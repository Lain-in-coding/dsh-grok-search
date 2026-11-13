import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createConfigLocationOpener } from '../src/core/config-opener.mjs';

// Execute the production PowerShell decision tree. Only OS discovery, process
// creation and profile lookup are replaced; these tests never open an editor.
async function productionPlan() {
  let plan;
  const opener = createConfigLocationOpener({ platform: 'win32', env: process.env,
    stat: () => ({ isFile: () => true, isDirectory: () => false }),
    spawnImpl(command, args, options) {
      plan = { command, script: args.at(-1), options };
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout.write('DSH_GROK_OPEN_OK'); child.emit('close', 0, null); });
      return child;
    } });
  await opener.open({ path: 'C:\\synthetic\\config.toml', kind: 'file' });
  return plan;
}
const boundary = 'try {\n  Restore-DesktopUserProfile\n';
const discovery = String.raw`
function Get-AppxPackage {
  [CmdletBinding()] param([string]$Name)
  if ($Name -ne 'Microsoft.WindowsNotepad') { throw 'Unexpected package query' }
  [pscustomobject]@{ PackageFamilyName='Microsoft.WindowsNotepad_8wekyb3d8bbwe';
    PackageFullName='synthetic-package'; InstallLocation=$env:DSH_TEST_PACKAGE_ROOT;
    Status='Ok'; IsResourcePackage=$false }
}
function Get-AppxPackageManifest {
  [CmdletBinding()] param([string]$Package)
  [xml]'<Package><Applications><Application Executable="Notepad.exe" /></Applications></Package>'
}
`;
async function executeScenario(plan, setup, body = 'return 0') {
  assert.equal(plan.script.split(boundary).length, 2, 'test injection has one dispatch boundary');
  const source = plan.script.replace(boundary, String.raw`
function Restore-DesktopUserProfile {}
${discovery}
${setup}
$script:attempts = 0
function Start-EditorProcess([string]$executable) {
  $script:attempts++
  [Console]::Error.WriteLine('ATTEMPT:' + $script:attempts)
  ${body}
}
` + boundary);
  const child = spawn(plan.command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', source],
    { ...plan.options, env: { ...plan.options.env, DSH_GROK_OPEN_KIND: 'file', DSH_TEST_PACKAGE_ROOT: plan.packageRoot },
      stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return { ...exit, stdout: stdout.trim(), attempts: (stderr.match(/ATTEMPT:/g) || []).length, stderr };
  } finally { clearTimeout(timer); }
}

test('Windows editor selection executes its real script with isolated OS boundaries', { skip: process.platform !== 'win32' }, async t => {
  const plan = await productionPlan();
  plan.packageRoot = mkdtempSync(join(tmpdir(), 'dsh-editor-registration-'));
  writeFileSync(join(plan.packageRoot, 'Notepad.exe'), 'synthetic registration target; never executed\n', { flag: 'wx' });
  assert.equal(plan.command, join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'));
  const cases = [
    ['registered modern editor is preferred', '', 'return 0', 'modern:none', 1],
    ['normal early exit is a successful existing-instance handoff', '', 'return 0', 'modern:none', 1],
    ['no package uses classic without a failure notice',
      'function Get-AppxPackage { [CmdletBinding()] param([string]$Name) }', 'return 0', 'classic:none', 1],
    ['registration query failure is visible in the fallback status',
      "function Get-AppxPackage { [CmdletBinding()] param([string]$Name) throw 'synthetic query error' }",
      'return 0', 'classic:discovery-failed', 1],
    ['broken manifest uses exactly one fallback',
      "function Get-AppxPackageManifest { [CmdletBinding()] param([string]$Package) throw 'synthetic manifest error' }",
      'return 0', 'classic:discovery-failed', 1],
    ['escaping executable cannot be launched',
      String.raw`function Get-AppxPackageManifest { [CmdletBinding()] param([string]$Package)
        [xml]'<Package><Applications><Application Executable="..\Notepad.exe" /></Applications></Package>' }`,
      'return 0', 'classic:unavailable', 1],
    ['missing executable cannot be launched',
      String.raw`function Get-AppxPackageManifest { [CmdletBinding()] param([string]$Package)
        [xml]'<Package><Applications><Application Executable="missing-editor\Notepad.exe" /></Applications></Package>' }`,
      'return 0', 'classic:unavailable', 1],
    ['failed modern start falls back once', '',
      "if ($script:attempts -eq 1) { throw 'synthetic start failure' }; return 0", 'classic:launch-failed', 2],
    ['crashed modern start falls back once', '',
      'if ($script:attempts -eq 1) { return -1073741819 }; return 0', 'classic:early-exit', 2],
  ];
  for (const [name, setup, body, receipt, attempts] of cases) {
    await t.test(name, async () => {
      const result = await executeScenario(plan, setup, body);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, 'DSH_GROK_OPEN_OK:' + receipt);
      assert.equal(result.attempts, attempts);
    });
  }
  await t.test('failure of both editors never emits a success receipt or third attempt', async () => {
    const result = await executeScenario(plan, '', 'return -1073741819');
    assert.equal(result.code, 1);
    assert.equal(result.stdout, 'DSH_GROK_OPEN_EDITOR_ERROR:-1073741819');
    assert.equal(result.attempts, 2);
  });
});

test('Windows folder decision tree requires the correct visible Explorer window', { skip: process.platform !== 'win32' }, async t => {
  const plan = await productionPlan();
  const systemRoot = mkdtempSync(join(tmpdir(), 'dsh-folder-system-'));
  writeFileSync(join(systemRoot, 'explorer.exe'), 'synthetic registration target; never executed\n', { flag: 'wx' });
  const folder = "C:\\synthetic 空格\\quote' & $value #hash %25,comma";
  const setup = String.raw`
function Restore-DesktopUserProfile {}
$script:starts = 0
$script:polls = 0
function Start-FolderProcess($start) {
  $script:starts++
  [Console]::Error.WriteLine('ATTEMPT:' + $script:starts)
  if ($start.FileName -cne [IO.Path]::Combine($env:DSH_TEST_SYSTEM_ROOT, 'explorer.exe')) { throw 'Wrong executable' }
  $expectedArguments = '"' + $target + '"'
  if ($target.EndsWith('\')) { $expectedArguments = '"' + $target + '."' }
  if ($start.Arguments -cne $expectedArguments) { throw 'Path was changed or unquoted' }
  if (-not $start.UseShellExecute -or $start.WindowStyle -ne 'Normal') { throw 'Wrong launch semantics' }
}
function New-TestWindow([string]$path, [bool]$visible, [string]$executable, [long]$handle) {
  [pscustomobject]@{ FullName=$executable; Visible=$visible; HWND=$handle; LocationURL=([Uri]$path).AbsoluteUri }
}
class TestWindowCollection {
  [object[]]$Rows
  [int]$Count
  TestWindowCollection([object[]]$rows) { $this.Rows=$rows; $this.Count=$rows.Count }
  [object] Item([int]$index) { return $this.Rows[$index] }
}
class TestFolderShell {
  [object] Windows() {
    $script:polls++
    $explorer = [IO.Path]::Combine($env:DSH_TEST_SYSTEM_ROOT, 'explorer.exe')
    $rows = @(New-TestWindow $script:target $false $explorer 1
      New-TestWindow ($script:target + '-other') $true $explorer 2
      New-TestWindow $script:target $true 'C:\untrusted\explorer.exe' 3
      New-TestWindow $script:target $true $explorer 0)
    if (Show-TestTarget) { $rows += New-TestWindow $script:target $true $explorer 5 }
    return [TestWindowCollection]::new($rows)
  }
}
function New-FolderShell {
  return [TestFolderShell]::new()
}
function Start-Sleep([int]$Milliseconds) {
  [Console]::Error.WriteLine('WAIT:begin')
  Microsoft.PowerShell.Utility\Start-Sleep -Milliseconds $Milliseconds
  [Console]::Error.WriteLine('WAIT:end')
}
`;
  const cases = [
    ['hidden, unrelated and non-Explorer windows cannot report success', 'function Show-TestTarget { return $false }',
      'DSH_GROK_OPEN_FOLDER_UNCONFIRMED', 1],
    ['waits for the matching visible window after one launch', 'function Show-TestTarget { return $script:polls -ge 3 }',
      'DSH_GROK_OPEN_FOLDER_VISIBLE', 0],
    ['already visible target is accepted after the open request', 'function Show-TestTarget { return $true }',
      'DSH_GROK_OPEN_FOLDER_VISIBLE', 0],
    ['drive root retains a safe closing quote', 'function Show-TestTarget { return $true }',
      'DSH_GROK_OPEN_FOLDER_VISIBLE', 0, 'C:\\'],
    ['UNC root retains its exact share and a safe closing quote', 'function Show-TestTarget { return $true }',
      'DSH_GROK_OPEN_FOLDER_VISIBLE', 0, '\\\\synthetic-server\\share\\'],
    ['Shell observer failure is explicit, not launch-only success',
      "function New-FolderShell { throw 'synthetic observer failure' }", 'DSH_GROK_OPEN_FOLDER_UNCONFIRMED', 1],
    ['launch failure stops before observing a stale window',
      "function Start-FolderProcess($start) { [Console]::Error.WriteLine('ATTEMPT:1'); throw 'synthetic launch failure' }",
      'DSH_GROK_OPEN_ERROR:0', 1],
  ];
  for (const [name, scenario, receipt, exitCode, target = folder] of cases) {
    await t.test(name, async () => {
      // Replace only the Explorer lookup boundary. Changing SystemRoot itself
      // prevents Windows PowerShell's CLR from resolving its own assemblies.
      const explorerLookup = "[IO.Path]::Combine($env:SystemRoot, 'explorer.exe')";
      assert.equal(plan.script.split(explorerLookup).length, 2);
      // ProcessInfo construction is an OS boundary, just like the mocked
      // Start-FolderProcess. Avoid New-Object reflection/module discovery in
      // a hosted Windows Server runspace; still assert all launch properties.
      assert.equal(plan.script.split('$start = New-Object System.Diagnostics.ProcessStartInfo').length, 2);
      const script = plan.script.replace(explorerLookup,
        "[IO.Path]::Combine($env:DSH_TEST_SYSTEM_ROOT, 'explorer.exe')")
        .replace('$start = New-Object System.Diagnostics.ProcessStartInfo',
          '$start = [System.Diagnostics.ProcessStartInfo]::new()')
        .replace(boundary, setup + '\n' + scenario + '\n' + boundary);
      // Long test injections use -File so Windows argument quoting cannot
      // change the script. The production command itself remains unchanged.
      const scriptPath = join(systemRoot, `scenario-${cases.findIndex(row => row[0] === name)}.ps1`);
      writeFileSync(scriptPath, '\uFEFF' + script);
      const child = spawn(plan.command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', scriptPath],
        { ...plan.options, env: { ...plan.options.env, DSH_TEST_SYSTEM_ROOT: systemRoot,
          DSH_GROK_OPEN_KIND: 'folder', DSH_GROK_OPEN_TARGET: target },
          stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15_000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject); child.once('close', resolve);
        });
        assert.equal(timedOut, false, `PowerShell fixture timeout; stdout=${stdout}; stderr=${stderr}`);
        assert.equal(stdout.trim(), receipt, stderr);
        assert.equal(code, exitCode);
        assert.equal((stderr.match(/ATTEMPT:/g) || []).length, 1);
      } finally { clearTimeout(timer); }
    });
  }
});
