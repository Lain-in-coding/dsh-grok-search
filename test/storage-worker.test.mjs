import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync, unlinkSync, symlinkSync, linkSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createStorageMaintenanceWorker } from '../src/core/storage-worker.mjs';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { acquireOwnedLock, releaseOwnedLockReceipt } from '../src/core/owned-lock.mjs';

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

test('a rejected asynchronous maintenance observer cannot fail the completed worker operation', async () => {
  const f = fixture(1);
  let child, observed = false;
  const service = createStorageMaintenanceWorker({ ...f,
    onResult: async () => { observed = true; throw new Error('optional observer failed'); },
    workerFactory: () => {
      child = new EventEmitter();
      child.postMessage = () => {};
      child.terminate = async () => { queueMicrotask(() => child.emit('exit', 0)); return 0; };
      return child;
    },
  });
  try {
    const pending = service.schedule();
    child.emit('message', { status: 'unchanged' });
    assert.equal((await pending).status, 'unchanged');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(observed, true);
  } finally { service.dispose(); }
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

test('an exited maintenance worker retains an exact lock receipt across a transient cleanup failure', async t => {
  for (const changed of ['unchanged', 'replacement', 'changed-bytes', 'unreadable-retry', 'missing',
    'same-ancestor-alias', 'retargeted-ancestor', 'retargeted-original-path', 'replaced-parent']) await t.test(changed, async () => {
    const f = fixture(1), path = join(f.directory, 'control-write.lock');
    const moduleUrl = new URL('../src/core/owned-lock.mjs', import.meta.url).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      parentPort.once('message', async () => {
        const { acquireOwnedLock } = await import(${JSON.stringify(moduleUrl)});
        acquireOwnedLock(require('node:path').join(workerData.directory, 'control-write.lock'), {
          token: workerData.maintenanceLockTokens.writer,
          onAcquired: owner => parentPort.postMessage({ type: 'maintenance-lock', name: 'control-write.lock', owner }),
        });
        process.exit(91);
      });
    `;
    let child, replacement, alias, releaseAttempts = 0;
    const service = createStorageMaintenanceWorker({ ...f, workerFactory: (_url, options) => {
      child = new Worker(source, { ...options, eval: true });
      return child;
    } });
    const unlink = fs.unlinkSync, read = fs.readFileSync;
    fs.unlinkSync = target => {
      if (target === path && ++releaseAttempts === 1) {
        throw Object.assign(new Error('synthetic transient cleanup failure'), { code: 'EBUSY' });
      }
      return unlink(target);
    };
    syncBuiltinESMExports();
    try {
      assert.equal((await service.schedule()).code, 'CONTROL_MAINTENANCE_EXIT');
      const before = readFileSync(path);
      assert.equal(releaseAttempts, 1);
      const store = createControlIntentStore({ ...f, governance: true, autoMaintain: false });
      const request = { expectedRevision: 1,
        intent: { schemaVersion: 1, policy: 'required', reason: 'after-proven-worker-exit', release: null } };
      if (changed === 'unreadable-retry') {
        fs.readFileSync = (target, ...args) => {
          if (target === path) throw Object.assign(new Error('synthetic unreadable retained lock'), { code: 'EACCES' });
          return read(target, ...args);
        };
        syncBuiltinESMExports();
        await assert.rejects(store.compareAndSwapAsync(request), { code: 'CONTROL_STORAGE_BUSY' });
        assert.equal(releaseAttempts, 1, 'unreadable ownership is not deletion authority');
        fs.readFileSync = read;
        syncBuiltinESMExports();
      }
      if (changed === 'unchanged' || changed === 'unreadable-retry' || changed === 'missing') {
        if (changed === 'missing') unlink(path);
        const record = await store.compareAndSwapAsync(request);
        assert.equal(record.revision, 2);
        assert.ok(releaseAttempts >= 2, 'a later write can retry cleanup without waiting for the shared parent PID to exit');
        assert.equal(existsSync(path), false);
      } else if (changed === 'same-ancestor-alias') {
        alias = join(f.trustedRoot, 'lock-alias');
        symlinkSync(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
        const retry = acquireOwnedLock(join(alias, 'control-write.lock'));
        assert.equal(retry.release(), true, 'an unchanged directory alias still refers to the same exited owner');
        assert.equal(existsSync(path), false);
      } else if (changed === 'retargeted-original-path' || changed === 'replaced-parent') {
        const saved = join(f.trustedRoot, 'saved-records'), other = join(f.trustedRoot, 'other-records');
        fs.renameSync(f.directory, saved);
        if (changed === 'retargeted-original-path') mkdirSync(other);
        else mkdirSync(f.directory);
        const target = join(changed === 'retargeted-original-path' ? other : f.directory, 'control-write.lock');
        linkSync(join(saved, 'control-write.lock'), target);
        if (changed === 'retargeted-original-path') {
          alias = f.directory;
          symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
        }
        assert.throws(() => acquireOwnedLock(path), { code: 'EEXIST' });
        assert.deepEqual(readFileSync(target), before, 'retargeting the original path cannot reuse an old directory receipt');
        assert.deepEqual(readFileSync(join(saved, 'control-write.lock')), before);
      } else if (changed === 'retargeted-ancestor') {
        const parent = join(f.trustedRoot, 'alias-parent'), other = join(f.trustedRoot, 'other-parent');
        mkdirSync(parent); mkdirSync(other);
        const target = join(other, 'control-write.lock');
        linkSync(path, target);
        alias = join(f.trustedRoot, 'lock-alias');
        symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
        const indirect = join(alias, 'control-write.lock');
        await assert.rejects(Promise.resolve().then(() => acquireOwnedLock(indirect)), { code: 'EEXIST' });
        assert.deepEqual(readFileSync(target), before, 'an alias to the same inode elsewhere is not the acquired path');
        const record = await store.compareAndSwapAsync(request);
        assert.equal(record.revision, 2, 'the original verified path remains independently retryable');
        assert.deepEqual(readFileSync(target), before);
      } else {
        if (changed === 'replacement') {
          unlink(path);
          replacement = acquireOwnedLock(path);
        } else writeFileSync(path, before.toString().replace(/\n$/, ' '));
        const currentBytes = readFileSync(path);
        await assert.rejects(store.compareAndSwapAsync(request), { code: 'CONTROL_STORAGE_BUSY' });
        assert.deepEqual(readFileSync(path), currentBytes, 'the exited worker cannot authorize removing changed ownership');
        assert.equal(releaseAttempts, 1);
      }
    } finally {
      fs.unlinkSync = unlink;
      fs.readFileSync = read;
      syncBuiltinESMExports();
      service.dispose();
      await child?.terminate();
      replacement?.release();
      if (alias) {
        if (process.platform === 'win32') fs.rmdirSync(alias);
        else unlink(alias);
      }
    }
  });
});

test('an exited maintenance worker using the original receipt shape cannot newly block later writes', async t => {
  for (const transient of [false, true]) await t.test(String(transient), async () => {
    const f = fixture(1), path = join(f.directory, 'control-write.lock');
    const moduleUrl = new URL('../src/core/owned-lock.mjs', import.meta.url).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      parentPort.once('message', async () => {
        const { acquireOwnedLock } = await import(${JSON.stringify(moduleUrl)});
        acquireOwnedLock(require('node:path').join(workerData.directory, 'control-write.lock'), {
          token: workerData.maintenanceLockTokens.writer,
          onAcquired: ({ token, pid, dev, ino, text }) => {
            parentPort.postMessage({ type: 'maintenance-lock', name: 'control-write.lock', owner: { token, pid, dev, ino, text } });
          },
        });
        process.exit(91);
      });
    `;
    let child, attempts = 0;
    const service = createStorageMaintenanceWorker({ ...f, workerFactory: (_url, options) => {
      child = new Worker(source, { ...options, eval: true });
      return child;
    } });
    const unlink = fs.unlinkSync;
    fs.unlinkSync = target => {
      if (target === path && ++attempts === 1 && transient) {
        throw Object.assign(new Error('synthetic old-producer cleanup failure'), { code: 'EBUSY' });
      }
      return unlink(target);
    };
    syncBuiltinESMExports();
    try {
      assert.equal((await service.schedule()).code, 'CONTROL_MAINTENANCE_EXIT');
      assert.equal(attempts, 1, 'the old receipt remains immediately verifiable after its known worker exits');
      assert.equal(existsSync(path), transient);
      const store = createControlIntentStore({ ...f, governance: true, autoMaintain: false });
      assert.equal((await store.compareAndSwapAsync({ expectedRevision: 1,
        intent: { schemaVersion: 1, policy: 'required', reason: 'original-receipt-retry', release: null } })).revision, 2);
    } finally {
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
      service.dispose();
      await child?.terminate();
    }
  });
});

test('an unreadable receipt cannot seed deferred deletion of a live parent lock', () => {
  const f = fixture(1), path = join(f.directory, 'control-write.lock');
  let receipt, attempts = 0;
  const owner = acquireOwnedLock(path, { onAcquired: value => { receipt = value; } });
  const before = readFileSync(path), read = fs.readFileSync, unlink = fs.unlinkSync;
  fs.readFileSync = (target, ...args) => {
    if (target === path) throw Object.assign(new Error('synthetic unreadable receipt'), { code: 'EACCES' });
    return read(target, ...args);
  };
  fs.unlinkSync = target => { if (target === path) attempts++; return unlink(target); };
  syncBuiltinESMExports();
  try {
    assert.equal(releaseOwnedLockReceipt(path, receipt), false);
    fs.readFileSync = read;
    syncBuiltinESMExports();
    assert.throws(() => acquireOwnedLock(path), { code: 'EEXIST' });
    assert.equal(attempts, 0);
    assert.deepEqual(readFileSync(path), before);
    for (const supplied of [null, {}, { ...receipt, token: randomUUID() },
      { ...receipt, pid: 0 }, { ...receipt, ino: 0 }, { ...receipt, text: receipt.text + ' ' }]) {
      assert.equal(releaseOwnedLockReceipt(path, supplied), false);
      assert.throws(() => acquireOwnedLock(path), { code: 'EEXIST' });
    }
  } finally {
    fs.readFileSync = read;
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    owner.release();
  }
});

test('exited-lock retries have a bounded one-receipt-per-path registry and cleanup missing paths', () => {
  const f = fixture(1), receipts = [], locks = [];
  const unlink = fs.unlinkSync, paths = new Set();
  let denied = true;
  fs.unlinkSync = target => {
    if (denied && paths.has(target)) throw Object.assign(new Error('synthetic retained cleanup'), { code: 'EBUSY' });
    return unlink(target);
  };
  syncBuiltinESMExports();
  try {
    for (let index = 0; index < 65; index++) {
      const path = join(f.directory, `owner-${index}.lock`);
      paths.add(path);
      locks.push(acquireOwnedLock(path, { onAcquired: receipt => { receipts.push({ path, receipt }); } }));
      assert.equal(releaseOwnedLockReceipt(path, receipts.at(-1).receipt), false);
    }
    denied = false;
    assert.throws(() => acquireOwnedLock(receipts[0].path), { code: 'EEXIST' },
      'capacity eviction removes permission rather than deleting an old lock');
    assert.deepEqual(readFileSync(receipts[0].path, 'utf8'), receipts[0].receipt.text);
    const latest = acquireOwnedLock(receipts.at(-1).path);
    assert.equal(latest.release(), true);
    const retained = receipts.at(-2);
    unlink(retained.path);
    const successor = acquireOwnedLock(retained.path, { onAcquired: () => {} });
    assert.throws(() => acquireOwnedLock(retained.path), { code: 'EEXIST' },
      'a new active owner clears stale retry permission for that path');
    assert.equal(successor.release(), true);
    for (const { path, receipt } of receipts.slice(1, -2)) releaseOwnedLockReceipt(path, receipt);
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
    for (const lock of locks) lock.release();
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
