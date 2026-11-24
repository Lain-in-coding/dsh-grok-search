import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOriginalSearchCounter } from './core/original-search-counter.mjs';
import { createProductStore, createSearchConfigHook, normalizeCounterSnapshot, readSelection, PRODUCT_SEARCH_BUNDLE,
  PRODUCT_PROVIDER_ID, effectiveSearchProvider, webEntry, createAcquisition, authorConfig, selectedId,
  holdProductRelease, productRuntimeCleanupInFlight, onProductRuntimeCleanupIdle }
  from './core/product-control.mjs';
import { projectPublicSnapshot } from './control.mjs';
import { createConnectionSecurity } from './core/connection-security.mjs';
import { createSearchLog } from './core/search-log.mjs';
import { createToolRouteContext } from './core/tool-route-context.mjs';
import { createToolBudgetController } from './core/tool-budget.mjs';
import {
  createRuntimeCompatibility, isConfirmedCoreCompatibilityFault,
} from './core/runtime-compat.mjs';
import { createCompatibilityState } from './core/compatibility-state.mjs';
import { GrokSearchError, cleanupFailure } from './core/errors.mjs';
import { parseGithubUrl } from './core/github-read.mjs';
import { createPrivatePreferences } from './core/private-preferences.mjs';

export const name = 'dsh-grok-search';
export const inject = ['loader', 'profileContext'];
export { Config } from './core/product-config.mjs';
export const ENTRY_ID = 'grok-search';
const pluginVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
const modules = Object.freeze({
  appBoot: () => import('@deepseek-ai/dsh-app-boot'),
  web: () => import('@deepseek-ai/dsh-web'),
  core: () => import('./index.mjs'),
  control: () => import('./control.mjs'),
  recovery: () => import('./recovery.mjs'),
  routeVerifier: () => import('./route-verifier.mjs'),
  program: () => import('./program.mjs'),
  settings: () => import('./settings-ui.mjs'),
  compatibilityService: () => import('./compatibility-service.mjs'),
  github: () => import('./core/github-host.mjs'),
  sharedConfig: () => import('./core/shared-config.mjs'),
});
const loadModule = key => modules[key]();
const unavailable = code => new GrokSearchError(code, 'Search is blocked until runtime compatibility is established.');
const defaultRetryDelay = ms => new Promise(resolve => setTimeout(resolve, ms));
const retriableControlError = (error, code = error?.code) => error?.retriable === true || error?.details?.retriable === true
  || code === 'CONTROL_STORAGE_BUSY' || code === 'CONTROL_CAS_CONFLICT';

// The root deliberately does not depend on web. Its scoped config hook survives
// a WebRuntime rebuild and leaves a missing/unavailable Grok provider fail-closed.
export function apply(ctx, configuration, { load = loadModule,
  createState = createCompatibilityState, createStore = createProductStore,
  createPreferences = createPrivatePreferences, retryDelay = defaultRetryDelay } = {}) {
  let store = null, coordinator = null, stateStore = null, appBoot = null;
  let destroyed = false, disabling = false, userStopped = false, releaseTask = null;
  let activeContext = null, lifecycleContext = null, lifecycleTask = null, generation = null;
  let lifecycleAttempt = null;
  let pumping = null, repump = false, bootstrapReady = false, stateUnsubscribe = null;
  let startAttempt = null, recheckTask = null, settingsAttempt = null;
  let startupInitialized = false, startupToken = null, startupError = null;
  let userIntent = 0, retryingRelease = false;
  let startupReleasePending = false, startupReleaseOperationId = null, runtimeRetryTask = null;
  let startupReleaseRecord = null, startupSupersession = null;
  let runtimeCleanupPending = false, cleanupUnsubscribe = null;
  let failureCount = 0, retrySequence = 0;
  let retiring = null, githubPreferences = null;
  const rootFiber = ctx.fiber, rootEntry = rootFiber.entry;
  const stateListeners = new Set(), pending = new Set();
  const webExecutions = new AsyncLocalStorage();
  const backgroundError = error => ctx.logger?.warn?.('dsh-grok-search: %s',
    typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'COMPATIBILITY_BLOCKED');
  const track = task => {
    pending.add(task);
    task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  const required = () => {
    if (disabling) return false;
    try { return !store || store.read()?.intent.policy !== 'released'; }
    catch (error) { backgroundError(error); return true; }
  };
  const searchReleased = () => {
    if (!userStopped || !store) return false;
    try {
      const intent = store.read()?.intent;
      return intent?.policy === 'released' && Boolean(intent.releaseCompletion || intent.recovery)
        && !productRuntimeCleanupInFlight(store);
    } catch { return false; }
  };
  const assertSearchAllowed = operation => {
    refreshRuntimeStatus();
    if (destroyed || userStopped) throw unavailable('COMPATIBILITY_STOPPED');
    if (!coordinator) throw unavailable('COMPATIBILITY_CHECKING');
    try { coordinator.assertSearchAllowed(operation); }
    catch (error) { throw unavailable(error?.code ?? 'COMPATIBILITY_BLOCKED'); }
    let routed = false;
    try { routed = effectiveSearchProvider(webEntry(activeContext ?? ctx)) === PRODUCT_PROVIDER_ID; } catch {}
    if (!routed) {
      if (generation?.owner?.refreshing?.()) throw unavailable('COMPATIBILITY_CHECKING');
      const ownerCode = generation?.owner?.publicSnapshot?.()?.error?.code;
      const code = ownerCode === 'CONTROL_SEARCH_SELECTION_CONFLICT' ? ownerCode : 'COMPATIBILITY_ROUTE_UNCONFIRMED';
      coordinator.block(code);
      throw unavailable(code);
    }
    return true;
  };
  const preferences = () => {
    if (githubPreferences) return githubPreferences;
    const candidate = createPreferences({ path: join(ctx.profileContext.dir, 'grok-search', 'preferences.json') });
    if (candidate && typeof candidate.then === 'function') {
      Promise.resolve(candidate).catch(backgroundError);
      throw new GrokSearchError('PREFERENCES_READ_FAILED', 'Plugin preferences must be available synchronously.');
    }
    if (typeof candidate?.snapshot !== 'function') {
      throw new GrokSearchError('PREFERENCES_READ_FAILED', 'Plugin preferences are unavailable.');
    }
    return githubPreferences = candidate;
  };
  const readGithubIntent = () => {
    try {
      const snapshot = preferences().snapshot();
      if (snapshot && typeof snapshot.then === 'function') {
        Promise.resolve(snapshot).catch(backgroundError);
        throw new GrokSearchError('PREFERENCES_READ_FAILED', 'Plugin preferences must be read synchronously.');
      }
      const enabled = snapshot?.value?.githubReadEnabled;
      if (typeof enabled !== 'boolean') throw new GrokSearchError('PREFERENCES_INVALID', 'GitHub preference is unavailable.');
      return enabled;
    } catch (error) { backgroundError(error); return null; }
  };
  // Only a validated false is off; unknown intent must not select the original fetch.
  const githubRequired = () => required() && readGithubIntent() !== false;
  const assertGithubAllowed = (fetch, token = null) => {
    const value = generation;
    let allowed = false;
    try {
      const capability = fetch ? 'githubFetch' : 'githubRead';
      const status = value?.github?.snapshot();
      allowed = value && (token === null || token === value.token) && current(value.token) && coordinator.report().coreReady
        && readGithubIntent() === true
        && value.githubCapabilities?.()[capability] === true && status?.enabled === true && !status.error;
    } catch { /* An unreadable optional state must not select the original fetch provider. */ }
    if (!allowed) throw new GrokSearchError(fetch ? 'GITHUB_FETCH_UNAVAILABLE' : 'GITHUB_UNAVAILABLE',
      'GitHub runtime compatibility is unavailable; this request was not forwarded.');
  };
  const retryCoreCheck = async (token, error) => {
    if (!current(token)) return;
    const code = typeof error?.code === 'string' ? error.code : null;
    if (isConfirmedCoreCompatibilityFault(code)) {
      retrySequence++;
      coordinator.block(code);
      return;
    }
    if (failureCount >= 2) {
      retrySequence++;
      coordinator.block('COMPATIBILITY_CORE_UNAVAILABLE');
      return;
    }
    const waitMs = failureCount === 0 ? 1000 : 3000;
    failureCount++;
    const sequence = ++retrySequence;
    try { await retryDelay(waitMs); } catch { /* A cancelled delay is resolved by the epoch check below. */ }
    if (sequence !== retrySequence || !current(token) || disabling) return;
    coordinator.beginEpoch();
  };
  // Only post-install calls using the known host hooks are protected; pre-import host work is outside this boundary.
  ctx.on('tools/execute', (exec, next) => {
    let githubFetch = false;
    const search = exec?.name === 'web_search' && !searchReleased();
    if (search) assertSearchAllowed('web_search');
    if (exec?.name === 'github_read' && githubRequired()) assertGithubAllowed(false);
    if (exec?.name === 'web_fetch') {
      let known = false;
      try { parseGithubUrl(exec.arguments?.url); known = true; } catch {}
      if (known && githubRequired()) { assertGithubAllowed(true); githubFetch = true; }
    }
    if (!search && !githubFetch) return webExecutions.run(null, () => callRoutes.run(exec, next));
    const execution = { token: coordinator.captureEpoch(), active: true, search };
    return webExecutions.run(execution, () => {
      try {
        const result = callRoutes.run(exec, next);
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).finally(() => { execution.active = false; });
        }
        execution.active = false;
        return result;
      } catch (error) { execution.active = false; throw error; }
    });
  }, { global: true, prepend: true });
  // A paused tool body can outlive its child adapter; retain only its epoch at the root.
  ctx.on('internal/get', (caller, key, accessError, next) => {
    const execution = webExecutions.getStore();
    if (key !== 'web' || !execution) return next();
    const fiber = caller?.fiber;
    if (fiber?.runtime?.name !== 'tool-web' || fiber.entry?.options?.name !== '@deepseek-ai/dsh-tool-web') return next();
    const assertActive = () => {
      if (execution.search) {
        if (!execution.active || !current(execution.token)) throw unavailable('COMPATIBILITY_STOPPED');
        return assertSearchAllowed('web_search');
      }
      if (!execution.active) throw new GrokSearchError('GITHUB_FETCH_UNAVAILABLE', 'The GitHub execution has ended.');
      assertGithubAllowed(true, execution.token);
    };
    assertActive();
    const service = next();
    if (!service) return service;
    return new Proxy(service, { get(target, property, receiver) {
      if (property !== (execution.search ? 'search' : 'fetch')) return Reflect.get(target, property, receiver);
      return function (...args) {
        assertActive();
        return Reflect.get(target, property, target).apply(target, args);
      };
    } });
  }, { global: true, prepend: true });
  ctx.effect(() => () => webExecutions.disable());
  ctx.on('internal/config', createSearchConfigHook({ required }), { global: true, prepend: true });

  const searchLog = createSearchLog(), callRoutes = createToolRouteContext({ searchLog });
  readGithubIntent();
  ctx.provide('grokSearchLog', searchLog);
  ctx.provide('grokSearchCallRoutes', callRoutes);
  ctx.on('tools/result', (exec, result) => callRoutes.finalize(exec, result), { global: true });
  ctx.effect(() => () => { searchLog.dispose(); callRoutes.dispose(); });
  const connectionSecurity = createConnectionSecurity();
  ctx.provide('grokSearchConnectionSecurity', connectionSecurity);
  ctx.on('connection/request', function (request, response, next) {
    return connectionSecurity.run(request, response, next);
  }, { global: true, prepend: true });
  ctx.effect(() => () => connectionSecurity.dispose());
  const existingCounter = ctx.get('grokSearchOriginalSearchCounter');
  const counter = existingCounter ?? createOriginalSearchCounter(ctx, { holdUntil: () => releaseTask });
  const snapshotCounter = () => normalizeCounterSnapshot(
    typeof counter === 'function' ? counter() : counter.snapshot(), 'host-counter');
  const stateFacade = {
    snapshot: () => stateStore?.snapshot() ?? { hostVersion: null, pluginVersion, revision: null,
      confirmed: false, notified: false, errorCode: 'COMPATIBILITY_IDENTITY_UNKNOWN' },
    onChange(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
  };
  coordinator = createRuntimeCompatibility({ pluginVersion, stateStore: stateFacade });
  const current = token => !destroyed && !userStopped && coordinator.isCurrent(token);
  const assertCurrent = token => { if (!current(token)) throw unavailable('COMPATIBILITY_STOPPED'); };
  const cleanupPending = () => {
    if (!store || !productRuntimeCleanupInFlight(store)) return false;
    runtimeCleanupPending = true;
    const report = coordinator.report();
    if (report.phase !== 'blocked') coordinator.block('COMPATIBILITY_CORE_UNAVAILABLE');
    return true;
  };
  const pause = () => {
    if (!retryingRelease) userIntent++;
    startupReleasePending = false;
    startupSupersession = null;
    userStopped = true;
    retrySequence++;
    coordinator.block('COMPATIBILITY_STOPPED');
    const task = suspendGeneration(generation);
    task.catch(backgroundError);
    return task;
  };
  const compatibility = Object.freeze({
    ...coordinator, assertSearchAllowed,
    report: () => { refreshRuntimeStatus(); refreshSettingsStatus(); refreshOptionalStatus(generation); return coordinator.report(); },
    snapshot: () => { refreshRuntimeStatus(); refreshSettingsStatus(); refreshOptionalStatus(generation); return coordinator.report(); },
    recheck: () => recheckCapabilities(),
    async confirm(request) {
      if (destroyed || !stateStore) throw unavailable('COMPATIBILITY_IDENTITY_UNKNOWN');
      await stateStore.confirm(request);
      if (destroyed) throw unavailable('COMPATIBILITY_STOPPED');
      await coordinator.refreshConfirmation();
      schedule();
      return coordinator.report();
    },
    async acknowledgeNotice(request) {
      if (destroyed || !stateStore) throw unavailable('COMPATIBILITY_IDENTITY_UNKNOWN');
      await stateStore.markNotified(request);
      if (destroyed) throw unavailable('COMPATIBILITY_STOPPED');
      await coordinator.refreshConfirmation();
      return coordinator.report();
    },
    start() {
      if (destroyed || disabling) return Promise.reject(unavailable('COMPATIBILITY_STOPPED'));
      if (startupError && !retriableControlError(startupError)) return Promise.resolve(coordinator.report());
      if (startAttempt?.intent === userIntent) return startAttempt.task;
      if (!userStopped && coordinator.report().coreReady) return Promise.resolve(coordinator.report());
      const attempt = { intent: ++userIntent, task: null };
      const assertIntent = () => {
        if (destroyed || disabling || attempt.intent !== userIntent) throw unavailable('COMPATIBILITY_STOPPED');
      };
      startAttempt = attempt;
      userStopped = true;
      coordinator.block('COMPATIBILITY_STOPPED');
      attempt.task = (async () => {
        assertIntent();
        retrySequence++;
        failureCount = 0;
        await suspendGeneration(generation);
        assertIntent();
        if (retiring) await retiring;
        if (releaseTask) await releaseTask;
        assertIntent();
        const owner = generation?.owner ?? generation?.ctx?.get('grokSearchControl');
        let release;
        // retryRelease calls onStop synchronously; do not suppress user stops while it awaits cleanup.
        retryingRelease = true;
        try { release = owner?.retryRelease?.(); }
        finally { retryingRelease = false; }
        await release;
        assertIntent();
        const record = store?.read()?.intent;
        if (record?.policy === 'released' && !record.releaseCompletion && !record.recovery) {
          throw unavailable('COMPATIBILITY_BLOCKED');
        }
        await disposeGeneration(generation);
        assertIntent();
        userStopped = false;
        coordinator.beginEpoch();
        schedule();
        return coordinator.report();
      })().finally(() => { if (startAttempt === attempt) startAttempt = null; });
      return attempt.task;
    },
  });
  ctx.provide('grokSearchCompatibility', compatibility);
  ctx.provide('grokSearchBudgets', {
    acquire: () => generation?.budgets?.acquire(),
    release: () => generation?.budgets?.release(),
    snapshot: () => generation?.budgets?.snapshot() ?? { budgetMs: configuration.budgetMs ?? 120_000, owned: 0, releasing: false },
  });

  const explicitDisableReason = () => {
    if (!readSelection(ctx).bundles.includes(PRODUCT_SEARCH_BUNDLE)) return 'native-bundle-disable';
    if (!appBoot) return null;
    const desired = appBoot.composeEntries([appBoot.readProfilePatches('dsh', ctx.profileContext)])
      .find(row => row.id === ENTRY_ID);
    if (desired?.disabled === true && rootEntry?.options.disabled === true) return 'native-component-disable';
    return null;
  };
  const startupControlSnapshot = () => {
    refreshRuntimeStatus();
    const owner = generation?.owner ?? generation?.ctx?.get('grokSearchControl');
    const observedOwner = owner?.publicSnapshot?.();
    if (observedOwner && (coordinator.report().coreReady || userStopped || observedOwner.error)) return observedOwner;
    let record = null, failure = startupError;
    try { record = store?.readView ? store.readView() : store?.read(); } catch (error) { failure = error; }
    const recovery = lifecycleContext?.get('grokSearchRecovery')?.snapshot?.();
    const pendingRelease = !startupSupersession && record?.intent.policy === 'released' && !record.intent.releaseCompletion && !record.intent.recovery;
    if (!failure && !startupSupersession && recovery?.error) failure = recovery.error;
    const report = coordinator.report();
    const code = failure?.code ?? (pendingRelease ? 'CONTROL_RELEASE_PENDING'
      : !userStopped && report.phase === 'blocked' ? report.code : null);
    return projectPublicSnapshot({
      phase: code ? 'incomplete' : userStopped ? record?.intent.policy === 'released' ? 'released' : 'stopped' : 'starting',
      record: record?.intent ?? null, revision: record?.revision ?? 0,
      releaseOperationId: record?.intent.release?.operationId ?? null,
      error: code ? { code, message: 'Search runtime recovery is incomplete; retry checks the current state.' } : null,
    }, destroyed);
  };
  const canSupersedeNativeRelease = ({ record, acquisition }) => {
    if (!startupSupersession || destroyed || disabling || userStopped || explicitDisableReason()
      || record.revision !== startupSupersession.revision || record.operationId !== startupSupersession.operationId
      || record.intent.release?.operationId !== startupReleaseOperationId
      || productRuntimeCleanupInFlight(store)) return false;
    const configured = selectedId(authorConfig(ctx).searchProvider) ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
    if (acquisition.authorSearchProvider !== configured) return false;
    return ['authorSearchProvider', 'authorSearchProviderPresent', 'authorFetchProvider', 'authorInjectSha256', 'selectionSha256']
      .every(key => acquisition[key] === startupSupersession.acquisition[key]);
  };
  const supersedeObsoleteStartupRelease = recovery => {
    if (!startupReleasePending || destroyed || disabling || explicitDisableReason()
      || !['CONTROL_RECOVERY_PROVENANCE_REQUIRED', 'CONTROL_RECOVERY_AUTHOR_CHANGED', 'CONTROL_RECOVERY_ROUTE_UNVERIFIED']
        .includes(recovery?.error?.code)) return false;
    const record = store.read(), intent = record?.intent;
    if (!record || record.revision !== startupReleaseRecord?.revision || record.operationId !== startupReleaseRecord?.operationId
      || intent?.policy !== 'released' || intent.release?.operationId !== startupReleaseOperationId
      || !['native-bundle-disable', 'native-component-disable'].includes(intent.reason)
      || intent.release?.kind !== 'intent-release-commit' || intent.releaseCompletion || intent.recovery
      || productRuntimeCleanupInFlight(store)) return false;
    const acquisition = createAcquisition(ctx), previous = intent.priorIntent?.acquisition;
    const configured = selectedId(authorConfig(ctx).searchProvider) ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
    if (!previous || !acquisition.selectedBundles.includes(PRODUCT_SEARCH_BUNDLE)
      || acquisition.authorSearchProvider !== configured
      || !['authorSearchProvider', 'authorFetchProvider', 'authorInjectSha256'].some(key => previous[key] !== acquisition[key])) return false;
    startupSupersession = { revision: record.revision, operationId: record.operationId, acquisition };
    startupReleasePending = false;
    userStopped = false;
    coordinator.beginEpoch();
    return true;
  };
  const resumeStartupRelease = () => {
    if (!startupReleasePending || destroyed || disabling) return false;
    const record = store.read()?.intent;
    if (record?.policy === 'released' && record.release?.operationId === startupReleaseOperationId
      && (record.releaseCompletion || record.recovery)) {
      const nativeRelease = ['native-bundle-disable', 'native-component-disable'].includes(record.reason);
      if (nativeRelease && readSelection(ctx).bundles.includes(PRODUCT_SEARCH_BUNDLE) && !explicitDisableReason()) {
        startupReleasePending = false;
        userStopped = false;
        coordinator.beginEpoch();
        return true;
      }
      startupReleasePending = false;
    }
    return false;
  };
  const retryRuntimeControl = () => {
    if (destroyed || disabling) return Promise.reject(unavailable('COMPATIBILITY_STOPPED'));
    if (runtimeRetryTask) return runtimeRetryTask;
    runtimeRetryTask = (async () => {
      const owner = generation?.owner ?? generation?.ctx?.get('grokSearchControl');
      if (owner && (userStopped || owner.publicSnapshot?.().policy === 'released')) {
        let retry;
        retryingRelease = true;
        try { retry = owner.retryRelease?.(); } finally { retryingRelease = false; }
        await retry;
        return startupControlSnapshot();
      }
      if (!startupInitialized && startupError) {
        const token = coordinator.beginEpoch();
        initializeStartup(token);
      }
      const parent = lifecycleContext;
      if (parent) {
        if (!lifecycleTask && !lifecycleAttempt?.cleanupFailed) startLifecycle(parent);
        const intent = store.read()?.intent;
        if (startupReleasePending || intent?.policy === 'released' && !intent.releaseCompletion && !intent.recovery) {
          if (lifecycleTask) await lifecycleTask;
          await parent.get('grokSearchRecovery')?.retry();
        }
      }
      if (destroyed || disabling) throw unavailable('COMPATIBILITY_STOPPED');
      resumeStartupRelease();
      if (!userStopped) {
        if (cleanupPending()) return startupControlSnapshot();
        await pumping;
        if (!coordinator.report().coreReady) {
          await recheckCapabilities();
          await pumping;
        }
      }
      return startupControlSnapshot();
    })().finally(() => { runtimeRetryTask = null; });
    return runtimeRetryTask;
  };
  ctx.on('internal/plugin', fiber => {
    if (fiber !== rootFiber || fiber.uid !== null) return;
    let reason;
    try { reason = explicitDisableReason(); }
    catch (error) { backgroundError(error); return; }
    if (!reason) return;
    disabling = true;
    pause();
    const owner = generation?.owner ?? generation?.ctx?.get('grokSearchControl');
    if (!owner) return;
    releaseTask = owner.stop(reason, { unloading: true });
    releaseTask.then(outcome => {
      if (outcome?.kind === 'released' || outcome?.kind === 'already-released') return;
      ctx.logger?.warn?.('dsh-grok-search release incomplete: %s',
        outcome?.error?.code ?? outcome?.kind ?? 'unknown');
    }, backgroundError);
  }, { global: true, prepend: true });
  ctx.effect(() => async () => {
    destroyed = true;
    cleanupUnsubscribe?.();
    coordinator.stop();
    stateUnsubscribe?.();
    stateStore?.dispose();
    try { if (releaseTask) await releaseTask; }
    finally { await disposeGeneration(generation); if (!existingCounter) counter.dispose(); }
  });

  function cancelResource(value, key) {
    const resource = value[key];
    if (!resource || typeof resource.dispose !== 'function') return Promise.resolve();
    const taskKey = `${key}Disposal`;
    if (!value[taskKey]) {
      try { value[taskKey] = Promise.resolve(resource.dispose()); }
      catch (error) { value[taskKey] = Promise.reject(error); }
      const task = value[taskKey];
      task.catch(error => {
        if (typeof error?.whenExited?.then !== 'function') return;
        Promise.resolve(error.whenExited).then(() => {
          if (value[taskKey] === task) value[taskKey] = Promise.resolve();
        }, () => {});
      });
      track(value[taskKey]).catch(backgroundError);
    }
    return value[taskKey];
  }
  function suspendGeneration(value) {
    if (!value) return Promise.resolve();
    value.suspended = true;
    value.abort.abort(unavailable('COMPATIBILITY_STOPPED'));
    try { Promise.resolve(value.github?.invalidate()).catch(backgroundError); }
    catch (error) { backgroundError(error); }
    const task = Promise.allSettled([cancelResource(value, 'core'), cancelResource(value, 'program')])
      .then(results => {
        const failure = cleanupFailure(results);
        if (failure) throw failure;
      });
    if (!value.cleanupTracked && store) {
      value.cleanupTracked = true;
      holdProductRelease(store, value.cleanupToken ??= {}, task, { whenDrained: task });
    }
    return track(task);
  }
  async function disposeGeneration(value, canDispose = null) {
    if (!value) return true;
    if (canDispose && !canDispose()) return false;
    if (value.disposal) {
      const disposed = await value.disposal;
      return disposed === false && !canDispose ? disposeGeneration(value) : disposed;
    }
    value.disposal = (async () => {
      const results = await Promise.allSettled([
        suspendGeneration(value),
        Promise.resolve().then(() => value.budgets?.release()).catch(backgroundError),
      ]);
      const failure = results.find(result => result.status === 'rejected');
      if (canDispose) {
        try {
          if (failure) throw failure.reason;
          if (!canDispose()) { value.disposal = null; return false; }
        } catch (error) { value.disposal = null; throw error; }
      }
      await value.fiber?.dispose();
      if (failure) throw failure.reason;
      if (generation === value) generation = null;
      return true;
    })();
    const task = value.disposal;
    task.catch(error => {
      if (typeof error?.whenExited?.then !== 'function') return;
      Promise.resolve(error.whenExited).then(() => {
        if (value.disposal === task) value.disposal = null;
      }, () => {});
    });
    return task;
  }
  // Cordis creates a caller-bound proxy for each Service read.
  const serviceIdentity = service => service?.[Symbol.for('cordis.original')] ?? service;
  function refreshRuntimeStatus() {
    const value = generation;
    if (!value?.initialized || value.suspended || !current(value.token) || !coordinator.report().coreReady) return;
    let intact = false;
    try {
      intact = ['core', 'program', 'owner'].every(key => {
        const name = key === 'owner' ? 'Control' : key[0].toUpperCase() + key.slice(1);
        return serviceIdentity(value.ctx.get('grokSearch' + name)) === serviceIdentity(value[key]);
      });
    } catch { /* A retired service cannot establish readiness. */ }
    if (intact) return;
    coordinator.block('COMPATIBILITY_CORE_UNAVAILABLE');
    track(retryCoreCheck(coordinator.captureEpoch(), unavailable('COMPATIBILITY_CORE_UNAVAILABLE'))).catch(backgroundError);
  }
  function refreshSettingsStatus() {
    const attempt = settingsAttempt;
    if (destroyed || !attempt || attempt.pending) return;
    let available = false;
    try {
      const service = ctx.get('grokSearchSettings');
      available = attempt.ready && attempt.fiber != null && attempt.fiber.uid !== null
        && typeof service?.snapshot === 'function';
    } catch { /* The optional service is currently unavailable. */ }
    coordinator.setOptional('settings', { available, confirmedFailure: !available,
      code: available ? undefined : 'COMPATIBILITY_SETTINGS_UNAVAILABLE' });
  }
  function startSettings() {
    if (destroyed) return Promise.resolve();
    const previous = settingsAttempt;
    if (previous?.pending || previous?.cleanupFailed) return previous.task;
    try {
      if (previous?.ready && previous.fiber != null && previous.fiber.uid !== null
        && typeof ctx.get('grokSearchSettings')?.snapshot === 'function') {
        refreshSettingsStatus();
        return Promise.resolve();
      }
    } catch { /* Retry a service that is actually absent. */ }
    const attempt = { pending: true, ready: false, cleanupFailed: false, fiber: null, task: null };
    settingsAttempt = attempt;
    attempt.task = track(Promise.resolve().then(async () => {
      try {
        if (previous?.fiber) {
          try { await previous.fiber.dispose(); }
          catch (error) { attempt.cleanupFailed = true; throw error; }
        }
        const module = await load('settings');
        if (destroyed || settingsAttempt !== attempt) return;
        attempt.fiber = ctx.plugin(module, { configPath: configuration.configPath });
        await attempt.fiber;
        if (destroyed || settingsAttempt !== attempt) {
          await attempt.fiber.dispose();
          return;
        }
        const service = ctx.get('grokSearchSettings');
        if (typeof service?.snapshot !== 'function') throw unavailable('COMPATIBILITY_SETTINGS_UNAVAILABLE');
        attempt.ready = true;
      } catch (error) {
        try { await attempt.fiber?.dispose(); }
        catch (cleanupError) { attempt.cleanupFailed = true; backgroundError(cleanupError); }
        backgroundError(error);
      } finally {
        attempt.pending = false;
        refreshSettingsStatus();
      }
    }));
    return attempt.task;
  }
  function refreshOptionalStatus(value, name = null) {
    if (!value || generation !== value || !current(value.token) || value.suspended) return;
    for (const key of name ? [name] : ['github']) {
      const attempt = value.optionals[key];
      if (!attempt || attempt.pending) continue;
      const intent = key === 'github' ? readGithubIntent() : true;
      let available = false;
      try {
        const status = value.github?.snapshot?.();
        available = attempt.ready && attempt.fiber?.uid !== null && value.github === attempt.instance
          && serviceIdentity(value.ctx.get('grokSearchGithub')) === serviceIdentity(attempt.instance)
          && (intent === false || intent === true && value.githubCapabilities?.().githubRead === true
            && status?.enabled === true && status.registered === true && !status.error);
      } catch { /* A failed snapshot cannot establish optional readiness. */ }
      coordinator.setOptional(key, { token: value.token, available,
        code: available ? undefined : intent === null ? 'COMPATIBILITY_OPTIONAL_PENDING'
          : `COMPATIBILITY_${key.toUpperCase()}_UNAVAILABLE`,
        confirmedFailure: !available && intent === true });
    }
  }
  function startOptional(value, key) {
    if (!current(value.token) || generation !== value || value.suspended) return Promise.resolve();
    const previous = value.optionals[key];
    // A failed cleanup is not permission to mount another provider beside it.
    if (previous?.pending || previous?.cleanupFailed) return previous.task;
    let retained = false;
    try {
      retained = previous?.ready && previous.fiber?.uid !== null
        && serviceIdentity(value.ctx.get('grokSearchGithub')) === serviceIdentity(previous.instance);
    } catch { /* Missing service access requires a fresh scoped attempt. */ }
    if (retained) {
      if (key === 'github') {
        try { value.github?.sync?.(); } catch (error) { backgroundError(error); }
      }
      refreshOptionalStatus(value, key);
      return Promise.resolve();
    }
    const attempt = { pending: true, ready: false, cleanupFailed: false, fiber: null, instance: null, task: null };
    value.optionals[key] = attempt;
    const assertAttempt = () => {
      assertCurrent(value.token);
      if (generation !== value || value.suspended || value.optionals[key] !== attempt) {
        throw unavailable('COMPATIBILITY_STOPPED');
      }
    };
    attempt.task = track(Promise.resolve().then(async () => {
      try {
        if (previous?.fiber) {
          if (value.github === previous.instance) value.github = null;
          try { await previous.fiber.dispose(); }
          catch (error) { attempt.cleanupFailed = true; throw error; }
          assertAttempt();
        }
        const module = await load(key);
        assertAttempt();
        {
          const privatePreferences = preferences();
          const { createSharedConfigStore, resolveSharedConfigPath } = await load('sharedConfig');
          assertAttempt();
          attempt.fiber = value.ctx.plugin({ name: 'dsh-grok-search-github-runtime', apply(scope) {
            assertAttempt();
            const integration = module.createGithubIntegration({ ctx: scope, searchLog, callRoutes,
              WebError: value.WebError, getCapabilities: value.githubCapabilities,
              getState: () => {
                if (disabling) return { enabled: false, token: '' };
                let prefSnapshot;
                try { prefSnapshot = privatePreferences.snapshot(); }
                catch (error) { if (!required()) return { enabled: false, token: '' }; throw error; }
                if (prefSnapshot.value.githubReadEnabled !== true || !required()) return { enabled: false, token: '' };
                if (!current(value.token)) return { enabled: true, token: '', identity: 'compatibility-blocked' };
                const path = scope.get('grokSearchProgram')?.snapshot?.()?.configPath || resolveSharedConfigPath({});
                const effective = createSharedConfigStore({ path }).readEffective();
                return { enabled: true, token: effective.github_token.value, identity: path };
              } });
            if (typeof integration?.snapshot !== 'function' || typeof integration.sync !== 'function') {
              throw unavailable('COMPATIBILITY_GITHUB_UNAVAILABLE');
            }
            attempt.instance = Object.freeze({ ...integration, sync() {
              try { return integration.sync(); }
              finally { refreshOptionalStatus(value, 'github'); }
            } });
            value.github = attempt.instance;
            scope.provide('grokSearchGithub', attempt.instance);
          } });
          await attempt.fiber;
          assertAttempt();
        }
        attempt.ready = true;
      } catch (error) {
        try { await attempt.fiber?.dispose(); }
        catch (cleanupError) { attempt.cleanupFailed = true; backgroundError(cleanupError); }
        if (value.github === attempt.instance) value.github = null;
        backgroundError(error);
      } finally {
        attempt.pending = false;
        refreshOptionalStatus(value, key);
      }
    }));
    return attempt.task;
  }
  function startLifecycle(parent) {
    // One disposable scope owns both verifier and recovery partial initialization.
    const attempt = { parent, fiber: null, cleanupFailed: false, task: null };
    lifecycleAttempt = attempt;
    const assertAttempt = () => {
      if (destroyed || lifecycleContext !== parent || lifecycleAttempt !== attempt) {
        throw unavailable('COMPATIBILITY_STOPPED');
      }
    };
    attempt.task = track(Promise.resolve().then(async () => {
      try {
        const [verifier, recovery] = await Promise.all(['routeVerifier', 'recovery'].map(load));
        assertAttempt();
        attempt.fiber = parent.plugin({ name: 'dsh-grok-search-lifecycle', async apply(scope) {
          assertAttempt();
          await scope.plugin(verifier, { counter });
          assertAttempt();
          await scope.plugin({ ...recovery, apply: child => recovery.apply(child, { store,
            onSettled: recoveryState => {
              if (destroyed || lifecycleContext !== parent || lifecycleAttempt !== attempt) return;
              if (!resumeStartupRelease()) supersedeObsoleteStartupRelease(recoveryState);
              schedule();
            },
          }) });
          assertAttempt();
          await scope.get('grokSearchRecovery')?.retry();
          assertAttempt();
        } });
        await attempt.fiber;
        assertAttempt();
      } catch (error) {
        try { await attempt.fiber?.dispose(); }
        catch (cleanupError) { attempt.cleanupFailed = true; throw cleanupError; }
        throw error;
      }
    }));
    lifecycleTask = attempt.task;
    attempt.task.then(() => { resumeStartupRelease(); schedule(); }, error => {
      if (lifecycleAttempt === attempt && !attempt.cleanupFailed) {
        lifecycleTask = null;
        lifecycleAttempt = null;
      }
      backgroundError(error);
      schedule();
    }).catch(backgroundError);
    return attempt.task;
  }
  async function initialize(parent, token) {
    if (cleanupPending()) throw unavailable('COMPATIBILITY_CORE_UNAVAILABLE');
    const [program, core, control, host] = await Promise.all(
      ['program', 'core', 'control', 'web'].map(load));
    assertCurrent(token);
    if (cleanupPending()) throw unavailable('COMPATIBILITY_CORE_UNAVAILABLE');
    if (typeof host.WebError !== 'function') throw unavailable('COMPATIBILITY_CORE_SHAPE');
    const corePreferences = Object.freeze({
      snapshot() {
        try { return preferences().snapshot(); }
        catch {
          return { value: { grokEnabled: false, githubEnabled: false }, revision: 'unavailable' };
        }
      },
    });
    const value = { token, parent, ctx: null, fiber: null, core: null, program: null, owner: null,
      budgets: null, github: null, githubCapabilities: null, leaseArmed: false,
      optionals: {}, WebError: host.WebError,
      abort: new AbortController(), suspended: false };
    value.githubCapabilities = () => {
      const available = current(token) && coordinator.report().coreReady;
      try {
        const tools = value.ctx?.get('tools');
        const githubRead = available && typeof tools?.register === 'function' && typeof tools?.get === 'function'
          && typeof (tools.checkGuards ?? tools.guardReason) === 'function';
        return { githubRead, githubFetch: githubRead };
      } catch { return { githubRead: false, githubFetch: false }; }
    };
    generation = value;
    const fiber = parent.plugin({ name: 'dsh-grok-search-runtime', apply(child) {
      value.ctx = child;
      child.provide('grokSearchPreferences', corePreferences);
      child.provide('grokSearchHostAdapter', { WebError: host.WebError });
      value.budgets = createToolBudgetController({ ctx: child, budgetMs: configuration.budgetMs ?? 120_000,
        required, canLease: () => value.leaseArmed && current(token) && coordinator.canLeaseBudget(), onError: backgroundError });
    } });
    value.fiber = fiber;
    await fiber;
    assertCurrent(token);
    if (cleanupPending()) throw unavailable('COMPATIBILITY_CORE_UNAVAILABLE');
    const child = value.ctx;
    // Publish the generation's services before awaiting children that inject them.
    await child.plugin(program, configuration);
    value.program = child.get('grokSearchProgram');
    if (!current(token)) await suspendGeneration(value);
    assertCurrent(token);
    if (cleanupPending()) throw unavailable('COMPATIBILITY_CORE_UNAVAILABLE');
    await child.plugin({ ...core, apply: (scope, config) => core.apply(scope, config, {
      WebError: host.WebError, assertExecution: () => assertSearchAllowed('search'), executionEpoch: coordinator.captureEpoch,
    }) }, configuration);
    value.core = child.get('grokSearchCore');
    if (!current(token)) await suspendGeneration(value);
    assertCurrent(token);
    if (cleanupPending()) throw unavailable('COMPATIBILITY_CORE_UNAVAILABLE');
    await child.plugin({ ...control, apply: scope => control.apply(scope, {
      store, counterSnapshot: snapshotCounter, canAcquire: () => current(token) && coordinator.canAcquireRoute(),
      isCurrent: () => current(token), onStop: pause, onStart: compatibility.start, signal: value.abort.signal,
      keepAliveOnFailure: true, canSupersedeNativeRelease,
    }) });
    assertCurrent(token);
    const owner = value.owner = child.get('grokSearchControl');
    const ownership = owner?.publicSnapshot();
    if (ownership?.phase !== 'required' || effectiveSearchProvider(webEntry(child)) !== PRODUCT_PROVIDER_ID) {
      const internalError = owner?.snapshot?.()?.error;
      const errorCode = ownership?.error?.code ?? internalError?.code;
      const retriable = retriableControlError(internalError, errorCode);
      const code = errorCode === 'CONTROL_SEARCH_SELECTION_CONFLICT' ? errorCode
        : retriable ? 'COMPATIBILITY_CORE_UNAVAILABLE' : 'COMPATIBILITY_ROUTE_UNCONFIRMED';
      ctx.logger?.warn?.('dsh-grok-search route setup failed: %s', errorCode ?? 'route-not-active');
      throw unavailable(code);
    }
    value.initialized = true;
    startupSupersession = null;
    coordinator.setCapabilities({ token, stage: 'route', confirmed: true });
    value.leaseArmed = true;
    coordinator.markReady(token);
    // Host timeout extension is optional; the executor retains its own deadline.
    track(value.budgets.acquire()).catch(backgroundError);
    store.startMaintenance();
    refreshSettingsStatus();
    startOptional(value, 'github');
    assertCurrent(token);
  }
  function schedule() {
    if (destroyed || disabling || userStopped) return;
    if (!startupInitialized) {
      const token = coordinator.captureEpoch();
      if (current(token) && startupToken !== token && retriableControlError(startupError)
        && coordinator.report().phase !== 'blocked') initializeStartup(token);
      return;
    }
    if (pumping) { repump = true; return; }
    pumping = track(Promise.resolve().then(async () => {
      if (!bootstrapReady || !activeContext || retiring || cleanupPending() || coordinator.report().phase === 'blocked'
        || generation && coordinator.isCurrent(generation.token)) return;
      const token = coordinator.captureEpoch(), parent = activeContext;
      try {
        assertCurrent(token);
        if (!coordinator.canAcquireRoute()) return;
        coordinator.markStarting(token);
        if (generation) {
          const value = generation;
          const mayRebuild = () => {
            if (!current(token) || !coordinator.canAcquireRoute() || activeContext !== parent || releaseTask) return false;
            const intent = store.read()?.intent;
            return (!intent || intent.policy === 'required') && !intent?.release && intent?.pause?.confirmed !== true;
          };
          // Consent may return on the same root. Retain the owner until draining
          // finishes, and let an explicit stop win before its fiber is disposed.
          if (!await disposeGeneration(value, mayRebuild)) return;
          assertCurrent(token);
        }
        await initialize(parent, token);
        if (current(token) && coordinator.report().coreReady) failureCount = 0;
      } catch (error) {
        if (current(token)) await retryCoreCheck(token, error);
        backgroundError(error);
      }
    })).finally(() => {
      pumping = null;
      if (repump) { repump = false; schedule(); }
    });
    pumping.catch(backgroundError);
  }
  async function recheckCapabilities() {
    if (destroyed || disabling || userStopped) throw unavailable('COMPATIBILITY_STOPPED');
    if (recheckTask) return recheckTask;
    recheckTask = performRecheck().finally(() => { recheckTask = null; });
    return recheckTask;
  }
  async function performRecheck() {
    if (!current(coordinator.captureEpoch()) || disabling) throw unavailable('COMPATIBILITY_STOPPED');
    startSettings();
    if (startupError && !retriableControlError(startupError)) return coordinator.report();
    if (lifecycleContext && !lifecycleTask && !lifecycleAttempt?.cleanupFailed) {
      startLifecycle(lifecycleContext);
    }
    const before = coordinator.report();
    if (!before.coreReady) {
      retrySequence++;
      failureCount = 0;
      const settled = new Promise(resolve => {
        let timer;
        const finish = value => {
          clearTimeout(timer);
          unsubscribe();
          resolve(value);
        };
        const unsubscribe = coordinator.subscribe(value => {
          if (['ready', 'degraded', 'stopped'].includes(value.phase)
            || value.phase === 'blocked' && (value.code !== 'COMPATIBILITY_CORE_UNAVAILABLE' || failureCount >= 2)) {
            finish(value);
          }
        });
        timer = setTimeout(() => finish(coordinator.report()), 15_000);
      });
      coordinator.beginEpoch();
      schedule();
      await settled;
      return coordinator.report();
    }
    try {
      if (generation && current(generation.token)) {
        const value = generation;
        await startOptional(value, 'github');
        refreshOptionalStatus(value);
      }
    } catch (error) {
      backgroundError(error);
    }
    return coordinator.report();
  }
  coordinator.subscribe(() => {
    if (generation && !coordinator.isCurrent(generation.token) && !userStopped && !destroyed) {
      const value = generation;
      if (!value.suspended) {
        // Keep the control owner reachable to finish release; revocation never restores a route.
        suspendGeneration(value).catch(backgroundError);
      }
    }
    schedule();
  });
  ctx.on('internal/status', () => { refreshRuntimeStatus(); schedule(); }, { global: true });
  ctx.on('internal/service', name => {
    if (['grokSearchCore', 'grokSearchProgram', 'grokSearchControl'].includes(name)) refreshRuntimeStatus();
  }, { global: true });
  ctx.provide('grokSearchBootstrap', {
    async settled() {
      let idlePasses = 0;
      do {
        while (pending.size) await Promise.allSettled([...pending]);
        await new Promise(resolve => setImmediate(resolve));
        idlePasses = pending.size ? 0 : idlePasses + 1;
      } while (idlePasses < 2);
    },
    start: compatibility.start,
    controlSnapshot: startupControlSnapshot,
    retryControlRelease: retryRuntimeControl,
  });
  startSettings();
  // Keep the secured report and recheck RPC reachable even when the startup ledger is unreadable.
  track(Promise.resolve().then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (destroyed || disabling) return;
      let fiber;
      try {
        const service = await load('compatibilityService');
        if (destroyed || disabling) return;
        fiber = ctx.plugin(service);
        await fiber;
        if (destroyed || disabling) await fiber.dispose();
        return;
      } catch (error) {
        // Retire partial registration before allowing another service owner.
        await fiber?.dispose();
        if (destroyed || disabling || attempt === 2) throw error;
        backgroundError(error);
        await retryDelay(attempt === 0 ? 1000 : 3000);
      }
    }
  }).catch(backgroundError));
  initializeStartup(coordinator.captureEpoch());

  function initializeStartup(token) {
    startupToken = token;
    let initial;
    try {
      store ??= createStore(ctx, { deferMaintenance: true });
      const initialRecord = store.read();
      initial = initialRecord?.intent;
      startupReleaseRecord = initialRecord;
      cleanupUnsubscribe ??= onProductRuntimeCleanupIdle(store, () => {
        if (!runtimeCleanupPending || destroyed || disabling) return;
        runtimeCleanupPending = false;
        if (!userStopped && coordinator.report().code === 'COMPATIBILITY_CORE_UNAVAILABLE') {
          coordinator.beginEpoch();
          schedule();
        }
      });
    } catch (error) {
      startupError = error;
      backgroundError(error);
      if (retriableControlError(error)) {
        coordinator.markStarting(token);
        track(retryCoreCheck(token, error)).catch(backgroundError);
      } else coordinator.block(error?.code, token);
      return;
    }
    // Recovering a failed read is not a new activation of a released owner.
    const recovering = startupError !== null;
    startupError = null;
    startupInitialized = true;
    if (initial?.policy === 'released' && !initial.releaseCompletion && !initial.recovery) {
      startupReleasePending = true;
      startupReleaseOperationId = initial.release?.operationId ?? null;
      userStopped = true;
      coordinator.block('COMPATIBILITY_STOPPED');
    } else if (initial?.pause?.confirmed === true
      && !['native-bundle-disable', 'native-component-disable'].includes(initial.reason)
      || recovering && initial?.policy === 'released') pause();
    ctx.inject(['web'], child => {
      lifecycleContext = child;
      startLifecycle(child);
      child.effect(() => () => {
        if (lifecycleContext === child) { lifecycleContext = null; lifecycleTask = null; lifecycleAttempt = null; }
      });
    });
    ctx.inject(['web'], child => {
      activeContext = child;
      child.effect(() => () => {
        if (activeContext !== child) return;
        activeContext = null;
        if (!destroyed && !userStopped) coordinator.beginEpoch();
        const value = generation;
        if (!value || value.parent !== child) return;
        const task = track(disposeGeneration(value));
        retiring = task;
        task.then(() => {
          if (retiring === task) retiring = null;
          schedule();
        }, error => {
          if (!destroyed && retiring === task) coordinator.block(error?.code);
          backgroundError(error);
        });
        return task;
      });
      schedule();
    });
    track(Promise.resolve().then(async () => {
      // Host packages are outside the synchronous spine, including version discovery.
      let hostVersion = null, imported = null;
      try {
        imported = await load('appBoot');
        if (typeof imported?.getDshRuntimeVersion === 'function') {
          hostVersion = await imported.getDshRuntimeVersion();
        }
      } catch (error) { backgroundError(error); }
      if (destroyed) return;
      appBoot = imported;
      try {
        stateStore = createState({ profileDir: ctx.profileContext.dir, hostVersion, pluginVersion });
        try { stateUnsubscribe = stateStore.onChange(() => { for (const listener of stateListeners) listener(); }); }
        catch (error) { backgroundError(error); }
      } catch (error) {
        stateStore = null;
        backgroundError(error);
      }
      coordinator.setHostVersion(hostVersion);
      if (userStopped) coordinator.block('COMPATIBILITY_STOPPED');
      bootstrapReady = true;
      schedule();
    }).catch(error => { if (!destroyed) coordinator.block(error?.code); backgroundError(error); }));
  }
}
