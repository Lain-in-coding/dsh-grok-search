import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { prepareDesktopFixture } from './deferred-release-desktop-prepare.mjs';
import { connectRenderer, requestDesktopShutdown, waitForRenderer } from './lib/renderer-cdp.mjs';
import { desktopWorkspacePatch, prepareDesktopAcceptanceEnvironment } from './lib/desktop-acceptance-environment.mjs';
import { cleanEnvironment, commandResult, freshRun, project, redact, sha256, writeJson } from './lib/internal-candidate-utils.mjs';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';
import { discoverGrokCandidates, inspectGrokProgram } from '../src/core/program-discovery.mjs';
import { probeMcpHandshake } from '../src/core/mcp-search.mjs';
import { closeUpgradeHost, readUpgradePackage } from './verify-search-log-upgrade.mjs';

export function nativeUpdateMetadata(packages, origin, targetData = packages[1]?.data) {
  assert.equal(packages.length, 2, 'Native update needs two verified packages.');
  const versions = packages.map(pkg => pkg.manifest.version);
  assert.notEqual(versions[0], versions[1], 'Native update needs distinct package versions.');
  return {
    name: 'dsh-grok-search', 'dist-tags': { latest: versions[1] },
    versions: Object.fromEntries(packages.map((pkg, index) => {
      const bytes = index === 1 ? targetData : pkg.data;
      return [pkg.manifest.version, { ...pkg.manifest, dist: {
        tarball: `${origin}/tar/dsh-grok-search/${pkg.manifest.version}`,
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
        shasum: createHash('sha1').update(bytes).digest('hex'),
      } }];
    })),
    // Fixture-only release ages do not change public registry metadata.
    time: { created: '2026-01-01T00:00:00Z', modified: '2026-01-02T00:00:00Z',
      [versions[0]]: '2026-01-01T00:00:00Z', [versions[1]]: '2026-01-02T00:00:00Z' },
  };
}

export async function finishNativeUpdate({ process, checkpoint }) {
  if (!process || process.ended()) return;
  try { return await checkpoint?.(); }
  finally { await closeUpgradeHost(process, 30_000); }
}

export function validateNativeUpdateOutcome({
  scenario, oldVersion, targetVersion, hostVersion, checkpoints, operations, requests,
}) {
  assert.ok(['success', 'disabled', 'download-failed', 'activation-failed', 'cancel-download'].includes(scenario));
  assert.notEqual(oldVersion, targetVersion);
  const baseline = checkpoints.find(row => row.label === 'old-installed');
  const final = checkpoints.findLast(row => row.label === 'final');
  assert.ok(baseline && final, 'The original installation and final state must both be observed.');
  assert.equal(baseline.installedVersion, oldVersion);
  assert.equal(final.hostVersion, hostVersion);
  assert.equal(final.configAndCacheUnchanged, true, 'Configuration and runtime cache must remain unchanged.');
  assert.deepEqual(final.mismatched, [], 'The final installed files must match the supplied receipt.');
  assert.ok(requests.some(row => row.kind === 'tarball' && row.version === targetVersion),
    'A completed fixture must actually request the target distribution.');
  assert.equal(final.enabled, baseline.enabled, 'The installed plugin must retain its enabled state.');
  assert.equal(final.fetchProvider, baseline.fetchProvider, 'Updating search must not change the fetch provider.');
  assert.equal(final.originalSearches, baseline.originalSearches, 'The update verification must not call official search.');
  const updated = ['success', 'disabled'].includes(scenario);
  assert.equal(final.installedVersion, updated ? targetVersion : oldVersion,
    updated ? 'The target version must remain installed.' : 'A failed or cancelled update must restore the original plugin.');
  assert.equal(final.searchProvider, baseline.searchProvider);
  if (updated) {
    const restarted = checkpoints.findLast(row => row.label === 'after-restart');
    assert.ok(restarted && operations.some(row => row.method === 'desktop-restart'),
      'A successful update must be verified after a real host restart.');
    assert.equal(restarted.installedVersion, targetVersion);
    assert.equal(restarted.enabled, baseline.enabled);
    assert.equal(restarted.configAndCacheUnchanged, true);
    assert.deepEqual(restarted.mismatched, []);
  } else {
    assert.ok(requests.some(row => row.kind === 'tarball' && row.version === targetVersion && row.fault === scenario),
      'A failure result must follow the deliberately injected fault.');
  }
  if (scenario === 'disabled') {
    assert.equal(final.enabled, false);
    assert.equal(final.programPhase, null, 'A disabled plugin must not start its program.');
    assert.ok(!requests.some(row => row.kind === 'search'), 'A disabled update must not send a search request.');
  } else {
    assert.equal(final.enabled, true);
    assert.equal(final.searchProvider, 'grok-search');
    assert.equal(final.programPhase, 'ready');
    assert.equal(final.programSource, 'private-cache', 'The existing verified program cache must actually be reused.');
    const searches = operations.filter(row => row.method === 'session-search');
    assert.ok(searches.length >= (updated ? 2 : 1), 'Real Session searches must validate the final running plugin.');
    for (const search of searches) {
      assert.equal(search.sessionCompleted, true);
      assert.equal(search.toolResultSucceeded, true);
      assert.equal(search.logRecords, 1);
      assert.deepEqual(search.actualSources, ['tavily']);
      assert.equal(search.originalSearchDelta, 0);
    }
  }
  if (scenario === 'cancel-download') {
    const cancellation = operations.findLast(row => row.method === 'pluginManager/updateBundle');
    assert.equal(cancellation?.pending, false, 'The cancelled update must finish before the fixture is closed.');
    assert.equal(cancellation.result?.result?.application, 'cancelled', 'The host must acknowledge cancellation.');
    assert.equal(cancellation.result?.restore?.application, 'applied', 'The host must confirm restoration after cancellation.');
  }
  return { passed: true, outcome: updated ? 'updated' : 'restored', installedVersion: final.installedVersion,
    enabledPreserved: true, configAndCacheUnchanged: true, officialSearchesUnchanged: true };
}

export function nativeUpdateHostStages(targetVersion, baselineVersion = targetVersion) {
  assert.ok(['0.2.2-rc.1', '0.2.2-rc.2'].includes(targetVersion));
  if (targetVersion === baselineVersion) return [targetVersion];
  assert.equal(baselineVersion, '0.2.2-rc.1', 'Only a forward rc.1 to rc.2 baseline is supported.');
  assert.equal(targetVersion, '0.2.2-rc.2', 'Never hand new-host data back to an older host.');
  return [baselineVersion, targetVersion];
}

// The fixture serves the exact old release and frozen candidate through an
// isolated loopback npm registry. It never changes a public tag or user profile.
// UI interactions are performed separately through the reported CDP endpoint.
async function main() {
const [desktop, oldArgument, nextArgument, grokArgument, scenario = 'success', baselineDesktop] = process.argv.slice(2);
assert.ok(desktop && oldArgument && nextArgument && grokArgument,
  'Provide Desktop, old/new tarballs, verified Grok executable and optional scenario.');
assert.equal(process.platform, 'win32', 'This native update fixture is verified on Windows only.');
assert.ok(['success', 'disabled', 'download-failed', 'activation-failed', 'cancel-download'].includes(scenario));
const runtime = candidateRuntime(desktop);
const baselineRuntime = baselineDesktop ? candidateRuntime(baselineDesktop) : runtime;
const hostStages = nativeUpdateHostStages(runtime.app.version, baselineRuntime.app.version);
const packages = [oldArgument, nextArgument].map(readUpgradePackage);
const oldVersion = packages[0].manifest.version, targetVersion = packages[1].manifest.version;
assert.notEqual(oldVersion, targetVersion, 'Native update needs distinct package versions.');
assert.ok(packages[0].manifest.engines?.dsh?.split(' || ').includes(baselineRuntime.app.version),
  'Install the unchanged historical package on a compatible baseline host; no exemptions are granted.');
assert.ok(packages[1].manifest.engines?.dsh?.split(' || ').includes(runtime.app.version),
  'The actual candidate must support the target host.');
for (const row of packages[1].receipt.sourceHashes) assert.equal(sha256(join(project, row.file)), row.sha256);
const verificationHashes = ['scripts/verify-native-update.mjs', 'scripts/verify-search-log-upgrade.mjs']
  .map(file => ({ file, sha256: sha256(join(project, file)) }));
const run = freshRun('native-update');
const folder = join(tmpdir(), 'dsh-deferred-desktop-native-update-' + run.runId);
prepareDesktopFixture(runtime.executable, folder, { pluginManagerEntries: true, liveHmr: true, versionedControlRecord: true });
const control = JSON.parse(readFileSync(join(folder, 'local-control.json'), 'utf8'));
writeFileSync(join(control.profile, 'cordis.patch.yml'), JSON.stringify([desktopWorkspacePatch(folder)], null, 2) + '\n');
let baselineControl = control;
if (hostStages.length > 1) {
  // Assembly only: both lifetimes use the SAME target profile, userData and
  // cache. No historical package or compatibility exemption is modified.
  const baselineFolder = folder + '-baseline-runtime';
  prepareDesktopFixture(baselineRuntime.executable, baselineFolder,
    { pluginManagerEntries: true, liveHmr: true, versionedControlRecord: true });
  baselineControl = JSON.parse(readFileSync(join(baselineFolder, 'local-control.json'), 'utf8'));
  for (const path of [join(control.profile, 'node_modules/candidate-offline-fixture/package.json'),
    join(folder, 'fixture-package/package.json')]) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.engines.dsh = hostStages.join(' || ');
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  }
}
const originalFiles = [...new Set([runtime.executable, runtime.archivePath, control.pnpmEntry,
  baselineRuntime.executable, baselineRuntime.archivePath, baselineControl.pnpmEntry])];
const originalHashes = originalFiles.map(sha256);
const productPath = join(control.profile, 'node_modules/dsh-grok-search');
const configPath = join(folder, 'synthetic-shared-config.toml');
const preferencesPath = join(control.profile, 'grok-search/preferences.json');
const cache = join(control.profile, 'grok-search/runtime-cache');
const programPath = join(cache, 'verified-existing', 'grok-search-rs.exe');
const requests = [], checkpoints = [], operations = [];
const metadataCache = new Map();
const heldDownloads = new Set();
let origin, renderer, child, closed, childEnded = false, finishing = false;
let baseline, launchEnvironment, exitCode, forced = false, failed = null, ready = false, outcome = null;
let activeRuntime = baselineRuntime, activeElectron = baselineControl.electron;
let activationTar;
if (scenario === 'activation-failed') {
  const extracted = join(folder, 'fault-package');
  mkdirSync(extracted);
  const unpacked = await commandResult('tar.exe', ['-xf', packages[1].path, '-C', extracted], { timeoutMs: 30_000 });
  assert.equal(unpacked.exitCode, 0);
  // Deliberately invalid test distribution; never returned by success cases.
  writeFileSync(join(extracted, 'package/src/bundle.mjs'), 'throw new Error("INJECTED_UPDATE_STARTUP_FAILURE");\n');
  const target = join(folder, 'activation-failure.tgz');
  const packed = await commandResult('tar.exe', ['-czf', target, '-C', extracted, 'package'], { timeoutMs: 30_000 });
  assert.equal(packed.exitCode, 0);
  activationTar = readFileSync(target);
}
const safe = value => JSON.parse(redact(JSON.stringify(value), [[folder, '<ISOLATED>']]));
const json = (response, code, body) => {
  response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};
async function rpc(service, method, args = {}) {
  return renderer.evaluate(`(async () => {
    const method=${JSON.stringify(service + '/' + method)};
    const response=await fetch('/api/'+method,{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},signal:AbortSignal.timeout(180000),
      body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:${JSON.stringify(args)}}})});
    const answer=(await response.json()).result;
    if(!answer?.ok) throw new Error(answer?.error?.code || 'RPC failed');
    return answer.value;
  })()`);
}
async function probe(op, args = {}) {
  const address = JSON.parse(readFileSync(join(folder, 'probe-address.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${address.port}/probe`, {
    method: 'POST', headers: { authorization: control.token, 'content-type': 'application/json' },
    body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json();
  if (!value.ok) throw new Error(value.error?.message ?? value.error?.code ?? 'Fixture operation failed');
  return value.value;
}
async function launchDesktop() {
  const addressPath = join(folder, 'probe-address.json');
  const previousInstance = existsSync(addressPath) ? JSON.parse(readFileSync(addressPath, 'utf8')).instanceId : null;
  childEnded = false;
  child = spawn(activeElectron, [activeRuntime.archivePath, '--user-data-dir=' + control.userData,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + control.port, '--lang=zh-CN'],
  { cwd: folder, env: launchEnvironment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  child.once('error', error => { failed ??= safe({ message: error.message }); });
  closed = new Promise(done => child.once('close', code => { childEnded = true; exitCode = code; done(code); }));
  renderer = await connectRenderer(control.port, { timeoutMs: 60_000, requestTimeoutMs: 200_000 });
  await waitForRenderer(renderer, current => current.evaluate('document.readyState === "complete" && !!document.querySelector(\'button[aria-label="插件"]\')'), { timeoutMs: 60_000 });
  // Desktop runs its DSH Host in a separate process. A new fixture identity,
  // not the Electron PID, rejects a stale probe address after restart.
  await waitForRenderer(renderer, async () => {
    const state = await probe('snapshot');
    return typeof state.instanceId === 'string' && state.instanceId !== previousInstance;
  }, { timeoutMs: 60_000 });
}
async function sessionSearch() {
  const before = await probe('snapshot');
  assert.equal(before.runtimeWeb?.searchProviderId, 'grok-search', 'Enable the plugin before testing its session search.');
  const created = await rpc('session', 'create', { request: { cwd: join(folder, 'workspace') } });
  assert.ok(created.sessionId);
  await rpc('session', 'prompt', { request: { sessionId: created.sessionId, requestId: randomUUID(),
    mode: 'queue', content: [{ type: 'text', text: 'search' }] } });
  const completed = await waitForRenderer(renderer, async () => {
    const state = await probe('snapshot');
    const events = state.sessionEvents.slice(before.sessionEvents.length).filter(event => event.sessionId === created.sessionId);
    const result = events.findLast(event => event.type === 'tool/result');
    return result && events.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed')
      ? { state, events, result } : null;
  }, { timeoutMs: 30_000 });
  assert.notEqual(completed.result.data?.message?.isError, true, 'The real session tool call must succeed.');
  const call = completed.events.find(event => event.type === 'tool/call' && event.data?.name === 'web_search');
  assert.ok(call, 'The session must actually execute web_search.');
  const log = await rpc('grokSearchSettings', 'readSearchLog', { request: { sessionId: randomUUID() } });
  const row = log.records.find(record => record.sessionId === created.sessionId);
  assert.ok(row, 'The session search must appear in the private log.');
  const queries = row.queries?.length ? row.queries : [row];
  assert.ok(queries.every(query => query.served === 'tavily' && ['sources', 'ok', 'fallback'].includes(query.kind)),
    'Every query must report its actual Tavily source.');
  assert.equal(completed.state.calls.original, before.calls.original, 'The search must not bypass the plugin.');
  const evidence = { sessionCompleted: true, toolResultSucceeded: true, logRecords: 1,
    queryCount: row.queryCount ?? 1, actualSources: [...new Set(queries.map(query => query.served))],
    originalSearchDelta: completed.state.calls.original - before.calls.original };
  operations.push({ method: 'session-search', ...evidence });
  return evidence;
}
function preservedFiles() {
  return Object.fromEntries([configPath, preferencesPath, join(cache, 'active.json'), programPath]
    .map(path => [path, existsSync(path) ? sha256(path) : null]));
}
async function checkpoint(label) {
  const manifest = existsSync(join(productPath, 'package.json'))
    ? JSON.parse(readFileSync(join(productPath, 'package.json'), 'utf8')) : null;
  const receipt = packages.find(pkg => pkg.manifest.version === manifest?.version)?.receipt;
  const mismatched = receipt?.sourceHashes.filter(row => !existsSync(join(productPath, row.file))
    || sha256(join(productPath, row.file)) !== row.sha256).map(row => row.file) ?? [];
  const current = await probe('snapshot');
  const bundles = await rpc('pluginManager', 'listBundles');
  const bundle = bundles.find(row => row.name === 'dsh-grok-search');
  const record = { label, hostVersion: activeRuntime.app.version,
    installedVersion: manifest?.version ?? null, enabled: bundle?.enabled ?? null,
    mismatched, configAndCacheUnchanged: JSON.stringify(preservedFiles()) === JSON.stringify(baseline),
    searchProvider: current.runtimeWeb?.searchProviderId, fetchProvider: current.runtimeWeb?.fetchProviderId,
    programPhase: current.productProgram?.phase ?? null, programSource: current.productProgram?.program?.source ?? null,
    originalSearches: current.calls?.original ?? null,
    registryRequests: requests.filter(row => row.kind === 'tarball').length };
  checkpoints.push(record);
  writeJson(join(run.directory, `checkpoint-${checkpoints.length}.json`), record);
  if (ready) {
    assert.equal(record.configAndCacheUnchanged, true, 'Configuration and existing runtime cache must survive the operation.');
    if (manifest) {
      assert.ok(receipt, 'An installed package must match one of the two supplied versions.');
      assert.deepEqual(mismatched, [], 'Installed package differs from its supplied receipt.');
    }
  }
  return record;
}
async function finish() {
  if (finishing) return;
  finishing = true;
  try {
    await finishNativeUpdate({
      process: child ? { request: () => requestDesktopShutdown(control.port, closed, { timeoutMs: 25_000 }),
        closed, ended: () => childEnded, exitCode: () => exitCode,
        kill: () => { forced = true; child.kill(); } } : null,
      checkpoint: renderer && ready ? () => checkpoint('final') : null,
    });
    if (ready) outcome = validateNativeUpdateOutcome({
      scenario, oldVersion, targetVersion, hostVersion: runtime.app.version, checkpoints, operations, requests,
    });
  } catch (error) {
    failed ??= safe({ message: error.message });
  } finally {
    renderer?.close();
    for (const response of heldDownloads) response.destroy();
    heldDownloads.clear();
    const unchanged = originalFiles.every((path, i) => sha256(path) === originalHashes[i]);
    const sourceUnchanged = verificationHashes.every(row => sha256(join(project, row.file)) === row.sha256);
    if (!sourceUnchanged) failed ??= { message: 'Upgrade verifier source changed during the run.' };
    if (!unchanged) failed ??= { message: 'Official runtime files changed during the run.' };
    if (failed || forced || exitCode !== 0) process.exitCode = 1;
    writeJson(join(run.directory, 'summary.json'), { runId: run.runId, scenario, ready, failed,
      passed: !failed && !forced && exitCode === 0 && outcome?.passed === true, outcome,
      hostVersion: runtime.app.version, hostStages, hostDowngradeTested: false,
      officialProgramUnchanged: unchanged, sourceUnchanged, verificationHashes,
      packages: packages.map(pkg => ({ version: pkg.manifest.version, sha256: pkg.receipt.sha256 })),
      faultDistribution: scenario === 'activation-failed', checkpoints, operations, requests,
      exitCode, forced, realCredentialsUsed: false, paidSearchRequests: 0, published: false });
    console.log(JSON.stringify({ phase: 'finished', directory: run.directory, scenario, failed, exitCode, forced }));
    server.closeAllConnections();
    server.close();
  }
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/control/')) {
      if (request.method !== 'POST' || request.headers.authorization !== control.token) return json(response, 403, { error: 'Test capability required' });
      let body = '';
      for await (const part of request) { body += part; assert.ok(body.length <= 8192); }
      const args = body ? JSON.parse(body) : {};
      if (url.pathname === '/control/state') {
        return json(response, 200, { ready, scenario, oldVersion, targetVersion, requests, checkpoints, operations });
      }
      if (url.pathname === '/control/checkpoint') return json(response, 200, await checkpoint(args.label ?? 'manual'));
      if (url.pathname === '/control/search') {
        const result = await probe('product-query-result', { query: 'Native update isolated search', timeoutMs: 5000 });
        return json(response, 200, { hasSources: result.sources?.length > 0, count: result.sources?.length ?? 0 });
      }
      if (url.pathname === '/control/session-search') return json(response, 200, await sessionSearch());
      if (url.pathname === '/control/restart') {
        assert.ok(['success', 'disabled'].includes(scenario), 'Restart is limited to successful upgrade scenarios.');
        const before = await checkpoint('before-restart');
        assert.equal(before.installedVersion, targetVersion, 'Restart verification follows the actual update.');
        await requestDesktopShutdown(control.port, closed, { timeoutMs: 25_000 });
        assert.equal(exitCode, 0, 'The old instance must exit normally before restart.');
        renderer.close();
        operations.push({ method: 'desktop-restart', previousExitCode: exitCode, forced: false });
        await launchDesktop();
        await waitForRenderer(renderer, async () => {
          const state = await probe('snapshot');
          return before.enabled ? state.productProgram?.phase === 'ready' && state.productControl?.phase === 'required'
            : state.productProgram === null && state.runtimeWeb?.searchProviderId === before.searchProvider;
        }, { timeoutMs: 60_000 });
        const after = await checkpoint('after-restart');
        assert.equal(after.installedVersion, targetVersion, 'Restart must retain the verified target package.');
        assert.equal(after.enabled, before.enabled);
        assert.equal(after.searchProvider, before.searchProvider);
        if (before.enabled) assert.equal(after.programSource, 'private-cache', 'The retained cache must actually be reused.');
        return json(response, 200, after);
      }
      if (url.pathname === '/control/finish') { json(response, 200, { finishing: true }); void finish(); return; }
      if (url.pathname === '/control/host-update') {
        assert.equal(scenario, 'cancel-download', 'Direct update RPC is limited to the cancellation contract case.');
        assert.ok(!operations.some(row => row.pending), 'Only one test update may run.');
        const operation = { method: 'pluginManager/updateBundle', requestId: randomUUID(), pending: true };
        operations.push(operation);
        void rpc('pluginManager', 'updateBundle', { name: 'dsh-grok-search', version: targetVersion,
          options: { registry: origin + '/', requestId: operation.requestId } })
          .then(result => { operation.result = safe(result); })
          .catch(error => { operation.error = String(error.message).slice(0, 500); })
          .finally(() => { operation.pending = false; });
        return json(response, 200, { started: true, scope: 'host-cancellation-contract-not-update-dialog' });
      }
      // Host cancellation contract, not a claim about an update-dialog button.
      if (url.pathname === '/control/cancel-running') {
        const operation = operations.findLast(row => row.method === 'pluginManager/updateBundle');
        assert.ok(operation?.requestId, 'A real update request must already be in flight.');
        return json(response, 200, await rpc('pluginManager', 'cancelInstall', { requestId: operation.requestId }));
      }
      return json(response, 404, { error: 'Unknown test operation' });
    }
    if (url.pathname === '/tavily/search' || url.pathname === '/exa/search') {
      for await (const _ of request) { /* Synthetic credentials are neither logged nor sent outside loopback. */ }
      requests.push({ kind: 'search', path: url.pathname });
      return json(response, 200, { results: [{ url: 'https://example.test/native-update',
        title: 'Native update isolated result', content: 'Verified after native package update.' }], usage: { credits: 1 } });
    }
    if (url.pathname === '/tavily/usage') return json(response, 200, { account: { plan_usage: 12, plan_limit: 1000 }, key: { usage: 12, limit: 100 } });
    if (url.pathname.startsWith('/tar/dsh-grok-search/')) {
      const version = url.pathname.split('/').at(-1);
      const pkg = packages.find(row => row.manifest.version === version);
      requests.push({ kind: 'tarball', version, fault: pkg === packages[1] ? scenario : 'none' });
      if (!pkg) return json(response, 404, { error: 'Unknown test package version' });
      if (pkg === packages[1] && scenario === 'download-failed') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end('Injected checksum mismatch'); return;
      }
      if (pkg === packages[1] && scenario === 'cancel-download') {
        heldDownloads.add(response);
        response.on('close', () => heldDownloads.delete(response));
        return;
      }
      const bytes = pkg === packages[1] && activationTar ? activationTar : pkg.data;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      response.end(bytes); return;
    }
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!path || path === '-/ping') return json(response, 200, { ok: true });
    if (path === 'dsh-grok-search' || path.startsWith('dsh-grok-search/')) {
      requests.push({ kind: 'metadata', name: 'dsh-grok-search', path });
      const doc = nativeUpdateMetadata(packages, origin, activationTar ?? packages[1].data);
      const version = path.split('/')[1];
      return json(response, 200, !version ? doc : doc.versions[version === 'latest' ? targetVersion : version] ?? {});
    }
    if (request.method !== 'GET' || path.includes('..') || path.startsWith('-')) return json(response, 404, {});
    if (!metadataCache.has(path)) metadataCache.set(path, (async () => {
      const source = 'https://registry.npmjs.org/' + path.split('/').map(encodeURIComponent).join('/');
      const fetched = await fetch(source, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
      return { status: fetched.status, value: await fetched.json() };
    })());
    const upstream = await metadataCache.get(path);
    requests.push({ kind: 'dependency-metadata', path, status: upstream.status });
    json(response, upstream.status, upstream.value);
  } catch (error) { if (!response.headersSent) json(response, 500, { error: String(error.message).slice(0, 300) }); else response.destroy(); }
});
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  origin = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(dirname(programPath), { recursive: true });
  copyFileSync(resolve(grokArgument), programPath);
  const environment = cleanEnvironment(folder);
  const checked = await inspectGrokProgram(programPath, { env: environment });
  assert.equal(checked.version, '0.1.26');
  const overrides = { ...Object.fromEntries(Object.keys(process.env)
    .filter(key => /^(GROK_SEARCH_|TAVILY_|EXA_|TINYFISH_|FIRECRAWL_|OPENAI_COMPATIBLE_|GITHUB_TOKEN$)/i.test(key)).map(key => [key, null])),
    ...environment, GROK_SEARCH_AUTH_MODE: 'api_key', GROK_SEARCH_API_KEY: 'isolated-handshake-not-a-real-key',
    GROK_SEARCH_URL: 'http://127.0.0.1:9', GROK_SEARCH_MODEL: 'handshake-only' };
  const handshake = await probeMcpHandshake({ executable: programPath, configPath: join(folder, 'handshake-missing.toml'), envOverrides: overrides });
  assert.equal(handshake.exited, true);
  assert.equal(handshake.version, '0.1.26');
  writeJson(join(cache, 'active.json'), { schemaVersion: 1, version: checked.version,
    executable: 'verified-existing/grok-search-rs.exe', sha256: sha256(programPath),
    mcpHandshakeValidated: true, credentialsValidated: false, testFixture: 'copied-and-verified-existing-binary' });
  writeFileSync(configPath, `# Synthetic fixture: never a user credential file.\ntavily_api_url = "${origin}/tavily"\ntavily_api_key = "isolated-old-key"\nexa_api_url = "${origin}/exa"\nexa_api_key = "isolated-exa-key"\nsource_providers = ["tavily","exa"]\ntavily_enabled = true\nexa_enabled = true\ntimeout_seconds = 90\n`);
  const preferences = createPrivatePreferences({ path: preferencesPath });
  const initial = preferences.snapshot();
  preferences.save(initial.revision, { ...initial.value, grokEnabled: false, githubEnabled: false });
  // Network retries are disabled only in this fixture so deliberate download
  // faults are bounded. No release-age or compatibility policy is weakened.
  writeFileSync(join(control.profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nfetchRetries: 0\n');
  writeFileSync(join(control.profile, '.npmrc'), `registry=${origin}/\n`);
  const reservation = createServer();
  await new Promise(done => reservation.listen(0, '127.0.0.1', done));
  control.port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  launchEnvironment = prepareDesktopAcceptanceEnvironment(folder, { DSH_HOME: control.dshHome,
    DSH_DESKTOP_DSH_DIR: baselineControl.runtime,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: baselineControl.primaryRuntime, DSH_DESKTOP_PNPM_ENTRY: baselineControl.pnpmEntry,
    DSH_DESKTOP_FIXTURE_TOKEN: control.token, DSH_DESKTOP_FIXTURE_ADDRESS_FILE: join(folder, 'probe-address.json'),
    DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_B2_CONTROL_RECORD: '1', DSH_B2_PRODUCT_COUNTER: '1',
    DSH_DESKTOP_OFFLINE_SENTINEL: 'isolated-not-a-real-key', GROK_SEARCH_CONFIG: configPath,
    npm_config_registry: origin + '/',
    DSH_PRODUCT_ANALYTICS_OTLP_URL: 'http://127.0.0.1:9', NODE_OPTIONS: '--network-family-autoselection-attempt-timeout=2000' }).env;
  // pnpm/Electron use explicit verified paths. Do not let the current Node
  // installation expose a global Grok program and mask retained-cache reuse.
  const system = process.env.SystemRoot ?? 'C:/Windows';
  launchEnvironment.PATH = [join(system, 'System32'), system, join(system, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
  assert.deepEqual(discoverGrokCandidates({ env: launchEnvironment }), [], 'No global program enters this upgrade fixture.');
  await launchDesktop();
  const installed = await rpc('pluginManager', 'installBundle', { spec: 'dsh-grok-search@' + oldVersion,
    options: { registry: origin + '/', requestId: randomUUID(), enabled: scenario !== 'disabled', saveExact: true } });
  assert.equal(installed.application, 'applied', JSON.stringify(installed.error));
  for (const row of packages[0].receipt.sourceHashes) assert.equal(sha256(join(productPath, row.file)), row.sha256);
  baseline = preservedFiles();
  assert.ok(Object.values(baseline).every(Boolean));
  ready = true;
  const oldInstalled = await checkpoint('old-installed');
  assert.equal(oldInstalled.installedVersion, oldVersion, 'The baseline must be the supplied public package.');
  if (hostStages.length > 1) {
    await requestDesktopShutdown(control.port, closed, { timeoutMs: 25_000 });
    assert.equal(exitCode, 0, 'The baseline host must exit normally before a forward upgrade.');
    renderer.close();
    operations.push({ method: 'forward-host-upgrade', from: baselineRuntime.app.version,
      to: runtime.app.version, sameProfile: true, sameUserData: true, previousExitCode: exitCode });
    activeRuntime = runtime; activeElectron = control.electron;
    launchEnvironment.DSH_DESKTOP_DSH_DIR = control.runtime;
    launchEnvironment.DSH_DESKTOP_PRIMARY_RUNTIME_DIR = control.primaryRuntime;
    launchEnvironment.DSH_DESKTOP_PNPM_ENTRY = control.pnpmEntry;
    await launchDesktop();
    const retained = await checkpoint('old-package-retained-on-new-host');
    assert.equal(retained.installedVersion, oldVersion);
    assert.equal(retained.originalSearches, oldInstalled.originalSearches,
      'Do not invoke the official search while the incompatible old plugin is skipped.');
  }
  writeJson(join(run.directory, 'local-control.json'), { scenario, oldVersion, targetVersion, port: control.port, origin, token: control.token,
    folder, profile: control.profile, configPath, programPath, artifacts: run.directory });
  console.log(JSON.stringify({ phase: 'ready', scenario, port: control.port, registry: origin,
    controlFile: join(run.directory, 'local-control.json'), directory: run.directory }));
} catch (error) {
  failed = safe({ message: error.message });
  process.exitCode = 1;
  await finish();
}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
