import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManagedMcpSearch } from '../src/core/mcp-search.mjs';
import { cleanEnvironment, freshRun, writeJson } from './lib/internal-candidate-utils.mjs';

const executable = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), 'dsh-grok-http-regression-'));
const run = freshRun('grok-http-regression');
let status = 401;
const calls = [];
const server = createServer(async (request, response) => {
  for await (const _ of request) { /* No body or key retention. */ }
  calls.push({ path: request.url, status });
  response.writeHead(request.url === '/v1/responses' ? status : 500, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'synthetic-private-upstream-body' } }));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const configPath = join(root, 'config.toml');
writeFileSync(configPath, `grok_api_url = "http://127.0.0.1:${server.address().port}"
grok_api_key = "synthetic-primary"
tavily_api_url = "http://127.0.0.1:${server.address().port}/tavily"
tavily_api_key = "synthetic-backup"
timeout_seconds = 5
`);
const clean = cleanEnvironment(root);
// Explicitly unset inherited credentials before adding the isolated environment.
const overrides = Object.fromEntries(Object.keys(process.env).filter(name =>
  /^(GROK_SEARCH_|OPENAI_COMPATIBLE_|TAVILY_|EXA_|FIRECRAWL_|TINYFISH_|GITHUB_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(name)).map(name => [name, null]));
const manager = createManagedMcpSearch();
const checks = [];
try {
  for (const code of [401, 403, 404, 429, 503]) {
    status = code;
    const before = calls.length;
    const deadline = performance.now() + 15_000;
    await assert.rejects(manager.run({ executable, configPath, envOverrides: { ...clean, ...overrides },
      request: { query: 'isolated primary authentication check', testPrimary: true }, remainingMs: () => deadline - performance.now() }),
    error => error.code === `HTTP_${code}` && error.details?.httpStatus === code
      && !JSON.stringify(error).includes('synthetic-private'));
    assert.deepEqual(calls.slice(before).map(row => row.path), ['/v1/responses', '/v1/responses']);
    checks.push({ status: code, classified: true, supplementaryCalls: 0, primaryCalls: 2 });
  }
  status = 401;
  const before = calls.length;
  const controller = new AbortController();
  const deadline = performance.now() + 15_000;
  const pending = manager.run({ executable, configPath, envOverrides: { ...clean, ...overrides },
    request: { query: 'cancel before network', testPrimary: true }, signal: controller.signal,
    remainingMs: () => deadline - performance.now() });
  controller.abort(new Error('synthetic-cancelled'));
  await assert.rejects(pending);
  assert.equal(calls.length, before);
  checks.push({ cancelledBeforeDispatch: true, primaryCalls: 0, supplementaryCalls: 0 });
  writeJson(join(run.directory, 'summary.json'), { checks, realProgram: true, upstream: 'loopback', paidCalls: 0 });
  console.log(JSON.stringify({ evidence: run.directory, checks }));
} finally {
  await manager.dispose();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
