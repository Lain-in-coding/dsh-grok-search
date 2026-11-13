import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';
import { cleanEnvironment, commandResult, freshRun, project, redact, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

export function readUpgradePackage(value) {
  const path = resolve(value), data = readFileSync(path);
  const receipt = JSON.parse(readFileSync(join(dirname(path), 'package-receipt.json'), 'utf8'));
  assert.equal(sha256(path), receipt.sha256, 'Package tarball must match its receipt.');
  if (receipt.integrity) assert.equal('sha512-' + createHash('sha512').update(data).digest('base64'),
    receipt.integrity, 'Package integrity must match its receipt.');
  assert.ok(Array.isArray(receipt.sourceHashes) && receipt.sourceHashes.length, 'Package receipt needs source hashes.');
  const bytes = gunzipSync(data, { maxOutputLength: 64 * 1024 * 1024 });
  const archiveFiles = new Map();
  const relativeFile = file => typeof file === 'string' && file.length > 0 && !/[\\:]/.test(file)
    && file.split('/').every(part => part && part !== '.' && part !== '..');
  let manifest;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const prefix = bytes.toString('utf8', offset + 345, offset + 500).replace(/\0.*$/, '');
    const leaf = bytes.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    if (!leaf) break;
    const name = prefix ? prefix + '/' + leaf : leaf;
    const size = Number.parseInt(bytes.toString('ascii', offset + 124, offset + 136).replace(/\0/g, '').trim(), 8) || 0;
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length, 'Invalid package tar entry.');
    const type = bytes[offset + 156];
    assert.ok(type === 0 || type === 48 || type === 53, 'Package archive must contain ordinary files and directories only.');
    const file = name.slice('package/'.length).replace(type === 53 ? /\/$/ : /$^/, '');
    assert.ok(name.startsWith('package/') && (type === 53 && !file || relativeFile(file)), 'Unsafe package archive path.');
    if (type !== 53) {
      assert.equal(archiveFiles.has(file), false, 'Package archive contains duplicate files.');
      archiveFiles.set(file, createHash('sha256').update(bytes.subarray(offset + 512, offset + 512 + size)).digest('hex'));
    }
    if (name === 'package/package.json') {
      assert.equal(manifest, undefined, 'Package has duplicate manifests.');
      manifest = JSON.parse(bytes.toString('utf8', offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(manifest?.name, 'dsh-grok-search', 'Package must contain the product manifest.');
  assert.equal(manifest.version, receipt.version, 'Archive version must match the package receipt version.');
  const claimed = new Set();
  for (const row of receipt.sourceHashes) {
    assert.ok(relativeFile(row.file) && !claimed.has(row.file), 'Invalid or duplicate receipt source path.');
    claimed.add(row.file);
    assert.equal(archiveFiles.get(row.file), row.sha256, 'Package receipt source hash differs from archive: ' + row.file);
  }
  assert.equal(claimed.size, archiveFiles.size, 'Package receipt must cover every archive file.');
  if (receipt.files) assert.deepEqual(receipt.files.map(row => row.path).sort(), [...archiveFiles.keys()].sort(),
    'Package receipt file list differs from archive.');
  return { path, data, receipt, manifest };
}

export function searchLogUpgradeStages({ hostUpgrade = false, forwardHostUpgrade = false, checkpointDowngrade = false, runtimes }) {
  assert.ok(!(forwardHostUpgrade && (hostUpgrade || checkpointDowngrade)),
    'Forward host upgrade and downgrade/rollback are separate verification modes.');
  if (forwardHostUpgrade) {
    assert.deepEqual(runtimes.map(runtime => runtime.app.version), ['0.2.2-rc.1', '0.2.2-rc.2'],
      'Forward host upgrade requires rc.1 followed by rc.2.');
    return [{ packageIndex: 0, runtimeIndex: 0 }, { packageIndex: 1, runtimeIndex: 0 },
      { packageIndex: 1, runtimeIndex: 1 }];
  }
  return (hostUpgrade ? [0, 1, 1, 1, 0] : [0, 1, 0])
    .map((packageIndex, index) => ({ packageIndex, runtimeIndex: hostUpgrade && index === 2 ? 1 : 0 }));
}

export function retainUpgradeCache(source, target) {
  const noLinks = file => {
    let current = resolve(source);
    const parts = relative(current, resolve(file)).split(/[\\/]/).filter(Boolean);
    for (const part of [null, ...parts]) {
      if (part !== null) current = join(current, part);
      assert.equal(lstatSync(current).isSymbolicLink(), false, 'Retained cache paths must not contain links.');
    }
  };
  noLinks(join(source, 'active.json'));
  const record = JSON.parse(readFileSync(join(source, 'active.json'), 'utf8'));
  assert.equal(record.mcpHandshakeValidated, true, 'Use an existing handshake-verified test cache.');
  assert.equal(typeof record.executable, 'string');
  const executable = resolve(source, record.executable), rel = relative(resolve(source), executable);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Retained executable must stay inside the source cache.');
  noLinks(executable);
  assert.equal(sha256(executable), record.sha256, 'Retained cache binary differs from its receipt.');
  const receipt = JSON.parse(readFileSync(join(dirname(executable), 'receipt.json'), 'utf8'));
  assert.equal(receipt.version, record.version);
  assert.equal(receipt.sha256, record.sha256);
  const files = ['active.json', rel, join(dirname(rel), 'receipt.json')].map(file => {
    const from = join(source, file), to = join(target, file);
    noLinks(from);
    return { file, from, to, sha256: sha256(from) };
  });
  for (const row of files) {
    mkdirSync(dirname(row.to), { recursive: true });
    copyFileSync(row.from, row.to, constants.COPYFILE_EXCL);
  }
  return files;
}

export async function closeUpgradeHost({ request, closed, ended, kill, exitCode }, timeoutMs = 20_000) {
  let timer;
  const wait = task => Promise.race([task, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Owned runtime did not exit normally.')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
  try {
    await wait((async () => { if (!ended()) await request('close'); await closed; })());
  } catch (error) {
    if (!ended()) { kill(); await wait(closed); }
    throw error;
  }
  assert.equal(exitCode(), 0, 'owned runtime exits before replacing its package');
}

export async function readRetainedSession(host, retained) {
  assert.ok(Number.isSafeInteger(retained.cursor) && retained.cursor >= 0, 'The old Session needs an exact history cursor.');
  const page = await host.rpc('session/page', { address: { kind: 'session', sessionId: retained.sessionId },
    throughSeq: retained.cursor, maxMessages: 100 });
  assert.equal(page.cursor, retained.cursor, 'The history reader must honor the original cut.');
  assert.deepEqual(page.records, retained.records, 'A cold read must retain the old Session history.');
  assert.equal(page.hasMore, false);
  return page;
}

// Each mode owns one new profile and retains every replaced package.
async function main() {
const hostUpgrade = process.argv.includes('--host-upgrade');
const forwardHostUpgrade = process.argv.includes('--forward-host-upgrade');
const checkpointDowngrade = process.argv.includes('--checkpoint-downgrade');
const arguments_ = process.argv.slice(2);
const cacheIndex = arguments_.indexOf('--retained-cache');
const retainedCache = cacheIndex < 0 ? null : arguments_[cacheIndex + 1];
if (cacheIndex >= 0) {
  assert.ok(retainedCache && !retainedCache.startsWith('--'), '--retained-cache requires an existing test cache directory.');
  arguments_.splice(cacheIndex, 2);
}
if (forwardHostUpgrade) assert.ok(retainedCache, 'Forward host upgrade requires --retained-cache from a previous isolated download test.');
const [oldArgument, newArgument, ...executables] = arguments_
  .filter(value => !['--host-upgrade', '--forward-host-upgrade', '--checkpoint-downgrade'].includes(value));
if (!oldArgument || !newArgument || !executables.length) throw new Error('Provide old/new tested tarballs and official runtime executables.');
if ((hostUpgrade || forwardHostUpgrade) && executables.length !== 2) throw new Error('Host upgrade requires old and new official host executables.');
if (hostUpgrade && checkpointDowngrade) throw new Error('Verify checkpoint downgrade on each supported host independently.');
const tarballs = [oldArgument, newArgument].map(path => resolve(path));
const receipts = tarballs.map(path => readUpgradePackage(path).receipt);
assert.notEqual(receipts[0].version, receipts[1].version, 'Upgrade needs distinct package versions.');
const runtimes = executables.map(candidateRuntime);
const schedule = searchLogUpgradeStages({ hostUpgrade, forwardHostUpgrade, checkpointDowngrade, runtimes });
if (checkpointDowngrade) assert.equal(receipts[0].version, '0.2.1', 'use the actual prior public version');
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
    async request(op, args = {}) {
      assert.equal(ended, false);
      const id = `upgrade-${++serial}`;
      return new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Owned runtime reply timed out.')); }, 20_000);
        pending.set(id, { resolve: resolveReply, reject, timer });
        child.send({ id, op, args }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
      });
    },
    async close() {
      await closeUpgradeHost({ request: host.request, closed, ended: () => ended, kill: () => child.kill(), exitCode: () => code });
    },
  };
  child.send({ productWiring: true, preserveProductSelection: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (ended || messages.some(message => message.type === 'fatal')) throw new Error('Isolated runtime failed to start.');
    const ready = messages.find(message => message.type === 'ready');
    const listening = messages.find(message => message.type === 'listening');
    if (ready && (!forwardHostUpgrade || listening)) {
      assert.deepEqual(ready.failed, []); assert.deepEqual(ready.pending, []);
      if (!forwardHostUpgrade) return { host, ready };
      const authenticated = await fetch(listening.authUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      assert.equal(authenticated.status, 303);
      const cookie = authenticated.headers.get('set-cookie')?.split(';', 1)[0];
      assert.ok(cookie, 'Isolated host must authenticate the Session history reader.');
      host.rpc = async (method, request) => {
        const response = await fetch(listening.origin + '/api/' + method, { method: 'POST',
          headers: { 'content-type': 'application/json', origin: listening.origin, cookie },
          body: JSON.stringify({ type: 'client-request', rpcId: `upgrade-rpc-${++serial}`, method, payload: { args: { request } } }),
          signal: AbortSignal.timeout(30_000) });
        const result = (await response.json()).result;
        assert.equal(result?.ok, true, JSON.stringify(result?.error));
        return result.value;
      };
      return { host, ready };
    }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Isolated runtime readiness timed out.');
}
try {
  for (const runtime of hostUpgrade || forwardHostUpgrade ? runtimes.slice(0, 1) : runtimes) {
    const stageRuntimes = hostUpgrade || forwardHostUpgrade ? runtimes : [runtime];
    const folder = inside(join(root, runtime.app.version));
    const profile = inside(join(folder, 'dsh-home/profiles/candidate'));
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    const cacheFiles = retainedCache ? retainUpgradeCache(resolve(retainedCache), inside(join(profile, 'grok-search/runtime-cache'))) : [];
    const product = inside(join(profile, 'node_modules/dsh-grok-search'));
    const configuration = join(folder, 'isolated-not-configured.toml');
    writeFileSync(configuration, `tavily_api_key = "offline-upgrade-key"\ntavily_api_url = "http://127.0.0.1:${upstream.address().port}"\nsource_providers = ["tavily"]\n`);
    const configHash = sha256(configuration);
    const preferencePath = join(profile, 'grok-search/preferences.json');
    const preferences = createPrivatePreferences({ path: preferencePath });
    const initial = preferences.snapshot();
    preferences.save(initial.revision, { ...initial.value, grokEnabled: false, githubEnabled: false });
    const preferenceHash = sha256(preferencePath);
    const originalFiles = stageRuntimes.flatMap(row => [sha256(row.executable), sha256(row.archivePath)]);
    const stages = [];
    let revision = 0;
    let downgrade = null;
    let retainedSession = null;
    for (const [index, { packageIndex, runtimeIndex }] of schedule.entries()) {
      const stageRuntime = stageRuntimes[runtimeIndex];
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
      if (forwardHostUpgrade && index === 0) {
        const created = await host.rpc('session/create', { cwd: join(folder, 'workspace') });
        assert.ok(created.sessionId);
        await host.rpc('session/prompt', { sessionId: created.sessionId, requestId: 'upgrade-history-seed',
          mode: 'queue', content: [{ type: 'text', text: 'chat' }] });
        const deadline = Date.now() + 30_000;
        let completed = false;
        while (Date.now() < deadline) {
          const current = await host.request('snapshot');
          if (current.sessionEvents.some(event => event.sessionId === created.sessionId
            && event.type === 'turn/end' && event.data?.reason?.kind === 'completed')) { completed = true; break; }
          await new Promise(done => setTimeout(done, 50));
        }
        assert.equal(completed, true, 'The old host must persist a completed Session.');
        const page = await host.rpc('session/page', { address: { kind: 'session', sessionId: created.sessionId }, maxMessages: 100 });
        assert.ok(page.records.length);
        assert.equal(page.hasMore, false);
        retainedSession = { sessionId: created.sessionId, cursor: page.cursor, records: page.records };
      } else if (forwardHostUpgrade) {
        await readRetainedSession(host, retainedSession);
      }
      await host.close(); owned = null;
      const stageRevision = revision;
      if (checkpointDowngrade && index === 1) {
        // Exercise the shipped converter only after the owned host has exited.
        // Synthetic revisions make the checkpoint layout unavoidable; they are
        // explicitly not additional searches or user configuration changes.
        const { createControlIntentStore } = await import(pathToFileURL(join(product, 'src/core/control-intent-store.mjs')));
        const directory = inside(join(profile, 'control-intent.records'));
        const store = createControlIntentStore({ directory,
          legacyPath: join(profile, 'control-intent.fixture.json') });
        let current = store.read();
        const initialRevision = current.revision;
        for (let offset = 0; offset < 120; offset++) {
          current = store.compareAndSwap({ expectedRevision: current.revision, intent: current.intent });
        }
        store.maintain({ expectedRevision: current.revision });
        assert.equal(existsSync(join(directory, 'checkpoint.json')), true);
        const { createControlIntentStore: createOldStore } = await import(pathToFileURL(
          inside(join(folder, 'retained-package-0/src/core/control-intent-store.mjs'))));
        assert.throws(() => createOldStore({ directory }).read(), { code: 'CONTROL_RECORD_INVALID' });
        const runConverter = async (mode, extra = []) => {
          const converted = await commandResult(process.execPath,
            [join(product, 'src/core/storage-maintenance.mjs'), '--mode', mode, '--profile', profile, ...extra],
            { cwd: product, env: cleanEnvironment(folder), timeoutMs: 30_000, sanitize: redact });
          assert.equal(converted.exitCode, 0, `shipped ${mode} exits successfully: ${converted.stderr}`);
          assert.equal(converted.timedOut, false);
          return JSON.parse(converted.rawStdout);
        };
        const inspection = await runConverter('inspect');
        assert.equal(inspection.revision, current.revision);
        const offlineArguments = ['--expected-revision', String(inspection.revision), '--offline', 'true'];
        const prepared = await runConverter('prepare-downgrade', offlineArguments);
        const converted = await runConverter('activate-downgrade',
          [...offlineArguments, '--prepared-directory', prepared.targetDirectory]);
        assert.equal(converted.status, 'downgraded');
        assert.equal(converted.configurationChanged, false);
        assert.equal(existsSync(join(directory, 'checkpoint.json')), false);
        assert.equal(existsSync(join(inside(converted.retainedDirectory), 'checkpoint.json')), true);
        const compatible = createOldStore({ directory }).read();
        assert.deepEqual(compatible.intent, current.intent);
        assert.equal(compatible.operationId, current.operationId);
        // Converted revisions have explicit new numbering; do not compare them
        // to the source sequence as if the historical numbering were unchanged.
        revision = compatible.revision;
        downgrade = { directOldReadRejected: true, convertedWithShippedCli: true,
          syntheticRevisions: current.revision - initialRevision, sourceRevision: current.revision,
          compatibleRevision: compatible.revision, oldReaderPassed: true, intentUnchanged: true,
          operationIdUnchanged: true, sourceLayoutRetained: true, configurationChanged: false };
      }
      assert.equal(sha256(configuration), configHash);
      assert.equal(sha256(preferencePath), preferenceHash);
      for (const row of cacheFiles) {
        assert.equal(sha256(row.from), row.sha256, 'The source test cache must remain unchanged.');
        assert.equal(sha256(row.to), row.sha256, 'The profile cache must survive every upgrade stage.');
      }
      stages.push({ pluginVersion: receipt.version, hostVersion: stageRuntime.app.version,
        revision: stageRevision, searchPassed: true, configurationUnchanged: true, preferencesUnchanged: true,
        retainedCacheFiles: cacheFiles.length, programCacheUnchanged: cacheFiles.length ? true : null,
        ...(retainedSession ? { oldSessionHistoryReadable: true, oldSessionRecords: retainedSession.records.length } : {}),
        exitCode: 0 });
    }
    assert.deepEqual(stageRuntimes.flatMap(row => [sha256(row.executable), sha256(row.archivePath)]), originalFiles);
    if (checkpointDowngrade) assert.ok(downgrade, 'checkpoint conversion was actually exercised');
    results.push({ version: runtime.app.version, passed: true, stages, ...(downgrade ? { downgrade } : {}) });
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
    scope: checkpointDowngrade ? 'official-runtime-upgrade-checkpoint-conversion-and-021-downgrade-in-one-isolated-profile'
      : forwardHostUpgrade ? 'official-runtime-forward-rc1-plugin-upgrade-then-rc2-without-host-downgrade'
      : hostUpgrade ? 'official-runtime-host-and-plugin-upgrade-and-rollback-in-one-isolated-profile'
      : 'official-runtime-restart-upgrade-and-rollback-in-one-isolated-profile',
    forwardHostUpgrade, hostDowngradeTested: hostUpgrade,
    programCacheReuseValidated: false,
    pluginManagerUpgradeTested: false, desktopRendererVerified: false, realPaidProviders: false, published: false });
  console.log(JSON.stringify({ runId: run.runId, passed, fatal, versions: results.map(row => row.version) }));
  process.exitCode = passed ? 0 : 1;
}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
