import { GrokSearchError } from './errors.mjs';
import { sourceSpec } from './source-adapters.mjs';

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
const remaining = (limit, used) => limit !== null && used !== null ? Math.max(0, limit - used) : null;
const failed = () => new GrokSearchError('QUOTA_QUERY_FAILED', '查询失败，请检查接口、权限或网络后重试。');

/** Only configured destinations; never accepts an arbitrary URL or a client-supplied key. */
export async function queryAccountQuota({ provider, keyIndex = 0, config, signal, fetchImpl = globalThis.fetch }) {
  if (!['tavily', 'exa', 'firecrawl', 'tinyfish'].includes(provider)) throw failed();
  if (provider === 'exa') return { value: null, supported: false };
  const fields = config?.fields ?? config ?? {};
  const get = key => fields[key] && typeof fields[key] === 'object' ? fields[key].value : fields[key];
  const spec = sourceSpec[provider];
  const keys = String(get(spec.key) ?? '').split(provider === 'tavily' ? ',' : '\0').map(v => v.trim()).filter(Boolean);
  if (!Number.isSafeInteger(keyIndex) || keyIndex < 0 || keyIndex >= keys.length) throw failed();
  let base;
  try { base = new URL(String(get(spec.url) || spec.fallbackUrl)); } catch { throw failed(); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw failed();
  const raw = base.href.replace(/\/+$/, '');
  const url = provider === 'tavily' ? `${raw}/usage`
    : provider === 'firecrawl' ? `${/\/v[12]$/.test(raw) ? raw : `${raw}/v2`}/team/credit-usage`
      : raw === spec.fallbackUrl ? 'https://agent.tinyfish.ai/v1/wallet' : `${raw}/v1/wallet`;
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    combined.throwIfAborted();
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: combined,
      headers: provider === 'tinyfish' ? { 'X-API-Key': keys[keyIndex] } : { authorization: `Bearer ${keys[keyIndex]}` } });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw failed();
    }
    const reader = response.body?.getReader();
    if (!reader) throw failed();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) { await reader.cancel().catch(() => {}); throw failed(); }
      chunks.push(value);
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
    throw failed();
  }
}
