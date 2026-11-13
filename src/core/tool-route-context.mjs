import { AsyncLocalStorage } from 'node:async_hooks';
import { isCancellation } from './errors.mjs';

const providers = new Set(['grok', 'grok-sources', 'tavily', 'exa', 'tinyfish', 'firecrawl', 'github']);
const identity = (value, limit) => typeof value === 'string' && value.length > 0
  && value.length <= limit && !/[\s\u0000-\u001f]/.test(value);
const unknown = () => ({ known: false, state: 'unknown', routes: [] });
const code = value => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : '';
// Remembered for an identity seen in more than one execution: neither is attributed.
const AMBIGUOUS = Object.freeze({ ambiguous: true });

/** Call identity comes only from DSH's tools/execute hook, never query text or time. */
export function createToolRouteContext({ capacity = 20, searchLog = null, now = Date.now } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw new TypeError('Invalid tool route capacity.');
  const storage = new AsyncLocalStorage();
  const active = new Map(), completed = new Map();
  const timelines = new WeakMap(), executions = new WeakMap();
  let disposed = false, generation = 0;
  const key = (sessionId, callId) => JSON.stringify([sessionId, callId]);
  // Markers and finished calls share one bound; a refreshed identity is evicted last.
  const remember = (id, value) => {
    completed.delete(id);
    completed.set(id, value);
    while (completed.size > capacity) completed.delete(completed.keys().next().value);
  };
  const view = entry => {
    if (!entry || entry.ambiguous || !entry.routes.length) return unknown();
    const { omitted } = entry;
    return {
      known: true,
      // Captures past the row cap still decide the outcome; only their rows are dropped.
      state: entry.finished ? entry.failed || omitted.failed > 0 || entry.routes.some(route => route.outcome === 'failed') ? 'failed'
        : entry.cancelled || omitted.cancelled > 0 || entry.routes.some(route => route.outcome === 'cancelled') ? 'cancelled' : 'done' : 'running',
      routes: entry.routes.map(route => ({ ...route,
        ...(route.resultProviders ? { resultProviders: [...route.resultProviders] } : {}) })),
      ...(omitted.total > 0 ? { routesComplete: false } : {}),
    };
  };
  const run = (exec, next) => {
    const sessionId = exec?.agent?.session?.id, callId = exec?.callId;
    if (disposed || !['web_search', 'web_fetch', 'github_read'].includes(exec?.name) || !identity(sessionId, 128) || !identity(callId, 512)) return storage.run(null, next);
    const id = key(sessionId, callId);
    // A second execution of one identity, finished or still running, cannot be told
    // apart from the first: it runs unattributed and the identity becomes unknown.
    if (active.has(id) || completed.has(id)) {
      const previous = active.get(id) ?? completed.get(id);
      if (previous !== AMBIGUOUS) previous.ambiguous = true;
      remember(id, AMBIGUOUS);
      return storage.run(null, next);
    }
    if (active.size >= 100) return storage.run(null, next);
    const entry = { sessionId, callId, toolName: exec.name, at: now(), elapsedMs: null,
      routes: [], omitted: { total: 0, running: 0, failed: 0, cancelled: 0 },
      finished: false, ambiguous: false, generation, logScope: searchLog?.beginCall({ sessionId, callId }) };
    executions.set(exec, entry);
    active.set(id, entry);
    return storage.run(entry, async () => {
      let failure = null, rejected = false, result;
      try { result = await next(); return result; }
      catch (error) { rejected = true; failure = error; throw error; }
      finally {
        if (active.get(id) === entry) active.delete(id);
        entry.finished = true;
        entry.elapsedMs = Math.max(0, now() - entry.at);
        const reported = failure ?? result?.error?.info ?? result?.error;
        const cancelled = exec.signal?.aborted === true && isCancellation(exec.signal.reason, true)
          && (!reported || isCancellation(reported));
        entry.failed = !cancelled && (rejected || result?.isError === true || exec.signal?.aborted === true);
        entry.cancelled = cancelled;
        for (const route of entry.routes) if (route.outcome === 'running') {
          route.outcome = cancelled ? 'cancelled' : 'failed';
          route.code = 'TOOL_ROUTE_INCOMPLETE';
          const timeline = timelines.get(route);
          if (timeline) {
            timeline.phase = 'done';
            timeline.elapsedMs = Math.max(0, now() - timeline.at);
            for (const call of timeline.calls) if (call.result === 'running') {
              call.result = route.outcome; call.code = route.code;
              call.elapsedMs = Math.max(0, now() - call.at);
            }
          }
        }
        entry.omitted[cancelled ? 'cancelled' : 'failed'] += entry.omitted.running;
        entry.omitted.running = 0;
        if (entry.logScope) searchLog.finishCall(entry.logScope, {
          failed: entry.failed, cancelled: entry.cancelled,
          code: code(failure?.code),
        });
        // Remembered even without routes, so a later repeat is still detected.
        if (!disposed && entry.generation === generation) remember(id, entry.ambiguous ? AMBIGUOUS : entry);
      }
    });
  };
  const capture = (toolName = 'web_search') => {
    const entry = storage.getStore();
    if (disposed || !entry || entry.finished || entry.toolName !== toolName) return null;
    if (entry.generation !== generation) return entry.logScope
      ? Object.freeze({ logScope: entry.logScope, suppressed: true, finish() {} }) : null;
    const row = { served: null, outcome: 'running', fallbackUsed: false, code: '' };
    // Past the cap only the outcome is counted, so the call is reported incomplete.
    const kept = entry.routes.length < 16;
    if (kept) entry.routes.push(row);
    else { entry.omitted.total++; entry.omitted.running++; }
    const timeline = { at: now(), elapsedMs: null, phase: 'queued', planned: [], calls: [], callsComplete: false, truncated: false };
    if (kept) timelines.set(row, timeline);
    let settled = false;
    const writable = () => !settled && !disposed && entry.generation === generation && !entry.finished && !entry.ambiguous;
    return Object.freeze({
      sessionId: entry.sessionId, callId: entry.callId, logScope: entry.logScope,
      dispatched() { if (kept && writable()) timeline.phase = 'search'; },
      planned(values) {
        if (kept && writable() && Array.isArray(values)) timeline.planned = [...new Set(values
          .filter(provider => providers.has(provider) && !['grok-sources','github'].includes(provider)))].slice(0,5);
      },
      record(input) {
        if (!kept || !writable() || !providers.has(input?.provider)) return;
        const result = ['running', 'ok', 'failed', 'cancelled'].includes(input.result) ? input.result : 'unknown';
        const keyIndex = Number.isSafeInteger(input.keyIndex) && input.keyIndex >= 0 && input.keyIndex < 100 ? input.keyIndex : null;
        const previous = timeline.calls.at(-1);
        const matching = result !== 'running' && previous?.result === 'running'
          && previous.provider === input.provider && previous.keyIndex === keyIndex;
        if (matching) {
          previous.result = result; previous.code = code(input.code);
          previous.evidence = input.evidence === 'kernel-summary' ? 'kernel-summary' : previous.evidence;
          previous.elapsedMs = previous.evidence === 'kernel-summary' ? null : Math.max(0, now() - previous.at);
          return;
        }
        if (timeline.calls.length >= 16) { timeline.truncated = true; return; }
        timeline.calls.push({ provider: input.provider, result, code: code(input.code), keyIndex,
          operation: ['retry', 'supplement', 'fetch'].includes(input.operation) ? input.operation : 'search',
          evidence: input.evidence === 'source-label' ? 'source-label' : 'dispatch',
          at: now(), elapsedMs: null });
      },
      finish(route) {
        if (!writable()) return;
        settled = true;
        if (!kept) {
          entry.omitted.running--;
          if (route?.cancelled) entry.omitted.cancelled++;
          else if (route?.outcome !== 'ok') entry.omitted.failed++;
          return;
        }
        row.served = providers.has(route?.served) ? route.served : null;
        row.outcome = route?.cancelled ? 'cancelled' : route?.outcome === 'ok' ? 'ok' : 'failed';
        row.fallbackUsed = route?.fallbackUsed === true
          && (route?.grokCode !== 'DISABLED' || Array.isArray(route?.failures) && route.failures.length > 0);
        row.code = code(route?.code || (route?.grokCode === 'DISABLED' ? '' : route?.grokCode));
        timeline.phase = 'done'; timeline.elapsedMs = Math.max(0, now() - timeline.at);
        timeline.callsComplete = route?.callsComplete === true && !timeline.truncated;
        for (const call of timeline.calls) if (call.result === 'running') {
          call.result = row.outcome === 'ok' ? 'unknown' : row.outcome;
          call.code = row.code || 'TOOL_ROUTE_INCOMPLETE';
          call.elapsedMs = Math.max(0, now() - call.at);
        }
        if (Array.isArray(route?.resultProviders)) {
          row.resultProviders = [...new Set(route.resultProviders.filter(provider => providers.has(provider) && provider !== 'grok-sources'))].slice(0, 5);
          row.resultProvidersComplete = route.resultProvidersComplete === true;
        }
      },
    });
  };
  const finalize = (exec, result) => {
    const entry = exec && executions.get(exec);
    if (disposed || !entry || !entry.finished || entry.finalized || entry.ambiguous || entry.generation !== generation) return;
    entry.finalized = true;
    const info = result?.error?.info;
    const cancelled = result?.isError === true && isCancellation(info ?? result.error);
    const failed = result?.isError === true && !cancelled;
    entry.failed = failed || entry.failed;
    entry.cancelled = cancelled || entry.cancelled;
    if (cancelled) entry.failed = false;
    entry.elapsedMs = Math.max(0, now() - entry.at);
    if (entry.logScope) searchLog?.finalizeCall(entry.logScope, { failed, cancelled, code: code(info?.code) });
  };
  return Object.freeze({
    run, capture, finalize, finalizeRead: finalize,
    read(sessionId, callId) {
      if (disposed || !identity(sessionId, 128) || !identity(callId, 512)) return unknown();
      const id = key(sessionId, callId);
      return view(active.get(id) ?? completed.get(id));
    },
    readTrace(sessionId, callId) {
      if (disposed || !identity(sessionId, 128) || !identity(callId, 512)) return unknown();
      const id = key(sessionId, callId), entry = active.get(id) ?? completed.get(id);
      const base = view(entry);
      if (!base.known) return base;
      return { ...base, toolName: entry.toolName, at: entry.at, elapsedMs: entry.elapsedMs,
        routes: base.routes.map((route, index) => {
          const timeline = timelines.get(entry.routes[index]);
          return { ...route, index, phase: timeline.phase, at: timeline.at, elapsedMs: timeline.elapsedMs,
            callsComplete: timeline.callsComplete, callsTruncated: timeline.truncated,
            planned: [...timeline.planned],
            calls: timeline.calls.map(call => ({ ...call })) };
        }) };
    },
    clear() { generation++; active.clear(); completed.clear(); },
    dispose() { disposed = true; generation++; active.clear(); completed.clear(); storage.disable(); },
  });
}
