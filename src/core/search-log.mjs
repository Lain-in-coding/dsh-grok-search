import { GrokSearchError } from './errors.mjs';
import { randomUUID } from 'node:crypto';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROVIDERS = new Set(['grok', 'grok-sources', 'tavily', 'exa', 'tinyfish', 'firecrawl', 'github']);
const safeCode = code => typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : '';

/** Plugin-owned volatile history. Views do not own or extend its lifetime. */
export function createSearchLog({ now = Date.now, capacity = 20, viewCapacity = 256, viewTtlMs = 10 * 60_000 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 20) throw new TypeError('Invalid search history capacity.');
  if (!Number.isSafeInteger(viewCapacity) || viewCapacity < 1 || viewCapacity > 4096) throw new TypeError('Invalid search history view capacity.');
  if (!Number.isSafeInteger(viewTtlMs) || viewTtlMs < 1) throw new TypeError('Invalid search history view lifetime.');
  let rows = [], generation = 0;
  const views = new Map();
  // Old clients mint UUIDs themselves. Keep a bounded, non-evicting table for
  // them: forgetting a revocation would make an old UUID appear new again.
  const legacyViews = new Map();
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
    if (typeof id !== 'string' || !ID.test(id.startsWith('view:') ? id.slice(5) : id)) throw new GrokSearchError('SEARCH_LOG_SESSION_INVALID', '日志会话无效，请重新打开设置页。');
  };
  const expired = () => { throw new GrokSearchError('SEARCH_LOG_VIEW_EXPIRED', '日志视图已失效，请重新打开设置页。'); };
  const pruneViews = () => {
    const at = now();
    for (const [id, view] of views) if (at - view.at >= viewTtlMs) views.delete(id);
  };
  const open = () => {
    if (disposed) expired();
    pruneViews();
    while (views.size >= viewCapacity) views.delete(views.keys().next().value);
    const id = 'view:' + randomUUID();
    views.set(id, { open: true, at: now() });
    return id;
  };
  const viewFor = (id, create = false) => {
    validate(id);
    if (disposed) return null;
    if (id.startsWith('view:')) {
      pruneViews();
      const view = views.get(id);
      if (view) { views.delete(id); view.at = now(); views.set(id, view); }
      else if (create) expired();
      return view ?? null;
    }
    let view = legacyViews.get(id);
    if (!view && create) {
      if (legacyViews.size >= viewCapacity) expired();
      view = { open: true, at: now() };
      legacyViews.set(id, view);
    }
    return view ?? null;
  };
  const snapshot = id => {
    const view = viewFor(id, true);
    if (!view?.open) return { records: [] };
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
    row.calls.push({ provider: input.provider, operation: ['retry', 'supplement', 'fetch'].includes(input.operation) ? input.operation : 'search',
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
    if (row.recordType === 'github') {
      if (failed || cancelled || row.kind === 'running') {
        row.kind = cancelled ? 'cancelled' : 'failed';
        row.reason = safeCode(code) || 'TOOL_ROUTE_INCOMPLETE';
      }
      return;
    }
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
  const finalizeCall = (scopeToken, { failed = false, cancelled = false, code = '' } = {}) => {
    const scope = scopes.get(scopeToken);
    if (disposed || !scope?.finished || scope.finalized || scope.generation !== generation) return;
    scope.finalized = true;
    const row = rows.find(item => item.id === scope.rowId);
    if (!row) return;
    row.ms = Math.max(0, now() - row.at);
    // Supplier outcomes and usage remain factual even if the host rejects delivery.
    if (failed || cancelled) {
      row.kind = cancelled ? 'cancelled' : 'failed';
      row.reason = safeCode(code) || 'TOOL_ROUTE_INCOMPLETE';
    }
  };
  return Object.freeze({
    open, snapshot, begin, call, finish, beginCall, finishCall, finalizeCall,
    beginRead(url, attribution) {
      const scope = attribution?.logScope && scopes.get(attribution.logScope);
      if (disposed || attribution?.suppressed || scope && (scope.finished || scope.generation !== generation || scope.rowId)) return null;
      const token = begin(url, { sessionId: attribution?.sessionId, callId: attribution?.callId });
      update(token, row => { row.recordType = 'github'; row.served = 'github'; row.callFinished = false; });
      if (scope) scope.rowId = token.id;
      return token;
    },
    finishRead(token, result, failure = null) {
      update(token, row => {
        row.segment = result?.segment ?? null;
        row.cacheHit = result?.cacheHit === true;
        row.hasMore = result?.hasMore === true;
        row.acquiredComplete = result?.acquiredComplete === true;
        row.apiRequests = result?.apiRequests ?? null;
        row.detail = result?.incomplete?.message ?? '';
      });
      call(token, { provider: 'github', operation: 'fetch', result: failure ? failure.cancelled ? 'cancelled' : 'failed' : 'ok',
        code: failure?.code ?? result?.incomplete?.code ?? '' });
      finish(token, { served: 'github', outcome: failure ? 'failed' : 'ok', cancelled: failure?.cancelled,
        code: failure?.code ?? result?.incomplete?.code ?? '', callsComplete: true,
        resultProviders: ['github'], resultProvidersComplete: true });
    },
    clear(id) {
      if (disposed) return { records: [] };
      const view = viewFor(id);
      // An evicted or never-opened token is inert: it can return an empty
      // result for a legacy client, but an issued view must report expiry so
      // the current UI cannot acknowledge a clear that never happened.
      if (!view) {
        if (id.startsWith('view:')) expired();
        return { records: [] };
      }
      if (view.open) { generation++; rows = []; }
      return { records: [] };
    },
    viewOpen(id) { return viewFor(id)?.open === true; },
    close(id) {
      validate(id);
      if (id.startsWith('view:')) { views.delete(id); return { closed: true }; }
      const view = viewFor(id, true);
      if (view) { view.open = false; view.at = now(); }
      return { closed: true };
    },
    dispose() { disposed = true; generation++; rows = []; views.clear(); legacyViews.clear(); },
  });
}
