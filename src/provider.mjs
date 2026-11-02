import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { createSearchExecutor } from './core/search-executor.mjs';
import { GrokSearchError } from './core/errors.mjs';
import { createManagedMcpSearch } from './core/mcp-search.mjs';

export const PROVIDER_ID = 'grok-search';

// 本轮只实现查询核心；自动接管、临时字段所有权及持久恢复由控制层验收。
export function createGrokProvider({ configuration, sdkFactory, runQuery, executionConfiguration = () => configuration } = {}) {
  if (!configuration || typeof configuration !== 'object') throw new TypeError('需要查询配置。');
  const budgetMs = configuration.budgetMs ?? 120_000;
  const executableReady = () => {
    try {
      const current = executionConfiguration();
      return typeof current.executable === 'string' && isAbsolute(current.executable) && statSync(current.executable).isFile();
    } catch { return false; }
  };
  const session = runQuery ? null : createManagedMcpSearch();
  const executor = createSearchExecutor({
    budgetMs,
    maxRunning: 1,
    runQuery: runQuery ?? session.run,
    snapshot: () => {
      const current = executionConfiguration();
      if (!executableReady()) throw new GrokSearchError('GROK_PROGRAM_MISSING', 'Grok 程序不存在，请在插件设置中检查程序状态。');
      if (current.configPath && !isAbsolute(current.configPath)) throw new GrokSearchError('GROK_CONFIG_INVALID', 'Grok 配置文件必须使用绝对路径。');
      return { executable: current.executable, executableArgs: [...(current.executableArgs ?? [])],
        ...(current.configPath ? { configPath: current.configPath } : {}),
        ...(current.envOverrides ? { envOverrides: { ...current.envOverrides } } : {}),
        ...(sdkFactory ? { sdkFactory } : {}) };
    },
  });
  return {
    provider: { id: PROVIDER_ID, available: () => executableReady() && executor.snapshot().accepting,
      search: (request, signal) => executor.search(request, signal) },
    snapshot: () => ({ ...executor.snapshot(), executableReady: executableReady(), session: session?.snapshot() ?? null }),
    async dispose() {
      const outcomes = await Promise.allSettled([executor.dispose(), session?.dispose()]);
      for (const result of outcomes) if (result.status === 'rejected') throw result.reason;
    },
  };
}
