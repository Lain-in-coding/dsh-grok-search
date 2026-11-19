import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempTracked } from './helpers/temp-fixture.mjs';
import { apply as applyControl } from '../src/control.mjs';
import { ControlRecordError } from '../src/core/control-intent-store.mjs';
import { createSettingsGateway, SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';
import { joinSentences } from '../src/ui/route-form.mjs';

class TestService {
  constructor(ctx) { this.ctx = ctx; }
}
class TestRemoteError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const Gateway = createSettingsGateway({ Service: TestService, RemoteError: TestRemoteError });

function gateway(control, authorize = () => {}) {
  const instance = new Gateway({ provide() {}, get: name => name === 'grokSearchControl' ? control
    : name === 'grokSearchConnectionSecurity' ? { requireOwner: authorize } : null });
  // Dispatch-only tests can use a sentinel result.
  instance.snapshot = async () => ({ control: 'current' });
  return instance;
}

test('release retry is additive and does not change strict legacy snapshot/stop codecs', async () => {
  const descriptor = SETTINGS_DESCRIPTORS.find(row => row.method === 'retryControlRelease');
  assert.equal(descriptor.parameters.length, 0);
  assert.deepEqual(descriptor.result.jsonSchema,
    SETTINGS_DESCRIPTORS.find(row => row.method === 'snapshot').result.jsonSchema);
  let retries = 0, stops = 0;
  const instance = gateway({ retryRelease: async () => { retries++; }, stop: () => { stops++; } });
  assert.deepEqual(await instance.retryControlRelease(), { control: 'current' });
  assert.equal(retries, 1);
  assert.equal(stops, 0);
});

test('legacy owner without retry support is only observed; no new stop intent', async () => {
  let stops = 0;
  assert.deepEqual(await gateway({ stop() { stops++; } }).retryControlRelease(), { control: 'current' });
  assert.equal(stops, 0);
});

for (const method of ['snapshot', 'retryControlRelease']) {
  for (const retriable of [true, false]) test(`${method} encodes a real control error with internal retriable=${retriable}`, async () => {
    const dir = mkdtempTracked(join(tmpdir(), 'dsh-control-rpc-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-grok-search'] } } }));
    const fault = new ControlRecordError(retriable ? 'CONTROL_STORAGE_BUSY' : 'CONTROL_RECORD_INVALID', 'Cannot read control intent.', { retriable });
    const services = new Map([['grokSearchConnectionSecurity', { requireOwner() {},
      capabilities: () => ({ secretsAllowed: false, transport: 'restricted', reason: null }) }]]);
    const disposers = [];
    const ctx = { profileContext: { dir }, get: key => services.get(key), provide: (key, value) => services.set(key, value),
      inject: (keys, run) => keys.includes('web') ? run(ctx) : undefined,
      on() {}, effect: factory => disposers.push(factory()) };
    try {
      await applyControl(ctx, { store: { read() { throw fault; }, readView() { return null; } }, keepAliveOnFailure: true });
      const Settings = createSettingsGateway({ Service: TestService, RemoteError: TestRemoteError, configPath: join(dir, 'config.toml') });
      const result = await new Settings(ctx)[method]();
      const codec = SETTINGS_DESCRIPTORS.find(row => row.method === method).result.create();
      assert.equal(codec.safeParse(result).success, true);
      const error = { code: fault.code, message: fault.message };
      assert.deepEqual(result.control.error, error);
      assert.deepEqual(result.error, error);
      assert.deepEqual(ctx.get('grokSearchControl').snapshot().error, { ...error, retriable });
      assert.equal(codec.safeParse({ ...result, error: { ...error, retriable } }).success, false);
      assert.equal(codec.safeParse({ ...result, control: { ...result.control, error: { ...error, retriable } } }).success, false);
    } finally { for (const dispose of disposers.reverse()) await dispose(); }
  });
}

test('release failure keeps its diagnostic code without exposing raw host error details', async () => {
  const instance = gateway({
    retryRelease: async () => { throw new Error('private path and host details'); },
    publicSnapshot: () => ({ error: { code: 'CONTROL_ROUTE_COUNTER_REQUIRED' } }),
  });
  await assert.rejects(instance.retryControlRelease(), error =>
    error.code === 'CONTROL_ROUTE_COUNTER_REQUIRED' && !error.message.includes('private path'));
});

test('release retry respects owner cancellation before and after the awaited operation', async () => {
  let retries = 0, revoked = true;
  const authorize = () => { if (revoked) throw new GrokSearchError('SETTINGS_AUTH_REQUIRED', 'owner denied'); };
  const instance = gateway({ retryRelease: async () => { retries++; revoked = true; } }, authorize);
  await assert.rejects(instance.retryControlRelease(), { code: 'SETTINGS_AUTH_REQUIRED' });
  assert.equal(retries, 0);
  revoked = false;
  await assert.rejects(instance.retryControlRelease(), { code: 'SETTINGS_AUTH_REQUIRED' });
  assert.equal(retries, 1);
});

test('diagnostic sentences remove duplicated punctuation and do not emit empty sections', () => {
  assert.equal(joinSentences('连接失败。', '请检查网络。', '', 'GitHub：成功。'), '连接失败。请检查网络。GitHub：成功');
  assert.equal(joinSentences('结果。；', null, '下一项，'), '结果。下一项');
});
