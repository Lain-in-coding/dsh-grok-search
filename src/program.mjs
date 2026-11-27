import { join } from 'node:path';
import { createPrivateProgramInstaller, isRepairableProgramCode, resolveGrokProgram } from './core/program-install.mjs';
import { resolveSharedConfigPath } from './core/config-path.mjs';
import { GrokSearchError } from './core/errors.mjs';

export const name = 'dsh-grok-search-program';
export const inject = ['profileContext'];

export function createProgramController({ configuration, directory, env = () => process.env,
  resolveProgram = resolveGrokProgram, installer = createPrivateProgramInstaller({ directory }) }) {
  let task = null, abort = null, disposed = false, failure = null, resolved = null, pendingExit = null;
  // Whether the loader config pins a program or a config file. Only booleans:
  // the settings view never needs the configured values themselves.
  const state = { phase: 'idle', program: null, configPath: null, error: null, canRepair: false,
    configuration: { executable: Boolean(configuration.executable), configPath: Boolean(configuration.configPath) } };
  const snapshot = () => structuredClone(state);
  const prepare = (repair = false) => {
    if (disposed) return Promise.reject(new GrokSearchError('GROK_SEARCH_STOPPING', '程序管理器已停止。'));
    if (task) return task;
    if (pendingExit) return Promise.reject(pendingExit);
    if (repair && !state.canRepair) return Promise.reject(new GrokSearchError('GROK_CACHE_REPAIR_UNAVAILABLE', '当前没有可重新准备的损坏私有缓存，请先重新检测。'));
    state.phase = 'discovering';
    state.error = null;
    state.program = null;
    resolved = null;
    failure = null;
    abort = new AbortController();
    task = (async () => {
      const environment = { ...env() };
      state.configPath = resolveSharedConfigPath({ override: configuration.configPath, env: environment });
      resolved = await resolveProgram({ installer, configured: configuration.executable, repair,
        env: environment, signal: abort.signal, onProgress: progress => {
          if (!disposed) state.phase = progress.phase;
        } });
      abort.signal.throwIfAborted();
      if (disposed) throw new GrokSearchError('GROK_SEARCH_STOPPING', '程序管理器已停止。');
      state.program = { path: resolved.path, version: resolved.version, source: resolved.source, sha256: resolved.sha256 };
      state.phase = 'ready';
      state.canRepair = false;
      return snapshot();
    })().catch(error => {
      failure = error instanceof GrokSearchError ? error : new GrokSearchError('GROK_PROGRAM_PREPARE_FAILED', 'Grok 程序准备失败，请重试。');
      if (['GROK_PROGRAM_REAP_FAILED', 'GROK_PROCESS_REAP_FAILED'].includes(failure.code)) {
        const unreaped = failure;
        pendingExit = unreaped;
        if (typeof unreaped.whenExited?.then === 'function') {
          Promise.resolve(unreaped.whenExited).then(() => {
            if (pendingExit === unreaped) pendingExit = null;
          }, () => {});
        }
      }
      if (!disposed) {
        state.phase = 'error';
        state.error = { code: failure.code, message: failure.message };
        state.canRepair = !configuration.executable && (isRepairableProgramCode(failure.code) || repair && ![
          'GROK_CACHE_PATH_INVALID', 'GROK_CACHE_ACCESS_DENIED', 'GROK_PROGRAM_REAP_FAILED',
          'GROK_PROCESS_REAP_FAILED', 'GROK_SEARCH_STOPPING',
        ].includes(failure.code));
      }
      throw failure;
    }).finally(() => { task = null; });
    return task;
  };
  return {
    snapshot, prepare: () => prepare(false), repair: () => prepare(true),
    execution() {
      if (disposed) throw new GrokSearchError('GROK_SEARCH_STOPPING', '程序管理器已停止。');
      if (failure) throw failure;
      if (state.phase !== 'ready' || !resolved) throw new GrokSearchError('GROK_PROGRAM_PREPARING', '正在准备 Grok 程序，请稍后重试。');
      return { ...configuration, executable: resolved.path, configPath: state.configPath };
    },
    async dispose() {
      disposed = true;
      state.phase = 'disposed';
      abort?.abort(new GrokSearchError('GROK_SEARCH_STOPPING', '程序管理器已停止。'));
      if (task) await Promise.allSettled([task]);
      // Preparation may already have settled. Only its actual exit proof can
      // clear a cleanup failure; an ordinary preparation error owns no process.
      if (pendingExit) throw pendingExit;
    },
  };
}

export function apply(ctx, configuration) {
  const manager = createProgramController({ configuration, directory: join(ctx.profileContext.dir, 'grok-search/runtime-cache') });
  ctx.provide('grokSearchProgram', manager);
  ctx.effect(() => () => manager.dispose());
  // Preparing a program must not hold the configuration UI hostage. The core
  // stays fail-closed while this state is pending or reports an explicit error.
  void manager.prepare().catch(() => {});
}
