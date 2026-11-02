import test from 'node:test';
import assert from 'node:assert/strict';
import {checkDeferredNotice,checkColdPending,checkRecoveredRecord,checkPendingLoad,checkSelectedAcquisition,checkSelectionHistoryPreserved,checkRequiredSearchError,NOTICE_TEXT} from '../scripts/lib/deferred-release-checks.mjs';
const notice = () => ({ model: { isError: true, text: 'Error: '+NOTICE_TEXT }, seam: { ok: false, error: { code: 'WEB_PROVIDER_CONFIGURED_MISSING', message: NOTICE_TEXT } }, originalCalls: 0, ownerPresent: false, recoveryPresent: false });
test('两个控制组件缺席时的条件重启提示可通过', () => { assert.doesNotThrow(() => checkDeferredNotice(notice())); });
test('成功响应、空提示、原搜索调用或仍有 owner 不能冒称缺席提示通过', () => {
  for (const changes of [{ model: { isError: false, text: NOTICE_TEXT } }, { model: { isError: true, text: '' } }, { originalCalls: 1 }, { ownerPresent: true }, { seam: { ok: true, result: {} } }]) assert.throws(() => checkDeferredNotice({ ...notice(), ...changes }));
});
test('仅全部明确取消选择且作者路由恢复时允许历史 pending', () => {
 const value={selectedBundles:['base'],searchBundle:'search',recoveryBundle:'recovery',record:{policy:'required',release:null},authorRoute:true};
 assert.doesNotThrow(() => checkColdPending(value));
 for(const changes of [{selectedBundles:['base','search']},{selectedBundles:['base','recovery']},{authorRoute:false},{record:{policy:'required',release:{fake:true}}}])assert.throws(()=>checkColdPending({...value,...changes}));
});
test('合法加载恢复保留原记录并诚实区分本次校正与历史释放', () => {
 const before={schemaVersion:1,policy:'required',lease:{uid:'old'},release:null};
 const after={policy:'released',reason:'legal-load-observed-unselected-at-author',priorIntent:before,release:null,recovery:{action:'startup-state-correction',historicReleaseCommitted:false,routeVerified:true,selectedBundles:['base','recovery'],previousPolicy:'required',originalLease:before.lease,observedAt:'2026-10-18T00:00:00.000Z',selectionSha256:'a'.repeat(64)}};
 assert.doesNotThrow(()=>checkRecoveredRecord({before,after,searchBundle:'search'}));
 for(const changes of [{release:{fake:true}},{priorIntent:{}},{recovery:{...after.recovery,historicReleaseCommitted:true}},{recovery:{...after.recovery,selectedBundles:['search']}}])assert.throws(()=>checkRecoveredRecord({before,after:{...after,...changes},searchBundle:'search'}));
});

const pendingLoad = () => {
  const before = { schemaVersion: 1, policy: 'required', lease: { uid: 'old' }, release: null };
  return { before, after: structuredClone(before), authorRoute: true, grokCalls: 0, searchBundle: 'search',
    diagnosis: { code: 'CONTROL_HISTORY_PENDING', requiresExplicitResume: true, message: '历史记录待核实；当前未重新接管。' } };
};
test('历史 pending 保留作者与诚实诊断可通过，无依据接管确实失败', () => {
  const value = pendingLoad();
  assert.doesNotThrow(() => checkPendingLoad(value));
  for (const changes of [{ authorRoute: false }, { grokCalls: 1 }, { diagnosis: null },
    { after: { ...value.before, lease: { uid: 'new' } } }, { after: { ...value.before, release: { fake: true } } }])
    assert.throws(() => checkPendingLoad({ ...value, ...changes }), assert.AssertionError);
});
test('历史 pending 的诚实校正可通过，校正后换写 lease 或伪造授权仍失败', () => {
  const value = pendingLoad();
  const after = { ...value.before, policy: 'released', reason: 'legal-load-observed-unselected-at-author', priorIntent: value.before,
    recovery: { action: 'startup-state-correction', historicReleaseCommitted: false, routeVerified: true, selectedBundles: ['base'],
      previousPolicy: 'required', originalLease: value.before.lease, observedAt: '2026-10-18T00:00:00.000Z', selectionSha256: 'a'.repeat(64) } };
  assert.doesNotThrow(() => checkPendingLoad({ ...value, after, diagnosis: null }));
  for (const changes of [{ lease: { uid: 'new' } }, { acquisition: { forged: true } }, { release: { fake: true } },
    { recovery: { ...after.recovery, historicReleaseCommitted: true } }])
    assert.throws(() => checkPendingLoad({ ...value, after: { ...after, ...changes } }), assert.AssertionError);
});

test('搜索组件已经再次选择时，独立退出观察支持诚实校正，缺少或冲突证据仍失败', () => {
  const value = pendingLoad();
  const pendingObservation = { selectedBundles: ['base'], searchBundle: 'search', recoveryBundle: 'recovery', record: value.before, authorRoute: true };
  const after = { ...value.before, policy: 'released', reason: 'legal-load-observed-unselected-at-author', priorIntent: value.before,
    recovery: { action: 'startup-state-correction', historicReleaseCommitted: false, routeVerified: true, selectedBundles: ['base', 'search'], pendingObservation,
      previousPolicy: 'required', originalLease: value.before.lease, observedAt: '2026-10-18T00:00:00.000Z', selectionSha256: 'a'.repeat(64) } };
  assert.doesNotThrow(() => checkPendingLoad({ ...value, after, pendingObservation }));
  assert.throws(() => checkPendingLoad({ ...value, after: { ...after, recovery: { ...after.recovery, pendingObservation: undefined } }, pendingObservation }), assert.AssertionError);
  for (const observation of [undefined, { ...pendingObservation, selectedBundles: ['base', 'search'] },
    { ...pendingObservation, record: { ...value.before, lease: { uid: 'other' } } }, { ...pendingObservation, authorRoute: false }])
    assert.throws(() => checkPendingLoad({ ...value, after, pendingObservation: observation }), assert.AssertionError);
});

const selectedAcquisition = () => {
 const before = { schemaVersion: 1, policy: 'required', release: null, lease: { uid: 'prior-host' }, acquisition: { authorSearchProvider: 'author' } };
 const selectedBundles = ['base', 'search'];
 const acquisition = { source: 'current-selected-search-bundle', searchBundle: 'search', selectedBundles, selectionSha256: 'b'.repeat(64),
   observedAt: '2026-10-18T12:30:00.000Z', observerPid: 123, ownerUid: 'actual-owner', userClickObserved: false, historicReleaseCommitted: false };
 return { before, after: { policy: 'required', priorIntent: before, acquisition, release: null }, selectedBundles,
   searchBundle: 'search', selectionSha256: acquisition.selectionSha256, ownerPresent: true, requiredRoute: true, originalCallsDelta: 0,
   model: { isError: false, text: 'Grok 隔离搜索成功' }, seam: { ok: true, result: { content: 'Grok 隔离搜索成功' } } };
};
test('当前选择和实际 owner 授权可通过，旧记录、缺席或虚构点击/释放均不能替代', () => {
 const value = selectedAcquisition();
 assert.doesNotThrow(() => checkSelectedAcquisition(value));
 for(const changes of [{ ownerPresent: false }, { selectedBundles: ['base'] }, { originalCallsDelta: 1 }, { requiredRoute: false },
   { after: { ...value.after, priorIntent: {} } }, { after: { ...value.after, release: { fake: true } } },
   { after: { ...value.after, acquisition: { ...value.after.acquisition, source: 'old-required' } } },
   { after: { ...value.after, acquisition: { ...value.after.acquisition, userClickObserved: true } } },
   { after: { ...value.after, acquisition: { ...value.after.acquisition, historicReleaseCommitted: true } } },
   { before: { ...value.before, pause: { confirmed: true } } }, { before: { ...value.before, release: { explicit: true } } },
   { selectionSha256: 'c'.repeat(64) }, { model: { isError: true, text: 'failed' }, seam: { ok: false, error: { message: 'failed' } } }])
   assert.throws(() => checkSelectedAcquisition({ ...value, ...changes }), assert.AssertionError);
});
test('已确认暂停或冲突保留历史可通过，换写意图和调用 Grok 确实失败', () => {
 const before = { schemaVersion: 1, policy: 'released', release: { explicit: true }, pause: { confirmed: true } };
 const value = { before, after: structuredClone(before), diagnosis: { code: 'CONTROL_CONFIRMED_EXIT', requiresExplicitResume: true, message: '已停止' }, expectedCode: 'CONTROL_CONFIRMED_EXIT', grokCallsDelta: 0 };
 assert.doesNotThrow(() => checkSelectionHistoryPreserved(value));
 for(const changes of [{ after: { ...before, policy: 'required' } }, { grokCallsDelta: 1 }, { diagnosis: null }])
   assert.throws(() => checkSelectionHistoryPreserved({ ...value, ...changes }), assert.AssertionError);
});
test('成功与错误响应可靠采集，错误门禁拒绝成功响应而不解引用缺失 error', () => {
 const value = { model: { isError: true, text: '明确控制错误' }, seam: { ok: false, error: { code: 'CONTROL_RECORD_INVALID', message: '明确控制错误' } }, expectedCode: 'CONTROL_RECORD_INVALID', originalCallsDelta: 0, grokCallsDelta: 0 };
 assert.doesNotThrow(() => checkRequiredSearchError(value));
 for(const changes of [{ originalCallsDelta: 1 }, { grokCallsDelta: 1 }, { model: { isError: false, text: 'success' }, seam: { ok: true, result: {} } }, { seam: { ok: false } }])
   assert.throws(() => checkRequiredSearchError({ ...value, ...changes }), assert.AssertionError);
});
