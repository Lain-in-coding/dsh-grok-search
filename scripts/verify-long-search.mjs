import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createGrokProvider } from '../src/provider.mjs';
import { createRoutedSearch } from '../src/core/routed-search.mjs';
import { createReleaseBarrier } from '../src/core/release-transaction.mjs';
import { createSharedConfigStore } from '../src/core/shared-config.mjs';
import { createSourceRouter } from '../src/core/source-adapters.mjs';
import { createToolBudgetController } from '../src/core/tool-budget.mjs';
import { apply as settings } from '../src/settings-ui.mjs';

const [runtimeRoot, executable] = process.argv.slice(2);
if (!runtimeRoot || !executable) throw new Error('Provide an installed official runtime and grok-search-rs executable.');
const directory = mkdtempSync(join(tmpdir(), 'dsh-long-search-'));
// Child-process test environment only; never read the user's shared config.
for (const name of Object.keys(process.env)) if (/^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|GROK_SEARCH_.*|OPENAI_COMPATIBLE_.*|TAVILY_.*|EXA_.*|TINYFISH_.*|FIRECRAWL_.*|GITHUB_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)) delete process.env[name];
Object.assign(process.env, { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory });
let calls = 0;
const server = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  if (request.url !== '/v1/responses') { response.writeHead(404); response.end('{}'); return; }
  calls++;
  const timer = setTimeout(() => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'synthetic', object: 'response', status: 'completed', output: [{
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Source https://example.test/result',
        annotations: [{ type: 'url_citation', url: 'https://example.test/result', title: 'Source', start_index: 7, end_index: 34 }] }],
    }] }));
  }, 65_000);
  response.on('close', () => clearTimeout(timer));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const configPath = join(directory, 'config.toml');
writeFileSync(configPath, `grok_api_url = "http://127.0.0.1:${server.address().port}"\ngrok_api_key = "synthetic"\ngrok_model = "synthetic"\ntimeout_seconds = 90\ndefault_extra_sources = 0\nfallback_sources = 0\n`);
const execution = { executable: resolve(executable), configPath, budgetMs: 90_000 };
const store = createSharedConfigStore({ path: configPath });
const getConfig = () => ({ ...store.readSnapshot(), execution });
const core = createGrokProvider({ configuration: execution });
const sourceRouter = createSourceRouter({ getConfig });
const barrier = createReleaseBarrier();
const routed = createRoutedSearch({ grok: core.provider, sourceRouter, getConfig, releaseBarrier: barrier, budgetMs: 90_000 });
let Gateway;
settings({ plugin(Plugin) { Gateway = Plugin; } });
const services = new Map([
  ['grokSearchCore', { testGrok: routed.testGrok, releaseBarrier: barrier }],
  ['grokSearchProgram', { snapshot: () => ({ phase: 'ready', configPath }), execution: () => execution }],
  ['grokSearchConnectionSecurity', { requireOwner() {} }],
]);
const gateway = new Gateway({ get: name => services.get(name), provide() {}, profileContext: { dir: directory } });
const require = createRequire(pathToFileURL(resolve(runtimeRoot, 'package.json')));
const { Context, resolveConfig } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const tool = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-web')));
const policy = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-call-timeout-policy')));
const app = new Context();
let definition, budgets;
app.provide('tools', { register(value) { if (value.name === 'web_search') definition = value; }, get() { return definition; } });
app.provide('systemPrompt', { getSectionOrder() { return 1; }, section() {} });
app.provide('web', { searchReady() { return true; }, search: routed.search });
app.on('internal/plugin', fiber => {
  if (fiber.runtime?.name === 'tool-web' && fiber.uid !== null) Object.defineProperty(fiber, 'entry', {
    value: { options: { name: '@deepseek-ai/dsh-tool-web', config: { searchTimeoutMs: 60_000, fetch: false } } },
  });
}, { global: true, prepend: true });
const results = [];
try {
  await app.plugin(tool, { searchTimeoutMs: 60_000, fetch: false });
  assert.equal(definition.timeoutMs, 60_000);
  await app.plugin({ name: 'budget-owner', async apply(ctx) {
    budgets = createToolBudgetController({ ctx, budgetMs: 90_000, required: () => true, resolveConfig });
    await budgets.acquire();
  } });
  await app.plugin(policy);
  assert.equal(definition.timeoutMs, 90_000);
  let started = performance.now();
  console.log('Running real grok-search-rs diagnostic with a 65-second loopback response.');
  const diagnosis = await gateway.diagnoseProvider({ provider: 'grok' });
  assert.equal(diagnosis.status, 'ok');
  results.push({ scenario: 'diagnostic-over-60-seconds', passed: true, elapsedMs: Math.round(performance.now() - started) });
  started = performance.now();
  console.log('Running official web_search and timeout policy with the unchanged 60-second preset input.');
  const exec = { name: 'web_search', agent: {}, signal: new AbortController().signal };
  const result = await app.waterfall('tools/execute', exec, () => definition.execute({ queries: ['isolated long response'] }, exec));
  assert.equal(result.isError, undefined);
  assert.equal(result.sources.length, 1);
  results.push({ scenario: 'official-tool-runtime-budget', passed: true, elapsedMs: Math.round(performance.now() - started) });
  assert.equal(calls, 2);
  await budgets.release();
  assert.equal(definition.timeoutMs, 60_000);
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ scope: 'actual-grok-loopback-official-tool-policy-registration-stubs',
    results, requests: calls, paidRequests: 0, published: false }, null, 2));
  console.log(JSON.stringify({ directory, results, requests: calls }));
} finally {
  await Promise.allSettled([routed.dispose(), core.dispose()]);
  for (const runtime of [...app.registry.values()]) for (const fiber of [...runtime.fibers]) await fiber.dispose();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
