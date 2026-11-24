import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { GrokSearchError, cleanupFailure } from '../src/core/errors.mjs';
import { decodeGrokResult, mapSearchResult } from '../src/core/result-map.mjs';
import { createSearchExecutor } from '../src/core/search-executor.mjs';
import { createGrokProvider } from '../src/provider.mjs';
import { apply as applySearch } from '../src/index.mjs';
import { mkdtempTracked } from './helpers/temp-fixture.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const answer = { content: '已完成', sources: [], truncated: false };
const tick = () => new Promise(resolve => setImmediate(resolve));

const rejectedCleanup = reason => ({ status: 'rejected', reason });
const exitFailure = (code, proof) => {
  const error = new GrokSearchError(code, 'Synthetic cleanup failure.');
  if (proof) Object.defineProperty(error, 'whenExited', { value: proof });
  return error;
};

// Evaluate the actual exported boundaries with synthetic resource owners.
// This avoids adding test-only injection APIs or starting any child process.
function cleanupBoundary(entry, failures) {
  const calls = [];
  const resource = index => ({ dispose: async () => { calls.push(index); throw failures[index]; } });
  const globals = { GrokSearchError, cleanupFailure, Error };
  if (entry === 'provider') {
    const create = vm.runInNewContext(`(${createGrokProvider.toString()})`, {
      ...globals, PROVIDER_ID: 'grok-search',
      createSearchExecutor: () => resource(0), createManagedMcpSearch: () => resource(1),
    });
    return { calls, dispose: create({ configuration: {} }).dispose };
  }
  const services = new Map();
  const apply = vm.runInNewContext(`(${applySearch.toString()})`, {
    ...globals, createGrokProvider: () => ({ ...resource(1), provider: {}, snapshot: () => ({ executableReady: true }) }),
    createRoutedSearch: () => resource(0), createSourceRouter: () => ({}), createReleaseBarrier: () => ({}),
  });
  apply({ get: key => services.get(key), provide: (key, value) => services.set(key, value),
    effect() {}, web: { registerSearchProvider() {} } }, {}, { WebError: Error });
  return { calls, dispose: services.get('grokSearchCore').dispose };
}

test('cleanup aggregation preserves single failure identity and hides aggregate-only diagnostics', async () => {
  assert.equal(cleanupFailure([]), null);
  assert.equal(cleanupFailure([{ status: 'fulfilled', value: undefined }]), null);
  const proof = Promise.resolve();
  const first = exitFailure('GROK_PROCESS_REAP_FAILED', proof);
  first.details = { retriable: true, privateFixture: 'not-public' };
  Object.defineProperty(first, 'diagnostic', { value: { exited: false } });
  first.retriable = true;
  Object.freeze(first);
  assert.equal(cleanupFailure([{ status: 'fulfilled' }, rejectedCleanup(first)]), first);
  const second = new Error('private-secondary-failure');
  const combined = cleanupFailure([rejectedCleanup(first), rejectedCleanup(second)]);
  assert.ok(combined instanceof GrokSearchError);
  assert.equal(combined.code, first.code);
  assert.equal(combined.message, first.message);
  assert.equal(combined.name, first.name);
  assert.equal(combined.details, first.details);
  assert.equal(combined.diagnostic, first.diagnostic);
  assert.equal(combined.retriable, true);
  assert.deepEqual(combined.errors, [first, second]);
  assert.equal(combined.cause, first);
  assert.equal(Object.hasOwn(combined, 'whenExited'), false);
  assert.equal(first.whenExited, proof, 'aggregation must not mutate the original error');
  assert.doesNotMatch(JSON.stringify(combined), /details|diagnostic|private|errors|cause|whenExited/);
  const ordinary = Object.assign(new TypeError('first ordinary failure'), { code: 'SYNTHETIC_CLEANUP' });
  const wrapped = cleanupFailure([rejectedCleanup(ordinary), rejectedCleanup(second)]);
  assert.equal(wrapped instanceof GrokSearchError, false);
  assert.equal(wrapped.name, ordinary.name);
  assert.equal(wrapped.message, ordinary.message);
  assert.equal(wrapped.code, ordinary.code);
  for (const reason of [undefined, null, 'private-non-error']) {
    const unknown = cleanupFailure([rejectedCleanup(reason)]);
    assert.ok(unknown instanceof Error);
    assert.equal(Object.hasOwn(unknown, 'whenExited'), false);
    assert.doesNotMatch(JSON.stringify(unknown), /private-non-error/);
  }
});

for (const entry of ['provider', 'index']) {
  for (const firstExit of [0, 1]) test(`${entry} disposal waits for both independent proofs (${firstExit} exits first)`, async () => {
    const exits = [deferred(), deferred()];
    const failures = exits.map((exit, index) => exitFailure(index ? 'GROK_PROGRAM_REAP_FAILED' : 'GROK_PROCESS_REAP_FAILED', exit.promise));
    const boundary = cleanupBoundary(entry, failures);
    let failure, complete = false;
    try {
      await assert.rejects(boundary.dispose(), error => { failure = error; return error.code === failures[0].code; });
      assert.deepEqual(boundary.calls, [0, 1]);
      assert.equal(typeof failure.whenExited?.then, 'function');
      const observed = failure.whenExited.then(() => { complete = true; });
      exits[firstExit].resolve();
      await tick();
      assert.equal(complete, false, 'one process exit must not release the other resource');
      exits[1 - firstExit].resolve();
      await observed;
      assert.equal(complete, true);
      assert.equal(Object.getOwnPropertyDescriptor(failure, 'whenExited').enumerable, false);
      assert.notEqual(failure, failures[0], 'do not replace a resource proof in the original error');
    } finally { for (const exit of exits) exit.resolve(); }
  });

  test(`${entry} disposal does not publish a partial proof when another failure has no proof`, async () => {
    for (const missing of [0, 1]) {
      const exit = deferred();
      const failures = [0, 1].map(index => exitFailure(index ? 'GROK_PROGRAM_REAP_FAILED' : 'GROK_PROCESS_REAP_FAILED',
        index === missing ? null : exit.promise));
      const boundary = cleanupBoundary(entry, failures);
      let failure;
      await assert.rejects(boundary.dispose(), error => { failure = error; return error.code === failures[0].code; });
      exit.resolve();
      await tick();
      assert.equal(Object.hasOwn(failure, 'whenExited'), false);
      assert.equal(failure.errors.length, failures.length);
      for (const [index, original] of failures.entries()) assert.equal(failure.errors[index], original);
      assert.deepEqual(boundary.calls, [0, 1]);
    }
  });

  test(`${entry} disposal never succeeds when an independent exit proof rejects`, async () => {
    for (const rejected of [0, 1]) {
      const exits = [deferred(), deferred()], denied = new Error('Synthetic exit observation failed.');
      for (const exit of exits) exit.promise.catch(() => {});
      const boundary = cleanupBoundary(entry, exits.map(exit => exitFailure('GROK_PROCESS_REAP_FAILED', exit.promise)));
      let failure;
      await assert.rejects(boundary.dispose(), error => { failure = error; return true; });
      const outcome = failure.whenExited.then(() => ({ complete: true }), error => ({ complete: false, error }));
      exits[1 - rejected].resolve();
      exits[rejected].reject(denied);
      assert.deepEqual(await outcome, { complete: false, error: denied });
    }
  });
}

test('nested cleanup aggregation retains all proofs and observes a rejected aggregate immediately', async () => {
  const exits = [deferred(), deferred(), deferred()];
  const failures = exits.map(exit => exitFailure('GROK_PROCESS_REAP_FAILED', exit.promise));
  const inner = cleanupFailure(failures.slice(0, 2).map(rejectedCleanup));
  const outer = cleanupFailure([rejectedCleanup(inner), rejectedCleanup(failures[2])]);
  let completed = false;
  const observed = outer.whenExited.then(() => { completed = true; });
  exits[0].resolve(); exits[2].resolve();
  await tick();
  assert.equal(completed, false);
  exits[1].resolve();
  await observed;
  assert.equal(completed, true);
  const rejected = deferred(), denial = new Error('Synthetic observer rejection.');
  const blocked = cleanupFailure([rejectedCleanup(exitFailure('GROK_PROCESS_REAP_FAILED', rejected.promise)),
    rejectedCleanup(exitFailure('GROK_PROCESS_REAP_FAILED', Promise.resolve()))]);
  rejected.reject(denial);
  await tick();
  await assert.rejects(blocked.whenExited, error => error === denial);
});

function registeredSearch(t, { ready = false, grokEnabled = true, sources = true, fallback = 5 } = {}) {
  const directory = mkdtempTracked(join(tmpdir(), 'dsh-search-slice-'));
  const configPath = join(directory, 'config.toml');
  const save = (enabled, count) => writeFileSync(configPath, [
    'source_providers = ["tavily"]', `tavily_enabled = ${enabled}`, 'tavily_api_key = "offline-fixture"',
    'tavily_api_url = "https://source.invalid"', `fallback_sources = ${count}`,
  ].join('\n'));
  save(sources, fallback);
  const prefs = { grokEnabled }, services = new Map(), calls = [];
  let provider;
  const execution = { executable: process.execPath,
    executableArgs: [fileURLToPath(new URL('../fixtures/mcp/grok-server.mjs', import.meta.url)), 'structured'], configPath };
  services.set('grokSearchPreferences', { snapshot: () => ({ value: prefs }) });
  services.set('grokSearchProgram', { snapshot: () => ({ phase: ready ? 'ready' : 'missing', configPath }),
    execution: () => ready ? execution : { ...execution, executable: '' } });
  const ctx = { get: name => services.get(name), provide: (name, value) => services.set(name, value), effect() {},
    web: { registerSearchProvider: value => { provider = value; } }, logger: { warn() {} } };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://source.invalid/search');
    calls.push({ url, init });
    return new Response(JSON.stringify({ results: [{ url: 'https://result.invalid/one', title: 'offline' }] }));
  });
  applySearch(ctx, {}, { WebError: class extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }, assertExecution: () => {}, executionEpoch: () => 1 });
  return { provider, prefs, calls, save, core: services.get('grokSearchCore') };
}

test('registered search discovery follows disabled primary and the actual source fallback budget', async t => {
  const f = registeredSearch(t, { ready: true, grokEnabled: false, sources: false });
  try {
    assert.equal(f.provider.available(), false, 'a disabled primary cannot advertise a missing source route');
    await assert.rejects(f.provider.search({ query: 'offline' }), { code: 'SOURCE_NOT_CONFIGURED' });
    f.save(true, 0);
    assert.equal(f.provider.available(), false, 'configured keys cannot override a zero fallback budget');
    await assert.rejects(f.provider.search({ query: 'offline' }), { code: 'FALLBACK_SOURCES_ZERO' });
    assert.equal(f.calls.length, 0);
    f.save(true, 5);
    assert.equal(f.provider.available(), true);
    assert.equal((await f.provider.search({ query: 'offline' })).sources.length, 1);
    assert.equal(f.calls.length, 1);
  } finally { await f.core.dispose(); }
});

test('registered search supports source-only use while the primary executable is missing', async t => {
  const f = registeredSearch(t);
  try {
    assert.equal(f.provider.available(), true);
    assert.equal((await f.provider.search({ query: 'offline' })).sources.length, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.core.snapshot().session.connected, false);
  } finally { await f.core.dispose(); }
});

async function checkIdleFault(t, code) {
  const { Client } = await import('@modelcontextprotocol/client');
  const connect = Client.prototype.connect;
  let transport;
  t.mock.method(Client.prototype, 'connect', function (owned, ...args) {
    transport = owned;
    return connect.call(this, owned, ...args);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = registeredSearch(t, { ready: true });
  let close, fault;
  try {
    assert.equal((await f.provider.search({ query: 'offline' })).sources.length > 0, true);
    close = transport.close.bind(transport);
    fault = new GrokSearchError(code, 'offline idle cleanup failed');
    if (code === 'GROK_PROCESS_REAP_FAILED') Object.defineProperty(fault, 'whenExited', { value: transport.whenExited });
    transport.close = async () => { throw fault; };
    t.mock.timers.tick(300_000);
    await tick();
    assert.equal(f.core.snapshot().session.faulted, true);
    assert.equal(f.core.snapshot().routeExecutor.accepting, true, 'idle fault is outside the outer executor');
    const unreaped = code === 'GROK_PROCESS_REAP_FAILED';
    assert.equal(f.provider.available(), !unreaped, 'only unresolved process exit forbids fallback');
    f.prefs.grokEnabled = false;
    assert.equal(f.provider.available(), true, 'explicit source-only routing does not enter the blocked primary');
    assert.equal((await f.provider.search({ query: 'source only' })).sources.length, 1);
    assert.equal(f.calls.length, 1);
    f.prefs.grokEnabled = true;
    if (unreaped) {
      await assert.rejects(f.provider.search({ query: 'blocked primary' }), { code });
      assert.equal(f.calls.length, 1);
      await close();
      await tick();
      assert.equal(f.provider.available(), true, 'the observed exit reopens the primary route');
    } else {
      assert.equal((await f.provider.search({ query: 'ordinary fallback' })).sources.length, 1);
      assert.equal(f.calls.length, 2);
    }
  } finally {
    t.mock.timers.reset();
    if (close) { transport.close = close; await close(); await tick(); }
    await f.core.dispose().catch(error => { if (error !== fault) throw error; });
  }
}
for (const code of ['GROK_PROCESS_REAP_FAILED', 'GROK_CLOSE_ERROR']) {
  test(`registered discovery and dispatch agree after MCP idle ${code}`, t => checkIdleFault(t, code));
}

test('来源保留顺序、过滤协议和 userinfo、去重并遵守 maxResults', () => {
  const payload = { content: '摘要', sources: [
    { url: 'https://example.invalid/a', title: null, description: '片段', published_date: '2026-10-18' },
    { url: 'https://example.invalid/a' }, { url: 'file:///private' },
    { url: 'https://user:password@example.invalid/secret' },
    { url: 'https://example.invalid/b', title: '第二条' }, { url: 'https://example.invalid/c' },
  ] };
  const result = mapSearchResult(payload, { maxResults: 2 });
  assert.deepEqual(result.sources, [
    { url: 'https://example.invalid/a', snippet: '片段', publishedAt: '2026-10-18' },
    { url: 'https://example.invalid/b', title: '第二条' },
  ]);
  assert.equal(result.content, '摘要');
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('password'));
});

test('序列化字符预算覆盖转义和 Unicode，不截出半个代理对或伪造日期', () => {
  const result = mapSearchResult({ content: '\\"🙂'.repeat(20_000), sources: [
    { url: 'https://example.invalid/a', snippet: '说明'.repeat(300), published_date: '2026-10-18' },
  ] }, { maxChars: 500 });
  assert.ok(JSON.stringify(result).length <= 500);
  assert.equal(result.truncated, true);
  assert.ok(!/[\uD800-\uDBFF]$/.test(result.content));
  assert.ok(result.sources[0].publishedAt === undefined || result.sources[0].publishedAt === '2026-10-18');
  const empty = mapSearchResult({ sources: [] });
  assert.deepEqual(empty, { content: '', sources: [], truncated: false });
});

test('精确预算边界用实际 truncated 标志，完整与截断结果都不超限', () => {
  const base = JSON.stringify({ content: '', sources: [], truncated: false }).length;
  for (const size of [100, 45_000]) {
    const exact = mapSearchResult({ content: '中'.repeat(size - base), sources: [] }, { maxChars: size });
    assert.equal(JSON.stringify(exact).length, size);
    assert.equal(exact.truncated, false);
    const edge = mapSearchResult({ content: '中'.repeat(size - base + 1), sources: [] }, { maxChars: size });
    assert.ok(JSON.stringify(edge).length <= size);
    assert.equal(edge.truncated, true);
  }
});

test('结构化和单个 JSON 文本响应均可解码，错误不得伪装成无命中', () => {
  const payload = { content: '内容', sources: [], truncated: false };
  assert.deepEqual(decodeGrokResult({ structuredContent: payload }), payload);
  assert.deepEqual(decodeGrokResult({ content: [{ type: 'text', text: JSON.stringify(payload) }] }), payload);
  for (const response of [
    { isError: true, content: [{ type: 'text', text: 'api_key=secret' }] },
    { structuredContent: { sources: [], error: 'secret' } },
    { structuredContent: { sources: 'bad' } },
    { structuredContent: { sources: [], truncated: 'false' } },
    { structuredContent: { sources: [], sources_count: -1 } },
    { content: [{ type: 'text', text: 'not-json' }] },
  ]) assert.throws(() => decodeGrokResult(response), error => error instanceof GrokSearchError && !error.message.includes('secret'));
  assert.throws(() => mapSearchResult({ sources: [{ title: '无 URL' }] }), error => error.code === 'GROK_INVALID_RESULT');
});

test('来源标签随保留下来的结果跨预算映射，但不进入模型输出', () => {
  const input = { content: 'ok', sources: [
    { url: 'https://example.invalid/a', provider: 'tavily_fallback' },
    { url: 'https://example.invalid/a', provider: 'exa_fallback' },
    { url: 'file:///not-a-result', provider: 'firecrawl_fallback' },
    { url: 'https://user:secret@example.invalid/private', provider: 'tinyfish_fallback' },
    { url: 'https://example.invalid/b', provider: 'exa_enrichment' },
    { url: 'https://example.invalid/c', provider: 'grok_responses' },
    { url: 'https://example.invalid/d', provider: 'tavily_fallback_extra' },
    { url: 'https://example.invalid/e', provider: 'constructor' },
    { url: 'https://example.invalid/f', provider: { key: 'private' } },
  ] };
  const first = mapSearchResult(input);
  const second = mapSearchResult(first, { maxResults: 2 });
  assert.deepEqual(second.sources.map(source => source.provider), ['tavily_fallback', 'exa_enrichment']);
  assert.equal(first.sources[2].provider, 'grok_responses');
  assert.ok(first.sources.slice(3).every(source => source.provider === undefined));
  assert.deepEqual(Object.keys(second.sources[0]), ['url']);
  assert.doesNotMatch(JSON.stringify(second), /provider|fallback|enrichment|secret|private/);
  assert.equal(mapSearchResult({ sources: [{ url: 'https://example.test/compat', provider: 'openai_compatible' }] })
    .sources[0].provider, 'openai_compatible');
});

test('默认一个运行、八个排队，超出容量明确失败', async () => {
  const gate = deferred(); let calls = 0, peak = 0, active = 0;
  const executor = createSearchExecutor({ snapshot: () => ({}), runQuery: async () => {
    calls++; active++; peak = Math.max(peak, active); await gate.promise; active--; return answer;
  } });
  const requests = Array.from({ length: 9 }, (_, index) => executor.search({ query: String(index) }));
  await tick();
  assert.equal(calls, 1);
  assert.equal(executor.snapshot().queued, 8);
  await assert.rejects(executor.search({ query: '超过容量' }), error => error.code === 'GROK_QUEUE_FULL');
  gate.resolve(); await Promise.all(requests);
  assert.equal(calls, 9); assert.equal(peak, 1);
  assert.equal(executor.snapshot().running, 0);
  await executor.dispose();
});

test('排队取消保留调用方原因，未派发查询不启动程序', async () => {
  const gate = deferred(); let calls = 0;
  const executor = createSearchExecutor({ maxRunning: 1, snapshot: () => ({}), runQuery: async () => { calls++; await gate.promise; return answer; } });
  const first = executor.search({ query: '运行' });
  const controller = new AbortController(), reason = new Error('用户取消');
  const second = executor.search({ query: '等待' }, controller.signal);
  const rejection = assert.rejects(second, error => error === reason);
  controller.abort(reason); await rejection;
  assert.equal(calls, 1); assert.equal(executor.snapshot().queued, 0);
  gate.resolve(); await first; await executor.dispose();
});

test('排队时间占用工作预算，过期查询不会派发', async () => {
  let calls = 0;
  const executor = createSearchExecutor({ maxRunning: 1, budgetMs: 90, cleanupMs: 20, snapshot: () => ({}), runQuery: async ({ signal }) => {
    calls++; await new Promise((_, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 40), { once: true }));
  } });
  const first = executor.search({ query: '运行' });
  const firstRejected = assert.rejects(first, error => error.code === 'GROK_TIMEOUT');
  const second = executor.search({ query: '等待' });
  await assert.rejects(second, error => error.code === 'GROK_QUEUE_TIMEOUT');
  await firstRejected;
  assert.equal(calls, 1); await executor.dispose();
});

test('派发时读取当前配置，运行中的参数不被后续修改', async () => {
  const gate = deferred(); let revision = '一', sharedArgs = ['旧参数']; const snapshots = [];
  const executor = createSearchExecutor({ maxRunning: 1, snapshot: () => ({ revision, executableArgs: sharedArgs }), runQuery: async snapshot => {
    snapshots.push(snapshot); if (snapshots.length === 1) await gate.promise; return answer;
  } });
  const first = executor.search({ query: '先运行' }); await tick();
  const second = executor.search({ query: '后派发' });
  revision = '二'; sharedArgs.push('新参数');
  assert.deepEqual(snapshots[0].executableArgs, ['旧参数']);
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(snapshots[0].revision, '一'); assert.equal(snapshots[1].revision, '二');
  await executor.dispose();
});

test('读取配置快照也受截止时间约束，停止不会无限等待快照', async () => {
  let ran = false;
  const executor = createSearchExecutor({ budgetMs: 80, cleanupMs: 20, snapshot: () => new Promise(() => {}), runQuery: async () => { ran = true; return answer; } });
  await assert.rejects(executor.search({ query: '快照等待' }), error => error.code === 'GROK_TIMEOUT');
  await executor.dispose(); assert.equal(ran, false);
});

test('停止先拒绝新查询，取消排队和运行并等待运行回收', async () => {
  let reaped = false;
  const executor = createSearchExecutor({ maxRunning: 1, snapshot: () => ({}), runQuery: async ({ signal }) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => setTimeout(() => { reaped = true; reject(signal.reason); }, 15), { once: true }));
  } });
  const first = executor.search({ query: '运行' }); const firstRejected = assert.rejects(first, error => error.code === 'GROK_SEARCH_STOPPING');
  await tick();
  const second = executor.search({ query: '排队' }); const secondRejected = assert.rejects(second, error => error.code === 'GROK_SEARCH_STOPPING');
  const stop = executor.dispose();
  assert.equal(executor.snapshot().accepting, false);
  await assert.rejects(executor.search({ query: '停止之后' }), error => error.code === 'GROK_SEARCH_STOPPING');
  await stop; await Promise.all([firstRejected, secondRejected]); assert.equal(reaped, true);
});

test('回收失败保留故障槽位，直到实际退出才允许后续查询', async () => {
  const exit = deferred(); let calls = 0;
  const executor = createSearchExecutor({ snapshot: () => ({}), runQuery: async () => {
    if (++calls === 1) { const error = new GrokSearchError('GROK_PROCESS_REAP_FAILED', '未回收'); Object.defineProperty(error, 'whenExited', { value: exit.promise }); throw error; }
    return answer;
  } });
  await assert.rejects(executor.search({ query: '失败' }), error => error.code === 'GROK_PROCESS_REAP_FAILED');
  assert.equal(executor.snapshot().running, 1); assert.equal(executor.snapshot().faulted, 1);
  await assert.rejects(executor.search({ query: '暂停' }), error => error.code === 'GROK_PROCESS_REAP_FAILED');
  exit.resolve(); await tick();
  assert.deepEqual(await executor.search({ query: '实际退出后' }), answer);
  await executor.dispose();
});

test('executor disposal preserves the actual exit proof after its bounded cleanup fails', async () => {
  const exit = deferred();
  const executor = createSearchExecutor({ snapshot: () => ({}), runQuery: async () => {
    const error = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'The test process has not exited.');
    Object.defineProperty(error, 'whenExited', { value: exit.promise });
    throw error;
  } });
  await assert.rejects(executor.search({ query: 'synthetic pending exit' }), { code: 'GROK_PROCESS_REAP_FAILED' });
  let exited = false, cleanupError;
  await assert.rejects(executor.dispose(), error => {
    cleanupError = error;
    return error.code === 'GROK_PROCESS_REAP_FAILED' && typeof error.whenExited?.then === 'function';
  });
  const proof = cleanupError.whenExited.then(() => { exited = true; });
  await tick();
  assert.equal(exited, false);
  assert.equal(executor.snapshot().faulted, 1);
  exit.resolve();
  await proof;
  assert.equal(executor.snapshot().faulted, 0);
  assert.equal(executor.snapshot().running, 0);
});

test('executor observes a rejected aggregate exit proof without clearing its unresolved resource', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createSearchExecutor } from ${JSON.stringify(new URL('../src/core/search-executor.mjs', import.meta.url).href)};
    import { GrokSearchError } from ${JSON.stringify(new URL('../src/core/errors.mjs', import.meta.url).href)};
    let rejectExit;
    const whenExited = new Promise((_, reject) => { rejectExit = reject; });
    const executor = createSearchExecutor({ snapshot: () => ({}), runQuery: async () => {
      const error = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'Synthetic pending exit.');
      Object.defineProperty(error, 'whenExited', { value: whenExited });
      throw error;
    } });
    await assert.rejects(executor.search({ query: 'synthetic pending exit' }), { code: 'GROK_PROCESS_REAP_FAILED' });
    const failure = await executor.dispose().catch(error => error);
    const denied = new Error('Synthetic exit observer rejected.');
    rejectExit(denied);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(failure.whenExited, error => error === denied);
    assert.equal(executor.snapshot().faulted, 1);
    assert.equal(executor.snapshot().accepting, false);
  `;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
    windowsHide: true, timeout: 10_000, encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('上游错误直接传播，不调用任何替代搜索', async () => {
  let calls = 0; const failure = new GrokSearchError('GROK_TOOL_ERROR', '上游失败');
  const executor = createSearchExecutor({ snapshot: () => ({}), runQuery: async () => { calls++; throw failure; } });
  await assert.rejects(executor.search({ query: '明确失败' }), error => error === failure);
  assert.equal(calls, 1); await executor.dispose();
});

test('queued chat searches run before waiting diagnostics without interrupting an active request', async () => {
  const gate = deferred(), order = [];
  const executor = createSearchExecutor({ snapshot: () => ({}), runQuery: async ({ request }) => {
    order.push(request.query);
    if (order.length === 1) await gate.promise;
    return answer;
  } });
  const active = executor.search({ query: 'active', testPrimary: true });
  await tick();
  const diagnosis = executor.search({ query: 'diagnosis', testPrimary: true });
  const chat = executor.search({ query: 'chat' });
  gate.resolve();
  await Promise.all([active, diagnosis, chat]);
  assert.deepEqual(order, ['active', 'chat', 'diagnosis']);
  await executor.dispose();
});

test('代理对序列在精确字符预算下保持单调二分且不因孤立高代理转义提前截断', () => {
  const truncatedOverhead = JSON.stringify({ content: '', sources: [], truncated: true }).length;
  // Each 🙂 is 2 UTF-16 code units in JSON string literal (no backslash escaping when paired),
  // whereas an unpaired high surrogate expands to 6 chars (\ud83d). Budget fits exactly 10 emojis (20 code units).
  const budget = truncatedOverhead + 80;
  const result = mapSearchResult({ content: '🙂'.repeat(80), sources: [] }, { maxChars: budget });
  assert.equal(result.truncated, true);
  assert.equal(result.content, '🙂'.repeat(40));
  assert.equal(JSON.stringify(result).length, budget);
});
