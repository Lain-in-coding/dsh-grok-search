import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CANDIDATE_VERSIONS } from '../scripts/lib/candidate-runtime.mjs';
import * as desktopPreparation from '../scripts/deferred-release-desktop-prepare.mjs';
import * as cliWeb from '../scripts/b3-cli-web.mjs';
import { ACCEPTANCE_VERSIONS, acceptanceTargets, targetKey, hostVersionAdmitted } from '../scripts/lib/compatibility-evidence.mjs';

const readJson = name => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
test('release metadata stays synchronized without an enumerated future host ceiling', () => {
  const manifest = readJson('package.json');
  const lock = readJson('package-lock.json');
  const matrix = readJson('support-matrix.json');
  assert.equal(manifest.version, matrix.packageVersion);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(matrix.packageVersion, manifest.version);
  assert.equal(manifest.engines.dsh, '>=0.2.1-rc.2');
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-web', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/schemastery']) {
    assert.equal(manifest.peerDependencies[name], '*');
    assert.equal(manifest.peerDependenciesMeta[name].optional, true);
  }
  assert.equal(manifest.dependencies.semver, '7.8.5');
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[''].peerDependenciesMeta, manifest.peerDependenciesMeta);
});

test('21 target records reference named baselines without claiming a repeated release-package matrix', () => {
  const matrix = readJson('support-matrix.json');
  const targets = matrix.targets.map(targetKey).sort();
  const expected = acceptanceTargets().map(targetKey).sort();
  assert.deepEqual(targets, expected);
  assert.equal(new Set(targets).size, expected.length);
  assert.deepEqual(matrix.acceptanceVersions, [...ACCEPTANCE_VERSIONS]);
  assert.ok(matrix.targets.every(row => ['reference-reviewed', 'source-reviewed'].includes(row.verificationLevel)));
  for (const row of matrix.targets) {
    const reference = matrix.verificationReferences[row.verificationReference];
    assert.ok(reference?.scope);
    if (row.verificationLevel === 'reference-reviewed') assert.match(reference.packageSha256, /^[a-f0-9]{64}$/);
    if (row.followupReference) assert.equal(matrix.verificationReferences[row.followupReference]?.userReportedPassed, true);
  }
  assert(matrix.unsupported.some(value => value.includes('Windows 与 macOS') && value.includes('CLI/Web')));
  assert.equal(matrix.evidencePolicy.authority, 'external-exact-tgz');
  assert.equal(matrix.evidencePolicy.samePackageRequired, true);
  assert.equal(matrix.evidencePolicy.postFreezePackageEditsChangePackageIdentity, true);
  assert.equal(matrix.evidencePolicy.documentationOnlyRepackRequiresRuntimeIdentityCheck, true);
});

test('historical rc.4 source review never turns into current-package host execution evidence', () => {
  const matrix = readJson('support-matrix.json');
  assert.equal(matrix.historical.packageVersion, '0.3.0');
  assert.notEqual(matrix.historical.packageVersion, matrix.packageVersion);
  for (const row of matrix.targets) {
    assert(Object.hasOwn(matrix.verificationLevels, row.verificationLevel));
  }
  const inferred = matrix.historical.targets.filter(row => row.dsh === '0.2.1-rc.4' && row.host === 'Desktop');
  assert.deepEqual(inferred.map(row => `${row.platform}/${row.host}/${row.dsh}`).sort(), [
    'darwin-arm64/Desktop/0.2.1-rc.4', 'win32-x64/Desktop/0.2.1-rc.4',
  ]);
  for (const row of inferred) assert.equal(row.verificationLevel, 'source-reviewed');
  assert.equal(matrix.targets.some(row => row.verificationLevel === 'host-tested'), false);
  assert.equal(matrix.historical.targets.length, 18);
  for (const row of inferred) {
    assert.match(row.verification, /源码/);
    assert.match(row.verification, /未.*实测/);
    assert.doesNotMatch(row.verification, /自动化测试通过/);
  }
});

test('runtime admission and immutable external evidence have distinct policies', () => {
  const matrix = readJson('support-matrix.json');
  assert.equal(matrix.admission.minimum, '0.2.1-rc.2');
  assert.equal(matrix.admission.upperBound, null);
  assert.equal(matrix.admission.includePrerelease, true);
  assert.equal(matrix.admission.automaticOfficialFallback, false);
  assert.equal(matrix.admission.capabilityChecksRequired, false);
  assert.equal(matrix.admission.runtimeInitializationRequired, true);
  assert.equal(matrix.evidencePolicy.embeddedResults, 'named-baseline-references');
  assert.equal(matrix.evidencePolicy.watcherDefault, 'released-npm-latest-exact-hash');
  for (const version of ['0.2.2-rc.3', '0.2.3-alpha.1', '9.0.0']) assert.equal(hostVersionAdmitted(version), true);
  assert.equal(hostVersionAdmitted('0.2.1-rc.1'), false);
});

test('release preparation preserves manual validation without enabling a recurring job', () => {
  const workflow = readFileSync(new URL('../.github/workflows/compatibility-watch.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+schedule:|^\s+-\s+cron:/m);
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
