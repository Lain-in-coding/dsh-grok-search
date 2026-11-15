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
import { createRuntimeCompatibility, assessRuntimeCapabilities } from './core/runtime-compat.mjs';
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

// The root deliberately does not depend on web. Its scoped config hook survives
// a WebRuntime rebuild and leaves a missing/unavailable Grok provider fail-closed.
export function apply(ctx, configuration, { load = loadModule, checkContracts = checkRuntimeContracts,
  createState = createCompatibilityState, createStore = createProductStore,
  createPreferences = createPrivatePreferences } = {}) {
  let store = null, coordinator = null, stateStore = null, appBoot = null;
  let destroyed = false, disabling = false, userStopped = false, releaseTask = null;
  let activeContext = null, lifecycleContext = null, lifecycleTask = null, generation = null;
  let pumping = null, repump = false, bootstrapReady = false, stateUnsubscribe = null;
  let assessedToken = null, assessedChecks = null, startTask = null;
  let retiring = null, githubPreferences = null;
  const rootFiber = ctx.fiber, rootEntry = rootFiber.entry;
  const stateListeners = new Set(), pending = new Set();
  const githubExecutions = new AsyncLocalStorage();
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
    try { return coordinator.assertSearchAllowed(operation); }
    catch (error) { throw unavailable(error?.code ?? 'COMPATIBILITY_BLOCKED'); }
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
  // Only post-install calls using the known host hooks are protected; pre-import host work is outside this boundary.
  ctx.on('tools/execute', (exec, next) => {
    let githubFetch = false;
    if (exec?.name === 'web_search' && !searchReleased()) assertSearchAllowed('web_search');
    if (exec?.name === 'github_read' && githubRequired()) assertGithubAllowed(false);
    if (exec?.name === 'web_fetch') {
      let known = false;
      try { parseGithubUrl(exec.arguments?.url); known = true; } catch {}
      if (known && githubRequired()) { assertGithubAllowed(true); githubFetch = true; }
    }
    if (!githubFetch) return githubExecutions.run(null, () => callRoutes.run(exec, next));
    const execution = { token: generation.token, active: true };
    return githubExecutions.run(execution, async () => {
      try { return await callRoutes.run(exec, next); }
      finally { execution.active = false; }
    });
  }, { global: true, prepend: true });
  // A paused tool body can outlive its child adapter; retain only its epoch at the root.
  ctx.on('internal/get', (caller, key, accessError, next) => {
    const execution = githubExecutions.getStore();
    if (key !== 'web' || !execution) return next();
    const fiber = caller?.fiber;
    if (fiber?.runtime?.name !== 'tool-web' || fiber.entry?.options?.name !== '@deepseek-ai/dsh-tool-web') return next();
    const assertActive = () => {
      if (!execution.active) throw new GrokSearchError('GITHUB_FETCH_UNAVAILABLE', 'The GitHub execution has ended.');
      assertGithubAllowed(true, execution.token);
    };
    assertActive();
    const service = next();
    if (!service) return service;
    return new Proxy(service, { get(target, property, receiver) {
      if (property !== 'fetch') return Reflect.get(target, property, receiver);
      return function (...args) {
        assertActive();
        return Reflect.get(target, property, target).apply(target, args);
      };
    } });
  }, { global: true, prepend: true });
  ctx.effect(() => () => githubExecutions.disable());
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
    coordinator.block('COMPATIBILITY_STOPPED');
    const task = suspendGeneration(generation);
    task.catch(backgroundError);
    return task;
  };
  const compatibility = Object.freeze({
    ...coordinator, assertSearchAllowed,
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
      if (current(token)) coordinator.setOptional(key === 'github' ? 'github' : 'settings',
        { token, available: false });
      backgroundError(error);
    }
  }
  async function initialize(parent, token, contractChecks) {
    const [program, core, control, host] = await Promise.all(
      ['program', 'core', 'control', 'web'].map(load));
    assertCurrent(token);
    if (typeof host.WebError !== 'function') throw unavailable('COMPATIBILITY_CORE_SHAPE');
    const privatePreferences = preferences();
    const value = { token, parent, ctx: null, fiber: null, core: null, program: null, owner: null,
      budgets: null, github: null, githubCapabilities: null, leaseArmed: false,
      abort: new AbortController(), suspended: false };
    generation = value;
    const fiber = parent.plugin({ name: 'dsh-grok-search-runtime', apply(child) {
      value.ctx = child;
      child.provide('grokSearchPreferences', privatePreferences);
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
      const { createSharedConfigStore, resolveSharedConfigPath } = await load('sharedConfig');
      assertCurrent(token);
      value.githubCapabilities = () => {
        const available = current(token) && coordinator.report().coreReady;
        return {
          githubRead: available && contractChecks.toolExecution === true && contractChecks.toolResult === true
            && contractChecks.toolGuards === true,
          githubFetch: available && contractChecks.toolExecution === true && contractChecks.toolResult === true
            && contractChecks.toolGuards === true && contractChecks.githubFetch === true,
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
      coordinator.setOptional('github', { token, available: contractChecks.githubFetch === true && !value.github.snapshot?.().error });
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
          if (shape.shape !== 'passed') { coordinator.setCapabilities(shape); return; }
          const contractChecks = await checkContracts(parent, { assertCurrent: () => assertCurrent(token) });
          assertCurrent(token);
          checkToolBudgetContracts(parent, configuration.budgetMs ?? 120_000);
          coordinator.setCapabilities(assessRuntimeCapabilities({ ctx: parent, token, contractChecks }));
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
      } catch (error) {
        if (current(token)) coordinator.block(error?.code);
        backgroundError(error);
      }
    })).finally(() => {
      pumping = null;
      if (repump) { repump = false; schedule(); }
    });
    pumping.catch(backgroundError);
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
    const imported = await load('appBoot');
    if (destroyed) return;
    appBoot = imported;
    if (typeof appBoot.getDshRuntimeVersion !== 'function') throw unavailable('COMPATIBILITY_HOST_UNKNOWN');
    const hostVersion = await appBoot.getDshRuntimeVersion();
    if (destroyed) return;
    stateStore = createState({ profileDir: ctx.profileContext.dir, hostVersion, pluginVersion });
    stateUnsubscribe = stateStore.onChange(() => { for (const listener of stateListeners) listener(); });
    coordinator.setHostVersion(hostVersion);
    if (userStopped) coordinator.block('COMPATIBILITY_STOPPED');
    bootstrapReady = true;
    const report = coordinator.report();
    if (report.hostVersion && !report.notified && report.revision !== null) {
      ctx.logger?.warn?.('dsh-grok-search: this host/plugin pair is unverified; search remains subject to runtime checks.');
    }
    schedule();
  }).catch(error => { if (!destroyed) coordinator.block(error?.code); backgroundError(error); }));
  track(Promise.resolve().then(async () => {
    try {
      const service = await load('compatibilityService');
      if (!destroyed) await ctx.plugin(service);
    } catch (error) { backgroundError(error); }
  }));
}
