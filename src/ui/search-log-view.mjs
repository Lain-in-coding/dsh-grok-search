/**
 * Approved search-log presentation, with real gateway records only.
 * Self-contained browser factory; shared animation helpers are injected.
 */
export function createSearchLogView(host) {
const { $, $$, active, S, card, layer, listen, remote, uuid, clone, esc, svg, tile,
  logoSrc, isDark, reduced, META, SUPP, setTimeout, clearTimeout, requestAnimationFrame,
  cancelAnimationFrame, T, jolts, faultPulses, syncBreak, travel, jolt, pulseFault,
  flashRow, flashNode, pumpWires, closePop, hideStripTip: hideRouteTip, toast, errText, rowOf, SVGNS, logMemory,
  onPrivateAccessDenied } = host;
const HUB_DISPLAY_NAME = 'Grok Search Rs';
const sessionId = uuid();
let disposed = false, readTask = null, generation = 0, clearing = false, pollTimer = 0;
let readSignature = null;
// The first readable snapshot of a mount is a baseline, not new activity.
let logBaselined = false, logRestricted = false;
let logReadError = null;




const routeTooltip = $('#logTooltip');
let stripTipTarget = null, stripTipTimer = 0;
function hideStripTip() {
  clearTimeout(stripTipTimer);
  stripTipTarget?.removeAttribute('aria-describedby');
  stripTipTarget = null;
  routeTooltip.hidden = true;
  routeTooltip.textContent = '';
  delete routeTooltip.dataset.kind;
}
function showStripTip(node) {
  hideRouteTip();
  const logTip = true;
  if (!node?.isConnected || node.closest('[inert]')) {
    hideStripTip(); return;
  }
  clearTimeout(stripTipTimer);
  if (stripTipTarget !== node) stripTipTarget?.removeAttribute('aria-describedby');
  stripTipTarget = node;
  routeTooltip.textContent = logTip ? node.dataset.logTip : node._tip;
  routeTooltip.dataset.kind = logTip ? 'log' : 'route';
  routeTooltip.hidden = false;
  node.setAttribute('aria-describedby', 'logTooltip');
  const r = node.getBoundingClientRect();
  const t = routeTooltip.getBoundingClientRect();
  routeTooltip.style.left = Math.max(12, Math.min(innerWidth - t.width - 12, r.left + r.width / 2 - t.width / 2)) + 'px';
  routeTooltip.style.top = Math.max(12, r.bottom + t.height + 10 < innerHeight ? r.bottom + 8 : r.top - t.height - 8) + 'px';
}
function syncFocusedLogTip() {
  const node = stripTipTarget;
  if (node?.matches('[data-log-tip]') && node.isConnected && active() === node) {
    const bounds = node.getBoundingClientRect(), list = $('#logList').getBoundingClientRect();
    if (bounds.bottom > Math.max(0, list.top) && bounds.top < Math.min(innerHeight, list.bottom)
      && bounds.right > 0 && bounds.left < innerWidth) {
      showStripTip(node);
      return;
    }
  }
  hideStripTip();
}

listen(routeTooltip, 'pointerenter', () => clearTimeout(stripTipTimer));
listen(routeTooltip, 'pointerleave', () => { if (stripTipTarget !== active()) hideStripTip(); });
listen(document, 'keydown', event => { if (event.key === 'Escape') hideStripTip(); });
listen(window, 'resize', hideStripTip);
listen(window, 'scroll', event => { if (!routeTooltip.contains(event.target)) syncFocusedLogTip(); }, true);
listen($('#logList'), 'scroll', syncFocusedLogTip);
const LOG_CAP = 20;
const LOG_KINDS = new Set(['ok', 'sources', 'fallback', 'failed', 'running', 'cancelled', 'unknown', 'released', 'enabled', 'official']);
const LOG_CHANNELS = new Set(['grok', 'grok-sources', ...SUPP]);
const LOG_CHIP = {
  ok: ['ok', 'Grok 返回'], sources: ['ok', '补充来源'],
  fallback: ['warn', '已回退'], failed: ['err', '搜索失败'],
  running: ['run', '处理中'], cancelled: ['idle', '已取消'], released: ['idle', '官方已恢复'],
  enabled: ['idle', '插件已启用'], official: ['idle', '官方搜索'], unknown: ['idle', '结果未完整记录'],
};
const USAGE_CHANNELS = new Set(['grok', 'grok-sources', ...SUPP, 'deepseek']);
const USAGE_OPERATIONS = { search: '搜索', supplement: '补充搜索', fetch: '网页提取', retry: '重试' };
const USAGE_RESULTS = { ok: '成功', failed: '失败', running: '处理中', cancelled: '已取消', unknown: '未报告' };
function normalizeUsage(input) {
  const rows = Array.isArray(input) ? input : [];
  return rows.slice(0, 16).filter(item => item && USAGE_CHANNELS.has(item.provider)).map(item => {
    const basis = ['reported', 'estimated'].includes(item.charge?.basis) ? item.charge.basis : 'unknown';
    const amount = basis !== 'unknown' && Number.isFinite(item.charge?.amount)
      && item.charge.amount >= 0 && item.charge.amount <= 1e9 ? item.charge.amount : null;
    const expectedUnit = item.provider === 'tavily' || item.provider === 'firecrawl' ? 'credits' : 'USD';
    const unit = item.charge?.unit === expectedUnit ? expectedUnit : null;
    const keyIndex = item.provider === 'tavily' && Number.isSafeInteger(item.keyIndex) && item.keyIndex >= 0 && item.keyIndex < 100
      ? item.keyIndex : null;
    return {
      provider: item.provider,
      operation: Object.hasOwn(USAGE_OPERATIONS, item.operation) ? item.operation : 'search',
      result: Object.hasOwn(USAGE_RESULTS, item.result) ? item.result : 'unknown',
      ...(item.evidence === 'source-label' ? { evidence: 'source-label' } : {}),
      code: /^[\w.-]{1,64}$/.test(item.code || '') ? item.code : '',
      keyIndex,
      charge: { basis: amount === null || !unit ? 'unknown' : item.provider === 'exa' ? 'estimated' : basis, amount, unit },
    };
  });
}
let logRows = [];
let logFilter = 'all';

let logSequence = 0;
let logEpoch = 0;
let logPrivate = logMemory?.private === true;

let logRoutePlayback = null;
let logReplayReturn = null;
const logOpen = new Set();
const logNodes = new Map();
const logFingerprints = new WeakMap();
const logEvent = rec => rec.kind === 'released' || rec.kind === 'enabled';
const logReplayable = rec => ['ok', 'sources', 'fallback', 'failed', 'official'].includes(rec.kind);
const logTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function normalizeLog(input, child = false) {
  if (!input || !LOG_KINDS.has(input.kind)) throw new TypeError('Unknown search log state.');
  const calls = logEvent(input) ? [] : normalizeUsage(input.calls);
  const record = {
    id: /^search-log-[0-9]+$/.test(input.id) ? input.id : `search-log-${++logSequence}`,
    t: String(input.t || (Number.isFinite(input.at) ? new Date(input.at).toLocaleTimeString('zh-CN', { hour12: false }) : logTime())).slice(0, 60),
    q: String(input.q || '').slice(0, 5000),
    kind: input.kind,
    served: LOG_CHANNELS.has(input.served) ? input.served : null,
    ms: !logEvent(input) && Number.isFinite(input.ms) && input.ms >= 0 && input.ms <= Number.MAX_SAFE_INTEGER ? input.ms : null,
    official: !logEvent(input) && Number.isSafeInteger(input.official) && input.official >= 0 ? input.official : null,
    reason: /^[\w.-]{1,64}$/.test(input.reason || '') ? input.reason : '',
    detail: String(input.detail || '').slice(0, 3000),
    calls,
    callsComplete: !logEvent(input) && input.callsComplete === true
      && Array.isArray(input.calls) && input.calls.length === calls.length,
    epoch: logEpoch,
  };
  if (Array.isArray(input.resultProviders) && !logEvent(input)) {
    record.resultProviders = [...new Set(input.resultProviders.filter(provider =>
      LOG_CHANNELS.has(provider) && provider !== 'grok-sources'))].slice(0, 5);
    record.resultProvidersComplete = input.resultProvidersComplete === true
      && input.resultProviders.every(provider => record.resultProviders.includes(provider));
  }
  if (!child && !logEvent(input) && Array.isArray(input.queries)) {
    record.queries = input.queries.slice(0, 16)
      .filter(query => query && LOG_KINDS.has(query.kind) && !logEvent(query))
      .map(query => normalizeLog({ ...query, t: query.t || (Number.isFinite(query.at) ? undefined : record.t),
        kind: input.kind !== 'running' && query.kind === 'running' ? 'unknown' : query.kind }, true));
    record.queryCount = Math.max(input.queries.length, record.queries.length,
      Number.isSafeInteger(input.queryCount) && input.queryCount >= 0 ? Math.min(input.queryCount, 1000000) : input.queries.length);
    record.queriesComplete = input.queriesComplete !== false
      && record.queryCount === record.queries.length && input.queries.length === record.queries.length;
    // The parent receipt describes the lifecycle of the whole tool invocation.
    // Child results can disprove success, but cannot turn a live/failed/cancelled
    // parent into success. Missing history is not a still-running request.
    const kinds = record.queries.map(query => query.kind);
    if (!['running', 'failed', 'cancelled', 'unknown'].includes(input.kind)) {
      if (kinds.includes('failed')) record.kind = 'failed';
      else if (kinds.includes('cancelled')) record.kind = 'cancelled';
      else if (!record.queriesComplete || !kinds.length || kinds.includes('unknown')) record.kind = 'unknown';
      else record.kind = input.kind === 'fallback' || kinds.includes('fallback') ? 'fallback'
        : kinds.every(kind => kind === 'official') ? 'official' : kinds.every(kind => kind === 'sources') ? 'sources' : 'ok';
    }
  }
  return record;
}
const logQueries = rec => logEvent(rec) ? [] : rec.queries || [rec];
const logQueryCount = rec => logEvent(rec) ? 0 : rec.queryCount ?? 1;
// Keep invocation receipts for late-write/cancellation protection, but render
// each recorded query as its own row. A row's identity does not depend on the
// child IDs regenerated by normalizeLog when a parent receipt is updated.
const logEntryId = (record, index = 0) => record.queries?.length ? `${record.id}-query-${record.queries[index].id}` : record.id;
function logEntries() {
  const entries = [];
  for (const record of logRows) {
    if (record.queries?.length) {
      record.queries.forEach((query, index) => entries.push({
        ...query, id: logEntryId(record, index), parentId: record.id, queryIndex: index,
        receipt: { kind: record.kind, reason: record.reason, detail: record.detail,
          incomplete: record.queriesComplete === false },
      }));
    } else {
      entries.push({ ...record, parentId: record.id, queryIndex: 0,
        receiptOnly: Array.isArray(record.queries), queries: undefined });
    }
    if (entries.length >= LOG_CAP) break;
  }
  return entries.slice(0, LOG_CAP);
}
function logDuration(ms) {
  if (ms === null) return '—';
  if (ms >= 86400000) return (ms / 86400000).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' 天';
  return (ms / 1000).toFixed(1) + ' 秒';
}
const logSucceeded = rec => ['ok', 'sources', 'fallback', 'official'].includes(rec.kind);
function logStatus(rec) {
  if (rec.kind === 'fallback') return ['warn', '已回退', 'reroute'];
  if (logSucceeded(rec)) return ['ok', LOG_CHIP[rec.kind][1], 'ok'];
  if (rec.kind === 'failed') return ['err', '搜索失败', 'warn'];
  if (rec.kind === 'cancelled') return ['idle', '已取消', 'minus'];
  if (rec.kind === 'running') return ['run', '处理中', 'refresh'];
  return [LOG_CHIP[rec.kind][0], LOG_CHIP[rec.kind][1], 'info'];
}
function logStatusHtml(rec) {
  const [tone, label] = logStatus(rec);
  return `<span class="le-chip" data-t="${tone}"><span class="le-dot" aria-hidden="true"></span>${label}</span>`;
}
function logChannel(rec) {
  if (rec.kind === 'released') return '官方路由已恢复';
  if (rec.kind === 'enabled') return '尚未发起搜索';
  if (rec.kind === 'official') return 'DeepSeek 官方搜索';
  if (rec.kind === 'running') return '等待结果回执';
  if (rec.kind === 'cancelled') return '请求未完成';
  if (rec.kind === 'unknown') return '结果未完整记录';
  if (rec.kind === 'failed') return '无可用通道';
  if (rec.resultProviders?.length) return [...rec.resultProviders.map(provider => META[provider].name),
    ...(rec.resultProvidersComplete ? [] : ['来源未报告'])].join(' / ');
  if (rec.served === 'grok-sources') return '来源未报告';
  return META[rec.served]?.name || '具体来源未报告';
}
function logVisibleQuery(rec) {
  return logPrivate && !logEvent(rec) ? '搜索内容已隐藏' : rec.q;
}
function logNode(id, name, state, tone = '') {
  const mark = id === 'hub' ? `<span class="lhub">${svg('hub')}</span>` : tile(id, 18);
  return `<span class="lnode" title="${esc(name)}" data-node="${id}" data-s="${state}"${tone ? ` data-tone="${tone}"` : ''}>${mark}<span class="ln-name">${esc(name)}</span></span>`;
}
function logWire(state) {
  return `<span class="lwire" data-s="${state}"></span>`;
}
function logRouteHtml(rec) {
  let route = logNode('dsh', 'DSH', 'hit');
  const final = rec.served === 'grok-sources' || !rec.served ? 'hub' : rec.served;
  const providers = rec.resultProviders;
  const results = providers
    ? [...providers, ...(rec.resultProvidersComplete ? [] : ['hub'])]
    : [final];
  if (!results.length) results.push('hub');
  const appendResults = fallback => results.map(provider => logWire(fallback ? 'back' : 'flow')
    + logNode(provider, provider === 'hub' ? '来源未报告' : META[provider].name, 'hit', fallback ? 'warn' : '')).join('');
  if (rec.kind === 'released' || rec.kind === 'official') {
    route += logWire(rec.kind === 'released' ? 'idle' : 'flow') + logNode('deepseek', 'DeepSeek 官方搜索', 'hit');
  } else if (rec.kind === 'enabled') {
    route += logWire('idle') + logNode('hub', HUB_DISPLAY_NAME, 'off');
  } else if (['running', 'cancelled', 'unknown'].includes(rec.kind)) {
    route += logWire('idle') + logNode('hub', rec.kind === 'running' ? '等待结果回执' : rec.kind === 'cancelled' ? '请求已取消' : '结果未完整记录', 'off');
  } else {
    route += logWire('flow') + logNode('hub', HUB_DISPLAY_NAME, 'hit');
    if (rec.kind === 'fallback') {
      // A fallback may start with supplemental sources while Grok is disabled.
      // Render recorded failures only; the outcome alone identifies no source.
      const failed = [...new Set(rec.calls.filter(call =>
        call.result === 'failed' && call.provider !== rec.served && !providers?.includes(call.provider) && LOG_CHANNELS.has(call.provider))
        .map(call => call.provider))];
      for (const provider of failed) {
        route += logWire('dead') + logNode(provider === 'grok-sources' ? 'hub' : provider,
          provider === 'grok-sources' ? '来源未报告' : META[provider].name, 'fail');
      }
      route += appendResults(true);
    } else if (rec.kind === 'failed') {
      route += logWire('dead') + logNode('hub', '无可用通道', 'fail');
    } else {
      route += appendResults(false);
    }
  }
  return route;
}
function logBandHtml(rec, queryIndex = 0) {
  const replayHint = logReplayable(rec) ? '仅回放这个查询的结果链路，不重新搜索或消耗额度；动画不代表原始请求时序。'
    : rec.kind === 'running' ? '等待搜索完成后回放。'
      : logEvent(rec) ? '这是启停路由事件，没有发起搜索。' : '没有完整的结果链路可供回放。';
  return `<div class="lband"><div class="lroute-viewport" tabindex="0" role="group" aria-label="搜索链路，较长时可横向滚动"><div class="lroute" role="img" aria-label="${esc(`${LOG_CHIP[rec.kind][1]}；结果通道：${logChannel(rec)}。`)}" title="记录中的结果与失败来源，不表示供应商之间直接调用或实际网络时序。">${logRouteHtml(rec)}</div></div>
    <button type="button" class="lr-replay" data-log-replay="${queryIndex}" aria-label="回放此条搜索的链路动画" aria-pressed="false" title="${replayHint}"${logReplayable(rec) && !rec.receiptOnly ? '' : ' disabled'}>${svg('replay', 'ic ic-sm')}<span>回放</span></button></div>`;
}
function logReason(rec) {
  const codes = {
    grok_auth_error: 'Grok 认证失败', grok_sources_empty: 'Grok 未返回引用链接',
    grok_provider_error: 'Grok 接口调用失败', grok_timeout: 'Grok 响应超时',
    grok_parse_error: 'Grok 响应无法解析', SOURCE_ALL_FAILED: '全部搜索来源不可用',
    CONFIG_REQUIRED: '尚未配置搜索来源', CANCELLED: '此次搜索已取消',
  };
  return Object.hasOwn(codes, rec.reason) ? codes[rec.reason] : rec.reason ? errText(rec.reason) : '';
}
function logChargeAmount(charge) {
  const amount = charge.amount > 0 && charge.amount < 0.000001 ? '<0.000001'
    : charge.amount.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return charge.unit === 'USD' ? '$' + amount : amount + ' credits';
}
function logInfoTip(text, label) {
  return `<button type="button" class="lu-info" data-log-tip="${esc(text)}" aria-label="${esc(label)}"><svg class="lu-info-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 5.8v5.1m0 3.2v.1"/></svg></button>`;
}
function logCharge(call) {
  const charge = call.charge;
  if (charge.basis === 'unknown' || charge.amount === null || !charge.unit) {
    return `<span class="lu-unknown">未报告${logInfoTip('未报告不代表免费；失败、超时或取消也可能产生消耗。', '未报告消耗的说明')}</span>`;
  }
  const amount = logChargeAmount(charge);
  return `<span class="lu-charge" data-basis="${charge.basis}">${esc(amount)}<small title="${charge.basis === 'estimated' ? '服务返回的估算费用，不是账单或实际扣费。' : '服务在本次响应中报告的消耗，不由余额差值计算。'}">${charge.basis === 'estimated' ? '估算' : '接口报告'}</small></span>`;
}
function logCallsHtml(rec) {
  if (logEvent(rec)) return '<p class="lu-empty">无搜索调用</p>';
  const calls = rec.calls;
  const notes = [];
  if (rec.reason) notes.push(`${logReason(rec)}（${rec.reason}）`);
  if (rec.detail) notes.push(logPrivate ? '错误详情已隐藏。' : rec.detail);
  const receipt = rec.receipt;
  if (receipt) {
    if (receipt.kind === 'failed') notes.push('所属调用报告失败；本条状态仅代表此查询。');
    else if (receipt.kind === 'cancelled') notes.push('所属调用已取消，本条保留已记录的结果。');
    if (receipt.kind === 'unknown' || receipt.incomplete) notes.push('所属调用的记录不完整。');
    if (receipt.reason && receipt.reason !== rec.reason) notes.push(`${logReason(receipt)}（${receipt.reason}）`);
    if (receipt.detail && receipt.detail !== rec.detail) notes.push(logPrivate ? '错误详情已隐藏。' : receipt.detail);
  }
  if (rec.receiptOnly || !rec.callsComplete) notes.push('调用明细未完整报告，不推测缺失来源。');
  if (calls.some(call => call.evidence === 'source-label')) {
    notes.push('结果来源由 Grok Search Rs 返回标签确认，不代表完整调用次数或具体 Key；未报告的消耗不推算。');
  }
  const resultInfo = notes.length ? logInfoTip(notes.join('\n'), '搜索结果补充说明') : '';
  const rows = calls.map(call => {
    const provider = call.provider === 'grok-sources' ? '来源未报告'
      : call.provider === 'deepseek' ? 'DeepSeek 官方搜索' : META[call.provider].name;
    const mark = call.provider === 'grok-sources' ? `<span class="lhub">${svg('hub')}</span>` : tile(call.provider, 18);
    return `<div class="lu-row" role="row">
      <div class="lu-provider" role="cell">${mark}<span>${provider}${call.keyIndex === null ? '' : `<small>Key ${call.keyIndex + 1}</small>`}</span></div>
      <span class="lu-operation" role="cell">${call.evidence === 'source-label' ? '结果来源' : USAGE_OPERATIONS[call.operation]}</span>
      <span class="lu-result" role="cell" data-result="${call.result}">${USAGE_RESULTS[call.result]}${call.code ? `<code>${esc(call.code)}</code>${logInfoTip(errText(call.code), `错误 ${call.code} 的说明`)}` : ''}</span>
      <span class="lu-cost" role="cell">${logCharge(call)}</span></div>`;
  }).join('');
  return `<section class="log-usage" aria-label="此查询的调用与消耗明细">
    <div class="lu-table" role="table" aria-label="本次服务调用">
      <div class="lu-columns" role="row"><span role="columnheader">服务</span><span role="columnheader">调用</span><span role="columnheader">结果${resultInfo}</span><span role="columnheader">消耗</span></div>
      ${rows || `<div class="lu-empty-row" role="row"><span role="cell" aria-colspan="4">${rec.kind === 'running' ? '等待调用明细' : '暂无调用明细'}</span></div>`}
    </div></section>`;
}
function logDetailHtml(rec) {
  return `<section class="lquery" aria-label="此条搜索的详情">${logCallsHtml(rec)}</section>`;
}
function logMatches(rec) {
  return logFilter === 'all' || rec.kind === logFilter
    || logFilter === 'ok' && (rec.kind === 'sources' || rec.kind === 'official');
}
function syncLogControls({ snap = false } = {}) {
  const filters = $$('[data-logfilter]');
  filters.forEach(b => {
    const selected = b.dataset.logfilter === logFilter;
    b.setAttribute('aria-checked', String(selected));
    b.tabIndex = selected ? 0 : -1;
  });
  const target = filters.find(b => b.dataset.logfilter === logFilter);
  const indicator = $('#logFilterActive');
  if (snap) indicator.style.transition = 'none';
  indicator.style.width = target.offsetWidth + 'px';
  indicator.style.transform = `translateX(${target.offsetLeft - 3}px)`;
  if (snap) requestAnimationFrame(() => indicator.style.removeProperty('transition'));
  const privacy = $('#logPrivacy');
  privacy.setAttribute('aria-pressed', String(logPrivate));
  privacy.setAttribute('aria-label', logPrivate ? '显示搜索内容' : '隐藏搜索内容');
  privacy.title = logPrivate ? '显示搜索内容' : '隐藏搜索内容';
  const icon = svg(logPrivate ? 'eyeOff' : 'eye');
  if (privacy.innerHTML !== icon) privacy.innerHTML = icon;
  $('#logCount').textContent = logReadError && !logRows.length ? '—' : String(logEntries().length);
  $('#logClear').disabled = !logRows.length;
  syncLogRuntime();
}
function syncLogRuntime() {}
function updateLogEntry(article, rec) {
  const open = logOpen.has(rec.id);
  const fingerprint = JSON.stringify([rec, logPrivate, isDark()]);
  if (stripTipTarget && article.contains(stripTipTarget) && !open) hideStripTip();
  if (logFingerprints.get(article) !== fingerprint) {
    const label = logStatus(rec)[1];
    if (logRoutePlayback?.entryId === rec.id) stopLogRouteReplay();
    const duration = logEvent(rec) ? '—' : logDuration(rec.ms);
    const query = logVisibleQuery(rec) || (rec.receiptOnly ? '查询明细未报告' : '搜索内容未报告');
    const summary = `${rec.t}，${query}，${label}，耗时 ${duration}；展开查看详情`;
    if (!article.firstElementChild) article.innerHTML = `<button type="button" class="le-head">
      <span class="le-top"><span class="le-time"></span><span class="le-query"></span>
        <span class="le-state"></span>
        <span class="le-dur" title="此条查询报告的耗时"></span>
        <span class="le-chevron">${svg('chev')}</span></span></button>
      <div class="le-band-slot"></div><div class="ldet">
        <div class="ldet-inner"><div class="ldet-body"></div></div></div>`;
    const header = $('.le-head', article), title = $('.le-query', article), time = $('.le-time', article);
    header.setAttribute('aria-controls', `${rec.id}-detail`);
    header.setAttribute('aria-describedby', `${rec.id}-summary`);
    header.setAttribute('aria-label', summary);
    if (time.textContent !== rec.t) time.textContent = rec.t;
    time.title = rec.t;
    if (title.textContent !== query) title.textContent = query;
    title.title = query;
    title.dataset.private = String(logPrivate && !logEvent(rec));
    $('.le-dur', article).textContent = duration;
    const state = $('.le-state', article), stateHtml = logStatusHtml(rec);
    if (state._logHtml !== stateHtml) { state.innerHTML = stateHtml; state._logHtml = stateHtml; }
    const band = $('.le-band-slot', article), bandHtml = logBandHtml(rec, rec.queryIndex);
    if (band._logHtml !== bandHtml) {
      const scrollLeft = $('.lroute-viewport', band)?.scrollLeft || 0;
      band.innerHTML = bandHtml; band._logHtml = bandHtml;
      $('.lroute-viewport', band).scrollLeft = scrollLeft;
    }
    $('.lband', article).id = `${rec.id}-summary`;
    const detail = $('.ldet', article);
    detail.id = `${rec.id}-detail`;
    detail._logFingerprint = null;
    if (!open && detail._logHtml) {
      $('.ldet-body', detail).replaceChildren(); detail._logHtml = null;
    }
    logFingerprints.set(article, fingerprint);
  }
  article.dataset.kind = rec.kind;
  article.dataset.id = rec.id;
  article.dataset.parentId = rec.parentId;
  article.dataset.queryIndex = String(rec.queryIndex);
  article.classList.toggle('is-open', open);
  $('.le-head', article).setAttribute('aria-expanded', String(open));
  const detail = $('.ldet', article);
  if (open && detail._logFingerprint !== fingerprint) {
    const detailHtml = logDetailHtml(rec);
    if (detail._logHtml !== detailHtml) {
      if (stripTipTarget && detail.contains(stripTipTarget)) hideStripTip();
      const scrollLeft = $('.lu-table', detail)?.scrollLeft || 0;
      $('.ldet-body', detail).innerHTML = detailHtml;
      const table = $('.lu-table', detail);
      if (table) table.scrollLeft = scrollLeft;
      detail._logHtml = detailHtml;
    }
    detail._logFingerprint = fingerprint;
  }
  detail.setAttribute('aria-hidden', String(!open));
  detail.inert = !open;
}
function renderLog(opt = {}) {
  const list = $('#logList');
  if (!list) return;
  const focusElement = active();
  const focused = focusElement?.closest('.log-entry')?.dataset.id;
  const replayFocused = active()?.getAttribute('data-log-replay');
  const top = list.scrollTop;
  const anchor = top > 24 ? Array.from(list.children).find(node =>
    node.dataset.id && node.getBoundingClientRect().bottom > list.getBoundingClientRect().top) : null;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - list.getBoundingClientRect().top : null;
  const entries = logEntries();
  const rows = entries.filter(logMatches);
  const allIds = new Set(entries.map(r => r.id));
  for (const [id, node] of logNodes) if (!allIds.has(id)) {
    node.remove(); logNodes.delete(id); logOpen.delete(id);
  }
  const visibleIds = new Set(rows.map(r => r.id));
  if (logRoutePlayback && !visibleIds.has(logRoutePlayback.entryId)) stopLogRouteReplay();
  if (logReplayReturn && !visibleIds.has(logReplayReturn.entryId)) clearHistoryReturn();
  for (const node of Array.from(list.children)) {
    if (!visibleIds.has(node.dataset.id)) node.remove();
  }
  if (!rows.length) {
    const blank = logReadError
      ? ['搜索记录暂不可读', '读取失败不代表未调用插件；恢复连接后自动刷新']
      : logRows.length
      ? ['没有符合条件的记录', '切换筛选查看其他记录']
      : ['还没有搜索记录', S.plugin ? '下一次搜索完成后，可在这里查看通道' : '官方路由已恢复，当前没有搜索记录'];
    const empty = document.createElement('div');
    empty.className = 'lc-empty';
    empty.innerHTML = `<p>${blank[0]}</p><small>${blank[1]}</small>`;
    list.appendChild(empty);
  } else {
    rows.forEach((rec, index) => {
      let node = logNodes.get(rec.id);
      if (!node) {
        node = document.createElement('article');
        node.className = 'log-entry';
        node.setAttribute('role', 'listitem');
        logNodes.set(rec.id, node);
      }
      updateLogEntry(node, rec);
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
      if (opt.fresh === rec.parentId || opt.final === rec.parentId) {
        node.classList.remove('is-new', 'is-final');
        node.classList.add(opt.final ? 'is-final' : 'is-new');
      }
    });
  }
  if (focused && logNodes.get(focused)?.isConnected && !focusElement?.isConnected) {
    const node = logNodes.get(focused);
    const replay = replayFocused !== null ? $(`[data-log-replay="${replayFocused}"]`, node) : null;
    const target = replay && !replay.disabled ? replay : $('.le-head', node);
    if (target !== active()) target.focus({ preventScroll: true });
  }
  if (anchor?.isConnected && anchorOffset !== null) {
    list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - anchorOffset;
  } else list.scrollTop = opt.fresh && top < 24 ? 0 : top;
  if (focused && !logNodes.get(focused)?.isConnected && active() === document.body) {
    const target = list.querySelector('.le-head') || $('[data-logfilter=all]');
    target.focus({ preventScroll: true });
  }
  syncLogControls({ snap: opt.snap === true });
  if (stripTipTarget?.matches('[data-log-tip]')) {
    if (!stripTipTarget.isConnected || stripTipTarget.closest('[inert]')) hideStripTip();
    else showStripTip(stripTipTarget);
  }
}
function clearLocalLog({ announce = true } = {}) {
  stopLogRouteReplay();
  clearHistoryReturn();
  logEpoch++;
  logRows = [];
  readSignature = null;
  logOpen.clear();
  logNodes.clear();
  renderLog();
  if (announce) $('#logAnnouncer').textContent = '已清空本次会话的搜索记录。';
}
function selectLogFilter(value, focus = false) {
  if (!['all', 'ok', 'fallback', 'failed'].includes(value)) return;
  logFilter = value;
  renderLog();
  if (focus) $(`[data-logfilter="${value}"]`).focus();
}
function syncLogRouteReplay(play, active) {
  const buttons = $$(`[data-log-replay="${play.queryIndex}"]`, play.article || play.node);
  buttons.forEach(button => {
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? '停止此条搜索的链路回放' : '回放此条搜索的链路动画');
    button.innerHTML = `${svg(active ? 'stop' : 'replay', 'ic ic-sm')}<span>${active ? '停止' : '回放'}</span>`;
  });
}
function clearHistoryReturn() {
  logReplayReturn = null;
  const bar = $('#historyBar');
  const focused = bar.contains(active());
  bar.hidden = true;
  $('#historyQuery').textContent = '';
  $('#historyContext').hidden = true;
  $('#historyPhase').textContent = '';
  $('#historyRoute').replaceChildren();
  $('#historyRoute').classList.remove('is-replaying');
  if (focused) $('#routeTitle').focus({ preventScroll: true });
}
function stopLogRouteReplay({ retain = false, completed = false } = {}) {
  const play = logRoutePlayback;
  if (!play) {
    if (!retain) clearHistoryReturn();
    return false;
  }
  logRoutePlayback = null;
  play.cancelled = true;
  play.cancelScroll?.();
  play.cancelers.forEach(cancel => cancel());
  cancelAnimationFrame(play.pumpRaf);
  $$('.hr-node', play.stage).forEach(element => {
    jolts.get(element)?.();
    clearTimeout(faultPulses.get(element));
    faultPulses.delete(element);
  });
  play.animations.forEach(animation => animation.cancel());
  play.resize?.disconnect();
  play.offResize?.();
  play.node.classList.remove('is-replaying');
  play.article?.classList.remove('is-replaying');
  $$('.is-replay-seen', play.node).forEach(node => node.classList.remove('is-replay-seen'));
  syncLogRouteReplay(play, false);
  const focusInHistory = $('#historyBar').contains(active());
  delete card.dataset.history;
  for (const [element, inert] of play.locks) element.inert = inert;
  $('#historyStage').hidden = true;
  $('#historyStage').replaceChildren();
  $('#historyNote').hidden = true;
  $('#historyContext').hidden = true;
  $('#historyRoute').replaceChildren();
  $('#historyRoute').classList.remove('is-replaying');
  if (retain && play.article?.isConnected) {
    $('#historyBar').dataset.phase = 'done';
    $('#historyLabel').textContent = '已恢复当前配置';
    $('#historyLabel').title = `${completed ? '回放结束' : '回放已停止'} · ${play.rec.t}`;
    $('#historyPhase').textContent = '';
    $('#historyStop').hidden = true;
    $('#historyDismiss').hidden = false;
    if (focusInHistory) $('#historyReturn').focus({ preventScroll: true });
  } else clearHistoryReturn();
  // The live canvas never changed state; redraw coordinates after unhiding it.
  pumpWires(120);
  return true;
}
function historyNode(id, name, meta = '') {
  const glyph = id === 'hub' ? `<span class="hub-glyph">${svg('hub')}</span>`
    : `<img class="node-logo" src="${logoSrc(id)}" alt="">`;
  return `<div class="node ${id === 'dsh' ? 'node-dsh' : id === 'hub' ? 'node-hub' : 'history-official'} hr-node" data-history-node="${id}" data-hs="idle">
    ${id !== 'dsh' ? '<span class="port hr-port"></span>' : ''}${id !== 'deepseek' ? '<span class="port hr-port out"></span>' : ''}
    ${glyph}<span class="node-name">${esc(name)}</span><span class="node-meta">${esc(meta)}</span>
    ${id === 'hub' ? '<span class="hub-pill hr-hub-mode">历史路径</span>' : ''}</div>`;
}
function mountHistoryRoute(play) {
  const rec = play.rec;
  const stage = $('#historyStage');
  const unknown = rec.kind === 'failed' || rec.kind !== 'official' && (rec.resultProviders
    ? !rec.resultProviders.length || !rec.resultProvidersComplete : !rec.served || rec.served === 'grok-sources');
  const provider = id => `<div class="row hr-provider hr-node" data-history-node="${id}" data-hs="idle" data-st="off">
    ${id === 'unknown' ? `<span class="tile tile-glyph" style="--s:28px">${svg('hub')}</span>` : tile(id, 28)}
    <span class="hr-provider-name">${id === 'unknown' ? rec.kind === 'failed' ? '无可用通道' : '来源未报告' : META[id].name}</span>
    <span class="hr-result"></span><span class="row-fault hr-fault" hidden></span><span class="port hr-port"></span></div>`;
  stage.innerHTML = `<svg class="wires hr-wires" aria-hidden="true"></svg>
    ${historyNode('dsh', 'DeepSeek Harness', 'web_search')}${rec.kind === 'official' ? historyNode('deepseek', 'DeepSeek 官方搜索', '记录报告的通道') : ''}
    ${historyNode('hub', HUB_DISPLAY_NAME, rec.kind === 'official' ? '未经过此通道' : '记录链路')}
    ${['grok', ...SUPP, 'github', ...(unknown ? ['unknown'] : [])].map(provider).join('')}
    ${['primary', 'supp', 'extract'].map((group, index) => `<span class="hr-label" data-history-group="${group}">${['主搜索', '补充来源', '专用抽取'][index]}</span>`).join('')}`;
  play.stage = stage;
  play.svg = $('.hr-wires', stage);
  play.paths = new Map();
  const edges = rec.kind === 'official' ? [['dsh-deepseek', 'dsh', 'deepseek']]
    : [['dsh-hub', 'dsh', 'hub'], ...['grok', ...SUPP, 'github', ...(unknown ? ['unknown'] : [])].map(id => ['hub-' + id, 'hub', id])];
  for (const [id, from, to] of edges) {
    const group = document.createElementNS(SVGNS, 'g');
    group.setAttribute('class', 'wg');
    group.dataset.ws = 'rest';
    group.innerHTML = '<path class="wt"/><path class="w"/><circle class="w-end" r="1.4"/><circle class="w-end" r="1.4"/>';
    const path = group.children[1];
    path.dataset.historyWire = id;
    path.dataset.hs = 'idle';
    play.svg.appendChild(group);
    play.paths.set(id, { path, group, from, to });
  }
  play.packetLayer = document.createElementNS(SVGNS, 'g');
  play.packetLayer.setAttribute('class', 'packets');
  play.svg.appendChild(play.packetLayer);
  if (rec.kind === 'official') {
    $('[data-history-node=dsh] .hr-port', stage).className = 'port hr-port bottom';
    $('[data-history-node=deepseek] .hr-port', stage).className = 'port hr-port top';
    $('[data-history-node=hub] .hr-port.out', stage).hidden = true;
  } else if (unknown) {
    $('[data-history-node=unknown] .hr-port', stage).className = 'port hr-port top';
    $('[data-history-node=hub]', stage).insertAdjacentHTML('beforeend', '<span class="port hr-port bottom"></span>');
  }
  const draw = () => {
    if (logRoutePlayback !== play || play.cancelled || stage.hidden) return;
    const liveStage = $('#stage'), root = liveStage.getBoundingClientRect();
    const parent = card.getBoundingClientRect();
    const computed = getComputedStyle(liveStage);
    const sx = root.width / parseFloat(computed.width), sy = root.height / parseFloat(computed.height);
    stage.style.left = (root.left - parent.left) / sx - card.clientLeft + 'px';
    stage.style.top = (root.top - parent.top) / sy - card.clientTop + 'px';
    stage.style.width = root.width / sx + 'px';
    stage.style.height = root.height / sy + 'px';
    const place = (target, bounds) => {
      Object.assign(target.style, { left: (bounds.left - root.left) / sx + 'px',
        top: (bounds.top - root.top) / sy - stage.clientTop + 'px', width: bounds.width / sx + 'px', height: bounds.height / sy + 'px' });
    };
    for (const element of $$('.hr-node', stage)) {
      const id = element.dataset.historyNode;
      const source = id === 'dsh' ? $('#nodeDsh') : id === 'hub' ? $('#nodeHub')
        : id === 'deepseek' ? $('#nodeOfficial') : id === 'unknown' ? null : rowOf(id);
      if (source) place(element, source.getBoundingClientRect());
      else {
        const hub = $('#nodeHub').getBoundingClientRect();
        place(element, { left: hub.left - 15 * sx, top: hub.bottom + 26 * sy, width: hub.width + 30 * sx, height: 44 * sy });
      }
    }
    for (const label of $$('.hr-label', stage)) {
      place(label, $(`[data-group="${label.dataset.historyGroup}"] .rg-label`).getBoundingClientRect());
    }
    const banner = $('#bannerSlot').getBoundingClientRect(), context = $('#historyContext');
    const compact = banner.height < 36 * sy;
    context.dataset.compact = String(compact);
    Object.assign(context.style, { left: '20px', right: '20px',
      top: (compact ? root.top - parent.top + 4 * sy : banner.top - parent.top) / sy - card.clientTop + 'px',
      height: (compact ? 22 : banner.height / sy) + 'px' });
    const overlayRoot = stage.getBoundingClientRect();
    for (const { path, group, from, to } of play.paths.values()) {
      const a = $(`[data-history-node="${from}"]`, stage).getBoundingClientRect();
      const b = $(`[data-history-node="${to}"]`, stage).getBoundingClientRect();
      const vertical = to === 'deepseek' || to === 'unknown';
      const x1 = ((vertical ? a.left + a.width / 2 : a.right) - overlayRoot.left) / sx;
      const y1 = ((vertical ? a.bottom : a.top + a.height / 2) - overlayRoot.top) / sy - stage.clientTop;
      const x2 = ((vertical ? b.left + b.width / 2 : b.left) - overlayRoot.left) / sx;
      const y2 = ((vertical ? b.top : b.top + b.height / 2) - overlayRoot.top) / sy - stage.clientTop;
      const mid = (x1 + x2) / 2;
      path.setAttribute('d', vertical ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
      group.children[0].setAttribute('d', path.getAttribute('d'));
      syncBreak(group, group.dataset.ws, from === 'dsh' ? 'start' : 'end');
    }
  };
  play.layout = draw;
  play.pump = (ms = 520) => {
    play.pumpUntil = Math.max(play.pumpUntil || 0, performance.now() + ms);
    if (play.pumpRaf) return;
    const tick = () => {
      if (play.cancelled || logRoutePlayback !== play) { play.pumpRaf = 0; return; }
      draw();
      play.pumpRaf = performance.now() < play.pumpUntil ? requestAnimationFrame(tick) : 0;
    };
    play.pumpRaf = requestAnimationFrame(tick);
  };
  stage.hidden = false;
  draw();
  play.resize = new ResizeObserver(draw);
  play.resize.observe($('#stage'));
  play.resize.observe(card);
  play.offResize = listen(window, 'resize', draw);
}
function scrollToHistory(play) {
  const scrollers = [];
  for (let element = card.parentElement; element; element = element.parentElement || element.getRootNode()?.host) {
    if (element.scrollHeight > element.clientHeight && /auto|scroll/.test(getComputedStyle(element).overflowY)) scrollers.push(element);
  }
  if (!scrollers.length) scrollers.push(document.scrollingElement);
  const positions = scrollers.filter(Boolean).map(element => {
    const viewport = element === document.scrollingElement ? { top: 0 } : element.getBoundingClientRect();
    return { element, start: element.scrollTop, target: Math.max(0, Math.min(element.scrollHeight - element.clientHeight,
      element.scrollTop + card.getBoundingClientRect().top - viewport.top - 16)) };
  });
  if (reduced()) { positions.forEach(({ element, target }) => { element.scrollTop = target; }); return Promise.resolve(); }
  return new Promise(resolve => {
    const start = performance.now();
    let frame, offWheel, offTouch;
    const done = () => { cancelAnimationFrame(frame); offWheel?.(); offTouch?.(); play.cancelScroll = null; resolve(); };
    offWheel = listen(window, 'wheel', done, { once: true, passive: true });
    offTouch = listen(window, 'touchstart', done, { once: true, passive: true });
    play.cancelScroll = done;
    const tick = time => {
      if (play.cancelled) return done();
      const progress = Math.min(1, (time - start) / 420);
      positions.forEach(({ element, start, target }) => { element.scrollTop = start + (target - start) * (1 - (1 - progress) ** 3); });
      if (progress === 1) done(); else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  });
}
async function replayLogRoute(id, queryIndex = 0) {
  if (!Number.isSafeInteger(queryIndex) || queryIndex < 0 || queryIndex >= 16) return false;
  const rec = logEntries().find(record => record.parentId === id && record.queryIndex === queryIndex);
  const article = rec && logNodes.get(rec.id);
  if (!rec || rec.receiptOnly || !article?.isConnected || !logReplayable(rec)) return false;
  if (logRoutePlayback?.entryId === rec.id) {
    stopLogRouteReplay({ retain: true });
    $('#logAnnouncer').textContent = '已停止链路回放，没有重新搜索。';
    return true;
  }
  if (S.testing || S.loading || false || logRows.some(record => record.kind === 'running')) {
    $('#logAnnouncer').textContent = '正在处理搜索或加载，完成后可回放历史链路。';
    toast('搜索或加载进行中，请完成后再回放', { tone: 'info' });
    return false;
  }
  stopLogRouteReplay();
  const node = article;
  // A replay never calls runTest or any provider. It reads the rendered,
  // recorded outcome path only; durations are visual pacing, not request timing.
  const play = { id, entryId: rec.id, queryIndex, article, node, rec, epoch: logEpoch, animations: new Set(), cancelers: new Set(),
    cancelled: false, static: reduced(),
    locks: [$('#stage'), $('.rc-actions', card), $('#bannerSlot'), $('.rc-foot', card)].map(element => [element, element.inert]) };
  logRoutePlayback = play;
  logReplayReturn = { id, entryId: rec.id, queryIndex, epoch: logEpoch };
  if (!play.static) {
    node.classList.add('is-replaying');
    article.classList.add('is-replaying');
  }
  syncLogRouteReplay(play, true);
  closePop();
  hideStripTip();
  play.locks.forEach(([element]) => { element.inert = true; });
  card.dataset.history = 'true';
  $('#historyBar').hidden = false;
  $('#historyBar').dataset.phase = 'playing';
  $('#historyLabel').textContent = `${play.static ? '历史记录' : '历史回放'} · ${rec.t}`;
  $('#historyLabel').removeAttribute('title');
  $('#historyQuery').textContent = logVisibleQuery(rec);
  $('#historyContext').hidden = false;
  $('#historyPhase').textContent = play.static ? '历史终态' : '准备回放';
  $('#historyStop').hidden = false;
  $('#historyStop').innerHTML = `${svg(play.static ? 'replay' : 'stop')}<span>${play.static ? '返回当前配置' : '停止'}</span>`;
  $('#historyReturn').innerHTML = `${svg('returnLog')}<span>返回该条日志</span>`;
  $('#historyDismiss').innerHTML = svg('x');
  $('#historyDismiss').hidden = true;
  $('#historyNote').hidden = false;
  let completed = false;
  try {
    mountHistoryRoute(play);
    $('#historyStop').focus({ preventScroll: true });
    $('#logAnnouncer').textContent = '正在回放记录链路，不会重新搜索或消耗额度。';
    const alive = () => logRoutePlayback === play && !play.cancelled
      && logEpoch === play.epoch && node.isConnected;
    const animate = async (element, keyframes, duration, options = {}) => {
      if (!alive() || play.static) return;
      const index = elements.indexOf(element);
      const targets = index < 0 ? [element] : [element, historyElements[index]];
      await Promise.all(targets.map(async target => {
        const animation = target.animate(keyframes, {
          duration, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards', ...options,
        });
        play.animations.add(animation);
        await animation.finished.catch(() => {});
        if (options.fill === 'none') { animation.cancel(); play.animations.delete(animation); }
      }));
    };
    const elements = Array.from($('.lroute', node).children);
    const historyRoute = $('#historyRoute');
    // The header is the complete log chain, from the same renderer and CSS.
    historyRoute.innerHTML = logRouteHtml(rec);
    historyRoute.classList.toggle('is-replaying', !play.static);
    historyRoute.setAttribute('aria-label', `历史结果链路：${Array.from(historyRoute.querySelectorAll('.ln-name'), el => el.textContent).join(' → ')}；${LOG_CHIP[rec.kind][1]}。不重新搜索，不代表原始请求时序。`);
    const historyElements = Array.from(historyRoute.children);
    const mainNode = element => $(`[data-history-node="${element.dataset.node === 'hub'
      ? element === elements[2] ? 'hub' : 'unknown' : element.dataset.node}"]`, play.stage);
    const hub = $('[data-history-node=hub]', play.stage);
    const delay = ms => new Promise(resolve => {
      if (!alive() || play.static) { resolve(); return; }
      let timer;
      const clean = () => { clearTimeout(timer); play.cancelers.delete(clean); resolve(); };
      timer = setTimeout(clean, ms);
      play.cancelers.add(clean);
    });
    const markNode = element => {
      const target = mainNode(element);
      if (!target) return null;
      target.dataset.hs = element.dataset.s === 'fail' ? 'fail' : element.dataset.tone === 'warn' ? 'back' : 'hit';
      if (target.classList.contains('row')) target.dataset.st = element.dataset.s === 'fail' ? 'bad' : 'live';
      $$('.hr-port', target).forEach(port => {
        port.dataset.ps = element.dataset.s === 'fail' ? 'broken' : 'live';
        if (target.classList.contains('row') && element.dataset.s !== 'fail') port.dataset.mark = 'ok';
      });
      const result = $('.hr-result', target);
      if (result) result.textContent = element.dataset.s === 'fail' ? target.dataset.historyNode === 'unknown' ? '搜索失败' : '来源不可用'
        : rec.kind === 'failed' ? '搜索未完成' : '返回结果';
      const badge = $('.hr-fault', target);
      if (badge && element.dataset.s === 'fail') {
        const code = rec.calls.find(call => call.provider === target.dataset.historyNode && call.result === 'failed')?.code;
        badge.textContent = code ? `${code} · ${errText(code)}` : logReason(rec) || '来源不可用';
        badge.hidden = false;
        target.classList.add('has-fault');
      }
      return target;
    };
    const wireFor = index => {
      const next = elements[index + 1]?.dataset.node;
      return play.paths.get(next === 'deepseek' ? 'dsh-deepseek'
        : index === 1 ? 'dsh-hub' : 'hub-' + (next === 'hub' ? 'unknown' : next));
    };
    const setWire = (edge, state) => {
      if (!edge) return;
      edge.path.dataset.hs = state;
      edge.group.dataset.ws = state === 'fail' ? 'broken' : 'live';
      if (state === 'fail') {
        edge.group.classList.remove('lit');
        edge.group._bt = performance.now();
        delete edge.group._bf;
      }
      play.pump(480);
    };
    await scrollToHistory(play);
    if (!alive()) return true;
    if (play.static) {
      elements.forEach((element, index) => {
        if (element.classList.contains('lwire')) {
          setWire(wireFor(index), element.dataset.s === 'dead' ? 'fail' : element.dataset.s === 'back' ? 'back' : 'hit');
        } else markNode(element);
      });
      play.layout();
      $('#historyPhase').textContent = logChannel(rec);
      $('#logAnnouncer').textContent = '已在搜索路由图展示历史终态，没有重新搜索。可返回当前配置或该条日志。';
      completed = true;
      return true;
    }
    for (const [index, element] of elements.entries()) {
      if (!alive()) return true;
      element.classList.add('is-replay-seen');
      historyElements[index].classList.add('is-replay-seen');
      if (element.classList.contains('lwire')) {
        const edge = wireFor(index);
        const tone = element.dataset.s === 'back' ? 'back' : 'hit';
        setWire(edge, 'active');
        const nextTarget = mainNode(elements[index + 1]);
        if (nextTarget?.classList.contains('row')) {
          nextTarget.dataset.st = 'on';
        }
        if (tone === 'back') {
          hub.classList.add('is-falling');
          $('.hr-hub-mode', hub).textContent = '回退中';
          await delay(260);
          if (!alive()) return true;
        }
        if (edge) edge.group.dataset.requesting = 'true';
        $('#historyPhase').textContent = index === 1 ? rec.kind === 'official' ? '官方结果路径' : '进入 Grok Search Rs'
          : tone === 'back' ? '转向补充来源' : '请求路径';
        await Promise.all([animate(element, [
          { clipPath: 'inset(0 100% 0 0)', opacity: .35 },
          { clipPath: 'inset(0)', opacity: 1 },
        ], T.hop), edge && travel(edge.path.dataset.historyWire, { view: play })]);
        if (!alive()) return true;
        if (edge) edge.group.dataset.requesting = 'false';
      } else {
        const target = mainNode(element);
        const failed = element.dataset.s === 'fail';
        if (target?.classList.contains('row')) {
          target.classList.add('is-searching');
          await delay(failed ? T.fail : target.dataset.historyNode === 'grok' ? T.grok : T.supp);
          if (!alive()) return true;
          target.classList.remove('is-searching');
        }
        markNode(element);
        if (failed) {
          $('#historyPhase').textContent = rec.kind === 'failed' ? '没有可用结果' : `${element.querySelector('.ln-name').textContent} 不可用`;
          pulseFault(target);
          await jolt(target, false, play.pump);
          if (!alive()) return true;
          setWire(wireFor(index - 1), 'fail');
          await delay(260);
        } else {
          if (target === hub) hub.classList.add('is-busy');
          if (target?.classList.contains('row')) flashRow(target);
          if (index > 0) setWire(wireFor(index - 1), element.dataset.tone === 'warn' ? 'back' : 'hit');
          await animate(element, [{ opacity: .6 }, { opacity: 1 }], 180);
        }
      }
    }
    if (alive()) {
      if (rec.kind !== 'failed') {
        $('#historyPhase').textContent = '结果返回';
        const lastEdge = wireFor(elements.length - 2);
        if (lastEdge) await travel(lastEdge.path.dataset.historyWire, { view: play, back: true });
        if (alive() && rec.kind !== 'official') {
          hub.classList.remove('is-busy', 'is-falling');
          $('.hr-hub-mode', hub).textContent = '历史路径';
          await travel('dsh-hub', { view: play, back: true });
        }
        if (alive()) flashNode($('[data-history-node=dsh]', play.stage));
      } else {
        hub.classList.remove('is-busy', 'is-falling');
        await jolt($('[data-history-node=dsh]', play.stage), false, play.pump);
        if (alive()) setWire(play.paths.get('dsh-hub'), 'fail');
      }
      if (!alive()) return true;
      $('#historyPhase').textContent = logChannel(rec);
      await animate($('.le-chip', node), [{ opacity: .7 }, { opacity: 1 }, { opacity: 1 }], T.hold);
      if (alive()) $('#logAnnouncer').textContent = '链路回放结束，已恢复当前配置。原记录与额度未改变。';
    }
    completed = alive();
    return true;
  } catch {
    $('#logAnnouncer').textContent = '回放未能完成，已恢复当前配置；原记录未改变。';
    return false;
  } finally {
    if (logRoutePlayback === play && (!play.static || !completed)) {
      stopLogRouteReplay({ retain: completed, completed });
    }
  }
}
listen($('#historyStop'), 'click', () => stopLogRouteReplay({ retain: true }));
listen($('#historyDismiss'), 'click', clearHistoryReturn);
listen($('#historyReturn'), 'click', () => {
  const target = logReplayReturn && logReplayReturn.epoch === logEpoch ? logNodes.get(logReplayReturn.entryId) : null;
  const queryIndex = logReplayReturn?.queryIndex || 0;
  stopLogRouteReplay({ retain: true });
  if (!target?.isConnected) { clearHistoryReturn(); return; }
  target.style.scrollMarginTop = '16px';
  target.scrollIntoView({ behavior: reduced() ? 'instant' : 'smooth', block: 'center' });
  ($(`[data-log-replay="${queryIndex}"]`, target) || $('.le-head', target)).focus({ preventScroll: true });
});
listen($('#logList'), 'pointerover', event => {
  const tip = event.target.closest('[data-log-tip]');
  if (tip && tip !== stripTipTarget) showStripTip(tip);
});
listen($('#logList'), 'pointerout', event => {
  if (!event.target.closest('[data-log-tip]')) return;
  if (event.relatedTarget && (stripTipTarget?.contains(event.relatedTarget) || routeTooltip.contains(event.relatedTarget))) return;
  clearTimeout(stripTipTimer);
  stripTipTimer = setTimeout(() => {
    if (stripTipTarget !== active()) hideStripTip();
  }, 100);
});
listen($('#logList'), 'focusin', event => {
  if (event.target.matches('[data-log-tip]')) showStripTip(event.target);
});
listen($('#logList'), 'focusout', event => {
  if (event.target.matches('[data-log-tip]') && !routeTooltip.contains(event.relatedTarget)) hideStripTip();
});
listen($('#logList'), 'click', event => {
  const tip = event.target.closest('[data-log-tip]');
  if (tip) { showStripTip(tip); return; }
  const replay = event.target.closest('[data-log-replay]');
  if (replay) {
    if (!replay.disabled) void replayLogRoute(replay.closest('.log-entry').dataset.parentId, Number(replay.dataset.logReplay));
    return;
  }
  const button = event.target.closest('.le-head');
  if (!button) return;
  const node = button.closest('.log-entry');
  const id = node.dataset.id;
  if (logOpen.has(id)) {
    if (logRoutePlayback?.entryId === id) stopLogRouteReplay();
    logOpen.delete(id);
  } else logOpen.add(id);
  updateLogEntry(node, logEntries().find(r => r.id === id));
});
listen($('#logList'), 'animationend', event => {
  if (event.target.classList.contains('log-entry')) event.target.classList.remove('is-new', 'is-final');
});
$$('[data-logfilter]').forEach(b => listen(b, 'click', () => selectLogFilter(b.dataset.logfilter)));
listen($('.lc-filters'), 'keydown', event => {
  const buttons = $$('[data-logfilter]');
  const current = buttons.indexOf(event.target);
  if (current < 0 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
  selectLogFilter(buttons[next].dataset.logfilter, true);
});
listen($('#logPrivacy'), 'click', () => {
  stopLogRouteReplay();
  logPrivate = !logPrivate;
  if (logMemory) logMemory.private = logPrivate;
  renderLog();
  $('#logAnnouncer').textContent = logPrivate ? '搜索内容已隐藏，结果通道仍可查看。' : '搜索内容已显示。';
});
listen($('#logClear'), 'click', () => { void clearRemoteLog(); });
function logReadNotice(code) {
  const reason = code === 'SETTINGS_SECURE_CONNECTION_REQUIRED' ? '请通过本机直连或 HTTPS 查看'
    : code === 'SETTINGS_AUTH_REQUIRED' ? '宿主身份验证失效，请重新连接'
      : code === 'SEARCH_LOG_SESSION_INVALID' ? '日志会话失效，请重新打开插件页'
        : '读取失败，正在重试；这不代表没有搜索记录';
  return `日志暂不可读 · ${code} · ${reason}`;
}
function restrict(code = null) {
  if (disposed) return;
  // Explicit RPC denial and a restricted capability snapshot share the same
  // local revocation. This never deletes the server's search history.
  if (!logRestricted) {
    generation++;
    logRestricted = true;
    logBaselined = false;
    logReadError = code;
    hideStripTip();
    clearLocalLog({ announce: false });
    $('#logAnnouncer').textContent = '';
  }
  if (code && logReadError !== code) { logReadError = code; renderLog(); }
  $('#logNote').textContent = logReadError ? logReadNotice(logReadError) : '请通过本机直连或 HTTPS 查看搜索日志';
}
async function read() {
  if (disposed) return;
  // No snapshot yet: the connection is unknown, not restricted.
  if (!S.capabilities) return;
  if (!S.capabilities?.secretsAllowed) {
    // Hide the records once; this is not a user clear and must not repeat on every poll.
    restrict();
    return;
  }
  if (clearing) return;
  logRestricted = false;
  if (readTask) return;
  const mine = generation;
  readTask = (async () => {
    try {
      const result = await remote.readSearchLog({ sessionId });
      if (disposed || mine !== generation || !S.capabilities?.secretsAllowed) return;
      const wasUnreadable = logReadError !== null;
      logReadError = null;
      const records = (result.records || []).slice(0, LOG_CAP);
      const signature = JSON.stringify([records, S.plugin]);
      $('#logNote').textContent = '仅内存 · 最近 20 条 · 停用或退出 DSH 后清空';
      if (readSignature === signature) { if (wasUnreadable) renderLog(); return; }
      const before = new Map(logRows.map(row => [row.id, row.kind]));
      logRows = records.map(input => {
        const row = normalizeLog({ ...input, t: new Date(input.at).toLocaleTimeString('zh-CN', { hour12: false }) });
        return { ...row, id: /^search-log-[0-9]+$/.test(input.id) ? input.id : row.id };
      });
      if (logRows.some(row => row.kind === 'running')) stopLogRouteReplay();
      const fresh = logBaselined ? logRows.find(row => !before.has(row.id)) : undefined;
      const final = logBaselined ? logRows.find(row => before.get(row.id) === 'running' && row.kind !== 'running') : undefined;
      renderLog({ fresh: fresh?.id, final: final?.id });
      readSignature = signature;
      logBaselined = true;
      if (fresh || final) {
        const row = final || fresh;
        $('#logAnnouncer').textContent = `${logVisibleQuery(row)}，${LOG_CHIP[row.kind][1]}。`;
      }
    } catch (error) {
      if (disposed || mine !== generation || !S.capabilities?.secretsAllowed) return;
      const code = /^[\w./-]{1,80}$/.test(error?.code || '') ? error.code : 'SETTINGS_UNAVAILABLE';
      if (code === 'SETTINGS_AUTH_REQUIRED' || code === 'SETTINGS_SECURE_CONNECTION_REQUIRED') {
        restrict(code);
        onPrivateAccessDenied?.(error);
      }
      $('#logNote').textContent = logReadNotice(code);
      if (logReadError !== code) { logReadError = code; renderLog(); }
    }
  })().finally(() => { readTask = null; });
  return readTask;
}
async function clearRemoteLog() {
  if (clearing || disposed) return;
  clearing = true;
  generation++;
  clearLocalLog();
  try {
    await remote.clearSearchLog({ sessionId });
    if (!disposed) toast('已清空当前插件的搜索记录', { tone: 'info' });
  } catch { if (!disposed) toast('清空未确认，请稍后重试', { tone: 'info' }); }
  finally { generation++; clearing = false; }
}
renderLog({ snap: true });
const poll = async () => {
  if (disposed) return;
  if (document.visibilityState !== 'hidden') await read();
  if (!disposed) pollTimer = setTimeout(poll, 2500);
};
pollTimer = setTimeout(poll, 2500);
return Object.freeze({
  read, restrict,
  hideTip: hideStripTip,
  stop: () => { hideStripTip(); return stopLogRouteReplay(); },
  cancel: () => { hideStripTip(); stopLogRouteReplay(); clearHistoryReturn(); },
  theme: () => { hideStripTip(); stopLogRouteReplay(); renderLog(); },
  dispose() {
    if (disposed) return;
    disposed = true; generation++;
    clearTimeout(pollTimer);
    hideStripTip();
    stopLogRouteReplay(); clearHistoryReturn();
    logRows = []; readSignature = null; logNodes.clear(); logOpen.clear();
    void remote.closeSearchLog({ sessionId }).catch(() => {});
  },
});
}
