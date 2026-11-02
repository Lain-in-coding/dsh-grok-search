import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlRecordError, createControlIntentStore } from '../src/core/control-intent-store.mjs';

// These cooperative local-filesystem fixtures are deliberately retained. They
// test publication/interruption, not NFS, power-loss durability or hostile writes.
const FORMAT = 'dsh-grok-search/control-intent';
const STORE_URL = new URL('../src/core/control-intent-store.mjs', import.meta.url).href;
const COMMITTED_NAME = /^v\d{12}\.json$/;
const STAGE_NAME = /^stage-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const revisionName = revision => `v${String(revision).padStart(12, '0')}.json`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const requiredIntent = (overrides = {}) => ({
  schemaVersion: 1, policy: 'required', reason: 'test-authorized-acquisition', release: null, ...overrides,
});
const envelope = (overrides = {}) => ({
  format: FORMAT, schemaVersion: 1, revision: 1, operationId: randomUUID(),
  previousSha256: null, intent: requiredIntent(), ...overrides,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-intent-test-'));
  t.diagnostic(`Retained fixture: ${root}`);
  return { root, directory: join(root, 'control') };
}

function names(directory) {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function diskSnapshot(directory) {
  return {
    exists: existsSync(directory),
    entries: names(directory).map(name => {
      const path = join(directory, name);
      const entry = lstatSync(path);
      return { name, kind: entry.isFile() ? 'file' : 'other', bytes: entry.isFile() ? readFileSync(path) : null };
    }),
  };
}

function seed(directory, files) {
  mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(directory, name), bytes, { flag: 'wx' });
}

function expectCode(action, code) {
  let caught;
  assert.throws(action, error => {
    assert.ok(error instanceof ControlRecordError);
    assert.equal(error.code, code);
    caught = error;
    return true;
  });
  return caught;
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

const CONTENDING_WRITER = String.raw`
import { existsSync, writeFileSync } from 'node:fs';
const [moduleUrl, directory, barrierPath, readyPath, expectedRevision, intentJson, operationId] = process.argv.slice(1);
const { ControlRecordError, createControlIntentStore } = await import(moduleUrl);
const stages = [];
const waitCell = new Int32Array(new SharedArrayBuffer(4));
try {
  const store = createControlIntentStore({ directory, fault(stage) {
    stages.push(stage);
    if (stage !== 'before-publish') return;
    writeFileSync(readyPath, operationId, { flag: 'wx' });
    const deadline = Date.now() + 15_000;
    while (!existsSync(barrierPath)) {
      if (Date.now() >= deadline) throw new Error('Publication barrier timed out.');
      Atomics.wait(waitCell, 0, 0, 10);
    }
  } });
  const committed = store.compareAndSwap({ expectedRevision: Number(expectedRevision),
    intent: JSON.parse(intentJson), operationId });
  process.stdout.write(JSON.stringify({ kind: 'winner', envelope: committed, stages }) + '\n');
} catch (error) {
  if (!(error instanceof ControlRecordError)) throw error;
  process.stdout.write(JSON.stringify({ kind: 'error', code: error.code, details: error.details, stages }) + '\n');
}
`;

const INTERRUPTED_WRITER = String.raw`
const [moduleUrl, directory, expectedRevision, intentJson, operationId, interruptAt] = process.argv.slice(1);
const { createControlIntentStore } = await import(moduleUrl);
const exitCodes = { 'before-publish': 71, 'after-publish': 72 };
const store = createControlIntentStore({ directory, fault(stage) {
  if (stage === interruptAt) process.exit(exitCodes[stage]);
} });
store.compareAndSwap({ expectedRevision: Number(expectedRevision), intent: JSON.parse(intentJson), operationId });
process.stderr.write('The requested interruption seam was not reached.\n');
process.exitCode = 1;
`;

test('ControlRecordError exposes its code and an immutable details snapshot', () => {
  const details = { expectedRevision: 2 };
  const error = new ControlRecordError('CONTROL_CAS_CONFLICT', 'stale writer', details);
  details.expectedRevision = 9;
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ControlRecordError');
  assert.equal(error.message, 'stale writer');
  assert.equal(error.code, 'CONTROL_CAS_CONFLICT');
  assert.deepEqual(error.details, { expectedRevision: 2 });
  assert.ok(Object.isFrozen(error.details));
});

test('an absent store reads as null without creating a storage directory', t => {
  const { directory } = fixture(t);
  const store = createControlIntentStore({ directory });
  const before = diskSnapshot(directory);
  assert.equal(store.read(), null);
  assert.deepEqual(diskSnapshot(directory), before);
  assert.equal(existsSync(directory), false);
});

test('a trusted profile permits aliases above it while rejecting links at or below it', t => {
  if (process.platform === 'win32') {
    t.skip('POSIX directory symlink semantics are required.');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-intent-trusted-root-'));
  t.diagnostic(`Retained fixture: ${root}`);
  const physical = join(root, 'physical');
  const alias = join(root, 'alias');
  const profile = join(alias, 'profile');
  mkdirSync(join(physical, 'profile'), { recursive: true });
  symlinkSync(physical, alias, 'dir');

  const store = createControlIntentStore({
    directory: join(profile, 'control'),
    trustedRoot: profile,
  });
  assert.equal(store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() }).revision, 1);

  const outside = join(root, 'outside');
  const linkedRoot = join(profile, 'linked-control');
  mkdirSync(outside);
  symlinkSync(outside, linkedRoot, 'dir');
  assert.throws(() => createControlIntentStore({
    directory: linkedRoot,
    trustedRoot: profile,
  }).read(), error => error.code === 'CONTROL_RECORD_INVALID');

  assert.throws(() => createControlIntentStore({
    directory: join(profile, '..', 'escaped'),
    trustedRoot: profile,
  }), error => error.code === 'CONTROL_RECORD_INVALID');
});

test('CAS accepts required intent without a lease and returns detached, deeply frozen envelopes', t => {
  const { directory } = fixture(t);
  const store = createControlIntentStore({ directory });
  const operationId = randomUUID();
  const intent = requiredIntent({ acquiredSelection: ['search'], acquisition: { note: { supplied: true } } });
  const original = structuredClone(intent);
  const committed = store.compareAndSwap({ expectedRevision: 0, intent, operationId });
  assert.deepEqual(committed, {
    format: FORMAT, schemaVersion: 1, revision: 1, operationId, previousSha256: null, intent: original,
  });
  for (const value of [committed, committed.intent, committed.intent.acquiredSelection,
    committed.intent.acquisition, committed.intent.acquisition.note]) assert.ok(Object.isFrozen(value));
  intent.reason = 'mutated caller input';
  intent.acquisition.note.supplied = false;
  intent.acquiredSelection.push('other');
  assert.throws(() => { committed.intent.reason = 'forbidden'; }, TypeError);
  assert.throws(() => committed.intent.acquiredSelection.push('forbidden'), TypeError);
  const reread = store.read();
  assert.notStrictEqual(reread, committed);
  assert.deepEqual(reread, committed);
  assert.deepEqual(reread.intent, original);
  assert.ok(Object.isFrozen(reread.intent.acquisition.note));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, revisionName(1)), 'utf8')), committed);
});

test('publication retains unique complete staging files hardlinked to immutable hash-chained revisions', t => {
  const { directory } = fixture(t);
  const calls = [];
  const store = createControlIntentStore({ directory, fault(stage, context) {
    calls.push({ stage, ...context });
    assert.match(basename(context.stagePath), STAGE_NAME);
    assert.equal(basename(context.targetPath), revisionName(context.expectedRevision + 1));
    if (stage === 'before-stage-write') {
      assert.equal(existsSync(context.stagePath), false);
      assert.equal(existsSync(context.targetPath), false);
    } else {
      const staged = JSON.parse(readFileSync(context.stagePath, 'utf8'));
      assert.equal(staged.operationId, context.operationId);
      assert.equal(staged.revision, context.expectedRevision + 1);
      if (stage === 'before-publish') assert.equal(existsSync(context.targetPath), false);
      if (stage === 'after-publish') {
        const stagingStat = statSync(context.stagePath, { bigint: true });
        const committedStat = statSync(context.targetPath, { bigint: true });
        assert.equal(stagingStat.dev, committedStat.dev);
        assert.equal(stagingStat.ino, committedStat.ino);
        assert.ok(stagingStat.nlink >= 2n);
        assert.deepEqual(readFileSync(context.stagePath), readFileSync(context.targetPath));
      }
    }
  } });
  const first = store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
  const oldBytes = readFileSync(join(directory, revisionName(1)));
  const second = store.compareAndSwap({ expectedRevision: 1, intent: requiredIntent({ reason: 'next acquisition' }) });
  assert.equal(first.previousSha256, null);
  assert.equal(second.previousSha256, sha256(oldBytes));
  assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
  assert.deepEqual(names(directory).filter(name => COMMITTED_NAME.test(name)), [revisionName(1), revisionName(2)]);
  assert.equal(names(directory).filter(name => STAGE_NAME.test(name)).length, 2);
  assert.notEqual(calls[0].stagePath, calls[3].stagePath);
  assert.deepEqual(calls.map(call => call.stage), [
    'before-stage-write', 'before-publish', 'after-publish',
    'before-stage-write', 'before-publish', 'after-publish',
  ]);
  assert.deepEqual(store.read(), second);
});

test('stale revisions cannot overwrite an explicit release or create another staging file', t => {
  const { directory } = fixture(t);
  const store = createControlIntentStore({ directory });
  store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
  const released = store.compareAndSwap({ expectedRevision: 1, intent: requiredIntent({
    policy: 'released', reason: 'confirmed user release',
    release: { explicit: true, committedAt: '2026-10-20T00:00:00.000Z' },
  }) });
  const before = diskSnapshot(directory);
  for (const expectedRevision of [0, 1]) {
    const error = expectCode(() => store.compareAndSwap({ expectedRevision, intent: requiredIntent() }), 'CONTROL_CAS_CONFLICT');
    assert.deepEqual(error.details, { expectedRevision, actualRevision: 2 });
    assert.deepEqual(diskSnapshot(directory), before);
  }
  assert.deepEqual(store.read(), released);
});

test('a competitor published after the initial snapshot wins the exclusive hardlink CAS', t => {
  const { directory } = fixture(t);
  const normal = createControlIntentStore({ directory });
  normal.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
  const oldBytes = readFileSync(join(directory, revisionName(1)));
  let winner;
  const contender = createControlIntentStore({ directory, fault(stage) {
    if (stage === 'before-publish') winner = normal.compareAndSwap({
      expectedRevision: 1, intent: requiredIntent({ reason: 'competing winner' }), operationId: randomUUID(),
    });
  } });
  const loserOperationId = randomUUID();
  expectCode(() => contender.compareAndSwap({ expectedRevision: 1,
    intent: requiredIntent({ reason: 'must not overwrite' }), operationId: loserOperationId }), 'CONTROL_CAS_CONFLICT');
  assert.deepEqual(normal.read(), winner);
  assert.notEqual(winner.operationId, loserOperationId);
  assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, revisionName(2)), 'utf8')), winner);
  assert.equal(names(directory).filter(name => STAGE_NAME.test(name)).length, 3);
  assert.equal(existsSync(join(directory, revisionName(3))), false);
});

test('competing Node processes at the same revision have exactly one winner', { timeout: 45_000 }, async t => {
  for (const expectedRevision of [0, 1]) await t.test(`expected revision ${expectedRevision}`, async sub => {
    const { root, directory } = fixture(sub);
    const store = createControlIntentStore({ directory });
    if (expectedRevision === 1) store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
    const oldBytes = expectedRevision === 1 ? readFileSync(join(directory, revisionName(1))) : null;
    const barrierPath = join(root, 'publish-barrier.ready');
    const workers = ['writer-a', 'writer-b'].map(label => {
      const readyPath = join(root, `${label}.ready`);
      const operationId = randomUUID();
      return { readyPath, operationId, ...startChild(CONTENDING_WRITER, [STORE_URL, directory, barrierPath,
        readyPath, String(expectedRevision), JSON.stringify(requiredIntent({ reason: label })), operationId]) };
    });
    let barrierError;
    try {
      const deadline = Date.now() + 15_000;
      while (!workers.every(worker => existsSync(worker.readyPath))) {
        if (workers.some(worker => worker.state.closed)) throw new Error('A writer exited before both reached publication.');
        if (Date.now() >= deadline) throw new Error('Both writers did not reach the publication barrier.');
        await delay(10);
      }
    } catch (error) {
      barrierError = error;
    } finally {
      // Release even on a failed barrier assertion; all child fixtures stay on disk.
      writeFileSync(barrierPath, 'publish\n', { flag: 'wx' });
    }
    const childResults = await Promise.all(workers.map(worker => worker.done));
    if (barrierError) {
      sub.diagnostic(JSON.stringify(childResults));
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
    assert.deepEqual(losers[0].stages, ['before-stage-write', 'before-publish']);
    assert.deepEqual(winners[0].stages, ['before-stage-write', 'before-publish', 'after-publish']);
    const winner = winners[0].envelope;
    assert.equal(winner.revision, expectedRevision + 1);
    assert.ok(workers.some(worker => worker.operationId === winner.operationId));
    assert.deepEqual(store.read(), winner);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, revisionName(winner.revision)), 'utf8')), winner);
    assert.equal(names(directory).filter(name => COMMITTED_NAME.test(name)).length, expectedRevision + 1);
    assert.equal(names(directory).filter(name => STAGE_NAME.test(name)).length, expectedRevision + 2);
    if (oldBytes) assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
    const final = diskSnapshot(directory);
    expectCode(() => store.compareAndSwap({ expectedRevision, intent: requiredIntent() }), 'CONTROL_CAS_CONFLICT');
    assert.deepEqual(diskSnapshot(directory), final);
  });
});

test('unpublished staging bytes are retained but never promoted or parsed as committed intent', t => {
  const { directory } = fixture(t);
  const orphan = `stage-${randomUUID()}.json`;
  const raw = Buffer.from('{ incomplete staging evidence\n');
  seed(directory, [[orphan, raw]]);
  const store = createControlIntentStore({ directory });
  const before = diskSnapshot(directory);
  assert.equal(store.read(), null);
  assert.deepEqual(diskSnapshot(directory), before);
  const committed = store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
  assert.deepEqual(store.read(), committed);
  assert.deepEqual(readFileSync(join(directory, orphan)), raw);
  assert.equal(names(directory).filter(name => STAGE_NAME.test(name)).length, 2);
});

test('corrupt, unknown-version and gapped histories fail closed without altering raw evidence', async t => {
  const cases = [
    { name: 'damaged JSON', files: () => [[revisionName(1), Buffer.from('{ damaged\n')]] },
    { name: 'unknown format', files: () => [[revisionName(1), encode(envelope({ format: 'unknown/control-intent' }))]] },
    { name: 'unknown envelope version', code: 'CONTROL_RECORD_VERSION_UNSUPPORTED',
      files: () => [[revisionName(1), encode(envelope({ schemaVersion: 2 }))]] },
    { name: 'unknown intent version', code: 'CONTROL_RECORD_VERSION_UNSUPPORTED',
      files: () => [[revisionName(1), encode(envelope({ intent: requiredIntent({ schemaVersion: 2 }) }))]] },
    { name: 'invalid intent', files: () => [[revisionName(1), encode(envelope({ intent: requiredIntent({ policy: 'unknown' }) }))]] },
    { name: 'mismatched revision', files: () => [[revisionName(1), encode(envelope({ revision: 2 }))]] },
    { name: 'invalid operation UUID', files: () => [[revisionName(1), encode(envelope({ operationId: 'not-a-uuid' }))]] },
    { name: 'first revision has a predecessor', files: () => [[revisionName(1), encode(envelope({ previousSha256: 'a'.repeat(64) }))]] },
    { name: 'missing first revision', files: () => [[revisionName(2), encode(envelope({ revision: 2 }))]] },
    { name: 'gap after first revision', files: () => {
      const first = encode(envelope());
      return [[revisionName(1), first], [revisionName(3), encode(envelope({ revision: 3, previousSha256: sha256(first) }))]];
    } },
    { name: 'broken predecessor digest', files: () => [[revisionName(1), encode(envelope())],
      [revisionName(2), encode(envelope({ revision: 2, previousSha256: '0'.repeat(64) }))]] },
    { name: 'old damage is not hidden by a later revision', files: () => {
      const first = Buffer.from('{ damaged older record\n');
      return [[revisionName(1), first], [revisionName(2), encode(envelope({ revision: 2, previousSha256: sha256(first) }))]];
    } },
    { name: 'malformed committed filename', files: () => [['v1.json', encode(envelope())]] },
    { name: 'oversized committed file', files: () => [[revisionName(1), Buffer.alloc(1_048_577, 0x78)]] },
  ];
  for (const entry of cases) await t.test(entry.name, sub => {
    const { directory } = fixture(sub);
    seed(directory, entry.files());
    const store = createControlIntentStore({ directory });
    const before = diskSnapshot(directory);
    const code = entry.code ?? 'CONTROL_RECORD_INVALID';
    expectCode(() => store.read(), code);
    expectCode(() => store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() }), code);
    assert.deepEqual(diskSnapshot(directory), before);
  });
  await t.test('a revision pathname that is a directory is not a committed record', sub => {
    const { directory } = fixture(sub);
    mkdirSync(join(directory, revisionName(1)), { recursive: true });
    const store = createControlIntentStore({ directory });
    const before = diskSnapshot(directory);
    expectCode(() => store.read(), 'CONTROL_RECORD_INVALID');
    expectCode(() => store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() }), 'CONTROL_RECORD_INVALID');
    assert.deepEqual(diskSnapshot(directory), before);
  });
});

test('any existing legacy evidence blocks reads and writes, even alongside versioned commits', async t => {
  for (const initialRevision of [0, 1]) await t.test(`versioned revision ${initialRevision}`, sub => {
    const { root, directory } = fixture(sub);
    const normal = createControlIntentStore({ directory });
    if (initialRevision) normal.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
    const legacyPath = join(root, 'legacy.json');
    const legacyBytes = Buffer.from('unversioned original evidence\n\0');
    writeFileSync(legacyPath, legacyBytes, { flag: 'wx' });
    const store = createControlIntentStore({ directory, legacyPath });
    const before = diskSnapshot(directory);
    expectCode(() => store.read(), 'CONTROL_RECORD_MIGRATION_REQUIRED');
    expectCode(() => store.compareAndSwap({ expectedRevision: initialRevision, intent: requiredIntent() }), 'CONTROL_RECORD_MIGRATION_REQUIRED');
    assert.deepEqual(diskSnapshot(directory), before);
    assert.deepEqual(readFileSync(legacyPath), legacyBytes);
  });
});

test('invalid writes are rejected before staging and leave a valid prior record intact', async t => {
  const cases = [
    { name: 'unsupported intent version', code: 'CONTROL_RECORD_VERSION_UNSUPPORTED', make: () => requiredIntent({ schemaVersion: 2 }) },
    { name: 'unknown policy', make: () => requiredIntent({ policy: 'unknown' }) },
    { name: 'empty reason', make: () => requiredIntent({ reason: '' }) },
    { name: 'missing explicit release field', make: () => ({ schemaVersion: 1, policy: 'required', reason: 'missing release' }) },
    { name: 'required intent claims historic release', make: () => requiredIntent({ release: { explicit: true, committedAt: '2026-10-20T00:00:00.000Z' } }) },
    { name: 'non-explicit release', make: () => requiredIntent({ policy: 'released', release: { explicit: false, committedAt: '2026-10-20T00:00:00.000Z' } }) },
    { name: 'invalid lease', make: () => requiredIntent({ lease: { pid: 0, uid: 'owner', entryId: 'web', moduleName: '@deepseek-ai/dsh-web', provider: 'test' } }) },
    { name: 'invalid acquired selection', make: () => requiredIntent({ acquiredSelection: ['search', ''] }) },
    { name: 'invalid pause confirmation', make: () => requiredIntent({ pause: { confirmed: 'yes' } }) },
    { name: 'undefined JSON member', make: () => requiredIntent({ extra: undefined }) },
    { name: 'nonfinite JSON member', make: () => requiredIntent({ extra: NaN }) },
    { name: 'bigint JSON member', make: () => requiredIntent({ extra: 1n }) },
    { name: 'cyclic JSON', make: () => { const intent = requiredIntent(); intent.extra = intent; return intent; } },
    { name: 'oversized JSON', make: () => requiredIntent({ reason: 'x'.repeat(1_048_577) }) },
    { name: 'invented historic release in correction evidence', make: () => requiredIntent({ policy: 'released',
      priorIntent: requiredIntent(), recovery: { action: 'startup-state-correction', originalLease: {},
        historicReleaseCommitted: true, routeVerified: true, routeChanged: false } }) },
  ];
  for (const entry of cases) await t.test(entry.name, sub => {
    const { directory } = fixture(sub);
    const store = createControlIntentStore({ directory });
    store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
    const before = diskSnapshot(directory);
    expectCode(() => store.compareAndSwap({ expectedRevision: 1, intent: entry.make() }), entry.code ?? 'CONTROL_RECORD_INVALID');
    assert.deepEqual(diskSnapshot(directory), before);
  });
  for (const parameters of [
    { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: '0' },
    { expectedRevision: Number.MAX_SAFE_INTEGER }, { operationId: 'not-a-uuid' },
  ]) await t.test(`invalid CAS parameters ${JSON.stringify(parameters)}`, sub => {
    const { directory } = fixture(sub);
    const store = createControlIntentStore({ directory });
    const before = diskSnapshot(directory);
    expectCode(() => store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent(), ...parameters }), 'CONTROL_RECORD_INVALID');
    assert.deepEqual(diskSnapshot(directory), before);
  });
});

test('fault seams distinguish unpublished failure from a committed-but-uncertain publication', async t => {
  for (const interruptAt of ['before-stage-write', 'before-publish', 'after-publish']) await t.test(interruptAt, sub => {
    const { directory } = fixture(sub);
    const normal = createControlIntentStore({ directory });
    normal.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
    const oldBytes = readFileSync(join(directory, revisionName(1)));
    const before = diskSnapshot(directory);
    const operationId = randomUUID();
    let context;
    const store = createControlIntentStore({ directory, fault(stage, details) {
      if (stage !== interruptAt) return;
      context = details;
      const error = new Error('Injected write interruption.');
      error.code = 'E_TEST_WRITE';
      throw error;
    } });
    const published = interruptAt === 'after-publish';
    const error = expectCode(() => store.compareAndSwap({ expectedRevision: 1,
      intent: requiredIntent({ reason: 'faulted candidate' }), operationId }),
    published ? 'CONTROL_RECORD_COMMIT_UNCERTAIN' : 'CONTROL_RECORD_WRITE_FAILED');
    assert.deepEqual(error.details, { expectedRevision: 1, attemptedRevision: 2, operationId,
      published, causeCode: 'E_TEST_WRITE' });
    assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
    assert.equal(existsSync(context.targetPath), published);
    assert.equal(existsSync(context.stagePath), interruptAt !== 'before-stage-write');
    if (interruptAt === 'before-stage-write') assert.deepEqual(diskSnapshot(directory), before);
    else {
      const staged = JSON.parse(readFileSync(context.stagePath, 'utf8'));
      assert.equal(staged.operationId, operationId);
      assert.equal(staged.previousSha256, sha256(oldBytes));
      assert.equal(staged.revision, 2);
      if (published) assert.deepEqual(readFileSync(context.targetPath), readFileSync(context.stagePath));
    }
    assert.equal(normal.read().revision, published ? 2 : 1);
    if (published) assert.equal(normal.read().operationId, operationId);
    assert.equal(names(directory).filter(name => STAGE_NAME.test(name)).length, interruptAt === 'before-stage-write' ? 1 : 2);
  });
});

test('process interruption before or after hardlink publication is resolved by disk state, not an error alone',
  { timeout: 45_000 }, async t => {
    for (const interruptAt of ['before-publish', 'after-publish']) await t.test(interruptAt, async sub => {
      const { directory } = fixture(sub);
      const store = createControlIntentStore({ directory });
      store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
      const oldBytes = readFileSync(join(directory, revisionName(1)));
      const operationId = randomUUID();
      const intent = requiredIntent({ reason: `interrupted at ${interruptAt}` });
      const child = startChild(INTERRUPTED_WRITER, [STORE_URL, directory, '1', JSON.stringify(intent), operationId, interruptAt]);
      const result = await child.done;
      assert.equal(result.spawnError, null);
      assert.equal(result.signal, null);
      assert.equal(result.code, interruptAt === 'before-publish' ? 71 : 72, result.stderr);
      assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
      const stages = names(directory).filter(name => STAGE_NAME.test(name));
      assert.equal(stages.length, 2);
      const attemptedStage = stages.find(name => JSON.parse(readFileSync(join(directory, name), 'utf8')).operationId === operationId);
      assert.ok(attemptedStage);
      const stagedBytes = readFileSync(join(directory, attemptedStage));
      const restarted = createControlIntentStore({ directory });
      const published = interruptAt === 'after-publish';
      assert.equal(restarted.read().revision, published ? 2 : 1);
      assert.equal(existsSync(join(directory, revisionName(2))), published);
      if (published) {
        assert.equal(restarted.read().operationId, operationId);
        assert.deepEqual(restarted.read().intent, intent);
        assert.deepEqual(readFileSync(join(directory, revisionName(2))), stagedBytes);
        const final = diskSnapshot(directory);
        expectCode(() => restarted.compareAndSwap({ expectedRevision: 1, intent, operationId }), 'CONTROL_CAS_CONFLICT');
        assert.deepEqual(diskSnapshot(directory), final);
      } else {
        const retried = restarted.compareAndSwap({ expectedRevision: 1, intent, operationId });
        assert.equal(retried.revision, 2);
        assert.equal(retried.operationId, operationId);
        assert.equal(names(directory).filter(name => STAGE_NAME.test(name)).length, 3);
        assert.deepEqual(readFileSync(join(directory, attemptedStage)), stagedBytes);
      }
    });
  });

test('a real exclusive staging write failure leaves the committed revision and raw evidence intact', t => {
  const { directory } = fixture(t);
  const normal = createControlIntentStore({ directory });
  const before = normal.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
  const oldBytes = readFileSync(join(directory, revisionName(1)));
  const obstruction = Buffer.from('pre-existing collision evidence');
  let blockedPath;
  const failing = createControlIntentStore({ directory, fault(stage, context) {
    if (stage !== 'before-stage-write') return;
    blockedPath = context.stagePath;
    writeFileSync(blockedPath, obstruction, { flag: 'wx' });
  } });
  const error = expectCode(() => failing.compareAndSwap({ expectedRevision: 1,
    intent: requiredIntent({ reason: 'must-not-commit' }) }), 'CONTROL_RECORD_WRITE_FAILED');
  assert.equal(error.details.causeCode, 'EEXIST');
  assert.equal(error.details.published, false);
  assert.deepEqual(normal.read(), before);
  assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
  assert.deepEqual(readFileSync(blockedPath), obstruction);
  assert.equal(existsSync(join(directory, revisionName(2))), false);
});
