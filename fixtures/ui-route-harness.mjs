// Offline browser fixture only. Synthetic keys, no external provider requests.
// Loads the generated production client, not a second implementation of its UI.
const clone = value => structuredClone(value);
const sourceNames = ['tavily', 'exa', 'tinyfish', 'firecrawl'];
const mapping = {
  grok_api_url: ['https://api.x.ai', 'url'], grok_api_key: ['', 'secret'],
  grok_model: ['grok-4-1-fast-reasoning', 'string'], grok_auth_mode: ['api_key', 'string'],
  grok_auth_file: ['', 'string'], web_search_enabled: [true, 'boolean'], x_search_enabled: [false, 'boolean'],
  openai_compatible_api_url: ['', 'url'], openai_compatible_api_key: ['', 'secret'], openai_compatible_model: ['', 'string'],
  tavily_api_url: ['https://api.tavily.com', 'url'], tavily_api_key: ['', 'secret'], tavily_enabled: [true, 'boolean'],
  exa_api_url: ['https://api.exa.ai', 'url'], exa_api_key: ['', 'secret'], exa_enabled: [true, 'boolean'],
  tinyfish_search_api_url: ['https://api.search.tinyfish.ai', 'url'], tinyfish_fetch_api_url: ['https://api.fetch.tinyfish.ai', 'url'],
  tinyfish_api_key: ['', 'secret'], tinyfish_enabled: [true, 'boolean'], firecrawl_api_url: ['https://api.firecrawl.dev', 'url'],
  firecrawl_api_key: ['', 'secret'], firecrawl_enabled: [true, 'boolean'], github_token: ['', 'secret'],
  source_providers: [sourceNames, 'sources'], default_extra_sources: [3, 'integer'], fallback_sources: [5, 'integer'],
  timeout_seconds: [60, 'integer'], cache_size: [256, 'integer'], response_max_chars: [45000, 'integer'],
};
const secrets = ['grok_api_key', 'openai_compatible_api_key', 'tavily_api_key', 'exa_api_key', 'tinyfish_api_key', 'firecrawl_api_key', 'github_token'];
let content = {}, environment = {}, history = {}, currentRevision = 'missing', revisionNumber = 0, exists = false;
let prefs = { value: { schemaVersion: 1, grokEnabled: true, githubEnabled: true, sourceOrder: [...sourceNames],
  sourceEnabled: Object.fromEntries(sourceNames.map(id => [id, true])) }, revision: 'missing' };
let control, program, capabilities, route = null, configError = null, delay = 0, nextSaveError = null, nextPreferenceError = null;
let diagnostics = {}, calls = [], themeListener = null, theme = 'light', fiberErrors = [];
const cancelledOperations = new Set(), activeDiagnostics = new Map();
let counters = { added: 0, removed: 0 };
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
const revision = () => (++revisionNumber).toString(16).padStart(64, '0');
function configSnapshot() {
  const fields = Object.fromEntries(Object.entries(mapping).map(([key, [fallback, type]]) => {
    const value = environment[key] ?? content[key] ?? fallback;
    const source = Object.hasOwn(environment, key) ? 'environment' : Object.hasOwn(content, key) ? 'file' : 'default';
    const readOnly = source === 'environment' || ['grok_auth_mode', 'grok_auth_file'].includes(key);
    const field = type === 'secret' ? { value: null, configured: Boolean(value),
      keyCount: String(value).split(',').filter(v => v.trim()).length } : { value: clone(value) };
    return [key, { ...field, source, readOnly }];
  }));
  return { path: '/isolated/grok-search-rs/config.toml', displayPath: '~/.config/grok-search-rs/config.toml',
    revision: currentRevision, exists, fields, error: configError, unknownFields: [] };
}
function snapshot() {
  return { control: clone(control), program: clone(program), config: configSnapshot(), capabilities: clone(capabilities),
    plugin: { budgetMs: 120000, programConfigured: false, configSource: 'default' }, route: clone(route) };
}
const settings = new Proxy({}, { get: (_, method) => async request => {
  calls.push({ method, request: clone(request) });
  if (method === 'cancelDiagnosis') {
    const active = activeDiagnostics.get(request.operationId);
    cancelledOperations.add(request.operationId);
    active?.();
    return { ok: true, value: { cancelled: Boolean(active) } };
  }
  if (method === 'diagnoseProvider') {
    const operationId = request.operationId;
    if (cancelledOperations.has(operationId)) return failure('SETTINGS_DIAGNOSIS_CANCELLED', '测试已取消。');
    if (delay) await new Promise(done => {
      activeDiagnostics.set(operationId, done);
      setTimeout(() => { activeDiagnostics.delete(operationId); done(); }, delay);
    });
    activeDiagnostics.delete(operationId);
    if (cancelledOperations.has(operationId)) return failure('SETTINGS_DIAGNOSIS_CANCELLED', '测试已取消。');
  }
  else if (delay) await new Promise(done => setTimeout(done, delay));
  if (method === 'snapshot') return { ok: true, value: snapshot() };
  if (method === 'preferences') return { ok: true, value: clone(prefs) };
  if (method === 'save') {
    if (nextSaveError) { const error = nextSaveError; nextSaveError = null; return failure(error, '保存失败，草稿应保留。'); }
    if (request.expectedRevision !== currentRevision) return failure('CONFIG_CONFLICT', '配置已在别处修改。');
    if (Object.keys(request.updates).some(key => secrets.includes(key)) && !capabilities.secretsAllowed) return failure('SETTINGS_SECURE_CONNECTION_REQUIRED', '连接不安全。');
    if (Object.keys(request.updates).some(key => Object.hasOwn(environment, key))) return failure('CONFIG_ENV_OVERRIDE', '环境变量只读。');
    if (exists) history[currentRevision] = clone(content);
    for (const [key, value] of Object.entries(request.updates)) { if (value === null) delete content[key]; else content[key] = clone(value); }
    exists = true; currentRevision = revision();
    return { ok: true, value: { config: configSnapshot() } };
  }
  if (method === 'restoreConfig') {
    if (request.expectedRevision !== currentRevision) return failure('CONFIG_CONFLICT', '配置已在别处修改。');
    if (!capabilities.secretsAllowed) return failure('SETTINGS_SECURE_CONNECTION_REQUIRED', '连接不安全。');
    if (!history[request.revision]) return failure('CONFIG_HISTORY_INVALID', '无效修订。');
    history[currentRevision] = clone(content);
    content = clone(history[request.revision]); currentRevision = revision();
    return { ok: true, value: { config: configSnapshot() } };
  }
  if (method === 'reveal') return capabilities.secretsAllowed ? { ok: true, value: {
    key: request.key, value: environment[request.key] ?? content[request.key] ?? '',
    readOnly: Object.hasOwn(environment, request.key),
  } } : failure('SETTINGS_SECURE_CONNECTION_REQUIRED', '连接不安全。');
  if (method === 'savePreferences') {
    if (nextPreferenceError && nextPreferenceError !== 'PREFERENCES_COMMIT_UNCERTAIN') {
      const error = nextPreferenceError; nextPreferenceError = null;
      return failure(error, '开关保存失败。');
    }
    if (request.expectedRevision !== prefs.revision) return failure('PREFERENCES_CONFLICT', '其他窗口已修改。');
    prefs = { value: clone(request.value), revision: revision() };
    if (nextPreferenceError) {
      nextPreferenceError = null;
      return failure('PREFERENCES_COMMIT_UNCERTAIN', '开关已保存，但回读未完成。');
    }
    return { ok: true, value: clone(prefs) };
  }
  if (method === 'openConfigLocation') return { ok: true, value: {
    path: configSnapshot().path, displayPath: configSnapshot().displayPath, exists, opened: false, kind: request.kind,
  } };
  if (method === 'prepareProgram') { program.phase = 'ready'; return { ok: true, value: clone(program) }; }
  if (method === 'diagnoseProvider') {
    const id = request.provider, key = id === 'github' ? 'github_token' : id + '_api_key';
    const count = configSnapshot().fields[key]?.keyCount || 1;
    const configured = id === 'github' || configSnapshot().fields[key]?.configured;
    const codes = diagnostics[id] || Array(count).fill('OK');
    const keys = codes.map((code, keyIndex) => ({ keyIndex, status: code === 'OK' ? 'ok' : code === 'EMPTY' ? 'empty' : 'failed',
      code, message: code === 'OK' ? '连接成功。' : code === 'EMPTY' ? '无结果。' : '测试失败。', elapsedMs: 1, ...(code === 'OK' ? { results: 1 } : {}) }));
    const ok = keys.some(item => item.status === 'ok'), bad = keys.some(item => item.status === 'failed');
    return { ok: true, value: { provider: id, status: !configured ? 'not-configured' : ok ? 'ok' : bad ? 'failed' : 'empty',
      code: !configured ? 'NOT_CONFIGURED' : ok ? 'OK' : bad ? keys.find(item => item.status === 'failed').code : 'EMPTY',
      message: '离线合成诊断', keyCount: count, keys: configured ? keys : [], partial: ok && bad } };
  }
  return failure('METHOD_NOT_FOUND', String(method));
} });

// Minimal host hook/slot shim. Real React lifecycle is checked by Desktop gates.
let client, component, hooks = [], effects = [], currentHook = 0, element = null, disposers = [];
const React = {
  useRef(initial) { return hooks[currentHook++] ||= { current: initial }; },
  useEffect(effect) { effects.push(effect); currentHook++; },
};
const jsx = (type, props) => {
  if (type === 'div' && props.ref) {
    element ||= document.getElementById('preview');
    props.ref.current = element;
    element.dataset.dsgRoute = '1';
  }
  return {};
};
function mount() {
  currentHook = 0; effects = [];
  component({ remote: { grokSearchSettings: settings }, theme: { get current() { return theme === 'dark'; }, listeners: themeListeners } });
  disposers = effects.map(effect => effect()).filter(Boolean);
  counters.added++;
}
const themeListeners = new Set();
function unmount() { disposers.forEach(dispose => dispose()); disposers = []; counters.removed++; }
window.__ModuleLoader__ = { load(definition) { client = definition.factory(name => name === 'react' ? React : { jsx }); } };
await import('/src/client.js');
const ctx = {
  locale: { register: () => () => {} }, effect: effect => effect(),
  remote: { grokSearchSettings: settings, $mount: async () => () => {} },
  theme: { getTheme: () => ({ active: { colorScheme: theme } }) },
  on: (event, fn) => { if (event === 'theme/change') themeListener = fn; },
  inject(names, callback) {
    const value = callback(ctx);
    const promise = Promise.resolve(value);
    promise.dispose = async () => { if (typeof value === 'function') await value(); };
    return promise;
  },
  slots: { inject: (_, fn) => fn(), register: (_, view) => { component = view; return () => {}; } },
};
await client.apply(ctx);
function reset(state = 'returning') {
  activeDiagnostics.forEach(done => done()); activeDiagnostics.clear(); cancelledOperations.clear();
  content = state === 'fresh' ? {} : {
    grok_api_key: 'xai-synthetic-key', tavily_api_key: 'tvly-synthetic-1,tvly-synthetic-2',
    exa_api_key: 'exa-synthetic', firecrawl_api_key: 'fc-synthetic', github_token: 'ghp_synthetic',
    source_providers: ['tavily', 'exa', 'firecrawl', 'tinyfish'], firecrawl_enabled: false,
  };
  environment = {}; history = {}; revisionNumber = 1; currentRevision = state === 'fresh' ? 'missing' : revision();
  exists = state !== 'fresh'; route = null; configError = null; diagnostics = {}; calls = []; delay = 0; nextSaveError = null; nextPreferenceError = null;
  prefs = { value: { schemaVersion: 1, grokEnabled: true, githubEnabled: true,
    sourceOrder: [...sourceNames], sourceEnabled: Object.fromEntries(sourceNames.map(id => [id, true])) }, revision: 'missing' };
  control = { available: true, phase: 'required', policy: 'required', routeVerified: true, completionCommitted: false };
  program = { phase: 'ready', program: { path: '/isolated/bin/grok-search-rs', version: '0.1.26', source: 'npm' },
    configPath: configSnapshot().path, configuration: { executable: false, configPath: false }, error: null };
  capabilities = { secretsAllowed: true, transport: 'loopback', reason: null };
  if (state === 'backup') { delete content.grok_api_key; }
  if (state === 'off') { control = { ...control, phase: 'released', policy: 'released', completionCommitted: true }; }
  if (state === 'fallback' || state === 'allfail') {
    route = { at: Date.now(), origin: 'search', outcome: state === 'allfail' ? 'failed' : 'ok',
      served: state === 'allfail' ? null : 'exa', grokCode: 'grok_auth_error', fallbackUsed: state !== 'allfail',
      failures: [{ provider: 'tavily', code: 'HTTP_401' }, ...(state === 'allfail' ? [{ provider: 'exa', code: 'HTTP_403' }] : [])] };
  }
}
reset(new URL(location.href).searchParams.get('state') || 'returning');
mount();
window.harness = {
  reset(state) { unmount(); hooks = []; reset(state); mount(); },
  remount() { unmount(); mount(); },
  unmount, mount,
  theme(value) { theme = value; document.body.dataset.theme = value; themeListener?.({ active: { colorScheme: value } }); themeListeners.forEach(fn => fn()); },
  inject(updates) { Object.assign(content, updates); currentRevision = revision(); },
  environment(updates) { environment = clone(updates); currentRevision = revision(); },
  configure(options) {
    if (options.program) Object.assign(program, options.program);
    if (options.control) Object.assign(control, options.control);
    if (options.capabilities) Object.assign(capabilities, options.capabilities);
    if (options.configError) configError = options.configError;
    if (options.diagnostics) diagnostics = clone(options.diagnostics);
    if (options.delay !== undefined) delay = options.delay;
    if (options.nextSaveError) nextSaveError = options.nextSaveError;
    if (options.nextPreferenceError) nextPreferenceError = options.nextPreferenceError;
    if (options.route) route = clone(options.route);
  },
  refresh() { document.dispatchEvent(new Event('visibilitychange')); },
  get state() { return { snapshot: snapshot(), prefs: clone(prefs), content: clone(content),
    calls: clone(calls), counters: clone(counters), fiberErrors }; },
};
