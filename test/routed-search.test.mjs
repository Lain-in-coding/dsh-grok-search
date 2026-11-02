import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoutedSearch } from '../src/core/routed-search.mjs';
import { createReleaseBarrier } from '../src/core/release-transaction.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';

const QUERY = 'secret-query-text-7f3a';
const sourceResult = (provider, failures = []) => ({ content: '', sources: [{ url: 'https://result.test/a' }],
  search_provider: provider, fallback_used: true, fallback_reason: 'grok-unavailable',
  diagnostic: { provider, failures } });

function harness({ grok, sources = {}, prefs = { grokEnabled: true }, barrier = createReleaseBarrier(),
  budgetMs = 120_000, cleanupMs = 2_000, getConfig = () => ({}) } = {}) {
  const calls = { grok: 0, sources: [] };
  let clock = 1_000;
  const routed = createRoutedSearch({
    grok: { search: async (request, signal) => { calls.grok += 1; return grok(request, signal); } },
    sourceRouter: {
      snapshot: () => ({ available: sources.available !== false }),
      search: async input => { calls.sources.push(input); return sources.search(input); },
    },
    preferences: { snapshot: () => ({ value: prefs }) },
    releaseBarrier: barrier,
    getConfig, budgetMs, cleanupMs,
    now: () => clock++,
  });
  return { routed, calls, barrier };
}

test('Grok success is recorded as served by grok', async () => {
  const { routed, barrier } = harness({ grok: async () => ({ content: 'ok', sources: [] }) });
  assert.equal(routed.routeSnapshot(), null);
  const result = await routed.search({ query: QUERY }, undefined);
  assert.equal(result.content, 'ok');
  assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'ok', served: 'grok',
    grokCode: null, fallbackUsed: false, failures: [] });
  assert.deepEqual(barrier.snapshot().activeOperationIds, []);
});

test('shared response character cap bounds both Grok and source-only serialized outputs', async () => {
  for (const enabled of [true, false]) {
    const result = { content: '\\"🙂'.repeat(30_000),
      sources: [{ url: 'https://a.test', title: '中文'.repeat(50), snippet: '内容'.repeat(500) }],
      diagnostic: { fallbackUsed: false } };
    const { routed } = harness({ prefs: { grokEnabled: enabled }, getConfig: () => ({ response_max_chars: { value: 5000 } }),
      grok: async () => result, sources: { search: async () => ({ ...result, search_provider: 'tavily', fallback_used: true }) } });
    const answer = await routed.search({ query: 'q' });
    assert.ok(JSON.stringify(answer).length <= 5000);
    assert.equal(answer.truncated, true);
    assert.equal(Object.keys(answer).includes('diagnostic'), false);
    await routed.dispose();
  }
});

test('the shared store effective fields envelope controls the real outer output budget', async () => {
  for (const maxChars of [5000, 90000]) {
    const { routed } = harness({
      getConfig: () => ({ fields: { response_max_chars: { value: maxChars, source: 'file' } } }),
      grok: async () => ({ content: 'x'.repeat(80000), sources: [] }),
    });
    const answer = await routed.search({ query: 'q' });
    assert.ok(JSON.stringify(answer).length <= maxChars);
    assert.equal(answer.truncated, maxChars < 80000);
    const envelopeLength = JSON.stringify({ content: '', sources: [], truncated: true }).length;
    assert.equal(answer.content.length, maxChars < 80000 ? maxChars - envelopeLength : 80000);
    await routed.dispose();
  }
});

test('an invalid budget inside effective fields fails before dispatching any provider', async () => {
  const { routed, calls } = harness({
    getConfig: () => ({ fields: { response_max_chars: { value: 0, source: 'environment' } } }),
    grok: async () => ({ content: 'unused', sources: [] }),
  });
  await assert.rejects(routed.search({ query: 'q' }), { code: 'GROK_CONFIG_INVALID' });
  assert.equal(calls.grok, 0);
  assert.equal(calls.sources.length, 0);
  await routed.dispose();
});

test('bounded tool output retains non-enumerable source routing metadata for the settings gateway', async () => {
  const answer = { content: '', sources: [{ url: 'https://a.test' }], truncated: false };
  Object.defineProperties(answer, { search_provider: { value: 'exa' }, fallback_used: { value: true },
    fallback_reason: { value: 'grok-disabled' }, diagnostic: { value: { provider: 'exa', failures: [] } } });
  const { routed } = harness({ prefs: { grokEnabled: false }, sources: { search: async () => answer } });
  const result = await routed.search({ query: 'q' });
  assert.equal(result.search_provider, 'exa');
  assert.equal(result.fallback_used, true);
  assert.equal(result.fallback_reason, 'grok-disabled');
  assert.equal(result.diagnostic.provider, 'exa');
  assert.deepEqual(Object.keys(result), ['content', 'sources', 'truncated']);
  await routed.dispose();
});

test('sources-only uses the same one-running eight-queued limit', async () => {
  let resolve, running = 0, peak = 0, count = 0;
  const gate = new Promise(done => { resolve = done; });
  const { routed } = harness({ prefs: { grokEnabled: false },
    sources: { search: async () => { running++; peak = Math.max(peak, running); count++; await gate; running--; return sourceResult('exa'); } } });
  const tasks = Array.from({ length: 9 }, (_, i) => routed.search({ query: String(i) }));
  await new Promise(done => setImmediate(done));
  assert.equal(count, 1);
  assert.equal(routed.snapshot().queued, 8);
  await assert.rejects(routed.search({ query: 'overflow' }), { code: 'GROK_QUEUE_FULL' });
  resolve(); await Promise.all(tasks);
  assert.equal(peak, 1);
  await routed.dispose();
});

test('stop aborts in-flight sources and rejects queued requests before barrier drain', async () => {
  let aborted = false;
  const { routed, barrier } = harness({ prefs: { grokEnabled: false }, sources: {
    search: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(signal.reason);
    }, { once: true })),
  } });
  const first = routed.search({ query: 'q' });
  const firstRejected = assert.rejects(first, { code: 'GROK_SEARCH_STOPPING' });
  const second = routed.search({ query: 'queued' });
  const secondRejected = assert.rejects(second, { code: 'GROK_SEARCH_STOPPING' });
  await new Promise(done => setImmediate(done));
  barrier.invalidate({ reason: 'native-stop' });
  await routed.dispose();
  await Promise.all([firstRejected, secondRejected]);
  await barrier.drain();
  assert.equal(aborted, true);
  assert.equal(routed.routeSnapshot(), null);
});

test('a single total budget ends Grok without giving sources another full timeout', async () => {
  const { routed, calls } = harness({ budgetMs: 80, cleanupMs: 20,
    grok: (request, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    sources: { search: async () => sourceResult('exa') } });
  await assert.rejects(routed.search({ query: 'q' }), { code: 'GROK_TIMEOUT' });
  assert.equal(calls.sources.length, 0);
  await routed.dispose();
});

test('output budget captured at dispatch rejects bad config instead of silent fallback', async () => {
  const { routed, calls } = harness({ getConfig: () => ({ response_max_chars: 0 }),
    grok: async () => ({ sources: [] }), sources: { search: async () => sourceResult('exa') } });
  await assert.rejects(routed.search({ query: 'q' }), { code: 'GROK_CONFIG_INVALID' });
  assert.equal(calls.grok, 0);
  assert.equal(calls.sources.length, 0);
  await routed.dispose();
});

test('grok-search-rs internal fallback is recorded as grok-sources with a stable reason only', async () => {
  const { routed } = harness({ grok: async () => ({ sources: [], diagnostic: { fallbackUsed: true, fallbackReason: 'grok_auth_error' } }) });
  await routed.search({ query: QUERY });
  assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'ok', served: 'grok-sources',
    grokCode: 'grok_auth_error', fallbackUsed: true, failures: [] });
  const free = harness({ grok: async () => ({ sources: [], diagnostic: { fallbackUsed: true, fallbackReason: 'upstream said: bad key sk-123' } }) });
  await free.routed.search({ query: QUERY });
  assert.equal(free.routed.routeSnapshot().grokCode, 'grok_provider_error');
});

test('a failed Grok falls back to the shared source chain and records the primary code', async () => {
  const { routed, calls } = harness({
    grok: async () => { throw new GrokSearchError('GROK_TIMEOUT', '超时'); },
    sources: { search: async () => sourceResult('exa', [{ provider: 'tavily', code: 'HTTP_401', httpStatus: 401, message: 'Tavily 拒绝了 Key' }]) },
  });
  const result = await routed.search({ query: QUERY, maxResults: 3 }, undefined);
  assert.equal(result.search_provider, 'exa');
  assert.equal(calls.sources.length, 1);
  assert.equal(calls.sources[0].reason, 'grok-unavailable');
  assert.equal(calls.sources[0].query, QUERY);
  assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'ok', served: 'exa',
    grokCode: 'GROK_TIMEOUT', fallbackUsed: true, failures: [{ provider: 'tavily', code: 'HTTP_401' }] });
});

test('without an available source the primary failure is thrown and recorded', async () => {
  const primary = new GrokSearchError('GROK_PROGRAM_PREPARING', '正在准备');
  const { routed, calls } = harness({ grok: async () => { throw primary; }, sources: { available: false } });
  await assert.rejects(() => routed.search({ query: QUERY }), error => error === primary);
  assert.equal(calls.sources.length, 0);
  assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'failed', served: null,
    grokCode: 'GROK_PROGRAM_PREPARING', fallbackUsed: false, failures: [], code: 'GROK_PROGRAM_PREPARING' });
});

test('when every source fails the error keeps grok first and the route lists only the sources', async () => {
  const { routed } = harness({
    grok: async () => { throw new GrokSearchError('grok_auth_error', 'Grok 拒绝了 Key'); },
    sources: { search: async () => { throw new GrokSearchError('SOURCE_ALL_FAILED', '均失败', { failures: [
      { provider: 'tavily', code: 'HTTP_429', message: 'Tavily 限流' },
      { provider: 'exa', code: 'NETWORK', message: 'Exa 网络错误' }] }); } },
  });
  await assert.rejects(() => routed.search({ query: QUERY }), error => {
    assert.equal(error.code, 'SOURCE_ALL_FAILED');
    assert.deepEqual(error.details.failures.map(item => [item.provider, item.code]),
      [['grok', 'grok_auth_error'], ['tavily', 'HTTP_429'], ['exa', 'NETWORK']]);
    assert.equal(error.details.failures[0].message, 'Grok 拒绝了 Key');
    return true;
  });
  assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'failed', served: null,
    grokCode: 'grok_auth_error', fallbackUsed: false, code: 'SOURCE_ALL_FAILED',
    failures: [{ provider: 'tavily', code: 'HTTP_429' }, { provider: 'exa', code: 'NETWORK' }] });
});

test('a non-plugin primary error gets the fixed message, never upstream text', async () => {
  const { routed } = harness({
    grok: async () => { throw new Error('raw upstream text with sk-secret'); },
    sources: { search: async () => { throw new GrokSearchError('SOURCE_ALL_FAILED', '均失败', { failures: [] }); } },
  });
  await assert.rejects(() => routed.search({ query: QUERY }), error => {
    assert.deepEqual(error.details.failures, [{ provider: 'grok', code: 'GROK_SEARCH_FAILED', message: 'Grok 查询失败。' }]);
    return true;
  });
  assert.equal(routed.routeSnapshot().grokCode, 'GROK_SEARCH_FAILED');
});

test('Grok switched off goes straight to the sources and records DISABLED', async () => {
  const { routed, calls } = harness({ prefs: { grokEnabled: false },
    grok: async () => { throw new Error('must not run'); },
    sources: { search: async () => sourceResult('tavily') } });
  await routed.search({ query: QUERY });
  assert.equal(calls.grok, 0);
  assert.equal(calls.sources[0].reason, 'grok-disabled');
  assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'ok', served: 'tavily',
    grokCode: 'DISABLED', fallbackUsed: true, failures: [] });

  const empty = harness({ prefs: { grokEnabled: false }, grok: async () => ({}),
    sources: { search: async () => { throw new GrokSearchError('SOURCE_NOT_CONFIGURED', '没有补充来源'); } } });
  await assert.rejects(() => empty.routed.search({ query: QUERY }), error => error.code === 'SOURCE_NOT_CONFIGURED');
  assert.deepEqual(empty.routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'failed', served: null,
    grokCode: 'DISABLED', fallbackUsed: false, failures: [], code: 'SOURCE_NOT_CONFIGURED' });
});

test('an aborted search is not recorded and does not fall back', async () => {
  const controller = new AbortController();
  const reason = new Error('aborted by host');
  const { routed, calls } = harness({
    grok: async () => { controller.abort(reason); throw new GrokSearchError('GROK_ABORTED', '已取消'); },
    sources: { search: async () => sourceResult('tavily') },
  });
  await assert.rejects(() => routed.search({ query: QUERY }, controller.signal), error => error === reason);
  assert.equal(calls.sources.length, 0);
  assert.equal(routed.routeSnapshot(), null);

  const off = new AbortController();
  const disabled = harness({ prefs: { grokEnabled: false }, grok: async () => ({}),
    sources: { search: async () => { off.abort(); throw new GrokSearchError('SOURCE_ABORTED', '已取消'); } } });
  await assert.rejects(() => disabled.routed.search({ query: QUERY }, off.signal));
  assert.equal(disabled.routed.routeSnapshot(), null);
});

test('the origin is kept so settings can tell tests from real searches', async () => {
  const { routed } = harness({ grok: async () => ({ sources: [] }) });
  await routed.search({ query: QUERY }, undefined, 'test');
  assert.equal(routed.routeSnapshot().origin, 'test');
});

test('the route never carries the query, URLs, keys, unknown providers or free-form codes', async () => {
  const { routed } = harness({
    grok: async () => { throw new GrokSearchError('bad code with spaces', 'x'); },
    sources: { search: async () => sourceResult('firecrawl', [
      { provider: 'tavily', code: 'tvly-SECRETKEY value', message: 'Key tvly-SECRETKEY' },
      { provider: 'https://evil.test', code: 'HTTP_500' }]) },
  });
  await routed.search({ query: QUERY });
  const route = routed.routeSnapshot();
  const text = JSON.stringify(route);
  for (const leak of [QUERY, 'result.test', 'SECRETKEY', 'evil.test', 'spaces']) assert.equal(text.includes(leak), false, leak);
  assert.equal(route.grokCode, 'GROK_SEARCH_FAILED');
  assert.deepEqual(route.failures, [{ provider: 'tavily', code: 'GROK_SEARCH_FAILED' }]);
  route.failures.push({ provider: 'exa', code: 'X' });
  assert.equal(routed.routeSnapshot().failures.length, 1, 'snapshots are copies');
});

test('every search and Grok test begins and settles exactly one barrier operation', async () => {
  const events = [];
  const real = createReleaseBarrier();
  const barrier = {
    begin: input => { events.push(['begin', input.operationId]); return real.begin(input); },
    settle: input => { events.push(['settle', input.operationId]); return real.settle(input); },
    snapshot: real.snapshot,
  };
  let release;
  const { routed } = harness({ barrier,
    grok: () => new Promise((resolve, reject) => { release = { resolve, reject }; }),
    sources: { search: async () => sourceResult('tavily') } });
  const pending = routed.search({ query: QUERY });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(real.snapshot().activeOperationIds.length, 1, 'in flight while Grok runs');
  release.reject(new GrokSearchError('GROK_TIMEOUT', '超时'));
  await pending;
  const testing = routed.testGrok({ query: QUERY });
  await new Promise(resolve => setImmediate(resolve));
  release.resolve({ sources: [{ url: 'https://a.test' }], diagnostic: { fallbackUsed: false } });
  assert.deepEqual(await testing, { sources: [{ url: 'https://a.test' }], diagnostic: { fallbackUsed: false } });
  assert.deepEqual(real.snapshot().activeOperationIds, []);
  assert.deepEqual(events.map(([kind]) => kind), ['begin', 'settle', 'begin', 'settle']);
  assert.equal(events[0][1], events[1][1]);
  assert.equal(events[2][1], events[3][1]);
  assert.notEqual(events[0][1], events[2][1]);
});

test('testGrok never falls back and never replaces the recorded route', async () => {
  const { routed, calls } = harness({
    grok: async () => { throw new GrokSearchError('grok_auth_error', 'Grok 拒绝了 Key'); },
    sources: { search: async () => sourceResult('tavily') },
  });
  await assert.rejects(() => routed.testGrok({ query: QUERY }), error => error.code === 'grok_auth_error');
  assert.equal(calls.sources.length, 0);
  assert.equal(routed.routeSnapshot(), null);
});

test('a stopping barrier rejects new searches before any engine runs', async () => {
  const barrier = createReleaseBarrier();
  barrier.invalidate({ reason: 'explicit-user-release' });
  const { routed, calls } = harness({ barrier, grok: async () => ({ sources: [] }),
    sources: { search: async () => sourceResult('tavily') } });
  await assert.rejects(() => routed.search({ query: QUERY }), error => error.code === 'CONTROL_RELEASE_BARRIER_INACTIVE');
  await assert.rejects(() => routed.testGrok({ query: QUERY }), error => error.code === 'CONTROL_RELEASE_BARRIER_INACTIVE');
  assert.equal(calls.grok, 0);
  assert.equal(calls.sources.length, 0);
  assert.equal(routed.routeSnapshot(), null);
});
