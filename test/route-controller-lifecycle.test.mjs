import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRouteController } from '../src/ui/route-controller.mjs';
import { NUM, normCard, normHub, validateHub } from '../src/ui/route-form.mjs';

const source = createRouteController.toString();
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `production section: ${start}`);
  return source.slice(from, to);
}
function element(value = '') {
  const classes = new Set(), attrs = new Map([['value', value]]);
  return {
    value, dataset: {}, disabled: false, readOnly: false, isConnected: true, type: 'text',
    hidden: false, innerHTML: 'dialog content',
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    removeAttribute: name => attrs.delete(name), getAttribute: name => attrs.get(name) ?? null,
    setAttribute: (name, next) => attrs.set(name, next), focus() {}, setSelectionRange() {},
  };
}
function harness() {
  const inputs = [], buttons = [], requests = [], commits = [], errors = [], timers = [];
  const dlg = element(), overlay = element(), saveButton = element();
  const $ = selector => {
    const key = selector.match(/^input\[data-k="([^"]+)"\]$/)?.[1];
    return key ? inputs.find(input => input.dataset.k === key)
      : selector === '[data-a=save]' ? saveButton : null;
  };
  dlg.querySelector = $;
  const context = vm.createContext({
    NUM, normCard, normHub, validateHub,
    D: null, S: { busy: false, capabilities: { secretsAllowed: true },
      config: { path: '/config.toml', revision: 'before', quotaRevision: 'effective-before' } }, disposed: false, secretEpoch: 0,
    dlg, overlay, quotaView: null, closeTimer: 0, overlayEntranceTimer: 0, shakeCleanups: new Map(),
    $, $$: selector => selector === 'input[data-k]' ? inputs : selector === '[data-a=eye], [data-a=copy]' ? buttons : [],
    active: () => null, clone: structuredClone, reduced: () => false,
    remote: {
      reveal() { assert.fail('The new UI must not dispatch unguarded credential reads'); },
      revealWithIdentity(request) {
        return new Promise((resolve, reject) => requests.push({ ...request, resolve, reject }));
      },
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    hideStripTip() {}, shake() {}, svg: () => '', rowOf: () => null,
    refreshDialog() { context.D.v = { err: {}, warn: {} }; },
    operationError(error) { errors.push(error); }, resetClearConfirmation() {}, cancelTest() {},
    syncAll() {}, lockDialog() {},
    commitCard: async draft => { commits.push({ dialog: context.D, draft }); },
    commitHub: async draft => { commits.push({ dialog: context.D, draft }); },
  });
  // Execute the actual lifecycle functions with controlled async replies and
  // DOM boundaries. The browser suite exercises the complete mounted factory.
  vm.runInContext([
    section('const HIDDEN =', 'const configFields ='),
    section('const CARD_FIELDS =', 'const S ='),
    'const dialogBusy = () => !!D && (D.saving || D.clearing);',
    section('function hideOverlay(cb)', 'overlay.addEventListener('),
    section('function fieldReadOnly(k)', 'function keyIn('),
    section('function isDirty()', 'function refreshDialog('),
    section('async function revealFor(k)', 'function setMode('),
    section('async function save()', 'function cardUpdates('),
    section('function stepper(k, v)', 'function hubBody('),
  ].join('\n'), context);
  const marker = vm.runInContext('HIDDEN', context) + 'configured';
  function open(id = 'grok', draft = { key: marker, gwKey: marker, model: 'before', enabled: true }) {
    const dialog = {
      kind: 'card', id, draft: structuredClone(draft), base: structuredClone(draft),
      configBaseline: structuredClone(context.S.config),
      fields: {}, revealing: new Map(), closed: false, touched: new Set(), edited: new Set(),
      show: {}, saving: false, clearing: false, submitted: false, clearTimer: 0,
    };
    dialog.orig = JSON.stringify(context.normCard(dialog.base));
    context.D = dialog;
    inputs.length = 0; buttons.length = 0;
    for (const [key, value] of Object.entries(draft)) {
      for (const [name, item] of Array.isArray(value) ? value.map((v, index) => [`${key}.${index}`, v]) : [[key, value]]) {
        const input = element(item === marker ? '' : String(item));
        input.dataset.k = name;
        if (item === marker) input.dataset.hidden = 'true';
        inputs.push(input);
        if (['key', 'gwKey', 'token', 'keys'].includes(key)) {
          for (const action of ['eye', 'copy']) {
            const button = element(); button.dataset = { a: action, k: name }; buttons.push(button);
          }
        }
      }
    }
    return dialog;
  }
  return { context, open, inputs, buttons, requests, commits, errors, timers, dlg, overlay, marker };
}

test('reveals deduplicate per field while native and gateway keys resolve independently', async () => {
  const h = harness(), dialog = h.open();
  const native = h.context.revealFor('key'), duplicate = h.context.revealFor('key');
  const gateway = h.context.revealFor('gwKey');
  assert.deepEqual(h.requests.map(request => request.key), ['grok_api_key', 'openai_compatible_api_key']);
  for (const request of h.requests) {
    assert.equal(request.expectedRevision, dialog.configBaseline.revision);
    assert.equal(request.configIdentity, dialog.configBaseline.quotaRevision);
  }
  h.requests[1].resolve({ value: 'gateway-value' });
  assert.equal(await gateway, true);
  assert.equal(dialog.draft.gwKey, 'gateway-value');
  assert.equal(dialog.draft.key, h.marker);
  assert.equal(dialog.revealing.size, 1);
  h.requests[0].resolve({ value: 'native-value' });
  assert.deepEqual(await Promise.all([native, duplicate]), [true, true]);
  assert.equal(dialog.draft.key, 'native-value');
  assert.equal(dialog.revealing.size, 0);
  assert.equal(h.context.isDirty(), false);
});

test('Tavily row reveals share only the keys field request', async () => {
  const h = harness(), dialog = h.open('tavily', { keys: [h.marker, h.marker], enabled: true });
  const first = h.context.revealFor('keys.0'), second = h.context.revealFor('keys.1');
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ value: 'first-value, second-value' });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(Array.from(dialog.draft.keys), ['first-value', 'second-value']);
  assert.equal(h.context.isDirty(), false);
});

test('save waits for every reveal, including another field started while waiting', async () => {
  const h = harness(), dialog = h.open();
  dialog.draft.model = 'after';
  const native = h.context.revealFor('key');
  const saving = h.context.save(), duplicateSave = h.context.save();
  const gateway = h.context.revealFor('gwKey');
  h.requests[0].resolve({ value: 'native-value' });
  await native;
  assert.equal(h.commits.length, 0);
  assert.equal(dialog.submitted, false);
  h.requests[1].resolve({ value: 'gateway-value' });
  await Promise.all([gateway, saving, duplicateSave]);
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].dialog, dialog);
  assert.equal(h.commits[0].draft.key, 'native-value');
  assert.equal(h.commits[0].draft.gwKey, 'gateway-value');
  assert.equal(h.commits[0].draft.model, 'after');
  assert.equal(h.context.S.busy, false);
});

test('a save waiting on a closed dialog cannot submit the replacement dialog', async () => {
  const h = harness(), old = h.open();
  old.draft.model = 'discarded';
  const revealing = h.context.revealFor('key'), saving = h.context.save();
  h.context.closeDialog(true);
  const next = h.open('exa', { key: h.marker, url: 'next-draft' });
  h.requests[0].resolve({ value: 'old-value' });
  assert.equal(await revealing, false);
  await saving;
  assert.equal(next.submitted, false);
  assert.equal(next.draft.key, h.marker);
  assert.equal(old.revealing.size, 0);
  assert.equal(h.commits.length, 0);
});

test('old reveal failures cannot report errors in a replacement dialog', async () => {
  const h = harness(); h.open();
  const revealing = h.context.revealFor('key');
  h.context.closeDialog(true);
  h.open('exa', { key: h.marker });
  h.requests[0].reject(new Error('old request failed'));
  assert.equal(await revealing, false);
  assert.equal(h.errors.length, 0);
});

test('a new authorization epoch can reveal while an obsolete same-field request is pending', async () => {
  const h = harness(), dialog = h.open();
  dialog.draft.model = 'after';
  const obsolete = h.context.revealFor('key'), saving = h.context.save();
  h.context.secretEpoch++;
  const fresh = h.context.revealFor('key');
  assert.equal(h.requests.length, 2);
  h.requests[0].resolve({ value: 'obsolete-value' });
  assert.equal(await obsolete, false);
  await saving;
  assert.equal(h.commits.length, 0);
  assert.equal(dialog.revealing.size, 1, 'old completion must not delete the replacement request');
  h.requests[1].resolve({ value: 'fresh-value' });
  assert.equal(await fresh, true);
  assert.equal(dialog.draft.key, 'fresh-value');
  assert.equal(dialog.revealing.size, 0);
});

test('a reloaded dialog baseline invalidates pending key reveals and permits a fresh request', async () => {
  const h = harness(), dialog = h.open();
  const obsolete = h.context.revealFor('key');
  h.context.S.config = { path: '/config.toml', revision: 'reloaded', quotaRevision: 'reloaded' };
  dialog.configBaseline = structuredClone(h.context.S.config);
  const fresh = h.context.revealFor('key');
  const count = h.requests.length;
  h.requests[0].resolve({ value: 'old-baseline-key' });
  if (h.requests[1]) h.requests[1].resolve({ value: 'reloaded-baseline-key' });
  const results = await Promise.all([obsolete, fresh]);
  assert.equal(count, 2);
  assert.deepEqual(results, [false, true]);
  assert.equal(dialog.base.key, 'reloaded-baseline-key');
  assert.equal(dialog.draft.key, 'reloaded-baseline-key');
  assert.equal(dialog.revealing.size, 0);
});

test('pending reveals reject changed paths, revisions and effective identities without changing their dialog baseline', async () => {
  for (const change of [{ path: '/other.toml' }, { revision: 'other' }, { quotaRevision: 'effective-other' }]) {
    const h = harness(), dialog = h.open(), baseline = dialog.configBaseline;
    const revealing = h.context.revealFor('key');
    h.context.S.config = { ...h.context.S.config, ...change };
    h.requests[0].resolve({ value: 'obsolete-value' });
    assert.equal(await revealing, false);
    assert.equal(dialog.configBaseline, baseline);
    assert.equal(dialog.draft.key, h.marker);
    assert.equal(h.inputs.find(input => input.dataset.k === 'key').value, '');
    assert.equal(dialog.revealing.size, 0);
  }
});

test('a stale dialog cannot start a reveal even after an obsolete same-field request finishes', async () => {
  const h = harness(), dialog = h.open();
  const revealing = h.context.revealFor('key');
  h.context.S.config = { ...h.context.S.config, quotaRevision: 'effective-other' };
  h.requests[0].reject(new Error('obsolete failure'));
  assert.equal(await revealing, false);
  assert.equal(h.errors.length, 0);
  const next = h.context.revealFor('key');
  const calls = h.requests.length;
  h.requests[1]?.resolve({ value: 'wrong-baseline-value' });
  assert.equal(await next, false);
  assert.equal(calls, 1);
  assert.equal(dialog.draft.key, h.marker);
  assert.equal(h.errors.at(-1)?.code, 'CONFIG_CONFLICT');
});

test('a revealed value cannot cross an in-place change to the captured config baseline', async () => {
  const h = harness(), dialog = h.open();
  const revealing = h.context.revealFor('key');
  dialog.configBaseline.quotaRevision = 'effective-other';
  h.context.S.config.quotaRevision = 'effective-other';
  h.requests[0].resolve({ value: 'obsolete-value' });
  assert.equal(await revealing, false);
  assert.equal(dialog.draft.key, h.marker);
});

test('an unpolled host identity change rejects a reveal before reading another target credential', async () => {
  const h = harness(), dialog = h.open(), before = structuredClone(h.context.S.config);
  let identity = before.quotaRevision, reads = 0;
  h.context.remote.revealWithIdentity = async request => {
    if (request.expectedRevision !== before.revision || request.configIdentity !== identity) {
      throw Object.assign(new Error('host target changed'), { code: 'CONFIG_CONFLICT' });
    }
    reads++;
    return { value: 'other-target-value' };
  };
  identity = 'host-other-identity';
  assert.equal(await h.context.revealFor('key'), false);
  assert.equal(reads, 0);
  assert.equal(dialog.draft.key, h.marker);
  assert.equal(h.context.S.config.path, before.path);
  assert.equal(h.errors.at(-1)?.code, 'CONFIG_CONFLICT');
});

test('a missing identity-aware reveal fails with a recovery action and never calls legacy reveal', async () => {
  for (const missing of [true, false]) {
    const h = harness(), dialog = h.open();
    if (missing) delete h.context.remote.revealWithIdentity;
    else h.context.remote.revealWithIdentity = async () => {
      throw Object.assign(new Error('synthetic old backend'), { code: 'gateway/method_not_found' });
    };
    assert.equal(await h.context.revealFor('key'), false);
    assert.equal(dialog.draft.key, h.marker);
    assert.match(h.errors.at(-1)?.message || '', /重新打开设置/);
    assert.match(h.errors.at(-1)?.message || '', /重启 DSH/);
  }
});

test('accepted external config changes invalidate a reveal even if the original configuration returns', async () => {
  const h = harness(), dialog = h.open(), before = structuredClone(h.context.S.config);
  Object.assign(h.context, {
    META: { grok: {} }, HUB_FIELDS: {}, sourceChain: { view: () => ({ order: [] }) },
    providersFrom: () => ({ grok: {} }), providerIdentity: () => '',
    ingestRoute() {}, buildRows() {}, syncOpenCardBaseline() {}, logView: null,
  });
  Object.assign(h.context.S, { order: [], identity: {}, checked: {}, bad: {}, providerBad: {}, hub: {},
    configRevision: before.revision, configIdentity: before.quotaRevision, configPath: before.path });
  vm.runInContext(section('function acceptSnapshot(', 'let readTask ='), h.context);
  const revealing = h.context.revealFor('key');
  const snapshot = config => ({ config, control: { policy: 'required' }, capabilities: { secretsAllowed: true }, plugin: {} });
  h.context.acceptSnapshot(snapshot({ ...before, quotaRevision: 'effective-other' }), { value: {} });
  h.context.acceptSnapshot(snapshot(before), { value: {} });
  h.requests[0].resolve({ value: 'obsolete-value' });
  assert.equal(await revealing, false);
  assert.equal(dialog.draft.key, h.marker);
});

test('copy completion callbacks are inert after disposal for either clipboard outcome', async () => {
  for (const failed of [false, true]) {
    const h = harness();
    h.open('grok', { key: 'synthetic-copy-value' });
    let callback;
    h.context.navigator = { clipboard: { writeText() {
      return { then(resolve, reject) { callback = failed ? reject : resolve; } };
    } } };
    h.context.toast = () => assert.fail('A disposed controller must not publish clipboard feedback');
    await h.context.copyKey(h.buttons.find(button => button.dataset.a === 'copy'));
    h.context.disposed = true;
    assert.equal(typeof callback, 'function');
    assert.doesNotThrow(() => callback(new Error('synthetic clipboard rejection')));
  }
});

test('a disposed toast never reads or mutates the removed DOM', () => {
  const context = vm.createContext({
    disposed: true,
    $() { assert.fail('A disposed toast must not read its DOM'); },
  });
  vm.runInContext(section('function toast(text,', 'const shakeCleanups ='), context);
  assert.doesNotThrow(() => context.toast('late feedback'));
});

test('a failed current reveal remains visible and prevents a waiting save', async () => {
  const h = harness(), dialog = h.open();
  dialog.draft.model = 'after';
  const revealing = h.context.revealFor('key'), saving = h.context.save();
  const error = new Error('current request failed');
  h.requests[0].reject(error);
  assert.equal(await revealing, false);
  await saving;
  assert.deepEqual(h.errors, [error]);
  assert.equal(h.commits.length, 0);
  assert.equal(dialog.revealing.size, 0);
});

test('dialog close erases sensitive values and attributes before the unchanged exit animation', () => {
  const h = harness();
  const dialog = h.open('grok', { key: 'native-value', gwKey: 'gateway-value', token: 'token-value', keys: ['list-value'], model: 'public-model' });
  const secrets = h.inputs.filter(input => input.dataset.k !== 'model');
  h.context.closeDialog(true);
  assert.equal(h.context.D, null);
  assert.equal(dialog.closed, true);
  for (const input of secrets) {
    assert.equal(input.value, '');
    assert.equal(input.getAttribute('value'), null);
    assert.equal(input.type, 'password');
    assert.equal(input.disabled, true);
  }
  assert.ok(h.buttons.every(button => button.disabled));
  assert.equal(h.inputs.find(input => input.dataset.k === 'model').value, 'public-model');
  assert.equal(h.overlay.hidden, false);
  assert.equal(h.overlay.classList.contains('is-closing'), true);
  assert.equal(h.dlg.innerHTML, 'dialog content');
  assert.deepEqual(h.timers.map(timer => timer.ms), [150]);
  h.timers[0].fn();
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.dlg.innerHTML, '');
});

test('hub validation uses the runtime fallback and response character ranges', () => {
  const h = harness();
  const base = { extra: 3, fallback: 5, timeout: 60, cache: 256, maxChars: 45000, budget: 120 };
  h.context.D = { kind: 'hub', base, fields: {} };
  for (const [key, values] of [['fallback', [0, 10]], ['maxChars', [100, 500000]]]) {
    for (const value of values) assert.equal(h.context.vHub({ ...base, [key]: value }).err[key], undefined, `${key}=${value}`);
  }
  for (const [key, values] of [['fallback', [-1, 11, 0.5]], ['maxChars', [99, 500001, 100.5]]]) {
    for (const value of values) assert.ok(h.context.vHub({ ...base, [key]: value }).err[key], `${key}=${value}`);
  }
});

test('missing optional services or a broken settings connection never count as a credential check', () => {
  const context = vm.createContext({});
  vm.runInContext(section('const untestedCode =', 'function flashRow(') + '\nglobalThis.unchecked = untestedCode;', context);
  for (const code of ['SOURCE_UNAVAILABLE', 'GROK_UNAVAILABLE', 'GITHUB_UNAVAILABLE',
    'GROK_PROGRAM_UNAVAILABLE', 'GITHUB_TOOL_REGISTRATION_FAILED', 'SETTINGS_UNAVAILABLE',
    'SETTINGS_OPERATION_FAILED', 'gateway/method_not_found']) {
    assert.equal(context.unchecked(code), true, code);
  }
  for (const code of ['HTTP_401', 'GROK_NETWORK_ERROR', 'HTTP_503']) assert.equal(context.unchecked(code), false, code);
});

test('clearing a read-only authentication card cannot delete its shared file fields', async () => {
  const h = harness(), requests = [];
  const mine = h.open('grok', { authReadOnly: true, enabled: true, url: 'https://readonly.example', model: 'readonly-model', key: '' });
  mine.fields = { grok_api_url: { source: 'file', readOnly: false }, grok_model: { source: 'file', readOnly: false } };
  Object.assign(h.context, {
    servingSupp: () => null, toast() {},
    saveConfig: async updates => { requests.push(updates); return null; },
  });
  vm.runInContext(section('async function clearArm(', '/* 右上角开关'), h.context);
  const button = element();
  await h.context.clearArm(button);
  await h.context.clearArm(button);
  assert.equal(requests.length, 0);
  assert.equal(h.context.D, mine);
  assert.equal(mine.clearing, false);
});

test('destination drafts cannot cross a known config path or effective identity change with identical file bytes', async () => {
  for (const changed of [{ path: '/config-b.toml' }, { quotaRevision: 'effective-b' }]) {
    const baseline = { path: '/config-a.toml', revision: 'same-file-hash', quotaRevision: 'effective-a', exists: true,
      fields: { grok_api_url: { value: 'https://api.example', source: 'file' } } };
    const config = { ...structuredClone(baseline), ...changed }, requests = [];
    const context = vm.createContext({
      S: { config }, disposed: false, accessGeneration: 0, clone: structuredClone, updateConfig() {},
      remote: { save: async request => {
        requests.push(request);
        return { config: { ...config, revision: 'saved' } };
      } },
    });
    vm.runInContext(section('async function saveConfig(', 'async function savePreference('), context);
    await assert.rejects(context.saveConfig({ grok_api_url: 'https://new-destination.example' }, baseline),
      error => error.code === 'CONFIG_CONFLICT');
    assert.equal(requests.length, 0);
  }
});

test('an effective identity change requires explicit review even for an unrelated nonsecret draft edit', async () => {
  const baseline = { path: '/config.toml', revision: 'same-file-hash', quotaRevision: 'effective-a', exists: true,
    fields: { grok_model: { value: 'before', source: 'file' } } };
  const config = { ...structuredClone(baseline), quotaRevision: 'effective-b' }, requests = [];
  const context = vm.createContext({
    S: { config }, disposed: false, accessGeneration: 0, clone: structuredClone, updateConfig() {},
    remote: { save: async request => { requests.push(request); return { config: { ...config, revision: 'saved' } }; },
      saveWithIdentity: async request => { requests.push(request); return { config: { ...config, revision: 'saved' } }; } },
  });
  vm.runInContext(section('async function saveConfig(', 'async function savePreference('), context);
  await assert.rejects(context.saveConfig({ grok_model: 'after' }, baseline), error => error.code === 'CONFIG_CONFLICT');
  assert.equal(requests.length, 0);
});

test('new saves use the existing effective identity and never call the legacy endpoint', async () => {
  const config = { path: '/config.toml', revision: 'before', quotaRevision: 'effective-before', exists: true, fields: {} };
  const saved = { ...config, revision: 'saved', quotaRevision: 'effective-saved' };
  const requests = [];
  const context = vm.createContext({
    S: { config }, disposed: false, secretEpoch: 0, accessGeneration: 0, clone: structuredClone, updateConfig() {},
    remote: {
      save() { assert.fail('The new UI must not dispatch unguarded saves'); },
      saveWithIdentity: async request => { requests.push(request); return { config: saved }; },
    },
  });
  vm.runInContext(section('async function saveConfig(', 'async function savePreference('), context);
  const receipt = await context.saveConfig({ grok_model: 'after' }, config);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), {
    expectedRevision: 'before', configIdentity: 'effective-before', updates: { grok_model: 'after' },
  });
  assert.equal(receipt.path, saved.path);
  assert.equal(receipt.quotaRevision, saved.quotaRevision);
  assert.equal(receipt.after, saved.revision);
});

test('a late save reply cannot replace a configuration switched while it was pending', async () => {
  const before = { path: '/config-a.toml', revision: 'before', quotaRevision: 'effective-a', exists: true, fields: {} };
  const saved = { ...before, revision: 'saved', quotaRevision: 'effective-saved' };
  const other = { ...before, path: '/config-b.toml', quotaRevision: 'effective-b' };
  let complete, updates = 0;
  const context = vm.createContext({
    disposed: false, accessGeneration: 0, secretEpoch: 0, S: { config: before }, clone: structuredClone,
    updateConfig(config) { updates++; context.S.config = config; },
    remote: { saveWithIdentity: () => new Promise(resolve => { complete = resolve; }) },
  });
  vm.runInContext(section('async function saveConfig(', 'async function savePreference('), context);
  const task = context.saveConfig({ grok_model: 'saved-to-a' });
  const rejection = assert.rejects(task, { code: 'CONFIG_COMMIT_UNCERTAIN' });
  context.S.config = other;
  context.secretEpoch++;
  complete({ config: saved });
  await rejection;
  assert.equal(updates, 0);
  assert.equal(context.S.config, other);
});

test('a late private switch reply cannot replace newer preference state', async () => {
  const before = { revision: 'before', value: { grokEnabled: true, githubReadEnabled: false } };
  const saved = { revision: 'saved', value: { grokEnabled: false, githubReadEnabled: false } };
  const current = { revision: 'newer', value: { grokEnabled: true, githubReadEnabled: true } };
  let complete;
  const context = vm.createContext({
    disposed: false, accessGeneration: 0, stateGeneration: 0, snapshotSignature: null,
    S: { prefs: before, prov: { grok: { enabled: true }, github: { enabled: false } } },
    remote: { savePreferences: () => new Promise(resolve => { complete = resolve; }) },
  });
  vm.runInContext(section('async function savePreference(', 'function configUndo('), context);
  const task = context.savePreference('grok', false);
  const rejection = assert.rejects(task, { code: 'PREFERENCES_COMMIT_UNCERTAIN' });
  context.S.prefs = current;
  context.S.prov.github.enabled = true;
  complete(saved);
  await rejection;
  assert.equal(context.S.prefs, current);
  assert.equal(context.S.prov.grok.enabled, true);
  assert.equal(context.S.prov.github.enabled, true);
});

function undoHarness({ changed = {}, failure = null, missing = false } = {}) {
  const receipt = { before: 'before', after: 'saved', path: '/config.toml', quotaRevision: 'effective-saved', undo: true };
  const config = { path: receipt.path, revision: receipt.after, quotaRevision: receipt.quotaRevision, ...changed };
  const requests = [], errors = [], preferences = [], updates = [];
  const context = vm.createContext({
    disposed: false, secretEpoch: 0, accessGeneration: 0, S: { config, busy: false, capabilities: { secretsAllowed: true } },
    updateConfig: value => updates.push(value), operationError: error => errors.push(error), syncAll() {}, toast() {},
    savePreference: async (...args) => preferences.push(args),
    remote: {
      restoreConfig() { assert.fail('New undo cannot call the legacy restore endpoint'); },
      ...(!missing ? { restoreConfigWithIdentity: async request => {
        requests.push(request);
        if (failure) throw Object.assign(new Error('Synthetic restore failure'), { code: failure });
        return { config: { ...config, revision: 'restored' } };
      } } : {}),
    },
  });
  vm.runInContext(section('function configUndo(', 'function normalizeCode('), context);
  return { context, receipt, requests, errors, preferences, updates };
}

test('config and card undo restore only the saved target identity before reverting a private switch', async () => {
  for (const card of [false, true]) {
    const h = undoHarness();
    const undo = card ? h.context.cardUndo(h.receipt, 'grok', false, true) : h.context.configUndo(h.receipt);
    await undo();
    assert.deepEqual(JSON.parse(JSON.stringify(h.requests)), [{
      expectedRevision: 'saved', configIdentity: 'effective-saved', revision: 'before',
    }]);
    assert.equal(h.errors.length, 0);
    assert.equal(h.updates.length, 1);
    assert.equal(h.preferences.length, card ? 1 : 0);
    assert.equal(h.context.S.busy, false);
  }
});

test('config and card undo reject a known different path, revision or credential identity without dispatch', async () => {
  for (const card of [false, true]) {
    for (const changed of [{ path: '/other.toml' }, { revision: 'other' }, { quotaRevision: 'effective-other' }]) {
      const h = undoHarness({ changed });
      const undo = card ? h.context.cardUndo(h.receipt, 'grok', false, true) : h.context.configUndo(h.receipt);
      await undo();
      assert.equal(h.requests.length, 0);
      assert.equal(h.updates.length, 0);
      assert.equal(h.preferences.length, 0);
      assert.equal(h.errors.at(-1)?.code, 'CONFIG_CONFLICT');
    }
  }
});

test('an unpolled undo target change or missing new endpoint cannot fall back or revert the private switch', async () => {
  for (const options of [{ failure: 'CONFIG_CONFLICT' }, { failure: 'gateway/method_not_found' }, { missing: true }]) {
    for (const card of [false, true]) {
      const h = undoHarness(options);
      const undo = card ? h.context.cardUndo(h.receipt, 'grok', false, true) : h.context.configUndo(h.receipt);
      await undo();
      assert.equal(h.requests.length, options.missing ? 0 : 1);
      assert.equal(h.updates.length, 0);
      assert.equal(h.preferences.length, 0);
      assert.equal(h.errors.at(-1)?.code, options.missing ? 'SETTINGS_RESTORE_UNAVAILABLE' : options.failure);
      if (options.failure !== 'CONFIG_CONFLICT') {
        assert.match(h.errors.at(-1)?.message || '', /重新打开设置/);
        assert.match(h.errors.at(-1)?.message || '', /重启 DSH/);
      }
    }
  }
});

test('a late restore reply cannot replace the current target or proceed to the private switch', async () => {
  for (const card of [false, true]) {
    const h = undoHarness();
    let complete;
    h.context.clone = structuredClone;
    h.context.accessGeneration = 0;
    h.context.secretEpoch = 0;
    h.context.remote.restoreConfigWithIdentity = () => new Promise(resolve => { complete = resolve; });
    const undo = card ? h.context.cardUndo(h.receipt, 'grok', false, true) : h.context.configUndo(h.receipt);
    const task = undo();
    const current = { ...h.context.S.config, path: '/changed-target.toml', quotaRevision: 'changed-effective' };
    h.context.S.config = current;
    h.context.secretEpoch++;
    complete({ config: { path: h.receipt.path, revision: 'restored', quotaRevision: 'restored-effective' } });
    await task;
    assert.equal(h.updates.length, 0);
    assert.equal(h.preferences.length, 0);
    assert.equal(h.errors.at(-1)?.code, 'CONFIG_COMMIT_UNCERTAIN');
    assert.equal(h.context.S.config, current);
    assert.equal(h.context.S.busy, false);
  }
});

test('a missing identity-aware save endpoint fails without legacy fallback or a config retry', async () => {
  for (const missing of [true, false]) {
    const config = { path: '/config.toml', revision: 'before', quotaRevision: 'effective-before', fields: {} };
    let guardedCalls = 0;
    const context = vm.createContext({
      S: { config }, disposed: false, secretEpoch: 0, accessGeneration: 0, clone: structuredClone, updateConfig() {},
      refresh() { assert.fail('An unavailable endpoint is not a revision conflict'); },
      remote: {
        save() { assert.fail('The legacy endpoint cannot weaken identity checking'); },
        ...(!missing ? { saveWithIdentity() {
          guardedCalls++;
          return Promise.reject(Object.assign(new Error('old backend'), { code: 'gateway/method_not_found' }));
        } } : {}),
      },
    });
    vm.runInContext(section('async function saveConfig(', 'async function savePreference('), context);
    await assert.rejects(context.saveConfig({ grok_model: 'after' }), error => {
      assert.equal(error.code, missing ? 'SETTINGS_SAVE_UNAVAILABLE' : 'gateway/method_not_found');
      assert.match(error.message, /重新打开设置/);
      assert.match(error.message, /重启 DSH/);
      assert.doesNotMatch(error.message, /更新插件/);
      return true;
    });
    assert.equal(guardedCalls, missing ? 0 : 1);
  }
});

test('a conflict retry cannot rebase a draft across a different config path or effective identity', async () => {
  for (const change of [{ path: '/other.toml' }, { quotaRevision: 'effective-other' }]) {
    const config = { path: '/config.toml', revision: 'before', quotaRevision: 'effective-before', fields: {} };
    const requests = [];
    const dispatch = async request => {
      requests.push(request);
      if (requests.length === 1) throw Object.assign(new Error('conflict'), { code: 'CONFIG_CONFLICT' });
      return { config: { ...config, revision: 'saved' } };
    };
    const context = vm.createContext({
      S: { config }, disposed: false, secretEpoch: 0, accessGeneration: 0, clone: structuredClone, updateConfig() {},
      refresh: async () => { context.S.config = { ...config, ...change }; },
      remote: { save: dispatch, saveWithIdentity: dispatch },
    });
    vm.runInContext(section('async function saveConfig(', 'async function savePreference('), context);
    await assert.rejects(context.saveConfig({ timeout_seconds: 65 }), error => error.code === 'CONFIG_CONFLICT');
    assert.equal(requests.length, 1);
  }
});

test('a comment-only config conflict can retry once with the unchanged effective identity', async () => {
  const config = { path: '/config.toml', revision: 'before', quotaRevision: 'effective-before', fields: {} };
  const requests = [];
  const context = vm.createContext({
    S: { config }, disposed: false, secretEpoch: 0, accessGeneration: 0, clone: structuredClone, updateConfig() {},
    refresh: async () => { context.S.config = { ...config, revision: 'comment-edit' }; },
    remote: { saveWithIdentity: async request => {
      requests.push(request);
      if (requests.length === 1) throw Object.assign(new Error('conflict'), { code: 'CONFIG_CONFLICT' });
      return { config: { ...config, revision: 'saved' } };
    } },
  });
  vm.runInContext(section('async function saveConfig(', 'async function savePreference('), context);
  await context.saveConfig({ timeout_seconds: 65 }, config);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].expectedRevision, 'comment-edit');
  assert.equal(requests[1].configIdentity, 'effective-before');
});

test('disposing during a preference conflict reread prevents a retry and late state replacement', async () => {
  const requests = [], before = { revision: 'old', value: { grokEnabled: true } };
  let resolveRead, reading;
  const started = new Promise(resolve => { reading = resolve; });
  const context = vm.createContext({
    S: { prefs: before, prov: { grok: { enabled: true } } }, disposed: false, accessGeneration: 0,
    remote: {
      savePreferences: async request => {
        requests.push(request);
        if (requests.length === 1) throw Object.assign(new Error('conflict'), { code: 'PREFERENCES_CONFLICT' });
        return { revision: 'saved', value: request.value };
      },
      preferences: () => new Promise(resolve => { resolveRead = resolve; reading(); }),
    },
  });
  vm.runInContext(section('async function savePreference(', 'function configUndo('), context);
  const saving = context.savePreference('grok', false);
  await started;
  context.disposed = true;
  resolveRead({ revision: 'new', value: { grokEnabled: true } });
  await saving;
  assert.equal(requests.length, 1);
  assert.equal(context.S.prefs, before);
});

test('disposing during a config conflict reread prevents a new save request', async () => {
  const config = { path: '/config.toml', revision: 'before', quotaRevision: 'effective-before',
    fields: { grok_model: { value: 'before' } } };
  const requests = [];
  let resolveRead, reading;
  const started = new Promise(resolve => { reading = resolve; });
  const context = vm.createContext({
    S: { config }, disposed: false, secretEpoch: 0, accessGeneration: 0, clone: structuredClone, updateConfig() {},
    refresh: () => new Promise(resolve => { resolveRead = resolve; reading(); }),
    remote: { saveWithIdentity: async request => {
      requests.push(request);
      if (requests.length === 1) throw Object.assign(new Error('conflict'), { code: 'CONFIG_CONFLICT' });
      return { config: { ...config, revision: 'saved' } };
    } },
  });
  vm.runInContext(section('async function saveConfig(', 'async function savePreference('), context);
  const saving = context.saveConfig({ grok_model: 'after' });
  await started;
  context.disposed = true;
  resolveRead();
  await saving;
  assert.equal(requests.length, 1);
});

test('an earlier settings poll cannot replace a successful config save', async () => {
  const before = { path: '/config.toml', revision: 'before', quotaRevision: 'effective-before', exists: true,
    fields: { grok_model: { value: 'before' } } };
  const saved = { ...before, revision: 'saved', fields: { grok_model: { value: 'after' } } };
  let resolveRead;
  const context = vm.createContext({
    disposed: false, secretEpoch: 0, accessGeneration: 0, stateGeneration: 0, readTask: null, drag: null,
    snapshotSignature: null, logView: null, S: { config: before }, clone: structuredClone,
    CARD_FIELDS: {}, acceptSnapshot(snapshot) { context.S.config = snapshot.config; },
    syncAll() {}, denyPrivateAccess() {},
    remote: {
      snapshot: () => new Promise(resolve => { resolveRead = resolve; }), preferences: async () => ({}),
      saveWithIdentity: async () => ({ config: saved }),
    },
  });
  vm.runInContext([
    section('async function refresh(', 'function schedulePoll('),
    section('function updateConfig(', 'function operationError('),
    section('async function saveConfig(', 'async function savePreference('),
  ].join('\n'), context);
  const reading = context.refresh();
  await context.saveConfig({ grok_model: 'after' });
  assert.equal(context.S.config.revision, 'saved');
  resolveRead({ config: before });
  await reading;
  assert.equal(context.S.config.revision, 'saved');
  assert.equal(context.S.config.fields.grok_model.value, 'after');
});

test('an earlier settings poll cannot replace a successful preference save', async () => {
  const before = { revision: 'before', value: { grokEnabled: true } };
  const saved = { revision: 'saved', value: { grokEnabled: false } };
  let resolveRead;
  const context = vm.createContext({
    disposed: false, accessGeneration: 0, stateGeneration: 0, readTask: null, drag: null,
    snapshotSignature: null, logView: null, S: { prefs: before, prov: { grok: { enabled: true } } },
    acceptSnapshot(_snapshot, prefs) { context.S.prefs = prefs; },
    syncAll() {}, denyPrivateAccess() {},
    remote: {
      snapshot: () => new Promise(resolve => { resolveRead = resolve; }), preferences: async () => before,
      savePreferences: async () => saved,
    },
  });
  vm.runInContext([
    section('async function refresh(', 'function schedulePoll('),
    section('async function savePreference(', 'function configUndo('),
  ].join('\n'), context);
  const reading = context.refresh();
  await context.savePreference('grok', false);
  assert.equal(context.S.prefs, saved);
  resolveRead({});
  await reading;
  assert.equal(context.S.prefs, saved);
});

test('an earlier settings poll cannot replace a successful program preparation', async () => {
  const before = { phase: 'discovering', program: null }, ready = { phase: 'ready', program: { version: '0.1.26' } };
  let complete;
  const context = vm.createContext({
    disposed: false, accessGeneration: 0, stateGeneration: 0, readTask: null, drag: null,
    snapshotSignature: null, logView: null, D: { kind: 'hub' }, S: { program: before },
    dialogBusy: () => false, acceptSnapshot(snapshot) { context.S.program = snapshot.program; },
    syncAll() {}, denyPrivateAccess() {}, renderHead() {}, renderHub() {}, toast() {},
    programPhase: () => 'ready', programSource: () => 'private-cache',
    remote: { snapshot: () => new Promise(resolve => { complete = resolve; }), preferences: async () => ({}),
      prepareProgram: async () => ready },
  });
  vm.runInContext([
    section('async function refresh(', 'function schedulePoll('),
    section('async function redetect(', 'async function commitHub('),
  ].join('\n'), context);
  const reading = context.refresh();
  await context.redetect(element());
  assert.equal(context.S.program, ready);
  complete({ program: before });
  await reading;
  assert.equal(context.S.program, ready);
});

test('late program preparation cannot publish or refresh after its access lifetime changes', async () => {
  for (const outcome of ['success', 'failure']) {
    let finish;
    const before = { phase: 'error', program: null }, newer = { phase: 'discovering', program: null };
    const button = element(), renders = [], reads = [], notices = [];
    const context = vm.createContext({
      disposed: false, accessGeneration: 0, stateGeneration: 0, snapshotSignature: null,
      D: { kind: 'hub' }, S: { program: before }, dialogBusy: () => false,
      refresh: async () => { reads.push('refresh'); }, operationError: error => notices.push(error),
      syncAll: () => renders.push('sync'), renderHead: () => renders.push('head'), renderHub: () => renders.push('hub'),
      toast: message => notices.push(message), programPhase: () => 'ready', programSource: () => 'private-cache',
      remote: { prepareProgram: () => new Promise((resolve, reject) => {
        finish = () => outcome === 'success' ? resolve({ phase: 'ready', program: {} })
          : reject(Object.assign(new Error('obsolete preparation failure'), { code: 'GROK_PROGRAM_UNAVAILABLE' }));
      }) },
    });
    vm.runInContext(section('async function redetect(', 'async function commitHub('), context);
    const pending = context.redetect(button);
    context.accessGeneration++;
    context.S.program = newer;
    finish();
    await pending;
    assert.equal(context.S.program, newer);
    assert.deepEqual(reads, []);
    assert.deepEqual(renders, []);
    assert.deepEqual(notices, []);
    assert.equal(context.S.busy, false);
  }
});

for (const outcome of ['success', 'failure']) {
  test('real snapshot revocation and reauthorization reject late program preparation ' + outcome, async () => {
    const h = controlLifecycleStateHarness(), renders = [], reads = [], notices = [];
    const button = element(), newer = { phase: 'discovering', program: null };
    let finish;
    Object.assign(h.context, {
      D: { kind: 'hub', draft: { timeout: 75 }, base: { timeout: 60 } },
      dialogBusy: () => false, active: () => null,
      syncAll: () => renders.push('sync'), renderHead: () => renders.push('head'), renderHub: () => renders.push('hub'),
      operationError: error => notices.push(error), toast: message => notices.push(message),
    });
    h.context.remote.snapshot = async () => { reads.push('snapshot'); return structuredClone(h.state.snapshot); };
    h.context.remote.preferences = async () => { reads.push('preferences'); return structuredClone(h.state.preferences); };
    h.context.remote.prepareProgram = () => new Promise((resolve, reject) => {
      finish = () => outcome === 'success' ? resolve({ phase: 'ready', program: {} })
        : reject(Object.assign(new Error('obsolete preparation failure'), { code: 'GROK_PROGRAM_UNAVAILABLE' }));
    });
    vm.runInContext(section('async function redetect(', 'async function commitHub('), h.context);
    const accessAtStart = h.context.accessGeneration;
    const pending = h.context.redetect(button);
    h.state.snapshot.program = newer;
    h.state.snapshot.capabilities = { secretsAllowed: false };
    await h.context.refresh({ force: true, readLog: false });
    assert.equal(h.context.S.capabilities.secretsAllowed, false);
    assert.equal(h.context.accessGeneration, accessAtStart + 1);
    h.state.snapshot.capabilities = { secretsAllowed: true };
    await h.context.refresh({ force: true, readLog: false });
    assert.equal(h.context.S.capabilities.secretsAllowed, true);
    assert.equal(h.context.accessGeneration, accessAtStart + 1, 'Reauthorization cannot revive the revoked access lifetime.');
    assert.equal(h.context.D.draft.timeout, 75);
    const currentProgram = h.context.S.program;
    assert.equal(currentProgram.phase, 'discovering');
    renders.length = reads.length = notices.length = 0;
    finish();
    await pending;
    assert.equal(h.context.S.program, currentProgram);
    assert.deepEqual(reads, []);
    assert.deepEqual(renders, []);
    assert.deepEqual(notices, []);
    assert.equal(h.context.S.busy, false);
    assert.equal(button.disabled, false);
  });
}

test('a stale settings poll still revokes private access without restoring old config', async () => {
  for (const rejectRead of [false, true]) {
    let finish;
    const context = vm.createContext({
      disposed: false, accessGeneration: 0, stateGeneration: 0, readTask: null, drag: null,
      snapshotSignature: null, logView: null, S: { capabilities: { secretsAllowed: true } },
      acceptSnapshot() { assert.fail('stale config must not be accepted'); }, syncAll() {},
      denyPrivateAccess(error) {
        assert.equal(error.code, 'SETTINGS_SECURE_CONNECTION_REQUIRED');
        context.S.capabilities = { secretsAllowed: false };
        return true;
      },
      remote: {
        snapshot: () => new Promise((resolve, reject) => { finish = rejectRead ? reject : resolve; }),
        preferences: async () => ({}),
      },
    });
    vm.runInContext(section('async function refresh(', 'function schedulePoll('), context);
    const reading = context.refresh();
    context.stateGeneration++;
    finish(rejectRead ? Object.assign(new Error('restricted'), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' })
      : { capabilities: { secretsAllowed: false } });
    await reading;
    assert.equal(context.S.capabilities.secretsAllowed, false);
  }
});

test('an explicit draft reload cannot restore an authorization revoked while it was pending', async () => {
  const dialog = { kind: 'card', id: 'grok',
    base: { key: 'private-draft', enabled: true }, draft: { key: 'private-draft', enabled: true } };
  let resolveRead, accepted = 0;
  const context = vm.createContext({
    disposed: false, accessGeneration: 0, stateGeneration: 0, D: dialog,
    S: { capabilities: { secretsAllowed: true }, prov: { grok: dialog.base } },
    dialogBusy: () => false, clone: structuredClone, lockDialog() {}, $: () => null,
    fieldReadOnly: () => false, configFields: () => ({}), normCard, isSet: () => true,
    renderCard() {}, quotaView: null, operationError() {},
    acceptSnapshot(snapshot) { accepted++; context.S.capabilities = snapshot.capabilities; context.S.config = snapshot.config; },
    remote: {
      snapshot: () => new Promise(resolve => { resolveRead = resolve; }),
      preferences: async () => ({}),
    },
  });
  vm.runInContext(section('async function reloadDialogDraft(', '// One retry for an unrelated external write.'), context);
  const reloading = context.reloadDialogDraft();
  context.accessGeneration++;
  context.S.capabilities = { secretsAllowed: false };
  resolveRead({ config: { fields: {} }, capabilities: { secretsAllowed: true } });
  await reloading;
  assert.equal(accepted, 0);
  assert.equal(context.S.capabilities.secretsAllowed, false);
  assert.equal(context.S.busy, false);
  assert.equal(dialog.saving, false);
});

test('reloading a disabled tokenless GitHub draft follows fresh-panel consent defaults', async () => {
  for (const id of ['github', 'tavily']) {
    for (const enableDraft of [false, true]) {
      const base = id === 'github' ? { enabled: false, token: '' }
        : { enabled: false, keys: [''], url: '' };
      const context = vm.createContext({
        disposed: false, accessGeneration: 0, stateGeneration: 0, D: null,
        S: { capabilities: { secretsAllowed: true }, prov: { [id]: base }, config: { fields: {} } },
        META: { [id]: {} }, clone: structuredClone, dialogBusy: () => false, normCard,
        configFields: () => ({}), fieldReadOnly: () => false,
        closePop() {}, rowOf: () => null, showOverlay() {}, renderCard() {},
        requestAnimationFrame() {}, initialFocus() {}, lockDialog() {}, quotaView: null,
        acceptSnapshot(snapshot) { context.S.config = snapshot.config; },
        operationError(error) { throw error; },
        remote: { snapshot: async () => ({ config: { fields: {} } }), preferences: async () => ({}) },
      });
      vm.runInContext([
        section('function isSet(', 'const isOn ='),
        section('function openCard(', '/* ---------- 中继弹窗'),
        section('async function reloadDialogDraft(', '// One retry for an unrelated external write.'),
      ].join('\n'), context);
      context.openCard(id);
      const freshBase = structuredClone(context.D.base);
      if (enableDraft) context.D.draft.enabled = true;
      const expectedDraft = structuredClone(context.D.draft);
      context.D.operationError = { code: 'CONFIG_CONFLICT' };
      await context.reloadDialogDraft();
      assert.deepEqual(context.D.base, freshBase);
      assert.deepEqual(context.D.draft, expectedDraft);
      assert.equal(context.D.orig, JSON.stringify(normCard(freshBase)));
      assert.equal(context.D.operationError.code, 'CONFIG_RELOADED');
    }
  }
});

test('actual GitHub redirect and invalid-response codes have specific route and log explanations', () => {
  const context = vm.createContext({});
  vm.runInContext([
    section('function normalizeCode(', 'function ingestRoute('),
    section('const ERR_TEXT =', 'function failureHelp('),
    'globalThis.describeError = errText;',
  ].join('\n'), context);
  for (const [code, status, text] of [
    ['GITHUB_REDIRECT', '跳转', 'GitHub 资源已重定向，请使用当前资源的官方链接'],
    ['GITHUB_RESPONSE_INVALID', '响应', 'GitHub 返回数据无效'],
  ]) {
    const result = context.failureInfo(code);
    assert.equal(result.code, code);
    assert.equal(result.status, status);
    assert.equal(context.describeError(code), text);
  }
});

test('a late ordering save failure cannot roll back a disposed settings DOM', async () => {
  let rejectSave;
  const context = vm.createContext({
    disposed: false, S: { busy: false, order: ['tavily', 'exa'] },
    cancelTest() {}, syncAll() {}, pumpWires() {},
    sourceChain: { plan: () => ({}) },
    saveConfig: () => new Promise((_resolve, reject) => { rejectSave = reject; }),
    flipTo() { assert.fail('Disposed DOM must not be reordered'); },
    refresh() { assert.fail('Disposed controller must not refresh'); },
    operationError() { assert.fail('Disposed controller must not display errors'); },
  });
  vm.runInContext(section('async function commitOrder(', "colList.addEventListener('keydown'"), context);
  const saving = context.commitOrder(['exa', 'tavily'], ['tavily', 'exa']);
  context.disposed = true;
  rejectSave(Object.assign(new Error('busy'), { code: 'CONFIG_BUSY' }));
  await saving;
  assert.equal(context.S.busy, false);
});

test('route state survives a remount only for the same settings connection', () => {
  const memory = {}, firstRemote = {}, secondRemote = {};
  const initialize = remote => vm.runInNewContext([
    source.slice(source.indexOf('\n') + 1, source.indexOf('let disposed =')),
    section('function blankProv()', 'function providersFrom('),
    'S',
  ].join('\n'), { memory, remote, SUPP: ['tavily'], clone: structuredClone });
  const state = initialize(firstRemote);
  state.lastRoute = { at: 9000, outcome: 'failed', served: 'tavily' };
  state.lastRouteAt = 9000;
  state.checked = { tavily: { 0: { status: 'failed', source: 'test' } } };
  state.bad = { tavily: { 0: '401' } };
  state.readDismissed = true;
  vm.runInNewContext(section('Object.assign(memory, {', '// No cleartext draft/config'), {
    memory, remote: firstRemote, S: state, clone: structuredClone,
  });
  const same = initialize(firstRemote);
  assert.equal(same.lastRouteAt, 9000);
  assert.equal(same.bad.tavily[0], '401');
  const changed = initialize(secondRemote);
  assert.equal(changed.lastRoute, null, 'A different server must not inherit a failed route.');
  assert.equal(changed.lastRouteAt, 0, 'Its earlier clock must not suppress new route receipts.');
  assert.equal(Object.keys(changed.checked).length, 0);
  assert.equal(Object.keys(changed.bad).length, 0);
  assert.equal(changed.readDismissed, false);
});

test('card preference completion cannot render or alter a replacement dialog after disposal', async () => {
  for (const rejected of [false, true]) {
    let finish, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const mine = { id: 'grok', base: { enabled: true }, draft: { enabled: false }, saving: true };
    const context = vm.createContext({
      disposed: false, D: mine, S: { prov: { grok: mine.base } }, clone: structuredClone,
      saveConfig: async () => ({ after: 'saved' }),
      savePreference: () => new Promise((resolve, reject) => { finish = rejected ? reject : resolve; started(); }),
      CRED: { grok: [] }, configFields: () => ({}), normCard,
      closeDialog() { assert.fail('A disposed save must not close another dialog.'); },
      syncAll() { assert.fail('A disposed save must not render.'); },
      operationError() { assert.fail('A disposed save must not report to another dialog.'); },
    });
    vm.runInContext(section('async function commitCard(', 'async function clearArm('), context);
    const saving = context.commitCard();
    await waiting;
    context.disposed = true;
    context.D = { id: 'github' };
    finish(rejected ? new Error('preference save failed') : {});
    await saving;
    assert.equal(mine.saving, true, 'The obsolete dialog is no longer owned by the callback.');
  }
});

test('an invalidated hub reload releases the actual disabled controls', async () => {
  const mine = { kind: 'hub', base: { timeout: 60 }, draft: { timeout: 65 } };
  const control = element();
  let resolveRead;
  const context = vm.createContext({
    disposed: false, D: mine, S: {}, accessGeneration: 0, stateGeneration: 0,
    dialogBusy: () => false, clone: structuredClone,
    lockDialog() { control.disabled = true; },
    renderHub() { assert.equal(mine.saving, false); control.disabled = false; },
    acceptSnapshot() { assert.fail('An obsolete reply must not be accepted.'); },
    operationError(error) { throw error; },
    remote: { snapshot: () => new Promise(resolve => { resolveRead = resolve; }), preferences: async () => ({}) },
  });
  vm.runInContext(section('async function reloadDialogDraft(', '// One retry for an unrelated external write.'), context);
  const reloading = context.reloadDialogDraft();
  assert.equal(control.disabled, true);
  context.accessGeneration++;
  resolveRead({});
  await reloading;
  assert.equal(context.S.busy, false);
  assert.equal(mine.saving, false);
  assert.equal(control.disabled, false, 'Closing or retrying must remain possible.');
});

for (const revocation of ['SETTINGS_AUTH_REQUIRED', 'SETTINGS_SECURE_CONNECTION_REQUIRED', 'snapshot']) {
  test('an independent ' + revocation + ' revocation invalidates a pending provider diagnostic', async () => {
    const h = harness(), requests = [], cancellations = [], nodes = new Map();
    let finish;
    Object.assign(h.context.S, { order: ['tavily'], checked: {}, bad: {}, providerBad: {}, identity: {}, hub: {},
      prov: { grok: { enabled: true }, tavily: { enabled: true } } });
    Object.assign(h.context, {
      gen: 0, accessGeneration: 0, snapshotSignature: null, performance: { now: () => 0 },
      logView: { cancel() {}, restrict() {}, read() {} },
      HUB_FIELDS: {}, sourceChain: { view: () => ({ order: ['tavily'] }) },
      providersFrom: () => h.context.S.prov, providerIdentity: () => 'unchanged',
      ingestRoute() {}, buildRows() {}, syncOpenCardBaseline() {},
      $: selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
      routeStatus: () => 'ready', grokOn: () => true, isOn: () => false, enabledSupp: () => ['tavily'],
      META: { grok: { name: 'Grok' }, tavily: { name: 'Tavily' } }, SUPP: ['tavily'],
      reduced: () => true, uuid: () => 'diagnostic-operation', normalizeCode: value => value, errText: value => value,
      rowOf: () => element(), T: { trace: 1000 }, untestedCode: () => false,
      renderHead() {}, renderSummary() {}, renderBanner() {}, syncRows() {}, pumpWires() {},
      tickTestProgress() {}, clearToasts() {}, clearLit() {}, toast() {}, hideStripTip() {},
      rememberCheck() { assert.fail('A diagnostic from the revoked access lifetime must not validate credentials.'); },
    });
    h.context.remote.diagnoseProvider = request => {
      requests.push(request);
      return new Promise(resolve => { finish = resolve; });
    };
    h.context.remote.cancelDiagnosis = async request => { cancellations.push(request); return {}; };
    vm.runInContext([
      section('function acceptSnapshot(', 'let readTask ='),
      section('function denyPrivateAccess(', 'async function refresh('),
      section('function cancelTest(', 'function cancelOwnedDiagnosis('),
      section('async function runTest(', '/* ---------- Mount-local theme'),
    ].join('\n'), h.context);
    const pending = h.context.runTest();
    if (revocation !== 'snapshot') h.context.denyPrivateAccess({ code: revocation });
    else h.context.acceptSnapshot({ config: h.context.S.config,
      control: { phase: 'required', policy: 'required', available: true },
      capabilities: { secretsAllowed: false }, plugin: {} }, { value: {} });
    h.context.S.capabilities = { secretsAllowed: true };
    finish({ provider: 'grok', status: 'ok', code: 'OK', keys: [] });
    await pending;
    assert.equal(requests.length, 1);
    assert.equal(cancellations.length, 1);
    assert.equal(h.context.S.testing, false);
    assert.equal(h.context.S.diagnosticOperation, null);
    assert.equal(Object.keys(h.context.S.checked).length, 0);
  });
}

for (const code of ['SETTINGS_AUTH_REQUIRED', 'SETTINGS_SECURE_CONNECTION_REQUIRED']) {
  test('provider diagnostics stop on ' + code + ' without marking credentials as failed', async () => {
    for (const rejected of [true, false]) {
      const h = harness(), denied = [], requests = [], nodes = new Map();
      Object.assign(h.context.S, { order: ['tavily'], checked: {}, providerBad: {} });
      Object.assign(h.context, {
        gen: 0, accessGeneration: 0, snapshotSignature: null, performance: { now: () => 0 },
        logView: { cancel() {}, restrict: value => denied.push(value) },
        $: selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
        routeStatus: () => 'ready', grokOn: () => true, isOn: () => false, enabledSupp: () => ['tavily'],
        META: { grok: { name: 'Grok' }, tavily: { name: 'Tavily' } }, SUPP: ['tavily'],
        reduced: () => true, uuid: () => 'diagnostic-operation', normalizeCode: value => value, errText: value => value,
        rowOf: () => element(), T: { trace: 1000 }, untestedCode: () => false,
        renderHead() {}, renderSummary() {}, renderBanner() {}, syncRows() {}, pumpWires() {},
        tickTestProgress() {}, clearToasts() {}, clearLit() {}, toast() {},
        rememberCheck() { assert.fail('A settings access refusal must not become a failed credential check.'); },
      });
      h.context.remote.diagnoseProvider = async request => {
        requests.push(request);
        if (rejected) throw Object.assign(new Error('denied'), { code });
        return { provider: request.provider, status: 'failed', code, message: 'denied', keys: [] };
      };
      vm.runInContext([
        section('function denyPrivateAccess(', 'async function refresh('),
        section('function cancelTest(', 'function cancelOwnedDiagnosis('),
        section('async function runTest(', '/* ---------- Mount-local theme'),
      ].join('\n'), h.context);
      await h.context.runTest();
      assert.equal(h.context.S.capabilities.secretsAllowed, false);
      assert.deepEqual(denied, [code]);
      assert.equal(requests.length, 1, 'Do not diagnose more sources after the connection refuses access.');
      assert.equal(h.context.S.testing, false);
      assert.equal(h.context.S.diagnosticOperation, null);
      assert.equal(Object.keys(h.context.S.checked).length, 0);
    }
  });

  test('GitHub preview rejection ' + code + ' revokes private UI access immediately', async () => {
    const h = harness(), mine = h.open('github', { token: 'synthetic-token', enabled: true });
    const outcome = element(), button = element(), denied = [];
    mine.show.token = true;
    Object.assign(h.context, {
      accessGeneration: 0, snapshotSignature: null, uuid: () => 'preview-operation',
      logView: { restrict: value => denied.push(value) },
      renderCard() {},
      $: selector => selector === '.search-result' ? outcome : null,
    });
    h.context.remote.previewGithubConnection = async () => { throw Object.assign(new Error('denied'), { code }); };
    h.context.remote.cancelDiagnosis = async () => ({});
    vm.runInContext([
      section('function denyPrivateAccess(', 'async function refresh('),
      section('async function testGithubDraft(', 'async function revealFor('),
    ].join('\n'), h.context);
    await h.context.testGithubDraft(button);
    assert.equal(h.context.S.capabilities.secretsAllowed, false);
    assert.equal(h.context.secretEpoch, 1);
    assert.deepEqual(denied, [code]);
    assert.equal(Object.keys(mine.show).length, 0);
    assert.equal(mine.githubOperation, null);
  });
}


test('primary model-route help survives a diagnostic but is cleared by a newer check', () => {
  const context = vm.createContext({ S: { checked: { grok: { 0: { source: 'test' } } }, bad: { grok: '404' } },
    normalizeCode: code => String(code).replace(/^HTTP_/i, ''), Date });
  vm.runInContext(section('function rememberPrimaryFailure(', 'function rowFault('), context);
  vm.runInContext(section('function rememberCheck(', 'function reconcileChecks('), context);
  context.rememberPrimaryFailure({ evidence: 'primary-request', provider: 'grok', protocol: 'responses', reason: 'model_not_found' });
  assert.match(context.primaryHelp('grok', 'HTTP_404'), /模型或路由不存在/);
  assert.equal(context.primaryHelp('exa', '404'), '');
  assert.equal(context.primaryHelp('grok', '401'), '');
  context.rememberCheck('grok', 0, '404', 'search');
  assert.equal(context.primaryHelp('grok', '404'), '');
  context.rememberPrimaryFailure({ evidence: 'primary-request', provider: 'grok', protocol: 'responses', reason: 'secret remote body' });
  assert.equal(context.primaryHelp('grok', '404'), '');
});

function controlRecoveryHarness() {
  const calls = [], notices = [], accepted = [], nodes = new Map();
  const state = {
    snapshot: {
      control: { available: true, phase: 'incomplete', policy: 'released', revision: 1, canStop: false,
        completionCommitted: false, routeVerified: false, routeChanged: false, releaseOperationId: 'pending-release',
        error: { code: 'CONTROL_RELEASE_PENDING', message: 'Recovery pending.' } },
      program: { phase: 'ready' }, config: { path: '/config.toml', revision: 'before', error: null },
      capabilities: { secretsAllowed: true },
    },
    preferences: { revision: 'preferences', value: {} },
  };
  const context = vm.createContext({
    disposed: false, controlRetrying: false, accessGeneration: 0, stateGeneration: 0, secretEpoch: 0,
    readTask: null, snapshotSignature: null, drag: null, logView: null, quotaView: null, D: null,
    S: { loading: false, busy: false, testing: false, plugin: true, rpcError: null,
      ...structuredClone(state.snapshot), prov: { grok: { enabled: true } }, lastRoute: null },
    $: selector => {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    esc: String, svg: () => '', reduced: () => true, pumpWires() {}, setTimeout: () => 0,
    servingSupp: () => null, unknownFallback: () => false, grokOn: () => true, isBad: () => false,
    enabledSupp: () => [], isSet: () => true,
    acceptSnapshot(snapshot, preferences) {
      accepted.push(snapshot);
      Object.assign(context.S, snapshot, { prefs: preferences, loading: false, rpcError: null });
      context.S.plugin = !(snapshot.control.policy === 'released' && snapshot.control.routeVerified
        && snapshot.control.completionCommitted);
      context.syncAll(true);
    },
    syncAll() { calls.push('render'); context.renderBanner(); },
    toast(text, options) { notices.push({ text, options }); },
    remote: {
      async retryControlRelease() { calls.push('retryControlRelease'); return structuredClone(state.snapshot); },
      async snapshot() { calls.push('snapshot'); return structuredClone(state.snapshot); },
      async preferences() { calls.push('preferences'); return structuredClone(state.preferences); },
      stop() { assert.fail('Recovery must not initiate a new stop.'); },
      start() { assert.fail('Recovery must not implicitly start a legacy owner.'); },
    },
  });
  vm.runInContext([
    section('function denyPrivateAccess(', 'async function refresh('),
    section('async function refresh(', 'function schedulePoll('),
    section('function operationError(', '// An external write'),
    section('function routeStatus()', 'const STATUS_TEXT'),
    section('let bannerHtml =', 'function renderFoot('),
  ].join('\n'), context);
  return { context, state, calls, notices, accepted, banner: () => context.$('#bannerSlot') };
}

test('control recovery refreshes the current root state and deduplicates the retry action', async () => {
  const h = controlRecoveryHarness(), oldReply = structuredClone(h.state.snapshot);
  let complete;
  h.context.remote.retryControlRelease = () => {
    h.calls.push('retryControlRelease');
    return new Promise(resolve => { complete = resolve; });
  };
  const retrying = h.context.retryControl();
  assert.equal(h.context.S.busy, true);
  assert.match(h.banner().innerHTML, /disabled aria-busy="true"/);
  await h.context.retryControl();
  assert.equal(h.calls.filter(call => call === 'retryControlRelease').length, 1);
  h.state.snapshot.control = { ...oldReply.control, phase: 'required', policy: 'required', error: null };
  complete(oldReply);
  await retrying;
  assert.equal(h.accepted.length, 1);
  assert.equal(h.context.S.control.phase, 'required', 'Read the current root rather than the retry receipt.');
  assert.equal(h.context.S.control.error, null);
  assert.deepEqual(h.calls.filter(call => call !== 'render'), ['retryControlRelease', 'snapshot', 'preferences']);
  assert.equal(h.context.S.busy, false);
  assert.equal(h.context.controlRetrying, false);
});

test('failed control recovery retains the actual root error code after its state refresh', async () => {
  const h = controlRecoveryHarness(), code = 'CONTROL_ROUTE_COUNTER_REQUIRED';
  h.state.snapshot.control.error = { code, message: 'The host counter is unavailable.' };
  h.context.remote.retryControlRelease = async () => {
    h.calls.push('retryControlRelease');
    throw Object.assign(new Error('The host counter is unavailable.'), { code });
  };
  await h.context.retryControl();
  assert.equal(h.context.S.control.error.code, code);
  assert.equal(h.context.routeStatus(), 'ctlerr');
  assert.match(h.banner().innerHTML, new RegExp(code));
  assert.match(h.banner().innerHTML, /搜索恢复或重新检查当前状态/);
  assert.doesNotMatch(h.banner().innerHTML, /否则仅检查状态|重试继续未完成的停用/);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].text, new RegExp(code));
  assert.equal(h.context.S.busy, false);
  assert.equal(h.context.controlRetrying, false);
});

test('control recovery drains an earlier settings read before refreshing the recovered state', async () => {
  const h = controlRecoveryHarness(), before = structuredClone(h.state.snapshot);
  let complete, reads = 0;
  h.context.remote.snapshot = () => {
    h.calls.push('snapshot');
    return ++reads === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(structuredClone(h.state.snapshot));
  };
  const reading = h.context.refresh({ force: true });
  const retrying = h.context.retryControl();
  assert.equal(h.calls.includes('retryControlRelease'), false);
  h.state.snapshot.control = { ...before.control, phase: 'required', policy: 'required', error: null };
  complete(before);
  await reading;
  await retrying;
  assert.equal(h.accepted.length, 2);
  assert.equal(h.context.S.control.phase, 'required');
  assert.deepEqual(h.calls.filter(call => call !== 'render'), [
    'snapshot', 'preferences', 'retryControlRelease', 'snapshot', 'preferences',
  ]);
});

test('an invalidated controller cannot dispatch recovery after an earlier read settles', async () => {
  for (const change of ['dispose', 'access']) {
    const h = controlRecoveryHarness();
    let complete;
    h.context.readTask = new Promise(resolve => { complete = resolve; });
    const retrying = h.context.retryControl(), renders = h.calls.filter(call => call === 'render').length;
    if (change === 'dispose') h.context.disposed = true; else h.context.accessGeneration++;
    complete();
    await retrying;
    assert.equal(h.calls.includes('retryControlRelease'), false, change);
    assert.equal(h.calls.filter(call => call === 'render').length, renders, change);
    assert.equal(h.notices.length, 0, change);
    assert.equal(h.context.S.busy, false, change);
    assert.equal(h.context.controlRetrying, false, change);
  }
});

test('late recovery success or failure cannot refresh or render a disposed or access-changed controller', async () => {
  for (const change of ['dispose', 'access']) for (const rejected of [false, true]) {
    const h = controlRecoveryHarness();
    let complete;
    h.context.remote.retryControlRelease = () => {
      h.calls.push('retryControlRelease');
      return new Promise((resolve, reject) => { complete = rejected ? reject : resolve; });
    };
    const retrying = h.context.retryControl(), renders = h.calls.filter(call => call === 'render').length;
    if (change === 'dispose') h.context.disposed = true; else h.context.accessGeneration++;
    complete(rejected ? Object.assign(new Error('Late owner failure.'), { code: 'CONTROL_OWNER_ABSENT' }) : h.state.snapshot);
    await retrying;
    assert.equal(h.calls.includes('snapshot'), false, change);
    assert.equal(h.calls.filter(call => call === 'render').length, renders, change);
    assert.equal(h.accepted.length, 0, change);
    assert.equal(h.notices.length, 0, change);
    assert.equal(h.context.S.busy, false, change);
    assert.equal(h.context.controlRetrying, false, change);
  }
});

test('a late recovery state read cannot publish a legacy hint or render after its access lifetime changes', async () => {
  for (const change of ['dispose', 'access']) for (const rejected of [false, true]) {
    const h = controlRecoveryHarness();
    let complete;
    h.context.remote.retryControlRelease = async () => {
      throw Object.assign(new Error('Legacy owner is unavailable.'), { code: 'CONTROL_OWNER_ABSENT' });
    };
    h.context.remote.snapshot = () => new Promise((resolve, reject) => { complete = rejected ? reject : resolve; });
    const retrying = h.context.retryControl();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    assert.equal(typeof complete, 'function');
    const renders = h.calls.filter(call => call === 'render').length, notices = h.notices.length;
    if (change === 'dispose') h.context.disposed = true; else h.context.accessGeneration++;
    complete(rejected ? Object.assign(new Error('Late read failure.'), { code: 'SETTINGS_UNAVAILABLE' }) : h.state.snapshot);
    await retrying;
    assert.equal(h.calls.filter(call => call === 'render').length, renders, change);
    assert.equal(h.accepted.length, 0, change);
    assert.equal(h.notices.length, notices, change);
    assert.equal(h.context.S.busy, false, change);
    assert.equal(h.context.controlRetrying, false, change);
  }
});

test('a recovery authorization failure revokes access before any follow-up state read', async () => {
  const h = controlRecoveryHarness();
  h.context.remote.retryControlRelease = async () => {
    throw Object.assign(new Error('Owner authorization was revoked.'), { code: 'SETTINGS_AUTH_REQUIRED' });
  };
  await h.context.retryControl();
  assert.equal(h.context.accessGeneration, 1);
  assert.equal(h.context.S.capabilities.secretsAllowed, false);
  assert.equal(h.calls.includes('snapshot'), false);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].text, /SETTINGS_AUTH_REQUIRED/);
  assert.equal(h.context.S.busy, false);
  assert.equal(h.context.controlRetrying, false);
});

test('unsupported legacy recovery and missing owners offer native guidance without stop or start', async () => {
  for (const failure of ['missing-method', 'gateway/method_not_found', 'SETTINGS_UNAVAILABLE',
    'CONTROL_SETTINGS_UNAVAILABLE', 'CONTROL_OWNER_ABSENT', 'observed-missing-owner']) {
    const h = controlRecoveryHarness();
    h.state.snapshot.control = { ...h.state.snapshot.control, available: false, phase: 'unavailable',
      error: { code: 'CONTROL_SETTINGS_UNAVAILABLE', message: 'The control owner is unavailable.' } };
    if (failure === 'missing-method') delete h.context.remote.retryControlRelease;
    else if (failure !== 'observed-missing-owner') h.context.remote.retryControlRelease = async () => {
      throw Object.assign(new Error('Legacy recovery is unavailable.'), { code: failure });
    };
    await h.context.retryControl();
    assert.equal(h.context.S.control.error.code, 'CONTROL_SETTINGS_UNAVAILABLE', failure);
    assert.match(h.banner().innerHTML, /CONTROL_SETTINGS_UNAVAILABLE.*原生开关/, failure);
    assert.ok(h.notices.some(notice => /原生开关.*宿主日志/.test(notice.text)), failure);
    const hint = h.notices.at(-1);
    assert.match(hint.text, /本页不会更改原生开关/, failure);
    assert.doesNotMatch(hint.text, /重启|reboot|restart/i, failure);
    assert.equal(h.context.S.busy, false, failure);
    assert.equal(h.context.controlRetrying, false, failure);
  }
});

test('starting is neutral while genuine control errors and confirmed releases keep their own states', async () => {
  for (const row of [
    { control: { phase: 'starting', available: true, error: null }, status: 'connecting', tone: 'info' },
    { control: { phase: 'starting', available: false, error: null }, status: 'connecting', tone: 'info' },
    { control: { phase: 'starting', error: { code: 'CONTROL_RELEASE_PENDING' } }, status: 'ctlerr', tone: 'err' },
    { control: { phase: 'starting', error: { code: 'COMPATIBILITY_INITIALIZATION_PENDING' } }, status: 'ctlerr', tone: 'err' },
    { control: { phase: 'required', available: false, error: null }, status: 'ctlerr', tone: 'err' },
    { control: { phase: 'released', available: false, error: null, routeVerified: true, completionCommitted: true },
      status: 'off', tone: 'info' },
  ]) {
    const h = controlRecoveryHarness();
    h.state.snapshot.control = { ...h.state.snapshot.control, ...row.control };
    await h.context.refresh({ force: true });
    assert.equal(h.context.routeStatus(), row.status);
    assert.match(h.banner().innerHTML, new RegExp(`data-tone="${row.tone}"`));
    if (row.status === 'connecting') {
      assert.match(h.banner().innerHTML, /正在启动搜索组件.*当前尚未确认搜索路由/);
      assert.doesNotMatch(h.banner().innerHTML, /data-act="retry-control"|接管状态异常/);
    } else if (row.status === 'ctlerr') {
      assert.match(h.banner().innerHTML, /data-act="retry-control"/);
      if (row.control.error) assert.match(h.banner().innerHTML, new RegExp(row.control.error.code));
    } else assert.match(h.banner().innerHTML, /已恢复原搜索设置/);
  }
});

function controlLifecycleStateHarness() {
  const h = controlRecoveryHarness(), card = element();
  card.classList.toggle = () => {};
  Object.assign(h.context, {
    card, META: { grok: { name: 'Grok' }, github: { name: 'GitHub' } }, HUB_FIELDS: {},
    sourceChain: { view: () => ({ order: [] }) },
    providersFrom: () => ({ grok: { enabled: true }, github: { enabled: false } }),
    providerIdentity: () => 'synthetic-config',
    isOn: id => id === 'grok', servingSupps: () => [],
    programPhase: () => '等待程序', programSource: () => '自动检测',
    cancelTest() { assert.fail('A lifecycle-only snapshot must not mutate preferences or restart tests.'); },
    ingestRoute() {}, buildRows() {}, syncOpenCardBaseline() {},
  });
  Object.assign(h.context.S, {
    order: [], identity: {}, checked: {}, bad: {}, providerBad: {}, hub: {},
    configRevision: h.context.S.config.revision, configPath: h.context.S.config.path,
  });
  // Use production snapshot ingestion, not the retry harness's sentinel state.
  vm.runInContext([
    section('function acceptSnapshot(', 'let readTask ='),
    section('const STATUS_TEXT =', 'function rowState('),
    section('function rowState(', 'const RANK ='),
    section('function wireDefs(', 'function portEl('),
    section('function renderHead(', 'function programPhase('),
    section('async function runTest(', '/* ---------- Mount-local theme'),
  ].join('\n'), h.context);
  h.context.syncAll = () => {
    h.calls.push('render');
    h.context.renderHead();
    h.context.renderBanner();
  };
  return h;
}

test('starting after historical release completion stays neutral until the current runtime is ready', async () => {
  for (const available of [true, false]) {
    const h = controlLifecycleStateHarness();
    h.state.snapshot.control = { ...h.state.snapshot.control, available, phase: 'starting', policy: 'released',
      completionCommitted: true, routeVerified: true, error: null };
    await h.context.refresh({ force: true });
    assert.equal(h.context.S.plugin, true);
    assert.equal(h.context.routeStatus(), 'connecting');
    assert.equal(h.context.card.dataset.plugin, 'on');
    assert.equal(h.context.$('#statusText').textContent, '正在启动…');
    assert.equal(h.context.$('#nodeOfficial').getAttribute('aria-hidden'), 'true');
    assert.match(h.banner().innerHTML, /data-tone="info".*正在启动搜索组件/);
    assert.doesNotMatch(h.banner().innerHTML, /已恢复原搜索设置|重新启用|data-act="retry-control"|接管状态异常/);
    assert.equal(h.context.$('#testBtn').disabled, true);
    assert.equal(h.context.wireDefs().find(wire => wire.id === 'dsh-off').ws, 'hidden');
    h.state.snapshot.control = { ...h.state.snapshot.control, available: true, phase: 'required', policy: 'required' };
    await h.context.refresh({ force: true });
    assert.equal(h.context.routeStatus(), 'live');
    assert.equal(h.context.$('#testBtn').disabled, false);
    assert.equal(h.calls.includes('retryControlRelease'), false);
    assert.equal(h.notices.length, 0);
  }
});

test('a stopped required runtime shows an honest pause without active routes, tests or resume actions', async () => {
  for (const available of [true, false]) for (const completionCommitted of [true, false]) {
    const h = controlLifecycleStateHarness();
    h.state.snapshot.control = { ...h.state.snapshot.control, available, phase: 'stopped', policy: 'required',
      completionCommitted, routeVerified: completionCommitted, error: null };
    await h.context.refresh({ force: true });
    assert.equal(h.context.S.plugin, true);
    assert.equal(h.context.routeStatus(), 'paused');
    assert.equal(h.context.$('#statusText').textContent, '搜索已暂停');
    assert.equal(h.context.$('#nodeOfficial').getAttribute('aria-hidden'), 'true');
    assert.match(h.banner().innerHTML, /data-tone="info".*搜索已暂停/);
    assert.match(h.banner().innerHTML, /本页不会自动恢复接管/);
    assert.match(h.banner().innerHTML, /原生开关与宿主日志/);
    assert.doesNotMatch(h.banner().innerHTML, /正在确认|等待宿主|完成后自动更新|无需重启|data-act=/);
    assert.equal(h.context.$('#testBtn').disabled, true);
    assert.match(h.context.$('#testBtn').title, /搜索已暂停/);
    assert.equal(h.context.rowState('grok'), 'on');
    const wires = h.context.wireDefs();
    assert.equal(wires.find(wire => wire.id === 'dsh-hub').ws, 'rest');
    assert.equal(wires.find(wire => wire.id === 'dsh-off').ws, 'hidden');
    assert.equal(wires.some(wire => wire.ws === 'live'), false);
    await h.context.runTest();
    assert.equal(h.context.S.testing, false);
    assert.equal(h.calls.includes('retryControlRelease'), false);
    assert.equal(h.notices.length, 0);
  }
});

test('a confirmed released runtime retains the original restored-search display', async () => {
  for (const available of [true, false]) {
    const h = controlLifecycleStateHarness();
    h.state.snapshot.control = { ...h.state.snapshot.control, available, phase: 'released', policy: 'released',
      completionCommitted: true, routeVerified: true, error: null };
    await h.context.refresh({ force: true });
    assert.equal(h.context.S.plugin, false);
    assert.equal(h.context.routeStatus(), 'off');
    assert.equal(h.context.$('#statusText').textContent, '已恢复原搜索');
    assert.equal(h.context.$('#nodeOfficial').getAttribute('aria-hidden'), 'false');
    assert.match(h.banner().innerHTML, /data-tone="info".*已恢复原搜索设置，无需重启/);
    assert.match(h.banner().innerHTML, /原生开关重新启用/);
    assert.doesNotMatch(h.banner().innerHTML, /正在启动|搜索已暂停|data-act=/);
    assert.equal(h.context.wireDefs().find(wire => wire.id === 'dsh-off').ws, 'live');
    assert.equal(h.context.$('#testBtn').disabled, true);
  }
});

test('actual control failures remain visible ahead of starting, paused and historical release states', async () => {
  for (const phase of ['starting', 'stopped', 'released']) {
    const h = controlLifecycleStateHarness(), code = 'CONTROL_ROUTE_COUNTER_REQUIRED';
    h.state.snapshot.control = { ...h.state.snapshot.control, phase,
      policy: phase === 'stopped' ? 'required' : 'released', completionCommitted: true, routeVerified: true,
      error: { code, message: 'Current recovery evidence is unavailable.' } };
    await h.context.refresh({ force: true });
    assert.equal(h.context.routeStatus(), 'ctlerr');
    assert.match(h.banner().innerHTML, /data-tone="err"/);
    assert.match(h.banner().innerHTML, new RegExp(code));
    assert.match(h.banner().innerHTML, /data-act="retry-control"/);
    assert.doesNotMatch(h.banner().innerHTML, /正在启动搜索组件|本页不会自动恢复接管|已恢复原搜索设置/);
    assert.equal(h.context.$('#testBtn').disabled, true);
  }
});

function partialWriteHarness(code) {
  const h = controlRecoveryHarness(), revoked = [], rendered = [];
  const draft = { key: 'synthetic-edited-key', enabled: false };
  h.context.D = { kind: 'card', id: 'grok', base: { key: 'synthetic-before', enabled: true },
    draft, fields: {}, show: { key: true }, saving: true };
  Object.assign(h.context, {
    clone: structuredClone, normCard, dlg: element(), shake() {}, fid: key => key, hidden: () => false,
    CARD_FIELDS: { grok: { key: 'grok_api_key' } }, HUB_FIELDS: {},
    logView: { restrict(value) { revoked.push(value); } },
    saveConfig: async () => ({ after: 'saved' }), restoreReceipt: async () => ({ config: {} }),
    updateConfig() {}, configFields: () => ({}),
    savePreference: async () => { throw Object.assign(new Error('Synthetic private failure details'), { code }); },
    renderCard() { rendered.push(h.context.keyIn('key', h.context.D.draft.key, '')); },
  });
  vm.runInContext([
    section('function fieldReadOnly(', 'function chip('),
    section('function configUndo(', 'async function restoreReceipt('),
    section('async function commitCard(', 'async function clearArm('),
  ].join('\n'), h.context);
  return { ...h, revoked, rendered, draft };
}

test('partial config saves retain security error classification and revoke revealed credentials immediately', async () => {
  for (const code of ['SETTINGS_AUTH_REQUIRED', 'SETTINGS_SECURE_CONNECTION_REQUIRED', 'PREFERENCES_BUSY']) {
    const h = partialWriteHarness(code), restricted = code.startsWith('SETTINGS_');
    await h.context.commitCard(h.draft);
    assert.equal(h.context.D.operationError.code, restricted ? code : 'SETTINGS_PARTIAL_SAVE');
    assert.match(h.context.D.operationError.message, /共享配置已保存/);
    assert.equal(h.context.S.capabilities.secretsAllowed, !restricted);
    assert.equal(h.revoked.length, restricted ? 1 : 0);
    assert.equal(h.context.D.base.key, h.draft.key, 'Retain the committed configuration as the retry baseline.');
    assert.equal(h.context.D.base.enabled, true, 'Do not invent a successful private switch write.');
    if (restricted) {
      assert.equal(h.context.accessGeneration, 1);
      assert.equal(Object.keys(h.context.D.show).length, 0);
      assert.doesNotMatch(h.rendered.at(-1), /synthetic-edited-key|type="text"/);
      assert.match(h.rendered.at(-1), /data-a="copy"[^>]*disabled/);
    }
  }
});

test('partial undo retains security error classification without hiding the completed config restore', async () => {
  for (const code of ['SETTINGS_AUTH_REQUIRED', 'SETTINGS_SECURE_CONNECTION_REQUIRED', 'PREFERENCES_BUSY']) {
    const h = partialWriteHarness(code), restricted = code.startsWith('SETTINGS_');
    await h.context.cardUndo({ undo: true }, 'grok', true, true)();
    assert.match(h.notices.at(-1).text, new RegExp(restricted ? code : 'SETTINGS_PARTIAL_RESTORE'));
    assert.match(h.notices.at(-1).text, /共享配置已恢复/);
    assert.equal(h.context.S.capabilities.secretsAllowed, !restricted);
    assert.equal(h.revoked.length, restricted ? 1 : 0);
    assert.equal(h.context.S.busy, false);
    if (restricted) assert.doesNotMatch(h.rendered.at(-1), /synthetic-edited-key|type="text"/);
  }
});

test('config conflict rereads cannot restart a write after access is revoked or reauthorized', async () => {
  for (const reauthorized of [false, true]) {
    const h = controlRecoveryHarness(), requests = [];
    const config = { path: '/config.toml', revision: 'before', quotaRevision: 'same-effective',
      fields: { grok_model: { value: 'before' } } };
    h.context.S.config = config;
    Object.assign(h.context, { clone: structuredClone,
      updateConfig() { assert.fail('An obsolete save must not publish configuration.'); } });
    let complete, entered;
    const reading = new Promise(resolve => { entered = resolve; });
    h.context.remote.snapshot = () => new Promise(resolve => { complete = resolve; entered(); });
    h.context.remote.saveWithIdentity = async request => {
      requests.push(request);
      if (requests.length === 1) throw Object.assign(new Error('conflict'), { code: 'CONFIG_CONFLICT' });
      return { config: { ...config, revision: 'unexpected-save' } };
    };
    vm.runInContext(section('async function saveConfig(', 'async function savePreference('), h.context);
    const saving = h.context.saveConfig({ grok_model: 'after' }).then(() => null, error => error);
    await reading;
    h.context.denyPrivateAccess({ code: 'SETTINGS_AUTH_REQUIRED' });
    if (reauthorized) h.context.S.capabilities.secretsAllowed = true;
    complete({ config, capabilities: { secretsAllowed: true } });
    const error = await saving;
    assert.equal(requests.length, 1);
    assert.equal(error?.code, 'CONFIG_CONFLICT');
    assert.equal(h.context.S.config, config);
  }
});

test('preference conflict rereads cannot replace state or retry after access is revoked or reauthorized', async () => {
  for (const reauthorized of [false, true]) {
    const h = controlRecoveryHarness(), requests = [];
    const before = { revision: 'before', value: { grokEnabled: true, githubReadEnabled: false } };
    h.context.S.prefs = before;
    let complete, entered;
    const reading = new Promise(resolve => { entered = resolve; });
    h.context.remote.preferences = () => new Promise(resolve => { complete = resolve; entered(); });
    h.context.remote.savePreferences = async request => {
      requests.push(request);
      if (requests.length === 1) throw Object.assign(new Error('conflict'), { code: 'PREFERENCES_CONFLICT' });
      return { revision: 'unexpected-save', value: request.value };
    };
    vm.runInContext(section('async function savePreference(', 'function configUndo('), h.context);
    const saving = h.context.savePreference('grok', false).then(() => null, error => error);
    await reading;
    h.context.denyPrivateAccess({ code: 'SETTINGS_AUTH_REQUIRED' });
    if (reauthorized) h.context.S.capabilities.secretsAllowed = true;
    complete({ revision: 'new', value: before.value });
    const error = await saving;
    assert.equal(requests.length, 1);
    assert.equal(error?.code, 'PREFERENCES_CONFLICT');
    assert.equal(h.context.S.prefs, before);
    assert.equal(h.context.S.prov.grok.enabled, true);
  }
});

function absentProgramHarness() {
  const h = controlRecoveryHarness();
  let click;
  h.context.S.program = null;
  h.state.snapshot.program = null;
  h.context.D = { kind: 'hub', draft: { timeout: 75 }, base: { timeout: 60 }, advOpen: false };
  Object.assign(h.context, {
    dlg: { addEventListener(type, callback) { if (type === 'click') click = callback; } },
    dialogBusy: () => false, configLocation: () => ({ name: 'config.toml', full: '/config.toml', label: '/config.toml' }),
    programPhase: () => '等待程序', programSource: () => '自动检测',
    field: () => '', stepper: () => '', txt: () => '', note: text => text,
    renderHub() { h.calls.push('hub-render'); h.context.$('#hubBody').innerHTML = h.context.hubBody(h.context.D.draft); },
  });
  h.context.remote.prepareProgram = h.context.remote.repairProgram = () => assert.fail('Missing program recovery must use the root.');
  vm.runInContext([
    section('function hubBody(', 'function renderHub('),
    section('function toggleAdv(', 'async function redetect('),
    section('async function redetect(', 'async function commitHub('),
    section("dlg.addEventListener('click',", 'async function testGithubDraft('),
  ].join('\n'), h.context);
  return { ...h, click: button => click({ target: { closest: () => button } }),
    html: () => h.context.hubBody(h.context.D.draft) };
}

test('missing program presentation is honest and offers root retry only for a current recoverable control', () => {
  for (const phase of ['incomplete', 'starting', 'stopped', 'released', 'unavailable']) {
    const h = absentProgramHarness();
    h.context.S.control = { available: phase !== 'unavailable', phase, policy: phase === 'released' ? 'released' : 'required', error: null };
    const html = h.html();
    assert.match(html, /程序管理组件当前未加载/);
    assert.doesNotMatch(html, /正在自动检测|data-a="redetect"/);
    if (phase === 'incomplete') assert.match(html, /data-a="retry-control"[^>]*>.*重试恢复/);
    else assert.doesNotMatch(html, /data-a="retry-control"/);
  }
  const h = absentProgramHarness();
  delete h.context.remote.retryControlRelease;
  assert.doesNotMatch(h.html(), /data-a="retry-control"/);
  assert.match(h.html(), /原生开关与宿主日志/);
  h.context.S.program = { phase: 'error', canRepair: true, error: { code: 'GROK_CACHE_DAMAGED', message: 'Synthetic damaged cache' } };
  assert.match(h.html(), /data-a="redetect" data-repair="true"[^>]*>.*重新准备/);
});

test('the program recovery action uses one root retry and refreshes the same hub without losing its draft', async () => {
  const h = absentProgramHarness(), mine = h.context.D, draft = mine.draft;
  let complete;
  h.context.remote.retryControlRelease = () => {
    h.calls.push('retryControlRelease');
    return new Promise(resolve => { complete = resolve; });
  };
  const button = element(); button.dataset.a = 'retry-control';
  const pending = h.click(button);
  assert.equal(h.calls.filter(call => call === 'retryControlRelease').length, 1);
  assert.equal(button.disabled, true);
  await h.click(button);
  h.state.snapshot.program = { phase: 'ready', program: { version: 'synthetic-ready' } };
  complete({});
  await pending;
  assert.equal(h.calls.filter(call => call === 'retryControlRelease').length, 1);
  assert.equal(h.context.D, mine);
  assert.equal(h.context.D.draft, draft);
  assert.equal(h.context.D.draft.timeout, 75);
  assert.match(h.context.$('#hubBody').innerHTML, /synthetic-ready/);
  assert.equal(h.context.S.busy, false);
});

test('late program recovery cannot rerender a disposed, replaced or access-changed hub', async () => {
  for (const change of ['dispose', 'dialog', 'access']) {
    const h = absentProgramHarness();
    let complete;
    h.context.remote.retryControlRelease = () => new Promise(resolve => { complete = resolve; });
    const button = element(); button.dataset.a = 'retry-control';
    const pending = h.click(button);
    assert.equal(typeof complete, 'function');
    if (change === 'dispose') h.context.disposed = true;
    else if (change === 'dialog') h.context.D = { kind: 'hub', draft: {} };
    else h.context.accessGeneration++;
    complete({});
    await pending;
    assert.equal(h.calls.includes('hub-render'), false, change);
  }
});

test('the hub recovery action rechecks current service and pause state before dispatch', async () => {
  for (const change of ['ready', 'paused', 'unavailable', 'missing-method']) {
    const h = absentProgramHarness(), button = element();
    button.dataset.a = 'retry-control';
    if (change === 'ready') h.context.S.program = { phase: 'ready' };
    else if (change === 'paused') h.context.S.control = { available: true, phase: 'stopped', policy: 'required' };
    else if (change === 'unavailable') h.context.S.control.available = false;
    else delete h.context.remote.retryControlRelease;
    await h.click(button);
    assert.equal(h.calls.includes('retryControlRelease'), false, change);
  }
});

test('a current hub recovery rejection preserves its code and releases the visible busy state', async () => {
  for (const code of ['SETTINGS_AUTH_REQUIRED', 'CONTROL_ROUTE_COUNTER_REQUIRED']) {
    const h = absentProgramHarness(), button = element();
    button.dataset.a = 'retry-control';
    h.context.shake = () => {};
    h.context.remote.retryControlRelease = async () => { throw Object.assign(new Error('Synthetic recovery failure'), { code }); };
    await h.click(button);
    assert.equal(h.context.D.operationError?.code, code);
    assert.equal(h.context.S.busy, false);
    assert.equal(h.context.controlRetrying, false);
    assert.doesNotMatch(h.context.$('#hubBody').innerHTML, /处理中|data-a="retry-control" disabled/);
    if (code === 'SETTINGS_AUTH_REQUIRED') assert.equal(h.context.S.capabilities.secretsAllowed, false);
  }
});

test('an open hub follows program service recovery without replacing an unsaved configuration draft', async () => {
  const h = controlLifecycleStateHarness(), draft = { timeout: 75 }, renders = [];
  h.context.S.program = null;
  h.context.D = { kind: 'hub', draft, base: { timeout: 60 }, saving: false };
  Object.assign(h.context, {
    dlg: {}, active: () => null, dialogBusy: () => h.context.D.saving,
    renderHub() { renders.push(h.context.S.program); },
  });
  h.state.snapshot.control = { ...h.state.snapshot.control, phase: 'starting', error: null };
  h.state.snapshot.program = { phase: 'ready', program: { version: 'synthetic-ready' } };
  await h.context.refresh({ force: true });
  assert.equal(renders.length, 1);
  assert.equal(renders[0].program.version, 'synthetic-ready');
  assert.equal(h.context.D.draft, draft);
  assert.equal(h.context.D.base.timeout, 60);
  await h.context.refresh({ force: true });
  assert.equal(renders.length, 1, 'Identical status polling must not keep replacing dialog DOM.');
  h.context.D.saving = true;
  h.state.snapshot.program = null;
  await h.context.refresh({ force: true });
  assert.equal(renders.length, 1, 'A current dialog operation still owns its DOM.');
});
