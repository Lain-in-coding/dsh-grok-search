import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CANDIDATE_VERSIONS } from '../scripts/lib/candidate-runtime.mjs';
import * as desktopPreparation from '../scripts/deferred-release-desktop-prepare.mjs';
import * as cliWeb from '../scripts/b3-cli-web.mjs';

const readJson = name => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const versions = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2'];

test('0.2.2-rc.2 适配同步版本、宿主声明与锁文件，不放宽到未来版本', () => {
  const manifest = readJson('package.json');
  const lock = readJson('package-lock.json');
  const matrix = readJson('support-matrix.json');
  assert.equal(manifest.version, '0.3.0');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(matrix.packageVersion, manifest.version);
  assert.equal(manifest.engines.dsh, versions.join(' || '));
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-web', '@deepseek-ai/dsh-typert-protocol']) {
    assert.equal(manifest.peerDependencies[name], manifest.engines.dsh);
  }
  assert.deepEqual(manifest.dependencies, { '@modelcontextprotocol/client': '2.4.0', 'smol-toml': '1.9.1' });
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '~4.0.5 || ~4.1.0');
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '~3.18.5 || ~3.19.0');
});

test('支持矩阵覆盖旧四版和 0.2.2 两版的十八个组合，不扩张 Windows/macOS 独立 Web', () => {
  const matrix = readJson('support-matrix.json');
  const targets = matrix.targets.map(row => `${row.platform}/${row.host}/${row.dsh}`).sort();
  const expected = [
    ...versions.flatMap(version =>
      ['win32-x64', 'darwin-arm64'].map(platform => `${platform}/Desktop/${version}`)),
    ...versions.map(version => `linux-x64/CLI/Web/${version}`),
  ].sort();
  assert.deepEqual(targets, expected);
  assert.equal(new Set(targets).size, expected.length);
  assert(matrix.unsupported.some(value => value.includes('Windows 与 macOS') && value.includes('CLI/Web')));
  assert(matrix.notTested.some(value => value.includes('rc.4') && value.includes('Desktop')));
});

test('rc.4 Desktop 属于源码审查支持，不得冒充官方 Desktop 原包实测', () => {
  const matrix = readJson('support-matrix.json');
  assert.deepEqual(Object.keys(matrix.verificationLevels ?? {}).sort(), ['host-tested', 'source-reviewed']);
  for (const row of matrix.targets) {
    assert(Object.hasOwn(matrix.verificationLevels, row.verificationLevel));
  }
  const inferred = matrix.targets.filter(row => row.dsh === '0.2.1-rc.4' && row.host === 'Desktop');
  assert.deepEqual(inferred.map(row => `${row.platform}/${row.host}/${row.dsh}`).sort(), [
    'darwin-arm64/Desktop/0.2.1-rc.4', 'win32-x64/Desktop/0.2.1-rc.4',
  ]);
  for (const row of inferred) assert.equal(row.verificationLevel, 'source-reviewed');
  assert.equal(matrix.targets.filter(row => row.verificationLevel === 'host-tested' && row.dsh.startsWith('0.2.1-')).length, 10);
  assert.equal(matrix.targets.filter(row => row.verificationLevel === 'host-tested' && row.dsh === '0.2.2-rc.2').length, 3);
  assert.equal(matrix.targets.filter(row => row.verificationLevel === 'host-tested' && row.dsh === '0.2.2-rc.1').length, 3);
  const rc2Desktop = matrix.targets.filter(row => row.dsh === '0.2.2-rc.2' && row.host === 'Desktop');
  assert.deepEqual(rc2Desktop.filter(row => row.verificationLevel === 'host-tested').map(row => row.platform).sort(),
    ['darwin-arm64', 'win32-x64']);
  assert.deepEqual(rc2Desktop.filter(row => row.verificationLevel === 'source-reviewed'), []);
  const rc2Linux = matrix.targets.find(row => row.dsh === '0.2.2-rc.2' && row.host === 'CLI/Web');
  assert.equal(rc2Linux.verificationLevel, 'host-tested');
  assert.equal(matrix.notTested.some(value => /rc\.2.*Windows.*Linux/.test(value)), false);
  assert.equal(matrix.notTested.some(value => /rc\.2 macOS.*source-reviewed/.test(value)), false);
  for (const row of inferred) {
    assert.match(row.verification, /源码/);
    assert.match(row.verification, /未.*实测/);
    assert.doesNotMatch(row.verification, /自动化测试通过/);
  }
});

test('README 的验证边界不把全部支持组合写成自动化实测', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const matrix = readJson('support-matrix.json');
  const boundary = readme.split('<summary>还有哪些验证边界？</summary>')[1]?.split('</details>')[0];
  const support = readme.split('## 支持范围')[1]?.split('\n## ')[0];
  assert(boundary);
  assert(support);
  assert.match(boundary, /\[支持范围\]\(#支持范围\)/);
  assert.match(support, /rc\.4 Desktop/);
  assert.match(support, /源码审查/);
  assert.match(support, /未单独实测官方 rc\.4 桌面发行包/);
  assert.doesNotMatch(boundary + support, /支持表列出的组合已完成自动化验证/);
  assert.match(boundary, /DSH `0\.2\.2-rc\.2` 的 Windows x64 与 macOS arm64 Desktop/);
  assert.match(boundary, /GitHub 托管 Apple Silicon/);
  assert.equal(matrix.targets.find(row => row.dsh === '0.2.2-rc.2'
    && row.platform === 'darwin-arm64' && row.host === 'Desktop').verificationLevel, 'host-tested');
  const updateGuidance = readme.split('## 更新已有版本')[1]?.split('\n## ')[0];
  assert.match(updateGuidance, /先在兼容的旧宿主把插件更新至 `0\.3\.0`，再升级 DSH/);
  assert.match(updateGuidance, /不兼容的 `0\.2\.1` 回装/);
});

test('Desktop 候选工具接受 0.2.2-rc.2 但不自动接受 alpha 或未来 rc', () => {
  assert(CANDIDATE_VERSIONS.includes('0.2.2-rc.2'));
  assert(CANDIDATE_VERSIONS.includes('0.2.2-rc.1'));
  assert(CANDIDATE_VERSIONS.includes('0.2.1-rc.5'));
  assert(CANDIDATE_VERSIONS.includes('0.2.1-rc.2'));
  assert(CANDIDATE_VERSIONS.includes('0.2.1-rc.3'));
  assert(!CANDIDATE_VERSIONS.includes('0.2.2-alpha.2'));
  assert(!CANDIDATE_VERSIONS.includes('0.2.1-rc.6'));
  assert(!CANDIDATE_VERSIONS.includes('0.2.2-rc.3'));
});

test('隔离测试 bundle 使用被核验的真实宿主版本，不能因旧版硬编码被 rc.5 跳过', () => {
  assert.equal(typeof desktopPreparation.fixtureDshEngines, 'function');
  for (const version of CANDIDATE_VERSIONS) {
    assert.deepEqual(desktopPreparation.fixtureDshEngines(version), { dsh: version });
  }
  for (const version of ['', '0.2.1-rc.6', '0.2.2-rc.3', '0.2.2-alpha.2', '*']) {
    assert.throws(() => desktopPreparation.fixtureDshEngines(version));
  }
});

test('所有 CLI/Web 用例都检查设置 DOM，缺少浏览器参数应在启动前拒绝', () => {
  assert.equal(typeof cliWeb.parseCliWebArguments, 'function');
  const common = ['--dsh-cli', 'cli/bin.js', '--dsh-version', 'rc5', '--product-package', 'candidate.tgz',
    '--grok-linux-archive', 'grok.tar.gz', '--pnpm-entry', 'pnpm.mjs', '--pnpm-store', 'store', '--pnpm-cache', 'cache'];
  for (const value of ['smoke', 'stop', 'full']) {
    assert.throws(() => cliWeb.parseCliWebArguments([...common, '--case', value]), /--browser-executable is required/);
    const options = cliWeb.parseCliWebArguments([...common, '--case', value, '--browser-executable', '/test/chromium']);
    assert.equal(options.browserExecutable, '/test/chromium');
  }
});

test('新版 CLI/Web 在准备环境前拒绝 Node 22，允许隔离指定 Node 24.9 及以上', () => {
  for (const host of ['022-rc1', '022-rc2']) {
    for (const version of ['22.22.2', '23.11.0', '24.8.1', 'invalid']) {
      assert.equal(cliWeb.cliNodeVersionSupported(version, host), false, `${host}: ${version}`);
    }
    for (const version of ['24.9.0', 'v24.14.1', '25.0.0']) {
      assert.equal(cliWeb.cliNodeVersionSupported(version, host), true, `${host}: ${version}`);
    }
  }
  assert.equal(cliWeb.cliNodeVersionSupported('22.22.2', 'rc5'), true);
  for (const host of ['022-rc3', '022-alpha2', '*']) {
    assert.equal(cliWeb.cliNodeVersionSupported('24.14.1', host), false);
  }
});

test('CLI/Web 接受 rc.2 的隔离 Node 参数并拒绝未核验宿主', () => {
  const common = ['--dsh-cli', 'cli/bin.js', '--product-package', 'candidate.tgz',
    '--grok-linux-archive', 'grok.tar.gz', '--pnpm-entry', 'pnpm.mjs', '--pnpm-store', 'store', '--pnpm-cache', 'cache',
    '--browser-executable', '/test/chromium'];
  for (const host of ['022-rc1', '022-rc2']) {
    const args = [...common, '--dsh-version', host];
    assert.equal(cliWeb.parseCliWebArguments([...args, '--linux-node', '/tmp/node/bin/node']).linuxNode, '/tmp/node/bin/node');
    assert.throws(() => cliWeb.parseCliWebArguments([...args, '--linux-node', 'node']), /absolute Linux/);
  }
  for (const host of ['022-rc3', '022-alpha2', '*']) {
    assert.throws(() => cliWeb.parseCliWebArguments([...common, '--dsh-version', host]), /Unsupported --dsh-version/);
  }
});

test('CLI/Web 日志索引与实际扁平文件名一致，不能指向不存在的 logs 目录', () => {
  assert.deepEqual(cliWeb.CLI_WEB_LOG_ARTIFACTS, {
    webStderr: 'logs-dsh-web.stderr.log',
    webStdout: 'logs-dsh-web.stdout.log',
    browserStderr: 'logs-linux-browser.stderr.log',
    browserStdout: 'logs-linux-browser.stdout.log',
  });
});
