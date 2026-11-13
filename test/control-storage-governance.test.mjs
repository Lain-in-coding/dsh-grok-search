import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { commitExplicitRelease } from '../src/core/release-transaction.mjs';
import { acquireOwnedLock } from '../src/core/owned-lock.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';

const intent = reason => ({ schemaVersion: 1, policy: 'required', reason, release: null });
const setup = (options = {}) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-control-governance-'));
  return { root, directory: join(root, 'records'), ...options };
};
const writeRevisions = (store, count, start = 1) => {
  let current = store.read();
  for (let index = start; index < start + count; index++) {
    current = store.compareAndSwap({
      expectedRevision: current?.revision ?? 0,
      intent: intent(`revision-${index}`),
    });
  }
  return current;
};
const revisionName = revision => `v${String(revision).padStart(12, '0')}.json`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function appendFixture(directory, from, to, previousSha256 = null, baseIntent = null) {
  mkdirSync(directory, { recursive: true });
  const files = new Map();
  for (let revision = from; revision <= to; revision++) {
    const bytes = Buffer.from(JSON.stringify({ format: 'dsh-grok-search/control-intent', schemaVersion: 1,
      revision, operationId: randomUUID(), previousSha256, intent: baseIntent ?? intent(`revision-${revision}`),
      committedAt: '2026-11-01T00:00:00.000Z' }, null, 2) + '\n');
    writeFileSync(join(directory, revisionName(revision)), bytes, { flag: 'wx' });
    previousSha256 = hash(bytes);
    files.set(revision, bytes);
  }
  return files;
}

test('checkpoint keeps exactly the latest active set and preserves sealed evidence', () => {
  const { directory } = setup();
  const store = createControlIntentStore({ directory, governance: true });
  writeRevisions(store, 53);
  const inspected = store.inspectStorage();
  assert.equal(inspected.checkpoint.revision, 3);
  assert.equal(inspected.activeRevisions.length, 50);
  assert.deepEqual(inspected.activeRevisions[0], 4);
  assert.deepEqual(inspected.activeRevisions.at(-1), 53);
  assert.equal(inspected.checkpoint.initialArchive.headRevision, 51);
  assert.equal(inspected.sealed, 0);
  assert.equal(readdirSync(directory).filter(name => /^v\d{12}\.json$/.test(name)).length, 50);
  const archived = join(directory, 'legacy-archives', inspected.checkpoint.initialArchive.name);
  assert.equal(readdirSync(archived).filter(name => /^v\d{12}\.json$/.test(name)).length, 51);
  assert.equal(readdirSync(directory).filter(name => name.startsWith('stage-')).length, 50);
  assert.equal(store.read().revision, 53);
  assert.equal(store.readView().revision, 53);

  const restarted = createControlIntentStore({ directory, governance: true });
  assert.equal(restarted.read().revision, 53);
  assert.equal(restarted.readView().revision, 53);
  const advanced = restarted.compareAndSwap({ expectedRevision: 53, intent: intent('revision-54') });
  assert.equal(advanced.revision, 54);
  assert.equal(restarted.read().intent.reason, 'revision-54');
  assert.equal(restarted.inspectStorage().checkpoint.revision, 4);
  assert.equal(restarted.inspectStorage().activeRevisions.length, 50);
});

test('an interrupted checkpoint publication never hides the committed revision', () => {
  for (const stage of ['before-checkpoint-publish', 'after-checkpoint-publish']) {
    const { directory } = setup();
    let interrupted = false;
    const store = createControlIntentStore({
      directory,
      governance: true,
      fault(point) {
        if (point === stage && !interrupted) {
          interrupted = true;
          throw new Error(`synthetic ${stage} interruption`);
        }
      },
    });
    writeRevisions(store, 50);
    const committed = store.compareAndSwap({ expectedRevision: 50, intent: intent('revision-51') });
    assert.equal(committed.revision, 51);
    assert.equal(store.read().revision, 51);
    assert.equal(store.read().intent.reason, 'revision-51');
    assert.equal(store.inspectStorage().lastMaintenance.status, 'error');
    // A later maintenance may complete sealing, but it must never change the
    // latest committed intent or manufacture a missing revision.
    store.maintain();
    assert.equal(store.read().revision, 51);
    assert.equal(store.read().intent.reason, 'revision-51');
  }
});

test('a damaged checkpoint fails closed instead of silently reading old root revisions', () => {
  const { directory } = setup();
  const store = createControlIntentStore({ directory, governance: true });
  writeRevisions(store, 53);
  const checkpoint = join(directory, 'checkpoint.json');
  const original = readFileSync(checkpoint);
  writeFileSync(checkpoint, Buffer.concat([original, Buffer.from('{ damaged\n')]));
  assert.throws(() => store.read(), error => error.code.startsWith('CONTROL_'));
  assert.throws(() => store.readView(), error => error.code.startsWith('CONTROL_'));
});

test('compatible downgrade export retains origin, current state and an explicit revision conversion receipt', () => {
  const { directory } = setup();
  const store = createControlIntentStore({ directory, governance: true });
  writeRevisions(store, 53);
  const before = readFileSync(join(directory, 'checkpoint.json'));
  const target = join(realpathSync(tmpdir()), `dsh-control-export-${randomUUID()}`);
  const exported = store.exportCompatibleHistory({ targetDirectory: target });
  assert.equal(exported.revisions, 52);
  assert.equal(exported.firstRevision, 1);
  assert.equal(exported.lastRevision, 52);
  assert.deepEqual(readFileSync(join(directory, 'checkpoint.json')), before);
  const reopened = createControlIntentStore({ directory: target });
  assert.equal(reopened.read().revision, 52);
  assert.equal(reopened.read().intent.reason, 'revision-53');
  assert.equal(existsSync(join(target, 'checkpoint.json')), false);
  assert.equal(readdirSync(target).filter(name => /^v\d{12}\.json$/.test(name)).length, 52);
  const receipt = JSON.parse(readFileSync(join(target, 'conversion.json'), 'utf8'));
  assert.equal(receipt.sourceRevision, 53);
  assert.equal(receipt.intentUnchanged, true);
  assert.equal(receipt.retainsFullHistoricalChain, false);
});

test('sealed retention enforces the configured count and age without changing current state', () => {
  const { directory } = setup();
  const store = createControlIntentStore({ directory, governance: true, retention: { maxSealedRevisions: 3, maxAgeMs: 365 * 24 * 60 * 60 * 1000 } });
  writeRevisions(store, 108);
  assert.equal(store.inspectStorage().sealed, 3);
  assert.equal(store.read().intent.reason, 'revision-108');
  const aged = createControlIntentStore({ directory, retention: { maxSealedRevisions: 3, maxAgeMs: 0 } });
  const result = aged.maintain();
  assert.equal(result.status, 'unchanged');
  assert.equal(result.pruned, 3);
  assert.equal(aged.inspectStorage().sealed, 0);
  assert.equal(aged.read().intent.reason, 'revision-108');
  const archivePath = join(directory, 'legacy-archives', aged.inspectStorage().checkpoint.initialArchive.name);
  assert.equal(readdirSync(archivePath).filter(name => /^v\d{12}\.json$/.test(name)).length, 51,
    'pre-migration evidence is exempt from rolling retention');
  assert.equal(existsSync(join(directory, 'sealed', 'retention.json')), true);
});

test('sealed revisions are moved rather than duplicated and active stages remain bounded', () => {
  const { directory } = setup();
  const store = createControlIntentStore({ directory, governance: true });
  writeRevisions(store, 60);
  const stages = readdirSync(directory).filter(name => name.startsWith('stage-'));
  assert.ok(stages.length <= 51, `stage count must be bounded by active revisions, got ${stages.length}`);
  const archivePath = join(directory, 'legacy-archives', store.inspectStorage().checkpoint.initialArchive.name);
  const sealed = readdirSync(archivePath).filter(name => /^v\d{12}\.json$/.test(name) && Number(name.slice(1, 13)) < 10);
  assert.deepEqual(sealed.sort(), [revisionName(1), revisionName(2), revisionName(3), revisionName(4), revisionName(5),
    revisionName(6), revisionName(7), revisionName(8), revisionName(9)]);
  for (const name of sealed) {
    const sealedPath = join(archivePath, name);
    const rootPath = join(directory, name);
    assert.equal(existsSync(rootPath), false);
    assert.ok(readFileSync(sealedPath).length > 0);
  }
});

test('an existing 1101-revision ledger is sealed byte-for-byte before bounded active reads begin', t => {
  const { directory } = setup();
  const original = appendFixture(directory, 1, 1101);
  const store = createControlIntentStore({ directory });
  const started = performance.now();
  const migrated = store.maintain();
  const duration = performance.now() - started;
  assert.equal(migrated.status, 'migrated');
  const inspected = store.inspectStorage();
  assert.equal(inspected.checkpoint.revision, 1051);
  assert.equal(inspected.activeRevisions.length, 50);
  const archive = join(directory, 'legacy-archives', inspected.checkpoint.initialArchive.name);
  for (const [revision, bytes] of original) assert.deepEqual(readFileSync(join(archive, revisionName(revision))), bytes);
  assert.equal(store.read().revision, 1101);
  assert.throws(() => store.compareAndSwap({ expectedRevision: 100, intent: intent('stale') }), { code: 'CONTROL_CAS_CONFLICT' });
  const startRead = performance.now();
  for (let index = 0; index < 20; index++) assert.equal(store.read().revision, 1101);
  t.diagnostic(JSON.stringify({ migrationMs: duration, authoritative20ReadsMs: performance.now() - startRead,
    activeRecords: inspected.activeRevisions.length, archivedOriginalRecords: original.size }));
});

test('rolling history respects the 1000-revision boundary and interrupted pruning resumes', () => {
  const { directory } = setup();
  const initial = appendFixture(directory, 1, 51);
  const store = createControlIntentStore({ directory });
  store.maintain();
  appendFixture(directory, 52, 1101, hash(initial.get(51)));
  let interrupted = false;
  const faulty = createControlIntentStore({ directory, fault(stage) {
    if (stage === 'after-retention-delete' && !interrupted) { interrupted = true; throw new Error('prune-interrupted'); }
  } });
  assert.throws(() => faulty.maintain(), /prune-interrupted/);
  assert.equal(store.read().revision, 1101, 'a retention error cannot invalidate current control state');
  assert.equal(existsSync(join(directory, 'sealed', 'retention-pending.json')), true);
  store.maintain();
  const storage = store.inspectStorage();
  assert.equal(storage.activeRevisions.length + storage.sealed + 1, 1000);
  assert.equal(existsSync(join(directory, 'sealed', 'retention-pending.json')), false);
  const archive = join(directory, 'legacy-archives', storage.checkpoint.initialArchive.name);
  assert.equal(readFileSync(join(archive, revisionName(1))).equals(initial.get(1)), true);
});

test('interrupted sealing is retryable and never deletes an unarchived original', () => {
  for (const point of ['before-sealed-evidence-publish', 'after-initial-archive', 'before-checkpoint-publish', 'after-checkpoint-publish']) {
    const { directory } = setup();
    const original = appendFixture(directory, 1, 75);
    let failed = false;
    const store = createControlIntentStore({ directory, fault(stage) {
      if (stage === point && !failed) { failed = true; throw new Error(point); }
    } });
    assert.throws(() => store.maintain(), new RegExp(point));
    for (const [revision, bytes] of original) assert.deepEqual(readFileSync(join(directory, revisionName(revision))), bytes);
    assert.equal(store.read().revision, 75);
    store.maintain();
    assert.equal(readdirSync(join(directory, 'legacy-archives')).length, 1, 'same-head retries reuse the sealed archive');
    assert.equal(store.read().revision, 75);
    assert.equal(store.inspectStorage().activeRevisions.length, 50);
  }
});

test('legacy migration identity and explicit release survive checkpointing and downgrade', () => {
  const { root, directory } = setup();
  const legacyPath = join(root, 'legacy.json');
  const original = { schemaVersion: 1, policy: 'released', reason: 'historic-explicit-release',
    release: { explicit: true, committedAt: '2026-01-01T00:00:00.000Z' } };
  const raw = Buffer.from(JSON.stringify(original, null, 2) + '\n');
  writeFileSync(legacyPath, raw);
  const store = createControlIntentStore({ directory, legacyPath });
  const operationId = randomUUID();
  store.migrateLegacy({ expectedRevision: 0, expectedLegacySha256: hash(raw), operationId });
  const first = readFileSync(join(directory, revisionName(1)));
  appendFixture(directory, 2, 60, hash(first), store.read().intent);
  store.maintain();
  const latest = store.read();
  assert.equal(latest.intent.policy, 'released');
  assert.equal(latest.intent.migration.operationId, operationId);
  const exported = store.exportCompatibleHistory({ targetDirectory: join(root, 'compatible') });
  const reopened = createControlIntentStore({ directory: exported.targetDirectory, legacyPath });
  assert.deepEqual(reopened.read().intent, latest.intent);
  assert.equal(reopened.migrateLegacy({ expectedRevision: 0, expectedLegacySha256: hash(raw), operationId }).kind, 'already-migrated');
  writeFileSync(legacyPath, Buffer.concat([raw, Buffer.from(' ')]));
  assert.throws(() => store.read(), { code: 'CONTROL_RECORD_MIGRATION_SOURCE_CHANGED' });
});

test('corrupt original histories cannot be checkpointed and missing active revisions still fail closed', () => {
  const { directory } = setup();
  appendFixture(directory, 1, 60);
  writeFileSync(join(directory, revisionName(10)), '{ damaged');
  const store = createControlIntentStore({ directory });
  assert.throws(() => store.maintain(), { code: 'CONTROL_RECORD_INVALID' });
  assert.equal(existsSync(join(directory, 'checkpoint.json')), false);
  assert.equal(existsSync(join(directory, 'legacy-archives')), false);
});

test('a user can commit while the legacy archive is being built without losing either head', () => {
  const { directory } = setup();
  appendFixture(directory, 1, 60);
  const writer = createControlIntentStore({ directory, governance: true, autoMaintain: false });
  let wrote = false;
  const maintainer = createControlIntentStore({ directory, fault(stage) {
    if (stage === 'after-initial-archive' && !wrote) {
      wrote = true;
      writer.compareAndSwap({ expectedRevision: 60, intent: intent('user-saved-during-archive') });
    }
  } });
  maintainer.maintain();
  assert.equal(writer.read().revision, 61);
  assert.equal(writer.read().intent.reason, 'user-saved-during-archive');
  assert.equal(writer.inspectStorage().checkpoint.initialArchive.headRevision, 60);
  maintainer.maintain();
  assert.equal(writer.inspectStorage().activeRevisions.length, 50);
});

test('checkpoint publication does not rescan the whole ledger while holding the user writer lock', () => {
  const { directory } = setup();
  appendFixture(directory, 1, 101);
  const originalRead = fs.readFileSync;
  let lockedRevisionReads = 0;
  fs.readFileSync = (path, ...options) => {
    if (/v\d{12}\.json$/.test(String(path)) && existsSync(join(directory, 'control-write.lock'))) {
      lockedRevisionReads++;
    }
    return originalRead(path, ...options);
  };
  syncBuiltinESMExports();
  try { createControlIntentStore({ directory }).maintain(); }
  finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  assert.ok(lockedRevisionReads <= 2, `short publication must not re-read ${lockedRevisionReads} revisions`);
  assert.equal(createControlIntentStore({ directory }).read().revision, 101);
});

test('interrupted retired-link cleanup can resume without leaving committed stage links behind', () => {
  const { directory } = setup();
  const writer = createControlIntentStore({ directory });
  writeRevisions(writer, 60);
  const unknown = join(directory, `stage-${randomUUID()}.json`);
  writeFileSync(unknown, '{"unpublished":"retain"}\n');
  let interrupted = false;
  const maintainer = createControlIntentStore({ directory, fault(stage, detail) {
    if (stage === 'maintenance-progress' && detail.phase === 'remove-sealed-links'
      && detail.revision === 2 && !interrupted) {
      interrupted = true;
      throw new Error('retired-link-cleanup-interrupted');
    }
  } });
  assert.throws(() => maintainer.maintain(), /retired-link-cleanup-interrupted/);
  maintainer.maintain();
  assert.equal(writer.read().revision, 60);
  assert.equal(readdirSync(directory).filter(name => name.startsWith('stage-')).length, 51,
    'only fifty active staging links and the unrelated unpublished evidence may remain');
  assert.equal(readFileSync(unknown, 'utf8'), '{"unpublished":"retain"}\n');
});

test('a failed maintenance scheduler cannot turn an already committed control write into a failure', () => {
  const { directory } = setup();
  appendFixture(directory, 1, 50);
  const reports = [];
  const store = createControlIntentStore({ directory, governance: true,
    maintenanceScheduler() { throw new Error('synthetic-scheduler-failure'); },
    onMaintenance: result => reports.push(result) });
  const result = store.compareAndSwap({ expectedRevision: 50, intent: intent('committed-before-scheduling') });
  assert.equal(result.revision, 51);
  assert.equal(store.read().revision, 51);
  assert.equal(reports.at(-1).status, 'error');
  assert.equal(reports.at(-1).writeCommitted, true);
});

test('stale maintenance requests are rejected before archiving or reporting unchanged', () => {
  for (const count of [1, 51]) {
    const { directory } = setup();
    appendFixture(directory, 1, count);
    const before = readdirSync(directory).sort();
    const store = createControlIntentStore({ directory });
    assert.throws(() => store.maintain({ expectedRevision: count - 1 }), { code: 'CONTROL_CAS_CONFLICT' });
    assert.deepEqual(readdirSync(directory).sort(), before);
  }
});

test('a rejected async maintenance scheduler is observed separately from the successful commit', async () => {
  const { directory } = setup();
  appendFixture(directory, 1, 50);
  const reports = [];
  const store = createControlIntentStore({ directory, governance: true,
    maintenanceScheduler: async () => { throw new Error('async-scheduler-failure'); },
    onMaintenance: result => reports.push(result) });
  assert.equal(store.compareAndSwap({ expectedRevision: 50, intent: intent('committed') }).revision, 51);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports.at(-1).writeCommitted, true);
  assert.equal(store.read().revision, 51);
});

test('two processes with one expected revision cannot both commit across checkpointed storage', async () => {
  const { directory } = setup();
  appendFixture(directory, 1, 60);
  const store = createControlIntentStore({ directory });
  store.maintain();
  const source = `
    import { createControlIntentStore } from ${JSON.stringify(new URL('../src/core/control-intent-store.mjs', import.meta.url).href)};
    const store = createControlIntentStore({ directory: process.argv[1], governance: true });
    try {
      const record = store.compareAndSwap({ expectedRevision: 60, intent: { schemaVersion: 1, policy: 'required', reason: 'concurrent', release: null } });
      console.log(JSON.stringify({ won: true, revision: record.revision }));
    } catch (error) { console.log(JSON.stringify({ won: false, code: error.code })); }
  `;
  const run = async () => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source, directory],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter(row => row.won).length, 1);
  assert.ok(['CONTROL_CAS_CONFLICT', 'CONTROL_STORAGE_BUSY'].includes(results.find(row => !row.won).code));
  assert.equal(store.read().revision, 61);
});

test('explicit release and its idempotent retry stay valid after checkpointing and compatible conversion', async () => {
  const { root, directory } = setup();
  const owner = { hostId: randomUUID(), pid: process.pid, uid: 1, entryId: 'web',
    moduleName: '@deepseek-ai/dsh-web', provider: 'grok-search' };
  const required = { ...intent('required'), lease: owner,
    acquisition: { source: 'current-selected-search-bundle', searchBundle: 'dsh-grok-search',
      selectedBundles: ['dsh-grok-search'], selectionSha256: 'a'.repeat(64),
      hostId: owner.hostId, ownerUid: 1, authorSearchProvider: 'original' } };
  appendFixture(directory, 1, 60, null, required);
  const store = createControlIntentStore({ directory });
  store.maintain();
  const controller = {
    invalidate: () => ({ stopping: true, available: false }),
    drain: async () => ({ settled: true, remaining: 0 }),
    restore: async () => ({ routeChanged: true }),
    verify: async () => ({ atAuthor: true, routeChanged: true, fetchPreserved: true, dependenciesPreserved: true,
      actualSearchProvider: 'original', originalSearchCalls: 0, originalSearchBaseline: 0, originalSearchDelta: 0 }),
  };
  const operationId = randomUUID();
  const released = await commitExplicitRelease({ store, owner, controller, operationId, counterBaseline: 0 });
  assert.equal(released.kind, 'released');
  const latest = store.read();
  store.maintain();
  const exported = store.exportCompatibleHistory({ targetDirectory: join(root, 'release-compatible') });
  const legacy = createControlIntentStore({ directory: exported.targetDirectory });
  assert.deepEqual(legacy.read().intent, latest.intent);
  const retried = await commitExplicitRelease({ store: legacy, owner, controller, operationId, counterBaseline: 0 });
  assert.equal(retried.kind, 'already-released');
  assert.equal(legacy.read().intent.releaseCompletion.releaseOperationId, operationId);
});

test('async control commits wait for a short maintenance contention without changing the expected revision', async () => {
  const { directory } = setup();
  appendFixture(directory, 1, 60);
  const store = createControlIntentStore({ directory, governance: true, autoMaintain: false });
  store.maintain();
  const lock = acquireOwnedLock(join(directory, 'control-write.lock'));
  const timer = setTimeout(() => lock.release(), 30);
  try {
    const operationId = randomUUID();
    const result = await store.compareAndSwapAsync({ expectedRevision: 60, operationId, intent: intent('after-short-contention') });
    assert.equal(result.revision, 61);
    assert.equal(result.operationId, operationId);
    await assert.rejects(store.compareAndSwapAsync({ expectedRevision: 60, intent: intent('stale') }), { code: 'CONTROL_CAS_CONFLICT' });
  } finally { clearTimeout(timer); lock.release(); }
});
