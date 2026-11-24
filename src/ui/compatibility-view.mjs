const CORE_FAULTS = new Set([
  'COMPATIBILITY_PLUGIN_INVALID', 'COMPATIBILITY_MINIMUM_REQUIRED',
  'COMPATIBILITY_CORE_SHAPE', 'COMPATIBILITY_ABI_UNSUPPORTED',
  'COMPATIBILITY_CONTRACT_FAILED', 'COMPATIBILITY_PROBE_INVALID',
  'COMPATIBILITY_ROUTE_UNCONFIRMED',
  'COMPATIBILITY_BUDGET_UNCONFIRMED', 'COMPATIBILITY_CORE_UNAVAILABLE', 'COMPATIBILITY_BLOCKED',
  'CONTROL_SEARCH_SELECTION_CONFLICT',
]);
const OPTIONAL_LABELS = Object.freeze({
  settings: '完整设置界面',
  github: 'GitHub 链接读取',
  chat: '聊天搜索卡片',
});
const COMPATIBILITY_CSS = `
.compatibility-banner,.compatibility-banner *{box-sizing:border-box}
.compatibility-banner[hidden],.compatibility-banner [hidden]{display:none!important}
.compatibility-banner{display:flex;align-items:flex-start;gap:10px;padding:10px 10px 10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);font-size:12.5px;color:var(--text-2);margin-bottom:12px;flex-wrap:wrap}
.compatibility-banner[data-tone=warn]{background:var(--warn-soft);border-color:transparent}
.compatibility-banner[data-tone=err]{background:var(--surface-2);border-color:var(--line-2)}
.compatibility-banner[data-tone=err] .compatibility-title{color:var(--err-text)}
.compatibility-banner .compatibility-mark{flex:none;width:18px;height:18px;display:grid;place-items:center;border:1.5px solid currentColor;border-radius:50%;font-size:11px;font-weight:700;line-height:1}
.compatibility-banner[data-tone=warn] .compatibility-mark{color:var(--warn)}
.compatibility-banner[data-tone=err] .compatibility-mark{color:var(--err-text)}
.compatibility-banner .compatibility-body{flex:1;min-width:0}
.compatibility-banner .compatibility-title{display:block;color:var(--text);font-weight:600}
.compatibility-banner .compatibility-text{display:block;margin-top:1px}
.compatibility-banner .compatibility-detail{margin-top:7px;padding-top:7px;border-top:1px solid var(--line);font-size:12px;line-height:1.55;color:var(--text-2)}
.compatibility-banner .compatibility-actions{display:flex;gap:4px;align-items:center;flex:none;align-self:flex-start;flex-wrap:wrap}
.compatibility-banner .compatibility-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface);color:var(--text);font-family:inherit;font-size:12.5px;font-weight:550;line-height:1.2;white-space:nowrap;box-shadow:var(--shadow-sm);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s,box-shadow .15s,transform .1s,opacity .15s}
.compatibility-banner .compatibility-button:hover:not(:disabled){background:var(--surface-2)}
.compatibility-banner .compatibility-button:active:not(:disabled){transform:translateY(.5px)}
.compatibility-banner .compatibility-button:disabled{opacity:.48;cursor:not-allowed}
.compatibility-banner .compatibility-button:focus-visible{outline:2px solid var(--agent);outline-offset:2px}
.compatibility-banner .compatibility-button[aria-busy=true]::before{content:"";width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:compatibility-spin .7s linear infinite}
@keyframes compatibility-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.compatibility-banner .compatibility-button{transition-duration:.001ms!important;transition-delay:0s!important}.compatibility-banner .compatibility-button[aria-busy=true]::before{animation:none}}
`;

const safeCode = code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : '';
const recheckNotice = error => {
  const code = /^(?:SETTINGS|COMPATIBILITY)_[A-Z0-9_]{1,60}$/.test(error?.code || '')
    ? error.code : 'COMPATIBILITY_RECHECK_FAILED';
  const help = code === 'SETTINGS_AUTH_REQUIRED' ? '请重新连接并完成宿主身份验证后再试。'
    : code === 'SETTINGS_SECURE_CONNECTION_REQUIRED' ? '请通过已认证的本机直连或 HTTPS 连接重新检查。'
      : ['SETTINGS_UNAVAILABLE', 'COMPATIBILITY_UNAVAILABLE'].includes(code) ? '请重新打开插件详情页后再试。'
        : '请检查连接，稍后重试。';
  return `重新检查未完成 · ${code} · ${help}`;
};

function describe(report) {
  const code = safeCode(report?.code);
  if (report?.phase === 'blocked' && CORE_FAULTS.has(code)) {
    const belowMinimum = code === 'COMPATIBILITY_MINIMUM_REQUIRED';
    const transient = code === 'COMPATIBILITY_CORE_UNAVAILABLE';
    return {
      kind: 'blocked',
      tone: 'err',
      title: '核心搜索暂不可用',
      text: transient
        ? '搜索组件启动失败，可以重新尝试；不会转交官方搜索。'
        : code === 'CONTROL_SEARCH_SELECTION_CONFLICT'
        ? '搜索来源设置在接管期间发生变化；插件未覆盖当前配置，也未转交官方搜索。'
        : belowMinimum
        ? `当前 DSH 低于插件最低版本 ${report.minimumVersion || '0.2.1-rc.2'}，搜索已暂停；不会转交官方搜索。`
        : '搜索已暂停，当前不会转交官方搜索。',
      detail: transient
        ? '配置仍可编辑。重新检查将重试未完成的启动步骤。'
        : code === 'COMPATIBILITY_BLOCKED'
        ? '搜索启动被安全检查阻止。请检查宿主日志中的错误码，修复后重新启用插件；已有配置会保留。'
        : code === 'CONTROL_SEARCH_SELECTION_CONFLICT'
        ? '请检查当前搜索来源设置，再重新检查并接管。'
        : belowMinimum
        ? `宿主版本：${report.hostVersion || '无法识别'} · 插件版本：${report.pluginVersion || '无法识别'}`
        : '搜索接管未完成，可以重新检查；已有配置会保留。',
    };
  }
  if (report?.phase === 'degraded' && code === 'COMPATIBILITY_OPTIONAL_UNAVAILABLE') {
    const affected = Object.entries(report.optionalFeatures ?? {})
      .filter(([, feature]) => feature?.available === false && feature.code !== 'COMPATIBILITY_OPTIONAL_PENDING')
      .map(([name]) => OPTIONAL_LABELS[name])
      .filter(Boolean);
    return {
      kind: 'optional',
      tone: 'warn',
      title: '可选功能暂不可用',
      text: affected.length
        ? `${affected.join('、')}暂不可用；核心搜索不受影响。`
        : '部分可选功能暂不可用；核心搜索不受影响。',
      detail: `宿主版本：${report.hostVersion || '无法识别'} · 插件版本：${report.pluginVersion || '无法识别'}`,
    };
  }
  return null;
}

/** Backend reports own compatibility; manual operation failures have separate feedback. */
export function createCompatibilityView({ root, remote = null, parseReport, memory = null, timers = globalThis,
  reportTimeoutMs = 4000, recheckTimeoutMs = 20000, refreshIntervalMs = 5000 }) {
  function bindCachedReport() {
    if (!memory || typeof memory !== 'object') return null;
    if (remote && memory.remote === remote) return memory.report ?? null;
    memory.remote = remote;
    memory.report = null;
    return null;
  }
  let disposed = false, generation = 0, pending = null, report = bindCachedReport(), detailsOpen = false;
  let refreshTimer = null, recheckError = null;
  const flights = new Set();
  const document = root.ownerDocument;
  root.innerHTML = `<style>${COMPATIBILITY_CSS}</style><section class="compatibility-banner" data-tone="warn" role="status" aria-live="polite" aria-atomic="true" hidden>
    <span class="compatibility-mark" aria-hidden="true">!</span>
    <span class="compatibility-body"><span class="compatibility-title" data-compatibility-title></span>
      <span class="compatibility-text" data-compatibility-text></span>
      <span class="compatibility-detail" data-compatibility-detail hidden></span>
    </span>
    <span class="compatibility-actions">
      <button type="button" class="compatibility-button" data-compatibility-details aria-expanded="false" hidden>查看原因</button>
      <button type="button" class="compatibility-button" data-compatibility-recheck>重新检查</button>
    </span>
  </section>`;
  const $ = selector => root.querySelector(selector);
  const banner = $('.compatibility-banner'), title = $('[data-compatibility-title]');
  const text = $('[data-compatibility-text]'), detail = $('[data-compatibility-detail]');
  const detailsButton = $('[data-compatibility-details]'), recheckButton = $('[data-compatibility-recheck]');
  function render() {
    if (disposed) return;
    const state = describe(report);
    banner.hidden = !state && !recheckError;
    root.dataset.compatibilityPhase = state?.kind || 'normal';
    root.setAttribute('aria-busy', String(Boolean(pending)));
    text.textContent = [state?.text, recheckError].filter(Boolean).join(' ');
    if (!state && !recheckError) return;
    banner.dataset.tone = state?.tone || 'warn';
    title.textContent = state?.title || '重新检查未完成';
    detail.textContent = state?.detail || '';
    detail.hidden = !state || !detailsOpen;
    detailsButton.hidden = !state;
    detailsButton.setAttribute('aria-expanded', String(Boolean(state && detailsOpen)));
    detailsButton.textContent = detailsOpen ? '收起详情' : '查看原因';
    recheckButton.hidden = typeof remote?.recheckCompatibility !== 'function';
    recheckButton.disabled = pending?.method === 'recheckCompatibility';
    recheckButton.setAttribute('aria-busy', String(pending?.method === 'recheckCompatibility'));
    recheckButton.textContent = pending?.method === 'recheckCompatibility' ? '正在检查…' : '重新检查';
  }
  function scheduleRefresh() {
    timers.clearTimeout(refreshTimer);
    refreshTimer = null;
    if (disposed || pending || document.visibilityState === 'hidden'
      || typeof remote?.compatibilityReport !== 'function') return;
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      // A transport deadline cannot cancel the RPC. Do not accumulate hung background reads.
      if ([...flights].some(item => item.generation === generation && item.method === 'compatibilityReport')) {
        scheduleRefresh();
      } else void refresh();
    }, refreshIntervalMs);
  }
  function request(method, timeoutMs) {
    if (disposed || !remote) return Promise.resolve();
    if (pending && (method !== 'recheckCompatibility' || pending.method === method)) return pending.task;
    if ([...flights].filter(item => item.generation === generation && item.method === method).length >= 2) {
      return Promise.resolve();
    }
    timers.clearTimeout(pending?.timer);
    const mine = { method, generation, remote, timer: null, task: null };
    timers.clearTimeout(refreshTimer);
    refreshTimer = null;
    flights.add(mine);
    pending = mine;
    if (method === 'recheckCompatibility') recheckError = null;
    render();
    mine.timer = timers.setTimeout(() => {
      if (disposed || pending !== mine) return;
      pending = null;
      if (method === 'recheckCompatibility') recheckError = '重新检查未确认；后台可能仍在处理，页面会继续读取状态。';
      render();
      scheduleRefresh();
    }, timeoutMs);
    mine.task = Promise.resolve().then(() => {
      if (disposed || pending !== mine || mine.generation !== generation) return null;
      if (typeof mine.remote[method] !== 'function') {
        if (method === 'recheckCompatibility') throw Object.assign(new Error(), { code: 'COMPATIBILITY_UNAVAILABLE' });
        return null;
      }
      return mine.remote[method]();
    }).then(value => {
      if (!value || disposed || pending !== mine || mine.generation !== generation) return;
      const parsed = parseReport(value);
      if (JSON.stringify(describe(parsed)) !== JSON.stringify(describe(report))) {
        detailsOpen = false;
        recheckError = null;
      }
      if (method === 'recheckCompatibility') recheckError = null;
      report = parsed;
      if (memory?.remote === mine.remote) memory.report = parsed;
    }).catch(error => {
      if (disposed || pending !== mine || mine.generation !== generation) return;
      // Keep the accepted backend state; never expose raw transport details.
      if (method === 'recheckCompatibility') recheckError = recheckNotice(error);
    }).finally(() => {
      timers.clearTimeout(mine.timer);
      flights.delete(mine);
      if (disposed || mine.generation !== generation) return;
      if (pending === mine) {
        pending = null;
        render();
      }
      scheduleRefresh();
    });
    return mine.task;
  }
  const refresh = () => request('compatibilityReport', reportTimeoutMs);
  const recheck = () => request('recheckCompatibility', recheckTimeoutMs);
  const toggleDetails = () => {
    if (!describe(report)) return;
    detailsOpen = !detailsOpen;
    render();
  };
  const visible = () => {
    timers.clearTimeout(refreshTimer);
    refreshTimer = null;
    if (document.visibilityState !== 'hidden') void refresh();
  };
  detailsButton.addEventListener('click', toggleDetails);
  recheckButton.addEventListener('click', recheck);
  document.addEventListener('visibilitychange', visible);
  render();
  void refresh();
  return Object.freeze({
    refresh, recheck,
    bind(next) {
      if (disposed) return;
      if (remote === next) { void refresh(); return; }
      generation++;
      timers.clearTimeout(pending?.timer);
      timers.clearTimeout(refreshTimer);
      refreshTimer = null;
      pending = null;
      remote = next;
      report = bindCachedReport();
      detailsOpen = false;
      recheckError = null;
      render();
      void refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      timers.clearTimeout(pending?.timer);
      timers.clearTimeout(refreshTimer);
      detailsButton.removeEventListener('click', toggleDetails);
      recheckButton.removeEventListener('click', recheck);
      document.removeEventListener('visibilitychange', visible);
      pending = null;
      flights.clear();
      report = null;
      recheckError = null;
      root.replaceChildren();
    },
  });
}
