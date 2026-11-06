import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { cleanEnvironment, commandResult, freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

// Explicit opt-in: credentials remain in memory/child environment, never arguments
// or evidence. This command does not save configuration or touch a DSH profile.
const onlyGrok = process.argv.includes('--only-grok');
const grokDirect = process.argv.includes('--grok-direct');
const asConfigured = process.argv.includes('--as-configured');
const args = process.argv.slice(2).filter(value => !['--only-grok', '--grok-direct', '--as-configured'].includes(value));
if (args.length !== 2 || args[0] !== '--allow-live') {
  throw new Error('Usage: node scripts/verify-search-log-live.mjs --allow-live <verified-tarball> [--only-grok] [--grok-direct] [--as-configured]');
}
const tarball = resolve(args[1]);
const packageReceipt = JSON.parse(readFileSync(join(resolve(tarball, '..'), 'package-receipt.json'), 'utf8'));
assert.equal(sha256(tarball), packageReceipt.sha256);
for (const row of packageReceipt.sourceHashes) assert.equal(sha256(join(project, row.file)), row.sha256);
const run = freshRun('search-log-live');
const root = mkdtempSync(join(tmpdir(), 'dsh-search-log-live-'));
const results = [], network = [], cleanup = [];
let secrets = [], configPath, configHash, program, fatalCode;
const codeOf = error => /^[A-Za-z0-9_.-]{1,80}$/.test(error?.code ?? '') ? error.code : 'VALIDATION_FAILED';
const failureCodes = error => (error?.details?.failures ?? []).map(row => ({
  provider: ['grok', 'tavily', 'exa', 'tinyfish', 'firecrawl'].includes(row.provider) ? row.provider : 'unknown',
  code: codeOf(row),
}));
const assertSecretFree = value => {
  const text = JSON.stringify(value);
  for (const secret of secrets) for (const encoded of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
    if (encoded && text.includes(encoded)) throw Object.assign(new Error('Evidence redaction guard'), { code: 'EVIDENCE_SECRET_REJECTED' });
  }
  return value;
};
const record = row => {
  assertSecretFree(row);
  results.push(row);
  console.log(JSON.stringify({ case: row.case, status: row.status, code: row.code, elapsedMs: row.elapsedMs }));
};
const networkFetch = (provider, purpose) => async (url, init) => {
  const started = performance.now();
  // Destination is constructed by the product from the user's configuration.
  // Only status/timing leave this scope; no headers, URLs or response bodies.
  try {
    const response = await fetch(url, init);
    network.push({ provider, purpose, status: response.status, elapsedMs: Math.round(performance.now() - started) });
    return response;
  } catch (error) {
    network.push({ provider, purpose, status: null, code: codeOf(error.cause ?? error),
      elapsedMs: Math.round(performance.now() - started) });
    throw error;
  }
};
const safeLog = row => row && ({
  kind: row.kind, served: row.served, official: row.official, reason: row.reason,
  callsComplete: row.callsComplete, ms: row.ms, calls: row.calls,
});
try {
  const extracted = await commandResult('tar.exe', ['-xf', tarball, '-C', root], { timeoutMs: 30_000 });
  assert.equal(extracted.exitCode, 0);
  const product = join(root, 'package');
  for (const file of packageReceipt.files) assert.equal(sha256(join(product, file.path)), sha256(join(project, file.path)));
  symlinkSync(join(project, 'node_modules'), join(product, 'node_modules'), 'junction');
  const load = file => import(pathToFileURL(join(product, file)).href);
  const { createSharedConfigStore, resolveSharedConfigPath, CONFIG_FIELDS } = await load('src/core/shared-config.mjs');
  const { findExistingGrok } = await load('src/core/program-discovery.mjs');
  const { createSourceRouter, sourceSpec } = await load('src/core/source-adapters.mjs');
  const { createRoutedSearch } = await load('src/core/routed-search.mjs');
  const { createReleaseBarrier } = await load('src/core/release-transaction.mjs');
  const { queryAccountQuota } = await load('src/core/account-quota.mjs');
  const { createGrokProvider } = await load('src/provider.mjs');
  configPath = resolveSharedConfigPath();
  const store = createSharedConfigStore({ path: configPath });
  const initial = store.snapshot();
  configHash = initial.revision;
  const effective = store.readEffective();
  const values = Object.fromEntries(Object.entries(effective).map(([name, field]) => [name, field.value]));
  secrets = Object.entries(CONFIG_FIELDS).filter(([, spec]) => spec.type === 'secret')
    .flatMap(([name]) => [values[name], ...String(values[name] ?? '').split(',')]).filter(Boolean);
  program = await findExistingGrok();
  const providers = ['tavily', 'exa', 'firecrawl', 'tinyfish'];
  const isolatedValues = (enabled, order = providers) => ({ ...values,
    source_providers: [...order],
    ...Object.fromEntries(providers.map(id => [`${id}_enabled`, enabled.includes(id)])),
    timeout_seconds: 25,
  });
  const query = 'DeepSeek Harness GitHub official repository';
  const sourceRuns = [];
  const testRouted = async ({ caseName, config, grokEnabled = false, grok, fetchImpl, expectedServed }) => {
    const router = createSourceRouter({ getConfig: () => config, fetchImpl });
    const routed = createRoutedSearch({ grok: grok ?? { search: async () => { throw Object.assign(new Error('Isolated primary failure'), { code: 'LIVE_TEST_PRIMARY_UNAVAILABLE' }); } },
      sourceRouter: router, preferences: { snapshot: () => ({ value: { grokEnabled } }) },
      getConfig: () => config, releaseBarrier: createReleaseBarrier(), budgetMs: 40_000 });
    const sessionId = randomUUID();
    routed.searchLog.snapshot(sessionId);
    const heartbeat = setInterval(() => routed.searchLog.snapshot(sessionId), 2500);
    const started = performance.now();
    let result, error;
    try { result = await routed.search({ query, maxResults: 2 }); }
    catch (caught) { error = caught; }
    finally { clearInterval(heartbeat); }
    try {
      const rows = routed.searchLog.snapshot(sessionId).records;
      assert.equal(rows.length, 1);
      const log = rows[0];
      assert.equal(log.official, null);
      assert.equal(log.kind, error ? 'failed' : grokEnabled ? 'fallback' : 'sources');
      if (result) {
        assert.ok(result.sources.length > 0);
        if (expectedServed) assert.equal(log.served, expectedServed);
      }
      const callsBeforeRead = network.length;
      routed.searchLog.snapshot(sessionId);
      assert.equal(network.length, callsBeforeRead);
      routed.searchLog.clear(sessionId);
      assert.deepEqual(routed.searchLog.snapshot(sessionId), { records: [] });
      routed.searchLog.close(sessionId);
      record({ case: caseName, status: error ? 'upstream-failed' : 'passed',
        code: error ? codeOf(error) : 'OK', elapsedMs: Math.round(performance.now() - started),
        resultCount: result?.sources.length ?? 0, failures: failureCodes(error),
        log: safeLog(log), logReadDidNotRequest: true, clearPassed: true });
      return { ok: !error, served: log.served };
    } finally { await routed.dispose(); }
  };

  // Existing disabled sources are enabled only in this in-memory test view.
  for (const provider of onlyGrok ? [] : providers) {
    if (!String(values[sourceSpec[provider].key] ?? '').trim()) {
      record({ case: `source-${provider}`, status: 'not-configured', code: 'NOT_CONFIGURED' });
      continue;
    }
    const outcome = await testRouted({ caseName: `source-${provider}`, config: isolatedValues([provider]),
      expectedServed: provider, fetchImpl: networkFetch(provider, 'search') });
    sourceRuns.push({ provider, ...outcome });
  }
  for (const provider of onlyGrok ? [] : providers) {
    const started = performance.now();
    try {
      const quota = await queryAccountQuota({ provider, config: values, fetchImpl: networkFetch(provider, 'quota') });
      record({ case: `quota-${provider}`, status: quota.supported ? 'passed' : 'unsupported',
        code: quota.supported ? 'OK' : 'NO_CONFIRMED_BALANCE_API',
        elapsedMs: Math.round(performance.now() - started), quota });
    } catch (error) {
      record({ case: `quota-${provider}`, status: 'upstream-failed', code: codeOf(error),
        elapsedMs: Math.round(performance.now() - started) });
    }
  }
  if (!onlyGrok) {
    const github = await createSourceRouter({ getConfig: () => values,
      fetchImpl: networkFetch('github', 'authentication') }).diagnoseProvider('github');
    record({ case: 'github-authentication', status: github.status === 'ok' ? 'passed' : 'upstream-failed',
      code: github.code, authenticated: github.authenticated, elapsedMs: github.elapsedMs });
  }

  if (program.found) {
    const envOverrides = cleanEnvironment(root);
    // Clear inherited MCP-specific variables, then capture the effective values
    // once. New process home and config path are isolated; no key file is made.
    for (const name of Object.keys(process.env)) if (/^GROK_SEARCH_/i.test(name)) envOverrides[name] = null;
    for (const [name, spec] of Object.entries(CONFIG_FIELDS)) envOverrides[spec.env] = Array.isArray(values[name])
      ? values[name].join(',') : String(values[name]);
    if (grokDirect) for (const name of Object.keys(process.env)) {
      if (/^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name)) envOverrides[name] = null;
    }
    if (!asConfigured) {
      for (const provider of providers) envOverrides[CONFIG_FIELDS[`${provider}_enabled`].env] = 'false';
      envOverrides.GROK_SEARCH_EXTRA_SOURCES = '0';
    }
    const observations = [];
    const sdkFactory = async () => {
      const sdk = await import('@modelcontextprotocol/client');
      return { ...sdk, Client: class extends sdk.Client {
        async callTool(...parameters) {
          try { return await super.callTool(...parameters); }
          catch (error) {
            const text = String(error?.message ?? '');
            observations.push({ rpcCode: Number.isInteger(error.code) ? error.code : null,
              reportedHttp: [...new Set([...text.matchAll(/\b([45]\d{2})\b/g)].map(match => Number(match[1])))],
              classifications: ['timeout', 'unauthorized', 'quota', 'disabled', 'empty', 'not found', 'model', 'request failed']
                .filter(word => text.toLowerCase().includes(word)) });
            throw error;
          }
        }
      } };
    };
    const core = createGrokProvider({ sdkFactory, configuration: { executable: program.path,
      configPath: join(root, 'intentionally-absent.toml'), envOverrides, budgetMs: 115_000 } });
    const routed = createRoutedSearch({ grok: core.provider,
      sourceRouter: createSourceRouter({ getConfig: () => asConfigured ? values : isolatedValues([]),
        fetchImpl: networkFetch('supplementary-chain', 'configured-fallback') }),
      getConfig: () => values, releaseBarrier: createReleaseBarrier(), budgetMs: 118_000 });
    const id = randomUUID();
    routed.searchLog.snapshot(id);
    const heartbeat = setInterval(() => routed.searchLog.snapshot(id), 2500);
    let firstPid;
    try {
      for (let pass = 1; pass <= 2; pass++) {
        const started = performance.now();
        try {
          const answer = await routed.search({ query, maxResults: 2 });
          assert.ok(answer.sources.length > 0);
          if (!asConfigured) assert.equal(answer.diagnostic?.fallbackUsed, false, 'primary success must not be MCP fallback');
          const log = routed.searchLog.snapshot(id).records[0];
          const fallback = answer.diagnostic?.fallbackUsed === true;
          assert.equal(log.kind, fallback ? 'fallback' : 'ok');
          assert.equal(log.served, fallback ? 'grok-sources' : 'grok');
          const pid = answer.diagnostic.childPid;
          assert.ok(Number.isInteger(pid) && pid > 0);
          if (pass === 1) firstPid = pid; else assert.equal(pid, firstPid, 'managed MCP process is reused');
          record({ case: `${asConfigured ? 'configured-mcp' : 'grok-primary'}-${pass}`, status: 'passed', code: 'OK',
            elapsedMs: Math.round(performance.now() - started), resultCount: answer.sources.length,
            fallbackUsed: answer.diagnostic.fallbackUsed, primaryVerified: !fallback, processReused: pass === 2,
            serverVersion: answer.diagnostic.serverVersion, log: safeLog(log) });
        } catch (error) {
          if (error.code === 'ERR_ASSERTION') throw error;
          record({ case: `${asConfigured ? 'configured-mcp' : 'grok-primary'}-${pass}`, status: 'upstream-failed', code: codeOf(error),
            elapsedMs: Math.round(performance.now() - started),
            fallbackUsed: error.diagnostic?.fallbackUsed ?? null,
            fallbackReason: error.diagnostic?.fallbackReason ?? null,
            observations,
            log: safeLog(routed.searchLog.snapshot(id).records[0]) });
          break;
        }
      }
    } finally {
      clearInterval(heartbeat);
      await routed.dispose();
      await core.dispose();
      assert.equal(core.snapshot().session.connected, false);
      if (firstPid) {
        let alive = true;
        try { process.kill(firstPid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
        assert.equal(alive, false, 'owned MCP child must exit');
      }
      cleanup.push({ resource: 'owned-mcp-session', disposed: true, connected: false, exitVerified: !!firstPid });
    }
    if (onlyGrok && observations.length && !asConfigured) {
      // Triage the configured Responses endpoint with the documented upstream
      // request shape. Never change protocol/model or follow a redirect.
      let base = values.grok_api_url.trim().replace(/\/+$/, '');
      for (const suffix of ['/chat/completions', '/responses']) if (base.endsWith(suffix)) base = base.slice(0, -suffix.length).replace(/\/+$/, '');
      if (!base.endsWith('/v1')) base += '/v1';
      try {
      const response = await networkFetch('grok', 'responses-triage')(`${base}/responses`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
        headers: { authorization: `Bearer ${values.grok_api_key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: values.grok_model, input: [{ role: 'user', content: query }],
          tools: [{ type: 'web_search' }], stream: false }),
      });
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024) { await reader.cancel(); break; }
        chunks.push(value);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      const text = typeof body?.error?.message === 'string' ? body.error.message : '';
      record({ case: 'configured-responses-direct-triage', status: response.ok ? 'response-received' : 'upstream-failed',
        code: `HTTP_${response.status}`,
        upstreamCode: /^[a-z_]{1,50}$/.test(body?.error?.code ?? '') ? body.error.code : null,
        classifications: ['model', 'not found', 'does not exist', 'unsupported', 'insufficient', 'quota', 'invalid', 'token', 'auth']
          .filter(word => text.toLowerCase().includes(word)),
        outputReported: Array.isArray(body?.output), rawResponseSaved: false });
      } catch (error) {
        record({ case: 'configured-responses-direct-triage', status: 'upstream-failed',
          code: codeOf(error.cause ?? error), rawResponseSaved: false });
      }
    }
  } else record({ case: 'grok-primary', status: 'not-configured', code: 'GROK_PROGRAM_MISSING' });

  const usable = sourceRuns.filter(row => row.ok);
  if (usable.length) {
    const next = usable[0].provider;
    await testRouted({ caseName: 'injected-primary-failure-to-live-source', config: isolatedValues([next]),
      grokEnabled: true, expectedServed: next, fetchImpl: networkFetch(next, 'fallback') });
    if (usable.length > 1) {
      const first = usable[0].provider, second = usable[1].provider;
      let injected = 0;
      const outcome = await testRouted({ caseName: 'injected-quota-exhaustion-to-live-next-source',
        config: isolatedValues([first, second], [first, second, ...providers.filter(id => id !== first && id !== second)]),
        expectedServed: second,
        fetchImpl: async (url, init) => {
          if (injected++ === 0) return new Response('{}', { status: 429 });
          return networkFetch(second, 'fallback-after-injected-429')(url, init);
        } });
      assert.equal(injected, 2);
      assert.equal(outcome.ok, true);
    }
  }
} catch (error) {
  fatalCode = codeOf(error);
} finally {
  const configUnchanged = configPath && existsSync(configPath) ? sha256(configPath) === configHash : false;
  const sourceUnchanged = packageReceipt.sourceHashes.every(row => sha256(join(project, row.file)) === row.sha256);
  const programUnchanged = program?.found ? sha256(program.path) === program.sha256 : null;
  const summary = { runId: run.runId, scope: 'real-credentials-packaged-core-no-desktop',
    grokTransport: grokDirect ? 'isolated-child-without-proxy-triage' : 'inherited-proxy-as-configured',
    invariantsPassed: !fatalCode && configUnchanged && sourceUnchanged && programUnchanged !== false,
    allConfiguredSearchesPassed: results.filter(row => /^(?:source-|grok-primary|configured-mcp)/.test(row.case))
      .every(row => row.status === 'passed'),
    primaryGrokVerified: results.some(row => row.primaryVerified === true),
    fatalCode, results, network, cleanup, configUnchanged, configSha256: configHash,
    sourceUnchanged, programUnchanged, programVersion: program?.version ?? null,
    sourceHashes: packageReceipt.sourceHashes,
    verifierSha256: sha256(join(project, 'scripts/verify-search-log-live.mjs')),
    tarballSha256: packageReceipt.sha256, rawResponsesSaved: false, keysSaved: false,
    sharedConfigurationWritten: false, desktopVerified: false, published: false };
  try {
    assertSecretFree(summary);
    writeJson(join(run.directory, 'summary.json'), summary);
    console.log(JSON.stringify({ runId: run.runId, invariantsPassed: summary.invariantsPassed,
      allConfiguredSearchesPassed: summary.allConfiguredSearchesPassed, fatalCode, configUnchanged }));
  } catch { fatalCode = 'EVIDENCE_WRITE_REJECTED'; console.log(JSON.stringify({ runId: run.runId, fatalCode })); }
  process.exitCode = fatalCode || !summary.invariantsPassed || !summary.allConfiguredSearchesPassed ? 1 : 0;
}
