import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { GrokSearchError } from './errors.mjs';
import { acquireOwnedLock, DEFAULT_STALE_LOCK_MS } from './owned-lock.mjs';
import {
  COMPATIBILITY_CONFIRM_REQUEST, COMPATIBILITY_MUTATION_REQUEST,
  COMPATIBILITY_VERSION_PATTERN, createCompatibilityCodec, isCompatibilityVersion,
} from './compatibility-contract.mjs';

export const MAX_COMPATIBILITY_STATE_BYTES = 64 * 1024;
export const MAX_COMPATIBILITY_PAIRS = 128;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new GrokSearchError(code, message); };
const pairKey = row => JSON.stringify([row.hostVersion, row.pluginVersion]);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const exists = path => lstatSync(path, { throwIfNoEntry: false });
const versionSchema = {
  type: 'string', minLength: 5, maxLength: 128, pattern: COMPATIBILITY_VERSION_PATTERN,
};
const documentParser = createCompatibilityCodec('dsh-grok-search/compatibility#StateFile', {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    generation: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
    pairs: {
      type: 'array', maxItems: MAX_COMPATIBILITY_PAIRS,
      items: {
        type: 'object',
        properties: {
          hostVersion: versionSchema, pluginVersion: versionSchema,
          confirmed: { type: 'boolean' }, notified: { type: 'boolean' },
        },
        required: ['hostVersion', 'pluginVersion', 'confirmed', 'notified'],
        additionalProperties: false,
      },
    },
  },
  required: ['schemaVersion', 'generation', 'pairs'],
  additionalProperties: false,
}).create();

function directoryChain(path) {
  const paths = [];
  for (let current = path; ; current = dirname(current)) {
    paths.push(current);
    if (paths.length > 128) fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility directory depth is unsupported.');
    if (dirname(current) === current) break;
  }
  return paths.reverse().map(directory => {
    const stat = exists(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility state requires ordinary directories.');
    }
    return { path: directory, stat };
  });
}

function canonicalProfile(path) {
  const before = exists(path);
  if (!before?.isDirectory() || before.isSymbolicLink()) {
    fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility profile must be an ordinary directory.');
  }
  // OS aliases such as macOS /var are allowed above the explicit profile.
  // Reject a linked profile itself before resolving, and pin the resolved root.
  const profile = realpathSync(path), canonical = directoryChain(profile).at(-1).stat;
  const after = exists(path);
  if (!after?.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, canonical)
    || !sameIdentity(before, after)) {
    fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility profile changed while resolving.');
  }
  const directory = join(profile, 'grok-search');
  return { profile, directory, path: join(directory, 'compatibility-state.json'), stat: canonical };
}

function ordinaryFile(stat) {
  return stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function readBytes(path, before) {
  if (!ordinaryFile(before)) fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility state is not an ordinary file.');
  if (before.size > MAX_COMPATIBILITY_STATE_BYTES) {
    fail('COMPATIBILITY_STATE_INVALID', 'Compatibility state exceeds its size limit.');
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor), current = exists(path);
    if (!ordinaryFile(opened) || !ordinaryFile(current) || !sameIdentity(before, opened)
      || !sameIdentity(opened, current)) {
      fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility state changed while opening.');
    }
    const bytes = Buffer.alloc(MAX_COMPATIBILITY_STATE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(descriptor), target = exists(path);
    if (length > MAX_COMPATIBILITY_STATE_BYTES) fail('COMPATIBILITY_STATE_INVALID', 'Compatibility state exceeds its size limit.');
    if (!ordinaryFile(target) || !sameIdentity(after, target) || opened.size !== after.size
      || after.size !== length || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      fail('COMPATIBILITY_STATE_READ_FAILED', 'Compatibility state changed while reading.');
    }
    return bytes.subarray(0, length);
  } finally { closeSync(descriptor); }
}

function validateDocument(value) {
  if (!documentParser.safeParse(value).success) fail('COMPATIBILITY_STATE_INVALID', 'Compatibility state has an unsupported format.');
  const keys = new Set();
  for (const row of value.pairs) {
    const key = pairKey(row);
    if (keys.has(key) || !row.notified) {
      fail('COMPATIBILITY_STATE_INVALID', 'Compatibility state contains duplicate or empty entries.');
    }
    keys.add(key);
  }
  return value;
}

function removeOwnedStage(path, identity) {
  if (!path || !identity) return;
  try {
    const current = exists(path);
    if (ordinaryFile(current) && sameIdentity(current, identity)) unlinkSync(path);
  } catch {}
}

export function createCompatibilityState({ profileDir, hostVersion, pluginVersion, fault } = {}) {
  if (typeof profileDir !== 'string' || profileDir.length > 4096
    || profileDir.includes('\0') || !isAbsolute(profileDir)) {
    fail('COMPATIBILITY_STATE_PATH_INVALID', 'An explicit absolute profile directory is required.');
  }
  const requestedProfile = resolve(profileDir);
  const identity = Object.freeze({
    hostVersion: isCompatibilityVersion(hostVersion) ? hostVersion : null,
    pluginVersion: isCompatibilityVersion(pluginVersion) ? pluginVersion : null,
  });
  const knownPair = identity.hostVersion !== null && identity.pluginVersion !== null;
  const listeners = new Set();
  let disposed = false, timer = null, lastSnapshot = null, trustedProfile = null;
  const requireIdentity = () => {
    if (disposed) fail('COMPATIBILITY_STATE_UNAVAILABLE', 'Compatibility state is disposed.');
    if (!knownPair) fail('COMPATIBILITY_IDENTITY_UNKNOWN', 'Exact host and plugin versions are required.');
  };
  const requireProfile = () => {
    trustedProfile ??= canonicalProfile(requestedProfile);
    const current = directoryChain(trustedProfile.profile).at(-1).stat;
    if (!sameIdentity(trustedProfile.stat, current)) {
      fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility profile was replaced.');
    }
    return trustedProfile;
  };
  const read = () => {
    requireIdentity();
    const { directory, path } = requireProfile();
    const folder = exists(directory);
    if (folder && (!folder.isDirectory() || folder.isSymbolicLink())) {
      fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility state requires an ordinary directory.');
    }
    const before = folder ? exists(path) : null;
    if (!before) return { value: { schemaVersion: 1, generation: 0, pairs: [] }, revision: 'missing' };
    const bytes = readBytes(path, before), text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('COMPATIBILITY_STATE_INVALID', 'Compatibility state must be UTF-8.');
    let value;
    try { value = JSON.parse(text); }
    catch { fail('COMPATIBILITY_STATE_INVALID', 'Compatibility state is not valid JSON.'); }
    requireProfile();
    const currentFolder = exists(directory);
    if (!currentFolder?.isDirectory() || currentFolder.isSymbolicLink() || !sameIdentity(folder, currentFolder)) {
      fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility directory changed while reading.');
    }
    return { value: validateDocument(value), revision: digest(bytes) };
  };
  const view = current => {
    const row = current.value.pairs.find(entry => pairKey(entry) === pairKey(identity));
    return { ...identity, revision: current.revision, confirmed: row?.confirmed === true,
      notified: row?.notified === true, errorCode: null };
  };
  const snapshot = () => {
    try { return view(read()); }
    catch (error) {
      return { ...identity, revision: null, confirmed: false, notified: false,
        errorCode: error instanceof GrokSearchError ? error.code : 'COMPATIBILITY_STATE_READ_FAILED' };
    }
  };
  const notify = () => {
    if (disposed || !listeners.size) return;
    const current = snapshot(), key = JSON.stringify(current);
    if (key === lastSnapshot) return;
    lastSnapshot = key;
    for (const listener of [...listeners]) {
      try { Promise.resolve(listener(structuredClone(current))).catch(() => {}); } catch {}
    }
  };
  const mutate = (operation, request) => {
    requireIdentity();
    const parser = operation === 'confirm' ? COMPATIBILITY_CONFIRM_REQUEST : COMPATIBILITY_MUTATION_REQUEST;
    if (!parser.create().safeParse(request).success) {
      fail('COMPATIBILITY_REQUEST_INVALID', 'Compatibility mutation requires an exact pair and current revision.');
    }
    if (request.hostVersion !== identity.hostVersion || request.pluginVersion !== identity.pluginVersion) {
      fail('COMPATIBILITY_PAIR_MISMATCH', 'The requested versions do not match this server identity.');
    }
    let lock, stage, stageIdentity, published = false;
    try {
      const { directory, path } = requireProfile();
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const directories = directoryChain(directory);
      try { lock = acquireOwnedLock(path + '.dsh-grok-search.lock', { reclaimStaleAfterMs: DEFAULT_STALE_LOCK_MS }); }
      catch (error) {
        if (error.code === 'EEXIST') fail('COMPATIBILITY_STATE_BUSY', 'Compatibility state is being updated.');
        throw error;
      }
      const before = read();
      if (before.revision !== request.expectedRevision) {
        fail('COMPATIBILITY_CONFLICT', 'Compatibility state changed; read its current revision first.');
      }
      const next = structuredClone(before.value);
      const index = next.pairs.findIndex(row => pairKey(row) === pairKey(identity));
      if (operation === 'revoke') {
        if (index === -1) return view(before);
        next.pairs.splice(index, 1);
      } else {
        const previous = next.pairs[index];
        if (previous?.notified && (operation !== 'confirm' || previous.confirmed)) return view(before);
        const row = { ...identity, confirmed: operation === 'confirm' || previous?.confirmed === true, notified: true };
        if (index === -1) {
          if (next.pairs.length >= MAX_COMPATIBILITY_PAIRS) fail('COMPATIBILITY_STATE_FULL', 'Compatibility state has reached its entry limit.');
          next.pairs.push(row);
        } else next.pairs[index] = row;
      }
      if (next.generation >= 1_000_000_000) fail('COMPATIBILITY_STATE_FULL', 'Compatibility state has reached its revision limit.');
      next.generation++;
      validateDocument(next);
      next.pairs.sort((a, b) => pairKey(a) < pairKey(b) ? -1 : pairKey(a) > pairKey(b) ? 1 : 0);
      const text = JSON.stringify(next, null, 2) + '\n';
      if (Buffer.byteLength(text) > MAX_COMPATIBILITY_STATE_BYTES) fail('COMPATIBILITY_STATE_FULL', 'Compatibility state has reached its size limit.');
      stage = `${path}.${randomUUID()}.tmp`;
      const descriptor = openSync(stage, 'wx', 0o600);
      try {
        stageIdentity = fstatSync(descriptor);
        writeFileSync(descriptor, text); fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      fault?.('before-publish');
      for (const { path: directoryPath, stat } of directories) {
        const current = exists(directoryPath);
        if (!current?.isDirectory() || current.isSymbolicLink() || !sameIdentity(stat, current)) {
          fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility directory changed before publication.');
        }
      }
      if (read().revision !== request.expectedRevision) fail('COMPATIBILITY_CONFLICT', 'Compatibility state changed before publication.');
      const staged = exists(stage);
      if (!ordinaryFile(staged) || !sameIdentity(stageIdentity, staged)) {
        fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility staging file changed before publication.');
      }
      if (digest(readBytes(stage, staged)) !== digest(text)) {
        fail('COMPATIBILITY_STATE_PATH_UNSAFE', 'Compatibility staging contents changed before publication.');
      }
      renameSync(stage, path);
      published = true;
      fault?.('after-publish');
      const saved = read();
      if (saved.revision !== digest(text)) fail('COMPATIBILITY_STATE_COMMIT_UNCERTAIN', 'Compatibility publication could not be verified.');
      return view(saved);
    } catch (error) {
      if (published) fail('COMPATIBILITY_STATE_COMMIT_UNCERTAIN', 'Compatibility state was published; read it again before retrying.');
      if (error instanceof GrokSearchError) throw error;
      fail('COMPATIBILITY_STATE_WRITE_FAILED', 'Compatibility state could not be updated.');
    } finally {
      if (!published) removeOwnedStage(stage, stageIdentity);
      lock?.release();
      if (published) notify();
    }
  };
  return Object.freeze({
    snapshot,
    get revision() { return snapshot().revision; },
    confirm: request => mutate('confirm', request),
    revoke: request => mutate('revoke', request),
    markNotified: request => mutate('notify', request),
    onChange(listener) {
      if (disposed || typeof listener !== 'function') throw new TypeError('An active compatibility state and listener are required.');
      if (!listeners.size) {
        lastSnapshot = JSON.stringify(snapshot());
        // Also observe local CLI changes without a second consent authority.
        timer = setInterval(notify, 1000);
        timer.unref?.();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer) { clearInterval(timer); timer = null; }
      };
    },
    dispose() {
      disposed = true;
      listeners.clear();
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}
