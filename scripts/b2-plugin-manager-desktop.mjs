import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { connectRenderer, requestDesktopShutdown, waitForRenderer } from './lib/renderer-cdp.mjs';
import {
  cleanEnvironment, commandResult, configSecrets, freshRun, project, receipt, redact, sha256, writeJson,
} from './lib/internal-candidate-utils.mjs';
import { createSharedConfigStore } from '../src/core/shared-config.mjs';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';
import { createPrivateProgramInstaller } from '../src/core/program-install.mjs';
import { probeMcpHandshake } from '../src/core/mcp-search.mjs';

const PRODUCT_BUNDLE = 'dsh-grok-search';
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--desktop-rc2', '--desktop-rc21', '--product-package', '--first-use', '--diagnostics',
    '--source-only-config', '--manual-acceptance', '--upgrade-from', '--upgrade-cache',
    '--upgrade-in-place-only', '--upgrade-old-source'].includes(process.argv[index])
    || !process.argv[index + 1]) throw new Error('Expected named Desktop and package arguments.');
  options.set(process.argv[index], process.argv[index + 1]);
}
const runtimes = [candidateRuntime(options.get('--desktop-rc2')), candidateRuntime(options.get('--desktop-rc21'))]
  .filter(runtime => !process.env.DSH_B2_ONLY_VERSION || runtime.app.version === process.env.DSH_B2_ONLY_VERSION);
const targetVersions = (process.env.DSH_B2_TARGET_VERSIONS ?? '0.2.1-rc.2,0.2.1-rc.3').split(',').map(value => value.trim()).filter(Boolean);
assert.deepEqual(runtimes.map(runtime => runtime.app.version),
  process.env.DSH_B2_ONLY_VERSION ? [process.env.DSH_B2_ONLY_VERSION] : targetVersions);
const productTarball = resolve(options.get('--product-package'));
if (!existsSync(productTarball)) throw new Error('Package tarball is missing: ' + productTarball);
const firstUse = options.get('--first-use') === 'download';
if (options.has('--first-use') && !firstUse) throw new Error('Expected --first-use download.');
const diagnostics = options.get('--diagnostics') === 'loopback';
if (options.has('--diagnostics') && (!diagnostics || !firstUse)) {
  throw new Error('--diagnostics loopback requires --first-use download.');
}
const sourceOnlyConfig = options.has('--source-only-config') ? resolve(options.get('--source-only-config')) : null;
const manualAcceptance = options.get('--manual-acceptance') === 'true';
const upgradeFrom = options.has('--upgrade-from') ? resolve(options.get('--upgrade-from')) : null;
const upgradeCache = options.has('--upgrade-cache') ? resolve(options.get('--upgrade-cache')) : null;
const upgradeInPlaceOnly = options.get('--upgrade-in-place-only') === 'true';
const upgradeOldRegistry = options.get('--upgrade-old-source') === 'registry';
if (options.has('--upgrade-old-source') && (!upgradeOldRegistry || !upgradeFrom)) {
  throw new Error('--upgrade-old-source registry requires upgrade verification.');
}
if (options.has('--upgrade-in-place-only') && (!upgradeInPlaceOnly || !upgradeFrom)) {
  throw new Error('--upgrade-in-place-only true requires upgrade verification.');
}
if (Boolean(upgradeFrom) !== Boolean(upgradeCache)
  || upgradeFrom && (firstUse || sourceOnlyConfig || manualAcceptance || diagnostics)) {
  throw new Error('Upgrade verification requires --upgrade-from and --upgrade-cache, without live or first-use modes.');
}
if (options.has('--manual-acceptance') && !manualAcceptance) throw new Error('Expected --manual-acceptance true.');
if (sourceOnlyConfig && (firstUse || diagnostics)) throw new Error('Source-only acceptance cannot use synthetic first-use/diagnosis mode.');
if (manualAcceptance && (!sourceOnlyConfig || runtimes.length !== 1)) {
  throw new Error('Manual acceptance requires a source-only config and one explicit DSH_B2_ONLY_VERSION.');
}
if (sourceOnlyConfig) {
  const fields = createSharedConfigStore({ path: sourceOnlyConfig, env: () => ({}) }).readEffective();
  if (fields.grok_api_key.value || fields.openai_compatible_api_key.value || fields.grok_auth_mode.value !== 'api_key') {
    throw new Error('Source-only acceptance must not contain Grok credentials or OAuth.');
  }
}
const sourceConfigBefore = sourceOnlyConfig ? sha256(sourceOnlyConfig) : null;

const { runId, directory } = freshRun(upgradeFrom ? 'plugin-manager-upgrade' : manualAcceptance ? 'manual-plugin-acceptance'
  : sourceOnlyConfig ? 'source-only-desktop' : diagnostics ? 'diagnostics-desktop'
  : firstUse ? 'first-use-desktop' : 'b2-plugin-manager-desktop');
const temporary = join(tmpdir(), 'dsh-deferred-desktop-manager-' + runId);
const replacements = [[temporary, '<TEMPORARY_RUN>'], [dirname(productTarball), '<PRODUCT_PACKAGE>'],
  [dirname(process.execPath), '<NODE_INSTALL>'],
  ...runtimes.map(runtime => [dirname(runtime.executable), `<DESKTOP_${runtime.app.version}>`])];
const secrets = new Set();
if (sourceOnlyConfig) {
  replacements.push([sourceOnlyConfig, '<ISOLATED_SOURCE_CONFIG>']);
  for (const secret of configSecrets(sourceOnlyConfig)) secrets.add(secret);
}
const sanitize = value => redact(String(value), replacements, [...secrets]);
const safe = value => JSON.parse(sanitize(JSON.stringify(value)));
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const runtimeFiles = folder => readdirSync(join(project, folder), { withFileTypes: true }).flatMap(row =>
  row.isDirectory() ? runtimeFiles(folder + '/' + row.name) : [folder + '/' + row.name]);
const sourceHashesBefore = [...new Set([...runtimeFiles('src'), 'package.json', 'cordis.patch.yml',
  'fixtures/deferred-release/desktop-fixture.mjs', 'fixtures/internal-candidate/host-fixture.mjs',
  'scripts/deferred-release-desktop-prepare.mjs', 'scripts/lib/renderer-cdp.mjs',
  'scripts/lib/internal-candidate-utils.mjs', 'scripts/b2-plugin-manager-desktop.mjs'])]
  .map(file => ({ file, sha256: sha256(join(project, file)) }));
const expectedProductReceipt = packageReceipt(productTarball);
const oldProductReceipt = upgradeFrom ? packageReceipt(upgradeFrom) : null;
if (oldProductReceipt) {
  assert.equal(oldProductReceipt.version, '0.1.1', 'Upgrade baseline must be the released 0.1.1 package.');
  assert.notEqual(oldProductReceipt.sha256, expectedProductReceipt.sha256);
  replacements.push([dirname(upgradeFrom), '<OLD_PACKAGE>'], [upgradeCache, '<RETAINED_TEST_CACHE>']);
}
for (const row of expectedProductReceipt.sourceHashes) {
  assert.equal(sha256(join(project, row.file)), row.sha256, 'Frozen package source differs: ' + row.file);
}
const results = [], children = [];
let serial = 0, currentVersion = null;
function protocolAssociation() {
  if (process.platform !== 'win32') return null;
  const ps = process.env.SystemRoot + '/System32/WindowsPowerShell/v1.0/powershell.exe';
  const script = "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\dsh\\shell\\open\\command');if($null -eq $k){Write-Output '<absent>'}else{Write-Output ([string]$k.GetValue(''));$k.Close()}";
  return commandResult(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10000, sanitize: value => String(value) });
}

function packageReceipt(tarball) {
  const file = join(dirname(tarball), 'package-receipt.json');
  if (!existsSync(file)) throw new Error('Package receipt is missing: ' + file);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.sha256 !== sha256(tarball)) throw new Error('Package tarball hash does not match its receipt.');
  return value;
}

async function rendererSnapshot(host) {
  const renderer = await connectRenderer(host.debuggerPort);
  try {
    await waitForRenderer(renderer, async current => {
      const ready = await current.evaluate(`document.readyState === 'complete'
        && document.body?.innerText?.trim().length > 0
        && !/Loading plugins|正在加载插件/i.test(document.body.innerText)`);
      return ready ? true : null;
    });
    return await renderer.evaluate(`(() => ({
      title: document.title,
      href: location.href,
      text: document.body.innerText,
      elements: [...document.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="tab"]')]
        .map(element => ({
          tag: element.tagName,
          text: (element.innerText || element.value || element.getAttribute('aria-label') || element.title || '').trim(),
          aria: element.getAttribute('aria-label'),
          role: element.getAttribute('role'),
          type: element.getAttribute('type'),
          name: element.getAttribute('name'),
          href: element.getAttribute('href'),
        }))
        .filter(item => item.text || item.aria || item.name || item.href)
        .slice(0, 400),
    }))()`);
  } finally {
    renderer.close();
  }
}

// Only synthetic credentials in the fresh isolated profile. Never returns the
// key, response body, cookie or auth URL to evidence output.
async function settingsRpcSecurityFlow(host) {
  const renderer = await connectRenderer(host.debuggerPort);
  try {
    const evidence = await renderer.evaluate(`(async () => {
      const call = async (method, request, extraHeaders = {}, credentials = 'same-origin') => {
        const response = await fetch('/api/grokSearchSettings/' + method, {
          method: 'POST', credentials,
          headers: { 'Content-Type': 'application/json', ...extraHeaders },
          body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(),
            method: 'grokSearchSettings/' + method,
            payload: { args: request === undefined ? {} : { request } } }),
        });
        let body; try { body = await response.json(); } catch { body = {}; }
        return { status: response.status, result: body.result };
      };
      const initial = await call('snapshot');
      if (!initial.result?.ok) return { snapshotOk: false, status: initial.status,
        code: initial.result?.error?.code ?? null };
      const before = initial.result.value;
      if (before.config.fields.grok_api_key.configured) throw new Error('Isolated credential was unexpectedly configured.');
      const sentinel = 'dsh-offline-settings-sentinel';
      const saved = await call('save', { expectedRevision: before.config.revision,
        updates: { grok_api_key: sentinel } });
      if (!saved.result?.ok) return { snapshotOk: true, capabilities: before.capabilities,
        saveOk: false, code: saved.result?.error?.code ?? null };
      try {
        const redacted = await call('snapshot');
        const reveal = await call('reveal', { key: 'grok_api_key' });
        const forwarded = await call('reveal', { key: 'grok_api_key' }, { 'X-Forwarded-Proto': 'https' });
        const restrictedSnapshot = await call('snapshot', undefined, { 'X-Forwarded-Proto': 'https' });
        const deniedSave = await call('save', { expectedRevision: saved.result.value.config.revision,
          updates: { grok_api_key: 'must-not-be-written' } }, { 'X-Forwarded-Proto': 'https' });
        const deniedDestination = await call('save', { expectedRevision: saved.result.value.config.revision,
          updates: { grok_api_url: 'https://example.invalid/must-not-receive-credentials' } },
          { 'X-Forwarded-Proto': 'https' });
        const afterDestination = await call('snapshot');
        const unauthenticated = await call('reveal', { key: 'grok_api_key' }, {}, 'omit');
        return { snapshotOk: true, saveOk: true, capabilities: before.capabilities,
          redacted: redacted.result?.ok === true && !JSON.stringify(redacted.result.value).includes(sentinel),
          revealMatches: reveal.result?.ok === true && reveal.result.value.value === sentinel,
          forwardedDenied: forwarded.result?.ok !== true && !JSON.stringify(forwarded).includes(sentinel),
          forwardedCode: forwarded.result?.error?.code ?? null,
          restrictedSnapshotOk: restrictedSnapshot.result?.ok === true
            && restrictedSnapshot.result.value.capabilities.secretsAllowed === false,
          deniedSave: deniedSave.result?.ok !== true,
          deniedSaveCode: deniedSave.result?.error?.code ?? null,
          deniedDestination: deniedDestination.result?.ok !== true
            && afterDestination.result?.value?.config?.revision === saved.result.value.config.revision,
          deniedDestinationCode: deniedDestination.result?.error?.code ?? null,
          rendererCookieOmissionDenied: unauthenticated.result?.ok !== true
            && !JSON.stringify(unauthenticated).includes(sentinel),
        };
      } finally {
        const current = await call('snapshot');
        if (!current.result?.ok) throw new Error('Cannot read temporary config for cleanup.');
        const restored = await call('save', { expectedRevision: current.result.value.config.revision,
          updates: { grok_api_key: null } });
        if (!restored.result?.ok || restored.result.value.config.fields.grok_api_key.configured)
          throw new Error('Temporary credential cleanup failed.');
      }
    })()`);
    // Electron may supply trusted authentication independently of fetch's
    // cookie option. Test a genuinely unauthenticated client outside Electron.
    const unauthenticated = await fetch(host.readAddress().hostOrigin + '/api/grokSearchSettings/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(),
        method: 'grokSearchSettings/reveal', payload: { args: { request: { key: 'grok_api_key' } } } }),
      signal: AbortSignal.timeout(10000),
    });
    evidence.unauthenticatedStatus = unauthenticated.status;
    evidence.unauthenticatedDenied = [401, 403].includes(unauthenticated.status);
    await unauthenticated.body?.cancel();
    writeJson(join(directory, currentVersion + '-settings-rpc-security.json'), safe(evidence));
    for (const key of ['snapshotOk', 'saveOk', 'redacted', 'revealMatches', 'forwardedDenied',
      'restrictedSnapshotOk', 'deniedSave', 'deniedDestination', 'unauthenticatedDenied']) {
      assert.equal(evidence[key], true, `Settings RPC security check ${key}: ${JSON.stringify(evidence)}`);
    }
    assert.equal(evidence.capabilities.transport, 'loopback');
    assert.equal(evidence.forwardedCode, 'SETTINGS_SECURE_CONNECTION_REQUIRED');
    assert.equal(evidence.deniedSaveCode, 'SETTINGS_SECURE_CONNECTION_REQUIRED');
    assert.equal(evidence.deniedDestinationCode, 'SETTINGS_SECURE_CONNECTION_REQUIRED');
    return evidence;
  } finally { renderer.close(); }
}

async function pluginManagerRendererSnapshot(host) {
  const renderer = await connectRenderer(host.debuggerPort);
  try {
    await renderer.send('Page.bringToFront');
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Sidebar navigation can preserve the current package detail. Return via
    // the host's own breadcrumb before expecting the installed-list heading.
    await renderer.evaluate(`(() => {
      const back = [...document.querySelectorAll('button')]
        .find(item => /^(返回插件|Back to plugins)$/.test(item.getAttribute('aria-label') || '')
          && item.getClientRects().length > 0);
      back?.click(); return Boolean(back);
    })()`);
    await waitForRenderer(renderer, current => current.evaluate(`[...document.querySelectorAll('button,[role="button"]')]
      .some(item => (item.getAttribute('aria-label') || item.innerText || '').trim() === '插件')`));
    const opened = await renderer.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find(item => (item.getAttribute('aria-label') || item.innerText || '').trim() === '插件');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(opened, true, 'Plugin Manager navigation button was not found.');
    await waitForRenderer(renderer, async current => {
      const ready = await current.evaluate(`(() => {
        const text = document.body?.innerText ?? '';
        return !/Loading plugins|正在加载插件/i.test(text)
          && /插件管理|Plugin Manager|已安装|Installed/i.test(text);
      })()`);
      return ready ? true : null;
    });
    const list = await renderer.evaluate(`(() => ({
      title: document.title,
      href: location.href,
      text: document.body.innerText,
      buttons: [...document.querySelectorAll('button,[role="button"]')]
        .map(element => ({
          text: (element.innerText || element.getAttribute('aria-label') || element.title || '').trim(),
          aria: element.getAttribute('aria-label'),
          checked: element.getAttribute('aria-checked'),
          disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
          visible: element.getClientRects().length > 0,
        }))
        .filter(item => item.text || item.aria)
        .slice(0, 500),
      inputs: [...document.querySelectorAll('input,textarea,select')]
        .map(element => ({ tag: element.tagName, type: element.getAttribute('type'),
          placeholder: element.getAttribute('placeholder'), value: element.value }))
        .slice(0, 100),
    }))()`);
    const detailOpened = await renderer.evaluate(`(() => {
      const button = [...document.querySelectorAll('button,[role="button"]')]
        .find(item => item.getAttribute('aria-label') === '查看 dsh-grok-search' && item.getClientRects().length > 0);
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(detailOpened, true, 'Installed dsh-grok-search detail action was not visible.');
    await waitForRenderer(renderer, current => current.evaluate(
      `Boolean(document.querySelector('[data-plugin-detail="dsh-grok-search"]'))`));
    const detail = await renderer.evaluate(`(() => {
      const root = document.querySelector('[data-plugin-detail="dsh-grok-search"]');
      return {
        text: root.innerText,
        buttons: [...root.querySelectorAll('button,[role="button"],[role="switch"]')]
          .map(element => ({
            text: (element.innerText || element.getAttribute('aria-label') || element.title || '').trim(),
            aria: element.getAttribute('aria-label'),
            role: element.getAttribute('role'),
            checked: element.getAttribute('aria-checked'),
            disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
            visible: element.getClientRects().length > 0,
          }))
          .filter(item => item.text || item.aria),
      };
    })()`);
    return { list, detail };
  } finally {
    renderer.close();
  }
}

async function settingsStopRendererFlow(host, phase) {
  const renderer = await connectRenderer(host.debuggerPort);
  try {
    let v74Detail;
    try {
      v74Detail = await waitForRenderer(renderer, current => current.evaluate(`(() => {
      const mount = document.querySelector('[data-dsg-route]');
      const root = mount?.shadowRoot?.querySelector('.dsg-root');
      if (!root?.querySelector('#routeCard') || root.querySelector('#routeCard').dataset.s === 'load') return null;
      return {
        detail: true,
        text: root.innerText,
        route: Boolean(root.querySelector('#routeCard')),
        providers: root.querySelectorAll('.row[data-id]').length,
        testButton: root.querySelector('#testBtn')?.textContent.includes('测试搜索') === true,
        configPath: root.querySelector('#cfgPath')?.textContent ?? null,
        state: root.querySelector('#routeCard')?.dataset.s,
        shadowIsolated: mount.shadowRoot !== null && document.querySelector('#routeCard') === null,
      };
    })()`), { timeoutMs: 30000 });
    } catch (error) {
      writeJson(join(directory, `${currentVersion}-${phase}-settings-v74-failure.json`), safe({
        error: error.message,
        body: await renderer.evaluate('document.body?.innerText ?? ""'),
        console: renderer.consoleEntries,
        exceptions: renderer.exceptions,
        clientLoaded: await renderer.evaluate('Boolean(document.querySelector("[data-dsg-route]")?.shadowRoot)'),
      }));
      throw error;
    }
    writeJson(join(directory, `${currentVersion}-${phase}-settings-v74-ui.json`), safe(v74Detail));
    assert.equal(v74Detail.route, true);
    assert.ok(v74Detail.providers >= 6);
    assert.equal(v74Detail.testButton, true);
    assert.equal(v74Detail.shadowIsolated, true);
    // D-29: the plugin detail page is the only settings surface and the native
    // PluginManager switch is the only stop control; there is no stop button.
    return { detail: v74Detail, nativeSwitchManagedByHost: true, buttonFound: false, after: v74Detail };
  } finally {
    renderer.close();
  }
}

async function settingsDialogRendererFlow(host) {
  const renderer = await connectRenderer(host.debuggerPort);
  const q = selector => `(() => {
    const roots = [document.querySelector('[data-dsg-route]')?.shadowRoot,
      document.querySelector('[data-dsg-layer]')?.shadowRoot];
    return roots.map(root => root?.querySelector(${JSON.stringify(selector)})).find(Boolean);
  })()`;
  const click = selector => renderer.evaluate(`(() => { const element=${q(selector)};
    if (!element || element.disabled) return false; element.click(); return true; })()`);
  const value = (selector, text) => renderer.evaluate(`(() => { const input=${q(selector)};
    if (!input || input.readOnly) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});
    input.dispatchEvent(new Event('input',{bubbles:true,composed:true})); return true; })()`);
  const closed = () => waitForRenderer(renderer, current => current.evaluate(`Boolean(${q('#overlay')}?.hidden)`));
  const snapshot = () => renderer.evaluate(`(async () => {
    const response=await fetch('/api/grokSearchSettings/snapshot',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),
        method:'grokSearchSettings/snapshot',payload:{args:{}}})});
    const data=await response.json();
    if (!data.result?.ok) throw new Error(data.result?.error?.code || 'snapshot failed');
    return data.result.value;
  })()`);
  const tests = [];
  const check = (name, actual, expected = true) => {
    tests.push({ name, passed: JSON.stringify(actual) === JSON.stringify(expected) });
    assert.deepEqual(actual, expected, `Settings dialog check: ${name}`);
  };
  try {
    // All data below lives in the fresh, isolated profile. Never starts a
    // provider test or sends a synthetic credential to an external service.
    // The prior security probe writes via raw RPC outside the UI. Let the
    // controller poll observe its final revision before starting a key edit;
    // a stale secret revision is intentionally never auto-rebased.
    // Production deliberately suspends polling in a hidden renderer. A raw
    // RPC write outside the view does not wake it; foreground the isolated
    // test page exactly as a user returning to the detail page would.
    await renderer.send('Page.bringToFront');
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForRenderer(renderer, current => current.evaluate(`document.visibilityState === 'visible'
      && ${q('#cfgTag')}?.textContent === 'Grok 共享配置'`));
    check('open Grok card', await click('.row[data-id=grok] .row-main'));
    check('fill synthetic key', await value('input[data-k=key]', 'dsh-offline-ui-key'));
    check('fill model', await value('input[data-k=model]', 'grok-ui-test-model'));
    check('save through production RPC adapter', await click('[data-a=save]'));
    await closed();
    const configured = await snapshot();
    check('key redacted/configured', configured.config.fields.grok_api_key.configured);
    check('key absent from ordinary snapshot', !JSON.stringify(configured).includes('dsh-offline-ui-key'));
    check('model persisted', configured.config.fields.grok_model.value, 'grok-ui-test-model');
    check('card reopen', await click('.row[data-id=grok] .row-main'));
    check('reopened key starts hidden', await renderer.evaluate(`${q('input[data-k=key')}?.value`), '');
    check('eye invokes reveal', await click('[data-a=eye][data-k=key]'));
    await waitForRenderer(renderer, current => current.evaluate(`${q('input[data-k=key')}?.type === 'text'
      && ${q('input[data-k=key')}?.value === 'dsh-offline-ui-key'`));
    check('reveal does not dirty draft', await renderer.evaluate(`${q('[data-a=save]')}?.disabled`));
    check('close reveal', await click('[data-a=cancel]')); await closed();
    check('open Hub', await click('#nodeHub'));
    check('change shared timeout', await value('input[data-k=timeout]', '65'));
    check('save Hub shared setting', await click('[data-a=save]')); await closed();
    check('Hub persisted', (await snapshot()).config.fields.timeout_seconds.value, 65);
    check('open Hub advanced', await click('#nodeHub'));
    check('expand advanced', await click('[data-a=adv]'));
    check('program path read-only', await renderer.evaluate(`${q('input[data-k=exeOverride')}?.readOnly`));
    check('config path read-only', await renderer.evaluate(`${q('input[data-k=cfgOverride')}?.readOnly`));
    check('budget read-only', await renderer.evaluate(`${q('input[data-k=budget')}?.readOnly`));
    check('close advanced', await click('[data-a=cancel]')); await closed();
    check('open TinyFish', await click('.row[data-id=tinyfish] .row-main'));
    check('TinyFish search URL exists', await renderer.evaluate(`Boolean(${q('input[data-k=searchUrl]')})`));
    check('TinyFish fetch URL exists', await renderer.evaluate(`Boolean(${q('input[data-k=fetchUrl]')})`));
    check('TinyFish unconfigured switch off', await renderer.evaluate(`${q('.head-switch .switch')}?.getAttribute('aria-checked')`), 'false');
    check('close TinyFish', await click('[data-a=cancel]')); await closed();
    check('keyboard Alt reorder', await renderer.evaluate(`(() => {
      const main=${q('.row[data-id=exa] .row-main')};
      main.focus(); main.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true,composed:true}));
      return true;
    })()`));
    await waitForRenderer(renderer, current => current.evaluate(`${q('#rowsSupp .row')}?.dataset.id === 'exa'`));
    check('reorder writes shared source list', (await snapshot()).config.fields.source_providers.value[0], 'exa');
    check('Grok card clear', await click('.row[data-id=grok] .row-main'));
    check('arm clear', await click('[data-a=clear]'));
    check('confirm clear', await click('[data-a=clear]')); await closed();
    check('clear removed key', (await snapshot()).config.fields.grok_api_key.configured, false);
    check('history undo button', await click('.t-act'));
    await waitForRenderer(renderer, async () => (await snapshot()).config.fields.grok_api_key.configured);
    check('real history undo restores model', (await snapshot()).config.fields.grok_model.value, 'grok-ui-test-model');
    // Remove just this probe's synthetic credential. No test/diagnostic call.
    const current = await snapshot();
    const cleared = await renderer.evaluate(`(async () => {
      const response=await fetch('/api/grokSearchSettings/save',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'grokSearchSettings/save',
          payload:{args:{request:{expectedRevision:${JSON.stringify(current.config.revision)},updates:{grok_api_key:null,grok_model:null,timeout_seconds:null}}}}})});
      return (await response.json()).result?.ok === true;
    })()`);
    check('cleanup only probe-owned config values', cleared);
    const evidence = { passed: tests.length, failed: 0, tests, syntheticCredentialsOnly: true,
      paidProviderRequests: false, exceptions: renderer.exceptions };
    writeJson(join(directory, currentVersion + '-settings-v74-dialog-flow.json'), safe(evidence));
    return evidence;
  } catch (error) {
    writeJson(join(directory, currentVersion + '-settings-v74-dialog-failure.json'), safe({
      message: error.message, tests, exceptions: renderer.exceptions,
      visibility: await renderer.evaluate('document.visibilityState'),
      configTag: await renderer.evaluate(`${q('#cfgTag')}?.textContent ?? null`),
      operationError: await renderer.evaluate(`${q('.save-error')}?.textContent ?? null`),
      validationErrors: await renderer.evaluate(`(() => {
        const dialog=${q('#dialog')}; return [...(dialog?.querySelectorAll('.f-msg:not([hidden])') || [])]
          .map(element=>element.textContent);
      })()`),
    }));
    throw error;
  } finally { renderer.close(); }
}

function auditCounterSource(runtime) {
  const modules = [
    ['web-runtime', 'dsh/node_modules/@deepseek-ai/dsh-web/lib/index.js'],
    ['web-tool', 'dsh/node_modules/@deepseek-ai/dsh-tool-web/lib/index.js'],
    ['web-search-deepseek', 'dsh/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js'],
    ['session', 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'],
  ];
  const evidence = modules.map(([role, file]) => {
    const source = runtime.archive.read(file).toString('utf8');
    return { role, file, sha256: runtime.archive.sha256(file),
      counterContractPresent: source.includes('web/deepseek-search-llm-request') };
  });
  const declared = role => evidence.find(row => row.role === role)?.counterContractPresent === true;
  const found = declared('web-search-deepseek') && declared('session');
  return { version: runtime.app.version, modules: evidence,
    officialCounterContractFound: found,
    adapterDecision: found ? 'canonical-session-event' : 'fail-closed-no-official-counter' };
}

async function unusedPort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

async function prepare(runtime, folder) {
  const args = [join(project, 'scripts/deferred-release-desktop-prepare.mjs'), '--desktop', runtime.executable,
    '--run-root', folder, '--control-record-mode', 'versioned', '--entry-mode', 'plugin-manager-live'];
  const execution = await commandResult(process.execPath, args, { cwd: project, timeoutMs: 120000, sanitize });
  writeJson(join(directory, runtime.app.version + '-prepare.json'), receipt(execution));
  assert.equal(execution.exitCode, 0, execution.stderr);
  assert.equal(execution.timedOut, false);
  const value = JSON.parse(execution.rawStdout);
  assert.equal(value.dependencyInstall, false);
  assert.equal(value.originalAsarUnmodified, true);
}

async function start(runtime, folder, phase) {
  const control = JSON.parse(readFileSync(join(folder, 'local-control.json'), 'utf8'));
  // Windows packaged startup registers dsh:// globally before our fixture can
  // intervene. Use the shipped default_app + original ASAR, as the other
  // isolated Desktop gates do. No host code, binary or association is changed.
  const executable = process.platform === 'win32' ? control.electron : runtime.executable;
  const debuggerPort = await unusedPort();
  const addressPath = join(folder, 'address-' + (++serial) + '.json');
  const args = [...(process.platform === 'win32' ? [runtime.archivePath] : []),
    '--user-data-dir=' + control.userData, '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + debuggerPort, '--lang=zh-CN'];
  const env = cleanEnvironment(folder, {
    DSH_HOME: control.dshHome,
    ...(process.platform === 'win32' ? {
      DSH_DESKTOP_DSH_DIR: control.runtime,
      DSH_DESKTOP_PRIMARY_RUNTIME_DIR: control.primaryRuntime,
      DSH_DESKTOP_PNPM_ENTRY: control.pnpmEntry,
    } : {}),
    DSH_DESKTOP_FIXTURE_TOKEN: control.token,
    DSH_DESKTOP_FIXTURE_ADDRESS_FILE: addressPath,
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    DSH_B2_CONTROL_RECORD: '1',
    DSH_B2_PRODUCT_COUNTER: '1',
    DSH_DESKTOP_OFFLINE_SENTINEL: 'offline-test-sentinel-not-a-real-key',
    DSH_PRODUCT_ANALYTICS_OTLP_URL: 'http://127.0.0.1:9',
    DSH_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: '--dns-result-order=ipv4first',
    PNPM_HOME: join(temporary, 'pnpm-home'),
    PNPM_STORE_DIR: join(temporary, 'pnpm-store'),
    npm_config_update_notifier: 'false',
    ...(sourceOnlyConfig ? { GROK_SEARCH_CONFIG: sourceOnlyConfig } : {}),
    ...(manualAcceptance ? { DSH_MANUAL_ACCEPTANCE: '1' } : {}),
    ...(firstUse || upgradeFrom ? { PATH: process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32')
      : '/usr/bin:/bin:/usr/sbin:/sbin' } : {}),
  });
  secrets.add(control.token);
  for (const name of ['pnpm-home', 'pnpm-store']) mkdirSync(join(temporary, name), { recursive: true });
  const prefix = runtime.app.version + '-' + phase + '-' + serial;
  const stdoutPath = join(directory, prefix + '-stdout.log');
  const stderrPath = join(directory, prefix + '-stderr.log');
  const stdout = sourceOnlyConfig ? null : openSync(stdoutPath, 'wx');
  const stderr = sourceOnlyConfig ? null : openSync(stderrPath, 'wx');
  const captured = { stdout: '', stderr: '' };
  writeJson(join(directory, prefix + '-command.json'), safe({
    executable, args, cwd: folder,
    environment: Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('DSH_') || name.startsWith('PNPM_') || name === 'NODE_OPTIONS')),
    packagedStartup: process.platform !== 'win32', originalAsar: true, isolatedUserData: true,
    startupMode: process.platform === 'win32' ? 'official-default-app-with-original-asar' : 'packaged-app',
    startedAt: new Date().toISOString(),
  }));
  // Automated gates stay hidden; the person doing manual acceptance must see
  // the isolated test window (Windows applies SW_HIDE to the first GUI show).
  const child = spawn(executable, args, { cwd: folder, env, windowsHide: !manualAcceptance, shell: false,
    stdio: sourceOnlyConfig ? ['ignore', 'pipe', 'pipe'] : ['ignore', stdout, stderr] });
  if (sourceOnlyConfig) {
    for (const stream of ['stdout', 'stderr']) {
      // Decode as one UTF-8 stream so multi-byte characters never split.
      child[stream].setEncoding('utf8');
      child[stream].on('data', chunk => {
        // Buffer before redacting, so secrets split across chunks cannot escape.
        // Trim only at a line break: a cut secret would leave an unredactable tail.
        const text = captured[stream] + chunk;
        if (text.length <= 2_000_000) { captured[stream] = text; return; }
        const window = text.slice(-2_000_000);
        const lineStart = window.indexOf('\n');
        captured[stream] = lineStart === -1 ? '' : window.slice(lineStart + 1);
      });
    }
  } else { closeSync(stdout); closeSync(stderr); }
  const state = { prefix, child, folder, control, debuggerPort, exited: false, spawnError: null };
  state.closed = new Promise(done => {
    child.once('error', error => { state.spawnError = error.message; });
    child.once('close', (code, signal) => {
      state.exited = true; state.exitCode = code; state.signal = signal;
      if (sourceOnlyConfig) {
        writeFileSync(stdoutPath, sanitize(captured.stdout), { flag: 'wx', mode: 0o600 });
        writeFileSync(stderrPath, sanitize(captured.stderr), { flag: 'wx', mode: 0o600 });
      }
      done();
    });
  });
  children.push(state);
  try {
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      if (state.exited) throw new Error('Packaged Desktop exited during startup: ' + state.spawnError + ' '
        + sanitize(sourceOnlyConfig ? captured.stderr : readFileSync(stderrPath, 'utf8')).slice(-2500));
      if (existsSync(addressPath)) {
        const readAddress = () => JSON.parse(readFileSync(addressPath, 'utf8'));
        const post = async (op, args = {}) => {
          if (!state.address) throw new Error('Desktop probe address is unavailable.');
          const response = await fetch('http://127.0.0.1:' + state.address.port + '/probe', {
            method: 'POST', headers: { Authorization: control.token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(600000),
          });
          const value = await response.json();
          if (response.status !== 200 || !value.ok) {
            const error = new Error(value.error?.message ?? 'Desktop probe failed.');
            error.probeRejected = true;
            throw error;
          }
          return value.value;
        };
        state.address = readAddress();
        state.readAddress = readAddress;
        state.reconnect = async previous => {
          const until = Date.now() + 90000;
          let lastError;
          while (Date.now() < until) {
            if (state.exited) throw new Error('Packaged Desktop exited while reconnecting its probe.');
            try {
              const next = readAddress();
              if (!previous || next.port !== previous.port || next.pid !== previous.pid || next.instanceId !== previous.instanceId) {
                state.address = next;
                delete state.modelSession; delete state.cookie; delete state.rpc;
                return await state.probe('snapshot');
              }
            } catch (error) { lastError = error; }
            try { return await state.probe('snapshot'); } catch (error) { lastError = error; }
            await sleep(300);
          }
          throw lastError ?? new Error('Packaged Desktop probe did not reconnect.');
        };
        state.probe = async (op, args = {}) => {
          const until = Date.now() + 30000;
          let lastError;
          while (Date.now() < until) {
            try { state.address = readAddress(); return await post(op, args); }
            catch (error) { lastError = error; if (state.exited) throw error; await sleep(300); }
          }
          throw lastError ?? new Error('Desktop probe did not answer: ' + op);
        };
        state.probeMutation = async (op, args = {}) => {
          const previous = readAddress();
          state.address = previous;
          try { return await post(op, args); }
          catch (error) {
            if (error.probeRejected !== true) { error.transportLost = true; error.previousAddress = previous; }
            throw error;
          }
        };
        const snapshot = await state.probe('snapshot');
        state.initial = snapshot;
        if (snapshot.pluginManagerPresent && snapshot.runtimeWeb && snapshot.existingDependencyPresent) {
          writeJson(join(directory, prefix + '-initial.json'), safe(snapshot));
          return state;
        }
      }
      await sleep(200);
    }
    throw new Error('Packaged Desktop startup did not produce an isolated probe.');
  } catch (error) {
    await close(state);
    throw error;
  }
}

async function close(state) {
  if (!state.exited) {
    try {
      await requestDesktopShutdown(state.debuggerPort, state.closed, { timeoutMs: 20000 });
    } catch (error) {
      state.closeError = error.message;
      if (!state.exited) { state.forced = true; state.child.kill('SIGKILL'); await state.closed; }
    }
  }
  const identity = { prefix: state.prefix, pid: state.child.pid, exitCode: state.exitCode, signal: state.signal,
    forced: state.forced ?? false, closeError: state.closeError ?? null, finishedAt: new Date().toISOString() };
  if (!state.exitSaved) { writeJson(join(directory, state.prefix + '-exit.json'), safe(identity)); state.exitSaved = true; }
  return identity;
}

async function waitFor(host, predicate, label, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await host.probe('snapshot');
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(label + ': ' + JSON.stringify(last));
}

async function modelTurn(host, mode) {
  if (!host.modelSession) {
    const auth = await host.probe('model-auth');
    const response = await fetch(auth.url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    host.cookie = cookie;
    host.rpc = async (endpoint, request) => {
      const envelope = { type: 'client-request', rpcId: 'manager-rpc-' + (++serial), method: endpoint, payload: { args: { request } } };
      const result = await fetch(host.address.hostOrigin + '/api/' + endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: host.address.hostOrigin, Cookie: host.cookie },
        body: JSON.stringify(envelope), signal: AbortSignal.timeout(20000) }).then(value => value.json());
      assert.equal(result?.result?.ok, true, JSON.stringify(result));
      return result.result.value;
    };
    const created = await host.rpc('session/create', { cwd: host.control.workspace });
    assert.ok(created.sessionId);
    host.modelSession = created.sessionId;
  }
  const before = await host.probe('snapshot');
  await host.rpc('session/prompt', { requestId: 'manager-prompt-' + (++serial), sessionId: host.modelSession,
    mode: 'queue', content: [{ type: 'text', text: mode }] });
  const deadline = Date.now() + (sourceOnlyConfig ? 65000 : 20000);
  while (Date.now() < deadline) {
    const after = await host.probe('snapshot');
    const events = after.sessionEvents.slice(before.sessionEvents.length).filter(event => event.sessionId === host.modelSession);
    const final = events.findLast(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === '内部候选轮次完成'));
    const ended = final && events.find(event => event.type === 'turn/end'
      && event.data.turn === final.data.turn && event.data.reason?.kind === 'completed');
    const toolResult = final && events.findLast(event => event.type === 'tool/result' && event.data.turn === final.data.turn);
    if (after.completed > before.completed && ended && (mode === 'chat' || toolResult)) {
      return { mode, isError: toolResult?.data.message.isError === true,
        text: toolResult?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '',
        beforeCalls: before.calls, afterCalls: after.calls };
    }
    await sleep(100);
  }
  throw new Error('Actual Desktop model turn did not complete: ' + mode);
}

function managerNames(state) {
  return state.bundles.map(bundle => bundle.name);
}

function assertManagerApplied(result, target, application = 'applied') {
  assert.equal(result.application, application, JSON.stringify(result));
  assert.equal(result.changed, true, JSON.stringify(result));
  assert.equal(result.target, target, JSON.stringify(result));
  assert.equal(result.error ?? null, null, JSON.stringify(result));
}

async function installBundle(host, spec, name) {
  return nativeManagerRpc(host, 'installBundle', { spec, options: { enabled: true, requestId: randomUUID() } });
}

async function setBundleEnabled(host, name, enabled) {
  return nativeManagerRpc(host, 'setBundleEnabled', { name, enabled });
}

async function removeBundle(host, name) {
  return nativeManagerRpc(host, 'removeBundle', { name });
}

async function nativeManagerRpc(host, method, args) {
  // Calling from the fixture's own HTTP handler deadlocks when pnpm/HMR
  // replaces that fixture and its disposer waits for the outstanding handler.
  // Use the authenticated first-party RPC transport and keep probes read-only.
  const renderer = await connectRenderer(host.debuggerPort, { requestTimeoutMs: 180000 });
  try {
    // A freshly started host answers /api only after the renderer finished its
    // own boot; an early call returned an empty body (run 18-43-11.877Z-1756).
    await waitForRenderer(renderer, async current => {
      const ready = await current.evaluate(`document.readyState === 'complete'
        && document.body?.innerText?.trim().length > 0
        && !/Loading plugins|正在加载插件/i.test(document.body.innerText)`);
      return ready ? true : null;
    }, { timeoutMs: 60000 });
    const result = await renderer.evaluate(`(async () => {
      const method = ${JSON.stringify('pluginManager/' + method)};
      const response = await fetch('/api/' + method, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(170000),
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method,
          payload: { args: ${JSON.stringify(args)} } }),
      });
      const text = await response.text();
      if (!text) return { ok: false, transport: { status: response.status, emptyBody: true } };
      return JSON.parse(text).result;
    })()`);
    assert.equal(result?.ok, true, JSON.stringify(result));
    return result.value;
  } finally { renderer.close(); }
}

async function sourceSettingsRpc(host, method, request) {
  const renderer = await connectRenderer(host.debuggerPort, { requestTimeoutMs: 45000 });
  try {
    return await renderer.evaluate(`(async () => {
      const method=${JSON.stringify('grokSearchSettings/' + method)};
      const response=await fetch('/api/'+method, {
        method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        signal:AbortSignal.timeout(40000),
        body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,
          payload:{args:${JSON.stringify(request === undefined ? {} : { request })}}}),
      });
      const result=(await response.json()).result;
      if(!result?.ok) throw new Error(result?.error?.code||'Source-only settings rejected.');
      return result.value;
    })()`);
  } finally { renderer.close(); }
}

async function prepareSourceOnlyHost(runtime) {
  currentVersion = runtime.app.version;
  const folder = join(temporary, runtime.app.version);
  await prepare(runtime, folder);
  const preferences = createPrivatePreferences({ path: join(folder, 'dsh-home/profiles/desktop/grok-search/preferences.json') });
  const before = preferences.snapshot();
  preferences.save(before.revision, { ...before.value, grokEnabled: false, githubEnabled: false });
  return start(runtime, folder, manualAcceptance ? 'manual-ready' : 'source-only-install');
}

async function runSourceOnly(runtime) {
  const host = await prepareSourceOnlyHost(runtime);
  try {
    const installed = await installBundle(host, productTarball, PRODUCT_BUNDLE);
    assertManagerApplied(installed, PRODUCT_BUNDLE);
    await waitFor(host, state => state.productProgram?.phase === 'ready'
      && state.productControl?.phase === 'required' && state.runtimeWeb?.searchProviderId === 'grok-search',
    'Source-only product did not become ready.', 140000);
    const preferences = await sourceSettingsRpc(host, 'preferences');
    assert.equal(preferences.value.grokEnabled, false);
    const settings = await sourceSettingsRpc(host, 'snapshot');
    assert.equal(settings.config.fields.grok_api_key.configured, false);
    assert.equal(settings.config.fields.openai_compatible_api_key.configured, false);
    assert.equal(settings.plugin.configSource, 'environment');
    assert.equal(settings.config.path, sourceOnlyConfig);
    const detail = await pluginManagerRendererSnapshot(host);
    const initialUi = await settingsStopRendererFlow(host, 'source-only');
    const summarize = result => ({
      mode: result.mode, isError: result.isError, textChars: result.text.length,
      sourceUrls: [...new Set([...result.text.matchAll(/https?:\/\/[^\s<>()]+/g)].map(match => match[0]))],
      originalSearchDelta: result.afterCalls.original - result.beforeCalls.original,
    });
    const search = summarize(await modelTurn(host, 'search'));
    assert.equal(search.isError, false);
    assert.ok(search.sourceUrls.length > 0);
    assert.equal(search.originalSearchDelta, 0);
    const routed = await sourceSettingsRpc(host, 'snapshot');
    assert.equal(routed.route.grokCode, 'DISABLED');
    assert.equal(routed.route.fallbackUsed, true);
    assert.ok(['tavily', 'exa', 'tinyfish', 'firecrawl'].includes(routed.route.served));
    const renderer = await connectRenderer(host.debuggerPort);
    let routeUi;
    try {
      await waitForRenderer(renderer, current => current.evaluate(
        `document.querySelector('[data-dsg-route]')?.shadowRoot?.querySelector('.row[data-id=grok] .switch')?.getAttribute('aria-checked')==='false'`));
      routeUi = await renderer.evaluate(`(() => {
        const root=document.querySelector('[data-dsg-route]')?.shadowRoot;
        return {state:root?.querySelector('#routeCard')?.dataset.s,
          status:root?.querySelector('#statusText')?.textContent,
          grokEnabled:root?.querySelector('.row[data-id=grok] .switch')?.getAttribute('aria-checked')==='true'};
      })()`);
      const screenshot = await renderer.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(directory, runtime.app.version + '-source-only-ui.png'), Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
    } finally { renderer.close(); }
    const fetch = summarize(await modelTurn(host, 'fetch'));
    const chat = summarize(await modelTurn(host, 'chat'));
    assert.equal(fetch.isError, false); assert.equal(chat.isError, false);
    const disabled = await setBundleEnabled(host, PRODUCT_BUNDLE, false);
    assertManagerApplied(disabled, PRODUCT_BUNDLE);
    await waitFor(host, state => state.runtimeWeb?.searchProviderId === 'candidate-original'
      && !state.productProgram, 'Source-only native disable did not restore the author route.');
    const enabled = await setBundleEnabled(host, PRODUCT_BUNDLE, true);
    assertManagerApplied(enabled, PRODUCT_BUNDLE);
    await waitFor(host, state => state.productProgram?.phase === 'ready'
      && state.productControl?.phase === 'required', 'Source-only native enable did not restore takeover.');
    assert.equal((await sourceSettingsRpc(host, 'preferences')).value.grokEnabled, false);
    const searchAfterEnable = summarize(await modelTurn(host, 'search'));
    assert.equal(searchAfterEnable.isError, false);
    assert.equal(searchAfterEnable.originalSearchDelta, 0);
    assert.ok(searchAfterEnable.sourceUrls.length > 0);
    const routedAfterEnable = await sourceSettingsRpc(host, 'snapshot');
    assert.equal(routedAfterEnable.route.grokCode, 'DISABLED');
    assert.equal(routedAfterEnable.route.fallbackUsed, true);
    assert.ok(routedAfterEnable.route.at > routed.route.at, 'The re-enabled search must record a new route.');
    assert.equal(sha256(sourceOnlyConfig), sourceConfigBefore);
    const exit = await close(host);
    assert.equal(exit.exitCode, 0); assert.equal(exit.forced, false);
    return { installed, detail, initialUi, routeUi, search, route: routed.route, fetch, chat,
      disabled, enabled, searchAfterEnable, routeAfterEnable: routedAfterEnable.route, exit,
      // Derived from the observed routes, not a network packet count.
      grokCredentialsAbsent: true, grokSearchBypassedByObservedRoutes: true,
      sourceOnlyConfigurationUnchanged: true,
      boundary: 'Real supplementary API through native search in official Desktop; model/fetch/author route are isolated fixtures, not real DeepSeek model or official-search acceptance.' };
  } finally { await close(host); }
}

async function holdManualAcceptance(runtime) {
  const host = await prepareSourceOnlyHost(runtime);
  try {
    assert.equal(managerNames(await host.probe('plugin-manager-state')).includes(PRODUCT_BUNDLE), false);
    writeJson(join(directory, 'ready-for-user.json'), safe({
      runId, version: runtime.app.version, status: 'ready-for-user', userAcceptancePassed: false,
      pluginPreinstalled: false, productTarball, sourceOnlyConfig, isolatedProfile: host.control.profile,
      configuredGrok: false, noBrowserAccountLogin: true,
      boundary: 'Real Desktop UI, isolated sources-only config; offline model/fetch/author provider. No production profile or dsh:// login callback.',
    }));
    console.log(JSON.stringify({ runId, status: 'ready-for-user', version: runtime.app.version,
      productTarball, evidence: join(directory, 'ready-for-user.json'),
      instructions: 'Install this tgz in the native Plugins page. Do not use browser login. Reply with manual results; finish on stdin closes only this test Desktop.' }));
    await new Promise(resolveHold => {
      host.child.once('close', resolveHold);
      const onInput = chunk => {
        if (String(chunk).trim() === 'finish') resolveHold();
      };
      process.stdin.on('data', onInput);
      host.closed.finally(() => process.stdin.off('data', onInput));
    });
    // Release stdin so the runner can exit after recording the result.
    process.stdin.destroy();
    return { manualEnvironmentPrepared: true, pluginInitiallyAbsent: true,
      userAcceptancePassed: false, externalUserVerdictRequired: true };
  } finally { await close(host); }
}

async function firstUseStub() {
  const key = 'dsh-first-use-' + randomUUID();
  secrets.add(key);
  const invalidKey = key + '-invalid';
  secrets.add(invalidKey);
  const state = { mode: 'ok' };
  const requests = [];
  const server = createServer((request, response) => {
    let length = 0, chunks = [];
    request.on('data', chunk => {
      length += chunk.length;
      if (length <= 1024 * 1024) chunks.push(chunk);
    });
    request.on('end', () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      chunks = [];
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const provider = pathname.startsWith('/tavily/') ? 'tavily'
        : pathname.startsWith('/exa/') ? 'exa' : pathname === '/tinyfish' ? 'tinyfish'
          : pathname.startsWith('/firecrawl/') ? 'firecrawl' : 'grok';
      const credential = ['exa', 'tinyfish'].includes(provider)
        ? request.headers['x-api-key'] : request.headers.authorization?.replace(/^Bearer /, '');
      const authorized = credential === key || credential === invalidKey;
      requests.push({ method: request.method, path: pathname,
        provider, mode: state.mode, keySlot: credential === invalidKey ? 'invalid' : 'valid',
        authorizedWithSyntheticKey: authorized, model: payload?.model ?? null });
      const validContract = provider === 'grok' ? request.method === 'POST' && pathname === '/v1/responses'
        : provider === 'tinyfish' ? request.method === 'GET' && pathname === '/tinyfish'
          : request.method === 'POST' && pathname === (provider === 'firecrawl'
            ? '/firecrawl/v2/search' : '/' + provider + '/search');
      if (length > 1024 * 1024 || !validContract || !authorized) {
        response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: { message: 'isolated first-use request rejected' } }));
        return;
      }
      const failed = state.mode === 'failed' || credential === invalidKey
        || state.mode === 'partial' && ['grok', 'tinyfish', 'firecrawl'].includes(provider);
      if (failed) {
        const code = provider === 'firecrawl' ? 500 : provider === 'tinyfish' ? 403 : 401;
        response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: { message: 'isolated test failure' } }));
        return;
      }
      if (provider !== 'grok') {
        const source = { url: state.mode === 'invalid-first-source' && provider === 'exa'
          ? 'https://[invalid-source' : state.mode === 'long-first-source' && provider === 'exa'
            ? 'https://example.invalid/' + 'long-path-'.repeat(200)
            : 'https://example.invalid/integrated/' + provider,
          title: 'Integrated ' + provider + ' result', content: 'loopback source',
          summary: 'loopback source', description: 'loopback source', snippet: 'loopback source', score: 1 };
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(provider === 'firecrawl'
          ? { success: true, data: { web: [source] } } : { results: [source] }));
        return;
      }
      const text = 'isolated first-use Grok search succeeded';
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ id: 'resp-' + requests.length, object: 'response', status: 'completed',
        model: payload.model, output_text: text, output: [
          { type: 'web_search_call', action: { sources: [{ url: 'https://example.invalid/first-use',
            title: 'Isolated first-use source', description: text }] } },
          { type: 'message', content: [{ type: 'output_text', text }] },
        ] }));
    });
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return { key, invalidKey, state, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done, reject) => server.close(error => error ? reject(error) : done())) };
}

async function matchingFirstUseProcesses(executable) {
  let command, args;
  if (process.platform === 'win32') {
    command = process.env.SystemRoot + '/System32/WindowsPowerShell/v1.0/powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name = 'grok-search-rs.exe'\" | Where-Object { $_.ExecutablePath -eq $env:DSH_FIRST_USE_PROGRAM } | Select-Object -ExpandProperty ProcessId"];
  } else {
    command = '/bin/ps';
    args = ['-axo', 'pid=,command='];
  }
  const result = await commandResult(command, args, { timeoutMs: 10000,
    env: { ...process.env, DSH_FIRST_USE_PROGRAM: executable }, sanitize });
  assert.equal(result.exitCode, 0, 'Cannot inspect first-use program processes.');
  return result.rawStdout.split(/\r?\n/).map(line => line.trim()).filter(line =>
    process.platform === 'win32' ? /^\d+$/.test(line) : line.slice(line.search(/\s/)).trim() === executable)
    .map(line => Number(line.split(/\s/, 1)[0]));
}

async function firstUseConfigure(host, stub) {
  const renderer = await connectRenderer(host.debuggerPort, { requestTimeoutMs: 30000 });
  const q = selector => `(() => {
    const roots = [document.querySelector('[data-dsg-route]')?.shadowRoot,
      document.querySelector('[data-dsg-layer]')?.shadowRoot];
    return roots.map(root => root?.querySelector(${JSON.stringify(selector)})).find(Boolean);
  })()`;
  try {
    await renderer.send('Page.bringToFront');
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const open = await renderer.evaluate(`(() => {
      const item=${q('.row[data-id=grok] .row-main')}; if (!item) return false; item.click(); return true;
    })()`);
    assert.equal(open, true, 'The first-use Grok card must be available.');
    for (const [field, value] of [['url', stub.baseUrl], ['key', stub.key]]) {
      const filled = await renderer.evaluate(`(() => {
        const input=${q(`input[data-k=${field}]`)}; if (!input || input.readOnly) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
        input.dispatchEvent(new Event('input',{bubbles:true,composed:true})); return true;
      })()`);
      assert.equal(filled, true, 'First-use field is not editable: ' + field);
    }
    assert.equal(await renderer.evaluate(`(() => { const button=${q('[data-a=save]')};
      if (!button || button.disabled) return false; button.click(); return true; })()`), true);
    await waitForRenderer(renderer, current => current.evaluate(`Boolean(${q('#overlay')}?.hidden)`));
    const saved = await renderer.evaluate(`(async () => {
      const response=await fetch('/api/grokSearchSettings/snapshot',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'grokSearchSettings/snapshot',payload:{args:{}}})});
      const result=(await response.json()).result;
      if (!result?.ok) throw new Error(result?.error?.code || 'First-use settings snapshot failed.');
      return result.value;
    })()`);
    assert.equal(saved.config.fields.grok_api_key.configured, true);
    assert.equal(saved.config.fields.grok_api_key.source, 'file');
    assert.equal(saved.config.fields.grok_api_url.value, stub.baseUrl);
    assert.equal(saved.plugin.programConfigured, false);
    assert.equal(saved.plugin.configSource, 'default');
    assert.ok(!JSON.stringify(saved).includes(stub.key));
    return { savedThroughProductionDialog: true, secretsRedacted: true,
      configPath: saved.config.path, revision: saved.config.revision,
      programOverrideRequired: false, configOverrideRequired: false, exceptions: renderer.exceptions };
  } finally { renderer.close(); }
}

async function productionDiagnosticsFlow(host, stub) {
  const renderer = await connectRenderer(host.debuggerPort, { requestTimeoutMs: 45000 });
  const q = selector => `(() => {
    const roots = [document.querySelector('[data-dsg-route]')?.shadowRoot,
      document.querySelector('[data-dsg-layer]')?.shadowRoot];
    return roots.map(root => root?.querySelector(${JSON.stringify(selector)})).find(Boolean);
  })()`;
  const click = selector => renderer.evaluate(`(() => { const element=${q(selector)};
    if (!element || element.disabled) return false; element.click(); return true; })()`);
  const call = (method, request) => renderer.evaluate(`(async () => {
    const method=${JSON.stringify('grokSearchSettings/' + method)};
    const response=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,
        payload:{args:${JSON.stringify(request === undefined ? {} : { request })}}})});
    const result=(await response.json()).result;
    if (!result?.ok) throw new Error(result?.error?.code || 'Settings RPC rejected.');
    return result.value;
  })()`);
  const snapshotUi = () => renderer.evaluate(`(() => {
    const root=${q('.dsg-root')}; return {
      state: root?.querySelector('#routeCard')?.dataset.s,
      status: root?.querySelector('#statusText')?.textContent,
      announcer: ${q('#announcer')}?.textContent,
      rows:[...(root?.querySelectorAll('.row[data-id]')||[])].map(row=>({
        id:row.dataset.id,state:row.dataset.st,
        checked:row.querySelector('.switch')?.getAttribute('aria-checked'),
        fault:row.querySelector('.row-fault')?.getAttribute('aria-hidden')==='false'
          ? row.querySelector('.row-fault')?.textContent : null,
      })),
      keys:[...(root?.querySelectorAll('.s-node[data-id]')||[])].map(node=>({
        id:node.dataset.id,dots:[...node.querySelectorAll('.s-dot')].map(dot=>dot.dataset.tone),
      })),
    };
  })()`);
  const runTest = async () => {
    assert.equal(await click('#testBtn'), true);
    await waitForRenderer(renderer, current => current.evaluate(`${q('#testPop')}?.hidden === false`));
    assert.equal(await click('[data-pop=go]'), true);
  };
  const completed = () => waitForRenderer(renderer, current => current.evaluate(`
    !${q('#testBtn')}?.disabled && ${q('#announcer')}?.textContent?.includes('已检查全部开启')
  `), { timeoutMs: 90000 });
  const tests = [];
  const check = (name, condition) => {
    tests.push({ name, passed: condition === true });
    assert.equal(condition, true, name);
  };
  try {
    await renderer.send('Page.bringToFront');
    // Test-only CDP focus emulation prevents OS foreground changes from
    // suspending the page's legitimate visible-only configuration polling.
    // No product code, document property or host runtime is patched.
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await renderer.send('Emulation.setDeviceMetricsOverride', {
      width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    const preferences = await call('preferences');
    await call('savePreferences', { expectedRevision: preferences.revision,
      value: { ...preferences.value, githubEnabled: false } });
    const current = await call('snapshot');
    await call('save', { expectedRevision: current.config.revision, updates: {
      tavily_api_url: stub.origin + '/tavily', tavily_api_key: stub.invalidKey + ',' + stub.key,
      exa_api_url: stub.origin + '/exa', exa_api_key: stub.key,
      tinyfish_search_api_url: stub.origin + '/tinyfish', tinyfish_api_key: stub.key,
      firecrawl_api_url: stub.origin + '/firecrawl', firecrawl_api_key: stub.key,
      tavily_enabled: true, exa_enabled: true, tinyfish_enabled: true, firecrawl_enabled: true,
      source_providers: ['exa', 'tavily', 'tinyfish', 'firecrawl'], default_extra_sources: 4,
    } });
    // After an out-of-view RPC update, wait for the production polling/visible
    // refresh to import it. Never touch the controller's internal state.
    await waitForRenderer(renderer, current => current.evaluate(`['exa','tavily','tinyfish','firecrawl']
      .every(id=>${q('.dsg-root')}?.querySelector('.row[data-id='+id+'] .switch')
        ?.getAttribute('aria-checked')==='true')
      && ${q('#rowsSupp .row')}?.dataset.id==='exa'`), { timeoutMs: 60000 });
    stub.state.mode = 'partial';
    const before = stub.requests.length;
    // Capture the transient class inside the page at mutation time. A second
    // CDP round-trip can arrive after a reduced-motion test has completed and
    // legitimately cleared its flash; do not treat that as a missing effect.
    await renderer.evaluate(`(() => {
      const row=${q('.row[data-id=tinyfish]')};
      if (!row) throw new Error('TinyFish diagnostic row is absent.');
      window.__dsgDiagnosticEvidence={faultFlash:false,
        reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};
      window.__dsgDiagnosticObserver=new MutationObserver(() => {
        if (row.classList.contains('is-fault-flash')) window.__dsgDiagnosticEvidence.faultFlash=true;
      });
      window.__dsgDiagnosticObserver.observe(row,{attributes:true,attributeFilter:['class']});
      return true;
    })()`);
    await runTest();
    const flash = await waitForRenderer(renderer, current => current.evaluate(
      `window.__dsgDiagnosticEvidence?.faultFlash ? window.__dsgDiagnosticEvidence : null`),
    { timeoutMs: 60000 });
    check('real-response-triggers-transient-error-border', flash.faultFlash);
    await renderer.evaluate(`window.__dsgDiagnosticObserver?.disconnect(); true`);
    await completed();
    const partial = await snapshotUi(), calls = stub.requests.slice(before);
    check('all-four-sources-tested-after-first-source-success',
      ['exa', 'tavily', 'tinyfish', 'firecrawl'].every(id => calls.some(row => row.provider === id)));
    check('both-Tavily-keys-tested', ['valid', 'invalid'].every(slot =>
      calls.some(row => row.provider === 'tavily' && row.keySlot === slot)));
    check('Grok-failed-backup-shown-without-search-failure', partial.state === 'fallback'
      && partial.status === '已静默回退' && partial.announcer.includes('已静默回退'));
    check('Tavily-partial-key-status-is-accurate', partial.keys.some(row =>
      row.id === 'tavily' && row.dots.includes('ok') && row.dots.includes('err')));
    check('TinyFish-error-has-real-403-short-code', partial.rows.some(row =>
      row.id === 'tinyfish' && row.fault?.includes('403')));
    check('Firecrawl-error-has-real-500-short-code', partial.rows.some(row =>
      row.id === 'firecrawl' && row.fault?.includes('500')));
    check('diagnosis-does-not-export-key-values', !JSON.stringify(partial).includes(stub.key));
    writeFileSync(join(directory, currentVersion + '-diagnostics-partial-ui.png'),
      Buffer.from((await renderer.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
      { flag: 'wx' });

    // The ordinary sources-only query must stop at Exa, unlike the full test.
    assert.equal(await click('.row[data-id=grok] .switch'), true);
    await waitForRenderer(renderer, current => current.evaluate(
      `${q('.row[data-id=grok] .switch')}?.getAttribute('aria-checked')==='false'`));
    const originalBefore = (await host.probe('snapshot')).calls.original;
    const searchStart = stub.requests.length;
    const ordinary = await host.probe('product-query-result');
    const ordinaryRequests = stub.requests.slice(searchStart);
    check('ordinary-sources-only-search-stops-at-first-success',
      ordinary.sources?.[0]?.url === 'https://example.invalid/integrated/exa'
      && ordinaryRequests.length === 1 && ordinaryRequests[0].provider === 'exa');
    check('ordinary-fallback-does-not-call-official-search',
      (await host.probe('snapshot')).calls.original === originalBefore);
    stub.state.mode = 'invalid-first-source';
    const invalidStart = stub.requests.length;
    const recovered = await host.probe('product-query-result');
    const recoveredRequests = stub.requests.slice(invalidStart);
    check('invalid-source-URL-falls-through-to-next-provider',
      recovered.sources?.[0]?.url === 'https://example.invalid/integrated/tavily'
      && recoveredRequests[0]?.provider === 'exa'
      && recoveredRequests.slice(1).some(row => row.provider === 'tavily')
      && !recoveredRequests.some(row => ['grok', 'tinyfish', 'firecrawl'].includes(row.provider)));
    check('invalid-source-URL-recovery-does-not-call-official',
      (await host.probe('snapshot')).calls.original === originalBefore);
    stub.state.mode = 'long-first-source';
    const beforeBudget = await call('snapshot');
    await call('save', { expectedRevision: beforeBudget.config.revision, updates: { response_max_chars: 5000 } });
    // Import a legal lower value through the isolated shared file. The UI's
    // write range intentionally starts at 5000; production accepts >=100.
    const budgetPath = beforeBudget.config.path;
    const originalBudgetText = readFileSync(budgetPath, 'utf8');
    assert.match(originalBudgetText, /^response_max_chars\s*=\s*5000/m);
    writeFileSync(budgetPath, originalBudgetText.replace(/^response_max_chars\s*=\s*5000/m, 'response_max_chars = 100'));
    try {
      const budgetStart = stub.requests.length;
      const bounded = await host.probe('product-query-result');
      const budgetRequests = stub.requests.slice(budgetStart);
      check('output-budget-zero-links-continues-to-next-source',
        bounded.sources?.[0]?.url === 'https://example.invalid/integrated/tavily'
        && JSON.stringify(bounded).length <= 100
        && budgetRequests[0]?.provider === 'exa' && budgetRequests.slice(1).some(row => row.provider === 'tavily'));
      check('output-budget-failover-does-not-call-official',
        (await host.probe('snapshot')).calls.original === originalBefore);
    } finally { writeFileSync(budgetPath, originalBudgetText); }
    stub.state.mode = 'failed';
    const allFailedStart = stub.requests.length;
    await runTest();
    await completed();
    const failed = await snapshotUi();
    check('all-failed-diagnosis-is-clear', failed.state === 'err'
      && failed.status === '搜索失败' && failed.announcer.includes('全部不可用'));
    check('disabled-Grok-is-not-tested', !stub.requests.slice(allFailedStart)
      .some(row => row.provider === 'grok'));
    check('failed-diagnosis-keeps-all-source-status-codes',
      ['exa', 'tavily', 'tinyfish', 'firecrawl'].every(id => failed.rows.some(row =>
        row.id === id && row.fault?.match(/401|403|500/))));
    check('real-diagnosis-no-page-exception', renderer.exceptions.length === 0);
    writeFileSync(join(directory, currentVersion + '-diagnostics-all-failed-ui.png'),
      Buffer.from((await renderer.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
      { flag: 'wx' });
    const evidence = { passed: tests.length, failed: 0, tests, partial, allFailed: failed,
      transientErrorBorderObserved: true, syntheticKeysOnly: true, upstream: 'loopback',
      testOnlyCdpFocusEmulation: true,
      reducedMotionObserved: flash.reducedMotion,
      realPaidProviderValidated: false, ordinarySearchRequests: ordinaryRequests,
      exceptions: renderer.exceptions };
    writeJson(join(directory, currentVersion + '-diagnostics-flow.json'), safe(evidence));
    return evidence;
  } catch (error) {
    writeJson(join(directory, currentVersion + '-diagnostics-failure.json'), safe({
      message: error.message, tests, ui: await snapshotUi(), exceptions: renderer.exceptions,
      visibility: await renderer.evaluate('document.visibilityState'),
      mountedViews: await renderer.evaluate('document.querySelectorAll("[data-dsg-route]").length'),
      backend: await call('snapshot').catch(error => ({ error: error.message })),
      requests: stub.requests,
    }));
    throw error;
  } finally {
    stub.state.mode = 'ok';
    await renderer.evaluate(`(() => {
      window.__dsgDiagnosticObserver?.disconnect();
      delete window.__dsgDiagnosticObserver; delete window.__dsgDiagnosticEvidence; return true;
    })()`).catch(() => {});
    renderer.close();
  }
}

async function runFirstUse(runtime) {
  currentVersion = runtime.app.version;
  const requestedFolder = join(temporary, runtime.app.version);
  await prepare(runtime, requestedFolder);
  // macOS aliases /var to /private/var. Use the resolved run root for both the
  // HOME-derived config and the profile cache; aliases are not a second file.
  const folder = realpathSync(requestedFolder);
  replacements.push([folder, '<TEMPORARY_RUN>/' + runtime.app.version]);
  const configPath = join(folder, 'user/.config/grok-search-rs/config.toml');
  const profile = join(folder, 'dsh-home/profiles/desktop');
  const cache = join(profile, 'grok-search/runtime-cache');
  assert.equal(existsSync(configPath), false);
  assert.equal(existsSync(join(cache, 'active.json')), false);
  const patchPath = join(profile, 'cordis.patch.yml');
  const assertNoProductPatch = () => assert.doesNotMatch(readFileSync(patchPath, 'utf8'), /grok-search/,
    'First use must not require a Grok entry or paths in the profile patch.');
  assertNoProductPatch();
  const stub = await firstUseStub();
  let host, ready;
  try {
    host = await start(runtime, folder, 'first-use-install');
    assert.equal(managerNames(await host.probe('plugin-manager-state')).includes(PRODUCT_BUNDLE), false);
    const installed = await installBundle(host, productTarball, PRODUCT_BUNDLE);
    assertManagerApplied(installed, PRODUCT_BUNDLE);
    ready = await waitFor(host, state => {
      if (state.productProgram?.phase === 'error') {
        throw new Error('First-use preparation failed: ' + JSON.stringify(state.productProgram.error));
      }
      return state.productProgram?.phase === 'ready' && state.productControl?.phase === 'required'
        && state.runtimeWeb?.searchProviderId === 'grok-search';
    }, 'Automatic first-use download did not complete', 140000);
    assert.equal(ready.productProgram.configuration.executable, false);
    assert.equal(ready.productProgram.configuration.configPath, false);
    assert.equal(ready.productProgram.configPath, configPath);
    assert.equal(ready.productProgram.program.source, 'private-cache');
    assert.equal(ready.productProgram.program.version, '0.1.26');
    assert.equal(existsSync(configPath), false, 'Program preparation must not create shared config.');
    const programPath = ready.productProgram.program.path;
    assert.ok(programPath.startsWith(cache + (process.platform === 'win32' ? '\\' : '/')));
    const active = JSON.parse(readFileSync(join(cache, 'active.json'), 'utf8'));
    const activeHash = sha256(join(cache, 'active.json'));
    assert.equal(active.sha256, ready.productProgram.program.sha256);
    assert.equal(active.mcpHandshakeValidated, true);
    assert.equal(active.credentialsValidated, false);
    assert.equal(sha256(programPath), active.sha256);
    const detail = await pluginManagerRendererSnapshot(host);
    const initialUi = await settingsStopRendererFlow(host, 'first-use');
    // The host's own onboarding writes ui-chat/ui-settings rows. That is not a
    // product configuration edit; take the comparison after that navigation.
    assertNoProductPatch();
    const patchAfterOnboarding = sha256(patchPath);
    const configured = await firstUseConfigure(host, stub);
    assert.equal(configured.configPath, configPath);
    assertNoProductPatch();
    const first = await modelTurn(host, 'search');
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal(first.afterCalls.original, first.beforeCalls.original);
    assert.match(first.text, /isolated first-use/i);
    const firstProcesses = await matchingFirstUseProcesses(programPath);
    assert.equal(firstProcesses.length, 1, 'One managed program should remain for reuse.');
    const second = await modelTurn(host, 'search');
    assert.equal(second.isError, false);
    assert.equal(second.afterCalls.original, second.beforeCalls.original);
    const secondProcesses = await matchingFirstUseProcesses(programPath);
    assert.deepEqual(secondProcesses, firstProcesses, 'Sequential first-use searches must reuse one process.');
    const fetch = await modelTurn(host, 'fetch'), chat = await modelTurn(host, 'chat');
    assert.equal(fetch.isError, false);
    assert.equal(chat.isError, false);
    assertNoProductPatch();
    const disabled = await setBundleEnabled(host, PRODUCT_BUNDLE, false);
    assertManagerApplied(disabled, PRODUCT_BUNDLE);
    await waitFor(host, state => state.runtimeWeb?.searchProviderId === 'candidate-original'
      && !state.productProgram, 'First-use native disable did not restore the original route.');
    assert.deepEqual(await matchingFirstUseProcesses(programPath), []);
    const enabled = await setBundleEnabled(host, PRODUCT_BUNDLE, true);
    assertManagerApplied(enabled, PRODUCT_BUNDLE);
    const reused = await waitFor(host, state => state.productProgram?.phase === 'ready'
      && state.productControl?.phase === 'required', 'Re-enable did not reuse the prepared private program.');
    assert.equal(reused.productProgram.program.path, programPath);
    assert.equal(sha256(join(cache, 'active.json')), activeHash, 'Re-enable must not redownload the private program.');
    const third = await modelTurn(host, 'search');
    assert.equal(third.isError, false);
    assert.equal(third.afterCalls.original, third.beforeCalls.original);
    const diagnosticFlow = diagnostics ? await productionDiagnosticsFlow(host, stub) : null;
    const exit = await close(host);
    assert.equal(exit.exitCode, 0);
    assert.equal(exit.forced, false);
    assert.deepEqual(await matchingFirstUseProcesses(programPath), []);
    assert.ok(stub.requests.length >= 2 && stub.requests.every(row => row.authorizedWithSyntheticKey));
    return { installed, detail, initialUi, configured, program: { version: active.version,
      source: 'private-cache', sha256: active.sha256, registry: active.registry,
      downloadRegistry: active.downloadRegistry, mcpHandshakeValidated: true },
      defaultConfigCreatedOnlyBySave: true, manualProfileEditRequired: false,
      productPatchEntriesAdded: false, hostOnboardingMayWriteProfile: true,
      profilePatchUnchangedAfterOnboarding: sha256(patchPath) === patchAfterOnboarding, hostRestartRequired: false,
      queries: [first, second, third], sameManagedProcessReused: true, nativeDisableReenableValidated: true,
      cacheReused: true, fetch, chat, diagnosticFlow, upstream: { scope: 'loopback-only', syntheticKeyOnly: true,
        requests: stub.requests }, exit, orphanPrograms: 0 };
  } finally {
    if (host) await close(host);
    await stub.close();
  }
}

// Real PluginManager lifecycle, with the released package, synthetic settings
// and a copied, previously downloaded native cache. Never touch a user's home.
async function upgradeCacheFixture(folder) {
  const cache = join(folder, 'dsh-home/profiles/desktop/grok-search/runtime-cache');
  const checked = await createPrivateProgramInstaller({ directory: upgradeCache }).active();
  assert.ok(checked?.found, 'An intact retained test cache is required.');
  const record = JSON.parse(readFileSync(join(upgradeCache, 'active.json'), 'utf8'));
  assert.equal(sha256(checked.path), record.sha256);
  mkdirSync(cache, { recursive: true });
  const target = resolve(cache, record.executable);
  const rel = relative(cache, target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  mkdirSync(dirname(target), { recursive: true });
  for (const [source, destination] of [[checked.path, target],
    [join(upgradeCache, 'active.json'), join(cache, 'active.json')],
    [join(dirname(checked.path), 'receipt.json'), join(dirname(target), 'receipt.json')]]) {
    assert.equal(lstatSync(source).isSymbolicLink(), false);
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }
  const handshake = await probeMcpHandshake({ executable: target,
    configPath: join(folder, 'handshake-not-created.toml'),
    envOverrides: { ...Object.fromEntries(Object.keys(process.env)
      .filter(key => /^(GROK_SEARCH_|TAVILY_|EXA_|TINYFISH_|FIRECRAWL_|OPENAI_COMPATIBLE_|GITHUB_TOKEN$)/i.test(key))
      .map(key => [key, null])), ...cleanEnvironment(folder, { GROK_SEARCH_AUTH_MODE: 'api_key',
      GROK_SEARCH_API_KEY: 'dsh-upgrade-handshake-not-a-real-key',
      GROK_SEARCH_URL: 'http://127.0.0.1:9', GROK_SEARCH_MODEL: 'handshake-only' }) } });
  assert.equal(handshake.version, record.version);
  assert.equal(handshake.exited, true);
  return { cache, target, binaryHash: record.sha256, activeHash: sha256(join(cache, 'active.json')),
    sourceActiveHash: sha256(join(upgradeCache, 'active.json')),
    setup: 'copy-of-previously-downloaded-test-cache-not-a-new-download', handshake };
}

async function upgradeUiAction(host, kind, spec = null, expectedVersion = null) {
  const renderer = await connectRenderer(host.debuggerPort, { requestTimeoutMs: 180000 });
  const button = (label, scope = 'document') => renderer.evaluate(`(() => {
    const element=[...${scope}.querySelectorAll('button')].find(item =>
      item.getClientRects().length && !item.disabled
      && (item.getAttribute('aria-label') || item.innerText || '').trim()===${JSON.stringify(label)});
    if (!element) return false; element.click(); return true;
  })()`);
  try {
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await button('返回插件');
    await waitForRenderer(renderer, async () => await button('插件') || null);
    if (kind === 'remove') {
      await waitForRenderer(renderer, async () => await button('查看 dsh-grok-search') || null);
      await waitForRenderer(renderer, async () => await button('卸载 dsh-grok-search') || null);
      await waitForRenderer(renderer, async () => await button('卸载',
        `(document.querySelector('[role="dialog"]') || document)`) || null);
      await waitFor(host, state => !state.selectedBundles.includes(PRODUCT_BUNDLE)
        && !state.productControl, 'Uninstall did not unload the old plugin.', 120000);
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (!managerNames(await host.probe('plugin-manager-state')).includes(PRODUCT_BUNDLE)) {
          return { action: 'remove', nativeUiClicked: true, pluginAbsent: true };
        }
        await sleep(200);
      }
      throw new Error('Native uninstall did not finish.');
    }
    await waitForRenderer(renderer, async () => await button('添加插件') || null);
    const filled = await renderer.evaluate(`(() => {
      const input=document.querySelector('input[aria-label="包名或地址"]');
      if(!input || input.disabled) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(spec)});
      input.dispatchEvent(new Event('input',{bubbles:true})); return true;
    })()`);
    assert.equal(filled, true, 'Native install field must accept the exact package path.');
    await waitForRenderer(renderer, async () => await button('安装',
      `(document.querySelector('[role="dialog"]') || document)`) || null);
    const until = Date.now() + 170000;
    let installed = false;
    while (Date.now() < until) {
      const state = await host.probe('plugin-manager-state');
      // The read-only fixture projects listBundles without its `installed`
      // property; require a resolved version and no package error instead.
      if (state.bundles.some(row => row.name === PRODUCT_BUNDLE && row.version && !row.error
        && (!expectedVersion || row.version === expectedVersion))) { installed = true; break; }
      const failure = await renderer.evaluate(`(() => {
        const root=document.querySelector('[role="dialog"]');
        return root && /插件安装失败|未能获取安装结果|安装状态尚未确认/.test(root.innerText) ? root.innerText : null;
      })()`);
      if (failure) throw new Error('Native UI installation failed: ' + failure.slice(0, 1600));
      await sleep(300);
    }
    assert.equal(installed, true, 'Native UI installation timed out.');
    const completion = await waitForRenderer(renderer, async () => {
      const scope = `(document.querySelector('[role="dialog"]') || document)`;
      if (await button('立即启用', scope)) return 'enabled';
      if (await button('完成', scope)) return 'already-enabled';
      return null;
    }, { timeoutMs: 30000 });
    await waitFor(host, state => state.productControl?.phase === 'required'
      && state.runtimeWeb?.searchProviderId === 'grok-search', 'Native enable did not take over.', 30000);
    await button('完成', `(document.querySelector('[role="dialog"]') || document)`);
    await button('关闭', `(document.querySelector('[role="dialog"]') || document)`);
    return { action: 'install', nativeUiClicked: true, completion,
      enabledThroughNativeUi: completion === 'enabled' };
  } finally { renderer.close(); }
}

async function runUpgrade(runtime) {
  currentVersion = runtime.app.version;
  const folder = join(temporary, runtime.app.version);
  await prepare(runtime, folder);
  const profile = join(folder, 'dsh-home/profiles/desktop');
  const configPath = join(folder, 'user/.config/grok-search-rs/config.toml');
  const cache = await upgradeCacheFixture(folder);
  const stub = await firstUseStub();
  const stages = [];
  let host;
  const configStore = createSharedConfigStore({ path: configPath, env: () => ({}) });
  const syntheticFields = ['grok_api_key', 'tavily_api_key', 'exa_api_key', 'tinyfish_api_key', 'firecrawl_api_key'];
  const fileTree = base => existsSync(base) ? readdirSync(base, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name)).flatMap(row => {
      assert.equal(row.isSymbolicLink(), false, 'Isolated persistence must not escape via links.');
      return row.isDirectory() ? fileTree(join(base, row.name)) : [{ file: relative(profile, join(base, row.name)),
        sha256: sha256(join(base, row.name)) }];
    }) : [];
  const preserved = () => ({
    config: sha256(configPath),
    preferences: sha256(join(profile, 'grok-search/preferences.json')),
    history: fileTree(join(profile, 'grok-search/config-history')),
    active: sha256(join(cache.cache, 'active.json')),
    binary: sha256(cache.target),
  });
  let expected, recordsBefore;
  const verify = async (receipt, phase, { ui = true } = {}) => {
    const ready = await waitFor(host, state => {
      if (state.productProgram?.phase === 'error') throw new Error(JSON.stringify(state.productProgram.error));
      return state.productProgram?.phase === 'ready' && state.productControl?.phase === 'required';
    }, 'Upgrade program/control not ready.', 30000);
    assert.equal(ready.productProgram.program.source, 'private-cache');
    assert.equal(ready.productProgram.program.path, cache.target);
    assert.equal(ready.productProgram.configPath, configPath);
    assert.equal(ready.productProgram.configuration.executable, false);
    assert.equal(ready.productProgram.configuration.configPath, false);
    assert.equal(ready.runtimeWeb.searchProviderId, 'grok-search');
    assert.equal(ready.runtimeWeb.fetchProviderId, 'candidate-fetch');
    assert.equal(ready.existingDependencyPresent, true);
    const installed = realpathSync(join(profile, 'node_modules/dsh-grok-search'));
    for (const row of receipt.sourceHashes) assert.equal(sha256(join(installed, row.file)), row.sha256,
      'Installed package differs: ' + row.file);
    assert.deepEqual(preserved(), expected, 'Updating a plugin must retain settings and the program cache.');
    for (const row of recordsBefore) assert.equal(sha256(join(profile, row.file)), row.sha256);
    if (ui) {
      const detail = await pluginManagerRendererSnapshot(host);
      assert.ok(detail.detail.text.includes(receipt.version));
      await settingsStopRendererFlow(host, 'upgrade-' + phase);
    }
    const snapshot = await sourceSettingsRpc(host, 'snapshot');
    for (const field of syntheticFields) {
      assert.equal(snapshot.config.fields[field].source, 'file');
      assert.equal(snapshot.config.fields[field].readOnly, false);
      assert.equal(snapshot.config.fields[field].configured, true);
      assert.equal(configStore.reveal(field).value, stub.key);
    }
    const search = await modelTurn(host, 'search');
    assert.equal(search.isError, false, JSON.stringify(search));
    assert.match(search.text, /isolated first-use/i);
    assert.equal(search.afterCalls.original, search.beforeCalls.original);
    const fetch = await modelTurn(host, 'fetch'), chat = await modelTurn(host, 'chat');
    assert.equal(fetch.isError, false); assert.equal(chat.isError, false);
    stages.push({ phase, pluginVersion: receipt.version, packageSha256: receipt.sha256,
      installedFilesVerified: receipt.sourceHashes.length, configurationUnchanged: true,
      programCacheUnchanged: true, programSource: 'private-cache', fileKeyEditable: true,
      searchPassed: true, fetchPassed: true, chatPassed: true, originalSearchDelta: 0,
      controlRevision: ready.productControl.revision });
    writeJson(join(directory, runtime.app.version + '-' + phase + '.json'), safe(stages.at(-1)));
  };
  const restart = async phase => {
    const exit = await close(host);
    assert.equal(exit.exitCode, 0); assert.equal(exit.forced, false);
    host = await start(runtime, folder, phase);
  };
  try {
    host = await start(runtime, folder, 'upgrade-old-install');
    const oldInstall = await upgradeUiAction(host, 'install',
      upgradeOldRegistry ? `${PRODUCT_BUNDLE}@${oldProductReceipt.version}` : upgradeFrom, oldProductReceipt.version);
    await pluginManagerRendererSnapshot(host);
    await settingsStopRendererFlow(host, 'upgrade-old');
    await firstUseConfigure(host, stub);
    const beforeSave = await sourceSettingsRpc(host, 'snapshot');
    await sourceSettingsRpc(host, 'save', { expectedRevision: beforeSave.config.revision,
      updates: { grok_model: 'isolated-upgrade-model', source_providers: ['firecrawl', 'tavily', 'exa', 'tinyfish'],
        default_extra_sources: 3, tavily_api_key: stub.key, tavily_api_url: stub.origin + '/tavily',
        exa_api_key: stub.key, exa_api_url: stub.origin + '/exa',
        tinyfish_api_key: stub.key, tinyfish_search_api_url: stub.origin + '/tinyfish',
        firecrawl_api_key: stub.key, firecrawl_api_url: stub.origin + '/firecrawl' } });
    const preference = await sourceSettingsRpc(host, 'preferences');
    await sourceSettingsRpc(host, 'savePreferences', { expectedRevision: preference.revision,
      value: { ...preference.value, githubEnabled: false } });
    expected = preserved();
    recordsBefore = fileTree(join(profile, 'control-intent.records')).filter(row => /revision|\.json$/.test(row.file));
    await verify(oldProductReceipt, 'old-configured');
    await restart('upgrade-old-restart');
    await verify(oldProductReceipt, 'old-restarted');

    let removed = null, failed = null, recovery = null, newInstall = null, rollback = null;
    if (!upgradeInPlaceOnly) {
      removed = await upgradeUiAction(host, 'remove');
      assert.deepEqual(preserved(), expected, 'Native uninstall must keep user data.');
      const failedPackage = join(folder, 'deliberately-invalid-upgrade.tgz');
      writeFileSync(failedPackage, 'intentionally invalid isolated package', { flag: 'wx' });
      const manifestBefore = sha256(join(profile, 'package.json'));
      const lockBefore = sha256(join(profile, 'pnpm-lock.yaml'));
      failed = await installBundle(host, failedPackage, PRODUCT_BUNDLE);
      assert.ok(failed.error, 'The deliberately invalid archive must fail.');
      assert.equal(sha256(join(profile, 'package.json')), manifestBefore);
      assert.equal(sha256(join(profile, 'pnpm-lock.yaml')), lockBefore);
      assert.deepEqual(preserved(), expected);
      writeJson(join(directory, runtime.app.version + '-expected-install-failure.json'), safe(failed));
      recovery = await upgradeUiAction(host, 'install', upgradeFrom, oldProductReceipt.version);
      await restart('upgrade-recover-old');
      await verify(oldProductReceipt, 'old-recovered-after-install-failure');

      await upgradeUiAction(host, 'remove');
      newInstall = await upgradeUiAction(host, 'install', productTarball, expectedProductReceipt.version);
      await restart('upgrade-new-restart');
      await verify(expectedProductReceipt, 'new-restarted');
      // Reinstall the released package; do not erase data to force recovery.
      await upgradeUiAction(host, 'remove');
      rollback = await upgradeUiAction(host, 'install', upgradeFrom, oldProductReceipt.version);
      await restart('upgrade-rollback-restart');
      await verify(oldProductReceipt, 'rollback-restarted');
    }
    // Assess the narrower tarball branch separately. It is not a promise that
    // the GUI supports updating an installed registry name or directory.
    const inPlace = await upgradeUiAction(host, 'install', productTarball, expectedProductReceipt.version);
    writeJson(join(directory, runtime.app.version + '-tarball-in-place-result.json'), safe(inPlace));
    await restart('upgrade-tarball-in-place-restart');
    await verify(expectedProductReceipt, 'tarball-in-place-restarted');
    const exit = await close(host);
    assert.equal(exit.exitCode, 0); assert.equal(exit.forced, false);
    assert.deepEqual(await matchingFirstUseProcesses(cache.target), []);
    assert.equal(sha256(join(upgradeCache, 'active.json')), cache.sourceActiveHash);
    assert.equal(readdirSync(cache.cache).filter(name => lstatSync(join(cache.cache, name)).isDirectory()).length, 1);
    return { stages, oldInstall, removed, failedInstallCode: failed?.error.code ?? null, recovery, newInstall, rollback,
      inPlaceTarball: { accepted: true, nativeServiceCalled: true,
        uiWorkflowTested: true, restarted: true }, inPlaceOnly: upgradeInPlaceOnly,
      oldPackageSource: upgradeOldRegistry ? 'registry-exact-version' : 'local-release-tarball',
      exit, uiDomValidated: true, nativeUpgradeUiValidated: true, configurationUnchanged: true,
      retainedCacheFixture: cache.setup, cacheSha256: cache.binaryHash, cacheReused: true,
      mcpHandshake: cache.handshake, programOverrideRequired: false, configOverrideRequired: false,
      noNewProgramCacheDirectory: true, fileCredentialsRetained: syntheticFields,
      rollbackScope: 'explicit-reinstall-of-old-package-not-cross-resource-atomicity',
      credentialScope: 'synthetic-loopback-only', requests: stub.requests };
  } finally {
    if (host) await close(host);
    await stub.close();
  }
}

async function runVersion(runtime) {
  currentVersion = runtime.app.version;
  const folder = join(temporary, runtime.app.version);
  await prepare(runtime, folder);
  const profile = join(folder, 'dsh-home/profiles/desktop');
  const initialPackage = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  assert.equal(initialPackage.dependencies[PRODUCT_BUNDLE], undefined);
  assert.ok(!initialPackage.dsh.profile.bundles.includes(PRODUCT_BUNDLE));

  const first = await start(runtime, folder, 'manager-install');
  const initialUi = await rendererSnapshot(first);
  writeJson(join(directory, runtime.app.version + '-plugin-manager-initial-ui.json'), safe(initialUi));
  const initialManager = await first.probe('plugin-manager-state');
  assert.ok(!managerNames(initialManager).includes(PRODUCT_BUNDLE));

  const productInstall = await installBundle(first, productTarball, PRODUCT_BUNDLE);
  assertManagerApplied(productInstall, PRODUCT_BUNDLE);
  assert.equal(productInstall.bundle, PRODUCT_BUNDLE);
  const afterProductManager = await first.probe('plugin-manager-state');
  assert.ok(managerNames(afterProductManager).includes(PRODUCT_BUNDLE));
  assert.equal(afterProductManager.bundles.find(bundle => bundle.name === PRODUCT_BUNDLE).enabled, true);
  const hotInstalled = await waitFor(first, state => state.productControl?.phase === 'required'
    && state.runtimeWeb.searchProviderId === 'grok-search', 'Hot installation did not take over before restart');
  const hotInstalledUi = await pluginManagerRendererSnapshot(first);
  const hotSettings = await settingsStopRendererFlow(first, 'hot-install');
  const settingsSecurity = await settingsRpcSecurityFlow(first);
  const settingsDialogs = await settingsDialogRendererFlow(first);
  const firstExit = await close(first);
  assert.equal(firstExit.exitCode, 0);
  assert.equal(firstExit.forced, false);

  const productHost = await start(runtime, folder, 'manager-product-startup');
  const productReady = await waitFor(productHost, snapshot => snapshot.productControl?.phase === 'required'
    && snapshot.productRecovery?.phase === 'still-selected' && snapshot.productRouteVerifier,
  'Product control and recovery entries did not load after PluginManager install and restart');
  const before = productReady.productControl.recordEnvelope;
  assert.equal(before.intent.policy, 'required');
  assert.equal(productReady.productRecovery.phase, 'still-selected');
  assert.equal(productReady.runtimeWeb.searchProviderId, 'grok-search');

  const installedBaseUi = await rendererSnapshot(productHost);
  writeJson(join(directory, runtime.app.version + '-plugin-manager-installed-base-ui.json'), safe(installedBaseUi));
  const installedUi = await pluginManagerRendererSnapshot(productHost);
  writeJson(join(directory, runtime.app.version + '-plugin-manager-installed-ui.json'), safe(installedUi));
  assert.match(installedUi.list.text, /已安装/);
  assert.match(installedUi.list.text, /dsh-grok-search/);
  assert.ok(installedUi.detail.text.includes(expectedProductReceipt.version),
    'PluginManager must display the frozen package version.');
  assert.match(installedUi.detail.text, /用 Grok 接管 DSH 网页搜索/);

  // D-29: native hot disable restores the route, and explicit re-enable reacquires.
  const settingsStop = await settingsStopRendererFlow(productHost, 'restart');
  writeJson(join(directory, runtime.app.version + '-settings-stop-ui.json'), safe(settingsStop));
  assert.equal(settingsStop.buttonFound, false);

  // Test-only observation of the owner's own release promise; it passes the
  // product promise through unchanged and records only codes and receipts.
  await productHost.probe('observe-product-release');
  const disabled = await setBundleEnabled(productHost, PRODUCT_BUNDLE, false);
  assertManagerApplied(disabled, PRODUCT_BUNDLE);
  // The user-visible contract is the route; the durable completion receipt is
  // written by the unloading owner and is checked separately with a deadline.
  const restoredNow = await productHost.probe('snapshot');
  assert.equal(restoredNow.runtimeWeb.searchProviderId, 'candidate-original');
  assert.equal(restoredNow.runtimeWeb.fetchProviderId, 'candidate-fetch');
  let stoppedSnapshot;
  try {
    stoppedSnapshot = await waitFor(productHost, state => state.recordEnvelope?.intent?.releaseCompletion,
      'Native disable did not write a release completion receipt', 15000);
  } catch (error) {
    writeJson(join(directory, runtime.app.version + '-native-disable-completion-failure.json'), safe({
      error: error.message, restoredNow: { runtimeWeb: restoredNow.runtimeWeb, hostLogs: restoredNow.hostLogs },
      final: await productHost.probe('snapshot').then(state => ({ record: state.recordEnvelope,
        productReleaseObservations: state.productReleaseObservations,
        hostLogs: state.hostLogs, entries: state.entries.filter(row => row.error || /grok/.test(row.id)) })),
    }));
    throw error;
  }
  writeJson(join(directory, runtime.app.version + '-native-disable-release-observation.json'),
    safe(stoppedSnapshot.productReleaseObservations ?? null));
  const stoppedRecord = stoppedSnapshot.recordEnvelope;
  assert.equal(stoppedRecord.intent.policy, 'released');
  assert.equal(stoppedRecord.intent.release.explicit, true);
  // Native PluginManager disable is the only user-facing release action. The
  // owner writes completion while the bundle leaves; the settings page itself
  // deliberately has no separate stop button.
  assert.equal(stoppedRecord.intent.releaseCompletion.recordCommit.kind, 'explicit-release-completion');
  assert.equal(stoppedRecord.intent.recovery, undefined);
  assert.equal(stoppedRecord.intent.releaseCompletion.routeVerified, true);
  assert.equal(stoppedRecord.intent.releaseCompletion.routeEvidence.originalSearchDelta, 0);
  assert.equal(stoppedSnapshot.runtimeWeb.searchProviderId, 'candidate-original');
  const productExit = await close(productHost);
  assert.equal(productExit.exitCode, 0);
  assert.equal(productExit.forced, false);

  const releasedHost = await start(runtime, folder, 'manager-released-startup');
  const releasedState = await releasedHost.probe('snapshot');
  assert.equal(releasedState.productControl, null);
  assert.equal(releasedState.productRecovery, null);
  assert.equal(releasedState.productRouteVerifier, null);
  assert.deepEqual(releasedState.recordEnvelope, stoppedRecord);
  assert.equal(releasedState.runtimeWeb.searchProviderId, 'candidate-original');
  const enabled = await setBundleEnabled(releasedHost, PRODUCT_BUNDLE, true);
  assertManagerApplied(enabled, PRODUCT_BUNDLE);
  const hotReenabled = await waitFor(releasedHost, state => state.productControl?.phase === 'required'
    && state.runtimeWeb.searchProviderId === 'grok-search', 'Hot re-enable did not take over before restart');
  const releasedExit = await close(releasedHost);
  assert.equal(releasedExit.exitCode, 0);
  assert.equal(releasedExit.forced, false);

  const revivedHost = await start(runtime, folder, 'manager-revive-startup');
  const revived = await waitFor(revivedHost, snapshot => snapshot.productControl?.phase === 'required',
    'Product control did not reload after re-enabling the bundle');
  assert.equal(revived.productControl.phase, 'required');
  assert.equal(revived.recordEnvelope.intent.policy, 'required');
  assert.notDeepEqual(revived.recordEnvelope, stoppedRecord);
  assert.equal(revived.runtimeWeb.searchProviderId, 'grok-search');
  assert.equal(revived.runtimeWeb.fetchProviderId, 'candidate-fetch');
  const revivedFetch = await modelTurn(revivedHost, 'fetch');
  const revivedChat = await modelTurn(revivedHost, 'chat');
  assert.equal(revivedFetch.isError, false);
  assert.equal(revivedChat.isError, false);
  const disabledAgain = await setBundleEnabled(revivedHost, PRODUCT_BUNDLE, false);
  assertManagerApplied(disabledAgain, PRODUCT_BUNDLE);
  const stoppedAgain = (await revivedHost.probe('snapshot')).recordEnvelope;
  assert.equal(stoppedAgain.intent.policy, 'released');
  assert.equal(stoppedAgain.intent.releaseCompletion.routeVerified, true);
  assert.equal(stoppedAgain.intent.releaseCompletion.routeEvidence.originalSearchDelta, 0);
  const revivedExit = await close(revivedHost);
  assert.equal(revivedExit.exitCode, 0);
  assert.equal(revivedExit.forced, false);

  const cleanupHost = await start(runtime, folder, 'manager-cleanup-startup');
  const cleanupInitial = await cleanupHost.probe('snapshot');
  assert.equal(cleanupInitial.productControl, null);
  assert.equal(cleanupInitial.productRecovery, null);
  assert.equal(cleanupInitial.productRouteVerifier, null);
  const cleanupManager = await cleanupHost.probe('plugin-manager-state');
  assert.equal(cleanupManager.bundles.find(bundle => bundle.name === PRODUCT_BUNDLE).enabled, false);

  const productRemove = await removeBundle(cleanupHost, PRODUCT_BUNDLE);
  assertManagerApplied(productRemove, PRODUCT_BUNDLE);
  const cleanedManager = await cleanupHost.probe('plugin-manager-state');
  assert.ok(!managerNames(cleanedManager).includes(PRODUCT_BUNDLE));
  const cleanedPackage = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  assert.equal(cleanedPackage.dependencies[PRODUCT_BUNDLE], undefined);
  assert.deepEqual(cleanedPackage.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'candidate-offline-fixture']);
  const cleaned = await cleanupHost.probe('snapshot');
  assert.deepEqual(cleaned.recordEnvelope, stoppedAgain);
  assert.equal(cleaned.runtimeWeb.searchProviderId, 'candidate-original');
  assert.equal(cleaned.runtimeWeb.fetchProviderId, 'candidate-fetch');
  assert.equal(cleaned.existingDependencyPresent, true);
  assert.ok(Object.hasOwn(cleaned.webInject, 'candidateExistingDependency'));
  const authorSearch = await modelTurn(cleanupHost, 'search');
  const fetch = await modelTurn(cleanupHost, 'fetch');
  const chat = await modelTurn(cleanupHost, 'chat');
  assert.equal(authorSearch.isError, false);
  assert.ok(authorSearch.afterCalls.original > authorSearch.beforeCalls.original);
  assert.equal(fetch.isError, false);
  assert.equal(chat.isError, false);
  const cleanupExit = await close(cleanupHost);
  assert.equal(cleanupExit.exitCode, 0);
  assert.equal(cleanupExit.forced, false);

  const finalHost = await start(runtime, folder, 'manager-final-restart');
  const restarted = await finalHost.probe('snapshot');
  assert.equal(restarted.pluginManagerPresent, true);
  assert.equal(restarted.productControl, null);
  assert.equal(restarted.productRecovery, null);
  assert.equal(restarted.productRouteVerifier, null);
  assert.deepEqual(restarted.recordEnvelope, stoppedAgain);
  assert.equal(restarted.runtimeWeb.searchProviderId, 'candidate-original');
  assert.equal(restarted.runtimeWeb.fetchProviderId, 'candidate-fetch');
  assert.equal(restarted.existingDependencyPresent, true);
  const restartSearch = await modelTurn(finalHost, 'search');
  const restartFetch = await modelTurn(finalHost, 'fetch');
  const restartChat = await modelTurn(finalHost, 'chat');
  assert.equal(restartSearch.isError, false);
  assert.ok(restartSearch.afterCalls.original > restartSearch.beforeCalls.original);
  assert.equal(restartFetch.isError, false);
  assert.equal(restartChat.isError, false);
  const finalExit = await close(finalHost);
  assert.equal(finalExit.exitCode, 0);
  assert.equal(finalExit.forced, false);

  return { initialManager, productInstall, hotInstalled, hotInstalledUi, hotSettings, hotReenabled, settingsSecurity, settingsDialogs,
    firstExit, before, settingsStop, stoppedRecord, productExit,
    releasedState, enabled, revived, revivedFetch, revivedChat, disabledAgain, stoppedAgain, revivedExit,
    uiDomValidated: true, productRemove, cleanedManager, cleaned, authorSearch, fetch, chat, cleanupExit,
    restarted, restartSearch, restartFetch, restartChat, finalExit };
}

let fatal = null;
const associationBefore = await protocolAssociation();
if (associationBefore && associationBefore.exitCode !== 0) throw new Error('Cannot verify dsh:// association before Desktop run.');
const beforeHashes = Object.fromEntries(runtimes.map(runtime => [runtime.app.version,
  { executable: sha256(runtime.executable), asar: sha256(runtime.archivePath) }]));
try {
  for (const runtime of runtimes) {
    const evidence = await (upgradeFrom ? runUpgrade(runtime) : manualAcceptance ? holdManualAcceptance(runtime)
      : sourceOnlyConfig ? runSourceOnly(runtime) : firstUse ? runFirstUse(runtime) : runVersion(runtime));
    results.push({ version: runtime.app.version, scenario: upgradeFrom ? 'released-package-upgrade-rollback-config-cache-retention'
      : manualAcceptance ? 'manual-isolated-environment-preparation'
      : firstUse
      ? 'first-use-native-install-auto-download-default-config-save-search-hot-toggle-reuse'
      : sourceOnlyConfig ? 'source-only-native-install-search-hot-toggle'
      : 'official-plugin-manager-install-enable-disable-remove-restart',
      status: 'pass', evidence });
  }
} catch (error) {
  fatal = { version: currentVersion, message: error.message, stack: error.stack };
    results.push({ version: currentVersion, scenario: upgradeFrom ? 'released-package-upgrade-rollback-config-cache-retention'
      : firstUse ? 'first-use-auto-download'
    : 'official-plugin-manager-install-enable-disable-remove-restart',
    status: 'fail', error: { message: error.message } });
} finally {
  for (const child of children) await close(child);
  const afterHashes = Object.fromEntries(runtimes.map(runtime => [runtime.app.version,
    { executable: sha256(runtime.executable), asar: sha256(runtime.archivePath) }]));
  const unchanged = JSON.stringify(beforeHashes) === JSON.stringify(afterHashes);
  const associationAfter = await protocolAssociation();
  const protocolUnchanged = associationBefore === null || associationAfter?.exitCode === 0
    && associationBefore.rawStdout === associationAfter.rawStdout;
  const sourcesUnchanged = sourceHashesBefore.every(row => sha256(join(project, row.file)) === row.sha256);
  if (!sourcesUnchanged) fatal ??= { message: 'Source changed during verification; not a current-source gate.' };
  const passed = !fatal && unchanged && protocolUnchanged;
  const summary = {
    runId, status: passed ? 'pass' : 'fail',
    counts: { pass: results.filter(row => row.status === 'pass').length,
      fail: results.filter(row => row.status === 'fail').length + (unchanged ? 0 : 1) + (protocolUnchanged ? 0 : 1) },
    fatal: fatal ? safe(fatal) : null,
    scope: process.platform === 'win32'
      ? 'official-Desktop-default-app-original-ASAR-with-official-PluginManager-service'
      : 'actual-packaged-official-Desktop-with-official-PluginManager-service',
    packagedDesktopStartupValidated: passed && process.platform !== 'win32',
    originalDesktopRuntimeValidated: passed,
    pluginManagerValidated: passed,
    pluginManagerUiDomValidated: passed && results.length === runtimes.length
      && results.every(row => firstUse ? row.evidence?.configured?.savedThroughProductionDialog === true
        : row.evidence?.uiDomValidated === true),
    firstUseAutoDownloadValidated: passed && firstUse,
    upgradeRetentionValidated: passed && Boolean(upgradeFrom),
    upgradeFailureRecoveryValidated: passed && Boolean(upgradeFrom) && !upgradeInPlaceOnly,
    productionDiagnosticsUiValidated: passed && diagnostics && results.length === runtimes.length
      && results.every(row => row.evidence?.diagnosticFlow?.failed === 0),
    realProviderCredentialsValidated: passed && Boolean(sourceOnlyConfig) && !manualAcceptance,
    realGrokPrimaryValidated: false,
    realGrokPaidTestDeferredByUser: Boolean(sourceOnlyConfig),
    userAcceptancePassed: false,
    manualAcceptanceEnvironment: manualAcceptance,
    sourceOnlyConfigurationUnchanged: sourceOnlyConfig ? sha256(sourceOnlyConfig) === sourceConfigBefore : null,
    globalInstallationChanged: false,
    desktopUiDomValidated: false,
    cleanupValidated: passed,
    releaseTransactionDesktopValidated: false,
    releaseControllerWired: false,
    routeCounterAdapter: 'fixture-and-canonical-session-event',
    realHostCounterAdapterValidated: false,
    officialCounterContractFound: runtimes.some(runtime => auditCounterSource(runtime).officialCounterContractFound),
    productIntegrated: false,
    hostCounterAudit: runtimes.map(auditCounterSource),
    packageReceipts: { product: packageReceipt(productTarball), ...(oldProductReceipt ? { oldProduct: oldProductReceipt } : {}) },
    results: results.map(({ version, scenario, status, evidence, error }) => ({ version, scenario, status,
      ...(evidence ? { evidence } : {}), ...(error ? { error } : {}) })),
    originalHashes: { before: beforeHashes, after: afterHashes, unchanged },
    protocolAssociationUnchanged: protocolUnchanged,
    sourceHashes: sourceHashesBefore,
    sourcesUnchanged,
    exits: children.map(row => ({ prefix: row.prefix, exitCode: row.exitCode, signal: row.signal,
      forced: row.forced ?? false })),
  };
  writeJson(join(directory, 'summary.json'), safe(summary));
  console.log(JSON.stringify(safe({ runId, status: summary.status, counts: summary.counts, fatal,
    sourcesUnchanged, protocolAssociationUnchanged: protocolUnchanged,
    firstUseAutoDownloadValidated: summary.firstUseAutoDownloadValidated,
    evidence: join(directory, 'summary.json') }), null, 2));
  process.exitCode = passed ? 0 : 1;
}
