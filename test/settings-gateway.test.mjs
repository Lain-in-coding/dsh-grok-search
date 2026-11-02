import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { apply as applySettings, SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';

test('settings gateway reads shared config, saves with CAS and keeps secrets out of snapshot', async () => {
  let Gateway;
  applySettings({ plugin(Plugin) { Gateway = Plugin; } });
  const directory = mkdtempSync(join(tmpdir(), 'dsh-settings-gateway-'));
  const configPath = join(directory, 'config.toml');
  writeFileSync(configPath, 'grok_api_key = "secret-value"\ngrok_model = "grok-test"\n');
  const services = new Map();
  const security = {
    requireOwner() {},
    requireSecret() {},
    capabilities() { return { secretsAllowed: true, transport: 'loopback', reason: null }; },
  };
  services.set('grokSearchControl', {
    publicSnapshot: () => ({ available: true, phase: 'required', policy: 'required', revision: 1,
      canStop: true, completionCommitted: false, routeVerified: true, routeChanged: true,
      releaseOperationId: null, error: null }),
  });
  services.set('grokSearchProgram', {
    snapshot: () => ({ phase: 'ready', program: { version: '0.1.26' }, configPath, error: null }),
    prepare: async () => ({ phase: 'ready', program: { version: '0.1.26' }, configPath, error: null }),
  });
  services.set('grokSearchCore', {});
  services.set('grokSearchSourceRouter', { diagnose: async () => [], search: async () => ({ sources: [], fallback_used: true }) });
  services.set('grokSearchConnectionSecurity', security);
  const ctx = {
    profileContext: { dir: directory },
    get: name => services.get(name),
    provide: (name, value) => services.set(name, value),
  };
  const gateway = new Gateway(ctx);
  const snapshot = await gateway.snapshot();
  assert.equal(snapshot.config.fields.grok_api_key.configured, true);
  assert.equal(snapshot.config.fields.grok_api_key.value, null);
  const saved = await gateway.save({ expectedRevision: snapshot.config.revision, updates: { grok_model: 'grok-new' } });
  assert.equal(saved.config.fields.grok_model.value, 'grok-new');
  assert.match(readFileSync(configPath, 'utf8'), /grok-new/);
  const revealed = await gateway.reveal({ key: 'grok_api_key' });
  assert.equal(revealed.value, 'secret-value');
  const restored = await gateway.restoreConfig({
    expectedRevision: saved.config.revision,
    revision: snapshot.config.revision,
  });
  assert.equal(restored.config.fields.grok_model.value, 'grok-test');
  assert.equal(restored.config.fields.grok_api_key.value, null);
  assert.equal((await gateway.reveal({ key: 'grok_api_key' })).value, 'secret-value');
  await assert.rejects(gateway.restoreConfig({
    expectedRevision: saved.config.revision,
    revision: snapshot.config.revision,
  }), { code: 'CONFIG_CONFLICT' });
  assert.ok(SETTINGS_DESCRIPTORS.some(descriptor => descriptor.method === 'restoreConfig'));
  assert.ok(SETTINGS_DESCRIPTORS.some(descriptor => descriptor.method === 'testSearch'));
});

test('configuration history restore requires both owner and secret-write authorization', async () => {
  let Gateway;
  applySettings({ plugin(Plugin) { Gateway = Plugin; } });
  const calls = [];
  const security = {
    requireOwner() { calls.push('owner'); },
    requireSecret() { calls.push('secret'); throw new GrokSearchError('SETTINGS_SECRET_FORBIDDEN', '安全连接不可用。'); },
  };
  const gateway = new Gateway({ get: key => key === 'grokSearchConnectionSecurity' ? security : null, provide() {} });
  await assert.rejects(gateway.restoreConfig({
    expectedRevision: 'missing', revision: 'a'.repeat(64),
  }), { code: 'SETTINGS_SECRET_FORBIDDEN' });
  assert.deepEqual(calls, ['owner', 'secret']);
  const descriptor = SETTINGS_DESCRIPTORS.find(row => row.method === 'restoreConfig');
  const codec = descriptor.parameters[0].codec.create();
  assert.throws(() => codec.parse({ expectedRevision: 'missing' }), /Invalid settings payload/);
  assert.throws(() => codec.parse({ expectedRevision: 'missing', revision: 1 }), /Invalid settings payload/);
});

test('settings descriptors do not expose a user stop button contract', () => {
  assert.equal(SETTINGS_DESCRIPTORS.some(descriptor => descriptor.method === 'stop'), true);
});

test('strict RPC codec implements the actual gateway parse boundary', () => {
  const codec = SETTINGS_DESCRIPTORS.find(row => row.method === 'save').parameters[0].codec.create();
  const request = { expectedRevision: 'missing', updates: { grok_api_key: 'sentinel' } };
  assert.deepEqual(codec.parse(request), request);
  assert.equal(codec.safeParse(request).success, true);
  for (const invalid of [null, [], {}, { expectedRevision: 4, updates: {} },
    { expectedRevision: 'missing', updates: [], unexpected: true },
    { expectedRevision: 'missing', updates: { unknown: Infinity } }]) {
    assert.throws(() => codec.parse(invalid), /Invalid settings payload/);
    assert.equal(codec.safeParse(invalid).success, false);
  }
});

test('settings gateway declares the host Remote error protocol it imports', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'],
    manifest.peerDependencies['@deepseek-ai/dsh']);
});

function diagnosticGateway({ core = {}, sourceRouter = {}, preferences } = {}) {
  let Gateway;
  applySettings({ plugin(Plugin) { Gateway = Plugin; } });
  const directory = mkdtempSync(join(tmpdir(), 'dsh-settings-diagnose-'));
  if (preferences) {
    mkdirSync(join(directory, 'grok-search'), { recursive: true });
    writeFileSync(join(directory, 'grok-search', 'preferences.json'), JSON.stringify(preferences));
  }
  const services = new Map([
    ['grokSearchCore', core],
    ['grokSearchSourceRouter', sourceRouter],
    ['grokSearchConnectionSecurity', { requireOwner() {}, requireSecret() {},
      capabilities: () => ({ secretsAllowed: true, transport: 'loopback', reason: null }) }],
  ]);
  return new Gateway({ profileContext: { dir: directory }, get: name => services.get(name), provide: () => {} });
}

test('provider diagnostics can be cancelled and join the core release drain', async () => {
  const active = new Set(), aborts = [];
  const gateway = diagnosticGateway({
    core: { releaseBarrier: {
      begin({ operationId }) { active.add(operationId); },
      settle({ operationId }) { active.delete(operationId); },
    } },
    sourceRouter: { diagnoseProvider: (provider, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborts.push(provider); reject(signal.reason); }, { once: true });
    }) },
  });
  const operationId = randomUUID();
  const task = gateway.diagnoseProvider({ provider: 'exa', operationId });
  assert.equal(active.has(operationId), true);
  assert.deepEqual(await gateway.cancelDiagnosis({ operationId }), { cancelled: true });
  await assert.rejects(task, { code: 'SETTINGS_DIAGNOSIS_CANCELLED' });
  assert.equal(active.size, 0);
  assert.deepEqual(aborts, ['exa']);
  assert.equal(gateway.diagnostics.size, 0);
});

test('cancel-before-dispatch tombstone rejects late diagnostics without sending HTTP', async () => {
  let count = 0;
  const gateway = diagnosticGateway({ sourceRouter: { diagnoseProvider: async () => { count++; } } });
  const operationId = randomUUID();
  assert.deepEqual(await gateway.cancelDiagnosis({ operationId }), { cancelled: false });
  await assert.rejects(gateway.diagnoseProvider({ provider: 'exa', operationId }), { code: 'SETTINGS_DIAGNOSIS_CANCELLED' });
  assert.equal(count, 0);
  await assert.rejects(gateway.cancelDiagnosis({ operationId: 'arbitrary' }), { code: 'SETTINGS_DIAGNOSIS_INVALID' });
  await assert.rejects(gateway.diagnoseProvider({ provider: 'exa', operationId: 'arbitrary' }), { code: 'SETTINGS_DIAGNOSIS_INVALID' });
  for (let i = 0; i < 40; i++) await gateway.cancelDiagnosis({ operationId: randomUUID() });
  assert.equal(gateway.cancelledDiagnostics.size, 32);
});

test('source diagnostics fail closed after release barrier invalidation', async () => {
  let count = 0;
  const gateway = diagnosticGateway({ core: { releaseBarrier: {
    begin() { throw new Error('stopping'); }, settle() { throw new Error('must not settle untracked operation'); },
  } }, sourceRouter: { diagnoseProvider: async () => { count++; } } });
  await assert.rejects(gateway.diagnoseProvider({ provider: 'exa' }), { code: 'GROK_SEARCH_STOPPING' });
  assert.equal(count, 0);
  assert.equal(gateway.diagnostics.size, 0);
});

test('core stop aborts registered diagnoses before the settings fiber leaves', async () => {
  let cancel, aborted = false;
  const active = new Set();
  const gateway = diagnosticGateway({ core: {
    registerDiagnosticCancellation(fn) { cancel = fn; return () => {}; },
    releaseBarrier: { begin({ operationId }) { active.add(operationId); }, settle({ operationId }) { active.delete(operationId); } },
  }, sourceRouter: {
    diagnoseProvider: (provider, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  } });
  const task = gateway.diagnoseProvider({ provider: 'tavily', operationId: randomUUID() });
  assert.equal(active.size, 1);
  cancel();
  await assert.rejects(task, { code: 'SETTINGS_DIAGNOSIS_CANCELLED' });
  assert.equal(aborted, true);
  assert.equal(active.size, 0);
});

test('legacy full diagnosis also respects a stopping release barrier', async () => {
  let calls = 0;
  const gateway = diagnosticGateway({ core: { releaseBarrier: {
    begin() { throw new Error('stopping'); },
  } }, sourceRouter: { diagnose: async () => { calls++; return []; } } });
  await assert.rejects(gateway.diagnose(), { code: 'GROK_SEARCH_STOPPING' });
  assert.equal(calls, 0);
  assert.equal(gateway.diagnostics.size, 0);
});

test('grok diagnosis reports an internal grok-search-rs fallback as a primary failure', async () => {
  const fallback = diagnosticGateway({ core: { testGrok: async () => ({ sources: [{ url: 'https://example.com' }],
    diagnostic: { fallbackUsed: true, fallbackReason: 'grok_auth_error' } }) } });
  const failed = await fallback.diagnoseProvider({ provider: 'grok' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 'grok_auth_error');
  assert.match(failed.message, /API Key/);

  const direct = diagnosticGateway({ core: { testGrok: async () => ({ sources: [{ url: 'https://example.com' }],
    diagnostic: { fallbackUsed: false } }) } });
  const ok = await direct.diagnoseProvider({ provider: 'grok' });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.results, 1);

  const thrown = diagnosticGateway({ core: { testGrok: async () => {
    throw Object.assign(new Error('raw upstream body with key'), { code: 'GROK_TOOL_ERROR' });
  } } });
  const tool = await thrown.diagnoseProvider({ provider: 'grok' });
  assert.equal(tool.code, 'GROK_TOOL_ERROR');
  assert.ok(!tool.message.includes('raw upstream'));
});

test('grok diagnosis is skipped when the primary engine is switched off', async () => {
  let called = false;
  const gateway = diagnosticGateway({
    core: { testGrok: async () => { called = true; return { sources: [] }; } },
    preferences: { schemaVersion: 1, grokEnabled: false, githubEnabled: true,
      sourceOrder: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
      sourceEnabled: { tavily: true, exa: true, tinyfish: true, firecrawl: true } },
  });
  const result = await gateway.diagnoseProvider({ provider: 'grok' });
  assert.equal(result.status, 'disabled');
  assert.equal(called, false);
});

test('provider diagnosis routes sources and forwards JSON-safe error details', async () => {
  const seen = [];
  const gateway = diagnosticGateway({ sourceRouter: {
    diagnoseProvider: async provider => { seen.push(provider); return { provider, status: 'ok', code: 'OK', message: '连接成功。' }; },
  } });
  assert.equal((await gateway.diagnoseProvider({ provider: 'github' })).provider, 'github');
  assert.equal((await gateway.diagnoseProvider({ provider: 'tinyfish' })).status, 'ok');
  assert.deepEqual(seen, ['github', 'tinyfish']);
  await assert.rejects(() => gateway.diagnoseProvider({ provider: '../etc' }), error => error.code === 'SOURCE_UNKNOWN');

  const failing = diagnosticGateway({ core: { testSearch: async () => {
    throw new GrokSearchError('SOURCE_ALL_FAILED', '主搜索与已开启的补充来源均未返回结果。',
      { failures: [{ provider: 'grok', code: 'GROK_TOOL_ERROR', message: 'x' }, { provider: 'tavily', code: 'HTTP_401', httpStatus: 401, message: 'y' }] });
  } } });
  await assert.rejects(() => failing.testSearch({ query: 'q' }), error => error.code === 'SOURCE_ALL_FAILED'
    && error.details.failures.length === 2 && error.details.failures[1].httpStatus === 401);
  const descriptor = SETTINGS_DESCRIPTORS.find(row => row.method === 'diagnoseProvider');
  assert.ok(descriptor);
  assert.deepEqual(descriptor.parameters[0].codec.create().parse({ provider: 'exa' }), { provider: 'exa' });
  assert.throws(() => descriptor.parameters[0].codec.create().parse({ provider: 'exa', extra: 1 }));
});

function viewGateway({ configPath, transport = 'loopback', core = {}, configuration, preferences, withProgram = true } = {}) {
  let Gateway;
  applySettings({ plugin(Plugin) { Gateway = Plugin; } });
  const directory = mkdtempSync(join(tmpdir(), 'dsh-settings-view-'));
  if (preferences) {
    mkdirSync(join(directory, 'grok-search'), { recursive: true });
    writeFileSync(join(directory, 'grok-search', 'preferences.json'), JSON.stringify(preferences));
  }
  const path = configPath ?? join(directory, 'config.toml');
  const program = { phase: 'ready', program: { version: '0.1.26', source: 'private-cache' }, configPath: path, error: null,
    configuration: configuration ?? { executable: false, configPath: false } };
  const services = new Map([
    ['grokSearchCore', core],
    ['grokSearchSourceRouter', {}],
    ['grokSearchConnectionSecurity', { requireOwner() {}, requireSecret() {},
      capabilities: () => ({ secretsAllowed: transport !== 'restricted', transport, reason: null }) }],
    ...(withProgram ? [['grokSearchProgram', { snapshot: () => structuredClone(program) }]] : []),
  ]);
  const gateway = new Gateway({ profileContext: { dir: directory }, get: name => services.get(name), provide: () => {} });
  return { gateway, directory, path };
}
const withoutConfigEnv = async work => {
  const names = Object.keys(process.env).filter(name => name.toUpperCase() === 'GROK_SEARCH_CONFIG');
  const saved = names.map(name => [name, process.env[name]]);
  for (const name of names) delete process.env[name];
  try { return await work(); } finally { for (const [name, value] of saved) process.env[name] = value; }
};
const snapshotCodec = () => SETTINGS_DESCRIPTORS.find(row => row.method === 'snapshot').result.create();

test('snapshot carries the last route and plugin facts through the strict codec', async () => withoutConfigEnv(async () => {
  const route = { at: 1, origin: 'search', outcome: 'ok', served: 'tavily', grokCode: 'grok_auth_error',
    fallbackUsed: true, failures: [{ provider: 'exa', code: 'HTTP_401' }] };
  const { gateway, path } = viewGateway({ core: { routeSnapshot: () => route, budgetMs: 90_000 } });
  writeFileSync(path, 'grok_api_key = "secret-value"\nsource_providers = ["exa"]\n');
  const snapshot = await gateway.snapshot();
  assert.deepEqual(snapshotCodec().parse(snapshot), snapshot);
  assert.deepEqual(snapshot.route, route);
  assert.deepEqual(snapshot.plugin, { budgetMs: 90_000, programConfigured: false, configSource: 'default' });
  assert.equal(typeof snapshot.config.displayPath, 'string');
  assert.equal(snapshot.program.configuration.executable, false);
  assert.equal(JSON.stringify(snapshot).includes('secret-value'), false);
  // A route carrying anything beyond stable codes is rejected at the boundary.
  assert.throws(() => snapshotCodec().parse({ ...snapshot, route: { ...route, query: 'hello' } }), /Invalid settings payload/);

  const pinned = viewGateway({ configuration: { executable: true, configPath: true } });
  assert.deepEqual((await pinned.gateway.snapshot()).plugin, { budgetMs: null, programConfigured: true, configSource: 'plugin' });

  const bare = viewGateway({ core: null, withProgram: false });
  const empty = await bare.gateway.snapshot();
  assert.equal(empty.route, null);
  assert.equal(empty.program, null);
  assert.deepEqual(empty.plugin, { budgetMs: null, programConfigured: false, configSource: 'default' });
  assert.deepEqual(snapshotCodec().parse(empty), empty);
}));

test('snapshot reports an environment-selected config file', async () => withoutConfigEnv(async () => {
  const { gateway, path } = viewGateway({});
  process.env.GROK_SEARCH_CONFIG = path;
  try { assert.equal((await gateway.snapshot()).plugin.configSource, 'environment'); }
  finally { delete process.env.GROK_SEARCH_CONFIG; }
}));

test('a broken config file still yields a parseable snapshot with its path', async () => {
  const { gateway, path } = viewGateway({});
  writeFileSync(path, 'grok_api_key = [unclosed\n');
  const snapshot = await gateway.snapshot();
  assert.equal(snapshot.config.path, path);
  assert.equal(snapshot.config.error.code, 'CONFIG_PARSE_FAILED');
  assert.equal(snapshot.config.exists, true, 'a broken file is reported as existing');
  assert.equal(typeof snapshot.config.displayPath, 'string');
  assert.deepEqual(snapshotCodec().parse(snapshot), snapshot);
});

test('openConfigLocation validates the target and never opens anything it cannot see', async () => {
  const descriptor = SETTINGS_DESCRIPTORS.find(row => row.method === 'openConfigLocation');
  assert.deepEqual(descriptor.parameters.map(item => item.name), ['request']);
  const requestCodec = descriptor.parameters[0].codec.create();
  assert.deepEqual(requestCodec.parse({ kind: 'file' }), { kind: 'file' });
  assert.throws(() => requestCodec.parse({ kind: 'file', path: 'C:/elsewhere' }), /Invalid settings payload/);
  const resultCodec = descriptor.result.create();

  const missing = join(homedir(), `.dsh-grok-search-test-${randomUUID()}`, 'config.toml');
  const remote = viewGateway({ configPath: missing, transport: 'restricted' });
  await assert.rejects(() => remote.gateway.openConfigLocation({ kind: 'editor' }), error => error.code === 'CONFIG_OPEN_INVALID');
  const restricted = await remote.gateway.openConfigLocation({ kind: 'file' });
  assert.deepEqual(resultCodec.parse(restricted), restricted);
  assert.equal(restricted.opened, false);
  assert.equal(restricted.path, missing);
  assert.equal(restricted.kind, 'file');
  assert.equal(restricted.exists, false);
  assert.ok(restricted.displayPath.startsWith('~'), restricted.displayPath);
  assert.ok(restricted.displayPath.endsWith('config.toml'));

  // On the local host a missing file or folder is reported, never spawned.
  const local = viewGateway({ configPath: missing });
  for (const kind of ['file', 'folder']) {
    const result = await local.gateway.openConfigLocation({ kind });
    assert.equal(result.opened, false);
    assert.equal(result.exists, false);
  }
  assert.equal((await local.gateway.openConfigLocation()).kind, 'folder');
});

test('preferences are only the plugin-private DSH switches', async () => {
  const stored = { schemaVersion: 1, grokEnabled: false, githubEnabled: false,
    sourceOrder: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
    sourceEnabled: { tavily: true, exa: true, tinyfish: true, firecrawl: true } };
  const { gateway, path } = viewGateway({ preferences: stored });
  // The shared chain lives in config.toml; it no longer leaks into preferences.
  writeFileSync(path, 'source_providers = ["firecrawl"]\ntavily_enabled = false\n');
  const current = await gateway.preferences();
  assert.deepEqual(current.value, stored);
  const saved = await gateway.savePreferences({ expectedRevision: current.revision, value: { ...current.value, grokEnabled: true } });
  assert.equal(saved.value.grokEnabled, true);
  assert.equal(readFileSync(path, 'utf8'), 'source_providers = ["firecrawl"]\ntavily_enabled = false\n');
});

test('a failed test search is reported as is, never retried through the sources', async () => {
  let sourceCalls = 0;
  const failure = new GrokSearchError('SOURCE_ALL_FAILED', '均失败', { failures: [{ provider: 'grok', code: 'grok_auth_error' }] });
  const gateway = diagnosticGateway({
    core: { testSearch: async () => { throw failure; } },
    sourceRouter: { search: async () => { sourceCalls += 1; return { sources: [], fallback_used: true }; } },
  });
  await assert.rejects(() => gateway.testSearch({ query: 'q' }), error => error.code === 'SOURCE_ALL_FAILED'
    && error.details.failures[0].code === 'grok_auth_error');
  assert.equal(sourceCalls, 0);
  // Without a loaded core the sources answer the test directly.
  const bare = diagnosticGateway({ core: null,
    sourceRouter: { search: async () => { sourceCalls += 1; return { sources: [{ url: 'https://a.test' }], fallback_used: true, search_provider: 'exa' }; } } });
  assert.deepEqual(await bare.testSearch({ query: 'q' }), { sources: [{ url: 'https://a.test' }], fallbackUsed: true, provider: 'exa' });
  assert.equal(sourceCalls, 1);
});
