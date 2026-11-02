import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnectionSecurity } from '../src/core/connection-security.mjs';
const owner = () => ({ invocation: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } });
const request = (remoteAddress, encrypted = false, headers = {}) => ({
  socket: { remoteAddress, localAddress: remoteAddress.includes(':') ? '::1' : '127.0.0.1', encrypted }, headers,
});

test('missing invocation or transport proof never defaults to local', () => {
  const security = createConnectionSecurity();
  assert.throws(() => security.requireOwner({}), error => error.code === 'SETTINGS_AUTH_REQUIRED');
  assert.throws(() => security.requireSecret(owner()), error => error.code === 'SETTINGS_SECURE_CONNECTION_REQUIRED');
});
test('authenticated direct loopback permits explicit secrets', async () => {
  const security = createConnectionSecurity();
  for (const address of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1']) {
    await security.run(request(address), null, async () => {
      assert.equal(security.capabilities(owner()).transport, 'loopback');
      security.requireSecret(owner());
    });
  }
});
test('remote HTTP stays redacted even when Host or Origin claims localhost', async () => {
  const security = createConnectionSecurity();
  await security.run(request('192.0.2.1', false, { host: 'localhost', origin: 'http://localhost', secure: 'true' }), null, async () => {
    assert.equal(security.capabilities(owner()).secretsAllowed, false);
    assert.throws(() => security.requireSecret(owner()), error => error.code === 'SETTINGS_SECURE_CONNECTION_REQUIRED');
  });
});
test('untrusted forwarded headers cannot upgrade a plaintext request', async () => {
  const security = createConnectionSecurity();
  await security.run(request('127.0.0.1', false, { 'x-forwarded-proto': 'https' }), null, async () => {
    assert.equal(security.capabilities(owner()).secretsAllowed, false);
  });
});
test('actual encrypted socket permits owner, but not a different principal', async () => {
  const security = createConnectionSecurity();
  await security.run(request('192.0.2.1', true), null, async () => {
    security.requireSecret(owner());
    assert.equal(security.capabilities(owner()).transport, 'https');
    assert.throws(() => security.requireSecret({ invocation: { peer: { principal: { kind: 'agent' } } } }), error => error.code === 'SETTINGS_AUTH_REQUIRED');
  });
});
test('concurrent requests sharing the same owner peer cannot mix security facts', async () => {
  const security = createConnectionSecurity(), ctx = owner();
  await Promise.all([
    security.run(request('127.0.0.1'), null, async () => { await delay(15); assert.equal(security.capabilities(ctx).secretsAllowed, true); }),
    security.run(request('192.0.2.4'), null, async () => { await delay(5); assert.equal(security.capabilities(ctx).secretsAllowed, false); }),
  ]);
  assert.equal(security.capabilities(ctx).secretsAllowed, false);
});
test('invalid address spellings and incomplete sockets are restricted', async () => {
  const security = createConnectionSecurity();
  for (const address of ['localhost', '127.evil', '127.0.0.1.evil', '192.168.1.2', '::ffff:192.0.2.1', '']) {
    await security.run(request(address), null, async () => assert.equal(security.capabilities(owner()).secretsAllowed, false));
  }
});
test('disposal and request cancellation are respected', async () => {
  const security = createConnectionSecurity(), controller = new AbortController(), ctx = owner();
  const reason = new Error('cancelled');
  ctx.invocation.signal = controller.signal; controller.abort(reason);
  assert.throws(() => security.requireOwner(ctx), error => error === reason);
  security.dispose();
  assert.throws(() => security.requireOwner(owner()), error => error.code === 'SETTINGS_UNAVAILABLE');
});
