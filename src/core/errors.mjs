export class GrokSearchError extends Error {
  /**
   * @param details optional JSON-safe, secret-free payload (for example per
   * source failure codes). It is forwarded to settings clients unchanged.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'GrokSearchError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function timeoutError() {
  return new GrokSearchError('GROK_TIMEOUT', '搜索已超出工作预算，请缩短查询或检查上游。');
}
