import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_STDOUT_BYTES = 2 * 1024 * 1024;
const SYSTEM_ENV = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
]);

export class GrokSmokeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GrokSmokeError';
    this.code = code;
  }
}

function failure(code, message) {
  return new GrokSmokeError(code, message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw failure('GROK_INVALID_RESULT', `Invalid Grok ${field}.`);
  return value;
}

/** Project the external MCP result into the official dsh WebSearchResult contract. */
export function mapGrokSearchResult(result) {
  if (!object(result)) throw failure('GROK_INVALID_RESULT', 'Grok returned no MCP result object.');
  if (result.isError) throw failure('GROK_TOOL_ERROR', 'Grok web_search reported a tool error; remote error content was not retained.');
  let payload = result.structuredContent;
  if (payload === undefined) {
    const texts = Array.isArray(result.content) ? result.content.filter(block => object(block) && block.type === 'text').map(block => block.text) : undefined;
    if (!texts?.length || texts.some(text => typeof text !== 'string')) {
      throw failure('GROK_INVALID_RESULT', 'Grok returned neither structured content nor JSON text.');
    }
    try { payload = JSON.parse(texts.join('\n')); }
    catch { throw failure('GROK_INVALID_RESULT', 'Grok text result is not JSON.'); }
  }
  if (!object(payload) || !Array.isArray(payload.sources)) {
    throw failure('GROK_INVALID_RESULT', 'Grok result must contain a sources array.');
  }
  if (payload.error !== undefined && payload.error !== null) {
    throw failure('GROK_TOOL_ERROR', 'Grok returned an error payload; remote error content was not retained.');
  }
  if (payload.truncated !== undefined && typeof payload.truncated !== 'boolean') {
    throw failure('GROK_INVALID_RESULT', 'Invalid Grok truncation flag.');
  }
  if (payload.fallback_used !== undefined && typeof payload.fallback_used !== 'boolean') {
    throw failure('GROK_INVALID_RESULT', 'Invalid Grok fallback flag.');
  }
  const sources = payload.sources.map(source => {
    if (!object(source) || typeof source.url !== 'string' || !source.url.trim()) {
      throw failure('GROK_INVALID_RESULT', 'Invalid Grok source URL.');
    }
    const title = optionalString(source.title, 'source title');
    const snippet = optionalString(source.snippet ?? source.description ?? source.content, 'source snippet');
    const publishedAt = optionalString(source.publishedAt ?? source.published_date, 'source publication date');
    return {
      url: source.url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    };
  });
  return {
    searchResult: {
      content: optionalString(payload.content, 'answer') ?? '',
      sources,
      truncated: payload.truncated ?? false,
    },
    diagnostic: {
      searchProvider: optionalString(payload.search_provider, 'provider') ?? null,
      fallbackUsed: payload.fallback_used ?? null,
    },
  };
}

function environment(overrides) {
  const selected = new Map();
  for (const [key, value] of Object.entries(process.env)) {
    if (SYSTEM_ENV.has(key.toUpperCase())) selected.set(process.platform === 'win32' ? key.toUpperCase() : key, [key, value]);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!key || /[=\0]/.test(key) || (value !== null && (typeof value !== 'string' || value.includes('\0')))) {
      throw new TypeError('envOverrides must contain valid environment names and string or null values.');
    }
    const identity = process.platform === 'win32' ? key.toUpperCase() : key;
    if (value === null) selected.delete(identity);
    else selected.set(identity, [key, value]);
  }
  return Object.fromEntries(selected.values());
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new TypeError(`${label} must be a positive safe timer-sized integer.`);
}

async function loadSdk(runtimeRoot) {
  if (typeof runtimeRoot !== 'string' || !isAbsolute(runtimeRoot)) throw new TypeError('runtimeRoot must be an absolute runtime directory.');
  // This is the public "." export in bundled @modelcontextprotocol/client 2.4.0.
  return import(pathToFileURL(join(runtimeRoot, 'node_modules', '@modelcontextprotocol', 'client', 'dist', 'index.mjs')).href);
}

/** A public MCP Transport around a process already owned by this invocation. */
class OwnedStdioTransport {
  constructor(child, sdk, maxStdoutBytes, buffer) {
    this.child = child;
    this.serialize = sdk.serializeMessage;
    this.buffer = buffer;
    this.maxStdoutBytes = maxStdoutBytes;
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.exited = false;
    this.closing = false;
    this.started = false;
    this.closedNotified = false;
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.fatal = new Promise((_, reject) => { this.rejectFatal = reject; });
    this.fatal.catch(() => {});
    this.spawnPromise = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => {
        const rejected = failure('GROK_PROCESS_ERROR', 'The Grok child process failed to start or run.');
        if (typeof error.code === 'string') rejected.systemCode = error.code;
        this.fail(rejected);
        reject(rejected);
        if (child.pid === undefined) { this.exited = true; this.resolveExit(); }
      });
    });
    this.spawnPromise.catch(() => {});
    child.once('exit', (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      this.resolveExit();
      if (!this.closing) this.fail(failure('GROK_CHILD_EXIT', 'The Grok child exited before the query completed.'));
      this.notifyClosed();
    });
    child.stdout.on('error', () => this.fail(failure('GROK_STDOUT_ERROR', 'Grok stdout failed.')));
    child.stdin.on('error', () => {
      if (!this.closing) this.fail(failure('GROK_STDIN_ERROR', 'Grok stdin failed.'));
    });
    // Never retain stderr bytes: they may contain credentials loaded only by the child.
    child.stderr.on('data', chunk => { this.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stderrBytes + chunk.length); });
    child.stderr.on('error', () => this.fail(failure('GROK_STDERR_ERROR', 'Grok stderr failed.')));
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    this.rejectFatal(error);
    this.onerror?.(error);
  }

  notifyClosed() {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.onclose?.();
  }

  async start() {
    if (this.started) throw failure('GROK_TRANSPORT_STARTED', 'Grok transport was started twice.');
    this.started = true;
    this.child.stdout.on('data', chunk => {
      this.stdoutBytes += chunk.length;
      if (this.failure || this.closing) return;
      if (this.stdoutBytes > this.maxStdoutBytes) {
        this.fail(failure('GROK_STDOUT_LIMIT', 'Grok exceeded the stdout byte limit.'));
        return;
      }
      try {
        this.buffer.append(chunk);
        for (let message; (message = this.buffer.readMessage()) !== null;) this.onmessage?.(message);
      } catch {
        this.fail(failure('GROK_PROTOCOL_ERROR', 'Grok emitted an invalid MCP frame.'));
      }
    });
    await this.spawnPromise;
    if (this.failure) throw this.failure;
  }

  async send(message) {
    if (this.closing || this.exited || this.child.stdin.destroyed) throw failure('GROK_STDIN_CLOSED', 'Grok input is closed.');
    await new Promise((resolve, reject) => {
      this.child.stdin.write(this.serialize(message), error => error ? reject(failure('GROK_STDIN_ERROR', 'Writing to Grok stdin failed.')) : resolve());
    });
  }

  async waitForExit(milliseconds) {
    let timer;
    try { await Promise.race([this.exitPromise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
    finally { clearTimeout(timer); }
  }

  close() {
    return this.closingPromise ??= this.reap();
  }

  async reap() {
    this.closing = true;
    this.child.stdin.end();
    await this.waitForExit(150);
    for (const [signal, wait] of [['SIGTERM', 250], ['SIGKILL', 1_000]]) {
      if (this.exited) break;
      try { this.child.kill(signal); }
      catch { this.killFailed = true; }
      await this.waitForExit(wait);
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.buffer.clear();
    this.notifyClosed();
  }

  diagnostic() {
    return {
      exited: this.exited,
      childPid: this.child.pid ?? null,
      exitCode: this.exitCode ?? null,
      exitSignal: this.exitSignal ?? null,
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      stderr: this.stderrBytes ? '[redacted]' : '',
    };
  }
}

/**
 * One external grok-search-rs stdio query, for explicitly authorized smoke tests.
 * configPath is passed to the child only; this module never reads or writes it.
 * executableArgs supports a Node-based fake server. sdkFactory is a test seam.
 */
export async function runGrokSearch({
  runtimeRoot, executable, executableArgs = [], configPath, query, signal,
  envOverrides = {}, deadlineMs = DEFAULT_DEADLINE_MS, maxStdoutBytes = DEFAULT_STDOUT_BYTES,
  sdkFactory = loadSdk,
}) {
  if (typeof executable !== 'string' || !isAbsolute(executable)) throw new TypeError('executable must be an absolute executable path.');
  if (typeof configPath !== 'string' || !isAbsolute(configPath)) throw new TypeError('configPath must be an explicit absolute file path.');
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('query must be non-empty text.');
  if (!Array.isArray(executableArgs) || executableArgs.some(value => typeof value !== 'string' || value.includes('\0'))) throw new TypeError('executableArgs must contain strings.');
  if (!object(envOverrides)) throw new TypeError('envOverrides must be an object.');
  positiveInteger(deadlineMs, 'deadlineMs');
  positiveInteger(maxStdoutBytes, 'maxStdoutBytes');
  signal?.throwIfAborted();
  const env = environment({ ...envOverrides, GROK_SEARCH_CONFIG: configPath });
  const started = performance.now();
  const deadline = new AbortController();
  const timeout = failure('GROK_TIMEOUT', 'Grok search exceeded its deadline.');
  const timer = setTimeout(() => deadline.abort(timeout), deadlineMs);
  const activeSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  aborted.catch(() => {});
  const onAbort = () => rejectAborted(activeSignal.reason);
  activeSignal.addEventListener('abort', onAbort, { once: true });
  let transport;
  let client;
  let answer;
  let error;
  let serverVersion = null;
  try {
    const sdk = await Promise.race([sdkFactory(runtimeRoot), aborted]);
    activeSignal.throwIfAborted();
    client = new sdk.Client({ name: 'dsh-grok-search-smoke', version: '0.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'legacy' } });
    const buffer = new sdk.ReadBuffer({ maxBufferSize: maxStdoutBytes });
    const child = spawn(executable, executableArgs, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    transport = new OwnedStdioTransport(child, sdk, maxStdoutBytes, buffer);
    const race = operation => Promise.race([operation, aborted, transport.fatal]);
    await race(client.connect(transport, { signal: activeSignal, timeout: deadlineMs }));
    serverVersion = client.getServerVersion()?.version ?? null;
    const result = await race(client.callTool({ name: 'web_search', arguments: { query, response_format: 'concise' } }, { signal: activeSignal, timeout: deadlineMs }));
    answer = mapGrokSearchResult(result);
  } catch (caught) {
    // Preserve caller cancellation identity; never retain arbitrary remote error text/data.
    if (activeSignal.aborted) error = activeSignal.reason;
    else if (caught instanceof GrokSmokeError) error = caught;
    else {
      error = failure('GROK_MCP_ERROR', 'Grok MCP initialization or call failed; remote error text was not retained.');
      if (typeof caught?.code === 'number' || typeof caught?.code === 'string') error.rpcCode = caught.code;
    }
  } finally {
    clearTimeout(timer);
    activeSignal.removeEventListener('abort', onAbort);
    // Client.close may itself invoke transport.close; both paths share one reap promise.
    if (transport) await transport.close();
    if (client) {
      try { await client.close(); }
      catch { error ??= failure('GROK_CLOSE_ERROR', 'The MCP client did not close cleanly.'); }
    }
  }
  const diagnostic = {
    serverVersion,
    searchProvider: answer?.diagnostic.searchProvider ?? null,
    fallbackUsed: answer?.diagnostic.fallbackUsed ?? null,
    elapsedMs: Math.round(performance.now() - started),
    ...(transport?.diagnostic() ?? { exited: true, childPid: null }),
  };
  if (transport && !transport.exited) error ??= failure('GROK_CLEANUP_FAILED', 'The Grok child did not exit after termination.');
  if (error !== undefined) {
    if (error instanceof Error && Object.isExtensible(error)) Object.defineProperty(error, 'diagnostic', { value: diagnostic, configurable: true });
    throw error;
  }
  return { searchResult: answer.searchResult, diagnostic };
}
