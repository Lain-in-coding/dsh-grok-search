import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';
import { cleanEnvironment, commandResult, freshRun, project, redact, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

// Restart-based upgrade and rollback in one new profile. No real credentials,
// official profile writes, dependency installation or deletion of old packages.
const hostUpgrade = process.argv.includes('--host-upgrade');
const [oldArgument, newArgument, ...executables] = process.argv.slice(2).filter(value => value !== '--host-upgrade');
if (!oldArgument || !newArgument || !executables.length) throw new Error('Provide old/new tested tarballs and official runtime executables.');
if (hostUpgrade && executables.length !== 2) throw new Error('--host-upgrade requires old and new official host executables.');
const tarballs = [oldArgument, newArgument].map(path => resolve(path));
const receipts = tarballs.map(path => {
  const receipt = JSON.parse(readFileSync(join(dirname(path), 'package-receipt.json'), 'utf8'));
  assert.equal(sha256(path), receipt.sha256);
  return receipt;
});
const run = freshRun('search-log-upgrade');
const root = mkdtempSync(join(tmpdir(), 'dsh-search-log-upgrade-'));
const sourceHashes = [...receipts[1].sourceHashes, ...['scripts/verify-search-log-upgrade.mjs',
  'scripts/internal-candidate-host.mjs', 'fixtures/internal-candidate/host-fixture.mjs']
  .map(file => ({ file, sha256: sha256(join(project, file)) }))];
const inside = path => {
  const resolved = resolve(path), rel = relative(root, resolved);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'operation stays in this new test root');
  return resolved;
};
const upstream = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ results: [{ url: 'https://example.test/upgrade', title: 'Isolated upgrade result' }],
      usage: { credits: 1 } }));
  });
});
await new Promise(done => upstream.listen(0, '127.0.0.1', done));
const results = [];
let owned = null, fatal = null;
async function start(runtime, folder, profile) {
  const child = spawn(runtime.executable, ['--expose-internals', join(project, 'scripts/internal-candidate-host.mjs'),
    runtime.archivePath, folder], { cwd: folder, env: cleanEnvironment(folder, {
      ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(folder, 'dsh-home'), DSH_DESKTOP_NODE_EXECUTABLE: runtime.executable,
    }), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.resume(); child.stderr.resume();
  const pending = new Map(), messages = [];
  let serial = 0, ended = false, code;
  const closed = new Promise(done => child.once('close', value => {
    ended = true; code = value;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Owned runtime closed.')); }
    pending.clear(); done();
  }));
  child.on('error', () => messages.push({ type: 'fatal' }));
  child.on('message', message => {
    if (message.type !== 'reply') { messages.push(message); return; }
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.ok) item.resolve(message.value); else item.reject(new Error('Isolated runtime operation failed.'));
  });
  const host = owned = {
    async request(op) {
      assert.equal(ended, false);
      const id = `upgrade-${++serial}`;
      return new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Owned runtime reply timed out.')); }, 20_000);
        pending.set(id, { resolve: resolveReply, reject, timer });
        child.send({ id, op }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
      });
    },
    async close() {
      if (!ended) {
        await host.request('close');
        let timer;
        try {
          await Promise.race([closed, new Promise((_, reject) => {
            timer = setTimeout(() => { child.kill(); reject(new Error('Owned runtime did not exit normally.')); }, 20_000);
          })]);
        } finally { clearTimeout(timer); }
      }
      assert.equal(code, 0, 'owned runtime exits before replacing its package');
    },
  };
  child.send({ productWiring: true, preserveProductSelection: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (ended || messages.some(message => message.type === 'fatal')) throw new Error('Isolated runtime failed to start.');
    const ready = messages.find(message => message.type === 'ready');
    if (ready) { assert.deepEqual(ready.failed, []); assert.deepEqual(ready.pending, []); return { host, ready }; }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Isolated runtime readiness timed out.');
}
try {
  for (const executable of hostUpgrade ? executables.slice(0, 1) : executables) {
    const runtime = candidateRuntime(executable);
    const nextRuntime = hostUpgrade ? candidateRuntime(executables[1]) : runtime;
    const folder = inside(join(root, runtime.app.version));
    const profile = inside(join(folder, 'dsh-home/profiles/candidate'));
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    const product = inside(join(profile, 'node_modules/dsh-grok-search'));
    const configuration = join(folder, 'isolated-not-configured.toml');
    writeFileSync(configuration, `tavily_api_key = "offline-upgrade-key"\ntavily_api_url = "http://127.0.0.1:${upstream.address().port}"\nsource_providers = ["tavily"]\n`);
    const configHash = sha256(configuration);
    const preferencePath = join(profile, 'grok-search/preferences.json');
    const preferences = createPrivatePreferences({ path: preferencePath });
    const initial = preferences.snapshot();
    preferences.save(initial.revision, { ...initial.value, grokEnabled: false, githubEnabled: false });
    const preferenceHash = sha256(preferencePath);
    const originalFiles = [runtime, nextRuntime].flatMap(row => [sha256(row.executable), sha256(row.archivePath)]);
    const stages = [];
    let revision = 0;
    // Upgrade the plugin on the old supported host before upgrading DSH.
    // Old 0.1.1 never claimed compatibility with the new host; do not bypass its gate.
    const schedule = hostUpgrade ? [0, 1, 1, 1, 0] : [0, 1, 0];
    for (const [index, packageIndex] of schedule.entries()) {
      const stageRuntime = hostUpgrade && index === 2 ? nextRuntime : runtime;
      const receipt = receipts[packageIndex];
      const extraction = inside(join(folder, 'stage-' + index));
      mkdirSync(extraction);
      const extract = await commandResult(process.platform === 'win32' ? 'tar.exe' : 'tar',
        ['-xf', tarballs[packageIndex], '-C', extraction], { timeoutMs: 30_000 });
      assert.equal(extract.exitCode, 0);
      if (index > 0) renameSync(product, inside(join(folder, 'retained-package-' + (index - 1))));
      renameSync(inside(join(extraction, 'package')), product);
      for (const row of receipt.sourceHashes) assert.equal(sha256(join(product, row.file)), row.sha256);
      symlinkSync(join(project, 'node_modules'), join(product, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const manifestPath = join(profile, 'package.json');
      const manifest = index ? JSON.parse(readFileSync(manifestPath, 'utf8'))
        : { name: 'isolated-upgrade-profile', private: true, type: 'module', dependencies: {},
          dsh: { profile: { bundles: ['candidate-offline-fixture', 'dsh-grok-search'] } } };
      manifest.dependencies['dsh-grok-search'] = receipt.version;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { host, ready } = await start(stageRuntime, folder, profile);
      assert.equal(ready.runtimeWeb.searchProviderId, 'grok-search');
      assert.equal(ready.runtimeWeb.fetchProviderId, 'candidate-fetch');
      assert.equal(ready.existingDependencyPresent, true);
      assert.equal(ready.productControl.recordEnvelope.intent.policy, 'required');
      assert.ok(ready.productControl.revision > revision, 'restart revision advances without rewriting history');
      revision = ready.productControl.revision;
      const search = await host.request('direct-search');
      assert.equal(search.ok, true);
      assert.ok(search.result.sources.length);
      const state = await host.request('snapshot');
      assert.equal(state.calls.original, 0);
      await host.close(); owned = null;
      assert.equal(sha256(configuration), configHash);
      assert.equal(sha256(preferencePath), preferenceHash);
      stages.push({ pluginVersion: receipt.version, hostVersion: stageRuntime.app.version,
        revision, searchPassed: true, configurationUnchanged: true, exitCode: 0 });
    }
    assert.deepEqual([runtime, nextRuntime].flatMap(row => [sha256(row.executable), sha256(row.archivePath)]), originalFiles);
    results.push({ version: runtime.app.version, passed: true, stages });
  }
} catch (error) { fatal = { message: redact(error.message) }; }
finally {
  if (owned) try { await owned.close(); } catch { fatal ??= { message: 'Owned runtime cleanup failed.' }; }
  upstream.closeAllConnections();
  await new Promise(done => upstream.close(done));
  const sourceUnchanged = sourceHashes.every(row => sha256(join(project, row.file)) === row.sha256);
  const passed = !fatal && sourceUnchanged;
  writeJson(join(run.directory, 'summary.json'), { runId: run.runId, passed, fatal, sourceUnchanged, sourceHashes,
    packages: receipts.map(row => ({ version: row.version, sha256: row.sha256 })), results,
    scope: hostUpgrade ? 'official-runtime-host-and-plugin-upgrade-and-rollback-in-one-isolated-profile'
      : 'official-runtime-restart-upgrade-and-rollback-in-one-isolated-profile',
    pluginManagerUpgradeTested: false, desktopRendererVerified: false, realPaidProviders: false, published: false });
  console.log(JSON.stringify({ runId: run.runId, passed, fatal, versions: results.map(row => row.version) }));
  process.exitCode = passed ? 0 : 1;
}
