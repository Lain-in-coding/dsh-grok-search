import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

// Run under the official Electron runtime with ELECTRON_RUN_AS_NODE=1.
// Real Cordis, tools registry, pipeline and web_fetch; synthetic HTTP only.
const [archive, candidateDirectory] = process.argv.slice(2);
if (!archive) throw new Error('Provide an official app.asar path.');
const product = candidateDirectory ? resolve(candidateDirectory) : resolve(import.meta.dirname, '..');
const core = name => import(pathToFileURL(join(product, 'src/core', name + '.mjs')).href);
const { createSearchLog } = await core('search-log');
const { createToolRouteContext } = await core('tool-route-context');
const root = join(archive, 'dsh', 'node_modules', '@deepseek-ai');
const version = JSON.parse(readFileSync(join(archive, 'package.json'), 'utf8')).version;
for (const name of ['dsh-tools', 'dsh-web']) {
  assert.equal(JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8')).version, version);
}
const structuredGuards = /^0\.2\.2-rc\.(\d+)$/.exec(version)?.[1] >= 2;
const githubHost = pathToFileURL(join(product, 'src/core/github-host.mjs'));
const peerResolution = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-web' && context.parentURL === githubHost.href) {
    return { url: pathToFileURL(join(root, 'dsh-web/lib/index.js')).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
let createGithubIntegration;
try { ({ createGithubIntegration } = await import(githubHost.href)); }
finally { peerResolution.deregister(); }
const imp = name => import(pathToFileURL(join(root, name, 'lib/index.js')).href);
const { Context } = await imp('cordis');
const toolsModule = await imp('dsh-tools');
const webTools = await imp('dsh-tool-web');
const modern = existsSync(join(root, 'dsh-tool-executor-native/package.json'));
const app = new Context();
const log = createSearchLog(), routes = createToolRouteContext({ searchLog: log });
let github, owner, webFiber, apiCalls = 0, ordinaryFetch = 0, status = 200, count = 101;
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
try {
  await app.plugin(toolsModule.default);
  if (modern) await app.plugin(await imp('dsh-tool-executor-native'));
  app.on('tools/execute', (exec, next) => routes.run(exec, next), { global: true, prepend: true });
  app.on('tools/result', (exec, result) => routes.finalize(exec, result), { global: true });
  // Install official web tool first: exercises an already-installed tool.
  await app.plugin(webTools, { search: false, fetch: true, fetchMaxOutputChars: 7000 });
  owner = app.plugin({ name: 'github-candidate-test', apply(ctx) {
    github = createGithubIntegration({ ctx, getState: () => config, searchLog: log, callRoutes: routes, readerOptions: { fetchImpl } });
  } });
  await owner;
  assert.equal(app.tools.get('github_read'), undefined);
  config.enabled = true; github.sync();
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
    node: process.versions.node, modern, syntheticOnly: true,
    sourceHashes: files.map(name => ({ file: `src/core/${name}.mjs`,
      sha256: createHash('sha256').update(readFileSync(join(product, 'src/core', name + '.mjs'))).digest('hex') })),
    guardFormat: structuredGuards ? 'reason-object' : 'string', cases: [
    'default-off', 'registered-tool', 'pagination-and-continuation', 'agent-isolation', 'official-web-fetch',
    'host-output-cap', 'no-method-mutation', 'no-provider-change', 'one-record-per-call', 'no-body-log',
    'permission-denial', 'github-specific-denial', 'stop-before-body', '401', 'post-policy-denial',
    'structured-github-errors', 'invalid-cursor-preserves-other-agent', '401-preserves-other-agent',
    'post-policy-final-log', 'post-policy-scope-cursors',
    'disable-and-restore', 'no-web-provider', 'small-output-cap-no-dispatch', 'third-party-same-name', 'dispose',
  ], apiCalls }));
} finally {
  github?.dispose(); routes.dispose(); log.dispose();
  for (const runtime of [...app.registry.values()]) for (const fiber of [...runtime.fibers]) await fiber.dispose();
}
