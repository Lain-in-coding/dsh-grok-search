import assert from 'node:assert/strict';
export const NOTICE_TEXT = '若已明确退出，需要完整退出并重启宿主才能完成退出';
export function checkDeferredNotice({ model, seam, originalCalls, ownerPresent, recoveryPresent }) {
  assert.equal(ownerPresent, false); assert.equal(recoveryPresent, false);
  assert.equal(originalCalls, 0); assert.equal(model.isError, true); assert.equal(seam.ok, false);
  assert.equal(seam.error?.code, 'WEB_PROVIDER_CONFIGURED_MISSING');
  assert.ok(model.text.includes(NOTICE_TEXT)); assert.ok(seam.error.message.includes(NOTICE_TEXT));
  assert.ok(!model.text.includes('退出已完成'));
}
export function checkColdPending({ selectedBundles, searchBundle, recoveryBundle, record, authorRoute }) {
  assert.equal(selectedBundles.includes(searchBundle), false); assert.equal(selectedBundles.includes(recoveryBundle), false);
  assert.equal(authorRoute, true); assert.equal(record?.policy, 'required'); assert.equal(record?.release ?? null, null);
}
export function checkPendingLoad({ before, after, authorRoute, grokCalls, diagnosis, searchBundle, pendingObservation }) {
  assert.equal(authorRoute, true, '历史 pending 不能授权抢回作者路由');
  assert.equal(grokCalls, 0, '没有新授权时不能调用 Grok');
  if (after?.policy === 'released') {
    checkRecoveredRecord({ before, after, searchBundle, pendingObservation });
    assert.deepEqual(after.lease, before.lease, '校正记录不能换写旧 lease');
    assert.deepEqual(after.acquisition, before.acquisition, '历史校正不能伪造新接管授权');
    return;
  }
  assert.deepEqual(after, before, '冲突诊断必须保留原历史记录');
  assert.equal(diagnosis?.code, 'CONTROL_HISTORY_PENDING');
  assert.equal(diagnosis?.requiresExplicitResume, true);
  assert.ok(typeof diagnosis?.message === 'string' && diagnosis.message.length > 0, '历史 pending 必须有诚实诊断');
}
export function checkRecoveredRecord({ before, after, searchBundle, pendingObservation }) {
  assert.equal(after?.policy, 'released'); assert.equal(after.reason, 'legal-load-observed-unselected-at-author');
  assert.deepEqual(after.priorIntent, before); assert.equal(after.release, null);
  assert.equal(after.recovery?.action, 'startup-state-correction'); assert.equal(after.recovery?.historicReleaseCommitted, false);
  assert.equal(after.recovery?.routeVerified, true);
  assert.ok(Array.isArray(after.recovery?.selectedBundles));
  if (after.recovery.selectedBundles.includes(searchBundle)) {
    // A later load may select the search component; the harness must retain an independent, earlier exit observation.
    assert.ok(pendingObservation, '当前已选中搜索组件时必须提供先前历史 pending 的独立观察');
    assert.equal(pendingObservation.searchBundle, searchBundle);
    assert.ok(typeof pendingObservation.recoveryBundle === 'string');
    checkColdPending(pendingObservation);
    assert.deepEqual(pendingObservation.record, before);
    assert.deepEqual(after.recovery.pendingObservation, pendingObservation, '校正记录必须保留所据的历史观察，不能只由运行器知道');
  }
  assert.equal(after.recovery?.previousPolicy, 'required'); assert.deepEqual(after.recovery?.originalLease, before.lease);
  assert.ok(after.recovery?.observedAt); assert.match(after.recovery?.selectionSha256 ?? '', /^[a-f0-9]{64}$/);
}

export function checkSelectedAcquisition({ before, after, selectedBundles, searchBundle, selectionSha256, ownerPresent, requiredRoute, originalCallsDelta, model, seam }) {
  assert.equal(ownerPresent, true, '当前授权必须来自实际加载的 owner');
  assert.equal(requiredRoute, true); assert.equal(originalCallsDelta, 0, '接管后不能调用原搜索');
  assert.equal(selectedBundles.includes(searchBundle), true, '当前搜索 bundle 未选择不得授权');
  assert.equal(before?.policy, 'required'); assert.equal(before?.pause?.confirmed === true, false, '已确认暂停必须优先');
  assert.equal(before?.release ?? null, null, '已确认释放不得被当前选择覆盖'); assert.equal(after?.policy, 'required');
  assert.deepEqual(after.priorIntent, before, '本次授权必须完整保留旧意图');
  assert.equal(after.release, null, '本次选择授权不能虚构历史释放');
  assert.equal(after.acquisition?.source, 'current-selected-search-bundle');
  assert.equal(after.acquisition?.searchBundle, searchBundle);
  assert.deepEqual(after.acquisition?.selectedBundles, selectedBundles);
  assert.equal(after.acquisition?.selectionSha256, selectionSha256);
  assert.match(selectionSha256, /^[a-f0-9]{64}$/);
  assert.equal(after.acquisition?.userClickObserved, false, '当前选择不证明刚发生点击');
  assert.equal(after.acquisition?.historicReleaseCommitted, false);
  assert.ok(Number.isFinite(Date.parse(after.acquisition?.observedAt)));
  assert.ok(Number.isInteger(after.acquisition?.observerPid) && after.acquisition.observerPid > 0);
  assert.notEqual(after.acquisition?.ownerUid, null); assert.notEqual(after.acquisition?.ownerUid, undefined);
  assert.equal(model.isError, false); assert.equal(seam.ok, true);
  assert.ok(model.text.includes('Grok 隔离搜索成功'));
}
export function checkSelectionHistoryPreserved({ before, after, diagnosis, expectedCode, grokCallsDelta }) {
  assert.deepEqual(after, before, '阻塞或已确认暂停不能改写历史意图');
  assert.equal(grokCallsDelta, 0); assert.equal(diagnosis?.code, expectedCode);
  assert.equal(diagnosis?.requiresExplicitResume, true);
  assert.ok(typeof diagnosis?.message === 'string' && diagnosis.message.length > 0);
}
export function checkRequiredSearchError({ model, seam, expectedCode, originalCallsDelta, grokCallsDelta }) {
  assert.equal(originalCallsDelta, 0); assert.equal(model.isError, true); assert.equal(seam.ok, false);
  assert.equal(seam.error?.code, expectedCode); assert.ok(typeof seam.error?.message === 'string' && seam.error.message.length > 0);
  assert.ok(typeof model.text === 'string' && model.text.length > 0);
  if (grokCallsDelta !== undefined) assert.equal(grokCallsDelta, 0);
}
