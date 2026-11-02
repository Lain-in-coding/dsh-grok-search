import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionOwner } from '../src/core/session-owner.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const operation = async session => session.id;
const request = (identity = 'one', extra = {}) => ({ identity, configuration: {}, operation, ...extra });

test('连续同身份请求只打开一个会话，退出幂等', async () => {
  let opens = 0, closes = 0;
  const owner = createSessionOwner({ open: async () => ({ id: ++opens, close: async () => { closes++; } }) });
  assert.equal(await owner.run(request()), 1);
  assert.equal(await owner.run(request()), 1);
  assert.equal(opens, 1);
  const first = owner.dispose();
  assert.equal(owner.dispose(), first);
  await first;
  assert.equal(closes, 1);
  await assert.rejects(owner.run(request()), { code: 'GROK_SEARCH_STOPPING' });
});

test('身份变化必须等待旧连接确认关闭后才打开新连接', async () => {
  const closed = deferred();
  let opens = 0;
  const owner = createSessionOwner({ open: async () => ({ id: ++opens, close: opens === 1 ? () => closed.promise : async () => {} }) });
  await owner.run(request());
  const second = owner.run(request('two'));
  await delay(0);
  assert.equal(opens, 1);
  assert.equal(owner.snapshot().closing, true);
  closed.resolve();
  assert.equal(await second, 2);
  await owner.dispose();
});

test('直接并发不创建第二进程，串行责任属于外层队列', async () => {
  const pending = deferred();
  const owner = createSessionOwner({ open: async () => ({ close: async () => {} }) });
  const first = owner.run(request('one', { operation: () => pending.promise }));
  await assert.rejects(owner.run(request()), { code: 'GROK_SESSION_BUSY' });
  pending.resolve('done');
  assert.equal(await first, 'done');
  await owner.dispose();
});

test('打开阶段取消后迟到的连接必须回收，不能复用', async () => {
  const opening = deferred();
  const controller = new AbortController();
  const reason = new Error('caller cancellation');
  let closes = 0, called = false;
  const owner = createSessionOwner({ open: () => opening.promise });
  const result = owner.run(request('one', { signal: controller.signal, operation: () => { called = true; } }));
  const rejected = assert.rejects(result, error => error === reason);
  await delay(0);
  controller.abort(reason);
  opening.resolve({ close: async () => { closes++; } });
  await rejected;
  assert.equal(closes, 1);
  assert.equal(called, false);
  assert.equal(owner.snapshot().connected, false);
  await owner.dispose();
});

test('dispose 期间迟到的初始化被回收，状态不会复活', async () => {
  const opening = deferred();
  let closes = 0;
  const owner = createSessionOwner({ open: () => opening.promise });
  const result = owner.run(request());
  const rejected = assert.rejects(result, { code: 'GROK_SEARCH_STOPPING' });
  await delay(0);
  const disposed = owner.dispose();
  opening.resolve({ close: async () => { closes++; } });
  await Promise.all([disposed, rejected]);
  assert.equal(closes, 1);
  assert.equal(owner.snapshot().connected, false);
});

test('查询失败后关闭连接，下一次重新建立，不沿用未知状态', async () => {
  let opens = 0, closes = 0;
  const owner = createSessionOwner({ open: async () => ({ id: ++opens, close: async () => { closes++; } }) });
  await assert.rejects(owner.run(request('one', { operation: async () => { throw new Error('failure'); } })), /failure/);
  assert.equal(closes, 1);
  assert.equal(await owner.run(request()), 2);
  await owner.dispose();
});

test('回收失败阻止新连接且优先于普通请求错误', async () => {
  const fault = new Error('unproven process exit');
  let opens = 0;
  const owner = createSessionOwner({ open: async () => ({ id: ++opens, close: async () => { throw fault; } }) });
  await owner.run(request());
  await assert.rejects(owner.run(request('two')), error => error === fault);
  await assert.rejects(owner.run(request()), error => error === fault);
  await assert.rejects(owner.dispose(), error => error === fault);
  assert.equal(opens, 1);
});

test('空闲退出只关闭本实例会话，后续请求重新打开', async () => {
  const closed = deferred();
  let opens = 0;
  const owner = createSessionOwner({ idleMs: 15, open: async () => ({ id: ++opens, close: async () => closed.resolve() }) });
  await owner.run(request());
  await Promise.race([closed.promise, delay(500).then(() => { throw new Error('idle close missing'); })]);
  assert.equal(await owner.run(request()), 2);
  await owner.dispose();
});

test('预先取消不打开连接', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const owner = createSessionOwner({ open: async () => { assert.fail('must not open'); } });
  await assert.rejects(owner.run(request('one', { signal: controller.signal })), /cancelled/);
  await owner.dispose();
});

test('在途取消后迟到成功不能作为结果返回，连接必须关闭', async () => {
  const pending = deferred(), entered = deferred();
  const controller = new AbortController();
  const reason = new Error('cancelled in flight');
  let closes = 0;
  const owner = createSessionOwner({ open: async () => ({ close: async () => { closes++; } }) });
  const result = owner.run(request('one', { signal: controller.signal,
    operation: () => { entered.resolve(); return pending.promise; } }));
  const rejected = assert.rejects(result, error => error === reason);
  await entered.promise;
  controller.abort(reason);
  pending.resolve('late success');
  await rejected;
  assert.equal(closes, 1);
  await owner.dispose();
});

test('空闲回收失败被报告并锁住新请求，即使报告器抛异常', async () => {
  const reported = deferred();
  const fault = new Error('idle reap failed');
  const owner = createSessionOwner({ idleMs: 10,
    open: async () => ({ close: async () => { throw fault; } }),
    onError: error => { reported.resolve(error); throw new Error('report failed'); } });
  await owner.run(request());
  const timeout = new AbortController();
  try {
    assert.equal(await Promise.race([reported.promise, delay(500, undefined, { signal: timeout.signal })]), fault);
    await assert.rejects(owner.run(request()), error => error === fault);
    await assert.rejects(owner.dispose(), error => error === fault);
  } finally { timeout.abort(); }
});
