import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { COMPATIBILITY_REPORT, COMPATIBILITY_DESCRIPTORS } from '../src/core/compatibility-contract.mjs';
import { createSettingsCodec } from '../src/core/settings-codec.mjs';
import { createSourceChain } from '../src/core/source-chain.mjs';
import { createCompatibilityView } from '../src/ui/compatibility-view.mjs';

const report = overrides => ({
  schemaVersion: 1, hostVersion: '0.2.2-rc.3', pluginVersion: '0.4.0', channel: 'rc',
  minimumAdmitted: true, verification: 'unverified', phase: 'ready', revision: 'missing',
  confirmationRequired: false, confirmed: false, notified: false, coreReady: true, code: null,
  optionalFeatures: Object.fromEntries(['settings', 'chat', 'github'].map(key => [key, { available: true, code: null }])),
  ...overrides,
});
const optionalFailure = overrides => report({
  phase: 'degraded', code: 'COMPATIBILITY_OPTIONAL_UNAVAILABLE',
  optionalFeatures: { ...report().optionalFeatures,
    github: { available: false, code: 'COMPATIBILITY_GITHUB_UNAVAILABLE' } },
  ...overrides,
});
const blocked = (code = 'COMPATIBILITY_CORE_SHAPE', overrides = {}) => report({
  phase: 'blocked', coreReady: false, code, ...overrides,
});

function element() {
  const listeners = new Map(), attributes = new Map();
  return {
    dataset: {}, hidden: false, disabled: false, checked: false, textContent: '', innerHTML: '',
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
    dispatch: type => listeners.get(type)?.(),
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    replaceChildren() {}, listeners,
  };
}
function harness(remote, options = {}) {
  const nodes = new Map(), document = { ...element(), visibilityState: 'visible' }, root = element();
  root.ownerDocument = document;
  root.querySelector = selector => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const schedules = new Map();
  let sequence = 0;
  const timers = {
    setTimeout(callback, ms) { const id = ++sequence; schedules.set(id, { callback, ms }); return id; },
    clearTimeout: id => schedules.delete(id),
  };
  const view = createCompatibilityView({
    root, remote, timers, parseReport: value => COMPATIBILITY_REPORT.create().parse(value), ...options,
  });
  return {
    view, root, document, schedules, get: selector => root.querySelector(selector),
    tick(ms) {
      for (const [id, timer] of [...schedules]) if (timer.ms === ms) {
        schedules.delete(id); timer.callback();
      }
    },
  };
}
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('normal compatibility stays completely hidden and only the three agreed states are modeled', async () => {
  assert.deepEqual(COMPATIBILITY_DESCRIPTORS.map(item => item.method), [
    'compatibilityReport', 'recheckCompatibility', 'confirmCompatibility', 'acknowledgeCompatibilityNotice',
  ]);
  const h = harness({ compatibilityReport: async () => report() });
  await settle();
  assert.equal(h.get('.compatibility-banner').hidden, true);
  assert.equal(h.root.dataset.compatibilityPhase, 'normal');
  assert.doesNotMatch(h.root.innerHTML, /waiting-confirmation|风险|未验证组合|COMPATIBILITY_READ_TIMEOUT/);
  h.view.dispose();
});

test('optional compatibility failure is compact, keeps search available and reveals versions only on demand', async () => {
  let rechecks = 0;
  const current = optionalFailure();
  const h = harness({
    compatibilityReport: async () => current,
    recheckCompatibility: async () => { rechecks++; return current; },
  });
  await settle();
  assert.equal(h.get('.compatibility-banner').hidden, false);
  assert.equal(h.root.dataset.compatibilityPhase, 'optional');
  assert.equal(h.get('.compatibility-banner').dataset.tone, 'warn');
  assert.match(h.get('[data-compatibility-title]').textContent, /可选功能暂不可用/);
  assert.match(h.get('[data-compatibility-text]').textContent, /GitHub 链接读取/);
  assert.match(h.get('[data-compatibility-text]').textContent, /核心搜索不受影响/);
  assert.doesNotMatch(h.get('[data-compatibility-text]').textContent, /0\.2\.2|0\.4\.0|COMPATIBILITY_/);
  assert.equal(h.get('[data-compatibility-detail]').hidden, true);
  assert.equal(h.get('[data-compatibility-details]').getAttribute('aria-expanded'), 'false');
  await h.get('[data-compatibility-details]').dispatch('click');
  assert.equal(h.get('[data-compatibility-detail]').hidden, false);
  assert.match(h.get('[data-compatibility-detail]').textContent, /0\.2\.2-rc\.3.*0\.4\.0/);
  await h.get('[data-compatibility-recheck]').dispatch('click');
  assert.equal(rechecks, 1, 'recheck invokes the backend capability RPC, not report refresh');
  assert.equal(h.get('[data-compatibility-title]').textContent, '可选功能暂不可用');
  h.view.dispose();
});

test('confirmed core block has actionable text and never implies official search fallback', async () => {
  const h = harness({ compatibilityReport: async () => blocked() });
  await settle();
  assert.equal(h.get('.compatibility-banner').hidden, false);
  assert.equal(h.root.dataset.compatibilityPhase, 'blocked');
  assert.equal(h.get('.compatibility-banner').dataset.tone, 'err');
  assert.match(h.get('[data-compatibility-title]').textContent, /核心搜索暂不可用/);
  assert.match(h.get('[data-compatibility-text]').textContent, /不会转交官方搜索/);
  assert.equal(h.get('[data-compatibility-recheck]').hidden, true, 'missing RPC is not presented as an action');
  h.view.dispose();
});

test('exhausted transient probe reports a neutral core-block state rather than version blame', async () => {
  const h = harness({ compatibilityReport: async () => blocked('COMPATIBILITY_CORE_UNAVAILABLE') });
  await settle();
  assert.match(h.get('[data-compatibility-text]').textContent, /暂时无法确认搜索安全状态/);
  assert.match(h.get('[data-compatibility-detail]').textContent, /可以重新检查/);
  assert.doesNotMatch(h.get('[data-compatibility-text]').textContent, /版本不兼容/);
  h.view.dispose();
});

test('report transport errors and timeouts never invent a compatibility state or replace an accepted one', async () => {
  const h = harness({ compatibilityReport: async () => { throw Object.assign(new Error('offline'), { code: 'COMPATIBILITY_UNAVAILABLE' }); } });
  await settle();
  assert.equal(h.get('.compatibility-banner').hidden, true);
  assert.equal(h.root.dataset.compatibilityPhase, 'normal');
  const accepted = { compatibilityReport: async () => blocked() };
  h.view.bind(accepted);
  await settle();
  const text = h.get('[data-compatibility-text]').textContent;
  accepted.compatibilityReport = async () => { throw Object.assign(new Error('lost'), { code: 'COMPATIBILITY_UNAVAILABLE' }); };
  await h.view.refresh();
  await settle();
  assert.equal(h.get('[data-compatibility-text]').textContent, text);
  assert.equal(h.get('.compatibility-banner').hidden, false);
  h.view.dispose();

  let replies = [];
  const late = harness({ compatibilityReport: () => new Promise(resolve => replies.push(resolve)) });
  await settle();
  late.tick(4000);
  assert.equal(late.get('.compatibility-banner').hidden, true);
  const second = late.view.refresh();
  await settle();
  replies[0](blocked());
  await settle();
  assert.equal(late.get('.compatibility-banner').hidden, true, 'stale timed-out reports are ignored');
  replies[1](optionalFailure());
  await second;
  assert.equal(late.root.dataset.compatibilityPhase, 'optional');
  late.view.dispose();
});

test('failed recheck preserves the confirmed backend state and can be retried without duplicate work', async () => {
  let rechecks = 0;
  const h = harness({
    compatibilityReport: async () => blocked(),
    recheckCompatibility: async () => { rechecks++; throw new Error('transport disconnected'); },
  });
  await settle();
  const task = h.view.recheck();
  assert.equal(h.view.recheck(), task, 'parallel UI actions share one in-flight request');
  await task;
  assert.equal(rechecks, 1);
  assert.equal(h.root.dataset.compatibilityPhase, 'blocked');
  assert.match(h.get('[data-compatibility-text]').textContent, /不会转交官方搜索/);
  h.view.dispose();
});

test('visible reports converge without rechecking and hidden pages stop polling', async () => {
  let current = report({ phase: 'checking', coreReady: false }), reads = 0;
  const remote = { compatibilityReport: async () => { reads++; return current; } };
  const h = harness(remote);
  await settle();
  current = blocked();
  h.tick(5000);
  await settle();
  assert.equal(h.root.dataset.compatibilityPhase, 'blocked');
  h.get('[data-compatibility-details]').dispatch('click');
  h.tick(5000);
  await settle();
  assert.equal(h.get('[data-compatibility-detail]').hidden, false, 'unchanged polls preserve expanded details');
  h.document.visibilityState = 'hidden';
  h.document.dispatch('visibilitychange');
  const before = reads;
  h.tick(5000);
  await settle();
  assert.equal(reads, before);
  current = report();
  h.document.visibilityState = 'visible';
  h.document.dispatch('visibilitychange');
  await settle();
  assert.equal(h.root.dataset.compatibilityPhase, 'normal');
  assert.equal(h.root.getAttribute('aria-busy'), 'false');
  h.view.dispose();
  assert.equal(h.schedules.size, 0);
});

test('recheck allows the backend deadline and a timeout is followed by a report read', async () => {
  let current = blocked(), finish;
  const h = harness({
    compatibilityReport: async () => current,
    recheckCompatibility: () => new Promise(resolve => { finish = resolve; }),
  });
  await settle();
  void h.view.recheck();
  await settle();
  assert.ok([...h.schedules.values()].some(timer => timer.ms === 20000));
  h.tick(20000);
  current = report();
  h.tick(5000);
  await settle();
  assert.equal(h.root.dataset.compatibilityPhase, 'normal');
  finish(blocked());
  await settle();
  assert.equal(h.root.dataset.compatibilityPhase, 'normal', 'late recheck cannot restore stale failure');
  h.view.dispose();
});

test('automatic polling does not accumulate unresolved transport calls', async () => {
  let reads = 0, finish;
  const h = harness({ compatibilityReport: () => {
    reads++;
    return new Promise(resolve => { finish = resolve; });
  } });
  await settle();
  h.tick(4000);
  for (let index = 0; index < 5; index++) { h.tick(5000); await settle(); }
  assert.equal(reads, 1);
  finish(report());
  await settle();
  h.tick(5000);
  await settle();
  assert.equal(reads, 2);
  h.view.dispose();
  finish(blocked());
  await settle();
  assert.equal(h.schedules.size, 0);
});

test('binding the same live remote refreshes its changed state without remounting', async () => {
  let current = blocked();
  const remote = { compatibilityReport: async () => current };
  const h = harness(remote);
  await settle();
  current = report();
  h.view.bind(remote);
  await settle();
  assert.equal(h.root.dataset.compatibilityPhase, 'normal');
  h.view.dispose();
});

test('scoped styles preserve keyboard focus, reduced motion and narrow layout without route selectors', () => {
  const h = harness({ compatibilityReport: async () => optionalFailure() });
  const css = h.root.innerHTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const [, selector] of css.matchAll(/([^{}]+)\{/g)) {
    if (selector.trim().startsWith('@') || selector.trim() === 'to') continue;
    assert.ok(selector.split(',').every(value => /^\.compatibility-banner(?=[\s.[:]|$)/.test(value.trim())),
      `unscoped selector: ${selector}`);
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /flex-wrap:wrap/);
  assert.match(css, /min-height:32px/);
  h.view.dispose();
});
// Evaluate the authored ModuleLoader entry, not the generated artifact or a
// reconstructed apply(). This suite deliberately does not invoke the bundler.
function clientHarness({ unavailable = [], delayedSlots = [], failedSlots = [], baseMissing = false } = {}) {
  const source = readFileSync(new URL('../src/client.template.js', import.meta.url), 'utf8');
  const offset = source.indexOf('window.__ModuleLoader__.load(');
  assert.ok(offset > 0);
  const registrations = [], mounts = [], warnings = [], services = new Map(), slots = new Map(), hooks = [];
  let factory, mountRemovals = 0, routeCreates = 0, routeDisposes = 0;
  const oldDescriptor = {
    id: 'dsh-grok-search#grokSearchSettings/snapshot', service: 'grokSearchSettings',
    namespace: 'grokSearchSettings', method: 'snapshot', invocation: { kind: 'direct' }, parameters: [],
    result: createSettingsCodec('test#Snapshot', { type: 'object', additionalProperties: true }),
  };
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { factory = value.factory; } } },
    codec: createSettingsCodec, createSourceChain, COMPATIBILITY_VIEW: createCompatibilityView,
    ROUTE_CONTROLLER: () => {
      routeCreates++;
      return { setTheme() {}, dispose() { routeDisposes++; } };
    },
    SEARCH_LOG() {}, QUOTA_VIEW() {}, TOOL_ROUTE_VIEW: () => ({ Component() {} }),
    attachSharedStyles: () => () => {}, LOGOS: {}, TOOL_ROUTE_CSS: '', ROUTE_CSS: '',
    ROUTE_CARD: '<section></section>', ROUTE_LAYER: '<div></div>',
    SETTINGS_DESCRIPTORS: [oldDescriptor], COMPATIBILITY_DESCRIPTORS,
  });
  vm.runInContext(source.slice(offset), context);
  const react = {
    useEffect: effect => hooks.push(effect), useRef: initial => ({ current: initial }),
  };
  const client = factory(name => name === 'react' ? react : { jsx: (type, props) => ({ type, props }) });
  const remote = {
    grokSearchSettings: { snapshot: async () => ({ ok: true, value: { legacy: true } }) },
    grokSearchCompatibility: { compatibilityReport: async () => ({ ok: true, value: report() }) },
    $mount: async value => { mounts.push(value); return () => { mountRemovals++; }; },
  };
  const ctx = {
    remote, effect: effect => effect(), locale: { register: () => () => {} },
    logger: { warn: value => warnings.push(value) },
    inject(names, setup) {
      services.set(names[0], setup);
      if (unavailable.includes(names[0]) || names[0] === 'theme') {
        return Object.assign(new Promise(() => {}), { dispose: async () => {} });
      }
      const cleanup = setup(ctx);
      return Object.assign(Promise.resolve(), { dispose: async () => cleanup?.() });
    },
    slots: {
      inject(name, setup) {
        slots.set(name, setup);
        if (!delayedSlots.includes(name)) return setup();
      },
      register(options, component) {
        if (failedSlots.includes(options.name)) throw new Error('optional slot absent');
        const row = { options, component };
        registrations.push(row);
        return () => { const index = registrations.indexOf(row); if (index >= 0) registrations.splice(index, 1); };
      },
      entries: () => [],
      subscribe: () => () => {},
    },
  };
  if (baseMissing) delete ctx.slots;
  return {
    client, ctx, context, hooks, registrations, mounts, services, slots, warnings, remote,
    mountRemovals: () => mountRemovals, routeCreates: () => routeCreates, routeDisposes: () => routeDisposes,
  };
}

test('authored client isolates old server, delayed missing slots and common-base failure without a build', async () => {
  const h = clientHarness({
    unavailable: ['remote.grokSearchCompatibility'],
    delayedSlots: ['plugins.detail.badge', 'tool.call.toolview'],
    failedSlots: ['plugins.detail.badge'],
  });
  const dispose = await h.client.apply(h.ctx);
  assert.equal(h.mounts.length, 1);
  assert.equal(h.mounts[0].descriptors.length, 1 + COMPATIBILITY_DESCRIPTORS.length);
  assert.doesNotThrow(() => h.slots.get('plugins.detail.badge')());
  h.ctx.slots.subscribe = () => { throw new Error('missing chat callbacks'); };
  assert.doesNotThrow(() => h.slots.get('tool.call.toolview')());
  const connection = h.registrations.find(row => row.options.name === 'plugins.bundle.config').options.inject().connection;
  assert.equal(connection.compatibility, null);
  assert.deepEqual(await connection.settings.snapshot(), { legacy: true });
  await dispose(); await dispose();
  assert.equal(h.mountRemovals(), 1);
  assert.equal(h.registrations.length, 0);
  const absent = clientHarness({ baseMissing: true });
  await (await absent.client.apply(absent.ctx))();
  assert.equal(absent.mounts.length, 0);
  assert.ok(absent.warnings.some(value => value.includes('BASE_UNAVAILABLE')));
});

test('compatibility-only authored client retains one page and picks up late settings without re-registering', async () => {
  const h = clientHarness({ unavailable: ['remote.grokSearchSettings'] });
  const dispose = await h.client.apply(h.ctx);
  const page = h.registrations.find(row => row.options.name === 'plugins.bundle.config');
  const connection = page.options.inject().connection;
  assert.equal(connection.settings, null);
  assert.equal((await connection.compatibility.compatibilityReport()).hostVersion, '0.2.2-rc.3');
  let notifications = 0;
  connection.listeners.add(() => { notifications++; });
  const detach = h.services.get('remote.grokSearchSettings')(h.ctx);
  assert.deepEqual(await connection.settings.snapshot(), { legacy: true });
  assert.equal(notifications, 1);
  assert.equal(h.registrations.filter(row => row.options.name === 'plugins.bundle.config').length, 1);
  detach();
  assert.equal(connection.settings, null);
  await dispose();
});

test('late service and slot callbacks cannot resurrect a disposed client', async () => {
  const h = clientHarness({ unavailable: ['remote.grokSearchSettings'], delayedSlots: ['plugins.detail.badge'] });
  const dispose = await h.client.apply(h.ctx);
  await dispose();
  h.services.get('remote.grokSearchSettings')(h.ctx);
  h.slots.get('plugins.detail.badge')();
  assert.equal(h.registrations.length, 0);
  assert.equal(h.mountRemovals(), 1);
});

test('settings removal disposes its chat contribution even when the host slot subscription returns no disposer', async () => {
  const h = clientHarness({ unavailable: ['remote.grokSearchSettings'] });
  const dispose = await h.client.apply(h.ctx);
  let removals = 0, subscribed = 0;
  h.ctx.slots.inject = (name, setup) => { setup(); };
  h.ctx.slots.subscribe = () => { subscribed++; return () => { removals++; }; };
  const detach = h.services.get('remote.grokSearchSettings')(h.ctx);
  assert.equal(subscribed, 1);
  detach();
  assert.equal(removals, 1);
  await dispose();
  assert.equal(removals, 1);
});

test('compatibility RPC failure and recovery never recreate an existing settings controller', async () => {
  const h = clientHarness();
  const nodes = () => {
    const map = new Map(), node = element();
    node.style = {};
    node.querySelector = selector => {
      if (!map.has(selector)) map.set(selector, nodes());
      return map.get(selector);
    };
    node.attachShadow = () => node.shadowRoot ||= nodes();
    node.remove = () => {};
    return node;
  };
  const document = {
    ...element(), visibilityState: 'visible',
    body: { appendChild() {} }, head: { appendChild() {} }, createElement: nodes,
  };
  const host = nodes(), shadow = host.attachShadow();
  shadow.querySelector('[data-dsg-compatibility]').ownerDocument = document;
  h.context.document = document;
  h.context.window.matchMedia = () => ({ ...element(), matches: false });
  let reject;
  h.remote.grokSearchCompatibility.compatibilityReport = () => new Promise((_, fail) => { reject = fail; });
  h.remote.grokSearchCompatibility.recheckCompatibility = async () => ({ ok: true, value: report() });
  const dispose = await h.client.apply(h.ctx);
  const page = h.registrations.find(row => row.options.name === 'plugins.bundle.config');
  const tree = page.component(page.options.inject());
  tree.props.ref.current = host;
  const cleanup = h.hooks.at(-1)();
  await settle();
  assert.equal(h.routeCreates(), 1);
  reject(Object.assign(new Error('report failed'), { code: 'COMPATIBILITY_UNAVAILABLE' }));
  await settle();
  assert.equal(h.routeCreates(), 1);
  assert.equal(h.routeDisposes(), 0);
  assert.equal(shadow.querySelector('[data-dsg-compatibility]').querySelector('.compatibility-banner').hidden, true);
  h.remote.grokSearchCompatibility.compatibilityReport = async () => ({ ok: true, value: report({
    optionalFeatures: {
      settings: { available: false, code: 'SETTINGS_UNAVAILABLE' },
      chat: { available: true, code: null }, github: { available: true, code: null },
    },
  }) });
  await shadow.querySelector('[data-dsg-compatibility]').querySelector('[data-compatibility-recheck]').dispatch('click');
  assert.equal(h.routeCreates(), 1);
  assert.equal(h.routeDisposes(), 0, 'a report does not own the actual settings service lifetime');
  cleanup();
  assert.equal(h.routeDisposes(), 1);
  await dispose();
});
