import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateSearchQuery, MAX_SEARCH_QUERY_CHARS } from '../src/core/search-query.mjs';
import { createSearchExecutor } from '../src/core/search-executor.mjs';
import { createSourceRouter } from '../src/core/source-adapters.mjs';
import { createRoutedSearch } from '../src/core/routed-search.mjs';
import { createReleaseBarrier } from '../src/core/release-transaction.mjs';
import { apply, SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';

test('search limit counts Unicode code points and never trims accepted input', () => {
  assert.equal(MAX_SEARCH_QUERY_CHARS, 8192);
  const codec = SETTINGS_DESCRIPTORS.find(row => row.method === 'testSearch').parameters[0].codec.create();
  for (const char of ['a', '中', '🙂']) {
    for (const size of [8191, 8192]) {
      const query = char.repeat(size);
      assert.equal(validateSearchQuery(query), query);
      assert.equal(codec.safeParse({ query }).success, true);
    }
    const query = char.repeat(8193);
    assert.throws(() => validateSearchQuery(query), { code: 'SEARCH_QUERY_TOO_LONG' });
    assert.equal(codec.safeParse({ query }).success, false);
  }
  assert.equal(validateSearchQuery(' 中文 🙂 '), ' 中文 🙂 ');
  for (const query of [null, undefined, {}, 7, '', ' \t\n']) {
    assert.throws(() => validateSearchQuery(query), { code: 'GROK_QUERY_INVALID' });
  }
});

test('oversized query is refused before configuration, queue, process or source requests', async () => {
  let observed = 0;
  const unexpected = () => { observed++; throw new Error('unexpected work'); };
  const executor = createSearchExecutor({ snapshot: unexpected, runQuery: unexpected });
  const source = createSourceRouter({ getConfig: unexpected, fetchImpl: unexpected });
  const routed = createRoutedSearch({ grok: { search: unexpected }, sourceRouter: source,
    preferences: { snapshot: unexpected }, getConfig: unexpected, releaseBarrier: createReleaseBarrier() });
  const query = 'x'.repeat(200_000), completions = [];
  try {
    await assert.rejects(executor.search({ query }), { code: 'SEARCH_QUERY_TOO_LONG' });
    await assert.rejects(source.search({ query }), { code: 'SEARCH_QUERY_TOO_LONG' });
    await assert.rejects(routed.search({ query }, undefined, 'search',
      { finish: outcome => completions.push(outcome) }), { code: 'SEARCH_QUERY_TOO_LONG' });
    assert.equal(observed, 0);
    assert.equal(executor.snapshot().queued, 0);
    assert.deepEqual(routed.searchLog.snapshot(randomUUID()).records, []);
    assert.equal(completions[0].code, 'SEARCH_QUERY_TOO_LONG');
    assert.equal(JSON.stringify(completions).includes(query), false);
  } finally { await routed.dispose(); await executor.dispose(); }
});

test('settings gateway rejects over-limit payloads with a useful message, including old descriptor callers', async () => {
  let Gateway, called = 0, ownerChecks = 0;
  apply({ plugin(Plugin) { Gateway = Plugin; } });
  const gateway = new Gateway({ provide() {}, get: name =>
    name === 'grokSearchConnectionSecurity' ? { requireOwner() { ownerChecks++; } }
      : name === 'grokSearchCore' ? { testSearch() { called++; } } : null });
  await assert.rejects(gateway.testSearch({ query: '🙂'.repeat(8193) }),
    error => error.code === 'SEARCH_QUERY_TOO_LONG' && error.message.includes('8192'));
  assert.equal(called, 0);
  assert.ok(ownerChecks > 0);
});
