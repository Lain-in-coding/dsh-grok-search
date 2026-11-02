import { GrokSearchError } from './errors.mjs';
import { mapSearchResult } from './result-map.mjs';
import { createSourceChain } from './source-chain.mjs';

const sourceChain = createSourceChain();

/*
 * Supplementary sources follow the grok-search-rs v0.1.26 provider contracts,
 * so DSH fallback search and diagnostics hit the same endpoints with the same
 * credentials as the shared configuration:
 *   Tavily    POST {base}/search, Bearer; comma-separated keys rotate only on
 *             401/403/429/432/433; results with score < 0.1 are dropped.
 *   Exa       POST {base}/search, x-api-key; numResults 1..100, no contents
 *             (contents are billed separately); one raw key.
 *   TinyFish  GET {search_api_url}?query=..., X-API-Key; one raw key.
 *   Firecrawl POST {base}/search, Bearer; base gains /v2 unless it already
 *             ends with /v1 or /v2; results from data.web, data or results.
 * Upstream echoes response bodies in its errors; this module never does.
 */

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DIAGNOSE_TIMEOUT_MS = 15_000;
const KEY_SCOPED_STATUS = new Set([401, 403, 429, 432, 433]);
const TAVILY_MIN_SCORE = 0.1;
const DIAGNOSE_QUERY = 'DeepSeek Harness';
const GITHUB_RATE_LIMIT = 'https://api.github.com/rate_limit';

const text = value => typeof value === 'string' ? value.trim() : '';

function parseBase(value, fallback) {
  const raw = text(value) || fallback;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

const firecrawlBase = base => /\/v[12]$/.test(base) ? base : `${base}/v2`;

function withQuery(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

function normalizeItem(item, provider, { snippet = ['snippet', 'description', 'content'], date = ['published_date'] } = {}) {
  const url = typeof item === 'string' ? item : item?.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  // Decide whether the source succeeded only after the same URL safety checks
  // as the final mapper. Otherwise malformed/userinfo-only results stop the
  // fallback chain even though the user receives no usable sources.
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  if (typeof item === 'string') return { url, provider };
  const pick = keys => keys.map(key => item[key]).find(value => typeof value === 'string' && value.trim());
  const description = pick(snippet);
  const published = pick(date);
  return {
    url,
    ...(typeof item.title === 'string' && item.title.trim() ? { title: item.title } : {}),
    ...(description ? { snippet: description } : {}),
    ...(published ? { publishedAt: published } : {}),
    provider,
  };
}

const sourceSpec = Object.freeze({
  tavily: Object.freeze({
    url: 'tavily_api_url', key: 'tavily_api_key', enabled: 'tavily_enabled',
    fallbackUrl: 'https://api.tavily.com', multiKey: true,
    request: (base, key, query, limit) => ({
      url: `${base}/search`,
      init: { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: limit, include_answer: false }) },
    }),
    read: body => (Array.isArray(body?.results) ? body.results : [])
      .filter(item => typeof item === 'string' || !(typeof item?.score === 'number' && item.score < TAVILY_MIN_SCORE))
      .map(item => normalizeItem(item, 'tavily', { snippet: ['content', 'description'] })),
  }),
  exa: Object.freeze({
    url: 'exa_api_url', key: 'exa_api_key', enabled: 'exa_enabled',
    fallbackUrl: 'https://api.exa.ai', multiKey: false,
    request: (base, key, query, limit) => ({
      url: `${base}/search`,
      init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ query, numResults: Math.min(100, Math.max(1, limit)) }) },
    }),
    read: body => (Array.isArray(body?.results) ? body.results : [])
      .map(item => normalizeItem(item, 'exa', { snippet: ['summary'], date: ['publishedDate'] })),
  }),
  tinyfish: Object.freeze({
    url: 'tinyfish_search_api_url', key: 'tinyfish_api_key', enabled: 'tinyfish_enabled',
    fallbackUrl: 'https://api.search.tinyfish.ai', multiKey: false,
    request: (base, key, query) => ({
      url: withQuery(base, { query }),
      init: { method: 'GET', headers: { 'X-API-Key': key } },
    }),
    read: (body, limit) => (Array.isArray(body?.results) ? body.results : [])
      .map(item => normalizeItem(item, 'tinyfish', { snippet: ['snippet'], date: ['date'] })).filter(Boolean).slice(0, limit),
  }),
  firecrawl: Object.freeze({
    url: 'firecrawl_api_url', key: 'firecrawl_api_key', enabled: 'firecrawl_enabled',
    fallbackUrl: 'https://api.firecrawl.dev', multiKey: false,
    request: (base, key, query, limit) => ({
      url: `${firecrawlBase(base)}/search`,
      init: { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, limit }) },
    }),
    read: body => {
      const rows = Array.isArray(body?.data?.web) ? body.data.web
        : Array.isArray(body?.data) ? body.data : Array.isArray(body?.results) ? body.results : [];
      return rows.map(item => normalizeItem(item, 'firecrawl', { snippet: ['description', 'markdown', 'content'] }));
    },
  }),
});

const HTTP_MESSAGES = Object.freeze({
  400: '请求被拒绝（HTTP 400），请检查 BaseUrl 是否指向搜索接口。',
  401: 'API Key 无效或已失效。',
  403: 'API Key 没有访问权限或已被停用。',
  404: '接口地址不存在，请检查 BaseUrl。',
  405: '接口不接受该请求方式，请检查 BaseUrl。',
  408: '服务响应超时。',
  429: '请求过于频繁或额度已用尽。',
  432: '套餐额度已用尽或超出限制。',
  433: '套餐额度已用尽或超出限制。',
  504: '服务网关超时。',
});

export function httpMessage(status) {
  return HTTP_MESSAGES[status] ?? (status >= 500 ? `服务端暂时不可用（HTTP ${status}）。` : `服务返回 HTTP ${status}。`);
}

const sourceFailure = (code, message) => new GrokSearchError(code, message);

async function readBoundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw sourceFailure('SOURCE_INVALID_RESPONSE', '服务返回了空响应。');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw sourceFailure('SOURCE_RESPONSE_TOO_LARGE', '服务响应超过 2 MiB，已停止读取。');
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw sourceFailure('SOURCE_INVALID_RESPONSE', '服务返回的不是有效 JSON。'); }
}

const safeCauseCode = error => {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : null;
};

function classify(error) {
  if (error?.code === 'SOURCE_TIMEOUT') return { code: 'TIMEOUT', message: '请求超时，请检查网络或稍后重试。' };
  if (error?.code === 'SOURCE_RESPONSE_TOO_LARGE' || error?.code === 'SOURCE_INVALID_RESPONSE') {
    return { code: error.code === 'SOURCE_INVALID_RESPONSE' ? 'INVALID_RESPONSE' : 'RESPONSE_TOO_LARGE', message: error.message };
  }
  const cause = safeCauseCode(error);
  return { code: 'NETWORK', message: '无法连接服务，请检查网络、代理或 BaseUrl。', ...(cause ? { cause } : {}) };
}

function configValues(getConfig) {
  const value = getConfig?.();
  if (!value) return {};
  const fields = value.fields ?? value;
  return Object.fromEntries(Object.entries(fields).map(([key, item]) => [
    key, item && typeof item === 'object' && Object.hasOwn(item, 'value') ? item.value : item,
  ]));
}

export function createSourceRouter({ getConfig, getPreferences, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('需要可用的 fetch 实现。');
  let tavilyCursor = 0;

  const current = () => {
    const config = configValues(getConfig);
    const preferences = getPreferences?.();
    const prefs = preferences?.value ?? preferences ?? {};
    // One shared chain: order and on/off come from the same effective
    // config.toml/environment grok-search-rs uses for its own source fallback.
    const chain = sourceChain.view(config);
    const order = chain.order;
    const sources = order.map(id => {
      const spec = sourceSpec[id];
      const raw = text(config[spec.key]);
      const keys = spec.multiKey ? raw.split(',').map(key => key.trim()).filter(Boolean) : raw ? [raw] : [];
      const base = parseBase(config[spec.url], spec.fallbackUrl);
      const state = !chain.enabled[id] ? 'disabled'
        : keys.length === 0 ? 'not-configured' : base === null ? 'invalid-url' : 'available';
      return { id, spec, keys, base, state };
    });
    return { config, prefs, order, sources };
  };

  const attempt = async (source, key, query, limit, { signal, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(sourceFailure('SOURCE_TIMEOUT', '补充来源请求超时。')), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const request = source.spec.request(source.base, key, query, limit);
      const response = await fetchImpl(request.url, { ...request.init, redirect: 'error', signal: combined });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        return { status: 'failed', code: `HTTP_${response.status}`, httpStatus: response.status,
          message: httpMessage(response.status), keyScoped: KEY_SCOPED_STATUS.has(response.status), elapsedMs: elapsed() };
      }
      const body = await readBoundedJson(response);
      const sources = source.spec.read(body, limit).filter(Boolean);
      return sources.length ? { status: 'ok', sources, elapsedMs: elapsed() }
        : { status: 'empty', code: 'EMPTY', message: '连接正常，但本次测试没有返回结果。', elapsedMs: elapsed() };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return { status: 'failed', ...classify(controller.signal.aborted ? controller.signal.reason : error),
        keyScoped: false, elapsedMs: elapsed() };
    } finally {
      clearTimeout(timer);
    }
  };

  const notRunnable = source => source.state === 'disabled'
    ? { status: 'disabled', code: 'DISABLED', message: '已停用，测试时跳过。' }
    : source.state === 'not-configured' ? { status: 'not-configured', code: 'NOT_CONFIGURED', message: '尚未填写 API Key。' }
      : { status: 'failed', code: 'URL_INVALID', message: 'BaseUrl 无效，只支持 http 或 https 地址。' };

  const diagnoseSource = async (source, signal) => {
    if (source.state !== 'available') {
      return { provider: source.id, ...notRunnable(source), keyCount: source.keys.length, elapsedMs: 0, keys: [] };
    }
    const keys = [];
    for (const [keyIndex, key] of source.keys.entries()) {
      const outcome = await attempt(source, key, DIAGNOSE_QUERY, 1, { signal, timeoutMs: DIAGNOSE_TIMEOUT_MS });
      const { sources, keyScoped, ...rest } = outcome;
      keys.push({ keyIndex, ...rest, ...(outcome.status === 'ok' ? { code: 'OK', message: '连接成功。', results: sources.length } : {}) });
    }
    const ok = keys.filter(item => item.status === 'ok');
    const failed = keys.filter(item => item.status === 'failed');
    const elapsedMs = keys.reduce((total, item) => total + item.elapsedMs, 0);
    const label = index => keys.length > 1 ? `Key ${index + 1}/${keys.length}：` : '';
    const summary = ok.length ? { status: 'ok', code: 'OK', partial: failed.length > 0,
      message: failed.length ? `${ok.length}/${keys.length} 个 Key 可用。` : keys.length > 1 ? `${keys.length} 个 Key 均可用。` : '连接成功。' }
      : failed.length === 0 ? { status: 'empty', code: 'EMPTY', message: '连接正常，但本次测试没有返回结果。' }
        : { status: 'failed', code: failed[0].code, ...(failed[0].httpStatus ? { httpStatus: failed[0].httpStatus } : {}),
          message: label(failed[0].keyIndex) + failed[0].message };
    return { provider: source.id, ...summary, keyCount: keys.length, elapsedMs, keys };
  };

  const diagnoseGithub = async signal => {
    const { config, prefs } = current();
    if (prefs.githubEnabled === false) {
      return { provider: 'github', status: 'disabled', code: 'DISABLED', message: '已停用，测试时跳过。', keyCount: 0, elapsedMs: 0, keys: [] };
    }
    const token = text(config.github_token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(sourceFailure('SOURCE_TIMEOUT', 'GitHub 请求超时。')), DIAGNOSE_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const base = { provider: 'github', keyCount: token ? 1 : 0, keys: [] };
    try {
      const response = await fetchImpl(GITHUB_RATE_LIMIT, { method: 'GET', redirect: 'error', signal: combined,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-grok-search',
          'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        return { ...base, status: 'failed', code: `HTTP_${response.status}`, httpStatus: response.status,
          message: response.status === 401 && token ? 'GitHub Token 无效或已过期。' : httpMessage(response.status), elapsedMs: elapsed() };
      }
      const body = await readBoundedJson(response);
      const core = body?.resources?.core ?? body?.rate ?? {};
      const limit = Number.isSafeInteger(core.limit) ? core.limit : null;
      const remaining = Number.isSafeInteger(core.remaining) ? core.remaining : null;
      return { ...base, status: 'ok', code: 'OK', authenticated: Boolean(token), limit, remaining, elapsedMs: elapsed(),
        message: token ? `Token 有效${limit !== null ? `，每小时 ${limit} 次` : ''}。` : `未填 Token，按匿名额度使用${limit !== null ? `（每小时 ${limit} 次）` : ''}。` };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return { ...base, status: 'failed', ...classify(controller.signal.aborted ? controller.signal.reason : error), elapsedMs: elapsed() };
    } finally {
      clearTimeout(timer);
    }
  };

  const searchSource = async (source, query, limit, { signal, deadline }) => {
    const count = source.keys.length;
    const start = source.spec.multiKey && count > 1 ? tavilyCursor++ % count : 0;
    let last = null;
    for (let offset = 0; offset < count; offset++) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { status: 'failed', code: 'TIMEOUT', message: '补充来源在本次搜索预算内没有返回。' };
      last = await attempt(source, source.keys[(start + offset) % count], query, limit, { signal, timeoutMs: remaining });
      if (last.status === 'failed' && last.keyScoped && offset + 1 < count) continue;
      return last;
    }
    return last ?? { status: 'not-configured', code: 'NOT_CONFIGURED', message: '尚未填写 API Key。' };
  };

  return Object.freeze({
    snapshot: () => {
      const { order, sources } = current();
      const enabled = sources.filter(source => source.state === 'available').map(source => source.id);
      return { order, enabled, states: Object.fromEntries(sources.map(source => [source.id, source.state])),
        available: enabled.length > 0 };
    },
    /** Legacy flat per-key list for older clients; skipped sources are reported once. */
    async diagnose({ signal } = {}) {
      const results = [];
      for (const source of current().sources) {
        const result = await diagnoseSource(source, signal);
        if (result.keys.length === 0) {
          results.push({ provider: result.provider, ok: false, status: result.status, code: result.code, message: result.message });
        } else {
          for (const key of result.keys) results.push({ provider: result.provider, ok: key.status === 'ok', ...key });
        }
      }
      return results;
    },
    async diagnoseProvider(provider, { signal } = {}) {
      if (provider === 'github') return diagnoseGithub(signal);
      const source = current().sources.find(item => item.id === provider);
      if (!source) throw new GrokSearchError('SOURCE_UNKNOWN', '未知补充来源。');
      return diagnoseSource(source, signal);
    },
    async search({ query, maxResults = 5, signal, reason = 'grok-unavailable' } = {}) {
      if (typeof query !== 'string' || !query.trim()) throw new GrokSearchError('SOURCE_QUERY_INVALID', '搜索查询不能为空。');
      const { config, sources } = current();
      if (config.response_max_chars !== undefined
        && (!Number.isSafeInteger(config.response_max_chars) || config.response_max_chars < 100)) {
        throw new GrokSearchError('GROK_CONFIG_INVALID', '回复字符上限至少需要 100 字符，请检查共享配置。');
      }
      const available = sources.filter(source => source.state === 'available');
      if (!available.length) {
        throw new GrokSearchError('SOURCE_NOT_CONFIGURED', '没有已开启且填写了 API Key 的补充来源。');
      }
      const fallbackSources = Number.isSafeInteger(config.fallback_sources) && config.fallback_sources > 0 ? config.fallback_sources : 5;
      const limit = Math.max(1, Math.min(Number.isSafeInteger(maxResults) && maxResults > 0 ? maxResults : 5, fallbackSources));
      const timeoutSeconds = Number.isSafeInteger(config.timeout_seconds) ? Math.min(300, Math.max(5, config.timeout_seconds)) : 60;
      const deadline = performance.now() + timeoutSeconds * 1000;
      const failures = [];
      for (const source of available) {
        const outcome = await searchSource(source, query, limit, { signal, deadline });
        if (outcome.status === 'ok') {
          const maxChars = config.response_max_chars === undefined ? 45_000 : Math.min(500_000, config.response_max_chars);
          const mapped = mapSearchResult({ content: '', sources: outcome.sources }, { maxResults: limit, maxChars });
          Object.defineProperties(mapped, {
            search_provider: { value: source.id }, fallback_used: { value: true }, fallback_reason: { value: reason },
            diagnostic: { value: { provider: source.id, failures } },
          });
          return mapped;
        }
        failures.push({ provider: source.id, code: outcome.code,
          ...(outcome.httpStatus ? { httpStatus: outcome.httpStatus } : {}), message: outcome.message });
        if (outcome.code === 'TIMEOUT' && deadline - performance.now() <= 0) break;
      }
      throw new GrokSearchError('SOURCE_ALL_FAILED', '主搜索与已开启的补充来源均未返回结果。', { failures });
    },
  });
}

export { sourceSpec };
