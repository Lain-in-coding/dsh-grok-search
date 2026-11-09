import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceRouter } from '../src/core/source-adapters.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';

const baseConfig = () => ({
  tavily_api_url: 'https://tavily.test/', tavily_api_key: 'tvly-key', tavily_enabled: true,
  exa_api_url: 'https://exa.test', exa_api_key: 'exa-key', exa_enabled: true,
  tinyfish_search_api_url: 'https://tinyfish.test/search', tinyfish_api_key: '', tinyfish_enabled: true,
  firecrawl_api_url: 'https://firecrawl.test', firecrawl_api_key: 'fc-key', firecrawl_enabled: true,
  fallback_sources: 5, timeout_seconds: 60, github_token: '',
});
const asFields = values => ({ fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])) });
const prefsOf = (value = {}) => ({ value: { githubEnabled: true, ...value } });
// Supplementary sources are switched in the shared config, exactly where
// grok-search-rs reads them; plugin preferences no longer gate them.
const without = (config, ...ids) => ({ ...config, ...Object.fromEntries(ids.map(id => [`${id}_enabled`, false])) });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function router({ config = baseConfig(), prefs = prefsOf(), fetchImpl }) {
  const calls = [];
  const instance = createSourceRouter({
    getConfig: () => asFields(config), getPreferences: () => prefs,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init, calls.length); },
  });
  return { instance, calls };
}

test('request contracts follow grok-search-rs v0.1.26 for every source', async () => {
  const config = { ...baseConfig(), tinyfish_api_key: 'tf-key' };
  const { instance, calls } = router({ config, fetchImpl: async () => json({}, 503) });
  await assert.rejects(() => instance.search({ query: 'hello world', maxResults: 3 }),
    error => error.code === 'SOURCE_ALL_FAILED');
  const [tavily, exa, tinyfish, firecrawl] = calls;
  assert.equal(tavily.url, 'https://tavily.test/search');
  assert.equal(tavily.init.method, 'POST');
  assert.equal(tavily.init.headers.authorization, 'Bearer tvly-key');
  assert.deepEqual(JSON.parse(tavily.init.body), { query: 'hello world', max_results: 3, include_answer: false, include_usage: true });
  assert.equal(exa.url, 'https://exa.test/search');
  assert.equal(exa.init.headers['x-api-key'], 'exa-key');
  assert.deepEqual(JSON.parse(exa.init.body), { query: 'hello world', numResults: 3 });
  assert.equal(tinyfish.init.method, 'GET');
  assert.equal(tinyfish.init.body, undefined);
  assert.equal(tinyfish.init.headers['X-API-Key'], 'tf-key');
  assert.equal(new URL(tinyfish.url).pathname, '/search');
  assert.equal(new URL(tinyfish.url).searchParams.get('query'), 'hello world');
  assert.equal(firecrawl.url, 'https://firecrawl.test/v2/search');
  assert.equal(firecrawl.init.headers.authorization, 'Bearer fc-key');
  assert.deepEqual(JSON.parse(firecrawl.init.body), { query: 'hello world', limit: 3 });
  assert.ok(calls.every(call => call.init.redirect === 'error'));
});

test('a slow first source cannot consume the whole fallback window', async () => {
  const config = without(baseConfig(), 'tinyfish', 'firecrawl');
  const { instance, calls } = router({ config, fetchImpl: (url, { signal }) => {
    if (url.includes('tavily')) return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return json({ results: [{ url: 'https://result.test' }] });
  } });
  const deadline = performance.now() + 250;
  const result = await instance.search({ query: 'q', remainingMs: () => deadline - performance.now() });
  assert.equal(result.search_provider, 'exa');
  assert.equal(calls.length, 2);
  assert.ok(performance.now() < deadline + 100);
});

test('empty keys do not become successful keys when another Tavily key works', async () => {
  const { instance } = router({ config: { ...baseConfig(), tavily_api_key: 'one,two' },
    fetchImpl: async (url, init, index) => json({ results: index === 1 ? [{ url: 'https://result.test' }] : [] }) });
  const result = await instance.diagnoseProvider('tavily');
  assert.equal(result.partial, true);
  assert.match(result.message, /1\/2/);
});

test('observed calls report actual retries and interface credits, never credential values', async () => {
  const observed = [];
  const config = without({ ...baseConfig(), tavily_api_key: 'first,second' }, 'exa', 'tinyfish', 'firecrawl');
  const { instance } = router({ config, fetchImpl: async (url, init, index) => index === 1
    ? json({}, 429) : json({ results: [{ url: 'https://result.test' }], usage: { credits: 1 } }) });
  await instance.search({ query: 'q', onCall: value => observed.push(value) });
  assert.equal(observed.length, 2);
  assert.deepEqual(observed.map(row => [row.keyIndex, row.operation, row.result]), [[0, 'search', 'failed'], [1, 'retry', 'ok']]);
  assert.equal(observed[1].charge.amount, 1);
  assert.equal(JSON.stringify(observed).includes('second'), false);
});

test('Exa dollar costs are estimates from the response, never a made-up price per result', async () => {
  const observed = [];
  const config = without(baseConfig(), 'tavily', 'tinyfish', 'firecrawl');
  const { instance } = router({ config, fetchImpl: async () =>
    json({ results: [{ url: 'https://result.test' }], costDollars: { total: 0.007 } }) });
  await instance.search({ query: 'q', onCall: value => observed.push(value) });
  assert.deepEqual(observed[0].charge, { basis: 'estimated', amount: 0.007, unit: 'USD' });
});

test('firecrawl keeps an explicit /v1 or /v2 base and reads data.web first', async () => {
  for (const [base, expected] of [['https://fc.test/v1', 'https://fc.test/v1/search'], ['https://fc.test/gw/v2/', 'https://fc.test/gw/v2/search']]) {
    const config = without({ ...baseConfig(), firecrawl_api_url: base }, 'tavily', 'exa');
    const { instance, calls } = router({ config,
      fetchImpl: async () => json({ data: { web: [{ url: 'https://example.com/a', title: 'A', description: 'alpha' }] } }) });
    const result = await instance.search({ query: 'q' });
    assert.equal(calls[0].url, expected);
    assert.equal(result.search_provider, 'firecrawl');
    assert.deepEqual(result.sources, [{ url: 'https://example.com/a', title: 'A', snippet: 'alpha' }]);
  }
});

test('tavily drops low-score results and rotates keys only on key-scoped status', async () => {
  const config = without({ ...baseConfig(), tavily_api_key: ' k1, k2 ,,k3' }, 'exa', 'firecrawl');
  const rotating = router({ config, fetchImpl: async (_url, init) =>
    init.headers.authorization === 'Bearer k1' ? json({}, 429)
      : json({ results: [{ url: 'https://low.example', score: 0.05 }, { url: 'https://high.example', title: 'H', content: 'c', score: 0.8 }, 'https://bare.example'] }) });
  const result = await rotating.instance.search({ query: 'q' });
  assert.deepEqual(rotating.calls.map(call => call.init.headers.authorization), ['Bearer k1', 'Bearer k2']);
  assert.deepEqual(result.sources.map(source => source.url), ['https://high.example', 'https://bare.example']);
  assert.equal(result.sources[0].snippet, 'c');

  const serverError = router({ config, fetchImpl: async () => json({}, 500) });
  await assert.rejects(() => serverError.instance.search({ query: 'q' }), error => error.code === 'SOURCE_ALL_FAILED'
    && error.details.failures[0].code === 'HTTP_500');
  assert.equal(serverError.calls.length, 1, 'a non key-scoped failure must not try the next key');
});

test('only tavily splits comma separated keys', async () => {
  const config = without({ ...baseConfig(), exa_api_key: 'exa,with,commas' }, 'tavily');
  const { instance, calls } = router({ config,
    fetchImpl: async () => json({ results: [{ url: 'https://exa.example', summary: 's', publishedDate: '2026-01-01' }] }) });
  const result = await instance.search({ query: 'q' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['x-api-key'], 'exa,with,commas');
  assert.deepEqual(result.sources, [{ url: 'https://exa.example', snippet: 's', publishedAt: '2026-01-01' }]);
});

test('exhausted Tavily keys are all tried before the next supplier', async () => {
  const config = { ...baseConfig(), source_providers: ['tavily', 'firecrawl', 'exa', 'tinyfish'],
    tavily_api_key: 'synthetic-one,synthetic-two,synthetic-three,synthetic-four' };
  const events = [];
  const { instance, calls } = router({ config,
    fetchImpl: async url => url.startsWith('https://tavily.test/')
      ? json({}, 429) : json({ data: { web: [{ url: 'https://result.test/after-exhaustion' }] } }) });
  const result = await instance.search({ query: 'q', onCall: event => events.push(event) });
  assert.equal(result.search_provider, 'firecrawl');
  assert.deepEqual(calls.map(call => new URL(call.url).hostname),
    ['tavily.test', 'tavily.test', 'tavily.test', 'tavily.test', 'firecrawl.test']);
  assert.deepEqual(events.map(event => [event.provider, event.keyIndex, event.result]),
    [['tavily', 0, 'failed'], ['tavily', 1, 'failed'], ['tavily', 2, 'failed'],
      ['tavily', 3, 'failed'], ['firecrawl', 0, 'ok']]);
  assert.deepEqual(result.diagnostic.failures.map(row => [row.provider, row.code]), [['tavily', 'HTTP_429']]);
});

test('unusable result URLs do not count as success or prevent the next source', async () => {
  const invalid = [
    'https://[invalid-url',
    'https://synthetic-user:synthetic-pass@example.invalid/private',
    { url: 'https://[invalid-object', title: 'Malformed URL' },
    { url: 'https://synthetic-user@example.invalid/private', title: 'Credential URL' },
  ];
  const { instance, calls } = router({ fetchImpl: async url => json({
    results: url.includes('tavily') ? invalid : [{ url: 'https://example.com/valid', title: 'Valid' }],
  }) });
  const diagnosis = await instance.diagnoseProvider('tavily');
  assert.equal(diagnosis.status, 'empty');
  assert.equal(diagnosis.code, 'EMPTY');
  assert.equal(diagnosis.keys[0].results, undefined);
  calls.length = 0;
  const result = await instance.search({ query: 'offline URL validation' });
  assert.deepEqual(calls.map(call => new URL(call.url).hostname), ['tavily.test', 'exa.test']);
  assert.equal(result.search_provider, 'exa');
  assert.equal(result.sources[0].url, 'https://example.com/valid');
  assert.equal(result.diagnostic.failures[0].code, 'EMPTY');
  assert.ok(!JSON.stringify(result).includes('synthetic-pass'));
});

test('each source filters unsafe URLs before applying the result limit', async () => {
  for (const provider of ['tavily', 'exa', 'tinyfish', 'firecrawl']) {
    const config = without({ ...baseConfig(), tinyfish_api_key: 'tf-key' },
      ...['tavily', 'exa', 'tinyfish', 'firecrawl'].filter(id => id !== provider));
    const rows = [{ url: 'https://[invalid' }, { url: 'https://user:pass@example.invalid' },
      { url: 'https://example.com/valid', title: 'Valid' }];
    const { instance } = router({ config, fetchImpl: async () =>
      json(provider === 'firecrawl' ? { data: { web: rows } } : { results: rows }) });
    const result = await instance.search({ query: 'offline URL validation', maxResults: 1 });
    assert.equal(result.search_provider, provider);
    assert.deepEqual(result.sources, [{ url: 'https://example.com/valid', title: 'Valid' }]);
  }
});

test('invalid URLs from every source fail explicitly instead of returning empty success', async () => {
  const { instance } = router({ fetchImpl: async () => json({ results: ['https://[invalid'] }) });
  await assert.rejects(instance.search({ query: 'offline URL validation' }), error =>
    error.code === 'SOURCE_ALL_FAILED' && error.details.failures.length === 3
    && error.details.failures.every(row => row.code === 'EMPTY'));
});

test('diagnosis covers every key, skips disabled sources and separates empty from failure', async () => {
  const config = without({ ...baseConfig(), tavily_api_key: 'good,bad' }, 'firecrawl');
  const { instance, calls } = router({ config,
    fetchImpl: async (url, init) => {
      if (url.includes('tavily')) return init.headers.authorization === 'Bearer bad' ? json({ detail: 'SECRET-BODY' }, 401)
        : json({ results: [{ url: 'https://ok.example', score: 0.9 }] });
      return json({ results: [] });
    } });
  const tavily = await instance.diagnoseProvider('tavily');
  assert.equal(tavily.status, 'ok');
  assert.equal(tavily.partial, true);
  assert.equal(tavily.keyCount, 2);
  assert.deepEqual(tavily.keys.map(key => key.status), ['ok', 'failed']);
  assert.equal(tavily.keys[1].code, 'HTTP_401');
  assert.equal(tavily.keys[1].httpStatus, 401);
  assert.ok(!JSON.stringify(tavily).includes('SECRET-BODY'));
  assert.ok(!JSON.stringify(tavily).includes('good') && !JSON.stringify(tavily).includes('Bearer'));
  const exa = await instance.diagnoseProvider('exa');
  assert.equal(exa.status, 'empty');
  assert.equal(exa.code, 'EMPTY');
  const tinyfish = await instance.diagnoseProvider('tinyfish');
  assert.equal(tinyfish.status, 'not-configured');
  const firecrawl = await instance.diagnoseProvider('firecrawl');
  assert.equal(firecrawl.status, 'disabled');
  assert.equal(calls.filter(call => call.url.includes('firecrawl') || call.url.includes('tinyfish')).length, 0);
  await assert.rejects(() => instance.diagnoseProvider('unknown'), error => error.code === 'SOURCE_UNKNOWN');
});

test('github diagnosis skips unconfigured and disabled targets and reports actual token failure', async () => {
  const anonymous = router({ fetchImpl: async () => assert.fail('unconfigured GitHub must not be requested') });
  const open = await anonymous.instance.diagnoseProvider('github');
  assert.equal(open.status, 'not-configured');
  assert.equal(anonymous.calls.length, 0);

  const config = { ...baseConfig(), github_token: 'ghp_bad' };
  const rejected = router({ config, fetchImpl: async () => json({ message: 'Bad credentials ghp_bad' }, 401) });
  const failed = await rejected.instance.diagnoseProvider('github');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.httpStatus, 401);
  assert.match(failed.message, /Token/);
  assert.ok(!JSON.stringify(failed).includes('ghp_bad'));

  const disabled = router({ config, prefs: prefsOf({ githubEnabled: false }), fetchImpl: async () => assert.fail() });
  assert.equal((await disabled.instance.diagnoseProvider('github')).status, 'disabled');
  assert.equal(disabled.calls.length, 0);
});

test('fallback results are capped by fallback_sources and keep provider metadata', async () => {
  const config = { ...baseConfig(), fallback_sources: 2 };
  const { instance, calls } = router({ config, fetchImpl: async url => url.includes('tavily') ? json({}, 401)
    : json({ results: [1, 2, 3, 4].map(index => ({ url: `https://exa.example/${index}` })) }) });
  const result = await instance.search({ query: 'q', maxResults: 5 });
  assert.equal(result.search_provider, 'exa');
  assert.equal(result.fallback_used, true);
  assert.equal(result.sources.length, 2);
  assert.equal(JSON.parse(calls[1].init.body).numResults, 2);
  assert.deepEqual(result.diagnostic.failures, [{ provider: 'tavily', code: 'HTTP_401', httpStatus: 401, message: 'API Key 无效或已失效。' }]);
});

test('fallback_sources 0 sends no supplementary request; missing or invalid values still mean 5', async () => {
  const onlyTavily = without(baseConfig(), 'exa', 'firecrawl');
  const noKey = router({ config: { ...onlyTavily, tavily_api_key: '', fallback_sources: 0 },
    fetchImpl: async () => json({}) });
  await assert.rejects(noKey.instance.search({ query: 'q' }), { code: 'FALLBACK_SOURCES_ZERO' });
  assert.equal(noKey.calls.length, 0);
  const zero = router({ config: { ...onlyTavily, fallback_sources: 0 },
    fetchImpl: async () => json({ results: [{ url: 'https://unexpected.example' }] }) });
  await assert.rejects(zero.instance.search({ query: 'q', maxResults: 3 }), error => {
    assert.equal(error.code, 'FALLBACK_SOURCES_ZERO');
    assert.match(error.message, /fallback_sources/);
    assert.doesNotMatch(error.message, /https?:|tvly-key/);
    return true;
  });
  assert.equal(zero.calls.length, 0);
  // Diagnostics are explicit user tests with their own fixed limit.
  assert.equal((await zero.instance.diagnoseProvider('tavily')).status, 'ok');
  assert.equal(zero.calls.length, 1);
  assert.equal((await zero.instance.diagnose()).find(row => row.provider === 'tavily').status, 'ok');
  assert.equal(zero.calls.length, 2);
  for (const fallbackSources of [undefined, -1, 2.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    const { instance, calls } = router({ config: { ...onlyTavily, fallback_sources: fallbackSources },
      fetchImpl: async () => json({ results: [{ url: 'https://served.example' }] }) });
    const result = await instance.search({ query: 'q', maxResults: 10 });
    assert.equal(result.search_provider, 'tavily');
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].init.body).max_results, 5, String(fallbackSources));
  }
});

test('fallback serializes within shared character budget without routing metadata consuming it', async () => {
  const { instance } = router({ config: { ...baseConfig(), response_max_chars: 500 },
    fetchImpl: async () => json({ results: [{ url: 'https://a.test', title: 'x'.repeat(200),
      content: '\\"🙂'.repeat(2000), score: .8 }] }) });
  const answer = await instance.search({ query: 'budget', maxResults: 1 });
  assert.ok(JSON.stringify(answer).length <= 500);
  assert.equal(answer.truncated, true);
  assert.equal(answer.search_provider, 'tavily');
  assert.equal(answer.fallback_used, true);
  assert.deepEqual(Object.keys(answer), ['content', 'sources', 'truncated']);
  const bad = router({ config: { ...baseConfig(), response_max_chars: 0 },
    fetchImpl: async () => { throw new Error('must not run'); } });
  await assert.rejects(bad.instance.search({ query: 'q' }), { code: 'GROK_CONFIG_INVALID' });
  assert.equal(bad.calls.length, 0);
});

test('sources removed by the output budget cannot stop fallback as an empty success', async () => {
  const config = { ...baseConfig(), source_providers: ['tavily', 'exa'], response_max_chars: 100 };
  const longUrl = 'https://example.test/' + 'a'.repeat(1000);
  const { instance, calls } = router({ config, fetchImpl: async url =>
    json({ results: [{ url: url.includes('tavily') ? longUrl : 'https://a.test' }] }) });
  const result = await instance.search({ query: 'bounded links' });
  assert.equal(result.search_provider, 'exa');
  assert.deepEqual(result.sources, [{ url: 'https://a.test' }]);
  assert.equal(result.diagnostic.failures[0].code, 'OUTPUT_LIMIT');
  assert.equal(calls.length, 2);
  assert.ok(JSON.stringify(result).length <= 100);
  const allLong = router({ config, fetchImpl: async () => json({ results: [{ url: longUrl }] }) });
  await assert.rejects(allLong.instance.search({ query: 'bounded links' }), error =>
    error.code === 'SOURCE_ALL_FAILED' && error.details.failures.length === 2
      && error.details.failures.every(row => row.code === 'OUTPUT_LIMIT'));
});

test('network, redirect, invalid URL and oversized responses fail closed with fixed messages', async () => {
  const onlyTavily = without(baseConfig(), 'exa', 'firecrawl');
  const network = router({ config: onlyTavily, fetchImpl: async () => {
    throw Object.assign(new TypeError('fetch failed https://tavily.test?key=tvly-key'), { cause: { code: 'ENOTFOUND' } });
  } });
  await assert.rejects(() => network.instance.search({ query: 'q' }), error => {
    const failure = error.details.failures[0];
    return error.code === 'SOURCE_ALL_FAILED' && failure.code === 'NETWORK' && !failure.message.includes('tvly-key');
  });
  const diagnosis = await network.instance.diagnoseProvider('tavily');
  assert.equal(diagnosis.keys[0].cause, 'ENOTFOUND');

  const invalid = router({ config: { ...onlyTavily, tavily_api_url: 'file:///etc/passwd' },
    fetchImpl: async () => json({}) });
  assert.equal((await invalid.instance.diagnoseProvider('tavily')).code, 'URL_INVALID');
  await assert.rejects(() => invalid.instance.search({ query: 'q' }), error => error.code === 'SOURCE_NOT_CONFIGURED');
  assert.equal(invalid.calls.length, 0);

  const huge = router({ config: onlyTavily, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 16)) });
  assert.equal((await huge.instance.diagnoseProvider('tavily')).code, 'RESPONSE_TOO_LARGE');
});

test('an empty query and a fully unconfigured router are explicit errors', async () => {
  const config = { ...baseConfig(), tavily_api_key: '', exa_api_key: '', firecrawl_api_key: '' };
  const { instance, calls } = router({ config, fetchImpl: async () => json({}) });
  assert.equal(instance.snapshot().available, false);
  await assert.rejects(() => instance.search({ query: '  ' }), error => error.code === 'SOURCE_QUERY_INVALID');
  await assert.rejects(() => instance.search({ query: 'q' }), error => error.code === 'SOURCE_NOT_CONFIGURED');
  assert.equal(calls.length, 0);
});

test('config and preference failures are not disguised as missing keys or default switches', async () => {
  for (const which of ['configuration', 'preferences']) {
    let requests = 0;
    const error = new GrokSearchError(which === 'configuration' ? 'CONFIG_PARSE_FAILED' : 'PREFERENCES_READ_FAILED',
      which === 'configuration' ? '配置语法无效。' : '偏好无法读取。');
    const instance = createSourceRouter({
      getConfig: () => { if (which === 'configuration') throw error; return asFields(baseConfig()); },
      getPreferences: () => { if (which === 'preferences') throw error; return prefsOf(); },
      fetchImpl: async () => { requests++; return json({}); },
    });
    assert.throws(instance.snapshot, caught => caught === error);
    await assert.rejects(instance.search({ query: 'q' }), caught => caught === error);
    await assert.rejects(instance.diagnoseProvider('exa'), caught => caught === error);
    await assert.rejects(instance.diagnoseProvider('github'), caught => caught === error);
    assert.equal(requests, 0);
  }
});

test('the chain order and on/off come from the shared source_providers and *_enabled fields', async () => {
  const ok = json({ results: [{ url: 'https://served.example', score: 0.9 }] });
  // An explicit list sets the order and excludes unnamed sources, as grok-search-rs does.
  const ordered = router({ config: { ...baseConfig(), source_providers: ['firecrawl', 'exa'] },
    fetchImpl: async url => url.includes('firecrawl') ? json({}, 503) : json({ results: [{ url: 'https://exa.example' }] }) });
  assert.deepEqual(ordered.instance.snapshot().order, ['firecrawl', 'exa', 'tavily', 'tinyfish']);
  assert.equal(ordered.instance.snapshot().states.tavily, 'disabled');
  const result = await ordered.instance.search({ query: 'q' });
  assert.equal(result.search_provider, 'exa');
  assert.deepEqual(ordered.calls.map(call => new URL(call.url).hostname), ['firecrawl.test', 'exa.test']);
  // The environment form is a comma separated list; an unknown name is ignored.
  const csv = router({ config: { ...baseConfig(), source_providers: ' exa , unknown,tavily' }, fetchImpl: async () => ok.clone() });
  assert.deepEqual(csv.instance.snapshot().enabled, ['exa', 'tavily']);
  // Old plugin-private order/on-off fields cannot create a second chain.
  const legacy = router({ prefs: { value: { sourceOrder: ['firecrawl', 'exa', 'tinyfish', 'tavily'],
    sourceEnabled: { tavily: false, exa: false, tinyfish: false, firecrawl: false } } }, fetchImpl: async () => ok.clone() });
  assert.deepEqual(legacy.instance.snapshot().enabled, ['tavily', 'exa', 'firecrawl']);
});
