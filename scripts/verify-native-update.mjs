import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { prepareDesktopFixture } from './deferred-release-desktop-prepare.mjs';
import { connectRenderer, requestDesktopShutdown, waitForRenderer } from './lib/renderer-cdp.mjs';
import { desktopWorkspacePatch, prepareDesktopAcceptanceEnvironment } from './lib/desktop-acceptance-environment.mjs';
import { cleanEnvironment, commandResult, freshRun, project, redact, sha256, writeJson } from './lib/internal-candidate-utils.mjs';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';
import { discoverGrokCandidates, inspectGrokProgram } from '../src/core/program-discovery.mjs';
import { probeMcpHandshake } from '../src/core/mcp-search.mjs';

// The fixture serves the exact old release and frozen candidate through an
// isolated loopback npm registry. It never changes a public tag or user profile.
// UI interactions are performed separately through the reported CDP endpoint.
const [desktop, oldArgument, nextArgument, grokArgument, scenario = 'success'] = process.argv.slice(2);
assert.ok(desktop && oldArgument && nextArgument && grokArgument,
  'Provide Desktop, old/new tarballs, verified Grok executable and optional scenario.');
assert.equal(process.platform, 'win32', 'This native update fixture is verified on Windows only.');
assert.ok(['success', 'disabled', 'download-failed', 'activation-failed', 'cancel-download'].includes(scenario));
const runtime = candidateRuntime(desktop);
assert.equal(runtime.app.version, '0.2.2-rc.1');
const packages = [oldArgument, nextArgument].map(value => {
  const path = resolve(value), data = readFileSync(path);
  const receipt = JSON.parse(readFileSync(join(dirname(path), 'package-receipt.json'), 'utf8'));
  assert.equal(sha256(path), receipt.sha256);
  const bytes = gunzipSync(data, { maxOutputLength: 64 * 1024 * 1024 });
  let manifest;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const name = bytes.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    const size = Number.parseInt(bytes.toString('ascii', offset + 124, offset + 136).replace(/\0/g, '').trim(), 8) || 0;
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length);
    if (name === 'package/package.json') manifest = JSON.parse(bytes.toString('utf8', offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(manifest?.name, 'dsh-grok-search');
  assert.equal(manifest.version, receipt.version);
  return { path, data, receipt, manifest };
});
assert.equal(packages[0].manifest.version, '0.2.0');
assert.equal(packages[1].manifest.version, '0.2.1');
for (const row of packages[1].receipt.sourceHashes) assert.equal(sha256(join(project, row.file)), row.sha256);
const run = freshRun('native-update-021');
const folder = join(tmpdir(), 'dsh-deferred-desktop-native-update-' + run.runId);
prepareDesktopFixture(runtime.executable, folder, { pluginManagerEntries: true, liveHmr: true, versionedControlRecord: true });
const control = JSON.parse(readFileSync(join(folder, 'local-control.json'), 'utf8'));
writeFileSync(join(control.profile, 'cordis.patch.yml'), JSON.stringify([desktopWorkspacePatch(folder)], null, 2) + '\n');
const originalHashes = [runtime.executable, runtime.archivePath, control.pnpmEntry].map(sha256);
const productPath = join(control.profile, 'node_modules/dsh-grok-search');
const configPath = join(folder, 'synthetic-shared-config.toml');
const preferencesPath = join(control.profile, 'grok-search/preferences.json');
const cache = join(control.profile, 'grok-search/runtime-cache');
const programPath = join(cache, 'verified-existing', 'grok-search-rs.exe');
const requests = [], checkpoints = [], operations = [];
const metadataCache = new Map();
const heldDownloads = new Set();
let origin, renderer, child, closed, childEnded = false, finishing = false;
let baseline, launchEnvironment, exitCode, forced = false, failed = null, ready = false;
const sha512 = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
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
const latestManifest = pkg => {
  const bytes = pkg === packages[1] && activationTar ? activationTar : pkg.data;
  return { ...pkg.manifest, dist: { tarball: `${origin}/tar/dsh-grok-search/${pkg.manifest.version}`,
    integrity: sha512(bytes), shasum: createHash('sha1').update(bytes).digest('hex') } };
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
  child = spawn(control.electron, [runtime.archivePath, '--user-data-dir=' + control.userData,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + control.port, '--lang=zh-CN'],
  { cwd: folder, env: launchEnvironment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
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
  const record = { label, installedVersion: manifest?.version ?? null, enabled: bundle?.enabled ?? null,
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
    if (renderer && !childEnded) {
      await checkpoint('final');
      await requestDesktopShutdown(control.port, closed, { timeoutMs: 25_000 });
    }
  } catch (error) {
    failed ??= safe({ message: error.message });
    if (child && !childEnded) { forced = true; child.kill(); await closed; }
  } finally {
    renderer?.close();
    for (const response of heldDownloads) response.destroy();
    heldDownloads.clear();
    const unchanged = [runtime.executable, runtime.archivePath, control.pnpmEntry].every((path, i) => sha256(path) === originalHashes[i]);
    writeJson(join(run.directory, 'summary.json'), { runId: run.runId, scenario, ready, failed,
      hostVersion: runtime.app.version, officialProgramUnchanged: unchanged,
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
        return json(response, 200, { ready, scenario, requests, checkpoints, operations });
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
        assert.equal(before.installedVersion, '0.2.1', 'Restart verification follows the actual update.');
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
        void rpc('pluginManager', 'updateBundle', { name: 'dsh-grok-search', version: '0.2.1',
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
      const doc = { name: 'dsh-grok-search', 'dist-tags': { latest: '0.2.1' },
        versions: Object.fromEntries(packages.map(pkg => [pkg.manifest.version, latestManifest(pkg)])),
        // Synthetic old timestamps are local fixture metadata only. The public
        // registry and its release-age policies remain untouched.
        time: { created: '2026-01-01T00:00:00Z', modified: '2026-01-02T00:00:00Z',
          '0.2.0': '2026-01-01T00:00:00Z', '0.2.1': '2026-01-02T00:00:00Z' } };
      const version = path.split('/')[1];
      return json(response, 200, !version ? doc : doc.versions[version === 'latest' ? '0.2.1' : version] ?? {});
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
  launchEnvironment = prepareDesktopAcceptanceEnvironment(folder, { DSH_HOME: control.dshHome, DSH_DESKTOP_DSH_DIR: control.runtime,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: control.primaryRuntime, DSH_DESKTOP_PNPM_ENTRY: control.pnpmEntry,
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
  const installed = await rpc('pluginManager', 'installBundle', { spec: 'dsh-grok-search@0.2.0',
    options: { registry: origin + '/', requestId: randomUUID(), enabled: scenario !== 'disabled', saveExact: true } });
  assert.equal(installed.application, 'applied', JSON.stringify(installed.error));
  for (const row of packages[0].receipt.sourceHashes) assert.equal(sha256(join(productPath, row.file)), row.sha256);
  baseline = preservedFiles();
  assert.ok(Object.values(baseline).every(Boolean));
  ready = true;
  await checkpoint('old-installed');
  writeJson(join(run.directory, 'local-control.json'), { scenario, port: control.port, origin, token: control.token,
    folder, profile: control.profile, configPath, programPath, artifacts: run.directory });
  console.log(JSON.stringify({ phase: 'ready', scenario, port: control.port, registry: origin,
    controlFile: join(run.directory, 'local-control.json'), directory: run.directory }));
} catch (error) {
  failed = safe({ message: error.message });
  process.exitCode = 1;
  await finish();
}
