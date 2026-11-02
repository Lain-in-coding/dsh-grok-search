import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const CONTROL_RECORD_FORMAT = 'dsh-grok-search/control-intent';
export const CONTROL_RECORD_VERSION = 1;
export const LEGACY_CONTROL_FORMAT = 'dsh-grok-search/legacy-control-intent';
const MAX_BYTES = 1_048_576;
const MAX_REVISION = 999_999_999_999;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const identity = value => text(value) || (Number.isSafeInteger(value) && value >= 0);
const time = value => text(value) && Number.isFinite(Date.parse(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rootNetworkPath = path => path.startsWith('\\') || path.startsWith('//');
const filename = revision => `v${String(revision).padStart(12, '0')}.json`;

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
function freeze(value) {
  if (value && typeof value === 'object') {
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


/**
 * Cooperative, local-filesystem CAS. Synced private staging bytes are published
 * by an exclusive hard link to the next immutable revision. No lock stealing,
 * overwrite, check-then-rename, network-filesystem fallback or automatic cleanup.
 * File-data fsync is NOT a Windows directory/power-loss durability guarantee.
 */
export function createControlIntentStore({ directory, legacyPath, trustedRoot = null, fault = () => {} }) {
  if (!text(directory) || !isAbsolute(directory) || rootNetworkPath(directory) || (legacyPath && (!isAbsolute(legacyPath) || rootNetworkPath(legacyPath)))) {
    invalid('Control storage and legacy evidence paths must be absolute.');
  }
  if (trustedRoot !== null && (!text(trustedRoot) || !isAbsolute(trustedRoot) || rootNetworkPath(trustedRoot))) {
    invalid('The trusted control storage profile must be an absolute local directory.');
  }
  if (typeof fault !== 'function') invalid('Control fault seam must be a function.');
  const root = resolve(directory);
  const boundary = trustedRoot === null ? null : resolve(trustedRoot);
  if (boundary !== null) {
    assertWithin(root, boundary);
    if (legacyPath) assertWithin(resolve(legacyPath), boundary);
  }
  let physicalRoot;
  const checkDirectory = () => {
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
  const snapshot = ({ allowUnmigratedLegacy = false } = {}) => {
    const sourcePresent = Boolean(legacyPath && stat(legacyPath));
    if (!checkDirectory()) {
      if (sourcePresent && !allowUnmigratedLegacy) fail('CONTROL_RECORD_MIGRATION_REQUIRED');
      return { envelope: null, sha256: null, origin: null, migration: null };
    }
    const names = readdirSync(root);
    const revisions = names.filter(name => /^v\d{12}\.json$/.test(name)).sort();
    if (names.some(name => /^v/i.test(name) && !/^v\d{12}\.json$/.test(name))) invalid('Malformed committed revision name.');
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
    return { envelope: envelope ? freeze(envelope) : null, sha256: previousSha256,
      origin: origin ? freeze(origin) : null, migration };
  };
  const publish = ({ expectedRevision, intent, operationId, before, sourceCheck = () => {} }) => {
    const actualRevision = before.envelope?.revision ?? 0;
    if (actualRevision !== expectedRevision) fail('CONTROL_CAS_CONFLICT', { expectedRevision, actualRevision });
    const candidate = jsonCopy({ format: CONTROL_RECORD_FORMAT, schemaVersion: CONTROL_RECORD_VERSION,
      revision: expectedRevision + 1, operationId, previousSha256: before.sha256, intent });
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
      // This exclusive namespace publication, not the earlier read, is the CAS linearization point.
      try { linkSync(stagePath, targetPath); }
      catch (error) {
        if (error.code === 'EEXIST') fail('CONTROL_CAS_CONFLICT', { expectedRevision, attemptedRevision: candidate.revision });
        throw error;
      }
      published = true;
      fault('after-publish', { expectedRevision, operationId, stagePath, targetPath });
      sourceCheck();
      if (hash(readBytes(targetPath)) !== hash(bytes)) invalid('Published control revision failed readback.');
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
        operationId, importedAt: new Date().toISOString(), authorizationEstablished: false,
        routeChanged: false, historicReleasePreserved: true };
      try {
        const envelope = publish({ expectedRevision: 0, intent: { ...original, migration }, operationId, before,
          sourceCheck: () => assertSource(expectedLegacySha256) });
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
      const before = snapshot();
      if (!isDeepStrictEqual(intent?.migration ?? null, before.migration)) {
        invalid('Only explicit migration can introduce origin evidence; later writes must preserve it unchanged.');
      }
      return publish({ expectedRevision, intent, operationId, before,
        sourceCheck: before.migration ? () => assertSource(before.migration.sourceSha256) : undefined });
    },
  });
}
