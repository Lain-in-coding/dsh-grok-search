import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readElectronFuseWire, assertDevelopmentFuseCompatibility,
  resolveNewTemporaryRunRoot, inspectDesktopPreparation,
} from '../scripts/deferred-release-desktop-prepare.mjs';
import { captureDesktopSearch, captureDesktopSeam, waitForDesktopRecovery } from '../fixtures/deferred-release/desktop-fixture.mjs';

const fuseBinary = (wire = '101100011', version = 1, length = wire.length) => Buffer.concat([
  Buffer.from('fixture-prefix:dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
  Buffer.from([version, length]), Buffer.from(wire),
]);
const temporary = realpathSync(tmpdir());
const sandbox = mkdtempSync(join(temporary, 'dsh-deferred-desktop-checks-'));
const marker = join(sandbox, 'existing-marker.txt');
writeFileSync(marker, '既有成果保持', { flag: 'wx' });

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
