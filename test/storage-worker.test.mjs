import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, realpathSync, readFileSync, unlinkSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createStorageMaintenanceWorker } from '../src/core/storage-worker.mjs';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { acquireOwnedLock } from '../src/core/owned-lock.mjs';

function fixture(count) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-storage-worker-'));
  const directory = join(root, 'records');
  mkdirSync(directory);
  let previousSha256 = null;
  for (let revision = 1; revision <= count; revision++) {
    const bytes = Buffer.from(JSON.stringify({ format: 'dsh-grok-search/control-intent', schemaVersion: 1,
      revision, operationId: randomUUID(), previousSha256,
      intent: { schemaVersion: 1, policy: 'required', reason: 'synthetic', release: null } }, null, 2) + '\n');
    writeFileSync(join(directory, `v${String(revision).padStart(12, '0')}.json`), bytes);
    previousSha256 = createHash('sha256').update(bytes).digest('hex');
  }
  return { directory, trustedRoot: root };
}

test('real worker seals a ledger without blocking the main event loop and produces a usable checkpoint', async t => {
  const f = fixture(201);
  const service = createStorageMaintenanceWorker(f);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  try {
    const result = await service.schedule();
    assert.equal(result.status, 'migrated');
    assert.ok(ticks > 10, `main event-loop progress expected during worker sealing, got ${ticks}`);
    assert.equal(createControlIntentStore(f).read().revision, 201);
    assert.equal(createControlIntentStore(f).inspectStorage().activeRevisions.length, 50);
    t.diagnostic(JSON.stringify({ mainThreadTimerTicks: ticks, checkpointRevision: result.checkpointRevision }));
  } finally { clearInterval(timer); service.dispose(); }
});

test('worker leases deduplicate tasks, preserve the remaining owner and cancel only the last owner', async () => {
  const f = fixture(1);
  let creations = 0, worker, cancelFlag;
  const factory = () => {
    creations++;
    worker = new EventEmitter();
    worker.postMessage = ({ cancelBuffer }) => { cancelFlag = new Int32Array(cancelBuffer); };
    worker.terminate = async () => { queueMicrotask(() => worker.emit('exit', 0)); return 0; };
    return worker;
  };
  const first = createStorageMaintenanceWorker({ ...f, workerFactory: factory });
  const second = createStorageMaintenanceWorker({ ...f, workerFactory: factory });
  const a = first.schedule(), b = second.schedule();
  assert.equal(a, b);
  assert.equal(creations, 1);
  first.dispose();
  assert.equal(Atomics.load(cancelFlag, 0), 0);
  worker.emit('message', { status: 'unchanged' });
  assert.equal((await b).status, 'unchanged');
  const c = second.schedule();
  second.dispose();
  assert.equal(Atomics.load(cancelFlag, 0), 1);
  worker.emit('message', { status: 'cancelled' });
  assert.equal((await c).status, 'cancelled');
});

test('cancellation waits for a safe boundary and releases the maintenance lock', async () => {
  const f = fixture(151);
  const service = createStorageMaintenanceWorker(f);
  const result = service.schedule();
  service.dispose();
  assert.equal((await result).status, 'cancelled');
  assert.equal(existsSync(join(f.directory, 'checkpoint.lock')), false);
  assert.equal(createControlIntentStore(f).read().revision, 151);
});

test('a new owner waits for the cancelled predecessor rather than spawning overlapping maintenance', async () => {
  const f = fixture(1), workers = [];
  const factory = () => {
    const worker = new EventEmitter();
    worker.postMessage = () => {};
    worker.terminate = async () => { queueMicrotask(() => worker.emit('exit', 0)); return 0; };
    workers.push(worker);
    return worker;
  };
  const first = createStorageMaintenanceWorker({ ...f, workerFactory: factory, retryDelayMs: 5 });
  const pending = first.schedule();
  first.dispose();
  const next = createStorageMaintenanceWorker({ ...f, workerFactory: factory, retryDelayMs: 5 });
  const resumed = next.schedule();
  try {
    assert.equal(workers.length, 1, 'hot reload must wait for cancellation at the old worker safe boundary');
    workers[0].emit('message', { status: 'cancelled' });
    await pending;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(workers.length, 2, 'a renewed owner receives a follow-up maintenance attempt');
    workers[1].emit('message', { status: 'unchanged' });
    await resumed;
    assert.equal(next.status().status, 'unchanged');
  } finally {
    next.dispose();
    for (const worker of workers) worker.emit('message', { status: 'cancelled' });
    await pending;
    await resumed;
  }
});

test('an exited maintenance worker releases only its abandoned locks before later user writes', async () => {
  for (const point of ['archive', 'checkpoint']) {
    const f = fixture(60);
    const moduleUrl = new URL('../src/core/control-intent-store.mjs', import.meta.url).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const originalRename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (${JSON.stringify(point)} === 'checkpoint' && String(from).includes('checkpoint-stage-')) process.exit(92);
        return originalRename(from, to);
      };
      require('node:module').syncBuiltinESMExports();
      parentPort.once('message', async () => {
        const { createControlIntentStore } = await import(${JSON.stringify(moduleUrl)});
        createControlIntentStore({ ...workerData,
          onMaintenanceLock: receipt => parentPort.postMessage({ type: 'maintenance-lock', ...receipt }),
          fault(stage) { if (${JSON.stringify(point)} === 'archive' && stage === 'maintenance-progress') process.exit(91); },
        }).maintain();
      });
    `;
    const worker = createStorageMaintenanceWorker({ ...f,
      workerFactory: (_url, options) => new Worker(source, { ...options, eval: true }) });
    try {
      assert.equal((await worker.schedule()).code, 'CONTROL_MAINTENANCE_EXIT');
      assert.equal(existsSync(join(f.directory, 'checkpoint.lock')), false);
      assert.equal(existsSync(join(f.directory, 'control-write.lock')), false);
      const store = createControlIntentStore({ ...f, governance: true, autoMaintain: false });
      const record = await store.compareAndSwapAsync({ expectedRevision: 60,
        intent: { schemaVersion: 1, policy: 'required', reason: 'after-worker-exit', release: null } });
      assert.equal(record.revision, 61);
    } finally { worker.dispose(); }
  }
});

test('a worker error is not exit proof and exit never removes a replacement parent lock', async () => {
  const f = fixture(1), moduleUrl = new URL('../src/core/owned-lock.mjs', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    parentPort.once('message', async () => {
      const { acquireOwnedLock } = await import(${JSON.stringify(moduleUrl)});
      acquireOwnedLock(require('node:path').join(workerData.directory, 'checkpoint.lock'), {
        token: workerData.maintenanceLockTokens.checkpoint,
        onAcquired: owner => parentPort.postMessage({ type: 'maintenance-lock', name: 'checkpoint.lock', owner }),
      });
      parentPort.once('message', () => process.exit(93));
    });
  `;
  let child, announce, settled = false, replacement;
  const acquired = new Promise(resolve => { announce = resolve; });
  const service = createStorageMaintenanceWorker({ ...f, workerFactory: (_url, options) => {
    child = new Worker(source, { ...options, eval: true });
    child.on('message', value => { if (value.type === 'maintenance-lock') announce(); });
    return child;
  } });
  const pending = service.schedule();
  pending.then(() => { settled = true; });
  try {
    await acquired;
    const lockPath = join(f.directory, 'checkpoint.lock');
    child.emit('error', Object.assign(new Error('synthetic worker error before exit'), { code: 'TEST_WORKER_ERROR' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(existsSync(lockPath), true);
    unlinkSync(lockPath);
    replacement = acquireOwnedLock(lockPath);
    const bytes = readFileSync(lockPath);
    child.postMessage({ exit: true });
    assert.equal((await pending).code, 'TEST_WORKER_ERROR');
    assert.deepEqual(readFileSync(lockPath), bytes, 'same PID does not authorize removing another owner');
  } finally {
    child?.postMessage({ exit: true });
    await pending;
    replacement?.release();
    service.dispose();
  }
});

test('an unrelated acquisition receipt cannot authorize cleanup of a parent lock', async () => {
  const f = fixture(1), path = join(f.directory, 'control-write.lock');
  let owner, child;
  const parentLock = acquireOwnedLock(path, { onAcquired: value => { owner = value; } });
  const before = readFileSync(path);
  const service = createStorageMaintenanceWorker({ ...f, workerFactory: () => {
    child = new EventEmitter();
    child.postMessage = () => {};
    child.terminate = async () => { queueMicrotask(() => child.emit('exit', 1)); return 1; };
    return child;
  } });
  try {
    const pending = service.schedule();
    child.emit('message', { type: 'maintenance-lock', name: 'control-write.lock', owner });
    child.emit('exit', 1);
    await pending;
    assert.deepEqual(readFileSync(path), before);
  } finally { service.dispose(); parentLock.release(); }
});
