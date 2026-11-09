import { GrokSearchError, isRecord } from './errors.mjs';

const invalid = () => new GrokSearchError('GROK_INVALID_RESULT', 'Grok 返回了不符合协议的结果，请检查程序版本。');
const optionalText = value => {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw invalid();
  return value;
};
// grok-search-rs v0.1.26 Source.provider is assigned by its adapters/service,
// not by the model answer. Only these exact protocol labels are retained.
const SOURCE_LABELS = new Map([
  ['grok_responses', { provider: 'grok', role: 'primary' }],
  ['openai_compatible', { provider: 'grok', role: 'primary' }],
  ...['tavily', 'exa', 'tinyfish', 'firecrawl'].flatMap(provider => [
    [provider, { provider, role: 'source' }],
    [`${provider}_fallback`, { provider, role: 'fallback' }],
    [`${provider}_enrichment`, { provider, role: 'enrichment' }],
  ]),
]);
export function searchSourceProvenance(sources = []) {
  const resultProviders = [], fallbackProviders = [], enrichmentProviders = [];
  let complete = sources.length > 0;
  for (const source of sources) {
    const label = isRecord(source) && Object.hasOwn(source, 'provider') ? SOURCE_LABELS.get(source.provider) : null;
    if (!label) { complete = false; continue; }
    if (!resultProviders.includes(label.provider)) resultProviders.push(label.provider);
    if (label.role === 'fallback' && !fallbackProviders.includes(label.provider)) fallbackProviders.push(label.provider);
    if (label.role === 'enrichment' && !enrichmentProviders.includes(label.provider)) enrichmentProviders.push(label.provider);
  }
  return { resultProviders, resultProvidersComplete: complete, fallbackProviders, enrichmentProviders };
}

export function decodeGrokResult(result) {
  if (!isRecord(result)) throw invalid();
  if (result.isError === true) throw new GrokSearchError('GROK_TOOL_ERROR', 'Grok 搜索报告错误，请检查上游和配置。');
  let payload = result.structuredContent;
  if (payload === undefined) {
    if (!Array.isArray(result.content)) throw invalid();
    const texts = result.content.filter(block => isRecord(block) && block.type === 'text');
    if (texts.length !== 1 || typeof texts[0].text !== 'string') throw invalid();
    try { payload = JSON.parse(texts[0].text); } catch { throw invalid(); }
  }
  if (!isRecord(payload) || !Array.isArray(payload.sources)) throw invalid();
  if (payload.error != null) throw new GrokSearchError('GROK_TOOL_ERROR', 'Grok 返回了错误，请检查上游和配置。');
  for (const field of ['truncated', 'fallback_used']) {
    if (payload[field] !== undefined && typeof payload[field] !== 'boolean') throw invalid();
  }
  for (const field of ['sources_count', 'total_sources']) {
    if (payload[field] !== undefined && (!Number.isSafeInteger(payload[field]) || payload[field] < 0)) throw invalid();
  }
  optionalText(payload.content);
  optionalText(payload.session_id);
  optionalText(payload.search_provider);
  return payload;
}

// 以序列化结果计预算，避免转义字符使实际结果超过上限。
function shorten(value, accepts) {
  let low = 0, high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (accepts(value.slice(0, middle))) low = middle; else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low--;
  return value.slice(0, low);
}

export function mapSearchResult(payload, { maxResults, maxChars = 45_000 } = {}) {
  if (!isRecord(payload) || !Array.isArray(payload.sources)) throw invalid();
  if (maxResults !== undefined && (!Number.isSafeInteger(maxResults) || maxResults < 0)) throw new TypeError('maxResults 必须是非负整数。');
  if (!Number.isSafeInteger(maxChars) || maxChars < 100) throw new TypeError('maxChars 必须是至少 100 的整数。');
  if (payload.truncated !== undefined && typeof payload.truncated !== 'boolean') throw invalid();
  const result = { content: '', sources: [], truncated: payload.truncated ?? false };
  const fits = candidate => JSON.stringify(candidate).length <= maxChars;
  const seen = new Set();
  for (const source of payload.sources) {
    if (!isRecord(source) || typeof source.url !== 'string' || !source.url.trim()) throw invalid();
    let url;
    try { url = new URL(source.url); } catch { result.truncated = true; continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { result.truncated = true; continue; }
    if (seen.has(source.url)) { result.truncated = true; continue; }
    seen.add(source.url);
    const title = optionalText(source.title);
    const snippet = optionalText(source.snippet ?? source.description ?? source.content);
    const publishedAt = optionalText(source.publishedAt ?? source.published_date);
    if (maxResults !== undefined && result.sources.length >= maxResults) { result.truncated = true; continue; }
    const item = { url: source.url, ...(title === undefined ? {} : { title }), ...(snippet === undefined ? {} : { snippet }), ...(publishedAt === undefined ? {} : { publishedAt }) };
    const candidate = () => ({ ...result, sources: [...result.sources, item] });
    if (!fits(candidate())) {
      result.truncated = true;
      for (const field of ['snippet', 'title', 'publishedAt']) {
        if (field === 'publishedAt') delete item[field];
        else if (typeof item[field] === 'string') item[field] = shorten(item[field], value => fits({ ...result, sources: [...result.sources, { ...item, [field]: value }] }));
        if (fits(candidate())) break;
        delete item[field];
      }
    }
    if (fits(candidate())) {
      // Keep provenance on the exact retained item through both budget passes,
      // while preserving DSH's enumerable source contract and character budget.
      if (Object.hasOwn(source, 'provider') && SOURCE_LABELS.has(source.provider)) {
        Object.defineProperty(item, 'provider', { value: source.provider });
      }
      result.sources.push(item);
    } else result.truncated = true;
  }
  const content = optionalText(payload.content) ?? '';
  // false 比 true 多一个序列化字符，先用实际标志判断完整内容。
  if (fits({ ...result, content })) result.content = content;
  else {
    result.truncated = true;
    result.content = shorten(content, value => fits({ ...result, content: value }));
  }
  return result;
}

/** Validate usable search output after mapping, without changing the mapper's
 * legal empty/zero-result contract. Only URL references, never answer text,
 * establish that a search result can be verified. */
export function assertSearchReferences(payload, result, maxResults) {
  if (maxResults === 0 || result.sources.length > 0) return;
  const hadReference = payload.sources.some(source => {
    try {
      const url = new URL(source.url);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  });
  if (hadReference) throw new GrokSearchError('OUTPUT_LIMIT', '回复字符上限未能容纳搜索链接，请调大上限后重试。');
  throw new GrokSearchError('grok_sources_empty', 'Grok 未返回可识别的来源链接。');
}
