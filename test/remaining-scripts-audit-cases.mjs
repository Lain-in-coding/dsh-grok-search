import test from 'node:test';
import './delivery-tooling-cases.mjs';
import './private-ci-tooling-cases.mjs';
import './npm-trusted-publish-cases.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import semver from 'semver';
import { cleanEnvironment } from '../scripts/lib/internal-candidate-utils.mjs';
import { desktopWorkspacePatch, prepareDesktopAcceptanceEnvironment } from '../scripts/lib/desktop-acceptance-environment.mjs';
import { readUpgradePackage } from '../scripts/verify-search-log-upgrade.mjs';

const source = name => readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
const section = (text, start, end) => {
  const first = text.indexOf(start), last = text.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'The audited code boundary must still exist.');
  return text.slice(first, last);
};

test('B2 Desktop launch drops inherited credentials and redirects the process home', () => {
  const text = source('b2-control-desktop.mjs');
  const body = section(text, '  const env=', '  const prefix=');
  const folder = mkdtempSync(join(tmpdir(), 'dsh-remaining-script-environment-'));
  const parent = {
    HOME: 'synthetic-production-home', USERPROFILE: 'synthetic-production-home',
    GROK_SEARCH_API_KEY: 'synthetic-primary-key', TAVILY_API_KEY: 'synthetic-source-key',
    DSH_UNRELATED_SECRET: 'synthetic-private-value', NODE_OPTIONS: '--require=untrusted-preload',
  };
  const env = runInNewContext(body + '\nenv;', {
    process: { platform: process.platform, env: parent }, cleanEnvironment, join,
    mkdirSync() { throw new Error('Home setup belongs to cleanEnvironment.'); },
    control: { dshHome: join(folder, 'dsh-home'), runtime: 'fixture-runtime',
      primaryRuntime: 'fixture-primary', pnpmEntry: 'fixture-pnpm', token: 'fixture-token' },
    folder, hostInspectPort: 12345, addressPath: 'fixture-address', versioned: true,
    productCounter: true, verificationCase: 'm0-04', runtime: { app: { version: '0.2.1-rc.3' } }, fault: null,
  });
  assert.equal(env.HOME, join(folder, 'user'));
  assert.equal(env.USERPROFILE, join(folder, 'user'));
  for (const name of ['GROK_SEARCH_API_KEY', 'TAVILY_API_KEY', 'DSH_UNRELATED_SECRET']) {
    assert.equal(Object.hasOwn(env, name), false, `${name} must not enter the fixture`);
  }
  assert.equal(env.DSH_HOME, join(folder, 'dsh-home'));
  assert.equal(parent.HOME, 'synthetic-production-home');
});

test('market adapter sees only isolated environment and restores the parent on success or failure', async () => {
  const text = source('verify-market-install.mjs');
  const setup = section(text, '      const previous =', '        const { createOfficialDesktopRuntime }');
  const restore = section(text, '      } finally {\n        for (const key', '\n    } else outcome');
  for (const fails of [false, true]) {
    const parent = { HOME: 'synthetic-parent-home', GROK_SEARCH_API_KEY: 'synthetic-parent-key',
      TAVILY_API_KEY: 'synthetic-tavily-key', NODE_OPTIONS: '--require=synthetic-preload' };
    const before = { ...parent };
    const isolated = { HOME: 'synthetic-isolated-home', DSH_HOME: 'synthetic-isolated-profile' };
    const failure = new Error('synthetic-adapter-failure');
    const run = runInNewContext(`(async () => { ${setup} await observe(); ${restore} })()`, {
      process: { env: parent }, env: isolated,
      async observe() {
        assert.deepEqual(parent, isolated);
        parent.ADAPTER_TEMP = 'synthetic-created-value';
        await Promise.resolve();
        if (fails) throw failure;
      },
    });
    if (fails) await assert.rejects(run, error => error === failure);
    else await run;
    assert.deepEqual(parent, before);
  }
});

test('market tools isolate native Documents before preparing their child environment', () => {
  for (const script of ['verify-market-install.mjs', 'verify-market-desktop-ui.mjs']) {
    const folder = mkdtempSync(join(tmpdir(), 'dsh-deferred-desktop-market-environment-'));
    const control = { profile: join(folder, 'dsh-home', 'profiles', 'desktop') };
    mkdirSync(control.profile, { recursive: true });
    const text = source(script);
    const begin = text.indexOf("writeFileSync(join(control.profile, 'cordis.patch.yml'),");
    const end = text.indexOf(';', begin);
    assert.ok(begin >= 0 && end > begin);
    runInNewContext(text.slice(begin, end + 1), { writeFileSync, join, control, folder, desktopWorkspacePatch });
    const patch = JSON.parse(readFileSync(join(control.profile, 'cordis.patch.yml'), 'utf8'));
    assert.equal(patch.find(row => row.id === 'workspace-controller')?.config.documentsDirectory,
      join(realpathSync(folder), 'user', 'Documents'));
    const { env, paths } = prepareDesktopAcceptanceEnvironment(folder);
    assert.equal(env.HOME, paths.home);
    assert.equal(env.DSH_HOME, paths.dshHome);
    assert.equal(Object.hasOwn(env, 'GROK_SEARCH_API_KEY'), false);
    assert.ok(text.includes('const { env } = prepareDesktopAcceptanceEnvironment(folder,'));
  }
});

test('market install cleanup records every abnormal exit and stays bounded without a renderer', async () => {
  const text = source('verify-market-install.mjs');
  const begin = text.indexOf('  } finally {', text.indexOf('  } catch (error) {\n    results.push'));
  const end = text.indexOf('\n  }\n}', begin);
  assert.ok(begin >= 0 && end > begin);
  const body = text.slice(begin + '  } finally {'.length, end);
  for (const mode of ['normal', 'nonzero', 'signal', 'renderer-error', 'cdp-error', 'unreaped', 'spawn-error']) {
    const stopped = [], results = [{ mode, error: 'synthetic primary install failure' }];
    const context = {
      child: { kill() {} }, closed: mode === 'unreaped' ? new Promise(() => {}) : Promise.resolve(),
      ended: ['nonzero', 'signal', 'spawn-error'].includes(mode), exitCode: mode === 'nonzero' ? 17 : mode === 'signal' ? null : 0,
      signal: mode === 'signal' ? 'SIGKILL' : null, forced: false,
      spawnError: mode === 'spawn-error' ? new Error('synthetic spawn failure') : null,
      renderer: mode === 'cdp-error' ? null : { close() { if (mode === 'renderer-error') throw new Error('synthetic renderer close failure'); } },
      port: 12345, folder: 'fixture-folder', mode, results, process: { exitCode: 0 },
      async requestDesktopShutdown() {
        if (['cdp-error', 'unreaped'].includes(mode)) throw new Error('synthetic CDP failure');
        context.ended = true;
      },
      async stopPreviewService(service) {
        stopped.push(service.child);
        if (mode === 'unreaped') throw new Error('synthetic bounded cleanup failure');
        context.ended = true; context.exitCode = null; context.signal = 'SIGTERM';
      },
    };
    let timer;
    try {
      await Promise.race([runInNewContext(`(async () => { ${body} })()`, context),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup waited without a bound.')), 250); })]);
    } finally { clearTimeout(timer); }
    assert.equal(results[0].error, 'synthetic primary install failure');
    assert.ok(results[0].process, 'Host shutdown must be part of the receipt.');
    assert.equal(results[0].process.ended, mode !== 'unreaped');
    assert.equal(results[0].process.exitCode, context.exitCode);
    assert.equal(results[0].process.errors.length === 0, mode === 'normal');
    assert.equal(context.process.exitCode, mode === 'normal' ? 0 : 1);
    assert.equal(stopped.length, ['cdp-error', 'unreaped'].includes(mode) ? 1 : 0);
  }
});

test('market install preserves measured results when final host integrity fails', () => {
  const text = source('verify-market-install.mjs');
  const begin = text.indexOf('let originalProgramUnchanged = false, integrityError = null;');
  assert.ok(begin >= 0);
  for (const mode of ['normal', 'changed', 'unreadable']) {
    const written = [], measurements = [{ mode: 'fixture', installedVersion: '0.2.0' }];
    const context = {
      runtime: { executable: 'fixture-runtime', archivePath: 'fixture-asar' },
      before: ['fixture-hash', 'fixture-hash'], root: 'fixture-root', results: measurements,
      run: { runId: 'fixture', directory: 'fixture-evidence' }, join, assert, process: { exitCode: 0 },
      sha256(path) {
        if (mode === 'unreadable') throw new Error('synthetic unreadable host');
        return mode === 'changed' && path === 'fixture-runtime' ? 'changed-hash' : 'fixture-hash';
      },
      writeJson(path, value) { written.push(value); }, console: { log() {} },
    };
    runInNewContext(text.slice(begin), context);
    assert.equal(written.length, 1);
    assert.equal(written[0].results, measurements);
    assert.equal(written[0].originalProgramUnchanged, mode === 'normal');
    assert.equal(Boolean(written[0].integrityError), mode !== 'normal');
    assert.equal(context.process.exitCode, mode === 'normal' ? 0 : 1);
  }
});

test('product install evidence never includes the child environment or proxy credentials', () => {
  const body = section(source('b2-product-install.mjs'), '  return { firstReady,', '\n}');
  const values = Object.fromEntries([
    'firstReady', 'before', 'secondReady', 'disabledState', 'disabledRecord',
    'author', 'thirdReady', 'after', 'final',
  ].map(name => [name, {}]));
  const credential = 'synthetic-private-proxy-password';
  values.installed = {
    profile: 'fixture-profile',
    env: { HTTPS_PROXY: `http://fixture-user:${credential}@127.0.0.1:9` },
    installed: [{ name: 'dsh-grok-search', version: '0.4.0' }],
    productReceipt: { sha256: 'a'.repeat(64) }, installExitCode: 0,
    installPolicy: { ignoreScripts: true, legacyPeerDeps: false },
  };
  const result = runInNewContext(`(function () { ${body} })()`, values);
  assert.equal(Object.hasOwn(result.install, 'env'), false);
  assert.equal(JSON.stringify(result).includes(credential), false);
  assert.equal(result.install.installExitCode, 0);
  assert.equal(result.install.productReceipt.sha256, 'a'.repeat(64));
  assert.deepEqual(result.install.installPolicy, values.installed.installPolicy);
});

test('product installation cannot accept an abnormal host exit after its close reply', async () => {
  const body = section(source('b2-product-install.mjs'), 'function startHost(', '\nfunction packageReceipt(');
  for (const code of [0, 17, null]) {
    const child = new EventEmitter();
    Object.assign(child, {
      stdout: new EventEmitter(), stderr: new EventEmitter(), connected: true,
      send(message) {
        if (message.op !== 'close') return;
        queueMicrotask(() => {
          child.emit('message', { type: 'reply', id: message.id, ok: true, value: true });
          child.emit('close', code, code === null ? 'SIGKILL' : null);
        });
      },
      kill() { throw new Error('This fixture already acknowledges close.'); },
    });
    const start = runInNewContext(body + '\nstartHost;', {
      spawn: () => child, join, project: 'fixture-project', root: 'fixture-root',
      hosts: [], sequence: 0, setTimeout, clearTimeout, assert,
    });
    const host = start({ app: { version: '0.2.1-rc.3' }, executable: 'fixture-runtime',
      archivePath: 'fixture-asar' }, 'fixture-profile', {}, {});
    if (code === 0) await host.close();
    else await assert.rejects(host.close(), /exit/i);
  }
});

test('search log evidence rejects an already-closed abnormal host', async () => {
  const body = section(source('verify-search-log-host.mjs'), '  const host = {', '  children.push(host);');
  for (const code of [0, 17, null]) {
    const host = runInNewContext(body + '\nhost;', {
      child: {}, closed: Promise.resolve(code), ended: true, stderr: '',
      pending: new Map(), serial: 0, setTimeout, clearTimeout, assert, sanitize: value => value,
    });
    if (code === 0) assert.equal(await host.close(), '');
    else await assert.rejects(host.close(), /exit/i);
  }
});

test('control host close rejects nonzero, killed, timed-out or missing exit without leaving timers', async () => {
  const body = section(source('b2-control-host.mjs'), 'function start(', '\nfunction storeAt(');
  for (const mode of ['normal', 'nonzero', 'signal', 'missing-exit', 'timeout', 'unreaped']) {
    const child = new EventEmitter();
    const timers = new Set();
    const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms >= 5000 && ms < 60000 ? 1 : ms); timers.add(timer); return timer; };
    const clear = timer => { timers.delete(timer); clearTimeout(timer); };
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(),
      send(message) {
        if (message.op !== 'close' || mode === 'timeout') return;
        queueMicrotask(() => {
          child.emit('message', { type: 'reply', id: message.id, ok: true, value: true });
          if (!['missing-exit', 'unreaped'].includes(mode)) child.emit('close', mode === 'nonzero' ? 17 : mode === 'signal' ? null : 0,
            mode === 'signal' ? 'SIGKILL' : null);
        });
      },
      kill(signal) { if (mode !== 'unreaped') queueMicrotask(() => child.emit('close', null, signal)); return true; },
    });
    const start = runInNewContext(body + '\nstart;', {
      spawn: () => child, mkdirSync() {}, cleanEnvironment: () => ({}), sanitize: value => value,
      join, project: 'fixture-project', hosts: [], sequence: 0, setTimeout: later, clearTimeout: clear, assert,
    });
    const host = start({ executable: 'fixture-runtime', archivePath: 'fixture-asar' }, 'fixture-profile', false);
    if (mode === 'normal') await host.close();
    else await assert.rejects(host.close(), /exit|abnormal/i);
    assert.equal(host.state.stopped, mode !== 'unreaped');
    assert.equal(timers.size, 0, 'Every owned timer must be cleared after exit.');
  }
});

test('control host final evidence preserves cleanup failure while closing every owned host', async () => {
  const text = source('b2-control-host.mjs');
  const begin = text.lastIndexOf('finally {\n  for (const host of hosts)');
  assert.ok(begin >= 0);
  const body = text.slice(begin + 'finally {'.length, text.lastIndexOf('\n}'));
  let closes = 0;
  const written = [];
  const context = { hosts: [0, 17].map(exitCode => ({
    state: { exitCode, closed: Promise.resolve(), pending: new Map() },
    async close() { closes++; if (exitCode !== 0) throw new Error('synthetic abnormal exit'); },
  })), fatal: null, results: [{ status: 'pass', version: 'fixture', scenario: 'fixture' }],
  directory: 'fixture-evidence', runId: 'fixture-run', project: 'fixture-project', join, safe: value => value,
  sha256: () => 'fixture-hash', writeJson: (path, value) => written.push({ path, value }),
  console: { log() {} }, process: { exitCode: 0 },
  };
  await runInNewContext(`(async () => { ${body} })()`, context);
  assert.equal(closes, 2);
  assert.equal(written.length, 3);
  assert.equal(written.at(-1).value.status, 'fail');
  assert.equal(context.process.exitCode, 1);
  assert.equal(written.at(-1).value.fatal.message, 'synthetic abnormal exit');
});

test('market UI cleanup reaps its child even without a renderer and records abnormal shutdown', async () => {
  const body = section(source('verify-market-desktop-ui.mjs'), 'async function finish() {', '\nconst server =');
  for (const mode of ['normal', 'cdp-failure', 'unreaped']) {
    const original = { message: 'synthetic connection failure' };
    const child = {};
    const written = [], stopped = [];
    const context = { finalizing: false, renderer: null, child, ended: false, exitCode: undefined, signal: null,
      error: original, forced: false, closed: Promise.resolve(0), folder: 'fixture-folder',
      control: { port: 12345, pnpmEntry: 'fixture-pnpm' }, runtime: { app: { version: 'fixture' }, executable: 'fixture-runtime', archivePath: 'fixture-asar' },
      before: ['fixture-hash', 'fixture-hash', 'fixture-hash'], run: { runId: 'fixture', directory: 'fixture-evidence' },
      productReceipt: { sha256: 'fixture-product' }, marketTar: 'fixture-market', checks: [], join,
      sha256: () => 'fixture-hash', writeJson: (path, value) => written.push(value),
      console: { log() {} }, process: { exitCode: 0 }, server: { closeAllConnections() {}, close() {} },
      snapshot() { throw new Error('No renderer may be used.'); },
      async requestDesktopShutdown() {
        if (mode !== 'normal') throw new Error('synthetic CDP failure');
        context.ended = true; context.exitCode = 0;
      },
      async stopPreviewService(service) {
        stopped.push(service.child);
        if (mode === 'unreaped') throw new Error('synthetic reap failure');
        context.ended = true; context.exitCode = null;
      },
    };
    const finish = runInNewContext(body + '\nfinish;', context);
    await finish();
    assert.equal(written[0].error, original, 'Primary startup failure must not be overwritten.');
    assert.equal(context.process.exitCode, 1);
    if (mode === 'normal') assert.equal(stopped.length, 0);
    else assert.deepEqual(stopped, [child]);
    if (mode === 'unreaped') assert.equal(original.cleanupMessage, 'synthetic reap failure');
  }
});

test('market UI finish closes its server and rejects renderer, integrity and receipt failures', async () => {
  const body = section(source('verify-market-desktop-ui.mjs'), 'async function finish() {', '\nconst server =');
  for (const mode of ['normal', 'renderer-error', 'changed-host', 'unreadable-host', 'receipt-error', 'signal']) {
    const events = [], written = [], fault = new Error('synthetic ' + mode);
    const context = {
      finalizing: false, renderer: { close() { events.push('renderer'); if (mode === 'renderer-error') throw fault; } },
      child: {}, ended: true, exitCode: mode === 'signal' ? null : 0, signal: mode === 'signal' ? 'SIGKILL' : null,
      forced: false, error: null, folder: 'fixture-folder', control: { pnpmEntry: 'fixture-pnpm' },
      runtime: { app: { version: 'fixture' }, executable: 'fixture-runtime', archivePath: 'fixture-asar' },
      before: ['fixture-hash', 'fixture-hash', 'fixture-hash'], run: { runId: 'fixture', directory: 'fixture-evidence' },
      productReceipt: { sha256: 'fixture-product' }, marketTar: 'fixture-market', checks: [], join,
      sha256(path) {
        if (mode === 'unreadable-host' && path === 'fixture-runtime') throw fault;
        return mode === 'changed-host' && path === 'fixture-runtime' ? 'changed-hash' : 'fixture-hash';
      },
      writeJson(path, value) { events.push('receipt'); if (mode === 'receipt-error') throw fault; written.push(value); },
      console: { log() {} }, process: { exitCode: 0 },
      server: { closeAllConnections() { events.push('connections'); }, close() { events.push('server'); } },
    };
    const finish = runInNewContext(body + '\nfinish;', context);
    if (mode === 'receipt-error') await assert.rejects(finish(), error => error === fault);
    else await finish();
    assert.ok(events.includes('connections') && events.includes('server'), 'Receipt and renderer failures must still close the control server.');
    assert.equal(context.process.exitCode, mode === 'normal' ? 0 : 1);
    if (mode !== 'receipt-error') assert.equal(Boolean(written[0].error), mode !== 'normal');
  }
});

test('limited live verification fails when a repeat search fails after initial success', () => {
  const text = source('verify-acceptance-sources.mjs');
  const summaryBody = section(text, '  const summary = {', '  assertSecretFreeEvidence(summary, secrets);');
  const exitBody = section(text, '  if (!summary.invariantsPassed', '\n}');
  for (const failedRepeat of [false, true]) {
    const results = ['grok', 'exa'].flatMap(provider => [1, 2].map(pass => ({
      provider, pass, status: failedRepeat && provider === 'grok' && pass === 2 ? 'failed' : 'passed',
    })));
    const context = {
      run: { runId: 'fixture-run' }, receipt: { sha256: 'a'.repeat(64) }, active: { version: '0.1.26' },
      attempts: { grok: 2, exa: 2 }, network: [], results, fatalCode: null,
      configUnchanged: true, cleanupVerified: true, process: { exitCode: 0 },
    };
    const result = runInNewContext(summaryBody + '\n' + exitBody + '\n({ summary, exitCode: process.exitCode });', context);
    assert.equal(result.exitCode, failedRepeat ? 1 : 0);
    assert.equal(result.summary.primaryGrokVerified, true, 'An earlier successful query remains an observation.');
  }
});

test('native update admission evaluates unchanged declared host ranges as semver', () => {
  const body = section(source('verify-native-update.mjs'), 'const packages = [oldArgument, nextArgument]', 'for (const row of packages[1].receipt.sourceHashes)');
  const candidate = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const verify = (oldRange, nextRange) => {
    const packages = [
      { manifest: { name: 'dsh-grok-search', version: '0.3.0', engines: { dsh: oldRange } } },
      { manifest: { name: 'dsh-grok-search', version: candidate.version, engines: { dsh: nextRange } } },
    ];
    return runInNewContext(body, {
      assert, semver, oldArgument: 0, nextArgument: 1, readUpgradePackage: index => packages[index],
      baselineRuntime: { app: { version: '0.2.2-rc.1' } }, runtime: { app: { version: '0.2.2-rc.2' } },
    });
  };
  assert.doesNotThrow(() => verify('0.2.2-rc.1 || 0.2.2-rc.2', candidate.engines.dsh));
  assert.doesNotThrow(() => verify('>=0.2.1-rc.2', '>=0.2.1-rc.2'));
  for (const range of ['0.2.1-rc.2', 'invalid range', undefined]) {
    assert.throws(() => verify('0.2.2-rc.1', range));
    assert.throws(() => verify(range, candidate.engines.dsh));
  }
});

test('RC5 upgrade rejects an unverified old package before any fixture preparation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remaining-script-provenance-'));
  const old = join(root, 'unverified-old.tgz');
  writeFileSync(old, 'synthetic changed package', { flag: 'wx' });
  writeFileSync(join(root, 'package-receipt.json'), JSON.stringify({ sha256: 'a'.repeat(64) }), { flag: 'wx' });
  const body = section(source('verify-rc5-user-path.mjs'), 'const packageReceipt =', 'const run =');
  const verify = upgradeFrom => runInNewContext(body, {
    assert, join, dirname, readUpgradePackage, upgradeFrom, tarball: 'synthetic-candidate.tgz',
    project: 'fixture-project', registryInstall: false, baselineReplay: false, sha256: () => 'b'.repeat(64),
    readFileSync: () => JSON.stringify({ sha256: 'b'.repeat(64), version: '0.4.0', sourceHashes: [] }),
  });
  assert.doesNotThrow(() => verify(null), 'Fresh-install preflight must not read an old package.');
  assert.throws(() => verify(old), /receipt/i);
});

async function performanceComparisonSummary({ changed = [], unreadable = [], fatal = null, exitCode = 0 } = {}) {
  const text = source('compare-settings-desktop-performance.mjs');
  const start = text.lastIndexOf('} finally {');
  assert.ok(start >= 0);
  const body = text.slice(start + '} finally {'.length, text.lastIndexOf('\n}'));
  const runtime = { archivePath: 'fixture-archive', executable: 'fixture-executable' };
  const project = 'fixture-project', read = [], evidence = [];
  const sourceHashes = ['helper-one.mjs', 'helper-two.mjs'].map(file => ({ file, sha256: 'original-' + file }));
  const hashes = new Map([[runtime.archivePath, 'original-archive'], [runtime.executable, 'original-executable'],
    ...sourceHashes.map(row => [join(project, row.file), row.sha256])]);
  const results = [{ label: 'baseline', measurement: 11 }, { label: 'optimized', measurement: 7 }];
  const exits = [{ code: 0, forced: false }, { code: exitCode, forced: false }];
  const context = { runtime, project, sourceHashes, fatal, results, exits, join, run: { runId: 'fixture-run', directory: 'unused' },
    originalArchive: 'original-archive', originalExecutable: 'original-executable',
    stop: async () => {}, upstream: { close(done) { done(); } }, process: { exitCode: null },
    console: { log() {} }, writeJson(path, value) { evidence.push({ path, value }); },
    sha256(path) {
      read.push(path);
      if (unreadable.includes(path)) throw Object.assign(new Error('Synthetic missing integrity input'), { code: 'ENOENT' });
      assert.ok(hashes.has(path), 'Only the recorded integrity inputs may be read.');
      return changed.includes(path) ? 'changed' : hashes.get(path);
    },
  };
  await runInNewContext(`(async () => { ${body} })()`, context);
  return { summary: evidence[0].value, exitCode: context.process.exitCode, read, sourceHashes, results, exits };
}

test('Desktop performance comparison fails changed official files without discarding measurements', async () => {
  for (const file of ['fixture-archive', 'fixture-executable']) {
    const result = await performanceComparisonSummary({ changed: [file] });
    assert.equal(result.summary.officialFilesUnchanged, false);
    assert.equal(result.summary.passed, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.results, result.results);
    assert.equal(result.summary.exits, result.exits);
  }
});

test('Desktop performance comparison rechecks every source hash and rejects drift or unreadable inputs', async () => {
  for (const mode of ['changed', 'unreadable']) {
    for (const file of ['helper-one.mjs', 'helper-two.mjs']) {
      const result = await performanceComparisonSummary({ [mode]: [join('fixture-project', file)] });
      assert.equal(result.summary.sourcesUnchanged, false);
      assert.equal(result.summary.passed, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.sourceHashes.every(row => result.read.includes(join('fixture-project', row.file))));
      assert.equal(result.summary.results, result.results);
    }
  }
});

test('Desktop performance comparison retains its primary failure even when final integrity reads fail', async () => {
  const fatal = { name: 'AssertionError', message: 'synthetic original measurement failure' };
  const result = await performanceComparisonSummary({ fatal, unreadable: ['fixture-archive'] });
  assert.equal(result.summary.fatal, fatal);
  assert.equal(result.summary.officialFilesUnchanged, false);
  assert.equal(result.summary.passed, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.results, result.results);
  assert.ok(result.summary.integrityErrors.some(row => row.code === 'ENOENT'));
});

test('Desktop performance comparison passes intact inputs and preserves failed process outcomes', async () => {
  const passed = await performanceComparisonSummary();
  assert.equal(passed.summary.passed, true);
  assert.equal(passed.summary.officialFilesUnchanged, true);
  assert.equal(passed.summary.sourcesUnchanged, true);
  assert.equal(passed.exitCode, 0);
  assert.equal((await performanceComparisonSummary({ exitCode: 17 })).summary.passed, false);
  const fatal = { name: 'Error', message: 'synthetic measurement failure' };
  assert.equal((await performanceComparisonSummary({ fatal })).summary.fatal, fatal);
  assert.equal((await performanceComparisonSummary({ fatal })).summary.passed, false);
});
