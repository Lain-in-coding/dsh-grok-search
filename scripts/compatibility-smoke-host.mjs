import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COMPATIBILITY_SMOKE_MARKER = 'DSH_COMPATIBILITY_SMOKE=';
const query = 'compatibility-smoke-direct';
const cancelQuery = 'compatibility-smoke-cancel';
const resultUrl = 'https://compatibility-smoke.invalid/synthetic-source';
const key = 'compatibility-smoke-synthetic-key';
const gateNames = ['package-admission', 'capabilities', 'search-no-official-fallback', 'cancellation'];
const hostPeers = ['cordis', 'dsh', 'dsh-app-boot', 'dsh-typert-protocol', 'dsh-web', 'schemastery'];
const insist = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const errorCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '')
  ? error.code : 'COMPATIBILITY_SMOKE_FAILED';
const selected = value => typeof value?.get === 'function' ? value.get() : value;
const idle = value => value?.running === 0 && value.queued === 0 && value.faulted === 0;
const containsSource = value => JSON.stringify(value ?? null).includes(resultUrl);
const counters = value => value ? {
  running: value.running ?? null, queued: value.queued ?? null, faulted: value.faulted ?? null,
} : null;

function inside(root, path) {
  insist(typeof root === 'string' && isAbsolute(root) && typeof path === 'string' && isAbsolute(path),
    'COMPATIBILITY_SMOKE_PATH_UNSAFE');
  const base = resolve(root), target = resolve(path), rel = relative(base, target);
  insist(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel),
    'COMPATIBILITY_SMOKE_PATH_UNSAFE');
  let current = base;
  for (const part of [null, ...rel.split(sep)]) {
    if (part !== null) current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    insist(!stat?.isSymbolicLink(), 'COMPATIBILITY_SMOKE_PATH_UNSAFE');
  }
  return target;
}

function loopbackEndpoint(value) {
  const url = new URL(value);
  insist(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
  'COMPATIBILITY_SMOKE_ENDPOINT_INVALID');
  return url.origin;
}

/** Only called for an explicitly requested, fresh isolated smoke profile. */
export function prepareCompatibilitySmoke({ directory, profile, endpoint }) {
  const base = loopbackEndpoint(endpoint), folder = inside(directory, join(profile, 'grok-search'));
  const executable = inside(directory, join(directory, 'intentionally-missing-grok-program'));
  insist(!existsSync(executable), 'COMPATIBILITY_SMOKE_PROGRAM_PRESENT');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const configPath = join(folder, 'compatibility-smoke.toml');
  const config = [
    `grok_api_url = ${JSON.stringify(base + '/disabled-grok')}`, 'grok_api_key = ""',
    `tavily_api_url = ${JSON.stringify(base)}`, `tavily_api_key = ${JSON.stringify(key)}`,
    'tavily_enabled = true', 'exa_enabled = false', 'tinyfish_enabled = false', 'firecrawl_enabled = false',
    'source_providers = ["tavily"]', 'fallback_sources = 3', 'response_max_chars = 6000', 'timeout_seconds = 10',
  ].join('\n') + '\n';
  writeFileSync(configPath, config, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(folder, 'preferences.json'), JSON.stringify({
    schemaVersion: 1, grokEnabled: false, githubEnabled: false, githubReadEnabled: false,
    sourceOrder: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
    sourceEnabled: { tavily: true, exa: false, tinyfish: false, firecrawl: false },
  }) + '\n', { flag: 'wx', mode: 0o600 });
  return { executable, configPath, budgetMs: 30_000 };
}

export function snapshotCompatibility(ctx, trace = {}) {
  const core = ctx.get('grokSearchCore')?.snapshot(), web = ctx.get('web');
  const compatibility = ctx.get('grokSearchCompatibility');
  return {
    compatibility: typeof compatibility?.report === 'function' ? compatibility.report() : null,
    officialSearchCalls: trace.calls?.original ?? null,
    runtimeWeb: web ? {
      searchProviderId: selected(web.searchProviderId ?? web.config?.searchProvider) ?? null,
      fetchProviderId: selected(web.fetchProviderId ?? web.config?.fetchProvider) ?? null,
    } : null,
    core: core ? {
      ...counters(core), routeExecutor: counters(core.routeExecutor),
      sessionConnected: core.session?.connected === true, sessionActive: core.session?.active === true,
      childStarted: Number.isSafeInteger(core.lastDiagnostic?.childPid),
    } : null,
    budgets: ctx.get('grokSearchBudgets')?.snapshot() ?? null,
  };
}

// A legacy package can reach execution checks without implementing the new
// coordinator. This predicate alone never passes its capabilities gate.
export function compatibilitySmokeReady(value, { requireReport = false } = {}) {
  if (!value?.core || value.runtimeWeb?.searchProviderId !== 'grok-search') return false;
  if (value.compatibility) return value.compatibility.coreReady === true
    && ['ready', 'degraded'].includes(value.compatibility.phase) && value.budgets?.owned > 0;
  return !requireReport && idle(value.core) && idle(value.core.routeExecutor);
}

function productEntryActive(ctx) {
  const entries = [...ctx.get('loader').entries()].filter(entry => entry.options.id === 'grok-search');
  if (entries.length !== 1) return false;
  const entry = entries[0], wrapper = entry.fiber, fiber = wrapper?.ctx?.fiber ?? wrapper;
  return entry.options.name === 'dsh-grok-search' && entry.options.disabled !== true
    && Boolean(wrapper?.uid && fiber?.uid) && fiber.state === 2 && !fiber.error;
}

/** Use the official native executor, including resolve/dispose on newer hosts. */
export async function invokeCompatibilitySearch(ctx, { queries = [query], modern = false, signal } = {}) {
  insist(Array.isArray(queries) && queries.length > 0 && queries.length <= 4
    && queries.every(value => typeof value === 'string' && value.startsWith('compatibility-smoke-')
      && value.length <= 100), 'COMPATIBILITY_SMOKE_QUERY_INVALID');
  const tools = ctx.get('tools'), agent = { session: { id: randomUUID() }, ctx }, callId = randomUUID();
  insist(typeof tools?.execute === 'function', 'COMPATIBILITY_SMOKE_NATIVE_TOOL_UNAVAILABLE');
  signal ??= new AbortController().signal;
  signal.throwIfAborted();
  if (!modern) return tools.execute({ name: 'web_search', arguments: { queries }, agent, callId, signal });
  const toolSet = await tools.resolve({ agent, modelSelection: { provider: 'compatibility-smoke' }, signal });
  try {
    const batch = await tools.execute({ agent, signal, toolSet,
      calls: [{ type: 'tool_call', id: callId, name: 'web_search', arguments: JSON.stringify({ queries }) }] });
    insist(batch?.results?.length === 1 && batch.results[0].result,
      'COMPATIBILITY_SMOKE_NATIVE_RESULT_INVALID');
    return batch.results[0].result;
  } finally { await toolSet.dispose(); }
}

async function until(check, code, signal, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    if (await check()) return;
    insist(performance.now() < deadline, code);
    await new Promise(done => setTimeout(done, 25));
  }
}

async function within(task, signal, timeoutMs = 15_000) {
  let timer, aborted;
  try {
    signal?.throwIfAborted();
    return await Promise.race([Promise.resolve(task), new Promise((_done, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('COMPATIBILITY_SMOKE_TIMEOUT'),
        { code: 'COMPATIBILITY_SMOKE_TIMEOUT' })), timeoutMs);
      if (signal) {
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
      }
    })]);
  } finally {
    clearTimeout(timer);
    if (aborted) signal.removeEventListener('abort', aborted);
  }
}

async function startTavily() {
  const state = { requests: [], active: 0, unexpected: 0, cancelled: 0, closed: false };
  const sockets = new Set();
  const server = createServer((request, response) => {
    let text = '', tooLarge = false;
    request.on('error', () => {});
    response.on('error', () => {});
    request.on('data', chunk => {
      if (Buffer.byteLength(text) + chunk.byteLength > 8192) { tooLarge = true; request.destroy(); }
      else text += chunk;
    });
    request.on('end', () => {
      let body;
      try { body = JSON.parse(text); } catch {}
      const valid = !tooLarge && request.method === 'POST' && request.url === '/search'
        && request.headers.authorization === `Bearer ${key}`
        && typeof body?.query === 'string' && body.query.startsWith('compatibility-smoke-')
        && body.query.length <= 100 && state.requests.length < 12;
      if (!valid) {
        state.unexpected++;
        response.writeHead(400); response.end('{}'); return;
      }
      const held = body.query === cancelQuery;
      const row = { query: body.query, held, cancelled: false };
      state.requests.push(row); state.active++;
      response.once('close', () => {
        state.active--;
        if (held && !response.writableEnded) { row.cancelled = true; state.cancelled++; }
      });
      if (held) return;
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ results: [{ url: resultUrl, title: 'Synthetic compatibility source',
        content: 'Loopback fixture response, not a live Tavily result.', score: 1 }], usage: { credits: 1 } }));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { state.unexpected++; socket.destroy(); });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); });
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`, state,
    async close() {
      await new Promise((done, fail) => {
        server.close(error => error ? fail(error) : done());
        server.closeAllConnections?.();
        for (const socket of sockets) socket.destroy();
      });
      state.closed = true;
    },
  };
}

const fixtureSource = `
const state = () => globalThis.__DSH_COMPATIBILITY_SMOKE__;
export function applyContext(ctx) {
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1; } });
  ctx.provide('candidateExistingDependency', { synthetic: true });
  ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: state().calls.original }) });
  ctx.effect(() => () => { state().disposed++; });
}
export function applyProviders(ctx) {
  ctx.web.registerSearchProvider({ id: 'candidate-original', available: () => true,
    async search() { state().calls.original++; return { sources: [], truncated: false }; } });
  ctx.web.registerFetchProvider({ id: 'candidate-fetch', available: () => true,
    async fetch(request) { state().calls.fetch++; return { url: request.url, statusCode: 200,
      body: { kind: 'text', content: 'Synthetic fetch control' }, truncated: false }; } });
}
`;

function prepareProfile(profile, directory, runtimeRoot) {
  const fixture = inside(directory, join(profile, 'node_modules', 'compatibility-smoke-fixture'));
  mkdirSync(fixture, { recursive: true, mode: 0o700 });
  writeFileSync(join(fixture, 'fixture.mjs'), fixtureSource, { flag: 'wx' });
  for (const label of ['context', 'providers']) {
    writeFileSync(join(fixture, label + '.mjs'), `export { apply${label === 'context' ? 'Context' : 'Providers'} as apply } from './fixture.mjs';\n`
      + `export const name = 'compatibility-smoke-${label}';\n`
      + `export const inject = ${JSON.stringify(label === 'providers' ? ['web'] : [])};\n`, { flag: 'wx' });
  }
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({
    name: 'compatibility-smoke-fixture', version: '0.0.0', private: true, type: 'module',
    exports: { './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml',
      './context': './context.mjs', './providers': './providers.mjs' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), { flag: 'wx' });
  const row = (id, name, config = {}) => ({ id, name: '@deepseek-ai/' + name, config });
  const modern = existsSync(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-tool-executor-native/package.json'));
  writeFileSync(join(fixture, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'fixture-context', name: 'compatibility-smoke-fixture/context' },
    row('timer', 'cordis-plugin-timer'), row('config-editor', 'dsh-config-editor'),
    row('tools', 'dsh-tools', modern ? {} : { mode: 'native' }),
    ...(modern ? [row('tool-executor-native', 'dsh-tool-executor-native')] : []),
    { ...row('web', 'dsh-web', { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' }),
      inject: ['candidateExistingDependency'] },
    row('tool-web', 'dsh-tool-web', { search: true, fetch: true, searchTimeoutMs: 30_000, fetchTimeoutMs: 30_000 }),
    { id: 'fixture-providers', name: 'compatibility-smoke-fixture/providers' },
  ] }]), { flag: 'wx' });
  const manifestPath = join(profile, 'package.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  insist(manifest.dependencies?.['dsh-grok-search'], 'COMPATIBILITY_SMOKE_PRODUCT_NOT_INSTALLED');
  manifest.dependencies['compatibility-smoke-fixture'] = '0.0.0';
  manifest.dsh = { profile: { bundles: ['compatibility-smoke-fixture', 'dsh-grok-search'] } };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { modern };
}

/** Executes only on explicit child invocation; unpack/install stays in the parent runner. */
export async function runCompatibilityHostProbe({ hostRoot, directory, installedProductDir, signal } = {}) {
  const gates = gateNames.map(id => ({ id, passed: false }));
  const receipt = { schemaVersion: 1, scope: 'official-host-synthetic-upstream', passed: false,
    realCredentialsUsed: false, originalProviderSynthetic: true, officialSearchCalls: 0,
    cleanupVerified: false, gates, code: null, hostVersion: null, pluginVersion: null, observations: {} };
  const trace = { calls: { original: 0, fetch: 0 }, disposed: 0 };
  let boot, starting, upstream, core, compatibility, web, cancellation;
  try {
    signal?.throwIfAborted();
    insist(typeof hostRoot === 'string' && isAbsolute(hostRoot), 'COMPATIBILITY_SMOKE_HOST_INVALID');
    const runtimeRoot = existsSync(join(hostRoot, 'dsh/package.json')) ? join(hostRoot, 'dsh') : resolve(hostRoot);
    const home = inside(directory, process.env.DSH_HOME);
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR',
      'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
      if (process.env[name]) inside(directory, process.env[name]);
    }
    const profile = inside(directory, join(home, 'profiles', 'candidate'));
    const expectedProduct = inside(directory, join(profile, 'node_modules', 'dsh-grok-search'));
    insist(typeof installedProductDir === 'string' && resolve(installedProductDir) === expectedProduct,
    'COMPATIBILITY_SMOKE_PRODUCT_NOT_INSTALLED');
    const forbidden = /^(?:(?:GROK|TAVILY|EXA|TINYFISH|FIRECRAWL|OPENAI|ANTHROPIC|DEEPSEEK)_|GH_TOKEN$|GITHUB_TOKEN$|NODE_OPTIONS$|NODE_PATH$|(?:HTTP|HTTPS|ALL)_PROXY$)/i;
    insist(!Object.entries(process.env).some(([name, value]) => value && forbidden.test(name)),
      'COMPATIBILITY_SMOKE_ENV_UNSAFE');
    const product = JSON.parse(readFileSync(join(expectedProduct, 'package.json'), 'utf8'));
    const host = JSON.parse(readFileSync(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
    insist(product.name === 'dsh-grok-search' && host.name === '@deepseek-ai/dsh',
      'COMPATIBILITY_SMOKE_IDENTITY_MISMATCH');
    insist(hostPeers.every(name => !existsSync(join(profile, 'node_modules', '@deepseek-ai', name))
      && !existsSync(join(expectedProduct, 'node_modules', '@deepseek-ai', name))),
    'COMPATIBILITY_SMOKE_HOST_COPY_INSTALLED');
    receipt.hostVersion = host.version; receipt.pluginVersion = product.version;
    const fixture = prepareProfile(profile, directory, runtimeRoot);
    upstream = await startTavily();
    const queryConfiguration = prepareCompatibilitySmoke({ directory, profile, endpoint: upstream.endpoint });
    writeFileSync(inside(directory, join(profile, 'cordis.patch.yml')),
      JSON.stringify([{ id: 'grok-search', config: queryConfiguration }]), { flag: 'wx', mode: 0o600 });
    globalThis.__DSH_COMPATIBILITY_SMOKE__ = trace;
    const imp = (name, file = 'lib/index.js') => import(pathToFileURL(
      join(runtimeRoot, 'node_modules', '@deepseek-ai', name, file)).href);
    const appBoot = await imp('dsh-app-boot'), { runProfile } = await imp('dsh', 'lib/profile-boot.js');
    signal?.throwIfAborted();
    starting = runProfile({
      environment: appBoot.loadLayeredEnv('dsh', directory), profile: 'candidate', patchFiles: [], args: [],
    }).then(value => { boot = value; return value; });
    await within(starting, signal, 45_000);
    await until(() => productEntryActive(boot.ctx),
      'COMPATIBILITY_SMOKE_PACKAGE_NOT_LOADED', signal, 30_000);
    gates[0].passed = true;
    receipt.observations.packageAdmission = { installedVersion: product.version, activeEntry: true, hostCopies: false };
    const requireReport = existsSync(join(expectedProduct, 'src/core/runtime-compat.mjs'));
    await until(() => compatibilitySmokeReady(snapshotCompatibility(boot.ctx, trace), {
      requireReport: requireReport || Boolean(boot.ctx.get('grokSearchCompatibility')),
    }),
      'COMPATIBILITY_SMOKE_CORE_NOT_READY', signal, 30_000);
    const before = snapshotCompatibility(boot.ctx, trace), report = before.compatibility;
    core = boot.ctx.get('grokSearchCore'); compatibility = boot.ctx.get('grokSearchCompatibility'); web = boot.ctx.get('web');
    if (report) {
      insist(report.hostVersion === host.version && report.pluginVersion === product.version
        && report.minimumAdmitted === true, 'COMPATIBILITY_SMOKE_IDENTITY_MISMATCH');
      gates[1].passed = true;
    }
    receipt.observations.capabilities = { reportAvailable: report !== null,
      evidence: report ? 'coordinator-report-and-execution' : 'execution-only-no-coordinator-report' };
    receipt.observations.initial = before;
    const direct = await within(web.search({ query, maxResults: 2 }, signal), signal);
    const native = await within(invokeCompatibilitySearch(boot.ctx, {
      queries: ['compatibility-smoke-native-1', 'compatibility-smoke-native-2'], modern: fixture.modern, signal,
    }), signal);
    const directMatched = containsSource(direct), nativeMatched = containsSource(native);
    receipt.observations.directSearch = { passed: directMatched, sourceMatched: directMatched };
    receipt.observations.nativeTool = { passed: native?.isError === false && nativeMatched,
      queries: 2, sourceMatched: nativeMatched, modern: fixture.modern, isError: native?.isError ?? null,
      errorCode: native?.isError === true ? errorCode(native.error?.info) : null };
    receipt.observations.searchRoute = { requests: upstream.state.requests.filter(row => !row.held).length,
      officialSearchCalls: trace.calls.original, unexpectedRequests: upstream.state.unexpected };
    insist(containsSource(direct) && native?.isError === false && containsSource(native)
      && upstream.state.requests.filter(row => !row.held).length === 3
      && trace.calls.original === 0 && upstream.state.unexpected === 0,
    'COMPATIBILITY_SMOKE_SEARCH_FAILED');
    gates[2].passed = true;
    const controller = new AbortController(), reason = Object.assign(new Error('COMPATIBILITY_SMOKE_CANCELLED'),
      { code: 'COMPATIBILITY_SMOKE_CANCELLED' });
    cancellation = { controller, reason };
    const task = web.search({ query: cancelQuery, maxResults: 2 }, controller.signal).then(
      () => ({ succeeded: true, callerReasonPreserved: false }),
      error => ({ succeeded: false, callerReasonPreserved: error === reason }));
    cancellation.task = task;
    await until(() => upstream.state.requests.some(row => row.held),
      'COMPATIBILITY_SMOKE_CANCEL_NOT_STARTED', signal);
    controller.abort(reason);
    const cancelled = await within(task, signal, 5000);
    await until(() => upstream.state.cancelled === 1 && upstream.state.active === 0,
      'COMPATIBILITY_SMOKE_CANCEL_NOT_CLEAN', signal, 5000);
    insist(!cancelled.succeeded && cancelled.callerReasonPreserved, 'COMPATIBILITY_SMOKE_CANCEL_FAILED');
    const recovered = await within(web.search({ query: 'compatibility-smoke-recovered', maxResults: 2 }, signal), signal);
    await until(() => upstream.state.active === 0 && idle(core.snapshot().routeExecutor),
      'COMPATIBILITY_SMOKE_CANCEL_NOT_CLEAN', signal, 5000);
    const after = snapshotCompatibility(boot.ctx, trace);
    insist(containsSource(recovered) && idle(after.core) && idle(after.core.routeExecutor)
      && !after.core.sessionConnected && !after.core.sessionActive && !after.core.childStarted
      && trace.calls.original === 0 && upstream.state.unexpected === 0,
    'COMPATIBILITY_SMOKE_CANCEL_NOT_CLEAN');
    gates[3].passed = true;
    gates[1].passed = true;
    receipt.observations.cancellation = { passed: true, callerReasonPreserved: true, upstreamCancelled: true, recovered: true };
    receipt.observations.final = after;
  } catch (error) {
    receipt.code = errorCode(error);
    if (boot) {
      try { receipt.observations.failure = snapshotCompatibility(boot.ctx, trace); } catch {}
    }
  }
  finally {
    let clean = false;
    try {
      cancellation?.controller.abort(cancellation.reason);
      if (cancellation?.task) await within(cancellation.task, undefined, 5000);
      if (starting && !boot) await within(starting, undefined, 5000).catch(() => {});
      if (boot) {
        core ??= boot.ctx.get('grokSearchCore');
        compatibility ??= boot.ctx.get('grokSearchCompatibility');
        web ??= boot.ctx.get('web');
      }
      if (boot) await within(boot.shutdown.shutdown(0), undefined, 15_000);
      if (upstream) await within(upstream.close(), undefined, 5000);
      const finalCore = core?.snapshot();
      clean = Boolean(boot && upstream?.state.closed && upstream.state.active === 0 && trace.disposed === 1
        && idle(finalCore) && idle(finalCore?.routeExecutor) && !finalCore?.session?.connected
        && !finalCore?.session?.active && finalCore?.stopping === true && finalCore?.routeExecutor?.stopping === true
        && (!compatibility || compatibility.report?.().phase === 'stopped')
        && !web?.searchProviders?.has('grok-search'));
    } catch (error) { receipt.code ??= errorCode(error); }
    finally {
      if (upstream && !upstream.state.closed) await upstream.close().catch(() => {});
      delete globalThis.__DSH_COMPATIBILITY_SMOKE__;
    }
    receipt.cleanupVerified = clean;
    receipt.officialSearchCalls = trace.calls.original;
    receipt.passed = clean && receipt.code === null && gates.every(gate => gate.passed);
    if (!receipt.passed) receipt.code ??= 'COMPATIBILITY_SMOKE_CLEANUP_FAILED';
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [hostRoot, directory, installedProductDir] = process.argv.slice(2);
  const controller = new AbortController();
  const stop = () => controller.abort(Object.assign(new Error('COMPATIBILITY_SMOKE_CANCELLED'),
    { code: 'COMPATIBILITY_SMOKE_CANCELLED' }));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const receipt = await runCompatibilityHostProbe({ hostRoot, directory, installedProductDir, signal: controller.signal });
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  console.log(COMPATIBILITY_SMOKE_MARKER + JSON.stringify(receipt));
  process.exitCode = receipt.passed ? 0 : 1;
}
