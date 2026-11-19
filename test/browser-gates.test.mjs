import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { summarizeChecks, assertBrowserResult, assertRequiredEvidence, stopPreviewService, followStreamingSearchCard } from '../scripts/lib/browser-gates.mjs';

test('observations are not assertions and a fatal assertion is counted once', () => {
  const rows = [{ name: 'works', passed: true }, { name: 'metric', kind: 'observation', measurement: 10 },
    { name: 'fails', passed: false }];
  assert.deepEqual(summarizeChecks(rows, 'assertion'), { passed: 1, failed: 1, observations: 1, fatal: 'assertion' });
  assert.equal(summarizeChecks([], 'setup failed').failed, 1);
});

test('successful process exit is not enough without a valid successful browser receipt', () => {
  for (const value of [undefined, {}, { passed: 0, failed: 0 }, { passed: 1, failed: 1 },
    { passed: 1, failed: 0, errors: ['error'] }, { passed: 1, failed: 0, fatal: 'setup failed' },
    { passed: 1, failed: 0, checks: [{ passed: false }] }]) assert.throws(() => assertBrowserResult(value));
  assert.deepEqual(assertBrowserResult({ passed: 1, failed: 0 }), { passed: 1, failed: 0 });
});

test('streaming observer waits for the real card and follows replacements with the same call identity', () => {
  const card = (id, hydrated = false) => {
    const value = { dataset: { dsgSearchCard: id, visible: 'false' }, isConnected: true,
      hydrated, open: false, scrolls: 0, readerIntents: 0,
      dispatchEvent(event) { assert.equal(event.type, 'wheel'); assert.equal(event.deltaY, -1); this.readerIntents++; },
      scrollIntoView(options) { assert.deepEqual(options, { block: 'center', behavior: 'instant' }); this.scrolls++; },
      querySelector(selector) {
        if (!this.hydrated) return null;
        if (selector === '.card-toggle[aria-expanded=false]' && !this.open) return { click: () => { this.open = true; } };
        return selector === '.card-toggle[aria-expanded=true]' && this.open ? {} : null;
      },
    };
    return value;
  };
  const old = card('old', true), pending = card('new');
  let cards = [old, pending], outerExpanded = false;
  const document = { defaultView: { WheelEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } } },
    querySelectorAll(selector) {
    if (selector === '.dsg-chat') return cards;
    return outerExpanded ? [] : [{ click: () => { outerExpanded = true; } }];
  } };
  const state = { initialCallIds: new Set(['old']), card: null, open: false };
  followStreamingSearchCard(document, state);
  assert.equal(outerExpanded, true);
  assert.equal(state.card, pending);
  assert.equal(pending.readerIntents, 1, 'The host follow controller must receive reader intent.');
  assert.equal(state.open, false, 'A visible pending wrapper must not end the observer.');
  pending.dataset.visible = 'true';
  followStreamingSearchCard(document, state);
  assert.equal(state.open, false);
  pending.hydrated = true;
  followStreamingSearchCard(document, state);
  assert.equal(state.open, true);
  assert.equal(pending.readerIntents, 1, 'Do not repeatedly interrupt the same call.');
  assert.equal(pending.scrolls, 1, 'A visible card must not be continuously scrolled.');
  pending.isConnected = false;
  const replacement = card('new', true);
  cards = [replacement]; // Host virtualization may also remove earlier cards.
  followStreamingSearchCard(document, state);
  assert.equal(state.card, replacement, 'Do not retain the detached pending row.');
  assert.equal(state.open, true);
  assert.equal(replacement.scrolls, 1);
  cards = [];
  followStreamingSearchCard(document, state);
  assert.equal(state.card, null);
  assert.equal(state.open, false);
});

test('streaming observer renews reader intent when the host starts following the tail again', () => {
  let following = true, gestures = 0, scrolls = 0;
  const card = {
    dataset: { dsgSearchCard: 'same-call', visible: 'false' }, isConnected: true,
    dispatchEvent() { gestures++; following = false; },
    scrollIntoView() { scrolls++; if (!following) this.dataset.visible = 'true'; },
    querySelector: selector => selector === '.card-toggle[aria-expanded=true]' ? {} : null,
  };
  const document = {
    defaultView: { WheelEvent: class {} },
    querySelectorAll: selector => selector === '.dsg-chat' ? [card] : [],
  };
  const state = { initialCallIds: new Set(), card: null, open: false };
  followStreamingSearchCard(document, state);
  assert.equal(card.dataset.visible, 'true');
  // A new streamed block or fold can restart the host follow animation after
  // the first gesture. Merely scrolling again does not interrupt that owner.
  following = true;
  card.dataset.visible = 'false';
  followStreamingSearchCard(document, state);
  assert.equal(card.dataset.visible, 'true', 'Reacquire reader intent before recovering the view.');
  assert.equal(gestures, 2);
  assert.equal(scrolls, 2);
  followStreamingSearchCard(document, state);
  assert.equal(gestures, 2, 'A visible card must not receive repeated gestures or scrolling.');
  assert.equal(scrolls, 2);
});

test('Desktop streaming diagnostics preserve the failed model call instead of replacing it with a visibility assertion', async () => {
  const source = readFileSync(new URL('../scripts/verify-search-log-desktop.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('      let streamed');
  const end = source.indexOf("      check('streamed model turn succeeds", start);
  assert.ok(start >= 0 && end > start);
  const failure = new Error('Model RPC failed before the streaming turn completed');
  const brokenProfiler = new Error('The crashed host cannot stop its profiler');
  for (const [callFailure, diagnosticFailure] of [[failure, null], [failure, brokenProfiler],
    [null, brokenProfiler], [null, null]]) {
    const records = [], host = {};
    const run = vm.runInNewContext(`(async () => {${source.slice(start, end)}})`, {
      renderer: { async send(method) {
        if (diagnosticFailure) throw diagnosticFailure;
        if (method === 'Page.captureScreenshot') return { data: '' };
        return method === 'Profiler.stop' ? { profile: { nodes: [], samples: [], timeDeltas: [] } } : { metrics: [] };
      } },
      metricsBefore: [], host, version: 'isolated-version', clientBaseline: false,
      run: { directory: '/isolated-evidence' }, join,
      modelTurn: async () => { if (callFailure) throw callFailure; return { completed: true }; },
      dom: async () => ({ visibleCardFrames: 0, measurements: 0, heightAnimations: 0 }),
      writeJson: (path, value) => records.push({ path, value }),
      writeFileSync: (path, value) => records.push({ path, imageBytes: value.length }), Buffer,
      safeError: error => ({ message: error.message }),
      check: (_name, actual, expected = true) => assert.equal(actual, expected),
    });
    await assert.rejects(run(), error => callFailure || diagnosticFailure
      ? error === (callFailure ?? diagnosticFailure) : error.code === 'ERR_ASSERTION');
    if (diagnosticFailure && callFailure) assert.equal(host.streamDiagnosticFailure.message, diagnosticFailure.message);
    else if (!diagnosticFailure) assert.ok(records.some(row => row.path.endsWith('-chat-stream-performance.json')),
      'A failed model call must still retain its bounded performance diagnostics.');
  }
});

test('required evidence rejects missing, invalid and failed selected gates', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evidence-check-'));
  assert.throws(() => assertRequiredEvidence(root, ['search-log-desktop']), /missing/);
  const directory = join(root, 'search-log-desktop', 'fixture');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'summary.json');
  writeFileSync(path, '{"passed":false}');
  assert.throws(() => assertRequiredEvidence(root, ['search-log-desktop']), /Failed/);
  writeFileSync(path, '{"passed":true}');
  assert.deepEqual(assertRequiredEvidence(root, ['search-log-desktop']), [{ group: 'search-log-desktop', receipts: 1 }]);
});

test('CPU diagnostic summaries cannot reject or stand in for a canonical assertion receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evidence-diagnostics-'));
  const directory = join(root, 'search-log-desktop', 'current');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'host-chat-cpu-summary.json'), '{"durations":{},"top":[]}');
  assert.throws(() => assertRequiredEvidence(root, ['search-log-desktop']), /missing/);
  const receipt = join(directory, 'summary.json');
  writeFileSync(receipt, '{"passed":true,"checks":[{"passed":true}]}');
  assert.deepEqual(assertRequiredEvidence(root, ['search-log-desktop']),
    [{ group: 'search-log-desktop', receipts: 1 }]);
  writeFileSync(receipt, '{"passed":false}');
  assert.throws(() => assertRequiredEvidence(root, ['search-log-desktop']), /Failed/);
});

test('evidence must contain affirmative success and rejects every supported failure representation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evidence-shapes-'));
  const directory = join(root, 'gate', 'current');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'summary.json');
  for (const value of [{}, [], { status: 'fail', counts: { pass: 0, fail: 1 } },
    { status: 'pass', counts: { pass: 1, fail: 1 } }, { exitCode: 1, counts: { pass: 1, fail: 0 } },
    { counts: { pass: 1, fail: 0, harnessErrors: 1 }, exitCode: 0 },
    { passed: true, results: [{ status: 'fail' }] }, { passed: true, checks: [{ passed: false }] },
    { passed: true, suites: [{ passed: 0, failed: 1 }] }]) {
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => assertRequiredEvidence(root, ['gate']), /Failed/, JSON.stringify(value));
  }
  for (const value of [{ passed: true }, { status: 'pass', counts: { pass: 2, fail: 0 }, fatal: null },
    { exitCode: 0, counts: { pass: 2, fail: 0, harnessErrors: 0 } },
    { serverInfo: { name: 'grok-search-rs' }, protocolVersion: '2025-03-26', tools: ['web_search'],
      call: { name: 'web_search', isError: false }, process: { exitCode: 0, gracefulStdioEof: true, forced: false } }]) {
    writeFileSync(path, JSON.stringify(value));
    assert.doesNotThrow(() => assertRequiredEvidence(root, ['gate']), JSON.stringify(value));
  }
});

test('UI evidence is bound to this client instead of accepting a stale green receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evidence-identity-'));
  const directory = join(root, 'ui-gates', 'old');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ passed: true, clientSha256: 'old-client' }));
  assert.throws(() => assertRequiredEvidence(root, ['ui-gates'], { clientSha256: 'current-client' }), /identity/);
});

test('checking the explicit run preserves old failures without accepting or mixing their evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evidence-selected-'));
  for (const [runId, passed] of [['old-failed', false], ['current', true]]) {
    const directory = join(root, 'ui-gates', runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({ runId, passed, clientSha256: 'same-client',
      scope: 'generated-client-offline-browser-fixtures', smoke: true, assertionsPassed: 2,
      suites: [{ passed: 1, failed: 0 }, { passed: 1, failed: 0 }] }));
  }
  assert.deepEqual(assertRequiredEvidence(root, ['ui-gates'], { runId: 'current', clientSha256: 'same-client' }),
    [{ group: 'ui-gates', receipts: 1 }]);
  assert.throws(() => assertRequiredEvidence(root, ['ui-gates'], { runId: 'old-failed' }), /Failed/);
  assert.throws(() => assertRequiredEvidence(root, ['ui-gates'], { runId: 'missing' }), /missing/);
  assert.throws(() => assertRequiredEvidence(root, ['ui-gates'], { runId: '../current' }), /identity/);
  writeFileSync(join(root, 'ui-gates/current/summary.json'), JSON.stringify({ runId: 'current',
    passed: true, clientSha256: 'same-client' }));
  assert.throws(() => assertRequiredEvidence(root, ['ui-gates'], { runId: 'current' }), /Incomplete/);
});

test('preview cleanup waits for normal exit and cannot hang on a noncooperative child', async () => {
  for (const ignoreNormal of [false, true]) {
    let done;
    const calls = [];
    const service = { exited: false, closed: new Promise(resolve => { done = resolve; }),
      child: { kill(signal = 'SIGTERM') {
        calls.push(signal);
        if (!ignoreNormal || signal === 'SIGKILL') {
          queueMicrotask(() => { service.exited = true; done(); });
        }
      } } };
    if (ignoreNormal) {
      await assert.rejects(stopPreviewService(service, { timeoutMs: 10 }), /forced cleanup/);
      assert.deepEqual(calls, ['SIGTERM', 'SIGKILL']);
    } else {
      await stopPreviewService(service, { timeoutMs: 10 });
      assert.deepEqual(calls, ['SIGTERM']);
    }
    assert.equal(service.exited, true);
    assert.equal(service.stopping, true);
  }
  const blocked = { exited: false, closed: new Promise(() => {}), child: { kill() {} } };
  await assert.rejects(stopPreviewService(blocked, { timeoutMs: 10 }), /bounded cleanup/);
});

test('a failed resource-comparison mount rejects instead of throwing into an unresolved animation callback', async () => {
  const source = readFileSync(new URL('../scripts/compare-client-resources.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const sample = ') + 'const sample = '.length;
  const end = source.indexOf('\ntry {', start);
  assert.ok(start > 'const sample = '.length && end > start);
  let now = 0, callbackError = null;
  const sample = vm.runInNewContext(`(${source.slice(start, end).trim().replace(/;$/, '')})`, {
    window: { harness: { unmount() {}, mount() {} } },
    document: { querySelector: () => null }, performance: { now: () => now },
    requestAnimationFrame(fn) {
      now += 10_001;
      queueMicrotask(() => { try { fn(); } catch (error) { callbackError = error; } });
    },
  });
  let timer;
  try {
    const result = await Promise.race([sample().then(() => 'resolved', error => error.message),
      new Promise(resolve => { timer = setTimeout(() => resolve('still pending'), 50); })]);
    assert.equal(result, 'Mount did not settle');
    assert.equal(callbackError, null);
  } finally { clearTimeout(timer); }
});

const browserSource = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const browserScript = (file, diagnostics = []) => vm.runInNewContext(`(${browserSource(file)})`, {
  URL, console: { log() {}, error: (...values) => diagnostics.push(values.map(String).join(' ')) },
});

function failedBrowserPage({ failure, screenshotError, evidenceError, reloadEvents = [] }) {
  const origin = 'http://127.0.0.1:4321', listeners = new Map(), evidence = [];
  const page = {
    url: () => origin + '/',
    on(event, callback) { listeners.set(event, callback); },
    async reload() { for (const [event, value] of reloadEvents) listeners.get(event)?.(value); },
    async waitForFunction() {},
    async setViewportSize() { throw failure; },
    async screenshot() { if (screenshotError) throw screenshotError; },
    async evaluate(fn, value) {
      const source = String(fn);
      if (source.includes("fetch('/evidence'")) {
        evidence.push(JSON.parse(JSON.stringify(value)));
        if (evidenceError) throw evidenceError;
        return { ok: true, text: 'recorded', body: 'recorded' };
      }
      if (source.includes('location.origin')) return origin;
      if (source.includes("fetch('/live-evidence'")) return { logs: [], quotas: {} };
      if (source.includes("fetch('/begin'")) return { runId: 'vm-browser-failure', directory: '/unused' };
      throw new Error('Unexpected browser evaluation: ' + source);
    },
  };
  return { page, evidence, origin };
}

for (const file of ['ui-route-browser.js', 'ui-search-log-browser.js',
  'ui-search-log-live-browser.js', 'ui-github-read-browser.js']) {
  test(`${file}: secondary screenshot failures retain the primary error and still attempt evidence`, async () => {
    const failure = new Error('synthetic-browser-primary');
    const screenshotError = new Error('synthetic-screenshot-failure');
    const evidenceError = new Error('synthetic-evidence-failure');
    for (const [imageFailure, reportFailure] of [[null, null], [screenshotError, null],
      [screenshotError, evidenceError]]) {
      const probe = failedBrowserPage({ failure, screenshotError: imageFailure, evidenceError: reportFailure });
      const diagnostics = [];
      await assert.rejects(browserScript(file, diagnostics)(probe.page), error => error === failure);
      assert.equal(probe.evidence.length, 1, 'Evidence must be attempted even when a screenshot fails.');
      assert.equal(probe.evidence[0].failed, 1);
      assert.match(JSON.stringify(probe.evidence[0]), /synthetic-browser-primary/);
      assert.equal(probe.evidence[0].screenshotError, imageFailure ? String(imageFailure) : undefined);
      if (reportFailure) assert.ok(diagnostics.some(value => value.includes(reportFailure.message)));
    }
  });
}

for (const file of ['ui-search-log-browser.js', 'ui-search-log-live-browser.js']) {
  test(`${file}: reload errors and exact-origin request violations enter the diagnostic receipt`, async () => {
    const failure = new Error('stop-after-reload'), startup = new Error('synthetic-startup-error');
    const sameOrigin = 'http://127.0.0.1:4321', otherPort = 'http://127.0.0.1:43210/request';
    const upstream = 'https://outside.example.test/startup';
    const requests = [sameOrigin, sameOrigin + '/local', 'data:text/plain,local', otherPort, upstream];
    const probe = failedBrowserPage({ failure, reloadEvents: [
      ['pageerror', startup], ...requests.map(url => ['request', { url: () => url }]),
    ] });
    await assert.rejects(browserScript(file)(probe.page), error => error === failure);
    assert.deepEqual(probe.evidence[0].errors, [String(startup)]);
    assert.deepEqual(probe.evidence[0].external, [otherPort, upstream]);
  });
}

function settingsPerformancePage(errorPhase = null) {
  const evidence = [], waits = [], listeners = new Map();
  const failure = new Error('synthetic-' + errorPhase + '-error');
  let callsPerQuery = 1, layerRead = 0, detached = 0;
  const layers = [0, 0, 0, 1, 0];
  const locator = selector => ({
    first() { return this; },
    locator: child => locator(child),
    async click() {},
    async count() { return selector === '[data-dsg-layer]' ? layers[layerRead++] : 16; },
    async textContent() { return '\u641c\u7d22\u5185\u5bb9\u5df2\u9690\u85cf'; },
  });
  const page = {
    on(event, callback) { listeners.set(event, callback); },
    async reload() { if (errorPhase === 'startup') listeners.get('pageerror')?.(failure); },
    async setViewportSize() { if (errorPhase === 'runtime') listeners.get('pageerror')?.(failure); },
    async emulateMedia() {},
    async waitForFunction(fn, arg, options) {
      if (/__uiPerf\.ready|path\.getTotalLength/.test(String(fn))) {
        waits.push({ arg, timeout: options?.timeout });
      }
    },
    locator,
    context: () => ({ async newCDPSession() { return {
      async send() { return { metrics: [{ name: 'LayoutCount', value: 1 }] }; },
      async detach() { detached++; },
    }; } }),
    // Stub only browser measurements; execute the original reporting and cleanup flow.
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("fetch('/begin'")) return { runId: 'vm-performance', directory: '/unused' };
      if (arg?.queryCount) callsPerQuery = arg.callsPerQuery;
      if (source.includes('readyMs: probe.ready')) return {
        readyMs: 1, longestFrameMs: 16, longTasks: [], elements: 10, collapsedDetailsElements: 0,
      };
      if (source.includes("article.classList.contains('is-open')")) {
        return { ms: 1, queries: 1, calls: callsPerQuery, open: true };
      }
      if (source.includes('const count = window.harness.state.calls')) return 0;
      if (source.includes('const same =')) return true;
      if (source.includes("fetch('/evidence'")) {
        evidence.push(JSON.parse(JSON.stringify(arg)));
        return { saved: true };
      }
    },
  };
  return { page, evidence, waits, failure, detached: () => detached };
}

for (const phase of ['startup', 'runtime']) {
  test(`settings performance persists ${phase} page errors before rejecting`, async () => {
    const probe = settingsPerformancePage(phase);
    await assert.rejects(browserScript('ui-settings-performance-browser.js')(probe.page),
      error => error.message.includes(probe.failure.message));
    assert.equal(probe.evidence.length, 1);
    assert.equal(probe.evidence[0].passed, false);
    assert.deepEqual(probe.evidence[0].errors, [String(probe.failure)]);
    assert.equal(probe.evidence[0].scenarios.length, 3, 'Keep measured diagnostics on a failed run.');
    assert.equal(probe.detached(), 1);
  });
}

test('settings performance passes bounded wait options as the third Playwright argument', async () => {
  const probe = settingsPerformancePage();
  await browserScript('ui-settings-performance-browser.js')(probe.page);
  assert.deepEqual(probe.waits, [30000, 30000, 30000, 10000, 10000]
    .map(timeout => ({ arg: undefined, timeout })));
  assert.equal(probe.evidence[0].passed, true);
  assert.equal(probe.detached(), 1);
});

async function checkLiveCharge(charge, displayed, unknownCount = 0) {
  const source = browserSource('ui-search-log-live-browser.js');
  const start = source.indexOf("    for (const provider of ['tavily', 'exa', 'firecrawl', 'tinyfish'])");
  const end = source.indexOf('    const fallback = ', start);
  assert.ok(start >= 0 && end > start);
  const providers = ['tavily', 'exa', 'firecrawl', 'tinyfish'];
  const valueFor = (value, provider) => typeof value === 'function' ? value(provider) : value;
  const input = { logs: providers.map(provider => ({ served: provider, kind: 'sources',
    calls: [{ provider, charge: valueFor(charge, provider) }] })) };
  const usage = provider => ({ locator(selector) {
    if (selector === '.lu-charge') return { async textContent() { return valueFor(displayed, provider); } };
    if (selector === '.lu-unknown') return { async count() { return valueFor(unknownCount, provider); } };
    throw new Error('Unexpected usage selector: ' + selector);
  } });
  const rows = providers.map(provider => ({
    async innerText() { return `12:34:56 ${provider} ${valueFor(displayed, provider)} another call: 1 credits\u63a5\u53e3\u62a5\u544a`; },
    locator(selector) {
      if (selector === '.le-head') return { async click() {} };
      if (selector === '.lu-row') return { first: () => usage(provider) };
      // An unrelated call's unknown cost must not satisfy the selected call.
      if (selector === '.lu-unknown') return { async count() { return 1; } };
      throw new Error('Unexpected row selector: ' + selector);
    },
  }));
  const execute = vm.runInNewContext(`(async () => {${source.slice(start, end)}})`, {
    input, page: { locator: () => ({ nth: index => rows[index] }) },
    check: (name, actual, expected = true) => assert.equal(actual, expected, name),
  });
  await execute();
}

test('live charge accuracy rejects row timestamps, unrelated costs and numeric substrings', async () => {
  for (const amount of ['999', '11']) {
    await assert.rejects(checkLiveCharge({ basis: 'reported', amount: 1, unit: 'credits' },
      amount + ' credits\u63a5\u53e3\u62a5\u544a'), /real charge accuracy/);
  }
  await assert.rejects(checkLiveCharge({ basis: 'unknown' }, '', 0), /real charge accuracy/);
});

test('live charge accuracy accepts production-normalized rendered costs including reported Exa input', async () => {
  const source = browserSource('../src/ui/search-log-view.mjs');
  const usageStart = source.indexOf('const USAGE_CHANNELS = ');
  const usageEnd = source.indexOf('\nlet logRows =', usageStart);
  const chargeStart = source.indexOf('function logChargeAmount(');
  const chargeEnd = source.indexOf('\nfunction logCallsHtml(', chargeStart);
  assert.ok(usageStart >= 0 && usageEnd > usageStart && chargeStart >= 0 && chargeEnd > chargeStart);
  // Use the production normalization and markup, not hand-authored UI text.
  const render = vm.runInNewContext(`call => {
    ${source.slice(usageStart, usageEnd)}
    ${source.slice(chargeStart, chargeEnd)}
    return logCharge(normalizeUsage([call])[0]);
  }`, {
    SUPP: ['tavily', 'exa', 'firecrawl', 'tinyfish'],
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  const providers = ['tavily', 'exa', 'firecrawl', 'tinyfish'];
  for (const [basis, amount] of [['reported', 1], ['reported', 1234.5], ['estimated', .003],
    ['reported', .0000001], ['unknown', null]]) {
    const charge = provider => ({ basis, amount,
      unit: provider === 'tavily' || provider === 'firecrawl' ? 'credits' : 'USD' });
    const html = Object.fromEntries(providers.map(provider => [provider, render({ provider, charge: charge(provider) })]));
    if (basis === 'reported') assert.match(html.exa, /data-basis="estimated"/);
    await checkLiveCharge(charge,
      provider => html[provider].replace(/<[^>]*>/g, '').replaceAll('&lt;', '<'),
      provider => Number(html[provider].includes('class="lu-unknown"')));
  }
});
