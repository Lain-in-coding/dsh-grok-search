import assert from 'node:assert/strict';

function nonNegativeSeq(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

export function canonicalRetainedSessionCut(snapshot, sessionId) {
  assert.ok(typeof sessionId === 'string' && sessionId, 'Retain the actual Session identity.');
  assert.ok(typeof snapshot?.instanceId === 'string' && snapshot.instanceId,
    'The seed must identify its actual host lifetime.');
  assert.ok(Array.isArray(snapshot.sessionEvents), 'Require observed canonical Session events.');
  const end = snapshot.sessionEvents.findLast(event => event.sessionId === sessionId
    && event.type === 'turn/end' && event.data?.reason?.kind === 'completed');
  assert.ok(end && nonNegativeSeq(end.seq),
    'The old Session must contain a completed turn with an observed canonical sequence.');
  return { sessionId, seq: end.seq, hostInstanceId: snapshot.instanceId,
    eventType: end.type, reason: end.data.reason.kind };
}

export function createRetainedSessionReader() {
  return {
    async readPage(host, { sessionId, throughSeq, maxMessages = 100, cutProof } = {}) {
      assert.ok(typeof host?.rpc === 'function', 'Use the authenticated host history RPC.');
      assert.ok(typeof sessionId === 'string' && sessionId, 'Require the retained Session identity.');
      assert.ok(nonNegativeSeq(throughSeq), 'Require an exact observed inclusive history cut.');
      assert.ok(Number.isSafeInteger(maxMessages) && maxMessages > 0,
        'Require a positive bounded message budget.');
      if (cutProof !== undefined) {
        assert.equal(cutProof?.sessionId, sessionId, 'The canonical cut must belong to this Session.');
        assert.equal(cutProof.seq, throughSeq, 'The canonical cut must match the requested boundary.');
        assert.ok(typeof cutProof.hostInstanceId === 'string' && cutProof.hostInstanceId);
        assert.equal(cutProof.eventType, 'turn/end');
        assert.equal(cutProof.reason, 'completed');
      }
      const raw = await host.rpc('session/page', {
        address: { kind: 'session', sessionId }, throughSeq, maxMessages,
      });
      assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), 'Require a real history page.');
      const hostReturnedCursor = Object.hasOwn(raw, 'cursor');
      if (hostReturnedCursor) assert.equal(raw.cursor, throughSeq, 'The history reader must honor the original cut.');
      assert.ok(Array.isArray(raw.records) && raw.records.length > 0, 'The old Session history cannot be empty.');
      assert.equal(raw.hasMore, false, 'The retained fixture must fit one complete bounded page.');
      for (let index = 0; index < raw.records.length; index++) {
        const record = raw.records[index], event = record?.event;
        assert.equal(record?.type, 'event', 'Retained history requires canonical event records.');
        assert.ok(event && typeof event === 'object' && !Array.isArray(event));
        assert.ok(nonNegativeSeq(event.seq), 'Require a canonical non-negative sequence.');
        assert.equal(event.seq, index, 'A complete retained page must be a dense zero-based history prefix.');
        assert.ok(typeof event.type === 'string' && event.type);
        if (Object.hasOwn(event, 'sessionId')) assert.equal(event.sessionId, sessionId);
      }
      const tail = raw.records.at(-1).event;
      assert.equal(tail.seq, throughSeq, 'The observed record boundary must match the original cut.');
      if (cutProof !== undefined) {
        assert.equal(tail.type, cutProof.eventType, 'The seed boundary must be the observed completed event.');
        assert.equal(tail.data?.reason?.kind, cutProof.reason);
      }
      // Older hosts omit cursor; only the validated record boundary supplies the normalized cut.
      return { ...raw, records: structuredClone(raw.records), cursor: tail.seq,
        readEvidence: { throughSeqRequested: throughSeq, boundarySeqObserved: tail.seq,
          cursorSource: hostReturnedCursor ? 'host-page-cursor' : 'validated-dense-record-boundary',
          hostReturnedCursor, hostCursor: hostReturnedCursor ? raw.cursor : null,
          completedCutProven: cutProof !== undefined } };
    },
  };
}

export function adaptRetainedSessionRpc(host, reader, retained) {
  assert.ok(typeof host?.rpc === 'function' && typeof reader?.readPage === 'function');
  return {
    rpc(method, request) {
      if (method !== 'session/page') return host.rpc(method, request);
      assert.equal(request?.address?.kind, 'session');
      assert.equal(request.address.sessionId, retained.sessionId, 'Read the original Session, never a replacement.');
      assert.equal(request.throughSeq, retained.cursor, 'Read the exact retained cut.');
      return reader.readPage(host, { sessionId: retained.sessionId, throughSeq: retained.cursor,
        maxMessages: request.maxMessages, cutProof: retained.cut });
    },
  };
}
