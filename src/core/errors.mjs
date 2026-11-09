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

export function isCancellation(error, aborted = false) {
  if (error?.name === 'TimeoutError' || /TIMEOUT|TIMED_OUT/i.test(error?.code ?? '')) return false;
  return aborted || error?.name === 'AbortError'
    || ['ABORTED', 'CANCELLED', 'GROK_SEARCH_STOPPING', 'GROK_SEARCH_CANCELLED', 'GROK_CANCELLED',
      'SETTINGS_DIAGNOSIS_CANCELLED'].includes(error?.code);
}
