import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PROGRAM_MARKER, PROGRAM_CASE_MARKER, PROGRAM_CASE_IDS, PROGRAM_VERSION, PROGRAM_SENTINEL, PROGRAM_SOURCE,
  casePassed, contained, digest, installerEndpoint, insist, parseProgramArguments, platformArchive, programCaseDirectory,
  readRegular, safeCode, validateProgramInputs,
} from './lib/compatibility-program-checks.mjs';

const ownFile = fileURLToPath(import.meta.url);
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const error = code => Object.assign(new Error(code), { code });
const json = (path, value, fresh = true) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n',
  { flag: fresh ? 'wx' : 'w', mode: 0o600 });
const idle = value => value?.running === 0 && value.queued === 0 && value.faulted === 0;

async function within(task, signal, timeout = 20_000) {
  let timer, abort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([task, new Promise((_done, reject) => {
      timer = setTimeout(() => reject(error('COMPATIBILITY_PROGRAM_TIMEOUT')), timeout);
      if (signal) {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }
    })]);
  } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
}

async function until(check, signal, timeout = 20_000) {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    signal?.throwIfAborted();
    insist(performance.now() < deadline, 'COMPATIBILITY_PROGRAM_TIMEOUT');
    await delay(20);
  }
}

export function programEnvironment(root, inherited = process.env) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (inherited[name]) env[name] = inherited[name];
  }
  return Object.assign(env, {
    HOME: join(root, 'user'), USERPROFILE: join(root, 'user'), APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'user/config'), XDG_CACHE_HOME: join(root, 'user/cache'), XDG_DATA_HOME: join(root, 'user/data'),
    CARGO_HOME: join(root, 'cargo'), DSH_HOME: join(root, 'dsh-home'), PATH: join(root, 'empty-path'),
    NO_PROXY: '127.0.0.1,localhost', DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  });
}

function applyEnvironment(root) {
  const env = programEnvironment(root);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
  for (const name of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'XDG_DATA_HOME', 'CARGO_HOME', 'DSH_HOME', 'PATH']) mkdirSync(env[name], { recursive: true, mode: 0o700 });
}

function observeProgramChildren(expectedSha256, root) {
  const spawn = childProcess.spawn, rows = [];
  childProcess.spawn = function (executable, args, options) {
    insist(typeof executable === 'string' && digest(readRegular(executable)) === expectedSha256,
      'COMPATIBILITY_PROGRAM_UNEXPECTED_CHILD');
    const versionProbe = args?.length === 1 && args[0] === '--version';
    insist(options?.shell !== true && (versionProbe ? options?.env?.PATH && contained(root, options.env.PATH)
      : options?.env?.HOME && contained(root, options.env.HOME)),
      'COMPATIBILITY_PROGRAM_CHILD_ENV_UNSAFE');
    const child = spawn.call(this, executable, args, options);
    const row = { child, pid: child.pid ?? null, versionProbe,
      closed: false, exited: false, forced: false, executableSha256: expectedSha256,
      executablePathLength: executable.length, spawnErrorCode: null };
    rows.push(row);
    child.once('spawn', () => { row.pid = child.pid; });
    child.once('error', failure => {
      row.spawnErrorCode = safeCode(failure);
      if (child.pid === undefined) row.exited = true;
    });
    child.once('exit', () => { row.exited = true; });
    child.once('close', () => { row.closed = true; });
    return child;
  };
  syncBuiltinESMExports();
  const reaped = row => row.exited && row.closed
    && [row.child.stdin, row.child.stdout, row.child.stderr].every(stream => !stream || stream.destroyed);
  return {
    rows, reaped,
    async close() {
      const live = rows.filter(row => !reaped(row));
      for (const row of live) if (!row.exited) { row.forced = true; row.child.kill('SIGKILL'); }
      await until(() => rows.every(reaped), undefined, 5000);
    },
    restore() { childProcess.spawn = spawn; syncBuiltinESMExports(); },
  };
}

export async function startProgramLoopback(archive, { mode = 'ok' } = {}) {
  const state = { mode, requests: [], active: 0, unexpected: 0, closed: false, lateAttempts: 0 };
  const held = [], sockets = new Set();
  const server = createServer((request, response) => {
    const path = request.url;
    const kind = request.method === 'GET' && path === '/registry/metadata' ? 'metadata'
      : request.method === 'GET' && path === '/registry/archive' ? 'archive'
        : request.method === 'POST' && path === '/v1/responses' ? 'responses' : null;
    const row = { kind, held: false, closed: false, disconnected: false };
    state.requests.push(row); state.active++;
    response.on('error', () => {});
    response.once('close', () => {
      row.closed = true; row.disconnected = row.held && !response.writableEnded; state.active--;
    });
    if (!kind || state.requests.length > 200) {
      state.unexpected++; response.writeHead(403); response.end(); return;
    }
    const send = value => {
      response.writeHead(200, { 'content-type': kind === 'archive' ? 'application/octet-stream' : 'application/json' });
      response.end(kind === 'archive' ? value : JSON.stringify(value));
    };
    if (kind === 'metadata' && state.mode === 'hold-metadata') {
      row.held = true; held.push(response);
      response.writeHead(200, { 'content-type': 'application/json' }); response.write(' ');
      return;
    }
    if (kind === 'metadata') { send(archive.metadata); return; }
    if (kind === 'archive') {
      if (state.mode === 'fail-download') { response.writeHead(503); response.end('synthetic download failure'); }
      else send(archive.archive);
      return;
    }
    let length = 0, chunks = [];
    request.on('data', chunk => { length += chunk.length; if (length <= 1_048_576) chunks.push(chunk); });
    request.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      chunks = [];
      if (length > 1_048_576 || body?.model !== 'compatibility-program'
        || request.headers.authorization !== 'Bearer ' + PROGRAM_SENTINEL) {
        state.unexpected++; response.writeHead(403); response.end(); return;
      }
      if (state.mode === 'hold-response') {
        row.held = true; held.push(response);
        response.writeHead(200, { 'content-type': 'application/json' }); response.write(' ');
        return;
      }
      const text = 'Synthetic real-program lifecycle result';
      send({ id: 'resp-' + randomUUID(), object: 'response', status: 'completed', model: body.model,
        output_text: text, output: [
          { type: 'web_search_call', action: { sources: [{ url: PROGRAM_SOURCE, title: 'Lifecycle fixture', description: text }] } },
          { type: 'message', content: [{ type: 'output_text', text }] },
        ] });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { state, origin: `http://127.0.0.1:${server.address().port}`,
    finishLateMetadata() {
      for (const response of held) {
        state.lateAttempts++;
        try { response.end(JSON.stringify(archive.metadata)); } catch {}
      }
    },
    async close() {
      if (state.closed) return;
      const closed = new Promise(done => server.close(done));
      for (const socket of sockets) socket.destroy();
      await closed; state.closed = true;
    },
  };
}

export function installProgramFetchBoundary(upstream, archive, fetchImpl = globalThis.fetch) {
  const records = [];
  return { records, async fetch(input, options = {}) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const mapped = installerEndpoint(url, upstream.origin, archive);
    if (mapped) {
      const record = { kind: mapped.endsWith('/metadata') ? 'metadata' : 'archive',
        signal: options.signal, aborted: options.signal?.aborted === true };
      records.push(record);
      options.signal?.addEventListener('abort', () => { record.aborted = true; }, { once: true });
      return fetchImpl(mapped, options);
    }
    let parsed;
    try { parsed = new URL(url); } catch {}
    if (parsed?.origin === upstream.origin && !parsed.username && !parsed.password) return fetchImpl(input, options);
    upstream.state.unexpected++;
    throw error('COMPATIBILITY_PROGRAM_NETWORK_DENIED');
  } };
}

const fixtureSource = `
const trace = () => globalThis.__DSH_COMPATIBILITY_PROGRAM__;
export function applyContext(ctx) {
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1; } });
  ctx.provide('candidateExistingDependency', { synthetic: true });
  ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: trace().official }) });
  ctx.effect(() => () => { trace().disposed++; });
}
export function applyProviders(ctx) {
  ctx.web.registerSearchProvider({ id: 'candidate-original', available: () => true,
    async search() { trace().official++; throw new Error('Official provider must not run'); } });
  ctx.web.registerFetchProvider({ id: 'candidate-fetch', available: () => true,
    async fetch() { trace().fetch++; throw new Error('Original fetch must not run'); } });
}
`;

function prepareProfile(input, runtimeRoot, origin) {
  const profile = join(input.outputRoot, 'dsh-home/profiles/candidate');
  const product = join(profile, 'node_modules/dsh-grok-search');
  mkdirSync(product, { recursive: true, mode: 0o700 });
  for (const [path, bytes] of input.files) {
    const target = join(product, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  // Only private output links to the caller's existing dependencies; no install or host-peer copies.
  symlinkSync(input.dependencyRoot, join(product, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const fixture = join(profile, 'node_modules/compatibility-program-fixture');
  mkdirSync(fixture, { recursive: true, mode: 0o700 });
  writeFileSync(join(fixture, 'fixture.mjs'), fixtureSource, { flag: 'wx' });
  for (const name of ['context', 'providers']) writeFileSync(join(fixture, name + '.mjs'),
    `export { apply${name === 'context' ? 'Context' : 'Providers'} as apply } from './fixture.mjs';\n`
    + `export const name = 'compatibility-program-${name}';\n`
    + `export const inject = ${JSON.stringify(name === 'providers' ? ['web'] : [])};\n`, { flag: 'wx' });
  json(join(fixture, 'package.json'), { name: 'compatibility-program-fixture', version: '0.0.0', private: true,
    type: 'module', exports: { './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml',
      './context': './context.mjs', './providers': './providers.mjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } } });
  const row = (id, name, config = {}) => ({ id, name: '@deepseek-ai/' + name, config });
  const modern = existsSync(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-tool-executor-native/package.json'));
  json(join(fixture, 'cordis.patch.yml'), [{ insert: [
    { id: 'fixture-context', name: 'compatibility-program-fixture/context' },
    row('timer', 'cordis-plugin-timer'), row('config-editor', 'dsh-config-editor'),
    row('tools', 'dsh-tools', modern ? {} : { mode: 'native' }),
    ...(modern ? [row('tool-executor-native', 'dsh-tool-executor-native')] : []),
    { ...row('web', 'dsh-web', { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' }),
      inject: ['candidateExistingDependency'] },
    row('tool-web', 'dsh-tool-web', { search: true, fetch: true, searchTimeoutMs: 30_000, fetchTimeoutMs: 30_000 }),
    { id: 'fixture-providers', name: 'compatibility-program-fixture/providers' },
  ] }]);
  json(join(profile, 'package.json'), { name: 'compatibility-program-profile', private: true, type: 'module',
    dependencies: { 'dsh-grok-search': input.manifest.version, 'compatibility-program-fixture': '0.0.0' },
    dsh: { profile: { bundles: ['compatibility-program-fixture', 'dsh-grok-search'] } } });
  const privateRoot = join(profile, 'grok-search'), cache = join(privateRoot, 'runtime-cache');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const sentinel = join(cache, 'unrelated-user-file');
  writeFileSync(sentinel, 'preserve unrelated cache contents\n', { flag: 'wx', mode: 0o600 });
  const preferences = join(privateRoot, 'preferences.json');
  json(preferences, { schemaVersion: 1, grokEnabled: true, githubEnabled: false, githubReadEnabled: false,
    sourceOrder: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
    sourceEnabled: { tavily: false, exa: false, tinyfish: false, firecrawl: false } });
  const configPath = join(privateRoot, 'program-fixture.toml');
  writeFileSync(configPath, [`grok_api_url = ${JSON.stringify(origin + '/v1')}`,
    `grok_api_key = ${JSON.stringify(PROGRAM_SENTINEL)}`, 'grok_auth_mode = "api_key"',
    'grok_model = "compatibility-program"', 'timeout_seconds = 30', 'response_max_chars = 6000',
    'fallback_sources = 0', 'default_extra_sources = 0', 'tavily_enabled = false', 'exa_enabled = false',
    'tinyfish_enabled = false', 'firecrawl_enabled = false',
  ].join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const patch = [{ id: 'grok-search', config: { budgetMs: 30_000, configPath,
    executable: input.caseId === PROGRAM_CASE_IDS[0] ? input.grokProgram : '' } }];
  const patchPath = join(profile, 'cordis.patch.yml');
  json(patchPath, patch);
  return { profile, product, cache, sentinel, configPath, preferences, patch, patchPath,
    hashes: { config: digest(readFileSync(configPath)), preferences: digest(readFileSync(preferences)),
      sentinel: digest(readFileSync(sentinel)) } };
}

async function managedCancellation({ boot, core, program, upstream, observer, signal }) {
  insist(program.snapshot().program?.version === PROGRAM_VERSION, 'COMPATIBILITY_PROGRAM_VERSION_MISMATCH');
  const observations = [];
  for (const diagnostic of [false, true]) {
    const warm = await within(boot.ctx.web.search({ query: 'program-warmup', maxResults: 2 }, signal), signal);
    insist(JSON.stringify(warm).includes(PROGRAM_SOURCE), 'COMPATIBILITY_PROGRAM_SEARCH_FAILED');
    const before = upstream.state.requests.length;
    upstream.state.mode = 'hold-response';
    const controller = new AbortController(), reason = error('COMPATIBILITY_PROGRAM_CALLER_CANCELLED');
    const task = (diagnostic ? core.testGrok({ query: 'program-diagnostic-cancel', maxResults: 2 }, controller.signal)
      : boot.ctx.web.search({ query: 'program-managed-cancel', maxResults: 2 }, controller.signal))
      .then(() => ({ succeeded: true }), failure => ({ succeeded: false, failure }));
    try {
      await until(() => upstream.state.requests.slice(before).some(row => row.kind === 'responses' && row.held), signal);
      controller.abort(reason);
      const result = await within(task, signal);
      const receipt = core.snapshot().lastDiagnostic, child = observer.rows.find(row => row.pid === receipt?.childPid);
      await until(() => child && observer.reaped(child)
        && upstream.state.requests.slice(before).some(row => row.disconnected), signal);
      insist(result.succeeded === false && result.failure === reason && receipt?.exited === true
        && receipt.serverVersion === PROGRAM_VERSION && child?.versionProbe === false,
      'COMPATIBILITY_PROGRAM_CANCEL_FAILED');
      observations.push({ diagnostic, callerReasonPreserved: true, childPid: child.pid, exited: receipt.exited,
        exitCode: receipt.exitCode, exitSignal: receipt.exitSignal, stdioClosed: observer.reaped(child) });
    } finally { controller.abort(reason); await within(task, undefined, 5000).catch(() => {}); }
    upstream.state.mode = 'ok';
    const recovered = await within(boot.ctx.web.search({ query: 'program-recovered', maxResults: 2 }, signal), signal);
    insist(JSON.stringify(recovered).includes(PROGRAM_SOURCE), 'COMPATIBILITY_PROGRAM_RECOVERY_FAILED');
  }
  await until(() => idle(core.snapshot()) && idle(core.snapshot().routeExecutor), signal);
  return { childStarted: observations.length === 2, callerReasonPreserved: observations.every(row => row.callerReasonPreserved),
    childReaped: observations.every(row => row.exited), stdioClosed: observations.every(row => row.stdioClosed),
    upstreamDisconnectObserved: upstream.state.requests.filter(row => row.kind === 'responses' && row.disconnected).length === 2,
    cancelledCalls: observations.length, diagnosticCancellation: observations, running0: true, queued0: true,
    recovered: true, programVersion: program.snapshot().program.version };
}

async function preparationCancellation({ boot, program, upstream, boundary, fixture, input, signal }) {
  await until(() => upstream.state.requests.some(row => row.kind === 'metadata' && row.held), signal);
  const pending = program.prepare().then(() => ({ succeeded: true }), failure => ({ succeeded: false, failure }));
  const entry = [...boot.ctx.loader.entries()].find(row => row.options.id === 'grok-search');
  insist(entry?.fiber, 'COMPATIBILITY_PROGRAM_ENTRY_MISSING');
  if (input.variant === 'disable') {
    fixture.patch[0].disabled = true;
    json(fixture.patchPath, fixture.patch, false);
    await within(entry.update({ ...entry.options, disabled: true }), signal);
  } else await within(entry.fiber.dispose(), signal);
  const settled = await within(pending, signal);
  await until(() => upstream.state.requests.some(row => row.kind === 'metadata' && row.disconnected), signal);
  const request = boundary.records.find(row => row.kind === 'metadata');
  const sameReason = settled.succeeded === false && request?.aborted === true && settled.failure === request.signal.reason;
  upstream.finishLateMetadata();
  await delay(50);
  return { variant: input.variant, preparationStarted: true, callerReasonPreserved: sameReason,
    preparationSettled: settled.succeeded === false, upstreamDisconnectObserved: true,
    lateCompletionAttempted: upstream.state.lateAttempts > 0,
    lateCompletionNotPublished: program.snapshot().phase === 'disposed' && !existsSync(join(fixture.cache, 'active.json')),
    activeCacheCommitted: existsSync(join(fixture.cache, 'active.json')), programPhase: program.snapshot().phase };
}

async function downloadRepair({ boot, program, fixture, upstream, input, signal }) {
  await until(() => program.snapshot().phase === 'error', signal);
  const failureCode = program.snapshot().error?.code;
  insist(failureCode === 'GROK_DOWNLOAD_HTTP' && !existsSync(join(fixture.cache, 'active.json')),
    'COMPATIBILITY_PROGRAM_DOWNLOAD_FAILURE_MISSING');
  upstream.state.mode = 'ok';
  await within(program.prepare(), signal, 45_000);
  const activePath = join(fixture.cache, 'active.json'), active = JSON.parse(readFileSync(activePath, 'utf8'));
  insist(active.sha256 === input.grokSha256 && active.mcpHandshakeValidated === true
    && digest(readRegular(join(fixture.cache, active.executable))) === input.grokSha256,
  'COMPATIBILITY_PROGRAM_CACHE_UNVERIFIED');
  json(activePath, { ...active, sha256: '0'.repeat(64) }, false);
  const corruptHash = digest(readFileSync(activePath));
  const bad = await program.prepare().then(() => null, failure => failure.code);
  insist(bad === 'GROK_CACHE_DAMAGED' && program.snapshot().canRepair === true,
    'COMPATIBILITY_PROGRAM_INVALID_CACHE_ACTIVATED');
  upstream.state.mode = 'fail-download';
  const failedRepair = await within(program.repair().then(() => null, failure => failure.code), signal);
  const preserved = digest(readFileSync(activePath)) === corruptHash;
  insist(failedRepair === 'GROK_DOWNLOAD_HTTP' && preserved && program.snapshot().canRepair,
    'COMPATIBILITY_PROGRAM_REPAIR_FAILURE_HIDDEN');
  upstream.state.mode = 'ok';
  await within(program.repair(), signal, 45_000);
  const repaired = JSON.parse(readFileSync(activePath, 'utf8'));
  const recovered = await within(boot.ctx.web.search({ query: 'program-repair-recovered', maxResults: 2 }, signal), signal);
  insist(repaired.executable !== active.executable && repaired.sha256 === input.grokSha256
    && digest(readRegular(join(fixture.cache, repaired.executable))) === input.grokSha256
    && digest(readRegular(join(fixture.cache, active.executable))) === input.grokSha256
    && JSON.stringify(recovered).includes(PROGRAM_SOURCE), 'COMPATIBILITY_PROGRAM_REPAIR_FAILED');
  return { failureObserved: true, failureCode, invalidCacheActivated: false, repairFailureObserved: true,
    failedRepairPreservedActive: preserved, repairSucceeded: program.snapshot().phase === 'ready',
    repairedSha256: repaired.sha256, mcpHandshakeValidated: repaired.mcpHandshakeValidated === true, recovered: true };
}

export async function runProgramCase(options, { signal } = {}) {
  const receipt = { id: options.caseId, variant: options.variant, passed: false, status: 'failed',
    hostVersion: null, pluginVersion: null, productSha256: options.productSha256, grokSha256: options.grokSha256,
    realCredentialsUsed: false, officialSearchCalls: 0, cleanupVerified: false, observations: {}, stage: 'input', code: null };
  let input, fixture, upstream, boundary, observer, boot, starting, program, core, originalFetch;
  const trace = { official: 0, fetch: 0, disposed: 0 };
  try {
    input = validateProgramInputs(options);
    mkdirSync(input.outputRoot, { mode: 0o700 });
    applyEnvironment(input.outputRoot);
    receipt.stage = 'host-layout';
    const runtimeRoot = existsSync(join(input.hostRoot, 'dsh/package.json')) ? join(input.hostRoot, 'dsh') : input.hostRoot;
    const host = JSON.parse(readRegular(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json')).toString('utf8'));
    insist(host.name === '@deepseek-ai/dsh' && typeof host.version === 'string', 'COMPATIBILITY_PROGRAM_HOST_INVALID');
    receipt.hostVersion = host.version; receipt.pluginVersion = input.manifest.version;
    const archive = platformArchive(input.binary);
    upstream = await startProgramLoopback(archive, { mode: input.caseId === PROGRAM_CASE_IDS[1] ? 'hold-metadata'
      : input.caseId === PROGRAM_CASE_IDS[2] ? 'fail-download' : 'ok' });
    fixture = prepareProfile(input, runtimeRoot, upstream.origin);
    globalThis.__DSH_COMPATIBILITY_PROGRAM__ = trace;
    originalFetch = globalThis.fetch;
    boundary = installProgramFetchBoundary(upstream, archive, originalFetch);
    globalThis.fetch = boundary.fetch;
    observer = observeProgramChildren(input.grokSha256, input.outputRoot);
    receipt.stage = 'profile-boot';
    const imp = (name, file = 'lib/index.js') => import(pathToFileURL(
      join(runtimeRoot, 'node_modules/@deepseek-ai', name, file)).href);
    const appBoot = await imp('dsh-app-boot'), { runProfile } = await imp('dsh', 'lib/profile-boot.js');
    starting = runProfile({ environment: appBoot.loadLayeredEnv('dsh', input.outputRoot),
      profile: 'candidate', patchFiles: [], args: [] }).then(value => { boot = value; return value; });
    await within(starting, signal, 45_000);
    receipt.stage = 'core-admission';
    await until(() => boot.ctx.get('grokSearchCompatibility')?.report().coreReady === true
      && boot.ctx.get('grokSearchProgram'), signal, 30_000);
    program = boot.ctx.get('grokSearchProgram'); core = boot.ctx.get('grokSearchCore');
    const report = boot.ctx.get('grokSearchCompatibility').report();
    insist(report.hostVersion === host.version && report.pluginVersion === input.manifest.version,
      'COMPATIBILITY_PROGRAM_IDENTITY_MISMATCH');
    if (input.caseId === PROGRAM_CASE_IDS[0]) await until(() => program.snapshot().phase === 'ready', signal);
    receipt.stage = 'case-execution';
    const context = { input, fixture, boot, program, core, upstream, boundary, observer, signal };
    receipt.observations = await (input.caseId === PROGRAM_CASE_IDS[0] ? managedCancellation(context)
      : input.caseId === PROGRAM_CASE_IDS[1] ? preparationCancellation(context) : downloadRepair(context));
    receipt.stage = 'cleanup';
  } catch (failure) { receipt.code = safeCode(failure); }
  finally {
    try {
      if (starting && !boot) await within(starting, undefined, 5000).catch(() => {});
      program ??= boot?.ctx.get('grokSearchProgram'); core ??= boot?.ctx.get('grokSearchCore');
      if (boot) await within(boot.shutdown.shutdown(0), undefined, 20_000);
      if (observer) await observer.close();
      if (upstream) await upstream.close();
      const quiet = observer?.rows.every(row => observer.reaped(row) && !row.forced) === true;
      Object.assign(receipt.observations, { orphanProcesses0: quiet,
        unexpectedRequests: upstream?.state.unexpected ?? null,
        configUnchanged: Boolean(fixture && digest(readFileSync(fixture.configPath)) === fixture.hashes.config
          && digest(readFileSync(fixture.preferences)) === fixture.hashes.preferences),
        cacheSentinelUnchanged: Boolean(fixture && digest(readFileSync(fixture.sentinel)) === fixture.hashes.sentinel),
        childProcesses: observer?.rows.map(row => ({ pid: row.pid, versionProbe: row.versionProbe,
          exited: row.exited, closed: row.closed, stdioClosed: observer.reaped(row), forced: row.forced,
          executablePathLength: row.executablePathLength, spawnErrorCode: row.spawnErrorCode })) ?? [] });
      receipt.cleanupVerified = Boolean(boot && upstream?.state.closed && upstream.state.active === 0
        && quiet && trace.disposed === 1 && program?.snapshot().phase === 'disposed'
        && (!core || idle(core.snapshot()) && idle(core.snapshot().routeExecutor)));
      if (fixture) {
        insist(!existsSync(join(fixture.cache, '.install.lock'))
          && !readdirSync(fixture.cache).some(name => /^active-.*\.json$/.test(name)), 'COMPATIBILITY_PROGRAM_CACHE_UNSETTLED');
        for (const [path, bytes] of input.files) insist(digest(readRegular(join(fixture.product, path), { allowEmpty: true })) === digest(bytes),
          'COMPATIBILITY_PROGRAM_PRODUCT_CHANGED');
      }
    } catch (failure) { receipt.code ??= safeCode(failure); }
    finally {
      if (observer) await observer.close().catch(failure => { receipt.code ??= safeCode(failure); });
      if (upstream && !upstream.state.closed) await upstream.close().catch(() => {});
      observer?.restore();
      if (originalFetch) globalThis.fetch = originalFetch;
      delete globalThis.__DSH_COMPATIBILITY_PROGRAM__;
    }
  }
  receipt.officialSearchCalls = trace.official;
  receipt.passed = receipt.code === null && receipt.cleanupVerified && trace.official === 0 && trace.fetch === 0
    && casePassed(receipt.id, receipt.observations);
  receipt.status = receipt.passed ? 'passed' : 'failed';
  if (receipt.passed) receipt.stage = 'complete';
  if (!receipt.passed) receipt.code ??= 'COMPATIBILITY_PROGRAM_EVIDENCE_INCOMPLETE';
  return receipt;
}

async function childCase(input, id, variant, signal) {
  // Long scenario labels plus the installer's UUID can exceed Windows process path limits.
  const directory = programCaseDirectory(input.outputRoot, id, variant);
  const args = ['--expose-internals', ownFile, input.hostRoot, directory, input.productDir, input.productSha256,
    '--product-package', input.productPackage, '--grok-program', input.grokProgram, '--grok-sha256', input.grokSha256,
    '--case', id, ...(variant ? ['--variant', variant] : [])];
  const child = childProcess.spawn(process.execPath, args, { env: programEnvironment(directory),
    cwd: input.outputRoot, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', bytes = 0, failure = null, hard;
  const stop = () => {
    if (child.connected) child.send({ type: 'compatibility-program-cancel' }, () => {});
    else child.kill('SIGTERM');
    hard ??= setTimeout(() => child.kill('SIGKILL'), 30_000);
  };
  const timer = setTimeout(() => { failure = 'COMPATIBILITY_PROGRAM_CHILD_TIMEOUT'; stop(); }, 180_000);
  const abort = () => { failure = 'COMPATIBILITY_PROGRAM_CANCELLED'; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.on('error', () => { failure = 'COMPATIBILITY_PROGRAM_CHILD_START_FAILED'; });
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 4_194_304) { failure = 'COMPATIBILITY_PROGRAM_OUTPUT_LIMIT'; stop(); }
    else stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 4_194_304) { failure = 'COMPATIBILITY_PROGRAM_OUTPUT_LIMIT'; stop(); }
  });
  const exit = await new Promise(done => child.once('close', (exitCode, exitSignal) => done({ exitCode, exitSignal })));
  clearTimeout(timer); clearTimeout(hard); signal?.removeEventListener('abort', abort);
  const messages = stdout.split(/\r?\n/).filter(line => line.startsWith(PROGRAM_CASE_MARKER));
  let receipt = null;
  try { if (messages.length === 1) receipt = JSON.parse(messages[0].slice(PROGRAM_CASE_MARKER.length)); } catch {}
  if (!receipt || receipt.id !== id || receipt.variant !== variant || receipt.productSha256 !== input.productSha256
    || receipt.grokSha256 !== input.grokSha256) failure ??= 'COMPATIBILITY_PROGRAM_CHILD_RECEIPT_INVALID';
  const passed = !failure && exit.exitCode === 0 && exit.exitSignal === null && receipt?.passed === true
    && receipt.cleanupVerified === true && receipt.realCredentialsUsed === false && receipt.officialSearchCalls === 0
    && casePassed(id, receipt.observations);
  return { id, variant, status: passed ? 'passed' : 'failed', passed, ...exit,
    code: failure ?? receipt?.code ?? null, receipt };
}

export async function runProgramHost(options, { signal } = {}) {
  const result = { schemaVersion: 1, kind: 'compatibility-program-host', productSha256: options.productSha256,
    grokSha256: options.grokSha256, hostVersion: null, pluginVersion: null, realCredentialsUsed: false,
    officialSearchCalls: 0, cleanupVerified: false, passed: false,
    transport: 'loopback-responses-and-exact-registry-remap', installer: 'frozen-product-unmodified',
    cases: PROGRAM_CASE_IDS.map(id => ({ id, status: 'not-run', passed: false })), code: null };
  try {
    const input = validateProgramInputs(options);
    mkdirSync(input.outputRoot, { mode: 0o700 });
    for (const id of PROGRAM_CASE_IDS) {
      signal?.throwIfAborted();
      const runs = [];
      for (const variant of id === PROGRAM_CASE_IDS[1] ? ['disable', 'dispose'] : [null]) {
        const run = await childCase(input, id, variant, signal);
        runs.push(run);
        json(join(input.outputRoot, id + (variant ? '-' + variant : '') + '.json'), run);
        if (run.receipt) {
          result.hostVersion ??= run.receipt.hostVersion;
          result.pluginVersion ??= run.receipt.pluginVersion;
          insist(run.receipt.hostVersion === result.hostVersion && run.receipt.pluginVersion === result.pluginVersion,
            'COMPATIBILITY_PROGRAM_IDENTITY_MISMATCH');
          result.officialSearchCalls += run.receipt.officialSearchCalls ?? 0;
        }
      }
      result.cases[result.cases.findIndex(row => row.id === id)] = {
        id, status: runs.every(run => run.passed) ? 'passed' : 'failed', passed: runs.every(run => run.passed),
        observations: runs.length === 1 ? runs[0].receipt?.observations ?? null : {
          ...Object.fromEntries(['preparationStarted', 'callerReasonPreserved', 'preparationSettled',
            'upstreamDisconnectObserved', 'lateCompletionAttempted', 'lateCompletionNotPublished',
            'orphanProcesses0', 'configUnchanged', 'cacheSentinelUnchanged']
            .map(key => [key, runs.every(run => run.receipt?.observations?.[key] === true)])),
          activeCacheCommitted: runs.every(run => run.receipt?.observations?.activeCacheCommitted === false) ? false : null,
          programPhase: runs.every(run => run.receipt?.observations?.programPhase === 'disposed') ? 'disposed' : null,
          unexpectedRequests: runs.every(run => run.receipt?.observations?.unexpectedRequests === 0) ? 0 : null,
          variants: runs.map(run => ({ variant: run.variant, passed: run.passed,
            observations: run.receipt?.observations ?? null })),
        },
        runs,
      };
    }
    result.cleanupVerified = result.cases.every(row => row.runs?.every(run => run.receipt?.cleanupVerified === true
      && run.exitCode === 0 && run.exitSignal === null));
    result.passed = result.cleanupVerified && result.officialSearchCalls === 0 && result.cases.every(row => row.passed);
    if (!result.passed) result.code = 'COMPATIBILITY_PROGRAM_CASE_FAILED';
    json(join(input.outputRoot, 'program-summary.json'), result);
  } catch (failure) { result.code = safeCode(failure); }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === ownFile) {
  const controller = new AbortController(), stop = () => controller.abort(error('COMPATIBILITY_PROGRAM_CANCELLED'));
  const cancelMessage = message => { if (message?.type === 'compatibility-program-cancel') stop(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  process.on('message', cancelMessage);
  let receipt, child = false;
  try {
    const options = parseProgramArguments(process.argv.slice(2));
    child = Boolean(options.caseId);
    receipt = await (child ? runProgramCase(options, { signal: controller.signal })
      : runProgramHost(options, { signal: controller.signal }));
  } catch (failure) { receipt = { schemaVersion: 1, kind: 'compatibility-program-host', passed: false, code: safeCode(failure) }; }
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  process.off('message', cancelMessage);
  console.log((child ? PROGRAM_CASE_MARKER : PROGRAM_MARKER) + JSON.stringify(receipt));
  process.exitCode = receipt.passed ? 0 : 1;
  if (process.connected) process.disconnect();
}
