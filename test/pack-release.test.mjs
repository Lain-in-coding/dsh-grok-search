import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePackChannel } from '../scripts/pack-internal.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const manifest = JSON.parse(read('package.json'));
const matrix = JSON.parse(read('support-matrix.json'));

test('正式候选版本、lockfile、支持矩阵与 MCP 客户端身份一致', () => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(validatePackChannel(manifest, matrix, { release: true }), 'release');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  const clientVersion = read('src/core/mcp-search.mjs')
    .match(/new sdk\.Client\(\{ name: 'dsh-grok-search', version: '([^']+)' \}/)?.[1];
  assert.equal(clientVersion, manifest.version);
  assert.equal(manifest.scripts['pack:release'], 'node scripts/pack-internal.mjs --release');
});

test('正式候选拒绝 Beta、内部版本和不规范的版本号', () => {
  for (const version of ['0.1.0-beta.1', '0.0.0-internal.1', 'v0.1.0', '01.1.0', '0.1', '0.1.0+local']) {
    assert.throws(() => validatePackChannel({ ...manifest, version }, { ...matrix, packageVersion: version }, { release: true }));
  }
});

test('正式候选拒绝 private、错误包名、不同步的矩阵和错误发布标签', () => {
  for (const changed of [
    { private: true }, { name: 'another-plugin' },
    { publishConfig: { tag: 'next', access: 'public' } },
    { publishConfig: { tag: 'latest', access: 'restricted' } },
  ]) {
    assert.throws(() => validatePackChannel({ ...manifest, ...changed }, matrix, { release: true }));
  }
  assert.throws(() => validatePackChannel(manifest, { ...matrix, packageVersion: '0.1.0-beta.1' }, { release: true }));
});

test('通道必须显式选择，正式版不能被内部或 Beta 命令误打包', () => {
  assert.throws(() => validatePackChannel(manifest, matrix));
  assert.throws(() => validatePackChannel(manifest, matrix, { beta: true }));
  assert.throws(() => validatePackChannel(manifest, matrix, { beta: true, release: true }));
});

test('保留历史内部与 Beta 通道的身份约束，不改写旧候选', () => {
  for (const [version, options, channel, privateValue] of [
    ['0.0.0-internal.1', {}, 'internal', true],
    ['0.1.0-beta.1', { beta: true }, 'beta', false],
  ]) {
    assert.equal(validatePackChannel({ ...manifest, version, private: privateValue },
      { ...matrix, packageVersion: version }, options), channel);
  }
});
