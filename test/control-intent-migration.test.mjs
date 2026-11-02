import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  readdirSync, renameSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlRecordError, createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { completeDeferredStartup } from '../src/core/startup-recovery.mjs';
import { resolveTemporaryMigrationProfile, runLegacyMigration } from '../scripts/b2-control-migrate.mjs';

// Cooperative local-file migration fixtures are deliberately retained, including
// moved originals, failed staging files and child-process barriers. No cleanup.
// Synthetic Host receipts test core validation, not real Host authorization.
const FORMAT = 'dsh-grok-search/control-intent';
const LEGACY_FORMAT = 'dsh-grok-search/legacy-control-intent';
const MAX_BYTES = 1_048_576;
const STORE_URL = new URL('../src/core/control-intent-store.mjs', import.meta.url).href;
const COMMITTED_NAME = /^v\d{12}\.json$/;
const STAGE_NAME = /^stage-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const revisionName = revision => `v${String(revision).padStart(12, '0')}.json`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const legacyIntent = (overrides = {}) => ({
  schemaVersion: 1, policy: 'required', reason: 'historic-authorized-acquisition', release: null, ...overrides,
});
const oldLease = () => ({ pid: 2345, uid: 'historic-owner', entryId: 'web',
  moduleName: '@deepseek-ai/dsh-web', provider: 'dsh-grok-search' });
const newEnvelope = (overrides = {}) => ({ format: FORMAT, schemaVersion: 1, revision: 1,
  operationId: randomUUID(), previousSha256: null, intent: legacyIntent(), ...overrides });
const sourceMarker = (raw, operationId) => ({ format: LEGACY_FORMAT, schemaVersion: 1,
  sourceSha256: sha256(raw), sourceByteLength: raw.length, sourceBase64: raw.toString('base64'),
  operationId, importedAt: '2026-10-20T00:00:00.000Z', authorizationEstablished: false,
  routeChanged: false, historicReleasePreserved: true });

function fixture(t, { raw = encode(legacyIntent()), source = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-migration-test-'));
  const directory = join(root, 'control');
  const legacyPath = join(root, 'legacy-control.json');
  if (source) writeFileSync(legacyPath, raw, { flag: 'wx' });
  t.diagnostic(`Retained fixture: ${root}`);
  const store = createControlIntentStore({ directory, legacyPath });
  const parameters = { expectedRevision: 0, expectedLegacySha256: sha256(raw), operationId: randomUUID() };
  return { root, directory, legacyPath, raw, store, parameters };
}

function names(directory) {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function diskSnapshot(directory) {
  return { exists: existsSync(directory), entries: names(directory).map(name => {
    const path = join(directory, name);
    const entry = lstatSync(path);
    return { name, kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'link',
      bytes: entry.isFile() ? readFileSync(path) : null };
  }) };
}

function expectCode(action, code) {
  let caught;
  assert.throws(action, error => {
    assert.ok(error instanceof ControlRecordError, `Expected ControlRecordError, received ${error?.name}.`);
    assert.equal(error.code, code);
    caught = error;
    return true;
  });
  return caught;
}

async function expectAsyncCode(action, code) {
  let caught;
  await assert.rejects(action, error => {
    assert.ok(error instanceof ControlRecordError);
    assert.equal(error.code, code);
    caught = error;
    return true;
  });
  return caught;
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function assertMigrated(f, result, original, { kind = 'migrated', revision = 1 } = {}) {
  const expected = { kind, recordCommitted: kind === 'migrated', migrationCommitted: true,
    routeChanged: false, authorizationEstablished: false, envelope: result.envelope, originRevision: 1 };
  if (kind === 'already-migrated') expected.resolution = 'same-operation-readback';
  assert.deepEqual(result, expected);
  assertDeepFrozen(result);
  assert.equal(result.envelope.revision, revision);
  const { migration, ...imported } = result.envelope.intent;
  assert.deepEqual(imported, original);
  assert.deepEqual(Object.keys(migration).sort(), Object.keys(sourceMarker(f.raw, f.parameters.operationId)).sort());
  assert.deepEqual(migration, { ...sourceMarker(f.raw, f.parameters.operationId), importedAt: migration.importedAt });
  assert.match(migration.importedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(migration.importedAt).toISOString(), migration.importedAt);
  assert.deepEqual(Buffer.from(migration.sourceBase64, 'base64'), f.raw);
  assert.deepEqual(readFileSync(f.legacyPath), f.raw);
}

function moveSourceAside(f) {
  const retainedPath = join(f.root, `retained-source-${randomUUID()}.json`);
  // Both explicit paths are inside the same freshly created fixture. No deletion.
  renameSync(f.legacyPath, retainedPath);
  assert.deepEqual(readFileSync(retainedPath), f.raw);
  return retainedPath;
}

function changeSource(f) {
  const retainedPath = moveSourceAside(f);
  const changedBytes = Buffer.concat([Buffer.from(' \r\n'), f.raw]);
  writeFileSync(f.legacyPath, changedBytes, { flag: 'wx' });
  return { retainedPath, changedBytes };
}

function assertIncomplete(error, f, recordCommitted) {
  assert.deepEqual(error.migrationOutcome, { kind: 'incomplete', recordCommitted,
    routeChanged: false, authorizationEstablished: false, operationId: f.parameters.operationId,
    expectedLegacySha256: f.parameters.expectedLegacySha256 });
  assertDeepFrozen(error.migrationOutcome);
}

function startChild(source, args) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source, '--', ...args], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { stdout: '', stderr: '', closed: false, spawnError: null };
  child.stdout.setEncoding('utf8').on('data', value => { state.stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { state.stderr += value; });
  const done = new Promise(resolve => {
    child.once('error', error => { state.spawnError = { code: error.code, message: error.message }; });
    child.once('close', (code, signal) => {
      state.closed = true;
      resolve({ code, signal, stdout: state.stdout, stderr: state.stderr, spawnError: state.spawnError });
    });
  });
  return { state, done };
}

const INTERRUPTED_MIGRATION = String.raw`
const [moduleUrl, directory, legacyPath, expectedLegacySha256, operationId, interruptAt] = process.argv.slice(1);
const { createControlIntentStore } = await import(moduleUrl);
const exitCodes = { 'before-publish': 91, 'after-publish': 92 };
const store = createControlIntentStore({ directory, legacyPath, fault(stage) {
  if (stage === interruptAt) process.exit(exitCodes[stage]);
} });
store.migrateLegacy({ expectedRevision: 0, expectedLegacySha256, operationId });
process.stderr.write('The requested migration interruption seam was not reached.\n');
process.exitCode = 1;
`;

const CONTENDING_MIGRATION = String.raw`
import { existsSync, writeFileSync } from 'node:fs';
const [moduleUrl, directory, legacyPath, expectedLegacySha256, operationId, barrierPath, readyPath] = process.argv.slice(1);
const { ControlRecordError, createControlIntentStore } = await import(moduleUrl);
const stages = [];
const waitCell = new Int32Array(new SharedArrayBuffer(4));
try {
  const store = createControlIntentStore({ directory, legacyPath, fault(stage) {
    stages.push(stage);
    if (stage !== 'before-publish') return;
    writeFileSync(readyPath, operationId, { flag: 'wx' });
    const deadline = Date.now() + 15_000;
    while (!existsSync(barrierPath)) {
      if (Date.now() >= deadline) throw new Error('Migration publication barrier timed out.');
      Atomics.wait(waitCell, 0, 0, 10);
    }
  } });
  const result = store.migrateLegacy({ expectedRevision: 0, expectedLegacySha256, operationId });
  process.stdout.write(JSON.stringify({ kind: 'winner', result, stages }) + '\n');
} catch (error) {
  if (!(error instanceof ControlRecordError)) throw error;
  process.stdout.write(JSON.stringify({ kind: 'error', code: error.code, stages }) + '\n');
}
`;

test('legacy inspection is read-only, byte-exact, detached and deeply frozen', t => {
  const original = legacyIntent({ reason: 'historic-\u6d4b\u8bd5', evidence: { nested: { values: [1, false, null] } } });
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  const raw = Buffer.from(' \t\r\n' + JSON.stringify(reordered, null, 3).replaceAll('\n', '\r\n') + '\r\n\t ');
  const f = fixture(t, { raw });
  const before = diskSnapshot(f.directory);
  const inspected = f.store.inspectLegacy();
  assert.deepEqual(inspected, { format: LEGACY_FORMAT, schemaVersion: 1,
    sha256: sha256(raw), byteLength: raw.length, intent: original });
  assertDeepFrozen(inspected);
  assert.throws(() => inspected.intent.evidence.nested.values.push('mutation'), TypeError);
  assert.throws(() => { inspected.intent.policy = 'released'; }, TypeError);
  const reread = f.store.inspectLegacy();
  assert.notStrictEqual(reread, inspected);
  assert.notStrictEqual(reread.intent, inspected.intent);
  assert.deepEqual(reread, inspected);
  assert.deepEqual(readFileSync(f.legacyPath), raw);
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.equal(existsSync(f.directory), false);
});

test('ordinary reads and writes never auto-migrate a legacy source', t => {
  const f = fixture(t);
  const before = diskSnapshot(f.directory);
  expectCode(() => f.store.read(), 'CONTROL_RECORD_MIGRATION_REQUIRED');
  expectCode(() => f.store.compareAndSwap({ expectedRevision: 0, intent: legacyIntent() }), 'CONTROL_RECORD_MIGRATION_REQUIRED');
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.deepEqual(readFileSync(f.legacyPath), f.raw);
  assert.equal(existsSync(f.directory), false);
});

test('explicit migration adds only origin metadata and retains CRLF, whitespace and key order bytes', t => {
  const original = legacyIntent({ lease: oldLease(), acquiredSelection: ['historic-search'],
    recovery: { action: 'historic-observation', facts: [true, null] } });
  const raw = Buffer.from('\t' + JSON.stringify(Object.fromEntries(Object.entries(original).reverse()), null, 2)
    .replaceAll('\n', '\r\n') + '\r\n ');
  const f = fixture(t, { raw });
  const seams = [];
  const store = createControlIntentStore({ directory: f.directory, legacyPath: f.legacyPath, fault(stage, context) {
    seams.push({ stage, ...context });
    assert.equal(context.operationId, f.parameters.operationId);
    assert.equal(context.expectedRevision, 0);
    assert.match(basename(context.stagePath), STAGE_NAME);
    assert.equal(basename(context.targetPath), revisionName(1));
    if (stage === 'before-stage-write') assert.equal(existsSync(context.stagePath), false);
    if (stage === 'before-publish') {
      assert.equal(existsSync(context.targetPath), false);
      const staged = JSON.parse(readFileSync(context.stagePath, 'utf8'));
      assert.deepEqual(Buffer.from(staged.intent.migration.sourceBase64, 'base64'), raw);
    }
    if (stage === 'after-publish') {
      const staged = statSync(context.stagePath, { bigint: true });
      const committed = statSync(context.targetPath, { bigint: true });
      assert.equal(staged.dev, committed.dev);
      assert.equal(staged.ino, committed.ino);
      assert.ok(staged.nlink >= 2n);
      assert.deepEqual(readFileSync(context.stagePath), readFileSync(context.targetPath));
    }
  } });
  const result = store.migrateLegacy(f.parameters);
  assertMigrated(f, result, original);
  assert.equal(result.envelope.format, FORMAT);
  assert.equal(result.envelope.schemaVersion, 1);
  assert.equal(result.envelope.operationId, f.parameters.operationId);
  assert.equal(result.envelope.previousSha256, null);
  assert.equal(Object.hasOwn(result.envelope.intent.lease, 'hostId'), false);
  assert.equal(Object.hasOwn(result.envelope.intent, 'acquisition'), false);
  assert.equal(result.envelope.intent.policy, 'required');
  assert.equal(result.envelope.intent.release, null);
  assert.deepEqual(seams.map(seam => seam.stage), ['before-stage-write', 'before-publish', 'after-publish']);
  assert.deepEqual(store.read(), result.envelope);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, revisionName(1)), 'utf8')), result.envelope);
  assert.equal(names(f.directory).filter(name => STAGE_NAME.test(name)).length, 1);
  assert.deepEqual(names(f.directory).filter(name => COMMITTED_NAME.test(name)), [revisionName(1)]);
});

test('required, historic release, pause and recovery evidence are preserved without fabricated provenance', async t => {
  const prior = legacyIntent({ lease: oldLease() });
  const cases = [
    { name: 'required without ownership lease', intent: legacyIntent() },
    { name: 'required with older lease and selection', intent: legacyIntent({ lease: oldLease(), acquiredSelection: ['historic-search'] }) },
    { name: 'historic explicit release', intent: legacyIntent({ policy: 'released', reason: 'historic release',
      release: { explicit: true, committedAt: '2026-10-19T00:00:00.000Z', evidence: { confirmed: true } } }) },
    { name: 'confirmed pause remains confirmed', intent: legacyIntent({ pause: { confirmed: true, reason: 'historic user pause' } }) },
    { name: 'historic startup correction evidence remains released', intent: legacyIntent({ policy: 'released', priorIntent: prior,
      recovery: { action: 'startup-state-correction', originalLease: oldLease(), historicReleaseCommitted: false,
        routeVerified: true, routeChanged: false, retained: { original: true } } }) },
  ];
  for (const entry of cases) await t.test(entry.name, sub => {
    const f = fixture(sub, { raw: encode(entry.intent) });
    const result = f.store.migrateLegacy(f.parameters);
    assertMigrated(f, result, entry.intent);
    for (const key of ['lease', 'acquisition', 'release', 'pause', 'recovery', 'priorIntent']) {
      assert.equal(Object.hasOwn(result.envelope.intent, key), Object.hasOwn(entry.intent, key));
    }
    if (entry.intent.lease) assert.equal(Object.hasOwn(result.envelope.intent.lease, 'hostId'), false);
    assert.equal(result.envelope.intent.policy, entry.intent.policy);
  });
});

test('migration requires an explicit operation token, inspected hash and initial revision', async t => {
  const cases = [
    { name: 'no arguments', parameters: () => undefined },
    { name: 'missing operation token', parameters: f => ({ expectedRevision: 0, expectedLegacySha256: f.parameters.expectedLegacySha256 }) },
    { name: 'invalid operation token', parameters: f => ({ ...f.parameters, operationId: 'not-a-uuid' }) },
    { name: 'missing source digest', parameters: f => ({ expectedRevision: 0, operationId: f.parameters.operationId }) },
    { name: 'invalid source digest', parameters: f => ({ ...f.parameters, expectedLegacySha256: 'not-a-digest' }) },
    { name: 'missing initial revision', parameters: f => ({ expectedLegacySha256: f.parameters.expectedLegacySha256, operationId: f.parameters.operationId }) },
    { name: 'negative initial revision', parameters: f => ({ ...f.parameters, expectedRevision: -1 }) },
    { name: 'noninteger initial revision', parameters: f => ({ ...f.parameters, expectedRevision: 0.5 }) },
    { name: 'string initial revision', parameters: f => ({ ...f.parameters, expectedRevision: '0' }) },
    { name: 'nonzero revision is not migration approval', code: 'CONTROL_CAS_CONFLICT', parameters: f => ({ ...f.parameters, expectedRevision: 1 }) },
  ];
  for (const entry of cases) await t.test(entry.name, sub => {
    const f = fixture(sub);
    const before = diskSnapshot(f.directory);
    expectCode(() => f.store.migrateLegacy(entry.parameters(f)), entry.code ?? 'CONTROL_RECORD_INVALID');
    assert.deepEqual(diskSnapshot(f.directory), before);
    assert.deepEqual(readFileSync(f.legacyPath), f.raw);
  });
});

test('missing source or no configured source path cannot establish migration approval', async t => {
  for (const configured of [true, false]) await t.test(`configured legacyPath ${configured}`, sub => {
    const f = fixture(sub, { source: false });
    const store = configured ? f.store : createControlIntentStore({ directory: f.directory });
    const before = diskSnapshot(f.directory);
    expectCode(() => store.inspectLegacy(), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    expectCode(() => store.migrateLegacy(f.parameters), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    assert.deepEqual(diskSnapshot(f.directory), before);
    assert.equal(existsSync(f.legacyPath), false);
  });
});

test('a stale inspected SHA rejects even byte changes that preserve the original JSON data', t => {
  const f = fixture(t);
  const change = changeSource(f);
  const before = diskSnapshot(f.directory);
  const inspected = f.store.inspectLegacy();
  assert.deepEqual(inspected.intent, JSON.parse(f.raw.toString('utf8')));
  assert.equal(inspected.sha256, sha256(change.changedBytes));
  const error = expectCode(() => f.store.migrateLegacy(f.parameters), 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED');
  assert.deepEqual(error.details, { expectedSha256: f.parameters.expectedLegacySha256, actualSha256: sha256(change.changedBytes) });
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.deepEqual(readFileSync(change.retainedPath), f.raw);
  assert.deepEqual(readFileSync(f.legacyPath), change.changedBytes);
});

test('ambiguous, incorrectly encoded, malformed and unsupported legacy sources preserve raw bytes and fail closed', async t => {
  const base = '{"schemaVersion":1,"policy":"required","reason":"historic","release":null';
  const cases = [
    { name: 'empty file', raw: Buffer.alloc(0) },
    { name: 'damaged JSON', raw: Buffer.from('{ interrupted original\r\n') },
    { name: 'invalid UTF-8', raw: Buffer.concat([Buffer.from(base + ',"evidence":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]) },
    { name: 'UTF-8 BOM', raw: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encode(legacyIntent())]) },
    { name: 'duplicate top-level policy', raw: Buffer.from(base + ',"policy":"released"}') },
    { name: 'duplicate top-level release', raw: Buffer.from(base + ',"release":{"explicit":true,"committedAt":"2026-10-19T00:00:00.000Z"}}') },
    { name: 'duplicate key with equal values is still ambiguous', raw: Buffer.from(base + ',"schemaVersion":1}') },
    { name: 'nested duplicate release evidence', raw: Buffer.from('{"schemaVersion":1,"policy":"released","reason":"historic","release":{"explicit":false,"explicit":true,"committedAt":"2026-10-19T00:00:00.000Z"}}') },
    { name: 'escaped duplicate top-level key', raw: Buffer.from(base + String.raw`,"pol\u0069cy":"required"}`) },
    { name: 'escaped duplicate nested key', raw: Buffer.from(base + String.raw`,"pause":{"confirmed":false,"confi\u0072med":true}}`) },
    { name: 'very deeply nested source', raw: Buffer.from(base + ',"evidence":' + '['.repeat(4096) + 'null' + ']'.repeat(4096) + '}') },
    { name: 'unsupported legacy schema', code: 'CONTROL_RECORD_VERSION_UNSUPPORTED', raw: encode(legacyIntent({ schemaVersion: 2 })) },
    { name: 'unknown policy', raw: encode(legacyIntent({ policy: 'unknown' })) },
    { name: 'missing release field', raw: Buffer.from('{"schemaVersion":1,"policy":"required","reason":"historic"}') },
    { name: 'invalid older lease', raw: encode(legacyIntent({ lease: { ...oldLease(), pid: 0 } })) },
    { name: 'nonexplicit historic release', raw: encode(legacyIntent({ policy: 'released', release: { explicit: false, committedAt: '2026-10-19T00:00:00.000Z' } })) },
    { name: 'reserved migration field, even null', raw: encode(legacyIntent({ migration: null })) },
    { name: 'reserved migration rejects before recursively validating unknown marker schema', raw: encode(legacyIntent({ migration: { schemaVersion: 999, migration: { schemaVersion: 999 } } })) },
    { name: 'array is not a control intent', raw: Buffer.from('[]') },
    { name: 'null is not a control intent', raw: Buffer.from('null') },
    { name: 'oversized raw source', raw: Buffer.alloc(MAX_BYTES + 1, 0x78) },
  ];
  for (const entry of cases) await t.test(entry.name, sub => {
    const f = fixture(sub, { raw: entry.raw });
    const before = diskSnapshot(f.directory);
    const code = entry.code ?? 'CONTROL_RECORD_INVALID';
    expectCode(() => f.store.inspectLegacy(), code);
    expectCode(() => f.store.migrateLegacy(f.parameters), code);
    assert.deepEqual(readFileSync(f.legacyPath), entry.raw);
    assert.deepEqual(diskSnapshot(f.directory), before);
    assert.equal(existsSync(join(f.directory, revisionName(1))), false);
  });
});

test('equal key names in different objects and escaped string values are not false duplicate keys', t => {
  const original = legacyIntent({ evidence: { first: { value: 'quoted "key" and \\ slash' }, second: { value: 'different scope' } } });
  const f = fixture(t, { raw: encode(original) });
  assert.deepEqual(f.store.inspectLegacy().intent, original);
  assertMigrated(f, f.store.migrateLegacy(f.parameters), original);
});

test('a source directory is rejected rather than interpreted or modified as legacy evidence', t => {
  const f = fixture(t, { source: false });
  mkdirSync(f.legacyPath);
  const before = diskSnapshot(f.root);
  expectCode(() => f.store.inspectLegacy(), 'CONTROL_RECORD_INVALID');
  expectCode(() => f.store.migrateLegacy(f.parameters), 'CONTROL_RECORD_INVALID');
  assert.deepEqual(diskSnapshot(f.root), before);
});

test('a valid source under 1 MiB whose migrated envelope exceeds 1 MiB fails before staging', t => {
  const original = legacyIntent({ reason: 'x'.repeat(600_000) });
  const f = fixture(t, { raw: encode(original) });
  assert.ok(f.raw.length < MAX_BYTES);
  assert.deepEqual(f.store.inspectLegacy().intent, original);
  let faultCalls = 0;
  const store = createControlIntentStore({ directory: f.directory, legacyPath: f.legacyPath,
    fault() { faultCalls++; assert.fail('Oversized migrated envelope must fail before staging.'); } });
  const before = diskSnapshot(f.directory);
  const error = expectCode(() => store.migrateLegacy(f.parameters), 'CONTROL_RECORD_INVALID');
  assertIncomplete(error, f, false);
  assert.equal(faultCalls, 0);
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.equal(existsSync(f.directory), false);
  assert.deepEqual(readFileSync(f.legacyPath), f.raw);
});

test('same-operation retry resolves the origin and reports an advanced current head without another commit', t => {
  const f = fixture(t);
  const original = JSON.parse(f.raw.toString('utf8'));
  const first = f.store.migrateLegacy(f.parameters);
  assertMigrated(f, first, original);
  const afterFirst = diskSnapshot(f.directory);
  const retry = f.store.migrateLegacy(f.parameters);
  assertMigrated(f, retry, original, { kind: 'already-migrated' });
  assert.deepEqual(retry.envelope, first.envelope);
  assert.deepEqual(diskSnapshot(f.directory), afterFirst);
  const originBytes = readFileSync(join(f.directory, revisionName(1)));
  const currentIntent = { ...first.envelope.intent, reason: 'later working state', pause: { confirmed: true } };
  const current = f.store.compareAndSwap({ expectedRevision: 1, intent: currentIntent });
  assert.equal(current.revision, 2);
  assert.equal(current.previousSha256, sha256(originBytes));
  assert.deepEqual(current.intent.migration, first.envelope.intent.migration);
  const afterAdvance = diskSnapshot(f.directory);
  const replay = f.store.migrateLegacy(f.parameters);
  const { migration: _migration, ...currentData } = currentIntent;
  assertMigrated(f, replay, currentData, { kind: 'already-migrated', revision: 2 });
  assert.deepEqual(replay.envelope, current);
  assert.equal(replay.originRevision, 1);
  assert.deepEqual(diskSnapshot(f.directory), afterAdvance);
  expectCode(() => f.store.migrateLegacy({ ...f.parameters, operationId: randomUUID() }), 'CONTROL_CAS_CONFLICT');
  assert.deepEqual(diskSnapshot(f.directory), afterAdvance);
  assert.deepEqual(readFileSync(join(f.directory, revisionName(1))), originBytes);
  assert.equal(existsSync(join(f.directory, revisionName(3))), false);
});

test('a different migration operation never silently reuses an existing migrated source', t => {
  const f = fixture(t);
  const first = f.store.migrateLegacy(f.parameters);
  const before = diskSnapshot(f.directory);
  const error = expectCode(() => f.store.migrateLegacy({ ...f.parameters, operationId: randomUUID() }), 'CONTROL_CAS_CONFLICT');
  assert.equal(error.details.actualRevision, 1);
  assert.deepEqual(f.store.read(), first.envelope);
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.deepEqual(readFileSync(f.legacyPath), f.raw);
});

test('ordinary CAS cannot introduce, drop or alter migration metadata', async t => {
  await t.test('only migrateLegacy may introduce origin metadata', sub => {
    const f = fixture(sub, { source: false });
    const normal = createControlIntentStore({ directory: f.directory });
    const before = diskSnapshot(f.directory);
    const intent = { ...legacyIntent(), migration: sourceMarker(f.raw, f.parameters.operationId) };
    expectCode(() => normal.compareAndSwap({ expectedRevision: 0, intent }), 'CONTROL_RECORD_INVALID');
    assert.deepEqual(diskSnapshot(f.directory), before);
  });
  const changes = [
    { name: 'drop marker', change: intent => { delete intent.migration; } },
    { name: 'null marker', change: intent => { intent.migration = null; } },
    { name: 'change origin token', change: intent => { intent.migration.operationId = randomUUID(); } },
    { name: 'change source digest', change: intent => { intent.migration.sourceSha256 = '0'.repeat(64); } },
    { name: 'change imported timestamp', change: intent => { intent.migration.importedAt = '2026-10-21T00:00:00.000Z'; } },
    { name: 'claim authorization', change: intent => { intent.migration.authorizationEstablished = true; } },
    { name: 'add unknown marker field', change: intent => { intent.migration.extra = 'not the original marker'; } },
  ];
  for (const entry of changes) await t.test(entry.name, sub => {
    const f = fixture(sub);
    const committed = f.store.migrateLegacy(f.parameters).envelope;
    const intent = structuredClone(committed.intent);
    entry.change(intent);
    const before = diskSnapshot(f.directory);
    expectCode(() => f.store.compareAndSwap({ expectedRevision: 1, intent }), 'CONTROL_RECORD_INVALID');
    assert.deepEqual(diskSnapshot(f.directory), before);
    assert.deepEqual(f.store.read(), committed);
    assert.deepEqual(readFileSync(f.legacyPath), f.raw);
  });
});

test('any valid preexisting non-migrated versioned history blocks migration instead of replacing or merging', async t => {
  const cases = [
    { name: 'existing required revision', files: () => [[revisionName(1), encode(newEnvelope())]] },
    { name: 'existing released revision', files: () => [[revisionName(1), encode(newEnvelope({ intent: legacyIntent({ policy: 'released' }) }))]] },
    { name: 'existing history with an advanced head', files: () => {
      const first = encode(newEnvelope());
      return [[revisionName(1), first], [revisionName(2), encode(newEnvelope({ revision: 2, previousSha256: sha256(first) }))]];
    } },
  ];
  for (const entry of cases) await t.test(entry.name, sub => {
    const f = fixture(sub);
    mkdirSync(f.directory);
    for (const [name, bytes] of entry.files()) writeFileSync(join(f.directory, name), bytes, { flag: 'wx' });
    const before = diskSnapshot(f.directory);
    expectCode(() => f.store.read(), 'CONTROL_RECORD_MIGRATION_REQUIRED');
    expectCode(() => f.store.compareAndSwap({ expectedRevision: 1, intent: legacyIntent() }), 'CONTROL_RECORD_MIGRATION_REQUIRED');
    expectCode(() => f.store.migrateLegacy(f.parameters), 'CONTROL_CAS_CONFLICT');
    assert.deepEqual(diskSnapshot(f.directory), before);
    assert.deepEqual(readFileSync(f.legacyPath), f.raw);
    assert.equal(names(f.directory).filter(name => STAGE_NAME.test(name)).length, 0);
  });
});

test('malformed or unknown-version destination history fails closed with every existing byte retained', async t => {
  const cases = [
    { name: 'damaged committed JSON', files: () => [[revisionName(1), Buffer.from('{ interrupted new history\n')]] },
    { name: 'unknown new format', files: () => [[revisionName(1), encode(newEnvelope({ format: 'unknown/control-intent' }))]] },
    { name: 'unsupported envelope schema', code: 'CONTROL_RECORD_VERSION_UNSUPPORTED', files: () => [[revisionName(1), encode(newEnvelope({ schemaVersion: 2 }))]] },
    { name: 'unsupported intent schema', code: 'CONTROL_RECORD_VERSION_UNSUPPORTED', files: () => [[revisionName(1), encode(newEnvelope({ intent: legacyIntent({ schemaVersion: 2 }) }))]] },
    { name: 'missing first revision', files: () => [[revisionName(2), encode(newEnvelope({ revision: 2 }))]] },
    { name: 'malformed version filename', files: () => [['v1.json', encode(newEnvelope())]] },
    { name: 'invalid historic policy in destination', files: () => [[revisionName(1), encode(newEnvelope({ intent: legacyIntent({ policy: 'unknown' }) }))]] },
    { name: 'duplicate destination revision key', files: () => {
      const text = JSON.stringify(newEnvelope());
      return [[revisionName(1), Buffer.from(text.slice(0, -1) + ',"revision":1}')]];
    } },
  ];
  for (const entry of cases) await t.test(entry.name, sub => {
    const f = fixture(sub);
    mkdirSync(f.directory);
    for (const [name, bytes] of entry.files()) writeFileSync(join(f.directory, name), bytes, { flag: 'wx' });
    const before = diskSnapshot(f.directory);
    const code = entry.code ?? 'CONTROL_RECORD_INVALID';
    expectCode(() => f.store.migrateLegacy(f.parameters), code);
    expectCode(() => f.store.read(), code);
    assert.deepEqual(diskSnapshot(f.directory), before);
    assert.deepEqual(readFileSync(f.legacyPath), f.raw);
  });
});

test('the first migration marker must match original intent, source bytes and the origin operation', async t => {
  const cases = [
    { name: 'origin silently changes policy', change: record => { record.intent.policy = 'released'; } },
    { name: 'origin fabricates Host provenance', change: record => { record.intent.acquisition = { source: 'fabricated' }; } },
    { name: 'origin operation differs from marker', change: record => { record.operationId = randomUUID(); } },
    { name: 'marker raw bytes are not the recorded source', change: record => { record.intent.migration.sourceBase64 = Buffer.from('different').toString('base64'); } },
    { name: 'marker source byte length is wrong', change: record => { record.intent.migration.sourceByteLength++; } },
    { name: 'marker claims authorization', change: record => { record.intent.migration.authorizationEstablished = true; } },
    { name: 'unknown marker schema', code: 'CONTROL_RECORD_VERSION_UNSUPPORTED', change: record => { record.intent.migration.schemaVersion = 2; } },
  ];
  for (const entry of cases) await t.test(entry.name, sub => {
    const f = fixture(sub);
    const record = newEnvelope({ operationId: f.parameters.operationId,
      intent: { ...legacyIntent(), migration: sourceMarker(f.raw, f.parameters.operationId) } });
    entry.change(record);
    mkdirSync(f.directory);
    writeFileSync(join(f.directory, revisionName(1)), encode(record), { flag: 'wx' });
    const before = diskSnapshot(f.directory);
    const code = entry.code ?? 'CONTROL_RECORD_INVALID';
    expectCode(() => f.store.read(), code);
    expectCode(() => f.store.migrateLegacy(f.parameters), code);
    expectCode(() => f.store.compareAndSwap({ expectedRevision: 1, intent: record.intent }), code);
    assert.deepEqual(diskSnapshot(f.directory), before);
    assert.deepEqual(readFileSync(f.legacyPath), f.raw);
  });
});

test('later disk revisions cannot discard or alter the origin marker even with a valid hash chain', async t => {
  for (const kind of ['dropped', 'altered']) await t.test(kind, sub => {
    const f = fixture(sub);
    const first = f.store.migrateLegacy(f.parameters).envelope;
    const originBytes = readFileSync(join(f.directory, revisionName(1)));
    const intent = structuredClone(first.intent);
    if (kind === 'dropped') delete intent.migration;
    else intent.migration.importedAt = '2026-10-21T00:00:00.000Z';
    const second = newEnvelope({ revision: 2, previousSha256: sha256(originBytes), intent });
    writeFileSync(join(f.directory, revisionName(2)), encode(second), { flag: 'wx' });
    const before = diskSnapshot(f.directory);
    expectCode(() => f.store.read(), 'CONTROL_RECORD_INVALID');
    expectCode(() => f.store.migrateLegacy(f.parameters), 'CONTROL_RECORD_INVALID');
    expectCode(() => f.store.compareAndSwap({ expectedRevision: 2, intent: first.intent }), 'CONTROL_RECORD_INVALID');
    assert.deepEqual(diskSnapshot(f.directory), before);
    assert.deepEqual(readFileSync(join(f.directory, revisionName(1))), originBytes);
    assert.deepEqual(readFileSync(f.legacyPath), f.raw);
  });
});

test('a migrated source moved aside is still required and cannot be bypassed by omitting legacyPath', t => {
  const f = fixture(t);
  const first = f.store.migrateLegacy(f.parameters).envelope;
  const retainedPath = moveSourceAside(f);
  const before = diskSnapshot(f.directory);
  const withoutSourcePath = createControlIntentStore({ directory: f.directory });
  for (const store of [f.store, withoutSourcePath]) {
    expectCode(() => store.inspectLegacy(), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    expectCode(() => store.read(), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    expectCode(() => store.migrateLegacy(f.parameters), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    expectCode(() => store.compareAndSwap({ expectedRevision: 1, intent: first.intent }), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
  }
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.deepEqual(readFileSync(retainedPath), f.raw);
  assert.equal(existsSync(f.legacyPath), false);
});

test('omitting legacyPath cannot bypass a migrated origin even when its source still exists', t => {
  const f = fixture(t);
  const first = f.store.migrateLegacy(f.parameters).envelope;
  const withoutSourcePath = createControlIntentStore({ directory: f.directory });
  const before = diskSnapshot(f.directory);
  expectCode(() => withoutSourcePath.read(), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
  expectCode(() => withoutSourcePath.compareAndSwap({ expectedRevision: 1, intent: first.intent }), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
  expectCode(() => withoutSourcePath.migrateLegacy(f.parameters), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
  assert.deepEqual(f.store.read(), first);
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.deepEqual(readFileSync(f.legacyPath), f.raw);
});

test('changed source bytes after migration stop reads, retries and subsequent writes without reconciliation', t => {
  const f = fixture(t);
  const first = f.store.migrateLegacy(f.parameters).envelope;
  const change = changeSource(f);
  const before = diskSnapshot(f.directory);
  expectCode(() => f.store.read(), 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED');
  expectCode(() => f.store.migrateLegacy(f.parameters), 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED');
  expectCode(() => f.store.compareAndSwap({ expectedRevision: 1, intent: first.intent }), 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED');
  assert.deepEqual(f.store.inspectLegacy().intent, legacyIntent());
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.deepEqual(readFileSync(change.retainedPath), f.raw);
  assert.deepEqual(readFileSync(f.legacyPath), change.changedBytes);
  assert.deepEqual(Buffer.from(first.intent.migration.sourceBase64, 'base64'), f.raw);
});

test('migrating older required state without Host provenance cannot release it through startup correction', async t => {
  const original = legacyIntent({ lease: oldLease(), acquiredSelection: ['test-search-bundle'] });
  const f = fixture(t, { raw: encode(original) });
  const migrated = f.store.migrateLegacy(f.parameters).envelope;
  const before = diskSnapshot(f.directory);
  let observerCalls = 0, routeCalls = 0;
  await expectAsyncCode(() => completeDeferredStartup({
    store: { read: () => f.store.read(), compareAndSwap() { assert.fail('Migration supplies no new authorization to write startup correction.'); } },
    observe: async () => {
      observerCalls++;
      return { hostId: '00000000-0000-4000-8000-000000000011', observedAt: '2026-10-20T00:00:00.000Z',
        selectionSha256: 'b'.repeat(64), selectedBundles: ['test-recovery-bundle'], searchBundle: 'test-search-bundle',
        recoveryBundle: 'test-recovery-bundle', authorSearchProvider: 'author-provider',
        component: { role: 'recovery', bundle: 'test-recovery-bundle', ownerUid: 'recovery-owner',
          loadId: '00000000-0000-4000-8000-000000000012', legalLoad: true } };
    },
    verifyRoute: async () => { routeCalls++; assert.fail('Missing provenance must be refused before route work.'); },
  }), 'CONTROL_RECOVERY_PROVENANCE_REQUIRED');
  assert.equal(observerCalls, 1);
  assert.equal(routeCalls, 0);
  assert.deepEqual(f.store.read(), migrated);
  assert.equal(migrated.intent.policy, 'required');
  assert.equal(migrated.intent.release, null);
  assert.equal(Object.hasOwn(migrated.intent.lease, 'hostId'), false);
  assert.equal(Object.hasOwn(migrated.intent, 'acquisition'), false);
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.deepEqual(readFileSync(f.legacyPath), f.raw);
});

test('injected migration seam failures distinguish no publication from a committed-but-uncertain record', async t => {
  for (const interruptAt of ['before-stage-write', 'before-publish', 'after-publish']) await t.test(interruptAt, sub => {
    const f = fixture(sub);
    let context;
    const store = createControlIntentStore({ directory: f.directory, legacyPath: f.legacyPath, fault(stage, details) {
      if (stage !== interruptAt) return;
      context = details;
      const error = new Error('Injected migration write interruption.');
      error.code = 'E_TEST_MIGRATION_WRITE';
      throw error;
    } });
    const published = interruptAt === 'after-publish';
    const error = expectCode(() => store.migrateLegacy(f.parameters), published
      ? 'CONTROL_RECORD_COMMIT_UNCERTAIN' : 'CONTROL_RECORD_WRITE_FAILED');
    assertIncomplete(error, f, published ? null : false);
    assert.deepEqual(error.details, { expectedRevision: 0, attemptedRevision: 1,
      operationId: f.parameters.operationId, published, causeCode: 'E_TEST_MIGRATION_WRITE' });
    assert.equal(existsSync(context.targetPath), published);
    assert.equal(existsSync(context.stagePath), interruptAt !== 'before-stage-write');
    assert.deepEqual(readFileSync(f.legacyPath), f.raw);
    let stagedBytes;
    if (interruptAt === 'before-stage-write') assert.deepEqual(names(f.directory), []);
    else {
      stagedBytes = readFileSync(context.stagePath);
      const staged = JSON.parse(stagedBytes.toString('utf8'));
      assert.equal(staged.operationId, f.parameters.operationId);
      assert.deepEqual(Buffer.from(staged.intent.migration.sourceBase64, 'base64'), f.raw);
      if (published) assert.deepEqual(readFileSync(context.targetPath), stagedBytes);
    }
    const beforeRetry = diskSnapshot(f.directory);
    if (published) assert.equal(f.store.read().operationId, f.parameters.operationId);
    else expectCode(() => f.store.read(), 'CONTROL_RECORD_MIGRATION_REQUIRED');
    const resolved = f.store.migrateLegacy(f.parameters);
    assertMigrated(f, resolved, legacyIntent(), { kind: published ? 'already-migrated' : 'migrated' });
    if (published) assert.deepEqual(diskSnapshot(f.directory), beforeRetry);
    if (stagedBytes) assert.deepEqual(readFileSync(context.stagePath), stagedBytes);
    assert.equal(names(f.directory).filter(name => STAGE_NAME.test(name)).length, interruptAt === 'before-publish' ? 2 : 1);
    assert.deepEqual(names(f.directory).filter(name => COMMITTED_NAME.test(name)), [revisionName(1)]);
  });
});

test('migration rechecks source bytes after every publication fault hook', async t => {
  for (const changeAt of ['before-stage-write', 'before-publish', 'after-publish']) await t.test(changeAt, sub => {
    const f = fixture(sub);
    let change, context;
    const store = createControlIntentStore({ directory: f.directory, legacyPath: f.legacyPath, fault(stage, details) {
      if (stage !== changeAt) return;
      context = details;
      change = changeSource(f);
    } });
    const published = changeAt === 'after-publish';
    const error = expectCode(() => store.migrateLegacy(f.parameters), published
      ? 'CONTROL_RECORD_COMMIT_UNCERTAIN' : 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED');
    assertIncomplete(error, f, published ? null : false);
    if (published) {
      assert.equal(error.details.published, true);
      assert.equal(error.details.causeCode, 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED');
    } else assert.deepEqual(error.details, { expectedSha256: f.parameters.expectedLegacySha256, actualSha256: sha256(change.changedBytes) });
    assert.equal(existsSync(context.targetPath), published);
    assert.equal(existsSync(context.stagePath), changeAt !== 'before-stage-write');
    assert.deepEqual(readFileSync(change.retainedPath), f.raw);
    assert.deepEqual(readFileSync(f.legacyPath), change.changedBytes);
    if (changeAt !== 'before-stage-write') {
      const stage = JSON.parse(readFileSync(context.stagePath, 'utf8'));
      assert.deepEqual(Buffer.from(stage.intent.migration.sourceBase64, 'base64'), f.raw);
    }
    const final = diskSnapshot(f.directory);
    expectCode(() => f.store.migrateLegacy(f.parameters), 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED');
    if (published) {
      expectCode(() => f.store.read(), 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED');
      const committed = JSON.parse(readFileSync(context.targetPath, 'utf8'));
      expectCode(() => f.store.compareAndSwap({ expectedRevision: 1, intent: committed.intent }), 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED');
      assert.deepEqual(readFileSync(context.targetPath), readFileSync(context.stagePath));
    } else expectCode(() => f.store.read(), 'CONTROL_RECORD_MIGRATION_REQUIRED');
    assert.deepEqual(diskSnapshot(f.directory), final);
  });
});

test('source loss at a fault hook retains the moved evidence and cannot publish or be silently reused', async t => {
  for (const moveAt of ['before-stage-write', 'before-publish', 'after-publish']) await t.test(moveAt, sub => {
    const f = fixture(sub);
    let retainedPath, context;
    const store = createControlIntentStore({ directory: f.directory, legacyPath: f.legacyPath, fault(stage, details) {
      if (stage !== moveAt) return;
      context = details;
      retainedPath = moveSourceAside(f);
    } });
    const published = moveAt === 'after-publish';
    const error = expectCode(() => store.migrateLegacy(f.parameters), published
      ? 'CONTROL_RECORD_COMMIT_UNCERTAIN' : 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    assertIncomplete(error, f, published ? null : false);
    if (published) assert.equal(error.details.causeCode, 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    assert.equal(existsSync(context.targetPath), published);
    assert.equal(existsSync(context.stagePath), moveAt !== 'before-stage-write');
    assert.deepEqual(readFileSync(retainedPath), f.raw);
    const final = diskSnapshot(f.directory);
    expectCode(() => f.store.migrateLegacy(f.parameters), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    if (published) expectCode(() => f.store.read(), 'CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    else assert.equal(f.store.read(), null);
    assert.deepEqual(diskSnapshot(f.directory), final);
  });
});

test('real staging path collisions and open errors do not overwrite evidence or publish a revision', async t => {
  for (const kind of ['file', 'directory']) await t.test(kind, sub => {
    const f = fixture(sub);
    const collisionBytes = Buffer.from('preexisting staging collision evidence\n');
    let context;
    const store = createControlIntentStore({ directory: f.directory, legacyPath: f.legacyPath, fault(stage, details) {
      if (stage !== 'before-stage-write') return;
      context = details;
      if (kind === 'file') writeFileSync(context.stagePath, collisionBytes, { flag: 'wx' });
      else mkdirSync(context.stagePath);
    } });
    const error = expectCode(() => store.migrateLegacy(f.parameters), 'CONTROL_RECORD_WRITE_FAILED');
    assertIncomplete(error, f, false);
    assert.equal(error.details.published, false);
    assert.match(error.details.causeCode, /^E(EXIST|ISDIR|PERM|ACCES)$/);
    assert.equal(existsSync(context.targetPath), false);
    if (kind === 'file') assert.deepEqual(readFileSync(context.stagePath), collisionBytes);
    else assert.ok(lstatSync(context.stagePath).isDirectory());
    assert.deepEqual(readFileSync(f.legacyPath), f.raw);
    const retried = f.store.migrateLegacy(f.parameters);
    assertMigrated(f, retried, legacyIntent());
    assert.equal(names(f.directory).filter(name => STAGE_NAME.test(name)).length, 2);
    if (kind === 'file') assert.deepEqual(readFileSync(context.stagePath), collisionBytes);
    else assert.ok(lstatSync(context.stagePath).isDirectory());
  });
});

test('a non-migrated revision appearing after the snapshot wins publication and is never merged', t => {
  const f = fixture(t);
  let winner, context;
  const store = createControlIntentStore({ directory: f.directory, legacyPath: f.legacyPath, fault(stage, details) {
    if (stage !== 'before-publish') return;
    context = details;
    winner = createControlIntentStore({ directory: f.directory }).compareAndSwap({ expectedRevision: 0,
      intent: legacyIntent({ reason: 'competing versioned record' }) });
  } });
  const error = expectCode(() => store.migrateLegacy(f.parameters), 'CONTROL_CAS_CONFLICT');
  assertIncomplete(error, f, false);
  assert.equal(Object.hasOwn(winner.intent, 'migration'), false);
  const winnerBytes = readFileSync(context.targetPath);
  assert.deepEqual(JSON.parse(winnerBytes.toString('utf8')), winner);
  assert.notEqual(winner.operationId, f.parameters.operationId);
  assert.equal(existsSync(context.stagePath), true);
  assert.equal(names(f.directory).filter(name => STAGE_NAME.test(name)).length, 2);
  const final = diskSnapshot(f.directory);
  expectCode(() => f.store.read(), 'CONTROL_RECORD_MIGRATION_REQUIRED');
  expectCode(() => f.store.migrateLegacy(f.parameters), 'CONTROL_CAS_CONFLICT');
  assert.deepEqual(diskSnapshot(f.directory), final);
  assert.deepEqual(readFileSync(context.targetPath), winnerBytes);
  assert.deepEqual(readFileSync(f.legacyPath), f.raw);
});

test('post-publication readback failure is uncertain and keeps the original committed candidate evidence', t => {
  const f = fixture(t);
  const damaged = Buffer.from('{ damaged readback\n');
  let retainedPath, context;
  const store = createControlIntentStore({ directory: f.directory, legacyPath: f.legacyPath, fault(stage, details) {
    if (stage !== 'after-publish') return;
    context = details;
    retainedPath = join(f.root, 'retained-published-candidate.json');
    renameSync(context.targetPath, retainedPath);
    writeFileSync(context.targetPath, damaged, { flag: 'wx' });
  } });
  const error = expectCode(() => store.migrateLegacy(f.parameters), 'CONTROL_RECORD_COMMIT_UNCERTAIN');
  assertIncomplete(error, f, null);
  assert.equal(error.details.causeCode, 'CONTROL_RECORD_INVALID');
  assert.equal(error.details.published, true);
  assert.deepEqual(readFileSync(retainedPath), readFileSync(context.stagePath));
  assert.equal(JSON.parse(readFileSync(retainedPath, 'utf8')).operationId, f.parameters.operationId);
  assert.deepEqual(readFileSync(context.targetPath), damaged);
  assert.deepEqual(readFileSync(f.legacyPath), f.raw);
  const final = diskSnapshot(f.directory);
  expectCode(() => f.store.read(), 'CONTROL_RECORD_INVALID');
  expectCode(() => f.store.migrateLegacy(f.parameters), 'CONTROL_RECORD_INVALID');
  assert.deepEqual(diskSnapshot(f.directory), final);
});

test('competing migration processes with different explicit tokens have exactly one publication winner',
  { timeout: 45_000 }, async t => {
    const f = fixture(t);
    const barrierPath = join(f.root, 'migration-publication.ready');
    const workers = ['migrator-a', 'migrator-b'].map(label => {
      const operationId = randomUUID();
      const readyPath = join(f.root, `${label}.ready`);
      return { operationId, readyPath, ...startChild(CONTENDING_MIGRATION, [STORE_URL, f.directory,
        f.legacyPath, f.parameters.expectedLegacySha256, operationId, barrierPath, readyPath]) };
    });
    let barrierError;
    try {
      const deadline = Date.now() + 15_000;
      while (!workers.every(worker => existsSync(worker.readyPath))) {
        if (workers.some(worker => worker.state.closed)) throw new Error('A migration process exited before both reached publication.');
        if (Date.now() >= deadline) throw new Error('Both migration processes did not reach the publication barrier.');
        await delay(10);
      }
    } catch (error) {
      barrierError = error;
    } finally {
      // Release both cooperative children even on an assertion failure. Keep all files.
      writeFileSync(barrierPath, 'publish\n', { flag: 'wx' });
    }
    const childResults = await Promise.all(workers.map(worker => worker.done));
    if (barrierError) {
      t.diagnostic(JSON.stringify(childResults));
      throw barrierError;
    }
    const results = childResults.map(result => {
      assert.equal(result.spawnError, null);
      assert.equal(result.signal, null);
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout.trim());
    });
    const winners = results.filter(result => result.kind === 'winner');
    const losers = results.filter(result => result.kind === 'error');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].code, 'CONTROL_CAS_CONFLICT');
    assert.deepEqual(winners[0].stages, ['before-stage-write', 'before-publish', 'after-publish']);
    assert.deepEqual(losers[0].stages, ['before-stage-write', 'before-publish']);
    const winner = winners[0].result;
    assert.equal(winner.kind, 'migrated');
    assert.equal(winner.recordCommitted, true);
    assert.equal(winner.migrationCommitted, true);
    assert.equal(winner.authorizationEstablished, false);
    assert.equal(winner.routeChanged, false);
    assert.equal(winner.envelope.revision, 1);
    assert.ok(workers.some(worker => worker.operationId === winner.envelope.operationId));
    assert.deepEqual(f.store.read(), winner.envelope);
    assert.deepEqual(readFileSync(f.legacyPath), f.raw);
    assert.deepEqual(names(f.directory).filter(name => COMMITTED_NAME.test(name)), [revisionName(1)]);
    assert.equal(names(f.directory).filter(name => STAGE_NAME.test(name)).length, 2);
    const final = diskSnapshot(f.directory);
    const winnerRetry = f.store.migrateLegacy({ ...f.parameters, operationId: winner.envelope.operationId });
    assert.equal(winnerRetry.kind, 'already-migrated');
    assert.equal(winnerRetry.recordCommitted, false);
    assert.equal(winnerRetry.resolution, 'same-operation-readback');
    assert.deepEqual(winnerRetry.envelope, winner.envelope);
    const loserToken = workers.find(worker => worker.operationId !== winner.envelope.operationId).operationId;
    expectCode(() => f.store.migrateLegacy({ ...f.parameters, operationId: loserToken }), 'CONTROL_CAS_CONFLICT');
    assert.deepEqual(diskSnapshot(f.directory), final);
  });

test('process.exit before/after publication resolves by same-operation readback without duplicate revisions',
  { timeout: 45_000 }, async t => {
    for (const interruptAt of ['before-publish', 'after-publish']) await t.test(interruptAt, async sub => {
      const f = fixture(sub);
      const child = startChild(INTERRUPTED_MIGRATION, [STORE_URL, f.directory, f.legacyPath,
        f.parameters.expectedLegacySha256, f.parameters.operationId, interruptAt]);
      const result = await child.done;
      assert.equal(result.spawnError, null);
      assert.equal(result.signal, null);
      assert.equal(result.code, interruptAt === 'before-publish' ? 91 : 92, result.stderr);
      assert.deepEqual(readFileSync(f.legacyPath), f.raw);
      const stageNames = names(f.directory).filter(name => STAGE_NAME.test(name));
      assert.equal(stageNames.length, 1);
      const stagePath = join(f.directory, stageNames[0]);
      const stageBytes = readFileSync(stagePath);
      const stage = JSON.parse(stageBytes.toString('utf8'));
      assert.equal(stage.operationId, f.parameters.operationId);
      assert.deepEqual(Buffer.from(stage.intent.migration.sourceBase64, 'base64'), f.raw);
      const published = interruptAt === 'after-publish';
      assert.equal(existsSync(join(f.directory, revisionName(1))), published);
      const restarted = createControlIntentStore({ directory: f.directory, legacyPath: f.legacyPath });
      const beforeRetry = diskSnapshot(f.directory);
      if (published) {
        assert.deepEqual(restarted.read(), stage);
        assert.deepEqual(readFileSync(join(f.directory, revisionName(1))), stageBytes);
      } else expectCode(() => restarted.read(), 'CONTROL_RECORD_MIGRATION_REQUIRED');
      const retried = restarted.migrateLegacy(f.parameters);
      assertMigrated(f, retried, legacyIntent(), { kind: published ? 'already-migrated' : 'migrated' });
      if (published) assert.deepEqual(diskSnapshot(f.directory), beforeRetry);
      assert.equal(names(f.directory).filter(name => STAGE_NAME.test(name)).length, published ? 1 : 2);
      assert.deepEqual(names(f.directory).filter(name => COMMITTED_NAME.test(name)), [revisionName(1)]);
      assert.deepEqual(readFileSync(stagePath), stageBytes);
      assert.deepEqual(readFileSync(f.legacyPath), f.raw);
      const final = diskSnapshot(f.directory);
      const resolvedAgain = restarted.migrateLegacy(f.parameters);
      assertMigrated(f, resolvedAgain, legacyIntent(), { kind: 'already-migrated' });
      assert.deepEqual(resolvedAgain.envelope, retried.envelope);
      assert.deepEqual(diskSnapshot(f.directory), final);
    });
  });

test('a source path containing a directory link is rejected without following it for migration', t => {
  const f = fixture(t);
  const linkedParent = join(f.root, 'linked-source-parent');
  symlinkSync(f.root, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(lstatSync(linkedParent).isSymbolicLink());
  const linkedSource = join(linkedParent, basename(f.legacyPath));
  const store = createControlIntentStore({ directory: f.directory, legacyPath: linkedSource });
  const before = diskSnapshot(f.directory);
  expectCode(() => store.inspectLegacy(), 'CONTROL_RECORD_INVALID');
  expectCode(() => store.migrateLegacy(f.parameters), 'CONTROL_RECORD_INVALID');
  assert.deepEqual(diskSnapshot(f.directory), before);
  assert.deepEqual(readFileSync(f.legacyPath), f.raw);
  assert.equal(existsSync(f.directory), false);
});

function temporaryProfile(t, prefix = 'dsh-b2-migration-') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  const profile = join(root, 'dsh-home', 'profiles', 'test-migration');
  mkdirSync(profile, { recursive: true });
  t.diagnostic(`Retained temporary CLI fixture: ${root}`);
  return { root, profile, legacyPath: join(profile, 'control-intent.fixture.json'),
    directory: join(profile, 'control-intent.records') };
}

test('temporary-profile CLI inspection is read-only and migration reports explicit non-authorization', async t => {
  for (const prefix of ['dsh-b2-migration-', 'dsh-deferred-desktop-']) await t.test(prefix, sub => {
    const f = temporaryProfile(sub, prefix);
    const raw = encode(legacyIntent());
    writeFileSync(f.legacyPath, raw, { flag: 'wx' });
    assert.equal(resolveTemporaryMigrationProfile(f.profile), f.profile);
    const before = diskSnapshot(f.directory);
    assert.deepEqual(runLegacyMigration({ profile: f.profile, mode: 'inspect' }), { mode: 'inspect',
      sourceSha256: sha256(raw), sourceByteLength: raw.length, legacySchemaVersion: 1,
      legacyPolicy: 'required', authorizationEstablished: false, routeChanged: false, recordCommitted: false });
    assert.deepEqual(diskSnapshot(f.directory), before);
    for (const approval of [{ expectedRevision: 0 }, { expectedLegacySha256: sha256(raw) }, { operationId: randomUUID() }]) {
      assert.throws(() => runLegacyMigration({ profile: f.profile, mode: 'inspect', ...approval }), /read-only/);
      assert.deepEqual(diskSnapshot(f.directory), before);
    }
    const parameters = { profile: f.profile, mode: 'migrate', expectedRevision: 0,
      expectedLegacySha256: sha256(raw), operationId: randomUUID() };
    const migrated = runLegacyMigration(parameters);
    const expected = { mode: 'migrate', kind: 'migrated', recordCommitted: true, migrationCommitted: true,
      routeChanged: false, authorizationEstablished: false, sourceSha256: sha256(raw), sourceByteLength: raw.length,
      originRevision: 1, currentRevision: 1, operationId: parameters.operationId, resolution: null,
      legacyRetained: true, productIntegrated: false };
    assert.deepEqual(migrated, expected);
    const final = diskSnapshot(f.directory);
    assert.deepEqual(runLegacyMigration(parameters), { ...expected, kind: 'already-migrated',
      recordCommitted: false, resolution: 'same-operation-readback' });
    assert.deepEqual(diskSnapshot(f.directory), final);
    assert.deepEqual(readFileSync(f.legacyPath), raw);
  });
});

test('temporary-profile CLI rejects ordinary, relative and linked paths without touching their source', t => {
  const ordinary = temporaryProfile(t, 'dsh-control-migration-test-');
  const dedicated = temporaryProfile(t);
  const raw = encode(legacyIntent());
  writeFileSync(ordinary.legacyPath, raw, { flag: 'wx' });
  writeFileSync(dedicated.legacyPath, raw, { flag: 'wx' });
  const linkedProfile = join(dedicated.root, 'dsh-home', 'profiles', 'linked-migration');
  symlinkSync(dedicated.profile, linkedProfile, process.platform === 'win32' ? 'junction' : 'dir');
  const beforeOrdinary = diskSnapshot(ordinary.directory);
  const beforeDedicated = diskSnapshot(dedicated.directory);
  for (const profile of [ordinary.profile, 'relative/dsh-home/profiles/test', linkedProfile]) {
    assert.throws(() => resolveTemporaryMigrationProfile(profile), /temporary|Temporary|restricted|absolute/);
    assert.throws(() => runLegacyMigration({ profile, mode: 'inspect' }), /temporary|Temporary|restricted|absolute/);
  }
  assert.throws(() => runLegacyMigration({ profile: dedicated.profile, mode: 'automatic' }), /explicit/);
  assert.deepEqual(diskSnapshot(ordinary.directory), beforeOrdinary);
  assert.deepEqual(diskSnapshot(dedicated.directory), beforeDedicated);
  assert.deepEqual(readFileSync(ordinary.legacyPath), raw);
  assert.deepEqual(readFileSync(dedicated.legacyPath), raw);
});
