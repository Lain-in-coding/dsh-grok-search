/**
 * v74 presentation, connected to the authenticated host settings gateway.
 * Self-contained so build-client can embed this factory without runtime imports.
 * root/layer belong to this mount, never the host document's selector namespace.
 */
export function createRouteController({ root, layer, remote, logos, sourceChain, memory = {} }) {
let disposed = false;
const timers = new Set(), frames = new Set(), waits = new Set(), listeners = new Set();
const setTimeout = (fn, ms) => {
  if (disposed) return 0;
  const id = window.setTimeout(() => { timers.delete(id); if (!disposed) fn(); }, ms);
  timers.add(id);
  return id;
};
const clearTimeout = id => { window.clearTimeout(id); timers.delete(id); };
const requestAnimationFrame = fn => {
  if (disposed) return 0;
  const id = window.requestAnimationFrame(time => { frames.delete(id); if (!disposed) fn(time); });
  frames.add(id);
  return id;
};
const cancelAnimationFrame = id => { window.cancelAnimationFrame(id); frames.delete(id); };
const listen = (target, type, fn, options) => {
  target.addEventListener(type, fn, options);
  const off = () => { target.removeEventListener(type, fn, options); listeners.delete(off); };
  listeners.add(off);
  return off;
};
const $ = (s, r) => r ? r.querySelector(s) : root.querySelector(s) || layer.querySelector(s);
const $$ = (s, r) => r ? Array.from(r.querySelectorAll(s)) : [...root.querySelectorAll(s), ...layer.querySelectorAll(s)];
const active = () => layer.getRootNode().activeElement || root.getRootNode().activeElement || document.activeElement;
const targetOf = event => event.composedPath()[0] || event.target;
const sleep = ms => new Promise(resolve => {
  const done = () => { waits.delete(done); resolve(); };
  waits.add(done);
  setTimeout(done, ms);
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => RM.matches;
let darkTheme = false;
const HIDDEN = '\u2063dsg-configured-secret:';
const hidden = value => typeof value === 'string' && value.startsWith(HIDDEN);
const configFields = () => S.config?.fields || {};
const sourceField = key => configFields()[key] || {};
const chain = () => sourceChain.view(configFields());
const uuid = () => {
  if (window.crypto.randomUUID) return window.crypto.randomUUID();
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

function parentPath(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(0, i === 0 || (i === 2 && path[1] === ':') ? i + 1 : i);
}
function configLocation() {
  const full = S.config?.path || '';
  return { label: S.config?.displayPath || full || '正在读取…', full, dir: parentPath(full),
    name: full.slice(Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\')) + 1) || 'config.toml' };
}

/* ---------- 图标（界面功能图标，非品牌） ---------- */
const I = {
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  eyeOff: '<path d="M2 2l12 12M6.6 3.7A6.7 6.7 0 0 1 8 3.5C12 3.5 14.5 8 14.5 8a12 12 0 0 1-1.9 2.5M10 11.9a6 6 0 0 1-2 .6C4 12.5 1.5 8 1.5 8a12 12 0 0 1 2.4-3"/><path d="M6.6 6.6a2 2 0 0 0 2.8 2.8"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7"/>',
  trash: '<path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.6 8.3a1.3 1.3 0 0 0 1.3 1.2h4.2a1.3 1.3 0 0 0 1.3-1.2l.6-8.3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  ext: '<path d="M6 3.5H3.5v9h9V10M9 2.5h4.5V7M13.5 2.5L7.5 8.5"/>',
  file: '<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/>',
  folder: '<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.2l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.4c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>',
  info: '<circle cx="8" cy="8" r="6.3"/><path d="M8 7.2v3.8M8 4.9v.1"/>',
  warn: '<path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.6v3.2M8 11.6v.1"/>',
  errc: '<circle cx="8" cy="8" r="6.3"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  ok: '<circle cx="8" cy="8" r="6.3"/><path d="M5.3 8.2l1.9 1.9 3.6-3.8"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="currentColor" stroke="none"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke-width="1.8"/>',
  grip: '<circle cx="6" cy="4" r=".9" fill="currentColor"/><circle cx="10" cy="4" r=".9" fill="currentColor"/><circle cx="6" cy="8" r=".9" fill="currentColor"/><circle cx="10" cy="8" r=".9" fill="currentColor"/><circle cx="6" cy="12" r=".9" fill="currentColor"/><circle cx="10" cy="12" r=".9" fill="currentColor"/>',
  chev: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>',
  undo: '<path d="M5.5 4L2.5 7l3 3"/><path d="M2.5 7h7a4 4 0 0 1 0 8H7"/>',
  reroute: '<path d="M3 3v4.5a3 3 0 0 0 3 3h7.5"/><path d="M10.5 7.5l3 3-3 3"/>',
  hub: '<circle cx="5" cy="12" r="2.3"/><circle cx="19" cy="5.5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="19" cy="18.5" r="2"/><path d="M7.3 12h3.2m0 0c2.6 0 2.4-6.5 6.5-6.5M10.5 12h6.5M10.5 12c2.6 0 2.4 6.5 6.5 6.5"/>'
};
const svg = (n, cls = 'ic') => n === 'hub'
  ? `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I.hub}</svg>`
  : `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

/* ---------- 官方 logo（原始文件，只做尺寸/底板/灰度） ---------- */
const LOGO = {
  dsh: { light: logos.harness, fit: 'cover' },
  deepseek: { light: logos.deepseek, fit: 'contain', k: '72%' },
  grok: { light: logos.grok, fit: 'cover', ringDark: true },
  tavily: { light: logos.tavily, dark: logos.tavilyDark, fit: 'cover' },
  exa: { light: logos.exa, dark: logos.exaDark, fit: 'contain', k: '54%' },
  tinyfish: { light: logos.tinyfish, fit: 'contain', k: '74%', plateDark: true },
  firecrawl: { light: logos.firecrawl, fit: 'contain', k: '54%' },
  github: { light: logos.github, dark: logos.githubDark, fit: 'contain', k: '62%' }
};
const isDark = () => darkTheme;
const logoSrc = (id, dark = isDark()) => (dark && LOGO[id].dark) || LOGO[id].light;
function tile(id, size, compact = false) {
  const L = LOGO[id];
  const dark = isDark();
  const k = compact && L.fit === 'contain' ? '74%' : L.k;
  const st = [size ? `--s:${size}px` : '', k ? `--k:${k}` : ''].filter(Boolean).join(';');
  return `<span class="tile" data-logo="${id}" data-fit="${L.fit}"${dark && L.plateDark ? ' data-plate="light"' : ''}${dark && L.ringDark ? ' data-ring="true"' : ''}${st ? ` style="${st}"` : ''}><img src="${logoSrc(id, dark)}" alt="" draggable="false"></span>`;
}
function refreshLogos() {
  const dark = isDark();
  $$('.tile[data-logo]:not([data-fixed])').forEach((t) => {
    const L = LOGO[t.dataset.logo];
    const img = t.querySelector('img');
    if (img) img.src = logoSrc(t.dataset.logo, dark);
    if (L.plateDark) dark ? t.dataset.plate = 'light' : delete t.dataset.plate;
    if (L.ringDark) dark ? t.dataset.ring = 'true' : delete t.dataset.ring;
  });
  $$('img[data-logo=dsh]').forEach((i) => { i.src = LOGO.dsh.light; });
  $$('img[data-logo=deepseek]').forEach((i) => { i.src = LOGO.deepseek.light; });
}

/* ---------- 供应商元数据（字段与默认值核对自 grok-search-rs v0.1.26 config.rs） ---------- */
const META = {
  grok: { name: 'Grok', group: 'primary', link: 'https://x.ai/api', linkText: '获取 Key', sub: '主搜索 · Grok 回答与引用' },
  tavily: { name: 'Tavily', group: 'supp', link: 'https://tavily.com', linkText: '获取 Key', sub: '网页搜索 / 抓取' },
  exa: { name: 'Exa', group: 'supp', link: 'https://exa.ai', linkText: '获取 Key', sub: '语义搜索' },
  tinyfish: { name: 'TinyFish', group: 'supp', link: 'https://tinyfish.ai', linkText: '获取 Key', sub: '免费搜索 / 抓取' },
  firecrawl: { name: 'Firecrawl', group: 'supp', link: 'https://firecrawl.dev', linkText: '获取 Key', sub: '网页抓取' },
  github: { name: 'GitHub', group: 'extract', link: 'https://github.com/settings/tokens', linkText: '创建 Token', sub: '专用抽取 · Issue / PR / Release' }
};
const SUPP = ['tavily', 'exa', 'tinyfish', 'firecrawl'];
const TAVILY_ROTATE = new Set(['401', '403', '429', '432', '433']);
const DEF = {
  grokUrl: 'https://api.x.ai', grokModel: 'grok-4-1-fast-reasoning',
  tavilyUrl: 'https://api.tavily.com', exaUrl: 'https://api.exa.ai',
  tfSearch: 'https://api.search.tinyfish.ai', tfFetch: 'https://api.fetch.tinyfish.ai',
  fcUrl: 'https://api.firecrawl.dev', ghApi: 'https://api.github.com'
};

function blankProv() {
  return {
    grok: { mode: 'responses', url: '', key: '', model: '', web: true, x: false, gwUrl: '', gwKey: '', gwModel: '', enabled: true },
    tavily: { url: '', keys: [''], enabled: true },
    exa: { url: '', key: '', enabled: true },
    tinyfish: { searchUrl: '', fetchUrl: '', key: '', enabled: true },
    firecrawl: { url: '', key: '', enabled: true },
    github: { token: '', enabled: true }
  };
}
const CARD_FIELDS = {
  grok: { url: 'grok_api_url', key: 'grok_api_key', model: 'grok_model', web: 'web_search_enabled',
    x: 'x_search_enabled', gwUrl: 'openai_compatible_api_url', gwKey: 'openai_compatible_api_key', gwModel: 'openai_compatible_model' },
  tavily: { url: 'tavily_api_url', keys: 'tavily_api_key' },
  exa: { url: 'exa_api_url', key: 'exa_api_key' },
  tinyfish: { searchUrl: 'tinyfish_search_api_url', fetchUrl: 'tinyfish_fetch_api_url', key: 'tinyfish_api_key' },
  firecrawl: { url: 'firecrawl_api_url', key: 'firecrawl_api_key' },
  github: { token: 'github_token' }
};
const HUB_FIELDS = { extra: 'default_extra_sources', fallback: 'fallback_sources', timeout: 'timeout_seconds',
  cache: 'cache_size', maxChars: 'response_max_chars' };
const S = {
  loading: true, busy: false, testing: false, bgRun: false, plugin: true,
  config: null, prefs: null, control: null, program: null, pluginInfo: null, capabilities: null, rpcError: null,
  cfgExists: false, readBanner: false, readDismissed: memory.readDismissed === true,
  prov: blankProv(), order: [...SUPP],
  hub: { extra: 3, fallback: 5, timeout: 60, cache: 256, maxChars: 45000, budget: 120, exeOverride: '', cfgOverride: '' },
  checked: clone(memory.checked || {}), bad: clone(memory.bad || {}), identity: clone(memory.identity || {}),
  providerBad: clone(memory.providerBad || {}),
  configRevision: memory.configRevision || null, configPath: memory.configPath || null,
  marks: {}, trace: null, auxDismissed: memory.auxDismissed || '', lastRouteAt: memory.lastRouteAt || 0,
  diagnosticOperation: null, lastRoute: clone(memory.lastRoute || null),
};

function providersFrom(fields, preferences = {}) {
  const p = blankProv(), order = sourceChain.view(fields);
  for (const [id, mapping] of Object.entries(CARD_FIELDS)) {
    for (const [name, key] of Object.entries(mapping)) {
      const field = fields[key] || {};
      if (name === 'keys') {
        p[id].keys = field.configured
          ? Array.from({ length: Math.max(1, field.keyCount || 1) }, (_, i) => HIDDEN + key + ':' + i) : [''];
      } else if (name === 'key' || name === 'gwKey' || name === 'token') {
        p[id][name] = field.configured ? HIDDEN + key : '';
      } else if (typeof p[id][name] === 'boolean') {
        p[id][name] = typeof field.value === 'boolean' ? field.value : p[id][name];
      } else {
        p[id][name] = field.source === 'default' ? '' : String(field.value ?? '');
      }
    }
    p[id].enabled = id === 'grok' ? preferences.grokEnabled !== false
      : id === 'github' ? preferences.githubEnabled !== false : order.enabled[id];
  }
  p.grok.authReadOnly = typeof fields.grok_auth_mode?.value === 'string' && fields.grok_auth_mode.value !== 'api_key';
  p.grok.mode = !p.grok.authReadOnly && !fields.grok_api_key?.configured
    && fields.openai_compatible_api_url?.value && fields.openai_compatible_api_key?.configured ? 'compat' : 'responses';
  return p;
}
function providerIdentity(id, fields, p) {
  return JSON.stringify([configLocation().full, ...Object.values(CARD_FIELDS[id]).map(key => {
    const item = fields[key] || {};
    return [key, item.value, item.configured, item.keyCount, item.source];
  }), p.mode, p.authReadOnly]);
}
function acceptSnapshot(snapshot, preferences, { first = false, keepTrace = true, trustedConfigUpdate = false } = {}) {
  const fields = snapshot.config?.fields || {}, oldOrder = S.order.join();
  const externalRevision = !trustedConfigUpdate && S.configRevision && S.configRevision !== snapshot.config?.revision;
  const preferencesChanged = S.prefs && preferences
    && (S.prefs.value.grokEnabled !== preferences.value.grokEnabled || S.prefs.value.githubEnabled !== preferences.value.githubEnabled);
  if (externalRevision || preferencesChanged) S.lastRoute = null;
  S.control = snapshot.control || snapshot;
  S.program = snapshot.program;
  S.pluginInfo = snapshot.plugin || {};
  S.capabilities = snapshot.capabilities;
  S.rpcError = null;
  S.config = snapshot.config;
  S.prefs = preferences || S.prefs;
  S.cfgExists = snapshot.config?.exists === true;
  const restored = S.control.policy === 'released' && S.control.routeVerified === true
    && S.control.completionCommitted === true;
  S.plugin = !restored;
  const next = providersFrom(fields, S.prefs?.value);
  for (const id of Object.keys(META)) {
    const identity = providerIdentity(id, fields, next[id]);
    if (externalRevision || S.identity[id] !== identity || S.configPath && S.configPath !== snapshot.config?.path) {
      delete S.checked[id]; delete S.bad[id];
      delete S.providerBad[id];
    }
    S.identity[id] = identity;
  }
  S.prov = next;
  S.order = sourceChain.view(fields).order;
  for (const [name, key] of Object.entries(HUB_FIELDS)) {
    if (typeof fields[key]?.value === 'number') S.hub[name] = fields[key].value;
  }
  S.hub.budget = typeof S.pluginInfo.budgetMs === 'number' ? S.pluginInfo.budgetMs / 1000 : null;
  S.hub.exeOverride = S.program?.configuration?.executable ? S.program.program?.path || '' : '';
  S.hub.cfgOverride = S.program?.configuration?.configPath ? S.program.configPath || '' : '';
  S.configRevision = snapshot.config?.revision;
  S.configPath = snapshot.config?.path;
  S.loading = false;
  if (first) S.readBanner = S.cfgExists && Object.keys(META).some(id => isSet(id));
  if (oldOrder !== S.order.join()) buildRows(false);
  ingestRoute(snapshot.route, first);
  syncAll(keepTrace);
}
let readTask = null, pollTimer = 0;
async function refresh({ first = false, force = false } = {}) {
  if (disposed) return;
  if (readTask) return readTask;
  if (!force && (S.busy || S.testing || drag)) return;
  readTask = (async () => {
    try {
      const [snapshot, prefs] = await Promise.all([remote.snapshot(), remote.preferences()]);
      if (!disposed) acceptSnapshot(snapshot, prefs, { first });
    } catch (error) {
      if (disposed) return;
      S.loading = false;
      S.rpcError = { code: error?.code || 'SETTINGS_UNAVAILABLE', message: error?.message || '设置服务暂不可用，请重试。' };
      syncAll(true);
    }
  })().finally(() => { readTask = null; });
  return readTask;
}
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (document.visibilityState !== 'hidden') await refresh();
    if (!disposed) schedulePoll();
  }, 3000);
}
function updateConfig(config, changedKeys) {
  if (Array.isArray(changedKeys)) {
    S.lastRoute = null;
    for (const [id, mapping] of Object.entries(CARD_FIELDS)) if (Object.values(mapping).some(key => changedKeys.includes(key))) {
      delete S.checked[id]; delete S.bad[id];
      delete S.providerBad[id];
    }
  }
  acceptSnapshot({ control: S.control, program: S.program, config: { ...config,
    displayPath: S.config?.displayPath, error: null }, capabilities: S.capabilities, plugin: S.pluginInfo },
  S.prefs, { keepTrace: false, trustedConfigUpdate: Array.isArray(changedKeys) });
}
function operationError(error, dialog = false) {
  if (disposed) return;
  const code = error?.code || 'SETTINGS_OPERATION_FAILED';
  const message = { CONFIG_CONFLICT: '配置已在别处修改，草稿已保留，请核对后再保存。',
    CONFIG_COMMIT_UNCERTAIN: '配置可能已写入，请重新读取确认，不要重复保存。',
    PREFERENCES_CONFLICT: '插件开关已在别处修改，请重试。',
    PREFERENCES_COMMIT_UNCERTAIN: '插件开关可能已保存，请重新读取确认，不要重复操作。',
    PREFERENCES_BUSY: '插件开关正在保存或上次保存被中断，请检查后重试。',
    CONFIG_BUSY: '配置正在保存或上次保存被中断，请检查后重试。',
    CONFIG_ENV_OVERRIDE: '此设置由环境变量控制，不能在插件中覆盖。',
  }[code] || error?.message || '操作失败，请重试。';
  if (dialog && D) {
    D.saving = false; D.clearing = false;
    D.operationError = { code, message };
    const body = $('.dlg-body', dlg), top = body?.scrollTop || 0;
    if (D.kind === 'card') renderCard(); else renderHub();
    const nextBody = $('.dlg-body', dlg);
    if (nextBody) nextBody.scrollTop = top;
    shake(dlg);
  } else toast(`${code} · ${message}`, { tone: 'err', ms: 5200 });
}
async function reloadDialogDraft() {
  if (!D || dialogBusy() || S.busy || disposed) return;
  const mine = D, previous = clone(mine.base), draft = clone(mine.draft);
  const changed = Object.keys(draft).filter(key => JSON.stringify(draft[key]) !== JSON.stringify(previous[key]));
  mine.saving = true; S.busy = true; lockDialog();
  try {
    const [snapshot, prefs] = await Promise.all([remote.snapshot(), remote.preferences()]);
    if (disposed || D !== mine) return;
    if (snapshot.config.error) throw Object.assign(new Error(snapshot.config.error.message), { code: snapshot.config.error.code });
    acceptSnapshot(snapshot, prefs);
    mine.base = clone(mine.kind === 'card' ? S.prov[mine.id] : S.hub);
    if (mine.kind === 'card' && !isSet(mine.id, mine.base)) mine.base.enabled = true;
    mine.fields = clone(configFields());
    mine.configBaseline = clone(S.config);
    mine.draft = clone(mine.base);
    for (const key of changed) {
      if (!fieldReadOnly(key) && (key !== 'mode' || !mine.base.authReadOnly && !mine.fields.grok_api_key?.readOnly)) {
        mine.draft[key] = clone(draft[key]);
      }
    }
    mine.orig = JSON.stringify(mine.kind === 'card' ? normCard(mine.base) : normHub(mine.base));
    mine.operationError = { code: 'CONFIG_RELOADED',
      message: '已读取最新配置并保留你的修改。请核对后再保存；本次没有写入。' };
    mine.show = {};
    mine.saving = false;
    if (mine.kind === 'card') renderCard(); else renderHub();
  } catch (error) { if (D === mine) operationError(error, true); }
  finally { S.busy = false; if (D === mine) mine.saving = false; }
}
// One retry for an unrelated external write. Never replace a newly edited
// field with a stale whole-file snapshot; an undo deliberately never rebases.
async function saveConfig(build, baseline = null) {
  if (!S.config || S.config.error) throw Object.assign(new Error('请先修正配置文件。'), { code: 'CONFIG_PARSE_FAILED' });
  const starting = clone(S.config);
  const fieldChanged = (old, current, updates) => old.path !== current.path || Object.keys(updates).some(key =>
    key.endsWith('_key') || key === 'github_token' || JSON.stringify(old.fields[key]) !== JSON.stringify(current.fields[key]));
  for (let attempt = 0; attempt < 2; attempt++) {
    const updates = typeof build === 'function' ? build(S.config.fields) : build;
    const revision = S.config.revision;
    if (!Object.keys(updates).length) return null;
    if (baseline && baseline.revision !== revision && fieldChanged(baseline, S.config, updates)) {
      throw Object.assign(new Error('配置已在别处修改，请核对草稿后再保存。'), { code: 'CONFIG_CONFLICT' });
    }
    try {
      const result = await remote.save({ expectedRevision: revision, updates });
      if (!disposed) updateConfig(result.config, Object.keys(updates));
      return { before: revision, after: result.config.revision, undo: starting.exists };
    } catch (error) {
      if (attempt || error?.code !== 'CONFIG_CONFLICT' || disposed) throw error;
      await refresh({ force: true });
      if (S.rpcError || !S.config || S.config.error) throw error;
      // Redacted snapshots cannot establish whether another writer replaced a
      // credential with a different same-length/same-count value. Never rebase
      // a secret write from redacted equality.
      const collision = fieldChanged(starting, S.config, updates);
      if (collision) throw error;
    }
  }
}
async function savePreference(id, on) {
  const key = id === 'grok' ? 'grokEnabled' : 'githubEnabled';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await remote.savePreferences({ expectedRevision: S.prefs.revision,
        value: { ...S.prefs.value, [key]: on } });
      if (!disposed) {
        S.prefs = result;
        S.prov[id].enabled = result.value[key] !== false;
      }
      return result;
    } catch (error) {
      if (attempt || error?.code !== 'PREFERENCES_CONFLICT' || disposed) throw error;
      S.prefs = await remote.preferences();
    }
  }
}
function configUndo(receipt) {
  if (!receipt?.undo || !S.capabilities?.secretsAllowed) return undefined;
  return async () => {
    if (disposed || S.busy) return;
    S.busy = true;
    try {
      const result = await remote.restoreConfig({ expectedRevision: receipt.after, revision: receipt.before });
      if (!disposed) { updateConfig(result.config); toast('已恢复保存前的配置 · 下次搜索生效'); }
    } catch (error) { operationError(error); }
    finally { S.busy = false; if (!disposed) syncAll(true); }
  };
}
function cardUndo(receipt, id, previousEnabled, preferenceChanged) {
  if (!preferenceChanged) return configUndo(receipt);
  if (receipt && (!receipt.undo || !S.capabilities?.secretsAllowed)) return undefined;
  return async () => {
    if (disposed || S.busy) return;
    S.busy = true;
    let restored = false;
    try {
      if (receipt) {
        const result = await remote.restoreConfig({ expectedRevision: receipt.after, revision: receipt.before });
        if (disposed) return;
        updateConfig(result.config);
        restored = true;
      }
      await savePreference(id, previousEnabled);
      if (!disposed) { syncAll(false); toast('已撤销配置和 DSH 开关修改'); }
    } catch (error) {
      operationError(restored ? Object.assign(new Error('共享配置已恢复，但 DSH 开关未恢复。请核对开关。'),
        { code: 'SETTINGS_PARTIAL_RESTORE' }) : error);
    } finally { S.busy = false; if (!disposed) syncAll(true); }
  };
}
function normalizeCode(code) {
  return String(code || 'UNKNOWN').replace(/^HTTP_/i, '').trim();
}
function ingestRoute(route, first = false) {
  if (!route || route.origin === 'test' || route.at <= S.lastRouteAt) return;
  S.lastRouteAt = route.at;
  S.lastRoute = clone(route);
  if (route.grokCode !== 'DISABLED' && grokOn()) {
    rememberCheck('grok', 0, route.grokCode ? normalizeCode(route.grokCode) : '', 'search', route.at);
  }
  if (SUPP.includes(route.served)) {
    delete S.providerBad[route.served];
    if (route.served === 'tavily') {
      // MCP/source search does not identify the successful Key. Do not turn
      // every configured Tavily Key green from one provider-level result.
      delete S.checked.tavily; delete S.bad.tavily;
      S.checked.tavilyProvider = { at: route.at, source: 'search' };
    } else rememberCheck(route.served, 0, '', 'search', route.at);
  }
  const failures = (route.failures || []).filter(row => SUPP.includes(row.provider) && row.code !== 'EMPTY');
  for (const failure of failures) {
    if (failure.provider === 'tavily') S.providerBad.tavily = { code: normalizeCode(failure.code), at: route.at };
    else rememberCheck(failure.provider, 0, normalizeCode(failure.code), 'search', route.at);
  }
  S.trace = { bg: true, order: S.order.slice(), items: [],
    failedSources: failures.map(row => row.provider), served: route.served,
    reroute: route.fallbackUsed === true, outcome: route.outcome,
    done: { tone: route.outcome === 'ok' ? 'ok' : 'err',
      text: route.outcome !== 'ok' ? '全部不可用'
        : route.served === 'grok-sources' ? '已回退 · Grok 内置补充链'
          : route.fallbackUsed ? `已回退 · ${META[route.served]?.name || '补充来源'}` : 'Grok 搜索完成' } };
  clearTimeout(S.traceTimer);
  S.traceTimer = setTimeout(() => { S.trace = null; renderSummary(); pumpWires(200); }, 6500);
  if (first) quiet(1000);
  else {
    for (const id of ['grok', ...failures.map(row => row.provider)]) {
      if (S.bad[id] || failures.some(row => row.provider === id)) { pulseFault(rowOf(id)); void jolt(rowOf(id)); }
    }
  }
}

function isSet(id, p = S.prov[id]) {
  if (id === 'grok') return p.authReadOnly || (p.mode === 'compat' ? !!(p.gwUrl.trim() && p.gwKey.trim()) : !!p.key.trim());
  if (id === 'tavily') return p.keys.some((k) => k.trim());
  if (id === 'github') return !!p.token.trim();
  return !!p.key.trim();
}
const isOn = (id) => isSet(id) && S.prov[id].enabled !== false;
const enabledSupp = () => S.order.filter(isOn);

/* ---------- 健康状态 ---------- */
const tvKeyIdx = (p = S.prov.tavily) => p.keys.map((k, i) => (k.trim() ? i : -1)).filter((i) => i >= 0);
function faultOf(map, id) {
  const v = map[id];
  if (id !== 'tavily') return v ? 'all' : '';
  if (!v) return '';
  const idx = tvKeyIdx();
  const n = idx.filter((i) => v[i]).length;
  return !n ? '' : n === idx.length ? 'all' : 'some';
}
const isBad = (id) => faultOf(S.bad, id) === 'all';
const isPart = (id) => faultOf(S.bad, id) === 'some';
const grokOn = () => isOn('grok');
const usable = (id) => isOn(id) && !isBad(id);
const requestFailed = id => S.lastRoute?.failures?.some(failure => failure.provider === id) === true;
const unknownFallback = () => S.lastRoute?.served === 'grok-sources' && S.lastRoute.outcome === 'ok';
const servingSupp = () => unknownFallback() || S.lastRoute?.outcome === 'failed' ? null
  : SUPP.includes(S.lastRoute?.served) && isOn(S.lastRoute.served) && !requestFailed(S.lastRoute.served)
    ? S.lastRoute.served : enabledSupp().find(id => !isBad(id) && !requestFailed(id)) || null;
/* checked 只记录完成时间和来源；成败统一由 bad 与完成记录共同确定。
   pending 属于本轮 trace，不能覆盖上一次已经完成的验证结果。 */
function savedCheck(id, slot = 0) {
  const code = id === 'tavily' ? S.bad.tavily?.[slot] : S.bad[id];
  const record = S.checked[id]?.[slot];
  return { tone: code ? 'err' : record ? 'ok' : 'idle', code: code || '', record };
}
function rememberCheck(id, slot, code, source, at = Date.now()) {
  (S.checked[id] ||= {})[slot] = { at, source };
  if (id === 'tavily') {
    const bad = { ...(S.bad.tavily || {}) };
    if (code) bad[slot] = code; else delete bad[slot];
    if (Object.keys(bad).length) S.bad.tavily = bad; else delete S.bad.tavily;
  } else if (code) S.bad[id] = code;
  else delete S.bad[id];
}
function reconcileChecks(id, prev, next) {
  delete S.providerBad[id];
  // Tavily 只编辑一个 Key 时，按凭据对应关系保留其他 Key 的结果，包括重新编号。
  if (id === 'tavily' && prev.url.trim() === next.url.trim()) {
    ['checked', 'bad'].forEach((name) => {
      const old = S[name][id] || {};
      const mapped = {};
      next.keys.forEach((key, i) => {
        const j = key ? prev.keys.findIndex((v) => v.trim() === key) : -1;
        if (j >= 0 && Object.hasOwn(old, j)) mapped[i] = old[j];
      });
      if (Object.keys(mapped).length) S[name][id] = mapped; else delete S[name][id];
    });
  } else {
    delete S.checked[id]; delete S.bad[id];
  }
  delete S.marks[id];
}
function codeOf(id, map = S.bad) {
  const v = map[id];
  if (!v) return '';
  if (id !== 'tavily') return v;
  const codes = tvKeyIdx().map((i) => v[i]).filter(Boolean);
  return [...new Set(codes)].join('/');
}
function routeStatus() {
  if (S.loading) return 'load';
  if (S.rpcError) return 'down';
  if (S.config?.error) return 'cfgerr';
  if (S.control?.error || ['incomplete', 'conflict', 'unavailable', 'stopping'].includes(S.control?.phase)) return 'ctlerr';
  if (!S.plugin) return 'off';
  if (!['required'].includes(S.control?.phase)) return 'connecting';
  if (S.lastRoute?.outcome === 'failed') return 'err';
  const sv = servingSupp();
  if (unknownFallback()) return 'fallback';
  if (S.prov.grok.enabled !== false && ['idle', 'discovering', 'checking-version', 'downloading', 'verifying'].includes(S.program?.phase)) {
    return sv ? 'backup' : 'prep';
  }
  if (grokOn()) {
    if (!isBad('grok') && S.program?.phase !== 'error') return 'live';
    return sv ? 'fallback' : 'err';
  }
  if (sv) return 'backup';
  if (enabledSupp().length) return 'err';
  const anySet = ['grok', ...SUPP].some((id) => isSet(id));
  return anySet ? 'none' : 'wait';
}
const STATUS_TEXT = { load: '读取配置…', down: '设置服务不可用', cfgerr: '配置文件无法读取', ctlerr: '接管异常',
  connecting: '正在接管…', prep: '正在准备 Grok', off: '已恢复原搜索', wait: '等待配置', none: '未启用来源',
  err: '搜索失败', live: '正在接管', fallback: '已静默回退', backup: '补充来源接管' };

function rowState(id) {
  const st = routeStatus();
  if (['load', 'down', 'cfgerr', 'ctlerr', 'connecting'].includes(st)) return isSet(id) ? 'on' : 'unset';
  if (id === 'grok') {
    if (!isSet('grok')) return st === 'wait' ? 'wait' : 'unset';
    if (!grokOn()) return 'off';
    if (st === 'off') return 'on';
    if (isBad('grok') || S.program?.phase === 'error') return st === 'err' ? 'err' : 'bad';
    if (S.program?.phase !== 'ready') return 'on';
    return 'live';
  }
  if (!isSet(id)) return 'unset';
  if (S.prov[id].enabled === false) return 'off';
  if (st === 'off' || id === 'github') return 'on';
  if (isBad(id) || requestFailed(id)) return st === 'err' ? 'err' : 'bad';
  if ((st === 'fallback' || st === 'backup') && servingSupp() === id) return 'live';
  return 'on';
}

/* ---------- 连线 ----------
   只保留宽版：每个来源拥有独立支路，故障不会切断其他来源。 */
const RANK = { hidden: 0, unset: 1, rest: 2, broken: 3, aux: 4, standby: 5, warn: 6, live: 7 };
function wireDefs() {
  const st = routeStatus();
  const off = st === 'off';
  const sv = servingSupp();
  const covering = st === 'fallback' || st === 'backup';
  const defs = [];
  const top = { off: 'rest', load: 'hidden', down: 'rest', cfgerr: 'broken', ctlerr: 'broken',
    connecting: 'warn', prep: 'warn', wait: 'warn', none: 'warn', err: 'broken' }[st] || 'live';
  defs.push({ id: 'dsh-hub', a: 'dsh-out', b: 'hub-in', ws: top, at: 'start' });
  defs.push({ id: 'dsh-off', a: 'dsh-alt', b: 'off-in', ws: off ? 'live' : 'hidden', kind: 'alt' });
  const rows = ['grok', ...S.order, 'github'];
  rows.forEach((id) => {
    let ws;
    if (st === 'load') ws = 'hidden';
    else if (['down', 'cfgerr', 'ctlerr', 'connecting'].includes(st)) ws = 'rest';
    else if (off) ws = isSet(id) ? 'rest' : 'unset';
    else if (!isSet(id)) ws = id === 'grok' && st === 'wait' ? 'warn' : 'unset';
    else if (!isOn(id)) ws = 'rest';
    else if (id === 'github') ws = isOn('github') ? 'aux' : 'unset';
    else if (isBad(id) || requestFailed(id) || id === 'grok' && S.program?.phase === 'error') ws = 'broken';
    else if (id === 'grok') ws = S.program?.phase === 'ready' ? 'live' : 'warn';
    else ws = covering && id === sv ? 'live' : 'standby';
    defs.push({ id: 'hub-' + id, a: 'hub-out', b: 'row-' + id, ws, kind: 'branch', at: 'end' });
  });
  return defs;
}
function portEl(name) {
  if (name.startsWith('row-')) return $(`.row[data-id="${name.slice(4)}"] > .port`);
  return $(`.port[data-port="${name}"]`);
}
function portXY(name, sr) {
  const el = portEl(name);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - sr.left, y: r.top + r.height / 2 - sr.top };
}
function pathFor(d, A, B) {
  if (d.kind === 'alt') return `M${A.x},${A.y} L${B.x},${B.y}`;
  const dx = Math.max(24, (B.x - A.x) * 0.5);
  return `M${A.x},${A.y} C${A.x + dx},${A.y} ${B.x - dx},${B.y} ${B.x},${B.y}`;
}
const wiresEl = $('#wires');
const SVGNS = 'http://www.w3.org/2000/svg';
const wireNodes = new Map();
let packetLayer = null;
let quietUntil = 0;
const quiet = (ms = 900) => { quietUntil = performance.now() + ms; };
function ensureWire(id) {
  let g = wireNodes.get(id);
  if (!g) {
    g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'wg');
    g.dataset.w = id;
    const t = document.createElementNS(SVGNS, 'path'); t.setAttribute('class', 'wt');
    const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('class', 'w');
    const d1 = document.createElementNS(SVGNS, 'circle'); d1.setAttribute('class', 'w-end'); d1.setAttribute('r', '1.4');
    const d2 = document.createElementNS(SVGNS, 'circle'); d2.setAttribute('class', 'w-end'); d2.setAttribute('r', '1.4');
    g.append(t, p, d1, d2);
    wireNodes.set(id, g);
    wiresEl.appendChild(g);
  }
  return g;
}
const BREAK = { end: 8, gap: 10 };
function syncBreak(g, prev, at) {
  if (g.dataset.ws === 'broken' && prev !== 'broken') g._bt = performance.now();
  if (g.dataset.ws !== 'broken') {
    g._bt = 0;
    delete g._bf;
    g.classList.remove('is-broken');
    g.children[1].style.strokeDasharray = '';
    g.children[1].style.strokeLinecap = '';
    g.children[2].style.opacity = g.children[3].style.opacity = '';
    return 0;
  }
  const p = g.children[1];
  g.classList.add('is-broken');
  if (!g._bt) g._bt = performance.now();
  if (g.classList.contains('lit')) {
    p.style.strokeDasharray = '';
    p.style.strokeLinecap = '';
    g.children[2].style.opacity = g.children[3].style.opacity = '0';
    return 0;
  }
  const k = reduced() || performance.now() <= quietUntil ? 1 : Math.min(1, (performance.now() - g._bt) / 420);
  // 断口向两侧张开，带约 7% 的轻微回弹；同一次故障的断点不会逐帧漂移。
  const u = k - 1;
  const e = Math.max(0, 1 + 2.4 * u * u * u + 1.4 * u * u);
  const len = p.getTotalLength();
  if (!len) return 0;
  g._bf ??= Math.random();
  const guard = Math.min(BREAK.end, len / 5);
  const target = Math.min(BREAK.gap * e, len - guard * 2);
  const center = len * (at === 'start' ? .3 + g._bf * .3 : .45 + g._bf * .37);
  const s = Math.max(guard, Math.min(len - target - guard, center - target / 2));
  p.style.strokeDasharray = `${s} ${target} ${Math.max(0, len - s - target)} 0`;
  p.style.strokeLinecap = 'butt';
  if (target > 0.2) {
    const a = p.getPointAtLength(s);
    const b = p.getPointAtLength(s + target);
    g.children[2].setAttribute('cx', a.x); g.children[2].setAttribute('cy', a.y);
    g.children[3].setAttribute('cx', b.x); g.children[3].setAttribute('cy', b.y);
    g.children[2].style.opacity = g.children[3].style.opacity = String(Math.min(1, e * 1.3));
  } else {
    g.children[2].style.opacity = g.children[3].style.opacity = '0';
  }
  return k < 1 ? 40 : 0;
}
function drawWires() {
  const stage = $('#stage');
  const sr = stage.getBoundingClientRect();
  const defs = wireDefs();
  const portRank = {};
  const live = new Set();
  let breaking = 0;
  defs.forEach((d) => {
    live.add(d.id);
    const fresh = !wireNodes.has(d.id);
    const g = ensureWire(d.id);
    const prev = g.dataset.ws;
    g.dataset.ws = d.ws;
    const requesting = S.testing && !S.trace?.done && (d.id === 'dsh-hub'
      || S.trace?.items.some((it) => it.tone === 'run' && d.id === 'hub-' + it.id));
    g.dataset.requesting = String(!!requesting);
    const A = portXY(d.a, sr), B = portXY(d.b, sr);
    if (A && B) {
      const dd = pathFor(d, A, B);
      g.children[0].setAttribute('d', dd);
      g.children[1].setAttribute('d', dd);
      breaking = Math.max(breaking, syncBreak(g, prev, d.at));
    }
    if (!fresh && prev !== d.ws) {
      if (!S.testing && performance.now() > quietUntil) onWireChange(d, g, prev);
      if (d.ws === 'broken' && !reduced() && performance.now() > quietUntil) breaking = Math.max(breaking, 60);
    }
    [d.a, d.b].forEach((pn) => { if ((portRank[pn] ?? -1) < RANK[d.ws]) portRank[pn] = RANK[d.ws]; });
  });
  for (const [id, g] of wireNodes) if (!live.has(id)) { g.remove(); wireNodes.delete(id); }
  const rk = (g) => (g.classList.contains('lit') ? 99 : RANK[g.dataset.ws]);
  const sorted = defs.map((d) => wireNodes.get(d.id)).sort((x, y) => rk(x) - rk(y));
  const cur = $$('.wg', wiresEl);
  if (sorted.some((g, i) => cur[i] !== g)) sorted.forEach((g) => wiresEl.appendChild(g));
  if (!packetLayer) { packetLayer = document.createElementNS(SVGNS, 'g'); packetLayer.setAttribute('class', 'packets'); }
  if (wiresEl.lastChild !== packetLayer) wiresEl.appendChild(packetLayer);
  const names = Object.keys(RANK);
  Object.entries(portRank).forEach(([pn, rk]) => { const el = portEl(pn); if (el) el.dataset.ps = names.find((n) => RANK[n] === rk); });
  if (breaking) pumpWires(breaking);
}
let pumpUntil = 0, pumpRaf = 0;
function pumpWires(ms = 520) {
  pumpUntil = Math.max(pumpUntil, performance.now() + ms);
  if (pumpRaf) return;
  const tick = () => {
    drawWires();
    if (performance.now() < pumpUntil) pumpRaf = requestAnimationFrame(tick);
    else pumpRaf = 0;
  };
  pumpRaf = requestAnimationFrame(tick);
}
/* 路由切换只用一次涌光提示；流动光点仅用于测试请求，失效由断口缓慢张开表达。 */
function surge(g, tone) {
  g.classList.remove('surge');
  void g.getBoundingClientRect();
  g.classList.add('surge');
  setTimeout(() => g.classList.remove('surge'), 1000);
}
function onWireChange(d, g, prev) {
  if (reduced()) return;
  if (d.ws === 'live' && d.kind === 'branch') {
    surge(g);
  }
}
/* ---------- 端口标记：实心 = 最近验证通过；半实心 = 部分 Key 通过。
   失效不再画叉：由断开的连线和空心端口表达，颜色不单独承担状态。 ---------- */
function markFor(id) {
  const st = routeStatus();
  if (st === 'load' || st === 'off') return '';
  if (!isOn(id) || isBad(id) || requestFailed(id)) return '';
  const slots = id === 'tavily' ? tvKeyIdx() : [0];
  const passed = slots.filter((slot) => savedCheck(id, slot).tone === 'ok').length;
  return passed === slots.length ? 'ok' : passed ? 'part' : '';
}
function syncMarks() {
  let changed = false;
  $$('.row').forEach((r) => {
    const p = r.querySelector('.port');
    const m = markFor(r.dataset.id);
    if ((p.dataset.mark || '') === m) return;
    changed = true;
    if (m) {
      p.dataset.mark = m;
      p.classList.remove('pop');
      void p.offsetWidth;
      p.classList.add('pop');
    } else delete p.dataset.mark;
  });
  if (changed) pumpWires(300);
}

/* ---------- 唯一宽版（按插件区域重新定位连线） ---------- */
const card = $('#routeCard');
// 仅重新定位连线，不因窗口大小切换路由布局。
const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => pumpWires(80)));
resizeObserver.observe(card);

/* ---------- 供应商行：图标 + 名称 + 开关 ---------- */
function rowEl(id) {
  const m = META[id];
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.id = id;
  if (m.group === 'supp') el.dataset.drag = 'true';
  el.innerHTML = `<span class="port"></span><button type="button" class="row-main">${tile(id)}<span class="row-name">${m.name}</span></button><button type="button" class="switch" role="switch" aria-checked="false"><i></i></button><span class="row-fault" id="rowFault-${id}" role="status" aria-atomic="true" aria-hidden="true"><span class="row-fault-code"></span><span class="row-fault-sep" aria-hidden="true">·</span><span class="row-fault-reason"></span></span>`;
  return el;
}
function syncRow(el) {
  const id = el.dataset.id;
  const st = rowState(id);
  el.dataset.st = st;
  const sw = el.querySelector('.switch');
  const name = META[id].name;
  const checked = isOn(id);
  const label = !isSet(id) ? `${name} 未配置，打开配置` : id === 'github' ? 'DSH 测试时检测 GitHub' : id === 'grok' ? '启用 Grok 主搜索' : `启用 ${name}`;
  sw.setAttribute('aria-checked', String(checked));
  sw.setAttribute('aria-label', label);
  sw.disabled = S.busy || ['down', 'cfgerr', 'ctlerr', 'connecting'].includes(routeStatus());
  const unverified = id === 'tavily'
    ? tvKeyIdx().every((slot) => savedCheck(id, slot).tone === 'idle')
    : savedCheck(id).tone === 'idle';
  const stText = st === 'live' && unverified ? '已启用，尚未验证'
    : { unset: '未配置', wait: '等待配置', on: '已启用', off: '已停用', live: '正在使用', bad: '最近验证失败', err: '最近验证失败' }[st];
  let aria = `${name}，${stText}`;
  if (META[id].group === 'supp') aria += `，补充来源第 ${S.order.indexOf(id) + 1} 位。按 Enter 打开配置，Alt 加上下方向键调整顺序`;
  else aria += '。按 Enter 打开配置';
  const fault = rowFault(id);
  const badge = el.querySelector('.row-fault');
  el.classList.toggle('has-fault', !!fault);
  const key = fault ? `${fault.tone}:${fault.status}:${fault.text}:${fault.detail}` : '';
  if (badge._state !== key) {
    badge._state = key;
    badge.setAttribute('aria-hidden', String(!fault));
    if (fault) badge.setAttribute('aria-label', fault.detail); else badge.removeAttribute('aria-label');
    badge.dataset.tone = fault?.tone || '';
    badge.querySelector('.row-fault-code').textContent = fault?.status || '';
    badge.querySelector('.row-fault-reason').textContent = fault?.text || '';
  }
  const main = el.querySelector('.row-main');
  if (fault) {
    el.title = fault.detail;
    main.setAttribute('aria-describedby', badge.id);
  } else {
    el.removeAttribute('title');
    main.removeAttribute('aria-describedby');
  }
  main.setAttribute('aria-label', aria);
}
function syncRows() { $$('.row').forEach(syncRow); syncMarks(); }
function buildRows(animate) {
  $('#rowsPrimary').replaceChildren(rowEl('grok'));
  $('#rowsSupp').replaceChildren(...S.order.map(rowEl));
  $('#rowsExtract').replaceChildren(rowEl('github'));
  syncRows();
  if (animate && !reduced()) {
    $$('.row').forEach((r, i) => {
      r.style.setProperty('--i', i);
      r.classList.add('enter');
      r.addEventListener('animationend', (e) => { if (e.animationName === 'row-in') r.classList.remove('enter'); });
    });
  }
}

/* ---------- 头部 / 说明行 / 提示条 / 底栏 ---------- */
function renderHead() {
  const st = routeStatus();
  card.dataset.s = st;
  card.dataset.plugin = S.plugin ? 'on' : 'off';
  card.classList.toggle('is-loading', st === 'load');
  const pill = $('#statusPill');
  if (pill.dataset.s !== st) {
    pill.dataset.s = st;
    $('#statusText').textContent = STATUS_TEXT[st];
    if (!reduced() && st !== 'load') { pill.classList.remove('swap'); void pill.offsetWidth; pill.classList.add('swap'); }
  }
  const tb = $('#testBtn');
  tb.innerHTML = S.testing && !S.bgRun ? '<span class="spin"></span>测试中…' : `${svg('play', 'ic ic-sm')}测试搜索`;
  tb.disabled = S.testing || S.busy || ['off', 'wait', 'none', 'load', 'down', 'cfgerr', 'ctlerr', 'connecting', 'prep'].includes(st);
  tb.title = { off: '插件已关闭，打开插件开关后可测试', wait: '先填写至少一个搜索来源的 Key', none: '先启用 Grok 或至少一个补充来源' }[st] || '';
  $('#testPop .pop-text').textContent = grokOn()
    ? '会逐一测试 Grok 和全部已开启的补充来源，Tavily 的每个 Key 单独检查，各次测试会消耗相应额度。正常搜索仍在补充链首个成功处停止。'
    : `Grok 未启用，会逐一测试 ${enabledSupp().map((id) => META[id].name).join('、') || '补充来源'} 的全部 Key，各次测试会消耗相应额度。正常搜索仍在首个成功处停止。`;
  $('#hubMeta').innerHTML = `<span class="nw">${esc(S.program?.program?.version ? 'v' + S.program.program.version : programPhase())}</span><span class="nw"><span class="hm-dot">· </span>${esc(programSource())}</span>`;
  const native = S.control?.acquisition?.authorSearchProvider;
  $('#nodeOfficial .node-name').textContent = native ? '原搜索设置' : 'DeepSeek 官方搜索';
  $('#nodeOfficial').setAttribute('aria-hidden', String(st !== 'off'));
}
function programPhase() {
  return { idle: '待准备', discovering: '检测中', 'checking-version': '检查版本', downloading: '下载中',
    verifying: '验证中', ready: '已就绪', error: '准备失败', disposed: '已停止' }[S.program?.phase] || '等待程序';
}
function programSource() {
  const source = S.program?.program?.source;
  return ['manual', 'loader'].includes(source) ? '手动指定'
    : ['path', 'npm', 'cargo'].includes(source) ? '已有安装'
      : source === 'private-cache' ? '随插件安装' : '自动检测';
}

/* ---------- 路由条：主搜索 + 补充来源，静态与测试共用同一套图标状态 ---------- */
const stripSlot = $('#stripSlot');
const stripEl = $('#strip');
const stripNodes = new Map();
const routeTooltip = $('#routeTooltip');
let stripTipTarget = null, stripTipTimer = 0;
let stripSect = '';
function hideStripTip() {
  clearTimeout(stripTipTimer);
  stripTipTarget = null;
  routeTooltip.hidden = true;
}
function showStripTip(node) {
  if (!node?.isConnected || !stripSlot.classList.contains('has')) { hideStripTip(); return; }
  clearTimeout(stripTipTimer);
  stripTipTarget = node;
  routeTooltip.textContent = node._tip;
  routeTooltip.hidden = false;
  const r = node.getBoundingClientRect();
  const t = routeTooltip.getBoundingClientRect();
  routeTooltip.style.left = Math.max(12, Math.min(innerWidth - t.width - 12, r.left + r.width / 2 - t.width / 2)) + 'px';
  routeTooltip.style.top = Math.max(12, r.bottom + t.height + 10 < innerHeight ? r.bottom + 8 : r.top - t.height - 8) + 'px';
}
stripEl.addEventListener('pointerover', (e) => {
  const node = e.target.closest('.s-node');
  if (node) showStripTip(node);
});
stripEl.addEventListener('pointerout', (e) => {
  if (e.relatedTarget && (stripTipTarget?.contains(e.relatedTarget) || routeTooltip.contains(e.relatedTarget))) return;
  stripTipTimer = setTimeout(() => {
    if (stripTipTarget !== active()) hideStripTip();
  }, 100);
});
stripEl.addEventListener('focusin', (e) => { if (e.target.matches('.s-node')) showStripTip(e.target); });
stripEl.addEventListener('focusout', (e) => { if (!stripEl.contains(e.relatedTarget)) hideStripTip(); });
routeTooltip.addEventListener('pointerenter', () => clearTimeout(stripTipTimer));
routeTooltip.addEventListener('pointerleave', () => {
  if (stripTipTarget !== active()) hideStripTip();
});
listen(document, 'keydown', e => { if (e.key === 'Escape') hideStripTip(); });
listen(window, 'resize', hideStripTip);
listen(window, 'scroll', hideStripTip, true);
function stripNode(m) {
  let n = stripNodes.get(m.id);
  if (!n) {
    n = document.createElement('span');
    n.className = 's-node';
    n.dataset.id = m.id;
    n.tabIndex = 0;
    n.setAttribute('role', 'img');
    n.insertAdjacentHTML('beforeend', tile(m.id, 16, true));
    n.insertAdjacentHTML('beforeend', '<span class="s-dots" aria-hidden="true"></span>');
    stripNodes.set(m.id, n);
  }
  if (n.dataset.role !== m.role) n.dataset.role = m.role;
  if (n.dataset.st !== m.st) n.dataset.st = m.st;
  n.dataset.health = m.health;
  n.style.opacity = '1';
  n._tip = m.tip;
  n.setAttribute('aria-label', m.tip.replace(/\n/g, '；'));
  const dots = n.lastElementChild;
  const key = m.dots.map((d) => `${d.tone}:${d.tip}`).join(',');
  if (dots.dataset.k !== key) {
    dots.innerHTML = m.dots.map((d) => `<i class="s-dot" data-tone="${d.tone}"></i>`).join('');
    dots.dataset.k = key;
  }
  return n;
}
function placeStrip(list, key) {
  const old = new Map($$(':scope > .s-node', stripEl).map((n) => [n, n.getBoundingClientRect().left]));
  let at = stripEl.firstElementChild;
  list.forEach((n) => {
    if (n === at) { at = at.nextElementSibling; return; }
    stripEl.insertBefore(n, at);
  });
  while (at) { const next = at.nextElementSibling; at.remove(); at = next; }
  if (old && !reduced()) {
    let moved = false;
    list.forEach((n) => {
      const dx = (old.get(n) ?? n.getBoundingClientRect().left) - n.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) { n.style.transition = 'none'; n.style.transform = `translateX(${dx}px)`; moved = true; }
    });
    if (moved) {
      void stripEl.offsetWidth;
      list.forEach((n) => { n.style.transition = 'transform .32s var(--ease)'; n.style.transform = ''; });
    }
  }
  if (stripSect !== key) {
    stripSect = key;
    if (['broken', 'detour', 'end'].includes(key)) stripEl.querySelector(`.s-${key}`)?.classList.add('is-new');
  }
}
const linkSvg = (tone) => tone === 'detour'
  ? '<svg class="s-link" data-tone="detour" viewBox="0 0 20 8" aria-hidden="true"><path class="sl-arc" pathLength="1" d="M0 4h4.5M8.2 4C10.1 4 9.3 1.3 11.8 1.3H15.8"/><path class="sl-head" d="M14.3 2.2L17 4l-2.7 1.8"/></svg>'
  : tone === 'broken'
    ? '<svg class="s-link" data-tone="broken" viewBox="0 0 20 8" aria-hidden="true"><path class="sl-line" d="M0 4h5.2"/><path class="sl-line" d="M13.4 4h2.1"/><path class="sl-head" d="M14.9 2.2L17.2 4l-2.3 1.8"/><circle cx="6.7" cy="4" r="1" fill="currentColor"/><circle cx="11.9" cy="4" r="1" fill="currentColor"/></svg>'
    : tone === 'dash'
      ? '<svg class="s-link" data-tone="dash" viewBox="0 0 20 8" aria-hidden="true"><path class="sl-line" d="M0 4h15.4"/><path class="sl-head" d="M14.2 2.2L16.5 4l-2.3 1.8"/></svg>'
      : '<svg class="s-link" data-tone="next" viewBox="0 0 20 8" aria-hidden="true"><path class="sl-line" d="M0 4h15.4"/><path class="sl-head" d="M14.2 2.2L16.5 4l-2.3 1.8"/></svg>';
function stripLink(tone, idx) {
  stripEl._links = stripEl._links || new Map();
  let el = stripEl._links.get(idx);
  if (!el || el.dataset.tone !== tone) {
    const holder = document.createElement('span');
    holder.innerHTML = linkSvg(tone);
    el = holder.firstElementChild;
    el.classList.add('is-new');
    stripEl._links.set(idx, el);
    setTimeout(() => el.classList.remove('is-new'), 380);
  }
  return el;
}
function stripEnd(text, tone) {
  if (!stripEl._end) stripEl._end = document.createElement('span');
  stripEl._end.className = 's-end';
  stripEl._end.dataset.tone = tone || '';
  if (stripEl._end.textContent !== text) stripEl._end.textContent = text;
  return stripEl._end;
}
function verificationNode(id, trace, order) {
  const on = isOn(id);
  const slots = id === 'tavily' ? tvKeyIdx() : [0];
  const dots = slots.map((slot) => {
    const saved = savedCheck(id, slot);
    const current = trace?.items.find((it) => it.id === id && (id !== 'tavily' || it.key === slot));
    const running = on && current?.tone === 'run';
    const tone = running ? 'run' : saved.tone;
    const what = saved.record?.source === 'search' ? '搜索' : '测试';
    const time = saved.record ? new Date(saved.record.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    const detail = running ? (trace.bg ? '搜索中' : '测试中')
      : tone === 'idle' ? '尚未验证'
      : `最近${what}${tone === 'ok' ? saved.record?.status === 'empty' ? '连通，但无结果' : '通过' : `失败（${failureInfo(saved.code).status}：${errText(saved.code)}）`}${time ? ' · ' + time : ''}`;
    return { tone, tip: (id === 'tavily' && slots.length > 1 ? `Key ${slot + 1}：` : '') + detail };
  });
  const passed = dots.filter((d) => d.tone === 'ok').length;
  const failed = dots.filter((d) => d.tone === 'err').length;
  const running = dots.some((d) => d.tone === 'run');
  const health = running ? 'run' : failed === dots.length ? 'err' : failed ? 'partial'
    : passed === dots.length ? 'ok' : passed ? 'partial' : 'idle';
  const role = id === 'grok' ? '主搜索' : `补充来源 · 第 ${order.indexOf(id) + 1} 位`;
  const state = !isSet(id) ? '未配置' : on ? '已启用' : '已关闭';
  return {
    id, role: id === 'grok' ? 'primary' : 'supp',
    st: on ? 'on' : isSet(id) ? 'off' : 'unset', health,
    dots: on ? dots : [],
    tip: `${META[id].name} · ${role} · ${state}\n${dots.map((d) => d.tip).join('\n')}\n圆点不表示优先级；静态亮点仅表示最近通过，脉动才表示检测中。`
  };
}
function stripModel(orderOverride, trace) {
  const st = routeStatus();
  if (!trace && ['off', 'wait', 'none'].includes(st)) return { hidden: true };
  if (!trace && st === 'load') {
    const bar = (w, h = 16) => `<span class="s-skel" style="width:${w}px;height:${h}px"></span>`;
    return { html: bar(16) + bar(14, 8) + bar(16) + bar(16) + bar(54, 9) };
  }
  const order = [...(orderOverride || S.order)];
  const supp = order.filter(isOn);
  const nodes = ['grok', ...supp].map((id) => verificationNode(id, trace, order));
  const between = [];
  for (let i = 1; i < nodes.length; i++) {
    between.push(nodes[i].health === 'err' ? 'broken'
      : i === 1 && !grokOn() ? 'dash'
      : nodes[i - 1].health === 'err' ? 'detour' : 'next');
  }
  const mode = trace ? (trace.bg ? '搜索验证' : '逐项测试') : '最近验证结果';
  let label = `${mode}；图标顺序表示补充链优先级，圆点区分未验证、检测中与最近完成的结果。${nodes.map((n) => n.tip.split('\n').slice(0, -1).join('；')).join('；')}`;
  if (trace?.reroute) label += '；已尝试静默回退到补充来源';
  if (st === 'err') label += '；全部来源不可用，明确报错，不回退官方搜索';
  const end = trace && trace.done ? { text: trace.done.text, tone: trace.done.tone === 'ok' ? 'ok' : 'err' } : null;
  if (trace && trace.done) label += `；${trace.done.text}`;
  return { nodes, between, label, end };
}
function renderSummary(orderOverride) {
  const m = stripModel(orderOverride, orderOverride ? null : S.trace);
  if (m.hidden) {
    hideStripTip();
    stripSlot.classList.remove('has');
    stripEl.removeAttribute('aria-label');
    stripEl.removeAttribute('title');
    stripEl.replaceChildren();
    stripSect = '';
    return;
  }
  stripSlot.classList.add('has');
  stripEl.setAttribute('aria-label', m.label || '搜索路由');
  stripEl.removeAttribute('title');
  if (m.html) {
    hideStripTip();
    if (stripSect !== 'load') { stripSect = 'load'; stripEl.innerHTML = m.html; }
    return;
  }
  const seq = [];
  m.nodes.forEach((n, i) => {
    if (i) seq.push(stripLink(m.between[i - 1] || 'next', i - 1));
    seq.push(stripNode(n));
  });
  if (m.end) seq.push(stripEnd(m.end.text, m.end.tone));
  const key = m.end ? 'end' : m.between.join(',');
  placeStrip(seq, key);
  if (stripTipTarget) showStripTip(stripTipTarget);
}
/* 参考 Magpie FAIL / failWord：状态码与错误分类分开。
   HTTP 状态码不能单独证明余额、Key 过期或具体供应商业务原因。 */
const ERR_TEXT = {
  400: '请求参数无效', 401: 'Key 验证失败', 402: '额度或计费受限', 403: '访问被拒绝',
  404: '接口不存在', 405: '接口方法不支持', 408: '请求超时', 413: '请求过大',
  422: '请求参数不被接受', 429: '限流或额度不足',
  500: '服务端错误', 502: '上游网关错误', 503: '服务暂不可用', 504: '网关超时'
};
const NETWORK_ERRORS = {
  TIMEOUT: ['超时', '请求超时'], ETIMEDOUT: ['超时', '请求超时'],
  NETWORK: ['网络', '连接失败'], ENOTFOUND: ['网络', '域名解析失败'],
  ECONNREFUSED: ['网络', '连接被拒绝'], ECONNRESET: ['网络', '连接中断'],
  CERT_HAS_EXPIRED: ['TLS', '证书已过期'],
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: ['TLS', '证书校验失败'],
  INVALID_RESPONSE: ['响应', '响应格式异常'], RESPONSE_TOO_LARGE: ['响应', '响应超过上限'],
  URL_INVALID: ['地址', '接口地址无效'],
  GROK_AUTH_ERROR: ['认证', 'Grok 认证失败'], GROK_TIMEOUT: ['超时', 'Grok 响应超时'],
  GROK_PARSE_ERROR: ['响应', 'Grok 响应无法解析'], GROK_PROVIDER_ERROR: ['接口', 'Grok 接口调用失败'],
  GROK_CONTENT_EMPTY: ['回答', '没有可核验回答'], GROK_SOURCES_EMPTY: ['来源', '没有可核验来源'],
  GROK_PROGRAM_MISSING: ['程序', 'Grok 尚未就绪'], GROK_PROGRAM_PREPARING: ['程序', 'Grok 正在准备'],
  GROK_CONFIG_INVALID: ['配置', 'Grok 配置无效'], GROK_TOOL_ERROR: ['搜索', 'Grok 搜索报告错误'],
  GROK_MCP_ERROR: ['MCP', 'Grok 初始化或搜索失败'], GROK_CHILD_EXIT: ['进程', 'Grok 意外退出'],
  GROK_PROCESS_ERROR: ['进程', '无法启动 Grok'], GROK_QUEUE_FULL: ['队列', '搜索队列已满'],
  GROK_SEARCH_STOPPING: ['停止', '插件正在停止'], GROK_SESSION_BUSY: ['队列', 'Grok 会话忙'],
  GROK_VERSION_UNVERIFIED: ['版本', 'Grok 版本未经验证'], GROK_PROTOCOL_UNVERIFIED: ['协议', 'Grok 协议未经验证'],
  GROK_PROGRAM_INVALID: ['程序', 'Grok 程序无效'], GROK_PROGRAM_START_FAILED: ['程序', 'Grok 无法启动'],
  GROK_PROGRAM_CHANGED: ['程序', 'Grok 程序已变化'], GROK_CACHE_DAMAGED: ['缓存', '程序缓存损坏'],
  GROK_PLATFORM_UNSUPPORTED: ['平台', '系统或架构不支持'], GROK_INSTALL_BUSY: ['安装', '程序正在安装'],
  GROK_PROGRAM_REAP_FAILED: ['回收', '程序回收未完成'], GROK_PROCESS_REAP_FAILED: ['回收', '进程回收未完成'],
  SETTINGS_UNAVAILABLE: ['连接', '设置服务不可用'], SOURCE_UNAVAILABLE: ['来源', '来源服务不可用'],
};
function failureInfo(code) {
  const value = normalizeCode(code).toUpperCase();
  const status = /^\d{3}$/.test(value) ? Number(value) : 0;
  if (status >= 400 && status <= 599) {
    return { status: value, text: ERR_TEXT[status] || (status >= 500 ? '服务端错误' : '请求被拒绝'), code: value };
  }
  const named = NETWORK_ERRORS[value];
  return named ? { status: named[0], text: named[1], code: value }
    : value.startsWith('GROK_DOWNLOAD_') ? { status: '下载', text: '程序下载或校验失败', code: value }
      : value.startsWith('GROK_ARCHIVE_') ? { status: '安装', text: '程序包校验失败', code: value }
        : value.startsWith('GROK_PROGRAM_') ? { status: '程序', text: 'Grok 程序准备失败', code: value }
    : { status: '异常', text: '请求失败', code: 'UNKNOWN' };
}
const errText = (code) => [...new Set(String(code || 'UNKNOWN').split('/').map((c) => failureInfo(c).text))].join('／');
function failureHelp(code) {
  const value = normalizeCode(String(code || '').split('/')[0]).toUpperCase();
  if (value === '401') return '检查 API Key 是否正确、已过期或被撤销。';
  if (value === '403') return '检查账号、模型或接口权限；403 本身不证明额度已用完。';
  if (value === '402') return '检查该服务的额度、套餐或计费状态。';
  if (value === '429') return '稍后重试，并检查该服务的限额或额度。';
  if (['404', '405'].includes(value)) return '核对 BaseURL 与接口路径。';
  if (['400', '413', '422'].includes(value)) return '核对模型与请求参数。';
  if (value === 'CERT_HAS_EXPIRED' || value === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return '核对 HTTPS 证书与代理设置，不要关闭证书校验。';
  if (['408', '504', 'TIMEOUT', 'ETIMEDOUT'].includes(value)) return '核对网络与超时设置，稍后重试。';
  if (value === 'GROK_AUTH_ERROR') return '检查 Grok Key 或原有登录凭据；上游未提供具体 HTTP 状态码。';
  if (['GROK_CONTENT_EMPTY', 'GROK_SOURCES_EMPTY', 'GROK_PARSE_ERROR'].includes(value)) return '核对模型与搜索能力；有 Key 不等于能返回可核验来源。';
  if (value === 'GROK_VERSION_UNVERIFIED') return '此版本尚未通过插件验证；不会擅自升级或覆盖已有安装。';
  if (value.startsWith('GROK_DOWNLOAD_') || value.startsWith('GROK_ARCHIVE_')) return '检查网络或程序缓存，在 Grok Search RS 设置中重新检测。';
  if (value.startsWith('GROK_PROGRAM_') || value.startsWith('GROK_PROCESS_')) return '检查程序状态，在 Grok Search RS 设置中重新检测；不会修改全局安装。';
  if (value.startsWith('GROK_')) return '核对 Grok 程序、Base URL 和模型；该错误不单独证明 Key 失效。';
  if (NETWORK_ERRORS[value]) return '核对 BaseURL、网络或代理设置。';
  if (Number(value) >= 500) return '上游服务异常，可稍后重试。';
  return '检查接口配置或服务端返回详情，不能仅凭此错误判断 Key 失效。';
}
function rowFault(id) {
  if (S.loading || !S.plugin || !isOn(id)) return null;
  if (id === 'grok' && S.program?.error && !S.bad.grok) {
    const info = failureInfo(S.program.error.code);
    return { ...info, tone: 'err', detail: `${info.status} · ${info.text}。${failureHelp(info.code)}` };
  }
  if (id === 'tavily' && S.providerBad.tavily && !S.bad.tavily) {
    const info = failureInfo(S.providerBad.tavily.code);
    return { ...info, tone: 'err', detail: `${info.status} · ${info.text}。最近搜索未获得 Tavily 结果；宿主未报告具体 Key，不能判断每个 Key 都失效。${failureHelp(info.code)}` };
  }
  const slots = id === 'tavily' ? tvKeyIdx() : [0];
  const faults = slots.flatMap((slot) => {
    const running = S.trace?.items.some((it) => it.id === id && (id !== 'tavily' || it.key === slot) && it.tone === 'run');
    const check = savedCheck(id, slot);
    return !running && check.tone === 'err' ? [{ slot, ...failureInfo(check.code) }] : [];
  });
  if (!faults.length) return null;
  const statuses = [...new Set(faults.map((f) => f.status))];
  const reasons = [...new Set(faults.map((f) => f.text))];
  const prefix = id === 'tavily' && slots.length > 1 && faults.length === 1 ? `Key ${faults[0].slot + 1} · ` : '';
  const status = prefix + (statuses.length <= 2 ? statuses.join('/') : `${statuses.slice(0, 2).join('/')} +${statuses.length - 2}`);
  const text = faults.length === 1 ? faults[0].text : `${faults.length} 个 Key ${reasons.length === 1 ? reasons[0] : '不可用'}`;
  const details = faults.map((f) => {
    const key = id === 'tavily' && slots.length > 1 ? `Key ${f.slot + 1}：` : '';
    return `${key}${f.status} · ${f.text}。${failureHelp(f.code)}`;
  });
  if (id === 'tavily' && faults.length < slots.length) {
    const verified = slots.some((slot) => savedCheck(id, slot).tone === 'ok');
    details.push(verified ? '其他 Key 已验证可用，此来源仍可使用。' : '仅这些 Key 已知失败，其他 Key 尚未全部验证。');
  }
  details.push('点击供应商名称打开配置。');
  return { status, text, tone: faults.length < slots.length ? 'partial' : 'err', detail: details.join('\n') };
}
function failList() {
  const parts = [];
  ['grok', ...enabledSupp()].forEach((id) => {
    if (!isOn(id) || !(S.bad[id] || S.providerBad[id])) return;
    if (id === 'tavily') {
      if (!S.bad.tavily) { parts.push(`Tavily 最近搜索返回 ${S.providerBad.tavily.code}（未定位具体 Key）`); return; }
      const n = tvKeyIdx().filter((i) => S.bad.tavily[i]).length;
      const all = n === tvKeyIdx().length;
      parts.push(`Tavily ${all && n > 1 ? `${n} 个 Key 均` : `${n} 个 Key`}返回 ${codeOf('tavily')}`);
    } else parts.push(`${META[id].name} 返回 ${codeOf(id)}`);
  });
  return parts;
}
let bannerHtml = null;
function renderBanner() {
  const slot = $('#bannerSlot');
  const st = routeStatus();
  let html = '';
  const B = (tone, ic, title, text, actions = '', iconOnly) => `<div class="banner" data-tone="${tone}"><span class="b-ic">${svg(ic)}</span><span class="b-body"><span class="b-title">${title}</span><span class="b-text">${text}</span></span><span class="b-actions${iconOnly ? ' is-icon' : ''}">${actions}</span></div>`;
  const btn = (act, label, primary) => `<button type="button" class="btn btn-sm${primary ? ' btn-primary' : ''}" data-act="${act}">${label}</button>`;
  const sv = servingSupp();
  if (st === 'down') {
    html = B('err', 'info', '设置服务暂不可用', esc(S.rpcError.message), btn('retry', '重试'));
  } else if (st === 'cfgerr') {
    html = B('err', 'info', '配置文件无法读取', `${esc(S.config.error.code || 'CONFIG_ERROR')} · ${esc(S.config.error.message)} 搜索会明确报错，不会回退官方搜索。`, btn('open-file', '打开文件'));
  } else if (st === 'ctlerr') {
    html = B('err', 'info', '接管状态异常', `${esc(S.control?.error?.code || S.control?.phase || 'CONTROL_ERROR')} · 尚未确认路由完成，请重试检查。`, btn('retry', '重试'));
  } else if (st === 'connecting') {
    html = B('info', 'info', '正在确认搜索接管', '此时不把配置记录当成路由完成；等待宿主实际就绪。');
  } else if (st === 'prep') {
    html = B('info', 'info', '正在准备 Grok 程序', `${esc(programPhase())}。可先填写配置；准备期间搜索会明确报错，不回退官方搜索。`);
  } else if (st === 'off') {
    html = B('info', 'info', '已恢复原搜索设置，无需重启', '配置已保留。请在插件页使用 dsh-grok-search 的原生开关重新启用。');
  } else if (st === 'fallback') {
    const observed = unknownFallback() ? 'Grok 内置补充链' : META[sv]?.name || '补充来源';
    const grokCode = codeOf('grok') || S.program?.error?.code;
    const rotates = sv && codeOf(sv).split('/').every((code) => TAVILY_ROTATE.has(code));
    const part = sv && isPart(sv) ? `；${META[sv].name} 有 Key 返回 ${codeOf(sv)}${rotates ? '，可换用其他 Key' : '，各 Key 的验证结果单独保留'}` : '';
    html = B('fallback', 'reroute', `Grok ${failureInfo(grokCode).status} · ${errText(grokCode)}，已静默回退到 ${observed}`,
      `搜索照常可用，结果来自补充来源${part}。修好 Grok 后自动切回，不会回退官方搜索。`,
      btn('open:grok', '检查 Grok 配置') + btn('grok-off', '关闭 Grok'));
  } else if (st === 'err') {
    const fails = failList();
    const first = ['grok', ...enabledSupp()].find((id) => isOn(id) && (S.bad[id] || S.providerBad[id]));
    const title = S.lastRoute?.outcome === 'failed' ? '主搜与补充来源未返回可用结果'
      : !grokOn() ? '补充来源全部不可用，搜索失败' : enabledSupp().length ? 'Grok 与补充来源全部不可用，搜索失败' : `Grok 返回 ${codeOf('grok')}：${errText(codeOf('grok'))}`;
    const text = `${fails.length > 1 || !grokOn() ? fails.join('；') + '。' : ''}本次搜索已明确报错，没有回退官方搜索。${grokOn() && !enabledSupp().length ? '配置任一补充来源后，Grok 失效时可静默回退。' : ''}`;
    html = B('err', 'errc', title, text, btn('open:' + (first || 'grok'), `检查 ${META[first || 'grok'].name} 配置`));
  } else if (st === 'wait') {
    html = B('warn', 'warn', '还差一步：填写一个搜索 Key', '推荐 Grok（带来源的回答）；只填 Tavily、Exa 等补充来源的 Key 也能搜索。未配置前搜索会明确报错，不会悄悄回退官方搜索。', btn('open:grok', '填写 Grok Key', true));
  } else if (st === 'none') {
    const act = isSet('grok') ? btn('grok-on', '启用 Grok', true) : btn('open:' + (SUPP.find((id) => isSet(id)) || 'grok'), '启用补充来源', true);
    html = B('warn', 'warn', 'Grok 与补充来源都已关闭', '现在搜索会明确报错。想恢复原搜索，请在插件页关闭 dsh-grok-search。', act);
  } else {
    const aux = enabledSupp().find((id) => isBad(id) || isPart(id));
    const auxKey = aux ? `${aux}:${codeOf(aux)}:${isBad(aux)}` : '';
    if (aux && S.auxDismissed !== auxKey) {
      const rotates = codeOf(aux).split('/').every((code) => TAVILY_ROTATE.has(code));
      const title = isBad(aux) ? `${META[aux].name} 最近检查失败 · ${codeOf(aux)}` : `${META[aux].name} 部分 Key 返回 ${codeOf(aux)}${rotates ? '，其他 Key 可用' : ''}`;
      html = B('soft', 'warn', title, `${errText(codeOf(aux))}。其余来源照常工作，搜索不受影响。`,
        btn('open:' + aux, `检查 ${META[aux].name}`) + `<button type="button" class="icon-btn" data-act="dismiss-aux" data-k="${auxKey}" aria-label="关闭提示">${svg('x')}</button>`);
    } else if (!S.capabilities?.secretsAllowed) {
      html = B('info', 'lock', '当前连接仅显示脱敏配置', `${esc(S.capabilities?.reason || '请在已认证的本机直连或 HTTPS 连接下查看和保存 Key。')} 仍可在服务器端执行连通性测试。`);
    } else if (S.readBanner && !S.readDismissed) {
      const found = ['grok', ...S.order, 'github'].filter((id) => isSet(id));
      html = B('info', 'ok', '已读取现有配置，无需重新填写', `来自 <code style="font:500 11.5px var(--mono)">${esc(configLocation().label)}</code>：<span class="chip-list">${found.map((id) => `<span class="mini-chip">${tile(id, 14)}${META[id].name}</span>`).join('')}</span>`,
        `<button type="button" class="icon-btn" data-act="dismiss-read" aria-label="关闭提示">${svg('x')}</button>`, true);
    }
  }
  if (html === bannerHtml) return;
  const had = !!bannerHtml;
  bannerHtml = html;
  if (html) {
    slot.innerHTML = `<div><div class="${had && !reduced() ? 'b-swap' : ''}">${html}</div></div>`;
    slot.classList.add('has');
  } else {
    slot.classList.remove('has');
    setTimeout(() => { if (!bannerHtml) slot.innerHTML = ''; }, 340);
  }
  pumpWires(380);
}
function renderFoot() {
  const config = configLocation();
  $('#cfgPath').textContent = config.label;
  $('#cfgPath').title = config.full;
  const tag = $('#cfgTag');
  if (S.cfgExists) { tag.textContent = 'Grok 共享配置'; tag.dataset.tone = 'agent'; tag.title = '保存后写入此 Grok 配置文件。其他使用同一文件的应用也会读取这些设置；使用独立配置的应用不受影响。'; }
  else { tag.textContent = '首次保存时创建'; tag.dataset.tone = 'warn'; tag.removeAttribute('title'); }
  const fb = $('[data-open=file]');
  fb.disabled = !S.cfgExists;
  fb.title = S.cfgExists ? '' : '文件尚未创建，首次保存后可打开';
}
function syncAll(keepTrace) {
  if (!keepTrace && !S.testing && S.trace) { S.trace = null; clearTimeout(S.traceTimer); }
  renderHead(); renderSummary(); renderBanner(); renderFoot(); syncRows(); pumpWires();
}

/* ---------- toast ---------- */
let toastTimer = 0;
function clearToasts() {
  clearTimeout(toastTimer);
  $('#toasts').replaceChildren();
}
function toast(text, opt = {}) {
  const box = $('#toasts');
  clearTimeout(toastTimer);
  const tone = opt.tone || 'ok';
  const icon = { ok: 'ok', err: 'errc', warn: 'warn', info: 'info' }[tone];
  const el = document.createElement('div');
  const action = opt.undo ? { label: '撤销', icon: 'undo', run: opt.undo } : opt.action;
  el.className = 'toast' + (action ? '' : ' no-act');
  el.dataset.tone = tone;
  el.innerHTML = `<span class="t-ic">${svg(icon)}</span><span class="t-text">${esc(text)}</span>${action ? `<button type="button" class="t-act">${svg(action.icon || 'copy', 'ic ic-sm')}${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('.t-act').addEventListener('click', () => {
    dismissToast(el);
    Promise.resolve().then(() => action.run()).catch(error => operationError(error));
  });
  box.replaceChildren(el);
  toastTimer = setTimeout(() => dismissToast(el), opt.ms || (action ? 5200 : 3200));
}
function dismissToast(el) {
  if (!el.isConnected || el.classList.contains('is-out')) return;
  el.classList.add('is-out');
  setTimeout(() => el.remove(), 180);
}
function shake(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  el.addEventListener('animationend', function h(e) { if (e.animationName === 'shake') { el.classList.remove('shake'); el.removeEventListener('animationend', h); } });
}
function bump(el) {
  if (!el) return;
  el.classList.remove('tick');
  void el.offsetWidth;
  el.classList.add('tick');
  setTimeout(() => el.classList.remove('tick'), 720);
}
const rowOf = (id) => $(`.row[data-id="${id}"]`);

/* ---------- 插件总开关：热重载语义，当场生效 ---------- */
function cancelTest() {
  const running = S.testing;
  gen++;
  const operationId = S.diagnosticOperation;
  S.diagnosticOperation = null;
  if (operationId) void remote.cancelDiagnosis({ operationId }).catch(error => {
    if (!disposed) operationError(Object.assign(new Error('取消请求未确认，已发出的请求仍可能消耗额度。'), { code: 'SETTINGS_CANCEL_UNCONFIRMED' }));
  });
  S.testing = false;
  S.bgRun = false;
  S.trace = null;
  S.lastRoute = null;
  S.marks = {};
  clearTimeout(S.traceTimer);
  hideStripTip();
  clearLit();
  clearToasts();
  if (running) $('#announcer').textContent = '路由已改变，本次测试已取消。可按新配置重新测试。';
}
function cancelOwnedDiagnosis() {
  const operationId = S.diagnosticOperation;
  S.diagnosticOperation = null;
  // The UI is leaving; there is nowhere to render a failure. Cancellation is
  // still dispatched, while the gateway disposer also aborts its own requests.
  if (operationId) void remote.cancelDiagnosis({ operationId }).catch(() => {});
}
/* ---------- 行交互：点击打开配置卡，开关只管启用 ---------- */
let suppressClick = false;
const colList = $('#colList');
colList.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row || S.loading || S.busy) return;
  if (suppressClick) { e.preventDefault(); e.stopPropagation(); return; }
  const id = row.dataset.id;
  if (e.target.closest('.switch')) onRowSwitch(id, row);
  else if (e.target.closest('.row-main')) openCard(id, { from: row.querySelector('.row-main') });
});
async function onRowSwitch(id, row) {
  if (S.busy || disposed) return;
  const sw = row.querySelector('.switch');
  if (!isSet(id)) { openCard(id, { from: sw, enable: true }); return; }
  const prev = S.prov[id].enabled !== false, on = !prev;
  cancelTest();
  S.busy = true;
  S.prov[id].enabled = on;
  syncAll(true);
  const persist = async value => {
    if (id === 'grok' || id === 'github') await savePreference(id, value);
    else await saveConfig(fields => sourceChain.plan(fields, { kind: 'toggle', id, on: value }));
  };
  try {
    await persist(on);
    if (disposed) return;
    const text = id === 'grok' ? on ? '已启用 Grok 主搜索 · 当场生效'
      : '已关闭 Grok · 搜索直接走补充来源 · 仅对 DSH 生效'
      : id === 'github' ? `${on ? '已开启' : '已关闭'} DSH 测试时的 GitHub 检测 · Token 未更改`
        : `已${on ? '启用' : '停用'} ${META[id].name} · 已写入 Grok 共享配置`;
    toast(text, { tone: 'info', undo: async () => {
      if (disposed || S.busy) return;
      S.busy = true;
      try { await persist(prev); if (!disposed) { syncAll(false); toast('已撤销开关修改'); } }
      catch (error) { operationError(error); }
      finally { S.busy = false; if (!disposed) syncAll(true); }
    } });
  } catch (error) {
    S.prov[id].enabled = prev;
    await refresh({ force: true });
    operationError(error);
  } finally {
    S.busy = false;
    if (!disposed) { syncAll(true); pumpWires(420); }
  }
}
colList.addEventListener('pointerover', (e) => {
  const row = e.target.closest('.row');
  $$('.wg.hl', wiresEl).forEach((g) => g.classList.remove('hl'));
  if (row && !drag) wireNodes.get('hub-' + row.dataset.id)?.classList.add('hl');
});
colList.addEventListener('pointerleave', () => $$('.wg.hl', wiresEl).forEach((g) => g.classList.remove('hl')));

/* ---------- 拖拽排序（补充来源） ---------- */
let drag = null;
let pinnedHintShown = false;
colList.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || S.loading || S.busy || drag) return;
  const row = e.target.closest('.row');
  if (!row || e.target.closest('.switch')) return;
  if (row.dataset.drag === 'true' && chain().orderLocked) return;
  drag = { row, id: row.dataset.id, x0: e.clientX, y0: e.clientY, pid: e.pointerId, active: false, movable: row.dataset.drag === 'true', warned: false };
  drag.off = [listen(window, 'pointermove', onDragMove, { passive: false }), listen(window, 'pointerup', onDragEnd), listen(window, 'pointercancel', onDragEnd)];
});
function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const dy = e.clientY - drag.y0;
  const dist = Math.hypot(e.clientX - drag.x0, dy);
  if (!drag.movable) {
    if (dist > 12 && !drag.warned) {
      drag.warned = true;
      suppressClick = true;
      shake(drag.row);
      if (!pinnedHintShown) { pinnedHintShown = true; toast(drag.id === 'grok' ? 'Grok 固定为主搜索，不参与排序' : 'GitHub 是专用抽取，按链接自动触发，不参与排序', { tone: 'info' }); }
    }
    return;
  }
  if (!drag.active) {
    if (dist < 4) return;
    startDrag();
  }
  e.preventDefault();
  const d = drag;
  let off = dy;
  const lo = d.slots[0] - d.slots[d.from];
  const hi = d.slots[d.n - 1] - d.slots[d.from];
  if (off < lo) off = lo - rubber(lo - off);
  if (off > hi) off = hi + rubber(off - hi);
  d.row.style.transform = `translateY(${off}px) scale(1.02)`;
  const to = nearestSlot(d.slots[d.from] + off + d.h / 2, d);
  if (to !== d.to) {
    d.to = to;
    d.rows.forEach((r, i) => {
      if (r === d.row) return;
      let shift = 0;
      if (d.from < to && i > d.from && i <= to) shift = -d.step;
      if (d.from > to && i < d.from && i >= to) shift = d.step;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
    d.ghost.style.transform = `translateY(${d.slots[to] - d.slots[d.from]}px)`;
    renderSummary(previewOrder(d));
  }
}
const rubber = (x) => 18 * (1 - Math.exp(-x / 60));
function nearestSlot(center, d) {
  let best = 0, bd = Infinity;
  d.slots.forEach((s, i) => { const c = s + d.h / 2; const dd = Math.abs(c - center); if (dd < bd) { bd = dd; best = i; } });
  return best;
}
function startDrag() {
  const d = drag;
  const wrap = $('#rowsSupp');
  d.rows = $$('.row', wrap);
  d.n = d.rows.length;
  d.from = d.rows.indexOf(d.row);
  d.to = d.from;
  const wr = wrap.getBoundingClientRect();
  d.slots = d.rows.map((r) => r.getBoundingClientRect().top - wr.top);
  d.h = d.row.offsetHeight;
  d.step = d.n > 1 ? d.slots[1] - d.slots[0] : d.h + 6;
  d.ghost = document.createElement('div');
  d.ghost.className = 'drop-ghost';
  d.ghost.style.top = d.slots[d.from] + 'px';
  d.ghost.style.height = d.h + 'px';
  wrap.prepend(d.ghost);
  wrap.classList.add('is-sorting');
  d.row.classList.add('is-dragging');
  d.row.style.transition = 'box-shadow .2s, border-color .2s';
  root.classList.add('is-grabbing');
  $$('.wg.hl', wiresEl).forEach((g) => g.classList.remove('hl'));
  d.active = true;
  suppressClick = true;
  try { d.row.setPointerCapture(d.pid); } catch (_) { /* 指针已释放 */ }
  const loop = () => { if (!drag || !drag.active) return; drawWires(); drag.raf = requestAnimationFrame(loop); };
  d.raf = requestAnimationFrame(loop);
}
function previewOrder(d) {
  const ids = d.rows.map((r) => r.dataset.id);
  const [m] = ids.splice(d.from, 1);
  ids.splice(d.to, 0, m);
  return ids;
}
function onDragEnd(e) {
  if (!drag || (e && e.pointerId !== drag.pid)) return;
  const d = drag;
  d.off.forEach(off => off());
  drag = null;
  setTimeout(() => { suppressClick = false; }, 0);
  if (!d.active) return;
  cancelAnimationFrame(d.raf);
  root.classList.remove('is-grabbing');
  const wrap = $('#rowsSupp');
  const cancelled = S.loading || (e && e.type === 'pointercancel');
  const ids = cancelled ? d.rows.map((r) => r.dataset.id) : previewOrder(d);
  d.ghost.remove();
  flipTo(ids, () => {
    wrap.classList.remove('is-sorting');
    d.row.classList.remove('is-dragging');
    d.row.style.transition = '';
  });
  if (!cancelled && ids.join() !== S.order.join()) commitOrder(ids, S.order.slice());
  else renderSummary();
}
function cancelDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.off.forEach(off => off());
  cancelAnimationFrame(d.raf);
  if (d.row.hasPointerCapture?.(d.pid)) d.row.releasePointerCapture(d.pid);
  d.ghost?.remove();
  (d.rows || [d.row]).forEach((row) => {
    row.style.transition = '';
    row.style.transform = '';
    row.classList.remove('is-dragging');
  });
  $('#rowsSupp').classList.remove('is-sorting');
  root.classList.remove('is-grabbing');
  suppressClick = false;
}
/* FLIP：按 ids 重排 DOM，并从当前视觉位置平滑过渡到新位置 */
function flipTo(ids, done) {
  const wrap = $('#rowsSupp');
  const rows = $$('.row', wrap);
  const first = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
  const focused = active();
  rows.forEach((r) => { r.style.transition = 'none'; r.style.transform = ''; });
  ids.forEach((id) => wrap.appendChild(wrap.querySelector(`.row[data-id="${id}"]`)));
  if (focused && wrap.contains(focused)) focused.focus({ preventScroll: true });
  rows.forEach((r) => {
    const dy = first.get(r) - r.getBoundingClientRect().top;
    r.style.transform = dy ? `translateY(${dy}px)` : '';
  });
  void wrap.offsetWidth;
  rows.forEach((r) => {
    r.style.transition = reduced() ? 'none' : 'transform .32s cubic-bezier(.2,.7,.2,1), box-shadow .2s, border-color .2s';
    r.style.transform = '';
  });
  pumpWires(380);
  setTimeout(() => { rows.forEach((r) => { r.style.transition = ''; }); done && done(); }, reduced() ? 0 : 340);
}
async function commitOrder(ids, prev) {
  if (S.busy || disposed) return;
  cancelTest();
  S.busy = true;
  S.order = ids.slice();
  syncAll(true);
  pumpWires(380);
  try {
    await saveConfig(fields => sourceChain.plan(fields, { kind: 'order', order: ids }));
    if (disposed) return;
    toast(`已按 ${ids.map(id => META[id].name).join(' › ')} 写入 Grok 共享配置`, {
      undo: () => commitOrder(prev, ids),
    });
  } catch (error) {
    S.order = prev.slice(); flipTo(prev);
    await refresh({ force: true });
    operationError(error);
  } finally { S.busy = false; if (!disposed) syncAll(true); }
}
colList.addEventListener('keydown', (e) => {
  const main = e.target.closest('.row-main');
  if (S.loading || S.busy || !main || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const row = main.closest('.row');
  const id = row.dataset.id;
  if (row.dataset.drag === 'true' && chain().orderLocked) {
    toast('搜索顺序由环境变量控制，不能在此排序。', { tone: 'info' }); return;
  }
  if (row.dataset.drag !== 'true') { shake(row); toast(id === 'grok' ? 'Grok 固定为主搜索，不参与排序；可用开关关闭' : 'GitHub 是专用抽取，不参与排序', { tone: 'info' }); return; }
  const i = S.order.indexOf(id);
  const j = i + (e.key === 'ArrowUp' ? -1 : 1);
  if (j < 0 || j >= S.order.length) { shake(row); return; }
  const prev = S.order.slice();
  const ids = S.order.slice();
  ids.splice(i, 1); ids.splice(j, 0, id);
  flipTo(ids);
  commitOrder(ids, prev);
});

/* ---------- 弹窗基础 ---------- */
const overlay = $('#overlay');
const dlg = $('#dialog');
const testPop = $('#testPop');
let D = null;
let closeTimer = 0;
let gen = 0;
const dialogBusy = () => !!D && (D.saving || D.clearing);
function resetClearConfirmation() {
  if (!D) return;
  clearTimeout(D.clearTimer);
  D.clearTimer = 0;
  D.clearArmed = false;
  const button = $('[data-a=clear]', dlg);
  if (button) {
    button.classList.remove('is-confirm');
    button.textContent = '清除配置';
  }
}
function lockDialog() {
  $$('button, input', dlg).forEach((el) => { el.disabled = true; });
}
function showOverlay() {
  hideStripTip();
  clearTimeout(closeTimer);
  overlay.classList.remove('is-closing');
  if (overlay.hidden) {
    clearToasts();
    overlay.hidden = false;
    dlg.classList.remove('is-in');
    const done = () => dlg.classList.add('is-in');
    dlg.addEventListener('animationend', function h(e) { if (e.target === dlg && e.animationName === 'dlg-in') { done(); dlg.removeEventListener('animationend', h); } });
    setTimeout(done, 300);
  }
}
function hideOverlay(cb) {
  overlay.classList.add('is-closing');
  closeTimer = setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove('is-closing');
    dlg.innerHTML = '';
    if (cb) cb();
  }, reduced() ? 0 : 150);
}
function closeDialog(force) {
  if (!D) return;
  if (dialogBusy() && !force) return;
  if (!force && isDirty() && !D.warned) {
    D.warned = true;
    shake(dlg);
    const fn = $('.foot-note', dlg);
    if (fn) fn.innerHTML = '<b>有未保存的修改</b> · 再按一次 Esc 或点空白处放弃修改';
    return;
  }
  const back = D.returnFocus;
  const id = D.id;
  clearTimeout(D.clearTimer);
  D = null;
  hideOverlay(() => {
    const target = back && back.isConnected ? back : (id ? rowOf(id)?.querySelector('.row-main') : null);
    if (target) target.focus({ preventScroll: true });
  });
}
overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeDialog(false); });
listen(document, 'keydown', (e) => {
  if (!overlay.hidden && D) {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(false); return; }
    if (e.key === 'Tab') { trapTab(e); return; }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      const t = targetOf(e);
      if (t.matches && t.matches('input[data-k]:not([type=checkbox]):not([readonly])')) { e.preventDefault(); save(); }
    }
    return;
  }
  if (e.key === 'Escape' && !testPop.hidden) closePop(true);
});
function focusables() {
  return $$('button, [href], input, [tabindex]:not([tabindex="-1"])', dlg).filter((el) => !el.disabled && !el.closest('[inert]') && el.getClientRects().length);
}
function trapTab(e) {
  const f = focusables();
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0];
  const last = f[f.length - 1];
  if (!dlg.contains(active())) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && active() === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active() === last) { e.preventDefault(); first.focus(); }
}
function initialFocus() {
  if (!D) return;
  let el = null;
  if (D.kind === 'card') {
    const kk = { grok: D.draft.mode === 'compat' ? 'gwKey' : 'key', tavily: 'keys.0', github: 'token' }[D.id] || 'key';
    const ki = dlg.querySelector(`input[data-k="${kk}"]`);
    if (ki && !ki.value && !ki.dataset.hidden && !ki.readOnly) el = ki;
  }
  if (!el) el = dlg.querySelector('[data-a=close]');
  if (el) el.focus({ preventScroll: true });
}

/* ---------- 表单片段 ---------- */
const fid = (k) => 'f-' + k.replace(/\./g, '-');
function field({ label, hint, k, msg, ctl, help }) {
  const tag = k ? 'label' : 'span';
  const slot = msg || k;
  const lab = `<${tag} class="f-label"${k ? ` for="${fid(k)}"` : ''}>${label}${k && fieldReadOnly(k) ? `<small>${svg('lock', 'ic ic-sm')}只读</small>` : hint ? `<small>${hint}</small>` : ''}</${tag}>`;
  const msgEl = slot ? `<p class="f-msg" id="${fid(slot)}-message" data-msg="${slot}" aria-live="polite" hidden></p>` : '';
  const helpEl = help ? `<p class="f-help"${slot ? ` id="${fid(slot)}-help"` : ''}>${help}</p>` : '';
  return `<div class="field">${lab}<div class="f-ctl">${ctl}${msgEl}${helpEl}</div></div>`;
}
function txt(k, v, ph, o = {}) {
  const readOnly = o.ro || fieldReadOnly(k);
  const extra = (readOnly ? ' readonly' : '') + (o.im ? ` inputmode="${o.im}"` : '');
  return `<div class="input${readOnly ? ' is-readonly' : ''}"><input id="${fid(k)}" type="text" class="mono" data-k="${k}" value="${esc(v)}" placeholder="${esc(ph || '')}" spellcheck="false" autocomplete="off"${extra}></div>`;
}
function fieldReadOnly(k) {
  if (!D) return false;
  if (D.kind === 'hub') return ['budget', 'exeOverride', 'cfgOverride'].includes(k)
    || D.fields?.[HUB_FIELDS[k]]?.readOnly === true;
  const key = CARD_FIELDS[D.id]?.[k.startsWith('keys.') ? 'keys' : k];
  if (!key) return k === 'ghApi';
  const secret = ['key', 'gwKey', 'token', 'keys'].includes(k.split('.')[0]);
  return D.fields?.[key]?.readOnly === true || D.id === 'grok' && D.base.authReadOnly
    || secret && !S.capabilities?.secretsAllowed;
}
function keyIn(k, v, ph, o = {}) {
  const shown = !!D.show[k];
  const unavailable = !S.capabilities?.secretsAllowed || D.id === 'grok' && D.base.authReadOnly;
  const ro = fieldReadOnly(k), isHidden = hidden(v);
  const eye = `<button type="button" class="icon-btn" data-a="eye" data-k="${k}" aria-label="${shown ? '隐藏' : '显示'}密钥" aria-pressed="${shown}"${unavailable ? ' disabled' : ''}>${svg(shown ? 'eyeOff' : 'eye')}</button>`;
  const cp = `<button type="button" class="icon-btn" data-a="copy" data-k="${k}" aria-label="复制密钥"${unavailable ? ' disabled' : ''}>${svg('copy')}</button>`;
  const del = o.del ? `<button type="button" class="icon-btn" data-a="del-key" data-i="${o.i}" aria-label="删除这个 Key"${ro ? ' disabled' : ''}>${svg('trash')}</button>` : '';
  const aria = o.aria ? ` aria-label="${o.aria}"` : '';
  return `<div class="input${ro ? ' is-readonly' : ''}"><input id="${fid(k)}" type="${shown ? 'text' : 'password'}" class="mono" data-k="${k}" value="${isHidden ? '' : esc(v)}" placeholder="${isHidden ? '已配置 · 点击查看或编辑' : esc(ph || '')}" spellcheck="false" autocomplete="off"${aria}${isHidden ? ' data-hidden="true" readonly' : ro ? ' readonly' : ''}><span class="in-act">${eye}${cp}${del}</span></div>`;
}
function chip(k, v, label, cur) {
  return `<button type="button" class="chip" data-a="pick" data-k="${k}" data-v="${esc(v)}" aria-pressed="${(cur || '').trim() === v}"${fieldReadOnly(k) ? ' disabled' : ''}>${esc(label)}</button>`;
}
function chk(k, on, title, sub) {
  const ro = fieldReadOnly(k);
  return `<label class="check${ro ? ' is-disabled' : ''}"><input type="checkbox" data-k="${k}"${on ? ' checked' : ''}${ro ? ' disabled' : ''}><span class="box">${svg('check')}</span><span class="c-text">${title}<small>${sub}</small></span></label>`;
}
const note = (t) => `<div class="note">${svg('info', 'ic ic-sm')}<span>${t}</span></div>`;
const EXT = (t) => `${t}${svg('ext', 'ic ic-sm')}`;
const subText = (id) => (META[id].group === 'supp' ? `${META[id].sub} · 补充来源第 ${S.order.indexOf(id) + 1} 位` : META[id].sub);
const KEEP_URL = '留空使用官方地址。';
const GROK_NOTE = note('关闭右上角开关后，搜索直接由补充来源返回；Grok 失效时也会静默回退到补充来源，全部不可用才报错，不会回退官方搜索。这个开关只对 DSH 生效，不写入 config.toml。');
const credKey = (id, p = S.prov[id]) => (id === 'grok' ? (p.mode === 'compat' ? 'gwKey' : 'key') : id === 'github' ? 'token' : 'key');
const CRED = { grok: ['mode', 'url', 'key', 'model', 'gwUrl', 'gwKey', 'gwModel', 'web', 'x'], tavily: ['url', 'keys'], exa: ['url', 'key'], tinyfish: ['searchUrl', 'fetchUrl', 'key'], firecrawl: ['url', 'key'], github: ['token'] };
/* 弹窗里的“最近一次结果”提示：跟随 Key 的值，改动该 Key 后自动消失 */
function healthOf(id) {
  const v = S.bad[id];
  if (!v) return [];
  const base = D?.id === id ? D.base : S.prov[id];
  if (id === 'tavily') return Object.entries(v).map(([i, code]) => ({ val: (base.keys[i] || '').trim(), code })).filter((x) => x.val);
  const k = credKey(id, base);
  return [{ k, val: (base[k] || '').trim(), code: v }];
}
function healthMsg(id, code) {
  const base = `最近一次检查：${failureInfo(code).status} · ${errText(code)}。${failureHelp(code)}`;
  if (id === 'grok') return base + (grokOn() && servingSupp() ? '；搜索已静默回退到补充来源' : '');
  if (id === 'tavily') return base + (!TAVILY_ROTATE.has(code) ? '；正常搜索遇到此错误不会换 Key，逐项测试仍独立检查其他 Key' : isBad('tavily') ? '' : '；已自动换用下一个 Key');
  return base + '；已自动跳过';
}

const FIELDS = {
  grok(p) {
    const compat = p.mode === 'compat';
    const protocolLocked = D.base.authReadOnly || D.fields.grok_api_key?.readOnly || !S.capabilities?.secretsAllowed;
    const seg = `<div class="seg" role="radiogroup" aria-label="接口协议"><button type="button" role="radio" data-a="mode" data-v="responses" aria-checked="${!compat}"${protocolLocked ? ' disabled' : ''}>xAI Responses</button><button type="button" role="radio" data-a="mode" data-v="compat" aria-checked="${compat}"${protocolLocked ? ' disabled' : ''}>OpenAI 兼容网关</button></div>`;
    const segHelp = compat
      ? '通过兼容 Chat Completions 的网关调用 Grok。切换时原 xAI Key 会从配置删除并备份到配置历史；切回需重新填入或恢复历史。此模式不支持 X 搜索。'
      : p.authReadOnly ? '正在复用原有登录认证，认证配置在此只读。'
        : '直连 xAI 官方接口，支持网页搜索与 X 搜索。';
    let h = field({ label: '接口协议', ctl: seg, help: segHelp });
    if (compat) {
      h += field({ label: '网关地址', k: 'gwUrl', ctl: txt('gwUrl', p.gwUrl, 'https://your-gateway/v1', { im: 'url' }) });
      h += field({ label: '网关 Key', k: 'gwKey', ctl: keyIn('gwKey', p.gwKey, 'sk-...') });
      h += field({ label: '模型', hint: '可选', k: 'gwModel', ctl: txt('gwModel', p.gwModel, '例如 grok-4.3-fast') });
      return h + GROK_NOTE;
    }
    h += field({ label: 'Base URL', k: 'url', ctl: txt('url', p.url, DEF.grokUrl, { im: 'url' }), help: '可填根地址、/v1 或完整端点，会自动规范到 /v1。' + KEEP_URL });
    h += field({ label: 'API Key', k: 'key', ctl: keyIn('key', p.key, 'xai-...') });
    const chips = `<div class="chips">${chip('model', '', '默认', p.model)}${chip('model', 'grok-4.3', 'grok-4.3', p.model)}</div>`;
    h += field({ label: '模型', k: 'model', ctl: txt('model', p.model, `默认 ${DEF.grokModel}`) + chips });
    const checks = `<div class="checks">${chk('web', p.web, '网页搜索', '让 Grok 联网检索网页并给出来源')}${chk('x', p.x, 'X 搜索', '同时检索 X（Twitter）上的帖子')}</div>`;
    h += field({ label: '搜索能力', msg: 'web', ctl: checks });
    return h + GROK_NOTE;
  },
  tavily(p) {
    const keys = p.keys.length ? p.keys : [''];
    const rows = keys.map((v, i) => `<div class="key-row">${keyIn('keys.' + i, v, 'tvly-...', { del: keys.length > 1, i, aria: `Tavily Key ${i + 1}` })}</div>`).join('');
    const add = `<button type="button" class="add-key" data-a="add-key"${fieldReadOnly('keys') ? ' disabled' : ''}>${svg('plus', 'ic ic-sm')}添加另一个 Key</button>`;
    return field({ label: 'Base URL', k: 'url', ctl: txt('url', p.url, DEF.tavilyUrl, { im: 'url' }), help: KEEP_URL })
      + field({ label: 'API Key', hint: '可填多个', msg: 'keys', ctl: `<div class="keylist">${rows}</div>${add}`, help: '多个 Key 按请求轮换；遇到 401、403、429、432、433 会自动换下一个。' });
  },
  exa(p) {
    return field({ label: 'Base URL', k: 'url', ctl: txt('url', p.url, DEF.exaUrl, { im: 'url' }), help: KEEP_URL })
      + field({ label: 'API Key', k: 'key', ctl: keyIn('key', p.key, 'Exa API Key'), help: '语义搜索，按请求计费。' });
  },
  tinyfish(p) {
    return field({ label: '搜索地址', k: 'searchUrl', ctl: txt('searchUrl', p.searchUrl, DEF.tfSearch, { im: 'url' }) })
      + field({ label: '抓取地址', k: 'fetchUrl', ctl: txt('fetchUrl', p.fetchUrl, DEF.tfFetch, { im: 'url' }), help: '两个地址都可留空，使用官方地址。' })
      + field({ label: 'API Key', k: 'key', ctl: keyIn('key', p.key, 'tf-...'), help: '一个 Key 同时用于搜索和抓取。免费使用，免费版限速 30 次/分钟；账号需开通 Search API。' });
  },
  firecrawl(p) {
    return field({ label: 'Base URL', k: 'url', ctl: txt('url', p.url, DEF.fcUrl, { im: 'url' }), help: '默认走 /v2；显式写 /v1 会保留。' + KEEP_URL })
      + field({ label: 'API Key', k: 'key', ctl: keyIn('key', p.key, 'fc-...'), help: '带域名或时间过滤的搜索会跳过 Firecrawl。' });
  },
  github(p) {
    return field({ label: 'API 地址', k: 'ghApi', ctl: txt('ghApi', DEF.ghApi, '', { ro: true }), help: '固定为 GitHub 官方接口，不可修改。' })
      + field({ label: 'Token', k: 'token', ctl: keyIn('token', p.token, 'ghp_... 或 github_pat_...'), help: '匿名约 60 次/小时；填写 Token 可提高限额，并能读取 Token 有权限的私有仓库。' })
      + note('GitHub、StackExchange、arXiv、Wikipedia 的链接由 Grok 的专用抽取器解析，不参与补充搜索排序。右上角开关只控制 DSH 测试时是否检测 GitHub，不改 Token，也不影响其他客户端。');
  }
};

/* ---------- 校验：硬错误挡保存，软提示只提醒 ---------- */
function vCard(id, p) {
  const err = {};
  const warn = {};
  const on = p.enabled !== false;
  // 从未配置过的来源可以先只存地址；已配置过的来源才要求凭据完整。
  const need = on && isSet(id, D?.base || S.prov[id]);
  const url = (k, v) => {
    const t = (v || '').trim();
    if (!t) return;
    try {
      const parsed = new URL(t);
      if (!/^https?:\/\//i.test(t) || /\s/.test(t) || !['http:', 'https:'].includes(parsed.protocol)
        || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError('Invalid HTTP URL');
      if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
        err[k] = '远程服务地址必须使用 HTTPS，本机地址才可使用 HTTP';
      }
    } catch (_) {
      err[k] = '请填写以 http:// 或 https:// 开头的完整地址';
    }
  };
  const key = (k, v, need, pre, preMsg) => {
    const t = (v || '').trim();
    if (hidden(t)) return;
    if (!t) { if (need) err[k] = need; return; }
    if (/\s/.test(t)) { err[k] = 'Key 中间不能有空格或换行，请检查是否粘贴完整'; return; }
    if (pre && !pre.some((x) => t.startsWith(x))) warn[k] = preMsg;
  };
  if (id === 'grok') {
    if (p.mode === 'compat') {
      url('gwUrl', p.gwUrl);
      const half = on && !!p.gwUrl.trim() !== !!p.gwKey.trim();
      if ((need || half) && !p.gwUrl.trim()) err.gwUrl = '兼容模式需要网关地址';
      key('gwKey', p.gwKey, need || half ? '兼容模式需要网关 Key' : '');
    } else {
      url('url', p.url);
      let host = '';
      try { host = new URL(p.url.trim() || DEF.grokUrl).host; } catch (_) { host = ''; }
      key('key', p.key, need ? '启用 Grok 需要 API Key；只用补充来源时可关闭右上角开关' : '', host === 'api.x.ai' ? ['xai-'] : null, 'xAI 的 Key 通常以 xai- 开头，请确认没有填错');
      if (!p.web) warn.web = p.x
        ? '网页搜索已关闭；X 搜索仍开启，Grok 仍会检索 X 上的内容'
        : '网页与 X 搜索均已关闭；Grok 可能因缺少引用而使用补充来源';
    }
  } else if (id === 'tavily') {
    url('url', p.url);
    const ks = p.keys.map((k) => k.trim());
    if (need && !ks.some(Boolean)) err['keys.0'] = '启用 Tavily 需要至少一个 API Key';
    const seen = new Set();
    ks.forEach((v, i) => {
      if (!v) return;
      if (/\s/.test(v)) err['keys.' + i] = 'Key 中间不能有空格或换行';
      else if (seen.has(v)) warn['keys.' + i] = `第 ${i + 1} 个 Key 与前面的重复`;
      else if (!v.startsWith('tvly-')) warn['keys.' + i] = 'Tavily 的 Key 通常以 tvly- 开头';
      seen.add(v);
    });
  } else if (id === 'exa') {
    url('url', p.url);
    key('key', p.key, need ? '启用 Exa 需要 API Key' : '');
  } else if (id === 'tinyfish') {
    url('searchUrl', p.searchUrl);
    url('fetchUrl', p.fetchUrl);
    key('key', p.key, need ? '启用 TinyFish 需要 API Key' : '');
  } else if (id === 'firecrawl') {
    url('url', p.url);
    key('key', p.key, need ? '启用 Firecrawl 需要 API Key' : '', ['fc-'], 'Firecrawl 的 Key 通常以 fc- 开头');
  } else if (id === 'github') {
    key('token', p.token, '', ['ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_'], 'GitHub Token 通常以 ghp_ 或 github_pat_ 开头');
  }
  // Unedited imported values must not block saving an unrelated field.
  for (const map of [err, warn]) for (const key of Object.keys(map)) {
    if (fieldReadOnly(key)) delete map[key];
    else if (D && JSON.stringify(p[key]) === JSON.stringify(D.base?.[key])
      && p.mode === D.base?.mode && !(id === 'tavily' && JSON.stringify(p.keys) !== JSON.stringify(D.base.keys))) delete map[key];
  }
  return { err, warn };
}
function normCard(p) {
  const o = {};
  Object.keys(p).forEach((k) => {
    const v = p[k];
    if (Array.isArray(v)) o[k] = v.map((x) => x.trim()).filter(Boolean);
    else o[k] = typeof v === 'string' ? v.trim() : v;
  });
  return o;
}
const normHub = (h) => ({ ...h, exeOverride: (h.exeOverride || '').trim(), cfgOverride: (h.cfgOverride || '').trim() });
function isDirty() {
  if (!D) return false;
  const now = D.kind === 'card' ? normCard(D.draft) : normHub(D.draft);
  return JSON.stringify(now) !== D.orig;
}
function refreshDialog() {
  if (!D) return;
  const v = D.kind === 'card' ? vCard(D.id, D.draft) : vHub(D.draft);
  D.v = v;
  if (D.kind === 'card') syncHeadSwitch();
  const shown = (k) => D.submitted || D.touched.has(k) || D.touched.has(k.split('.')[0]);
  const health = {};
  if (D.kind === 'card') {
    healthOf(D.id).forEach((h) => {
      if (D.id === 'tavily') D.draft.keys.forEach((v, i) => { if (v.trim() === h.val) health['keys.' + i] = h.code; });
      else if ((D.draft[h.k] || '').trim() === h.val) health[h.k] = h.code;
    });
  }
  $$('.f-msg[data-msg]', dlg).forEach((m) => {
    const slot = m.dataset.msg;
    const find = (o) => Object.keys(o).find((k) => (k === slot || k.startsWith(slot + '.')) && shown(k));
    const ek = find(v.err);
    const wk = ek ? null : find(v.warn);
    const hk = ek || wk ? null : Object.keys(health).find((k) => k === slot || k.startsWith(slot + '.'));
    if (ek || wk || hk) {
      m.hidden = false;
      m.dataset.tone = ek || hk ? 'err' : 'warn';
      const text = ek ? v.err[ek] : wk ? v.warn[wk] : (D.id === 'tavily' ? `第 ${+hk.split('.')[1] + 1} 个 Key ` : '') + healthMsg(D.id, health[hk]);
      const content = `${svg(ek || hk ? 'errc' : 'warn', 'ic ic-sm')}<span>${esc(text)}</span>`;
      if (m.innerHTML !== content) m.innerHTML = content;
    } else {
      m.hidden = true;
      m.innerHTML = '';
    }
  });
  $$('input[data-k]', dlg).forEach((inp) => {
    const k = inp.dataset.k;
    const invalid = !!((v.err[k] || v.err[k.split('.')[0]]) && shown(k));
    inp.setAttribute('aria-invalid', String(invalid));
    const field = inp.closest('.field');
    const descriptions = field ? $$('.f-msg:not([hidden]), .f-help[id]', field).map((el) => el.id).filter(Boolean) : [];
    if (descriptions.length) inp.setAttribute('aria-describedby', descriptions.join(' '));
    else inp.removeAttribute('aria-describedby');
    const box = inp.closest('.input');
    if (!box) return;
    box.dataset.invalid = String(invalid);
    box.dataset.health = String(!!health[inp.dataset.k] && box.dataset.invalid !== 'true');
  });
  const dirty = isDirty();
  const sv = $('[data-a=save]', dlg);
  if (sv && !D.saving) sv.disabled = !dirty;
  const fn = $('.foot-note', dlg);
  if (fn && !D.warned) {
    let base = D.kind === 'hub' ? '共享项写入配置，插件专属项只读' : '保存后写入共享配置，下次搜索生效';
    if (D.kind === 'card' && D.id === 'grok' && dirty) {
      const a = normCard(D.draft), b = JSON.parse(D.orig);
      delete a.enabled; delete b.enabled;
      if (JSON.stringify(a) === JSON.stringify(b)) base = '启用开关只对 DSH 生效，不写入 config.toml';
    }
    fn.innerHTML = dirty ? `<b>有未保存的修改</b> · ${base}` : base;
  }
  if (D.operationError) {
    let error = $('.save-error', dlg);
    if (!error) {
      error = document.createElement('div');
      error.className = 'note save-error';
      error.setAttribute('role', 'alert');
      $('.dlg-body', dlg)?.appendChild(error);
    }
    const retry = ['CONFIG_CONFLICT', 'CONFIG_COMMIT_UNCERTAIN', 'PREFERENCES_CONFLICT', 'PREFERENCES_COMMIT_UNCERTAIN'].includes(D.operationError.code)
      ? '<button type="button" class="btn btn-sm" data-a="reload-draft">读取最新配置</button>' : '';
    error.innerHTML = `${svg('info', 'ic ic-sm')}<span>${esc(D.operationError.code)} · ${esc(D.operationError.message)}</span>${retry}`;
  }
}

/* ---------- 弹窗事件 ---------- */
function setDraft(k, val) {
  if (!D || dialogBusy() || fieldReadOnly(k)) return;
  const m = /^keys\.(\d+)$/.exec(k);
  if (m) { D.draft.keys[+m[1]] = val; return; }
  if (D.kind === 'hub' && NUM[k]) { D.draft[k] = val.trim() === '' ? NaN : Number(val); return; }
  D.draft[k] = val;
}
function syncChips(k, v) {
  $$(`.chip[data-k="${k}"]`, dlg).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.v === v.trim())));
}
dlg.addEventListener('input', (e) => {
  const t = e.target;
  if (!D || dialogBusy() || !t.matches('input[data-k]') || t.type === 'checkbox') return;
  setDraft(t.dataset.k, t.value);
  D.edited.add(t.dataset.k);
  D.warned = false;
  if (t.dataset.k === 'model') syncChips('model', t.value);
  if (D.kind === 'hub' && NUM[t.dataset.k]) syncStepper(t.dataset.k);
  refreshDialog();
});
dlg.addEventListener('change', (e) => {
  const t = e.target;
  if (!D || dialogBusy() || !t.matches('input[type=checkbox][data-k]') || fieldReadOnly(t.dataset.k)) return;
  D.draft[t.dataset.k] = t.checked;
  D.touched.add(t.dataset.k);
  D.warned = false;
  refreshDialog();
});
dlg.addEventListener('focusout', (e) => {
  const t = e.target;
  if (!D || dialogBusy() || !t.matches('input[data-k]') || t.type === 'checkbox' || t.readOnly) return;
  const k = t.dataset.k;
  if (!D.edited.has(k)) return;
  const tr = t.value.trim();
  if (tr !== t.value) { t.value = tr; setDraft(k, tr); }
  D.touched.add(k);
  refreshDialog();
});
dlg.addEventListener('focusin', e => {
  const t = e.target;
  if (D && t.matches('input[data-hidden]') && !fieldReadOnly(t.dataset.k)) void revealFor(t.dataset.k);
});
dlg.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || !D || dialogBusy() || b.disabled) return;
  const a = b.dataset.a;
  if (a === 'close') closeDialog(false);
  else if (a === 'cancel') closeDialog(true);
  else if (a === 'save') save();
  else if (a === 'eye') toggleEye(b);
  else if (a === 'copy') copyKey(b);
  else if (a === 'mode') setMode(b);
  else if (a === 'pick') pickChip(b);
  else if (a === 'add-key' && !fieldReadOnly('keys')) {
    if (!(await revealFor('keys'))) return;
    if (!D || dialogBusy()) return;
    D.draft.keys.push(''); rerender(`input[data-k="keys.${D.draft.keys.length - 1}"]`, true);
  }
  else if (a === 'del-key' && !fieldReadOnly('keys')) {
    if (await revealFor('keys')) delKey(+b.dataset.i);
  }
  else if (a === 'enabled') toggleEnabled(b);
  else if (a === 'clear') clearArm(b);
  else if (a === 'step') step(b.dataset.k, +b.dataset.d);
  else if (a === 'adv') toggleAdv(b);
  else if (a === 'redetect') redetect(b);
  else if (a === 'open-file') openPath('file');
  else if (a === 'open-folder') openPath('folder');
  else if (a === 'reload-draft') void reloadDialogDraft();
});
async function revealFor(k) {
  if (!D || D.kind !== 'card') return false;
  const mine = D, keyName = k.startsWith('keys') ? 'keys' : k;
  const configured = keyName === 'keys' ? mine.draft.keys.some(hidden) : hidden(mine.draft[keyName]);
  if (!configured) return true;
  if (!S.capabilities?.secretsAllowed) return false;
  if (mine.revealing) {
    await mine.revealing;
    return D === mine && !disposed;
  }
  const key = CARD_FIELDS[mine.id]?.[keyName];
  if (!key) return false;
  const focused = active(), selection = focused?.selectionStart;
  mine.revealing = (async () => {
    try {
      const revealed = await remote.reveal({ key });
      if (disposed || D !== mine) return false;
      if (keyName === 'keys') {
        const values = String(revealed.value || '').split(',').map(v => v.trim()).filter(Boolean);
        const next = values.length ? values : [''];
        mine.base.keys = clone(next);
        mine.draft.keys = clone(next);
      } else {
        mine.base[keyName] = String(revealed.value || '');
        if (hidden(mine.draft[keyName])) mine.draft[keyName] = String(revealed.value || '');
      }
      mine.orig = JSON.stringify(normCard(mine.base));
      if (revealed.readOnly) mine.fields[key] = { ...mine.fields[key], readOnly: true };
      $$('input[data-k]', dlg).forEach(input => {
        const name = input.dataset.k;
        if (keyName === 'keys' ? name.startsWith('keys.') : name === keyName) {
          const value = keyName === 'keys' ? mine.draft.keys[+name.split('.')[1]] || '' : mine.draft[keyName];
          input.value = value;
          delete input.dataset.hidden;
          input.readOnly = fieldReadOnly(name);
        }
      });
      refreshDialog();
      if (focused?.isConnected && !focused.readOnly) {
        focused.focus({ preventScroll: true });
        if (typeof selection === 'number') focused.setSelectionRange(selection, selection);
      }
      return true;
    } catch (error) { operationError(error); return false; }
    finally { if (D === mine) mine.revealing = null; }
  })();
  return mine.revealing;
}
async function toggleEye(b) {
  const k = b.dataset.k;
  const mine = D;
  if (!(await revealFor(k)) || disposed || D !== mine || !b.isConnected) return;
  D.show[k] = !D.show[k];
  dlg.querySelector(`input[data-k="${k}"]`).type = D.show[k] ? 'text' : 'password';
  b.innerHTML = svg(D.show[k] ? 'eyeOff' : 'eye');
  b.setAttribute('aria-pressed', String(D.show[k]));
  b.setAttribute('aria-label', D.show[k] ? '隐藏密钥' : '显示密钥');
}
async function copyKey(b) {
  const mine = D;
  if (!(await revealFor(b.dataset.k)) || disposed || D !== mine || !b.isConnected) return;
  const v = dlg.querySelector(`input[data-k="${b.dataset.k}"]`).value.trim();
  if (!v) { toast('还没有可复制的内容', { tone: 'info' }); return; }
  if (!navigator.clipboard) { toast('复制失败：浏览器不允许访问剪贴板', { tone: 'warn' }); return; }
  navigator.clipboard.writeText(v).then(() => toast('已复制到剪贴板'), () => toast('复制失败：浏览器不允许访问剪贴板', { tone: 'warn' }));
}
function setMode(b) {
  if (!D || dialogBusy()) return;
  if (D.draft.mode === b.dataset.v) return;
  D.draft.mode = b.dataset.v;
  D.warned = false;
  rerender(`[data-a=mode][data-v="${b.dataset.v}"]`);
}
function pickChip(b) {
  if (!D || dialogBusy() || fieldReadOnly(b.dataset.k)) return;
  const k = b.dataset.k;
  D.draft[k] = b.dataset.v;
  const inp = dlg.querySelector(`input[data-k="${k}"]`);
  if (inp) inp.value = b.dataset.v;
  syncChips(k, b.dataset.v);
  D.warned = false;
  refreshDialog();
}
function delKey(i) {
  if (!D || dialogBusy()) return;
  D.draft.keys.splice(i, 1);
  if (!D.draft.keys.length) D.draft.keys.push('');
  D.show = {};
  [D.touched, D.edited].forEach((set) => [...set].forEach((k) => { if (k.startsWith('keys.')) set.delete(k); }));
  D.warned = false;
  rerender(`input[data-k="keys.${Math.max(0, i - 1)}"]`);
}
function toggleEnabled(b) {
  if (!D || dialogBusy()) return;
  if (cardPending()) {
    dlg.querySelector(`input[data-k="${credInput(D.id, D.draft)}"]`)?.focus();
    return;
  }
  D.draft.enabled = D.draft.enabled === false;
  D.touched.add(D.id === 'tavily' ? 'keys' : credKey(D.id, D.draft));
  if (D.id === 'grok' && D.draft.mode === 'compat') D.touched.add('gwUrl');
  D.warned = false;
  refreshDialog();
}
function rerender(focusSel, animateNew) {
  if (!D || dialogBusy()) return;
  resetClearConfirmation();
  const body = $('.dlg-body', dlg);
  const top = body ? body.scrollTop : 0;
  if (D.kind === 'card') renderCard(); else renderHub();
  const nb = $('.dlg-body', dlg);
  if (nb) nb.scrollTop = top;
  const f = focusSel ? dlg.querySelector(focusSel) : null;
  if (f) {
    f.focus();
    const kr = f.closest('.key-row');
    if (animateNew && kr && !reduced()) kr.classList.add('enter');
  }
}
async function save() {
  if (!D || dialogBusy() || S.busy || disposed) return;
  if (D.revealing) { if (!(await D.revealing)) return; }
  if (!D || disposed) return;
  D.submitted = true;
  refreshDialog();
  const ek = Object.keys(D.v.err);
  if (ek.length) {
    const advKeys = ['cache', 'maxChars', 'budget', 'exeOverride', 'cfgOverride'];
    if (D.kind === 'hub' && advKeys.includes(ek[0]) && !D.advOpen) toggleAdv($('[data-a=adv]', dlg));
    const target = dlg.querySelector(`input[data-k="${ek[0]}"]`);
    if (target) target.focus();
    shake(dlg);
    return;
  }
  if (!isDirty()) return;
  const snapshot = clone(D.draft);
  if (Array.isArray(snapshot.keys)) Object.freeze(snapshot.keys);
  Object.freeze(snapshot);
  resetClearConfirmation();
  cancelTest();
  syncAll();
  D.saving = true;
  const sv = $('[data-a=save]', dlg);
  lockDialog();
  sv.innerHTML = '<span class="spin"></span>保存中…';
  const mine = D;
  S.busy = true;
  try {
    if (D.kind === 'card') await commitCard(snapshot); else await commitHub(snapshot);
  } catch (error) { if (D === mine) operationError(error, true); }
  finally { S.busy = false; if (!disposed) syncAll(true); }
}
function cardUpdates(id, draft, base, fields) {
  const updates = {};
  for (const [name, key] of Object.entries(CARD_FIELDS[id])) {
    if (fieldReadOnly(name) || JSON.stringify(draft[name]) === JSON.stringify(base[name])) continue;
    const value = draft[name];
    if (hidden(value) || Array.isArray(value) && value.some(hidden)) continue;
    updates[key] = Array.isArray(value) ? value.map(v => v.trim()).filter(Boolean).join(',') || null
      : typeof value === 'string' ? value.trim() || null : value;
  }
  if (id === 'grok' && draft.mode === 'compat' && base.mode !== 'compat') updates.grok_api_key = null;
  if (SUPP.includes(id) && (draft.enabled !== base.enabled || !isSet(id, base) && isSet(id, draft))) {
    Object.assign(updates, sourceChain.plan(fields, { kind: 'toggle', id, on: draft.enabled !== false }));
  }
  return updates;
}
async function commitCard(draft = D.draft) {
  const mine = D, id = mine.id, base = clone(mine.base);
  const previous = clone(S.prov[id]);
  const receipt = await saveConfig(fields => cardUpdates(id, draft, base, fields), mine.configBaseline);
  if (disposed || D !== mine) return;
  const prefsChanged = (id === 'grok' || id === 'github') && draft.enabled !== base.enabled;
  if (prefsChanged) {
    try { await savePreference(id, draft.enabled !== false); }
    catch (error) {
      mine.saving = false;
      if (receipt) {
        mine.configBaseline = clone(S.config);
        // The config half was committed. Keep its actual typed values as the
        // new base so retrying the private switch cannot re-send the secrets.
        mine.base = clone(draft);
        mine.base.enabled = S.prov[id].enabled;
        mine.fields = clone(configFields());
        mine.draft = clone(draft);
        mine.orig = JSON.stringify(normCard(mine.base));
        operationError(Object.assign(new Error('共享配置已保存，但 DSH 开关未保存。请核对后再保存开关。'), { code: 'SETTINGS_PARTIAL_SAVE' }), true);
        return;
      }
      throw error;
    }
  }
  const credentialsChanged = CRED[id].some(name => JSON.stringify(base[name]) !== JSON.stringify(draft[name]));
  if (credentialsChanged) reconcileChecks(id, previous, normCard(draft));
  mine.saving = false;
  closeDialog(true);
  syncAll(false);
  bump(rowOf(id));
  const changedMode = id === 'grok' && base.mode !== 'compat' && draft.mode === 'compat';
  toast(changedMode ? '已保存兼容网关 · 原 xAI Key 已删除并备份到配置历史'
    : receipt ? `已保存 ${META[id].name} · 下次搜索生效，可点「测试搜索」验证`
      : `已保存 ${META[id].name} 开关 · 仅对 DSH 生效`,
  { undo: cardUndo(receipt, id, base.enabled !== false, prefsChanged) });
}
async function clearArm(b) {
  if (!D || dialogBusy()) return;
  if (!D.clearArmed) {
    D.clearArmed = true;
    b.classList.add('is-confirm');
    b.textContent = D.id === 'grok' ? (servingSupp() ? '再点一次：清除后改由补充来源搜索' : '再点一次：清除后搜索会报错') : '再点一次确认清除';
    const mine = D;
    D.clearTimer = setTimeout(() => {
      if (D !== mine) return;
      D.clearArmed = false;
      D.clearTimer = 0;
      if (b.isConnected) { b.classList.remove('is-confirm'); b.textContent = '清除配置'; }
    }, 3000);
    return;
  }
  const mine = D, id = mine.id;
  const updates = Object.fromEntries(Object.values(CARD_FIELDS[id])
    .filter(key => mine.fields[key]?.source === 'file' && !mine.fields[key]?.readOnly)
    .map(key => [key, null]));
  if (!Object.keys(updates).length) {
    toast('没有可清除的文件配置；环境变量和只读认证保持不变。', { tone: 'info' });
    resetClearConfirmation(); return;
  }
  D.clearing = true;
  lockDialog();
  cancelTest();
  S.busy = true;
  try {
    const receipt = await saveConfig(updates, mine.configBaseline);
    if (disposed || D !== mine) return;
    mine.clearing = false;
    closeDialog(true);
    syncAll(false);
    toast(`已清除 ${META[id].name} 文件配置 · 原内容已备份到配置历史`, { undo: configUndo(receipt) });
  } catch (error) { if (D === mine) operationError(error, true); }
  finally { S.busy = false; if (!disposed) syncAll(true); }
}
/* 右上角开关表示保存后的实际状态：从未配置且草稿仍缺凭据时固定为关闭，填好后自动打开。 */
const cardPending = () => !!D && D.kind === 'card' && D.id !== 'github' && !isSet(D.id, D.base) && !isSet(D.id, D.draft);
const credInput = (id, p) => (id === 'tavily' ? 'keys.0' : id === 'grok' && p.mode === 'compat' ? (p.gwUrl.trim() ? 'gwKey' : 'gwUrl') : credKey(id, p));
function headState() {
  const pending = cardPending();
  const text = D.id === 'github' ? '检测 GitHub' : '启用';
  return { pending, on: !pending && D.draft.enabled !== false, text };
}
function headSwitch() {
  const h = headState();
  return `<label class="head-switch" data-pending="${h.pending}"><span class="hs-text">${h.text}</span><button type="button" class="switch" role="switch" aria-checked="${h.on}"${h.pending ? ' aria-disabled="true" title="在下方填写后自动打开"' : ''} data-a="enabled"><i></i></button></label>`;
}
function syncHeadSwitch() {
  const hs = $('.head-switch', dlg);
  if (!hs) return;
  const h = headState();
  const sw = $('.switch', hs);
  hs.dataset.pending = String(h.pending);
  $('.hs-text', hs).textContent = h.text;
  sw.setAttribute('aria-checked', String(h.on));
  if (h.pending) { sw.setAttribute('aria-disabled', 'true'); sw.title = '在下方填写后自动打开'; }
  else { sw.removeAttribute('aria-disabled'); sw.removeAttribute('title'); }
}
function renderCard() {
  const id = D.id;
  const m = META[id];
  const p = D.draft;
  const ctl = headSwitch();
  const head = `<header class="dlg-head">${tile(id, 40)}<div class="dlg-titles"><h2 id="dlgTitle">${m.name}</h2><p class="dlg-sub"><span>${subText(id)}</span><a class="dlg-link" href="${m.link}" target="_blank" rel="noopener noreferrer">${EXT(m.linkText)}</a></p></div>${ctl}<button type="button" class="icon-btn" data-a="close" aria-label="关闭">${svg('x')}</button></header>`;
  // 用 form 包住字段，密码管理器才会把它当作一个凭据表单；保存仍由底部按钮控制。
  const locked = !S.capabilities?.secretsAllowed ? note('当前连接仅支持脱敏查看。请使用已认证的本机直连或 HTTPS 连接查看和保存 Key。') : '';
  const body = `<div class="dlg-body">${locked}<form class="dlg-form" novalidate>${FIELDS[id](p)}</form></div>`;
  const clearable = Object.values(CARD_FIELDS[id]).some(key => D.fields[key]?.source === 'file' && !D.fields[key]?.readOnly);
  const clearBtn = clearable ? `<button type="button" class="btn btn-ghost btn-sm btn-danger" data-a="clear"${S.capabilities?.secretsAllowed ? '' : ' disabled'}>清除配置</button>` : '';
  const foot = `<footer class="dlg-foot">${clearBtn}<span class="foot-note"></span><button type="button" class="btn btn-sm grow" data-a="cancel">取消</button><button type="button" class="btn btn-primary btn-sm grow" data-a="save">保存</button></footer>`;
  dlg.innerHTML = head + body + foot;
  const form = $('.dlg-form', dlg);
  if (form) form.addEventListener('submit', (e) => e.preventDefault());
  refreshDialog();
}
function openCard(id, opt = {}) {
  if (S.loading || S.busy || !META[id]) return;
  closePop();
  // 未配置来源的 enabled 只是默认值：草稿按“填好凭据后启用”处理，打开弹窗本身不算修改。
  const base = clone(S.prov[id]);
  if (!isSet(id, base)) base.enabled = true;
  const draft = clone(base);
  if (opt.enable) draft.enabled = true;
  D = {
    kind: 'card', id, draft, base, fields: clone(configFields()), configBaseline: clone(S.config),
    orig: JSON.stringify(normCard(base)),
    touched: new Set(), edited: new Set(), show: {}, submitted: false, warned: false, saving: false, clearing: false, clearArmed: false, clearTimer: 0,
    returnFocus: opt.from || rowOf(id)?.querySelector('.row-main')
  };
  showOverlay();
  renderCard();
  requestAnimationFrame(initialFocus);
}

/* ---------- 中继弹窗：Grok Search RS ---------- */
const NUM = {
  extra: { min: 0, max: 10, step: 1, unit: '条' },
  fallback: { min: 1, max: 10, step: 1, unit: '条' },
  timeout: { min: 5, max: 300, step: 5, unit: '秒' },
  cache: { min: 1, max: 4096, step: 64, unit: '条' },
  maxChars: { min: 5000, max: 500000, step: 5000, unit: '字符' },
  budget: { min: 30, max: 120, step: 10, unit: '秒' }
};
function stepper(k, v) {
  const n = NUM[k];
  const ok = Number.isFinite(v);
  const ro = fieldReadOnly(k);
  const dn = `<button type="button" data-a="step" data-k="${k}" data-d="-1" aria-label="减少"${ro || ok && v <= n.min ? ' disabled' : ''}>${svg('minus', 'ic ic-sm')}</button>`;
  const up = `<button type="button" data-a="step" data-k="${k}" data-d="1" aria-label="增加"${ro || ok && v >= n.max ? ' disabled' : ''}>${svg('plus', 'ic ic-sm')}</button>`;
  return `<div class="stepper${ro ? ' is-readonly' : ''}">${dn}<input id="${fid(k)}" type="text" inputmode="numeric" data-k="${k}" value="${ok ? v : ''}" autocomplete="off"${ro ? ' readonly' : ''}><span class="unit">${n.unit}</span>${up}</div>`;
}
function step(k, d) {
  if (!D || dialogBusy() || fieldReadOnly(k)) return;
  const n = NUM[k];
  const cur = Number.isFinite(D.draft[k]) ? D.draft[k] : n.min;
  const v = Math.min(n.max, Math.max(n.min, Math.round((cur + d * n.step) / n.step) * n.step));
  D.draft[k] = v;
  dlg.querySelector(`input[data-k="${k}"]`).value = v;
  D.touched.add(k);
  D.warned = false;
  syncStepper(k);
  refreshDialog();
}
function syncStepper(k) {
  const n = NUM[k];
  const v = D.draft[k];
  const [dn, up] = $$(`[data-a=step][data-k="${k}"]`, dlg);
  const set = (b, dis) => {
    const had = active() === b;
    b.disabled = dis;
    if (dis && had) dlg.querySelector(`input[data-k="${k}"]`).focus();
  };
  set(dn, Number.isFinite(v) && v <= n.min);
  set(up, Number.isFinite(v) && v >= n.max);
}
function vHub(h) {
  const err = {};
  const warn = {};
  Object.entries(NUM).forEach(([k, n]) => {
    if (fieldReadOnly(k) || D && Object.is(h[k], D.base[k])) return;
    const v = h[k];
    if (!Number.isInteger(v)) err[k] = '请填写整数';
    else if (v < n.min || v > n.max) err[k] = `可填范围 ${n.min}–${n.max}`;
  });
  if (h.fallback === 0 && D && h.fallback !== D.base.fallback && !fieldReadOnly('fallback')) err.fallback = '至少保留 1 条回退来源。';
  if (!err.timeout && !err.budget && h.timeout > h.budget) {
    warn.timeout = `请求超时 ${h.timeout} 秒长于单次搜索预算 ${h.budget} 秒，DSH 会先停止等待`;
    warn.budget = warn.timeout;
  }
  return { err, warn };
}
function hubBody(h) {
  const config = configLocation();
  const source = S.program?.program?.source;
  const prog = { tag: `<span class="tag" data-tone="${S.program?.phase === 'ready' ? 'ok' : 'warn'}">${esc(programSource())}</span>`,
    path: S.program?.program?.path || S.program?.error?.message || '正在自动检测，无需填写路径' };
  const version = S.program?.program?.version ? 'v' + S.program.program.version : programPhase();
  const hit = ['manual', 'loader'].includes(source) ? 0 : ['path', 'npm', 'cargo'].includes(source) ? 1
    : source === 'private-cache' ? 2 : -1;
  const order = ['插件设置里的程序路径（只读）', '系统 PATH、npm 或 Cargo 的已有安装', '缺失时下载到插件私有缓存']
    .map((t, i) => `<li class="${i === hit ? 'is-hit' : ''}">${t}${i === hit ? ' · 当前使用' : ''}</li>`).join('');
  const cfgTag = S.cfgExists ? '<span class="tag" data-tone="agent">已存在</span>' : '<span class="tag" data-tone="warn">首次保存时创建</span>';
  const secProg = [
    '<section class="sec"><h3 class="sec-h">程序</h3>',
    `<div class="prog"><div class="prog-main"><span class="prog-title">grok-search-rs ${esc(version)} ${prog.tag}</span><span class="prog-path" title="${esc(prog.path)}">${esc(prog.path)}</span></div><button type="button" class="btn btn-sm" data-a="redetect">${svg('refresh', 'ic ic-sm')}重新检测</button></div>`,
    '<p class="f-help" style="margin:10px 0 6px">按以下顺序查找，已有兼容安装直接复用；不会覆盖全局程序：</p>',
    `<ol class="order">${order}</ol></section>`
  ].join('');
  const secCfg = [
    '<section class="sec"><h3 class="sec-h">共享配置文件</h3>',
    `<div class="prog"><div class="prog-main"><span class="prog-title">${esc(config.name)} ${cfgTag}</span><span class="prog-path" title="${esc(config.full)}">${esc(config.label)}</span></div>`,
    `<button type="button" class="btn btn-ghost btn-sm" data-a="open-file"${S.cfgExists ? '' : ' disabled'}>${svg('file', 'ic ic-sm')}打开文件</button>`,
    `<button type="button" class="btn btn-ghost btn-sm" data-a="open-folder">${svg('folder', 'ic ic-sm')}所在文件夹</button></div>`,
    note('保存后写入此 Grok 配置文件。其他使用同一文件的应用也会读取这些设置；使用独立配置的应用不受影响。插件保存前会自动备份，并保留原有注释与排版。'),
    '</section>'
  ].join('');
  const secRoute = [
    '<section class="sec"><h3 class="sec-h">路由</h3>',
    field({ label: '路由策略', ctl: '<span class="static-val">按顺序<span class="tag">补充来源依次尝试</span></span>', help: '原生 Grok 会并行获取主搜与补充结果。Grok 关闭或程序不可用时，DSH 直接按补充链顺序尝试，首个有结果的来源返回；测试会另行检查全部已开启来源及 Key。' }),
    field({ label: '补充来源数', k: 'extra', ctl: stepper('extra', h.extra), help: 'Grok 正常返回时，额外展示的结果条数，不是供应商数量。供应商由主界面开关控制；设为 0 不附加补充结果，仍可失败回退。' }),
    field({ label: '回退来源数', k: 'fallback', ctl: stepper('fallback', h.fallback), help: 'Grok 调用失败或缺少可核验引用时，最多返回的回退结果条数，不是供应商数量。至少保留 1 条。' }),
    field({ label: '请求超时', k: 'timeout', ctl: stepper('timeout', h.timeout), help: '整条搜索链共用一个截止时间，不是每个来源各算一次。' }),
    '</section>'
  ].join('');
  const secAdv = [
    `<section class="sec"><button type="button" class="adv-toggle" data-a="adv" aria-expanded="${!!D.advOpen}" aria-controls="advBox">${svg('chev', 'ic ic-sm')}高级<span class="adv-hint">缓存、回复上限、插件专属设置</span></button>`,
    `<div class="adv${D.advOpen ? ' is-open' : ''}" id="advBox"><div${D.advOpen ? '' : ' inert'}>`,
    field({ label: '会话缓存', k: 'cache', ctl: stepper('cache', h.cache), help: '供 get_sources 回看来源的会话缓存条数。' }),
    field({ label: '回复字符上限', k: 'maxChars', ctl: stepper('maxChars', h.maxChars), help: '单次搜索返回给 DSH 的最大字符数。' }),
    `<p class="sub-h">${svg('lock', 'ic ic-sm')}插件专属设置 · 此处只读</p>`,
    field({ label: '单次搜索预算', k: 'budget', ctl: stepper('budget', h.budget), help: 'DSH 等待一次搜索的最长时间，30–120 秒。' }),
    field({ label: '程序路径', hint: '覆盖自动检测', k: 'exeOverride', ctl: txt('exeOverride', h.exeOverride, '留空则自动检测'), help: '在 DSH 插件配置中设置，此处只显示当前值。通常无需指定。' }),
    field({ label: '配置路径', hint: '覆盖默认位置', k: 'cfgOverride', ctl: txt('cfgOverride', h.cfgOverride, '自动使用 ' + config.label), help: '在 DSH 插件配置中设置，此处只显示当前值。通常无需指定。' }),
    note('进程环境变量优先于 config.toml 中的同名设置；设置了 <code>GROK_SEARCH_CONFIG</code> 时，以它指向的文件为准。'),
    '</div></div></section>'
  ].join('');
  return secProg + secCfg + secRoute + secAdv;
}
function renderHub() {
  const version = S.program?.program?.version ? 'v' + S.program.program.version : programPhase();
  const head = `<header class="dlg-head"><span class="tile tile-glyph" style="--s:40px">${svg('hub')}</span><div class="dlg-titles"><h2 id="dlgTitle">Grok Search RS</h2><p class="dlg-sub"><span>${esc(version)} · MIT · 把 Grok 与各搜索来源串成一条路由</span><a class="dlg-link" href="https://github.com/Episkey-G/GrokSearch-rs" target="_blank" rel="noopener noreferrer">${EXT('GitHub 仓库')}</a></p></div><button type="button" class="icon-btn" data-a="close" aria-label="关闭">${svg('x')}</button></header>`;
  const foot = '<footer class="dlg-foot"><span class="foot-note"></span><button type="button" class="btn btn-sm grow" data-a="cancel">取消</button><button type="button" class="btn btn-primary btn-sm grow" data-a="save">保存</button></footer>';
  dlg.innerHTML = head + `<div class="dlg-body">${hubBody(D.draft)}</div>` + foot;
  refreshDialog();
}
function toggleAdv(b) {
  D.advOpen = !D.advOpen;
  b.setAttribute('aria-expanded', String(D.advOpen));
  const box = $('#advBox', dlg);
  box.classList.toggle('is-open', D.advOpen);
  box.firstElementChild.inert = !D.advOpen;
  if (D.advOpen) setTimeout(() => box.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }), 140);
}
async function redetect(b) {
  if (!D || dialogBusy() || b.disabled) return;
  const html = b.innerHTML;
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>检测中…';
  const mine = D;
  S.busy = true;
  try {
    const program = await remote.prepareProgram();
    if (disposed || D !== mine) return;
    S.program = program;
    renderHead();
    toast(`${programPhase()} · ${programSource()}${program.program?.version ? ' v' + program.program.version : ''}`, { tone: 'info' });
    renderHub();
  } catch (error) { operationError(error); }
  finally {
    S.busy = false;
    if (b.isConnected) { b.disabled = false; b.innerHTML = html; }
    if (!disposed) syncAll(true);
  }
}
async function commitHub(draft = D.draft) {
  const mine = D;
  const updates = Object.fromEntries(Object.entries(HUB_FIELDS)
    .filter(([name]) => !fieldReadOnly(name) && !Object.is(draft[name], mine.base[name]))
    .map(([name, key]) => [key, draft[name]]));
  const receipt = await saveConfig(updates, mine.configBaseline);
  if (disposed || D !== mine) return;
  mine.saving = false;
  closeDialog(true);
  syncAll(false);
  toast('已写入 Grok 共享配置 · 下次搜索生效', { undo: configUndo(receipt) });
}
function openHub(opt = {}) {
  if (S.loading || S.busy) return;
  closePop();
  D = {
    kind: 'hub', draft: clone(S.hub), base: clone(S.hub), fields: clone(configFields()),
    configBaseline: clone(S.config), orig: JSON.stringify(normHub(S.hub)),
    touched: new Set(), edited: new Set(), show: {}, submitted: false, warned: false, saving: false,
    advOpen: !!opt.adv, returnFocus: opt.from || $('#nodeHub')
  };
  showOverlay();
  renderHub();
  requestAnimationFrame(initialFocus);
}

/* ---------- 测试搜索：数据包沿路由往返 ---------- */
function openPop() {
  if ($('#testBtn').disabled) return;
  testPop.hidden = false;
  $('#testBtn').setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => testPop.querySelector('[data-pop=go]').focus());
}
function closePop(refocus) {
  if (testPop.hidden) return;
  testPop.hidden = true;
  $('#testBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('#testBtn').focus();
}
$('#testBtn').addEventListener('click', () => { if (testPop.hidden) openPop(); else closePop(); });
testPop.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pop]');
  if (!b) return;
  if (b.dataset.pop === 'go') { closePop(); $('#testBtn').focus(); runTest(); }
  else closePop(true);
});
listen(document, 'pointerdown', e => { if (!testPop.hidden && !targetOf(e).closest?.('.rc-actions')) closePop(); });
function travel(wid, o = {}) {
  return new Promise((resolve) => {
    const g = wireNodes.get(wid);
    if (!g) { resolve(); return; }
    const path = g.children[1];
    // 数据包始终只用 agent 蓝；成败由端口形状和断口表达，不再把整条线染绿或染红。
    g.classList.add('lit');
    // 测试时线是通的：旧断口先合上，失败后再由 cut() 现场断开。
    path.style.strokeDasharray = '';
    path.style.strokeLinecap = '';
    g.children[2].style.opacity = g.children[3].style.opacity = '0';
    wiresEl.insertBefore(g, packetLayer);
    const pk = document.createElementNS(SVGNS, 'g');
    pk.setAttribute('class', 'packet');
    pk.innerHTML = '<circle class="p-halo" r="7"></circle><circle class="p-core" r="3.2"></circle>';
    packetLayer.appendChild(pk);
    const dur = o.dur || T.hop;
    const t0 = performance.now();
    const myGen = gen;
    const finish = () => { waits.delete(finish); pk.remove(); resolve(); };
    waits.add(finish);
    const frame = (now) => {
      if (myGen !== gen || disposed) { finish(); return; }
      const t = Math.min(1, (now - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const len = path.getTotalLength();
      const pt = path.getPointAtLength((o.back ? 1 - e : e) * len);
      pk.setAttribute('transform', `translate(${pt.x},${pt.y})`);
      if (t < 1) requestAnimationFrame(frame);
      else finish();
    };
    requestAnimationFrame(frame);
  });
}
/* 测试时先合上旧断口，让数据包走完整条线；失败时轻颤，再换一个位置张开断口。 */
function cut(wid) {
  const g = wireNodes.get(wid);
  if (!g) return;
  g.classList.remove('lit');
  g._bt = performance.now();
  delete g._bf;
  pumpWires(480);
}
const jolts = new Map();
const faultPulses = new Map();
function pulseFault(el) {
  if (!el) return;
  clearTimeout(faultPulses.get(el));
  el.classList.add('is-fault-flash');
  const timer = setTimeout(() => {
    if (faultPulses.get(el) !== timer) return;
    el.classList.remove('is-fault-flash');
    faultPulses.delete(el);
  }, 1100);
  faultPulses.set(el, timer);
}
function jolt(el, soft = false) {
  if (!el || reduced()) return Promise.resolve();
  jolts.get(el)?.();
  return new Promise((resolve) => {
    let leadTimer, cleanupTimer;
    const name = soft ? 'route-jolt-soft' : 'route-jolt';
    const clean = () => {
      clearTimeout(leadTimer);
      clearTimeout(cleanupTimer);
      el.removeEventListener('animationend', onEnd);
      el.removeEventListener('animationcancel', onEnd);
      if (jolts.get(el) === clean) {
        el.classList.remove('is-jolt', 'is-jolt-soft');
        jolts.delete(el);
      }
      resolve();
    };
    const onEnd = (e) => { if (e.target === el && e.animationName === name) clean(); };
    jolts.set(el, clean);
    el.classList.remove('is-searching', 'flash-ok', 'is-jolt', 'is-jolt-soft');
    void el.offsetWidth;
    el.classList.add(soft ? 'is-jolt-soft' : 'is-jolt');
    el.addEventListener('animationend', onEnd);
    el.addEventListener('animationcancel', onEnd);
    // 颤动尾部接上断线；取消场景时 clean() 同时解除等待和所有清理任务。
    leadTimer = setTimeout(resolve, soft ? 220 : 300);
    cleanupTimer = setTimeout(clean, soft ? 380 : 500);
    pumpWires(soft ? 360 : 480);
  });
}
function clearLit() {
  hideStripTip();
  jolts.forEach((clean) => clean());
  faultPulses.forEach((timer, el) => { clearTimeout(timer); el.classList.remove('is-fault-flash'); });
  faultPulses.clear();
  wireNodes.forEach((g) => { g.classList.remove('lit'); g.dataset.requesting = 'false'; });
  if (packetLayer) packetLayer.replaceChildren();
  $('#nodeHub').classList.remove('is-busy', 'is-falling');
  $('#hubPillText').textContent = '按顺序';
  $$('.row.is-searching').forEach((r) => r.classList.remove('is-searching'));
}
/* 测试节奏（毫秒） */
const T = { hop: 380, grok: 720, supp: 560, fail: 420, hold: 900, trace: 6500 };
function flashRow(id) {
  const r = rowOf(id);
  if (!r || reduced()) return;
  r.classList.remove('is-searching', 'flash-ok');
  void r.offsetWidth;
  r.classList.add('flash-ok');
  setTimeout(() => r.classList.remove('flash-ok'), 900);
}
function flashNode(el) {
  if (!el || reduced()) return;
  el.classList.remove('flash-ok');
  void el.offsetWidth;
  el.classList.add('flash-ok');
  setTimeout(() => el.classList.remove('flash-ok'), 1100);
}
/* Real provider diagnostics. The gateway returns per-Key results together:
   all Tavily dots pulse while that RPC is in flight, then resolve together.
   No timer invents network progress, result counts, status codes or duration. */
async function runTest() {
  const st0 = routeStatus();
  if (S.testing || S.busy || ['off', 'wait', 'none', 'load', 'down', 'cfgerr', 'ctlerr', 'connecting', 'prep'].includes(st0)) return;
  const my = ++gen;
  const started = performance.now();
  clearToasts();
  $('#announcer').textContent = '';
  S.testing = true;
  S.bgRun = false;
  S.marks = {};
  clearTimeout(S.traceTimer);
  S.trace = { bg: false, order: S.order.slice(), items: [], failedSources: [], done: null, reroute: false };
  S.lastRoute = null;
  renderHead();
  renderSummary();
  syncRows();
  pumpWires(200);
  const alive = () => my === gen && !disposed;
  const anim = !reduced();
  const go = (wid, opt) => (anim ? travel(wid, opt) : Promise.resolve());
  const live = () => { renderHead(); renderSummary(); syncRows(); pumpWires(360); };
  const hub = $('#nodeHub');
  const tr = S.trace;
  const providers = [...(grokOn() ? ['grok'] : []), ...enabledSupp(),
    ...(S.prov.github.enabled !== false ? ['github'] : [])];
  const results = [];
  let primaryFailed = false, supplementaryReady = false;
  try {
    hub.classList.add('is-busy');
    for (const id of providers) {
      if (!alive()) return;
      if (primaryFailed && SUPP.includes(id)) {
        tr.reroute = true;
        hub.classList.add('is-falling');
        $('#hubPillText').textContent = '检测补充链';
      }
      const slots = id === 'tavily' ? tvKeyIdx() : [0];
      const items = slots.map(slot => ({ id, key: slot, label: META[id].name, tone: 'run' }));
      tr.items.push(...items);
      const row = rowOf(id);
      row.classList.add('is-searching');
      live();
      // Start the request now; visuals run concurrently and never postpone it.
      const operationId = uuid();
      S.diagnosticOperation = operationId;
      const request = remote.diagnoseProvider({ provider: id, operationId }).catch(error => ({
        provider: id, status: 'failed', code: normalizeCode(error?.code || 'SETTINGS_UNAVAILABLE'),
        message: error?.message || '设置请求失败。', keys: [],
      }));
      await go('hub-' + id);
      if (!alive()) return;
      const result = await request;
      if (!alive()) return;
      S.diagnosticOperation = null;
      delete S.providerBad[id];
      row.classList.remove('is-searching');
      results.push(result);
      const skipped = ['disabled', 'not-configured'].includes(result.status);
      const entries = result.keys?.length ? result.keys : slots.map(slot => ({ keyIndex: slot, ...result }));
      for (const entry of entries) {
        const index = entry.keyIndex ?? 0;
        const item = items.find(it => it.key === index);
        const code = entry.status === 'failed' ? normalizeCode(entry.code) : '';
        if (item) { item.tone = code ? 'err' : skipped ? 'idle' : 'ok'; item.code = code; }
        if (!skipped) {
          rememberCheck(id, index, code, 'test');
          S.checked[id][index].status = entry.status;
        }
      }
      if (id === 'grok') primaryFailed = result.status === 'failed';
      if (SUPP.includes(id) && result.status === 'ok') supplementaryReady = true;
      if (result.status === 'failed') tr.failedSources.push(id);
      live();
      if (result.status === 'failed' || result.partial) {
        pulseFault(row);
        await jolt(row, result.partial === true);
        if (!alive()) return;
        if (result.status === 'failed') cut('hub-' + id);
      } else if (!skipped) {
        flashRow(id);
        await go('hub-' + id, { back: true });
      }
      if (!alive()) return;
    }
    const searchResults = results.filter(result => result.provider !== 'github'
      && !['disabled', 'not-configured'].includes(result.status));
    const passed = searchResults.filter(result => result.status === 'ok');
    const empty = searchResults.filter(result => result.status === 'empty');
    const valid = passed.length + empty.length;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    tr.done = { tone: valid ? 'ok' : 'err',
      text: `${valid}/${searchResults.length} 项连通${empty.length ? ` · ${empty.length} 项无结果` : ''} · ${seconds} 秒` };
    if (!valid) {
      tr.done.text = `全部不可用 · ${seconds} 秒`;
      cut('dsh-hub');
    } else if (primaryFailed && supplementaryReady) {
      tr.done.text = `已静默回退 · ${valid}/${searchResults.length} 项可用 · ${seconds} 秒`;
      await go('dsh-hub', { back: true });
      if (!alive()) return;
      flashNode($('#nodeDsh'));
    }
    live();
    const failures = searchResults.filter(result => result.status === 'failed')
      .map(result => `${META[result.provider].name} ${normalizeCode(result.code)} · ${errText(result.code)}`);
    const github = results.find(result => result.provider === 'github');
    $('#announcer').textContent = `已检查全部开启的来源与 Key。${tr.done.text}。${failures.join('；')}${github ? `。GitHub：${github.message}` : ''}`;
  } finally {
    // 旧测试的 finally 也不能清掉新测试的 loading、trace 或动画。
    if (alive()) {
      S.diagnosticOperation = null;
      S.testing = false;
      S.bgRun = false;
      clearLit();
      S.traceTimer = setTimeout(() => { if (!S.testing && S.trace === tr) { S.trace = null; renderSummary(); pumpWires(200); } }, T.trace);
      syncAll(true);
    }
  }
}

/* ---------- Mount-local theme, path actions and lifecycle ---------- */
function setTheme(dark) {
  if (disposed) return;
  darkTheme = dark === true || dark === 'dark';
  root.dataset.theme = layer.dataset.theme = darkTheme ? 'dark' : 'light';
  refreshLogos();
  bannerHtml = null;
  renderBanner();
}
async function openPath(kind) {
  if (disposed) return;
  try {
    const result = await remote.openConfigLocation({ kind });
    if (disposed) return;
    if (!result.opened) toast(!result.exists && kind === 'file' ? '配置文件尚未创建，首次保存后可打开。'
      : `未能在宿主打开：${result.path}`, { tone: 'info', ms: 7000,
        action: { label: '复制路径', icon: 'copy', run: async () => {
          if (!navigator.clipboard) { toast('浏览器不允许复制，请手动选择路径。', { tone: 'warn' }); return; }
          await navigator.clipboard.writeText(result.path);
          if (!disposed) toast('配置路径已复制');
        } } });
  } catch (error) { operationError(error); }
}
$$('.rc-foot [data-open]').forEach((b) => b.addEventListener('click', () => openPath(b.dataset.open)));
$('#bannerSlot').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  if (a === 'retry') void refresh({ force: true });
  else if (a === 'open-file') void openPath('file');
  else if (a.startsWith('open:')) openCard(a.slice(5), { from: b });
  else if (a === 'grok-off' || a === 'grok-on') { const r = rowOf('grok'); if (isOn('grok') !== (a === 'grok-on')) onRowSwitch('grok', r); }
  else if (a === 'dismiss-read') { S.readDismissed = true; renderBanner(); }
  else if (a === 'dismiss-aux') { S.auxDismissed = b.dataset.k; renderBanner(); }
});
$('#nodeHub').addEventListener('click', (e) => openHub({ from: e.currentTarget }));

function init() {
  $('#hubGlyph').innerHTML = svg('hub');
  $('[data-open=file]').insertAdjacentHTML('afterbegin', svg('file', 'ic ic-sm'));
  $('[data-open=folder]').insertAdjacentHTML('afterbegin', svg('folder', 'ic ic-sm'));
  $('.rg-hint').insertAdjacentHTML('afterbegin', svg('grip', 'ic ic-sm'));
  $('#testBtn').setAttribute('aria-haspopup', 'dialog');
  $('#testBtn').setAttribute('aria-expanded', 'false');
  card.dataset.layout = 'wide';
  refreshLogos();
  quiet(900);
  buildRows(false);
  syncAll(true);
  void refresh({ first: true }).then(() => {
    if (disposed) return;
    buildRows(!memory.mounted);
    syncAll(true);
    if (!memory.mounted) wiresEl.classList.add('draw');
    pumpWires(720);
  });
  schedulePoll();
}
listen(document, 'visibilitychange', () => {
  if (document.visibilityState !== 'hidden') { void refresh(); pumpWires(180); }
});
listen(RM, 'change', () => { quiet(1000); clearLit(); pumpWires(80); });
init();
return Object.freeze({
  setTheme,
  refresh: () => refresh({ force: true }),
  dispose() {
    if (disposed) return;
    cancelDrag();
    cancelOwnedDiagnosis();
    gen++;
    clearLit();
    resizeObserver.disconnect();
    Object.assign(memory, {
      mounted: true, checked: clone(S.checked), bad: clone(S.bad), providerBad: clone(S.providerBad), identity: clone(S.identity),
      readDismissed: S.readDismissed, auxDismissed: S.auxDismissed, lastRouteAt: S.lastRouteAt,
      configRevision: S.configRevision, configPath: S.configPath,
      lastRoute: clone(S.lastRoute),
    });
    // No cleartext draft/config values are retained in memory across mounts.
    D = null;
    overlay.hidden = true;
    dlg.replaceChildren();
    disposed = true;
    listeners.forEach(off => off());
    timers.forEach(id => window.clearTimeout(id));
    frames.forEach(id => window.cancelAnimationFrame(id));
    timers.clear(); frames.clear();
    waits.forEach(done => done()); waits.clear();
    root.replaceChildren();
    layer.replaceChildren();
  },
});
}
