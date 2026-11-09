import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { prepareDesktopFixture } from './deferred-release-desktop-prepare.mjs';
import { connectRenderer, requestDesktopShutdown, waitForRenderer } from './lib/renderer-cdp.mjs';
import { cleanEnvironment, freshRun, redact, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

// Visible, separately controlled, fresh Desktop profile for marketplace UI QA.
// No real user profile or keys are read. Only explicitly supplied published
// marketplace archives are installed; the product is installed through its UI.
const [desktop, marketArgument, receiptArgument, grokArgument] = process.argv.slice(2);
assert.ok(desktop && marketArgument && receiptArgument && grokArgument);
assert.equal(process.platform, 'win32', 'This marketplace UI fixture is verified on Windows only.');
const runtime = candidateRuntime(desktop), marketTar = resolve(marketArgument);
const productReceipt = JSON.parse(readFileSync(receiptArgument, 'utf8'));
assert.equal(runtime.app.version, '0.2.2-rc.1');
assert.equal(productReceipt.version, '0.2.0');
const run = freshRun('market-desktop-ui-021');
const folder = join(tmpdir(), 'dsh-deferred-desktop-market-ui-' + run.runId);
prepareDesktopFixture(runtime.executable, folder, { pluginManagerEntries: true, liveHmr: true, versionedControlRecord: true });
const control = JSON.parse(readFileSync(join(folder, 'local-control.json'), 'utf8'));
const before = [runtime.executable, runtime.archivePath, control.pnpmEntry].map(sha256);
const configPath = join(folder, 'synthetic-shared-config.toml');
const programFolder = join(folder, 'program');
mkdirSync(programFolder);
const program = join(programFolder, 'grok-search-rs.exe');
copyFileSync(resolve(grokArgument), program);
const controlToken = randomUUID(), checks = [];
let renderer, child, closed, ended = false, finalizing = false, exitCode, forced = false, error = null, initial;
async function rpc(method, args = {}) {
  return renderer.evaluate(`(async () => {
    const method=${JSON.stringify('pluginManager/' + method)};
    const response=await fetch('/api/'+method,{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},signal:AbortSignal.timeout(180000),
      body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:${JSON.stringify(args)}}})});
    const answer=(await response.json()).result;
    if(!answer?.ok) throw new Error(answer?.error?.code || 'RPC failed');return answer.value;
  })()`);
}
async function snapshot(label) {
  const bundles = await rpc('listBundles');
  const product = bundles.find(row => row.name === 'dsh-grok-search');
  const installed = join(control.profile, 'node_modules/dsh-grok-search');
  const mismatched = existsSync(join(installed, 'package.json')) ? productReceipt.sourceHashes.filter(row =>
    !existsSync(join(installed, row.file)) || sha256(join(installed, row.file)) !== row.sha256).map(row => row.file) : [];
  const value = { label, installedVersion: product?.version ?? null, applicationProblem: product?.error ?? null,
    enabled: product?.enabled ?? null, mismatched, sharedConfigUnchanged: sha256(configPath) === initial,
    markets: bundles.filter(row => row.name === 'dsh-plugin' || row.name === 'dshmarket')
      .map(row => ({ name: row.name, version: row.version, error: row.error ?? null, enabled: row.enabled })),
    pageExceptions: renderer.exceptions.map(row => ({ text: row.text, description: row.description?.slice(0, 300) })) };
  checks.push(value); writeJson(join(run.directory, `checkpoint-${checks.length}.json`), value);
  assert.equal(value.sharedConfigUnchanged, true, 'Installation must not rewrite shared credentials.');
  if (value.installedVersion === productReceipt.version) assert.deepEqual(mismatched, [], 'Installed release differs from the receipt.');
  return value;
}
async function finish() {
  if (finalizing) return;
  finalizing = true;
  try {
    if (renderer && !ended) { await snapshot('final'); await requestDesktopShutdown(control.port, closed, { timeoutMs: 25_000 }); }
  } catch (cause) {
    error ??= { message: String(cause.message).replaceAll(folder, '<ISOLATED>').slice(0, 400) };
    if (child && !ended) { forced = true; child.kill(); await closed; }
  } finally {
    renderer?.close();
    writeJson(join(run.directory, 'summary.json'), { runId: run.runId, hostVersion: runtime.app.version,
      marketTarballSha256: sha256(marketTar), productReceiptSha256: productReceipt.sha256, checks,
      originalProgramUnchanged: [runtime.executable, runtime.archivePath, control.pnpmEntry].every((p, i) => sha256(p) === before[i]),
      error, exitCode, forced, paidSearchRequests: 0, publicRegistryModified: false, published: false });
    console.log(JSON.stringify({ phase: 'finished', runId: run.runId, error, exitCode, forced }));
    server.closeAllConnections(); server.close();
  }
}
const server = createServer(async (request, response) => {
  const send = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
  if (request.url === '/tavily/search') {
    request.resume(); send({ results: [{ url: 'https://example.test/market', title: 'Isolated market search' }] }); return;
  }
  if (request.url === '/tavily/usage') { request.resume(); send({ account: { plan_limit: 1000, plan_usage: 1 } }); return; }
  if (request.method !== 'POST' || request.headers.authorization !== controlToken) { response.writeHead(403); response.end(); return; }
  try {
    if (request.url === '/checkpoint') return send(await snapshot('ui-observation'));
    if (request.url === '/finish') { send({ finishing: true }); void finish(); return; }
    response.writeHead(404); response.end();
  } catch (cause) { response.writeHead(500); send({ error: String(cause.message).slice(0, 400) }); }
});
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(configPath, `tavily_api_url = "${origin}/tavily"\ntavily_api_key = "isolated-market-key"\nsource_providers = ["tavily"]\n`);
  initial = sha256(configPath);
  writeFileSync(join(control.profile, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const portReservation = createServer();
  await new Promise(done => portReservation.listen(0, '127.0.0.1', done));
  control.port = portReservation.address().port;
  await new Promise(done => portReservation.close(done));
  const env = cleanEnvironment(folder, { DSH_HOME: control.dshHome, DSH_DESKTOP_DSH_DIR: control.runtime,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: control.primaryRuntime, DSH_DESKTOP_PNPM_ENTRY: control.pnpmEntry,
    DSH_DESKTOP_FIXTURE_TOKEN: control.token, DSH_DESKTOP_FIXTURE_ADDRESS_FILE: join(folder, 'probe-address.json'),
    DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_B2_CONTROL_RECORD: '1', DSH_B2_PRODUCT_COUNTER: '1',
    DSH_DESKTOP_OFFLINE_SENTINEL: 'isolated-not-a-real-key', GROK_SEARCH_CONFIG: configPath,
    PATH: `${programFolder};${join(process.env.SystemRoot ?? 'C:/Windows', 'System32')}`,
    npm_config_registry: 'https://registry.npmjs.org/', NODE_OPTIONS: '--network-family-autoselection-attempt-timeout=2000',
    DSH_PRODUCT_ANALYTICS_OTLP_URL: 'http://127.0.0.1:9' });
  child = spawn(control.electron, [runtime.archivePath, '--user-data-dir=' + control.userData,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + control.port, '--lang=zh-CN'],
  { cwd: folder, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  closed = new Promise(done => child.once('close', code => { ended = true; exitCode = code; done(code); }));
  renderer = await connectRenderer(control.port, { timeoutMs: 60_000, requestTimeoutMs: 200_000 });
  await waitForRenderer(renderer, current => current.evaluate('document.readyState==="complete" && !!document.querySelector(\'button[aria-label="插件"]\')'), { timeoutMs: 60_000 });
  const installation = await rpc('installBundle', { spec: marketTar, options: { registry: 'https://registry.npmjs.org/',
    requestId: randomUUID(), enabled: true } });
  writeJson(join(run.directory, 'market-install.json'), JSON.parse(redact(JSON.stringify(installation), [[folder, '<ISOLATED>']])));
  assert.equal(installation.application, 'applied', JSON.stringify(installation.error));
  await snapshot('market-installed');
  writeJson(join(run.directory, 'local-control.json'), { port: control.port, origin, token: controlToken,
    folder, profile: control.profile, artifacts: run.directory });
  console.log(JSON.stringify({ phase: 'ready', port: control.port, controlFile: join(run.directory, 'local-control.json'),
    market: installation.bundle, version: installation.version }));
} catch (cause) { error = { message: String(cause.message).slice(0, 600) }; process.exitCode = 1; await finish(); }
