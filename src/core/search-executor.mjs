import { randomUUID } from 'node:crypto';
import { GrokSearchError, isRecord, timeoutError } from './errors.mjs';
import { runMcpSearch } from './mcp-search.mjs';

const stoppedError = () => new GrokSearchError('GROK_SEARCH_STOPPING', '插件正在停止查询，请等待回收完成。');
const reapError = () => new GrokSearchError('GROK_PROCESS_REAP_FAILED', '本次查询进程尚未回收，新查询已暂停。');

export function createSearchExecutor({ snapshot, runQuery = runMcpSearch, budgetMs = 120_000, cleanupMs = 2_000, maxRunning = 1, maxQueued = 8 } = {}) {
  if (typeof snapshot !== 'function' || typeof runQuery !== 'function') throw new TypeError('查询执行器需要配置快照和运行函数。');
  for (const [name, value] of Object.entries({ budgetMs, cleanupMs, maxRunning, maxQueued })) {
    if (!Number.isSafeInteger(value) || value < (name === 'maxQueued' ? 0 : 1)) throw new TypeError(name + ' 必须是有效整数。');
  }
  if (budgetMs <= cleanupMs || budgetMs > 120_000 || cleanupMs > 2_000 || maxRunning > 4 || maxQueued > 8) throw new TypeError('查询预算或容量超出内部候选范围。');
  const queue = [];
  const active = new Map();
  const faulted = new Map();
  let stopping = false, disposeTask, lastDiagnostic = null;
  const detach = record => {
    clearTimeout(record.timer);
    record.signal?.removeEventListener('abort', record.onCallerAbort);
    record.controller.signal.removeEventListener('abort', record.onAbort);
  };
  const rejectQueued = reason => {
    for (const record of queue.splice(0)) { detach(record); record.state = 'done'; record.reject(reason); }
  };
  const drain = () => {
    if (stopping || faulted.size) return;
    while (queue.length && active.size < maxRunning) {
      const record = queue.shift();
      if (record.controller.signal.aborted) { detach(record); record.reject(record.controller.signal.reason); continue; }
      record.state = 'running';
      active.set(record.id, record);
      record.task = execute(record);
      record.task.catch(() => {});
    }
  };
  async function execute(record) {
    let holdSlot = false;
    try {
      const current = await Promise.race([Promise.resolve().then(snapshot), record.aborted]);
      record.controller.signal.throwIfAborted();
      if (!isRecord(current)) throw new GrokSearchError('GROK_CONFIG_INVALID', '当前查询配置无效，请检查插件设置。');
      const captured = { ...current, ...(current.executableArgs ? { executableArgs: [...current.executableArgs] } : {}),
        ...(current.envOverrides ? { envOverrides: { ...current.envOverrides } } : {}) };
      const result = await runQuery({ ...captured, request: record.request, signal: record.controller.signal,
        queryId: record.id, cleanupMs, remainingMs: () => record.deadline - performance.now() });
      record.controller.signal.throwIfAborted();
      lastDiagnostic = result?.diagnostic ?? null;
      record.resolve(result);
    } catch (caught) {
      const error = caught?.code === 'GROK_PROCESS_REAP_FAILED' ? caught : record.controller.signal.aborted ? record.controller.signal.reason : caught;
      lastDiagnostic = error?.diagnostic ?? null;
      if (error?.code === 'GROK_PROCESS_REAP_FAILED') {
        holdSlot = true;
        faulted.set(record.id, record);
        rejectQueued(reapError());
        if (error.whenExited && typeof error.whenExited.then === 'function') {
          Promise.resolve(error.whenExited).then(() => { faulted.delete(record.id); active.delete(record.id); drain(); }, () => {});
        }
      }
      record.reject(error);
    } finally {
      detach(record);
      record.state = holdSlot ? 'reap-failed' : 'done';
      if (!holdSlot) active.delete(record.id);
      drain();
    }
  }

  return {
    search(request, signal) {
      if (!isRecord(request) || typeof request.query !== 'string' || !request.query.trim()) return Promise.reject(new GrokSearchError('GROK_QUERY_INVALID', '搜索查询不能为空。'));
      if (request.maxResults !== undefined && (!Number.isSafeInteger(request.maxResults) || request.maxResults < 0)) return Promise.reject(new GrokSearchError('GROK_QUERY_INVALID', '搜索来源上限无效。'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (stopping) return Promise.reject(stoppedError());
      if (faulted.size) return Promise.reject(reapError());
      if (active.size >= maxRunning && queue.length >= maxQueued) return Promise.reject(new GrokSearchError('GROK_QUEUE_FULL', '搜索队列已满，请稍后重试。'));
      const record = { id: randomUUID(), request: { ...request }, signal, controller: new AbortController(), state: 'queued', deadline: performance.now() + budgetMs - cleanupMs };
      const promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
      record.aborted = new Promise((_, reject) => { record.rejectAbort = reject; });
      record.aborted.catch(() => {});
      record.onCallerAbort = () => record.controller.abort(signal.reason);
      record.onAbort = () => {
        record.rejectAbort(record.controller.signal.reason);
        if (record.state !== 'queued') return;
        const index = queue.indexOf(record);
        if (index !== -1) queue.splice(index, 1);
        detach(record);
        record.state = 'done';
        record.reject(record.controller.signal.reason);
        drain();
      };
      record.controller.signal.addEventListener('abort', record.onAbort, { once: true });
      signal?.addEventListener('abort', record.onCallerAbort, { once: true });
      record.timer = setTimeout(() => record.controller.abort(timeoutError()), budgetMs - cleanupMs);
      queue.push(record);
      if (signal?.aborted) record.onCallerAbort(); else drain();
      return promise;
    },
    snapshot() { return { stopping, accepting: !stopping && faulted.size === 0, running: active.size, queued: queue.length, faulted: faulted.size, lastDiagnostic }; },
    dispose() {
      if (disposeTask) return disposeTask;
      stopping = true;
      const reason = stoppedError();
      rejectQueued(reason);
      for (const record of active.values()) record.controller.abort(reason);
      disposeTask = Promise.allSettled([...active.values()].map(record => record.task)).then(() => {
        if (faulted.size) throw reapError();
      });
      return disposeTask;
    },
  };
}
