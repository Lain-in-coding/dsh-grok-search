import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { runStorageMaintenance } from '../src/core/storage-maintenance.mjs';

function fixture() {
  const profile = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-so-'));
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

test('Windows extended-length local drive paths are accepted while UNC network paths remain blocked', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  const extendedLocal = f.profile.startsWith('\\\\?\\') ? f.profile : `\\\\?\\${f.profile}`;
  const inspected = runStorageMaintenance({ profile: extendedLocal, mode: 'inspect' });
  assert.equal(inspected.mutation, false);
  for (const unsafePath of ['\\\\server\\share\\profile', '//server/share/profile', '\\\\?\\UNC\\server\\share\\profile']) {
    assert.throws(() => runStorageMaintenance({ profile: unsafePath, mode: 'inspect' }), { code: 'CONTROL_STORAGE_PATH_UNSAFE' });
  }
});

function mockFs(t, target, name, implementation) {
  const method = t.mock.method(target, name, implementation);
  syncBuiltinESMExports();
  t.after(() => { method.mock.restore(); syncBuiltinESMExports(); });
}

for (const field of ['profile', 'preparedDirectory']) {
  test(`unsafe Windows ${field} is rejected before any profile or lock access`, { skip: process.platform !== 'win32' }, t => {
    const accesses = [];
    const unexpected = path => { accesses.push(path); throw new Error('Unexpected filesystem access'); };
    mockFs(t, fs, 'lstatSync', unexpected);
    mockFs(t, fs.realpathSync, 'native', unexpected);
    mockFs(t, fs, 'openSync', unexpected);
    const profile = 'C:\\synthetic-profile';
    const preparedDirectory = join(profile, 'control-intent.compatible-12345678-1234-4234-8234-123456789012');
    for (const input of [null, '', 'relative', 'C:relative', '/profile', '\\profile', '/\\host/share',
      '//host/share', String.raw`\\?\UNC\host\share`, String.raw`\\.\C:\profile`, String.raw`\\?\C:relative`,
      String.raw`\\?\C:\..\UNC\host\share`, String.raw`\\?\C:\..\GLOBALROOT\Device`,
      'C:\\a\0b', 'C:\\NUL.txt', 'C:\\dir:stream', 'C:\\name.']) {
      assert.throws(() => runStorageMaintenance({ mode: 'activate-downgrade', offline: true, expectedRevision: 1,
        profile, preparedDirectory, [field]: input }), { code: 'CONTROL_STORAGE_PATH_UNSAFE' }, JSON.stringify(input));
    }
    assert.deepEqual(accesses, []);
  });
}

test('extended local paths normalize consistently for profile and prepared sibling', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  const profile = win32.toNamespacedPath(f.profile).replaceAll('\\', '/') + '/unused/..';
  const options = { profile, offline: true, expectedRevision: f.current.revision };
  const prepared = runStorageMaintenance({ ...options, mode: 'prepare-downgrade' });
  const result = runStorageMaintenance({ ...options, mode: 'activate-downgrade',
    preparedDirectory: win32.toNamespacedPath(prepared.targetDirectory) });
  assert.equal(result.status, 'downgraded');
  assert.deepEqual(f.store.read().intent, f.current.intent);
});

test('a network root from realpath is rejected before accessing any child', { skip: process.platform !== 'win32' }, t => {
  const { profile } = fixture();
  const stat = fs.lstatSync;
  mockFs(t, fs, 'lstatSync', (path, ...args) => {
    assert.equal(path, profile, 'only the requested local profile may be probed');
    return stat(path, ...args);
  });
  mockFs(t, fs.realpathSync, 'native', () => String.raw`\\host\share\redirected`);
  assert.throws(() => runStorageMaintenance({ profile, mode: 'inspect' }), { code: 'CONTROL_STORAGE_PATH_UNSAFE' });
});

test('unreadable, missing and malformed downgrade receipts retain distinct diagnoses', t => {
  const { profile } = fixture();
  // Match maintenance's native canonical root, including Windows drive aliases.
  const transition = join(realpathSync.native(profile), 'control-intent.records.transition.json');
  const recover = () => runStorageMaintenance({ profile, mode: 'recover-downgrade', offline: true });
  assert.throws(recover, { code: 'ENOENT' });
  writeFileSync(transition, '{broken');
  assert.throws(recover, { code: 'CONTROL_STORAGE_RECEIPT_INVALID' });
  const read = fs.readFileSync;
  let receiptReads = 0;
  mockFs(t, fs, 'readFileSync', (path, ...args) => {
    if (path === transition) {
      receiptReads++;
      throw Object.assign(new Error('Synthetic receipt read failure'), { code: 'EIO' });
    }
    return read(path, ...args);
  });
  assert.throws(recover, { code: 'EIO' });
  assert.equal(receiptReads, 1, 'The receipt read failure must actually be injected.');
  assert.equal(read(transition, 'utf8'), '{broken');
});

test('storage CLI checks decimal revision text and its safe range before coercion', () => {
  const { profile } = fixture();
  const cli = fileURLToPath(new URL('../src/core/storage-maintenance.mjs', import.meta.url));
  const inspect = value => {
    const result = spawnSync(process.execPath, [cli, '--mode', 'inspect', '--profile', profile,
      '--expected-revision', value], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return result;
  };
  for (const value of ['0', '1', '9007199254740991']) assert.equal(inspect(value).status, 0, value);
  for (const value of ['', ' ', ' 1', '1\n', '-0', '-1', '+1', '1.0', '1e0', '0x1', '0b1',
    '0o1', '9007199254740991.1', '9007199254740992']) {
    const result = inspect(value);
    assert.equal(result.status, 1, JSON.stringify(value));
    assert.equal(JSON.parse(result.stderr).code, 'CONTROL_STORAGE_ARGUMENT');
  }
});
