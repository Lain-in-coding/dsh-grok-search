import z from '@deepseek-ai/schemastery';
import { WebError } from '@deepseek-ai/dsh-web';
import { createGrokProvider } from './provider.mjs';
import { createReleaseBarrier } from './core/release-transaction.mjs';
import { GrokSearchError } from './core/errors.mjs';
import { createSharedConfigStore } from './core/shared-config.mjs';
import { createSourceRouter } from './core/source-adapters.mjs';
import { createRoutedSearch } from './core/routed-search.mjs';

export const name = 'dsh-grok-search';
export const inject = ['web', 'profileContext', 'grokSearchProgram', 'grokSearchPreferences'];
export const Config = z.object({
  executable: z.string().default('').description('已有 grok-search-rs 程序的绝对路径。'),
  executableArgs: z.array(z.string()).default([]).description('程序启动参数；内部离线验证也使用此字段。'),
  configPath: z.string().default('').description('已有 Grok 配置文件的绝对路径；留空时由 Grok 按自身规则读取。'),
  budgetMs: z.number().min(30_000).max(120_000).default(120_000).description('单次查询总预算，单位毫秒，包含排队与本地回收。'),
});

export function apply(ctx, config) {
  const program = ctx.get('grokSearchProgram');
  const preferences = ctx.get('grokSearchPreferences');
  const getConfig = () => {
    const path = program?.snapshot?.()?.configPath;
    if (!path) return null;
    return createSharedConfigStore({ path }).readEffective();
  };
  const sourceRouter = createSourceRouter({
    getConfig,
    getPreferences: () => preferences?.snapshot?.() ?? null,
  });
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
  const routed = createRoutedSearch({ grok: core.provider, sourceRouter, preferences, releaseBarrier,
    getConfig, budgetMs: config.budgetMs ?? 120_000 });
  const provider = {
    ...core.provider,
    available: () => releaseBarrier.snapshot().state === 'active'
      && routed.snapshot().accepting && (core.provider.available() || sourceRouter.snapshot().available),
    // The host passes only (request, signal); the origin is fixed here.
    search: (request, signal) => routed.search(request, signal, 'search'),
  };
  // 注册和回收均属于当前插件 fiber，没有借根上下文遗留效果。
  ctx.effect(() => dispose);
  ctx.provide('grokSearchCore', {
    snapshot: () => ({ ...core.snapshot(), routeExecutor: routed.snapshot() }),
    programSnapshot: () => program?.snapshot() ?? null,
    testSearch: (request, signal) => routed.search(request, signal, 'test'),
    testGrok: routed.testGrok,
    routeSnapshot: routed.routeSnapshot,
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
