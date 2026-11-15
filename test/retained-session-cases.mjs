import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptRetainedSessionRpc, canonicalRetainedSessionCut, createRetainedSessionReader } from '../scripts/lib/retained-session.mjs';
import { readRetainedSession } from '../scripts/verify-search-log-upgrade.mjs';

function fixture({ cursorless = false } = {}) {
  const records = [
    { type: 'event', event: { seq: 0, type: 'session/created', data: {} } },
    { type: 'event', event: { seq: 1, type: 'assistant/message', data: {} } },
    { type: 'event', event: { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ];
  const cut = { sessionId: 'retained-id', seq: 2, hostInstanceId: 'seed-host',
    eventType: 'turn/end', reason: 'completed' };
  const input = { sessionId: cut.sessionId, throughSeq: cut.seq, maxMessages: 100, cutProof: cut };
  const raw = { records, hasMore: false, ...(cursorless ? {} : { cursor: cut.seq }) };
  const calls = [], host = { async rpc(method, request) {
    calls.push({ method, request });
    assert.equal(method, 'session/page');
    assert.deepEqual(request, { address: { kind: 'session', sessionId: cut.sessionId }, throughSeq: 2, maxMessages: 100 });
    return raw;
  } };
  return { reader: createRetainedSessionReader(), records, cut, input, raw, calls, host };
}

for (const cursorless of [false, true]) {
  test(`retained history uses one fixed-cut owner request with ${cursorless ? 'older cursorless' : 'newer cursor'} page`, async () => {
    const item = fixture({ cursorless }), page = await item.reader.readPage(item.host, item.input);
    assert.equal(page.cursor, 2);
    assert.deepEqual(page.records, item.records);
    assert.deepEqual(page.readEvidence, { throughSeqRequested: 2, boundarySeqObserved: 2,
      cursorSource: cursorless ? 'validated-dense-record-boundary' : 'host-page-cursor',
      hostReturnedCursor: !cursorless, hostCursor: cursorless ? null : 2, completedCutProven: true });
    assert.equal(item.calls.length, 1);
    assert.equal(Object.hasOwn(item.raw, 'cursor'), !cursorless, 'Do not fabricate the raw host response.');
    page.records[0].event.data.changed = true;
    assert.equal(Object.hasOwn(item.records[0].event.data, 'changed'), false);
  });
}

test('retained history chooses the actual last completed canonical event for the original Session', () => {
  const events = [
    { sessionId: 'old-id', seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { sessionId: 'old-id', seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { sessionId: 'old-id', seq: 6, type: 'session/title', data: {} },
    { sessionId: 'other-id', seq: 500, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { sessionId: 'old-id', seq: 7, type: 'turn/end', data: { reason: { kind: 'cancelled' } } },
  ];
  assert.deepEqual(canonicalRetainedSessionCut({ instanceId: 'host-a', sessionEvents: events }, 'old-id'), {
    sessionId: 'old-id', seq: 5, hostInstanceId: 'host-a', eventType: 'turn/end', reason: 'completed',
  });
  for (const snapshot of [{}, { instanceId: 'host-a', sessionEvents: [] },
    { instanceId: 'host-a', sessionEvents: [{ sessionId: 'old-id', type: 'turn/end',
      seq: -0, data: { reason: { kind: 'completed' } } }] }]) {
    assert.throws(() => canonicalRetainedSessionCut(snapshot, 'old-id'));
  }
});

test('retained history rejects missing, guessed, invalid or unrelated cuts before making RPC requests', async () => {
  const item = fixture();
  for (const throughSeq of [undefined, null, -1, -0, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(item.reader.readPage(item.host, { ...item.input, throughSeq }));
  }
  for (const maxMessages of [0, -1, 1.5, Infinity]) {
    await assert.rejects(item.reader.readPage(item.host, { ...item.input, maxMessages }));
  }
  for (const patch of [{ sessionId: 'wrong-id' }, { seq: 3 }, { hostInstanceId: null },
    { eventType: 'session/title' }, { reason: 'cancelled' }]) {
    await assert.rejects(item.reader.readPage(item.host, { ...item.input, cutProof: { ...item.cut, ...patch } }));
  }
  assert.equal(item.calls.length, 0);
});

const invalidPages = [
  ['missing page', () => null],
  ['empty page', () => ({ records: [], hasMore: false })],
  ['truncated page', raw => ({ ...raw, hasMore: true })],
  ['missing completion flag', raw => ({ ...raw, hasMore: undefined })],
  ['wrong returned cut', raw => ({ ...raw, cursor: 3 })],
  ['null returned cursor is not an older cursorless page', raw => ({ ...raw, cursor: null })],
  ['missing final cut', raw => ({ ...raw, records: raw.records.slice(0, -1) })],
  ['missing prefix despite hasMore false', raw => ({ ...raw, records: raw.records.slice(1) })],
  ['duplicated sequence', raw => {
    raw.records[1].event.seq = 0;
    return raw;
  }],
  ['out-of-order sequence', raw => {
    [raw.records[0], raw.records[1]] = [raw.records[1], raw.records[0]];
    return raw;
  }],
  ['non-event record', raw => {
    raw.records[1].type = 'chunks';
    return raw;
  }],
  ['unrelated Session record', raw => {
    raw.records[1].event.sessionId = 'other-id';
    return raw;
  }],
  ['non-completed cut', raw => {
    raw.records[2].event.data.reason.kind = 'cancelled';
    return raw;
  }],
];
for (const [name, change] of invalidPages) {
  test(`retained history fails closed for ${name}, without retrying another request shape`, async () => {
    const item = fixture({ cursorless: true });
    item.host.rpc = async () => { item.calls.push('page'); return change(structuredClone(item.raw)); };
    await assert.rejects(item.reader.readPage(item.host, item.input));
    assert.equal(item.calls.length, 1);
  });
}

test('retained history preserves owner permission and stored-format errors instead of retrying or replacing Sessions', async () => {
  const item = fixture(), error = Object.assign(new Error('Unsupported stored Session format'), { code: 'SESSION_FORMAT_UNSUPPORTED' });
  item.host.rpc = async () => { item.calls.push('page'); throw error; };
  await assert.rejects(item.reader.readPage(item.host, item.input), value => value === error);
  assert.equal(item.calls.length, 1);
});

test('retained history RPC adapter keeps exact deep comparison across older cursorless cold reads', async () => {
  const item = fixture({ cursorless: true }), retained = {
    sessionId: item.input.sessionId, cursor: 2, records: structuredClone(item.records), cut: item.cut,
  };
  const adapted = adaptRetainedSessionRpc(item.host, item.reader, retained);
  await readRetainedSession(adapted, retained);
  item.raw.records[1].event.data.changed = true;
  await assert.rejects(readRetainedSession(adapted, retained), /retain the old Session history/);
  assert.equal(item.calls.length, 2);
  assert.throws(() => adapted.rpc('session/page', {
    address: { kind: 'session', sessionId: 'replacement' }, throughSeq: 2, maxMessages: 100,
  }), /original Session/);
  assert.throws(() => adapted.rpc('session/page', {
    address: { kind: 'session', sessionId: retained.sessionId }, throughSeq: 3, maxMessages: 100,
  }), /exact retained cut/);
});

test('retained history adapter does not change unrelated authenticated RPC calls', async () => {
  const item = fixture(), calls = [];
  const host = { async rpc(method, request) { calls.push({ method, request }); return { ok: true }; } };
  const adapted = adaptRetainedSessionRpc(host, item.reader, { sessionId: 'old-id', cursor: 2 });
  assert.deepEqual(await adapted.rpc('session/prompt', { sessionId: 'old-id' }), { ok: true });
  assert.deepEqual(calls, [{ method: 'session/prompt', request: { sessionId: 'old-id' } }]);
});
