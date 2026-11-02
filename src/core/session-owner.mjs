import { GrokSearchError } from './errors.mjs';

const stopped = () => new GrokSearchError('GROK_SEARCH_STOPPING', '搜索会话正在退出，请稍后重试。');

// Owns one reusable connection. The outer executor owns the bounded queue and
// deadline; open/run/close must honour that deadline and reap their own process.
// A rejected close is retained: never launch a replacement over an unproven exit.
export function createSessionOwner({ open, idleMs = 300_000, onError = () => {} } = {}) {
  if (typeof open !== 'function' || typeof onError !== 'function') throw new TypeError('会话工厂与错误处理器必须是函数。');
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 2_147_483_647) throw new TypeError('空闲退出时间无效。');
  let current = null, active = null, closing = null, idleTimer = null;
  let disposed = false, disposal = null, fault = null, generation = 0;
  const clearIdle = () => { clearTimeout(idleTimer); idleTimer = null; };
  const retire = () => {
    clearIdle();
    if (closing) return closing;
    if (!current) return Promise.resolve();
    const retiring = current;
    current = null;
    const pending = Promise.resolve().then(() => retiring.session.close());
    closing = pending;
    pending.then(() => { if (closing === pending) closing = null; }, error => { fault = error; });
    return pending;
  };
  const armIdle = () => {
    clearIdle();
    if (disposed || active || !current || fault) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void retire().catch(error => {
        // Reporting is not part of resource ownership; never replace the fault.
        try { onError(error); } catch { /* caller diagnostics must not crash timers */ }
      });
    }, idleMs);
    idleTimer.unref?.();
  };
  return {
    run({ identity, configuration, signal, operation }) {
      if (typeof identity !== 'string' || !identity || typeof operation !== 'function') return Promise.reject(new TypeError('会话身份与操作无效。'));
      if (disposed) return Promise.reject(stopped());
      if (fault) return Promise.reject(fault);
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (active) return Promise.reject(new GrokSearchError('GROK_SESSION_BUSY', '搜索会话正在使用，请通过查询队列串行派发。'));
      clearIdle();
      const controller = new AbortController();
      const forward = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', forward, { once: true });
      if (signal?.aborted) forward();
      const mine = { controller, task: null, generation };
      active = mine;
      const execute = async () => {
        try {
          if (closing) await closing;
          controller.signal.throwIfAborted();
          if (current && current.identity !== identity) await retire();
          controller.signal.throwIfAborted();
          if (!current) {
            const session = await open(configuration, controller.signal);
            if (!session || typeof session.close !== 'function') throw new TypeError('会话工厂必须返回可回收的连接。');
            current = { identity, session };
          }
          controller.signal.throwIfAborted();
          if (disposed || mine.generation !== generation) throw stopped();
          const value = await operation(current.session, controller.signal);
          controller.signal.throwIfAborted();
          return value;
        } catch (error) {
          // Cancellation or an uncertain protocol result invalidates the whole
          // connection, including a connection delivered late by open().
          await retire();
          throw controller.signal.aborted ? controller.signal.reason : error;
        } finally {
          signal?.removeEventListener('abort', forward);
          if (active === mine) active = null;
          armIdle();
        }
      };
      mine.task = Promise.resolve().then(execute);
      return mine.task;
    },
    snapshot() {
      return { disposed, active: Boolean(active), connected: Boolean(current),
        closing: Boolean(closing), faulted: fault !== null, generation };
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      generation++;
      clearIdle();
      const running = active;
      running?.controller.abort(stopped());
      disposal = (async () => {
        const outcomes = await Promise.allSettled([retire(), running?.task]);
        // A factory may have completed after the initial retire().
        await retire();
        if (fault) throw fault;
        const cleanupFailure = outcomes[0];
        if (cleanupFailure.status === 'rejected') throw cleanupFailure.reason;
      })();
      return disposal;
    },
  };
}
