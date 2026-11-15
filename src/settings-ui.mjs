import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import { isAbsolute, join, sep } from 'node:path';
import { createSharedConfigStore, CONFIG_FIELDS } from './core/shared-config.mjs';
import { resolveSharedConfigPath } from './core/config-path.mjs';
import { GrokSearchError } from './core/errors.mjs';
import { createPrivatePreferences } from './core/private-preferences.mjs';
import { queryAccountQuota, quotaDraftConfiguration } from './core/account-quota.mjs';
import { SETTINGS_DESCRIPTORS as descriptors, REMOTE_SERVICE } from './core/settings-contract.mjs';
import { SEARCH_SNAPSHOT } from './core/search-config.mjs';
import { createConfigLocationOpener } from './core/config-opener.mjs';
import { validateSearchQuery } from './core/search-query.mjs';

export const name = 'dsh-grok-search-settings-ui';
export const inject = [
  'grokSearchControl',
  'grokSearchCore',
  'grokSearchProgram',
  'grokSearchSourceRouter',
  'profileContext',
  'grokSearchConnectionSecurity',
];

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const DIAGNOSABLE_SOURCES = Object.freeze(['tavily', 'exa', 'tinyfish', 'firecrawl', 'github']);

// Short, fixed copy for primary-engine failures. Codes come from this plugin or
// from grok-search-rs' stable fallback_reason identifiers; never free text.
const GROK_MESSAGES = Object.freeze({
  grok_auth_error: 'Grok 认证失败，请检查 API Key 或登录凭据。',
  grok_timeout: 'Grok 响应超时。',
  grok_parse_error: 'Grok 返回了无法解析的结果。',
  grok_provider_error: 'Grok 接口调用失败，请检查接口协议、Base URL 和模型。',
  grok_content_empty: 'Grok 未返回回答内容。',
  grok_sources_empty: 'Grok 未返回引用链接。',
  GROK_TIMEOUT: 'Grok 响应超时。',
  GROK_QUEUE_TIMEOUT: '等待搜索队列超时，本次测试尚未开始。',
  CONFIG_CONFLICT: '配置已更新，请按当前配置重新测试。',
  GROK_PROGRAM_MISSING: 'Grok 程序尚未就绪，请等待自动准备完成。',
  GROK_CONFIG_INVALID: 'Grok 配置文件无效。',
  GROK_TOOL_ERROR: 'Grok 搜索报告错误，请检查 API Key、Base URL 和模型。',
  GROK_MCP_ERROR: 'Grok 初始化或搜索失败。',
  GROK_CHILD_EXIT: 'Grok 程序意外退出。',
  GROK_PROCESS_ERROR: '无法启动 Grok 程序。',
  GROK_QUEUE_FULL: '搜索队列已满，请稍后再测。',
  GROK_SEARCH_STOPPING: '插件正在停止，暂不能测试。',
});
const grokMessage = code => code === 'HTTP_401' ? 'API Key 无效或鉴权失败（HTTP 401）。'
  : /^HTTP_[45]\d{2}$/.test(code) ? `Grok 接口返回 HTTP ${code.slice(5)}，请核对对应的接口、权限或服务状态。`
    : code === 'GROK_NETWORK_ERROR' ? '无法连接 Grok 接口，请检查网络、代理或证书。'
      : GROK_MESSAGES[code] ?? 'Grok 查询失败，请检查程序和配置。';
// A short form for the route view; the full path stays in `path`.
const displayPath = path => {
  const home = homedir();
  if (typeof path !== 'string' || !home) return path;
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return fold(path).startsWith(fold(home.endsWith(sep) ? home : home + sep)) ? '~' + path.slice(home.replace(/[\\/]$/, '').length) : path;
};
const envSet = name => Object.entries(process.env)
  .some(([key, value]) => (process.platform === 'win32' ? key.toUpperCase() === name : key === name) && value);
const jsonDetails = value => {
  if (value === undefined) return {};
  try {
    const copy = JSON.parse(JSON.stringify(value));
    return copy && typeof copy === 'object' && !Array.isArray(copy) ? copy : {};
  } catch { return {}; }
};

export function createSettingsGateway({ Service, RemoteError } = {}) {
  if (typeof Service !== 'function' || typeof RemoteError !== 'function') {
    throw new TypeError('Real host Service and RemoteError constructors are required.');
  }

class GrokSearchSettingsGateway extends Service {
  static provide = REMOTE_SERVICE;

  constructor(ctx) {
    super(ctx, REMOTE_SERVICE);
    this.typertRemote = Object.freeze({ service: this, serviceKey: REMOTE_SERVICE, namespace: REMOTE_SERVICE });
    this.control = ctx.get?.('grokSearchControl') ?? null;
    this.core = ctx.get?.('grokSearchCore') ?? null;
    this.searchLog = ctx.get?.('grokSearchLog') ?? this.core?.searchLog ?? null;
    this.callRoutes = ctx.get?.('grokSearchCallRoutes') ?? null;
    this.program = ctx.get?.('grokSearchProgram') ?? null;
    this.sourceRouter = ctx.get?.('grokSearchSourceRouter') ?? null;
    this.profileContext = ctx.get?.('profileContext') ?? ctx.profileContext ?? { dir: process.cwd() };
    this.security = ctx.get?.('grokSearchConnectionSecurity') ?? null;
    this.preferenceStore = createPrivatePreferences({
      path: join(this.profileContext.dir, 'grok-search', 'preferences.json'),
    });
    this.diagnostics = new Map();
    this.cancelledDiagnostics = new Map();
    this.configOpener = createConfigLocationOpener();
    // Never expose an unkeyed secret hash or reuse identities across lifetimes.
    this.quotaIdentityKey = randomBytes(32);
    const cancel = () => {
      for (const controller of this.diagnostics.values()) {
        controller.abort(new GrokSearchError('SETTINGS_DIAGNOSIS_CANCELLED', '插件已卸载，测试已取消。'));
      }
    };
    // Native stop invalidates/drains core before the settings child fiber is
    // necessarily disposed. Register at that boundary too; not just on UI exit.
    const unregister = this.core?.registerDiagnosticCancellation?.(cancel);
    ctx.effect?.(() => () => {
      unregister?.();
      cancel();
      this.configOpener.dispose();
      this.cancelledDiagnostics.clear();
    });
  }

  _owner() {
    if (!this.security) throw new GrokSearchError('SETTINGS_SECURE_CONNECTION_REQUIRED', '设置安全服务未加载，请重新加载插件。');
    this.security.requireOwner(this.ctx);
  }

  // The path never depends on parsing the file: a broken file must still open.
  _configPath() {
    return resolveSharedConfigPath({ override: this.program?.snapshot?.()?.configPath });
  }

  _store(path = this._configPath()) {
    return createSharedConfigStore({
      path,
      historyDirectory: join(this.profileContext.dir, 'grok-search', 'config-history'),
      trustedHistoryRoot: this.profileContext.dir,
      onMaintenance: result => {
        if (result.status === 'error') this.ctx.logger?.warn?.(`${result.code}: ${result.message}`);
      },
    });
  }

  _capabilities() {
    return this.security ? this.security.capabilities(this.ctx)
      : { secretsAllowed: false, transport: 'restricted', reason: '设置服务未加载。' };
  }

  _quotaRevision(captured) {
    return createHmac('sha256', this.quotaIdentityKey)
      .update(JSON.stringify([captured.snapshot.path, captured.effective])).digest('hex');
  }

  async snapshot() {
    this._owner();
    let config, captured, path = '';
    try {
      path = this._configPath();
      captured = this._store(path).readSnapshot();
      const current = captured.snapshot;
      config = { ...current, quotaRevision: this._quotaRevision(captured), displayPath: displayPath(current.path), error: null };
    } catch (error) {
      config = {
        path, displayPath: displayPath(path),
        // A file that exists but cannot be read or parsed is still reported
        // as existing, so the view asks for a fix instead of offering "create".
        exists: isAbsolute(path) && existsSync(path), revision: 'missing', fields: {}, unknownFields: [],
        error: error instanceof GrokSearchError ? { code: error.code, message: error.message }
          : { code: 'CONFIG_READ_FAILED', message: '配置读取失败。' },
      };
    }
    const control = this.control?.publicSnapshot?.() ?? {
      available: false, phase: 'unavailable', policy: null, revision: 0,
      canStop: false, completionCommitted: false, routeVerified: false,
      routeChanged: false, releaseOperationId: null,
      error: { code: 'CONTROL_SETTINGS_UNAVAILABLE', message: '搜索控制组件当前未加载。' },
    };
    const program = this.program?.snapshot?.() ?? null;
    return {
      ...control,
      control,
      program,
      config,
      capabilities: this._capabilities(),
      route: captured ? this.core?.routeSnapshot?.(captured) ?? null : null,
      plugin: {
        budgetMs: typeof this.core?.budgetMs === 'number' ? this.core.budgetMs : null,
        programConfigured: program?.configuration?.executable === true,
        configSource: program?.configuration?.configPath === true ? 'plugin'
          : envSet('GROK_SEARCH_CONFIG') ? 'environment' : 'default',
      },
    };
  }

  async save(request = {}) {
    this._owner();
    const updates = request?.updates;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new GrokSearchError('CONFIG_UPDATES_INVALID', '配置更新必须是对象。');
    }
    // A URL edit can send an existing (including environment/OAuth) credential
    // to a different service without changing the key field. Protect changing
    // or clearing destinations by the same transport proof as secret writes.
    const needsSecret = Object.keys(updates).some(key => ['secret', 'url'].includes(CONFIG_FIELDS[key]?.type));
    if (needsSecret) this.security.requireSecret(this.ctx);
    const store = this._store();
    const config = store.save({
      expectedRevision: request.expectedRevision,
      updates,
    });
    if (Object.hasOwn(updates, 'github_token')) this.ctx.get?.('grokSearchGithub')?.sync();
    return { config: { ...config, quotaRevision: this._quotaRevision(store.readSnapshot()) } };
  }

  async reveal(request = {}) {
    this._owner();
    this.security.requireSecret(this.ctx);
    const key = request?.key;
    if (CONFIG_FIELDS[key]?.type !== 'secret') {
      throw new GrokSearchError('CONFIG_FIELD_INVALID', '只能显式查看凭据字段。');
    }
    const result = this._store().reveal(key);
    return {
      key,
      value: String(result.value ?? ''),
      source: result.source,
      readOnly: result.readOnly === true,
    };
  }

  async restoreConfig(request = {}) {
    this._owner();
    // A history revision can contain every credential in the shared file.
    // Restoring it is a secret write even when the original edit was not.
    this.security.requireSecret(this.ctx);
    const store = this._store();
    const config = store.restore({
      expectedRevision: request.expectedRevision,
      revision: request.revision,
    });
    return { config: { ...config, quotaRevision: this._quotaRevision(store.readSnapshot()) } };
  }

  async prepareProgram() {
    this._owner();
    if (!this.program?.prepare) throw new GrokSearchError('GROK_PROGRAM_UNAVAILABLE', '程序管理器当前不可用。');
    return this.program.prepare();
  }

  async repairProgram() {
    this._owner();
    if (!this.program?.repair) throw new GrokSearchError('GROK_PROGRAM_UNAVAILABLE', '程序管理器当前不可用。');
    return this.program.repair();
  }

  async openConfigLocation(request = {}) {
    const value = await this._openConfigLocation(request);
    return { path: value.path, displayPath: value.displayPath, exists: value.exists, kind: value.kind, opened: value.opened };
  }

  async openConfigLocationWithStatus(request = {}) {
    return this._openConfigLocation(request);
  }

  async _openConfigLocation(request = {}) {
    this._owner();
    const kind = request?.kind ?? 'folder';
    if (kind !== 'file' && kind !== 'folder') throw new GrokSearchError('CONFIG_OPEN_INVALID', '只能打开配置文件或所在文件夹。');
    const path = this._configPath();
    const result = { path, displayPath: displayPath(path), exists: false, kind, opened: false };
    // A remote browser cannot see this host's desktop; it gets the path to copy.
    if (this._capabilities().transport !== 'loopback') {
      result.exists = existsSync(path);
      result.copyOnly = true;
      return result;
    }
    // The opener distinguishes missing targets from denied access. A boolean
    // existence precheck here would silently hide its actionable I/O errors.
    Object.assign(result, await this.configOpener.open({ path, kind, signal: this.ctx.invocation?.signal }));
    return result;
  }

  async diagnose() {
    this._owner();
    if (!this.sourceRouter?.diagnose) return [];
    return this._diagnosisWork({}, signal => this.sourceRouter.diagnose({ signal }));
  }

  async diagnoseProvider(request = {}) {
    this._owner();
    const provider = request?.provider;
    if (provider !== 'grok' && !DIAGNOSABLE_SOURCES.includes(provider)) {
      throw new GrokSearchError('SOURCE_UNKNOWN', '未知搜索来源。');
    }
    const captured = this._store().readSnapshot();
    const identity = this._quotaRevision(captured);
    const preferences = this.preferenceStore.snapshot();
    const conflict = () => new GrokSearchError('CONFIG_CONFLICT', '配置已更新，本次结果不再用于当前配置；请重新测试。');
    if (request.expectedRevision !== undefined && request.expectedRevision !== captured.snapshot.revision
      || request.configIdentity !== undefined && request.configIdentity !== identity) throw conflict();
    if (this.program?.execution && this.program.snapshot()?.phase === 'ready') captured.execution = this.program.execution();
    return this._diagnosisWork(request, async signal => {
      if (provider !== 'grok' && provider !== 'github' && !this.sourceRouter?.diagnoseProvider) throw new GrokSearchError('SOURCE_UNAVAILABLE', '补充来源诊断当前不可用。');
      const result = provider === 'github' ? preferences.value.githubReadEnabled !== true
        ? { provider, status: 'disabled', code: 'DISABLED', message: 'GitHub 读取未开启，测试时跳过。', keys: [], elapsedMs: 0 }
        : await this._githubTest({ token: captured.effective.github_token.value, signal })
        : provider === 'grok' ? await this._diagnoseGrok(signal, captured)
        : await this.sourceRouter.diagnoseProvider(provider, { signal, configuration: captured.effective,
          schedule: this.core?.scheduleDiagnosis });
      const current = this._store().readSnapshot();
      if (current.snapshot.revision !== captured.snapshot.revision || this._quotaRevision(current) !== identity
        || this.preferenceStore.snapshot().revision !== preferences.revision) throw conflict();
      return result;
    });
  }

  async _githubTest(input) {
    const github = this.ctx.get?.('grokSearchGithub');
    if (!github?.test) throw new GrokSearchError('GITHUB_UNAVAILABLE', 'GitHub 读取组件尚未加载。');
    if (github.snapshot?.().error) throw new GrokSearchError('GITHUB_TOOL_REGISTRATION_FAILED', 'GitHub 工具未注册成功，请检查是否存在同名 github_read 工具。');
    return github.test(input);
  }

  async previewGithubConnection(request = {}) {
    this._privateView();
    const captured = this._store().readSnapshot();
    const identity = this._quotaRevision(captured);
    if (request.expectedRevision !== captured.snapshot.revision || request.configIdentity !== identity) {
      throw new GrokSearchError('CONFIG_CONFLICT', '配置已变化，请重新读取后测试。');
    }
    if (request.token !== undefined && (request.token.length > 4096 || /[\r\n\u0000-\u001f]/.test(request.token))) {
      throw new GrokSearchError('GITHUB_AUTH', 'GitHub Token 格式无效。');
    }
    const token = request.token === undefined ? captured.effective.github_token.value : request.token.trim();
    return this._diagnosisWork(request, async signal => {
      const result = await this._githubTest({ token, signal });
      const current = this._store().readSnapshot();
      if (this._quotaRevision(current) !== identity || current.snapshot.revision !== captured.snapshot.revision) {
        throw new GrokSearchError('CONFIG_CONFLICT', '配置已变化，本次测试结果未用于当前配置。');
      }
      return result;
    });
  }

  async _diagnosisWork(request, work) {
    const admission = this.ctx.get?.('grokSearchCompatibility')?.assertSearchAllowed('diagnosis');
    if (typeof admission?.then === 'function') { await admission; this._owner(); }
    const operationId = request.operationId ?? randomUUID();
    this._diagnosisId(operationId);
    if (this.cancelledDiagnostics.has(operationId)) throw new GrokSearchError('SETTINGS_DIAGNOSIS_CANCELLED', '测试已取消。');
    if (this.diagnostics.has(operationId) || this.diagnostics.size >= 8) {
      throw new GrokSearchError('SETTINGS_DIAGNOSIS_BUSY', '测试请求已在执行或队列已满，请稍后再试。');
    }
    const controller = new AbortController();
    const invocationSignal = this.ctx.invocation?.signal;
    const signal = invocationSignal ? AbortSignal.any([invocationSignal, controller.signal]) : controller.signal;
    this.diagnostics.set(operationId, controller);
    let tracked = false;
    try {
      // Source diagnostics are direct HTTP requests, not core.testGrok. They
      // must still participate in the same release barrier and bounded drain.
      if (this.core?.releaseBarrier) {
        try { this.core.releaseBarrier.begin({ operationId }); tracked = true; }
        catch { throw new GrokSearchError('GROK_SEARCH_STOPPING', '插件正在停止，暂不能测试。'); }
      }
      signal.throwIfAborted();
      const result = await work(signal);
      signal.throwIfAborted();
      return result;
    } finally {
      if (tracked) this.core.releaseBarrier.settle({ operationId });
      this.diagnostics.delete(operationId);
    }
  }

  _diagnosisId(operationId) {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operationId)) {
      throw new GrokSearchError('SETTINGS_DIAGNOSIS_INVALID', '测试操作标识无效。');
    }
    const now = Date.now();
    for (const [id, expires] of this.cancelledDiagnostics) if (expires <= now) this.cancelledDiagnostics.delete(id);
  }

  async cancelDiagnosis(request = {}) {
    this._owner();
    const operationId = request.operationId;
    this._diagnosisId(operationId);
    // Cancellation can arrive before the original HTTP request is dispatched.
    // A small, bounded tombstone window closes that race, without disk writes.
    if (this.cancelledDiagnostics.size >= 32) {
      this.cancelledDiagnostics.delete(this.cancelledDiagnostics.keys().next().value);
    }
    this.cancelledDiagnostics.set(operationId, Date.now() + 120_000);
    const controller = this.diagnostics.get(operationId);
    controller?.abort(new GrokSearchError('SETTINGS_DIAGNOSIS_CANCELLED', '测试已取消。'));
    return { cancelled: Boolean(controller) };
  }

  async _diagnoseGrok(signal, captured) {
    const base = { provider: 'grok', keys: [] };
    if (this.preferenceStore.snapshot().value?.grokEnabled === false) {
      return { ...base, status: 'disabled', code: 'DISABLED', message: '已关闭，搜索直接走补充来源。', elapsedMs: 0 };
    }
    if (!this.core?.testGrok) throw new GrokSearchError('GROK_UNAVAILABLE', 'Grok 查询核心当前未加载。');
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      // The core owns queue + work + cleanup budgets. No unrelated 60s timer.
      const result = await this.core.testGrok({ query: 'DeepSeek Harness', maxResults: 3, [SEARCH_SNAPSHOT]: captured }, signal);
      const diagnostic = result?.diagnostic ?? {};
      // grok-search-rs falls back to its own sources when Grok itself fails;
      // that answer is not evidence that the Grok key or model works.
      if (diagnostic.fallbackUsed === true) {
        const code = typeof diagnostic.fallbackReason === 'string' ? diagnostic.fallbackReason : 'grok_provider_error';
        return { ...base, status: 'failed', code, message: grokMessage(code), elapsedMs: elapsed() };
      }
      const count = Array.isArray(result?.sources) ? result.sources.length : 0;
      return count > 0
        ? { ...base, status: 'ok', code: 'OK', message: `连接成功，返回 ${count} 条来源。`, results: count, elapsedMs: elapsed() }
        : { ...base, status: 'empty', code: 'EMPTY', message: '连接正常，但本次测试没有返回来源。', elapsedMs: elapsed() };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const code = typeof error?.code === 'string' ? error.code : 'GROK_SEARCH_FAILED';
      return { ...base, status: 'failed', code, message: grokMessage(code), elapsedMs: elapsed(),
        ...(Number.isInteger(error?.details?.httpStatus) ? { httpStatus: error.details.httpStatus,
          evidence: 'primary-doctor' } : {}) };
    }
  }

  async testSearch(request = {}) {
    this._owner();
    validateSearchQuery(request.query);
    const admission = this.ctx.get?.('grokSearchCompatibility')?.assertSearchAllowed('diagnosis');
    if (typeof admission?.then === 'function') { await admission; this._owner(); }
    if (!this.core?.testSearch && !this.sourceRouter?.search) {
      throw new GrokSearchError('SOURCE_UNAVAILABLE', '搜索测试当前不可用。');
    }
    const signal = this.ctx.invocation?.signal;
    // The routed search already falls back through the shared source chain and
    // honours the release barrier; retrying the sources here would spend their
    // quota twice, hide the Grok failure and bypass a stopping barrier.
    const result = this.core?.testSearch
      ? await this.core.testSearch({ query: request.query, maxResults: 5 }, signal)
      : await this.sourceRouter.search({ query: request.query, maxResults: 5, signal });
    return {
      sources: result.sources,
      fallbackUsed: result.fallback_used === true,
      provider: result.search_provider ?? null,
    };
  }

  async preferences() {
    this._owner();
    // Only DSH-only switches live here (Grok on/off for DSH, GitHub in tests).
    // Source order and on/off are the shared config's source_providers/*_enabled.
    return this.preferenceStore.snapshot();
  }

  _privateView() {
    this._owner();
    if (!this.security) throw new GrokSearchError('SETTINGS_SECURE_CONNECTION_REQUIRED', '请通过安全连接查看。');
    this.security.requireSecret(this.ctx);
  }

  async openSearchLog() {
    this._privateView();
    if (!this.searchLog) throw new GrokSearchError('SEARCH_LOG_UNAVAILABLE', '搜索记录服务未加载，请重新打开插件页。');
    return { sessionId: this.searchLog.open() };
  }

  async readSearchLog(request = {}) {
    this._privateView();
    return this.searchLog?.snapshot(request.sessionId) ?? { records: [] };
  }

  async clearSearchLog(request = {}) {
    this._privateView();
    return this.searchLog?.clear(request.sessionId) ?? { records: [] };
  }

  async closeSearchLog(request = {}) {
    this._privateView();
    return this.searchLog?.close(request.sessionId) ?? { closed: true };
  }

  async toolCallRoute(request = {}) {
    this._owner();
    // This endpoint exposes no query or response body; secure private log reads remain separate.
    return this.callRoutes?.read(request.sessionId, request.callId)
      ?? { known: false, state: 'unknown', routes: [] };
  }

  async toolCallTrace(request = {}) {
    this._owner();
    // Like the legacy provenance RPC, this is credential/body-free.
    // The visible query and result remain in their existing host chat block.
    return this.callRoutes?.readTrace(request.sessionId, request.callId)
      ?? { known: false, state: 'unknown', routes: [] };
  }

  async _accountQuota(request = {}) {
    this._privateView();
    const captured = this._store().readSnapshot();
    const revision = captured.snapshot.revision;
    const effective = captured.effective;
    const identity = this._quotaRevision(captured);
    if (typeof request.expectedRevision !== 'string' || request.expectedRevision !== revision) {
      throw new GrokSearchError('CONFIG_CONFLICT', '配置已变更，请重新读取后查询。');
    }
    if (request.quotaRevision !== identity) throw new GrokSearchError('CONFIG_CONFLICT', '有效配置已变更，请重新读取后查询。');
    const query = quotaDraftConfiguration({ provider: request.provider, keyIndex: request.keyIndex ?? 0,
      effective, draft: request.draft });
    return this._diagnosisWork(request, async signal => {
      const result = await queryAccountQuota({ provider: request.provider, ...query, signal });
      const current = this._store().readSnapshot();
      if (current.snapshot.revision !== revision || this._quotaRevision(current) !== identity) {
        throw new GrokSearchError('CONFIG_CONFLICT', '配置已变更，请重新读取后查询。');
      }
      return result;
    });
  }

  async accountQuota(request) {
    return this._accountQuota(request);
  }

  async previewAccountQuota(request) {
    return this._accountQuota(request);
  }

  async savePreferences(request = {}) {
    this._owner();
    if (request.value?.githubReadEnabled === true && this.preferenceStore.snapshot().value.githubReadEnabled !== true) this._privateView();
    const result = this.preferenceStore.save(request.expectedRevision, request.value);
    this.ctx.get?.('grokSearchGithub')?.sync();
    return result;
  }

  async stop() {
    this._owner();
    if (!this.control?.stop) throw new GrokSearchError('CONTROL_SETTINGS_UNAVAILABLE', '搜索控制组件当前未加载。');
    const outcome = await this.control.stop('settings-ui-explicit-stop');
    return { outcome, snapshot: (await this.snapshot()).control };
  }

  async retryControlRelease() {
    this._owner();
    // Older hot-loaded owners may lack the new method. Reading their snapshot
    // is safe; calling the general stop() would create an unintended stop.
    try { await this.control?.retryRelease?.(); }
    catch (error) {
      // The control owner stores the original failure code in its public
      // snapshot. Do not forward its raw exception (paths/host details), and
      // do not replace it with an unhelpful generic gateway failure.
      this._owner();
      const current = this.control?.publicSnapshot?.();
      const code = current?.error?.code;
      throw new GrokSearchError(typeof code === 'string' && /^CONTROL_[A-Z0-9_]{1,80}$/.test(code)
        ? code : 'CONTROL_RETRY_FAILED', '停用尚未完成，请按错误码检查宿主状态后重试；不会重新开启接管。');
    }
    this._owner();
    return this.snapshot();
  }
}

// Typert serializes only its public RemoteError type with a stable code;
// ordinary Error.code is otherwise reduced to gateway/internal. Keep unknown
// implementation errors (potentially containing paths or keys) off the wire.
for (const descriptor of descriptors) {
  const { method } = descriptor;
  const implementation = GrokSearchSettingsGateway.prototype[method];
  const parameters = descriptor.parameters.map(parameter => parameter.codec.create());
  const optionalRequest = method === 'openConfigLocation' || method === 'openConfigLocationWithStatus';
  const invoke = async (self, args) => {
    try {
      // rc.5 may retain an older package's Typert manifest after an in-process
      // update and discover newly added methods from their SRC signatures.
      // Keep the same validation on both dispatch paths.
      for (const [index, parameter] of parameters.entries()) {
        const parsed = parameter.safeParse(args[index] === undefined && optionalRequest ? {} : args[index]);
        if (!parsed.success) {
          self._owner();
          if (method === 'testSearch' && typeof args[index]?.query === 'string') {
            try { validateSearchQuery(args[index].query); }
            catch (error) { if (error.code === 'SEARCH_QUERY_TOO_LONG') throw error; }
          }
          if (['readSearchLog', 'clearSearchLog', 'closeSearchLog', 'accountQuota', 'previewAccountQuota'].includes(method)) self._privateView();
          throw new GrokSearchError('SETTINGS_REQUEST_INVALID', '设置请求格式无效，请刷新插件页后重试。');
        }
      }
      return await implementation.apply(self, args);
    } catch (error) {
      if (self.ctx.invocation?.signal?.aborted) throw self.ctx.invocation.signal.reason;
      if (error instanceof GrokSearchError) throw new RemoteError(error.code, error.message, jsonDetails(error.details));
      throw new RemoteError('SETTINGS_OPERATION_FAILED', '设置操作失败，请重试。', {});
    }
  };
  Object.defineProperty(GrokSearchSettingsGateway.prototype, method, {
    configurable: true, writable: true,
    // Host SRC discovery accepts plain named parameters only, never ...args or
    // defaults. Method arity and wire names must match the actual descriptor.
    value: descriptor.parameters.length === 0 ? async function () { return invoke(this, []); }
      : async function (request) { return invoke(this, [request]); },
  });
}

Object.defineProperty(GrokSearchSettingsGateway.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(descriptors.map(descriptor => Object.freeze({
      method: descriptor.method,
      invocation: Object.freeze(descriptor.invocation),
    }))),
  }),
});

  return GrokSearchSettingsGateway;
}

export { descriptors as SETTINGS_DESCRIPTORS };

export async function apply(ctx) {
  // Missing peers fail only this optional gateway; never replace the host tracker.
  const { Service } = await import('@deepseek-ai/cordis');
  const { RemoteError } = await import('@deepseek-ai/dsh-typert-protocol');
  await ctx.plugin(createSettingsGateway({ Service, RemoteError }));
}
