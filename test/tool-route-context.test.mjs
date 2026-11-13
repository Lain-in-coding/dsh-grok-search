import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createToolRouteContext } from '../src/core/tool-route-context.mjs';
import { createRoutedSearch } from '../src/core/routed-search.mjs';
import { createSearchLog } from '../src/core/search-log.mjs';
import { createReleaseBarrier } from '../src/core/release-transaction.mjs';
import { SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import { createSourceRouter } from '../src/core/source-adapters.mjs';

const exec = (sessionId, callId, name = 'web_search') => ({ name, callId, agent: { session: { id: sessionId } } });
const route = served => ({ served, outcome: 'ok', fallbackUsed: false, grokCode: null });

test('trace keeps actual queued/dispatch/attempt timing while the legacy RPC shape stays exact', async () => {
  let clock = 1000;
  const context = createToolRouteContext({ now: () => clock }), session = randomUUID();
  await context.run(exec(session, 'trace'), async () => {
    const capture = context.capture();
    assert.equal(context.readTrace(session, 'trace').routes[0].phase, 'queued');
    clock += 50; capture.dispatched();
    capture.record({ provider: 'tavily', result: 'running', keyIndex: 0, query: 'private-query', key: 'private-key' });
    clock += 120;
    capture.record({ provider: 'tavily', result: 'failed', keyIndex: 0, code: 'HTTP_401' });
    capture.record({ provider: 'tavily', result: 'running', keyIndex: 1, operation: 'retry' });
    clock += 80; capture.record({ provider: 'tavily', result: 'ok', keyIndex: 1 });
    capture.finish({ ...route('tavily'), callsComplete: true });
  });
  const value = context.readTrace(session, 'trace'), calls = value.routes[0].calls;
  assert.equal(value.elapsedMs, 250);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => [call.result, call.elapsedMs, call.keyIndex]), [['failed',120,0],['ok',80,1]]);
  assert.equal(value.routes[0].callsComplete, true);
  assert.doesNotMatch(JSON.stringify(value), /private-query|private-key/);
  calls[0].code = 'MUTATED';
  assert.equal(context.readTrace(session, 'trace').routes[0].calls[0].code, 'HTTP_401');
  assert.deepEqual(SETTINGS_DESCRIPTORS.find(row => row.method === 'toolCallTrace').result.create().parse(value), value);
  assert.deepEqual(context.read(session, 'trace'), { known: true, state: 'done',
    routes: [{ served: 'tavily', outcome: 'ok', fallbackUsed: false, code: '' }] });
  context.dispose();
});

test('trace records are bounded and cannot resurrect cleared, cancelled or ambiguous identities', async () => {
  const context = createToolRouteContext(), session = randomUUID(), controller = new AbortController();
  await context.run({ ...exec(session, 'bounded'), signal: controller.signal }, () => {
    const capture = context.capture();
    for (let i = 0; i < 20; i++) {
      capture.record({ provider: 'tavily', result: 'running', keyIndex: i });
      capture.record({ provider: 'tavily', result: 'failed', keyIndex: i, code: 'HTTP_429' });
    }
    capture.finish({ ...route('exa'), callsComplete: true });
  });
  const bounded = context.readTrace(session, 'bounded');
  assert.equal(bounded.routes[0].calls.length, 16);
  assert.equal(bounded.routes[0].callsTruncated, true);
  assert.equal(bounded.routes[0].callsComplete, false);
  await context.run({ ...exec(session, 'cancel'), signal: controller.signal }, () => {
    context.capture().record({ provider: 'grok', result: 'running' });
    controller.abort();
  });
  assert.equal(context.readTrace(session, 'cancel').routes[0].calls[0].result, 'cancelled');
  await context.run(exec(session, 'clear'), () => {
    const capture = context.capture();
    context.clear();
    capture.record({ provider: 'grok', result: 'running' });
    capture.finish(route('grok'));
  });
  assert.equal(context.readTrace(session, 'clear').known, false);
  await context.run(exec(session, 'duplicate'), () => context.capture().finish(route('grok')));
  await context.run(exec(session, 'duplicate'), () => {});
  assert.equal(context.readTrace(session, 'duplicate').known, false);
  context.dispose();
});

test('an inner kernel fallback reports supplier evidence without inventing individual Grok latency', async () => {
  let clock = 100;
  const context = createToolRouteContext({ now: () => clock }), session = randomUUID();
  await context.run(exec(session, 'inner'), () => {
    const capture = context.capture();
    capture.record({ provider: 'grok', result: 'running' });
    clock = 9000;
    capture.record({ provider: 'grok', result: 'failed', code: 'grok_timeout', evidence: 'kernel-summary' });
    capture.record({ provider: 'exa', result: 'ok', evidence: 'source-label' });
    capture.finish({ ...route('exa'), fallbackUsed: true, grokCode: 'grok_timeout' });
  });
  const value = context.readTrace(session, 'inner');
  assert.equal(value.elapsedMs, 8900);
  assert.equal(value.routes[0].calls[0].elapsedMs, null);
  assert.equal(value.routes[0].calls[1].elapsedMs, null);
  assert.equal(value.routes[0].callsComplete, false);
  context.dispose();
});

test('real routing callbacks expose each active retry without extra requests or duplicate history rows', async () => {
  const history=createSearchLog(),context=createToolRouteContext({searchLog:history}),session=randomUUID();
  const configuration={source_providers:['tavily','exa','tinyfish','firecrawl'],
    tavily_api_key:'fixture-a,fixture-b',tavily_api_url:'https://tavily.test',tavily_enabled:true,
    exa_api_key:'fixture-exa',exa_api_url:'https://exa.test',exa_enabled:true,
    tinyfish_api_key:'fixture-tiny',tinyfish_search_api_url:'https://tinyfish.test',tinyfish_enabled:true,
    firecrawl_api_key:'fixture-fire',firecrawl_api_url:'https://firecrawl.test',firecrawl_enabled:true};
  let sent=0;
  const sourceRouter=createSourceRouter({getConfig:()=>configuration,fetchImpl:async url=>{
    sent++;
    const trace=context.readTrace(session,'real-route');
    assert.equal(trace.routes[0].calls.at(-1).result,'running');
    const success=String(url).includes('firecrawl');
    return new Response(JSON.stringify(success?{data:{web:[{url:'https://example.test/real'}]}}:{}),
      {status:success?200:401,headers:{'content-type':'application/json'}});
  }});
  const routed=createRoutedSearch({grok:{search:async()=>{throw Object.assign(new Error('fixture'),{code:'HTTP_401'});}},
    sourceRouter,getConfig:()=>configuration,searchLog:history,releaseBarrier:createReleaseBarrier()});
  await context.run(exec(session,'real-route'),()=>routed.search({query:'private-query'},undefined,'search',context.capture()));
  const result=context.readTrace(session,'real-route');
  assert.equal(sent,5,'Tavily two keys plus three suppliers, with no observation requests');
  assert.equal(result.routes[0].calls.length,6,'one primary and five supplementary attempts');
  assert.deepEqual(result.routes[0].planned,['grok','tavily','exa','tinyfish','firecrawl']);
  assert.equal(result.routes[0].calls.at(-1).provider,'firecrawl');
  assert.equal(result.routes[0].calls.at(-1).result,'ok');
  assert.equal(history.snapshot(randomUUID()).records[0].queries[0].calls.length,6);
  assert.doesNotMatch(JSON.stringify(result),/private-query|fixture-|https:/);
  await routed.dispose();context.dispose();history.dispose();
});

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
  history.snapshot(session);
  await context.run(exec(session, 'cleared-batch'), async () => {
    const attribution = context.capture(), pending = history.begin('first', attribution);
    history.clear(session); context.clear();
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

test('host ABORTED error envelopes remain cancelled, while timeout envelopes remain failed', async () => {
  for (const reason of ['ABORTED', 'TIMEOUT']) {
    const context = createToolRouteContext(), session = randomUUID(), controller = new AbortController();
    await context.run({ ...exec(session, reason), signal: controller.signal }, () => {
      const attribution = context.capture();
      attribution.finish({ outcome: 'failed', cancelled: reason === 'ABORTED', code: reason });
      controller.abort(Object.assign(new Error(reason), { code: reason }));
      return { isError: true, error: { info: { code: reason } } };
    });
    assert.equal(context.read(session, reason).state, reason === 'ABORTED' ? 'cancelled' : 'failed');
    context.dispose();
  }
});

test('GitHub one-call history is finalized by the whole host outcome and late post-policy failure', async () => {
  const history = createSearchLog(), context = createToolRouteContext({ searchLog: history }), session = randomUUID();
  const call = exec(session, 'github-call', 'github_read');
  await context.run(call, () => {
    const attribution = context.capture('github_read');
    const token = history.beginRead('https://github.com/a/b/issues/1', attribution);
    history.finishRead(token, { segment: 1, hasMore: true, acquiredComplete: true, apiRequests: 3 });
    attribution.finish({ served: 'github', outcome: 'ok' });
    return { isError: false };
  });
  let row = history.snapshot(randomUUID()).records[0];
  assert.equal(row.recordType, 'github');
  assert.equal(row.kind, 'ok');
  assert.equal(row.callFinished, true);
  assert.equal(row.queries, undefined);
  assert.equal(row.apiRequests, 3);
  context.finalizeRead(call, { isError: true, error: { info: { code: 'PERMISSION_DENIED' } } });
  row = history.snapshot(randomUUID()).records[0];
  assert.equal(row.kind, 'failed');
  assert.equal(row.reason, 'PERMISSION_DENIED');
  assert.equal(context.read(session, 'github-call').state, 'failed');
  context.dispose(); history.dispose();
});

test('final host policy outcome overrides only the tool summary and keeps real supplier usage', async () => {
  for (const finalCode of ['PERMISSION_DENIED', 'ABORTED', 'TOOL_TIMEOUT']) {
    const history = createSearchLog(), context = createToolRouteContext({ searchLog: history });
    const session = randomUUID(), call = exec(session, 'final-' + finalCode);
    await context.run(call, () => {
      const attribution = context.capture(), token = history.begin('supplier already completed', attribution);
      history.call(token, { provider: 'tavily', result: 'ok', charge: { amount: 1, unit: 'credits', basis: 'reported' } });
      history.finish(token, { outcome: 'ok', served: 'tavily', callsComplete: true });
      attribution.finish(route('tavily'));
      return { isError: false };
    });
    context.finalizeRead(call, { isError: true, error: { info: { name: 'PolicyError', code: finalCode } } });
    const row = history.snapshot(randomUUID()).records[0];
    const kind = finalCode === 'ABORTED' ? 'cancelled' : 'failed';
    assert.equal(row.kind, kind);
    assert.equal(row.reason, finalCode);
    assert.equal(context.read(session, call.callId).state, kind);
    assert.equal(row.queries[0].kind, 'ok');
    assert.deepEqual(row.queries[0].calls[0].charge, { amount: 1, unit: 'credits', basis: 'reported' });
    context.finalizeRead(call, { isError: false });
    assert.equal(history.snapshot(randomUUID()).records[0].kind, kind, 'final settlement is idempotent');
    context.dispose(); history.dispose();
  }
});

test('late final outcomes cannot change another execution with reused or cleared identities', async () => {
  const history = createSearchLog(), context = createToolRouteContext({ searchLog: history });
  const session = randomUUID(), call = exec(session, 'reused-final');
  const run = execution => context.run(execution, () => {
    const attribution = context.capture(), token = history.begin('successful', attribution);
    history.finish(token, { outcome: 'ok', served: 'grok' }); attribution?.finish(route('grok'));
  });
  await run(call);
  const unrelated = { ...call, agent: { session: { id: session } } };
  context.finalizeRead(unrelated, { isError: true, error: { info: { code: 'PERMISSION_DENIED' } } });
  assert.equal(history.snapshot(randomUUID()).records[0].kind, 'ok', 'matching text ids alone are insufficient');
  history.snapshot(session);
  history.clear(session); context.clear();
  await run(exec(session, call.callId));
  context.finalizeRead(call, { isError: true, error: { info: { code: 'PERMISSION_DENIED' } } });
  assert.equal(history.snapshot(randomUUID()).records[0].kind, 'ok');
  context.dispose(); history.dispose();
});

test('a duplicate completed identity prevents late host finalization from claiming its previous record', async () => {
  const history = createSearchLog(), context = createToolRouteContext({ searchLog: history });
  const session = randomUUID(), original = exec(session, 'duplicate-completed');
  await context.run(original, () => {
    const attribution = context.capture(), token = history.begin('original', attribution);
    history.finish(token, { outcome: 'ok', served: 'grok' }); attribution.finish(route('grok'));
  });
  for (let index = 0; index < 2; index++) await context.run(exec(session, original.callId), () => {
    assert.equal(context.capture(), null);
  });
  context.finalize(original, { isError: true, error: { info: { code: 'PERMISSION_DENIED' } } });
  assert.equal(context.read(session, original.callId).known, false);
  assert.equal(history.snapshot(randomUUID()).records[0].kind, 'ok', 'ambiguous identities cannot rewrite historical attribution');
  context.dispose(); history.dispose();
});

test('clearing during GitHub tool execution suppresses new and late records', async () => {
  const history = createSearchLog(), context = createToolRouteContext({ searchLog: history }), session = randomUUID();
  history.snapshot(session);
  await context.run(exec(session, 'github-clear', 'github_read'), () => {
    const first = context.capture('github_read'), token = history.beginRead('https://github.com/a/b/issues/1', first);
    context.clear(); history.clear(session);
    const late = context.capture('github_read');
    assert.equal(history.beginRead('https://github.com/a/b/issues/1', late), null);
    history.finishRead(token, { segment: 1 });
    first.finish({ served: 'github', outcome: 'ok' });
  });
  assert.equal(history.snapshot(randomUUID()).records.length, 0);
  context.dispose(); history.dispose();
});
