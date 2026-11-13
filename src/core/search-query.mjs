import { GrokSearchError } from './errors.mjs';

export const MAX_SEARCH_QUERY_CHARS = 8192;
export const SEARCH_QUERY_TOO_LONG_MESSAGE = `单条搜索查询最多 ${MAX_SEARCH_QUERY_CHARS} 个字符，请缩短后重试；本次未请求搜索来源。`;

// Count code points, as the settings codec does. Stop at the boundary rather
// than allocating a full character array or trimming an unbounded document.
export function validateSearchQuery(query, invalidCode = 'GROK_QUERY_INVALID') {
  if (typeof query !== 'string') throw new GrokSearchError(invalidCode, '搜索查询不能为空。');
  let length = 0;
  for (const _character of query) {
    if (++length > MAX_SEARCH_QUERY_CHARS) {
      throw new GrokSearchError('SEARCH_QUERY_TOO_LONG', SEARCH_QUERY_TOO_LONG_MESSAGE,
        { maxLength: MAX_SEARCH_QUERY_CHARS });
    }
  }
  if (!query.trim()) throw new GrokSearchError(invalidCode, '搜索查询不能为空。');
  return query;
}
