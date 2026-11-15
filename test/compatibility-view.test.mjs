import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { COMPATIBILITY_REPORT, COMPATIBILITY_DESCRIPTORS } from '../src/core/compatibility-contract.mjs';
import { createSettingsCodec } from '../src/core/settings-codec.mjs';
import { createSourceChain } from '../src/core/source-chain.mjs';
import { createCompatibilityView } from '../src/ui/compatibility-view.mjs';

const report = overrides => ({
  schemaVersion: 1, hostVersion: '0.3.0-rc.1', pluginVersion: '0.2.2', channel: 'rc',
  minimumAdmitted: true, verification: 'unverified', phase: 'ready', revision: 'missing',
  confirmationRequired: false, confirmed: false, notified: false, coreReady: true, code: null,
  optionalFeatures: Object.fromEntries(['settings', 'chat', 'github'].map(key => [key, { available: true, code: null }])),
  ...overrides,
});
const experimental = overrides => report({
  hostVersion: '0.3.0-beta.1', channel: 'beta', phase: 'waiting-confirmation',
  confirmationRequired: true, coreReady: false, ...overrides,
});
// runtime-compat reports ready once core work finishes, even while optionals are pending.
const pendingReport = overrides => report({
  code: 'COMPATIBILITY_OPTIONAL_PENDING',
  optionalFeatures: Object.fromEntries(['settings', 'chat', 'github'].map(key => [
    key, { available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' },
  ])),
  ...overrides,
});

function element() {
  const listeners = new Map();
  return {
    dataset: {}, hidden: false, disabled: false, checked: false, textContent: '', innerHTML: '',
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
    dispatch: type => listeners.get(type)?.(), setAttribute() {}, replaceChildren() {},
    listeners,
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
  const values = [];
  const view = createCompatibilityView({
    root, remote, timers, parseReport: value => COMPATIBILITY_REPORT.create().parse(value),
    onReport: value => values.push(value), ...options,
  });
  return {
    view, root, document, schedules, values, get: selector => root.querySelector(selector),
    consent() {
      const checkbox = root.querySelector('[data-compatibility-risk]');
      checkbox.checked = true;
      checkbox.dispatch('change');
    },
    tick(ms) {
      for (const [id, timer] of [...schedules]) if (timer.ms === ms) {
        schedules.delete(id); timer.callback();
      }
    },
  };
}
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('compatibility markup and state selectors never share route structural classes', async () => {
  for (const [current, tone] of [
    [report(), 'info'], [experimental(), 'warn'],
    [experimental({ phase: 'blocked', code: 'TOOL_BUDGET_UNAVAILABLE' }), 'err'],
    [null, 'err'],
  ]) {
    const h = harness({ compatibilityReport: async () => {
      if (!current) throw Object.assign(new Error('offline'), { code: 'COMPATIBILITY_UNAVAILABLE' });
      return current;
    } });
    await settle();
    const classes = [...h.root.innerHTML.matchAll(/\bclass="([^"]+)"/g)].flatMap(match => match[1].split(/\s+/));
    assert.ok(classes.includes('compatibility-banner'));
    assert.ok(classes.includes('compatibility-button-primary'));
    assert.ok(classes.includes('compatibility-check'));
    assert.ok(classes.every(name => name.startsWith('compatibility-')), 'no banner/btn/check aliases');
    assert.equal(h.get('.compatibility-banner').dataset.tone, tone);
    const css = h.root.innerHTML.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    assert.ok(css, 'the independent card owns its scoped styles');
    for (const [, selector] of css.matchAll(/([^{}]+)\{/g)) {
      if (selector.trim().startsWith('@media')) continue;
      assert.ok(selector.split(',').every(value => /^\.compatibility-banner(?=[\s.[:]|$)/.test(value.trim())),
        `unscoped selector: ${selector}`);
    }
    h.view.dispose();
  }
});

test('scoped compatibility styling preserves route card and control measurements and states', () => {
  const h = harness(null);
  const css = h.root.innerHTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  const routeCSS = readFileSync(new URL('../src/ui/route.css', import.meta.url), 'utf8');
  const rule = (source, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = source.match(new RegExp(`${escaped}\\{([^{}]*)\\}`))?.[1];
    assert.ok(body, `missing style rule: ${selector}`);
    return Object.fromEntries(body.split(';').filter(Boolean).map(value => {
      const index = value.indexOf(':');
      return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
    }));
  };
  assert.deepEqual(rule(css, '.compatibility-banner'), {
    ...rule(routeCSS, '.banner'), 'margin-bottom': '12px', 'flex-wrap': 'wrap',
  });
  assert.deepEqual(rule(css, '.compatibility-banner .compatibility-actions'), {
    ...rule(routeCSS, '.banner .b-actions'), 'flex-wrap': 'wrap',
  });
  assert.deepEqual(rule(css, '.compatibility-banner .compatibility-button'), {
    ...rule(routeCSS, '.btn'), ...rule(routeCSS, '.btn-sm'), 'font-family': 'inherit', cursor: 'pointer',
  });
  for (const [scoped, original] of [
    ['.compatibility-body', '.banner .b-body'], ['.compatibility-title', '.banner .b-title'],
    ['.compatibility-text', '.banner .b-text'], ['.compatibility-button:hover:not(:disabled)', '.btn:hover:not(:disabled)'],
    ['.compatibility-button:active:not(:disabled)', '.btn:active:not(:disabled)'],
    ['.compatibility-button-primary', '.btn-primary'],
    ['.compatibility-button-primary:hover:not(:disabled)', '.btn-primary:hover:not(:disabled)'],
    ['.compatibility-check', '.check'], ['.compatibility-check:hover', '.check:hover'],
    ['.compatibility-risk', '.check input'], ['.compatibility-box', '.check .box'],
    ['.compatibility-box svg', '.check .box svg'],
    ['.compatibility-risk:checked + .compatibility-box', '.check input:checked + .box'],
    ['.compatibility-risk:checked + .compatibility-box svg', '.check input:checked + .box svg'],
    ['.compatibility-risk:focus-visible + .compatibility-box', '.check input:focus-visible + .box'],
    ['.compatibility-check-text', '.check .c-text'], ['.compatibility-check-text small', '.check .c-text small'],
  ]) assert.deepEqual(rule(css, `.compatibility-banner ${scoped}`), rule(routeCSS, original), scoped);
  for (const suffix of ['[data-tone=warn]', '[data-tone=err]']) {
    assert.deepEqual(rule(css, `.compatibility-banner${suffix}`), rule(routeCSS, `.banner${suffix}`));
  }
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(css, /transition-duration:\.001ms!important;transition-delay:0s!important/);
  h.view.dispose();
});

test('stable and RC reports do not ask for experimental consent and dismiss only the exact pair', async () => {
  const memory = {};
  let current = report(), confirmations = 0;
  const remote = { compatibilityReport: async () => current, confirmCompatibility: async () => { confirmations++; } };
  const h = harness(remote, { memory });
  await settle();
  assert.equal(h.get('[data-compatibility-confirm]').hidden, true);
  assert.equal(h.get('[data-compatibility-notice]').hidden, false);
  await h.view.confirm();
  await h.view.dismiss();
  assert.equal(h.get('[data-compatibility-notice]').hidden, true);
  h.view.dispose();
  const next = harness(remote, { memory });
  await settle();
  assert.equal(next.get('[data-compatibility-notice]').hidden, true);
  current = report({ hostVersion: '0.3.0' , channel: 'stable' });
  await next.view.refresh();
  assert.equal(next.get('[data-compatibility-notice]').hidden, false);
  assert.equal(confirmations, 0);
  next.view.dispose();
});

test('persisted notification suppresses the once banner but leaves status and degradation visible', async () => {
  const current = report({ notified: true, phase: 'degraded', optionalFeatures: {
    settings: { available: false, code: 'SETTINGS_UNAVAILABLE' },
    chat: { available: false, code: 'CHAT_UNAVAILABLE' }, github: { available: true, code: null },
  } });
  const h = harness({ compatibilityReport: async () => current });
  await settle();
  assert.equal(h.get('[data-compatibility-notice]').hidden, true);
  assert.match(h.get('[data-compatibility-state]').textContent, /核心能力可用/);
  assert.match(h.get('[data-compatibility-features]').textContent, /SETTINGS_UNAVAILABLE/);
  assert.equal(h.get('[data-compatibility-confirm]').hidden, true);
  h.view.dispose();
});

test('pending optional observations are neither client failures nor proof of local availability', async () => {
  for (const code of [null, 'COMPATIBILITY_OPTIONAL_PENDING']) {
    const current = report({ phase: 'degraded', code, optionalFeatures: {
      settings: { available: true, code: null },
      chat: { available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' },
      github: { available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' },
    } });
    const h = harness({ compatibilityReport: async () => current });
    await settle();
    assert.match(h.get('[data-compatibility-features]').textContent, /聊天搜索卡片：客户端状态待确认/);
    assert.match(h.get('[data-compatibility-features]').textContent, /GitHub 读取：状态待确认/);
    assert.doesNotMatch(h.get('[data-compatibility-features]').textContent, /不可用|COMPATIBILITY_OPTIONAL_PENDING/);
    assert.match(h.get('[data-compatibility-state]').textContent, /可选功能状态待确认/);
    assert.equal(h.get('[data-compatibility-error]').hidden, true);
    assert.equal(h.get('.compatibility-banner').dataset.tone, 'info');
    assert.equal(h.root.dataset.compatibilityPhase, 'degraded', 'presentation does not rewrite the server phase');
    assert.equal(h.values[0].optionalFeatures.chat.available, false, 'no invented client observation');
    h.view.dispose();
  }
});

test('pending client observations never hide confirmed optional, core or transport failures', async () => {
  for (const [phase, code, settingsAvailable, tone] of [
    ['degraded', null, false, 'warn'],
    ['blocked', 'TOOL_BUDGET_UNAVAILABLE', true, 'err'],
  ]) {
    const current = report({ phase, code, coreReady: phase !== 'blocked', optionalFeatures: {
      settings: { available: settingsAvailable, code: settingsAvailable ? null : 'SETTINGS_UNAVAILABLE' },
      chat: { available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' },
      github: { available: true, code: null },
    } });
    const h = harness({ compatibilityReport: async () => current });
    await settle();
    assert.match(h.get('[data-compatibility-features]').textContent, /聊天搜索卡片：客户端状态待确认/);
    assert.equal(h.get('.compatibility-banner').dataset.tone, tone);
    assert.doesNotMatch(h.get('[data-compatibility-state]').textContent, /^可选功能状态待确认/);
    if (!settingsAvailable) assert.match(h.get('[data-compatibility-features]').textContent, /完整设置：不可用（SETTINGS_UNAVAILABLE）/);
    if (code) assert.match(h.get('[data-compatibility-error]').textContent, /TOOL_BUDGET_UNAVAILABLE/);
    h.view.dispose();
  }
  let fail = false;
  const h = harness({ compatibilityReport: async () => {
    if (fail) throw Object.assign(new Error('offline'), { code: 'COMPATIBILITY_UNAVAILABLE' });
    return report({ phase: 'degraded', optionalFeatures: {
      ...report().optionalFeatures, chat: { available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING' },
    } });
  } });
  await settle();
  fail = true;
  await h.view.refresh();
  assert.equal(h.get('[data-compatibility-error]').hidden, false);
  assert.match(h.get('[data-compatibility-error]').textContent, /COMPATIBILITY_UNAVAILABLE/);
  assert.equal(h.get('.compatibility-banner').dataset.tone, 'err');
  h.view.dispose();
});

test('runtime ready reports keep polling each pending server optional and stop with chat alone pending', async () => {
  for (const order of [['settings', 'github'], ['github', 'settings']]) {
    let current = pendingReport(), reads = 0;
    const h = harness({ compatibilityReport: async () => { reads++; return current; } });
    await settle();
    assert.equal(h.root.dataset.compatibilityPhase, 'ready');
    assert.equal(h.get('[data-compatibility-error]').hidden, true);
    for (const name of order) {
      assert.equal([...h.schedules.values()].filter(timer => timer.ms === 3000).length, 1);
      current = { ...current, optionalFeatures: { ...current.optionalFeatures, [name]: { available: true, code: null } } };
      h.tick(3000);
      await settle();
    }
    assert.equal(reads, 3);
    assert.match(h.get('[data-compatibility-features]').textContent, /完整设置：可用.*客户端状态待确认.*GitHub 读取：可用/);
    assert.equal(h.schedules.size, 0, 'the overall OPTIONAL_PENDING code must not keep chat polling');
    h.tick(3000);
    await settle();
    assert.equal(reads, 3);
    h.view.dispose();
  }
});

test('runtime degraded reports finish pending server observations without hiding a failed optional', async () => {
  let current = pendingReport({ phase: 'degraded', code: 'COMPATIBILITY_OPTIONAL_UNAVAILABLE' }), reads = 0;
  current.optionalFeatures.settings = { available: false, code: 'COMPATIBILITY_SETTINGS_UNAVAILABLE' };
  const h = harness({ compatibilityReport: async () => { reads++; return current; } });
  await settle();
  assert.equal([...h.schedules.values()].filter(timer => timer.ms === 3000).length, 1);
  current.optionalFeatures.github = { available: true, code: null };
  h.tick(3000);
  await settle();
  assert.equal(reads, 2);
  assert.equal(h.schedules.size, 0);
  assert.equal(h.get('.compatibility-banner').dataset.tone, 'warn');
  assert.match(h.get('[data-compatibility-features]').textContent, /COMPATIBILITY_SETTINGS_UNAVAILABLE/);
  assert.match(h.get('[data-compatibility-error]').textContent, /COMPATIBILITY_OPTIONAL_UNAVAILABLE/);
  h.view.dispose();
});

test('pending optionals do not revive blocked, stopped, waiting or non-ready core polling', async () => {
  for (const current of [
    pendingReport({ phase: 'blocked', code: 'COMPATIBILITY_BUDGET_UNCONFIRMED', coreReady: false }),
    pendingReport({ phase: 'stopped', code: 'COMPATIBILITY_STOPPED', coreReady: false }),
    pendingReport({ ...experimental(), optionalFeatures: pendingReport().optionalFeatures }),
    pendingReport({ coreReady: false }),
    report(),
    pendingReport({ optionalFeatures: { ...report().optionalFeatures, chat: pendingReport().optionalFeatures.chat } }),
  ]) {
    let reads = 0;
    const h = harness({ compatibilityReport: async () => { reads++; return current; } });
    await settle();
    h.tick(3000);
    await settle();
    assert.equal(reads, 1, current.phase);
    assert.equal(h.schedules.size, 0, current.phase);
    h.view.dispose();
  }
});

test('checking still polls through core readiness before the bounded optional follow-up', async () => {
  let current = pendingReport({ phase: 'checking', coreReady: false, code: 'COMPATIBILITY_CORE_PENDING' }), reads = 0;
  const h = harness({ compatibilityReport: async () => { reads++; return current; } });
  await settle();
  h.tick(3000);
  await settle();
  assert.equal(reads, 2);
  current = pendingReport();
  h.tick(3000);
  await settle();
  assert.equal(h.root.dataset.compatibilityPhase, 'ready');
  current = pendingReport({ optionalFeatures: { ...report().optionalFeatures, chat: pendingReport().optionalFeatures.chat } });
  h.tick(3000);
  await settle();
  assert.equal(reads, 4);
  assert.equal(h.schedules.size, 0);
  h.view.dispose();
});

test('hung optionals get at most ten automatic follow-ups per binding even when reports change', async () => {
  let reads = 0;
  const remote = { compatibilityReport: async () => pendingReport({ revision: (++reads).toString(16).padStart(64, '0') }) };
  const h = harness(remote);
  await settle();
  for (let index = 0; index < 20; index++) { h.tick(3000); await settle(); }
  assert.equal(reads, 11, 'one initial read plus ten automatic follow-ups');
  assert.equal(h.schedules.size, 0);
  assert.equal(h.get('[data-compatibility-refresh]').disabled, false);
  assert.equal(h.get('[data-compatibility-error]').hidden, true, 'exhausting a UI poll budget is not a server failure');
  await h.view.refresh();
  h.document.dispatch('visibilitychange');
  await settle();
  h.tick(3000);
  await settle();
  assert.equal(reads, 13, 'manual refresh and visibility restoration are single reads, not new retry windows');
  assert.equal(h.schedules.size, 0);
  h.view.bind(remote);
  await settle();
  assert.equal(reads, 13, 'rebinding the same service must not renew the budget');
  h.view.bind({ ...remote });
  await settle();
  for (let index = 0; index < 20; index++) { h.tick(3000); await settle(); }
  assert.equal(reads, 24, 'a replacement service gets one initial read and its own bounded window');
  assert.equal(h.schedules.size, 0);
  h.view.dispose();
});

test('hidden optional polls neither issue requests nor consume the follow-up budget', async () => {
  let reads = 0;
  const h = harness({ compatibilityReport: async () => { reads++; return pendingReport(); } });
  await settle();
  h.document.visibilityState = 'hidden';
  h.document.dispatch('visibilitychange');
  for (let index = 0; index < 20; index++) { h.tick(3000); await settle(); }
  assert.equal(reads, 1);
  h.document.visibilityState = 'visible';
  h.document.dispatch('visibilitychange');
  await settle();
  assert.equal(reads, 2);
  for (let index = 0; index < 20; index++) { h.tick(3000); await settle(); }
  assert.equal(reads, 12);
  assert.equal(h.schedules.size, 0);
  h.view.dispose();
});

test('optional follow-up failures and malformed reports stop automatic retries', async () => {
  for (const invalid of [false, true]) {
    let reads = 0;
    const h = harness({ compatibilityReport: async () => {
      if (++reads === 1) return pendingReport();
      if (invalid) return { ...pendingReport(), unexpected: true };
      throw Object.assign(new Error('offline'), { code: 'COMPATIBILITY_UNAVAILABLE' });
    } });
    await settle();
    for (let index = 0; index < 3; index++) { h.tick(3000); await settle(); }
    assert.equal(reads, 2);
    assert.equal(h.schedules.size, 0);
    assert.match(h.get('[data-compatibility-error]').textContent,
      invalid ? /COMPATIBILITY_REPORT_INVALID/ : /COMPATIBILITY_UNAVAILABLE/);
    h.view.dispose();
  }
});

test('optional follow-ups preserve single-flight, timeout and disposal guards', async () => {
  for (const dispose of [false, true]) {
    let reads = 0, reply;
    const h = harness({ compatibilityReport: () => {
      if (++reads === 1) return pendingReport();
      return new Promise(resolve => { reply = resolve; });
    } });
    await settle();
    h.tick(3000);
    await settle();
    const task = h.view.refresh();
    assert.equal(h.view.refresh(), task);
    h.document.dispatch('visibilitychange');
    h.tick(3000);
    await settle();
    assert.equal(reads, 2);
    if (dispose) h.view.dispose();
    else {
      h.tick(4000);
      assert.match(h.get('[data-compatibility-error]').textContent, /COMPATIBILITY_READ_TIMEOUT/);
      assert.equal(h.view.refresh(), task, 'a timed-out transport still owns the outstanding request');
    }
    reply(report());
    await task;
    h.tick(3000);
    await settle();
    assert.equal(reads, 2);
    assert.equal(h.values.length, 1, 'late optional responses cannot replace the last accepted report');
    assert.equal(h.schedules.size, 0);
    h.view.dispose();
  }
  let reads = 0;
  const h = harness({ compatibilityReport: async () => { reads++; return pendingReport(); } });
  await settle();
  h.view.dispose();
  h.tick(3000);
  await settle();
  assert.equal(reads, 1, 'unmount also cancels a follow-up that has not dispatched');
  assert.equal(h.schedules.size, 0);
  assert.equal(h.document.listeners.size, 0);
});

test('experimental confirmation requires a fresh exact pair and sends one immutable explicit request', async () => {
  const requests = [];
  let current = experimental();
  const h = harness({
    compatibilityReport: async () => current,
    confirmCompatibility: async request => {
      requests.push(request);
      return current = { ...current, phase: 'checking', confirmed: true, revision: 'a'.repeat(64) };
    },
  });
  await settle();
  await h.view.confirm();
  assert.equal(requests.length, 0);
  h.consent();
  await Promise.all([h.view.confirm(), h.view.confirm()]);
  assert.deepEqual(requests, [{
    expectedRevision: 'missing', hostVersion: '0.3.0-beta.1', pluginVersion: '0.2.2', acceptRisk: true,
  }]);
  assert.equal(h.get('[data-compatibility-confirm]').hidden, true);
  assert.match(h.get('[data-compatibility-state]').textContent, /核心就绪尚未确认/);
  h.view.dispose();
});

test('blocked, unadmitted, unknown, malformed and budget-failed reports cannot be confirmed', async () => {
  for (const current of [
    experimental({ phase: 'blocked', code: 'TOOL_BUDGET_UNAVAILABLE' }),
    experimental({ code: 'TOOL_BUDGET_UNAVAILABLE' }),
    experimental({ minimumAdmitted: false }),
    experimental({ hostVersion: null }),
    experimental({ revision: null }),
    experimental({ channel: 'stable' }),
    { ...experimental(), unexpected: 'not a report' },
  ]) {
    let confirmations = 0;
    const h = harness({ compatibilityReport: async () => current,
      confirmCompatibility: async () => { confirmations++; return current; } });
    await settle(); h.consent(); await h.view.confirm();
    assert.equal(confirmations, 0);
    assert.equal(h.get('[data-compatibility-confirm]').disabled, true);
    h.view.dispose();
  }
});

test('a report revision change withdraws consent and a failed mutation is never automatically retried', async () => {
  let current = experimental(), confirms = 0;
  const h = harness({
    compatibilityReport: async () => current,
    confirmCompatibility: async () => {
      confirms++;
      throw Object.assign(new Error('server denied'), { code: 'COMPATIBILITY_STATE_FULL' });
    },
  });
  await settle(); h.consent();
  current = { ...current, revision: 'b'.repeat(64) };
  await h.view.refresh(); await h.view.confirm();
  assert.equal(confirms, 0);
  h.consent(); await h.view.confirm();
  assert.equal(confirms, 1);
  assert.match(h.get('[data-compatibility-error]').textContent, /COMPATIBILITY_STATE_FULL/);
  h.consent(); await h.view.confirm(); h.tick(3000);
  assert.equal(confirms, 1);
  h.view.dispose();
});

test('notification acknowledgement never calls experimental confirmation', async () => {
  const requests = [];
  const current = report();
  const h = harness({
    compatibilityReport: async () => current,
    acknowledgeCompatibilityNotice: async request => { requests.push(request); return { ...current, notified: true }; },
    confirmCompatibility: async () => assert.fail('not a consent action'),
  });
  await settle(); await h.view.dismiss();
  assert.deepEqual(requests, [{ expectedRevision: 'missing', hostVersion: current.hostVersion, pluginVersion: current.pluginVersion }]);
  assert.equal(h.get('[data-compatibility-notice]').hidden, true);
  h.view.dispose();
});

test('missing service, failed report and timeout remain independent and bounded', async () => {
  const missing = harness(null);
  assert.match(missing.get('[data-compatibility-state]').textContent, /原有设置/);
  missing.view.dispose();
  let reads = 0, resolve;
  const h = harness({ compatibilityReport: () => { reads++; return new Promise(done => { resolve = done; }); } });
  await settle();
  h.tick(4000);
  assert.match(h.get('[data-compatibility-error]').textContent, /COMPATIBILITY_READ_TIMEOUT/);
  void h.view.refresh(); h.tick(3000);
  assert.equal(reads, 1);
  resolve(report());
  await settle();
  assert.equal(h.values.length, 0, 'late timeout results do not become a successful report');
  h.view.bind({ compatibilityReport: async () => { throw Object.assign(new Error('offline'), { code: 'COMPATIBILITY_UNAVAILABLE' }); } });
  await settle();
  assert.match(h.get('[data-compatibility-state]').textContent, /不会改变已有搜索或设置状态/);
  h.view.dispose();
});

test('replaced service and disposed view reject old responses and release timers and listeners', async () => {
  let reply;
  const h = harness({ compatibilityReport: () => new Promise(done => { reply = done; }) });
  await settle();
  h.view.bind({ compatibilityReport: async () => report({ hostVersion: '0.4.0', channel: 'stable' }) });
  await settle();
  reply(experimental());
  await settle();
  assert.match(h.get('[data-compatibility-pair]').textContent, /0.4.0/);
  assert.equal(h.get('[data-compatibility-confirm]').hidden, true);
  h.view.dispose(); h.view.dispose();
  assert.equal(h.schedules.size, 0);
  assert.equal(h.document.listeners.size, 0);
  assert.equal(h.get('[data-compatibility-refresh]').listeners.size, 0);
});

test('disposal before the request microtask never dispatches a new compatibility read', async () => {
  let reads = 0;
  const h = harness({ compatibilityReport: async () => { reads++; return report(); } });
  h.view.dispose();
  await settle();
  assert.equal(reads, 0);
  assert.equal(h.schedules.size, 0);
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
  assert.equal((await connection.compatibility.compatibilityReport()).hostVersion, '0.3.0-rc.1');
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

test('compatibility failure and recovery never recreate an existing settings controller', async () => {
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
  assert.match(shadow.querySelector('[data-dsg-compatibility]').querySelector('[data-compatibility-error]').textContent, /COMPATIBILITY_UNAVAILABLE/);
  h.remote.grokSearchCompatibility.compatibilityReport = async () => ({ ok: true, value: report({
    optionalFeatures: {
      settings: { available: false, code: 'SETTINGS_UNAVAILABLE' },
      chat: { available: true, code: null }, github: { available: true, code: null },
    },
  }) });
  await shadow.querySelector('[data-dsg-compatibility]').querySelector('[data-compatibility-refresh]').dispatch('click');
  assert.equal(h.routeCreates(), 1);
  assert.equal(h.routeDisposes(), 0, 'a report does not own the actual settings service lifetime');
  cleanup();
  assert.equal(h.routeDisposes(), 1);
  await dispose();
});
