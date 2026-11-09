import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { createSearchLogView } from '../src/ui/search-log-view.mjs';

// Exercise the production factory and its asynchronous state, without a second
// log implementation. The real-browser suite covers replay, DOM and animation.
class Element {
  constructor() {
    this.dataset = {}; this.children = []; this.nodes = new Map(); this.attrs = {};
    this.style = { removeProperty() {} }; this.classList = { add() {}, remove() {}, toggle() {} };
    this.textContent = ''; this.innerHTML = ''; this.hidden = false; this.isConnected = true;
    this.scrollTop = 0; this.offsetWidth = 10; this.offsetLeft = 0;
  }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  get firstElementChild() { return null; }
  contains() { return false; }
  focus() {}
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this);
    this.isConnected = false;
  }
  appendChild(child) { child.remove(); child.parent = this; child.isConnected = true; this.children.push(child); }
  insertBefore(child, next) {
    child.remove(); child.parent = this; child.isConnected = true;
    const index = this.children.indexOf(next);
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
  }
  replaceChildren() { for (const node of [...this.children]) node.remove(); }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
    return this.nodes.get(selector);
  }
}
function harness(readSearchLog) {
  const root = new Element(), filters = ['all', 'ok', 'fallback', 'failed'].map(logfilter => {
    const node = new Element(); node.dataset.logfilter = logfilter; return node;
  });
  const S = { capabilities: { secretsAllowed: true }, plugin: true };
  const factory = vm.runInNewContext(`(${createSearchLogView.toString()})`, {
    document: { createElement: () => new Element(), visibilityState: 'visible', body: new Element() },
    window: {}, Date,
  });
  const $ = (selector, parent = root) => parent.querySelector(selector);
  let denied = 0, clears = 0;
  const view = factory({
    $, $$: selector => selector === '[data-logfilter]' ? filters : [], active: () => null,
    S, card: new Element(), layer: new Element(), listen() {}, uuid: randomUUID,
    clone: structuredClone, esc: String, svg: () => '', tile: () => '',
    logoSrc: () => '', isDark: () => false, reduced: () => true,
    META: { tavily: { name: 'Tavily' } }, SUPP: ['tavily'],
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    jolts: new Map(), faultPulses: new Map(), toast() {}, errText: String,
    onPrivateAccessDenied() { denied++; S.capabilities = { secretsAllowed: false }; },
    remote: {
      readSearchLog, closeSearchLog: async () => ({}),
      clearSearchLog: async () => { clears++; return {}; },
    },
  });
  return { view, S, $, denied: () => denied, clears: () => clears,
    query: () => $('#logList').children.find(node => node.dataset.id)?.querySelector('.le-query').textContent ?? '' };
}
const records = { records: [{ id: 'search-log-1', at: 1, q: 'private-query',
  kind: 'sources', served: 'tavily', ms: 1, calls: [], callsComplete: true }] };

for (const code of ['SETTINGS_AUTH_REQUIRED', 'SETTINGS_SECURE_CONNECTION_REQUIRED']) {
  test(`log rejection ${code} clears private content without clearing server history`, async () => {
    let failure = false;
    const h = harness(async () => {
      if (failure) throw Object.assign(new Error('denied'), { code });
      return records;
    });
    try {
      await h.view.read();
      assert.equal(h.query(), 'private-query');
      failure = true;
      await h.view.read();
      assert.equal(h.query(), '');
      assert.equal(h.$('#logCount').textContent, '—');
      assert.equal(h.$('#logAnnouncer').textContent, '');
      assert.match(h.$('#logNote').textContent, new RegExp(code));
      assert.equal(h.denied(), 1);
      assert.equal(h.clears(), 0);
      failure = false;
      h.S.capabilities = { secretsAllowed: true };
      await h.view.read();
      assert.equal(h.query(), 'private-query', 'a fresh authorized read can restore history');
    } finally { h.view.dispose(); }
  });
}

test('ordinary log transport failures retain the last readable history', async () => {
  let failure = false;
  const h = harness(async () => {
    if (failure) throw Object.assign(new Error('offline'), { code: 'SETTINGS_UNAVAILABLE' });
    return records;
  });
  try {
    await h.view.read(); failure = true; await h.view.read();
    assert.equal(h.query(), 'private-query');
    assert.equal(h.denied(), 0);
    assert.match(h.$('#logNote').textContent, /读取失败/);
  } finally { h.view.dispose(); }
});

test('snapshot denial invalidates an in-flight log response across later reauthorization', async () => {
  let resolveReply;
  const h = harness(() => new Promise(resolve => { resolveReply = resolve; }));
  try {
    const pending = h.view.read();
    h.view.restrict('SETTINGS_AUTH_REQUIRED');
    h.S.capabilities = { secretsAllowed: true };
    resolveReply(records);
    await pending;
    assert.equal(h.query(), '');
    assert.equal(h.clears(), 0);
  } finally { h.view.dispose(); }
});
