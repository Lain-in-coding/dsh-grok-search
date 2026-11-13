import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createControlIntentStore } from './control-intent-store.mjs';

const tasks = new Map();
const idle = () => ({ status: 'idle', at: null });

/**
 * One credential-free maintenance worker per active store. Expensive legacy
 * validation and sealing never runs on the DSH event loop. Callers share it;
 * Disposal requests safe cancellation only after every caller releases its
 * lease. A new owner waits for that cancelled worker before starting another.
 */
export function createStorageMaintenanceWorker({
  directory, legacyPath, trustedRoot, onResult = () => {}, timeoutMs = 30_000,
  retryDelayMs = 250, workerFactory = (url, options) => new Worker(url, options),
}) {
  const identity = `${directory}\0${legacyPath ?? ''}\0${trustedRoot ?? ''}`;
  let task = tasks.get(identity);
  if (!task) {
    task = { refs: 0, worker: null, pending: null, timer: null, retry: null,
      listeners: new Set(), latest: idle(), disposed: false, retries: 0, again: false };
    tasks.set(identity, task);
  }
  // Keep the shared task reachable while its last worker is cancelling. A
  // hot-reloaded owner must not launch a second full scan beside that worker.
  task.disposed = false;
  task.refs++;
  task.listeners.add(onResult);
  let released = false;
  const schedule = (retry = false) => {
    if (task.disposed) return Promise.resolve(task.latest);
    if (task.pending) { if (!retry) task.again = true; return task.pending; }
    clearTimeout(task.retry); task.retry = null;
    if (!retry) task.retries = 0;
    let resolve;
    task.pending = new Promise(done => { resolve = done; });
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(task.timer); task.timer = null;
      const worker = task.worker; task.worker = null;
      task.pending = null;
      task.latest = result;
      for (const listener of task.listeners) {
        try { listener(result); } catch {}
      }
      void worker?.terminate().catch(() => {});
      resolve(result);
      const again = task.again; task.again = false;
      if (again && result.status !== 'error' && !task.disposed && task.refs > 0 && !task.retry) {
        task.retry = setTimeout(() => { task.retry = null; void schedule(true); }, retryDelayMs);
        task.retry.unref?.();
      }
      if (task.disposed && task.refs === 0 && tasks.get(identity) === task) tasks.delete(identity);
      if (result.status === 'busy' && task.retries++ < 2 && !task.disposed && task.refs > 0 && !task.retry) {
        task.retry = setTimeout(() => { task.retry = null; void schedule(true); }, retryDelayMs);
        task.retry.unref?.();
      }
    };
    try {
      // Never pass process.execArgv: debugging or test flags from the host must
      // not turn the maintenance worker into another app or test runner.
      const worker = workerFactory(new URL('./storage-worker.mjs', import.meta.url), {
        execArgv: [], env: {}, workerData: { directory, legacyPath, trustedRoot },
      });
      task.worker = worker;
      const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
      task.cancelFlag = cancelFlag;
      worker.postMessage?.({ cancelBuffer: cancelFlag.buffer });
      worker.once('message', result => finish(result));
      worker.once('error', error => finish({ status: 'error', code: error.code ?? 'CONTROL_MAINTENANCE_WORKER',
        message: 'Control history maintenance worker failed.' }));
      worker.once('exit', code => {
        if (!finished) finish({ status: 'error', code: 'CONTROL_MAINTENANCE_EXIT',
          message: `Control history maintenance exited without a receipt (${code}).` });
      });
      task.timer = setTimeout(() => {
        Atomics.store(cancelFlag, 0, 1);
        // Do not terminate mid-file operation: the worker observes cancellation
        // at explicit maintenance boundaries, then releases its owned lock.
      }, timeoutMs);
      task.timer.unref?.();
    } catch (error) {
      finish({ status: 'error', code: error.code ?? 'CONTROL_MAINTENANCE_WORKER',
        message: 'Unable to start the control history maintenance worker.' });
    }
    return task.pending ?? Promise.resolve(task.latest);
  };
  return Object.freeze({
    schedule: () => released ? Promise.resolve(task.latest) : schedule(),
    status: () => ({ ...task.latest }),
    dispose() {
      if (released) return;
      released = true;
      task.listeners.delete(onResult);
      task.refs--;
      if (task.refs !== 0) return;
      task.disposed = true;
      clearTimeout(task.retry); task.retry = null;
      clearTimeout(task.timer); task.timer = null;
      if (task.cancelFlag) Atomics.store(task.cancelFlag, 0, 1);
      if (!task.pending && tasks.get(identity) === task) tasks.delete(identity);
    },
  });
}

if (!isMainThread && workerData?.directory) {
  parentPort.once('message', ({ cancelBuffer }) => {
    const cancelFlag = new Int32Array(cancelBuffer);
    try {
      const store = createControlIntentStore({ ...workerData, fault(stage) {
        if (stage === 'maintenance-progress' || stage === 'before-checkpoint-publish') {
          if (Atomics.load(cancelFlag, 0)) throw Object.assign(new Error('Maintenance cancelled at a safe boundary.'), { code: 'CONTROL_MAINTENANCE_CANCELLED' });
        }
      } });
      parentPort.postMessage(store.maintain());
    } catch (error) {
      parentPort.postMessage({ status: error.code === 'CONTROL_MAINTENANCE_CANCELLED' ? 'cancelled' : 'error',
        code: error.code ?? 'CONTROL_MAINTENANCE_FAILED',
        message: 'Control history maintenance did not complete; existing evidence was retained.' });
    }
  });
}
