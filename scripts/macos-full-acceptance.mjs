import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_LIMITS, EVIDENCE_TIMEOUTS, confinedPath, createExecutionIdentity, executionSha256,
  fetchVerifiedResource, hashFile, requireSha256, sha256, validateOfficialUrl,
} from './lib/compatibility-evidence.mjs';
import { inspectZip } from './lib/compatibility-smoke.mjs';
import { runBoundedCommand } from './lib/compatibility-process.mjs';
import { readAsar } from './lib/asar.mjs';
import { assertDevelopmentFuseCompatibility, readDesktopGateRuntimes, readElectronFuseWire } from './deferred-release-desktop-prepare.mjs';
import {
  FROZEN_PRODUCT_SHA256, PUBLISHED_OLD_PRODUCT, MACOS_HOST_PINS, MACOS_RUNTIME_FILES, MACOS_STAGES,
  collectMacosEvidence, hashPackageSource, helpersCleanedUp, helpersSucceeded, macosHostPin, macosUpgradeSelection, mapMacosGates,
  readPackageArtifact, readStageEvidence,
} from './lib/macos-acceptance-evidence.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = '.github/workflows/macos-full-acceptance.yml';
export const ACCEPTANCE_WORKFLOW_FILES = Object.freeze([
  workflow, '.github/workflows/macos-package-transport.yml', '.github/workflows/offline-gates.yml',
]);
export const ACCEPTANCE_TOOL_FILES = Object.freeze([
  'scripts/macos-full-acceptance.mjs', 'scripts/macos-clean-lifecycle.mjs', 'scripts/lib/macos-acceptance-evidence.mjs',
  'scripts/lib/compatibility-evidence.mjs', 'scripts/lib/compatibility-smoke.mjs',
  'scripts/lib/compatibility-process.mjs', 'scripts/lib/asar.mjs', 'scripts/lib/candidate-runtime.mjs',
  'scripts/lib/internal-candidate-utils.mjs', 'scripts/lib/renderer-cdp.mjs', 'scripts/lib/retained-session.mjs',
  'scripts/lib/desktop-acceptance-environment.mjs', 'scripts/deferred-release-desktop-prepare.mjs',
  'scripts/b2-plugin-manager-desktop.mjs', 'scripts/verify-search-log-desktop.mjs',
  'scripts/verify-search-log-upgrade.mjs', 'scripts/verify-search-execution-host.mjs',
  'scripts/verify-github-read-host.mjs', 'scripts/compatibility-smoke-host.mjs', 'scripts/internal-candidate-host.mjs',
  'scripts/compatibility-program-host.mjs', 'scripts/lib/compatibility-program-checks.mjs',
  'scripts/lib/browser-gates.mjs',
  'fixtures/deferred-release/desktop-fixture.mjs', 'fixtures/deferred-release/github-api-fixture.mjs',
  'fixtures/deferred-release/control.mjs', 'fixtures/internal-candidate/host-fixture.mjs',
]);
export const PUBLIC_MACOS_SUPPORT_FILES = Object.freeze([
  ...ACCEPTANCE_WORKFLOW_FILES,
  '.gitattributes', '.npmrc', 'package-lock.json', 'scripts/build-client.mjs', 'scripts/pack-internal.mjs',
  'scripts/compatibility-watch.mjs', 'scripts/b3-cli-web.mjs', 'src/client.template.js',
  'src/ui/route-form.mjs', 'src/ui/route-controller.mjs', 'src/ui/search-log-view.mjs',
  'src/ui/quota-view.mjs', 'src/ui/tool-route-view.mjs', 'src/ui/compatibility-view.mjs',
  'src/ui/shared-styles.mjs', 'src/ui/tool-route.css', 'src/ui/route.css', 'src/ui/search-log.css',
  'src/ui/route-card.html', 'src/ui/route-layer.html',
  'src/assets/logos/deepseek-harness-settings.png', 'src/assets/logos/deepseek-harness-chat-light.png',
  'src/assets/logos/deepseek-harness-chat-dark.png', 'src/assets/logos/deepseek-whale.svg',
  'src/assets/logos/grok.png', 'src/assets/logos/tavily-mark-black.svg',
  'src/assets/logos/tavily-mark-offwhite.svg', 'src/assets/logos/exa-logomark-blue.svg',
  'src/assets/logos/exa-logomark-white.svg', 'src/assets/logos/tinyfish-icon.svg',
  'src/assets/logos/firecrawl-logo.svg', 'src/assets/logos/github-invertocat-black.svg',
  'src/assets/logos/github-invertocat-white.svg',
  'test/compatibility-evidence.test.mjs', 'test/macos-acceptance-cases.mjs', 'test/retained-session-cases.mjs',
]);

export async function reviewedMacosSourceClosure(product, sourceRoot = project) {
  const expected = new Map(product.sourceHashes.map(row => [row.file, row.sha256]));
  const names = [...new Set([...expected.keys(), ...ACCEPTANCE_TOOL_FILES, ...PUBLIC_MACOS_SUPPORT_FILES])].sort();
  const files = [];
  for (const path of names) {
    const sha = expected.has(path) ? hashPackageSource(confinedPath(sourceRoot, path))
      : await hashFile(confinedPath(sourceRoot, path), { limit: EVIDENCE_LIMITS.product });
    if (expected.has(path)) assert.equal(sha, expected.get(path), 'Reviewed source differs from the frozen package.');
    files.push({ path, sha256: sha });
  }
  return { productSha256: product.sha256, files, sha256: sha256(JSON.stringify(files)),
    scope: 'macos-verifier-and-transport-only', acceptanceExecuted: false };
}
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'MACOS_ACCEPTANCE_FAILED';
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const create = (root, name) => {
  const path = confinedPath(root, name, { allowMissing: true });
  assert.equal(existsSync(path), false, 'Refusing to reuse an acceptance output directory.');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
};
export function newTemporaryOutput(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'An explicit absolute output directory is required.');
  const parent = realpathSync(dirname(path)), temp = realpathSync(process.env.RUNNER_TEMP || tmpdir());
  const rel = relative(temp, parent);
  assert.ok(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'Outputs must stay in the owned temporary root.');
  assert.equal(existsSync(path), false, 'Refusing to reuse an existing output directory.');
  mkdirSync(path, { mode: 0o700 });
  return realpathSync(path);
}
export function parseHelperPayload(stdout, marker = '') {
  const messages = marker ? stdout.split(/\r?\n/).filter(line => line.startsWith(marker)) : [stdout];
  try {
    assert.equal(messages.length, 1);
    const value = JSON.parse(messages[0].slice(marker.length));
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value;
  } catch { return { passed: false, code: 'MISSING_OR_INVALID_HELPER_RESULT' }; }
}

export function acceptanceEnvironment(root) {
  const env = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    TMPDIR: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_DATA_HOME: join(root, 'xdg-data'), DSH_HOME: join(root, 'dsh-home'),
    DSH_TELEMETRY_DISABLED: '1', CI: '1', NO_COLOR: '1',
  };
  for (const name of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'DSH_HOME']) mkdirSync(env[name], { recursive: true, mode: 0o700 });
  return env;
}

export async function acceptanceVerifierIdentity(product, root = project) {
  const inputs = [];
  for (const path of [...ACCEPTANCE_TOOL_FILES, ...ACCEPTANCE_WORKFLOW_FILES, 'package-lock.json', '.npmrc']) {
    inputs.push({ path, sha256: await hashFile(confinedPath(root, path), { limit: EVIDENCE_LIMITS.gate }) });
  }
  // Helpers import the frozen package's core, not a drifting checkout copy.
  return { inputs, sha256: sha256(JSON.stringify({ inputs, productSha256: product.sha256,
    productSources: product.sourceHashes })) };
}

export function prepareExecutionTree(root, product, sourceRoot = project) {
  const tree = create(root, 'execution-tree');
  for (const [name, bytes] of product.files) {
    const destination = confinedPath(tree, name, { allowMissing: true });
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: 'wx' });
  }
  for (const name of ACCEPTANCE_TOOL_FILES) {
    const destination = confinedPath(tree, name, { allowMissing: true });
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(confinedPath(sourceRoot, name), destination, constants.COPYFILE_EXCL);
  }
  symlinkSync(join(sourceRoot, 'node_modules'), join(tree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return tree;
}

export async function verifyExecutionTreeInputs(tree, product, verifier) {
  for (const { file, sha256: expected } of product.sourceHashes) {
    assert.equal(hashPackageSource(confinedPath(tree, file)), expected, 'Frozen execution-tree product changed.');
  }
  for (const input of verifier.inputs.filter(row => ACCEPTANCE_TOOL_FILES.includes(row.path))) {
    assert.equal(await hashFile(confinedPath(tree, input.path)), input.sha256, 'Executed verifier differs from its fingerprint.');
  }
}

export async function downloadPinnedMacosHost(pin, destination, { fetchImpl = globalThis.fetch, signal } = {}) {
  validateOfficialUrl(pin.url, { kind: 'desktop-asset', lane: 'macos-desktop' });
  const expected = macosHostPin(pin.version);
  assert.deepEqual(pin, expected, 'Download inputs must come from the reviewed local pin table.');
  const hash256 = createHash('sha256'), hash512 = createHash('sha512');
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(EVIDENCE_TIMEOUTS.asset)])
    : AbortSignal.timeout(EVIDENCE_TIMEOUTS.asset);
  bounded.throwIfAborted();
  const fd = openSync(destination, 'wx', 0o600);
  let size;
  try {
    ({ size } = await fetchVerifiedResource(pin.url, { fetchImpl, signal: bounded,
      timeoutMs: EVIDENCE_TIMEOUTS.asset, limit: EVIDENCE_LIMITS.asset,
      validateUrl: url => validateOfficialUrl(url, { kind: 'desktop-asset', lane: 'macos-desktop' }),
      consume(bytes) {
        hash256.update(bytes); hash512.update(bytes);
        for (let offset = 0; offset < bytes.length;) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          assert.ok(written > 0); offset += written;
        }
      } }));
  } finally { closeSync(fd); }
  bounded.throwIfAborted();
  const asset = { ...pin, size, sha256: hash256.digest('hex'), integrity: 'sha512-' + hash512.digest('base64') };
  assert.equal(asset.integrity, pin.integrity, 'Official asset changed from its reviewed content hash.');
  if (pin.sha256) assert.equal(asset.sha256, pin.sha256);
  if (pin.size) assert.equal(size, pin.size);
  assert.equal(await hashFile(destination), asset.sha256);
  bounded.throwIfAborted();
  return asset;
}

export function verifyExtractedMacosArchive(root, entries) {
  const expected = new Set(entries.map(entry => entry.path));
  const parents = new Set();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index++) parents.add(parts.slice(0, index).join('/'));
  }
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), rel = relative(root, path).split(sep).join('/');
      assert.ok(expected.has(rel) || entry.isDirectory() && parents.has(rel), 'Extractor created an unexpected entry.');
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  for (const entry of entries) {
    const path = join(root, entry.path), stat = lstatSync(path), canonical = realpathSync(path);
    const rel = relative(realpathSync(root), canonical);
    assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'Archive link escapes extraction.');
    if (entry.link !== undefined) assert.ok(stat.isSymbolicLink() && readlinkSync(path) === entry.link);
    else assert.ok(!stat.isSymbolicLink() && (entry.directory ? stat.isDirectory() : stat.isFile() && stat.size === entry.size));
  }
}

export async function prepareRuntime(root, asset, environment, signal) {
  const archivePath = confinedPath(root, 'official-host.zip');
  const entries = inspectZip(readFileSync(archivePath));
  const host = create(root, 'official-runtime');
  const unpack = await runBoundedCommand('/usr/bin/ditto', ['-x', '-k', archivePath, host],
    { env: environment, signal, timeout: 180_000 });
  assert.ok(unpack.code === 0 && !unpack.failure && !unpack.signal, 'Safe official archive extraction failed.');
  verifyExtractedMacosArchive(host, entries);
  const paths = MACOS_RUNTIME_FILES;
  const files = {};
  for (const [role, path] of Object.entries(paths)) files[role] = { path, sha256: await hashFile(confinedPath(host, path)) };
  assertDevelopmentFuseCompatibility(readElectronFuseWire(readFileSync(confinedPath(host, paths.fuseBinary))));
  const asar = readAsar(confinedPath(host, paths.archive));
  assert.equal(asar.json('package.json').name, '@deepseek-ai/dsh-desktop');
  assert.equal(asar.json('package.json').version, asset.version);
  assert.equal(asar.json('dsh/package.json').version, asset.version);
  const manifest = asar.json('dsh/desktop-runtime.json');
  assert.equal(manifest.release?.version, asset.version);
  assert.equal(manifest.platform, 'darwin'); assert.equal(manifest.arch, 'arm64');
  let runtimeOptions = {}, receiptFlags = [];
  if (asset.provenance.kind === 'official-update') {
    const source = asset.provenance;
    const candidate = { schemaVersion: 1, kind: 'official-host-candidate', lane: 'macos-desktop',
      platform: 'darwin', arch: 'arm64', host: 'Desktop', environment: 'macos', version: asset.version,
      integrity: asset.integrity, sha256: asset.sha256, size: asset.size,
      source: { kind: 'official-update', url: asset.url, metadataUrl: source.metadataUrl, metadataSha256: source.metadataSha256 } };
    const receiptPath = confinedPath(host, 'runtime-receipt.json', { allowMissing: true });
    json(receiptPath, { schemaVersion: 1, kind: 'verified-runtime-candidate', asset: candidate, files });
    const receiptSha256 = await hashFile(receiptPath);
    runtimeOptions = { runtimeReceiptPath: receiptPath, runtimeReceiptSha256: receiptSha256 };
    receiptFlags = ['--runtime-receipt', receiptPath, '--runtime-receipt-sha256', receiptSha256];
  }
  const [runtime] = readDesktopGateRuntimes([confinedPath(host, paths.executable)], runtimeOptions);
  return { runtime, host, files, receiptFlags, asset, runtimeReceiptSha256: runtimeOptions.runtimeReceiptSha256 ?? null };
}

export function desktopStageArguments(id, { executable, receiptFlags, tarball, oldTarball, cache, upgradeTo }) {
  const manager = ['scripts/b2-plugin-manager-desktop.mjs', '--desktop', executable,
    '--product-package', tarball, ...receiptFlags];
  if (id === 'manager') return manager;
  if (id === 'first-use') return [...manager, '--first-use', 'download', '--diagnostics', 'loopback'];
  if (id === 'upgrade') {
    assert.ok(oldTarball && cache, 'Upgrade needs an exact old package and an actual retained test cache.');
    if (upgradeTo) {
      assert.notEqual(upgradeTo.executable, executable, 'Cross-host upgrade needs two distinct runtimes.');
      assert.deepEqual([upgradeTo.receiptFlags?.[0], upgradeTo.receiptFlags?.[2]],
        ['--runtime-receipt', '--runtime-receipt-sha256']);
      assert.equal(upgradeTo.receiptFlags.length, 4);
      requireSha256(upgradeTo.receiptFlags[3]);
      return [...manager, '--upgrade-from', oldTarball, '--upgrade-cache', cache,
        '--upgrade-in-place-only', 'true', '--upgrade-to-desktop', upgradeTo.executable,
        '--upgrade-to-runtime-receipt', upgradeTo.receiptFlags[1],
        '--upgrade-to-runtime-receipt-sha256', upgradeTo.receiptFlags[3]];
    }
    return [...manager, '--upgrade-from', oldTarball, '--upgrade-cache', cache];
  }
  assert.equal(id, 'renderer');
  return ['scripts/verify-search-log-desktop.mjs', '--editable-config', '--github-read',
    ...receiptFlags, tarball, executable];
}

export function programStageArguments({ tree, hostRoot, outputRoot, productDirectory, tarball, productSha256, grok, grokSha256 }) {
  requireSha256(productSha256); requireSha256(grokSha256);
  return ['--expose-internals', join(tree, 'scripts/compatibility-program-host.mjs'),
    hostRoot, outputRoot, productDirectory, productSha256, '--product-package', tarball,
    '--grok-program', grok, '--grok-sha256', grokSha256];
}

function actualContext() {
  if (process.env.GITHUB_ACTIONS !== 'true') return { kind: 'local' };
  return { kind: 'github-actions', repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
}

export async function runMacosAcceptance({ packageDirectory, oldPackageDirectory, oldPackageSha256,
  version, outputRoot, signal } = {}) {
  assert.equal(process.platform, 'darwin', 'Full macOS gates must actually run on macOS.');
  assert.equal(process.arch, 'arm64', 'Full macOS gates require arm64.');
  const root = newTemporaryOutput(outputRoot), evidenceRoot = create(root, 'evidence'), privateRoot = create(root, 'private');
  const pkg = readPackageArtifact(realpathSync(packageDirectory), FROZEN_PRODUCT_SHA256), product = pkg.product;
  const execution = createExecutionIdentity({ platform: 'darwin', arch: 'arm64', context: actualContext() });
  const verifier = await acceptanceVerifierIdentity(product);
  const stages = [], environment = acceptanceEnvironment(create(privateRoot, 'environment'));
  let asset = null, prepared = null, upgradeSource = null, oldProduct = null;
  let blocker = null, cleanupVerified = false, currentStage = 'preparation', upgradeSelection = null;
  let firstUsePreparation = null;
  const record = async (id, result, payload) => {
    assert.ok(MACOS_STAGES.includes(id) && !stages.some(row => row.id === id));
    const name = id + '.json', path = confinedPath(evidenceRoot, name, { allowMissing: true });
    json(path, payload);
    stages.push({ id, status: result.code === 0 && !result.failure && !result.signal
      && (payload.passed === true || payload.status === 'pass') ? 'passed' : 'failed',
      exitCode: result.code, failure: result.failure ?? null, signal: result.signal ?? null,
      evidence: { path: name, sha256: await hashFile(path, { limit: EVIDENCE_LIMITS.gate }) } });
  };
  const skipped = (id, reason) => stages.push({ id, status: 'not-run', reason });
  try {
    const old = oldPackageDirectory
      ? readPackageArtifact(realpathSync(oldPackageDirectory), requireSha256(oldPackageSha256)) : null;
    if (old) {
      assert.equal(old.product.sha256, PUBLISHED_OLD_PRODUCT.sha256, 'Upgrade uses the reviewed published prior package.');
      oldProduct = old.product;
    }
    upgradeSelection = old ? macosUpgradeSelection(old.manifest, version)
      : { eligible: false, code: 'OLD_PACKAGE_NOT_SUPPLIED', version };
    const pin = macosHostPin(version);
    const archive = confinedPath(privateRoot, 'official-host.zip', { allowMissing: true });
    asset = await downloadPinnedMacosHost(pin, archive, { signal });
    prepared = await prepareRuntime(privateRoot, asset, environment, signal);
    const tree = prepareExecutionTree(privateRoot, pkg);
    await verifyExecutionTreeInputs(tree, product, verifier);
    const probeRoot = create(privateRoot, 'probe'), probeEnv = acceptanceEnvironment(probeRoot);
    const profile = join(probeEnv.DSH_HOME, 'profiles/candidate');
    mkdirSync(profile, { recursive: true });
    json(join(profile, 'package.json'), { name: 'macos-acceptance-isolated', version: '0.0.0', private: true });
    const npm = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(path => existsSync(path));
    assert.ok(npm, 'Supported npm CLI required.');
    const config = join(probeRoot, 'npm-empty.ini'), global = join(probeRoot, 'npm-global-empty.ini');
    writeFileSync(config, '', { flag: 'wx' }); writeFileSync(global, '', { flag: 'wx' });
    currentStage = 'admission';
    const install = await runBoundedCommand(process.execPath, [npm, 'install', pkg.path, '--ignore-scripts',
      '--legacy-peer-deps=false', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/',
      '--userconfig', config, '--globalconfig', global, '--cache', join(probeRoot, 'npm-cache'), '--fetch-retries=1'],
    { cwd: profile, env: probeEnv, signal, timeout: 600_000 });
    const installed = join(profile, 'node_modules/dsh-grok-search');
    let checkedFiles = 0;
    if (install.code === 0 && !install.failure) {
      for (const [file, bytes] of pkg.files) {
        assert.equal(hashPackageSource(confinedPath(installed, file)), sha256(bytes)); checkedFiles++;
      }
    }
    const hostCopies = existsSync(join(profile, 'node_modules/@deepseek-ai')) || existsSync(join(installed, 'node_modules/@deepseek-ai'));
    await record('admission', install, { passed: install.code === 0 && !install.failure && !hostCopies
      && checkedFiles === product.fileCount, productSha256: product.sha256, checkedFiles, hostCopies, legacyPeerDeps: false });
    if (install.code === 0 && !install.failure && !hostCopies) {
      currentStage = 'smoke';
      const result = await runBoundedCommand(prepared.runtime.executable, ['--expose-internals',
        join(tree, 'scripts/compatibility-smoke-host.mjs'), prepared.runtime.archivePath, probeRoot, installed],
      { cwd: tree, env: { ...probeEnv, ELECTRON_RUN_AS_NODE: '1' }, signal, timeout: 120_000 });
      await record('smoke', result, parseHelperPayload(result.stdout, 'DSH_COMPATIBILITY_SMOKE='));
    } else skipped('smoke', 'Strict package installation failed.');
    for (const [id, script] of [['search-contract', 'verify-search-execution-host'], ['github-contract', 'verify-github-read-host']]) {
      currentStage = id;
      const result = await runBoundedCommand(prepared.runtime.executable, ['--expose-internals',
        join(tree, 'scripts/' + script + '.mjs'), prepared.runtime.archivePath, tree],
      { cwd: tree, env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, signal, timeout: 180_000 });
      await record(id, result, parseHelperPayload(result.stdout));
    }
    let cache = null, grok = null;
    const groups = { 'first-use': 'diagnostics-desktop', manager: 'b2-plugin-manager-desktop',
      renderer: 'search-log-desktop', upgrade: 'plugin-manager-upgrade' };
    for (const id of ['first-use', 'manager', 'renderer', 'upgrade']) {
      if (id === 'upgrade' && !upgradeSelection.eligible) {
        skipped(id, upgradeSelection.code); continue;
      }
      if (id === 'renderer' && !grok || id === 'upgrade' && !cache) {
        skipped(id, 'A hash-verified old package or successful private program preparation is missing.'); continue;
      }
      currentStage = id;
      if (id === 'upgrade' && upgradeSelection.mode === 'cross-host') {
        const fromRoot = create(privateRoot, 'upgrade-source');
        const fromAsset = await downloadPinnedMacosHost(macosHostPin(upgradeSelection.fromVersion),
          confinedPath(fromRoot, 'official-host.zip', { allowMissing: true }), { signal });
        upgradeSource = await prepareRuntime(fromRoot, fromAsset, environment, signal);
      }
      const selected = id === 'upgrade' && upgradeSource ? upgradeSource : prepared;
      const env = { ...environment, ...(grok ? { DSH_LOG_GROK_PROGRAM: grok } : {}) };
      const result = await runBoundedCommand(process.execPath, desktopStageArguments(id, {
        executable: selected.runtime.executable, receiptFlags: selected.receiptFlags, tarball: pkg.path,
        oldTarball: old?.path, cache, ...(id === 'upgrade' && upgradeSource ? {
          upgradeTo: { executable: prepared.runtime.executable, receiptFlags: prepared.receiptFlags },
        } : {}),
      }), { cwd: tree, env, signal, timeout: 600_000 });
      const group = join(tree, 'artifacts', groups[id]);
      const directories = existsSync(group) ? readdirSync(group) : [];
      assert.ok(directories.length <= 1, 'A fresh per-host execution must not reuse historical summaries.');
      let payload = { passed: false, code: 'MISSING_DESKTOP_RESULT' };
      let sourceEvidence = null;
      if (directories.length === 1) {
        const path = confinedPath(group, directories[0] + '/summary.json');
        assert.ok(lstatSync(path).size <= EVIDENCE_LIMITS.gate);
        const bytes = readFileSync(path);
        payload = parseHelperPayload(bytes.toString('utf8'));
        sourceEvidence = { group: groups[id], runId: directories[0], sha256: sha256(bytes) };
        assert.equal(payload.runId, directories[0], 'Helper summary differs from its execution directory.');
        if (id === 'first-use' && result.code !== 0) {
          const diagnostic = confinedPath(group, directories[0] + '/' + version + '-first-use-disable-diagnostic.json',
            { allowMissing: true });
          if (existsSync(diagnostic)) {
            assert.ok(lstatSync(diagnostic).size <= EVIDENCE_LIMITS.gate);
            const output = confinedPath(evidenceRoot, 'first-use-disable-diagnostic.json', { allowMissing: true });
            copyFileSync(diagnostic, output, constants.COPYFILE_EXCL);
            console.log(JSON.stringify({ firstUseFailureDiagnostic: 'first-use-disable-diagnostic.json' }));
          }
        }
        if (id === 'first-use') {
          const checkpoint = confinedPath(group, directories[0] + '/' + version + '-first-use-program-prepared.json',
            { allowMissing: true });
          if (existsSync(checkpoint)) {
            assert.ok(lstatSync(checkpoint).size <= EVIDENCE_LIMITS.gate);
            const bytes = readFileSync(checkpoint);
            const value = JSON.parse(bytes);
            assert.equal(value.hostVersion, version);
            assert.equal(value.productSha256, product.sha256);
            assert.equal(value.scope, 'first-use-preparation-checkpoint-not-complete-lifecycle-acceptance');
            assert.equal(value.program.source, 'private-cache');
            assert.equal(value.program.mcpHandshakeValidated, true);
            const destination = confinedPath(evidenceRoot, 'first-use-program-prepared.json', { allowMissing: true });
            copyFileSync(checkpoint, destination, constants.COPYFILE_EXCL);
            firstUsePreparation = { ...value, evidence: { path: 'first-use-program-prepared.json', sha256: sha256(bytes) } };
          }
        }
      }
      await record(id, result, payload);
      if (sourceEvidence) {
        assert.equal(stages.at(-1).evidence.sha256, sourceEvidence.sha256, 'Original helper summary serialization differs.');
        stages.at(-1).sourceEvidence = sourceEvidence;
      }
      if (id === 'first-use' && firstUsePreparation) {
        assert.match(payload.runId, /^[a-zA-Z0-9_.-]{1,128}$/);
        cache = confinedPath(realpathSync(environment.TMPDIR),
          `dsh-deferred-desktop-manager-${payload.runId}/${version}/dsh-home/profiles/desktop/grok-search/runtime-cache`);
        const activePath = confinedPath(cache, 'active.json');
        assert.ok(lstatSync(activePath).size <= EVIDENCE_LIMITS.receipt);
        const active = JSON.parse(readFileSync(activePath, 'utf8'));
        grok = confinedPath(cache, active.executable);
        assert.equal(await hashFile(activePath), firstUsePreparation.activeSha256);
        assert.equal(await hashFile(grok), firstUsePreparation.program.sha256);
        if (!hostCopies && install.code === 0 && !install.failure) {
          currentStage = 'program-host';
          const output = confinedPath(privateRoot, 'program-host', { allowMissing: true });
          const result = await runBoundedCommand(prepared.runtime.executable, programStageArguments({
            tree, hostRoot: prepared.runtime.archivePath, outputRoot: output, productDirectory: installed,
            tarball: pkg.path, productSha256: product.sha256, grok, grokSha256: await hashFile(grok),
          }), { cwd: tree, env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, signal, timeout: 780_000 });
          await record('program-host', result, parseHelperPayload(result.stdout, 'DSH_COMPATIBILITY_PROGRAM='));
        } else skipped('program-host', 'Strict installed product dependencies are required for the managed program cases.');
      }
    }
    currentStage = 'final-identity-check';
    await verifyExecutionTreeInputs(tree, product, verifier);
    for (const host of [prepared, upgradeSource].filter(Boolean)) {
      for (const row of Object.values(host.files)) assert.equal(await hashFile(confinedPath(host.host, row.path)), row.sha256);
    }
    assert.equal(await hashFile(pkg.path), FROZEN_PRODUCT_SHA256);
    assert.equal((await acceptanceVerifierIdentity(product)).sha256, verifier.sha256, 'Verifier changed during execution.');
  } catch (error) {
    blocker = safeCode(error);
    if (MACOS_STAGES.includes(currentStage) && !stages.some(row => row.id === currentStage)
      && !existsSync(join(evidenceRoot, currentStage + '.json'))) {
      await record(currentStage, { code: null, failure: blocker, signal: null }, { passed: false, code: blocker });
    }
  }
  for (const id of MACOS_STAGES) if (!stages.some(row => row.id === id)) skipped(id, blocker || 'Prerequisite did not run.');
  const actual = await readStageEvidence(evidenceRoot, stages);
  cleanupVerified = !blocker && helpersCleanedUp(actual);
  const gates = mapMacosGates({ product, version, stages: actual });
  const receipt = { schemaVersion: 1, kind: 'macos-exact-package-acceptance', version,
    platform: 'darwin-arm64', host: 'Desktop', environment: 'macos', product,
    hostAsset: asset, runtimeFiles: prepared?.files ?? null, runtimeReceiptSha256: prepared?.runtimeReceiptSha256 ?? null,
    verifierSha256: verifier.sha256, verifierInputs: verifier.inputs,
    execution: { ...execution, finishedAt: new Date().toISOString() }, stages, gates, blocker,
    ...(blocker ? { blockerStage: currentStage } : {}),
    passed: gates.every(row => row.passed) && cleanupVerified && helpersSucceeded(actual),
    cleanupVerified, realCredentialsUsed: false,
    counterScope: 'protected-search-windows-only; explicit release/disable restoration calls are separate',
    upgradeSelection, oldProduct,
    firstUsePreparation,
    upgradeSourceHost: upgradeSource ? { asset: upgradeSource.asset, runtimeFiles: upgradeSource.files } : null,
    hostTransitions: { status: 'not-run', inferredFromVersionMatrix: false },
    primaryGrokVerified: false, published: false };
  json(join(evidenceRoot, 'receipt.json'), { ...receipt, runSha256: executionSha256(receipt) });
  return receipt;
}

export function parseArguments(argv) {
  const [mode, ...args] = argv;
  assert.ok(['check-package', 'run', 'collect'].includes(mode), 'Expected check-package, run, or collect.');
  const values = {};
  const required = {
    'check-package': ['--package-directory', '--expected-sha256'],
    run: ['--package-directory', '--version', '--output-root'],
    collect: ['--package-directory', '--evidence-root', '--output-root'],
  };
  const allowed = [...required[mode], ...(mode === 'run' ? ['--old-package-directory', '--old-package-sha256'] : [])];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    assert.ok(allowed.includes(key) && !Object.hasOwn(values, key) && typeof value === 'string'
      && value.trim() && !value.startsWith('--') && !/[\0\r\n]/.test(value), 'Invalid or duplicate named argument.');
    values[key] = value;
  }
  assert.ok(required[mode].every(name => values[name]), 'Required acceptance arguments are missing.');
  if (mode === 'check-package') requireSha256(values['--expected-sha256']);
  if (mode === 'run') {
    assert.ok(Object.hasOwn(MACOS_HOST_PINS, values['--version']), 'Unknown acceptance target.');
    assert.equal(Boolean(values['--old-package-directory']), Boolean(values['--old-package-sha256']));
    if (values['--old-package-sha256']) requireSha256(values['--old-package-sha256']);
  }
  return { mode, values };
}

async function main() {
  const { mode, values: v } = parseArguments(process.argv.slice(2));
  if (mode === 'check-package') {
    const pkg = readPackageArtifact(realpathSync(v['--package-directory']), requireSha256(v['--expected-sha256']));
    console.log(JSON.stringify({ product: pkg.product }));
  } else if (mode === 'run') {
    const receipt = await runMacosAcceptance({ packageDirectory: v['--package-directory'], version: v['--version'],
      oldPackageDirectory: v['--old-package-directory'], oldPackageSha256: v['--old-package-sha256'],
      outputRoot: v['--output-root'], signal: AbortSignal.timeout(115 * 60_000) });
    console.log(JSON.stringify({ version: receipt.version, passed: receipt.passed, blocker: receipt.blocker,
      gates: receipt.gates.map(({ id, status }) => ({ id, status })) }));
    process.exitCode = receipt.passed ? 0 : 1;
  } else {
    const pkg = readPackageArtifact(realpathSync(v['--package-directory']), FROZEN_PRODUCT_SHA256);
    const context = actualContext();
    const verifier = await acceptanceVerifierIdentity(pkg.product);
    const receipt = await collectMacosEvidence(realpathSync(v['--evidence-root']), pkg.product,
      { ...(context.kind === 'github-actions' ? context : {}), verifierSha256: verifier.sha256 });
    const output = newTemporaryOutput(v['--output-root']);
    json(join(output, 'macos-acceptance.json'), receipt);
    console.log(JSON.stringify(receipt.summary));
    process.exitCode = receipt.passed ? 0 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
}
