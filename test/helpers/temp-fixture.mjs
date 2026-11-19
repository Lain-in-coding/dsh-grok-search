import { lstatSync, mkdtempSync as rawMkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tracked = new Map();
const initialRoots = new Set();
const cleanupFailures = [];
let sequence = 0;

export const getFixtureCleanupFailures = () => cleanupFailures.map(row => ({ ...row }));

function reportFailure(id, code) {
  const row = { fixture: id, code };
  cleanupFailures.push(row);
  try { process.stderr.write('TEST_FIXTURE_CLEANUP ' + JSON.stringify(row) + '\n'); }
  catch { /* The retained failure record remains available if stderr is closed. */ }
}

function identity(dir) {
  const stat = lstatSync(dir, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino === 0n) return null;
  return [stat.dev, stat.ino, stat.birthtimeNs].join(':');
}

function addRoot(target, dir) {
  if (typeof dir !== 'string' || !dir.trim()) return;
  try { target.add(resolve(dir)); } catch {}
  try { target.add(resolve(realpathSync(dir))); } catch {}
}

addRoot(initialRoots, tmpdir());
if (process.env.RUNNER_TEMP) addRoot(initialRoots, process.env.RUNNER_TEMP);

function currentTempRoots() {
  const roots = new Set(initialRoots);
  try { addRoot(roots, tmpdir()); } catch {}
  if (process.env.RUNNER_TEMP) addRoot(roots, process.env.RUNNER_TEMP);
  return roots;
}

export function mkdtempTracked(prefix, options) {
  const prefixText = prefix instanceof URL ? fileURLToPath(prefix)
    : Buffer.isBuffer(prefix) ? prefix.toString('utf8') : prefix;
  const parent = typeof prefixText === 'string' ? dirname(resolve(prefixText)) : null;
  let owner = null;
  if (parent && currentTempRoots().has(parent) && basename(prefixText).startsWith('dsh-')) {
    const id = ++sequence;
    try {
      const parentIdentity = identity(parent), canonicalParent = realpathSync(parent);
      if (parentIdentity) owner = { id, parent, parentIdentity, canonicalParent };
      else reportFailure(id, 'UNSAFE_PARENT');
    } catch { reportFailure(id, 'PARENT_IDENTITY_UNAVAILABLE'); }
  }
  const created = options === undefined ? rawMkdtempSync(prefix) : rawMkdtempSync(prefix, options);
  const text = typeof created === 'string' ? created : Buffer.isBuffer(created) ? created.toString('utf8') : '';
  if (owner && text) {
    const dir = resolve(text);
    try {
      const childIdentity = identity(dir);
      if (dirname(dir) === parent && basename(dir).startsWith('dsh-') && childIdentity
        && identity(parent) === owner.parentIdentity && realpathSync(parent) === owner.canonicalParent
        && realpathSync(dir) === join(owner.canonicalParent, basename(dir))) {
        tracked.set(dir, { ...owner, childIdentity });
      } else reportFailure(owner.id, 'IDENTITY_CHANGED');
    } catch { reportFailure(owner.id, 'CHILD_IDENTITY_UNAVAILABLE'); }
  }
  return created;
}

process.on('exit', code => {
  if (code !== 0 || process.env.DSH_KEEP_TEST_FIXTURES === '1') return;
  for (const [dir, owner] of [...tracked.entries()].reverse()) {
    try {
      if (dirname(dir) !== owner.parent || !basename(dir).startsWith('dsh-')
        || identity(owner.parent) !== owner.parentIdentity
        || realpathSync(owner.parent) !== owner.canonicalParent) {
        reportFailure(owner.id, 'PARENT_CHANGED'); continue;
      }
      let childIdentity;
      try { childIdentity = identity(dir); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (childIdentity !== owner.childIdentity
        || realpathSync(dir) !== join(owner.canonicalParent, basename(dir))) {
        reportFailure(owner.id, 'CHILD_CHANGED'); continue;
      }
      // Do not retry a path-based removal after its identity could have changed.
      rmSync(dir, { recursive: true, force: false });
      tracked.delete(dir);
    } catch (error) {
      reportFailure(owner.id, ['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'ENOENT'].includes(error.code)
        ? error.code : 'CLEANUP_FAILED');
    }
  }
});
