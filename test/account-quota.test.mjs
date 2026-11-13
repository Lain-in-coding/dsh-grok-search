import assert from 'node:assert/strict';
import test from 'node:test';
import { queryAccountQuota, quotaDraftConfiguration } from '../src/core/account-quota.mjs';

const json = body => new Response(JSON.stringify(body));
test('quota response readers release their lock on success, malformed data and oversize failures', async () => {
  for (const body of [
    JSON.stringify({ account: { plan_usage: 1, plan_limit: 100 } }), 'invalid JSON', 'x'.repeat(128 * 1024 + 1),
  ]) {
    const response = new Response(body);
    try {
      await queryAccountQuota({ provider: 'tavily', config: { tavily_api_key: 'synthetic' },
        fetchImpl: async () => response });
    } catch (error) { assert.equal(error.code, 'QUOTA_QUERY_FAILED'); }
    assert.equal(response.body.locked, false);
  }
});

test('quota caller cancellation also releases a body that does not propagate the fetch signal', async () => {
  const controller = new AbortController(), reason = new Error('synthetic quota cancellation');
  let stream, response, cancelled = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = queryAccountQuota({ provider: 'tavily', config: { tavily_api_key: 'synthetic' },
    signal: controller.signal, fetchImpl: async () => {
      response = new Response(new ReadableStream({
        start(value) { stream = value; started(); },
        cancel() { cancelled++; },
      }));
      return response;
    } });
  let timer;
  try {
    await ready;
    controller.abort(reason);
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Quota body remained pending after cancellation.')), 500);
    })]), error => error === reason);
    assert.equal(cancelled, 1);
    assert.equal(response.body.locked, false);
  } finally {
    clearTimeout(timer);
    if (!cancelled) stream.close();
    await pending.catch(() => {});
  }
});

test('Tavily custom endpoints query the configured origin and separate account/key scopes', async () => {
  const result = await queryAccountQuota({ provider: 'tavily', keyIndex: 1,
    config: { tavily_api_url: 'https://custom.test/api', tavily_api_key: 'first,second' },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://custom.test/api/usage');
      assert.equal(init.headers.authorization, 'Bearer second');
      assert.equal(init.redirect, 'manual');
      return json({ account: { plan_usage: 5, plan_limit: 100, paygo_usage: 123 },
        key: { usage: 2, limit: 10 } });
    } });
  assert.equal(result.value.remaining, 95);
  assert.equal(result.value.keyRemaining, 8);
  assert.equal(JSON.stringify(result).includes('second'), false);
});
test('Firecrawl never derives mixed-scope usage from plan and remaining', async () => {
  const result = await queryAccountQuota({ provider: 'firecrawl', config: { firecrawl_api_key: 'synthetic' },
    fetchImpl: async url => { assert.equal(url, 'https://api.firecrawl.dev/v2/team/credit-usage');
      return json({ success: true, data: { remainingCredits: 200, planCredits: 1000 } }); } });
  assert.equal(result.value.used, null);
  assert.equal(result.value.plan, null);
  assert.equal(result.value.remaining, 200);
});
test('TinyFish supports real negative wallet balance and keeps custom credentials on custom origin', async () => {
  for (const [base, expected] of [[undefined, 'https://agent.tinyfish.ai/v1/wallet'],
    ['https://custom.test/search', 'https://custom.test/search/v1/wallet'],
    ['https://custom.test/', 'https://custom.test/v1/wallet'],
    ['https://custom.test/v1', 'https://custom.test/v1/wallet'],
    ['https://custom.test/prefix/v1/', 'https://custom.test/prefix/v1/wallet']]) {
    const result = await queryAccountQuota({ provider: 'tinyfish',
      config: { tinyfish_api_key: 'synthetic', tinyfish_search_api_url: base },
      fetchImpl: async (url, init) => {
        assert.equal(url, expected); assert.equal(init.headers['X-API-Key'], 'synthetic');
        return json({ available_balance: '-2.50', currency: 'USD' });
      } });
    assert.equal(result.value.balance, -2.5);
  }
});
test('unsupported Exa does not issue a fake balance query', async () => {
  assert.deepEqual(await queryAccountQuota({ provider: 'exa', config: {},
    fetchImpl: () => { throw new Error('must not request'); } }), { value: null, supported: false });
});
test('errors, huge responses, malformed numbers, unsafe URLs and invalid key slots fail closed', async () => {
  for (const fetchImpl of [
    async () => new Response('secret body', { status: 401 }),
    async () => json({ account: { plan_usage: '5', plan_limit: -1 } }),
    async () => new Response('x'.repeat(128 * 1024 + 1)),
    async () => { throw new Error('secret key'); },
  ]) {
    await assert.rejects(queryAccountQuota({ provider: 'tavily', config: { tavily_api_key: 'synthetic' }, fetchImpl }),
      error => error.code === 'QUOTA_QUERY_FAILED' && !error.message.includes('secret'));
  }
  for (const url of ['file:///tmp/x', 'https://user:pass@test/', 'https://test/?api_key=secret']) {
    await assert.rejects(queryAccountQuota({ provider: 'tavily',
      config: { tavily_api_key: 'synthetic', tavily_api_url: url }, fetchImpl: () => assert.fail() }));
  }
  await assert.rejects(queryAccountQuota({ provider: 'tavily', keyIndex: -1,
    config: { tavily_api_key: 'synthetic' }, fetchImpl: () => assert.fail() }));
});
test('aborted invocations never send or replace the caller abort reason', async () => {
  const controller = new AbortController(), reason = new Error('cancel');
  controller.abort(reason);
  await assert.rejects(queryAccountQuota({ provider: 'tavily', config: { tavily_api_key: 'synthetic' },
    signal: controller.signal, fetchImpl: () => assert.fail() }), error => error === reason);
});

test('real HTTP redirects are refused instead of forwarding custom credentials', async () => {
  const { createServer } = await import('node:http');
  let downstream = 0;
  const server = createServer((request, response) => {
    if (request.url === '/usage') { response.writeHead(302, { location: '/collect' }); response.end(); }
    else { downstream++; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(queryAccountQuota({ provider: 'tavily', config: {
      tavily_api_url: `http://127.0.0.1:${server.address().port}`, tavily_api_key: 'synthetic',
    } }), { code: 'QUOTA_QUERY_FAILED' });
    assert.equal(downstream, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('real HTTP quota cancellation closes a stalled response and preserves the caller reason', async () => {
  const { createServer } = await import('node:http');
  const controller = new AbortController(), reason = new Error('real loopback quota cancellation');
  let sent, closed, requests = 0;
  const received = new Promise(resolve => { sent = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, '/usage');
    assert.equal(request.headers.authorization, 'Bearer synthetic-loopback-key');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"account":');
    response.once('close', closed);
    sent();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pending = queryAccountQuota({ provider: 'tavily', config: {
    tavily_api_url: `http://127.0.0.1:${server.address().port}`, tavily_api_key: 'synthetic-loopback-key',
  }, signal: controller.signal });
  const rejection = assert.rejects(pending, failure => failure === reason);
  let timer;
  try {
    await received;
    controller.abort(reason);
    await rejection;
    await Promise.race([disconnected, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Quota connection remained open after cancellation.')), 1000);
    })]);
    assert.equal(requests, 1);
  } finally {
    clearTimeout(timer);
    controller.abort(reason);
    await rejection;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('quota failures keep precise bounded HTTP/parse/network evidence without response bodies', async () => {
  for (const [status, category] of [[401, 'AUTH'], [403, 'PERMISSION'], [429, 'RATE_LIMIT'],
    [402, 'BILLING'], [404, 'ENDPOINT'], [503, 'UPSTREAM'], [302, 'REDIRECT']]) {
    await assert.rejects(queryAccountQuota({ provider: 'tavily', config: { tavily_api_key: 'synthetic' },
      fetchImpl: async () => new Response('upstream-secret-not-for-ui', { status }) }),
    error => error.details.category === category && error.details.httpStatus === status
      && !JSON.stringify(error).includes('upstream-secret'));
  }
  await assert.rejects(queryAccountQuota({ provider: 'tavily', config: { tavily_api_key: 'synthetic' },
    fetchImpl: async () => { throw Object.assign(new TypeError('secret'), { cause: { code: 'ENOTFOUND' } }); } }),
  error => error.details.category === 'NETWORK' && error.details.networkCode === 'ENOTFOUND');
  await assert.rejects(queryAccountQuota({ provider: 'tavily', config: { tavily_api_key: 'synthetic' },
    fetchImpl: async () => new Response('<html>secret</html>') }),
  error => error.details.category === 'UNREPORTED');
});

test('draft queries use the selected current form key and leave the saved snapshot unchanged', async () => {
  const effective = { tavily_api_url: { value: 'https://saved.test' }, tavily_api_key: { value: 'saved-one,saved-two' } };
  const before = structuredClone(effective);
  const query = quotaDraftConfiguration({ provider: 'tavily', keyIndex: 1, effective,
    draft: { baseUrl: 'https://draft.test', apiKey: 'draft-key' } });
  await queryAccountQuota({ provider: 'tavily', ...query, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://draft.test/usage'); assert.equal(init.headers.authorization, 'Bearer draft-key');
    return json({ account: { plan_usage: 0, plan_limit: 100 } });
  } });
  assert.deepEqual(effective, before);
  for (const draft of [{ baseUrl: 'http://remote.test' }, { apiKey: 'a\nb' }, { apiKey: null }, { unknown: 'value' }]) {
    assert.throws(() => quotaDraftConfiguration({ provider: 'tavily', effective, draft }));
  }
  assert.throws(() => quotaDraftConfiguration({ provider: 'tavily',
    effective: { tavily_api_key: { value: 'env-key', readOnly: true } }, draft: { apiKey: 'draft-key' } }),
  { code: 'CONFIG_FIELD_READ_ONLY' });
});

test('draft destination-only edits use the selected saved multi-key and do not redirect to an official API', async () => {
  const effective = { tavily_api_url: { value: 'https://saved.test' },
    tavily_api_key: { value: 'first,second' } };
  const query = quotaDraftConfiguration({ provider: 'tavily', keyIndex: 1, effective,
    draft: { baseUrl: 'https://other-custom.test/path' } });
  await queryAccountQuota({ provider: 'tavily', ...query, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://other-custom.test/path/usage');
    assert.equal(init.headers.authorization, 'Bearer second');
    return json({ key: { usage: 0, limit: 1 } });
  } });
  assert.equal(effective.tavily_api_url.value, 'https://saved.test');
});
