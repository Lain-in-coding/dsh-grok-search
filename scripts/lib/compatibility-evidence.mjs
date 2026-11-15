import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import semver from 'semver';

export const MINIMUM_DSH_VERSION = '0.2.1-rc.2';
export const ACCEPTANCE_VERSIONS = Object.freeze([
  '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5',
  '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3',
]);
export const COMPATIBILITY_LANES = Object.freeze({
  'windows-desktop': Object.freeze({ platform: 'win32', arch: 'x64', host: 'Desktop',
    environment: 'windows', runner: 'windows-2025', feedDirectory: 'win-x64' }),
  'macos-desktop': Object.freeze({ platform: 'darwin', arch: 'arm64', host: 'Desktop',
    environment: 'macos', runner: 'macos-15', feedDirectory: 'mac-arm64' }),
  'linux-cli': Object.freeze({ platform: 'linux', arch: 'x64', host: 'CLI/Web',
    environment: 'native-linux', runner: 'ubuntu-24.04' }),
});
export const FULL_ACCEPTANCE_GATES = Object.freeze([
  'install', 'configuration-security', 'search-no-official-fallback', 'cancellation',
  'lifecycle', 'logs-github', 'program-preparation',
]);
export const SMOKE_GATES = Object.freeze([
  'package-admission', 'capabilities', 'search-no-official-fallback', 'cancellation',
]);
export const EVIDENCE_LIMITS = Object.freeze({
  metadata: 4 * 1024 * 1024, receipt: 1024 * 1024,
  product: 32 * 1024 * 1024, asset: 2 * 1024 * 1024 * 1024,
  gate: 8 * 1024 * 1024, observations: 1024,
});
export const EVIDENCE_TIMEOUTS = Object.freeze({ metadata: 20_000, asset: 900_000 });
const DOWNLOAD_ORIGIN = 'https://download.deepseek.com';
const NPM_ORIGIN = 'https://registry.npmjs.org';
const SHA256 = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function evidenceError(code, message) { return Object.assign(new Error(message), { code }); }
const requireValue = (condition, code, message) => {
  if (!condition) throw evidenceError(code, message);
};
export function requireSha256(value) {
  requireValue(typeof value === 'string' && SHA256.test(value), 'COMPATIBILITY_HASH_REQUIRED', 'A SHA-256 identity is required.');
  return value;
}
export function exactVersion(value) {
  const parsed = typeof value === 'string' && value.length <= 128 ? semver.parse(value) : null;
  const canonical = parsed && parsed.version + (parsed.build.length ? '+' + parsed.build.join('.') : '');
  requireValue(parsed && canonical === value,
    'COMPATIBILITY_VERSION_INVALID', 'An exact canonical semantic version is required.');
  return value;
}
export function hostVersionAdmitted(value) {
  try { return semver.gte(exactVersion(value), MINIMUM_DSH_VERSION); } catch { return false; }
}
export function requireIntegrity(value) {
  const encoded = typeof value === 'string' && /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(value)?.[1];
  requireValue(encoded && Buffer.from(encoded, 'base64').toString('base64') === encoded,
    'COMPATIBILITY_HASH_REQUIRED', 'An official SHA-512 integrity value is required.');
  return value;
}
export function verifyBytes(bytes, { integrity, sha256: expected, size } = {}) {
  requireValue(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'COMPATIBILITY_BYTES_INVALID', 'Expected binary content.');
  requireValue(integrity !== undefined || expected !== undefined, 'COMPATIBILITY_HASH_REQUIRED', 'Content must have an expected hash.');
  if (size !== undefined) requireValue(Number.isSafeInteger(size) && size > 0 && bytes.byteLength === size,
    'COMPATIBILITY_SIZE_MISMATCH', 'Content length differs from its metadata.');
  if (expected !== undefined) requireValue(sha256(bytes) === requireSha256(expected),
    'COMPATIBILITY_HASH_MISMATCH', 'Content differs from its SHA-256 identity.');
  if (integrity !== undefined) {
    const wanted = Buffer.from(requireIntegrity(integrity).slice(7), 'base64');
    const actual = createHash('sha512').update(bytes).digest();
    requireValue(timingSafeEqual(wanted, actual), 'COMPATIBILITY_HASH_MISMATCH', 'Content differs from official integrity metadata.');
  }
  return { sha256: sha256(bytes), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), size: bytes.byteLength };
}

export function officialMetadataUrl(lane) {
  const spec = COMPATIBILITY_LANES[lane];
  requireValue(spec, 'COMPATIBILITY_LANE_INVALID', 'Unknown compatibility lane.');
  return lane === 'linux-cli' ? `${NPM_ORIGIN}/@deepseek-ai%2fdsh`
    : `${DOWNLOAD_ORIGIN}/dsh-desk/feeds/${spec.feedDirectory}/${lane === 'macos-desktop' ? 'nightly-mac.yml' : 'nightly.yml'}`;
}
function cleanUrl(value) {
  requireValue(typeof value === 'string' && value.length <= 4096 && !/[\s\\\0]/.test(value),
    'COMPATIBILITY_URL_UNTRUSTED', 'Invalid official resource URL.');
  let url;
  try { url = new URL(value); } catch { throw evidenceError('COMPATIBILITY_URL_UNTRUSTED', 'Invalid official resource URL.'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && !/%(?:2e|2f|5c|00)/i.test(url.pathname) && !/(?:^|\/)\.\.?(?:\/|$)/.test(value),
  'COMPATIBILITY_URL_UNTRUSTED', 'Official URLs cannot contain credentials, queries or traversal.');
  return url;
}
export function validateOfficialUrl(value, { kind, lane, packageName } = {}) {
  // npm's encoded scope separator is accepted only in these exact metadata URLs.
  if (kind === 'metadata') {
    const expected = packageName === 'dsh-grok-search' ? `${NPM_ORIGIN}/dsh-grok-search` : officialMetadataUrl(lane);
    requireValue(value === expected, 'COMPATIBILITY_URL_UNTRUSTED', 'Metadata must come from the fixed official feed.');
    return value;
  }
  if (kind === 'signal') {
    requireValue(value === 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=20',
      'COMPATIBILITY_URL_UNTRUSTED', 'Unknown release signal endpoint.');
    return value;
  }
  const url = cleanUrl(value);
  if (kind === 'desktop-asset') {
    const spec = COMPATIBILITY_LANES[lane];
    const prefix = `/dsh-desk/bin/${spec?.feedDirectory}/`;
    requireValue(spec?.feedDirectory && url.origin === DOWNLOAD_ORIGIN
      && url.pathname.startsWith(prefix)
      && /^[A-Za-z0-9._+-]+\.(?:zip|exe|dmg|7z)$/.test(url.pathname.slice(prefix.length)),
    'COMPATIBILITY_URL_UNTRUSTED', 'Desktop assets must stay on their official platform feed.');
  } else if (kind === 'npm-tarball') {
    requireValue(['dsh-grok-search', '@deepseek-ai/dsh'].includes(packageName)
      && url.origin === NPM_ORIGIN && url.pathname.startsWith(`/${packageName}/-/`)
      && url.pathname.endsWith('.tgz') && !url.pathname.slice(`/${packageName}/-/`.length).includes('/'),
    'COMPATIBILITY_URL_UNTRUSTED', 'The tarball must belong to the exact official npm package.');
  } else throw evidenceError('COMPATIBILITY_URL_UNTRUSTED', 'Unknown resource purpose.');
  return url.href;
}

function requestSignal(timeoutMs, signal) {
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= EVIDENCE_TIMEOUTS.asset,
    'COMPATIBILITY_TIMEOUT_INVALID', 'Download timeout must be a positive integer no greater than 900000 ms.');
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
export async function fetchVerifiedResource(url, { fetchImpl = globalThis.fetch, validateUrl, signal,
  limit = EVIDENCE_LIMITS.metadata, timeoutMs = EVIDENCE_TIMEOUTS.metadata, consume } = {}) {
  requireValue(typeof validateUrl === 'function', 'COMPATIBILITY_URL_UNTRUSTED', 'Every request needs a URL policy.');
  requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= EVIDENCE_LIMITS.asset,
    'COMPATIBILITY_SIZE_LIMIT', 'Invalid download budget.');
  requireValue(consume === undefined || typeof consume === 'function',
    'COMPATIBILITY_BYTES_INVALID', 'A content sink must be a local function.');
  const combined = requestSignal(timeoutMs, signal);
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    validateUrl(target);
    combined.throwIfAborted();
    const response = await fetchImpl(target, { redirect: 'manual', credentials: 'omit', signal: combined,
      headers: { accept: 'application/json, application/yaml, application/octet-stream', 'user-agent': 'dsh-compatibility-watch' } });
    try { if (response.url) validateUrl(response.url); }
    catch (error) { await response.body?.cancel(); throw error; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      requireValue(location, 'COMPATIBILITY_URL_UNTRUSTED', 'The official redirect has no destination.');
      target = new URL(location, target).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw evidenceError('COMPATIBILITY_METADATA_HTTP', `Official resource returned HTTP ${response.status}.`);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      await response.body?.cancel();
      throw evidenceError('COMPATIBILITY_SIZE_LIMIT', 'Official content exceeds the download limit.');
    }
    const reader = response.body?.getReader();
    requireValue(reader, 'COMPATIBILITY_BODY_MISSING', 'Official resource has no body.');
    const chunks = [];
    let size = 0;
    const cancel = () => { void reader.cancel(combined.reason).catch(() => {}); };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        combined.throwIfAborted();
        const { done, value } = await reader.read();
        combined.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        requireValue(size <= limit, 'COMPATIBILITY_SIZE_LIMIT', 'Official content exceeds the download limit.');
        if (consume) await consume(value);
        else chunks.push(value);
      }
    } finally {
      combined.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    combined.throwIfAborted();
    return consume ? { size } : Buffer.concat(chunks);
  }
  throw evidenceError('COMPATIBILITY_URL_UNTRUSTED', 'Too many official resource redirects.');
}

function scalar(value) {
  const text = value.trim();
  requireValue(text.length > 0 && !/^[!&*>|[{]/.test(text), 'COMPATIBILITY_METADATA_INVALID', 'Unsupported updater metadata scalar.');
  if (text.startsWith('"')) {
    try { return JSON.parse(text); } catch { throw evidenceError('COMPATIBILITY_METADATA_INVALID', 'Invalid quoted metadata.'); }
  }
  if (text.startsWith("'")) {
    requireValue(text.endsWith("'"), 'COMPATIBILITY_METADATA_INVALID', 'Invalid quoted metadata.');
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}
export function parseUpdateMetadata(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  requireValue(Buffer.byteLength(text) <= EVIDENCE_LIMITS.metadata && Buffer.from(text).equals(Buffer.from(bytes)),
    'COMPATIBILITY_METADATA_INVALID', 'Updater metadata must be bounded UTF-8.');
  if (text.trimStart().startsWith('{')) {
    try { return JSON.parse(text); } catch { throw evidenceError('COMPATIBILITY_METADATA_INVALID', 'Invalid update JSON.'); }
  }
  // A data-only subset of electron-updater YAML. No aliases, tags or executable templates.
  const result = {}, files = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let current = null, inFiles = false, index = 0;
  const readScalar = (raw, parentIndent) => {
    if (raw.trim() !== '>-') return scalar(raw);
    // Official feeds use folded-strip blocks. Reject other block styles and extra indentation.
    const parts = [];
    let indent, blanks = 0;
    for (++index; index < lines.length; index++) {
      const body = lines[index];
      requireValue(!/^[ \t]*\t/.test(body), 'COMPATIBILITY_METADATA_INVALID', 'Tabs cannot indent updater block scalars.');
      if (!body.trim()) { blanks++; continue; }
      const width = /^ */.exec(body)[0].length;
      if (width <= parentIndent) break;
      indent ??= width;
      requireValue(width === indent, 'COMPATIBILITY_METADATA_INVALID', 'Unsupported updater block scalar indentation.');
      if (parts.length || blanks) parts.push(blanks ? '\n'.repeat(blanks) : ' ');
      parts.push(body.slice(indent));
      blanks = 0;
    }
    index--;
    requireValue(parts.length > 0, 'COMPATIBILITY_METADATA_INVALID', 'Updater block scalar has no content.');
    return parts.join('');
  };
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z][\w]*):(?:\s+(.*))?$/.exec(line);
    if (top) {
      inFiles = top[1] === 'files'; current = null;
      if (inFiles) {
        requireValue(!Object.hasOwn(result, 'files') && !top[2], 'COMPATIBILITY_METADATA_INVALID', 'Invalid updater file list.');
        result.files = files;
      } else if (['version', 'path', 'sha512', 'size'].includes(top[1])) {
        requireValue(!Object.hasOwn(result, top[1]), 'COMPATIBILITY_METADATA_INVALID', 'Duplicate updater metadata.');
        result[top[1]] = readScalar(top[2] ?? '', 0);
      }
      continue;
    }
    if (!inFiles) continue;
    const entry = /^\s+-\s+url:\s+(.+)$/.exec(line);
    if (entry) { current = { url: readScalar(entry[1], line.indexOf('url:')) }; files.push(current); continue; }
    const field = /^\s+(sha512|size|url|blockMapSize):\s+(.+)$/.exec(line);
    requireValue(field && current && !Object.hasOwn(current, field[1]),
      'COMPATIBILITY_METADATA_INVALID', 'Unsupported or duplicate updater file entry.');
    current[field[1]] = readScalar(field[2], line.indexOf(field[1] + ':'));
  }
  return result;
}
export function desktopCandidates(bytes, lane) {
  const sourceUrl = officialMetadataUrl(lane);
  requireValue(lane !== 'linux-cli', 'COMPATIBILITY_LANE_INVALID', 'Desktop metadata needs a Desktop lane.');
  const metadata = parseUpdateMetadata(bytes);
  requireValue(record(metadata) && hostVersionAdmitted(metadata.version), 'COMPATIBILITY_VERSION_INVALID', 'Invalid official Desktop version.');
  const rows = Array.isArray(metadata.files) ? metadata.files
    : metadata.path ? [{ url: metadata.path, sha512: metadata.sha512, size: metadata.size }] : [];
  requireValue(rows.length > 0 && rows.length <= 16, 'COMPATIBILITY_METADATA_INVALID', 'Updater metadata has no bounded file list.');
  const spec = COMPATIBILITY_LANES[lane], seen = new Set();
  return rows.map(row => {
    requireValue(record(row) && typeof row.url === 'string' && !/[\s\\]/.test(row.url)
      && !/%(?:2e|2f|5c|00)/i.test(row.url) && !/(?:^|\/)\.\.?(?:\/|$)/.test(row.url),
    'COMPATIBILITY_URL_UNTRUSTED', 'Unsafe updater asset path.');
    const assetBase = `${DOWNLOAD_ORIGIN}/dsh-desk/bin/${spec.feedDirectory}/`;
    const url = validateOfficialUrl(new URL(row.url, assetBase).href, { kind: 'desktop-asset', lane });
    requireValue(new URL(url).pathname.split('/').at(-1).startsWith(`deepseek-harness-${metadata.version}-`),
      'COMPATIBILITY_METADATA_INVALID', 'Asset basename differs from the official release version.');
    requireValue(!seen.has(url), 'COMPATIBILITY_METADATA_INVALID', 'Duplicate updater asset.');
    seen.add(url);
    const integrity = requireIntegrity('sha512-' + row.sha512);
    const size = row.size === undefined ? undefined : Number(row.size);
    requireValue(size === undefined || Number.isSafeInteger(size) && size > 0 && size <= EVIDENCE_LIMITS.asset,
      'COMPATIBILITY_SIZE_LIMIT', 'Invalid official asset length.');
    return { schemaVersion: 1, kind: 'official-host-candidate', lane, version: metadata.version,
      platform: spec.platform, arch: spec.arch, host: spec.host, environment: spec.environment,
      source: { kind: 'official-update', metadataUrl: sourceUrl, metadataSha256: sha256(bytes), url },
      integrity, ...(size === undefined ? {} : { size }) };
  });
}
export function npmIdentity(bytes, { packageName, version, lane } = {}) {
  requireValue(['dsh-grok-search', '@deepseek-ai/dsh'].includes(packageName),
    'COMPATIBILITY_METADATA_INVALID', 'Unexpected npm package.');
  let document;
  try { document = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw evidenceError('COMPATIBILITY_METADATA_INVALID', 'Invalid npm metadata.'); }
  requireValue(record(document) && document.name === packageName, 'COMPATIBILITY_METADATA_INVALID', 'npm package identity differs.');
  const selected = exactVersion(version ?? document['dist-tags']?.latest);
  const manifest = document.versions?.[selected];
  requireValue(record(manifest) && manifest.name === packageName && manifest.version === selected,
    'COMPATIBILITY_METADATA_INVALID', 'Exact npm release metadata is missing.');
  const integrity = requireIntegrity(manifest.dist?.integrity);
  const url = validateOfficialUrl(manifest.dist?.tarball, { kind: 'npm-tarball', packageName });
  requireValue(new URL(url).pathname.endsWith(`/${packageName.split('/').at(-1)}-${selected}.tgz`),
    'COMPATIBILITY_METADATA_INVALID', 'npm tarball name differs from the selected version.');
  if (packageName === '@deepseek-ai/dsh') {
    requireValue(lane === 'linux-cli' && hostVersionAdmitted(selected), 'COMPATIBILITY_VERSION_INVALID', 'Unsupported CLI candidate.');
  }
  return { schemaVersion: 1, kind: packageName === 'dsh-grok-search' ? 'product-candidate' : 'official-host-candidate',
    name: packageName, version: selected,
    ...(lane ? { lane, ...Object.fromEntries(['platform', 'arch', 'host', 'environment'].map(key => [key, COMPATIBILITY_LANES[lane][key]])) } : {}),
    source: { kind: 'npm-registry', metadataUrl: packageName === 'dsh-grok-search'
      ? `${NPM_ORIGIN}/dsh-grok-search` : officialMetadataUrl(lane), metadataSha256: sha256(bytes), url },
    integrity, nodeRange: manifest.engines?.node ?? null };
}
export function validateCandidate(candidate) {
  requireValue(record(candidate) && candidate.schemaVersion === 1 && candidate.kind === 'official-host-candidate',
    'COMPATIBILITY_RECEIPT_INVALID', 'Invalid official candidate record.');
  const spec = COMPATIBILITY_LANES[candidate.lane];
  requireValue(spec && ['platform', 'arch', 'host', 'environment'].every(key => candidate[key] === spec[key])
    && hostVersionAdmitted(candidate.version), 'COMPATIBILITY_RECEIPT_INVALID', 'Candidate identity does not match its lane.');
  requireIntegrity(candidate.integrity);
  requireSha256(candidate.source?.metadataSha256);
  validateOfficialUrl(candidate.source?.metadataUrl, { kind: 'metadata', lane: candidate.lane });
  const desktop = candidate.lane !== 'linux-cli';
  requireValue(candidate.source.kind === (desktop ? 'official-update' : 'npm-registry'),
    'COMPATIBILITY_RECEIPT_INVALID', 'Candidate has the wrong source kind.');
  validateOfficialUrl(candidate.source.url, { kind: desktop ? 'desktop-asset' : 'npm-tarball',
    lane: candidate.lane, packageName: '@deepseek-ai/dsh' });
  requireValue(desktop
    ? new URL(candidate.source.url).pathname.split('/').at(-1).startsWith(`deepseek-harness-${candidate.version}-`)
    : candidate.name === '@deepseek-ai/dsh' && new URL(candidate.source.url).pathname.endsWith(`/dsh-${candidate.version}.tgz`),
  'COMPATIBILITY_RECEIPT_INVALID', 'Candidate asset name differs from its declared version.');
  if (!desktop && candidate.nodeRange !== null) requireValue(typeof candidate.nodeRange === 'string'
    && candidate.nodeRange.length <= 128 && semver.validRange(candidate.nodeRange) !== null,
  'COMPATIBILITY_RECEIPT_INVALID', 'Invalid official Node engine range.');
  if (candidate.size !== undefined) requireValue(Number.isSafeInteger(candidate.size) && candidate.size > 0
    && candidate.size <= EVIDENCE_LIMITS.asset, 'COMPATIBILITY_SIZE_LIMIT', 'Invalid candidate size.');
  if (candidate.sha256 !== undefined) requireSha256(candidate.sha256);
  return candidate;
}
export function verifyHostAsset(candidate, bytes) {
  validateCandidate(candidate);
  return { ...structuredClone(candidate), ...verifyBytes(bytes, candidate) };
}
export async function downloadHostAsset(candidate, path, { fetchImpl = globalThis.fetch, signal,
  timeoutMs = EVIDENCE_TIMEOUTS.asset } = {}) {
  validateCandidate(candidate);
  const combined = requestSignal(timeoutMs, signal);
  combined.throwIfAborted();
  const hash256 = createHash('sha256'), hash512 = createHash('sha512');
  const fd = openSync(path, 'wx', 0o600);
  let size;
  try {
    ({ size } = await fetchVerifiedResource(candidate.source.url, {
      fetchImpl, signal: combined, timeoutMs, limit: EVIDENCE_LIMITS.asset,
      validateUrl: url => validateOfficialUrl(url, { kind: candidate.lane === 'linux-cli' ? 'npm-tarball' : 'desktop-asset',
        lane: candidate.lane, packageName: '@deepseek-ai/dsh' }),
      consume(bytes) {
        hash256.update(bytes); hash512.update(bytes);
        for (let offset = 0; offset < bytes.byteLength;) {
          const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
          requireValue(written > 0, 'COMPATIBILITY_BYTES_INVALID', 'The asset sink made no progress.');
          offset += written;
        }
      },
    }));
  } finally { closeSync(fd); }
  combined.throwIfAborted();
  const actual = { sha256: hash256.digest('hex'), integrity: 'sha512-' + hash512.digest('base64'), size };
  requireValue(size > 0 && (candidate.size === undefined || size === candidate.size),
    'COMPATIBILITY_SIZE_MISMATCH', 'Downloaded asset length differs from official metadata.');
  requireValue(actual.integrity === candidate.integrity && (!candidate.sha256 || actual.sha256 === candidate.sha256),
    'COMPATIBILITY_HASH_MISMATCH', 'Downloaded asset differs from its pinned content identity.');
  const savedHash = await hashFile(path);
  combined.throwIfAborted();
  requireValue(savedHash === actual.sha256, 'COMPATIBILITY_ASSET_CHANGED', 'Saved asset differs from downloaded bytes.');
  return { ...structuredClone(candidate), ...actual };
}
export function assertAssetUnchanged(candidate, previous = []) {
  validateCandidate(candidate);
  for (const old of previous) {
    validateCandidate(old);
    if (old.lane === candidate.lane && old.version === candidate.version && old.source.url === candidate.source.url) {
      requireValue(old.integrity === candidate.integrity
        && (!old.sha256 || !candidate.sha256 || old.sha256 === candidate.sha256)
        && (old.size === undefined || candidate.size === undefined || old.size === candidate.size),
      'COMPATIBILITY_ASSET_CHANGED', 'An official asset changed under the same release identity.');
    }
  }
}
export function rememberAssets(previous = [], candidates = []) {
  requireValue(Array.isArray(previous) && Array.isArray(candidates)
    && previous.length <= EVIDENCE_LIMITS.observations && candidates.length <= EVIDENCE_LIMITS.observations,
  'COMPATIBILITY_RECEIPT_INVALID', 'Asset observations must be a bounded list.');
  const rows = [];
  for (const candidate of [...previous, ...candidates]) {
    assertAssetUnchanged(candidate, rows);
    const old = rows.find(row => row.lane === candidate.lane && row.version === candidate.version
      && row.source.url === candidate.source.url);
    if (!old) rows.push(structuredClone(candidate));
    else {
      if (candidate.sha256) old.sha256 = candidate.sha256;
      if (candidate.size !== undefined) old.size = candidate.size;
    }
    requireValue(rows.length <= EVIDENCE_LIMITS.observations,
      'COMPATIBILITY_SIZE_LIMIT', 'Observation retention is full; do not silently discard pinned identities.');
  }
  return rows;
}

export function relativeFile(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length < 2048
    && !/[\\:\x00-\x1f<>\"|?*]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
  'COMPATIBILITY_PATH_UNSAFE', 'A safe relative file path is required.');
  return value;
}
export function confinedPath(root, value, { allowMissing = false } = {}) {
  requireValue(typeof root === 'string' && isAbsolute(root), 'COMPATIBILITY_PATH_UNSAFE', 'An absolute trusted root is required.');
  const base = resolve(root), target = resolve(base, relativeFile(value));
  const rel = relative(base, target);
  requireValue(rel && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'COMPATIBILITY_PATH_UNSAFE', 'Path escapes its trusted root.');
  let current = base;
  for (const part of [null, ...rel.split(sep)]) {
    if (part !== null) current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat && allowMissing) continue;
    requireValue(stat && !stat.isSymbolicLink(), 'COMPATIBILITY_PATH_UNSAFE', 'Receipt paths cannot contain missing entries or links.');
  }
  if (!allowMissing) {
    const real = relative(realpathSync(base), realpathSync(target));
    requireValue(real && real !== '..' && !real.startsWith('..' + sep) && !isAbsolute(real),
      'COMPATIBILITY_PATH_UNSAFE', 'Resolved path escapes its trusted root.');
  }
  return target;
}
export function readJsonReceipt(path, expectedSha256) {
  if (expectedSha256 !== undefined) requireSha256(expectedSha256);
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= EVIDENCE_LIMITS.receipt,
    'COMPATIBILITY_RECEIPT_INVALID', 'Receipt must be a bounded ordinary file.');
  const bytes = readFileSync(path);
  if (expectedSha256 !== undefined) verifyBytes(bytes, { sha256: expectedSha256 });
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw evidenceError('COMPATIBILITY_RECEIPT_INVALID', 'Invalid receipt JSON.'); }
}
export async function hashFile(path, { limit = EVIDENCE_LIMITS.asset } = {}) {
  const before = lstatSync(path);
  requireValue(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= limit,
    'COMPATIBILITY_PATH_UNSAFE', 'Hash input must be a bounded ordinary file.');
  const hash = createHash('sha256');
  let read = 0;
  for await (const bytes of createReadStream(path)) {
    read += bytes.byteLength;
    requireValue(read <= limit, 'COMPATIBILITY_SIZE_LIMIT', 'File grew beyond its hash budget.');
    hash.update(bytes);
  }
  const after = lstatSync(path);
  requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
    && before.ino === after.ino && before.dev === after.dev && !after.isSymbolicLink(),
  'COMPATIBILITY_ASSET_CHANGED', 'File changed during identity verification.');
  return hash.digest('hex');
}
export function validateRuntimeReceipt(receipt, { root, version, platform, arch, roles = [] } = {}) {
  requireValue(record(receipt) && receipt.schemaVersion === 1 && receipt.kind === 'verified-runtime-candidate',
    'COMPATIBILITY_RECEIPT_INVALID', 'Expected a verified runtime receipt.');
  validateCandidate(receipt.asset);
  requireSha256(receipt.asset.sha256);
  requireValue(receipt.asset.version === version && receipt.asset.platform === platform && receipt.asset.arch === arch,
    'COMPATIBILITY_RECEIPT_INVALID', 'Runtime receipt identity differs from the requested host.');
  requireValue(record(receipt.files) && roles.every(role => Object.hasOwn(receipt.files, role)),
    'COMPATIBILITY_RECEIPT_INVALID', 'Required runtime identities are absent.');
  const files = {};
  for (const [role, row] of Object.entries(receipt.files)) {
    requireValue(['executable', 'archive', 'fuseBinary', 'cliManifest'].includes(role) && record(row),
      'COMPATIBILITY_RECEIPT_INVALID', 'Unexpected runtime file role.');
    const path = confinedPath(root, row.path), stat = lstatSync(path);
    requireValue(stat.isFile() && stat.size <= EVIDENCE_LIMITS.asset, 'COMPATIBILITY_PATH_UNSAFE', 'Invalid runtime file.');
    verifyBytes(readFileSync(path), { sha256: requireSha256(row.sha256) });
    files[role] = path;
  }
  return { receipt, files };
}
export function readRuntimeReceipt({ receiptPath, receiptSha256, root, ...identity }) {
  requireSha256(receiptSha256);
  const receipt = readJsonReceipt(receiptPath, receiptSha256);
  return validateRuntimeReceipt(receipt, { root, ...identity });
}
export function acceptanceTargets() {
  return ACCEPTANCE_VERSIONS.flatMap(dsh => Object.values(COMPATIBILITY_LANES).map(spec => ({
    platform: `${spec.platform}-${spec.arch}`, host: spec.host, dsh,
    environment: spec.platform === 'linux' ? 'WSL Ubuntu 22.04' : spec.environment,
  })));
}
export const targetKey = target => [target.platform, target.host, target.dsh, target.environment].join('/');
export function createExecutionIdentity({ platform, arch, context = { kind: 'local' } } = {}) {
  const execution = { id: randomUUID(), startedAt: new Date().toISOString(), platform, arch, context };
  validateExecutionIdentity(execution);
  return execution;
}
function validateExecutionIdentity(execution, { finished = false } = {}) {
  requireValue(record(execution) && /^[a-f0-9-]{36}$/.test(execution.id)
    && ['win32', 'darwin', 'linux'].includes(execution.platform) && ['x64', 'arm64'].includes(execution.arch)
    && typeof execution.startedAt === 'string' && Number.isFinite(Date.parse(execution.startedAt)),
  'COMPATIBILITY_RECEIPT_INVALID', 'Actual execution identity is missing.');
  const context = execution.context;
  requireValue(record(context) && ['local', 'github-actions'].includes(context.kind),
    'COMPATIBILITY_RECEIPT_INVALID', 'Unknown execution origin.');
  if (context.kind === 'github-actions') {
    requireValue(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(context.repository)
      && /^[1-9]\d*$/.test(context.runId) && /^[1-9]\d*$/.test(context.runAttempt)
      && /^[a-f0-9]{40}$/.test(context.commit),
    'COMPATIBILITY_RECEIPT_INVALID', 'Actions evidence needs the actual repository, commit and run.');
  }
  if (finished) requireValue(typeof execution.finishedAt === 'string'
    && Date.parse(execution.finishedAt) >= Date.parse(execution.startedAt),
  'COMPATIBILITY_RECEIPT_INVALID', 'Actual execution finish time is missing.');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export function executionSha256(result) {
  const { runSha256: _ignored, ...content } = result;
  return sha256(JSON.stringify(canonical(content)));
}
function validateGates(result, requiredGates) {
  requireValue(record(result) && Array.isArray(result.gates) && result.gates.length === requiredGates.length,
    'COMPATIBILITY_RECEIPT_INVALID', 'Every required gate must have exactly one explicit outcome.');
  for (const id of requiredGates) {
    const rows = result.gates.filter(row => record(row) && row.id === id);
    requireValue(rows.length === 1, 'COMPATIBILITY_RECEIPT_INVALID', 'Unknown, duplicate or absent gate.');
    const gate = rows[0];
    requireValue(['passed', 'failed', 'not-run'].includes(gate.status) && gate.passed === (gate.status === 'passed')
      && Array.isArray(gate.evidence) && gate.evidence.length <= 8
      && (gate.status === 'not-run' || gate.evidence.length > 0),
    'COMPATIBILITY_RECEIPT_INVALID', 'Executed gates must reference their actual bounded evidence.');
    for (const item of gate.evidence) {
      requireValue(record(item), 'COMPATIBILITY_RECEIPT_INVALID', 'Invalid gate evidence reference.');
      relativeFile(item.path); requireSha256(item.sha256);
    }
  }
  const passed = result.gates.every(row => row.passed) && result.realCredentialsUsed === false
    && result.officialSearchCalls === 0 && result.cleanupVerified === true;
  requireValue(typeof result.cleanupVerified === 'boolean' && result.realCredentialsUsed === false
    && Number.isSafeInteger(result.officialSearchCalls) && result.officialSearchCalls >= 0
    && result.passed === passed, 'COMPATIBILITY_RECEIPT_INVALID', 'Gate summary differs from its actual outcomes.');
  return passed;
}
function validateRunDigest(result) {
  validateExecutionIdentity(result.execution, { finished: true });
  requireValue(requireSha256(result.runSha256) === executionSha256(result),
    'COMPATIBILITY_HASH_MISMATCH', 'Actual execution evidence changed after sealing.');
}
export function validateSmokeResult(result, { product, candidate, verifierSha256, requirePassed = true }) {
  validateCandidate(candidate);
  requireValue(record(result) && result.scope === 'official-host-synthetic-upstream',
    'COMPATIBILITY_RECEIPT_INVALID', 'Expected isolated official host execution evidence.');
  requireValue(result.productSha256 === requireSha256(product.sha256)
    && result.hostSha256 === requireSha256(candidate.sha256)
    && result.verifierSha256 === requireSha256(verifierSha256)
    && result.dsh === candidate.version && result.lane === candidate.lane,
  'COMPATIBILITY_RECEIPT_INVALID', 'Smoke evidence identities differ.');
  const passed = validateGates(result, SMOKE_GATES);
  validateRunDigest(result);
  requireValue(result.execution.platform === candidate.platform && result.execution.arch === candidate.arch,
    'COMPATIBILITY_RECEIPT_INVALID', 'Actual execution ran on a different platform.');
  if (requirePassed) requireValue(passed, 'COMPATIBILITY_SMOKE_FAILED', 'Required smoke gates did not all run successfully.');
  return structuredClone(result);
}
export async function sealExecutionResult(result, { product, candidate, verifierSha256, execution, outputRoot,
  requiredGates = SMOKE_GATES } = {}) {
  validateCandidate(candidate);
  validateExecutionIdentity(execution);
  requireValue(record(result) && result.scope === 'official-host-synthetic-upstream'
    && result.productSha256 === requireSha256(product.sha256)
    && result.hostSha256 === requireSha256(candidate.sha256)
    && result.verifierSha256 === requireSha256(verifierSha256)
    && result.dsh === candidate.version && result.lane === candidate.lane,
  'COMPATIBILITY_RECEIPT_INVALID', 'Runner output differs from the frozen execution inputs.');
  validateGates(result, requiredGates);
  for (const gate of result.gates) {
    for (const item of gate.evidence) {
      requireValue(await hashFile(confinedPath(outputRoot, item.path), { limit: EVIDENCE_LIMITS.gate }) === item.sha256,
        'COMPATIBILITY_HASH_MISMATCH', 'Gate output differs from its execution evidence.');
    }
  }
  const sealed = { passed: result.passed, scope: result.scope, productSha256: result.productSha256,
    hostSha256: result.hostSha256, verifierSha256, dsh: result.dsh, lane: result.lane,
    ...(result.platform ? { platform: result.platform, host: result.host, environment: result.environment } : {}),
    realCredentialsUsed: result.realCredentialsUsed, officialSearchCalls: result.officialSearchCalls,
    cleanupVerified: result.cleanupVerified,
    gates: result.gates.map(gate => ({ id: gate.id, status: gate.status, passed: gate.passed,
      evidence: gate.evidence.map(item => ({ path: item.path, sha256: item.sha256 })) })),
    execution: { ...structuredClone(execution), finishedAt: new Date().toISOString() } };
  return { ...sealed, runSha256: executionSha256(sealed) };
}
export function releaseEvidence({ product, results = [] }) {
  requireSha256(product?.sha256); requireIntegrity(product?.integrity); exactVersion(product?.version);
  const expected = acceptanceTargets(), actual = new Map();
  for (const row of results) {
    requireValue(record(row) && row.productSha256 === product.sha256 && row.scope === 'official-host-synthetic-upstream'
      && row.realCredentialsUsed === false, 'COMPATIBILITY_RECEIPT_INVALID', 'A result does not belong to this exact package.');
    requireSha256(row.hostSha256); requireSha256(row.verifierSha256);
    const key = targetKey(row);
    requireValue(expected.some(target => targetKey(target) === key) && !actual.has(key),
      'COMPATIBILITY_RECEIPT_INVALID', 'Unknown or duplicate full acceptance target.');
    validateRunDigest(row);
    requireValue(`${row.execution.platform}-${row.execution.arch}` === row.platform,
      'COMPATIBILITY_RECEIPT_INVALID', 'Acceptance platform differs from the actual execution.');
    const passed = validateGates(row, FULL_ACCEPTANCE_GATES);
    actual.set(key, { ...structuredClone(row), passed });
  }
  const targets = expected.map(target => actual.get(targetKey(target)) ?? { ...target, passed: false, status: 'not-run' });
  return { schemaVersion: 1, kind: 'exact-package-compatibility-evidence', product: structuredClone(product),
    targets, summary: { expected: expected.length, actual: actual.size,
      passed: targets.filter(row => row.passed).length, missing: expected.length - actual.size },
    passed: targets.every(row => row.passed), published: false };
}
