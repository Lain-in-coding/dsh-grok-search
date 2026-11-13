import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { prepareDesktopFixture } from './deferred-release-desktop-prepare.mjs';
import { connectRenderer, requestDesktopShutdown, waitForRenderer } from './lib/renderer-cdp.mjs';
import { cleanEnvironment, commandResult, freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';
import { createSharedConfigStore, resolveSharedConfigPath, CONFIG_FIELDS } from '../src/core/shared-config.mjs';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';
import { findExistingGrok } from '../src/core/program-discovery.mjs';
import { followStreamingSearchCard } from './lib/browser-gates.mjs';

// Opt-in live services, no live key ever enters arguments, screenshots or files.
const live = process.argv.includes('--allow-live');
const liveSmoke = process.argv.includes('--live-smoke');
const editable = process.argv.includes('--editable-config');
const githubRead = process.argv.includes('--github-read');
const clientBaseline = process.argv.includes('--frozen-client-baseline');
const args = process.argv.slice(2).filter(value => !['--allow-live', '--editable-config', '--live-smoke', '--github-read','--frozen-client-baseline'].includes(value));
if(clientBaseline&&live)throw new Error('A client performance baseline may only use synthetic services.');
if (args.length < 2 || live && editable || liveSmoke && !live) throw new Error('Usage: node scripts/verify-search-log-desktop.mjs [--allow-live [--live-smoke] | --editable-config] <tgz> <official-executables...>');
const tarball = resolve(args[0]), runtimes = args.slice(1).map(candidateRuntime);
const packageReceipt = JSON.parse(readFileSync(join(dirname(tarball), 'package-receipt.json'), 'utf8'));
assert.equal(sha256(tarball), packageReceipt.sha256);
for (const row of packageReceipt.sourceHashes) {
  if(clientBaseline&&['src/client.js','README.md'].includes(row.file))continue;
  assert.equal(sha256(join(project, row.file)), row.sha256);
}
const run = freshRun(live ? 'search-log-desktop-live' : 'search-log-desktop');
const temporary = join(realpathSync(tmpdir()), 'dsh-deferred-desktop-search-log-' + run.runId);
const sourceFiles = [...packageReceipt.sourceHashes.map(row => row.file),
  'scripts/verify-search-log-desktop.mjs', 'scripts/deferred-release-desktop-prepare.mjs',
  'fixtures/deferred-release/desktop-fixture.mjs', 'fixtures/deferred-release/github-api-fixture.mjs',
  'fixtures/internal-candidate/host-fixture.mjs', 'scripts/lib/renderer-cdp.mjs', 'scripts/lib/browser-gates.mjs'];
const sourceHashes = sourceFiles.map(file => ({ file, sha256: sha256(join(project, file)) }));
const secrets = new Set(), results = [], exits = [];
const safeCode = error => /^[\w.-]{1,80}$/.test(error?.code ?? '') ? error.code : 'DESKTOP_VALIDATION_FAILED';
const safeError = error => {
  let message = String(error?.message ?? 'Desktop verification failed');
  for (const secret of secrets) message = message.split(secret).join('<REDACTED>');
  for (const path of [temporary, project]) message = message.split(path).join('<ISOLATED>');
  return { code: safeCode(error), message: message.slice(0, 1000) };
};
const sharedPath = live ? resolveSharedConfigPath() : null;
const sharedHash = live ? sha256(sharedPath) : null;
const values = live ? Object.fromEntries(Object.entries(createSharedConfigStore({ path: sharedPath }).readEffective())
  .map(([key, field]) => [key, field.value])) : null;
if (live) for (const [key, spec] of Object.entries(CONFIG_FIELDS)) if (spec.type === 'secret') {
  for (const secret of [values[key], ...String(values[key] ?? '').split(',')].filter(Boolean)) secrets.add(secret);
}
const key = 'dsh-desktop-log-' + randomUUID();
secrets.add(key);
let mode = 'ok', fatal = null, owned = null;
const requests = [];
const upstream = createServer(async (request, response) => {
  for await (const _ of request) { /* Never retain bodies or credentials. */ }
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  requests.push({ path, mode, method: request.method });
  response.setHeader('content-type', 'application/json');
  if (mode === 'quota-failed' && path === '/tavily/usage') { response.writeHead(503); response.end('{}'); }
  else if (path === '/tavily/usage') response.end(JSON.stringify({ account: { plan_usage: 12, plan_limit: 1000 }, key: { usage: 12, limit: 100 } }));
  else if (path === '/firecrawl/v2/team/credit-usage') response.end(JSON.stringify({ data: { remainingCredits: 890 } }));
  else if (path === '/tinyfish/v1/wallet') response.end(JSON.stringify({ available_balance: '12.345', currency: 'USD' }));
  else if (path === '/v1/responses') {
    response.end(JSON.stringify({ id: 'isolated-attribution', object: 'response', status: 'completed',
      output_text: 'Synthetic primary answer without citations.',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Synthetic primary answer without citations.' }] }] }));
  }
  else if (mode.startsWith('mcp-') && !path.startsWith('/' + mode.slice(4))) {
    response.writeHead(429); response.end('{}');
  }
  else if (mode === 'failed' || mode === 'fallback' && path.includes('tavily')) {
    response.writeHead(429); response.end('{}');
  } else {
    const source = { url: 'https://example.test/desktop-evidence', title: 'Desktop search log evidence',
      content: 'isolated result', summary: 'isolated result', snippet: 'isolated result', description: 'isolated result', score: .99 };
    response.end(JSON.stringify(path.includes('firecrawl')
      ? { data: { web: [source] }, creditsUsed: 2 }
      : { results: [source], usage: { credits: 1 }, costDollars: { total: 0.007 } }));
  }
});
await new Promise(done => upstream.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${upstream.address().port}`;
const q = selector => `(() => [document.querySelector('[data-dsg-route]')?.shadowRoot,
  document.querySelector('[data-dsg-layer]')?.shadowRoot].map(root => root?.querySelector(${JSON.stringify(selector)})).find(Boolean))()`;
const dom = (renderer, expression) => renderer.evaluate(expression);
const click = (renderer, selector) => dom(renderer, `(() => { const element=${q(selector)};
  if(!element || element.disabled) return false; element.click(); return true; })()`);
const until = async (renderer, expression, timeoutMs = 30_000) => {
  try { return await waitForRenderer(renderer, current => current.evaluate(expression), { timeoutMs }); }
  catch (failure) { throw new Error(failure.message + ' Predicate: ' + expression, { cause: failure }); }
};
const inside = path => {
  const rel = relative(temporary, resolve(path));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'new run path only');
  return path;
};
async function rpc(renderer, service, method, args = {}) {
  return renderer.evaluate(`(async () => {
    const method=${JSON.stringify(service + '/' + method)};
    const response=await fetch('/api/'+method,{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},signal:AbortSignal.timeout(90_000),
      body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:${JSON.stringify(args)}}})});
    const result=(await response.json()).result;
    if(!result?.ok) throw new Error(result?.error?.code || 'RPC failed');
    return result.value;
  })()`);
}
async function probe(host, op, args = {}) {
  host.address = JSON.parse(readFileSync(host.addressPath, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${host.address.port}/probe`, {
    method: 'POST', headers: { authorization: host.control.token, 'content-type': 'application/json' },
    body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(90_000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error?.code || 'Isolated probe failed');
  return result.value;
}
async function modelTurn(host, mode) {
  if (!host.modelSession) {
    const auth = await probe(host, 'model-auth');
    const response = await fetch(auth.url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 303);
    host.cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(host.cookie);
    secrets.add(host.cookie);
    host.modelRpc = async (method, request) => {
      const response = await fetch(host.address.hostOrigin + '/api/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json', Origin: host.address.hostOrigin, Cookie: host.cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }),
        signal: AbortSignal.timeout(20_000),
      });
      const message = await response.json();
      if (!message.result?.ok) throw new Error(message.result?.error?.code || 'Model RPC failed');
      return message.result.value;
    };
    host.modelSession = (await host.modelRpc('session/create', { cwd: host.control.workspace })).sessionId;
    assert.ok(host.modelSession);
  }
  const before = await probe(host, 'snapshot');
  await host.modelRpc('session/prompt', { requestId: randomUUID(), sessionId: host.modelSession,
    mode: 'queue', content: [{ type: 'text', text: mode }] });
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const after = await probe(host, 'snapshot');
    const events = after.sessionEvents.slice(before.sessionEvents.length).filter(row => row.sessionId === host.modelSession);
    const final = events.findLast(row => row.type === 'assistant/message'
      && row.data.message.content.some(block => block.type === 'text' && block.text.endsWith('内部候选轮次完成')));
    const ended = final && events.find(row => row.type === 'turn/end'
      && row.data.turn === final.data.turn && row.data.reason?.kind === 'completed');
    const tool = final && events.findLast(row => row.type === 'tool/result' && row.data.turn === final.data.turn);
    if (ended && (mode === 'chat' || tool)) return {
      mode, isError: tool?.data.message.isError === true, completed: true,
      sessionId: host.modelSession, callId: tool?.data.message.toolCallId ?? null,
      originalDelta: after.calls.original - before.calls.original,
      fetchDelta: after.calls.fetch - before.calls.fetch,
      ...(mode.startsWith('github') ? { githubDelta: (after.calls.github ?? 0) - (before.calls.github ?? 0),
        text: tool?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') } : {}),
    };
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error('Session turn did not complete: ' + mode);
}
async function stop(host) {
  if (!host) return;
  host.renderer?.close();
  if (!host.ended) {
    try { await requestDesktopShutdown(host.port, host.closed, { timeoutMs: 20_000 }); }
    catch (error) {
      host.shutdownError = safeError(error);
      if (!host.ended) { host.forced = true; host.child.kill('SIGKILL'); await host.closed; }
    }
  }
  if (!host.exitSaved) {
    exits.push({ version: host.runtime.app.version, code: host.exitCode, forced: !!host.forced,
      stderrRetained: false, shutdownError: host.shutdownError ?? null });
    host.exitSaved = true;
  }
}
async function association() {
  if (process.platform !== 'win32') return null;
  const result = await commandResult(process.env.SystemRoot + '/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\dsh\\shell\\open\\command');if($null -eq $k){Write-Output '<absent>'}else{Write-Output ([string]$k.GetValue(''));$k.Close()}"],
    { timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  return result.rawStdout;
}
const associationBefore = await association();
const binariesBefore = runtimes.map(runtime => ({ version: runtime.app.version, exe: sha256(runtime.executable), asar: sha256(runtime.archivePath) }));
try {
  const program = await findExistingGrok({ override: process.env.DSH_LOG_GROK_PROGRAM });
  assert.equal(program.found, true);
  for (const runtime of runtimes) {
    mode = 'ok';
    const version = runtime.app.version, folder = inside(join(temporary, version));
    prepareDesktopFixture(runtime.executable, folder, { versionedControlRecord: true, pluginManagerEntries: true, liveHmr: true });
    const control = JSON.parse(readFileSync(join(folder, 'local-control.json'), 'utf8'));
    secrets.add(control.token);
    const extraction = inside(join(folder, 'tarball'));
    mkdirSync(extraction);
    const extract = await commandResult(process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-xf', tarball, '-C', extraction], { timeoutMs: 30_000 });
    assert.equal(extract.exitCode, 0, 'isolated candidate extraction must succeed');
    const product = inside(join(control.profile, 'node_modules/dsh-grok-search'));
    renameSync(inside(join(extraction, 'package')), product);
    for (const row of packageReceipt.sourceHashes) assert.equal(sha256(join(product, row.file)), row.sha256);
    mkdirSync(join(product, 'node_modules'));
    for (const name of readdirSync(join(project, 'node_modules'))) {
      if (name.startsWith('.') || name === '@deepseek-ai') continue;
      symlinkSync(join(project, 'node_modules', name), join(product, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const manifestPath = join(control.profile, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies['dsh-grok-search'] = packageReceipt.version;
    manifest.dsh.profile.bundles.push('dsh-grok-search');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const configPath = join(folder, editable ? 'editable-synthetic-config.toml' : 'not-written-config.toml');
    // Live probes keep keys in env. Editable/restart coverage uses synthetic keys only.
    writeFileSync(join(control.profile, 'cordis.patch.yml'), JSON.stringify([
      { id: 'grok-search', config: { executable: program.path, configPath } },
    ]));
    const preferences = createPrivatePreferences({ path: join(control.profile, 'grok-search/preferences.json') });
    const initialPreferences = preferences.snapshot();
    preferences.save(initialPreferences.revision, { ...initialPreferences.value, grokEnabled: false, githubEnabled: false });
    const config = live ? values : {
      grok_api_url: origin + '/v1', grok_api_key: key, grok_auth_mode: 'api_key', grok_model: 'isolated-attribution',
      web_search_enabled: true, x_search_enabled: false,
      tavily_api_url: origin + '/tavily', tavily_api_key: key,
      exa_api_url: origin + '/exa', exa_api_key: key,
      firecrawl_api_url: origin + '/firecrawl', firecrawl_api_key: key,
      tinyfish_search_api_url: origin + '/tinyfish', tinyfish_api_key: key,
      source_providers: ['tavily', 'exa', 'firecrawl', 'tinyfish'],
      tavily_enabled: true, exa_enabled: true, firecrawl_enabled: true, tinyfish_enabled: true,
    };
    if (editable) {
      const store = createSharedConfigStore({ path: configPath, env: () => ({}) });
      store.save({ expectedRevision: 'missing', updates: Object.fromEntries(Object.entries(config)
        .filter(([name]) => !CONFIG_FIELDS[name].readOnly)) });
    }
    const initialConfigHash = editable ? sha256(configPath) : null;
    const envFields = editable ? {} : Object.fromEntries(Object.entries(CONFIG_FIELDS).filter(([name]) => config[name] !== undefined)
      .map(([name, spec]) => [spec.env, Array.isArray(config[name]) ? config[name].join(',') : String(config[name])]));
    const { createServer: netServer } = await import('node:net');
    const reservation = netServer();
    await new Promise(done => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    const addressPath = join(folder, 'probe-address.json');
    const env = cleanEnvironment(folder, {
      DSH_HOME: control.dshHome, DSH_DESKTOP_DSH_DIR: control.runtime,
      DSH_DESKTOP_PRIMARY_RUNTIME_DIR: control.primaryRuntime, DSH_DESKTOP_PNPM_ENTRY: control.pnpmEntry,
      DSH_DESKTOP_FIXTURE_TOKEN: control.token, DSH_DESKTOP_FIXTURE_ADDRESS_FILE: addressPath,
      DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_B2_CONTROL_RECORD: '1', DSH_B2_PRODUCT_COUNTER: '1',
      DSH_DESKTOP_OFFLINE_SENTINEL: 'offline-test-sentinel-not-a-real-key',
      ...(githubRead ? { DSH_GITHUB_READ_FIXTURE: '1' } : {}),
      DSH_PRODUCT_ANALYTICS_OTLP_URL: 'http://127.0.0.1:9', GROK_SEARCH_CONFIG: configPath, ...envFields,
    });
    const child = spawn(control.electron, [...(process.platform === 'win32' ? [runtime.archivePath] : []), '--user-data-dir=' + control.userData,
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--lang=zh-CN'],
    { cwd: folder, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    const host = owned = { runtime, child, control, port, addressPath, ended: false };
    host.closed = new Promise(done => child.once('close', code => { host.ended = true; host.exitCode = code; done(); }));
    const checks = [];
    host.checks = checks;
    const check = (name, actual, expected = true) => {
      checks.push({ name, passed: JSON.stringify(actual) === JSON.stringify(expected) });
      assert.deepEqual(actual, expected, name);
    };
    console.log(JSON.stringify({ version, phase: 'starting-isolated-desktop', live }));
    const deadline = Date.now() + 90_000;
    while (!existsSync(addressPath) && !host.ended && Date.now() < deadline) await new Promise(done => setTimeout(done, 200));
    assert.equal(host.ended, false);
    assert.ok(existsSync(addressPath), 'Desktop probe ready');
    const renderer = host.renderer = await connectRenderer(port, { requestTimeoutMs: 100_000 });
    await renderer.send('Page.bringToFront');
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Hosted macOS can default to reduced motion. Exercise both preferences
    // deliberately instead of expecting moving packets under a static policy.
    await renderer.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    check('animated motion preference verified', await dom(renderer,
      `matchMedia('(prefers-reduced-motion: reduce)').matches`), false);
    await until(renderer, `document.readyState==='complete' && [...document.querySelectorAll('button')]
      .some(e=>(e.getAttribute('aria-label')||e.innerText||'').trim()==='插件')`, 60_000);
    check('settings page not yet opened', await dom(renderer,
      `!document.querySelector('[data-dsg-route]')`));
    const beforeFirstVisit = await modelTurn(host, 'search');
    check('search before first settings visit succeeds', beforeFirstVisit.isError, false);
    check('first search uses no original provider', beforeFirstVisit.originalDelta, 0);
    const firstCallRoute = await rpc(renderer, 'grokSearchSettings', 'toolCallRoute', {
      request: { sessionId: beforeFirstVisit.sessionId, callId: beforeFirstVisit.callId },
    });
    check('first call linked to its true source', firstCallRoute.known && firstCallRoute.routes[0]?.served === 'tavily');
    await dom(renderer, `(() => { [...document.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||e.innerText||'').trim()==='插件').click(); })()`);
    await until(renderer, `[...document.querySelectorAll('button')].some(e=>e.getAttribute('aria-label')==='查看 dsh-grok-search')`);
    await dom(renderer, `document.querySelector('button[aria-label="查看 dsh-grok-search"]').click()`);
    await until(renderer, `${q('#routeCard')} && ${q('#routeCard')}.dataset.s!=='load'`);
    check('official plugin detail mounts production Shadow DOM', await dom(renderer,
      `Boolean(document.querySelector('[data-plugin-detail="dsh-grok-search"]') && ${q('#logCard')} && !document.querySelector('#logCard'))`));
    check('same packaged client', sha256(join(product, 'src/client.js')), packageReceipt.sourceHashes.find(row=>row.file==='src/client.js').sha256);
    const projectLink = `document.querySelector('[data-dsg-project]')?.shadowRoot?.querySelector('a')`;
    await until(renderer, `Boolean(${projectLink}?.querySelector('img')?.complete)`);
    check('project GitHub badge is in the native title row', await dom(renderer, `(() => {
      const detail=document.querySelector('[data-plugin-detail="dsh-grok-search"]');
      const heading=detail.querySelector('h3'), badge=detail.querySelector('[data-dsg-project]');
      return !!badge && heading.parentElement.contains(badge) && detail.querySelectorAll('[data-dsg-project]').length===1;
    })()`));
    check('project badge has the fixed safe external link and exact tooltip', await dom(renderer, `(() => {
      const link=${projectLink};
      return link.href==='https://github.com/Lain-in-coding/dsh-grok-search'
        && link.target==='_blank' && link.rel==='noopener noreferrer'
        && link.getAttribute('aria-label')==='打开 dsh-grok-search 的 GitHub 项目首页（新窗口）'
        && link.getRootNode().querySelector('[role=tooltip]').textContent==='用着还行？给个 star';
    })()`));
    check('project badge is 16px with a 24px target', await dom(renderer, `(() => {
      const link=${projectLink}, icon=link.querySelector('img');
      const a=link.getBoundingClientRect(), i=icon.getBoundingClientRect();
      return [a.width,a.height,i.width,i.height].map(size=>Math.round(size*100)/100).concat(icon.naturalWidth>0);
    })()`), [24, 24, 16, 16, true]);
    await dom(renderer, `${projectLink}.focus()`);
    await until(renderer, `getComputedStyle(${projectLink}.getRootNode().querySelector('[role=tooltip]')).visibility==='visible'`);
    check('project badge has a visible keyboard focus ring', await dom(renderer,
      `getComputedStyle(${projectLink}).outlineStyle==='solid'`));
    const pageState = `JSON.stringify([location.href, Boolean(document.querySelector('[data-plugin-detail="dsh-grok-search"]')),
      Boolean(${q('#routeCard')})])`;
    const beforeEscape = await dom(renderer, pageState);
    await renderer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(renderer, `(() => { const tip=${projectLink}?.getRootNode().querySelector('[role=tooltip]');
      return !tip || getComputedStyle(tip).visibility==='hidden'; })()`);
    check('project tooltip dismisses on Escape without navigation', await dom(renderer, pageState), beforeEscape);
    await dom(renderer, `${projectLink}.blur()`);
    const layoutWidths = [1366, 1100, 1000];
    for (const width of layoutWidths) {
      await renderer.send('Emulation.setDeviceMetricsOverride', {
        width, height: 925, deviceScaleFactor: 1, mobile: false,
      });
      await until(renderer, `(() => {
        const stage=${q('#stage')};
        return stage && !stage.getAnimations().some(animation => animation.playState==='running');
      })()`);
      check(`native detail and all route controls fit at ${width}px`, await dom(renderer, `(() => {
        const mount=document.querySelector('[data-dsg-route]'), root=mount.shadowRoot;
        const bounds=mount.getBoundingClientRect(), card=root.querySelector('#routeCard');
        const fits=element=>{
          if(!element.getClientRects().length || getComputedStyle(element).visibility==='hidden') return true;
          const rect=element.getBoundingClientRect();
          return rect.left>=bounds.left-1 && rect.right<=bounds.right+1;
        };
        return [mount,root.querySelector('.dsg-root'),root.querySelector('.route-scroll'),card]
          .every(element=>element.scrollWidth<=element.clientWidth+1)
          && Math.abs(card.getBoundingClientRect().width-root.querySelector('#logCard').getBoundingClientRect().width)<1
          && [...root.querySelectorAll('#stage,.rc-head,.rc-actions,#testBtn,.node,.row,.row .switch,.rc-foot [data-open]')].every(fits)
          && [...root.querySelectorAll('.row-name')].every(element=>element.scrollWidth<=element.clientWidth+1);
      })()`));
    }
    await renderer.send('Emulation.clearDeviceMetricsOverride');
    await until(renderer, `${q('#logCard')}.innerText.includes('最近')`);
    await until(renderer, `${q('.le-query')}?.textContent==='内部候选离线查询'`);
    check('first visit includes search made from chat', await dom(renderer,
      `${q('.le-query')}.textContent`), '内部候选离线查询');
    if (liveSmoke) {
      const actual = await rpc(renderer, 'grokSearchSettings', 'readSearchLog', { request: { sessionId: randomUUID() } });
      const row = actual.records.find(item => item.sessionId === beforeFirstVisit.sessionId && item.callId === beforeFirstVisit.callId);
      check('live call log agrees with exact session attribution', row?.queries?.[0]?.served === firstCallRoute.routes[0].served
        && row.callFinished === true && row.queries[0].kind === 'sources');
      const state = await rpc(renderer, 'grokSearchSettings', 'snapshot');
      const quota = await rpc(renderer, 'grokSearchSettings', 'accountQuota', { request: {
        provider: 'tavily', expectedRevision: state.config.revision, quotaRevision: state.config.quotaRevision,
        operationId: randomUUID(),
      } });
      check('same saved live Tavily account exposes actual quota through native RPC', quota.value?.kind === 'credits');
      results.push({ version, passed: true, checks, live: true, source: firstCallRoute.routes[0].served,
        searchCalls: 1, logMatched: true, originalDelta: beforeFirstVisit.originalDelta,
        scope: 'official-Desktop-real-Session-synthetic-model-live-Tavily-upstream' });
      writeJson(join(run.directory, version + '-checks.json'), results.at(-1));
      await stop(host);
      console.log(JSON.stringify({ version, phase: 'live-smoke-passed', checks: checks.length }));
      continue;
    }
    const before = await probe(host, 'snapshot');
    const answer = await probe(host, 'product-query-result', { query: 'DeepSeek Harness GitHub official repository', timeoutMs: live ? 30_000 : 5000 });
    check('host WebRuntime receives usable result', answer.sources.length > 0);
    await until(renderer, `${q('.log-entry')}?.dataset.kind==='sources'
      && ${q('.log-entry .le-query')}?.textContent==='DeepSeek Harness GitHub official repository'`);
    check('real request appears in log', await dom(renderer, `${q('.log-entry .le-query')}.textContent`), 'DeepSeek Harness GitHub official repository');
    check('log details expand', await click(renderer, '.log-entry .le-head'));
    check('actual source consumption rendered', await dom(renderer, `Boolean(${q('.log-entry .lu-charge')})`));
    const replayCalls = requests.length, baseline = (await probe(host, 'snapshot')).calls.original;
    check('user replay button', await click(renderer, '.log-entry [data-log-replay]'));
    await until(renderer, `!${q('#historyStage')}.hidden`);
    check('main graph historical full route', await dom(renderer,
      `[...${q('#historyRoute')}.querySelectorAll('.lnode')].map(e=>e.dataset.node)`), ['dsh', 'hub', 'tavily']);
    await until(renderer, `Boolean(${q('.hr-wires .packet')})`);
    check('approved packet glow retained', await dom(renderer, `(() => {const p=${q('.hr-wires .packet')};
      return [p.querySelector('.p-halo').getAttribute('r'),p.querySelector('.p-core').getAttribute('r')];})()`), ['7', '3.2']);
    check('replay stop', await click(renderer, '#historyStop'));
    await until(renderer, `${q('#historyStage')}.hidden`);
    check('replay can complete naturally', await click(renderer, '.log-entry [data-log-replay]'));
    await until(renderer, `${q('#historyBar')}?.dataset.phase==='done' && ${q('#historyStage')}.hidden`, 30_000);
    await renderer.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    // Changing the media query cancels any retained replay context. Wait for
    // that observable listener result before clicking a new replay.
    await until(renderer, `${q('#historyBar')}.hidden && ${q('#historyStage')}.hidden`);
    check('reduced motion preference verified', await dom(renderer,
      `matchMedia('(prefers-reduced-motion: reduce)').matches`));
    check('reduced motion replay remains available', await click(renderer, '.log-entry [data-log-replay]'));
    await until(renderer, `!${q('#historyStage')}.hidden && ${q('#historyPhase')}.textContent==='Tavily'`);
    check('reduced motion shows terminal route without moving packets', await dom(renderer,
      `${q('#historyStage')}.querySelectorAll('.packet').length`), 0);
    check('reduced motion returns to current configuration', await click(renderer, '#historyStop'));
    await until(renderer, `${q('#historyStage')}.hidden`);
    await renderer.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    check('replay did not call loopback provider', requests.length, replayCalls);
    check('replay did not invoke original provider', (await probe(host, 'snapshot')).calls.original, baseline);
    check('privacy hides query', await click(renderer, '#logPrivacy'));
    check('query masked', await dom(renderer, `${q('.le-query')}.textContent`), '搜索内容已隐藏');
    await click(renderer, '#logPrivacy');
    const sessionSearch = await modelTurn(host, 'search');
    check('canonical session web_search succeeds', sessionSearch.isError, false);
    check('canonical search does not call original provider', sessionSearch.originalDelta, 0);
    await until(renderer, `${q('.le-query')}.textContent==='内部候选离线查询'`);
    check('canonical tool query appears in recent history', await dom(renderer, `${q('.le-query')}.textContent`), '内部候选离线查询');
    const callRoute = await rpc(renderer, 'grokSearchSettings', 'toolCallRoute', {
      request: { sessionId: sessionSearch.sessionId, callId: sessionSearch.callId },
    });
    check('canonical call route uses exact session/call identity', callRoute.known && callRoute.routes[0]?.served === 'tavily');
    check('unknown call cannot inherit latest route', (await rpc(renderer, 'grokSearchSettings', 'toolCallRoute', {
      request: { sessionId: sessionSearch.sessionId, callId: 'not-a-recorded-call' },
    })).known, false);
    // Native same-window navigation: open the already searched chat from its actual sidebar row.
    const chatRow = `document.querySelector('[data-row-key="session:${sessionSearch.sessionId}"]')`;
    await dom(renderer, `(() => {
      const group = document.querySelector('[data-row-key="workspace:"][aria-expanded="false"]');
      group?.click();
    })()`);
    await until(renderer, `!!${chatRow}`, 20_000);
    await dom(renderer, `${chatRow}.click()`);
    await until(renderer, `!document.querySelector('[data-dsg-route]')`);
    const attributedCard = `document.querySelector('[data-dsg-search-card="${sessionSearch.callId}"]')`;
    await until(renderer, `!!${attributedCard}`);
    await dom(renderer, `(() => {
      for (const button of document.querySelectorAll('button,[role=button]')) {
        if (/已完成.*用时/.test(button.textContent || '') && button.getAttribute('aria-expanded') !== 'true') button.click();
      }
    })()`);
    await dom(renderer, `(() => {
      for(const button of document.querySelectorAll('button[data-process-activity][aria-expanded=false]'))button.click();
    })()`);
    await until(renderer, `${attributedCard}.getBoundingClientRect().height>0`);
    await dom(renderer, `${attributedCard}.scrollIntoView({ block: 'center' })`);
    await until(renderer, `${attributedCard}?.querySelector('.card-name')?.textContent==='dsh-grok-search'`);
    check('chat shows plugin title and actual provider', await dom(renderer,
      `${attributedCard}.querySelector('.card-name').textContent==='dsh-grok-search'
        && ${attributedCard}.querySelector('.provider-steps').textContent.includes('Tavily')`));
    check('host search references retained in the enhanced card', await dom(renderer,
      `${attributedCard}.querySelectorAll('.source-row[href^="https://example.test/"]').length>0`));
    await dom(renderer, `(() => {
      for (const button of document.querySelectorAll('button,[role=button]')) {
        if (button.matches('.dsg-chat .card-toggle') && button.getAttribute('aria-expanded') !== 'true') button.click();
      }
    })()`);
    await until(renderer, `(() => {
      const element = ${attributedCard}?.querySelector('.provider-steps');
      return element && element.getBoundingClientRect().height > 0 && element.innerText.includes('Tavily');
    })()`);
    check('chat route is visibly displayed, not hidden in a collapsed tree', await dom(renderer,
      `${attributedCard}.querySelector('.provider-steps').getBoundingClientRect().height>0`));
    const detailedTrace = await rpc(renderer,'grokSearchSettings','toolCallTrace',{
      request:{sessionId:sessionSearch.sessionId,callId:sessionSearch.callId},
    });
    check('chat details RPC agrees with the exact provider attempt',detailedTrace.known
      && detailedTrace.routes[0].calls[0].provider==='tavily'
      && detailedTrace.routes[0].calls[0].result==='ok'
      && typeof detailedTrace.routes[0].calls[0].elapsedMs==='number');
    check('chat preserves native parameter inspector',await dom(renderer,
      `!!${attributedCard}.querySelector('button.inspect-btn')`));
    await dom(renderer, `${attributedCard}.scrollIntoView({ block: 'center' })`);
    const cardImage = await renderer.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(run.directory, version + '-chat-route.png'), Buffer.from(cardImage.data, 'base64'), { flag: 'wx' });
    if (!live) {
      // Measure the actual official chat while the fixture model streams, not
      // just a static card rendered in a browser. No real credentials/upstreams.
      await renderer.send('Page.bringToFront');
      await renderer.send('Performance.enable');
      await renderer.send('Profiler.enable');
      await renderer.send('Profiler.start');
      const metricsBefore=(await renderer.send('Performance.getMetrics')).metrics;
      await dom(renderer, `(() => {
        const data=window.__dsgHostPerf={measurements:0,heightAnimations:0,longTasks:[],frames:[],streamFrames:0,mutations:0,visibility:[document.visibilityState]};
        const OriginalIntersectionObserver=window.IntersectionObserver;
        data.intersections=[];
        let observerId=0;
        window.IntersectionObserver=class extends OriginalIntersectionObserver{
          constructor(callback,options){
            const id=++observerId;
            super((entries,observer)=>{
              const relevant=entries.filter(entry=>entry.target.matches?.('.dsg-chat'));
              if(relevant.length&&data.intersections.length<120)data.intersections.push({
                id,at:performance.now(),entries:relevant.map(entry=>({
                  callId:entry.target.dataset.dsgSearchCard,connected:entry.target.isConnected,
                  time:entry.time,intersecting:entry.isIntersecting,ratio:entry.intersectionRatio,
                  top:entry.boundingClientRect.top,height:entry.boundingClientRect.height,
                  root:entry.rootBounds&&{top:entry.rootBounds.top,bottom:entry.rootBounds.bottom},
                })),
              });
              callback(entries,observer);
            },options);
          }
        };
        const onVisibility=()=>data.visibility.push(document.visibilityState);
        document.addEventListener('visibilitychange',onVisibility);
        const measure=Element.prototype.getBoundingClientRect,animate=Element.prototype.animate;
        const taskObserver=new PerformanceObserver(list=>{for(const task of list.getEntries())data.longTasks.push(Math.round(task.duration));});
        taskObserver.observe({type:'longtask'});
        const changes=new MutationObserver(list=>{data.mutations+=list.length;});
        changes.observe(document.body,{subtree:true,childList:true,characterData:true});
        Element.prototype.getBoundingClientRect=function(...args){
          if(this.classList?.contains('card-body')&&this.closest('.dsg-chat'))data.measurements++;
          return Reflect.apply(measure,this,args);
        };
        Element.prototype.animate=function(...args){
          if((this.classList?.contains('card-body')||this.classList?.contains('fold-inner'))&&this.closest('.dsg-chat'))data.heightAnimations++;
          return Reflect.apply(animate,this,args);
        };
        const streaming={initialCallIds:new Set([...document.querySelectorAll('.dsg-chat')]
          .map(card=>card.dataset.dsgSearchCard)),card:null,open:false};
        data.streaming=streaming;
        const follow=${followStreamingSearchCard.toString()};
        let previous=null,frame;
        // Keep tracking through pending->result DOM replacement and host scroll
        // changes. Visibility of the initial placeholder is not proof that the
        // final enhanced card is open, so cleanup belongs to data.stop below.
        const openTimer=setInterval(()=>follow(document,streaming),100);
        const tick=time=>{if(previous!==null)data.frames.push(time-previous);previous=time;
          if(streaming.open&&streaming.card?.isConnected&&streaming.card.dataset.visible==='true')data.streamFrames++;
          frame=requestAnimationFrame(tick);
        };frame=requestAnimationFrame(tick);
        data.stop=()=>{cancelAnimationFrame(frame);clearInterval(openTimer);taskObserver.disconnect();changes.disconnect();
          document.removeEventListener('visibilitychange',onVisibility);
          window.IntersectionObserver=OriginalIntersectionObserver;
          Element.prototype.getBoundingClientRect=measure;Element.prototype.animate=animate;};
      })()`);
      let streamed, streamFailure;
      try { streamed=await modelTurn(host,'search stream'); }
      catch (error) { streamFailure=error; throw error; }
      finally {
        try {
        const profile=(await renderer.send('Profiler.stop')).profile;
        writeJson(join(run.directory,version+'-chat-cpu-profile.json'),profile);
        const metricsAfter=(await renderer.send('Performance.getMetrics')).metrics;
        const durations=Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount']
          .map(name=>[name,(metricsAfter.find(row=>row.name===name)?.value??0)-(metricsBefore.find(row=>row.name===name)?.value??0)]));
        const nodes=new Map(profile.nodes.map(node=>[node.id,node.callFrame]));
        const totals=new Map();
        for(let index=0;index<(profile.samples?.length??0);index++){
          const call=nodes.get(profile.samples[index]);
          const label=`${call?.functionName??''} ${call?.url??''}:${call?.lineNumber??0}`;
          totals.set(label,(totals.get(label)??0)+(profile.timeDeltas?.[index]??0));
        }
        writeJson(join(run.directory,version+'-chat-cpu-summary.json'),{durations,
          top:[...totals].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([frame,us])=>({frame,ms:Math.round(us/1000)}))});
        const metrics=await dom(renderer, `(() => {
          const data=window.__dsgHostPerf;data.stop();
          const sorted=data.frames.toSorted((a,b)=>a-b);
          const result={measurements:data.measurements,heightAnimations:data.heightAnimations,longTasks:data.longTasks,
            frameCount:data.frames.length,frameP95Ms:Math.round((sorted[Math.floor(sorted.length*.95)]??0)*100)/100,
            maxFrameMs:Math.round((sorted.at(-1)??0)*100)/100,visibleCardFrames:data.streamFrames,domMutations:data.mutations,visibility:data.visibility,
            observedCallId:data.streaming.card?.dataset.dsgSearchCard??null,observedConnected:data.streaming.card?.isConnected===true,
            observedVisible:data.streaming.card?.dataset.visible??null,observedOpen:data.streaming.open,
            intersections:data.intersections,
            observedTitle:data.streaming.card?.querySelector('.card-name')?.textContent??null,
            observedAncestors:(()=>{
              const rows=[];
              for(let node=data.streaming.card;node&&rows.length<20;node=node.parentElement){
                const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
                rows.push({tag:node.tagName,class:node.className,hidden:node.getAttribute('hidden'),
                  top:rect.top,bottom:rect.bottom,height:rect.height,width:rect.width,
                  display:style.display,visibility:style.visibility,contentVisibility:style.contentVisibility,
                  overflowY:style.overflowY,scrollTop:node.scrollTop,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight});
              }
              return rows;
            })()};
          delete window.__dsgHostPerf;return result;
        })()`);
        writeJson(join(run.directory,version+'-chat-stream-performance.json'),{
          ...metrics, modelTurnCompleted:streamed?.completed===true,
          modelFailure:streamFailure?safeError(streamFailure):null,
        });
        // A failed RPC never exercised the full streaming case. Keep its real
        // cause instead of masking it with an assertion about a partial frame.
        if(!streamFailure){
          if(metrics.visibleCardFrames<=30){
            metrics.freshIntersection=await dom(renderer,`new Promise(resolve=>{
              const target=[...document.querySelectorAll('.dsg-chat')].find(card=>card.dataset.dsgSearchCard===${JSON.stringify(metrics.observedCallId)});
              if(!target){resolve({missing:true});return;}
              let timer;
              const observer=new IntersectionObserver(entries=>{
                clearTimeout(timer);observer.disconnect();
                resolve(entries.map(entry=>({intersecting:entry.isIntersecting,ratio:entry.intersectionRatio,
                  top:entry.boundingClientRect.top,height:entry.boundingClientRect.height})));
              });
              observer.observe(target);
              timer=setTimeout(()=>{observer.disconnect();resolve({timeout:true});},1500);
            })`);
            host.streamVisibility=metrics.freshIntersection;
            const image=await renderer.send('Page.captureScreenshot',{format:'png'});
            writeFileSync(join(run.directory,version+'-chat-stream-failed.png'),Buffer.from(image.data,'base64'),{flag:'wx'});
          }
          check('streaming official chat renders visible search cards',metrics.visibleCardFrames>30);
          if(!clientBaseline){
            check('streaming card performs no synchronous body height reads',metrics.measurements,0);
            check('content size animation does not restart per model token',metrics.heightAnimations<20);
          }
        }
        } catch (error) {
          if(!streamFailure)throw error;
          host.streamDiagnosticFailure=safeError(error);
        }
      }
      check('streamed model turn succeeds without bypassing search',streamed.isError===false&&streamed.originalDelta===0);
      for(const width of [1366,1000]){
        await renderer.send('Emulation.setDeviceMetricsOverride',{width,height:925,deviceScaleFactor:1,mobile:false});
        check('native chat horizontal chain at '+width,await dom(renderer,`[...document.querySelectorAll('.dsg-chat .flow')].every(flow=>{
          const nodes=[...flow.querySelectorAll('.route-node')].map(node=>node.getBoundingClientRect());
          return nodes.every(node=>Math.abs(node.top-nodes[0].top)<1);
        })`));
      }
      await renderer.send('Emulation.clearDeviceMetricsOverride');
    }
    const whileAway = await modelTurn(host, 'search');
    check('search while settings unmounted succeeds', whileAway.isError, false);
    const awayCard=`document.querySelector('[data-dsg-search-card="${whileAway.callId}"]')`;
    await until(renderer,`!!${awayCard}`);
    await dom(renderer,`(()=>{
      for(const button of document.querySelectorAll('button,[role=button]')){
        if(/已完成.*用时/.test(button.textContent||'')&&button.getAttribute('aria-expanded')==='false')button.click();
      }
    })()`);
    await dom(renderer,`(()=>{
      for(const button of document.querySelectorAll('button[data-process-activity][aria-expanded=false]'))button.click();
    })()`);
    await dom(renderer,`${awayCard}.scrollIntoView({block:'center'})`);
    await until(renderer, `${awayCard}?.querySelector('.provider-steps')?.textContent.includes('Tavily')`);
    await dom(renderer, `[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')==='插件').click()`);
    await until(renderer, `!!document.querySelector('button[aria-label="查看 dsh-grok-search"]')`);
    await dom(renderer, `document.querySelector('button[aria-label="查看 dsh-grok-search"]').click()`);
    await until(renderer, `${q('.log-entry')}`);
    check('returning to settings retains multiple earlier searches', await dom(renderer,
      `${q('#logList')}.querySelectorAll('.log-entry').length>=3`));
    const awayRoute = await rpc(renderer, 'grokSearchSettings', 'toolCallRoute', {
      request: { sessionId: whileAway.sessionId, callId: whileAway.callId },
    });
    check('search made while away has its own attribution', awayRoute.known && awayRoute.routes[0]?.served === 'tavily');
    const batchSearch = await modelTurn(host, 'search batch');
    check('one model call can dispatch two distinct queries', batchSearch.isError === false && batchSearch.originalDelta === 0);
    await until(renderer, `${q('.le-query')}?.textContent==='内部候选实时查询'`);
    const grouped = await rpc(renderer, 'grokSearchSettings', 'readSearchLog', { request: { sessionId: randomUUID() } });
    const batchRows = grouped.records.filter(row => row.callId === batchSearch.callId && row.sessionId === batchSearch.sessionId);
    check('native multi-query call creates exactly one parent record', batchRows.length, 1);
    check('parent preserves both child queries', batchRows[0].queries.map(row => row.q),
      ['内部候选实时查询', '内部候选逐小时查询']);
    check('parent finishes after both child searches', batchRows[0].callFinished
      && batchRows[0].queryCount === 2 && batchRows[0].queries.every(row => row.kind === 'sources'));
    check('parent duration is not a sum of child queue durations',
      batchRows[0].ms >= Math.max(...batchRows[0].queries.map(row => row.ms))
      && batchRows[0].ms <= Date.now() - batchRows[0].at);
    await click(renderer, '.log-entry .le-head');
    await until(renderer, `${q('.log-entry.is-open .lquery')}`);
    check('native batch renders two flat rows tied to the same parent', await dom(renderer,
      `${q('#logList')}.querySelectorAll('[data-parent-id="${batchRows[0].id}"]').length`), 2);
    check('each native row detail contains only its own query', await dom(renderer,
      `${q('.log-entry.is-open')}.querySelectorAll('.lquery').length`), 1);
    const batchAttribution = await rpc(renderer, 'grokSearchSettings', 'toolCallRoute', {
      request: { sessionId: batchSearch.sessionId, callId: batchSearch.callId },
    });
    check('chat provenance remains one call with two exact source outcomes',
      batchAttribution.known && batchAttribution.routes.length === 2
      && batchAttribution.routes.every(route => route.served === 'tavily' && route.outcome === 'ok'));
    const groupedImage = await renderer.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(run.directory, version + '-grouped-log.png'), Buffer.from(groupedImage.data, 'base64'), { flag: 'wx' });
    const fetched = await modelTurn(host, 'fetch');
    check('canonical fetch preserved', fetched.isError === false && fetched.fetchDelta === 1);
    const chat = await modelTurn(host, 'chat');
    check('ordinary chat completes without search', chat.completed && chat.originalDelta === 0 && chat.fetchDelta === 0);
    for (const provider of ['tavily', 'firecrawl', 'tinyfish', 'exa']) {
      check('open ' + provider + ' card', await click(renderer, `#colList .row[data-id=${provider}] .row-main`));
      await until(renderer, `${q('#quotaPanel')}?.dataset.provider===${JSON.stringify(provider)}`);
      check(provider + ' quota heading keeps the approved compact layout', await dom(renderer,
        `(() => {const panel=${q('#quotaPanel')},title=panel.querySelector('h3'),link=panel.querySelector('.qp-console');
          const head=panel.querySelector('.qp-head').getBoundingClientRect();
          return getComputedStyle(title).fontSize==='13px' && getComputedStyle(title).fontWeight==='600'
            && getComputedStyle(link).fontSize==='11px' && getComputedStyle(link).fontWeight==='550'
            && Math.abs(link.getBoundingClientRect().left-title.getBoundingClientRect().right-8)<1
            && !panel.querySelector('#quotaDetails,[data-a=quota-details],.qp-key-hint')
            && [...panel.querySelectorAll('.qp-tools button,.qp-tools select')].every(el=>{
              const box=el.getBoundingClientRect();
              return Math.abs(box.y+box.height/2-head.y-head.height/2)<1;
            });})()`));
      if (provider === 'exa') {
        check('Exa has no fabricated balance endpoint', await dom(renderer, `${q('#quotaPanel')}.dataset.state`), 'unsupported');
      } else {
        await until(renderer, `${q('#quotaPanel')}.dataset.state==='ready'`, 30_000);
        check(provider + ' opening automatically queries without revealing the key', true);
        check(provider + ' queried via real authenticated settings service', await dom(renderer,
          `Boolean(${q('#quotaPanel .qp-value')}) && !${q('#quotaPanel')}.innerText.includes('查询失败')`));
        const image = await renderer.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(run.directory, version + '-' + provider + '.png'), Buffer.from(image.data, 'base64'), { flag: 'wx' });
        if (!live && provider === 'tavily') {
          await dom(renderer, `${q('[data-quota-kind=key]')}.focus()`);
          await until(renderer, `${q('#routeTooltip')}.hidden===false`);
          check('native quota key hint matches the real RPC value', await dom(renderer,
            `${q('#routeTooltip')}.textContent`), '当前 Key 最多还可用 88 credits。');
          await renderer.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await renderer.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          check('native Escape closes tooltip and keeps dialog', await dom(renderer,
            `${q('#routeTooltip')}.hidden && !${q('#overlay')}.hidden`));
          mode = 'quota-failed';
          await click(renderer, '[data-a=quota-refresh]');
          await until(renderer, `${q('#quotaPanel')}.dataset.state==='error'`);
          check('real quota RPC failure preserves its marked last result', await dom(renderer,
            `${q('.qp-updated')}.innerText.includes('刷新失败 · 上次结果') && ${q('[data-stat=remaining] .qp-value')}.textContent==='988'`));
          mode = 'ok';
          await click(renderer, '[data-a=quota-refresh]');
          await until(renderer, `${q('#quotaPanel')}.dataset.state==='ready'`);
          check('real quota retry recovers without changing keys', await dom(renderer,
            `${q('[data-stat=remaining] .qp-value')}.textContent`), '988');
        }
      }
      check('existing key not revealed by quota', await dom(renderer,
        `[...${q('#dialog')}.querySelectorAll('input[type=password]')].every(e=>e.value==='')`));
      await click(renderer, '[data-a=cancel]');
      await until(renderer, `${q('#overlay')}.hidden`);
    }
    if (!live) {
      mode = 'fallback';
      const fallback = await probe(host, 'product-query-result');
      check('429 falls through to next source', fallback.sources.length > 0);
      await until(renderer, `${q('.log-entry .lroute')}.innerText.includes('Exa')`);
      mode = 'failed';
      let failed = false;
      try { await probe(host, 'product-query-result'); } catch { failed = true; }
      check('all upstreams failed means explicit error', failed);
      await until(renderer, `${q('.log-entry')}?.dataset.kind==='failed'`);
      check('failure did not call original provider', (await probe(host, 'snapshot')).calls.original, before.calls.original);
      mode = 'ok';
      const pref = await rpc(renderer, 'grokSearchSettings', 'preferences');
      await rpc(renderer, 'grokSearchSettings', 'savePreferences', {
        request: { expectedRevision: pref.revision, value: { ...pref.value, grokEnabled: true } },
      });
      await renderer.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      // MediaQueryList change is asynchronous and cancels retained playback.
      // Let that listener settle before starting the first static replay.
      await until(renderer, `matchMedia('(prefers-reduced-motion: reduce)').matches
        && ${q('#historyBar')}.hidden && ${q('#historyStage')}.hidden`);
      for (const provider of ['tavily', 'exa', 'tinyfish', 'firecrawl']) {
        mode = 'mcp-' + provider;
        const call = await modelTurn(host, 'search');
        check(provider + ' real MCP internal fallback completes', call.isError, false);
        const actual = await rpc(renderer, 'grokSearchSettings', 'toolCallRoute', {
          request: { sessionId: call.sessionId, callId: call.callId },
        });
        check(provider + ' true session call reports concrete supplier', actual.routes[0]?.served, provider);
        check(provider + ' true session carries verified result suppliers', actual.routes[0]?.resultProviders, [provider]);
        const history = await rpc(renderer, 'grokSearchSettings', 'readSearchLog', { request: { sessionId: randomUUID() } });
        const row = history.records.find(row => row.callId === call.callId)?.queries?.[0];
        check(provider + ' MCP labels reach real history', row?.resultProviders, [provider]);
        check(provider + ' supplier attribution is not a fabricated bill', row?.calls.find(item => item.provider === provider)?.charge?.basis, 'unknown');
        await until(renderer, `${q('.log-entry')}?.dataset.parentId === ${JSON.stringify(history.records[0].id)}`);
        check(provider + ' log has official supplier logo', await dom(renderer, `!!${q('.log-entry .lnode[data-node=' + provider + '] img')}`));
        check(provider + ' internal fallback replay starts', await click(renderer, '.log-entry [data-log-replay]'));
        await until(renderer, `${q('#historyStage [data-history-node=' + provider + ']')}?.dataset.hs === 'back'`);
        check(provider + ' desktop replay has no anonymous fallback node', await dom(renderer, `!${q('#historyStage [data-history-node=unknown]')}`));
        if (provider === 'tavily' || provider === 'firecrawl') {
          const shot = await renderer.send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(join(run.directory, version + '-internal-' + provider + '.png'), Buffer.from(shot.data, 'base64'), { flag: 'wx' });
        }
        await click(renderer, '#historyStop');
        check(provider + ' internal fallback did not call original provider', call.originalDelta, 0);
      }
      const restoredPref = await rpc(renderer, 'grokSearchSettings', 'preferences');
      await rpc(renderer, 'grokSearchSettings', 'savePreferences', {
        request: { expectedRevision: restoredPref.revision, value: { ...restoredPref.value, grokEnabled: false } },
      });
      mode = 'ok';
    }
    check('clear log', await click(renderer, '#logClear'));
    await until(renderer, `${q('#logCard')}.querySelectorAll('.log-entry').length===0`);
    const nativeSwitch = `document.querySelector('[role="switch"][aria-label="启用 dsh-grok-search"]')`;
    check('native switch initially enabled', await dom(renderer, `${nativeSwitch}?.getAttribute('aria-checked')`), 'true');
    check('user clicks native plugin switch off', await dom(renderer, `(() => {
      const button=${nativeSwitch};if(!button||button.disabled)return false;button.click();return true;})()`));
    await until(renderer, `${nativeSwitch}?.getAttribute('aria-checked')==='false'`);
    await until(renderer, `!document.querySelector('[data-dsg-route]')`);
    const stopped = await probe(host, 'snapshot');
    check('hot disable restores previous author route', stopped.runtimeWeb.searchProviderId, 'candidate-original');
    const release = stopped.recordEnvelope?.intent?.releaseCompletion;
    check('completion revision committed separately from route change', release?.recordCommit?.kind, 'explicit-release-completion');
    check('route restoration receipt verified', release?.routeVerified, true);
    check('fetch provider preserved', stopped.runtimeWeb.fetchProviderId, before.runtimeWeb.fetchProviderId);
    check('existing dependency preserved', stopped.existingDependencyPresent);
    check('user clicks native plugin switch on', await dom(renderer, `(() => {
      const button=${nativeSwitch};if(!button||button.disabled)return false;button.click();return true;})()`));
    await until(renderer, `${nativeSwitch}?.getAttribute('aria-checked')==='true'`);
    await until(renderer, `${q('#routeCard')} && ${q('#routeCard')}.dataset.s!=='load'`);
    check('reenable takes over without restart', (await probe(host, 'snapshot')).runtimeWeb.searchProviderId, 'grok-search');
    check('new page has no private history', await dom(renderer, `${q('#logCard')}.querySelectorAll('.log-entry').length`), 0);
    const afterEnable = await probe(host, 'product-query-result', { query: 'reenabled isolated search', timeoutMs: live ? 30_000 : 5000 });
    check('reenabled search succeeds', afterEnable.sources.length > 0);
    await until(renderer, `${q('.le-query')}?.textContent==='reenabled isolated search'`);
    const retained = await probe(host, 'snapshot');
    check('reenabled search still bypasses original provider', retained.calls.original, before.calls.original);
    if (!editable) check('configuration not written', existsSync(configPath), false);
    else {
      check('searches and automatic quota reads never rewrite configuration', sha256(configPath), initialConfigHash);
      const state = await rpc(renderer, 'grokSearchSettings', 'snapshot');
      check('all synthetic file keys are editable', Object.entries(CONFIG_FIELDS)
        .filter(([name, spec]) => spec.type === 'secret' && state.config.fields[name]?.configured)
        .every(([name]) => state.config.fields[name].source === 'file' && !state.config.fields[name].readOnly));
      await click(renderer, '#colList .row[data-id=grok] .row-main');
      check('file-backed Grok allows both protocol selectors', await dom(renderer,
        `${q('#dialog')}.querySelectorAll('[data-a=mode]:disabled').length`), 0);
      check('Grok familiar protocol names', await dom(renderer,
        `[...${q('#dialog')}.querySelectorAll('[data-a=mode]')].map(e=>e.textContent)`), ['xAI Responses', 'OpenAI 兼容网关']);
      check('select Chat Completions without clearing the draft on click', await click(renderer, '[data-a=mode][data-v=compat]'));
      await until(renderer, `!!${q('input[data-k=gwKey]')}`);
      await click(renderer, '[data-a=cancel]');
      await until(renderer, `${q('#overlay')}.hidden`);
      check('cancelled protocol draft leaves shared bytes unchanged', sha256(configPath), initialConfigHash);
      await click(renderer, '#colList .row[data-id=exa] .row-main');
      await until(renderer, `!!${q('input[data-k=key]')}`);
      await dom(renderer, `${q('input[data-k=key]')}.focus()`);
      await until(renderer, `!${q('input[data-k=key]')}.readOnly`);
      const changedKey = 'dsh-synthetic-persisted-' + randomUUID();
      secrets.add(changedKey);
      await dom(renderer, `(() => { const input=${q('input[data-k=key]')};
        input.value=${JSON.stringify(changedKey)};input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      check('replacement key can be saved through the real UI', await click(renderer, '[data-a=save]'));
      await until(renderer, `${q('#overlay')}.hidden`);
      const savedStore = createSharedConfigStore({ path: configPath, env: () => ({}) });
      check('replacement reaches the same shared file', savedStore.reveal('exa_api_key').value === changedKey);
      const savedHash = sha256(configPath);
      await stop(host);
      check('editable test first lifetime exits normally', exits.at(-1).code === 0 && !exits.at(-1).forced);
      const restartAddress = join(folder, 'probe-address-restart.json');
      const restartChild = spawn(control.electron,
        [...(process.platform === 'win32' ? [runtime.archivePath] : []), '--user-data-dir=' + control.userData,
          '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--lang=zh-CN'],
        { cwd: folder, env: { ...env, DSH_DESKTOP_FIXTURE_ADDRESS_FILE: restartAddress },
          windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      restartChild.stdout.resume(); restartChild.stderr.resume();
      const restarted = owned = { runtime, child: restartChild, control, port, addressPath: restartAddress, ended: false, checks };
      restarted.closed = new Promise(done => restartChild.once('close', code => { restarted.ended = true; restarted.exitCode = code; done(); }));
      const nextRenderer = restarted.renderer = await connectRenderer(port, { timeoutMs: 90_000, requestTimeoutMs: 30_000 });
      await until(nextRenderer, `document.readyState==='complete' && [...document.querySelectorAll('button')]
        .some(e=>(e.getAttribute('aria-label')||e.innerText||'').trim()==='插件')`, 60_000);
      await dom(nextRenderer, `(() => { [...document.querySelectorAll('button')]
        .find(e=>(e.getAttribute('aria-label')||e.innerText||'').trim()==='插件').click(); })()`);
      await until(nextRenderer, `!!document.querySelector('button[aria-label="查看 dsh-grok-search"]')`);
      await dom(nextRenderer, `document.querySelector('button[aria-label="查看 dsh-grok-search"]').click()`);
      await until(nextRenderer, `${q('#routeCard')} && ${q('#routeCard')}.dataset.s!=='load'`, 60_000);
      check('full Desktop restart does not rewrite the saved config', sha256(configPath), savedHash);
      const reopened = await rpc(nextRenderer, 'grokSearchSettings', 'snapshot');
      check('restart reads the same config path and saved revision',
        reopened.config.path === configPath && reopened.config.revision === savedStore.snapshot().revision);
      await click(nextRenderer, '#colList .row[data-id=exa] .row-main');
      await until(nextRenderer, `!!${q('input[data-k=key]')}`);
      await dom(nextRenderer, `${q('input[data-k=key]')}.focus()`);
      await until(nextRenderer, `!${q('input[data-k=key]')}.readOnly`);
      check('reopened form retains the replacement and permits editing', await dom(nextRenderer,
        `${q('input[data-k=key]')}.value===${JSON.stringify(changedKey)} && !${q('input[data-k=key]')}.readOnly`));
      await click(nextRenderer, '[data-a=cancel]');
      await until(nextRenderer, `${q('#overlay')}.hidden`);
      const afterRestart = await modelTurn(restarted, 'search');
      check('search after restart remains functional without original fallback', !afterRestart.isError && afterRestart.originalDelta === 0);
      check('restarted renderer has no exception', nextRenderer.exceptions.length, 0);
    }
    if (githubRead) {
      const activeHost = owned, activeRenderer = activeHost.renderer;
      const initial = await rpc(activeRenderer, 'grokSearchSettings', 'preferences');
      check('GitHub read is off after upgrading old preferences', initial.value.githubReadEnabled, false);
      const saved = await rpc(activeRenderer, 'grokSearchSettings', 'savePreferences', { request: {
        expectedRevision: initial.revision, value: { ...initial.value, githubReadEnabled: true },
      } });
      const url = 'https://github.com/dsh-fixture/discussion/issues/7';
      const first = await modelTurn(activeHost, 'github ' + JSON.stringify({ url }));
      check('actual Session discovers and invokes GitHub tool', !first.isError && first.githubDelta >= 3 && first.fetchDelta === 0);
      const cursor = /cursor="([^"]+)"/.exec(first.text)?.[1];
      check('actual Session receives a continuation cursor', !!cursor);
      const second = await modelTurn(activeHost, 'github ' + JSON.stringify({ url, cursor }));
      check('same real Agent can continue across turns', !second.isError && second.githubDelta === 1 && /分段 2/.test(second.text));
      const log = await rpc(activeRenderer, 'grokSearchSettings', 'readSearchLog', { request: { sessionId: randomUUID() } });
      const rows = log.records.filter(row => row.recordType === 'github');
      check('two tool calls produce exactly two GitHub records', rows.length, 2);
      check('continuation record identifies its cached segment', rows[0].segment === 2 && rows[0].cacheHit);
      check('GitHub logs contain no original discussion text', !JSON.stringify(rows).includes('fixture-answer-'));
      const fetched = await modelTurn(activeHost, 'github-fetch ' + JSON.stringify({ url }));
      check('actual Session official fetch is diverted without original fetch', !fetched.isError && fetched.githubDelta >= 3 && fetched.fetchDelta === 0);
      await rpc(activeRenderer, 'grokSearchSettings', 'savePreferences', { request: {
        expectedRevision: saved.revision, value: { ...saved.value, githubReadEnabled: false },
      } });
      const disabled = await modelTurn(activeHost, 'github ' + JSON.stringify({ url, cursor }));
      check('disabled GitHub tool cannot continue', disabled.isError && disabled.githubDelta === 0);
      const restored = await modelTurn(activeHost, 'github-fetch ' + JSON.stringify({ url }));
      check('disabled GitHub restores author fetch', !restored.isError && restored.githubDelta === 0 && restored.fetchDelta === 1);
    }
    check('no renderer exception', renderer.exceptions.length, 0);
    results.push({ version, passed: true, checks, live, editableConfig: editable, officialCounterScope: 'isolated-provider-fixture-not-production',
      desktopRenderer: true, packagedStartup: process.platform === 'darwin', dependenciesInstalled: false });
    await stop(owned); owned = null;
    check('owned desktop exited normally', exits.at(-1).code, 0);
    check('owned desktop not force-killed', exits.at(-1).forced, false);
    writeJson(join(run.directory, version + '-checks.json'), results.at(-1));
    console.log(JSON.stringify({ version, phase: 'passed', checks: checks.length }));
  }
} catch (error) {
  fatal = safeError(error);
  if (owned?.renderer) {
    try {
      const state = await dom(owned.renderer, `({body:document.body.innerText.slice(0,1500),
        mounted:Boolean(document.querySelector('[data-dsg-route]')),state:${q('#routeCard')}?.dataset.s,
        quota:${q('#quotaPanel')}?.dataset.state,
        motionReduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
        visibility:document.visibilityState,
        historyPhase:${q('#historyPhase')}?.textContent,
        historyBarPhase:${q('#historyBar')}?.dataset.phase,
        logAnnouncer:${q('#logAnnouncer')}?.textContent,
        lastCheck: ${JSON.stringify(owned.checks?.at(-1)?.name ?? null)},
        historyStageHidden:${q('#historyStage')}?.hidden,
        historyPackets:${q('#historyStage')}?.querySelectorAll('.packet').length,
        sidebarRows:[...document.querySelectorAll('[data-row-key]')].map(e=>({key:e.dataset.rowKey,expanded:e.getAttribute('aria-expanded')})),
        attributionRows:[...document.querySelectorAll('.dsg-tool-attribution')].map(e=>e.textContent),
        chatCardMarkup:document.querySelector('[data-dsg-search-card]')?.outerHTML.slice(0,5000),
        chatAncestors:(()=>{const rows=[];let e=document.querySelector('[data-dsg-search-card]');
          while(e&&rows.length<8){const r=e.getBoundingClientRect();rows.push({tag:e.tagName,class:e.className,
            height:r.height,display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility});e=e.parentElement;}return rows;})(),
        buttons:[...document.querySelectorAll('button,[role=button]')].filter(e=>e.hasAttribute('aria-expanded'))
          .map(e=>({text:e.textContent.slice(0,100),expanded:e.getAttribute('aria-expanded'),html:e.outerHTML.slice(0,500)})),
        nativeSwitches:[...document.querySelectorAll('[role=switch]')].map(e=>({aria:e.getAttribute('aria-label'),checked:e.getAttribute('aria-checked')}))})`);
      writeJson(join(run.directory, 'failed-state.json'), { ...state, checks: owned.checks, exceptions:owned.renderer.exceptions,
        streamDiagnosticFailure:owned.streamDiagnosticFailure??null,streamVisibility:owned.streamVisibility??null });
    } catch { /* Original failure remains authoritative. */ }
  }
} finally {
  await stop(owned);
  upstream.closeAllConnections();
  await new Promise(done => upstream.close(done));
  const associationUnchanged = associationBefore === await association();
  const binariesAfter = runtimes.map(runtime => ({ version: runtime.app.version, exe: sha256(runtime.executable), asar: sha256(runtime.archivePath) }));
  const originalFilesUnchanged = JSON.stringify(binariesBefore) === JSON.stringify(binariesAfter);
  const sourceUnchanged = sourceHashes.every(row => sha256(join(project, row.file)) === row.sha256);
  const sharedConfigUnchanged = live ? sha256(sharedPath) === sharedHash : null;
  const summary = { runId: run.runId, passed: !fatal && sourceUnchanged && associationUnchanged
    && originalFilesUnchanged && sharedConfigUnchanged !== false && exits.every(exit => exit.code === 0 && !exit.forced),
    fatal, results, exits, live, requests, tarballSha256: packageReceipt.sha256, sourceHashes,
    sourceUnchanged, associationUnchanged, originalFilesUnchanged, sharedConfigUnchanged,
    scope: process.platform === 'win32' ? 'official-Desktop-default-app-original-ASAR-renderer-with-isolated-profile'
      : 'official-packaged-Desktop-renderer-with-isolated-profile',
    packagedStartupVerified: process.platform === 'darwin' && !fatal,
    primaryGrokVerified: false, published: false,
    keyFilesWritten: editable, syntheticKeysOnly: editable, realKeyFilesWritten: false, rawUpstreamResponsesSaved: false };
  // A deliberately invalid one-character credential can equal version digits,
  // counts and timestamps. Match such test values as exact JSON strings; scan
  // real-length secrets as substrings as before.
  const summaryText = JSON.stringify(summary);
  for (const secret of secrets) assert.equal(secret.length >= 5 ? summaryText.includes(secret)
    : summaryText.includes(JSON.stringify(secret)), false);
  writeJson(join(run.directory, 'summary.json'), summary);
  console.log(JSON.stringify({ runId: run.runId, passed: summary.passed, fatal, versions: results.map(row => row.version) }));
  process.exitCode = summary.passed ? 0 : 1;
}
