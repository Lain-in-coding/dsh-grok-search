import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { freshRun, project, writeJson, redact, cleanEnvironment, sha256 } from './lib/internal-candidate-utils.mjs';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--desktop-rc2', '--desktop-rc21'].includes(process.argv[i]) || !process.argv[i + 1]) throw new Error('Expected both named Desktop paths.');
  options.set(process.argv[i], process.argv[i + 1]);
}
const runtimes = [candidateRuntime(options.get('--desktop-rc2')), candidateRuntime(options.get('--desktop-rc21'))];
assert.deepEqual(runtimes.map(row => row.app.version), ['0.2.0-rc.2', '0.2.1-rc.2']);
const { runId, directory } = freshRun('b2-control-host');
const root = mkdtempSync(join(tmpdir(), 'dsh-b2-host-'));
const replacements = [[root, '<TEMPORARY_RUN>'], ...runtimes.map(row => [dirname(row.executable), `<DESKTOP_${row.app.version}>`])];
const sanitize = value => redact(String(value), replacements);
const safe = value => JSON.parse(sanitize(JSON.stringify(value)));
const hosts = [], results = [];
let sequence = 0;
function start(runtime, folder, initialize, fault = null) {
  mkdirSync(folder, { recursive: true });
  const env = cleanEnvironment(folder, { DSH_HOME: join(folder, 'dsh-home'), ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: runtime.executable });
  const args = ['--expose-internals', join(project, 'scripts/deferred-release-host.mjs'), runtime.archivePath, folder];
  const child = spawn(runtime.executable, args, { cwd: folder, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state = { command: sanitize(runtime.executable), args: args.map(sanitize), cwd: sanitize(folder),
    startedAt: new Date().toISOString(), stdout: '', stderr: '', events: [], requests: [], pending: new Map(), stopped: false };
  child.stdout.on('data', data => { state.stdout += data; });
  child.stderr.on('data', data => { state.stderr += data; });
  child.on('error', error => { state.spawnError = error.message; });
  const timer = setTimeout(() => { state.timedOut = true; child.kill('SIGKILL'); }, 60_000);
  state.closed = new Promise(done => child.once('close', (exitCode, signal) => {
    clearTimeout(timer); Object.assign(state, { stopped: true, exitCode, signal });
    for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Host closed before reply.')); }
    state.pending.clear(); done();
  }));
  child.on('message', message => {
    if (message.type !== 'reply') { state.events.push(message); return; }
    const pending = state.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); state.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value); else pending.reject(new Error(message.error.message));
  });
  const host = { runtime, folder, state, child,
    request(op, args = {}) {
      const id = 'b2-' + (++sequence);
      state.requests.push({ op, args });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { state.pending.delete(id); reject(new Error('Host reply timed out: ' + op)); }, 12_000);
        state.pending.set(id, { resolve, reject, timer }); child.send({ id, op, args });
      });
    },
    async ready() {
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        const fatal = state.events.find(row => row.type === 'fatal');
        if (fatal) throw new Error(fatal.error.message);
        const ready = state.events.find(row => row.type === 'ready');
        if (ready) { assert.deepEqual(ready.failed, []); assert.deepEqual(ready.pending, []); return ready; }
        if (state.stopped) throw new Error('Host stopped before ready: ' + state.stderr);
        await new Promise(done => setTimeout(done, 30));
      }
      throw new Error('Host startup timed out.');
    },
    async close() {
      if (!state.stopped) { try { await host.request('close'); } catch (error) { state.closeError = error.message; child.kill('SIGKILL'); } }
      await state.closed;
    },
  };
  hosts.push(host);
  child.send({ initialize, currentSelectionAuthorization: true, b2ControlRecord: true, b2RecordFault: fault });
  return host;
}
function storeAt(folder) {
  const profile = join(folder, 'dsh-home/profiles/deferred');
  return createControlIntentStore({ directory: join(profile, 'control-intent.records'),
    legacyPath: join(profile, 'control-intent.fixture.json'), trustedRoot: profile });
}
function stoppedSelection(folder, keepRecovery) {
  const path = join(folder, 'dsh-home/profiles/deferred/package.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.dsh.profile.bundles = config.dsh.profile.bundles.filter(name => name !== 'candidate-controlled-search'
    && (keepRecovery || name !== 'candidate-search-recovery'));
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}
async function retained(host, expectedRecord) {
  const state = await host.request('snapshot');
  assert.equal(state.existingDependencyPresent, true);
  assert.equal(state.runtimeWeb.fetchProviderId, 'candidate-fetch');
  assert.equal(state.calls.original, 0);
  if (expectedRecord) assert.deepEqual(state.recordEnvelope, expectedRecord);
  return state;
}
async function seedPending(runtime, folder) {
  const owner = start(runtime, folder, true); const ready = await owner.ready();
  assert.equal(ready.recordEnvelope?.revision, 1);
  assert.equal(ready.record?.lease?.hostId, ready.instanceId);
  assert.equal(ready.runtimeWeb.searchProviderId, ready.record.lease.provider);
  const before = storeAt(folder).read();
  const disposed = await owner.request('dispose-owner');
  assert.deepEqual(disposed.recordEnvelope, before);
  const upstream = await owner.request('seam');
  assert.equal(upstream.ok, false); // Dependency disposal may remove the provider; it still must not release or fall back.
  assert.equal(upstream.error.code, 'WEB_PROVIDER_CONFIGURED_MISSING');
  assert.equal(upstream.calls.original, 0);
  await owner.close();
  assert.deepEqual(storeAt(folder).read(), before);
  return before;
}
async function scenario(runtime, name, work) {
  const folder = join(root, runtime.app.version, name);
  const evidence = { version: runtime.app.version, scenario: name, scope: 'actual-fixed-RC2-Host-not-Desktop-UI' };
  try { Object.assign(evidence, await work(folder), { status: 'pass' }); }
  catch (error) { Object.assign(evidence, { status: 'fail', error: { message: error.message, stack: error.stack } }); }
  results.push(evidence); writeJson(join(directory, runtime.app.version + '-' + name + '.json'), safe(evidence));
  if (evidence.status !== 'pass') throw new Error(evidence.error.message);
}
let fatal = null;
try {
  for (const runtime of runtimes) {
    await scenario(runtime, 'selected-recovery-startup-cas', async folder => {
      const before = await seedPending(runtime, folder); stoppedSelection(folder, true);
      const next = start(runtime, folder, false); const ready = await next.ready();
      await next.request('wait-recovery'); const corrected = await retained(next);
      assert.equal(corrected.recordEnvelope.revision, before.revision + 1);
      assert.equal(corrected.record.recovery.action, 'startup-state-correction');
      assert.equal(corrected.record.release, null);
      assert.deepEqual(corrected.record.priorIntent, before.intent);
      assert.deepEqual(corrected.record.recovery.originalLease, before.intent.lease);
      assert.equal(corrected.record.recovery.historicReleaseCommitted, false);
      assert.equal(corrected.runtimeWeb.searchProviderId, 'candidate-original');
      assert.throws(() => storeAt(folder).compareAndSwap({ expectedRevision: before.revision, intent: before.intent }), { code: 'CONTROL_CAS_CONFLICT' });
      await next.request('wait-recovery'); assert.deepEqual(storeAt(folder).read(), corrected.recordEnvelope);
      await next.close(); return { before, startup: ready, corrected, staleWriteConflict: true, repeatIdempotent: true };
    });
    await scenario(runtime, 'all-unselected-then-legal-load', async folder => {
      const before = await seedPending(runtime, folder); stoppedSelection(folder, false);
      const cold = start(runtime, folder, false); await cold.ready();
      const pending = await retained(cold, before);
      assert.equal(pending.ownerPresent, false); assert.equal(pending.recoveryPresent, false);
      assert.equal(pending.runtimeWeb.searchProviderId, 'candidate-original'); await cold.close();
      const path = join(folder, 'dsh-home/profiles/deferred/package.json');
      const selection = JSON.parse(readFileSync(path, 'utf8')); selection.dsh.profile.bundles.push('candidate-search-recovery');
      writeFileSync(path, JSON.stringify(selection, null, 2) + '\n');
      const legal = start(runtime, folder, false); await legal.ready(); await legal.request('wait-recovery');
      const corrected = await retained(legal); assert.equal(corrected.recordEnvelope.revision, before.revision + 1);
      assert.deepEqual(corrected.record.priorIntent, before.intent); await legal.close(); return { pending, corrected };
    });
    await scenario(runtime, 'owner-immediate-release-and-failure', async folder => {
      const owner = start(runtime, folder, true); await owner.ready(); const before = await retained(owner);
      await owner.request('upstream-failure', { enabled: true }); const failure = await owner.request('seam');
      assert.equal(failure.ok, false); assert.equal(failure.error.code, 'CONTROLLED_UPSTREAM_ERROR'); assert.equal(failure.calls.original, 0);
      await owner.request('upstream-failure', { enabled: false });
      const stopped = await owner.request('confirm-stop');
      assert.equal(stopped.recordEnvelope.revision, before.recordEnvelope.revision + 1);
      assert.equal(stopped.runtimeWeb.searchProviderId, 'candidate-original');
      assert.deepEqual(stopped.owner.releaseOutcome, { routeChanged: true, routeVerified: true, recordCommitted: true });
      assert.equal(stopped.record.release.explicit, true); assert.equal(stopped.record.release.kind, 'intent-release-commit');
      assert.equal(Object.hasOwn(stopped.record.release, 'routeVerified'), false);
      const after = await retained(owner); assert.deepEqual(after.webInject, before.webInject); await owner.close();
      return { before, failure, stopped, after };
    });
    await scenario(runtime, 'release-lease-conflict-preserves-fields', async folder => {
      const owner = start(runtime, folder, true); await owner.ready();
      const before = await retained(owner);
      // Synthetic changed lease in this temporary store; not a claim of private-field coexistence.
      const competing = storeAt(folder).compareAndSwap({ expectedRevision: before.recordEnvelope.revision,
        intent: { ...before.record, priorIntent: before.record, reason: 'synthetic-competing-lease',
          lease: { ...before.record.lease, hostId: randomUUID() } } });
      await assert.rejects(() => owner.request('confirm-stop'), /CONTROL_RELEASE_OWNERSHIP_CONFLICT/);
      const conflict = await retained(owner, competing);
      assert.equal(conflict.runtimeWeb.searchProviderId, before.runtimeWeb.searchProviderId);
      assert.deepEqual(conflict.webInject, before.webInject);
      assert.equal(conflict.owner.releaseOutcome.recordCommitted, false);
      assert.equal(conflict.owner.releaseOutcome.routeChanged, false);
      await owner.close(); return { before, competing, conflict, syntheticChangedLease: true };
    });
    await scenario(runtime, 'release-write-failure-keeps-route-required', async folder => {
      const owner = start(runtime, folder, true); await owner.ready();
      const before = await retained(owner);
      await owner.request('record-fault', { stage: 'before-publish' });
      await assert.rejects(() => owner.request('confirm-stop'), /Control write did not publish/);
      const incomplete = await retained(owner, before.recordEnvelope);
      assert.deepEqual(incomplete.owner.releaseOutcome, { routeChanged: false, routeVerified: false, recordCommitted: false });
      assert.equal(incomplete.runtimeWeb.searchProviderId, before.record.lease.provider);
      const failure = await owner.request('seam'); assert.equal(failure.ok, false); assert.equal(failure.calls.original, 0);
      const rebuilt = await owner.request('rebuild-web-from-author');
      assert.equal(rebuilt.runtimeWeb.searchProviderId, before.record.lease.provider);
      assert.deepEqual(rebuilt.recordEnvelope, before.recordEnvelope);
      assert.equal(rebuilt.owner.releasePending, true);
      const reboundFailure = await owner.request('seam'); assert.equal(reboundFailure.ok, false); assert.equal(reboundFailure.calls.original, 0);
      await owner.request('record-fault', { stage: null });
      const stopped = await owner.request('confirm-stop');
      assert.equal(stopped.runtimeWeb.searchProviderId, 'candidate-original');
      assert.equal(stopped.recordEnvelope.revision, before.recordEnvelope.revision + 1);
      assert.equal(stopped.owner.releaseOutcome.routeVerified, true);
      await owner.close(); return { before, incomplete, failure, rebuilt, reboundFailure, stopped };
    });
    for (const stage of ['before-publish', 'after-publish']) await scenario(runtime, 'startup-' + stage, async folder => {
      const before = await seedPending(runtime, folder); stoppedSelection(folder, true);
      const interrupted = start(runtime, folder, false, stage); await interrupted.ready();
      const failed = await retained(interrupted); assert.equal(failed.recovery.phase, 'incomplete');
      assert.equal(failed.recovery.outcome.recordCommitted, stage === 'after-publish' ? null : false);
      assert.equal(failed.recovery.outcome.routeVerified, true);
      assert.equal(failed.runtimeWeb.searchProviderId, 'candidate-original');
      assert.equal(storeAt(folder).read().revision, stage === 'after-publish' ? before.revision + 1 : before.revision);
      await interrupted.close();
      const retry = start(runtime, folder, false); await retry.ready(); await retry.request('wait-recovery');
      const recovered = await retained(retry); assert.equal(recovered.recordEnvelope.revision, before.revision + 1);
      assert.deepEqual(recovered.record.priorIntent, before.intent); await retry.close(); return { before, failed, recovered };
    });
  }
} catch (error) { fatal = { message: error.message, stack: error.stack }; }
finally {
  for (const host of hosts) await host.close();
  for (const [index, host] of hosts.entries()) {
    const { closed: _closed, pending: _pending, ...record } = host.state;
    writeJson(join(directory, 'host-' + index + '-execution.json'), safe(record));
  }
  const sourceFiles = ['src/core/control-intent-store.mjs','src/core/startup-recovery.mjs','fixtures/deferred-release/control.mjs','scripts/deferred-release-host.mjs','scripts/b2-control-host.mjs'];
  const summary = {runId,status:fatal?'fail':'pass',counts:{pass:results.filter(row=>row.status==='pass').length,fail:results.filter(row=>row.status==='fail').length},fatal,
    scope:'actual-fixed-RC2-Host-not-Desktop-UI',desktopUiValidated:false,productIntegrated:false,results:results.map(({version,scenario,status})=>({version,scenario,status})),
    sourceHashes:sourceFiles.map(file=>({file,sha256:sha256(join(project,file))})),hostExitCodes:hosts.map(host=>host.state.exitCode)};
  writeJson(join(directory,'summary.json'),safe(summary));console.log(JSON.stringify(safe(summary),null,2));process.exitCode=fatal?1:0;
}
