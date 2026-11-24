import assert from 'node:assert/strict';
import fs, { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { acquireOwnedLock, DEFAULT_STALE_LOCK_MS, reclaimStaleOwnedLock } from '../src/core/owned-lock.mjs';

const old = new Date(Date.now() - DEFAULT_STALE_LOCK_MS - 60_000).toISOString();
const owner = (overrides = {}) => JSON.stringify({
  schemaVersion: 1, token: randomUUID(), pid: 424242, createdAt: old, ...overrides,
}) + '\n';
const fixture = () => join(mkdtempSync(join(tmpdir(), 'dsh-owned-lock-')), 'owner.lock');

test('reclaims only a well-formed expired lock whose owner process is proven gone', () => {
  const path = fixture();
  writeFileSync(path, owner(), { flag: 'wx' });
  const result = reclaimStaleOwnedLock(path, {
    now: Date.now(), staleAfterMs: DEFAULT_STALE_LOCK_MS, isProcessAlive: () => false,
  });
  assert.equal(result.reclaimed, true);
  assert.equal(result.reason, 'owner-exited');
  assert.equal(existsSync(path), false);
});

test('age alone, liveness alone, invalid records and replacements never authorize removal', () => {
  for (const scenario of [
    { name: 'owner alive', content: owner(), alive: () => true, reason: 'owner-alive' },
    { name: 'liveness unknown', content: owner(), alive: () => { throw new Error('probe failed'); }, reason: 'liveness-unknown' },
    { name: 'plain legacy lock', content: 'other-writer', alive: () => false, reason: 'no-owner' },
    { name: 'invalid timestamp', content: owner({ createdAt: 'not-a-time' }), alive: () => false, reason: 'no-owner' },
    { name: 'invalid pid', content: owner({ pid: 0 }), alive: () => false, reason: 'no-owner' },
  ]) {
    const path = fixture();
    writeFileSync(path, scenario.content, { flag: 'wx' });
    const before = readFileSync(path, 'utf8');
    const result = reclaimStaleOwnedLock(path, {
      now: Date.now(), staleAfterMs: DEFAULT_STALE_LOCK_MS, isProcessAlive: scenario.alive,
    });
    assert.equal(result.reclaimed, false, scenario.name);
    assert.equal(result.reason, scenario.reason, scenario.name);
    assert.equal(readFileSync(path, 'utf8'), before, scenario.name);
  }
});

test('a fresh lock is not stale even when its owner is gone', () => {
  const path = fixture();
  writeFileSync(path, owner({ createdAt: new Date().toISOString() }), { flag: 'wx' });
  const result = reclaimStaleOwnedLock(path, {
    now: Date.now(), staleAfterMs: DEFAULT_STALE_LOCK_MS, isProcessAlive: () => false,
  });
  assert.equal(result.reclaimed, false);
  assert.equal(result.reason, 'fresh');
  assert.equal(existsSync(path), true);
});

test('acquisition retries once after a proven stale lock and still honors a live contender', () => {
  const path = fixture();
  writeFileSync(path, owner(), { flag: 'wx' });
  const lock = acquireOwnedLock(path, {
    reclaimStaleAfterMs: DEFAULT_STALE_LOCK_MS, now: Date.now(), isProcessAlive: () => false,
  });
  assert.equal(existsSync(path), true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
  assert.equal(lock.release(), true);
  assert.equal(existsSync(path), false);

  writeFileSync(path, owner(), { flag: 'wx' });
  assert.throws(() => acquireOwnedLock(path, {
    reclaimStaleAfterMs: DEFAULT_STALE_LOCK_MS, now: Date.now(), isProcessAlive: () => true,
  }), error => error.code === 'EEXIST');
  assert.equal(readFileSync(path, 'utf8'), owner({ token: JSON.parse(readFileSync(path, 'utf8')).token,
    pid: 424242, createdAt: old }));
});

test('release removes only the exact owner file and never a replacement', () => {
  const path = fixture();
  const lock = acquireOwnedLock(path);
  const original = readFileSync(path, 'utf8');
  unlinkSync(path);
  writeFileSync(path, original.replace(/"pid":\d+/, '"pid":1'), { flag: 'wx' });
  assert.equal(lock.release(), false);
  assert.equal(existsSync(path), true);
});

for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
  test(`release can explicitly retry ${code} unlink failure without closing its fd again`, () => {
    const path = fixture();
    const lock = acquireOwnedLock(path);
    const original = readFileSync(path, 'utf8');
    const unrelatedPath = `${path}.unrelated`;
    writeFileSync(unrelatedPath, 'unrelated open file', { flag: 'wx' });
    const close = fs.closeSync, unlink = fs.unlinkSync;
    let ownedFd, unrelatedFd, closeCalls = 0, unlinkCalls = 0, releasing = false;
    const release = () => {
      releasing = true;
      try { return lock.release(); }
      finally { releasing = false; }
    };
    fs.closeSync = fd => {
      if (!releasing) return close(fd);
      if (ownedFd === undefined) ownedFd = fd;
      if (fd === ownedFd) {
        closeCalls++;
        // Observe unsafe retries without actually closing a recycled descriptor.
        if (closeCalls > 1) throw Object.assign(new Error('Owned fd was already closed'), { code: 'EBADF' });
      }
      return close(fd);
    };
    fs.unlinkSync = (target, ...args) => {
      if (target === path && ++unlinkCalls === 1) {
        throw Object.assign(new Error('Transient owned-lock unlink failure'), { code });
      }
      return unlink(target, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(release(), false);
      assert.equal(closeCalls, 1);
      assert.equal(unlinkCalls, 1);
      assert.equal(readFileSync(path, 'utf8'), original);

      unrelatedFd = fs.openSync(unrelatedPath, 'r');
      assert.equal(release(), true, 'An explicit retry of the same owned lock must succeed');
      assert.equal(closeCalls, 1, 'Retry must not close the already released fd');
      assert.equal(unlinkCalls, 2);
      assert.equal(fs.fstatSync(unrelatedFd).isFile(), true);
      assert.equal(existsSync(path), false);
      assert.equal(release(), false);
      assert.equal(closeCalls, 1);
      assert.equal(unlinkCalls, 2);
    } finally {
      fs.closeSync = close;
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
      if (unrelatedFd !== undefined) close(unrelatedFd);
    }
  });
}

for (const scenario of [
  'byte-identical replacement inode',
  'changed owner token on the original inode',
  'changed bytes with unchanged owner fields',
  'symbolic link at retry inspection',
  'symbolic link at the final retry recheck',
  'missing original followed by a byte-identical successor',
]) {
  test(`release retry refuses ${scenario}`, () => {
    const path = fixture();
    const lock = acquireOwnedLock(path);
    const original = readFileSync(path, 'utf8');
    const identity = fs.lstatSync(path);
    const close = fs.closeSync, unlink = fs.unlinkSync;
    const lstat = fs.lstatSync, read = fs.readFileSync;
    const replacementPath = `${path}.replacement`;
    if (scenario.startsWith('symbolic link')) writeFileSync(replacementPath, original, { flag: 'wx' });
    let ownedFd, closeCalls = 0, unlinkCalls = 0, retryStats = 0, retryReads = 0, releasing = false;
    const release = () => {
      releasing = true;
      try { return lock.release(); }
      finally { releasing = false; }
    };
    let expected = original;
    fs.closeSync = fd => {
      if (!releasing) return close(fd);
      if (ownedFd === undefined) ownedFd = fd;
      if (fd === ownedFd && ++closeCalls > 1) {
        throw Object.assign(new Error('Owned fd was already closed'), { code: 'EBADF' });
      }
      return close(fd);
    };
    fs.unlinkSync = (target, ...args) => {
      if (target === path && ++unlinkCalls === 1) {
        throw Object.assign(new Error('Transient owned-lock unlink failure'), { code: 'EACCES' });
      }
      return unlink(target, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(release(), false);
      assert.equal(closeCalls, 1);
      assert.equal(unlinkCalls, 1);
      assert.equal(read(path, 'utf8'), original);

      if (scenario === 'byte-identical replacement inode') {
        fs.renameSync(path, `${path}.original`);
        writeFileSync(path, original, { flag: 'wx' });
        assert.notEqual(lstat(path).ino, identity.ino);
      } else if (scenario === 'changed owner token on the original inode') {
        expected = owner({ ...JSON.parse(original), token: randomUUID() });
        writeFileSync(path, expected);
        assert.equal(lstat(path).ino, identity.ino);
      } else if (scenario === 'changed bytes with unchanged owner fields') {
        expected = original.slice(0, -1) + ' ';
        writeFileSync(path, expected);
        assert.notEqual(expected, original);
        assert.deepEqual(JSON.parse(expected), JSON.parse(original));
        assert.equal(lstat(path).ino, identity.ino);
        assert.equal(lstat(path).size, identity.size);
      } else if (scenario.startsWith('symbolic link')) {
        fs.readFileSync = (target, ...args) => {
          if (target === path) retryReads++;
          return read(target, ...args);
        };
        fs.lstatSync = (target, ...args) => {
          if (target !== path) return lstat(target, ...args);
          retryStats++;
          const linked = scenario === 'symbolic link at retry inspection' || retryStats === 2;
          if (!linked) return lstat(target, ...args);
          if (retryStats === (scenario === 'symbolic link at retry inspection' ? 1 : 2)) {
            fs.renameSync(path, `${path}.original`);
            fs.renameSync(replacementPath, path);
          }
          // Inject link metadata without Windows symlink privileges. Matching
          // identity and bytes must not override the non-link requirement.
          return Object.assign(Object.create(lstat(target, ...args)), {
            dev: identity.dev, ino: identity.ino,
            isFile: () => true, isSymbolicLink: () => true,
          });
        };
        syncBuiltinESMExports();
      } else {
        fs.renameSync(path, `${path}.original`);
        assert.equal(existsSync(path), false);
      }

      assert.equal(release(), false);
      assert.equal(closeCalls, 1);
      assert.equal(unlinkCalls, 1, 'Refusing a replacement must not attempt another unlink');
      if (scenario === 'missing original followed by a byte-identical successor') {
        assert.equal(existsSync(path), false);
        writeFileSync(path, original, { flag: 'wx' });
        assert.notEqual(lstat(path).ino, identity.ino);
        assert.equal(release(), false);
        assert.equal(closeCalls, 1);
        assert.equal(unlinkCalls, 1);
      }
      if (scenario === 'symbolic link at retry inspection') {
        assert.equal(retryReads, 0, 'Retry must not read through a link');
      }
      assert.equal(read(path, 'utf8'), expected);
    } finally {
      fs.closeSync = close;
      fs.unlinkSync = unlink;
      fs.lstatSync = lstat;
      fs.readFileSync = read;
      syncBuiltinESMExports();
    }
  });
}

for (const closedBeforeError of [false, true]) {
  test(`release never retries an uncertain close (${closedBeforeError ? 'fd already closed' : 'fd still open'})`, () => {
    const path = fixture();
    const lock = acquireOwnedLock(path);
    const original = readFileSync(path, 'utf8');
    const unrelatedPath = `${path}.unrelated`;
    writeFileSync(unrelatedPath, 'unrelated open file', { flag: 'wx' });
    const close = fs.closeSync, unlink = fs.unlinkSync;
    let ownedFd, unrelatedFd, closeCalls = 0, unlinkCalls = 0, releasing = false;
    const release = () => {
      releasing = true;
      try { return lock.release(); }
      finally { releasing = false; }
    };
    fs.closeSync = fd => {
      if (!releasing) return close(fd);
      closeCalls++;
      if (closeCalls === 1) {
        ownedFd = fd;
        if (closedBeforeError) {
          close(fd);
          unrelatedFd = fs.openSync(unrelatedPath, 'r');
        }
      }
      // A close error does not prove that the descriptor is still ours.
      throw Object.assign(new Error('Uncertain owned-lock close failure'), { code: 'EIO' });
    };
    fs.unlinkSync = (target, ...args) => {
      if (target === path) unlinkCalls++;
      return unlink(target, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(release(), false);
      assert.equal(closeCalls, 1);
      assert.equal(unlinkCalls, 0);
      assert.equal(release(), false);
      assert.equal(release(), false);
      assert.equal(closeCalls, 1, 'A close error must not authorize retrying a potentially recycled fd');
      assert.equal(unlinkCalls, 0);
      assert.equal(readFileSync(path, 'utf8'), original);
      assert.equal(fs.fstatSync(unrelatedFd ?? ownedFd).isFile(), true);
    } finally {
      fs.closeSync = close;
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
      if (unrelatedFd !== undefined) close(unrelatedFd);
      else if (ownedFd !== undefined) close(ownedFd);
    }
  });
}

test('owner record is small, regular and closed before release', () => {
  const path = fixture();
  const lock = acquireOwnedLock(path);
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.pid, process.pid);
  assert.equal(typeof entry.token, 'string');
  assert.ok(readFileSync(path).length < 4096);
  assert.equal(lock.release(), true);
  assert.equal(existsSync(path), false);
});

test('a real exited child can be reclaimed, but a live or reused PID is never treated as exited', async () => {
  const path = fixture();
  const child = spawn(process.execPath, ['--eval', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'close');
  writeFileSync(path, owner({ pid: child.pid }), { flag: 'wx' });
  const reclaimed = reclaimStaleOwnedLock(path, { now: Date.now(), staleAfterMs: DEFAULT_STALE_LOCK_MS });
  // PID reuse between child exit and this probe is possible; in that case the
  // implementation conservatively keeps the lock.
  if (reclaimed.reason === 'owner-alive') assert.equal(existsSync(path), true);
  else assert.equal(reclaimed.reclaimed, true);
  if (existsSync(path)) unlinkSync(path);
  writeFileSync(path, owner({ pid: process.pid }), { flag: 'wx' });
  assert.equal(reclaimStaleOwnedLock(path).reason, 'owner-alive');
});

test('reclaimer refuses a lock replaced during the process check and never follows its link', () => {
  const path = fixture();
  writeFileSync(path, owner(), { flag: 'wx' });
  const replacement = owner({ pid: process.pid });
  const result = reclaimStaleOwnedLock(path, { isProcessAlive() {
    unlinkSync(path);
    writeFileSync(path, replacement, { flag: 'wx' });
    return false;
  } });
  assert.equal(result.reclaimed, false);
  assert.equal(result.reason, 'replaced');
  assert.equal(readFileSync(path, 'utf8'), replacement);
});

test('acquireOwnedLock honors injected timestamp and rejects out-of-range or NaN timestamps without clobbering locks', () => {
  const path = fixture();
  const fixedNow = Date.UTC(2026, 10, 18, 12, 0, 0, 456);
  const lock = acquireOwnedLock(path, { now: fixedNow });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).createdAt, new Date(fixedNow).toISOString());
  assert.equal(lock.release(), true);

  for (const badNow of [Number.NaN, Number.POSITIVE_INFINITY, 1e20, -1e20, '2026-11-18']) {
    assert.throws(() => acquireOwnedLock(path, { now: badNow }), TypeError);
  }

  writeFileSync(path, owner(), { flag: 'wx' });
  for (const badNow of [Number.NaN, 1e20, -1e20]) {
    const result = reclaimStaleOwnedLock(path, { now: badNow, staleAfterMs: DEFAULT_STALE_LOCK_MS, isProcessAlive: () => false });
    assert.deepEqual(result, { reclaimed: false, reason: 'invalid-options' });
    assert.equal(existsSync(path), true);
  }
});
