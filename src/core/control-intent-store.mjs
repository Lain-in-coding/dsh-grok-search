import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireOwnedLock, DEFAULT_STALE_LOCK_MS } from './owned-lock.mjs';

export const CONTROL_RECORD_FORMAT = 'dsh-grok-search/control-intent';
export const CONTROL_RECORD_VERSION = 1;
export const LEGACY_CONTROL_FORMAT = 'dsh-grok-search/legacy-control-intent';
export const CONTROL_CHECKPOINT_FORMAT = 'dsh-grok-search/control-checkpoint';
const MAX_BYTES = 1_048_576;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_SEALED_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_REVISION = 999_999_999_999;
const ACTIVE_CONTROL_REVISIONS = 50;
const DEFAULT_SEALED_MAX_REVISIONS = 1000 - ACTIVE_CONTROL_REVISIONS - 1;
const DEFAULT_SEALED_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const CHECKPOINT_NAME = 'checkpoint.json';
const CHECKPOINT_LOCK = 'checkpoint.lock';
const CONTROL_WRITE_LOCK = 'control-write.lock';
const SEALED_DIRECTORY = 'sealed';
const LEGACY_ARCHIVES_DIRECTORY = 'legacy-archives';
const SEALED_MANIFEST = 'manifest.json';
const SEALED_RETENTION = 'retention.json';
const SEALED_PENDING = 'retention-pending.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const identity = value => text(value) || (Number.isSafeInteger(value) && value >= 0);
const time = value => text(value) && Number.isFinite(Date.parse(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rootNetworkPath = path => !/^\\\\\?\\[a-z]:\\/i.test(path)
  && (path.startsWith('\\') || path.startsWith('//'));
const filename = revision => `v${String(revision).padStart(12, '0')}.json`;
const REVISION_NAME = /^v\d{12}\.json$/;
const revisionOf = name => Number(name.slice(1, 13));

export class ControlRecordError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'ControlRecordError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
const fail = (code, details, message) => { throw new ControlRecordError(code, message ?? code, details); };
const invalid = message => fail('CONTROL_RECORD_INVALID', {}, message);
export function writeControlIntent(store, request) {
  return typeof store.compareAndSwapAsync === 'function'
    ? store.compareAndSwapAsync(request) : store.compareAndSwap(request);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    if (ArrayBuffer.isView(value)) return value;
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function jsonCopy(value) {
  try {
    const encoded = JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint'
        || (typeof item === 'number' && !Number.isFinite(item))) invalid('Control records must contain only JSON values.');
      return item;
    });
    if (!encoded || Buffer.byteLength(encoded) > MAX_BYTES) invalid('Control record exceeds the bounded JSON format.');
    return JSON.parse(encoded);
  } catch (error) {
    if (error instanceof ControlRecordError) throw error;
    invalid('Control record is not serializable JSON.');
  }
}
export function validateControlIntent(intent) {
  if (!object(intent)) invalid('Control intent must be an object.');
  if (intent.schemaVersion !== CONTROL_RECORD_VERSION) {
    fail('CONTROL_RECORD_VERSION_UNSUPPORTED', { schemaVersion: intent.schemaVersion ?? null });
  }
  if (!['required', 'released'].includes(intent.policy) || !text(intent.reason) || !Object.hasOwn(intent, 'release')) {
    invalid('Control intent policy, reason and explicit release field are required.');
  }
  if (intent.release !== null) {
    if (intent.policy !== 'released' || !object(intent.release) || intent.release.explicit !== true
      || !time(intent.release.committedAt)) invalid('A historic release requires an explicit, timestamped released intent.');
    if (intent.release.kind !== undefined && !text(intent.release.kind)) invalid('Release kind must be non-empty text.');
    if (intent.release.operationId !== undefined && !UUID.test(intent.release.operationId)) invalid('Release operation ID must be a UUID.');
    if (intent.release.hostId !== undefined && !UUID.test(intent.release.hostId)) invalid('Release host ID must be a UUID.');
    if (intent.release.pid !== undefined && (!Number.isSafeInteger(intent.release.pid) || intent.release.pid <= 0)) invalid('Release PID must be a positive integer.');
    if (intent.release.counterBaseline !== undefined
      && (!Number.isSafeInteger(intent.release.counterBaseline) || intent.release.counterBaseline < 0)) {
      invalid('Release original-search baseline must be a non-negative integer.');
    }
    for (const key of ['routeChanged', 'routeVerified']) {
      if (intent.release[key] !== undefined && typeof intent.release[key] !== 'boolean') invalid(`Release ${key} must be boolean.`);
    }
  }
  if (intent.lease !== undefined) {
    const lease = intent.lease;
    if (!object(lease) || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 || !identity(lease.uid)
      || !text(lease.entryId) || !text(lease.moduleName) || !text(lease.provider)
      || (lease.hostId !== undefined && !UUID.test(lease.hostId))) invalid('Control ownership lease is invalid.');
  }
  if (intent.acquiredSelection !== undefined && (!Array.isArray(intent.acquiredSelection)
    || intent.acquiredSelection.some(value => !text(value)))) invalid('Acquired bundle selection is invalid.');
  for (const key of ['acquisition', 'pause', 'recovery', 'priorIntent', 'releaseCompletion']) {
    if (intent[key] !== undefined && intent[key] !== null && !object(intent[key])) invalid(`Control ${key} must be an object.`);
  }
  if (intent.pause !== undefined && (!object(intent.pause) || typeof intent.pause.confirmed !== 'boolean')) {
    invalid('Control pause must state whether it was confirmed.');
  }
  if (intent.recovery?.action === 'startup-state-correction') {
    if (intent.policy !== 'released' || intent.release !== null || !object(intent.priorIntent)
      || !object(intent.recovery.originalLease)
      || (intent.recovery.historicReleaseCommitted !== false
        && !(intent.recovery.historicReleaseCommitted === true && intent.priorIntent.release?.explicit === true))
      || intent.recovery.routeVerified !== true || typeof intent.recovery.routeChanged !== 'boolean') {
      invalid('Startup correction must preserve prior evidence and must not invent a historic release.');
    }
  }
  if (intent.recovery?.action === 'explicit-release-recovery') {
    if (intent.policy !== 'released' || intent.release === null || !object(intent.priorIntent)
      || !object(intent.recovery.originalLease) || intent.recovery.historicReleaseCommitted !== true
      || intent.recovery.routeVerified !== true || typeof intent.recovery.routeChanged !== 'boolean'
      || !object(intent.releaseCompletion)) {
      invalid('Explicit release recovery must preserve the release intent and completion evidence.');
    }
  }
  if (intent.releaseCompletion !== undefined) {
    const completion = intent.releaseCompletion;
    if (intent.policy !== 'released' || intent.release === null || !object(completion)
      || completion.kind !== 'explicit-release-completion' || !UUID.test(completion.operationId)
      || !UUID.test(completion.releaseOperationId) || !time(completion.completedAt)
      || typeof completion.routeChanged !== 'boolean' || completion.routeVerified !== true
      || !object(completion.routeEvidence) || !object(completion.recordCommit)) {
      invalid('Explicit release completion evidence is invalid.');
    }
  }
  if (intent.migration !== undefined) validateMigration(intent.migration);
}
function parseEvidenceJson(bytes) {
  let input;
  try { input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { invalid('Control evidence contains invalid UTF-8.'); }
  let cursor = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(input[cursor] ?? '') && cursor < input.length) cursor++; };
  const string = () => {
    if (input[cursor] !== '"') invalid('Control JSON contains an invalid string or object key.');
    const start = cursor++;
    while (cursor < input.length) {
      const value = input[cursor++];
      if (value === '\\') cursor++;
      else if (value === '"') {
        try { return JSON.parse(input.slice(start, cursor)); }
        catch { invalid('Control JSON string is invalid.'); }
      }
    }
    invalid('Control JSON string was interrupted.');
  };
  const value = depth => {
    if (depth > 64) invalid('Control evidence exceeds the bounded JSON nesting depth.');
    whitespace();
    const token = input[cursor];
    if (token === '"') { string(); return; }
    if (token === '{') {
      cursor++; whitespace(); const keys = new Set();
      if (input[cursor] === '}') { cursor++; return; }
      while (cursor < input.length) {
        whitespace(); const key = string();
        if (keys.has(key)) invalid('Duplicate decoded JSON keys make historical control evidence ambiguous.');
        keys.add(key); whitespace();
        if (input[cursor++] !== ':') invalid('Control JSON object separator is invalid.');
        value(depth + 1); whitespace();
        if (input[cursor] === '}') { cursor++; return; }
        if (input[cursor++] !== ',') invalid('Control JSON object delimiter is invalid.');
      }
      invalid('Control JSON object was interrupted.');
    }
    if (token === '[') {
      cursor++; whitespace();
      if (input[cursor] === ']') { cursor++; return; }
      while (cursor < input.length) {
        value(depth + 1); whitespace();
        if (input[cursor] === ']') { cursor++; return; }
        if (input[cursor++] !== ',') invalid('Control JSON array delimiter is invalid.');
      }
      invalid('Control JSON array was interrupted.');
    }
    const start = cursor;
    while (cursor < input.length && !/[\t\n\r ,}\]]/.test(input[cursor])) cursor++;
    if (cursor === start) invalid('Control JSON value is invalid.');
  };
  value(0); whitespace();
  if (cursor !== input.length) invalid('Control JSON contains trailing or unsupported bytes.');
  try { return JSON.parse(input); }
  catch { invalid('Control evidence is not valid JSON.'); }
}
function parseLegacy(bytes) {
  const intent = parseEvidenceJson(bytes);

  if (object(intent) && Object.hasOwn(intent, 'migration')) invalid('Legacy migration metadata is reserved; do not infer a second conversion.');
  validateControlIntent(intent);
  return intent;
}
function validateMigration(marker) {
  if (!object(marker) || marker.format !== LEGACY_CONTROL_FORMAT) invalid('Unknown legacy migration evidence format.');
  if (marker.schemaVersion !== CONTROL_RECORD_VERSION) {
    fail('CONTROL_RECORD_VERSION_UNSUPPORTED', { schemaVersion: marker.schemaVersion ?? null });
  }
  if (!SHA256.test(marker.sourceSha256) || !Number.isSafeInteger(marker.sourceByteLength)
    || marker.sourceByteLength <= 0 || marker.sourceByteLength > MAX_BYTES || !text(marker.sourceBase64)
    || !UUID.test(marker.operationId) || !time(marker.importedAt)
    || marker.authorizationEstablished !== false || marker.routeChanged !== false
    || marker.historicReleasePreserved !== true) invalid('Legacy migration receipt is invalid.');
  const bytes = Buffer.from(marker.sourceBase64, 'base64');
  if (bytes.toString('base64') !== marker.sourceBase64 || bytes.length !== marker.sourceByteLength
    || hash(bytes) !== marker.sourceSha256) invalid('Legacy raw bytes or fingerprint do not match the migration receipt.');
  return { bytes, intent: parseLegacy(bytes) };
}
function validateEnvelope(envelope, revision, previousSha256) {
  if (!object(envelope) || envelope.format !== CONTROL_RECORD_FORMAT) invalid('Unknown control record format.');
  if (envelope.schemaVersion !== CONTROL_RECORD_VERSION) {
    fail('CONTROL_RECORD_VERSION_UNSUPPORTED', { schemaVersion: envelope.schemaVersion ?? null });
  }
  if (envelope.revision !== revision || !UUID.test(envelope.operationId)
    || envelope.previousSha256 !== previousSha256
    || (previousSha256 !== null && !SHA256.test(previousSha256))) invalid('Control revision chain or operation identity is invalid.');
  if (envelope.committedAt !== undefined && !time(envelope.committedAt)) invalid('Control revision timestamp is invalid.');
  validateControlIntent(envelope.intent);
  return envelope;
}
function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function assertDirectories(path, trustedRoot = null) {
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const entry = stat(cursor);
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) invalid('Control storage must use ordinary local directories, not links or files.');
    if (trustedRoot !== null && cursor === trustedRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
  }
}
function assertWithin(path, trustedRoot) {
  const child = relative(trustedRoot, path);
  if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) {
    invalid('Control storage paths must remain inside the trusted profile directory.');
  }
}
function readBytes(path) {
  const entry = stat(path);
  if (!entry || !entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES) invalid('Committed control revision is not a bounded regular file.');
  return readFileSync(path);
}
function parse(bytes) { return parseEvidenceJson(bytes); }
function decodeBase64(value) {
  if (!text(value) || value.length > Math.ceil(MAX_BYTES / 3) * 4 || value.length % 4 !== 0) invalid('Control checkpoint envelope encoding is invalid.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) invalid('Control checkpoint envelope encoding is invalid.');
  return bytes;
}
function validateCheckpoint(checkpoint) {
  if (!object(checkpoint) || checkpoint.format !== CONTROL_CHECKPOINT_FORMAT) invalid('Unknown control checkpoint format.');
  if (checkpoint.schemaVersion !== CONTROL_RECORD_VERSION) {
    fail('CONTROL_RECORD_VERSION_UNSUPPORTED', { schemaVersion: checkpoint.schemaVersion ?? null });
  }
  if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1 || checkpoint.revision > MAX_REVISION
    || !SHA256.test(checkpoint.envelopeSha256 ?? '') || !time(checkpoint.createdAt)) {
    invalid('Control checkpoint identity is invalid.');
  }
  const bytes = decodeBase64(checkpoint.envelopeBase64);
  if (hash(bytes) !== checkpoint.envelopeSha256) invalid('Control checkpoint envelope fingerprint is invalid.');
  const envelope = parse(bytes);
  if (!object(envelope) || envelope.format !== CONTROL_RECORD_FORMAT || envelope.schemaVersion !== CONTROL_RECORD_VERSION
    || envelope.revision !== checkpoint.revision || !UUID.test(envelope.operationId ?? '')
    || !(checkpoint.revision === 1 ? envelope.previousSha256 === null : SHA256.test(envelope.previousSha256 ?? ''))) {
    invalid('Control checkpoint envelope chain identity is invalid.');
  }
  validateControlIntent(envelope.intent);
  if (envelope.committedAt !== undefined && !time(envelope.committedAt)) invalid('Control checkpoint commit time is invalid.');
  const originBytes = decodeBase64(checkpoint.originBase64);
  if (hash(originBytes) !== checkpoint.originSha256) invalid('Control checkpoint origin fingerprint is invalid.');
  const origin = validateEnvelope(parse(originBytes), 1, null);
  if (!isDeepStrictEqual(envelope.intent.migration ?? null, origin.intent.migration ?? null)) {
    invalid('Control checkpoint lost its migration origin.');
  }
  if (origin.intent.migration) {
    const source = validateMigration(origin.intent.migration);
    const { migration: _migration, ...imported } = origin.intent;
    if (origin.operationId !== origin.intent.migration.operationId || !isDeepStrictEqual(imported, source.intent)) {
      invalid('Checkpoint migration origin must preserve the complete original intent.');
    }
  }
  const archive = checkpoint.initialArchive;
  if (!object(archive) || !/^legacy-[0-9a-f-]{36}$/.test(archive.name ?? '')
    || !UUID.test(archive.name.slice(7)) || !SHA256.test(archive.manifestSha256 ?? '')
    || !Number.isSafeInteger(archive.headRevision) || archive.headRevision < 1
    || !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1
    || !SHA256.test(checkpoint.historyDigest ?? '')) {
    invalid('Control checkpoint archive receipt is invalid.');
  }
  return { bytes, envelope, originBytes, origin };
}
function validateSealedManifest(manifest) {
  if (!object(manifest) || manifest.schemaVersion !== CONTROL_RECORD_VERSION || !object(manifest.entries)) {
    invalid('Control sealed manifest is invalid.');
  }
  const entries = {};
  for (const [name, row] of Object.entries(manifest.entries)) {
    if (!REVISION_NAME.test(name) || !object(row) || row.revision !== revisionOf(name)
      || !SHA256.test(row.sha256 ?? '')) invalid('Control sealed manifest entry is invalid.');
    if (!time(row.retainedAt)) invalid('Control sealed retention time is invalid.');
    entries[name] = { revision: row.revision, sha256: row.sha256, retainedAt: row.retainedAt };
  }
  return entries;
}


/**
 * Cooperative, local-filesystem CAS. Synced private staging bytes are published
 * by an exclusive hard link to the next immutable revision. Revision publication
 * never overwrites another writer. Optional layout maintenance seals verified
 * evidence before compacting it; network filesystems remain unsupported.
 * File-data fsync is NOT a Windows directory/power-loss durability guarantee.
 */
export function createControlIntentStore({
  directory, legacyPath, trustedRoot = null, fault = () => {},
  now = () => new Date(), retention = {}, governance = false, onMaintenance = () => {},
  allowOfflineTransition = false, autoMaintain = true, maintenanceScheduler = null,
}) {
  if (!text(directory) || !isAbsolute(directory) || rootNetworkPath(directory) || (legacyPath && (!isAbsolute(legacyPath) || rootNetworkPath(legacyPath)))) {
    invalid('Control storage and legacy evidence paths must be absolute.');
  }
  if (trustedRoot !== null && (!text(trustedRoot) || !isAbsolute(trustedRoot) || rootNetworkPath(trustedRoot))) {
    invalid('The trusted control storage profile must be an absolute local directory.');
  }
  if (typeof fault !== 'function') invalid('Control fault seam must be a function.');
  if (typeof governance !== 'boolean') invalid('Control storage governance option must be boolean.');
  const sealedMaxRevisions = retention.maxSealedRevisions ?? DEFAULT_SEALED_MAX_REVISIONS;
  const sealedMaxAgeMs = retention.maxAgeMs ?? DEFAULT_SEALED_MAX_AGE_MS;
  if (!Number.isSafeInteger(sealedMaxRevisions) || sealedMaxRevisions < 1
    || !Number.isFinite(sealedMaxAgeMs) || sealedMaxAgeMs < 0) invalid('Control retention policy is invalid.');
  const root = resolve(directory);
  const boundary = trustedRoot === null ? null : resolve(trustedRoot);
  if (boundary !== null) {
    assertWithin(root, boundary);
    if (legacyPath) assertWithin(resolve(legacyPath), boundary);
  }
  let physicalRoot;
  let viewCache = null;
  let checkpointCache = null;
  const checkpointPath = join(root, CHECKPOINT_NAME);
  const sealedRoot = join(root, SEALED_DIRECTORY);
  const sealedManifestPath = join(sealedRoot, SEALED_MANIFEST);
  const sealedRetentionPath = join(sealedRoot, SEALED_RETENTION);
  const sealedPendingPath = join(sealedRoot, SEALED_PENDING);
  const archivesRoot = join(root, LEGACY_ARCHIVES_DIRECTORY);
  let archiveCache = null;
  const clock = () => {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) invalid('Control maintenance clock is invalid.');
    return date;
  };
  const checkDirectory = () => {
    if (!allowOfflineTransition && stat(root + '.transition.json')) {
      fail('CONTROL_STORAGE_TRANSITION', {}, 'Storage downgrade was interrupted. Keep DSH closed and run recover-downgrade.');
    }
    assertDirectories(root, boundary);
    if (!stat(root)) return false;
    const actual = realpathSync.native(root);
    if (physicalRoot !== undefined && actual !== physicalRoot) invalid('Control storage identity changed.');
    physicalRoot = actual;
    return true;
  };
  const legacyBytes = () => {
    if (!legacyPath) fail('CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    assertDirectories(dirname(resolve(legacyPath)), boundary);
    const entry = stat(legacyPath);
    if (!entry) fail('CONTROL_RECORD_MIGRATION_SOURCE_MISSING');
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES) invalid('Legacy source must be a bounded ordinary local file.');
    const bytes = readFileSync(legacyPath);
    if (bytes.length === 0 || bytes.length > MAX_BYTES) invalid('Legacy source is empty or exceeds the bounded format.');
    return bytes;
  };
  const assertSource = expectedSha256 => {
    const bytes = legacyBytes();
    const actualSha256 = hash(bytes);
    if (actualSha256 !== expectedSha256) {
      fail('CONTROL_RECORD_MIGRATION_SOURCE_CHANGED', { expectedSha256, actualSha256 },
        'Legacy source changed; preserve both histories and stop instead of silently reconciling them.');
    }
    return bytes;
  };
  const revisionList = () => {
    const names = readdirSync(root);
    const revisions = names.filter(name => REVISION_NAME.test(name)).sort();
    if (names.some(name => /^v/i.test(name) && !REVISION_NAME.test(name))) invalid('Malformed committed revision name.');
    return revisions;
  };
  const checkpointFingerprint = () => {
    const entry = stat(checkpointPath);
    if (!entry) return null;
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_CHECKPOINT_BYTES) {
      invalid('Control checkpoint is not a bounded regular file.');
    }
    const bytes = readFileSync(checkpointPath);
    if (bytes.length > MAX_CHECKPOINT_BYTES) invalid('Control checkpoint exceeds its supported size.');
    return hash(bytes);
  };
  const readCheckpoint = () => {
    const entry = stat(checkpointPath);
    if (!entry) { checkpointCache = null; archiveCache = null; return null; }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_CHECKPOINT_BYTES) {
      invalid('Control checkpoint is not a bounded regular file.');
    }
    const bytes = readFileSync(checkpointPath);
    const rawSha256 = hash(bytes);
    const cached = checkpointCache?.rawSha256 === rawSha256;
    const raw = cached ? checkpointCache.value : parse(bytes);
    const value = cached ? checkpointCache.checkpoint : validateCheckpoint(raw);
    const archivePath = join(archivesRoot, raw.initialArchive.name);
    assertDirectories(archivePath, boundary);
    const manifestPath = join(archivePath, SEALED_MANIFEST);
    const archiveEntry = stat(manifestPath);
    if (!archiveEntry || !archiveEntry.isFile() || archiveEntry.isSymbolicLink() || archiveEntry.size > MAX_SEALED_MANIFEST_BYTES) {
      invalid('Control checkpoint archive receipt is unavailable.');
    }
    const archiveIdentity = `${archiveEntry.dev}:${archiveEntry.ino}:${archiveEntry.size}:${archiveEntry.mtimeMs}:${archiveEntry.ctimeMs}`;
    if (archiveCache?.sha256 !== raw.initialArchive.manifestSha256 || archiveCache.identity !== archiveIdentity) {
      const manifestBytes = readFileSync(manifestPath);
      if (hash(manifestBytes) !== raw.initialArchive.manifestSha256) invalid('Control checkpoint initial archive changed.');
      const manifest = parse(manifestBytes);
      if (!object(manifest) || manifest.format !== 'dsh-grok-search/control-archive' || manifest.schemaVersion !== 1
        || manifest.headRevision !== raw.initialArchive.headRevision || !Array.isArray(manifest.entries)
        || manifest.entries.length !== manifest.headRevision) invalid('Control initial archive manifest is invalid.');
      for (let index = 0; index < manifest.entries.length; index++) {
        const row = manifest.entries[index];
        if (!object(row) || row.name !== filename(index + 1) || !SHA256.test(row.sha256 ?? '')
          || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > MAX_BYTES) invalid('Control archive entry is invalid.');
        const entry = stat(join(archivePath, row.name));
        if (!entry || !entry.isFile() || entry.isSymbolicLink() || entry.size !== row.size) {
          invalid('Control initial archive has missing evidence.');
        }
      }
      if (manifest.entries[0].sha256 !== raw.originSha256
        || manifest.headSha256 !== manifest.entries.at(-1).sha256) invalid('Control archive origin or head fingerprint is invalid.');
      archiveCache = { sha256: raw.initialArchive.manifestSha256, identity: archiveIdentity,
        entries: manifest.entries };
    }
    if (raw.revision <= raw.initialArchive.headRevision
      && archiveCache.entries[raw.revision - 1]?.sha256 !== raw.envelopeSha256) {
      invalid('Control checkpoint does not match its sealed original revision.');
    }
    if (cached) return checkpointCache;
    checkpointCache = freeze({
      value: raw,
      checkpoint: value,
      envelope: value.envelope,
      bytes,
      rawSha256,
      sha256: hash(value.bytes),
      revision: value.envelope.revision,
    });
    return checkpointCache;
  };
  const activeRevisionRows = checkpoint => revisionList()
    .map(name => ({ name, revision: revisionOf(name) }))
    .filter(row => !checkpoint || row.revision > checkpoint.revision);
  const snapshotOnce = ({ allowUnmigratedLegacy = false } = {}) => {
    const sourcePresent = Boolean(legacyPath && stat(legacyPath));
    if (!checkDirectory()) {
      if (sourcePresent && !allowUnmigratedLegacy) fail('CONTROL_RECORD_MIGRATION_REQUIRED');
      return { envelope: null, sha256: null, origin: null, migration: null, revisionNames: '' };
    }
    const checkpoint = readCheckpoint();
    if (checkpoint) {
      const rows = activeRevisionRows(checkpoint);
      let envelope = checkpoint.envelope, previousSha256 = checkpoint.sha256, migration = envelope.intent.migration ?? null;
      if (migration) validateMigration(migration);
      let expected = checkpoint.revision + 1;
      for (const row of rows) {
        if (row.revision !== expected) invalid('Committed control history contains a gap after its checkpoint.');
        const bytes = readBytes(join(root, row.name));
        const next = validateEnvelope(parse(bytes), row.revision, previousSha256);
        if (!isDeepStrictEqual(next.intent.migration ?? null, migration)) {
          invalid('Migration origin evidence must be retained unchanged through all later revisions.');
        }
        envelope = next;
        previousSha256 = hash(bytes);
        expected++;
      }
      if (migration) assertSource(migration.sourceSha256);
      if (sourcePresent && !migration && !allowUnmigratedLegacy) {
        fail('CONTROL_RECORD_MIGRATION_REQUIRED', {}, 'Unversioned evidence exists; explicit migration is required before any new write.');
      }
      if (checkpointFingerprint() !== checkpoint.rawSha256) fail('CONTROL_LAYOUT_CHANGED');
      return { envelope: freeze(envelope), sha256: previousSha256, origin: freeze(checkpoint.checkpoint.origin),
        migration, revisionNames: rows.map(row => row.name).join('\0') };
    }
    const revisions = revisionList();
    let envelope = null, previousSha256 = null, origin = null, migration = null;
    for (let index = 0; index < revisions.length; index++) {
      const revision = index + 1;
      if (revisions[index] !== filename(revision)) invalid('Committed control history contains a gap.');
      const bytes = readBytes(join(root, revisions[index]));
      envelope = validateEnvelope(parse(bytes), revision, previousSha256);
      if (index === 0) {
        origin = envelope;
        migration = envelope.intent.migration ?? null;
        if (migration) {
          const source = validateMigration(migration);
          const { migration: _migration, ...imported } = envelope.intent;
          if (envelope.operationId !== migration.operationId || !isDeepStrictEqual(imported, source.intent)) {
            invalid('The initial migrated revision must preserve the entire original intent without authorization or release changes.');
          }
          assertSource(migration.sourceSha256);
        }
      } else if (!isDeepStrictEqual(envelope.intent.migration ?? null, migration)) {
        invalid('Migration origin evidence must be retained unchanged through all later revisions.');
      }
      previousSha256 = hash(bytes);
    }
    if (sourcePresent && !migration && !allowUnmigratedLegacy) {
      fail('CONTROL_RECORD_MIGRATION_REQUIRED', {}, 'Unversioned evidence exists; explicit migration is required before any new write.');
    }
    if (stat(checkpointPath)) fail('CONTROL_LAYOUT_CHANGED');
    return { envelope: envelope ? freeze(envelope) : null, sha256: previousSha256,
      origin: origin ? freeze(origin) : null, migration, revisionNames: revisions.join('\0') };
  };
  const snapshot = options => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!checkDirectory()) return snapshotOnce(options);
      const fingerprint = checkpointFingerprint();
      try { return snapshotOnce(options); }
      catch (error) {
        const changed = checkpointFingerprint() !== fingerprint;
        if (error.code !== 'CONTROL_LAYOUT_CHANGED' && !changed) throw error;
        if (attempt === 2) fail('CONTROL_STORAGE_BUSY', {}, 'Control storage layout changed during read; retry the operation.');
      }
    }
  };
  // Presentation only: unchanged names, latest bytes and legacy source reuse a
  // fully validated envelope. Old in-place edits with those inputs unchanged
  // are detected by read()/CAS or the next cache miss, not by stable UI polling.
  // Every cache miss validates the entire chain; this cache never authorizes writes.
  const snapshotViewOnce = () => {
    if (!checkDirectory()) {
      viewCache = null;
      return snapshot().envelope;
    }
    const checkpoint = readCheckpoint();
    const revisions = activeRevisionRows(checkpoint).map(row => row.name);
    const revisionNames = revisions.join('\0');
    const checkpointSha256 = checkpoint?.rawSha256 ?? null;
    const tailSha256 = revisions.length ? hash(readBytes(join(root, revisions.at(-1)))) : checkpoint?.sha256 ?? null;
    const sourceSha256 = legacyPath && stat(legacyPath) ? hash(legacyBytes()) : null;
    if (viewCache && viewCache.revisionNames === revisionNames && viewCache.sha256 === tailSha256
      && viewCache.checkpointSha256 === checkpointSha256 && viewCache.sourceSha256 === sourceSha256) return viewCache.envelope;
    viewCache = null;
    const verified = snapshot();
    viewCache = { envelope: verified.envelope, revisionNames: verified.revisionNames,
      sha256: verified.sha256, checkpointSha256, sourceSha256: verified.migration?.sourceSha256 ?? null };
    return verified.envelope;
  };
  const snapshotView = () => {
    if (!checkDirectory()) return snapshotViewOnce();
    const fingerprint = checkpointFingerprint();
    try { return snapshotViewOnce(); }
    catch (error) {
      const changed = checkpointFingerprint() !== fingerprint;
      if (!changed) throw error;
      viewCache = null;
      return snapshot().envelope;
    }
  };
  const writeAtomicJson = (target, value, stagePrefix) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    if (bytes.length > MAX_SEALED_MANIFEST_BYTES) invalid('Control maintenance metadata exceeds its supported size; old storage remains intact.');
    const stage = join(dirname(target), `${stagePrefix}-${randomUUID()}.json`);
    let fd;
    try {
      fd = openSync(stage, 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(stage, target);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(stage); } catch {}
      throw error;
    }
  };
  const publishSealedEvidence = (target, bytes) => {
    if (stat(target)) {
      if (hash(readBytes(target)) !== hash(bytes)) invalid('Sealed evidence conflicts with the verified source.');
      return;
    }
    const stage = join(dirname(target), `.evidence-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(stage, 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      if (hash(readBytes(stage)) !== hash(bytes)) invalid('Sealed evidence staging verification failed.');
      fault('before-sealed-evidence-publish', { byteLength: bytes.length });
      try { linkSync(stage, target); }
      catch (error) {
        if (error.code !== 'EEXIST' || hash(readBytes(target)) !== hash(bytes)) throw error;
      }
      if (hash(readBytes(target)) !== hash(bytes)) invalid('Sealed evidence readback failed.');
    } finally {
      if (fd !== undefined) closeSync(fd);
      // A crash can leave this private stage, but can never publish half a
      // revision. Ordinary retries ignore leftover stages rather than promote
      // them or overwrite a previous final evidence file.
      if (stat(stage)) unlinkSync(stage);
    }
  };
  const ensureSealedDirectory = () => {
    assertDirectories(root, boundary);
    if (!stat(sealedRoot)) mkdirSync(sealedRoot, { recursive: true, mode: 0o700 });
    const entry = stat(sealedRoot);
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) invalid('Control sealed storage is not an ordinary directory.');
    assertDirectories(sealedRoot, boundary);
  };
  const readSealedManifest = () => {
    if (stat(sealedRoot)) assertDirectories(sealedRoot, boundary);
    const entry = stat(sealedManifestPath);
    if (!entry) return {};
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SEALED_MANIFEST_BYTES) {
      invalid('Control sealed manifest is not a bounded regular file.');
    }
    return validateSealedManifest(parse(readFileSync(sealedManifestPath)));
  };
  const writeSealedManifest = entries => {
    const ordered = Object.fromEntries(Object.entries(entries)
      .sort(([left], [right]) => left.localeCompare(right)));
    writeAtomicJson(sealedManifestPath, { schemaVersion: CONTROL_RECORD_VERSION, entries: ordered }, 'manifest-stage');
  };
  const removeStageLinks = identities => {
    const targets = new Map(identities.filter(entry => entry)
      .map(entry => [`${entry.dev}:${entry.ino}`, entry.sha256]));
    if (!targets.size) return 0;
    let removed = 0;
    for (const name of readdirSync(root)) {
      if (!/^stage-[0-9a-f-]+\.json$/i.test(name)) continue;
      try {
        const entry = lstatSync(join(root, name));
        const digest = targets.get(`${entry.dev}:${entry.ino}`);
        if (digest && entry.isFile() && !entry.isSymbolicLink() && entry.size <= MAX_BYTES
          && hash(readBytes(join(root, name))) === digest) {
          unlinkSync(join(root, name));
          removed++;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return removed;
  };
  const appendRetentionAudit = deleted => {
    let previous = [];
    const entry = stat(sealedRetentionPath);
    if (entry) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SEALED_MANIFEST_BYTES) invalid('Control retention receipt is invalid.');
      const parsed = parse(readFileSync(sealedRetentionPath));
      if (!object(parsed) || parsed.schemaVersion !== CONTROL_RECORD_VERSION || !Array.isArray(parsed.deleted)
        || parsed.deleted.some(row => !object(row) || !Number.isSafeInteger(row.revision)
          || !SHA256.test(row.sha256 ?? '') || !time(row.deletedAt))) {
        invalid('Control retention receipt contains invalid entries.');
      }
      previous = parsed.deleted;
    }
    const combined = [...new Map([...previous, ...deleted].map(row => [row.revision, row])).values()].slice(-1000);
    writeAtomicJson(sealedRetentionPath, { schemaVersion: CONTROL_RECORD_VERSION, deleted: combined }, 'retention-stage');
  };
  const finishRetention = manifest => {
    const pendingStat = stat(sealedPendingPath);
    if (!pendingStat) return [];
    if (!pendingStat.isFile() || pendingStat.isSymbolicLink() || pendingStat.size > MAX_SEALED_MANIFEST_BYTES) {
      invalid('Pending control retention receipt is invalid.');
    }
    const pending = parse(readFileSync(sealedPendingPath));
    if (!object(pending) || pending.schemaVersion !== 1 || !Array.isArray(pending.entries)
      || !time(pending.at) || pending.entries.some(row => !object(row) || !REVISION_NAME.test(row.name ?? '')
        || !SHA256.test(row.sha256 ?? ''))) invalid('Pending control retention entries are invalid.');
    const checkpoint = readCheckpoint();
    const deleted = [];
    for (const row of pending.entries) {
      if (!checkpoint || revisionOf(row.name) >= checkpoint.revision
        || revisionOf(row.name) <= checkpoint.value.initialArchive.headRevision) {
        invalid('Retention cannot remove active or initial-archive evidence.');
      }
      const path = join(sealedRoot, row.name);
      const entry = stat(path);
      if (manifest[row.name] && manifest[row.name].sha256 !== row.sha256) invalid('Retention target changed.');
      if (entry) {
        if (hash(readBytes(path)) !== row.sha256) invalid('Control retention target failed fingerprint verification.');
        fault('before-retention-delete', { revision: revisionOf(row.name) });
        unlinkSync(path);
        fault('after-retention-delete', { revision: revisionOf(row.name) });
      }
      delete manifest[row.name];
      deleted.push({ revision: revisionOf(row.name), sha256: row.sha256, deletedAt: pending.at });
    }
    writeSealedManifest(manifest);
    appendRetentionAudit(deleted);
    unlinkSync(sealedPendingPath);
    return deleted;
  };
  const pruneSealed = ({ at = clock(), manifest = readSealedManifest() } = {}) => {
    if (!stat(sealedRoot)) return { deleted: [] };
    const recovered = finishRetention(manifest);
    const rows = [];
    for (const [name, row] of Object.entries(manifest)) {
      const fullPath = join(sealedRoot, name);
      const entry = stat(fullPath);
      if (!entry || !entry.isFile() || entry.isSymbolicLink()) invalid('Sealed control history is missing or unsafe.');
      rows.push({ name, row, path: fullPath, retainedMs: Date.parse(row.retainedAt) });
    }
    if (!rows.length) return { deleted: recovered };
    rows.sort((left, right) => left.row.revision - right.row.revision);
    const cutoff = at.getTime() - sealedMaxAgeMs;
    const remove = new Set();
    for (const row of rows) {
      if (row.retainedMs < cutoff) remove.add(row.name);
    }
    let remaining = rows.length - remove.size;
    for (const row of rows) {
      if (remaining <= sealedMaxRevisions) break;
      if (!remove.has(row.name)) { remove.add(row.name); remaining--; }
    }
    const planned = [];
    for (const row of rows) {
      if (!remove.has(row.name)) continue;
      if (hash(readBytes(row.path)) !== row.row.sha256) invalid('Sealed control history fingerprint mismatch.');
      planned.push({ name: row.name, sha256: row.row.sha256 });
    }
    if (planned.length) {
      writeAtomicJson(sealedPendingPath, { schemaVersion: 1, at: at.toISOString(), entries: planned }, 'retention-stage');
      recovered.push(...finishRetention(manifest));
    }
    return { deleted: recovered };
  };
  const sealInitialArchive = (verified, at) => {
    const names = revisionList();
    const head = verified.envelope.revision;
    const retainedNames = names.filter(name => revisionOf(name) <= head);
    // Reuse the same migration receipt after an interruption at the same
    // verified head, rather than accumulating a full archive on every retry.
    const name = `legacy-${verified.envelope.operationId}`;
    const archivePath = join(archivesRoot, name);
    assertDirectories(archivesRoot, boundary);
    mkdirSync(archivePath, { recursive: true, mode: 0o700 });
    assertDirectories(archivePath, boundary);
    const entries = [];
    let previousSha256 = null;
    for (const revisionName of retainedNames) {
      fault('maintenance-progress', { revision: revisionOf(revisionName), phase: 'initial-archive' });
      const revision = revisionOf(revisionName);
      const bytes = readBytes(join(root, revisionName));
      validateEnvelope(parse(bytes), revision, previousSha256);
      const sha256 = hash(bytes), target = join(archivePath, revisionName);
      publishSealedEvidence(target, bytes);
      if (hash(readBytes(target)) !== sha256) invalid('Initial control archive failed byte-exact verification.');
      entries.push({ name: revisionName, size: bytes.length, sha256 });
      previousSha256 = sha256;
    }
    if (entries.length !== head || previousSha256 !== verified.sha256) invalid('Initial archive does not match the verified control head.');
    const manifest = { format: 'dsh-grok-search/control-archive', schemaVersion: 1,
      archivedAt: at.toISOString(), headRevision: head, headSha256: previousSha256, entries };
    const manifestPath = join(archivePath, SEALED_MANIFEST);
    if (stat(manifestPath)) {
      const manifestStat = stat(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_SEALED_MANIFEST_BYTES) {
        invalid('Existing initial-archive manifest is unsafe or exceeds its supported size.');
      }
      const existing = parse(readFileSync(manifestPath));
      if (existing.headRevision !== head || existing.headSha256 !== previousSha256
        || !isDeepStrictEqual(existing.entries, entries)) invalid('Initial archive conflicts with a prior migration attempt.');
    } else writeAtomicJson(manifestPath, manifest, 'manifest-stage');
    const manifestSha256 = hash(readFileSync(manifestPath));
    fault('after-initial-archive', { name, headRevision: head, manifestSha256 });
    return { name, manifestSha256, headRevision: head };
  };
  const retainRollingRevision = (name, bytes, at, manifest) => {
    ensureSealedDirectory();
    const sha256 = hash(bytes), path = join(sealedRoot, name);
    const existing = stat(path);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || hash(readBytes(path)) !== sha256) {
        invalid('Control sealed revision conflicts with verified evidence.');
      }
    } else publishSealedEvidence(path, bytes);
    if (hash(readBytes(path)) !== sha256) invalid('Sealed control revision failed readback.');
    manifest[name] ??= { revision: revisionOf(name), sha256,
      retainedAt: parse(bytes).committedAt ?? at.toISOString() };
  };
  const removeArchivedRootFiles = checkpoint => {
    const retired = [];
    const archivePath = join(archivesRoot, checkpoint.value.initialArchive.name);
    const manifest = readSealedManifest();
    let removed = 0;
    for (const name of revisionList()) {
      fault('maintenance-progress', { revision: revisionOf(name), phase: 'verify-sealed-links' });
      const revision = revisionOf(name);
      if (revision > checkpoint.revision) continue;
      const path = join(root, name), bytes = readBytes(path), sha256 = hash(bytes);
      let retained;
      if (revision === checkpoint.revision) retained = checkpoint.sha256 === sha256;
      else if (revision <= checkpoint.value.initialArchive.headRevision) {
        const archived = join(archivePath, name);
        retained = stat(archived) && hash(readBytes(archived)) === sha256;
      } else {
        const sealed = join(sealedRoot, name);
        retained = manifest[name]?.sha256 === sha256 && stat(sealed) && hash(readBytes(sealed)) === sha256;
      }
      if (!retained) invalid('Control revision cannot be removed before verified sealing.');
      retired.push({ name, path, revision, ...stat(path), sha256 });
    }
    // Remove duplicate staging links first. If this phase is interrupted or a
    // known link cannot be removed, its committed root remains discoverable on
    // the next maintenance; unknown unpublished stages are still untouched.
    removeStageLinks(retired);
    for (const entry of retired) {
      const { path, revision, sha256 } = entry;
      fault('maintenance-progress', { revision, phase: 'remove-sealed-links' });
      const current = stat(path);
      if (!current || current.dev !== entry.dev || current.ino !== entry.ino
        || hash(readBytes(path)) !== sha256) invalid('Retired control revision changed during cleanup.');
      unlinkSync(path);
      removed++;
    }
    return removed;
  };
  let lastMaintenance = null;
  const maintain = ({ expectedRevision, force = false } = {}) => {
    const assertRevision = value => {
      const actualRevision = value?.envelope?.revision ?? 0;
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision)
        || expectedRevision !== actualRevision)) fail('CONTROL_CAS_CONFLICT', { expectedRevision, actualRevision });
    };
    if (!checkDirectory()) {
      assertRevision(null);
      return freeze({ status: 'empty', migrated: false });
    }
    const at = clock();
    const preliminary = snapshot();
    assertRevision(preliminary);
    fault('after-maintenance-snapshot', { revision: preliminary.envelope?.revision ?? 0 });
    if (!preliminary.envelope) return freeze({ status: 'empty', migrated: false });
    if (!force && !stat(checkpointPath) && preliminary.envelope.revision <= ACTIVE_CONTROL_REVISIONS) {
      return freeze({ status: 'unchanged', migrated: false, latestRevision: preliminary.envelope.revision });
    }
    let lock;
    try {
      lock = acquireOwnedLock(join(root, CHECKPOINT_LOCK), {
        reclaimStaleAfterMs: DEFAULT_STALE_LOCK_MS, now: at.getTime(),
      });
      // The maintenance lock serializes maintainers only, not user writes.
      // Initial archive creation can take seconds and must not block CAS.
      const verified = snapshot();
      assertRevision(verified);
      const preparedArchive = !stat(checkpointPath) ? sealInitialArchive(verified, at) : null;
      return maintainLocked(verified, preparedArchive);
    } catch (error) {
      if (error.code === 'EEXIST') {
        lastMaintenance = freeze({ status: 'busy', at: at.toISOString() });
        return lastMaintenance;
      }
      throw error;
    } finally {
      lock?.release();
    }
    function maintainLocked(verified, preparedArchive) {
      const latest = verified.envelope.revision;
      const current = readCheckpoint(), target = Math.max(1, latest - ACTIVE_CONTROL_REVISIONS);
      let checkpoint = current, moved = 0, migrated = false;
      if (!current || target > current.revision) {
        const initialArchive = current?.value.initialArchive ?? preparedArchive;
        const targetBytes = target === current?.revision ? current.checkpoint.bytes : readBytes(join(root, filename(target)));
        const originBytes = current?.checkpoint.originBytes ?? readBytes(join(root, filename(1)));
        const manifest = readSealedManifest();
        const start = current?.revision ?? 1;
        const digests = [];
        for (let revision = start; revision <= target; revision++) {
          fault('maintenance-progress', { revision, phase: 'checkpoint' });
          const name = filename(revision);
          const bytes = revision === current?.revision ? current.checkpoint.bytes : readBytes(join(root, name));
          digests.push(`${revision}:${hash(bytes)}\n`);
          if (revision > initialArchive.headRevision && revision < target) retainRollingRevision(name, bytes, at, manifest);
          moved++;
        }
        if (Object.keys(manifest).length) writeSealedManifest(manifest);
        const value = {
          format: CONTROL_CHECKPOINT_FORMAT, schemaVersion: CONTROL_RECORD_VERSION,
          generation: (current?.value.generation ?? 0) + 1, revision: target,
          envelopeBase64: targetBytes.toString('base64'), envelopeSha256: hash(targetBytes),
          originBase64: originBytes.toString('base64'), originSha256: hash(originBytes),
          initialArchive,
          historyDigest: hash((current?.value.historyDigest ?? '') + digests.join('')),
          createdAt: at.toISOString(),
        };
        validateCheckpoint(value);
        fault('before-checkpoint-publish', { from: current?.revision ?? 0, to: target });
        // The archive and rolling evidence are complete before the layout
        // switches. The immutable next-revision namespace remains the CAS point.
        // Only the pointer publication needs the writer lock. Appended
        // revisions are not removed: this verified prefix remains valid even
        // when the user commits a newer head while the archive is being built.
        const publishedLatest = snapshot();
        assertRevision(publishedLatest);
        if (publishedLatest.envelope.revision < latest) invalid('Control history moved backwards during maintenance.');
        let writer;
        try { writer = acquireOwnedLock(join(root, CONTROL_WRITE_LOCK), { reclaimStaleAfterMs: DEFAULT_STALE_LOCK_MS }); }
        catch (error) {
          if (error.code === 'EEXIST') return freeze({ status: 'busy', reason: 'writer-active', at: at.toISOString() });
          throw error;
        }
        try {
          if (readCheckpoint()?.rawSha256 !== current?.rawSha256) fail('CONTROL_LAYOUT_CHANGED');
          // Full verification happens before taking the user writer lock.
          // Cooperative writers only append immutable revisions: unchanged
          // names, tail bytes and migration source preserve that observation.
          const names = activeRevisionRows(current).map(row => row.name);
          if (names.join('\0') !== publishedLatest.revisionNames) {
            return freeze({ status: 'busy', reason: 'writer-changed', at: at.toISOString() });
          }
          const tail = names.length ? readBytes(join(root, names.at(-1))) : current.checkpoint.bytes;
          if (hash(tail) !== publishedLatest.sha256) invalid('Control history changed during checkpoint publication.');
          if (publishedLatest.migration) assertSource(publishedLatest.migration.sourceSha256);
          writeAtomicJson(checkpointPath, value, 'checkpoint-stage');
        } finally { writer.release(); }
        fault('after-checkpoint-publish', { from: current?.revision ?? 0, to: target });
        checkpoint = readCheckpoint();
        migrated = !current;
      }
      const removed = removeArchivedRootFiles(checkpoint);
      const pruned = pruneSealed({ at });
      // Orphan staging entries without a verified retained copy are left alone.
      lastMaintenance = freeze({
        status: migrated ? 'migrated' : moved ? 'compacted' : 'unchanged',
        at: at.toISOString(), checkpointRevision: checkpoint.revision,
        latestRevision: latest, moved, removed, migrated,
        legacyArchiveRetained: true, pruned: pruned.deleted.length,
        prunedRevisions: pruned.deleted.map(row => row.revision),
      });
      return lastMaintenance;
    }
  };
  const maintainAfterWrite = envelope => {
    if (!governance) return null;
    const failed = error => {
      lastMaintenance = freeze({ status: 'error', code: error.code ?? null,
        message: error.message, writeCommitted: true });
      try { onMaintenance(lastMaintenance); } catch {}
      return lastMaintenance;
    };
    try {
      if (maintenanceScheduler) {
        if (envelope.revision <= ACTIVE_CONTROL_REVISIONS && !stat(checkpointPath)) return null;
        const scheduled = maintenanceScheduler(envelope);
        return scheduled?.then ? Promise.resolve(scheduled).catch(failed) : scheduled;
      }
      return autoMaintain ? maintain() : null;
    } catch (error) { return failed(error); }
  };
  const withWriterLock = action => {
    if (!governance && !stat(checkpointPath)) return action();
    assertDirectories(root, boundary);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    checkDirectory();
    let lock;
    try {
      lock = acquireOwnedLock(join(root, CONTROL_WRITE_LOCK), { reclaimStaleAfterMs: DEFAULT_STALE_LOCK_MS });
    } catch (error) {
      if (error.code === 'EEXIST') fail('CONTROL_STORAGE_BUSY', {}, 'Control history is being committed or maintained; retry after it finishes.');
      throw error;
    }
    try { return action(); } finally { lock.release(); }
  };
  const preservedPublishedBytes = revision => {
    const path = join(root, filename(revision));
    if (stat(path)) return readBytes(path);
    const checkpoint = readCheckpoint();
    if (checkpoint?.revision === revision) return checkpoint.checkpoint.bytes;
    if (checkpoint && revision <= checkpoint.value.initialArchive.headRevision) {
      return readBytes(join(archivesRoot, checkpoint.value.initialArchive.name, filename(revision)));
    }
    if (checkpoint && revision < checkpoint.revision) return readBytes(join(sealedRoot, filename(revision)));
    invalid('Committed revision disappeared without a verified retained copy.');
  };
  const publish = ({ expectedRevision, intent, operationId, before, sourceCheck = () => {} }) => {
    const actualRevision = before.envelope?.revision ?? 0;
    if (actualRevision !== expectedRevision) fail('CONTROL_CAS_CONFLICT', { expectedRevision, actualRevision });
    const candidate = jsonCopy({ format: CONTROL_RECORD_FORMAT, schemaVersion: CONTROL_RECORD_VERSION,
      revision: expectedRevision + 1, operationId, previousSha256: before.sha256, intent,
      ...(governance ? { committedAt: clock().toISOString() } : {}) });
    validateEnvelope(candidate, expectedRevision + 1, before.sha256);
    const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
    // Reject evidence the strict reader cannot consume before any publication.
    parseEvidenceJson(bytes);
    if (bytes.length > MAX_BYTES) invalid('Control revision exceeds maximum size, including preserved raw migration bytes.');
    const stagePath = join(root, `stage-${randomUUID()}.json`);
    const targetPath = join(root, filename(candidate.revision));
    let published = false;
    try {
      assertDirectories(root, boundary);
      mkdirSync(root, { recursive: true });
      checkDirectory();
      fault('before-stage-write', { expectedRevision, operationId, stagePath, targetPath });
      sourceCheck();
      const fd = openSync(stagePath, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); }
      finally { closeSync(fd); }
      fault('before-publish', { expectedRevision, operationId, stagePath, targetPath });
      sourceCheck();
      if (governance || stat(checkpointPath)) {
        const latest = snapshot();
        if ((latest.envelope?.revision ?? 0) !== expectedRevision || latest.sha256 !== before.sha256) {
          fail('CONTROL_CAS_CONFLICT', { expectedRevision, actualRevision: latest.envelope?.revision ?? 0 });
        }
      }
      // This exclusive namespace publication, not the earlier read, is the CAS linearization point.
      try { linkSync(stagePath, targetPath); }
      catch (error) {
        if (error.code === 'EEXIST') fail('CONTROL_CAS_CONFLICT', { expectedRevision, attemptedRevision: candidate.revision });
        throw error;
      }
      published = true;
      fault('after-publish', { expectedRevision, operationId, stagePath, targetPath });
      sourceCheck();
      if (hash(preservedPublishedBytes(candidate.revision)) !== hash(bytes)) invalid('Published control revision failed readback.');
      return freeze(candidate);
    } catch (error) {
      if (!published && error instanceof ControlRecordError) throw error;
      const code = published ? 'CONTROL_RECORD_COMMIT_UNCERTAIN' : 'CONTROL_RECORD_WRITE_FAILED';
      fail(code, { expectedRevision, attemptedRevision: candidate.revision, operationId,
        published, causeCode: error.code ?? null }, published
        ? 'Publication may have committed; read the revision/operation ID before retrying.'
        : 'Control write did not publish; existing committed evidence was not overwritten.');
    }
  };
  return Object.freeze({
    directory: root,
    read() { return snapshot().envelope; },
    readView() { return snapshotView(); },
    inspectLegacy() {
      const bytes = legacyBytes(), intent = parseLegacy(bytes);
      return freeze({ format: LEGACY_CONTROL_FORMAT, schemaVersion: CONTROL_RECORD_VERSION,
        sha256: hash(bytes), byteLength: bytes.length, intent: jsonCopy(intent) });
    },
    migrateLegacy({ expectedRevision, expectedLegacySha256, operationId } = {}) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || !SHA256.test(expectedLegacySha256) || !UUID.test(operationId)) {
        invalid('Explicit migration requires the original revision, inspected SHA-256 and a caller-owned operation ID.');
      }
      if (expectedRevision !== 0) fail('CONTROL_CAS_CONFLICT', { expectedRevision, requiredInitialRevision: 0 });
      const bytes = assertSource(expectedLegacySha256), original = parseLegacy(bytes);
      const before = snapshot({ allowUnmigratedLegacy: true });
      if (before.envelope) {
        if (before.migration?.operationId === operationId && before.migration.sourceSha256 === expectedLegacySha256) {
          return freeze({ kind: 'already-migrated', recordCommitted: false, migrationCommitted: true,
            resolution: 'same-operation-readback', routeChanged: false, authorizationEstablished: false,
            envelope: before.envelope, originRevision: 1 });
        }
        fail('CONTROL_CAS_CONFLICT', { expectedRevision, actualRevision: before.envelope.revision },
          'A versioned history already exists; explicit migration must not overwrite, merge or rebase it.');
      }
      const migration = { format: LEGACY_CONTROL_FORMAT, schemaVersion: CONTROL_RECORD_VERSION,
        sourceSha256: expectedLegacySha256, sourceByteLength: bytes.length, sourceBase64: bytes.toString('base64'),
        operationId, importedAt: clock().toISOString(), authorizationEstablished: false,
        routeChanged: false, historicReleasePreserved: true };
      try {
        const envelope = publish({ expectedRevision: 0, intent: { ...original, migration }, operationId, before,
          sourceCheck: () => assertSource(expectedLegacySha256) });
        maintainAfterWrite(envelope);
        return freeze({ kind: 'migrated', recordCommitted: true, migrationCommitted: true,
          routeChanged: false, authorizationEstablished: false, envelope, originRevision: 1 });
      } catch (error) {
        if (error instanceof ControlRecordError) error.migrationOutcome = freeze({ kind: 'incomplete',
          recordCommitted: error.code === 'CONTROL_RECORD_COMMIT_UNCERTAIN' ? null : false,
          routeChanged: false, authorizationEstablished: false, operationId, expectedLegacySha256 });
        throw error;
      }
    },
    compareAndSwap({ expectedRevision, intent, operationId = randomUUID() }) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= MAX_REVISION
        || !UUID.test(operationId)) invalid('Expected revision or operation ID is invalid.');
      const envelope = withWriterLock(() => {
        const before = snapshot();
        if (!isDeepStrictEqual(intent?.migration ?? null, before.migration)) {
          invalid('Only explicit migration can introduce origin evidence; later writes must preserve it unchanged.');
        }
        return publish({ expectedRevision, intent, operationId, before,
          sourceCheck: before.migration ? () => assertSource(before.migration.sourceSha256) : undefined });
      });
      maintainAfterWrite(envelope);
      return envelope;
    },
    async compareAndSwapAsync(request) {
      const captured = { ...request, intent: jsonCopy(request?.intent), operationId: request?.operationId ?? randomUUID() };
      const deadline = performance.now() + 250;
      for (;;) {
        captured.signal?.throwIfAborted();
        try { return this.compareAndSwap(captured); }
        catch (error) {
          if (error.code !== 'CONTROL_STORAGE_BUSY' || performance.now() >= deadline) throw error;
          // Only contention with storage maintenance is retried. A changed
          // revision is a genuine conflict, never merged or overwritten here.
          await delay(5, undefined, { signal: captured.signal });
        }
      }
    },
    maintain(options) { return maintain(options); },
    scheduleMaintenance() {
      if (!maintenanceScheduler || !checkDirectory()) return false;
      const revisions = revisionList();
      if (stat(checkpointPath) || revisionOf(revisions.at(-1) ?? filename(0)) > ACTIVE_CONTROL_REVISIONS) {
        maintenanceScheduler();
        return true;
      }
      return false;
    },
    inspectStorage() {
      if (!checkDirectory()) return freeze({ exists: false, checkpoint: null, activeRevisions: [], sealed: 0 });
      const checkpoint = readCheckpoint();
      const active = activeRevisionRows(checkpoint).map(row => row.revision);
      const manifest = stat(sealedManifestPath) ? readSealedManifest() : {};
      return freeze({
        exists: true,
        checkpoint: checkpoint ? {
          revision: checkpoint.revision,
          envelopeSha256: checkpoint.sha256,
          initialArchive: { ...checkpoint.value.initialArchive },
          generation: checkpoint.value.generation,
          rawSha256: checkpoint.rawSha256,
        } : null,
        activeRevisions: active,
        latestRevision: active.at(-1) ?? checkpoint?.revision ?? 0,
        headSha256: snapshot().sha256,
        sealed: Object.keys(manifest).length,
        lastMaintenance,
      });
    },
    exportCompatibleHistory({ targetDirectory } = {}) {
      if (!text(targetDirectory) || !isAbsolute(targetDirectory) || rootNetworkPath(targetDirectory)) {
        invalid('A compatible export requires an absolute local target directory.');
      }
      const target = resolve(targetDirectory);
      const inside = relative(root, target);
      const targetInsideRoot = inside === '' || (inside !== '..'
        && !inside.startsWith('..' + sep) && !isAbsolute(inside));
      if (target === root || targetInsideRoot) {
        invalid('Compatible export must not replace or live inside the active control store.');
      }
      if (stat(target)) fail('CONTROL_EXPORT_TARGET_EXISTS', {}, 'Compatible export target must not already exist.');
      const checkpoint = readCheckpoint();
      const verified = snapshot();
      if (!verified.envelope) fail('CONTROL_EXPORT_EMPTY');
      const envelopes = [];
      const mappings = [];
      if (checkpoint) {
        envelopes.push(checkpoint.checkpoint.origin);
        mappings.push({ exportedRevision: 1, originalRevision: 1, originalSha256: checkpoint.value.originSha256,
          kind: 'original-origin' });
        if (checkpoint.revision !== 1) {
          envelopes.push(checkpoint.envelope);
          mappings.push({ exportedRevision: 2, originalRevision: checkpoint.revision,
            originalSha256: checkpoint.sha256, kind: 'checkpoint-baseline' });
        }
        const rows = activeRevisionRows(checkpoint);
        for (const row of rows) {
          const value = parse(readBytes(join(root, row.name)));
          if (!object(value) || value.revision !== row.revision || !UUID.test(value.operationId ?? '')) {
            invalid('Compatible export encountered an invalid active revision.');
          }
          validateControlIntent(value.intent);
          envelopes.push(value);
          mappings.push({ exportedRevision: envelopes.length, originalRevision: row.revision,
            originalSha256: hash(readBytes(join(root, row.name))), kind: 'active-revision' });
        }
      } else {
        for (const name of revisionList()) {
          const value = parse(readBytes(join(root, name)));
          if (!object(value) || value.revision !== revisionOf(name)) invalid('Compatible export encountered an invalid revision.');
          validateControlIntent(value.intent);
          envelopes.push(value);
          mappings.push({ exportedRevision: envelopes.length, originalRevision: value.revision,
            originalSha256: hash(readBytes(join(root, name))), kind: 'original-revision' });
        }
      }
      mkdirSync(target, { mode: 0o700 });
      assertDirectories(target, null);
      let previousSha256 = null;
      try {
        for (let index = 0; index < envelopes.length; index++) {
          const next = jsonCopy({ ...envelopes[index], revision: index + 1, previousSha256 });
          validateEnvelope(next, index + 1, previousSha256);
          const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
          parseEvidenceJson(bytes);
          const fd = openSync(join(target, filename(index + 1)), 'wx', 0o600);
          try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
          previousSha256 = hash(bytes);
        }
      } catch (error) {
        // Leave the partial export for diagnosis; never claim it is usable.
        throw error;
      }
      if (!isDeepStrictEqual(snapshot().envelope, verified.envelope)) fail('CONTROL_EXPORT_SOURCE_CHANGED');
      const readback = createControlIntentStore({ directory: target, legacyPath }).read();
      if (!isDeepStrictEqual(readback.intent, verified.envelope.intent)
        || readback.operationId !== verified.envelope.operationId) invalid('Compatible export did not preserve the latest control state.');
      writeAtomicJson(join(target, 'conversion.json'), {
        format: 'dsh-grok-search/control-downgrade', schemaVersion: 1,
        convertedAt: clock().toISOString(), sourceRevision: verified.envelope.revision,
        sourceOperationId: verified.envelope.operationId, sourceSha256: verified.sha256,
        exportedRevision: envelopes.length, exportedSha256: previousSha256,
        retainsFullHistoricalChain: !checkpoint,
        intentUnchanged: true, mappings,
      }, 'conversion-stage');
      return freeze({ targetDirectory: target, revisions: envelopes.length,
        firstRevision: 1, lastRevision: envelopes.length, sha256: previousSha256,
        originalRevision: verified.envelope.revision, intentUnchanged: true });
    },
  });
}
