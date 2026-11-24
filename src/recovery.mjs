import { randomUUID } from 'node:crypto';
import { ControlRecordError } from './core/control-intent-store.mjs';
import { completeDeferredStartup, completeReleaseRecovery } from './core/startup-recovery.mjs';
import {
  PRODUCT_SEARCH_BUNDLE, PRODUCT_RECOVERY_BUNDLE,
  PRODUCT_HOST_ID, createProductStore, createRecoveryObservation, readSelection, restoreAuthorRoute, routeReceipt,
  productRuntimeCleanupInFlight, onProductRuntimeCleanupIdle,
} from './core/product-control.mjs';

export const name = 'dsh-grok-search-recovery';
export const inject = ['loader', 'profileContext'];

export function apply(ctx, { store: suppliedStore = null, onSettled = null } = {}) {
  const store = suppliedStore ?? createProductStore(ctx);
  const loadId = randomUUID();
  let disposed = false;
  let task = null;
  let releaseUnsubscribe = null, waitingOperationId = null, rerun = false, queued = null;
  const lifetime = new AbortController();
  const state = {
    phase: 'idle',
    outcome: null,
    error: null,
    recordEnvelope: null,
    loadId,
    hostId: PRODUCT_HOST_ID,
    path: store.directory,
    routeReceiptRequired: true,
  };
  const snapshot = () => structuredClone(state);
  const setRecord = envelope => {
    state.recordEnvelope = envelope;
    return envelope;
  };
  const assertCleanupIdle = () => {
    if (productRuntimeCleanupInFlight(store)) throw new ControlRecordError('CONTROL_RUNTIME_CLEANUP_PENDING',
      'The previous runtime has not completed cleanup.', { retriable: true });
  };
  const readCurrent = ({ observation, routeChanged, counterBaseline }) => {
    assertCleanupIdle();
    return {
      observation: createRecoveryObservation(ctx, loadId),
      receipt: routeReceipt(ctx, {
        authorSearchProvider: observation.authorSearchProvider,
        authorFetchProvider: observation.authorFetchProvider,
        expectedInjectSha256: observation.authorInjectSha256,
        routeChanged, counterBaseline,
      }),
    };
  };
  const forgetRelease = () => {
    releaseUnsubscribe?.();
    releaseUnsubscribe = null;
    waitingOperationId = null;
  };
  const scheduleRecovery = () => {
    if (disposed) return;
    if (task) { rerun = true; return; }
    if (queued) return;
    queued = setImmediate(() => {
      queued = null;
      if (!disposed) void run('release-idle').catch(error => ctx.logger?.error?.(error));
    });
  };
  const run = reason => {
    if (task) return task;
    state.phase = 'checking';
    task = (async () => {
      if (disposed) {
        state.phase = 'disposed';
        return snapshot();
      }
      const before = setRecord(store.read());
      const operationId = before?.intent.release?.operationId;
      if (waitingOperationId !== operationId) forgetRelease();
      if (!before) {
        state.phase = 'no-record';
        state.error = null;
        return snapshot();
      }
      const incompleteRelease = before.intent.policy === 'released'
        && before.intent.release?.kind === 'intent-release-commit'
        && !before.intent.releaseCompletion;
      if (before.intent.policy === 'released' && !incompleteRelease
        && before.intent.release?.explicit !== true) {
        state.phase = 'already-released';
        state.error = null;
        return snapshot();
      }
      const verifier = ctx.get('grokSearchRouteVerifier');
      const verifyRoute = typeof verifier === 'function' ? verifier : verifier?.verify;
      if (typeof verifyRoute !== 'function') {
        const error = new ControlRecordError('CONTROL_RECOVERY_ROUTE_RECEIPT_REQUIRED',
          'No product route receipt is available; the required record was preserved.');
        state.phase = 'wiring-incomplete';
        state.error = { code: error.code, message: error.message };
        state.outcome = { kind: 'incomplete', recordCommitted: false, routeChanged: false };
        return snapshot();
      }
      // A service can disappear during teardown while its release is still running.
      // Process identity alone cannot distinguish that from a finished, failed owner.
      if (incompleteRelease && productRuntimeCleanupInFlight(store)) {
        if (!releaseUnsubscribe) {
          waitingOperationId = operationId;
          releaseUnsubscribe = onProductRuntimeCleanupIdle(store, scheduleRecovery);
        }
        state.phase = 'owner-present';
        state.error = null;
        state.outcome = { kind: 'owner-present', recordCommitted: false, routeChanged: false };
        return snapshot();
      }
      forgetRelease();
      if (incompleteRelease) {
        const outcome = await completeReleaseRecovery({
          store,
          observe: async () => createRecoveryObservation(ctx, loadId),
          restoreRoute: ({ priorIntent }) => { assertCleanupIdle(); return restoreAuthorRoute(ctx, priorIntent); },
          verifyRoute,
          readCurrent,
          operationId: randomUUID(),
          signal: lifetime.signal,
        });
        if (disposed) return snapshot();
        const control = ctx.get('grokSearchControl');
        if (control?.retry) await Promise.resolve(control.retry()).catch(() => {});
        if (disposed) return snapshot();
        state.phase = outcome.kind;
        state.outcome = outcome;
        setRecord(store.read());
        state.error = null;
        return snapshot();
      }
      // A still-selected single bundle owns its own record: takeover stays with the
      // control entry and the recovery entry never corrects or releases it (D-28 Q1).
      if (readSelection(ctx).bundles.includes(PRODUCT_SEARCH_BUNDLE)) {
        state.phase = 'still-selected';
        state.error = null;
        return snapshot();
      }
      if (before.intent.lease?.hostId === PRODUCT_HOST_ID && ctx.get('grokSearchControl')) {
        state.phase = 'same-host';
        state.error = null;
        state.outcome = { kind: 'same-host', recordCommitted: false, routeChanged: false };
        return snapshot();
      }
      const outcome = await completeDeferredStartup({
        store,
        observe: async () => createRecoveryObservation(ctx, loadId),
        verifyRoute,
        readCurrent,
        restoreRoute: ({ priorIntent }) => restoreAuthorRoute(ctx, priorIntent),
        operationId: randomUUID(),
        signal: lifetime.signal,
      });
      if (disposed) return snapshot();
      state.phase = outcome.kind;
      state.outcome = outcome;
      setRecord(store.read());
      state.error = null;
      return snapshot();
    })().catch(error => {
      if (disposed) return snapshot();
      state.phase = 'incomplete';
      state.error = { code: error.code ?? null, message: error.message };
      state.outcome = error.recoveryOutcome ?? { kind: 'incomplete', recordCommitted: false,
        routeVerified: false, routeChanged: false };
      if (error.code === 'CONTROL_RUNTIME_CLEANUP_PENDING' && !releaseUnsubscribe) {
        releaseUnsubscribe = onProductRuntimeCleanupIdle(store, scheduleRecovery);
      }
      if (error.code === 'CONTROL_ROUTE_COUNTER_REQUIRED') return snapshot();
      throw error;
    }).finally(() => {
      task = null;
      if (!disposed) {
        try { Promise.resolve(onSettled?.(snapshot())).catch(error => ctx.logger?.error?.(error)); }
        catch (error) { ctx.logger?.error?.(error); }
        if (rerun) { rerun = false; scheduleRecovery(); }
      }
    });
    return task;
  };
  const background = reason => { if (!disposed) void run(reason).catch(error => ctx.logger?.error?.(error)); };
  ctx.provide('grokSearchRecovery', {
    snapshot,
    retry: () => run('explicit-retry'),
    path: store.directory,
    productBundle: PRODUCT_SEARCH_BUNDLE,
    recoveryBundle: PRODUCT_RECOVERY_BUNDLE,
  });
  ctx.on('app-boot/config-reload', () => background('config-reload'));
  ctx.on('plugin-manager/changed', () => background('manager-change'));
  // A single aggregate bundle starts control and recovery concurrently. Wait
  // for the owner service before the first observation; otherwise recovery can
  // race the owner's initial CAS and permanently cache a false `no-record`
  // state, leaving startup without the expected still-selected receipt.
  ctx.inject(['web', 'grokSearchControl'], () => background('legal-web-activation'));
  ctx.effect(() => () => {
    disposed = true;
    forgetRelease();
    clearImmediate(queued);
    queued = null;
    lifetime.abort(new ControlRecordError('CONTROL_RECOVERY_CANCELLED', 'The recovery owner was disposed.'));
    state.phase = 'disposed';
  });
}
