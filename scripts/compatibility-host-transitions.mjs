import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import semver from 'semver';
import { readAsar } from './lib/asar.mjs';
import { COMPATIBILITY_LANES, confinedPath, exactVersion, hashFile, hostVersionAdmitted, readJsonReceipt,
  readRuntimeReceipt, requireSha256, sha256, validateOfficialUrl } from './lib/compatibility-evidence.mjs';
import { inspectPackage, validateInstallManifest } from './lib/compatibility-smoke.mjs';
import { runBoundedCommand } from './lib/compatibility-process.mjs';
import { assertDevelopmentFuseCompatibility, readElectronFuseWire } from './deferred-release-desktop-prepare.mjs';
import { compatibilitySmokeReady, invokeCompatibilitySearch, prepareCompatibilitySmoke, snapshotCompatibility } from './compatibility-smoke-host.mjs';
import { CANDIDATE_VERSIONS } from './lib/candidate-runtime.mjs';

export const HOST_TRANSITION_MARKER = 'DSH_HOST_TRANSITION=';
const script = fileURLToPath(import.meta.url);
const project = resolve(dirname(script), '..');
export const HOST_TRANSITION_VERIFIER_PATHS = Object.freeze([
  'scripts/compatibility-host-transitions.mjs', 'scripts/compatibility-smoke-host.mjs',
  'scripts/lib/asar.mjs', 'scripts/lib/compatibility-evidence.mjs', 'scripts/lib/compatibility-smoke.mjs',
  'scripts/lib/compatibility-process.mjs', 'scripts/deferred-release-desktop-prepare.mjs', 'scripts/lib/candidate-runtime.mjs',
]);
const scope = 'same-plugin-official-host-transition-node-contract';
const fixtureName = 'compatibility-transition-fixture';
const bundles = [fixtureName, 'dsh-grok-search'];
const insist = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const codeOf = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code ?? '') ? error.code : 'HOST_TRANSITION_FAILED';
const idle = value => value?.running === 0 && value.queued === 0 && value.faulted === 0;
const same = (left, right, code) => insist(isDeepStrictEqual(left, right), code);
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const sourceUrl = (runId, index, suffix) => `https://compatibility-transition.invalid/${runId}/${index}/${suffix}`;
const queryFor = (runId, index, suffix) => `compatibility-smoke-${runId}-${index}-${suffix}`;
const retainedFiles = ['package.json', 'cordis.patch.yml', 'grok-search/compatibility-smoke.toml',
  'grok-search/preferences.json', 'grok-search/compatibility-state.json'];
const historicalExtractionToolSha256 = 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95';

function absolute(value) {
  insist(typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/.test(value)
    && !value.startsWith('\\\\') && !value.startsWith('//'), 'HOST_TRANSITION_PATH_UNSAFE');
  return resolve(value);
}

function ordinaryDirectory(path) {
  const root = absolute(path);
  for (let current = root; ; current = dirname(current)) {
    const stat = lstatSync(current);
    insist(stat.isDirectory() && !stat.isSymbolicLink(), 'HOST_TRANSITION_PATH_UNSAFE');
    if (dirname(current) === current) break;
  }
  return realpathSync(root);
}

function boundedBytes(path, limit = 1024 * 1024) {
  const stat = lstatSync(path);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'HOST_TRANSITION_FILE_UNSAFE');
  const bytes = readFileSync(path);
  insist(bytes.length === stat.size, 'HOST_TRANSITION_FILE_CHANGED');
  return bytes;
}

function fingerprintOrdinaryFile(path) {
  const before = lstatSync(path);
  insist(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= 2 * 1024 * 1024 * 1024,
    'HOST_TRANSITION_FILE_UNSAFE');
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = openSync(path, 'r');
  let offset = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) break;
      offset += count;
      insist(offset <= before.size, 'HOST_TRANSITION_FILE_CHANGED');
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
  const after = lstatSync(path);
  insist(offset === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs && before.ino === after.ino && before.dev === after.dev,
  'HOST_TRANSITION_FILE_CHANGED');
  return hash.digest('hex');
}

function certificateThumbprint(value) {
  insist(typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value), 'HOST_TRANSITION_SIGNATURE_RECEIPT');
  return value.toUpperCase();
}

function observedTime(value) {
  insist(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'HOST_TRANSITION_PROVENANCE_RECEIPT');
}

function readWindowsAuthenticode(installer) {
  insist(process.platform === 'win32', 'HOST_TRANSITION_HISTORICAL_PLATFORM');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const shell = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$value = Get-AuthenticodeSignature -LiteralPath $env:DSH_TRANSITION_SIGNATURE_INPUT',
    '[pscustomobject]@{ status = [string]$value.Status; signerSubject = $value.SignerCertificate.Subject;',
    'certificateThumbprint = $value.SignerCertificate.Thumbprint; timestampSubject = $value.TimeStamperCertificate.Subject;',
    'timestampThumbprint = $value.TimeStamperCertificate.Thumbprint } | ConvertTo-Json -Compress',
  ].join('\n');
  const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], {
    cwd: dirname(installer), env: { SystemRoot: systemRoot, WINDIR: systemRoot, DSH_TRANSITION_SIGNATURE_INPUT: installer },
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024,
  });
  insist(!result.error && result.status === 0 && result.signal === null, 'HOST_TRANSITION_SIGNATURE_CHECK_FAILED');
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()); }
  catch { insist(false, 'HOST_TRANSITION_SIGNATURE_CHECK_FAILED'); }
}

function readHistoricalRuntime(raw, root, signatureReader, extractionToolFingerprint) {
  insist(raw.schemaVersion === 1 && raw.kind === 'reviewed-historical-runtime'
    && process.platform === 'win32' && process.arch === 'x64'
    && raw.host?.platform === 'win32' && raw.host.arch === 'x64', 'HOST_TRANSITION_HISTORICAL_PLATFORM');
  const version = exactVersion(raw.host.version);
  insist(CANDIDATE_VERSIONS.includes(version) && hostVersionAdmitted(version), 'HOST_TRANSITION_HISTORICAL_HOST_UNKNOWN');
  insist(raw.source?.metadataStatus === 'unavailable' && typeof raw.source.metadataReason === 'string'
    && raw.source.metadataReason.length > 0 && raw.source.metadataReason.length <= 1024
    && !raw.asset && !raw.source.metadataSha256 && !raw.source.metadataUrl, 'HOST_TRANSITION_HISTORICAL_METADATA');
  const url = validateOfficialUrl(raw.source.url, { kind: 'desktop-asset', lane: 'windows-desktop' });
  insist(new URL(url).pathname.split('/').at(-1) === `deepseek-harness-${version}-win-x64.exe`,
    'HOST_TRANSITION_HISTORICAL_URL');
  const installer = confinedPath(root, raw.installer?.path), installerSha256 = requireSha256(raw.installer?.sha256);
  insist(fingerprintOrdinaryFile(installer) === installerSha256, 'HOST_TRANSITION_HISTORICAL_INSTALLER_CHANGED');
  const signaturePath = confinedPath(root, raw.signatureReceipt?.path);
  const extractionPath = confinedPath(root, raw.extractionReceipt?.path);
  const signatureSha256 = requireSha256(raw.signatureReceipt?.sha256), extractionSha256 = requireSha256(raw.extractionReceipt?.sha256);
  const signature = readJsonReceipt(signaturePath, signatureSha256), extraction = readJsonReceipt(extractionPath, extractionSha256);
  for (const evidence of [signature, extraction]) {
    insist(evidence.schemaVersion === 1 && evidence.installerSha256 === installerSha256 && evidence.url === url
      && evidence.version === version && evidence.platform === 'win32' && evidence.arch === 'x64',
    'HOST_TRANSITION_PROVENANCE_RECEIPT');
    observedTime(evidence.observedAt);
  }
  insist(signature.kind === 'windows-authenticode-validation'
    && signature.verifier?.kind === 'parent-local-GetAuthenticodeSignature'
    && signature.validation?.status === 'Valid' && typeof signature.validation.signerSubject === 'string'
    && /deepseek/i.test(signature.validation.signerSubject), 'HOST_TRANSITION_SIGNATURE_RECEIPT');
  const thumbprint = certificateThumbprint(signature.validation.certificateThumbprint);
  const current = signatureReader(installer);
  insist(current?.status === 'Valid' && current.signerSubject === signature.validation.signerSubject
    && certificateThumbprint(current.certificateThumbprint) === thumbprint, 'HOST_TRANSITION_SIGNATURE_CHANGED');
  for (const field of ['timestampSubject', 'timestampThumbprint']) if (signature.validation[field] !== undefined) {
    if (field === 'timestampThumbprint') {
      insist(certificateThumbprint(current[field]) === certificateThumbprint(signature.validation[field]),
        'HOST_TRANSITION_SIGNATURE_CHANGED');
    } else same(current[field], signature.validation[field], 'HOST_TRANSITION_SIGNATURE_CHANGED');
  }
  insist(fingerprintOrdinaryFile(installer) === installerSha256, 'HOST_TRANSITION_HISTORICAL_INSTALLER_CHANGED');
  insist(extraction.kind === 'same-installer-runtime-extraction' && extraction.method?.exitCode === 0
    && Array.isArray(extraction.method.argv) && extraction.method.argv.length > 0
    && extraction.method.argv.every(value => typeof value === 'string' && !/[\0\r\n]/.test(value))
    && extraction.method.sha256 === historicalExtractionToolSha256, 'HOST_TRANSITION_EXTRACTION_RECEIPT');
  const tool = confinedPath(root, extraction.method.executable);
  insist(extractionToolFingerprint(tool) === historicalExtractionToolSha256, 'HOST_TRANSITION_EXTRACTION_TOOL_CHANGED');
  const roles = ['executable', 'archive', 'fuseBinary'];
  same(Object.keys(raw.files ?? {}).sort(), [...roles].sort(), 'HOST_TRANSITION_HISTORICAL_FILES');
  same(Object.keys(extraction.files ?? {}).sort(), [...roles].sort(), 'HOST_TRANSITION_HISTORICAL_FILES');
  const files = {};
  for (const role of roles) {
    const expected = requireSha256(raw.files[role]?.sha256), path = confinedPath(root, raw.files[role]?.path);
    const extracted = confinedPath(root, extraction.files[role]?.path);
    insist(path !== extracted && extraction.files[role]?.sha256 === expected && fingerprintOrdinaryFile(path) === expected
      && fingerprintOrdinaryFile(extracted) === expected, 'HOST_TRANSITION_HISTORICAL_FILES_CHANGED');
    files[role] = path;
  }
  insist(files.fuseBinary === files.executable
    && resolve(root, extraction.files.fuseBinary.path) === resolve(root, extraction.files.executable.path),
  'HOST_TRANSITION_HISTORICAL_FILES');
  const args = extraction.method.argv, extractedExecutable = resolve(root, extraction.files.executable.path);
  insist(args.length === 7 && args[0] === 'x' && args[1] === '-y' && args[2].startsWith('-o')
    && resolve(root, args[2].slice(2)) === dirname(extractedExecutable) && args[3] === '--'
    && resolve(root, args[4]) === installer && args[5] === 'DeepSeek Harness.exe' && args[6] === 'resources/app.asar'
    && resolve(root, extraction.files.archive.path) === join(dirname(extractedExecutable), 'resources/app.asar'),
  'HOST_TRANSITION_EXTRACTION_COMMAND');
  return {
    files, asset: { schemaVersion: 1, kind: 'reviewed-historical-host', lane: 'windows-desktop',
      ...COMPATIBILITY_LANES['windows-desktop'], version, sha256: installerSha256,
      source: { kind: 'reviewed-signed-historical-installer', url, metadataStatus: 'unavailable' } },
    provenance: { kind: raw.kind, officialFeedVerified: false, metadataStatus: 'unavailable', metadataReason: raw.source.metadataReason,
      installerSha256, signatureReceiptSha256: signatureSha256, extractionReceiptSha256: extractionSha256,
      signatureValidation: signatureReader === readWindowsAuthenticode && extractionToolFingerprint === fingerprintOrdinaryFile
        ? 'actual-windows-GetAuthenticodeSignature'
        : 'synthetic-unit-not-signature-proof',
      signature: { status: current.status, signerSubject: current.signerSubject, certificateThumbprint: thumbprint,
        ...(current.timestampThumbprint ? { timestampThumbprint: certificateThumbprint(current.timestampThumbprint) } : {}) },
      extractionLinkEvidence: 'parent-pinned-command-and-reextracted-byte-comparison' },
  };
}

export function parseHostTransitionArgs(args) {
  const names = new Map([
    ['--package', 'packagePath'], ['--package-sha256', 'packageSha256'],
    ['--dependencies-root', 'dependenciesRoot'], ['--output-root', 'outputRoot'],
    ['--from-receipt', 'fromReceipt'], ['--from-receipt-sha256', 'fromReceiptSha256'], ['--from-root', 'fromRoot'],
    ['--to-receipt', 'toReceipt'], ['--to-receipt-sha256', 'toReceiptSha256'], ['--to-root', 'toRoot'],
  ]);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]), value = args[index + 1];
    insist(key && !Object.hasOwn(result, key) && typeof value === 'string' && value && !value.startsWith('--'),
      'HOST_TRANSITION_ARGUMENT_INVALID');
    result[key] = value;
  }
  insist(Object.keys(result).length === names.size, 'HOST_TRANSITION_ARGUMENT_REQUIRED');
  for (const key of ['packageSha256', 'fromReceiptSha256', 'toReceiptSha256']) requireSha256(result[key]);
  for (const key of ['packagePath', 'dependenciesRoot', 'outputRoot', 'fromReceipt', 'toReceipt', 'fromRoot', 'toRoot']) {
    result[key] = absolute(result[key]);
  }
  return result;
}

export function validateHostTransitionPair(from, to, { platform = process.platform, arch = process.arch } = {}) {
  insist(from?.lane === to?.lane && from?.platform === platform && to?.platform === platform
    && from?.arch === arch && to?.arch === arch, 'HOST_TRANSITION_PLATFORM_MISMATCH');
  exactVersion(from.version); exactVersion(to.version);
  insist(semver.compare(from.version, to.version) !== 0, 'HOST_TRANSITION_DISTINCT_HOSTS_REQUIRED');
  return [from.version, to.version, from.version];
}

export function readHostTransitionRuntime({ receiptPath, receiptSha256, root }, {
  signatureReader = readWindowsAuthenticode, extractionToolFingerprint = fingerprintOrdinaryFile,
} = {}) {
  root = ordinaryDirectory(root);
  const raw = readJsonReceipt(absolute(receiptPath), requireSha256(receiptSha256));
  const historical = raw.kind === 'reviewed-historical-runtime';
  let asset = raw.asset;
  const desktop = asset?.lane !== 'linux-cli';
  const verified = historical ? readHistoricalRuntime(raw, root, signatureReader, extractionToolFingerprint)
    : readRuntimeReceipt({ receiptPath, receiptSha256, root, version: asset?.version,
    platform: process.platform, arch: process.arch,
    roles: desktop ? ['executable', 'archive', 'fuseBinary'] : ['executable', 'cliManifest'] });
  if (historical) asset = verified.asset;
  let hostRoot, executable, modern;
  if (desktop) {
    const { files } = verified;
    const archive = process.platform === 'win32' ? join(dirname(files.executable), 'resources/app.asar')
      : resolve(dirname(files.executable), '../Resources/app.asar');
    const fuse = process.platform === 'win32' ? files.executable
      : resolve(dirname(files.executable), '../Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
    insist(files.archive === archive && files.fuseBinary === fuse, 'HOST_TRANSITION_RUNTIME_LAYOUT');
    const app = readAsar(archive), identity = app.json('package.json'), runtime = app.json('dsh/desktop-runtime.json');
    insist(identity.name === '@deepseek-ai/dsh-desktop' && identity.version === asset.version
      && app.json('dsh/package.json').version === asset.version && runtime.release?.version === asset.version
      && runtime.platform === asset.platform && runtime.arch === asset.arch
      && app.json('dsh/node_modules/@deepseek-ai/dsh/package.json').version === asset.version,
    'HOST_TRANSITION_RUNTIME_IDENTITY');
    assertDevelopmentFuseCompatibility(readElectronFuseWire(readFileSync(fuse)));
    modern = app.entries('dsh/node_modules/@deepseek-ai').includes('dsh-tool-executor-native');
    hostRoot = archive; executable = files.executable;
  } else {
    const manifestPath = verified.files.cliManifest, manifest = readJsonReceipt(manifestPath);
    hostRoot = resolve(dirname(manifestPath), '../../..');
    insist(join(hostRoot, 'node_modules/@deepseek-ai/dsh/package.json') === manifestPath
      && verified.files.executable === join(dirname(manifestPath), 'lib/bin.js')
      && manifest.name === '@deepseek-ai/dsh' && manifest.version === asset.version,
    'HOST_TRANSITION_RUNTIME_LAYOUT');
    insist(semver.satisfies(process.versions.node, asset.nodeRange || '*', { includePrerelease: true })
      && semver.satisfies(process.versions.node, manifest.engines?.node || '*', { includePrerelease: true }),
    'HOST_TRANSITION_NODE_UNSUPPORTED');
    executable = process.execPath;
    modern = existsSync(join(hostRoot, 'node_modules/@deepseek-ai/dsh-tool-executor-native/package.json'));
  }
  return { receiptPath: absolute(receiptPath), receiptSha256, root, asset, hostRoot, executable, modern,
    files: structuredClone(raw.files),
    ...(historical ? { provenance: verified.provenance } : {}) };
}

// Reuse only the declared runtime dependency closure. Never run a package manager,
// carry host peers into the profile, or follow links out of the caller's source.
function copyDependencies(sourceRoot, destination, requirements) {
  sourceRoot = ordinaryDirectory(sourceRoot);
  insist(basename(sourceRoot) === 'node_modules', 'HOST_TRANSITION_DEPENDENCIES_ROOT');
  const planned = new Map(), packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  function locate(name, parent) {
    const candidates = [];
    for (let current = parent; current !== sourceRoot; current = dirname(current)) {
      insist(relative(sourceRoot, current) && !relative(sourceRoot, current).startsWith('..'),
        'HOST_TRANSITION_DEPENDENCY_ESCAPE');
      if (basename(current) !== 'node_modules') candidates.push(join(current, 'node_modules', name));
    }
    candidates.push(join(sourceRoot, name));
    return candidates.find(path => existsSync(path));
  }
  function include(name, range, parent, optional = false) {
    insist(packageName.test(name) && !name.startsWith('@deepseek-ai/') && name !== 'dsh-grok-search'
      && typeof range === 'string' && semver.validRange(range), 'HOST_TRANSITION_DEPENDENCY_UNSAFE');
    const path = locate(name, parent);
    if (!path && optional) return;
    insist(path, 'HOST_TRANSITION_DEPENDENCY_MISSING');
    const rel = relative(sourceRoot, path).split(sep).join('/');
    confinedPath(sourceRoot, rel);
    const manifest = readJsonReceipt(confinedPath(sourceRoot, rel + '/package.json'));
    insist(manifest.name === name && semver.satisfies(manifest.version, range, { includePrerelease: true }),
      'HOST_TRANSITION_DEPENDENCY_VERSION');
    if (planned.has(rel)) return;
    insist(planned.size < 128, 'HOST_TRANSITION_DEPENDENCY_LIMIT');
    planned.set(rel, { path, version: manifest.version });
    for (const [child, version] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      include(child, version, path, Object.hasOwn(manifest.optionalDependencies ?? {}, child));
    }
    for (const [child, version] of Object.entries(manifest.peerDependencies ?? {})) {
      include(child, version, path, manifest.peerDependenciesMeta?.[child]?.optional === true);
    }
  }
  for (const [name, range] of Object.entries(requirements)) include(name, range, sourceRoot);
  const files = {};
  let size = 0;
  function copy(folder, rel) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const key = rel + '/' + entry.name, path = confinedPath(sourceRoot, key);
      insist(!entry.isSymbolicLink(), 'HOST_TRANSITION_DEPENDENCY_LINK');
      if (entry.isDirectory()) { copy(path, key); continue; }
      const bytes = boundedBytes(path, 32 * 1024 * 1024);
      size += bytes.length;
      insist(size <= 128 * 1024 * 1024 && Object.keys(files).length < 10000, 'HOST_TRANSITION_DEPENDENCY_LIMIT');
      const target = confinedPath(destination, key, { allowMissing: true });
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      files[key] = sha256(bytes);
    }
  }
  for (const [rel, value] of planned) copy(value.path, rel);
  return { packages: Object.fromEntries([...planned].map(([name, value]) => [name, value.version])), files };
}

const fixtureSource = `
const state = () => globalThis.__DSH_HOST_TRANSITION__;
export function applyContext(ctx) {
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1; } });
  ctx.provide('candidateExistingDependency', { synthetic: true });
  ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: state().calls.original }) });
  ctx.effect(() => () => { state().disposed++; });
}
export function applyProviders(ctx) {
  ctx.web.registerSearchProvider({ id: 'candidate-original', available: () => true,
    async search() { state().calls.original++; return { sources: [], truncated: false }; } });
  ctx.web.registerFetchProvider({ id: 'candidate-fetch', available: () => true,
    async fetch(request) { state().calls.fetch++; return { url: request.url, statusCode: 200,
      body: { kind: 'text', content: 'Synthetic transition control' }, truncated: false }; } });
}
`;

function fixturePatch(modern) {
  const row = (id, name, config = {}) => ({ id, name: '@deepseek-ai/' + name, config });
  return [{ insert: [
    { id: 'fixture-context', name: fixtureName + '/context' },
    row('timer', 'cordis-plugin-timer'), row('config-editor', 'dsh-config-editor'),
    row('tools', 'dsh-tools', modern ? {} : { mode: 'native' }),
    ...(modern ? [row('tool-executor-native', 'dsh-tool-executor-native')] : []),
    { ...row('web', 'dsh-web', { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' }),
      inject: ['candidateExistingDependency'] },
    row('tool-web', 'dsh-tool-web', { search: true, fetch: true, searchTimeoutMs: 30_000, fetchTimeoutMs: 30_000 }),
    { id: 'fixture-providers', name: fixtureName + '/providers' },
  ] }];
}

export function prepareHostTransitionProfile({ directory, inspected, dependenciesRoot, endpoint, versions }) {
  const profile = join(directory, 'dsh-home/profiles/candidate'), modules = join(profile, 'node_modules');
  const product = join(modules, 'dsh-grok-search'), fixture = join(modules, fixtureName);
  mkdirSync(product, { recursive: true, mode: 0o700 });
  const productFiles = {};
  for (const [name, bytes] of inspected.files) {
    insist(!name.split('/').includes('node_modules'), 'HOST_TRANSITION_PACKAGED_DEPENDENCIES');
    const path = confinedPath(product, name, { allowMissing: true });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    productFiles[name] = sha256(bytes);
  }
  const dependencies = copyDependencies(dependenciesRoot, modules, inspected.manifest.dependencies ?? {});
  mkdirSync(fixture, { mode: 0o700 });
  writeFileSync(join(fixture, 'fixture.mjs'), fixtureSource, { flag: 'wx' });
  for (const label of ['context', 'providers']) {
    writeFileSync(join(fixture, label + '.mjs'),
      `export { apply${label === 'context' ? 'Context' : 'Providers'} as apply } from './fixture.mjs';\n`
      + `export const name = 'host-transition-${label}';\n`
      + `export const inject = ${JSON.stringify(label === 'providers' ? ['web'] : [])};\n`, { flag: 'wx' });
  }
  json(join(fixture, 'package.json'), {
    name: fixtureName, version: '0.0.0', type: 'module', private: true,
    exports: { './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml',
      './context': './context.mjs', './providers': './providers.mjs' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });
  const fixtureFiles = Object.fromEntries(['package.json', 'fixture.mjs', 'context.mjs', 'providers.mjs']
    .map(name => [name, sha256(boundedBytes(join(fixture, name)))]));
  json(join(profile, 'package.json'), { name: 'compatibility-transition-profile', version: '0.0.0', private: true, type: 'module', dependencies: {
    'dsh-grok-search': inspected.manifest.version, [fixtureName]: '0.0.0',
  }, dsh: { profile: { bundles } } });
  const config = prepareCompatibilitySmoke({ directory, profile, endpoint });
  json(join(profile, 'cordis.patch.yml'), [{ id: 'grok-search', config }]);
  // Synthetic prior notifications exercise retention, never user consent.
  json(join(profile, 'grok-search/compatibility-state.json'), { schemaVersion: 1, generation: 1,
    pairs: [...new Set(versions)].map(hostVersion => ({
      hostVersion, pluginVersion: inspected.manifest.version, confirmed: false, notified: true,
    })) });
  return { profile, product, fixture, productFiles, fixtureFiles, dependencies };
}

function environment(directory, desktop) {
  const value = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[name]) value[name] = process.env[name];
  const systemPath = process.platform === 'win32' ? join(value.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin';
  value.PATH = dirname(process.execPath) + delimiter + systemPath;
  for (const [key, leaf] of Object.entries({ HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata',
    LOCALAPPDATA: 'localappdata', TMP: 'tmp', TEMP: 'tmp', TMPDIR: 'tmp',
    XDG_CONFIG_HOME: 'xdg-config', XDG_CACHE_HOME: 'xdg-cache', XDG_DATA_HOME: 'xdg-data', DSH_HOME: 'dsh-home' })) {
    value[key] = join(directory, leaf); mkdirSync(value[key], { recursive: true, mode: 0o700 });
  }
  value.DSH_TELEMETRY_DISABLED = '1';
  if (desktop) value.ELECTRON_RUN_AS_NODE = '1';
  return value;
}

function configurationSnapshot(profile) {
  return Object.fromEntries(retainedFiles.map(name => [name, sha256(boundedBytes(confinedPath(profile, name)))]));
}

export function controlIntentProjection(envelope) {
  const intent = envelope?.intent, acquisition = intent?.acquisition;
  insist(envelope?.format === 'dsh-grok-search/control-intent' && envelope.schemaVersion === 1
    && Number.isSafeInteger(envelope.revision) && envelope.revision > 0 && intent?.schemaVersion === 1
    && intent.policy === 'required' && intent.release === null && !intent.pause?.confirmed
    && !intent.recovery && !intent.releaseCompletion && acquisition?.historicReleaseCommitted === false
    && acquisition?.userClickObserved === false && acquisition.authorSearchProvider === 'candidate-original'
    && acquisition.authorSearchProviderPresent === true && acquisition.authorFetchProvider === 'candidate-fetch'
    && acquisition.source === 'current-selected-search-bundle' && acquisition.searchBundle === 'dsh-grok-search'
    && intent.lease?.provider === 'grok-search', 'HOST_TRANSITION_CONTROL_INTENT');
  same(intent.acquiredSelection, bundles, 'HOST_TRANSITION_CONTROL_SELECTION');
  same(acquisition.selectedBundles, bundles, 'HOST_TRANSITION_CONTROL_SELECTION');
  return { policy: intent.policy, release: intent.release, acquiredSelection: intent.acquiredSelection,
    authorSearchProvider: acquisition.authorSearchProvider, authorSearchProviderPresent: acquisition.authorSearchProviderPresent,
    authorFetchProvider: acquisition.authorFetchProvider, authorInjectSha256: requireSha256(acquisition.authorInjectSha256),
    selectionSha256: requireSha256(acquisition.selectionSha256), searchBundle: acquisition.searchBundle };
}

export async function readTransitionControl(profile, product) {
  const { createControlIntentStore } = await import(pathToFileURL(join(product, 'src/core/control-intent-store.mjs')).href);
  const directory = join(profile, 'control-intent.records');
  const store = createControlIntentStore({ directory, legacyPath: join(profile, 'control-intent.fixture.json'),
    trustedRoot: profile, autoMaintain: false });
  const head = store.read();
  if (head === null) return null;
  const intent = controlIntentProjection(head), history = [];
  insist(intent.selectionSha256 === sha256(boundedBytes(confinedPath(profile, 'package.json'))),
    'HOST_TRANSITION_CONTROL_SELECTION');
  insist(head.revision <= 32, 'HOST_TRANSITION_HISTORY_LIMIT');
  const checkpointPath = join(directory, 'checkpoint.json');
  const checkpoint = existsSync(checkpointPath) ? readJsonReceipt(confinedPath(directory, 'checkpoint.json')) : null;
  let previousSha256 = null, last;
  for (let revision = 1; revision <= head.revision; revision++) {
    const name = `v${String(revision).padStart(12, '0')}.json`;
    let bytes;
    if (existsSync(join(directory, name))) bytes = boundedBytes(confinedPath(directory, name));
    else if (checkpoint?.revision === revision) {
      bytes = Buffer.from(checkpoint.envelopeBase64, 'base64');
      insist(sha256(bytes) === checkpoint.envelopeSha256, 'HOST_TRANSITION_HISTORY_CHANGED');
    } else {
      const relativePath = checkpoint && revision <= checkpoint.initialArchive.headRevision
        ? `legacy-archives/${checkpoint.initialArchive.name}/${name}` : 'sealed/' + name;
      bytes = boundedBytes(confinedPath(directory, relativePath));
    }
    const record = JSON.parse(bytes.toString('utf8'));
    insist(record.format === 'dsh-grok-search/control-intent' && record.schemaVersion === 1
      && record.revision === revision && record.previousSha256 === previousSha256, 'HOST_TRANSITION_HISTORY_CHANGED');
    previousSha256 = sha256(bytes); history.push({ revision, sha256: previousSha256 }); last = record;
  }
  same(last, head, 'HOST_TRANSITION_CONTROL_READBACK');
  insist(store.inspectStorage().headSha256 === previousSha256, 'HOST_TRANSITION_CONTROL_READBACK');
  return { revision: head.revision, sha256: previousSha256, intent, history };
}

export function assertTransitionRetention(previous, next, { requireControl = true } = {}) {
  same(next?.configuration, previous?.configuration, 'HOST_TRANSITION_CONFIGURATION_CHANGED');
  if (!requireControl && next?.control === null && previous?.control === null) return;
  insist(next?.control && Number.isSafeInteger(next.control.revision) && next.control.revision > 0
    && next.control.history?.length === next.control.revision, 'HOST_TRANSITION_CONTROL_MISSING');
  if (previous?.control) {
    insist(next.control.revision >= previous.control.revision, 'HOST_TRANSITION_CONTROL_REWOUND');
    same(next.control.intent, previous.control.intent, 'HOST_TRANSITION_CONTROL_CHANGED');
    same(next.control.history.slice(0, previous.control.history.length), previous.control.history,
      'HOST_TRANSITION_HISTORY_CHANGED');
  }
}

async function until(check, code, timeout = 30000) {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    insist(performance.now() < deadline, code);
    await new Promise(done => setTimeout(done, 25));
  }
}

async function within(promise, timeout = 30000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('HOST_TRANSITION_TIMEOUT'), { code: 'HOST_TRANSITION_TIMEOUT' })), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

function activeProduct(ctx) {
  const entries = [...ctx.get('loader').entries()].filter(entry => entry.options.id === 'grok-search');
  if (entries.length !== 1) return false;
  const entry = entries[0], fiber = entry.fiber?.ctx?.fiber ?? entry.fiber;
  return entry.options.name === 'dsh-grok-search' && entry.options.disabled !== true && Boolean(fiber?.uid)
    && fiber.state === 2 && !fiber.error;
}

export async function runHostTransitionWorker(input) {
  const result = { schemaVersion: 1, scope, runId: input?.runId, index: input?.index, passed: false, code: null,
    realCredentialsUsed: false, originalProviderSynthetic: true, officialSearchCalls: 0, cleanupVerified: false };
  const trace = { calls: { original: 0, fetch: 0 }, disposed: 0 };
  let boot, starting, core, compatibility, web;
  try {
    const directory = ordinaryDirectory(input.directory), profile = confinedPath(directory, 'dsh-home/profiles/candidate');
    const product = confinedPath(profile, 'node_modules/dsh-grok-search');
    insist(/^[0-9a-f-]{36}$/.test(input.runId) && [0, 1, 2].includes(input.index), 'HOST_TRANSITION_WORKER_INPUT');
    const owner = readJsonReceipt(confinedPath(directory, 'transition-owner.json'), requireSha256(input.ownerSha256));
    insist(owner.kind === 'isolated-host-transition-owner' && owner.runId === input.runId
      && owner.versions?.[input.index] === input.hostVersion && owner.pluginVersion === input.pluginVersion,
    'HOST_TRANSITION_WORKER_INPUT');
    insist(process.env.DSH_HOME === join(directory, 'dsh-home'), 'HOST_TRANSITION_ENV_UNSAFE');
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR',
      'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
      insist(typeof process.env[key] === 'string', 'HOST_TRANSITION_ENV_UNSAFE');
      confinedPath(directory, relative(directory, process.env[key]).split(sep).join('/'));
    }
    insist(!Object.entries(process.env).some(([name, value]) => value
      && /^(?:(?:GROK|TAVILY|EXA|TINYFISH|FIRECRAWL|OPENAI|ANTHROPIC|DEEPSEEK)_|GH_TOKEN$|GITHUB_TOKEN$|NODE_OPTIONS$|NODE_PATH$|(?:HTTP|HTTPS|ALL)_PROXY$)/i.test(name)),
    'HOST_TRANSITION_ENV_UNSAFE');
    const hostRoot = absolute(input.hostRoot);
    const runtimeRoot = existsSync(join(hostRoot, 'dsh/package.json')) ? join(hostRoot, 'dsh') : hostRoot;
    const host = readJsonReceipt(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json'));
    const manifest = readJsonReceipt(join(product, 'package.json'));
    insist(host.name === '@deepseek-ai/dsh' && host.version === input.hostVersion
      && manifest.name === 'dsh-grok-search' && manifest.version === input.pluginVersion,
    'HOST_TRANSITION_RUNTIME_IDENTITY');
    insist(!existsSync(join(profile, 'node_modules/@deepseek-ai'))
      && !existsSync(join(product, 'node_modules/@deepseek-ai')), 'HOST_TRANSITION_HOST_COPY');
    const modern = existsSync(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-tool-executor-native/package.json'));
    insist(modern === input.modern, 'HOST_TRANSITION_RUNTIME_IDENTITY');
    result.hostVersion = host.version; result.pluginVersion = manifest.version;
    result.before = { configuration: configurationSnapshot(profile), control: await readTransitionControl(profile, product) };
    globalThis.__DSH_HOST_TRANSITION__ = trace;
    const imp = (name, file = 'lib/index.js') => import(pathToFileURL(join(runtimeRoot, 'node_modules/@deepseek-ai', name, file)).href);
    const appBoot = await imp('dsh-app-boot'), { runProfile } = await imp('dsh', 'lib/profile-boot.js');
    starting = runProfile({ environment: appBoot.loadLayeredEnv('dsh', directory),
      profile: 'candidate', patchFiles: [], args: [] }).then(value => { boot = value; return value; });
    await within(starting, 45000);
    insist(resolve(boot.ctx.get('profileContext')?.dir ?? '') === profile, 'HOST_TRANSITION_PROFILE_MISMATCH');
    await until(() => activeProduct(boot.ctx), 'HOST_TRANSITION_PACKAGE_NOT_LOADED');
    await until(() => compatibilitySmokeReady(snapshotCompatibility(boot.ctx, trace), { requireReport: true }),
      'HOST_TRANSITION_CORE_NOT_READY');
    core = boot.ctx.get('grokSearchCore'); compatibility = boot.ctx.get('grokSearchCompatibility'); web = boot.ctx.get('web');
    const report = compatibility.report();
    insist(report.hostVersion === input.hostVersion && report.pluginVersion === input.pluginVersion
      && report.minimumAdmitted === true && report.confirmed === false && report.notified === true
      && [null, 'COMPATIBILITY_OPTIONAL_PENDING', 'COMPATIBILITY_OPTIONAL_UNAVAILABLE'].includes(report.code),
    'HOST_TRANSITION_REPORT_IDENTITY');
    same(controlIntentProjection(boot.ctx.get('grokSearchControl')?.snapshot().recordEnvelope),
      (await readTransitionControl(profile, product)).intent, 'HOST_TRANSITION_CONTROL_READBACK');
    const direct = await within(web.search({ query: queryFor(input.runId, input.index, 'direct'), maxResults: 2 }));
    const native = await within(invokeCompatibilitySearch(boot.ctx, {
      queries: ['native-1', 'native-2'].map(suffix => queryFor(input.runId, input.index, suffix)), modern,
    }));
    insist(JSON.stringify(direct).includes(sourceUrl(input.runId, input.index, 'direct')) && native?.isError === false
      && ['native-1', 'native-2'].every(suffix => JSON.stringify(native).includes(sourceUrl(input.runId, input.index, suffix)))
      && trace.calls.original === 0 && trace.calls.fetch === 0, 'HOST_TRANSITION_SEARCH_FAILED');
    await until(() => { const value = snapshotCompatibility(boot.ctx, trace); return idle(value.core) && idle(value.core.routeExecutor); },
      'HOST_TRANSITION_NOT_IDLE', 5000);
    result.observations = { directSearch: true, nativeQueries: 2, modern, ready: snapshotCompatibility(boot.ctx, trace) };
  } catch (error) { result.code = codeOf(error); }
  finally {
    try {
      if (starting && !boot) await within(starting, 5000).catch(() => {});
      if (boot) {
        core ??= boot.ctx.get('grokSearchCore'); compatibility ??= boot.ctx.get('grokSearchCompatibility'); web ??= boot.ctx.get('web');
        await within(boot.shutdown.shutdown(0), 15000);
        const final = core?.snapshot();
        result.cleanupVerified = trace.disposed === 1 && idle(final) && idle(final?.routeExecutor)
          && final.stopping === true && final.routeExecutor.stopping === true && !final.session?.connected
          && !final.session?.active && compatibility?.report().phase === 'stopped' && !web?.searchProviders?.has('grok-search');
        const profile = join(input.directory, 'dsh-home/profiles/candidate');
        result.after = { configuration: configurationSnapshot(profile),
          control: await readTransitionControl(profile, join(profile, 'node_modules/dsh-grok-search')) };
        assertTransitionRetention(result.before, result.after);
      }
    } catch (error) { result.code ??= codeOf(error); result.cleanupVerified = false; }
    delete globalThis.__DSH_HOST_TRANSITION__;
    result.officialSearchCalls = trace.calls.original;
    result.passed = result.code === null && result.cleanupVerified && Boolean(result.observations)
      && result.officialSearchCalls === 0 && trace.calls.fetch === 0;
    if (!result.passed) result.code ??= 'HOST_TRANSITION_CLEANUP_FAILED';
  }
  return result;
}

async function startUpstream(runId) {
  const state = { index: null, requests: [], unexpected: 0, active: 0, closed: false };
  const sockets = new Set();
  const server = createServer((request, response) => {
    let bytes = '';
    request.on('error', () => {}); response.on('error', () => {});
    request.on('data', chunk => { bytes += chunk; if (Buffer.byteLength(bytes) > 8192) { state.unexpected++; request.destroy(); } });
    request.on('end', () => {
      let body;
      try { body = JSON.parse(bytes); } catch {}
      const suffix = ['direct', 'native-1', 'native-2'].find(value => body?.query === queryFor(runId, state.index, value));
      if (request.method !== 'POST' || request.url !== '/search' || !suffix
        || request.headers.authorization !== 'Bearer compatibility-smoke-synthetic-key'
        || state.requests.some(row => row.index === state.index && row.suffix === suffix)) {
        state.unexpected++; response.writeHead(400); response.end('{}'); return;
      }
      state.requests.push({ index: state.index, suffix }); state.active++;
      response.once('close', () => { state.active--; });
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ results: [{ url: sourceUrl(runId, state.index, suffix),
        title: 'Synthetic host transition source', content: 'Isolated loopback response.', score: 1 }], usage: { credits: 1 } }));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { state.unexpected++; socket.destroy(); });
  await new Promise((done, fail) => {
    server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); });
  });
  let closing;
  return { endpoint: `http://127.0.0.1:${server.address().port}`, state,
    async close() {
      closing ??= new Promise((done, fail) => {
        server.close(error => error ? fail(error) : done());
        for (const socket of sockets) socket.destroy();
      });
      await closing;
      state.closed = true;
    } };
}

export function validateHostTransitionExecution(execution, expected, before, after) {
  insist(!execution?.verificationFailure, execution?.verificationFailure);
  insist(execution?.code === 0 && execution.signal === null && execution.failure === null, 'HOST_TRANSITION_ABNORMAL_EXIT');
  const messages = execution.stdout.split(/\r?\n/).filter(line => line.startsWith(HOST_TRANSITION_MARKER));
  insist(messages.length === 1, 'HOST_TRANSITION_RECEIPT_MISSING');
  let result;
  try { result = JSON.parse(messages[0].slice(HOST_TRANSITION_MARKER.length)); }
  catch { insist(false, 'HOST_TRANSITION_RECEIPT_INVALID'); }
  insist(result.schemaVersion === 1 && result.scope === scope && result.runId === expected.runId && result.index === expected.index
    && result.hostVersion === expected.hostVersion && result.pluginVersion === expected.pluginVersion,
  'HOST_TRANSITION_RECEIPT_IDENTITY');
  insist(result.passed === true && result.code === null && result.cleanupVerified === true
    && result.realCredentialsUsed === false && result.originalProviderSynthetic === true
    && result.officialSearchCalls === 0 && result.observations?.directSearch === true
    && result.observations?.nativeQueries === 2 && result.observations.modern === expected.modern,
  'HOST_TRANSITION_RECEIPT_FAILED');
  const ready = result.observations.ready;
  insist(compatibilitySmokeReady(ready, { requireReport: true }) && ready.officialSearchCalls === 0
    && ready.compatibility.hostVersion === expected.hostVersion && ready.compatibility.pluginVersion === expected.pluginVersion
    && ready.compatibility.minimumAdmitted === true && ready.runtimeWeb.fetchProviderId === 'candidate-fetch'
    && idle(ready.core) && idle(ready.core.routeExecutor) && !ready.core.sessionConnected
    && !ready.core.sessionActive && !ready.core.childStarted, 'HOST_TRANSITION_RECEIPT_FAILED');
  same(result.before, before, 'HOST_TRANSITION_BEFORE_MISMATCH');
  same(result.after, after, 'HOST_TRANSITION_AFTER_MISMATCH');
  assertTransitionRetention(before, after);
  return result;
}

// The injected executor is only for unit tests; it cannot produce a real-host receipt.
export async function runHostTransitionSequence({ hosts, runId, pluginVersion, snapshot, execute, record = () => {} }) {
  const rows = [], versions = validateHostTransitionPair(hosts[0].asset, hosts[1].asset);
  let previous = await snapshot();
  for (let index = 0; index < versions.length; index++) {
    const host = hosts[index === 1 ? 1 : 0], before = await snapshot();
    same(before, previous, 'HOST_TRANSITION_BETWEEN_STAGES_CHANGED');
    const expected = { runId, index, hostVersion: versions[index], pluginVersion, modern: host.modern };
    const execution = await execute(host, expected);
    const direction = index === 0 ? 'baseline' : semver.gt(versions[index], versions[index - 1]) ? 'upgrade' : 'downgrade';
    let after, result;
    try {
      after = await snapshot();
      result = validateHostTransitionExecution(execution, expected, before, after);
    } catch (error) {
      record(index, { execution, before, after: after ?? null, validation: { passed: false, direction, code: codeOf(error) } });
      throw error;
    }
    const row = { index, hostVersion: versions[index], direction,
      exitCode: execution.code, signal: execution.signal, normalExit: true, passed: true, result };
    record(index, { execution, before, after, validation: { passed: true, direction, code: null } });
    rows.push(row); previous = after;
  }
  return { scope: 'synthetic-unit-host-transition-sequence', realHostValidated: false, passed: true, rows };
}

export async function runCompatibilityHostTransitions(options) {
  options.signal?.throwIfAborted();
  const directory = absolute(options.outputRoot);
  ordinaryDirectory(dirname(directory));
  insist(!lstatSync(directory, { throwIfNoEntry: false }), 'HOST_TRANSITION_OUTPUT_EXISTS');
  requireSha256(options.packageSha256);
  const packagePath = absolute(options.packagePath);
  insist(await hashFile(packagePath, { limit: 32 * 1024 * 1024 }) === options.packageSha256, 'HOST_TRANSITION_PACKAGE_CHANGED');
  const packageBytes = boundedBytes(packagePath, 32 * 1024 * 1024);
  insist(sha256(packageBytes) === options.packageSha256, 'HOST_TRANSITION_PACKAGE_CHANGED');
  const inspected = inspectPackage(packageBytes);
  validateInstallManifest(inspected);
  insist(inspected.manifest.name === 'dsh-grok-search', 'HOST_TRANSITION_PACKAGE_IDENTITY');
  exactVersion(inspected.manifest.version);
  for (const file of ['src/core/control-intent-store.mjs', 'src/core/compatibility-state.mjs', 'src/core/runtime-compat.mjs']) {
    insist(inspected.files.has(file), 'HOST_TRANSITION_PACKAGE_CONTRACT_REQUIRED');
  }
  const hosts = ['from', 'to'].map(key => readHostTransitionRuntime({
    receiptPath: options[key + 'Receipt'], receiptSha256: options[key + 'ReceiptSha256'], root: options[key + 'Root'],
  }));
  const versions = validateHostTransitionPair(hosts[0].asset, hosts[1].asset);
  ordinaryDirectory(options.dependenciesRoot);
  mkdirSync(directory, { mode: 0o700 });
  const runId = randomUUID(), startedAt = new Date().toISOString();
  const receipt = { schemaVersion: 1, kind: 'same-plugin-host-transition', scope, runId, startedAt,
    productSha256: options.packageSha256, pluginVersion: inspected.manifest.version, versions,
    verifierSha256: await hashFile(script), passed: false, code: null, cleanupVerified: false,
    realHostValidated: false, guiValidated: false, installationValidated: false, sessionHistoryValidated: false, fullAcceptanceGates: [],
    realCredentialsUsed: false, originalProviderSynthetic: true, officialSearchCalls: null,
    controlIntentScenario: 'selected-required-no-explicit-release',
    compatibilitySeed: 'synthetic-notification-only-no-confirmation', stages: [],
    hosts: hosts.map(({ asset, receiptSha256, files, provenance }) => ({ asset, receiptSha256, files,
      ...(provenance ? { provenance } : {}) })) };
  let upstream, setup;
  try {
    receipt.verifierFiles = Object.fromEntries(await Promise.all(HOST_TRANSITION_VERIFIER_PATHS.map(async path =>
      [path, await hashFile(join(project, path))])));
    json(join(directory, 'transition-owner.json'), { kind: 'isolated-host-transition-owner', runId, versions,
      pluginVersion: inspected.manifest.version, packageSha256: options.packageSha256 });
    const ownerSha256 = await hashFile(join(directory, 'transition-owner.json'));
    upstream = await startUpstream(runId);
    setup = prepareHostTransitionProfile({ directory, inspected, dependenciesRoot: options.dependenciesRoot, endpoint: upstream.endpoint, versions });
    receipt.dependencyPackages = setup.dependencies.packages;
    receipt.dependencyFilesSha256 = sha256(JSON.stringify(setup.dependencies.files));
    receipt.productFilesSha256 = sha256(JSON.stringify(setup.productFiles));
    receipt.fixtureFilesSha256 = sha256(JSON.stringify(setup.fixtureFiles));
    const snapshot = async () => {
      insist(await hashFile(packagePath, { limit: 32 * 1024 * 1024 }) === options.packageSha256, 'HOST_TRANSITION_PACKAGE_CHANGED');
      for (const [name, expected] of Object.entries(setup.productFiles)) {
        insist(sha256(boundedBytes(confinedPath(setup.product, name), 32 * 1024 * 1024)) === expected, 'HOST_TRANSITION_PRODUCT_CHANGED');
      }
      for (const [name, expected] of Object.entries(setup.dependencies.files)) {
        insist(sha256(boundedBytes(confinedPath(join(setup.profile, 'node_modules'), name), 32 * 1024 * 1024)) === expected,
          'HOST_TRANSITION_DEPENDENCIES_CHANGED');
      }
      for (const [name, expected] of Object.entries(setup.fixtureFiles)) {
        insist(sha256(boundedBytes(confinedPath(setup.fixture, name))) === expected, 'HOST_TRANSITION_FIXTURE_CHANGED');
      }
      return { configuration: configurationSnapshot(setup.profile), control: await readTransitionControl(setup.profile, setup.product) };
    };
    await runHostTransitionSequence({ hosts, runId, pluginVersion: inspected.manifest.version, snapshot,
      record(index, value) {
        json(join(directory, `stage-${index}.json`), value);
        const normalExit = value.execution.code === 0 && value.execution.signal === null && value.execution.failure === null;
        receipt.stages.push({ index, hostVersion: versions[index], ...value.validation, normalExit,
          exitCode: value.execution.code, signal: value.execution.signal,
          fixturePatchSha256: sha256(JSON.stringify(fixturePatch(hosts[index === 1 ? 1 : 0].modern)) + '\n'),
          receipt: { path: `stage-${index}.json`, sha256: sha256(boundedBytes(join(directory, `stage-${index}.json`), 16 * 1024 * 1024)) } });
      },
      async execute(host, expected) {
        options.signal?.throwIfAborted();
        same(readHostTransitionRuntime(host), host, 'HOST_TRANSITION_RUNTIME_CHANGED');
        upstream.state.index = expected.index;
        const patchPath = confinedPath(directory, relative(directory, join(setup.fixture, 'cordis.patch.yml')).split(sep).join('/'),
          { allowMissing: true });
        writeFileSync(patchPath, JSON.stringify(fixturePatch(host.modern)) + '\n', { mode: 0o600 });
        const request = { ...expected, directory, hostRoot: host.hostRoot, ownerSha256 };
        json(join(directory, `worker-${expected.index}.json`), request);
        const execution = await runBoundedCommand(host.executable, ['--expose-internals', script, '--worker',
          join(directory, `worker-${expected.index}.json`)], {
          cwd: directory, env: environment(directory, host.asset.lane !== 'linux-cli'), signal: options.signal,
          timeout: 120000, limit: 4 * 1024 * 1024,
        });
        try {
          insist(await hashFile(patchPath) === sha256(JSON.stringify(fixturePatch(host.modern)) + '\n'),
            'HOST_TRANSITION_FIXTURE_CHANGED');
          same(readHostTransitionRuntime(host), host, 'HOST_TRANSITION_RUNTIME_CHANGED');
          await until(() => upstream.state.active === 0, 'HOST_TRANSITION_UPSTREAM_NOT_IDLE', 3000);
          insist(upstream.state.unexpected === 0 && upstream.state.requests.filter(row => row.index === expected.index).length === 3,
            'HOST_TRANSITION_UPSTREAM_FAILED');
        } catch (error) { execution.verificationFailure = codeOf(error); }
        return execution;
      },
    });
    receipt.officialSearchCalls = 0;
    for (const host of hosts) same(readHostTransitionRuntime(host), host, 'HOST_TRANSITION_RUNTIME_CHANGED');
    receipt.retained = await snapshot();
    receipt.passed = true;
  } catch (error) { receipt.code = codeOf(error); }
  finally {
    try {
      if (upstream) {
        const drained = upstream.state.active === 0;
        await within(upstream.close(), 5000);
        receipt.upstream = upstream.state;
        receipt.cleanupVerified = drained && upstream.state.closed && upstream.state.active === 0 && upstream.state.unexpected === 0
          && receipt.stages.length === 3 && receipt.stages.every(row => row.passed && row.normalExit);
      }
      insist(await hashFile(script) === receipt.verifierSha256, 'HOST_TRANSITION_VERIFIER_CHANGED');
      for (const [path, expected] of Object.entries(receipt.verifierFiles ?? {})) {
        insist(await hashFile(join(project, path)) === expected, 'HOST_TRANSITION_VERIFIER_CHANGED');
      }
    } catch (error) { receipt.code ??= codeOf(error); receipt.cleanupVerified = false; }
    if (upstream && !upstream.state.closed) await upstream.close().catch(() => {});
    receipt.passed = receipt.passed && receipt.code === null && receipt.cleanupVerified;
    receipt.realHostValidated = receipt.passed;
    receipt.finishedAt = new Date().toISOString();
    json(join(directory, 'host-transitions.json'), receipt);
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const controller = new AbortController();
  const stop = () => controller.abort(Object.assign(new Error('HOST_TRANSITION_CANCELLED'), { code: 'HOST_TRANSITION_CANCELLED' }));
  if (process.argv[2] !== '--worker') { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
  try {
    const result = process.argv[2] === '--worker'
      ? await runHostTransitionWorker(readJsonReceipt(absolute(process.argv[3])))
      : await runCompatibilityHostTransitions({ ...parseHostTransitionArgs(process.argv.slice(2)), signal: controller.signal });
    process.stdout.write(HOST_TRANSITION_MARKER + JSON.stringify(result) + '\n');
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(HOST_TRANSITION_MARKER + JSON.stringify({ passed: false, code: codeOf(error) }) + '\n');
    process.exitCode = 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
