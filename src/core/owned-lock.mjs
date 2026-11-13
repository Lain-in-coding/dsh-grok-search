import { closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const MAX_OWNER_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;

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
  if (!Number.isFinite(now) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0
    || typeof isProcessAlive !== 'function') return { reclaimed: false, reason: 'invalid-options' };
  const owner = ownerRecord(path);
  if (owner.missing) return { reclaimed: false, reason: 'missing' };
  if (owner.unreadable) return { reclaimed: false, reason: 'unreadable' };
  if (owner.noOwner) return { reclaimed: false, reason: 'no-owner' };
  const age = now - owner.createdAt;
  if (!(age >= staleAfterMs)) return { reclaimed: false, reason: 'fresh', age };
  let alive;
  try { alive = isProcessAlive(owner.parsed.pid); }
  catch { return { reclaimed: false, reason: 'liveness-unknown', age } };
  if (alive !== false) return { reclaimed: false, reason: alive ? 'owner-alive' : 'liveness-unknown', age };
  // Serialize reclaimers for this exact owner. A second reclaimer must never
  // unlink a new lock installed between the first reclaimer's unlink and its
  // own check. An interrupted recovery claim is deliberately fail-closed.
  let claim;
  try { claim = acquireOwnedLock(`${path}.reclaim-${owner.parsed.token}`); }
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
} = {}) {
  const token = randomUUID();
  const record = JSON.stringify({ schemaVersion: 1, token, pid: process.pid,
    createdAt: new Date().toISOString() }) + '\n';
  let descriptor, identity;
  const create = () => {
    descriptor = openSync(path, 'wx', 0o600);
    try {
      identity = fstatSync(descriptor);
      writeFileSync(descriptor, record); fsyncSync(descriptor);
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
  try { create(); }
  catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} descriptor = undefined; }
    if (error.code !== 'EEXIST' || !Number.isFinite(reclaimStaleAfterMs) || reclaimStaleAfterMs < 0) throw error;
    const reclaimed = reclaimStaleOwnedLock(path, { now, staleAfterMs: reclaimStaleAfterMs, isProcessAlive });
    error.reclaim = reclaimed;
    if (!reclaimed.reclaimed && reclaimed.reason !== 'missing') throw error;
    // Retry only once. A normal contender may have acquired the lock first.
    create();
  }
  let released = false;
  return Object.freeze({
    token,
    release() {
      if (released) return false;
      released = true;
      try { closeSync(descriptor); }
      catch { return false; }
      let before;
      try {
        before = lstatSync(path);
        if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_OWNER_BYTES) return false;
        if (before.dev !== identity.dev || before.ino !== identity.ino) return false;
        if (readFileSync(path, 'utf8') !== record) return false;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        return false;
      }
      // Re-check immediately before unlinking. This is a cooperative local
      // lock, not an atomic defense against a hostile filesystem writer.
      try {
        const after = lstatSync(path);
        if (after.dev !== before.dev || after.ino !== before.ino) return false;
        unlinkSync(path);
        return true;
      } catch { return false; }
    },
  });
}
