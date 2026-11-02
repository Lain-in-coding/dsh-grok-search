import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { packInternal } from './pack-internal.mjs';
import { project, freshRun, writeJson, commandResult, receipt, npmCli, sha256, cleanEnvironment, configSecrets, redact } from './lib/internal-candidate-utils.mjs';

let oldDesktop, newDesktop, realGrokExecutable, realGrokConfig, existingTarball;
let diagnoseProviders = [], upstreamMode = 'unspecified';
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--desktop-rc2') oldDesktop = process.argv[++index];
  else if (process.argv[index] === '--desktop-rc21') newDesktop = process.argv[++index];
  else if (process.argv[index] === '--real-grok-executable') realGrokExecutable = process.argv[++index];
  else if (process.argv[index] === '--real-grok-config') realGrokConfig = process.argv[++index];
  else if (process.argv[index] === '--package') existingTarball = process.argv[++index];
  else if (process.argv[index] === '--diagnose-providers') diagnoseProviders = process.argv[++index].split(',').filter(Boolean);
  else if (process.argv[index] === '--upstream-mode') upstreamMode = process.argv[++index];
  else throw new Error('未知内部候选参数：' + process.argv[index]);
}
if (!['unspecified', 'loopback', 'paid'].includes(upstreamMode)) throw new Error('Unknown acceptance upstream mode.');
if (new Set(diagnoseProviders).size !== diagnoseProviders.length
  || diagnoseProviders.some(provider => !['tavily', 'exa', 'tinyfish', 'firecrawl', 'github'].includes(provider))) {
  throw new Error('Unknown or repeated acceptance diagnosis provider.');
}
if (!oldDesktop || !newDesktop) throw new Error('请同时提供 --desktop-rc2 和 --desktop-rc21。');
const runtimes = [candidateRuntime(oldDesktop), candidateRuntime(newDesktop)];
const targetVersions = (process.env.DSH_B2_TARGET_VERSIONS ?? '0.2.1-rc.2,0.2.1-rc.3').split(',').map(value => value.trim()).filter(Boolean);
assert.deepEqual(runtimes.map(runtime => runtime.app.version), targetVersions);
const realOnly = Boolean(realGrokExecutable || realGrokConfig || existingTarball);
if (realOnly && (!realGrokExecutable || !realGrokConfig || !existingTarball)) throw new Error('真实冒烟须同时给出 --package、--real-grok-executable、--real-grok-config。');
if (!realOnly && (diagnoseProviders.length || upstreamMode !== 'unspecified')) throw new Error('Provider diagnosis requires an explicit package, program and isolated configuration.');
const realConfigHashBefore = realOnly ? sha256(realGrokConfig) : null;
const realExecutableHashBefore = realOnly ? sha256(realGrokExecutable) : null;
const { directory, runId } = freshRun(realOnly ? 'internal-candidate-real' : 'internal-candidate');
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-internal-candidate-'));
const replacements = [...(realOnly ? [[realGrokExecutable, '<GROK_EXECUTABLE>'], [realGrokConfig, '<GROK_CONFIG>']] : []), [sandbox, '<SANDBOX>'], ...runtimes.map(runtime => [dirname(runtime.executable), `<DESKTOP_${runtime.app.version}>`])];
const secrets = new Set(realOnly ? configSecrets(realGrokConfig) : []);
const sanitize = value => redact(value, replacements, [...secrets]);
const safeValue = value => JSON.parse(sanitize(JSON.stringify(value)));
const results = [], executions = [], hosts = [];
const protectedPaths = ['scripts/lib/asar.mjs', 'scripts/lib/grok-smoke.mjs'];
const protectedBefore = Object.fromEntries(protectedPaths.map(path => [path, sha256(join(project, path))]));
let sequence = 0;
let packageResult;

async function runCommand(label, command, args, options) {
  console.log(label);
  const result = await commandResult(command, args, { sanitize, ...options });
  const path = label.replace(/[^\w.-]/g, '-') + '-execution.json';
  writeJson(join(directory, path), receipt(result));
  executions.push({ label, file: path, exitCode: result.exitCode, timedOut: result.timedOut });
  return result;
}
async function caseResult(name, version, execute) {
  const record = { case: name, version, status: 'running', observations: [] };
  results.push(record);
  try { await execute(record); record.status = 'pass'; }
  catch (error) { record.status = error instanceof assert.AssertionError ? 'fail' : 'harnessError'; record.error = safeValue({ name: error.name, message: error.message }); }
  console.log(`${version ?? 'core'} ${name}: ${record.status}`);
  return record;
}
function startHost(runtime, root, env) {
  const command = [runtime.executable, '--expose-internals', join(project, 'scripts/internal-candidate-host.mjs'), runtime.archivePath, root];
  const child = spawn(command[0], command.slice(1), { cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state = { command: command.map(sanitize), cwd: sanitize(root), events: [], pending: new Map(), stdout: '', stderr: '', timedOut: false, requests: [] };
  child.stdout.on('data', chunk => { state.stdout += chunk; });
  child.stderr.on('data', chunk => { state.stderr += chunk; });
  child.on('error', error => { state.spawnError = error.message; });
  const safety = setTimeout(() => { state.timedOut = true; child.kill('SIGKILL'); }, realOnly ? 180_000 : 120_000);
  state.closed = new Promise(done => child.once('close', (code, signal) => {
    clearTimeout(safety); state.exitCode = code; state.signal = signal; state.stopped = true;
    for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('候选 Host 在回复前退出。')); }
    state.pending.clear(); done();
  }));
  child.on('message', message => {
    if (message.type === 'reply') {
      const pending = state.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); state.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value); else pending.reject(new Error(message.error?.message ?? '候选 IPC 失败。'));
    } else state.events.push(message);
  });
  const host = { child, state, version: runtime.app.version, root,
    async event(type, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const fatal = state.events.find(event => event.type === 'fatal'); if (fatal) throw new Error(fatal.error.message);
        const found = state.events.find(event => event.type === type); if (found) return found;
        if (state.stopped) throw new Error('候选 Host 已退出。');
        await new Promise(done => setTimeout(done, 30));
      }
      throw new Error('候选 Host 等待超时：' + type);
    },
    request(op, args = {}) {
      if (state.stopped) return Promise.reject(new Error('候选 Host 已退出。'));
      const id = `candidate-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { state.pending.delete(id); reject(new Error('候选 IPC 超时：' + op)); }, 35_000);
        state.pending.set(id, { timer, resolve, reject }); child.send({ id, op, args });
      });
    },
    async close() {
      if (!state.stopped) {
        try { await host.request('close'); }
        catch (error) { state.closeError = error.message; child.kill('SIGKILL'); }
      }
      await Promise.race([state.closed, new Promise(done => setTimeout(() => { if (!state.stopped) child.kill('SIGKILL'); done(); }, 8_000))]);
      if (!state.stopped) await state.closed;
    },
  };
  child.send({ fixtureNode: process.execPath, ...(realOnly ? { realGrok: {
    executable: realGrokExecutable, configPath: realGrokConfig, query: 'DeepSeek Harness official plugin documentation',
  } } : {}) }); hosts.push(host); return host;
}
async function rpc(host, cookie, endpoint, request) {
  const origin = (await host.event('listening')).origin;
  const payload = { type: 'client-request', rpcId: `candidate-rpc-${++sequence}`, method: endpoint, payload: { args: { request } } };
  const response = await fetch(origin + '/api/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  host.state.requests.push({ endpoint, request: payload, status: response.status, response: body, authorization: 'isolated-test-cookie' });
  assert.equal(response.status, 200); assert.equal(body?.result?.ok, true, JSON.stringify(body)); return body.result.value;
}
async function session(host) {
  const listening = await host.event('listening');
  const auth = await fetch(listening.authUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  assert.equal(auth.status, 303);
  const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]; assert.ok(cookie);
  secrets.add(cookie); secrets.add(cookie.slice(cookie.indexOf('=') + 1));
  const ready = await host.event('ready');
  const created = await rpc(host, cookie, 'session/create', { cwd: ready.workspace }); assert.ok(created.sessionId);
  return { cookie, sessionId: created.sessionId };
}
async function turn(host, auth, mode, stage) {
  const before = await host.request('snapshot');
  await rpc(host, auth.cookie, 'session/prompt', { requestId: `candidate-prompt-${++sequence}`, sessionId: auth.sessionId, mode: 'queue', content: [{ type: 'text', text: mode }] });
  const deadline = Date.now() + (realOnly ? 125_000 : 15_000);
  while (Date.now() < deadline) {
    const after = await host.request('snapshot');
    const events = after.sessionEvents.slice(before.sessionEvents.length).filter(event => event.sessionId === auth.sessionId);
    const final = events.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === '内部候选轮次完成'));
    const ended = final && events.find(event => event.type === 'turn/end' && event.data.turn === final.data.turn && event.data.reason?.kind === 'completed');
    const tool = final && events.findLast(event => event.type === 'tool/result' && event.data.turn === final.data.turn);
    if (after.completed > before.completed && ended && (mode === 'chat' || tool)) {
      const text = tool?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
      return { stage, mode, calls: after.calls, core: after.core, sdk: after.sdk, runtimeWeb: after.runtimeWeb,
        model: { completed: true, turn: final.data.turn, ...(tool ? { isError: tool.data.message.isError === true, text, result: tool.data.message } : {}) }, mcpEvents: after.mcpEvents };
    }
    await new Promise(done => setTimeout(done, 35));
  }
  throw new Error('模型未完成受控轮次：' + stage);
}
function reaped(state) {
  const diagnostic = state.core?.lastDiagnostic; assert.ok(diagnostic); assert.equal(diagnostic.exited, true);
  assert.equal(state.core.running, 0); assert.equal(state.core.queued, 0); assert.equal(state.core.faulted, 0);
  assert.ok(Number.isSafeInteger(diagnostic.childPid));
  assert.throws(() => process.kill(diagnostic.childPid, 0), error => error.code === 'ESRCH');
}
async function verifyHost(runtime, root, env) {
  const host = startHost(runtime, root, env); let auth;
  const bootCase = await caseResult('official-host-loads-installed-package', runtime.app.version, async record => {
    const ready = await host.event('ready'); record.observations.push({ stage: 'loaded', ...ready });
    assert.deepEqual(ready.failed, []); assert.deepEqual(ready.pending, []); assert.equal(ready.runtimeWeb.searchProviderId, 'grok-search');
    assert.equal(ready.runtimeWeb.fetchProviderId, 'candidate-fetch'); assert.equal(ready.existingDependencyPresent, true);
    assert.deepEqual(ready.webInject, ['candidateExistingDependency']); assert.equal(ready.existingDisposed, 0);
    auth = await session(host);
  });
  if (bootCase.status !== 'pass') { await host.close(); return; }
  for (const mode of ['structured', 'text-json', 'sources']) {
    await caseResult('native-tool-' + mode, runtime.app.version, async record => {
      await host.request('mode', { mode }); const model = await turn(host, auth, 'search', mode); record.observations.push(model);
      assert.equal(model.model.isError, false); assert.ok(model.model.text.includes('内部候选离线搜索成功')); assert.equal(model.calls.original, 0);
      assert.equal(model.sdk.version, '2.4.0'); assert.equal(model.sdk.suppliedByPlugin, true); reaped(model);
      if (mode === 'sources') assert.ok(model.mcpEvents.some(event => event.tool === 'get_sources'));
    });
  }
  for (const [mode, code, message] of [
    ['rpc-error', 'GROK_MCP_ERROR', 'Grok 初始化或搜索失败'], ['tool-error', 'GROK_TOOL_ERROR', 'Grok 搜索报告错误'],
    ['invalid-result', 'GROK_INVALID_RESULT', 'Grok 返回了不符合协议的结果'],
  ]) {
    await caseResult('explicit-error-' + mode, runtime.app.version, async record => {
      await host.request('mode', { mode }); const model = await turn(host, auth, 'search', mode); record.observations.push(model);
      assert.equal(model.model.isError, true); assert.ok(model.model.text.includes(message)); assert.equal(model.calls.original, 0);
      assert.ok(!model.model.text.includes('fixture-private-value')); reaped(model);
      const seam = await host.request('direct-search'); record.observations.push({ stage: mode + '-seam', seam });
      assert.equal(seam.ok, false); assert.equal(seam.error.code, code);
    });
  }
  await caseResult('fetch-chat-and-existing-dependency', runtime.app.version, async record => {
    const fetchTurn = await turn(host, auth, 'fetch', 'fetch'); record.observations.push(fetchTurn);
    assert.equal(fetchTurn.model.isError, false); assert.ok(fetchTurn.model.text.includes('离线 fetch 保持'));
    assert.equal(fetchTurn.runtimeWeb.fetchProviderId, 'candidate-fetch');
    const echo = await turn(host, auth, 'echo', 'echo'); record.observations.push(echo); assert.equal(echo.model.isError, false);
    const chat = await turn(host, auth, 'chat', 'chat'); record.observations.push(chat); assert.equal(chat.model.completed, true);
    const state = await host.request('snapshot'); assert.equal(state.existingDisposed, 0); assert.equal(state.existingDependencyPresent, true);
    assert.deepEqual(state.webInject, ['candidateExistingDependency']); assert.equal(state.calls.original, 0);
  });
  await caseResult('running-query-cancel-reaps-process', runtime.app.version, async record => {
    await host.request('cancel-start');
    const deadline = Date.now() + 8_000; let state;
    while (Date.now() < deadline) {
      state = await host.request('snapshot');
      if (state.mcpEvents.findLast(event => event.mode === 'hang' && event.tool === 'web_search')) break;
      await new Promise(done => setTimeout(done, 35));
    }
    assert.ok(state.mcpEvents.findLast(event => event.mode === 'hang' && event.tool === 'web_search'));
    const result = await host.request('cancel-finish'); state = await host.request('snapshot');
    record.observations.push({ stage: 'caller-cancel', result, state });
    assert.equal(result.ok, false); assert.equal(result.callerReasonPreserved, true); reaped(state); assert.equal(state.calls.original, 0);
    await host.request('mode', { mode: 'structured' }); const model = await turn(host, auth, 'search', 'after-cancel');
    record.observations.push(model); assert.equal(model.model.isError, false); reaped(model);
  });
  await caseResult('ordinary-dispose-does-not-release-search', runtime.app.version, async record => {
    const disposed = await host.request('dispose-core'); record.observations.push({ stage: 'disposed', state: disposed });
    assert.equal(disposed.runtimeWeb.searchProviderId, 'grok-search'); assert.equal(disposed.runtimeWeb.searchProviderIds.includes('grok-search'), false);
    const seam = await host.request('direct-search'); record.observations.push({ stage: 'after-dispose', seam });
    assert.equal(seam.ok, false); assert.equal(disposed.calls.original, 0);
    const fetchTurn = await turn(host, auth, 'fetch', 'fetch-after-dispose'); record.observations.push(fetchTurn); assert.equal(fetchTurn.model.isError, false);
  });
  await host.close();
}

async function verifyRealHost(runtime, root, env) {
  const host = startHost(runtime, root, env);
  let managedPid = null, auth = null;
  await caseResult('real-grok-native-tool-query', runtime.app.version, async record => {
    const ready = await host.event('ready');
    assert.deepEqual(ready.failed, []); assert.deepEqual(ready.pending, []);
    const deadline = Date.now() + 30000;
    let program = ready.productProgram;
    while (program?.phase !== 'ready' && Date.now() < deadline) {
      if (program?.phase === 'error') throw new Error('Isolated Grok preparation failed: ' + JSON.stringify(program.error));
      await new Promise(resolve => setTimeout(resolve, 100));
      program = (await host.request('snapshot')).productProgram;
    }
    assert.equal(program?.phase, 'ready', 'Isolated Grok must be ready before the native tool query.');
    auth = await session(host);
    const model = await turn(host, auth, 'search', 'real-grok-query');
    // 不留真实回答正文，只保存可核查的路由、来源 URL 与进程事实。
    const urls = [...new Set([...model.model.text.matchAll(/https?:\/\/[^\s<>()]+/g)].map(match => match[0]))];
    record.observations.push({ stage: 'real-tool-result', model: { isError: model.model.isError, completed: model.model.completed,
      textChars: model.model.text.length, sourceUrls: urls },
      calls: model.calls, core: model.core, sdk: model.sdk, runtimeWeb: model.runtimeWeb });
    assert.equal(model.model.isError, false); assert.ok(urls.length > 0);
    assert.equal(model.calls.original, 0); assert.equal(model.sdk.version, '2.4.0'); assert.equal(model.sdk.suppliedByPlugin, true);
    assert.equal(model.core.lastDiagnostic.serverVersion, '0.1.26');
    assert.equal(model.core.lastDiagnostic.fallbackUsed, false, 'Supplementary-source fallback cannot validate the Grok primary key/model.');
    assert.equal(model.core.lastDiagnostic.exited, false, 'A successful query keeps the managed MCP session.');
    assert.equal(model.core.session?.connected, true);
    assert.equal(model.core.session?.active, false);
    assert.equal(model.core.running, 0); assert.equal(model.core.queued, 0);
    assert.equal(model.core.faulted, 0); assert.equal(model.core.routeExecutor.running, 0);
    managedPid = model.core.lastDiagnostic.childPid;
    assert.ok(Number.isSafeInteger(managedPid));
    process.kill(managedPid, 0);
    const fetchTurn = await turn(host, auth, 'fetch', 'real-profile-fetch-stub');
    record.observations.push({ stage: 'fetch-control', model: { completed: fetchTurn.model.completed, isError: fetchTurn.model.isError }, runtimeWeb: fetchTurn.runtimeWeb });
    assert.equal(fetchTurn.model.isError, false); assert.equal(fetchTurn.runtimeWeb.fetchProviderId, 'candidate-fetch');
  });
  // One request per configured key, once across the two Host versions. This
  // calls the installed production settings gateway, not a parallel adapter.
  if (runtime === runtimes[0]) for (const provider of diagnoseProviders) {
    await caseResult('real-provider-diagnosis-' + provider, runtime.app.version, async record => {
      auth ??= await session(host);
      const outcome = await rpc(host, auth.cookie, 'grokSearchSettings/diagnoseProvider', { provider });
      record.observations.push({ stage: 'production-settings-diagnosis', result: outcome });
      assert.equal(outcome.provider, provider);
      assert.equal(outcome.status, 'ok', `${provider} diagnosis did not return usable results.`);
      if (provider === 'github') assert.equal(outcome.authenticated, true);
      else {
        assert.ok(outcome.keys.length > 0);
        for (const key of outcome.keys) assert.equal(key.status, 'ok', `Key ${key.keyIndex + 1} is not usable.`);
      }
    });
  }
  managedPid ??= (await host.request('snapshot')).core?.lastDiagnostic?.childPid ?? null;
  await host.close();
  await caseResult('real-grok-reaped-after-host-close', runtime.app.version, async record => {
    assert.equal(host.state.exitCode, 0); assert.equal(host.state.timedOut, false);
    assert.ok(Number.isSafeInteger(managedPid));
    assert.throws(() => process.kill(managedPid, 0), error => error.code === 'ESRCH');
    record.observations.push({ stage: 'owned-process-exit', childPid: managedPid,
      hostExitCode: host.state.exitCode, orphanProgram: false });
  });
}

try {
  if (!realOnly) await caseResult('provider-and-commit-unit-tests', null, async record => {
    const result = await runCommand('unit-tests', process.execPath, ['--test', join(project, 'test/provider-core.test.mjs'), join(project, 'test/commit-message.test.mjs')], { cwd: project });
    record.observations.push({ stage: 'tests', exitCode: result.exitCode, output: result.stdout }); assert.equal(result.exitCode, 0);
  });
  if (realOnly) {
    const packageReceipt = JSON.parse(readFileSync(join(dirname(existingTarball), 'package-receipt.json'), 'utf8'));
    assert.equal(sha256(existingTarball), packageReceipt.sha256);
    packageResult = { tarball: existingTarball, packageReceipt };
    writeJson(join(directory, 'package-receipt.json'), packageReceipt);
  } else packageResult = await packInternal(directory);
  for (const runtime of runtimes) {
    const root = join(sandbox, runtime.app.version); const profile = join(root, 'dsh-home', 'profiles', 'candidate');
    mkdirSync(profile, { recursive: true });
    const env = cleanEnvironment(root, { DSH_HOME: join(root, 'dsh-home'), ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: runtime.executable });
    const configFile = join(root, 'npm-empty.ini'); writeFileSync(configFile, '');
    const globalConfigFile = join(root, 'npm-global-empty.ini'); writeFileSync(globalConfigFile, '');
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'candidate-profile', version: '0.0.0', private: true, type: 'module' }, null, 2));
    const installation = await caseResult('same-tarball-isolated-install', runtime.app.version, async record => {
      const result = await runCommand('install-' + runtime.app.version, process.execPath, [npmCli, 'install', packageResult.tarball,
        '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', join(root, 'npm-cache'), '--userconfig', configFile, '--globalconfig', globalConfigFile],
        { cwd: profile, env: { ...env, ELECTRON_RUN_AS_NODE: '' }, timeoutMs: 180_000 });
      record.observations.push({ stage: 'install', exitCode: result.exitCode, tarballSha256: packageResult.packageReceipt.sha256 }); assert.equal(result.exitCode, 0);
      const installed = join(profile, 'node_modules', 'dsh-grok-search');
      for (const file of packageResult.packageReceipt.files) assert.equal(sha256(join(installed, file.path)), sha256(join(project, file.path)), file.path);
      const require = createRequire(join(installed, 'package.json')); const sdkEntry = require.resolve('@modelcontextprotocol/client');
      let sdkRoot = dirname(sdkEntry); while (!existsSync(join(sdkRoot, 'package.json'))) sdkRoot = dirname(sdkRoot);
      const sdk = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')); assert.equal(sdk.name, '@modelcontextprotocol/client'); assert.equal(sdk.version, '2.4.0');
      assert.equal(existsSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh')), false);
      record.observations.push({ stage: 'installed-content-and-sdk', version: sdk.version, sdkEntry, samePackageFiles: true, officialPeerCopiesInstalled: false });
    });
    if (installation.status !== 'pass') continue;
    if (!realOnly) await caseResult('pinned-sdk-process-integration', runtime.app.version, async record => {
      const result = await runCommand('mcp-tests-' + runtime.app.version, runtime.executable, ['--test', join(project, 'test/provider-mcp.test.mjs')],
        { cwd: root, env: { ...env, DSH_TEST_RUNTIME_ROOT: profile, DSH_TEST_NODE: process.execPath }, timeoutMs: 60_000 });
      record.observations.push({ stage: 'sdk-integration', sdkVersion: '2.4.0', exitCode: result.exitCode, output: result.stdout });
      assert.equal(result.exitCode, 0); assert.match(result.stdout, /(?:skipped|skip)\s+0/);
    });
    if (realOnly) await verifyRealHost(runtime, root, env); else await verifyHost(runtime, root, env);
  }
} catch (error) {
  results.push({ case: 'runner-fatal', version: null, status: 'harnessError', error: safeValue({ message: error.message, stack: error.stack }) });
} finally {
  for (const host of hosts) {
    if (!host.state.stopped) await host.close();
    const { pending, closed, ...state } = host.state;
    if (realOnly) {
      state.requests = state.requests.map(request => ({ endpoint: request.endpoint, status: request.status, authorization: request.authorization }));
      // No paid answer bodies, parser inputs or provider stderr in artifacts.
      state.events = state.events.map(event => event.type === 'fatal'
        ? { type: 'fatal', error: event.error }
        : { type: event.type, ...(event.value?.core ? { core: event.value.core } : {}) });
      state.stdout = { capturedChars: state.stdout.length, persisted: false };
      state.stderr = { capturedChars: state.stderr.length, persisted: false };
    }
    writeJson(join(directory, 'host-' + host.version + '.json'), safeValue(state));
  }
  if (realOnly && (sha256(realGrokConfig) !== realConfigHashBefore || sha256(realGrokExecutable) !== realExecutableHashBefore)) results.push({ case: 'shared-grok-unchanged', status: 'fail', observations: [] });
  const protectedAfter = Object.fromEntries(protectedPaths.map(path => [path, sha256(join(project, path))]));
  const protectedUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter);
  if (!protectedUnchanged) results.push({ case: 'historical-evidence-unchanged', status: 'fail', observations: [{ protectedBefore, protectedAfter }] });
  const counts = { pass: results.filter(result => result.status === 'pass').length, fail: results.filter(result => result.status === 'fail').length,
    harnessErrors: results.filter(result => result.status === 'harnessError').length };
  const exitCode = counts.fail || counts.harnessErrors ? 1 : 0;
  const summary = { runId, createdAt: new Date().toISOString(), package: packageResult?.packageReceipt ?? null,
    runtimes: runtimes.map(runtime => ({ version: runtime.app.version, runtime: runtime.runtime.version, selector: runtime.selectorKind,
      node: runtime.manifest.release.nodeVersion, cordis: runtime.archive.json('dsh/node_modules/@deepseek-ai/cordis/package.json').version,
      schemastery: runtime.archive.json('dsh/node_modules/@deepseek-ai/schemastery/package.json').version,
      bundledSdk: runtime.archive.json('dsh/node_modules/@modelcontextprotocol/client/package.json').version })),
    counts, exitCode, results, protectedUnchanged, protectedBefore, protectedAfter,
    upstreamMode, diagnosisProviders: diagnoseProviders,
    harnessSourceHashes: ['scripts/internal-candidate.mjs', 'scripts/internal-candidate-host.mjs',
      'scripts/lib/internal-candidate-utils.mjs', 'fixtures/internal-candidate/host-fixture.mjs']
      .map(file => ({ file, sha256: sha256(join(project, file)) })),
    realPaidPrimaryValidated: upstreamMode === 'paid'
      && results.filter(result => result.case === 'real-grok-native-tool-query').length === runtimes.length
      && results.filter(result => result.case === 'real-grok-native-tool-query').every(result => result.status === 'pass'),
    realPaidProviderDiagnosticsValidated: upstreamMode === 'paid' && diagnoseProviders.length > 0
      && diagnoseProviders.every(provider => results.some(result =>
        result.case === 'real-provider-diagnosis-' + provider && result.status === 'pass')),
    ...(realOnly ? { sharedGrokUnchanged: sha256(realGrokConfig) === realConfigHashBefore && sha256(realGrokExecutable) === realExecutableHashBefore, realGrokVersion: '0.1.26' } : {}),
    boundaries: [realOnly ? '同一压缩包；真实官方 Desktop/Host/HTTP Session；离线模型；真实已有 Grok 0.1.26 与共享配置' : '同一压缩包；真实官方 Desktop/Host/HTTP Session；离线模型与外部 MCP 夹具', 'npm 隔离安装不是桌面 PluginManager 安装 UI 验收',
      'fetch 是无网络 stub', '精确错误码来自 direct seam；模型只核验 isError 与文字',
      '临时作者 selector 只用于查询验证；自动接管／释放／退出提示和旧记录恢复未验收',
      realOnly ? '每版仅一次原生搜索；可选逐来源诊断仅第一版执行；上游原生预取/内部回退不能当主后端健康，未改共享配置、全局程序或正式 profile' : '未执行真实收费查询、正式 profile 改动、提交、推送或发布',
      '真实上游结果正文与原始 stdout/stderr 不持久化；配置凭据和编码形式先脱敏'] };
  writeJson(join(directory, 'summary.json'), safeValue(summary));
  writeJson(join(directory, 'execution.json'), { runId, command: process.execPath, args: process.argv.slice(1).map(sanitize), cwd: '<PROJECT>',
    envPolicy: '临时 DSH_HOME 与用户目录；只继承系统和代理变量；npm 使用空白用户/全局配置', executions, exitCode });
  console.log(JSON.stringify({ runId, directory: sanitize(directory), counts, exitCode, package: packageResult?.packageReceipt.filename ?? null }, null, 2));
  process.exitCode = exitCode;
}
