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
    D: null, S: { busy: false, capabilities: { secretsAllowed: true } }, disposed: false, secretEpoch: 0,
    dlg, overlay, quotaView: null, closeTimer: 0, overlayEntranceTimer: 0, shakeCleanups: new Map(),
    $, $$: selector => selector === 'input[data-k]' ? inputs : selector === '[data-a=eye], [data-a=copy]' ? buttons : [],
    active: () => null, clone: structuredClone, reduced: () => false,
    remote: { reveal(request) {
      return new Promise((resolve, reject) => requests.push({ ...request, resolve, reject }));
    } },
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
