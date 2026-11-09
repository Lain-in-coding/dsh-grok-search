import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoutedSearch } from '../src/core/routed-search.mjs';
import { createReleaseBarrier } from '../src/core/release-transaction.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';
import { randomUUID } from 'node:crypto';
import { createSourceRouter } from '../src/core/source-adapters.mjs';

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
    // Reading the clock is not the passage of time. History now samples both
    // start and completion; these route-shape assertions hold time fixed.
    now: () => clock,
  });
  return { routed, calls, barrier };
}

test('Grok success is recorded as served by grok', async () => {
  const { routed, barrier } = harness({ grok: async () => ({ content: 'ok', sources: [{ url: 'https://g.test' }] }) });
  assert.equal(routed.routeSnapshot(), null);
  const result = await routed.search({ query: QUERY }, undefined);
  assert.equal(result.content, 'ok');
  assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'ok', served: 'grok',
    grokCode: null, fallbackUsed: false, failures: [] });
  assert.deepEqual(barrier.snapshot().activeOperationIds, []);
});

test('primary references lost to the output budget use the configured fallback and record its actual route', async () => {
  const { routed, calls } = harness({
    getConfig: () => ({ response_max_chars: 100 }),
    grok: async () => ({ content: 'answer', sources: [{ url: 'https://g.test/' + 'x'.repeat(400) }] }),
    sources: { search: async () => sourceResult('exa') },
  });
  try {
    const result = await routed.search({ query: QUERY });
    assert.equal(result.sources.length, 1);
    assert.equal(calls.grok, 1);
    assert.equal(calls.sources.length, 1);
    assert.ok(JSON.stringify(result).length <= 100);
    assert.equal(routed.routeSnapshot().served, 'exa');
    assert.equal(routed.routeSnapshot().grokCode, 'OUTPUT_LIMIT');
    const [record] = routed.searchLog.snapshot(randomUUID()).records;
    assert.equal(record.kind, 'fallback');
    assert.equal(record.served, 'exa');
    assert.equal(record.reason, 'OUTPUT_LIMIT');
    assert.equal(record.calls[0].result, 'failed');
  } finally { await routed.dispose(); }
});

for (const [sources, code] of [
  [[], 'grok_sources_empty'],
  [[{ url: 'javascript:alert(1)' }], 'grok_sources_empty'],
  [[{ url: 'https://g.test/' + 'x'.repeat(400) }], 'OUTPUT_LIMIT'],
]) {
  test(`primary ${code} fails explicitly without a fallback instead of recording success`, async () => {
    const { routed, calls } = harness({
      getConfig: () => ({ response_max_chars: 100 }),
      grok: async () => ({ content: 'answer', sources }), sources: { available: false },
    });
    try {
      await assert.rejects(routed.search({ query: QUERY }), { code });
      assert.equal(calls.sources.length, 0);
      assert.equal(routed.routeSnapshot().outcome, 'failed');
      assert.equal(routed.searchLog.snapshot(randomUUID()).records[0].kind, 'failed');
    } finally { await routed.dispose(); }
  });
}

test('an explicit zero-reference request remains successful without unnecessary fallback', async () => {
  const { routed, calls } = harness({
    grok: async () => ({ content: 'answer', sources: [{ url: 'https://g.test' }] }),
  });
  try {
    const result = await routed.search({ query: QUERY, maxResults: 0 });
    assert.deepEqual(result.sources, []);
    assert.equal(result.content, 'answer');
    assert.equal(routed.routeSnapshot().outcome, 'ok');
    assert.equal(calls.sources.length, 0);
  } finally { await routed.dispose(); }
});

test('primary diagnosis enforces the same reference contract without invoking fallback', async () => {
  const { routed, calls } = harness({
    grok: async () => ({ content: 'answer', sources: [] }),
  });
  try {
    await assert.rejects(routed.testGrok({ query: QUERY }), { code: 'grok_sources_empty' });
    assert.equal(calls.sources.length, 0);
    assert.equal(routed.routeSnapshot(), null);
    assert.equal(routed.searchLog.snapshot(randomUUID()).records.length, 0);
    assert.deepEqual(await routed.testGrok({ query: QUERY, maxResults: 0 }), { sources: [], diagnostic: null });
  } finally { await routed.dispose(); }
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

test('the shared store effective fields envelope controls the outer budget for explicit zero-reference requests', async () => {
  for (const maxChars of [5000, 90000]) {
    const { routed } = harness({
      getConfig: () => ({ fields: { response_max_chars: { value: maxChars, source: 'file' } } }),
      grok: async () => ({ content: 'x'.repeat(80000), sources: [] }),
    });
    const answer = await routed.search({ query: 'q', maxResults: 0 });
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

test('a single total budget ends Grok when no fallback is available', async () => {
  const { routed, calls } = harness({ budgetMs: 80, cleanupMs: 20,
    grok: (request, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    sources: { available: false, search: async () => sourceResult('exa') } });
  await assert.rejects(routed.search({ query: 'q' }), { code: 'GROK_TIMEOUT' });
  assert.equal(calls.sources.length, 0);
  await routed.dispose();
});

test('a slow primary leaves time for a configured fallback within the original deadline', async () => {
  const { routed, calls } = harness({ budgetMs: 240, cleanupMs: 20,
    grok: (request, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    sources: { search: async ({ signal, remainingMs }) => {
      assert.equal(signal.aborted, false);
      assert.ok(remainingMs() > 0 && remainingMs() < 100);
      return sourceResult('exa');
    } } });
  try {
    const answer = await routed.search({ query: 'q' });
    assert.equal(answer.search_provider, 'exa');
    assert.equal(calls.sources.length, 1);
    assert.equal(routed.routeSnapshot().grokCode, 'GROK_STAGE_TIMEOUT');
  } finally { await routed.dispose(); }
});

test('one dispatched request retains its original source configuration after a concurrent save', async () => {
  let config = { tavily_api_key: 'old', timeout_seconds: 60 };
  const { routed } = harness({ getConfig: () => config,
    grok: async () => { config = { tavily_api_key: 'new', timeout_seconds: 5 }; throw new Error('unavailable'); },
    sources: { search: async ({ configuration }) => {
      assert.equal(configuration.tavily_api_key, 'old');
      return sourceResult('tavily');
    } } });
  try { await routed.search({ query: 'q' }); } finally { await routed.dispose(); }
});

test('an old in-flight result stays in history but cannot validate a replacement credential', async () => {
  let config = { tavily_api_key: 'old-key', response_max_chars: 5000 };
  let finish;
  const { routed } = harness({
    prefs: { grokEnabled: false }, getConfig: () => config,
    sources: { search: () => new Promise(resolve => { finish = resolve; }) },
  });
  try {
    const pending = routed.search({ query: 'configuration attribution' });
    await new Promise(resolve => setImmediate(resolve));
    config = { ...config, tavily_api_key: 'new-key' };
    finish(sourceResult('tavily'));
    assert.equal((await pending).sources.length, 1, 'the valid in-flight response still completes');
    assert.equal(routed.routeSnapshot(), null, 'current health must not inherit the old credential result');
    const records = routed.searchLog.snapshot(randomUUID()).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].served, 'tavily');
    assert.equal(records[0].kind, 'sources');
  } finally { await routed.dispose(); }
});

test('route health expires on effective configuration changes and unreadable configuration', async () => {
  let config = { grok_api_key: 'first-key' }, broken = false;
  const { routed } = harness({
    getConfig: () => { if (broken) throw new GrokSearchError('CONFIG_PARSE_FAILED', 'invalid TOML'); return config; },
    grok: async () => ({ content: 'ok', sources: [{ url: 'https://g.test' }] }),
  });
  try {
    await routed.search({ query: 'first' });
    assert.equal(routed.routeSnapshot().served, 'grok');
    config = { grok_api_key: 'other-key' };
    assert.equal(routed.routeSnapshot(), null);
    await routed.search({ query: 'second' });
    assert.equal(routed.routeSnapshot().served, 'grok');
    broken = true;
    assert.equal(routed.routeSnapshot(), null);
  } finally { await routed.dispose(); }
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
  const { routed } = harness({ grok: async () => ({ sources: [{ url: 'https://g.test' }], diagnostic: { fallbackUsed: true, fallbackReason: 'grok_auth_error' } }) });
  await routed.search({ query: QUERY });
  assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'ok', served: 'grok-sources',
    grokCode: 'grok_auth_error', fallbackUsed: true, failures: [] });
  const free = harness({ grok: async () => ({ sources: [{ url: 'https://g.test' }], diagnostic: { fallbackUsed: true, fallbackReason: 'upstream said: bad key sk-123' } }) });
  await free.routed.search({ query: QUERY });
  assert.equal(free.routed.routeSnapshot().grokCode, 'grok_provider_error');
});

test('内部回退采用结果携带的实际供应商，不读取配置顺序或额外搜索', async () => {
  for (const provider of ['tavily', 'exa', 'tinyfish', 'firecrawl']) {
    const { routed, calls } = harness({ grok: async () => ({
      content: 'degraded answer', sources: [{ url: 'https://example.test/evidence', provider: `${provider}_fallback` }],
      diagnostic: { fallbackUsed: true, fallbackReason: 'grok_sources_empty',
        searchProvider: 'source_fallback', sourceProvenance: {} },
    }) });
    try {
      await routed.search({ query: QUERY });
      const route = routed.routeSnapshot();
      assert.equal(route.served, provider);
      assert.deepEqual(route.resultProviders, [provider]);
      assert.equal(route.resultProvidersComplete, true);
      const row = routed.searchLog.snapshot(randomUUID()).records[0];
      assert.equal(row.served, provider);
      assert.deepEqual(row.resultProviders, [provider]);
      assert.deepEqual(row.calls.map(call => [call.provider, call.result]), [['grok', 'failed'], [provider, 'ok']]);
      assert.equal(row.calls[1].evidence, 'source-label');
      assert.equal(row.calls[1].keyIndex, null);
      assert.equal(row.calls[1].charge.basis, 'unknown');
      assert.equal(row.callsComplete, false);
      assert.equal(calls.grok, 1);
      assert.equal(calls.sources.length, 0);
    } finally { await routed.dispose(); }
  }
});

test('正常主搜的补充结果和混合回退均保留来源，不把补充结果当作主搜失败', async () => {
  for (const fallbackUsed of [false, true]) {
    const { routed } = harness({ grok: async () => ({
      content: 'answer', sources: [
        { url: 'https://example.test/primary', provider: 'grok_responses' },
        { url: 'https://example.test/secondary', provider: fallbackUsed ? 'exa_fallback' : 'exa_enrichment' },
      ], diagnostic: { fallbackUsed, fallbackReason: fallbackUsed ? 'grok_content_empty' : null, sourceProvenance: {} },
    }) });
    try {
      await routed.search({ query: QUERY });
      const route = routed.routeSnapshot();
      assert.equal(route.served, fallbackUsed ? 'exa' : 'grok');
      assert.deepEqual(route.resultProviders, ['grok', 'exa']);
      assert.equal(route.fallbackUsed, fallbackUsed);
      const row = routed.searchLog.snapshot(randomUUID()).records[0];
      assert.equal(row.calls[0].result, fallbackUsed ? 'failed' : 'ok');
      assert.equal(row.calls[1].provider, 'exa');
      assert.equal(row.calls[1].operation, 'supplement');
    } finally { await routed.dispose(); }
  }
});

test('来源被裁掉或未知时不猜供应商；已知来源与未报告可同时保留', async () => {
  for (const [sources, maxResults, expected, complete] of [
    [[{ url: 'https://example.test/a', provider: 'tavily_fallback' },
      { url: 'https://example.test/b', provider: 'exa_fallback' }], 1, ['tavily'], true],
    [[{ url: 'https://example.test/a', provider: 'tavily_fallback' },
      { url: 'https://example.test/b', provider: 'not-a-provider' }], 2, ['tavily'], false],
    [[{ url: 'https://exa.ai/not-provider-proof', provider: 'constructor' }], 1, [], false],
  ]) {
    const { routed, calls } = harness({ grok: async () => ({ sources, diagnostic: {
      fallbackUsed: true, fallbackReason: 'grok_sources_empty', sourceProvenance: {},
    } }) });
    try {
      await routed.search({ query: QUERY, maxResults });
      const route = routed.routeSnapshot();
      assert.deepEqual(route.resultProviders, expected);
      assert.equal(route.resultProvidersComplete, complete);
      assert.equal(route.served, expected.length === 1 ? expected[0] : 'grok-sources');
      assert.equal(calls.sources.length, 0);
    } finally { await routed.dispose(); }
  }
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

// The real source adapter behind the routed search: the shared fallback budget
// is enforced before any supplementary request, in both fallback modes.
function liveSources(config, { prefs = { grokEnabled: true }, grok }) {
  const requests = [];
  let grokCalls = 0;
  const sourceRouter = createSourceRouter({ getConfig: () => config,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ results: [{ url: 'https://result.test/live' }] }));
    } });
  const routed = createRoutedSearch({ grok: { search: async (...args) => { grokCalls++; return grok(...args); } },
    sourceRouter, preferences: { snapshot: () => ({ value: prefs }) }, releaseBarrier: createReleaseBarrier(),
    getConfig: () => config, now: () => 1_000 });
  return { routed, requests, grokCalls: () => grokCalls };
}
const onlyTavily = extra => ({ source_providers: ['tavily'], tavily_api_key: 'synthetic-tavily-key', ...extra });

test('an imported fallback_sources 0 sends no supplementary request and reports only the Grok failure', async () => {
  const primary = new GrokSearchError('grok_auth_error', 'Grok 认证失败，请检查 API Key 或登录凭据。');
  const { routed, requests } = liveSources(onlyTavily({ fallback_sources: 0 }), { grok: async () => { throw primary; } });
  try {
    await assert.rejects(routed.search({ query: QUERY, maxResults: 3 }), error => error === primary);
    assert.equal(requests.length, 0);
    assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'failed', served: null,
      grokCode: 'grok_auth_error', fallbackUsed: false, failures: [], code: 'grok_auth_error' });
    const row = routed.searchLog.snapshot(randomUUID()).records[0];
    assert.equal(row.kind, 'failed');
    assert.equal(row.reason, 'grok_auth_error');
    assert.deepEqual(row.calls.map(call => [call.provider, call.result]), [['grok', 'failed']]);
  } finally { await routed.dispose(); }
});

test('sources-only mode with fallback_sources 0 sends no request and names the zero budget', async () => {
  const { routed, requests, grokCalls } = liveSources(onlyTavily({ fallback_sources: 0 }), {
    prefs: { grokEnabled: false }, grok: async () => { throw new Error('must not run'); } });
  try {
    await assert.rejects(routed.search({ query: QUERY }), error => {
      assert.ok(error instanceof GrokSearchError);
      assert.equal(error.code, 'FALLBACK_SOURCES_ZERO');
      assert.match(error.message, /fallback_sources/);
      return true;
    });
    assert.equal(requests.length, 0);
    assert.equal(grokCalls(), 0);
    assert.deepEqual(routed.routeSnapshot(), { at: 1_000, origin: 'search', outcome: 'failed', served: null,
      grokCode: 'DISABLED', fallbackUsed: false, failures: [], code: 'FALLBACK_SOURCES_ZERO' });
    const row = routed.searchLog.snapshot(randomUUID()).records[0];
    assert.equal(row.kind, 'failed');
    assert.equal(row.reason, 'FALLBACK_SOURCES_ZERO');
    assert.deepEqual(row.calls, []);
  } finally { await routed.dispose(); }
});

test('zero fallback budget keeps non-plugin primary errors secret-free', async () => {
  const { routed, requests } = liveSources(onlyTavily({ fallback_sources: 0 }), {
    grok: async () => { throw new Error('synthetic-private-upstream-text'); } });
  try {
    await assert.rejects(routed.search({ query: QUERY }), error => {
      assert.ok(error instanceof GrokSearchError);
      assert.equal(error.code, 'GROK_SEARCH_FAILED');
      assert.equal(error.message, 'Grok 查询失败，请检查程序和配置。');
      assert.equal(JSON.stringify(error).includes('synthetic-private'), false);
      return true;
    });
    assert.equal(requests.length, 0);
    assert.equal(routed.routeSnapshot().code, 'GROK_SEARCH_FAILED');
  } finally { await routed.dispose(); }
});

test('a missing fallback_sources still requests five supplementary results in both fallback modes', async () => {
  for (const prefs of [{ grokEnabled: true }, { grokEnabled: false }]) {
    const { routed, requests } = liveSources(onlyTavily(), { prefs,
      grok: async () => { throw new GrokSearchError('grok_timeout', 'Grok 响应超时。'); } });
    try {
      const result = await routed.search({ query: QUERY, maxResults: 10 });
      assert.equal(result.sources[0].url, 'https://result.test/live');
      assert.equal(requests.length, 1);
      assert.equal(JSON.parse(requests[0].init.body).max_results, 5);
      assert.equal(routed.routeSnapshot().served, 'tavily');
      assert.equal(routed.routeSnapshot().fallbackUsed, true);
    } finally { await routed.dispose(); }
  }
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
  const { routed } = harness({ grok: async () => ({ sources: [{ url: 'https://g.test' }] }) });
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

test('an unreaped Grok process is never hidden by supplementary fallback', async () => {
  let confirmExit;
  const whenExited = new Promise(resolve => { confirmExit = resolve; });
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', '本次进程尚未确认退出。');
  Object.defineProperty(failure, 'whenExited', { value: whenExited });
  const { routed, calls } = harness({ grok: async () => { throw failure; },
    sources: { search: async () => sourceResult('exa') } });
  try {
    await assert.rejects(routed.search({ query: QUERY }), error => error === failure);
    assert.equal(calls.sources.length, 0);
    assert.equal(routed.snapshot().accepting, false);
    await assert.rejects(routed.search({ query: 'later' }), { code: 'GROK_PROCESS_REAP_FAILED' });
    assert.equal(calls.grok, 1, 'faulted slot must block dispatching another process');
    assert.equal(routed.routeSnapshot().grokCode, 'GROK_PROCESS_REAP_FAILED');
  } finally {
    confirmExit();
    await new Promise(resolve => setImmediate(resolve));
    await routed.dispose();
  }
});

test('caller cancellation cannot hide an unreaped process or release its faulted slot', async () => {
  const controller = new AbortController();
  const cancellation = new Error('调用方取消');
  let confirmExit;
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', '取消后进程尚未确认退出。');
  Object.defineProperty(failure, 'whenExited', { value: new Promise(resolve => { confirmExit = resolve; }) });
  const { routed, calls } = harness({ grok: async () => {
    controller.abort(cancellation); throw failure;
  }, sources: { search: async () => sourceResult('exa') } });
  try {
    await assert.rejects(routed.search({ query: QUERY }, controller.signal), error => error === failure);
    assert.equal(routed.snapshot().accepting, false);
    assert.equal(routed.snapshot().faulted, 1);
    assert.equal(calls.sources.length, 0);
  } finally {
    confirmExit();
    await new Promise(resolve => setImmediate(resolve));
    await routed.dispose();
  }
});
