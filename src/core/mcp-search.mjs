import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSessionOwner } from './session-owner.mjs';
import { GrokSearchError, isRecord, timeoutError } from './errors.mjs';
import { assertSearchReferences, decodeGrokResult, mapSearchResult, searchSourceProvenance } from './result-map.mjs';
import { parse } from 'smol-toml';

const FRAME_BYTES = 1_048_576;
const SYSTEM_ENV = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
const GROK_ENV = /^(?:GROK_SEARCH_[A-Z0-9_]+|OPENAI_COMPATIBLE_(?:API_URL|API_KEY|MODEL)|GITHUB_TOKEN|(?:TAVILY|EXA|FIRECRAWL)_(?:API_KEY|API_URL|ENABLED)|TINYFISH_(?:API_KEY|SEARCH_API_URL|FETCH_API_URL|ENABLED))$/;
const PRIMARY_ONLY_ENV = Object.freeze({
  GROK_SEARCH_EXTRA_SOURCES: '0', GROK_SEARCH_FALLBACK_SOURCES: '0',
  TAVILY_ENABLED: 'false', EXA_ENABLED: 'false', TINYFISH_ENABLED: 'false', FIRECRAWL_ENABLED: 'false',
});
const failure = (code, message) => new GrokSearchError(code, message);
const safeLabel = value => typeof value === 'string' && /^[\w.+-]{1,80}$/.test(value) ? value : null;
const EMPTY_SEARCH_REASONS = Object.freeze({
  grok_auth_error: 'Grok 认证失败，请检查 API Key 或登录凭据。',
  grok_timeout: 'Grok 响应超时。',
  grok_parse_error: 'Grok 返回了无法解析的结果。',
  grok_provider_error: 'Grok 接口调用失败，请检查接口协议、Base URL 和模型。',
  grok_content_empty: 'Grok 未返回回答内容。',
  grok_sources_empty: 'Grok 未返回引用链接。',
});
function classifyEmptySearch(error) {
  // grok-search-rs 0.1.26 finalizes an empty fallback as Provider (-32001).
  // Match only its fixed web_search envelope, then discard ALL remote text/data.
  // Other RPCs, unknown reasons and arbitrary status/key text stay generic.
  const reason = error?.code === -32001 && typeof error.message === 'string'
    ? /^provider error: web_search returned no sources: (grok_[a-z_]+), and (?:the source fallback produced nothing \(|the fallback source budget is 0 \()/.exec(error.message)?.[1]
    : null;
  return reason && Object.hasOwn(EMPTY_SEARCH_REASONS, reason)
    ? failure(reason, EMPTY_SEARCH_REASONS[reason]) : error;
}

const PRIMARY_FAILURE_FIELDS = new Set(['schemaVersion', 'provider', 'protocol', 'stage', 'httpStatus', 'upstreamCode', 'reason']);
const PRIMARY_UPSTREAM_CODES = new Set([
  'invalid_api_key', 'authentication_error', 'auth_error', 'permission_denied', 'insufficient_quota',
  'rate_limit_exceeded', 'rate_limited', 'rate_limit_error', 'model_not_found',
  'tool_unsupported', 'unsupported_tool', 'unsupported_tools',
  'unsupported_parameter', 'invalid_request', 'invalid_request_error', 'context_length_exceeded',
  'server_error', 'internal_server_error', 'upstream_error', 'service_unavailable',
]);
const PRIMARY_FAILURE_REASONS = Object.freeze({
  auth_error: ['grok_auth_error', EMPTY_SEARCH_REASONS.grok_auth_error],
  rate_limited: ['grok_provider_error', 'Grok 接口请求受限，请检查限流或额度。'],
  model_not_found: ['grok_provider_error', 'Grok 模型或路由不存在，请检查模型名称和服务商路由配置。'],
  tool_unsupported: ['grok_provider_error', '当前 Grok 模型或路由不支持搜索工具。'],
  invalid_request: ['grok_provider_error', 'Grok 请求参数不受支持，请检查模型和搜索工具配置。'],
  upstream_error: ['grok_provider_error', 'Grok 上游接口调用失败，请检查服务状态与配置。'],
  network_error: ['GROK_NETWORK_ERROR', '无法连接 Grok 接口，请检查网络、代理或证书。'],
  timeout: ['grok_timeout', EMPTY_SEARCH_REASONS.grok_timeout],
  parse_error: ['grok_parse_error', EMPTY_SEARCH_REASONS.grok_parse_error],
  content_empty: ['grok_content_empty', EMPTY_SEARCH_REASONS.grok_content_empty],
  sources_empty: ['grok_sources_empty', EMPTY_SEARCH_REASONS.grok_sources_empty],
});

function primaryFailureDetails(data) {
  // Treat the extension atomically: unknown versions/fields/values retain the
  // legacy diagnosis. Copy only bounded protocol values, never remote text.
  if (!isRecord(data) || ![Object.prototype, null].includes(Object.getPrototypeOf(data))
    || Object.keys(data).some(key => !PRIMARY_FAILURE_FIELDS.has(key))
    || ['schemaVersion', 'provider', 'protocol', 'stage', 'reason'].some(key => !Object.hasOwn(data, key))
    || data.schemaVersion !== 1 || data.provider !== 'grok'
    || !['responses', 'chat_completions'].includes(data.protocol)
    || !['request', 'response', 'parse', 'result'].includes(data.stage)
    || typeof data.reason !== 'string' || !Object.hasOwn(PRIMARY_FAILURE_REASONS, data.reason)) return null;
  if (Object.hasOwn(data, 'httpStatus') && (!Number.isInteger(data.httpStatus) || data.httpStatus < 200 || data.httpStatus > 599)) return null;
  if (Object.hasOwn(data, 'upstreamCode') && !PRIMARY_UPSTREAM_CODES.has(data.upstreamCode)) return null;
  return { schemaVersion: 1, provider: 'grok', protocol: data.protocol, stage: data.stage, reason: data.reason,
    ...(Object.hasOwn(data, 'httpStatus') ? { httpStatus: data.httpStatus } : {}),
    ...(Object.hasOwn(data, 'upstreamCode') ? { upstreamCode: data.upstreamCode } : {}), evidence: 'primary-request' };
}

export function primaryFailureError(data) {
  const details = primaryFailureDetails(data);
  if (!details) return null;
  const [code, message] = PRIMARY_FAILURE_REASONS[details.reason];
  // Successful headers can still carry a failed response/SSE body. Preserve
  // their status as evidence without turning the failure into an HTTP_200 code.
  const httpFailure = details.httpStatus >= 400;
  return new GrokSearchError(httpFailure ? `HTTP_${details.httpStatus}` : code,
    httpFailure ? `${message}（HTTP ${details.httpStatus}）` : message, details);
}

function classifySearchFailure(error) {
  const legacy = classifyEmptySearch(error);
  return legacy === error ? error : primaryFailureError(error.data) ?? legacy;
}

// 继承模式只传系统、代理及已知上游变量；配置文件由子进程自行读取。
export function executionEnvironment(overrides = {}, configPath, primaryOnly = false) {
  if (!isRecord(overrides)) throw new TypeError('环境覆盖必须是对象。');
  const values = new Map();
  const identity = key => process.platform === 'win32' ? key.toUpperCase() : key;
  for (const [key, value] of Object.entries(process.env)) {
    if (SYSTEM_ENV.has(key.toUpperCase()) || GROK_ENV.test(key.toUpperCase())) values.set(identity(key), [key, value]);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!key || /[=\0]/.test(key) || (value !== null && (typeof value !== 'string' || value.includes('\0')))) throw new TypeError('环境变量名称或值无效。');
    if (value === null) values.delete(identity(key)); else values.set(identity(key), [key, value]);
  }
  if (configPath !== undefined) values.set(identity('GROK_SEARCH_CONFIG'), ['GROK_SEARCH_CONFIG', configPath]);
  // Upstream v0.1.26 speculates max(extra_sources, fallback_sources) alongside
  // Grok. A single-provider diagnostic must disable BOTH budgets and all four
  // source switches, after caller overrides, only in this child environment.
  // Never mutate process.env or the shared config; include these flags in the
  // managed identity so a normal connection cannot leak into a diagnostic.
  if (primaryOnly === true) {
    for (const [key, value] of Object.entries(PRIMARY_ONLY_ENV)) values.set(identity(key), [key, value]);
  }
  return Object.fromEntries(values.values());
}

// 只负责进程与公开 SDK framing，不实现 JSON-RPC 会话或读取 SDK 私有字段。
export class OwnedStdioTransport {
  constructor(child, sdk, { cleanupMs, maxMessageBytes = FRAME_BYTES, buffer } = {}) {
    this.child = child;
    this.cleanupMs = cleanupMs;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = buffer ?? new sdk.ReadBuffer({ maxBufferSize: maxMessageBytes + 1 });
    this.serialize = sdk.serializeMessage;
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.lineBytes = 0;
    this.lineHasText = false;
    this.exited = false;
    this.closing = false;
    this.started = false;
    this.whenExited = new Promise(resolve => { this.resolveExit = resolve; });
    this.fatal = new Promise((_, reject) => { this.rejectFatal = reject; });
    this.fatal.catch(() => {});
    this.spawned = new Promise((resolve, reject) => {
      child.once('spawn', () => {
        resolve();
        // 即使取消先于 spawn 通知，也只操作本次持有的 ChildProcess。
        if (this.closing && !this.exited) this.terminate('SIGKILL');
      });
      child.once('error', () => {
        const error = failure('GROK_PROCESS_ERROR', '无法启动或运行 Grok 程序，请检查可执行文件。');
        if (child.pid === undefined) this.markExited(null, null);
        this.fail(error);
        reject(error);
      });
    });
    this.spawned.catch(() => {});
    child.once('exit', (code, signal) => {
      this.markExited(code, signal);
      if (!this.closing) this.fail(failure('GROK_CHILD_EXIT', 'Grok 在查询完成前退出，请检查程序和配置。'));
      this.notifyClosed();
    });
    child.stdout.on('error', () => { if (!this.closing) this.fail(failure('GROK_STDOUT_ERROR', '读取 Grok 输出失败。')); });
    child.stdin.on('error', () => { if (!this.closing) this.fail(failure('GROK_STDIN_ERROR', '写入 Grok 请求失败。')); });
    // 不保存 stderr 原文，避免上游输出泄漏凭据。
    child.stderr.on('data', chunk => { this.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stderrBytes + chunk.length); });
    child.stderr.on('error', () => { if (!this.closing) this.fail(failure('GROK_STDERR_ERROR', '读取 Grok 诊断流失败。')); });
  }

  markExited(code, signal) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    this.resolveExit();
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

  receive(chunk) {
    this.stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stdoutBytes + chunk.length);
    if (this.failure || this.closing) return;
    try {
      // 每行单独检查与解码；多个合并帧不会被误算为一条超限消息。
      for (let offset = 0; offset < chunk.length;) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline + 1;
        const piece = chunk.subarray(offset, end);
        this.lineBytes += piece.length - (newline === -1 ? 0 : 1);
        if (this.lineBytes > this.maxMessageBytes) throw failure('GROK_STDOUT_LIMIT', 'Grok 单条协议消息超过 1 MiB，请缩小结果。');
        for (const byte of piece) if (![9, 10, 13, 32].includes(byte)) { this.lineHasText = true; break; }
        this.buffer.append(piece);
        if (newline !== -1) {
          const message = this.buffer.readMessage();
          if (message === null && this.lineHasText) throw failure('GROK_PROTOCOL_ERROR', 'Grok 输出了无效协议消息，请检查程序版本。');
          this.lineBytes = 0;
          this.lineHasText = false;
          if (message !== null) this.onmessage?.(message);
        }
        offset = end;
      }
    } catch (error) {
      this.fail(error instanceof GrokSearchError ? error : failure('GROK_PROTOCOL_ERROR', 'Grok 输出了无效协议消息，请检查程序版本。'));
    }
  }

  async start() {
    if (this.started) throw failure('GROK_TRANSPORT_STARTED', 'Grok 通信层被重复启动。');
    this.started = true;
    this.child.stdout.on('data', chunk => this.receive(chunk));
    await this.spawned;
    if (this.failure) throw this.failure;
  }

  async send(message) {
    if (this.closing || this.exited || this.child.stdin.destroyed) throw failure('GROK_STDIN_CLOSED', 'Grok 输入已关闭。');
    await new Promise((resolve, reject) => {
      this.child.stdin.write(this.serialize(message), error => error ? reject(failure('GROK_STDIN_ERROR', '写入 Grok 请求失败。')) : resolve());
    });
  }

  terminate(signal) {
    if (this.exited || this.child.pid === undefined) return;
    try { if (!this.child.kill(signal)) this.killFailed = true; } catch { this.killFailed = true; }
  }

  async waitForExit(milliseconds) {
    if (this.exited || milliseconds <= 0) return;
    let timer;
    try { await Promise.race([this.whenExited, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
    finally { clearTimeout(timer); }
  }

  close() { return this.closeTask ??= this.reap(); }

  async reap() {
    this.closing = true;
    const deadline = performance.now() + this.cleanupMs;
    this.child.stdin.end();
    await this.waitForExit(Math.min(100, this.cleanupMs / 8));
    this.terminate('SIGTERM');
    await this.waitForExit(Math.min(250, Math.max(0, deadline - performance.now()) / 3));
    this.terminate('SIGKILL');
    await this.waitForExit(Math.max(0, deadline - performance.now()));
    this.buffer.clear();
    this.notifyClosed();
    if (!this.exited) {
      const error = failure('GROK_PROCESS_REAP_FAILED', '查询已停止，但本次 Grok 进程尚未回收；新查询已暂停。');
      Object.defineProperty(error, 'whenExited', { value: this.whenExited });
      Object.defineProperty(error, 'diagnostic', { value: this.diagnostic() });
      throw error;
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  diagnostic() {
    return { exited: this.exited, childPid: this.child.pid ?? null, exitCode: this.exitCode ?? null,
      exitSignal: this.exitSignal ?? null, stdoutBytes: this.stdoutBytes, stderrBytes: this.stderrBytes,
      killFailed: this.killFailed ?? false };
  }
}

const defaultSdkFactory = () => import('@modelcontextprotocol/client');

async function closeConnection(connection, cleanupMs, primaryError) {
  if (connection.closing) return connection.closing;
  connection.closing = (async () => {
    const deadline = performance.now() + cleanupMs;
    let error;
    const hasTransport = Boolean(connection.transport?.close);
    try { await connection.transport?.close(); } catch (caught) { error = caught; }
    if (connection.client) {
      let timer;
      try {
        await Promise.race([connection.client.close(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure('GROK_CLOSE_ERROR', 'MCP 会话未在回收预算内关闭。')),
            Math.max(1, deadline - performance.now()));
        })]);
      } catch (caught) {
        // Transport close owns the exit proof. Before spawn, SDK cleanup only
        // supplies an error if the operation had none, including on retirement.
        if (!hasTransport && primaryError === undefined) {
          error ??= caught instanceof GrokSearchError ? caught : failure('GROK_CLOSE_ERROR', 'MCP 会话关闭失败。');
        }
      } finally { clearTimeout(timer); }
    }
    if (error) throw error;
  })();
  return connection.closing;
}

// Only hashes leave the identity calculation; keys and file contents are not
// exposed in diagnostics. The environment used to spawn is the captured one.
export function createManagedMcpSearch({ idleMs = 300_000, onError } = {}) {
  let closeCode;
  const owner = createSessionOwner({ idleMs, onError,
    open: async configuration => {
      const connection = {};
      return { connection, close: async () => {
        try { await closeConnection(connection, configuration.cleanupMs ?? 2_000); }
        catch (error) { closeCode = error?.code; throw error; }
      } };
    },
  });
  return {
    async run(options) {
      options.signal?.throwIfAborted();
      const environment = executionEnvironment(options.envOverrides, options.configPath, options.request?.testPrimary === true);
      const envValue = name => Object.entries(environment)
        .find(([key]) => process.platform === 'win32' ? key.toUpperCase() === name : key === name)?.[1];
      const configPath = envValue('GROK_SEARCH_CONFIG')
        || join(envValue('HOME') || envValue('USERPROFILE') || homedir(), '.config/grok-search-rs/config.toml');
      if (!isAbsolute(configPath)) throw failure('GROK_CONFIG_INVALID', 'Grok 配置文件必须使用绝对路径。');
      for (const key of Object.keys(environment)) if (key.toUpperCase() === 'GROK_SEARCH_CONFIG') delete environment[key];
      environment.GROK_SEARCH_CONFIG = configPath;
      const program = statSync(options.executable);
      let configHash = 'missing';
      let fileMaxChars;
      try {
        if (statSync(configPath).size > FRAME_BYTES) throw failure('GROK_CONFIG_INVALID', 'Grok 配置文件超过 1 MiB。');
        const bytes = readFileSync(configPath);
        configHash = createHash('sha256').update(bytes).digest('hex');
        const text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes)) throw failure('GROK_CONFIG_INVALID', 'Grok 配置文件必须使用 UTF-8。');
        let values;
        try { values = parse(text.replace(/^\uFEFF/, ''), { integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'throw' }); }
        catch { throw failure('GROK_CONFIG_INVALID', 'Grok 配置文件不是有效 TOML。'); }
        fileMaxChars = values.response_max_chars;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const assertConfiguration = () => {
        if (options.expectedConfigRevision === undefined) return;
        let revision = 'missing';
        try { revision = createHash('sha256').update(readFileSync(configPath)).digest('hex'); }
        catch (error) { if (error.code !== 'ENOENT') throw failure('GROK_CONFIG_INVALID', '无法读取共享配置。'); }
        if (revision !== options.expectedConfigRevision) throw failure('CONFIG_CONFLICT', '共享配置已更新，请按新配置重新搜索。');
      };
      assertConfiguration();
      const envMaxChars = envValue('GROK_SEARCH_RESPONSE_MAX_CHARS');
      const maxChars = envMaxChars === undefined || envMaxChars === '' ? fileMaxChars ?? 45_000
        : /^\d+$/.test(envMaxChars) ? Number(envMaxChars) : NaN;
      if (!Number.isSafeInteger(maxChars) || maxChars < 100) throw failure('GROK_CONFIG_INVALID', '回复字符上限至少需要 100 字符。');
      const identity = createHash('sha256').update(JSON.stringify({ executable: options.executable,
        args: options.executableArgs ?? [], program: [program.size, program.mtimeMs, program.ctimeMs],
        configPath, configHash, environment: Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
      })).digest('hex');
      return owner.run({ identity, configuration: options, signal: options.signal,
        operation: (session, signal) => runMcpSearch({ ...options, signal, maxChars: Math.min(500_000, maxChars),
          connection: session.connection, capturedEnvironment: environment, keepAlive: true, assertConfiguration }),
      });
    },
    snapshot: owner.snapshot,
    exitPending: () => closeCode === 'GROK_PROCESS_REAP_FAILED' && owner.snapshot().faulted,
    dispose: owner.dispose,
  };
}

export async function runMcpSearch({
  executable, executableArgs = [], configPath, envOverrides = {}, request, signal,
  assertConfiguration = () => {},
  remainingMs = () => 118_000, cleanupMs = 2_000, maxMessageBytes = FRAME_BYTES,
  maxChars = 45_000,
  sdkFactory = defaultSdkFactory,
  connection = {}, capturedEnvironment, keepAlive = false,
  handshakeOnly = false,
}) {
  if (typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0')) throw new TypeError('Grok 程序必须使用绝对路径。');
  if (configPath !== undefined && (typeof configPath !== 'string' || !isAbsolute(configPath) || configPath.includes('\0'))) throw new TypeError('配置文件必须使用绝对路径。');
  if (!Array.isArray(executableArgs) || executableArgs.some(value => typeof value !== 'string' || value.includes('\0'))) throw new TypeError('程序参数无效。');
  if (!isRecord(request) || typeof request.query !== 'string' || !request.query.trim()) throw new TypeError('搜索查询不能为空。');
  if (request.maxResults !== undefined && (!Number.isSafeInteger(request.maxResults) || request.maxResults < 0)) throw new TypeError('maxResults 必须是非负整数。');
  if (typeof remainingMs !== 'function' || !Number.isFinite(remainingMs())) throw new TypeError('工作截止时间无效。');
  if (!Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 2_000) throw new TypeError('回收预算必须在 1–2000 毫秒内。');
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 128 || maxMessageBytes > FRAME_BYTES) throw new TypeError('单条消息上限必须在 128 字节至 1 MiB 内。');
  if (!Number.isSafeInteger(maxChars) || maxChars < 100 || maxChars > 500_000) throw new TypeError('回复字符上限必须在 100–500000 字符内。');
  signal?.throwIfAborted();
  const started = performance.now();
  const deadline = new AbortController();
  const initialRemaining = remainingMs();
  if (initialRemaining <= 0) throw timeoutError();
  const timer = setTimeout(() => deadline.abort(timeoutError()), Math.max(1, Math.ceil(initialRemaining)));
  const activeSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const onAbort = () => rejectAbort(activeSignal.reason);
  activeSignal.addEventListener('abort', onAbort, { once: true });
  const budget = () => {
    activeSignal.throwIfAborted();
    const remaining = Math.ceil(remainingMs());
    if (remaining <= 0) throw timeoutError();
    return remaining;
  };
  let client = connection.client, transport = connection.transport, result, error, payload;
  let sdkEntry = connection.sdkEntry ?? null, serverVersion = connection.serverVersion ?? null;
  let sourceRecovery = 'not-needed';
  try {
    if (!client) {
    const sdk = await Promise.race([Promise.resolve().then(sdkFactory), aborted]);
    if (sdkFactory === defaultSdkFactory) sdkEntry = import.meta.resolve('@modelcontextprotocol/client');
    budget();
    if (typeof sdk.Client !== 'function' || typeof sdk.ReadBuffer !== 'function' || typeof sdk.serializeMessage !== 'function') throw failure('GROK_SDK_UNSUPPORTED', 'MCP SDK 缺少所需公开接口，请检查依赖版本。');
    client = new sdk.Client({ name: 'dsh-grok-search', version: '0.4.3' }, { capabilities: {}, versionNegotiation: { mode: 'legacy' } });
    connection.client = client;
    // 所有可能拒绝的 framing 参数先校验，再启动本次进程。
    const buffer = new sdk.ReadBuffer({ maxBufferSize: maxMessageBytes + 1 });
    const child = spawn(executable, executableArgs, { env: capturedEnvironment ?? executionEnvironment(envOverrides, configPath, request.testPrimary === true), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    transport = new OwnedStdioTransport(child, sdk, { cleanupMs, maxMessageBytes, buffer });
    connection.transport = transport;
    await Promise.race([client.connect(transport, { signal: activeSignal, timeout: budget(), resetTimeoutOnProgress: false }), aborted, transport.fatal]);
    serverVersion = safeLabel(client.getServerVersion()?.version);
    Object.assign(connection, { sdkEntry, serverVersion });
    }
    const interrupts = transport?.fatal ? [aborted, transport.fatal] : [aborted];
    const race = operation => Promise.race([operation, ...interrupts]);
    const options = () => ({ signal: activeSignal, timeout: budget(), resetTimeoutOnProgress: false });
    budget();
    if (transport?.failure) throw transport.failure;
    if (handshakeOnly) {
      if (!Object.hasOwn(client.getServerCapabilities() ?? {}, 'tools')) throw failure('GROK_SDK_UNSUPPORTED', 'Grok 未声明 MCP 工具能力。');
      result = { serverVersion, toolsDeclared: true };
    } else {
    try {
      // An external editor may save while a new MCP process is starting.
      // Check before sending a billable request; never write a second config.
      assertConfiguration();
      payload = decodeGrokResult(await race(client.callTool({ name: 'web_search', arguments: { query: request.query, response_format: 'concise' } }, options())));
    } catch (caught) {
      activeSignal.throwIfAborted();
      if (transport?.failure) throw transport.failure;
      // Report this request only; a doctor probe can spend another request
      // and return an unrelated status that hides the original failure.
      throw classifySearchFailure(caught);
    }
    budget();
    const total = payload.sources_count ?? payload.total_sources ?? payload.sources.length;
    const missing = total - payload.sources.length;
    if (missing > 0) payload = { ...payload, truncated: true };
    result = mapSearchResult(payload, { maxResults: request.maxResults, maxChars });
    // Cached offsets count raw rows; the requested cap counts usable retained links.
    const recoveryCapacity = () => request.maxResults === undefined ? total - payload.sources.length
      : Math.min(total - payload.sources.length, request.maxResults - result.sources.length);
    let capacity = recoveryCapacity();
    if (missing > 0 && capacity > 0 && typeof payload.session_id === 'string' && payload.session_id && remainingMs() > 0) {
      sourceRecovery = 'attempted';
      try {
        let offset = payload.sources.length;
        while (capacity > 0) {
          const extra = decodeGrokResult(await race(client.callTool({ name: 'get_sources', arguments: { session_id: payload.session_id, offset, limit: capacity } }, options())));
          budget();
          const next = offset + extra.sources.length;
          if (extra.session_id !== undefined && extra.session_id !== payload.session_id
            || extra.offset !== undefined && extra.offset !== offset
            || extra.total_sources !== undefined && extra.total_sources !== total
            || extra.sources.length > capacity || next > total
            || extra.next_offset != null && extra.next_offset !== next) {
            throw failure('GROK_INVALID_RESULT', 'Grok 来源分页元数据不一致，请检查程序版本。');
          }
          payload = { ...payload, sources: [...payload.sources, ...extra.sources], truncated: true };
          result = mapSearchResult(payload, { maxResults: request.maxResults, maxChars });
          capacity = recoveryCapacity();
          if (!extra.sources.length) { sourceRecovery = 'partial'; break; }
          offset = next;
          sourceRecovery = capacity === 0 ? 'completed' : 'partial';
          // Older backends may omit cursors. Only an explicit next page can
          // authorize another cached read; never repeat an empty page.
          if (extra.next_offset == null) break;
        }
      } catch (caught) {
        activeSignal.throwIfAborted();
        if (transport?.failure) throw transport.failure;
        if (caught instanceof GrokSearchError && caught.code !== 'GROK_TOOL_ERROR') throw caught;
        // 只允许普通远端补取失败保留部分结果；协议与取消不能转成成功。
        if (!(caught instanceof GrokSearchError && caught.code === 'GROK_TOOL_ERROR') && (!Number.isInteger(caught?.code) || !([-32601, -32603].includes(caught.code) || (caught.code <= -32000 && caught.code >= -32099)))) throw caught;
        payload = { ...payload, truncated: true };
        sourceRecovery = 'partial';
      }
    }
    budget();
    result = mapSearchResult(payload, { maxResults: request.maxResults, maxChars });
    assertSearchReferences(payload, result, request.maxResults);
    budget();
    }
  } catch (caught) {
    error = activeSignal.aborted ? activeSignal.reason : caught instanceof GrokSearchError ? caught : failure('GROK_MCP_ERROR', 'Grok 初始化或搜索失败，请检查上游和配置。');
  } finally {
    clearTimeout(timer);
    activeSignal.removeEventListener('abort', onAbort);
    if (activeSignal.aborted && error === undefined) error = activeSignal.reason;
    if (!keepAlive || error !== undefined) {
      try { await closeConnection(connection, cleanupMs, error); }
      catch (caught) { if (error === undefined || caught?.code === 'GROK_PROCESS_REAP_FAILED') error = caught; }
    }
    // Cancellation can arrive while cleanup is awaited; an unproven exit still owns the slot.
    if (activeSignal.aborted && error?.code !== 'GROK_PROCESS_REAP_FAILED') error = activeSignal.reason;
  }
  // Accept protocol identifiers, not arbitrary token-shaped upstream text.
  const primaryFailure = payload?.fallback_used === true ? primaryFailureDetails(payload.primary_failure) : null;
  const diagnostic = { serverVersion, sdkEntry,
    searchProvider: ['grok_responses', 'openai_compatible', 'source_fallback'].includes(payload?.search_provider) ? payload.search_provider : null,
    fallbackUsed: payload?.fallback_used ?? null,
    fallbackReason: typeof payload?.fallback_reason === 'string' && Object.hasOwn(EMPTY_SEARCH_REASONS, payload.fallback_reason) ? payload.fallback_reason : null,
    ...(primaryFailure ? { primaryFailure } : {}),
    sourceProvenance: searchSourceProvenance(result?.sources),
    sourceRecovery, elapsedMs: Math.round(performance.now() - started), ...(transport?.diagnostic?.() ?? { exited: true, childPid: null }) };
  if (error !== undefined) {
    if (error instanceof Error && Object.isExtensible(error) && !Object.hasOwn(error, 'diagnostic')) Object.defineProperty(error, 'diagnostic', { value: diagnostic });
    throw error;
  }
  Object.defineProperty(result, 'diagnostic', { value: diagnostic });
  return result;
}

export async function probeMcpHandshake({ executable, configPath, envOverrides, signal }) {
  const result = await runMcpSearch({ executable, configPath, envOverrides, signal,
    request: { query: 'handshake-only-not-sent' }, handshakeOnly: true, remainingMs: () => 5_000 });
  return { version: result.serverVersion, toolsDeclared: result.toolsDeclared, exited: result.diagnostic.exited };
}
