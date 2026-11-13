import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareDesktopFixture } from './deferred-release-desktop-prepare.mjs';
import { connectRenderer, requestDesktopShutdown, waitForRenderer } from './lib/renderer-cdp.mjs';
import { cleanEnvironment, commandResult, freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';
import { desktopWorkspacePatch, prepareDesktopAcceptanceEnvironment } from './lib/desktop-acceptance-environment.mjs';

// Unlike the historical desktop suite, this starts without the fixture bundle,
// replacement providers, pre-created preferences, control records or shared keys.
const liveInstall = process.argv.includes('--live-install');
const openConfig = process.argv.includes('--open-config');
const hiddenFolder = process.argv.includes('--hidden-folder');
assert.ok(!hiddenFolder || openConfig, '--hidden-folder requires --open-config');
const input = process.argv.slice(2).filter(value => !['--live-install', '--open-config', '--hidden-folder'].includes(value));
const upgradeIndex = input.indexOf('--upgrade-from');
if (upgradeIndex >= 0) assert.ok(input[upgradeIndex + 1] && !input[upgradeIndex + 1].startsWith('--'), '--upgrade-from requires an old tarball');
const upgradeFrom = upgradeIndex < 0 ? null : resolve(input.splice(upgradeIndex, 2)[1]);
assert.equal(input.length, 2, 'Usage: [--live-install | --upgrade-from <old tgz>] [--open-config] <tgz> <official Desktop executable>');
const [tarball, executable] = input.map(value => resolve(value));
assert.ok(tarball && executable, 'Usage: <tgz> <official Desktop executable>');
assert.equal(liveInstall && Boolean(upgradeFrom), false, 'Choose fresh installation or upgrade, not both');
const packageReceipt = JSON.parse(readFileSync(join(dirname(tarball), 'package-receipt.json'), 'utf8'));
assert.equal(sha256(tarball), packageReceipt.sha256, 'test the frozen candidate');
for (const row of packageReceipt.sourceHashes) assert.equal(sha256(join(project, row.file)), row.sha256);
const run = freshRun('rc5-user-path');
const root = join(tmpdir(), 'dsh-deferred-desktop-user-path-' + run.runId + (openConfig ? " 中文 空格 ' & $" : ''));
prepareDesktopFixture(executable, root, { pluginManagerEntries: true, liveHmr: true });
const control = JSON.parse(readFileSync(join(root, 'local-control.json'), 'utf8'));
const extraction = join(root, 'extracted-product');
mkdirSync(extraction);
const unpack = await commandResult('tar.exe', ['-xf', upgradeFrom || tarball, '-C', extraction], { timeoutMs: 30_000 });
assert.equal(unpack.exitCode, 0);
const product = join(control.profile, 'node_modules/dsh-grok-search');
const manifest = JSON.parse(readFileSync(join(extraction, 'package/package.json'), 'utf8'));
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
const child = spawn(control.electron, [control.archive, '--user-data-dir=' + control.userData,
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
let renderer;
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
    const installation = await rpc('installBundle', {
      spec: tarball, options: { enabled: true, requestId: randomUUID(), registry: 'https://registry.npmjs.org/' },
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
  const result = {
    root, port, version: JSON.parse(readFileSync(join(product, 'package.json'), 'utf8')).version,
    packageSha256: packageReceipt.sha256, fixtureBundle: false, snapshot, ui,
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
  result.passed = true;
  writeJson(join(run.directory, 'summary.json'), result);
} finally {
  renderer?.close();
  await requestDesktopShutdown(port, closed, { timeoutMs: 20_000 });
  writeJson(join(run.directory, 'exit.json'), await closed);
  quotaServer.closeAllConnections();
  await new Promise(done => quotaServer.close(done));
}
