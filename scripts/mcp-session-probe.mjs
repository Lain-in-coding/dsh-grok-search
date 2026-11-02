import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createManagedMcpSearch, runMcpSearch } from '../src/core/mcp-search.mjs';
import { createGrokProvider } from '../src/provider.mjs';
import { freshRun, project, sha256, writeJson, cleanEnvironment } from './lib/internal-candidate-utils.mjs';

const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== '--runtime-root'
  || args.length === 4 && args[2] !== '--grok-executable') throw new Error('Usage: node scripts/mcp-session-probe.mjs --runtime-root <isolated-runtime> [--grok-executable <existing-binary>]');
const runtime = resolve(args[1]);
const grokExecutable = args[3] ? resolve(args[3]) : null;
const sdkVersion = JSON.parse(readFileSync(join(runtime, 'node_modules/@modelcontextprotocol/client/package.json'), 'utf8')).version;
assert.equal(sdkVersion, JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).dependencies['@modelcontextprotocol/client']);
const { runId, directory } = freshRun('mcp-session');
const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-session-'));
const configPath = join(root, 'config.toml');
writeFileSync(configPath, '# synthetic offline configuration\n', { flag: 'wx' });
const sdkUrl = pathToFileURL(join(runtime, 'node_modules/@modelcontextprotocol/client/dist/index.mjs')).href;
const sdkFactory = () => import(sdkUrl);
const overrides = cleanEnvironment(root, Object.fromEntries(Object.keys(process.env)
  .filter(key => /^(GROK_SEARCH_|TAVILY_|EXA_|TINYFISH_|FIRECRAWL_|GITHUB_TOKEN$|OPENAI_COMPATIBLE_)/i.test(key)).map(key => [key, null])));
const base = { executable: process.execPath, executableArgs: [join(project, 'fixtures/mcp/grok-server.mjs'), 'structured'],
  configPath, sdkFactory, envOverrides: overrides, request: { query: 'offline-only' }, remainingMs: () => 5_000, cleanupMs: 1_000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = result => JSON.parse(result.content).childPid;
const checks = [];
async function check(name, run) {
  try { const detail = await run(); checks.push({ name, status: 'pass', ...detail }); }
  catch (error) { checks.push({ name, status: 'fail', error: { code: error.code ?? null, message: error.message } }); throw error; }
}
let fatal;
try {
  await check('one-shot-compatible-and-reaped', async () => {
    const result = await runMcpSearch(base);
    assert.equal(result.diagnostic.exited, true);
    assert.equal(alive(pidOf(result)), false);
    return { pid: pidOf(result) };
  });
  await check('serial-reuse-same-pid-and-dispose', async () => {
    const session = createManagedMcpSearch();
    const pids = [];
    try {
      for (let index = 0; index < 10; index++) {
        const result = await session.run(base);
        pids.push(pidOf(result));
        assert.equal(result.diagnostic.exited, false);
      }
      assert.equal(new Set(pids).size, 1);
    } finally { await session.dispose(); }
    assert.equal(alive(pids[0]), false);
    return { queries: pids.length, uniqueProcesses: new Set(pids).size };
  });
  await check('shared-output-budget-honours-file-env-and-rejects-invalid-TOML', async () => {
    const session = createManagedMcpSearch();
    try {
      writeFileSync(configPath, 'response_max_chars = 100\n');
      const small = await session.run(base);
      assert.ok(JSON.stringify(small).length <= 100);
      assert.equal(small.truncated, true);
      writeFileSync(configPath, 'response_max_chars = 45000\n');
      const normal = await session.run(base);
      assert.ok(JSON.stringify(normal).length > 100);
      assert.equal(normal.truncated, false);
      const fromEnvironment = await session.run({ ...base,
        envOverrides: { ...base.envOverrides, GROK_SEARCH_RESPONSE_MAX_CHARS: '100' } });
      assert.ok(JSON.stringify(fromEnvironment).length <= 100);
      assert.equal(fromEnvironment.truncated, true);
      writeFileSync(configPath, 'response_max_chars = invalid-TOML\n');
      await assert.rejects(session.run(base), { code: 'GROK_CONFIG_INVALID' });
      return { fileBudget: true, environmentOverride: true, invalidConfigRejected: true };
    } finally { await session.dispose(); writeFileSync(configPath, '# synthetic offline configuration\n'); }
  });
  await check('implicit-default-config-reuse-and-environment-selection-invalidate', async () => {
    const session = createManagedMcpSearch();
    const implicit = { ...base, configPath: undefined };
    const pids = [];
    try {
      pids.push(pidOf(await session.run(implicit)));
      pids.push(pidOf(await session.run(implicit)));
      assert.equal(pids[0], pids[1]);
      // Explicit environment selection also participates in identity.
      pids.push(pidOf(await session.run({ ...implicit, envOverrides: { ...overrides, GROK_SEARCH_CONFIG: configPath } })));
      assert.notEqual(pids[0], pids[2]);
      assert.equal(alive(pids[0]), false);
    } finally { await session.dispose(); }
    assert.equal(alive(pids[2]), false);
  });
  await check('config-and-environment-identity-retire-before-replacement', async () => {
    const session = createManagedMcpSearch();
    const pids = [];
    try {
      pids.push(pidOf(await session.run(base)));
      writeFileSync(configPath, '# new configuration revision\n');
      pids.push(pidOf(await session.run(base)));
      assert.equal(alive(pids[0]), false);
      pids.push(pidOf(await session.run({ ...base, envOverrides: { ...overrides, GROK_FIXTURE_EXPLICIT: 'changed' } })));
      assert.equal(alive(pids[1]), false);
      assert.equal(new Set(pids).size, 3);
    } finally { await session.dispose(); }
    assert.equal(alive(pids[2]), false);
    return { uniqueProcesses: new Set(pids).size };
  });
  await check('provider-queues-concurrent-searches-on-one-process', async () => {
    const provider = createGrokProvider({ configuration: base, sdkFactory });
    const results = [];
    try {
      results.push(...await Promise.all(Array.from({ length: 8 }, (_, index) => provider.provider.search({ query: 'parallel-' + index }))));
      assert.equal(new Set(results.map(pidOf)).size, 1);
      assert.equal(provider.snapshot().running, 0);
      assert.equal(provider.snapshot().session.connected, true);
    } finally { await provider.dispose(); }
    assert.equal(alive(pidOf(results[0])), false);
    return { queries: results.length, uniqueProcesses: new Set(results.map(pidOf)).size };
  });
  await check('abort-reaps-and-next-request-can-reconnect', async () => {
    const session = createManagedMcpSearch();
    const controller = new AbortController();
    const reason = new Error('offline-probe-cancelled');
    let timer;
    try {
      const pending = session.run({ ...base, executableArgs: [base.executableArgs[0], 'call-hang'], signal: controller.signal });
      timer = setTimeout(() => controller.abort(reason), 100);
      await assert.rejects(pending, error => error === reason);
      assert.equal(session.snapshot().connected, false);
      assert.equal(session.snapshot().closing, false);
      const result = await session.run(base);
      return { reconnected: Boolean(pidOf(result)) };
    } finally { clearTimeout(timer); await session.dispose(); }
  });
  await check('timeout-reaps-and-preserves-deadline', async () => {
    const session = createManagedMcpSearch();
    const started = performance.now();
    try {
      await assert.rejects(session.run({ ...base, remainingMs: () => 100,
        executableArgs: [base.executableArgs[0], 'init-hang'] }), error => error.code === 'GROK_TIMEOUT');
      assert.equal(session.snapshot().connected, false);
      assert.ok(performance.now() - started < 2_000);
    } finally { await session.dispose(); }
  });
  await check('idle-exit-and-next-request-restart', async () => {
    const session = createManagedMcpSearch({ idleMs: 40 });
    let first, second;
    try {
      first = pidOf(await session.run(base));
      const until = performance.now() + 2_000;
      while ((session.snapshot().connected || session.snapshot().closing) && performance.now() < until) await delay(10);
      assert.equal(alive(first), false);
      second = pidOf(await session.run(base));
      assert.notEqual(first, second);
    } finally { await session.dispose(); }
    assert.equal(alive(second), false);
  });
  await check('protocol-error-invalidates-connection', async () => {
    const session = createManagedMcpSearch();
    try {
      await assert.rejects(session.run({ ...base, executableArgs: [base.executableArgs[0], 'invalid-json'] }),
        error => error.code === 'GROK_PROTOCOL_ERROR');
      assert.equal(session.snapshot().connected, false);
      await session.run(base);
    } finally { await session.dispose(); }
  });
  await check('dispose-cancels-active-and-rejects-queued-without-new-process', async () => {
    const provider = createGrokProvider({ configuration: {
      ...base, executableArgs: [base.executableArgs[0], 'call-hang'],
    }, sdkFactory });
    const settled = Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
      provider.provider.search({ query: 'cancel-' + index })));
    await delay(100);
    await provider.dispose();
    const outcomes = await settled;
    assert.equal(outcomes.filter(value => value.status === 'rejected').length, 5);
    assert.equal(provider.snapshot().session.connected, false);
    assert.equal(provider.snapshot().running, 0);
    await assert.rejects(provider.provider.search({ query: 'after-dispose' }), error => error.code === 'GROK_SEARCH_STOPPING');
  });
  if (grokExecutable) await check('real-grok-binary-reuses-one-process-with-local-upstream', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        if (request.url !== '/v1/responses' || request.headers.authorization !== 'Bearer offline-synthetic-key') {
          response.writeHead(401); response.end('rejected'); return;
        }
        requests++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'offline-' + requests, object: 'response', status: 'completed',
          output_text: 'Real Grok local probe.',
          output: [
            { type: 'web_search_call', action: { sources: [{ url: 'https://example.invalid/offline', title: 'Offline source' }] } },
            { type: 'message', content: [{ type: 'output_text', text: 'Real Grok local probe.' }] },
          ] }));
      });
    });
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
    const binaryConfig = join(root, 'real-binary.toml');
    writeFileSync(binaryConfig, [
      `grok_api_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'grok_api_key = "offline-synthetic-key"', 'grok_auth_mode = "api_key"', 'grok_model = "offline-probe"',
      'web_search_enabled = true', 'x_search_enabled = false',
      'tavily_enabled = false', 'exa_enabled = false', 'tinyfish_enabled = false', 'firecrawl_enabled = false',
    ].join('\n') + '\n', { flag: 'wx' });
    const session = createManagedMcpSearch();
    const pids = [];
    let version;
    try {
      for (let index = 0; index < 4; index++) {
        const result = await session.run({ ...base, executable: grokExecutable, executableArgs: [],
          configPath: binaryConfig, request: { query: 'Offline unique query ' + index }, remainingMs: () => 10_000 });
        pids.push(result.diagnostic.childPid);
        version = result.diagnostic.serverVersion;
        assert.equal(result.sources[0].url, 'https://example.invalid/offline');
      }
      assert.equal(new Set(pids).size, 1);
      assert.equal(requests, 4);
      assert.equal(version, '0.1.26');
    } finally {
      await session.dispose();
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
    assert.equal(alive(pids[0]), false);
    return { version, upstreamRequests: requests, uniqueProcesses: new Set(pids).size, binarySha256: sha256(grokExecutable) };
  });
} catch (error) { fatal = { code: error.code ?? null, message: error.message }; }
const sources = ['src/core/session-owner.mjs', 'src/core/mcp-search.mjs', 'src/core/search-executor.mjs',
  'src/provider.mjs', 'fixtures/mcp/grok-server.mjs', 'scripts/mcp-session-probe.mjs'];
const summary = { runId, status: fatal ? 'fail' : 'pass', checks, fatal: fatal ?? null,
  scope: 'real-owned-node-process-and-fixed-MCP-SDK-with-offline-peer',
  sdkVersion, realGrokBinaryValidated: !fatal && Boolean(grokExecutable), desktopValidated: false, realUpstreamQueries: false,
  sourceHashes: sources.map(file => ({ file, sha256: sha256(join(project, file)) })) };
writeJson(join(directory, 'summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = fatal ? 1 : 0;
