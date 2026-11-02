#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  constants,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { arch, homedir, platform, release, tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { connectRenderer, waitForRenderer } from './lib/renderer-cdp.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const ARTIFACT_ROOT = join(PROJECT_ROOT, 'artifacts', 'b3-cli-web');
const DEFAULT_DISTRO = 'Ubuntu-22.04';
const REGISTRY = 'https://registry.npmmirror.com/';
const DEFAULT_PNPM_VERSION = '11.7.0';
const LINUX_NATIVE = 'node-addon-require-builtin-linux-x64-gnu';
const LINUX_NATIVE_VERSION = '0.1.9';
const SYSTEM_NATIVE = '@deepseek-ai/node-addon-system-linux-x64';
const SYSTEM_NATIVE_VERSION = '0.1.2';
const GROK_VERSION = '0.1.26';
const GROK_LINUX_X64_SHA256 = 'e8ced45392738bac691e41de9793c7941ed7f56c7e53697f8084b2e9ef4acf86';
const GROK_TEST_API_KEY = 'dsh-grok-search-local-test-key';
const VERSIONS = Object.freeze({
  rc2: '0.2.1-rc.2',
  rc3: '0.2.1-rc.3',
  rc4: '0.2.1-rc.4',
});
const CASES = new Set(['smoke', 'stop', 'full']);

function usage() {
  return [
    'Usage:',
    '  node scripts/b3-cli-web.mjs --dsh-cli <bin.js> --dsh-version <rc2|rc3|rc4>',
    '    --product-package <tgz> --grok-linux-archive <tar.gz> --case <smoke|stop|full>',
    '    --pnpm-entry <pnpm.cjs> --pnpm-store <path> --pnpm-cache <path>',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { case: 'stop', worker: false };
  const valueFlags = new Map([
    ['--dsh-cli', 'dshCli'],
    ['--dsh-version', 'dshVersion'],
    ['--product-package', 'productPackage'],
    ['--grok-linux-archive', 'grokLinuxArchive'],
    ['--browser-executable', 'browserExecutable'],
    ['--case', 'case'],
    ['--run-id', 'runId'],
    ['--staged-runtime-archive', 'stagedRuntimeArchive'],
    ['--bootstrap-file', 'bootstrapFile'],
    ['--wsl-distro', 'wslDistro'],
    ['--pnpm-entry', 'pnpmEntry'],
    ['--pnpm-store', 'pnpmStore'],
    ['--pnpm-cache', 'pnpmCache'],
    ['--first-use', 'firstUse'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--worker') {
      options.worker = true;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key || index + 1 >= argv.length) throw new Error(`Invalid argument ${JSON.stringify(flag)}.\n${usage()}`);
    options[key] = argv[++index];
  }
  if (!options.dshCli || !options.dshVersion || !options.productPackage || !options.grokLinuxArchive
    || !options.pnpmEntry || !options.pnpmStore || !options.pnpmCache) {
    throw new Error(`--dsh-cli, --dsh-version, --product-package, --grok-linux-archive, --pnpm-entry, --pnpm-store and --pnpm-cache are required.\n${usage()}`);
  }
  if (options.case === 'full' && !options.browserExecutable) {
    throw new Error(`--browser-executable is required for the full case.\n${usage()}`);
  }
  if (!Object.hasOwn(VERSIONS, options.dshVersion)) {
    throw new Error(`Unsupported --dsh-version ${JSON.stringify(options.dshVersion)}; expected rc2, rc3 or rc4.`);
  }
  if (!CASES.has(options.case)) {
    throw new Error(`Unsupported --case ${JSON.stringify(options.case)}; expected smoke, stop or full.`);
  }
  if (options.firstUse && options.firstUse !== 'download') throw new Error('Expected --first-use download.');
  if (options.firstUse && options.case !== 'full') throw new Error('First-use verification requires --case full.');
  options.dshCli = resolve(options.dshCli);
  options.productPackage = resolve(options.productPackage);
  options.grokLinuxArchive = resolve(options.grokLinuxArchive);
  for (const key of ['pnpmEntry', 'pnpmStore', 'pnpmCache']) {
    if (options[key]) options[key] = resolve(options[key]);
  }
  return options;
}

function isoRunId(version) {
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '').replace('T', 'T');
  return `${stamp}-${version}-${randomBytes(4).toString('hex')}`;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function redactPrivatePaths(value) {
  return String(value ?? '')
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/gi, '$1<redacted>')
    .replace(/([A-Za-z]:\/Users\/)[^/]+/gi, '$1<redacted>')
    .replace(/(\/mnt\/[a-z]\/Users\/)[^/]+/gi, '$1<redacted>')
    .replace(/(\/Users\/)[^/]+/g, '$1<redacted>')
    .replace(/(\/home\/)[^/]+/g, '$1<redacted>');
}

function integrityContentPath(cacheDirectory, integrity) {
  const separator = integrity.indexOf('-');
  if (separator < 1) return null;
  const algorithm = integrity.slice(0, separator);
  let hex;
  try { hex = Buffer.from(integrity.slice(separator + 1), 'base64').toString('hex'); }
  catch { return null; }
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  return join(cacheDirectory, 'content-v2', algorithm, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

function readTarManifest(tarballPath) {
  const bytes = gunzipSync(readFileSync(tarballPath));
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const rawName = bytes.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    const prefix = bytes.toString('utf8', offset + 345, offset + 500).replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeField = bytes.toString('ascii', offset + 124, offset + 136).replace(/\0/g, '').trim();
    const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar entry size for ${name}.`);
    if (name === 'package/package.json') {
      return JSON.parse(bytes.toString('utf8', offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`No package/package.json found in ${tarballPath}.`);
}

async function startLocalPnpmRegistry({ storeIndex, npmCache, runtimeRoot, pnpmWorker, packrModule }) {
  const workerSource = readFileSync(pnpmWorker, 'utf8');
  const startMarker = '\nstartWorker();';
  const markerIndex = workerSource.lastIndexOf(startMarker);
  if (markerIndex < 0) throw new Error('Unable to expose the store decoder from the pnpm worker bundle.');
  writeFileSync(packrModule, `${workerSource.slice(0, markerIndex)}\nexport { packr };\n`);
  const { packr } = await import(`${pathToFileURL(packrModule).href}?run=${Date.now()}`);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(storeIndex);
  const rows = database.prepare('SELECT key, data FROM package_index').all();
  database.close();
  const packages = new Map();
  for (const { key, data } of rows) {
    const tab = key.indexOf('\t');
    if (tab < 0) continue;
    const identity = key.slice(tab + 1);
    const at = identity.lastIndexOf('@');
    if (at <= 0) continue;
    const name = identity.slice(0, at);
    const version = identity.slice(at + 1);
    const integrity = key.slice(0, tab);
    if (!name || !version || !integrity.includes('-')) continue;
    const versions = packages.get(name) ?? new Map();
    if (!versions.has(version)) {
      let index;
      try { index = packr.unpack(data); }
      catch { index = null; }
      versions.set(version, { name, version, integrity, index });
    }
    packages.set(name, versions);
  }

  const manifestCache = new Map();
  const tarballPath = entry => integrityContentPath(npmCache, entry.integrity);
  const manifestFor = entry => {
    const cached = manifestCache.get(entry.integrity);
    if (cached) return cached;
    const path = tarballPath(entry);
    let manifest;
    if (entry.index?.manifest && typeof entry.index.manifest === 'object') {
      manifest = entry.index.manifest;
    } else if (path && existsSync(path)) {
      manifest = readTarManifest(path);
    } else {
      const installed = join(runtimeRoot, 'node_modules', entry.name, 'package.json');
      if (!existsSync(installed)) throw new Error(`No cached tarball or staged manifest for ${entry.name}@${entry.version}.`);
      manifest = JSON.parse(readFileSync(installed, 'utf8'));
      if (manifest.version !== entry.version) {
        throw new Error(`Staged ${entry.name} version ${manifest.version} does not match ${entry.version}.`);
      }
    }
    manifestCache.set(entry.integrity, manifest);
    return manifest;
  };

  const metadataRequests = [];
  const tarballRequests = [];
  const missing = [];
  const server = createServer((request, response) => {
    const send = (status, value, type = 'application/json') => {
      response.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
      });
      response.end(type === 'application/json' && typeof value !== 'string'
        ? JSON.stringify(value)
        : value);
    };
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/-/ping') {
      send(200, { ok: true });
      return;
    }
    if (url.pathname === '/-/b3-tarball') {
      const name = url.searchParams.get('name');
      const version = url.searchParams.get('version');
      const entry = packages.get(name)?.get(version);
      const path = entry && tarballPath(entry);
      tarballRequests.push({ name, version, found: Boolean(path && existsSync(path)) });
      if (!entry || !path || !existsSync(path)) {
        missing.push({ type: 'tarball', name, version });
        send(404, { error: 'cached tarball unavailable' });
        return;
      }
      send(200, readFileSync(path), 'application/octet-stream');
      return;
    }

    let name;
    try { name = decodeURIComponent(url.pathname.replace(/^\/+/, '')).replace(/\/+$/, ''); }
    catch {
      send(400, { error: 'invalid package name encoding' });
      return;
    }
    metadataRequests.push({ name });
    const versions = packages.get(name);
    if (!versions) {
      missing.push({ type: 'metadata', name });
      send(404, { error: 'package not in local pnpm store index' });
      return;
    }
    const body = {
      name,
      'dist-tags': {
        latest: [...versions.keys()].sort((left, right) =>
          left.localeCompare(right, undefined, { numeric: true })).at(-1),
      },
      versions: Object.fromEntries([...versions.entries()].map(([version, entry]) => {
        let manifest;
        try { manifest = manifestFor(entry); }
        catch (error) {
          missing.push({ type: 'manifest', name, version, message: error.message });
          return [version, null];
        }
        return [version, {
          ...manifest,
          name,
          version,
          dist: {
            tarball: `http://127.0.0.1:${server.address().port}/-/b3-tarball?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`,
            integrity: entry.integrity,
          },
        }];
      }).filter(([, value]) => value !== null)),
    };
    if (Object.keys(body.versions).length === 0) {
      send(404, { error: 'no cached manifest for package' });
      return;
    }
    send(200, JSON.stringify(body));
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    snapshot: () => ({
      source: 'host pnpm store index + host npm content cache',
      storeIndex: '<HOST_PNPM_STORE>/index.db',
      npmCache: '<HOST_NPM_CACHE>',
      packageNames: packages.size,
      metadataRequests: metadataRequests.slice(-300),
      tarballRequests: tarballRequests.slice(-300),
      missing: missing.slice(-100),
    }),
    close: () => new Promise((resolvePromise, reject) =>
      server.close(error => error ? reject(error) : resolvePromise())),
  };
}

async function startOfficialSearchStub() {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => {
      if (body.length < 1024 * 1024) body += chunk;
    });
    request.on('end', () => {
      let query = null;
      try {
        const parsed = JSON.parse(body);
        query = parsed?.messages?.[0]?.content
          ?.filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n') ?? null;
      } catch {}
      requests.push({
        method: request.method,
        url: request.url,
        bodyLength: body.length,
        query,
        authorizationKind: request.headers['x-api-key']
          ? 'offline-api-key'
          : request.headers['x-dsh-auth-token'] ? 'account' : 'none',
      });
      response.writeHead(200, {
        'content-type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({
        content: [
          {
            type: 'web_search_tool_result',
            content: [{
              type: 'web_search_result',
              url: 'https://example.invalid/official-counter',
              title: 'Official counter fixture',
              page_age: '2026-10-24',
            }],
          },
          {
            type: 'text',
            text: '本地官方搜索派发探针',
            citations: [{
              type: 'web_search_result_location',
              url: 'https://example.invalid/official-counter',
              cited_text: 'Official counter fixture',
            }],
          },
        ],
      }));
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  return {
    baseURL: `http://127.0.0.1:${port}/anthropic/v1`,
    port,
    requests,
    close: () => new Promise((resolvePromise, reject) =>
      server.close(error => error ? reject(error) : resolvePromise())),
  };
}

async function startGrokResponsesStub() {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => {
      if (body.length < 1024 * 1024) body += chunk;
    });
    request.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      const authorized = request.headers.authorization === `Bearer ${GROK_TEST_API_KEY}`;
      const input = Array.isArray(parsed?.input) ? parsed.input : [];
      const query = input
        .filter(message => message?.role === 'user')
        .map(message => typeof message.content === 'string' ? message.content : '')
        .filter(Boolean)
        .join('\n');
      requests.push({
        method: request.method,
        url: request.url,
        authorizedWithSyntheticKey: authorized,
        model: parsed?.model ?? null,
        tools: Array.isArray(parsed?.tools) ? parsed.tools.map(tool => tool?.type).filter(Boolean) : [],
        query,
      });
      if (request.method !== 'POST' || request.url !== '/v1/responses' || !authorized) {
        response.writeHead(401, {
          'content-type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify({ error: { message: 'local test authorization rejected' } }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({
        id: `resp-${randomBytes(6).toString('hex')}`,
        object: 'response',
        status: 'completed',
        model: parsed.model,
        output_text: 'Linux grok-search-rs 0.1.26 real MCP search succeeded.',
        output: [{
          type: 'web_search_call',
          action: {
            sources: [{
              url: 'https://example.invalid/grok-search-rs-linux',
              title: 'grok-search-rs Linux MCP fixture',
              description: 'Response served by the isolated local xAI Responses API stub.',
            }],
          },
        }, {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Linux grok-search-rs 0.1.26 real MCP search succeeded.',
          }],
        }],
      }));
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise((resolvePromise, reject) =>
      server.close(error => error ? reject(error) : resolvePromise())),
  };
}

async function runGrokProtocolProbe({ executable, configPath, home, tempDirectory, workspace }) {
  const child = spawn(executable, [], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: tempDirectory,
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? '',
      GROK_SEARCH_CONFIG: configPath,
      NO_COLOR: '1',
    },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  let stdoutBuffer = '';
  let stderrBytes = 0;
  let closed = false;
  let processError = null;
  const closedPromise = new Promise(resolvePromise => {
    child.once('close', (code, signal) => {
      closed = true;
      resolvePromise({ code, signal });
    });
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); }
      catch {
        processError = new Error('grok-search-rs emitted a non-JSON stdio frame.');
        for (const pending of responses.values()) pending.reject(processError);
        responses.clear();
        continue;
      }
      const pending = responses.get(String(value.id));
      if (pending) {
        responses.delete(String(value.id));
        pending.resolve(value);
      }
    }
  });
  child.stderr.on('data', chunk => {
    stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.length);
  });
  child.once('error', error => {
    processError = error;
    for (const pending of responses.values()) pending.reject(error);
    responses.clear();
  });
  const request = (id, method, params = {}) => new Promise((resolvePromise, reject) => {
    if (closed || processError) {
      reject(processError ?? new Error(`grok-search-rs exited before ${method}.`));
      return;
    }
    const timer = setTimeout(() => {
      responses.delete(String(id));
      reject(new Error(`grok-search-rs timed out waiting for ${method}.`));
    }, 30_000);
    responses.set(String(id), {
      resolve(value) { clearTimeout(timer); resolvePromise(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  let forced = false;
  try {
    const initialized = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-grok-search-linux-gate', version: '0.0.0' },
    });
    if (initialized.error || initialized.result?.serverInfo?.name !== 'grok-search-rs'
      || initialized.result.serverInfo.version !== GROK_VERSION) {
      throw new Error('grok-search-rs MCP initialize did not report version 0.1.26.');
    }
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }) + '\n');
    const listed = await request(2, 'tools/list');
    const tools = Array.isArray(listed.result?.tools) ? listed.result.tools : [];
    if (listed.error || !tools.some(tool => tool.name === 'web_search')) {
      throw new Error('grok-search-rs tools/list did not expose web_search.');
    }
    const called = await request(3, 'tools/call', {
      name: 'web_search',
      arguments: { query: 'direct stdio MCP protocol probe', extra_sources: 0, response_format: 'concise' },
    });
    if (called.error || called.result?.isError === true) {
      throw new Error('grok-search-rs tools/call web_search failed.');
    }
    child.stdin.end();
    const exit = await Promise.race([
      closedPromise,
      delay(10_000).then(() => null),
    ]);
    if (!exit) {
      forced = true;
      child.kill('SIGTERM');
      const terminated = await Promise.race([
        closedPromise,
        delay(2_000).then(() => null),
      ]);
      if (!terminated) child.kill('SIGKILL');
      throw new Error('grok-search-rs did not exit after stdio EOF.');
    }
    if (exit.code !== 0) throw new Error(`grok-search-rs exited with code ${exit.code}.`);
    const contentText = Array.isArray(called.result?.content)
      ? called.result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
      : '';
    return {
      serverInfo: initialized.result.serverInfo,
      protocolVersion: initialized.result.protocolVersion,
      tools: tools.map(tool => tool.name),
      call: {
        name: 'web_search',
        isError: called.result?.isError === true,
        hasStructuredContent: Boolean(called.result?.structuredContent),
        contentText,
      },
      process: {
        pid: child.pid,
        exitCode: exit.code,
        exitSignal: exit.signal,
        gracefulStdioEof: true,
        forced,
        stderrBytes,
      },
    };
  } finally {
    if (!closed) {
      try { child.stdin.end(); } catch {}
      child.kill('SIGTERM');
      const exited = await Promise.race([closedPromise, delay(2_000)]);
      if (exited === undefined && !closed) child.kill('SIGKILL');
    }
  }
}

function safeName(value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '-');
}

function runSync(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, code, signal) => {
      if (settled) return;
      settled = true;
      const result = { command, args, cwd: options.cwd, code, signal, stdout, stderr };
      if (error) reject(Object.assign(error, { result }));
      else resolvePromise(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16 * 1024 * 1024); });
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => finish(null, code, signal));
  });
}

function findInstallRoot(cliPath) {
  let cursor = dirname(cliPath);
  for (let index = 0; index < 12; index += 1, cursor = dirname(cursor)) {
    if (cursor.endsWith(`${String.fromCharCode(92)}node_modules`) || cursor.endsWith('/node_modules')) {
      return dirname(cursor);
    }
    if (dirname(cursor) === cursor) break;
  }
  throw new Error('Could not locate the npm installation root for --dsh-cli.');
}

function wslUncPath(distro, linuxPath) {
  if (!linuxPath.startsWith('/')) throw new Error(`Expected an absolute WSL path, got ${linuxPath}.`);
  return `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll('/', '\\')}`;
}

async function windowsBootstrap(options) {
  const distro = process.env.DSH_CLI_WEB_WSL_DISTRO ?? DEFAULT_DISTRO;
  const runId = isoRunId(options.dshVersion);
  const runRoot = `/tmp/dsh-grok-cli-web-${runId}`;
  const artifactDir = join(ARTIFACT_ROOT, runId);
  mkdirSync(artifactDir, { recursive: true });
  const summaryPath = join(artifactDir, 'summary.json');
  const commands = [];
  let stage = 'prepare';
  try {
    if (platform() !== 'win32') throw new Error('Windows bootstrap was selected on a non-Windows platform.');
    if (!existsSync(options.dshCli) || !statSync(options.dshCli).isFile()) {
      throw new Error(`DSH CLI file does not exist: ${options.dshCli}`);
    }
    if (!existsSync(options.productPackage) || !statSync(options.productPackage).isFile()) {
      throw new Error(`Product package does not exist: ${options.productPackage}`);
    }
    if (!existsSync(options.grokLinuxArchive) || !statSync(options.grokLinuxArchive).isFile()) {
      throw new Error(`Official Linux Grok archive does not exist: ${options.grokLinuxArchive}`);
    }
    if (!existsSync(options.pnpmEntry) || !statSync(options.pnpmEntry).isFile()) {
      throw new Error(`pnpm entry is missing: ${options.pnpmEntry}`);
    }
    if (!existsSync(options.pnpmStore) || !statSync(options.pnpmStore).isDirectory()) {
      throw new Error(`pnpm store is missing: ${options.pnpmStore}`);
    }
    if (!existsSync(options.pnpmCache) || !statSync(options.pnpmCache).isDirectory()) {
      throw new Error(`pnpm cache is missing: ${options.pnpmCache}`);
    }
    const grokArchiveSha256 = sha256(options.grokLinuxArchive);
    if (grokArchiveSha256 !== GROK_LINUX_X64_SHA256) {
      throw new Error(`Official Linux Grok archive SHA-256 mismatch: ${grokArchiveSha256}`);
    }
    const cliRoot = findInstallRoot(options.dshCli);
    stage = 'wsl-preflight';
    const preflight = await runSync('wsl.exe', [
      '-d', distro, '--exec', 'bash', '-lc',
      'printf "%s\\n" "$(uname -m)" "$(node --version)" "$(npm --version)"',
    ]);
    commands.push({
      label: 'wsl-preflight',
      command: 'wsl.exe',
      args: ['-d', distro, '--exec', 'bash', '-lc', '<runtime-version-command>'],
      exitCode: preflight.code,
    });
    if (preflight.code !== 0) throw new Error(`WSL preflight failed: ${preflight.stderr.trim()}`);
    const environment = preflight.stdout.trim().split(/\r?\n/);
    if (environment[0] !== 'x86_64') throw new Error(`Expected WSL x86_64, got ${environment[0]}.`);
    const nodeMajor = Number(environment[1]?.replace(/^v/, '').split('.')[0]);
    if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
      throw new Error(`Expected WSL Node >= 22, got ${environment[1]}.`);
    }

    stage = 'create-temporary-root';
    const rootResult = await runSync('wsl.exe', ['-d', distro, '--exec', 'mkdir', '-p', runRoot]);
    commands.push({ label: 'create-temporary-root', command: 'wsl.exe', args: ['-d', distro, '--exec', 'mkdir', '-p', runRoot], exitCode: rootResult.code });
    if (rootResult.code !== 0) throw new Error(`Could not create WSL temporary root: ${rootResult.stderr.trim()}`);

    stage = 'stage-linux-cli';
    const archive = `${runRoot}/cli-runtime.tar`;
    const tar = await runSync('tar.exe', ['-cf', wslUncPath(distro, archive), '-C', cliRoot, '.']);
    commands.push({
      label: 'stage-linux-cli',
      command: 'tar.exe',
      args: ['-cf', '<WSL_TEMP>/cli-runtime.tar', '-C', '<DSH_CLI_INSTALL_ROOT>', '.'],
      exitCode: tar.code,
    });
    if (tar.code !== 0) throw new Error(`Could not stage the CLI package for WSL: ${tar.stderr.trim()}`);

    stage = 'map-paths';
    const paths = {};
    for (const [key, value] of Object.entries({
      script: SCRIPT_PATH,
      projectRoot: PROJECT_ROOT,
      dshCli: options.dshCli,
      productPackage: options.productPackage,
      grokLinuxArchive: options.grokLinuxArchive,
      pnpmEntry: options.pnpmEntry,
      pnpmStore: options.pnpmStore,
      pnpmCache: options.pnpmCache,
    })) {
      const mapped = await runSync('wsl.exe', ['-d', distro, '--exec', 'wslpath', '-a', '-u', value]);
      if (mapped.code !== 0) throw new Error(`Could not map ${key} into WSL: ${mapped.stderr.trim()}`);
      paths[key] = mapped.stdout.trim();
    }
    const bootstrapFile = `${runRoot}/bootstrap.json`;
    const bootstrap = {
      distro,
      runId,
      createdBy: 'windows-bootstrap',
      originalCli: '<DSH_CLI_INPUT>',
      cliInstallRoot: '<DSH_CLI_INSTALL_ROOT>',
      archive,
      grokLinuxArchive: '<OFFICIAL_GROK_LINUX_ARCHIVE>',
      grokLinuxArchiveSha256: grokArchiveSha256,
      commands,
      environment: {
        wslArch: environment[0],
        node: environment[1],
        npm: environment[2],
      },
    };
    writeFileSync(wslUncPath(distro, bootstrapFile), redactPrivatePaths(JSON.stringify(bootstrap, null, 2)) + '\n');

    stage = 'linux-worker';
    const worker = await new Promise((resolvePromise, reject) => {
      const child = spawn('wsl.exe', [
        '-d', distro, '--exec', 'node', paths.script,
        '--worker',
        '--run-id', runId,
        '--dsh-cli', paths.dshCli,
        '--dsh-version', options.dshVersion,
        '--product-package', paths.productPackage,
        '--grok-linux-archive', paths.grokLinuxArchive,
        ...(options.browserExecutable ? ['--browser-executable', options.browserExecutable] : []),
        ...(options.firstUse ? ['--first-use', options.firstUse] : []),
        '--case', options.case,
        '--staged-runtime-archive', archive,
        '--bootstrap-file', bootstrapFile,
        '--wsl-distro', distro,
        '--pnpm-entry', paths.pnpmEntry,
        '--pnpm-store', paths.pnpmStore,
        '--pnpm-cache', paths.pnpmCache,
      ], {
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolvePromise({ code, signal }));
    });
    process.exitCode = worker.code ?? 1;
  } catch (error) {
    const summary = {
      status: 'fail',
      runId,
      case: options.case,
      dshVersion: options.dshVersion,
      stage,
      error: { name: error.name, message: redactPrivatePaths(error.message) },
      commands,
      boundaries: ['Bootstrap failed before a complete Linux CLI/Web run.'],
    };
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    console.error(`b3-cli-web: ${stage}: ${redactPrivatePaths(error.message)}`);
    console.error(`Evidence: ${summaryPath}`);
    process.exitCode = 1;
  }
}

class Evidence {
  constructor(directory, replacements) {
    this.directory = directory;
    this.replacements = replacements;
    this.secrets = new Set();
    this.executions = [];
  }

  addSecret(value) {
    if (typeof value !== 'string' || !value) return;
    this.secrets.add(value);
    const token = value.match(/(?:^|;\s*)token=([^;\s]+)/i)?.[1];
    if (token) this.secrets.add(token);
  }

  sanitize(value) {
    let text = typeof value === 'string' ? value : String(value ?? '');
    const secrets = [...this.secrets].filter(Boolean).sort((left, right) => right.length - left.length);
    for (const secret of secrets) text = text.replaceAll(secret, '<redacted>');
    for (const [from, to] of this.replacements) text = text.replaceAll(from, to);
    text = text.replace(/([?&]token=)[^&\s]+/gi, '$1<redacted>');
    text = text.replace(/(Cookie:\s*)[^\r\n]+/gi, '$1<redacted>');
    return redactPrivatePaths(text);
  }

  safe(value) {
    const serialized = JSON.stringify(value, (_key, item) =>
      typeof item === 'string' ? this.sanitize(item) : item);
    return JSON.parse(serialized);
  }

  json(name, value) {
    const path = join(this.directory, safeName(name));
    writeFileSync(path, JSON.stringify(this.safe(value), null, 2) + '\n');
    return path;
  }

  text(name, value) {
    const path = join(this.directory, safeName(name));
    writeFileSync(path, this.sanitize(value));
    return path;
  }

  commandView(command, args, cwd) {
    return {
      command: this.sanitize(command),
      args: args.map(arg => this.sanitize(arg)),
      cwd: cwd ? this.sanitize(cwd) : null,
    };
  }

  recordExecution(record) {
    this.executions.push(record);
    return record;
  }
}

async function runCaptured(label, command, args, options, evidence, limit = 16 * 1024 * 1024) {
  const started = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const collect = (current, chunk, truncated) => {
    if (current.length >= limit) return { value: current, truncated: true };
    const next = current + chunk;
    return { value: next.slice(0, limit), truncated: truncated || next.length > limit };
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    const next = collect(stdout, chunk, stdoutTruncated);
    stdout = next.value;
    stdoutTruncated = next.truncated;
  });
  child.stderr.on('data', chunk => {
    const next = collect(stderr, chunk, stderrTruncated);
    stderr = next.value;
    stderrTruncated = next.truncated;
  });
  let timedOut = false;
  let timer;
  const timeout = options.timeoutMs ?? 300_000;
  if (timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeout);
    timer.unref();
  }
  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const record = {
    label,
    ...evidence.commandView(command, args, options.cwd),
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    durationMs: Date.now() - started,
    stdoutTruncated,
    stderrTruncated,
  };
  evidence.recordExecution(record);
  evidence.text(`logs/${safeName(label)}.stdout.log`, stdout);
  evidence.text(`logs/${safeName(label)}.stderr.log`, stderr);
  return { ...record, stdout, stderr };
}

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

function findId(dump, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*(?:-\\s*)?(?:"id"\\s*:\\s*"|id\\s*:\\s*)${escaped}(?:"|\\s|$)`).test(dump);
}

function completionRecord(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.releaseCompletion && typeof value.releaseCompletion === 'object') return value.releaseCompletion;
  for (const item of Object.values(value)) {
    const found = completionRecord(item);
    if (found) return found;
  }
  return null;
}

function listJsonFiles(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) result.push(path);
    }
  };
  visit(directory);
  return result;
}

function procCommand(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return null;
  }
}

function matchingProcesses(markers) {
  if (!existsSync('/proc')) return [];
  const needles = (Array.isArray(markers) ? markers : [markers]).filter(Boolean);
  return readdirSync('/proc')
    .filter(name => /^\d+$/.test(name))
    .map(Number)
    .filter(pid => pid !== process.pid)
    .map(pid => ({ pid, command: procCommand(pid) }))
    .filter(item => needles.some(marker => item.command?.includes(marker)));
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}.`);
}

async function terminateWebProcess(web, runRoot, grokExecutable) {
  if (!web || web.closed) {
    return {
      signalSent: null, graceful: true, exitCode: web?.exitCode ?? null,
      exitSignal: web?.signal ?? null, durationMs: 0,
      dshAliveAfterExit: false, leftoverMatchingProcesses: [],
    };
  }
  const terminateStarted = Date.now();
  let sendError = null;
  try {
    process.kill(web.child.pid, 'SIGTERM');
  } catch (error) {
    sendError = error.message;
  }
  const closed = await Promise.race([
    web.exited,
    delay(20_000).then(() => null),
  ]);
  if (!closed) {
    try { web.child.kill('SIGKILL'); }
    catch {}
    await Promise.race([web.exited, delay(5_000)]);
  }
  const dshAlive = pidAlive(web.child.pid);
  const leftovers = matchingProcesses([runRoot, grokExecutable]);
  return {
    ...(sendError ? { sent: false, error: sendError } : {}),
    signalSent: 'SIGTERM',
    graceful: Boolean(closed),
    exitCode: web.exitCode,
    exitSignal: web.signal,
    durationMs: Date.now() - terminateStarted,
    dshAliveAfterExit: dshAlive,
    leftoverMatchingProcesses: leftovers,
  };
}

function compactEvent(event) {
  return {
    sessionId: event.sessionId,
    seq: event.seq,
    time: event.time,
    type: event.type,
    turn: event.data?.turn ?? null,
    step: event.data?.step ?? null,
    name: event.data?.name ?? null,
    reason: event.data?.reason ?? null,
    isError: event.data?.message?.isError ?? null,
    text: event.data?.message?.content
      ?.filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n') ?? null,
  };
}

async function linuxWorker(options) {
  const firstUse = options.firstUse === 'download';
  const runtimeFiles = folder => readdirSync(join(PROJECT_ROOT, folder), { withFileTypes: true })
    .flatMap(row => row.isDirectory() ? runtimeFiles(folder + '/' + row.name) : [folder + '/' + row.name]);
  const sourceHashesBefore = ['scripts/b3-cli-web.mjs', 'scripts/lib/renderer-cdp.mjs', 'fixtures/cli-web/fixture.mjs',
    'package.json', 'README.md', 'support-matrix.json', 'LICENSE', 'cordis.patch.yml', ...runtimeFiles('src')]
    .map(file => ({ file, sha256: sha256(join(PROJECT_ROOT, file)) }));
  const runId = options.runId ?? isoRunId(options.dshVersion);
  const runRoot = `/tmp/dsh-grok-cli-web-${runId}`;
  const dshHome = join(runRoot, 'dsh-home');
  const workspace = join(runRoot, 'workspace');
  const home = join(runRoot, 'home');
  const artifactDir = join(ARTIFACT_ROOT, runId);
  mkdirSync(ARTIFACT_ROOT, { recursive: true });
  if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: false });
  else if (!statSync(artifactDir).isDirectory()) throw new Error(`Artifact path is not a directory: ${artifactDir}`);
  if (!existsSync(runRoot)) mkdirSync(runRoot, { recursive: false });
  for (const path of [dshHome, workspace, home, join(runRoot, 'tmp'),
    join(runRoot, 'xdg-config'), join(runRoot, 'xdg-cache'), join(runRoot, 'xdg-data')]) {
    mkdirSync(path, { recursive: true });
  }

  const evidence = new Evidence(artifactDir, [
    [PROJECT_ROOT, '<PROJECT>'],
    [runRoot, '<RUN_ROOT>'],
    [dshHome, '<DSH_HOME>'],
    [workspace, '<WORKSPACE>'],
    [artifactDir, '<ARTIFACT_DIR>'],
    [options.dshCli, '<DSH_CLI_INPUT>'],
    [options.productPackage, '<PRODUCT_PACKAGE>'],
    [options.grokLinuxArchive, '<OFFICIAL_GROK_LINUX_ARCHIVE>'],
    [options.pnpmEntry, '<PNPM_ENTRY>'],
    [options.pnpmStore, '<HOST_PNPM_STORE>'],
    [options.pnpmCache, '<HOST_PNPM_CACHE>'],
    ...(options.browserExecutable ? [[options.browserExecutable, '<BROWSER_EXECUTABLE>']] : []),
  ]);
  const steps = [];
  const checks = [];
  const startedAt = new Date().toISOString();
  const packageReceiptPath = join(dirname(options.productPackage), 'package-receipt.json');
  let packageReceipt = null;
  let web = null;
  let auth = null;
  let ready = null;
  const webProcesses = [];
  let bootstrap = null;
  let failure = null;
  let termination = null;
  let officialStub = null;
  let grokResponsesStub = null;
  let grokExecutable = null;
  let grokConfigPath = null;
  let grokArchiveSha256 = null;
  let grokDirectProtocol = null;
  let grokRequestsAfterTakeover = null;
  let firstUseProgramReceipt = null;
  let lifecycleObservation = null;
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(runRoot, now, now);
      utimesSync(dshHome, now, now);
    } catch {}
  }, 20_000);
  heartbeat.unref();

  const check = (name, condition, details = null) => {
    const record = { name, status: condition ? 'pass' : 'fail', ...(details === null ? {} : { details }) };
    checks.push(record);
    if (!condition) throw new Error(`Check failed: ${name}${details === null ? '' : ` (${JSON.stringify(details)})`}`);
    return record;
  };
  const step = (name, observation) => {
    const record = { name, at: new Date().toISOString(), ...observation };
    steps.push(record);
    return record;
  };

  try {
    if (platform() !== 'linux' || arch() !== 'x64') {
      throw new Error(`Linux x64 is required, got ${platform()} ${arch()}.`);
    }
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    check('linux-node-22', nodeMajor >= 22, { node: process.versions.node });
    packageReceipt = JSON.parse(readFileSync(packageReceiptPath, 'utf8'));
    if (options.bootstrapFile && existsSync(options.bootstrapFile)) {
      bootstrap = JSON.parse(readFileSync(options.bootstrapFile, 'utf8'));
    }
    evidence.json('bootstrap.json', bootstrap ?? { createdBy: 'direct-linux-worker', note: 'No Windows bootstrap file.' });
    step('runtime', {
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.versions.node,
      distro: options.wslDistro ?? 'unknown',
    });

    const cliRoot = findInstallRoot(options.dshCli);
    const runtimeRoot = join(runRoot, 'cli-runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    const archive = options.stagedRuntimeArchive ?? join(runRoot, 'cli-runtime.tar');
    if (!options.stagedRuntimeArchive) {
      const staged = await runCaptured('stage-cli-runtime', 'tar', ['-cf', archive, '-C', cliRoot, '.'], {
        cwd: runRoot,
        env: process.env,
        timeoutMs: 300_000,
      }, evidence);
      check('stage-cli-runtime', staged.exitCode === 0 && !staged.timedOut, { exitCode: staged.exitCode });
    }
    check('runtime-archive-present', existsSync(archive), { archive: '<RUN_ROOT>/cli-runtime.tar' });
    const extracted = await runCaptured('extract-cli-runtime', 'tar', ['-xf', archive, '-C', runtimeRoot], {
      cwd: runRoot,
      env: process.env,
      timeoutMs: 120_000,
    }, evidence);
    check('extract-cli-runtime', extracted.exitCode === 0 && !extracted.timedOut, { exitCode: extracted.exitCode });
    const copiedCli = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    check('copied-cli-present', existsSync(copiedCli), { path: '<RUN_ROOT>/cli-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js' });

    check('official-linux-grok-archive-present',
      existsSync(options.grokLinuxArchive) && statSync(options.grokLinuxArchive).isFile(), {
        path: '<OFFICIAL_GROK_LINUX_ARCHIVE>',
      });
    grokArchiveSha256 = sha256(options.grokLinuxArchive);
    check('official-linux-grok-archive-sha256', grokArchiveSha256 === GROK_LINUX_X64_SHA256, {
      expected: GROK_LINUX_X64_SHA256,
      actual: grokArchiveSha256,
    });
    const grokArchiveList = await runCaptured('list-linux-grok-archive', 'tar', [
      '-tzf', options.grokLinuxArchive,
    ], {
      cwd: runRoot,
      env: process.env,
      timeoutMs: 30_000,
    }, evidence);
    check('official-linux-grok-archive-layout', grokArchiveList.exitCode === 0
      && grokArchiveList.stdout.split(/\r?\n/).includes('grok-search-rs'), {
      exitCode: grokArchiveList.exitCode,
      entries: grokArchiveList.stdout.split(/\r?\n/).filter(Boolean),
    });
    const grokDirectory = join(runRoot, 'grok');
    mkdirSync(grokDirectory, { recursive: false });
    const extractGrok = await runCaptured('extract-linux-grok', 'tar', [
      '-xzf', options.grokLinuxArchive, '-C', grokDirectory,
    ], {
      cwd: runRoot,
      env: process.env,
      timeoutMs: 30_000,
    }, evidence);
    check('extract-linux-grok', extractGrok.exitCode === 0 && !extractGrok.timedOut, {
      exitCode: extractGrok.exitCode,
    });
    grokExecutable = join(grokDirectory, 'grok-search-rs');
    check('linux-grok-executable-present', existsSync(grokExecutable)
      && statSync(grokExecutable).isFile(), {
      path: '<RUN_ROOT>/grok/grok-search-rs',
    });
    chmodSync(grokExecutable, 0o700);
    const grokVersion = await runCaptured('linux-grok-version', grokExecutable, ['--version'], {
      cwd: runRoot,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: join(runRoot, 'tmp'),
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? '',
        NO_COLOR: '1',
      },
      timeoutMs: 20_000,
    }, evidence);
    check('linux-grok-version', grokVersion.exitCode === 0
      && grokVersion.stdout.trim() === `grok-search-rs ${GROK_VERSION}`, {
      expected: `grok-search-rs ${GROK_VERSION}`,
      actual: grokVersion.stdout.trim(),
      exitCode: grokVersion.exitCode,
    });

    const npmEnv = {
      PATH: process.env.PATH,
      HOME: homedir(),
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? '',
      TMPDIR: join(runRoot, 'tmp'),
      npm_config_registry: REGISTRY,
      npm_config_store_dir: options.pnpmStore,
      npm_config_cache_dir: options.pnpmCache,
      CI: '1',
      NO_COLOR: '1',
    };
    const overlay = join(runRoot, 'linux-overlay');
    mkdirSync(overlay, { recursive: true });
    const nativeInstall = await runCaptured('install-linux-native', 'npm', [
      'install',
      '--prefix', overlay,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--prefer-offline',
      '--registry', REGISTRY,
      `${LINUX_NATIVE}@${LINUX_NATIVE_VERSION}`,
    ], {
      cwd: runRoot,
      env: npmEnv,
      timeoutMs: 180_000,
    }, evidence);
    check('install-linux-native', nativeInstall.exitCode === 0 && !nativeInstall.timedOut, {
      exitCode: nativeInstall.exitCode,
      package: `${LINUX_NATIVE}@${LINUX_NATIVE_VERSION}`,
    });
    const nativeSource = join(overlay, 'node_modules', LINUX_NATIVE);
    const nativeDestination = join(runtimeRoot, 'node_modules', LINUX_NATIVE);
    check('linux-native-package-present', existsSync(nativeSource), { package: LINUX_NATIVE });
    cpSync(nativeSource, nativeDestination, { recursive: true, errorOnExist: true, force: false });
    const nativeManifest = JSON.parse(readFileSync(join(nativeDestination, 'package.json'), 'utf8'));
    check('linux-native-version', nativeManifest.version === LINUX_NATIVE_VERSION, { version: nativeManifest.version });

    const systemNativePackDir = join(runRoot, 'system-native-pack');
    mkdirSync(systemNativePackDir, { recursive: true });
    const systemNativePack = await runCaptured('pack-linux-system-native', 'npm', [
      'pack',
      `${SYSTEM_NATIVE}@${SYSTEM_NATIVE_VERSION}`,
      '--pack-destination', systemNativePackDir,
      '--prefer-offline',
      '--registry', REGISTRY,
    ], {
      cwd: runRoot,
      env: npmEnv,
      timeoutMs: 180_000,
    }, evidence);
    check('pack-linux-system-native', systemNativePack.exitCode === 0
      && !systemNativePack.timedOut, {
      exitCode: systemNativePack.exitCode,
      package: `${SYSTEM_NATIVE}@${SYSTEM_NATIVE_VERSION}`,
    });
    const systemNativeTarballName = systemNativePack.stdout.trim().split(/\r?\n/).at(-1);
    const systemNativeTarball = join(systemNativePackDir, systemNativeTarballName);
    check('system-native-tarball', Boolean(systemNativeTarballName)
      && existsSync(systemNativeTarball), {
      name: systemNativeTarballName ?? null,
      sha256: existsSync(systemNativeTarball) ? sha256(systemNativeTarball) : null,
    });
    const systemNativeDestination = join(runtimeRoot, 'node_modules', '@deepseek-ai',
      'node-addon-system-linux-x64');
    mkdirSync(systemNativeDestination, { recursive: true });
    const systemNativeExtract = await runCaptured('extract-linux-system-native', 'tar', [
      '-xzf', systemNativeTarball, '-C', systemNativeDestination, '--strip-components=1',
    ], {
      cwd: runRoot,
      env: process.env,
      timeoutMs: 30_000,
    }, evidence);
    check('extract-linux-system-native', systemNativeExtract.exitCode === 0
      && !systemNativeExtract.timedOut, { exitCode: systemNativeExtract.exitCode });
    const systemNativeManifest = JSON.parse(readFileSync(
      join(systemNativeDestination, 'package.json'), 'utf8'));
    check('linux-system-native-version', systemNativeManifest.name === SYSTEM_NATIVE
      && systemNativeManifest.version === SYSTEM_NATIVE_VERSION, {
      name: systemNativeManifest.name,
      version: systemNativeManifest.version,
      path: '<RUN_ROOT>/cli-runtime/node_modules/@deepseek-ai/node-addon-system-linux-x64',
    });

    check('host-pnpm-entry-present', existsSync(options.pnpmEntry), {
      path: '<PNPM_ENTRY>',
    });
    const pnpmBinDir = join(runRoot, 'pnpm-bin');
    mkdirSync(pnpmBinDir, { recursive: true });
    const pnpmWrapper = join(pnpmBinDir, 'pnpm');
    writeFileSync(pnpmWrapper, [
      '#!/bin/sh',
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(options.pnpmEntry)} "$@"`,
      '',
    ].join('\n'));
    chmodSync(pnpmWrapper, 0o700);
    const pnpmVersion = await runCaptured('pnpm-version', pnpmWrapper, ['--version'], {
      cwd: runRoot,
      env: { ...npmEnv, PATH: `${pnpmBinDir}:${npmEnv.PATH}` },
      timeoutMs: 30_000,
    }, evidence);
    check('host-pnpm-version', pnpmVersion.exitCode === 0
      && pnpmVersion.stdout.trim() === DEFAULT_PNPM_VERSION, {
      expected: DEFAULT_PNPM_VERSION,
      actual: pnpmVersion.stdout.trim(),
      entry: '<PNPM_ENTRY>',
    });

    const nodeVersion = await runCaptured('node-version', process.execPath, ['--version'], {
      cwd: workspace, env: npmEnv, timeoutMs: 20_000,
    }, evidence);
    const npmVersion = await runCaptured('npm-version', 'npm', ['--version'], {
      cwd: workspace, env: npmEnv, timeoutMs: 20_000,
    }, evidence);
    const uname = await runCaptured('uname', 'uname', ['-srm'], {
      cwd: workspace, env: npmEnv, timeoutMs: 20_000,
    }, evidence);
    check('toolchain', nodeVersion.exitCode === 0 && npmVersion.exitCode === 0 && uname.exitCode === 0, {
      node: nodeVersion.stdout.trim(),
      npm: npmVersion.stdout.trim(),
      kernel: uname.stdout.trim(),
    });

    const dshEnv = {
      PATH: `${pnpmBinDir}:${firstUse ? '/usr/local/bin:/usr/bin:/bin' : process.env.PATH}`,
      HOME: home,
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? '',
      TERM: process.env.TERM ?? 'dumb',
      SHELL: '/bin/bash',
      TMPDIR: join(runRoot, 'tmp'),
      DSH_HOME: dshHome,
      XDG_CONFIG_HOME: join(runRoot, 'xdg-config'),
      XDG_CACHE_HOME: join(runRoot, 'xdg-cache'),
      XDG_DATA_HOME: join(runRoot, 'xdg-data'),
      npm_config_registry: REGISTRY,
      COREPACK_NPM_REGISTRY: REGISTRY,
      COREPACK_DEFAULT_TO_LATEST: '0',
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };
    const cliVersion = await runCaptured('dsh-version', process.execPath, [copiedCli, '--version'], {
      cwd: workspace, env: dshEnv, timeoutMs: 30_000,
    }, evidence);
    const expectedVersion = VERSIONS[options.dshVersion];
    check('dsh-version', cliVersion.exitCode === 0 && cliVersion.stdout.trim() === expectedVersion, {
      expected: expectedVersion,
      actual: cliVersion.stdout.trim(),
    });

    const productCopy = join(runRoot, 'product-package.tgz');
    copyFileSync(options.productPackage, productCopy, constants.COPYFILE_EXCL);
    const productSha256 = sha256(productCopy);
    check('product-package-copy', productSha256 === sha256(options.productPackage), {
      sha256: productSha256,
      size: statSync(productCopy).size,
    });

    const pluginInstall = await runCaptured('plugin-add', process.execPath, [
      copiedCli, 'plugin', '--profile', 'web', 'add', productCopy,
      '--offline',
      '--store-dir', options.pnpmStore,
      '--cache-dir', options.pnpmCache,
      '--ignore-scripts',
      '--config.auto-install-peers=false',
      '--registry', REGISTRY,
    ], {
      cwd: workspace,
      env: dshEnv,
      timeoutMs: 360_000,
    }, evidence);
    evidence.json('plugin-install-offline-source.json', {
      pnpmVersion: DEFAULT_PNPM_VERSION,
      pnpmSource: '<PNPM_ENTRY>',
      store: '<HOST_PNPM_STORE>',
      cache: '<HOST_PNPM_CACHE>',
      registry: REGISTRY,
      offline: true,
      ignoreScripts: true,
      autoInstallPeers: false,
    });
    check('plugin-add', pluginInstall.exitCode === 0 && !pluginInstall.timedOut, {
      exitCode: pluginInstall.exitCode,
      signal: pluginInstall.signal,
    });
    check('plugin-add-offline-cache-hit', !/fetch failed|ETIMEDOUT|ERR_PNPM_META_FETCH_FAIL/
      .test(pluginInstall.stdout + pluginInstall.stderr), {
      outputHasNetworkFailure: /fetch failed|ETIMEDOUT|ERR_PNPM_META_FETCH_FAIL/
        .test(pluginInstall.stdout + pluginInstall.stderr),
    });

    const profile = join(dshHome, 'profiles', 'web');
    const profilePackagePath = join(profile, 'package.json');
    mkdirSync(join(runRoot, 'xdg-config', 'pnpm'), { recursive: true });
    writeFileSync(join(runRoot, 'xdg-config', 'pnpm', 'config.yaml'), [
      `storeDir: ${options.pnpmStore}`,
      `cacheDir: ${options.pnpmCache}`,
      '',
    ].join('\n'));
    writeFileSync(join(profile, '.npmrc'), [
      `store-dir=${options.pnpmStore}`,
      `cache-dir=${options.pnpmCache}`,
      'auto-install-peers=false',
      'strict-peer-dependencies=false',
      '',
    ].join('\n'));
    const installedManifestPath = join(profile, 'node_modules', 'dsh-grok-search', 'package.json');
    check('profile-package', existsSync(profilePackagePath), {
      path: '<DSH_HOME>/profiles/web/package.json',
    });
    check('installed-product-package', existsSync(installedManifestPath), {
      path: '<DSH_HOME>/profiles/web/node_modules/dsh-grok-search/package.json',
    });
    let profilePackage = JSON.parse(readFileSync(profilePackagePath, 'utf8'));
    const installedManifest = JSON.parse(readFileSync(installedManifestPath, 'utf8'));
    evidence.json('profile-package-installed.json', profilePackage);
    evidence.json('installed-product-manifest.json', installedManifest);
    check('installed-product-version', installedManifest.name === 'dsh-grok-search'
      && installedManifest.version === packageReceipt.version, {
      name: installedManifest.name,
      version: installedManifest.version,
      expectedVersion: packageReceipt.version,
    });
    const installedProduct = join(profile, 'node_modules', 'dsh-grok-search');
    check('product-package-receipt-sha256', packageReceipt.sha256 === productSha256, {
      expected: packageReceipt.sha256, actual: productSha256,
    });
    const packageSourceHashes = packageReceipt.files.map(({ path }) => ({
      file: path,
      sha256: sha256(join(installedProduct, path)),
      sourceSha256: sha256(join(PROJECT_ROOT, path)),
    }));
    check('installed-product-files-match-current-source',
      packageSourceHashes.every(item => item.sha256 === item.sourceSha256), {
        files: packageSourceHashes.length,
      });
    evidence.json('package-source-hashes.json', packageSourceHashes);

    const baselineDump = await runCaptured('dump-config-installed', process.execPath, [
      copiedCli, '--profile', 'web', '--dump-config',
    ], {
      cwd: workspace, env: dshEnv, timeoutMs: 60_000,
    }, evidence);
    check('dump-config-installed', baselineDump.exitCode === 0 && !baselineDump.timedOut, {
      exitCode: baselineDump.exitCode,
    });
    const requiredIds = [
      'agent-default-model',
      'web',
      'web-search-deepseek',
      'web-fetch-http',
      'web-deepseek-api',
      'llm-deepseek',
      'llm-deepseek-account',
      'grok-search',
    ];
    const idPresence = Object.fromEntries(requiredIds.map(id => [id, findId(baselineDump.stdout, id)]));
    evidence.json('dump-config-id-presence.json', idPresence);
    const missingIds = Object.entries(idPresence).filter(([, present]) => !present).map(([id]) => id);
    check('dump-config-required-ids', missingIds.length === 0, { missingIds, idPresence });

    const fixtureDirectory = join(profile, 'node_modules', 'candidate-cli-web-fixture');
    const materializeFixture = () => {
      if (existsSync(fixtureDirectory)) return;
      mkdirSync(fixtureDirectory, { recursive: false });
      copyFileSync(join(PROJECT_ROOT, 'fixtures', 'cli-web', 'fixture.mjs'), join(fixtureDirectory, 'fixture.mjs'));
    const entries = {
      model: { apply: 'applyModel', inject: ['llm', 'tools'] },
      providers: { apply: 'applyProviders', inject: ['web'] },
      observer: {
        apply: 'applyObserver',
        inject: ['loader', 'profileContext', 'webServer', 'sessionController', 'connection', 'tools'],
      },
    };
    for (const [name, entry] of Object.entries(entries)) {
      writeFileSync(join(fixtureDirectory, `${name}.mjs`), [
        `export { ${entry.apply} as apply } from './fixture.mjs';`,
        `export const name = 'candidate-cli-web-${name}';`,
        `export const inject = ${JSON.stringify(entry.inject)};`,
        '',
      ].join('\n'));
    }
    writeFileSync(join(fixtureDirectory, 'cordis.patch.yml'), JSON.stringify([{
      insert: [
        { id: 'cli-web-fixture-model', name: 'candidate-cli-web-fixture/model' },
        { id: 'cli-web-fixture-providers', name: 'candidate-cli-web-fixture/providers' },
        { id: 'cli-web-fixture-observer', name: 'candidate-cli-web-fixture/observer' },
      ],
    }], null, 2) + '\n');
    writeFileSync(join(fixtureDirectory, 'package.json'), JSON.stringify({
      name: 'candidate-cli-web-fixture',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: {
        './package.json': './package.json',
        './cordis.patch.yml': './cordis.patch.yml',
        './model': './model.mjs',
        './providers': './providers.mjs',
        './observer': './observer.mjs',
      },
      engines: { dsh: expectedVersion },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2) + '\n');
    };
    materializeFixture();

    profilePackage.dependencies ??= {};
    profilePackage.dependencies['candidate-cli-web-fixture'] = '0.0.0';
    const previousBundles = Array.isArray(profilePackage.dsh?.profile?.bundles)
      ? profilePackage.dsh.profile.bundles : [];
    const productSelected = previousBundles.includes('dsh-grok-search');
    const bundles = [...new Set([
      ...previousBundles,
      ...(!productSelected ? ['dsh-grok-search'] : []),
      'candidate-cli-web-fixture',
    ])];
    profilePackage.dsh ??= {};
    profilePackage.dsh.profile ??= {};
    profilePackage.dsh.profile.bundles = bundles;
    const profileTemp = profilePackagePath + '.b3-cli-web.tmp';
    writeFileSync(profileTemp, JSON.stringify(profilePackage, null, 2) + '\n');
    renameSync(profileTemp, profilePackagePath);
    evidence.json('profile-package-configured.json', profilePackage);
    check('product-bundle-selected', bundles.includes('dsh-grok-search'), { bundles, addedByHarness: !productSelected });
    officialStub = await startOfficialSearchStub();
    evidence.json('official-search-stub-start.json', {
      baseURL: officialStub.baseURL,
      loopbackOnly: true,
      requests: officialStub.requests,
    });
    const readyPath = join(runRoot, 'ready.json');
    grokResponsesStub = await startGrokResponsesStub();
    const grokConfigDirectory = join(runRoot, 'grok-config');
    mkdirSync(grokConfigDirectory, { recursive: false });
    const directConfigPath = join(grokConfigDirectory, 'config.toml');
    writeFileSync(directConfigPath, [
      `grok_api_url = "${grokResponsesStub.baseUrl}"`,
      `grok_api_key = "${GROK_TEST_API_KEY}"`,
      'grok_model = "grok-4-1-fast-reasoning"',
      'web_search_enabled = true',
      '',
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    evidence.addSecret(GROK_TEST_API_KEY);
    evidence.json('grok-config-isolated.json', {
      path: '<RUN_ROOT>/grok-config/config.toml',
      keys: ['grok_api_url', 'grok_api_key', 'grok_model', 'web_search_enabled'],
      apiUrl: grokResponsesStub.baseUrl,
      apiKey: '<synthetic-key-redacted>',
      configPathPassedThroughGROK_SEARCH_CONFIG: true,
    });
    evidence.json('grok-responses-stub-start.json', {
      baseUrl: grokResponsesStub.baseUrl,
      loopbackOnly: true,
      requests: grokResponsesStub.requests,
    });
    const grokDirectProtocolCommand = await runGrokProtocolProbe({
      executable: grokExecutable,
      configPath: directConfigPath,
      home,
      tempDirectory: join(runRoot, 'tmp'),
      workspace,
    });
    grokDirectProtocol = grokDirectProtocolCommand;
    const grokRequestsAfterDirectProtocol = grokResponsesStub.requests.length;
    evidence.json('grok-direct-mcp-protocol.json', grokDirectProtocol);
    check('real-grok-mcp-initialize', grokDirectProtocol.serverInfo?.name === 'grok-search-rs'
      && grokDirectProtocol.serverInfo?.version === GROK_VERSION
      && grokDirectProtocol.process?.exitCode === 0
      && grokDirectProtocol.process?.gracefulStdioEof === true, {
      serverInfo: grokDirectProtocol.serverInfo,
      process: grokDirectProtocol.process,
    });
    check('real-grok-mcp-tools-list', grokDirectProtocol.tools?.includes('web_search') === true, {
      tools: grokDirectProtocol.tools,
    });
    check('real-grok-mcp-tools-call', grokDirectProtocol.call?.name === 'web_search'
      && grokDirectProtocol.call?.isError === false
      && grokDirectProtocol.call?.hasStructuredContent === true
      && grokDirectProtocol.call?.contentText?.includes(
        'Linux grok-search-rs 0.1.26 real MCP search succeeded.') === true, {
      call: grokDirectProtocol.call,
    });
    check('real-grok-direct-api-stub', grokResponsesStub.requests.length === 1
      && grokResponsesStub.requests[0].method === 'POST'
      && grokResponsesStub.requests[0].url === '/v1/responses'
      && grokResponsesStub.requests[0].authorizedWithSyntheticKey === true
      && grokResponsesStub.requests[0].tools.includes('web_search'), {
      requestCount: grokResponsesStub.requests.length,
      requests: grokResponsesStub.requests,
    });
    const grokDirectChildPid = grokDirectProtocol.process?.pid;
    check('real-grok-direct-process-reaped',
      Number.isSafeInteger(grokDirectChildPid) && !pidAlive(grokDirectChildPid), {
      childPid: grokDirectChildPid ?? null,
      alive: grokDirectChildPid ? pidAlive(grokDirectChildPid) : null,
      process: grokDirectProtocol.process,
    });

    grokConfigPath = firstUse ? join(home, '.config/grok-search-rs/config.toml') : directConfigPath;
    if (firstUse) check('first-use-default-config-absent', !existsSync(grokConfigPath));
    const profilePatch = [
      { id: 'agent-default-model', config: { provider: 'candidate-offline', model: 'fixture-native' } },
      {
        id: 'ui-settings-general',
        config: { welcomeNoticeVersion: '2026-09-28.1' },
      },
      { id: 'web', config: { searchProvider: 'deepseek-official', fetchProvider: 'candidate-fetch' } },
      {
        id: 'web-search-deepseek',
        disabled: false,
        config: {
          apiKey: 'offline-test-sentinel-not-a-real-key',
          baseURL: officialStub.baseURL,
          model: 'fixture-search',
          maxTokens: 1,
          maxUses: 1,
        },
      },
      { id: 'web-fetch-http', disabled: true },
      { id: 'web-deepseek-api', disabled: true },
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'agent-preset-registry', config: { default: 'cli-web-fixture' } },
      {
        insert: [{
          id: 'preset-cli-web-fixture',
          name: '@deepseek-ai/dsh-agent-preset',
          config: {
            id: 'cli-web-fixture',
            title: 'Linux CLI/Web isolated verification',
            plugins: [
              {
                id: 'persona',
                name: '@deepseek-ai/dsh-persona',
                config: {
                  prefix: 'Linux CLI/Web isolated verification',
                  complete: true,
                  includeRuntimeContext: false,
                },
              },
              {
                id: 'tool-web',
                name: '@deepseek-ai/dsh-tool-web',
                config: {
                  fetch: true,
                  searchTimeoutMs: 30_000,
                  fetchTimeoutMs: 30_000,
                },
              },
            ],
          },
        }],
      },
      ...(!firstUse ? [{
        id: 'grok-search',
        config: {
          executable: grokExecutable,
          executableArgs: [],
          configPath: grokConfigPath,
          budgetMs: 30_000,
        },
      }] : []),
    ];
    writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify(profilePatch, null, 2) + '\n');
    evidence.json('profile-patch-applied.json', profilePatch);

    const patchedDump = await runCaptured('dump-config-patched', process.execPath, [
      copiedCli, '--profile', 'web', '--dump-config',
    ], {
      cwd: workspace, env: dshEnv, timeoutMs: 60_000,
    }, evidence);
    check('dump-config-patched', patchedDump.exitCode === 0 && !patchedDump.timedOut, {
      exitCode: patchedDump.exitCode,
    });
    const fixtureIds = [
      'cli-web-fixture-model',
      'cli-web-fixture-providers',
      'cli-web-fixture-observer',
      'preset-cli-web-fixture',
    ];
    const fixturePresence = Object.fromEntries(fixtureIds.map(id => [id, findId(patchedDump.stdout, id)]));
    evidence.json('dump-config-fixture-id-presence.json', fixturePresence);
    check('dump-config-fixture-ids', Object.values(fixturePresence).every(Boolean), { fixturePresence });
    step('fixture-bundle', {
      package: 'candidate-cli-web-fixture',
      entries: fixtureIds,
      selectedBundles: bundles,
      officialSearchRow: {
        id: 'web-search-deepseek',
        baseURL: officialStub.baseURL,
        localOnly: true,
      },
      disabledRows: ['web-fetch-http', 'web-deepseek-api', 'llm-deepseek', 'llm-deepseek-account'],
      providers: { search: 'deepseek-official', fetch: 'candidate-fetch' },
      model: { provider: 'candidate-offline', model: 'fixture-native' },
      agentPreset: { registryDefault: 'cli-web-fixture', toolWeb: true },
      grokExecutable: '<RUN_ROOT>/grok/grok-search-rs',
      grokVersion: GROK_VERSION,
      grokConfigPath: firstUse ? '<RUN_ROOT>/home/.config/grok-search-rs/config.toml' : '<RUN_ROOT>/grok-config/config.toml',
      grokApiStub: grokResponsesStub.baseUrl,
    });

    let webSequence = 0;
    const startWeb = async label => {
      const sequence = ++webSequence;
      const suffix = sequence === 1 ? '' : `-${safeName(label)}`;
      const processReadyPath = sequence === 1 ? readyPath : join(runRoot, `ready-${sequence}.json`);
      const childEnv = {
        ...dshEnv,
        DSH_CLI_WEB_RUN_ID: runId,
        DSH_CLI_WEB_READY_FILE: processReadyPath,
        DSH_CLI_WEB_WORKSPACE: workspace,
      };
      const stdoutChunks = [];
      const stderrChunks = [];
      const child = spawn(process.execPath, [copiedCli, 'web', '--no-open', '--port', '0'], {
        cwd: workspace,
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const current = {
        label,
        sequence,
        child,
        stdout: '',
        stderr: '',
        startedAt: Date.now(),
        exitCode: null,
        signal: null,
        closed: false,
        stdoutChunks,
        stderrChunks,
      };
      web = current;
      webProcesses.push(current);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (current.stdout.length < 8 * 1024 * 1024) current.stdout += chunk;
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', chunk => {
        if (current.stderr.length < 8 * 1024 * 1024) current.stderr += chunk;
        stderrChunks.push(chunk);
      });
      current.exited = new Promise(resolvePromise => {
        child.once('close', (code, signal) => {
          current.closed = true;
          current.exitCode = code;
          current.signal = signal;
          current.endedAt = Date.now();
          resolvePromise({ code, signal });
        });
      });
      child.once('error', error => {
        current.spawnError = error.message;
      });
      evidence.recordExecution({
        label: `dsh-web-start${suffix}`,
        command: process.execPath,
        args: ['<COPIED_DSH_CLI>', 'web', '--no-open', '--port', '0'],
        cwd: '<WORKSPACE>',
        exitCode: null,
        signal: null,
        durationMs: null,
        note: 'Long-running process; final exit is recorded below.',
      });
      step(`dsh-web-start${suffix}`, {
        pid: child.pid,
        command: '<COPIED_DSH_CLI> web --no-open --port 0',
        browserOpenRequested: false,
      });

      const startup = await waitFor(() => {
        if (current.spawnError) throw new Error(current.spawnError);
        if (current.closed) throw new Error(`dsh web exited early with ${current.exitCode ?? current.signal}.`);
        const clean = current.stdout.replace(/\x1b\[[0-9;]*m/g, '');
        const match = clean.match(/(?:^|\n)dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+))/);
        const readyValue = existsSync(processReadyPath) ? JSON.parse(readFileSync(processReadyPath, 'utf8')) : null;
        return match && readyValue ? { match, readyValue } : null;
      }, 120_000, `dsh web startup URL and fixture readiness (${label})`);
      ready = startup.readyValue;
      const startupPort = Number(startup.match[2]);
      const startupToken = startup.match[3];
      evidence.addSecret(startupToken);
      evidence.addSecret(ready.probeToken);
      evidence.addSecret(ready.authUrl);
      const readyUrl = new URL(ready.authUrl);
      check(`startup-output-auth-url${suffix}`, startupPort === Number(readyUrl.port), {
        portFromOutput: startupPort,
        portFromReadyFile: readyUrl.port,
        loopback: readyUrl.hostname === '127.0.0.1',
      });
      check(`fixture-pid${suffix}`, ready.pid === child.pid, { readyPid: ready.pid, childPid: child.pid });
      evidence.json(`startup-observation${suffix}.json`, {
        stdout: current.stdout,
        ready: {
          runId: ready.runId,
          pid: ready.pid,
          probePort: ready.probePort,
          hostOrigin: ready.hostOrigin,
          authUrl: '<authenticated-url>',
          workspace: ready.workspace,
        },
        port: startupPort,
      });
      step(`dsh-web-ready${suffix}`, {
        pid: child.pid,
        port: startupPort,
        authUrlObservedIn: ['stdout', 'fixture-ready-file'],
        authUrlRedacted: true,
      });

      const authResponse = await fetch(ready.authUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const setCookies = authResponse.headers.getSetCookie?.()
        ?? (authResponse.headers.get('set-cookie') ? [authResponse.headers.get('set-cookie')] : []);
      const cookie = setCookies[0]?.split(';', 1)[0];
      check(`auth-token-exchange${suffix}`, authResponse.status === 303 && Boolean(cookie), {
        status: authResponse.status,
        location: authResponse.headers.get('location'),
      });
      evidence.addSecret(cookie);
      evidence.addSecret(cookie.slice(cookie.indexOf('=') + 1));
      auth = { cookie, hostOrigin: new URL(ready.authUrl).origin };
      return current;
    };
    const stopWeb = async label => {
      const current = web;
      const result = await terminateWebProcess(current, runRoot, grokExecutable);
      current.termination = result;
      step(`sigterm-cleanup-${label}`, result);
      check(`dsh-sigterm-exit-${label}`, result.graceful && !result.dshAliveAfterExit, {
        graceful: result.graceful,
        exitCode: result.exitCode,
        exitSignal: result.exitSignal,
      });
      check(`no-grok-child-residue-${label}`, result.leftoverMatchingProcesses.length === 0, {
        leftovers: result.leftoverMatchingProcesses,
      });
      return result;
    };
    await startWeb('initial');

    let rpcSequence = 0;
    const settingsCall = async (method, request, extraHeaders = {}, cookie = auth.cookie) => {
      const response = await fetch(`${auth.hostOrigin}/api/grokSearchSettings/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: auth.hostOrigin,
          ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
        body: JSON.stringify({ type: 'client-request', rpcId: `private-test-${++rpcSequence}`,
          method: `grokSearchSettings/${method}`, payload: { args: request === undefined ? {} : { request } } }),
        signal: AbortSignal.timeout(30000),
      });
      let value; try { value = await response.json(); } catch { value = {}; }
      return { status: response.status, ...value.result };
    };
    const rpc = async (label, endpoint, args) => {
      const rpcId = `${runId}-${safeName(label)}-${++rpcSequence}`;
      const payload = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload: { args },
      };
      const response = await fetch(`${auth.hostOrigin}/api/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: auth.hostOrigin,
          Cookie: auth.cookie,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); }
      catch { throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`); }
      evidence.json(`rpc-${label}.json`, {
        endpoint,
        status: response.status,
        request: payload,
        response: body,
      });
      if (response.status !== 200 || body?.result?.ok !== true) {
        throw new Error(`${label} failed with HTTP ${response.status}: ${JSON.stringify(body).slice(0, 1_000)}`);
      }
      return body.result.value;
    };

    const probeTimeouts = { 'reload-web-with-session-search': 60_000,
      'plugin-manager-set-bundle': 60_000, 'plugin-manager-remove': 120_000 };
    const probe = async (op = 'snapshot', args = {}) => {
      const response = await fetch(`http://127.0.0.1:${ready.probePort}/probe`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ready.probeToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ op, args }),
        signal: AbortSignal.timeout(probeTimeouts[op] ?? 15_000),
      });
      const body = await response.json();
      if (!response.ok || body?.ok !== true) {
        throw new Error(`Fixture probe ${op} failed: ${JSON.stringify(body).slice(0, 1_000)}`);
      }
      return body.value;
    };

    if (firstUse) {
      const firstProgram = await waitFor(async () => {
        const state = await probe();
        if (state.program?.phase === 'error') throw new Error('First-use program preparation: ' + JSON.stringify(state.program.error));
        return state.program?.phase === 'ready' ? state.program : null;
      }, 140000, 'first-use private program download');
      const cache = join(profile, 'grok-search/runtime-cache');
      check('first-use-private-program-auto-ready', firstProgram.program?.source === 'private-cache'
        && firstProgram.program.version === GROK_VERSION
        && firstProgram.program.path.startsWith(cache + '/')
        && firstProgram.configuration.executable === false && firstProgram.configuration.configPath === false
        && firstProgram.configPath === grokConfigPath, { program: firstProgram });
      check('first-use-config-still-absent-after-download', !existsSync(grokConfigPath));
      grokExecutable = firstProgram.program.path;
      firstUseProgramReceipt = JSON.parse(readFileSync(join(cache, 'active.json'), 'utf8'));
      check('first-use-cache-integrity-and-handshake', firstUseProgramReceipt.sha256 === sha256(grokExecutable)
        && firstUseProgramReceipt.mcpHandshakeValidated === true && firstUseProgramReceipt.credentialsValidated === false,
      { receipt: firstUseProgramReceipt });
      const current = await settingsCall('snapshot');
      check('first-use-default-settings-snapshot', current.ok === true && !current.value.config.exists
        && current.value.config.path === grokConfigPath && current.value.plugin.configSource === 'default');
      // This is the same authenticated settings API used by the production
      // dialog. The full Web DOM flow below separately exercises that dialog.
      const saved = await settingsCall('save', { expectedRevision: current.value.config.revision,
        updates: { grok_api_key: GROK_TEST_API_KEY, grok_api_url: grokResponsesStub.baseUrl } });
      check('first-use-shared-key-save', saved.ok === true
        && saved.value.config.fields.grok_api_key.configured
        && saved.value.config.fields.grok_api_key.source === 'file'
        && !JSON.stringify(saved.value).includes(GROK_TEST_API_KEY));
      check('first-use-no-manual-product-patch', !/grok-search/.test(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')));
      evidence.json('first-use-private-program.json', { program: firstProgram,
        receipt: firstUseProgramReceipt, configCreatedBySettingsSave: true, manualPathsRequired: false,
        realCredentialsUsed: false, paidUpstream: false });
    }

    const browserSettingsDom = async () => {
      const browserProfile = join(runRoot, 'browser-profile');
      mkdirSync(browserProfile, { recursive: false });
      const browserEnv = {
        ...dshEnv,
        HOME: home,
        TMPDIR: join(runRoot, 'tmp'),
        XDG_CONFIG_HOME: join(runRoot, 'xdg-config'),
        XDG_CACHE_HOME: join(runRoot, 'xdg-cache'),
        XDG_DATA_HOME: join(runRoot, 'xdg-data'),
      };
      const child = spawn(options.browserExecutable, [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${browserProfile}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        'about:blank',
      ], {
        cwd: workspace,
        env: browserEnv,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk; });
      child.stderr.on('data', chunk => { if (stderr.length < 4 * 1024 * 1024) stderr += chunk; });
      const exited = new Promise(resolvePromise => {
        child.once('close', (code, signal) => resolvePromise({ code, signal }));
      });
      let renderer = null;
      const startedAt = Date.now();
      try {
        const debug = await waitFor(() => {
          const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
          return match ? { port: Number(match[1]) } : null;
        }, 30_000, 'Linux browser DevTools endpoint');
        renderer = await connectRenderer(debug.port, { timeoutMs: 20_000 });
        await renderer.send('Page.enable');
        await renderer.send('Network.enable');
        const cookieName = auth.cookie.slice(0, auth.cookie.indexOf('='));
        const cookieValue = auth.cookie.slice(auth.cookie.indexOf('=') + 1);
        const cookieResult = await renderer.send('Network.setCookie', {
          name: cookieName,
          value: cookieValue,
          url: `${auth.hostOrigin}/`,
          path: '/',
          httpOnly: true,
          sameSite: 'Lax',
        });
        check('linux-settings-ui-browser-auth-cookie', cookieResult.success === true,
          { browserCookieAccepted: cookieResult.success === true });
        await renderer.evaluate(`setTimeout(() => location.assign(${JSON.stringify(`${auth.hostOrigin}/`)}), 0); true`);
        const initialPage = await waitForRenderer(renderer, current => current.evaluate(`(() => {
          const text = document.body?.innerText ?? '';
          if (document.readyState !== 'complete' || !text.trim()) return null;
          return {
            href: location.href,
            title: document.title,
            text,
            controls: [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],a')]
              .map(item => ({
                tag: item.tagName,
                text: (item.innerText || item.getAttribute('aria-label') || item.title || '').trim(),
                role: item.getAttribute('role'),
                visible: item.getClientRects().length > 0,
              }))
              .filter(item => item.text)
              .slice(0, 200),
          };
        })()`), { timeoutMs: 30_000 });
        evidence.json('linux-settings-initial-ui.json', initialPage);
        const workspaceSelection = await renderer.evaluate(`(() => {
          const controls = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],a')]
            .filter(item => item.getClientRects().length > 0);
          const target = controls.find(item =>
            /^(Choose workspace|选择工作区)$/.test((item.innerText || item.getAttribute('aria-label') || '').trim()));
          if (!target) return { clicked: false, text: '' };
          target.click();
          return { clicked: true, text: (target.innerText || target.getAttribute('aria-label') || '').trim() };
        })()`);
        evidence.json('linux-settings-workspace-selection.json', workspaceSelection);
        if (workspaceSelection.clicked) {
          const workspaceOpen = await waitForRenderer(renderer, current => current.evaluate(`(() => {
            const button = [...document.querySelectorAll('button,[role="button"]')]
              .find(item => item.getClientRects().length > 0
                && /^(Open|打开)$/.test((item.innerText || item.getAttribute('aria-label') || '').trim()));
            if (!button) return null;
            const observation = {
              text: (button.innerText || button.getAttribute('aria-label') || '').trim(),
              disabled: button.disabled === true,
            };
            if (observation.disabled) return null;
            button.click();
            return observation;
          })()`), { timeoutMs: 20_000 });
          evidence.json('linux-settings-workspace-open.json', workspaceOpen);
          await waitForRenderer(renderer, current => current.evaluate(`(() => {
            const text=document.body?.innerText ?? '';
            const picker=[...document.querySelectorAll('button,[role="button"]')].some(item =>
              item.getClientRects().length > 0 && /^(Open|打开)$/.test((item.innerText || '').trim()));
            return !picker && !/Choose a workspace to start|选择工作区以开始/.test(text) ? true : null;
          })()`), { timeoutMs: 30000 });
        }
        let shell;
        try {
          shell = await waitForRenderer(renderer, current => current.evaluate(`(() => {
            const text = document.body?.innerText ?? '';
            if (document.readyState !== 'complete' || !text.trim()) return null;
            const buttons = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')];
            const more = buttons.find(item => /^(Account menu|账号菜单)$/
              .test((item.getAttribute('aria-label') || item.innerText || '').trim()))
              ?? buttons.find(item => /^(More|更多)$/.test((item.innerText || '').trim()));
            return more ? {
              href: location.href,
              text,
              moreText: (more.innerText || more.getAttribute('aria-label') || '').trim(),
            } : null;
          })()`), { timeoutMs: 30_000 });
        } catch (error) {
          const diagnostic = await renderer.evaluate(`(() => ({
            href: location.href,
            title: document.title,
            readyState: document.readyState,
            text: document.body?.innerText ?? '',
            html: document.documentElement?.outerHTML?.slice(0, 20_000) ?? '',
          }))()`).catch(evaluateError => ({ evaluateError: evaluateError.message }));
          evidence.json('linux-settings-shell-failure.json', diagnostic);
          throw new Error(`Linux browser shell did not become ready: ${JSON.stringify(diagnostic).slice(0, 2_000)}`);
        }
        evidence.json('linux-settings-shell-ui.json', shell);
        // Plugins is a dedicated shell entry, not a tab inside General
        // Settings. Waiting for its own dialog avoids clicking behind an
        // unrelated settings modal during an asynchronous React transition.
        try {
          const sectionClick = await waitForRenderer(renderer, current => current.evaluate(`(() => {
          const section = [...document.querySelectorAll('button,[role="tab"]')]
            .find(item => item.getClientRects().length > 0 && /^(插件|Plugins)$/
                .test((item.getAttribute('aria-label') || item.innerText || '').trim()));
            if (!section) return null;
            const observation = {
              text: (section.innerText || section.getAttribute('aria-label') || '').trim(),
              controls: [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],a')]
                .map(item => ({
                  tag: item.tagName,
                  text: (item.innerText || item.getAttribute('aria-label') || item.title || '').trim(),
                  aria: item.getAttribute('aria-label'),
                  role: item.getAttribute('role'),
                  visible: item.getClientRects().length > 0,
                }))
                .filter(item => item.text || item.aria),
            };
            section.click();
            return observation;
          })()`),
          { timeoutMs: 20_000 });
          evidence.json('linux-settings-section-click-ui.json', sectionClick);
        } catch (error) {
          const diagnostic = await renderer.evaluate(`(() => ({
            href: location.href,
            title: document.title,
            text: document.body?.innerText ?? '',
            controls: [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],a')]
              .map(item => ({
                tag: item.tagName,
                text: (item.innerText || item.getAttribute('aria-label') || item.title || '').trim(),
                aria: item.getAttribute('aria-label'),
                role: item.getAttribute('role'),
                visible: item.getClientRects().length > 0,
              }))
              .filter(item => item.text || item.aria),
          }))()`);
          evidence.json('linux-settings-sections-failure.json', diagnostic);
          throw new Error(`Linux Settings sections did not render: ${JSON.stringify(diagnostic).slice(0, 2_000)}`);
        }
        await waitForRenderer(renderer, current => current.evaluate(`(() => {
          const text=document.body?.innerText ?? '';
          return !/Loading plugins|正在加载插件/i.test(text) && /插件管理|Plugin Manager|已安装|Installed/i.test(text)
            ? true : null;
        })()`), { timeoutMs: 30000 });
        try {
          await waitForRenderer(renderer, current => current.evaluate(`(() => {
          const tab = [...document.querySelectorAll('button,[role="button"]')]
            .find(item => item.getClientRects().length > 0
              && /^(查看|View) dsh-grok-search$/.test((item.getAttribute('aria-label') || '').trim()));
            if (!tab) return null;
            tab.click();
            return true;
          })()`),
          { timeoutMs: 10_000 });
        } catch (error) {
          const diagnostic = await renderer.evaluate(`(() => ({
            href: location.href,
            title: document.title,
            text: document.body?.innerText ?? '',
            controls: [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],a')]
              .map(item => ({
                tag: item.tagName,
                text: (item.innerText || item.getAttribute('aria-label') || item.title || '').trim(),
                aria: item.getAttribute('aria-label'),
                role: item.getAttribute('role'),
                visible: item.getClientRects().length > 0,
              }))
              .filter(item => item.text || item.aria),
            grokElements: [...document.querySelectorAll('*')]
              .filter(item => /Grok/.test((item.innerText || item.textContent || '').trim()))
              .slice(-30)
              .map(item => ({
                tag: item.tagName,
                id: item.id,
                role: item.getAttribute('role'),
                text: (item.innerText || item.textContent || '').trim().slice(0, 500),
              })),
          }))()`);
          evidence.json('linux-settings-grok-tab-failure.json', diagnostic);
          throw new Error(`Linux Grok settings tab did not render: ${JSON.stringify(diagnostic).slice(0, 2_000)}`);
        }
        const detail = await waitForRenderer(renderer, current => current.evaluate(`(() => {
          const detail = document.querySelector('[data-plugin-detail="dsh-grok-search"]');
          const root = detail?.querySelector('[data-dsg-route]')?.shadowRoot;
          const card = root?.querySelector('#routeCard');
          if (!card || !card.dataset.s || card.dataset.s === 'load') return null;
          const buttons = [...root.querySelectorAll('button,[role="button"]')]
            .map(item => ({
              text: (item.innerText || item.getAttribute('aria-label') || item.title || '').trim(),
              disabled: item.disabled === true || item.getAttribute('aria-disabled') === 'true',
              visible: item.getClientRects().length > 0,
            }))
            .filter(item => item.text);
          return {
            href: location.href,
            title: document.title,
            text: root.querySelector('.dsg-root')?.innerText ?? '',
            bodyText: document.body.innerText,
            buttons,
            error: root.querySelector('#routeCard')?.getAttribute('data-s') === 'cfgerr'
              ? root.querySelector('#bannerSlot')?.textContent?.trim() : null,
            state: root.querySelector('#routeCard')?.dataset.s ?? null,
          };
        })()`), { timeoutMs: 30_000 });
        evidence.json('linux-settings-grok-ui.json', detail);
        const screenshot = await renderer.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
        });
        writeFileSync(join(artifactDir, 'linux-settings-grok-ui.png'),
          Buffer.from(screenshot.data, 'base64'));
        const routeStage = Boolean(await renderer.evaluate(`Boolean(document.querySelector('[data-dsg-route]')
          ?.shadowRoot?.querySelector('#stage'))`));
        const providerRows = await renderer.evaluate(`document.querySelector('[data-dsg-route]')
          ?.shadowRoot?.querySelectorAll('.row[data-id]').length ?? 0`);
        check('linux-settings-ui-open', detail.href.startsWith(`${auth.hostOrigin}/`)
          && /插件|Plugins|dsh-grok-search/.test(detail.bodyText), {
          href: detail.href,
          title: detail.title,
        });
        check('linux-settings-ui-takeover', ['live', 'fallback', 'backup', 'wait', 'prep'].includes(detail.state), {
          text: detail.text,
        });
        check('linux-settings-ui-v74-route', routeStage && providerRows >= 6, {
          routeStage,
          providerRows,
          buttons: detail.buttons,
        });
        check('linux-settings-ui-no-error', detail.error === null, { error: detail.error });
        const q = selector => `(() => {
          const mounted = document.querySelector('[data-dsg-route]')?.shadowRoot?.querySelector(${JSON.stringify(selector)});
          if (mounted) return mounted;
          for (const host of document.querySelectorAll('[data-dsg-layer]')) {
            const found = host.shadowRoot?.querySelector(${JSON.stringify(selector)});
            if (found) return found;
          }
          return null;
        })()`;
        const click = selector => renderer.evaluate(`(() => {
          const element = ${q(selector)}; if (!element || element.disabled) return false;
          element.click(); return true;
        })()`);
        const current = await settingsCall('snapshot');
        check('linux-settings-secure-owner-snapshot', current.ok === true
          && current.value.capabilities.secretsAllowed === true && current.value.capabilities.transport === 'loopback');
        const revealed = await settingsCall('reveal', { key: 'grok_api_key' });
        check('linux-settings-explicit-reveal', revealed.ok === true && revealed.value.value === GROK_TEST_API_KEY);
        check('linux-settings-snapshot-redacted', !JSON.stringify(current.value).includes(GROK_TEST_API_KEY));
        const forwarded = await settingsCall('reveal', { key: 'grok_api_key' }, { 'X-Forwarded-Proto': 'https' });
        check('linux-settings-forwarded-facts-not-trusted', forwarded.ok !== true
          && forwarded.error?.code === 'SETTINGS_SECURE_CONNECTION_REQUIRED'
          && !JSON.stringify(forwarded).includes(GROK_TEST_API_KEY));
        const unauthenticated = await settingsCall('reveal', { key: 'grok_api_key' }, {}, '');
        check('linux-settings-no-owner-denied', [401, 403].includes(unauthenticated.status));
        check('linux-settings-dialog-open', await click('.row[data-id=grok] .row-main'));
        await waitForRenderer(renderer, current => current.evaluate(`Boolean(${q('input[data-k=model]')})`));
        check('linux-settings-key-hidden-in-input', await renderer.evaluate(`${q('input[data-k=key')}?.value === ''`));
        check('linux-settings-eye-click', await click('[data-a=eye][data-k=key]'));
        await waitForRenderer(renderer, current => current.evaluate(`${q('input[data-k=key')}?.type === 'text'
          && ${q('input[data-k=key')}?.value === ${JSON.stringify(GROK_TEST_API_KEY)}`));
        check('linux-settings-reveal-pristine', await renderer.evaluate(`${q('[data-a=save]')}?.disabled === true`));
        check('linux-settings-fill-model', await renderer.evaluate(`(() => {
          const input=${q('input[data-k=model]')}; if (!input) return false;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'grok-ui-offline-model');
          input.dispatchEvent(new Event('input',{bubbles:true,composed:true})); return true;
        })()`));
        check('linux-settings-save-via-production-adapter', await click('[data-a=save]'));
        await waitForRenderer(renderer, current => current.evaluate(`${q('#overlay')}?.hidden === true`));
        const saved = await settingsCall('snapshot');
        check('linux-settings-save-shared-readback', saved.ok === true
          && saved.value.config.fields.grok_model.value === 'grok-ui-offline-model');
        check('linux-settings-history-undo-click', await click('.t-act'));
        await waitFor(async () => {
          const state = await settingsCall('snapshot');
          return state.ok && state.value.config.fields.grok_model.value === current.value.config.fields.grok_model.value ? true : null;
        }, 15000, 'history undo restores shared model');
        await waitForRenderer(renderer, current => current.evaluate(`!${q('.dsg-root')}?.classList.contains('is-busy')`));
        // Shared history restore may settle before its UI finally block.
        // Wait for the visible undo toast; do not click into that busy frame.
        await waitForRenderer(renderer, current => current.evaluate(`Boolean(${q('.t-text')}
          ?.textContent?.includes('已恢复'))`));
        check('linux-settings-history-undo-verified', true);
        check('linux-settings-TinyFish-open', await click('.row[data-id=tinyfish] .row-main'));
        await waitForRenderer(renderer, current => current.evaluate(`Boolean(${q('input[data-k=searchUrl]')})`));
        check('linux-settings-TinyFish-double-url', await renderer.evaluate(`Boolean(${q('input[data-k=searchUrl]')})
          && Boolean(${q('input[data-k=fetchUrl]')})`));
        check('linux-settings-TinyFish-unconfigured-switch', await renderer.evaluate(`${q('.head-switch .switch')}
          ?.getAttribute('aria-checked') === 'false'`));
        await click('[data-a=cancel]');
        step('browser-settings-dom', {
          browser: '<BROWSER_EXECUTABLE>',
          href: detail.href,
          title: detail.title,
          settingsText: detail.text,
          routeStage,
          providerRows,
          screenshot: 'linux-settings-grok-ui.png',
        });
        return detail;
      } finally {
        renderer?.close();
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        const graceful = await Promise.race([exited, delay(5_000).then(() => null)]);
        if (graceful === null) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          await Promise.race([exited, delay(2_000)]);
        }
        const result = await Promise.race([exited, Promise.resolve({ code: null, signal: 'running' })]);
        evidence.text('logs/linux-browser.stdout.log', stdout);
        evidence.text('logs/linux-browser.stderr.log', stderr);
        evidence.recordExecution({
          label: 'linux-browser-settings-dom',
          command: options.browserExecutable,
          args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
            '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
          cwd: '<WORKSPACE>',
          exitCode: result.code,
          signal: result.signal,
          durationMs: Date.now() - startedAt,
        });
      }
    };

    const initial = await waitFor(async () => {
      const value = await probe();
      return value.runtimeWeb?.searchProviderId === 'grok-search'
        && value.control?.phase === 'required' ? value : null;
    }, 45_000, 'product route takeover');
    evidence.json('snapshot-route-takeover.json', initial);
    check('route-takeover', initial.runtimeWeb.searchProviderId === 'grok-search'
      && initial.control.phase === 'required', {
      searchProviderId: initial.runtimeWeb.searchProviderId,
      controlPhase: initial.control.phase,
    });
    check('fetch-route-preserved-before-query', initial.runtimeWeb.fetchProviderId === 'candidate-fetch', {
      fetchProviderId: initial.runtimeWeb.fetchProviderId,
    });
    check('canonical-counter-at-takeover', initial.originalSearchCounter?.source
      === 'dsh-session/web-deepseek-search-llm-request'
      && initial.originalSearchCounter?.eventType === 'web/deepseek-search-llm-request'
      && initial.originalSearchCounter?.calls === 0, {
      completionCommitted: initial.control.completionCommitted,
      routeVerified: initial.control.routeVerified,
      originalSearchCounter: initial.originalSearchCounter,
    });
    check('official-provider-not-dispatched-at-takeover', officialStub.requests.length === 0
      && initial.fixtureObservedOfficialEvents === 0, {
      stubRequestCount: officialStub.requests.length,
      fixtureObservedOfficialEvents: initial.fixtureObservedOfficialEvents,
    });

    const created = await rpc('session-create', 'session/create', {
      request: { cwd: workspace },
    });
    check('session-create', typeof created?.sessionId === 'string' && created.sessionId.length > 0, {
      sessionId: created?.sessionId ?? null,
    });
    auth.sessionId = created.sessionId;

    const runTurn = async (label, text, expectedTool, expectedError = false) => {
      const before = await probe();
      const beforeEvents = before.sessionEvents.length;
      const beforeCompleted = before.completed;
      const requestId = `${runId}-prompt-${safeName(label)}-${++rpcSequence}`;
      await rpc(`prompt-${label}`, 'session/prompt', {
        request: {
          requestId,
          sessionId: auth.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
      });
      let after;
      try {
        after = await waitFor(async () => {
          const value = await probe();
          const events = value.sessionEvents.slice(beforeEvents)
            .filter(event => event.sessionId === auth.sessionId);
          const ended = [...events].reverse().find(event =>
            event.type === 'turn/end' && event.data?.reason?.kind === 'completed');
          const failed = [...events].reverse().find(event =>
            event.type === 'turn/end' && event.data?.reason?.kind === 'error');
          if (failed) throw new Error(`${label} turn failed: ${JSON.stringify(failed.data.reason)}`);
          return ended && value.completed > beforeCompleted ? { value, events, ended } : null;
        }, 45_000, `${label} turn completion`);
      } catch (error) {
        const current = await probe().catch(probeError => ({ probeError: probeError.message }));
        evidence.json(`turn-${label}-timeout.json`, {
          prompt: text,
          beforeEvents,
          beforeCompleted,
          current,
          promptRequestId: requestId,
        });
        throw error;
      }
      const turn = after.ended.data.turn;
      const turnEvents = after.events.filter(event => event.data?.turn === turn);
      const toolCall = turnEvents.find(event => event.type === 'tool/call');
      const toolResult = [...turnEvents].reverse().find(event => event.type === 'tool/result');
      const assistant = [...turnEvents].reverse().find(event => event.type === 'assistant/message');
      if (expectedTool) {
        check(`${label}-tool-call`, toolCall?.data?.name === expectedTool, {
          expected: expectedTool,
          actual: toolCall?.data?.name ?? null,
        });
        check(`${label}-tool-result`, Boolean(toolResult) && (toolResult.data?.message?.isError === true) === expectedError, {
          isError: toolResult?.data?.message?.isError ?? null,
        });
      } else {
        check(`${label}-no-tool`, !toolCall, { actualTool: toolCall?.data?.name ?? null });
      }
      evidence.json(`turn-${label}.json`, {
        prompt: text,
        turn,
        events: turnEvents.map(compactEvent),
        snapshot: after.value,
      });
      return {
        turn,
        toolCall: toolCall ? compactEvent(toolCall) : null,
        toolResult: toolResult ? compactEvent(toolResult) : null,
        assistant: assistant ? compactEvent(assistant) : null,
        snapshot: after.value,
        events: turnEvents,
      };
    };

    await waitFor(async () => {
      const value = await probe();
      if (value.program?.phase === 'error') throw new Error('Isolated Grok program: ' + JSON.stringify(value.program.error));
      return value.program?.phase === 'ready' ? true : null;
    }, 30000, 'isolated Grok program ready');
    const searchTurn = await runTurn('search', 'search', 'web_search');
    check('search-result', searchTurn.toolResult?.text?.includes(
      'Linux grok-search-rs 0.1.26 real MCP search succeeded.'), {
      text: searchTurn.toolResult?.text ?? null,
    });
    check('search-route', searchTurn.snapshot.runtimeWeb.searchProviderId === 'grok-search', {
      searchProviderId: searchTurn.snapshot.runtimeWeb.searchProviderId,
    });
    check('official-provider-not-called-during-takeover-search', officialStub.requests.length === 0,
      { officialStubRequests: officialStub.requests.length });
    check('canonical-counter-zero-during-takeover-search',
      searchTurn.snapshot.originalSearchCounter?.calls === 0, {
        originalSearchCounter: searchTurn.snapshot.originalSearchCounter,
    });
    const grokDiagnostic = searchTurn.snapshot.core?.lastDiagnostic ?? null;
    check('real-grok-mcp-process-search', grokDiagnostic?.serverVersion === GROK_VERSION
      && grokDiagnostic?.exited === false && grokDiagnostic?.fallbackUsed !== true
      && typeof grokDiagnostic?.sdkEntry === 'string'
      && grokDiagnostic.sdkEntry.includes('@modelcontextprotocol/client'), {
      diagnostic: grokDiagnostic,
    });
    const grokPid = grokDiagnostic?.childPid;
    check('real-grok-mcp-search-session-reused', Number.isSafeInteger(grokPid) && pidAlive(grokPid)
      && searchTurn.snapshot.core?.session?.connected === true
      && searchTurn.snapshot.core?.session?.active === false, {
      childPid: grokPid ?? null,
      alive: grokPid ? pidAlive(grokPid) : null,
      diagnostic: grokDiagnostic,
    });
    const productGrokRequests = grokResponsesStub.requests.slice(grokRequestsAfterDirectProtocol);
    check('real-grok-product-search-request', productGrokRequests.length === 1
      && productGrokRequests[0].method === 'POST'
      && productGrokRequests[0].url === '/v1/responses'
      && productGrokRequests[0].authorizedWithSyntheticKey === true
      && productGrokRequests[0].tools.includes('web_search')
      && productGrokRequests[0].query.includes('内部候选离线查询'), {
      requests: productGrokRequests,
    });
    check('real-grok-product-search-result', searchTurn.toolResult?.text?.includes(
      'Linux grok-search-rs 0.1.26 real MCP search succeeded.'), {
      text: searchTurn.toolResult?.text ?? null,
    });
    if (firstUse) {
      const activePath = join(profile, 'grok-search/runtime-cache/active.json'), cacheHash = sha256(activePath);
      const second = await runTurn('first-use-repeat-search', 'search', 'web_search');
      check('first-use-sequential-query-reuses-process', second.snapshot.core?.lastDiagnostic?.childPid === grokPid
        && second.toolResult?.isError !== true && officialStub.requests.length === 0);
      const off = await rpc('first-use-native-disable', 'pluginManager/setBundleEnabled', {
        name: 'dsh-grok-search', enabled: false,
      });
      check('first-use-disable-hot-applied', off.application === 'applied' && off.error == null);
      await waitFor(async () => {
        const state = await probe();
        return state.runtimeWeb?.searchProviderId === 'deepseek-official' && !state.program ? true : null;
      }, 15000, 'first-use hot stop and process reap');
      check('first-use-disable-reaps-owned-program', !pidAlive(grokPid) && officialStub.requests.length === 0);
      const on = await rpc('first-use-native-reenable', 'pluginManager/setBundleEnabled', {
        name: 'dsh-grok-search', enabled: true,
      });
      check('first-use-reenable-hot-applied', on.application === 'applied' && on.error == null);
      const reacquired = await waitFor(async () => {
        const state = await probe();
        if (state.program?.phase === 'error') throw new Error('First-use cache reuse failed.');
        return state.program?.phase === 'ready' && state.control?.phase === 'required' ? state : null;
      }, 30000, 'first-use cache reuse and route reacquisition');
      check('first-use-cache-reused-without-redownload', reacquired.program.program.path === grokExecutable
        && sha256(activePath) === cacheHash);
      const third = await runTurn('first-use-reenabled-search', 'search', 'web_search');
      check('first-use-reenabled-search-no-official-fallback', third.toolResult?.isError !== true
        && third.snapshot.runtimeWeb.searchProviderId === 'grok-search' && officialStub.requests.length === 0);
    }
    grokRequestsAfterTakeover = grokResponsesStub.requests.length;

    const fetchTurn = await runTurn('fetch', 'fetch', 'web_fetch');
    check('fetch-result', fetchTurn.toolResult?.text?.includes('离线 fetch 保持'), {
      text: fetchTurn.toolResult?.text ?? null,
    });
    check('fetch-route', fetchTurn.snapshot.runtimeWeb.fetchProviderId === 'candidate-fetch'
      && fetchTurn.snapshot.calls.fetch >= 1, {
      fetchProviderId: fetchTurn.snapshot.runtimeWeb.fetchProviderId,
      fetchCalls: fetchTurn.snapshot.calls.fetch,
    });

    const chatTurn = await runTurn('chat', 'chat', null);
    check('chat-result', chatTurn.assistant?.text === '内部候选轮次完成', {
      text: chatTurn.assistant?.text ?? null,
    });

    if (options.case === 'full') {
      const officialRequestsBeforeReload = officialStub.requests.length;
      const grokRequestsBeforeReload = grokResponsesStub.requests.length;
      const reloadState = await probe('reload-web-with-session-search', {
        origin: auth.hostOrigin,
        cookie: auth.cookie,
        sessionId: auth.sessionId,
        requestId: `${runId}-reload-search-${++rpcSequence}`,
      });
      evidence.json('snapshot-config-reload-transition.json', reloadState);
      const officialRequestsDuringReload = officialStub.requests.length - officialRequestsBeforeReload;
      const grokRequestsDuringReload = grokResponsesStub.requests.length - grokRequestsBeforeReload;
      check('config-reload-no-official-fallback', officialRequestsDuringReload === 0
        && reloadState.originalSearchCounter?.calls === 0
        && reloadState.runtimeWeb?.searchProviderId === 'grok-search', {
          officialRequestsBeforeReload,
          officialRequestsDuringReload,
          originalSearchCounter: reloadState.originalSearchCounter,
          searchProviderId: reloadState.runtimeWeb?.searchProviderId ?? null,
        });
      check('config-reload-search-served-by-grok', reloadState.reloadProbe?.toolResult?.isError === true
        || grokRequestsDuringReload >= 1, {
          grokRequestsDuringReload,
          toolResultIsError: reloadState.reloadProbe?.toolResult?.isError ?? null,
        });
      check('config-reload-search-overlapped', reloadState.reloadProbe?.overlappedReload === true
        && Boolean(reloadState.reloadProbe?.toolResult), {
          reloadProbe: reloadState.reloadProbe,
        });
      if (reloadState.reloadProbe?.toolResult?.isError) {
        check('config-reload-error-explicit', /CONTROL_|WEB_PROVIDER_|GROK_/i
          .test(JSON.stringify(reloadState.reloadProbe.toolResult)), {
            toolResult: reloadState.reloadProbe.toolResult,
          });
      }
      grokRequestsAfterTakeover = grokResponsesStub.requests.length;
    }
    step('conversation-flow', {
      search: {
        turn: searchTurn.turn,
        tool: 'web_search',
        result: searchTurn.toolResult?.text,
        provider: searchTurn.snapshot.runtimeWeb.searchProviderId,
      },
      fetch: {
        turn: fetchTurn.turn,
        tool: 'web_fetch',
        result: fetchTurn.toolResult?.text,
        provider: fetchTurn.snapshot.runtimeWeb.fetchProviderId,
      },
      chat: { turn: chatTurn.turn, completed: true },
      officialStubRequests: officialStub.requests.length,
      grokResponsesRequests: grokResponsesStub.requests.length,
      canonicalCounter: chatTurn.snapshot.originalSearchCounter,
    });

    await browserSettingsDom();

    if (options.case === 'full') {
      const originalText = readFileSync(grokConfigPath, 'utf8');
      const originalPreferences = await settingsCall('preferences');
      check('sources-only-preferences-read', originalPreferences.ok === true);
      const received = [];
      let invalidFirstSource = false;
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { if (body.length < 65536) body += chunk; });
        request.on('end', () => {
          const tavily = request.url === '/tavily/search';
          const valid = request.method === 'POST' && (tavily
            ? request.headers.authorization === `Bearer ${GROK_TEST_API_KEY}`
            : request.url === '/search' && request.headers['x-api-key'] === GROK_TEST_API_KEY);
          received.push({ method: request.method, path: request.url, valid });
          response.writeHead(valid ? 200 : 400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ results: [{ url: invalidFirstSource && !tavily ? 'https://[invalid-source'
            : tavily ? 'https://example.invalid/linux-source-failover' : 'https://example.invalid/linux-sources-only',
            title: '隔离补充来源', summary: '测试摘要'.repeat(20000) }] }));
        });
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      try {
        const cfg = await settingsCall('snapshot');
        const saved = await settingsCall('save', { expectedRevision: cfg.value.config.revision,
          updates: { exa_api_key: GROK_TEST_API_KEY, exa_api_url: `http://127.0.0.1:${server.address().port}`,
            exa_enabled: true, tavily_api_key: GROK_TEST_API_KEY,
            tavily_api_url: `http://127.0.0.1:${server.address().port}/tavily`,
            tavily_enabled: true, source_providers: ['exa', 'tavily'], response_max_chars: 5000 } });
        check('sources-only-shared-save', saved.ok === true);
        const switched = await settingsCall('savePreferences', { expectedRevision: originalPreferences.value.revision,
          value: { ...originalPreferences.value.value, grokEnabled: false } });
        check('sources-only-disable-grok', switched.ok === true);
        const officialBefore = officialStub.requests.length, grokBefore = grokResponsesStub.requests.length;
        const turn = await runTurn('sources-only-search', 'search', 'web_search');
        const result = await probe('product-query-result');
        check('sources-only-real-result', turn.toolResult?.isError !== true
          && result.sources[0]?.url === 'https://example.invalid/linux-sources-only'
          && received.length > 0 && received.every(row => row.valid));
        check('sources-only-shared-budget', JSON.stringify(result).length <= 5000 && result.truncated === true,
          { maxChars: 5000, serializedChars: JSON.stringify(result).length });
        check('sources-only-no-grok-or-official', grokResponsesStub.requests.length === grokBefore
          && officialStub.requests.length === officialBefore);
        invalidFirstSource = true;
        const failoverStart = received.length;
        const recovered = await probe('product-query-result');
        check('invalid-source-URL-falls-through-to-next-provider',
          recovered.sources[0]?.url === 'https://example.invalid/linux-source-failover'
          && JSON.stringify(received.slice(failoverStart).map(row => row.path)) === '["/search","/tavily/search"]');
        check('invalid-source-URL-failover-keeps-original-unused',
          grokResponsesStub.requests.length === grokBefore && officialStub.requests.length === officialBefore);
        const count = received.length;
        writeFileSync(grokConfigPath, 'exa_api_key = invalid-TOML\n');
        const broken = await runTurn('sources-only-broken-config', 'search', 'web_search', true);
        check('sources-only-invalid-config-explicit-no-fallback', broken.toolResult?.isError === true
          && received.length === count && officialStub.requests.length === officialBefore);
      } finally {
        writeFileSync(grokConfigPath, originalText);
        const currentPrefs = await settingsCall('preferences');
        if (currentPrefs.ok) {
          const restored = await settingsCall('savePreferences', { expectedRevision: currentPrefs.value.revision,
            value: originalPreferences.value.value });
          check('sources-only-restores-private-switches', restored.ok === true);
        }
        await new Promise(resolve => server.close(resolve));
      }
    }

    if (options.case === 'stop' || options.case === 'full') {
      const settingsBefore = await rpc('settings-snapshot-before-stop', 'grokSearchSettings/snapshot', {});
      check('settings-snapshot-before-stop', settingsBefore.control?.phase === 'required'
        && settingsBefore.control?.canStop === true, { phase: settingsBefore.control?.phase,
          canStop: settingsBefore.control?.canStop });
      const nativeDisable = await rpc('native-bundle-disable', 'pluginManager/setBundleEnabled', {
        name: 'dsh-grok-search', enabled: false,
      });
      check('native-hot-disable-applied', nativeDisable.application === 'applied' && nativeDisable.error == null,
        { application: nativeDisable.application, error: nativeDisable.error ?? null });
      const releasedEnvelope = await waitFor(async () => {
        const value = await probe('read-control-record');
        return value?.intent?.releaseCompletion?.routeVerified ? value : null;
      }, 15000, 'native bundle release completion');
      const releasedIntent = releasedEnvelope.intent;
      evidence.json('native-release-envelope.json', releasedEnvelope);
      const stopValue = { outcome: { kind: 'released', completionCommitted: true, routeVerified: true,
        routeChanged: releasedIntent.releaseCompletion.routeChanged,
        routeReceipt: releasedIntent.releaseCompletion.routeEvidence } };
      evidence.json('native-release-evidence.json', {
        nativeDisable, releaseEnvelope: releasedEnvelope, interpretation: stopValue,
        interpretationIsRpcResult: false, hostReleaseCompletionReceiptValidated: false,
      });
      check('stop-response', stopValue?.outcome?.completionCommitted === true
        && stopValue?.outcome?.routeVerified === true, {
        outcomeKind: stopValue?.outcome?.kind ?? null,
        completionCommitted: stopValue?.outcome?.completionCommitted ?? null,
        routeVerified: stopValue?.outcome?.routeVerified ?? null,
        routeChanged: stopValue?.outcome?.routeChanged ?? null,
      });
      const stopped = await waitFor(async () => {
        const value = await probe();
        return value.runtimeWeb?.searchProviderId === 'deepseek-official' ? value : null;
      }, 15_000, 'official DeepSeek author route restoration');
      evidence.json('snapshot-after-stop.json', stopped);
      check('route-restored-after-stop', stopped.runtimeWeb.searchProviderId === 'deepseek-official'
        && stopped.control === null && stopped.entries.every(entry => entry.id !== 'grok-search'), {
        searchProviderId: stopped.runtimeWeb.searchProviderId,
        controlPhase: stopped.control?.phase ?? null,
      });
      check('official-provider-not-called-by-stop', officialStub.requests.length === 0, {
        officialStubRequests: officialStub.requests.length,
      });
      const baselineCounter = releasedIntent.releaseCompletion.routeEvidence;
      check('canonical-counter-baseline', baselineCounter?.counterSource
        === 'dsh-session/web-deepseek-search-llm-request'
        && baselineCounter?.originalSearchCalls === 0 && baselineCounter.originalSearchDelta === 0,
      { baselineCounter, productCounterAfterUnload: stopped.originalSearchCounter });
      const stopRouteReceipt = stopValue?.outcome?.routeReceipt ?? null;
      const stopCounterSource = stopRouteReceipt?.counterSource
        ?? stopRouteReceipt?.routeEvidence?.counterSource
        ?? null;
      check('stop-route-receipt-canonical-counter',
        stopCounterSource === 'dsh-session/web-deepseek-search-llm-request', {
          routeReceipt: stopRouteReceipt,
          counterSource: stopCounterSource,
      });
      check('completion-and-route-verified-separate', stopValue.outcome.completionCommitted === true
        && stopValue.outcome.routeVerified === true && releasedIntent.policy === 'released'
        && releasedIntent.releaseCompletion.routeVerified === true, {
        stopOutcome: {
          completionCommitted: stopValue.outcome.completionCommitted,
          routeVerified: stopValue.outcome.routeVerified,
          routeChanged: stopValue.outcome.routeChanged,
        },
        publicSnapshot: {
          completionCommitted: Boolean(releasedIntent.releaseCompletion),
          routeVerified: releasedIntent.releaseCompletion.routeVerified,
          routeChanged: releasedIntent.releaseCompletion.routeChanged ?? null,
        },
      });

      const restoredSearch = await runTurn('post-stop-search', 'search', 'web_search');
      check('post-stop-search-result',
        restoredSearch.toolResult?.isError !== true
          && (restoredSearch.toolResult?.text?.includes('Official counter fixture')
            || restoredSearch.toolResult?.text?.includes('https://example.invalid/official-counter')), {
        text: restoredSearch.toolResult?.text ?? null,
        isError: restoredSearch.toolResult?.isError ?? null,
      });
      check('post-stop-route', restoredSearch.snapshot.runtimeWeb.searchProviderId === 'deepseek-official', {
        searchProviderId: restoredSearch.snapshot.runtimeWeb.searchProviderId,
      });
      check('post-stop-real-official-provider-dispatched', officialStub.requests.length > 0
        && officialStub.requests.some(request => request.method === 'POST'
          && request.url?.endsWith('/messages')), {
        officialStubRequests: officialStub.requests,
      });
      // The product counter leaves with the disabled bundle. The persisted
      // release receipt is its last authoritative window; a separate fixture
      // listener observes the real canonical event for this positive control.
      // Never label a nonexistent post-unload product service as still alive.
      const finalCounter = restoredSearch.snapshot.originalSearchCounter;
      check('post-stop-product-observer-unmounted', finalCounter === null);
      check('post-stop-canonical-observer-positive-control',
        restoredSearch.snapshot.fixtureObservedOfficialEvents > stopped.fixtureObservedOfficialEvents,
      { before: stopped.fixtureObservedOfficialEvents, after: restoredSearch.snapshot.fixtureObservedOfficialEvents,
        eventType: 'web/deepseek-search-llm-request', productCounterActive: false });
      check('canonical-event-independent-cross-check',
        restoredSearch.snapshot.fixtureObservedOfficialEvents >= 1
        && restoredSearch.snapshot.fixtureObservedOfficialEvents > stopped.fixtureObservedOfficialEvents, {
        fixtureObservedOfficialEvents: restoredSearch.snapshot.fixtureObservedOfficialEvents,
        productCounterCalls: finalCounter?.calls ?? null,
        note: 'Real canonical Session-event positive control; product release receipt remains the authoritative release window.',
      });
      check('grok-not-called-after-author-route-restoration',
        grokResponsesStub.requests.length === grokRequestsAfterTakeover, {
          requestsBeforeAuthorSearch: grokRequestsAfterTakeover,
          requestsAfterAuthorSearch: grokResponsesStub.requests.length,
        });

      if (options.case === 'full') {
        const reenableBeforeMatrix = await rpc('native-bundle-reenable-before-matrix', 'pluginManager/setBundleEnabled', {
          name: 'dsh-grok-search', enabled: true,
        });
        check('native-hot-reenable-applied', reenableBeforeMatrix.application === 'applied' && reenableBeforeMatrix.error == null,
          { application: reenableBeforeMatrix.application, error: reenableBeforeMatrix.error ?? null });
        await waitFor(async () => {
          const state = await probe();
          return state.control?.phase === 'required' && state.runtimeWeb?.searchProviderId === 'grok-search' ? true : null;
        }, 30000, 'native bundle reacquisition');
        const managerBeforeDisable = await probe('plugin-manager-state');
        evidence.json('plugin-manager-state-before-disable.json', managerBeforeDisable);
        const productRowBeforeDisable = managerBeforeDisable.bundles
          .find(bundle => bundle.name === 'dsh-grok-search');
        check('plugin-manager-lists-product', productRowBeforeDisable?.enabled === true, {
          product: productRowBeforeDisable ?? null,
        });
        const disableResult = await probe('plugin-manager-set-bundle', {
          name: 'dsh-grok-search', enabled: false,
        });
        evidence.json('plugin-manager-disable-result.json', disableResult);
        check('plugin-manager-disable-result', ['applied', 'restart-required'].includes(disableResult?.application)
          && disableResult?.changed === true && disableResult?.error == null, {
            application: disableResult?.application ?? null,
            changed: disableResult?.changed ?? null,
            error: disableResult?.error ?? null,
          });
        const pendingDisable = await probe();
        const disableRemainsLoaded = pendingDisable.entries.some(entry => entry.id === 'grok-search');
        check('plugin-manager-disable-application-matches-runtime',
          disableResult.application === 'restart-required'
            ? disableRemainsLoaded && pendingDisable.runtimeWeb?.searchProviderId === 'grok-search'
            : !disableRemainsLoaded && pendingDisable.runtimeWeb?.searchProviderId === 'deepseek-official', {
            application: disableResult.application,
            disableRemainsLoaded,
            productEntryPresent: pendingDisable.entries.some(entry => entry.id === 'grok-search'),
            searchProviderId: pendingDisable.runtimeWeb?.searchProviderId ?? null,
          });
        const disabledSnapshot = disableRemainsLoaded
          ? await (async () => {
            await stopWeb('after-plugin-manager-disable');
            await startWeb('disabled-restart');
            return await waitFor(async () => {
              const value = await probe();
              return value.entries.every(entry => !entry.id.startsWith('grok-search'))
                && value.runtimeWeb?.searchProviderId === 'deepseek-official' ? value : null;
            }, 45_000, 'PluginManager disable to drop product entries on restart');
          })()
          : pendingDisable;
        evidence.json('snapshot-after-plugin-manager-disable.json', disabledSnapshot);
        check('plugin-manager-disable-removes-entries',
          disabledSnapshot.entries.every(entry => !entry.id.startsWith('grok-search')), {
            remaining: disabledSnapshot.entries.filter(entry => entry.id.startsWith('grok-search')),
          });
        check('plugin-manager-disable-restores-official',
          disabledSnapshot.runtimeWeb.searchProviderId === 'deepseek-official', {
            searchProviderId: disabledSnapshot.runtimeWeb.searchProviderId,
          });
        const managerAfterDisable = await probe('plugin-manager-state');
        check('plugin-manager-disabled-state', managerAfterDisable.bundles
          .find(bundle => bundle.name === 'dsh-grok-search')?.enabled === false, {
            product: managerAfterDisable.bundles.find(bundle => bundle.name === 'dsh-grok-search') ?? null,
          });
        const disabledSessionCreated = await rpc('session-create-disabled', 'session/create', {
          request: { cwd: workspace },
        });
        auth.sessionId = disabledSessionCreated.sessionId;
        const disabledSearch = await runTurn('post-disable-search', 'search', 'web_search');
        check('post-disable-official-provider-dispatched', disabledSearch.toolResult?.isError !== true
          && disabledSearch.snapshot.runtimeWeb.searchProviderId === 'deepseek-official'
          && officialStub.requests.length > 1, {
            searchProviderId: disabledSearch.snapshot.runtimeWeb.searchProviderId,
            officialStubRequests: officialStub.requests.length,
          });
        check('post-disable-grok-not-called', grokResponsesStub.requests.length === grokRequestsAfterTakeover, {
          before: grokRequestsAfterTakeover,
          after: grokResponsesStub.requests.length,
        });
        lifecycleObservation = {
          disableResult,
          managerAfterDisable,
          disabledSearch: {
            searchProviderId: disabledSearch.snapshot.runtimeWeb.searchProviderId,
            officialStubRequests: officialStub.requests.length,
          },
          disabledRestart: { searchProviderId: disabledSnapshot.runtimeWeb.searchProviderId },
        };

        const disabledManagerAfterRestart = await probe('plugin-manager-state');
        check('disabled-restart-manager-state', disabledManagerAfterRestart.bundles
          .find(bundle => bundle.name === 'dsh-grok-search')?.enabled === false, {
            product: disabledManagerAfterRestart.bundles.find(bundle => bundle.name === 'dsh-grok-search') ?? null,
          });

        const enableResult = await probe('plugin-manager-set-bundle', {
          name: 'dsh-grok-search', enabled: true,
        });
        evidence.json('plugin-manager-enable-result.json', enableResult);
        check('plugin-manager-enable-result', ['applied', 'restart-required'].includes(enableResult?.application)
          && enableResult?.changed === true
          && enableResult?.error == null, {
            application: enableResult?.application ?? null,
            changed: enableResult?.changed ?? null,
            error: enableResult?.error ?? null,
          });
        check('plugin-manager-enable-application-observed',
          ['applied', 'restart-required'].includes(enableResult?.application), {
            application: enableResult?.application ?? null,
          });
        if (enableResult.application === 'restart-required') {
          await stopWeb('after-plugin-manager-enable');
          await startWeb('reenabled-restart');
        }
        const reenabled = await waitFor(async () => {
          const value = await probe();
          return value.control && value.runtimeWeb ? value : null;
        }, 45_000, 're-enabled product control');
        evidence.json('snapshot-reenabled-restart.json', reenabled);
        const releasedRecord = reenabled.control?.recordEnvelope ?? null;
        check('reenabled-control-reacquires', reenabled.control?.phase === 'required'
          && reenabled.runtimeWeb.searchProviderId === 'grok-search', {
            phase: reenabled.control?.phase ?? null,
            searchProviderId: reenabled.runtimeWeb.searchProviderId,
            releasedRecord,
          });
        const officialBeforeReenabledSearch = officialStub.requests.length;
        const grokBeforeReenabledSearch = grokResponsesStub.requests.length;
        const reenabledSessionCreated = await rpc('session-create-reenabled', 'session/create', {
          request: { cwd: workspace },
        });
        auth.sessionId = reenabledSessionCreated.sessionId;
        const reenabledSearch = await runTurn('reenabled-search', 'search', 'web_search');
        check('reenabled-search-uses-grok',
          reenabledSearch.toolResult?.isError !== true
          && reenabledSearch.snapshot.runtimeWeb.searchProviderId === 'grok-search'
          && officialStub.requests.length === officialBeforeReenabledSearch
          && grokResponsesStub.requests.length > grokBeforeReenabledSearch, {
            searchProviderId: reenabledSearch.snapshot.runtimeWeb.searchProviderId,
            officialRequestsDelta: officialStub.requests.length - officialBeforeReenabledSearch,
            grokRequestsDelta: grokResponsesStub.requests.length - grokBeforeReenabledSearch,
          });

        const disableAgain = await probe('plugin-manager-set-bundle', {
          name: 'dsh-grok-search', enabled: false,
        });
        evidence.json('plugin-manager-disable-again-result.json', disableAgain);
        check('plugin-manager-disable-again-result', ['applied', 'restart-required'].includes(disableAgain?.application)
          && disableAgain?.changed === true
          && disableAgain?.error == null, {
            application: disableAgain?.application ?? null,
            error: disableAgain?.error ?? null,
          });
        await stopWeb('before-remove');
        await startWeb('remove');
        const beforeRemove = await waitFor(async () => {
          const value = await probe();
          return value.entries.every(entry => !entry.id.startsWith('grok-search')) ? value : null;
        }, 45_000, 'disabled product before remove');
        evidence.json('snapshot-before-plugin-manager-remove.json', beforeRemove);
        const fixturePackagePath = join(profile, 'package.json');
        const manifestBeforeRemove = JSON.parse(readFileSync(fixturePackagePath, 'utf8'));
        const fixtureDependencySpec = manifestBeforeRemove.dependencies?.['candidate-cli-web-fixture'];
        delete manifestBeforeRemove.dependencies?.['candidate-cli-web-fixture'];
        writeFileSync(fixturePackagePath, JSON.stringify(manifestBeforeRemove, null, 2) + '\n');
        const removeResult = await probe('plugin-manager-remove', { name: 'dsh-grok-search' });
        evidence.json('plugin-manager-remove-result.json', removeResult);
        check('plugin-manager-remove-result', removeResult?.changed === true
          && removeResult?.error == null
          && removeResult?.packageResult?.exitCode === 0, {
            application: removeResult?.application ?? null,
            changed: removeResult?.changed ?? null,
            error: removeResult?.error ?? null,
            packageExitCode: removeResult?.packageResult?.exitCode ?? null,
          });
        const afterRemoveManager = await probe('plugin-manager-state');
        check('plugin-manager-removed-state', !afterRemoveManager.bundles
          .some(bundle => bundle.name === 'dsh-grok-search'), {
            bundles: afterRemoveManager.bundles.map(bundle => bundle.name),
          });
        const profileAfterRemove = JSON.parse(readFileSync(profilePackagePath, 'utf8'));
        evidence.json('profile-package-after-remove.json', profileAfterRemove);
        check('profile-dependency-removed',
          profileAfterRemove.dependencies?.['dsh-grok-search'] === undefined
          && !(profileAfterRemove.dsh?.profile?.bundles ?? []).includes('dsh-grok-search'), {
            dependencies: Object.keys(profileAfterRemove.dependencies ?? {}),
            bundles: profileAfterRemove.dsh?.profile?.bundles ?? [],
          });
        await stopWeb('after-remove');
        if (fixtureDependencySpec) {
          const restored = JSON.parse(readFileSync(fixturePackagePath, 'utf8'));
          restored.dependencies ??= {};
          restored.dependencies['candidate-cli-web-fixture'] = fixtureDependencySpec;
          writeFileSync(fixturePackagePath, JSON.stringify(restored, null, 2) + '\n');
          materializeFixture();
        }
        await startWeb('removed-restart');
        const removedRestart = await waitFor(async () => {
          const value = await probe();
          return value.runtimeWeb?.searchProviderId === 'deepseek-official' ? value : null;
        }, 45_000, 'removed product restart route');
        evidence.json('snapshot-removed-restart.json', removedRestart);
        check('removed-restart-no-product-entries',
          removedRestart.entries.every(entry => !entry.id.startsWith('grok-search')), {
            remaining: removedRestart.entries.filter(entry => entry.id.startsWith('grok-search')),
          });
        const removedSessionCreated = await rpc('session-create-removed', 'session/create', {
          request: { cwd: workspace },
        });
        auth.sessionId = removedSessionCreated.sessionId;
        const removedSearch = await runTurn('removed-search', 'search', 'web_search');
        const removedFetch = await runTurn('removed-fetch', 'fetch', 'web_fetch');
        const removedChat = await runTurn('removed-chat', 'chat', null);
        check('removed-search-fetch-chat', removedSearch.snapshot.runtimeWeb.searchProviderId === 'deepseek-official'
          && removedFetch.toolResult?.text?.includes('离线 fetch 保持')
          && removedChat.assistant?.text === '内部候选轮次完成', {
            searchProviderId: removedSearch.snapshot.runtimeWeb.searchProviderId,
            fetchText: removedFetch.toolResult?.text ?? null,
            chatText: removedChat.assistant?.text ?? null,
          });
        lifecycleObservation = {
          ...lifecycleObservation,
          enableResult,
          reenabled: { phase: reenabled.control?.phase ?? null,
            searchProviderId: reenabled.runtimeWeb.searchProviderId },
          disableAgain,
          removeResult: { application: removeResult?.application ?? null, changed: removeResult?.changed ?? null,
            packageExitCode: removeResult?.packageResult?.exitCode ?? null },
          removedRestart: { searchProviderId: removedRestart.runtimeWeb.searchProviderId },
        };
        evidence.json('lifecycle-observation.json', lifecycleObservation);
      }

      if (options.case === 'full') {
        const recordsDirectory = join(profile, 'control-intent.records');
        const recordFiles = listJsonFiles(recordsDirectory);
        const completions = recordFiles.flatMap(path => {
          try {
            const value = completionRecord(JSON.parse(readFileSync(path, 'utf8')));
            return value ? [{ path: relative(profile, path), value }] : [];
          } catch {
            return [];
          }
        });
        evidence.json('persistence-record-observation.json', {
          recordFiles: recordFiles.map(path => relative(profile, path)),
          completions: completions.map(item => ({
            path: item.path,
            completionCommitted: item.value.routeVerified === true,
            routeVerified: item.value.routeVerified === true,
            routeChanged: item.value.routeChanged === true,
          })),
        });
        check('full-persisted-release-completion', completions.some(item =>
          item.value.routeVerified === true && typeof item.value.routeChanged === 'boolean'), {
          completionRecords: completions.length,
        });
      }

      step('explicit-stop', {
        transport: 'authenticated Web /api/grokSearchSettings/stop RPC',
        outcomeKind: stopValue.outcome.kind,
        completionCommitted: stopValue.outcome.completionCommitted,
        routeVerified: stopValue.outcome.routeVerified,
        routeChanged: stopValue.outcome.routeChanged,
        restoredSearchProvider: restoredSearch.snapshot.runtimeWeb.searchProviderId,
        officialStubRequestsAfterRestore: officialStub.requests.length,
        canonicalCounterBaseline: baselineCounter,
        canonicalCounterAfterRestore: finalCounter,
      });
    } else {
      const finalSnapshot = await probe();
      evidence.json('snapshot-smoke-final.json', finalSnapshot);
      check('smoke-leaves-control-required-before-exit', finalSnapshot.control?.phase === 'required'
        && finalSnapshot.runtimeWeb.searchProviderId === 'grok-search', {
        phase: finalSnapshot.control?.phase ?? null,
        searchProviderId: finalSnapshot.runtimeWeb.searchProviderId,
      });
      step('smoke-boundary', {
        explicitStopExecuted: false,
        reason: 'smoke case verifies takeover and conversation paths only',
      });
    }
  } catch (error) {
    failure = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } finally {
    for (const item of webProcesses) {
      if (item.closed) continue;
      item.termination = await terminateWebProcess(item, runRoot, grokExecutable);
    }
    if (web) {
      termination = web.termination ?? await terminateWebProcess(web, runRoot, grokExecutable);
      try {
        check('dsh-sigterm-exit', termination.graceful && !termination.dshAliveAfterExit, {
          graceful: termination.graceful,
          exitCode: termination.exitCode,
          exitSignal: termination.exitSignal,
        });
        check('no-grok-child-residue', termination.leftoverMatchingProcesses.length === 0, {
          leftovers: termination.leftoverMatchingProcesses,
        });
        check('all-dsh-web-processes-exited', webProcesses.every(item => item.closed
          && !pidAlive(item.child.pid)), {
            processes: webProcesses.map(item => ({ label: item.label, pid: item.child.pid,
              closed: item.closed, exitCode: item.exitCode, signal: item.signal })),
          });
      } catch (error) {
        failure ??= { name: error.name, message: error.message, stack: error.stack };
      }
      step('sigterm-cleanup', termination);
    }
    if (officialStub) {
      evidence.json('official-search-stub-final.json', {
        baseURL: officialStub.baseURL,
        requestCount: officialStub.requests.length,
        requests: officialStub.requests,
      });
      try { await officialStub.close(); } catch {}
      officialStub = null;
    }
    if (grokResponsesStub) {
      evidence.json('grok-responses-stub-final.json', {
        baseUrl: grokResponsesStub.baseUrl,
        requestCount: grokResponsesStub.requests.length,
        requests: grokResponsesStub.requests,
      });
      try { await grokResponsesStub.close(); } catch {}
      grokResponsesStub = null;
    }
    clearInterval(heartbeat);
  }

  if (web) {
    evidence.text('logs/dsh-web.stdout.log', web.stdout);
    evidence.text('logs/dsh-web.stderr.log', web.stderr);
    evidence.json('dsh-web-exit.json', {
      pid: web.child.pid,
      exitCode: web.exitCode,
      signal: web.signal,
      graceful: termination?.graceful ?? null,
      durationMs: web.endedAt ? web.endedAt - web.startedAt : null,
    });
    if (termination) {
      evidence.recordExecution({
        label: 'dsh-web-process',
        command: process.execPath,
        args: ['<COPIED_DSH_CLI>', 'web', '--no-open', '--port', '0'],
        cwd: '<WORKSPACE>',
        exitCode: web.exitCode,
        signal: web.signal,
        durationMs: web.endedAt ? web.endedAt - web.startedAt : null,
        timedOut: false,
      });
    }
  }

  const sourcesUnchanged = sourceHashesBefore.every(row => existsSync(join(PROJECT_ROOT, row.file))
    && sha256(join(PROJECT_ROOT, row.file)) === row.sha256);
  if (!sourcesUnchanged) failure ??= { message: 'Source changed during the run; this is not current-source evidence.' };
  const status = failure || checks.some(item => item.status !== 'pass') ? 'fail' : 'pass';
  const summary = {
    schemaVersion: 1,
    status,
    runId,
    case: options.case,
    dshVersion: VERSIONS[options.dshVersion],
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceHashes: sourceHashesBefore,
    sourcesUnchanged,
    productPackage: existsSync(options.productPackage) ? {
      sha256: sha256(options.productPackage),
      size: statSync(options.productPackage).size,
    } : null,
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.versions.node,
      wslDistro: options.wslDistro ?? 'unknown',
      grok: {
        version: GROK_VERSION,
        linuxArchiveSha256: grokArchiveSha256,
        executable: '<RUN_ROOT>/grok/grok-search-rs',
        config: firstUse ? '<RUN_ROOT>/home/.config/grok-search-rs/config.toml' : '<RUN_ROOT>/grok-config/config.toml',
        realCredentialsPassed: false,
      },
      pnpm: {
        version: DEFAULT_PNPM_VERSION,
        source: 'provided pnpm entry',
        entry: '<PNPM_ENTRY>',
        store: '<HOST_PNPM_STORE>',
      },
      isolatedDshHome: '<RUN_ROOT>/dsh-home',
      isolatedWorkspace: '<RUN_ROOT>/workspace',
      browser: options.browserExecutable ? {
        executable: '<BROWSER_EXECUTABLE>',
        isolatedProfile: '<RUN_ROOT>/browser-profile',
        headless: true,
      } : null,
      inheritedCredentialEnvironmentPassed: false,
      authAndCookieRedacted: true,
    },
    commands: [
      ...(bootstrap?.commands ?? []),
      ...evidence.executions,
    ],
    steps,
    checks,
    firstUseAutoDownloadValidated: firstUse && status === 'pass',
    firstUseProgramReceipt,
    failure: failure ? evidence.safe(failure) : null,
    termination,
    boundaries: [
      'Linux x64 CLI/Web only; no Windows dsh.ps1 or Desktop host was exercised.',
      'The MCP process is the official grok-search-rs 0.1.26 Linux x64 release binary, hash-verified against the upstream SHA256SUMS.',
      'Grok config and its synthetic API key are confined to this temporary run; Responses API calls go only to a 127.0.0.1 local stub, not xAI.',
      'The model and fetch provider are isolated offline fixtures.',
      'The official search path enables the real dsh web-search-deepseek provider against a 127.0.0.1-only Anthropic-format stub.',
      'Canonical official-search evidence comes from the product route verifier and dsh-session canonical event; the fixture event listener is a supporting cross-check only.',
      'Web startup, owner-authenticated RPC, Plugins detail DOM/shared configuration and native bundle disable/re-enable are real dsh HTTP/Web paths.',
      'The Linux browser uses an isolated profile and headless Chromium; no formal profile, shared Grok config, user credential, publication, commit or push was used.',
      'Temporary DSH_HOME and runtime paths are intentionally not part of public profile state.',
    ],
    artifacts: {
      summary: 'summary.json',
      bootstrap: 'bootstrap.json',
      profileInstalled: 'profile-package-installed.json',
      profileConfigured: 'profile-package-configured.json',
      pnpmLocalRegistry: existsSync(join(artifactDir, 'pnpm-local-registry-after-install.json'))
        ? 'pnpm-local-registry-after-install.json' : null,
      routeTakeover: 'snapshot-route-takeover.json',
      stopResult: existsSync(join(artifactDir, 'native-release-evidence.json')) ? 'native-release-evidence.json' : null,
      officialStub: existsSync(join(artifactDir, 'official-search-stub-final.json'))
        ? 'official-search-stub-final.json' : 'official-search-stub-start.json',
      grokDirectProtocol: existsSync(join(artifactDir, 'grok-direct-mcp-protocol.json'))
        ? 'grok-direct-mcp-protocol.json' : null,
      grokResponsesStub: existsSync(join(artifactDir, 'grok-responses-stub-final.json'))
        ? 'grok-responses-stub-final.json' : 'grok-responses-stub-start.json',
      webStderr: 'logs/dsh-web.stderr.log',
      webStdout: 'logs/dsh-web.stdout.log',
      settingsUi: existsSync(join(artifactDir, 'linux-settings-grok-ui.json'))
        ? 'linux-settings-grok-ui.json' : null,
      settingsUiScreenshot: existsSync(join(artifactDir, 'linux-settings-grok-ui.png'))
        ? 'linux-settings-grok-ui.png' : null,
    },
  };
  evidence.json('summary.json', summary);
  evidence.json('receipt.json', {
    runId,
    status,
    case: options.case,
    dshVersion: VERSIONS[options.dshVersion],
    productSha256: summary.productPackage?.sha256 ?? null,
    officialCanonicalPathValidated: status === 'pass' && checks.some(check =>
      check.name === 'post-stop-canonical-observer-positive-control' && check.status === 'pass'),
    checks,
    commands: evidence.executions.map(({ label, exitCode, signal, timedOut, durationMs }) => ({
      label, exitCode, signal, timedOut, durationMs,
    })),
    termination,
    failure: summary.failure,
  });

  console.log(`b3-cli-web: ${status} ${options.dshVersion} ${options.case} ${runId}`);
  console.log(`Evidence: ${artifactDir}`);
  process.exitCode = status === 'pass' ? 0 : 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform === 'win32') {
    if (options.worker) throw new Error('--worker must run inside WSL.');
    await windowsBootstrap(options);
  } else {
    await linuxWorker(options);
  }
}

export { runGrokProtocolProbe };

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    console.error(`b3-cli-web: ${redactPrivatePaths(error.stack ?? error)}`);
    process.exitCode = 1;
  });
}
