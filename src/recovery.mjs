import { randomUUID } from 'node:crypto';
import { ControlRecordError } from './core/control-intent-store.mjs';
import { completeDeferredStartup, completeReleaseRecovery } from './core/startup-recovery.mjs';
import {
  PRODUCT_SEARCH_BUNDLE, PRODUCT_RECOVERY_BUNDLE,
  PRODUCT_HOST_ID, createProductStore, createRecoveryObservation, readSelection, restoreAuthorRoute,
} from './core/product-control.mjs';

export const name = 'dsh-grok-search-recovery';
export const inject = ['loader', 'profileContext'];

export function apply(ctx) {
  const store = createProductStore(ctx);
  const loadId = randomUUID();
  let disposed = false;
  let task = null;
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
  const run = reason => {
    if (task) return task;
    state.phase = 'checking';
    task = (async () => {
      if (disposed) {
        state.phase = 'disposed';
        return snapshot();
      }
      const before = setRecord(store.read());
      if (!before) {
        state.phase = 'no-record';
        return snapshot();
      }
      const incompleteRelease = before.intent.policy === 'released'
        && before.intent.release?.kind === 'intent-release-commit'
        && !before.intent.releaseCompletion;
      if (before.intent.policy === 'released' && !incompleteRelease
        && before.intent.release?.explicit !== true) {
        state.phase = 'already-released';
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
      // Release ownership follows the process identity, not the momentary service
      // registration: restoring the web route restarts the control fiber, so the owner
      // service can be briefly absent while its release task is still in flight. A
      // release intent committed by this process is always left to that task; only a
      // release left behind by a previous process is finished here (D-28).
      if (incompleteRelease && before.intent.release?.hostId === PRODUCT_HOST_ID) {
        state.phase = 'owner-present';
        state.outcome = { kind: 'owner-present', recordCommitted: false, routeChanged: false };
        return snapshot();
      }
      if (incompleteRelease) {
        const outcome = await completeReleaseRecovery({
          store,
          observe: async () => createRecoveryObservation(ctx, loadId),
          restoreRoute: ({ priorIntent }) => restoreAuthorRoute(ctx, priorIntent),
          verifyRoute,
          operationId: randomUUID(),
        });
        const control = ctx.get('grokSearchControl');
        if (control?.retry) await Promise.resolve(control.retry()).catch(() => {});
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
        return snapshot();
      }
      if (before.intent.lease?.hostId === PRODUCT_HOST_ID && ctx.get('grokSearchControl')) {
        state.phase = 'same-host';
        state.outcome = { kind: 'same-host', recordCommitted: false, routeChanged: false };
        return snapshot();
      }
      const outcome = await completeDeferredStartup({
        store,
        observe: async () => createRecoveryObservation(ctx, loadId),
        verifyRoute,
        restoreRoute: ({ priorIntent }) => restoreAuthorRoute(ctx, priorIntent),
        operationId: randomUUID(),
      });
      state.phase = outcome.kind;
      state.outcome = outcome;
      setRecord(store.read());
      state.error = null;
      return snapshot();
    })().catch(error => {
      state.phase = 'incomplete';
      state.error = { code: error.code ?? null, message: error.message };
      state.outcome = error.recoveryOutcome ?? { kind: 'incomplete', recordCommitted: false,
        routeVerified: false, routeChanged: false };
      if (error.code === 'CONTROL_ROUTE_COUNTER_REQUIRED') return snapshot();
      throw error;
    }).finally(() => { task = null; });
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
    state.phase = 'disposed';
  });
}
