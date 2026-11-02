import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { composeEntries, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import { WebError } from '@deepseek-ai/dsh-web';
import { createControlIntentStore } from '../../src/core/control-intent-store.mjs';
import { completeDeferredStartup } from '../../src/core/startup-recovery.mjs';

export const SEARCH_BUNDLE = 'candidate-controlled-search';
export const RECOVERY_BUNDLE = 'candidate-search-recovery';
export const NOTICE = '若已明确退出，需要完整退出并重启宿主才能完成退出';
export const REQUIRED_PROVIDER = 'grok-required：控制组件暂不可用；' + NOTICE;
export const name = 'candidate-search-control';
export const inject = ['loader', 'profileContext'];
const trace = () => globalThis.__DSH_INTERNAL_CANDIDATE__;
// Opt-in only: historical fixtures continue to read their original journal.
export function createCandidateJournal(profileDirectory, versioned = trace()?.b2ControlRecord === true) {
  const legacyPath = join(profileDirectory, 'control-intent.fixture.json');
  if (!versioned) return { path: legacyPath, read() {
    if (!existsSync(legacyPath)) return null;
    const record = JSON.parse(readFileSync(legacyPath, 'utf8'));
    if (record.schemaVersion !== 1 || !['required', 'released'].includes(record.policy)) throw new Error('CONTROL_RECORD_INVALID');
    return record;
  }, write(record) { writeFileSync(legacyPath, JSON.stringify(record, null, 2) + '\n'); } };
  const store = createControlIntentStore({ directory: join(profileDirectory, 'control-intent.records'), legacyPath,
    fault(stage) { if (trace().b2RecordFault === stage) throw new Error('Injected isolated record write interruption.'); } });
  return { store, path: store.directory, readEnvelope: () => store.read(),
    read: () => store.read()?.intent ?? null,
    write(record, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision)) throw new Error('CONTROL_EXPECTED_REVISION_REQUIRED');
      return store.compareAndSwap({ expectedRevision, intent: record });
    } };
}
export const selectedId = value => typeof value?.get === 'function' ? value.get() : value;
const nonSearch = value => { const copy = { ...value }; delete copy.searchProvider; return copy; };
const rawView = value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, selectedId(item)]));
function inputs(ctx) {
  const path = join(ctx.profileContext.dir, 'package.json');
  const text = readFileSync(path, 'utf8');
  const bundles = JSON.parse(text).dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) throw new Error('CONTROL_SELECTION_INVALID');
  const config = composeEntries([readProfilePatches('dsh', ctx.profileContext)]).find(row => row.id === 'web')?.config;
  if (!config || typeof config !== 'object') throw new Error('CONTROL_AUTHOR_CONFIG_MISSING');
  return { bundles, sha256: createHash('sha256').update(text).digest('hex'), config };
}
function webEntry(ctx) {
  const entries = [...ctx.loader.entries()].filter(row => row.options.id === 'web');
  if (entries.length !== 1 || !entries[0].fiber?.uid) throw new Error('CONTROL_TARGET_MISSING');
  return entries[0];
}
function journal(ctx) { return createCandidateJournal(ctx.profileContext.dir); }
function snapshotOf(store) {
  if (!store.readEnvelope) return { record: store.read(), revision: undefined };
  const envelope = store.readEnvelope();
  return { record: envelope?.intent ?? null, revision: envelope?.revision ?? 0 };
}
const observed = (component, event) => (trace().controlEvents ??= []).push({ component, at: new Date().toISOString(), ...event });
async function correctUnselected(ctx, reason, loadIdentity) {
  const current = inputs(ctx);
  if (current.bundles.includes(SEARCH_BUNDLE)) return { kind: 'still-selected' };
  const store = journal(ctx), { record: before, revision: expectedRevision } = snapshotOf(store);
  if (!before || before.policy === 'released') return { kind: before ? 'already-corrected' : 'no-record' };
  if (before.lease?.provider !== REQUIRED_PROVIDER || before.lease.entryId !== 'web' || before.lease.moduleName !== '@deepseek-ai/dsh-web') throw new Error('CONTROL_LEASE_IDENTITY_INVALID');
  const entry = webEntry(ctx), fiber = entry.fiber;
  const sameHost = trace().b2ControlRecord ? before.lease.hostId === trace().instanceId : before.lease.pid === process.pid;
  if (trace().b2ControlRecord && !sameHost) {
    const observe = () => {
      const input = selectionInputs(ctx);
      const componentEntry = [...ctx.loader.entries()].find(row => row.options.id === 'control-recovery');
      return { hostId: trace().instanceId, observedAt: new Date().toISOString(), selectionSha256: input.sha256,
        selectedBundles: input.bundles, searchBundle: SEARCH_BUNDLE, recoveryBundle: RECOVERY_BUNDLE,
        observer: { loadId: loadIdentity, counter: { calls: trace().calls.original,
          source: 'fixture-original-search-counter', adapterVersion: 1 } },
        component: { role: 'recovery', bundle: RECOVERY_BUNDLE, ownerUid: ctx.fiber.uid,
          loadId: loadIdentity, legalLoad: Boolean(componentEntry?.fiber === ctx.fiber
            && ctx.profileContext.startedBundles.includes(RECOVERY_BUNDLE) && componentEntry.options.disabled !== true) },
        authorSearchProvider: input.config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null };
    };
    const outcome = await completeDeferredStartup({ store: store.store, observe,
      verifyRoute(input) {
        const currentEntry = webEntry(ctx), runtime = currentEntry.fiber.ctx.get('web');
        const config = rawView(currentEntry.fiber.config);
        const authorId = input.authorSearchProvider;
        const runtimeId = runtime?.searchProviderId ?? selectedId(runtime?.config?.searchProvider) ?? null;
        return { atAuthor: currentEntry.fiber.state === 2 && currentEntry.options.name === before.lease.moduleName
          && runtimeId === authorId && (config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null) === authorId,
          actualSearchProvider: runtimeId, routeChanged: false,
          fetchPreserved: (runtime?.fetchProviderId ?? selectedId(runtime?.config?.fetchProvider)) === config.fetchProvider,
          dependenciesPreserved: Boolean(ctx.get('candidateExistingDependency'))
            && Object.hasOwn(currentEntry.options.inject ?? {}, 'candidateExistingDependency'),
          originalSearchCalls: trace().calls.original, originalSearchBaseline: input.counterBaseline,
          originalSearchDelta: trace().calls.original - input.counterBaseline,
          hostEvidence: { webUid: currentEntry.fiber.uid,
            webInject: structuredClone(currentEntry.options.inject), fetchProvider: config.fetchProvider ?? null } };
      } });
    observed('recovery', { type: 'record-corrected', reason, action: 'startup-state-correction',
      recordCommitted: outcome.recordCommitted, routeVerified: outcome.routeVerified, routeChanged: outcome.routeChanged,
      revision: outcome.envelope?.revision, historicReleaseCommitted: false });
    return { ...outcome, sameHost: false };
  }
  const actual = rawView(fiber.config), desired = current.config;
  if (sameHost && fiber.uid !== before.lease.uid) throw new Error('CONTROL_LEASE_TARGET_CHANGED');
  if (entry.options.name !== before.lease.moduleName) throw new Error('CONTROL_LEASE_MODULE_CHANGED');
  const desiredId = desired.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER;
  const actualId = actual.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER;
  if (desiredId === REQUIRED_PROVIDER) throw new Error('CONTROL_AUTHOR_STILL_REQUIRED');
  if (sameHost && actualId !== REQUIRED_PROVIDER && actualId !== desiredId) throw new Error('CONTROL_OTHER_OWNER');
  if (!sameHost && actualId !== desiredId) throw new Error('CONTROL_COLD_START_NOT_AT_AUTHOR');
  const unrelated = nonSearch(actual), inject = structuredClone(entry.options.inject);
  if (sameHost && actualId === REQUIRED_PROVIDER) {
    fiber.update({ ...desired }, true);
    let timer;
    try { await Promise.race([fiber.await(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CONTROL_RELEASE_DEADLINE')), 2_000); })]); }
    finally { clearTimeout(timer); }
  }
  const verified = rawView(fiber.config), after = inputs(ctx), recordAfter = store.read();
  const web = fiber.ctx.get('web');
  const runtimeId = web?.searchProviderId ?? selectedId(web?.config?.searchProvider);
  if (fiber.state !== 2 || webEntry(ctx).fiber !== fiber || runtimeId !== (after.config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER)
    || verified.searchProvider !== after.config.searchProvider || !isDeepStrictEqual(nonSearch(verified), unrelated)
    || !isDeepStrictEqual(entry.options.inject, inject) || !isDeepStrictEqual(recordAfter, before)
    || after.bundles.includes(SEARCH_BUNDLE)) throw new Error('CONTROL_RECOVERY_VERIFICATION_FAILED');
  const record = { ...before, policy: 'released', reason: sameHost ? 'observed-explicit-unselection-completed' : 'legal-load-observed-unselected-at-author',
    priorIntent: before, recovery: { action: sameHost ? 'finish-explicit-exit' : 'startup-state-correction', observedAt: new Date().toISOString(),
      observerPid: process.pid, selectionSha256: after.sha256, selectedBundles: after.bundles, routeVerified: true,
      authorSearchProvider: after.config.searchProvider ?? null, originalLease: before.lease,
      historicReleaseCommitted: false, previousPolicy: before.policy }, release: null };
  store.write(record, expectedRevision);
  if (!isDeepStrictEqual(store.read(), record)) throw new Error('CONTROL_RECOVERY_READBACK_FAILED');
  observed('recovery', { type: 'record-corrected', reason, action: record.recovery.action, historicReleaseCommitted: false });
  return { kind: 'corrected', sameHost };
}
// Isolated opt-in candidate: historical D-24 probes keep their original behavior.
function selectionInputs(ctx) {
  const current = inputs(ctx);
  let authorSearchProvider = process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
  for (const patch of readProfilePatches('dsh', ctx.profileContext)) {
    const rows = [...(Array.isArray(patch.insert) ? patch.insert : []), patch];
    for (const row of rows) if (row.id === 'web' && Object.hasOwn(row.config ?? {}, 'searchProvider')) {
      const selected = row.config.searchProvider;
      if (typeof selected !== 'string' || selected.length === 0) throw new Error('CONTROL_SEARCH_SELECTION_INVALID');
      authorSearchProvider = selected;
    }
  }
  return { ...current, authorSearchProvider };
}
function applySelectedOwner(ctx) {
  const store = journal(ctx);
  let disposed = false, stopped = false, authorized = false, diagnosis = null, routedUid;
  const diagnose = error => {
    diagnosis = { code: error.message, message: '控制意图未重新授权：' + error.message, requiresExplicitResume: true };
    observed('owner', { type: 'selection-authorization-blocked', diagnosis });
  };
  let releaseOutcome = null, releasePending = false;
  const release = async reason => {
    if (disposed) throw new Error('CONTROL_OWNER_ABSENT');
    const input = selectionInputs(ctx), { record: before, revision: expectedRevision } = snapshotOf(store);
    const entry = webEntry(ctx), unrelated = nonSearch(rawView(entry.fiber.config));
    stopped = true; authorized = false;
    diagnosis = { code: 'CONTROL_CONFIRMED_EXIT', message: '已确认停止或暂停，当前 bundle 选择不会覆盖它。', requiresExplicitResume: true };
    const next = { ...before, policy: 'released', reason, priorIntent: before,
      pause: { confirmed: true, reason, observedAt: new Date().toISOString() },
      release: { committedAt: new Date().toISOString(), pid: process.pid, explicit: true, author: input.config.searchProvider ?? null } };
    const restored = { ...unrelated };
    if (Object.hasOwn(input.config, 'searchProvider')) restored.searchProvider = input.config.searchProvider;
    if (!trace().b2ControlRecord) {
      store.write(next, expectedRevision);
      if (!isDeepStrictEqual(store.read(), next)) throw new Error('CONTROL_RELEASE_READBACK_FAILED');
      entry.fiber.update(restored, true);
      observed('owner', { type: 'live-explicit-release', reason });
      return entry.fiber.await();
    }
    const inject = structuredClone(entry.options.inject);
    releaseOutcome = { routeChanged: false, routeVerified: false, recordCommitted: false };
    const actualSearch = rawView(entry.fiber.config).searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
    const authorSearch = input.config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
    if (!before?.lease || before.lease.hostId !== trace().instanceId || before.lease.uid !== entry.fiber.uid
      || before.lease.moduleName !== entry.options.name || before.lease.entryId !== 'web'
      || (actualSearch !== before.lease.provider && actualSearch !== authorSearch)) {
      throw new Error('CONTROL_RELEASE_OWNERSHIP_CONFLICT');
    }
    releasePending = true;
    next.release.kind = 'intent-release-commit';
    next.release.hostId = trace().instanceId;
    // Plan §8.3: publish release intent before returning still-owned Host fields.
    // This historical intent commit does not claim a successful route change.
    try {
      store.write(next, expectedRevision);
      releaseOutcome.recordCommitted = true;
      releasePending = false;
    } catch (error) {
      releaseOutcome.recordCommitted = error.code === 'CONTROL_RECORD_COMMIT_UNCERTAIN' ? null : false;
      error.releaseOutcome = { ...releaseOutcome };
      throw error;
    }
    entry.fiber.update(restored, true);
    releaseOutcome.routeChanged = true;
    let timer;
    try {
      await Promise.race([entry.fiber.await(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CONTROL_RELEASE_DEADLINE')), 2_000);
      })]);
    } finally { clearTimeout(timer); }
    const after = selectionInputs(ctx), runtime = entry.fiber.ctx.get('web');
    if (webEntry(ctx) !== entry || entry.fiber.state !== 2
      || (runtime?.searchProviderId ?? selectedId(runtime?.config?.searchProvider) ?? null)
        !== (after.config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null)
      || !isDeepStrictEqual(nonSearch(rawView(entry.fiber.config)), unrelated)
      || !isDeepStrictEqual(entry.options.inject, inject) || after.sha256 !== input.sha256) {
      throw new Error('CONTROL_RELEASE_ROUTE_UNVERIFIED');
    }
    releaseOutcome.routeVerified = true;

    observed('owner', { type: 'live-explicit-release', reason, ...releaseOutcome });
    return { ...releaseOutcome };
  };
  const holdError = async error => {
    diagnose(error);
    const entry = webEntry(ctx), actual = rawView(entry.fiber.config), input = selectionInputs(ctx);
    const currentId = actual.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
    const authorId = input.config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
    if (currentId === REQUIRED_PROVIDER || currentId !== authorId) return;
    entry.fiber.update({ ...actual, searchProvider: REQUIRED_PROVIDER }, true);
    await entry.fiber.await();
  };
  const route = async () => {
    if (disposed || stopped) return;
    const current = selectionInputs(ctx);
    let before, expectedRevision;
    try { ({ record: before, revision: expectedRevision } = snapshotOf(store)); } catch (error) { await holdError(new Error(error.code ?? 'CONTROL_RECORD_INVALID')); return; }
    if (!current.bundles.includes(SEARCH_BUNDLE)) return;
    if (before?.policy === 'released' || before?.pause?.confirmed === true || before?.release != null) {
      stopped = true; diagnosis = { code: 'CONTROL_CONFIRMED_EXIT', message: '已确认停止或暂停，当前 bundle 选择不会覆盖它。', requiresExplicitResume: true };
      observed('owner', { type: 'confirmed-exit-retained' }); return;
    }
    const entry = webEntry(ctx), fiber = entry.fiber;
    if (authorized && routedUid === fiber.uid) return;
    if (before && (before.lease?.provider !== REQUIRED_PROVIDER || before.lease.entryId !== 'web' || before.lease.moduleName !== '@deepseek-ai/dsh-web')) {
      await holdError(new Error('CONTROL_LEASE_IDENTITY_INVALID')); return;
    }
    if (before && before.acquisition?.authorSearchProvider !== current.authorSearchProvider) {
      diagnose(new Error('CONTROL_SEARCH_SELECTION_CONFLICT')); return;
    }
    const actual = rawView(fiber.config);
    const actualId = actual.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
    const authorId = current.config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER ?? null;
    if (entry.options.name !== '@deepseek-ai/dsh-web' || (actualId !== authorId && actualId !== REQUIRED_PROVIDER)) {
      diagnose(new Error('CONTROL_OTHER_OWNER')); return;
    }
    observed('owner', { type: 'activation-input', startedBundles: [...ctx.profileContext.startedBundles], current, record: before,
      effectiveWebConfig: actual, webInject: structuredClone(entry.options.inject) });
    const acquisition = { source: 'current-selected-search-bundle', searchBundle: SEARCH_BUNDLE,
      selectedBundles: [...current.bundles], selectionSha256: current.sha256, observedAt: new Date().toISOString(),
      observerPid: process.pid, ownerUid: ctx.fiber.uid, authorSearchProvider: current.authorSearchProvider,
      ...(trace().b2ControlRecord ? { hostId: trace().instanceId } : {}),
      userClickObserved: false, historicReleaseCommitted: false };
    const record = { schemaVersion: 1, policy: 'required', reason: 'current-selected-search-bundle',
      acquiredSelection: [...current.bundles], acquisition, priorIntent: before, release: null,
      ...(before?.migration ? { migration: before.migration } : {}),
      lease: { pid: process.pid, uid: fiber.uid, entryId: 'web', moduleName: entry.options.name, provider: REQUIRED_PROVIDER, ...(trace().b2ControlRecord ? { hostId: trace().instanceId } : {}) } };
    const latest = selectionInputs(ctx);
    if (latest.sha256 !== current.sha256 || latest.authorSearchProvider !== current.authorSearchProvider || !isDeepStrictEqual(store.read(), before)) {
      await holdError(new Error('CONTROL_AUTHORIZATION_INPUT_CHANGED')); return;
    }
    store.write(record, expectedRevision);
    if (!isDeepStrictEqual(store.read(), record)) { await holdError(new Error('CONTROL_AUTHORIZATION_READBACK_FAILED')); return; }
    authorized = true; routedUid = fiber.uid; diagnosis = null;
    fiber.update({ ...actual, searchProvider: REQUIRED_PROVIDER }, true);
    await fiber.await();
    observed('owner', { type: 'current-selection-authorized', acquisition, priorPolicy: before?.policy ?? null });
  };
  ctx.on('internal/config', function(raw, next) {
    const config = next();
    if (this.entry?.options.id !== 'web' || disposed) return config;
    // A failed release commit must keep the already-owned required gate through
    // ordinary WebRuntime rebinding; stopped alone is not permission to fall back.
    if (trace().b2ControlRecord && releasePending) return { ...config, searchProvider: REQUIRED_PROVIDER };
    if (stopped || !authorized) return config;
    const current = selectionInputs(ctx), { record, revision: expectedRevision } = snapshotOf(store);
    if (!current.bundles.includes(SEARCH_BUNDLE) || record?.policy !== 'required' || record?.pause?.confirmed || record?.release != null) return config;
    if (current.authorSearchProvider !== record.acquisition.authorSearchProvider) {
      stopped = true; authorized = false;
      store.write({ ...record, policy: 'released', reason: 'explicit-file-search-selection', priorIntent: record,
        pause: { confirmed: true, reason: 'external-search-selection', selectionSha256: current.sha256 },
        release: { committedAt: new Date().toISOString(), pid: process.pid, explicit: true, author: current.config.searchProvider ?? null } }, expectedRevision);
      observed('owner', { type: 'live-explicit-release', reason: 'external-search-selection' });
      return config;
    }
    return { ...config, searchProvider: REQUIRED_PROVIDER };
  }, { global: true, prepend: true });
  ctx.on('internal/plugin', fiber => {
    if (fiber.uid !== null || fiber.parent.fiber?.entry === fiber.entry || !['control-owner', 'control-provider'].includes(fiber.entry?.options.id)) return;
    if (disposed || stopped) return;
    const current = selectionInputs(ctx);
    if (current.bundles.includes(SEARCH_BUNDLE) && fiber.entry.options.disabled !== true) return;
    void release('live-owner-explicit-exit').catch(error => diagnose(error));
  }, { global: true, prepend: true });
  ctx.provide('candidateControlOwner', { snapshot: () => ({ disposed, stopped, authorized, diagnosis, releaseOutcome, releasePending,
    record: (() => { try { return store.read(); } catch { return null; } })() }), route,
    stop: reason => release(reason) });
  ctx.effect(() => () => { disposed = true; observed('owner', { type: 'ordinary-dispose', release: false }); });
  ctx.inject(['web'], () => { void route().catch(error => { trace().controlError = error.message; diagnose(error); }); });
  observed('owner', { type: 'active', candidate: 'current-selection-authorization' });
}

export function applyOwner(ctx) {
  if (trace().currentSelectionAuthorization) return applySelectedOwner(ctx);
  const store = journal(ctx);
  let record = store.read();
  if (!record) {
    record = { schemaVersion: 1, policy: 'required', reason: 'fresh-selected-owner', acquiredSelection: inputs(ctx).bundles, release: null };
    writeFileSync(store.path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
  let disposed = false, stopped = record.policy === 'released';
  let routedUid, activationRecorded = false;
  const route = async () => {
    if (disposed) return;
    const input = inputs(ctx);
    record = store.read();
    if (!input.bundles.includes(SEARCH_BUNDLE)) { stopped = true; await correctUnselected(ctx, 'owner-observes-unselection'); return; }
    if (stopped || record.policy !== 'required') return;
    const entry = webEntry(ctx), fiber = entry.fiber;
    if (!activationRecorded) {
      observed('owner', { type: 'activation-input', startedBundles: [...ctx.profileContext.startedBundles], current: input, record,
        effectiveWebConfig: rawView(fiber.config), webInject: structuredClone(entry.options.inject) });
      activationRecorded = true;
    }
    if (routedUid === fiber.uid && (fiber.ctx.get('web')?.searchProviderId ?? selectedId(fiber.ctx.get('web')?.config?.searchProvider)) === REQUIRED_PROVIDER) return;
    record = { ...record, lease: { pid: process.pid, uid: fiber.uid, entryId: 'web', moduleName: entry.options.name, provider: REQUIRED_PROVIDER, ...(trace().b2ControlRecord ? { hostId: trace().instanceId } : {}) } };
    store.write(record); routedUid = fiber.uid;
    fiber.update({ ...input.config, searchProvider: REQUIRED_PROVIDER }, true);
    await fiber.await();
    observed('owner', { type: 'required-route', uid: fiber.uid, reason: record.reason });
  };
  ctx.on('internal/config', function(raw, next) {
    const config = next();
    if (this.entry?.options.id !== 'web' || disposed || stopped || store.read()?.policy !== 'required' || !inputs(ctx).bundles.includes(SEARCH_BUNDLE)) return config;
    return { ...config, searchProvider: REQUIRED_PROVIDER };
  }, { global: true, prepend: true });
  ctx.on('internal/plugin', fiber => {
    if (fiber.uid !== null || fiber.parent.fiber?.entry === fiber.entry || !['control-owner', 'control-provider'].includes(fiber.entry?.options.id)) return;
    const input = inputs(ctx);
    if (input.bundles.includes(SEARCH_BUNDLE) && fiber.entry.options.disabled !== true) return;
    stopped = true;
    const entry = webEntry(ctx);
    entry.fiber.update({ ...input.config }, true);
    const before = store.read();
    store.write({ ...before, policy: 'released', reason: 'live-owner-explicit-exit',
      release: { committedAt: new Date().toISOString(), pid: process.pid, explicit: true, author: input.config.searchProvider ?? null }, priorIntent: before });
    observed('owner', { type: 'live-explicit-release' });
  }, { global: true, prepend: true });
  ctx.provide('candidateControlOwner', { snapshot: () => ({ disposed, stopped, record: store.read() }), route });
  ctx.effect(() => () => { disposed = true; observed('owner', { type: 'ordinary-dispose', release: false }); });
  ctx.inject(['web'], () => { void route().catch(error => { trace().controlError = error.message; ctx.logger.error(error); }); });
  observed('owner', { type: 'active', policy: record.policy });
}
export function applyProvider(ctx) {
  ctx.web.registerSearchProvider({ id: REQUIRED_PROVIDER, available: () => true, async search() {
    const diagnosis = trace().currentSelectionAuthorization ? ctx.candidateControlOwner.snapshot().diagnosis : null;
    if (diagnosis) throw new WebError(diagnosis.message, diagnosis.code);
    trace().calls.grok = (trace().calls.grok ?? 0) + 1;
    if (trace().upstreamFailure) throw new WebError('Grok 搜索失败，未切换搜索来源。', 'CONTROLLED_UPSTREAM_ERROR');
    return { content: 'Grok 隔离搜索成功', sources: [{ url: 'https://example.invalid/control' }], truncated: false };
  } });
}
export function applyRecovery(ctx) {
  let task, disposed = false;
  const loadIdentity = randomUUID();
  const state = { phase: 'idle', outcome: null, error: null };
  const kick = reason => {
    if (task) return task;
    state.phase = 'checking';
    task = correctUnselected(ctx, reason, loadIdentity).then(outcome => {
      if (trace().b2ControlRecord && state.outcome?.recordCommitted === null && outcome.kind === 'already-corrected') {
        const envelope = journal(ctx).readEnvelope();
        if (envelope.operationId !== state.outcome.operationId) throw new Error('CONTROL_RECOVERY_UNCERTAIN_OPERATION_CHANGED');
        // Readback resolves this operation's uncertain publication, not a historic release.
        outcome = { ...outcome, recordCommitted: true, routeVerified: state.outcome.routeVerified,
          routeChanged: false, resolution: 'same-operation-readback', operationId: envelope.operationId };
      }
      state.outcome = outcome; state.phase = outcome.kind; state.error = null; return outcome;
    }).catch(error => {
      state.phase = 'incomplete'; state.outcome = error.recoveryOutcome ?? null; state.error = { code: error.code ?? null, message: error.message };
      observed('recovery', { type: 'record-commit-incomplete', reason, error: state.error, outcome: state.outcome }); throw error;
    }).finally(() => { task = null; });
    return task;
  };
  const background = reason => { if (!disposed) void kick(reason).catch(error => ctx.logger.error(error)); };
  ctx.provide('candidateControlRecovery', { snapshot: () => structuredClone(state), retry: () => kick('explicit-retry') });
  ctx.on('app-boot/config-reload', () => background('config-reload'));
  ctx.on('plugin-manager/changed', () => background('manager-change'));
  ctx.effect(() => async () => { disposed = true; await kick('owned-dispose'); });
  ctx.inject(['web'], () => background('legal-web-activation'));
  observed('recovery', { type: 'active' });
}
