import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { runStorageMaintenance } from '../src/core/storage-maintenance.mjs';

function fixture() {
  const profile = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-storage-offline-'));
  const directory = join(profile, 'control-intent.records');
  const store = createControlIntentStore({ directory });
  const current = store.compareAndSwap({ expectedRevision: 0,
    intent: { schemaVersion: 1, policy: 'released', reason: 'user-stopped',
      release: { explicit: true, committedAt: '2026-11-01T00:00:00Z' } } });
  store.maintain({ force: true });
  return { profile, directory, store, current };
}

test('inspection is read-only and conversion requires explicit offline mode and current revision', () => {
  const f = fixture();
  const before = readFileSync(join(f.directory, 'checkpoint.json'));
  assert.equal(runStorageMaintenance({ profile: f.profile, mode: 'inspect' }).mutation, false);
  assert.deepEqual(readFileSync(join(f.directory, 'checkpoint.json')), before);
  assert.throws(() => runStorageMaintenance({ profile: f.profile, mode: 'prepare-downgrade', expectedRevision: 1 }),
    { code: 'CONTROL_OFFLINE_REQUIRED' });
  assert.throws(() => runStorageMaintenance({ profile: f.profile, mode: 'prepare-downgrade', offline: true, expectedRevision: 0 }),
    { code: 'CONTROL_CAS_CONFLICT' });
});

test('offline downgrade preserves the complete current intent and retains the source layout', () => {
  const f = fixture();
  const prepared = runStorageMaintenance({ profile: f.profile, mode: 'prepare-downgrade',
    offline: true, expectedRevision: 1 });
  const result = runStorageMaintenance({ profile: f.profile, mode: 'activate-downgrade',
    offline: true, expectedRevision: 1, preparedDirectory: prepared.targetDirectory });
  assert.equal(result.status, 'downgraded');
  assert.equal(result.policy, 'released');
  assert.equal(result.configurationChanged, false);
  assert.equal(existsSync(join(result.retainedDirectory, 'checkpoint.json')), true);
  assert.equal(existsSync(join(f.directory, 'checkpoint.json')), false);
  assert.deepEqual(f.store.read().intent, f.current.intent);
});

test('all directory-swap interruptions are explicit and recoverable without losing either layout', () => {
  for (const point of ['before-source-move', 'after-source-move', 'after-target-move', 'before-transition-complete']) {
    const f = fixture();
    const prepared = runStorageMaintenance({ profile: f.profile, mode: 'prepare-downgrade',
      offline: true, expectedRevision: 1 });
    assert.throws(() => runStorageMaintenance({ profile: f.profile, mode: 'activate-downgrade',
      offline: true, expectedRevision: 1, preparedDirectory: prepared.targetDirectory,
      fault(stage) { if (stage === point) throw new Error(point); } }), new RegExp(point));
    assert.equal(runStorageMaintenance({ profile: f.profile, mode: 'inspect' }).status, 'downgrade-interrupted');
    assert.throws(() => createControlIntentStore({ directory: f.directory }).read(), { code: 'CONTROL_STORAGE_TRANSITION' });
    const result = runStorageMaintenance({ profile: f.profile, mode: 'recover-downgrade', offline: true });
    assert.equal(result.status, 'downgraded');
    assert.deepEqual(createControlIntentStore({ directory: f.directory }).read().intent, f.current.intent);
    assert.equal(existsSync(f.directory + '.transition.json'), false);
  }
});

test('running owner and a changed source block offline activation', () => {
  const f = fixture();
  const prepared = runStorageMaintenance({ profile: f.profile, mode: 'prepare-downgrade',
    offline: true, expectedRevision: 1 });
  f.store.compareAndSwap({ expectedRevision: 1, intent: { ...f.current.intent,
    reason: 'changed-after-preparation' } });
  assert.throws(() => runStorageMaintenance({ profile: f.profile, mode: 'activate-downgrade',
    offline: true, expectedRevision: 2, preparedDirectory: prepared.targetDirectory }), { code: 'CONTROL_EXPORT_SOURCE_CHANGED' });
  const current = f.store.read();
  f.store.compareAndSwap({ expectedRevision: current.revision, intent: { ...current.intent,
    lease: { pid: process.pid, uid: 'test', entryId: 'web', moduleName: 'test', provider: 'test' } } });
  assert.throws(() => runStorageMaintenance({ profile: f.profile, mode: 'prepare-downgrade',
    offline: true, expectedRevision: 3 }), { code: 'CONTROL_HOST_STILL_RUNNING' });
});
