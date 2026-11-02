import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ControlRecordError, createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { commitExplicitRelease, createReleaseBarrier } from '../src/core/release-transaction.mjs';

const HOST_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_HOST_ID = '00000000-0000-4000-8000-000000000002';
const AUTHOR = 'author-search-provider';

function owner(overrides = {}) {
  return { hostId: HOST_ID, pid: 1234, uid: 7, entryId: 'web',
    moduleName: '@deepseek-ai/dsh-web', provider: 'grok-search', ...overrides };
}

function requiredIntent(overrides = {}) {
  return {
    schemaVersion: 1,
    policy: 'required',
    reason: 'test-release',
    lease: owner(),
    acquisition: { source: 'current-selected-search-bundle', searchBundle: 'dsh-grok-search',
      selectedBundles: ['dsh-grok-search'], selectionSha256: 'a'.repeat(64),
      observedAt: '2026-10-22T00:00:00.000Z', hostId: HOST_ID, ownerUid: 7,
      authorSearchProvider: AUTHOR, userClickObserved: false, historicReleaseCommitted: false },
    release: null,
    ...overrides,
  };
}

function fixture(t) {
  const directory = join(mkdtempSync(join(tmpdir(), 'dsh-release-transaction-test-')), 'control');
  t.diagnostic(`Retained fixture: ${directory}`);
  const store = createControlIntentStore({ directory });
  const before = store.compareAndSwap({ expectedRevision: 0, intent: requiredIntent() });
  return { directory, store, before };
}

function controller(events, overrides = {}) {
  return {
    invalidate() { events.push('invalidate'); return { stopping: true, available: false }; },
    async drain() { events.push('drain'); return { settled: true, remaining: 0 }; },
    async restore() { events.push('restore'); return { routeChanged: true }; },
    async verify({ counterBaseline = 0 } = {}) { events.push('verify'); return { atAuthor: true, routeChanged: true,
      fetchPreserved: true, dependenciesPreserved: true, actualSearchProvider: AUTHOR,
      originalSearchCalls: counterBaseline, originalSearchBaseline: counterBaseline,
      originalSearchDelta: 0 }; },
    ...overrides,
  };
}

test('explicit release commits the intent before route restore and verification', async t => {
  const { store, before } = fixture(t);
  const events = [];
  const operationId = randomUUID();
  const outcome = await commitExplicitRelease({ store, owner: owner(), controller: controller(events), operationId,
    counterBaseline: 0 });
  assert.equal(outcome.kind, 'released');
  assert.equal(outcome.recordCommitted, true);
  assert.equal(outcome.routeChanged, true);
  assert.equal(outcome.routeVerified, true);
  assert.equal(outcome.inFlightInvalidated, true);
  assert.equal(outcome.drainSettled, true);
  assert.deepEqual(events, ['invalidate', 'drain', 'restore', 'verify']);
  const after = store.read();
  assert.equal(after.revision, before.revision + 2);
  assert.equal(after.intent.policy, 'released');
  assert.equal(after.intent.release.kind, 'intent-release-commit');
  assert.equal(after.intent.release.operationId, operationId);
  assert.equal(after.intent.release.counterBaseline, 0);
  assert.equal(after.intent.release.routeChanged, false);
  assert.equal(after.intent.release.routeVerified, false);
  assert.equal(after.intent.pause.confirmed, true);
  assert.equal(after.intent.releaseCompletion.kind, 'explicit-release-completion');
  assert.equal(after.intent.releaseCompletion.routeChanged, true);
  assert.equal(after.intent.releaseCompletion.routeVerified, true);
  assert.deepEqual(after.intent.priorIntent, before.intent);
});

test('the same release operation is idempotent and does not touch the route again', async t => {
  const { store } = fixture(t);
  const events = [];
  const operationId = randomUUID();
  const first = await commitExplicitRelease({ store, owner: owner(), controller: controller(events), operationId,
    counterBaseline: 0 });
  const second = await commitExplicitRelease({ store, owner: owner(), controller: controller(events), operationId,
    counterBaseline: 0 });
  assert.equal(first.kind, 'released');
  assert.equal(second.kind, 'already-released');
  assert.equal(second.recordCommitted, false);
  assert.deepEqual(events, ['invalidate', 'drain', 'restore', 'verify']);
});

test('completion CAS failure preserves the release intent and retries the same operation', async t => {
  const { store, before } = fixture(t);
  const operationId = randomUUID();
  let calls = 0;
  const flaky = {
    read: () => store.read(),
    compareAndSwap(input) {
      calls += 1;
      if (calls === 2) throw new ControlRecordError('CONTROL_RECORD_WRITE_FAILED', 'completion write failed');
      return store.compareAndSwap(input);
    },
  };
  const outcome = await commitExplicitRelease({ store: flaky, owner: owner(),
    controller: controller([]), operationId, counterBaseline: 0 });
  assert.equal(outcome.kind, 'incomplete');
  assert.equal(outcome.recordCommitted, true);
  assert.equal(outcome.completionCommitted, false);
  assert.equal(outcome.routeChanged, true);
  assert.equal(outcome.routeVerified, true);
  const partial = store.read();
  assert.equal(partial.revision, before.revision + 1);
  assert.equal(partial.intent.policy, 'released');
  assert.equal(partial.intent.releaseCompletion, undefined);
  const retry = await commitExplicitRelease({ store, owner: owner(), controller: controller([]), operationId,
    counterBaseline: 0 });
  assert.equal(retry.kind, 'released');
  assert.equal(retry.completionCommitted, true);
  assert.equal(store.read().revision, before.revision + 2);
  assert.equal(store.read().intent.releaseCompletion.routeVerified, true);
});

test('a concurrent recovery completion of the same release is reported as released', async t => {
  const { store, before } = fixture(t);
  const operationId = randomUUID();
  let calls = 0;
  const concurrent = {
    read: () => store.read(),
    compareAndSwap(input) {
      calls += 1;
      if (calls === 1) return store.compareAndSwap(input);
      const current = store.read();
      const recoveryCompletion = { kind: 'explicit-release-completion',
        operationId: randomUUID(), releaseOperationId: operationId,
        completedAt: '2026-10-22T00:00:01.000Z', routeChanged: false, routeVerified: true,
        routeEvidence: { atAuthor: true, fetchPreserved: true, dependenciesPreserved: true,
          actualSearchProvider: AUTHOR, originalSearchCalls: 0, originalSearchBaseline: 0,
          originalSearchDelta: 0 },
        recordCommit: { kind: 'explicit-release-recovery', previousRevision: current.revision,
          nextRevision: current.revision + 1 } };
      store.compareAndSwap({ expectedRevision: current.revision, intent: {
        ...current.intent, releaseCompletion: recoveryCompletion } });
      throw new ControlRecordError('CONTROL_CAS_CONFLICT', 'owner completion lost the race');
    },
  };
  const outcome = await commitExplicitRelease({ store: concurrent, owner: owner(),
    controller: controller([]), operationId, counterBaseline: 0 });
  assert.equal(outcome.kind, 'released');
  assert.equal(outcome.completionCommitted, true);
  assert.equal(outcome.completionSource, 'recovery');
  assert.equal(outcome.routeChanged, true);
  assert.equal(outcome.routeVerified, true);
  assert.equal(store.read().revision, before.revision + 2);
  assert.equal(store.read().intent.releaseCompletion.releaseOperationId, operationId);
});

test('ownership mismatch cannot commit a release or invalidate another owner route', async t => {
  const { store, before } = fixture(t);
  const events = [];
  await assert.rejects(() => commitExplicitRelease({ store, owner: owner({ hostId: OTHER_HOST_ID }),
    controller: controller(events), operationId: randomUUID(), counterBaseline: 0 }),
  error => error.code === 'CONTROL_RELEASE_OWNERSHIP_CONFLICT');
  assert.deepEqual(events, []);
  assert.deepEqual(store.read(), before);
});

test('a late writer wins the CAS and the stale release cannot overwrite it', async t => {
  const { store, before } = fixture(t);
  const events = [];
  const lateIntent = { ...before.intent, reason: 'late-required-writer' };
  const lateController = controller(events, {
    async drain() {
      events.push('drain');
      store.compareAndSwap({ expectedRevision: before.revision, intent: lateIntent, operationId: randomUUID() });
      return { settled: true, remaining: 0 };
    },
  });
  let caught;
  await assert.rejects(() => commitExplicitRelease({ store, owner: owner(), controller: lateController,
    operationId: randomUUID(), counterBaseline: 0 }), error => { caught = error; return error.code === 'CONTROL_CAS_CONFLICT'; });
  assert.equal(caught.releaseOutcome.recordCommitted, false);
  assert.equal(caught.releaseOutcome.inFlightInvalidated, true);
  assert.equal(caught.releaseOutcome.drainSettled, true);
  assert.equal(store.read().intent.reason, 'late-required-writer');
  assert.deepEqual(events, ['invalidate', 'drain']);
});

test('route restore failure preserves the released intent and reports incomplete verification', async t => {
  const { store } = fixture(t);
  const events = [];
  const outcome = await commitExplicitRelease({ store, owner: owner(), controller: controller(events, {
    async restore() { events.push('restore'); throw new ControlRecordError('TEST_RESTORE_FAILED', 'restore failed'); },
  }), operationId: randomUUID(), counterBaseline: 0 });
  assert.equal(outcome.kind, 'incomplete');
  assert.equal(outcome.recordCommitted, true);
  assert.equal(outcome.routeChanged, null);
  assert.equal(outcome.routeVerified, false);
  assert.equal(outcome.error.code, 'TEST_RESTORE_FAILED');
  assert.equal(store.read().intent.policy, 'released');
  assert.equal(store.read().intent.release.kind, 'intent-release-commit');
  assert.deepEqual(events, ['invalidate', 'drain', 'restore']);
});

test('route verification failure preserves the record commit and exposes the receipt', async t => {
  const { store } = fixture(t);
  const events = [];
  const receipt = { atAuthor: false, fetchPreserved: true, dependenciesPreserved: true,
    actualSearchProvider: 'wrong-provider', originalSearchCalls: 0, originalSearchBaseline: 0,
    originalSearchDelta: 0 };
  const outcome = await commitExplicitRelease({ store, owner: owner(), controller: controller(events, {
    async verify() { events.push('verify'); return receipt; },
  }), operationId: randomUUID(), counterBaseline: 0 });
  assert.equal(outcome.kind, 'incomplete');
  assert.equal(outcome.recordCommitted, true);
  assert.equal(outcome.routeChanged, true);
  assert.equal(outcome.routeVerified, false);
  assert.deepEqual(outcome.routeReceipt, receipt);
  assert.equal(store.read().intent.policy, 'released');
});

test('drain timeout does not commit a release', async t => {
  const { store, before } = fixture(t);
  const events = [];
  let caught;
  await assert.rejects(() => commitExplicitRelease({ store, owner: owner(), controller: controller(events, {
    async drain() { events.push('drain'); throw new ControlRecordError('CONTROL_RELEASE_DRAIN_TIMEOUT', 'still busy'); },
  }), operationId: randomUUID(), counterBaseline: 0 }), error => { caught = error; return error.code === 'CONTROL_RELEASE_DRAIN_TIMEOUT'; });
  assert.equal(caught.releaseOutcome.recordCommitted, false);
  assert.equal(caught.releaseOutcome.inFlightInvalidated, true);
  assert.equal(caught.releaseOutcome.drainSettled, false);
  assert.deepEqual(store.read(), before);
});

test('a plain in-flight controller failure is normalized with release evidence', async t => {
  const { store, before } = fixture(t);
  let caught;
  await assert.rejects(() => commitExplicitRelease({ store, owner: owner(), controller: controller([], {
    async drain() { throw new Error('plain drain failure'); },
  }), operationId: randomUUID(), counterBaseline: 0 }), error => {
    caught = error;
    return error.code === 'CONTROL_RELEASE_IN_FLIGHT';
  });
  assert.equal(caught.releaseOutcome.recordCommitted, false);
  assert.equal(caught.releaseOutcome.inFlightInvalidated, true);
  assert.equal(caught.releaseOutcome.drainSettled, false);
  assert.equal(caught.cause.message, 'plain drain failure');
  assert.deepEqual(store.read(), before);
});

test('the release barrier invalidates operations synchronously and drains after settlement', async () => {
  const barrier = createReleaseBarrier({ drainTimeoutMs: 40 });
  const operationId = randomUUID();
  barrier.begin({ operationId });
  const invalidated = barrier.invalidate({ reason: 'explicit-stop' });
  assert.equal(invalidated.state, 'stopping');
  assert.throws(() => barrier.assertActive(operationId), error => error.code === 'CONTROL_RELEASE_OPERATION_INVALIDATED');
  await assert.rejects(() => barrier.drain(), error => error.code === 'CONTROL_RELEASE_DRAIN_TIMEOUT');
  assert.equal(barrier.settle({ operationId }), true);
  const drained = await barrier.drain();
  assert.deepEqual(drained.activeOperationIds, []);
  assert.deepEqual(drained.invalidatedOperationIds, [operationId]);
});

test('malformed release transaction metadata is rejected before publication', t => {
  const { store } = fixture(t);
  const intent = requiredIntent({ policy: 'released', reason: 'malformed-release',
    release: { explicit: true, committedAt: '2026-10-22T00:00:00.000Z', kind: 'intent-release-commit',
      operationId: 'not-a-uuid', hostId: HOST_ID, pid: 1234, routeChanged: false, routeVerified: false } });
  assert.throws(() => store.compareAndSwap({ expectedRevision: 1, intent }),
    error => error instanceof ControlRecordError && error.code === 'CONTROL_RECORD_INVALID');
});

test('the release transaction core is an explicit package export', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./release-transaction'], './src/core/release-transaction.mjs');
  assert.match(manifest.scripts['test:release'], /release-transaction\.test\.mjs/);
});
