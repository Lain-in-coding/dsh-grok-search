import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createSettingsGateway, SETTINGS_DESCRIPTORS, inject } from '../src/settings-ui.mjs';
import { SETTINGS_DESCRIPTORS as PURE_SETTINGS_DESCRIPTORS } from '../src/core/settings-contract.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';
import { createSharedConfigStore } from '../src/core/shared-config.mjs';
import { createConnectionSecurity } from '../src/core/connection-security.mjs';
import { createConfigLocationOpener } from '../src/core/config-opener.mjs';
import { createSearchLog } from '../src/core/search-log.mjs';
import { createToolRouteContext } from '../src/core/tool-route-context.mjs';
import { createReleaseBarrier } from '../src/core/release-transaction.mjs';

// Explicit unit fixtures; production apply must resolve the host constructors.
class TestService {
  constructor(ctx, name) { this.ctx = ctx; this.name = name; ctx.provide?.(name, this); }
}
class TestRemoteError extends Error {
  constructor(code, message, details) {
    super(message); this.code = code; this.details = details; this.isDSHRemoteError = true;
  }
}
const Gateway = createSettingsGateway({ Service: TestService, RemoteError: TestRemoteError });

test('settings mounts without resolving optional runtime services', () => {
  assert.deepEqual(inject, ['profileContext', 'grokSearchConnectionSecurity']);
  const directory = mkdtempSync(join(tmpdir(), 'dsh-settings-independent-'));
  const reads = [];
  new Gateway({ get(key) {
    reads.push(key);
    if (key === 'profileContext') return { dir: directory };
    if (key === 'grokSearchConnectionSecurity') return {};
    assert.fail(`Settings construction must not resolve ${key}`);
  }, provide() {} });
  assert.deepEqual(reads, ['profileContext', 'grokSearchConnectionSecurity']);
});

test('settings factory requires explicit constructors and retains the injected error protocol', async () => {
  for (const peers of [undefined, {}, { Service: TestService }, { RemoteError: TestRemoteError },
    { Service: {}, RemoteError: TestRemoteError }]) {
    assert.throws(() => createSettingsGateway(peers), { name: 'TypeError' });
  }
  assert.equal(Object.getPrototypeOf(Gateway.prototype), TestService.prototype);
  const security = createConnectionSecurity();
  try {
    const gateway = new Gateway({ get: key => key === 'grokSearchConnectionSecurity' ? security : null, provide() {} });
    await assert.rejects(gateway.snapshot(), error => error instanceof TestRemoteError
      && error.isDSHRemoteError === true && error.code === 'SETTINGS_AUTH_REQUIRED');
  } finally { security.dispose(); }
});

const peerFixture = (scenario, code) => {
  const service = `export class Service {
    constructor(ctx, key) { this.ctx = ctx; ctx.provide?.(key, this); }
  }`;
  const remoteError = `export class RemoteError extends Error {
    constructor(code, message, details) {
      super(message); this.code = code; this.details = details; this.isDSHRemoteError = true;
    }
  }`;
  const loader = `data:text/javascript,${encodeURIComponent(`
    const scenario = ${JSON.stringify(scenario)};
    export function resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/cordis') {
        if (scenario === 'missing-cordis') {
          throw Object.assign(new Error('Synthetic host dependency unavailable'), { code: 'ERR_MODULE_NOT_FOUND' });
        }
        return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(service)}`)}, shortCircuit: true };
      }
      if (specifier === '@deepseek-ai/dsh-typert-protocol') {
        if (scenario === 'missing-protocol' || scenario === 'failed-protocol') {
          throw Object.assign(new Error('Synthetic protocol import failure'),
            { code: scenario === 'missing-protocol' ? 'ERR_MODULE_NOT_FOUND' : 'HOST_PROTOCOL_FAILED' });
        }
        const source = scenario === 'invalid-protocol' ? 'export const RemoteError = null;' : ${JSON.stringify(remoteError)};
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      }
      return next(specifier, context);
    }
  `)}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { register } from 'node:module';
    register(${JSON.stringify(loader)});
    const { apply, createSettingsGateway, SETTINGS_DESCRIPTORS } =
      await import(${JSON.stringify(new URL('../src/settings-ui.mjs', import.meta.url).href)});
    assert.equal(typeof createSettingsGateway, 'function');
    assert.equal(SETTINGS_DESCRIPTORS.length, 28);
    ${code}
  `], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

test('production settings apply rejects unavailable or malformed peers without registration', async t => {
  for (const scenario of ['missing-cordis', 'missing-protocol', 'failed-protocol', 'invalid-protocol']) {
    await t.test(scenario, () => peerFixture(scenario, `
      let registrations = 0;
      await assert.rejects(apply({ plugin() { registrations++; } }), error =>
        ${JSON.stringify(scenario)} === 'invalid-protocol' ? error instanceof TypeError
          : error.code === (${JSON.stringify(scenario)} === 'failed-protocol' ? 'HOST_PROTOCOL_FAILED' : 'ERR_MODULE_NOT_FOUND'));
      assert.equal(registrations, 0);
    `));
  }
});

test('production settings apply waits for registration and propagates child startup failure', () => {
  peerFixture('available', `
    const { Service } = await import('@deepseek-ai/cordis');
    const { RemoteError } = await import('@deepseek-ai/dsh-typert-protocol');
    let registered, release, entered, settled = false;
    const registration = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const task = apply({ plugin(Plugin) { registered = Plugin; entered(); return pending; } })
      .then(() => { settled = true; });
    await Promise.race([registration, task]);
    assert.ok(registered);
    assert.equal(Object.getPrototypeOf(registered.prototype), Service.prototype);
    assert.equal(settled, false, 'optional availability must wait for child registration');
    release();
    await task;
    assert.equal(settled, true);
    const gateway = new registered({ get() {}, provide() {} });
    await assert.rejects(gateway.snapshot(), error => error instanceof RemoteError && error.isDSHRemoteError === true);
    const failure = new Error('Synthetic gateway startup failure');
    await assert.rejects(apply({ plugin() { return Promise.reject(failure); } }), error => error === failure);
  `);
});

test('production settings apply retains the explicit config path without a program service', () => {
  peerFixture('available', `
    const configPath = process.platform === 'win32' ? 'C:/synthetic-settings/shared.toml' : '/synthetic-settings/shared.toml';
    let registered;
    await apply({ plugin(Plugin) { registered = Plugin; } }, { configPath });
    const gateway = new registered({ get() {}, provide() {} });
    assert.equal(gateway._configPath().replaceAll('\\\\', '/'), configPath);
  `);
});

test('the legacy settings descriptor export shares the pure static contract', () => {
  assert.equal(SETTINGS_DESCRIPTORS, PURE_SETTINGS_DESCRIPTORS);
  assert.equal(SETTINGS_DESCRIPTORS.length, 28);
  const legacy = SETTINGS_DESCRIPTORS.filter(row =>
    !['saveWithIdentity', 'revealWithIdentity', 'restoreConfigWithIdentity'].includes(row.method));
  assert.equal(legacy.length, 25);
  assert.equal(createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
    'a755d8697157ad8437a08f22cdf73eb90dafa33996fca0741c8b15f4fe3deb96');
});

test('identity-aware save rejects an identical file at a changed path before any write', async () => withIsolatedHome(async () => {
  const { gateway, path, directory, services } = viewGateway();
  const other = join(directory, 'other.toml');
  const original = 'grok_model = "before"\n';
  writeFileSync(path, original);
  writeFileSync(other, original);
  const before = await gateway.snapshot();
  services.set('grokSearchProgram', { snapshot: () => ({ configPath: other }) });
  const current = await gateway.snapshot();
  assert.equal(current.config.revision, before.config.revision);
  assert.notEqual(current.config.quotaRevision, before.config.quotaRevision);
  await assert.rejects(gateway.saveWithIdentity({
    expectedRevision: before.config.revision, configIdentity: before.config.quotaRevision, updates: { grok_model: 'after' },
  }), { code: 'CONFIG_CONFLICT' });
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(readFileSync(other, 'utf8'), original);
  assert.equal(existsSync(join(directory, 'grok-search', 'config-history')), false);
}));

test('save and restore never issue undo credentials for an external post-publish edit', async () => withIsolatedHome(async () => {
  const { gateway, path, directory, services } = viewGateway();
  let invalidated = 0;
  services.set('grokSearchGithub', { sync() { throw new Error('optional failure'); }, invalidate() { invalidated++; } });
  gateway.ctx.logger = { warn() { throw new Error('logger failure'); } };
  const original = 'grok_model = "before"\n', external = 'grok_model = "outside"\n';
  writeFileSync(path, original);
  let race = false;
  const store = createSharedConfigStore({ path, historyDirectory: join(directory, 'history'), env: () => ({}),
    fault(stage) { if (race && stage === 'after-publish') writeFileSync(path, external); } });
  gateway._store = () => store;
  const identity = config => ({ expectedRevision: config.revision, configIdentity: config.quotaRevision });
  const before = (await gateway.snapshot()).config;
  const saved = (await gateway.saveWithIdentity({ ...identity(before), updates: { grok_model: 'plugin' } })).config;
  race = true;
  await assert.rejects(gateway.restoreConfigWithIdentity({ ...identity(saved), revision: before.revision }), { code: 'CONFIG_COMMIT_UNCERTAIN' });
  assert.equal(readFileSync(path, 'utf8'), external);
  const current = (await gateway.snapshot()).config;
  await assert.rejects(gateway.saveWithIdentity({ ...identity(current), updates: { grok_model: 'plugin' } }), { code: 'CONFIG_COMMIT_UNCERTAIN' });
  await assert.rejects(gateway.restoreConfigWithIdentity({ ...identity(saved), revision: before.revision }), { code: 'CONFIG_CONFLICT' });
  assert.equal(readFileSync(path, 'utf8'), external);
  assert.equal(invalidated, 2, 'both uncertain writes invalidate stale readers without replacing the original error');
}));

test('optional GitHub sync failure invalidates stale reads and preserves committed RPC results', async () => withIsolatedHome(async () => {
  const { gateway, path, services } = viewGateway();
  const warnings = [], calls = [];
  gateway.ctx.logger = { warn(message) { warnings.push(message); } };
  services.set('grokSearchGithub', { sync() { calls.push('sync'); throw new Error('synthetic-private-detail'); },
    invalidate() { calls.push('invalidate'); } });
  writeFileSync(path, 'github_token = "synthetic-before"\n');
  const before = (await gateway.snapshot()).config;
  const saved = await gateway.saveWithIdentity({ expectedRevision: before.revision, configIdentity: before.quotaRevision,
    updates: { github_token: 'synthetic-after' } });
  const restored = await gateway.restoreConfigWithIdentity({ expectedRevision: saved.config.revision,
    configIdentity: saved.config.quotaRevision, revision: before.revision });
  assert.equal(restored.config.revision, before.revision);
  assert.equal(restored.config.quotaRevision, before.quotaRevision);
  assert.equal(readFileSync(path, 'utf8'), 'github_token = "synthetic-before"\n');
  const prefs = await gateway.preferences();
  const updated = await gateway.savePreferences({ expectedRevision: prefs.revision, value: { ...prefs.value, githubReadEnabled: true } });
  assert.equal(updated.value.githubReadEnabled, true);
  assert.deepEqual(calls, ['sync', 'invalidate', 'sync', 'invalidate', 'sync', 'invalidate']);
  assert.ok(warnings.length > 0);
  assert.doesNotMatch(JSON.stringify(warnings), /synthetic/);
}));

test('identity-aware save rejects a changed effective credential while the file revision stays unchanged', async () => withIsolatedHome(async () => {
  const { gateway, path, directory } = viewGateway();
  const original = 'grok_model = "before"\n';
  writeFileSync(path, original);
  try {
    process.env.TAVILY_API_KEY = 'synthetic-before';
    const before = await gateway.snapshot();
    process.env.TAVILY_API_KEY = 'synthetic-after';
    const current = await gateway.snapshot();
    assert.equal(current.config.revision, before.config.revision);
    assert.notEqual(current.config.quotaRevision, before.config.quotaRevision);
    await assert.rejects(gateway.saveWithIdentity({
      expectedRevision: before.config.revision, configIdentity: before.config.quotaRevision,
      updates: { tavily_api_url: 'https://other.example.invalid' },
    }), { code: 'CONFIG_CONFLICT' });
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(existsSync(join(directory, 'grok-search', 'config-history')), false);
  } finally { delete process.env.TAVILY_API_KEY; }
}));

test('identity-aware save checks the file revision even when only comments changed', async () => withIsolatedHome(async () => {
  const { gateway, path } = viewGateway();
  writeFileSync(path, 'grok_model = "before"\n');
  const before = await gateway.snapshot();
  const changed = '# another writer\n' + readFileSync(path, 'utf8');
  writeFileSync(path, changed);
  const current = await gateway.snapshot();
  assert.equal(current.config.quotaRevision, before.config.quotaRevision);
  assert.notEqual(current.config.revision, before.config.revision);
  await assert.rejects(gateway.saveWithIdentity({
    expectedRevision: before.config.revision, configIdentity: before.config.quotaRevision, updates: { grok_model: 'after' },
  }), { code: 'CONFIG_CONFLICT' });
  assert.equal(readFileSync(path, 'utf8'), changed);
}));

test('identity-aware save returns the redacted saved identity and retains legacy save and reveal behavior', async () => withIsolatedHome(async () => {
  const { gateway, path, services } = viewGateway();
  let synced = 0;
  services.set('grokSearchGithub', { sync() { synced++; } });
  const before = await gateway.snapshot();
  const saved = await gateway.saveWithIdentity({
    expectedRevision: before.config.revision, configIdentity: before.config.quotaRevision,
    updates: { github_token: 'synthetic-only', grok_model: 'after' },
  });
  assert.equal(synced, 1);
  assert.equal(saved.config.path, path);
  assert.equal(saved.config.fields.github_token.value, null);
  assert.equal(saved.config.fields.github_token.configured, true);
  assert.notEqual(saved.config.quotaRevision, before.config.quotaRevision);
  assert.equal(saved.config.quotaRevision, (await gateway.snapshot()).config.quotaRevision);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-only/);
  assert.equal((await gateway.reveal({ key: 'github_token' })).value, 'synthetic-only');
  const legacy = await gateway.save({ expectedRevision: saved.config.revision, updates: { grok_model: 'legacy' } });
  assert.equal(legacy.config.fields.grok_model.value, 'legacy');
}));

test('identity-aware save preserves owner and secret-write gates before resolving configuration', async () => {
  const { gateway } = viewGateway();
  let reads = 0;
  gateway._store = () => { reads++; assert.fail('Denied operations must not read or save'); };
  const request = { expectedRevision: 'missing', configIdentity: 'a'.repeat(64), updates: { grok_model: 'after' } };
  gateway.security = null;
  await assert.rejects(gateway.saveWithIdentity(request), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  gateway.security = {
    requireOwner() {},
    requireSecret() { throw new GrokSearchError('SETTINGS_SECURE_CONNECTION_REQUIRED', 'Synthetic restriction'); },
  };
  for (const updates of [{ grok_api_key: 'synthetic-only' }, { tavily_api_url: 'https://other.example.invalid' }]) {
    await assert.rejects(gateway.saveWithIdentity({ ...request, updates }), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  }
  assert.equal(reads, 0);
});

test('identity-aware reveal and restore reject changed targets before credential reads or history writes', async () => {
  for (const changed of [{ path: '/config-b.toml' }, { credential: 'synthetic-other' }, { revision: 'b'.repeat(64) }]) {
    const { gateway } = viewGateway();
    let target = { path: '/config-a.toml', credential: 'synthetic-viewed', revision: 'a'.repeat(64) };
    let reveals = 0, restores = 0;
    gateway._store = () => ({
      readSnapshot: () => ({ snapshot: { path: target.path, revision: target.revision },
        effective: { grok_api_key: { value: target.credential, source: 'environment', readOnly: true } } }),
      reveal() { reveals++; return { value: target.credential, source: 'environment', readOnly: true }; },
      restore() { restores++; assert.fail('A mismatched target cannot restore history'); },
    });
    const before = await gateway.snapshot();
    target = { ...target, ...changed };
    const request = { expectedRevision: before.config.revision, configIdentity: before.config.quotaRevision };
    await assert.rejects(gateway.revealWithIdentity({ ...request, key: 'grok_api_key' }), { code: 'CONFIG_CONFLICT' });
    await assert.rejects(gateway.restoreConfigWithIdentity({ ...request, revision: 'c'.repeat(64) }), { code: 'CONFIG_CONFLICT' });
    assert.equal(reveals, 0);
    assert.equal(restores, 0);
  }
});

test('identity-aware reveal and restore use the captured store while legacy endpoints keep their schemas', async () => withIsolatedHome(async () => {
  const { gateway, path } = viewGateway();
  writeFileSync(path, 'grok_model = "before"\ngrok_api_key = "synthetic-before"\n');
  const before = await gateway.snapshot();
  const saved = await gateway.saveWithIdentity({
    expectedRevision: before.config.revision, configIdentity: before.config.quotaRevision, updates: { grok_model: 'after' },
  });
  const request = { expectedRevision: saved.config.revision, configIdentity: saved.config.quotaRevision };
  const revealed = await gateway.revealWithIdentity({ ...request, key: 'grok_api_key' });
  assert.equal(revealed.value, 'synthetic-before');
  assert.equal(revealed.source, 'file');
  assert.equal(revealed.readOnly, false);
  const restored = await gateway.restoreConfigWithIdentity({ ...request, revision: before.config.revision });
  assert.equal(restored.config.fields.grok_model.value, 'before');
  assert.equal(restored.config.quotaRevision, (await gateway.snapshot()).config.quotaRevision);
  assert.equal(restored.config.fields.grok_api_key.value, null);
  assert.equal((await gateway.reveal({ key: 'grok_api_key' })).value, 'synthetic-before');
  await assert.rejects(gateway.revealWithIdentity({ ...request, key: 'grok_api_key' }), { code: 'CONFIG_CONFLICT' });
  await assert.rejects(gateway.restoreConfigWithIdentity({ ...request, revision: before.config.revision }), { code: 'CONFIG_CONFLICT' });
}));

test('identity-aware reveal and restore retain secure owner gates before reading configuration', async () => {
  const { gateway } = viewGateway();
  let reads = 0;
  gateway._store = () => { reads++; assert.fail('Denied operations must not resolve a target'); };
  const request = { expectedRevision: 'missing', configIdentity: 'a'.repeat(64) };
  const operations = [['revealWithIdentity', { ...request, key: 'grok_api_key' }],
    ['restoreConfigWithIdentity', { ...request, revision: 'b'.repeat(64) }]];
  gateway.security = null;
  for (const [method, value] of operations) {
    await assert.rejects(gateway[method](value), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  }
  gateway.security = {
    requireOwner() {},
    requireSecret() { throw new GrokSearchError('SETTINGS_SECURE_CONNECTION_REQUIRED', 'Synthetic restriction'); },
  };
  for (const [method, value] of operations) {
    await assert.rejects(gateway[method](value), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  }
  assert.equal(reads, 0);
});

test('settings gateway reads shared config, saves with CAS and keeps secrets out of snapshot', async () => {
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
  let deny = false, repairs = 0;
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
  const { gateway, services } = viewGateway();
  gateway.security = null;
  let effects = 0;
  gateway._store = () => { effects++; throw new Error('must not read or save'); };
  gateway.preferenceStore = { snapshot() { effects++; }, save() { effects++; } };
  services.set('grokSearchProgram', { prepare() { effects++; }, repair() { effects++; } });
  services.set('grokSearchControl', { stop() { effects++; } });
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
  const { gateway, services } = viewGateway({ core: { searchLog: log } });
  services.set('grokSearchCallRoutes', routes);
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
  const { gateway, services } = viewGateway();
  services.set('grokSearchCallRoutes', routes);
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

function diagnosticGateway({ core = {}, sourceRouter = {}, preferences, github = null, compatibility,
  services = new Map(), effect } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-settings-diagnose-'));
  if (preferences) {
    mkdirSync(join(directory, 'grok-search'), { recursive: true });
    writeFileSync(join(directory, 'grok-search', 'preferences.json'), JSON.stringify(preferences));
  }
  for (const [key, value] of [
    ['grokSearchProgram', { snapshot: () => ({ configPath: join(directory, 'config.toml') }) }],
    ['grokSearchCore', core],
    ['grokSearchSourceRouter', sourceRouter],
    ['grokSearchGithub', github],
    ['grokSearchCompatibility', compatibility],
    ['grokSearchConnectionSecurity', { requireOwner() {}, requireSecret() {},
      capabilities: () => ({ secretsAllowed: true, transport: 'loopback', reason: null }) }],
  ]) if (!services.has(key)) services.set(key, value);
  return new Gateway({ profileContext: { dir: directory }, get: name => services.get(name),
    provide: () => {}, effect });
}

test('settings operations use actual dependencies without the runtime compatibility preflight', async () => {
  const calls = [];
  const result = { sources: [{ url: 'https://synthetic.test' }], search_provider: 'tavily' };
  const gateway = diagnosticGateway({
    compatibility: { assertSearchAllowed() { assert.fail('Obsolete runtime preflight must not run'); } },
    core: { testGrok: async () => { calls.push('grok'); return result; },
      testSearch: async () => { calls.push('search'); return result; }, releaseBarrier: createReleaseBarrier() },
    sourceRouter: { diagnose: async () => { calls.push('all'); return []; },
      diagnoseProvider: async provider => { calls.push(provider); return { provider, status: 'ok' }; },
      search() { assert.fail('A successful core test must not dispatch another search'); } },
    github: { test: async () => { calls.push('github'); return { provider: 'github', status: 'ok' }; }, sync() {} },
  });
  const preferences = await gateway.preferences();
  await gateway.savePreferences({ expectedRevision: preferences.revision, value: { ...preferences.value, githubReadEnabled: true } });
  const snapshot = await gateway.snapshot();
  const requests = [
    () => gateway.diagnose(),
    () => gateway.diagnoseProvider({ provider: 'tavily' }),
    () => gateway.diagnoseProvider({ provider: 'grok' }),
    () => gateway.diagnoseProvider({ provider: 'github' }),
    () => gateway.previewGithubConnection({ expectedRevision: snapshot.config.revision,
      configIdentity: snapshot.config.quotaRevision, operationId: randomUUID() }),
    () => gateway.testSearch({ query: 'synthetic test' }),
  ];
  for (const request of requests) await request();
  assert.deepEqual(calls, ['all', 'tavily', 'grok', 'github', 'github', 'search']);
  assert.equal(gateway.diagnostics.size, 0);
});

test('removing runtime preflight retains owner checks and actual operation errors', async () => {
  let requests = 0;
  const gateway = diagnosticGateway({ core: {
    testSearch: async () => { throw new GrokSearchError('GROK_SEARCH_STOPPING', 'Stopping.'); },
  }, sourceRouter: {
    diagnose: async () => { requests++; return []; },
    search: async () => { assert.fail('A real core error must not trigger another source'); },
  } });
  assert.deepEqual(await gateway.diagnose(), []);
  await assert.rejects(gateway.testSearch({ query: 'synthetic test' }), { code: 'GROK_SEARCH_STOPPING' });
  gateway.security.requireOwner = () => { throw new GrokSearchError('SETTINGS_AUTH_REQUIRED', 'Denied.'); };
  await assert.rejects(gateway.diagnose(), { code: 'SETTINGS_AUTH_REQUIRED' });
  assert.equal(requests, 1);
});

test('missing runtime operations fail explicitly without consulting official search', async () => {
  const gateway = diagnosticGateway({ core: null, sourceRouter: null });
  const get = gateway.ctx.get;
  gateway.ctx.get = key => {
    if (key === 'web') assert.fail('Settings must never use official search as a fallback');
    return get(key);
  };
  await assert.rejects(gateway.diagnose(), { code: 'SOURCE_UNAVAILABLE' });
  await assert.rejects(gateway.diagnoseProvider({ provider: 'exa' }), { code: 'SOURCE_UNAVAILABLE' });
  await assert.rejects(gateway.diagnoseProvider({ provider: 'grok' }), { code: 'GROK_UNAVAILABLE' });
  await assert.rejects(gateway.testSearch({ query: 'synthetic test' }), { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(gateway.diagnostics.size, 0);
});

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
  const services = new Map();
  const gateway = diagnosticGateway({ services, sourceRouter: {
    diagnoseProvider: async provider => {
      const next = join(gateway.profileContext.dir, 'other.toml');
      services.set('grokSearchProgram', { snapshot: () => ({ configPath: next }) });
      return { provider, status: 'ok', code: 'OK', message: 'ok' };
    },
  } });
  await assert.rejects(gateway.diagnoseProvider({ provider: 'tavily' }), { code: 'CONFIG_CONFLICT' });
});

test('legacy full diagnosis rejects results from a configuration replaced during the request', async () => {
  for (const changedPath of [false, true]) {
    const services = new Map();
    const gateway = diagnosticGateway({ services, sourceRouter: {
      diagnose: async () => {
        const path = join(gateway.profileContext.dir, changedPath ? 'other.toml' : 'config.toml');
        if (changedPath) services.set('grokSearchProgram', { snapshot: () => ({ configPath: path }) });
        else writeFileSync(path, 'grok_model = "changed-during-diagnosis"\n');
        return [{ provider: 'exa', ok: true, status: 'ok', code: 'OK', message: 'ok' }];
      },
    } });
    await assert.rejects(gateway.diagnose(), { code: 'CONFIG_CONFLICT' });
    assert.equal(gateway.diagnostics.size, 0);
  }
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
  const releaseBarrier = createReleaseBarrier();
  releaseBarrier.invalidate({ reason: 'test-stop' });
  const gateway = diagnosticGateway({ core: { releaseBarrier },
    sourceRouter: { diagnoseProvider: async () => { count++; } } });
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
  const releaseBarrier = createReleaseBarrier();
  releaseBarrier.invalidate({ reason: 'test-stop' });
  const gateway = diagnosticGateway({ core: { releaseBarrier },
    sourceRouter: { diagnose: async () => { calls++; return []; } } });
  await assert.rejects(gateway.diagnose(), { code: 'GROK_SEARCH_STOPPING' });
  assert.equal(calls, 0);
  assert.equal(gateway.diagnostics.size, 0);
});

test('diagnostics capture their core generation, drain its barrier and unregister cancellation', async () => {
  const services = new Map();
  const completions = [];
  const makeCore = () => {
    const cancellations = new Set(), releaseBarrier = createReleaseBarrier();
    return { cancellations, releaseBarrier,
      registerDiagnosticCancellation(cancel) {
        cancellations.add(cancel);
        return () => cancellations.delete(cancel);
      },
    };
  };
  const oldCore = makeCore(), nextCore = makeCore();
  const gateway = diagnosticGateway({ core: null, services, sourceRouter: {
    diagnoseProvider: (provider, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      completions.push(() => resolve({ provider, status: 'ok' }));
    }),
  } });
  services.set('grokSearchCore', oldCore);
  const oldId = randomUUID();
  const oldTask = gateway.diagnoseProvider({ provider: 'tavily', operationId: oldId });
  const oldRejected = assert.rejects(oldTask, { code: 'SETTINGS_DIAGNOSIS_CANCELLED' });
  assert.deepEqual(oldCore.releaseBarrier.snapshot().activeOperationIds, [oldId]);
  assert.equal(oldCore.cancellations.size, 1);

  services.set('grokSearchCore', nextCore);
  const nextId = randomUUID();
  const nextTask = gateway.diagnoseProvider({ provider: 'exa', operationId: nextId });
  assert.equal(nextCore.cancellations.size, 1);
  const oldBarrier = oldCore.releaseBarrier;
  oldCore.releaseBarrier = nextCore.releaseBarrier;
  oldBarrier.invalidate({ reason: 'replace-core' });
  for (const cancel of oldCore.cancellations) cancel();
  await oldRejected;
  await oldBarrier.drain();
  assert.equal(oldCore.cancellations.size, 0);
  assert.deepEqual(nextCore.releaseBarrier.snapshot().activeOperationIds, [nextId]);
  assert.equal(nextCore.cancellations.size, 1, 'old cancellation must not abort the new operation');
  completions[1]();
  assert.equal((await nextTask).status, 'ok');
  assert.deepEqual(nextCore.releaseBarrier.snapshot().activeOperationIds, []);
  assert.equal(nextCore.cancellations.size, 0);
  assert.equal(gateway.diagnostics.size, 0);
});

test('settings disposal cancels work even when no core supplied a cancellation registry', async () => {
  let dispose, aborted = false;
  const gateway = diagnosticGateway({ core: null, effect: setup => { dispose = setup(); }, sourceRouter: {
    diagnoseProvider: (provider, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  } });
  const task = gateway.diagnoseProvider({ provider: 'exa' });
  const rejected = assert.rejects(task, { code: 'SETTINGS_DIAGNOSIS_CANCELLED' });
  dispose();
  await rejected;
  assert.equal(aborted, true);
  assert.equal(gateway.diagnostics.size, 0);
});

test('settings disposal cancels a test search with or without the optional core', async () => {
  for (const withCore of [false, true]) {
    let dispose, observedSignal, complete;
    const search = (_request, signal) => {
      observedSignal = signal;
      return new Promise((resolve, reject) => {
        complete = resolve;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const gateway = diagnosticGateway({
      core: withCore ? { testSearch: search } : null,
      sourceRouter: { search: request => search(request, request.signal) },
      effect: setup => { dispose = setup(); },
    });
    const task = gateway.testSearch({ query: 'offline lifecycle probe' });
    const rejection = assert.rejects(task, { code: 'SETTINGS_DIAGNOSIS_CANCELLED' });
    dispose();
    if (!observedSignal?.aborted) complete({ sources: [], search_provider: 'tavily' });
    await rejection;
    assert.equal(observedSignal?.aborted, true, 'The admitted search must be cancelled when its settings owner leaves.');
    assert.equal(gateway.diagnostics.size, 0);
  }
});

test('a disposed settings gateway rejects old references before reading or mutating dependencies', async () => {
  let dispose;
  const gateway = diagnosticGateway({ effect: setup => { dispose = setup(); } });
  gateway._store = () => { assert.fail('Disposed settings must not open configuration'); };
  gateway.preferenceStore = {
    snapshot() { assert.fail('Disposed settings must not read preferences'); },
    save() { assert.fail('Disposed settings must not write preferences'); },
  };
  dispose();
  for (const operation of [() => gateway.snapshot(), () => gateway.preferences(),
    () => gateway.savePreferences({ expectedRevision: 'missing', value: { grokEnabled: false } })]) {
    await assert.rejects(operation(), { code: 'SETTINGS_UNAVAILABLE' });
  }
});

test('settings disposal rejects a pending program response even while root security remains alive', async () => {
  let dispose, complete;
  const services = new Map([['grokSearchProgram', {
    prepare: () => new Promise(resolve => { complete = resolve; }),
  }]]);
  const gateway = diagnosticGateway({ services, effect: setup => { dispose = setup(); } });
  const task = gateway.prepareProgram();
  dispose();
  complete({ phase: 'ready' });
  await assert.rejects(task, { code: 'SETTINGS_UNAVAILABLE' });
});

test('a settings secret response rechecks owner authorization before leaving the RPC boundary', async () => {
  let owner = true;
  const services = new Map([['grokSearchConnectionSecurity', {
    requireOwner() {
      if (!owner) throw new GrokSearchError('SETTINGS_AUTH_REQUIRED', 'Synthetic owner revoked');
    },
    requireSecret() {},
  }]]);
  const gateway = diagnosticGateway({ services });
  gateway._store = () => ({ reveal: () => ({ value: 'synthetic-private-value', source: 'file', readOnly: false }) });
  const task = gateway.reveal({ key: 'grok_api_key' });
  owner = false;
  await assert.rejects(task, error => error.code === 'SETTINGS_AUTH_REQUIRED'
    && !JSON.stringify(error).includes('synthetic-private-value'));
});

test('unexpected diagnostic dependency errors fail rather than becoming a stopping result', async () => {
  let unregistered = 0, dispatched = 0;
  const gateway = diagnosticGateway({ core: {
    registerDiagnosticCancellation() { return () => { unregistered++; }; },
    releaseBarrier: { begin() { throw new Error('synthetic unexpected failure'); } },
  }, sourceRouter: { diagnoseProvider() { dispatched++; } } });
  await assert.rejects(gateway.diagnoseProvider({ provider: 'exa' }), { code: 'SETTINGS_OPERATION_FAILED' });
  assert.equal(unregistered, 1);
  assert.equal(dispatched, 0);
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

function viewGateway({ configPath, settingsConfigPath, transport = 'loopback', core = {}, configuration,
  preferences, withProgram = true } = {}) {
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
  const Settings = settingsConfigPath === undefined ? Gateway
    : createSettingsGateway({ Service: TestService, RemoteError: TestRemoteError, configPath: settingsConfigPath });
  const gateway = new Settings({ profileContext: { dir: directory }, get: name => services.get(name), provide: () => {} });
  return { gateway, directory, path, services };
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

test('explicit settings config path survives missing, pending and removed program services without writing defaults', async () => withIsolatedHome(async home => {
  const customPath = join(home, 'custom-shared.toml');
  const defaultDirectory = join(home, '.config', 'grok-search-rs');
  const defaultPath = join(defaultDirectory, 'config.toml');
  const defaultText = 'grok_model = "untouched-default"\n';
  mkdirSync(defaultDirectory, { recursive: true });
  writeFileSync(defaultPath, defaultText);
  writeFileSync(customPath, 'grok_model = "custom-original"\n');
  const { gateway, services } = viewGateway({ settingsConfigPath: customPath, core: null, withProgram: false });
  for (const phase of ['missing', 'pending', 'ready', 'removed']) {
    if (phase === 'pending' || phase === 'ready') {
      services.set('grokSearchProgram', { snapshot: () => ({
        phase: phase === 'pending' ? 'discovering' : 'ready', configPath: phase === 'pending' ? null : customPath,
        program: null, error: null, configuration: { configPath: true, executable: false },
      }) });
    } else services.delete('grokSearchProgram');
    const snapshot = await gateway.snapshot();
    assert.equal(snapshot.config.path, customPath, phase);
    assert.equal(snapshot.plugin.configSource, 'plugin', phase);
    assert.equal(snapshot.plugin.programConfigured, false, phase);
    assert.equal(snapshot.config.error, null, phase);
    const saved = await gateway.save({ expectedRevision: snapshot.config.revision, updates: { grok_model: `custom-${phase}` } });
    assert.equal(saved.config.path, customPath, phase);
    assert.match(readFileSync(customPath, 'utf8'), new RegExp(`custom-${phase}`), phase);
    assert.equal(readFileSync(defaultPath, 'utf8'), defaultText, phase);
  }
}));

test('empty settings config override preserves environment and default path precedence', async () => withIsolatedHome(async home => {
  const { gateway } = viewGateway({ settingsConfigPath: '', core: null, withProgram: false });
  const first = await gateway.snapshot();
  assert.equal(first.config.path, join(home, '.config', 'grok-search-rs', 'config.toml'));
  assert.equal(first.plugin.configSource, 'default');
  const environmentPath = join(home, 'environment-shared.toml');
  process.env.GROK_SEARCH_CONFIG = environmentPath;
  try {
    const next = await gateway.snapshot();
    assert.equal(next.config.path, environmentPath);
    assert.equal(next.plugin.configSource, 'environment');
  } finally { delete process.env.GROK_SEARCH_CONFIG; }
}));

test('invalid explicit settings paths fail without falling back or writing another config', async () => withIsolatedHome(async home => {
  const environmentPath = join(home, 'environment-shared.toml');
  process.env.GROK_SEARCH_CONFIG = environmentPath;
  try {
    for (const settingsConfigPath of ['relative/shared.toml', join(home, 'invalid\0.toml')]) {
      const { gateway } = viewGateway({ settingsConfigPath, core: null, withProgram: false });
      const snapshot = await gateway.snapshot();
      assert.equal(snapshot.config.error?.code, 'CONFIG_PATH_INVALID');
      assert.equal(snapshot.config.path, '');
      assert.equal(snapshot.plugin.configSource, 'plugin');
      await assert.rejects(gateway.save({ expectedRevision: 'missing', updates: { grok_model: 'must-not-save' } }),
        { code: 'CONFIG_PATH_INVALID' });
    }
    assert.equal(existsSync(environmentPath), false);
    assert.equal(existsSync(join(home, '.config', 'grok-search-rs', 'config.toml')), false);
  } finally { delete process.env.GROK_SEARCH_CONFIG; }
}));

test('core absence leaves config, preferences, history and independent logs available', async () => withIsolatedHome(async () => {
  const { gateway, services } = viewGateway({ core: null, withProgram: false });
  services.delete('grokSearchSourceRouter');
  const before = await gateway.snapshot();
  assert.equal(before.program, null);
  assert.equal(before.control.error.code, 'CONTROL_SETTINGS_UNAVAILABLE');
  assert.deepEqual(snapshotCodec().parse(before), before);
  const saved = await gateway.save({ expectedRevision: before.config.revision, updates: {
    grok_api_key: 'synthetic-only', grok_model: 'first-model',
  } });
  assert.equal((await gateway.reveal({ key: 'grok_api_key' })).value, 'synthetic-only');
  const changed = await gateway.save({ expectedRevision: saved.config.revision, updates: { grok_model: 'second-model' } });
  const restored = await gateway.restoreConfig({ expectedRevision: changed.config.revision, revision: saved.config.revision });
  assert.equal(restored.config.fields.grok_model.value, 'first-model');
  const preferences = await gateway.preferences();
  const updated = await gateway.savePreferences({ expectedRevision: preferences.revision,
    value: { ...preferences.value, grokEnabled: false } });
  assert.equal(updated.value.grokEnabled, false);
  const log = createSearchLog();
  services.set('grokSearchLog', log);
  try {
    const { sessionId } = await gateway.openSearchLog();
    const token = log.begin('synthetic local history');
    log.finish(token, { outcome: 'ok', served: 'tavily' });
    assert.equal((await gateway.readSearchLog({ sessionId })).records.length, 1);
    assert.deepEqual(await gateway.clearSearchLog({ sessionId }), { records: [] });
    await gateway.closeSearchLog({ sessionId });
  } finally { log.dispose(); }
  for (const method of ['prepareProgram', 'repairProgram']) {
    await assert.rejects(gateway[method](), { code: 'GROK_PROGRAM_UNAVAILABLE' });
  }
  await assert.rejects(gateway.stop(), { code: 'CONTROL_SETTINGS_UNAVAILABLE' });
}));

test('the same settings instance sees runtime services appearing and disappearing', async () => withIsolatedHome(async () => {
  const { gateway, services, path } = viewGateway({ core: null, withProgram: false });
  const initial = await gateway.snapshot();
  let prepared = 0, searches = 0, stopped = 0;
  const program = { phase: 'ready', program: { version: '0.1.26', source: 'private-cache' },
    configPath: path, error: null, configuration: { executable: false, configPath: true } };
  services.set('grokSearchProgram', { snapshot: () => program, prepare: async () => { prepared++; return program; } });
  services.set('grokSearchControl', {
    publicSnapshot: () => ({ ...initial.control, available: true, phase: 'required', error: null }),
    stop: async () => { stopped++; return { kind: 'released' }; },
  });
  services.set('grokSearchCore', { budgetMs: 15000, testSearch: async () => {
    searches++;
    return { sources: [{ url: 'https://synthetic.test' }], search_provider: 'tavily' };
  } });
  services.set('grokSearchSourceRouter', { diagnose: async () => [{ provider: 'exa', status: 'ok' }] });
  assert.equal((await gateway.snapshot()).program.configPath, path);
  assert.equal((await gateway.snapshot()).plugin.budgetMs, 15000);
  assert.equal((await gateway.snapshot()).control.available, true);
  assert.equal((await gateway.prepareProgram()).phase, 'ready');
  assert.equal((await gateway.testSearch({ query: 'synthetic test' })).provider, 'tavily');
  assert.equal((await gateway.diagnose())[0].provider, 'exa');
  await gateway.stop();
  assert.deepEqual([prepared, searches, stopped], [1, 1, 1]);
  for (const key of ['grokSearchCore', 'grokSearchSourceRouter', 'grokSearchControl', 'grokSearchProgram']) services.delete(key);
  assert.equal((await gateway.snapshot()).program, null);
  assert.equal((await gateway.snapshot()).control.available, false);
  await assert.rejects(gateway.testSearch({ query: 'synthetic test' }), { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(searches, 1);
}));

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

test('internal primary failure evidence cannot invalidate the legacy settings snapshot codec', async () => withIsolatedHome(async () => {
  const evidence = { schemaVersion: 1, provider: 'grok', protocol: 'chat_completions', stage: 'response',
    reason: 'model_not_found', httpStatus: 404, upstreamCode: 'model_not_found', evidence: 'primary-request' };
  const route = { at: 1, origin: 'search', outcome: 'ok', served: 'tavily', grokCode: 'HTTP_404',
    fallbackUsed: true, failures: [], primaryFailure: evidence };
  const { gateway } = viewGateway({ core: { routeSnapshot: () => route } });
  const snapshot = await gateway.snapshot();
  assert.deepEqual(snapshotCodec().parse(snapshot), snapshot);
  assert.equal(snapshot.route.grokCode, 'HTTP_404');
  assert.equal(snapshot.route.served, 'tavily');
  assert.equal(snapshot.route.primaryFailure, undefined, 'Internal evidence must not widen the cached legacy wire contract.');
  assert.deepEqual(route.primaryFailure, evidence, 'Redaction must not mutate the core route receipt.');
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

test('restoreConfigWithIdentity syncs GitHub credential state and rejects concurrent identity drift', async () => withIsolatedHome(async () => {
  const { gateway, path, services } = viewGateway();
  let githubSynced = 0;
  services.set('grokSearchGithub', { sync() { githubSynced++; } });
  writeFileSync(path, 'github_token = "synthetic-initial"\ngrok_model = "before"\n');
  const initial = await gateway.snapshot();
  const saved = await gateway.saveWithIdentity({
    expectedRevision: initial.config.revision,
    configIdentity: initial.config.quotaRevision,
    updates: { github_token: 'synthetic-updated', grok_model: 'after' },
  });
  assert.equal(githubSynced, 1);

  // External credential drift invalidates restoreConfigWithIdentity before writing.
  process.env.TAVILY_API_KEY = 'synthetic-drift';
  try {
    await assert.rejects(gateway.restoreConfigWithIdentity({
      revision: initial.config.revision,
      expectedRevision: saved.config.revision,
      configIdentity: saved.config.quotaRevision,
    }), { code: 'CONFIG_CONFLICT' });
  } finally {
    delete process.env.TAVILY_API_KEY;
  }
  assert.equal(githubSynced, 1);

  const restored = await gateway.restoreConfigWithIdentity({
    revision: initial.config.revision,
    expectedRevision: saved.config.revision,
    configIdentity: saved.config.quotaRevision,
  });
  assert.equal(githubSynced, 2, 'restoring config must immediately sync GitHub token/cursor state');
  assert.equal(restored.config.fields.grok_model.value, 'before');
}));


test('Grok diagnosis retains safe original Responses error through the settings gateway', async () => {
  const details = { schemaVersion: 1, provider: 'grok', protocol: 'responses', stage: 'response',
    httpStatus: 404, upstreamCode: 'model_not_found', reason: 'model_not_found', evidence: 'primary-request' };
  for (const fallback of [false, true]) {
    const gateway = diagnosticGateway({ core: { testGrok: async () => {
      if (fallback) return { sources: [{ url: 'https://example.com' }], diagnostic: {
        fallbackUsed: true, fallbackReason: 'grok_provider_error', primaryFailure: details } };
      throw new GrokSearchError('HTTP_404', 'untrusted raw upstream body', details);
    } } });
    const result = await gateway.diagnoseProvider({ provider: 'grok' });
    assert.equal(result.code, 'HTTP_404');
    assert.equal(result.httpStatus, 404);
    assert.equal(result.evidence, 'primary-request');
    assert.match(result.message, /模型或路由不存在/);
    assert.doesNotMatch(result.message, /untrusted|接口路径/);
    assert.deepEqual(result.primaryFailure, details);
  }
});

test('Grok diagnosis never labels unvalidated error details as a doctor or primary request', async () => {
  const gateway = diagnosticGateway({ core: { testGrok: async () => {
    throw new GrokSearchError('HTTP_422', 'secret upstream text', { httpStatus: 422, evidence: 'primary-request',
      reason: 'model_not_found', secret: 'do not expose' });
  } } });
  const result = await gateway.diagnoseProvider({ provider: 'grok' });
  assert.equal(result.code, 'HTTP_422');
  assert.equal(result.primaryFailure, undefined);
  assert.equal(result.evidence, undefined);
  assert.doesNotMatch(JSON.stringify(result), /secret upstream|do not expose/);
});
