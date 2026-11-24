import { closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const MAX_OWNER_BYTES = 4096;
const MAX_DATE_MS = 8_640_000_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validTimestamp = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS;
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
const MAX_EXITED_OWNER_RECEIPTS = 64;
const exitedOwnerReceipts = new Map();
const pinnedExitReceipts = new WeakSet();

function retainExitedOwner(receipt) {
  const key = receipt.physicalPath;
  if (!exitedOwnerReceipts.has(key) && exitedOwnerReceipts.size >= MAX_EXITED_OWNER_RECEIPTS) {
    // Capacity eviction removes retry permission, never a filesystem lock.
    exitedOwnerReceipts.delete(exitedOwnerReceipts.keys().next().value);
  }
  exitedOwnerReceipts.set(key, receipt);
}

function forgetExitedOwner(receipt) {
  if (pinnedExitReceipts.has(receipt) && exitedOwnerReceipts.get(receipt.physicalPath)?.token === receipt.token) {
    exitedOwnerReceipts.delete(receipt.physicalPath);
  }
}

function receiptPathMatches(path, receipt) {
  const physicalPath = realpathSync(path), parent = lstatSync(dirname(physicalPath));
  return physicalPath === receipt.physicalPath && parent.isDirectory() && !parent.isSymbolicLink()
    && parent.dev === receipt.parentDev && parent.ino === receipt.parentIno;
}

function pinExitReceipt(path, receipt) {
  if (pinnedExitReceipts.has(receipt)) return receipt;
  const physicalPath = realpathSync(path), parent = lstatSync(dirname(physicalPath));
  const pinned = Object.freeze({ token: receipt.token, pid: receipt.pid, dev: receipt.dev, ino: receipt.ino,
    text: receipt.text, physicalPath, parentDev: parent.dev, parentIno: parent.ino });
  pinnedExitReceipts.add(pinned);
  return pinned;
}

function ownerRecord(path) {
  let entry;
  try { entry = lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    return { unreadable: true };
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_OWNER_BYTES) return { noOwner: true };
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch { return { unreadable: true }; }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return { noOwner: true }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schemaVersion !== 1 || !UUID.test(parsed.token ?? '')
    || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0
    || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) {
    return { noOwner: true };
  }
  return { entry, text, parsed, createdAt: Date.parse(parsed.createdAt) };
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // EPERM means the process exists but belongs to another identity. Any
    // other error is unknown; neither is evidence that the owner exited.
    return true;
  }
}

/**
 * Reclaim a lock only when all of the following are observable:
 * - the owner record is a valid owned-lock record;
 * - it has exceeded the caller's stale threshold;
 * - the recorded process is proven not to exist;
 * - the exact file identity and owner text still match before unlink.
 *
 * Plain text or older locks without an owner record are never reclaimed.
 */
export function reclaimStaleOwnedLock(path, {
  now = Date.now(), staleAfterMs = DEFAULT_STALE_LOCK_MS, isProcessAlive = defaultProcessAlive,
} = {}) {
  if (!validTimestamp(now) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0
    || typeof isProcessAlive !== 'function') return { reclaimed: false, reason: 'invalid-options' };
  const owner = ownerRecord(path);
  if (owner.missing) return { reclaimed: false, reason: 'missing' };
  if (owner.unreadable) return { reclaimed: false, reason: 'unreadable' };
  if (owner.noOwner) return { reclaimed: false, reason: 'no-owner' };
  const age = now - owner.createdAt;
  if (!(age >= staleAfterMs)) return { reclaimed: false, reason: 'fresh', age };
  let alive;
  try { alive = isProcessAlive(owner.parsed.pid); }
  catch { return { reclaimed: false, reason: 'liveness-unknown', age }; }
  if (alive !== false) return { reclaimed: false, reason: alive ? 'owner-alive' : 'liveness-unknown', age };
  // Serialize reclaimers for this exact owner. A second reclaimer must never
  // unlink a new lock installed between the first reclaimer's unlink and its
  // own check. An interrupted recovery claim is deliberately fail-closed.
  let claim;
  try { claim = acquireOwnedLock(`${path}.reclaim-${owner.parsed.token}`, { now }); }
  catch { return { reclaimed: false, reason: 'recovery-busy', age }; }
  try {
    let current;
    try { current = lstatSync(path); }
    catch (error) {
      if (error.code === 'ENOENT') return { reclaimed: false, reason: 'missing' };
      return { reclaimed: false, reason: 'unreadable' };
    }
    if (!current.isFile() || current.isSymbolicLink() || current.size > MAX_OWNER_BYTES
      || current.dev !== owner.entry.dev || current.ino !== owner.entry.ino) {
      return { reclaimed: false, reason: 'replaced' };
    }
    let text;
    try { text = readFileSync(path, 'utf8'); }
    catch { return { reclaimed: false, reason: 'unreadable' }; }
    if (text !== owner.text) return { reclaimed: false, reason: 'replaced' };
    try {
      const after = lstatSync(path);
      if (after.dev !== current.dev || after.ino !== current.ino) return { reclaimed: false, reason: 'replaced' };
      unlinkSync(path);
      return { reclaimed: true, reason: 'owner-exited', age };
    } catch {
      return { reclaimed: false, reason: 'unlink-failed' };
    }
  } finally { claim.release(); }
}

/**
 * Create a cooperative local lock whose release removes only the exact file
 * created by this call. The owner record is intentionally small and contains
 * no credentials. Automatic stale recovery is opt-in and always requires both
 * age and proof that the recorded process has exited.
 */
export function acquireOwnedLock(path, {
  reclaimStaleAfterMs = null, now = Date.now(), isProcessAlive = defaultProcessAlive,
  token = randomUUID(), onAcquired = null,
} = {}) {
  if (!validTimestamp(now) || typeof token !== 'string' || !UUID.test(token) || onAcquired !== null && typeof onAcquired !== 'function') {
    throw new TypeError('Owned locks require a valid epoch-ms timestamp, UUID token and synchronous acquisition observer.');
  }
  const timestamp = Math.trunc(now);
  const record = JSON.stringify({ schemaVersion: 1, token, pid: process.pid,
    createdAt: new Date(timestamp).toISOString() }) + '\n';
  let descriptor, identity;
  const create = () => {
    descriptor = openSync(path, 'wx', 0o600);
    try {
      identity = fstatSync(descriptor);
      writeFileSync(descriptor, record); fsyncSync(descriptor);
      onAcquired?.(Object.freeze({ token, pid: process.pid, dev: identity.dev, ino: identity.ino, text: record }));
      if (exitedOwnerReceipts.size) {
        try { exitedOwnerReceipts.delete(realpathSync(path)); } catch {}
      }
    }
    catch (error) {
      try { closeSync(descriptor); } catch {}
      descriptor = undefined;
      // Do not delete a file another writer replaced after our failed write.
      try {
        const current = lstatSync(path);
        if (identity && current.isFile() && !current.isSymbolicLink()
          && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
      } catch {}
      throw error;
    }
  };
  let creationError;
  try { create(); }
  catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} descriptor = undefined; }
    creationError = error;
  }
  if (exitedOwnerReceipts.size && creationError?.code === 'EEXIST') {
    // A proven worker exit may outlive an unlink failure; retry only its exact receipt.
    let receipt;
    try { receipt = exitedOwnerReceipts.get(realpathSync(path)); } catch {}
    if (receipt && releaseOwnedLockReceipt(path, receipt)) { create(); creationError = null; }
  }
  if (creationError) {
    const error = creationError;
    if (error.code !== 'EEXIST' || !Number.isFinite(reclaimStaleAfterMs) || reclaimStaleAfterMs < 0) throw error;
    const reclaimed = reclaimStaleOwnedLock(path, { now: timestamp, staleAfterMs: reclaimStaleAfterMs, isProcessAlive });
    error.reclaim = reclaimed;
    if (!reclaimed.reclaimed && reclaimed.reason !== 'missing') throw error;
    // Retry only once. A normal contender may have acquired the lock first.
    create();
  }
  let releaseState = 'held';
  return Object.freeze({
    token,
    release() {
      if (releaseState === 'finished') return false;
      if (releaseState === 'held') {
        // A failed close may have consumed the descriptor; never close it twice.
        releaseState = 'finished';
        try { closeSync(descriptor); }
        catch { return false; }
        releaseState = 'closed';
      }
      let before;
      try {
        before = lstatSync(path);
        if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_OWNER_BYTES
          || before.dev !== identity.dev || before.ino !== identity.ino
          || readFileSync(path, 'utf8') !== record) {
          releaseState = 'finished';
          return false;
        }
      } catch (error) {
        if (error.code === 'ENOENT') releaseState = 'finished';
        return false;
      }
      // Re-check immediately before unlinking. This is a cooperative local
      // lock, not an atomic defense against a hostile filesystem writer.
      try {
        const after = lstatSync(path);
        if (!after.isFile() || after.isSymbolicLink() || after.size > MAX_OWNER_BYTES
          || after.dev !== before.dev || after.ino !== before.ino) {
          releaseState = 'finished';
          return false;
        }
        unlinkSync(path);
        releaseState = 'finished';
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') releaseState = 'finished';
        return false;
      }
    },
  });
}

// The caller must first prove that this exact owner stopped (for example, a
// known Worker's exit event). A PID alone is not such proof for worker threads.
export function releaseOwnedLockReceipt(path, receipt) {
  if (!receipt || typeof receipt.token !== 'string' || !UUID.test(receipt.token) || typeof receipt.text !== 'string'
    || Buffer.byteLength(receipt.text) > MAX_OWNER_BYTES
    || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0
    || ['dev', 'ino'].some(key => !Number.isInteger(receipt[key]) || receipt[key] < 0)) return false;
  const current = ownerRecord(path);
  // Unverified unreadable input cannot create authority; a prior verified retry stays passive.
  if (current.unreadable) return false;
  if (!current.entry || current.parsed.token !== receipt.token || current.parsed.pid !== receipt.pid
    || current.text !== receipt.text || current.entry.dev !== receipt.dev || current.entry.ino !== receipt.ino) {
    forgetExitedOwner(receipt);
    return false;
  }
  let pathConfirmed = false;
  try {
    receipt = pinExitReceipt(path, receipt);
    if (!receiptPathMatches(path, receipt)) { forgetExitedOwner(receipt); return false; }
    pathConfirmed = true;
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== receipt.dev || after.ino !== receipt.ino
      || !receiptPathMatches(path, receipt)) {
      forgetExitedOwner(receipt);
      return false;
    }
    unlinkSync(path);
    forgetExitedOwner(receipt);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') forgetExitedOwner(receipt);
    else if (pathConfirmed && ['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) retainExitedOwner(receipt);
    return false;
  }
}
