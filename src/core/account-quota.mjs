import { GrokSearchError } from './errors.mjs';
import { sourceSpec } from './source-adapters.mjs';
import { patchSharedToml } from './shared-config.mjs';

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
const remaining = (limit, used) => limit !== null && used !== null ? Math.max(0, limit - used) : null;
const MESSAGES = Object.freeze({
  AUTH: '额度接口鉴权失败，请核对该接口的 API Key 和权限。',
  PERMISSION: '额度接口拒绝访问，请检查账户或查询权限。',
  RATE_LIMIT: '额度查询受到限流，请稍后重试。',
  BILLING: '额度接口报告账户或计费受限。',
  ENDPOINT: '额度接口不存在或不支持此请求，请核对 Base URL。',
  REDIRECT: '额度接口发生重定向，未向新地址转发 API Key。',
  UPSTREAM: '额度服务暂时异常，请稍后重试。',
  TIMEOUT: '额度查询超时，请检查网络或服务地址。',
  NETWORK: '无法连接额度接口，请检查网络、代理或证书。',
  UNREPORTED: '额度接口未返回可识别的额度数据。',
  CONFIG: '额度查询参数无效，请检查 Base URL、API Key 和所选 Key。',
});
const failed = (category = 'UNREPORTED', details = {}) => new GrokSearchError('QUOTA_QUERY_FAILED',
  `${MESSAGES[category]}${details.httpStatus ? `（HTTP ${details.httpStatus}）` : ''}`,
  { category, ...details });

/** A transient overlay: validates like Save, but never writes a config/history file. */
export function quotaDraftConfiguration({ provider, keyIndex = 0, effective, draft }) {
  if (!Object.hasOwn(sourceSpec, provider) || provider === 'github') throw failed('CONFIG');
  if (draft === undefined) return { config: effective, keyIndex };
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)
    || Object.keys(draft).some(key => !['baseUrl', 'apiKey'].includes(key))) throw failed('CONFIG');
  const spec = sourceSpec[provider], updates = {};
  if (Object.hasOwn(draft, 'baseUrl')) updates[spec.url] = draft.baseUrl;
  if (Object.hasOwn(draft, 'apiKey')) updates[spec.key] = draft.apiKey;
  if (Object.values(updates).some(value => typeof value !== 'string')
    || typeof draft.apiKey === 'string' && (!draft.apiKey.trim() || draft.apiKey.includes(','))) throw failed('CONFIG');
  // Reuse the shared validator without calling store.save or creating a second file.
  patchSharedToml('', updates);
  for (const [key, value] of Object.entries(updates)) {
    const previous = key === spec.key && spec.multiKey
      ? String(effective[key]?.value ?? '').split(',').map(item => item.trim()).filter(Boolean)[keyIndex]
      : effective[key]?.value;
    if (effective[key]?.readOnly && previous !== value) {
      throw new GrokSearchError('CONFIG_FIELD_READ_ONLY', '此项由环境变量提供，不能用表单草稿覆盖。');
    }
  }
  return { config: { ...effective, ...Object.fromEntries(Object.entries(updates).map(([key, value]) =>
    [key, { value }])) }, keyIndex: Object.hasOwn(draft, 'apiKey') ? 0 : keyIndex };
}

/** Accepts a saved snapshot or an authenticated, validated in-memory draft. */
export async function queryAccountQuota({ provider, keyIndex = 0, config, signal, fetchImpl = globalThis.fetch }) {
  if (!['tavily', 'exa', 'firecrawl', 'tinyfish'].includes(provider)) throw failed('CONFIG');
  if (provider === 'exa') return { value: null, supported: false };
  const fields = config?.fields ?? config ?? {};
  const get = key => fields[key] && typeof fields[key] === 'object' ? fields[key].value : fields[key];
  const spec = sourceSpec[provider];
  const rawKey = String(get(spec.key) ?? '');
  const keys = (provider === 'tavily' ? rawKey.split(',') : [rawKey]).map(v => v.trim()).filter(Boolean);
  if (!Number.isSafeInteger(keyIndex) || keyIndex < 0 || keyIndex >= keys.length) throw failed('CONFIG');
  let base;
  try { base = new URL(String(get(spec.url) || spec.fallbackUrl)); } catch { throw failed('CONFIG'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw failed('CONFIG');
  const raw = base.href.replace(/\/+$/, '');
  const url = provider === 'tavily' ? `${raw}/usage`
    : provider === 'firecrawl' ? `${/\/v[12]$/.test(raw) ? raw : `${raw}/v2`}/team/credit-usage`
      : raw === spec.fallbackUrl ? 'https://agent.tinyfish.ai/v1/wallet'
        : `${/\/v1$/.test(raw) ? raw : `${raw}/v1`}/wallet`;
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    combined.throwIfAborted();
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: combined,
      headers: provider === 'tinyfish' ? { 'X-API-Key': keys[keyIndex] } : { authorization: `Bearer ${keys[keyIndex]}` } });
    combined.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      const status = response.status;
      const category = status === 401 ? 'AUTH' : status === 403 ? 'PERMISSION' : status === 429 ? 'RATE_LIMIT'
        : [402, 432, 433].includes(status) ? 'BILLING' : [404, 405].includes(status) ? 'ENDPOINT'
          : status >= 300 && status < 400 ? 'REDIRECT' : 'UPSTREAM';
      throw failed(category, { httpStatus: status });
    }
    const reader = response.body?.getReader();
    if (!reader) throw failed();
    const chunks = [];
    let size = 0;
    const abort = () => { void reader.cancel(combined.reason).catch(() => {}); };
    combined.addEventListener('abort', abort, { once: true });
    try {
      combined.throwIfAborted();
      for (;;) {
        combined.throwIfAborted();
        const { done, value } = await reader.read();
        combined.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024) throw failed();
        chunks.push(value);
      }
    } finally {
      combined.removeEventListener('abort', abort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    combined.throwIfAborted();
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let value;
    if (provider === 'tavily') {
      const used = numeric(body?.account?.plan_usage), plan = numeric(body?.account?.plan_limit);
      const keyUsed = numeric(body?.key?.usage), keyLimit = numeric(body?.key?.limit);
      value = { kind: 'credits', used, plan, remaining: remaining(plan, used),
        keyUsed, keyLimit, keyRemaining: remaining(keyLimit, keyUsed),
        note: '账户按套餐统计，可能包含其他应用的调用；按量付费不计入此处。' };
      if (used === null && plan === null && keyUsed === null && keyLimit === null) throw failed();
    } else if (provider === 'firecrawl') {
      const data = body?.data;
      const balance = numeric(data?.remainingCredits);
      if (balance === null) throw failed();
      value = { kind: 'credits', used: null, plan: null, remaining: balance,
        keyUsed: null, keyLimit: null, keyRemaining: null,
        note: '团队余额可能包含赠送或按量额度；接口未报告同口径的已用与总额度。' };
    } else {
      const balance = body?.available_balance ?? body?.balance;
      if (!['usd', 'USD'].includes(body?.currency)
        || !['string', 'number'].includes(typeof balance)
        || !/^-?\d+(\.\d+)?$/.test(String(balance)) || !Number.isFinite(Number(balance)) || Math.abs(Number(balance)) > 1e12) throw failed();
      value = { kind: 'wallet', balance: Number(balance),
        note: '账户钱包余额，可能包含其他应用的调用；不是这次搜索的费用。' };
    }
    return { value, supported: true };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof GrokSearchError) throw error;
    if (timeout.aborted) throw failed('TIMEOUT');
    if (error instanceof SyntaxError) throw failed('UNREPORTED');
    const networkCode = error?.cause?.code ?? error?.code;
    const allowedCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
      'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'];
    throw failed('NETWORK', allowedCodes.includes(networkCode) ? { networkCode } : {});
  } finally {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
