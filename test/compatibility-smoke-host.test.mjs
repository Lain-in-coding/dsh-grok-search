import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  COMPATIBILITY_SMOKE_MARKER, compatibilitySmokeReady, invokeCompatibilitySearch,
  prepareCompatibilitySmoke, runCompatibilityHostProbe, snapshotCompatibility,
} from '../scripts/compatibility-smoke-host.mjs';
import {
  HOST_TRANSITION_MARKER, HOST_TRANSITION_VERIFIER_PATHS, assertTransitionRetention,
  controlIntentProjection, parseHostTransitionArgs, prepareHostTransitionProfile, readHostTransitionRuntime, readTransitionControl,
  runCompatibilityHostTransitions, runHostTransitionSequence, runHostTransitionWorker,
  validateHostTransitionExecution, validateHostTransitionPair,
} from '../scripts/compatibility-host-transitions.mjs';
import { COMPATIBILITY_LANES, officialMetadataUrl, sha256 } from '../scripts/lib/compatibility-evidence.mjs';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { createCompatibilityState } from '../src/core/compatibility-state.mjs';

const idle = () => ({ running: 0, queued: 0, faulted: 0 });
const query = 'compatibility-smoke-unit';
const gateNames = ['package-admission', 'capabilities', 'search-no-official-fallback', 'cancellation'];
const legacySnapshot = () => ({
  compatibility: null, core: { ...idle(), routeExecutor: idle() },
  runtimeWeb: { searchProviderId: 'grok-search', fetchProviderId: 'candidate-fetch' }, budgets: null,
});

function temporary(t) {
  const parent = realpathSync(tmpdir()), prefix = 'dsh-compatibility-smoke-unit-';
  const root = mkdtempSync(join(parent, prefix));
  t.after(ctx => {
    assert.equal(dirname(root), parent);
    assert.ok(basename(root).startsWith(prefix));
    assert.equal(lstatSync(root).isSymbolicLink(), false);
    if (ctx?.passed !== false && process.env.DSH_KEEP_TEST_FIXTURES !== '1') {
      rmSync(root, { recursive: true });
    }
  });
  return root;
}

test('isolated source-only preparation pins loopback configuration and disables Grok and GitHub', t => {
  const directory = temporary(t), profile = join(directory, 'dsh-home', 'profiles', 'candidate');
  const configured = prepareCompatibilitySmoke({ directory, profile, endpoint: 'http://127.0.0.1:43127' });
  const text = readFileSync(configured.configPath, 'utf8');
  assert.equal(configured.budgetMs, 30_000);
  assert.equal(configured.executable, join(directory, 'intentionally-missing-grok-program'));
  assert.equal(existsSync(configured.executable), false);
  assert.match(text, /^tavily_api_url = "http:\/\/127\.0\.0\.1:43127"$/m);
  assert.match(text, /^tavily_api_key = "compatibility-smoke-synthetic-key"$/m);
  assert.match(text, /^grok_api_key = ""$/m);
  assert.match(text, /^source_providers = \["tavily"\]$/m);
  for (const source of ['exa', 'tinyfish', 'firecrawl']) assert.match(text, new RegExp(`^${source}_enabled = false$`, 'm'));
  const preferencesPath = join(profile, 'grok-search', 'preferences.json');
  const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'));
  assert.deepEqual(preferences, {
    schemaVersion: 1, grokEnabled: false, githubEnabled: false, githubReadEnabled: false,
    sourceOrder: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
    sourceEnabled: { tavily: true, exa: false, tinyfish: false, firecrawl: false },
  });
  assert.throws(() => prepareCompatibilitySmoke({ directory, profile, endpoint: 'http://127.0.0.1:43128' }),
    { code: 'EEXIST' });
  assert.equal(readFileSync(configured.configPath, 'utf8'), text);
  assert.deepEqual(JSON.parse(readFileSync(preferencesPath, 'utf8')), preferences);
});

test('preparation rejects non-loopback endpoints, escaped profiles, and a pre-existing program', t => {
  const directory = temporary(t), profile = join(directory, 'profile');
  for (const endpoint of [
    'https://127.0.0.1:43127', 'http://localhost:43127', 'http://example.invalid:43127',
    'http://127.0.0.1', 'http://user:password@127.0.0.1:43127',
    'http://127.0.0.1:43127/search', 'http://127.0.0.1:43127/?key=private', 'http://127.0.0.1:43127/#private',
  ]) {
    assert.throws(() => prepareCompatibilitySmoke({ directory, profile, endpoint }),
      { code: 'COMPATIBILITY_SMOKE_ENDPOINT_INVALID' });
  }
  assert.equal(existsSync(profile), false);
  assert.throws(() => prepareCompatibilitySmoke({
    directory, profile: join(directory, '..', 'escaped-smoke-profile'), endpoint: 'http://127.0.0.1:43127',
  }), { code: 'COMPATIBILITY_SMOKE_PATH_UNSAFE' });
  writeFileSync(join(directory, 'intentionally-missing-grok-program'), 'not an executable');
  assert.throws(() => prepareCompatibilitySmoke({ directory, profile, endpoint: 'http://127.0.0.1:43127' }),
    { code: 'COMPATIBILITY_SMOKE_PROGRAM_PRESENT' });
  assert.equal(existsSync(profile), false);
});

test('snapshots preserve unknown observations and exclude raw program diagnostics', () => {
  const empty = snapshotCompatibility({ get: () => undefined });
  assert.deepEqual(empty, { compatibility: null, officialSearchCalls: null, runtimeWeb: null, core: null, budgets: null });
  const services = {
    grokSearchCore: { snapshot: () => ({
      ...idle(), routeExecutor: idle(), session: { connected: true, active: false },
      lastDiagnostic: { childPid: 123, configPath: '/private/config', message: 'Bearer private-value' },
    }) },
    web: { config: { searchProvider: { get: () => 'grok-search' }, fetchProvider: 'candidate-fetch' } },
    grokSearchBudgets: { snapshot: () => ({ budgetMs: 30_000, owned: 1, releasing: false }) },
  };
  const value = snapshotCompatibility({ get: name => services[name] }, { calls: { original: 2 } });
  assert.equal(value.compatibility, null);
  assert.equal(value.officialSearchCalls, 2);
  assert.equal(value.runtimeWeb.searchProviderId, 'grok-search');
  assert.equal(value.runtimeWeb.fetchProviderId, 'candidate-fetch');
  assert.equal(value.core.childStarted, true);
  assert.equal(value.core.sessionConnected, true);
  assert.equal(value.core.sessionActive, false);
  assert.doesNotMatch(JSON.stringify(value), /private|Bearer|configPath|childPid/);
});

test('legacy readiness allows execution evidence without inventing a coordinator report', () => {
  const value = legacySnapshot();
  assert.equal(compatibilitySmokeReady(value), true);
  assert.equal(compatibilitySmokeReady(value, { requireReport: true }), false);
  for (const invalid of [
    null, {}, { ...value, core: null }, { ...value, runtimeWeb: { searchProviderId: 'candidate-original' } },
    { ...value, core: { ...value.core, running: 1 } },
    { ...value, core: { ...value.core, queued: 1 } },
    { ...value, core: { ...value.core, faulted: 1 } },
    { ...value, core: { ...value.core, routeExecutor: null } },
  ]) assert.equal(compatibilitySmokeReady(invalid), false);
  assert.equal(value.compatibility, null);
});

test('coordinator readiness requires coreReady, an allowed phase, and a real budget lease', () => {
  const value = { ...legacySnapshot(), budgets: { owned: 1 }, compatibility: { coreReady: true, phase: 'degraded' } };
  assert.equal(compatibilitySmokeReady(value, { requireReport: true }), true);
  assert.equal(compatibilitySmokeReady({ ...value, compatibility: { coreReady: true, phase: 'ready' } }), true);
  for (const phase of ['initial', 'checking', 'waiting-confirmation', 'blocked', 'stopped']) {
    assert.equal(compatibilitySmokeReady({ ...value, compatibility: { coreReady: true, phase } }), false);
  }
  assert.equal(compatibilitySmokeReady({ ...value, compatibility: { coreReady: false, phase: 'ready' } }), false);
  assert.equal(compatibilitySmokeReady({ ...value, budgets: { owned: 0 } }), false);
  assert.equal(compatibilitySmokeReady({ ...value, budgets: null }), false);
});

test('legacy native invocation preserves structured arguments, signal, and agent context', async () => {
  const signal = new AbortController().signal, inputs = [], result = { isError: false, content: [] };
  const ctx = { get: () => ({ execute: async input => { inputs.push(input); return result; } }) };
  assert.equal(await invokeCompatibilitySearch(ctx, { queries: [query], signal }), result);
  assert.equal(await invokeCompatibilitySearch(ctx, { queries: [query], signal }), result);
  assert.equal(inputs[0].name, 'web_search');
  assert.deepEqual(inputs[0].arguments, { queries: [query] });
  assert.equal(inputs[0].signal, signal);
  assert.equal(inputs[0].agent.ctx, ctx);
  assert.notEqual(inputs[0].callId, inputs[1].callId);
  assert.notEqual(inputs[0].agent.session.id, inputs[1].agent.session.id);
});

test('modern native invocation resolves one tool set and always awaits its disposal', async () => {
  for (const outcome of ['success', 'throw', 'empty', 'missing-result', 'multiple-results']) {
    const signal = new AbortController().signal, events = [], failure = new Error('synthetic-native-failure');
    const result = { isError: false, content: [] };
    const toolSet = { async dispose() { await Promise.resolve(); events.push('disposed'); } };
    const ctx = { get: () => ({
      async resolve(input) {
        events.push('resolved');
        assert.equal(input.signal, signal);
        assert.equal(input.agent.ctx, ctx);
        assert.equal(input.modelSelection.provider, 'compatibility-smoke');
        return toolSet;
      },
      async execute(input) {
        events.push('executed');
        assert.equal(input.toolSet, toolSet);
        assert.equal(input.signal, signal);
        assert.equal(input.agent.session.requestContext?.()?.provider, 'compatibility-smoke');
        assert.equal(input.calls.length, 1);
        assert.equal(input.calls[0].type, 'tool_call');
        assert.equal(input.calls[0].name, 'web_search');
        assert.deepEqual(JSON.parse(input.calls[0].arguments), { queries: [query] });
        if (outcome === 'throw') throw failure;
        return { results: outcome === 'empty' ? [] : outcome === 'missing-result' ? [{}]
          : outcome === 'multiple-results' ? [{ result }, { result }] : [{ result }] };
      },
    }) };
    const task = invokeCompatibilitySearch(ctx, { modern: true, queries: [query], signal });
    if (outcome === 'success') assert.equal(await task, result);
    else if (outcome === 'throw') await assert.rejects(task, error => error === failure);
    else await assert.rejects(task, { code: 'COMPATIBILITY_SMOKE_NATIVE_RESULT_INVALID' });
    assert.deepEqual(events, ['resolved', 'executed', 'disposed']);
  }
});

test('invalid queries, absent executors, and pre-aborted callers never execute a tool', async () => {
  const ctx = { get() { assert.fail('Invalid input must not access host services.'); } };
  for (const queries of [null, [], [query, query, query, query, query], ['external query'], [5], ['compatibility-smoke-' + 'a'.repeat(100)]]) {
    await assert.rejects(invokeCompatibilitySearch(ctx, { queries }), { code: 'COMPATIBILITY_SMOKE_QUERY_INVALID' });
  }
  await assert.rejects(invokeCompatibilitySearch({ get: () => null }), { code: 'COMPATIBILITY_SMOKE_NATIVE_TOOL_UNAVAILABLE' });
  const controller = new AbortController(), reason = new Error('synthetic-caller-cancelled');
  controller.abort(reason);
  const inactive = { get: () => ({ execute() { assert.fail('Execution after cancellation.'); },
    resolve() { assert.fail('Resolution after cancellation.'); } }) };
  await assert.rejects(invokeCompatibilitySearch(inactive, { modern: true, signal: controller.signal }), error => error === reason);
});

// All host modules and HTTP transports below are synthetic. No receipt from
// these tests is evidence that an official host or published package passed.
function mockHttp(t) {
  let server;
  t.mock.method(net.Server.prototype, 'listen', () => { throw new Error('UNIT_NETWORK_FORBIDDEN'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('UNIT_NETWORK_FORBIDDEN'); });
  t.mock.method(http, 'createServer', handler => {
    server = new EventEmitter();
    server.closed = false;
    server.address = () => ({ port: 43127 });
    server.listen = (port, host, done) => {
      assert.equal(port, 0); assert.equal(host, '127.0.0.1'); queueMicrotask(done); return server;
    };
    server.close = done => { server.closed = true; queueMicrotask(done); };
    server.closeAllConnections = () => {};
    server.dispatch = (query, signal) => new Promise((done, fail) => {
      const request = new EventEmitter(), response = new EventEmitter();
      request.method = 'POST'; request.url = '/search';
      request.headers = { authorization: 'Bearer compatibility-smoke-synthetic-key' };
      request.destroy = () => fail(new Error('Synthetic request destroyed.'));
      response.writableEnded = false;
      response.writeHead = status => { assert.equal(status, 200); };
      const abort = () => { response.emit('close'); fail(signal.reason); };
      response.end = body => {
        response.writableEnded = true;
        response.emit('close');
        signal?.removeEventListener('abort', abort);
        done(JSON.parse(body));
      };
      handler(request, response);
      signal?.addEventListener('abort', abort, { once: true });
      request.emit('data', Buffer.from(JSON.stringify({ query })));
      request.emit('end');
    });
    return server;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { get server() { return server; } };
}

function mockInstallation(t, { version = '0.4.0', reportAvailable = true, rejectAdmission = false,
  nativeFailure = false, disposalFailure = false } = {}) {
  const directory = temporary(t), transport = mockHttp(t);
  const priorEnvironment = process.env;
  process.env = { DSH_HOME: join(directory, 'dsh-home'), HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home') };
  t.after(() => { process.env = priorEnvironment; });
  const profile = join(directory, 'dsh-home', 'profiles', 'candidate');
  const installedProductDir = join(profile, 'node_modules', 'dsh-grok-search'), hostRoot = join(directory, 'host');
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  write(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-grok-search': 'file:synthetic.tgz' } }));
  write(join(installedProductDir, 'package.json'), JSON.stringify({ name: 'dsh-grok-search', version }));
  if (reportAvailable) write(join(installedProductDir, 'src/core/runtime-compat.mjs'), '// Synthetic presence marker.\n');
  const host = join(hostRoot, 'node_modules/@deepseek-ai');
  write(join(host, 'dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3', type: 'module' }));
  write(join(host, 'dsh-app-boot/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', type: 'module' }));
  write(join(host, 'dsh-tool-executor-native/package.json'), '{}');
  const handle = '__DSH_SMOKE_UNIT_' + randomUUID();
  write(join(host, 'dsh-app-boot/lib/index.js'), 'export const loadLayeredEnv = () => ({});\n');
  write(join(host, 'dsh/lib/profile-boot.js'), `export const runProfile = options => globalThis[${JSON.stringify(handle)}](options);\n`);
  const state = { searches: 0, native: 0, stopped: false, disposedTools: 0 };
  const core = { snapshot: () => ({
    ...idle(), stopping: state.stopped, routeExecutor: { ...idle(), stopping: state.stopped },
    session: { connected: false, active: false },
  }) };
  const web = {
    searchProviderId: 'grok-search', fetchProviderId: 'candidate-fetch', searchProviders: new Map([['grok-search', {}]]),
    async search(request, signal) {
      state.searches++;
      const result = await transport.server.dispatch(request.query, signal);
      return { sources: result.results, truncated: false };
    },
  };
  const services = {
    loader: { entries: () => [{ options: { id: 'grok-search', name: 'dsh-grok-search' }, fiber: { uid: 1, state: 2 } }] },
    grokSearchCore: core, web, grokSearchBudgets: { snapshot: () => ({ owned: 1, budgetMs: 30_000 }) },
    ...(reportAvailable ? { grokSearchCompatibility: { report: () => ({
      hostVersion: '0.2.2-rc.3', pluginVersion: version, minimumAdmitted: true, coreReady: !state.stopped,
      phase: state.stopped ? 'stopped' : 'degraded', verification: 'unverified',
    }) } } : {}),
    tools: {
      async resolve() { return { dispose() { state.disposedTools++; } }; },
      async execute(input) {
        state.native++;
        assert.equal(input.agent.session.requestContext?.()?.provider, 'compatibility-smoke');
        const queries = JSON.parse(input.calls[0].arguments).queries, sources = [];
        for (const query of queries) sources.push(...(await web.search({ query }, input.signal)).sources);
        return { results: [{ result: { isError: nativeFailure, sources,
          ...(nativeFailure ? { error: { message: 'Synthetic error /private/config with a secret',
            info: { code: 'TOOL_OUTPUT_INVALID' } } } : {}) } }] };
      },
    },
  };
  globalThis[handle] = async options => {
    assert.equal(options.profile, 'candidate');
    if (rejectAdmission) throw Object.assign(new Error('Synthetic 0.3.0 admission rejected /private/config'),
      { code: 'DSH_ENGINE_UNSUPPORTED' });
    return { ctx: { get: name => services[name] }, shutdown: { async shutdown() {
      state.stopped = true;
      web.searchProviders.delete('grok-search');
      if (!disposalFailure) globalThis.__DSH_COMPATIBILITY_SMOKE__.disposed++;
    } } };
  };
  t.after(() => { delete globalThis[handle]; });
  return { directory, hostRoot, installedProductDir, state, transport };
}

test('synthetic new-host receipt requires every execution gate and completed cleanup', async t => {
  const fixture = mockInstallation(t);
  const result = await runCompatibilityHostProbe(fixture);
  assert.equal(COMPATIBILITY_SMOKE_MARKER, 'DSH_COMPATIBILITY_SMOKE=');
  assert.equal(result.passed, true);
  assert.deepEqual(result.gates, gateNames.map(id => ({ id, passed: true })));
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.realCredentialsUsed, false);
  assert.equal(result.originalProviderSynthetic, true);
  assert.equal(result.officialSearchCalls, 0);
  assert.equal(result.hostVersion, '0.2.2-rc.3');
  assert.equal(result.pluginVersion, '0.4.0');
  assert.equal(result.observations.initial.compatibility.verification, 'unverified');
  assert.equal(result.observations.cancellation.callerReasonPreserved, true);
  assert.equal(result.observations.cancellation.recovered, true);
  assert.equal(fixture.state.searches, 5);
  assert.equal(fixture.state.native, 1);
  assert.equal(fixture.state.disposedTools, 1);
  assert.equal(fixture.transport.server.closed, true);
});

test('synthetic 0.3.0 may pass actual execution gates without a fabricated compatibility API', async t => {
  const fixture = mockInstallation(t, { version: '0.3.0', reportAvailable: false });
  const result = await runCompatibilityHostProbe(fixture);
  assert.equal(result.passed, true);
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.pluginVersion, '0.3.0');
  assert.equal(result.observations.initial.compatibility, null);
  assert.deepEqual(result.observations.capabilities, {
    reportAvailable: false, evidence: 'execution-only-no-coordinator-report',
  });
  assert.deepEqual(result.gates, gateNames.map(id => ({ id, passed: true })));
  assert.equal(fixture.state.searches, 5);
});

test('synthetic 0.3.0 rejection is a failed package admission, not a missing-report bypass or passing smoke', async t => {
  const fixture = mockInstallation(t, { version: '0.3.0', reportAvailable: false, rejectAdmission: true });
  const result = await runCompatibilityHostProbe(fixture);
  assert.equal(result.passed, false);
  assert.equal(result.pluginVersion, '0.3.0');
  assert.equal(result.code, 'DSH_ENGINE_UNSUPPORTED');
  assert.equal(result.cleanupVerified, false);
  assert.deepEqual(result.gates, gateNames.map(id => ({ id, passed: false })));
  assert.equal(fixture.state.searches, 0);
  assert.equal(fixture.state.native, 0);
  assert.equal(fixture.transport.server.closed, true);
  assert.doesNotMatch(JSON.stringify(result), /private|config|missing-report/);
});

test('legacy readiness alone cannot pass capabilities when the native tool fails', async t => {
  const fixture = mockInstallation(t, { version: '0.3.0', reportAvailable: false, nativeFailure: true });
  const result = await runCompatibilityHostProbe(fixture);
  assert.equal(result.passed, false);
  assert.equal(result.code, 'COMPATIBILITY_SMOKE_SEARCH_FAILED');
  assert.equal(result.gates.find(gate => gate.id === 'package-admission').passed, true);
  assert.equal(result.gates.find(gate => gate.id === 'capabilities').passed, false);
  assert.equal(result.gates.find(gate => gate.id === 'search-no-official-fallback').passed, false);
  assert.equal(result.gates.find(gate => gate.id === 'cancellation').passed, false);
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.observations.directSearch.sourceMatched, true);
  assert.equal(result.observations.nativeTool.isError, true);
  assert.equal(result.observations.nativeTool.errorCode, 'TOOL_OUTPUT_INVALID');
  assert.deepEqual(result.observations.searchRoute, { requests: 3, officialSearchCalls: 0, unexpectedRequests: 0 });
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
});

test('passing query gates without fixture disposal never produce a passing receipt', async t => {
  const fixture = mockInstallation(t, { disposalFailure: true });
  const result = await runCompatibilityHostProbe(fixture);
  assert.equal(result.gates.every(gate => gate.passed), true);
  assert.equal(result.passed, false);
  assert.equal(result.cleanupVerified, false);
  assert.equal(result.code, 'COMPATIBILITY_SMOKE_CLEANUP_FAILED');
});

test('invalid entry arguments and caller cancellation fail closed before host preparation', async () => {
  const invalid = await runCompatibilityHostProbe({ hostRoot: 'relative-host' });
  assert.equal(invalid.passed, false);
  assert.equal(invalid.cleanupVerified, false);
  assert.equal(invalid.code, 'COMPATIBILITY_SMOKE_HOST_INVALID');
  assert.deepEqual(invalid.gates, gateNames.map(id => ({ id, passed: false })));
  const controller = new AbortController();
  controller.abort(new Error('Bearer private-value'));
  const cancelled = await runCompatibilityHostProbe({ signal: controller.signal });
  assert.equal(cancelled.code, 'COMPATIBILITY_SMOKE_FAILED');
  assert.equal(cancelled.passed, false);
  assert.doesNotMatch(JSON.stringify(cancelled), /private|Bearer/);
});

// Host-transition unit fixtures never execute an official host or certify a transition.
const transitionScope = 'same-plugin-official-host-transition-node-contract';
const transitionBundles = ['compatibility-transition-fixture', 'dsh-grok-search'];
const transitionRun = '4a895da4-b3a6-4db5-8b18-133a77f3f1b6';
const transitionVersion = '0.4.0';
const transitionOwner = '15f8548a-109b-4a10-97ab-e9f364495b65';
const transitionConfiguration = () => Object.fromEntries([
  'package.json', 'cordis.patch.yml', 'grok-search/compatibility-smoke.toml',
  'grok-search/preferences.json', 'grok-search/compatibility-state.json',
].map(name => [name, sha256(name)]));

function transitionIntent(selectionSha256 = sha256('package.json')) {
  return {
    schemaVersion: 1, policy: 'required', reason: 'product-current-selection', release: null,
    acquiredSelection: transitionBundles,
    acquisition: {
      source: 'current-selected-search-bundle', searchBundle: 'dsh-grok-search',
      selectedBundles: transitionBundles, selectionSha256, observedAt: '2026-11-14T12:00:00.000Z',
      authorSearchProvider: 'candidate-original', authorSearchProviderPresent: true, authorFetchProvider: 'candidate-fetch',
      authorInjectSha256: 'e'.repeat(64), historicReleaseCommitted: false, userClickObserved: false,
    },
    lease: { pid: process.pid, uid: 1, entryId: 'web', moduleName: '@deepseek-ai/dsh-web',
      provider: 'grok-search', hostId: transitionOwner },
  };
}

function transitionState(revision = 0) {
  const state = { configuration: transitionConfiguration(), control: null };
  if (revision) {
    const intent = controlIntentProjection({ format: 'dsh-grok-search/control-intent', schemaVersion: 1,
      revision, intent: transitionIntent() });
    state.control = { revision, sha256: sha256('revision-' + revision), intent,
      history: Array.from({ length: revision }, (_, index) => ({ revision: index + 1, sha256: sha256('revision-' + (index + 1)) })) };
  }
  return state;
}

function transitionExpectation(overrides = {}) {
  return { runId: transitionRun, index: 0, hostVersion: '0.2.1-rc.2', pluginVersion: transitionVersion, modern: false, ...overrides };
}

function transitionExecution(expected = transitionExpectation(), before = transitionState(), after = transitionState(1)) {
  const ready = {
    core: { ...idle(), routeExecutor: idle(), childStarted: false, sessionConnected: false, sessionActive: false },
    compatibility: { coreReady: true, phase: 'ready', hostVersion: expected.hostVersion, pluginVersion: expected.pluginVersion,
      minimumAdmitted: true, code: null },
    runtimeWeb: { searchProviderId: 'grok-search', fetchProviderId: 'candidate-fetch' },
    budgets: { owned: 1 }, officialSearchCalls: 0,
  };
  const result = { schemaVersion: 1, scope: transitionScope, ...expected, passed: true, code: null,
    realCredentialsUsed: false, originalProviderSynthetic: true, officialSearchCalls: 0, cleanupVerified: true,
    before, after, observations: { directSearch: true, nativeQueries: 2, modern: expected.modern, ready } };
  return { code: 0, signal: null, failure: null, stderr: '', stdout: HOST_TRANSITION_MARKER + JSON.stringify(result) + '\n' };
}

function transitionHosts() {
  const common = { lane: 'synthetic-unit', platform: process.platform, arch: process.arch };
  return [{ asset: { ...common, version: '0.2.1-rc.2' }, modern: false },
    { asset: { ...common, version: '0.2.2-rc.3' }, modern: true }];
}

test('host transition CLI requires exact hashes, both explicit hosts, and a new output path; no install mode', t => {
  const root = temporary(t), hash = 'a'.repeat(64);
  const args = ['--package', join(root, 'fixed.tgz'), '--package-sha256', hash,
    '--dependencies-root', join(root, 'node_modules'), '--output-root', join(root, 'new-run'),
    '--from-receipt', join(root, 'a.json'), '--from-receipt-sha256', hash, '--from-root', join(root, 'a'),
    '--to-receipt', join(root, 'b.json'), '--to-receipt-sha256', hash, '--to-root', join(root, 'b')];
  const parsed = parseHostTransitionArgs(args);
  assert.equal(parsed.packageSha256, hash);
  assert.equal(parsed.outputRoot, join(root, 'new-run'));
  for (const invalid of [args.slice(0, -2), [...args, '--package', join(root, 'other.tgz')],
    [...args, '--install', 'true'], [...args, '--profile', join(root, 'existing')]]) {
    assert.throws(() => parseHostTransitionArgs(invalid), /HOST_TRANSITION_ARGUMENT/);
  }
  assert.throws(() => parseHostTransitionArgs(args.map(value => value === hash ? 'unverified' : value)),
    { code: 'COMPATIBILITY_HASH_REQUIRED' });
  assert.throws(() => parseHostTransitionArgs(args.map(value => value === join(root, 'new-run') ? 'relative' : value)),
    { code: 'HOST_TRANSITION_PATH_UNSAFE' });
});

test('host transition selection is generic but rejects equal versions and cross-platform evidence', () => {
  const [from, to] = transitionHosts();
  assert.deepEqual(validateHostTransitionPair(from.asset, to.asset), ['0.2.1-rc.2', '0.2.2-rc.3', '0.2.1-rc.2']);
  assert.deepEqual(validateHostTransitionPair(from.asset, { ...to.asset, version: '0.2.3-rc.7' }),
    ['0.2.1-rc.2', '0.2.3-rc.7', '0.2.1-rc.2']);
  assert.throws(() => validateHostTransitionPair(from.asset, from.asset), { code: 'HOST_TRANSITION_DISTINCT_HOSTS_REQUIRED' });
  assert.throws(() => validateHostTransitionPair(from.asset, { ...to.asset, platform: 'different' }),
    { code: 'HOST_TRANSITION_PLATFORM_MISMATCH' });
});

test('host transition refuses any pre-existing output/profile before touching it', async t => {
  const root = temporary(t), sentinel = join(root, 'not-a-fixture.txt');
  writeFileSync(sentinel, 'retained');
  await assert.rejects(runCompatibilityHostTransitions({ outputRoot: root }),
    { code: 'HOST_TRANSITION_OUTPUT_EXISTS' });
  assert.equal(readFileSync(sentinel, 'utf8'), 'retained');
});

function preparationFixture(t, { requirements = { 'synthetic-dependency': '1.0.0' } } = {}) {
  const directory = temporary(t), dependenciesRoot = join(directory, 'source/node_modules'), output = join(directory, 'new-run');
  mkdirSync(dependenciesRoot, { recursive: true }); mkdirSync(output);
  const dependency = (name, manifest) => {
    const path = join(dependenciesRoot, name); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(path, 'index.js'), '// Never executed in this fixture.\n');
    return path;
  };
  const inspected = { manifest: { name: 'dsh-grok-search', version: transitionVersion, dependencies: requirements },
    files: new Map() };
  inspected.files.set('package.json', Buffer.from(JSON.stringify(inspected.manifest)));
  inspected.files.set('src/entry.mjs', Buffer.from('export const synthetic = true;\n'));
  return { directory, dependenciesRoot, output, dependency, options: {
    directory: output, inspected, dependenciesRoot, endpoint: 'http://127.0.0.1:19999',
    versions: ['0.2.1-rc.2', '0.2.2-rc.3', '0.2.1-rc.2'],
  } };
}

test('transition preparation copies only the transitive runtime closure and seeds valid unconfirmed state', t => {
  const fixture = preparationFixture(t);
  fixture.dependency('synthetic-dependency', { name: 'synthetic-dependency', version: '1.0.0',
    dependencies: { 'synthetic-child': '^2.0.0' }, optionalDependencies: { 'synthetic-absent': '^1.0.0' } });
  fixture.dependency('synthetic-child', { name: 'synthetic-child', version: '2.1.0' });
  fixture.dependency('@deepseek-ai/cordis', { name: '@deepseek-ai/cordis', version: '1.0.0' });
  fixture.dependency('unused-private', { name: 'unused-private', version: '1.0.0' });
  const prepared = prepareHostTransitionProfile(fixture.options);
  assert.deepEqual(prepared.dependencies.packages, { 'synthetic-dependency': '1.0.0', 'synthetic-child': '2.1.0' });
  assert.equal(existsSync(join(prepared.profile, 'node_modules/@deepseek-ai')), false);
  assert.equal(existsSync(join(prepared.profile, 'node_modules/unused-private')), false);
  for (const [name, bytes] of fixture.options.inspected.files) {
    assert.deepEqual(readFileSync(join(prepared.product, name)), bytes);
  }
  const before = readFileSync(join(prepared.profile, 'grok-search/compatibility-state.json'));
  for (const hostVersion of fixture.options.versions.slice(0, 2)) {
    const state = createCompatibilityState({ profileDir: prepared.profile, hostVersion, pluginVersion: transitionVersion });
    assert.equal(state.snapshot().errorCode, null);
    assert.equal(state.snapshot().confirmed, false);
    assert.equal(state.snapshot().notified, true);
    state.dispose();
  }
  assert.deepEqual(readFileSync(join(prepared.profile, 'grok-search/compatibility-state.json')), before);
  assert.equal(readFileSync(join(prepared.profile, 'grok-search/preferences.json'), 'utf8').includes('"grokEnabled":false'), true);
});

test('transition preparation refuses an unresolved, wrong-version, or host-peer dependency instead of installing', t => {
  for (const kind of ['missing', 'mismatch', 'host-peer']) {
    const fixture = preparationFixture(t, { requirements: kind === 'host-peer' ? { '@deepseek-ai/cordis': '1.0.0' } : undefined });
    if (kind === 'mismatch') fixture.dependency('synthetic-dependency', { name: 'synthetic-dependency', version: '2.0.0' });
    assert.throws(() => prepareHostTransitionProfile(fixture.options), {
      code: kind === 'missing' ? 'HOST_TRANSITION_DEPENDENCY_MISSING'
        : kind === 'mismatch' ? 'HOST_TRANSITION_DEPENDENCY_VERSION' : 'HOST_TRANSITION_DEPENDENCY_UNSAFE',
    });
  }
});

test('transition dependency copy never follows a linked package directory outside its declared source', t => {
  const fixture = preparationFixture(t), outside = join(fixture.directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'package.json'), '{"name":"synthetic-dependency","version":"1.0.0"}');
  symlinkSync(outside, join(fixture.dependenciesRoot, 'synthetic-dependency'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareHostTransitionProfile(fixture.options), { code: 'COMPATIBILITY_PATH_UNSAFE' });
  assert.equal(readFileSync(join(outside, 'package.json'), 'utf8'), '{"name":"synthetic-dependency","version":"1.0.0"}');
});

function syntheticAsar(files) {
  const table = { files: {} }, bodies = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(JSON.stringify(text)), parts = name.split('/');
    let directory = table.files;
    for (const part of parts.slice(0, -1)) directory = (directory[part] ??= { files: {} }).files;
    directory[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    bodies.push(bytes); offset += bytes.length;
  }
  const header = Buffer.from(JSON.stringify(table)), lead = Buffer.alloc(16);
  lead.writeUInt32LE(4, 0); lead.writeUInt32LE(8 + header.length, 4); lead.writeUInt32LE(header.length, 12);
  return Buffer.concat([lead, header, ...bodies]);
}

function transitionRuntime(t, { version = '0.2.2-rc.3', reportedVersion = version } = {}) {
  const root = temporary(t);
  const lane = process.platform === 'linux' ? 'linux-cli' : process.platform === 'darwin' ? 'macos-desktop' : 'windows-desktop';
  const spec = COMPATIBILITY_LANES[lane], files = {};
  const write = (name, bytes) => {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    return { path: name, sha256: sha256(bytes) };
  };
  if (lane === 'linux-cli') {
    files.executable = write('node_modules/@deepseek-ai/dsh/lib/bin.js', '// Unit fixture, not executable host evidence.\n');
    files.cliManifest = write('node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({
      name: '@deepseek-ai/dsh', version: reportedVersion, engines: { node: '*' },
    }));
  } else {
    const binary = Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 6]), Buffer.from('100100')]);
    const mac = lane === 'macos-desktop';
    files.executable = write(mac ? 'DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' : 'DeepSeek Harness.exe', binary);
    files.fuseBinary = mac
      ? write('DeepSeek Harness.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', binary)
      : { ...files.executable };
    files.archive = write(mac ? 'DeepSeek Harness.app/Contents/Resources/app.asar' : 'resources/app.asar', syntheticAsar({
      'package.json': { name: '@deepseek-ai/dsh-desktop', version: reportedVersion },
      'dsh/package.json': { version: reportedVersion },
      'dsh/desktop-runtime.json': { release: { version: reportedVersion }, platform: spec.platform, arch: spec.arch },
      'dsh/node_modules/@deepseek-ai/dsh/package.json': { name: '@deepseek-ai/dsh', version: reportedVersion },
      'dsh/node_modules/@deepseek-ai/dsh-tool-executor-native/package.json': {},
    }));
  }
  const receipt = {
    schemaVersion: 1, kind: 'verified-runtime-candidate', files,
    asset: { schemaVersion: 1, kind: 'official-host-candidate', lane, ...spec, version,
      ...(lane === 'linux-cli' ? { name: '@deepseek-ai/dsh', nodeRange: '*' } : {}),
      integrity: 'sha512-' + createHash('sha512').update('unit-asset').digest('base64'), sha256: sha256('unit-asset'),
      source: { kind: lane === 'linux-cli' ? 'npm-registry' : 'official-update', metadataSha256: sha256('unit-metadata'),
        metadataUrl: officialMetadataUrl(lane), url: lane === 'linux-cli'
          ? `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`
          : `https://download.deepseek.com/dsh-desk/bin/${spec.feedDirectory}/deepseek-harness-${version}-${lane === 'macos-desktop' ? 'mac-arm64.zip' : 'win-x64.exe'}` },
    },
  };
  const receiptPath = join(root, 'unit-runtime.json');
  const publish = () => { writeFileSync(receiptPath, JSON.stringify(receipt)); return sha256(readFileSync(receiptPath)); };
  return { root, receiptPath, receiptSha256: publish(), receipt, publish };
}

test('transition runtime preflight verifies role hashes, actual manifest version, and receipt identity without running it', t => {
  if (process.platform === 'darwin' && process.arch !== 'arm64') return t.skip('Official macOS lane is arm64.');
  const fixture = transitionRuntime(t);
  const actual = readHostTransitionRuntime(fixture);
  assert.equal(actual.asset.version, '0.2.2-rc.3');
  assert.equal(actual.receiptSha256, fixture.receiptSha256);
  assert.throws(() => readHostTransitionRuntime({ ...fixture, receiptSha256: '0'.repeat(64) }), /./);
  writeFileSync(join(fixture.root, fixture.receipt.files.executable.path), 'changed');
  assert.throws(() => readHostTransitionRuntime(fixture), /./);
});

test('transition preflight cannot pass a receipt for a different on-disk host or absent mandatory role', t => {
  if (process.platform === 'darwin' && process.arch !== 'arm64') return t.skip('Official macOS lane is arm64.');
  const mismatch = transitionRuntime(t, { reportedVersion: '0.2.2-rc.2' });
  assert.throws(() => readHostTransitionRuntime(mismatch), /HOST_TRANSITION_RUNTIME_(?:IDENTITY|LAYOUT)/);
  const missing = transitionRuntime(t);
  delete missing.receipt.files.executable;
  missing.receiptSha256 = missing.publish();
  assert.throws(() => readHostTransitionRuntime(missing), { code: 'COMPATIBILITY_RECEIPT_INVALID' });
});

function historicalTransitionRuntime(t) {
  const fixture = transitionRuntime(t, { version: '0.2.2-rc.2' });
  const { root, receipt: previous } = fixture, version = '0.2.2-rc.2';
  const url = `https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-${version}-win-x64.exe`;
  const write = (name, bytes) => {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    return { path: name, sha256: sha256(bytes) };
  };
  const installer = write('historical-installer.exe', 'Synthetic installer, never signature verified.');
  const toolSha256 = 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95';
  const tool = write('verification-tools/7za.exe', 'Synthetic extraction tool, never executed.');
  const validation = { status: 'Valid', signerSubject: 'CN=Hangzhou DeepSeek Artificial Intelligence Co., Ltd.',
    certificateThumbprint: '84032578657219876E273E0D1BD303CFE1B82E6F',
    timestampThumbprint: '51D9ABDA034973D84F4266ACA48248E6B369C439' };
  const identity = { schemaVersion: 1, installerSha256: installer.sha256, url, version,
    platform: 'win32', arch: 'x64', observedAt: '2026-11-14T15:20:00.000Z' };
  const signature = { ...identity, kind: 'windows-authenticode-validation', validation,
    verifier: { kind: 'parent-local-GetAuthenticodeSignature' } };
  const extracted = Object.fromEntries(Object.entries(previous.files).map(([role, row]) => {
    const name = role === 'archive' ? 'new-owned-extraction/resources/app.asar' : 'new-owned-extraction/DeepSeek Harness.exe';
    if (!existsSync(join(root, name))) write(name, readFileSync(join(root, row.path)));
    return [role, { path: name, sha256: row.sha256 }];
  }));
  const extraction = { ...identity, kind: 'same-installer-runtime-extraction',
    method: { executable: tool.path, sha256: toolSha256, exitCode: 0,
      argv: ['x', '-y', '-onew-owned-extraction', '--', installer.path, 'DeepSeek Harness.exe', 'resources/app.asar'] }, files: extracted };
  const signatureReceipt = write('current-evidence/signature.json', JSON.stringify(signature));
  const extractionReceipt = write('current-evidence/extraction.json', JSON.stringify(extraction));
  fixture.receipt = { schemaVersion: 1, kind: 'reviewed-historical-runtime',
    host: { version, platform: 'win32', arch: 'x64' },
    source: { url, metadataStatus: 'unavailable', metadataReason: 'The original feed snapshot was not retained.' },
    installer, files: previous.files, signatureReceipt, extractionReceipt };
  fixture.publish = () => { writeFileSync(fixture.receiptPath, JSON.stringify(fixture.receipt)); return sha256(readFileSync(fixture.receiptPath)); };
  fixture.receiptSha256 = fixture.publish();
  const repin = () => {
    writeFileSync(join(root, signatureReceipt.path), JSON.stringify(signature));
    writeFileSync(join(root, extractionReceipt.path), JSON.stringify(extraction));
    fixture.receipt.signatureReceipt.sha256 = sha256(readFileSync(join(root, signatureReceipt.path)));
    fixture.receipt.extractionReceipt.sha256 = sha256(readFileSync(join(root, extractionReceipt.path)));
    fixture.receiptSha256 = fixture.publish();
  };
  const calls = [];
  const dependencies = { signatureReader(path) { calls.push(path); return structuredClone(validation); },
    extractionToolFingerprint(path) { assert.equal(path, join(root, tool.path)); return toolSha256; } };
  return { ...fixture, signature, extraction, validation, repin, dependencies, calls };
}

test('historical transition provenance stays distinct, pinned and unverified by synthetic signature stand-ins', t => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip('Historical provenance is Windows-only.');
  const fixture = historicalTransitionRuntime(t);
  const result = readHostTransitionRuntime(fixture, fixture.dependencies);
  assert.equal(result.asset.kind, 'reviewed-historical-host');
  assert.equal(result.asset.version, '0.2.2-rc.2');
  assert.equal(result.asset.source.metadataStatus, 'unavailable');
  assert.equal(result.provenance.officialFeedVerified, false);
  assert.equal(result.provenance.signatureValidation, 'synthetic-unit-not-signature-proof');
  assert.equal(result.provenance.signature.certificateThumbprint, fixture.validation.certificateThumbprint);
  assert.equal(result.provenance.extractionReceiptSha256, fixture.receipt.extractionReceipt.sha256);
  assert.equal(fixture.calls.length, 1);
  assert.equal(result.asset.source.metadataSha256, undefined);
});

test('historical provenance requires actual signature-check agreement rather than a Valid JSON claim', t => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip('Historical provenance is Windows-only.');
  for (const current of [
    { status: 'NotSigned' },
    { status: 'Valid', signerSubject: 'unrelated signer', certificateThumbprint: 'a'.repeat(40) },
    { status: 'Valid', signerSubject: 'CN=Hangzhou DeepSeek Artificial Intelligence Co., Ltd.',
      certificateThumbprint: 'a'.repeat(40) },
  ]) {
    const fixture = historicalTransitionRuntime(t);
    assert.throws(() => readHostTransitionRuntime(fixture, { ...fixture.dependencies, signatureReader: () => current }),
      /HOST_TRANSITION_SIGNATURE_/);
  }
});

test('historical receipt rejects forged feed, unknown hosts, wrong URL and missing signature receipt identity', t => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip('Historical provenance is Windows-only.');
  for (const mutate of [
    value => { value.receipt.kind = 'official-host-candidate'; },
    value => { value.receipt.host.version = '0.2.2-rc.3'; },
    value => { value.receipt.host.platform = 'linux'; },
    value => { value.receipt.source.metadataSha256 = 'a'.repeat(64); },
    value => { value.receipt.source.metadataStatus = 'verified'; },
    value => { value.receipt.source.url = 'https://example.test/historical.exe'; },
    value => { value.receipt.signatureReceipt.sha256 = '0'.repeat(64); },
    value => { value.signature.installerSha256 = '0'.repeat(64); value.repin(); },
  ]) {
    const fixture = historicalTransitionRuntime(t); mutate(fixture);
    fixture.receiptSha256 = fixture.publish();
    assert.throws(() => readHostTransitionRuntime(fixture, fixture.dependencies), /./);
  }
});

test('historical extraction requires the same installer, a pinned tool and distinct matching re-extracted bytes', t => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip('Historical provenance is Windows-only.');
  for (const mutate of [
    value => { value.extraction.installerSha256 = '0'.repeat(64); value.repin(); },
    value => { value.extraction.method.exitCode = 1; value.repin(); },
    value => { value.extraction.method.argv[4] = 'other-installer.exe'; value.repin(); },
    value => { value.extraction.method.sha256 = '0'.repeat(64); value.repin(); },
    value => { value.extraction.files.archive = { ...value.receipt.files.archive }; value.repin(); },
    value => { value.extraction.files.archive.sha256 = '0'.repeat(64); value.repin(); },
    value => { writeFileSync(join(value.root, value.extraction.files.archive.path), 'mismatch'); },
    value => { writeFileSync(join(value.root, value.receipt.installer.path), 'changed installer'); },
  ]) {
    const fixture = historicalTransitionRuntime(t); mutate(fixture);
    fixture.receiptSha256 = fixture.publish();
    assert.throws(() => readHostTransitionRuntime(fixture, fixture.dependencies), /HOST_TRANSITION_/);
  }
  const fixture = historicalTransitionRuntime(t);
  assert.throws(() => readHostTransitionRuntime(fixture, {
    ...fixture.dependencies, extractionToolFingerprint: () => '0'.repeat(64),
  }), { code: 'HOST_TRANSITION_EXTRACTION_TOOL_CHANGED' });
});

test('historical provenance path escapes fail before the signature reader can observe an outside input', t => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip('Historical provenance is Windows-only.');
  for (const field of ['installer', 'signatureReceipt', 'extractionReceipt']) {
    const fixture = historicalTransitionRuntime(t);
    fixture.receipt[field].path = '../outside.json'; fixture.receiptSha256 = fixture.publish();
    assert.throws(() => readHostTransitionRuntime(fixture, fixture.dependencies), { code: 'COMPATIBILITY_PATH_UNSAFE' });
    assert.equal(fixture.calls.length, 0);
  }
});

test('transition retention allows new ownership revisions, not config changes, rewinds, or discarded history', () => {
  assert.doesNotThrow(() => assertTransitionRetention(transitionState(), transitionState(1)));
  assert.doesNotThrow(() => assertTransitionRetention(transitionState(1), transitionState(2)));
  const changed = transitionState(2);
  changed.configuration['grok-search/preferences.json'] = 'b'.repeat(64);
  assert.throws(() => assertTransitionRetention(transitionState(1), changed), { code: 'HOST_TRANSITION_CONFIGURATION_CHANGED' });
  assert.throws(() => assertTransitionRetention(transitionState(2), transitionState(1)), { code: 'HOST_TRANSITION_CONTROL_REWOUND' });
  const erased = transitionState(2); erased.control.history[0].sha256 = 'b'.repeat(64);
  assert.throws(() => assertTransitionRetention(transitionState(1), erased), { code: 'HOST_TRANSITION_HISTORY_CHANGED' });
  const changedIntent = transitionState(2); changedIntent.control.intent.authorFetchProvider = 'other-fetch';
  assert.throws(() => assertTransitionRetention(transitionState(1), changedIntent), { code: 'HOST_TRANSITION_CONTROL_CHANGED' });
  assert.throws(() => assertTransitionRetention(transitionState(), transitionState()), { code: 'HOST_TRANSITION_CONTROL_MISSING' });
});

test('transition control projection forbids fabricated release, author fallback, consent and selection changes', () => {
  const envelope = { format: 'dsh-grok-search/control-intent', schemaVersion: 1, revision: 1, intent: transitionIntent() };
  assert.equal(controlIntentProjection(envelope).policy, 'required');
  for (const mutate of [
    value => { value.intent.policy = 'released'; },
    value => { value.intent.release = { explicit: true }; },
    value => { value.intent.acquisition.userClickObserved = true; },
    value => { value.intent.acquisition.authorSearchProvider = 'grok-search'; },
    value => { value.intent.pause = { confirmed: true }; },
    value => { value.intent.acquiredSelection = ['another-bundle']; },
  ]) {
    const value = structuredClone(envelope); mutate(value);
    assert.throws(() => controlIntentProjection(value), /HOST_TRANSITION_CONTROL/);
  }
});

test('transition execution rejects abnormal exits, duplicate receipts, wrong versions and original-provider calls', () => {
  const expected = transitionExpectation(), before = transitionState(), after = transitionState(1);
  assert.equal(validateHostTransitionExecution(transitionExecution(), expected, before, after).passed, true);
  for (const mutate of [
    value => { value.code = 1; },
    value => { value.signal = 'SIGTERM'; },
    value => { value.failure = 'COMPATIBILITY_SMOKE_PIPE_TIMEOUT'; },
    value => { value.stdout += value.stdout; },
    value => { value.stdout = HOST_TRANSITION_MARKER + '{'; },
  ]) {
    const value = transitionExecution(); mutate(value);
    assert.throws(() => validateHostTransitionExecution(value, expected, before, after), /HOST_TRANSITION_/);
  }
  for (const mutate of [
    value => { value.hostVersion = '0.2.2-rc.9'; },
    value => { value.pluginVersion = '0.3.0'; },
    value => { value.officialSearchCalls = 1; },
    value => { value.cleanupVerified = false; },
    value => { value.observations.ready.runtimeWeb.fetchProviderId = 'different'; },
    value => { value.observations.ready.core.childStarted = true; },
    value => { value.after.configuration['cordis.patch.yml'] = 'b'.repeat(64); },
  ]) {
    const value = transitionExecution(), result = JSON.parse(value.stdout.slice(HOST_TRANSITION_MARKER.length));
    mutate(result); value.stdout = HOST_TRANSITION_MARKER + JSON.stringify(result);
    assert.throws(() => validateHostTransitionExecution(value, expected, before, after), /HOST_TRANSITION_/);
  }
});

test('synthetic transition sequence runs A-B-A against one evolving state without claiming real-host acceptance', async () => {
  const calls = [], records = [];
  let current = transitionState();
  const result = await runHostTransitionSequence({
    hosts: transitionHosts(), runId: transitionRun, pluginVersion: transitionVersion,
    snapshot: async () => structuredClone(current),
    async execute(host, expected) {
      calls.push(host.asset.version);
      const before = structuredClone(current); current = transitionState(expected.index + 1);
      return transitionExecution(expected, before, structuredClone(current));
    },
    record(index, value) { records.push({ index, value }); },
  });
  assert.deepEqual(calls, ['0.2.1-rc.2', '0.2.2-rc.3', '0.2.1-rc.2']);
  assert.deepEqual(result.rows.map(row => row.direction), ['baseline', 'upgrade', 'downgrade']);
  assert.ok(records.every(row => row.value.validation.passed));
  assert.equal(result.realHostValidated, false);
  assert.equal(result.scope, 'synthetic-unit-host-transition-sequence');
});

test('a failed middle host keeps the passing baseline and records a boundary, never runs or passes the return', async () => {
  const calls = [], records = [];
  let current = transitionState();
  await assert.rejects(runHostTransitionSequence({
    hosts: transitionHosts(), runId: transitionRun, pluginVersion: transitionVersion,
    snapshot: async () => structuredClone(current),
    async execute(host, expected) {
      calls.push(host.asset.version);
      const before = structuredClone(current); current = transitionState(expected.index + 1);
      const value = transitionExecution(expected, before, structuredClone(current));
      if (expected.index === 1) value.code = 1;
      return value;
    },
    record(index, value) { records.push({ index, value }); },
  }), { code: 'HOST_TRANSITION_ABNORMAL_EXIT' });
  assert.equal(calls.length, 2);
  assert.equal(records[0].value.validation.passed, true);
  assert.equal(records[1].value.validation.passed, false);
  assert.equal(records[1].value.validation.code, 'HOST_TRANSITION_ABNORMAL_EXIT');
});

function transitionInstallation(t, { originalCalls = 0, corruptControl = false, mutatePreferences = false,
  cleanupFailure = false, reportCode = null } = {}) {
  const directory = temporary(t), home = join(directory, 'home'), profile = join(directory, 'dsh-home/profiles/candidate');
  const product = join(profile, 'node_modules/dsh-grok-search'), hostRoot = join(directory, 'host');
  const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  mkdirSync(home);
  const priorEnvironment = process.env;
  process.env = Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'].map(key => [key, home]));
  process.env.DSH_HOME = join(directory, 'dsh-home');
  t.after(() => { process.env = priorEnvironment; });
  const expected = transitionExpectation({ hostVersion: '0.2.2-rc.3', modern: true });
  const owner = { kind: 'isolated-host-transition-owner', runId: transitionRun, versions: [
    expected.hostVersion, '0.2.1-rc.2', expected.hostVersion,
  ], pluginVersion: transitionVersion };
  write(join(directory, 'transition-owner.json'), JSON.stringify(owner));
  const input = { ...expected, directory, hostRoot, ownerSha256: sha256(readFileSync(join(directory, 'transition-owner.json'))) };
  write(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: transitionBundles } } }));
  for (const name of Object.keys(transitionConfiguration()).slice(1)) write(join(profile, name), '{}\n');
  write(join(product, 'package.json'), JSON.stringify({ name: 'dsh-grok-search', version: transitionVersion }));
  const storeSource = new URL('../src/core/control-intent-store.mjs', import.meta.url).href;
  write(join(product, 'src/core/control-intent-store.mjs'), `export { createControlIntentStore } from ${JSON.stringify(storeSource)};\n`);
  const store = createControlIntentStore({ directory: join(profile, 'control-intent.records'),
    legacyPath: join(profile, 'control-intent.fixture.json'), trustedRoot: profile, autoMaintain: false });
  const selectionHash = sha256(readFileSync(join(profile, 'package.json')));
  const intent = transitionIntent(selectionHash);
  if (corruptControl) {
    store.compareAndSwap({ expectedRevision: 0, intent });
    const path = join(profile, 'control-intent.records/v000000000001.json'), record = JSON.parse(readFileSync(path));
    record.schemaVersion = 99; writeFileSync(path, JSON.stringify(record));
  }
  const host = join(hostRoot, 'node_modules/@deepseek-ai');
  write(join(host, 'dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: expected.hostVersion, type: 'module' }));
  write(join(host, 'dsh-tool-executor-native/package.json'), '{}');
  write(join(host, 'dsh-app-boot/package.json'), '{"type":"module"}');
  write(join(host, 'dsh-app-boot/lib/index.js'), 'export const loadLayeredEnv = () => ({});\n');
  const handle = '__DSH_TRANSITION_UNIT_' + randomUUID();
  write(join(host, 'dsh/lib/profile-boot.js'), `export const runProfile = options => globalThis[${JSON.stringify(handle)}](options);\n`);
  const state = { boots: 0, stopped: false, searches: [], disposedTools: 0 };
  const core = { snapshot: () => ({ ...idle(), stopping: state.stopped, routeExecutor: { ...idle(), stopping: state.stopped },
    session: { connected: false, active: false } }) };
  const web = { searchProviderId: 'grok-search', fetchProviderId: 'candidate-fetch', searchProviders: new Map([['grok-search', {}]]),
    async search({ query }) {
      state.searches.push(query);
      const suffix = query.split(`${transitionRun}-0-`)[1];
      return { sources: [{ url: `https://compatibility-transition.invalid/${transitionRun}/0/${suffix}` }], truncated: false };
    } };
  const services = {
    profileContext: { dir: profile },
    loader: { entries: () => [{ options: { id: 'grok-search', name: 'dsh-grok-search' },
      fiber: { uid: 5, ctx: { fiber: { uid: 6, state: 2 } } } }] },
    grokSearchCore: core, web, grokSearchBudgets: { snapshot: () => ({ owned: 1 }) },
    grokSearchCompatibility: { report: () => ({ hostVersion: expected.hostVersion, pluginVersion: transitionVersion,
      coreReady: !state.stopped, minimumAdmitted: true, phase: state.stopped ? 'stopped' : reportCode ? 'degraded' : 'ready',
      confirmed: false, notified: true, code: reportCode }) },
    grokSearchControl: { snapshot: () => ({ recordEnvelope: store.read() }) },
    tools: {
      async resolve() { return { async dispose() { state.disposedTools++; } }; },
      async execute({ calls }) {
        const queries = JSON.parse(calls[0].arguments).queries;
        return { results: [{ result: { isError: false, sources: (await Promise.all(queries.map(query => web.search({ query }))))
          .flatMap(value => value.sources) } }] };
      },
    },
  };
  globalThis[handle] = async options => {
    state.boots++; assert.equal(options.profile, 'candidate');
    const current = store.read();
    store.compareAndSwap({ expectedRevision: current?.revision ?? 0, intent });
    globalThis.__DSH_HOST_TRANSITION__.calls.original = originalCalls;
    return { ctx: { get: name => services[name] }, shutdown: { async shutdown(code) {
      assert.equal(code, 0); state.stopped = true; web.searchProviders.delete('grok-search');
      if (!cleanupFailure) globalThis.__DSH_HOST_TRANSITION__.disposed++;
      if (mutatePreferences) writeFileSync(join(profile, 'grok-search/preferences.json'), '{"modified":true}');
    } } };
  };
  t.after(() => { delete globalThis[handle]; });
  return { input, state, profile, product, store, intent };
}

test('synthetic worker exercises shaped host entry, native queries, real control codec and awaited cleanup', async t => {
  const fixture = transitionInstallation(t, { reportCode: 'COMPATIBILITY_OPTIONAL_UNAVAILABLE' });
  const result = await runHostTransitionWorker(fixture.input);
  assert.equal(result.code, null);
  assert.equal(result.passed, true);
  assert.equal(result.hostVersion, '0.2.2-rc.3');
  assert.equal(result.before.control, null);
  assert.equal(result.after.control.revision, 1);
  assert.equal(result.officialSearchCalls, 0);
  assert.equal(result.cleanupVerified, true);
  assert.equal(fixture.state.searches.length, 3);
  assert.equal(fixture.state.disposedTools, 1);
  assert.equal(fixture.state.stopped, true);
});

test('actual control reader retains immutable revisions across checkpoint maintenance', async t => {
  const fixture = transitionInstallation(t);
  const first = fixture.store.compareAndSwap({ expectedRevision: 0, intent: fixture.intent });
  const before = await readTransitionControl(fixture.profile, fixture.product);
  fixture.store.compareAndSwap({ expectedRevision: first.revision, intent: fixture.intent });
  fixture.store.maintain();
  const after = await readTransitionControl(fixture.profile, fixture.product);
  assert.equal(after.revision, 2);
  assert.deepEqual(after.history.slice(0, 1), before.history);
  assert.deepEqual(after.intent, before.intent);
});

test('unsupported retained control format is a failed boundary before host boot, never repaired or passed', async t => {
  const fixture = transitionInstallation(t, { corruptControl: true });
  const path = join(fixture.profile, 'control-intent.records/v000000000001.json'), previous = readFileSync(path);
  const result = await runHostTransitionWorker(fixture.input);
  assert.equal(result.passed, false);
  assert.equal(result.code, 'CONTROL_RECORD_VERSION_UNSUPPORTED');
  assert.equal(fixture.state.boots, 0);
  assert.deepEqual(readFileSync(path), previous);
});

test('worker rejects original-provider fallthrough and still shuts down its synthetic host', async t => {
  const fixture = transitionInstallation(t, { originalCalls: 1 });
  const result = await runHostTransitionWorker(fixture.input);
  assert.equal(result.passed, false);
  assert.equal(result.code, 'HOST_TRANSITION_SEARCH_FAILED');
  assert.equal(result.officialSearchCalls, 1);
  assert.equal(fixture.state.stopped, true);
});

test('worker fails changed preferences after normal shutdown instead of labeling retention successful', async t => {
  const fixture = transitionInstallation(t, { mutatePreferences: true });
  const result = await runHostTransitionWorker(fixture.input);
  assert.equal(result.passed, false);
  assert.equal(result.code, 'HOST_TRANSITION_CONFIGURATION_CHANGED');
  assert.equal(fixture.state.stopped, true);
});

test('worker cannot count absent disposal or incorrect runtime identity as a passing transition', async t => {
  const fixture = transitionInstallation(t, { cleanupFailure: true });
  const result = await runHostTransitionWorker(fixture.input);
  assert.equal(result.passed, false);
  assert.equal(result.cleanupVerified, false);
  assert.equal(result.code, 'HOST_TRANSITION_CLEANUP_FAILED');
  const before = fixture.state.boots;
  const wrong = await runHostTransitionWorker({ ...fixture.input, hostVersion: '0.2.2-rc.9' });
  assert.equal(wrong.passed, false);
  assert.equal(fixture.state.boots, before);
});

test('transition verifier fingerprint includes its entire static local implementation closure', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({ entryPoints: [join(root, 'scripts/compatibility-host-transitions.mjs')],
    bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs).map(path => fileURLToPath(pathToFileURL(resolve(path))));
  assert.deepEqual(new Set(inputs), new Set(HOST_TRANSITION_VERIFIER_PATHS.map(path => join(root, path))));
});
