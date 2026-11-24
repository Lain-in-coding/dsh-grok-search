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

export function cleanupFailure(results) {
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (!failures.length) return null;
  const proofs = failures.map(error => typeof error?.whenExited?.then === 'function'
    ? Promise.resolve(error.whenExited) : null);
  for (const proof of proofs) proof?.catch(() => {});
  const first = failures[0];
  if (failures.length === 1 && first instanceof Error) return first;
  const error = first instanceof GrokSearchError ? new GrokSearchError(first.code, first.message)
    : new Error(first instanceof Error ? first.message : 'Search resource cleanup failed.');
  if (first instanceof Error) {
    error.name = first.name;
    if (first.code !== undefined) error.code = first.code;
    for (const key of ['details', 'diagnostic', 'retriable']) {
      if (Object.hasOwn(first, key)) Object.defineProperty(error, key, { value: first[key] });
    }
  } else error.code = 'GROK_CLEANUP_FAILED';
  Object.defineProperties(error, { cause: { value: first }, errors: { value: failures } });
  // Every failed resource must prove its exit; one unknown failure blocks the group.
  if (proofs.every(proof => proof !== null)) {
    const whenExited = Promise.all(proofs);
    whenExited.catch(() => {});
    Object.defineProperty(error, 'whenExited', { value: whenExited });
  }
  return error;
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
