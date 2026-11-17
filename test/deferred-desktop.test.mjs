import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readElectronFuseWire, assertDevelopmentFuseCompatibility,
  resolveNewTemporaryRunRoot, inspectDesktopPreparation, fixtureDshEngines,
  prepareDesktopFixture, parseDesktopPreparationArguments,
} from '../scripts/deferred-release-desktop-prepare.mjs';
import * as desktopPreparation from '../scripts/deferred-release-desktop-prepare.mjs';
import { CANDIDATE_VERSIONS } from '../scripts/lib/candidate-runtime.mjs';
import { desktopCandidates, sha256, verifyHostAsset } from '../scripts/lib/compatibility-evidence.mjs';
import { captureDesktopSearch, captureDesktopSeam, waitForDesktopRecovery } from '../fixtures/deferred-release/desktop-fixture.mjs';
import { connectRenderer, requestDesktopShutdown } from '../scripts/lib/renderer-cdp.mjs';
import { desktopAcceptancePaths, desktopWorkspacePatch, prepareDesktopAcceptanceEnvironment } from '../scripts/lib/desktop-acceptance-environment.mjs';
import { commandResult } from '../scripts/lib/internal-candidate-utils.mjs';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import semver from 'semver';
import { readUpgradePackage, retainUpgradeCache, searchLogUpgradeStages } from '../scripts/verify-search-log-upgrade.mjs';
import * as upgradeVerifier from '../scripts/verify-search-log-upgrade.mjs';
import { adaptRetainedSessionRpc, canonicalRetainedSessionCut, createRetainedSessionReader } from '../scripts/lib/retained-session.mjs';
import './retained-session-cases.mjs';
import './remaining-scripts-audit-cases.mjs';
import * as cliUpgradeVerifier from '../scripts/compatibility-cli-upgrade.mjs';
import { finishNativeUpdate, nativeUpdateMetadata, nativeUpdateHostStages, validateNativeUpdateOutcome } from '../scripts/verify-native-update.mjs';

const fuseBinary = (wire = '101100011', version = 1, length = wire.length) => Buffer.concat([
  Buffer.from('fixture-prefix:dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
  Buffer.from([version, length]), Buffer.from(wire),
]);
const temporary = realpathSync(tmpdir());
const sandbox = mkdtempSync(join(temporary, 'dsh-deferred-desktop-checks-'));
const marker = join(sandbox, 'existing-marker.txt');
writeFileSync(marker, '既有成果保持', { flag: 'wx' });

const desktopPlatform = process.platform === 'win32' && process.arch === 'x64'
  || process.platform === 'darwin' && process.arch === 'arm64';

function receiptDesktopFixture(version = '0.2.2-rc.3', wire = '101100011') {
  const root = mkdtempSync(join(sandbox, 'runtime-')), mac = process.platform === 'darwin';
  const binaryDir = mac ? join(root, 'Harness.app', 'Contents', 'MacOS') : root;
  const resources = mac ? join(binaryDir, '..', 'Resources') : join(root, 'resources');
  const executable = join(binaryDir, mac ? 'DeepSeek Harness' : 'DeepSeek Harness.exe');
  const fuse = mac ? join(binaryDir, '..', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework') : executable;
  const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  write(executable, fuseBinary(wire));
  if (mac) {
    write(fuse, fuseBinary(wire));
    write(join(dirname(fuse), 'Resources', 'icudtl.dat'), 'synthetic ICU');
  } else {
    for (const name of ['chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll',
      'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
      'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll', 'locales/en-US.pak']) {
      write(join(root, name), 'synthetic resource');
    }
  }
  for (const name of ['default_app.asar', 'icon.png', 'tray.ico']) write(join(resources, name), 'synthetic resource');
  write(join(resources, version === '0.2.0-rc.2' ? 'runtime/pnpm/bin/pnpm.mjs'
    : 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), '// never executed');
  const entries = [
    ['package.json', { name: '@deepseek-ai/dsh-desktop', version }],
    ['dsh/package.json', { name: '@deepseek-ai/dsh', version }],
    ['dsh/desktop-runtime.json', { release: { version }, platform: process.platform, arch: process.arch }],
  ];
  const table = { files: {} }, contents = [];
  let offset = 0;
  for (const [path, value] of entries) {
    const bytes = Buffer.from(JSON.stringify(value)), parts = path.split('/');
    let parent = table;
    for (const part of parts.slice(0, -1)) parent = parent.files[part] ??= { files: {} };
    parent.files[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    contents.push(bytes); offset += bytes.length;
  }
  const header = Buffer.from(JSON.stringify(table)), lead = Buffer.alloc(16);
  lead.writeUInt32LE(header.length + 8, 4); lead.writeUInt32LE(header.length, 12);
  const archive = join(resources, 'app.asar');
  write(archive, Buffer.concat([lead, header, ...contents]));
  const bytes = Buffer.from('synthetic installer fixture, not an official asset');
  const feed = Buffer.from(JSON.stringify({ version, files: [{
    url: `deepseek-harness-${version}-${mac ? 'mac-arm64.zip' : 'win-x64.exe'}`,
    sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length,
  }] }));
  const receipt = version === '0.2.0-rc.2' ? null : {
    schemaVersion: 1, kind: 'verified-runtime-candidate',
    asset: verifyHostAsset(desktopCandidates(feed, mac ? 'macos-desktop' : 'windows-desktop')[0], bytes),
    files: Object.fromEntries(Object.entries({ executable, archive, fuseBinary: fuse }).map(([role, path]) =>
      [role, { path: relative(root, path).split(sep).join('/'), sha256: sha256(readFileSync(path)) }])),
  };
  const runtimeReceiptPath = join(root, 'runtime-receipt.json');
  const saveReceipt = () => {
    const content = Buffer.from(JSON.stringify(receipt));
    write(runtimeReceiptPath, content);
    return { runtimeReceiptPath, runtimeReceiptSha256: sha256(content) };
  };
  return { root, executable, archive, receipt, saveReceipt, runRoot: root + '-run',
    options: receipt ? saveReceipt() : {} };
}

function desktopGatePreflight(script, argv) {
  const source = readFileSync(new URL('../scripts/' + script, import.meta.url), 'utf8');
  const start = source.indexOf('const { args: inputArguments, runtimeOptions } = parseRuntimeReceiptArguments(');
  const end = source.indexOf('const packageReceipt =');
  assert.ok(start >= 0 && end > start, 'locate only the side-effect-free gate argument preflight');
  const searchLog = script === 'verify-search-log-desktop.mjs';
  const evaluate = new Function('process', 'assert', 'resolve', 'parseRuntimeReceiptArguments', 'readDesktopGateRuntimes',
    source.slice(start, end) + '\nreturn { runtimeOptions, runtimes: ' + (searchLog ? 'runtimes' : '[runtime]') + ' };');
  const parsed = evaluate({ argv: ['node', script, ...argv] }, assert, resolve,
    desktopPreparation.parseRuntimeReceiptArguments, desktopPreparation.readDesktopGateRuntimes);
  const call = /prepareDesktopFixture\([^;]+?\);/.exec(source);
  assert.ok(call, 'locate the actual preparation call without launching a gate');
  const prepare = new Function('prepareDesktopFixture', 'runtime', 'runtimeOptions', 'folder', 'root', 'executable', call[0]);
  const calls = [];
  for (const runtime of parsed.runtimes) {
    prepare((...args) => calls.push(args), runtime, parsed.runtimeOptions, '/fixture-output', '/fixture-output', runtime.executable);
  }
  return { ...parsed, calls };
}

function b2GatePreflight(script, argv, env = {}) {
  const source = readFileSync(new URL('../scripts/' + script, import.meta.url), 'utf8');
  const start = source.indexOf('const { args: inputArguments, runtimeOptions } = parseRuntimeReceiptArguments(');
  const end = source.indexOf('const { runId, directory } = freshRun(');
  assert.ok(start >= 0 && end > start, 'locate B2 argument preflight before any run, process or install');
  const evaluate = new Function('process', 'assert', 'resolve', 'existsSync', 'parseRuntimeReceiptArguments',
    'readDesktopGateRuntimes', 'createSharedConfigStore', 'sha256',
    source.slice(start, end) + '\nreturn { options, runtimeOptions, runtimes, productTarball,'
      + ' upgradeToRuntime: typeof upgradeToRuntime === "undefined" ? null : upgradeToRuntime,'
      + ' upgradeToRuntimeOptions: typeof upgradeToRuntimeOptions === "undefined" ? {} : upgradeToRuntimeOptions };');
  return evaluate({ argv: ['node', script, ...argv], env }, assert, resolve, () => true,
    desktopPreparation.parseRuntimeReceiptArguments, desktopPreparation.readDesktopGateRuntimes,
    () => ({ readEffective: () => ({ grok_api_key: { value: '' }, openai_compatible_api_key: { value: '' },
      grok_auth_mode: { value: 'api_key' } }) }), () => 'a'.repeat(64));
}

async function b2PreparationCommand(runtime, runtimeOptions, upgradeToRuntime = null, upgradeToRuntimeOptions = {}) {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function prepare(runtime, folder) {');
  const end = source.indexOf('async function start(runtime, folder, phase) {', start);
  assert.ok(start >= 0 && end > start);
  const calls = [], output = join(sandbox, 'b2-prepare-not-run');
  const prepare = new Function('join', 'project', 'process', 'commandResult', 'writeJson', 'directory',
    'receipt', 'assert', 'sanitize', 'upgradeFrom', 'runtimeOptions', 'upgradeToRuntime', 'upgradeToRuntimeOptions',
    source.slice(start, end) + '\nreturn prepare;')(
    join, sandbox, { execPath: 'synthetic-node' }, async (command, args, options) => {
      calls.push({ command, args, options });
      return { exitCode: 0, timedOut: false, rawStdout: '{"dependencyInstall":false,"originalAsarUnmodified":true}' };
    }, () => {}, sandbox, value => value, assert, value => value, null, runtimeOptions, upgradeToRuntime, upgradeToRuntimeOptions);
  await prepare(runtime, output);
  assert.equal(calls.length, 1);
  assert.equal(existsSync(output), false, 'the command stub never creates a Desktop profile or starts preparation');
  return calls[0];
}

function upgradePackage(version, receiptVersion = version) {
  const folder = mkdtempSync(join(sandbox, 'upgrade-package-'));
  const manifest = Buffer.from(JSON.stringify({ name: 'dsh-grok-search', version }));
  const header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write(manifest.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  const data = gzipSync(Buffer.concat([header, manifest, Buffer.alloc((512 - manifest.length % 512) % 512), Buffer.alloc(1024)]));
  const path = join(folder, 'package.tgz');
  writeFileSync(path, data, { flag: 'wx' });
  writeFileSync(join(folder, 'package-receipt.json'), JSON.stringify({
    version: receiptVersion, sha256: createHash('sha256').update(data).digest('hex'),
    sourceHashes: [{ file: 'package.json', sha256: createHash('sha256').update(manifest).digest('hex') }],
  }), { flag: 'wx' });
  return path;
}

test('upgrade inputs use the actual archive and receipt versions, rejecting relabelled distributions', () => {
  for (const version of ['0.2.0', '0.2.1', '0.3.0']) {
    const pkg = readUpgradePackage(upgradePackage(version));
    assert.equal(pkg.manifest.version, version);
    assert.equal(pkg.receipt.version, version);
  }
  assert.throws(() => readUpgradePackage(upgradePackage('0.2.1', '0.3.0')), /version/);
  const changed = upgradePackage('0.3.0');
  writeFileSync(changed, 'different package bytes');
  assert.throws(() => readUpgradePackage(changed), /receipt/);
});

test('upgrade receipt hashes must describe actual archive files instead of an unchecked claimed source list', () => {
  for (const hash of [{ file: 'package.json', sha256: '0'.repeat(64) },
    { file: '../outside.json', sha256: '0'.repeat(64) }]) {
    const path = upgradePackage('0.3.0'), receiptPath = join(path, '../package-receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipt.sourceHashes = [hash];
    writeFileSync(receiptPath, JSON.stringify(receipt));
    assert.throws(() => readUpgradePackage(path), /receipt|source|archive/i);
  }
});

test('native update registry advertises exactly the supplied historical or current upgrade pair', () => {
  for (const versions of [['0.2.0', '0.2.1'], ['0.2.1', '0.3.0']]) {
    const packages = versions.map(version => readUpgradePackage(upgradePackage(version)));
    const metadata = nativeUpdateMetadata(packages, 'http://127.0.0.1:12345');
    assert.equal(metadata['dist-tags'].latest, versions[1]);
    assert.deepEqual(Object.keys(metadata.versions), versions);
    assert.deepEqual(Object.keys(metadata.time).filter(key => !['created', 'modified'].includes(key)), versions);
    for (const pkg of packages) {
      const distribution = metadata.versions[pkg.manifest.version];
      assert.equal(distribution.dist.tarball, 'http://127.0.0.1:12345/tar/dsh-grok-search/' + pkg.manifest.version);
      assert.equal(distribution.dist.integrity, 'sha512-' + createHash('sha512').update(pkg.data).digest('base64'));
    }
  }
  const same = readUpgradePackage(upgradePackage('0.3.0'));
  assert.throws(() => nativeUpdateMetadata([same, same], 'http://127.0.0.1:12345'), /distinct/);
});

test('native update may seed an unchanged old package on rc.1 but never downgrade its host data', () => {
  assert.deepEqual(nativeUpdateHostStages('0.2.2-rc.1'), ['0.2.2-rc.1']);
  assert.deepEqual(nativeUpdateHostStages('0.2.2-rc.2', '0.2.2-rc.1'),
    ['0.2.2-rc.1', '0.2.2-rc.2']);
  assert.throws(() => nativeUpdateHostStages('0.2.2-rc.1', '0.2.2-rc.2'), /forward/);
  assert.throws(() => nativeUpdateHostStages('0.2.2-rc.3'));
  const source = readFileSync(new URL('../scripts/verify-native-update.mjs', import.meta.url), 'utf8');
  assert.match(source, /Install the unchanged historical package on a compatible baseline host/);
  assert.match(source, /sameProfile: true, sameUserData: true/);
});

function nativeOutcomeFixture(scenario = 'success') {
  const updated = ['success', 'disabled'].includes(scenario);
  const disabled = scenario === 'disabled';
  const baseline = { label: 'old-installed', installedVersion: '0.2.1', hostVersion: '0.2.2-rc.1',
    enabled: !disabled, mismatched: [], configAndCacheUnchanged: true, originalSearches: 0,
    fetchProvider: 'original-fetch', searchProvider: disabled ? 'original-search' : 'grok-search',
    programPhase: disabled ? null : 'ready', programSource: disabled ? null : 'private-cache' };
  const final = { ...baseline, label: 'final', installedVersion: updated ? '0.3.0' : '0.2.1' };
  const search = { method: 'session-search', sessionCompleted: true, toolResultSucceeded: true,
    logRecords: 1, actualSources: ['tavily'], originalSearchDelta: 0 };
  return { scenario, oldVersion: '0.2.1', targetVersion: '0.3.0', hostVersion: '0.2.2-rc.1',
    checkpoints: [baseline, ...(updated ? [{ ...final, label: 'after-restart' }] : []), final],
    operations: [...(updated ? [{ method: 'desktop-restart' }] : []),
      ...(disabled ? [] : [search, ...(updated ? [{ ...search }] : [])]),
      ...(scenario === 'cancel-download' ? [{ method: 'pluginManager/updateBundle', pending: false,
        result: { result: { application: 'cancelled' }, restore: { application: 'applied' } } }] : [])],
    requests: [{ kind: 'tarball', version: '0.3.0', fault: scenario }],
  };
}

test('native update acceptance requires the actual final version, restart and Session evidence', () => {
  for (const scenario of ['success', 'disabled', 'download-failed', 'activation-failed', 'cancel-download']) {
    const fixture = nativeOutcomeFixture(scenario);
    assert.equal(validateNativeUpdateOutcome(fixture).outcome,
      ['success', 'disabled'].includes(scenario) ? 'updated' : 'restored');
  }
  const incomplete = nativeOutcomeFixture();
  incomplete.checkpoints.pop();
  assert.throws(() => validateNativeUpdateOutcome(incomplete), /final state/);
  const notUpdated = nativeOutcomeFixture();
  notUpdated.checkpoints.at(-1).installedVersion = '0.2.1';
  assert.throws(() => validateNativeUpdateOutcome(notUpdated), /target version/i);
  const noRestart = nativeOutcomeFixture();
  noRestart.operations = noRestart.operations.filter(row => row.method !== 'desktop-restart');
  assert.throws(() => validateNativeUpdateOutcome(noRestart), /real host restart/);
  const noSearch = nativeOutcomeFixture();
  noSearch.operations = noSearch.operations.filter(row => row.method !== 'session-search');
  assert.throws(() => validateNativeUpdateOutcome(noSearch), /Real Session searches/);
});

test('native update never labels a missing or incompatible rollback as passing', () => {
  const missing = nativeOutcomeFixture('download-failed');
  Object.assign(missing.checkpoints.at(-1), { installedVersion: null, enabled: null });
  assert.throws(() => validateNativeUpdateOutcome(missing), /enabled state|original plugin/);
  const mismatched = nativeOutcomeFixture('activation-failed');
  mismatched.checkpoints.at(-1).mismatched = ['src/bundle.mjs'];
  assert.throws(() => validateNativeUpdateOutcome(mismatched), /receipt/);
  const unsent = nativeOutcomeFixture('download-failed');
  unsent.requests = [];
  assert.throws(() => validateNativeUpdateOutcome(unsent), /request the target distribution/);
  const cancelled = nativeOutcomeFixture('cancel-download');
  cancelled.operations.at(-1).pending = true;
  assert.throws(() => validateNativeUpdateOutcome(cancelled), /finish before/);
});

test('disabled native update preserves the original route and never starts a search', () => {
  const fixture = nativeOutcomeFixture('disabled');
  fixture.requests.push({ kind: 'search' });
  assert.throws(() => validateNativeUpdateOutcome(fixture), /must not send a search/);
  fixture.requests.pop();
  fixture.checkpoints.at(-1).programPhase = 'ready';
  assert.throws(() => validateNativeUpdateOutcome(fixture), /must not start its program/);
});

test('retained upgrade cache preserves the prior receipt and rejects changed binary data', () => {
  const source = mkdtempSync(join(sandbox, 'old-cache-'));
  mkdirSync(join(source, 'verified'));
  const binary = join(source, 'verified/grok-search-rs.exe');
  writeFileSync(binary, 'unit-test cache bytes', { flag: 'wx' });
  const record = { version: '0.1.26', executable: 'verified/grok-search-rs.exe',
    sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), mcpHandshakeValidated: true };
  writeFileSync(join(source, 'active.json'), JSON.stringify(record), { flag: 'wx' });
  writeFileSync(join(source, 'verified/receipt.json'), JSON.stringify(record), { flag: 'wx' });
  const target = join(sandbox, 'retained-profile-cache');
  const retained = retainUpgradeCache(source, target);
  assert.equal(retained.length, 3);
  for (const row of retained) assert.deepEqual(readFileSync(row.to), readFileSync(row.from));
  assert.throws(() => retainUpgradeCache(source, target), /EEXIST/);
  writeFileSync(binary, 'changed prior cache');
  const rejected = join(sandbox, 'rejected-profile-cache');
  assert.throws(() => retainUpgradeCache(source, rejected), /differs from its receipt/);
  assert.equal(existsSync(rejected), false);
});

test('retained upgrade cache rejects a linked version directory before copying its files', () => {
  const source = mkdtempSync(join(sandbox, 'linked-cache-'));
  const outside = mkdtempSync(join(sandbox, 'cache-outside-'));
  const record = { version: '0.1.26', executable: 'verified/grok-search-rs.exe',
    sha256: createHash('sha256').update('cache bytes').digest('hex'), mcpHandshakeValidated: true };
  writeFileSync(join(outside, 'grok-search-rs.exe'), 'cache bytes');
  writeFileSync(join(outside, 'receipt.json'), JSON.stringify(record));
  symlinkSync(outside, join(source, 'verified'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(source, 'active.json'), JSON.stringify(record));
  const target = join(sandbox, 'linked-cache-target');
  assert.throws(() => retainUpgradeCache(source, target), /link/i);
  assert.equal(existsSync(target), false);
});

test('upgrade cleanup still waits for the owned process after its close RPC rejects', async () => {
  let ended = false, killed = false, complete;
  const closed = new Promise(done => { complete = done; });
  const failure = new Error('close RPC disconnected');
  await assert.rejects(upgradeVerifier.closeUpgradeHost({
    request: async () => { throw failure; }, closed, ended: () => ended, exitCode: () => null,
    kill: () => { killed = true; queueMicrotask(() => { ended = true; complete(); }); },
  }, 100), error => error === failure);
  assert.equal(killed, true);
  assert.equal(ended, true, 'cleanup must observe actual exit before returning the error');
});

test('native update closes its owned process even without a renderer or after a checkpoint failure', async () => {
  for (const checkpointFails of [false, true]) {
    let ended = false, requested = false, complete;
    const closed = new Promise(done => { complete = done; });
    const checkpointError = new Error('checkpoint failed');
    const result = finishNativeUpdate({
      process: {
        request: async () => { requested = true; ended = true; complete(); }, closed,
        ended: () => ended, exitCode: () => 0, kill: () => assert.fail('normal close must not kill'),
      },
      checkpoint: checkpointFails ? async () => { throw checkpointError; } : null,
    });
    if (checkpointFails) await assert.rejects(result, error => error === checkpointError);
    else await result;
    assert.equal(requested, true);
    assert.equal(ended, true);
  }
});

test('原生首装验证仅在宿主正常退出后生成通过摘要', async () => {
  const source = readFileSync(new URL('../scripts/verify-rc5-user-path.mjs', import.meta.url), 'utf8');
  const closing = source.slice(source.lastIndexOf('} finally {\n  renderer?.close();'));
  assert.ok(closing.startsWith('} finally {'));
  assert.ok(closing.indexOf('assert.equal(exit.code, 0') < closing.indexOf('result.passed = true'));
  assert.ok(closing.indexOf('assert.equal(exit.signal, null') < closing.indexOf('result.passed = true'));
  const execute = new Function('assert', 'renderer', 'requestDesktopShutdown', 'port', 'closed',
    'writeJson', 'join', 'run', 'quotaServer', 'result',
    `return (async () => { try { ${closing} })();`);
  for (const [exit, shutdownFailure] of [
    [{ code: 0, signal: null }, null],
    [{ code: 1, signal: null }, null],
    [{ code: null, signal: 'SIGTERM' }, null],
    [{ code: 0, signal: null }, new Error('synthetic shutdown timeout')],
  ]) {
    const evidence = [];
    let quotaClosed = false;
    const result = {};
    const verification = execute(assert, { close() {} },
      async () => { if (shutdownFailure) throw shutdownFailure; }, 1234, Promise.resolve(exit),
      (path, value) => evidence.push({ path, value }), join, { directory: '/isolated-fixture' },
      { closeAllConnections() {}, close(done) { quotaClosed = true; done(); } }, result);
    const successful = exit.code === 0 && exit.signal === null && !shutdownFailure;
    if (successful) await verification;
    else await assert.rejects(verification);
    assert.equal(quotaClosed, true, 'the local quota fixture closes even after a shutdown failure');
    assert.equal(evidence.some(row => row.path.endsWith('summary.json')), successful);
    assert.equal(result.passed === true, successful);
    if (!shutdownFailure) assert.deepEqual(evidence[0].value, exit, 'failed exit diagnostics are retained');
  }
});

test('B2 settings snapshot pins the current idle test-button label', () => {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  assert.match(source, /testButton:\s*root\.querySelector\('#testBtn'\)\?\.textContent\.trim\(\)\s*===\s*'测试连接'/);
  assert.doesNotMatch(source, /testButton:[^\n]*includes\(['"]测试搜索['"]\)/);
});

test('B2 detail verifies the description from the actual candidate instead of an obsolete sentence', () => {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  assert.match(source, /installedUi\.detail\.text\.includes\(expectedProduct\.manifest\.description\)/);
  assert.doesNotMatch(source, /assert\.match\(installedUi\.detail\.text, \/用 Grok 接管/);
});

function b2PluginManagerRendererFixture({ frames = [{ view: 'list' }], returnedFrames = [{ view: 'list' }],
  detailFrames = [{ view: 'detail' }], vanishAfterListReady = false } = {}) {
  const events = [], waits = [], diagnostics = [];
  let phase = 'outside', index = 0, actionGone = false, closed = false;
  const frame = () => phase === 'outside' ? { view: 'outside' }
    : (phase === 'opened' ? frames : phase === 'returned' ? returnedFrames : detailFrames)
      [Math.min(index, (phase === 'opened' ? frames : phase === 'returned' ? returnedFrames : detailFrames).length - 1)];
  const element = (aria, { hidden = false, disabled = false, ariaDisabled = false, click = () => {} } = {}) => ({
    innerText: aria, disabled, title: '', click,
    getAttribute: name => name === 'aria-label' ? aria : name === 'aria-disabled' && ariaDisabled ? 'true' : null,
    getClientRects: () => hidden ? [] : [{}],
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const activate = (name, next) => {
    events.push({ name, frame: { ...frame() } });
    phase = next; index = 0;
  };
  const buttons = () => {
    const current = frame(), items = [element('插件', { click: () => activate('navigate', 'opened') })];
    if (current.view === 'detail') items.push(element('返回插件', { click: () => activate('back', 'returned') }));
    if (current.view === 'list' && current.action !== 'missing' && !actionGone) {
      items.push(element('查看 dsh-grok-search', {
        hidden: current.action === 'hidden', disabled: current.action === 'disabled',
        ariaDisabled: current.action === 'aria-disabled', click: () => activate('open-detail', 'detail'),
      }));
    }
    return items;
  };
  const detail = {
    innerText: 'dsh-grok-search installed detail',
    getAttribute: name => name === 'data-plugin-detail' ? 'dsh-grok-search' : null,
    getClientRects: () => frame().hiddenDetail ? [] : [{}],
    querySelectorAll: () => [element('卸载 dsh-grok-search')],
  };
  const layer = { shadowRoot: {
    querySelector: () => null,
    querySelectorAll: selector => selector === '[role="dialog"]' && frame().shadowDialog ? [element('pending')] : [],
  } };
  const document = {
    title: 'Harness fixture', visibilityState: 'visible',
    body: { get innerText() {
      return frame().view === 'detail' ? 'dsh-grok-search\nGrok configuration'
        : 'Plugin Manager Installed\n' + (frame().view === 'list' ? 'dsh-grok-search' : '');
    } },
    querySelectorAll: selector => selector === 'button' || selector === 'button,[role="button"]' ? buttons()
      : selector === '[role="dialog"],[data-plugin-loading]'
        ? [frame().dialog, frame().loading].filter(Boolean).map(() => element('pending'))
        : selector === '[role="dialog"]' ? frame().dialog ? [element('pending')] : []
        : selector === '[data-plugin-loading]' ? frame().loading ? [element('pending')] : []
        : selector === '[data-plugin-detail]' ? frame().view === 'detail' ? [detail] : []
        : [],
    querySelector: selector => selector === '[data-dsg-layer]' ? layer : selector.startsWith('[data-plugin-detail=')
      && frame().view === 'detail' && frame().mounted !== false ? detail : null,
  };
  const renderer = {
    send: async () => {},
    evaluate: async expression => new Function('document', 'location', 'return ' + expression)(
      document, { href: 'http://fixture.invalid/' }),
    close: () => { closed = true; },
  };
  const wait = async (current, predicate) => {
    const attempts = [];
    waits.push(attempts);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = await predicate(current);
      attempts.push({ ...frame(), ready: Boolean(value) });
      if (value) {
        if (vanishAfterListReady && waits.length === 3) actionGone = true;
        return value;
      }
      index += 1;
    }
    throw new Error('Renderer condition did not become true.');
  };
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function pluginManagerRendererSnapshot(host) {');
  const end = source.indexOf('\nasync function settingsStopRendererFlow(', start);
  assert.ok(start >= 0 && end > start, 'extract only the native Plugin Manager navigation, without running a host');
  const snapshot = new Function('assert', 'connectRenderer', 'waitForRenderer', 'writeJson', 'join',
    'directory', 'safe', 'randomUUID', source.slice(start, end) + '\nreturn pluginManagerRendererSnapshot;')(
      assert, async () => renderer, wait, (file, value) => diagnostics.push({ file, value }), join,
      '/fixture-evidence', value => value, () => 'fixture-id');
  return { run: () => snapshot({ debuggerPort: 0, prefix: 'fixture-host' }), events, waits, diagnostics,
    get closed() { return closed; } };
}

test('B2 Plugin Manager waits for the visible enabled installed action instead of a stale heading', async () => {
  const fixture = b2PluginManagerRendererFixture({ frames: [
    { view: 'list', action: 'missing' }, { view: 'list', action: 'hidden' },
    { view: 'list', action: 'disabled' }, { view: 'list', action: 'aria-disabled' }, { view: 'list' },
  ] });
  const result = await fixture.run();
  assert.equal(result.list.buttons.find(item => item.aria === '查看 dsh-grok-search').visible, true);
  assert.equal(result.detail.text, 'dsh-grok-search installed detail');
  assert.deepEqual(fixture.events.map(event => event.name), ['navigate', 'open-detail']);
  assert.equal(fixture.waits[1].length, 5);
  assert.equal(fixture.closed, true);
});

test('B2 Plugin Manager returns a delayed retained package detail without requiring the list heading', async () => {
  const fixture = b2PluginManagerRendererFixture({ frames: [
    { view: 'list', dialog: true }, { view: 'detail', loading: true }, { view: 'detail' },
  ], returnedFrames: [{ view: 'list', action: 'missing' }, { view: 'list', action: 'hidden' }, { view: 'list' }] });
  await fixture.run();
  assert.deepEqual(fixture.events.map(event => event.name), ['navigate', 'back', 'open-detail']);
  assert.deepEqual(fixture.events[1].frame, { view: 'detail' });
  assert.equal(fixture.waits[1].length, 3);
  assert.equal(fixture.waits[2].length, 3);
});

test('B2 Plugin Manager does not click a row while the native dialog or loading surface remains visible', async () => {
  const fixture = b2PluginManagerRendererFixture({ frames: [
    { view: 'list', dialog: true }, { view: 'list', loading: true }, { view: 'list' },
  ] });
  await fixture.run();
  assert.deepEqual(fixture.events.find(event => event.name === 'open-detail').frame, { view: 'list' });
});

test('B2 Plugin Manager never navigates away from a visible production shadow dialog', async () => {
  const delayed = b2PluginManagerRendererFixture({ frames: [
    { view: 'detail', shadowDialog: true }, { view: 'detail' },
  ] });
  await delayed.run();
  assert.deepEqual(delayed.events.find(event => event.name === 'back').frame, { view: 'detail' });
  const blocked = b2PluginManagerRendererFixture({ frames: [{ view: 'detail', shadowDialog: true }] });
  await assert.rejects(blocked.run(), /Renderer condition did not become true/);
  assert.deepEqual(blocked.events.map(event => event.name), ['navigate']);
  assert.equal(blocked.diagnostics[0].value.after.settingsLayers[1].dialogs.length, 1);
});

test('B2 Plugin Manager requires a visible mounted package detail before using its breadcrumb', async () => {
  for (const frame of [{ view: 'detail', mounted: false }, { view: 'detail', hiddenDetail: true }]) {
    const fixture = b2PluginManagerRendererFixture({ frames: [frame] });
    await assert.rejects(fixture.run(), /Renderer condition did not become true/);
    assert.deepEqual(fixture.events.map(event => event.name), ['navigate']);
  }
});

test('B2 Plugin Manager preserves a bounded failure when its installed action never becomes usable', async () => {
  for (const action of ['missing', 'hidden', 'disabled', 'aria-disabled']) {
    const fixture = b2PluginManagerRendererFixture({ frames: [{ view: 'list', action }] });
    await assert.rejects(fixture.run(), /Renderer condition did not become true/);
    assert.deepEqual(fixture.events.map(event => event.name), ['navigate']);
    assert.equal(fixture.waits[1].length, 8);
    assert.equal(fixture.diagnostics[0].value.step, 'manager-surface-ready');
    assert.equal(fixture.diagnostics[0].value.inputValuesIncluded, false);
    assert.equal(fixture.closed, true);
  }
});

test('B2 Plugin Manager records only safe structural navigation diagnostics before closing on a blocked dialog', async () => {
  const fixture = b2PluginManagerRendererFixture({ frames: [{ view: 'list', dialog: true }] });
  await assert.rejects(fixture.run(), /Renderer condition did not become true/);
  const { file, value } = fixture.diagnostics[0];
  assert.match(file, /fixture-host-plugin-manager-ui-failure-fixture-id\.json$/);
  assert.equal(value.before.dialogs.length, 0);
  assert.equal(value.after.dialogs.length, 1);
  assert.equal(value.after.buttons.find(button => button.label === '查看 dsh-grok-search').disabled, false);
  assert.equal(value.step, 'manager-surface-ready');
  assert.equal(value.inputValuesIncluded, false);
  assert.equal('text' in value.after, false);
  assert.equal('href' in value.after, false);
  assert.equal(fixture.closed, true);
});

test('B2 Plugin Manager retains the detail-action assertion if the row disappears after readiness', async () => {
  const fixture = b2PluginManagerRendererFixture({ vanishAfterListReady: true });
  await assert.rejects(fixture.run(), /Installed dsh-grok-search detail action was not visible/);
  assert.deepEqual(fixture.events.map(event => event.name), ['navigate']);
  assert.equal(fixture.closed, true);
});

test('B2 Plugin Manager requires the clicked detail to be actually visible and closes on failure', async () => {
  const delayed = b2PluginManagerRendererFixture({ detailFrames: [
    { view: 'detail', mounted: false }, { view: 'detail', hiddenDetail: true }, { view: 'detail' },
  ] });
  await delayed.run();
  assert.equal(delayed.waits[3].length, 3);
  const hidden = b2PluginManagerRendererFixture({ detailFrames: [{ view: 'detail', hiddenDetail: true }] });
  await assert.rejects(hidden.run(), /Renderer condition did not become true/);
  assert.equal(hidden.closed, true);
});

test('macOS contract gates execute frozen-package probes with official Electron instead of ordinary Node', () => {
  const source = readFileSync(new URL('../.github/workflows/macos-beta-gate.yml', import.meta.url), 'utf8');
  for (const name of ['verify-search-execution-host', 'verify-github-read-host']) {
    assert.match(source, new RegExp('ELECTRON_RUN_AS_NODE=1 "\\$APP/MacOS/DeepSeek Harness" --expose-internals scripts/' + name + '\\.mjs'));
  }
  assert.match(source, /host-contract-package\/package/);
  assert.match(source, /ln -s "\$GITHUB_WORKSPACE\/node_modules" "\$RUNNER_TEMP\/host-contract-package\/package\/node_modules"/);
  assert.match(source, /assert\.equal\(result\.cases\.length, name === 'search' \? 11 : 25\)/);
  assert.match(source, /artifacts\/host-execution-contracts\/\*\*\/\*\.json/);
});

test('Desktop replay waits for the reduced-motion change listener and measures visible chat cards', () => {
  const source = readFileSync(new URL('../scripts/verify-search-log-desktop.mjs', import.meta.url), 'utf8');
  const replay = source.slice(source.indexOf("mode = 'mcp-' + provider") - 600,
    source.indexOf("mode = 'mcp-' + provider"));
  assert.match(replay, /prefers-reduced-motion/);
  assert.match(replay, /#historyBar/);
  assert.match(replay, /#historyStage/);
  assert.match(source, /followStreamingSearchCard\.toString\(\)/);
  assert.match(source, /if\(streaming\.open&&streaming\.card\?\.isConnected&&streaming\.card\.dataset\.visible==='true'\)data\.streamFrames\+\+/);
});

test('B2 all-failed diagnostics require the exact search-failure summary and zero connected sources', () => {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  assert.match(source, /failed\.status\s*===\s*'最近检查未通过'\s*&&\s*failed\.announcer\.includes\('搜索未通过'\)\s*&&\s*failed\.announcer\.includes\('0\/4 项连通'\)/);
  assert.doesNotMatch(source, /failed\.announcer\.includes\(['"]测试未通过['"]\)/);
});

test('old Session verification pins its original inclusive cursor across host restart', async () => {
  const retained = { sessionId: 'old-session', cursor: 3, records: [{ seq: 3, type: 'turn/end' }] };
  const calls = [];
  const host = { async rpc(method, request) {
    calls.push({ method, request });
    return { cursor: request.throughSeq ?? 4, records: request.throughSeq === 3
      ? retained.records : [...retained.records, { seq: 4, type: 'session/title' }], hasMore: false };
  } };
  await upgradeVerifier.readRetainedSession(host, retained);
  assert.deepEqual(calls, [{ method: 'session/page', request: {
    address: { kind: 'session', sessionId: 'old-session' }, throughSeq: 3, maxMessages: 100,
  } }]);
});

function b2RetainedSessionFixture() {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function authenticateModelSession(host) {');
  const end = source.indexOf('function managerNames(state) {', start);
  assert.ok(start >= 0 && end > start);
  const records = [], requests = [];
  let generation = 0;
  const state = { auth: 0, creates: 0, instanceId: 'synthetic-host-0', completed: 0, sessionEvents: [],
    calls: { original: 0, fetch: 0 }, pageError: null, pageOverride: null, cursorless: false };
  const snapshot = () => structuredClone({
    instanceId: state.instanceId, completed: state.completed, sessionEvents: state.sessionEvents, calls: state.calls,
  });
  const makeHost = () => ({ address: { hostOrigin: 'http://127.0.0.1:19998' }, control: { workspace: sandbox },
    async probe(op) {
      if (op === 'model-auth') { state.auth++; return { url: 'http://127.0.0.1:19998/auth' }; }
      assert.equal(op, 'snapshot'); return snapshot();
    } });
  const fetch = async (url, options) => {
    if (url.endsWith('/auth')) {
      requests.push({ endpoint: 'auth' });
      return { status: 303, headers: new Map([['set-cookie', 'synthetic-session-cookie=value; HttpOnly']]) };
    }
    const { method: endpoint, payload } = JSON.parse(options.body), request = payload.args.request;
    requests.push({ endpoint, request });
    assert.equal(options.headers.Cookie, 'synthetic-session-cookie=value');
    assert.equal(options.headers.Origin, 'http://127.0.0.1:19998');
    let value;
    if (endpoint === 'session/create') { state.creates++; value = { sessionId: 'synthetic-old-session' }; }
    else if (endpoint === 'session/page') {
      if (state.pageError) throw state.pageError;
      assert.ok(Number.isSafeInteger(request.throughSeq), 'The old history owner requires throughSeq.');
      const cursor = request.throughSeq;
      value = state.pageOverride ?? { cursor, records: records.filter(row => row.event.seq <= cursor), hasMore: false };
      value = structuredClone(value);
      if (state.cursorless) delete value.cursor;
    } else {
      assert.equal(endpoint, 'session/prompt');
      const turn = ++state.completed, mode = request.content[0].text;
      const events = [
        ...(mode === 'chat' ? [] : [{ type: 'tool/result', data: {
          turn, message: { isError: false, content: [{ type: 'text', text: 'isolated first-use synthetic source' }] },
        } }]),
        { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: '内部候选轮次完成' }] } } },
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      ];
      for (const event of events) {
        const full = { seq: records.length, ...event };
        records.push({ type: 'event', event: full });
        state.sessionEvents.push({ sessionId: request.sessionId, ...full });
      }
      value = {};
    }
    return { async json() { return { result: { ok: true, value } }; } };
  };
  const api = new Function('assert', 'fetch', 'AbortSignal', 'sourceOnlyConfig', 'sleep', 'createHash', 'readRetainedSession',
    'adaptRetainedSessionRpc', 'canonicalRetainedSessionCut', 'createRetainedSessionReader',
    'let serial = 0;\n' + source.slice(start, end) + '\nreturn { authenticateModelSession, modelTurn, retainedSessionIdentity,'
    + ' captureRetainedUpgradeSession, readRetainedUpgradePage, restoreRetainedUpgradeSession };')(
    assert, fetch, AbortSignal, false, async () => { throw new Error('The fixture should complete on its first observation.'); },
    createHash, upgradeVerifier.readRetainedSession, adaptRetainedSessionRpc, canonicalRetainedSessionCut, createRetainedSessionReader);
  return { api, host: makeHost(), state, requests, records, source,
    reboot() {
      state.instanceId = 'synthetic-host-' + (++generation);
      state.sessionEvents = []; state.completed = 0;
      return makeHost();
    } };
}

test('B2 modelTurn authenticates a retained Session without replacing its ID', async () => {
  const fixture = b2RetainedSessionFixture();
  fixture.host.modelSession = 'already-persisted-session';
  const first = await fixture.api.modelTurn(fixture.host, 'search');
  const second = await fixture.api.modelTurn(fixture.host, 'chat');
  assert.equal(first.sessionId, 'already-persisted-session');
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(fixture.state.auth, 1);
  assert.equal(fixture.state.creates, 0);
  assert.deepEqual(fixture.requests.filter(row => row.endpoint === 'session/prompt')
    .map(row => row.request.sessionId), ['already-persisted-session', 'already-persisted-session']);
});

test('B2 ordinary model turns still create one Session and reuse it for search, fetch and chat', async () => {
  const fixture = b2RetainedSessionFixture();
  const values = [];
  for (const mode of ['search', 'fetch', 'chat']) values.push(await fixture.api.modelTurn(fixture.host, mode));
  assert.equal(fixture.state.auth, 1);
  assert.equal(fixture.state.creates, 1);
  assert.ok(values.every(value => value.sessionId === 'synthetic-old-session' && !value.isError));
  assert.deepEqual(fixture.requests.map(row => row.endpoint),
    ['auth', 'session/create', 'session/prompt', 'session/prompt', 'session/prompt']);
});

test('B2 captures a real completed bounded history and hashes its original cut without later mutation', async () => {
  const fixture = b2RetainedSessionFixture(), receipt = { version: '0.3.0', sha256: 'a'.repeat(64) };
  await fixture.api.modelTurn(fixture.host, 'search');
  const retained = await fixture.api.captureRetainedUpgradeSession(fixture.host, receipt, '0.2.2-rc.2');
  const original = structuredClone(retained.records);
  assert.equal(retained.sessionId, 'synthetic-old-session');
  assert.equal(retained.cursor, original.length - 1);
  assert.equal(retained.recordsSha256, sha256(JSON.stringify(original)));
  assert.deepEqual(fixture.api.retainedSessionIdentity(retained), {
    sessionId: retained.sessionId, throughSeq: retained.cursor, recordCount: original.length,
    recordsSha256: retained.recordsSha256, seededHostVersion: '0.2.2-rc.2',
    seededPluginVersion: '0.3.0', seededPackageSha256: receipt.sha256, seedInstanceId: 'synthetic-host-0',
    seedCutProof: retained.cut, seedHistoryRead: retained.historyRead,
  });
  await fixture.api.modelTurn(fixture.host, 'chat');
  assert.deepEqual(retained.records, original);
  for (const page of [{ cursor: 1, records: [], hasMore: false },
    { cursor: 1.5, records: original, hasMore: false }, { cursor: 1, records: original, hasMore: true }]) {
    fixture.state.pageOverride = page;
    await assert.rejects(fixture.api.captureRetainedUpgradeSession(fixture.host, receipt, '0.2.2-rc.2'));
  }
  fixture.state.pageOverride = null; fixture.state.sessionEvents = [];
  await assert.rejects(fixture.api.captureRetainedUpgradeSession(fixture.host, receipt, '0.2.2-rc.2'), /completed turn/);
});

test('B2 cold read authenticates after restart, verifies the old inclusive cut, then searches the same ID', async () => {
  const fixture = b2RetainedSessionFixture();
  await fixture.api.modelTurn(fixture.host, 'search');
  const retained = await fixture.api.captureRetainedUpgradeSession(fixture.host, { version: '0.3.0', sha256: 'a'.repeat(64) }, '0.2.2-rc.2');
  const next = fixture.reboot(), offset = fixture.requests.length;
  const evidence = await fixture.api.restoreRetainedUpgradeSession(next, retained, {
    instanceId: retained.instanceId, exitCode: 0, signal: null, forced: false, closeError: null,
  });
  assert.equal(evidence.coldReadBeforePrompt, true);
  assert.equal(evidence.historyMatched, true);
  assert.equal(next.modelSession, retained.sessionId);
  assert.deepEqual(fixture.requests.slice(offset), [
    { endpoint: 'auth' }, { endpoint: 'session/page', request: {
      address: { kind: 'session', sessionId: retained.sessionId }, throughSeq: retained.cursor, maxMessages: 100,
    } },
  ]);
  const search = await fixture.api.modelTurn(next, 'search');
  assert.equal(search.sessionId, retained.sessionId);
  assert.equal(fixture.state.creates, 1);
  await fixture.api.readRetainedUpgradePage(next, retained);
  assert.ok(fixture.records.length > retained.records.length);
});

test('B2 cold history rejects abnormal exit, same host lifetime and preactivated replacement Sessions', async () => {
  const fixture = b2RetainedSessionFixture();
  await fixture.api.modelTurn(fixture.host, 'search');
  const retained = await fixture.api.captureRetainedUpgradeSession(fixture.host, { version: '0.3.0', sha256: 'a'.repeat(64) }, '0.2.2-rc.2');
  const next = fixture.reboot(), offset = fixture.requests.length;
  const exit = { instanceId: retained.instanceId, exitCode: 0, signal: null, forced: false, closeError: null };
  for (const patch of [{ instanceId: null }, { exitCode: 1 }, { signal: 'SIGTERM' }, { forced: true },
    { closeError: 'shutdown rejected' }, { instanceId: fixture.state.instanceId }]) {
    await assert.rejects(fixture.api.restoreRetainedUpgradeSession(next, retained, { ...exit, ...patch }));
  }
  next.modelSession = 'new-session';
  await assert.rejects(fixture.api.restoreRetainedUpgradeSession(next, retained, exit), /before any Session/);
  assert.equal(fixture.requests.length, offset);
});

test('B2 requires the real completed cut and retains older cursorless history through capture, cold read and later turns', async () => {
  const fixture = b2RetainedSessionFixture();
  fixture.state.cursorless = true;
  await fixture.api.modelTurn(fixture.host, 'search');
  const retained = await fixture.api.captureRetainedUpgradeSession(fixture.host,
    { version: '0.3.0', sha256: 'a'.repeat(64) }, '0.2.1-rc.2');
  assert.equal(retained.cut.seq, fixture.records.at(-1).event.seq);
  assert.equal(retained.historyRead.cursorSource, 'validated-dense-record-boundary');
  assert.equal(retained.historyRead.hostReturnedCursor, false);
  const next = fixture.reboot();
  const evidence = await fixture.api.restoreRetainedUpgradeSession(next, retained, {
    instanceId: retained.instanceId, exitCode: 0, signal: null, forced: false, closeError: null,
  });
  assert.equal(evidence.coldReadBeforePrompt, true);
  assert.equal(evidence.historyRead.hostReturnedCursor, false);
  await fixture.api.modelTurn(next, 'chat');
  await fixture.api.readRetainedUpgradePage(next, retained);
  assert.ok(fixture.requests.filter(row => row.endpoint === 'session/page')
    .every(row => row.request.throughSeq === retained.cursor));
  assert.equal(fixture.state.creates, 1);
});

test('B2 incompatible, missing or changed persisted history fails without creating a replacement Session', async () => {
  const fixture = b2RetainedSessionFixture();
  await fixture.api.modelTurn(fixture.host, 'search');
  const retained = await fixture.api.captureRetainedUpgradeSession(fixture.host, { version: '0.3.0', sha256: 'a'.repeat(64) }, '0.2.2-rc.2');
  const next = fixture.reboot();
  const exit = { instanceId: retained.instanceId, exitCode: 0, signal: null, forced: false, closeError: null };
  fixture.state.pageError = Object.assign(new Error('Unsupported stored Session format'), { code: 'SESSION_FORMAT_UNSUPPORTED' });
  await assert.rejects(fixture.api.restoreRetainedUpgradeSession(next, retained, exit), { code: 'SESSION_FORMAT_UNSUPPORTED' });
  fixture.state.pageError = null;
  const changed = structuredClone(retained.records);
  changed[0].event.data.changed = true;
  fixture.state.pageOverride = { cursor: retained.cursor, records: changed, hasMore: false };
  await assert.rejects(fixture.api.restoreRetainedUpgradeSession(next, retained, exit), /retain the old Session history/);
  fixture.state.pageOverride = { cursor: retained.cursor + 1, records: retained.records, hasMore: false };
  await assert.rejects(fixture.api.restoreRetainedUpgradeSession(next, retained, exit), /honor the original cut/);
  assert.equal(next.modelSession, undefined);
  assert.equal(fixture.state.creates, 1);
});

test('B2 actual upgrade verify and restart blocks seed once and cold-read before same-ID turns on the new plugin', async () => {
  const fixture = b2RetainedSessionFixture(), offset = fixture.source.indexOf('async function runUpgrade(runtime) {');
  const begin = fixture.source.indexOf('  const verify = async ', offset);
  const end = fixture.source.indexOf("  try {\n    host = await start(runtime, folder, 'upgrade-old-install');", begin);
  assert.ok(begin > offset && end > begin);
  const stages = [], writes = [], audits = [], starts = [];
  const oldReceipt = { version: '0.3.0', sha256: 'a'.repeat(64), sourceHashes: [] };
  const newReceipt = { version: '0.4.0', sha256: 'b'.repeat(64), sourceHashes: [] };
  const inputs = { assert, join, host: fixture.host, retainedSession: null, retainedRead: null, stages,
    runtime: { app: { version: '0.2.2-rc.2' } }, activeRuntime: { app: { version: '0.2.2-rc.2' } },
    currentVersion: '0.2.2-rc.2', oldProductReceipt: oldReceipt, expectedProductReceipt: newReceipt,
    inspectDesktopNativeInstall: (profile, version) => { audits.push(version); return { installedVersion: version, hostCopies: false }; },
    profile: sandbox, directory: sandbox, configPath: 'synthetic-config', cache: { target: 'synthetic-cache' },
    expected: {}, recordsBefore: [], syntheticFields: [], preserved: () => ({}), realpathSync: value => value,
    sourceSettingsRpc: async () => ({}), safe: value => value, writeJson: (path, value) => writes.push({ path, value }),
    modelTurn: fixture.api.modelTurn, captureRetainedUpgradeSession: fixture.api.captureRetainedUpgradeSession,
    retainedSessionIdentity: fixture.api.retainedSessionIdentity, readRetainedUpgradePage: fixture.api.readRetainedUpgradePage,
    restoreRetainedUpgradeSession: fixture.api.restoreRetainedUpgradeSession,
    waitFor: async () => ({ productProgram: { program: { source: 'private-cache', path: 'synthetic-cache' },
      configPath: 'synthetic-config', configuration: { executable: false, configPath: false } },
    productControl: { revision: 1 }, runtimeWeb: { searchProviderId: 'grok-search', fetchProviderId: 'candidate-fetch' },
    existingDependencyPresent: true }),
    close: async () => ({ exitCode: 0, signal: null, forced: false, closeError: null }),
    start: async runtime => { starts.push(runtime.app.version); return fixture.reboot(); }, folder: sandbox,
  };
  const api = new Function(...Object.keys(inputs), fixture.source.slice(begin, end) + '\nreturn { verify, restart };')(...Object.values(inputs));
  await api.verify(oldReceipt, 'old-configured', { ui: false });
  const count = fixture.requests.length;
  await api.restart('new-runtime-lifetime', { app: { version: '0.2.2-rc.3' } });
  await api.verify(newReceipt, 'tarball-in-place-restarted', { ui: false });
  assert.equal(stages.length, 2);
  assert.equal(fixture.state.creates, 1);
  assert.equal(writes.filter(row => row.path.endsWith('-old-session-seed.json')).length, 1);
  assert.equal(stages[0].retainedSession.coldReadBeforePrompt, false);
  assert.equal(stages[1].retainedSession.coldReadBeforePrompt, true);
  assert.equal(stages[1].retainedSession.seededPluginVersion, '0.3.0');
  assert.equal(stages[1].pluginVersion, '0.4.0');
  assert.equal(stages[0].hostVersion, '0.2.2-rc.2');
  assert.equal(stages[1].hostVersion, '0.2.2-rc.3');
  assert.deepEqual(starts, ['0.2.2-rc.3']);
  assert.equal(stages[1].retainedSession.recordsSha256, stages[0].retainedSession.recordsSha256);
  assert.equal(stages[1].retainedSession.sameIdSearch, true);
  assert.equal(stages[1].retainedSession.originalCutReadbackAfterTurns, true);
  assert.deepEqual(audits, ['0.4.0']);
  assert.equal(stages[0].nativeInstallAudit, undefined);
  assert.equal(stages[1].nativeInstallAudit.installedVersion, '0.4.0');
  assert.deepEqual(fixture.requests.slice(count, count + 3).map(row => row.endpoint), ['auth', 'session/page', 'session/prompt']);
});

function b2PairFunctions(dependencies = {}) {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  const parts = [
    source.slice(source.indexOf('function validateCrossHostUpgradePackages('), source.indexOf('let serial = 0, currentVersion = null;')),
    source.slice(source.indexOf('function bindCrossHostFixture('), source.indexOf('async function captureRetainedUpgradeSession(')),
  ];
  const values = { assert, semver, PRODUCT_BUNDLE: 'dsh-grok-search', join, isAbsolute: path => resolve(path) === path,
    readFileSync, writeFileSync, existsSync, sha256: path => sha256(readFileSync(path)), ...dependencies };
  return new Function(...Object.keys(values), parts.join('\n')
    + '\nreturn { validateCrossHostUpgradePackages, bindCrossHostFixture, selectUpgradeRuntimeControl, observeRejectedOldPlugin };')
  (...Object.values(values));
}

test('B2 cross-host CLI requires one baseline, all pinned target arguments and forward-only in-place mode', {
  skip: !desktopPlatform,
}, async () => {
  const old = receiptDesktopFixture('0.2.2-rc.2'), target = receiptDesktopFixture('0.2.2-rc.3');
  const base = ['--desktop', old.executable, '--product-package', 'new.tgz', '--upgrade-from', 'old.tgz',
    '--upgrade-cache', 'existing-cache', '--upgrade-in-place-only', 'true'];
  const pin = ['--upgrade-to-desktop', target.executable,
    '--upgrade-to-runtime-receipt', target.options.runtimeReceiptPath,
    '--upgrade-to-runtime-receipt-sha256', target.options.runtimeReceiptSha256];
  const parsed = b2GatePreflight('b2-plugin-manager-desktop.mjs', [...base, ...pin]);
  assert.equal(parsed.runtimes[0].app.version, '0.2.2-rc.2');
  assert.equal(parsed.upgradeToRuntime.app.version, '0.2.2-rc.3');
  assert.deepEqual(parsed.upgradeToRuntimeOptions, target.options);
  const targetCommand = await b2PreparationCommand(parsed.upgradeToRuntime, {}, parsed.upgradeToRuntime, target.options);
  assert.equal(targetCommand.args[targetCommand.args.indexOf('--runtime-receipt') + 1], target.options.runtimeReceiptPath);
  assert.equal(targetCommand.args[targetCommand.args.indexOf('--runtime-receipt-sha256') + 1], target.options.runtimeReceiptSha256);
  const baselineCommand = await b2PreparationCommand(parsed.runtimes[0], {}, parsed.upgradeToRuntime, target.options);
  assert.equal(baselineCommand.args.includes('--runtime-receipt'), false);
  for (const invalid of [[...base, ...pin.slice(0, -2)], [...base.slice(0, -2), ...pin],
    ['--desktop', old.executable, '--product-package', 'new.tgz', ...pin],
    [...base, ...pin, '--upgrade-to-desktop', target.executable]]) {
    assert.throws(() => b2GatePreflight('b2-plugin-manager-desktop.mjs', invalid));
  }
  assert.throws(() => b2GatePreflight('b2-plugin-manager-desktop.mjs',
    [...base, ...pin.slice(0, -1), '0'.repeat(64)]), { code: 'COMPATIBILITY_HASH_MISMATCH' });
  assert.equal(existsSync(old.runRoot), false);
  assert.equal(existsSync(target.runRoot), false);
});

test('B2 pair uses real semver requirements without weakening the old package or granting an exemption', () => {
  const { validateCrossHostUpgradePackages: validate } = b2PairFunctions();
  const old = { name: 'dsh-grok-search', version: '0.3.0', engines: { dsh: '0.2.2-rc.1 || 0.2.2-rc.2' } };
  const next = { name: 'dsh-grok-search', version: '0.4.0', engines: { dsh: '>=0.2.1-rc.2' } };
  assert.doesNotThrow(() => validate(old, next, '0.2.2-rc.2', '0.2.2-rc.3'));
  for (const args of [
    [old, next, '0.2.2-rc.3', '0.2.2-rc.2'],
    [old, next, '0.2.2-rc.3', '0.2.2-rc.4'],
    [{ ...old, engines: { dsh: '*' } }, next, '0.2.2-rc.2', '0.2.2-rc.3'],
    [old, { ...next, engines: { dsh: 'invalid range' } }, '0.2.2-rc.2', '0.2.2-rc.3'],
  ]) assert.throws(() => validate(...args));
  assert.equal(old.engines.dsh, '0.2.2-rc.1 || 0.2.2-rc.2');
});

test('B2 pair switches only prepared runtime paths and preserves shared profile, token, userData and workspace', () => {
  const { selectUpgradeRuntimeControl } = b2PairFunctions();
  const shared = { root: join(sandbox, 'baseline'), profile: join(sandbox, 'baseline/profile'), token: 'synthetic-token',
    userData: join(sandbox, 'baseline/userData'), workspace: join(sandbox, 'baseline/workspace'), dshHome: join(sandbox, 'baseline/dsh-home'),
    electron: join(sandbox, 'old/electron.exe'), archive: join(sandbox, 'old/app.asar'), runtime: join(sandbox, 'old/runtime'),
    primaryRuntime: join(sandbox, 'old/primary-runtime'), pnpmEntry: join(sandbox, 'old/pnpm.mjs') };
  const next = Object.fromEntries(['electron', 'archive', 'runtime', 'primaryRuntime', 'pnpmEntry']
    .map(key => [key, join(sandbox, 'new-runtime', key)]));
  const result = selectUpgradeRuntimeControl(shared, { ...next, profile: 'must-not-replace', token: 'must-not-replace' });
  for (const key of ['profile', 'token', 'userData', 'workspace', 'dshHome', 'root']) assert.equal(result[key], shared[key]);
  for (const [key, value] of Object.entries(next)) assert.equal(result[key], value);
  assert.equal(selectUpgradeRuntimeControl(shared, null), shared);
  assert.throws(() => selectUpgradeRuntimeControl(shared, { ...next, runtime: null }), /explicit prepared paths/);
});

test('B2 pair declares two observed engines only on owned fixtures and leaves the installed plugin unchanged', () => {
  const folder = mkdtempSync(join(sandbox, 'b2-pair-fixture-'));
  const paths = ['dsh-home/profiles/desktop/package.json', 'fixture-package/package.json',
    'dsh-home/profiles/desktop/node_modules/candidate-offline-fixture/package.json'];
  for (const [index, path] of paths.entries()) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), JSON.stringify({ name: index === 0 ? 'isolated-desktop-profile' : 'candidate-offline-fixture',
      engines: { dsh: '0.2.2-rc.2' }, dependencies: { unchanged: '1.0.0' } }));
  }
  const product = join(folder, 'dsh-home/profiles/desktop/node_modules/dsh-grok-search/package.json');
  mkdirSync(dirname(product), { recursive: true }); writeFileSync(product, '{"name":"dsh-grok-search","engines":{"dsh":"0.2.2-rc.2"}}');
  const before = readFileSync(product);
  b2PairFunctions().bindCrossHostFixture(folder, '0.2.2-rc.2', '0.2.2-rc.3');
  for (const path of paths) {
    const value = JSON.parse(readFileSync(join(folder, path)));
    assert.equal(value.engines.dsh, '0.2.2-rc.2 || 0.2.2-rc.3');
    assert.deepEqual(value.dependencies, { unchanged: '1.0.0' });
  }
  assert.deepEqual(readFileSync(product), before);
  assert.equal(existsSync(join(folder, 'dsh-home/profiles/desktop/compatibility.json')), false);
});

test('B2 old-plugin boundary requires official incompatible evidence, unchanged bytes and no search', async () => {
  const profile = mkdtempSync(join(sandbox, 'b2-pair-rejected-')), product = join(profile, 'node_modules/dsh-grok-search');
  mkdirSync(product, { recursive: true });
  writeFileSync(join(product, 'package.json'), JSON.stringify({ name: 'dsh-grok-search', version: '0.3.0', engines: { dsh: '0.2.2-rc.2' } }));
  const receipt = { version: '0.3.0', sha256: 'a'.repeat(64),
    sourceHashes: [{ file: 'package.json', sha256: sha256(readFileSync(join(product, 'package.json'))) }] };
  const bundle = { name: 'dsh-grok-search', version: '0.3.0', installed: true, enabled: true,
    error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-grok-search', version: '0.3.0',
      runtimeVersion: '0.2.2-rc.3', requirements: { 'engines.dsh': '0.2.2-rc.2' } }] } };
  const state = { productControl: null, productProgram: null, entries: [], calls: { original: 0 } }, calls = [];
  const host = { async probe(op) { assert.equal(op, 'snapshot'); return state; } };
  const { observeRejectedOldPlugin } = b2PairFunctions({ nativeManagerRpc: async (_host, method) => {
    calls.push(method); assert.equal(method, 'listBundles'); return [bundle];
  } });
  const result = await observeRejectedOldPlugin(host, profile, receipt, '0.2.2-rc.3');
  assert.equal(result.searchIssued, false);
  assert.equal(result.oldPluginActive, false);
  assert.equal(result.exempted, false);
  assert.equal(result.protectionStatus, 'old-plugin-unloaded-not-protected');
  state.calls.original = 1;
  await assert.rejects(observeRejectedOldPlugin(host, profile, receipt, '0.2.2-rc.3'), /unprotected original/);
  state.calls.original = 0; state.productControl = { phase: 'required' };
  await assert.rejects(observeRejectedOldPlugin(host, profile, receipt, '0.2.2-rc.3'));
  state.productControl = null; bundle.error.code = 'download-failed';
  await assert.rejects(observeRejectedOldPlugin(host, profile, receipt, '0.2.2-rc.3'), /official manager incompatibility/);
  bundle.error.code = 'incompatible-version'; writeFileSync(join(profile, 'compatibility.json'), '{}');
  await assert.rejects(observeRejectedOldPlugin(host, profile, receipt, '0.2.2-rc.3'), /exemption/);
  assert.ok(calls.every(method => method === 'listBundles'));
});

test('B2 normal and first-use paths audit actual installs and normal restart without labeling preparation as installation', async () => {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const [functionName, startText, endText, returned] of [
    ['runFirstUse', '    const installed = await installBundle(', '    ready = await waitFor(', 'nativeInstallAudit'],
    ['runVersion', '  const productInstall = await installBundle(', '  assert.equal(productInstall.bundle', 'nativeInstallAudit'],
    ['runVersion', '  const productHost = await start(', '  const before = productReady.productControl', 'restartNativeInstallAudit'],
  ]) {
    const start = source.indexOf(startText, source.indexOf('async function ' + functionName + '('));
    const end = source.indexOf(endText, start); assert.ok(start >= 0 && end > start);
    const calls = [];
    const values = { host: {}, first: {}, productTarball: 'synthetic.tgz', PRODUCT_BUNDLE: 'dsh-grok-search', profile: 'owned-profile',
      expectedProductReceipt: { version: '0.4.0' }, runtime: {}, folder: 'owned-root',
      installBundle: async () => { calls.push('native-install'); return { application: 'applied' }; },
      assertManagerApplied: result => { assert.equal(result.application, 'applied'); calls.push('applied'); },
      start: async () => { calls.push('restart'); return {}; },
      waitFor: async () => { calls.push('ready'); return { productControl: { recordEnvelope: {} } }; },
      inspectDesktopNativeInstall: (profile, version) => { calls.push('audit');
        assert.equal(profile, 'owned-profile'); assert.equal(version, '0.4.0'); return { hostCopies: false }; },
    };
    const result = await new AsyncFunction(...Object.keys(values), source.slice(start, end) + '\nreturn ' + returned + ';')(...Object.values(values));
    assert.equal(result.hostCopies, false);
    assert.deepEqual(calls, returned === 'restartNativeInstallAudit' ? ['restart', 'ready', 'audit'] : ['native-install', 'applied', 'audit']);
    values.inspectDesktopNativeInstall = () => { throw new Error('private host peer'); };
    await assert.rejects(new AsyncFunction(...Object.keys(values), source.slice(start, end) + '\nreturn ' + returned + ';')(...Object.values(values)), /private host peer/);
  }
});

test('first-use disable distinguishes the observed advisory from actual release and keeps later checks', () => {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function assertFirstUseDisableReported(');
  const end = source.indexOf('\nasync function installBundle(', start);
  assert.ok(start > 0 && end > start);
  const { check, releaseObserved } = new Function('assert', source.slice(start, end)
    + '\nreturn { check: assertFirstUseDisableReported, releaseObserved: firstUseReleaseObserved };')(assert);
  const applied = { application: 'applied', changed: true, target: 'dsh-grok-search', enabled: false };
  assert.equal(check(applied, applied.target), false);
  assert.equal(check({ ...applied, application: 'restart-required', restartReason: 'unmanaged-plugin' }, applied.target), true);
  for (const override of [
    { application: 'failed' }, { application: 'overridden' }, { changed: false }, { enabled: true },
    { target: 'different-plugin' }, { error: { code: 'release-failed' } },
    { application: 'restart-required', restartReason: 'no-hmr' },
    { application: 'restart-required', restartReason: 'package-moved' },
  ]) assert.throws(() => check({ ...applied, ...override }, applied.target));
  const lifecycle = source.slice(source.indexOf('async function runFirstUse('), source.indexOf('async function upgradeCacheFixture('));
  const released = { runtimeWeb: { searchProviderId: 'candidate-original' },
    record: { policy: 'released', releaseCompletion: { routeVerified: true } },
    productProgram: null, productControl: null, productRecovery: null, productRouteVerifier: null };
  assert.equal(releaseObserved(released), true);
  for (const service of ['productProgram', 'productControl', 'productRecovery', 'productRouteVerifier']) {
    assert.equal(releaseObserved({ ...released, [service]: {} }), false);
  }
  assert.match(lifecycle, /waitFor\(host, firstUseReleaseObserved/);
  assert.ok(lifecycle.indexOf('progress.releaseCompletion = releaseCompletion') < lifecycle.indexOf('const enabled = await setBundleEnabled'));
  assert.match(lifecycle, /assert\.deepEqual\(await matchingFirstUseProcesses\(programPath\), \[\]\)/);
  assert.match(lifecycle, /assertManagerApplied\(enabled, PRODUCT_BUNDLE\)/);
  assert.match(lifecycle, /progress\.searchAfterReenable = true/);
  assert.match(lifecycle, /managerOutcomes: \{ disabled, enabled \}, releaseCompletion/);
  assert.match(source, /validationFlagSemantics: 'false means not validated/);
});

test('forward host upgrade retains the new plugin on rc.2 and never schedules an old-host rollback', () => {
  const runtimes = ['0.2.2-rc.1', '0.2.2-rc.2'].map(version => ({ app: { version } }));
  const forward = searchLogUpgradeStages({ forwardHostUpgrade: true, runtimes });
  assert.deepEqual(forward, [
    { packageIndex: 0, runtimeIndex: 0 },
    { packageIndex: 1, runtimeIndex: 0 },
    { packageIndex: 1, runtimeIndex: 1 },
  ]);
  assert.deepEqual(searchLogUpgradeStages({ runtimes: runtimes.slice(0, 1) }).map(row => row.packageIndex), [0, 1, 0]);
  assert.deepEqual(searchLogUpgradeStages({ hostUpgrade: true, runtimes }).map(row => row.runtimeIndex), [0, 0, 1, 0, 0]);
  assert.throws(() => searchLogUpgradeStages({ forwardHostUpgrade: true, hostUpgrade: true, runtimes }), /separate/);
  assert.throws(() => searchLogUpgradeStages({ forwardHostUpgrade: true, checkpointDowngrade: true, runtimes }), /separate/);
  assert.throws(() => searchLogUpgradeStages({ forwardHostUpgrade: true, runtimes: [...runtimes].reverse() }), /rc\.1.*rc\.2/);
});

test('the Desktop fixture copy includes the complete local core dependency closure', async () => {
  const preparation = readFileSync(new URL('../scripts/deferred-release-desktop-prepare.mjs', import.meta.url), 'utf8');
  const copy = /for \(const module of (\[[^\]]+\])\)/.exec(preparation);
  assert.ok(copy, 'locate the explicit fixture-only copy list');
  const modules = [...copy[1].matchAll(/'([^']+\.mjs)'/g)].map(match => match[1]);
  const result = await build({ absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: modules.map(name => 'src/core/' + name), outdir: 'unused-fixture-closure',
    bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true, write: false, logLevel: 'silent' });
  const missing = Object.keys(result.metafile.inputs).filter(path => path.startsWith('src/core/'))
    .map(path => path.slice('src/core/'.length)).filter(name => !modules.includes(name));
  assert.deepEqual(missing, [], 'new core imports must be copied before any Desktop fixture is launched');
});

test('官方格式 fuse 可读且兼容检查只接受可用的开发加载条件', () => {
  const fuses = readElectronFuseWire(fuseBinary());
  assert.equal(fuses.version, 1);
  assert.equal(fuses.length, 9);
  assert.equal(fuses.wire, '101100011');
  assert.equal(fuses.onlyLoadAppFromAsar, false);
  assert.equal(fuses.embeddedAsarIntegrityValidation, false);
  assert.doesNotThrow(() => assertDevelopmentFuseCompatibility(fuses));
});

test('禁止的 fuse 条件确实阻断，不能借兼容检查放宽官方二进制要求', () => {
  for (const wire of ['001100011', '101000011', '101110011', '101101011', '1011r0011']) {
    assert.throws(() => assertDevelopmentFuseCompatibility(readElectronFuseWire(fuseBinary(wire))));
  }
});

test('缺失、重复、截断和未知 fuse 格式可靠报错', () => {
  const malformed = [Buffer.from('no-wire'), Buffer.concat([fuseBinary(), fuseBinary()]),
    fuseBinary('101100011', 2), fuseBinary('10110'), fuseBinary('101100011', 1, 10), fuseBinary('10110x011')];
  for (const binary of malformed) assert.throws(() => readElectronFuseWire(binary));
});

test('准备根必须为专属临时空间内的全新绝对目录，检查本身不创建目录', () => {
  const accepted = join(sandbox, 'new-run');
  assert.equal(resolveNewTemporaryRunRoot(accepted), accepted);
  assert.equal(existsSync(accepted), false);
  for (const rejected of [undefined, '', 'relative-run', temporary, sandbox,
    join(temporary, 'another-namespace', 'run'), resolve(temporary, '..', 'formal-profile', 'run')]) {
    assert.throws(() => resolveNewTemporaryRunRoot(rejected));
  }
  assert.equal(readFileSync(marker, 'utf8'), '既有成果保持');
});

test('临时目录中的文件和通向外部目录的链接不可成为准备入口', () => {
  const outside = mkdtempSync(join(temporary, 'dsh-desktop-fixture-outside-'));
  const outsideMarker = join(outside, 'untouched.txt');
  writeFileSync(outsideMarker, '不得覆盖', { flag: 'wx' });
  const redirect = join(sandbox, 'redirect');
  symlinkSync(outside, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveNewTemporaryRunRoot(join(redirect, 'new-run')), /link or non-directory/);
  assert.throws(() => resolveNewTemporaryRunRoot(join(marker, 'new-run')), /link or non-directory/);
  assert.equal(readFileSync(outsideMarker, 'utf8'), '不得覆盖');
  assert.equal(existsSync(join(outside, 'new-run')), false);
});

test('无效准备目录在读取 Desktop 或创建文件前阻断', () => {
  const outside = join(temporary, 'unrelated-profile', 'new-run');
  assert.throws(() => inspectDesktopPreparation('missing-desktop.exe', outside), /temporary namespace/);
  assert.equal(existsSync(outside), false);
});

test('Desktop preparation arguments require a complete pinned local runtime receipt pair', () => {
  const common = ['--desktop', 'fixture-desktop.exe', '--run-root', join(sandbox, 'parse-only')];
  const receipt = join(sandbox, 'runtime-receipt.json'), hash = 'a'.repeat(64);
  const old = parseDesktopPreparationArguments(common);
  assert.equal(old.versionedControlRecord, false);
  assert.equal(old.productEntries, false);
  assert.equal(Object.hasOwn(old, 'runtimeReceiptPath'), false);
  const parsed = parseDesktopPreparationArguments([...common, '--runtime-receipt', receipt,
    '--runtime-receipt-sha256', hash, '--entry-mode', 'plugin-manager-live']);
  assert.equal(parsed.runtimeReceiptPath, receipt);
  assert.equal(parsed.runtimeReceiptSha256, hash);
  assert.equal(parsed.pluginManagerEntries, true);
  assert.equal(parsed.liveHmr, true);
  for (const extra of [
    ['--runtime-receipt', receipt], ['--runtime-receipt-sha256', hash],
    ['--runtime-receipt', '--entry-mode', 'product'], ['--runtime-receipt', receipt, '--runtime-receipt-sha256', 'bad'],
    ['--runtime-receipt', 'https://untrusted.invalid/receipt.json', '--runtime-receipt-sha256', hash],
    ['--runtime-receipt', 'relative.json', '--runtime-receipt-sha256', hash],
    ['--runtime-receipt', '\\\\server\\share\\receipt.json', '--runtime-receipt-sha256', hash],
    ['--runtime-receipt', receipt + '\n', '--runtime-receipt-sha256', hash],
    ['--runtime-receipt', receipt, '--runtime-receipt', receipt, '--runtime-receipt-sha256', hash],
    ['--runtime-receipt-sha256', hash, '--runtime-receipt-sha256', hash, '--runtime-receipt', receipt],
    ['--entry-mode', 'unknown'], ['--desktop', 'another.exe'], ['--unknown', 'value'],
  ]) assert.throws(() => parseDesktopPreparationArguments([...common, ...extra]));
  assert.throws(() => parseDesktopPreparationArguments([]), /required/);
  assert.equal(existsSync(join(sandbox, 'parse-only')), false);
});

test('shared Desktop receipt arguments preserve other gate flags and reject incomplete or repeated pairs', () => {
  assert.equal(typeof desktopPreparation.parseRuntimeReceiptArguments, 'function');
  const receipt = join(sandbox, 'unread-runtime-receipt.json'), hash = 'a'.repeat(64);
  const argv = ['--editable-config', 'product.tgz', '--runtime-receipt', receipt, 'desktop.exe',
    '--runtime-receipt-sha256', hash, '--github-read'];
  const before = [...argv], parsed = desktopPreparation.parseRuntimeReceiptArguments(argv);
  assert.deepEqual(argv, before);
  assert.deepEqual(parsed.args, ['--editable-config', 'product.tgz', 'desktop.exe', '--github-read']);
  assert.deepEqual(parsed.runtimeOptions, { runtimeReceiptPath: receipt, runtimeReceiptSha256: hash });
  assert.deepEqual(desktopPreparation.parseRuntimeReceiptArguments(['product.tgz', 'old1.exe', 'old2.exe']),
    { args: ['product.tgz', 'old1.exe', 'old2.exe'], runtimeOptions: {} });
  for (const args of [
    ['--runtime-receipt', receipt], ['--runtime-receipt-sha256', hash],
    ['--runtime-receipt', '--allow-live', '--runtime-receipt-sha256', hash],
    ['--runtime-receipt', receipt, '--runtime-receipt-sha256', 'invalid'],
    ['--runtime-receipt', receipt, '--runtime-receipt', receipt, '--runtime-receipt-sha256', hash],
    ['--runtime-receipt', 'https://untrusted.invalid/receipt', '--runtime-receipt-sha256', hash],
  ]) assert.throws(() => desktopPreparation.parseRuntimeReceiptArguments(args));
  assert.equal(existsSync(receipt), false, 'argument parsing must not read or create receipts');
  assert.throws(() => desktopPreparation.readDesktopGateRuntimes(['missing1.exe', 'missing2.exe'], parsed.runtimeOptions),
    /one.*host/i);
});

test('B2 single-Desktop selection admits receipt-pinned hosts in normal, first-use, diagnostics and upgrade modes',
  { skip: !desktopPlatform }, () => {
    const host = receiptDesktopFixture('8.0.0-rc.1');
    const base = ['--desktop', host.executable, '--product-package', 'product.tgz',
      '--runtime-receipt', host.options.runtimeReceiptPath, '--runtime-receipt-sha256', host.options.runtimeReceiptSha256];
    const historicalEnv = { DSH_B2_ONLY_VERSION: '0.2.1-rc.2', DSH_B2_TARGET_VERSIONS: '0.2.1-rc.2,0.2.1-rc.3' };
    for (const script of ['b2-plugin-manager-desktop.mjs', 'b2-product-install.mjs']) {
      const modes = script === 'b2-product-install.mjs' ? [[]] : [[],
        ['--first-use', 'download'], ['--first-use', 'download', '--diagnostics', 'loopback'],
        ['--upgrade-from', 'old.tgz', '--upgrade-cache', 'retained-cache'],
        ['--upgrade-from', 'old.tgz', '--upgrade-cache', 'retained-cache', '--upgrade-in-place-only', 'true'],
        ['--source-only-config', 'isolated.toml', '--manual-acceptance', 'true']];
      for (const mode of modes) {
        const parsed = b2GatePreflight(script, [...base, ...mode], historicalEnv);
        assert.deepEqual(parsed.runtimes.map(runtime => runtime.app.version), ['8.0.0-rc.1']);
        assert.deepEqual(parsed.runtimeOptions, host.options);
        assert.equal(parsed.runtimes[0].candidateReceipt.asset.sha256, host.receipt.asset.sha256);
        for (let index = 0; index < mode.length; index += 2) assert.equal(parsed.options.get(mode[index]), mode[index + 1]);
      }
      assert.throws(() => b2GatePreflight(script, base.slice(0, 4)), { code: 'COMPATIBILITY_HASH_REQUIRED' });
    }
    assert.equal(CANDIDATE_VERSIONS.includes('8.0.0-rc.1'), false);
    assert.equal(existsSync(host.runRoot), false);
  });

test('B2 Desktop preflight preserves the legacy pair, version overrides and manager-only filtering',
  { skip: !desktopPlatform }, () => {
    const first = receiptDesktopFixture('0.2.1-rc.2'), second = receiptDesktopFixture('0.2.1-rc.3');
    const base = ['--desktop-rc2', first.executable, '--desktop-rc21', second.executable, '--product-package', 'product.tgz'];
    for (const script of ['b2-plugin-manager-desktop.mjs', 'b2-product-install.mjs']) {
      const parsed = b2GatePreflight(script, base);
      assert.deepEqual(parsed.runtimes.map(runtime => runtime.app.version), ['0.2.1-rc.2', '0.2.1-rc.3']);
      assert.deepEqual(parsed.runtimeOptions, {});
      assert.equal(b2GatePreflight(script, ['--desktop', first.executable, '--product-package', 'product.tgz'])
        .runtimes[0].app.version, '0.2.1-rc.2');
      assert.throws(() => b2GatePreflight(script, base, { DSH_B2_TARGET_VERSIONS: '0.2.1-rc.3,0.2.1-rc.2' }));
      const later = receiptDesktopFixture('0.2.1-rc.5');
      assert.deepEqual(b2GatePreflight(script,
        ['--desktop-rc2', first.executable, '--desktop-rc21', later.executable, '--product-package', 'product.tgz'],
        { DSH_B2_TARGET_VERSIONS: '0.2.1-rc.2,0.2.1-rc.5' }).runtimes.map(runtime => runtime.app.version),
      ['0.2.1-rc.2', '0.2.1-rc.5']);
    }
    assert.deepEqual(b2GatePreflight('b2-plugin-manager-desktop.mjs', base, { DSH_B2_ONLY_VERSION: '0.2.1-rc.3' })
      .runtimes.map(runtime => runtime.app.version), ['0.2.1-rc.3']);
    assert.throws(() => b2GatePreflight('b2-plugin-manager-desktop.mjs', base, { DSH_B2_ONLY_VERSION: '9.0.0' }));
  });

test('B2 Desktop preflight rejects mixed selectors, duplicate flags and receipts bound to multiple or altered hosts',
  { skip: !desktopPlatform }, () => {
    for (const script of ['b2-plugin-manager-desktop.mjs', 'b2-product-install.mjs']) {
      const host = receiptDesktopFixture(), other = receiptDesktopFixture();
      const base = ['--desktop', host.executable, '--product-package', 'product.tgz'];
      const pin = ['--runtime-receipt', host.options.runtimeReceiptPath,
        '--runtime-receipt-sha256', host.options.runtimeReceiptSha256];
      for (const args of [
        [...base, '--desktop-rc2', host.executable, ...pin],
        [...base, '--desktop-rc21', host.executable, ...pin],
        [...base, '--desktop', host.executable, ...pin],
        [...base, '--product-package', 'other.tgz', ...pin],
        [...base, '--unknown', 'value', ...pin], ['--desktop', '--product-package', 'product.tgz', ...pin],
        ['--desktop', host.executable, ...pin], ['--product-package', 'product.tgz', ...pin],
        ['--desktop-rc2', host.executable, '--product-package', 'product.tgz', ...pin],
        ['--desktop-rc2', host.executable, '--desktop-rc21', other.executable, '--product-package', 'product.tgz', ...pin],
        [...base, '--runtime-receipt', host.options.runtimeReceiptPath],
        [...base, '--runtime-receipt-sha256', host.options.runtimeReceiptSha256],
        [...base, ...pin, ...pin],
        [...base, '--runtime-receipt', 'https://untrusted.invalid/receipt.json', '--runtime-receipt-sha256', 'a'.repeat(64)],
        [...base, '--runtime-receipt', host.options.runtimeReceiptPath, '--runtime-receipt-sha256', 'a'.repeat(64)],
        ['--desktop', other.executable, '--product-package', 'product.tgz', ...pin],
      ]) assert.throws(() => b2GatePreflight(script, args));
      writeFileSync(host.executable, fuseBinary('001100011'));
      assert.throws(() => b2GatePreflight(script, [...base, ...pin]), { code: 'COMPATIBILITY_HASH_MISMATCH' });
      assert.equal(existsSync(host.runRoot), false);
    }
  });

test('B2 manager preparation forwards the identical receipt and never silently switches a future host to legacy mode',
  { skip: !desktopPlatform }, async () => {
    for (const version of ['0.2.2-rc.3', '0.2.1-rc.2']) {
      const host = receiptDesktopFixture(version), pinned = version === '0.2.2-rc.3';
      const flags = pinned ? ['--runtime-receipt', host.options.runtimeReceiptPath,
        '--runtime-receipt-sha256', host.options.runtimeReceiptSha256] : [];
      const parsed = b2GatePreflight('b2-plugin-manager-desktop.mjs',
        ['--desktop', host.executable, '--product-package', 'product.tgz', ...flags]);
      const command = await b2PreparationCommand(parsed.runtimes[0], parsed.runtimeOptions);
      assert.equal(command.command, 'synthetic-node');
      const prepared = parseDesktopPreparationArguments(command.args.slice(1));
      assert.equal(prepared.desktop, host.executable);
      assert.equal(prepared.pluginManagerEntries, true);
      assert.equal(prepared.liveHmr, true);
      assert.equal(prepared.runtimeReceiptPath, pinned ? host.options.runtimeReceiptPath : undefined);
      assert.equal(prepared.runtimeReceiptSha256, pinned ? host.options.runtimeReceiptSha256 : undefined);
      if (pinned) {
        writeFileSync(host.options.runtimeReceiptPath, '{}');
        assert.throws(() => desktopPreparation.readDesktopGateRuntimes([host.executable], prepared),
          { code: 'COMPATIBILITY_HASH_MISMATCH' });
      }
    }
  });

test('B2 product installation requests normal optional-peer resolution without executing npm', async () => {
  const source = readFileSync(new URL('../scripts/b2-product-install.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function install(runtime) {'), end = source.indexOf('async function runVersion(runtime) {', start);
  assert.ok(start >= 0 && end > start);
  const calls = [], root = join(sandbox, 'b2-install-not-run');
  let outcome = { exitCode: 0, timedOut: false };
  const install = new Function('join', 'root', 'mkdirSync', 'cleanEnvironment', 'writeFileSync', 'commandResult',
    'process', 'npmCli', 'productTarball', 'writeJson', 'directory', 'receipt', 'assert', 'packageReceipt',
    'verifyInstalled', 'project', source.slice(start, end) + '\nreturn install;')(
    join, root, () => {}, (_root, extra) => extra, () => {}, async (command, args, options) => {
      calls.push({ command, args, options }); return outcome;
    }, { execPath: 'synthetic-node' }, 'synthetic-npm-cli', 'product.tgz', () => {}, sandbox, value => value,
    assert, () => ({ name: 'dsh-grok-search', version: '0.4.0' }), () => ({ verified: true }), sandbox);
  const result = await install({ app: { version: '0.2.2-rc.3' }, executable: 'synthetic-electron' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'synthetic-node');
  assert.deepEqual(calls[0].args.slice(0, 3), ['synthetic-npm-cli', 'install', 'product.tgz']);
  assert.ok(calls[0].args.includes('--legacy-peer-deps=false'));
  assert.ok(calls[0].args.includes('--ignore-scripts'));
  assert.equal(calls[0].args.some(arg => ['--legacy-peer-deps', '--legacy-peer-deps=true', '--force'].includes(arg)), false);
  assert.equal(calls[0].options.cwd, join(root, '0.2.2-rc.3', 'dsh-home', 'profiles', 'candidate'));
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '');
  assert.equal(result.installExitCode, 0);
  assert.deepEqual(result.installPolicy, { ignoreScripts: true, legacyPeerDeps: false });
  outcome = { exitCode: 1, timedOut: false, stderr: 'synthetic peer conflict' };
  await assert.rejects(() => install({ app: { version: '0.2.2-rc.3' }, executable: 'synthetic-electron' }),
    error => error.code === 'ERR_ASSERTION');
  assert.equal(calls.length, 2, 'a failed normal install is not retried with a peer-resolution bypass');
  assert.equal(existsSync(root), false, 'the stub must not install or create a profile');
});

test('B2 install evidence does not label a failed or unexecuted normal install as validated', () => {
  const source = readFileSync(new URL('../scripts/b2-product-install.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const summary = { runId,'), end = source.indexOf('writeJson(join(directory,', start);
  assert.ok(start >= 0 && end > start);
  const summarize = new Function('runId', 'fatal', 'results', 'hostDiagnostics', 'runtimes', 'packageReceipt',
    'productTarball', 'sha256', 'join', 'project', source.slice(start, end) + '\nreturn summary;');
  for (const [fatal, results, expected] of [
    [null, [{ status: 'pass' }], true], [null, [], false], [{ message: 'synthetic install failure' }, [], false],
  ]) {
    const summary = summarize('synthetic-run', fatal, results, [], [{}], () => ({ releaseChannel: 'beta' }),
      'product.tgz', () => 'a'.repeat(64), join, sandbox);
    assert.equal(summary.npmInstallValidated, expected);
    assert.equal(summary.packagedDesktopInstallValidated, expected);
    assert.deepEqual(summary.installPolicy, { ignoreScripts: true, legacyPeerDeps: false });
    assert.equal(summary.pluginManagerValidated, false);
    assert.doesNotMatch(summary.scope, /RC2/);
  }
});

test('full Desktop gate entry points forward the same pinned receipt to runtime validation and preparation',
  { skip: !desktopPlatform }, () => {
    for (const script of ['verify-search-log-desktop.mjs', 'verify-rc5-user-path.mjs']) {
      const host = receiptDesktopFixture();
      const flags = ['--runtime-receipt', host.options.runtimeReceiptPath,
        '--runtime-receipt-sha256', host.options.runtimeReceiptSha256];
      const parsed = desktopGatePreflight(script, ['product.tgz', host.executable, ...flags]);
      assert.equal(parsed.runtimes.length, 1);
      assert.equal(parsed.runtimes[0].app.version, '0.2.2-rc.3');
      assert.equal(parsed.runtimes[0].candidateReceipt.asset.sha256, host.receipt.asset.sha256);
      assert.equal(parsed.calls.length, 1);
      assert.equal(parsed.calls[0][0], host.executable);
      assert.deepEqual({ runtimeReceiptPath: parsed.calls[0][2].runtimeReceiptPath,
        runtimeReceiptSha256: parsed.calls[0][2].runtimeReceiptSha256 }, host.options);
      assert.equal(parsed.calls[0][2].pluginManagerEntries, true);
      assert.equal(parsed.calls[0][2].liveHmr, true);
      assert.throws(() => desktopGatePreflight(script, ['product.tgz', host.executable]),
        { code: 'COMPATIBILITY_HASH_REQUIRED' });
      assert.throws(() => desktopGatePreflight(script, ['product.tgz', host.executable, 'another.exe', ...flags]));
      assert.equal(existsSync(host.runRoot), false);
    }
  });

test('full Desktop receipt preflight and preparation reject tampering without writes or allowlist widening',
  { skip: !desktopPlatform }, () => {
    for (const script of ['verify-search-log-desktop.mjs', 'verify-rc5-user-path.mjs']) {
      const host = receiptDesktopFixture(), flags = ['--runtime-receipt', host.options.runtimeReceiptPath,
        '--runtime-receipt-sha256', host.options.runtimeReceiptSha256];
      const parsed = desktopGatePreflight(script, ['product.tgz', host.executable, ...flags]);
      writeFileSync(host.executable, fuseBinary('001100011'));
      assert.throws(() => desktopGatePreflight(script, ['product.tgz', host.executable, ...flags]),
        { code: 'COMPATIBILITY_HASH_MISMATCH' });
      assert.throws(() => prepareDesktopFixture(host.executable, host.runRoot, parsed.calls[0][2]),
        { code: 'COMPATIBILITY_HASH_MISMATCH' });
      assert.equal(existsSync(host.runRoot), false);
      const changedReceipt = receiptDesktopFixture();
      writeFileSync(changedReceipt.options.runtimeReceiptPath, '{}');
      assert.throws(() => desktopGatePreflight(script, ['product.tgz', changedReceipt.executable,
        '--runtime-receipt', changedReceipt.options.runtimeReceiptPath,
        '--runtime-receipt-sha256', changedReceipt.options.runtimeReceiptSha256]),
      { code: 'COMPATIBILITY_HASH_MISMATCH' });
    }
    assert.equal(CANDIDATE_VERSIONS.includes('0.2.2-rc.3'), false);
  });

test('full Desktop gates retain old no-receipt single-host and search-log multi-host invocations',
  { skip: !desktopPlatform }, () => {
    const first = receiptDesktopFixture('0.2.1-rc.5'), second = receiptDesktopFixture('0.2.2-rc.2');
    const search = desktopGatePreflight('verify-search-log-desktop.mjs',
      ['--github-read', 'product.tgz', first.executable, second.executable, '--editable-config']);
    assert.deepEqual(search.runtimes.map(runtime => runtime.app.version), ['0.2.1-rc.5', '0.2.2-rc.2']);
    assert.deepEqual(search.runtimeOptions, {});
    for (const call of search.calls) assert.equal(call[2].runtimeReceiptPath, undefined);
    const user = desktopGatePreflight('verify-rc5-user-path.mjs',
      ['--upgrade-from', 'old.tgz', 'product.tgz', second.executable, '--open-config']);
    assert.equal(user.runtimes[0].app.version, '0.2.2-rc.2');
    assert.deepEqual(user.runtimeOptions, {});
    assert.equal(user.calls[0][2].runtimeReceiptPath, undefined);
  });

test('fixture host versions preserve the baseline allowlist and reject fabricated verification objects', () => {
  for (const version of CANDIDATE_VERSIONS) assert.deepEqual(fixtureDshEngines(version), { dsh: version });
  for (const version of [undefined, '', '*', '0.2.2-rc.3', '9.0.0']) {
    assert.throws(() => fixtureDshEngines(version));
    for (const forged of [true, {}, new Set([version]), { asset: { version, sha256: 'a'.repeat(64) } }]) {
      assert.throws(() => fixtureDshEngines(version, forged));
    }
  }
});

test('verified Desktop receipt admits only its actual exact fixture version without expanding the allowlist',
  { skip: !desktopPlatform }, () => {
    const host = receiptDesktopFixture();
    assert.equal(CANDIDATE_VERSIONS.includes('0.2.2-rc.3'), false);
    assert.throws(() => inspectDesktopPreparation(host.executable, host.runRoot), { code: 'COMPATIBILITY_HASH_REQUIRED' });
    const inspected = inspectDesktopPreparation(host.executable, host.runRoot, host.options);
    assert.deepEqual(inspected.fixtureEngines, { dsh: '0.2.2-rc.3' });
    assert.deepEqual(fixtureDshEngines('0.2.2-rc.3', inspected.desktop.candidateReceipt), { dsh: '0.2.2-rc.3' });
    assert.throws(() => fixtureDshEngines('0.2.2-rc.3', host.receipt));
    assert.throws(() => fixtureDshEngines('0.2.2-rc.3', structuredClone(inspected.desktop.candidateReceipt)));
    assert.throws(() => fixtureDshEngines('0.2.2-rc.4', inspected.desktop.candidateReceipt));
    assert.equal(existsSync(host.runRoot), false);
    for (const version of ['0.2.0-rc.2', '0.2.2-rc.2']) {
      const old = receiptDesktopFixture(version);
      assert.equal(inspectDesktopPreparation(old.executable, old.runRoot).desktop.app.version, version);
    }
  });

test('Desktop preparation writes every fixture and profile with the exact verified host engine',
  { skip: !desktopPlatform }, () => {
    for (const version of ['0.2.2-rc.2', '0.2.2-rc.3']) {
      const host = receiptDesktopFixture(version), before = sha256(readFileSync(host.archive));
      const options = version === '0.2.2-rc.3' ? host.options : {};
      const result = prepareDesktopFixture(host.executable, host.runRoot, options);
      const profile = join(host.runRoot, 'dsh-home', 'profiles', 'desktop');
      for (const path of ['package.json', ...['candidate-offline-fixture', 'candidate-controlled-search', 'candidate-search-recovery']
        .map(name => `node_modules/${name}/package.json`)]) {
        assert.deepEqual(JSON.parse(readFileSync(join(profile, path))).engines, { dsh: version });
      }
      assert.equal(result.version, version);
      assert.equal(sha256(readFileSync(host.archive)), before);
      if (version === '0.2.2-rc.3') {
        assert.deepEqual(result.runtimeReceipt, { sha256: host.options.runtimeReceiptSha256, assetSha256: host.receipt.asset.sha256 });
      } else assert.equal(Object.hasOwn(result, 'runtimeReceipt'), false);
      const managerRoot = host.runRoot + '-manager';
      const manager = prepareDesktopFixture(host.executable, managerRoot, { ...options, pluginManagerEntries: true });
      for (const path of ['fixture-package/package.json', 'dsh-home/profiles/desktop/package.json',
        'dsh-home/profiles/desktop/node_modules/candidate-offline-fixture/package.json']) {
        assert.deepEqual(JSON.parse(readFileSync(join(managerRoot, path))).engines, { dsh: version });
      }
      const policy = { autoInstallPeers: true, strictPeerDependencies: true, legacyPeerDeps: false, force: false };
      assert.deepEqual(manager.installPolicy, policy);
      assert.equal(manager.dependencyInstall, false, 'preparing a policy is not a completed install');
      const prepared = JSON.parse(readFileSync(join(managerRoot, 'preparation.json'), 'utf8'));
      assert.deepEqual(prepared.installPolicy, policy);
      assert.equal(prepared.dependenciesInstalled, false);
      assert.equal(readFileSync(join(managerRoot, 'dsh-home/profiles/desktop/.npmrc'), 'utf8'),
        'auto-install-peers=true\nstrict-peer-dependencies=true\nlegacy-peer-deps=false\nforce=false\n');
    }
  });

function desktopNativeInstallTree() {
  const profile = mkdtempSync(join(sandbox, 'native-install-policy-'));
  const config = 'auto-install-peers=true\nstrict-peer-dependencies=true\nlegacy-peer-deps=false\nforce=false\n';
  const writePackage = (folder, name, version = '0.4.0') => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, version }));
  };
  writeFileSync(join(profile, '.npmrc'), config);
  writePackage(join(profile, 'node_modules/dsh-grok-search'), 'dsh-grok-search');
  return { profile, config, writePackage };
}

test('Desktop native install audit proves current identity and no private host peers without claiming execution', () => {
  const tree = desktopNativeInstallTree(), { profile, writePackage } = tree;
  writePackage(join(profile, 'node_modules/.pnpm/dependency@1/node_modules/dependency'), 'dependency', '1.0.0');
  mkdirSync(join(profile, 'node_modules/dsh-grok-search/node_modules'), { recursive: true });
  symlinkSync(join(profile, 'node_modules/.pnpm/dependency@1/node_modules/dependency'),
    join(profile, 'node_modules/dsh-grok-search/node_modules/dependency'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = sha256(readFileSync(join(profile, '.npmrc')));
  const audit = desktopPreparation.inspectDesktopNativeInstall(profile, '0.4.0');
  assert.deepEqual(audit.installPolicy, { autoInstallPeers: true, strictPeerDependencies: true, legacyPeerDeps: false, force: false });
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.installedVersion, '0.4.0');
  assert.equal(audit.hostCopies, false);
  assert.ok(audit.checkedModuleDirectories >= 3);
  assert.equal(audit.policyScope, 'profile-local-config-and-installed-tree');
  assert.equal(Object.hasOwn(audit, 'nativeInstallValidated'), false);
  assert.equal(sha256(readFileSync(join(profile, '.npmrc'))), before);
});

test('Desktop native install audit rejects relaxed, duplicated or missing policy and wrong product identity', () => {
  for (const mutate of [
    text => text.replace('strict-peer-dependencies=true', 'strict-peer-dependencies=false'),
    text => text.replace('auto-install-peers=true', 'auto-install-peers=false'),
    text => text.replace('legacy-peer-deps=false', 'legacy-peer-deps=true'),
    text => text.replace('force=false', 'force=true'),
    text => text.replace('strict-peer-dependencies=true\n', ''),
    text => text + 'strict-peer-dependencies=false\n',
    text => text + 'AUTO-INSTALL-PEERS=false\n',
  ]) {
    const { profile, config } = desktopNativeInstallTree();
    writeFileSync(join(profile, '.npmrc'), mutate(config));
    assert.throws(() => desktopPreparation.inspectDesktopNativeInstall(profile, '0.4.0'), /policy/);
  }
  const { profile, writePackage } = desktopNativeInstallTree();
  assert.throws(() => desktopPreparation.inspectDesktopNativeInstall(profile, '0.3.0'), /identity/);
  writePackage(join(profile, 'node_modules/dsh-grok-search'), 'not-the-candidate');
  assert.throws(() => desktopPreparation.inspectDesktopNativeInstall(profile, '0.4.0'), /identity/);
});

test('Desktop native install audit rejects top-level, nested, aliased and virtual-store host peer copies', () => {
  for (const [folder, name] of [
    ['node_modules/@deepseek-ai/dsh', '@deepseek-ai/dsh'],
    ['node_modules/dsh-grok-search/node_modules/@deepseek-ai/dsh-web', '@deepseek-ai/dsh-web'],
    ['node_modules/.pnpm/peer@1/node_modules/@deepseek-ai/cordis', '@deepseek-ai/cordis'],
    ['node_modules/renamed-host', '@deepseek-ai/schemastery'],
  ]) {
    const { profile, writePackage } = desktopNativeInstallTree();
    writePackage(join(profile, folder), name);
    assert.throws(() => desktopPreparation.inspectDesktopNativeInstall(profile, '0.4.0'), /private host peer/);
  }
});

test('Desktop native install audit never treats escaped dependencies or absent installs as zero host copies', () => {
  const { profile, writePackage } = desktopNativeInstallTree();
  const outside = mkdtempSync(join(sandbox, 'native-install-external-'));
  writePackage(outside, 'dependency');
  symlinkSync(outside, join(profile, 'node_modules/external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => desktopPreparation.inspectDesktopNativeInstall(profile, '0.4.0'), /outside the isolated/);
  const empty = mkdtempSync(join(sandbox, 'native-install-empty-'));
  assert.throws(() => desktopPreparation.inspectDesktopNativeInstall(empty, '0.4.0'));
});

test('Desktop receipt hashes, traversal, links and overlapping output roots fail before preparation writes',
  { skip: !desktopPlatform }, () => {
    const host = receiptDesktopFixture();
    assert.throws(() => inspectDesktopPreparation(host.executable, host.runRoot,
      { ...host.options, runtimeReceiptSha256: '0'.repeat(64) }), { code: 'COMPATIBILITY_HASH_MISMATCH' });
    for (const path of ['../outside.asar', '/outside.asar', 'C:/outside.asar', 'nested\\outside.asar']) {
      host.receipt.files.archive.path = path;
      assert.throws(() => inspectDesktopPreparation(host.executable, host.runRoot, host.saveReceipt()),
        { code: 'COMPATIBILITY_PATH_UNSAFE' });
    }
    const outside = mkdtempSync(join(temporary, 'dsh-receipt-outside-')), untouched = join(outside, 'untouched.txt');
    writeFileSync(untouched, 'untouched');
    symlinkSync(outside, join(host.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    host.receipt.files.archive.path = 'linked/untouched.txt';
    assert.throws(() => inspectDesktopPreparation(host.executable, host.runRoot, host.saveReceipt()),
      { code: 'COMPATIBILITY_PATH_UNSAFE' });
    assert.throws(() => inspectDesktopPreparation(untouched, host.runRoot, host.options), { code: 'COMPATIBILITY_PATH_UNSAFE' });
    assert.throws(() => inspectDesktopPreparation(host.executable, join(host.root, 'output'), host.options), /overlap/);
    assert.equal(readFileSync(untouched, 'utf8'), 'untouched');
    assert.equal(existsSync(host.runRoot), false);
    assert.equal(existsSync(join(host.root, 'output')), false);
    const changed = receiptDesktopFixture();
    writeFileSync(changed.executable, fuseBinary('001100011'));
    assert.throws(() => inspectDesktopPreparation(changed.executable, changed.runRoot, changed.options),
      { code: 'COMPATIBILITY_HASH_MISMATCH' });
    const forbiddenFuse = receiptDesktopFixture('0.2.2-rc.3', '101110011');
    assert.throws(() => inspectDesktopPreparation(forbiddenFuse.executable, forbiddenFuse.runRoot, forbiddenFuse.options), /fuses/);
    assert.equal(existsSync(forbiddenFuse.runRoot), false);
  });

test('搜索成功结果可靠采集，不要求错误字段且计数是结果完成后的快照', async () => {
  const calls = { original: 0, grok: 0 };
  const result = { content: '离线成功', sources: [], truncated: false };
  const capture = await captureDesktopSearch({ async search() { calls.grok++; return result; } }, calls);
  assert.deepEqual(capture, { ok: true, result, calls: { original: 0, grok: 1 } });
  assert.equal(Object.hasOwn(capture, 'error'), false);
  calls.grok++;
  assert.equal(capture.calls.grok, 1);
});

test('搜索错误和非 Error 拒绝均可记录，不能冒称搜索成功', async () => {
  const calls = { original: 0, grok: 0 };
  const error = Object.assign(new Error('需要完整退出并重启宿主才能完成退出'), { code: 'WEB_PROVIDER_CONFIGURED_MISSING' });
  const capture = await captureDesktopSearch({ async search() { throw error; } }, calls);
  assert.equal(capture.ok, false);
  assert.deepEqual(capture.error, { name: 'Error', code: error.code, message: error.message });
  assert.deepEqual(capture.calls, calls);
  const nonError = await captureDesktopSearch({ async search() { throw '原始拒绝文字'; } }, calls);
  assert.deepEqual(nonError.error, { name: 'Error', code: null, message: '原始拒绝文字' });
  assert.equal(nonError.ok, false);
});

test('恢复组件缺席或失败必须拒绝，合法恢复等待实际结果', async () => {
  for (const value of [undefined, {}, { retry: false }]) {
    await assert.rejects(waitForDesktopRecovery({ get: () => value }), /no recovery was completed/);
  }
  let completed = false;
  const result = await waitForDesktopRecovery({ get: () => ({ async retry() { completed = true; return { kind: 'corrected' }; } }) });
  assert.equal(completed, true);
  assert.deepEqual(result, { kind: 'corrected' });
  const failure = new Error('真实恢复失败');
  await assert.rejects(waitForDesktopRecovery({ get: () => ({ async retry() { throw failure; } }) }), error => error === failure);
});


test('Desktop seam 使用当前显式服务查询，不读取未注入的 web 属性且不缓存旧实例', async () => {
  const calls = { original: 0, grok: 0 };
  let web = { async search() { calls.grok++; return { content: '当前 Grok' }; } };
  const ctx = { get(name) { assert.equal(name, 'web'); return web; },
    get web() { throw new Error('cannot get property "web" without inject'); } };
  const first = await captureDesktopSeam(ctx, calls);
  assert.equal(first.ok, true);
  assert.equal(first.result.content, '当前 Grok');
  web = { async search() { throw Object.assign(new Error('暂不可用，需要完整重启'), { code: 'WEB_PROVIDER_CONFIGURED_MISSING' }); } };
  const remounted = await captureDesktopSeam(ctx, calls);
  assert.equal(remounted.ok, false);
  assert.equal(remounted.error.code, 'WEB_PROVIDER_CONFIGURED_MISSING');
  assert.deepEqual(first.calls, { original: 0, grok: 1 });
  assert.deepEqual(remounted.calls, first.calls);
});

test('Desktop Web 服务缺席拒绝 seam 采样，不能伪报业务成功或业务错误', async () => {
  for (const web of [undefined, {}, { search: false }]) {
    await assert.rejects(captureDesktopSeam({ get: () => web }, {}), /未完成 direct seam 采样/);
  }
});

test('Desktop 退出命令必须等待实际退出，不能发送后立刻关掉 CDP socket', async () => {
  let closed, socket;
  const whenClosed = new Promise(resolve => { closed = resolve; });
  class DeferredSocket extends EventTarget {
    constructor() {
      super(); socket = this; this.closed = false; this.dispatched = false;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(text) {
      assert.equal(JSON.parse(text).method, 'Browser.close');
      queueMicrotask(() => {
        if (!this.closed) { this.dispatched = true; closed(); }
      });
    }
    close() { this.closed = true; }
  }
  await requestDesktopShutdown(12345, whenClosed, {
    timeoutMs: 1000, WebSocketImpl: DeferredSocket,
    fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:12345/browser/test' }) }),
  });
  assert.equal(socket.dispatched, true);
  assert.equal(socket.closed, true, 'socket is released only after actual exit');
});

for (const failure of ['socket-error', 'open-timeout', 'runtime-enable']) {
  test(`renderer initialization closes its owned socket after ${failure}`, async t => {
    let socket;
    const originalWebSocket = globalThis.WebSocket;
    class FailingSocket extends EventTarget {
      closed = false;
      constructor() {
        super(); socket = this;
        if (failure !== 'open-timeout') queueMicrotask(() =>
          this.dispatchEvent(new Event(failure === 'socket-error' ? 'error' : 'open')));
      }
      send(text) {
        const { id, method } = JSON.parse(text);
        assert.equal(method, 'Runtime.enable');
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ id, error: { message: 'synthetic Runtime.enable failure' } }),
        })));
      }
      close() { this.closed = true; }
    }
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: true, json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:12345/page/test' }],
    }));
    globalThis.WebSocket = FailingSocket;
    try {
      await assert.rejects(connectRenderer(12345, { timeoutMs: 30, requestTimeoutMs: 30 }));
      assert.equal(socket.closed, true, 'failed setup cannot leave an unreachable live socket');
    } finally { socket?.close(); globalThis.WebSocket = originalWebSocket; }
  });
}

function acceptanceFixture() {
  const root = mkdtempSync(join(temporary, 'dsh-deferred-desktop-environment-'));
  const paths = desktopAcceptancePaths(root);
  mkdirSync(paths.profile, { recursive: true });
  const patch = [desktopWorkspacePatch(root)];
  writeFileSync(join(paths.profile, 'cordis.patch.yml'), JSON.stringify(patch), { flag: 'wx' });
  return { root, paths, patch };
}

test('桌面验收准备补齐隔离目录，不修改进程全局环境或替宿主注册工作区', () => {
  const { root, paths } = acceptanceFixture();
  const before = { ...process.env };
  const patchBefore = readFileSync(join(paths.profile, 'cordis.patch.yml'));
  const prepared = prepareDesktopAcceptanceEnvironment(root);
  for (const path of [paths.desktop, paths.documents, paths.downloads]) assert.equal(existsSync(path), true);
  assert.equal(existsSync(paths.workspace), false, 'default workspace belongs to official Host initialization');
  assert.equal(prepared.env.USERPROFILE, paths.home);
  assert.equal(prepared.env.DSH_HOME, paths.dshHome);
  assert.ok(JSON.stringify(Object.entries(process.env).sort()) === JSON.stringify(Object.entries(before).sort()),
    'global environment values are unchanged');
  assert.deepEqual(readFileSync(join(paths.profile, 'cordis.patch.yml')), patchBefore);
  const sentinel = join(paths.desktop, 'keep.txt');
  writeFileSync(sentinel, 'keep existing data', { flag: 'wx' });
  prepareDesktopAcceptanceEnvironment(root);
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep existing data');
});

test('未明确隔离Documents前拒绝准备，不偷偷回退到真实用户文档', () => {
  for (const patch of [[], [{ id: 'workspace-controller', disabled: true }],
    [{ id: 'workspace-controller', config: { documentsDirectory: 'C:/Users/real/Documents' } }]]) {
    const { root, paths } = acceptanceFixture();
    writeFileSync(join(paths.profile, 'cordis.patch.yml'), JSON.stringify(patch));
    assert.throws(() => prepareDesktopAcceptanceEnvironment(root), /Isolate documentsDirectory/);
    assert.equal(existsSync(paths.desktop), false);
  }
});

test('冲突和不可解析的工作区patch阻断准备，保留原文件', () => {
  const { root, paths, patch } = acceptanceFixture();
  const file = join(paths.profile, 'cordis.patch.yml');
  writeFileSync(file, JSON.stringify([...patch, ...patch]));
  assert.throws(() => prepareDesktopAcceptanceEnvironment(root), /Isolate documentsDirectory/);
  writeFileSync(file, '- invalid-for-this-dedicated-fixture');
  assert.throws(() => prepareDesktopAcceptanceEnvironment(root), /explicit JSON workspace patch/);
  assert.equal(readFileSync(file, 'utf8'), '- invalid-for-this-dedicated-fixture');
});

test('桌面验收拒绝普通目录、越界profile环境和大小写路径覆盖', () => {
  assert.throws(() => desktopAcceptancePaths(temporary), /dedicated temporary namespace/);
  assert.throws(() => desktopAcceptancePaths('relative'), /absolute/);
  const { root, paths } = acceptanceFixture();
  for (const extra of [{ USERPROFILE: temporary }, { Path: 'untrusted' }, { DSH_HOME: temporary },
    { GROK_SEARCH_CONFIG: join(temporary, 'outside.toml') }]) {
    assert.throws(() => prepareDesktopAcceptanceEnvironment(root, extra));
  }
  assert.equal(existsSync(paths.desktop), false);
});

test('隔离系统目录的外跳链接及文件冲突在创建其他目录前被拒绝', () => {
  const outside = mkdtempSync(join(temporary, 'dsh-environment-outside-'));
  const linked = acceptanceFixture();
  mkdirSync(linked.paths.home);
  symlinkSync(outside, linked.paths.documents, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareDesktopAcceptanceEnvironment(linked.root), /link/);
  assert.equal(existsSync(linked.paths.desktop), false);
  const collision = acceptanceFixture();
  mkdirSync(collision.paths.home);
  writeFileSync(collision.paths.desktop, 'not a directory', { flag: 'wx' });
  assert.throws(() => prepareDesktopAcceptanceEnvironment(collision.root), /unexpected type/);
  assert.equal(existsSync(collision.paths.downloads), false);
});

test('Windows桌面验收能按名称找到PowerShell且系统桌面解析到现存隔离目录', {
  skip: process.platform !== 'win32',
}, async () => {
  const { root, paths } = acceptanceFixture();
  const { env } = prepareDesktopAcceptanceEnvironment(root);
  const result = await commandResult('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)'],
  { cwd: root, env, timeoutMs: 15_000 });
  assert.equal(result.exitCode, 0, result.spawnError ?? result.stderr);
  assert.equal(result.rawStdout.trim(), paths.desktop);
  assert.equal(env.PATH.includes(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')), true);
});

test('B3 legacy temporary mode rejects unsafe run identifiers before preparing outputs', async () => {
  const { parseCliWebArguments } = await import('../scripts/b3-cli-web.mjs');
  const args = ['--worker', '--dsh-cli', join(sandbox, 'bin.js'), '--dsh-version', 'rc2',
    '--product-package', join(sandbox, 'product.tgz'), '--grok-linux-archive', join(sandbox, 'grok.tgz'),
    '--browser-executable', '/synthetic/browser', '--pnpm-entry', join(sandbox, 'pnpm.cjs'),
    '--pnpm-store', join(sandbox, 'store'), '--pnpm-cache', join(sandbox, 'cache')];
  for (const runId of ['../../outside', '../previous', 'path/nested', 'path\\nested', '/absolute', '', 'line\nbreak']) {
    assert.throws(() => parseCliWebArguments([...args, '--run-id', runId]), /run-id/);
  }
  assert.equal(parseCliWebArguments([...args, '--run-id', 'bounded-040']).runId, 'bounded-040');
});

test('B3 artifact preparation rejects historical receipts and links but permits an empty bootstrap handoff', async () => {
  const { lstatSync } = await import('node:fs');
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  mkdirSync(ARTIFACT_ROOT,');
  const end = source.indexOf('  if (options.runRoot !== undefined || !existsSync(runRoot))', start);
  assert.ok(start > 0 && end > start);
  const prepare = new Function('ARTIFACT_ROOT', 'artifactDir', 'options', 'mkdirSync', 'existsSync',
    'statSync', 'lstatSync', 'readdirSync', source.slice(start, end));
  const root = mkdtempSync(join(sandbox, 'b3-artifact-boundary-')), previous = join(root, 'previous');
  mkdirSync(previous);
  const run = (directory, options = {}) => prepare(root, directory, options, mkdirSync, existsSync,
    () => ({ isDirectory: () => true }), lstatSync, path => {
      if (path === previous) return ['summary.json'];
      return [];
    });
  writeFileSync(join(previous, 'summary.json'), '{"retained":true}\n', { flag: 'wx' });
  assert.throws(() => run(previous), /Artifact directory must be new/);
  assert.throws(() => run(previous, { bootstrapFile: 'explicit-bootstrap.json' }), /Artifact directory must be new/);
  assert.equal(readFileSync(join(previous, 'summary.json'), 'utf8'), '{"retained":true}\n');
  const empty = join(root, 'empty');
  mkdirSync(empty);
  assert.throws(() => run(empty), /Artifact directory must be new/);
  assert.doesNotThrow(() => run(empty, { bootstrapFile: 'explicit-bootstrap.json' }));
  const linked = join(root, 'linked');
  symlinkSync(empty, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => run(linked, { bootstrapFile: 'explicit-bootstrap.json' }), /Artifact directory must be new/);
});

test('B3 already-exited hosts retain actual exit failures and independently observed child residue', () => {
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function terminateWebProcess(');
  const end = source.indexOf('\nfunction compactEvent(', start);
  assert.ok(start > 0 && end > start);
  const remaining = [{ pid: 202, command: '/owned/run/grok' }];
  const terminate = new Function('pidAlive', 'matchingProcesses',
    source.slice(start, end) + '\nreturn terminateWebProcess;')(
    pid => { assert.equal(pid, 101); return false; },
    paths => { assert.deepEqual(paths, ['/owned/run', '/owned/run/grok']); return remaining; });
  return (async () => {
    for (const [exitCode, signal] of [[23, null], [null, 'SIGKILL'], [0, null]]) {
      const result = await terminate({ closed: true, exitCode, signal, child: { pid: 101 } },
        '/owned/run', '/owned/run/grok');
      assert.equal(result.graceful, exitCode === 0 && signal === null);
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.exitSignal, signal);
      assert.deepEqual(result.leftoverMatchingProcesses, remaining);
    }
  })();
});

test('B3 requested shutdown cannot classify abnormal actual exits as graceful', async () => {
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function terminateWebProcess(');
  const end = source.indexOf('\nfunction compactEvent(', start);
  assert.ok(start > 0 && end > start);
  for (const [exitCode, signal] of [[23, null], [null, 'SIGTERM'], [0, null]]) {
    let finish;
    const web = { child: { pid: 101, kill() { assert.fail('The host already exited.'); } },
      closed: false, exitCode: null, signal: null,
      exited: new Promise(resolve => { finish = resolve; }) };
    const terminate = new Function('pidAlive', 'matchingProcesses', 'process', 'delay',
      source.slice(start, end) + '\nreturn terminateWebProcess;')(
      () => false, () => [], { kill(pid, sent) {
        assert.equal(pid, 101); assert.equal(sent, 'SIGTERM');
        Object.assign(web, { closed: true, exitCode, signal });
        finish({ code: exitCode, signal });
      } }, () => new Promise(() => {}));
    const result = await terminate(web, '/owned/run', '/owned/run/grok');
    assert.equal(result.graceful, exitCode === 0 && signal === null);
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.exitSignal, signal);
  }
});

async function b3RunRootResolver() {
  const { posix } = await import('node:path');
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function resolveCliWebRunRoot(options) {');
  const end = source.indexOf('export function inspectCliWebHostPeers', start);
  assert.ok(start >= 0 && end > start);
  const directory = overrides => ({ uid: 1000, mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false, ...overrides });
  const entries = new Map(['/', '/home', '/home/ubuntu', '/home/ubuntu/.cache', '/home/ubuntu/.cache/acceptance',
    '/workspace', '/inputs', '/inputs/product', '/inputs/cli', '/inputs/store', '/inputs/cache']
    .map(path => [path, directory()]));
  const aliases = new Map(), env = { platform: 'linux' };
  const resolveRoot = new Function('platform', 'process', 'resolve', 'dirname', 'relative', 'isAbsolute',
    'lstatSync', 'realpathSync', 'PROJECT_ROOT', 'findInstallRoot',
    source.slice(start, end).replace(/^export /, '') + '\nreturn resolveCliWebRunRoot;')(
    () => env.platform, { getuid: () => 1000 }, posix.resolve, posix.dirname, posix.relative, posix.isAbsolute,
    path => {
      if (!entries.has(path)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return entries.get(path);
    }, path => aliases.get(path) ?? path, '/workspace', () => '/inputs/cli');
  const options = { worker: true, runRoot: '/home/ubuntu/.cache/acceptance/fresh-rc3',
    productPackage: '/inputs/product/frozen.tgz', dshCli: '/inputs/cli/node_modules/@deepseek-ai/dsh/lib/bin.js',
    pnpmStore: '/inputs/store', pnpmCache: '/inputs/cache' };
  return { resolveRoot, entries, aliases, env, options, directory, source };
}

test('B3 persistent run root accepts a fresh owned direct-worker path without creating it', async () => {
  const h = await b3RunRootResolver();
  assert.equal(h.resolveRoot(h.options), h.options.runRoot);
  assert.equal(h.entries.has(h.options.runRoot), false);
  h.entries.set(h.options.runRoot, h.directory());
  assert.throws(() => h.resolveRoot(h.options), /fresh, nonexistent/);
});

test('B3 persistent run root rejects other platforms, bootstrap, unsafe paths and artifact names', async () => {
  const h = await b3RunRootResolver();
  for (const patch of [{ worker: false }, { bootstrapFile: '/input/bootstrap.json' }]) {
    assert.throws(() => h.resolveRoot({ ...h.options, ...patch }), /direct Linux/);
  }
  for (const runRoot of ['relative', '/', '/home/ubuntu/.cache/acceptance/../run',
    '/home/ubuntu/.cache/acceptance//run', '/home/ubuntu/.cache/acceptance/run/',
    '/home/ubuntu/.cache/acceptance/run\n', '/home/ubuntu/.cache/acceptance/run\\bad']) {
    assert.throws(() => h.resolveRoot({ ...h.options, runRoot }), /normalized absolute/);
  }
  for (const runId of ['../escape', '/absolute', 'line\nbreak', 'a'.repeat(121)]) {
    assert.throws(() => h.resolveRoot({ ...h.options, runId }), /artifact directory name/);
  }
  h.env.platform = 'win32';
  assert.throws(() => h.resolveRoot(h.options), /direct Linux/);
});

test('B3 persistent run root rejects absent, unowned, writable or linked parents and dangling targets', async () => {
  for (const mutate of [
    h => h.entries.delete('/home/ubuntu/.cache/acceptance'),
    h => h.entries.set('/home/ubuntu/.cache/acceptance', h.directory({ uid: 0 })),
    h => h.entries.set('/home/ubuntu/.cache/acceptance', h.directory({ mode: 0o40777 })),
    h => h.entries.set('/home/ubuntu/.cache/acceptance', h.directory({ isDirectory: () => false })),
    h => h.entries.set('/home/ubuntu/.cache', h.directory({ isSymbolicLink: () => true })),
    h => h.aliases.set('/home/ubuntu/.cache/acceptance', '/different/parent'),
    h => h.entries.set(h.options.runRoot, h.directory({ isSymbolicLink: () => true })),
  ]) {
    const h = await b3RunRootResolver(); mutate(h);
    assert.throws(() => h.resolveRoot(h.options));
  }
});

test('B3 persistent run root rejects project, product, host and cache overlaps including aliases', async () => {
  for (const base of ['/workspace', '/inputs/product', '/inputs/cli', '/inputs/store', '/inputs/cache']) {
    const h = await b3RunRootResolver();
    assert.throws(() => h.resolveRoot({ ...h.options, runRoot: base + '/new-run' }), /must not overlap/);
    h.aliases.set(base, h.options.runRoot + '/protected');
    assert.throws(() => h.resolveRoot(h.options), /must not overlap/);
  }
  const h = await b3RunRootResolver();
  assert.throws(() => h.resolveRoot({ ...h.options, candidateRoot: '/home/ubuntu/.cache/acceptance' }), /must not overlap/);
});

test('B3 persistent option is wired before worker writes while legacy bootstrap and redaction remain', async () => {
  const { source } = await b3RunRootResolver();
  assert.match(source, /\['--run-root', 'runRoot'\]/);
  const worker = source.slice(source.indexOf('async function linuxWorker(options) {'));
  assert.ok(worker.indexOf('resolveCliWebRunRoot(options)') < worker.indexOf('mkdirSync(ARTIFACT_ROOT'));
  assert.match(worker, /options\.runRoot !== undefined \|\| !existsSync\(runRoot\).*mkdirSync\(runRoot, \{ recursive: false, mode: 0o700 \}/);
  assert.match(worker, /\[runRoot, '<RUN_ROOT>'\]/);
  const bootstrap = source.slice(source.indexOf('async function windowsBootstrap(options) {'), source.indexOf('class Evidence'));
  assert.match(bootstrap, /if \(options\.runRoot !== undefined\) throw/);
  assert.match(bootstrap, /const runRoot = `\/tmp\/dsh-grok-cli-web-\$\{runId\}`/);
});

test('B3 install arguments use strict ordinary peer resolution without a bypass', async () => {
  const { cliWebPluginAddArguments } = await import('../scripts/b3-cli-web.mjs');
  const args = cliWebPluginAddArguments({ copiedCli: 'bin.js', productCopy: 'frozen.tgz',
    pnpmStore: 'owned-store', pnpmCache: 'owned-cache' });
  assert.deepEqual(args.slice(0, 6), ['bin.js', 'plugin', '--profile', 'web', 'add', 'frozen.tgz']);
  assert.ok(args.includes('--config.strict-peer-dependencies=true'));
  assert.ok(args.includes('--config.auto-install-peers=true'));
  assert.ok(args.includes('--offline'));
  assert.ok(args.includes('--ignore-scripts'));
  assert.equal(args.some(arg => /legacy-peer|^--force|peer.*=false/.test(arg)), false);
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /strict-peer-dependencies=false|auto-install-peers=false/);
  assert.equal([...source.matchAll(/runCaptured\('plugin-add'/g)].length, 1, 'no retry with relaxed peers');
});

test('B3 overlay npm cannot inherit formal home, credential config or a shared default cache', async () => {
  const { cliWebNpmEnvironment } = await import('../scripts/b3-cli-web.mjs');
  const root = join(sandbox, 'b3-env-not-created');
  const env = cliWebNpmEnvironment(root, {
    PATH: 'synthetic-path', HOME: 'formal-home', npm_config_userconfig: 'formal-npmrc',
    npm_config_cache: 'shared-cache', NPM_TOKEN: 'never-forward', npm_config_force: 'true',
  });
  assert.equal(env.HOME, join(root, 'home'));
  assert.equal(env.npm_config_userconfig, join(root, 'npm-user.npmrc'));
  assert.equal(env.npm_config_globalconfig, join(root, 'npm-global.npmrc'));
  assert.equal(env.npm_config_cache, join(root, 'npm-cache'));
  assert.equal(env.npm_config_strict_peer_deps, 'true');
  assert.equal(env.npm_config_legacy_peer_deps, 'false');
  assert.equal(env.npm_config_force, 'false');
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(existsSync(root), false);
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf("writeFileSync(npmEnv.npm_config_userconfig, '', { flag: 'wx'") <
    source.indexOf("runCaptured('install-linux-native'"));
});

test('B3 host-peer audit distinguishes profile and staged providers from nested copies including pnpm slots', async () => {
  const { inspectCliWebHostPeers } = await import('../scripts/b3-cli-web.mjs');
  const root = mkdtempSync(join(sandbox, 'b3-peers-')), modules = join(root, 'node_modules');
  const hostRoot = mkdtempSync(join(sandbox, 'b3-staged-host-'));
  const host = join(hostRoot, 'node_modules', '@deepseek-ai', 'cordis');
  mkdirSync(host, { recursive: true });
  mkdirSync(join(modules, '@deepseek-ai', 'dsh-web'), { recursive: true });
  const pluginPeers = join(modules, 'dsh-grok-search', 'node_modules', '@deepseek-ai');
  mkdirSync(pluginPeers, { recursive: true });
  symlinkSync(host, join(pluginPeers, 'cordis'), process.platform === 'win32' ? 'junction' : 'dir');
  let audit = inspectCliWebHostPeers(root, { hostRoot });
  assert.equal(audit.nestedHostPeers.length, 0);
  assert.deepEqual(audit.providedHostPeers, ['@deepseek-ai/dsh-web']);
  assert.deepEqual(audit.stagedHostPeers, ['@deepseek-ai/cordis']);
  mkdirSync(join(pluginPeers, 'dsh-web'));
  mkdirSync(join(modules, '.pnpm', 'nested-slot', 'node_modules', '@deepseek-ai', 'schemastery'), { recursive: true });
  audit = inspectCliWebHostPeers(root, { hostRoot });
  assert.deepEqual(audit.nestedHostPeers.map(row => row.name).sort(), ['@deepseek-ai/dsh-web', '@deepseek-ai/schemastery']);
  assert.equal(audit.hostPeers.some(row => row.realPath.startsWith('<STAGED_HOST>/')), true);
});

test('B3 host-peer audit rejects missing trees and external links rather than certifying zero copies', async () => {
  const { inspectCliWebHostPeers } = await import('../scripts/b3-cli-web.mjs');
  const root = mkdtempSync(join(sandbox, 'b3-peers-unsafe-'));
  assert.throws(() => inspectCliWebHostPeers(root), /requires the installed/);
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(sandbox, join(root, 'node_modules', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inspectCliWebHostPeers(root), /outside the isolated/);
});

test('B3 reload accepts only exact fail-closed transition codes and host-observed web_search revocation', async () => {
  const { cliWebReloadOutcome } = await import('../scripts/b3-cli-web.mjs');
  const result = (code, text = code) => ({ overlappedReload: true, toolErrorCode: code,
    toolResult: { isError: true, content: [{ type: 'text', text }] } });
  for (const code of ['ABORTED', 'CANCELLED', 'GROK_SEARCH_STOPPING', 'GROK_SEARCH_CANCELLED', 'GROK_CANCELLED',
    'CONTROL_ACQUISITION_CANCELLED', 'CONTROL_ROUTE_VERIFIER_DISPOSED', 'COMPATIBILITY_STOPPED',
    'COMPATIBILITY_CHECKING', 'COMPATIBILITY_CORE_PENDING', 'COMPATIBILITY_CONTRACT_PENDING',
    'COMPATIBILITY_ROUTE_UNCONFIRMED', 'COMPATIBILITY_BUDGET_UNCONFIRMED', 'COMPATIBILITY_INITIALIZATION_PENDING']) {
    assert.equal(cliWebReloadOutcome(result(code)).accepted, true, code);
  }
  assert.equal(cliWebReloadOutcome(result('UNKNOWN_TOOL', 'Unknown tool: web_search')).accepted, true);
  assert.equal(cliWebReloadOutcome(result(null, 'COMPATIBILITY_CHECKING: waiting for the current epoch')).accepted, true);
  for (const code of ['GROK_TIMEOUT', 'GROK_PROCESS_REAP_FAILED', 'CONTROL_ROUTE_COUNTER_REQUIRED',
    'CONTROL_ROUTE_OWNERSHIP_CONFLICT', 'WEB_PROVIDER_FAILED', 'COMPATIBILITY_CONTRACT_FAILED',
    'COMPATIBILITY_ABI_UNSUPPORTED', 'COMPATIBILITY_CONFIRMATION_REQUIRED', 'COMPATIBILITY_STATE_PATH_UNSAFE',
    'COMPATIBILITY_OPTIONAL_PENDING', 'COMPATIBILITY_BLOCKED']) {
    assert.equal(cliWebReloadOutcome(result(code)).accepted, false, code);
  }
  for (const value of [
    result('UNKNOWN_TOOL', 'Unknown tool: web_fetch'),
    result('UNKNOWN_TOOL', 'Unknown tool: web_search\nother error'),
    result('WEB_PROVIDER_FAILED', 'COMPATIBILITY_CHECKING'),
    result('COMPATIBILITY_CHECKING', 'COMPATIBILITY_CHECKING GROK_PROCESS_REAP_FAILED'),
    result(null, 'An arbitrary search error'),
    { ...result('COMPATIBILITY_CHECKING'), overlappedReload: false },
    { overlappedReload: true, toolResult: { isError: false, content: [{ type: 'text', text: 'not a real search' }] } },
  ]) assert.equal(cliWebReloadOutcome(value).accepted, false);
});

test('B3 reload recognizes the exact code-stripped guard only during the measured overlap', async () => {
  const { cliWebReloadOutcome } = await import('../scripts/b3-cli-web.mjs');
  const message = 'Error: Search is blocked until runtime compatibility is established.';
  const observation = () => ({
    overlappedReload: true, toolErrorCode: null, reloadStartedAt: 100, reloadSettledAt: 130,
    toolCallAt: 100, toolResultAt: 110,
    toolResult: { isError: true, content: [{ type: 'text', text: message }] },
  });
  assert.deepEqual(cliWebReloadOutcome(observation()), {
    accepted: true, code: null, kind: 'admission-pending', evidence: 'exact-compatibility-guard-message',
  });
  for (const mutate of [
    value => { value.overlappedReload = false; },
    value => { delete value.reloadStartedAt; },
    value => { value.toolResultAt = 131; },
    value => { value.toolResultAt = 99; },
    value => { value.toolCallAt = 120; },
    value => { value.toolErrorCode = 'COMPATIBILITY_CONTRACT_FAILED'; },
    value => { value.toolErrorCode = 'COMPATIBILITY_STATE_PATH_UNSAFE'; },
    value => { value.toolResult.isError = false; },
    value => { delete value.toolResult.content; },
    value => { value.toolResult.content[0].text += '\nAdditional failure'; },
    value => { value.toolResult.content[0].text = message.replace('blocked', 'stopped'); },
    value => { value.toolResult.content[0].text = message + ' '; },
    value => { value.toolResult.content.push({ type: 'text', text: '' }); },
  ]) {
    const value = observation(); mutate(value);
    assert.equal(cliWebReloadOutcome(value).accepted, false);
  }
});

test('B3 always demands real post-reload recovery and zero canonical or stub official calls', async () => {
  const { cliWebReloadRecoveryPassed } = await import('../scripts/b3-cli-web.mjs');
  const good = () => ({
    recovered: {
      toolCall: { name: 'web_search' },
      toolResult: { isError: false, text: 'Linux grok-search-rs 0.1.26 real MCP search succeeded.' },
      snapshot: { runtimeWeb: { searchProviderId: 'grok-search' }, calls: { original: 0 }, originalSearchCounter: { calls: 0 } },
    },
    grokRequestsBefore: 3, grokRequestsAfter: 4, officialRequestsBefore: 0, officialRequestsAfter: 0,
  });
  assert.equal(cliWebReloadRecoveryPassed(good()), true);
  for (const mutate of [
    value => { value.recovered.toolCall.name = 'web_fetch'; },
    value => { value.recovered.toolResult.isError = true; },
    value => { value.recovered.toolResult.text = 'cached unrelated text'; },
    value => { value.recovered.snapshot.runtimeWeb.searchProviderId = 'official'; },
    value => { value.recovered.snapshot.calls.original = 1; },
    value => { value.recovered.snapshot.originalSearchCounter.calls = 1; },
    value => { delete value.recovered.snapshot.originalSearchCounter; },
    value => { value.grokRequestsAfter = value.grokRequestsBefore; },
    value => { value.officialRequestsBefore = value.officialRequestsAfter = 1; },
  ]) {
    const value = good(); mutate(value);
    assert.equal(cliWebReloadRecoveryPassed(value), false);
  }
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("const reloadState = await probe('reload-web-with-session-search'");
  const end = source.indexOf("step('conversation-flow'", start);
  const block = source.slice(start, end);
  assert.match(block, /await runTurn\('post-reload-admission-recovery', 'search', 'web_search'\)/);
  assert.doesNotMatch(block, /MODERN_VERSIONS|if \(revokedAdmission\)|if \(reloadState\.reloadProbe/);
});

test('B3 known-alias receipts accept omitted Node engines while rc3 requires its pinned range', async () => {
  const { parseCliWebArguments, cliNodeVersionSupported } = await import('../scripts/b3-cli-web.mjs');
  const { npmIdentity } = await import('../scripts/lib/compatibility-evidence.mjs');
  for (const [version, alias, nodeRange] of [['0.2.1-rc.2', 'rc2', null], ['0.2.2-rc.3', '0.2.2-rc.3', '>=24.9.0']]) {
    const root = mkdtempSync(join(sandbox, 'b3-cli-receipt-'));
    const executable = join(root, 'bin.js'), manifestPath = join(root, 'package.json');
    const manifest = { name: '@deepseek-ai/dsh', version, ...(nodeRange ? { engines: { node: nodeRange } } : {}) };
    writeFileSync(executable, '// synthetic receipt fixture; never executed');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const bytes = Buffer.from('synthetic CLI archive, not an official host');
    const metadata = Buffer.from(JSON.stringify({ name: manifest.name, versions: { [version]: {
      ...manifest, dist: { tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`,
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') },
    } } }));
    const receipt = { schemaVersion: 1, kind: 'verified-runtime-candidate',
      asset: verifyHostAsset(npmIdentity(metadata, { packageName: manifest.name, version, lane: 'linux-cli' }), bytes),
      files: Object.fromEntries([['executable', executable], ['cliManifest', manifestPath]].map(([role, path]) =>
        [role, { path: relative(root, path).split(sep).join('/'), sha256: sha256(readFileSync(path)) }])) };
    const receiptPath = join(root, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const args = ['--dsh-cli', executable, '--dsh-version', alias, '--product-package', join(root, 'frozen.tgz'),
      '--grok-linux-archive', join(root, 'grok.tgz'), '--browser-executable', '/synthetic/chromium',
      '--pnpm-entry', join(root, 'pnpm.cjs'), '--pnpm-store', join(root, 'store'), '--pnpm-cache', join(root, 'cache'),
      '--case', 'full', '--candidate-receipt', receiptPath, '--candidate-sha256', sha256(readFileSync(receiptPath)),
      '--candidate-root', root];
    assert.equal(parseCliWebArguments(args).candidateReceipt.asset.nodeRange, nodeRange);
    assert.equal(cliNodeVersionSupported('24.9.0', alias, receipt), true);
    if (nodeRange) {
      assert.equal(cliNodeVersionSupported('24.8.0', alias, receipt), false);
      assert.equal(cliNodeVersionSupported('24.9.0', alias), false);
    }
  }
});

async function b3BrowserTemporaryHarness() {
  const { posix } = await import('node:path');
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function createCliWebBrowserTemporaryRoot(');
  const end = source.indexOf('export function cliWebBrowserArguments(', start);
  assert.ok(start >= 0 && end > start);
  const directory = overrides => ({ uid: 1000, mode: 0o40700, isDirectory: () => true,
    isSymbolicLink: () => false, ...overrides });
  const entries = new Map(['/', '/home', '/home/ubuntu', '/home/ubuntu/.cache']
    .map(path => [path, directory()]));
  const aliases = new Map(), env = { platform: 'linux', suffix: 'Ab12Cd', created: null, writes: [] };
  const createRoot = new Function('platform', 'userInfo', 'process', 'resolve', 'dirname', 'join',
    'lstatSync', 'realpathSync', 'mkdtempSync', 'Buffer',
    source.slice(start, end).replace(/^export /, '') + '\nreturn createCliWebBrowserTemporaryRoot;')(
    () => env.platform, () => ({ homedir: '/home/ubuntu' }), { getuid: () => 1000 },
    posix.resolve, posix.dirname, posix.join, path => {
      if (!entries.has(path)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return entries.get(path);
    }, path => aliases.get(path) ?? path, prefix => {
      const path = prefix + env.suffix;
      env.writes.push(path);
      entries.set(path, directory(env.created ?? {}));
      return path;
    }, Buffer);
  return { createRoot, entries, aliases, env, directory, source };
}

test('B3 browser TMPDIR uses a fresh private account cache root instead of the long run or injected HOME', async () => {
  const h = await b3BrowserTemporaryHarness();
  const result = h.createRoot();
  assert.equal(result.path, '/home/ubuntu/.cache/b3-cdp-Ab12Cd');
  assert.equal(result.singletonSocketMaxBytes, Buffer.byteLength(result.path + '/org.chromium.Chromium.XXXXXX/SingletonSocket'));
  assert.ok(result.singletonSocketMaxBytes < 108);
  assert.deepEqual(h.env.writes, [result.path]);
  h.env.suffix = 'Ef34Gh';
  assert.notEqual(h.createRoot().path, result.path);
  assert.match(h.source, /parent = join\(userInfo\(\)\.homedir, '\.cache'\)/);
  assert.doesNotMatch(h.source.slice(h.source.indexOf('export function createCliWebBrowserTemporaryRoot('),
    h.source.indexOf('export function cliWebBrowserArguments(')), /process\.env\.HOME|rmSync|recursive: true/);
});

test('B3 browser TMPDIR rejects links, unsafe ownership and UTF-8 socket overflow before creating it', async () => {
  for (const change of [
    h => { h.env.platform = 'win32'; },
    h => h.entries.delete('/home/ubuntu/.cache'),
    h => h.entries.set('/home/ubuntu/.cache', h.directory({ uid: 0 })),
    h => h.entries.set('/home/ubuntu/.cache', h.directory({ mode: 0o40777 })),
    h => h.entries.set('/home/ubuntu/.cache', h.directory({ isDirectory: () => false })),
    h => h.entries.set('/home/ubuntu', h.directory({ isSymbolicLink: () => true })),
    h => h.aliases.set('/home/ubuntu/.cache', '/different/cache'),
  ]) {
    const h = await b3BrowserTemporaryHarness(); change(h);
    assert.throws(() => h.createRoot());
    assert.deepEqual(h.env.writes, []);
  }
  const h = await b3BrowserTemporaryHarness();
  for (const path of ['relative', '/home/ubuntu/.cache/../tmp', '/home//ubuntu', '/home/ubuntu/',
    '/home/ubuntu/cache\n', '/home/ubuntu/cache\\bad']) {
    assert.throws(() => h.createRoot(path), /normalized absolute/);
  }
  for (const leaf of ['a'.repeat(36), '\u754c'.repeat(13)]) {
    const path = '/home/ubuntu/' + leaf;
    h.entries.set(path, h.directory());
    assert.throws(() => h.createRoot(path), /too long/);
    assert.deepEqual(h.env.writes, []);
  }
  const longest = '/home/ubuntu/' + 'a'.repeat(35);
  h.entries.set(longest, h.directory());
  assert.equal(h.createRoot(longest).singletonSocketMaxBytes, 107);
  for (const created of [{ mode: 0o40755 }, { uid: 0 }, { isSymbolicLink: () => true }]) {
    const unsafe = await b3BrowserTemporaryHarness();
    unsafe.env.created = created;
    assert.throws(() => unsafe.createRoot(), /fresh private canonical/);
  }
});

async function b3ObservedBrowser(options) {
  const { EventEmitter } = await import('node:events');
  const { observeCliWebBrowser } = await import('../scripts/b3-cli-web.mjs');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.exitCode = null;
  child.signalCode = null;
  const observation = observeCliWebBrowser(child, options);
  const close = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  const assertDetached = () => {
    for (const event of ['error', 'exit', 'close']) assert.equal(child.listenerCount(event), 0);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
  };
  return { child, observation, close, assertDetached };
}

test('B3 browser observation captures a split loopback endpoint and bounded logs then releases listeners', async () => {
  const h = await b3ObservedBrowser({ timeoutMs: 100, outputLimit: 100 });
  h.child.stderr.emit('data', 'DevTools listening on ws://127.0.0.');
  h.child.stderr.emit('data', '1:43123/devtools/browser/fixture\n');
  assert.deepEqual(await h.observation.ready, { port: 43123 });
  h.child.stdout.emit('data', 'a'.repeat(150));
  h.child.stderr.emit('data', 'b'.repeat(150));
  assert.equal(h.observation.snapshot().stdout.length, 100);
  assert.equal(h.observation.snapshot().stderr.length, 100);
  h.close();
  assert.deepEqual(await h.observation.whenClosed, { code: 0, signal: null });
  assert.equal(h.observation.snapshot().startupFailure, null);
  h.assertDetached();
});

test('B3 browser SIGTRAP and early exit fail immediately without treating a stale endpoint as ready', async () => {
  for (const [code, signal, kind] of [[null, 'SIGTRAP', 'early-signal'], [1, null, 'early-exit']]) {
    const h = await b3ObservedBrowser({ timeoutMs: 1000 });
    const rejected = assert.rejects(h.observation.ready, new RegExp(kind));
    h.child.stderr.emit('data', 'original crash diagnostics\n');
    h.close(code, signal);
    h.child.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:43123/');
    await rejected;
    assert.deepEqual(h.observation.snapshot().startupFailure, { kind, exitCode: code, signal, spawnError: null });
    assert.equal(h.observation.snapshot().port, null);
    assert.match(h.observation.snapshot().stderr, /original crash diagnostics/);
    h.assertDetached();
  }
  const h = await b3ObservedBrowser({ timeoutMs: 1000 });
  const rejected = assert.rejects(h.observation.ready, /early-signal/);
  h.child.signalCode = 'SIGTRAP';
  h.child.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:43123/');
  h.close(null, 'SIGTRAP');
  await rejected;
  assert.equal(h.observation.snapshot().port, null);
  h.assertDetached();
});

test('B3 browser spawn error and deadline remain hard failures with structured diagnostics', async () => {
  const h = await b3ObservedBrowser({ timeoutMs: 1000 });
  const rejected = assert.rejects(h.observation.ready, /spawn-error; ENOENT/);
  h.child.emit('error', Object.assign(new Error('synthetic executable missing'), { code: 'ENOENT' }));
  h.child.emit('close', -2, null);
  await rejected;
  assert.deepEqual(h.observation.snapshot().spawnError, { code: 'ENOENT', message: 'synthetic executable missing' });
  h.assertDetached();
  const timeout = await b3ObservedBrowser({ timeoutMs: 5 });
  timeout.child.stderr.emit('data', 'DevTools listening on ws://0.0.0.0:43123/');
  await assert.rejects(timeout.observation.ready, /endpoint-timeout/);
  timeout.child.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:43123/');
  assert.equal(timeout.observation.snapshot().port, null);
  timeout.close();
  timeout.assertDetached();
});

test('B3 browser preserves the exact profile and safety flags while redacting the separate TMPDIR evidence', async () => {
  const { cliWebBrowserArguments } = await import('../scripts/b3-cli-web.mjs');
  const profile = '/owned/long-profile-unchanged';
  assert.deepEqual(cliWebBrowserArguments(profile), [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank',
  ]);
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('const browserSettingsDom = async () => {'),
    source.indexOf('const initial = await waitFor', source.indexOf('const browserSettingsDom = async () => {')));
  assert.match(block, /TMPDIR: browserTemporary\.path/);
  assert.match(block, /evidence\.replacements\.unshift\(\[browserTemporary\.path, '<BROWSER_TMP_ROOT>'\]\)/);
  assert.match(block, /HOME: home/);
  assert.match(block, /const debug = await observation\.ready/);
  assert.match(block, /evidence\.json\('linux-browser-launch\.json'/);
  assert.match(block, /spawnError: result\.spawnError/);
  assert.match(block, /startupFailure: result\.startupFailure/);
  assert.doesNotMatch(block, /TMPDIR: join\(runRoot|waitFor\(\(\) =>|process\.kill\(-child\.pid, 'SIGTERM'\).*catch.*await delay/s);
});

function hostContractResolver(script) {
  const source = readFileSync(new URL(`../scripts/${script}.mjs`, import.meta.url), 'utf8');
  const start = source.indexOf('function resolveHostInput(input) {');
  const end = source.indexOf('const [archive,', start);
  assert.ok(start >= 0 && end > start, 'isolate path resolution before any real host imports');
  return new Function('assert', 'resolve', 'join', 'existsSync', 'readFileSync',
    source.slice(start, end) + '\nreturn resolveHostInput;')(assert, resolve, join, existsSync, readFileSync);
}

function hostContractTree({ desktop = false, version = '0.2.2-rc.3',
  runtimeName = '@deepseek-ai/dsh-desktop-runtime' } = {}) {
  const root = mkdtempSync(join(sandbox, 'host-contract-root-'));
  const input = join(root, desktop ? 'app.asar' : 'cli'), runtime = desktop ? join(input, 'dsh') : input;
  const hostRoot = join(runtime, 'node_modules', '@deepseek-ai');
  const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  if (desktop) {
    write(join(input, 'package.json'), { name: '@deepseek-ai/dsh-desktop', version });
    write(join(runtime, 'package.json'), { name: runtimeName, version });
    write(join(runtime, 'desktop-runtime.json'), { release: { version } });
  }
  for (const name of ['dsh', 'dsh-tools', 'dsh-web', 'dsh-tool-web']) {
    write(join(hostRoot, name, 'package.json'), { name: `@deepseek-ai/${name}`, version });
  }
  return { input, runtime, hostRoot, version, write };
}

test('Host contract resolvers accept real CLI roots without a fake archive or root manifest', () => {
  for (const script of ['verify-search-execution-host', 'verify-github-read-host']) {
    const resolveHost = hostContractResolver(script);
    for (const version of ['0.2.1-rc.2', '0.2.2-rc.3']) {
      const tree = hostContractTree({ version });
      assert.equal(existsSync(join(tree.input, 'package.json')), false);
      assert.equal(existsSync(join(tree.input, 'dsh')), false);
      assert.deepEqual(resolveHost(tree.input), { hostRoot: tree.hostRoot, version });
    }
  }
});

test('Host contract resolvers preserve the Desktop ASAR path and reject relabelled hosts', () => {
  for (const script of ['verify-search-execution-host', 'verify-github-read-host']) {
    const resolveHost = hostContractResolver(script), tree = hostContractTree({ desktop: true });
    assert.deepEqual(resolveHost(tree.input), { hostRoot: tree.hostRoot, version: tree.version });
    for (const value of [
      { name: 'unrelated-desktop', version: tree.version },
      { name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.2' },
    ]) {
      tree.write(join(tree.input, 'package.json'), value);
      assert.throws(() => resolveHost(tree.input), { code: 'ERR_ASSERTION' });
    }
    tree.write(join(tree.input, 'package.json'), { name: '@deepseek-ai/dsh-desktop', version: tree.version });
    tree.write(join(tree.runtime, 'package.json'), { name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1-rc.2' });
    assert.throws(() => resolveHost(tree.input), { code: 'ERR_ASSERTION' });
  }
});

test('Host contract resolvers accept the shipped minimum Desktop runtime name and verify release metadata', () => {
  for (const script of ['verify-search-execution-host', 'verify-github-read-host']) {
    const resolveHost = hostContractResolver(script);
    for (const runtimeName of ['@deepseek-ai/dsh-desktop-runtime', '@deepseek-ai/dsh']) {
      const tree = hostContractTree({ desktop: true, version: '0.2.1-rc.2', runtimeName });
      assert.deepEqual(resolveHost(tree.input), { hostRoot: tree.hostRoot, version: tree.version });
      for (const release of [{}, { release: {} }, { release: { version: '0.2.2-rc.3' } }]) {
        tree.write(join(tree.runtime, 'desktop-runtime.json'), release);
        assert.throws(() => resolveHost(tree.input), { code: 'ERR_ASSERTION' });
      }
    }
  }
});

test('Host contract resolvers reject mismatched CLI and tool package identities before imports', () => {
  for (const script of ['verify-search-execution-host', 'verify-github-read-host']) {
    const resolveHost = hostContractResolver(script);
    for (const name of ['dsh', 'dsh-tools', 'dsh-web', 'dsh-tool-web']) {
      for (const mismatch of ['name', 'version']) {
        const tree = hostContractTree();
        tree.write(join(tree.hostRoot, name, 'package.json'), {
          name: mismatch === 'name' ? '@untrusted/' + name : '@deepseek-ai/' + name,
          version: mismatch === 'version' ? name === 'dsh' ? 'not-a-version' : '0.2.1-rc.2' : tree.version,
        });
        assert.throws(() => resolveHost(tree.input), { code: 'ERR_ASSERTION' });
      }
    }
  }
});

const cliUpgradeArguments = () => [
  join(sandbox, 'old.tgz'), join(sandbox, 'new.tgz'), '--native-cli-install',
  '--linux-cli', join(sandbox, 'host/cli.mjs'), '--linux-node', join(sandbox, 'node'),
  '--runtime-root', join(sandbox, 'host'), '--runtime-receipt', join(sandbox, 'receipt.json'),
  '--runtime-receipt-sha256', 'a'.repeat(64), '--host-version', '0.2.1-rc.2',
  '--run-root', join(sandbox, 'persistent-run'), '--retained-cache', join(sandbox, 'private-grok'),
  '--pnpm-entry', join(sandbox, 'pnpm.mjs'), '--pnpm-store', join(sandbox, 'store'),
  '--pnpm-cache', join(sandbox, 'pnpm-cache'),
];

test('CLI upgrade requires explicit native install, pinned receipts and all pair inputs', () => {
  const parsed = cliUpgradeVerifier.parseCliUpgradeArguments(cliUpgradeArguments());
  assert.equal(parsed.nativeCliInstall, true);
  assert.equal(parsed.version, '0.2.1-rc.2');
  assert.equal(parsed.oldPackage, join(sandbox, 'old.tgz'));
  assert.throws(() => cliUpgradeVerifier.parseCliUpgradeArguments(
    cliUpgradeArguments().filter(value => value !== '--native-cli-install')), /explicit/);
  assert.throws(() => cliUpgradeVerifier.parseCliUpgradeArguments([...cliUpgradeArguments(), '--legacy-peer-deps']), /Unknown/);
  assert.throws(() => cliUpgradeVerifier.parseCliUpgradeArguments([...cliUpgradeArguments(), '--linux-node', join(sandbox, 'other')]), /Duplicate/);
  assert.throws(() => cliUpgradeVerifier.parseCliUpgradeArguments([...cliUpgradeArguments(), '--to-host-version', '0.2.2-rc.3']), /all target/);
  const unsafe = cliUpgradeArguments();
  unsafe[unsafe.indexOf('--runtime-receipt-sha256') + 1] = 'not-a-fingerprint';
  assert.throws(() => cliUpgradeVerifier.parseCliUpgradeArguments(unsafe), /SHA-256/);
});

test('CLI upgrade uses semver admission without relabelling or escaping the historical package', () => {
  const old = { name: 'dsh-grok-search', version: '0.3.0', engines: {
    dsh: ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2'].join(' || '),
  } };
  const next = { name: 'dsh-grok-search', version: '0.4.0', engines: { dsh: '>=0.2.1-rc.2' } };
  for (const version of old.engines.dsh.split(' || ')) {
    assert.deepEqual(cliUpgradeVerifier.cliUpgradeStages(old, next, [{ version }]).map(row => row.packageIndex), [0, 1, 0]);
  }
  const pair = cliUpgradeVerifier.cliUpgradeStages(old, next, [{ version: '0.2.2-rc.2' }, { version: '0.2.2-rc.3' }]);
  assert.deepEqual(pair.map(row => [row.packageIndex, row.runtimeIndex, row.rejected === true]), [[0, 0, false], [0, 1, true], [1, 1, false]]);
  assert.throws(() => cliUpgradeVerifier.cliUpgradeStages(old, next, [{ version: '0.2.2-rc.3' }]), /normally admit/);
  assert.throws(() => cliUpgradeVerifier.cliUpgradeStages(old, next, [{ version: '0.2.2-rc.2' }, { version: '0.2.2-rc.1' }]), /forward/);
  assert.throws(() => cliUpgradeVerifier.cliUpgradeStages({ ...old, engines: { dsh: '*' } }, next,
    [{ version: '0.2.2-rc.2' }, { version: '0.2.2-rc.3' }]), /admission boundary/);
});

test('CLI upgrade native add pins candidate profile, offline caches and ordinary strict peer flags', () => {
  const args = cliUpgradeVerifier.cliUpgradeInstallArguments({ cli: '/verified/cli.mjs' }, '/frozen/package.tgz',
    { pnpmStore: '/private/store', pnpmCache: '/private/cache' });
  assert.deepEqual(args, ['/verified/cli.mjs', 'plugin', '--profile', 'candidate', 'add', '/frozen/package.tgz',
    '--offline', '--store-dir', '/private/store', '--cache-dir', '/private/cache', '--ignore-scripts',
    '--config.auto-install-peers=true', '--config.strict-peer-dependencies=true', '--registry', 'https://registry.npmjs.org']);
  assert.ok(args.every(value => !/legacy-peer|force|override|ignore.*peer/i.test(value)));
});

test('CLI upgrade explicitly bounded online installation keeps strict peers and the fixed registry without silent offline fallback', () => {
  const args = cliUpgradeVerifier.cliUpgradeInstallArguments({ cli: '/verified/cli.mjs' }, '/frozen/package.tgz',
    { pnpmStore: '/private/store', pnpmCache: '/private/cache', onlineNativeInstall: true });
  assert.ok(!args.includes('--offline'));
  assert.ok(args.includes('--config.fetch-retries=0'));
  assert.ok(args.includes('--config.fetch-timeout=60000'));
  assert.ok(args.includes('--config.auto-install-peers=true'));
  assert.ok(args.includes('--config.strict-peer-dependencies=true'));
  assert.deepEqual(args.slice(-2), ['--registry', 'https://registry.npmjs.org']);
  assert.ok(args.every(value => !/legacy-peer|force|override|ignore.*peer/i.test(value)));
});

test('CLI upgrade old package baseline preserves official host peer defaults without weakening the new package install', () => {
  const settings = { pnpmStore: '/private/store', pnpmCache: '/private/cache', onlineNativeInstall: true };
  const old = cliUpgradeVerifier.cliUpgradeInstallArguments({ cli: '/verified/cli.mjs' }, '/frozen/old.tgz',
    { ...settings, pluginVersion: '0.3.0' });
  assert.ok(!old.some(value => value.startsWith('--config.auto-install-peers')
    || value.startsWith('--config.strict-peer-dependencies')));
  assert.ok(!old.some(value => /legacy-peer|force|ignore.*peer|allowedVersions|ignoreMissing/.test(value)));
  const base = { npm_config_auto_install_peers: 'true', npm_config_strict_peer_dependencies: 'true',
    npm_config_legacy_peer_deps: 'false', npm_config_force: 'false' };
  const oldEnv = cliUpgradeVerifier.cliUpgradeInstallEnvironment(base, '0.3.0');
  assert.equal(Object.hasOwn(oldEnv, 'npm_config_auto_install_peers'), false);
  assert.equal(Object.hasOwn(oldEnv, 'npm_config_strict_peer_dependencies'), false);
  assert.deepEqual(cliUpgradeVerifier.cliUpgradeInstallEnvironment(base, '0.4.0'), base);
  assert.deepEqual(base.npm_config_auto_install_peers, 'true');
  const next = cliUpgradeVerifier.cliUpgradeInstallArguments({ cli: '/verified/cli.mjs' }, '/frozen/new.tgz', settings);
  assert.ok(next.includes('--config.auto-install-peers=true'));
  assert.ok(next.includes('--config.strict-peer-dependencies=true'));
});

test('CLI upgrade official-default lifecycle mode does not claim the separate strict fresh-install gate', () => {
  const settings = { pnpmStore: '/private/store', pnpmCache: '/private/cache',
    onlineNativeInstall: true, hostDefaultPeerPolicy: true };
  const next = cliUpgradeVerifier.cliUpgradeInstallArguments({ cli: '/verified/cli.mjs' }, '/frozen/new.tgz', settings);
  assert.ok(!next.some(value => value.includes('auto-install-peers') || value.includes('strict-peer-dependencies')));
  assert.ok(!next.some(value => /legacy-peer|force|ignore.*peer/.test(value)));
  const base = { npm_config_auto_install_peers: 'true', npm_config_strict_peer_dependencies: 'true',
    npm_config_legacy_peer_deps: 'false', npm_config_force: 'false' };
  const defaults = cliUpgradeVerifier.cliUpgradeInstallEnvironment(base, '0.4.0', settings);
  assert.equal(Object.hasOwn(defaults, 'npm_config_auto_install_peers'), false);
  assert.equal(Object.hasOwn(defaults, 'npm_config_strict_peer_dependencies'), false);
  assert.equal(defaults.npm_config_force, 'false');
  assert.deepEqual(cliUpgradeVerifier.cliUpgradeInstallEnvironment(base, '0.4.0'), base);
});

test('CLI upgrade cut is the actual completed canonical Session event, not a guessed maximum', () => {
  const state = { instanceId: 'host-seed', sessionEvents: [
    { sessionId: 'old-id', seq: 41, type: 'assistant/message', data: {} },
    { sessionId: 'old-id', seq: 42, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { sessionId: 'unrelated-id', seq: 900, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ] };
  assert.deepEqual(cliUpgradeVerifier.canonicalUpgradeCut(state, 'old-id'), {
    sessionId: 'old-id', seq: 42, hostInstanceId: 'host-seed', eventType: 'turn/end', reason: 'completed',
  });
  for (const patch of [{ instanceId: null }, { sessionEvents: [] }, { sessionEvents: [
    { sessionId: 'old-id', seq: 42.5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ] }]) assert.throws(() => cliUpgradeVerifier.canonicalUpgradeCut({ ...state, ...patch }, 'old-id'));
});

function cliUpgradeLifecycleFixture({ rejected = false, failedExit = false } = {}) {
  const requests = [], records = [{ type: 'event', event: { seq: 0, type: 'turn/end', data: { reason: { kind: 'completed' } } } }];
  let generation = 0, prepared = null;
  const state = () => ({ instanceId: 'cli-host-' + generation, completed: 1,
    calls: { original: 0 }, sessionEvents: [{ sessionId: 'old-session', seq: 0,
      type: 'turn/end', data: { reason: { kind: 'completed' } } }] });
  const reader = createRetainedSessionReader();
  const plan = rejected ? [
    { id: 'old-seed', packageIndex: 0, runtimeIndex: 0 },
    { id: 'old-package-rejected', packageIndex: 0, runtimeIndex: 1, rejected: true },
    { id: 'new-forward', packageIndex: 1, runtimeIndex: 1 },
  ] : [
    { id: 'old-seed', packageIndex: 0, runtimeIndex: 0 },
    { id: 'new-upgraded', packageIndex: 1, runtimeIndex: 0 },
    { id: 'old-rollback', packageIndex: 0, runtimeIndex: 0 },
  ];
  const operations = {
    async install(stage) { requests.push({ type: 'install', stage: stage.id }); },
    async start(stage) {
      generation++; requests.push({ type: 'start', stage: stage.id, generation });
      prepared = { request: async () => state(), async rpc(method, request) {
        assert.equal(method, 'session/page');
        requests.push({ type: 'page', generation, sessionId: request.address.sessionId, throughSeq: request.throughSeq });
        return { ...(generation === 1 ? {} : { cursor: request.throughSeq }),
          records: structuredClone(records), hasMore: false };
      } };
      return prepared;
    },
    reader: async () => reader,
    verifyRequired: async () => ({ required: true }),
    verifyRejected: async () => { requests.push({ type: 'rejected', generation }); return { searchIssued: false }; },
    async turn(host, mode) {
      host.sessionId ??= 'old-session'; requests.push({ type: 'prompt', generation, mode, sessionId: host.sessionId });
      return { sessionId: host.sessionId };
    },
    capture: (host, reader_) => cliUpgradeVerifier.captureCliUpgradeSession(host, reader_,
      { manifest: { version: '0.3.0' }, receipt: { sha256: 'a'.repeat(64) } }, '0.2.1-rc.2'),
    preserve: async () => {},
    async close() {
      requests.push({ type: 'exit', generation });
      return { instanceId: 'cli-host-' + generation, exitCode: failedExit && generation === 1 ? 1 : 0,
        signal: null, forced: false, closeError: null, originalSearchCalls: 0 };
    },
    record: async () => {},
  };
  return { plan, operations, requests, reader, host: () => prepared };
}

test('CLI native upgrade and rollback close before install, cold-read before prompt and reuse the exact old ID', async () => {
  const fixture = cliUpgradeLifecycleFixture();
  const result = await cliUpgradeVerifier.executeCliUpgradeStages(fixture.plan, fixture.operations);
  assert.equal(result.stages.length, 3);
  assert.equal(result.retainedSession.sessionId, 'old-session');
  assert.equal(result.retainedSession.historyRead.hostReturnedCursor, false);
  assert.equal(result.retainedSession.historyRead.cursorSource, 'validated-dense-record-boundary');
  assert.equal(result.stages[1].retainedSession.coldRead.historyRead.hostReturnedCursor, true);
  assert.equal(result.stages[1].retainedSession.historyAfterTurns.cursorSource, 'host-page-cursor');
  for (const generation of [2, 3]) {
    const events = fixture.requests.filter(row => row.generation === generation);
    assert.equal(events[1].type, 'page', 'The cold host must read before any prompt.');
    assert.ok(events.filter(row => row.type === 'prompt').every(row => row.sessionId === 'old-session'));
    assert.ok(events.filter(row => row.type === 'page').every(row => row.throughSeq === 0));
  }
  const kinds = fixture.requests.map(row => row.type);
  const secondInstall = fixture.requests.findIndex(row => row.type === 'install' && row.stage === 'new-upgraded');
  assert.equal(kinds[secondInstall - 1], 'exit');
});

test('CLI forward pair retains history at the rejected old-package boundary without issuing a search', async () => {
  const fixture = cliUpgradeLifecycleFixture({ rejected: true });
  const result = await cliUpgradeVerifier.executeCliUpgradeStages(fixture.plan, fixture.operations);
  assert.equal(result.stages[1].searchIssued, false);
  assert.equal(fixture.requests.filter(row => row.generation === 2 && row.type === 'prompt').length, 0);
  assert.deepEqual(fixture.requests.filter(row => row.type === 'install').map(row => row.stage), ['old-seed', 'new-forward']);
  assert.equal(result.stages[2].retainedSession.coldRead.historyMatched, true);
});

test('CLI upgrade rejects abnormal prior exit before another package can be installed', async () => {
  const fixture = cliUpgradeLifecycleFixture({ failedExit: true });
  await assert.rejects(cliUpgradeVerifier.executeCliUpgradeStages(fixture.plan, fixture.operations), /abnormal/);
  assert.equal(fixture.requests.filter(row => row.type === 'install').length, 1);
});

test('CLI cold history cannot hide corruption, a preactivated Session or the same lifetime', async () => {
  const retained = { sessionId: 'old-session', cursor: 3, records: [{ seq: 3 }] };
  const exit = { instanceId: 'before', exitCode: 0, signal: null, forced: false, closeError: null };
  const host = { request: async () => ({ instanceId: 'after' }), rpc: async () => assert.fail('The injected reader owns this test.') };
  const reader = { readPage: async () => ({ cursor: 3, records: [{ seq: 3, changed: true }], hasMore: false }) };
  await assert.rejects(cliUpgradeVerifier.restoreCliUpgradeSession(host, reader, retained, exit), /retain the old Session history/);
  assert.equal(host.sessionId, undefined);
  host.sessionId = 'replacement';
  await assert.rejects(cliUpgradeVerifier.restoreCliUpgradeSession(host, reader, retained, exit), /before activating/);
  delete host.sessionId;
  host.request = async () => ({ instanceId: 'before' });
  await assert.rejects(cliUpgradeVerifier.restoreCliUpgradeSession(host, reader, retained, exit), /new actual host lifetime/);
});

test('explicit CLI host config-once preserves defaults for Desktop and refuses silent recreation on cold start', () => {
  const source = readFileSync(new URL('../scripts/internal-candidate-host.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function candidateHostRuntimeRoot(');
  const end = source.indexOf('const [archive, directory, runtimeMode]', start);
  const api = new Function('assert', 'resolve', 'join', 'writeFileSync', 'lstatSync',
    source.slice(start, end).replaceAll('export function', 'function') + '\nreturn { candidateHostRuntimeRoot, writeCandidateConfiguration };')(
    assert, resolve, join, writeFileSync, (path, options) => {
      try { return { ...options, isFile: () => true, isSymbolicLink: () => false, existing: readFileSync(path) }; }
      catch (error) { if (options?.throwIfNoEntry === false && error.code === 'ENOENT') return undefined; throw error; }
    });
  assert.equal(api.candidateHostRuntimeRoot('/archive/app.asar'), join('/archive/app.asar', 'dsh'));
  assert.equal(api.candidateHostRuntimeRoot('/verified/cli-root', true), resolve('/verified/cli-root'));
  const path = join(sandbox, 'config-once.json');
  api.writeCandidateConfiguration(path, 'seed', true, true);
  api.writeCandidateConfiguration(path, 'unexpected new defaults', true, false);
  assert.equal(readFileSync(path, 'utf8'), 'seed');
  assert.throws(() => api.writeCandidateConfiguration(path + '-missing', 'defaults', true, false), /cannot recreate/);
  api.writeCandidateConfiguration(path, 'desktop overwrite', false);
  assert.equal(readFileSync(path, 'utf8'), 'desktop overwrite');
});

const cliUpgradePeers = ['cordis', 'dsh', 'dsh-app-boot', 'dsh-typert-protocol', 'dsh-web', 'schemastery']
  .map(name => '@deepseek-ai/' + name);

function cliUpgradePeerFixture() {
  const root = mkdtempSync(join(sandbox, 'cli-peer-')), profile = join(root, 'profile'), runtimeRoot = join(root, 'verified-cli');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }));
  writeFileSync(join(profile, '.npmrc'), 'auto-install-peers=true\nstrict-peer-dependencies=true\nlegacy-peer-deps=false\nforce=false\n');
  const hostPeers = cliUpgradePeers.map(name => {
    const path = join(runtimeRoot, 'node_modules', name), version = name.endsWith('/cordis') ? '4.0.5'
      : name.endsWith('/schemastery') ? '3.18.5' : '0.2.1-rc.2';
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version }));
    return { name, path, realPath: realpathSync(path), version,
      manifestSha256: sha256(readFileSync(join(path, 'package.json'))) };
  });
  const product = join(profile, 'node_modules/dsh-grok-search');
  mkdirSync(product, { recursive: true });
  const manifest = { name: 'dsh-grok-search', version: '0.4.0' };
  writeFileSync(join(product, 'package.json'), JSON.stringify(manifest));
  const package_ = { manifest, receipt: { sourceHashes: [{ file: 'package.json',
    sha256: sha256(readFileSync(join(product, 'package.json'))) }] } };
  return { profile, runtimeRoot, hostPeers, package_ };
}

test('CLI upgrade legitimate root links provide verified host peers without local manifest overrides', () => {
  const fixture = cliUpgradePeerFixture();
  const links = cliUpgradeVerifier.bindCliUpgradeHostPeers(fixture.profile, fixture);
  assert.equal(links.length, 6);
  const manifest = JSON.parse(readFileSync(join(fixture.profile, 'package.json'), 'utf8'));
  for (const peer of links) {
    assert.equal(manifest.dependencies[peer.name], 'link:' + relative(fixture.profile, peer.realPath).split('\\').join('/'));
    assert.equal(realpathSync(peer.rootPath), peer.realPath);
    assert.equal(peer.provision, 'verified-host-root-link');
  }
  const audit = cliUpgradeVerifier.inspectCliUpgradeInstall(fixture.profile, fixture.runtimeRoot, fixture.package_);
  assert.equal(audit.secondHostInstalled, false);
  assert.equal(audit.hostPeerProvisioning, 'verified-host-root-links');
  assert.equal(audit.autoInstallPeers, true);
});

test('CLI upgrade peer audit rejects same-version private root, nested and ignored host copies', () => {
  for (const location of ['root', 'nested', 'ignored']) {
    const fixture = cliUpgradePeerFixture();
    if (location !== 'root') cliUpgradeVerifier.bindCliUpgradeHostPeers(fixture.profile, fixture);
    const peer = fixture.hostPeers[0], path = location === 'root'
      ? join(fixture.profile, 'node_modules', peer.name)
      : location === 'nested' ? join(fixture.profile, 'node_modules/dependency/node_modules', peer.name)
        : join(fixture.profile, 'node_modules/.ignored', peer.name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), readFileSync(join(peer.path, 'package.json')));
    assert.throws(() => cliUpgradeVerifier.inspectCliUpgradeInstall(fixture.profile, fixture.runtimeRoot, fixture.package_),
      /private host peer copy/);
    if (location === 'root') assert.throws(() => cliUpgradeVerifier.bindCliUpgradeHostPeers(fixture.profile, fixture),
      /Never repair a private root/);
  }
});

test('CLI upgrade fixture host declarations remain explicit links rather than an independently installed host graph', () => {
  const fixture = cliUpgradePeerFixture();
  const old = cliUpgradeVerifier.bindCliUpgradeHostPeers(fixture.profile, fixture);
  const next = cliUpgradeVerifier.bindCliUpgradeHostPeers(fixture.profile, fixture, old);
  const manifest = JSON.parse(readFileSync(join(fixture.profile, 'package.json')));
  assert.ok(next.every(row => row.manifestSpecifier.startsWith('link:') && realpathSync(row.rootPath) === row.realPath));
  assert.ok(cliUpgradePeers.every(name => manifest.dependencies[name].startsWith('link:')));
  const audit = cliUpgradeVerifier.inspectCliUpgradeInstall(fixture.profile, fixture.runtimeRoot, fixture.package_);
  assert.equal(audit.strictPeerDependencies, true);
  assert.equal(audit.autoInstallPeers, true);
  assert.equal(audit.secondHostInstalled, false);
});

test('CLI upgrade peer links rebind only a recorded host on a cold forward transition', () => {
  const fixture = cliUpgradePeerFixture(), next = cliUpgradePeerFixture();
  const oldBindings = cliUpgradeVerifier.bindCliUpgradeHostPeers(fixture.profile, fixture);
  const updated = cliUpgradeVerifier.bindCliUpgradeHostPeers(fixture.profile, next, oldBindings);
  assert.ok(updated.every(peer => peer.rebound));
  assert.ok(updated.every(peer => realpathSync(peer.rootPath) === peer.realPath));
  assert.throws(() => cliUpgradeVerifier.bindCliUpgradeHostPeers(fixture.profile, fixture), /previously verified host/);
});

test('CLI upgrade persistent environment drops inherited secrets and isolates each Node pnpm wrapper', () => {
  const root = mkdtempSync(join(sandbox, 'cli-private-env-'));
  const first = cliUpgradeVerifier.cliUpgradeEnvironment(root, '/verified/node24/bin/node', '/verified/pnpm.cjs');
  const second = cliUpgradeVerifier.cliUpgradeEnvironment(root, '/verified/node25/bin/node', '/verified/pnpm.cjs');
  const firstBin = join(root, 'bin', createHash('sha256').update('/verified/node24/bin/node').digest('hex').slice(0, 16));
  const secondBin = join(root, 'bin', createHash('sha256').update('/verified/node25/bin/node').digest('hex').slice(0, 16));
  assert.notEqual(firstBin, secondBin);
  assert.match(readFileSync(join(firstBin, 'pnpm'), 'utf8'), /node24/);
  assert.match(readFileSync(join(secondBin, 'pnpm'), 'utf8'), /node25/);
  assert.equal(first.DSH_HOME, second.DSH_HOME);
  assert.equal(first.npm_config_auto_install_peers, 'true');
  assert.equal(first.npm_config_strict_peer_dependencies, 'true');
  for (const key of ['GROK_API_KEY', 'GITHUB_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'NODE_PATH', 'NPM_TOKEN']) {
    assert.equal(Object.hasOwn(first, key), false);
  }
});

test('CLI upgrade pnpm wrapper preserves literal shell metacharacters in verified paths', async t => {
  const shell = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
      .map(root => join(root, 'Git/bin/bash.exe')).find(existsSync)
    : '/bin/sh';
  if (!shell || !existsSync(shell)) return t.skip('A local POSIX shell is required for this argument-only test.');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(sandbox, 'cli-shell-arguments-'));
  const node = '/verified/$DSH_WRAPPER_SEGMENT/$(printf expanded)/node';
  const pnpm = '/verified/single\' and "double"/`printf substituted`/pnpm.cjs';
  cliUpgradeVerifier.cliUpgradeEnvironment(root, node, pnpm);
  const bin = join(root, 'bin', createHash('sha256').update(node).digest('hex').slice(0, 16));
  const wrappers = [readFileSync(join(bin, 'pnpm'), 'utf8')];
  const source = readFileSync(new URL('../scripts/b3-cli-web.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('    const pnpmWrapper =');
  const end = source.indexOf('    chmodSync(pnpmWrapper', start);
  assert.ok(start > 0 && end > start);
  new Function('join', 'pnpmBinDir', 'writeFileSync', 'process', 'options', source.slice(start, end))(
    join, bin, (_path, value) => wrappers.push(value), { execPath: node }, { pnpmEntry: pnpm });
  for (const wrapper of wrappers) {
    assert.match(wrapper, /^exec /m);
    const argumentPrinter = wrapper.replace(/^exec /m, "printf '%s\\n' ");
    const result = spawnSync(shell, [...(process.platform === 'win32' ? ['--posix'] : []), '-c', argumentPrinter,
      'pnpm-wrapper', '--flag', 'argument with spaces'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536,
      env: { SystemRoot: process.env.SystemRoot, PATH: dirname(shell), DSH_WRAPPER_SEGMENT: 'expanded' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/),
      [node, pnpm, '--flag', 'argument with spaces']);
  }
});

test('CLI upgrade source identity captures actual transitive imports and explicit child fixture without writing a build', () => {
  const root = mkdtempSync(join(sandbox, 'cli-source-closure-'));
  writeFileSync(join(root, 'entry.mjs'), "import './middle.mjs';\n");
  writeFileSync(join(root, 'middle.mjs'), "export { value } from './leaf.mjs';\n");
  writeFileSync(join(root, 'leaf.mjs'), 'export const value = 1;\n');
  const before = cliUpgradeVerifier.cliUpgradeSourceClosure(root, ['entry.mjs']);
  assert.deepEqual(before.map(row => row.file), ['entry.mjs', 'leaf.mjs', 'middle.mjs']);
  assert.equal(existsSync(join(root, 'unused-in-memory-verifier-output')), false);
  writeFileSync(join(root, 'leaf.mjs'), 'export const value = 2;\n');
  const after = cliUpgradeVerifier.cliUpgradeSourceClosure(root, ['entry.mjs']);
  assert.notEqual(before.find(row => row.file === 'leaf.mjs').sha256, after.find(row => row.file === 'leaf.mjs').sha256);
  const actual = cliUpgradeVerifier.cliUpgradeSourceClosure();
  for (const file of ['scripts/internal-candidate-host.mjs', 'scripts/compatibility-smoke-host.mjs',
    'scripts/lib/candidate-runtime.mjs', 'scripts/lib/asar.mjs', 'scripts/lib/internal-candidate-utils.mjs',
    'scripts/lib/retained-session.mjs', 'src/core/private-preferences.mjs', 'src/core/owned-lock.mjs',
    'fixtures/internal-candidate/host-fixture.mjs']) assert.ok(actual.some(row => row.file === file), file);
});

test('CLI upgrade stage failure and close exception still write failure evidence and stop before another install', async () => {
  for (const failure of ['turn', 'close', 'preservation']) {
    const fixture = cliUpgradeLifecycleFixture(), recorded = [];
    fixture.operations.record = async (stage, record, error, exit) => recorded.push({ stage, record, error, exit });
    if (failure === 'turn') fixture.operations.turn = async () => { throw new Error('fixture turn failed'); };
    if (failure === 'close') fixture.operations.close = async () => { throw new Error('fixture close failed'); };
    if (failure === 'preservation') {
      const close = fixture.operations.close;
      fixture.operations.close = async () => ({ ...await close(), preservationError: 'fixture private state changed' });
    }
    await assert.rejects(cliUpgradeVerifier.executeCliUpgradeStages(fixture.plan, fixture.operations));
    assert.equal(recorded.length, 1);
    assert.equal(fixture.requests.filter(row => row.type === 'install').length, 1);
    if (failure === 'turn') assert.equal(recorded[0].error.message, 'fixture turn failed');
    if (failure === 'close') assert.equal(recorded[0].exit.closeError, 'fixture close failed');
    if (failure === 'preservation') assert.equal(recorded[0].exit.preservationError, 'fixture private state changed');
  }
});

test('CLI upgrade runtime binds outer receipt root to the inner CLI root and rejects mismatches before execution', async () => {
  const { npmIdentity } = await import('../scripts/lib/compatibility-evidence.mjs');
  const root = mkdtempSync(join(sandbox, 'cli-runtime-receipt-')), runtimeRoot = join(root, 'cli');
  const version = '0.2.1-rc.2', name = '@deepseek-ai/dsh', executable = join(runtimeRoot, 'node_modules', name, 'lib/bin.js');
  for (const peer of cliUpgradePeers) {
    const path = join(runtimeRoot, 'node_modules', peer);
    mkdirSync(join(path, 'lib'), { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: peer, version,
      ...(peer === name ? { bin: { dsh: 'lib/bin.js' } } : peer.endsWith('/schemastery')
        ? { main: 'lib/index.cjs', exports: { '.': { import: './lib/index.mjs', require: './lib/index.cjs' } } }
        : { main: 'lib/index.js' }) }));
    writeFileSync(join(path, peer === name ? 'lib/bin.js'
      : peer.endsWith('/schemastery') ? 'lib/index.mjs' : 'lib/index.js'), '// Never executed; synthetic receipt fixture.');
  }
  const bytes = Buffer.from('synthetic official metadata fixture, not an actual installed host');
  const metadata = Buffer.from(JSON.stringify({ name, versions: { [version]: { name, version, dist: {
    tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  } } } }));
  const manifestPath = join(runtimeRoot, 'node_modules', name, 'package.json'), node = join(root, 'node');
  writeFileSync(node, 'Not a real executable; preflight never launches it.');
  const receipt = { schemaVersion: 1, kind: 'verified-runtime-candidate',
    asset: verifyHostAsset(npmIdentity(metadata, { packageName: name, version, lane: 'linux-cli' }), bytes),
    files: Object.fromEntries([['executable', executable], ['cliManifest', manifestPath]].map(([role, path]) =>
      [role, { path: relative(root, path).split(sep).join('/'), sha256: sha256(readFileSync(path)) }])) };
  const receiptPath = join(root, 'runtime-receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const input = { cli: executable, node, version, runtimeRoot, receiptRoot: root, receiptPath,
    receiptSha256: sha256(readFileSync(receiptPath)) };
  const runtime = cliUpgradeVerifier.readCliUpgradeRuntime(input);
  assert.equal(runtime.runtimeRoot, runtimeRoot);
  assert.equal(runtime.receiptRoot, root);
  assert.equal(runtime.hostPeers.length, 6);
  assert.equal(runtime.receipt.asset.nodeRange, null);
  assert.throws(() => cliUpgradeVerifier.readCliUpgradeRuntime({ ...input, receiptRoot: runtimeRoot }));
  assert.throws(() => cliUpgradeVerifier.readCliUpgradeRuntime({ ...input, version: '0.2.2-rc.3' }));
  assert.throws(() => cliUpgradeVerifier.readCliUpgradeRuntime({ ...input, receiptSha256: '0'.repeat(64) }));
  assert.throws(() => cliUpgradeVerifier.readCliUpgradeRuntime({ ...input, cli: node }));
  writeFileSync(manifestPath, JSON.stringify({ name, version: '0.2.2-rc.3' }));
  assert.throws(() => cliUpgradeVerifier.readCliUpgradeRuntime(input));
});

test('CLI upgrade rejects positive or unknown original counts first observed at any stage close', async () => {
  for (const rejected of [false, true]) {
    for (const stageIndex of [0, 1, 2]) {
      for (const originalSearchCalls of [1, null, undefined, -1, 0.5]) {
        const fixture = cliUpgradeLifecycleFixture({ rejected }), close = fixture.operations.close, recorded = [];
        let closed = 0;
        fixture.operations.close = async () => ({ ...await close(),
          originalSearchCalls: closed++ === stageIndex ? originalSearchCalls : 0 });
        fixture.operations.record = async (stage, record, error, exit) => recorded.push({ stage, record, error, exit });
        await assert.rejects(cliUpgradeVerifier.executeCliUpgradeStages(fixture.plan, fixture.operations),
          /original search|counter/i);
        assert.equal(recorded.length, stageIndex + 1);
        assert.equal(recorded.at(-1).exit.originalSearchCalls, originalSearchCalls);
      }
    }
  }
});

test('CLI upgrade peer audit rejects private host identity under root and nested package aliases', () => {
  for (const location of ['root', 'nested', 'ignored', 'virtual-store']) {
    const fixture = cliUpgradePeerFixture();
    cliUpgradeVerifier.bindCliUpgradeHostPeers(fixture.profile, fixture);
    const base = location === 'root' ? join(fixture.profile, 'node_modules')
      : location === 'nested' ? join(fixture.profile, 'node_modules/dependency/node_modules')
        : location === 'ignored' ? join(fixture.profile, 'node_modules/.ignored')
          : join(fixture.profile, 'node_modules/.pnpm/host-alias@4.0.5/node_modules');
    const path = join(base, 'host-alias');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), readFileSync(join(fixture.hostPeers[0].path, 'package.json')));
    assert.throws(() => cliUpgradeVerifier.inspectCliUpgradeInstall(fixture.profile, fixture.runtimeRoot, fixture.package_),
      /host peer alias|private host peer copy/i);
  }
});

test('CLI upgrade closing evidence uses the actual close reply and never substitutes an earlier zero', async () => {
  for (const count of [0, 1, null, undefined, -1, 0.5]) {
    const calls = [];
    const evidence = await cliUpgradeVerifier.readCliUpgradeClosingSnapshot({
      async request(op) {
        calls.push(op);
        return { instanceId: 'actual-host', calls: { original: op === 'snapshot' ? 0 : count } };
      },
    });
    assert.deepEqual(calls, ['snapshot', 'close']);
    assert.equal(evidence.originalSearchCalls, count === 0 || count === 1 ? count : null);
    assert.equal(evidence.counterObservation, 'actual-host-close-reply-before-shutdown');
  }
  const exits = () => Array.from({ length: 3 }, () => ({ exitCode: 0, signal: null, forced: false,
    closeError: null, preservationError: null, originalSearchCalls: 0 }));
  assert.equal(cliUpgradeVerifier.cliUpgradeExitEvidence(exits()).passed, true);
  for (const count of [1, null, undefined, -1, 0.5]) {
    const rows = exits(); rows[2].originalSearchCalls = count;
    const result = cliUpgradeVerifier.cliUpgradeExitEvidence(rows);
    assert.equal(result.passed, false);
    assert.equal(result.officialSearchCalls, count === 1 ? 1 : null);
  }
  for (const patch of [{ exitCode: 1 }, { forced: true }, { signal: 'SIGTERM' },
    { closeError: 'failure' }, { preservationError: 'changed' }]) {
    const rows = exits(); Object.assign(rows[2], patch);
    assert.equal(cliUpgradeVerifier.cliUpgradeExitEvidence(rows).passed, false);
  }
  assert.equal(cliUpgradeVerifier.cliUpgradeExitEvidence(exits().slice(0, 2)).passed, false);
  assert.equal(cliUpgradeVerifier.cliUpgradeExitEvidence(exits(), [123]).passed, false);
});

test('CLI upgrade host peer identity hashes declared CLI boot and conditional ESM entries without executing them', () => {
  const root = mkdtempSync(join(sandbox, 'cli-entry-mapping-')), path = join(root, 'package');
  mkdirSync(join(path, 'lib'), { recursive: true });
  for (const name of ['bin.js', 'profile-boot.js', 'index.js', 'index.mjs', 'index.cjs']) {
    writeFileSync(join(path, 'lib', name), 'throw new Error("This file must never be executed");');
  }
  const cli = join(path, 'lib/bin.js'), selected = manifest => cliUpgradeVerifier.cliUpgradeHostPeerEntry(manifest, path, cli);
  assert.equal(selected({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }), cli);
  assert.equal(selected({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' },
    exports: { './profile-boot': { default: './lib/profile-boot.js' } } }), join(path, 'lib/profile-boot.js'));
  assert.equal(selected({ name: '@deepseek-ai/schemastery', main: './lib/index.cjs',
    exports: { '.': { import: './lib/index.mjs', require: './lib/index.cjs' } } }), join(path, 'lib/index.mjs'));
  assert.equal(selected({ name: '@deepseek-ai/cordis', exports: { '.': { node: { import: './lib/index.js' },
    default: './lib/index.cjs' } } }), join(path, 'lib/index.js'));
  assert.throws(() => selected({ name: '@deepseek-ai/cordis' }), /declare.*entry|never guess/);
  assert.throws(() => selected({ name: '@deepseek-ai/cordis', main: './lib/missing.js' }));
  assert.throws(() => selected({ name: '@deepseek-ai/cordis', main: '../outside.js' }), /escaped/);
  assert.throws(() => selected({ name: '@deepseek-ai/cordis', exports: { '.': { import: '../outside.js' } } }), /escaped/);
  assert.throws(() => selected({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/index.js' } }), /differs from the verified/);
});

test('CLI upgrade compatibility metadata is created by the real 0.4 state API without granting consent and pins exact bytes', async () => {
  const profileDir = mkdtempSync(join(sandbox, 'cli-real-state-'));
  const productDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const before = cliUpgradeVerifier.readCliUpgradeCompatibilityState(profileDir);
  assert.deepEqual(before, { present: false, sha256: null, size: 0 });
  const seeded = await cliUpgradeVerifier.seedCliUpgradeCompatibilityState({
    profileDir, hostVersion: '0.2.1-rc.2', productDir,
  });
  assert.equal(seeded.operation, 'shipped-createCompatibilityState.markNotified');
  assert.equal(seeded.before.revision, 'missing');
  assert.equal(seeded.after.notified, true);
  assert.equal(seeded.after.confirmed, false);
  assert.equal(seeded.consentGranted, false);
  const path = join(profileDir, 'grok-search/compatibility-state.json'), bytes = readFileSync(path);
  assert.equal(seeded.file.sha256, sha256(bytes));
  const repeated = await cliUpgradeVerifier.seedCliUpgradeCompatibilityState({
    profileDir, hostVersion: '0.2.1-rc.2', productDir,
  });
  assert.deepEqual(repeated.file, seeded.file);
  assert.deepEqual(readFileSync(path), bytes);
  const { createCompatibilityState } = await import('../src/core/compatibility-state.mjs');
  const nextHost = createCompatibilityState({ profileDir, hostVersion: '0.2.2-rc.3', pluginVersion: '0.4.0' });
  try {
    const state = nextHost.snapshot();
    assert.equal(state.revision, seeded.file.sha256);
    assert.equal(state.confirmed, false);
    assert.equal(state.notified, false);
    assert.deepEqual(cliUpgradeVerifier.readCliUpgradeCompatibilityState(profileDir), seeded.file);
    assert.deepEqual(readFileSync(path), bytes);
  } finally { nextHost.dispose(); }
});
