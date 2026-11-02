import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ControlRecordError, createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { completeDeferredStartup, completeReleaseRecovery } from '../src/core/startup-recovery.mjs';

// Synthetic observations/receipts exercise core validation only. They are not
// evidence that a real Host loaded legally or preserved its actual author route.
// All local fixtures (including child-process staging files) are retained.
const STORE_URL = new URL('../src/core/control-intent-store.mjs', import.meta.url).href;
const STARTUP_URL = new URL('../src/core/startup-recovery.mjs', import.meta.url).href;
const FORMAT = 'dsh-grok-search/control-intent';
const OLD_HOST = '00000000-0000-4000-8000-000000000001';
const NEW_HOST = '00000000-0000-4000-8000-000000000002';
const LOAD_ID = '00000000-0000-4000-8000-000000000003';
const SEARCH_BUNDLE = 'test-search-bundle';
const RECOVERY_BUNDLE = 'test-recovery-bundle';
const ACQUIRED_AT = '2026-10-19T00:00:00.000Z';
const OBSERVED_AT = '2026-10-20T00:00:00.000Z';
const ACQUIRED_HASH = 'a'.repeat(64);
const OBSERVED_HASH = 'b'.repeat(64);
const revisionName = revision => `v${String(revision).padStart(12, '0')}.json`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function requiredIntent(overrides = {}) {
  return {
    schemaVersion: 1, policy: 'required', reason: 'current-selected-search-acquisition',
    lease: { pid: 1234, uid: 'previous-search-owner', entryId: 'web',
      moduleName: '@deepseek-ai/dsh-web', provider: 'dsh-grok-search', hostId: OLD_HOST },
    acquiredSelection: [SEARCH_BUNDLE],
    acquisition: { source: 'current-selected-search-bundle', searchBundle: SEARCH_BUNDLE,
      selectedBundles: [SEARCH_BUNDLE], selectionSha256: ACQUIRED_HASH,
      observedAt: ACQUIRED_AT, hostId: OLD_HOST, ownerUid: 'previous-search-owner' },
    release: null,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    hostId: NEW_HOST, observedAt: OBSERVED_AT, selectionSha256: OBSERVED_HASH,
    selectedBundles: [RECOVERY_BUNDLE], searchBundle: SEARCH_BUNDLE, recoveryBundle: RECOVERY_BUNDLE,
    component: { role: 'recovery', bundle: RECOVERY_BUNDLE, ownerUid: 'recovery-owner',
      loadId: LOAD_ID, legalLoad: true },
    observer: { loadId: LOAD_ID, counter: { calls: 0, source: 'test-counter', adapterVersion: 1 } },
    authorSearchProvider: 'author-search-provider',
    ...overrides,
  };
}

function routeReceipt(input, overrides = {}) {
  const baseline = input.counterBaseline ?? 0;
  return { atAuthor: true, routeChanged: false, fetchPreserved: true, dependenciesPreserved: true,
    actualSearchProvider: input.authorSearchProvider, originalSearchCalls: baseline,
    originalSearchBaseline: baseline, originalSearchDelta: 0, ...overrides };
}

function fixture(t, { intent = requiredIntent(), seed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-recovery-test-'));
  const directory = join(root, 'control');
  t.diagnostic(`Retained fixture: ${root}`);
  const store = createControlIntentStore({ directory });
  const before = seed ? store.compareAndSwap({ expectedRevision: 0, intent }) : null;
  return { root, directory, store, before };
}

function names(directory) {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function diskSnapshot(directory) {
  return { exists: existsSync(directory), entries: names(directory).map(name => {
    const path = join(directory, name);
    const entry = lstatSync(path);
    return { name, kind: entry.isFile() ? 'file' : 'other', bytes: entry.isFile() ? readFileSync(path) : null };
  }) };
}

function runtime({ observations = [observation()], receipt } = {}) {
  const state = { observeCalls: 0, verifyCalls: 0, routeInputs: [], events: [] };
  return {
    state,
    async observe() {
      state.events.push('observe');
      const index = state.observeCalls++;
      return structuredClone(observations[Math.min(index, observations.length - 1)]);
    },
    async verifyRoute(input) {
      state.events.push('verify-route');
      state.verifyCalls++;
      state.routeInputs.push(structuredClone(input));
      return structuredClone(receipt === undefined ? routeReceipt(input) : receipt);
    },
  };
}

function unusedRuntime() {
  const state = { observeCalls: 0, verifyCalls: 0 };
  return {
    state,
    async observe() { state.observeCalls++; assert.fail('This result must not invoke an observer.'); },
    async verifyRoute() { state.verifyCalls++; assert.fail('This result must not verify or touch the route.'); },
  };
}

function readOnlyStore(store) {
  return { read: () => store.read(), compareAndSwap() { assert.fail('This branch must not attempt a record write.'); } };
}

async function expectCode(action, code) {
  let caught;
  await assert.rejects(action, error => {
    assert.ok(error instanceof ControlRecordError);
    assert.equal(error.code, code);
    caught = error;
    return true;
  });
  return caught;
}

function assertPassiveResult(result, kind, envelope) {
  assert.deepEqual(result, { kind, envelope, recordCommitted: false, routeVerified: false, routeChanged: false });
}

const INTERRUPTED_STARTUP = String.raw`
const [storeUrl, startupUrl, directory, observationJson, operationId, interruptAt] = process.argv.slice(1);
const { createControlIntentStore } = await import(storeUrl);
const { completeDeferredStartup } = await import(startupUrl);
const exitCodes = { 'before-publish': 81, 'after-publish': 82 };
const store = createControlIntentStore({ directory, fault(stage) {
  if (stage === interruptAt) process.exit(exitCodes[stage]);
} });
await completeDeferredStartup({ store, operationId,
  observe: async () => JSON.parse(observationJson),
  verifyRoute: async input => ({ atAuthor: true, routeChanged: false, fetchPreserved: true,
    dependenciesPreserved: true, actualSearchProvider: input.authorSearchProvider,
    originalSearchCalls: input.counterBaseline, originalSearchBaseline: input.counterBaseline,
    originalSearchDelta: 0 }) });
process.stderr.write('The requested startup interruption seam was not reached.\n');
process.exitCode = 1;
`;

function interruptStartup(args) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', INTERRUPTED_STARTUP, '--', ...args], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', spawnError = null;
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  return new Promise(resolve => {
    child.once('error', error => { spawnError = { code: error.code, message: error.message }; });
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, spawnError }));
  });
}

test('no record means no observer, route call, executor or write', async t => {
  const { directory, store } = fixture(t, { seed: false });
  const supplied = unusedRuntime();
  const before = diskSnapshot(directory);
  const result = await completeDeferredStartup({ store: readOnlyStore(store), ...supplied });
  assertPassiveResult(result, 'no-record', null);
  assert.deepEqual(supplied.state, { observeCalls: 0, verifyCalls: 0 });
  assert.deepEqual(diskSnapshot(directory), before);
  assert.equal(existsSync(directory), false);
});

test('old required intent is corrected only by a selected recovery component on a new legal Host', async t => {
  const prior = requiredIntent({ extraEvidence: { preserved: ['original-authorization'] } });
  const { directory, store, before } = fixture(t, { intent: prior });
  const oldBytes = readFileSync(join(directory, revisionName(1)));
  const operationId = randomUUID();
  const supplied = runtime();
  let casInput;
  const trackedStore = {
    read() { supplied.state.events.push('read'); return store.read(); },
    compareAndSwap(input) { supplied.state.events.push('cas'); casInput = input; return store.compareAndSwap(input); },
  };
  const result = await completeDeferredStartup({ store: trackedStore, observe: supplied.observe,
    verifyRoute: supplied.verifyRoute, operationId });
  assert.equal(result.kind, 'corrected');
  assert.equal(result.recordCommitted, true);
  assert.equal(result.routeVerified, true);
  assert.equal(result.routeChanged, false);
  assert.deepEqual(supplied.state.events, ['read', 'observe', 'verify-route', 'observe', 'cas']);
  assert.equal(supplied.state.observeCalls, 2);
  assert.equal(supplied.state.verifyCalls, 1);
  assert.deepEqual({ ...supplied.state.routeInputs[0], counterBaseline: undefined },
    { ...observation(), counterBaseline: undefined });
  assert.equal(supplied.state.routeInputs[0].counterBaseline, 0);
  assert.equal(casInput.expectedRevision, before.revision);
  assert.equal(casInput.operationId, operationId);
  const committed = result.envelope;
  assert.equal(committed.revision, 2);
  assert.equal(committed.operationId, operationId);
  assert.equal(committed.previousSha256, sha256(oldBytes));
  assert.equal(committed.intent.policy, 'released');
  assert.equal(committed.intent.release, null);
  assert.deepEqual(committed.intent.priorIntent, before.intent);
  for (const key of ['lease', 'acquisition', 'acquiredSelection', 'extraEvidence']) {
    assert.deepEqual(committed.intent[key], before.intent[key]);
  }
  const recovery = committed.intent.recovery;
  assert.equal(recovery.action, 'startup-state-correction');
  assert.equal(recovery.historicReleaseCommitted, false);
  assert.equal(recovery.previousPolicy, 'required');
  assert.equal(recovery.routeVerified, true);
  assert.equal(recovery.routeChanged, false);
  assert.deepEqual(recovery.originalLease, before.intent.lease);
  assert.equal(recovery.observerHostId, NEW_HOST);
  assert.equal(recovery.observerLoadId, LOAD_ID);
  assert.equal(recovery.observerOwnerUid, observation().component.ownerUid);
  assert.equal(recovery.observerBundle, RECOVERY_BUNDLE);
  assert.equal(recovery.observedAt, OBSERVED_AT);
  assert.equal(recovery.selectionSha256, OBSERVED_HASH);
  assert.deepEqual(recovery.selectedBundles, [RECOVERY_BUNDLE]);
  assert.equal(recovery.authorSearchProvider, observation().authorSearchProvider);
  assert.deepEqual(recovery.routeEvidence, routeReceipt(observation()));
  assert.deepEqual(recovery.recordCommit, { kind: 'startup-correction', operationId, previousRevision: 1, nextRevision: 2 });
  assert.deepEqual(recovery.exitEvidence, { source: 'profile-bundle-selection', searchBundle: SEARCH_BUNDLE,
    previousSelectionSha256: ACQUIRED_HASH, observedSelectionSha256: OBSERVED_HASH,
    searchBundleSelected: false, userClickObserved: false, ordinaryDisposeIsRelease: false });
  for (const value of [committed, committed.intent, committed.intent.priorIntent, recovery,
    recovery.originalLease, recovery.selectedBundles, recovery.routeEvidence, recovery.recordCommit]) assert.ok(Object.isFrozen(value));
  assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, revisionName(2)), 'utf8')), committed);
  assert.deepEqual(store.read(), committed);
  assert.equal(names(directory).filter(name => /^stage-/.test(name)).length, 2);
  assert.equal(existsSync(join(directory, revisionName(3))), false);
});

test('already-corrected is idempotent and requires no new observation or route verification', async t => {
  const { directory, store } = fixture(t);
  const supplied = runtime();
  const first = await completeDeferredStartup({ store, observe: supplied.observe, verifyRoute: supplied.verifyRoute });
  const before = diskSnapshot(directory);
  const unused = unusedRuntime();
  const retry = await completeDeferredStartup({ store: readOnlyStore(store), ...unused, operationId: randomUUID() });
  assertPassiveResult(retry, 'already-corrected', first.envelope);
  assert.equal(retry.envelope.revision, 2);
  assert.deepEqual(unused.state, { observeCalls: 0, verifyCalls: 0 });
  assert.deepEqual(diskSnapshot(directory), before);
});

test('already-released preserves explicit release and confirmed pause without an observer', async t => {
  const cases = [
    { name: 'explicit historic release', intent: requiredIntent({ policy: 'released', reason: 'confirmed user release',
      release: { explicit: true, committedAt: OBSERVED_AT, evidence: { userConfirmed: true } } }) },
    { name: 'confirmed pause in released policy', intent: requiredIntent({ policy: 'released', reason: 'confirmed pause',
      pause: { confirmed: true, confirmedAt: OBSERVED_AT } }) },
    { name: 'released without historic release evidence', intent: requiredIntent({ policy: 'released' }) },
  ];
  for (const entry of cases) await t.test(entry.name, async sub => {
    const { directory, store, before } = fixture(sub, { intent: entry.intent });
    const bytes = diskSnapshot(directory);
    const unused = unusedRuntime();
    const result = await completeDeferredStartup({ store: readOnlyStore(store), ...unused });
    assertPassiveResult(result, 'already-released', before);
    assert.deepEqual(result.envelope.intent, entry.intent);
    assert.deepEqual(unused.state, { observeCalls: 0, verifyCalls: 0 });
    assert.deepEqual(diskSnapshot(directory), bytes);
  });
});

test('an explicitly released intent is still corrected when a later legal load observes the search bundle unselected', async t => {
  const released = requiredIntent({
    policy: 'released', reason: 'explicit-user-release',
    priorIntent: requiredIntent(),
    pause: { confirmed: true, reason: 'explicit-user-release', observedAt: ACQUIRED_AT },
    release: { explicit: true, committedAt: ACQUIRED_AT, kind: 'intent-release-commit',
      operationId: '11111111-1111-4111-8111-111111111111', hostId: OLD_HOST, pid: 1234,
      author: 'author-search-provider', counterBaseline: 0, routeChanged: true, routeVerified: true },
  });
  const { directory, store } = fixture(t, { intent: released });
  const supplied = runtime();
  const result = await completeDeferredStartup({ store, observe: supplied.observe,
    verifyRoute: supplied.verifyRoute, operationId: randomUUID() });
  assert.equal(result.kind, 'corrected');
  assert.equal(result.recordCommitted, true);
  assert.equal(result.routeVerified, true);
  assert.equal(result.routeChanged, false);
  const after = store.read();
  assert.equal(after.revision, 2);
  assert.equal(after.intent.policy, 'released');
  assert.equal(after.intent.reason, 'legal-load-observed-unselected-at-author');
  assert.equal(after.intent.release, null);
  assert.equal(after.intent.releaseCompletion, undefined);
  assert.deepEqual(after.intent.priorIntent, released);
  assert.equal(after.intent.recovery.action, 'startup-state-correction');
  assert.equal(after.intent.recovery.historicReleaseCommitted, true);
  assert.equal(after.intent.recovery.previousPolicy, 'released');
  assert.equal(after.intent.recovery.exitEvidence.source, 'explicit-release-then-unselected');
});

test('a completed explicit release is never corrected for selected or unselected observations', async t => {
  const required = requiredIntent();
  const { store } = fixture(t, { intent: required });
  const releaseOperationId = randomUUID();
  const release = { ...required, policy: 'released', reason: 'completed-user-release',
    priorIntent: structuredClone(required), release: { explicit: true, committedAt: ACQUIRED_AT,
      kind: 'intent-release-commit', operationId: releaseOperationId, hostId: OLD_HOST, pid: 1234,
      author: 'author-search-provider', counterBaseline: 0, routeChanged: false, routeVerified: false } };
  const released = store.compareAndSwap({ expectedRevision: 1, intent: release });
  const completion = {
    kind: 'explicit-release-completion', operationId: randomUUID(),
    releaseOperationId, completedAt: ACQUIRED_AT, routeChanged: false, routeVerified: true,
    routeEvidence: routeReceipt({ authorSearchProvider: 'author-search-provider', counterBaseline: 0 }),
    recordCommit: { kind: 'explicit-release-completion', operationId: randomUUID(),
      previousRevision: released.revision, nextRevision: released.revision + 1 },
  };
  const completed = store.compareAndSwap({ expectedRevision: released.revision,
    intent: { ...release, releaseCompletion: completion } });
  let observeCalls = 0;
  let verifyCalls = 0;
  for (const selectedBundles of [[SEARCH_BUNDLE, RECOVERY_BUNDLE], [RECOVERY_BUNDLE]]) {
    const result = await completeDeferredStartup({
      store,
      observe: async () => { observeCalls += 1; return observation({ selectedBundles }); },
      verifyRoute: async () => { verifyCalls += 1; return routeReceipt(observation()); },
      operationId: randomUUID(),
    });
    assert.equal(result.kind, 'already-released');
    assert.equal(result.completionCommitted, true);
    assert.deepEqual(store.read(), completed);
  }
  assert.equal(observeCalls, 0);
  assert.equal(verifyCalls, 0);
  assert.equal(store.read().revision, completed.revision);
  assert.equal(store.read().intent.releaseCompletion.kind, 'explicit-release-completion');
});


test('startup correction can restore the recorded author route and reports route change separately', async t => {
  const prior = requiredIntent();
  const { store, before } = fixture(t, { intent: prior });
  const supplied = runtime({ receipt: routeReceipt(observation(), { routeChanged: true }) });
  const restoreCalls = [];
  const result = await completeDeferredStartup({ store, observe: supplied.observe, verifyRoute: supplied.verifyRoute,
    restoreRoute(input) { restoreCalls.push(input); return { routeChanged: true }; } });
  assert.equal(result.kind, 'corrected');
  assert.equal(result.routeChanged, true);
  assert.equal(result.envelope.intent.recovery.routeChanged, true);
  assert.equal(result.envelope.intent.recovery.routeEvidence.routeChanged, true);
  assert.equal(result.envelope.intent.release, null);
  assert.equal(result.envelope.intent.recovery.historicReleaseCommitted, false);
  assert.deepEqual(result.envelope.intent.priorIntent, before.intent);
  assert.equal(restoreCalls.length, 1);
  assert.equal(supplied.state.routeInputs[0].routeChanged, true);
  assert.deepEqual(supplied.state.events, ['observe', 'verify-route', 'observe']);
});

test('explicit release recovery preserves the release intent and completes it once', async t => {
  const releaseOperationId = randomUUID();
  const required = requiredIntent({ acquisition: { ...requiredIntent().acquisition,
    authorSearchProvider: 'author-search-provider' } });
  const released = { ...required, policy: 'released', reason: 'explicit-test-release',
    pause: { confirmed: true, reason: 'explicit-test-release', observedAt: OBSERVED_AT },
    priorIntent: structuredClone(required), release: { explicit: true, committedAt: OBSERVED_AT,
      kind: 'intent-release-commit', operationId: releaseOperationId, hostId: OLD_HOST, pid: 1234,
      author: 'author-search-provider', routeChanged: false, routeVerified: false } };
  const { store, before } = fixture(t, { intent: released });
  const supplied = runtime({ receipt: routeReceipt(observation(), { routeChanged: true }) });
  const result = await completeReleaseRecovery({ store, observe: supplied.observe, verifyRoute: supplied.verifyRoute,
    restoreRoute: () => ({ routeChanged: true }) });
  assert.equal(result.kind, 'completed');
  assert.equal(result.completionCommitted, true);
  assert.equal(result.routeChanged, true);
  const after = store.read();
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.intent.release, released.release);
  assert.deepEqual(after.intent.priorIntent, released.priorIntent);
  assert.equal(after.intent.releaseCompletion.kind, 'explicit-release-completion');
  assert.equal(after.intent.releaseCompletion.releaseOperationId, releaseOperationId);
  assert.equal(after.intent.releaseCompletion.routeVerified, true);
  assert.equal(after.intent.recovery.action, 'explicit-release-recovery');
  assert.equal(after.intent.recovery.historicReleaseCommitted, true);
  assert.deepEqual(after.intent.recovery.originalLease, required.lease);
  const unused = unusedRuntime();
  const repeat = await completeReleaseRecovery({ store: readOnlyStore(store), observe: unused.observe,
    restoreRoute: async () => assert.fail('completed recovery must not touch the route'),
    verifyRoute: unused.verifyRoute });
  assert.equal(repeat.kind, 'already-completed');
  assert.equal(repeat.completionCommitted, true);
  assert.deepEqual(unused.state, { observeCalls: 0, verifyCalls: 0 });
});
test('a confirmed pause is retained when a required record receives startup correction', async t => {
  const pause = { confirmed: true, confirmedAt: OBSERVED_AT, reason: 'explicit user pause', evidence: { supplied: true } };
  const { directory, store, before } = fixture(t, { intent: requiredIntent({ pause }) });
  const oldBytes = readFileSync(join(directory, revisionName(1)));
  const supplied = runtime();
  const result = await completeDeferredStartup({ store, observe: supplied.observe, verifyRoute: supplied.verifyRoute });
  assert.equal(result.kind, 'corrected');
  assert.equal(result.envelope.intent.policy, 'released');
  assert.equal(result.envelope.intent.release, null);
  assert.deepEqual(result.envelope.intent.pause, pause);
  assert.deepEqual(result.envelope.intent.priorIntent, before.intent);
  assert.deepEqual(result.envelope.intent.priorIntent.pause, pause);
  assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
});

test('a selected search bundle is still-selected without route verification, authorization or CAS', async t => {
  const cases = [
    { name: 'selected recovery alongside selected search', input: observation({ selectedBundles: [SEARCH_BUNDLE, RECOVERY_BUNDLE] }) },
    { name: 'legal selected search owner', input: observation({ selectedBundles: [SEARCH_BUNDLE],
      component: { role: 'search-owner', bundle: SEARCH_BUNDLE, ownerUid: 'current-search-owner', loadId: LOAD_ID, legalLoad: true } }) },
    { name: 'same host while search remains selected', input: observation({ hostId: OLD_HOST,
      selectedBundles: [SEARCH_BUNDLE, RECOVERY_BUNDLE] }) },
    { name: 'no provenance needed to refuse further authorization', input: observation({ selectedBundles: [SEARCH_BUNDLE, RECOVERY_BUNDLE] }),
      intent: { schemaVersion: 1, policy: 'required', reason: 'record without provenance', release: null } },
  ];
  for (const entry of cases) await t.test(entry.name, async sub => {
    const { directory, store, before } = fixture(sub, { intent: entry.intent ?? requiredIntent() });
    const bytes = diskSnapshot(directory);
    const supplied = runtime({ observations: [entry.input] });
    const result = await completeDeferredStartup({ store: readOnlyStore(store), observe: supplied.observe, verifyRoute: supplied.verifyRoute });
    assertPassiveResult(result, 'still-selected', before);
    assert.equal(supplied.state.observeCalls, 1);
    assert.equal(supplied.state.verifyCalls, 0);
    assert.deepEqual(diskSnapshot(directory), bytes);
  });
});

test('no legal selected executor fails before route work, including when search is still selected', async t => {
  const cases = [
    { name: 'no components or selected bundles', input: observation({ selectedBundles: [], component: null }) },
    { name: 'no component despite selected recovery', input: observation({ component: null }) },
    { name: 'recovery is not selected', input: observation({ selectedBundles: ['unrelated-bundle'] }) },
    { name: 'load is not legal', input: observation({ component: { ...observation().component, legalLoad: false } }) },
    { name: 'ordinary component is not an executor', input: observation({ component: { ...observation().component, role: 'ordinary' } }) },
    { name: 'mismatched component bundle', input: observation({ component: { ...observation().component, bundle: 'unrelated-bundle' } }) },
    { name: 'unselected search owner cannot recover', input: observation({ component: { ...observation().component,
      role: 'search-owner', bundle: SEARCH_BUNDLE } }) },
    { name: 'component has no owner', input: observation({ component: { ...observation().component, ownerUid: '' } }) },
    { name: 'component has no load UUID', input: observation({ component: { ...observation().component, loadId: 'not-a-uuid' } }) },
    { name: 'still-selected with no legal component', input: observation({ selectedBundles: [SEARCH_BUNDLE], component: null }) },
  ];
  for (const entry of cases) await t.test(entry.name, async sub => {
    const { directory, store } = fixture(sub);
    const before = diskSnapshot(directory);
    const supplied = runtime({ observations: [entry.input] });
    await expectCode(() => completeDeferredStartup({ store: readOnlyStore(store), observe: supplied.observe,
      verifyRoute: supplied.verifyRoute }), 'CONTROL_LEGAL_LOAD_REQUIRED');
    assert.equal(supplied.state.observeCalls, 1);
    assert.equal(supplied.state.verifyCalls, 0);
    assert.deepEqual(diskSnapshot(directory), before);
  });
});

test('a same live Host cannot turn startup correction into a historic or live release', async t => {
  const { directory, store, before } = fixture(t);
  const bytes = diskSnapshot(directory);
  const supplied = runtime({ observations: [observation({ hostId: OLD_HOST })] });
  await expectCode(() => completeDeferredStartup({ store: readOnlyStore(store), observe: supplied.observe,
    verifyRoute: supplied.verifyRoute }), 'CONTROL_STARTUP_SAME_HOST');
  assert.equal(supplied.state.observeCalls, 1);
  assert.equal(supplied.state.verifyCalls, 0);
  assert.deepEqual(store.read(), before);
  assert.equal(store.read().intent.policy, 'required');
  assert.equal(store.read().intent.release, null);
  assert.deepEqual(diskSnapshot(directory), bytes);
});

test('same-host startup correction is allowed only when the owner is explicitly absent', async t => {
  const { store, before } = fixture(t);
  const input = observation({ hostId: OLD_HOST, ownerPresent: false });
  const supplied = runtime({ observations: [input], receipt: routeReceipt(input, { routeChanged: true }) });
  const result = await completeDeferredStartup({ store, observe: supplied.observe, verifyRoute: supplied.verifyRoute,
    restoreRoute: () => ({ routeChanged: true }) });
  assert.equal(result.kind, 'corrected');
  assert.equal(result.routeChanged, true);
  assert.equal(result.envelope.intent.recovery.routeChanged, true);
  assert.equal(result.envelope.intent.recovery.exitEvidence.ownerAbsent, true);
  assert.deepEqual(result.envelope.intent.priorIntent, before.intent);
  assert.equal(result.envelope.intent.release, null);
});

test('missing or mismatched acquisition provenance cannot authorize startup correction', async t => {
  const cases = [
    { name: 'missing lease', change: intent => { delete intent.lease; } },
    { name: 'missing historic host', change: intent => { delete intent.lease.hostId; } },
    { name: 'wrong entry', change: intent => { intent.lease.entryId = 'ordinary-entry'; } },
    { name: 'wrong module', change: intent => { intent.lease.moduleName = '@example/ordinary-module'; } },
    { name: 'missing acquisition', change: intent => { delete intent.acquisition; } },
    { name: 'wrong acquisition source', change: intent => { intent.acquisition.source = 'manual-assumption'; } },
    { name: 'mismatched search bundle', change: intent => { intent.acquisition.searchBundle = 'another-search-bundle'; } },
    { name: 'acquisition host does not match prior lease', change: intent => { intent.acquisition.hostId = NEW_HOST; } },
    { name: 'invalid acquired fingerprint', change: intent => { intent.acquisition.selectionSha256 = 'not-a-digest'; } },
    { name: 'invalid acquisition timestamp', change: intent => { intent.acquisition.observedAt = 'not-a-timestamp'; } },
    { name: 'missing acquisition owner', change: intent => { delete intent.acquisition.ownerUid; } },
    { name: 'negative acquisition owner', change: intent => { intent.acquisition.ownerUid = -1; } },
    { name: 'missing acquired selected bundles', change: intent => { delete intent.acquisition.selectedBundles; } },
    { name: 'search was not selected at acquisition', change: intent => { intent.acquisition.selectedBundles = [RECOVERY_BUNDLE]; } },
  ];
  for (const entry of cases) await t.test(entry.name, async sub => {
    const intent = requiredIntent();
    entry.change(intent);
    const { directory, store } = fixture(sub, { intent });
    const before = diskSnapshot(directory);
    const supplied = runtime();
    await expectCode(() => completeDeferredStartup({ store: readOnlyStore(store), observe: supplied.observe,
      verifyRoute: supplied.verifyRoute }), 'CONTROL_RECOVERY_PROVENANCE_REQUIRED');
    assert.equal(supplied.state.observeCalls, 1);
    assert.equal(supplied.state.verifyCalls, 0);
    assert.deepEqual(diskSnapshot(directory), before);
  });
});

test('malformed supplied observations fail closed without writes or route verification', async t => {
  const cases = [
    { name: 'no observation', input: null },
    { name: 'invalid host UUID', input: observation({ hostId: 'not-a-uuid' }) },
    { name: 'invalid observed timestamp', input: observation({ observedAt: 'not-a-timestamp' }) },
    { name: 'invalid selection digest', input: observation({ selectionSha256: 'not-a-digest' }) },
    { name: 'selected bundles are not an array', input: observation({ selectedBundles: RECOVERY_BUNDLE }) },
    { name: 'duplicate selected bundles', input: observation({ selectedBundles: [RECOVERY_BUNDLE, RECOVERY_BUNDLE] }) },
    { name: 'empty selected bundle', input: observation({ selectedBundles: [RECOVERY_BUNDLE, ''] }) },
    { name: 'invalid author provider', input: observation({ authorSearchProvider: 42 }) },
  ];
  for (const entry of cases) await t.test(entry.name, async sub => {
    const { directory, store } = fixture(sub);
    const before = diskSnapshot(directory);
    const supplied = runtime({ observations: [entry.input] });
    await expectCode(() => completeDeferredStartup({ store: readOnlyStore(store), observe: supplied.observe,
      verifyRoute: supplied.verifyRoute }), 'CONTROL_RECOVERY_OBSERVATION_INVALID');
    assert.equal(supplied.state.observeCalls, 1);
    assert.equal(supplied.state.verifyCalls, 0);
    assert.deepEqual(diskSnapshot(directory), before);
  });
});

// D-28 single-bundle build: search and recovery entries share one bundle. That is a legal
// observation, but the shared bundle is the search bundle, so a selected bundle must still
// refuse correction instead of authorizing or releasing anything.
test('a single bundle hosting both search and recovery is still-selected, never a correction', async t => {
  const { directory, store, before } = fixture(t);
  const bytes = diskSnapshot(directory);
  const supplied = runtime({ observations: [observation({ searchBundle: RECOVERY_BUNDLE })] });
  const result = await completeDeferredStartup({ store: readOnlyStore(store), observe: supplied.observe,
    verifyRoute: supplied.verifyRoute });
  assertPassiveResult(result, 'still-selected', before);
  assert.equal(supplied.state.verifyCalls, 0);
  assert.deepEqual(diskSnapshot(directory), bytes);
});

test('every author-route receipt predicate is required before re-observation and CAS', async t => {
  const missingCalls = routeReceipt(observation());
  delete missingCalls.originalSearchCalls;
  const cases = [
    { name: 'no receipt', receipt: null },
    { name: 'not at author route', receipt: routeReceipt(observation(), { atAuthor: false }) },
    { name: 'route was changed', receipt: routeReceipt(observation(), { routeChanged: true }) },
    { name: 'fetch was replaced', receipt: routeReceipt(observation(), { fetchPreserved: false }) },
    { name: 'dependencies were replaced', receipt: routeReceipt(observation(), { dependenciesPreserved: false }) },
    { name: 'wrong actual provider', receipt: routeReceipt(observation(), { actualSearchProvider: 'different-provider' }) },
    { name: 'original search was called', receipt: routeReceipt(observation(), { originalSearchCalls: 1 }) },
    { name: 'missing original-call evidence', receipt: missingCalls },
  ];
  for (const entry of cases) await t.test(entry.name, async sub => {
    const { directory, store } = fixture(sub);
    const before = diskSnapshot(directory);
    const supplied = runtime({ receipt: entry.receipt });
    const error = await expectCode(() => completeDeferredStartup({ store: readOnlyStore(store), observe: supplied.observe,
      verifyRoute: supplied.verifyRoute }), 'CONTROL_RECOVERY_ROUTE_UNVERIFIED');
    assert.equal(supplied.state.observeCalls, 1);
    assert.equal(supplied.state.verifyCalls, 1);
    assert.equal(Object.hasOwn(error, 'recoveryOutcome'), false);
    assert.deepEqual(diskSnapshot(directory), before);
  });
});

test('a nullable author provider and numeric zero owner identities are valid supplied evidence', async t => {
  const prior = requiredIntent();
  prior.lease.uid = 0;
  prior.acquisition.ownerUid = 0;
  const { store } = fixture(t, { intent: prior });
  const supplied = runtime({ observations: [observation({ authorSearchProvider: null,
    component: { ...observation().component, ownerUid: 0 } })] });
  const result = await completeDeferredStartup({ store, observe: supplied.observe, verifyRoute: supplied.verifyRoute });
  assert.equal(result.kind, 'corrected');
  assert.equal(result.envelope.intent.recovery.authorSearchProvider, null);
  assert.equal(result.envelope.intent.recovery.routeEvidence.actualSearchProvider, null);
  assert.equal(result.envelope.intent.recovery.observerOwnerUid, 0);
  assert.equal(result.envelope.intent.recovery.originalLease.uid, 0);
});

test('re-observation rejects changed selection, Host, component or route identity before CAS', async t => {
  const first = observation();
  const cases = [
    { name: 'selection fingerprint changed', second: observation({ selectionSha256: 'c'.repeat(64) }) },
    { name: 'selected bundle set changed', second: observation({ selectedBundles: [RECOVERY_BUNDLE, 'other-bundle'] }) },
    { name: 'Host changed', second: observation({ hostId: randomUUID() }) },
    { name: 'component load changed', second: observation({ component: { ...first.component, loadId: randomUUID() } }) },
    { name: 'component owner changed', second: observation({ component: { ...first.component, ownerUid: 'another-owner' } }) },
    { name: 'search was selected again', second: observation({ selectedBundles: [RECOVERY_BUNDLE, SEARCH_BUNDLE] }) },
    { name: 'legal executor role changed', second: observation({ selectedBundles: [RECOVERY_BUNDLE, SEARCH_BUNDLE],
      component: { ...first.component, role: 'search-owner', bundle: SEARCH_BUNDLE } }) },
    { name: 'author provider changed', second: observation({ authorSearchProvider: 'different-provider' }) },
  ];
  for (const entry of cases) await t.test(entry.name, async sub => {
    const { directory, store } = fixture(sub);
    const before = diskSnapshot(directory);
    const supplied = runtime({ observations: [first, entry.second] });
    await expectCode(() => completeDeferredStartup({ store: readOnlyStore(store), observe: supplied.observe,
      verifyRoute: supplied.verifyRoute }), 'CONTROL_RECOVERY_INPUT_CHANGED');
    assert.equal(supplied.state.observeCalls, 2);
    assert.equal(supplied.state.verifyCalls, 1);
    assert.deepEqual(supplied.state.events, ['observe', 'verify-route', 'observe']);
    assert.deepEqual(diskSnapshot(directory), before);
  });
});

test('a later observedAt alone is allowed when the re-observed input identity is unchanged', async t => {
  const { store } = fixture(t);
  const first = observation();
  const second = observation({ observedAt: '2026-10-20T00:00:01.000Z' });
  const supplied = runtime({ observations: [first, second] });
  const result = await completeDeferredStartup({ store, observe: supplied.observe, verifyRoute: supplied.verifyRoute });
  assert.equal(result.kind, 'corrected');
  assert.equal(result.envelope.intent.recovery.observedAt, first.observedAt);
  assert.equal(supplied.state.observeCalls, 2);
  assert.equal(supplied.state.verifyCalls, 1);
});

test('loss of the legal executor during re-observation still forbids publication', async t => {
  const { directory, store } = fixture(t);
  const before = diskSnapshot(directory);
  const supplied = runtime({ observations: [observation(), observation({ selectedBundles: [], component: null })] });
  await expectCode(() => completeDeferredStartup({ store: readOnlyStore(store), observe: supplied.observe,
    verifyRoute: supplied.verifyRoute }), 'CONTROL_LEGAL_LOAD_REQUIRED');
  assert.equal(supplied.state.observeCalls, 2);
  assert.equal(supplied.state.verifyCalls, 1);
  assert.deepEqual(diskSnapshot(directory), before);
});

test('corrupt and gapped records fail before invoking a supplied Host adapter', async t => {
  const rawEnvelope = overrides => ({ format: FORMAT, schemaVersion: 1, revision: 1,
    operationId: randomUUID(), previousSha256: null, intent: requiredIntent(), ...overrides });
  const cases = [
    { name: 'damaged JSON', nameOnDisk: revisionName(1), bytes: Buffer.from('{ original damaged evidence\n') },
    { name: 'unknown format', nameOnDisk: revisionName(1), bytes: encode(rawEnvelope({ format: 'unknown/control-intent' })) },
    { name: 'unsupported schema', nameOnDisk: revisionName(1), bytes: encode(rawEnvelope({ schemaVersion: 2 })),
      code: 'CONTROL_RECORD_VERSION_UNSUPPORTED' },
    { name: 'missing first revision', nameOnDisk: revisionName(2), bytes: encode(rawEnvelope({ revision: 2 })) },
    { name: 'invalid required policy', nameOnDisk: revisionName(1), bytes: encode(rawEnvelope({ intent: requiredIntent({ policy: 'unknown' }) })) },
  ];
  for (const entry of cases) await t.test(entry.name, async sub => {
    const { directory, store } = fixture(sub, { seed: false });
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, entry.nameOnDisk), entry.bytes, { flag: 'wx' });
    const before = diskSnapshot(directory);
    const unused = unusedRuntime();
    await expectCode(() => completeDeferredStartup({ store: readOnlyStore(store), ...unused }), entry.code ?? 'CONTROL_RECORD_INVALID');
    assert.deepEqual(unused.state, { observeCalls: 0, verifyCalls: 0 });
    assert.deepEqual(diskSnapshot(directory), before);
  });
});

test('legacy evidence blocks startup recovery even when a valid required revision also exists', async t => {
  const { root, directory } = fixture(t);
  const legacyPath = join(root, 'legacy.json');
  const raw = Buffer.from('unversioned original evidence\n');
  writeFileSync(legacyPath, raw, { flag: 'wx' });
  const store = createControlIntentStore({ directory, legacyPath });
  const before = diskSnapshot(directory);
  const unused = unusedRuntime();
  await expectCode(() => completeDeferredStartup({ store: readOnlyStore(store), ...unused }), 'CONTROL_RECORD_MIGRATION_REQUIRED');
  assert.deepEqual(unused.state, { observeCalls: 0, verifyCalls: 0 });
  assert.deepEqual(diskSnapshot(directory), before);
  assert.deepEqual(readFileSync(legacyPath), raw);
});

test('startup write faults report route verification separately from the actual disk commit state', async t => {
  for (const interruptAt of ['before-stage-write', 'before-publish', 'after-publish']) await t.test(interruptAt, async sub => {
    const { directory, store: normal, before } = fixture(sub);
    const oldBytes = readFileSync(join(directory, revisionName(1)));
    const originalDisk = diskSnapshot(directory);
    const operationId = randomUUID();
    let context;
    const store = createControlIntentStore({ directory, fault(stage, details) {
      if (stage !== interruptAt) return;
      context = details;
      const error = new Error('Injected startup commit interruption.');
      error.code = 'E_TEST_STARTUP_WRITE';
      throw error;
    } });
    const supplied = runtime();
    const published = interruptAt === 'after-publish';
    const error = await expectCode(() => completeDeferredStartup({ store, observe: supplied.observe,
      verifyRoute: supplied.verifyRoute, operationId }), published
      ? 'CONTROL_RECORD_COMMIT_UNCERTAIN' : 'CONTROL_RECORD_WRITE_FAILED');
    assert.deepEqual(error.recoveryOutcome, { kind: 'incomplete', routeVerified: true, routeChanged: false,
      recordCommitted: published ? null : false, operationId, expectedRevision: 1 });
    assert.ok(Object.isFrozen(error.recoveryOutcome));
    assert.equal(error.details.operationId, operationId);
    assert.equal(error.details.published, published);
    assert.equal(error.details.causeCode, 'E_TEST_STARTUP_WRITE');
    assert.equal(supplied.state.observeCalls, 2);
    assert.equal(supplied.state.verifyCalls, 1);
    assert.equal(existsSync(context.targetPath), published);
    assert.equal(existsSync(context.stagePath), interruptAt !== 'before-stage-write');
    assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
    let stagedBytes;
    if (interruptAt === 'before-stage-write') assert.deepEqual(diskSnapshot(directory), originalDisk);
    else {
      stagedBytes = readFileSync(context.stagePath);
      const staged = JSON.parse(stagedBytes.toString('utf8'));
      assert.equal(staged.operationId, operationId);
      assert.equal(staged.intent.policy, 'released');
      assert.equal(staged.intent.release, null);
      assert.deepEqual(staged.intent.priorIntent, before.intent);
    }
    const diskRecord = normal.read();
    assert.equal(diskRecord.revision, published ? 2 : 1);
    if (published) {
      assert.equal(diskRecord.operationId, operationId);
      assert.deepEqual(readFileSync(context.targetPath), stagedBytes);
      const finalDisk = diskSnapshot(directory);
      const unused = unusedRuntime();
      const retry = await completeDeferredStartup({ store: readOnlyStore(normal), ...unused, operationId });
      assertPassiveResult(retry, 'already-corrected', diskRecord);
      assert.deepEqual(diskSnapshot(directory), finalDisk);
      assert.deepEqual(unused.state, { observeCalls: 0, verifyCalls: 0 });
    } else {
      assert.deepEqual(diskRecord, before);
      const retryInput = runtime();
      const retry = await completeDeferredStartup({ store: normal, observe: retryInput.observe,
        verifyRoute: retryInput.verifyRoute, operationId });
      assert.equal(retry.kind, 'corrected');
      assert.equal(retry.envelope.revision, 2);
      assert.equal(retry.envelope.operationId, operationId);
      if (stagedBytes) assert.deepEqual(readFileSync(context.stagePath), stagedBytes);
    }
    assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
    assert.equal(existsSync(join(directory, revisionName(3))), false);
  });
});

test('a concurrent confirmed release or pause wins CAS and cannot be erased by a stale correction', async t => {
  for (const kind of ['release', 'pause']) await t.test(kind, async sub => {
    const { directory, store, before } = fixture(sub);
    const oldBytes = readFileSync(join(directory, revisionName(1)));
    const operationId = randomUUID();
    let observations = 0, routeCalls = 0, winner, winnerBytes;
    const intent = kind === 'release'
      ? requiredIntent({ policy: 'released', reason: 'concurrent confirmed release',
        release: { explicit: true, committedAt: OBSERVED_AT } })
      : requiredIntent({ reason: 'concurrent confirmed pause', pause: { confirmed: true, confirmedAt: OBSERVED_AT } });
    const error = await expectCode(() => completeDeferredStartup({ store, operationId,
      observe: async () => {
        if (++observations === 2) {
          winner = store.compareAndSwap({ expectedRevision: before.revision, intent });
          winnerBytes = readFileSync(join(directory, revisionName(2)));
        }
        return observation();
      },
      verifyRoute: async input => { routeCalls++; return routeReceipt(input); },
    }), 'CONTROL_CAS_CONFLICT');
    assert.deepEqual(error.recoveryOutcome, { kind: 'incomplete', routeVerified: true, routeChanged: false,
      recordCommitted: false, operationId, expectedRevision: 1 });
    assert.equal(observations, 2);
    assert.equal(routeCalls, 1);
    assert.deepEqual(store.read(), winner);
    assert.deepEqual(store.read().intent, intent);
    assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
    assert.deepEqual(readFileSync(join(directory, revisionName(2))), winnerBytes);
    assert.equal(names(directory).filter(name => /^stage-/.test(name)).length, 2);
    assert.equal(existsSync(join(directory, revisionName(3))), false);
  });
});

test('startup process interruption before/after publish preserves evidence and restarts idempotently',
  { timeout: 45_000 }, async t => {
    for (const interruptAt of ['before-publish', 'after-publish']) await t.test(interruptAt, async sub => {
      const { directory, store, before } = fixture(sub);
      const oldBytes = readFileSync(join(directory, revisionName(1)));
      const operationId = randomUUID();
      const result = await interruptStartup([STORE_URL, STARTUP_URL, directory, JSON.stringify(observation()), operationId, interruptAt]);
      assert.equal(result.spawnError, null);
      assert.equal(result.signal, null);
      assert.equal(result.code, interruptAt === 'before-publish' ? 81 : 82, result.stderr);
      assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
      const stageNames = names(directory).filter(name => /^stage-/.test(name));
      assert.equal(stageNames.length, 2);
      const attempt = stageNames.find(name => JSON.parse(readFileSync(join(directory, name), 'utf8')).operationId === operationId);
      assert.ok(attempt);
      const stagedBytes = readFileSync(join(directory, attempt));
      const staged = JSON.parse(stagedBytes.toString('utf8'));
      assert.equal(staged.intent.policy, 'released');
      assert.equal(staged.intent.release, null);
      assert.deepEqual(staged.intent.priorIntent, before.intent);
      assert.equal(staged.intent.recovery.historicReleaseCommitted, false);
      const published = interruptAt === 'after-publish';
      const restartedStore = createControlIntentStore({ directory });
      assert.equal(restartedStore.read().revision, published ? 2 : 1);
      assert.equal(existsSync(join(directory, revisionName(2))), published);
      if (published) {
        assert.equal(restartedStore.read().operationId, operationId);
        assert.deepEqual(readFileSync(join(directory, revisionName(2))), stagedBytes);
        const finalDisk = diskSnapshot(directory);
        const unused = unusedRuntime();
        const resumed = await completeDeferredStartup({ store: readOnlyStore(restartedStore), ...unused, operationId });
        assertPassiveResult(resumed, 'already-corrected', restartedStore.read());
        assert.deepEqual(unused.state, { observeCalls: 0, verifyCalls: 0 });
        assert.deepEqual(diskSnapshot(directory), finalDisk);
      } else {
        assert.deepEqual(restartedStore.read(), before);
        const supplied = runtime();
        const resumed = await completeDeferredStartup({ store: restartedStore, observe: supplied.observe,
          verifyRoute: supplied.verifyRoute, operationId });
        assert.equal(resumed.kind, 'corrected');
        assert.equal(resumed.envelope.revision, 2);
        assert.equal(resumed.envelope.operationId, operationId);
        assert.equal(names(directory).filter(name => /^stage-/.test(name)).length, 3);
      }
      assert.deepEqual(readFileSync(join(directory, attempt)), stagedBytes);
      assert.deepEqual(readFileSync(join(directory, revisionName(1))), oldBytes);
      assert.equal(store.read().revision, 2);
      assert.equal(existsSync(join(directory, revisionName(3))), false);
    });
  });
