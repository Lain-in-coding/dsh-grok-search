import { createGrokProvider } from './provider.mjs';
import { createReleaseBarrier } from './core/release-transaction.mjs';
import { GrokSearchError } from './core/errors.mjs';
import { createSharedConfigStore } from './core/shared-config.mjs';
import { createSourceRouter } from './core/source-adapters.mjs';
import { createRoutedSearch } from './core/routed-search.mjs';

export const name = 'dsh-grok-search';
export const inject = ['web', 'profileContext', 'grokSearchProgram', 'grokSearchPreferences'];
export { Config } from './core/product-config.mjs';

export function apply(ctx, config, { WebError = ctx.get('grokSearchHostAdapter')?.WebError,
  assertExecution = () => {
    const compatibility = ctx.get('grokSearchCompatibility');
    if (typeof compatibility?.assertSearchAllowed !== 'function') {
      throw new GrokSearchError('COMPATIBILITY_CHECKING', 'Runtime compatibility has not been established.');
    }
    return compatibility.assertSearchAllowed('search');
  },
  executionEpoch = () => ctx.get('grokSearchCompatibility')?.captureEpoch() ?? 0 } = {}) {
  if (typeof WebError !== 'function') {
    throw new GrokSearchError('COMPATIBILITY_WEB_ERROR_UNAVAILABLE', 'The host search error contract is unavailable.');
  }
  const program = ctx.get('grokSearchProgram');
  const preferences = ctx.get('grokSearchPreferences');
  const getConfig = () => {
    const state = program?.snapshot?.();
    const path = state?.configPath;
    if (!path) return null;
    // Reading source settings must not require a ready Grok executable.
    return { ...createSharedConfigStore({ path }).readSnapshot(),
      execution: state.phase === 'ready' ? program.execution() : { executable: '', configPath: path } };
  };
  const rawSourceRouter = createSourceRouter({
    getConfig,
    budgetMs: config.budgetMs ?? 120_000,
    getPreferences: () => preferences?.snapshot?.() ?? null,
  });
  const sourceRouter = { ...rawSourceRouter };
  for (const method of ['search', 'diagnose', 'diagnoseProvider']) {
    sourceRouter[method] = async (...args) => {
      assertExecution();
      return rawSourceRouter[method](...args);
    };
  }
  ctx.provide('grokSearchSourceRouter', sourceRouter);
  const core = createGrokProvider({ configuration: config,
    ...(program ? { executionConfiguration: () => program.execution() } : {}) });
  const diagnosticCancellers = new Set();
  const dispose = async () => {
    for (const cancel of diagnosticCancellers) cancel();
    const results = await Promise.allSettled([routed.dispose(), core.dispose()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  };
  const releaseBarrier = createReleaseBarrier();
  const callRoutes = ctx.get('grokSearchCallRoutes');
  const routed = createRoutedSearch({ grok: core.provider, canFallback: core.canFallback, sourceRouter, preferences, releaseBarrier,
    searchLog: ctx.get('grokSearchLog'),
    getConfig, budgetMs: config.budgetMs ?? 120_000, assertExecution, executionEpoch });
  const provider = {
    ...core.provider,
    available: routed.available,
    // The host passes only (request, signal); the origin is fixed here.
    search: (request, signal) => routed.search(request, signal, 'search', callRoutes?.capture() ?? null),
  };
  // 注册和回收均属于当前插件 fiber，没有借根上下文遗留效果。
  ctx.effect(() => dispose);
  ctx.provide('grokSearchCore', {
    snapshot: () => ({ ...core.snapshot(), routeExecutor: routed.snapshot() }),
    programSnapshot: () => program?.snapshot() ?? null,
    testSearch: (request, signal) => routed.search(request, signal, 'test'),
    testGrok: routed.testGrok,
    scheduleDiagnosis: routed.scheduleDiagnosis,
    routeSnapshot: routed.routeSnapshot,
    searchLog: routed.searchLog,
    budgetMs: config.budgetMs ?? 120_000,
    dispose,
    registerDiagnosticCancellation(cancel) {
      if (typeof cancel !== 'function') throw new TypeError('A diagnosis cancellation callback is required.');
      diagnosticCancellers.add(cancel);
      return () => diagnosticCancellers.delete(cancel);
    },
    releaseBarrier,
  });
  ctx.web.registerSearchProvider({
    ...provider,
    async search(request, signal) {
      try { return await provider.search(request, signal); }
      catch (error) {
        if (signal?.aborted && error === signal.reason) throw error;
        if (error instanceof GrokSearchError) throw new WebError(error.message, error.code);
        throw new WebError('Grok 查询失败，请检查程序和配置。', 'GROK_SEARCH_FAILED');
      }
    },
  });
  if (!program && !core.snapshot().executableReady) {
    ctx.logger.warn('Grok 程序尚未配置；本插件会在补充来源可用时提供受限回退。');
  }
}
