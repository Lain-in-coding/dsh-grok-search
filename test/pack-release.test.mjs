import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { validatePackChannel } from '../scripts/pack-internal.mjs';

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
  assert.equal(manifest.version, '0.3.0');
  assert.deepEqual(manifest.publishConfig, { tag: 'latest', access: 'public' });
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  const clientVersion = read('src/core/mcp-search.mjs')
    .match(/new sdk\.Client\(\{ name: 'dsh-grok-search', version: '([^']+)' \}/)?.[1];
  assert.equal(clientVersion, manifest.version);
  assert.equal(manifest.scripts['pack:release'], 'node scripts/pack-internal.mjs --release');
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

test('正式发布材料同步0.3.0入口与日期，不遗留候选公告或把旧包当当前版本', () => {
  const readme = read('README.md');
  const changelog = read('CHANGELOG.md');
  assert.match(readme, /Version-0\.3\.0-/);
  assert.match(readme, /安装 \*\*0\.3\.0\*\*/);
  assert.match(readme, /releases\/tag\/v0\.3\.0/);
  assert.doesNotMatch(readme, /待发布|尚未公开发布|当前公开版本为 \*\*0\.2\.1\*\*/);
  assert.match(readme, /npm run pack:release/);
  assert.doesNotMatch(readme, /npm run pack:alpha|0\.3\.0-alpha\.1/);
  assert.match(changelog, /## 0\.3\.0 - 2026-11-13/);
  assert.doesNotMatch(changelog, /## 0\.3\.0-alpha/);
  assert.match(matrix.channel, /0\.3\.0.*latest/);
  assert.doesNotMatch(matrix.channel, /未公开发布|仍为0\.2\.1/);
});

test('默认安装示例固定当前发布版本，避免预览新版却按裸名解析旧版', () => {
  const readme = read('README.md');
  const install = readme.split('### 方式一：在 DSH 中按名称安装')[1]?.split('\n### ')[0];
  const expected = `${manifest.name}@${manifest.version}`;
  assert.equal(install?.match(/```text\s+([^\r\n]+)\s+```/)?.[1]?.trim(), expected);
  assert.equal(readme.match(/^dsh plugin --profile web add (\S+)$/m)?.[1], expected);
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
