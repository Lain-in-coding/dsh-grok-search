import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

// Run with an official Electron runtime in Node mode and an extracted candidate.
// Real host tools, policies and WebRuntime; only provider responses are synthetic.
const [archive, productPath] = process.argv.slice(2);
if (!archive || !productPath) throw new Error('Provide an official app.asar and extracted candidate package directory.');
const product = resolve(productPath), hostRoot = join(archive, 'dsh/node_modules/@deepseek-ai');
const version = JSON.parse(readFileSync(join(archive, 'package.json'), 'utf8')).version;
const candidate = JSON.parse(readFileSync(join(product, 'package.json'), 'utf8')).version;
const upstream = name => import(pathToFileURL(join(hostRoot, name, 'lib/index.js')).href);
const core = name => import(pathToFileURL(join(product, 'src/core', name + '.mjs')).href);
const { Context } = await upstream('cordis');
const toolsModule = await upstream('dsh-tools'), webModule = await upstream('dsh-web');
const webTools = await upstream('dsh-tool-web'), { WebError } = webModule;
const modern = existsSync(join(hostRoot, 'dsh-tool-executor-native/package.json'));
const executorModule = modern ? await upstream('dsh-tool-executor-native') : null;
const { createRoutedSearch } = await core('routed-search');
const { createSourceRouter } = await core('source-adapters');
const { createReleaseBarrier } = await core('release-transaction');
const { createSearchLog } = await core('search-log');
const { createToolRouteContext } = await core('tool-route-context');
const { GrokSearchError } = await core('errors');
const newerDefaults = /^0\.2\.2-rc\.(\d+)$/.exec(version)?.[1] >= 2;
const tick = () => new Promise(done => setImmediate(done));
const deferred = () => {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
};
async function until(check, label) {
  const deadline = performance.now() + 5000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('Fixture did not reach ' + label);
    await tick();
  }
}
async function waitFor(gate, signal, holdCleanup = false) {
  if (holdCleanup) { await gate.promise; signal.throwIfAborted(); return; }
  let abort;
  try {
    await Promise.race([gate.promise, new Promise((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function harness({ mode = 'grok', searchMaxQueries, budgetMs = 120_000, cleanupMs = 2000, work } = {}) {
  const app = new Context(), log = createSearchLog(), routes = createToolRouteContext({ searchLog: log });
  const calls = { grok: 0, tavily: 0, original: 0 }, dispatches = [], identities = new WeakMap();
  const config = { tavily_api_url: 'https://synthetic.invalid', tavily_api_key: 'synthetic-key',
    tavily_enabled: true, source_providers: ['tavily'], response_max_chars: 45_000 };
  const preferences = { snapshot: () => ({ value: { grokEnabled: mode !== 'sources' } }) };
  let active = 0, maxActive = 0, routed;
  const upstreamCall = async (provider, query, signal) => {
    calls[provider]++;
    dispatches.push({ provider, query });
    active++; maxActive = Math.max(maxActive, active);
    try {
      signal.throwIfAborted();
      if (work) await work({ provider, query, signal, calls }); else await tick();
      signal.throwIfAborted();
      if (mode === 'failed') throw new GrokSearchError('SYNTHETIC_UPSTREAM_FAILED', 'Synthetic provider failure.');
      return [{ url: 'https://synthetic.invalid/result/' + encodeURIComponent(query), title: 'Synthetic result', content: 'Synthetic excerpt' }];
    } finally { active--; }
  };
  const sourceRouter = createSourceRouter({ getConfig: () => config, budgetMs, cleanupMs,
    fetchImpl: async (_url, request) => {
      try {
        const results = await upstreamCall('tavily', JSON.parse(request.body).query, request.signal);
        return new Response(JSON.stringify({ results, usage: { credits: 1 } }),
          { headers: { 'content-type': 'application/json' } });
      } catch (failure) {
        if (request.signal.aborted) throw request.signal.reason;
        return new Response('{}', { status: 503 });
      }
    },
  });
  routed = createRoutedSearch({ getConfig: () => config, preferences, sourceRouter, searchLog: log,
    releaseBarrier: createReleaseBarrier(), budgetMs, cleanupMs,
    grok: { search: async (request, signal) => ({ content: 'Synthetic answer',
      sources: await upstreamCall('grok', request.query, signal) }) },
  });
  const close = async () => {
    await routed.dispose();
    routes.dispose(); log.dispose();
    for (const runtime of [...app.registry.values()]) for (const fiber of [...runtime.fibers]) await fiber.dispose();
  };
  try {
    app.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1; } });
    await app.plugin(toolsModule.default);
    if (modern) await app.plugin(executorModule);
    await app.plugin(webModule.default, { searchProvider: 'grok-search' });
    app.web.registerSearchProvider({ id: 'candidate-original', available: () => true,
      async search() { calls.original++; return { sources: [], truncated: false }; } });
    app.web.registerSearchProvider({ id: 'grok-search', available: () => true,
      async search(request, signal) {
        try { return await routed.search(request, signal, 'search', routes.capture()); }
        catch (failure) {
          if (signal?.aborted && failure === signal.reason) throw failure;
          if (failure instanceof GrokSearchError) throw new WebError(failure.message, failure.code);
          throw failure;
        }
      } });
    app.on('tools/execute', (exec, next) => routes.run(exec, next), { global: true, prepend: true });
    app.on('tools/result', (exec, result) => routes.finalize(exec, result), { global: true });
    const owner = app.plugin(webTools, { search: true, fetch: false,
      ...(searchMaxQueries === undefined ? {} : { searchMaxQueries }) });
    await owner;
    const effective = owner.effectiveConfig ?? owner.config;
    const agent = { session: { id: randomUUID() }, ctx: app };
    const invoke = async (queries, { target = agent, signal = new AbortController().signal } = {}) => {
      const callId = randomUUID(), args = { queries };
      let result;
      if (!modern) result = await app.tools.execute({ name: 'web_search', arguments: args, agent: target, callId, signal });
      else {
        const toolSet = await app.tools.resolve({ agent: target, modelSelection: { provider: 'fixture' }, signal });
        try {
          const batch = await app.tools.execute({ agent: target, signal, toolSet,
            calls: [{ type: 'tool_call', id: callId, name: 'web_search', arguments: JSON.stringify(args) }] });
          result = batch.results[0].result;
        } finally { toolSet.dispose(); }
      }
      identities.set(result, { sessionId: target.session.id, callId });
      return result;
    };
    const rowFor = result => {
      const identity = identities.get(result);
      return log.snapshot(randomUUID()).records.find(row => row.sessionId === identity.sessionId && row.callId === identity.callId);
    };
    const traceFor = result => {
      const identity = identities.get(result);
      return routes.readTrace(identity.sessionId, identity.callId);
    };
    return { app, agent, log, routed, routes, calls, dispatches, invoke, rowFor, traceFor, close,
      maxQueries: effective.searchMaxQueries, maximum: () => maxActive };
  } catch (failure) { await close(); throw failure; }
}

const passed = [];
async function scenario(name, options, verify) {
  const h = await harness(options);
  try {
    await verify(h);
    assert.equal(h.calls.original, 0, 'original provider is never used');
    assert.ok(h.maximum() <= 1, 'the plugin dispatches at most one upstream request');
    assert.equal(h.routed.snapshot().running, 0);
    assert.equal(h.routed.snapshot().queued, 0);
    passed.push(name);
  } finally { await h.close(); }
}
let defaultMaxQueries;
await scenario('host-default-query-limit', {}, async h => {
  defaultMaxQueries = h.maxQueries;
  assert.equal(defaultMaxQueries, newerDefaults ? 10 : 4);
  const before = h.calls.grok + h.calls.tavily;
  const result = await h.invoke(Array.from({ length: defaultMaxQueries + 1 }, (_, i) => 'excess-' + i));
  assert.equal(result.isError, true);
  assert.equal(h.calls.grok + h.calls.tavily, before);
});
const batchOptions = newerDefaults ? {} : { searchMaxQueries: 10 };
for (const mode of ['grok', 'sources']) {
  await scenario(mode + '-batches-1-4-10-and-deduplication', { ...batchOptions, mode }, async h => {
    for (const count of [1, 4, 10]) {
      const queries = Array.from({ length: count }, (_, i) => `${mode}-${count}-${i}`);
      const before = h.calls[mode === 'grok' ? 'grok' : 'tavily'];
      const result = await h.invoke(queries);
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(h.calls[mode === 'grok' ? 'grok' : 'tavily'] - before, count);
      assert.deepEqual(h.rowFor(result).queries.map(row => row.q), queries);
      assert.equal(h.rowFor(result).kind, mode === 'grok' ? 'ok' : 'sources');
      assert.equal(h.traceFor(result).routes.length, count);
    }
    const before = h.calls[mode === 'grok' ? 'grok' : 'tavily'];
    const deduped = await h.invoke(Array.from({ length: 10 }, () => 'same-query'));
    assert.equal(deduped.isError, false);
    assert.equal(h.calls[mode === 'grok' ? 'grok' : 'tavily'] - before, 1);
    assert.equal(h.rowFor(deduped).queries.length, 1);
  });
}
await scenario('explicit-lower-query-limit', { searchMaxQueries: 2 }, async h => {
  assert.equal(h.maxQueries, 2);
  assert.equal((await h.invoke(['one', 'two', 'three'])).isError, true);
  assert.equal(h.calls.grok, 0);
});
await scenario('different-sessions-keep-independent-call-logs', batchOptions, async h => {
  const other = { session: { id: randomUUID() }, ctx: h.app };
  const results = await Promise.all([h.invoke(['same-query']), h.invoke(['same-query'], { target: other })]);
  assert.equal(results.every(result => !result.isError), true);
  assert.equal(h.rowFor(results[0]).sessionId, h.agent.session.id);
  assert.equal(h.rowFor(results[1]).sessionId, other.session.id);
  assert.notEqual(h.rowFor(results[0]).id, h.rowFor(results[1]).id);
});
const occupied = deferred();
await scenario('ten-query-batch-alongside-existing-work', { ...batchOptions, work: ({ signal }) => waitFor(occupied, signal) }, async h => {
  const first = h.invoke(['existing-work']);
  await until(() => h.calls.grok === 1, 'existing work');
  const batch = h.invoke(Array.from({ length: 10 }, (_, i) => 'queued-batch-' + i));
  try { await until(() => h.routed.snapshot().queued === 10, 'ten queued queries'); }
  finally { occupied.resolve(); }
  const outcomes = await Promise.all([first, batch]);
  assert.equal(outcomes.every(result => !result.isError), true);
  assert.equal(h.calls.grok, 11);
  assert.equal(h.rowFor(outcomes[1]).queries.length, 10);
});
const cancelGate = deferred();
await scenario('queued-cancellation-does-not-dispatch', { ...batchOptions, work: ({ signal }) => waitFor(cancelGate, signal) }, async h => {
  const first = h.invoke(['held-work']), controller = new AbortController();
  await until(() => h.calls.grok === 1, 'held work');
  const queued = h.invoke(['cancelled-queue'], { signal: controller.signal });
  try {
    await until(() => h.routed.snapshot().queued === 1, 'queued cancellation');
    controller.abort(new WebError('Synthetic caller cancellation.', 'ABORTED'));
    const result = await queued;
    assert.equal(result.isError, true);
    assert.equal(h.calls.grok, 1);
    assert.equal(h.rowFor(result).kind, 'cancelled');
  } finally { cancelGate.resolve(); await first; }
});
const deadlineGate = deferred();
await scenario('queued-deadline-does-not-dispatch', { ...batchOptions, budgetMs: 180, cleanupMs: 10,
  work: ({ signal }) => waitFor(deadlineGate, signal, true) }, async h => {
  const first = h.invoke(['held-cleanup']);
  await until(() => h.calls.grok === 1, 'deadline work');
  try {
    const result = await h.invoke(['expired-queue']);
    assert.equal(result.isError, true);
    assert.equal(h.calls.grok, 1);
    assert.equal(h.rowFor(result).reason, 'GROK_QUEUE_TIMEOUT');
    assert.equal(h.rowFor(result).kind, 'failed');
  } finally { deadlineGate.resolve(); await first; }
});
const fullGate = deferred();
await scenario('bounded-queue-rejects-without-dispatch', { ...batchOptions, work: ({ signal }) => waitFor(fullGate, signal) }, async h => {
  const first = h.invoke(['queue-owner']);
  await until(() => h.calls.grok === 1, 'queue owner');
  const queued = Array.from({ length: 16 }, (_, i) => h.invoke(['queued-' + i]));
  try {
    await until(() => h.routed.snapshot().queued === 16, 'full queue');
    const result = await h.invoke(['queue-overflow']);
    assert.equal(result.isError, true);
    assert.equal(h.rowFor(result).reason, 'GROK_QUEUE_FULL');
    assert.equal(h.calls.grok, 1);
  } finally { fullGate.resolve(); await Promise.all([first, ...queued]); }
});
await scenario('all-providers-failed-without-official-fallback', { ...batchOptions, mode: 'failed' }, async h => {
  const result = await h.invoke(['all-failed']);
  assert.equal(result.isError, true);
  assert.equal(h.calls.grok, 1);
  assert.equal(h.calls.tavily, 1);
  assert.equal(h.rowFor(result).kind, 'failed');
  assert.equal(h.rowFor(result).reason, 'SOURCE_ALL_FAILED');
});
await scenario('post-policy-failure-overrides-whole-call-log', batchOptions, async h => {
  const remove = h.app.on('tools/post-execute', async (exec, _result, next) => exec.name === 'web_search'
    ? { kind: 'block', feedback: [{ type: 'text', text: 'Synthetic post-policy denial.' }],
      ...(newerDefaults ? { info: { name: 'PermissionError', code: 'PERMISSION_DENIED' } } : {}) } : next());
  try {
    const result = await h.invoke(['retrieved-before-denial']);
    assert.equal(result.isError, true);
    assert.equal(h.rowFor(result).kind, 'failed');
    assert.equal(h.rowFor(result).queries[0].kind, 'ok');
    assert.equal(h.traceFor(result).state, 'failed');
    assert.equal(h.traceFor(result).routes[0].outcome, 'ok');
    if (newerDefaults) assert.equal(h.rowFor(result).reason, 'PERMISSION_DENIED');
  } finally { remove(); }
});
const files = ['routed-search', 'search-executor', 'source-adapters', 'search-log', 'tool-route-context'];
console.log(JSON.stringify({ passed: true, version, candidate, modern, defaultMaxQueries,
  tenQueryFixture: newerDefaults ? 'host-default' : 'explicit-searchMaxQueries-10',
  cases: passed, originalProviderCalls: 0, maximumUpstreamConcurrency: 1, syntheticOnly: true,
  sourceHashes: files.map(name => ({ file: `src/core/${name}.mjs`,
    sha256: createHash('sha256').update(readFileSync(join(product, 'src/core', name + '.mjs'))).digest('hex') })) }));
