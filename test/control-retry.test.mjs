import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';
import { joinSentences } from '../src/ui/route-form.mjs';

function gateway(control, authorize = () => {}) {
  let Gateway;
  apply({ plugin(Plugin) { Gateway = Plugin; } });
  const instance = new Gateway({ provide() {}, get: name => name === 'grokSearchControl' ? control
    : name === 'grokSearchConnectionSecurity' ? { requireOwner: authorize } : null });
  // This suite tests the new RPC dispatch; full snapshot codecs are covered
  // with real control state by product-wiring.test.mjs.
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
