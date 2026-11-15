import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import {
  acceptanceEnvironment, acceptanceVerifierIdentity, downloadPinnedMacosHost, newTemporaryOutput, prepareRuntime,
} from './macos-full-acceptance.mjs';
import { FROZEN_PRODUCT_SHA256, hashPackageSource, macosHostPin, readPackageArtifact } from './lib/macos-acceptance-evidence.mjs';
import { hashFile, sha256 } from './lib/compatibility-evidence.mjs';
import { runBoundedCommand } from './lib/compatibility-process.mjs';
import { inspectDesktopNativeInstall } from './deferred-release-desktop-prepare.mjs';
import { requestDesktopShutdown } from './lib/renderer-cdp.mjs';

const BUNDLE = 'dsh-grok-search';
const VERSION = '0.2.1-rc.2';
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

export function classifyCleanLifecycle(observation) {
  const required = ['cleanProfile', 'nativeInstall', 'programPrepared', 'searchBefore', 'disabledSelection',
    'releaseCompleted', 'processStopped', 'reenabledSelection', 'searchAfter', 'cacheReused',
    'configurationPreserved', 'productUnchanged', 'hostUnchanged', 'hostExited', 'finalProcessStopped'];
  const missing = required.filter(name => observation[name] !== true && observation[name] !== false);
  const failed = required.filter(name => observation[name] === false);
  const warnings = (observation.managerResults ?? []).filter(row => row.result?.application === 'restart-required')
    .map(row => ({ action: row.action, reason: row.result.restartReason ?? null }));
  const rejected = (observation.managerResults ?? []).filter(row =>
    row.result?.error || !['applied', 'restart-required'].includes(row.result?.application));
  if (rejected.length) failed.push('manager-action-rejected');
  if (observation.executionError) missing.push('control-execution-completed');
  return {
    status: failed.length ? 'functional-failure' : missing.length ? 'incomplete'
      : warnings.length ? 'functional-pass-with-host-warning' : 'functional-pass',
    functionalPassed: failed.length === 0 && missing.length === 0,
    missing, failed, hostWarnings: warnings,
    fullMatrixPassed: false, userAcceptancePassed: false,
  };
}

export function readReleaseCompletion(profile) {
  const directory = join(profile, 'control-intent.records');
  if (!existsSync(directory)) return null;
  const names = readdirSync(directory).filter(name => /^v\d{12}\.json$/.test(name)).sort();
  if (!names.length) return null;
  const file = names.at(-1), bytes = readFileSync(join(directory, file)), envelope = JSON.parse(bytes);
  assert.equal(envelope.format, 'dsh-grok-search/control-intent');
  assert.equal(envelope.revision, Number(file.slice(1, 13)));
  return { file, sha256: sha256(bytes), revision: envelope.revision, intent: envelope.intent };
}

export function parseCleanArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    assert.ok(['--package-directory', '--output-root', '--version'].includes(key)
      && !Object.hasOwn(values, key) && typeof value === 'string' && value.trim()
      && !value.startsWith('--') && !/[\0\r\n]/.test(value), 'Invalid clean-control argument.');
    values[key] = value;
  }
  assert.ok(values['--package-directory'] && values['--output-root']);
  assert.equal(values['--version'], VERSION, 'This control is bounded to the previously failing minimum host.');
  return values;
}

export async function boundedObservation(work, { timeout = 30_000, signal } = {}) {
  signal?.throwIfAborted();
  let timer, abort;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Observation channel timed out.'),
          { code: 'CLEAN_CHANNEL_TIMEOUT' })), timeout);
        abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

export async function pollUntil(label, predicate, timeout = 30_000, signal) {
  const end = Date.now() + timeout;
  let last, lastValue, observed = false;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    try {
      const result = await boundedObservation(predicate, { timeout: Math.max(1, end - Date.now()), signal });
      signal?.throwIfAborted();
      lastValue = result; observed = true;
      if (result) return result;
    } catch (error) { signal?.throwIfAborted(); last = error; }
    if (Date.now() < end) await delay(Math.min(100, end - Date.now()), undefined, { signal });
  }
  throw Object.assign(new Error(label + (last ? ': ' + last.message : '')),
    { code: 'CLEAN_OBSERVATION_TIMEOUT', observed, lastValue });
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

async function externalApi() {
  const key = 'clean-control-' + randomUUID(), requests = [];
  const server = createServer((request, response) => {
    let size = 0, chunks = [];
    request.on('data', chunk => { size += chunk.length; if (size <= 1048576) chunks.push(chunk); });
    request.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* Rejected below. */ }
      chunks = [];
      const valid = size <= 1048576 && request.method === 'POST' && request.url === '/v1/responses'
        && request.headers.authorization === 'Bearer ' + key && typeof payload?.model === 'string';
      requests.push({ at: new Date().toISOString(), method: request.method, path: request.url, valid });
      response.writeHead(valid ? 200 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      if (!valid) { response.end(JSON.stringify({ error: { message: 'External control API rejected request.' } })); return; }
      const text = 'Clean official host lifecycle search succeeded.';
      response.end(JSON.stringify({
        id: 'clean-response-' + requests.length, object: 'response', status: 'completed', model: payload.model,
        output_text: text, output: [
          { type: 'web_search_call', action: { sources: [
            { url: 'https://example.invalid/clean-lifecycle', title: 'Lifecycle control source', description: text },
          ] } },
          { type: 'message', content: [{ type: 'output_text', text }] },
        ],
      }));
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { key, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async close() { server.closeAllConnections(); await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); } };
}

async function programProcesses(executable, environment) {
  const result = await runBoundedCommand('/bin/ps', ['-axo', 'pid=,command='], { env: environment, timeout: 10_000 });
  assert.equal(result.code, 0); assert.equal(result.failure, null);
  return result.stdout.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match?.[2] === executable ? [Number(match[1])] : [];
  });
}

function selectBundle(rows) {
  assert.ok(Array.isArray(rows), 'Official listBundles must return an array.');
  return rows.find(row => row.name === BUNDLE) ?? null;
}

export async function runCleanLifecycle({ packageDirectory, outputRoot, version }) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.equal(version, VERSION);
  // Leave at least four minutes for an outstanding bounded RPC, shutdown, and receipts.
  const signal = AbortSignal.timeout(10 * 60_000);
  const until = (label, predicate, timeout) => pollUntil(label, predicate, timeout, signal);
  const root = newTemporaryOutput(outputRoot), privateRoot = join(root, 'private'), evidenceRoot = join(root, 'evidence');
  mkdirSync(privateRoot); mkdirSync(evidenceRoot);
  const pkg = readPackageArtifact(realpathSync(packageDirectory), FROZEN_PRODUCT_SHA256);
  const environment = acceptanceEnvironment(join(privateRoot, 'environment'));
  const profile = join(environment.DSH_HOME, 'profiles', 'desktop'), userData = join(privateRoot, 'electron-data');
  const observation = { managerResults: [] }, checkpoints = [], screenshots = [], transportErrors = [];
  const receipt = { schemaVersion: 1, kind: 'official-macos-clean-lifecycle-control', version,
    product: pkg.product, verifier: await acceptanceVerifierIdentity(pkg.product),
    execution: { platform: process.platform, arch: process.arch, repository: process.env.GITHUB_REPOSITORY ?? null,
      commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    boundary: { officialPackagedApp: true, cleanHome: true, hostFixturePlugins: false, syntheticHostProviders: false,
      syntheticSessions: false, hostHooks: false, privateHmrMutation: false, moduleMtimeMutation: false,
      externalHttpResponseStub: true, paidProviderValidated: false, modelDrivenChatValidated: false,
      productSettingsSearch: true, matrixReplacement: false },
    observation, checkpoints, screenshots, transportErrors,
  };
  let child, childExit, browser, page, cdp, api, programPath, asset, prepared, phase = 'prepare';
  let exited = false, forced = false, stdout = '', stderr = '';
  const redact = value => {
    let text = String(value).replaceAll(root, '<ISOLATED_RUN>').replaceAll(pkg.path, '<FROZEN_PACKAGE>');
    if (api) text = text.replaceAll(api.key, '<SYNTHETIC_KEY>');
    return text;
  };
  const safe = value => JSON.parse(redact(JSON.stringify(value)));
  const checkpoint = (name, value) => checkpoints.push({ name, at: new Date().toISOString(), value: safe(value) });
  const observeBoolean = async (name, label, measure, timeout) => {
    try { observation[name] = await until(label, measure, timeout); }
    catch (error) {
      if (error.code === 'CLEAN_OBSERVATION_TIMEOUT' && error.observed && error.lastValue === false) {
        observation[name] = false;
      }
      throw error;
    }
  };
  const capture = async name => boundedObservation(async () => {
    const state = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText,
      product: document.querySelector('[data-dsg-route]')?.shadowRoot?.querySelector('.dsg-root')?.innerText ?? null,
      actions: [...document.querySelectorAll('button,[role="switch"],input')].map(element => ({
        role: element.getAttribute('role'), label: element.getAttribute('aria-label'), text: element.innerText,
        checked: element.getAttribute('aria-checked'), disabled: element.disabled === true,
      })),
    }));
    checkpoint(name, state);
    const file = name + '.png', path = join(evidenceRoot, file);
    // Mask paths and editable fields, never the host's status/notice or toggle.
    await page.screenshot({ path, mask: [page.locator('input'), page.locator('#cfgPath')] });
    screenshots.push({ path: file, sha256: await hashFile(path) });
  }, { timeout: name === 'failure-ui' ? 10_000 : 30_000, signal: name === 'failure-ui' ? undefined : signal });
  const rpc = async (method, args = {}) => boundedObservation(() => page.evaluate(async ({ method, args }) => {
    const response = await fetch('/api/' + method, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(170000),
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    });
    const text = await response.text();
    if (!response.ok || !text) throw new Error('Official RPC transport: ' + response.status);
    const result = JSON.parse(text).result;
    if (!result?.ok) throw new Error('Official RPC: ' + (result?.error?.code ?? 'rejected'));
    return result.value;
  }, { method, args }), { timeout: 175_000, signal });
  const button = async (labels, timeout = 30_000) => {
    signal.throwIfAborted();
    const element = page.getByRole('button', { name: labels, exact: true });
    await element.click({ timeout });
  };
  const managerResult = async (action, from, targetEnabled) => {
    const row = await until('Native UI manager result was not observed', () =>
      observation.managerResults.slice(from).find(item => item.result.target === BUNDLE
        && item.result.enabled === targetEnabled), 180_000);
    row.action = action;
    return row.result;
  };
  const openDetail = async () => {
    await button(/^(插件|Plugins)$/);
    const back = page.getByRole('button', { name: /^(返回插件|Back to plugins)$/ });
    if (await back.isVisible()) await back.click();
    await button(/^(查看|View) dsh-grok-search$/);
    await page.locator('[data-plugin-detail="dsh-grok-search"]').waitFor({ state: 'visible', timeout: 30_000 });
  };
  const switchBundle = async enabled => {
    const toggle = page.locator('[data-plugin-detail="dsh-grok-search"]')
      .getByRole('switch', { name: /^(启用|Enable) dsh-grok-search$/, exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), String(!enabled));
    const from = observation.managerResults.length;
    await toggle.click();
    const result = await managerResult(enabled ? 'enable' : 'disable', from, enabled);
    await capture(enabled ? 'reenabled-ui' : 'disabled-ui');
    return result;
  };
  const search = async name => {
    const count = api.requests.length;
    const result = await rpc('grokSearchSettings/testSearch', { request: { query: 'Official host clean lifecycle control' } });
    const requests = api.requests.slice(count);
    const valid = result.fallbackUsed === false && result.sources?.some(row => row.url === 'https://example.invalid/clean-lifecycle')
      && requests.some(row => row.valid);
    checkpoint(name, { result, requests, valid });
    return valid;
  };
  try {
    assert.equal(existsSync(profile), false, 'The host must initialize its own profile.');
    const pin = macosHostPin(version);
    asset = await downloadPinnedMacosHost(pin, join(privateRoot, 'official-host.zip'), { signal });
    prepared = await prepareRuntime(privateRoot, asset, environment, signal);
    receipt.asset = asset; receipt.runtimeFiles = prepared.files;
    phase = 'launch';
    const port = await unusedPort();
    environment.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    environment.DSH_PRODUCT_ANALYTICS_OTLP_URL = 'http://127.0.0.1:9';
    child = spawn(prepared.runtime.executable, [
      '--user-data-dir=' + userData, '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port, '--lang=zh-CN',
    ], { cwd: privateRoot, env: environment, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = stream => bytes => {
      if (stdout.length + stderr.length > 8 * 1024 * 1024) return;
      if (stream === 'out') stdout += bytes; else stderr += bytes;
    };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    childExit = new Promise(done => {
      child.once('close', (code, signal) => { exited = true; done({ code, signal }); });
      child.once('error', error => { exited = true; done({ code: null, error: error.message }); });
    });
    receipt.debuggerPort = port;
    await until('Official Desktop debugger did not start', async () => {
      if (exited) throw new Error('Official Desktop exited before UI startup.');
      return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok;
    }, 60_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const welcome = await until('Fresh credential-free profile did not show the official welcome', () =>
      browser.contexts().flatMap(context => context.pages()).find(item => /\/renderer\/welcome\.html/.test(item.url())), 60_000);
    await welcome.locator('#api-key').click();
    await welcome.locator('#skip-key').click();
    await until('Official welcome did not close after Set up later', () => welcome.isClosed());
    page = await until('Official application did not open after Set up later', () =>
      browser.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('dsh-app://app/')), 60_000);
    checkpoint('welcome', { skippedViaNativeUi: true, credentialWritten: false });
    page.setDefaultTimeout(30_000);
    await page.bringToFront();
    await until('Official Desktop UI did not finish booting', async () => {
      const text = await page.locator('body').innerText();
      return text.trim() && !/Loading plugins|正在加载插件/i.test(text);
    }, 60_000);
    // Observe transport only: do not replace fetch, inject a service, or repair HMR records.
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const receive = (raw, transport) => {
      try {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const result = value?.result?.ok === true ? value.result.value : null;
        if (result?.target === BUNDLE && typeof result.application === 'string') {
          observation.managerResults.push({ action: 'native-ui', transport, at: new Date().toISOString(), result });
        }
      } catch { /* Non-JSON frames are not manager responses. */ }
    };
    cdp.on('Network.webSocketFrameReceived', event => receive(event.response.payloadData, 'websocket'));
    const responseJobs = new Set();
    page.on('response', response => {
      if (!/\/api\/pluginManager\//.test(response.url())) return;
      const job = response.text().then(text => receive(text, 'http')).catch(error => transportErrors.push(redact(error.message)));
      responseJobs.add(job); job.finally(() => responseJobs.delete(job));
    });
    const initialManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    observation.cleanProfile = Object.keys(initialManifest.dependencies ?? {}).length === 0
      && JSON.stringify(initialManifest.dsh?.profile?.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    assert.equal(observation.cleanProfile, true, 'The control must contain only official default bundles.');
    checkpoint('official-profile', initialManifest);
    // Explicit strict install policy only; the profile and its business composition remain host-generated.
    const npmrc = join(profile, '.npmrc');
    assert.equal(existsSync(npmrc), false, 'Do not overwrite a host-created install policy.');
    writeFileSync(npmrc, 'auto-install-peers=true\nstrict-peer-dependencies=true\nlegacy-peer-deps=false\nforce=false\n', { flag: 'wx' });
    await capture('initial-ui');
    phase = 'install';
    await button(/^(插件|Plugins)$/);
    await button(/^(添加插件|Add plugin)$/);
    const thirdParty = page.getByRole('button', { name: /^(安装第三方插件|Install third-party plugin)$/ });
    if (await thirdParty.isVisible()) await thirdParty.click();
    await page.getByRole('textbox', { name: /^(包名或地址|Package name or URL)$/ }).fill(pkg.path);
    await page.getByRole('dialog').getByRole('button', { name: /^(安装|Install)$/, exact: true }).click();
    await until('Native UI installation did not resolve the product', async () => {
      const bundle = selectBundle(await rpc('pluginManager/listBundles'));
      if (bundle?.error) throw new Error(JSON.stringify(bundle.error));
      return bundle?.version === pkg.product.version;
    }, 180_000);
    const enableNow = page.getByRole('button', { name: /^(立即启用|Enable now)$/ });
    await enableNow.waitFor({ state: 'visible', timeout: 30_000 });
    const from = observation.managerResults.length;
    await enableNow.click();
    await managerResult('install-enable', from, true);
    const done = page.getByRole('dialog').getByRole('button', { name: /^(完成|Done)$/, exact: true });
    if (await done.isVisible()) await done.click();
    const nativeInstall = inspectDesktopNativeInstall(profile, pkg.product.version);
    checkpoint('native-install-audit', nativeInstall);
    observation.nativeInstall = true;
    phase = 'prepare-program';
    const preparedState = await until('Product program preparation did not complete', async () => {
      const state = await rpc('grokSearchSettings/snapshot');
      if (state.program?.phase === 'error') throw new Error(JSON.stringify(state.program.error));
      return state.program?.phase === 'ready' ? state : null;
    }, 180_000);
    checkpoint('program-prepared', preparedState);
    programPath = preparedState.program.program.path;
    const cache = join(profile, 'grok-search/runtime-cache'), rel = relative(cache, realpathSync(programPath));
    assert.ok(rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
    const activePath = join(cache, 'active.json'), active = JSON.parse(readFileSync(activePath, 'utf8'));
    const activeSha256 = await hashFile(activePath);
    observation.programPrepared = active.mcpHandshakeValidated === true && active.credentialsValidated === false
      && preparedState.program.program.source === 'private-cache'
      && await hashFile(programPath) === active.sha256;
    api = await externalApi();
    await openDetail();
    await page.locator('.row[data-id="grok"] .row-main').click();
    await page.locator('input[data-k="url"]').fill(api.baseUrl);
    await page.locator('input[data-k="key"]').fill(api.key);
    await page.locator('[data-a="save"]').click();
    await until('Production configuration did not save', async () => {
      const state = await rpc('grokSearchSettings/snapshot');
      return state.config.fields.grok_api_key.configured && state.config.fields.grok_api_url.value === api.baseUrl;
    });
    const configured = await rpc('grokSearchSettings/snapshot'), configPath = configured.config.path;
    const configHash = await hashFile(configPath);
    checkpoint('configured', configured);
    phase = 'search-before';
    observation.searchBefore = await search('search-before');
    checkpoint('program-processes-before-disable', await programProcesses(programPath, environment));
    await capture('ready-ui');
    phase = 'disable';
    await switchBundle(false);
    await observeBoolean('disabledSelection', 'Native selection did not disable', async () =>
      selectBundle(await rpc('pluginManager/listBundles'))?.enabled === false);
    const released = await until('Durable release did not complete', () => {
      const row = readReleaseCompletion(profile);
      return row?.intent?.policy === 'released' && row.intent.releaseCompletion ? row : null;
    });
    checkpoint('release-completion', released);
    const completion = released.intent.releaseCompletion;
    observation.releaseCompleted = completion.kind === 'explicit-release-completion' && completion.routeVerified === true
      && completion.routeEvidence?.fetchPreserved === true && completion.routeEvidence?.dependenciesPreserved === true;
    await observeBoolean('processStopped', 'Product process remained after native disable', async () =>
      (await programProcesses(programPath, environment)).length === 0, 15_000);
    checkpoint('disabled-bundle', selectBundle(await rpc('pluginManager/listBundles')));
    phase = 'reenable';
    await switchBundle(true);
    await observeBoolean('reenabledSelection', 'Native selection did not re-enable', async () =>
      selectBundle(await rpc('pluginManager/listBundles'))?.enabled === true);
    const resumed = await until('Product did not become ready after re-enable', async () => {
      const state = await rpc('grokSearchSettings/snapshot');
      return state.program?.phase === 'ready' && state.control?.phase === 'required' ? state : null;
    }, 45_000);
    checkpoint('resumed', resumed);
    phase = 'search-after';
    observation.searchAfter = await search('search-after');
    observation.cacheReused = resumed.program.program.path === programPath
      && await hashFile(activePath) === activeSha256 && await hashFile(programPath) === active.sha256;
    observation.configurationPreserved = await hashFile(configPath) === configHash;
    await capture('working-again-ui');
    await boundedObservation(() => Promise.all(responseJobs), { timeout: 10_000, signal });
  } catch (error) {
    receipt.failure = { phase, message: redact(error.message) };
    observation.executionError = true;
    if (page && !page.isClosed()) {
      try { await boundedObservation(() => capture('failure-ui'), { timeout: 10_000 }); }
      catch (captureError) { receipt.captureError = redact(captureError.message); }
    }
  } finally {
    phase = 'cleanup';
    receipt.cleanupErrors = [];
    const cleanup = async (name, work, timeout = 15_000) => {
      try { await boundedObservation(work, { timeout }); }
      catch (error) {
        observation.executionError = true;
        receipt.cleanupErrors.push({ name, message: redact(error.message) });
      }
    };
    if (child && !exited) await cleanup('desktop-shutdown', async () => {
      try { await requestDesktopShutdown(receipt.debuggerPort, childExit, { timeoutMs: 20_000 }); }
      catch (error) {
        receipt.shutdownError = redact(error.message); forced = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
        await Promise.race([childExit, delay(5000)]);
        if (!exited) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
        }
      }
    }, 32_000);
    if (childExit) {
      const exit = await Promise.race([childExit, delay(5000).then(() => ({ code: null, timeout: true }))]);
      receipt.exit = { ...exit, forced };
      observation.hostExited = exit.code === 0 && !forced;
    }
    if (browser) await cleanup('browser-detach', () => browser.close(), 10_000);
    if (api) { receipt.externalRequests = api.requests; await cleanup('external-api', () => api.close(), 5000); }
    if (programPath) await cleanup('final-program-processes', async () => {
      observation.finalProcessStopped = (await programProcesses(programPath, environment)).length === 0;
    });
    await cleanup('product-integrity', async () => {
      let unchanged = true;
      const installed = join(profile, 'node_modules', BUNDLE);
      if (existsSync(installed)) {
        for (const row of pkg.product.sourceHashes) {
          if (!existsSync(join(installed, row.file)) || hashPackageSource(join(installed, row.file)) !== row.sha256) unchanged = false;
        }
        observation.productUnchanged = unchanged;
      } else observation.productUnchanged = null;
    });
    if (prepared) await cleanup('host-integrity', async () => {
      let unchanged = true;
      for (const row of Object.values(prepared.files)) {
        if (await hashFile(join(prepared.host, row.path)) !== row.sha256) unchanged = false;
      }
      observation.hostUnchanged = unchanged;
    }, 30_000);
    receipt.hostOutput = { stdout: redact(stdout.slice(-24000)), stderr: redact(stderr.slice(-24000)) };
    receipt.result = classifyCleanLifecycle(observation);
    receipt.completedAt = new Date().toISOString();
    json(join(evidenceRoot, 'clean-lifecycle.json'), safe(receipt));
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCleanArguments(process.argv.slice(2));
  runCleanLifecycle({ packageDirectory: args['--package-directory'], outputRoot: args['--output-root'], version: args['--version'] })
    .then(receipt => {
      console.log(JSON.stringify({ result: receipt.result, failure: receipt.failure ?? null }));
      process.exitCode = receipt.result.functionalPassed ? 0 : 1;
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
