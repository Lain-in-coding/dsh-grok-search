import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { parseRuntimeReceiptArguments, readDesktopGateRuntimes, prepareDesktopFixture } from './deferred-release-desktop-prepare.mjs';
import { connectRenderer, requestDesktopShutdown, waitForRenderer } from './lib/renderer-cdp.mjs';
import { cleanEnvironment, commandResult, freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';
import { desktopWorkspacePatch, prepareDesktopAcceptanceEnvironment } from './lib/desktop-acceptance-environment.mjs';
import { readUpgradePackage } from './verify-search-log-upgrade.mjs';
import { inspectPackage } from './lib/compatibility-smoke.mjs';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';

export function assertReplayReady(control, ui) {
  assert.equal(control?.available, true, 'cold replay must restore the live control service');
  assert.equal(control.phase, 'required', 'cold replay must acquire search');
  assert.equal(control.policy, 'required');
  assert.equal(control.error, null, 'cold replay must not retain a control error');
  assert.ok(ui?.text && ui.note, 'cold replay must render the control and log status');
  assert.equal(ui.controlUnavailable, false, 'cold replay UI must clear CONTROL_SETTINGS_UNAVAILABLE');
  assert.equal(ui.componentError, false, 'cold replay UI must not report a component error');
}

export function verifyUserPathIdentities({ tarball, packageReceipt, product, sourceRoot, hostHashes,
  baselineReplay = false, registryInstall = false }) {
  assert.equal(sha256(tarball), packageReceipt.sha256, 'the frozen tarball must remain unchanged');
  let sourceFilesVerified = 0;
  for (const row of packageReceipt.sourceHashes) {
    assert.equal(sha256(join(product, row.file)), row.sha256, `installed file changed: ${row.file}`);
    if (baselineReplay || registryInstall && row.file === 'README.md') continue;
    assert.equal(sha256(join(sourceRoot, row.file)), row.sha256, `source file changed: ${row.file}`);
    sourceFilesVerified++;
  }
  for (const row of hostHashes) assert.equal(sha256(row.path), row.sha256, `official host changed: ${row.role}`);
  return { packageSha256: packageReceipt.sha256, installedFilesVerified: packageReceipt.sourceHashes.length,
    sourceFilesVerified, baselineSourceComparisonSkipped: baselineReplay,
    registryReadmeComparisonSkipped: registryInstall,
    hostHashes: hostHashes.map(({ role, sha256 }) => ({ role, sha256 })) };
}

export function assertBareRegistryIdentity(resolved, installed, metadata, expectedName) {
  assert.ok(['applied', 'restart-required'].includes(resolved?.application));
  assert.equal(resolved.error ?? null, null);
  assert.match(resolved.version, /^\d+\.\d+\.\d+$/);
  assert.equal(installed.name, expectedName);
  assert.equal(metadata.name, expectedName);
  assert.equal(installed.version, resolved.version);
  assert.equal(metadata.version, resolved.version);
}

// Unlike the historical desktop suite, this starts without the fixture bundle,
// replacement providers, pre-created preferences, control records or shared keys.
const { args: inputArguments, runtimeOptions } = parseRuntimeReceiptArguments(process.argv.slice(2));
const liveInstall = inputArguments.includes('--live-install');
const registryInstall = inputArguments.includes('--registry-install');
const reinstall = inputArguments.includes('--reinstall');
const baselineReplay = inputArguments.includes('--baseline-replay');
const openConfig = inputArguments.includes('--open-config');
const hiddenFolder = inputArguments.includes('--hidden-folder');
assert.ok(!hiddenFolder || openConfig, '--hidden-folder requires --open-config');
assert.ok(!registryInstall || liveInstall, '--registry-install requires --live-install');
assert.ok(!reinstall || liveInstall, '--reinstall requires --live-install');
const input = inputArguments.filter(value => !['--live-install', '--registry-install', '--reinstall', '--baseline-replay', '--open-config', '--hidden-folder'].includes(value));
const historyIndex = input.indexOf('--replay-control-history');
if (historyIndex >= 0) assert.ok(input[historyIndex + 1] && !input[historyIndex + 1].startsWith('--'), 'Replay requires a control-history directory');
const replayHistory = historyIndex < 0 ? null : resolve(input.splice(historyIndex, 2)[1]);
assert.ok(!replayHistory || !liveInstall, 'Replay is a cold boot of the verified installed archive');
assert.ok(!baselineReplay || replayHistory, 'A historical baseline is valid only for isolated history reproduction');
const upgradeIndex = input.indexOf('--upgrade-from');
if (upgradeIndex >= 0) assert.ok(input[upgradeIndex + 1] && !input[upgradeIndex + 1].startsWith('--'), '--upgrade-from requires an old tarball');
const upgradeFrom = upgradeIndex < 0 ? null : resolve(input.splice(upgradeIndex, 2)[1]);
assert.ok(!replayHistory || !upgradeFrom, '--replay-control-history cannot be combined with --upgrade-from');
assert.equal(input.length, 2, 'Usage: [--live-install [--registry-install] [--reinstall] | --upgrade-from <old tgz> | --replay-control-history <directory> [--baseline-replay]] [--open-config] [--runtime-receipt <json> --runtime-receipt-sha256 <hash>] <tgz> <official Desktop executable>');
const [tarball, executable] = input.map(value => resolve(value));
assert.ok(tarball && executable, 'Usage: <tgz> <official Desktop executable>');
assert.equal(liveInstall && Boolean(upgradeFrom), false, 'Choose fresh installation or upgrade, not both');
const [runtime] = readDesktopGateRuntimes([executable], runtimeOptions);
const packageReceipt = JSON.parse(readFileSync(join(dirname(tarball), 'package-receipt.json'), 'utf8'));
assert.equal(sha256(tarball), packageReceipt.sha256, 'test the frozen candidate');
const repositoryReadmeDiffers = packageReceipt.sourceHashes.some(row =>
  row.file === 'README.md' && sha256(join(project, row.file)) !== row.sha256);
for (const row of packageReceipt.sourceHashes) {
  // Post-publication installation guidance may change without replacing the
  // published package. Still reject any runtime-file drift in registry mode.
  if (baselineReplay || registryInstall && row.file === 'README.md') continue;
  assert.equal(sha256(join(project, row.file)), row.sha256);
}
if (baselineReplay) {
  const verified = readUpgradePackage(tarball);
  assert.equal(verified.receipt.sha256, packageReceipt.sha256);
  assert.notEqual(verified.manifest.version, JSON.parse(readFileSync(join(project, 'package.json'))).version,
    'The baseline must be a distinct older package, not the current candidate');
}
const upgradePackage = upgradeFrom ? readUpgradePackage(upgradeFrom) : null;
if (upgradePackage) assert.notEqual(upgradePackage.manifest.version, packageReceipt.version, 'Upgrade needs distinct verified package versions.');
const run = freshRun('rc5-user-path');
const hostHashes = Object.entries({ executable: runtime.executable, archive: runtime.archivePath, fuseBinary: runtime.fuseBinary })
  .map(([role, path]) => ({ role, path, sha256: runtime.candidateReceipt?.files[role]?.sha256 ?? sha256(path) }));
if (runtimeOptions.runtimeReceiptPath) hostHashes.push({ role: 'runtime-receipt', path: runtimeOptions.runtimeReceiptPath,
  sha256: runtimeOptions.runtimeReceiptSha256 });
// The owned scratch already has a unique parent; keep native executable paths short.
const root = join(tmpdir(), 'dsh-deferred-desktop-' + randomUUID().replaceAll('-', '').slice(0, 6) + (openConfig ? " 中文 空格 ' & $" : ''));
prepareDesktopFixture(runtime.executable, root, { pluginManagerEntries: true, liveHmr: true, ...runtimeOptions });
const control = JSON.parse(readFileSync(join(root, 'local-control.json'), 'utf8'));
const extraction = join(root, 'extracted-product');
mkdirSync(extraction);
const unpack = await commandResult('tar.exe', ['-xf', upgradeFrom || tarball, '-C', extraction], { timeoutMs: 30_000 });
assert.equal(unpack.exitCode, 0);
const product = join(control.profile, 'node_modules/dsh-grok-search');
const verifyIdentities = () => verifyUserPathIdentities({ tarball, packageReceipt, product, sourceRoot: project,
  hostHashes, baselineReplay, registryInstall });
const manifest = JSON.parse(readFileSync(join(extraction, 'package/package.json'), 'utf8'));
if (upgradePackage) for (const row of upgradePackage.receipt.sourceHashes) {
  assert.equal(sha256(join(extraction, 'package', row.file)), row.sha256, 'The old installation must match its verified receipt.');
}
if (!liveInstall) {
  renameSync(join(extraction, 'package'), product);
  mkdirSync(join(product, 'node_modules'));
  for (const name of readdirSync(join(project, 'node_modules'))) {
    if (name.startsWith('.') || name === '@deepseek-ai') continue;
    symlinkSync(join(project, 'node_modules', name), join(product, 'node_modules', name), 'junction');
  }
}
writeFileSync(join(control.profile, 'package.json'), JSON.stringify({
  name: 'isolated-user-path', private: true, type: 'module',
  dependencies: liveInstall ? {} : { 'dsh-grok-search': upgradeFrom
    ? 'file:' + upgradeFrom.replaceAll('\\', '/') : manifest.version },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
    ...(!liveInstall ? ['dsh-grok-search'] : [])] } },
}));
writeFileSync(join(control.profile, 'cordis.patch.yml'), JSON.stringify([desktopWorkspacePatch(root)], null, 2) + '\n');
let replayEvidence = null;
if (replayHistory) {
  assert.equal(basename(replayHistory), 'control-intent.records');
  const target = join(control.profile, 'control-intent.records'), identities = [];
  let totalBytes = 0;
  const copyHistory = (source, destination, prefix = '') => {
    const stat = lstatSync(source);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'control history must contain ordinary directories');
    mkdirSync(destination);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'control history replay never follows links');
      const from = join(source, entry.name), to = join(destination, entry.name), file = prefix + entry.name;
      if (entry.isDirectory()) { copyHistory(from, to, file + '/'); continue; }
      // Unpublished stages and locks are not committed history and never copied.
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('stage-')) continue;
      const bytes = readFileSync(from);
      totalBytes += bytes.length;
      assert.ok(bytes.length <= 1024 * 1024 && totalBytes <= 32 * 1024 * 1024 && identities.length < 2000);
      JSON.parse(bytes);
      writeFileSync(to, bytes, { flag: 'wx' });
      identities.push({ file, sha256: sha256(from) });
      assert.equal(sha256(to), identities.at(-1).sha256);
    }
  };
  copyHistory(replayHistory, target);
  for (const row of identities) assert.equal(sha256(join(replayHistory, row.file)), row.sha256, 'history changed during capture');
  const before = createControlIntentStore({ directory: target, trustedRoot: control.profile,
    governance: true, autoMaintain: false }).read();
  assert.equal(before?.intent.policy, 'released');
  assert.equal(before.intent.releaseCompletion, undefined, 'cold replay starts with an incomplete release');
  replayEvidence = { files: identities.length, bytes: totalBytes, identitySha256: createHash('sha256')
    .update(JSON.stringify(identities)).digest('hex'), revision: before.revision,
    releaseOperationId: before.intent.release.operationId, completionBeforeBoot: false };
  writeJson(join(run.directory, 'control-history-replay.json'), replayEvidence);
}
const reservation = createServer();
await new Promise(done => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
const quotaRequests = [];
const quotaServer = createHttpServer((request, response) => {
  quotaRequests.push(request.url);
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ account: { plan_usage: 2, plan_limit: 10 } }));
});
await new Promise(done => quotaServer.listen(0, '127.0.0.1', done));
// Native first installation must exercise the signed packaged entry, not default_app.
const packaged = (liveInstall || replayHistory) && process.platform === 'win32';
const launchExecutable = packaged ? runtime.executable : control.electron;
function launchDesktop() {
  const child = spawn(launchExecutable, [...(packaged ? [] : [control.archive]), '--user-data-dir=' + control.userData,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--lang=zh-CN'], {
    cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: prepareDesktopAcceptanceEnvironment(root, {
      DSH_HOME: control.dshHome, DSH_DESKTOP_DSH_DIR: control.runtime,
      DSH_DESKTOP_PRIMARY_RUNTIME_DIR: control.primaryRuntime, DSH_DESKTOP_PNPM_ENTRY: control.pnpmEntry,
      DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_PRODUCT_ANALYTICS_OTLP_URL: 'http://127.0.0.1:9',
      ...(openConfig ? { GROK_SEARCH_CONFIG: join(root, 'user/.config/grok-search-rs', `config-open-${run.runId}.toml`) } : {}),
    }).env,
  });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise(done => child.once('close', (code, signal) => done({ code, signal })));
  return { child, closed };
}
let { child, closed } = launchDesktop();
let renderer;
let registryResolution;
let result;
let failure;
let baselineReproduced = false;
let finalIdentity = null;
try {
  renderer = await connectRenderer(port, { timeoutMs: 90_000, requestTimeoutMs: 200_000 });
  await waitForRenderer(renderer, client => client.evaluate('document.readyState === "complete" && !!document.querySelector(\'button[aria-label="插件"]\')'));
  const rpc = async (method, request, manager = false) => renderer.evaluate(`(async () => {
    const method=${JSON.stringify((manager ? 'pluginManager/' : 'grokSearchSettings/') + method)};
    const r=await fetch('/api/'+method,{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},signal:AbortSignal.timeout(180_000),
      body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,
        payload:{args:${JSON.stringify(request === undefined ? {} : manager ? request : { request })}}})});
    const text=await r.text();let body=null;try{body=JSON.parse(text)}catch{}
    return {http:r.status,body};
  })()`);
  const workspace = await renderer.evaluate(`(async () => {
    const method='workspace/initializeDefault';
    const response=await fetch('/api/'+method,{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},signal:AbortSignal.timeout(20_000),
      body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{}}})});
    const body=await response.json();
    return {http:response.status,ok:body.result?.ok,value:body.result?.value,error:body.result?.error};
  })()`);
  assert.equal(workspace.ok, true, 'native default-workspace initialization succeeds');
  if (workspace.value?.workspace) {
    assert.equal(resolve(workspace.value.workspace.path),
      resolve(root, 'user', 'Documents', 'deepseek-harness', 'default-workspace'),
      'native default workspace stays in the isolated Documents directory');
  }
  assert.ok(existsSync(join(root, 'user', 'Documents', 'deepseek-harness', 'default-workspace')),
    'the official Host created its isolated default workspace');
  writeJson(join(run.directory, 'workspace-initialization.json'), workspace);
  if (liveInstall || upgradeFrom) {
    if (upgradeFrom) await waitForRenderer(renderer, async () => (await rpc('snapshot')).body?.result?.ok, { timeoutMs: 45_000 });
    if (registryInstall) {
      // Exercise the installed host's own registry preview and resolver. A fresh
      // release can preview as latest while pnpm's age policy selects an older
      // version. Never weaken that policy or change any user profile.
      const registry = 'https://registry.npmjs.org/';
      const dependencyNames = Object.keys(JSON.parse(readFileSync(join(control.profile, 'package.json'), 'utf8'))
        .dependencies ?? {}).sort();
      const profileState = () => {
        const files = Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']
          .map(file => [file, existsSync(join(control.profile, file)) ? sha256(join(control.profile, file)) : null]));
        const modules = {};
        const visit = relativePath => {
          const path = join(control.profile, relativePath);
          const entry = lstatSync(path, { throwIfNoEntry: false });
          if (!entry) { modules[relativePath] = null; return; }
          if (entry.isSymbolicLink()) { modules[relativePath] = { link: readlinkSync(path) }; return; }
          if (entry.isFile()) { modules[relativePath] = { sha256: sha256(path) }; return; }
          assert.ok(entry.isDirectory(), 'the isolated dependency tree contains only files, directories and links');
          modules[relativePath] = { directory: true };
          for (const name of readdirSync(path).sort()) visit(join(relativePath, name));
        };
        // Rollback restores the declared dependency graph, not pnpm's generated
        // metadata or unused fixture files that pnpm moves into .ignored.
        for (const name of dependencyNames) visit(join('node_modules', name));
        return { files, modules };
      };
      const before = profileState();
      const inspection = await rpc('inspect', { spec: manifest.name, options: { registry } }, true);
      assert.equal(inspection.body?.result?.ok, true, 'native registry inspection succeeds');
      assert.equal(inspection.body.result.value.version, manifest.version, 'registry preview identifies the candidate');
      const bare = await rpc('installBundle', {
        spec: manifest.name, options: { enabled: false, requestId: randomUUID(), registry },
      }, true);
      registryResolution = { inspection, bare };
      writeJson(join(run.directory, 'registry-resolution.json'), registryResolution);
      const value = bare.body?.result?.value;
      assert.equal(bare.body?.result?.ok, true, 'native bare-name installation returns structured diagnostics');
      if (value?.application === 'failed') {
        assert.equal(value.error?.code, 'incompatible-version', 'bare-name failure must identify the actual incompatible package');
        const after = profileState();
        writeJson(join(run.directory, 'registry-rollback.json'), { dependencyNames, before, after });
        assert.deepEqual(after, before,
          'rejected old version restores the manifest, lockfile, host patch and declared dependency paths');
        assert.equal(existsSync(join(product, 'package.json')), false,
          'rejected old version cannot remain installed');
      } else {
        // The host's publication-age policy may legitimately select an older compatible release.
        assert.match(value?.version ?? '', /^\d+\.\d+\.\d+$/);
        const response = await fetch(`${registry}${manifest.name}/${value.version}`, { signal: AbortSignal.timeout(30_000) });
        assert.equal(response.status, 200, 'the resolved bare-name version is actually published');
        const metadata = await response.json();
        const installed = JSON.parse(readFileSync(join(product, 'package.json'), 'utf8'));
        assertBareRegistryIdentity(value, installed, metadata, manifest.name);
        assert.equal(new URL(metadata.dist.tarball).origin, 'https://registry.npmjs.org');
        const download = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(60_000) });
        assert.equal(download.status, 200);
        const bytes = Buffer.from(await download.arrayBuffer());
        assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), metadata.dist.integrity);
        const packed = inspectPackage(bytes);
        assert.equal(packed.manifest.version, value.version);
        for (const [file, content] of packed.files) {
          assert.ok(readFileSync(join(product, file)).equals(content), 'resolved registry package matches installed bytes: ' + file);
        }
        registryResolution.bareResolvedIdentity = { name: manifest.name, version: value.version,
          sha256: createHash('sha256').update(bytes).digest('hex'), integrity: metadata.dist.integrity,
          installedFilesVerified: packed.files.size, differsFromLatest: value.version !== manifest.version };
        writeJson(join(run.directory, 'bare-registry-identity.json'), registryResolution.bareResolvedIdentity);
        const removed = await rpc('removeBundle', { name: manifest.name }, true);
        assert.equal(removed.body?.result?.ok, true, 'remove only this test-created package before exact-version verification');
        assert.notEqual(removed.body.result.value.application, 'failed');
      }
    }
    const installation = await rpc('installBundle', {
      spec: registryInstall ? `${manifest.name}@${manifest.version}` : tarball,
      options: { enabled: true, requestId: randomUUID(), registry: 'https://registry.npmjs.org/' },
    }, true);
    writeJson(join(run.directory, 'installation.json'), installation);
    console.log(JSON.stringify({ installation: installation.body?.result?.value
      ? { http: installation.http, stage: installation.body.result.value.stage,
        application: installation.body.result.value.application, version: installation.body.result.value.version,
        error: installation.body.result.value.error } : installation }));
    assert.equal(installation.body?.result?.ok, true, 'native installation RPC succeeds');
    assert.equal(installation.body.result.value.error ?? null, null, 'native installer reports no error');
    assert.equal(installation.body.result.value.application, 'applied', 'new code is applied without restart');
    assert.equal(installation.body.result.value.version, packageReceipt.version, 'native installer selects the candidate version');
  }
  if (baselineReplay) {
    await waitForRenderer(renderer, async () => (await rpc('snapshot')).body?.result?.ok);
    await renderer.evaluate('document.querySelector(\'button[aria-label="插件"]\').click()');
    await waitForRenderer(renderer, client => client.evaluate('!!document.querySelector(\'button[aria-label="查看 dsh-grok-search"]\')'));
    await renderer.evaluate('document.querySelector(\'button[aria-label="查看 dsh-grok-search"]\').click()');
    const baseline = await waitForRenderer(renderer, async () => {
      const response = await rpc('snapshot'), current = response.body?.result?.value;
      const ui = await renderer.evaluate(`(() => {
        const root=document.querySelector('[data-dsg-route]')?.shadowRoot;
        return { status:root?.querySelector('#statusText')?.textContent??null,
          controlUnavailable:root?.textContent?.includes('CONTROL_SETTINGS_UNAVAILABLE')===true };
      })()`);
      return current?.control?.error?.code === 'CONTROL_SETTINGS_UNAVAILABLE' && ui.controlUnavailable
        ? { control: current.control, program: current.program?.phase ?? null, ui } : null;
    }, { timeoutMs: 15_000 });
    const identity = verifyIdentities();
    const capture = await renderer.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(run.directory, 'baseline-replay.png'), Buffer.from(capture.data, 'base64'), { flag: 'wx' });
    writeJson(join(run.directory, 'baseline-reproduction.json'), {
      baselineVersion: packageReceipt.version, packageSha256: packageReceipt.sha256,
      installedFilesVerified: packageReceipt.sourceHashes.length, identity, input: replayEvidence, baseline,
      reproduced: true, repaired: false,
    });
    baselineReproduced = true;
    throw new Error('KNOWN_BASELINE_FAILURE_REPRODUCED: CONTROL_SETTINGS_UNAVAILABLE');
  }
  const snapshot = await waitForRenderer(renderer, async () => {
    const response = await rpc('snapshot');
    return response.body?.result?.ok && ['ready', 'error'].includes(response.body.result.value.program?.phase) ? response : null;
  }, { timeoutMs: 90_000 });
  const sessionId = randomUUID();
  await renderer.evaluate('document.querySelector(\'button[aria-label="插件"]\').click()');
  await waitForRenderer(renderer, client => client.evaluate('!!document.querySelector(\'button[aria-label="查看 dsh-grok-search"]\')'));
  await renderer.evaluate('document.querySelector(\'button[aria-label="查看 dsh-grok-search"]\').click()');
  const ui = await waitForRenderer(renderer, client => client.evaluate(`(() => {
    const r=document.querySelector('[data-dsg-route]')?.shadowRoot;
    const note=r?.querySelector('#logNote')?.textContent;
    const text=r?.querySelector('#statusText')?.textContent;
    return note && !note.includes('载入') && text && text!=='读取配置…'
      ? {note, text, componentError: /共\\s*1\\s*个[·\\s]*1\\s*异常/.test(document.body.innerText)} : null;
  })()`), { timeoutMs: 30_000 });
  let compatibility = null;
  if (existsSync(join(product, 'src/core/runtime-compat.mjs'))) {
    compatibility = await waitForRenderer(renderer, client => client.evaluate(`(async () => {
      const method='grokSearchCompatibility/compatibilityReport';
      const response=await fetch('/api/'+method,{method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10_000),
        body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{}}})});
      const body=await response.json(), report=body.result?.ok ? body.result.value : null;
      return report?.coreReady && report.optionalFeatures?.settings?.available ? report : null;
    })()`), { timeoutMs: 30_000 });
    assert.equal(compatibility.confirmationRequired, false, 'healthy services do not require compatibility consent');
    assert.equal(compatibility.phase, 'ready', 'healthy first-use services do not report an optional compatibility fault');
    const bannerHidden = await renderer.evaluate(`(() => {
      const root=document.querySelector('[data-dsg-route]')?.shadowRoot;
      return ![...(root?.querySelectorAll('.compatibility-banner') ?? [])].some(element=>!element.hidden);
    })()`);
    assert.equal(bannerHidden, true, 'the healthy first-use UI hides compatibility warnings');
  }
  result = {
    root, port, version: JSON.parse(readFileSync(join(product, 'package.json'), 'utf8')).version,
    ...(registryResolution ? { registryResolution, repositoryReadmeDiffers } : {}),
    packageSha256: packageReceipt.sha256, fixtureBundle: false, snapshot, ui, compatibility,
    startupMode: packaged ? 'official-signed-packaged-windows-desktop' : 'existing-isolated-desktop-entry',
    packagedStartupVerified: packaged,
    ...(upgradePackage ? { upgradeFrom: { version: upgradePackage.manifest.version, sha256: upgradePackage.receipt.sha256 } } : {}),
    log: await rpc('readSearchLog', { sessionId }),
    route: await rpc('toolCallRoute', { sessionId, callId: 'unknown' }),
    draftQuota: await rpc('previewAccountQuota', {
      provider: 'tavily', expectedRevision: snapshot.body.result.value.config.revision,
      quotaRevision: snapshot.body.result.value.config.quotaRevision, operationId: randomUUID(),
      draft: { baseUrl: `http://127.0.0.1:${quotaServer.address().port}`, apiKey: 'synthetic-unsaved-key' },
    }),
  };
  assert.equal(result.version, packageReceipt.version, 'the installed package is the frozen candidate');
  for (const row of packageReceipt.sourceHashes) assert.equal(sha256(join(product, row.file)), row.sha256, row.file);
  result.installedFilesVerified = packageReceipt.sourceHashes.length;
  console.log(JSON.stringify({ evidence: run.directory, root, snapshot: snapshot.body.result.value.control, ui,
    log: result.log, route: result.route }));
  assert.equal(result.log.body.result?.ok, true, 'secure first-use log RPC');
  assert.equal(result.route.body.result?.ok, true, 'first-use route RPC');
  assert.equal(ui.componentError, false, 'fresh component does not report an exception');
  assert.equal(snapshot.body.result.value.program.phase, 'ready', 'automatic program preparation completes');
  if (result.draftQuota) {
    assert.equal(result.draftQuota.body.result?.ok, true, 'SRC-compatible draft quota RPC');
    assert.equal((await rpc('snapshot')).body.result.value.config.revision, snapshot.body.result.value.config.revision);
    assert.deepEqual(quotaRequests, ['/usage']);
  }
  if (reinstall) {
    const ledger = createControlIntentStore({
      directory: join(control.profile, 'control-intent.records'), trustedRoot: control.profile,
      governance: true, autoMaintain: false,
    });
    const lifecycle = { packageSha256: packageReceipt.sha256, stages: [] };
    const observe = async stage => {
      let latest = null;
      try {
        latest = await waitForRenderer(renderer, async () => {
          const response = await rpc('snapshot');
          if (!response.body?.result?.ok) return null;
          latest = response.body.result.value;
          return latest.control?.available && latest.control.phase === 'required' ? latest : null;
        }, { timeoutMs: 15_000 });
      } catch (error) {
        if (!latest) throw error;
      }
      const record = ledger.read();
      const observation = {
        stage, control: latest.control, program: latest.program?.phase ?? null,
        intent: record?.intent ?? null, revision: record?.revision ?? 0,
        profilePatchSha256: sha256(join(control.profile, 'cordis.patch.yml')),
        selectedBundles: JSON.parse(readFileSync(join(control.profile, 'package.json'), 'utf8')).dsh.profile.bundles,
      };
      observation.identity = verifyIdentities();
      observation.installedFilesVerified = packageReceipt.sourceHashes.length;
      lifecycle.stages.push(observation);
      writeJson(join(run.directory, `reinstall-${stage}.json`), observation);
      console.log(JSON.stringify({ reinstallStage: stage, control: observation.control, program: observation.program,
        policy: observation.intent?.policy, reason: observation.intent?.reason,
        releaseReason: observation.intent?.release?.reason, completion: Boolean(observation.intent?.releaseCompletion),
        recovery: observation.intent?.recovery?.action, revision: observation.revision }));
      return observation;
    };
    await observe('before-remove');
    const removed = await rpc('removeBundle', { name: manifest.name }, true);
    writeJson(join(run.directory, 'reinstall-removal.json'), removed);
    assert.equal(removed.body?.result?.ok, true, 'remove the enabled test-created bundle');
    assert.notEqual(removed.body.result.value.application, 'failed');
    writeJson(join(run.directory, 'reinstall-removed-record.json'), ledger.read());
    const installed = await rpc('installBundle', {
      spec: tarball, options: { enabled: false, requestId: randomUUID(), registry: 'https://registry.npmjs.org/' },
    }, true);
    writeJson(join(run.directory, 'reinstall-installation.json'), installed);
    assert.equal(installed.body?.result?.ok, true, 'reinstall the exact same tarball without clearing the profile');
    assert.equal(installed.body.result.value.error ?? null, null);
    const enabled = await rpc('setBundleEnabled', { name: manifest.name, enabled: true }, true);
    writeJson(join(run.directory, 'reinstall-enabling.json'), enabled);
    assert.equal(enabled.body?.result?.ok, true, 'enable through the native manager, as the UI does');
    const warm = await observe('warm');
    await rpc('retryControlRelease');
    await observe('after-retry');
    renderer.close();
    renderer = null;
    await requestDesktopShutdown(port, closed, { timeoutMs: 20_000 });
    const exit = await closed;
    writeJson(join(run.directory, 'reinstall-first-exit.json'), exit);
    assert.equal(exit.code, 0, 'normally exit the owned host before cold restart');
    ({ child, closed } = launchDesktop());
    renderer = await connectRenderer(port, { timeoutMs: 90_000, requestTimeoutMs: 200_000 });
    await waitForRenderer(renderer, client => client.evaluate('document.readyState === "complete" && !!document.querySelector(\'button[aria-label="插件"]\')'));
    const cold = await observe('cold');
    result.reinstall = lifecycle;
    writeJson(join(run.directory, 'reinstall-lifecycle.json'), lifecycle);
    for (const observation of [warm, cold]) {
      assert.equal(observation.control.available, true, `${observation.stage}: reinstall must restore the control service`);
      assert.equal(observation.control.phase, 'required', `${observation.stage}: the enabled reinstallation must acquire search`);
    }
  }
  if (openConfig) {
    // This creates only a brand-new, non-secret test file in this owned profile.
    const path = snapshot.body.result.value.config.path;
    const local = relative(root, path);
    assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'the test config stays in the new isolated root');
    mkdirSync(dirname(path), { recursive: true });
    const observeFolder = async (stage, requireVisible = true) => {
      const observation = await commandResult(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:DSH_OPEN_TEST_FOLDER).TrimEnd('\')
$shell = New-Object -ComObject Shell.Application
function Read-TargetWindows {
  @($shell.Windows() | ForEach-Object {
    try {
      if ([string]$_.FullName -ieq [IO.Path]::Combine($env:SystemRoot, 'explorer.exe') -and
          ([string]$_.LocationURL).StartsWith('file:', [StringComparison]::OrdinalIgnoreCase) -and
          [IO.Path]::GetFullPath([Uri]::new([string]$_.LocationURL).LocalPath).TrimEnd('\') -ieq $target) {
        @{ visible=[bool]$_.Visible; handle=[long]$_.HWND }
      }
    } catch { # A closing tab is not a passing observation.
    }
  })
}
$first = @(Read-TargetWindows)
Start-Sleep -Milliseconds 1000
$last = @(Read-TargetWindows)
ConvertTo-Json -InputObject @{first=$first;last=$last} -Depth 4 -Compress
`], { cwd: root, env: { ...cleanEnvironment(root), DSH_OPEN_TEST_FOLDER: dirname(path) }, timeoutMs: 12_000 });
      assert.equal(observation.exitCode, 0, 'folder observation runs');
      const windows = JSON.parse(observation.rawStdout);
      writeJson(join(run.directory, `folder-${stage}.json`), windows);
      if (requireVisible) {
        assert.ok(windows.first.some(window => window.visible && window.handle), 'target folder is visible, not merely acknowledged');
        assert.ok(windows.last.some(window => window.visible && window.handle), 'target folder remains visible');
      }
      return windows;
    };
    if (hiddenFolder) {
      // This root was just created and bounds-checked above. Seed a real hidden
      // window only for this synthetic folder; never hide/reuse a user's window.
      const fixture = await commandResult(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:DSH_OPEN_TEST_FOLDER
$start.UseShellExecute = $true
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($start)
if ($null -ne $process) { $process.Dispose() }
Start-Sleep -Seconds 2
`], { cwd: root, env: { ...process.env, DSH_OPEN_TEST_FOLDER: dirname(path) }, timeoutMs: 12_000 });
      assert.equal(fixture.exitCode, 0);
      result.hiddenFolderFixture = await observeFolder('hidden-fixture', false);
      assert.ok(result.hiddenFolderFixture.last.length > 0);
      assert.ok(result.hiddenFolderFixture.last.every(window => !window.visible), 'regression fixture must truly start hidden');
    }
    result.folderBeforeSave = await rpc('openConfigLocationWithStatus', { kind: 'folder' });
    assert.equal(result.folderBeforeSave.body.result?.ok, true);
    assert.equal(result.folderBeforeSave.body.result.value.opened, true);
    assert.equal(result.folderBeforeSave.body.result.value.exists, false);
    result.folderBeforeSaveWindows = await observeFolder('before-save');
    assert.equal(existsSync(path), false, 'opening the parent must not create a configuration');
    writeFileSync(path, '# Configuration opening regression; no real credentials.\n', { flag: 'wx' });
    const original = sha256(path), openingStartedAt = new Date().toISOString();
    result.openFile = await rpc('openConfigLocationWithStatus', { kind: 'file' });
    result.openFolder = await rpc('openConfigLocation', { kind: 'folder' });
    for (const entry of [result.openFile, result.openFolder]) {
      assert.equal(entry.body.result?.ok, true, 'native configuration opener RPC succeeds');
      assert.equal(entry.body.result.value.opened, true, 'system opener acknowledges the target');
      assert.equal(entry.body.result.value.path, path, 'opener retains the actual configuration path');
    }
    result.folderRepeatedWindows = await observeFolder('repeated');
    // Opening an editor backgrounds the renderer; an externally created file is
    // picked up when the settings page becomes visible again, as for a user.
    await renderer.send('Page.bringToFront');
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await renderer.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
    await waitForRenderer(renderer, client => client.evaluate(`(() => {
      const button=document.querySelector('[data-dsg-route]')?.shadowRoot?.querySelector('[data-open="file"]');
      return button && !button.disabled;
    })()`), { timeoutMs: 15_000 });
    await renderer.evaluate(`(() => {
      const original=window.fetch;
      window.__configOpenReplies=[];
      window.__restoreConfigOpenFetch=()=>{window.fetch=original;};
      window.fetch=async function(...args) {
        const response=await original.apply(this,args);
        if(String(args[0]).includes('openConfigLocation')) {
          window.__configOpenReplies.push({status:response.status,reply:await response.clone().json()});
        }
        return response;
      };
      document.querySelector('[data-dsg-route]').shadowRoot.querySelector('[data-open="file"]').click();
    })()`);
    try {
      await waitForRenderer(renderer, client => client.evaluate(`(() => {
        const button=document.querySelector('[data-dsg-route]')?.shadowRoot?.querySelector('[data-open="file"]');
        return button && !button.disabled && !button.hasAttribute('aria-busy');
      })()`), { timeoutMs: 20_000 });
      await renderer.send('Page.bringToFront');
      await renderer.evaluate(`document.querySelector('[data-dsg-route]').shadowRoot.querySelector('[data-open="folder"]').click()`);
      await waitForRenderer(renderer, client => client.evaluate(`(() => {
        const button=document.querySelector('[data-dsg-route]')?.shadowRoot?.querySelector('[data-open="folder"]');
        return button && !button.disabled && !button.hasAttribute('aria-busy') && window.__configOpenReplies.length >= 2;
      })()`), { timeoutMs: 20_000 });
      result.folderUiWindows = await observeFolder('ui');
    } catch (error) {
      writeJson(join(run.directory, 'open-ui-failure.json'), await renderer.evaluate(`(() => {
        const root=document.querySelector('[data-dsg-route]')?.shadowRoot;
        const layer=document.querySelector('[data-dsg-layer]')?.shadowRoot;
        return {button:root?.querySelector('[data-open="file"]')?.outerHTML,
          replies:window.__configOpenReplies,errors:layer?.querySelector('.toast')?.textContent,
          status:root?.querySelector('#statusText')?.textContent};
      })()`));
      throw error;
    } finally {
      await renderer.evaluate(`window.__restoreConfigOpenFetch?.()`);
    }
    const failed = await renderer.evaluate(`document.querySelector('[data-dsg-layer]')?.shadowRoot?.querySelector('.toast[data-tone="err"]')?.textContent || ''`);
    assert.equal(failed, '', 'the real button does not report an opener failure');
    // A launcher receipt alone missed a real Notepad APPCRASH. Require the
    // synthetic file's editor window to survive and audit process crash events.
    const observation = await commandResult(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:DSH_OPEN_TEST_NAME
function Get-TargetWindows {
  @(Get-Process -Name notepad -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.Contains($target) } |
    ForEach-Object { [int]$_.Id })
}
$first = @(Get-TargetWindows)
Start-Sleep -Seconds 8
$last = @(Get-TargetWindows)
$from = [DateTime]::Parse($env:DSH_OPEN_TEST_STARTED).ToLocalTime()
$crashes = @(Get-WinEvent -FilterHashtable @{ LogName='Application'; StartTime=$from; Id=1000 } -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -match '(?i)notepad\.exe' } | ForEach-Object { $_.TimeCreated.ToString('o') })
$identities = @(Get-Process -Name notepad -ErrorAction SilentlyContinue |
  Where-Object { $last -contains $_.Id } |
  ForEach-Object { @{ pid=$_.Id; modern=$_.Path -match '\\Microsoft\.WindowsNotepad_[^\\]+\\' } })
ConvertTo-Json -InputObject @{ first=$first; last=$last; crashEvents=$crashes; identities=$identities } -Compress -Depth 4
`], { cwd: root, env: { ...cleanEnvironment(root), DSH_OPEN_TEST_NAME: basename(path), DSH_OPEN_TEST_STARTED: openingStartedAt },
        timeoutMs: 20_000 });
    assert.equal(observation.exitCode, 0, 'editor survival observation runs');
    assert.equal(observation.timedOut, false);
    result.editorSurvival = JSON.parse(observation.rawStdout);
    writeJson(join(run.directory, 'editor-survival.json'), result.editorSurvival);
    assert.ok(result.editorSurvival.first.length > 0, 'the synthetic file has an actual editor window');
    assert.ok(result.editorSurvival.last.some(pid => result.editorSurvival.first.includes(pid)), 'editor remains visible after eight seconds');
    assert.deepEqual(result.editorSurvival.crashEvents, [], 'opening produced no Notepad APPCRASH');
    if (result.openFile.body.result.value.editor === 'modern') {
      assert.ok(result.editorSurvival.identities.some(editor => editor.modern), 'modern selection uses the registered modern editor');
    }
    assert.equal(sha256(path), original, 'opening never modifies configuration bytes');
    result.realConfigOpenValidated = true;
    result.realFolderVisibilityValidated = true;
    result.configOpenUsesSyntheticFile = true;
  }
  if (replayEvidence) {
    const replayState = await waitForRenderer(renderer, async client => {
      const response = await rpc('snapshot');
      if (!response.body?.result?.ok) return null;
      const ui = await client.evaluate(`(() => {
        const root=document.querySelector('[data-dsg-route]')?.shadowRoot;
        return { text:root?.querySelector('#statusText')?.textContent??null,
          note:root?.querySelector('#logNote')?.textContent??null,
          controlUnavailable:root?.textContent?.includes('CONTROL_SETTINGS_UNAVAILABLE')===true,
          componentError:/共\\s*1\\s*个[·\\s]*1\\s*异常/.test(document.body.innerText) };
      })()`);
      const control = response.body.result.value.control;
      assertReplayReady(control, ui);
      return { control, ui };
    }, { timeoutMs: 30_000 });
    const after = createControlIntentStore({ directory: join(control.profile, 'control-intent.records'),
      trustedRoot: control.profile, governance: true, autoMaintain: false }).read();
    assert.equal(after.intent.policy, 'required', 'cold replay must acquire a fresh enabled owner');
    assert.ok(after.revision > replayEvidence.revision);
    assert.equal(after.intent.priorIntent?.release?.operationId, replayEvidence.releaseOperationId);
    result.controlHistoryReplay = { ...replayEvidence, revisionAfterBoot: after.revision,
      priorReleaseCompleted: Boolean(after.intent.priorIntent.releaseCompletion), ...replayState };
  }
} catch (error) {
  failure = error;
  throw error;
} finally {
  renderer?.close();
  try {
    try { await requestDesktopShutdown(port, closed, { timeoutMs: 20_000 }); }
    catch (error) {
      let exit = null, forced = false, cleanupError = null;
      const wait = async timeoutMs => {
        let timer;
        try {
          return await Promise.race([closed,
            new Promise(done => { timer = setTimeout(() => done(null), timeoutMs); })]);
        } finally { clearTimeout(timer); }
      };
      const terminate = signal => {
        // Never signal an exited lifetime whose PID could now belong to another process.
        if (!Number.isSafeInteger(child.pid) || child.pid < 1 || child.exitCode !== null || child.signalCode !== null) return;
        forced = true;
        try { child.kill(signal); }
        catch (cause) { cleanupError ??= String(cause?.message ?? cause).slice(0, 500); }
      };
      try {
        terminate('SIGTERM');
        exit = await wait(3000);
        if (!exit) { terminate('SIGKILL'); exit = await wait(5000); }
        if (!exit) {
          cleanupError ??= 'The owned Desktop did not close within the cleanup deadline.';
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
        }
        writeJson(join(run.directory, 'exit.json'), {
          ...(exit ?? { code: child.exitCode ?? null, signal: child.signalCode ?? null }),
          forced, cleanupVerified: exit !== null, cleanupError,
          shutdownError: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1000) },
        });
      } finally { throw error; }
    }
    const exit = await closed;
    writeJson(join(run.directory, 'exit.json'), exit);
    assert.equal(exit.code, 0, 'the owned Desktop exits successfully');
    assert.equal(exit.signal, null, 'the owned Desktop is not terminated by a signal');
  } catch (error) {
    if (failure === undefined) throw error;
  } finally {
    quotaServer.closeAllConnections();
    await new Promise(done => quotaServer.close(done));
    if (failure === undefined || baselineReproduced) {
      try {
        finalIdentity = verifyIdentities();
        writeJson(join(run.directory, 'final-identity.json'), { passed: true, ...finalIdentity });
      } catch (error) {
        writeJson(join(run.directory, 'final-identity.json'), { passed: false, error: error.message });
        throw error;
      }
    }
  }
}
result.finalIdentity = finalIdentity;
result.passed = true;
writeJson(join(run.directory, 'summary.json'), result);
