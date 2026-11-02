import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ControlRecordError } from './control-intent-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const identity = value => (typeof value === 'string' && value.length > 0) || (Number.isSafeInteger(value) && value >= 0);
const fail = code => { throw new ControlRecordError(code); };
function validateObservation(input) {
  const observation = structuredClone(input);
  const component = observation?.component;
  if (!UUID.test(observation?.hostId) || !Number.isFinite(Date.parse(observation?.observedAt))
    || !SHA256.test(observation?.selectionSha256) || !Array.isArray(observation?.selectedBundles)
    || observation.selectedBundles.some(value => typeof value !== 'string' || value.length === 0)
    || new Set(observation.selectedBundles).size !== observation.selectedBundles.length
    || typeof observation.searchBundle !== 'string' || typeof observation.recoveryBundle !== 'string'
    || !(observation.authorSearchProvider === null || typeof observation.authorSearchProvider === 'string')
    || (observation.authorSearchProviderPresent !== undefined && typeof observation.authorSearchProviderPresent !== 'boolean')
    || (observation.authorFetchProvider !== undefined && observation.authorFetchProvider !== null
      && typeof observation.authorFetchProvider !== 'string')
    || (observation.authorInjectSha256 !== undefined && !SHA256.test(observation.authorInjectSha256))
    || (observation.ownerPresent !== undefined && typeof observation.ownerPresent !== 'boolean')) {
    fail('CONTROL_RECOVERY_OBSERVATION_INVALID');
  }
  if (!component || component.legalLoad !== true || !UUID.test(component.loadId) || !identity(component.ownerUid)
    || !['recovery', 'search-owner'].includes(component.role)
    || component.bundle !== (component.role === 'recovery' ? observation.recoveryBundle : observation.searchBundle)
    || !observation.selectedBundles.includes(component.bundle)) fail('CONTROL_LEGAL_LOAD_REQUIRED');
  return observation;
}
function stableObservation({ observedAt: _observedAt, ...rest }) { return rest; }
const outcome = (kind, envelope, extra = {}) => ({ kind, envelope, recordCommitted: false,
  routeVerified: false, routeChanged: false, ...extra });

function validateReceipt(receipt, expectedAuthor, routeChanged, counterBaseline) {
  if (!receipt || receipt.atAuthor !== true || receipt.routeChanged !== routeChanged
    || receipt.fetchPreserved !== true || receipt.dependenciesPreserved !== true
    || receipt.actualSearchProvider !== expectedAuthor || !Number.isSafeInteger(counterBaseline)
    || counterBaseline < 0 || !Number.isSafeInteger(receipt.originalSearchCalls)
    || receipt.originalSearchCalls < counterBaseline || receipt.originalSearchBaseline !== counterBaseline
    || receipt.originalSearchDelta !== receipt.originalSearchCalls - counterBaseline
    || receipt.originalSearchDelta !== 0) {
    fail('CONTROL_RECOVERY_ROUTE_UNVERIFIED');
  }
}

function validateRequiredProvenance(prior, observation) {
  const lease = prior.lease, acquisition = prior.acquisition;
  if (!lease || !UUID.test(lease.hostId) || !acquisition
    || acquisition.source !== 'current-selected-search-bundle' || acquisition.searchBundle !== observation.searchBundle
    || acquisition.hostId !== lease.hostId || !SHA256.test(acquisition.selectionSha256)
    || !Number.isFinite(Date.parse(acquisition.observedAt)) || !identity(acquisition.ownerUid)
    || !Array.isArray(acquisition.selectedBundles) || !acquisition.selectedBundles.includes(observation.searchBundle)
    || lease.entryId !== 'web' || lease.moduleName !== '@deepseek-ai/dsh-web') fail('CONTROL_RECOVERY_PROVENANCE_REQUIRED');
  if (lease.hostId === observation.hostId && observation.ownerPresent !== false) fail('CONTROL_STARTUP_SAME_HOST');
  if (prior.release !== null) fail('CONTROL_RECOVERY_HISTORIC_RELEASE_CONFLICT');
  if (Object.hasOwn(acquisition, 'authorSearchProvider') && acquisition.authorSearchProvider !== observation.authorSearchProvider) fail('CONTROL_RECOVERY_AUTHOR_CHANGED');
  return { lease, acquisition };
}

function releasedProvenance(prior) {
  const release = prior.release;
  const previous = prior.priorIntent;
  if (release?.explicit !== true || release.kind !== 'intent-release-commit'
    || !UUID.test(release.operationId) || !previous || previous.policy !== 'required') {
    fail('CONTROL_RECOVERY_HISTORIC_RELEASE_CONFLICT');
  }
  return previous;
}

/**
 * Official startup-correction branch. The Host adapter must supply actual
 * profile selection, legal component identity and verified route receipts.
 * This core neither authorizes takeover nor silently invents a release.
 * CAS commits one record only; it is not a cross-resource Host transaction.
 */
export async function completeDeferredStartup({ store, observe, verifyRoute, restoreRoute = null,
  operationId = randomUUID() }) {
  if (!store || typeof store.read !== 'function' || typeof store.compareAndSwap !== 'function'
    || typeof observe !== 'function' || typeof verifyRoute !== 'function'
    || (restoreRoute !== null && typeof restoreRoute !== 'function') || !UUID.test(operationId)) {
    fail('CONTROL_RECOVERY_ARGUMENT_INVALID');
  }
  const before = store.read();
  if (!before) return outcome('no-record', null);
  const prior = before.intent;
  if (prior.policy === 'released' && prior.releaseCompletion) {
    return outcome('already-released', before, {
      completionCommitted: true,
      routeChanged: prior.releaseCompletion.routeChanged === true,
      routeVerified: prior.releaseCompletion.routeVerified === true,
    });
  }
  const correctableRelease = prior.policy === 'released' && prior.release?.explicit === true
    && !prior.releaseCompletion
    && prior.priorIntent?.policy === 'required' && prior.release.kind === 'intent-release-commit'
    && UUID.test(prior.release.operationId);
  if (prior.policy === 'released' && !correctableRelease) return outcome(prior.recovery?.action === 'startup-state-correction'
    ? 'already-corrected' : 'already-released', before);
  const observation = validateObservation(await observe());
  if (observation.selectedBundles.includes(observation.searchBundle)) return outcome('still-selected', before);
  const provenance = correctableRelease ? releasedProvenance(prior) : prior;
  const { lease, acquisition } = validateRequiredProvenance(provenance, observation);
  let routeChanged = false;
  if (restoreRoute) {
    const restored = await restoreRoute({ priorIntent: prior, observation });
    if (!restored || typeof restored.routeChanged !== 'boolean') fail('CONTROL_RECOVERY_RESTORE_INVALID');
    routeChanged = restored.routeChanged;
  }
  const counterBaseline = observation.observer?.counter?.calls;
  if (!Number.isSafeInteger(counterBaseline) || counterBaseline < 0) fail('CONTROL_ROUTE_COUNTER_REQUIRED');
  const receipt = structuredClone(await verifyRoute(restoreRoute
    ? { ...observation, routeChanged, counterBaseline } : { ...observation, counterBaseline }));
  validateReceipt(receipt, observation.authorSearchProvider, routeChanged, counterBaseline);
  const latest = validateObservation(await observe());
  if (!isDeepStrictEqual(stableObservation(latest), stableObservation(observation))) fail('CONTROL_RECOVERY_INPUT_CHANGED');
  const recovery = {
    action: 'startup-state-correction', observedAt: observation.observedAt,
    observerHostId: observation.hostId, observerLoadId: observation.component.loadId,
    observerOwnerUid: observation.component.ownerUid, observerBundle: observation.component.bundle,
    selectionSha256: observation.selectionSha256, selectedBundles: observation.selectedBundles,
    authorSearchProvider: observation.authorSearchProvider,
    originalLease: structuredClone(lease),
    historicReleaseCommitted: correctableRelease === true,
    previousPolicy: prior.policy, routeVerified: true, routeChanged,
    routeEvidence: receipt,
    counterBaseline,
    exitEvidence: { source: correctableRelease ? 'explicit-release-then-unselected' : 'profile-bundle-selection',
      searchBundle: observation.searchBundle,
      previousSelectionSha256: acquisition.selectionSha256, observedSelectionSha256: observation.selectionSha256,
      searchBundleSelected: false, userClickObserved: false, ordinaryDisposeIsRelease: false,
      ...(observation.ownerPresent === false ? { ownerAbsent: true } : {}) },
    recordCommit: { kind: 'startup-correction', operationId,
      previousRevision: before.revision, nextRevision: before.revision + 1 },
  };
  const { releaseCompletion: archivedCompletion, ...archivedIntent } = prior;
  const intent = { ...archivedIntent, policy: 'released', reason: 'legal-load-observed-unselected-at-author',
    priorIntent: structuredClone(prior), recovery, release: null };
  try {
    const envelope = store.compareAndSwap({ expectedRevision: before.revision, intent, operationId });
    return outcome('corrected', envelope, { recordCommitted: true, routeVerified: true, routeChanged });
  } catch (error) {
    if (error instanceof ControlRecordError) {
      error.recoveryOutcome = Object.freeze({ kind: 'incomplete', routeVerified: true, routeChanged,
        recordCommitted: error.code === 'CONTROL_RECORD_COMMIT_UNCERTAIN' ? null : false,
        operationId, expectedRevision: before.revision });
    }
    throw error;
  }
}

/**
 * Finish an explicit release whose intent was committed before the route
 * restoration or its completion record. The historical release receipt is
 * preserved; this branch adds only startup completion evidence.
 */
export async function completeReleaseRecovery({ store, observe, restoreRoute, verifyRoute,
  operationId = randomUUID() }) {
  if (!store || typeof store.read !== 'function' || typeof store.compareAndSwap !== 'function'
    || typeof observe !== 'function' || typeof restoreRoute !== 'function'
    || typeof verifyRoute !== 'function' || !UUID.test(operationId)) {
    fail('CONTROL_RECOVERY_ARGUMENT_INVALID');
  }
  const before = store.read();
  if (!before) return outcome('no-record', null);
  const prior = before.intent;
  if (prior.policy !== 'released') return outcome('not-released', before);
  if (prior.releaseCompletion) {
    return outcome('already-completed', before, { completionCommitted: true,
      routeChanged: prior.releaseCompletion.routeChanged === true, routeVerified: true });
  }
  if (!prior.release || prior.release.kind !== 'intent-release-commit' || prior.release.explicit !== true
    || !UUID.test(prior.release.operationId) || !prior.priorIntent) {
    fail('CONTROL_RECOVERY_HISTORIC_RELEASE_CONFLICT');
  }
  const observation = validateObservation(await observe());
  if (observation.component.role !== 'recovery') fail('CONTROL_RECOVERY_COMPONENT_REQUIRED');
  const priorIntent = prior.priorIntent;
  const acquisition = priorIntent.acquisition;
  if (!priorIntent.lease || !acquisition || acquisition.searchBundle !== observation.searchBundle
    || (Object.hasOwn(acquisition, 'authorSearchProvider')
      && acquisition.authorSearchProvider !== observation.authorSearchProvider)) {
    fail('CONTROL_RECOVERY_PROVENANCE_REQUIRED');
  }
  const counterBaseline = observation.observer?.counter?.calls;
  if (!Number.isSafeInteger(counterBaseline) || counterBaseline < 0) fail('CONTROL_ROUTE_COUNTER_REQUIRED');
  const restored = await restoreRoute({ priorIntent, observation, counterBaseline });
  if (!restored || typeof restored.routeChanged !== 'boolean') fail('CONTROL_RECOVERY_RESTORE_INVALID');
  const routeChanged = restored.routeChanged;
  const receipt = structuredClone(await verifyRoute({ ...observation, routeChanged, counterBaseline }));
  validateReceipt(receipt, acquisition.authorSearchProvider, routeChanged, counterBaseline);
  const latest = validateObservation(await observe());
  if (!isDeepStrictEqual(stableObservation(latest), stableObservation(observation))) fail('CONTROL_RECOVERY_INPUT_CHANGED');
  const completion = {
    kind: 'explicit-release-completion', operationId, releaseOperationId: prior.release.operationId,
    completedAt: observation.observedAt, routeChanged, routeVerified: true,
    routeEvidence: receipt,
    counterBaseline,
    recordCommit: { kind: 'explicit-release-recovery', operationId,
      previousRevision: before.revision, nextRevision: before.revision + 1 },
  };
  const recovery = {
    action: 'explicit-release-recovery', observedAt: observation.observedAt,
    observerHostId: observation.hostId, observerLoadId: observation.component.loadId,
    observerOwnerUid: observation.component.ownerUid, observerBundle: observation.component.bundle,
    selectionSha256: observation.selectionSha256, selectedBundles: observation.selectedBundles,
    authorSearchProvider: observation.authorSearchProvider,
    originalLease: structuredClone(priorIntent.lease), historicReleaseCommitted: true,
    previousPolicy: 'released', routeVerified: true, routeChanged,
    releaseOperationId: prior.release.operationId, routeEvidence: receipt,
    exitEvidence: { source: 'explicit-release-intent', searchBundle: observation.searchBundle,
      previousSelectionSha256: acquisition.selectionSha256, observedSelectionSha256: observation.selectionSha256,
      searchBundleSelected: observation.selectedBundles.includes(observation.searchBundle),
      userClickObserved: false, ordinaryDisposeIsRelease: false, routeChanged },
    recordCommit: { kind: 'explicit-release-recovery', operationId,
      previousRevision: before.revision, nextRevision: before.revision + 1 },
  };
  const intent = { ...prior, releaseCompletion: completion, recovery };
  try {
    const envelope = store.compareAndSwap({ expectedRevision: before.revision, intent, operationId });
    return outcome('completed', envelope, { recordCommitted: true, completionCommitted: true,
      routeVerified: true, routeChanged });
  } catch (error) {
    if (error instanceof ControlRecordError) {
      error.recoveryOutcome = Object.freeze({ kind: 'incomplete', routeVerified: true, routeChanged,
        recordCommitted: error.code === 'CONTROL_RECORD_COMMIT_UNCERTAIN' ? null : false,
        completionCommitted: error.code === 'CONTROL_RECORD_COMMIT_UNCERTAIN' ? null : false,
        operationId, expectedRevision: before.revision });
    }
    throw error;
  }
}
