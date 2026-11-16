const CORE_FAULTS = new Set([
  'COMPATIBILITY_PLUGIN_INVALID', 'COMPATIBILITY_MINIMUM_REQUIRED',
  'COMPATIBILITY_CORE_SHAPE', 'COMPATIBILITY_ABI_UNSUPPORTED',
  'COMPATIBILITY_CONTRACT_FAILED', 'COMPATIBILITY_PROBE_INVALID',
  'COMPATIBILITY_ROUTE_UNCONFIRMED',
  'COMPATIBILITY_BUDGET_UNCONFIRMED', 'COMPATIBILITY_CORE_UNAVAILABLE',
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
        ? '暂时无法确认搜索安全状态，插件已暂停接管；不会转交官方搜索。'
        : belowMinimum
        ? `当前 DSH 低于插件最低版本 ${report.minimumVersion || '0.2.1-rc.2'}，搜索已暂停；不会转交官方搜索。`
        : '搜索已暂停，当前不会转交官方搜索。',
      detail: transient
        ? '可以重新检查；状态确认前，搜索保持暂停。'
        : belowMinimum
        ? `宿主版本：${report.hostVersion || '无法识别'} · 插件版本：${report.pluginVersion || '无法识别'}`
        : '只有确认搜索接管链路可安全运行后，插件才会恢复搜索。',
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

/** Shows only backend-confirmed compatibility states; transport errors stay invisible. */
export function createCompatibilityView({ root, remote = null, parseReport, timers = globalThis,
  reportTimeoutMs = 4000, recheckTimeoutMs = 12000 }) {
  let disposed = false, generation = 0, pending = null, report = null, detailsOpen = false;
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
    banner.hidden = !state;
    root.dataset.compatibilityPhase = state?.kind || 'normal';
    if (!state) return;
    banner.dataset.tone = state.tone;
    title.textContent = state.title;
    text.textContent = state.text;
    detail.textContent = state.detail;
    detail.hidden = !detailsOpen;
    detailsButton.hidden = false;
    detailsButton.setAttribute('aria-expanded', String(detailsOpen));
    detailsButton.textContent = detailsOpen ? '收起详情' : '查看原因';
    recheckButton.hidden = typeof remote?.recheckCompatibility !== 'function';
    recheckButton.disabled = Boolean(pending);
    recheckButton.setAttribute('aria-busy', String(pending?.method === 'recheckCompatibility'));
    recheckButton.textContent = pending?.method === 'recheckCompatibility' ? '正在检查…' : '重新检查';
    root.setAttribute('aria-busy', String(Boolean(pending)));
  }
  function request(method, timeoutMs) {
    if (disposed || !remote || pending) return pending?.task ?? Promise.resolve();
    const mine = { method, generation, remote, timer: null, task: null };
    pending = mine;
    render();
    mine.timer = timers.setTimeout(() => {
      if (disposed || pending !== mine) return;
      pending = null;
      render();
    }, timeoutMs);
    mine.task = Promise.resolve().then(() => {
      if (disposed || pending !== mine || mine.generation !== generation) return null;
      if (typeof mine.remote[method] !== 'function') return null;
      return mine.remote[method]();
    }).then(value => {
      if (!value || disposed || pending !== mine || mine.generation !== generation) return;
      const parsed = parseReport(value);
      report = parsed;
      detailsOpen = false;
    }).catch(() => {
      // RPC failure is not evidence that the host or plugin is incompatible.
    }).finally(() => {
      timers.clearTimeout(mine.timer);
      if (disposed || pending !== mine) return;
      pending = null;
      render();
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
      if (disposed || remote === next) return;
      generation++;
      timers.clearTimeout(pending?.timer);
      pending = null;
      remote = next;
      report = null;
      detailsOpen = false;
      render();
      void refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      timers.clearTimeout(pending?.timer);
      detailsButton.removeEventListener('click', toggleDetails);
      recheckButton.removeEventListener('click', recheck);
      document.removeEventListener('visibilitychange', visible);
      pending = null;
      report = null;
      root.replaceChildren();
    },
  });
}
