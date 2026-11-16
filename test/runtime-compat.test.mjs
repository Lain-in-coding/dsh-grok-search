import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPATIBILITY_REPORT } from '../src/core/compatibility-contract.mjs';
import {
  MINIMUM_DSH_VERSION, CORE_CONTRACT_CHECKS, assessRuntimeCapabilities,
  createRuntimeCompatibility, evaluateRuntimeVersion,
} from '../src/core/runtime-compat.mjs';

const pluginVersion = '0.4.0';
const revision = 'a'.repeat(64);
const completeChecks = () => Object.fromEntries(CORE_CONTRACT_CHECKS.map(name => [name, true]));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Synthetic ABI surfaces, not proof of a real DSH installation or release.
function host({ modern = true } = {}) {
  const raw = { searchProvider: 'original', fetchProvider: 'preserved' };
  const volatile = value => ({ get: () => value });
  const fiber = {
    uid: 1, state: 2, config: { ...raw },
    update() {}, await() {}, dispose() {},
  };
  if (modern) Object.assign(fiber, {
    rawConfig: fiber.config,
    effectiveConfig: { searchProvider: volatile('original'), fetchProvider: volatile('preserved') },
    resolveConfig: candidate => candidate,
  });
  const web = { registerSearchProvider() {}, search() {}, fetch() {} };
  const entry = { options: { id: 'web', name: '@deepseek-ai/dsh-web' }, fiber, update() {} };
  const entries = [entry];
  const services = {
    loader: { entries: () => entries.values() }, profileContext: { dir: '/synthetic/profile' },
    tools: { register() {}, get() {}, checkGuards() {} }, web,
  };
  const ctx = { get: key => services[key], on() {}, effect() {}, plugin() {}, registry: new Map() };
  return { ctx, services, entries, entry, fiber, web };
}

function memoryState(hostVersion, confirmed = false) {
  let value = { hostVersion, pluginVersion, revision, confirmed, notified: confirmed, errorCode: null };
  const listeners = new Set(), writes = [];
  return {
    snapshot: () => ({ ...value }),
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    confirm() { writes.push('confirm'); },
    revoke() { writes.push('revoke'); },
    markNotified() { writes.push('notify'); },
    change(next) { value = { ...value, ...next }; for (const listener of listeners) listener(); },
    get writes() { return writes; },
    get subscribers() { return listeners.size; },
  };
}

function prepare(compat, fixture = host(), checks = completeChecks()) {
  const token = compat.captureEpoch();
  const result = assessRuntimeCapabilities({ ctx: fixture.ctx, token, contractChecks: checks });
  compat.setCapabilities(result);
  return { token, result, fixture };
}

function finish(compat, token) {
  assert.equal(compat.setCapabilities({ token, stage: 'route', confirmed: true }), true);
  assert.equal(compat.setCapabilities({ token, stage: 'budget', confirmed: true }), true);
  assert.equal(compat.markReady(token), true);
}

function validReport(compat) {
  const value = compat.snapshot();
  const parsed = COMPATIBILITY_REPORT.create().safeParse(value);
  assert.equal(parsed.success, true, JSON.stringify(value));
  assert.deepEqual(compat.report(), value);
  assert.equal(value.verification, 'unverified');
  return value;
}

test('minimum is unbounded for canonical stable and standard rc versions', () => {
  assert.equal(MINIMUM_DSH_VERSION, '0.2.1-rc.2');
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.2-rc.3', '0.2.1', '1.0.0', '999.0.0-rc.1']) {
    const value = evaluateRuntimeVersion(version);
    assert.equal(value.hostVersion, version);
    assert.equal(value.minimumAdmitted, true);
    assert.equal(value.confirmationRequired, false);
    assert.equal(value.code, null);
    assert.equal(value.verification, 'unverified');
  }
  for (const version of ['0.2.1-rc.1', '0.2.1-beta.99', '0.2.0', '0.0.0']) {
    const value = evaluateRuntimeVersion(version);
    assert.equal(value.minimumAdmitted, false);
    assert.equal(value.confirmationRequired, false);
    assert.equal(value.code, 'COMPATIBILITY_MINIMUM_REQUIRED');
  }
});

test('unknown or malformed host versions defer to capability checks; old valid versions remain below the floor', () => {
  for (const version of [undefined, null, '', ' v0.2.2-rc.3', 'v0.2.2-rc.3', '=0.2.2-rc.3',
    '0.2.2-rc.3 ', '0.2.2-rc.03', '0.02.2', '0.2', '1.0.0-', '1.0.0+', '1.0.0\n',
    1, {}, ['1.0.0'], '9007199254740992.0.0', '1.0.0+' + 'x'.repeat(130)]) {
    const value = evaluateRuntimeVersion(version);
    assert.equal(value.hostVersion, null);
    assert.equal(value.minimumAdmitted, true);
    assert.equal(value.confirmationRequired, false);
    assert.equal(value.code, null);
    const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion });
    assert.equal(validReport(compat).phase, 'initial');
    assert.equal(validReport(compat).code, 'COMPATIBILITY_CORE_PENDING');
    assert.equal(compat.canAcquireRoute(), false);
  }
  for (const version of ['0.2.1-rc.1', '0.2.1-beta.99', '0.2.0', '0.0.0']) {
    assert.equal(evaluateRuntimeVersion(version).code, 'COMPATIBILITY_MINIMUM_REQUIRED');
  }
});

test('all prerelease channels above the floor use the same capability admission; build identity stays exact', () => {
  for (const [version, channel] of [
    ['0.2.2-alpha.1', 'alpha'], ['0.2.2-beta.1', 'beta'], ['1.0.0-nightly.4', 'other'],
    ['1.0.0-rc', 'other'], ['1.0.0-rc.experimental', 'other'], ['1.0.0-RC.1', 'other'],
    ['1.0.0-rc.1.dev', 'other'],
  ]) {
    const value = evaluateRuntimeVersion(version);
    assert.equal(value.channel, channel);
    assert.equal(value.confirmationRequired, false);
    assert.equal(value.minimumAdmitted, true);
    assert.equal(value.code, null);
  }
  const version = '0.2.2-rc.3+build.01';
  assert.equal(evaluateRuntimeVersion(version).hostVersion, version);
  assert.equal(evaluateRuntimeVersion(version).confirmationRequired, false);
});

test('unknown bootstrap and malformed plugin identities never grant acquisition', () => {
  const compat = createRuntimeCompatibility({ pluginVersion });
  const old = prepare(compat).token;
  assert.equal(compat.markReady(old), false);
  assert.equal(compat.canAcquireRoute(), true, 'missing host version defers to capabilities');
  compat.setHostVersion('0.2.2-rc.3');
  assert.equal(compat.isCurrent(old), false);
  assert.equal(validReport(compat).phase, 'initial');
  const token = prepare(compat).token;
  finish(compat, token);
  for (const version of [undefined, 'v0.4.0', 'secret://private']) {
    const bad = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion: version });
    assert.equal(validReport(bad).code, 'COMPATIBILITY_PLUGIN_INVALID');
    assert.equal(bad.canAcquireRoute(), false);
  }
});

test('shape-only probes and arbitrary ready objects cannot acquire or execute', () => {
  const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
  const token = compat.captureEpoch();
  const shapeOnly = assessRuntimeCapabilities({ ctx: host().ctx, token });
  assert.equal(shapeOnly.shape, 'passed');
  assert.equal(shapeOnly.contract, 'pending');
  compat.setCapabilities(shapeOnly);
  assert.equal(compat.canAcquireRoute(), false);
  assert.equal(compat.canLeaseBudget(), false);
  assert.equal(compat.markReady(token), false);
  assert.equal(validReport(compat).coreReady, false);
  assert.equal(compat.setCapabilities({ token, stage: 'route', confirmed: true }), false);
  compat.setCapabilities({ token, stage: 'core', shape: 'passed', contract: 'passed', ready: true });
  assert.equal(validReport(compat).code, 'COMPATIBILITY_PROBE_INVALID');
  assert.equal(compat.isCurrent(token), false);
});

test('adapted shapes remain distinct and require every ABI contract check', () => {
  for (const modern of [false, true]) {
    const fixture = host({ modern }), before = { ...fixture.fiber.config };
    const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
    const { token, result } = prepare(compat, fixture);
    assert.equal(result.abi, modern ? 'cordis-effective-config' : 'cordis-resolved-config');
    assert.equal(result.shape, 'passed');
    assert.equal(result.contract, 'passed');
    assert.equal(compat.canAcquireRoute(), true);
    assert.equal(compat.canLeaseBudget(), true);
    assert.equal(compat.markReady(token), false);
    assert.throws(() => compat.assertSearchAllowed(), { code: 'COMPATIBILITY_ROUTE_UNCONFIRMED' });
    compat.setCapabilities({ token, stage: 'route', confirmed: true });
    assert.equal(compat.markReady(token), false);
    assert.throws(() => compat.assertSearchAllowed(), { code: 'COMPATIBILITY_BUDGET_UNCONFIRMED' });
    compat.setCapabilities({ token, stage: 'budget', confirmed: true });
    assert.throws(() => compat.assertSearchAllowed(), { code: 'COMPATIBILITY_INITIALIZATION_PENDING' });
    assert.equal(compat.markReady(token), true);
    assert.equal(compat.assertSearchAllowed(), true);
    assert.equal(validReport(compat).coreReady, true);
    assert.deepEqual(fixture.fiber.config, before);
  }
  for (const name of CORE_CONTRACT_CHECKS) {
    const fixture = host(), checks = completeChecks();
    delete checks[name];
    const pending = assessRuntimeCapabilities({ ctx: fixture.ctx, contractChecks: checks });
    assert.equal(pending.contract, 'pending');
    checks[name] = false;
    assert.equal(assessRuntimeCapabilities({ ctx: fixture.ctx, contractChecks: checks }).contract, 'failed');
  }
});

test('pending services are staged while incompatible identities and throws fail closed', () => {
  const missing = host();
  delete missing.services.tools;
  assert.equal(assessRuntimeCapabilities({ ctx: missing.ctx }).shape, 'passed');
  const pending = host();
  pending.fiber.state = 1;
  assert.equal(assessRuntimeCapabilities({ ctx: pending.ctx }).shape, 'pending');
  for (const mutate of [
    fixture => fixture.entries.push(fixture.entry),
    fixture => { fixture.entry.options.name = 'other-web'; },
    fixture => { fixture.entry.options.disabled = true; },
    fixture => { delete fixture.fiber.rawConfig; },
    fixture => { fixture.fiber.effectiveConfig.searchProvider = 'not-volatile'; },
    fixture => { fixture.web.search = null; },
  ]) {
    const fixture = host();
    mutate(fixture);
    const result = assessRuntimeCapabilities({ ctx: fixture.ctx, contractChecks: completeChecks() });
    assert.equal(result.shape, 'failed');
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
  }
  const throwing = host();
  throwing.ctx.get = () => { throw new Error('Bearer secret-value'); };
  const retryable = assessRuntimeCapabilities({ ctx: throwing.ctx, contractChecks: completeChecks() });
  assert.equal(retryable.shape, 'pending');
  assert.equal(retryable.transient, true);
  assert.equal(JSON.stringify(retryable).includes('secret-value'), false);
});

test('optional tools and web.fetch APIs do not prevent the core search contract from passing', () => {
  for (const modern of [false, true]) {
    const fixture = host({ modern });
    delete fixture.services.tools;
    delete fixture.web.fetch;
    delete fixture.fiber.config.fetchProvider;
    if (modern) delete fixture.fiber.effectiveConfig.fetchProvider;
    const checks = completeChecks();
    const result = assessRuntimeCapabilities({ ctx: fixture.ctx, token: {}, contractChecks: checks });
    assert.equal(result.shape, 'passed');
    assert.equal(result.contract, 'passed');
    const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
    const { token } = prepare(compat, fixture, checks);
    assert.equal(compat.canAcquireRoute(), true);
    finish(compat, token);
    assert.equal(compat.assertSearchAllowed(), true);
  }
});

test('loader wrappers use the live inner fiber and entry-scoped web service', () => {
  const fixture = host();
  const wrapper = { uid: 2, state: 2, ctx: { fiber: fixture.fiber, get: () => fixture.web } };
  fixture.entry.fiber = wrapper;
  fixture.services.web = { search: null };
  const assess = () => assessRuntimeCapabilities({ ctx: fixture.ctx, contractChecks: completeChecks() });
  assert.equal(assess().shape, 'passed');
  assert.equal(assess().abi, 'cordis-effective-config');
  for (const uid of [null, undefined, 0]) {
    wrapper.uid = uid;
    assert.equal(assess().shape, 'pending');
  }
  wrapper.uid = 2;
  for (const uid of [null, undefined, 0]) {
    fixture.fiber.uid = uid;
    assert.equal(assess().shape, 'pending');
  }
  fixture.fiber.uid = 1;
  fixture.fiber.state = 1;
  assert.equal(assess().shape, 'pending');
  fixture.fiber.state = 2;
  fixture.services.web = fixture.web;
  wrapper.ctx.get = () => undefined;
  assert.equal(assess().shape, 'pending');
});

test('compatibility metadata never gates supported core capabilities or changes verification claims', () => {
  const version = '1.0.0-alpha.1+one';
  const store = memoryState(version);
  const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: store });
  const { token } = prepare(compat);
  assert.equal(validReport(compat).phase, 'checking');
  assert.equal(compat.canAcquireRoute(), true);
  store.change({ notified: true });
  assert.equal(validReport(compat).notified, true);
  assert.equal(compat.canAcquireRoute(), true);
  store.change({ confirmed: true, verification: 'verified' });
  assert.equal(validReport(compat).confirmed, true);
  finish(compat, token);
  assert.equal(validReport(compat).verification, 'unverified');
  assert.deepEqual(store.writes, []);
  store.change({ hostVersion: '1.0.0-alpha.1+two' });
  assert.equal(validReport(compat).code, 'COMPATIBILITY_PAIR_MISMATCH');
  assert.equal(compat.isCurrent(token), true);
  assert.equal(compat.canAcquireRoute(), true);
  assert.equal(compat.assertSearchAllowed(), true);
});

test('revoking old compatibility metadata does not invalidate an active capability epoch', () => {
  const version = '2.0.0-beta.1', store = memoryState(version, true);
  const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: store });
  const token = prepare(compat).token;
  finish(compat, token);
  store.change({ confirmed: false });
  assert.equal(validReport(compat).phase, 'ready');
  assert.equal(compat.isCurrent(token), true);
  assert.equal(compat.markReady(token), true);
  assert.equal(compat.setCapabilities({ token, stage: 'route', confirmed: true }), true);
  store.change({ confirmed: true });
  assert.equal(compat.canAcquireRoute(), true);
  assert.equal(compat.assertSearchAllowed(), true);
});

test('stop is terminal across initialization, consent resolution, and store notifications', async () => {
  const next = deferred();
  const store = { snapshot: () => next.promise };
  const compat = createRuntimeCompatibility({ hostVersion: '2.0.0-beta.1', pluginVersion, stateStore: store });
  const token = prepare(compat).token;
  compat.stop();
  next.resolve({ hostVersion: '2.0.0-beta.1', pluginVersion, revision, confirmed: true, notified: true });
  await next.promise;
  await Promise.resolve();
  assert.equal(validReport(compat).phase, 'stopped');
  assert.equal(compat.isCurrent(token), false);
  assert.equal(compat.markReady(token), false);
  assert.equal(compat.setCapabilities({ token, stage: 'budget', confirmed: true }), false);
  assert.equal(compat.setOptional('settings', { available: true }), false);
  compat.setHostVersion('3.0.0');
  assert.equal(validReport(compat).hostVersion, '2.0.0-beta.1');
  assert.throws(() => compat.assertSearchAllowed('secret-operation'), error =>
    error.code === 'COMPATIBILITY_STOPPED' && error.message === 'COMPATIBILITY_STOPPED');
});

test('out-of-order confirmation reads cannot overwrite newer state', async () => {
  const first = deferred(), second = deferred();
  let reads = 0;
  const version = '2.0.0-beta.1';
  const store = { snapshot: () => ++reads === 1 ? first.promise : second.promise };
  const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: store });
  const latest = compat.refreshConfirmation();
  second.resolve({ hostVersion: version, pluginVersion, revision, confirmed: false, notified: true });
  await latest;
  first.resolve({ hostVersion: version, pluginVersion, revision, confirmed: true, notified: true });
  await first.promise;
  await Promise.resolve();
  assert.equal(validReport(compat).confirmed, false);
  assert.equal(compat.canAcquireRoute(), false);
});

test('host changes discard old work; foreign coordinator tokens never authorize', () => {
  const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
  const token = prepare(compat).token;
  finish(compat, token);
  compat.setHostVersion('0.3.0-rc.1');
  assert.equal(compat.isCurrent(token), false);
  assert.equal(compat.markReady(token), false);
  const foreign = createRuntimeCompatibility({ hostVersion: '0.3.0-rc.1', pluginVersion });
  assert.equal(compat.markReady(foreign.captureEpoch()), false);
  assert.equal(validReport(compat).coreReady, false);
});

test('same-version reassessment revokes in-flight acquisition and requires fresh route and budget results', () => {
  const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
  const first = prepare(compat);
  finish(compat, first.token);
  assert.equal(compat.setCapabilities(first.result), true);
  assert.equal(compat.isCurrent(first.token), true);
  const next = assessRuntimeCapabilities({ ctx: host().ctx, token: first.token, contractChecks: completeChecks() });
  assert.equal(compat.setCapabilities(next), false);
  assert.equal(compat.isCurrent(first.token), false);
  assert.equal(compat.markReady(first.token), false);
  assert.equal(compat.setCapabilities({ token: first.token, stage: 'route', confirmed: true }), false);
  assert.equal(validReport(compat).coreReady, false);
  assert.equal(validReport(compat).code, 'COMPATIBILITY_CORE_PENDING');
  finish(compat, prepare(compat).token);
});

test('explicit retry starts a new epoch without granting consent or changing persistent policy', () => {
  const store = memoryState('0.2.2-rc.3');
  const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion, stateStore: store });
  const old = prepare(compat).token;
  compat.block('COMPATIBILITY_CONTRACT_FAILED');
  const fresh = compat.beginEpoch();
  assert.equal(compat.isCurrent(old), false);
  assert.equal(compat.isCurrent(fresh), true);
  assert.equal(compat.canAcquireRoute(), false);
  finish(compat, prepare(compat).token);
  assert.deepEqual(store.writes, []);
  compat.stop();
  assert.equal(compat.beginEpoch(), null);
});

test('a new epoch clears optional successes until current-epoch initialization reports them again', () => {
  const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
  const names = ['settings', 'chat', 'github'], old = prepare(compat).token;
  finish(compat, old);
  for (const name of names) compat.setOptional(name, { token: old, state: 'ready' });
  const before = validReport(compat), observed = [];
  assert.equal(before.phase, 'ready');
  compat.subscribe(value => observed.push(value));
  const fresh = compat.beginEpoch();
  const reset = validReport(compat);
  assert.equal(reset.phase, 'checking');
  assert.equal(reset.coreReady, false);
  assert.equal(compat.canAcquireRoute(), false);
  assert.equal(compat.canLeaseBudget(), false);
  assert.equal(compat.markReady(fresh), false);
  assert.equal(compat.isCurrent(old), false);
  assert.deepEqual(observed, [reset]);
  for (const name of names) {
    assert.deepEqual(reset.optionalFeatures[name], { available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' });
    assert.equal(compat.setOptional(name, { token: old, available: true }), false);
    assert.deepEqual(before.optionalFeatures[name], { available: true, code: null });
  }
  assert.equal(prepare(compat).token, fresh);
  finish(compat, fresh);
  const initialized = validReport(compat);
  assert.equal(initialized.coreReady, true);
  assert.equal(initialized.phase, 'ready');
  assert.equal(initialized.code, 'COMPATIBILITY_OPTIONAL_PENDING');
  assert.deepEqual(initialized.optionalFeatures, reset.optionalFeatures);
  for (const name of names) {
    assert.equal(compat.setOptional(name, { token: fresh, state: 'ready' }), true);
  }
  assert.equal(validReport(compat).phase, 'ready');
});

test('all work invalidation paths reset optional results and reject stale optional callbacks', () => {
  for (const invalidate of [
    compat => compat.block('COMPATIBILITY_CONTRACT_FAILED'),
    compat => compat.stop(),
    compat => compat.setHostVersion('2.0.0'),
    (compat, _store, token) => compat.setCapabilities(assessRuntimeCapabilities({
      ctx: host().ctx, token, contractChecks: completeChecks(),
    })),
    (compat, _store, token) => compat.setCapabilities(assessRuntimeCapabilities({
      ctx: host().ctx, token, contractChecks: { ...completeChecks(), configUpdate: false },
    })),
  ]) {
    const version = '1.0.0-alpha.1', store = memoryState(version, true);
    const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: store });
    const token = prepare(compat).token;
    finish(compat, token);
    compat.setOptional('settings', { token, state: 'ready' });
    compat.setOptional('chat', { token, available: false, code: 'COMPATIBILITY_CHAT_UNAVAILABLE', confirmedFailure: true });
    compat.setOptional('github', { token, state: 'ready' });
    invalidate(compat, store, token);
    const reset = validReport(compat);
    assert.equal(reset.coreReady, false);
    assert.equal(compat.isCurrent(token), false);
    for (const name of ['settings', 'chat', 'github']) {
      assert.deepEqual(reset.optionalFeatures[name], { available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' });
      assert.equal(compat.setOptional(name, { token, state: 'ready' }), false);
    }
    assert.deepEqual(store.writes, []);
  }
});

test('epoch changes notify subscribers even when report fields are unchanged', () => {
  const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
  const old = compat.beginEpoch(), before = validReport(compat), observed = [];
  compat.subscribe(value => observed.push({ value, token: compat.captureEpoch() }));
  const fresh = compat.beginEpoch();
  assert.equal(compat.isCurrent(old), false);
  assert.notEqual(fresh, old);
  assert.deepEqual(validReport(compat), before);
  assert.deepEqual(observed, [{ value: before, token: fresh }]);
  compat.refreshConfirmation();
  compat.setOptional('settings', { token: fresh, available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' });
  assert.equal(observed.length, 1, 'Unchanged reports within the same epoch remain deduplicated.');
  compat.block('COMPATIBILITY_CONTRACT_FAILED');
  const blocked = validReport(compat), blockedToken = compat.captureEpoch();
  assert.equal(observed.length, 2);
  compat.block('COMPATIBILITY_CONTRACT_FAILED');
  assert.equal(observed.length, 3);
  assert.notEqual(compat.captureEpoch(), blockedToken);
  assert.deepEqual(observed[2], { value: blocked, token: compat.captureEpoch() });
});

test('optional failures degrade presentation without granting or revoking core authority', () => {
  const compat = createRuntimeCompatibility({ hostVersion: '9.0.0', pluginVersion });
  for (const name of ['settings', 'chat', 'github']) compat.setOptional(name, { state: 'ready' });
  assert.equal(validReport(compat).coreReady, false);
  const token = prepare(compat).token;
  finish(compat, token);
  assert.equal(validReport(compat).phase, 'ready');
  compat.setOptional('chat', { available: false, code: 'SECRET_PATH_OR_TOKEN', confirmedFailure: true });
  const report = validReport(compat);
  assert.equal(report.phase, 'degraded');
  assert.equal(report.optionalFeatures.chat.code, 'COMPATIBILITY_CHAT_UNAVAILABLE');
  assert.equal(compat.assertSearchAllowed(), true);
  assert.equal(compat.setOptional('unknown-feature', { available: true }), false);
});

test('pending browser slots do not count as optional failure or claim chat availability', () => {
  const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
  const token = prepare(compat).token;
  compat.setOptional('settings', { token, state: 'ready' });
  compat.setOptional('github', { token, state: 'ready' });
  const checking = validReport(compat);
  assert.equal(checking.coreReady, false);
  assert.equal(checking.phase, 'checking');
  assert.equal(checking.code, 'COMPATIBILITY_ROUTE_UNCONFIRMED');
  assert.equal(compat.markReady(token), false);
  assert.throws(() => compat.assertSearchAllowed(), { code: 'COMPATIBILITY_ROUTE_UNCONFIRMED' });
  finish(compat, token);
  const ready = validReport(compat);
  assert.equal(ready.coreReady, true);
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.code, 'COMPATIBILITY_OPTIONAL_PENDING');
  assert.deepEqual(ready.optionalFeatures, {
    settings: { available: true, code: null },
    chat: { available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' },
    github: { available: true, code: null },
  });
  assert.equal(compat.assertSearchAllowed(), true);
});

test('actual optional failures take priority over pending features without revoking core authority', () => {
  const names = ['settings', 'chat', 'github'];
  for (const failedName of names) {
    const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
    const token = prepare(compat).token;
    finish(compat, token);
    const pending = validReport(compat);
    assert.equal(pending.phase, 'ready');
    assert.equal(pending.code, 'COMPATIBILITY_OPTIONAL_PENDING');
    const observed = [];
    compat.subscribe(value => observed.push(value));
    const code = `COMPATIBILITY_${failedName.toUpperCase()}_UNAVAILABLE`;
    compat.setOptional(failedName, { token, available: false, code, confirmedFailure: true });
    const failed = validReport(compat);
    assert.equal(failed.phase, 'degraded');
    assert.equal(failed.code, 'COMPATIBILITY_OPTIONAL_UNAVAILABLE');
    assert.equal(failed.coreReady, true);
    assert.deepEqual(failed.optionalFeatures[failedName], { available: false, code });
    for (const name of names.filter(name => name !== failedName)) {
      assert.deepEqual(failed.optionalFeatures[name], { available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' });
    }
    assert.equal(compat.isCurrent(token), true);
    assert.equal(compat.assertSearchAllowed(), true);
    compat.setOptional(failedName, { token, state: 'ready' });
    const recovered = validReport(compat);
    assert.equal(recovered.phase, 'ready');
    assert.equal(recovered.code, 'COMPATIBILITY_OPTIONAL_PENDING');
    assert.deepEqual(observed, [failed, recovered]);
    for (const name of names) compat.setOptional(name, { token, state: 'ready' });
    assert.equal(validReport(compat).phase, 'ready');
    assert.equal(validReport(compat).code, null);
  }
});

test('state metadata errors neither grant nor block the actual capability checks', () => {
  for (const version of ['0.2.2', '0.2.2-rc.3']) {
    for (const code of [
      'COMPATIBILITY_STATE_INVALID', 'COMPATIBILITY_STATE_READ_FAILED',
      'COMPATIBILITY_STATE_UNAVAILABLE', 'COMPATIBILITY_STATE_PATH_INVALID', 'COMPATIBILITY_STATE_PATH_UNSAFE',
    ]) {
      const store = memoryState(version, true);
      store.change({ errorCode: code });
      const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: store });
      for (const name of ['settings', 'chat', 'github']) compat.setOptional(name, { state: 'ready' });
      const initial = validReport(compat);
      assert.equal(initial.phase, 'initial');
      assert.equal(initial.coreReady, false);
      assert.equal(initial.confirmed, false);
      assert.equal(initial.notified, false);
      assert.equal(initial.revision, null);
      assert.equal(compat.canAcquireRoute(), false);
      assert.equal(compat.canLeaseBudget(), false);
      assert.equal(compat.markReady(compat.captureEpoch()), false);
      assert.throws(() => compat.assertSearchAllowed(), { code: 'COMPATIBILITY_CORE_PENDING' });
      const token = prepare(compat).token;
      assert.equal(compat.canAcquireRoute(), true);
      assert.equal(compat.canLeaseBudget(), true);
      assert.equal(compat.markReady(token), false);
      assert.throws(() => compat.assertSearchAllowed(), { code: 'COMPATIBILITY_ROUTE_UNCONFIRMED' });
      finish(compat, token);
      const ready = validReport(compat);
      assert.equal(ready.coreReady, true);
      assert.equal(ready.confirmed, false);
      assert.equal(ready.phase, 'ready');
      assert.equal(ready.code, code);
      assert.equal(compat.assertSearchAllowed(), true);
      assert.deepEqual(store.writes, []);
    }
  }
});

test('metadata failure and recovery preserve the ready epoch for every version channel', () => {
  for (const version of ['0.2.2', '0.2.2-rc.3']) {
    const store = memoryState(version, true);
    const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: store });
    for (const name of ['settings', 'chat', 'github']) compat.setOptional(name, { state: 'ready' });
    const token = prepare(compat).token;
    finish(compat, token);
    assert.equal(validReport(compat).phase, 'ready');
    store.change({ errorCode: 'COMPATIBILITY_STATE_INVALID' });
    const broken = validReport(compat);
    assert.equal(broken.phase, 'ready');
    assert.equal(broken.code, 'COMPATIBILITY_STATE_INVALID');
    assert.equal(broken.confirmed, false);
    assert.equal(broken.notified, false);
    assert.equal(broken.revision, null);
    assert.equal(compat.isCurrent(token), true);
    assert.equal(compat.assertSearchAllowed(), true);
    store.change({ errorCode: null, revision: 'missing', confirmed: false, notified: false });
    assert.equal(validReport(compat).phase, 'ready');
    assert.equal(validReport(compat).code, null);
    assert.equal(compat.isCurrent(token), true);
    assert.equal(compat.assertSearchAllowed(), true);
    assert.deepEqual(store.writes, []);
  }
});

test('experimental channels retain core admission when legacy consent metadata is corrupt', () => {
  for (const version of ['1.0.0-alpha.1', '1.0.0-beta.1', '1.0.0-preview.1']) {
    const store = memoryState(version, true);
    const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: store });
    const old = prepare(compat).token;
    finish(compat, old);
    store.change({ errorCode: 'COMPATIBILITY_STATE_INVALID' });
    assert.equal(compat.isCurrent(old), true);
    const broken = validReport(compat);
    assert.equal(broken.phase, 'ready');
    assert.equal(broken.code, 'COMPATIBILITY_STATE_INVALID');
    assert.equal(broken.confirmed, false);
    assert.equal(broken.coreReady, true);
    assert.equal(compat.canAcquireRoute(), true);
    assert.equal(compat.canLeaseBudget(), true);
    assert.equal(compat.markReady(old), true);
    assert.equal(compat.setCapabilities({ token: old, stage: 'route', confirmed: true }), true);
    assert.equal(compat.assertSearchAllowed(), true);
  }
});

test('pending or rejected metadata reads cannot hold any channel behind an obsolete consent gate', async () => {
  for (const version of ['0.2.2', '0.2.2-rc.3', '1.0.0-alpha.1']) {
    const read = deferred();
    const compat = createRuntimeCompatibility({
      hostVersion: version, pluginVersion, stateStore: { snapshot: () => read.promise },
    });
    const token = prepare(compat).token;
    assert.equal(validReport(compat).confirmationRequired, false);
    const refreshed = compat.refreshConfirmation();
    assert.equal(compat.canAcquireRoute(), true);
    finish(compat, token);
    read.reject(new Error('/private/config Bearer abc123'));
    await refreshed;
    const broken = validReport(compat);
    assert.equal(broken.code, 'COMPATIBILITY_STATE_READ_FAILED');
    assert.equal(broken.confirmed, false);
    assert.equal(broken.coreReady, true);
    assert.equal(broken.phase, 'ready');
    assert.equal(compat.isCurrent(token), true);
    assert.equal(compat.assertSearchAllowed(), true);
    assert.doesNotMatch(JSON.stringify(broken), /private|Bearer|abc123/);
  }
});

test('state subscription failure is diagnostic and never blocks experimental runtime capabilities', () => {
  for (const version of ['0.2.2', '0.2.2-rc.3', '1.0.0-alpha.1']) {
    const store = memoryState(version, true);
    store.onChange = () => { throw new Error('/private/config Bearer abc123'); };
    const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: store });
    const token = prepare(compat).token;
    assert.equal(validReport(compat).confirmationRequired, false);
    assert.equal(compat.canAcquireRoute(), true);
    finish(compat, token);
    const broken = validReport(compat);
    assert.equal(broken.confirmed, false);
    assert.equal(broken.code, 'COMPATIBILITY_STATE_READ_FAILED');
    assert.equal(broken.phase, 'ready');
    assert.equal(broken.coreReady, true);
    assert.doesNotMatch(JSON.stringify(broken), /private|Bearer|abc123/);
  }
});

test('pair mismatches and unknown legacy identity metadata do not revoke capability authority', () => {
  for (const version of ['0.2.2', '0.2.2-rc.3']) {
    for (const change of [
      { hostVersion: version + '+different-build' }, { pluginVersion: '0.4.1' },
      { errorCode: 'COMPATIBILITY_PAIR_MISMATCH' }, { errorCode: 'COMPATIBILITY_IDENTITY_UNKNOWN' },
    ]) {
      const store = memoryState(version, true);
      const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: store });
      const token = prepare(compat).token;
      finish(compat, token);
      store.change(change);
      const broken = validReport(compat);
      assert.equal(broken.phase, 'ready');
      assert.equal(broken.code, change.errorCode ?? 'COMPATIBILITY_PAIR_MISMATCH');
      assert.equal(broken.confirmed, false);
      assert.equal(broken.coreReady, true);
      assert.equal(compat.isCurrent(token), true);
      assert.equal(compat.canAcquireRoute(), true);
      assert.equal(compat.canLeaseBudget(), true);
      assert.equal(compat.markReady(token), true);
    }
  }
});

test('read errors, invalid state, and caller errors only expose stable sanitized codes', () => {
  const version = '1.0.0-alpha.1';
  for (const snapshot of [
    () => { throw new Error('/private/config Bearer abc123'); },
    () => ({ hostVersion: version, pluginVersion, revision: 'path-or-secret', confirmed: true, notified: true }),
    () => ({ hostVersion: version, pluginVersion, revision: 'missing', confirmed: true, notified: true }),
    () => ({ hostVersion: version, pluginVersion, revision: 'missing', confirmed: false, notified: true }),
    () => ({ hostVersion: version, pluginVersion, revision, confirmed: true, notified: false }),
    () => ({ hostVersion: version, pluginVersion, errorCode: 'PRIVATE_SECRET_ABC' }),
  ]) {
    const compat = createRuntimeCompatibility({ hostVersion: version, pluginVersion, stateStore: { snapshot } });
    const value = validReport(compat);
    assert.equal(value.phase, 'initial');
    assert.equal(value.confirmed, false);
    assert.doesNotMatch(JSON.stringify(value), /private|Bearer|abc123|SECRET_ABC|path-or-secret/);
  }
  const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion });
  compat.block('/private/credential');
  assert.equal(validReport(compat).code, 'COMPATIBILITY_BLOCKED');
});

test('observers cannot undo stop, subscriptions dispose, and no state mutation is called', async () => {
  const store = memoryState('0.2.2-rc.3'), observed = [];
  const compat = createRuntimeCompatibility({ hostVersion: '0.2.2-rc.3', pluginVersion, stateStore: store });
  const unsubscribe = compat.subscribe(value => { observed.push(value.phase); throw new Error('private observer error'); });
  compat.subscribe(async () => { throw new Error('private async observer error'); });
  const token = prepare(compat).token;
  finish(compat, token);
  assert.ok(observed.length > 0);
  unsubscribe();
  const count = observed.length;
  assert.equal(store.subscribers, 1);
  compat.stop();
  assert.equal(store.subscribers, 0);
  assert.equal(observed.length, count);
  assert.deepEqual(store.writes, []);
  await Promise.resolve();
});
