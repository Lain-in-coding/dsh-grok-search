import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';
import * as pack from '../scripts/pack-internal.mjs';
const { validatePackChannel } = pack;

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const manifest = JSON.parse(read('package.json'));
const matrix = JSON.parse(read('support-matrix.json'));

test('browser gate preserves diagnostic evidence but rejects a failed run', async () => {
  const execute = vm.runInNewContext(`(${read('test/ui-route-browser.js')})`);
  let evidence = null;
  const page = {
    on() {},
    async setViewportSize() {},
    async evaluate(_fn, value) {
      if (value?.scope) { evidence = value; return { ok: true, text: 'evidence recorded' }; }
      if (value !== undefined) throw new Error('synthetic-browser-failure');
      return { runId: 'synthetic-review', directory: '/isolated-fixture' };
    },
    async screenshot() {},
    locator: () => ({ waitFor: async () => { throw new Error('synthetic-browser-failure'); } }),
  };
  await assert.rejects(execute(page), /browser|浏览器/i);
  assert.ok(evidence.failed > 0);
  assert.ok(evidence.results.some(row => row.error?.includes('synthetic-browser-failure')));
});

test('完整离线门禁纳入全部单元与协议测试文件，不把遗漏套件当成全量通过', () => {
  const expanded = manifest.scripts['test:all'].replace(/npm (?:run ([\w:-]+)|(test))\b/g,
    (_command, name, fallback) => manifest.scripts[name || fallback] ?? '');
  const files = readdirSync(new URL('../test/', import.meta.url)).filter(file => file.endsWith('.test.mjs'));
  assert.deepEqual(files.filter(file => !expanded.includes(`test/${file}`)), []);
  assert.doesNotMatch(read('test/provider-mcp.test.mjs'), /runtimeRoot \? test : test\.skip/);
});

test('阶段三维护器与后台worker位于实际打包范围内，候选不遗漏降级工具', () => {
  assert.ok(manifest.files.includes('src/core/'));
  for (const file of ['src/core/storage-worker.mjs', 'src/core/storage-maintenance.mjs', 'src/core/owned-lock.mjs']) {
    assert.ok(read(file).length > 0);
  }
  assert.match(read('src/core/product-control.mjs'), /createStorageMaintenanceWorker/);
  assert.match(read('src/core/storage-worker.mjs'), /env: \{\}/);
  assert.match(read('src/core/storage-maintenance.mjs'), /recover-downgrade/);
});

test('正式编号、lockfile、支持矩阵与 MCP 客户端身份一致且不可误走预发布通道', () => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(validatePackChannel(manifest, matrix, { release: true }), 'release');
  assert.throws(() => validatePackChannel(manifest, matrix, { alpha: true }));
  assert.equal(manifest.version, '0.4.3');
  assert.deepEqual(manifest.publishConfig, { tag: 'latest', access: 'public' });
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  const clientVersion = read('src/core/mcp-search.mjs')
    .match(/new sdk\.Client\(\{ name: 'dsh-grok-search', version: '([^']+)' \}/)?.[1];
  assert.equal(clientVersion, manifest.version);
  assert.equal(manifest.scripts['pack:release'], 'node scripts/pack-internal.mjs --release');
});

test('release packaging refuses self-dependencies and preserves the intended CLI entry', () => {
  const lock = JSON.parse(read('package-lock.json'));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    assert.equal(manifest[field]?.[manifest.name], undefined);
    assert.equal(lock.packages[''][field]?.[manifest.name], undefined);
    for (const spec of ['0.4.0', 'file:artifacts/product.tgz']) {
      assert.throws(() => validatePackChannel({
        ...manifest, [field]: { ...manifest[field], [manifest.name]: spec },
      }, matrix, { release: true }), /SELF_DEPENDENCY_NOT_ALLOWED/);
    }
  }
  assert.equal(lock.packages[`node_modules/${manifest.name}`], undefined);
  assert.equal(manifest.bin['dsh-grok-search-compatibility'], './src/core/compatibility-cli.mjs');
  assert.ok(read('src/core/compatibility-cli.mjs').startsWith('#!/usr/bin/env node'));
});

test('开发通道拒绝latest、错误版本和混合通道，保留正式通道正向验证', () => {
  const alpha = { ...manifest, version: '0.3.0-alpha.1', publishConfig: { tag: 'next', access: 'public' } };
  const alphaMatrix = { ...matrix, packageVersion: alpha.version };
  assert.equal(validatePackChannel(alpha, alphaMatrix, { alpha: true }), 'alpha');
  assert.throws(() => validatePackChannel({ ...alpha, publishConfig: { tag: 'latest' } }, alphaMatrix, { alpha: true }));
  assert.throws(() => validatePackChannel(manifest, matrix, { alpha: true, release: true }));
  assert.throws(() => validatePackChannel({ ...manifest, version: '0.3.0' }, { ...matrix, packageVersion: '0.3.0' }, { alpha: true }));
  const release = { ...manifest, version: '0.2.1', publishConfig: { tag: 'latest', access: 'public' } };
  assert.equal(validatePackChannel(release, { ...matrix, packageVersion: release.version }, { release: true }), 'release');
});

test('0.4.3发布文档固定目标版本并保留历史实录与验证范围', () => {
  const readme = read('README.md');
  const changelog = read('CHANGELOG.md');
  assert.match(readme, /Version-0\.4\.3-/);
  assert.match(readme, /实际发布状态以/);
  assert.match(readme, /releases\/tag\/v0\.4\.3/);
  assert.match(readme, /历史操作实录：Windows Desktop 0\.2\.2-rc\.2 · 插件 0\.3\.0/);
  assert.match(readme, /原人工验收与宿主矩阵保留各自包的验证范围/);
  assert.doesNotMatch(readme, /运行文件与该人工验收包逐字节一致/);
  assert.match(readme, /尚未做 macOS 实机复验/);
  assert.match(readme, /npm run pack:release/);
  assert.doesNotMatch(readme, /npm run pack:alpha|0\.3\.0-alpha\.1/);
  assert.match(changelog, /## 0\.3\.0 - 2026-11-13/);
  assert.match(changelog, /^## 0\.4\.0$/m);
  assert.match(changelog, /^## 0\.4\.1 - 2026-11-19$/m);
  assert.match(changelog, /^## 0\.4\.2 - 2026-11-21$/m);
  assert.match(changelog, /^## 0\.4\.3 - 2026-11-24$/m);
  assert.doesNotMatch(changelog, /## 0\.3\.0-alpha/);
  assert.equal(matrix.packageVersion, manifest.version);
  assert.match(matrix.channel, /0\.4\.3/);
});

test('发布安装示例固定0.4.3但不预先声称registry已经发布', () => {
  const readme = read('README.md');
  const install = readme.split('### 方式一：在 DSH 中按名称安装')[1]?.split('\n### ')[0];
  const expected = `${manifest.name}@${manifest.version}`;
  assert.equal(install?.match(/```text\s+([^\r\n]+)\s+```/)?.[1]?.trim(), expected);
  assert.equal(readme.match(/^dsh plugin --profile web add (\S+)$/m)?.[1], expected);
  assert.match(readme, /确认目标版本可下载后/);
  assert.match(readme, /dsh-grok-search-0\.4\.3\.tgz/);
  assert.doesNotMatch(readme, /安装已发布 \*\*0\.4\.3\*\*/);
  assert.equal(manifest.bin['dsh-grok-search-compatibility'], './src/core/compatibility-cli.mjs');
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

test('pack receipts derive every file hash from the actual tarball and reject a changed checkout', () => {
  assert.equal(typeof pack.inspectPackedSources, 'function');
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-source-audit-'));
  const files = new Map([['package.json', Buffer.from(JSON.stringify({ name: 'dsh-grok-search', version: '0.4.0' }))],
    ['empty.md', Buffer.alloc(0)], ['entry.mjs', Buffer.from('export const value = 1;\n')]]);
  const blocks = [];
  for (const [path, bytes] of files) {
    writeFileSync(join(root, path), bytes);
    const header = Buffer.alloc(512);
    header.write('package/' + path); header.write('0000644\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48;
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const metadata = { name: 'dsh-grok-search', version: '0.4.0', size: archive.length,
    integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'),
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.length })) };
  const expected = [...files].map(([file, bytes]) => ({ file, sha256: hash(bytes) }));
  assert.deepEqual(pack.inspectPackedSources(archive, metadata, root), expected);
  writeFileSync(join(root, 'entry.mjs'), 'export const value = 2;\n');
  assert.throws(() => pack.inspectPackedSources(archive, metadata, root), /PACK_SOURCE_CHANGED/);
  writeFileSync(join(root, 'entry.mjs'), files.get('entry.mjs'));
  assert.throws(() => pack.inspectPackedSources(archive, { ...metadata, files: metadata.files.slice(1) }, root), /PACK_FILE_INVENTORY/);
  assert.throws(() => pack.inspectPackedSources(archive, { ...metadata, integrity: 'sha512-' + 'A'.repeat(88) }, root), /PACK_ARCHIVE_INTEGRITY/);
});

test('packing checks generated client and current development instructions keep normal peer resolution', () => {
  const script = read('scripts/pack-internal.mjs'), readme = read('README.md');
  assert.match(script, /checkClientArtifact/);
  assert.match(script, /inspectPackedSources/);
  assert.match(readme, /npm ci --ignore-scripts --legacy-peer-deps=false/);
  assert.doesNotMatch(readme, /npm ci --ignore-scripts --legacy-peer-deps(?:\s|$)/m);
  assert.doesNotMatch(readme, /见源码仓库的 `docs\/开发与验证\.md`/);
});

test('README recording refuses empty or unknown selections instead of reporting a zero-scenario success', () => {
  const source = read('scripts/readme-demos.mjs');
  const start = source.indexOf('const usage = '), end = source.indexOf('\nconst sleep = ', start);
  assert.ok(start > 0 && end > start);
  const parse = args => vm.runInNewContext(source.slice(start, end), {
    process: { argv: ['node', 'readme-demos.mjs', ...args] },
    existsSync: () => true, spawnSync: () => ({ status: 0 }),
  });
  assert.doesNotThrow(() => parse(['--chrome', 'synthetic-browser', '--only', 'first-use,order', '--formats', 'apng,mp4']));
  for (const args of [
    ['--only', ''], ['--only', 'typo'], ['--only', 'order,typo'], ['--formats', ','],
    ['--chrome', 'second-browser'], ['--unknown', 'value'],
  ]) assert.throws(() => parse(['--chrome', 'synthetic-browser', ...args]));
});
