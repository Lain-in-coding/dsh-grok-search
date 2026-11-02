import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { createSharedConfigStore, CONFIG_FIELDS } from './core/shared-config.mjs';
import { resolveSharedConfigPath } from './core/config-path.mjs';
import { GrokSearchError } from './core/errors.mjs';
import { createPrivatePreferences } from './core/private-preferences.mjs';
import { createSettingsCodec as codec } from './core/settings-codec.mjs';

// The peer is supplied by DSH at runtime. Keeping a tiny test fallback lets
// schema-only checks run in this package's dependency-free checkout while the
// real host always uses Cordis' Service tracker (which carries invocation
// context into direct RPC calls).
let Service, RemoteError;
try {
  ({ Service } = await import('@deepseek-ai/cordis'));
  ({ RemoteError } = await import('@deepseek-ai/dsh-typert-protocol'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  // Only the dependency-free unit-test checkout uses these stand-ins.
  // A partially installed host must not silently lose its Service tracker.
  if (Service) throw error;
  Service = class ServiceFallback {
    constructor(ctx, name) {
      this.ctx = ctx;
      this.name = name;
      ctx.provide?.(name, this);
    }
  };
  RemoteError = class extends GrokSearchError {};
}

export const name = 'dsh-grok-search-settings-ui';
export const inject = [
  'grokSearchControl',
  'grokSearchCore',
  'grokSearchProgram',
  'grokSearchSourceRouter',
  'profileContext',
  'grokSearchConnectionSecurity',
];

const REMOTE_SERVICE = 'grokSearchSettings';
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const DIAGNOSABLE_SOURCES = Object.freeze(['tavily', 'exa', 'tinyfish', 'firecrawl', 'github']);
const GROK_DIAGNOSE_TIMEOUT_MS = 60_000;

// Short, fixed copy for primary-engine failures. Codes come from this plugin or
// from grok-search-rs' stable fallback_reason identifiers; never free text.
const GROK_MESSAGES = Object.freeze({
  grok_auth_error: 'Grok 认证失败，请检查 API Key 或登录凭据。',
  grok_timeout: 'Grok 响应超时。',
  grok_parse_error: 'Grok 返回了无法解析的结果。',
  grok_provider_error: 'Grok 接口调用失败，请检查 API Key、BaseUrl 和模型。',
  grok_content_empty: 'Grok 没有返回可核验的回答。',
  grok_sources_empty: 'Grok 没有返回可核验的来源。',
  GROK_TIMEOUT: 'Grok 响应超时。',
  GROK_PROGRAM_MISSING: 'Grok 程序尚未就绪，请等待自动准备完成。',
  GROK_CONFIG_INVALID: 'Grok 配置文件无效。',
  GROK_TOOL_ERROR: 'Grok 搜索报告错误，请检查 API Key、BaseUrl 和模型。',
  GROK_MCP_ERROR: 'Grok 初始化或搜索失败。',
  GROK_CHILD_EXIT: 'Grok 程序意外退出。',
  GROK_PROCESS_ERROR: '无法启动 Grok 程序。',
  GROK_QUEUE_FULL: '搜索队列已满，请稍后再测。',
  GROK_SEARCH_STOPPING: '插件正在停止，暂不能测试。',
});
const grokMessage = code => GROK_MESSAGES[code] ?? 'Grok 查询失败，请检查程序和配置。';
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

const errorSchema = {
  type: 'object',
  properties: { code: { type: ['string', 'null'] }, message: { type: 'string' } },
  required: ['code', 'message'],
  additionalProperties: false,
};
const nullableError = { anyOf: [errorSchema, { type: 'null' }] };
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const capabilitiesSchema = {
  type: 'object',
  properties: {
    secretsAllowed: { type: 'boolean' },
    transport: { type: 'string' },
    reason: nullableString,
  },
  required: ['secretsAllowed', 'transport', 'reason'],
  additionalProperties: false,
};
const configSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    displayPath: { type: 'string' },
    exists: { type: 'boolean' },
    revision: { type: 'string' },
    fields: { type: 'object', additionalProperties: true },
    unknownFields: { type: 'array', items: { type: 'string' } },
    error: nullableError,
  },
  required: ['path', 'exists', 'revision', 'fields', 'unknownFields'],
  additionalProperties: false,
};
const programSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: {
        phase: { type: 'string' },
        program: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
        configPath: nullableString,
        error: nullableError,
        configuration: { type: 'object', additionalProperties: true },
      },
      required: ['phase', 'program', 'configPath', 'error'],
      additionalProperties: false,
    },
  ],
};
const controlSchema = {
  type: 'object',
  properties: {
    available: { type: 'boolean' },
    phase: { type: 'string' },
    policy: nullableString,
    revision: { type: 'number' },
    canStop: { type: 'boolean' },
    completionCommitted: { type: 'boolean' },
    routeVerified: { type: 'boolean' },
    routeChanged: { type: 'boolean' },
    releaseOperationId: nullableString,
    error: nullableError,
  },
  required: [
    'available', 'phase', 'policy', 'revision', 'canStop', 'completionCommitted',
    'routeVerified', 'routeChanged', 'releaseOperationId', 'error',
  ],
  additionalProperties: false,
};
// Final route of the latest real search: stable codes and provider ids only.
const routeSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      properties: {
        at: { type: 'number' },
        origin: { type: 'string' },
        outcome: { type: 'string' },
        served: nullableString,
        grokCode: nullableString,
        fallbackUsed: { type: 'boolean' },
        code: { type: 'string' },
        failures: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['at', 'origin', 'outcome', 'served', 'grokCode', 'fallbackUsed', 'failures'],
      additionalProperties: false,
    },
  ],
};
const pluginSchema = {
  type: 'object',
  properties: {
    budgetMs: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    programConfigured: { type: 'boolean' },
    configSource: { type: 'string' },
  },
  required: ['budgetMs', 'programConfigured', 'configSource'],
  additionalProperties: false,
};
const snapshotJsonSchema = {
  type: 'object',
  properties: {
    control: controlSchema,
    program: programSchema,
    config: configSchema,
    capabilities: capabilitiesSchema,
    route: routeSchema,
    plugin: pluginSchema,
    available: { type: 'boolean' },
    phase: { type: 'string' },
    policy: nullableString,
    revision: { type: 'number' },
    canStop: { type: 'boolean' },
    completionCommitted: { type: 'boolean' },
    routeVerified: { type: 'boolean' },
    routeChanged: { type: 'boolean' },
    releaseOperationId: nullableString,
    error: nullableError,
  },
  required: ['control', 'program', 'config', 'capabilities', 'available', 'phase', 'policy', 'revision',
    'canStop', 'completionCommitted', 'routeVerified', 'routeChanged', 'releaseOperationId', 'error'],
  additionalProperties: false,
};
const saveJsonSchema = {
  type: 'object',
  properties: { config: configSchema },
  required: ['config'],
  additionalProperties: false,
};
const revealJsonSchema = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    value: { type: 'string' },
    source: { type: 'string' },
    readOnly: { type: 'boolean' },
  },
  required: ['key', 'value', 'source', 'readOnly'],
  additionalProperties: false,
};
const prepareJsonSchema = {
  type: 'object',
  properties: {
    phase: { type: 'string' },
    program: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    configPath: nullableString,
    error: nullableError,
    configuration: { type: 'object', additionalProperties: true },
  },
  required: ['phase', 'program', 'configPath', 'error'],
  additionalProperties: false,
};
const openJsonSchema = {
  type: 'object',
  properties: { path: { type: 'string' }, displayPath: { type: 'string' }, opened: { type: 'boolean' },
    exists: { type: 'boolean' }, kind: { type: 'string' } },
  required: ['path', 'opened'],
  additionalProperties: false,
};
const diagnosticsSchema = {
  type: 'array',
  items: { type: 'object', additionalProperties: true },
};
const providerDiagnosisSchema = {
  type: 'object',
  properties: {
    provider: { type: 'string' },
    status: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    elapsedMs: { type: 'number' },
    keys: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['provider', 'status', 'code', 'message'],
  additionalProperties: true,
};
const testSearchSchema = {
  type: 'object',
  properties: {
    sources: { type: 'array', items: { type: 'object', additionalProperties: true } },
    fallbackUsed: { type: 'boolean' },
    provider: nullableString,
  },
  required: ['sources', 'fallbackUsed', 'provider'],
  additionalProperties: false,
};
const preferencesSchema = {
  type: 'object',
  properties: {
    value: { type: 'object', additionalProperties: true },
    revision: { type: 'string' },
  },
  required: ['value', 'revision'],
  additionalProperties: false,
};
const stopJsonSchema = {
  type: 'object',
  properties: {
    outcome: { type: 'object', additionalProperties: true },
    snapshot: controlSchema,
  },
  required: ['outcome', 'snapshot'],
  additionalProperties: false,
};

const descriptors = [
  {
    id: 'dsh-grok-search#grokSearchSettings/snapshot',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'snapshot',
    description: 'Read redacted Grok shared configuration and current takeover state.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#Snapshot', snapshotJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/save',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'save',
    description: 'Save validated changes to the shared Grok configuration with CAS.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#SaveRequest', {
        type: 'object',
        properties: { expectedRevision: { type: 'string' }, updates: { type: 'object', additionalProperties: true } },
        required: ['expectedRevision', 'updates'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#SaveResult', saveJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/restoreConfig',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'restoreConfig',
    description: 'Restore one verified configuration history revision with CAS over a secure connection.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#RestoreRequest', {
        type: 'object',
        properties: { expectedRevision: { type: 'string' }, revision: { type: 'string' } },
        required: ['expectedRevision', 'revision'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#RestoreResult', saveJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/reveal',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'reveal',
    description: 'Explicitly reveal one credential over an authenticated secure connection.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#RevealRequest', {
        type: 'object', properties: { key: { type: 'string' } },
        required: ['key'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#RevealResult', revealJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/prepareProgram',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'prepareProgram',
    description: 'Discover or prepare the verified private Grok program.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#PrepareResult', prepareJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/openConfigLocation',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'openConfigLocation',
    description: 'Open the shared Grok configuration file or its folder on the local host.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#OpenConfigRequest', {
        type: 'object', properties: { kind: { type: 'string' } },
        required: [], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#OpenConfigResult', openJsonSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/diagnose',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'diagnose',
    description: 'Check every enabled source and every configured key without exposing secrets.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#DiagnosticsResult', diagnosticsSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/diagnoseProvider',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'diagnoseProvider',
    description: 'Check one search engine or source (every configured key) with a real request.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#DiagnoseProviderRequest', {
        type: 'object', properties: { provider: { type: 'string' }, operationId: { type: 'string' } },
        required: ['provider'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#ProviderDiagnosis', providerDiagnosisSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/cancelDiagnosis',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'cancelDiagnosis',
    description: 'Cancel only a settings diagnosis owned by this plugin; accepted requests may still be billed upstream.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#CancelDiagnosisRequest', {
        type: 'object', properties: { operationId: { type: 'string' } },
        required: ['operationId'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#CancelDiagnosisResult', {
      type: 'object', properties: { cancelled: { type: 'boolean' } },
      required: ['cancelled'], additionalProperties: false,
    }),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/testSearch',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'testSearch',
    description: 'Run a real test search and report fallback metadata.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#TestSearchRequest', {
        type: 'object', properties: { query: { type: 'string' } },
        required: ['query'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#TestSearchResult', testSearchSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/preferences',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'preferences',
    description: 'Read plugin-private route preferences.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#PreferencesResult', preferencesSchema),
  },
  {
    id: 'dsh-grok-search#grokSearchSettings/savePreferences',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'savePreferences',
    description: 'Save plugin-private route preferences with CAS.',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request', wire: 'request', source: 'json',
      codec: codec('dsh-grok-search/settings#SavePreferencesRequest', {
        type: 'object',
        properties: { expectedRevision: { type: 'string' }, value: { type: 'object', additionalProperties: true } },
        required: ['expectedRevision', 'value'], additionalProperties: false,
      }),
    }],
    result: codec('dsh-grok-search/settings#SavePreferencesResult', preferencesSchema),
  },
  // Kept as a compatibility endpoint for older clients. The new UI never
  // renders a separate "stop takeover" action; the native plugin switch is
  // the only user-facing stop control.
  {
    id: 'dsh-grok-search#grokSearchSettings/stop',
    service: REMOTE_SERVICE, namespace: REMOTE_SERVICE, method: 'stop',
    description: 'Compatibility endpoint for older clients; native switch is preferred.',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('dsh-grok-search/settings#StopResult', stopJsonSchema),
  },
];

class GrokSearchSettingsGateway extends Service {
  static provide = REMOTE_SERVICE;

  constructor(ctx) {
    super(ctx, REMOTE_SERVICE);
    this.typertRemote = Object.freeze({ service: this, serviceKey: REMOTE_SERVICE, namespace: REMOTE_SERVICE });
    this.control = ctx.get?.('grokSearchControl') ?? null;
    this.core = ctx.get?.('grokSearchCore') ?? null;
    this.program = ctx.get?.('grokSearchProgram') ?? null;
    this.sourceRouter = ctx.get?.('grokSearchSourceRouter') ?? null;
    this.profileContext = ctx.get?.('profileContext') ?? ctx.profileContext ?? { dir: process.cwd() };
    this.security = ctx.get?.('grokSearchConnectionSecurity') ?? null;
    this.preferenceStore = createPrivatePreferences({
      path: join(this.profileContext.dir, 'grok-search', 'preferences.json'),
    });
    this.diagnostics = new Map();
    this.cancelledDiagnostics = new Map();
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
      this.cancelledDiagnostics.clear();
    });
  }

  _owner() {
    if (this.security) this.security.requireOwner(this.ctx);
  }

  // The path never depends on parsing the file: a broken file must still open.
  _configPath() {
    return this.program?.snapshot?.()?.configPath || resolveSharedConfigPath({});
  }

  _store() {
    return createSharedConfigStore({
      path: this._configPath(),
      historyDirectory: join(this.profileContext.dir, 'grok-search', 'config-history'),
    });
  }

  _capabilities() {
    return this.security ? this.security.capabilities(this.ctx)
      : { secretsAllowed: false, transport: 'restricted', reason: '设置服务未加载。' };
  }

  async snapshot() {
    this._owner();
    let config;
    try {
      const current = this._store().snapshot();
      config = { ...current, displayPath: displayPath(current.path), error: null };
    } catch (error) {
      const path = this.program?.snapshot?.()?.configPath || resolveSharedConfigPath({});
      config = {
        path, displayPath: displayPath(path),
        // A file that exists but cannot be read or parsed is still reported
        // as existing, so the view asks for a fix instead of offering "create".
        exists: isAbsolute(path) && existsSync(path), revision: 'missing', fields: {}, unknownFields: [],
        error: { code: error?.code ?? null, message: error?.message ?? '配置读取失败。' },
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
      route: this.core?.routeSnapshot?.() ?? null,
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
    const needsSecret = Object.keys(updates).some(key => CONFIG_FIELDS[key]?.type === 'secret');
    if (needsSecret) this.security.requireSecret(this.ctx);
    const config = this._store().save({
      expectedRevision: request.expectedRevision,
      updates,
    });
    return { config };
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
    const config = this._store().restore({
      expectedRevision: request.expectedRevision,
      revision: request.revision,
    });
    return { config };
  }

  async prepareProgram() {
    this._owner();
    if (!this.program?.prepare) throw new GrokSearchError('GROK_PROGRAM_UNAVAILABLE', '程序管理器当前不可用。');
    return this.program.prepare();
  }

  async openConfigLocation(request = {}) {
    this._owner();
    const kind = request?.kind ?? 'folder';
    if (kind !== 'file' && kind !== 'folder') throw new GrokSearchError('CONFIG_OPEN_INVALID', '只能打开配置文件或所在文件夹。');
    const path = this._configPath();
    const exists = existsSync(path);
    const result = { path, displayPath: displayPath(path), exists, kind, opened: false };
    // A remote browser cannot see this host's desktop; it gets the path to copy.
    if (this._capabilities().transport === 'restricted') return result;
    const folder = dirname(path);
    if (kind === 'file' ? !exists : !existsSync(folder)) return result;
    const [command, args] = process.platform === 'win32'
      ? ['explorer.exe', kind === 'file' ? [path] : exists ? ['/select,' + path] : [folder]]
      : process.platform === 'darwin'
        ? ['open', kind === 'file' ? ['-t', path] : exists ? ['-R', path] : [folder]]
        : ['xdg-open', [kind === 'file' ? path : folder]];
    // A missing opener reports through the `error` event; never let it crash the host.
    result.opened = await new Promise(resolve => {
      let child;
      try { child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false }); }
      catch { resolve(false); return; }
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    });
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
    return this._diagnosisWork(request, signal => {
      if (provider === 'grok') return this._diagnoseGrok(signal);
      if (!this.sourceRouter?.diagnoseProvider) throw new GrokSearchError('SOURCE_UNAVAILABLE', '补充来源诊断当前不可用。');
      return this.sourceRouter.diagnoseProvider(provider, { signal });
    });
  }

  async _diagnosisWork(request, work) {
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

  async _diagnoseGrok(signal) {
    const base = { provider: 'grok', keys: [] };
    if (this.preferenceStore.snapshot().value?.grokEnabled === false) {
      return { ...base, status: 'disabled', code: 'DISABLED', message: '已关闭，搜索直接走补充来源。', elapsedMs: 0 };
    }
    if (!this.core?.testGrok) throw new GrokSearchError('GROK_UNAVAILABLE', 'Grok 查询核心当前未加载。');
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const timeout = AbortSignal.timeout(GROK_DIAGNOSE_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const result = await this.core.testGrok({ query: 'DeepSeek Harness', maxResults: 3 }, combined);
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
      const code = timeout.aborted ? 'GROK_TIMEOUT' : typeof error?.code === 'string' ? error.code : 'GROK_SEARCH_FAILED';
      return { ...base, status: 'failed', code, message: grokMessage(code), elapsedMs: elapsed() };
    }
  }

  async testSearch(request = {}) {
    this._owner();
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

  async savePreferences(request = {}) {
    this._owner();
    return this.preferenceStore.save(request.expectedRevision, request.value);
  }

  async stop() {
    this._owner();
    if (!this.control?.stop) throw new GrokSearchError('CONTROL_SETTINGS_UNAVAILABLE', '搜索控制组件当前未加载。');
    const outcome = await this.control.stop('settings-ui-explicit-stop');
    return { outcome, snapshot: (await this.snapshot()).control };
  }
}

// Typert serializes only its public RemoteError type with a stable code;
// ordinary Error.code is otherwise reduced to gateway/internal. Keep unknown
// implementation errors (potentially containing paths or keys) off the wire.
for (const { method } of descriptors) {
  const implementation = GrokSearchSettingsGateway.prototype[method];
  Object.defineProperty(GrokSearchSettingsGateway.prototype, method, {
    configurable: true, writable: true,
    value: async function (...args) {
      try { return await implementation.apply(this, args); }
      catch (error) {
        if (this.ctx.invocation?.signal?.aborted) throw this.ctx.invocation.signal.reason;
        if (error instanceof GrokSearchError) throw new RemoteError(error.code, error.message, jsonDetails(error.details));
        throw new RemoteError('SETTINGS_OPERATION_FAILED', '设置操作失败，请重试。', {});
      }
    },
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

export { descriptors as SETTINGS_DESCRIPTORS };

export function apply(ctx) {
  ctx.plugin(GrokSearchSettingsGateway);
}
