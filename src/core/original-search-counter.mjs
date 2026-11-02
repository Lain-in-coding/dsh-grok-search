import { ControlRecordError } from './control-intent-store.mjs';

export const ORIGINAL_SEARCH_EVENT = 'web/deepseek-search-llm-request';
export const ORIGINAL_SEARCH_COUNTER_SOURCE = 'dsh-session/web-deepseek-search-llm-request';

/**
 * Count official deepseek search dispatch attempts from the canonical Session
 * event log. The event carries the full request body, but this adapter only
 * inspects its type and never retains or exposes event data.
 */
export function createOriginalSearchCounter(ctx, { holdUntil = null } = {}) {
  if (!ctx || typeof ctx.on !== 'function') {
    throw new ControlRecordError('CONTROL_ROUTE_COUNTER_UNAVAILABLE',
      'The Session event stream is required for the original-search counter.');
  }
  let calls = 0;
  let active = true;
  const disposeEvent = ctx.on('session/event', (_session, event) => {
    if (active && event?.type === ORIGINAL_SEARCH_EVENT) calls += 1;
  });
  if (holdUntil) {
    // Cordis unloads sibling effects concurrently. Transfer this subscription
    // into an ordered effect so it survives through the release verification.
    ctx.effect(function* () {
      yield disposeEvent;
      yield async () => {
        try { await holdUntil(); } finally { active = false; }
      };
    }, 'canonical-counter-release-lifetime');
  }
  const snapshot = () => ({
    calls,
    originalSearchCalls: calls,
    source: ORIGINAL_SEARCH_COUNTER_SOURCE,
    eventType: ORIGINAL_SEARCH_EVENT,
    adapterVersion: 1,
  });
  return Object.freeze({
    snapshot,
    dispose() {
      if (!active) return;
      active = false;
      if (typeof disposeEvent === 'function') disposeEvent();
    },
  });
}
