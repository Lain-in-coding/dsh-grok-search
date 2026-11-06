import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';
import { createSharedConfigStore, resolveSharedConfigPath, CONFIG_FIELDS } from '../src/core/shared-config.mjs';
import { cleanEnvironment, commandResult, freshRun, project, receipt, redact, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

// Official runtime/ASAR, not a packaged Desktop renderer acceptance.
// Uses an isolated profile and read-only links to existing exact dependencies.
const live = process.argv.includes('--allow-live');
const arguments_ = process.argv.slice(2).filter(value => value !== '--allow-live');
const tarball = resolve(arguments_[0]);
const executables = arguments_.slice(1);
if (!executables.length) throw new Error('Provide a tested tarball and official runtime executables.');
const run = freshRun(live ? 'search-log-host-live' : 'search-log-host');
const root = mkdtempSync(join(tmpdir(), 'dsh-search-log-host-'));
const results = [], children = [], privateValues = [];
const sanitize = value => redact(String(value), [[root, '<ISOLATED_RUN>']], privateValues);
const sourceHashes = ['src/client.js', 'src/settings-ui.mjs', 'src/core/routed-search.mjs',
  'src/core/source-adapters.mjs', 'src/core/search-log.mjs', 'src/core/account-quota.mjs',
  'scripts/internal-candidate-host.mjs', 'scripts/verify-search-log-host.mjs'].map(file => ({ file, sha256: sha256(join(project, file)) }));
const packageReceipt = JSON.parse(readFileSync(join(resolve(tarball, '..'), 'package-receipt.json'), 'utf8'));
assert.equal(sha256(tarball), packageReceipt.sha256);
for (const row of packageReceipt.sourceHashes) assert.equal(sha256(join(project, row.file)), row.sha256);
const livePath = live ? resolveSharedConfigPath() : null;
const liveHash = live ? sha256(livePath) : null;
const liveEnvironment = {};
if (live) {
  const fields = createSharedConfigStore({ path: livePath }).readEffective();
  for (const [key, spec] of Object.entries(CONFIG_FIELDS)) {
    const value = fields[key].value;
    liveEnvironment[spec.env] = Array.isArray(value) ? value.join(',') : String(value);
    if (spec.type === 'secret' && value) privateValues.push(value, ...value.split(',').filter(Boolean));
  }
}
let sourceMode = 'ok', sourceCalls = 0, quotaCalls = 0, fatal;
const upstream = createServer(async (request, response) => {
  for await (const chunk of request) { /* Drain only; never retain query bodies or headers. */ }
  response.setHeader('content-type', 'application/json');
  if (request.url === '/usage') {
    quotaCalls++;
    response.end(JSON.stringify({ account: { plan_usage: 7, plan_limit: 100 }, key: { usage: 2, limit: 10 } }));
  } else if (request.url === '/search') {
    sourceCalls++;
    response.writeHead(sourceMode === 'ok' ? 200 : 401);
    response.end(JSON.stringify(sourceMode === 'ok'
      ? { results: [{ url: 'https://example.test/verified', title: 'isolated result', content: 'isolated source' }], usage: { credits: 1 } }
      : { error: 'synthetic failure' }));
  } else { response.writeHead(404); response.end('{}'); }
});
await new Promise(done => upstream.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${upstream.address().port}`;
const inside = path => {
  const rel = relative(root, path);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'operation must stay in new isolated root');
  return path;
};
async function start(runtime, folder) {
  const child = spawn(runtime.executable, ['--expose-internals', join(project, 'scripts/internal-candidate-host.mjs'), runtime.archivePath, folder], {
    cwd: folder, env: cleanEnvironment(folder, { DSH_HOME: join(folder, 'dsh-home'),
      ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: runtime.executable, ...liveEnvironment }),
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let ended = false, stderr = '', serial = 0;
  const messages = [], pending = new Map();
  const closed = new Promise(done => child.once('close', code => { ended = true; done(code); }));
  child.on('error', error => messages.push({ type: 'fatal', error: { message: error.message } }));
  child.stdout.on('data', () => {});
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.on('message', message => {
    if (message.type !== 'reply') { messages.push(message); return; }
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.ok) item.resolve(message.value); else item.reject(new Error(message.error.message));
  });
  const host = {
    child, closed,
    request(op) {
      const id = `log-host-${++serial}`;
      return new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host operation timed out: ' + op)); }, 20_000);
        pending.set(id, { resolve: resolveReply, reject, timer });
        child.send({ id, op }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
      });
    },
    async close() {
      if (!ended) {
        try { await host.request('close'); } catch { if (!ended) child.kill(); }
        const timer = setTimeout(() => { if (!ended) child.kill(); }, 15_000);
        await closed; clearTimeout(timer);
      }
      for (const item of pending.values()) clearTimeout(item.timer);
      return sanitize(stderr);
    },
  };
  children.push(host);
  child.send({ productWiring: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const failure = messages.find(row => row.type === 'fatal');
    if (failure) throw new Error(sanitize(failure.error.message));
    const ready = messages.find(row => row.type === 'ready'), listening = messages.find(row => row.type === 'listening');
    if (ready && listening) {
      assert.deepEqual(ready.failed, []);
      const auth = await fetch(listening.authUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0];
      assert.ok(cookie);
      privateValues.push(cookie, cookie.split('=')[1]);
      const rpc = async (method, request) => {
        const response = await fetch(listening.origin + '/api/grokSearchSettings/' + method, {
          method: 'POST', headers: { 'content-type': 'application/json', Origin: listening.origin, Cookie: cookie },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'grokSearchSettings/' + method,
            payload: { args: request === undefined ? {} : { request } } }), signal: AbortSignal.timeout(20_000),
        });
        const message = await response.json();
        const result = message.result;
        if (!result?.ok) throw new Error(`RPC ${method} failed: ${result?.error?.code || response.status}`);
        return result.value;
      };
      return { host, rpc, ready };
    }
    if (ended) throw new Error('Runtime exited: ' + sanitize(stderr));
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Official runtime did not become ready.');
}
try {
  for (const executable of executables) {
    sourceMode = 'ok';
    const runtime = candidateRuntime(executable), version = runtime.app.version;
    const folder = inside(join(root, version));
    mkdirSync(folder, { recursive: true });
    const profile = join(folder, 'dsh-home/profiles/candidate'), modules = join(profile, 'node_modules');
    mkdirSync(modules, { recursive: true });
    const extracted = await commandResult('tar.exe', ['-xf', tarball, '-C', folder], { timeoutMs: 30_000, sanitize });
    writeJson(join(run.directory, version + '-extract.json'), receipt(extracted));
    assert.equal(extracted.exitCode, 0);
    const product = inside(join(modules, 'dsh-grok-search'));
    renameSync(inside(join(folder, 'package')), product);
    symlinkSync(join(project, 'node_modules'), join(product, 'node_modules'), 'junction');
    for (const file of packageReceipt.files) assert.equal(sha256(join(product, file.path)), sha256(join(project, file.path)));
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-log-host', private: true, type: 'module',
      dependencies: { 'dsh-grok-search': packageReceipt.version } }));
    writeFileSync(join(folder, 'isolated-not-configured.toml'), live ? '# Real configuration supplied only via isolated child environment.\n'
      : `tavily_api_key = "synthetic-log-test"\ntavily_api_url = "${origin}"\nsource_providers = ["tavily"]\n`);
    mkdirSync(join(profile, 'grok-search'));
    const preferences = createPrivatePreferences({ path: join(profile, 'grok-search/preferences.json') });
    const preference = preferences.snapshot();
    preferences.save(preference.revision, { ...preference.value, grokEnabled: false, githubEnabled: false });
    const before = { exe: sha256(runtime.executable), asar: sha256(runtime.archivePath) };
    const { host, rpc } = await start(runtime, folder);
    const snapshot = await rpc('snapshot');
    assert.equal(snapshot.capabilities.secretsAllowed, true);
    const sessionId = randomUUID();
    assert.deepEqual(await rpc('readSearchLog', { sessionId }), { records: [] });
    const answer = await host.request('direct-search');
    assert.equal(answer.ok, true, sanitize(JSON.stringify(answer)));
    const rows = (await rpc('readSearchLog', { sessionId })).records;
    assert.equal(rows.length, 1);
    // Codes and provider ids only (no query, URL, key or upstream text), so a
    // live mismatch reports which source failed before another one answered.
    const route = sanitize(JSON.stringify({ kind: rows[0].kind, served: rows[0].served, reason: rows[0].reason,
      calls: rows[0].calls.map(call => ({ provider: call.provider, operation: call.operation,
        result: call.result, code: call.code, keyIndex: call.keyIndex })) }));
    assert.equal(rows[0].kind, 'sources', 'Route: ' + route);
    assert.equal(rows[0].served, 'tavily', 'Route: ' + route);
    if (!live) assert.equal(rows[0].calls[0].charge.amount, 1);
    else assert.equal(rows[0].calls[0].charge.basis, 'reported');
    assert.equal(rows[0].official, null);
    const quota = await rpc('accountQuota', { provider: 'tavily', expectedRevision: snapshot.config.revision,
      quotaRevision: snapshot.config.quotaRevision, operationId: randomUUID() });
    if (!live) {
      assert.equal(quota.value.remaining, 93);
      assert.equal(quota.value.keyRemaining, 8);
      sourceMode = 'failed';
      assert.equal((await host.request('direct-search')).ok, false);
      assert.equal((await rpc('readSearchLog', { sessionId })).records[0].kind, 'failed');
    } else assert.ok(Number.isFinite(quota.value.remaining));
    assert.equal((await host.request('snapshot')).calls.original, 0);
    await rpc('clearSearchLog', { sessionId });
    assert.deepEqual(await rpc('readSearchLog', { sessionId }), { records: [] });
    await rpc('closeSearchLog', { sessionId });
    await host.close();
    assert.deepEqual({ exe: sha256(runtime.executable), asar: sha256(runtime.archivePath) }, before);
    results.push({ version, passed: true, checks: ['same-tarball', 'authenticated-log-rpc', 'source-only-result',
      'reported-credits', live ? 'live-custom-endpoint-quota-rpc' : 'real-loopback-quota-rpc',
      ...(!live ? ['all-failed-no-official'] : []), 'clear-and-close', 'official-files-unchanged'],
      officialSearchCount: 0, counterScope: 'isolated-original-provider-fixture', privateQueriesRecordedInArtifacts: false });
  }
} catch (error) { fatal = sanitize(error.stack || error); }
finally {
  for (const host of children) await host.close().catch(error => { fatal ??= sanitize(error.message); });
  upstream.closeAllConnections();
  await new Promise(done => upstream.close(done));
  const sharedConfigUnchanged = live ? sha256(livePath) === liveHash : null;
  if (sharedConfigUnchanged === false) fatal ??= 'Shared configuration changed during verification.';
  const summary = { runId: run.runId, passed: !fatal, results, fatal, sourceCalls, quotaCalls, sourceHashes,
    tarballSha256: packageReceipt.sha256,
    scope: live ? 'official-ASAR-runtime-live-tavily-with-environment-only-credentials' : 'official-ASAR-runtime-with-loopback-upstream',
    sharedConfigUnchanged, desktopRendererVerified: false, paidProviderVerified: live,
    dependenciesInstalled: false, published: false };
  writeJson(join(run.directory, 'summary.json'), summary);
  console.log(JSON.stringify({ runId: run.runId, passed: !fatal, results, fatal }));
  process.exitCode = fatal ? 1 : 0;
}
