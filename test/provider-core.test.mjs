import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { GrokSearchError } from '../src/core/errors.mjs';
import { decodeGrokResult, mapSearchResult } from '../src/core/result-map.mjs';
import { createSearchExecutor } from '../src/core/search-executor.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const answer = { content: '已完成', sources: [], truncated: false };
const tick = () => new Promise(resolve => setImmediate(resolve));

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
  await assert.rejects(second, error => error.code === 'GROK_TIMEOUT');
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

test('上游错误直接传播，不调用任何替代搜索', async () => {
  let calls = 0; const failure = new GrokSearchError('GROK_TOOL_ERROR', '上游失败');
  const executor = createSearchExecutor({ snapshot: () => ({}), runQuery: async () => { calls++; throw failure; } });
  await assert.rejects(executor.search({ query: '明确失败' }), error => error === failure);
  assert.equal(calls, 1); await executor.dispose();
});
