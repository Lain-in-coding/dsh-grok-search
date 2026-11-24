import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { apply as applyControl, projectPublicSnapshot } from '../src/control.mjs';
import { apply as applyRecovery } from '../src/recovery.mjs';
import { apply as applyRouteVerifier } from '../src/route-verifier.mjs';
import { createSettingsGateway, SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import {
  PRODUCT_SEARCH_BUNDLE, PRODUCT_RECOVERY_BUNDLE, PRODUCT_HOST_ID, createAcquisition, createLease, createProductStore,
  createProductReleaseController, effectiveFetchProvider, effectiveSearchProvider, routeReceipt, takeOverAuthorRoute,
  restoreAuthorRoute, effectiveConfig, createSearchConfigHook, readSelection, holdProductRelease, productReleaseInFlight,
  onProductReleaseIdle, productRuntimeCleanupInFlight, onProductRuntimeCleanupIdle,
} from '../src/core/product-control.mjs';
import { commitExplicitRelease, createReleaseBarrier } from '../src/core/release-transaction.mjs';
import { acquireOwnedLock } from '../src/core/owned-lock.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const nextImmediate = () => new Promise(resolve => setImmediate(resolve));
async function waitForNotification(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Passive release notification did not arrive.')), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitForRuntimeCleanup(store) {
  const idle = deferred(), unsubscribe = onProductRuntimeCleanupIdle(store, idle.resolve);
  try { await waitForNotification(idle.promise); }
  finally { unsubscribe(); }
}
async function withIsolatedHome(work) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-isolated-home-'));
  const pattern = /^(HOME|USERPROFILE|GROK_SEARCH_.*|TAVILY_.*|EXA_.*|TINYFISH_.*|FIRECRAWL_.*|OPENAI_COMPATIBLE_.*|GITHUB_TOKEN)$/i;
  const saved = Object.entries(process.env).filter(([name]) => pattern.test(name));
  for (const [name] of saved) delete process.env[name];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return await work(home); }
  finally {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    for (const [name, value] of saved) process.env[name] = value;
  }
}
function writeProfile(ctx, bundles) {
  // D-28: search and recovery share one bundle, so profile selections are de-duplicated.
  const value = { name: 'product-wiring-profile', private: true, type: 'module',
    dsh: { profile: { bundles: [...new Set(bundles)] } } };
  writeFileSync(join(ctx.profileContext.dir, 'package.json'), JSON.stringify(value, null, 2) + '\n');
}
function makeContext({ bundles, verifier, originalCalls } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-product-wiring-test-'));
  const services = new Map();
  const disposers = [];
  const events = new Map();
  const webFiber = {
    uid: 42, state: 2, config: { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' },
    ctx: { get: name => services.get(name) },
    update() { throw new Error('web fiber must not restart for a volatile route update'); },
  };
  const web = {
    options: { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' },
      inject: { candidateExistingDependency: { probe: 'preserve' } } },
    fiber: webFiber,
    async update(options) {
      if (isDeepStrictEqual(web.options.config, options.config)) return;
      web.options.config = structuredClone(options.config);
      webFiber.config = structuredClone(options.config);
      services.set('web', { searchProviderId: options.config.searchProvider ?? null,
        fetchProviderId: options.config.fetchProvider ?? null });
      ctx.emit('loader/volatile-update', [['config', 'searchProvider']]);
    },
  };
  const recovery = { options: { id: 'grok-search-recovery', name: 'dsh-grok-search/recovery' }, fiber: { uid: 43, state: 2 } };
  const entries = [web, recovery];
  services.set('web', { searchProviderId: 'candidate-original', fetchProviderId: 'candidate-fetch' });
  const releaseBarrier = createReleaseBarrier();
  services.set('grokSearchCore', { releaseBarrier, dispose: async () => {} });
  const ctx = {
    profileContext: { dir: directory },
    loader: { entries: () => entries },
    fiber: { uid: 44 },
    logger: { error: () => {} },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    inject: (_names, callback) => callback(ctx),
    on: (name, callback) => { const list = events.get(name) ?? []; list.push(callback); events.set(name, list); },
    emit: (name, ...args) => { for (const callback of events.get(name) ?? []) callback(...args); },
    effect: factory => { const disposer = factory(); if (typeof disposer === 'function') disposers.push(disposer); },
    dispose: () => { for (const disposer of disposers.splice(0)) disposer(); },
    events,
  };
  writeProfile(ctx, bundles ?? [PRODUCT_SEARCH_BUNDLE, PRODUCT_RECOVERY_BUNDLE]);
  if (verifier) services.set('grokSearchRouteVerifier', verifier);
  if (originalCalls !== undefined) services.set('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: originalCalls }) });
  return ctx;
}

function gateTakeover(ctx, mode = 'apply') {
  const entry = ctx.loader.entries()[0], update = entry.update;
  const started = deferred(), gate = deferred();
  let blocked = false;
  entry.update = async options => {
    if (!blocked && options.config.searchProvider === 'grok-search') {
      blocked = true;
      started.resolve();
      await gate.promise;
      if (mode === 'reject') throw new Error('takeover rejected by host');
      if (mode === 'ignore') return;
      await update(options);
      if (mode === 'apply-then-reject') throw new Error('host failed after applying takeover');
      return;
    }
    return update(options);
  };
  return { started: started.promise, release: gate.resolve };
}

function createRequiredRecord(ctx, store, hostId) {
  const acquisition = createAcquisition(ctx);
  acquisition.hostId = hostId;
  const lease = createLease(ctx);
  lease.hostId = hostId;
  const intent = { schemaVersion: 1, policy: 'required', reason: 'test-product-record', release: null, acquisition, lease };
  return store.compareAndSwap({ expectedRevision: 0, intent });
}

function createInterruptedReleaseRecord(ctx, store, operationId = randomUUID(), reason = 'native-bundle-disable') {
  const required = createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
  const committedAt = '2026-10-26T00:00:00.000Z';
  const released = store.compareAndSwap({ expectedRevision: required.revision, intent: {
    ...required.intent, policy: 'released', reason,
    pause: { confirmed: true, reason, observedAt: committedAt },
    priorIntent: structuredClone(required.intent), release: {
      explicit: true, committedAt, kind: 'intent-release-commit', operationId,
      hostId: PRODUCT_HOST_ID, pid: required.intent.lease.pid,
      author: required.intent.acquisition.authorSearchProvider, counterBaseline: 0,
      routeChanged: false, routeVerified: false,
    },
  } });
  return { required, released };
}

test('damaged product selections expose a stable code without rewriting the manifest', async t => {
  for (const text of ['{broken', 'null', '{}', '{"dsh":{"profile":{"bundles":null}}}',
    '{"dsh":{"profile":{"bundles":[""]}}}', '{"dsh":{"profile":{"bundles":[42]}}}']) {
    await t.test(text, () => {
      const ctx = makeContext();
      const manifest = join(ctx.profileContext.dir, 'package.json');
      writeFileSync(manifest, text);
      try {
        assert.throws(() => readSelection(ctx), { code: 'CONTROL_SELECTION_INVALID' });
        assert.equal(readFileSync(manifest, 'utf8'), text);
      } finally { ctx.dispose(); }
    });
  }
});

test('control startup retains the actual damaged-selection code in its incomplete snapshot', async () => {
  const ctx = makeContext();
  const manifest = join(ctx.profileContext.dir, 'package.json');
  const text = '{broken';
  writeFileSync(manifest, text);
  try {
    await applyControl(ctx, { keepAliveOnFailure: true });
    const snapshot = ctx.get('grokSearchControl').snapshot();
    assert.equal(snapshot.phase, 'incomplete');
    assert.equal(snapshot.error.code, 'CONTROL_SELECTION_INVALID');
    assert.equal(snapshot.revision, 0);
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
    assert.equal(readFileSync(manifest, 'utf8'), text);
  } finally { ctx.dispose(); }
});

test('native release keeps live loader and counter across child-context disposal', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx, { counterSnapshot: () => ({ calls: 0, source: 'test-counter', adapterVersion: 1 }) });
  const control = ctx.get('grokSearchControl');
  const gate = deferred();
  ctx.get('grokSearchCore').dispose = () => gate.promise;
  const release = control.stop('native-bundle-disable', { unloading: true });
  ctx.dispose();
  Object.defineProperty(ctx, 'loader', { get: () => { throw new Error('child context has been disposed'); } });
  gate.resolve();
  const outcome = await release;
  assert.equal(outcome.kind, 'released');
  assert.equal(outcome.completionCommitted, true);
  assert.equal(outcome.routeVerified, true);
});

test('native release completes when the host counter reports only calls', async () => {
  // Packaged Desktop regression: a host counter returning `{ calls }` left
  // undefined receipt members, and the CAS store rejected the completion.
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx, { counterSnapshot: () => ({ calls: 0 }) });
  const control = ctx.get('grokSearchControl');
  const outcome = await control.stop('native-bundle-disable', { unloading: true });
  assert.equal(outcome.kind, 'released');
  assert.equal(outcome.completionCommitted, true);
  const completion = createProductStore(ctx).read().intent.releaseCompletion;
  assert.equal(completion.routeVerified, true);
  assert.equal(completion.routeEvidence.originalSearchDelta, 0);
  assert.equal(typeof completion.routeEvidence.counterSource, 'string');
  assert.equal(completion.routeEvidence.counterAdapterVersion, 1);
  ctx.dispose();
});

test('product control entry creates one versioned record and ordinary dispose does not release it', async () => {
  const ctx = makeContext();
  await applyControl(ctx);
  assert.equal(ctx.get('web').searchProviderId, 'grok-search');
  const service = ctx.get('grokSearchControl');
  assert.ok(service);
  const snapshot = service.snapshot();
  assert.equal(snapshot.phase, 'required');
  assert.equal(snapshot.path, join(ctx.profileContext.dir, 'control-intent.records'));
  const before = createProductStore(ctx).read();
  assert.equal(before.revision, 1);
  assert.equal(before.intent.policy, 'required');
  assert.equal(before.intent.acquisition.source, 'current-selected-search-bundle');
  assert.equal(before.intent.acquisition.searchBundle, PRODUCT_SEARCH_BUNDLE);
  assert.equal(before.intent.lease.provider, 'grok-search');
  assert.equal(snapshot.routeChanged, true);
  assert.equal(ctx.get('web').searchProviderId, 'grok-search');
  assert.equal(ctx.loader.entries()[0].options.config.searchProvider, 'candidate-original');
  ctx.dispose();
  assert.equal(service.snapshot().phase, 'disposed');
  assert.equal(ctx.get('web').searchProviderId, 'grok-search');
  assert.deepEqual(createProductStore(ctx).read(), before);
});

test('product control reasserts takeover after a live search-provider config reload', async () => {
  const ctx = makeContext();
  await applyControl(ctx);
  const entry = ctx.loader.entries()[0];
  entry.options.config = { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' };
  entry.fiber.config = { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' };
  ctx.get('web').searchProviderId = 'candidate-original';

  ctx.emit('loader/volatile-update', [['config', 'searchProvider']]);
  const snapshot = await ctx.get('grokSearchControl').retry();

  assert.equal(snapshot.phase, 'required');
  assert.equal(ctx.get('web').searchProviderId, 'grok-search');
  assert.equal(entry.options.config.searchProvider, 'candidate-original');
});

test('compatibility admission never rewrites required intent while control release remains available', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  let admitted = true, stops = 0;
  await applyControl(ctx, { canAcquire: () => admitted, onStop: () => { admitted = false; stops++; } });
  const service = ctx.get('grokSearchControl');
  const store = createProductStore(ctx);
  const required = store.read();
  admitted = false;
  await service.retry();
  assert.deepEqual(store.read(), required);
  assert.equal(service.publicSnapshot().policy, 'required');
  const released = await service.stop('explicit-release-while-compatibility-blocked');
  assert.equal(released.kind, 'released');
  assert.equal(stops, 1);
  assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  ctx.dispose();
});

test('an unadmitted control owner stays reachable without creating an acquisition', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx, { canAcquire: () => false });
  assert.equal(createProductStore(ctx).read(), null);
  assert.equal(ctx.get('grokSearchControl').publicSnapshot().available, true);
  assert.equal(ctx.get('grokSearchControl').publicSnapshot().policy, null);
  assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  ctx.dispose();
});

test('bootstrap keeps a failed acquisition owner alive for explicit release', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  const entry = ctx.loader.entries()[0], update = entry.update;
  entry.update = async options => {
    await update(options);
    if (options.config.searchProvider === 'grok-search') throw new Error('host applied the route then rejected');
  };
  await applyControl(ctx, { keepAliveOnFailure: true });
  const owner = ctx.get('grokSearchControl');
  assert.equal(owner.publicSnapshot().available, true);
  assert.equal(owner.publicSnapshot().phase, 'incomplete');
  assert.equal(owner.publicSnapshot().policy, 'required');
  assert.equal(ctx.get('web').searchProviderId, 'grok-search');
  const outcome = await owner.stop('explicit-release-after-initialization-failure');
  assert.equal(outcome.kind, 'released');
  assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  ctx.dispose();
});

test('explicit release waits for program cancellation before committing released intent', async () => {
  const ctx = makeContext({ originalCalls: 0 }), cancellation = deferred();
  await applyControl(ctx, { onStop: () => cancellation.promise });
  const owner = ctx.get('grokSearchControl'), store = createProductStore(ctx);
  const pending = owner.stop('explicit-stop-with-preparing-program');
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.read().intent.policy, 'required');
    assert.equal(ctx.get('web').searchProviderId, 'grok-search');
    cancellation.resolve();
    assert.equal((await pending).kind, 'released');
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  } finally { cancellation.resolve(); await pending; ctx.dispose(); }
});

test('failed program cancellation preserves required intent and a retry can finish the explicit release', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  const failure = Object.assign(new Error('program not reaped'), { code: 'GROK_PROGRAM_REAP_FAILED' });
  let stopped = false;
  await applyControl(ctx, { onStop: () => stopped ? Promise.resolve() : Promise.reject(failure) });
  const owner = ctx.get('grokSearchControl'), store = createProductStore(ctx);
  try {
    await assert.rejects(owner.stop('explicit-stop-with-unreaped-program'),
      error => error.code === 'CONTROL_RELEASE_IN_FLIGHT' && error.cause === failure);
    assert.equal(store.read().intent.policy, 'required');
    assert.equal(owner.publicSnapshot().completionCommitted, false);
    assert.equal(ctx.get('web').searchProviderId, 'grok-search');
    stopped = true;
    assert.equal((await owner.retryRelease()).completionCommitted, true);
    assert.equal(store.read().intent.policy, 'released');
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  } finally { ctx.dispose(); }
});

test('product control tolerates an older required acquisition without the new author-presence field', async () => {
  const ctx = makeContext();
  const store = createProductStore(ctx);
  const acquisition = createAcquisition(ctx);
  delete acquisition.authorSearchProviderPresent;
  const lease = createLease(ctx);
  const prior = store.compareAndSwap({ expectedRevision: 0, intent: {
    schemaVersion: 1, policy: 'required', reason: 'older-required-record', acquisition, lease, release: null } });
  await applyControl(ctx);
  const snapshot = await ctx.get('grokSearchControl').retry();
  assert.equal(snapshot.phase, 'required');
  const after = store.read();
  assert.equal(after.revision, prior.revision + 1);
  assert.equal(after.intent.acquisition.authorSearchProviderPresent, true);
  assert.deepEqual(after.intent.priorIntent, prior.intent);
  assert.equal(ctx.get('web').searchProviderId, 'grok-search');
  ctx.dispose();
});

test('a fresh control owner adopts current author selectors but rejects changes after acquisition', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  const store = createProductStore(ctx, { deferMaintenance: true });
  const entry = ctx.loader.entries()[0], manifest = join(ctx.profileContext.dir, 'package.json');
  try {
    await entry.update({ config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } });
    const prior = createRequiredRecord(ctx, store, randomUUID());
    const priorPath = join(store.directory, 'v000000000001.json');
    const priorBytes = readFileSync(priorPath);
    const currentAuthor = { searchProvider: 'ddg', fetchProvider: 'fs-quality-fetch' };
    await entry.update({ config: currentAuthor });
    writeProfile(ctx, [PRODUCT_SEARCH_BUNDLE, 'current-other-bundle']);
    const manifestBytes = readFileSync(manifest);
    const updates = [], update = entry.update;
    entry.update = async options => { updates.push(structuredClone(options.config)); return update(options); };

    await applyControl(ctx, { store });
    const owner = ctx.get('grokSearchControl'), adopted = store.read();
    assert.equal(owner.snapshot().phase, 'required');
    assert.equal(owner.snapshot().error, null);
    assert.equal(adopted.revision, prior.revision + 1);
    assert.equal(adopted.intent.policy, 'required');
    assert.equal(adopted.intent.release, null);
    assert.equal(adopted.intent.releaseCompletion, undefined);
    assert.equal(adopted.intent.pause, undefined);
    assert.equal(adopted.intent.recovery, undefined);
    assert.deepEqual(adopted.intent.priorIntent, prior.intent);
    assert.equal(adopted.intent.acquisition.authorSearchProvider, currentAuthor.searchProvider);
    assert.equal(adopted.intent.acquisition.authorSearchProviderPresent, true);
    assert.equal(adopted.intent.acquisition.authorFetchProvider, currentAuthor.fetchProvider);
    assert.deepEqual(adopted.intent.acquisition.selectedBundles, [PRODUCT_SEARCH_BUNDLE, 'current-other-bundle']);
    assert.deepEqual(adopted.intent.acquiredSelection, adopted.intent.acquisition.selectedBundles);
    assert.equal(adopted.intent.lease.hostId, PRODUCT_HOST_ID);
    assert.equal(effectiveSearchProvider(entry), 'grok-search');
    assert.equal(effectiveFetchProvider(entry), currentAuthor.fetchProvider);
    assert.deepEqual(entry.options.config, currentAuthor);
    assert.deepEqual(updates, [{ ...currentAuthor, searchProvider: 'grok-search' }]);
    assert.deepEqual(readFileSync(priorPath), priorBytes);
    assert.deepEqual(readFileSync(manifest), manifestBytes);
    await owner.retry();
    assert.deepEqual(store.read(), adopted);

    const laterAuthor = { searchProvider: 'session-author', fetchProvider: 'session-fetch' };
    await entry.update({ config: laterAuthor });
    const conflicted = await owner.retry();
    assert.equal(conflicted.phase, 'conflict');
    assert.equal(conflicted.error.code, 'CONTROL_SEARCH_SELECTION_CONFLICT');
    assert.equal(owner.publicSnapshot().completionCommitted, false);
    assert.deepEqual(store.read(), adopted);
    assert.equal(effectiveSearchProvider(entry), laterAuthor.searchProvider);
    assert.equal(effectiveFetchProvider(entry), laterAuthor.fetchProvider);
    assert.deepEqual(entry.options.config, laterAuthor);
    assert.deepEqual(updates, [{ ...currentAuthor, searchProvider: 'grok-search' }, laterAuthor]);
    assert.deepEqual(readFileSync(priorPath), priorBytes);
    assert.deepEqual(readFileSync(manifest), manifestBytes);
  } finally { ctx.dispose(); }
});

test('product owner explicit stop releases the route and records completion', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  const service = ctx.get('grokSearchControl');
  const required = await service.retry();
  assert.equal(required.phase, 'required');
  assert.equal(ctx.get('web').searchProviderId, 'grok-search');
  const outcome = await service.stop('explicit-product-stop');
  assert.equal(outcome.kind, 'released');
  assert.equal(outcome.recordCommitted, true);
  assert.equal(outcome.completionCommitted, true);
  assert.equal(outcome.routeChanged, true);
  assert.equal(outcome.routeVerified, true);
  assert.equal(service.publicSnapshot().completionCommitted, true);
  assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  const after = createProductStore(ctx).read();
  assert.equal(after.revision, 3);
  assert.equal(after.intent.policy, 'released');
  assert.equal(after.intent.release.explicit, true);
  assert.equal(after.intent.releaseCompletion.routeVerified, true);
  assert.equal(after.intent.releaseCompletion.routeChanged, true);
  assert.equal(after.intent.priorIntent.policy, 'required');
  const repeat = await service.stop('explicit-product-stop');
  assert.equal(repeat.kind, 'already-released');
  assert.equal(repeat.completionCommitted, true);
  assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  ctx.dispose();
  assert.deepEqual(createProductStore(ctx).read(), after);
});

test('an optional timeout cleanup failure does not prevent explicit search route release', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  ctx.provide('grokSearchBudgets', { release: async () => {
    throw Object.assign(new Error('optional timeout update failed'), { code: 'TEST_BUDGET_RELEASE' });
  } });
  try {
    await applyControl(ctx);
    const result = await ctx.get('grokSearchControl').stop('stop-with-unavailable-budget');
    assert.equal(result.kind, 'released');
    assert.equal(result.completionCommitted, true);
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  } finally { ctx.dispose(); }
});

test('a fresh enabled owner reacquires a completed release and preserves immutable history', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  const store = createProductStore(ctx);
  const oldOwner = ctx.get('grokSearchControl');
  await oldOwner.stop('native-bundle-disable');
  const released = store.read();
  assert.equal(released.intent.policy, 'released');
  assert.equal((await oldOwner.retry()).phase, 'released');
  await waitForRuntimeCleanup(store);
  ctx.dispose();
  ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
  await applyControl(ctx);
  const state = ctx.get('grokSearchControl').publicSnapshot();
  assert.equal(state.phase, 'required');
  assert.equal(state.completionCommitted, false);
  assert.equal(state.releaseOperationId, null);
  assert.equal(ctx.get('web').searchProviderId, 'grok-search');
  const reacquired = store.read();
  assert.equal(reacquired.revision, released.revision + 1);
  assert.equal(reacquired.intent.priorIntent.policy, 'released');
  assert.deepEqual(reacquired.intent.priorIntent.releaseCompletion, released.intent.releaseCompletion);
  assert.equal(reacquired.intent.priorIntent.priorIntent, null);
  assert.equal(released.intent.priorIntent.policy, 'required');
  ctx.dispose();
});

test('an authorized fresh native owner supersedes pending release with current author evidence', async t => {
  for (const reason of ['native-bundle-disable', 'native-component-disable']) {
    for (const route of ['current-author', 'default-author', 'product']) await t.test(`${reason}: ${route}`, async () => {
      const previousSearchEnv = process.env.DSH_WEB_SEARCH_PROVIDER;
      delete process.env.DSH_WEB_SEARCH_PROVIDER;
      const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
      const entry = ctx.loader.entries()[0];
      try {
        await entry.update({ config: { searchProvider: 'ddg', fetchProvider: 'fs-quality-fetch' } });
        ctx.provide('grokSearchRouteVerifier', { verify: () => { throw new Error('interrupted old verification'); } });
        await applyControl(ctx, { store });
        const result = await ctx.get('grokSearchControl').stop(reason);
        assert.equal(result.completionCommitted, false);
        await nextImmediate();
        const released = store.read(), path = join(store.directory, `v${String(released.revision).padStart(12, '0')}.json`);
        const bytes = readFileSync(path);
        assert.equal(productReleaseInFlight(store, released.intent.release.operationId), false);
        ctx.dispose();
        ctx.provide('grokSearchControl', undefined);
        ctx.provide('grokSearchRouteVerifier', undefined);
        ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
        const authorConfig = route === 'default-author' ? { fetchProvider: 'http' }
          : { searchProvider: 'current-author', fetchProvider: 'http' };
        await entry.update({ config: authorConfig });
        entry.options.inject = { currentDependency: { retained: true } };
        if (route === 'product') {
          entry.fiber.config.searchProvider = 'grok-search';
          ctx.get('web').searchProviderId = 'grok-search';
        }
        const acquisition = createAcquisition(ctx), lease = createLease(ctx), observations = [];
        const update = entry.update, updates = [];
        entry.update = async options => { updates.push(structuredClone(options.config)); return update(options); };
        await applyControl(ctx, { store, canSupersedeNativeRelease: observation => {
          observations.push(observation);
          return observation.record.revision === released.revision && observation.record.operationId === released.operationId;
        } });
        const acquired = store.read(), owner = ctx.get('grokSearchControl');
        assert.equal(owner.publicSnapshot().phase, 'required');
        assert.equal(owner.publicSnapshot().completionCommitted, false);
        assert.equal(acquired.revision, released.revision + 1);
        assert.equal(acquired.intent.release, null);
        assert.equal(acquired.intent.releaseCompletion, undefined);
        assert.equal(acquired.intent.recovery, undefined);
        assert.equal(acquired.intent.pause, undefined);
        assert.deepEqual(acquired.intent.priorIntent, { ...released.intent, priorIntent: null });
        assert.equal(acquired.intent.priorIntent.releaseCompletion, undefined);
        for (const key of ['authorSearchProvider', 'authorSearchProviderPresent', 'authorFetchProvider', 'authorInjectSha256']) {
          assert.equal(acquired.intent.acquisition[key], acquisition[key]);
        }
        assert.deepEqual(acquired.intent.lease, lease);
        assert.ok(observations.length >= 3, 'authorization is checked initially, at publication and before route takeover');
        for (const observed of observations) {
          assert.deepEqual(observed.record, released, 'all checks receive the original release envelope');
          assert.deepEqual(observed.lease, lease);
          assert.equal(observed.acquisition.authorInjectSha256, acquisition.authorInjectSha256);
        }
        assert.equal(effectiveSearchProvider(entry), 'grok-search');
        assert.equal(effectiveFetchProvider(entry), 'http');
        assert.deepEqual(entry.options.config, authorConfig);
        assert.deepEqual(entry.options.inject, { currentDependency: { retained: true } });
        assert.deepEqual(updates, route === 'product' ? [] : [{ ...authorConfig, searchProvider: 'grok-search' }]);
        assert.deepEqual(readFileSync(path), bytes);
        assert.equal((await owner.stop('settings-ui-explicit-stop')).completionCommitted, true);
        assert.equal(effectiveSearchProvider(entry), acquisition.authorSearchProvider);
        assert.equal(effectiveFetchProvider(entry), 'http');
        assert.deepEqual(entry.options.config, authorConfig);
        assert.deepEqual(readFileSync(path), bytes);
      } finally {
        ctx.dispose();
        if (previousSearchEnv === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER;
        else process.env.DSH_WEB_SEARCH_PROVIDER = previousSearchEnv;
      }
    });
  }
});

test('native supersession remains opt-in and cannot replace explicit stop, newer pause or a busy owner', async t => {
  for (const mode of ['default', 'denied', 'truthy', 'async', 'settings-stop', 'other-release', 'historic-release', 'newer-pause', 'busy']) {
    await t.test(mode, async () => {
      const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
      const reason = mode === 'settings-stop' ? 'settings-ui-explicit-stop'
        : mode === 'other-release' ? 'explicit-user-release' : 'native-bundle-disable';
      let { released } = createInterruptedReleaseRecord(ctx, store, randomUUID(), reason);
      if (mode === 'historic-release') released = store.compareAndSwap({ expectedRevision: released.revision,
        intent: { ...released.intent, release: { ...released.intent.release, kind: 'historic-release' } } });
      if (mode === 'newer-pause') released = store.compareAndSwap({ expectedRevision: released.revision,
        intent: { ...released.intent, pause: { confirmed: true, reason: 'external-user-pause' } } });
      const pending = deferred(), entry = ctx.loader.entries()[0];
      await entry.update({ config: { searchProvider: 'current-author', fetchProvider: 'http' } });
      let calls = 0;
      const canSupersedeNativeRelease = () => {
        calls++;
        return mode === 'denied' ? false : mode === 'truthy' ? 'yes' : mode === 'async' ? Promise.resolve(true) : true;
      };
      if (mode === 'busy') holdProductRelease(store, released.intent.release.operationId, pending.promise);
      try {
        await applyControl(ctx, { store, ...(mode === 'default' ? {} : { canSupersedeNativeRelease }) });
        assert.equal(ctx.get('grokSearchControl').snapshot().phase, 'released');
        assert.equal(ctx.get('grokSearchControl').publicSnapshot().completionCommitted, false);
        assert.deepEqual(store.read(), released);
        assert.equal(effectiveSearchProvider(entry), 'current-author');
        assert.equal(calls, ['denied', 'truthy', 'async'].includes(mode) ? 1 : 0);
      } finally { pending.resolve(); await pending.promise; ctx.dispose(); }
    });
  }
});

test('an already acquired owner cannot supersede a later pending native release', async () => {
  const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
  let grants = 0;
  try {
    await applyControl(ctx, { store, canSupersedeNativeRelease: () => { grants++; return true; } });
    const required = store.read(), reason = 'native-bundle-disable';
    const released = store.compareAndSwap({ expectedRevision: required.revision, intent: {
      ...required.intent, policy: 'released', reason, priorIntent: required.intent,
      pause: { confirmed: true, reason }, release: { explicit: true, kind: 'intent-release-commit',
        committedAt: new Date().toISOString(), operationId: randomUUID(), hostId: PRODUCT_HOST_ID, counterBaseline: 0 },
    } });
    assert.equal((await ctx.get('grokSearchControl').retry()).phase, 'released');
    assert.deepEqual(store.read(), released);
    assert.equal(grants, 0);
  } finally { ctx.dispose(); }
});

test('native supersession rechecks authorization and resources after waiting for the writer lock', async t => {
  for (const change of ['grant', 'busy', 'epoch', 'admission', 'selection', 'author', 'fetch', 'dependencies', 'web-owner', 'record']) {
    await t.test(change, async () => {
      const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
      const { released } = createInterruptedReleaseRecord(ctx, store), waiting = deferred(), pending = deferred();
      const entry = ctx.loader.entries()[0];
      await entry.update({ config: { searchProvider: 'current-author', fetchProvider: 'http' } });
      const lock = acquireOwnedLock(join(store.directory, 'control-write.lock'));
      let authorized = true, current = true, admitted = true, expected = released;
      const observations = [];
      const starting = applyControl(ctx, {
        store: { ...store, compareAndSwapAsync(request) { waiting.resolve(); return store.compareAndSwapAsync(request); } },
        canSupersedeNativeRelease: observation => { observations.push(observation); return authorized; },
        canAcquire: () => admitted, isCurrent: () => current, keepAliveOnFailure: true,
      });
      try {
        await waiting.promise;
        if (change === 'grant') authorized = false;
        else if (change === 'busy') holdProductRelease(store, released.intent.release.operationId, pending.promise);
        else if (change === 'epoch') current = false;
        else if (change === 'admission') admitted = false;
        else if (change === 'selection') writeProfile(ctx, ['different-bundle']);
        else if (change === 'author') {
          entry.options.config.searchProvider = 'changed-author';
          entry.fiber.config.searchProvider = 'changed-author';
          ctx.get('web').searchProviderId = 'changed-author';
        } else if (change === 'fetch') {
          entry.options.config.fetchProvider = 'changed-fetch';
          entry.fiber.config.fetchProvider = 'changed-fetch';
          ctx.get('web').fetchProviderId = 'changed-fetch';
        } else if (change === 'dependencies') entry.options.inject = { laterDependency: {} };
        else if (change === 'web-owner') entry.fiber.uid++;
        else {
          lock.release();
          expected = store.compareAndSwap({ expectedRevision: released.revision,
            intent: { ...released.intent, pause: { confirmed: true, reason: 'newer-explicit-pause' } } });
        }
        lock.release();
        await starting;
        assert.deepEqual(store.read(), expected);
        assert.equal(store.read().intent.releaseCompletion, undefined);
        assert.equal(ctx.get('grokSearchControl').snapshot().phase, 'incomplete');
        assert.equal(effectiveSearchProvider(entry), change === 'author' ? 'changed-author' : 'current-author');
        assert.ok(observations.length >= 1);
        for (const observed of observations) assert.deepEqual(observed.record, released);
      } finally {
        lock.release(); pending.resolve();
        await starting.catch(() => {}); await pending.promise; ctx.dispose();
      }
    });
  }
});

test('explicit stop cancels a reactivation still waiting for the control writer lock', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  await ctx.get('grokSearchControl').stop('before-reactivation');
  const store = createProductStore(ctx), released = store.read();
  ctx.dispose();
  ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
  const lock = acquireOwnedLock(join(store.directory, 'control-write.lock'));
  const starting = applyControl(ctx);
  try {
    const stopped = await ctx.get('grokSearchControl').stop('cancel-reactivation');
    assert.equal(stopped.kind, 'already-released');
    lock.release();
    await starting;
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
    assert.deepEqual(store.read(), released);
    assert.equal(ctx.get('grokSearchControl').publicSnapshot().phase, 'released');
  } finally {
    lock.release();
    await starting.catch(() => {});
    ctx.dispose();
  }
});

test('disposing a reactivation waiting on storage leaves the completed release unchanged', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  await ctx.get('grokSearchControl').stop('before-disposal');
  const store = createProductStore(ctx), released = store.read();
  ctx.dispose();
  ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
  const lock = acquireOwnedLock(join(store.directory, 'control-write.lock'));
  const starting = applyControl(ctx);
  try {
    ctx.dispose();
    lock.release();
    await starting;
    assert.deepEqual(store.read(), released);
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
    assert.equal(ctx.get('grokSearchControl').publicSnapshot().phase, 'disposed');
  } finally { lock.release(); await starting.catch(() => {}); ctx.dispose(); }
});

test('acquisition rechecks live authorization and author inputs after waiting for storage', async t => {
  for (const change of ['selection', 'admission', 'epoch', 'web-owner', 'fetch', 'dependencies']) {
    await t.test(change, async () => {
      const ctx = makeContext({ originalCalls: 0 }), waiting = deferred();
      const store = createProductStore(ctx, { deferMaintenance: true });
      const prior = createRequiredRecord(ctx, store, randomUUID());
      const lock = acquireOwnedLock(join(store.directory, 'control-write.lock'));
      let admitted = true, current = true;
      const starting = applyControl(ctx, {
        store: { ...store, compareAndSwapAsync(request) {
          waiting.resolve();
          return store.compareAndSwapAsync(request);
        } },
        canAcquire: () => admitted, isCurrent: () => current, keepAliveOnFailure: true,
      });
      try {
        await waiting.promise;
        const entry = ctx.loader.entries()[0];
        if (change === 'selection') writeProfile(ctx, ['different-bundle']);
        else if (change === 'admission') admitted = false;
        else if (change === 'epoch') current = false;
        else if (change === 'web-owner') entry.fiber.uid++;
        else if (change === 'fetch') {
          entry.fiber.config.fetchProvider = 'different-fetch';
          entry.options.config.fetchProvider = 'different-fetch';
          ctx.get('web').fetchProviderId = 'different-fetch';
        } else entry.options.inject = { changedDependency: {} };
        lock.release();
        await starting;
        assert.deepEqual(store.read(), prior, 'a waiting owner cannot commit cached authorization');
        assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
        assert.equal(ctx.get('grokSearchControl').snapshot().phase, 'incomplete');
      } finally { lock.release(); await starting.catch(() => {}); ctx.dispose(); }
    });
  }
});

test('acquisition does not take over a release committed before its write returns', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  const store = createProductStore(ctx, { deferMaintenance: true });
  let released;
  const concurrent = { ...store, async compareAndSwapAsync(request) {
    const required = await store.compareAndSwapAsync(request);
    released = store.compareAndSwap({ expectedRevision: required.revision, intent: {
      ...required.intent, policy: 'released', priorIntent: required.intent,
      release: { explicit: true, committedAt: new Date().toISOString(),
        kind: 'intent-release-commit', operationId: randomUUID(), counterBaseline: 0 },
    } });
    return required;
  } };
  try {
    await applyControl(ctx, { store: concurrent, keepAliveOnFailure: true });
    assert.deepEqual(store.read(), released);
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
    assert.equal(ctx.get('grokSearchControl').snapshot().phase, 'incomplete');
  } finally { ctx.dispose(); }
});

test('product control stop prelude failure is recorded and retryable', async () => {
  const ctx = makeContext();
  await applyControl(ctx);
  const service = ctx.get('grokSearchControl');
  await service.retry();
  const core = ctx.get('grokSearchCore');
  const unchanged = service.publicSnapshot();
  await service.retryRelease();
  assert.deepEqual(service.publicSnapshot(), unchanged, 'retry without stop intent is read-only');
  let disposals = 0;
  core.dispose = async () => { disposals += 1; };

  await assert.rejects(() => service.stop('missing-counter'),
    error => error.code === 'CONTROL_ROUTE_COUNTER_REQUIRED');
  const failed = service.publicSnapshot();
  assert.equal(failed.phase, 'incomplete');
  assert.equal(failed.error.code, 'CONTROL_ROUTE_COUNTER_REQUIRED');
  assert.equal(failed.completionCommitted, false);
  assert.equal(failed.canStop, false);
  assert.equal(core.releaseBarrier.snapshot().state, 'stopping');
  assert.equal(disposals, 1);
  assert.throws(() => core.releaseBarrier.begin({ operationId: randomUUID() }),
    error => error.code === 'CONTROL_RELEASE_BARRIER_INACTIVE');
  assert.equal(ctx.get('web').searchProviderId, 'grok-search');
  const beforeRetry = createProductStore(ctx).read();
  assert.equal(beforeRetry.intent.policy, 'required');
  await service.retry();
  assert.deepEqual(createProductStore(ctx).read(), beforeRetry);

  ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: 0 }) });
  const outcome = await service.retryRelease();
  assert.equal(outcome.phase, 'released');
  assert.equal(service.publicSnapshot().completionCommitted, true);
  assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  assert.equal(disposals, 1);
  assert.equal(createProductStore(ctx).read().intent.releaseCompletion.routeBefore, 'grok-search');
  ctx.dispose();
});

test('product control refresh waits for an in-flight release instead of writing a required revision', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  const service = ctx.get('grokSearchControl');
  await service.retry();

  const gate = deferred();
  ctx.provide('grokSearchCore', {
    releaseBarrier: createReleaseBarrier(),
    dispose: () => gate.promise,
  });
  const release = service.stop('delayed-release');
  const retry = service.retry();
  assert.equal(retry, release);
  assert.equal(createProductStore(ctx).read().intent.policy, 'required');

  gate.resolve();
  const outcome = await release;
  assert.equal(outcome.kind, 'released');
  assert.equal(service.publicSnapshot().phase, 'released');
  assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  ctx.dispose();
});

test('explicit stop supersedes a pending takeover and restores the author after the late host update', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  const takeover = gateTakeover(ctx);
  const mounting = applyControl(ctx);
  mounting.catch(() => {});
  await takeover.started;
  const service = ctx.get('grokSearchControl');
  const release = service.stop('stop-during-takeover');
  release.catch(() => {});
  try {
    assert.equal(service.retry(), release);
    assert.equal(await Promise.race([
      release.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 50)),
    ]), 'pending');
    takeover.release();
    assert.equal((await release).kind, 'released');
    await mounting;
    const record = createProductStore(ctx).read();
    assert.equal(record.intent.policy, 'released');
    assert.equal(record.intent.releaseCompletion.routeVerified, true);
    assert.equal(record.intent.releaseCompletion.routeChanged, true);
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
    assert.equal(effectiveSearchProvider(ctx.loader.entries()[0]), 'candidate-original');
    assert.equal(service.publicSnapshot().phase, 'released');
    await service.retry();
    ctx.emit('loader/volatile-update', [['config', 'searchProvider']]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(createProductStore(ctx).read(), record);
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  } finally {
    takeover.release();
    await Promise.allSettled([mounting, release]);
    ctx.dispose();
  }
});

test('a takeover that fails or rolls back after an explicit stop cannot overwrite the release', async t => {
  for (const mode of ['reject', 'ignore', 'apply-then-reject']) {
    await t.test(mode, async () => {
      const ctx = makeContext({ originalCalls: 0 });
      const takeover = gateTakeover(ctx, mode);
      const mounting = applyControl(ctx);
      mounting.catch(() => {});
      await takeover.started;
      const service = ctx.get('grokSearchControl');
      const release = service.stop(`stop-before-${mode}`);
      release.catch(() => {});
      try {
        assert.equal(service.retry(), release);
        takeover.release();
        assert.equal((await release).kind, 'released');
        await mounting;
        assert.equal(service.publicSnapshot().phase, 'released');
        assert.equal(service.publicSnapshot().error, null);
        assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
        assert.equal(effectiveSearchProvider(ctx.loader.entries()[0]), 'candidate-original');
        const record = createProductStore(ctx).read();
        await service.retry();
        assert.deepEqual(createProductStore(ctx).read(), record);
      } finally {
        takeover.release();
        await Promise.allSettled([mounting, release]);
        ctx.dispose();
      }
    });
  }
});

test('route takeover rejects when the host does not apply the product provider', async () => {
  const runtime = { searchProviderId: 'candidate-original', fetchProviderId: 'candidate-fetch' };
  const entry = {
    options: { id: 'web', name: '@deepseek-ai/dsh-web',
      config: { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' } },
    fiber: {
      uid: 7, state: 2, config: { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' },
      ctx: { get: () => runtime },
    },
    async update() {},
  };
  const ctx = { loader: { entries: () => [entry] } };
  await assert.rejects(() => takeOverAuthorRoute(ctx, { authorSearchProvider: 'candidate-original' },
    { entryId: 'web', moduleName: '@deepseek-ai/dsh-web' }),
  error => error.code === 'CONTROL_ROUTE_UPDATE_NOT_APPLIED');
  assert.equal(effectiveSearchProvider(entry), 'candidate-original');
});

test('a finishing takeover preserves an author config edit made while its host update was pending', async t => {
  for (const edit of ['replacement', 'in-place']) await t.test(edit, async () => {
    const ctx = makeContext(), entry = ctx.loader.entries()[0];
    const acquisition = createAcquisition(ctx), lease = createLease(ctx);
    const started = deferred(), finish = deferred(), update = entry.update;
    entry.update = async options => {
      await update(options);
      if (edit === 'in-place') entry.options.config = options.config;
      started.resolve();
      await finish.promise;
    };
    const pending = takeOverAuthorRoute(ctx, acquisition, lease);
    try {
      await started.promise;
      if (edit === 'replacement') entry.options.config = { searchProvider: 'candidate-original' };
      const author = entry.options.config;
      author.fetchProvider = 'new-author-fetch';
      finish.resolve();
      await pending;
      assert.equal(entry.options.config, author);
      assert.equal(entry.options.config.fetchProvider, 'new-author-fetch');
    } finally { finish.resolve(); await pending.catch(() => {}); ctx.dispose(); }
  });
});

test('route takeover never restores the author automatically when the host throws after applying a change', async () => {
  const runtime = { searchProviderId: 'candidate-original', fetchProviderId: 'candidate-fetch' };
  let attempts = 0;
  const entry = {
    options: { id: 'web', name: '@deepseek-ai/dsh-web',
      config: { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' } },
    fiber: {
      uid: 7, state: 2, config: { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' },
      ctx: { get: () => runtime },
    },
    async update(options) {
      entry.options.config = structuredClone(options.config);
      entry.fiber.config = structuredClone(options.config);
      runtime.searchProviderId = options.config.searchProvider;
      runtime.fetchProviderId = options.config.fetchProvider;
      attempts += 1;
      if (attempts === 1) throw new Error('host update failed');
    },
  };
  const ctx = { loader: { entries: () => [entry] } };
  await assert.rejects(() => takeOverAuthorRoute(ctx, { authorSearchProvider: 'candidate-original' },
    { entryId: 'web', moduleName: '@deepseek-ai/dsh-web' }), error => error.message === 'host update failed');
  assert.equal(effectiveSearchProvider(entry), 'grok-search');
  assert.equal(effectiveFetchProvider(entry), 'candidate-fetch');
  assert.equal(attempts, 1);
});

test('effective provider parsing is safe when the runtime service lookup throws and includes the fetch env fallback', () => {
  const entry = {
    options: { config: {} },
    fiber: {
      config: { searchProvider: 'configured-search' },
      ctx: { get() { throw new Error('runtime unavailable'); } },
    },
  };
  assert.equal(effectiveSearchProvider(entry), 'configured-search');

  const previous = process.env.DSH_WEB_FETCH_PROVIDER;
  process.env.DSH_WEB_FETCH_PROVIDER = 'env-fetch-provider';
  try {
    const envEntry = {
      options: { config: {} },
      fiber: { config: {}, ctx: { get: () => ({ config: { fetchProvider: { get: () => undefined } } }) } },
    };
    assert.equal(effectiveFetchProvider(envEntry), 'env-fetch-provider');
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_FETCH_PROVIDER;
    else process.env.DSH_WEB_FETCH_PROVIDER = previous;
  }
});

test('Cordis 4.1 route receipts read effective config rather than pending raw input', () => {
  const entry = {
    options: { config: { searchProvider: 'author-search', fetchProvider: 'author-fetch' } },
    fiber: {
      config: { searchProvider: 'pending-search', fetchProvider: 'pending-fetch' },
      effectiveConfig: { searchProvider: { get: () => 'grok-search' }, fetchProvider: { get: () => 'author-fetch' } },
      ctx: { get: () => null },
    },
  };
  assert.equal(effectiveSearchProvider(entry), 'grok-search');
  assert.equal(effectiveFetchProvider(entry), 'author-fetch');
});

test('config hooks protect only the owning web entry in both Cordis contracts', () => {
  const author = { searchProvider: 'author-search', fetchProvider: 'author-fetch' };
  const entry = { options: { id: 'web', name: '@deepseek-ai/dsh-web' } };
  const legacyFiber = { entry, parent: { fiber: {} } };
  let required = true, resolves = 0;
  const resolveConfig = (_runtime, value) => {
    resolves++;
    return Object.fromEntries(Object.entries(value).map(([name, selected]) => [name, { get: () => selected }]));
  };
  const hook = createSearchConfigHook({ required: () => required, resolveConfig });
  const oldResult = hook.call(legacyFiber, author, () => author);
  assert.deepEqual(oldResult, { ...author, searchProvider: 'grok-search' });
  assert.deepEqual(author, { searchProvider: 'author-search', fetchProvider: 'author-fetch' });
  assert.equal(resolves, 0);
  const modernFiber = { ...legacyFiber, runtime: {}, resolveConfig() { throw new Error('must not recursively resolve hooks'); } };
  const resolved = resolveConfig(null, author);
  const modernResult = hook(modernFiber, () => resolved);
  assert.equal(modernResult.searchProvider.get(), 'grok-search');
  assert.equal(modernResult.fetchProvider.get(), 'author-fetch');
  assert.equal(resolved.searchProvider.get(), 'author-search');
  assert.equal(resolves, 2);
  const child = { ...modernFiber, parent: { fiber: { entry } } };
  assert.equal(hook(child, () => resolved), resolved);
  assert.equal(hook({ ...modernFiber, entry: { options: { id: 'other' } } }, () => resolved), resolved);
  required = false;
  assert.equal(hook(modernFiber, () => resolved), resolved);
  assert.equal(hook.call(legacyFiber, author, () => author), author);
});

test('modern unactivated fibers do not expose raw input as an effective config', () => {
  assert.equal(effectiveConfig({ effectiveConfig: undefined, config: { searchProvider: 'not-applied' } }), undefined);
  const legacy = { searchProvider: 'legacy-active' };
  assert.equal(effectiveConfig({ config: legacy }), legacy);
});

test('Cordis 4.1 takeover and release preserve effective fetch and raw author configuration', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  const entry = ctx.loader.entries()[0];
  const author = structuredClone(entry.options.config);
  entry.fiber.effectiveConfig = structuredClone(author);
  entry.fiber.config = { searchProvider: 'uncommitted-search', fetchProvider: 'uncommitted-fetch' };
  entry.update = async ({ config }) => {
    entry.options.config = structuredClone(config);
    entry.fiber.config = structuredClone(config);
    entry.fiber.effectiveConfig = structuredClone(config);
  };
  const acquisition = createAcquisition(ctx), lease = createLease(ctx);
  assert.equal(acquisition.authorSearchProvider, author.searchProvider);
  assert.equal(acquisition.authorFetchProvider, author.fetchProvider);
  await takeOverAuthorRoute(ctx, acquisition, lease);
  assert.equal(effectiveSearchProvider(entry), 'grok-search');
  assert.equal(effectiveFetchProvider(entry), author.fetchProvider);
  assert.deepEqual(entry.options.config, author);
  await restoreAuthorRoute(ctx, { acquisition, lease });
  assert.equal(effectiveSearchProvider(entry), author.searchProvider);
  assert.equal(effectiveFetchProvider(entry), author.fetchProvider);
  ctx.dispose();
});

test('acquisition and route receipt use the same effective fetch environment value', () => {
  const previous = process.env.DSH_WEB_FETCH_PROVIDER;
  process.env.DSH_WEB_FETCH_PROVIDER = 'env-fetch-provider';
  try {
    const ctx = makeContext();
    const web = ctx.loader.entries()[0];
    delete web.options.config.fetchProvider;
    delete web.fiber.config.fetchProvider;
    ctx.provide('web', { searchProviderId: 'candidate-original', fetchProviderId: null });
    ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: 0 }) });
    const acquisition = createAcquisition(ctx);
    assert.equal(acquisition.authorFetchProvider, 'env-fetch-provider');
    const receipt = routeReceipt(ctx, {
      authorSearchProvider: acquisition.authorSearchProvider,
      authorFetchProvider: acquisition.authorFetchProvider,
      expectedInjectSha256: acquisition.authorInjectSha256,
      counterBaseline: 0,
    });
    assert.equal(receipt.fetchPreserved, true);
    assert.equal(receipt.actualFetchProvider, 'env-fetch-provider');
    assert.equal(receipt.dependenciesPreserved, true);
    ctx.dispose();
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_FETCH_PROVIDER;
    else process.env.DSH_WEB_FETCH_PROVIDER = previous;
  }
});

test('release verification fails closed without a recorded inject baseline', async () => {
  const ctx = makeContext();
  const controller = createProductReleaseController({
    ctx,
    priorIntent: { lease: createLease(ctx), acquisition: {
      authorSearchProvider: 'candidate-original', authorFetchProvider: 'candidate-fetch',
    } },
    core: ctx.get('grokSearchCore'),
  });
  await assert.rejects(() => controller.verify({ routeChanged: false, counterBaseline: 0 }),
    error => error.code === 'CONTROL_RELEASE_INJECT_BASELINE_REQUIRED');
  ctx.dispose();
});

test('release without a historical inject baseline does not submit completion', async () => {
  const ctx = makeContext();
  const store = createProductStore(ctx);
  const acquisition = createAcquisition(ctx);
  delete acquisition.authorInjectSha256;
  const lease = createLease(ctx);
  const required = store.compareAndSwap({ expectedRevision: 0, intent: {
    schemaVersion: 1, policy: 'required', reason: 'legacy-inject-baseline', acquisition, lease, release: null,
  } });
  const controller = createProductReleaseController({
    ctx, priorIntent: required.intent, core: ctx.get('grokSearchCore'),
  });
  const outcome = await commitExplicitRelease({
    store, owner: createLease(ctx), controller, counterBaseline: 0,
  });
  assert.equal(outcome.kind, 'incomplete');
  assert.equal(outcome.completionCommitted, false);
  assert.equal(store.read().intent.releaseCompletion, undefined);
  ctx.dispose();
});

test('a first native release timeout keeps required ownership blocked until the real barrier is idle', async () => {
  const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
  const barrier = createReleaseBarrier({ drainTimeoutMs: 1 }), operationId = randomUUID();
  ctx.provide('grokSearchCore', { releaseBarrier: barrier, dispose: async () => {} });
  try {
    await applyControl(ctx, { store });
    const oldOwner = ctx.get('grokSearchControl'), required = store.read();
    barrier.begin({ operationId });
    await assert.rejects(oldOwner.stop('native-bundle-disable'), { code: 'CONTROL_RELEASE_DRAIN_TIMEOUT' });
    assert.deepEqual(store.read(), required);
    assert.equal(productRuntimeCleanupInFlight(store), true);
    ctx.dispose();
    ctx.provide('grokSearchControl', undefined);
    ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
    ctx.fiber.uid++;
    await applyControl(ctx, { store, keepAliveOnFailure: true });
    const nextOwner = ctx.get('grokSearchControl');
    assert.equal(nextOwner.snapshot().error.code, 'CONTROL_RUNTIME_CLEANUP_PENDING');
    assert.deepEqual(store.read(), required, 'a fresh owner cannot adopt the stale required record while cleanup lives');
    barrier.settle({ operationId });
    await waitForRuntimeCleanup(store);
    assert.equal((await nextOwner.retry()).phase, 'required');
    assert.equal(store.read().revision, required.revision, 'an unchanged lease resumes without inventing a revision');
    assert.equal(productRuntimeCleanupInFlight(store), false, 'a running owner is not a cleanup lease');
  } finally { barrier.settle({ operationId }); await nextImmediate(); ctx.dispose(); }
});

test('early release failures retain real disposal, cancellation and barrier proofs', async t => {
  for (const failure of ['counter', 'lease', 'read', 'missing-record']) await t.test(failure, async () => {
    const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
    const disposal = deferred(), cancellation = deferred(), barrier = createReleaseBarrier(), operationId = randomUUID();
    let readFailure = false, stopSawBusy = false;
    const suppliedStore = failure === 'read' ? { ...store, read() {
      if (readFailure) throw Object.assign(new Error('record unavailable'), { code: 'TEST_RECORD_UNAVAILABLE' });
      return store.read();
    } } : store;
    ctx.provide('grokSearchCore', { releaseBarrier: barrier, dispose: () => disposal.promise });
    try {
      await applyControl(ctx, { store: suppliedStore, canAcquire: () => failure !== 'missing-record',
        onStop: () => { stopSawBusy = productRuntimeCleanupInFlight(store); return cancellation.promise; } });
      const before = store.read();
      barrier.begin({ operationId });
      if (failure === 'counter') ctx.provide('grokSearchOriginalSearchCounter', undefined);
      if (failure === 'lease') ctx.loader.entries()[0].fiber.uid++;
      if (failure === 'read') readFailure = true;
      const errorCode = { counter: 'CONTROL_ROUTE_COUNTER_REQUIRED', lease: 'CONTROL_RELEASE_OWNERSHIP_CONFLICT',
        read: 'TEST_RECORD_UNAVAILABLE', 'missing-record': 'CONTROL_RELEASE_RECORD_MISSING' }[failure];
      await assert.rejects(ctx.get('grokSearchControl').stop('native-bundle-disable'), { code: errorCode });
      readFailure = false;
      assert.equal(stopSawBusy, true, 'onStop already observes the registered cleanup');
      assert.equal(productRuntimeCleanupInFlight(store), true);
      assert.deepEqual(store.read(), before);
      if (failure === 'missing-record') assert.equal(existsSync(store.directory), false);
      disposal.resolve(); await disposal.promise; await nextImmediate();
      assert.equal(productRuntimeCleanupInFlight(store), true);
      cancellation.resolve(); await cancellation.promise; await nextImmediate();
      assert.equal(productRuntimeCleanupInFlight(store), true, 'barrier proof is still required before controller.drain was called');
      barrier.settle({ operationId });
      await waitForRuntimeCleanup(store);
      assert.deepEqual(store.read(), before);
    } finally {
      readFailure = false; disposal.resolve(); cancellation.resolve(); barrier.settle({ operationId });
      await Promise.all([disposal.promise, cancellation.promise]); await nextImmediate(); ctx.dispose();
    }
  });
});

test('an early failed cleanup keeps the profile blocked when any resource lacks exit proof', async () => {
  const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
  const disposal = deferred(), cancellation = deferred(), exited = deferred();
  ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: () => disposal.promise });
  try {
    await applyControl(ctx, { store, onStop: () => cancellation.promise });
    ctx.loader.entries()[0].fiber.uid++;
    await assert.rejects(ctx.get('grokSearchControl').stop('native-bundle-disable'), { code: 'CONTROL_RELEASE_OWNERSHIP_CONFLICT' });
    disposal.reject(Object.assign(new Error('core has not exited'), { code: 'GROK_PROCESS_REAP_FAILED', whenExited: exited.promise }));
    cancellation.reject(Object.assign(new Error('program cleanup unproven'), { code: 'GROK_PROGRAM_REAP_FAILED' }));
    exited.resolve(); await nextImmediate(); await nextImmediate();
    assert.equal(productRuntimeCleanupInFlight(store), true, 'one successful exit proof cannot hide another unproven cleanup');
    assert.equal(store.read().intent.policy, 'required');
  } finally {
    disposal.resolve(); cancellation.resolve(); exited.resolve();
    await Promise.allSettled([disposal.promise, cancellation.promise, exited.promise]); ctx.dispose();
  }
});

test('all acquisitions recheck profile cleanup at the writer lock and before takeover', async t => {
  for (const boundary of ['writer', 'takeover']) await t.test(boundary, async () => {
    const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
    const before = createRequiredRecord(ctx, store, randomUUID()), waiting = deferred(), cleanup = deferred();
    let lock, published = null;
    if (boundary === 'writer') lock = acquireOwnedLock(join(store.directory, 'control-write.lock'));
    const observedStore = { ...store, async compareAndSwapAsync(request) {
      waiting.resolve();
      const result = await store.compareAndSwapAsync(request);
      if (boundary === 'takeover') { published = result; holdProductRelease(store, {}, cleanup.promise); }
      return result;
    } };
    const starting = applyControl(ctx, { store: observedStore, keepAliveOnFailure: true });
    try {
      await waiting.promise;
      if (boundary === 'writer') { holdProductRelease(store, {}, cleanup.promise); lock.release(); }
      await starting;
      assert.equal(ctx.get('grokSearchControl').snapshot().error.code, 'CONTROL_RUNTIME_CLEANUP_PENDING');
      assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
      assert.deepEqual(store.read(), published ?? before);
      cleanup.resolve(); await waitForRuntimeCleanup(store);
      assert.equal((await ctx.get('grokSearchControl').retry()).phase, 'required');
    } finally { lock?.release(); cleanup.resolve(); await starting.catch(() => {}); await nextImmediate(); ctx.dispose(); }
  });
});

test('release drain has its own timeout when the core never settles', async () => {
  const ctx = makeContext();
  const controller = createProductReleaseController({
    ctx,
    priorIntent: { lease: createLease(ctx), acquisition: {
      authorSearchProvider: 'candidate-original', authorFetchProvider: 'candidate-fetch',
      authorInjectSha256: 'a'.repeat(64),
    } },
    core: { releaseBarrier: createReleaseBarrier(), dispose: () => new Promise(() => {}) },
    disposeTimeoutMs: 25,
  });
  controller.invalidate({ reason: 'test-timeout' });
  await assert.rejects(() => controller.drain(), error => error.code === 'CONTROL_RELEASE_DRAIN_TIMEOUT');
  ctx.dispose();
});

test('release drain fails closed while a route takeover never settles', async () => {
  const ctx = makeContext();
  const controller = createProductReleaseController({
    ctx,
    priorIntent: { lease: createLease(ctx), acquisition: {
      authorSearchProvider: 'candidate-original', authorFetchProvider: 'candidate-fetch',
      authorInjectSha256: 'a'.repeat(64),
    } },
    core: { releaseBarrier: createReleaseBarrier(), dispose: async () => {} },
    disposeTimeoutMs: 25,
    pendingTakeovers: () => new Promise(() => {}),
  });
  controller.invalidate({ reason: 'test-takeover-timeout' });
  await assert.rejects(() => controller.drain(), error => error.code === 'CONTROL_RELEASE_DRAIN_TIMEOUT');
  ctx.dispose();
});

test('native release timeout keeps real disposal, barrier work and late takeover registered', async t => {
  for (const first of ['dispose', 'barrier']) await t.test(`${first} settles first`, async () => {
    const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx);
    const required = createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
    const operationId = randomUUID(), barrierOperationId = randomUUID();
    const disposal = deferred(), takeover = deferred(), idle = deferred();
    const barrier = createReleaseBarrier({ drainTimeoutMs: 1 });
    barrier.begin({ operationId: barrierOperationId });
    const controller = createProductReleaseController({
      ctx, priorIntent: required.intent,
      core: { releaseBarrier: barrier, dispose: () => disposal.promise },
      disposeTimeoutMs: 1, pendingTakeovers: () => takeover.promise,
    });
    controller.invalidate({ reason: 'native-bundle-disable' });
    const release = controller.drain(), cleanup = controller.whenDrained();
    let cleanupFinished = false, notifications = 0;
    cleanup.then(() => { cleanupFinished = true; }, () => {});
    holdProductRelease(store, operationId, release, { whenDrained: cleanup });
    const unsubscribe = onProductReleaseIdle(store, operationId, () => { notifications++; idle.resolve(); });
    try {
      await assert.rejects(release, { code: 'CONTROL_RELEASE_DRAIN_TIMEOUT' });
      await nextImmediate();
      assert.equal(productReleaseInFlight(store, operationId), true);
      assert.equal(cleanupFinished, false);
      assert.equal(notifications, 0);
      assert.deepEqual(store.read(), required);
      if (first === 'dispose') disposal.resolve();
      else barrier.settle({ operationId: barrierOperationId });
      await nextImmediate();
      assert.equal(cleanupFinished, false);
      assert.equal(productReleaseInFlight(store, operationId), true);
      if (first === 'dispose') barrier.settle({ operationId: barrierOperationId });
      else disposal.resolve();
      await nextImmediate();
      assert.equal(cleanupFinished, false, 'a late host takeover still prevents quiescence');
      assert.equal(notifications, 0);
      takeover.resolve();
      await waitForNotification(idle.promise);
      assert.equal(cleanupFinished, true);
      assert.equal(productReleaseInFlight(store, operationId), false);
      assert.equal(notifications, 1);
      assert.deepEqual(store.read(), required);
    } finally {
      unsubscribe();
      disposal.resolve(); takeover.resolve(); barrier.settle({ operationId: barrierOperationId });
      await Promise.allSettled([release, cleanup]);
      ctx.dispose();
    }
  });
});

test('public snapshot keeps route verification separate from committed completion', () => {
  const projected = projectPublicSnapshot({
    phase: 'incomplete', record: { policy: 'released' }, revision: 3, releaseOperationId: 'operation',
    releaseOutcome: { kind: 'incomplete', completionCommitted: false, routeChanged: true, routeVerified: true },
    error: { code: 'CONTROL_RECORD_WRITE_FAILED', message: 'completion write failed' },
  });
  assert.equal(projected.routeVerified, true);
  assert.equal(projected.completionCommitted, false);
  assert.equal(projected.phase, 'incomplete');
});

// These wiring fixtures inject stand-ins without changing production peer loading.
const SettingsGateway = createSettingsGateway({
  Service: class {
    constructor(ctx, key) { this.ctx = ctx; ctx.provide?.(key, this); }
  },
  RemoteError: class extends Error {
    constructor(code, message, details) {
      super(message); this.code = code; this.details = details; this.isDSHRemoteError = true;
    }
  },
});

test('settings gateway unavailable snapshot includes completionCommitted', async () => withIsolatedHome(async home => {
  // The owner check fails closed without connection security; this case covers
  // the unavailable control projection, so supply a verified local owner.
  const gateway = new SettingsGateway({ get: key => key === 'grokSearchConnectionSecurity' ? {
    requireOwner() {},
    capabilities: () => ({ secretsAllowed: false, transport: 'restricted', reason: null }),
  } : null, provide() {} });
  const snapshot = await gateway.snapshot();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.completionCommitted, false);
  assert.equal(snapshot.config.path, join(home, '.config/grok-search-rs/config.toml'));
  assert.equal(snapshot.plugin.configSource, 'default');
}));

test('real control snapshot and stop results satisfy the strict settings RPC codecs', async () => withIsolatedHome(async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  ctx.provide('grokSearchProgram', { snapshot: () => ({
    phase: 'ready', program: { version: '0.1.26', source: 'test' },
    configPath: join(ctx.profileContext.dir, 'config.toml'), error: null,
    configuration: { executable: false, configPath: true },
  }) });
  ctx.provide('grokSearchConnectionSecurity', {
    requireOwner() {}, requireSecret() {},
    capabilities: () => ({ secretsAllowed: true, transport: 'loopback', reason: null }),
  });
  const gateway = new SettingsGateway(ctx);
  const snapshot = await gateway.snapshot();
  const resultCodec = method => SETTINGS_DESCRIPTORS.find(row => row.method === method).result.create();
  assert.equal(resultCodec('snapshot').safeParse(snapshot).success, true);
  assert.equal(snapshot.control.available, true);
  const stopped = await gateway.stop();
  assert.equal(resultCodec('stop').safeParse(stopped).success, true);
  assert.equal(stopped.outcome.kind, 'released');
  assert.equal(stopped.snapshot.available, true);
  ctx.dispose();
  assert.equal(ctx.get('grokSearchControl').publicSnapshot().available, false);
}));

test('product recovery entry fails closed without a route receipt and preserves the required record', async () => {
  const ctx = makeContext();
  const store = createProductStore(ctx);
  const prior = createRequiredRecord(ctx, store, randomUUID());
  writeProfile(ctx, [PRODUCT_SEARCH_BUNDLE]);
  applyRecovery(ctx);
  const snapshot = await ctx.get('grokSearchRecovery').retry();
  assert.equal(snapshot.phase, 'wiring-incomplete');
  assert.equal(snapshot.error.code, 'CONTROL_RECOVERY_ROUTE_RECEIPT_REQUIRED');
  assert.equal(snapshot.outcome.recordCommitted, false);
  assert.deepEqual(store.read(), prior);
  ctx.dispose();
  assert.deepEqual(store.read(), prior);
});

test('product recovery entry can use an explicit host verifier without fabricating prior release evidence', async () => {
  const verifier = {
    verify: observation => ({ atAuthor: true, routeChanged: false, fetchPreserved: true, dependenciesPreserved: true,
      actualSearchProvider: observation.authorSearchProvider,
      originalSearchCalls: observation.counterBaseline,
      originalSearchBaseline: observation.counterBaseline, originalSearchDelta: 0 }),
  };
  const ctx = makeContext({ verifier, originalCalls: 0 });
  const store = createProductStore(ctx);
  const prior = createRequiredRecord(ctx, store, randomUUID());
  writeProfile(ctx, [PRODUCT_SEARCH_BUNDLE]);
  applyRecovery(ctx);
  const snapshot = await ctx.get('grokSearchRecovery').retry();
  // D-28 single-bundle build: the recovery entry ships in the search bundle, so a selected
  // bundle is still-selected. Correction stays a core capability, not a wiring path.
  assert.equal(snapshot.phase, 'still-selected');
  const after = store.read();
  assert.deepEqual(after, prior);
  ctx.dispose();
  assert.deepEqual(store.read(), after);
});

test('product recovery completes an incomplete explicit release and restores the author route', async () => {
  const verifier = {
    verify: observation => ({ atAuthor: true, routeChanged: observation.routeChanged === true,
      fetchPreserved: true, dependenciesPreserved: true, actualSearchProvider: observation.authorSearchProvider,
      originalSearchCalls: observation.counterBaseline,
      originalSearchBaseline: observation.counterBaseline, originalSearchDelta: 0 }),
  };
  const ctx = makeContext({ verifier, originalCalls: 0 });
  const store = createProductStore(ctx);
  const required = createRequiredRecord(ctx, store, randomUUID());
  const releaseOperationId = randomUUID();
  const releaseIntent = { ...required.intent, policy: 'released', reason: 'explicit-product-release',
    pause: { confirmed: true, reason: 'explicit-product-release', observedAt: '2026-10-22T00:00:00.000Z' },
    priorIntent: structuredClone(required.intent), release: { explicit: true,
      committedAt: '2026-10-22T00:00:00.000Z', kind: 'intent-release-commit',
      operationId: releaseOperationId, hostId: required.intent.lease.hostId, pid: required.intent.lease.pid,
      author: required.intent.acquisition.authorSearchProvider, routeChanged: false, routeVerified: false } };
  const released = store.compareAndSwap({ expectedRevision: required.revision, intent: releaseIntent });
  const web = ctx.get('web');
  web.searchProviderId = 'grok-search';
  ctx.loader.entries()[0].fiber.config.searchProvider = 'grok-search';
  applyRecovery(ctx);
  const state = await ctx.get('grokSearchRecovery').retry();
  assert.equal(state.phase, 'completed');
  assert.equal(state.outcome.completionCommitted, true);
  assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
  const after = store.read();
  assert.equal(after.revision, released.revision + 1);
  assert.deepEqual(after.intent.release, releaseIntent.release);
  assert.equal(after.intent.releaseCompletion.releaseOperationId, releaseOperationId);
  assert.equal(after.intent.recovery.action, 'explicit-release-recovery');
  assert.equal(after.intent.recovery.historicReleaseCommitted, true);
  ctx.dispose();
  assert.deepEqual(store.read(), after);
});

test('disposing recovery while its completion waits for storage cannot publish a stale receipt', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  applyRouteVerifier(ctx);
  const store = createProductStore(ctx);
  const required = createRequiredRecord(ctx, store, randomUUID());
  const released = store.compareAndSwap({ expectedRevision: required.revision, intent: {
    ...required.intent, policy: 'released', reason: 'interrupted-release',
    priorIntent: structuredClone(required.intent), release: {
      explicit: true, committedAt: '2026-11-15T00:00:00.000Z', kind: 'intent-release-commit',
      operationId: randomUUID(), hostId: required.intent.lease.hostId, counterBaseline: 0,
    },
  } });
  const waiting = deferred();
  const lock = acquireOwnedLock(join(store.directory, 'control-write.lock'));
  let recovery;
  try {
    applyRecovery(ctx, { store: {
      ...store,
      compareAndSwapAsync(request) {
        waiting.resolve();
        return store.compareAndSwapAsync(request);
      },
    } });
    recovery = ctx.get('grokSearchRecovery');
    const pending = recovery.retry();
    await waiting.promise;
    ctx.dispose();
    lock.release();
    await pending;
    assert.deepEqual(store.read(), released);
    assert.equal(recovery.snapshot().phase, 'disposed');
  } finally { lock.release(); ctx.dispose(); }
});

test('product recovery reports a completed explicit release without rewriting its record', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  applyRouteVerifier(ctx);
  const store = createProductStore(ctx);
  const required = createRequiredRecord(ctx, store, randomUUID());
  const releaseOperationId = randomUUID();
  const releaseIntent = { ...required.intent, policy: 'released', reason: 'completed-release',
    priorIntent: structuredClone(required.intent), release: { explicit: true,
      committedAt: '2026-10-26T00:00:00.000Z', kind: 'intent-release-commit',
      operationId: releaseOperationId, hostId: required.intent.lease.hostId, pid: required.intent.lease.pid,
      counterBaseline: 0, routeChanged: false, routeVerified: false } };
  const released = store.compareAndSwap({ expectedRevision: required.revision, intent: releaseIntent });
  const completion = {
    kind: 'explicit-release-completion', operationId: randomUUID(), releaseOperationId,
    completedAt: '2026-10-26T00:00:01.000Z', routeChanged: false, routeVerified: true,
    routeEvidence: { atAuthor: true, routeChanged: false, fetchPreserved: true, dependenciesPreserved: true,
      actualSearchProvider: required.intent.acquisition.authorSearchProvider,
      originalSearchCalls: 0, originalSearchBaseline: 0, originalSearchDelta: 0 },
    recordCommit: { kind: 'explicit-release-completion', operationId: randomUUID(),
      previousRevision: released.revision, nextRevision: released.revision + 1 },
  };
  const completed = store.compareAndSwap({ expectedRevision: released.revision,
    intent: { ...releaseIntent, releaseCompletion: completion } });
  applyRecovery(ctx);
  const state = await ctx.get('grokSearchRecovery').retry();
  // D-28: while the single bundle is still selected, recovery must report
  // still-selected and leave the completed release to the owner path.
  assert.equal(state.phase, 'still-selected');
  assert.deepEqual(store.read(), completed);
  assert.equal(store.read().intent.releaseCompletion.kind, 'explicit-release-completion');
  ctx.dispose();
});

test('public presentation polling sees an external recovery completion', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  const control = ctx.get('grokSearchControl');
  const store = createProductStore(ctx);
  const recorded = store.read();
  assert.equal(control.publicSnapshot().completionCommitted, false);
  assert.equal(control.publicSnapshot().revision, recorded.revision);
  const completion = {
    kind: 'explicit-release-completion', operationId: randomUUID(),
    releaseOperationId: randomUUID(), completedAt: '2026-10-30T00:00:00.000Z',
    routeChanged: false, routeVerified: true, routeEvidence: {}, recordCommit: {},
  };
  const released = store.compareAndSwap({ expectedRevision: recorded.revision, intent: {
    ...recorded.intent, policy: 'released', release: {
      explicit: true, committedAt: '2026-10-30T00:00:00.000Z',
      operationId: completion.releaseOperationId, routeChanged: false, routeVerified: false,
    },
  } });
  store.compareAndSwap({ expectedRevision: released.revision,
    intent: { ...released.intent, releaseCompletion: completion } });
  const presentation = control.publicSnapshot();
  assert.equal(presentation.phase, 'released');
  assert.equal(presentation.revision, recorded.revision + 2);
  assert.equal(presentation.releaseOperationId, completion.releaseOperationId);
  assert.equal(presentation.completionCommitted, true);
  assert.equal(presentation.routeVerified, true);
  assert.equal(presentation.canStop, false);
  assert.equal(control.snapshot().revision, recorded.revision + 2);
  ctx.dispose();
});

test('public display cache leaves control state and authoritative corruption checks intact', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  const control = ctx.get('grokSearchControl'), store = createProductStore(ctx);
  const recorded = store.read();
  const completion = {
    kind: 'explicit-release-completion', operationId: randomUUID(),
    releaseOperationId: randomUUID(), completedAt: '2026-10-30T00:00:00.000Z',
    routeChanged: false, routeVerified: true, routeEvidence: {}, recordCommit: {},
  };
  const completed = store.compareAndSwap({ expectedRevision: recorded.revision, intent: {
    ...recorded.intent, policy: 'released', release: {
      explicit: true, committedAt: '2026-10-30T00:00:00.000Z', operationId: completion.releaseOperationId,
    }, releaseCompletion: completion,
  } });
  assert.equal(control.publicSnapshot().completionCommitted, true);
  writeFileSync(join(store.directory, 'v000000000001.json'), '{ damaged old revision\n');
  // The lightweight display can retain a previous view, but never installs it
  // into the control state or substitutes it for a full read during retry.
  assert.equal(control.publicSnapshot().completionCommitted, true);
  assert.equal(control.snapshot().phase, 'required');
  assert.equal(control.snapshot().revision, recorded.revision);
  await assert.rejects(control.retry(), error => error.code === 'CONTROL_RECORD_INVALID');
  assert.throws(() => store.read(), error => error.code === 'CONTROL_RECORD_INVALID');
  writeFileSync(join(store.directory, `v${String(completed.revision).padStart(12, '0')}.json`), '{ damaged latest\n');
  assert.doesNotThrow(() => control.publicSnapshot());
  assert.equal(control.publicSnapshot().error.code, 'CONTROL_RECORD_INVALID');
  assert.equal(control.publicSnapshot().completionCommitted, false);
  ctx.dispose();
});

test('profile cleanup covers absent records, object tokens and every outstanding operation', async () => {
  const ctx = makeContext(), other = makeContext();
  const store = createProductStore(ctx, { deferMaintenance: true }), otherStore = createProductStore(other, { deferMaintenance: true });
  const first = deferred(), last = deferred(), idle = deferred(), token = {}, operationId = randomUUID();
  let notifications = 0, cancelled = 0;
  assert.equal(existsSync(store.directory), false);
  assert.equal(productRuntimeCleanupInFlight(store), false);
  holdProductRelease(store, token, first.promise);
  holdProductRelease(store, operationId, last.promise);
  const unsubscribe = onProductRuntimeCleanupIdle(store, () => { notifications++; idle.resolve(); });
  const cancel = onProductRuntimeCleanupIdle(store, () => { cancelled++; });
  cancel();
  try {
    assert.equal(existsSync(store.directory), false, 'runtime tracking never creates records');
    assert.equal(productRuntimeCleanupInFlight(otherStore), false);
    assert.equal(productRuntimeCleanupInFlight(store), true);
    createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
    assert.equal(productRuntimeCleanupInFlight(createProductStore(ctx, { deferMaintenance: true })), true);
    first.resolve(); await first.promise; await nextImmediate();
    assert.equal(productReleaseInFlight(store, token), false);
    assert.equal(productReleaseInFlight(store, operationId), true);
    assert.equal(productRuntimeCleanupInFlight(store), true);
    assert.equal(notifications, 0);
    last.resolve(); await last.promise;
    assert.equal(notifications, 0, 'profile notifications are never synchronous with settlement');
    await waitForNotification(idle.promise);
    assert.equal(productRuntimeCleanupInFlight(store), false);
    assert.equal(notifications, 1);
    assert.equal(cancelled, 0);
    unsubscribe();
    const next = deferred();
    holdProductRelease(store, {}, next.promise);
    next.resolve(); await next.promise; await nextImmediate();
    assert.equal(notifications, 1, 'unsubscribed idle listeners are not retained for future operations');
  } finally {
    unsubscribe(); cancel(); first.resolve(); last.resolve();
    await Promise.all([first.promise, last.promise]); ctx.dispose(); other.dispose();
  }
});

test('profile cleanup notifications survive aliases and module replacement without awaiting listeners', async () => {
  const ctx = makeContext(), store = createProductStore(ctx, { deferMaintenance: true });
  createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
  const alias = join(ctx.profileContext.dir, 'runtime-cleanup-alias');
  const task = deferred(), resources = deferred(), listenerWork = deferred(), idle = deferred(), token = {};
  let unsubscribe;
  try {
    symlinkSync(store.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasStore = { ...store, directory: alias };
    holdProductRelease(store, token, task.promise, { whenDrained: resources.promise });
    const fresh = await import(new URL(`../src/core/product-control.mjs?cleanup-test=${randomUUID()}`, import.meta.url));
    assert.equal(fresh.productRuntimeCleanupInFlight(aliasStore), true);
    unsubscribe = fresh.onProductRuntimeCleanupIdle(aliasStore, () => { idle.resolve(); return listenerWork.promise; });
    task.resolve(); await task.promise; await nextImmediate();
    assert.equal(fresh.productRuntimeCleanupInFlight(aliasStore), true);
    resources.resolve(); await waitForNotification(idle.promise);
    assert.equal(productRuntimeCleanupInFlight(store), false);
    assert.equal(fresh.productRuntimeCleanupInFlight(aliasStore), false);
    await waitForRuntimeCleanup(store);
  } finally {
    unsubscribe?.(); task.resolve(); resources.resolve(); listenerWork.resolve();
    await Promise.all([task.promise, resources.promise, listenerWork.promise]);
    if (existsSync(alias)) {
      assert.equal(realpathSync.native(alias), realpathSync.native(store.directory)); unlinkSync(alias);
    }
    ctx.dispose();
  }
});

test('a queued profile idle notification cannot bypass a newly registered cleanup', async () => {
  const ctx = makeContext(), store = createProductStore(ctx, { deferMaintenance: true });
  const first = deferred(), replacement = deferred(), idle = deferred();
  let notifications = 0;
  holdProductRelease(store, {}, first.promise);
  const unsubscribe = onProductRuntimeCleanupIdle(store, () => { notifications++; idle.resolve(); });
  try {
    first.resolve(); await first.promise;
    holdProductRelease(store, {}, replacement.promise);
    await nextImmediate();
    assert.equal(notifications, 0);
    assert.equal(productRuntimeCleanupInFlight(store), true);
    replacement.resolve(); await waitForNotification(idle.promise);
    assert.equal(notifications, 1);
    assert.equal(productRuntimeCleanupInFlight(store), false);
  } finally {
    unsubscribe(); first.resolve(); replacement.resolve();
    await Promise.all([first.promise, replacement.promise]); ctx.dispose();
  }
});

test('release task sets stay busy until both owners settle in either order', async t => {
  for (const first of ['A', 'B']) await t.test(`${first} settles first`, async () => {
    const ctx = makeContext(), store = createProductStore(ctx), operationId = randomUUID();
    createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
    const tasks = { A: deferred(), B: deferred() }, idle = deferred();
    let notifications = 0;
    holdProductRelease(store, operationId, tasks.A.promise);
    assert.equal(holdProductRelease(store, operationId, tasks.A.promise), tasks.A.promise);
    assert.equal(holdProductRelease(store, operationId, tasks.B.promise), tasks.B.promise);
    const unsubscribe = onProductReleaseIdle(store, operationId, () => { notifications++; idle.resolve(); });
    try {
      tasks[first].resolve();
      await tasks[first].promise;
      await nextImmediate();
      assert.equal(productReleaseInFlight(store, operationId), true);
      assert.equal(notifications, 0);
      const last = first === 'A' ? 'B' : 'A';
      tasks[last].resolve();
      await waitForNotification(idle.promise);
      assert.equal(productReleaseInFlight(store, operationId), false);
      await nextImmediate();
      assert.equal(notifications, 1);
    } finally {
      unsubscribe();
      tasks.A.resolve(); tasks.B.resolve();
      await Promise.all([tasks.A.promise, tasks.B.promise]);
      ctx.dispose();
    }
  });
});

test('an idle notification queued for a retired task cannot bypass its replacement', async () => {
  const ctx = makeContext(), store = createProductStore(ctx), operationId = randomUUID();
  createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
  const first = deferred(), replacement = deferred(), idle = deferred();
  let notifications = 0;
  holdProductRelease(store, operationId, first.promise);
  const unsubscribe = onProductReleaseIdle(store, operationId, () => { notifications++; idle.resolve(); });
  try {
    first.resolve();
    await first.promise;
    holdProductRelease(store, operationId, replacement.promise);
    await nextImmediate();
    assert.equal(productReleaseInFlight(store, operationId), true);
    assert.equal(notifications, 0);
    replacement.resolve();
    await waitForNotification(idle.promise);
    assert.equal(productReleaseInFlight(store, operationId), false);
    assert.equal(notifications, 1);
  } finally {
    unsubscribe();
    first.resolve(); replacement.resolve();
    await Promise.all([first.promise, replacement.promise]);
    ctx.dispose();
  }
});

test('release tracker identity follows a physical directory alias', async () => {
  const ctx = makeContext(), store = createProductStore(ctx), operationId = randomUUID();
  createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
  const alias = join(ctx.profileContext.dir, 'release-records-alias'), release = deferred(), idle = deferred();
  let unsubscribe;
  try {
    symlinkSync(store.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(realpathSync.native(alias), realpathSync.native(store.directory));
    const aliasStore = { ...store, directory: alias };
    holdProductRelease(aliasStore, operationId, release.promise);
    unsubscribe = onProductReleaseIdle(store, operationId, idle.resolve);
    assert.equal(productReleaseInFlight(store, operationId), true);
    assert.equal(productReleaseInFlight(aliasStore, operationId), true);
    release.resolve();
    await waitForNotification(idle.promise);
    assert.equal(productReleaseInFlight(store, operationId), false);
    assert.equal(productReleaseInFlight(aliasStore, operationId), false);
  } finally {
    unsubscribe?.();
    release.resolve(); await release.promise;
    try {
      if (existsSync(alias)) {
        assert.equal(realpathSync.native(alias), realpathSync.native(store.directory));
        unlinkSync(alias);
      }
    } finally { ctx.dispose(); }
  }
});

test('release tracker shares Windows case aliases only when the filesystem does',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = makeContext(), store = createProductStore(ctx), operationId = randomUUID();
    createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
    const directory = join(ctx.profileContext.dir, 'CONTROL-INTENT.RECORDS'), release = deferred(), idle = deferred();
    let unsubscribe;
    try {
      if (!existsSync(directory) || realpathSync.native(directory) !== realpathSync.native(store.directory)) {
        t.skip('This profile directory is case-sensitive.');
        return;
      }
      const caseStore = { ...store, directory };
      assert.notEqual(caseStore.directory, store.directory);
      holdProductRelease(store, operationId, release.promise);
      unsubscribe = onProductReleaseIdle(caseStore, operationId, idle.resolve);
      assert.equal(productReleaseInFlight(caseStore, operationId), true);
      release.resolve();
      await waitForNotification(idle.promise);
      assert.equal(productReleaseInFlight(caseStore, operationId), false);
      assert.equal(productReleaseInFlight(store, operationId), false);
    } finally { unsubscribe?.(); release.resolve(); await release.promise; ctx.dispose(); }
  });

test('a fresh product-control module shares outstanding release tasks and idle listeners', async () => {
  const ctx = makeContext(), store = createProductStore(ctx), operationId = randomUUID();
  createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
  const oldTask = deferred(), newTask = deferred(), idle = deferred();
  holdProductRelease(store, operationId, oldTask.promise);
  let unsubscribe;
  try {
    const fresh = await import(new URL(`../src/core/product-control.mjs?release-test=${randomUUID()}`, import.meta.url));
    assert.notEqual(fresh.holdProductRelease, holdProductRelease);
    assert.equal(fresh.productReleaseInFlight(store, operationId), true);
    assert.equal(fresh.holdProductRelease(store, operationId, newTask.promise), newTask.promise);
    unsubscribe = fresh.onProductReleaseIdle(store, operationId, idle.resolve);
    newTask.resolve();
    await newTask.promise;
    await nextImmediate();
    assert.equal(productReleaseInFlight(store, operationId), true);
    assert.equal(fresh.productReleaseInFlight(store, operationId), true);
    oldTask.resolve();
    await waitForNotification(idle.promise);
    assert.equal(productReleaseInFlight(store, operationId), false);
    assert.equal(fresh.productReleaseInFlight(store, operationId), false);
  } finally {
    unsubscribe?.();
    oldTask.resolve(); newTask.resolve();
    await Promise.all([oldTask.promise, newTask.promise]);
    ctx.dispose();
  }
});

test('idle listeners run passively and unsubscribe without joining release cleanup', async () => {
  const ctx = makeContext(), store = createProductStore(ctx), operationId = randomUUID();
  createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
  const release = deferred(), listenerWork = deferred(), idle = deferred(), lateIdle = deferred();
  let notifications = 0, cancelledCalls = 0, lateCalls = 0, listenerFinished = false;
  listenerWork.promise.then(() => { listenerFinished = true; });
  holdProductRelease(store, operationId, release.promise);
  const unsubscribe = onProductReleaseIdle(store, operationId, () => {
    notifications++; idle.resolve(); return listenerWork.promise;
  });
  const cancel = onProductReleaseIdle(store, operationId, () => { cancelledCalls++; });
  const removeThrowing = onProductReleaseIdle(store, operationId, () => { throw new Error('listener failed'); });
  const removeRejecting = onProductReleaseIdle(store, operationId, () => Promise.reject(new Error('listener rejected')));
  let removeLate;
  try {
    cancel();
    release.resolve();
    await release.promise;
    assert.equal(notifications, 0, 'idle notification must not run inside release settlement');
    await waitForNotification(idle.promise);
    assert.equal(productReleaseInFlight(store, operationId), false);
    assert.equal(listenerFinished, false);
    assert.equal(cancelledCalls, 0);
    unsubscribe(); removeThrowing(); removeRejecting();
    removeLate = onProductReleaseIdle(store, operationId, () => { lateCalls++; lateIdle.resolve(); });
    assert.equal(lateCalls, 0, 'subscribing to an idle operation is still asynchronous');
    await waitForNotification(lateIdle.promise);
    assert.equal(lateCalls, 1, 'unfinished listener work cannot block later idle observers');
    assert.equal(listenerFinished, false);
    assert.equal(notifications, 1);
  } finally {
    unsubscribe(); cancel(); removeThrowing(); removeRejecting(); removeLate?.();
    release.resolve(); listenerWork.resolve();
    await Promise.all([release.promise, listenerWork.promise]);
    ctx.dispose();
  }
});

test('a rejected release stays registered until its independent resource proof settles in either order', async t => {
  for (const first of ['release', 'resources']) await t.test(`${first} settles first`, async () => {
    const ctx = makeContext(), store = createProductStore(ctx), operationId = randomUUID();
    createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
    const release = deferred(), resources = deferred(), idle = deferred();
    const failure = Object.assign(new Error('release deadline elapsed'), { code: 'CONTROL_RELEASE_DRAIN_TIMEOUT' });
    let notifications = 0;
    assert.equal(holdProductRelease(store, operationId, release.promise, { whenDrained: resources.promise }), release.promise);
    const rejected = assert.rejects(release.promise, error => error === failure);
    const unsubscribe = onProductReleaseIdle(store, operationId, () => { notifications++; idle.resolve(); });
    try {
      if (first === 'release') { release.reject(failure); await rejected; }
      else { resources.resolve(); await resources.promise; }
      await nextImmediate();
      assert.equal(productReleaseInFlight(store, operationId), true);
      assert.equal(notifications, 0);
      if (first === 'release') resources.resolve();
      else release.reject(failure);
      await rejected;
      await waitForNotification(idle.promise);
      assert.equal(productReleaseInFlight(store, operationId), false);
      assert.equal(notifications, 1);
    } finally {
      unsubscribe();
      release.reject(failure); resources.resolve();
      await Promise.all([rejected, resources.promise]);
      ctx.dispose();
    }
  });
});

test('a cleanup error with pending exit proof remains busy until actual exit', async () => {
  const ctx = makeContext(), store = createProductStore(ctx), operationId = randomUUID();
  createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
  const release = deferred(), resources = deferred(), exit = deferred(), idle = deferred();
  const failure = Object.assign(new Error('process has not exited'), { code: 'GROK_PROCESS_REAP_FAILED', whenExited: exit.promise });
  let notifications = 0;
  holdProductRelease(store, operationId, release.promise, { whenDrained: resources.promise });
  const unsubscribe = onProductReleaseIdle(store, operationId, () => { notifications++; idle.resolve(); });
  try {
    release.resolve({ kind: 'incomplete' });
    resources.reject(failure);
    await nextImmediate();
    assert.equal(productReleaseInFlight(store, operationId), true);
    assert.equal(notifications, 0);
    exit.resolve();
    await waitForNotification(idle.promise);
    assert.equal(productReleaseInFlight(store, operationId), false);
    assert.equal(notifications, 1);
  } finally {
    unsubscribe();
    release.resolve(); resources.resolve(); exit.resolve();
    await Promise.allSettled([release.promise, resources.promise, exit.promise]);
    ctx.dispose();
  }
});

test('unproven cleanup failures stay registered without an idle notification', async t => {
  for (const kind of ['GROK_PROGRAM_REAP_FAILED', 'GROK_PROCESS_REAP_FAILED', 'unknown-cleanup', 'failed-exit-proof']) {
    await t.test(kind, async () => {
      const ctx = makeContext(), store = createProductStore(ctx), operationId = randomUUID();
      createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
      const resources = deferred(), exit = deferred();
      const failure = Object.assign(new Error('cleanup has no successful exit proof'),
        { code: kind === 'failed-exit-proof' ? 'GROK_PROCESS_REAP_FAILED' : kind });
      if (kind === 'failed-exit-proof') failure.whenExited = exit.promise;
      let notifications = 0;
      holdProductRelease(store, operationId, Promise.resolve({ kind: 'incomplete' }), { whenDrained: resources.promise });
      const unsubscribe = onProductReleaseIdle(store, operationId, () => { notifications++; });
      try {
        resources.reject(failure);
        await nextImmediate();
        if (kind === 'failed-exit-proof') exit.reject(new Error('exit observation failed'));
        await nextImmediate();
        assert.equal(productReleaseInFlight(store, operationId), true, 'cleanup rejection is not proof of resource exit');
        assert.equal(notifications, 0);
      } finally {
        unsubscribe();
        resources.resolve(); exit.resolve();
        await Promise.allSettled([resources.promise, exit.promise]);
        ctx.dispose();
      }
    });
  }
});

// Service absence during teardown does not mean the release task has finished.
test('product recovery waits for the current release task and completes it after the absent owner finishes', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  applyRouteVerifier(ctx);
  const verifier = ctx.get('grokSearchRouteVerifier');
  let verifyCalls = 0;
  ctx.provide('grokSearchRouteVerifier', { ...verifier,
    verify: observation => {
      verifyCalls += 1;
      return verifier.verify(observation);
    },
  });
  const store = createProductStore(ctx);
  const { required, released } = createInterruptedReleaseRecord(ctx, store);
  const operationId = released.intent.release.operationId, pending = deferred(), completedNotice = deferred(), callbackWork = deferred();
  assert.equal(holdProductRelease(store, operationId, pending.promise), pending.promise);
  const entry = ctx.loader.entries()[0];
  const author = structuredClone(entry.options.config), inject = structuredClone(entry.options.inject);
  entry.fiber.config.searchProvider = 'grok-search';
  ctx.get('web').searchProviderId = 'grok-search';
  const owner = { publicSnapshot: () => ({ phase: 'stopping' }) };
  ctx.provide('grokSearchControl', owner);
  let completed;
  try {
    applyRecovery(ctx, { onSettled: state => {
      if (state.phase === 'completed') completedNotice.resolve(state);
      return callbackWork.promise;
    } });
    const recovery = ctx.get('grokSearchRecovery');
    assert.equal((await recovery.retry()).phase, 'owner-present');
    ctx.provide('grokSearchControl', undefined);
    const waiting = await recovery.retry();
    assert.equal(waiting.phase, 'owner-present');
    assert.equal(waiting.outcome.recordCommitted, false);
    assert.equal(productReleaseInFlight(createProductStore(ctx), operationId), true);
    assert.equal(verifyCalls, 0);
    assert.deepEqual(store.read(), released);
    assert.equal(ctx.get('web').searchProviderId, 'grok-search');
    assert.deepEqual(entry.options.config, author);
    assert.deepEqual(entry.options.inject, inject);

    pending.resolve({ kind: 'incomplete' });
    await pending.promise;
    assert.equal(ctx.get('grokSearchControl'), undefined);
    const recovered = await waitForNotification(completedNotice.promise);
    assert.equal(recovered.phase, 'completed');
    assert.equal(recovered.outcome.completionCommitted, true);
    assert.equal(productReleaseInFlight(store, operationId), false);
    assert.equal(verifyCalls, 1);
    completed = store.read();
    assert.equal(completed.revision, released.revision + 1);
    assert.deepEqual(completed.intent.release, released.intent.release);
    assert.deepEqual(completed.intent.priorIntent, required.intent);
    assert.equal(completed.intent.recovery.action, 'explicit-release-recovery');
    assert.equal(completed.intent.recovery.observerHostId, PRODUCT_HOST_ID);
    assert.equal(completed.intent.releaseCompletion.releaseOperationId, operationId);
    assert.equal(completed.intent.releaseCompletion.routeEvidence.originalSearchDelta, 0);
    assert.equal(completed.intent.releaseCompletion.routeEvidence.actualSearchProvider, author.searchProvider);
    assert.equal(ctx.get('web').searchProviderId, author.searchProvider);
    assert.equal(ctx.get('web').fetchProviderId, author.fetchProvider);
    assert.deepEqual(entry.options.config, author);
    assert.deepEqual(entry.options.inject, inject);
  } finally { pending.resolve(); await pending.promise; ctx.dispose(); callbackWork.resolve(); await callbackWork.promise; }
  assert.deepEqual(store.read(), completed);
});

test('recovery settles automatically only after the failed release and late resources are quiescent', async () => {
  const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx);
  const { released } = createInterruptedReleaseRecord(ctx, store), operationId = released.intent.release.operationId;
  const release = deferred(), resources = deferred(), completion = deferred();
  const failure = Object.assign(new Error('native release timed out'), { code: 'CONTROL_RELEASE_DRAIN_TIMEOUT' });
  applyRouteVerifier(ctx);
  const verifier = ctx.get('grokSearchRouteVerifier');
  let verifyCalls = 0;
  ctx.provide('grokSearchRouteVerifier', { ...verifier, verify: observation => {
    verifyCalls++; return verifier.verify(observation);
  } });
  holdProductRelease(store, operationId, release.promise, { whenDrained: resources.promise });
  const rejected = assert.rejects(release.promise, error => error === failure);
  try {
    applyRecovery(ctx, { onSettled: state => { if (state.phase === 'completed') completion.resolve(state); } });
    const recovery = ctx.get('grokSearchRecovery');
    assert.equal((await recovery.retry()).phase, 'owner-present');
    release.reject(failure);
    await rejected;
    await nextImmediate();
    assert.equal(productReleaseInFlight(store, operationId), true);
    assert.equal(recovery.snapshot().phase, 'owner-present');
    assert.equal(verifyCalls, 0);
    assert.deepEqual(store.read(), released);
    resources.resolve();
    const recovered = await waitForNotification(completion.promise);
    assert.equal(recovered.outcome.completionCommitted, true);
    assert.equal(productReleaseInFlight(store, operationId), false);
    assert.equal(verifyCalls, 1);
    assert.equal(store.read().revision, released.revision + 1);
    assert.equal(store.read().intent.releaseCompletion.releaseOperationId, operationId);
  } finally {
    ctx.dispose();
    release.reject(failure); resources.resolve();
    await Promise.all([rejected, resources.promise]);
  }
});

test('disposing recovery before task or queued idle settlement prevents callbacks and publication', async t => {
  for (const moment of ['before-idle', 'idle-queued']) await t.test(moment, async () => {
    const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx);
    const { released } = createInterruptedReleaseRecord(ctx, store), operationId = released.intent.release.operationId;
    const release = deferred(), idle = deferred();
    applyRouteVerifier(ctx);
    const verifier = ctx.get('grokSearchRouteVerifier');
    let verifyCalls = 0, callbacks = 0, writes = 0, unsubscribe;
    ctx.provide('grokSearchRouteVerifier', { ...verifier, verify: observation => {
      verifyCalls++; return verifier.verify(observation);
    } });
    const observedStore = { ...store, compareAndSwapAsync(request) {
      writes++; return store.compareAndSwapAsync(request);
    } };
    holdProductRelease(store, operationId, release.promise);
    try {
      applyRecovery(ctx, { store: observedStore, onSettled: () => { callbacks++; } });
      const recovery = ctx.get('grokSearchRecovery');
      assert.equal((await recovery.retry()).phase, 'owner-present');
      const beforeCallbacks = callbacks;
      unsubscribe = onProductReleaseIdle(store, operationId, () => {
        // Recovery queued its rerun first; disposal must cancel that queued work.
        if (moment === 'idle-queued') ctx.dispose();
        idle.resolve();
      });
      if (moment === 'before-idle') ctx.dispose();
      release.resolve();
      await waitForNotification(idle.promise);
      await nextImmediate();
      await nextImmediate();
      assert.equal(productReleaseInFlight(store, operationId), false);
      assert.equal(recovery.snapshot().phase, 'disposed');
      assert.equal(callbacks, beforeCallbacks);
      assert.equal(verifyCalls, 0);
      assert.equal(writes, 0);
      assert.deepEqual(store.read(), released);
    } finally { unsubscribe?.(); ctx.dispose(); release.resolve(); await release.promise; }
  });
});

test('passive recovery of an explicit settings stop does not reactivate its live control owner', async () => {
  const ctx = makeContext({ originalCalls: 0 }), firstVerification = deferred(), finishRelease = deferred(), completion = deferred();
  applyRouteVerifier(ctx);
  const verifier = ctx.get('grokSearchRouteVerifier');
  const failure = Object.assign(new Error('native verifier interrupted'), { code: 'TEST_INTERRUPTED_VERIFIER' });
  let verifyCalls = 0, starts = 0, pending;
  ctx.provide('grokSearchRouteVerifier', { ...verifier, verify: async observation => {
    verifyCalls++;
    if (verifyCalls === 1) { firstVerification.resolve(); await finishRelease.promise; throw failure; }
    return verifier.verify(observation);
  } });
  const store = createProductStore(ctx);
  try {
    await applyControl(ctx, { store, onStart: () => { starts++; } });
    const control = ctx.get('grokSearchControl');
    pending = control.stop('settings-ui-explicit-stop');
    await firstVerification.promise;
    const released = store.read(), operationId = released.intent.release.operationId;
    assert.equal(released.intent.reason, 'settings-ui-explicit-stop');
    assert.equal(released.intent.releaseCompletion, undefined);
    applyRecovery(ctx, { onSettled: state => { if (state.phase === 'completed') completion.resolve(state); } });
    assert.equal((await ctx.get('grokSearchRecovery').retry()).phase, 'owner-present');
    finishRelease.resolve();
    const result = await pending;
    assert.equal(result.kind, 'incomplete');
    const recovered = await waitForNotification(completion.promise);
    assert.equal(recovered.outcome.completionCommitted, true);
    await nextImmediate();
    const completed = store.read();
    assert.equal(completed.revision, released.revision + 1);
    assert.equal(completed.intent.releaseCompletion.releaseOperationId, operationId);
    assert.equal(completed.intent.reason, 'settings-ui-explicit-stop');
    assert.equal(ctx.get('grokSearchControl'), control);
    assert.equal(control.publicSnapshot().phase, 'released');
    assert.equal(control.publicSnapshot().available, true);
    assert.equal(productReleaseInFlight(store, operationId), false);
    assert.equal(verifyCalls, 2);
    assert.equal(starts, 0);
    assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
    assert.equal(ctx.get('web').fetchProviderId, 'candidate-fetch');
    assert.deepEqual(store.read(), completed);
  } finally { finishRelease.resolve(); await pending?.catch(() => {}); ctx.dispose(); }
});

test('recovery waits for every cleanup in its profile while other profiles remain independent', async () => {
  const first = makeContext({ originalCalls: 0 }), other = makeContext({ originalCalls: 0 });
  const store = createProductStore(first), otherStore = createProductStore(other);
  const operationId = randomUUID(), unrelatedOperationId = randomUUID();
  const firstPending = deferred(), unrelatedPending = deferred(), otherCompleted = deferred();
  applyRouteVerifier(first);
  applyRouteVerifier(other);
  const { released } = createInterruptedReleaseRecord(first, store, operationId);
  const { released: otherReleased } = createInterruptedReleaseRecord(other, otherStore, operationId);
  holdProductRelease(store, operationId, firstPending.promise);
  holdProductRelease(otherStore, unrelatedOperationId, unrelatedPending.promise);
  try {
    assert.notEqual(store.directory, otherStore.directory);
    assert.equal(productReleaseInFlight(store, operationId), true);
    assert.equal(productReleaseInFlight(store, unrelatedOperationId), false);
    assert.equal(productReleaseInFlight(otherStore, operationId), false);
    assert.equal(productReleaseInFlight(otherStore, unrelatedOperationId), true);
    applyRecovery(first);
    applyRecovery(other, { onSettled: state => { if (state.phase === 'completed') otherCompleted.resolve(state); } });
    assert.equal((await first.get('grokSearchRecovery').retry()).phase, 'owner-present');
    assert.equal((await other.get('grokSearchRecovery').retry()).phase, 'owner-present');
    assert.deepEqual(otherStore.read(), otherReleased, 'an unrelated operation in this profile still owns live cleanup');
    assert.deepEqual(store.read(), released);
    unrelatedPending.resolve();
    const recovered = await waitForNotification(otherCompleted.promise);
    assert.equal(recovered.phase, 'completed');
    assert.equal(recovered.outcome.completionCommitted, true);
    const completed = otherStore.read();
    assert.equal(completed.revision, otherReleased.revision + 1);
    assert.equal(completed.intent.releaseCompletion.releaseOperationId, operationId);
    assert.equal(productReleaseInFlight(otherStore, unrelatedOperationId), false);
    assert.equal(productRuntimeCleanupInFlight(otherStore), false);
    assert.equal(productReleaseInFlight(store, operationId), true);
    assert.equal((await first.get('grokSearchRecovery').retry()).phase, 'owner-present');
    assert.deepEqual(store.read(), released);
  } finally {
    firstPending.resolve();
    unrelatedPending.resolve();
    await Promise.all([firstPending.promise, unrelatedPending.promise]);
    first.dispose();
    other.dispose();
  }
});

test('recovery CAS refuses newly started cleanup and resumes passively only after actual exit', async t => {
  for (const kind of ['owner-retry', 'other-operation']) await t.test(kind, async () => {
    const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
    const waiting = deferred(), exited = deferred(), completedNotice = deferred();
    const cleanupError = Object.assign(new Error('program exit not observed'), {
      code: 'GROK_PROGRAM_REAP_FAILED', whenExited: exited.promise,
    });
    let failVerification = true, failCancellation = false, verifyCalls = 0, lock, checking, stopping;
    applyRouteVerifier(ctx);
    const verifier = ctx.get('grokSearchRouteVerifier');
    ctx.provide('grokSearchRouteVerifier', { ...verifier, verify: observation => {
      verifyCalls++;
      if (failVerification) throw new Error('original release verification interrupted');
      return verifier.verify(observation);
    } });
    try {
      await applyControl(ctx, { store, onStop: () => failCancellation ? Promise.reject(cleanupError) : Promise.resolve() });
      const owner = ctx.get('grokSearchControl');
      assert.equal((await owner.stop('native-bundle-disable')).completionCommitted, false);
      await waitForRuntimeCleanup(store);
      const released = store.read(), operationId = released.intent.release.operationId;
      const recordPath = join(store.directory, `v${String(released.revision).padStart(12, '0')}.json`);
      const originalBytes = readFileSync(recordPath);
      failVerification = false;
      lock = acquireOwnedLock(join(store.directory, 'control-write.lock'));
      applyRecovery(ctx, { store: { ...store, compareAndSwapAsync(request) {
        waiting.resolve();
        return store.compareAndSwapAsync(request);
      } }, onSettled: state => { if (state.phase === 'completed') completedNotice.resolve(state); } });
      const recovery = ctx.get('grokSearchRecovery');
      checking = recovery.retry();
      const blocked = assert.rejects(checking, { code: 'CONTROL_RUNTIME_CLEANUP_PENDING' });
      await waitForNotification(waiting.promise);
      assert.equal(verifyCalls, 2, 'recovery reached its writer after route verification');
      if (kind === 'owner-retry') {
        failCancellation = true;
        stopping = owner.stop('native-bundle-disable');
        await assert.rejects(stopping, error => error.code === 'CONTROL_RELEASE_IN_FLIGHT' && error.cause === cleanupError);
        assert.equal(productReleaseInFlight(store, operationId), true);
      } else {
        holdProductRelease(store, {}, Promise.resolve({ kind: 'incomplete' }), { whenDrained: Promise.reject(cleanupError) });
        assert.equal(productReleaseInFlight(store, operationId), false);
      }
      assert.equal(productRuntimeCleanupInFlight(store), true);
      lock.release();
      await blocked;
      assert.equal(recovery.snapshot().error.code, 'CONTROL_RUNTIME_CLEANUP_PENDING');
      assert.equal(recovery.snapshot().outcome.completionCommitted, false);
      assert.deepEqual(store.read(), released, 'new cleanup must invalidate the pending completion CAS');
      assert.equal(owner.publicSnapshot().completionCommitted, false);
      await nextImmediate();
      assert.equal(productRuntimeCleanupInFlight(store), true);
      assert.equal(verifyCalls, 2, 'failed cleanup is not an idle notification');
      assert.equal(store.read().intent.releaseCompletion, undefined);
      exited.resolve();
      const completed = await waitForNotification(completedNotice.promise);
      assert.equal(completed.outcome.completionCommitted, true);
      assert.equal(productRuntimeCleanupInFlight(store), false);
      assert.equal(verifyCalls, 3, 'idle notification reruns real verification without a manual retry');
      const record = store.read();
      assert.equal(record.revision, released.revision + 1);
      assert.deepEqual(record.intent.release, released.intent.release);
      assert.deepEqual(record.intent.priorIntent, released.intent.priorIntent);
      assert.equal(record.intent.releaseCompletion.releaseOperationId, operationId);
      assert.equal(record.intent.releaseCompletion.routeEvidence.originalSearchDelta, 0);
      assert.deepEqual(readFileSync(recordPath), originalBytes);
      assert.equal(owner.publicSnapshot().phase, 'released');
      assert.equal(ctx.get('web').searchProviderId, 'candidate-original');
      assert.equal(ctx.get('web').fetchProviderId, 'candidate-fetch');
    } finally {
      lock?.release(); exited.resolve();
      await Promise.allSettled([checking, stopping]); ctx.dispose();
    }
  });
});

test('product recovery leaves a genuinely running control release to its owner', async () => {
  const ctx = makeContext({ originalCalls: 0 }), verifying = deferred(), finishVerification = deferred();
  applyRouteVerifier(ctx);
  const verifier = ctx.get('grokSearchRouteVerifier');
  const idle = deferred(), settledNotice = deferred();
  let verifyCalls = 0, pending, unsubscribe;
  ctx.provide('grokSearchRouteVerifier', { ...verifier, verify: async observation => {
    verifyCalls += 1;
    verifying.resolve();
    await finishVerification.promise;
    return verifier.verify(observation);
  } });
  const store = createProductStore(ctx);
  try {
    await applyControl(ctx, { store });
    const owner = ctx.get('grokSearchControl');
    pending = owner.stop('native-bundle-disable');
    await verifying.promise;
    const released = store.read(), operationId = released.intent.release.operationId;
    assert.equal(released.intent.policy, 'released');
    assert.equal(released.intent.releaseCompletion, undefined);
    assert.equal(productReleaseInFlight(createProductStore(ctx), operationId), true);
    unsubscribe = onProductReleaseIdle(store, operationId, idle.resolve);
    applyRecovery(ctx, { onSettled: state => { if (state.phase === 'still-selected') settledNotice.resolve(state); } });
    const recovery = ctx.get('grokSearchRecovery'), waiting = await recovery.retry();
    assert.equal(ctx.get('grokSearchControl'), owner);
    assert.equal(waiting.phase, 'owner-present');
    assert.equal(waiting.outcome.recordCommitted, false);
    assert.equal(verifyCalls, 1);
    assert.deepEqual(store.read(), released);
    finishVerification.resolve();
    const result = await pending;
    assert.equal(result.kind, 'released');
    assert.equal(result.completionCommitted, true);
    await waitForNotification(idle.promise);
    assert.equal(productReleaseInFlight(store, operationId), false);
    const completed = store.read();
    assert.equal(completed.intent.releaseCompletion.releaseOperationId, operationId);
    assert.equal(completed.intent.releaseCompletion.routeEvidence.originalSearchDelta, 0);
    assert.equal(completed.intent.recovery, undefined);
    assert.equal((await waitForNotification(settledNotice.promise)).phase, 'still-selected');
    assert.equal(verifyCalls, 1);
    assert.deepEqual(store.read(), completed);
  } finally {
    unsubscribe?.();
    finishVerification.resolve();
    await pending?.catch(() => {});
    ctx.dispose();
  }
});

test('product route verifier prefers a host counter and rejects malformed evidence', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  applyRouteVerifier(ctx);
  const verifier = ctx.get('grokSearchRouteVerifier');
  assert.ok(verifier);
  const receipt = await verifier.verify({ authorSearchProvider: 'candidate-original', counterBaseline: 0 });
  assert.equal(receipt.atAuthor, true);
  assert.equal(receipt.routeChanged, false);
  assert.equal(receipt.fetchPreserved, true);
  assert.equal(receipt.dependenciesPreserved, true);
  assert.equal(receipt.actualSearchProvider, 'candidate-original');
  assert.equal(receipt.originalSearchCalls, 0);
  assert.equal(receipt.originalSearchBaseline, 0);
  assert.equal(receipt.originalSearchDelta, 0);
  assert.equal(receipt.counterSource, 'grokSearchOriginalSearchCounter');
  assert.equal(receipt.counterAdapterVersion, 1);
  ctx.dispose();

  const malformed = makeContext();
  malformed.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: '0' }) });
  applyRouteVerifier(malformed);
  await assert.rejects(() => malformed.get('grokSearchRouteVerifier').verify({ authorSearchProvider: 'candidate-original' }),
    error => error.code === 'CONTROL_ROUTE_COUNTER_REQUIRED');
  malformed.dispose();
});

test('product route verifier preserves an explicitly recorded null author', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  applyRouteVerifier(ctx);
  const receipt = await ctx.get('grokSearchRouteVerifier').verify({
    authorSearchProvider: null, authorFetchProvider: null, counterBaseline: 0,
  });
  assert.equal(receipt.atAuthor, false);
  assert.equal(receipt.fetchPreserved, false);
  ctx.dispose();
});

test('product route verifier counts canonical official-search events without retaining request data', async () => {
  const ctx = makeContext();
  applyRouteVerifier(ctx);
  const verifier = ctx.get('grokSearchRouteVerifier');
  const counter = ctx.get('grokSearchOriginalSearchCounter');
  assert.ok(verifier);
  assert.ok(counter);

  const emit = event => {
    for (const callback of ctx.events.get('session/event') ?? []) callback({ id: 'session-test' }, event);
  };
  emit({ type: 'tool/result', data: { body: 'ignored' } });
  emit({ type: 'web/deepseek-search-llm-request', data: { body: { secret: 'must-not-be-retained' } } });
  emit({ type: 'web/deepseek-search-llm-request', data: { body: { query: 'second' } } });

  const receipt = await verifier.verify({ authorSearchProvider: 'candidate-original', counterBaseline: 2 });
  assert.equal(receipt.originalSearchCalls, 2);
  assert.equal(receipt.originalSearchBaseline, 2);
  assert.equal(receipt.originalSearchDelta, 0);
  assert.equal(receipt.counterSource, 'dsh-session/web-deepseek-search-llm-request');
  assert.equal(receipt.counterAdapterVersion, 1);
  assert.deepEqual(Object.keys(counter.snapshot()).sort(),
    ['adapterVersion', 'calls', 'eventType', 'originalSearchCalls', 'source']);

  ctx.dispose();
  emit({ type: 'web/deepseek-search-llm-request', data: { body: { query: 'after-dispose' } } });
  assert.equal(counter.snapshot().calls, 2);
});
test('the product manifest ships search, settings and recovery entries in one bundle (D-28)', () => {
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const rootPatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.equal(root.exports['./control'], './src/control.mjs');
  assert.equal(root.exports['./recovery'], './src/recovery.mjs');
  assert.equal(root.exports['./route-verifier'], './src/route-verifier.mjs');
  assert.equal(PRODUCT_RECOVERY_BUNDLE, PRODUCT_SEARCH_BUNDLE);
  assert.match(rootPatch, /name: dsh-grok-search\s*$/);
  assert.equal(root.exports['.'], './src/bundle.mjs');
  assert.equal(root.exports['./search-core'], './src/index.mjs');
  assert.equal((rootPatch.match(/- id:/g) ?? []).length, 1);
  const bundle = readFileSync(new URL('../src/bundle.mjs', import.meta.url), 'utf8');
  assert.match(bundle, /recovery:\s*\(\) => import\('\.\/recovery\.mjs'\)/);
  assert.match(bundle, /settings:\s*\(\) => import\('\.\/settings-ui\.mjs'\)/);
  assert.ok(root.files.includes('src/route-verifier.mjs'));
  assert.ok(root.files.includes('src/bundle.mjs'));
  assert.ok(root.files.includes('src/control.mjs'));
  assert.ok(root.files.includes('src/recovery.mjs'));
});

test('historical completion cannot admit a new owner while this generation cleanup is running', async () => {
  const ctx = makeContext({ originalCalls: 0 }), store = createProductStore(ctx, { deferMaintenance: true });
  const disposal = deferred(), cancellation = deferred();
  let stopping;
  try {
    await applyControl(ctx, { store });
    await ctx.get('grokSearchControl').stop('native-bundle-disable');
    await waitForRuntimeCleanup(store);
    const completed = store.read();
    ctx.dispose();
    ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: () => disposal.promise });
    await applyControl(ctx, { store, canAcquire: () => false, onStop: () => cancellation.promise });
    stopping = ctx.get('grokSearchControl').stop('native-bundle-disable');
    assert.equal(productRuntimeCleanupInFlight(store), true);
    assert.equal(productReleaseInFlight(store, completed.intent.release.operationId), true);
    ctx.dispose();
    ctx.provide('grokSearchControl', undefined);
    ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
    await applyControl(ctx, { store, keepAliveOnFailure: true });
    const replacement = ctx.get('grokSearchControl');
    assert.equal(replacement.publicSnapshot().phase, 'incomplete');
    assert.equal(replacement.publicSnapshot().error.code, 'CONTROL_RUNTIME_CLEANUP_PENDING');
    assert.deepEqual(store.read(), completed);
    disposal.resolve(); await disposal.promise; await nextImmediate();
    assert.equal(productRuntimeCleanupInFlight(store), true);
    cancellation.resolve();
    assert.equal((await stopping).kind, 'already-released');
    await waitForRuntimeCleanup(store);
    assert.deepEqual(store.read(), completed);
    assert.equal((await replacement.retry()).phase, 'required');
    assert.equal(productRuntimeCleanupInFlight(store), false);
    assert.equal(store.read().revision, completed.revision + 1);
  } finally {
    disposal.resolve(); cancellation.resolve(); await stopping?.catch(() => {}); await nextImmediate(); ctx.dispose();
  }
});

test('an already-released stop waits for this generation cleanup and shares its pending result', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  const program = deferred(), core = deferred();
  let stopped = false, disposals = 0;
  await applyControl(ctx);
  await ctx.get('grokSearchControl').stop('seed-completion');
  ctx.dispose();
  ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(),
    dispose: () => { disposals++; return core.promise; } });
  await applyControl(ctx, { canAcquire: () => false, onStop: () => program.promise });
  const control = ctx.get('grokSearchControl');
  const pending = control.stop('cancel-new-generation');
  pending.then(() => { stopped = true; }, () => {});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'historical completion is not proof of current cleanup');
    assert.equal(control.stop('duplicate-stop'), pending);
    program.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'core disposal must also settle');
    core.resolve();
    assert.equal((await pending).kind, 'already-released');
    assert.equal(disposals, 1);
  } finally { program.resolve(); core.resolve(); await pending.catch(() => {}); ctx.dispose(); }
});

test('an already-released stop reports a new cancellation failure and can retry without redisposal', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  await ctx.get('grokSearchControl').stop('seed-completion');
  ctx.dispose();
  let canStop = false, disposals = 0;
  const failure = Object.assign(new Error('program cleanup failed'), { code: 'TEST_PROGRAM_CLEANUP' });
  ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => { disposals++; } });
  await applyControl(ctx, { canAcquire: () => false,
    onStop: () => canStop ? Promise.resolve() : Promise.reject(failure) });
  try {
    const control = ctx.get('grokSearchControl');
    await assert.rejects(control.stop('stop-failed-generation'), { code: 'TEST_PROGRAM_CLEANUP' });
    assert.equal(control.publicSnapshot().phase, 'incomplete');
    assert.equal(control.snapshot().phase, 'incomplete');
    canStop = true;
    await control.retryRelease();
    assert.equal(control.publicSnapshot().phase, 'released');
    assert.equal(disposals, 1);
  } finally { ctx.dispose(); }
});

test('an already-released stop bounds an unsettled new cleanup without redisposing its core', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  await ctx.get('grokSearchControl').stop('seed-completion');
  ctx.dispose();
  let disposals = 0;
  ctx.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(),
    dispose: async () => { disposals++; } });
  await applyControl(ctx, { canAcquire: () => false, onStop: () => new Promise(() => {}) });
  try {
    const control = ctx.get('grokSearchControl');
    await assert.rejects(control.stop('bounded-cleanup'), { code: 'CONTROL_RELEASE_DRAIN_TIMEOUT' });
    assert.equal(control.publicSnapshot().phase, 'incomplete');
    assert.equal(disposals, 1);
  } finally { ctx.dispose(); }
});

test('release completion rejects live route changes while waiting for its writer lock', async t => {
  for (const change of ['route', 'counter', 'counter-source', 'web-owner']) await t.test(change, async () => {
  const ctx = makeContext({ originalCalls: 0 }), waiting = deferred();
  const store = createProductStore(ctx);
  let lock;
  const gated = { ...store, compareAndSwapAsync(request) {
    if (request.intent.releaseCompletion && !lock) {
      lock = acquireOwnedLock(join(store.directory, 'control-write.lock'));
      waiting.resolve();
    }
    return store.compareAndSwapAsync(request);
  } };
  await applyControl(ctx, { store: gated });
  const pending = ctx.get('grokSearchControl').stop('release-before-route-change');
  try {
    await waiting.promise;
    const entry = ctx.loader.entries()[0];
    if (change === 'route') {
      entry.fiber.config.searchProvider = 'different-owner';
      entry.options.config.searchProvider = 'different-owner';
      ctx.get('web').searchProviderId = 'different-owner';
    } else if (change === 'counter') {
      ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: 1 }) });
    } else if (change === 'counter-source') {
      ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: 0, source: 'replacement-counter' }) });
    } else entry.fiber.uid++;
    lock.release();
    const result = await pending;
    assert.equal(result.kind, 'incomplete');
    assert.equal(result.completionCommitted, false);
    assert.equal(store.read().intent.releaseCompletion, undefined);
  } finally { lock?.release(); await pending.catch(() => {}); ctx.dispose(); }
  });
});

test('same-process recovery completion rejects counter and author changes while waiting for its writer lock', async t => {
  for (const change of ['counter', 'author']) await t.test(change, async () => {
  const ctx = makeContext({ originalCalls: 0 }), waiting = deferred();
  applyRouteVerifier(ctx);
  const store = createProductStore(ctx), { released } = createInterruptedReleaseRecord(ctx, store);
  assert.equal(productReleaseInFlight(store, released.intent.release.operationId), false);
  const lock = acquireOwnedLock(join(store.directory, 'control-write.lock'));
  applyRecovery(ctx, { store: { ...store, compareAndSwapAsync(request) {
    waiting.resolve();
    return store.compareAndSwapAsync(request);
  } } });
  const pending = ctx.get('grokSearchRecovery').retry();
  pending.catch(() => {});
  try {
    await waiting.promise;
    if (change === 'counter') {
      ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: 1 }) });
    } else {
      const entry = ctx.loader.entries()[0];
      entry.options.config.searchProvider = 'different-owner';
      entry.fiber.config.searchProvider = 'different-owner';
      ctx.get('web').searchProviderId = 'different-owner';
    }
    lock.release();
    await assert.rejects(pending, error => /^CONTROL_RECOVERY_/.test(error.code));
    assert.deepEqual(store.read(), released);
    assert.equal(store.read().intent.releaseCompletion, undefined);
    if (change === 'author') assert.equal(ctx.get('web').searchProviderId, 'different-owner');
  } finally { lock.release(); await pending.catch(() => {}); ctx.dispose(); }
  });
});
