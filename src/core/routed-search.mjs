import { randomUUID } from 'node:crypto';
import { GrokSearchError } from './errors.mjs';
import { createSearchExecutor } from './search-executor.mjs';
import { mapSearchResult, searchSourceProvenance } from './result-map.mjs';
import { createSearchLog } from './search-log.mjs';

const CODE = /^[\w.-]{1,64}$/;
const SOURCES = new Set(['grok', 'tavily', 'exa', 'tinyfish', 'firecrawl']);
const codeOf = error => typeof error?.code === 'string' && CODE.test(error.code) ? error.code : 'GROK_SEARCH_FAILED';
const failureRows = list => (Array.isArray(list) ? list : []).slice(0, 8)
  .map(item => ({ provider: String(item?.provider ?? ''), code: codeOf(item) }))
  .filter(item => SOURCES.has(item.provider));

/**
 * Grok first; when it fails, is switched off or not ready, the shared
 * supplementary chain in its configured order. Never the official search.
 *
 * The final route of every real search is kept for the settings view. It holds
 * only stable codes and provider ids: never the query, results, URLs, keys or
 * upstream text.
 */
export function createRoutedSearch({ grok, sourceRouter, preferences, releaseBarrier, searchLog: suppliedLog,
  getConfig = () => ({}), budgetMs = 120_000, cleanupMs = 2_000, now = Date.now }) {
  let lastRoute = null;
  const searchLog = suppliedLog ?? createSearchLog({ now });
  const fromSources = (result, grokCode) => ({ outcome: 'ok',
    served: SOURCES.has(result?.search_provider) ? result.search_provider : null,
    grokCode, fallbackUsed: true, failures: failureRows(result?.diagnostic?.failures) });
  // grok-search-rs can itself answer from its source chain when Grok fails.
  const fromGrok = result => {
    const diagnostic = result?.diagnostic ?? {};
    const provenance = searchSourceProvenance(result.sources);
    const hasProvenance = diagnostic.sourceProvenance !== undefined || provenance.resultProviders.length > 0;
    const details = hasProvenance ? {
      resultProviders: provenance.resultProviders,
      resultProvidersComplete: provenance.resultProvidersComplete,
      provenance: 'source-label',
    } : {};
    const fallback = provenance.fallbackProviders;
    // The top-level "source_fallback" is not a supplier. The exact per-source
    // *_fallback labels identify suppliers of retained results, not attempts.
    const served = fallback.length === 1 ? fallback[0] : provenance.resultProviders.length === 1
      && provenance.resultProviders[0] === 'grok' && provenance.resultProvidersComplete ? 'grok' : 'grok-sources';
    return diagnostic.fallbackUsed === true
      ? { outcome: 'ok', served, fallbackUsed: true, failures: [], ...details,
        grokCode: typeof diagnostic.fallbackReason === 'string' && CODE.test(diagnostic.fallbackReason)
          ? diagnostic.fallbackReason : 'grok_provider_error' }
      : { outcome: 'ok', served: 'grok', grokCode: null, fallbackUsed: false, failures: [], ...details };
  };
  const tracked = async work => {
    const operationId = randomUUID();
    releaseBarrier.begin({ operationId });
    try { return await work(); }
    finally { releaseBarrier.settle({ operationId }); }
  };
  const configuration = () => {
    const config = getConfig();
    const item = (config?.fields ?? config)?.response_max_chars;
    const value = item && typeof item === 'object' && Object.hasOwn(item, 'value') ? item.value : item;
    // Respect imported lower/higher values, with a fixed local safety ceiling.
    // Tiny budgets still need the minimal result envelope; do not silently
    // replace an invalid config with an unrelated 45k budget.
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 100)) {
      throw new GrokSearchError('GROK_CONFIG_INVALID', '回复字符上限至少需要 100 字符，请检查共享配置。');
    }
    return { maxChars: value === undefined ? 45_000 : Math.min(500_000, value) };
  };
  const bounded = (result, maxChars, maxResults) => {
    const normalized = mapSearchResult(result, { maxChars, maxResults });
    // Extra route metadata is for internal diagnostics, not enumerable tool
    // output. Otherwise it can itself push JSON beyond the configured limit.
    for (const key of ['search_provider', 'fallback_used', 'fallback_reason', 'diagnostic']) {
      if (result[key] !== undefined) Object.defineProperty(normalized, key, { value: result[key] });
    }
    return normalized;
  };

  async function dispatch(request, signal, origin, maxChars) {
      const token = request.logToken;
      const record = (origin, route) => {
        lastRoute = { at: now(), origin, ...route };
        if (token) token.route = { ...route, callsComplete: route.grokCode === 'DISABLED' };
      };
      const onCall = call => searchLog.call(token, call);
      if (preferences?.snapshot?.()?.value?.grokEnabled === false) {
        try {
          const result = await sourceRouter.search({ ...request, signal, reason: 'grok-disabled', onCall });
          signal?.throwIfAborted();
          const output = bounded(result, maxChars, request.maxResults);
          record(origin, fromSources(result, 'DISABLED'));
          return output;
        } catch (error) {
          if (!signal?.aborted) record(origin, { outcome: 'failed', served: null, grokCode: 'DISABLED',
            fallbackUsed: false, failures: failureRows(error?.details?.failures), code: codeOf(error) });
          throw error;
        }
      }
      let primary;
      try {
        const result = await grok.search(request, signal);
        signal?.throwIfAborted();
        const output = bounded(result, maxChars, request.maxResults);
        const route = fromGrok(output);
        onCall({ provider: 'grok', result: route.fallbackUsed ? 'failed' : 'ok',
          code: route.fallbackUsed ? route.grokCode : '' });
        for (const provider of route.resultProviders || []) {
          if (provider !== 'grok') onCall({ provider, operation: 'supplement', result: 'ok', evidence: 'source-label' });
        }
        if (route.fallbackUsed && (!route.resultProviders || !route.resultProvidersComplete)) {
          onCall({ provider: 'grok-sources', result: 'ok', evidence: 'source-label' });
        }
        record(origin, route);
        return output;
      } catch (error) {
        onCall({ provider: 'grok', result: signal?.aborted ? 'cancelled' : 'failed', code: codeOf(error) });
        // An uncertain owned-process exit is not an upstream failure. Keep the
        // error (and whenExited proof) intact so the outer executor holds its
        // faulted slot instead of hiding it behind an otherwise valid source.
        if (error?.code === 'GROK_PROCESS_REAP_FAILED') {
          record(origin, { outcome: 'failed', served: null, grokCode: error.code,
            fallbackUsed: false, failures: [], code: error.code });
          throw error;
        }
        if (signal?.aborted) throw signal.reason;
        primary = error;
      }
      if (!sourceRouter.snapshot().available) {
        record(origin, { outcome: 'failed', served: null, grokCode: codeOf(primary), fallbackUsed: false,
          failures: [], code: codeOf(primary) });
        throw primary;
      }
      try {
        const result = await sourceRouter.search({ ...request, signal, reason: 'grok-unavailable', onCall });
        signal?.throwIfAborted();
        const output = bounded(result, maxChars, request.maxResults);
        record(origin, fromSources(result, codeOf(primary)));
        return output;
      } catch (fallbackError) {
        // A zero fallback budget is not a source failure: nothing was sent, so
        // the Grok failure itself remains the outcome, as with no source at all.
        if (fallbackError?.code === 'FALLBACK_SOURCES_ZERO' && !signal?.aborted) {
          record(origin, { outcome: 'failed', served: null, grokCode: codeOf(primary), fallbackUsed: false,
            failures: [], code: codeOf(primary) });
          throw primary instanceof GrokSearchError ? primary
            : new GrokSearchError('GROK_SEARCH_FAILED', 'Grok 查询失败，请检查程序和配置。');
        }
        // Keep the primary failure next to the per-source codes; both are
        // fixed, secret-free messages produced by this plugin.
        if (fallbackError?.code === 'SOURCE_ALL_FAILED' && Array.isArray(fallbackError.details?.failures)) {
          fallbackError.details.failures.unshift({ provider: 'grok',
            code: typeof primary?.code === 'string' ? primary.code : 'GROK_SEARCH_FAILED',
            message: primary instanceof GrokSearchError ? primary.message : 'Grok 查询失败。' });
        }
        if (!signal?.aborted) record(origin, { outcome: 'failed', served: null, grokCode: codeOf(primary),
          fallbackUsed: false, code: codeOf(fallbackError),
          failures: failureRows(fallbackError?.details?.failures).filter(item => item.provider !== 'grok') });
        throw fallbackError;
      }
  }
  // One queue/time budget covers Grok and every fallback attempt, including
  // sources-only requests. The nested Grok executor retains process ownership.
  const executor = createSearchExecutor({
    budgetMs, cleanupMs, maxRunning: 1, maxQueued: 8, snapshot: configuration,
    runQuery: ({ request, signal, maxChars }) => request.testPrimary
      ? grok.search(request, signal).then(result => ({ sources: result.sources, diagnostic: result.diagnostic ?? null }))
      : dispatch(request, signal, request.origin, maxChars),
  });
  const search = async (request, signal, origin = 'search', attribution = null) => {
    const logToken = origin === 'search' && !attribution?.suppressed ? searchLog.begin(request?.query, attribution) : null;
    // Route evidence belongs to this invocation even when its history was
    // cleared/evicted. Never fall back to the mutable lastRoute snapshot.
    const routeToken = logToken ?? {};
    try {
      const result = await tracked(() => executor.search({ ...request, origin, logToken: routeToken }, signal));
      searchLog.finish(logToken, routeToken.route);
      attribution?.finish(routeToken.route);
      return result;
    }
    catch (error) {
      const failure = { ...routeToken.route, outcome: 'failed', served: null, code: codeOf(error),
        cancelled: signal?.aborted || ['GROK_SEARCH_STOPPING', 'GROK_SEARCH_CANCELLED', 'GROK_CANCELLED'].includes(error?.code) };
      searchLog.finish(logToken, failure);
      attribution?.finish(failure);
      throw error;
    }
  };

  // Diagnostics test the primary engine alone: no supplementary fallback, so a
  // failed Grok key is reported instead of being hidden by another source.
  const testGrok = (request, signal) => tracked(() => executor.search({ ...request, testPrimary: true }, signal));

  return { search, testGrok, searchLog, dispose: async () => { if (!suppliedLog) searchLog.dispose(); return executor.dispose(); }, snapshot: executor.snapshot,
    routeSnapshot: () => lastRoute && structuredClone(lastRoute) };
}
