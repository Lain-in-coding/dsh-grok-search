// Compare two immutable product packages in independent, synthetic-only rc.5
// Desktop profiles. Never touches the user's profile, configuration or keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { prepareDesktopFixture } from './deferred-release-desktop-prepare.mjs';
import { connectRenderer, requestDesktopShutdown, waitForRenderer } from './lib/renderer-cdp.mjs';
import { cleanEnvironment, commandResult, freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';
import { findExistingGrok } from '../src/core/program-discovery.mjs';

assert.equal(process.argv.length, 5, 'Expected baseline tarball, optimized tarball and official Desktop executable.');
const packages = process.argv.slice(2, 4).map((value, index) => {
  const tarball = resolve(value);
  const receipt = JSON.parse(readFileSync(join(dirname(tarball), 'package-receipt.json'), 'utf8'));
  assert.equal(sha256(tarball), receipt.sha256);
  return { label: index ? 'optimized' : 'baseline', tarball, receipt };
});
const runtime = candidateRuntime(process.argv[4]);
assert.equal(runtime.app.version, '0.2.1-rc.5');
const originalArchive = sha256(runtime.archivePath), originalExecutable = sha256(runtime.executable);
const run = freshRun('settings-desktop-comparison');
const temporary = join(realpathSync(tmpdir()), 'dsh-deferred-desktop-settings-performance-' + run.runId);
const inside = path => {
  const target = resolve(path), rel = relative(temporary, target);
  assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  return target;
};
const sourceHashes = ['scripts/compare-settings-desktop-performance.mjs', 'scripts/measure-settings-performance.mjs',
  'scripts/deferred-release-desktop-prepare.mjs', 'scripts/lib/renderer-cdp.mjs']
  .map(file => ({ file, sha256: sha256(join(project, file)) }));
const upstream = createServer(async (request, response) => {
  for await (const _ of request) { /* synthetic body is not retained */ }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ results: [{ url: 'https://example.test/result', title: 'Offline result',
    content: 'Synthetic result for the isolated performance comparison.' }], usage: { credits: 1 } }));
});
await new Promise(done => upstream.listen(0, '127.0.0.1', done));
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
const results = [];
const exits = [];
let owned = null, fatal = null;
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function stop() {
  if (!owned) return;
  const current = owned;
  current.renderer?.close();
  if (!current.ended) {
    try { await requestDesktopShutdown(current.port, current.closed, { timeoutMs: 20_000 }); }
    catch {
      current.forced = true;
      if (!current.ended) { current.child.kill('SIGKILL'); await current.closed; }
    }
  }
  exits.push({ label: current.label, code: current.exitCode, forced: current.forced === true,
    spawnError: current.spawnError ?? null });
  owned = null;
}
try {
  const program = await findExistingGrok({ override: process.env.DSH_LOG_GROK_PROGRAM });
  assert.equal(program.found, true, 'A previously installed grok-search-rs executable is required.');
  for (const entry of packages) {
    const folder = inside(join(temporary, entry.label));
    prepareDesktopFixture(runtime.executable, folder,
      { versionedControlRecord: true, pluginManagerEntries: true, liveHmr: true });
    const control = JSON.parse(readFileSync(join(folder, 'local-control.json'), 'utf8'));
    const extraction = inside(join(folder, 'tarball'));
    mkdirSync(extraction);
    const extract = await commandResult('tar.exe', ['-xf', entry.tarball, '-C', extraction], { timeoutMs: 30_000 });
    assert.equal(extract.exitCode, 0);
    const product = inside(join(control.profile, 'node_modules/dsh-grok-search'));
    renameSync(inside(join(extraction, 'package')), product);
    for (const row of entry.receipt.sourceHashes) assert.equal(sha256(join(product, row.file)), row.sha256);
    mkdirSync(join(product, 'node_modules'));
    for (const name of readdirSync(join(project, 'node_modules'))) {
      if (name.startsWith('.') || name === '@deepseek-ai') continue;
      symlinkSync(join(project, 'node_modules', name), join(product, 'node_modules', name), 'junction');
    }
    const manifestPath = join(control.profile, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies['dsh-grok-search'] = entry.receipt.version;
    manifest.dsh.profile.bundles.push('dsh-grok-search');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const configPath = join(folder, 'synthetic-config.toml');
    writeFileSync(join(control.profile, 'cordis.patch.yml'), JSON.stringify([
      { id: 'grok-search', config: { executable: program.path, configPath } },
    ]));
    const preferences = createPrivatePreferences({ path: join(control.profile, 'grok-search/preferences.json') });
    const initial = preferences.snapshot();
    preferences.save(initial.revision, { ...initial.value, grokEnabled: false, githubEnabled: false });
    const reservation = createNetServer();
    await new Promise(done => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    const addressPath = join(folder, 'probe-address.json');
    const env = cleanEnvironment(folder, {
      DSH_HOME: control.dshHome, DSH_DESKTOP_DSH_DIR: control.runtime,
      DSH_DESKTOP_PRIMARY_RUNTIME_DIR: control.primaryRuntime, DSH_DESKTOP_PNPM_ENTRY: control.pnpmEntry,
      DSH_DESKTOP_FIXTURE_TOKEN: control.token, DSH_DESKTOP_FIXTURE_ADDRESS_FILE: addressPath,
      DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_B2_CONTROL_RECORD: '1', DSH_B2_PRODUCT_COUNTER: '1',
      DSH_DESKTOP_OFFLINE_SENTINEL: 'offline-test-sentinel-not-a-real-key',
      DSH_PRODUCT_ANALYTICS_OTLP_URL: 'http://127.0.0.1:9',
      GROK_SEARCH_CONFIG: configPath, TAVILY_API_URL: upstreamOrigin + '/tavily',
      TAVILY_API_KEY: 'tvly-synthetic-settings-performance',
      GROK_SEARCH_SOURCE_PROVIDERS: 'tavily', TAVILY_ENABLED: 'true',
    });
    const child = spawn(control.electron, [runtime.archivePath, '--user-data-dir=' + control.userData,
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--lang=zh-CN'],
    { cwd: folder, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    const current = owned = { child, port, label: entry.label, ended: false };
    child.once('error', error => { current.spawnError = error.code ?? 'SPAWN_FAILED'; });
    current.closed = new Promise(done => child.once('close', code => { current.ended = true; current.exitCode = code; done(); }));
    console.log(JSON.stringify({ label: entry.label, phase: 'starting-official-rc5-isolated' }));
    const deadline = Date.now() + 90_000;
    while (!existsSync(addressPath) && !owned.ended && Date.now() < deadline) await sleep(200);
    assert.equal(owned.ended, false);
    assert.ok(existsSync(addressPath));
    const renderer = owned.renderer = await connectRenderer(port, { requestTimeoutMs: 60_000 });
    await renderer.send('Page.bringToFront');
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await renderer.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await waitForRenderer(renderer, current => current.evaluate(`document.readyState==='complete'
      && [...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='插件')`), { timeoutMs: 60_000 });
    const address = JSON.parse(readFileSync(addressPath, 'utf8'));
    for (let index = 0; index < 20; index++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/probe`, {
        method: 'POST', headers: { authorization: control.token, 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'product-query-result', args: { query: 'Synthetic performance query ' + index, timeoutMs: 5000 } }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.ok(result.value.sources.length > 0);
    }
    await renderer.evaluate(`document.querySelector('button[aria-label="插件"]').click()`);
    await waitForRenderer(renderer, current => current.evaluate(`[...document.querySelectorAll('button')]
      .some(e=>e.getAttribute('aria-label')==='查看 dsh-grok-search')`), { timeoutMs: 30_000 });
    const execution = await commandResult(process.execPath,
      ['scripts/measure-settings-performance.mjs', String(port), entry.label, entry.tarball, '20'],
      { cwd: project, timeoutMs: 120_000 });
    assert.equal(execution.exitCode, 0, 'Native performance measurement failed.');
    const last = execution.rawStdout.trim().split(/\r?\n/).at(-1);
    const evidence = JSON.parse(last);
    const measured = JSON.parse(readFileSync(join(evidence.directory, 'summary.json'), 'utf8'));
    assert.equal(measured.packageSha256, entry.receipt.sha256);
    assert.equal(measured.iterations.length, 5);
    results.push({ label: entry.label, sha256: entry.receipt.sha256,
      measurementRunId: measured.runId, directory: evidence.directory,
      viewport: measured.viewport, iterations: measured.iterations.map(value => ({
        readyMs: value.readyMs, logsReadyMs: value.logsReadyMs,
        frameP95Ms: value.frameP95Ms, longestFrameMs: value.longestFrameMs,
        layoutCount: value.metricsDelta.LayoutCount, layoutMs: value.metricsDelta.LayoutDuration * 1000,
        taskMs: value.metricsDelta.TaskDuration * 1000, routeHostsAfterClose: value.afterClose.routeHosts,
        layerHostsAfterClose: value.afterClose.layerHosts, listenersAfterClose: value.afterClose.JSEventListeners,
      })) });
    console.log(JSON.stringify({ label: entry.label, measurementRunId: measured.runId, passed: true }));
    await stop();
  }
} catch (error) {
  fatal = { name: error?.name ?? 'Error', message: String(error?.message ?? 'Comparison failed').slice(0, 500) };
} finally {
  await stop();
  await new Promise(done => upstream.close(done));
  const summary = { runId: run.runId, scope: 'official-windows-rc5-desktop-synthetic-only',
    passed: !fatal && results.length === 2 && exits.length === 2
      && exits.every(row => row.code === 0 && !row.forced && !row.spawnError), fatal, results, exits, sourceHashes,
    officialFilesUnchanged: sha256(runtime.archivePath) === originalArchive && sha256(runtime.executable) === originalExecutable,
    profileAndKeys: 'new synthetic-only isolated profiles', realCredentialsRead: false, paidRequests: false };
  writeJson(join(run.directory, 'summary.json'), summary);
  console.log(JSON.stringify({ runId: run.runId, directory: run.directory, passed: summary.passed, fatal }));
  process.exitCode = summary.passed ? 0 : 1;
}
