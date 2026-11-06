import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createToolRouteContext } from '../src/core/tool-route-context.mjs';
import { createRoutedSearch } from '../src/core/routed-search.mjs';
import { createSearchLog } from '../src/core/search-log.mjs';
import { createReleaseBarrier } from '../src/core/release-transaction.mjs';
import { SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';

const exec = (sessionId, callId, name = 'web_search') => ({ name, callId, agent: { session: { id: sessionId } } });
const route = served => ({ served, outcome: 'ok', fallbackUsed: false, grokCode: null });

test('tool route context tracks exact call and session, never query text or current route', async () => {
  const context = createToolRouteContext(), session = randomUUID();
  assert.equal(context.capture(), null);
  await context.run(exec(session, 'first'), async () => {
    const pending = context.capture();
    assert.equal(pending.callId, 'first');
    assert.equal(pending.sessionId, session);
    assert.equal(context.read(session, 'first').state, 'running');
    pending.finish(route('tavily'));
    pending.finish(route('exa'));
  });
  assert.deepEqual(context.read(session, 'first'), { known: true, state: 'done',
    routes: [{ served: 'tavily', outcome: 'ok', fallbackUsed: false, code: '' }] });
  assert.deepEqual(context.read(randomUUID(), 'first'), { known: false, state: 'unknown', routes: [] });
  assert.deepEqual(context.read(session, 'second'), { known: false, state: 'unknown', routes: [] });
  context.dispose();
});

test('chat provenance preserves confirmed result suppliers as detached safe names only', async () => {
  const context = createToolRouteContext(), session = randomUUID();
  await context.run(exec(session, 'internal-fallback'), () => context.capture().finish({
    ...route('exa'), resultProviders: ['grok', 'exa', 'exa', 'https://not-a-provider', 'grok-sources'],
    resultProvidersComplete: false, fallbackUsed: true, grokCode: 'grok_content_empty',
  }));
  const first = context.read(session, 'internal-fallback');
  assert.deepEqual(first.routes[0].resultProviders, ['grok', 'exa']);
  assert.equal(first.routes[0].resultProvidersComplete, false);
  first.routes[0].resultProviders.push('tavily');
  assert.deepEqual(context.read(session, 'internal-fallback').routes[0].resultProviders, ['grok', 'exa']);
  context.dispose();
});
test('concurrent same-word searches remain associated to their own calls and sessions', async () => {
  const context = createToolRouteContext(), sessionA = randomUUID(), sessionB = randomUUID();
  const release = [];
  const task = (session, call, served) => context.run(exec(session, call), async () => {
    const capture = context.capture();
    await new Promise(done => release.push(done));
    capture.finish(route(served));
  });
  const a = task(sessionA, 'same-call-id', 'tavily'), b = task(sessionB, 'same-call-id', 'exa');
  release[1](); await b; release[0](); await a;
  assert.equal(context.read(sessionA, 'same-call-id').routes[0].served, 'tavily');
  assert.equal(context.read(sessionB, 'same-call-id').routes[0].served, 'exa');
  context.dispose();
});

test('multi-query calls retain every observed route and failures; unknown upstream data is dropped', async () => {
  const context = createToolRouteContext(), session = randomUUID();
  await context.run(exec(session, 'batch'), async () => {
    context.capture().finish(route('tavily'));
    context.capture().finish({ served: 'untrusted', outcome: 'failed', code: '<private error>', apiKey: 'private' });
    context.capture().finish({ ...route('exa'), fallbackUsed: true, grokCode: 'grok_auth_error' });
  });
  const result = context.read(session, 'batch');
  assert.equal(result.state, 'failed');
  assert.equal(result.routes.length, 3);
  assert.deepEqual(result.routes[1], { served: null, outcome: 'failed', fallbackUsed: false, code: '' });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(result.routes[2].fallbackUsed, true);
  context.dispose();
});

test('real routed search and diagnostics do not share tool provenance or page lifetimes', async () => {
  const context = createToolRouteContext(), history = createSearchLog(), session = randomUUID();
  const routed = createRoutedSearch({
    grok: { search: async () => ({ content: '', sources: [{ url: 'https://example.test/search' }] }) },
    sourceRouter: {}, releaseBarrier: createReleaseBarrier(), searchLog: history,
  });
  await context.run(exec(session, 'native'), () => routed.search({ query: 'same query' }, undefined, 'search', context.capture()));
  await routed.search({ query: 'diagnosis' }, undefined, 'test');
  assert.equal(history.snapshot(randomUUID()).records.length, 1);
  assert.equal(history.snapshot(randomUUID()).records[0].callId, 'native');
  assert.equal(context.read(session, 'native').routes[0].served, 'grok');
  await routed.dispose();
  assert.equal(history.snapshot(randomUUID()).records.length, 1, 'rebuilt core does not clear bundle-owned history');
  context.dispose(); history.dispose();
});

test('disposal and history eviction never infer a missing or earlier call from last success', async () => {
  const context = createToolRouteContext({ capacity: 1 }), session = randomUUID();
  for (const call of ['old', 'new']) await context.run(exec(session, call), () => context.capture().finish(route('tavily')));
  assert.equal(context.read(session, 'old').known, false);
  assert.equal(context.read(session, 'new').known, true);
  const pending = context.run(exec(session, 'disposed'), async () => {
    const capture = context.capture(); context.dispose(); capture.finish(route('exa'));
  });
  await pending;
  assert.equal(context.capture(), null);
  assert.equal(context.read(session, 'new').known, false);
});

test('non-search tools and invalid identities never create plugin route evidence', async () => {
  const context = createToolRouteContext();
  for (const execution of [exec(randomUUID(), 'chat', 'echo'), exec('', 'bad'), exec(randomUUID(), 'bad\nid')]) {
    await context.run(execution, () => assert.equal(context.capture(), null));
  }
  context.dispose();
});

test('clear invalidates in-flight call attribution without republishing it on late completion', async () => {
  const context = createToolRouteContext(), session = randomUUID();
  await context.run(exec(session, 'clear-in-flight'), async () => {
    const pending = context.capture();
    context.clear();
    pending.finish(route('tavily'));
    assert.equal(context.capture(), null);
  });
  assert.equal(context.read(session, 'clear-in-flight').known, false);
  await context.run(exec(session, 'next'), () => context.capture().finish(route('exa')));
  assert.equal(context.read(session, 'next').routes[0].served, 'exa');
  context.dispose();
});

test('nested unrelated or duplicate tool executions cannot inherit the enclosing search identity', async () => {
  const context = createToolRouteContext(), session = randomUUID();
  await context.run(exec(session, 'outer'), async () => {
    await context.run(exec(session, 'child', 'web_fetch'), () => assert.equal(context.capture(), null));
    await context.run(exec(session, 'outer'), () => assert.equal(context.capture(), null));
    context.capture().finish(route('tavily'));
  });
  // A second execution of the same identity makes both executions unattributable.
  assert.deepEqual(context.read(session, 'outer'), { known: false, state: 'unknown', routes: [] });
  context.dispose();
});

test('a repeated session/call identity after completion withdraws both attributions', async () => {
  const history = createSearchLog(), context = createToolRouteContext({ searchLog: history }), session = randomUUID();
  let supplier = 'tavily';
  const routed = createRoutedSearch({ grok: {}, preferences: { snapshot: () => ({ value: { grokEnabled: false } }) },
    sourceRouter: { search: async request => {
      request.onCall({ provider: supplier, result: 'ok' });
      return { content: '', search_provider: supplier, sources: [{ url: 'https://example.test/' + supplier }] };
    } }, releaseBarrier: createReleaseBarrier(), searchLog: history });
  await context.run(exec(session, 'reused'), () => routed.search({ query: 'first' }, undefined, 'search', context.capture()));
  assert.equal(context.read(session, 'reused').routes[0].served, 'tavily');
  supplier = 'exa';
  await context.run(exec(session, 'reused'), async () => {
    const attribution = context.capture();
    assert.equal(attribution, null, 'the repeated execution still runs but carries no attribution');
    const result = await routed.search({ query: 'second' }, undefined, 'search', attribution);
    assert.equal(result.sources[0].url, 'https://example.test/exa');
  });
  assert.deepEqual(context.read(session, 'reused'), { known: false, state: 'unknown', routes: [] });
  const records = history.snapshot(randomUUID()).records;
  assert.deepEqual(records.map(row => [row.q, row.callId ?? null]), [['second', null], ['first', 'reused']]);
  await context.run(exec(session, 'reused'), () => assert.equal(context.capture(), null));
  assert.equal(context.read(session, 'reused').known, false);
  await routed.dispose(); context.dispose(); history.dispose();
});

test('a concurrent duplicate identity withdraws both attributions while either is still running', async () => {
  const context = createToolRouteContext(), session = randomUUID();
  let release;
  const gate = new Promise(done => { release = done; });
  const first = context.run(exec(session, 'parallel'), async () => {
    const attribution = context.capture();
    assert.equal(context.read(session, 'parallel').state, 'running');
    await gate;
    attribution.finish(route('tavily'));
    return 'first done';
  });
  const second = await context.run(exec(session, 'parallel'), () => {
    assert.equal(context.capture(), null);
    return 'second done';
  });
  assert.equal(second, 'second done');
  assert.deepEqual(context.read(session, 'parallel'), { known: false, state: 'unknown', routes: [] });
  release();
  assert.equal(await first, 'first done');
  assert.deepEqual(context.read(session, 'parallel'), { known: false, state: 'unknown', routes: [] });
  context.dispose();
});

test('ambiguity markers occupy route capacity and are dropped by clear and dispose', async () => {
  const context = createToolRouteContext({ capacity: 2 }), session = randomUUID();
  const once = (call, served = 'tavily') => context.run(exec(session, call), () => context.capture()?.finish(route(served)));
  await once('x'); await once('y'); await once('y'); await once('z');
  assert.equal(context.read(session, 'x').known, false, 'the marker took a slot and evicted the oldest call');
  assert.equal(context.read(session, 'y').known, false);
  assert.equal(context.read(session, 'z').known, true);
  context.clear();
  await once('y', 'exa');
  assert.equal(context.read(session, 'y').routes[0].served, 'exa', 'clear forgets earlier identities and markers');
  context.dispose();
  assert.equal(context.read(session, 'y').known, false);
});

test('captures beyond sixteen keep the cap, mark routes incomplete and still count omitted failures', async () => {
  const batch = async (call, extra) => {
    const context = createToolRouteContext(), session = randomUUID();
    await context.run(exec(session, call), () => {
      for (let index = 0; index < 16; index++) context.capture().finish(route('tavily'));
      extra(context);
    });
    const value = context.read(session, call);
    context.dispose();
    return value;
  };
  const failed = await batch('omitted-failure', context => context.capture().finish({ served: null, outcome: 'failed', code: 'HTTP_429' }));
  assert.equal(failed.routes.length, 16);
  assert.equal(failed.routesComplete, false);
  assert.equal(failed.state, 'failed', 'an omitted failure cannot be hidden by sixteen retained successes');
  assert.equal((await batch('omitted-cancel', context => context.capture().finish({ outcome: 'failed', cancelled: true }))).state, 'cancelled');
  assert.equal((await batch('omitted-unfinished', context => { context.capture(); })).state, 'failed');
  const succeeded = await batch('omitted-ok', context => context.capture().finish(route('exa')));
  assert.equal(succeeded.state, 'done');
  assert.equal(succeeded.routesComplete, false);
  assert.ok(succeeded.routes.every(row => row.served === 'tavily'), 'the omitted supplier is not presented as recorded');
  const controller = new AbortController(), context = createToolRouteContext(), session = randomUUID();
  let late;
  await context.run({ ...exec(session, 'omitted-running-cancelled'), signal: controller.signal }, () => {
    for (let index = 0; index < 16; index++) context.capture().finish(route('tavily'));
    late = context.capture();
    controller.abort();
  });
  late.finish(route('exa'));
  assert.equal(context.read(session, 'omitted-running-cancelled').state, 'cancelled');
  assert.equal(context.read(session, 'omitted-running-cancelled').routesComplete, false);
  context.dispose();
  const within = await batch('within-cap', () => {});
  assert.equal(within.routes.length, 16);
  assert.equal(Object.hasOwn(within, 'routesComplete'), false);
  const descriptor = SETTINGS_DESCRIPTORS.find(row => row.method === 'toolCallRoute');
  assert.deepEqual(descriptor.result.create().parse(failed), failed);
});

test('supplement-only failover is distinguished from direct source success', async () => {
  const context = createToolRouteContext(), session = randomUUID();
  await context.run(exec(session, 'source-failover'), () => context.capture().finish({
    ...route('exa'), grokCode: 'DISABLED', fallbackUsed: true, failures: [{ provider: 'tavily', code: 'HTTP_429' }],
  }));
  assert.equal(context.read(session, 'source-failover').routes[0].fallbackUsed, true);
  context.dispose();
});

test('one host tool call creates one history record with each distinct child query and real calls', async () => {
  let clock = 1000;
  const history = createSearchLog({ now: () => clock });
  const context = createToolRouteContext({ searchLog: history }), session = randomUUID();
  const routed = createRoutedSearch({
    grok: {}, preferences: { snapshot: () => ({ value: { grokEnabled: false } }) },
    sourceRouter: { search: async request => {
      request.onCall({ provider: 'tavily', result: 'ok', keyIndex: 0,
        charge: { basis: 'reported', amount: 1, unit: 'credits' } });
      clock += 100;
      return { content: '', search_provider: 'tavily', sources: [{ url: 'https://example.test/' + request.query }] };
    } },
    releaseBarrier: createReleaseBarrier(), searchLog: history,
  });
  await context.run(exec(session, 'batch-one'), async () => {
    const tasks = ['current', 'hourly'].map(query => routed.search({ query }, undefined, 'search', context.capture()));
    assert.equal(history.snapshot(randomUUID()).records.length, 1);
    assert.equal(history.snapshot(randomUUID()).records[0].kind, 'running');
    await Promise.all(tasks);
    assert.equal(history.snapshot(randomUUID()).records[0].kind, 'running', 'the host has not finished the batch');
  });
  const record = history.snapshot(randomUUID()).records[0];
  assert.equal(record.callId, 'batch-one');
  assert.equal(record.queryCount, 2);
  assert.equal(record.queriesComplete, true);
  assert.equal(record.kind, 'sources');
  assert.equal(record.ms, 200, 'batch duration is wall clock, not the sum of child durations');
  assert.deepEqual(record.queries.map(row => row.q), ['current', 'hourly']);
  assert.deepEqual(record.queries.map(row => row.calls[0].charge.amount), [1, 1]);
  assert.equal(record.calls.length, 0, 'parent does not duplicate child usage');
  assert.equal(context.read(session, 'batch-one').routes.length, 2);
  await routed.dispose(); context.dispose(); history.dispose();
});

test('same words in different tool calls or sessions never merge, and capacity counts calls not queries', async () => {
  const history = createSearchLog({ capacity: 2 }), context = createToolRouteContext({ searchLog: history });
  const session = randomUUID(), other = randomUUID();
  const dispatch = async (sid, call) => context.run(exec(sid, call), async () => {
    for (const query of ['same', 'same']) {
      const attribution = context.capture(), token = history.begin(query, attribution);
      history.finish(token, { outcome: 'ok', served: 'grok' });
      attribution.finish(route('grok'));
    }
  });
  await dispatch(session, 'first'); await dispatch(session, 'second');
  assert.equal(history.snapshot(randomUUID()).records.length, 2);
  await dispatch(other, 'second');
  const records = history.snapshot(randomUUID()).records;
  assert.equal(records.length, 2);
  assert.equal(records.every(row => row.queryCount === 2), true);
  assert.equal(records[0].sessionId, other);
  assert.equal(records[1].sessionId, session);
  context.dispose(); history.dispose();
});

test('clearing in the middle of a tool batch suppresses late and newly dispatched child history', async () => {
  const history = createSearchLog(), context = createToolRouteContext({ searchLog: history }), session = randomUUID();
  await context.run(exec(session, 'cleared-batch'), async () => {
    const attribution = context.capture(), pending = history.begin('first', attribution);
    history.clear(randomUUID()); context.clear();
    history.finish(pending, { outcome: 'ok', served: 'grok' });
    const late = context.capture();
    assert.equal(late.suppressed, true);
    assert.equal(history.begin('second', late), null);
    attribution.finish(route('grok')); late.finish(route('tavily'));
  });
  assert.equal(history.snapshot(randomUUID()).records.length, 0);
  assert.equal(context.read(session, 'cleared-batch').known, false);
  await context.run(exec(session, 'new-batch'), () => {
    const attribution = context.capture(), token = history.begin('new', attribution);
    history.finish(token, { outcome: 'ok', served: 'grok' }); attribution.finish(route('grok'));
  });
  assert.equal(history.snapshot(randomUUID()).records.length, 1);
  context.dispose(); history.dispose();
});

test('batch failures, cancellation and overflow retain honest child outcomes without success aggregation', async () => {
  const history = createSearchLog(), context = createToolRouteContext({ searchLog: history }), session = randomUUID();
  await assert.rejects(context.run(exec(session, 'mixed'), () => {
    for (const [query, outcome] of [['success', 'ok'], ['failure', 'failed']]) {
      const attribution = context.capture(), token = history.begin(query, attribution);
      history.finish(token, { outcome, served: outcome === 'ok' ? 'tavily' : null, code: outcome === 'ok' ? '' : 'HTTP_429' });
      attribution.finish({ served: outcome === 'ok' ? 'tavily' : null, outcome });
    }
    throw Object.assign(new Error('private upstream text'), { code: 'HTTP_429' });
  }));
  let record = history.snapshot(randomUUID()).records[0];
  assert.equal(record.kind, 'failed');
  assert.deepEqual(record.queries.map(row => row.kind), ['ok', 'failed']);
  assert.equal(JSON.stringify(record).includes('private upstream text'), false);
  await context.run(exec(session, 'overflow'), () => {
    for (let index = 0; index < 18; index++) {
      const attribution = context.capture(), token = history.begin('query ' + index, attribution);
      history.finish(token, { outcome: 'ok', served: 'grok', callsComplete: true });
      attribution.finish(route('grok'));
    }
  });
  record = history.snapshot(randomUUID()).records[0];
  assert.equal(record.queryCount, 18);
  assert.equal(record.queries.length, 16);
  assert.equal(record.queriesComplete, false);
  assert.equal(record.callsComplete, false);
  assert.equal(record.served, null);
  context.dispose(); history.dispose();
});

test('evicted batch history does not corrupt exact call provenance or resurrect on a later query', async () => {
  const history = createSearchLog({ capacity: 1 }), context = createToolRouteContext({ searchLog: history }), session = randomUUID();
  const routed = createRoutedSearch({
    grok: { search: async () => ({ content: '', sources: [{ url: 'https://example.test/search' }] }) },
    sourceRouter: {}, releaseBarrier: createReleaseBarrier(), searchLog: history,
  });
  await context.run(exec(session, 'evicted'), async () => {
    await routed.search({ query: 'first' }, undefined, 'search', context.capture());
    history.begin('newer standalone search');
    await routed.search({ query: 'second' }, undefined, 'search', context.capture());
  });
  assert.equal(history.snapshot(randomUUID()).records[0].q, 'newer standalone search');
  assert.equal(context.read(session, 'evicted').routes.every(row => row.outcome === 'ok' && row.served === 'grok'), true);
  await routed.dispose(); context.dispose(); history.dispose();
});

test('whole-tool cancellation and post-provider failure are not displayed as successful batches', async () => {
  const history = createSearchLog(), context = createToolRouteContext({ searchLog: history }), session = randomUUID();
  const controller = new AbortController(), execution = { ...exec(session, 'cancelled'), signal: controller.signal };
  await context.run(execution, () => {
    const attribution = context.capture();
    history.begin('cancelled while pending', attribution);
    controller.abort();
  });
  assert.equal(history.snapshot(randomUUID()).records[0].kind, 'cancelled');
  assert.equal(history.snapshot(randomUUID()).records[0].queries[0].kind, 'cancelled');
  await context.run(exec(session, 'render-error'), () => {
    const attribution = context.capture(), token = history.begin('provider succeeded', attribution);
    history.finish(token, { outcome: 'ok', served: 'grok' }); attribution.finish(route('grok'));
    return { isError: true };
  });
  assert.equal(history.snapshot(randomUUID()).records[0].kind, 'failed');
  assert.equal(history.snapshot(randomUUID()).records[0].queries[0].kind, 'ok');
  assert.equal(context.read(session, 'render-error').state, 'failed');
  context.dispose(); history.dispose();
});
