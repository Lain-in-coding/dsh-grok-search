import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, freshRun, writeJson, commandResult, receipt, npmCli, sha256, redact } from './lib/internal-candidate-utils.mjs';
import { buildClient, checkClientArtifact } from './build-client.mjs';
import { inspectPackage } from './lib/compatibility-smoke.mjs';

export function inspectPackedSources(bytes, metadata, sourceRoot = project) {
  const archive = inspectPackage(bytes), hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(metadata.integrity, 'sha512-' + createHash('sha512').update(bytes).digest('base64'), 'PACK_ARCHIVE_INTEGRITY');
  assert.equal(metadata.size, bytes.length, 'PACK_ARCHIVE_INTEGRITY');
  assert.equal(archive.manifest.name, metadata.name, 'PACK_ARCHIVE_IDENTITY');
  assert.equal(archive.manifest.version, metadata.version, 'PACK_ARCHIVE_IDENTITY');
  const listed = metadata.files.map(row => row.path);
  assert.equal(new Set(listed).size, listed.length, 'PACK_FILE_INVENTORY');
  assert.deepEqual([...archive.files.keys()].sort(), [...listed].sort(), 'PACK_FILE_INVENTORY');
  return metadata.files.map(({ path, size }) => {
    const packed = archive.files.get(path), sourcePath = join(sourceRoot, path), before = lstatSync(sourcePath);
    assert.ok(before.isFile() && !before.isSymbolicLink(), 'PACK_SOURCE_UNSAFE');
    const current = readFileSync(sourcePath), after = lstatSync(sourcePath);
    assert.ok(after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
    'PACK_SOURCE_CHANGED');
    assert.equal(packed.length, size, 'PACK_FILE_INVENTORY');
    assert.ok(packed.equals(current), 'PACK_SOURCE_CHANGED: ' + path);
    return { file: path, sha256: hash(packed) };
  });
}

export function validatePackChannel(manifest, matrix, { alpha = false, beta = false, release = false } = {}) {
  if ([alpha, beta, release].filter(Boolean).length > 1) throw new Error('打包通道不能同时选择多个。');
  const channel = release ? 'release' : alpha ? 'alpha' : beta ? 'beta' : 'internal';
  const versionMatches = release
    ? /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(manifest.version)
    : alpha ? /^0\.3\.0-alpha\.[1-9]\d*$/.test(manifest.version)
      : manifest.version === (beta ? '0.1.0-beta.1' : '0.0.0-internal.1');
  if ((channel === 'internal' ? manifest.private !== true : manifest.private === true) || !versionMatches) {
    throw new Error('打包版本或 private 状态不符合通道要求。');
  }
  if (manifest.name !== 'dsh-grok-search' || matrix.packageVersion !== manifest.version) {
    throw new Error('包名或支持矩阵版本与候选不一致。');
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    if (Object.hasOwn(manifest[field] ?? {}, manifest.name)) {
      throw new Error('SELF_DEPENDENCY_NOT_ALLOWED');
    }
  }
  if (release && (manifest.publishConfig?.tag !== 'latest' || manifest.publishConfig?.access !== 'public')) {
    throw new Error('正式候选必须显式声明 latest 和 public；打包不构成发布授权。');
  }
  if (alpha && manifest.publishConfig?.tag !== 'next') throw new Error('开发候选不能使用 latest 标签；打包不构成发布授权。');
  return channel;
}

export async function packInternal(directory, options = {}) {
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  const matrix = JSON.parse(readFileSync(join(project, 'support-matrix.json'), 'utf8'));
  const channel = validatePackChannel(manifest, matrix, options);
  for (const file of ['support-matrix.json', 'README.md', 'src/index.mjs', 'cordis.patch.yml', 'LICENSE']) {
    if (!existsSync(join(project, file))) throw new Error('打包前缺少文件：' + file);
  }
  // Check without rebuilding: packaging must not silently change the tested client.
  checkClientArtifact((await buildClient()).code);
  const identitiesBefore = new Map(['package.json', 'support-matrix.json', 'src/client.js'].map(file => [file, sha256(join(project, file))]));
  const record = await commandResult(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], {
    cwd: project, timeoutMs: 60_000, sanitize: value => redact(value),
  });
  writeJson(join(directory, 'pack-execution.json'), receipt(record));
  if (record.exitCode !== 0 || record.timedOut) throw new Error('候选打包失败；见 pack-execution.json。');
  const output = JSON.parse(record.rawStdout);
  const metadata = Array.isArray(output) ? output[0] : Object.values(output).find(value => value?.filename);
  if (!metadata?.filename || basename(metadata.filename) !== metadata.filename) throw new Error('打包输出缺少安全文件名。');
  if (metadata.name !== manifest.name || metadata.version !== manifest.version
    || metadata.filename !== `${manifest.name}-${manifest.version}.tgz`) throw new Error('压缩包身份与候选不一致。');
  const allowed = path => ['package.json', 'README.md', 'cordis.patch.yml', 'support-matrix.json', 'LICENSE', 'src/bundle.mjs', 'src/program.mjs', 'src/index.mjs', 'src/provider.mjs', 'src/control.mjs', 'src/recovery.mjs', 'src/route-verifier.mjs', 'src/settings-ui.mjs', 'src/compatibility-service.mjs', 'src/typert.host.mjs', 'src/client.js'].includes(path)
    || ['locale/zh.json', 'locale/en.json', 'docs/plugin-detail.zh.md', 'docs/plugin-detail.en.md'].includes(path)
    || /^src\/core\/[a-z-]+\.mjs$/.test(path);
  const unexpected = metadata.files.filter(file => !allowed(file.path));
  if (unexpected.length) throw new Error('打包白名单失效：' + unexpected.map(file => file.path).join(', '));
  for (const expected of ['package.json', 'README.md', 'cordis.patch.yml', 'support-matrix.json', 'LICENSE', 'src/bundle.mjs', 'src/program.mjs', 'src/index.mjs', 'src/provider.mjs', 'src/control.mjs', 'src/recovery.mjs', 'src/route-verifier.mjs', 'src/settings-ui.mjs', 'src/compatibility-service.mjs', 'src/typert.host.mjs', 'src/client.js', 'src/core/release-transaction.mjs', 'src/core/product-config.mjs', 'src/core/runtime-compat.mjs', 'src/core/compatibility-state.mjs', 'src/core/compatibility-contract.mjs', 'src/core/compatibility-cli.mjs', 'src/core/settings-contract.mjs']) {
    if (!metadata.files.some(file => file.path === expected)) throw new Error('压缩包遗漏文件：' + expected);
  }
  for (const language of ['zh', 'en']) {
    const locale = `locale/${language}.json`;
    const detail = JSON.parse(readFileSync(join(project, locale), 'utf8')).meta.detail;
    for (const path of [locale, detail]) if (!metadata.files.some(file => file.path === path)) throw new Error('短介绍遗漏文件：' + path);
  }
  const readme = readFileSync(join(project, 'README.md'), 'utf8');
  for (const match of readme.matchAll(/\]\(\.\/([^)#]+)(?:#[^)]*)?\)/g)) {
    if (!metadata.files.some(file => file.path === match[1])) throw new Error('压缩包内 README 链接缺少目标：' + match[1]);
  }
  const tarball = join(directory, metadata.filename);
  const bytes = readFileSync(tarball);
  const sourceHashes = inspectPackedSources(bytes, metadata);
  for (const [file, expected] of identitiesBefore) assert.equal(sha256(join(project, file)), expected, 'PACK_SOURCE_CHANGED');
  checkClientArtifact((await buildClient()).code);
  const packageReceipt = { name: metadata.name, version: metadata.version, filename: metadata.filename,
    sha256: createHash('sha256').update(bytes).digest('hex'), integrity: metadata.integrity, files: metadata.files, whiteListPassed: true,
    sourceHashes, archiveSourcesVerified: true, generatedClientVerified: true,
    releaseChannel: channel, publicReleaseApproved: false, verification: '宿主结果另见本次验证索引；打包不表示已发布。' };
  writeJson(join(directory, 'package-receipt.json'), packageReceipt);
  return { tarball, packageReceipt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--alpha', '--beta', '--release'].includes(args[0]))) throw new Error('打包仅接受 --alpha、--beta、--release 或无参数的内部通道。');
  const alpha = args[0] === '--alpha';
  const beta = args[0] === '--beta';
  const release = args[0] === '--release';
  const { directory, runId } = freshRun(release ? 'release-package' : alpha ? 'alpha-package' : beta ? 'beta-package' : 'internal-package');
  const { packageReceipt } = await packInternal(directory, { alpha, beta, release });
  console.log(JSON.stringify({ runId, directory: redact(directory), ...packageReceipt }, null, 2));
}
