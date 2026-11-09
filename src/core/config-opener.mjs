import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { GrokSearchError } from './errors.mjs';

const OPEN_TIMEOUT_MS = 10_000;
const MAX_RECEIPT_BYTES = 1024;
const TEXT_EXTENSIONS = new Set(['', '.toml', '.conf', '.cfg', '.ini', '.txt', '.json', '.yaml', '.yml']);
const OS_ENV = /^(?:SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATHEXT|PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|PROGRAMDATA|ALLUSERSPROFILE|PUBLIC|USERNAME|USERDOMAIN|USERDOMAIN_ROAMINGPROFILE|LOGONSERVER|LANG|LANGUAGE|LC_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_[A-Z_]+)$/i;
const error = (code, message, details) => new GrokSearchError(code, message, details);

// Fixed source, never interpolated with a path or credential. Open configuration
// as text, not through .toml associations: Windows can launch OpenWith and still
// report ShellExecute success. Observe only the editor's early exit; never wait
// for its document lifetime or kill it.
const WINDOWS_OPEN = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = [Environment]::GetEnvironmentVariable('DSH_GROK_OPEN_TARGET')
$kind = [Environment]::GetEnvironmentVariable('DSH_GROK_OPEN_KIND')
function Restore-DesktopUserProfile {
  # The target is already absolute. Its isolated location must not become the
  # editor's Windows profile: legacy Notepad crashes with a redirected USERPROFILE.
  # Resolve the OS-known profile only in this short-lived helper, never in DSH.
  $profilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if (-not [IO.Path]::IsPathRooted($profilePath) -or -not [IO.Directory]::Exists($profilePath)) {
    [Console]::Out.Write('DSH_GROK_OPEN_PROFILE_ERROR')
    exit 1
  }
  $env:USERPROFILE = $profilePath
}
function Find-ModernNotepad {
  try {
    $packages = @(Get-AppxPackage -Name Microsoft.WindowsNotepad -ErrorAction Stop |
      Where-Object { $_.PackageFamilyName -eq 'Microsoft.WindowsNotepad_8wekyb3d8bbwe' -and -not $_.IsResourcePackage })
    if ($packages.Count -eq 0) { return @{ path = $null; reason = 'none' } }
    if ($packages.Count -ne 1 -or $packages[0].Status -ne 'Ok') {
      return @{ path = $null; reason = 'unavailable' }
    }
    $package = $packages[0]
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop
    $applications = @($manifest.Package.Applications.Application | Where-Object {
      [IO.Path]::GetFileName([string]$_.Executable) -ieq 'Notepad.exe'
    })
    if ($applications.Count -ne 1 -or -not [IO.Path]::IsPathRooted($package.InstallLocation) -or
        [IO.Path]::IsPathRooted([string]$applications[0].Executable)) {
      return @{ path = $null; reason = 'unavailable' }
    }
    $location = [IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\') + '\'
    $executable = [IO.Path]::GetFullPath([IO.Path]::Combine($location, [string]$applications[0].Executable))
    if (-not $executable.StartsWith($location, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.File]::Exists($executable)) {
      return @{ path = $null; reason = 'unavailable' }
    }
    return @{ path = $executable; reason = 'none' }
  } catch {
    # Registration lookup can be unavailable on older Windows. Keep one bounded
    # built-in fallback; never acquire or register an app on the user's behalf.
    return @{ path = $null; reason = 'discovery-failed' }
  }
}
function Start-EditorProcess([string]$executable) {
  $textStart = New-Object System.Diagnostics.ProcessStartInfo
  $textStart.FileName = $executable
  $textStart.Arguments = '"' + $target + '"'
  $textStart.UseShellExecute = $true
  $textStart.ErrorDialog = $false
  $editor = [System.Diagnostics.Process]::Start($textStart)
  if ($null -ne $editor) {
    try {
      if ($editor.WaitForExit(1000)) { return $editor.ExitCode }
    } finally { $editor.Dispose() }
  }
  # A running editor or a successful handoff to an existing instance is valid.
  return 0
}
function Start-TextEditor {
  $modern = Find-ModernNotepad
  $reason = $modern.reason
  if ($modern.path) {
    try {
      $code = Start-EditorProcess $modern.path
      if ($code -eq 0) {
        [Console]::Out.Write('DSH_GROK_OPEN_OK:modern:none')
        return
      }
      $reason = 'early-exit'
    } catch { $reason = 'launch-failed' }
  }
  $classic = [IO.Path]::Combine($env:SystemRoot, 'System32', 'notepad.exe')
  $code = Start-EditorProcess $classic
  if ($code -ne 0) {
    [Console]::Out.Write('DSH_GROK_OPEN_EDITOR_ERROR:' + $code)
    exit 1
  }
  [Console]::Out.Write('DSH_GROK_OPEN_OK:classic:' + $reason)
}
function Release-ShellReference($value) {
  if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($value)
  }
}
function New-FolderShell {
  return New-Object -ComObject Shell.Application
}
function Test-VisibleFolder($shell, [string]$directory, [string]$explorer) {
  $windows = $null
  try {
    $windows = $shell.Windows()
    for ($index = 0; $index -lt $windows.Count; $index++) {
      $window = $null
      try {
        $window = $windows.Item($index)
        if (-not $window.Visible -or [long]$window.HWND -eq 0 -or
            -not [string]::Equals([string]$window.FullName, $explorer, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $location = $null
        if (-not [Uri]::TryCreate([string]$window.LocationURL, [UriKind]::Absolute, [ref]$location) -or
            -not $location.IsFile) { continue }
        $actual = [IO.Path]::GetFullPath($location.LocalPath).TrimEnd('\')
        if ([string]::Equals($actual, $directory, [StringComparison]::OrdinalIgnoreCase)) { return $true }
      } catch {
        # A Shell item can disappear while the user closes/navigates a tab.
        # It is never evidence that our target opened; retry until the deadline.
      } finally { Release-ShellReference $window }
    }
    return $false
  } finally { Release-ShellReference $windows }
}
function Start-FolderProcess($start) {
  $process = [System.Diagnostics.Process]::Start($start)
  if ($null -ne $process) { $process.Dispose() }
}
function Open-ConfigurationFolder {
  $explorer = [IO.Path]::Combine($env:SystemRoot, 'explorer.exe')
  if (-not [IO.File]::Exists($explorer)) {
    [Console]::Out.Write('DSH_GROK_OPEN_ERROR:2')
    exit 1
  }
  $directory = [IO.Path]::GetFullPath($target).TrimEnd('\')
  # Launch the executable directly instead of dispatching the folder association:
  # its DelegateExecute handler can acknowledge an existing invisible window.
  # A trailing slash must not escape the closing quote (drive/UNC roots).
  $argumentPath = $target
  if ($argumentPath.EndsWith('\')) { $argumentPath += '.' }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $explorer
  $start.Arguments = '"' + $argumentPath + '"'
  $start.UseShellExecute = $true
  $start.ErrorDialog = $false
  $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
  Start-FolderProcess $start
  $shell = $null
  try {
    $shell = New-FolderShell
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
      if (Test-VisibleFolder $shell $directory $explorer) {
        [Console]::Out.Write('DSH_GROK_OPEN_FOLDER_VISIBLE')
        return
      }
      Start-Sleep -Milliseconds 120
    } while ($deadline.ElapsedMilliseconds -lt 6500)
  } catch {
    # A missing/hung Shell observer must not become an unverified success.
  } finally { Release-ShellReference $shell }
  [Console]::Out.Write('DSH_GROK_OPEN_FOLDER_UNCONFIRMED')
  exit 1
}
try {
  Restore-DesktopUserProfile
  if ($kind -eq 'file') {
    Start-TextEditor
  } else {
    Open-ConfigurationFolder
  }
  exit 0
} catch {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  $nativeCode = 0
  if ($cause -is [System.ComponentModel.Win32Exception]) { $nativeCode = $cause.NativeErrorCode }
  [Console]::Out.Write('DSH_GROK_OPEN_ERROR:' + $nativeCode)
  exit 1
}
`.trim();

function environmentValue(env, name, platform) {
  return platform === 'win32'
    ? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    : env[name];
}

function statTarget(path, stat) {
  try { return stat(path); }
  catch (cause) {
    if (['ENOENT', 'ENOTDIR'].includes(cause?.code)) return null;
    throw error('CONFIG_OPEN_ACCESS_FAILED', '无法访问配置位置，请检查文件权限。',
      { cause: ['EACCES', 'EPERM'].includes(cause?.code) ? cause.code : 'IO_ERROR' });
  }
}

function openPlan(path, kind, { platform, env, stat }) {
  const paths = platform === 'win32' ? win32 : posix;
  if (typeof path !== 'string' || !paths.isAbsolute(path) || /[\0\r\n]/.test(path)
    || platform === 'win32' && path.includes('"') || !['file', 'folder'].includes(kind)) {
    throw error('CONFIG_OPEN_INVALID', '配置位置或打开方式无效。');
  }
  const config = statTarget(path, stat);
  if (config && !config.isFile()) throw error('CONFIG_OPEN_INVALID', '配置路径不是普通文件，请检查配置位置。');
  const exists = Boolean(config);
  const target = kind === 'file' ? path : paths.dirname(path);
  const entry = kind === 'file' ? config : statTarget(target, stat);
  if (!entry) return { exists, missing: true };
  if (kind === 'folder' && !entry.isDirectory()) throw error('CONFIG_OPEN_INVALID', '配置所在位置不是文件夹。');
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name, value]) =>
    OS_ENV.test(name) && typeof value === 'string'));
  const textFile = TEXT_EXTENSIONS.has(paths.extname(path).toLowerCase());
  const regular = file => statTarget(file, stat)?.isFile() === true;
  if (platform === 'win32') {
    const systemRoot = environmentValue(env, 'SystemRoot', platform) || environmentValue(env, 'WINDIR', platform);
    if (typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot) || /[\0\r\n"]/.test(systemRoot)) {
      throw error('CONFIG_OPEN_UNAVAILABLE', '无法定位 Windows 系统打开工具，请复制路径后手动打开。');
    }
    const command = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!regular(command)) throw error('CONFIG_OPEN_UNAVAILABLE', 'Windows 系统打开工具不存在，请复制路径后手动打开。');
    for (const name of Object.keys(childEnv)) if (name.toUpperCase() === 'SYSTEMROOT') delete childEnv[name];
    return { exists, command, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_OPEN],
      cwd: systemRoot, receipt: true, folderReceipt: kind === 'folder', env: { ...childEnv, SystemRoot: systemRoot,
        DSH_GROK_OPEN_TARGET: target, DSH_GROK_OPEN_KIND: kind } };
  }
  if (platform === 'darwin') {
    if (!regular('/usr/bin/open')) throw error('CONFIG_OPEN_UNAVAILABLE', '系统打开工具不可用，请复制路径后手动打开。');
    return { exists, command: '/usr/bin/open', args: kind === 'file' ? ['-t', path] : exists ? ['-R', path] : [target],
      cwd: paths.dirname(path), env: childEnv };
  }
  if (platform === 'linux') {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
      throw error('CONFIG_OPEN_NO_DESKTOP', '当前宿主没有桌面会话，请复制路径后在宿主打开。');
    }
    if (kind === 'file' && !textFile) {
      throw error('CONFIG_OPEN_UNSAFE_TYPE', '请使用文本编辑器打开此配置；为避免执行文件，未调用默认程序。');
    }
    const command = ['/usr/bin/xdg-open', '/bin/xdg-open'].find(regular);
    if (!command) throw error('CONFIG_OPEN_UNAVAILABLE', '系统未安装 xdg-open，请复制路径后手动打开。');
    return { exists, command, args: [target], cwd: paths.dirname(path), env: childEnv,
      // xdg-open may exec the editor itself. Never kill that process just
      // because the launcher has not returned while its window stays open.
      mayBecomeEditor: true };
  }
  throw error('CONFIG_OPEN_UNAVAILABLE', '当前系统不支持自动打开，请复制路径后手动打开。');
}

function runOpen(plan, { spawnImpl, signal, timeoutMs }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child, ended = false, timer, reapTimer, failure = null, output = '', bytes = 0;
    const finish = (cause, result = {}) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer); clearTimeout(reapTimer);
      signal?.removeEventListener('abort', abort);
      if (cause) reject(cause); else resolve(result);
    };
    const stop = cause => {
      if (ended || failure) return;
      failure = cause;
      if (plan.mayBecomeEditor) {
        child.unref?.();
        finish(cause);
        return;
      }
      try { child.kill(); } catch { /* close or the bounded reap check decides completion */ }
      reapTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.();
        finish(error('CONFIG_OPEN_REAP_FAILED', '打开工具未能正常结束，请检查桌面后再试。'));
      }, 1000);
    };
    const abort = () => stop(signal.reason ?? error('CONFIG_OPEN_CANCELLED', '打开请求已取消。'));
    try {
      child = spawnImpl(plan.command, plan.args, {
        cwd: plan.cwd, env: plan.env, shell: false, windowsHide: true,
        stdio: plan.mayBecomeEditor ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(error('CONFIG_OPEN_START_FAILED', '无法启动系统打开工具，请复制路径后手动打开。'));
      return;
    }
    child.once('error', cause => finish(error(cause?.code === 'ENOENT' ? 'CONFIG_OPEN_UNAVAILABLE' : 'CONFIG_OPEN_START_FAILED',
      '无法启动系统打开工具，请检查系统权限或复制路径后手动打开。',
      { cause: ['ENOENT', 'EACCES', 'EPERM'].includes(cause?.code) ? cause.code : 'SPAWN_ERROR' })));
    child.stdout?.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_RECEIPT_BYTES) stop(error('CONFIG_OPEN_UNCONFIRMED', '系统打开工具未返回有效结果，请检查桌面后再试。'));
      else output += chunk.toString('utf8');
    });
    child.stderr?.resume(); // Never forward raw OS errors or editor output.
    child.once('close', (code, exitSignal) => {
      if (failure) return finish(failure);
      if (code === 0 && !exitSignal && (!plan.receipt ||
          output.trim() === (plan.folderReceipt ? 'DSH_GROK_OPEN_FOLDER_VISIBLE' : 'DSH_GROK_OPEN_OK'))) return finish();
      if (plan.folderReceipt && output.trim() === 'DSH_GROK_OPEN_FOLDER_UNCONFIRMED') {
        return finish(error('CONFIG_OPEN_FOLDER_UNCONFIRMED',
          '未能确认文件夹窗口已显示，请检查资源管理器，或复制路径后手动打开。'));
      }
      const opened = plan.receipt && /^DSH_GROK_OPEN_OK:(modern|classic):(none|unavailable|discovery-failed|launch-failed|early-exit)$/.exec(output.trim());
      if (!plan.folderReceipt && code === 0 && !exitSignal && opened && (opened[1] === 'classic' || opened[2] === 'none')) {
        return finish(null, { editor: opened[1], fallbackReason: opened[2] === 'none' ? null : opened[2] });
      }
      if (plan.receipt && output.trim() === 'DSH_GROK_OPEN_PROFILE_ERROR') {
        return finish(error('CONFIG_OPEN_PROFILE_FAILED', '无法定位系统用户目录，未启动编辑器；请复制路径后手动打开。'));
      }
      const editorFailure = plan.receipt && /^DSH_GROK_OPEN_EDITOR_ERROR:(-?\d+)$/.exec(output.trim());
      if (editorFailure) {
        const editorExitCode = Number(editorFailure[1]);
        if (Number.isInteger(editorExitCode) && editorExitCode >= -2147483648 && editorExitCode <= 2147483647) {
          const exitHex = (editorExitCode >>> 0).toString(16).toUpperCase().padStart(8, '0');
          return finish(error('CONFIG_OPEN_EDITOR_FAILED', `文本编辑器异常退出（0x${exitHex}），请重试或复制路径后手动打开。`,
            { editorExitCode }));
        }
      }
      const match = /^DSH_GROK_OPEN_ERROR:(\d+)$/.exec(output.trim());
      const osCode = match ? Number(match[1]) : null;
      const message = osCode === 5 ? '系统拒绝打开配置，请检查文件及编辑器权限。'
        : osCode === 1155 ? '没有可用的文本编辑器，请复制路径后选择编辑器打开。'
          : osCode === 2 || osCode === 3 ? '配置位置或默认编辑器不存在，请检查系统文件关联。'
            : '系统未能打开配置位置，请检查默认编辑器或复制路径后手动打开。';
      finish(error('CONFIG_OPEN_FAILED', message,
        { ...(Number.isInteger(code) ? { exitCode: code } : {}), ...(osCode !== null ? { osCode } : {}) }));
    });
    timer = setTimeout(() => stop(error('CONFIG_OPEN_TIMEOUT',
      '未能及时确认打开结果，请先检查桌面是否已有窗口；配置文件未修改。')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Opens only the caller's already-resolved configuration, without reading it. */
export function createConfigLocationOpener({ platform = process.platform, env = () => process.env,
  stat = statSync, spawnImpl = spawn, timeoutMs = OPEN_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid opener deadline.');
  let active = null, disposed = false;
  return Object.freeze({
    open({ path, kind = 'folder', signal } = {}) {
      if (disposed) return Promise.reject(error('CONFIG_OPEN_CANCELLED', '插件已停用，打开请求已取消。'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (active) return active.path === path && active.kind === kind ? active.promise
        : Promise.reject(error('CONFIG_OPEN_BUSY', '正在打开配置位置，请稍候再试。'));
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const request = { path, kind, controller };
      active = request;
      request.promise = (async () => {
        const plan = openPlan(path, kind, { platform, env: typeof env === 'function' ? env() : env, stat });
        if (plan.missing) return { exists: plan.exists, opened: false };
        const result = await runOpen(plan, { spawnImpl, signal: combined, timeoutMs });
        return { exists: plan.exists, opened: true, ...result };
      })().finally(() => { if (active === request) active = null; });
      return request.promise;
    },
    dispose() {
      disposed = true;
      active?.controller.abort(error('CONFIG_OPEN_CANCELLED', '插件已停用，打开请求已取消。'));
    },
  });
}
