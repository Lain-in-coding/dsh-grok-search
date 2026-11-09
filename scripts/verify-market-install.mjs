import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prepareDesktopFixture } from './deferred-release-desktop-prepare.mjs';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { connectRenderer, requestDesktopShutdown, waitForRenderer } from './lib/renderer-cdp.mjs';
import { cleanEnvironment, freshRun, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

// New, credential-free profiles only. This uses the released market's real
// install adapter and official Desktop manager, not the market's visual shell
// or routes.js pre-install version pinning. A bare-target adapter refusal does
// not prove the full marketplace install route fails; use the UI fixture too.
const [desktop, marketDirectory, onlyMode] = process.argv.slice(2);
if (!desktop || !marketDirectory) throw new Error('Provide Desktop and the unpacked dshmarket package.');
const runtime = candidateRuntime(desktop);
const market = JSON.parse(readFileSync(join(marketDirectory, 'package.json'), 'utf8'));
assert.equal(market.name, 'dshmarket');
assert.equal(market.version, '1.73.12');
const run = freshRun('market-install-021');
const root = join(tmpdir(), 'dsh-deferred-desktop-market-' + run.runId);
const before = [sha256(runtime.executable), sha256(runtime.archivePath)];
const results = [], modes = ['bare-name', 'market-adapter', 'exact-version'];
if (onlyMode !== undefined && !modes.includes(onlyMode)) throw new Error('Unknown verification mode.');
for (const mode of onlyMode ? [onlyMode] : modes) {
  const folder = join(root, mode);
  prepareDesktopFixture(runtime.executable, folder, { pluginManagerEntries: true, liveHmr: true });
  const control = JSON.parse(readFileSync(join(folder, 'local-control.json'), 'utf8'));
  writeFileSync(join(control.profile, 'package.json'), JSON.stringify({ name: 'isolated-market-probe', version: '0.0.0',
    private: true, type: 'module', dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  writeFileSync(join(control.profile, 'cordis.patch.yml'),
    '- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  config:\n    enabled: false\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-deepseek\n  config:\n    apiKeyEnv: DSH_PROBE_UNUSED_KEY\n');
  const configPath = join(folder, 'user/.config/grok-search-rs/config.toml');
  mkdirSync(join(configPath, '..'), { recursive: true });
  writeFileSync(configPath, '# Isolated install verification; no credentials.\n');
  const reservation = createServer();
  await new Promise(done => reservation.listen(0, '127.0.0.1', done));
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const env = cleanEnvironment(folder, { DSH_HOME: control.dshHome, DSH_DESKTOP_DSH_DIR: control.runtime,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: control.primaryRuntime, DSH_DESKTOP_PNPM_ENTRY: control.pnpmEntry,
    GROK_SEARCH_CONFIG: configPath, DSH_PROBE_UNUSED_KEY: 'unused-offline', DSH_TELEMETRY_DISABLED: '1',
    npm_config_registry: 'https://registry.npmjs.org/', NODE_OPTIONS: '--network-family-autoselection-attempt-timeout=2000' });
  const child = spawn(control.electron, [runtime.archivePath, '--user-data-dir=' + control.userData,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--lang=zh-CN'],
  { cwd: folder, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  let ended = false, renderer;
  const closed = new Promise(done => child.once('close', code => { ended = true; done(code); }));
  const requestId = randomUUID();
  console.log(JSON.stringify({ mode, phase: 'starting', profile: 'new-isolated' }));
  try {
    renderer = await connectRenderer(port, { timeoutMs: 60_000, requestTimeoutMs: 180_000 });
    await waitForRenderer(renderer, r => r.evaluate("document.readyState==='complete' && !!document.querySelector('button[aria-label=\"插件\"]')"), { timeoutMs: 60_000 });
    const rpc = (method, args) => renderer.evaluate(`(async () => {
      const method=${JSON.stringify('pluginManager/' )}+${JSON.stringify(method)};
      const response=await fetch('/api/'+method,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
        signal:AbortSignal.timeout(150000),body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:${JSON.stringify(args)}}})});
      const result=(await response.json()).result;
      if(!result?.ok) throw new Error(result?.error?.code || 'RPC failed');
      return result.value;
    })()`);
    const spec = mode === 'exact-version' ? 'dsh-grok-search@0.2.0' : 'dsh-grok-search';
    let outcome, managerError;
    if (mode === 'market-adapter') {
      // The market's own logger and journal also stay in this disposable profile.
      const previous = { ...process.env };
      try {
        Object.assign(process.env, env);
        const { createOfficialDesktopRuntime } = await import(pathToFileURL(resolve(marketDirectory, 'lib/official-desktop.js')));
        const { installTargetFor } = await import(pathToFileURL(resolve(marketDirectory, 'lib/sources.js')));
        const target = installTargetFor({ url: 'https://github.com/Lain-in-coding/dsh-grok-search', npm: 'dsh-grok-search' });
        assert.equal(target, spec);
        const manager = {
          installBundle: async (value, options) => {
            const result = await rpc('installBundle', { spec: value, options: { ...options, requestId, registry: 'https://registry.npmjs.org/' } });
            managerError = result.error;
            return result;
          },
          removeBundle: name => rpc('removeBundle', { name }),
          cancelInstall: id => rpc('cancelInstall', { requestId: id }),
        };
        const bridge = createOfficialDesktopRuntime(() => manager, 'desktop', control.profile);
        try { outcome = await bridge.runPlugin('desktop', ['add', target]); }
        finally { await bridge.dispose(); }
      } finally {
        for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
        Object.assign(process.env, previous);
      }
    } else outcome = await rpc('installBundle', { spec, options: { requestId, registry: 'https://registry.npmjs.org/' } });
    const path = join(control.profile, 'node_modules/dsh-grok-search/package.json');
    const installed = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    const result = { mode, spec, installedVersion: installed?.version ?? null,
      application: outcome?.application ?? null, exitCode: outcome?.exitCode ?? outcome?.code ?? outcome?.packageResult?.exitCode ?? null,
      errorCode: outcome?.error?.code ?? outcome?.refusalCode ?? null,
      incompatible: (outcome?.error ?? managerError)?.incompatible ?? [],
      expectedVersionInstalled: installed?.version === '0.2.0' };
    results.push(result);
    console.log(JSON.stringify(result));
    await rpc('cancelInstall', { requestId }).catch(() => {});
  } catch (error) {
    results.push({ mode, expectedVersionInstalled: false, error: String(error.message).replaceAll(folder, '<ISOLATED>').slice(0, 500) });
  } finally {
    renderer?.close();
    if (!ended) {
      try { await requestDesktopShutdown(port, closed, { timeoutMs: 20_000 }); }
      catch { if (!ended) child.kill(); }
    }
    await closed;
  }
}
assert.deepEqual([sha256(runtime.executable), sha256(runtime.archivePath)], before);
writeJson(join(run.directory, 'summary.json'), { runId: run.runId, results,
  scope: 'published-0.2.0-official-Desktop-manager-and-released-market-1.73.12-adapter',
  marketVisualShellVerified: false, marketRouteVersionPinningVerified: false,
  freshReleasePolicyModified: false, sharedConfigRead: false, paidSearchRequests: 0, published: false });
console.log(JSON.stringify({ runId: run.runId, directory: run.directory, results }));
