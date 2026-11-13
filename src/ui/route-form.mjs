/** Pure form policy shared by the mounted view and its behavior tests. */
export const NUM = Object.freeze(Object.fromEntries(Object.entries({
  extra: { min: 0, max: 10, step: 1, unit: '条' },
  fallback: { min: 0, max: 10, step: 1, unit: '条' },
  timeout: { min: 5, max: 300, step: 5, unit: '秒' },
  cache: { min: 1, max: 4096, step: 64, unit: '条' },
  maxChars: { min: 100, max: 500000, step: 5000, unit: '字符' },
  budget: { min: 30, max: 120, step: 10, unit: '秒' },
}).map(([key, value]) => [key, Object.freeze(value)])));

export function normCard(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, Array.isArray(item) ? item.map(text => text.trim()).filter(Boolean)
      : typeof item === 'string' ? item.trim() : item,
  ]));
}

export const normHub = value => ({ ...value, exeOverride: (value.exeOverride || '').trim(),
  cfgOverride: (value.cfgOverride || '').trim() });

export const joinSentences = (...parts) => parts.map(part => String(part ?? '').trim().replace(/[。；，;,.]+$/, ''))
  .filter(Boolean).join('。');

export function validateHub(value, { base, readOnly = () => false } = {}) {
  const err = {}, warn = {};
  for (const [key, range] of Object.entries(NUM)) {
    if (readOnly(key) || base && Object.is(value[key], base[key])) continue;
    if (!Number.isInteger(value[key])) err[key] = '请填写整数';
    else if (value[key] < range.min || value[key] > range.max) err[key] = `可填范围 ${range.min}–${range.max}`;
  }
  if (!err.timeout && !err.budget && value.timeout > value.budget) {
    warn.timeout = `请求超时 ${value.timeout} 秒长于单次搜索预算 ${value.budget} 秒，DSH 会先停止等待`;
    warn.budget = warn.timeout;
  }
  return { err, warn };
}
