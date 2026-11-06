import { AsyncLocalStorage } from 'node:async_hooks';

const providers = new Set(['grok', 'grok-sources', 'tavily', 'exa', 'tinyfish', 'firecrawl']);
const identity = (value, limit) => typeof value === 'string' && value.length > 0
  && value.length <= limit && !/[\s\u0000-\u001f]/.test(value);
const unknown = () => ({ known: false, state: 'unknown', routes: [] });
const code = value => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : '';
// Remembered for an identity seen in more than one execution: neither is attributed.
const AMBIGUOUS = Object.freeze({ ambiguous: true });

/** Call identity comes only from DSH's tools/execute hook, never query text or time. */
export function createToolRouteContext({ capacity = 20, searchLog = null } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) throw new TypeError('Invalid tool route capacity.');
  const storage = new AsyncLocalStorage();
  const active = new Map(), completed = new Map();
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
    if (disposed || exec?.name !== 'web_search' || !identity(sessionId, 128) || !identity(callId, 512)) return storage.run(null, next);
    const id = key(sessionId, callId);
    // A second execution of one identity, finished or still running, cannot be told
    // apart from the first: it runs unattributed and the identity becomes unknown.
    if (active.has(id) || completed.has(id)) {
      const running = active.get(id);
      if (running) running.ambiguous = true;
      remember(id, AMBIGUOUS);
      return storage.run(null, next);
    }
    if (active.size >= 100) return storage.run(null, next);
    const entry = { sessionId, callId, routes: [], omitted: { total: 0, running: 0, failed: 0, cancelled: 0 },
      finished: false, ambiguous: false, generation, logScope: searchLog?.beginCall({ sessionId, callId }) };
    active.set(id, entry);
    return storage.run(entry, async () => {
      let failure = null, rejected = false, result;
      try { result = await next(); return result; }
      catch (error) { rejected = true; failure = error; throw error; }
      finally {
        if (active.get(id) === entry) active.delete(id);
        entry.finished = true;
        entry.failed = rejected && !exec.signal?.aborted || result?.isError === true;
        entry.cancelled = exec.signal?.aborted === true;
        for (const route of entry.routes) if (route.outcome === 'running') {
          route.outcome = exec.signal?.aborted ? 'cancelled' : 'failed';
          route.code = 'TOOL_ROUTE_INCOMPLETE';
        }
        entry.omitted[exec.signal?.aborted ? 'cancelled' : 'failed'] += entry.omitted.running;
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
  const capture = () => {
    const entry = storage.getStore();
    if (disposed || !entry || entry.finished) return null;
    if (entry.generation !== generation) return entry.logScope
      ? Object.freeze({ logScope: entry.logScope, suppressed: true, finish() {} }) : null;
    const row = { served: null, outcome: 'running', fallbackUsed: false, code: '' };
    // Past the cap only the outcome is counted, so the call is reported incomplete.
    const kept = entry.routes.length < 16;
    if (kept) entry.routes.push(row);
    else { entry.omitted.total++; entry.omitted.running++; }
    let settled = false;
    return Object.freeze({
      sessionId: entry.sessionId, callId: entry.callId, logScope: entry.logScope,
      finish(route) {
        if (settled || disposed || entry.generation !== generation || entry.finished) return;
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
        if (Array.isArray(route?.resultProviders)) {
          row.resultProviders = [...new Set(route.resultProviders.filter(provider => providers.has(provider) && provider !== 'grok-sources'))].slice(0, 5);
          row.resultProvidersComplete = route.resultProvidersComplete === true;
        }
      },
    });
  };
  return Object.freeze({
    run, capture,
    read(sessionId, callId) {
      if (disposed || !identity(sessionId, 128) || !identity(callId, 512)) return unknown();
      const id = key(sessionId, callId);
      return view(active.get(id) ?? completed.get(id));
    },
    clear() { generation++; active.clear(); completed.clear(); },
    dispose() { disposed = true; generation++; active.clear(); completed.clear(); storage.disable(); },
  });
}
