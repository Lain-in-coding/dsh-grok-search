import { GrokSearchError } from './errors.mjs';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROVIDERS = new Set(['grok', 'grok-sources', 'tavily', 'exa', 'tinyfish', 'firecrawl']);
const safeCode = code => typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : '';

/** Plugin-owned volatile history. Views do not own or extend its lifetime. */
export function createSearchLog({ now = Date.now, capacity = 20 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 20) throw new TypeError('Invalid search history capacity.');
  let rows = [], generation = 0;
  const closed = new Set();
  const truncatedCalls = new WeakSet();
  const scopes = new WeakMap();
  const omittedCounts = new WeakMap(), settledOmitted = new WeakSet();
  const routeKind = route => route.cancelled ? 'cancelled' : route.outcome !== 'ok' ? 'failed'
    : route.grokCode === 'DISABLED' && !route.failures?.length ? 'sources' : route.fallbackUsed ? 'fallback' : 'ok';
  const routeReason = route => safeCode(route.code || (route.grokCode === 'DISABLED' ? '' : route.grokCode));
  let sequence = 0, disposed = false;
  const rowFor = (query, at) => ({ id: `search-log-${++sequence}`, at,
    q: String(query ?? '').slice(0, 5000), kind: 'running', served: null, ms: null,
    official: null, reason: '', detail: '', calls: [], callsComplete: false });
  const append = row => { rows.unshift(row); rows.length = Math.min(capacity, rows.length); };
  const validate = id => {
    if (typeof id !== 'string' || !ID.test(id)) throw new GrokSearchError('SEARCH_LOG_SESSION_INVALID', '日志会话无效，请重新打开设置页。');
  };
  const snapshot = id => {
    validate(id);
    if (disposed || closed.has(id)) return { records: [] };
    return { records: structuredClone(rows) };
  };
  // An opaque scope is issued only at the host's tools/execute boundary.
  // Identity strings alone cannot merge invocations or resurrect cleared calls.
  const beginCall = ({ sessionId, callId }) => {
    const scope = Object.freeze({});
    scopes.set(scope, { sessionId, callId, at: now(), generation, finished: false, rowId: null });
    return scope;
  };
  const begin = (query, attribution = null) => {
    if (disposed) return null;
    const at = now(), scope = attribution?.logScope && scopes.get(attribution.logScope);
    if (scope) {
      if (scope.generation !== generation || scope.finished) return null;
      let parent = scope.rowId ? rows.find(row => row.id === scope.rowId) : null;
      if (scope.rowId && !parent) return null;
      if (!parent) {
        parent = { ...rowFor(query, scope.at), sessionId: scope.sessionId, callId: scope.callId,
          queries: [], queryCount: 0, queriesComplete: true, callFinished: false };
        scope.rowId = parent.id;
        append(parent);
      }
      parent.queryCount++;
      if (parent.queries.length >= 16) {
        parent.queriesComplete = false;
        let counts = omittedCounts.get(parent);
        if (!counts) {
          counts = { total: 0, running: 0, failed: 0, cancelled: 0, fallback: 0, sources: 0, ok: 0, reasons: {} };
          omittedCounts.set(parent, counts);
        }
        counts.total++; counts.running++;
        return { id: parent.id, at, omitted: true };
      }
      const child = rowFor(query, at);
      parent.queries.push(child);
      return { id: parent.id, queryId: child.id, at };
    }
    const row = rowFor(query, at);
    if (typeof attribution?.sessionId === 'string' && typeof attribution?.callId === 'string') {
      row.sessionId = attribution.sessionId.slice(0, 128);
      row.callId = attribution.callId.slice(0, 512);
    }
    append(row);
    return { id: row.id, at };
  };
  const update = (token, work) => {
    if (!token || disposed) return;
    const parent = rows.find(item => item.id === token.id);
    const row = token.queryId ? parent?.queries?.find(item => item.id === token.queryId) : token.omitted ? null : parent;
    if (row?.kind === 'running') {
      work(row);
      // Preserve the single-query wire shape for older consumers.
      if (parent.queries?.length === 1) {
        parent.calls = row.calls; parent.callsComplete = row.callsComplete; parent.served = row.served;
      }
    }
  };
  const call = (token, input) => update(token, row => {
    if (!PROVIDERS.has(input?.provider)) return;
    if (row.calls.length >= 16) { truncatedCalls.add(row); return; }
    const charge = input.charge;
    const amount = typeof charge?.amount === 'number' && Number.isFinite(charge.amount)
      && charge.amount >= 0 && charge.amount <= 1e9 ? charge.amount : null;
    const unit = ['credits', 'USD'].includes(charge?.unit) ? charge.unit : null;
    row.calls.push({ provider: input.provider, operation: ['retry', 'supplement'].includes(input.operation) ? input.operation : 'search',
      result: ['ok', 'failed', 'cancelled'].includes(input.result) ? input.result : 'unknown',
      ...(input.evidence === 'source-label' ? { evidence: 'source-label' } : {}),
      code: safeCode(input.code), keyIndex: Number.isSafeInteger(input.keyIndex) && input.keyIndex >= 0 && input.keyIndex < 100 ? input.keyIndex : null,
      charge: amount !== null && unit && ['reported', 'estimated'].includes(charge?.basis)
        ? { amount, unit, basis: charge.basis } : { amount: null, unit: null, basis: 'unknown' } });
  });
  const finish = (token, route = {}) => {
    if (token?.omitted) {
      const parent = rows.find(item => item.id === token.id), counts = omittedCounts.get(parent);
      if (disposed || parent?.kind !== 'running' || !counts || settledOmitted.has(token)) return;
      // Drop the row, not its outcome. Token settlement is idempotent, and a
      // cleared/evicted/finished parent never accepts delayed completion.
      settledOmitted.add(token);
      counts.running--;
      const kind = routeKind(route);
      counts[kind]++;
      if (['failed', 'cancelled', 'fallback'].includes(kind)) counts.reasons[kind] ||= routeReason(route);
      return;
    }
    update(token, row => {
      row.ms = Math.max(0, now() - token.at);
      row.served = PROVIDERS.has(route.served) ? route.served : null;
      row.kind = routeKind(route);
      row.reason = routeReason(route);
      if (Array.isArray(route.resultProviders)) {
        row.resultProviders = [...new Set(route.resultProviders.filter(provider => PROVIDERS.has(provider) && provider !== 'grok-sources'))].slice(0, 5);
        row.resultProvidersComplete = route.resultProvidersComplete === true;
      }
      // Only the sources-only adapter path reports every dispatched call.
      row.callsComplete = route.callsComplete === true && !truncatedCalls.has(row);
    });
  };
  const finishCall = (scopeToken, { failed = false, cancelled = false, code = '' } = {}) => {
    const scope = scopes.get(scopeToken);
    if (!scope || scope.finished) return;
    scope.finished = true;
    const row = rows.find(item => item.id === scope.rowId);
    if (disposed || scope.generation !== generation || !row) return;
    row.callFinished = true;
    row.ms = Math.max(0, now() - row.at);
    for (const child of row.queries) if (child.kind === 'running') {
      child.kind = cancelled ? 'cancelled' : 'failed';
      child.reason = 'TOOL_ROUTE_INCOMPLETE';
      child.ms = Math.max(0, now() - child.at);
    }
    const counts = omittedCounts.get(row);
    if (counts?.running) {
      const kind = cancelled ? 'cancelled' : 'failed';
      counts[kind] += counts.running;
      counts.reasons[kind] ||= 'TOOL_ROUTE_INCOMPLETE';
      counts.running = 0;
    }
    row.kind = failed || counts?.failed > 0 || row.queries.some(child => child.kind === 'failed') ? 'failed'
      : cancelled || counts?.cancelled > 0 || row.queries.some(child => child.kind === 'cancelled') ? 'cancelled'
        : counts?.fallback > 0 || row.queries.some(child => child.kind === 'fallback') ? 'fallback'
          : row.queries.every(child => child.kind === 'sources') && (!counts || counts.sources === counts.total) ? 'sources' : 'ok';
    const served = new Set(row.queries.map(child => child.served));
    row.served = row.queriesComplete && served.size === 1 ? served.values().next().value : null;
    row.reason = safeCode(code) || row.queries.find(child => child.kind === row.kind)?.reason
      || counts?.reasons[row.kind] || '';
    row.calls = row.queries.length === 1 ? row.queries[0].calls : [];
    row.callsComplete = row.queriesComplete && row.queries.every(child => child.callsComplete);
  };
  return Object.freeze({
    snapshot, begin, call, finish, beginCall, finishCall,
    clear(id) {
      validate(id);
      if (!disposed && !closed.has(id)) { generation++; rows = []; }
      return { records: [] };
    },
    viewOpen(id) { validate(id); return !disposed && !closed.has(id); },
    close(id) {
      validate(id); closed.add(id);
      // These IDs are revocations, not a cache. Forgetting an old closed view
      // would let its delayed read/clear affect a newly opened settings page.
      // No query or credential is retained here; dispose drops the IDs.
      return { closed: true };
    },
    dispose() { disposed = true; generation++; rows = []; closed.clear(); },
  });
}
