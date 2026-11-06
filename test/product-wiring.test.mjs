import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { apply as applyControl, projectPublicSnapshot } from '../src/control.mjs';
import { apply as applyRecovery } from '../src/recovery.mjs';
import { apply as applyRouteVerifier } from '../src/route-verifier.mjs';
import { apply as applySettingsUi, SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import {
  PRODUCT_SEARCH_BUNDLE, PRODUCT_RECOVERY_BUNDLE, PRODUCT_HOST_ID, createAcquisition, createLease, createProductStore,
  createProductReleaseController, effectiveFetchProvider, effectiveSearchProvider, routeReceipt, takeOverAuthorRoute,
  restoreAuthorRoute, effectiveConfig, createSearchConfigHook,
} from '../src/core/product-control.mjs';
import { commitExplicitRelease, createReleaseBarrier } from '../src/core/release-transaction.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
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

test('a fresh enabled owner reacquires a completed release and preserves immutable history', async () => {
  const ctx = makeContext({ originalCalls: 0 });
  await applyControl(ctx);
  const store = createProductStore(ctx);
  const oldOwner = ctx.get('grokSearchControl');
  await oldOwner.stop('native-bundle-disable');
  const released = store.read();
  assert.equal(released.intent.policy, 'released');
  assert.equal((await oldOwner.retry()).phase, 'released');
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

test('product control stop prelude failure is recorded and retryable', async () => {
  const ctx = makeContext();
  await applyControl(ctx);
  const service = ctx.get('grokSearchControl');
  await service.retry();
  const core = ctx.get('grokSearchCore');
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
  const outcome = await service.stop('retry-with-counter');
  assert.equal(outcome.kind, 'released');
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

test('route takeover rolls back when the host update throws after applying a change', async () => {
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
  assert.equal(effectiveSearchProvider(entry), 'candidate-original');
  assert.equal(effectiveFetchProvider(entry), 'candidate-fetch');
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

test('settings gateway unavailable snapshot includes completionCommitted', async () => withIsolatedHome(async home => {
  let Gateway;
  applySettingsUi({ plugin(Plugin) { Gateway = Plugin; } });
  const gateway = new Gateway({ provide() {} });
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
  let Gateway;
  applySettingsUi({ plugin(Plugin) { Gateway = Plugin; } });
  const gateway = new Gateway(ctx);
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

// D-28 regression: restoring the web route restarts the control fiber, so the owner service can
// be briefly absent while its release task is still in flight. A release committed by this
// process must stay with that task even when the owner service is not registered.
test('product recovery never completes a release committed by the current process', async () => {
  let verifyCalls = 0;
  const verifier = {
    verify: observation => {
      verifyCalls += 1;
      return { atAuthor: true, routeChanged: observation.routeChanged === true,
        fetchPreserved: true, dependenciesPreserved: true, actualSearchProvider: observation.authorSearchProvider,
        originalSearchCalls: observation.counterBaseline,
        originalSearchBaseline: observation.counterBaseline, originalSearchDelta: 0 };
    },
  };
  const ctx = makeContext({ verifier, originalCalls: 0 });
  const store = createProductStore(ctx);
  const required = createRequiredRecord(ctx, store, PRODUCT_HOST_ID);
  const releaseIntent = { ...required.intent, policy: 'released', reason: 'settings-ui-explicit-stop',
    pause: { confirmed: true, reason: 'settings-ui-explicit-stop', observedAt: '2026-10-26T00:00:00.000Z' },
    priorIntent: structuredClone(required.intent), release: { explicit: true,
      committedAt: '2026-10-26T00:00:00.000Z', kind: 'intent-release-commit',
      operationId: randomUUID(), hostId: PRODUCT_HOST_ID, pid: required.intent.lease.pid,
      author: required.intent.acquisition.authorSearchProvider, counterBaseline: 0,
      routeChanged: false, routeVerified: false } };
  const released = store.compareAndSwap({ expectedRevision: required.revision, intent: releaseIntent });
  assert.equal(ctx.get('grokSearchControl'), undefined);
  applyRecovery(ctx);
  const state = await ctx.get('grokSearchRecovery').retry();
  assert.equal(state.phase, 'owner-present');
  assert.equal(state.outcome.recordCommitted, false);
  assert.equal(verifyCalls, 0);
  assert.deepEqual(store.read(), released);
  ctx.dispose();
  assert.deepEqual(store.read(), released);
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
  assert.match(bundle, /ctx\.plugin\(recovery\)/);
  assert.match(bundle, /ctx\.plugin\(settings\)/);
  assert.ok(root.files.includes('src/route-verifier.mjs'));
  assert.ok(root.files.includes('src/bundle.mjs'));
  assert.ok(root.files.includes('src/control.mjs'));
  assert.ok(root.files.includes('src/recovery.mjs'));
});
