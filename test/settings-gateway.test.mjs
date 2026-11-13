import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { apply as applySettings, SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';
import { createConnectionSecurity } from '../src/core/connection-security.mjs';
import { createConfigLocationOpener } from '../src/core/config-opener.mjs';
import { createSearchLog } from '../src/core/search-log.mjs';
import { createToolRouteContext } from '../src/core/tool-route-context.mjs';

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

test('private cache repair has its own owner-checked RPC and does not accept a caller path or version', async () => {
  let Gateway, deny = false, repairs = 0;
  applySettings({ plugin(Plugin) { Gateway = Plugin; } });
  const state = { phase: 'ready', configPath: '/synthetic/config.toml', program: null, error: null, canRepair: false };
  const gateway = new Gateway({
    get: name => name === 'grokSearchConnectionSecurity'
      ? { requireOwner() { if (deny) throw new GrokSearchError('SETTINGS_AUTH_REQUIRED', 'denied'); } }
      : name === 'grokSearchProgram' ? { repair: async () => { repairs++; return state; } } : null,
    provide() {},
  });
  assert.deepEqual(await gateway.repairProgram(), state);
  deny = true;
  await assert.rejects(gateway.repairProgram(), { code: 'SETTINGS_AUTH_REQUIRED' });
  assert.equal(repairs, 1);
  const descriptor = SETTINGS_DESCRIPTORS.find(row => row.method === 'repairProgram');
  assert.equal(descriptor.parameters.length, 0);
  assert.equal(descriptor.result.create().safeParse(state).success, true);
  assert.ok(SETTINGS_DESCRIPTORS.some(row => row.method === 'prepareProgram'), 'existing RPC stays compatible');
});

test('remote HTTP cannot redirect stored credentials by changing a service URL', async () => {
  let Gateway;
  applySettings({ plugin(Plugin) { Gateway = Plugin; } });
  const directory = mkdtempSync(join(tmpdir(), 'dsh-settings-destination-'));
  const path = join(directory, 'config.toml');
  const original = 'tavily_api_key = "synthetic-destination-key"\n';
  writeFileSync(path, original);
  const security = createConnectionSecurity();
  const services = new Map([
    ['grokSearchConnectionSecurity', security],
    ['grokSearchProgram', { snapshot: () => ({ configPath: path }) }],
  ]);
  const ctx = { profileContext: { dir: directory }, get: key => services.get(key), provide() {},
    invocation: { peer: { principal: { kind: 'owner' } } } };
  const gateway = new Gateway(ctx);
  const remote = { socket: { remoteAddress: '192.0.2.1', localAddress: '192.0.2.2', encrypted: false }, headers: {} };
  const local = { socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', encrypted: false }, headers: {} };
  try {
    await security.run(remote, null, async () => {
      const before = await gateway.snapshot();
      assert.equal(before.capabilities.secretsAllowed, false);
      for (const key of ['grok_api_url', 'openai_compatible_api_url', 'tavily_api_url', 'exa_api_url',
        'tinyfish_search_api_url', 'tinyfish_fetch_api_url', 'firecrawl_api_url']) {
        for (const value of ['https://example.invalid/changed', null]) {
          await assert.rejects(gateway.save({
            expectedRevision: before.config.revision, updates: { [key]: value },
          }), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
          assert.equal(readFileSync(path, 'utf8'), original);
        }
      }
      const allowed = await gateway.save({ expectedRevision: before.config.revision, updates: { timeout_seconds: 65 } });
      assert.equal(allowed.config.fields.timeout_seconds.value, 65, 'non-destination settings remain editable');
    });
    await security.run(local, null, async () => {
      const before = await gateway.snapshot();
      const saved = await gateway.save({ expectedRevision: before.config.revision,
        updates: { tavily_api_url: 'https://example.invalid/authorized' } });
      assert.equal(saved.config.fields.tavily_api_url.value, 'https://example.invalid/authorized');
      assert.equal(saved.config.fields.tavily_api_key.value, null);
    });
  } finally { security.dispose(); }
});

test('legacy stop RPC remains available without requiring a user-visible stop button', () => {
  assert.equal(SETTINGS_DESCRIPTORS.some(descriptor => descriptor.method === 'stop'), true);
});

test('all settings methods remain SRC-discoverable when an old host caches older Typert metadata', () => {
  let Gateway;
  applySettings({ plugin(Plugin) { Gateway = Plugin; } });
  for (const descriptor of SETTINGS_DESCRIPTORS) {
    const text = Gateway.prototype[descriptor.method].toString();
    const parameters = /^\s*async function\s*\(([^)]*)\)/.exec(text)?.[1].trim();
    assert.equal(parameters, descriptor.parameters.map(parameter => parameter.name).join(', '), descriptor.method);
    assert.doesNotMatch(parameters, /\.\.\.|=|[{[]/);
  }
});

test('SRC dispatch keeps draft validation and owner-only protection without the cached strict descriptor', async () => {
  const { gateway } = viewGateway();
  const before = await gateway.snapshot();
  const request = { provider: 'tavily', expectedRevision: before.config.revision,
    quotaRevision: before.config.quotaRevision, operationId: randomUUID(),
    draft: { apiKey: 'synthetic', unexpected: 'never accepted' } };
  await assert.rejects(gateway.previewAccountQuota(request), { code: 'SETTINGS_REQUEST_INVALID' });
  await assert.rejects(gateway.previewAccountQuota({ ...request, draft: { apiKey: 'bad\nheader' } }),
    { code: 'CONFIG_VALUE_INVALID' });
});

test('direct dispatch validates missing requests while optional config opening keeps its empty default', async () => {
  const { gateway, path } = viewGateway({ transport: 'restricted' });
  let reads = 0;
  gateway._store = () => { reads++; throw new Error('invalid requests must not read configuration'); };
  for (const descriptor of SETTINGS_DESCRIPTORS) {
    if (!descriptor.parameters.length || descriptor.method.startsWith('openConfigLocation')) continue;
    await assert.rejects(gateway[descriptor.method](), { code: 'SETTINGS_REQUEST_INVALID' }, descriptor.method);
    await assert.rejects(gateway[descriptor.method](undefined), { code: 'SETTINGS_REQUEST_INVALID' }, descriptor.method);
  }
  for (const method of ['openConfigLocation', 'openConfigLocationWithStatus']) {
    for (const value of [undefined, {}]) {
      const result = await gateway[method](value);
      assert.equal(result.kind, 'folder');
      assert.equal(result.path, path);
      assert.equal(result.opened, false);
    }
    await assert.rejects(gateway[method](null), { code: 'SETTINGS_REQUEST_INVALID' });
  }
  assert.equal(reads, 0);
});

test('owner RPCs fail closed when connection security is absent', async () => {
  const { gateway } = viewGateway();
  gateway.security = null;
  let effects = 0;
  gateway._store = () => { effects++; throw new Error('must not read or save'); };
  gateway.preferenceStore = { snapshot() { effects++; }, save() { effects++; } };
  gateway.program = { prepare() { effects++; }, repair() { effects++; } };
  gateway.control = { stop() { effects++; } };
  for (const [method, request] of [
    ['snapshot'], ['preferences'], ['prepareProgram'], ['repairProgram'], ['stop'],
    ['save', { expectedRevision: 'missing', updates: { grok_model: 'new' } }],
    ['savePreferences', { expectedRevision: 'missing', value: {} }],
    ['toolCallRoute', { sessionId: randomUUID(), callId: 'call' }],
    ['toolCallTrace', { sessionId: randomUUID(), callId: 'call' }],
  ]) await assert.rejects(gateway[method](request), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' }, method);
  assert.equal(effects, 0);
});

test('search history uses separate secure owner RPCs; ordinary snapshot stays redacted', async () => {
  const log = createSearchLog(), id = randomUUID();
  const { gateway } = viewGateway({ core: { searchLog: log } });
  await gateway.readSearchLog({ sessionId: id });
  const token = log.begin('private-search-text');
  log.finish(token, { outcome: 'ok', served: 'grok' });
  const value = await gateway.readSearchLog({ sessionId: id });
  const descriptor = SETTINGS_DESCRIPTORS.find(row => row.method === 'readSearchLog');
  assert.deepEqual(descriptor.result.create().parse(value), value);
  assert.equal(value.records[0].q, 'private-search-text');
  assert.equal(JSON.stringify(await gateway.snapshot()).includes('private-search-text'), false);
  await gateway.clearSearchLog({ sessionId: id });
  assert.deepEqual(await gateway.readSearchLog({ sessionId: id }), { records: [] });
  await gateway.closeSearchLog({ sessionId: id });
  log.dispose();
});

test('clearing private search history preserves independent chat routes and traces', async () => {
  const log = createSearchLog(), routes = createToolRouteContext(), sessionId = randomUUID();
  const { gateway } = viewGateway({ core: { searchLog: log } });
  gateway.callRoutes = routes;
  try {
    await gateway.readSearchLog({ sessionId });
    const token = log.begin('private-history');
    log.finish(token, { outcome: 'ok', served: 'tavily' });
    await routes.run({ name: 'web_search', callId: 'call', agent: { session: { id: sessionId } } }, async () => {
      routes.capture().finish({ outcome: 'ok', served: 'tavily' });
    });
    const request = { sessionId, callId: 'call' };
    const route = await gateway.toolCallRoute(request), trace = await gateway.toolCallTrace(request);
    assert.equal(route.known, true);
    assert.equal(trace.known, true);
    assert.deepEqual(await gateway.clearSearchLog({ sessionId }), { records: [] });
    assert.deepEqual(await gateway.toolCallRoute(request), route);
    assert.deepEqual(await gateway.toolCallTrace(request), trace);
  } finally { log.dispose(); routes.dispose(); }
});

test('chat route RPC requires owner and exact session/call identity without exposing search text', async () => {
  const routes = createToolRouteContext(), sessionId = randomUUID();
  await routes.run({ name: 'web_search', callId: 'native-call', agent: { session: { id: sessionId } } }, async () => {
    routes.capture().finish({ outcome: 'ok', served: 'tavily', grokCode: 'DISABLED', fallbackUsed: true });
  });
  const { gateway } = viewGateway();
  gateway.callRoutes = routes;
  const value = await gateway.toolCallRoute({ sessionId, callId: 'native-call' });
  const descriptor = SETTINGS_DESCRIPTORS.find(row => row.method === 'toolCallRoute');
  assert.deepEqual(descriptor.result.create().parse(value), value);
  assert.equal(value.known, true);
  assert.equal(value.routes[0].served, 'tavily');
  assert.equal(value.routes[0].fallbackUsed, false);
  assert.equal((await gateway.toolCallRoute({ sessionId: randomUUID(), callId: 'native-call' })).known, false);
  assert.equal((await gateway.toolCallRoute({ sessionId, callId: 'other' })).known, false);
  gateway.security = { requireOwner() { throw new GrokSearchError('SETTINGS_AUTH_REQUIRED', 'Denied'); } };
  await assert.rejects(gateway.toolCallRoute({ sessionId, callId: 'native-call' }), { code: 'SETTINGS_AUTH_REQUIRED' });
  routes.dispose();
});

test('private data RPCs require actual connection security even if the client claims otherwise', async () => {
  let Gateway;
  applySettings({ plugin(Plugin) { Gateway = Plugin; } });
  for (const security of [null, {
    requireOwner() {},
    requireSecret() { throw new GrokSearchError('SETTINGS_SECURE_CONNECTION_REQUIRED', '连接不安全。'); },
  }]) {
    const gateway = new Gateway({ get: key => key === 'grokSearchConnectionSecurity' ? security : null, provide() {} });
    for (const method of ['readSearchLog', 'clearSearchLog', 'closeSearchLog', 'accountQuota']) {
      await assert.rejects(gateway[method]({ sessionId: randomUUID() }), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
    }
  }
});

test('quota RPC rejects stale revisions, unknown providers and cancelled operations before network', async () => {
  const { gateway, path } = viewGateway();
  writeFileSync(path, 'tavily_api_key = "synthetic"\n');
  const snapshot = await gateway.snapshot();
  await assert.rejects(gateway.accountQuota({ provider: 'tavily', expectedRevision: 'stale',
    quotaRevision: snapshot.config.quotaRevision, operationId: randomUUID() }), { code: 'CONFIG_CONFLICT' });
  await assert.rejects(gateway.accountQuota({ provider: 'unknown', expectedRevision: snapshot.config.revision,
    quotaRevision: snapshot.config.quotaRevision, operationId: randomUUID() }), { code: 'QUOTA_QUERY_FAILED' });
  const operationId = randomUUID();
  await gateway.cancelDiagnosis({ operationId });
  await assert.rejects(gateway.accountQuota({ provider: 'tavily', expectedRevision: snapshot.config.revision,
    quotaRevision: snapshot.config.quotaRevision, operationId }), { code: 'SETTINGS_DIAGNOSIS_CANCELLED' });
});

test('effective configuration identity changes when environment keys change, without exposing hashes of raw secrets', async () => {
  const previous = process.env.TAVILY_API_KEY;
  try {
    process.env.TAVILY_API_KEY = 'synthetic-first';
    const { gateway } = viewGateway();
    const first = await gateway.snapshot();
    process.env.TAVILY_API_KEY = 'synthetic-second';
    const second = await gateway.snapshot();
    assert.equal(first.config.revision, second.config.revision, 'file revision alone cannot identify environment secrets');
    assert.notEqual(first.config.quotaRevision, second.config.quotaRevision);
    assert.equal(JSON.stringify(second).includes('synthetic-second'), false);
    await assert.rejects(gateway.accountQuota({ provider: 'tavily', expectedRevision: second.config.revision,
      quotaRevision: first.config.quotaRevision, operationId: randomUUID() }), { code: 'CONFIG_CONFLICT' });
    const other = viewGateway();
    assert.notEqual((await other.gateway.snapshot()).config.quotaRevision, second.config.quotaRevision);
  } finally {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  }
});

test('quota response cannot cross a concurrent config revision or a cancellation', async () => {
  const { createServer } = await import('node:http');
  let received, response;
  const server = createServer((request, reply) => {
    request.resume();
    response = reply;
    received?.();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { gateway, path } = viewGateway();
  writeFileSync(path, `tavily_api_key = "offline-quota-key"\ntavily_api_url = "http://127.0.0.1:${server.address().port}"\n`);
  try {
    for (const mode of ['changed', 'cancelled']) {
      const snapshot = await gateway.snapshot();
      const operationId = randomUUID();
      const dispatched = new Promise(resolve => { received = resolve; });
      const pending = gateway.accountQuota({ provider: 'tavily',
        expectedRevision: snapshot.config.revision, quotaRevision: snapshot.config.quotaRevision, operationId });
      const rejection = assert.rejects(pending, { code: mode === 'changed' ? 'CONFIG_CONFLICT' : 'SETTINGS_DIAGNOSIS_CANCELLED' });
      await dispatched;
      if (mode === 'changed') writeFileSync(path, readFileSync(path, 'utf8') + '# other application saved\n');
      else await gateway.cancelDiagnosis({ operationId });
      response.end(JSON.stringify({ account: { plan_usage: 1, plan_limit: 10 } }));
      await rejection;
      assert.equal(gateway.diagnostics.size, 0);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('authenticated draft quota query and cancellation never save a file or config history', async () => {
  const { createServer } = await import('node:http');
  const { existsSync } = await import('node:fs');
  const { gateway, path } = viewGateway();
  const server = createServer((request, response) => {
    assert.equal(request.url, '/usage');
    assert.equal(request.headers.authorization, 'Bearer unsaved-synthetic');
    response.end(JSON.stringify({ account: { plan_usage: 3, plan_limit: 10 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const snapshot = await gateway.snapshot();
    const request = { provider: 'tavily', expectedRevision: snapshot.config.revision,
      quotaRevision: snapshot.config.quotaRevision, operationId: randomUUID(),
      draft: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'unsaved-synthetic' } };
    const descriptor = SETTINGS_DESCRIPTORS.find(row => row.method === 'accountQuota');
    assert.equal(descriptor.parameters[0].codec.create().safeParse(request).success, true);
    const reads = observeConfigReads(gateway);
    assert.equal((await gateway.accountQuota(request)).value.remaining, 7);
    assert.deepEqual(reads, { paired: 2, snapshot: 0, effective: 0 });
    assert.equal(existsSync(path), false, 'query does not create shared config');
    assert.equal((await gateway.snapshot()).config.revision, snapshot.config.revision);
    const operationId = randomUUID();
    await gateway.cancelDiagnosis({ operationId });
    await assert.rejects(gateway.accountQuota({ ...request, operationId }), { code: 'SETTINGS_DIAGNOSIS_CANCELLED' });
    assert.equal(existsSync(path), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('strict RPC codec implements the actual gateway parse boundary', () => {
  const codec = SETTINGS_DESCRIPTORS.find(row => row.method === 'save').parameters[0].codec.create();
  const request = { expectedRevision: 'missing', updates: { grok_api_key: 'sentinel' } };
  assert.deepEqual(codec.parse(request), request);
  assert.equal(codec.safeParse(request).success, true);
  let deeplyNested = 1;
  for (let i = 0; i < 70; i++) deeplyNested = { next: deeplyNested };
  for (const invalid of [null, [], {}, { expectedRevision: 4, updates: {} },
    { expectedRevision: 'missing', updates: [], unexpected: true },
    { expectedRevision: 'missing', updates: { unknown: Infinity } },
    { expectedRevision: 'missing', updates: { unknown: new Date() } },
    { expectedRevision: 'missing', updates: { unknown: deeplyNested } }]) {
    assert.throws(() => codec.parse(invalid), /Invalid settings payload/);
    assert.equal(codec.safeParse(invalid).success, false);
  }
});

test('missing required RPC arguments are rejected before implementation dispatch', async () => {
  const { gateway } = viewGateway();
  await assert.rejects(gateway.testSearch(), { code: 'SETTINGS_REQUEST_INVALID' });
  await assert.rejects(gateway.testSearch({}), { code: 'SETTINGS_REQUEST_INVALID' });
});

test('settings gateway declares the host Remote error protocol it imports', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'],
    manifest.peerDependencies['@deepseek-ai/dsh']);
});

function diagnosticGateway({ core = {}, sourceRouter = {}, preferences, github = null } = {}) {
  let Gateway;
  applySettings({ plugin(Plugin) { Gateway = Plugin; } });
  const directory = mkdtempSync(join(tmpdir(), 'dsh-settings-diagnose-'));
  if (preferences) {
    mkdirSync(join(directory, 'grok-search'), { recursive: true });
    writeFileSync(join(directory, 'grok-search', 'preferences.json'), JSON.stringify(preferences));
  }
  const services = new Map([
    ['grokSearchProgram', { snapshot: () => ({ configPath: join(directory, 'config.toml') }) }],
    ['grokSearchCore', core],
    ['grokSearchSourceRouter', sourceRouter],
    ['grokSearchGithub', github],
    ['grokSearchConnectionSecurity', { requireOwner() {}, requireSecret() {},
      capabilities: () => ({ secretsAllowed: true, transport: 'loopback', reason: null }) }],
  ]);
  return new Gateway({ profileContext: { dir: directory }, get: name => services.get(name), provide: () => {} });
}

function observeConfigReads(gateway) {
  const reads = { paired: 0, snapshot: 0, effective: 0 }, original = gateway._store.bind(gateway);
  gateway._store = path => {
    const store = original(path);
    return { ...store,
      readSnapshot() { reads.paired++; return store.readSnapshot(); },
      snapshot() { reads.snapshot++; return store.snapshot(); },
      readEffective() { reads.effective++; return store.readEffective(); },
    };
  };
  return reads;
}

test('settings snapshot passes its exact local configuration capture to the health view once', async () => {
  let observed;
  const gateway = diagnosticGateway({ core: { routeSnapshot(captured) { observed = captured; return null; } } });
  const reads = observeConfigReads(gateway);
  const result = await gateway.snapshot();
  assert.deepEqual(reads, { paired: 1, snapshot: 0, effective: 0 });
  assert.equal(observed.snapshot.revision, result.config.revision);
  assert.equal(observed.snapshot.path, result.config.path);
  assert.ok(observed.effective);
});

test('provider diagnosis pairs revision and effective identity in one read at each boundary', async () => {
  const gateway = diagnosticGateway({ sourceRouter: {
    diagnoseProvider: async provider => ({ provider, status: 'ok', code: 'OK', message: 'ok' }),
  } });
  const reads = observeConfigReads(gateway);
  assert.equal((await gateway.diagnoseProvider({ provider: 'tavily' })).status, 'ok');
  assert.deepEqual(reads, { paired: 2, snapshot: 0, effective: 0 });
});

test('diagnostic completion rejects a new configuration path even if both files have identical content', async () => {
  const gateway = diagnosticGateway({ sourceRouter: {
    diagnoseProvider: async provider => {
      const next = join(gateway.profileContext.dir, 'other.toml');
      gateway.program = { snapshot: () => ({ configPath: next }) };
      return { provider, status: 'ok', code: 'OK', message: 'ok' };
    },
  } });
  await assert.rejects(gateway.diagnoseProvider({ provider: 'tavily' }), { code: 'CONFIG_CONFLICT' });
});

test('diagnostic completion notices changed environment configuration without a file revision change', async () => {
  const previous = process.env.TAVILY_API_KEY;
  try {
    process.env.TAVILY_API_KEY = 'first-synthetic-key';
    const gateway = diagnosticGateway({ sourceRouter: {
      diagnoseProvider: async provider => {
        process.env.TAVILY_API_KEY = 'second-synthetic-key';
        return { provider, status: 'ok', code: 'OK', message: 'ok' };
      },
    } });
    await assert.rejects(gateway.diagnoseProvider({ provider: 'tavily' }), { code: 'CONFIG_CONFLICT' });
  } finally {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  }
});

test('diagnostic results cannot validate a key replaced while the request is in flight', async () => {
  let complete, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gateway = diagnosticGateway({ sourceRouter: { diagnoseProvider: () => {
    entered(); return new Promise(resolve => { complete = resolve; });
  } } });
  const before = await gateway.snapshot();
  const result = gateway.diagnoseProvider({ provider: 'tavily', expectedRevision: before.config.revision,
    configIdentity: before.config.quotaRevision });
  await ready;
  writeFileSync(gateway._configPath(), 'tavily_api_key = "changed"\n');
  complete({ provider: 'tavily', status: 'ok', code: 'OK', keys: [] });
  await assert.rejects(result, { code: 'CONFIG_CONFLICT' });
});

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

test('Grok diagnostic copy distinguishes missing citations from protocol and authentication failures', async () => {
  for (const [code, expected] of [
    ['grok_sources_empty', 'Grok 未返回引用链接。'],
    ['grok_content_empty', 'Grok 未返回回答内容。'],
    ['grok_provider_error', 'Grok 接口调用失败，请检查接口协议、Base URL 和模型。'],
  ]) {
    const gateway = diagnosticGateway({ core: { testGrok: async () => ({
      sources: [{ url: 'https://example.com' }],
      diagnostic: { fallbackUsed: true, fallbackReason: code },
    }) } });
    const result = await gateway.diagnoseProvider({ provider: 'grok' });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, code);
    assert.equal(result.message, expected);
    assert.ok(!result.message.includes('API Key'));
  }
});

test('Grok empty-source RPC failure preserves the safe reason rather than blaming initialization', async () => {
  const gateway = diagnosticGateway({ core: { testGrok: async () => {
    throw new GrokSearchError('grok_sources_empty', 'Grok 未返回引用链接。');
  } } });
  const result = await gateway.diagnoseProvider({ provider: 'grok' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'grok_sources_empty');
  assert.equal(result.message, 'Grok 未返回引用链接。');
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
  assert.equal((await gateway.diagnoseProvider({ provider: 'github' })).status, 'disabled');
  assert.equal((await gateway.diagnoseProvider({ provider: 'tinyfish' })).status, 'ok');
  assert.deepEqual(seen, ['tinyfish']);
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

test('GitHub main test requires explicit read consent, including anonymous public reading', async () => {
  let calls = 0, seenToken = null;
  const gateway = diagnosticGateway({ github: { test: async ({ token }) => {
    calls++; seenToken = token; return { provider: 'github', status: 'ok', code: 'OK', message: '公开读取成功', keys: [] };
  }, sync() {} } });
  assert.equal((await gateway.diagnoseProvider({ provider: 'github' })).status, 'disabled');
  assert.equal(calls, 0);
  const preferences = await gateway.preferences();
  await gateway.savePreferences({ expectedRevision: preferences.revision, value: { ...preferences.value, githubReadEnabled: true } });
  assert.equal((await gateway.diagnoseProvider({ provider: 'github' })).status, 'ok');
  assert.equal(calls, 1);
  assert.equal(seenToken, '');
});

test('GitHub draft connection tests do not save token or enable reading; cancellation blocks dispatch', async () => {
  const tokens = [];
  const gateway = diagnosticGateway({ github: { test: async ({ token }) => {
    tokens.push(token); return { provider: 'github', status: 'ok', code: 'OK', message: '公开读取成功', keys: [] };
  } } });
  const snapshot = await gateway.snapshot(), prefs = await gateway.preferences();
  const request = { token: 'transient-test-value', operationId: randomUUID(), expectedRevision: snapshot.config.revision,
    configIdentity: snapshot.config.quotaRevision };
  const reads = observeConfigReads(gateway);
  assert.equal((await gateway.previewGithubConnection(request)).status, 'ok');
  assert.deepEqual(reads, { paired: 2, snapshot: 0, effective: 0 });
  assert.deepEqual(tokens, ['transient-test-value']);
  assert.equal(existsSync(gateway._configPath()), false);
  assert.deepEqual(await gateway.preferences(), prefs);
  const cancelled = { ...request, operationId: randomUUID() };
  await gateway.cancelDiagnosis({ operationId: cancelled.operationId });
  await assert.rejects(gateway.previewGithubConnection(cancelled), { code: 'SETTINGS_DIAGNOSIS_CANCELLED' });
  assert.equal(tokens.length, 1);
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
const withIsolatedHome = async work => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-isolated-home-'));
  const pattern = /^(HOME|USERPROFILE|GROK_SEARCH_.*|TAVILY_.*|EXA_.*|TINYFISH_.*|FIRECRAWL_.*|OPENAI_COMPATIBLE_.*|GITHUB_TOKEN)$/i;
  const saved = Object.entries(process.env).filter(([name]) => pattern.test(name));
  for (const [name] of saved) delete process.env[name];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return await work(home); }
  finally {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    for (const [name, value] of saved) process.env[name] = value;
  }
};
const snapshotCodec = () => SETTINGS_DESCRIPTORS.find(row => row.method === 'snapshot').result.create();

test('snapshot carries the last route and plugin facts through the strict codec', async () => withIsolatedHome(async home => {
  const route = { at: 1, origin: 'search', outcome: 'ok', served: 'tavily', grokCode: 'grok_auth_error',
    fallbackUsed: true, failures: [{ provider: 'exa', code: 'HTTP_401' }],
    resultProviders: ['tavily'], resultProvidersComplete: true, provenance: 'source-label' };
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
  assert.equal(empty.config.path, join(home, '.config/grok-search-rs/config.toml'));
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

test('invalid configured paths produce a safe snapshot without resolving a fallback path', async () => withoutConfigEnv(async () => {
  try {
    process.env.GROK_SEARCH_CONFIG = 'relative/config.toml';
    for (const withProgram of [false, true]) {
      const { gateway } = viewGateway({ withProgram, configPath: 'relative/config.toml' });
      let resolutions = 0;
      const original = gateway._configPath.bind(gateway);
      gateway._configPath = () => { resolutions++; return original(); };
      const result = await gateway.snapshot();
      assert.equal(resolutions, 1);
      assert.equal(result.config.path, '');
      assert.equal(result.config.displayPath, '');
      assert.equal(result.config.exists, false);
      assert.equal(result.config.error.code, 'CONFIG_PATH_INVALID');
      assert.deepEqual(snapshotCodec().parse(result), result);
    }
  } finally { delete process.env.GROK_SEARCH_CONFIG; }
}));

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

test('config opening keeps the old wire schema, local gate and actual opener errors', async () => {
  const { gateway, path } = viewGateway({});
  writeFileSync(path, 'not valid TOML is still editable\n');
  let calls = 0;
  gateway.configOpener = { open: async request => {
    calls++;
    assert.equal(request.path, path);
    assert.equal(request.kind, 'file');
    return { opened: true, exists: true };
  } };
  const result = await gateway.openConfigLocation({ kind: 'file' });
  assert.equal(result.opened, true);
  const codec = SETTINGS_DESCRIPTORS.find(row => row.method === 'openConfigLocation').result.create();
  assert.deepEqual(codec.parse(result), result);
  assert.deepEqual(Object.keys(result).sort(), ['displayPath', 'exists', 'kind', 'opened', 'path']);
  gateway.configOpener.open = async () => { throw new GrokSearchError('CONFIG_OPEN_FAILED', '系统拒绝打开。', { osCode: 5 }); };
  await assert.rejects(gateway.openConfigLocation({ kind: 'file' }), error =>
    error.code === 'CONFIG_OPEN_FAILED' && error.details.osCode === 5);
  const remote = viewGateway({ configPath: path, transport: 'restricted' });
  remote.gateway.configOpener = { open: async () => { calls++; throw new Error('must not open'); } };
  assert.equal((await remote.gateway.openConfigLocation({ kind: 'file' })).opened, false);
  assert.equal(calls, 1);
  assert.equal(readFileSync(path, 'utf8'), 'not valid TOML is still editable\n');
});

test('config opening does not hide inaccessible locations behind an existence precheck', async () => {
  const { gateway } = viewGateway({});
  let spawned = false;
  gateway.configOpener = createConfigLocationOpener({
    stat() { throw Object.assign(new Error('private filesystem detail'), { code: 'EACCES' }); },
    spawnImpl() { spawned = true; throw new Error('must not spawn'); },
  });
  for (const kind of ['file', 'folder']) {
    await assert.rejects(gateway.openConfigLocation({ kind }), error =>
      error.code === 'CONFIG_OPEN_ACCESS_FAILED' && error.details.cause === 'EACCES'
      && !error.message.includes('private filesystem detail'));
  }
  assert.equal(spawned, false);
});

test('editor fallback is observable without changing the legacy opening schema', async () => {
  const { gateway } = viewGateway({});
  gateway.configOpener = { open: async () => ({
    exists: true, opened: true, editor: 'classic', fallbackReason: 'early-exit',
  }) };
  const value = await gateway.openConfigLocationWithStatus({ kind: 'file' });
  const statusCodec = SETTINGS_DESCRIPTORS.find(row => row.method === 'openConfigLocationWithStatus').result.create();
  assert.deepEqual(statusCodec.parse(value), value);
  assert.equal(value.editor, 'classic');
  assert.equal(value.fallbackReason, 'early-exit');
  const legacy = await gateway.openConfigLocation({ kind: 'file' });
  assert.deepEqual(Object.keys(legacy).sort(), ['displayPath', 'exists', 'kind', 'opened', 'path']);
  assert.equal(legacy.opened, true);
});

test('remote HTTPS and unknown transports cannot launch a host editor', async () => {
  for (const transport of ['https', 'restricted', 'future-transport']) {
    const { gateway } = viewGateway({ transport });
    let launched = false;
    gateway.configOpener = { open: async () => { launched = true; throw new Error('must not launch'); } };
    const result = await gateway.openConfigLocationWithStatus({ kind: 'file' });
    assert.equal(result.opened, false);
    assert.equal(result.copyOnly, true);
    assert.equal(launched, false);
    assert.equal((await gateway.openConfigLocation({ kind: 'folder' })).opened, false);
    await assert.rejects(gateway.openConfigLocationWithStatus({ kind: 'file', path: '/untrusted' }),
      { code: 'SETTINGS_REQUEST_INVALID' });
  }
});

test('preferences are only the plugin-private DSH switches', async () => {
  const stored = { schemaVersion: 1, grokEnabled: false, githubEnabled: false,
    sourceOrder: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
    sourceEnabled: { tavily: true, exa: true, tinyfish: true, firecrawl: true } };
  const { gateway, path } = viewGateway({ preferences: stored });
  // The shared chain lives in config.toml; it no longer leaks into preferences.
  writeFileSync(path, 'source_providers = ["firecrawl"]\ntavily_enabled = false\n');
  const current = await gateway.preferences();
  assert.deepEqual(current.value, { ...stored, githubReadEnabled: false });
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
