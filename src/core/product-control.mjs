import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ControlRecordError, createControlIntentStore } from './control-intent-store.mjs';

export const PRODUCT_SEARCH_BUNDLE = 'dsh-grok-search';
// Single-bundle build (D-28): recovery entries ship in the product bundle itself.
export const PRODUCT_RECOVERY_BUNDLE = 'dsh-grok-search';
export const PRODUCT_PROVIDER_ID = 'grok-search';
// One opaque process identity shared by the search and recovery entries.
export const PRODUCT_HOST_ID = randomUUID();

export const selectedId = value => typeof value?.get === 'function' ? value.get() : value;

export function readSelection(ctx) {
  const path = join(ctx.profileContext.dir, 'package.json');
  const text = readFileSync(path, 'utf8');
  const manifest = JSON.parse(text);
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new Error('CONTROL_SELECTION_INVALID');
  }
  return { path, bundles, sha256: createHash('sha256').update(text).digest('hex') };
}

export function webEntry(ctx) {
  const entries = [...ctx.loader.entries()].filter(row => row.options.id === 'web');
  if (entries.length !== 1 || !entries[0].fiber?.uid) throw new Error('CONTROL_TARGET_MISSING');
  return entries[0];
}

export function authorConfig(ctx) {
  return webEntry(ctx).options.config ?? {};
}

export function authorSearchProvider(ctx) {
  const entry = webEntry(ctx);
  const fiber = selectedId(entry.fiber.config?.searchProvider);
  if (fiber !== undefined && fiber !== null && fiber !== PRODUCT_PROVIDER_ID) return fiber;
  const runtime = runtimeService(entry);
  const active = selectedId(runtime?.searchProviderId ?? runtime?.config?.searchProvider);
  if (active !== undefined && active !== null && active !== PRODUCT_PROVIDER_ID) return active;
  const configured = selectedId(entry.options.config?.searchProvider);
  if (configured !== undefined && configured !== null) return configured;
  return process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
}

export function authorFetchProvider(ctx) {
  return effectiveFetchProvider(webEntry(ctx));
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

export function authorInjectSha256(ctx) {
  return createHash('sha256').update(stableJson(webEntry(ctx).options.inject ?? null)).digest('hex');
}

export function createProductStore(ctx) {
  return createControlIntentStore({
    directory: join(ctx.profileContext.dir, 'control-intent.records'),
    legacyPath: join(ctx.profileContext.dir, 'control-intent.fixture.json'),
    trustedRoot: ctx.profileContext.dir,
  });
}

export function createAcquisition(ctx, observedAt = new Date().toISOString()) {
  const selection = readSelection(ctx);
  const config = authorConfig(ctx);
  return {
    source: 'current-selected-search-bundle',
    searchBundle: PRODUCT_SEARCH_BUNDLE,
    selectedBundles: [...selection.bundles],
    selectionSha256: selection.sha256,
    observedAt,
    observerPid: process.pid,
    ownerUid: ctx.fiber.uid,
    authorSearchProvider: authorSearchProvider(ctx),
    authorSearchProviderPresent: Object.hasOwn(config, 'searchProvider'),
    authorFetchProvider: authorFetchProvider(ctx),
    authorInjectSha256: authorInjectSha256(ctx),
    hostId: PRODUCT_HOST_ID,
    userClickObserved: false,
    historicReleaseCommitted: false,
  };
}

export function createLease(ctx) {
  const entry = webEntry(ctx);
  return {
    pid: process.pid,
    uid: entry.fiber.uid,
    entryId: 'web',
    moduleName: entry.options.name,
    provider: PRODUCT_PROVIDER_ID,
    hostId: PRODUCT_HOST_ID,
  };
}

export function createRecoveryObservation(ctx, loadId) {
  const selection = readSelection(ctx);
  if (!selection.bundles.includes(PRODUCT_RECOVERY_BUNDLE)) throw new Error('CONTROL_RECOVERY_BUNDLE_NOT_SELECTED');
  return {
    hostId: PRODUCT_HOST_ID,
    observedAt: new Date().toISOString(),
    selectionSha256: selection.sha256,
    selectedBundles: [...selection.bundles],
    searchBundle: PRODUCT_SEARCH_BUNDLE,
    recoveryBundle: PRODUCT_RECOVERY_BUNDLE,
    authorSearchProvider: authorSearchProvider(ctx),
    authorSearchProviderPresent: Object.hasOwn(authorConfig(ctx), 'searchProvider'),
    authorFetchProvider: authorFetchProvider(ctx),
    authorInjectSha256: authorInjectSha256(ctx),
    ownerPresent: Boolean(ctx.get('grokSearchControl')),
    observer: {
      loadId,
      counter: originalSearchCounter(ctx),
    },
    component: {
      legalLoad: true,
      loadId,
      ownerUid: ctx.fiber.uid,
      role: 'recovery',
      bundle: PRODUCT_RECOVERY_BUNDLE,
    },
  };
}

export function dependenciesPreserved(ctx, snapshot) {
  return isDeepStrictEqual(webEntry(ctx).options.inject ?? null, snapshot ?? null);
}

/**
 * Normalize every counter shape into one JSON-safe snapshot. Route receipts are
 * persisted in CAS records, which reject undefined members; a host counter that
 * reports only `{ calls }` must still yield a complete, serializable value.
 */
export function normalizeCounterSnapshot(value, fallbackSource = 'grokSearchOriginalSearchCounter') {
  const calls = Number.isSafeInteger(value) ? value
    : Number.isSafeInteger(value?.calls) ? value.calls
      : Number.isSafeInteger(value?.originalSearchCalls) ? value.originalSearchCalls
        : null;
  if (calls === null || calls < 0) {
    throw new ControlRecordError('CONTROL_ROUTE_COUNTER_REQUIRED',
      'The Host must provide a verified original-search counter before route correction.');
  }
  return {
    calls,
    source: typeof value?.source === 'string' && value.source.length > 0 ? value.source : fallbackSource,
    adapterVersion: Number.isSafeInteger(value?.adapterVersion) && value.adapterVersion > 0
      ? value.adapterVersion : 1,
  };
}

export function originalSearchCounter(ctx) {
  const counter = ctx.get('grokSearchOriginalSearchCounter');
  return normalizeCounterSnapshot(typeof counter === 'function' ? counter() : counter?.snapshot?.());
}

export function originalSearchCalls(ctx) {
  return originalSearchCounter(ctx).calls;
}

export function routeReceipt(ctx, { authorSearchProvider: expectedSearch = authorSearchProvider(ctx),
  authorFetchProvider: expectedFetch = authorFetchProvider(ctx), expectedInjectSha256 = null,
  dependenciesPreserved: dependencyOverride = null, routeChanged = false,
  counterBaseline = null, counterSnapshot = null } = {}) {
  const entry = webEntry(ctx);
  const actualSearchProvider = effectiveSearchProvider(entry);
  const actualFetchProvider = effectiveFetchProvider(entry);
  const deps = typeof dependencyOverride === 'boolean' ? dependencyOverride
    : expectedInjectSha256 === null ? null
      : authorInjectSha256(ctx) === expectedInjectSha256;
  const counter = counterSnapshot ? normalizeCounterSnapshot(counterSnapshot) : originalSearchCounter(ctx);
  if (counterBaseline !== null && (!Number.isSafeInteger(counterBaseline) || counterBaseline < 0
    || counter.calls < counterBaseline)) {
    throw new ControlRecordError('CONTROL_ROUTE_COUNTER_REGRESSION',
      'The original-search counter moved backwards or has no valid release baseline.');
  }
  return {
    atAuthor: actualSearchProvider === expectedSearch,
    routeChanged: routeChanged === true,
    fetchPreserved: actualFetchProvider === expectedFetch,
    dependenciesPreserved: deps,
    actualSearchProvider,
    actualFetchProvider,
    originalSearchCalls: counter.calls,
    originalSearchBaseline: counterBaseline,
    originalSearchDelta: counterBaseline === null ? null : counter.calls - counterBaseline,
    counterSource: counter.source,
    counterAdapterVersion: counter.adapterVersion,
    hostEvidence: {
      webUid: entry.fiber.uid,
      webModule: entry.options.name,
      webInject: structuredClone(entry.options.inject ?? null),
    },
  };
}

function routeTarget(ctx, priorIntent) {
  const entry = webEntry(ctx);
  const lease = priorIntent?.lease;
  if (!lease || lease.entryId !== 'web' || lease.moduleName !== entry.options.name
    || entry.options.id !== 'web' || !entry.fiber?.uid) {
    throw new ControlRecordError('CONTROL_ROUTE_TARGET_CHANGED',
      'The current web target does not match the recorded ownership lease.');
  }
  return entry;
}

function rawConfig(value) {
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, item]) => [key, selectedId(item)]));
}

function runtimeService(entry) {
  try { return entry.fiber.ctx?.get?.('web') ?? null; } catch { return null; }
}

export function effectiveSearchProvider(entry) {
  const runtime = runtimeService(entry);
  return selectedId(entry.fiber.config?.searchProvider)
    ?? selectedId(runtime?.searchProviderId ?? runtime?.config?.searchProvider)
    ?? selectedId(entry.options.config?.searchProvider)
    ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
}

export function effectiveFetchProvider(entry) {
  const runtime = runtimeService(entry);
  return selectedId(entry.fiber.config?.fetchProvider)
    ?? selectedId(runtime?.fetchProviderId)
    ?? selectedId(runtime?.config?.fetchProvider)
    ?? selectedId(entry.options.config?.fetchProvider)
    ?? process.env.DSH_WEB_FETCH_PROVIDER ?? null;
}

async function updateWebEntry(entry, next, preserveEntryConfig = false) {
  if (typeof entry.update !== 'function') {
    throw new ControlRecordError('CONTROL_ROUTE_UPDATE_CAPABILITY_REQUIRED',
      'The loader entry cannot apply a volatile route update.');
  }
  const entryConfig = entry.options?.config;
  if (entry.options && entry.fiber?.config) {
    entry.options.config = { ...entryConfig, ...rawConfig(entry.fiber.config) };
  }
  try {
    await entry.update({ config: next });
  } finally {
    if (preserveEntryConfig && entry.options) entry.options.config = entryConfig;
  }
  if (entry.fiber.state !== 2) throw new ControlRecordError('CONTROL_ROUTE_UPDATE_FAILED',
    'The web target is not active after the route update.');
}

export async function takeOverAuthorRoute(ctx, acquisition, lease) {
  const entry = routeTarget(ctx, { lease });
  const author = acquisition?.authorSearchProvider ?? null;
  const actual = effectiveSearchProvider(entry);
  if (actual === PRODUCT_PROVIDER_ID) return { routeChanged: false, actualSearchProvider: actual };
  if (actual !== author) {
    throw new ControlRecordError('CONTROL_ROUTE_OWNERSHIP_CONFLICT',
      'The current web route is neither the recorded author nor the product provider.');
  }
  const current = rawConfig(entry.fiber.config);
  const rollback = async () => {
    try { await updateWebEntry(entry, current, true); } catch {}
  };
  try {
    await updateWebEntry(entry, { ...current, searchProvider: PRODUCT_PROVIDER_ID }, true);
  } catch (error) {
    await rollback();
    throw error;
  }
  const updated = effectiveSearchProvider(entry);
  if (updated !== PRODUCT_PROVIDER_ID) {
    await rollback();
    throw new ControlRecordError('CONTROL_ROUTE_UPDATE_NOT_APPLIED',
      'The web target did not apply the product search provider.');
  }
  return { routeChanged: true, actualSearchProvider: updated };
}

export async function restoreAuthorRoute(ctx, priorIntent) {
  const entry = routeTarget(ctx, priorIntent);
  const acquisition = priorIntent?.acquisition;
  if (!acquisition || acquisition.searchBundle !== PRODUCT_SEARCH_BUNDLE) {
    throw new ControlRecordError('CONTROL_ROUTE_PROVENANCE_REQUIRED',
      'The recorded author route provenance is incomplete.');
  }
  const author = acquisition.authorSearchProvider ?? null;
  const authorPresent = Object.hasOwn(acquisition, 'authorSearchProviderPresent')
    ? acquisition.authorSearchProviderPresent === true : author !== null;
  const actual = effectiveSearchProvider(entry);
  if (actual !== author && actual !== PRODUCT_PROVIDER_ID) {
    throw new ControlRecordError('CONTROL_ROUTE_OWNERSHIP_CONFLICT',
      'The current web route was changed by another owner; the recorded author was not restored.');
  }
  const current = rawConfig(entry.fiber.config);
  const next = { ...current };
  if (authorPresent) next.searchProvider = author;
  else delete next.searchProvider;
  const changed = !isDeepStrictEqual(next.searchProvider, current.searchProvider);
  if (changed) await updateWebEntry(entry, next);
  return { routeChanged: changed, actualSearchProvider: effectiveSearchProvider(entry) };
}

export function createProductReleaseController({ ctx, priorIntent, core, routeVerifier = null, onState = () => {},
  disposeTimeoutMs = 2_000, counterSnapshot = null }) {
  if (!core || !core.releaseBarrier || typeof core.dispose !== 'function') {
    throw new ControlRecordError('CONTROL_RELEASE_CORE_REQUIRED',
      'The query core and its release barrier must be present before an explicit release.');
  }
  if (!Number.isSafeInteger(disposeTimeoutMs) || disposeTimeoutMs < 1) {
    throw new ControlRecordError('CONTROL_RELEASE_DRAIN_TIMEOUT',
      'The query executor drain deadline must be a positive integer.');
  }
  let stopping = false;
  let disposeTask = null;
  let routeBefore = null;
  const barrier = core.releaseBarrier;
  // Native bundle teardown disposes children concurrently. Hold the public
  // loader reference before invalidation; a drained child context no longer
  // resolves injected services, even while the root is awaiting this release.
  const routeContext = counterSnapshot ? { loader: ctx.loader } : ctx;
  return {
    invalidate({ reason }) {
      if (!stopping) {
        try { routeBefore = effectiveSearchProvider(webEntry(routeContext)); } catch { routeBefore = null; }
        barrier.invalidate({ reason });
        stopping = true;
        onState('stopping');
        try { disposeTask = core.dispose(); }
        catch (error) { disposeTask = Promise.reject(error); }
        disposeTask?.catch?.(() => {});
      }
      return { stopping: true, available: false };
    },
    async drain() {
      if (!stopping) throw new ControlRecordError('CONTROL_RELEASE_BARRIER_NOT_INVALIDATED');
      let timer;
      const disposeBound = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ControlRecordError(
          'CONTROL_RELEASE_DRAIN_TIMEOUT', 'The query executor did not settle before the release deadline.')), disposeTimeoutMs);
      });
      const results = await Promise.allSettled([
        Promise.race([disposeTask ?? Promise.resolve(), disposeBound]),
        barrier.drain(),
      ]).finally(() => clearTimeout(timer));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      return { settled: true, remaining: 0 };
    },
    async restore() {
      const restored = await restoreAuthorRoute(routeContext, priorIntent);
      const author = priorIntent?.acquisition?.authorSearchProvider ?? null;
      return { ...restored, routeBefore,
        routeChanged: restored.routeChanged || (routeBefore === PRODUCT_PROVIDER_ID && restored.actualSearchProvider === author) };
    },
    async verify({ routeChanged, counterBaseline = null }) {
      const acquisition = priorIntent?.acquisition ?? {};
      const injectBaseline = acquisition.authorInjectSha256;
      if (typeof injectBaseline !== 'string' || !/^[0-9a-f]{64}$/i.test(injectBaseline)) {
        throw new ControlRecordError('CONTROL_RELEASE_INJECT_BASELINE_REQUIRED',
          'A recorded dependency baseline is required before release verification.');
      }
      const recordedSearch = Object.hasOwn(acquisition, 'authorSearchProvider')
        ? acquisition.authorSearchProvider : authorSearchProvider(ctx);
      const recordedFetch = Object.hasOwn(acquisition, 'authorFetchProvider')
        ? acquisition.authorFetchProvider : authorFetchProvider(ctx);
      const verifier = counterSnapshot ? null : routeVerifier ?? ctx.get('grokSearchRouteVerifier');
      if (typeof verifier?.verify === 'function') {
        return verifier.verify({
          authorSearchProvider: recordedSearch,
          authorSearchProviderPresent: acquisition.authorSearchProviderPresent,
          authorFetchProvider: recordedFetch,
          authorInjectSha256: injectBaseline,
          routeChanged, counterBaseline,
        });
      }
      return routeReceipt(routeContext, {
        authorSearchProvider: recordedSearch,
        authorFetchProvider: recordedFetch,
        expectedInjectSha256: injectBaseline,
        routeChanged, counterBaseline,
        ...(counterSnapshot ? { counterSnapshot: counterSnapshot() } : {}),
      });
    },
  };
}
