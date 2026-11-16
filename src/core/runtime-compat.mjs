import semver from 'semver';
import { isCompatibilityVersion } from './compatibility-contract.mjs';

export const MINIMUM_DSH_VERSION = '0.2.1-rc.2';
export const CORE_CONTRACT_CHECKS = Object.freeze([
  'configHook', 'configCandidate', 'configUpdate', 'pluginDisposal',
  'webSelection', 'toolExecution',
]);

const codes = new Set([
  'COMPATIBILITY_HOST_UNKNOWN', 'COMPATIBILITY_HOST_INVALID', 'COMPATIBILITY_PLUGIN_INVALID',
  'COMPATIBILITY_MINIMUM_REQUIRED', 'COMPATIBILITY_CONFIRMATION_REQUIRED',
  'COMPATIBILITY_CHECKING', 'COMPATIBILITY_CORE_PENDING', 'COMPATIBILITY_CORE_SHAPE',
  'COMPATIBILITY_ABI_UNSUPPORTED', 'COMPATIBILITY_CONTRACT_PENDING', 'COMPATIBILITY_CONTRACT_FAILED',
  'COMPATIBILITY_PROBE_FAILED', 'COMPATIBILITY_PROBE_INVALID', 'COMPATIBILITY_CORE_UNAVAILABLE',
  'COMPATIBILITY_ROUTE_UNCONFIRMED',
  'COMPATIBILITY_BUDGET_UNCONFIRMED', 'COMPATIBILITY_INITIALIZATION_PENDING',
  'COMPATIBILITY_OPTIONAL_PENDING', 'COMPATIBILITY_OPTIONAL_UNAVAILABLE',
  'COMPATIBILITY_SETTINGS_UNAVAILABLE', 'COMPATIBILITY_CHAT_UNAVAILABLE',
  'COMPATIBILITY_GITHUB_UNAVAILABLE', 'COMPATIBILITY_BLOCKED', 'COMPATIBILITY_STOPPED',
  'COMPATIBILITY_PAIR_MISMATCH', 'COMPATIBILITY_IDENTITY_UNKNOWN',
  'COMPATIBILITY_STATE_READ_FAILED', 'COMPATIBILITY_STATE_INVALID',
  'COMPATIBILITY_STATE_UNAVAILABLE', 'COMPATIBILITY_STATE_PATH_INVALID',
  'COMPATIBILITY_STATE_PATH_UNSAFE', 'COMPATIBILITY_STATE_BUSY',
  'COMPATIBILITY_STATE_FULL', 'COMPATIBILITY_STATE_WRITE_FAILED',
  'COMPATIBILITY_STATE_COMMIT_UNCERTAIN', 'COMPATIBILITY_CONFLICT',
]);
const optionalNames = Object.freeze(['settings', 'chat', 'github']);
const coreFaultCodes = new Set([
  'COMPATIBILITY_PLUGIN_INVALID', 'COMPATIBILITY_MINIMUM_REQUIRED',
  'COMPATIBILITY_CORE_SHAPE', 'COMPATIBILITY_ABI_UNSUPPORTED',
  'COMPATIBILITY_CONTRACT_FAILED', 'COMPATIBILITY_PROBE_INVALID',
  'COMPATIBILITY_ROUTE_UNCONFIRMED', 'COMPATIBILITY_BUDGET_UNCONFIRMED',
]);
export const isConfirmedCoreCompatibilityFault = code => coreFaultCodes.has(code);
const probeResults = new WeakSet();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const method = (value, key) => typeof value?.[key] === 'function';
const safeCode = (code, fallback) => typeof code === 'string' && codes.has(code) ? code : fallback;
const revisionValid = value => typeof value === 'string' && /^(?:missing|[a-f0-9]{64})$/.test(value);
const isPromise = value => value !== null && value !== undefined && typeof value.then === 'function';

function exactVersion(value) {
  if (!isCompatibilityVersion(value)) return null;
  try { return semver.parse(value, { loose: false }); } catch { return null; }
}

function channelOf(version) {
  if (!version.prerelease.length) return 'stable';
  const [channel, number] = version.prerelease;
  if (channel === 'rc' && version.prerelease.length === 2 && Number.isSafeInteger(number)) return 'rc';
  return channel === 'alpha' || channel === 'beta' ? channel : 'other';
}

export function evaluateRuntimeVersion(hostVersion) {
  const parsed = exactVersion(hostVersion);
  const channel = parsed ? channelOf(parsed) : 'unknown';
  const minimumAdmitted = parsed === null || semver.gte(parsed, MINIMUM_DSH_VERSION);
  const confirmationRequired = false;
  const code = parsed && !minimumAdmitted ? 'COMPATIBILITY_MINIMUM_REQUIRED' : null;
  return Object.freeze({
    hostVersion: parsed ? hostVersion : null,
    channel, minimumAdmitted, confirmationRequired, verification: 'unverified', code,
  });
}

function featureDefaults() {
  return Object.fromEntries(optionalNames.map(name => [
    name, Object.freeze({ available: false, code: 'COMPATIBILITY_OPTIONAL_PENDING', confirmedFailure: false }),
  ]));
}

function makeProbe(token, abi, shape, contract, code, transient = false) {
  const result = Object.freeze({ token, stage: 'core', abi, shape, contract, code, transient });
  probeResults.add(result);
  return result;
}

function contractState(checks) {
  if (checks === undefined) return 'pending';
  if (!record(checks)) return 'failed';
  if (CORE_CONTRACT_CHECKS.some(name => checks[name] === false)) return 'failed';
  return CORE_CONTRACT_CHECKS.every(name => checks[name] === true) ? 'passed' : 'pending';
}

/**
 * Read-only shape assessment. The adapter supplies results of its separate ABI
 * contract checks; method presence alone never grants route or search authority.
 */
export function assessRuntimeCapabilities({ ctx, token, contractChecks } = {}) {
  try {
    if (!record(ctx) || !['get', 'on', 'effect', 'plugin'].every(name => method(ctx, name))) {
      return makeProbe(token, null, 'failed', 'pending', 'COMPATIBILITY_CORE_SHAPE');
    }
    const loader = ctx.get('loader'), profile = ctx.get('profileContext');
    if (!loader || !profile) {
      return makeProbe(token, null, 'pending', 'pending', 'COMPATIBILITY_CORE_PENDING');
    }
    if (!method(loader, 'entries') || !method(ctx.registry, 'values')
      || typeof profile.dir !== 'string' || !profile.dir) {
      return makeProbe(token, null, 'failed', 'pending', 'COMPATIBILITY_CORE_SHAPE');
    }
    const matches = [];
    let count = 0;
    for (const entry of loader.entries()) {
      if (++count > 4096) return makeProbe(token, null, 'failed', 'pending', 'COMPATIBILITY_CORE_SHAPE');
      if (entry?.options?.id === 'web') matches.push(entry);
    }
    if (!matches.length) return makeProbe(token, null, 'pending', 'pending', 'COMPATIBILITY_CORE_PENDING');
    const entry = matches[0], wrapper = entry.fiber, fiber = wrapper?.ctx?.fiber ?? wrapper;
    if (matches.length !== 1 || entry.options.name !== '@deepseek-ai/dsh-web'
      || entry.options.disabled === true || !method(entry, 'update')) {
      return makeProbe(token, null, 'failed', 'pending', 'COMPATIBILITY_CORE_SHAPE');
    }
    if (!wrapper?.uid || !fiber?.uid || fiber.state !== 2) {
      return makeProbe(token, null, 'pending', 'pending', 'COMPATIBILITY_CORE_PENDING');
    }
    if (!['update', 'await', 'dispose'].every(name => method(fiber, name))) {
      return makeProbe(token, null, 'failed', 'pending', 'COMPATIBILITY_CORE_SHAPE');
    }
    const modern = 'effectiveConfig' in fiber;
    const abi = modern ? 'cordis-effective-config' : 'cordis-resolved-config';
    const config = modern ? fiber.effectiveConfig : fiber.config;
    if (!record(config) || modern && (!method(fiber, 'resolveConfig') || !('rawConfig' in fiber))) {
      return makeProbe(token, abi, 'failed', 'pending', 'COMPATIBILITY_ABI_UNSUPPORTED');
    }
    const web = method(wrapper?.ctx, 'get') ? wrapper.ctx.get('web') : ctx.get('web');
    if (!web) return makeProbe(token, abi, 'pending', 'pending', 'COMPATIBILITY_CORE_PENDING');
    if (!['registerSearchProvider', 'search'].every(name => method(web, name))) {
      return makeProbe(token, abi, 'failed', 'pending', 'COMPATIBILITY_CORE_SHAPE');
    }
    for (const key of ['searchProvider', 'fetchProvider']) {
      if (key === 'fetchProvider' && !Object.hasOwn(config, key)) continue;
      const field = config[key];
      if (modern && !method(field, 'get')) {
        return makeProbe(token, abi, 'failed', 'pending', 'COMPATIBILITY_ABI_UNSUPPORTED');
      }
      const value = method(field, 'get') ? field.get() : field;
      if (key === 'fetchProvider' && value === undefined) continue;
      if (value !== undefined && (typeof value !== 'string' || !value)) {
        return makeProbe(token, abi, 'failed', 'pending', 'COMPATIBILITY_ABI_UNSUPPORTED');
      }
    }
    const contract = contractState(contractChecks);
    return makeProbe(token, abi, 'passed', contract,
      contract === 'passed' ? null : contract === 'pending'
        ? 'COMPATIBILITY_CONTRACT_PENDING' : 'COMPATIBILITY_CONTRACT_FAILED');
  } catch {
    return makeProbe(token, null, 'pending', 'pending', 'COMPATIBILITY_PROBE_FAILED', true);
  }
}

function compatibilityError(code) {
  const error = new Error(code);
  error.name = 'RuntimeCompatibilityError';
  error.code = code;
  return error;
}

/**
 * Plugin-local coordination only: no host imports, profile writes, consent
 * mutations, provider fallback, or claims derived from a static support matrix.
 */
export function createRuntimeCompatibility({ hostVersion, pluginVersion, stateStore, onChange } = {}) {
  let policy = evaluateRuntimeVersion(hostVersion);
  const plugin = exactVersion(pluginVersion) ? pluginVersion : null;
  let token = Object.freeze({}), stopped = false, blocked = null, checking = false;
  let core = null, route = false, budget = false, initialized = false;
  let confirmed = false, notified = false, revision = null, stateCode = null, statePending = false;
  let optional = featureDefaults(), readSequence = 0, unsubscribeState = null;
  const listeners = new Set();
  if (typeof onChange === 'function') listeners.add(onChange);
  const isCurrent = candidate => !stopped && candidate === token;
  const resetWork = () => {
    token = Object.freeze({});
    core = null; route = false; budget = false; initialized = false; checking = false;
    optional = featureDefaults();
  };
  const identityCode = () => !plugin ? 'COMPATIBILITY_PLUGIN_INVALID'
    : !policy.minimumAdmitted ? policy.code : null;
  const admitted = () => !stopped && !identityCode() && !blocked;
  const corePassed = () => core?.shape === 'passed' && core.contract === 'passed';
  const canAcquireRoute = () => admitted() && corePassed();
  const ready = () => canAcquireRoute() && route && budget && initialized;
  const optionalCode = () => {
    const unavailable = optionalNames.map(name => optional[name]).filter(feature => !feature.available);
    if (unavailable.some(feature => feature.confirmedFailure)) {
      return 'COMPATIBILITY_OPTIONAL_UNAVAILABLE';
    }
    return unavailable.length ? 'COMPATIBILITY_OPTIONAL_PENDING' : null;
  };
  const currentCode = () => {
    if (stopped) return 'COMPATIBILITY_STOPPED';
    if (identityCode()) return identityCode();
    if (blocked) return blocked;
    if (statePending) return 'COMPATIBILITY_CHECKING';
    if (!corePassed()) return core?.code ?? 'COMPATIBILITY_CORE_PENDING';
    if (!route) return 'COMPATIBILITY_ROUTE_UNCONFIRMED';
    if (!budget) return 'COMPATIBILITY_BUDGET_UNCONFIRMED';
    if (!initialized) return 'COMPATIBILITY_INITIALIZATION_PENDING';
    return stateCode ?? optionalCode();
  };
  const report = () => {
    const coreReady = ready();
    const phase = stopped ? 'stopped'
      : identityCode() || blocked ? 'blocked'
        : coreReady ? optionalCode() === 'COMPATIBILITY_OPTIONAL_UNAVAILABLE' ? 'degraded' : 'ready'
          : checking || statePending ? 'checking' : 'initial';
    return Object.freeze({
      schemaVersion: 1, hostVersion: policy.hostVersion, pluginVersion: plugin, channel: policy.channel,
      minimumAdmitted: policy.minimumAdmitted, verification: 'unverified', phase, revision,
      confirmationRequired: false, confirmed, notified, coreReady, code: currentCode(),
      optionalFeatures: Object.freeze(Object.fromEntries(optionalNames.map(name => [name,
        Object.freeze({ available: optional[name].available, code: optional[name].code })]))),
    });
  };
  let lastReport = JSON.stringify(report()), lastToken = token;
  const publish = () => {
    const serialized = JSON.stringify(report());
    // An epoch change invalidates subscribers' work even if its report is equal.
    if (serialized === lastReport && token === lastToken) return;
    lastReport = serialized; lastToken = token;
    for (const listener of [...listeners]) {
      try {
        const result = listener(report());
        if (isPromise(result)) Promise.resolve(result).catch(() => {});
      } catch { /* Observers cannot change admission or expose their errors. */ }
    }
  };
  const applyConfirmation = (value, expectedToken, sequence) => {
    if (!isCurrent(expectedToken) || sequence !== readSequence) return report();
    statePending = false;
    let nextCode = null;
    let nextConfirmed = false, nextNotified = false, nextRevision = null;
    if (!record(value)) nextCode = 'COMPATIBILITY_STATE_INVALID';
    else if (value.hostVersion !== policy.hostVersion || value.pluginVersion !== plugin) {
      nextCode = 'COMPATIBILITY_PAIR_MISMATCH';
    } else if (value.errorCode !== null && value.errorCode !== undefined) {
      nextCode = safeCode(value.errorCode, 'COMPATIBILITY_STATE_READ_FAILED');
    } else if (!revisionValid(value.revision) || typeof value.confirmed !== 'boolean'
      || typeof value.notified !== 'boolean'
      || value.revision === 'missing' && (value.confirmed || value.notified)
      || value.confirmed && !value.notified) {
      nextCode = 'COMPATIBILITY_STATE_INVALID';
    } else {
      nextConfirmed = value.confirmed; nextNotified = value.notified; nextRevision = value.revision;
    }
    confirmed = nextConfirmed; notified = nextNotified; revision = nextRevision; stateCode = nextCode;
    publish();
    return report();
  };
  const refreshConfirmation = () => {
    if (stopped || identityCode()) return report();
    const expectedToken = token, sequence = ++readSequence;
    const failed = () => applyConfirmation({
      hostVersion: policy.hostVersion, pluginVersion: plugin, errorCode: 'COMPATIBILITY_STATE_READ_FAILED',
    }, expectedToken, sequence);
    try {
      const value = stateStore === undefined ? {
        hostVersion: policy.hostVersion, pluginVersion: plugin, revision: 'missing',
        confirmed: false, notified: false, errorCode: null,
      } : stateStore.snapshot();
      if (isPromise(value)) {
        statePending = true;
        publish();
        return Promise.resolve(value).then(result => applyConfirmation(result, expectedToken, sequence), failed)
          .catch(failed);
      }
      return applyConfirmation(value, expectedToken, sequence);
    } catch { return failed(); }
  };
  const block = code => {
    if (stopped) return false;
    blocked = safeCode(code, 'COMPATIBILITY_BLOCKED');
    readSequence++;
    statePending = false;
    resetWork();
    publish();
    return true;
  };
  const stop = () => {
    if (stopped) return report();
    stopped = true;
    readSequence++;
    resetWork();
    statePending = false;
    try { unsubscribeState?.(); } catch { /* The stopped epoch remains authoritative. */ }
    unsubscribeState = null;
    publish();
    listeners.clear();
    return report();
  };
  const api = Object.freeze({
    snapshot: report, report, canAcquireRoute, canLeaseBudget: canAcquireRoute,
    captureEpoch: () => token, isCurrent, refreshConfirmation, block, stop,
    beginEpoch() {
      if (stopped) return null;
      readSequence++;
      blocked = null; stateCode = null; statePending = false;
      resetWork();
      checking = true;
      refreshConfirmation();
      publish();
      return stopped ? null : token;
    },
    assertSearchAllowed(_operation) {
      if (!ready()) throw compatibilityError(currentCode());
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('COMPATIBILITY_LISTENER_INVALID');
      if (stopped) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setHostVersion(value) {
      if (stopped) return report();
      const next = evaluateRuntimeVersion(value);
      if (next.hostVersion === policy.hostVersion && next.code === policy.code) return report();
      policy = next; blocked = null; stateCode = null; statePending = false;
      confirmed = false; notified = false; revision = null;
      readSequence++;
      resetWork();
      publish();
      refreshConfirmation();
      return report();
    },
    setCapabilities(result) {
      if (!isCurrent(result?.token)) return false;
      if (result.stage === 'core') {
        if (!probeResults.has(result)) return block('COMPATIBILITY_PROBE_INVALID');
        if (result === core) return true;
        // A second complete assessment replaces the authority of in-flight
        // acquisition, even when it reports the same method/ABI shape.
        if (corePassed()) {
          readSequence++;
          statePending = false;
          resetWork();
          checking = true;
          publish();
          return false;
        }
        checking = true;
        core = result;
        route = false; budget = false;
        initialized = false;
        if (result.shape === 'failed' || result.contract === 'failed') return block(result.code);
      } else if (result.stage === 'route' || result.stage === 'budget') {
        if (!canAcquireRoute()) return false;
        if (result.confirmed !== true) return block(result.stage === 'route'
          ? 'COMPATIBILITY_ROUTE_UNCONFIRMED' : 'COMPATIBILITY_BUDGET_UNCONFIRMED');
        if (result.stage === 'route') route = true;
        else budget = true;
      } else return block('COMPATIBILITY_PROBE_INVALID');
      publish();
      return true;
    },
    markReady(expectedToken) {
      if (!isCurrent(expectedToken) || !canAcquireRoute() || !route || !budget) return false;
      initialized = true;
      publish();
      return ready();
    },
    setOptional(name, value = {}) {
      if (stopped || !optionalNames.includes(name) || !record(value)
        || value.token !== undefined && !isCurrent(value.token)) return false;
      const available = value.available === true || value.available === undefined && value.state === 'ready';
      optional[name] = Object.freeze({
        available,
        code: available ? null : safeCode(value.code, `COMPATIBILITY_${name.toUpperCase()}_UNAVAILABLE`),
        confirmedFailure: !available && value.confirmedFailure === true,
      });
      publish();
      return true;
    },
  });
  refreshConfirmation();
  if (stateStore && !stopped) {
    try {
      if (method(stateStore, 'onChange')) unsubscribeState = stateStore.onChange(() => { refreshConfirmation(); });
    } catch {
      applyConfirmation({
        hostVersion: policy.hostVersion, pluginVersion: plugin, errorCode: 'COMPATIBILITY_STATE_READ_FAILED',
      }, token, ++readSequence);
    }
  }
  return api;
}
