import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOriginalSearchCounter } from './core/original-search-counter.mjs';
import { createProductStore, createSearchConfigHook, normalizeCounterSnapshot, readSelection, PRODUCT_SEARCH_BUNDLE,
  PRODUCT_PROVIDER_ID, effectiveSearchProvider, webEntry, checkRuntimeContracts }
  from './core/product-control.mjs';
import { createConnectionSecurity } from './core/connection-security.mjs';
import { createSearchLog } from './core/search-log.mjs';
import { createToolRouteContext } from './core/tool-route-context.mjs';
import { createToolBudgetController, checkToolBudgetContracts } from './core/tool-budget.mjs';
import {
  createRuntimeCompatibility, assessRuntimeCapabilities, isConfirmedCoreCompatibilityFault,
} from './core/runtime-compat.mjs';
import { createCompatibilityState } from './core/compatibility-state.mjs';
import { GrokSearchError } from './core/errors.mjs';
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

// The root deliberately does not depend on web. Its scoped config hook survives
// a WebRuntime rebuild and leaves a missing/unavailable Grok provider fail-closed.
export function apply(ctx, configuration, { load = loadModule, checkContracts = checkRuntimeContracts,
  createState = createCompatibilityState, createStore = createProductStore,
  createPreferences = createPrivatePreferences, retryDelay = defaultRetryDelay } = {}) {
  let store = null, coordinator = null, stateStore = null, appBoot = null;
  let destroyed = false, disabling = false, userStopped = false, releaseTask = null;
  let activeContext = null, lifecycleContext = null, lifecycleTask = null, generation = null;
  let pumping = null, repump = false, bootstrapReady = false, stateUnsubscribe = null;
  let assessedToken = null, assessedChecks = null, startTask = null, recheckTask = null;
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
      return intent?.policy === 'released' && Boolean(intent.releaseCompletion || intent.recovery);
    } catch { return false; }
  };
  const assertSearchAllowed = operation => {
    if (destroyed || userStopped) throw unavailable('COMPATIBILITY_STOPPED');
    if (!coordinator) throw unavailable('COMPATIBILITY_CHECKING');
    try { coordinator.assertSearchAllowed(operation); }
    catch (error) { throw unavailable(error?.code ?? 'COMPATIBILITY_BLOCKED'); }
    let routed = false;
    try { routed = effectiveSearchProvider(webEntry(activeContext ?? ctx)) === PRODUCT_PROVIDER_ID; } catch {}
    if (!routed) {
      coordinator.block('COMPATIBILITY_ROUTE_UNCONFIRMED');
      throw unavailable('COMPATIBILITY_ROUTE_UNCONFIRMED');
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
  ctx.on('internal/config', createSearchConfigHook({ required, requireSchema: true }), { global: true, prepend: true });

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
  const pause = () => {
    userStopped = true;
    retrySequence++;
    coordinator.block('COMPATIBILITY_STOPPED');
    const task = suspendGeneration(generation);
    task.catch(backgroundError);
    return task;
  };
  const compatibility = Object.freeze({
    ...coordinator, assertSearchAllowed,
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
      if (startTask) return startTask;
      if (!userStopped && coordinator.report().coreReady) return Promise.resolve(coordinator.report());
      userStopped = true;
      coordinator.block('COMPATIBILITY_STOPPED');
      startTask = (async () => {
        retrySequence++;
        failureCount = 0;
        await suspendGeneration(generation);
        if (retiring) await retiring;
        if (releaseTask) await releaseTask;
        const owner = generation?.owner ?? generation?.ctx?.get('grokSearchControl');
        await owner?.retryRelease?.();
        const record = store?.read()?.intent;
        if (record?.policy === 'released' && !record.releaseCompletion && !record.recovery) {
          throw unavailable('COMPATIBILITY_BLOCKED');
        }
        await disposeGeneration(generation);
        if (destroyed || disabling) throw unavailable('COMPATIBILITY_STOPPED');
        userStopped = false;
        coordinator.beginEpoch();
        schedule();
        return coordinator.report();
      })().finally(() => { startTask = null; });
      return startTask;
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
      track(value[taskKey]).catch(backgroundError);
    }
    return value[taskKey];
  }
  function suspendGeneration(value) {
    if (!value) return Promise.resolve();
    value.suspended = true;
    value.abort.abort(unavailable('COMPATIBILITY_STOPPED'));
    value.github?.invalidate();
    const task = Promise.allSettled([cancelResource(value, 'core'), cancelResource(value, 'program')])
      .then(results => {
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      });
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
        Promise.resolve().then(() => value.budgets?.release()),
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
    return value.disposal;
  }
  async function optional(key, token, work) {
    try {
      const module = await load(key);
      if (!current(token)) return;
      await work(module);
    } catch (error) {
      const name = key === 'github' ? 'github' : 'settings';
      const confirmedFailure = key === 'settings' || key === 'github' && readGithubIntent() === true;
      if (current(token)) coordinator.setOptional(key === 'github' ? 'github' : 'settings',
        { token, available: false, code: error?.code ?? `COMPATIBILITY_${name.toUpperCase()}_UNAVAILABLE`, confirmedFailure });
      backgroundError(error);
    }
  }
  async function initialize(parent, token, contractChecks) {
    const [program, core, control, host] = await Promise.all(
      ['program', 'core', 'control', 'web'].map(load));
    assertCurrent(token);
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
      budgets: null, github: null, githubCapabilities: null, contractChecks, leaseArmed: false,
      abort: new AbortController(), suspended: false };
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
    const child = value.ctx;
    // Publish the generation's services before awaiting children that inject them.
    await child.plugin(program, configuration);
    value.program = child.get('grokSearchProgram');
    if (!current(token)) await suspendGeneration(value);
    assertCurrent(token);
    await child.plugin({ ...core, apply: (scope, config) => core.apply(scope, config, {
      WebError: host.WebError, assertExecution: () => assertSearchAllowed('search'), executionEpoch: coordinator.captureEpoch,
    }) }, configuration);
    value.core = child.get('grokSearchCore');
    if (!current(token)) await suspendGeneration(value);
    assertCurrent(token);
    await child.plugin({ ...control, apply: scope => control.apply(scope, {
      store, counterSnapshot: snapshotCounter, canAcquire: () => current(token) && coordinator.canAcquireRoute(),
      isCurrent: () => current(token), onStop: pause, onStart: compatibility.start, signal: value.abort.signal,
      keepAliveOnFailure: true,
    }) });
    assertCurrent(token);
    const owner = value.owner = child.get('grokSearchControl');
    if (owner?.publicSnapshot().phase !== 'required'
      || effectiveSearchProvider(webEntry(child)) !== PRODUCT_PROVIDER_ID) throw unavailable('COMPATIBILITY_ROUTE_UNCONFIRMED');
    coordinator.setCapabilities({ token, stage: 'route', confirmed: true });
    value.leaseArmed = true;
    await value.budgets.acquire();
    assertCurrent(token);
    if (effectiveSearchProvider(webEntry(child)) !== PRODUCT_PROVIDER_ID) throw unavailable('COMPATIBILITY_ROUTE_UNCONFIRMED');
    coordinator.setCapabilities({ token, stage: 'budget', confirmed: true });
    coordinator.markReady(token);
    store.startMaintenance();
    track(optional('settings', token, async settings => {
      await child.plugin(settings);
      if (current(token)) coordinator.setOptional('settings', { token, available: true });
    }));
    track(optional('github', token, async github => {
      const privatePreferences = preferences();
      const { createSharedConfigStore, resolveSharedConfigPath } = await load('sharedConfig');
      assertCurrent(token);
      value.githubCapabilities = () => {
        const available = current(token) && coordinator.report().coreReady;
        const checks = value.contractChecks;
        return {
          githubRead: available && checks.toolExecution === true && checks.toolResult === true
            && checks.toolGuards === true && checks.githubRead === true,
          githubFetch: available && checks.toolExecution === true && checks.toolResult === true
            && checks.toolGuards === true && checks.githubRead === true && checks.githubFetch === true,
        };
      };
      value.github = github.createGithubIntegration({ ctx: child, searchLog, callRoutes, WebError: host.WebError,
        getCapabilities: value.githubCapabilities,
        getState: () => {
          const enabled = required() && privatePreferences.snapshot().value.githubReadEnabled === true;
          if (!enabled) return { enabled: false, token: '' };
          if (!current(token)) return { enabled: true, token: '', identity: 'compatibility-blocked' };
          const path = child.get('grokSearchProgram')?.snapshot?.()?.configPath || resolveSharedConfigPath({});
          const effective = createSharedConfigStore({ path }).readEffective();
          return { enabled, token: effective.github_token.value, identity: path };
        } });
      child.provide('grokSearchGithub', value.github);
      const intent = privatePreferences.snapshot().value.githubReadEnabled === true;
      const available = !intent || contractChecks.githubRead === true && contractChecks.toolExecution === true
        && contractChecks.toolResult === true && contractChecks.toolGuards === true
        && !value.github.snapshot?.().error;
      coordinator.setOptional('github', { token, available,
        code: intent && !available ? 'COMPATIBILITY_GITHUB_UNAVAILABLE' : undefined,
        confirmedFailure: intent && !available });
    }));
    assertCurrent(token);
  }
  function schedule() {
    if (destroyed || userStopped) return;
    if (pumping) { repump = true; return; }
    pumping = track(Promise.resolve().then(async () => {
      if (!bootstrapReady || !activeContext || !lifecycleTask || retiring || coordinator.report().phase === 'blocked'
        || generation && coordinator.isCurrent(generation.token)) return;
      const token = coordinator.captureEpoch(), parent = activeContext;
      try {
        await lifecycleTask;
        assertCurrent(token);
        if (assessedToken !== token) {
          const shape = assessRuntimeCapabilities({ ctx: parent, token });
          if (shape.transient) throw Object.assign(new Error(shape.code), { code: shape.code });
          if (shape.shape === 'pending') { coordinator.setCapabilities(shape); return; }
          if (shape.shape === 'failed') { coordinator.setCapabilities(shape); return; }
          const contractChecks = await checkContracts(parent, { assertCurrent: () => assertCurrent(token) });
          assertCurrent(token);
          checkToolBudgetContracts(parent, configuration.budgetMs ?? 120_000);
          const assessed = assessRuntimeCapabilities({ ctx: parent, token, contractChecks });
          if (assessed.transient) throw Object.assign(new Error(assessed.code), { code: assessed.code });
          coordinator.setCapabilities(assessed);
          assertCurrent(token);
          assessedToken = token;
          assessedChecks = contractChecks;
        }
        if (!coordinator.canAcquireRoute()) return;
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
        await initialize(parent, token, assessedChecks);
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
    if (destroyed || disabling || userStopped) throw unavailable('COMPATIBILITY_STOPPED');
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
    const token = coordinator.captureEpoch(), parent = activeContext;
    if (!parent) return coordinator.report();
    try {
      const shape = assessRuntimeCapabilities({ ctx: parent, token });
      if (shape.transient || shape.shape !== 'passed') return coordinator.report();
      const checks = await checkContracts(parent, { assertCurrent: () => assertCurrent(token) });
      assertCurrent(token);
      const assessed = assessRuntimeCapabilities({ ctx: parent, token, contractChecks: checks });
      if (assessed.transient || assessed.shape !== 'passed' || assessed.contract !== 'passed') return coordinator.report();
      checkToolBudgetContracts(parent, configuration.budgetMs ?? 120_000);
      if (generation?.token === token) {
        generation.contractChecks = checks;
        generation.github?.sync?.();
        const intent = readGithubIntent();
        const github = generation.github?.snapshot?.();
        const githubUnavailable = intent === true && (checks.githubRead !== true
          || checks.toolExecution !== true || checks.toolResult !== true || checks.toolGuards !== true
          || Boolean(github?.error));
        coordinator.setOptional('github', {
          token, available: intent !== true || !githubUnavailable,
          code: githubUnavailable ? 'COMPATIBILITY_GITHUB_UNAVAILABLE' : undefined,
          confirmedFailure: githubUnavailable,
        });
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
  ctx.on('internal/status', () => schedule(), { global: true });
  ctx.provide('grokSearchBootstrap', {
    async settled() { while (pending.size) await Promise.allSettled([...pending]); },
    start: compatibility.start,
  });
  try {
    store = createStore(ctx, { deferMaintenance: true });
    const initial = store.read()?.intent;
    if (initial?.policy === 'released' && initial.release?.kind === 'intent-release-commit'
      && !initial.releaseCompletion) pause();
  } catch (error) {
    coordinator.block(error?.code);
    backgroundError(error);
    return;
  }
  ctx.inject(['web'], child => {
    lifecycleContext = child;
    lifecycleTask = track(Promise.resolve().then(async () => {
      const [verifier, recovery] = await Promise.all(['routeVerifier', 'recovery'].map(load));
      if (destroyed || lifecycleContext !== child) return;
      await child.plugin(verifier, { counter });
      if (destroyed || lifecycleContext !== child) return;
      await child.plugin({ ...recovery, apply: scope => recovery.apply(scope, { store }) });
      if (destroyed || lifecycleContext !== child) return;
      await child.get('grokSearchRecovery')?.retry();
    }));
    lifecycleTask.then(schedule, error => {
      if (!destroyed && lifecycleContext === child) coordinator.block(error?.code);
      backgroundError(error);
    });
    child.effect(() => () => { if (lifecycleContext === child) { lifecycleContext = null; lifecycleTask = null; } });
  });
  ctx.inject(['web', 'tools'], child => {
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
  track(Promise.resolve().then(async () => {
    try {
      const service = await load('compatibilityService');
      if (!destroyed) await ctx.plugin(service);
    } catch (error) { backgroundError(error); }
  }));
}
