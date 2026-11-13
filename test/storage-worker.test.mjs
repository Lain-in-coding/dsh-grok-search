import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createStorageMaintenanceWorker } from '../src/core/storage-worker.mjs';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';

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
    worker.terminate = async () => 0;
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
    worker.terminate = async () => 0;
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
