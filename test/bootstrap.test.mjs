import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, resolveRuntimeConfig } from '../src/core/product-config.mjs';
import { createSearchConfigHook, checkRuntimeContracts } from '../src/core/product-control.mjs';
import { apply as applyBundle, Config as BundleConfig } from '../src/bundle.mjs';
import { apply as applyCore, Config as CoreConfig } from '../src/index.mjs';
import { createGithubIntegration } from '../src/core/github-host.mjs';
import { createProgramController } from '../src/program.mjs';

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
function bootstrapHost({ modern = true, ready = true } = {}) {
  const services = new Map(), hooks = new Map(), scopes = new Set(), injections = [];
  const definitions = new Map(), guards = [];
  let nextUid = 1;
  const raw = { searchProvider: 'author', fetchProvider: 'fetch' };
  const wrap = value => ({ get: () => value });
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
      fiber, registry: new Map(), profileContext: { dir: 'C:/synthetic-profile' },
      logger: { warn() {}, error() {} },
      get: key => provided.has(key) ? provided.get(key) : parent?.get(key) ?? services.get(key),
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
  stateFactory = null, retryDelay = async () => {} } = {}) {
  const h = bootstrapHost({ ready }), calls = [], stateListeners = new Set();
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
    settings: simple('settings', () => { calls.push('settings'); }),
    github: { createGithubIntegration: () => ({ invalidate() {}, snapshot: () => ({ error: null }) }) },
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
  const start = () => applyBundle(h.ctx, defaults, {
    load, checkContracts: checks, createState: stateFactory ?? makeState,
    createStore: () => store, createPreferences, retryDelay,
  });
  return { ...h, calls, start, store,
    loseConfirmation(errorCode = null) {
      confirmation = false; confirmationError = errorCode;
      for (const listener of stateListeners) listener();
    },
    coordinator: () => h.ctx.get('grokSearchCompatibility'),
    settle: () => h.ctx.get('grokSearchBootstrap').settled() };
}

test('root protects the import gap synchronously and a missing optional module does not block core', async () => {
  const gate = deferred();
  const f = bootstrapFixture({ overrides: {
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
    assert.equal(f.coordinator().report().optionalFeatures.github.code, 'COMPATIBILITY_GITHUB_UNAVAILABLE');
    assert.equal(f.coordinator().report().verification, 'unverified');
    assert.equal(f.coordinator().report().notified, false, 'a boot log is not an acknowledged UI notice');
    await f.coordinator().acknowledgeNotice({});
    assert.equal(f.coordinator().report().notified, true);
    f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => { ran = true; });
    assert.equal(ran, true);
    assert.ok(f.calls.indexOf('recovery') < f.calls.indexOf('program'));
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
      const f = bootstrapFixture({ hostVersion, overrides, initialRecord, githubEnabled: enabled });
      let originalFetches = 0;
      const execute = url => f.ctx.waterfall('tools/execute', { name: 'web_fetch', arguments: { url } },
        () => { originalFetches++; return {}; });
      try {
        f.start();
        await turn();
        if (gap === 'prerelease') assert.equal(f.coordinator().report().confirmationRequired, false);
        if (gap === 'core-import') assert.equal(f.coordinator().report().phase, 'blocked');
        if (gap === 'preferences') assert.equal(f.calls.includes('load:preferences'), false,
          'private preferences no longer wait for dynamic module resolution');
        if (enabled) await assert.rejects(async () => execute('https://github.com/example/project/issues/1'),
          error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
        else await execute('https://github.com/example/project/issues/1');
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

test('a failed production contract cannot be replaced by a successful import or version admission', async () => {
  const f = bootstrapFixture({ contractChecks: () => ({ configHook: false }) });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().phase, 'blocked');
    assert.equal(f.coordinator().report().coreReady, false);
    assert.equal(f.calls.includes('program'), false);
    assert.equal(f.web.searchProviderId, 'author');
    assert.equal(f.store.read(), null);
  } finally { await f.ctx.dispose(); }
});

test('unreadable required intent preserves both early protection hooks without importing execution modules', async () => {
  const f = bootstrapFixture({ readError: new Error('private record failure') });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().phase, 'blocked');
    assert.deepEqual(f.calls, []);
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => true),
      error => error.code.startsWith('COMPATIBILITY_'));
    assert.equal(f.webFiber.resolveConfig({ searchProvider: 'author', fetchProvider: 'fetch' }).searchProvider.get(), 'grok-search');
  } finally { await f.ctx.dispose(); }
});

test('missing core imports leave the root protection and recovery alive without automatic official fallback', async () => {
  const f = bootstrapFixture({ overrides: { core: new Error('core import failed') } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().phase, 'blocked');
    assert.equal(f.calls.includes('recovery'), true);
    assert.equal(f.calls.includes('program'), false);
    assert.equal(f.store.read(), null);
    assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => true),
      error => error.code.startsWith('COMPATIBILITY_'));
    assert.equal(f.web.searchProviderId, 'author', 'an unchanged author route is not permission to execute it');
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

test('a false-negative manual recheck cannot revoke an already working core search route', async () => {
  let checks = 0;
  const f = bootstrapFixture({ contractChecks: () => {
    checks++;
    return { configHook: checks === 1, configCandidate: true, configUpdate: true, pluginDisposal: true,
      webSelection: true, toolExecution: true, toolResult: true, toolGuards: true, githubRead: true };
  } });
  try {
    f.start();
    await f.settle();
    assert.equal(f.coordinator().report().coreReady, true);
    await f.coordinator().recheck();
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

test('missing and malformed host versions defer admission to the real core capability probe', async t => {
  for (const hostVersion of [null, 'not-a-semver']) await t.test(String(hostVersion), async () => {
    const f = bootstrapFixture({ hostVersion });
    try {
      f.start();
      await f.settle();
      const current = f.coordinator().report();
      assert.equal(current.hostVersion, null);
      assert.equal(current.minimumAdmitted, true);
      assert.equal(current.confirmationRequired, false);
      assert.equal(current.coreReady, true);
      assert.equal(f.web.searchProviderId, 'grok-search');
    } finally { await f.ctx.dispose(); }
  });
});

test('the early config hook rejects a missing host schema instead of presenting an unvalidated route', async () => {
  const f = bootstrapFixture({ ready: false });
  let bootstrap;
  try {
    f.start();
    bootstrap = f.ctx.get('grokSearchBootstrap');
    f.webFiber.runtime.Config = null;
    assert.throws(() => f.webFiber.resolveConfig({ searchProvider: 'author', fetchProvider: 'fetch' }),
      { code: 'COMPATIBILITY_ABI_UNSUPPORTED' });
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
        assert.equal(f.coordinator().report().coreReady, true);
        assert.notEqual(f.service('grokSearchControl'), owner);
        assert.equal(f.calls.filter(call => call === 'program').length, 2);
        assert.equal(f.store.read().intent.policy, 'required');
        assert.equal(f.web.searchProviderId, 'grok-search');
      }
    } finally { drained.resolve(); await pendingStop; await f.ctx.dispose(); }
  });
});

test('web and tools detach/reprovide drains the old generation and automatically rebuilds once', async () => {
  for (const missing of [['web'], ['tools'], ['web', 'tools']]) {
    const f = bootstrapFixture();
    try {
      f.start();
      await f.settle();
      const oldEpoch = f.coordinator().captureEpoch(), owner = f.service('grokSearchControl');
      const required = f.store.read();
      await f.deactivateHost(missing);
      await f.settle();
      assert.equal(f.coordinator().report().coreReady, false);
      assert.deepEqual(f.store.read(), required, 'dependency loss must not release persistent intent');
      assert.throws(() => f.ctx.waterfall('tools/execute', { name: 'web_search' }, () => true),
        error => error.code.startsWith('COMPATIBILITY_'));
      f.activateHost();
      await f.settle();
      assert.equal(f.coordinator().report().coreReady, true, `services ${missing.join(',')} should rebuild`);
      assert.notEqual(f.coordinator().captureEpoch(), oldEpoch);
      assert.notEqual(f.service('grokSearchControl'), owner);
      assert.equal(f.calls.filter(call => call === 'program').length, 2);
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
    detached = f.deactivateHost(['tools']);
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
      await f.deactivateHost(['tools']);
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
  const original = { fetch: async () => { originalFetches++; return {}; } };
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
    await f.ctx.waterfall('tools/execute', { ...request, callId: 'github-revoked' }, () => {
      f.coordinator().block('COMPATIBILITY_CONTRACT_FAILED');
      assert.equal(f.ctx.waterfall('internal/get', f.ctx, 'web', null, () => original), original,
        'recovery and control are not execution-gated');
      assert.throws(() => f.ctx.waterfall('internal/get', caller, 'web', null, () => original),
        error => error.code === 'GITHUB_FETCH_UNAVAILABLE');
    });
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
