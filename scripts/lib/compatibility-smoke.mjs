import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import semver from 'semver';
import { COMPATIBILITY_LANES, SMOKE_GATES, confinedPath, hashFile, validateCandidate } from './compatibility-evidence.mjs';
import { readAsar } from './asar.mjs';
import { assertDevelopmentFuseCompatibility, readElectronFuseWire } from '../deferred-release-desktop-prepare.mjs';
import { runBoundedCommand as command } from './compatibility-process.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marker = 'DSH_COMPATIBILITY_SMOKE=';
const maxEntries = 50_000, maxExpansion = 3 * 1024 ** 3;
const archiveToolSha256 = 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95';
const insist = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const codeOf = error => /^COMPATIBILITY_[A-Z0-9_]+$/.test(error?.code ?? '')
  ? error.code : 'COMPATIBILITY_SMOKE_FAILED';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

export function archivePath(value, { windows = false } = {}) {
  insist(typeof value === 'string' && value.length > 0 && value.length <= 4096
    && Buffer.from(value).toString('utf8') === value
    && !/[\x00-\x1f\x7f:]/.test(value) && !/^[\\/]/.test(value)
    && (!windows || !/[<>"|?*]/.test(value)),
  'COMPATIBILITY_ARCHIVE_PATH_UNSAFE');
  const name = value.replaceAll('\\', '/').replace(/\/$/, '');
  const parts = name.split('/');
  insist(parts.every(part => part && part !== '.' && part !== '..'
    && (!windows || !/[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]) *(?:\.|$)/i.test(part))),
  'COMPATIBILITY_ARCHIVE_PATH_UNSAFE');
  return name;
}

function validateEntries(entries, { windows = false } = {}) {
  insist(entries.length > 0 && entries.length <= maxEntries, 'COMPATIBILITY_ARCHIVE_LIMIT');
  // Conservatively reject aliases even on a case-sensitive extraction volume.
  const pathKey = value => value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
  const seen = new Map();
  let size = 0;
  for (const entry of entries) {
    entry.path = archivePath(entry.path, { windows });
    const key = pathKey(entry.path);
    insist(!seen.has(key), 'COMPATIBILITY_ARCHIVE_DUPLICATE');
    seen.set(key, entry);
    insist(Number.isSafeInteger(entry.size) && entry.size >= 0, 'COMPATIBILITY_ARCHIVE_LIMIT');
    size += entry.size;
    insist(size <= maxExpansion, 'COMPATIBILITY_ARCHIVE_LIMIT');
    if (entry.link !== undefined) {
      insist(!windows && typeof entry.link === 'string' && entry.link.length > 0 && entry.link.length <= 4096
        && Buffer.from(entry.link).toString('utf8') === entry.link
        && !/[\x00-\x1f\x7f:\\]/.test(entry.link) && !entry.link.startsWith('/'),
      'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
    }
  }
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = seen.get(pathKey(parts.slice(0, index).join('/')));
      insist(!parent || parent.directory && parent.link === undefined, 'COMPATIBILITY_ARCHIVE_PATH_CONFLICT');
    }
  }
  let steps = 0;
  for (const entry of entries) {
    if (entry.link === undefined) continue;
    let pending = [...entry.path.split('/').slice(0, -1), ...entry.link.split('/')], index = 0, hops = 0;
    const resolved = [];
    while (index < pending.length) {
      insist(++steps <= 2_000_000, 'COMPATIBILITY_ARCHIVE_LIMIT');
      const part = pending[index++];
      if (!part || part === '.') continue;
      if (part === '..') {
        insist(resolved.length > 0, 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
        resolved.pop();
        continue;
      }
      resolved.push(part);
      const path = resolved.join('/');
      insist(path.length <= 4096, 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
      const target = seen.get(pathKey(path));
      if (target?.link !== undefined) {
        insist(++hops <= 64, 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
        resolved.pop();
        // Expand a link before interpreting a later ".."; lexical normalize is unsafe here.
        pending = [...target.link.split('/'), ...pending.slice(index)];
        index = 0;
      } else {
        insist(!target || target.directory || index === pending.length, 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
      }
    }
  }
  return entries;
}

export function parseSevenZipListing(text) {
  insist(typeof text === 'string' && Buffer.byteLength(text) <= 16 * 1024 * 1024,
    'COMPATIBILITY_ARCHIVE_LIST_INVALID');
  const start = /^----------\r?$/m.exec(text);
  insist(start, 'COMPATIBILITY_ARCHIVE_LIST_INVALID');
  const sections = text.slice(start.index + start[0].length).split(/\r?\n\r?\n/)
    .map(section => section.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, ''))
    .filter(section => {
      if (!section.trim() || /^Warnings: [0-9]+$/.test(section.trim())) return false;
      insist(section.startsWith('Path = '), 'COMPATIBILITY_ARCHIVE_LIST_INVALID');
      return true;
    });
  const entries = sections.map(section => {
    const fields = Object.create(null);
    for (const line of section.split(/\r?\n/)) {
      const field = /^([^=\r\n]+) =(?: (.*))?$/.exec(line);
      insist(field && field[1] === field[1].trim() && !Object.hasOwn(fields, field[1]),
        'COMPATIBILITY_ARCHIVE_LIST_INVALID');
      fields[field[1]] = field[2] ?? '';
    }
    insist(!fields['Symbolic Link'] && !fields['Hard Link'] && fields.Encrypted !== '+',
      'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
    const directory = fields.Folder === '+' || Boolean(fields.Attributes?.includes('D'));
    insist(typeof fields.Size === 'string' && (/^\d+$/.test(fields.Size) || directory && fields.Size === ''),
      'COMPATIBILITY_ARCHIVE_LIST_INVALID');
    return { path: fields.Path, size: Number(fields.Size), directory };
  });
  return validateEntries(entries, { windows: true });
}

export function inspectZip(bytes) {
  insist(Buffer.isBuffer(bytes), 'COMPATIBILITY_ARCHIVE_LIST_INVALID');
  const crcTable = Uint32Array.from({ length: 256 }, (_value, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    return value >>> 0;
  });
  const crc32 = content => {
    let crc = 0xffffffff;
    for (const byte of content) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
  };
  const validateExtra = (start, length, name) => {
    const end = start + length, seen = new Set();
    for (let offset = start; offset < end;) {
      insist(offset + 4 <= end, 'COMPATIBILITY_ARCHIVE_LIST_INVALID');
      const id = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
      insist(offset + 4 + size <= end && !seen.has(id) && id !== 0x0001,
        'COMPATIBILITY_ARCHIVE_LIST_INVALID');
      seen.add(id);
      if (id === 0x7075) {
        // An alternate Unicode path must not give the extractor a different filename.
        insist(size >= 5 && bytes[offset + 4] === 1 && bytes.readUInt32LE(offset + 5) === crc32(name)
          && bytes.subarray(offset + 9, offset + 4 + size).equals(name), 'COMPATIBILITY_ARCHIVE_PATH_CONFLICT');
      }
      offset += 4 + size;
    }
  };
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
      end = index; break;
    }
  }
  insist(end >= 0 && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0,
    'COMPATIBILITY_ARCHIVE_LIST_INVALID');
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  insist(count < 65535 && offset + length === end && count <= maxEntries
    && bytes.readUInt16LE(end + 8) === count, 'COMPATIBILITY_ARCHIVE_LIMIT');
  const centralStart = offset, entries = [], ranges = [];
  for (let index = 0; index < count; index++) {
    insist(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50, 'COMPATIBILITY_ARCHIVE_LIST_INVALID');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30);
    const comment = bytes.readUInt16LE(offset + 32), mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const local = bytes.readUInt32LE(offset + 42);
    insist(!(flags & ~0x080e) && [0, 8].includes(method) && (method !== 0 || compressedSize === size)
      && size !== 0xffffffff && compressedSize !== 0xffffffff && bytes.readUInt16LE(offset + 34) === 0
      && local + 30 <= centralStart && offset + 46 + nameSize + extra + comment <= end,
    'COMPATIBILITY_ARCHIVE_LIST_INVALID');
    const pathBytes = bytes.subarray(offset + 46, offset + 46 + nameSize), path = pathBytes.toString('utf8');
    insist(Buffer.from(path).equals(pathBytes) && bytes.readUInt32LE(local) === 0x04034b50,
      'COMPATIBILITY_ARCHIVE_LIST_INVALID');
    insist(bytes.readUInt16LE(local + 4) === bytes.readUInt16LE(offset + 6)
      && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method,
    'COMPATIBILITY_ARCHIVE_HEADER_MISMATCH');
    for (const [localOffset, value] of [[14, crc], [18, compressedSize], [22, size]]) {
      const declared = bytes.readUInt32LE(local + localOffset);
      insist(declared === value || flags & 8 && declared === 0, 'COMPATIBILITY_ARCHIVE_HEADER_MISMATCH');
    }
    const localNameSize = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameSize + localExtra, dataEnd = dataStart + compressedSize;
    insist(dataEnd <= centralStart, 'COMPATIBILITY_ARCHIVE_LIMIT');
    const localName = bytes.subarray(local + 30, local + 30 + localNameSize);
    insist(localName.equals(pathBytes), 'COMPATIBILITY_ARCHIVE_PATH_CONFLICT');
    validateExtra(offset + 46 + nameSize, extra, pathBytes);
    validateExtra(local + 30 + localNameSize, localExtra, pathBytes);
    let recordEnd = dataEnd;
    if (flags & 8) {
      const matches = start => start + 12 <= centralStart && bytes.readUInt32LE(start) === crc
        && bytes.readUInt32LE(start + 4) === compressedSize && bytes.readUInt32LE(start + 8) === size;
      if (dataEnd + 16 <= centralStart && bytes.readUInt32LE(dataEnd) === 0x08074b50 && matches(dataEnd + 4)) {
        recordEnd += 16;
      } else {
        insist(matches(dataEnd), 'COMPATIBILITY_ARCHIVE_DESCRIPTOR_INVALID');
        recordEnd += 12;
      }
    }
    ranges.push({ start: local, end: recordEnd });
    const entry = { path, size, directory: path.endsWith('/') || (mode & 0xf000) === 0x4000 };
    if ((mode & 0xf000) === 0xa000) {
      insist(size > 0 && size <= 4096 && !entry.directory, 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
      const content = bytes.subarray(dataStart, dataStart + compressedSize);
      let target;
      try { target = method === 0 ? content : inflateRawSync(content, { maxOutputLength: 4096 }); }
      catch { insist(false, 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE'); }
      insist(target.length === size && crc32(target) === crc, 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
      entry.link = target.toString('utf8');
      insist(Buffer.from(entry.link).equals(target), 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
    } else insist([0, 0x8000, 0x4000].includes(mode & 0xf000), 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE');
    entries.push(entry);
    offset += 46 + nameSize + extra + comment;
  }
  insist(offset === bytes.readUInt32LE(end + 16) + length, 'COMPATIBILITY_ARCHIVE_LIST_INVALID');
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) {
    insist(ranges[index - 1].end <= ranges[index].start, 'COMPATIBILITY_ARCHIVE_PATH_CONFLICT');
  }
  return validateEntries(entries);
}

export function inspectPackage(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const entries = [], files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, size) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '').trim();
    const sizeText = text(124, 12), checksum = text(148, 8);
    insist(/^[0-7]+$/.test(sizeText) && /^[0-7]+$/.test(checksum), 'COMPATIBILITY_PACKAGE_INVALID');
    const size = parseInt(sizeText, 8), expected = parseInt(checksum, 8);
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    insist(sum === expected && offset + 512 + size <= tar.length, 'COMPATIBILITY_PACKAGE_INVALID');
    const type = header[156], prefix = text(345, 155), name = text(0, 100);
    insist([0, 48, 53].includes(type), 'COMPATIBILITY_PACKAGE_UNSUPPORTED_ENTRY');
    const path = archivePath(prefix ? prefix + '/' + name : name);
    insist(path === 'package' || path.startsWith('package/'), 'COMPATIBILITY_PACKAGE_INVALID');
    entries.push({ path, size, directory: type === 53 });
    if (type !== 53) files.set(path.slice(8), Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  validateEntries(entries);
  let manifest;
  try { manifest = JSON.parse(files.get('package.json').toString('utf8')); }
  catch { throw Object.assign(new Error('COMPATIBILITY_PACKAGE_INVALID'), { code: 'COMPATIBILITY_PACKAGE_INVALID' }); }
  return { manifest, files };
}

function newDirectory(root, name) {
  const path = confinedPath(root, name, { allowMissing: true });
  insist(!existsSync(path), 'COMPATIBILITY_SMOKE_DIRECTORY_EXISTS');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function verifyExtracted(root, entries) {
  const canonical = realpathSync(root);
  for (const entry of entries) {
    const path = resolve(root, entry.path), stat = lstatSync(path);
    const actual = realpathSync(path), rel = relative(canonical, actual);
    insist(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'COMPATIBILITY_ARCHIVE_PATH_UNSAFE');
    if (entry.link === undefined) {
      insist(!stat.isSymbolicLink() && (entry.directory ? stat.isDirectory() : stat.isFile() && stat.size === entry.size),
        'COMPATIBILITY_ARCHIVE_CONTENT_MISMATCH');
    } else insist(stat.isSymbolicLink(), 'COMPATIBILITY_ARCHIVE_CONTENT_MISMATCH');
  }
}

function npmEntry() {
  const candidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find(path => existsSync(path));
  insist(found, 'COMPATIBILITY_NPM_UNAVAILABLE');
  return found;
}

async function installPackage(tarball, root, env, signal) {
  json(join(root, 'package.json'), { name: 'compatibility-isolated-runtime', version: '0.0.0', private: true, type: 'module' });
  const config = join(root, 'npm-empty.ini'), global = join(root, 'npm-global-empty.ini');
  writeFileSync(config, '', { flag: 'wx' }); writeFileSync(global, '', { flag: 'wx' });
  return command(process.execPath, [npmEntry(), 'install', tarball, '--ignore-scripts', '--legacy-peer-deps=false',
    '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', '--userconfig', config, '--globalconfig', global,
    '--cache', join(root, 'npm-cache'), '--fetch-retries=1'], { cwd: root, env, signal, timeout: 600_000 });
}

export function validateInstallManifest({ manifest, files }) {
  const fileKeys = new Set([...files.keys()].map(path => path.normalize('NFC').toLowerCase()));
  for (const name of ['npm-shrinkwrap.json', 'package-lock.json', '.npmrc']) {
    insist(!fileKeys.has(name), 'COMPATIBILITY_PACKAGE_INSTALL_POLICY');
  }
  insist(!manifest.bundleDependencies && !manifest.bundledDependencies && !manifest.overrides,
    'COMPATIBILITY_PACKAGE_INSTALL_POLICY');
  const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      insist(packageName.test(name) && typeof range === 'string' && semver.validRange(range) !== null,
        'COMPATIBILITY_PACKAGE_DEPENDENCY_UNTRUSTED');
    }
  }
  return true;
}

async function prepareHost({ candidate, assetPath, outputRoot, environment, signal }) {
  const root = newDirectory(outputRoot, 'host');
  if (candidate.lane === 'linux-cli') {
    insist(semver.satisfies(process.versions.node, candidate.nodeRange || '*', { includePrerelease: true }),
      'COMPATIBILITY_NODE_UNSUPPORTED');
    const pkg = inspectPackage(readFileSync(assetPath));
    validateInstallManifest(pkg);
    insist(pkg.manifest.name === '@deepseek-ai/dsh' && pkg.manifest.version === candidate.version, 'COMPATIBILITY_HOST_IDENTITY');
    const result = await installPackage(assetPath, root, environment, signal);
    insist(result.code === 0 && !result.failure, result.failure || 'COMPATIBILITY_HOST_INSTALL_FAILED');
    return { executable: process.execPath, hostRoot: root, environment };
  }
  let entries, extracted;
  if (candidate.lane === 'windows-desktop') {
    const locations = [
      join(process.env.RUNNER_TEMP || outputRoot, 'dsh-compatibility-tools/node_modules/7zip-bin/win/x64/7za.exe'),
      join(project, 'artifacts/validation-tools/node_modules/7zip-bin/win/x64/7za.exe'),
    ];
    const tool = locations.find(path => existsSync(path));
    insist(tool && await hashFile(tool) === archiveToolSha256, 'COMPATIBILITY_ARCHIVE_TOOL_UNAVAILABLE');
    const listed = await command(tool, ['l', '-slt', '--', assetPath], { env: environment, signal });
    insist(listed.code === 0 && !listed.failure, listed.failure || 'COMPATIBILITY_ARCHIVE_LIST_INVALID');
    entries = parseSevenZipListing(listed.stdout);
    extracted = await command(tool, ['x', '-y', `-o${root}`, '--', assetPath], { env: environment, signal });
  } else {
    entries = inspectZip(readFileSync(assetPath));
    extracted = await command('/usr/bin/ditto', ['-x', '-k', assetPath, root], { env: environment, signal });
  }
  insist(extracted.code === 0 && !extracted.failure, extracted.failure || 'COMPATIBILITY_ARCHIVE_EXTRACT_FAILED');
  verifyExtracted(root, entries);
  const executable = candidate.lane === 'windows-desktop' ? join(root, 'DeepSeek Harness.exe')
    : join(root, 'DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness');
  const archive = candidate.lane === 'windows-desktop' ? join(root, 'resources/app.asar')
    : join(root, 'DeepSeek Harness.app/Contents/Resources/app.asar');
  const app = readAsar(archive), manifest = app.json('dsh/desktop-runtime.json');
  insist(app.json('package.json').name === '@deepseek-ai/dsh-desktop'
    && app.json('package.json').version === candidate.version && app.json('dsh/package.json').version === candidate.version
    && manifest.release?.version === candidate.version && manifest.platform === candidate.platform
    && manifest.arch === candidate.arch, 'COMPATIBILITY_HOST_IDENTITY');
  const fuse = candidate.lane === 'windows-desktop' ? executable
    : join(root, 'DeepSeek Harness.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
  assertDevelopmentFuseCompatibility(readElectronFuseWire(readFileSync(fuse)));
  return { executable, hostRoot: archive, environment: { ...environment, ELECTRON_RUN_AS_NODE: '1' } };
}

export async function runCompatibilitySmoke({ product, productPath, candidate, assetPath, outputRoot, environment,
  signal, verifierSha256, requiredGates = SMOKE_GATES, noLiveServices, extractionMustBeConfined } = {}) {
  const gates = SMOKE_GATES.map(id => ({ id, status: 'not-run', passed: false, evidence: [] }));
  const result = { scope: 'official-host-synthetic-upstream', productSha256: product?.sha256,
    hostSha256: candidate?.sha256, verifierSha256, dsh: candidate?.version, lane: candidate?.lane,
    realCredentialsUsed: false, officialSearchCalls: 0, cleanupVerified: false, passed: false, gates };
  let stage = 'package-admission', childStarted = false;
  const record = (name, value) => {
    const path = confinedPath(outputRoot, name, { allowMissing: true });
    json(path, value);
    return { path: name, sha256: digest(readFileSync(path)) };
  };
  try {
    insist(noLiveServices === true && extractionMustBeConfined === true
      && JSON.stringify(requiredGates) === JSON.stringify(SMOKE_GATES), 'COMPATIBILITY_SMOKE_POLICY_REQUIRED');
    validateCandidate(candidate);
    const lane = COMPATIBILITY_LANES[candidate.lane];
    insist(lane.platform === process.platform && lane.arch === process.arch, 'COMPATIBILITY_SMOKE_PLATFORM_MISMATCH');
    insist(await hashFile(assetPath) === candidate.sha256 && await hashFile(productPath) === product.sha256,
      'COMPATIBILITY_ASSET_CHANGED');
    const expected = inspectPackage(readFileSync(productPath));
    validateInstallManifest(expected);
    insist(expected.manifest.name === 'dsh-grok-search' && expected.manifest.version === product.version,
      'COMPATIBILITY_PACKAGE_INVALID');
    const profile = newDirectory(outputRoot, 'dsh-home/profiles/candidate');
    const installed = await installPackage(productPath, profile, environment, signal);
    insist(installed.code === 0 && !installed.failure, installed.failure || 'COMPATIBILITY_PRODUCT_INSTALL_FAILED');
    const productDirectory = join(profile, 'node_modules/dsh-grok-search');
    for (const [file, content] of expected.files) {
      const path = confinedPath(productDirectory, file);
      insist(digest(readFileSync(path)) === digest(content), 'COMPATIBILITY_PACKAGE_CONTENT_MISMATCH');
    }
    insist(!existsSync(join(profile, 'node_modules/@deepseek-ai'))
      && !existsSync(join(productDirectory, 'node_modules/@deepseek-ai')), 'COMPATIBILITY_HOST_COPY_INSTALLED');
    const prepared = await prepareHost({ candidate, assetPath, outputRoot, environment, signal });
    stage = 'capabilities'; childStarted = true;
    const execution = await command(prepared.executable, ['--expose-internals',
      join(project, 'scripts/compatibility-smoke-host.mjs'), prepared.hostRoot, outputRoot, productDirectory], {
      cwd: outputRoot, env: prepared.environment, signal, timeout: 120_000,
    });
    const messages = execution.stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
    insist(messages.length === 1, execution.failure || 'COMPATIBILITY_HOST_RECEIPT_MISSING');
    const receipt = JSON.parse(messages[0].slice(marker.length));
    insist(receipt.scope === result.scope && receipt.hostVersion === candidate.version
      && receipt.pluginVersion === product.version && receipt.realCredentialsUsed === false
      && Number.isSafeInteger(receipt.officialSearchCalls) && receipt.officialSearchCalls >= 0
      && Array.isArray(receipt.gates), 'COMPATIBILITY_HOST_RECEIPT_INVALID');
    const evidence = record('host-execution.json', { exitCode: execution.code, signal: execution.signal,
      failure: execution.failure, receipt });
    let encounteredFailure = false;
    for (const gate of gates) {
      const rows = receipt.gates.filter(row => row.id === gate.id);
      insist(rows.length === 1 && typeof rows[0].passed === 'boolean', 'COMPATIBILITY_HOST_RECEIPT_INVALID');
      gate.passed = rows[0].passed;
      gate.status = gate.passed ? 'passed' : encounteredFailure ? 'not-run' : 'failed';
      if (gate.status !== 'not-run') gate.evidence = [evidence];
      if (!gate.passed) encounteredFailure = true;
    }
    result.officialSearchCalls = receipt.officialSearchCalls;
    result.cleanupVerified = receipt.cleanupVerified === true && execution.code === 0 && !execution.failure;
    result.passed = gates.every(gate => gate.passed) && result.cleanupVerified && result.officialSearchCalls === 0;
  } catch (error) {
    const evidence = record('preparation-failure.json', { code: codeOf(error), stage, childStarted });
    const gate = gates.find(row => row.id === stage);
    gate.status = 'failed'; gate.passed = false; gate.evidence = [evidence];
    if (childStarted) result.cleanupVerified = false;
  }
  return result;
}
