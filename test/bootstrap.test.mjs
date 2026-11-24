import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, resolveRuntimeConfig } from '../src/core/product-config.mjs';
import { createSearchConfigHook, checkRuntimeContracts, effectiveFetchProvider, selectedId, holdProductRelease } from '../src/core/product-control.mjs';
import { ControlRecordError, createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { apply as applyBundle, Config as BundleConfig } from '../src/bundle.mjs';
import { apply as applyCore, Config as CoreConfig } from '../src/index.mjs';
import { apply as applyControl } from '../src/control.mjs';
import { apply as applyRouteVerifier } from '../src/route-verifier.mjs';
import { apply as applyRecovery } from '../src/recovery.mjs';
import { createCompatibilityGateway, COMPATIBILITY_DESCRIPTORS } from '../src/compatibility-service.mjs';
import { createGithubIntegration } from '../src/core/github-host.mjs';
import { createProgramController } from '../src/program.mjs';
import { createGrokProvider } from '../src/provider.mjs';
import { createRoutedSearch } from '../src/core/routed-search.mjs';
import { createReleaseBarrier } from '../src/core/release-transaction.mjs';

const defaults = { executable: '', executableArgs: [], configPath: '', budgetMs: 120_000 };
const validate = value => Config['~standard'].validate(value);

test('the standalone Config implements the synchronous Standard Schema contract on the minimum host', () => {
  assert.equal(BundleConfig, Config);
  assert.equal(CoreConfig, Config);
  // Cordis 4.0.5 consumes this protocol before running apply; no host class is required.
  for (const input of [undefined, null, {}, { executable: null, executableArgs: null, configPath: null, budgetMs: null }]) {
    const result = validate(input);
    assert.equal('then' in result, false);
    assert.deepEqual(result, { value: defaults });
    assert.deepEqual(resolveRuntimeConfig({ Config }, input), defaults);
  }
  const first = validate({}).value;
  first.executableArgs.push('local');
  assert.deepEqual(validate({}).value, defaults);
});

test('direct core and source diagnostics honor admission while snapshots and disposal remain accessible', async () => {
  const services = new Map(), disposers = [];
  const ctx = {
    get: key => services.get(key),
    provide: (key, value) => services.set(key, value),
    effect: factory => disposers.push(factory()),
    web: { registerSearchProvider() {} }, logger: { warn() {} },
  };
  const blocked = Object.assign(new Error('blocked'), { code: 'COMPATIBILITY_CONFIRMATION_REQUIRED' });
  applyCore(ctx, defaults, { WebError: class extends Error {}, assertExecution: () => { throw blocked; } });
  const core = services.get('grokSearchCore'), sources = services.get('grokSearchSourceRouter');
  try {
    assert.ok(core.snapshot());
    assert.ok(sources.snapshot());
    for (const start of [
      () => core.testSearch({ query: 'test' }), () => core.testGrok({ query: 'test' }),
      () => core.scheduleDiagnosis(() => { throw new Error('must not dispatch'); }),
      () => sources.search({ query: 'test' }), () => sources.diagnose(), () => sources.diagnoseProvider('tavily'),
    ]) await assert.rejects(start, error => error === blocked);
  } finally { await Promise.all(disposers.map(dispose => dispose())); }
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// The root is real product code; only the host and network-capable child plugins are synthetic.
function bootstrapHost({ modern = true, ready = true, trackedServices = [] } = {}) {
  const services = new Map(), hooks = new Map(), scopes = new Set(), injections = [];
  const definitions = new Map(), guards = [];
  const tracked = new Set(trackedServices), cordisOriginal = Symbol.for('cordis.original');
  let nextUid = 1;
  const raw = { searchProvider: 'author', fetchProvider: 'fetch' };
  const wrap = value => ({ get: () => value });
  const expose = (key, value) => !tracked.has(key) || value == null ? value : new Proxy(value, {
    get(target, property) {
      if (property === cordisOriginal) return target;
      const member = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  const hostSchema = { '~standard': { version: 1, validate(value) {
    if (typeof value.searchProvider !== 'string') return { issues: [{ message: 'invalid searchProvider' }] };
    return { value: modern ? { searchProvider: wrap(value.searchProvider), fetchProvider: wrap(value.fetchProvider) }
      : { ...value } };
  } } };
  const web = {
    config: modern ? { searchProvider: wrap('author'), fetchProvider: wrap('fetch') } : { ...raw },
    searchProviderId: 'author', fetchProviderId: 'fetch', registerSearchProvider() {}, search() {}, fetch() {},
  };
  const webFiber = {
    uid: 900, state: 2, config: { ...raw }, runtime: { Config: hostSchema },
    update() {}, await() {}, dispose() {},
  };
  const entry = { options: { id: 'web', name: '@deepseek-ai/dsh-web', config: { ...raw } },
    fiber: webFiber, update() {} };
  let root;
  function context(parent = null) {
    const provided = new Map(), disposers = [], children = [];
    const fiber = { uid: nextUid++, state: 2, entry: parent?.fiber.entry ?? { options: { id: 'grok-search' } } };
    const ctx = {
      fiber, registry: new Map(), profileContext: parent?.profileContext ?? { dir: 'C:/synthetic-profile' },
      logger: { warn() {}, error() {} },
      get(key) {
        const value = provided.has(key) ? provided.get(key) : parent?.get(key) ?? services.get(key);
        if (!tracked.has(key) || value == null) return value;
        const original = value[cordisOriginal] ?? value;
        return expose(key, original);
      },
      provide(key, value) {
        const previous = services.get(key);
        provided.set(key, value);
        services.set(key, value);
        disposers.push(() => {
          provided.delete(key);
          if (services.get(key) === value) {
            if (previous === undefined) services.delete(key); else services.set(key, previous);
          }
        });
        for (const item of injections) activate(item);
      },
      on(name, callback, options = {}) {
        const list = hooks.get(name) ?? [], row = { callback, ctx };
        if (options.prepend) list.unshift(row); else list.push(row);
        hooks.set(name, list);
        const remove = () => { const index = list.indexOf(row); if (index >= 0) list.splice(index, 1); };
        disposers.push(remove);
        return remove;
      },
      effect(factory) {
        const result = factory();
        if (typeof result === 'function') disposers.push(result);
        else if (result?.next) {
          const items = [...result];
          disposers.push(async () => { for (const item of items.reverse()) if (typeof item === 'function') await item(); });
        }
      },
      waterfall(...args) {
        const receiver = typeof args[0] === 'object' ? args.shift() : null;
        const name = args.shift(), last = args.pop();
        const list = [...hooks.get(name) ?? []];
        const next = () => list.length ? list.shift().callback.call(receiver, ...args, next) : last();
        return next();
      },
      async parallel(name, ...args) {
        await Promise.all((hooks.get(name) ?? []).map(({ callback }) => callback(...args)));
      },
      events: { dispatch: (_type, args) => [...hooks.get(args[0]) ?? []].map(({ callback }) => callback) },
      inject(names, callback) {
        const item = { ctx, names, callback, active: false, disposed: false };
        injections.push(item);
        disposers.push(async () => { item.disposed = true; item.active = false; await item.child?.dispose(); });
        activate(item);
        return { dispose() {} };
      },
      plugin(plugin, config = {}) {
        const child = context(ctx), returned = Object.create(child.fiber);
        children.push(child);
        let task;
        task = Promise.resolve().then(() => {
          const validated = plugin.Config ? resolveRuntimeConfig(plugin, config) : config;
          return plugin.apply(child, validated);
        }).catch(error => { child.fiber.state = 0; throw error; });
        returned.then = (yes, no) => task.then(() => yes?.(child.fiber), no);
        returned.dispose = child.dispose;
        child.fiber.dispose = child.dispose;
        child.fiber.await = () => task;
        return returned;
      },
      async dispose() {
        if (fiber.uid === null) return;
        fiber.uid = null;
        await ctx.parallel('internal/plugin', fiber);
        for (const dispose of disposers.splice(0).reverse()) await dispose();
        for (const child of children) await child.dispose();
        scopes.delete(ctx);
      },
    };
    fiber.ctx = ctx;
    Object.defineProperty(ctx, 'loader', { get: () => ctx.get('loader') });
    Object.defineProperty(ctx, 'tools', { get: () => ctx.get('tools') });
    Object.defineProperty(ctx, 'web', { get: () => ctx.waterfall('internal/get', ctx, 'web', null, () => ctx.get('web')) });
    scopes.add(ctx);
    return ctx;
  }
  function activate(item) {
    if (item.active || item.disposed || item.ctx.fiber.uid === null || !item.names.every(name => item.ctx.get(name))) return;
    item.active = true;
    const child = context(item.ctx);
    item.child = child;
    item.ctx.effect(() => () => child.dispose());
    item.callback(child);
  }
  root = context();
  webFiber.entry = entry;
  webFiber.parent = { fiber: {} };
  webFiber.ctx = { fiber: webFiber, get: key => key === 'web' ? web : root.get(key) };
  if (modern) {
    webFiber.rawConfig = webFiber.config;
    webFiber.effectiveConfig = web.config;
    webFiber.resolveConfig = candidate => root.waterfall('internal/config', webFiber,
      () => resolveRuntimeConfig(webFiber.runtime, candidate));
  }
  services.set('loader', { entries: () => [entry] });
  services.set('profileContext', root.profileContext);
  const tools = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => definitions.delete(definition.name);
    },
    get: name => definitions.get(name),
    guard(callback) {
      guards.push(callback);
      return () => guards.splice(guards.indexOf(callback), 1);
    },
    checkGuards: exec => guards.map(guard => guard(exec)).find(value => value !== undefined),
  };
  const activateHost = () => {
    services.set('web', web); services.set('tools', tools);
    for (const item of injections) activate(item);
  };
  const deactivateHost = async (names = ['web', 'tools']) => {
    for (const name of names) services.delete(name);
    for (const item of [...injections]) {
      if (!item.active || item.names.every(name => item.ctx.get(name))) continue;
      item.active = false;
      await item.child.dispose();
    }
  };
  if (ready) activateHost();
  return { ctx: root, web, webFiber, entry, scopes, activateHost, deactivateHost, hooks, services, definitions,
    service(key) { for (const scope of [...scopes].reverse()) { const value = scope.get(key); if (value) return value; } } };
}

function bootstrapFixture({ hostVersion = '0.2.1-rc.2', ready = true, overrides = {}, contractChecks,
  initialRecord = null, readError = null, githubEnabled = false, preferencesFactory = null,
  stateFactory = null, storeFactory = null, retryDelay = async () => {}, trackedServices = [] } = {}) {
  const h = bootstrapHost({ ready, trackedServices }), calls = [], stateListeners = new Set();
  h.ctx.profileContext.dir = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-profile-'));
  let record = initialRecord, confirmation = false, notified = false, confirmationError = null;
  const createPreferences = preferencesFactory ?? (() => ({
    snapshot: () => ({ value: { githubReadEnabled: githubEnabled } }),
  }));
  const store = {
    read: () => { if (readError) throw readError; return record; }, startMaintenance: () => calls.push('maintenance'),
  };
  const makeState = ({ pluginVersion }) => ({
    snapshot: () => ({ hostVersion, pluginVersion, revision: confirmation || notified ? 'a'.repeat(64) : 'missing', confirmed: confirmation,
      notified, errorCode: confirmationError }),
    onChange(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    async confirm() {
      confirmation = true; notified = true; confirmationError = null;
      for (const listener of stateListeners) listener();
    },
    async markNotified() { notified = true; },
    dispose() {},
  });
  const simple = (name, apply = () => {}) => ({ name, apply });
  const modules = {
    appBoot: { getDshRuntimeVersion: () => hostVersion, composeEntries: () => [], readProfilePatches: () => [] },
    web: { WebError: class WebError extends Error { constructor(message, code) { super(message); this.code = code; } } },
    compatibilityService: simple('confirmation-ui'),
    preferences: { createPrivatePreferences: createPreferences },
    program: simple('program', child => { calls.push('program'); child.provide('grokSearchProgram', {}); }),
    core: simple('core', child => {
      calls.push('core');
      child.provide('grokSearchCore', { dispose: async () => { calls.push('core-dispose'); } });
    }),
    control: { name: 'control', async apply(child, options) {
      calls.push('control');
      if (!options.canAcquire()) throw new Error('unadmitted control');
      record = { intent: { policy: 'required' } };
      h.web.searchProviderId = 'grok-search';
      h.webFiber.effectiveConfig.searchProvider = { get: () => 'grok-search' };
      let stopped = false;
      child.provide('grokSearchControl', {
        publicSnapshot: () => ({ phase: stopped ? 'released' : 'required' }),
        retryRelease: async () => {},
        start: options.onStart,
        async stop() {
          await options.onStop();
          stopped = true;
          record = { intent: { policy: 'released', releaseCompletion: {} } };
          h.web.searchProviderId = 'author';
          h.webFiber.effectiveConfig.searchProvider = { get: () => 'author' };
          return { kind: 'released' };
        },
      });
    } },
    routeVerifier: simple('verifier', child => { calls.push('verifier'); child.provide('grokSearchRouteVerifier', {}); }),
    recovery: simple('recovery', child => {
      child.provide('grokSearchRecovery', { retry: async () => { calls.push('recovery'); } });
    }),
    settings: simple('settings', child => {
      calls.push('settings');
      child.provide('grokSearchSettings', { snapshot() {} });
    }),
    github: { createGithubIntegration: ({ getState, getCapabilities }) => ({
      invalidate() {}, sync() {},
      snapshot: () => ({ enabled: getState().enabled, registered: getState().enabled && getCapabilities().githubRead, error: null }),
    }) },
    sharedConfig: { resolveSharedConfigPath: () => 'synthetic-shared-config',
      createSharedConfigStore: () => ({ readEffective: () => ({ github_token: { value: '' } }) }) },
    ...overrides,
  };
  const load = async key => {
    calls.push(`load:${key}`);
    const value = modules[key];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value() : value;
  };
  const checks = contractChecks ?? (() => ({
    configHook: true, configCandidate: true, configUpdate: true, pluginDisposal: true, webSelection: true,
    toolExecution: true, toolResult: true, toolGuards: true, profileSelection: true,
  }));
  let contractCheckCalls = 0;
  const start = (configuration = defaults) => applyBundle(h.ctx, configuration, {
    load, checkContracts: (...args) => { contractCheckCalls++; return checks(...args); },
    createState: stateFactory ?? makeState,
    createStore: (...args) => {
      const selected = storeFactory ? storeFactory(...args) : store;
      return { ...selected, directory: selected.directory ?? join(h.ctx.profileContext.dir, 'control-intent.records') };
    }, createPreferences, retryDelay,
  });
  return { ...h, calls, start, store,
    loseConfirmation(errorCode = null) {
      confirmation = false; confirmationError = errorCode;
      for (const listener of stateListeners) listener();
    },
    coordinator: () => h.ctx.get('grokSearchCompatibility'),
    contractCheckCalls: () => contractCheckCalls,
    settle: () => h.ctx.get('grokSearchBootstrap').settled() };
}

for (const stage of ['import', 'mount']) test(`compatibility RPC recovers its first ${stage} failure without retaining partial services`, async () => {
  let loads = 0, mounts = 0, active = 0;
  const delays = [];
  const f = bootstrapFixture({ retryDelay: async ms => { delays.push(ms); }, overrides: {
    compatibilityService: () => {
      if (++loads === 1 && stage === 'import') throw new Error('temporary import failure');
      return { name: 'compatibility-service', apply(child) {
        mounts++;
        assert.equal(active, 0, 'the previous registration must be retired before retry');
        active++;
        child.effect(() => () => { active--; });
        child.provide('grokSearchCompatibilityRemote', { compatibilityReport() {} });
        if (mounts === 1 && stage === 'mount') throw new Error('temporary mount failure');
      } };
    },
  } });
  f.start();
  try {
    await f.settle();
    assert.equal(loads, 2);
    assert.equal(mounts, stage === 'import' ? 1 : 2);
    assert.equal(active, 1);
    assert.equal(typeof f.ctx.get('grokSearchCompatibilityRemote')?.compatibilityReport, 'function');
    assert.equal(f.coordinator().report().coreReady, true);
    assert.deepEqual(delays, [1000]);
  } finally { await f.ctx.dispose(); }
  assert.equal(active, 0);
});

test('disposing bootstrap cancels a pending compatibility RPC registration retry', async () => {
  const delay = deferred(), waiting = deferred();
  let loads = 0;
  const f = bootstrapFixture({ retryDelay: () => { waiting.resolve(); return delay.promise; }, overrides: {
    compatibilityService: () => { loads++; throw new Error('temporary import failure'); },
  } });
  f.start();
  const bootstrap = f.ctx.get('grokSearchBootstrap');
  try {
    await Promise.race([waiting.promise, bootstrap.settled()]);
    await f.ctx.dispose();
    delay.resolve();
    await bootstrap.settled();
    assert.equal(loads, 1);
    assert.equal(f.ctx.get('grokSearchCompatibilityRemote'), undefined);
  } finally { delay.resolve(); await f.ctx.dispose(); }
});

test('compatibility regression: scalar fetch selectors survive production core, acquisition, takeover and explicit release', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-compat-fetch-release-'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
  const store = createControlIntentStore({ directory: join(directory, 'control-intent.records'),
    trustedRoot: directory, governance: true, autoMaintain: false });
  let updates = 0, upstreamCalls = 0, provider;
  const f = bootstrapFixture({
    trackedServices: ['grokSearchSettings'],
    githubEnabled: true,
    storeFactory: () => ({ ...store, startMaintenance() {} }),
    contractChecks: checkRuntimeContracts,
    overrides: {
      core: { name: 'core', Config: CoreConfig, apply: applyCore },
      control: { name: 'control', apply: applyControl },
      routeVerifier: { name: 'verifier', apply: applyRouteVerifier },
      github: { createGithubIntegration: options => createGithubIntegration({ ...options,
        readerOptions: { fetchImpl: async () => { upstreamCalls++; throw new Error('No upstream requests allowed'); } },
      }) },
    },
  });
  f.ctx.profileContext.dir = directory;
  f.web.registerSearchProvider = value => { provider = value; };
  f.webFiber.effectiveConfig.fetchProvider = 'author-fetch';
  f.web.fetchProviderId = 'author-fetch';
  f.entry.options.config.fetchProvider = 'author-fetch';
  f.webFiber.config.fetchProvider = 'author-fetch';
  f.entry.options.inject = { authorDependency: { required: true } };
  const schema = f.webFiber.runtime.Config['~standard'], validateSchema = schema.validate;
  schema.validate = value => {
    const result = validateSchema(value);
    if (result.value) result.value.fetchProvider = value.fetchProvider;
    return result;
  };
  f.entry.update = async ({ config }) => {
    updates++;
    f.entry.options.config = structuredClone(config);
    f.webFiber.config = structuredClone(config);
    f.webFiber.rawConfig = f.webFiber.config;
    f.webFiber.effectiveConfig = f.webFiber.resolveConfig(config);
    f.web.config = f.webFiber.effectiveConfig;
    f.web.searchProviderId = f.webFiber.effectiveConfig.searchProvider.get();
    f.web.fetchProviderId = selectedId(f.webFiber.effectiveConfig.fetchProvider);
  };
  const authorOptions = structuredClone(f.entry.options.config);
  const authorDependencies = structuredClone(f.entry.options.inject);
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(provider.id, 'grok-search');
    const core = f.service('grokSearchCore'), control = f.service('grokSearchControl');
    assert.equal(core.snapshot().routeExecutor.accepting, true);
    const acquired = store.read(), acquisition = acquired.intent.acquisition;
    assert.equal(acquired.intent.policy, 'required');
    assert.equal(acquisition.authorFetchProvider, 'author-fetch');
    assert.equal(acquisition.authorSearchProvider, 'author');
    assert.equal(control.snapshot().routeChanged, true);
    assert.equal(f.web.searchProviderId, 'grok-search');
    assert.equal(updates, 1);
    assert.equal(effectiveFetchProvider(f.entry), 'author-fetch');
    assert.deepEqual(f.entry.options.config, authorOptions);
    assert.deepEqual(f.entry.options.inject, authorDependencies);
    let dispatched = false;
    f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { dispatched = true; });
    assert.equal(dispatched, true);
    assert.equal(f.contractCheckCalls(), 0, 'startup does not run a runtime contract probe');
    const providerBeforeRecheck = provider;
    const settingsBeforeRecheck = f.ctx.get('grokSearchSettings');
    const canonicalSettings = settingsBeforeRecheck?.[Symbol.for('cordis.original')] ?? settingsBeforeRecheck;
    await f.coordinator().recheck();
    assert.equal(f.contractCheckCalls(), 0, 'recheck does not run a runtime contract probe');
    assert.equal(provider, providerBeforeRecheck);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.web.searchProviderId, 'grok-search');
    assert.equal((f.ctx.get('grokSearchSettings')?.[Symbol.for('cordis.original')]
      ?? f.ctx.get('grokSearchSettings')), canonicalSettings);
    const outcome = await control.stop('explicit-user-release');
    assert.equal(outcome.kind, 'released', JSON.stringify(outcome.error));
    assert.equal(outcome.completionCommitted, true);
    assert.equal(outcome.routeVerified, true);
    const released = store.read(), evidence = released.intent.releaseCompletion.routeEvidence;
    assert.equal(released.intent.policy, 'released');
    assert.equal(evidence.atAuthor, true);
    assert.equal(evidence.fetchPreserved, true);
    assert.equal(evidence.dependenciesPreserved, true);
    assert.equal(evidence.originalSearchDelta, 0);
    assert.equal(evidence.actualSearchProvider, 'author');
    assert.equal(evidence.actualFetchProvider, 'author-fetch');
    assert.equal(f.web.searchProviderId, 'author');
    assert.equal(effectiveFetchProvider(f.entry), 'author-fetch');
    assert.equal(updates, 2);
    assert.deepEqual(f.entry.options.config, authorOptions);
    assert.deepEqual(f.entry.options.inject, authorDependencies);
    assert.equal(core.snapshot().routeExecutor.accepting, false);
    assert.equal(upstreamCalls, 0);
  } finally { await f.ctx.dispose(); }
});

test('compatibility regression: lifecycle failure leaves core ready and manual retry retires partial effects', async () => {
  let attempts = 0, active = 0, peak = 0;
  const waits = [];
  const f = bootstrapFixture({
    retryDelay: async ms => { waits.push(ms); },
    overrides: {
      routeVerifier: { name: 'verifier', apply(child) {
        attempts++;
        peak = Math.max(peak, ++active);
        child.effect(() => () => { active--; });
        child.provide('grokSearchRouteVerifier', {});
      } },
      recovery: { name: 'recovery', apply(child) {
        child.provide('grokSearchRecovery', { retry: async () => {
          if (attempts === 1) throw new Error('temporary recovery initialization failure');
        } });
      } },
    },
  });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(attempts, 1);
    assert.equal(active, 0);
    assert.deepEqual(waits, []);
    const core = f.service('grokSearchCore'), epoch = f.coordinator().captureEpoch();
    await f.coordinator().recheck();
    await f.settle();
    assert.equal(attempts, 2);
    assert.equal(active, 1);
    assert.equal(peak, 1);
    assert.deepEqual(waits, []);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.service('grokSearchCore'), core);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.calls.filter(call => call === 'program').length, 1);
    assert.equal(f.contractCheckCalls(), 0);
  } finally { await f.ctx.dispose(); }
  assert.equal(active, 0);
});

test('compatibility limitation: unreadable author fetch values never authorize a guessed takeover', async t => {
  const scenarios = ['effective field', 'effective selector', 'normalized field', 'normalized selector'];
  for (const scenario of scenarios) await t.test(scenario, async () => {
    const [stage, failure] = scenario.split(' ');
    const directory = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-unreadable-route-'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
    const store = createControlIntentStore({ directory: join(directory, 'control-intent.records'),
      trustedRoot: directory, governance: true, autoMaintain: false });
    let updates = 0, reads = 0;
    const f = bootstrapFixture({ storeFactory: () => ({ ...store, startMaintenance() {} }),
      overrides: { control: { name: 'control', apply: applyControl } } });
    f.ctx.profileContext.dir = directory;
    // Neither readable fallback proves the unreadable effective/normalized selection.
    f.entry.options.config.fetchProvider = 'author-raw-fetch';
    f.webFiber.config.fetchProvider = 'author-raw-fetch';
    f.web.fetchProviderId = 'runtime-fetch';
    const unreadable = () => { reads++; throw new Error('author fetch choice cannot be read'); };
    const breakSelector = config => {
      if (failure === 'field') Object.defineProperty(config, 'fetchProvider', { enumerable: true, get: unreadable });
      else config.fetchProvider = { get: unreadable };
    };
    if (stage === 'effective') breakSelector(f.webFiber.effectiveConfig);
    else {
      const schema = f.webFiber.runtime.Config['~standard'], validate = schema.validate;
      schema.validate = value => {
        const result = validate(value);
        if (result.value) breakSelector(result.value);
        return result;
      };
    }
    f.entry.update = async ({ config }) => {
      const effective = f.webFiber.resolveConfig(config);
      selectedId(effective.fetchProvider);
      updates++;
      assert.fail('An unreadable fetch selection must not be applied');
    };
    try {
      f.start();
      await f.settle();
      const report = f.coordinator().report();
      assert.equal(report.minimumAdmitted, true);
      assert.equal(report.coreReady, false);
      assert.equal(report.phase, 'blocked');
      assert.ok(reads > 0, 'the real acquisition or route update must encounter the unreadable selector');
      assert.equal(updates, 0);
      assert.equal(f.calls.includes('load:control'), true);
      assert.equal(f.web.searchProviderId, 'author');
      assert.equal(f.contractCheckCalls(), 0);
      let dispatched = false;
      assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { dispatched = true; }),
        { code: report.code });
      assert.equal(dispatched, false, 'an unreadable author fetch selection must not authorize takeover');
      assert.equal(f.entry.options.config.searchProvider, 'author');
      assert.equal(f.web.fetchProviderId, 'runtime-fetch');
      assert.equal(f.entry.options.config.fetchProvider, 'author-raw-fetch');
    } finally { await f.ctx.dispose(); }
  });
});

test('compatibility regression: lifecycle cleanup finishes before a retry can register its replacement', async () => {
  const cleaning = deferred(), release = deferred();
  let attempts = 0, active = 0, peak = 0;
  const f = bootstrapFixture({ overrides: {
    routeVerifier: { name: 'verifier', apply(child) {
      const first = ++attempts === 1;
      peak = Math.max(peak, ++active);
      child.effect(() => async () => {
        if (first) { cleaning.resolve(); await release.promise; }
        active--;
      });
      child.provide('grokSearchRouteVerifier', {});
    } },
    recovery: { name: 'recovery', apply() { if (attempts === 1) throw new Error('partial initialization'); } },
  } });
  try {
    f.start();
    await cleaning.promise;
    await turn();
    assert.equal(attempts, 1);
    assert.equal(active, 1);
    assert.equal(f.coordinator().report().coreReady, true, 'core must not wait for lifecycle cleanup');
    const core = f.service('grokSearchCore'), epoch = f.coordinator().captureEpoch();
    await f.coordinator().recheck();
    assert.equal(attempts, 1, 'a pending cleanup must not allow a replacement scope');
    release.resolve();
    await f.settle();
    assert.equal(attempts, 1);
    assert.equal(active, 0);
    await f.coordinator().recheck();
    await f.settle();
    assert.equal(attempts, 2);
    assert.equal(active, 1);
    assert.equal(peak, 1);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.service('grokSearchCore'), core);
    assert.equal(f.coordinator().captureEpoch(), epoch);
  } finally { release.resolve(); await f.ctx.dispose(); }
});

test('compatibility regression: manual retry reloads a failed lifecycle without duplicating services', async () => {
  let failing = true, loads = 0;
  const f = bootstrapFixture({ overrides: { routeVerifier: () => {
    loads++;
    if (failing) throw new Error('temporary verifier import failure');
    return { name: 'verifier', apply(child) { child.provide('grokSearchRouteVerifier', {}); } };
  } } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().report().phase, 'ready');
    assert.equal(loads, 1);
    const core = f.service('grokSearchCore'), epoch = f.coordinator().captureEpoch();
    failing = false;
    await f.coordinator().recheck();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(loads, 2);
    assert.equal(f.service('grokSearchCore'), core);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.calls.filter(call => call === 'program').length, 1);
  } finally { await f.ctx.dispose(); }
});

test('compatibility regression: failed lifecycle cleanup never permits a duplicate replacement', async () => {
  let attempts = 0;
  const f = bootstrapFixture({ overrides: {
    routeVerifier: { name: 'verifier', apply(child) {
      attempts++;
      child.effect(() => () => { throw new Error('unconfirmed cleanup'); });
      child.provide('grokSearchRouteVerifier', {});
    } },
    recovery: { name: 'recovery', apply() { throw new Error('partial initialization'); } },
  } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    const core = f.service('grokSearchCore'), epoch = f.coordinator().captureEpoch();
    await f.coordinator().recheck();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(attempts, 1);
    assert.equal(f.service('grokSearchCore'), core);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.calls.filter(call => call === 'program').length, 1);
  } finally { await f.ctx.dispose(); }
});

test('compatibility regression: recheck retries optional imports and reports only actual ready instances', async () => {
  let repaired = false, settingsLoads = 0, githubLoads = 0, active = 0;
  const f = bootstrapFixture({ githubEnabled: true, overrides: {
    settings: () => {
      settingsLoads++;
      if (!repaired) throw new Error('optional settings import failure');
      return { name: 'settings', apply(child) {
        active++;
        child.effect(() => () => { active--; });
        child.provide('grokSearchSettings', { snapshot() {} });
      } };
    },
    github: () => {
      githubLoads++;
      if (!repaired) throw new Error('optional GitHub import failure');
      return { createGithubIntegration: options => createGithubIntegration({ ...options,
        readerOptions: { fetchImpl: async () => { assert.fail('No upstream requests allowed'); } } }) };
    },
  } });
  try {
    f.start();
    await f.settle();
    const epoch = f.coordinator().captureEpoch();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, false);
    assert.equal(f.coordinator().report().optionalFeatures.github.available, false);
    assert.equal(f.coordinator().report().optionalFeatures.github.code, 'COMPATIBILITY_GITHUB_UNAVAILABLE');
    assert.equal(settingsLoads, 1);
    assert.equal(githubLoads, 1);
    await f.coordinator().recheck();
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, false);
    assert.equal(f.coordinator().report().optionalFeatures.github.available, false);
    assert.equal(settingsLoads, 2);
    assert.equal(githubLoads, 2);
    repaired = true;
    await Promise.all([f.coordinator().recheck(), f.coordinator().recheck()]);
    await f.settle();
    const report = f.coordinator().report();
    assert.equal(report.optionalFeatures.settings.available, true);
    assert.equal(report.optionalFeatures.github.available, true);
    assert.equal(f.ctx.get('grokSearchGithub').snapshot().registered, true);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(settingsLoads, 3);
    assert.equal(githubLoads, 3);
    assert.equal(active, 1);
    assert.equal(f.calls.filter(call => call === 'program').length, 1);
    assert.equal(f.contractCheckCalls(), 0);
  } finally { await f.ctx.dispose(); }
  assert.equal(active, 0);
});

test('compatibility regression: optional report follows real GitHub registration and intent changes', async () => {
  let enabled = false;
  const f = bootstrapFixture({
    preferencesFactory: () => ({ snapshot: () => ({ value: { githubReadEnabled: enabled } }) }),
    overrides: { github: { createGithubIntegration: options => createGithubIntegration(options) } },
  });
  try {
    f.start();
    await f.settle();
    const github = f.ctx.get('grokSearchGithub'), epoch = f.coordinator().captureEpoch();
    enabled = true;
    github.sync();
    assert.equal(f.coordinator().report().phase, 'ready');
    assert.equal(f.coordinator().report().optionalFeatures.github.available, true);
    assert.equal(f.coordinator().report().coreReady, true);
    enabled = false;
    github.sync();
    assert.equal(f.coordinator().report().phase, 'ready');
    assert.equal(f.coordinator().report().optionalFeatures.github.available, true);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.contractCheckCalls(), 0);
  } finally { await f.ctx.dispose(); }
});

test('compatibility regression: GitHub registration can recover in place without replacing its live instance', async () => {
  let conflict = true;
  const f = bootstrapFixture({ githubEnabled: true, overrides: {
    github: { createGithubIntegration: options => createGithubIntegration(options) },
  } });
  const tools = f.ctx.get('tools'), register = tools.register;
  tools.register = definition => {
    if (conflict && definition.name === 'github_read') throw new Error('synthetic registration conflict');
    return register(definition);
  };
  try {
    f.start();
    await f.settle();
    const instance = f.ctx.get('grokSearchGithub'), epoch = f.coordinator().captureEpoch();
    assert.equal(f.coordinator().report().phase, 'degraded');
    assert.equal(instance.snapshot().registered, false);
    conflict = false;
    await f.coordinator().recheck();
    assert.equal(f.ctx.get('grokSearchGithub'), instance);
    assert.equal(instance.snapshot().registered, true);
    assert.equal(f.coordinator().report().optionalFeatures.github.available, true);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.calls.filter(call => call === 'load:github').length, 1);
    assert.equal(f.contractCheckCalls(), 0);
  } finally { await f.ctx.dispose(); }
});

test('compatibility regression: failed optional initialization disposes partial registrations before retry', async () => {
  let attempts = 0, active = 0, peak = 0;
  const f = bootstrapFixture({ overrides: {
    settings: { name: 'settings', apply(child) {
      attempts++;
      peak = Math.max(peak, ++active);
      child.effect(() => () => { active--; });
      child.provide('grokSearchSettings', { snapshot() {} });
      if (attempts === 1) throw new Error('optional setup failed after publication');
    } },
  } });
  try {
    f.start();
    await f.settle();
    assert.equal(active, 0);
    assert.equal(f.ctx.get('grokSearchSettings'), undefined);
    assert.equal(f.coordinator().report().coreReady, true);
    await f.coordinator().recheck();
    await f.settle();
    assert.equal(active, 1);
    assert.equal(peak, 1);
    assert.equal(attempts, 2);
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
  } finally { await f.ctx.dispose(); }
  assert.equal(active, 0);
});

test('compatibility regression: settings recheck recovers its optional mount without revoking live routes', async () => {
  let loads = 0;
  const f = bootstrapFixture({
    overrides: { settings: () => {
      if (++loads === 1) throw new Error('temporary settings import failure');
      return { name: 'settings', apply(child) { child.provide('grokSearchSettings', { snapshot() {} }); } };
    } },
  });
  try {
    f.start();
    await f.settle();
    const epoch = f.coordinator().captureEpoch(), phases = [];
    f.coordinator().subscribe(report => phases.push(report.coreReady));
    await f.coordinator().recheck();
    assert.equal(loads, 2);
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(phases.every(Boolean), true);
    assert.equal(f.contractCheckCalls(), 0);
    let dispatched = false;
    f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { dispatched = true; });
    assert.equal(dispatched, true);
  } finally { await f.ctx.dispose(); }
});

test('compatibility regression: an in-flight search and canonical settings survive probe-free recheck', { timeout: 10_000 }, async () => {
  const dispatched = deferred(), finish = deferred(), caller = new AbortController();
  let settingsLoads = 0, settingsActive = 0, settingsMounts = 0;
  let provider, pending, settled = false, dispatches = 0, aborts = 0, officialCalls = 0, coreDisposals = 0;
  const f = bootstrapFixture({ trackedServices: ['grokSearchSettings'],
    overrides: {
      core: { name: 'core', apply(child, config, admission) {
        const primary = createGrokProvider({ configuration: { ...config, executable: process.execPath },
          // Keep the production queues, admission and cancellation path; only MCP I/O is synthetic.
          runQuery: async input => {
            dispatches++;
            const aborted = () => { aborts++; finish.reject(input.signal.reason); };
            input.signal.addEventListener('abort', aborted, { once: true });
            dispatched.resolve(input);
            try {
              await finish.promise;
              input.signal.throwIfAborted();
              return { content: `${input.queryId}:${input.request.query}`, sources: [{ url: 'https://recheck.test/result' }] };
            } finally { input.signal.removeEventListener('abort', aborted); }
          },
        });
        const releaseBarrier = createReleaseBarrier();
        const routed = createRoutedSearch({ grok: primary.provider, releaseBarrier,
          preferences: child.get('grokSearchPreferences'), ...admission,
          sourceRouter: { snapshot: () => ({ available: false }),
            search: async () => assert.fail('This request must finish through its original primary dispatch') },
        });
        const dispose = async () => { coreDisposals++; await Promise.all([routed.dispose(), primary.dispose()]); };
        child.effect(() => dispose);
        child.provide('grokSearchCore', { releaseBarrier, dispose,
          snapshot: () => ({ ...primary.snapshot(), routeExecutor: routed.snapshot() }) });
        child.web.registerSearchProvider({ ...primary.provider, search: routed.search });
      } },
      settings: () => {
        settingsLoads++;
        return { name: 'settings', apply(child) {
          settingsMounts++; settingsActive++;
          child.effect(() => () => { settingsActive--; });
          child.provide('grokSearchSettings', { snapshot() {} });
        } };
      },
    },
  });
  f.web.registerSearchProvider = value => { provider = value; };
  f.web.search = (request, signal) => {
    if (f.web.searchProviderId !== 'grok-search') {
      officialCalls++;
      assert.fail('The host must not dispatch to its official search provider');
    }
    return provider.search(request, signal);
  };
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
    const settingsProxy = f.ctx.get('grokSearchSettings'), settingsInstance = settingsProxy[Symbol.for('cordis.original')];
    const epoch = f.coordinator().captureEpoch(), registered = provider;
    const names = ['grokSearchCore', 'grokSearchProgram', 'grokSearchControl', 'grokSearchRecovery', 'grokSearchRouteVerifier'];
    const instances = names.map(name => f.service(name)), core = instances[0];
    const request = { query: 'same-request-across-recheck', maxResults: 1 };
    pending = f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => f.web.search(request, caller.signal));
    pending.then(() => { settled = true; }, () => { settled = true; });
    const active = await Promise.race([dispatched.promise, pending.then(() => assert.fail('Search completed before dispatch'))]);
    assert.equal(active.request.query, request.query);
    assert.equal(dispatches, 1);
    assert.equal(settled, false);
    assert.equal(core.snapshot().running, 1);
    assert.equal(core.snapshot().routeExecutor.running, 1);
    const operations = core.releaseBarrier.snapshot().activeOperationIds;
    assert.equal(operations.length, 1);

    await Promise.all([f.coordinator().recheck(), f.coordinator().recheck()]);
    await f.settle();
    const settingsAfterRecheck = f.ctx.get('grokSearchSettings');
    assert.notEqual(settingsAfterRecheck, settingsProxy, 'Cordis may return a fresh caller-bound proxy');
    assert.equal(settingsAfterRecheck[Symbol.for('cordis.original')], settingsInstance);
    assert.equal(f.contractCheckCalls(), 0);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
    assert.equal(settingsLoads, 1);
    assert.equal(settingsMounts, 1);
    assert.equal(settingsActive, 1);
    for (const [index, name] of names.entries()) {
      assert.ok(instances[index], name);
      assert.equal(f.service(name), instances[index], name);
    }
    for (const name of ['core', 'program', 'control', 'recovery', 'routeVerifier']) {
      assert.equal(f.calls.filter(call => call === `load:${name}`).length, 1, name);
    }
    assert.equal(provider, registered);
    assert.equal(coreDisposals, 0);
    assert.equal(f.web.searchProviderId, 'grok-search');
    assert.deepEqual(core.releaseBarrier.snapshot().activeOperationIds, operations);
    assert.equal(core.snapshot().running, 1);
    assert.equal(core.snapshot().routeExecutor.running, 1);
    assert.equal(settled, false);
    assert.equal(active.signal.aborted, false);
    assert.equal(caller.signal.aborted, false);
    assert.equal(aborts, 0);
    finish.resolve();
    const result = await pending;
    assert.equal(result.content, `${active.queryId}:${request.query}`);
    assert.equal(result.sources[0].url, 'https://recheck.test/result');
    assert.equal(dispatches, 1);
    assert.equal(aborts, 0);
    assert.equal(officialCalls, 0);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(core.snapshot().running, 0);
    assert.equal(core.snapshot().routeExecutor.running, 0);
    assert.deepEqual(core.releaseBarrier.snapshot().activeOperationIds, []);
  } finally {
    finish.resolve();
    await pending?.catch(() => {});
    await f.ctx.dispose();
  }
  assert.equal(settingsActive, 0);
});

test('settings mount once at root and accept a healthy service replacement across recheck', async () => {
  let loads = 0, mounts = 0, active = 0;
  let mounted, unsubscribe;
  const f = bootstrapFixture({ trackedServices: ['grokSearchSettings'], overrides: {
    settings: { name: 'settings', apply(child) {
      loads++; mounts++; active++;
      mounted = child;
      child.effect(() => () => { active--; });
      child.provide('grokSearchSettings', { snapshot: () => ({ ready: true }) });
    } },
  } });
  try {
    f.start();
    await f.settle();
    const before = f.ctx.get('grokSearchSettings'), canonical = before[Symbol.for('cordis.original')];
    assert.notEqual(before, f.ctx.get('grokSearchSettings'));
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
    assert.equal(canonical.snapshot().ready, true);
    assert.equal(f.coordinator().report().coreReady, true);
    const providerId = f.web.searchProviderId, epoch = f.coordinator().captureEpoch(), core = f.service('grokSearchCore');
    await f.coordinator().recheck();
    assert.equal(loads, 1);
    assert.equal(mounts, 1);
    assert.equal(active, 1);
    assert.equal(f.ctx.get('grokSearchSettings')[Symbol.for('cordis.original')], canonical);
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.web.searchProviderId, providerId);
    const reports = [];
    unsubscribe = f.coordinator().subscribe(report => { reports.push(report); });
    const replacement = { snapshot: () => ({ ready: true, revision: 'replacement' }) };
    mounted.provide('grokSearchSettings', replacement);
    const current = f.ctx.get('grokSearchSettings');
    assert.notEqual(current[Symbol.for('cordis.original')], canonical);
    assert.equal(current[Symbol.for('cordis.original')], replacement);
    assert.deepEqual(current.snapshot(), { ready: true, revision: 'replacement' });
    assert.equal(f.coordinator().report().phase, 'ready');
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
    await Promise.all([f.coordinator().recheck(), f.coordinator().recheck()]);
    await f.settle();
    assert.equal(f.ctx.get('grokSearchSettings')[Symbol.for('cordis.original')], replacement);
    assert.deepEqual(f.coordinator().report().optionalFeatures.settings, { available: true, code: null });
    assert.equal(f.coordinator().report().phase, 'ready');
    assert.equal(reports.every(report => report.coreReady && report.phase === 'ready'
      && report.optionalFeatures.settings.available), true);
    assert.equal(loads, 1);
    assert.equal(mounts, 1);
    assert.equal(active, 1);
    assert.notEqual(mounted.fiber.uid, null);
    assert.equal(f.calls.filter(call => call === 'load:settings').length, 1);
    assert.equal(f.service('grokSearchCore'), core);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.web.searchProviderId, providerId);
    assert.equal(f.calls.filter(call => call === 'program').length, 1);
    assert.equal(f.contractCheckCalls(), 0);
  } finally { unsubscribe?.(); await f.ctx.dispose(); }
  assert.equal(active, 0);
});

test('settings report real service or mount loss and repair it without replacing the core', async t => {
  for (const failure of ['missing service', 'missing snapshot', 'disposed mount']) await t.test(failure, async () => {
    let mounted, mounts = 0, active = 0, peak = 0;
    const f = bootstrapFixture({ trackedServices: ['grokSearchSettings'], overrides: {
      settings: { name: 'settings', apply(child) {
        mounted = child;
        mounts++;
        peak = Math.max(peak, ++active);
        child.effect(() => () => { active--; });
        child.provide('grokSearchSettings', { snapshot: () => ({ ready: true }) });
      } },
    } });
    try {
      f.start();
      await f.settle();
      const core = f.service('grokSearchCore'), epoch = f.coordinator().captureEpoch(), oldMount = mounted;
      assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
      if (failure === 'disposed mount') {
        await mounted.dispose();
        // A readable replacement alone cannot make a disposed settings mount healthy.
        await f.ctx.plugin({ name: 'replacement', apply(child) {
          child.provide('grokSearchSettings', { snapshot: () => ({ ready: true }) });
        } });
        assert.equal(typeof f.ctx.get('grokSearchSettings').snapshot, 'function');
      } else {
        mounted.provide('grokSearchSettings', failure === 'missing service' ? undefined : {});
      }
      const report = f.coordinator().report();
      assert.deepEqual(report.optionalFeatures.settings, { available: false, code: 'COMPATIBILITY_SETTINGS_UNAVAILABLE' });
      assert.equal(report.phase, 'degraded');
      assert.equal(report.coreReady, true);
      assert.equal(mounts, 1, 'observing a missing service must not mount a replacement');
      await f.coordinator().recheck();
      await f.settle();
      assert.equal(mounts, 2);
      assert.equal(active, 1);
      assert.equal(peak, 1);
      assert.equal(oldMount.fiber.uid, null);
      assert.notEqual(mounted, oldMount);
      assert.equal(f.ctx.get('grokSearchSettings').snapshot().ready, true);
      assert.deepEqual(f.coordinator().report().optionalFeatures.settings, { available: true, code: null });
      assert.equal(f.coordinator().report().coreReady, true);
      assert.equal(f.coordinator().captureEpoch(), epoch);
      assert.equal(f.service('grokSearchCore'), core);
      assert.equal(f.calls.filter(call => call === 'program').length, 1);
      assert.equal(f.contractCheckCalls(), 0);
    } finally { await f.ctx.dispose(); }
    assert.equal(active, 0);
  });
});

test('root protects the import gap synchronously and a missing optional module does not block core', async () => {
  const gate = deferred();
  let githubEnabled = false;
  const f = bootstrapFixture({ preferencesFactory: () => ({
    snapshot: () => ({ value: { githubReadEnabled: githubEnabled } }),
  }), overrides: {
    appBoot: () => gate.promise, settings: new Error('optional settings import failed'), github: new Error('optional github import failed'),
  } });
  try {
    assert.equal(f.start(), undefined);
    assert.deepEqual(f.calls, []);
    let ran = false;
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { ran = true; }),
      error => error.code.startsWith('COMPATIBILITY_'));
    assert.equal(ran, false);
    const result = f.webFiber.resolveConfig({ searchProvider: 'author', fetchProvider: 'fetch' });
    assert.equal(result.searchProvider.get(), 'grok-search');
    gate.resolve({ getDshRuntimeVersion: () => '0.2.1-rc.2' });
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().report().phase, 'degraded');
    assert.equal(f.coordinator().report().optionalFeatures.settings.code, 'COMPATIBILITY_SETTINGS_UNAVAILABLE');
    assert.equal(f.coordinator().report().optionalFeatures.github.code, 'COMPATIBILITY_OPTIONAL_PENDING');
    assert.equal(f.coordinator().report().optionalFeatures.github.available, false);
    assert.equal(f.coordinator().report().verification, 'unverified');
    assert.equal(f.coordinator().report().notified, false, 'a boot log is not an acknowledged UI notice');
    await f.coordinator().acknowledgeNotice({});
    assert.equal(f.coordinator().report().notified, true);
    f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(f.calls.includes('recovery'), true);
    assert.equal(f.calls.includes('program'), true);
    const epoch = f.coordinator().captureEpoch(), core = f.service('grokSearchCore');
    githubEnabled = true;
    await f.coordinator().recheck();
    assert.equal(f.coordinator().report().optionalFeatures.github.code, 'COMPATIBILITY_GITHUB_UNAVAILABLE');
    assert.equal(f.coordinator().report().optionalFeatures.github.available, false);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.service('grokSearchCore'), core);
    assert.equal(f.contractCheckCalls(), 0);
  } finally { await f.ctx.dispose(); }
});

test('a ready root rejects an externally changed search route before dispatching a tool', async () => {
  const f = bootstrapFixture();
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    const owner = f.service('grokSearchControl');
    const before = structuredClone(f.store.read());
    f.web.searchProviderId = 'external-provider';
    f.webFiber.effectiveConfig.searchProvider = { get: () => 'external-provider' };
    let dispatched = false;
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { dispatched = true; }),
      { code: 'COMPATIBILITY_ROUTE_UNCONFIRMED' });
    assert.equal(dispatched, false);
    assert.equal(f.coordinator().report().coreReady, false);
    assert.equal(f.service('grokSearchControl'), owner);
    assert.deepEqual(f.store.read(), before);
    assert.equal(f.web.searchProviderId, 'external-provider');
  } finally { await f.ctx.dispose(); }
});

test('a protected product route cannot hide a current author selection conflict', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-author-conflict-'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
  const store = createControlIntentStore({ directory: join(directory, 'control-intent.records'),
    trustedRoot: directory, governance: true, autoMaintain: false });
  const f = bootstrapFixture({ storeFactory: () => ({ ...store, startMaintenance() {} }), overrides: {
    control: { name: 'control', apply: applyControl },
    routeVerifier: { name: 'verifier', apply: applyRouteVerifier },
    core: { name: 'core', apply(child) {
      child.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
    } },
  } });
  f.ctx.profileContext.dir = directory;
  f.entry.update = async ({ config }) => {
    f.entry.options.config = structuredClone(config);
    f.webFiber.config = structuredClone(config);
    f.webFiber.rawConfig = f.webFiber.config;
    f.webFiber.effectiveConfig = f.webFiber.resolveConfig(config);
    f.web.config = f.webFiber.effectiveConfig;
    f.web.searchProviderId = selectedId(f.webFiber.effectiveConfig.searchProvider);
    f.web.fetchProviderId = selectedId(f.webFiber.effectiveConfig.fetchProvider);
  };
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    const owner = f.service('grokSearchControl'), before = store.read();
    await f.entry.update({ config: { searchProvider: 'new-author', fetchProvider: 'fetch' } });
    assert.equal((await owner.retry()).error.code, 'CONTROL_SEARCH_SELECTION_CONFLICT');
    assert.equal(f.web.searchProviderId, 'grok-search', 'the root config hook still protects the effective route');
    let dispatched = false;
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { dispatched = true; }),
      { code: 'CONTROL_SEARCH_SELECTION_CONFLICT' });
    assert.equal(dispatched, false);
    assert.equal(f.coordinator().report().coreReady, false);
    assert.equal(f.entry.options.config.searchProvider, 'new-author');
    assert.deepEqual(store.read(), before, 'a conflict does not rewrite or release ownership');
    await f.coordinator().start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true, 'a new explicit owner may adopt the current author');
    assert.equal(store.read().intent.acquisition.authorSearchProvider, 'new-author');
    assert.equal(store.read().intent.release, null);
    assert.equal(f.entry.options.config.searchProvider, 'new-author');
  } finally { await f.ctx.dispose(); }
});

test('an admitted search rechecks its route and epoch when a paused tool resumes', async t => {
  for (const change of ['external-route', 'replacement-epoch']) await t.test(change, async () => {
    const f = bootstrapFixture(), entered = deferred(), resume = deferred();
    const caller = { fiber: { uid: 910, runtime: { name: 'tool-web' },
      entry: { options: { name: '@deepseek-ai/dsh-tool-web' } } } };
    let dispatched = 0, pending;
    try {
      f.start();
      await f.settle();
      pending = f.ctx.waterfall('tools/execute', { name: 'web_search', arguments: { query: 'local test' } }, async () => {
        const service = f.ctx.waterfall('internal/get', caller, 'web', null, () => ({
          search: () => { dispatched++; return {}; },
        }));
        entered.resolve();
        await resume.promise;
        return service.search({ query: 'local test' });
      });
      pending.catch(() => {});
      await entered.promise;
      if (change === 'external-route') {
        f.web.searchProviderId = 'external-provider';
        f.webFiber.effectiveConfig.searchProvider = { get: () => 'external-provider' };
      } else {
        f.coordinator().block('COMPATIBILITY_CONTRACT_FAILED');
        await f.coordinator().start();
        await f.settle();
        assert.equal(f.coordinator().report().coreReady, true);
      }
      resume.resolve();
      await assert.rejects(pending, error => error.code?.startsWith('COMPATIBILITY_'));
      assert.equal(dispatched, 0);
      assert.equal(f.store.read().intent.policy, 'required');
    } finally { resume.resolve(); await pending?.catch(() => {}); await f.ctx.dispose(); }
  });
});

test('the root search guard preserves current calls, recovery access and completed explicit release', async () => {
  const f = bootstrapFixture(), caller = { fiber: { uid: 910, runtime: { name: 'tool-web' },
    entry: { options: { name: '@deepseek-ai/dsh-tool-web' } } } };
  const original = { search() { assert.equal(this, original); return 'current-result'; } };
  let held;
  try {
    f.start();
    await f.settle();
    const result = f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => {
      assert.equal(f.ctx.waterfall('internal/get', f.ctx, 'web', null, () => original), original);
      held = f.ctx.waterfall('internal/get', caller, 'web', null, () => original);
      return held.search();
    });
    assert.equal(result, 'current-result', 'a synchronous tool result stays synchronous');
    assert.throws(() => held.search(), { code: 'COMPATIBILITY_STOPPED' });
    await f.service('grokSearchControl').stop();
    assert.equal(f.store.read().intent.policy, 'released');
    await f.settle();
    assert.equal(f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => {
      return f.ctx.waterfall('internal/get', caller, 'web', null, () => original).search();
    }), 'current-result', 'completed explicit release returns search authority to the author');
  } finally { await f.ctx.dispose(); }
});

test('GitHub intent is read synchronously before dynamic imports while only known selected URLs are protected', async () => {
  let reads = 0, originalFetches = 0;
  const f = bootstrapFixture({ preferencesFactory: () => ({ snapshot() {
    reads++;
    return { value: { githubReadEnabled: true } };
  } }) });
  const execute = url => f.ctx.waterfall('tools/execute', { name: 'web_fetch', arguments: { url } },
    () => { originalFetches++; });
  try {
    assert.equal(f.start(), undefined);
    assert.ok(reads > 0, 'private intent must be read before the first await');
    assert.deepEqual(f.calls, [], 'host and runtime modules have not loaded');
    assert.throws(() => execute('https://github.com/example/project/issues/1'),
      error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
    const before = reads;
    execute('https://example.org/page');
    assert.equal(reads, before, 'ordinary fetch does not consult GitHub preferences');
    assert.equal(originalFetches, 1);
  } finally { await f.settle(); await f.ctx.dispose(); }
});

test('early GitHub intent survives appBoot, preferences, core-import and prerelease checks', async t => {
  for (const gap of ['appBoot', 'preferences', 'core-import', 'prerelease']) {
    for (const enabled of [true, false]) await t.test(`${gap}: enabled=${enabled}`, async () => {
      const gate = deferred();
      const hostVersion = gap === 'prerelease' ? '0.4.0-beta.1' : '0.2.1-rc.2';
      const overrides = gap === 'core-import' ? { core: new Error('first core import failed') }
        : ['appBoot', 'preferences'].includes(gap) ? { [gap]: () => gate.promise } : {};
      const initialRecord = { intent: { policy: 'required' } };
      let originalFetches = 0, githubFetches = 0;
      const f = bootstrapFixture({ hostVersion, initialRecord, githubEnabled: enabled, overrides: {
        ...overrides,
        github: { createGithubIntegration: options => createGithubIntegration({ ...options,
          readerOptions: { fetchImpl: async input => {
            githubFetches++;
            const body = new URL(input).pathname.endsWith('/comments') ? [] : {
              id: 1, title: 'Issue', body: 'offline fixture', user: { login: 'fixture' },
            };
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
          } },
        }) },
      } });
      const original = { fetch: async () => { originalFetches++; return {}; } };
      const execute = url => {
        const tools = f.ctx.get('tools');
        tools.register({ name: 'web_fetch', timeoutMs: 30_000 });
        const caller = { tools, fiber: { uid: 910, runtime: { name: 'tool-web' }, config: { fetch: true },
          entry: { options: { name: '@deepseek-ai/dsh-tool-web' } } } };
        const request = { name: 'web_fetch', arguments: { url }, callId: `early-${gap}-${url}`,
          signal: new AbortController().signal, agent: { session: { id: 'early-github' } } };
        return f.ctx.waterfall('tools/execute', request, () => {
          const web = f.ctx.waterfall('internal/get', caller, 'web', null, () => original);
          return web.fetch({ url }, request.signal);
        });
      };
      try {
        f.start();
        await turn();
        if (gap === 'prerelease') assert.equal(f.coordinator().report().confirmationRequired, false);
        if (gap === 'core-import') assert.equal(f.coordinator().report().phase, 'blocked');
        if (gap === 'preferences') assert.equal(f.calls.includes('load:preferences'), false,
          'private preferences no longer wait for dynamic module resolution');
        const coreReady = ['preferences', 'prerelease'].includes(gap);
        assert.equal(f.coordinator().report().coreReady, coreReady);
        if (enabled && !coreReady) await assert.rejects(async () => execute('https://github.com/example/project/issues/1'),
          error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
        else {
          const result = await execute('https://github.com/example/project/issues/1');
          if (enabled) {
            assert.equal(result.statusCode, 200);
            assert.match(result.body.content, /offline fixture/);
          }
        }
        assert.equal(originalFetches, enabled ? 0 : 1);
        assert.equal(githubFetches > 0, enabled && coreReady);
        await execute('https://example.org/page');
        assert.equal(originalFetches, enabled ? 1 : 2);
        assert.equal(f.store.read().intent.policy, 'required');
      } finally {
        gate.resolve(gap === 'appBoot' ? { getDshRuntimeVersion: () => hostVersion }
          : { createPrivatePreferences: () => ({ snapshot: () => ({ value: { githubReadEnabled: enabled } }) }) });
        await f.settle();
        await f.ctx.dispose();
      }
    });
  }
});

test('unknown or unreadable early GitHub intent blocks only known GitHub requests until a valid false is read', async t => {
  for (const state of ['unreadable', 'invalid', 'pending', 'factory-unreadable', 'factory-pending']) await t.test(state, async () => {
    const host = deferred(), preferences = deferred();
    let enabled = null, originalFetches = 0;
    const f = bootstrapFixture({ overrides: { appBoot: () => host.promise }, preferencesFactory: () => {
      if (enabled === null && state === 'factory-unreadable') throw new Error('unavailable private preferences');
      if (enabled === null && state === 'factory-pending') return preferences.promise;
      return { snapshot() {
          if (enabled !== null) return { value: { githubReadEnabled: enabled } };
          if (state === 'unreadable') throw new Error('unreadable private preferences');
          if (state === 'pending') return preferences.promise;
          return { value: {} };
        } };
    } });
    const execute = url => f.ctx.waterfall('tools/execute', { name: 'web_fetch', arguments: { url } },
      () => { originalFetches++; });
    try {
      f.start();
      assert.throws(() => execute('https://github.com/example/project/issues/1'),
        error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
      execute('https://example.org/page');
      assert.equal(originalFetches, 1);
      enabled = false;
      execute('https://github.com/example/project/issues/1');
      assert.equal(originalFetches, 2, 'a valid user-disabled preference keeps its original semantics');
      enabled = null;
      assert.throws(() => execute('https://github.com/example/project/issues/1'),
        error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
      assert.equal(originalFetches, 2, 'a previous false does not authorize unreadable current intent');
      enabled = true;
      assert.throws(() => execute('https://github.com/example/project/issues/1'),
        error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
      assert.equal(originalFetches, 2);
    } finally {
      preferences.resolve({ value: { githubReadEnabled: false } });
      host.resolve({ getDshRuntimeVersion: () => '0.2.1-rc.2' });
      await f.settle();
      await f.ctx.dispose();
    }
  });
});

test('production contract checks use synchronous candidates and scoped sentinels without dispatch or tool residue', async () => {
  for (const modern of [false, true]) {
    const h = bootstrapHost({ modern });
    try {
      h.ctx.on('internal/config', createSearchConfigHook({ required: () => true }), { global: true, prepend: true });
      h.ctx.on('tools/execute', () => { throw Object.assign(new Error('blocked'), { code: 'COMPATIBILITY_CHECKING' }); });
      const original = h.webFiber.config, effective = h.webFiber.effectiveConfig;
      let externalResults = 0;
      h.ctx.on('tools/result', () => { externalResults++; });
      const checks = await checkRuntimeContracts(h.ctx, { selection: () => ({ bundles: ['dsh-grok-search'] }) });
      assert.ok(Object.values(checks).every(value => value === true), JSON.stringify(checks));
      assert.equal(h.webFiber.config, original);
      assert.equal(h.webFiber.effectiveConfig, effective);
      assert.equal(h.web.searchProviderId, 'author');
      assert.equal(h.definitions.size, 0);
      assert.equal(externalResults, 0);
    } finally { await h.ctx.dispose(); }
  }
});

test('config capability checks compare effective values rather than host object identity', async () => {
  const h = bootstrapHost({ modern: true });
  const effective = h.webFiber.effectiveConfig;
  Object.defineProperty(h.webFiber, 'effectiveConfig', {
    configurable: true,
    get: () => ({ searchProvider: effective.searchProvider, fetchProvider: effective.fetchProvider }),
  });
  try {
    h.ctx.on('internal/config', createSearchConfigHook({ required: () => true }), { global: true, prepend: true });
    h.ctx.on('tools/execute', () => { throw Object.assign(new Error('blocked'), { code: 'COMPATIBILITY_CHECKING' }); });
    const checks = await checkRuntimeContracts(h.ctx, { selection: () => ({ bundles: ['dsh-grok-search'] }) });
    assert.ok(Object.values(checks).every(value => value === true), JSON.stringify(checks));
  } finally { await h.ctx.dispose(); }
});

test('a false injected contract result is never called and cannot block actual initialization', async () => {
  const f = bootstrapFixture({ contractChecks: () => ({ configHook: false }) });
  try {
    f.start();
    await f.settle();
    assert.equal(f.contractCheckCalls(), 0);
    assert.equal(f.coordinator().report().phase, 'ready');
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.calls.includes('program'), true);
    assert.equal(f.calls.includes('control'), true);
    assert.equal(f.web.searchProviderId, 'grok-search');
    assert.equal(f.store.read().intent.policy, 'required');
    let dispatched = false;
    f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { dispatched = true; });
    assert.equal(dispatched, true);
  } finally { await f.ctx.dispose(); }
});

test('unreadable required intent preserves both early protection hooks without importing execution modules', async () => {
  const f = bootstrapFixture({ readError: new Error('private record failure') });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().phase, 'blocked');
    assert.deepEqual(f.calls, ['load:settings', 'load:compatibilityService', 'settings']);
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
    assert.equal(typeof f.ctx.get('grokSearchSettings').snapshot, 'function');
    assert.equal(f.contractCheckCalls(), 0);
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => true),
      error => error.code.startsWith('COMPATIBILITY_'));
    assert.equal(f.webFiber.resolveConfig({ searchProvider: 'author', fetchProvider: 'fetch' }).searchProvider.get(), 'grok-search');
  } finally { await f.ctx.dispose(); }
});

test('missing core imports preserve the root settings configPath and recovery without official fallback', async () => {
  const configPath = 'C:/synthetic-profile/explicit-grok-search.json';
  let settingsConfig;
  const f = bootstrapFixture({ overrides: {
    core: new Error('core import failed'),
    settings: { name: 'settings', apply(child, config) {
      settingsConfig = config;
      child.provide('grokSearchSettings', { snapshot: () => ({ configPath: config.configPath }) });
    } },
  } });
  try {
    f.start({ ...defaults, configPath });
    await f.settle();
    assert.equal(f.coordinator().report().phase, 'blocked');
    assert.equal(f.coordinator().report().coreReady, false);
    assert.equal(f.coordinator().report().optionalFeatures.settings.available, true);
    assert.equal(typeof f.ctx.get('grokSearchSettings').snapshot, 'function');
    assert.equal(settingsConfig.configPath, configPath);
    assert.equal(f.ctx.get('grokSearchSettings').snapshot().configPath, configPath);
    assert.equal(f.service('grokSearchCore'), undefined);
    assert.equal(f.service('grokSearchProgram'), undefined);
    assert.equal(f.calls.filter(call => call === 'load:settings').length, 1);
    assert.equal(f.calls.includes('recovery'), true);
    assert.equal(f.calls.includes('program'), false);
    assert.equal(f.store.read(), null);
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => true),
      error => error.code.startsWith('COMPATIBILITY_'));
    assert.equal(f.web.searchProviderId, 'author', 'an unchanged author route is not permission to execute it');
  } finally { await f.ctx.dispose(); }
});

function startupIntentFixture(stage, onAttempt, options = {}) {
  const delays = [];
  let creates = 0, attempts = 0;
  const f = bootstrapFixture({ ...options,
    retryDelay(ms) { delays.push(ms); return options.retryDelay?.(ms); },
    storeFactory() {
      creates++;
      if (stage === 'create') onAttempt(++attempts);
      return { ...f.store, read() {
        if (stage === 'read') onAttempt(++attempts);
        return f.store.read();
      } };
    },
  });
  return { ...f, delays, creates: () => creates, attempts: () => attempts };
}

function assertSingleStartup(f) {
  for (const call of ['settings', 'load:appBoot', 'load:compatibilityService', 'verifier', 'recovery',
    'program', 'core', 'control', 'maintenance']) {
    assert.equal(f.calls.filter(value => value === call).length, 1, call);
  }
  assert.equal(f.coordinator().report().coreReady, true);
  assert.equal(f.web.searchProviderId, 'grok-search');
}

for (const [stage, hostVersion, fault] of [
  ['create', '0.4.0-beta.1', new ControlRecordError('CONTROL_STORAGE_BUSY')],
  ['read', null, new ControlRecordError('CONTROL_COMMIT_INPUT_CHANGED', 'Inputs changed', { retriable: true })],
]) test(`startup intent recovers automatically after the first ${stage} failure`, async () => {
  const f = startupIntentFixture(stage, attempt => { if (attempt === 1) throw fault; }, { hostVersion });
  try {
    f.start();
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => assert.fail('early search')),
      error => error.code.startsWith('COMPATIBILITY_'));
    await f.settle();
    assert.deepEqual(f.delays, [1000]);
    assert.equal(f.creates(), stage === 'create' ? 2 : 1);
    assert.equal(f.coordinator().report().hostVersion, hostVersion);
    assert.equal(f.coordinator().report().confirmationRequired, false);
    assertSingleStartup(f);
  } finally { await f.ctx.dispose(); }
});

test('startup intent exhaustion stays closed until concurrent manual rechecks recover the same root', async () => {
  let locked = true;
  const f = startupIntentFixture('read', () => { if (locked) throw new ControlRecordError('CONTROL_CAS_CONFLICT'); });
  try {
    f.start();
    await f.settle();
    const exhausted = f.coordinator().report(), attempts = f.attempts();
    assert.equal(exhausted.phase, 'blocked');
    assert.equal(f.calls.includes('program'), false);
    assert.equal(f.web.searchProviderId, 'author');
    locked = false;
    const checks = Promise.all([f.coordinator().recheck(), f.coordinator().recheck()]);
    await f.settle();
    assertSingleStartup(f);
    assert.ok((await checks).every(report => report.coreReady));
    assert.deepEqual(f.delays, [1000, 3000]);
    assert.equal(attempts, 3);
    assert.equal(exhausted.code, 'COMPATIBILITY_CORE_UNAVAILABLE');
    assert.equal(f.creates(), 1);
  } finally { await f.ctx.dispose(); }
});

test('a manual startup intent recheck supersedes a sleeping automatic retry without duplicate mounts', async () => {
  const delay = deferred();
  const f = startupIntentFixture('create', attempt => { if (attempt === 1) throw new ControlRecordError('CONTROL_STORAGE_BUSY'); },
    { retryDelay: () => delay.promise });
  try {
    f.start();
    await turn();
    assert.deepEqual(f.delays, [1000]);
    const checks = Promise.all([f.coordinator().recheck(), f.coordinator().recheck()]);
    await turn();
    assert.equal(f.coordinator().report().coreReady, true);
    delay.resolve();
    await checks;
    await f.settle();
    assert.equal(f.creates(), 2);
    assertSingleStartup(f);
  } finally { delay.resolve(); await f.ctx.dispose(); }
});

test('exhausted startup intent reads remain recoverable through the registered secured compatibility gateway', async () => {
  let locked = true;
  const Gateway = createCompatibilityGateway({
    Service: class {
      constructor(child, key) { this.ctx = child; child.provide(key, this); }
    },
    RemoteError: class extends Error {
      constructor(code, message) { super(message); this.code = code; }
    },
  });
  const f = startupIntentFixture('read', () => { if (locked) throw new ControlRecordError('CONTROL_STORAGE_BUSY'); }, {
    overrides: { compatibilityService: { name: 'compatibility-gateway', apply(child) { new Gateway(child); } } },
  });
  try {
    f.start();
    await f.settle();
    const remote = f.ctx.get('grokSearchCompatibilityRemote');
    assert.equal(typeof remote?.compatibilityReport, 'function', 'UI RPC must mount before the first successful ledger read');
    assert.equal(remote.typertRemote.service, remote);
    assert.equal(remote.typertRemote.serviceKey, 'grokSearchCompatibilityRemote');
    await assert.rejects(remote.compatibilityReport(), { code: 'SETTINGS_AUTH_REQUIRED' });
    await assert.rejects(remote.recheckCompatibility(), { code: 'SETTINGS_AUTH_REQUIRED' });
    remote.ctx.invocation = { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal };
    const before = await remote.compatibilityReport();
    assert.equal(before.phase, 'blocked');
    assert.equal(before.code, 'COMPATIBILITY_CORE_UNAVAILABLE');
    assert.equal(before.coreReady, false);
    await assert.rejects(remote.recheckCompatibility(), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
    assert.equal(f.attempts(), 3, 'unauthorized RPCs must not start another retry round');
    assert.equal(f.calls.includes('program'), false);
    assert.equal(f.calls.includes('control'), false);
    assert.equal(f.web.searchProviderId, 'author');
    locked = false;
    const request = { socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' }, headers: {} };
    const after = await f.ctx.waterfall('connection/request', request, null, () =>
      Promise.all([remote.recheckCompatibility(), remote.recheckCompatibility()]));
    await f.settle();
    assert.ok(after.every(report => report.coreReady));
    for (const [method, result] of [['compatibilityReport', before], ['recheckCompatibility', after[0]]]) {
      assert.equal(COMPATIBILITY_DESCRIPTORS.find(row => row.method === method).result.create().safeParse(result).success, true);
    }
    assert.equal(f.ctx.get('grokSearchCompatibilityRemote'), remote, 'recovery must not remount the root gateway');
    assert.deepEqual(f.delays, [1000, 3000]);
    assertSingleStartup(f);
  } finally { await f.ctx.dispose(); }
});

for (const completed of [false, true]) test(`startup intent retry respects a released record with completion=${completed}`, async () => {
  const f = startupIntentFixture('read', attempt => { if (attempt === 1) throw new ControlRecordError('CONTROL_STORAGE_BUSY'); },
    { initialRecord: { intent: { policy: 'released', release: { kind: 'intent-release-commit' },
      releaseCompletion: completed ? { routeVerified: true } : null } } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.calls.filter(value => value === 'recovery').length, 1);
    assert.equal(f.calls.includes('program'), false);
    assert.equal(f.coordinator().report().code, 'COMPATIBILITY_STOPPED');
    assert.equal(f.web.searchProviderId, 'author');
    await assert.rejects(f.coordinator().recheck(), { code: 'COMPATIBILITY_STOPPED' });
  } finally { await f.ctx.dispose(); }
});

test('startup intent and subsequent core failures share the same two automatic retries', async () => {
  const f = startupIntentFixture('create', attempt => { if (attempt === 1) throw new ControlRecordError('CONTROL_STORAGE_BUSY'); },
    { overrides: { core: new Error('temporary module resolution failure') } });
  try {
    f.start();
    await f.settle();
    assert.deepEqual(f.delays, [1000, 3000]);
    assert.equal(f.calls.filter(value => value === 'load:core').length, 2);
    assert.equal(f.coordinator().report().code, 'COMPATIBILITY_CORE_UNAVAILABLE');
    assert.equal(f.web.searchProviderId, 'author');
  } finally { await f.ctx.dispose(); }
});

for (const action of ['stop', 'dispose']) test(`startup intent retry cannot mount after ${action}`, async () => {
  const delay = deferred();
  const f = startupIntentFixture('create', attempt => { if (attempt === 1) throw new ControlRecordError('CONTROL_STORAGE_BUSY'); },
    { retryDelay: () => delay.promise });
  try {
    f.start();
    const coordinator = f.coordinator(), bootstrap = f.ctx.get('grokSearchBootstrap');
    await turn();
    assert.deepEqual(f.delays, [1000]);
    if (action === 'stop') coordinator.stop();
    else await f.ctx.dispose();
    await assert.rejects(coordinator.recheck(), { code: 'COMPATIBILITY_STOPPED' });
    delay.resolve();
    await bootstrap.settled();
    assert.equal(f.creates(), 1);
    assert.deepEqual(f.calls, ['load:settings', 'load:compatibilityService', 'settings']);
    assert.equal(coordinator.report().phase, 'stopped');
    assert.equal(f.web.searchProviderId, 'author');
  } finally { delay.resolve(); await f.ctx.dispose(); }
});

test('a permanent startup intent fault stays blocked across status changes and manual recheck', async () => {
  const f = startupIntentFixture('read', attempt => { if (attempt === 1) throw new ControlRecordError('CONTROL_RECORD_INVALID'); });
  try {
    f.start();
    await f.settle();
    const recheck = f.coordinator().recheck();
    await f.ctx.parallel('internal/status');
    await f.settle();
    assert.equal(f.coordinator().report().phase, 'blocked');
    assert.equal((await recheck).coreReady, false);
    assert.equal((await f.coordinator().start()).phase, 'blocked');
    assert.equal(f.attempts(), 1);
    assert.deepEqual(f.delays, []);
    assert.deepEqual(f.calls, ['load:settings', 'load:compatibilityService', 'settings']);
  } finally { await f.ctx.dispose(); }
});

test('transient bootstrap failures retry twice, then report a neutral block; manual recheck starts a fresh round', async () => {
  const delays = [];
  const retryPhases = [];
  let imports = 0;
  let f;
  f = bootstrapFixture({ hostVersion: '0.4.0-beta.1', retryDelay: async ms => {
    delays.push(ms);
    retryPhases.push(f.coordinator().report().phase);
  },
    overrides: { core: () => { imports++; throw new Error('temporary module resolution failure'); } } });
  try {
    f.start();
    await f.settle();
    assert.deepEqual(delays, [1000, 3000]);
    assert.deepEqual(retryPhases, ['checking', 'checking'], 'transient retries do not flash a blocked compatibility state');
    assert.equal(imports, 3);
    assert.equal(f.coordinator().report().phase, 'blocked');
    assert.equal(f.coordinator().report().code, 'COMPATIBILITY_CORE_UNAVAILABLE');
    assert.equal(f.coordinator().report().minimumAdmitted, true);
    assert.equal(f.coordinator().report().hostVersion, '0.4.0-beta.1');
    assert.equal(f.web.searchProviderId, 'author');
    await f.coordinator().recheck();
    await f.settle();
    assert.deepEqual(delays, [1000, 3000, 1000, 3000]);
    assert.equal(imports, 6);
    assert.equal(f.coordinator().report().code, 'COMPATIBILITY_CORE_UNAVAILABLE');
    assert.equal(f.web.searchProviderId, 'author');
  } finally { await f.ctx.dispose(); }
});

test('pending settings and lifecycle retries do not delay a failed core recovering on recheck', async t => {
  for (const retry of ['compatibility', 'root']) for (const optional of ['settings', 'lifecycle']) await t.test(`${retry}: ${optional}`, async () => {
    const release = deferred();
    let repaired = false, coreLoads = 0, optionalAttempts = 0, optionalReady = false, recheckDone = false, recheck;
    const settings = { name: 'settings', apply(child) {
      optionalReady = true;
      child.provide('grokSearchSettings', { snapshot() {} });
    } };
    const pendingOptional = optional === 'settings' ? {
      settings: () => {
        if (++optionalAttempts === 1) throw new Error('temporary settings import failure');
        return release.promise;
      },
    } : {
      recovery: { name: 'recovery', apply(child) {
        child.provide('grokSearchRecovery', { retry: async () => {
          if (++optionalAttempts === 1) throw new Error('temporary recovery initialization failure');
          await release.promise;
          optionalReady = true;
        } });
      } },
    };
    const f = bootstrapFixture({ overrides: {
      ...pendingOptional,
      core: () => {
        coreLoads++;
        if (!repaired) throw new Error('temporary core import failure');
        return { name: 'core', apply(child) {
          child.provide('grokSearchCore', { dispose: async () => {} });
        } };
      },
    } });
    try {
      f.start();
      await f.settle();
      assert.equal(f.coordinator().report().coreReady, false);
      assert.equal(f.coordinator().report().code, 'COMPATIBILITY_CORE_UNAVAILABLE');
      assert.equal(coreLoads, 3);
      assert.equal(optionalAttempts, 1);
      const blockedEpoch = f.coordinator().captureEpoch();
      repaired = true;
      recheck = retry === 'root' ? f.ctx.get('grokSearchBootstrap').retryControlRelease() : f.coordinator().recheck();
      recheck.then(() => { recheckDone = true; }, () => {});
      await turn();
      assert.equal(optionalAttempts, 2, 'the optional retry must have entered its unresolved work');
      assert.equal(optionalReady, false);
      if (optional === 'settings') assert.equal(f.ctx.get('grokSearchSettings'), undefined);
      assert.equal(f.coordinator().report().coreReady, true, 'core must recover before the optional work resolves');
      assert.equal(recheckDone, true, 'recheck must not await settings load or recovery retry');
      assert.notEqual(f.coordinator().captureEpoch(), blockedEpoch);
      assert.equal(f.web.searchProviderId, 'grok-search');
      assert.equal(coreLoads, 4);
      assert.equal(f.calls.filter(call => call === 'program').length, 1);
      assert.equal(f.contractCheckCalls(), 0);
      const core = f.service('grokSearchCore'), epoch = f.coordinator().captureEpoch();
      release.resolve(settings);
      await recheck;
      await f.settle();
      assert.equal(optionalReady, true);
      assert.equal(f.service('grokSearchCore'), core);
      assert.equal(f.coordinator().captureEpoch(), epoch);
      assert.equal(f.coordinator().report().coreReady, true);
      assert.equal(optionalAttempts, 2);
    } finally {
      release.resolve(settings);
      await recheck?.catch(() => {});
      await f.ctx.dispose();
    }
  });
});

test('a transient core import failure recovers without ever entering a blocked compatibility state', async () => {
  let failures = 1;
  const f = bootstrapFixture({ retryDelay: async () => {}, overrides: {
    core: () => {
      if (failures-- > 0) throw new Error('temporary module resolution failure');
      return { name: 'core', apply(child) { child.provide('grokSearchCore', { dispose: async () => {} }); } };
    },
  } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().phase, 'ready');
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.calls.filter(call => call === 'program').length, 1);
    assert.equal(f.web.searchProviderId, 'grok-search');
  } finally { await f.ctx.dispose(); }
});

test('compatibility metadata storage failures do not block a valid core search runtime', async () => {
  const f = bootstrapFixture({ stateFactory: () => { throw new Error('metadata storage unavailable'); } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().report().phase, 'ready');
    assert.equal(f.web.searchProviderId, 'grok-search');
  } finally { await f.ctx.dispose(); }
});

test('startup and manual recheck ignore a throwing probe and preserve the working core search route', async () => {
  const f = bootstrapFixture({ contractChecks: () => { throw new Error('A runtime probe must never run'); } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    const core = f.service('grokSearchCore'), epoch = f.coordinator().captureEpoch();
    await f.coordinator().recheck();
    assert.equal(f.contractCheckCalls(), 0);
    assert.equal(f.service('grokSearchCore'), core);
    assert.equal(f.coordinator().captureEpoch(), epoch);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().report().phase, 'ready');
    let dispatched = false;
    f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { dispatched = true; });
    assert.equal(dispatched, true);
    assert.equal(f.web.searchProviderId, 'grok-search');
  } finally { await f.ctx.dispose(); }
});

test('preference read failures never override the stored choice by enabling Grok', async () => {
  let preferences;
  const f = bootstrapFixture({ preferencesFactory: () => { throw new Error('preferences temporarily unreadable'); },
    overrides: { core: { name: 'core', apply(child) {
      preferences = child.get('grokSearchPreferences').snapshot().value;
      child.provide('grokSearchCore', { dispose: async () => {} });
    } } } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(preferences.grokEnabled, false);
    assert.equal(preferences.githubEnabled, false);
  } finally { await f.ctx.dispose(); }
});

test('host version admission keeps the hard minimum without an active compatibility probe', async t => {
  for (const hostVersion of [null, 'not-a-semver', '0.2.1-rc.1']) await t.test(String(hostVersion), async () => {
    const f = bootstrapFixture({ hostVersion });
    try {
      f.start();
      await f.settle();
      const current = f.coordinator().report();
      const belowMinimum = hostVersion === '0.2.1-rc.1';
      assert.equal(current.hostVersion, belowMinimum ? hostVersion : null);
      assert.equal(current.minimumAdmitted, !belowMinimum);
      assert.equal(current.confirmationRequired, false);
      assert.equal(current.coreReady, !belowMinimum);
      assert.equal(current.optionalFeatures.settings.available, true);
      assert.equal(f.contractCheckCalls(), 0);
      assert.equal(f.web.searchProviderId, belowMinimum ? 'author' : 'grok-search');
      if (belowMinimum) {
        assert.equal(current.code, 'COMPATIBILITY_MINIMUM_REQUIRED');
        assert.equal(f.calls.includes('load:program'), false);
        assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' },
          () => assert.fail('A host below the minimum must not dispatch search')),
        { code: 'COMPATIBILITY_MINIMUM_REQUIRED' });
      }
    } finally { await f.ctx.dispose(); }
  });
});

test('a schema-free config hook protects startup but an actual route update failure never authorizes search', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-route-update-'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
  const store = createControlIntentStore({ directory: join(directory, 'control-intent.records'),
    trustedRoot: directory, governance: true, autoMaintain: false });
  const f = bootstrapFixture({ ready: false, storeFactory: () => ({ ...store, startMaintenance() {} }),
    overrides: { control: { name: 'control', apply: applyControl } } });
  f.ctx.profileContext.dir = directory;
  let updates = 0;
  f.entry.update = async ({ config }) => {
    updates++;
    assert.equal(config.searchProvider, 'grok-search');
    assert.equal(config.fetchProvider, 'fetch');
    throw Object.assign(new Error('host cannot apply this route'), { code: 'CONTROL_ROUTE_UPDATE_FAILED' });
  };
  let bootstrap;
  try {
    f.start();
    bootstrap = f.ctx.get('grokSearchBootstrap');
    f.webFiber.runtime.Config = null;
    const resolved = f.webFiber.resolveConfig({ searchProvider: 'author', fetchProvider: 'fetch' });
    assert.equal(selectedId(resolved.searchProvider), 'grok-search');
    assert.equal(selectedId(resolved.fetchProvider), 'fetch');
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' },
      () => assert.fail('A route config hook alone must not authorize search')),
    error => error.code.startsWith('COMPATIBILITY_'));
    f.activateHost();
    await f.settle();
    assert.ok(updates > 0, 'the real controller must attempt the host route update');
    assert.equal(f.coordinator().report().coreReady, false);
    assert.equal(f.coordinator().report().phase, 'blocked');
    assert.equal(f.web.searchProviderId, 'author');
    assert.equal(f.web.fetchProviderId, 'fetch');
    assert.equal(f.entry.options.config.searchProvider, 'author');
    assert.equal(store.read().intent.policy, 'required');
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' },
      () => assert.fail('A failed route update must not dispatch to the author provider')),
    { code: f.coordinator().report().code });
    assert.equal(f.contractCheckCalls(), 0);
  } finally { await f.ctx.dispose(); await bootstrap?.settled(); }
});

test('a pending historical release runs recovery without automatically acquiring a new route', async () => {
  const f = bootstrapFixture({ initialRecord: { intent: { policy: 'released', release: { kind: 'intent-release-commit' } } } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.calls.includes('recovery'), true);
    assert.equal(f.calls.includes('program'), false);
    assert.equal(f.coordinator().report().coreReady, false);
  } finally { await f.ctx.dispose(); }
});

test('bootstrap never becomes ready from a takeover superseded by author selection or committed intent', async t => {
  for (const change of ['author', 'release', 'pause']) await t.test(change, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-takeover-intent-'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
    const store = createControlIntentStore({ directory: join(directory, 'control-intent.records'),
      trustedRoot: directory, governance: true, autoMaintain: false });
    const f = bootstrapFixture({ storeFactory: () => ({ ...store, startMaintenance() {} }),
      overrides: { control: { name: 'control', async apply(child, configuration) {
        await applyControl(child, configuration);
        // This synthetic host does not await inject callbacks; join the real pending acquisition.
        await child.get('grokSearchControl').retry().catch(() => {});
      } } } });
    f.ctx.profileContext.dir = directory;
    const applied = deferred(), finish = deferred();
    f.entry.update = async ({ config }) => {
      f.entry.options.config = structuredClone(config);
      f.webFiber.config = structuredClone(config);
      f.webFiber.rawConfig = f.webFiber.config;
      f.webFiber.effectiveConfig = f.webFiber.resolveConfig(config);
      f.web.config = f.webFiber.effectiveConfig;
      f.web.searchProviderId = selectedId(f.webFiber.effectiveConfig.searchProvider);
      f.web.fetchProviderId = selectedId(f.webFiber.effectiveConfig.fetchProvider);
      applied.resolve();
      await finish.promise;
    };
    try {
      f.start();
      await applied.promise;
      const acquired = store.read();
      let expected = acquired;
      if (change === 'author') f.entry.options.config = { ...f.entry.options.config, searchProvider: 'new-author' };
      else expected = store.compareAndSwap({ expectedRevision: acquired.revision, intent: change === 'pause'
          ? { ...acquired.intent, pause: { confirmed: true, reason: 'concurrent-pause' } }
          : { ...acquired.intent, policy: 'released', reason: 'concurrent-explicit-release',
            priorIntent: acquired.intent, release: { explicit: true, committedAt: new Date().toISOString(),
              kind: 'intent-release-commit', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', counterBaseline: 0 } } });
      finish.resolve();
      await f.settle();
      assert.equal(f.ctx.get('grokSearchControl')?.snapshot().phase, 'incomplete');
      assert.equal(f.coordinator().report().coreReady, false);
      let dispatched = false;
      assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { dispatched = true; }));
      assert.equal(dispatched, false, 'a late host callback cannot authorize search over the newer user intent');
      assert.deepEqual(store.read(), expected);
      assert.equal(f.web.fetchProviderId, 'fetch');
    } finally { finish.resolve(); await f.ctx.dispose(); }
  });
});

test('an absent host service and missing version never impose an experimental consent gate', async () => {
  const f = bootstrapFixture({ ready: false, hostVersion: null });
  try {
    assert.equal(f.start(), undefined);
    await f.settle();
    assert.equal(f.calls.includes('program'), false);
    f.activateHost();
    await f.settle();
    assert.equal(f.calls.includes('recovery'), true);
    assert.equal(f.calls.includes('program'), true, 'a missing version does not block successful capability checks');
    assert.equal(f.coordinator().report().confirmationRequired, false);
    assert.equal(f.coordinator().report().coreReady, true);
  } finally { await f.ctx.dispose(); }
});

test('same-root explicit stop and start create a fresh owner without requiring metadata confirmation', async () => {
  const f = bootstrapFixture({ hostVersion: '0.4.0-beta.1' });
  try {
    f.start();
    await f.settle();
    const before = f.coordinator().captureEpoch();
    await f.service('grokSearchControl').stop();
    assert.equal(f.coordinator().report().coreReady, false);
    assert.equal(f.web.searchProviderId, 'author');
    await f.service('grokSearchControl').start();
    await f.settle();
    assert.notEqual(f.coordinator().captureEpoch(), before);
    assert.equal(f.coordinator().report().confirmed, false);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.calls.filter(call => call === 'program').length, 2);
  } finally { await f.ctx.dispose(); }
});

test('a later explicit stop cancels a pending start and a newer start can still run', { timeout: 10_000 }, async t => {
  for (const restartWhilePending of [false, true]) await t.test(
    restartWhilePending ? 'restart before stale start settles' : 'restart after stale start settles', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-start-stop-'));
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
      const store = createControlIntentStore({ directory: join(directory, 'control-intent.records'),
        trustedRoot: directory, governance: true, autoMaintain: false });
      const draining = deferred(), drained = deferred();
      let mounts = 0, pendingStart, pendingStop, nextStart;
      const f = bootstrapFixture({ storeFactory: () => ({ ...store, startMaintenance() {} }), overrides: {
        control: { name: 'control', apply: applyControl },
        routeVerifier: { name: 'verifier', apply: applyRouteVerifier },
        core: { name: 'core', apply(child) {
          const first = ++mounts === 1;
          child.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {
            if (first) { draining.resolve(); await drained.promise; }
          } });
        } },
      } });
      f.ctx.profileContext.dir = directory;
      f.entry.update = async ({ config }) => {
        f.entry.options.config = structuredClone(config);
        f.webFiber.config = structuredClone(config);
        f.webFiber.rawConfig = f.webFiber.config;
        f.webFiber.effectiveConfig = f.webFiber.resolveConfig(config);
        f.web.config = f.webFiber.effectiveConfig;
        f.web.searchProviderId = selectedId(f.webFiber.effectiveConfig.searchProvider);
        f.web.fetchProviderId = selectedId(f.webFiber.effectiveConfig.fetchProvider);
      };
      try {
        f.start();
        await f.settle();
        const owner = f.service('grokSearchControl');
        assert.equal(f.coordinator().report().coreReady, true);
        f.coordinator().block('COMPATIBILITY_CORE_UNAVAILABLE');
        await draining.promise;
        pendingStart = owner.start();
        const startOutcome = pendingStart.then(() => ({ status: 'fulfilled' }),
          error => ({ status: 'rejected', code: error.code }));
        await turn();
        assert.equal(mounts, 1, 'the old start must still be waiting for its generation to drain');
        pendingStop = owner.stop('later-explicit-stop');
        if (restartWhilePending) {
          nextStart = f.coordinator().start();
          nextStart.catch(() => {});
          assert.notEqual(nextStart, pendingStart, 'a new start must not reuse the invalidated pending one');
        }
        drained.resolve();
        assert.equal((await pendingStop).kind, 'released');
        const stale = await startOutcome;
        await f.settle();
        if (!restartWhilePending) {
          assert.equal(f.coordinator().report().coreReady, false, 'the later stop must keep search stopped');
          assert.equal(f.web.searchProviderId, 'author');
          assert.equal(store.read().intent.policy, 'released');
          assert.equal(mounts, 1);
        }
        assert.deepEqual(stale, { status: 'rejected', code: 'COMPATIBILITY_STOPPED' });
        nextStart ??= f.coordinator().start();
        await nextStart;
        await f.settle();
        assert.equal(f.coordinator().report().coreReady, true);
        assert.equal(f.web.searchProviderId, 'grok-search');
        assert.equal(store.read().intent.policy, 'required');
        assert.equal(mounts, 2);
        const nextOwner = f.service('grokSearchControl');
        assert.notEqual(nextOwner, owner);
        assert.equal((await nextOwner.stop('completed-stop-before-restart')).kind, 'released');
        await nextOwner.start();
        await f.settle();
        assert.equal(f.coordinator().report().coreReady, true, 'internal retryRelease must not cancel the new start');
        assert.equal(f.web.searchProviderId, 'grok-search');
        assert.equal(store.read().intent.policy, 'required');
        assert.equal(mounts, 3);
      } finally {
        drained.resolve();
        await Promise.allSettled([pendingStart, pendingStop, nextStart]);
        await f.ctx.dispose();
      }
    });
});

test('revoked runtime authority keeps the release owner reachable and a fresh explicit start rechecks', async () => {
  const f = bootstrapFixture();
  try {
    f.start();
    await f.settle();
    const owner = f.service('grokSearchControl');
    f.coordinator().block('COMPATIBILITY_CONTRACT_FAILED');
    await f.settle();
    assert.equal(f.service('grokSearchControl'), owner);
    assert.equal(f.coordinator().report().coreReady, false);
    assert.equal(f.store.read().intent.policy, 'required');
    assert.equal(f.web.searchProviderId, 'grok-search');
    await owner.stop();
    await owner.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.calls.filter(call => call === 'program').length, 2);
  } finally { await f.ctx.dispose(); }
});

test('legacy consent revocation and state corruption do not disable a compatible running root', async t => {
  for (const stateError of [null, 'COMPATIBILITY_STATE_INVALID']) await t.test(stateError ?? 'revoked', async () => {
    const f = bootstrapFixture({ hostVersion: '0.4.0-beta.1' });
    let officialCalls = 0;
    const execute = () => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => {
      if (f.web.searchProviderId !== 'grok-search') officialCalls++;
      return true;
    });
    try {
      f.start();
      await f.settle();
      const epoch = f.coordinator().captureEpoch(), owner = f.service('grokSearchControl');
      f.loseConfirmation(stateError);
      await f.settle();
      assert.equal(f.coordinator().report().coreReady, true);
      assert.equal(f.service('grokSearchControl'), owner, 'legacy metadata changes do not replace the search owner');
      assert.equal(f.store.read().intent.policy, 'required');
      assert.equal(f.web.searchProviderId, 'grok-search');
      assert.equal(execute(), true);
      assert.equal(f.coordinator().captureEpoch(), epoch);
      assert.equal(f.service('grokSearchControl'), owner);
      assert.equal(f.calls.filter(call => call === 'program').length, 1);
      assert.equal(f.store.read().intent.policy, 'required');
      assert.equal(officialCalls, 0);
    } finally { await f.ctx.dispose(); }
  });
});

test('a fresh capability epoch waits for retirement and an explicit release wins before the old owner is disposed', async t => {
  for (const stopDuringDrain of [false, true]) await t.test(stopDuringDrain ? 'explicit release' : 're-confirm only', async () => {
    const draining = deferred(), drained = deferred();
    let cores = 0, pendingStop;
    const f = bootstrapFixture({ hostVersion: '0.4.0-beta.1', overrides: {
      core: { name: 'core', apply(child) {
        const first = ++cores === 1;
        child.provide('grokSearchCore', { dispose: async () => {
          if (first) { draining.resolve(); await drained.promise; }
        } });
      } },
    } });
    try {
      f.start();
      await f.settle();
      const owner = f.service('grokSearchControl');
      f.coordinator().beginEpoch();
      await draining.promise;
      await turn();
      assert.equal(f.coordinator().report().coreReady, false);
      assert.equal(f.service('grokSearchControl'), owner);
      assert.equal(f.calls.filter(call => call === 'program').length, 1);
      assert.equal(f.store.read().intent.policy, 'required');
      if (stopDuringDrain) {
        pendingStop = owner.stop();
        await turn();
        assert.equal(f.service('grokSearchControl'), owner);
        assert.equal(f.store.read().intent.policy, 'required');
      }
      drained.resolve();
      if (pendingStop) await pendingStop;
      await f.settle();
      if (stopDuringDrain) {
        assert.equal(f.service('grokSearchControl'), owner);
        assert.equal(f.calls.filter(call => call === 'program').length, 1);
        assert.equal(f.store.read().intent.policy, 'released');
        assert.equal(f.coordinator().report().coreReady, false, 'a recheck is not an explicit user start');
        assert.equal(f.service('grokSearchControl'), owner);
      } else {
        assert.equal(f.coordinator().report().coreReady, true, JSON.stringify({ report: f.coordinator().report(), calls: f.calls }));
        assert.notEqual(f.service('grokSearchControl'), owner);
        assert.equal(f.calls.filter(call => call === 'program').length, 2);
        assert.equal(f.store.read().intent.policy, 'required');
        assert.equal(f.web.searchProviderId, 'grok-search');
      }
    } finally { drained.resolve(); await pendingStop; await f.ctx.dispose(); }
  });
});

test('web detach drains and rebuilds the core while optional tools detach preserves its generation', async () => {
  for (const missing of [['web'], ['tools'], ['web', 'tools']]) {
    const f = bootstrapFixture();
    try {
      f.start();
      await f.settle();
      const oldEpoch = f.coordinator().captureEpoch(), owner = f.service('grokSearchControl');
      const required = f.store.read();
      await f.deactivateHost(missing);
      await f.settle();
      const coreDetached = missing.includes('web');
      assert.equal(f.coordinator().report().coreReady, !coreDetached);
      assert.deepEqual(f.store.read(), required, 'dependency loss must not release persistent intent');
      if (coreDetached) {
        assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => true),
          error => error.code.startsWith('COMPATIBILITY_'));
      } else {
        assert.equal(f.coordinator().captureEpoch(), oldEpoch);
        assert.equal(f.service('grokSearchControl'), owner);
      }
      f.activateHost();
      await f.settle();
      assert.equal(f.coordinator().report().coreReady, true, `services ${missing.join(',')} should rebuild`);
      if (coreDetached) {
        assert.notEqual(f.coordinator().captureEpoch(), oldEpoch);
        assert.notEqual(f.service('grokSearchControl'), owner);
      } else {
        assert.equal(f.coordinator().captureEpoch(), oldEpoch);
        assert.equal(f.service('grokSearchControl'), owner);
      }
      assert.equal(f.calls.filter(call => call === 'program').length, coreDetached ? 2 : 1);
    } finally { await f.ctx.dispose(); }
  }
});

test('reprovided services cannot start another program before the detached generation drains', async () => {
  const draining = deferred(), release = deferred();
  let cores = 0;
  const f = bootstrapFixture({ overrides: {
    core: { name: 'core', apply(child) {
      const first = ++cores === 1;
      child.provide('grokSearchCore', { dispose: async () => {
        if (first) { draining.resolve(); await release.promise; }
      } });
    } },
  } });
  let detached;
  try {
    f.start();
    await f.settle();
    detached = f.deactivateHost(['web']);
    await draining.promise;
    f.activateHost();
    await turn();
    assert.equal(f.calls.filter(call => call === 'program').length, 1);
    assert.equal(f.coordinator().report().coreReady, false);
    release.resolve();
    await detached;
    await f.settle();
    assert.equal(f.calls.filter(call => call === 'program').length, 2);
    assert.equal(f.coordinator().report().coreReady, true);
  } finally { release.resolve(); await detached; await f.ctx.dispose(); }
});

test('a detached generation resumes only after its failed resource proves exit', async t => {
  for (const change of ['none', 'pause', 'dispose']) await t.test(change, async () => {
    const exited = deferred();
    let cores = 0, disposals = 0;
    const f = bootstrapFixture({ overrides: {
      core: { name: 'core', apply(child) {
        const first = ++cores === 1;
        child.provide('grokSearchCore', { dispose() {
          disposals++;
          if (!first) return Promise.resolve();
          const error = Object.assign(new Error('The detached resource has not exited.'), { code: 'GROK_PROCESS_REAP_FAILED' });
          Object.defineProperty(error, 'whenExited', { value: exited.promise });
          return Promise.reject(error);
        } });
      } },
    } });
    try {
      f.start();
      await f.settle();
      const bootstrap = f.ctx.get('grokSearchBootstrap'), compatibility = f.coordinator();
      const required = f.store.read();
      await assert.rejects(f.deactivateHost(['web']), { code: 'GROK_PROCESS_REAP_FAILED' });
      f.activateHost();
      await f.settle();
      assert.equal(cores, 1, 'reprovided web cannot overlap a resource awaiting exit');
      assert.equal(f.coordinator().report().coreReady, false);
      assert.deepEqual(f.store.read(), required, 'dependency loss does not release control intent');
      if (change === 'pause') await assert.rejects(f.coordinator().start(), { code: 'GROK_PROCESS_REAP_FAILED' });
      if (change === 'dispose') await assert.rejects(f.ctx.dispose(), { code: 'GROK_PROCESS_REAP_FAILED' });
      exited.resolve();
      await turn();
      await bootstrap.settled();
      if (change === 'none') {
        assert.equal(compatibility.report().coreReady, true, 'confirmed exit must retire the rejected detach promise');
        assert.equal(cores, 2);
        assert.equal(disposals, 1, 'the exited predecessor is not disposed again');
      } else {
        assert.equal(compatibility.report().coreReady, false);
        assert.equal(cores, 1, 'late exit cannot activate a paused or destroyed root');
        if (change === 'pause') {
          await compatibility.start();
          await bootstrap.settled();
          assert.equal(compatibility.report().coreReady, true);
          assert.equal(cores, 2, 'a later explicit start may replace the exited predecessor');
          assert.equal(disposals, 1);
        }
      }
    } finally { exited.resolve(); await turn(); await f.ctx.dispose(); }
  });
});

test('optional timeout restoration failure does not block retiring and replacing a search generation', async () => {
  const f = bootstrapFixture();
  let updates = 0;
  const runtime = { name: 'tool-web', fibers: new Set() };
  const author = { search: true, searchTimeoutMs: 10_000, fetchTimeoutMs: 15_000 };
  const fiber = { uid: 950, state: 2, runtime, config: { ...author },
    entry: { options: { name: '@deepseek-ai/dsh-tool-web', config: { ...author } } },
    async update(value) {
      if (++updates > 1) throw Object.assign(new Error('optional budget unavailable'), { code: 'TEST_BUDGET_RELEASE' });
      this.config = f.ctx.waterfall(this, 'internal/config', value, () => value);
    },
    async await() {},
  };
  runtime.fibers.add(fiber);
  try {
    f.start();
    await f.settle();
    const owner = f.service('grokSearchControl');
    for (const scope of f.scopes) scope.registry.set('tool-web', runtime);
    await f.ctx.get('grokSearchBudgets').acquire();
    assert.equal(f.ctx.get('grokSearchBudgets').snapshot().owned, 1);
    f.coordinator().beginEpoch();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.notEqual(f.service('grokSearchControl'), owner);
    assert.equal(f.calls.filter(call => call === 'program').length, 2);
  } finally { await f.ctx.dispose(); }
});

test('a failed optional GitHub invalidation still drains the core and allows explicit stop', async () => {
  const f = bootstrapFixture({ githubEnabled: true, overrides: {
    github: { createGithubIntegration: () => ({
      invalidate() { throw new Error('optional GitHub invalidation failed'); }, sync() {},
      snapshot: () => ({ enabled: true, registered: true, error: null }),
    }) },
  } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    const outcome = await f.service('grokSearchControl').stop();
    assert.equal(outcome.kind, 'released');
    assert.ok(f.calls.includes('core-dispose'));
    assert.equal(f.web.searchProviderId, 'author');
  } finally { await f.ctx.dispose(); }
});

test('enabled GitHub intent survives revoked capabilities and runtime disposal without original fetch fallback', async () => {
  const nextCore = deferred();
  nextCore.promise.catch(() => {});
  let coreLoads = 0, upstreamCalls = 0, githubState;
  const f = bootstrapFixture({ githubEnabled: true, overrides: {
    github: { createGithubIntegration(options) {
      githubState = options.getState;
      return createGithubIntegration({ ...options, readerOptions: {
        fetchImpl: async () => { upstreamCalls++; throw new Error('no upstream requests expected'); },
      } });
    } },
    core: () => {
      if (++coreLoads > 1) return nextCore.promise;
      return { name: 'core', apply(child) { child.provide('grokSearchCore', { dispose: async () => {} }); } };
    },
  } });
  let originalFetches = 0;
  const request = { name: 'web_fetch', arguments: { url: 'https://github.com/example/project/issues/1' },
    callId: 'github-blocked', signal: new AbortController().signal, agent: { session: { id: 'session' } } };
  const execute = args => f.ctx.waterfall('tools/execute', args, () => { originalFetches++; return {}; });
  const denied = () => assert.rejects(async () => execute(request), error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
  try {
    f.start();
    await f.settle();
    f.coordinator().block('COMPATIBILITY_CONTRACT_FAILED');
    await f.settle();
    assert.equal(githubState().enabled, true, 'compatibility is not the user GitHub switch');
    await denied();
    await f.coordinator().start();
    await denied();
    nextCore.reject(new Error('replacement core failed'));
    await f.settle();
    await denied();
    execute({ ...request, arguments: { url: 'https://example.org/ordinary-page' } });
    assert.equal(originalFetches, 1, 'only unrelated URLs may use the original fetch');
    assert.equal(upstreamCalls, 0);
  } finally { nextCore.reject(new Error('test cleanup')); await f.ctx.dispose(); }
});

test('an unavailable optional GitHub module keeps enabled known URLs fail-closed without disabling ordinary fetch', async () => {
  const f = bootstrapFixture({ githubEnabled: true, overrides: { github: new Error('optional import unavailable') } });
  let originalFetches = 0;
  const exec = { name: 'web_fetch', arguments: { url: 'https://github.com/example/project/issues/1' } };
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    assert.throws(() => f.ctx.waterfall('tools/execute', exec, () => { originalFetches++; }),
      error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
    f.ctx.waterfall('tools/execute', { ...exec, arguments: { url: 'https://example.org/page' } },
      () => { originalFetches++; });
    assert.equal(originalFetches, 1);
  } finally { await f.ctx.dispose(); }
});

test('an admitted GitHub fetch cannot resume through the original provider after its generation is removed', async t => {
  for (const rebuild of [false, true]) await t.test(rebuild ? 'replacement ready' : 'dependencies absent', async () => {
    const entered = deferred(), resume = deferred();
    let originalFetches = 0, upstreamCalls = 0, pending;
    const f = bootstrapFixture({ githubEnabled: true,
      contractChecks: ctx => checkRuntimeContracts(ctx, { selection: () => ({ bundles: ['dsh-grok-search'] }) }),
      overrides: { github: { createGithubIntegration: options => createGithubIntegration({ ...options,
        readerOptions: { fetchImpl: async () => { upstreamCalls++; throw new Error('no upstream requests expected'); } },
      }) } },
    });
    const request = { name: 'web_fetch', arguments: { url: 'https://github.com/example/project/issues/1' },
      callId: 'github-waiting', signal: new AbortController().signal, agent: { session: { id: 'session' } } };
    const caller = { fiber: { uid: 910, runtime: { name: 'tool-web' }, config: { fetch: true },
      entry: { options: { name: '@deepseek-ai/dsh-tool-web' } } } };
    try {
      f.start();
      await f.settle();
      assert.equal(f.coordinator().report().coreReady, true);
      assert.equal(f.service('grokSearchGithub').snapshot().enabled, true);
      pending = f.ctx.waterfall('tools/execute', request, async () => {
        entered.resolve();
        await resume.promise;
        const web = f.ctx.waterfall('internal/get', caller, 'web', null,
          () => ({ fetch: async () => { originalFetches++; return {}; } }));
        return web.fetch({ url: request.arguments.url }, request.signal);
      });
      pending.catch(() => {});
      await entered.promise;
      await f.deactivateHost(['web']);
      if (rebuild) {
        f.activateHost();
        await f.settle();
        assert.equal(f.coordinator().report().coreReady, true);
      }
      resume.resolve();
      await assert.rejects(pending, error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
      assert.equal(originalFetches, 0);
      assert.equal(upstreamCalls, 0);
      assert.equal(f.store.read().intent.policy, 'required');
    } finally { resume.resolve(); await pending?.catch(() => {}); await f.ctx.dispose(); }
  });
});

test('the root GitHub epoch guard preserves admitted fetches and does not intercept recovery service access', async () => {
  let originalFetches = 0, upstreamCalls = 0;
  const f = bootstrapFixture({ githubEnabled: true,
    contractChecks: ctx => checkRuntimeContracts(ctx, { selection: () => ({ bundles: ['dsh-grok-search'] }) }),
    overrides: { github: { createGithubIntegration: options => createGithubIntegration({ ...options,
      readerOptions: { fetchImpl: async input => {
        upstreamCalls++;
        const body = new URL(input).pathname.endsWith('/comments') ? [] : {
          id: 1, title: 'Issue', body: 'fixture content', user: { login: 'fixture' }, updated_at: '2026-01-01T00:00:00Z',
        };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      } },
    }) } },
  });
  const request = { name: 'web_fetch', arguments: { url: 'https://github.com/example/project/issues/1' },
    callId: 'github-admitted', signal: new AbortController().signal, agent: { session: { id: 'session' } } };
  const original = { searchProviderId: 'author', fetch: async () => { originalFetches++; return {}; } };
  try {
    f.start();
    await f.settle();
    const tools = f.ctx.get('tools');
    tools.register({ name: 'web_fetch', timeoutMs: 30_000 });
    const caller = { tools, fiber: { uid: 910, runtime: { name: 'tool-web' }, config: { fetch: true },
      entry: { options: { name: '@deepseek-ai/dsh-tool-web' } } } };
    const result = await f.ctx.waterfall('tools/execute', request, () => {
      const web = f.ctx.waterfall('internal/get', caller, 'web', null, () => original);
      return web.fetch({ url: request.arguments.url }, request.signal);
    });
    assert.equal(result.statusCode, 200);
    assert.match(result.body.content, /fixture content/);
    assert.ok(upstreamCalls > 0);
    assert.equal(originalFetches, 0);
    await assert.rejects(f.ctx.waterfall('tools/execute', { ...request, callId: 'github-revoked' }, async () => {
      f.coordinator().block('COMPATIBILITY_CONTRACT_FAILED');
      const observed = f.ctx.waterfall('internal/get', f.ctx, 'web', null, () => original);
      assert.equal(observed.searchProviderId, original.searchProviderId,
        'recovery and control can still observe service state');
      await assert.rejects(observed.fetch({ url: request.arguments.url }, request.signal),
        error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
      assert.throws(() => f.ctx.waterfall('internal/get', caller, 'web', null, () => original),
        error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
    }), error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
    assert.equal(f.ctx.waterfall('internal/get', f.ctx, 'web', null, () => original), original,
      'service access outside the GitHub request is unchanged');
    assert.equal(originalFetches, 0);
  } finally { await f.ctx.dispose(); }
});

test('revocation and explicit pause cancel in-flight program preparation before a fresh instance can run', async () => {
  for (const reason of ['revoke', 'pause']) {
    const managers = [], gates = [], aborted = [];
    const f = bootstrapFixture({ overrides: {
      program: { name: 'program', apply(child, configuration) {
        const index = managers.length, gate = deferred();
        const manager = createProgramController({ configuration, directory: 'C:/synthetic-runtime', env: () => ({}),
          installer: {}, resolveProgram: ({ signal }) => {
            signal.addEventListener('abort', () => { aborted[index] = true; gate.reject(signal.reason); }, { once: true });
            return gate.promise;
          } });
        managers.push(manager); gates.push(gate);
        child.provide('grokSearchProgram', manager);
        child.effect(() => () => manager.dispose());
        void manager.prepare().catch(() => {});
      } },
    } });
    try {
      f.start();
      await f.settle();
      assert.equal(managers[0].snapshot().phase, 'discovering');
      if (reason === 'pause') await f.service('grokSearchControl').stop();
      else f.coordinator().block('COMPATIBILITY_CONTRACT_FAILED');
      await f.settle();
      assert.equal(aborted[0], true, `${reason} must cancel the preparation signal`);
      assert.equal(managers[0].snapshot().phase, 'disposed');
      assert.ok(f.service('grokSearchControl'), 'cancelling preparation must preserve the release owner');
      await f.coordinator().start();
      await f.settle();
      assert.equal(managers.length, 2);
      assert.equal(managers[1].snapshot().phase, 'discovering');
      gates[0].resolve({ path: 'stale', version: '0.0.0', source: 'configured' });
      assert.equal(managers[0].snapshot().phase, 'disposed');
    } finally { await f.ctx.dispose(); }
  }
});

test('a superseded import rejection cannot block the next explicit runtime generation', async () => {
  const gate = deferred();
  let attempts = 0;
  const f = bootstrapFixture({ overrides: { core: () => {
    if (++attempts === 1) return gate.promise;
    return { name: 'new-core', apply(child) { child.provide('grokSearchCore', { dispose: async () => {} }); } };
  } } });
  try {
    f.start();
    while (!f.calls.includes('load:core')) await turn();
    const oldEpoch = f.coordinator().captureEpoch();
    await f.coordinator().start();
    gate.reject(new Error('late old import failure'));
    await f.settle();
    assert.notEqual(f.coordinator().captureEpoch(), oldEpoch);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(attempts, 2);
  } finally { await f.ctx.dispose(); }
});

test('a late import after root destruction cannot start programs, acquire routes or reopen search', async () => {
  const gate = deferred();
  const f = bootstrapFixture({ overrides: { core: () => gate.promise } });
  f.start();
  while (!f.calls.includes('load:core')) await turn();
  const bootstrap = f.ctx.get('grokSearchBootstrap'), coordinator = f.coordinator();
  await f.ctx.dispose();
  gate.resolve({ name: 'late-core', apply() { throw new Error('late core must not run'); } });
  await bootstrap.settled();
  assert.equal(f.calls.includes('program'), false);
  assert.equal(coordinator.report().phase, 'stopped');
  assert.equal(f.web.searchProviderId, 'author');
});

test('Config preserves unknown fields, optional arguments and non-integer budget semantics', () => {
  const extra = { retained: true };
  const input = { executable: 'grok', executableArgs: ['arg', null, undefined], budgetMs: 30_000.5, extra };
  const result = validate(input).value;
  assert.deepEqual(result, { ...defaults, ...input });
  assert.equal(result.extra, extra);
  assert.notEqual(result.executableArgs, input.executableArgs);
  assert.equal(Number.isNaN(validate({ budgetMs: NaN }).value.budgetMs), true);
  assert.deepEqual(validate(Object.create({ inherited: extra })).value, { ...defaults, inherited: extra });
  for (const budgetMs of [30_000, 120_000]) assert.equal(validate({ budgetMs }).value.budgetMs, budgetMs);
});

test('Config reports invalid known fields without coercion or disclosing their values', () => {
  for (const [input, path] of [
    [[], []], ['private-input', []], [{ executable: 1 }, ['executable']],
    [{ configPath: false }, ['configPath']], [{ executableArgs: 'private-input' }, ['executableArgs']],
    [{ executableArgs: [1] }, ['executableArgs', 0]], [{ budgetMs: '120000' }, ['budgetMs']],
    [{ budgetMs: 29_999 }, ['budgetMs']], [{ budgetMs: Infinity }, ['budgetMs']],
  ]) {
    const result = validate(input);
    assert.deepEqual(result.issues[0].path, path);
    assert.equal(JSON.stringify(result).includes('private-input'), false);
  }
});

test('synchronous host config resolution rejects invalid protocols, promises and validation issues', () => {
  const input = { retained: true };
  assert.equal(resolveRuntimeConfig({}, input), input);
  for (const Config of [{}, { '~standard': { version: 2, validate: () => ({ value: input }) } },
    { '~standard': { version: 1, validate: () => Promise.resolve({ value: input }) } },
    { '~standard': { version: 1, validate: () => ({}) } }]) {
    assert.throws(() => resolveRuntimeConfig({ Config }, input), { code: 'COMPAT_CONFIG_SCHEMA_UNSUPPORTED' });
  }
  assert.throws(() => resolveRuntimeConfig({ Config }, { budgetMs: 'not-a-number' }),
    error => error.code === 'COMPAT_CONFIG_INVALID' && error[Symbol.for('ValidationError')] === true);
});

test('the cold config hook protects both known Cordis ABIs without a dynamic host import', () => {
  const entry = { options: { id: 'web', name: '@deepseek-ai/dsh-web' } };
  const raw = { searchProvider: 'author', fetchProvider: 'fetch' };
  const legacy = { entry, parent: { fiber: {} } };
  const hook = createSearchConfigHook({ required: () => true });
  assert.deepEqual(hook.call(legacy, raw, () => raw), { ...raw, searchProvider: 'grok-search' });
  let validations = 0;
  const modern = { ...legacy, resolveConfig() { throw new Error('recursive config hook'); },
    runtime: { Config: { '~standard': { version: 1, validate(candidate) {
      validations++;
      return { value: Object.fromEntries(Object.entries(candidate).map(([key, value]) => [key, { get: () => value }])) };
    } } } } };
  const resolved = hook(modern, () => raw);
  assert.equal(resolved.searchProvider.get(), 'grok-search');
  assert.equal(resolved.fetchProvider.get(), 'fetch');
  assert.equal(validations, 1);
  assert.deepEqual(raw, { searchProvider: 'author', fetchProvider: 'fetch' });
});

test('disabled GitHub read short-circuits getState without reading the control-intent store', async () => {
  let storeReads = 0;
  const baseRecord = { intent: { policy: 'required' } };
  const f = bootstrapFixture({
    githubEnabled: false,
    initialRecord: baseRecord,
    overrides: { github: { createGithubIntegration } },
    storeFactory: () => ({
      read: () => { storeReads++; return baseRecord; },
      startMaintenance: () => {},
    }),
  });
  try {
    f.start();
    await f.ctx.get('grokSearchBootstrap').settled();
    const github = f.service('grokSearchGithub');
    assert.ok(github);
    const readsAfterBoot = storeReads;
    github.sync();
    assert.deepEqual(github.snapshot(), { enabled: false, registered: false, error: null });
    assert.equal(storeReads, readsAfterBoot);
  } finally {
    await f.ctx.dispose();
  }
});

test('hot-reload control refresh window rejects overlapping web_search with COMPATIBILITY_CHECKING without blocking core', async () => {
  let refreshing = false;
  const f = bootstrapFixture({
    overrides: {
      control: {
        name: 'control',
        async apply(child, options) {
          if (!options.canAcquire()) throw new Error('unadmitted control');
          f.web.searchProviderId = 'grok-search';
          f.webFiber.effectiveConfig.searchProvider = { get: () => 'grok-search' };
          child.provide('grokSearchControl', {
            publicSnapshot: () => ({ phase: 'required' }),
            refreshing: () => refreshing,
            retryRelease: async () => {},
            start: options.onStart,
            async stop() { await options.onStop(); return { kind: 'released' }; },
          });
        },
      },
    },
  });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    // Simulate host hot-reload briefly resetting searchProvider while control.refresh() is actively re-acquiring.
    refreshing = true;
    f.web.searchProviderId = 'author';
    f.webFiber.effectiveConfig.searchProvider = { get: () => 'author' };
    let officialDispatched = false;
    assert.throws(
      () => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { officialDispatched = true; }),
      { code: 'COMPATIBILITY_CHECKING' },
    );
    assert.equal(officialDispatched, false);
    assert.equal(f.coordinator().report().coreReady, true, 'transient refresh window must not permanently block core');
    // Once refresh finishes re-acquiring grok-search, searches proceed normally without manual recheck.
    refreshing = false;
    f.web.searchProviderId = 'grok-search';
    f.webFiber.effectiveConfig.searchProvider = { get: () => 'grok-search' };
    let routedDispatched = false;
    f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { routedDispatched = true; });
    assert.equal(routedDispatched, true);
  } finally {
    await f.ctx.dispose();
  }
});

test('retriable control storage lock contention during initialize recovers within automatic retry budget', async () => {
  let attempts = 0;
  const delays = [];
  const f = bootstrapFixture({
    retryDelay: async ms => { delays.push(ms); },
    overrides: {
      control: {
        name: 'control',
        async apply(child, options) {
          attempts++;
          if (attempts === 1) {
            throw Object.assign(new Error('Control storage writer lock busy'), {
              code: 'CONTROL_STORAGE_BUSY',
              retriable: true,
            });
          }
          if (!options.canAcquire()) throw new Error('unadmitted control');
          f.web.searchProviderId = 'grok-search';
          f.webFiber.effectiveConfig.searchProvider = { get: () => 'grok-search' };
          child.provide('grokSearchControl', {
            publicSnapshot: () => ({ phase: 'required' }),
            refreshing: () => false,
            retryRelease: async () => {},
            start: options.onStart,
            async stop() { await options.onStop(); return { kind: 'released' }; },
          });
        },
      },
    },
  });
  try {
    f.start();
    await f.settle();
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [1000]);
    assert.equal(f.coordinator().report().coreReady, true);
    assert.equal(f.coordinator().report().phase, 'ready');
  } finally {
    await f.ctx.dispose();
  }
});

for (const reason of ['native-bundle-disable', 'native-component-disable', 'settings-ui-explicit-stop']) {
  for (const changedAuthor of [false, true]) test(`a generated incomplete ${reason} survives teardown with changedAuthor=${changedAuthor}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-pending-release-'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
    const store = createControlIntentStore({ directory: join(directory, 'control-intent.records'),
      trustedRoot: directory, governance: true, autoMaintain: false });
    let failRestore = true;
    const mount = () => {
      const f = bootstrapFixture({ storeFactory: () => ({ ...store, startMaintenance() {} }), overrides: {
        control: { name: 'control', apply: applyControl },
        recovery: { name: 'recovery', apply: applyRecovery },
        routeVerifier: { name: 'verifier', apply: applyRouteVerifier },
        core: { name: 'core', apply(child) {
          child.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
        } },
      } });
      f.ctx.profileContext.dir = directory;
      f.entry.update = async ({ config }) => {
        if (failRestore && config.searchProvider !== 'grok-search') {
          throw new ControlRecordError('CONTROL_ROUTE_UPDATE_FAILED');
        }
        f.entry.options.config = structuredClone(config);
        f.webFiber.config = structuredClone(config);
        f.webFiber.rawConfig = f.webFiber.config;
        f.webFiber.effectiveConfig = f.webFiber.resolveConfig(config);
        f.web.config = f.webFiber.effectiveConfig;
        f.web.searchProviderId = selectedId(f.webFiber.effectiveConfig.searchProvider);
        f.web.fetchProviderId = selectedId(f.webFiber.effectiveConfig.fetchProvider);
      };
      return f;
    };
    const first = mount();
    let second;
    try {
      first.start();
      await first.settle();
      const release = await first.service('grokSearchControl').stop(reason);
      assert.equal(release.completionCommitted, false, 'a real release transaction leaves the pending record');
      assert.equal(store.read().intent.policy, 'released');
      const originalOperation = store.read().intent.release.operationId;
      await first.ctx.dispose();
      failRestore = false;
      second = mount();
      if (changedAuthor) await second.entry.update({ config: { searchProvider: 'new-author', fetchProvider: 'new-fetch' } });
      second.start();
      await second.settle();
      const record = store.read();
      if (reason === 'settings-ui-explicit-stop') {
        assert.equal(record.intent.policy, 'released', 'an explicit stop is not undone by mounting the same bundle');
        assert.equal(record.intent.release.operationId, originalOperation);
        assert.equal(record.intent.releaseCompletion?.routeVerified, changedAuthor ? undefined : true);
        assert.equal(second.coordinator().report().coreReady, false);
        assert.equal(second.ctx.get('grokSearchBootstrap').controlSnapshot().phase, changedAuthor ? 'incomplete' : 'released');
      } else {
        assert.equal(second.coordinator().report().coreReady, true, 'native re-enable resumes after verified recovery');
        assert.equal(second.service('grokSearchControl').publicSnapshot().phase, 'required');
        assert.equal(record.intent.policy, 'required');
        assert.equal(record.intent.priorIntent.release.operationId, originalOperation);
        assert.equal(record.intent.priorIntent.releaseCompletion?.routeVerified, changedAuthor ? undefined : true);
        if (changedAuthor) {
          assert.equal(record.intent.acquisition.authorSearchProvider, 'new-author');
          assert.equal(record.intent.acquisition.authorFetchProvider, 'new-fetch');
          await second.service('grokSearchControl').stop('settings-ui-explicit-stop');
          assert.equal(second.web.searchProviderId, 'new-author');
          assert.equal(second.web.fetchProviderId, 'new-fetch');
        }
      }
    } finally {
      failRestore = false;
      await first.ctx.dispose();
      await second?.ctx.dispose();
    }
  });
}

test('a generated failed native release can be retried from the root before a control service exists', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-root-recovery-'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
  const store = createControlIntentStore({ directory: join(directory, 'control-intent.records'),
    trustedRoot: directory, governance: true, autoMaintain: false });
  const f = bootstrapFixture({ storeFactory: () => ({ ...store, startMaintenance() {} }), overrides: {
    control: { name: 'control', apply: applyControl },
    recovery: { name: 'recovery', apply: applyRecovery },
    routeVerifier: { name: 'verifier', apply: applyRouteVerifier },
    core: { name: 'core', apply(child) {
      child.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
    } },
  } });
  f.ctx.profileContext.dir = directory;
  let rejectRestore = true;
  f.entry.update = async ({ config }) => {
    if (rejectRestore && config.searchProvider !== 'grok-search') throw new ControlRecordError('CONTROL_ROUTE_UPDATE_FAILED');
    f.entry.options.config = structuredClone(config);
    f.webFiber.config = structuredClone(config);
    f.webFiber.rawConfig = f.webFiber.config;
    f.webFiber.effectiveConfig = f.webFiber.resolveConfig(config);
    f.web.config = f.webFiber.effectiveConfig;
    f.web.searchProviderId = selectedId(f.webFiber.effectiveConfig.searchProvider);
    f.web.fetchProviderId = selectedId(f.webFiber.effectiveConfig.fetchProvider);
  };
  let replacement;
  try {
    f.start();
    await f.settle();
    const outcome = await f.service('grokSearchControl').stop('native-bundle-disable');
    assert.equal(outcome.completionCommitted, false);
    await f.ctx.dispose();
    replacement = bootstrapFixture({ storeFactory: () => ({ ...store, startMaintenance() {} }), overrides: {
      core: { name: 'core', apply(child) {
        child.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
      } },
      control: { name: 'control', apply: applyControl },
      recovery: { name: 'recovery', apply: applyRecovery },
      routeVerifier: { name: 'verifier', apply: applyRouteVerifier },
    } });
    replacement.ctx.profileContext.dir = directory;
    replacement.entry.update = f.entry.update;
    replacement.web.searchProviderId = 'external-provider';
    replacement.webFiber.effectiveConfig.searchProvider = { get: () => 'external-provider' };
    replacement.start();
    await replacement.settle();
    const root = replacement.ctx.get('grokSearchBootstrap');
    assert.equal(root.controlSnapshot().phase, 'incomplete');
    assert.equal(replacement.ctx.get('grokSearchControl'), undefined);
    const revision = store.read().revision;
    replacement.web.searchProviderId = 'author';
    replacement.webFiber.effectiveConfig.searchProvider = { get: () => 'author' };
    rejectRestore = false;
    replacement.entry.update = async ({ config }) => {
      replacement.entry.options.config = structuredClone(config);
      replacement.webFiber.config = structuredClone(config);
      replacement.webFiber.rawConfig = replacement.webFiber.config;
      replacement.webFiber.effectiveConfig = replacement.webFiber.resolveConfig(config);
      replacement.web.config = replacement.webFiber.effectiveConfig;
      replacement.web.searchProviderId = selectedId(replacement.webFiber.effectiveConfig.searchProvider);
      replacement.web.fetchProviderId = selectedId(replacement.webFiber.effectiveConfig.fetchProvider);
    };
    await Promise.all([root.retryControlRelease(), root.retryControlRelease()]);
    await replacement.settle();
    assert.equal(root.controlSnapshot().phase, 'required');
    assert.equal(replacement.coordinator().report().coreReady, true);
    assert.equal(store.read().revision, revision + 2, 'one recovery completion and one new acquisition, no duplicate writes');
  } finally { await f.ctx.dispose(); await replacement?.ctx.dispose(); }
});

for (const service of ['grokSearchCore', 'grokSearchProgram', 'grokSearchControl']) {
  test(`losing ${service} cannot leave a stale ready runtime and root retry recovers`, async () => {
    const f = bootstrapFixture();
    try {
      f.start();
      await f.settle();
      const root = f.ctx.get('grokSearchBootstrap');
      assert.equal(f.coordinator().report().coreReady, true);
      f.services.delete(service);
      assert.equal(f.coordinator().report().coreReady, false);
      const state = root.controlSnapshot();
      assert.notEqual(state.phase, 'required');
      let officialCalls = 0;
      assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { officialCalls++; }));
      await root.retryControlRelease();
      await f.settle();
      assert.equal(f.coordinator().report().coreReady, true);
      assert.equal(officialCalls, 0);
    } finally { await f.ctx.dispose(); }
  });
}

test('ordinary startup and confirmed external pauses use honest root snapshots without implicit activation', async () => {
  const waiting = deferred();
  const f = bootstrapFixture({ overrides: { core: () => waiting.promise } });
  try {
    f.start();
    await turn();
    const current = f.ctx.get('grokSearchBootstrap').controlSnapshot();
    assert.equal(current.phase, 'starting');
    assert.equal(current.error, null);
  } finally {
    const bootstrap = f.ctx.get('grokSearchBootstrap');
    waiting.resolve({ name: 'core', apply(child) { child.provide('grokSearchCore', { dispose: async () => {} }); } });
    await f.ctx.dispose();
    await bootstrap.settled();
  }
  for (const policy of ['required', 'released']) {
    const stopped = bootstrapFixture({ initialRecord: { intent: {
      policy, reason: 'external-user-pause', pause: { confirmed: true }, release: null,
      ...(policy === 'released' ? { recovery: { routeVerified: true } } : {}),
    } } });
    try {
      stopped.start();
      await stopped.settle();
      const root = stopped.ctx.get('grokSearchBootstrap');
      await root.retryControlRelease();
      assert.equal(stopped.calls.includes('core'), false);
      assert.equal(stopped.coordinator().report().coreReady, false);
      assert.equal(root.controlSnapshot().phase, policy === 'released' ? 'released' : 'stopped');
    } finally { await stopped.ctx.dispose(); }
  }
});

test('a control owner claiming required cannot hide a failed root route validation', async () => {
  const f = bootstrapFixture({ overrides: { control: { name: 'control', apply(child) {
    child.provide('grokSearchControl', { publicSnapshot: () => ({
      available: true, phase: 'required', policy: 'required', revision: 0, releaseOperationId: null,
      completionCommitted: false, routeVerified: false, routeChanged: false, canStop: true, error: null,
    }) });
  } } } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().code, 'COMPATIBILITY_ROUTE_UNCONFIRMED');
    const snapshot = f.ctx.get('grokSearchBootstrap').controlSnapshot();
    assert.equal(snapshot.phase, 'incomplete');
    assert.equal(snapshot.error.code, 'COMPATIBILITY_ROUTE_UNCONFIRMED');
    assert.equal(snapshot.canStop, false);
  } finally { await f.ctx.dispose(); }
});

test('a runtime restart waits for every failed resource exit and retires stale cleanup promises', async () => {
  for (const firstExit of ['core', 'program']) {
    const exits = { core: deferred(), program: deferred() };
    const mounts = { core: 0, program: 0 }, disposals = { core: 0, program: 0 };
    const resource = key => ({ name: key, apply(child) {
      const first = ++mounts[key] === 1;
      child.provide('grokSearch' + key[0].toUpperCase() + key.slice(1), {
        dispose() {
          disposals[key]++;
          if (!first) return Promise.resolve();
          const error = Object.assign(new Error('The owned resource has not exited.'), { code: 'GROK_PROCESS_REAP_FAILED' });
          Object.defineProperty(error, 'whenExited', { value: exits[key].promise });
          return Promise.reject(error);
        },
      });
    } });
    const f = bootstrapFixture({ overrides: { core: resource('core'), program: resource('program') } });
    try {
      f.start();
      await f.settle();
      f.coordinator().block('COMPATIBILITY_CORE_UNAVAILABLE');
      await f.settle();
      let proof;
      await assert.rejects(f.coordinator().start(), error => {
        proof = error.whenExited;
        return error.code === 'GROK_PROCESS_REAP_FAILED' && typeof proof?.then === 'function';
      });
      let allExited = false;
      proof.then(() => { allExited = true; });
      exits[firstExit].resolve();
      await turn();
      assert.equal(allExited, false);
      await assert.rejects(f.coordinator().start(), { code: 'GROK_PROCESS_REAP_FAILED' });
      assert.deepEqual(mounts, { core: 1, program: 1 });
      exits[firstExit === 'core' ? 'program' : 'core'].resolve();
      await proof;
      await turn();
      await f.coordinator().start();
      await f.settle();
      assert.equal(f.coordinator().report().coreReady, true);
      assert.deepEqual(mounts, { core: 2, program: 2 });
      assert.deepEqual(disposals, { core: 1, program: 1 }, 'already exited resources are not disposed again');
    } finally {
      exits.core.resolve(); exits.program.resolve();
      await turn();
      await f.ctx.dispose();
    }
  }
});

test('a new enabled root waits for profile cleanup even without a release record', async () => {
  for (const cancelled of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-cleanup-before-record-'));
    const store = { directory: join(directory, 'control-intent.records'), read: () => null, startMaintenance() {} };
    const closing = deferred();
    holdProductRelease(store, {}, closing.promise, { whenDrained: closing.promise });
    const f = bootstrapFixture({ storeFactory: () => store });
    f.ctx.profileContext.dir = directory;
    let bootstrap;
    try {
      f.start();
      bootstrap = f.ctx.get('grokSearchBootstrap');
      await f.settle();
      assert.equal(f.calls.includes('program'), false);
      assert.equal(f.calls.includes('core'), false);
      assert.equal(f.coordinator().report().coreReady, false);
      if (cancelled) await f.ctx.dispose();
      closing.resolve();
      await bootstrap.settled();
      if (cancelled) assert.equal(f.calls.includes('core'), false);
      else {
        assert.equal(f.coordinator().report().coreReady, true);
        assert.equal(f.calls.filter(call => call === 'core').length, 1);
      }
    } finally { closing.resolve(); await f.ctx.dispose(); }
  }
});

test('settlement of an old release automatically resumes only the still-active native reinstallation', async () => {
  for (const change of ['none', 'pause', 'dispose']) {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-release-notify-'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
    const store = createControlIntentStore({ directory: join(directory, 'control-intent.records'),
      trustedRoot: directory, governance: true, autoMaintain: false });
    let componentDisabled = false;
    const overrides = {
      appBoot: { getDshRuntimeVersion: () => '0.2.2-rc.5',
        readProfilePatches: () => [], composeEntries: () => [{ id: 'grok-search', disabled: componentDisabled }] },
      control: { name: 'control', apply: applyControl },
      recovery: { name: 'recovery', apply: applyRecovery },
      routeVerifier: { name: 'verifier', apply: applyRouteVerifier },
      core: { name: 'core', apply(child) {
        child.provide('grokSearchCore', { releaseBarrier: createReleaseBarrier(), dispose: async () => {} });
      } },
    };
    const mount = () => {
      const f = bootstrapFixture({ storeFactory: () => ({ ...store, startMaintenance() {} }), overrides });
      f.ctx.profileContext.dir = directory;
      f.entry.update = async ({ config }) => {
        f.entry.options.config = structuredClone(config);
        f.webFiber.config = structuredClone(config);
        f.webFiber.rawConfig = f.webFiber.config;
        f.webFiber.effectiveConfig = f.webFiber.resolveConfig(config);
        f.web.config = f.webFiber.effectiveConfig;
        f.web.searchProviderId = selectedId(f.webFiber.effectiveConfig.searchProvider);
        f.web.fetchProviderId = selectedId(f.webFiber.effectiveConfig.fetchProvider);
      };
      return f;
    };
    const first = mount(), held = deferred();
    let replacement;
    try {
      first.start();
      await first.settle();
      first.entry.update = async () => { throw new ControlRecordError('CONTROL_ROUTE_UPDATE_FAILED'); };
      const release = await first.service('grokSearchControl').stop('native-bundle-disable');
      assert.equal(release.completionCommitted, false);
      const pending = store.read(), operationId = pending.intent.release.operationId;
      await first.ctx.dispose();
      holdProductRelease(store, operationId, held.promise);
      replacement = mount();
      replacement.start();
      await replacement.settle();
      assert.equal(replacement.ctx.get('grokSearchRecovery').snapshot().phase, 'owner-present');
      assert.equal(replacement.ctx.get('grokSearchControl'), undefined);
      if (change === 'pause') {
        componentDisabled = true;
        replacement.ctx.fiber.entry.options.disabled = true;
      }
      if (change === 'dispose') await replacement.ctx.dispose();
      held.resolve();
      await held.promise;
      for (let pass = 0; pass < 10; pass++) {
        await turn();
        if (change !== 'dispose') await replacement.settle();
        if (replacement.ctx.get('grokSearchControl')) break;
      }
      if (change === 'none') {
        assert.equal(replacement.coordinator().report().coreReady, true);
        assert.equal(replacement.ctx.get('grokSearchControl').publicSnapshot().phase, 'required');
        assert.equal(store.read().intent.priorIntent.releaseCompletion.releaseOperationId, operationId);
      } else {
        assert.equal(replacement.ctx.get('grokSearchControl'), undefined, change);
        assert.equal(store.read().intent.policy, 'released', change);
        if (change === 'dispose') assert.deepEqual(store.read(), pending);
        else assert.equal(replacement.coordinator().report().coreReady, false);
      }
    } finally {
      held.resolve();
      await first.ctx.dispose();
      await replacement?.ctx.dispose();
    }
  }
});
