import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  COMPATIBILITY_ACKNOWLEDGE_REQUEST, COMPATIBILITY_CONFIRM_REQUEST, COMPATIBILITY_DESCRIPTORS, COMPATIBILITY_REPORT,
  COMPATIBILITY_REMOTE_SERVICE, COMPATIBILITY_NAMESPACE,
} from '../src/core/compatibility-contract.mjs';
import { createCompatibilityState } from '../src/core/compatibility-state.mjs';
import { createCompatibilityGateway, apply, inject } from '../src/compatibility-service.mjs';
import { createConnectionSecurity } from '../src/core/connection-security.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';

const HOST = '0.2.2-alpha.1', PLUGIN = '0.4.0';
const owner = () => ({ peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal });
const loopback = () => ({ socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' }, headers: {} });
const report = (state, extra = {}) => ({
  schemaVersion: 1, hostVersion: state.hostVersion, pluginVersion: state.pluginVersion,
  channel: 'alpha', minimumAdmitted: true, verification: 'unverified',
  phase: state.confirmed ? 'checking' : 'waiting-confirmation',
  revision: state.revision, confirmationRequired: true, confirmed: state.confirmed, notified: state.notified,
  coreReady: false, code: state.errorCode,
  optionalFeatures: {
    settings: { available: false, code: 'SETTINGS_UNAVAILABLE' },
    chat: { available: false, code: 'CHAT_UNAVAILABLE' },
    github: { available: false, code: 'GITHUB_UNAVAILABLE' },
  },
  ...extra,
});

// Explicit unit harness only; production apply imports the actual host classes.
class TestService {
  constructor(ctx, key) { this.ctx = ctx; ctx.provide(key, this); }
}
class TestRemoteError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const Gateway = createCompatibilityGateway({ Service: TestService, RemoteError: TestRemoteError });

function fixture(t) {
  const root = realpathSync(tmpdir()), profileDir = mkdtempSync(join(root, 'dsh-compatibility-service-'));
  const state = createCompatibilityState({ profileDir, hostVersion: HOST, pluginVersion: PLUGIN });
  const security = createConnectionSecurity(), effects = [];
  let confirmations = 0, acknowledgements = 0, rechecks = 0;
  const coordinator = {
    report: () => report(state.snapshot()),
    async recheck() { rechecks++; },
    confirm(request) { confirmations++; return state.confirm(request); },
    acknowledgeNotice(request) { acknowledgements++; return state.markNotified(request); },
  };
  const services = new Map([
    ['grokSearchCompatibility', coordinator], ['grokSearchConnectionSecurity', security],
  ]);
  const ctx = {
    invocation: owner(), get: key => services.get(key), provide: (key, value) => services.set(key, value),
    effect: callback => effects.push(callback()),
  };
  const gateway = new Gateway(ctx);
  t.after(() => {
    for (const effect of effects) effect();
    state.dispose(); security.dispose();
    const target = resolve(profileDir);
    assert.equal(dirname(target), root);
    assert.ok(target.startsWith(root + sep) && target.includes('dsh-compatibility-service-'));
    rmSync(target, { recursive: true, force: true });
  });
  const request = extra => ({
    hostVersion: HOST, pluginVersion: PLUGIN, expectedRevision: state.revision, acceptRisk: true, ...extra,
  });
  const noticeRequest = extra => ({
    hostVersion: HOST, pluginVersion: PLUGIN, expectedRevision: state.revision, ...extra,
  });
  return { profileDir, state, coordinator, security, ctx, gateway, effects, request, noticeRequest,
    confirmations: () => confirmations, acknowledgements: () => acknowledgements, rechecks: () => rechecks };
}

test('additive descriptors have separate schemas, methods and a distinct service but one namespace', () => {
  assert.deepEqual(COMPATIBILITY_DESCRIPTORS.map(row => row.method),
    ['compatibilityReport', 'recheckCompatibility', 'confirmCompatibility', 'acknowledgeCompatibilityNotice']);
  assert.equal(COMPATIBILITY_REMOTE_SERVICE, 'grokSearchCompatibilityRemote');
  assert.equal(COMPATIBILITY_NAMESPACE, 'grokSearchCompatibility');
  for (const descriptor of COMPATIBILITY_DESCRIPTORS) {
    assert.equal(descriptor.service, COMPATIBILITY_REMOTE_SERVICE);
    assert.equal(descriptor.namespace, COMPATIBILITY_NAMESPACE);
    assert.equal(descriptor.invocation.kind, 'direct');
    assert.match(descriptor.result.typeSymbol, /\/compatibility#/);
    const parameters = /^\s*async function\s*\(([^)]*)\)/.exec(Gateway.prototype[descriptor.method].toString())?.[1];
    assert.equal(parameters, descriptor.parameters.map(row => row.name).join(', '));
  }
  assert.deepEqual(inject, ['grokSearchCompatibility', 'grokSearchConnectionSecurity']);
  assert.equal(Gateway.prototype['@deepseek-ai/dsh-typert-protocol/remote-methods'].version, 1);
});

test('recheck RPC requires the owner secure transport and invokes a fresh backend capability probe', async t => {
  const { gateway, security, coordinator, rechecks } = fixture(t);
  await assert.rejects(gateway.recheckCompatibility(), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  assert.equal(rechecks(), 0);
  const value = await security.run(loopback(), null, () => gateway.recheckCompatibility());
  assert.equal(rechecks(), 1);
  assert.deepEqual(value, await gateway.compatibilityReport());
  coordinator.recheck = undefined;
  await security.run(loopback(), null, () =>
    assert.rejects(gateway.recheckCompatibility(), { code: 'COMPATIBILITY_UNAVAILABLE' }));
  assert.equal(rechecks(), 1);
});

test('notice acknowledgement has its own strict request codec and cannot carry risk acceptance', () => {
  const descriptor = COMPATIBILITY_DESCRIPTORS.find(row => row.method === 'acknowledgeCompatibilityNotice');
  assert.equal(descriptor.id, 'dsh-grok-search#grokSearchCompatibilityRemote/acknowledgeCompatibilityNotice');
  assert.equal(descriptor.result, COMPATIBILITY_REPORT);
  assert.equal(descriptor.parameters[0].codec, COMPATIBILITY_ACKNOWLEDGE_REQUEST);
  assert.equal(descriptor.parameters[0].name, 'request');
  assert.equal(descriptor.parameters[0].wire, 'request');
  assert.equal(descriptor.parameters[0].source, 'json');
  assert.notEqual(COMPATIBILITY_ACKNOWLEDGE_REQUEST.typeSymbol, COMPATIBILITY_CONFIRM_REQUEST.typeSymbol);
  const request = { hostVersion: HOST, pluginVersion: PLUGIN, expectedRevision: 'missing' };
  const parser = COMPATIBILITY_ACKNOWLEDGE_REQUEST.create();
  assert.deepEqual(parser.parse(request), request);
  for (const invalid of [
    undefined, null, {}, { ...request, acceptRisk: true }, { ...request, acceptRisk: false },
    { ...request, confirmed: true }, { ...request, notified: true }, { ...request, secure: true },
    { ...request, expectedRevision: null },
  ]) assert.equal(parser.safeParse(invalid).success, false);
});

test('report schema rejects arbitrary fields, raw paths, malformed identity and unrecognized states', () => {
  const parser = COMPATIBILITY_REPORT.create();
  const current = report({ hostVersion: HOST, pluginVersion: PLUGIN, revision: 'missing', confirmed: false, notified: false, errorCode: null });
  assert.deepEqual(parser.parse(current), current);
  for (const value of [
    { ...current, path: 'private-profile' },
    { ...current, code: 'private/path' },
    { ...current, code: 'ERROR\n' },
    { ...current, phase: 'anything' },
    { ...current, hostVersion: 'secret-value' },
    { ...current, verification: 'capability-checked' },
    { ...current, optionalFeatures: { ...current.optionalFeatures, settings: { available: true, code: null, path: 'private' } } },
    { ...current, optionalFeatures: { ...current.optionalFeatures, arbitraryModule: { available: true, code: null } } },
  ]) assert.equal(parser.safeParse(value).success, false);
  assert.equal(COMPATIBILITY_CONFIRM_REQUEST.create().safeParse({
    hostVersion: HOST, pluginVersion: PLUGIN, expectedRevision: 'missing', acceptRisk: true, secure: true,
  }).success, false);
});

test('owner can inspect over restricted transport without a write, while anonymous callers cannot', async t => {
  const { gateway, state, ctx, confirmations, acknowledgements } = fixture(t);
  const before = state.snapshot();
  const first = await gateway.compatibilityReport();
  assert.equal(first.phase, 'waiting-confirmation');
  assert.equal(first.notified, false);
  assert.deepEqual(await gateway.compatibilityReport(), first);
  assert.deepEqual(state.snapshot(), before);
  assert.equal(confirmations(), 0);
  assert.equal(acknowledgements(), 0);
  ctx.invocation = { peer: { principal: { kind: 'agent' } } };
  await assert.rejects(gateway.compatibilityReport(), { code: 'SETTINGS_AUTH_REQUIRED' });
  ctx.invocation = {};
  await assert.rejects(gateway.compatibilityReport(), { code: 'SETTINGS_AUTH_REQUIRED' });
});

test('secure notice acknowledgement persists across store lifetimes without confirming risk', async t => {
  const { profileDir, gateway, state, security, noticeRequest, confirmations, acknowledgements } = fixture(t);
  const before = await gateway.compatibilityReport();
  const saved = await security.run(loopback(), null, () => gateway.acknowledgeCompatibilityNotice(noticeRequest()));
  assert.equal(saved.notified, true);
  assert.equal(saved.confirmed, false);
  assert.equal(saved.confirmationRequired, true);
  assert.equal(saved.phase, 'waiting-confirmation');
  assert.equal(saved.coreReady, false);
  assert.equal(saved.verification, 'unverified');
  assert.notEqual(saved.revision, before.revision);
  assert.equal(confirmations(), 0);
  assert.equal(acknowledgements(), 1);
  const repeated = await security.run(loopback(), null, () => gateway.acknowledgeCompatibilityNotice(noticeRequest()));
  assert.deepEqual(repeated, saved);
  assert.deepEqual(await gateway.compatibilityReport(), saved);
  assert.equal(state.snapshot().revision, saved.revision);
  state.dispose();
  for (const pair of [
    { hostVersion: HOST, pluginVersion: PLUGIN },
    { hostVersion: '0.2.2-alpha.2', pluginVersion: PLUGIN },
    { hostVersion: HOST, pluginVersion: '0.4.1' },
  ]) {
    const reopened = createCompatibilityState({ profileDir, ...pair });
    try {
      assert.equal(reopened.snapshot().notified, pair.hostVersion === HOST && pair.pluginVersion === PLUGIN);
      assert.equal(reopened.snapshot().confirmed, false);
    } finally { reopened.dispose(); }
  }
});

test('notice writes require owner and socket security just like risk confirmation', async t => {
  const { gateway, state, security, ctx, noticeRequest, acknowledgements, confirmations } = fixture(t);
  ctx.invocation.peer.secure = true;
  await assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  for (const transport of [
    { socket: { remoteAddress: '198.51.100.8', localAddress: '10.0.0.1' }, headers: {} },
    { ...loopback(), headers: { 'x-forwarded-for': '127.0.0.1' } },
    { ...loopback(), socket: { remoteAddress: '127.0.0.1', localAddress: '198.51.100.8' } },
  ]) {
    await security.run(transport, null, () =>
      assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' }));
  }
  const tls = { socket: { encrypted: true, remoteAddress: '198.51.100.8', localAddress: '10.0.0.1' }, headers: {} };
  ctx.invocation.peer.principal.kind = 'agent';
  await security.run(tls, null, () =>
    assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), { code: 'SETTINGS_AUTH_REQUIRED' }));
  assert.equal(acknowledgements(), 0);
  assert.equal(state.snapshot().notified, false);
  ctx.invocation.peer.principal.kind = 'owner';
  const saved = await security.run(tls, null, () => gateway.acknowledgeCompatibilityNotice(noticeRequest()));
  assert.equal(saved.notified, true);
  assert.equal(saved.confirmed, false);
  assert.equal(confirmations(), 0);
});

test('notice acknowledgement rejects forged pairs, stale revisions and consent-shaped direct requests', async t => {
  const { gateway, state, security, noticeRequest, request, acknowledgements, confirmations } = fixture(t);
  await security.run(loopback(), null, async () => {
    await assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest({ hostVersion: '0.2.2-beta.1' })),
      { code: 'COMPATIBILITY_PAIR_MISMATCH' });
    await assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest({ pluginVersion: '0.4.1' })),
      { code: 'COMPATIBILITY_PAIR_MISMATCH' });
    for (const invalid of [
      undefined, null, {}, request(), noticeRequest({ acceptRisk: false }),
      noticeRequest({ expectedRevision: null }), noticeRequest({ confirmed: true }),
    ]) await assert.rejects(gateway.acknowledgeCompatibilityNotice(invalid), { code: 'COMPATIBILITY_REQUEST_INVALID' });
    const stale = noticeRequest();
    state.markNotified(stale);
    await assert.rejects(gateway.acknowledgeCompatibilityNotice(stale), { code: 'COMPATIBILITY_CONFLICT' });
  });
  assert.equal(acknowledgements(), 0);
  assert.equal(confirmations(), 0);
  assert.equal(state.snapshot().confirmed, false);
});

test('notice acknowledgement still obeys authoritative CAS when state changes after the report', async t => {
  const { gateway, coordinator, state, security, noticeRequest, confirmations } = fixture(t);
  const original = coordinator.acknowledgeNotice;
  coordinator.acknowledgeNotice = request => {
    state.markNotified(noticeRequest());
    return original(request);
  };
  await security.run(loopback(), null, () =>
    assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), { code: 'COMPATIBILITY_CONFLICT' }));
  assert.equal(state.snapshot().confirmed, false);
  assert.equal(confirmations(), 0);
});

test('missing or failed notice acknowledgement does not change a ready unverified report', async t => {
  const { gateway, coordinator, state, security, noticeRequest, confirmations } = fixture(t);
  coordinator.report = () => report(state.snapshot(), {
    channel: 'rc', confirmationRequired: false, phase: 'ready', coreReady: true,
  });
  const before = await gateway.compatibilityReport();
  coordinator.acknowledgeNotice = undefined;
  await security.run(loopback(), null, () =>
    assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), { code: 'COMPATIBILITY_UNAVAILABLE' }));
  assert.deepEqual(await gateway.compatibilityReport(), before);
  coordinator.acknowledgeNotice = () => {
    throw new GrokSearchError('COMPATIBILITY_STATE_WRITE_FAILED', 'private-path secret-key', { path: 'private-path' });
  };
  await security.run(loopback(), null, () => assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), error => {
    assert.equal(error.code, 'COMPATIBILITY_STATE_WRITE_FAILED');
    assert.doesNotMatch(error.message, /private-path|secret-key/);
    assert.deepEqual(error.details, {});
    return true;
  }));
  assert.deepEqual(await gateway.compatibilityReport(), before);
  assert.equal(state.snapshot().notified, false);
  assert.equal(confirmations(), 0);
});

test('confirmation requires real socket facts rather than a claimed secure field or owner alone', async t => {
  const { gateway, state, security, ctx, request, confirmations } = fixture(t);
  ctx.invocation.peer.secure = true;
  ctx.invocation.peer.isLocal = true;
  await assert.rejects(gateway.confirmCompatibility(request()), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  for (const transport of [
    { socket: { remoteAddress: '198.51.100.8', localAddress: '10.0.0.1' }, headers: {} },
    { ...loopback(), headers: { 'x-forwarded-for': '127.0.0.1' } },
    { ...loopback(), socket: { remoteAddress: '127.0.0.1', localAddress: '198.51.100.8' } },
  ]) {
    await security.run(transport, null, () =>
      assert.rejects(gateway.confirmCompatibility(request()), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' }));
  }
  assert.equal(confirmations(), 0);
  assert.equal(state.snapshot().confirmed, false);
});

test('a secure owner confirms only the trusted server pair without claiming safety or verification', async t => {
  const { gateway, state, security, request } = fixture(t);
  const after = await security.run(loopback(), null, () => gateway.confirmCompatibility(request()));
  assert.equal(after.confirmed, true);
  assert.equal(after.coreReady, false);
  assert.equal(after.verification, 'unverified');
  assert.equal(after.phase, 'checking');
  assert.equal(state.snapshot().confirmed, true);
  assert.deepEqual(after, await gateway.compatibilityReport());
});

test('an encrypted owner connection is accepted while encrypted non-owner calls remain forbidden', async t => {
  const { gateway, security, ctx, request } = fixture(t);
  const tls = { socket: { encrypted: true, remoteAddress: '198.51.100.8', localAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': 'x' } };
  ctx.invocation.peer.principal.kind = 'agent';
  await security.run(tls, null, () => assert.rejects(gateway.confirmCompatibility(request()), { code: 'SETTINGS_AUTH_REQUIRED' }));
  ctx.invocation.peer.principal.kind = 'owner';
  const saved = await security.run(tls, null, () => gateway.confirmCompatibility(request()));
  assert.equal(saved.confirmed, true);
});

test('wrong versions, stale CAS and invalid direct SRC requests cannot reach confirmation', async t => {
  const { gateway, state, security, request, confirmations } = fixture(t);
  await security.run(loopback(), null, async () => {
    await assert.rejects(gateway.confirmCompatibility(request({ hostVersion: '0.2.2-beta.1' })), { code: 'COMPATIBILITY_PAIR_MISMATCH' });
    await assert.rejects(gateway.confirmCompatibility(request({ pluginVersion: '0.4.1' })), { code: 'COMPATIBILITY_PAIR_MISMATCH' });
    const stale = request();
    state.markNotified({ hostVersion: HOST, pluginVersion: PLUGIN, expectedRevision: state.revision });
    await assert.rejects(gateway.confirmCompatibility(stale), { code: 'COMPATIBILITY_CONFLICT' });
    for (const invalid of [undefined, {}, request({ acceptRisk: false }), request({ extra: true }), request({ expectedRevision: null })]) {
      await assert.rejects(gateway.confirmCompatibility(invalid), { code: 'COMPATIBILITY_REQUEST_INVALID' });
    }
  });
  assert.equal(confirmations(), 0);
  assert.equal(state.snapshot().confirmed, false);
});

test('unknown server identity is not replaced by a browser supplied pair', async t => {
  const { gateway, coordinator, security, request, noticeRequest, confirmations, acknowledgements } = fixture(t);
  const original = coordinator.report;
  coordinator.report = () => ({ ...original(), hostVersion: null, channel: 'unknown' });
  await security.run(loopback(), null, () =>
    assert.rejects(gateway.confirmCompatibility(request()), { code: 'COMPATIBILITY_IDENTITY_UNKNOWN' }));
  await security.run(loopback(), null, () =>
    assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), { code: 'COMPATIBILITY_IDENTITY_UNKNOWN' }));
  assert.equal(confirmations(), 0);
  assert.equal(acknowledgements(), 0);
});

test('owner and request cancellation are rechecked after an asynchronous report', async t => {
  for (const [method, makeRequest] of [
    ['confirmCompatibility', 'request'], ['acknowledgeCompatibilityNotice', 'noticeRequest'],
  ]) {
    const context = fixture(t);
    const { gateway, coordinator, security, ctx, confirmations, acknowledgements } = context;
    const original = coordinator.report;
    coordinator.report = async () => {
      const result = original();
      ctx.invocation.peer.principal.kind = 'agent';
      return result;
    };
    await security.run(loopback(), null, () =>
      assert.rejects(gateway[method](context[makeRequest]()), { code: 'SETTINGS_AUTH_REQUIRED' }));
    assert.equal(confirmations(), 0);
    assert.equal(acknowledgements(), 0);
    ctx.invocation = owner();
    const controller = new AbortController();
    ctx.invocation.signal = controller.signal;
    coordinator.report = async () => {
      const result = original();
      controller.abort();
      return result;
    };
    await security.run(loopback(), null, () =>
      assert.rejects(gateway[method](context[makeRequest]()), { name: 'AbortError' }));
    assert.equal(confirmations(), 0);
    assert.equal(acknowledgements(), 0);
  }
});

test('concurrent state changes after the server report are still checked by the authoritative store', async t => {
  const { gateway, coordinator, state, security, request } = fixture(t);
  const original = coordinator.confirm;
  coordinator.confirm = value => {
    state.markNotified({ hostVersion: HOST, pluginVersion: PLUGIN, expectedRevision: state.revision });
    return original(value);
  };
  await security.run(loopback(), null, () =>
    assert.rejects(gateway.confirmCompatibility(request()), { code: 'COMPATIBILITY_CONFLICT' }));
  assert.equal(state.snapshot().confirmed, false);
});

test('RPC does not expose raw error messages, details or paths from a failed coordinator', async t => {
  const { gateway, coordinator } = fixture(t);
  for (const error of [
    new Error('private-path secret-key'),
    new GrokSearchError('COMPATIBILITY_CONFLICT', 'private-path secret-key', { path: 'private-path', key: 'secret-key' }),
    new GrokSearchError('private-path', 'secret-key'),
  ]) {
    coordinator.report = () => { throw error; };
    await assert.rejects(gateway.compatibilityReport(), actual => {
      assert.doesNotMatch(actual.message, /private-path|secret-key/);
      assert.doesNotMatch(actual.code, /private-path|secret-key/);
      assert.deepEqual(actual.details, {});
      return true;
    });
  }
});

test('invalid runtime reports fail separately instead of leaking extras or invoking confirmation', async t => {
  const { gateway, coordinator, security, request, noticeRequest, confirmations, acknowledgements } = fixture(t);
  const original = coordinator.report;
  coordinator.report = () => ({ ...original(), privatePath: 'private-location' });
  await assert.rejects(gateway.compatibilityReport(), { code: 'COMPATIBILITY_REPORT_INVALID' });
  await security.run(loopback(), null, () =>
    assert.rejects(gateway.confirmCompatibility(request()), { code: 'COMPATIBILITY_REPORT_INVALID' }));
  await security.run(loopback(), null, () =>
    assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), { code: 'COMPATIBILITY_REPORT_INVALID' }));
  assert.equal(confirmations(), 0);
  assert.equal(acknowledgements(), 0);
});

test('missing connection security, coordinator or disposed gateway fails closed', async t => {
  const { gateway, request, noticeRequest, effects } = fixture(t);
  const security = gateway.security;
  gateway.security = null;
  await assert.rejects(gateway.compatibilityReport(), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  await assert.rejects(gateway.confirmCompatibility(request()), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  await assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), { code: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  gateway.security = security;
  gateway.coordinator = null;
  await assert.rejects(gateway.compatibilityReport(), { code: 'COMPATIBILITY_UNAVAILABLE' });
  effects[0]();
  await assert.rejects(gateway.compatibilityReport(), { code: 'COMPATIBILITY_UNAVAILABLE' });
  await assert.rejects(gateway.acknowledgeCompatibilityNotice(noticeRequest()), { code: 'COMPATIBILITY_UNAVAILABLE' });
});

test('production apply requires actual peers and never installs a fallback service', async () => {
  let available = true;
  try { import.meta.resolve('@deepseek-ai/cordis'); import.meta.resolve('@deepseek-ai/dsh-typert-protocol'); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') available = false; else throw error; }
  let installed;
  const task = apply({ plugin(Plugin) { installed = Plugin; } });
  if (available) {
    await task;
    const { Service } = await import('@deepseek-ai/cordis');
    assert.equal(Object.getPrototypeOf(installed.prototype), Service.prototype);
  } else {
    await assert.rejects(task, { code: 'ERR_MODULE_NOT_FOUND' });
    assert.equal(installed, undefined);
  }
});
