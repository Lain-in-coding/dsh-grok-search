import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export const PROGRAM_MARKER = 'DSH_COMPATIBILITY_PROGRAM=';
export const PROGRAM_CASE_MARKER = 'DSH_COMPATIBILITY_PROGRAM_CASE=';
export const PROGRAM_CASE_IDS = Object.freeze([
  'managed-grok-child-cancel-and-reap',
  'pending-program-preparation-cancel',
  'program-download-failure-and-repair',
]);
export const PROGRAM_VERSION = '0.1.26';
export const PROGRAM_SENTINEL = 'compatibility-program-synthetic-not-a-real-key';
export const PROGRAM_SOURCE = 'https://compatibility-program.invalid/synthetic-source';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const insist = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
export const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '')
  ? error.code : 'COMPATIBILITY_PROGRAM_FAILED';

export function localAbsolute(path) {
  insist(typeof path === 'string' && isAbsolute(path) && !/[\0\r\n]/.test(path) && !/^[\\/]{2}/.test(path),
    'COMPATIBILITY_PROGRAM_PATH_INVALID');
  return resolve(path);
}

export function contained(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export function programCaseDirectory(root, id, variant) {
  const name = id === PROGRAM_CASE_IDS[0] && variant === null ? 'm'
    : id === PROGRAM_CASE_IDS[1] && variant === 'disable' ? 'pd'
      : id === PROGRAM_CASE_IDS[1] && variant === 'dispose' ? 'px'
        : id === PROGRAM_CASE_IDS[2] && variant === null ? 'r' : null;
  insist(name, 'COMPATIBILITY_PROGRAM_CASE_INVALID');
  return join(root, name);
}

export function parseProgramArguments(argv) {
  insist(Array.isArray(argv) && argv.length >= 10, 'COMPATIBILITY_PROGRAM_ARGUMENTS_REQUIRED');
  const [hostRoot, outputRoot, productDir, productSha256, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    insist(['--product-package', '--grok-program', '--grok-sha256', '--case', '--variant'].includes(flag)
      && typeof value === 'string' && value.length > 0 && !value.startsWith('--')
      && !Object.hasOwn(options, flag), 'COMPATIBILITY_PROGRAM_ARGUMENTS_INVALID');
    options[flag] = value;
  }
  const hash = value => insist(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    'COMPATIBILITY_PROGRAM_HASH_REQUIRED');
  hash(productSha256); hash(options['--grok-sha256']);
  const caseId = options['--case'] ?? null, variant = options['--variant'] ?? null;
  insist(caseId === null || PROGRAM_CASE_IDS.includes(caseId), 'COMPATIBILITY_PROGRAM_CASE_INVALID');
  insist(caseId === PROGRAM_CASE_IDS[1] ? ['disable', 'dispose'].includes(variant) : variant === null,
    'COMPATIBILITY_PROGRAM_VARIANT_INVALID');
  return { hostRoot: localAbsolute(hostRoot), outputRoot: localAbsolute(outputRoot),
    productDir: localAbsolute(productDir), productSha256,
    productPackage: localAbsolute(options['--product-package']),
    grokProgram: localAbsolute(options['--grok-program']), grokSha256: options['--grok-sha256'], caseId, variant };
}

export function readRegular(path, { limit = 64 * 1024 * 1024, allowEmpty = false } = {}) {
  const stat = lstatSync(localAbsolute(path));
  insist(stat.isFile() && !stat.isSymbolicLink() && (allowEmpty || stat.size > 0) && stat.size <= limit,
    'COMPATIBILITY_PROGRAM_FILE_INVALID');
  return readFileSync(path);
}

export function packageFiles(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }), files = new Map();
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) { ended = true; break; }
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const octal = (start, length) => {
      const value = text(start, length).trim();
      insist(/^[0-7]+$/.test(value), 'COMPATIBILITY_PROGRAM_ARCHIVE_INVALID');
      return parseInt(value, 8);
    };
    const size = octal(124, 12), checksum = octal(148, 8);
    insist(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length
      && checksum === header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0),
    'COMPATIBILITY_PROGRAM_ARCHIVE_INVALID');
    const prefix = text(345, 155), name = (prefix ? prefix + '/' : '') + text(0, 100);
    const path = name.replace(/\/$/, ''), parts = path.split('/');
    insist(parts[0] === 'package' && parts.every(part => part && !['.', '..'].includes(part))
      && !/[\\:\0-\x1f]/.test(path) && path.length < 500 && files.size < 20_000,
    'COMPATIBILITY_PROGRAM_ARCHIVE_PATH');
    insist([0, 48, 53].includes(header[156]), 'COMPATIBILITY_PROGRAM_ARCHIVE_TYPE');
    if (header[156] !== 53) {
      const key = parts.slice(1).join('/');
      insist(key && !files.has(key), 'COMPATIBILITY_PROGRAM_ARCHIVE_INVALID');
      files.set(key, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    } else insist(size === 0, 'COMPATIBILITY_PROGRAM_ARCHIVE_INVALID');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  insist(ended && tar.subarray(offset).every(value => value === 0) && files.has('package.json'),
    'COMPATIBILITY_PROGRAM_ARCHIVE_INVALID');
  return files;
}

export function validateProgramInputs(input) {
  const parent = realpathSync(dirname(input.outputRoot)), outputRoot = join(parent, basename(input.outputRoot));
  insist(!existsSync(outputRoot), 'COMPATIBILITY_PROGRAM_OUTPUT_EXISTS');
  const productDir = realpathSync(input.productDir);
  insist(lstatSync(productDir).isDirectory(), 'COMPATIBILITY_PROGRAM_PRODUCT_INVALID');
  for (const protectedPath of [input.hostRoot, productDir, input.grokProgram, input.productPackage]) {
    insist(outputRoot !== resolve(protectedPath) && !contained(outputRoot, protectedPath)
      && !contained(protectedPath, outputRoot), 'COMPATIBILITY_PROGRAM_OUTPUT_OVERLAP');
  }
  const tarball = readRegular(input.productPackage), binary = readRegular(input.grokProgram);
  insist(digest(tarball) === input.productSha256 && digest(binary) === input.grokSha256,
    'COMPATIBILITY_PROGRAM_HASH_MISMATCH');
  const files = packageFiles(tarball), manifest = JSON.parse(files.get('package.json').toString('utf8'));
  insist(manifest.name === 'dsh-grok-search' && typeof manifest.version === 'string',
    'COMPATIBILITY_PROGRAM_PRODUCT_INVALID');
  for (const [path, bytes] of files) {
    const target = join(productDir, path);
    insist(contained(productDir, realpathSync(target)) && digest(readRegular(target, { allowEmpty: true })) === digest(bytes),
      'COMPATIBILITY_PROGRAM_PRODUCT_CHANGED');
  }
  const dependencyRoot = existsSync(join(productDir, 'node_modules')) ? realpathSync(join(productDir, 'node_modules'))
    : basename(dirname(productDir)) === 'node_modules' ? dirname(productDir) : null;
  insist(dependencyRoot && lstatSync(dependencyRoot).isDirectory(), 'COMPATIBILITY_PROGRAM_DEPENDENCIES_MISSING');
  for (const name of ['dsh', 'cordis', 'dsh-app-boot', 'dsh-web', 'schemastery', 'dsh-typert-protocol']) {
    insist(!existsSync(join(dependencyRoot, '@deepseek-ai', name)), 'COMPATIBILITY_PROGRAM_HOST_COPY_INSTALLED');
  }
  return { ...input, outputRoot, productDir, dependencyRoot, files, manifest, binary };
}

export function tarGzip(files) {
  const chunks = [];
  for (const [path, content] of files) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    insist(Buffer.byteLength(path) < 100, 'COMPATIBILITY_PROGRAM_ARCHIVE_PATH');
    header.write(path);
    const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    octal(0o700, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

export function platformArchive(binary, platform = process.platform, arch = process.arch) {
  const packages = { 'win32-x64': '@epsiekygrr_zedxx/grok-search-rs-win32-x64',
    'darwin-arm64': '@epsiekygrr_zedxx/grok-search-rs-darwin-universal',
    'linux-x64': '@epsiekygrr_zedxx/grok-search-rs-linux-x64' };
  const name = packages[`${platform}-${arch}`];
  insist(name, 'COMPATIBILITY_PROGRAM_PLATFORM_UNSUPPORTED');
  const filename = platform === 'win32' ? 'grok-search-rs.exe' : 'grok-search-rs';
  const archive = tarGzip([['package/package.json', JSON.stringify({
    name, version: PROGRAM_VERSION, os: [platform], cpu: [arch],
  })], ['package/bin/' + filename, binary]]);
  insist(archive.length <= 32 * 1024 * 1024, 'COMPATIBILITY_PROGRAM_ARCHIVE_TOO_LARGE');
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  const metadataUrls = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
    .map(origin => `${origin}/${encodeURIComponent(name)}/${PROGRAM_VERSION}`);
  const archiveUrl = 'https://registry.npmjs.org/compatibility-program/synthetic-0.1.26.tgz';
  return { archive, name, filename, integrity, metadataUrls, archiveUrl,
    metadata: { name, version: PROGRAM_VERSION, dist: { tarball: archiveUrl, integrity } } };
}

export function installerEndpoint(url, origin, archive) {
  if (archive.metadataUrls.includes(url)) return origin + '/registry/metadata';
  if (url === archive.archiveUrl) return origin + '/registry/archive';
  return null;
}

export function casePassed(id, observation) {
  const yes = (...keys) => keys.every(key => observation?.[key] === true);
  if (!observation || observation.orphanProcesses0 !== true || observation.configUnchanged !== true
    || observation.cacheSentinelUnchanged !== true || observation.unexpectedRequests !== 0) return false;
  if (id === PROGRAM_CASE_IDS[0]) return yes('childStarted', 'callerReasonPreserved', 'childReaped',
    'stdioClosed', 'upstreamDisconnectObserved', 'running0', 'queued0', 'recovered')
    && observation.programVersion === PROGRAM_VERSION && Number.isInteger(observation.cancelledCalls)
    && observation.cancelledCalls >= 2;
  if (id === PROGRAM_CASE_IDS[1]) return yes('preparationStarted', 'callerReasonPreserved', 'preparationSettled',
    'upstreamDisconnectObserved', 'lateCompletionAttempted', 'lateCompletionNotPublished')
    && observation.activeCacheCommitted === false && observation.programPhase === 'disposed';
  if (id === PROGRAM_CASE_IDS[2]) return yes('failureObserved', 'repairFailureObserved', 'failedRepairPreservedActive',
    'repairSucceeded', 'mcpHandshakeValidated', 'recovered')
    && observation.invalidCacheActivated === false && observation.failureCode === 'GROK_DOWNLOAD_HTTP'
    && typeof observation.repairedSha256 === 'string' && /^[a-f0-9]{64}$/.test(observation.repairedSha256);
  return false;
}
