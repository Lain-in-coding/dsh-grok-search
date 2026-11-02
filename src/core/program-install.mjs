import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GrokSearchError } from './errors.mjs';
import { findExistingGrok, grokPlatformPackage, inspectGrokProgram, VERIFIED_GROK_VERSIONS } from './program-discovery.mjs';
import { probeMcpHandshake } from './mcp-search.mjs';

const fail = (code, message) => { throw new GrokSearchError(code, message); };
const REGISTRIES = Object.freeze(['https://registry.npmjs.org', 'https://registry.npmmirror.com']);
const DOWNLOAD_ORIGINS = new Set([...REGISTRIES, 'https://cdn.npmmirror.com']);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const safePath = name => name && !name.startsWith('/') && !/[\\:\0]/.test(name)
  && name.split('/').every(part => part !== '..' && part !== '.');

export function verifyArchiveIntegrity(bytes, integrity) {
  const encoded = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity ?? '')?.[1];
  if (!encoded) fail('GROK_DOWNLOAD_INTEGRITY', '下载元数据缺少有效 SHA-512 校验值。');
  const expected = Buffer.from(encoded, 'base64'), actual = createHash('sha512').update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('GROK_DOWNLOAD_INTEGRITY', '下载文件校验失败，未安装。');
}

// The published platform package contains only its manifest and one native
// binary. Parse that small format directly; reject links, special files and
// extended paths instead of handing an untrusted archive to a shell extractor.
export function unpackPlatformArchive(archive, { packageName, version, platform = process.platform } = {}) {
  let bytes;
  try { bytes = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }); }
  catch { fail('GROK_ARCHIVE_INVALID', '下载文件无法安全解压。'); }
  const files = new Map();
  const filename = platform === 'win32' ? 'grok-search-rs.exe' : 'grok-search-rs';
  const wanted = new Set(['package/package.json', 'package/bin/' + filename]);
  let at = 0, ended = false;
  const text = data => data.toString('utf8').replace(/\0.*$/s, '');
  const octal = data => {
    const value = text(data).trim();
    if (!/^[0-7]+$/.test(value)) fail('GROK_ARCHIVE_INVALID', '归档数字字段无效。');
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) fail('GROK_ARCHIVE_INVALID', '归档字段超出限制。');
    return parsed;
  };
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512);
    if (header.every(value => value === 0)) { ended = true; break; }
    const checksum = octal(header.subarray(148, 156));
    const computed = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (computed !== checksum) fail('GROK_ARCHIVE_INVALID', '归档头校验失败。');
    const prefix = text(header.subarray(345, 500));
    const name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
    if (!safePath(name) || !name.startsWith('package/')) fail('GROK_ARCHIVE_PATH', '归档包含不安全路径。');
    const type = header[156], size = octal(header.subarray(124, 136));
    if (![0, 48, 53].includes(type)) fail('GROK_ARCHIVE_TYPE', '归档包含链接或不受支持的文件类型。');
    if (size > 50 * 1024 * 1024 || at + 512 + size > bytes.length) fail('GROK_ARCHIVE_INVALID', '归档文件长度无效。');
    if (type !== 53) {
      if (!wanted.has(name) || files.has(name)) fail('GROK_ARCHIVE_CONTENT', '平台包包含未预期或重复文件。');
      files.set(name, Buffer.from(bytes.subarray(at + 512, at + 512 + size)));
    } else if (size !== 0) fail('GROK_ARCHIVE_INVALID', '归档目录长度无效。');
    at += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || bytes.subarray(at).some(value => value !== 0) || files.size !== 2) fail('GROK_ARCHIVE_INVALID', '归档不完整或包含额外数据。');
  let manifest;
  try { manifest = JSON.parse(files.get('package/package.json').toString('utf8')); }
  catch { fail('GROK_ARCHIVE_METADATA', '平台包清单无效。'); }
  if (manifest.name !== packageName || manifest.version !== version || manifest.scripts
    || !Array.isArray(manifest.os) || !manifest.os.includes(platform)) fail('GROK_ARCHIVE_METADATA', '平台包身份、版本或系统不匹配。');
  const executable = files.get('package/bin/' + filename);
  if (!executable.length) fail('GROK_ARCHIVE_CONTENT', '平台包没有可执行程序。');
  return { manifest, executable, filename };
}

async function readResponse(response, limit, signal) {
  if (!response.ok) fail('GROK_DOWNLOAD_HTTP', `程序下载服务返回 HTTP ${response.status}。`);
  if (Number(response.headers.get('content-length')) > limit) fail('GROK_DOWNLOAD_SIZE', '下载文件超过限制。');
  const reader = response.body?.getReader();
  if (!reader) fail('GROK_DOWNLOAD_EMPTY', '下载服务未返回文件内容。');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) fail('GROK_DOWNLOAD_SIZE', '下载文件超过限制。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function createPrivateProgramInstaller({ directory, platform = process.platform, arch = process.arch,
  fetchImpl = fetch, inspect = inspectGrokProgram, handshake = probeMcpHandshake } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('GROK_CACHE_PATH_INVALID', '程序缓存必须使用绝对路径。');
  const packageName = grokPlatformPackage(platform, arch);
  let pending = null;
  const fetchBytes = async (url, limit, signal) => {
    for (let redirects = 0; redirects < 4; redirects++) {
      let parsed;
      try { parsed = new URL(url); } catch { fail('GROK_DOWNLOAD_ORIGIN', '下载地址无效。'); }
      if (!DOWNLOAD_ORIGINS.has(parsed.origin) || parsed.username || parsed.password || parsed.hash) {
        fail('GROK_DOWNLOAD_ORIGIN', '下载地址不属于受信的 npm 源。');
      }
      let response;
      try { response = await fetchImpl(url, { signal, redirect: 'manual', credentials: 'omit',
        headers: { accept: 'application/json, application/octet-stream' } }); }
      catch { signal.throwIfAborted(); fail('GROK_DOWNLOAD_UNAVAILABLE', '下载服务暂时不可用，请稍后重试。'); }
      if (![301, 302, 303, 307, 308].includes(response.status)) return readResponse(response, limit, signal);
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) fail('GROK_DOWNLOAD_ORIGIN', '下载跳转缺少目标地址。');
      url = new URL(location, url).href;
    }
    fail('GROK_DOWNLOAD_ORIGIN', '下载跳转次数超过限制。');
  };
  const metadata = async (name, version, signal) => {
    let error;
    for (const origin of REGISTRIES) {
      try {
        const bytes = await fetchBytes(`${origin}/${encodeURIComponent(name)}/${version}`, 1_048_576, signal);
        const data = JSON.parse(bytes.toString('utf8'));
        if (data.name !== name || typeof data.version !== 'string') fail('GROK_DOWNLOAD_METADATA', 'npm 包身份不匹配。');
        return { data, origin };
      } catch (caught) { signal.throwIfAborted(); error = caught; }
    }
    throw error instanceof GrokSearchError ? error : new GrokSearchError('GROK_DOWNLOAD_UNAVAILABLE', '官方源和备用镜像暂时不可用，请稍后重试。');
  };
  const active = async ({ signal } = {}) => {
    const file = join(directory, 'active.json');
    if (!existsSync(file)) return null;
    try {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 65536) throw new Error();
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (record.schemaVersion !== 1 || record.mcpHandshakeValidated !== true || !safePath(record.executable)
        || !VERIFIED_GROK_VERSIONS.includes(record.version)) throw new Error();
      const path = resolve(directory, record.executable);
      const inside = relative(directory, path);
      if (!inside || inside.startsWith('..' + sep) || isAbsolute(inside)) throw new Error();
      const actualInside = relative(realpathSync(directory), realpathSync(path));
      if (!actualInside || actualInside.startsWith('..' + sep) || isAbsolute(actualInside)
        || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 50 * 1024 * 1024) throw new Error();
      if (sha256(readFileSync(path)) !== record.sha256) fail('GROK_CACHE_DAMAGED', '私有 Grok 程序校验失败，请重新准备。');
      const result = await inspect(path, { signal, platform });
      if (result.version !== record.version) throw new Error();
      return { ...result, source: 'private-cache', found: true };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof GrokSearchError) throw error;
      fail('GROK_CACHE_DAMAGED', '私有 Grok 缓存记录无效，请重新准备。');
    }
  };
  const install = ({ signal, onProgress = () => {} } = {}) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (pending) return pending;
    const notify = event => { try { onProgress(event); } catch { /* observation cannot change publication */ } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new GrokSearchError('GROK_DOWNLOAD_TIMEOUT', '准备 Grok 程序超时，请重试。')), 120_000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    pending = (async () => {
      combined.throwIfAborted();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink()) fail('GROK_CACHE_PATH_INVALID', '程序缓存不能指向符号链接。');
      const lock = join(directory, '.install.lock');
      let fd;
      try {
        try { fd = openSync(lock, 'wx', 0o600); }
        catch (error) { if (error.code === 'EEXIST') fail('GROK_INSTALL_BUSY', '另一个实例正在准备程序，或上次准备被中断。'); throw error; }
        notify({ phase: 'checking-version' });
        const latest = await metadata('grok-search-rs', 'latest', combined);
        const version = latest.data.version;
        if (!VERIFIED_GROK_VERSIONS.includes(version)) fail('GROK_VERSION_UNVERIFIED', `上游最新版本 ${version} 尚未通过兼容验证，未自动安装。`);
        const resolved = await metadata(packageName, version, combined);
        const { data } = resolved;
        if (data.version !== version || !data.dist?.tarball || !data.dist?.integrity) fail('GROK_DOWNLOAD_METADATA', '平台包版本或下载信息不完整。');
        notify({ phase: 'downloading', version });
        let archive, downloadRegistry = resolved.origin;
        try { archive = await fetchBytes(data.dist.tarball, 32 * 1024 * 1024, combined); }
        catch (error) {
          combined.throwIfAborted();
          if (!['GROK_DOWNLOAD_UNAVAILABLE', 'GROK_DOWNLOAD_HTTP'].includes(error.code)
            || resolved.origin !== REGISTRIES[0]) throw error;
          const mirror = JSON.parse((await fetchBytes(`${REGISTRIES[1]}/${encodeURIComponent(packageName)}/${version}`,
            1_048_576, combined)).toString('utf8'));
          if (mirror.name !== packageName || mirror.version !== version || mirror.dist?.integrity !== data.dist.integrity) {
            fail('GROK_DOWNLOAD_INTEGRITY', '镜像版本或完整性与官方元数据不一致，未安装。');
          }
          archive = await fetchBytes(mirror.dist.tarball, 32 * 1024 * 1024, combined);
          downloadRegistry = REGISTRIES[1];
        }
        verifyArchiveIntegrity(archive, data.dist.integrity);
        const unpacked = unpackPlatformArchive(archive, { packageName, version, platform });
        if (!Array.isArray(unpacked.manifest.cpu) || !unpacked.manifest.cpu.includes(arch)) fail('GROK_ARCHIVE_METADATA', '程序架构与当前系统不匹配。');
        combined.throwIfAborted();
        notify({ phase: 'verifying', version });
        const id = `${version}-${platform}-${arch}-${randomUUID()}`;
        const folder = join(directory, id);
        mkdirSync(folder, { mode: 0o700 });
        const path = join(folder, unpacked.filename);
        const binary = openSync(path, 'wx', 0o700);
        try { writeFileSync(binary, unpacked.executable); fsyncSync(binary); } finally { closeSync(binary); }
        if (platform !== 'win32') chmodSync(path, 0o700);
        const checked = await inspect(path, { signal: combined, platform });
        if (checked.version !== version) fail('GROK_PROGRAM_IDENTITY_INVALID', '下载程序实际版本与元数据不一致。');
        if (checked.sha256 !== sha256(unpacked.executable)) fail('GROK_PROGRAM_CHANGED', '程序在验证期间发生变化，未启用。');
        const envOverrides = Object.fromEntries(Object.keys(process.env)
          .filter(key => /^(GROK_SEARCH_|TAVILY_|EXA_|TINYFISH_|FIRECRAWL_|OPENAI_COMPATIBLE_|GITHUB_TOKEN$)/i.test(key))
          .map(key => [key, null]));
        // Upstream refuses to start without a key. These probe-only values
        // prove the protocol binary, never credentials: no tool is called,
        // the endpoint is loopback-discard, and nothing enters shared config.
        Object.assign(envOverrides, { HOME: folder, USERPROFILE: folder, GROK_SEARCH_AUTH_MODE: 'api_key',
          GROK_SEARCH_API_KEY: 'dsh-handshake-only-sentinel-not-a-real-key',
          GROK_SEARCH_URL: 'http://127.0.0.1:9', GROK_SEARCH_MODEL: 'offline-handshake' });
        const protocol = await handshake({ executable: path, signal: combined,
          configPath: join(folder, 'handshake-config-not-created.toml'), envOverrides });
        if (protocol.version !== version || protocol.toolsDeclared !== true || protocol.exited !== true) {
          fail('GROK_PROTOCOL_UNVERIFIED', '下载程序的 MCP 握手或回收验证未通过，未启用。');
        }
        const record = { schemaVersion: 1, version, executable: `${id}/${unpacked.filename}`,
          sha256: sha256(unpacked.executable), integrity: data.dist.integrity, registry: resolved.origin, downloadRegistry,
          mcpHandshakeValidated: true, handshakeUsesSyntheticConfig: true, credentialsValidated: false };
        writeFileSync(join(folder, 'receipt.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        const staged = join(directory, `active-${randomUUID()}.json`);
        const stagedFd = openSync(staged, 'wx', 0o600);
        try { writeFileSync(stagedFd, JSON.stringify(record) + '\n'); fsyncSync(stagedFd); } finally { closeSync(stagedFd); }
        combined.throwIfAborted();
        renameSync(staged, join(directory, 'active.json'));
        notify({ phase: 'ready', version });
        return { ...checked, source: 'private-cache', found: true };
      } finally {
        if (fd !== undefined) { closeSync(fd); unlinkSync(lock); }
      }
    })().finally(() => { clearTimeout(timer); pending = null; });
    return pending;
  };
  return { active, install };
}

export async function resolveGrokProgram({ installer, signal, onProgress, ...discovery } = {}) {
  const existing = await findExistingGrok({ ...discovery, signal });
  if (existing.found) return existing;
  const cached = await installer.active({ signal });
  return cached ?? installer.install({ signal, onProgress });
}
