import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

// Run with official Electron in Node mode (ASAR), or Node and an official CLI install root.
// Real Cordis, tools registry, pipeline and web_fetch; synthetic HTTP only.
function resolveHostInput(input) {
  const base = resolve(input), desktop = existsSync(join(base, 'dsh', 'package.json'));
  const runtime = desktop ? join(base, 'dsh') : base;
  const hostRoot = join(runtime, 'node_modules', '@deepseek-ai');
  const manifest = path => JSON.parse(readFileSync(path, 'utf8'));
  const host = manifest(join(hostRoot, 'dsh', 'package.json'));
  assert.equal(host.name, '@deepseek-ai/dsh', 'Expected the official CLI host package.');
  assert.equal(typeof host.version, 'string', 'Host version is required.');
  assert.match(host.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'Invalid host version.');
  if (desktop) {
    const app = manifest(join(base, 'package.json')), bundled = manifest(join(runtime, 'package.json'));
    const release = manifest(join(runtime, 'desktop-runtime.json'));
    assert.equal(app.name, '@deepseek-ai/dsh-desktop', 'Expected the official Desktop archive.');
    assert.equal(app.version, host.version, 'Desktop and CLI host versions differ.');
    // Desktop's container can be dsh-desktop-runtime, not the CLI package.
    assert.equal(bundled.version, app.version, 'Desktop runtime versions differ.');
    assert.equal(release.release?.version, app.version, 'Desktop release metadata differs.');
  }
  for (const name of ['dsh-tools', 'dsh-web', 'dsh-tool-web']) {
    const dependency = manifest(join(hostRoot, name, 'package.json'));
    assert.equal(dependency.name, `@deepseek-ai/${name}`, 'Unexpected host package identity.');
    assert.equal(dependency.version, host.version, 'Host package versions differ.');
  }
  return { hostRoot, version: host.version };
}
const [archive, candidateDirectory] = process.argv.slice(2);
if (!archive) throw new Error('Provide an official app.asar or CLI install root.');
const { hostRoot: root, version } = resolveHostInput(archive);
const product = candidateDirectory ? resolve(candidateDirectory) : resolve(import.meta.dirname, '..');
const core = name => import(pathToFileURL(join(product, 'src/core', name + '.mjs')).href);
const { createSearchLog } = await core('search-log');
const { createToolRouteContext } = await core('tool-route-context');
const { createGithubIntegration } = await core('github-host');
const imp = name => import(pathToFileURL(join(root, name, 'lib/index.js')).href);
const { Context } = await imp('cordis');
const { WebError } = await imp('dsh-web');
const toolsModule = await imp('dsh-tools');
const webTools = await imp('dsh-tool-web');
const modern = existsSync(join(root, 'dsh-tool-executor-native/package.json'));
const app = new Context();
const log = createSearchLog(), routes = createToolRouteContext({ searchLog: log });
let github, owner, webFiber, apiCalls = 0, ordinaryFetch = 0, status = 200, count = 101;
let structuredGuards = false, evaluatedCapabilities;
let capabilities = Object.freeze({ githubRead: false, githubFetch: false });
const config = { enabled: false, token: '' };
const originalFetch = async request => { ordinaryFetch++; return { url: request.url, statusCode: 200,
  body: { kind: 'text', content: 'ordinary fetch' }, truncated: false }; };
const web = { fetch: originalFetch, fetchProviderId: 'original', searchReady: () => false, fetchReady: () => true };
app.provide('web', web);
app.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1; } });
app.on('internal/plugin', fiber => {
  if (fiber.runtime?.name === 'tool-web' && fiber.uid !== null) {
    webFiber = fiber;
    Object.defineProperty(fiber, 'entry', { configurable: true, value: {
      options: { name: '@deepseek-ai/dsh-tool-web', config: { search: false, fetch: true, fetchMaxOutputChars: 7000 } },
    } });
  }
}, { global: true, prepend: true });
const answer = (body, code = 200, headers) => new Response(JSON.stringify(body), { status: code, headers });
const fetchImpl = async input => {
  apiCalls++;
  if (status !== 200) return answer({}, status);
  const parsed = new URL(input);
  if (!parsed.pathname.endsWith('/comments')) return answer({ id: 7, title: 'discussion', body: 'root' });
  const per = Number(parsed.searchParams.get('per_page')), page = Number(parsed.searchParams.get('page'));
  const rows = Array.from({ length: count }, (_, i) => ({ id: i + 20, body: `item-${i} ` + 'text '.repeat(20) }));
  return answer(rows.slice((page - 1) * per, page * per), 200, page * per < count
    ? { link: `<https://api.github.com${parsed.pathname}?per_page=${per}&page=${page + 1}>; rel="next"` } : {});
};
function evaluateFixtureCapabilities(ctx) {
  const tools = ctx.get('tools'), checkGuard = tools?.checkGuards ?? tools?.guardReason;
  assert.equal(typeof WebError, 'function', 'the official host must supply WebError');
  for (const method of ['register', 'get', 'guard']) assert.equal(typeof tools?.[method], 'function');
  assert.equal(typeof checkGuard, 'function', 'the host must expose its guard decision');
  const execution = { name: `github_contract_${randomUUID().replaceAll('-', '')}`,
    arguments: {}, callId: randomUUID(), signal: new AbortController().signal };
  const reason = 'GitHub validator capability sentinel';
  const removeGuard = tools.guard(exec => exec === execution ? reason : undefined);
  let guardsPassed = false;
  try {
    assert.equal(typeof removeGuard, 'function');
    const denial = checkGuard.call(tools, execution);
    structuredGuards = denial !== null && typeof denial === 'object' && denial.reason === reason;
    guardsPassed = denial === reason || structuredGuards;
    assert.equal(guardsPassed, true, 'the registered guard must deny the exact sentinel');
  } finally { removeGuard?.(); }
  assert.equal(checkGuard.call(tools, execution), undefined, 'the sentinel guard must be removed');
  const sentinelFetch = () => { throw new Error('Capability checks never fetch.'); };
  let observedGet = false, intercepted = false;
  const removeGet = ctx.on('internal/get', (caller, key, _error, next) => {
    const service = next();
    if (key !== 'web' || caller?.fiber?.uid !== ctx.fiber.uid || !service) return service;
    observedGet = true;
    return new Proxy(service, { get(target, property, receiver) {
      return property === 'fetch' ? sentinelFetch : Reflect.get(target, property, receiver);
    } });
  }, { global: true, prepend: true });
  try {
    assert.equal(typeof removeGet, 'function');
    intercepted = ctx.web.fetch === sentinelFetch && observedGet;
  } finally { removeGet?.(); }
  return Object.freeze({
    githubRead: guardsPassed,
    githubFetch: guardsPassed && intercepted && typeof tools.get('web_fetch')?.execute === 'function',
  });
}
try {
  await app.plugin(toolsModule.default);
  if (modern) await app.plugin(await imp('dsh-tool-executor-native'));
  app.on('tools/execute', (exec, next) => routes.run(exec, next), { global: true, prepend: true });
  app.on('tools/result', (exec, result) => routes.finalize(exec, result), { global: true });
  // Install official web tool first: exercises an already-installed tool.
  await app.plugin(webTools, { search: false, fetch: true, fetchMaxOutputChars: 7000 });
  owner = app.plugin({ name: 'github-candidate-test', inject: ['web', 'tools'], apply(ctx) {
    evaluatedCapabilities = evaluateFixtureCapabilities(ctx);
    assert.deepEqual(evaluatedCapabilities, { githubRead: true, githubFetch: true });
    github = createGithubIntegration({ ctx, WebError, getCapabilities: () => capabilities,
      getState: () => config, searchLog: log, callRoutes: routes, readerOptions: { fetchImpl } });
  } });
  await owner;
  assert.equal(app.tools.get('github_read'), undefined);
  config.enabled = true; github.sync();
  assert.equal(app.tools.get('github_read'), undefined, 'user consent alone cannot bypass pending capability admission');
  capabilities = evaluatedCapabilities; github.sync();
  assert.equal(app.tools.get('github_read'), github.definition);
  const agent = { session: { id: randomUUID() }, ctx: app };
  const identities = new WeakMap();
  const call = async (name, args, target = agent) => {
    const signal = new AbortController().signal, callId = randomUUID();
    const settled = result => { identities.set(result, { callId, sessionId: target.session.id }); return result; };
    if (!modern) return settled(await app.tools.execute({ name, arguments: args, agent: target, callId, signal }));
    const toolSet = await app.tools.resolve({ agent: target, modelSelection: { provider: 'test' }, signal });
    try {
      const result = await app.tools.execute({ agent: target, signal, toolSet,
        calls: [{ type: 'tool_call', id: callId, name, arguments: JSON.stringify(args) }] });
      return settled(result.results[0].result);
    } finally { toolSet.dispose(); }
  };
  const url = 'https://github.com/octocat/example/issues/7';
  const cursorOf = result => {
    const cursor = /cursor="([^"]+)"/.exec(result.content[0].text)?.[1];
    assert.ok(cursor, JSON.stringify(result));
    return cursor;
  };
  const initial = await call('github_read', { url });
  assert.notEqual(initial.isError, true, JSON.stringify(initial));
  assert.match(initial.content[0].text, /github_read/);
  const cursor = cursorOf(initial);
  const continued = await call('github_read', { url, cursor });
  assert.notEqual(continued.isError, true, JSON.stringify(continued));
  const wrongAgent = await call('github_read', { url, cursor }, { session: { id: agent.session.id }, ctx: app });
  assert.equal(wrongAgent.isError, true);
  assert.equal(wrongAgent.error?.info?.code, 'GITHUB_CURSOR_INVALID');
  const beforeDivert = apiCalls;
  const diverted = await call('web_fetch', { url });
  assert.notEqual(diverted.isError, true, JSON.stringify(diverted));
  assert.match(diverted.content[0].text, /github_read/);
  assert.ok(diverted.content[0].text.length <= 7000);
  assert.ok(apiCalls > beforeDivert);
  assert.equal(ordinaryFetch, 0);
  assert.equal(web.fetch, originalFetch);
  assert.equal(web.fetchProviderId, 'original');
  const view = log.snapshot(randomUUID()).records;
  assert.equal(view.filter(row => row.recordType === 'github').length, 4);
  assert.ok(view.every(row => !JSON.stringify(row).includes('text text')));
  const otherAgent = { session: { id: agent.session.id }, ctx: app };
  const kept = await call('github_read', { url }, otherAgent);
  const keptCursor = cursorOf(kept);
  const invalidCursor = await call('github_read', { url, cursor: 'unknown-cursor' });
  assert.equal(invalidCursor.error?.info?.code, 'GITHUB_CURSOR_INVALID');
  assert.equal((await call('github_read', { url, cursor: keptCursor }, otherAgent)).isError, false);
  status = 401;
  const invalid = await call('github_read', { url });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.error?.info?.code, 'GITHUB_AUTH');
  assert.match(invalid.content[0].text, /401/);
  status = 200;
  assert.equal((await call('github_read', { url, cursor: keptCursor }, otherAgent)).isError, false);
  const beforeDenied = apiCalls;
  const denial = reason => structuredGuards ? { reason, info: { name: 'PermissionError', code: 'PERMISSION_DENIED' } } : reason;
  const removeGuard = app.tools.guard(exec => ['github_read', 'web_fetch'].includes(exec.name) ? denial('explicit test denial') : undefined);
  assert.equal((await call('github_read', { url })).isError, true);
  assert.equal((await call('web_fetch', { url })).isError, true);
  assert.equal(apiCalls, beforeDenied);
  removeGuard();
  const denyGithubOnly = app.tools.guard(exec => exec.name === 'github_read' ? denial('GitHub-specific denial') : undefined);
  const deniedViaWeb = await call('web_fetch', { url });
  assert.equal(deniedViaWeb.isError, true);
  assert.equal(deniedViaWeb.error?.info?.code, 'GITHUB_PERMISSION');
  assert.equal(apiCalls, beforeDenied);
  denyGithubOnly();
  const stopBeforeBody = app.on('tools/execute', (exec, next) => {
    if (exec.name === 'web_fetch') { config.enabled = false; github.sync(); }
    return next();
  });
  assert.equal((await call('web_fetch', { url })).isError, true);
  assert.equal(ordinaryFetch, 0, 'stop during an accepted GitHub call must not silently switch to original fetch');
  stopBeforeBody(); config.enabled = true; github.sync();
  const deniedScope = await call('github_read', { url });
  const survivingScope = await call('github_read', { url }, otherAgent);
  const deniedCursor = cursorOf(deniedScope), survivingCursor = cursorOf(survivingScope);
  const rejectAfterRead = app.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name === 'github_read' && exec.agent === agent) return {
      kind: 'block', feedback: [{ type: 'text', text: 'post-policy denial' }],
      ...structuredGuards ? { info: { name: 'PermissionError', code: 'PERMISSION_DENIED' } } : {},
    };
    return next();
  });
  const blocked = await call('github_read', { url });
  assert.equal(blocked.isError, true);
  const blockedId = identities.get(blocked);
  const blockedLog = log.snapshot(randomUUID()).records.find(row =>
    row.callId === blockedId.callId && row.sessionId === blockedId.sessionId);
  assert.equal(blockedLog?.kind, 'failed');
  assert.equal(routes.read(blockedId.sessionId, blockedId.callId).state, 'failed');
  if (structuredGuards) {
    assert.equal(blocked.error?.info?.code, 'PERMISSION_DENIED');
    assert.equal(blockedLog.reason, 'PERMISSION_DENIED');
  }
  rejectAfterRead();
  assert.equal((await call('github_read', { url, cursor: deniedCursor })).error?.info?.code, 'GITHUB_CURSOR_INVALID');
  assert.equal((await call('github_read', { url, cursor: survivingCursor }, otherAgent)).isError, false);
  const beforeRevoked = { apiCalls, ordinaryFetch };
  try {
    capabilities = Object.freeze({ ...evaluatedCapabilities, githubFetch: false });
    const fetchBlocked = await call('web_fetch', { url });
    assert.equal(fetchBlocked.isError, true);
    assert.equal(fetchBlocked.error?.info?.code, 'GITHUB_FETCH_UNAVAILABLE');
    assert.equal(app.tools.get('github_read'), github.definition, 'fetch-only revocation must preserve the direct tool');
    assert.deepEqual({ apiCalls, ordinaryFetch }, beforeRevoked);
    capabilities = Object.freeze({ githubRead: false, githubFetch: false }); github.sync();
    assert.equal(config.enabled, true, 'capability revocation must not change user consent');
    assert.equal(app.tools.get('github_read'), undefined);
    assert.equal((await call('github_read', { url })).isError, true);
    const revoked = await call('web_fetch', { url });
    assert.equal(revoked.isError, true);
    assert.equal(revoked.error?.info?.code, 'GITHUB_FETCH_UNAVAILABLE');
    assert.deepEqual({ apiCalls, ordinaryFetch }, beforeRevoked,
      'revoked GitHub capability must dispatch neither GitHub HTTP nor the original fetch');
  } finally { capabilities = evaluatedCapabilities; github.sync(); }
  assert.equal(app.tools.get('github_read'), github.definition);
  config.enabled = false; github.sync();
  assert.equal(app.tools.get('github_read'), undefined);
  assert.equal((await call('github_read', { url })).isError, true);
  const ordinary = await call('web_fetch', { url });
  assert.match(ordinary.content[0].text, /ordinary fetch/);
  assert.equal(ordinaryFetch, 1);
  config.enabled = true; github.sync();
  // Unavailable web retrieval must not disable the independent GitHub tool.
  web.fetchReady = () => false;
  count = 0;
  assert.notEqual((await call('github_read', { url })).isError, true);
  web.fetchReady = () => true;
  const beforeSmallCap = apiCalls;
  await webFiber.update({ search: false, fetch: true, fetchMaxOutputChars: 1000 }, true);
  await webFiber.await?.();
  const smallCap = await call('web_fetch', { url });
  assert.equal(smallCap.isError, true, 'too little room for the output envelope must fail before dispatch');
  assert.equal(apiCalls, beforeSmallCap, 'a nonpositive body budget must not become the default budget');
  await webFiber.dispose();
  await app.plugin({ name: 'third-party-fetch', inject: ['tools'], apply(ctx) {
    ctx.tools.register(toolsModule.defineTool({
      name: 'web_fetch', description: 'Third-party tool', parameters: { url: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => (await ctx.web.fetch({ url: args.url })).body.content,
    }));
  } });
  const beforeThird = apiCalls;
  assert.match((await call('web_fetch', { url })).content[0].text, /ordinary fetch/);
  assert.equal(apiCalls, beforeThird);
  await owner.dispose();
  assert.equal(app.tools.get('github_read'), undefined);
  assert.equal(github.reader.snapshot().bytes, 0);
  const files = ['github-host', 'github-read', 'search-log', 'tool-route-context'];
  console.log(JSON.stringify({ passed: true, version,
    candidate: JSON.parse(readFileSync(join(product, 'package.json'), 'utf8')).version,
    node: process.versions.node, modern, syntheticOnly: true, evaluatedCapabilities,
    sourceHashes: files.map(name => ({ file: `src/core/${name}.mjs`,
      sha256: createHash('sha256').update(readFileSync(join(product, 'src/core', name + '.mjs'))).digest('hex') })),
    guardFormat: structuredGuards ? 'reason-object' : 'string', cases: [
    'default-off', 'evaluated-capability-contracts', 'pending-capability-no-registration',
    'registered-tool', 'pagination-and-continuation', 'agent-isolation', 'official-web-fetch',
    'host-output-cap', 'no-method-mutation', 'no-provider-change', 'one-record-per-call', 'no-body-log',
    'permission-denial', 'github-specific-denial', 'stop-before-body', '401', 'post-policy-denial',
    'structured-github-errors', 'invalid-cursor-preserves-other-agent', '401-preserves-other-agent',
    'post-policy-final-log', 'post-policy-scope-cursors',
    'fetch-only-capability-revocation', 'revoked-capability-no-original-fetch',
    'disable-and-restore', 'no-web-provider', 'small-output-cap-no-dispatch', 'third-party-same-name', 'dispose',
  ], apiCalls }));
} finally {
  github?.dispose(); routes.dispose(); log.dispose();
  for (const runtime of [...app.registry.values()]) for (const fiber of [...runtime.fibers]) await fiber.dispose();
}
