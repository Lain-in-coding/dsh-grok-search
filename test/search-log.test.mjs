import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSearchLog } from '../src/core/search-log.mjs';
import { createRoutedSearch } from '../src/core/routed-search.mjs';
import { createReleaseBarrier } from '../src/core/release-transaction.mjs';
import { createToolRouteContext } from '../src/core/tool-route-context.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';

test('history starts with the plugin, survives navigation and returns bounded detached copies', () => {
  const log = createSearchLog(), a = randomUUID(), b = randomUUID();
  const token = log.begin('<private query>');
  assert.ok(token, 'a search before the first settings visit must be collected');
  log.call(token, { provider: 'tavily', result: 'ok', keyIndex: 0,
    charge: { basis: 'reported', amount: 1, unit: 'credits' } });
  log.finish(token, { outcome: 'ok', served: 'tavily', grokCode: 'DISABLED' });
  const first = log.snapshot(a).records[0];
  assert.equal(first.kind, 'sources');
  assert.equal(first.official, null);
  assert.equal(first.calls[0].charge.amount, 1);
  log.close(a);
  assert.equal(log.snapshot(b).records.length, 1, 'returning from chat sees the earlier search');
  first.q = 'changed';
  assert.equal(log.snapshot(b).records[0].q, '<private query>');
  for (let i = 0; i < 24; i++) log.begin('query ' + i);
  assert.equal(log.snapshot(b).records.length, 20);
  assert.deepEqual(log.snapshot(a), { records: [] }, 'a closed view cannot receive a late response');
  log.dispose();
});

test('clear removes the shared history without letting late results resurrect it', () => {
  const log = createSearchLog(), session = randomUUID(), nextPage = randomUUID();
  log.snapshot(session);
  const token = log.begin('cleared');
  log.clear(session);
  log.finish(token, { outcome: 'ok', served: 'grok' });
  assert.deepEqual(log.snapshot(session), { records: [] });
  log.close(session);
  const next = log.begin('search while the settings page is closed');
  assert.ok(next);
  log.finish(next, { outcome: 'ok', served: 'tavily', grokCode: 'DISABLED' });
  assert.equal(log.snapshot(nextPage).records[0].q, 'search while the settings page is closed');
  log.clear(session);
  assert.equal(log.snapshot(nextPage).records.length, 1, 'a stale closed page cannot clear new history');
  log.clear(nextPage);
  assert.deepEqual(log.snapshot(randomUUID()), { records: [] });
  log.dispose();
});

test('history does not expire with page leases, and untrusted fields are never copied', () => {
  let clock = 0;
  const log = createSearchLog({ now: () => clock }), session = randomUUID();
  assert.throws(() => log.snapshot('not-an-id'));
  log.snapshot(session);
  const token = log.begin('bounded'.repeat(2000));
  log.call(token, { provider: 'unknown', result: 'ok', api_key: 'must-not-copy' });
  log.call(token, { provider: 'exa', result: 'failed', code: 'bad <html>', charge: { amount: -1, unit: 'USD' } });
  log.finish(token, { outcome: 'failed', code: 'unsafe <body>', detail: 'must-not-copy' });
  const value = log.snapshot(session);
  assert.equal(value.records[0].q.length, 5000);
  assert.equal(value.records[0].calls.length, 1);
  assert.equal(value.records[0].calls[0].code, '');
  assert.equal(value.records[0].reason, '');
  assert.equal(JSON.stringify(value).includes('must-not-copy'), false);
  log.close(session);
  clock = 31_000;
  assert.ok(log.begin('search after the former page lease expired'));
  assert.equal(log.snapshot(randomUUID()).records.length, 2);
  log.dispose();
});

test('closed view revocations survive repeated navigation and cannot clear later history', () => {
  const log = createSearchLog(), old = randomUUID(), active = randomUUID();
  log.snapshot(old);
  log.close(old);
  for (let i = 0; i < 80; i++) log.close(randomUUID());
  const token = log.begin('newer private history');
  log.finish(token, { outcome: 'ok', served: 'grok' });
  assert.equal(log.viewOpen(old), false);
  assert.deepEqual(log.snapshot(old), { records: [] });
  log.clear(old);
  assert.equal(log.snapshot(active).records[0].q, 'newer private history');
  log.dispose();
  assert.equal(log.viewOpen(old), false);
});

test('view revocation storage stays bounded and an evicted destructive token cannot clear history', () => {
  const log = createSearchLog({ viewCapacity: 4 }), first = log.open();
  log.snapshot(first);
  for (let i = 0; i < 8; i++) log.open();
  const token = log.begin('new history remains intact');
  log.finish(token, { outcome: 'ok', served: 'grok' });
  assert.throws(() => log.clear(first), { code: 'SEARCH_LOG_VIEW_EXPIRED' });
  assert.throws(() => log.snapshot(first), { code: 'SEARCH_LOG_VIEW_EXPIRED' });
  log.close(first);
  assert.equal(log.snapshot(randomUUID()).records[0].q, 'new history remains intact');
  log.dispose();
});

test('issued views expire after inactivity, never resurrect, and active reads renew them', () => {
  let clock = 0;
  const log = createSearchLog({ now: () => clock, viewTtlMs: 10, viewCapacity: 2 });
  const closed = log.open(), active = log.open();
  log.close(closed);
  for (let i = 0; i < 4; i++) { clock += 9; log.snapshot(active); }
  assert.equal(log.viewOpen(active), true);
  assert.throws(() => log.snapshot(closed), { code: 'SEARCH_LOG_VIEW_EXPIRED' });
  clock += 11;
  assert.throws(() => log.snapshot(active), { code: 'SEARCH_LOG_VIEW_EXPIRED' });
  log.dispose();
});

test('legacy UUID revocations cannot be evicted and capacity exhaustion fails explicitly', () => {
  const log = createSearchLog({ viewCapacity: 2 }), old = randomUUID();
  log.snapshot(old); log.close(old); log.snapshot(randomUUID());
  assert.throws(() => log.snapshot(randomUUID()), { code: 'SEARCH_LOG_VIEW_EXPIRED' });
  assert.deepEqual(log.snapshot(old), { records: [] });
  log.dispose();
});

test('bounded call list never presents a truncated retry list as complete', () => {
  const log = createSearchLog(), id = randomUUID();
  log.snapshot(id);
  const token = log.begin('many keys');
  for (let i = 0; i < 20; i++) log.call(token, { provider: 'tavily', keyIndex: i, result: 'failed' });
  log.finish(token, { outcome: 'failed', callsComplete: true });
  assert.equal(log.snapshot(id).records[0].calls.length, 16);
  assert.equal(log.snapshot(id).records[0].callsComplete, false);
  log.dispose();
});

test('multiple views share one ring and disposal clears history and rejects late completion', () => {
  let clock = 0;
  const log = createSearchLog({ now: () => clock });
  const ids = Array.from({ length: 9 }, () => randomUUID());
  for (const id of ids) log.snapshot(id);
  const old = log.begin('earlier search');
  log.finish(old, { outcome: 'ok', served: 'grok' });
  clock = 29_999;
  log.snapshot(ids[0]);
  clock = 30_001;
  log.snapshot(ids[8]);
  const token = log.begin('all enabled-plugin searches');
  log.finish(token, { outcome: 'ok', served: 'grok' });
  assert.equal(log.snapshot(ids[0]).records.length, 2);
  assert.equal(log.snapshot(ids[8]).records.length, 2);
  assert.equal(log.snapshot(ids[1]).records.length, 2);
  log.dispose();
  log.finish(token, { outcome: 'ok', served: 'tavily' });
  assert.deepEqual(log.snapshot(ids[0]), { records: [] });
  assert.equal(log.begin('after disposal'), null);
});

test('independent plugin instances never share private search history', () => {
  const first = createSearchLog(), second = createSearchLog();
  first.begin('first profile only');
  assert.deepEqual(second.snapshot(randomUUID()), { records: [] });
  first.dispose(); second.dispose();
});

test('parent duration uses the tool-call wall clock including post-search completion, never a sum', () => {
  let clock = 1000;
  const log = createSearchLog({ now: () => clock });
  const scope = log.beginCall({ sessionId: randomUUID(), callId: 'timing' });
  clock = 1010;
  const first = log.begin('first', { logScope: scope });
  const second = log.begin('second', { logScope: scope });
  clock = 1020; log.finish(first, { outcome: 'ok', served: 'tavily' });
  clock = 1030; log.finish(second, { outcome: 'ok', served: 'tavily' });
  clock = 1400; log.finishCall(scope);
  const row = log.snapshot(randomUUID()).records[0];
  assert.equal(row.ms, 400);
  assert.deepEqual(row.queries.map(query => query.ms), [10, 20]);
  log.dispose();
});

test('routed search records actual results only, not diagnostics or replay requests', async () => {
  const routed = createRoutedSearch({
    grok: { search: async () => ({ content: '', sources: [{ url: 'https://result.test' }] }) },
    sourceRouter: {}, releaseBarrier: createReleaseBarrier(),
  });
  const id = randomUUID();
  routed.searchLog.snapshot(id);
  await routed.search({ query: 'real search' });
  await routed.search({ query: 'test search' }, undefined, 'test');
  await routed.testGrok({ query: 'diagnostic' });
  const rows = routed.searchLog.snapshot(id).records;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].q, 'real search');
  assert.equal(rows[0].kind, 'ok');
  assert.equal(rows[0].callsComplete, false);
  assert.equal(rows[0].calls[0].provider, 'grok');
  assert.equal(rows[0].official, null);
  await routed.dispose();
});

test('cancellation and stop finalize running records without an invented source', async () => {
  const routed = createRoutedSearch({
    grok: { search: (request, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
    sourceRouter: {}, releaseBarrier: createReleaseBarrier(),
  });
  const id = randomUUID(), controller = new AbortController();
  routed.searchLog.snapshot(id);
  const task = routed.search({ query: 'cancel me' }, controller.signal);
  const rejected = assert.rejects(task);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('private reason'));
  await rejected;
  const row = routed.searchLog.snapshot(id).records[0];
  assert.equal(row.kind, 'cancelled');
  assert.equal(row.served, null);
  assert.equal(JSON.stringify(row).includes('private reason'), false);
  await routed.dispose();
});

const okRoute = { outcome: 'ok', served: 'grok', callsComplete: true };
const sourcesRoute = { outcome: 'ok', served: 'tavily', grokCode: 'DISABLED', fallbackUsed: true, callsComplete: true };
function cappedLog(route = okRoute) {
  const log = createSearchLog(), view = randomUUID();
  log.snapshot(view);
  const scope = log.beginCall({ sessionId: randomUUID(), callId: 'capped-call' });
  const begin = () => log.begin('query', { logScope: scope });
  for (let i = 0; i < 16; i++) log.finish(begin(), route);
  return { log, view, scope, begin, read: () => log.snapshot(view).records[0] };
}

test('an omitted query failure sets the batch failure and safe reason without storing another row', () => {
  const { log, scope, begin, read } = cappedLog();
  const token = begin();
  log.finish(token, { outcome: 'failed', code: 'HTTP_429' });
  log.finish(token, okRoute);
  assert.equal(read().kind, 'running', 'only the host completion settles the whole call');
  log.finishCall(scope);
  const row = read();
  assert.equal(row.kind, 'failed');
  assert.equal(row.reason, 'HTTP_429');
  assert.equal(row.queries.length, 16);
  assert.equal(row.queryCount, 17);
  assert.equal(row.queriesComplete, false);
  assert.equal(row.callsComplete, false);
  assert.equal(row.served, null);
  assert.equal(row.queries.every(query => query.kind === 'ok'), true);
  log.dispose();
});

test('omitted cancellations and fallback retain their outcome and respect failure priority', () => {
  const fallback = { outcome: 'ok', served: 'exa', grokCode: 'grok_timeout', fallbackUsed: true };
  const cancelled = { outcome: 'failed', cancelled: true, code: 'GROK_SEARCH_CANCELLED' };
  const failed = { outcome: 'failed', code: 'HTTP_401' };
  for (const [routes, kind, reason] of [
    [[cancelled], 'cancelled', 'GROK_SEARCH_CANCELLED'],
    [[fallback], 'fallback', 'grok_timeout'],
    [[fallback, cancelled], 'cancelled', 'GROK_SEARCH_CANCELLED'],
    [[fallback, cancelled, failed], 'failed', 'HTTP_401'],
  ]) {
    const { log, scope, begin, read } = cappedLog();
    for (const route of routes) log.finish(begin(), route);
    log.finishCall(scope);
    assert.equal(read().kind, kind);
    assert.equal(read().reason, reason);
    assert.equal(read().callsComplete, false);
    assert.equal(read().served, null);
    log.dispose();
  }
});

test('successful omitted queries preserve sources-only or mixed successful batch classification', () => {
  for (const [retained, omitted, kind] of [
    [okRoute, okRoute, 'ok'], [sourcesRoute, sourcesRoute, 'sources'],
    [sourcesRoute, okRoute, 'ok'], [okRoute, sourcesRoute, 'ok'],
  ]) {
    const { log, scope, begin, read } = cappedLog(retained);
    log.finish(begin(), omitted);
    log.finishCall(scope);
    assert.equal(read().kind, kind);
    assert.equal(read().reason, '');
    assert.equal(read().callsComplete, false);
    assert.equal(read().served, null);
    assert.equal(read().queries.length, 16);
    log.dispose();
  }
});

test('unfinished omitted queries settle once and reject late completion, clear and disposal', () => {
  for (const cancelled of [false, true]) {
    const { log, view, scope, begin, read } = cappedLog();
    const token = begin();
    log.finishCall(scope, { cancelled });
    assert.equal(read().kind, cancelled ? 'cancelled' : 'failed');
    assert.equal(read().reason, 'TOOL_ROUTE_INCOMPLETE');
    const before = log.snapshot(view);
    log.finish(token, okRoute);
    log.call(token, { provider: 'exa', result: 'ok' });
    log.finishCall(scope);
    assert.deepEqual(log.snapshot(view), before);
    log.dispose();
  }
  const { log, view, scope, begin } = cappedLog();
  const token = begin();
  log.clear(view);
  log.finish(log.begin('new call'), okRoute);
  const afterClear = log.snapshot(view);
  log.finish(token, { outcome: 'failed', code: 'HTTP_429' });
  log.finishCall(scope);
  assert.deepEqual(log.snapshot(view), afterClear);
  assert.equal(log.begin('late child', { logScope: scope }), null);
  log.dispose();
  log.finish(token, okRoute);
  assert.deepEqual(log.snapshot(view), { records: [] });
  const evicted = cappedLog();
  const evictedToken = evicted.begin();
  for (let i = 0; i < 20; i++) evicted.log.finish(evicted.log.begin('newer call'), okRoute);
  const afterEviction = evicted.log.snapshot(evicted.view);
  evicted.log.finish(evictedToken, { outcome: 'failed', code: 'HTTP_429' });
  evicted.log.finishCall(evicted.scope);
  assert.deepEqual(evicted.log.snapshot(evicted.view), afterEviction);
  evicted.log.dispose();
});

test('routed omitted failures reach log finalization before the host scope settles', async () => {
  const history = createSearchLog(), context = createToolRouteContext({ searchLog: history });
  let searches = 0;
  const routed = createRoutedSearch({ searchLog: history, releaseBarrier: createReleaseBarrier(),
    sourceRouter: { snapshot: () => ({ available: false }) }, grok: { search: async () => {
      if (++searches === 17) throw new GrokSearchError('grok_timeout', 'Grok 响应超时。');
      return { sources: [{ url: 'https://example.test/source' }] };
    } } });
  try {
    await context.run({ name: 'web_search', callId: 'routed-cap', agent: { session: { id: randomUUID() } } }, async () => {
      for (let i = 0; i < 16; i++) await routed.search({ query: 'ok' }, undefined, 'search', context.capture());
      await assert.rejects(routed.search({ query: 'omitted' }, undefined, 'search', context.capture()), { code: 'grok_timeout' });
    });
    const row = history.snapshot(randomUUID()).records[0];
    assert.equal(row.kind, 'failed', 'the tool callback returned normally, so only the omitted query proves the failure');
    assert.equal(row.reason, 'grok_timeout');
    assert.equal(row.queries.length, 16);
    assert.equal(row.queryCount, 17);
    assert.equal(row.callsComplete, false);
    assert.equal(row.served, null);
  } finally { await routed.dispose(); context.dispose(); history.dispose(); }
});
