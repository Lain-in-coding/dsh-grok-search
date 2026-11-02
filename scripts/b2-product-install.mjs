import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { cleanEnvironment, commandResult, freshRun, npmCli, project, receipt, redact, sha256, writeJson } from './lib/internal-candidate-utils.mjs';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--desktop-rc2', '--desktop-rc21', '--product-package'].includes(process.argv[index])
    || !process.argv[index + 1]) throw new Error('Expected named Desktop and package arguments.');
  options.set(process.argv[index], process.argv[index + 1]);
}
const runtimes = [candidateRuntime(options.get('--desktop-rc2')), candidateRuntime(options.get('--desktop-rc21'))];
const targetVersions = (process.env.DSH_B2_TARGET_VERSIONS ?? '0.2.1-rc.2,0.2.1-rc.3').split(',').map(value => value.trim()).filter(Boolean);
assert.deepEqual(runtimes.map(runtime => runtime.app.version), targetVersions);
const productTarball = resolve(options.get('--product-package'));
if (!existsSync(productTarball)) throw new Error('Package tarball is missing: ' + productTarball);
const { runId, directory } = freshRun('b2-product-install');
const root = mkdtempSync(join(tmpdir(), 'dsh-product-install-'));
const replacements = [[root, '<TEMPORARY_RUN>'], [dirname(productTarball), '<PRODUCT_PACKAGE>'],
  ...runtimes.map(runtime => [dirname(runtime.executable), `<DESKTOP_${runtime.app.version}>`])];
const sanitize = value => redact(String(value), replacements);
const safe = value => JSON.parse(sanitize(JSON.stringify(value)));
const results = [], hosts = [];
let sequence = 0;

function startHost(runtime, profile, env, initialize) {
  const state = { version: runtime.app.version, stdout: '', stderr: '', events: [], pending: new Map(), stopped: false };
  const child = spawn(runtime.executable, ['--expose-internals', join(project, 'scripts/internal-candidate-host.mjs'), runtime.archivePath, root], {
    cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  state.child = child;
  // A host that exits during startup closes its IPC channel first; keep that as a recorded
  // failure instead of an unhandled 'error' event that would hide the original startup error.
  child.on('error', error => { state.events.push({ type: 'child-error', error: { message: error.message, code: error.code ?? null } }); });
  child.stdout.on('data', data => { state.stdout += data; });
  child.stderr.on('data', data => { state.stderr += data; });
  state.closed = new Promise(done => child.once('close', (exitCode, signal) => {
    state.stopped = true; state.exitCode = exitCode; state.signal = signal;
    for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Host closed before reply.')); }
    state.pending.clear(); done();
  }));
  child.on('message', message => {
    if (message.type !== 'reply') { state.events.push(message); return; }
    const pending = state.pending.get(message.id); if (!pending) return;
    clearTimeout(pending.timer); state.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value); else pending.reject(new Error(message.error.message));
  });
  const host = {
    runtime, state, profile,
    request(op, args = {}) {
      const id = 'product-install-' + (++sequence);
      return new Promise((resolveReply, rejectReply) => {
        if (state.stopped || !child.connected) { rejectReply(new Error('Host is not connected: ' + op)); return; }
        const timer = setTimeout(() => { state.pending.delete(id); rejectReply(new Error('Host reply timed out: ' + op)); }, 20_000);
        state.pending.set(id, { resolve: resolveReply, reject: rejectReply, timer });
        child.send({ id, op, args }, error => {
          if (!error) return;
          clearTimeout(timer); state.pending.delete(id); rejectReply(error);
        });
      });
    },
    async ready() {
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        const fatal = state.events.find(event => event.type === 'fatal');
        if (fatal) throw new Error(fatal.error.message);
        const ready = state.events.find(event => event.type === 'ready');
        if (ready) return ready;
        if (state.stopped) throw new Error('Host stopped before ready: ' + state.stderr);
        await new Promise(done => setTimeout(done, 30));
      }
      throw new Error('Host startup timed out.');
    },
    async close() {
      if (!state.stopped) { try { await host.request('close'); } catch { if (!state.stopped) child.kill('SIGKILL'); } }
      await state.closed;
    },
  };
  hosts.push(host); child.send(initialize);
  return host;
}

function packageReceipt(tarball) {
  const file = join(dirname(tarball), 'package-receipt.json');
  if (!existsSync(file)) throw new Error('Package receipt is missing: ' + file);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.sha256 !== sha256(tarball)) throw new Error('Package tarball hash does not match its receipt.');
  return value;
}

// The product record lives in the isolated candidate profile. With the single bundle deselected
// no product entry exists to report it, so the record is read directly from disk.
function recordStore(profile) {
  return createControlIntentStore({ directory: join(profile, 'control-intent.records'),
    legacyPath: join(profile, 'control-intent.fixture.json'), trustedRoot: profile });
}

function verifyInstalled(profile, receiptValue, sourceRoot) {
  const installed = join(profile, 'node_modules', receiptValue.name);
  if (!existsSync(join(installed, 'package.json'))) throw new Error('Installed package is missing: ' + receiptValue.name);
  for (const file of receiptValue.files) {
    const target = join(installed, file.path), source = join(sourceRoot, file.path);
    if (!existsSync(target) || sha256(target) !== sha256(source)) throw new Error('Installed package content differs: ' + file.path);
  }
  return { name: receiptValue.name, version: receiptValue.version, files: receiptValue.files.length, hash: receiptValue.sha256 };
}

async function install(runtime) {
  const profile = join(root, runtime.app.version, 'dsh-home', 'profiles', 'candidate');
  mkdirSync(profile, { recursive: true });
  const env = cleanEnvironment(join(root, runtime.app.version), { DSH_HOME: join(root, runtime.app.version, 'dsh-home'),
    ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: runtime.executable });
  const configFile = join(root, runtime.app.version, 'npm-empty.ini');
  const globalConfigFile = join(root, runtime.app.version, 'npm-global-empty.ini');
  writeFileSync(configFile, ''); writeFileSync(globalConfigFile, '');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'candidate-profile', version: '0.0.0', private: true, type: 'module' }, null, 2));
  const execution = await commandResult(process.execPath, [npmCli, 'install', productTarball,
    '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', join(root, runtime.app.version, 'npm-cache'),
    '--userconfig', configFile, '--globalconfig', globalConfigFile],
  { cwd: profile, env: { ...env, ELECTRON_RUN_AS_NODE: '' }, timeoutMs: 180_000 });
  writeJson(join(directory, runtime.app.version + '-npm-install.json'), receipt(execution));
  assert.equal(execution.exitCode, 0, execution.stderr);
  const productReceipt = packageReceipt(productTarball);
  const installed = [verifyInstalled(profile, productReceipt, project)];
  return { profile, env, installed, productReceipt, installExitCode: execution.exitCode };
}

async function runVersion(runtime) {
  const installed = await install(runtime);
  const first = startHost(runtime, installed.profile, installed.env, { productWiring: true });
  const firstReady = await first.ready();
  assert.deepEqual(firstReady.failed, []); assert.deepEqual(firstReady.pending, []);
  assert.equal(firstReady.runtimeWeb.searchProviderId, 'grok-search');
  assert.equal(firstReady.runtimeWeb.fetchProviderId, 'candidate-fetch');
  assert.equal(firstReady.existingDependencyPresent, true);
  assert.equal(firstReady.productControl.phase, 'required');
  assert.ok(firstReady.productRouteVerifier);
  assert.ok(firstReady.productRecovery);
  const before = firstReady.productControl.recordEnvelope;
  assert.equal(before.intent.policy, 'required');
  assert.equal(before.intent.release, null);
  assert.equal(before.intent.acquisition.authorSearchProvider, 'candidate-original');
  await first.close();
  // D-28 single-bundle build: deselecting the bundle removes every entry, so a restart restores
  // the author route and leaves the record pending; re-enabling re-establishes the D-26 intent.
  const selectionPath = join(installed.profile, 'package.json');
  const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
  selection.dsh.profile.bundles = selection.dsh.profile.bundles.filter(name => name !== 'dsh-grok-search');
  writeFileSync(selectionPath, JSON.stringify(selection, null, 2) + '\n');
  const second = startHost(runtime, installed.profile, installed.env, { productWiring: true, preserveProductSelection: true });
  const secondReady = await second.ready();
  assert.deepEqual(secondReady.failed, []); assert.deepEqual(secondReady.pending, []);
  assert.equal(secondReady.productControl, null);
  assert.equal(secondReady.productRecovery, null);
  assert.equal(secondReady.productRouteVerifier, null);
  const author = await second.request('direct-search');
  assert.equal(author.ok, true);
  const disabledState = await second.request('snapshot');
  assert.equal(disabledState.runtimeWeb.searchProviderId, 'candidate-original');
  assert.equal(disabledState.runtimeWeb.fetchProviderId, 'candidate-fetch');
  const disabledRecord = recordStore(installed.profile).read();
  assert.deepEqual(disabledRecord, before);
  await second.close();
  const restored = JSON.parse(readFileSync(selectionPath, 'utf8'));
  restored.dsh.profile.bundles = [...restored.dsh.profile.bundles, 'dsh-grok-search'];
  writeFileSync(selectionPath, JSON.stringify(restored, null, 2) + '\n');
  const third = startHost(runtime, installed.profile, installed.env, { productWiring: true, preserveProductSelection: true });
  const thirdReady = await third.ready();
  assert.deepEqual(thirdReady.failed, []); assert.deepEqual(thirdReady.pending, []);
  assert.equal(thirdReady.productControl.phase, 'required');
  assert.equal(thirdReady.runtimeWeb.searchProviderId, 'grok-search');
  const after = thirdReady.productControl.recordEnvelope;
  assert.equal(after.intent.policy, 'required');
  assert.equal(after.intent.release, null);
  assert.equal(after.intent.acquisition.source, 'current-selected-search-bundle');
  assert.deepEqual(after.intent.priorIntent, before.intent);
  assert.ok(thirdReady.productRecovery);
  assert.ok(thirdReady.productRouteVerifier);
  const final = await third.request('snapshot');
  assert.equal(final.runtimeWeb.fetchProviderId, 'candidate-fetch');
  assert.equal(final.existingDependencyPresent, true);
  assert.ok(final.webInject.includes('candidateExistingDependency'));
  await third.close();
  return { firstReady, before, secondReady, disabledState, disabledRecord, author, thirdReady, after, final, install: installed };
}

let fatal = null;
try {
  for (const runtime of runtimes) {
    const evidence = await runVersion(runtime);
    results.push({ version: runtime.app.version, scenario: 'installed-product-ownership-and-recovery', status: 'pass', evidence });
  }
} catch (error) { fatal = { message: error.message, stack: error.stack }; }
finally {
  for (const host of hosts) {
    try { await host.close(); }
    catch (error) { fatal ??= { message: 'Host cleanup failed: ' + error.message, stack: error.stack }; }
  }
  const hostDiagnostics = hosts.map(host => ({ version: host.state.version, exitCode: host.state.exitCode ?? null,
    signal: host.state.signal ?? null, stderrTail: host.state.stderr.slice(-4000),
    events: host.state.events.filter(event => event.type !== 'ready').slice(-10) }));
  const summary = { runId, status: fatal ? 'fail' : 'pass', counts: { pass: results.filter(row => row.status === 'pass').length,
    fail: fatal ? 1 : 0 }, fatal, ...(fatal ? { hostDiagnostics } : {}), scope: 'actual-RC2-Host-npm-installed-single-product-bundle',
    npmInstallValidated: true, pluginManagerValidated: false, packagedDesktopInstallValidated: true,
    releaseChannel: packageReceipt(productTarball).releaseChannel,
    candidatePackageValidated: !fatal, betaPackageValidated: !fatal && packageReceipt(productTarball).releaseChannel === 'beta',
    desktopUiValidated: false, productIntegrated: false, routeCounterAdapter: 'canonical-session-event', results,
    sourceHashes: ['src/control.mjs', 'src/recovery.mjs', 'src/route-verifier.mjs', 'src/core/product-control.mjs',
      'src/core/original-search-counter.mjs',
      'cordis.patch.yml', 'scripts/internal-candidate-host.mjs', 'fixtures/internal-candidate/host-fixture.mjs']
      .map(file => ({ file, sha256: sha256(join(project, file)) })) };
  writeJson(join(directory, 'summary.json'), safe(summary));
  console.log(JSON.stringify(safe(summary), null, 2));
  process.exitCode = fatal ? 1 : 0;
}
