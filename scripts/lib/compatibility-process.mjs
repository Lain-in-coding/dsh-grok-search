import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Only children created here are eligible for termination. An unverified
// descendant/pipe cleanup is a failed run, never a successful smoke receipt.
export async function runBoundedCommand(executable, args, {
  cwd, env, signal, timeout = 180_000, limit = 16 * 1024 * 1024, drainMs = 1000, killGraceMs = 5000,
} = {}) {
  signal?.throwIfAborted();
  const child = spawn(executable, args, {
    cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', size = 0, failure = null, killTimer, finalTimer, drainTimer;
  const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
  let exitCode = null, exitSignal = null, settled = false, terminating = false, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const complete = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finalTimer); clearTimeout(drainTimer);
    signal?.removeEventListener('abort', abort);
    stdout += decoders.out.end(); stderr += decoders.err.end();
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
    finish({ code: exitCode, signal: exitSignal, stdout, stderr, failure });
  };
  const terminateTree = force => {
    if (!Number.isSafeInteger(child.pid)) return;
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= 'COMPATIBILITY_SMOKE_CLEANUP_FAILED'; }
      return;
    }
    const systemRoot = env?.SystemRoot || env?.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows';
    const killer = spawn(join(systemRoot, 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, shell: false, stdio: 'ignore' });
    killer.on('error', () => { failure ??= 'COMPATIBILITY_SMOKE_CLEANUP_FAILED'; });
    const stopKiller = setTimeout(() => { killer.kill(); killer.unref(); }, killGraceMs);
    stopKiller.unref();
    killer.once('close', () => clearTimeout(stopKiller));
    child.kill('SIGKILL');
  };
  const terminate = code => {
    failure ??= code;
    if (terminating || settled) return;
    terminating = true;
    clearTimeout(drainTimer);
    terminateTree(false);
    killTimer = setTimeout(() => terminateTree(true), Math.min(1000, killGraceMs));
    // Inherited pipes cannot hold the runner forever after its child exits.
    finalTimer = setTimeout(complete, killGraceMs);
  };
  const abort = () => terminate('COMPATIBILITY_SMOKE_CANCELLED');
  const timer = setTimeout(() => terminate('COMPATIBILITY_SMOKE_TIMEOUT'), timeout);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const collect = stream => bytes => {
    size += bytes.length;
    if (size > limit) return terminate('COMPATIBILITY_SMOKE_OUTPUT_LIMIT');
    const text = decoders[stream].write(bytes);
    if (stream === 'out') stdout += text; else stderr += text;
  };
  child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
  child.once('error', () => { failure ??= 'COMPATIBILITY_SMOKE_SPAWN_FAILED'; complete(); });
  child.once('exit', (code, signal) => {
    exitCode = code; exitSignal = signal;
    if (!settled && !terminating) drainTimer = setTimeout(() => terminate('COMPATIBILITY_SMOKE_PIPE_TIMEOUT'), drainMs);
  });
  child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; complete(); });
  return done;
}
