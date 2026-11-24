import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mkdtempTracked } from './helpers/temp-fixture.mjs';
import { connectRenderer } from '../scripts/lib/renderer-cdp.mjs';
import { commandResult, receipt } from '../scripts/lib/internal-candidate-utils.mjs';

const fixtureHelper = new URL('./helpers/temp-fixture.mjs', import.meta.url).href;

test('registry installation verifies the actual host-resolved release while allowing publication-age selection', () => {
  const source = readFileSync(new URL('../scripts/verify-rc5-user-path.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function assertBareRegistryIdentity(');
  const end = source.indexOf('\n// Unlike the historical', start);
  assert.ok(start >= 0 && end > start);
  const verify = runInNewContext(source.slice(start, end).replace('export ', '')
    + '\nassertBareRegistryIdentity;', { assert });
  const name = 'dsh-grok-search';
  for (const version of ['0.4.1', '0.4.2']) {
    verify({ application: 'applied', version }, { name, version }, { name, version }, name);
  }
  assert.throws(() => verify({ application: 'applied', version: '0.4.1' },
    { name, version: '0.4.2' }, { name, version: '0.4.1' }, name));
  assert.throws(() => verify({ application: 'applied', version: '0.4.1' },
    { name, version: '0.4.1' }, { name: 'other', version: '0.4.1' }, name));
  assert.throws(() => verify({ application: 'failed', version: '0.4.1' },
    { name, version: '0.4.1' }, { name, version: '0.4.1' }, name));
  assert.match(source, /packed\.files\) \{[\s\S]*?readFileSync\(join\(product, file\)\)\.equals\(content\)/);
  assert.match(source, /spec: registryInstall \? `\$\{manifest\.name\}@\$\{manifest\.version\}` : tarball/);
});

test('native installation, upgrade and cold replay select the signed Windows entry and retain special-path mode', () => {
  const source = readFileSync(new URL('../scripts/verify-rc5-user-path.mjs', import.meta.url), 'utf8');
  assert.match(source, /const root = join\(tmpdir\(\), 'dsh-deferred-desktop-' \+ randomUUID\(\)\.replaceAll\('-', ''\)\.slice\(0, 6\)/);
  assert.ok(source.includes(`openConfig ? " 中文 空格 ' & $"`));
  const start = source.indexOf('const packaged ='), end = source.indexOf('\nfunction launchDesktop()', start);
  assert.ok(start >= 0 && end > start);
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const [liveInstall, replayHistory, upgradeFrom] of [
      [true, null, null], [false, 'synthetic-control-history', null],
      [false, null, 'previous.tgz'], [false, null, null],
    ]) {
      const result = runInNewContext(source.slice(start, end) + '\n({ packaged, launchExecutable });', {
        process: { platform }, liveInstall, replayHistory, upgradeFrom,
        runtime: { executable: 'official-signed-host' }, control: { electron: 'isolated-development-entry' },
      });
      const signed = platform === 'win32' && (liveInstall || replayHistory !== null || upgradeFrom !== null);
      assert.equal(Boolean(result.packaged), signed);
      assert.equal(result.launchExecutable, signed ? 'official-signed-host' : 'isolated-development-entry');
    }
  }
  assert.match(source, /spawn\(launchExecutable, \[\.\.\.\(packaged \? \[\] : \[control\.archive\]\)/);
});

function userPathGuards() {
  const source = readFileSync(new URL('../scripts/verify-rc5-user-path.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function assertReplayReady(');
  const end = source.indexOf('export function assertBareRegistryIdentity(', start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(source.slice(start, end).replaceAll('export function ', 'function ')
    + '\n({ assertReplayReady, verifyUserPathIdentities, assertUserPathInstallation });', {
    assert, join, sha256: path => createHash('sha256').update(readFileSync(path)).digest('hex'),
  });
}

test('upgrade installation accepts restart-required only for an explicitly verified cold upgrade', () => {
  const { assertUserPathInstallation } = userPathGuards();
  const response = (application, version = '0.4.3') => ({
    http: 200, body: { result: { ok: true, value: { application, version, error: null } } },
  });
  assert.equal(assertUserPathInstallation(response('applied'), '0.4.3'), 'applied');
  assert.throws(() => assertUserPathInstallation(response('restart-required'), '0.4.3'));
  assert.equal(assertUserPathInstallation(response('restart-required'), '0.4.3', { allowRestart: true }), 'restart-required');
  for (const value of [false, 'true', 1]) {
    assert.throws(() => assertUserPathInstallation(response('restart-required'), '0.4.3', { allowRestart: value }));
  }
  for (const invalid of [null, response('failed'), response('unknown'), response('applied', '0.4.2'),
    { http: 500, body: response('applied').body },
    { http: 200, body: { result: { ok: false } } },
    { http: 200, body: { result: { ok: true, value: { ...response('applied').body.result.value, error: { code: 'failure' } } } } }]) {
    assert.throws(() => assertUserPathInstallation(invalid, '0.4.3', { allowRestart: true }));
  }
});

test('restart-required upgrade verifies installed files, exits normally and cold-boots before readiness checks', async () => {
  const source = readFileSync(new URL('../scripts/verify-rc5-user-path.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("    if (application === 'restart-required') {");
  const end = source.indexOf('\n  }\n  if (baselineReplay)', start);
  assert.ok(start >= 0 && end > start);
  const calls = [], evidence = [];
  const run = vmExit => runInNewContext(`(async () => {
    let renderer = { close() { calls.push('close-renderer'); } };
    let child, closed = Promise.resolve(vmExit);
    ${source.slice(start, end)}
    return renderer;
  })()`, {
    assert, calls, vmExit, application: 'restart-required', port: 1234,
    run: { directory: 'synthetic-upgrade-evidence' }, join,
    verifyIdentities: () => { calls.push('verify-files'); return { installedFilesVerified: 59 }; },
    requestDesktopShutdown: async () => { calls.push('shutdown'); },
    launchDesktop: () => { calls.push('cold-boot'); return { child: {}, closed: Promise.resolve({ code: 0, signal: null }) }; },
    connectRenderer: async () => { calls.push('connect-new'); return { evaluate() {} }; },
    waitForRenderer: async () => { calls.push('new-ui-ready'); },
    writeJson: (path, value) => evidence.push({ path, value }),
  });
  await run({ code: 0, signal: null });
  assert.deepEqual(calls, ['verify-files', 'close-renderer', 'shutdown', 'cold-boot', 'connect-new', 'new-ui-ready']);
  assert.equal(evidence.at(-1).value.completed, true);
  assert.equal(evidence.at(-1).value.installedIdentity.installedFilesVerified, 59);
  for (const exit of [{ code: 1, signal: null }, { code: 0, signal: 'SIGKILL' }]) {
    calls.length = evidence.length = 0;
    await assert.rejects(run(exit));
    assert.deepEqual(calls, ['verify-files', 'close-renderer', 'shutdown']);
    assert.equal(evidence.some(item => item.value.completed), false);
  }
  assert.ok(source.indexOf('const snapshot = await waitForRenderer', end) > end,
    'normal runtime readiness is still required after the cold upgrade');
});

test('cold replay rejects an upgrade combination before opening any package or profile', () => {
  const source = readFileSync(new URL('../scripts/verify-rc5-user-path.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const liveInstall ='), end = source.indexOf('const [runtime] =', start);
  assert.ok(start >= 0 && end > start);
  const parse = args => runInNewContext(source.slice(start, end) + '\n({ replayHistory, baselineReplay, upgradeFrom });', {
    assert, resolve, inputArguments: [...args, 'candidate.tgz', 'official-desktop.exe'],
  });
  const replay = ['--replay-control-history', 'control-intent.records'];
  assert.equal(parse(replay).replayHistory, resolve('control-intent.records'));
  assert.equal(parse([...replay, '--baseline-replay']).baselineReplay, true);
  assert.equal(parse(['--upgrade-from', 'previous.tgz']).upgradeFrom, resolve('previous.tgz'));
  for (const extra of [[], ['--baseline-replay']]) {
    assert.throws(() => parse([...replay, ...extra, '--upgrade-from', 'previous.tgz']), /cannot be combined/);
  }
  assert.throws(() => parse([...replay, '--live-install']), /cold boot/);
  assert.throws(() => parse(['--baseline-replay']), /historical baseline/);
});

test('replay success requires live control and a healthy rendered UI, not just a required ledger', () => {
  const { assertReplayReady } = userPathGuards();
  const control = { available: true, phase: 'required', policy: 'required', error: null };
  const ui = { text: 'ready', note: 'empty log', controlUnavailable: false, componentError: false };
  assertReplayReady(control, ui);
  for (const invalid of [null, { ...control, available: false }, { ...control, phase: 'released' },
    { ...control, policy: 'released' }, { ...control, error: { code: 'CONTROL_SETTINGS_UNAVAILABLE' } }]) {
    assert.throws(() => assertReplayReady(invalid, ui));
  }
  for (const invalid of [null, { ...ui, text: '' }, { ...ui, note: null },
    { ...ui, controlUnavailable: true }, { ...ui, componentError: true }]) {
    assert.throws(() => assertReplayReady(control, invalid));
  }
});

test('user-path identity checks reject changed package, installed files, sources and official host bytes', () => {
  const { verifyUserPathIdentities } = userPathGuards();
  const root = mkdtempTracked(join(tmpdir(), 'dsh-user-path-identity-'));
  const product = join(root, 'installed'), sourceRoot = join(root, 'source');
  mkdirSync(product); mkdirSync(sourceRoot);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const originals = new Map(), put = (path, content) => { originals.set(path, content); writeFileSync(path, content); return path; };
  const tarball = put(join(root, 'frozen.tgz'), 'synthetic-archive');
  const sourceHashes = ['runtime.mjs', 'README.md'].map(file => {
    const content = 'synthetic-' + file;
    put(join(product, file), content); put(join(sourceRoot, file), content);
    return { file, sha256: hash(content) };
  });
  const hostHashes = ['executable', 'archive', 'fuseBinary', 'runtime-receipt'].map(role => {
    const content = 'synthetic-' + role, path = put(join(root, role), content);
    return { role, path, sha256: hash(content) };
  });
  const options = { tarball, product, sourceRoot, hostHashes,
    packageReceipt: { sha256: hash('synthetic-archive'), sourceHashes } };
  assert.equal(verifyUserPathIdentities(options).sourceFilesVerified, 2);
  for (const [path, content] of originals) {
    writeFileSync(path, content + '-changed');
    assert.throws(() => verifyUserPathIdentities(options), /unchanged|changed/);
    writeFileSync(path, content);
  }
  writeFileSync(join(sourceRoot, 'README.md'), 'post-publication-guidance');
  assert.equal(verifyUserPathIdentities({ ...options, registryInstall: true }).sourceFilesVerified, 1);
  writeFileSync(join(sourceRoot, 'runtime.mjs'), 'current-candidate-source');
  assert.throws(() => verifyUserPathIdentities({ ...options, registryInstall: true }), /source file changed/);
  assert.equal(verifyUserPathIdentities({ ...options, baselineReplay: true }).sourceFilesVerified, 0);
  writeFileSync(join(product, 'runtime.mjs'), 'changed-baseline');
  assert.throws(() => verifyUserPathIdentities({ ...options, baselineReplay: true }), /installed file changed/);
});

test('baseline replay still captures the diagnosed failure and never becomes a success result', async () => {
  const source = readFileSync(new URL('../scripts/verify-rc5-user-path.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  if (baselineReplay) {', source.indexOf('let { child, closed }'));
  const end = source.indexOf('  const snapshot = await waitForRenderer', start);
  assert.ok(start >= 0 && end > start);
  const writes = [], events = [];
  const execute = runInNewContext('(async () => {\n' + source.slice(start, end)
    + '\n})()', {
    assert, Buffer, join, baselineReplay: true, baselineReproduced: false, run: { directory: 'synthetic-evidence' },
    renderer: { evaluate: async () => true, send: async () => ({ data: Buffer.from('synthetic-image').toString('base64') }) },
    waitForRenderer: async (_renderer, _predicate, options) => options?.timeoutMs === 15_000
      ? { control: { available: false, error: { code: 'CONTROL_SETTINGS_UNAVAILABLE' } },
        ui: { controlUnavailable: true } } : true,
    verifyIdentities: () => { events.push('identity'); return { packageSha256: 'synthetic-hash' }; },
    packageReceipt: { version: 'synthetic-old-version', sha256: 'synthetic-hash', sourceHashes: [{}] },
    replayEvidence: { revision: 58 },
    writeFileSync: (path, bytes) => { writes.push({ path, image: Buffer.isBuffer(bytes) }); },
    writeJson: (path, value) => { writes.push({ path, value }); },
  });
  await assert.rejects(execute, /KNOWN_BASELINE_FAILURE_REPRODUCED: CONTROL_SETTINGS_UNAVAILABLE/);
  assert.deepEqual(events, ['identity']);
  assert.ok(writes.some(row => row.path.endsWith('baseline-replay.png') && row.image));
  const receipt = writes.find(row => row.path.endsWith('baseline-reproduction.json')).value;
  assert.equal(receipt.reproduced, true); assert.equal(receipt.repaired, false);
  assert.equal(writes.some(row => row.path.endsWith('summary.json')), false);
});

test('final identity checks run after host shutdown and cannot turn a failed baseline or changed input green', async () => {
  const source = readFileSync(new URL('../scripts/verify-rc5-user-path.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('} finally {\n  renderer?.close();');
  assert.ok(start >= 0);
  for (const baseline of [false, true]) for (const changed of [false, true]) {
    const events = [], writes = [], baselineError = new Error('KNOWN_BASELINE_FAILURE_REPRODUCED');
    const identityError = new Error('synthetic final identity mismatch');
    const failure = baseline ? baselineError : undefined;
    const context = { assert, join, setTimeout, clearTimeout, run: { directory: 'synthetic-evidence' },
      failure, baselineReproduced: baseline, finalIdentity: null, result: {},
      renderer: { close() { events.push('renderer-close'); } }, port: 1,
      closed: Promise.resolve({ code: 0, signal: null }),
      requestDesktopShutdown: async () => { events.push('shutdown'); },
      quotaServer: { closeAllConnections() {}, close(done) { events.push('quota-close'); done(); } },
      verifyIdentities: () => { events.push('identity'); if (changed) throw identityError; return { verified: true }; },
      writeJson: (path, value) => { writes.push({ path, value: { ...value } }); },
    };
    const execute = runInNewContext('(async () => { try { if (failure) throw failure; '
      + source.slice(start) + '\nreturn result; })()', context);
    if (changed || baseline) await assert.rejects(execute, error => error === (changed ? identityError : baselineError));
    else assert.equal((await execute).passed, true);
    assert.ok(events.indexOf('shutdown') < events.indexOf('identity'));
    assert.equal(writes.find(row => row.path.endsWith('final-identity.json')).value.passed, !changed);
    assert.equal(writes.some(row => row.path.endsWith('summary.json')), !changed && !baseline);
  }
});

test('modified native user-path and delivery tooling modules pass syntax checking without launching a host', () => {
  for (const path of [new URL('../scripts/verify-rc5-user-path.mjs', import.meta.url), new URL(import.meta.url)]) {
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(path)], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('program probe keeps historical modes and requires an exact package and hash for final-package checks', () => {
  const source = readFileSync(new URL('../scripts/program-install-probe.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function parseProgramProbeArguments(');
  const end = source.indexOf('\nconst { mirrorOnly,', start);
  assert.ok(start >= 0 && end > start);
  const parse = runInNewContext(source.slice(start, end).replace('export ', '')
    + '\nparseProgramProbeArguments;');
  const normalize = args => JSON.parse(JSON.stringify(parse(args)));
  assert.deepEqual(normalize([]), { mirrorOnly: false });
  assert.deepEqual(normalize(['--mirror-only']), { mirrorOnly: true });
  const hash = 'a'.repeat(64), receipt = ['--runtime-receipt', 'receipt.json',
    '--runtime-receipt-sha256', hash, '--receipt-root', 'root'];
  assert.deepEqual(normalize(['--host-desktop', 'host.exe', ...receipt]), {
    mirrorOnly: false, desktop: 'host.exe', receiptPath: 'receipt.json', receiptSha256: hash, receiptRoot: 'root',
  });
  assert.equal(normalize(['--host-desktop', 'host.exe', ...receipt,
    '--product-package', 'final.tgz', '--product-sha256', hash]).productSha256, hash);
  for (const args of [
    ['--product-package', 'final.tgz', '--product-sha256', hash],
    ['--host-desktop', 'host.exe', '--product-package', 'final.tgz'],
    ['--host-desktop', 'host.exe', '--product-sha256', hash],
    ['--host-desktop', 'host.exe', '--product-package', 'final.tgz', '--product-sha256', 'bad'],
    ['--host-desktop', 'host.exe', '--product-package', 'one.tgz', '--product-package', 'two.tgz'],
    ['--runtime-receipt', 'receipt.json'],
    ['--host-desktop', '--mirror-only'],
    ['--mirror-only', '--mirror-only'],
    ['--unknown'],
  ]) assert.throws(() => parse(args), /Usage:/, JSON.stringify(args));
});

function cleanupProbe(mode) {
  const root = mkdtempTracked(join(tmpdir(), 'dsh-tooling-cleanup-'));
  const parent = join(root, 'parent'); mkdirSync(parent);
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join, basename } from 'node:path';
    const mode = process.env.FIXTURE_MODE, root = process.env.FIXTURE_ROOT;
    const parent = join(root, 'parent');
    if (mode === 'remove-error') {
      fs.rmSync = () => { throw Object.assign(new Error('synthetic-private-message'), { code: 'EACCES' }); };
      syncBuiltinESMExports();
    }
    const { mkdtempTracked } = await import(${JSON.stringify(fixtureHelper)});
    const path = mkdtempTracked(join(parent, 'dsh-owned-'));
    fs.writeFileSync(join(path, 'sentinel'), 'owned');
    if (mode === 'child-replaced') {
      fs.renameSync(path, join(root, 'original-child'));
      fs.mkdirSync(path); fs.writeFileSync(join(path, 'sentinel'), 'replacement');
    }
    if (mode === 'parent-replaced') {
      fs.renameSync(parent, join(root, 'original-parent'));
      fs.mkdirSync(parent);
      fs.renameSync(join(root, 'original-parent', basename(path)), path);
    }
    if (mode === 'parent-link') {
      fs.renameSync(parent, join(root, 'original-parent'));
      fs.symlinkSync(join(root, 'original-parent'), parent, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (mode === 'child-link') {
      fs.renameSync(path, join(root, 'original-child'));
      fs.symlinkSync(join(root, 'original-child'), path, process.platform === 'win32' ? 'junction' : 'dir');
    }
    process.on('exit', () => console.log(JSON.stringify({ exists: fs.existsSync(path) })));
    if (mode === 'nonzero') process.exitCode = 7;
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, RUNNER_TEMP: parent, FIXTURE_ROOT: root, FIXTURE_MODE: mode,
      DSH_KEEP_TEST_FIXTURES: mode === 'keep' ? '1' : '0' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, mode === 'nonzero' ? 7 : 0, result.stderr);
  return { ...JSON.parse(result.stdout.trim()), stderr: result.stderr, root };
}

test('fixture cleanup deletes original ordinary directories and honors retention', () => {
  assert.equal(cleanupProbe('ordinary').exists, false);
  for (const mode of ['keep', 'nonzero']) assert.equal(cleanupProbe(mode).exists, true, mode);
});

for (const mode of ['child-replaced', 'parent-replaced', 'parent-link', 'child-link', 'remove-error']) {
  test(`fixture cleanup retains and safely reports ${mode}`, () => {
    const result = cleanupProbe(mode);
    assert.equal(result.exists, true, 'Never remove a replacement or redirected fixture.');
    assert.match(result.stderr, /TEST_FIXTURE_CLEANUP/);
    assert.doesNotMatch(result.stderr, /synthetic-private-message/);
    assert.equal(result.stderr.includes(result.root), false, 'Diagnostics must not expose private temporary paths.');
  });
}

test('fixture cleanup does not adopt existing directories or out-of-root prefixes', () => {
  const root = mkdtempTracked(join(tmpdir(), 'dsh-tooling-cleanup-scope-'));
  const parent = join(root, 'ordinary'); mkdirSync(parent);
  const existing = join(parent, 'dsh-existing'); mkdirSync(existing);
  const script = `
    import { mkdtempTracked } from ${JSON.stringify(fixtureHelper)};
    console.log(JSON.stringify({ created: mkdtempTracked(process.env.FIXTURE_PREFIX) }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, RUNNER_TEMP: '', FIXTURE_PREFIX: join(parent, 'dsh-unowned-') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(existing), true);
  assert.equal(existsSync(JSON.parse(result.stdout).created), true);
});

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Disconnect did not settle promptly.')), 250);
    })]);
  } finally { clearTimeout(timer); }
}

async function rendererFixture(t, setup = 'open') {
  let socket;
  class Socket extends EventTarget {
    readyState = 0;
    sent = [];
    closeCount = 0;
    constructor() {
      super(); socket = this;
      queueMicrotask(() => {
        if (setup === 'close-before-open') { this.readyState = 3; this.dispatchEvent(new Event('close')); }
        else { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      });
    }
    send(bytes) {
      const request = JSON.parse(bytes); this.sent.push(request);
      if (request.method === 'Runtime.enable') queueMicrotask(() => {
        if (setup === 'close-during-enable') { this.readyState = 3; this.dispatchEvent(new Event('close')); }
        else this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result: {} }) }));
      });
      if (request.method === 'throw') throw new Error('synthetic send failure');
    }
    close() { this.closeCount++; this.readyState = 3; }
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true,
    json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:1/fixture' }],
  }));
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; socket?.close(); });
  const connection = connectRenderer(1, { timeoutMs: 1_000, requestTimeoutMs: 2_000 });
  return { connection, socket: () => socket };
}

for (const signal of ['close', 'error', 'explicit-close', 'send-error']) {
  test(`renderer rejects pending and future requests on ${signal}`, async t => {
    const fixture = await rendererFixture(t), renderer = await fixture.connection, socket = fixture.socket();
    const requests = [renderer.send('pending-one'), renderer.evaluate('pending-two')];
    const settled = Promise.allSettled(requests);
    if (signal === 'explicit-close') renderer.close();
    else if (signal === 'send-error') await assert.rejects(renderer.send('throw'));
    else { if (signal === 'close') socket.readyState = 3; socket.dispatchEvent(new Event(signal)); }
    const results = await within(settled);
    assert.ok(results.every(row => row.status === 'rejected'));
    assert.ok(results.every(row => !/timed out/.test(row.reason.message)));
    const sent = socket.sent.length;
    await assert.rejects(within(renderer.send('future')), /closed|disconnect|failed|send failure/i);
    assert.equal(socket.sent.length, sent, 'Disconnected calls must not reach socket.send.');
    if (signal !== 'close') assert.ok(socket.closeCount > 0);
  });
}

for (const setup of ['close-before-open', 'close-during-enable']) {
  test(`renderer setup rejects immediately on ${setup}`, async t => {
    const fixture = await rendererFixture(t, setup);
    await assert.rejects(within(fixture.connection), /closed|disconnect/i);
    assert.ok(fixture.socket().closeCount > 0);
  });
}

test('B2 advanced read-only probes use complete attribute selectors', async () => {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("    check('program path read-only'");
  const end = source.indexOf("    check('close advanced'", start);
  assert.ok(start >= 0 && end > start);
  const selectors = [];
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    q(selector) {
      assert.match(selector, /^input\[data-k=(exeOverride|cfgOverride|budget)\]$/);
      selectors.push(selector); return '({ readOnly: true })';
    },
    renderer: { evaluate: async expression => runInNewContext(expression) },
    check: (_, value) => assert.equal(value, true),
  });
  assert.equal(selectors.length, 3);
});


async function readmeDemoFixture({ preview = 'ready', browser = 'spawn', stop = 'normal',
  captureError, rendererError, removeError, evidenceError, summaryWriteError, passed = true,
  keepFrames = 'false', earlyClose } = {}) {
  const source = readFileSync(new URL('../scripts/readme-demos.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const services = []');
  const captureStart = source.indexOf('  const { send, evaluate } = renderer;', start);
  const captureEnd = source.indexOf('  // The preview seals source hashes while alive;', captureStart);
  assert.ok(start >= 0 && captureStart > start && captureEnd > captureStart);
  const fragment = source.slice(start, captureStart)
    + '\nif (captureError) throw captureError;\nreport.scenarios.push({ sensitiveCalls: 0, expected: fixturePassed });\n'
    + 'report.pageErrors = [];\nreport.passed = fixturePassed;\n' + source.slice(captureEnd);
  const events = [], children = [], receipts = [], writes = [], removed = [], diagnostics = [], timers = new Map();
  const origin = 'http://127.0.0.1:1', directory = join(tmpdir(), 'dsh-synthetic-evidence');
  const runInfo = { origin, directory, runId: 'synthetic-run' };
  const summaryPath = join(directory, 'summary.json');
  const sourceHashes = [{ file: 'src/client.js', sha256: 'synthetic-source-hash' }];
  const files = new Map();
  const spawnError = new Error('synthetic spawn error');
  const renderer = { close() { events.push('renderer-close'); if (rendererError) throw rendererError; } };
  function timer(callback) {
    const token = {}; timers.set(token, callback);
    setImmediate(() => { if (timers.delete(token)) callback(); });
    return token;
  }
  function spawn(_exe, _args, options) {
    const name = children.length ? 'browser' : 'preview';
    events.push('spawn-' + name);
    assert.equal(options.windowsHide, true);
    if (name === 'browser' && browser === 'throw') throw spawnError;
    if (name === 'preview' && preview === 'throw') throw spawnError;
    const child = new EventEmitter(); child.name = name; child.stdout = new EventEmitter();
    child.kill = signal => {
      events.push('kill-' + name + ':' + (signal ?? 'default'));
      if (stop === 'throw' && name === 'browser') throw new Error('synthetic kill failure');
      if (stop !== 'stuck' && (stop !== 'forced' || signal === 'SIGKILL')) {
        queueMicrotask(() => { events.push('close-' + name); child.emit('close', 0); });
      }
      return true;
    };
    children.push(child);
    queueMicrotask(() => {
      if (name === 'preview') {
        if (preview === 'error') { child.emit('error', spawnError); child.emit('close', -1); }
        else if (preview === 'exit') { child.emit('exit', 2); child.emit('close', 2); }
        else if (preview === 'malformed') child.stdout.emit('data', 'invalid-json\n');
        else if (preview === 'ready') {
          child.stdout.emit('data', JSON.stringify(runInfo)); child.stdout.emit('data', '\n');
        }
      } else if (browser === 'error') { child.emit('error', spawnError); child.emit('close', -1); }
      else { child.emit('spawn'); if (browser === 'exit') child.emit('close', 2); }
    });
    return child;
  }
  const context = { spawn, process: { execPath: 'synthetic-node' }, project: 'synthetic-project',
    chrome: 'synthetic-browser', formats: ['gif'], dpr: 1, speed: 1, WIDTH: 1089, keepFrames,
    join, basename, resolve, sep, tmpdir, setTimeout: timer, clearTimeout: token => timers.delete(token),
    mkdtempSync: prefix => prefix + 'owned', existsSync: () => true,
    readFileSync(file) {
      if (file === summaryPath) return files.get(file);
      if (file.endsWith('package.json')) return JSON.stringify({ version: 'synthetic-version' });
      return '1\n';
    },
    connectRenderer: async () => renderer, captureError, fixturePassed: passed,
    fetch: async (url, options) => {
      assert.equal(url, origin + '/evidence');
      const value = JSON.parse(options.body); receipts.push(value); events.push('evidence');
      assert.equal(value.passed, false); assert.equal(value.cleanupPending, true);
      if (evidenceError) return { ok: false, text: async () => evidenceError.message };
      files.set(summaryPath, JSON.stringify({ ...value, sourceHashes }));
      if (earlyClose) {
        const child = children.find(row => row.name === earlyClose.child);
        const event = earlyClose.event ?? 'close';
        events.push(event + '-' + child.name);
        child.emit(event, earlyClose.code, earlyClose.signal ?? null);
      }
      return { ok: true };
    },
    rmSync(target) { removed.push(target); events.push('remove-frames'); if (removeError) throw removeError; },
    writeFileSync(file, value, options) {
      assert.ok(children.every(child => events.includes('close-' + child.name)), 'Receipts must wait for all owned children to close.');
      if (file === summaryPath && summaryWriteError) throw summaryWriteError;
      if (options?.flag === 'wx') assert.equal(files.has(file), false);
      files.set(file, value); writes.push({ file, value: JSON.parse(value) });
    },
    console: { log(value) { events.push('log'); diagnostics.push(value); }, error(...args) { diagnostics.push(args); } },
  };
  const gateSource = readFileSync(new URL('../scripts/lib/browser-gates.mjs', import.meta.url), 'utf8');
  const gateStart = gateSource.indexOf('export async function stopPreviewService(');
  const gateEnd = gateSource.indexOf('\nfunction hasFailure', gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  context.stopPreviewService = runInNewContext(gateSource.slice(gateStart, gateEnd)
    .replace('export async function', 'async function') + '\nstopPreviewService;', context);
  let error;
  try { await within(runInNewContext('(async () => {\n' + fragment + '\n})()', context)); }
  catch (caught) { error = caught; }
  return { error, spawnError, children, events, receipts, writes, removed, diagnostics, timers,
    sourceHashes, summary: files.has(summaryPath) ? JSON.parse(files.get(summaryPath)) : null,
    report: files.has(join(directory, 'recording-report.json'))
      ? JSON.parse(files.get(join(directory, 'recording-report.json'))) : null, process: context.process };
}

for (const preview of ['timeout', 'error', 'malformed', 'exit', 'throw']) {
  test('README demo lifecycle cleans owned preview after ' + preview, async () => {
    const fixture = await readmeDemoFixture({ preview });
    assert.ok(fixture.error);
    if (preview === 'error' || preview === 'throw') assert.equal(fixture.error, fixture.spawnError);
    if (preview === 'timeout') assert.match(fixture.error.message, /Preview server did not start/);
    if (preview === 'malformed') assert.equal(fixture.error.name, 'SyntaxError');
    if (preview === 'exit') assert.match(fixture.error.message, /Preview server exited: 2/);
    assert.equal(fixture.children.length, preview === 'throw' ? 0 : 1);
    if (preview === 'timeout' || preview === 'malformed') assert.ok(fixture.events.includes('kill-preview:default'));
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.receipts.length, 0);
    assert.equal(fixture.removed.length, 0); assert.equal(fixture.timers.size, 0);
    if (fixture.children[0]) assert.equal(fixture.children[0].stdout.listenerCount('data'), 0);
  });
}

for (const browser of ['error', 'throw', 'exit']) {
  test('README demo lifecycle cleans preview after browser ' + browser, async () => {
    const fixture = await readmeDemoFixture({ browser });
    assert.ok(fixture.error);
    if (browser !== 'exit') assert.equal(fixture.error, fixture.spawnError);
    else assert.match(fixture.error.message, /Chrome exited before exposing DevTools/);
    assert.ok(fixture.events.includes('kill-preview:default'));
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.removed.length, 0);
    assert.equal(fixture.timers.size, 0);
  });
}


for (const browser of ['error', 'throw']) {
  test('README demo lifecycle preserves browser ' + browser + ' when preview cleanup fails', async () => {
    const fixture = await readmeDemoFixture({ browser, stop: 'stuck' });
    assert.equal(fixture.error, fixture.spawnError);
    assert.ok(fixture.events.includes('kill-preview:SIGKILL'));
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.receipts.length, 0);
    assert.equal(fixture.timers.size, 0);
  });
}

for (const stop of ['throw', 'forced', 'stuck']) {
  test('README demo lifecycle refuses success after ' + stop + ' cleanup', async () => {
    const fixture = await readmeDemoFixture({ stop });
    assert.match(fixture.error?.message ?? '', /kill failure|forced cleanup|bounded cleanup/);
    assert.ok(fixture.events.includes('kill-preview:default'));
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.removed.length, 0);
    assert.equal(fixture.summary.passed, false); assert.equal(fixture.summary.cleanupPending, true);
    assert.equal(fixture.timers.size, 0);
    if (stop !== 'throw') assert.ok(fixture.events.includes('kill-browser:SIGKILL'));
  });
}

test('README demo lifecycle preserves capture error while cleanup also fails', async () => {
  const captureError = new Error('synthetic capture error'), rendererError = new Error('synthetic renderer close error');
  const fixture = await readmeDemoFixture({ captureError, rendererError, stop: 'throw' });
  assert.equal(fixture.error, captureError);
  assert.ok(fixture.events.includes('kill-preview:default')); assert.ok(fixture.events.includes('kill-browser:default'));
  assert.equal(fixture.writes.length, 0); assert.equal(fixture.receipts.length, 0);
});

for (const fault of ['rendererError', 'removeError', 'evidenceError', 'summaryWriteError']) {
  test('README demo lifecycle leaves summary unsuccessful after ' + fault, async () => {
    const error = new Error('synthetic ' + fault), fixture = await readmeDemoFixture({ [fault]: error });
    if (fault === 'evidenceError') assert.match(fixture.error.message, /Evidence write failed: synthetic evidenceError/);
    else assert.equal(fixture.error, error);
    if (fixture.summary) assert.equal(fixture.summary.passed, false);
    assert.ok(fixture.events.includes('close-preview')); assert.ok(fixture.events.includes('close-browser'));
    assert.equal(fixture.events.includes('log'), false);
    if (fault !== 'summaryWriteError') assert.equal(fixture.writes.length, 0);
  });
}

test('README demo lifecycle commits success only after owned cleanup and retains source hashes', async () => {
  const fixture = await readmeDemoFixture();
  assert.equal(fixture.error, undefined);
  assert.equal(fixture.removed.length, 1); assert.equal(fixture.writes.length, 2);
  assert.equal(fixture.summary.passed, true); assert.equal(fixture.summary.cleanupPending, false);
  assert.deepEqual(fixture.summary.sourceHashes, fixture.sourceHashes);
  assert.equal(fixture.report.passed, true); assert.equal(fixture.timers.size, 0);
  assert.deepEqual(fixture.events.filter(event => event.startsWith('kill-')).sort(), ['kill-browser:default', 'kill-preview:default']);
});

test('README demo lifecycle rejects an owned process that closes before cleanup', async () => {
  for (const child of ['browser', 'preview']) {
    for (const outcome of [{ code: 0 }, { code: 17 }, { code: null, signal: 'SIGKILL' }, { code: 17, event: 'exit' }]) {
      const fixture = await readmeDemoFixture({ earlyClose: { child, ...outcome } });
      assert.match(fixture.error?.message ?? '', /exited before cleanup/);
      assert.equal(fixture.summary.passed, false);
      assert.equal(fixture.writes.length, 0);
      assert.equal(fixture.timers.size, 0);
    }
  }
});

test('README demo lifecycle honors frame retention and unsuccessful scenarios', async () => {
  for (const options of [{ keepFrames: 'true' }, { passed: false }]) {
    const fixture = await readmeDemoFixture(options);
    assert.equal(fixture.error, undefined); assert.equal(fixture.removed.length, 0);
    assert.equal(fixture.summary.passed, options.passed ?? true);
    if (options.passed === false) assert.equal(fixture.process.exitCode, 1);
  }
});

test('delivery command receipts preserve UTF-8 split across stdout and stderr chunks', async () => {
  const expected = JSON.stringify({ host: '\u6821\u9a8c\u20ac\ud83d\ude00' }) + '\n';
  const bytes = [...Buffer.from(expected)];
  const source = `const bytes=${JSON.stringify(bytes)};
    (async()=>{for(const byte of bytes){
      process.stdout.write(Buffer.from([byte]));process.stderr.write(Buffer.from([byte]));
      await new Promise(done=>setTimeout(done,20));
    }})();`;
  const result = await commandResult(process.execPath, ['-e', source], { timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.rawStdout, expected);
  assert.equal(result.stdout, expected);
  assert.equal(receipt(result).stderr, expected);
  assert.deepEqual(JSON.parse(result.rawStdout), JSON.parse(expected));
});
