import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { GrokSearchError } from './errors.mjs';

export const VERIFIED_GROK_VERSIONS = Object.freeze(['0.1.26']);
const PLATFORMS = Object.freeze({
  'win32-x64': '@epsiekygrr_zedxx/grok-search-rs-win32-x64',
  'darwin-arm64': '@epsiekygrr_zedxx/grok-search-rs-darwin-universal',
  'linux-x64': '@epsiekygrr_zedxx/grok-search-rs-linux-x64',
});
export function grokPlatformPackage(platform = process.platform, arch = process.arch) {
  const name = PLATFORMS[`${platform}-${arch}`];
  if (!name) throw new GrokSearchError('GROK_PLATFORM_UNSUPPORTED', '此系统或架构尚未通过插件兼容验证。');
  return name;
}
const envValue = (env, key, platform) => Object.entries(env)
  .find(([name]) => platform === 'win32' ? name.toUpperCase() === key : name === key)?.[1];
export function discoverGrokCandidates({ override, configured, env = process.env,
  platform = process.platform, arch = process.arch } = {}) {
  const packageName = grokPlatformPackage(platform, arch);
  const filename = platform === 'win32' ? 'grok-search-rs.exe' : 'grok-search-rs';
  const preferred = override || configured;
  if (preferred) {
    if (!isAbsolute(preferred) || preferred.includes('\0')) throw new GrokSearchError('GROK_PROGRAM_PATH_INVALID', 'Grok 程序必须使用绝对路径。');
    return [{ path: preferred, source: override ? 'manual' : 'loader', explicit: true }];
  }
  const paths = (envValue(env, 'PATH', platform) || '').split(platform === process.platform ? delimiter : platform === 'win32' ? ';' : ':')
    .map(path => path.replace(/^"(.*)"$/, '$1')).filter(path => path && isAbsolute(path));
  const taskUserHome = envValue(env, 'HOME', platform) || envValue(env, 'USERPROFILE', platform) || homedir();
  const cargo = envValue(env, 'CARGO_HOME', platform) || join(taskUserHome, '.cargo');
  const rows = [];
  const seen = new Set();
  const add = (path, source) => {
    if (!existsSync(path)) return;
    let actual;
    try { actual = realpathSync(path); } catch { return; }
    const key = platform === 'win32' ? actual.toLowerCase() : actual;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ path: actual, source, explicit: false });
  };
  for (const path of [...paths, join(cargo, 'bin')]) {
    add(join(path, filename), path === join(cargo, 'bin') ? 'cargo' : 'path');
    // Resolve only documented npm package layouts. Never execute .cmd/.bat,
    // shell wrappers, a global npm command, or an arbitrary launcher.
    for (const modules of [join(path, 'node_modules'), join(dirname(path), 'lib/node_modules'),
      ...(path.endsWith('.bin') ? [dirname(path)] : [])]) {
      add(join(modules, 'grok-search-rs/node_modules', packageName, 'bin', filename), 'npm');
      add(join(modules, packageName, 'bin', filename), 'npm');
    }
  }
  return rows;
}

export async function inspectGrokProgram(executable, { signal, timeoutMs = 5_000,
  env = process.env, platform = process.platform } = {}) {
  if (typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0')) {
    throw new GrokSearchError('GROK_PROGRAM_PATH_INVALID', 'Grok 程序必须使用绝对路径。');
  }
  signal?.throwIfAborted();
  let stat, actual;
  try {
    actual = realpathSync(executable);
    stat = statSync(actual);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error();
    if (platform === 'win32' && !actual.toLowerCase().endsWith('.exe')) throw new Error();
    accessSync(actual, platform === 'win32' ? constants.R_OK : constants.X_OK);
  } catch { throw new GrokSearchError('GROK_PROGRAM_MISSING', '找不到可执行的 Grok 程序，请检查路径或重新准备。'); }
  const descriptor = openSync(actual, 'r'), magic = Buffer.alloc(4);
  try { readSync(descriptor, magic, 0, 4, 0); } finally { closeSync(descriptor); }
  const native = platform === 'win32' ? magic.subarray(0, 2).toString('ascii') === 'MZ'
    : platform === 'linux' ? magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      : ['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca', 'feedfacf', 'cffaedfe'].includes(magic.toString('hex'));
  if (!native) throw new GrokSearchError('GROK_PROGRAM_NOT_NATIVE', '检测到启动脚本，请选择 Grok 原生可执行程序。');
  const environment = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|SYSTEMDRIVE|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)));
  const version = await new Promise((resolveVersion, reject) => {
    let output = '', failed, timer, killTimer, settled = false;
    const child = spawn(actual, ['--version'], { env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolveVersion(value);
    };
    const stop = reason => {
      failed ??= reason;
      try { child.kill('SIGKILL'); } catch {}
      killTimer ??= setTimeout(() => finish(new GrokSearchError('GROK_PROGRAM_REAP_FAILED', '程序验证已停止，但验证进程未确认退出。')), 2_000);
    };
    const abort = () => stop(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop(new GrokSearchError('GROK_PROGRAM_TIMEOUT', 'Grok 版本检查超时。')), timeoutMs);
    child.once('error', () => finish(new GrokSearchError('GROK_PROGRAM_START_FAILED', '无法启动 Grok 版本检查。')));
    child.stdout.on('data', bytes => {
      if (output.length + bytes.length > 8192) { stop(new GrokSearchError('GROK_PROGRAM_OUTPUT_INVALID', '程序版本输出异常。')); return; }
      output += bytes.toString('utf8');
    });
    child.stderr.resume(); // Never retain upstream error text or credentials.
    child.once('close', code => {
      if (failed) return finish(failed);
      const match = /^grok-search-rs (\d+\.\d+\.\d+(?:-[\w.-]+)?)\s*$/.exec(output);
      if (code !== 0 || !match) return finish(new GrokSearchError('GROK_PROGRAM_IDENTITY_INVALID', '所选程序不是可识别的 grok-search-rs。'));
      finish(null, match[1]);
    });
    if (signal?.aborted) abort();
  });
  if (!VERIFIED_GROK_VERSIONS.includes(version)) throw new GrokSearchError('GROK_VERSION_UNVERIFIED', `Grok ${version} 尚未通过当前插件的兼容验证。`);
  const programBytes = readFileSync(actual);
  const after = statSync(actual);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
    throw new GrokSearchError('GROK_PROGRAM_CHANGED', 'Grok 程序在验证期间发生变化，请重试。');
  }
  return { path: actual, version, sha256: createHash('sha256').update(programBytes).digest('hex') };
}

export async function findExistingGrok(options = {}) {
  const candidates = discoverGrokCandidates(options);
  const inspect = options.inspect ?? inspectGrokProgram;
  const failures = [];
  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    try { return { ...await inspect(candidate.path, options), source: candidate.source, found: true }; }
    catch (error) {
      if (options.signal?.aborted || error.code === 'GROK_PROGRAM_REAP_FAILED' || candidate.explicit) throw error;
      failures.push({ code: error.code ?? 'GROK_PROGRAM_INVALID' });
    }
  }
  // An installed but unsupported/broken program is not permission to silently
  // download another copy. Let the user inspect it or choose private repair.
  if (candidates.length) throw new GrokSearchError(failures[0]?.code ?? 'GROK_PROGRAM_INVALID', '已发现 Grok，但验证未通过；请检查现有程序或明确选择重新准备。');
  return { found: false, candidates: 0 };
}
