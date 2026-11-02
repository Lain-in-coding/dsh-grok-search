import { randomUUID } from 'node:crypto';
import { ControlRecordError } from './control-intent-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const time = value => text(value) && Number.isFinite(Date.parse(value));
const clone = value => structuredClone(value);
const fail = (code, message, details = {}) => { throw new ControlRecordError(code, message, details); };

function errorView(error) {
  return { code: error?.code ?? null, message: error?.message ?? String(error) };
}

function releaseOutcome({ operationId, recordCommitted, completionCommitted = false,
  inFlightInvalidated, drainSettled, routeChanged = false, routeVerified = false, error = null }) {
  return { kind: 'incomplete', recordCommitted, completionCommitted, inFlightInvalidated, drainSettled,
    routeChanged, routeVerified, operationId, ...(error ? { error: errorView(error) } : {}) };
}

function assertLease(lease, owner) {
  if (!object(lease) || !object(owner) || lease.hostId !== owner.hostId || lease.pid !== owner.pid
    || lease.uid !== owner.uid || lease.entryId !== owner.entryId
    || lease.moduleName !== owner.moduleName || lease.provider !== owner.provider) {
    fail('CONTROL_RELEASE_OWNERSHIP_CONFLICT',
      'The live owner identity does not match the committed control lease.');
  }
}

function assertController(controller) {
  if (!object(controller) || typeof controller.invalidate !== 'function' || typeof controller.drain !== 'function'
    || typeof controller.restore !== 'function' || typeof controller.verify !== 'function') {
    fail('CONTROL_RELEASE_CONTROLLER_INVALID',
      'Release requires invalidate, drain, restore and verify callbacks.');
  }
}

function assertReceipt(receipt, expectedAuthor, baseline) {
  if (!object(receipt) || receipt.atAuthor !== true || receipt.fetchPreserved !== true
    || receipt.dependenciesPreserved !== true || receipt.actualSearchProvider !== expectedAuthor
    || !Number.isSafeInteger(baseline) || baseline < 0
    || !Number.isSafeInteger(receipt.originalSearchCalls) || receipt.originalSearchCalls < baseline
    || receipt.originalSearchBaseline !== baseline
    || receipt.originalSearchDelta !== receipt.originalSearchCalls - baseline
    || receipt.originalSearchDelta !== 0) {
    fail('CONTROL_RELEASE_ROUTE_UNVERIFIED',
      'The route did not return to the recorded author state without an official-search dispatch in the release window.');
  }
}

function assertReleaseRecord(intent, releaseOperationId) {
  if (!object(intent?.priorIntent) || intent.release?.kind !== 'intent-release-commit'
    || intent.release.explicit !== true || intent.release.operationId !== releaseOperationId) {
    fail('CONTROL_RELEASE_HISTORIC_EVIDENCE_INVALID',
      'The committed release intent is missing or belongs to another operation.');
  }
}

/**
 * Cooperative in-flight barrier. It invalidates the caller's operation IDs
 * synchronously and waits for the owner to settle them within a bound. It does
 * not cancel work itself and cannot create a cross-resource transaction.
 */
export function createReleaseBarrier({ drainTimeoutMs = 2_000 } = {}) {
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1) {
    fail('CONTROL_RELEASE_BARRIER_INVALID', 'The release barrier timeout must be a positive integer.');
  }
  let state = 'active';
  let epoch = 0;
  const operations = new Map();
  const invalidated = new Set();
  const snapshot = () => ({ state, epoch, activeOperationIds: [...operations.keys()],
    invalidatedOperationIds: [...invalidated] });
  const begin = ({ operationId } = {}) => {
    if (!UUID.test(operationId)) fail('CONTROL_RELEASE_OPERATION_INVALID', 'A UUID operation ID is required.');
    if (state !== 'active') fail('CONTROL_RELEASE_BARRIER_INACTIVE', 'The release barrier is no longer active.');
    if (operations.has(operationId)) fail('CONTROL_RELEASE_OPERATION_DUPLICATE', 'The operation is already in flight.');
    operations.set(operationId, { epoch });
    return { operationId, epoch };
  };
  const settle = ({ operationId } = {}) => {
    if (!UUID.test(operationId)) fail('CONTROL_RELEASE_OPERATION_INVALID', 'A UUID operation ID is required.');
    return operations.delete(operationId);
  };
  const assertActive = operationId => {
    if (!UUID.test(operationId) || !operations.has(operationId)) {
      fail('CONTROL_RELEASE_OPERATION_UNKNOWN', 'The operation is not tracked by this release barrier.');
    }
    if (state !== 'active' || invalidated.has(operationId)) {
      fail('CONTROL_RELEASE_OPERATION_INVALIDATED', 'The operation was invalidated by a release request.');
    }
  };
  const invalidate = ({ reason } = {}) => {
    if (!text(reason)) fail('CONTROL_RELEASE_REASON_REQUIRED', 'An explicit release reason is required.');
    if (state !== 'stopping') {
      state = 'stopping';
      epoch += 1;
      for (const operationId of operations.keys()) invalidated.add(operationId);
    }
    return snapshot();
  };
  const drain = async ({ timeoutMs = drainTimeoutMs } = {}) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      fail('CONTROL_RELEASE_BARRIER_INVALID', 'The drain timeout must be a positive integer.');
    }
    if (state !== 'stopping') fail('CONTROL_RELEASE_BARRIER_NOT_INVALIDATED', 'Invalidate the barrier before draining.');
    const deadline = Date.now() + timeoutMs;
    while (operations.size > 0) {
      if (Date.now() >= deadline) {
        fail('CONTROL_RELEASE_DRAIN_TIMEOUT', 'In-flight operations did not settle before the release deadline.',
          { remaining: operations.size, activeOperationIds: [...operations.keys()] });
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return snapshot();
  };
  return Object.freeze({ begin, settle, assertActive, invalidate, drain, snapshot });
}

async function finishExplicitRelease({ store, record, owner, controller, reason, now, releaseOperationId }) {
  assertReleaseRecord(record.intent, releaseOperationId);
  const prior = record.intent.priorIntent;
  const counterBaseline = record.intent.release.counterBaseline;
  assertLease(prior.lease, owner);
  let restore;
  try {
    restore = await controller.restore({ reason, operationId: releaseOperationId, owner: clone(owner),
      previousIntent: clone(prior), releaseIntent: clone(record.intent) });
  } catch (error) {
    return Object.freeze({ ...releaseOutcome({ operationId: releaseOperationId, recordCommitted: true,
      completionCommitted: false, inFlightInvalidated: true, drainSettled: true,
      routeChanged: null, routeVerified: false, error }), envelope: record });
  }
  if (!object(restore) || typeof restore.routeChanged !== 'boolean') {
    return Object.freeze({ ...releaseOutcome({ operationId: releaseOperationId, recordCommitted: true,
      completionCommitted: false, inFlightInvalidated: true, drainSettled: true,
      routeChanged: null, routeVerified: false,
      error: { code: 'CONTROL_RELEASE_RESTORE_INVALID',
        message: 'The route restore callback must report routeChanged as a boolean.' } }), envelope: record });
  }

  if (!Number.isSafeInteger(counterBaseline) || counterBaseline < 0) {
    return Object.freeze({ ...releaseOutcome({ operationId: releaseOperationId, recordCommitted: true,
      completionCommitted: false, inFlightInvalidated: true, drainSettled: true,
      routeChanged: restore.routeChanged, routeVerified: false,
      error: { code: 'CONTROL_RELEASE_COUNTER_BASELINE_REQUIRED',
        message: 'The committed release intent has no valid original-search baseline.' } }), envelope: record });
  }

  let receipt;
  try {
    receipt = await controller.verify({ reason, operationId: releaseOperationId, owner: clone(owner),
      previousIntent: clone(prior), releaseIntent: clone(record.intent), routeChanged: restore.routeChanged,
      counterBaseline });
    assertReceipt(receipt, prior.acquisition?.authorSearchProvider ?? null, counterBaseline);
  } catch (error) {
    return Object.freeze({ ...releaseOutcome({ operationId: releaseOperationId, recordCommitted: true,
      completionCommitted: false, inFlightInvalidated: true, drainSettled: true,
      routeChanged: restore.routeChanged, routeVerified: false, error }), envelope: record,
    routeReceipt: receipt ?? null });
  }

  const completionOperationId = randomUUID();
  const completion = {
    kind: 'explicit-release-completion',
    operationId: completionOperationId,
    releaseOperationId,
    completedAt: now,
    routeBefore: restore.routeBefore ?? null,
    routeChanged: restore.routeChanged,
    routeVerified: true,
    routeEvidence: clone(receipt),
    recordCommit: { kind: 'explicit-release-completion', operationId: completionOperationId,
      previousRevision: record.revision, nextRevision: record.revision + 1 },
  };
  const intent = { ...record.intent, releaseCompletion: completion };
  try {
    const envelope = store.compareAndSwap({ expectedRevision: record.revision, intent,
      operationId: completionOperationId });
    return Object.freeze({ kind: 'released', recordCommitted: true, completionCommitted: true,
      inFlightInvalidated: true, drainSettled: true, routeChanged: restore.routeChanged,
      routeVerified: true, operationId: releaseOperationId, envelope, routeReceipt: receipt });
  } catch (error) {
    const after = (() => { try { return store.read(); } catch { return null; } })();
    const completion = after?.intent?.releaseCompletion;
    if (completion?.releaseOperationId === releaseOperationId && completion.routeVerified === true) {
      return Object.freeze({ kind: 'released', recordCommitted: true, completionCommitted: true,
        inFlightInvalidated: true, drainSettled: true, routeChanged: restore.routeChanged,
        routeVerified: true, operationId: releaseOperationId, envelope: after,
        routeReceipt: receipt, completionSource: 'recovery', resolution: 'same-release-completion' });
    }
    if (after?.intent?.releaseCompletion?.operationId === completionOperationId) {
      return Object.freeze({ kind: 'released', recordCommitted: true, completionCommitted: true,
        inFlightInvalidated: true, drainSettled: true, routeChanged: restore.routeChanged,
        routeVerified: true, operationId: releaseOperationId, envelope: after,
        routeReceipt: receipt, resolution: 'same-operation-readback' });
    }
    return Object.freeze({ ...releaseOutcome({ operationId: releaseOperationId, recordCommitted: true,
      completionCommitted: error.code === 'CONTROL_RECORD_COMMIT_UNCERTAIN' ? null : false,
      inFlightInvalidated: true, drainSettled: true, routeChanged: restore.routeChanged,
      routeVerified: true, error }), envelope: record, routeReceipt: receipt });
  }
}

/**
 * Commit an explicit release intent, then attempt route restoration and
 * verification. The record commit and the route result are deliberately
 * separate; no host route is changed by this module.
 */
export async function commitExplicitRelease({ store, owner, controller, reason = 'explicit-user-release',
  operationId = randomUUID(), now = new Date().toISOString(), counterBaseline } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.compareAndSwap !== 'function') {
    fail('CONTROL_RELEASE_ARGUMENT_INVALID', 'A readable and CAS-capable control store is required.');
  }
  if (!object(owner) || !UUID.test(owner.hostId) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || !text(owner.entryId) || !text(owner.moduleName) || !text(owner.provider)
    || owner.uid === undefined || owner.uid === null) {
    fail('CONTROL_RELEASE_ARGUMENT_INVALID', 'A complete live owner lease is required.');
  }
  if (!text(reason) || !UUID.test(operationId) || !time(now)) {
    fail('CONTROL_RELEASE_ARGUMENT_INVALID', 'Release requires a reason, UUID operation ID and timestamp.');
  }
  if (!Number.isSafeInteger(counterBaseline) || counterBaseline < 0) {
    fail('CONTROL_RELEASE_COUNTER_BASELINE_REQUIRED',
      'Release requires the original-search counter value observed before invalidation.');
  }
  assertController(controller);

  const before = store.read();
  if (!before) fail('CONTROL_RELEASE_RECORD_MISSING', 'No control record exists to release.');
  if (before.intent.policy === 'released') {
    if (before.intent.release?.operationId !== operationId) {
      fail('CONTROL_RELEASE_ALREADY_RELEASED', 'The control intent is already released by another operation.');
    }
    if (before.intent.releaseCompletion) {
      return Object.freeze({ kind: 'already-released', recordCommitted: false, completionCommitted: true,
        routeChanged: before.intent.releaseCompletion.routeChanged === true,
        routeVerified: before.intent.releaseCompletion.routeVerified === true,
        operationId, envelope: before });
    }
    return finishExplicitRelease({ store, record: before, owner, controller, reason, now,
      releaseOperationId: operationId });
  }
  if (before.intent.pause?.confirmed === true || before.intent.release !== null) {
    fail('CONTROL_RELEASE_CONFLICT', 'A confirmed pause or existing release blocks this release.');
  }
  assertLease(before.intent.lease, owner);

  let invalidated = false, drained = false;
  try {
    const invalidation = controller.invalidate({ reason, operationId, owner: clone(owner) });
    if (invalidation && typeof invalidation.then === 'function') {
      fail('CONTROL_RELEASE_INVALIDATION_ASYNC', 'Release invalidation must complete synchronously.');
    }
    if (!object(invalidation) || invalidation.stopping !== true || invalidation.available !== false) {
      fail('CONTROL_RELEASE_INVALIDATION_INVALID', 'Release invalidation must set stopping=true and available=false.');
    }
    invalidated = true;
    const drainedState = await controller.drain({ reason, operationId, owner: clone(owner) });
    if (!object(drainedState) || drainedState.settled !== true || drainedState.remaining !== 0) {
      fail('CONTROL_RELEASE_DRAIN_INCOMPLETE', 'In-flight work did not settle before release commit.');
    }
    drained = true;
  } catch (error) {
    const outcome = Object.freeze(releaseOutcome({ operationId, recordCommitted: false,
      completionCommitted: false, inFlightInvalidated: invalidated, drainSettled: drained, error }));
    if (error instanceof ControlRecordError) {
      error.releaseOutcome = outcome;
      throw error;
    }
    const wrapped = new ControlRecordError('CONTROL_RELEASE_IN_FLIGHT',
      error?.message ?? String(error), { causeCode: error?.code ?? null });
    wrapped.cause = error;
    wrapped.releaseOutcome = outcome;
    throw wrapped;
  }

  const release = {
    explicit: true,
    committedAt: now,
    kind: 'intent-release-commit',
    operationId,
    hostId: owner.hostId,
    pid: owner.pid,
    author: before.intent.acquisition?.authorSearchProvider ?? null,
    counterBaseline,
    routeChanged: false,
    routeVerified: false,
  };
  const intent = {
    ...before.intent,
    policy: 'released',
    reason,
    priorIntent: clone(before.intent),
    pause: { confirmed: true, reason, observedAt: now },
    release,
  };
  let committed;
  try {
    committed = store.compareAndSwap({ expectedRevision: before.revision, intent, operationId });
  } catch (error) {
    if (error instanceof ControlRecordError) {
      error.releaseOutcome = Object.freeze(releaseOutcome({ operationId,
        recordCommitted: error.code === 'CONTROL_RECORD_COMMIT_UNCERTAIN' ? null : false,
        completionCommitted: false, inFlightInvalidated: true, drainSettled: true, error }));
    }
    throw error;
  }
  return finishExplicitRelease({ store, record: committed, owner, controller, reason, now,
    releaseOperationId: operationId });
}
