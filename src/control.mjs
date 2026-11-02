import { randomUUID } from 'node:crypto';
import { ControlRecordError } from './core/control-intent-store.mjs';
import { commitExplicitRelease } from './core/release-transaction.mjs';
import {
  PRODUCT_SEARCH_BUNDLE, PRODUCT_RECOVERY_BUNDLE, PRODUCT_HOST_ID,
  createAcquisition, createLease, createProductReleaseController, createProductStore,
  originalSearchCounter, readSelection, takeOverAuthorRoute,
} from './core/product-control.mjs';

export const name = 'dsh-grok-search-control';
export const inject = ['loader', 'profileContext', 'grokSearchCore'];

export function projectPublicSnapshot(current, disposed = false) {
  const completionCommitted = current.releaseOutcome?.completionCommitted === true
    || Boolean(current.record?.releaseCompletion)
    || Boolean(current.record?.recovery);
  return {
    phase: current.phase,
    policy: current.record?.policy ?? null,
    revision: current.revision,
    releaseOperationId: current.releaseOperationId,
    completionCommitted,
    // Verified means a completion or a startup correction recorded its own route receipt;
    // a committed release intent alone is not shown as restored.
    routeVerified: current.releaseOutcome?.routeVerified === true
      || current.record?.releaseCompletion?.routeVerified === true
      || current.record?.recovery?.routeVerified === true,
    routeChanged: current.releaseOutcome?.routeChanged === true
      || current.record?.releaseCompletion?.routeChanged === true,
    error: current.error,
    canStop: !disposed && current.phase === 'required' && current.record?.policy === 'required'
      && current.record?.release === null && current.record?.pause?.confirmed !== true,
  };
}

export async function apply(ctx, { counterSnapshot = null } = {}) {
  const store = createProductStore(ctx);
  let disposed = false;
  let routeVerifier = null;
  let task = null;
  let releaseTask = null;
  let acquired = false;
  ctx.inject(['grokSearchRouteVerifier'], () => { routeVerifier = ctx.get('grokSearchRouteVerifier'); });
  let releaseOperationId = null;
  const state = {
    phase: 'idle',
    record: null,
    recordEnvelope: null,
    revision: 0,
    error: null,
    releaseOutcome: null,
    releaseOperationId: null,
    routeChanged: false,
    hostId: PRODUCT_HOST_ID,
    path: store.directory,
  };
  const snapshot = () => {
    if (!state.releaseOutcome) {
      try {
        const current = store.read();
        const completion = current?.intent?.releaseCompletion;
        if (completion && current.intent.policy === 'released') {
          state.releaseOutcome = { kind: 'released', recordCommitted: false, completionCommitted: true,
            routeChanged: completion.routeChanged === true, routeVerified: completion.routeVerified === true,
            operationId: current.intent.release?.operationId ?? null };
          state.releaseOperationId = current.intent.release?.operationId ?? null;
          state.phase = 'released';
          state.recordEnvelope = current;
          state.record = current.intent;
          state.revision = current.revision;
        }
      } catch {}
    }
    return structuredClone(state);
  };
  const setRecord = envelope => {
    state.recordEnvelope = envelope;
    state.record = envelope?.intent ?? null;
    state.revision = envelope?.revision ?? 0;
    return envelope;
  };
  const acquisitionChanged = (recorded, current) => !recorded
    || recorded.authorSearchProvider !== current.authorSearchProvider
    || recorded.authorSearchProviderPresent !== current.authorSearchProviderPresent
    || recorded.authorFetchProvider !== current.authorFetchProvider
    || recorded.authorInjectSha256 !== current.authorInjectSha256;
  const sameLease = (lease, current) => lease?.hostId === current.hostId && lease?.uid === current.uid
    && lease?.entryId === current.entryId && lease?.moduleName === current.moduleName
    && lease?.provider === current.provider;
  const requiredIntent = (selection, acquisition, lease, prior = null) => ({
    schemaVersion: 1,
    policy: 'required',
    reason: 'product-current-selection',
    acquiredSelection: [...selection.bundles],
    acquisition,
    lease,
    // Every complete prior revision remains in the immutable store. Keep one
    // immediate evidence object here instead of recursively nesting all toggles.
    priorIntent: prior ? Object.fromEntries(Object.entries(structuredClone(prior))
      .map(([key, value]) => [key, key === 'priorIntent' ? null : value])) : null,
    release: null,
    ...(prior?.migration ? { migration: structuredClone(prior.migration) } : {}),
  });
  const refresh = () => {
    if (releaseTask) return releaseTask;
    if (task) return task;
    state.phase = 'checking';
    task = (async () => {
      if (disposed) {
        state.phase = 'disposed';
        return snapshot();
      }
      const selection = readSelection(ctx);
      if (!selection.bundles.includes(PRODUCT_SEARCH_BUNDLE)) {
        state.phase = 'not-selected';
        return snapshot();
      }
      let existing = store.read();
      setRecord(existing);
      if (existing?.intent.policy === 'released' && (acquired || !existing.intent.releaseCompletion
        && !existing.intent.recovery)) {
        const completion = existing.intent.releaseCompletion;
        state.phase = 'released';
        state.releaseOutcome = completion ? { kind: 'released', recordCommitted: false,
          completionCommitted: true, routeChanged: completion.routeChanged === true,
          routeVerified: completion.routeVerified === true,
          operationId: existing.intent.release?.operationId ?? null } : null;
        state.error = null;
        return snapshot();
      }
      if (existing && acquired && (existing.intent.pause?.confirmed === true || existing.intent.release !== null)) {
        state.phase = 'stopped';
        state.error = null;
        return snapshot();
      }
      const currentLease = createLease(ctx);
      const currentAcquisition = createAcquisition(ctx);
      const reactivating = existing?.intent.policy === 'released' || existing?.intent.pause?.confirmed === true;
      if (reactivating) {
        existing = store.compareAndSwap({ expectedRevision: existing.revision,
          intent: requiredIntent(selection, currentAcquisition, currentLease, existing.intent) });
        setRecord(existing);
        state.releaseOutcome = null;
        state.releaseOperationId = null;
        releaseOperationId = null;
      } else if (existing) {
        const recorded = existing.intent.acquisition;
        const recordedPresent = recorded && Object.hasOwn(recorded, 'authorSearchProviderPresent')
          ? recorded.authorSearchProviderPresent : recorded?.authorSearchProvider !== null;
        if (recorded?.authorSearchProvider !== currentAcquisition.authorSearchProvider
          || recordedPresent !== currentAcquisition.authorSearchProviderPresent) {
          state.phase = 'conflict';
          state.error = { code: 'CONTROL_SEARCH_SELECTION_CONFLICT',
            message: 'The current author search selection differs from the recorded ownership intent.' };
          return snapshot();
        }
        if (!sameLease(existing.intent.lease, currentLease) || acquisitionChanged(recorded, currentAcquisition)) {
          const intent = requiredIntent(selection, currentAcquisition, currentLease, existing.intent);
          existing = store.compareAndSwap({ expectedRevision: existing.revision, intent });
          setRecord(existing);
        }
      } else {
        const intent = requiredIntent(selection, currentAcquisition, currentLease);
        existing = store.compareAndSwap({ expectedRevision: 0, intent });
        setRecord(existing);
      }
      const core = ctx.get('grokSearchCore');
      if (!core) throw new ControlRecordError('CONTROL_RELEASE_CORE_REQUIRED',
        'The query core must be loaded before the product owner can take over search.');
      const takeover = await takeOverAuthorRoute(ctx, existing.intent.acquisition, existing.intent.lease);
      acquired = true;
      state.phase = 'required';
      state.error = null;
      state.routeChanged = takeover.routeChanged;
      return snapshot();
    })().catch(error => {
      state.phase = 'incomplete';
      state.error = { code: error.code ?? null, message: error.message };
      throw error;
    }).finally(() => { task = null; });
    return task;
  };
  const stop = (reason, { unloading = false } = {}) => {
    if (disposed) return Promise.reject(new ControlRecordError('CONTROL_OWNER_ABSENT', 'The product owner is absent.'));
    if (releaseTask) return releaseTask;
    const stopFailure = error => {
      state.phase = 'incomplete';
      state.error = { code: error?.code ?? null, message: error?.message ?? String(error) };
      state.releaseOutcome = error?.releaseOutcome ?? state.releaseOutcome;
      try { setRecord(store.read()); } catch {}
      return error;
    };
    let before, priorIntent, owner, controller, counterBaseline;
    try {
      before = store.read();
      if (!before) throw new ControlRecordError('CONTROL_RELEASE_RECORD_MISSING',
        'No control record exists to release.');
      if (before.intent.policy === 'released' && before.intent.releaseCompletion) {
        state.phase = 'released';
        state.releaseOutcome = { kind: 'already-released', recordCommitted: false, completionCommitted: true,
          routeChanged: before.intent.releaseCompletion.routeChanged === true,
          routeVerified: before.intent.releaseCompletion.routeVerified === true };
        state.error = null;
        setRecord(before);
        return Promise.resolve(structuredClone(state.releaseOutcome));
      }
      releaseOperationId ??= before.intent.release?.operationId ?? randomUUID();
      state.releaseOperationId = releaseOperationId;
      priorIntent = before.intent.policy === 'required' ? before.intent : before.intent.priorIntent;
      const core = ctx.get('grokSearchCore');
      counterBaseline = (counterSnapshot ? counterSnapshot() : originalSearchCounter(ctx)).calls;
      owner = createLease(ctx);
      controller = createProductReleaseController({ ctx, priorIntent, core, routeVerifier,
        ...(unloading && counterSnapshot ? { counterSnapshot } : {}),
        onState: phase => { state.phase = phase; } });
    } catch (error) {
      stopFailure(error);
      return Promise.reject(error);
    }
    state.phase = 'stopping';
    state.error = null;
    releaseTask = (async () => {
      const outcome = await commitExplicitRelease({ store, owner, controller,
        reason: reason ?? 'explicit-user-release', operationId: releaseOperationId, counterBaseline });
      state.releaseOutcome = outcome;
      state.phase = outcome.kind === 'released' || outcome.kind === 'already-released' ? 'released' : 'incomplete';
      state.error = outcome.error ?? null;
      setRecord(store.read());
      return outcome;
    })().catch(error => {
      stopFailure(error);
      throw error;
    }).finally(() => { releaseTask = null; });
    return releaseTask;
  };
  const publicSnapshot = () => {
    return projectPublicSnapshot(snapshot(), disposed);
  };
  ctx.on('loader/volatile-update', paths => {
    const searchRouteChanged = Array.isArray(paths) && paths.some(path =>
      Array.isArray(path) && path.length === 2 && path[0] === 'config' && path[1] === 'searchProvider');
    if (searchRouteChanged && !disposed) void refresh().catch(error => ctx.logger?.error?.(error));
  });
  ctx.provide('grokSearchControl', {
    snapshot,
    publicSnapshot,
    retry: () => refresh(),
    stop,
    release: stop,
    path: store.directory,
    productBundle: PRODUCT_SEARCH_BUNDLE,
    recoveryBundle: PRODUCT_RECOVERY_BUNDLE,
  });
  // Startup must not report the control entry as ready while the author route is
  // still active. The web route is volatile, so takeover updates its live config
  // without restarting this dependency fiber.
  await ctx.inject(['web'], async () => { await refresh(); });
  ctx.effect(() => () => {
    disposed = true;
    state.phase = 'disposed';
  });
}
