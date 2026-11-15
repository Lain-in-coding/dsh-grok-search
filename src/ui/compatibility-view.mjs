const PHASE_TEXT = Object.freeze({
  initial: '等待兼容性检查', checking: '正在检查兼容性', 'waiting-confirmation': '实验版本需要确认',
  ready: '核心搜索已就绪', degraded: '部分可选功能不可用', blocked: '兼容性检查未通过', stopped: '插件已停止',
});
const FEATURE_TEXT = Object.freeze({ settings: '完整设置', chat: '聊天搜索卡片', github: 'GitHub 读取' });
const OPTIONAL_PENDING = 'COMPATIBILITY_OPTIONAL_PENDING';
const OPTIONAL_POLL_LIMIT = 10;
const featurePending = feature => feature.code === OPTIONAL_PENDING;
// Keep route.css tokens and measurements without sharing its structural selectors.
const COMPATIBILITY_CSS = `
.compatibility-banner,.compatibility-banner *{box-sizing:border-box}
.compatibility-banner[hidden],.compatibility-banner [hidden]{display:none!important}
.compatibility-banner{display:flex;align-items:flex-start;gap:10px;padding:10px 10px 10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);font-size:12.5px;color:var(--text-2);margin-bottom:12px;flex-wrap:wrap}
.compatibility-banner .compatibility-body{flex:1;min-width:0}
.compatibility-banner .compatibility-title{display:block;color:var(--text);font-weight:600}
.compatibility-banner .compatibility-text{display:block;margin-top:1px}
.compatibility-banner .compatibility-actions{display:flex;gap:4px;align-items:center;flex:none;align-self:center;flex-wrap:wrap}
.compatibility-banner[data-tone=warn]{background:var(--warn-soft);border-color:transparent}
.compatibility-banner[data-tone=err]{background:var(--surface-2);border-color:var(--line-2)}
.compatibility-banner[data-tone=err] .compatibility-title{color:var(--err-text)}
.compatibility-banner[data-tone=err] .compatibility-text{color:var(--text-2)}
.compatibility-banner .compatibility-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface);color:var(--text);font-family:inherit;font-size:12px;font-weight:550;line-height:1;white-space:nowrap;box-shadow:var(--shadow-sm);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s,box-shadow .15s,transform .1s,opacity .15s}
.compatibility-banner .compatibility-button:hover:not(:disabled){background:var(--surface-2)}
.compatibility-banner .compatibility-button:active:not(:disabled){transform:translateY(.5px)}
.compatibility-banner .compatibility-button:disabled{opacity:.48;cursor:not-allowed}
.compatibility-banner .compatibility-button:focus-visible{outline:2px solid var(--agent);outline-offset:2px}
.compatibility-banner .compatibility-button-primary{background:var(--btn-primary);border-color:var(--btn-primary);color:#fff}
.compatibility-banner .compatibility-button-primary:hover:not(:disabled){background:var(--btn-primary-hover);border-color:var(--btn-primary-hover)}
.compatibility-banner .compatibility-check{position:relative;display:flex;align-items:flex-start;gap:9px;padding:6px 8px;margin:0 -8px;border-radius:8px;cursor:pointer}
.compatibility-banner .compatibility-check:hover{background:var(--surface-2)}
.compatibility-banner .compatibility-risk{position:absolute;opacity:0;pointer-events:none}
.compatibility-banner .compatibility-box{flex:none;width:16px;height:16px;margin-top:1px;border-radius:5px;border:1.5px solid var(--line-2);background:var(--surface);display:grid;place-items:center;color:#fff;transition:background-color .15s,border-color .15s}
.compatibility-banner .compatibility-box svg{width:11px;height:11px;opacity:0;transform:scale(.6);transition:opacity .15s,transform .2s var(--spring)}
.compatibility-banner .compatibility-risk:checked + .compatibility-box{background:var(--btn-primary);border-color:var(--btn-primary)}
.compatibility-banner .compatibility-risk:checked + .compatibility-box svg{opacity:1;transform:none}
.compatibility-banner .compatibility-risk:focus-visible + .compatibility-box{outline:2px solid var(--agent);outline-offset:2px}
.compatibility-banner .compatibility-check-text{display:flex;flex-direction:column;font-size:12.5px;font-weight:550}
.compatibility-banner .compatibility-check-text small{color:var(--text-3);font-size:11.5px;font-weight:400}
@media (prefers-reduced-motion:reduce){
  .compatibility-banner .compatibility-button,.compatibility-banner .compatibility-box,.compatibility-banner .compatibility-box svg{transition-duration:.001ms!important;transition-delay:0s!important}
}`;
const errorCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '')
  || /^gateway[/.][\w./-]{1,64}$/.test(error?.code || '') ? error.code : 'COMPATIBILITY_UNAVAILABLE';
const pairKey = report => JSON.stringify([report.hostVersion, report.pluginVersion]);
const experimental = report => !['stable', 'rc'].includes(report.channel);
const canConfirm = report => report?.phase === 'waiting-confirmation' && report.minimumAdmitted === true
  && report.confirmationRequired === true && report.confirmed === false && experimental(report)
  && (report.code === null || report.code === 'COMPATIBILITY_CONFIRMATION_REQUIRED')
  && typeof report.revision === 'string' && typeof report.hostVersion === 'string'
  && typeof report.pluginVersion === 'string';

/** Independent from settings snapshots: failure here never cancels their refresh. */
export function createCompatibilityView({ root, remote = null, parseReport, memory = {}, onReport = () => {},
  timers = globalThis, timeoutMs = 4000, pollMs = 3000 }) {
  let disposed = false, generation = 0, pending = null, report = null, error = null, accepted = false, poll = null;
  let optionalPolls = 0;
  const document = root.ownerDocument;
  const dismissed = memory.dismissed ||= new Set();
  root.innerHTML = `<style>${COMPATIBILITY_CSS}</style><section class="compatibility-banner" data-tone="info" aria-labelledby="compatibilityTitle">
    <span class="compatibility-body"><span class="compatibility-title" id="compatibilityTitle">兼容性状态</span>
      <span class="compatibility-text" data-compatibility-state role="status" aria-live="polite"></span>
      <span class="compatibility-text" data-compatibility-pair></span>
      <span class="compatibility-text" data-compatibility-features></span>
      <span class="compatibility-text" data-compatibility-notice hidden>此宿主与插件组合尚未验证。稳定版与 RC 会自动检查并继续，不需要实验风险确认；这不代表已完成宿主实测。</span>
      <label class="compatibility-check" data-compatibility-consent hidden><input type="checkbox" class="compatibility-risk" data-compatibility-risk>
        <span class="compatibility-box" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3 3 7-7"/></svg></span><span class="compatibility-check-text">我理解当前精确版本组合的实验风险
          <small>仅确认实验风险，不绕过核心能力、安全、预算或接管校验。</small></span></label>
      <span class="compatibility-text" data-compatibility-error role="alert" hidden></span>
    </span>
    <span class="compatibility-actions">
      <button type="button" class="compatibility-button" data-compatibility-refresh>刷新状态</button>
      <button type="button" class="compatibility-button" data-compatibility-dismiss hidden>知道了</button>
      <button type="button" class="compatibility-button compatibility-button-primary" data-compatibility-confirm hidden>确认此版本组合</button>
    </span></section>`;
  const $ = selector => root.querySelector(selector);
  const state = $('[data-compatibility-state]'), pair = $('[data-compatibility-pair]');
  const features = $('[data-compatibility-features]'), notice = $('[data-compatibility-notice]');
  const consent = $('[data-compatibility-consent]'), risk = $('[data-compatibility-risk]');
  const failure = $('[data-compatibility-error]'), refreshButton = $('[data-compatibility-refresh]');
  const dismissButton = $('[data-compatibility-dismiss]'), confirmButton = $('[data-compatibility-confirm]');
  const noticeVisible = () => report?.verification === 'unverified' && ['stable', 'rc'].includes(report.channel)
    && report.minimumAdmitted && !['blocked', 'stopped'].includes(report.phase)
    && typeof report.hostVersion === 'string' && typeof report.pluginVersion === 'string'
    && !report.confirmationRequired && !report.notified && !dismissed.has(pairKey(report));
  function render() {
    if (disposed) return;
    const reportCode = report?.code === OPTIONAL_PENDING ? null : report?.code;
    const optional = report ? Object.values(report.optionalFeatures) : [];
    // Pending observations are not failures; keep the server phase and report intact.
    const awaitingOnly = report?.phase === 'degraded' && !reportCode && optional.some(featurePending)
      && optional.every(feature => featurePending(feature) || (feature.available && !feature.code));
    root.dataset.compatibilityPhase = error ? 'unavailable' : report?.phase || 'initial';
    $('.compatibility-banner').dataset.tone = error || report?.phase === 'blocked' ? 'err'
      : canConfirm(report) || (report?.phase === 'degraded' && !awaitingOnly) ? 'warn' : 'info';
    state.textContent = error ? '兼容性状态暂不可读；此读取失败不会改变已有搜索或设置状态。'
      : report ? `${awaitingOnly ? '可选功能状态待确认' : PHASE_TEXT[report.phase]}${report.coreReady ? ' · 核心能力可用' : ' · 核心就绪尚未确认'}`
        : remote ? '正在读取兼容性状态…' : '当前服务器未提供兼容性报告；原有设置仍按自身状态工作。';
    pair.textContent = report ? `宿主 ${report.hostVersion ?? '未识别'} · 插件 ${report.pluginVersion ?? '未识别'}`
      + ` · ${report.verification === 'verified' ? '已验证组合' : '未验证组合'}${report.confirmed ? ' · 已确认实验风险' : ''}` : '';
    features.textContent = report ? Object.entries(FEATURE_TEXT).map(([key, label]) => {
      const feature = report.optionalFeatures[key];
      if (featurePending(feature)) return `${label}：${key === 'chat' ? '客户端状态待确认' : '状态待确认'}`;
      return `${label}：${feature.available ? '可用' : '不可用'}${feature.code ? `（${feature.code}）` : ''}`;
    }).join('；') : '';
    const shownNotice = noticeVisible();
    notice.hidden = dismissButton.hidden = !shownNotice;
    consent.hidden = confirmButton.hidden = !canConfirm(report);
    risk.checked = accepted;
    risk.disabled = Boolean(pending || error);
    confirmButton.disabled = !canConfirm(report) || !accepted || Boolean(pending || error);
    confirmButton.textContent = pending?.method === 'confirmCompatibility' ? '正在确认…' : '确认此版本组合';
    refreshButton.disabled = !remote || Boolean(pending);
    dismissButton.disabled = Boolean(pending || error);
    dismissButton.textContent = typeof remote?.acknowledgeCompatibilityNotice === 'function' ? '知道了' : '本次会话不再提示';
    failure.hidden = !error && !reportCode;
    failure.textContent = error ? `${error} · 请刷新状态后重试；不会自动重试确认。` : reportCode || '';
    root.setAttribute('aria-busy', String(Boolean(pending)));
  }
  function schedule() {
    timers.clearTimeout(poll);
    poll = null;
    const checking = ['initial', 'checking'].includes(report?.phase || 'initial');
    const optionalPending = report?.coreReady === true && ['ready', 'degraded'].includes(report.phase)
      && ['settings', 'github'].some(name => featurePending(report.optionalFeatures[name]));
    if (!disposed && remote && !error && !pending
      && (checking || optionalPending && optionalPolls < OPTIONAL_POLL_LIMIT)) {
      poll = timers.setTimeout(() => {
        poll = null;
        if (document.visibilityState === 'hidden') schedule();
        else {
          // A hung server optional gets a bounded follow-up window per binding, not per report.
          if (optionalPending) optionalPolls++;
          void refresh();
        }
      }, pollMs);
    }
  }
  function receive(value) {
    let next;
    try { next = parseReport(value); }
    catch { throw Object.assign(new Error('Invalid compatibility report'), { code: 'COMPATIBILITY_REPORT_INVALID' }); }
    if (JSON.stringify(next) !== JSON.stringify(report)) accepted = false;
    report = next;
    error = null;
    onReport(next);
  }
  function request(method, payload) {
    if (disposed || !remote) return Promise.resolve();
    if (pending) return pending.task;
    const mine = { method, generation, remote, timer: null, expired: false, task: null };
    pending = mine;
    timers.clearTimeout(poll);
    poll = null;
    error = null;
    render();
    mine.timer = timers.setTimeout(() => {
      if (disposed || pending !== mine) return;
      mine.expired = true;
      error = 'COMPATIBILITY_READ_TIMEOUT';
      accepted = false;
      render();
      // The transport still owns the outstanding call; do not stack retries.
    }, timeoutMs);
    mine.task = Promise.resolve().then(() => {
      if (disposed || pending !== mine || mine.generation !== generation) return;
      if (typeof mine.remote[method] !== 'function') throw Object.assign(new Error('Unavailable method'), { code: 'COMPATIBILITY_UNAVAILABLE' });
      return payload === undefined ? mine.remote[method]() : mine.remote[method](payload);
    }).then(value => {
      if (disposed || pending !== mine || mine.generation !== generation || mine.expired) return;
      if (payload && (value?.hostVersion !== payload.hostVersion || value?.pluginVersion !== payload.pluginVersion)) {
        throw Object.assign(new Error('Compatibility identity changed'), { code: 'COMPATIBILITY_PAIR_MISMATCH' });
      }
      receive(value);
    }).catch(reason => {
      if (disposed || pending !== mine || mine.generation !== generation || mine.expired) return;
      error = errorCode(reason);
      accepted = false;
    }).finally(() => {
      timers.clearTimeout(mine.timer);
      if (disposed || pending !== mine) return;
      pending = null;
      render();
      schedule();
    });
    return mine.task;
  }
  function refresh() { return request('compatibilityReport'); }
  function mutation() {
    return { expectedRevision: report.revision, hostVersion: report.hostVersion, pluginVersion: report.pluginVersion };
  }
  function confirm() {
    if (disposed || pending || error || !accepted || !canConfirm(report)) return Promise.resolve();
    accepted = false;
    return request('confirmCompatibility', { ...mutation(), acceptRisk: true });
  }
  function dismiss() {
    if (disposed || pending || error || !noticeVisible()) return Promise.resolve();
    if (typeof remote?.acknowledgeCompatibilityNotice === 'function' && typeof report.revision === 'string') {
      return request('acknowledgeCompatibilityNotice', mutation());
    }
    dismissed.add(pairKey(report));
    if (dismissed.size > 128) dismissed.delete(dismissed.values().next().value);
    render();
    return Promise.resolve();
  }
  const changeRisk = () => { accepted = risk.checked && canConfirm(report) && !pending && !error; render(); };
  const visible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
  risk.addEventListener('change', changeRisk);
  refreshButton.addEventListener('click', refresh);
  confirmButton.addEventListener('click', confirm);
  dismissButton.addEventListener('click', dismiss);
  document.addEventListener('visibilitychange', visible);
  render();
  void refresh();
  return Object.freeze({
    refresh, confirm, dismiss,
    bind(next) {
      if (disposed || remote === next) return;
      generation++;
      timers.clearTimeout(poll);
      timers.clearTimeout(pending?.timer);
      pending = null;
      remote = next;
      report = null;
      error = null;
      accepted = false;
      optionalPolls = 0;
      onReport(null);
      render();
      void refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      timers.clearTimeout(poll);
      timers.clearTimeout(pending?.timer);
      risk.removeEventListener('change', changeRisk);
      refreshButton.removeEventListener('click', refresh);
      confirmButton.removeEventListener('click', confirm);
      dismissButton.removeEventListener('click', dismiss);
      document.removeEventListener('visibilitychange', visible);
      pending = null;
      report = null;
      root.replaceChildren();
    },
  });
}
