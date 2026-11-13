/**
 * Approved account panel; values come only from the authenticated host.
 * Cache identities never include cleartext credentials.
 */
export function createQuotaView(host) {
const { $, S, getDialog, dlg, active, DEF, SUPP, svg, EXT, esc, reduced, dialogBusy,
  remote, uuid, hideTip, hidden = value => typeof value === 'string' && value.startsWith('\u2063dsg-configured-secret:') } = host;
let D = null, disposed = false;
const QUOTA_PROVIDERS = new Set(SUPP);
const QUOTA_CONSOLE = {
  tavily: 'https://app.tavily.com', exa: 'https://dashboard.exa.ai',
  firecrawl: 'https://www.firecrawl.dev/app', tinyfish: 'https://agent.tinyfish.ai/wallet',
};
const QUOTA_ERRORS = {
  AUTH: '额度接口鉴权失败', RATE_LIMIT: '额度查询失败 · 请求限流',
  PERMISSION: '额度接口拒绝访问', BILLING: '账户或计费受限', ENDPOINT: '额度接口不存在',
  REDIRECT: '额度接口发生重定向', UPSTREAM: '额度服务异常', TIMEOUT: '额度查询超时',
  NETWORK: '额度查询失败 · 网络异常', CONFIG: '请检查查询参数',
  UNAVAILABLE: '额度查询失败', UNREPORTED: '额度接口未报告数据',
};
const QUOTA_ERROR_HELP = {
  AUTH: '额度接口鉴权失败。请核对 API Key 和查询权限；这不代表搜索一定不可用。',
  RATE_LIMIT: '额度查询请求受到限流，请稍后重试。',
  NETWORK: '未能完成额度查询，请检查网络或服务地址后重试。',
  UNAVAILABLE: '暂时未能取得额度信息，请稍后重试。额度查询失败不等于搜索不可用。',
  UNREPORTED: '接口未返回可识别的额度数据。未报告不代表余额为零。',
};
const quotaCache = new Map();
const QUOTA_CACHE_MS = 30_000;
const animations = new Set();
let quotaEpoch = 0;
function cancelAnimations() {
  for (const animation of animations) animation.cancel();
  animations.clear();
}
function animate(element, keyframes, options) {
  if (!element?.animate || disposed || reduced()) return;
  const animation = element.animate(keyframes, options);
  animations.add(animation);
  // Interrupted transitions reject finished; cancellation is normal cleanup.
  animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
}
const quotaTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function quotaBase(id, p) {
  const raw = id === 'tinyfish' ? p.searchUrl || DEF.tfSearch
    : p.url || DEF[id === 'firecrawl' ? 'fcUrl' : id + 'Url'];
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}
function quotaContext(id, p, keyIndex = 0) {
  const keys = id === 'tavily' ? p.keys : [p.key];
  const index = Math.max(0, Math.min(Number.isSafeInteger(keyIndex) ? keyIndex : 0, keys.length - 1));
  const key = (keys[index] || '').trim();
  const base = quotaBase(id, p);
  const official = id === 'tavily' ? base === DEF.tavilyUrl
    : id === 'exa' ? base === DEF.exaUrl
      : id === 'firecrawl' ? base === DEF.fcUrl || base === DEF.fcUrl + '/v2'
        : base === DEF.tfSearch;
  const savedKey = (id === 'tavily' ? D.base.keys[index] : D.base.key) || '';
  const draftSame = key === savedKey.trim() && base === quotaBase(id, D.base);
  // Only this dialog retains the current form identity. Cache keys never contain
  // credentials, and changing away/back cannot revive an in-flight draft reply.
  const signature = JSON.stringify([id, base, key, index]);
  if (D.quotaFormIdentity !== signature) {
    D.quotaFormIdentity = signature;
    D.quotaDraftId = uuid();
  }
  return { id, keyIndex: index, key, base, official, draftSame,
    scope: JSON.stringify([id, base, S.config?.quotaRevision || S.configRevision, index,
      draftSame ? 'saved' : D.quotaDraftId]) };
}
const quotaNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12;
function quotaValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const note = typeof value.note === 'string' ? value.note.slice(0, 2048) : '';
  if (value.kind === 'credits') return { kind: 'credits', note,
    ...Object.fromEntries(['used', 'plan', 'remaining', 'keyUsed', 'keyLimit', 'keyRemaining']
      .map(key => [key, quotaNumber(value[key]) ? value[key] : null])) };
  if (value.kind === 'wallet' && typeof value.balance === 'number'
    && Number.isFinite(value.balance) && Math.abs(value.balance) <= 1e12) {
    return { kind: 'wallet', balance: value.balance, note };
  }
  return null;
}
const quotaFormat = value => quotaNumber(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : '未报告';
function quotaView() {
  if (!D || D.kind !== 'card' || !QUOTA_PROVIDERS.has(D.id)) return null;
  const context = quotaContext(D.id, D.draft, D.quotaKeyIndex);
  const baselineCurrent = D.configBaseline.revision === S.configRevision && D.configBaseline.quotaRevision === S.config?.quotaRevision;
  const cached = quotaCache.get(context.scope);
  const status = !S.capabilities?.secretsAllowed ? 'restricted'
    : !context.key ? 'unconfigured' : !context.base ? 'invalid'
    : D.id === 'exa' ? 'unsupported'
      : !baselineCurrent ? 'stale'
      : D.quotaRequest?.scope === context.scope ? 'loading'
        : cached?.error ? 'error' : cached?.value ? 'ready' : 'unreported';
  return { context, status, cached, unchanged: baselineCurrent,
    canRefresh: context.key && baselineCurrent && !!context.base && D.id !== 'exa' && status !== 'loading' && !dialogBusy() && S.capabilities?.secretsAllowed };
}
function quotaHtml() {
  const view = quotaView();
  if (!view) return '';
  const { context, status, cached } = view;
  const select = context.id === 'tavily' && D.draft.keys.length > 1
    ? `<label class="qp-key"><select data-quota-key aria-label="查看哪个 Tavily Key 的额度">${D.draft.keys.map((_, index) =>
      `<option value="${index}"${index === context.keyIndex ? ' selected' : ''}>Key ${index + 1}</option>`).join('')}</select></label>` : '';
  const value = ['ready', 'loading', 'error'].includes(status) ? cached?.value : null;
  const credits = value?.kind === 'credits';
  const placeholder = {
    unconfigured: '填写 API Key 后可查询', invalid: 'Base URL 无效，请检查后查询',
    stale: '配置已在别处修改，读取最新配置后刷新',
    unsupported: '请到服务控制台查看', unreported: '尚未查询额度',
    error: (QUOTA_ERRORS[cached?.error] || '额度查询失败') + (cached?.httpStatus ? ` · HTTP ${cached.httpStatus}` : ''),
    loading: '正在查询额度…',
    restricted: '请使用本机直连或 HTTPS 查看额度',
  };
  const info = (kind, label, text) => `<button type="button" class="qp-info" data-quota-kind="${kind}" data-quota-tip="${esc(text)}" aria-label="${esc(label)}">${svg('info', 'ic')}</button>`;
  const stat = (label, amount, name, primary = false) => `<div class="qp-stat${primary ? ' is-primary' : ''}" data-stat="${name}">
    <span class="qp-label">${label}</span><div class="qp-amount"><strong class="qp-value${quotaNumber(amount) ? '' : ' is-unknown'}">${quotaFormat(amount)}</strong>${quotaNumber(amount) ? '<span class="qp-unit">credits</span>' : ''}</div></div>`;
  const metrics = credits ? `<div class="qp-stats">${stat('已用', value.used, 'used')}${stat('剩余', value.remaining, 'remaining', true)}</div>`
    : value?.kind === 'wallet' ? `<div class="qp-wallet"><span class="qp-label">钱包余额</span><div class="qp-amount"><span class="qp-currency">$</span><strong class="qp-value">${esc(value.balance)}</strong><span class="qp-unit">USD</span></div></div>` : '';
  const progress = credits && quotaNumber(value.used) && quotaNumber(value.plan) && value.plan > 0
    ? `<div class="qp-meter" role="meter" aria-label="账户已用额度" aria-valuemin="0" aria-valuemax="${value.plan}" aria-valuenow="${Math.min(value.plan, value.used)}" aria-valuetext="已用 ${quotaFormat(value.used)} credits，总额度 ${quotaFormat(value.plan)} credits"><i style="transform:scaleX(${Math.min(1, value.used / value.plan)})"></i></div>`
    : credits ? '<div class="qp-meter is-unreported" aria-hidden="true"></div>' : '';
  const hasKey = credits && context.id === 'tavily'
    && ['keyUsed', 'keyLimit', 'keyRemaining'].some(field => quotaNumber(value[field]));
  const restricted = hasKey && quotaNumber(value.remaining) && quotaNumber(value.keyRemaining)
    && value.keyRemaining < value.remaining;
  const keyNote = restricted ? `当前 Key 最多还可用 ${quotaFormat(value.keyRemaining)} credits。` : '';
  const accountInfo = context.id === 'tavily'
    ? keyNote ? info('key', '当前 Key 剩余额度', keyNote) : ''
    : value ? info('account', '额度统计说明', value.note) : '';
  const errorHelp = cached?.message ? `${cached.message} 额度查询失败不等于搜索不可用。`
    : QUOTA_ERROR_HELP[cached?.error] || QUOTA_ERROR_HELP.UNAVAILABLE;
  const stateText = status === 'loading' ? '正在刷新…' : status === 'error' && value
    ? `刷新失败 · 上次结果${cached?.httpStatus ? ` · HTTP ${cached.httpStatus}` : ''}`
    : value ? `更新于 ${cached.updatedAt}` : '';
  const stateIcon = status === 'error' ? info('error', '额度查询失败原因', errorHelp)
    : svg('info', 'ic qp-state-icon');
  const retry = status === 'error';
  const refreshHelp = view.canRefresh ? context.draftSame ? '刷新账户额度' : '查询当前表单的额度，不保存配置'
    : placeholder[status] || '请等待当前操作完成';
  const refresh = context.id === 'exa' ? '' : `<button type="button" class="qp-refresh${retry ? ' is-retry' : ''}" data-a="quota-refresh" aria-label="${retry ? '重新查询账户额度' : '刷新账户额度'}" title="${esc(refreshHelp)}"${view.canRefresh ? '' : ' disabled'} aria-busy="${status === 'loading'}">${svg('refresh', 'ic')}${retry ? '<span>重试</span>' : ''}</button>`;
  const tools = `<div class="qp-tools">${select}${refresh}</div>`;
  const consoleHelp = context.official ? '打开官方服务控制台'
    : '打开官方服务控制台；自定义服务的账户余额请以该服务提供方为准。';
  const consoleLink = `<a class="dlg-link qp-console" href="${QUOTA_CONSOLE[context.id]}" target="_blank" rel="noopener noreferrer" data-quota-kind="console" data-quota-tip="${consoleHelp}" aria-label="服务控制台（官方）">${EXT('服务控制台')}</a>`;
  const total = credits ? `<span class="qp-total">${quotaNumber(value.plan) ? `总额度 <b>${quotaFormat(value.plan)}</b> credits` : '总额度未报告'}</span>` : '';
  const updated = value ? `<span class="qp-updated" data-state="${status}">${status === 'error' ? info('error', '额度查询失败原因', `${errorHelp}\n上次更新：${cached.updatedAt}`) : ''}<span>${stateText}</span></span>` : '';
  return `<section class="quota-panel" id="quotaPanel" data-provider="${context.id}" data-state="${status}" data-kind="${esc(value?.kind || '')}" aria-labelledby="quotaTitle" aria-busy="${status === 'loading'}">
    <header class="qp-head"><div class="qp-heading"><h3 id="quotaTitle">账户额度</h3>${consoleLink}</div>${tools}</header>
    <div class="qp-content"><div class="qp-main" aria-live="polite" aria-atomic="true">
      ${value ? `${metrics}${progress}<div class="qp-summary"><span class="qp-account-meta">${total}${accountInfo}</span>${updated}</div>`
        : `<div class="qp-empty"><div class="qp-placeholder" data-state="${status}">${stateIcon}<span>${placeholder[status] || '额度尚未查询'}</span></div></div>`}
    </div></div></section>`;
}
function renderQuota() {
  const slot = $('#quotaSlot', dlg);
  if (!slot || !D || D.kind !== 'card') return;
  const html = quotaHtml();
  if (slot._html === html) return;
  const focused = active()?.closest('#quotaSlot')?.querySelector(':focus');
  const focusedTip = focused?.dataset.quotaKind;
  const focusKind = focused?.hasAttribute('data-quota-key') ? 'select'
    : focusedTip ? 'tip'
    : focused?.dataset.a === 'quota-refresh' || focused?.id === 'quotaPanel' ? 'refresh' : null;
  const previousMeter = $('.qp-meter i', slot);
  const previousTransform = previousMeter && getComputedStyle(previousMeter).transform;
  // CSS-pixel heights stay correct under browser/CSS zoom. Client rects scale.
  const previousHeight = parseFloat(getComputedStyle(slot).height);
  const previousState = $('#quotaPanel', slot)?.dataset.state;
  cancelAnimations();
  hideTip?.();
  slot._html = html;
  slot.innerHTML = html;
  const nextHeight = parseFloat(getComputedStyle(slot).height);
  if (previousHeight && Math.abs(nextHeight - previousHeight) > 1) {
    animate(slot, [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
      { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  if (previousState && previousState !== $('#quotaPanel', slot)?.dataset.state) {
    animate($('.qp-main', slot), [{ opacity: .65 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
  }
  const meter = $('.qp-meter i', slot);
  if (meter && previousTransform) animate(meter, [
    { transform: previousTransform }, { transform: meter.style.transform },
  ], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
  if (focusKind) {
    const target = focusKind === 'select' ? $('[data-quota-key]', slot)
      : focusKind === 'tip' ? $(`[data-quota-kind="${focusedTip}"]`, slot) : $('[data-a=quota-refresh]', slot);
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else {
      const panel = $('#quotaPanel', slot);
      panel.tabIndex = -1;
      panel.focus({ preventScroll: true });
    }
  }
}
function cancel() {
  cancelAnimations();
  hideTip?.();
  const request = D?.quotaRequest;
  if (request) void remote.cancelDiagnosis({ operationId: request.operationId }).catch(() => {});
  if (D) D.quotaRequest = null;
  quotaEpoch++;
}
function syncDialog() {
  const next = getDialog();
  if (D !== next) cancel();
  D = next;
}
function render() {
  if (disposed) return;
  syncDialog();
  const view = quotaView();
  // Both saved and draft reads are cancelled when their account identity changes.
  if (D?.quotaRequest && (!view?.unchanged || !S.capabilities?.secretsAllowed
    || D.quotaRequest.scope !== view.context.scope)) cancel();
  renderQuota();
}
async function refresh({ automatic = false } = {}) {
  syncDialog();
  const view = quotaView();
  if (disposed) return;
  // A manual click on a panel drawn before the state changed still explains why.
  if (!view?.canRefresh) { if (!automatic) renderQuota(); return; }
  const age = Date.now() - (view.cached?.completedAt ?? -Infinity);
  if (automatic && age >= 0 && age < QUOTA_CACHE_MS) return;
  const mine = D, epoch = quotaEpoch;
  const request = { scope: view.context.scope, operationId: uuid() };
  mine.quotaRequest = request;
  renderQuota();
  const previous = quotaCache.get(request.scope);
  try {
    const query = view.context.draftSame ? remote.accountQuota : remote.previewAccountQuota;
    const savedKey = (D.id === 'tavily' ? D.base.keys[view.context.keyIndex] : D.base.key) || '';
    const result = await query({ provider: view.context.id, keyIndex: view.context.keyIndex,
      ...(!view.context.draftSame ? { draft: {
        ...(view.context.base !== quotaBase(D.id, D.base) ? { baseUrl: view.context.base } : {}),
        ...(!hidden(view.context.key) && view.context.key !== savedKey.trim() ? { apiKey: view.context.key } : {}),
      } } : {}),
      expectedRevision: mine.configBaseline.revision, quotaRevision: mine.configBaseline.quotaRevision, operationId: request.operationId });
    if (disposed || getDialog() !== mine || epoch !== quotaEpoch || mine.quotaRequest !== request) return;
    D = mine; mine.quotaRequest = null;
    const current = quotaView();
    if (!current?.unchanged || !S.capabilities?.secretsAllowed || current.context.scope !== request.scope) return;
    const value = quotaValue(result?.value);
    quotaCache.set(request.scope, { value, updatedAt: quotaTime(),
      completedAt: Date.now(), error: value ? null : 'UNREPORTED' });
  } catch (error) {
    if (disposed || getDialog() !== mine || epoch !== quotaEpoch || mine.quotaRequest !== request) return;
    D = mine; mine.quotaRequest = null;
    const current = quotaView();
    if (!current?.unchanged || !S.capabilities?.secretsAllowed || current.context.scope !== request.scope) return;
    const category = error?.details?.category;
    const status = error?.details?.httpStatus;
    quotaCache.set(request.scope, { value: previous?.value ?? null, updatedAt: previous?.updatedAt,
      completedAt: Date.now(), error: Object.hasOwn(QUOTA_ERRORS, category) ? category : 'UNAVAILABLE',
      httpStatus: Number.isInteger(status) && status >= 300 && status <= 599 ? status : null,
      message: error?.code === 'QUOTA_QUERY_FAILED' ? error.message
        : `设置服务返回 ${/^[\w./-]{1,80}$/.test(error?.code || '') ? error.code : '未知错误'}；额度查询失败不代表搜索不可用。` });
  } finally {
    while (quotaCache.size > 16) quotaCache.delete(quotaCache.keys().next().value);
    if (!disposed && getDialog() === mine) { D = mine; renderQuota(); }
  }
}
return Object.freeze({
  render,
  stale() { syncDialog(); return quotaView()?.status === 'stale'; },
  open() { render(); return refresh({ automatic: true }); },
  refresh, cancel,
  stopAnimations: cancelAnimations,
  key(index) {
    if (disposed || dialogBusy()) return;
    syncDialog();
    if (D) {
      cancel(); D.quotaKeyIndex = index; renderQuota();
      return refresh({ automatic: true });
    }
  },
  dispose() { cancel(); disposed = true; D = null; quotaCache.clear(); },
});
}
