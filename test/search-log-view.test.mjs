import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { createSearchLogView } from '../src/ui/search-log-view.mjs';
import { createSearchLog } from '../src/core/search-log.mjs';

// Exercise the production factory and its asynchronous state, without a second
// log implementation. The real-browser suite covers replay, DOM and animation.
class Element {
  constructor() {
    const classes = new Set();
    this.dataset = {}; this.children = []; this.nodes = new Map(); this.attrs = {};
    this.style = { removeProperty() {} };
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle: (name, on = !classes.has(name)) => on ? classes.add(name) : classes.delete(name),
      contains: name => classes.has(name),
    };
    this.textContent = ''; this.innerHTML = ''; this.hidden = false; this.isConnected = true;
    this.inert = false;
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
function harness(readSearchLog, { clearSearchLog = async () => ({}), reducedMotion = true,
  openSearchLog, closeSearchLog = async () => ({}) } = {}) {
  const root = new Element(), filters = ['all', 'ok', 'fallback', 'failed'].map(logfilter => {
    const node = new Element(); node.dataset.logfilter = logfilter; return node;
  });
  const S = { capabilities: { secretsAllowed: true }, plugin: true };
  // Expose the production event handlers only inside this VM so tests can await
  // transaction completion without changing the browser-facing view API.
  const source = createSearchLogView.toString().replace('read, restrict,', 'read, restrict, replay: replayLogRoute, clear: clearRemoteLog,');
  const factory = vm.runInNewContext(`(${source})`, {
    document: { createElement: () => new Element(), visibilityState: 'visible', body: new Element(),
      createElementNS() { throw new Error('history mount fault'); } },
    window: {}, Date,
  });
  const $ = (selector, parent = root) => parent.querySelector(selector);
  const card = new Element(), toasts = [], pumps = [];
  let denied = 0, clears = 0, reads = 0;
  const view = factory({
    $, $$: (selector, parent) => selector === '[data-logfilter]' ? filters
      : selector.startsWith('[data-log-replay=') ? [$(selector, parent)] : [], active: () => null,
    S, card, layer: new Element(), listen() {}, uuid: randomUUID,
    clone: structuredClone, esc: String, svg: () => '', tile: () => '',
    logoSrc: () => '', isDark: () => false, reduced: () => reducedMotion,
    META: { tavily: { name: 'Tavily' }, grok: { name: 'Grok' }, github: { name: 'GitHub' } }, SUPP: ['tavily'],
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    jolts: new Map(), faultPulses: new Map(), toast: message => toasts.push(message), errText: String,
    closePop() {}, pumpWires: ms => pumps.push(ms),
    onPrivateAccessDenied() { denied++; S.capabilities = { secretsAllowed: false }; },
    remote: {
      readSearchLog: request => { reads++; return readSearchLog(request); }, closeSearchLog,
      ...(openSearchLog ? { openSearchLog } : {}),
      clearSearchLog: async request => { clears++; return clearSearchLog(request); },
    },
  });
  return { view, S, $, card, toasts, pumps, denied: () => denied, clears: () => clears, reads: () => reads,
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

test('replay catches failures while reading initial lock state before any UI mutation', async () => {
  const h = harness(async () => records);
  const control = h.$('.rc-actions', h.card);
  try {
    await h.view.read();
    Object.defineProperty(control, 'inert', { configurable: true, get() { throw new Error('lock read fault'); } });
    assert.equal(await h.view.replay('search-log-1'), false);
    assert.equal(h.$('#stage').inert, false);
    assert.equal(h.card.dataset.history, undefined);
    assert.match(h.$('#logAnnouncer').textContent, /回放未能完成/);
    assert.equal(h.query(), 'private-query');
  } finally {
    Object.defineProperty(control, 'inert', { configurable: true, value: false, writable: true });
    h.view.dispose();
  }
});

test('replay restores already acquired locks when a later lock mutation throws', async () => {
  const h = harness(async () => records, { reducedMotion: false });
  const control = h.$('.rc-actions', h.card), footer = h.$('.rc-foot', h.card);
  let inert = false;
  try {
    await h.view.read();
    footer.inert = true;
    Object.defineProperty(control, 'inert', {
      configurable: true, get: () => inert,
      set(value) { inert = value; if (value) throw new Error('lock write fault'); },
    });
    assert.equal(await h.view.replay('search-log-1'), false);
    assert.equal(h.$('#stage').inert, false);
    assert.equal(control.inert, false);
    assert.equal(h.$('#bannerSlot').inert, false);
    assert.equal(footer.inert, true, 'a previously locked control stays locked');
    assert.equal(h.card.dataset.history, undefined);
    assert.equal(h.$('#historyStage').hidden, true);
    assert.equal(h.$('#historyBar').hidden, true);
    assert.equal(h.$('#logList').children.find(node => node.dataset.id).classList.contains('is-replaying'), false);
    assert.equal(h.query(), 'private-query');
  } finally { h.view.dispose(); }
});

test('replay restores all live UI after an early history header mutation fails', async () => {
  const h = harness(async () => records);
  const stop = h.$('#historyStop');
  try {
    await h.view.read();
    Object.defineProperty(stop, 'innerHTML', { configurable: true, set() { throw new Error('history header fault'); } });
    assert.equal(await h.view.replay('search-log-1'), false);
    for (const control of [h.$('#stage'), h.$('.rc-actions', h.card), h.$('#bannerSlot'), h.$('.rc-foot', h.card)]) {
      assert.equal(control.inert, false);
    }
    assert.equal(h.card.dataset.history, undefined);
    assert.equal(h.$('#historyStage').hidden, true);
    assert.equal(h.$('#historyNote').hidden, true);
    assert.equal(h.$('#historyContext').hidden, true);
    assert.equal(h.$('#historyBar').hidden, true);
    assert.deepEqual(h.pumps, [120]);
    assert.equal(h.clears(), 0);
    assert.equal(h.query(), 'private-query');
  } finally { h.view.dispose(); }
});

test('replay cleanup continues restoring controls and surfaces a cleanup DOM failure', async () => {
  const h = harness(async () => records, { reducedMotion: false });
  const stage = h.$('#historyStage'), replaceChildren = stage.replaceChildren;
  try {
    await h.view.read();
    stage.replaceChildren = () => { throw new Error('history cleanup fault'); };
    await assert.rejects(h.view.replay('search-log-1'), /history cleanup fault/);
    for (const control of [h.$('#stage'), h.$('.rc-actions', h.card), h.$('#bannerSlot'), h.$('.rc-foot', h.card)]) {
      assert.equal(control.inert, false);
    }
    assert.equal(h.card.dataset.history, undefined);
    assert.equal(stage.hidden, true);
    assert.equal(h.$('#historyNote').hidden, true);
    assert.equal(h.$('#historyContext').hidden, true);
    assert.equal(h.$('#historyBar').hidden, true);
    assert.deepEqual(h.pumps, [120]);
    assert.equal(h.view.stop(), false, 'failed cleanup still releases playback ownership');
  } finally { stage.replaceChildren = replaceChildren; h.view.dispose(); }
});

test('clear releases its busy state when local DOM clearing fails before the RPC', async () => {
  const h = harness(async () => records);
  const history = h.$('#historyRoute'), replaceChildren = history.replaceChildren;
  try {
    await h.view.read();
    history.replaceChildren = () => { throw new Error('local clear fault'); };
    await h.view.clear();
    assert.equal(h.clears(), 0);
    assert.deepEqual(h.toasts, ['清空未确认，请稍后重试']);
    history.replaceChildren = replaceChildren;
    await h.view.read();
    assert.equal(h.reads(), 2, 'polling resumes after the local failure');
    await h.view.clear();
    assert.equal(h.clears(), 1, 'the clear action can be retried');
    assert.equal(h.query(), '');
    assert.equal(h.toasts.at(-1), '已清空当前插件的搜索记录');
  } finally { history.replaceChildren = replaceChildren; h.view.dispose(); }
});

test('clear RPC failures stay visible and leave polling and retries available', async () => {
  let failure = true;
  const h = harness(async () => records, { clearSearchLog: async () => {
    if (failure) throw new Error('clear transport fault');
  } });
  try {
    await h.view.read();
    await h.view.clear();
    assert.equal(h.clears(), 1);
    assert.equal(h.query(), '');
    assert.equal(h.toasts.at(-1), '清空未确认，请稍后重试');
    await h.view.read();
    assert.equal(h.query(), 'private-query');
    failure = false;
    await h.view.clear();
    assert.equal(h.clears(), 2);
    assert.equal(h.toasts.at(-1), '已清空当前插件的搜索记录');
  } finally { h.view.dispose(); }
});

test('an expired issued view cannot falsely acknowledge clearing persistent in-memory history', async () => {
  let clock = 0;
  const log = createSearchLog({ now: () => clock, viewTtlMs: 10 });
  const token = log.begin('still present');
  log.finish(token, { outcome: 'ok', served: 'tavily' });
  const h = harness(async ({ sessionId }) => log.snapshot(sessionId), {
    openSearchLog: async () => ({ sessionId: log.open() }),
    clearSearchLog: async ({ sessionId }) => log.clear(sessionId),
    closeSearchLog: async ({ sessionId }) => log.close(sessionId),
  });
  try {
    await h.view.read();
    clock += 11;
    await h.view.clear();
    assert.equal(h.toasts.at(-1), '清空未确认，请稍后重试');
    assert.equal(log.snapshot(log.open()).records.length, 1);
    await h.view.read();
    assert.equal(h.query(), 'still present', 'the next read renews the expired view');
    await h.view.clear();
    assert.equal(h.toasts.at(-1), '已清空当前插件的搜索记录');
    assert.equal(log.snapshot(log.open()).records.length, 0);
  } finally { h.view.dispose(); log.dispose(); }
});
