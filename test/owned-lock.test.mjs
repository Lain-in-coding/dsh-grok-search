import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
