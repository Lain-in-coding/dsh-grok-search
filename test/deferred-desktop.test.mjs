import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readElectronFuseWire, assertDevelopmentFuseCompatibility,
  resolveNewTemporaryRunRoot, inspectDesktopPreparation,
} from '../scripts/deferred-release-desktop-prepare.mjs';
import { captureDesktopSearch, captureDesktopSeam, waitForDesktopRecovery } from '../fixtures/deferred-release/desktop-fixture.mjs';
import { requestDesktopShutdown } from '../scripts/lib/renderer-cdp.mjs';
import { desktopAcceptancePaths, desktopWorkspacePatch, prepareDesktopAcceptanceEnvironment } from '../scripts/lib/desktop-acceptance-environment.mjs';
import { commandResult } from '../scripts/lib/internal-candidate-utils.mjs';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readUpgradePackage, retainUpgradeCache, searchLogUpgradeStages } from '../scripts/verify-search-log-upgrade.mjs';
import * as upgradeVerifier from '../scripts/verify-search-log-upgrade.mjs';
import { finishNativeUpdate, nativeUpdateMetadata, nativeUpdateHostStages, validateNativeUpdateOutcome } from '../scripts/verify-native-update.mjs';

const fuseBinary = (wire = '101100011', version = 1, length = wire.length) => Buffer.concat([
  Buffer.from('fixture-prefix:dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
  Buffer.from([version, length]), Buffer.from(wire),
]);
const temporary = realpathSync(tmpdir());
const sandbox = mkdtempSync(join(temporary, 'dsh-deferred-desktop-checks-'));
const marker = join(sandbox, 'existing-marker.txt');
writeFileSync(marker, '既有成果保持', { flag: 'wx' });

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
