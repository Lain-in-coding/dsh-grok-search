import assert from 'node:assert/strict';
import { readFileSync, realpathSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { desktopAcceptancePaths } from './lib/desktop-acceptance-environment.mjs';
import { assertSecretFreeEvidence, cleanEnvironment, commandResult, freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

// Deliberate opt-in, explicitly selected existing acceptance profile, never the
// default home. No configuration, quota, doctor or unrelated provider writes.
const [permission, inputRoot, inputPackage] = process.argv.slice(2);
assert.equal(permission, '--allow-live');
assert.equal(process.argv.length, 5, 'Usage: node scripts/verify-acceptance-sources.mjs --allow-live <fixed-acceptance-root> <tarball>');
const paths = desktopAcceptancePaths(resolve(inputRoot));
const inside = path => {
  const resolved = realpathSync(path), rel = relative(realpathSync(paths.root), resolved);
  assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'Acceptance resource escaped root.');
  assert.equal(lstatSync(path).isSymbolicLink(), false, 'Acceptance input must not redirect to production.');
  return resolved;
};
const configPath = inside(join(paths.home, '.config/grok-search-rs/config.toml'));
const prefsPath = inside(join(paths.profile, 'grok-search/preferences.json'));
const patchPath = inside(join(paths.profile, 'cordis.patch.yml'));
const cachePath = inside(join(paths.profile, 'grok-search/runtime-cache/active.json'));
const active = JSON.parse(readFileSync(cachePath, 'utf8'));
const executable = inside(resolve(dirname(cachePath), active.executable));
assert.equal(sha256(executable), active.sha256);
assert.equal(active.version, '0.1.26');
const protectedFiles = { config: configPath, preferences: prefsPath, patch: patchPath, cache: cachePath, executable };
const hashes = () => Object.fromEntries(Object.entries(protectedFiles).map(([key, path]) => [key, sha256(path)]));
const initial = hashes();
const tarball = resolve(inputPackage);
const receipt = JSON.parse(readFileSync(join(dirname(tarball), 'package-receipt.json'), 'utf8'));
assert.equal(sha256(tarball), receipt.sha256);
const run = freshRun('acceptance-sources-limited');
const extract = join(run.directory, 'extracted');
mkdirSync(extract);
const results = [], network = [], attempts = { grok: 0, exa: 0 };
let fatalCode = null, secrets = [], core = null, routed = null, cleanupVerified = true;
const codeOf = error => /^[A-Za-z0-9_.-]{1,80}$/.test(error?.code ?? '') ? error.code : 'VERIFICATION_FAILED';
const unchanged = () => assert.deepEqual(hashes(), initial, 'Acceptance settings changed; stop before further requests.');
const record = value => {
  assertSecretFreeEvidence(value, secrets);
  results.push(value);
  console.log(JSON.stringify({ provider: value.provider, pass: value.pass, status: value.status, code: value.code }));
};
try {
  const unpack = await commandResult(process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['-xf', tarball, '-C', extract], { timeoutMs: 30000 });
  assert.equal(unpack.exitCode, 0);
  const product = join(extract, 'package');
  for (const row of receipt.sourceHashes) assert.equal(sha256(join(product, row.file)), row.sha256);
  symlinkSync(join(project, 'node_modules'), join(product, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const load = file => import(pathToFileURL(join(product, file)).href);
  const { createSharedConfigStore, CONFIG_FIELDS } = await load('src/core/shared-config.mjs');
  const { createSourceRouter } = await load('src/core/source-adapters.mjs');
  const { createRoutedSearch } = await load('src/core/routed-search.mjs');
  const { createReleaseBarrier } = await load('src/core/release-transaction.mjs');
  const { createGrokProvider } = await load('src/provider.mjs');
  const effective = createSharedConfigStore({ path: configPath, env: () => ({}) }).readEffective();
  const values = Object.fromEntries(Object.entries(effective).map(([name, field]) => [name, field.value]));
  secrets = Object.entries(CONFIG_FIELDS).filter(([, spec]) => spec.type === 'secret')
    .flatMap(([name]) => String(values[name] ?? '').split(',')).filter(Boolean);
  const query = 'DeepSeek Harness official GitHub repository';
  const disabled = { ...values, source_providers: ['exa'], default_extra_sources: 0, fallback_sources: 0,
    tavily_enabled: false, exa_enabled: false, tinyfish_enabled: false, firecrawl_enabled: false,
    tavily_api_key: '', tinyfish_api_key: '', firecrawl_api_key: '', github_token: '' };
  for (const provider of ['grok', 'exa']) {
    unchanged();
    const configured = provider === 'exa' ? Boolean(String(values.exa_api_key).trim())
      : Boolean(String(values.grok_api_key).trim() || String(values.openai_compatible_api_key).trim());
    if (!configured) { record({ provider, status: 'not-configured', code: 'NOT_CONFIGURED' }); continue; }
    const config = provider === 'grok' ? { ...disabled, exa_api_key: '' } : { ...disabled,
      grok_api_key: '', openai_compatible_api_key: '', exa_enabled: true, fallback_sources: 2 };
    let rpcCalls = 0;
    const fetchImpl = async (url, init) => {
      assert.equal(provider, 'exa');
      assert.equal(init.method, 'POST');
      assert.equal(new URL(url).origin, new URL(values.exa_api_url).origin);
      assert.ok(++rpcCalls <= 2, 'No more than two Exa requests are authorized.');
      const started = performance.now();
      const response = await fetch(url, init);
      network.push({ provider, status: response.status, elapsedMs: Math.round(performance.now() - started) });
      return response;
    };
    const sourceRouter = createSourceRouter({ getConfig: () => config, fetchImpl });
    if (provider === 'grok') {
      const env = cleanEnvironment(join(run.directory, 'child'));
      for (const name of Object.keys(process.env)) {
        if (/^(?:GROK_SEARCH_|TAVILY_|EXA_|FIRECRAWL_|TINYFISH_|OPENAI_COMPATIBLE_|GITHUB_TOKEN$)/i.test(name)) env[name] = null;
      }
      for (const [name, spec] of Object.entries(CONFIG_FIELDS)) {
        const value = config[name];
        env[spec.env] = Array.isArray(value) ? value.join(',') : String(value);
      }
      const sdkFactory = async () => {
        const sdk = await import('@modelcontextprotocol/client');
        return { ...sdk, Client: class extends sdk.Client {
          async callTool(request, ...options) {
            assert.ok(['web_search', 'get_sources'].includes(request.name), 'No doctor, quota or extra tool request authorized.');
            if (request.name === 'web_search') assert.ok(++rpcCalls <= 2, 'Grok call budget exhausted.');
            return super.callTool(request, ...options);
          }
        } };
      };
      core = createGrokProvider({ sdkFactory, configuration: { executable,
        configPath: join(run.directory, 'intentionally-absent.toml'), envOverrides: env, budgetMs: 120000 } });
    }
    routed = createRoutedSearch({ grok: core?.provider ?? { search: async () => { throw new Error('Disabled primary'); } },
      sourceRouter, preferences: { snapshot: () => ({ value: { grokEnabled: provider === 'grok' } }) },
      getConfig: () => config, releaseBarrier: createReleaseBarrier(), budgetMs: 120000 });
    const view = randomUUID();
    routed.searchLog.snapshot(view);
    const heartbeat = setInterval(() => routed.searchLog.snapshot(view), 2000);
    let firstPid = null;
    try {
      for (let pass = 1; pass <= 2; pass++) {
        unchanged();
        attempts[provider]++;
        const started = performance.now();
        try {
          const answer = await routed.search({ query, maxResults: 2 });
          unchanged();
          const log = routed.searchLog.snapshot(view).records[0];
          assert.ok(answer.sources.length > 0);
          assert.equal(log.served, provider, 'Primary success cannot be a supplemental fallback.');
          if (provider === 'grok') assert.equal(answer.diagnostic?.fallbackUsed, false);
          const pid = answer.diagnostic?.childPid ?? null;
          if (pass === 1) firstPid = pid;
          if (provider === 'grok' && pass === 2) assert.equal(pid, firstPid);
          record({ provider, pass, status: 'passed', code: 'OK', resultCount: answer.sources.length,
            elapsedMs: Math.round(performance.now() - started), processReused: provider === 'grok' && pass === 2,
            log: { kind: log.kind, served: log.served, reason: log.reason, ms: log.ms } });
        } catch (error) {
          record({ provider, pass, status: 'failed', code: codeOf(error), elapsedMs: Math.round(performance.now() - started) });
          break;
        }
      }
    } finally {
      clearInterval(heartbeat);
      await routed.dispose(); routed = null;
      if (core) {
        await core.dispose();
        assert.equal(core.snapshot().session.connected, false);
        core = null;
      }
    }
  }
} catch (error) { fatalCode = codeOf(error); }
finally {
  try { await routed?.dispose(); await core?.dispose(); } catch { cleanupVerified = false; }
  const configUnchanged = JSON.stringify(hashes()) === JSON.stringify(initial);
  const summary = { runId: run.runId, scope: 'frozen-package-existing-isolated-credentials-limited-live-search',
    packageSha256: receipt.sha256, programVersion: active.version, attempts, network, results, fatalCode,
    configUnchanged, cleanupVerified, invariantsPassed: !fatalCode && configUnchanged && cleanupVerified,
    primaryGrokVerified: results.some(row => row.provider === 'grok' && row.status === 'passed'),
    exaSearchVerified: results.some(row => row.provider === 'exa' && row.status === 'passed'),
    rawResponsesSaved: false, keysSaved: false, quotaQueried: false, desktopConversationVerified: false, published: false };
  assertSecretFreeEvidence(summary, secrets);
  writeJson(join(run.directory, 'summary.json'), summary);
  console.log(JSON.stringify({ runId: run.runId, packageSha256: receipt.sha256, attempts,
    invariantsPassed: summary.invariantsPassed, primaryGrokVerified: summary.primaryGrokVerified, exaSearchVerified: summary.exaSearchVerified }));
  if (!summary.invariantsPassed || !summary.primaryGrokVerified || !summary.exaSearchVerified) process.exitCode = 1;
}
