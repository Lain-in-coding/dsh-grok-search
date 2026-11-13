import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { buildClient } from '../scripts/build-client.mjs';
import { SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import { createQuotaView } from '../src/ui/quota-view.mjs';
import { createSourceChain } from '../src/core/source-chain.mjs';
import { createToolRouteView } from '../src/ui/tool-route-view.mjs';

const { code: clientSource } = await buildClient();

function loadClient(globals = {}) {
  let factory;
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, set textContent(_) {} }),
    head: { appendChild() {} },
  };
  const window = { __ModuleLoader__: { load(definition) { factory = definition.factory; } } };
  const context = { window, document, URL, console, setTimeout, clearTimeout, ...globals };
  vm.createContext(context);
  // Node's injected structuredClone would create foreign-realm objects. These
  // UI fixtures clone JSON only, matching the browser's local object realm.
  vm.runInContext('globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));', context);
  vm.runInContext(clientSource, context,
    { filename: 'src/client.js' });
  assert.equal(typeof factory, 'function');
  const react = {
    useState: () => [null, () => {}],
    useCallback: value => value,
    useEffect() {},
    useMemo: value => value(),
    useRef: () => ({ current: null }),
  };
  const jsx = (type, props) => ({ type, props });
  return factory(name => name === 'react' ? react : { jsx, jsxs: jsx, Fragment: Symbol('Fragment') });
}

test('client exposes the real settings contribution and all route methods', () => {
  const client = loadClient();
  const methods = client.__test.descriptors.map(descriptor => descriptor.method);
  assert.equal(JSON.stringify(methods), JSON.stringify(SETTINGS_DESCRIPTORS.map(descriptor => descriptor.method)));
  assert.equal(JSON.stringify(client.__test.descriptors), JSON.stringify(SETTINGS_DESCRIPTORS));
  assert.equal(client.__test.descriptors.every(descriptor => descriptor.invocation.kind === 'direct'), true);
});

test('client declares the owners of its remote and keyed detail slot', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-tool'));
});

test('chat and settings whale assets are compact variants and preserve the source artwork', () => {
  const logos = loadClient().__test.LOGOS;
  const original = readFileSync(new URL('../src/assets/logos/deepseek-harness.png', import.meta.url));
  assert.equal(original.readUInt32BE(16), 1024);
  const settings = readFileSync(new URL('../src/assets/logos/deepseek-harness-settings.png', import.meta.url));
  assert.equal(logos.harness, `data:image/png;base64,${settings.toString('base64')}`);
  assert.equal(settings.readUInt32BE(16), 256);
  assert.ok(settings.length < original.length / 3);
  for (const [key, theme] of [['harnessChat', 'light'], ['harnessChatDark', 'dark']]) {
    assert.match(logos[key] ?? '', /^data:image\/png;base64,/);
    const image = Buffer.from(logos[key].split(',')[1], 'base64');
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(image.readUInt32BE(16), 64);
    assert.equal(image.readUInt32BE(20), 64);
    assert.ok(image.length < 10_000, 'a small decorative icon must not decode a full-size app artwork');
    assert.deepEqual(image, readFileSync(new URL(`../src/assets/logos/deepseek-harness-chat-${theme}.png`, import.meta.url)));
  }
  assert.notEqual(logos.harnessChat, logos.harnessChatDark);
  const css = readFileSync(new URL('../src/ui/tool-route.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /mix-blend-mode\s*:/, 'chat cards must not blend a logo against the scrolling host');
});

test('GitHub project badge uses the public title slot and is limited to this bundle', async () => {
  const client = loadClient(), entries = [], disposers = [];
  const ctx = {
    locale: { register: () => () => {} }, effect: fn => fn(),
    remote: { $mount: async () => () => {} },
    inject(names, fn) {
      const result = names.includes('theme') ? undefined : fn(ctx);
      return Object.assign(Promise.resolve(result), { dispose: async () => {} });
    },
    slots: {
      inject(name, fn) { if (name !== 'tool.call.toolview') disposers.push(fn()); },
      register(options, component) {
        const entry = { options, component };
        entries.push(entry);
        return () => entries.splice(entries.indexOf(entry), 1);
      },
    },
  };
  const dispose = await client.apply(ctx);
  const badge = entries.find(entry => entry.options.name === 'plugins.detail.badge');
  assert.equal(badge.options.id, 'dsh-grok-search-project');
  for (const subject of [undefined, { kind: 'item', id: 'dsh-grok-search' },
    { kind: 'row', pkg: { name: 'dsh-grok-search' } },
    { kind: 'bundle', pkg: { name: 'another-plugin' } }]) {
    assert.equal(badge.component({ subject }), null);
  }
  const own = badge.component({ subject: { kind: 'bundle', pkg: { name: 'dsh-grok-search' } },
    ...badge.options.inject() });
  assert.equal(typeof own.type, 'function');
  assert.ok(own.props.theme.listeners instanceof Set || typeof own.props.theme.listeners.add === 'function');
  const source = clientSource;
  assert.match(source, /href="https:\/\/github\.com\/Lain-in-coding\/dsh-grok-search" target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /role="tooltip">用着还行？给个 star/);
  for (const cleanup of disposers.reverse()) cleanup?.();
  assert.equal(entries.length, 0);
  await dispose();
});

// Mirrors the host SlotCore: rows keep identity, sort by ascending priority, the
// first row of a key wins, and subscribers are flushed in one microtask batch.
function fakeToolSlots() {
  const rows = [], listeners = new Set();
  let scheduled = false;
  const dirty = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; for (const listener of [...listeners]) listener(); });
  };
  const register = (options, component, extra = {}) => {
    if (options.name !== 'tool.call.toolview') return () => {};
    const row = { options, component, locale: options.locale, ...extra };
    rows.push(row);
    rows.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0));
    dirty();
    return () => { const index = rows.indexOf(row); if (index >= 0) { rows.splice(index, 1); dirty(); } };
  };
  return { rows, listeners, register,
    entries: name => name === 'tool.call.toolview' ? rows : [],
    subscribe(name, listener) {
      if (name !== 'tool.call.toolview') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    } };
}

test('chat source ribbon wraps only a plain host web_search row and follows slot changes', async () => {
  const client = loadClient(), slots = fakeToolSlots(), cleanups = [];
  const ctx = {
    locale: { register: () => () => {} }, effect: fn => fn(),
    remote: { $mount: async () => () => {} },
    inject(names, fn) {
      const result = names.includes('theme') ? undefined : fn(ctx);
      return Object.assign(Promise.resolve(result), { dispose: async () => {} });
    },
    slots: {
      inject(name, fn) { const cleanup = fn(); if (name === 'tool.call.toolview') cleanups.push(cleanup); },
      register: slots.register, entries: slots.entries, subscribe: slots.subscribe,
    },
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const webRows = () => slots.rows.filter(row => row.options.key === 'web_search');
  function HostWebRow() {}
  let removeHost = slots.register({ name: 'tool.call.toolview', key: 'web_search', locale: 'host' }, HostWebRow);
  const dispose = await client.apply(ctx);
  await settle();
  const [wrapper, host] = webRows();
  assert.equal(webRows().length, 2);
  assert.equal(host.component, HostWebRow);
  assert.equal(wrapper.options.priority, -1);
  assert.equal(wrapper.locale, 'host');
  const tree = wrapper.component({ sessionId: 's', callId: 'c', phase: 'result', block: {} });
  assert.equal(tree.props.children.find(child => child.type === HostWebRow)?.props.callId, 'c');

  // Its own registration and other tools' changes never wrap or re-register it.
  const removeOther = slots.register({ name: 'tool.call.toolview', key: 'fetch' }, function Fetch() {});
  await settle();
  assert.equal(webRows()[0], wrapper);
  assert.equal(webRows().length, 2);
  removeOther();

  // A replaced host row is wrapped again just ahead of its own precedence.
  function NewHostWebRow() {}
  removeHost();
  removeHost = slots.register({ name: 'tool.call.toolview', key: 'web_search', locale: 'host', priority: 4 }, NewHostWebRow);
  await settle();
  assert.deepEqual(webRows().map(row => [row.options.priority, row.component === NewHostWebRow]), [[3, false], [4, true]]);

  // A winning third-party view keeps its injected props; the ribbon steps aside.
  const removeComplex = slots.register({ name: 'tool.call.toolview', key: 'web_search', priority: 2 },
    function ThirdPartyRow() {}, { inject: () => ({}) });
  await settle();
  assert.deepEqual(webRows().map(row => [row.options.priority, Boolean(row.inject)]), [[2, true], [4, false]]);
  removeComplex();
  await settle();
  assert.deepEqual(webRows().map(row => [row.options.priority, row.component === NewHostWebRow]), [[3, false], [4, true]]);

  // Disabling removes the wrapper and stops following later host changes.
  for (const cleanup of cleanups) cleanup();
  assert.deepEqual(webRows().map(row => row.component), [NewHostWebRow]);
  assert.equal(slots.listeners.size, 0);
  removeHost();
  slots.register({ name: 'tool.call.toolview', key: 'web_search' }, HostWebRow);
  await settle();
  assert.deepEqual(webRows().map(row => row.component), [HostWebRow]);
  await dispose();
});

test('production view embeds v74 inputs without mock actions or global presentation changes', () => {
  const code = clientSource;
  assert.match(code, /attachShadow/);
  assert.match(code, /restoreConfig/);
  assert.match(code, /diagnoseProvider/);
  assert.match(code, /theme\/change/);
  assert.doesNotMatch(code, /window\.mock|simulateFail|makeScene|masterSwitch|style\[data-dsg-style\]/);
  assert.doesNotMatch(code, /document\.body\.(?:style|dataset|classList)|document\.documentElement\.dataset/);
});

test('bundled client exposes the production log and quota modules without demo controls', () => {
  const client = loadClient();
  assert.equal(typeof client.__test.searchLogView, 'function');
  assert.equal(typeof client.__test.quotaView, 'function');
  for (const id of ['logCard', 'historyStage', 'historyRoute', 'logPrivacy']) assert.ok(clientSource.includes(id));
  assert.doesNotMatch(clientSource, /quotaFixture|LOG_SCENES|LOG_DEMO_QUERIES|mockbar|演示数据/);
});

test('approved compact quota removes detail panels without discarding query safeguards', () => {
  const quota = readFileSync(new URL('../src/ui/quota-view.mjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/ui/search-log.css', import.meta.url), 'utf8');
  assert.doesNotMatch(quota, /quota-details|quotaDetailsOpen|qp-key-hint|qp-disclosure|qp-details/);
  assert.match(quota, /data-quota-kind/);
  assert.match(quota, /当前 Key 最多还可用/);
  assert.match(quota, /AUTH: '额度接口鉴权失败'/);
  assert.doesNotMatch(quota, /AUTH: '.*无查询权限/);
  assert.match(quota, /<header class="qp-head"><div class="qp-heading">.*?\$\{tools\}<\/header>/);
  assert.match(quota, /自定义服务的账户余额请以该服务提供方为准/);
  assert.match(quota, /cancelAnimations\(\);\s*hideTip\?\.\(\)/);
  assert.match(quota, /animation\.finished\.then/);
  assert.match(quota, /parseFloat\(getComputedStyle\(slot\)\.height\)/);
  assert.match(css, /\.qp-empty\{min-height:36px;/);
  assert.match(css, /\.qp-head h3\{font-size:13px;font-weight:600;/);
  assert.match(css, /\.qp-console\{font-size:11px;font-weight:550;/);
});

test('capability revocation invalidates pending log reads before polling can defer it', () => {
  const controller = readFileSync(new URL('../src/ui/route-controller.mjs', import.meta.url), 'utf8');
  const log = readFileSync(new URL('../src/ui/search-log-view.mjs', import.meta.url), 'utf8');
  assert.match(controller, /S\.capabilities = snapshot\.capabilities;[\s\S]*?if \(S\.capabilities && !S\.capabilities\.secretsAllowed\) void logView\?\.read\(\);/);
  const read = log.slice(log.indexOf('async function read()'), log.indexOf('async function clearRemoteLog()'));
  assert.ok(read.indexOf('if (!S.capabilities?.secretsAllowed)') < read.indexOf('if (readTask) return;'));
  assert.match(read, /if \(!S\.capabilities\?\.secretsAllowed\) \{[\s\S]*?restrict\(\)/);
  assert.match(read, /mine !== generation \|\| !S\.capabilities\?\.secretsAllowed/);
});

test('client embeds the exact host source-chain rules', () => {
  const client = loadClient();
  const fields = { source_providers: { value: ['exa', 'tavily'], readOnly: false }, exa_enabled: { value: false, readOnly: false } };
  const host = createSourceChain();
  assert.equal(JSON.stringify(client.__test.sourceChain.view(fields)), JSON.stringify(host.view(fields)));
  const change = { kind: 'order', order: ['tavily', 'exa', 'firecrawl', 'tinyfish'] };
  assert.equal(JSON.stringify(client.__test.sourceChain.plan(fields, change)), JSON.stringify(host.plan(fields, change)));
});

test('Grok form names protocols and credentials without implying a provider or key-prefix restriction', () => {
  const code = readFileSync(new URL('../src/ui/route-controller.mjs', import.meta.url), 'utf8');
  assert.match(code, />xAI Responses<\/button>/);
  assert.match(code, />OpenAI 兼容网关<\/button>/);
  assert.match(code, /title="Responses 接口；支持兼容此协议的自定义服务"/);
  assert.match(code, /title="Chat Completions 接口"/);
  assert.match(code, /label: 'Base URL', k: 'gwUrl'/);
  assert.match(code, /label: 'API Key', k: 'gwKey'/);
  assert.match(code, /keyIn\('key', p\.key, 'xai-\.\.\.\/sk-\.\.\.'\)/);
  assert.doesNotMatch(code, /直连 xAI 官方接口/);
});

test('quota auto-load deduplicates, expires per account and keeps refresh independent from key reveal', async () => {
  let now = 0, dialog = null, sequence = 0;
  const calls = [], cancellations = [];
  const S = { config: { quotaRevision: 'account-a' }, configRevision: 'file-a', capabilities: { secretsAllowed: true } };
  const makeDialog = (id = 'tavily') => {
    const base = { url: '', searchUrl: '', key: 'synthetic', keys: ['synthetic-a', 'synthetic-b'] };
    return { id, kind: 'card', base, draft: structuredClone(base),
      configBaseline: { revision: S.configRevision, quotaRevision: S.config.quotaRevision } };
  };
  const factory = loadClient({ Date: class extends Date { static now() { return now; } } }).__test.quotaView;
  let failNext = false;
  const view = factory({
    $: () => null, S, getDialog: () => dialog, dlg: {}, active: () => null,
    DEF: { tavilyUrl: 'https://quota.example.test', exaUrl: 'https://exa.example.test' },
    SUPP: ['tavily', 'exa', 'tinyfish', 'firecrawl'], dialogBusy: () => false,
    uuid: () => String(++sequence), remote: {
      previewAccountQuota(request) {
        calls.push(request);
        return Promise.resolve({ value: { kind: 'credits', remaining: 100 } });
      },
      accountQuota(request) {
        calls.push(request);
        if (failNext) { failNext = false; return Promise.reject(new Error('synthetic failure')); }
        return Promise.resolve({ value: { kind: 'credits', remaining: 100 } });
      },
      cancelDiagnosis(request) { cancellations.push(request); return Promise.resolve({ cancelled: true }); },
    },
  });
  dialog = makeDialog();
  await Promise.all([view.open(), view.open(), view.refresh()]);
  assert.equal(calls.length, 1, 'in-flight opens and manual refresh coalesce');
  view.cancel(); dialog = makeDialog();
  await view.open();
  assert.equal(calls.length, 1, 'reopening the same account reuses its fresh snapshot');
  await view.key(1);
  assert.equal(calls.length, 2, 'each saved Tavily key has a distinct automatic lookup');
  await view.key(0);
  assert.equal(calls.length, 2, 'switching back reuses the correct key cache');
  now = 30_001; view.cancel(); dialog = makeDialog();
  await view.open();
  assert.equal(calls.length, 3, 'expired cache refreshes on reopen');
  failNext = true; await view.refresh();
  assert.equal(calls.length, 4, 'manual refresh bypasses cache freshness');
  view.render(); view.cancel(); dialog = makeDialog();
  await view.open();
  assert.equal(calls.length, 4, 'failed query also has a short retry cooldown');
  now += 30_001; view.cancel(); dialog = makeDialog();
  await view.open();
  assert.equal(calls.length, 5, 'later reopen retries a previously failed account');
  S.config.quotaRevision = 'account-b'; dialog = makeDialog();
  await view.open();
  assert.equal(calls.length, 6, 'effective configuration identity invalidates old balances');
  dialog.draft.url = 'https://unsaved.example.test'; view.render();
  await view.open();
  assert.equal(calls.length, 7, 'explicit draft lookup uses the form without saving');
  assert.equal(calls.at(-1).draft.baseUrl, 'https://unsaved.example.test');
  dialog = makeDialog('exa'); await view.open();
  assert.equal(calls.length, 7, 'no invented Exa endpoint');
  S.capabilities.secretsAllowed = false; dialog = makeDialog(); await view.open();
  assert.equal(calls.length, 7, 'unsafe connections never automatically query');
  assert.equal(calls.slice(0, 6).every(call => Object.keys(call).sort().join(',') ===
    'expectedRevision,keyIndex,operationId,provider,quotaRevision'), true, 'RPC never sends key or arbitrary URL from the UI');
  view.dispose();
});

test('quota draft changes, closed dialogs and disposal reject late replies even if text is restored', async () => {
  let dialog, sequence = 0;
  const pending = [], cancelled = [];
  const S = { config: { quotaRevision: 'account' }, configRevision: 'file', capabilities: { secretsAllowed: true } };
  const makeDialog = () => {
    const base = { url: '', key: 'synthetic' };
    return { id: 'firecrawl', kind: 'card', base, draft: { ...base },
      configBaseline: { revision: 'file', quotaRevision: 'account' } };
  };
  const view = createQuotaView({
    $: () => null, S, getDialog: () => dialog, dlg: {}, active: () => null,
    DEF: { fcUrl: 'https://quota.example.test' }, SUPP: ['firecrawl'], dialogBusy: () => false,
    uuid: () => String(++sequence), remote: {
      accountQuota(request) { return new Promise(resolve => pending.push({ request, resolve })); },
      cancelDiagnosis(request) { cancelled.push(request.operationId); return Promise.resolve({ cancelled: true }); },
    },
  });
  dialog = makeDialog();
  const first = view.open();
  dialog.draft.url = 'https://changed.example.test'; view.render();
  assert.deepEqual(cancelled, [pending[0].request.operationId]);
  dialog.draft.url = ''; view.render();
  pending[0].resolve({ value: { kind: 'credits', remaining: 100 } }); await first;
  const second = view.open();
  assert.equal(pending.length, 2, 'cancelled reply was not cached after restoring the original text');
  view.cancel(); dialog = null; view.render();
  pending[1].resolve({ value: { kind: 'credits', remaining: 200 } }); await second;
  dialog = makeDialog();
  const third = view.open();
  assert.equal(pending.length, 3, 'closed-dialog reply was not cached');
  view.dispose();
  pending[2].resolve({ value: { kind: 'credits', remaining: 300 } }); await third;
  assert.deepEqual(cancelled, pending.map(item => item.request.operationId));
  await view.open();
  assert.equal(pending.length, 3, 'disposed UI starts no new query');
});

test('bundled route controller separates search errors from credential feedback', () => {
  assert.equal(typeof loadClient().__test.routeController, 'function');
  const code = readFileSync(new URL('../src/ui/route-controller.mjs', import.meta.url), 'utf8');
  assert.match(code, /class="note search-result"/);
  assert.match(code, /GROK_SOURCES_EMPTY: \['来源', '未返回引用链接'\]/);
  assert.doesNotMatch(code, /没有可核验来源|没有可核验回答/);
});

test('chat route presentation preserves the host view and never infers unknown history', () => {
  assert.doesNotMatch(clientSource, /toolName\s*=\s*['"]dsh-grok-search|lastRoute.*toolCallRoute/);
  const view = loadClient().__test.toolRouteView({ React: {}, jsx() {}, remote: {}, Original() {} });
  const unknown = view.describe({ known: false, routes: [] }, 'result', false);
  assert.equal(unknown.text, '本次来源未记录');
  assert.equal(unknown.known, false);
  const success = view.describe({ known: true, state: 'done', routes: [
    { served: 'tavily', outcome: 'ok', fallbackUsed: false },
  ] }, 'result', false);
  assert.equal(success.text, '由 dsh-grok-search 执行 · Tavily');
  assert.equal(success.tone, 'ok');
  const fallback = view.describe({ known: true, state: 'done', routes: [
    { served: 'grok-sources', outcome: 'ok', fallbackUsed: true },
  ] }, 'result', false);
  assert.match(fallback.text, /来源未报告 · 已回退$/);
  const attributed = view.describe({ known: true, state: 'done', routes: [
    { served: 'exa', resultProviders: ['grok', 'exa'], resultProvidersComplete: true, fallbackUsed: true },
  ] }, 'result', false);
  assert.equal(attributed.text, '由 dsh-grok-search 执行 · Grok / Exa · 已回退');
  const partial = view.describe({ known: true, state: 'done', routes: [
    { served: 'exa', resultProviders: ['exa'], resultProvidersComplete: false, fallbackUsed: true },
  ] }, 'result', false);
  assert.equal(partial.text, '由 dsh-grok-search 执行 · Exa / 来源未报告 · 已回退');
  const batch = view.describe({ known: true, state: 'done', routes: [
    { served: 'tavily', outcome: 'ok' }, { served: 'exa', outcome: 'ok' },
  ] }, 'result', false);
  assert.match(batch.text, /Tavily \/ Exa$/);
  assert.equal(view.describe({ known: true, state: 'failed', routes: [
    { served: null, outcome: 'failed', code: 'SOURCE_ALL_FAILED' },
  ] }, 'result', true).tone, 'error');
});

test('chat route presentation marks capped calls as incomplete instead of presenting partial sources as all sources', () => {
  const view = createToolRouteView({ React: {}, jsx() {}, remote: {}, Original() {} });
  const routes = [{ served: 'tavily', outcome: 'ok', fallbackUsed: false }];
  const done = view.describe({ known: true, state: 'done', routesComplete: false, routes }, 'result', false);
  assert.equal(done.text, '由 dsh-grok-search 执行 · Tavily · 其余来源未记录');
  assert.equal(done.tone, 'ok');
  const failed = view.describe({ known: true, state: 'failed', routesComplete: false, routes }, 'result', false);
  assert.equal(failed.text, '由 dsh-grok-search 执行 · Tavily · 其余来源未记录 · 搜索失败');
  assert.equal(failed.tone, 'error');
  assert.equal(view.describe({ known: true, state: 'done', routes }, 'result', false).text, '由 dsh-grok-search 执行 · Tavily');
});

// Drive the production subscription directly; real React/DOM is covered by the
// isolated browser and Desktop checks, not emulated with a partial hook engine.
function routeHarness() {
  let answer = null, identity, callIdentity, subscription;
  const requests = [];
  const view = createToolRouteView({
    React: {},
    jsx: (type, props) => ({ type, props }), Original() {},
    remote: { toolCallRoute: request => new Promise((resolve, reject) => requests.push({ request, resolve, reject })) },
  });
  const render = (phase, callId = 'same-call', sessionId = 'session') => {
    const nextCall = JSON.stringify([sessionId, callId]), nextIdentity = JSON.stringify([sessionId, callId, phase]);
    if (nextCall !== callIdentity) {
      subscription?.dispose(); callIdentity = nextCall;
      subscription = view.watch({ sessionId, callId, phase, onChange: value => { answer = value; } });
    }
    if (nextIdentity !== identity) {
      identity = nextIdentity; answer = null;
      subscription.update({ phase, visible: true });
    }
    const readable = typeof sessionId === 'string' && typeof callId === 'string' && phase !== 'preparing';
    const label = readable && (!answer || answer.reading) ? { text: '正在读取本次来源…', tone: 'unknown' }
      : answer?.unreadable ? { text: `本次来源暂不可读 · ${answer.code}`, tone: 'unknown' }
        : view.describe(answer?.result, phase, false);
    return { children: label.text, 'data-tone': label.tone };
  };
  const reply = async result => { requests.shift().resolve(result); await Promise.resolve(); };
  return { view, requests, render, reply, unmount: () => subscription?.dispose() };
}

test('tool route mount and phase changes stay neutral while reading, until the final unknown reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { view, requests, render, reply, unmount } = routeHarness();
  const reading = props => {
    assert.equal(props.children, '正在读取本次来源…');
    assert.equal(props['data-tone'], 'unknown');
  };
  try {
    reading(render('result'));
    await reply({ known: false, state: 'unknown', routes: [] });
    reading(render('result'));
    t.mock.timers.tick(750);
    await reply({ known: false, state: 'unknown', routes: [] });
    reading(render('result'));
    t.mock.timers.tick(750);
    await reply({ known: false, state: 'unknown', routes: [] });
    assert.equal(render('result').children, '本次来源未记录');
    const result = { known: true, state: 'running', routes: [{ served: 'tavily', outcome: 'ok' }] };
    reading(render('start'));
    await reply(result);
    assert.match(render('start').children, /Tavily · 正在搜索$/);
    reading(render('result'));
    await reply({ ...result, state: 'done' });
    assert.equal(render('result').children, '由 dsh-grok-search 执行 · Tavily');
    assert.equal(view.describe({ known: false, routes: [] }, 'result', false).text, '本次来源未记录');
    reading(render('result', 'unreadable'));
    requests.shift().reject(new Error('synthetic RPC unavailable'));
    await Promise.resolve();
    assert.equal(render('result', 'unreadable').children, '本次来源暂不可读 · SETTINGS_UNAVAILABLE');
  } finally { unmount(); t.mock.timers.reset(); }
});

test('tool route reading state needs a polled identity and leaves start wording to the reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { requests, render, reply, unmount } = routeHarness();
  try {
    assert.equal(render('result', 'no-session', null).children, '本次来源未记录');
    assert.equal(render('start', null).children, '正在确认搜索通道…');
    assert.equal(render('preparing').children, '等待搜索调用');
    assert.equal(requests.length, 0, 'a card that is never polled must not wait in the reading state');
    assert.equal(render('start').children, '正在读取本次来源…');
    await reply({ known: false, state: 'unknown', routes: [] });
    assert.equal(render('start').children, '正在确认搜索通道…');
    t.mock.timers.tick(750);
    assert.equal(requests.length, 1, 'start keeps polling until the route is published');
  } finally { unmount(); t.mock.timers.reset(); }
});

test('cancelled tool routes stay cancelled even when the host marks the result as an error', () => {
  const view = createToolRouteView({ React: {}, jsx() {}, remote: {}, Original() {} });
  const label = view.describe({ known: true, state: 'cancelled',
    routes: [{ served: 'tavily', outcome: 'cancelled' }] }, 'result', true);
  assert.equal(label.text, '由 dsh-grok-search 执行 · Tavily · 已取消');
  assert.equal(label.tone, 'cancelled');
});

test('chat model keeps pending suppliers separate from actual attempts and never reconstructs missing latency', () => {
  const view = createToolRouteView({ React: {}, jsx() {}, remote: {}, Original() {} });
  const props = {phase:'start',block:{argsRaw:JSON.stringify({queries:['same query','same query','second query']})}};
  const trace={known:true,state:'running',elapsedMs:null,routes:[{outcome:'running',phase:'search',
    planned:['grok','tavily','exa','tinyfish','firecrawl'],calls:[
      {provider:'grok',result:'failed',code:'grok_timeout',elapsedMs:null,evidence:'kernel-summary'},
      {provider:'tavily',result:'running',keyIndex:0,elapsedMs:null,evidence:'dispatch'},
    ]}]};
  const running=view.model(trace,props);
  assert.equal(running.query,'2 个查询');
  assert.equal(Object.hasOwn(running.routes[0],'stacked'),false);
  assert.equal(running.routes[0].calls.filter(row=>row.result==='pending').length,3);
  assert.equal(running.routes[0].calls[0].elapsedMs,null);
  assert.equal(running.routes[0].partial,true);
  const done=view.model({...trace,state:'done',routes:[{...trace.routes[0],outcome:'ok',served:'tavily',
    calls:[{provider:'tavily',result:'ok',keyIndex:0,elapsedMs:100,evidence:'dispatch'}]}]},
    {phase:'result',block:{call:{argsRaw:props.block.argsRaw},meta:{sources:[],truncated:false}}});
  assert.equal(done.routes[0].calls.length,1,'unattempted suppliers are not labelled as failed');
  assert.equal(done.state,'done');
  assert.equal(Object.hasOwn(done.routes[0],'stacked'),false,'source planning cannot select a vertical layout');
});

test('chat results use host data, escape via React, and reject executable or credential-bearing URLs', () => {
  const view=createToolRouteView({React:{},jsx(){},remote:{},Original(){}});
  const trace={known:true,state:'done',routes:[{outcome:'ok',served:'exa',resultProviders:['exa'],calls:[]}]};
  const value=view.model(trace,{phase:'result',block:{call:{argsRaw:'{"queries":["<script>query</script>"]}'},
    meta:{answer:'Original summary',truncated:true,sources:[
      {url:'javascript:alert(1)',title:'bad'},
      {url:'https://secret:token@example.test/'},
      {url:'https://example.test/a',title:'<img src=x onerror=alert(1)>',snippet:'Source excerpt',publishedAt:'2026-11-10'},
    ]}}});
  assert.equal(value.sources.length,1);
  assert.equal(value.sources[0].title,'<img src=x onerror=alert(1)>');
  assert.equal(value.sources[0].snippet,'Source excerpt');
  assert.equal(value.answer,'Original summary');
  assert.equal(value.truncated,true);
  assert.equal(value.routes[0].calls[0].evidence,'source-label');
  assert.equal(value.routes[0].calls[0].elapsedMs,null);
});

test('a host result cannot turn an unsettled route snapshot into a successful card', () => {
  const view=createToolRouteView({React:{},jsx(){},remote:{},Original(){}});
  const props={phase:'result',block:{call:{argsRaw:'{"queries":["weather"]}'},meta:{sources:[]}}};
  const trace={known:true,state:'running',routes:[{outcome:'running',phase:'search',
    planned:['tavily'],calls:[{provider:'tavily',result:'running',elapsedMs:null}]}]};
  const waiting=view.model(trace,props);
  assert.equal(waiting.state,'running');
  assert.equal(waiting.label,'正在确认结果');
  assert.equal(waiting.routes[0].calls[0].result,'running');
  for(const state of ['failed','cancelled']){
    const settled=view.model({...trace,state,routes:[{...trace.routes[0],outcome:state,
      calls:[{provider:'tavily',result:state,code:'HTTP_401'}]}]},props);
    assert.equal(settled.state,state);
    assert.notEqual(settled.label,'已完成');
  }
});

test('a finished card revalidates once when visible again and discards cleared attribution', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const requests=[],updates=[];
  const view=createToolRouteView({React:{},jsx(){},Original(){},remote:{
    toolCallTrace:()=>new Promise(resolve=>requests.push(resolve)),
  }});
  const watch=view.watch({sessionId:'s',callId:'c',phase:'result',onChange:value=>updates.push(value)});
  const flush=async()=>{await Promise.resolve();await Promise.resolve();};
  try{
    watch.update({phase:'result',visible:true});
    requests.shift()({known:true,state:'done',routes:[{outcome:'ok',served:'tavily'}]});await flush();
    t.mock.timers.tick(5000);assert.equal(requests.length,0,'terminal cards do not continuously poll');
    watch.update({phase:'result',visible:false});
    watch.update({phase:'result',visible:true});
    assert.equal(requests.length,1,'visibility resumes a bounded validity check');
    for(let index=0;index<3;index++){
      requests.shift()({known:false,state:'unknown',routes:[]});await flush();
      if(index<2)t.mock.timers.tick(750);
    }
    assert.equal(updates.at(-1).result.known,false);
    t.mock.timers.tick(5000);assert.equal(requests.length,0,'unknown results stop after the bounded retry window');
  }finally{watch.dispose();t.mock.timers.reset();}
});

test('unsettled terminal attribution times out neutrally instead of spinning or claiming success', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const requests=[],updates=[];
  const view=createToolRouteView({React:{},jsx(){},Original(){},remote:{
    toolCallTrace:()=>new Promise(resolve=>requests.push(resolve)),
  }});
  const watch=view.watch({sessionId:'s',callId:'c',phase:'result',onChange:value=>updates.push(value)});
  try{
    watch.update({phase:'result',visible:true});
    for(let index=0;index<3;index++){
      requests.shift()({known:true,state:'running',routes:[{outcome:'running',calls:[]}]});
      await Promise.resolve();await Promise.resolve();
      if(index<2)t.mock.timers.tick(750);
    }
    assert.equal(updates.at(-1).unreadable,true);
    assert.equal(updates.at(-1).code,'TOOL_ROUTE_PENDING');
    assert.equal(updates.at(-1).result,null);
    t.mock.timers.tick(5000);assert.equal(requests.length,0);
  }finally{watch.dispose();t.mock.timers.reset();}
});

test('route watcher pauses offscreen, deduplicates identical snapshots, and drops late replies on disposal', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const requests=[],updates=[];
  const view=createToolRouteView({React:{},jsx(){},Original(){},remote:{
    toolCallTrace:()=>new Promise(resolve=>requests.push(resolve)),
  }});
  const watch=view.watch({sessionId:'s',callId:'c',phase:'start',onChange:value=>updates.push(value)});
  const running={known:true,state:'running',routes:[{served:null,outcome:'running'}]};
  try {
    watch.update({phase:'start',visible:false});t.mock.timers.tick(2000);
    assert.equal(requests.length,0);
    watch.update({phase:'start',visible:true});watch.update({phase:'start',visible:true});
    assert.equal(requests.length,1,'only one RPC may be in flight');
    requests.shift()(running);await Promise.resolve();await Promise.resolve();
    t.mock.timers.tick(750);requests.shift()(running);await Promise.resolve();await Promise.resolve();
    assert.equal(updates.length,1,'unchanged wire state does not update React');
    watch.update({phase:'start',visible:false});t.mock.timers.tick(5000);
    assert.equal(requests.length,0);
    watch.update({phase:'result',visible:true});
    watch.dispose();requests.shift()({...running,state:'done'});
    await Promise.resolve();await Promise.resolve();
    assert.equal(updates.length,1);
  }finally{watch.dispose();t.mock.timers.reset();}
});

test('terminal publication races retry boundedly without converting cancelled calls to success', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const updates=[],requests=[];
  const view=createToolRouteView({React:{},jsx(){},Original(){},remote:{
    toolCallTrace:()=>new Promise(resolve=>requests.push(resolve)),
  }});
  const watch=view.watch({sessionId:'s',callId:'c',phase:'start',onChange:value=>updates.push(value)});
  try {
    watch.update({phase:'start',visible:true});
    watch.update({phase:'result',visible:true});
    requests.shift()({known:true,state:'running',routes:[{outcome:'running',calls:[]}]});
    await Promise.resolve();await Promise.resolve();
    t.mock.timers.tick(750);
    assert.equal(requests.length,1,'a result phase must not settle a stale running snapshot');
    requests.shift()({known:true,state:'cancelled',routes:[{outcome:'cancelled',calls:[]}]});
    await Promise.resolve();await Promise.resolve();t.mock.timers.tick(2000);
    assert.equal(requests.length,0);
    assert.equal(updates.at(-1).result.state,'cancelled');
  }finally{watch.dispose();t.mock.timers.reset();}
});

test('a hung trace read becomes a bounded error without stacking requests or repainting hidden cards', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let reads=0,resolve;const updates=[];
  const view=createToolRouteView({React:{},jsx(){},Original(){},remote:{
    toolCallTrace:()=>{reads++;return new Promise(done=>{resolve=done;});},
  }});
  const watch=view.watch({sessionId:'s',callId:'c',phase:'start',onChange:value=>updates.push(value)});
  try {
    watch.update({phase:'start',visible:true});
    watch.update({phase:'start',visible:false});
    t.mock.timers.tick(4000);
    assert.equal(updates.length,0,'offscreen reads cannot trigger React updates');
    watch.update({phase:'start',visible:true});
    assert.equal(updates[0].code,'SETTINGS_READ_TIMEOUT');
    watch.update({phase:'result',visible:true});t.mock.timers.tick(6000);
    assert.equal(reads,1);
    watch.dispose();resolve({known:true,state:'done',routes:[]});
    await Promise.resolve();await Promise.resolve();
    assert.equal(updates.length,1);
  }finally{watch.dispose();t.mock.timers.reset();}
});

test('empty or malformed identities never schedule a trace read', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let reads=0;
  const view=createToolRouteView({React:{},jsx(){},Original(){},remote:{toolCallTrace:async()=>{reads++;return {known:false,routes:[]};}}});
  try{
    for(const [sessionId,callId]of [['','c'],['s',''],['s','bad id'],['s','x'.repeat(513)]]){
      const watch=view.watch({sessionId,callId,phase:'result',onChange:()=>assert.fail('invalid identity cannot publish')});
      watch.update({phase:'result',visible:true});t.mock.timers.tick(5000);watch.dispose();
    }
    assert.equal(reads,0);
  }finally{t.mock.timers.reset();}
});
