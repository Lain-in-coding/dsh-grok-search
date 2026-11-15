import assert from 'node:assert/strict';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createCompatibilityState, MAX_COMPATIBILITY_PAIRS, MAX_COMPATIBILITY_STATE_BYTES,
} from '../src/core/compatibility-state.mjs';
import { isCompatibilityVersion } from '../src/core/compatibility-contract.mjs';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';
import { acquireOwnedLock } from '../src/core/owned-lock.mjs';
import { runCompatibilityCli } from '../src/core/compatibility-cli.mjs';

const PAIR = Object.freeze({ hostVersion: '0.2.2-alpha.1', pluginVersion: '0.4.0' });
const request = (store, extra = {}) => {
  const { hostVersion, pluginVersion, revision } = store.snapshot();
  return { hostVersion, pluginVersion, expectedRevision: revision, ...extra };
};
const confirm = store => store.confirm(request(store, { acceptRisk: true }));

function fixture(t) {
  const root = realpathSync(tmpdir()), profileDir = mkdtempSync(join(root, 'dsh-compatibility-state-'));
  const path = join(profileDir, 'grok-search', 'compatibility-state.json');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.dispose();
    const target = resolve(profileDir);
    assert.equal(dirname(target), root);
    assert.ok(target.startsWith(root + sep) && target.includes('dsh-compatibility-state-'));
    rmSync(target, { recursive: true, force: true });
  });
  const create = (options = {}) => {
    const store = createCompatibilityState({ profileDir, ...PAIR, ...options });
    stores.push(store);
    return store;
  };
  const write = value => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  return { profileDir, path, create, write };
}

test('missing state is a read-only, unconfirmed exact-pair snapshot', t => {
  const { profileDir, create } = fixture(t), store = create();
  assert.deepEqual(store.snapshot(), { ...PAIR, revision: 'missing', confirmed: false, notified: false, errorCode: null });
  assert.equal(store.revision, 'missing');
  assert.equal(existsSync(join(profileDir, 'grok-search')), false);
  const snapshot = store.snapshot();
  snapshot.confirmed = true;
  assert.equal(store.snapshot().confirmed, false);
});

test('confirmation, notification and revocation are independent exact-pair CAS operations', t => {
  const { path, create } = fixture(t), store = create();
  const notified = store.markNotified(request(store));
  assert.equal(notified.confirmed, false);
  assert.equal(notified.notified, true);
  assert.match(notified.revision, /^[a-f0-9]{64}$/);
  const saved = confirm(store);
  assert.equal(saved.confirmed, true);
  assert.equal(saved.notified, true);
  assert.notEqual(saved.revision, notified.revision);
  const nextHost = create({ hostVersion: '0.2.2-alpha.2' });
  const nextPlugin = create({ pluginVersion: '0.4.1' });
  assert.equal(nextHost.snapshot().confirmed, false);
  assert.equal(nextPlugin.snapshot().confirmed, false);
  confirm(nextHost);
  assert.equal(store.snapshot().confirmed, true);
  const revoked = store.revoke(request(store));
  assert.equal(revoked.confirmed, false);
  assert.equal(revoked.notified, false);
  assert.equal(nextHost.snapshot().confirmed, true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['generation', 'pairs', 'schemaVersion']);
});

test('pair identity is never learned from a request and exact build metadata is significant', t => {
  const { create } = fixture(t), store = create({ hostVersion: '0.2.2-alpha.1+host.1' });
  confirm(store);
  const mismatch = request(store, { hostVersion: '0.2.2-alpha.1+host.2', acceptRisk: true });
  assert.throws(() => store.confirm(mismatch), { code: 'COMPATIBILITY_PAIR_MISMATCH' });
  assert.equal(create({ hostVersion: '0.2.2-alpha.1+host.2' }).snapshot().confirmed, false);
  for (const version of [undefined, '', 'v0.2.2', '>=0.2.2', '0.2.2-01', '0.2.2\n', 'secret/path', '1.2']) {
    const unknown = create({ hostVersion: version });
    assert.equal(unknown.snapshot().hostVersion, null);
    assert.equal(unknown.snapshot().revision, null);
    assert.equal(unknown.snapshot().confirmed, false);
    assert.throws(() => unknown.confirm({ ...request(store), acceptRisk: true }), { code: 'COMPATIBILITY_IDENTITY_UNKNOWN' });
  }
  assert.equal(isCompatibilityVersion('0.2.2-rc.3+build.007'), true);
});

test('strict mutation validation rejects missing consent, revisions and extra properties', t => {
  const { create } = fixture(t), store = create();
  for (const value of [
    undefined, null, {}, request(store), request(store, { acceptRisk: false }),
    request(store, { acceptRisk: true, expectedRevision: null }),
    request(store, { acceptRisk: true, expectedRevision: 'missing\n' }),
    request(store, { acceptRisk: true, unexpected: true }),
    request(store, { acceptRisk: true, hostVersion: '*' }),
  ]) assert.throws(() => store.confirm(value), { code: 'COMPATIBILITY_REQUEST_INVALID' });
  for (const method of ['revoke', 'markNotified']) {
    assert.throws(() => store[method](request(store, { acceptRisk: true })), { code: 'COMPATIBILITY_REQUEST_INVALID' });
  }
  assert.equal(store.snapshot().revision, 'missing');
});

test('a stale mutation and a confirm-revoke ABA cannot silently grant consent', t => {
  const { create } = fixture(t), first = create(), second = create();
  const missingRequest = request(first, { acceptRisk: true });
  confirm(first);
  assert.throws(() => second.confirm(missingRequest), { code: 'COMPATIBILITY_CONFLICT' });
  const oldRequest = request(first, { acceptRisk: true });
  first.revoke(request(first));
  confirm(first);
  assert.throws(() => second.confirm(oldRequest), { code: 'COMPATIBILITY_CONFLICT' });
  assert.notEqual(first.snapshot().revision, oldRequest.expectedRevision);
});

test('idempotent operations do not republish state or advance its revision', t => {
  const { create } = fixture(t), store = create();
  assert.equal(store.revoke(request(store)).revision, 'missing');
  const first = confirm(store);
  const guarded = create({ fault() { throw new Error('must not republish'); } });
  assert.deepEqual(confirm(guarded), first);
  assert.deepEqual(guarded.markNotified(request(guarded)), first);
});

test('invalid, oversized, unknown-schema, duplicate and invalid UTF-8 state never authorize', t => {
  const { create, write } = fixture(t), store = create();
  const row = { ...PAIR, confirmed: true, notified: true };
  for (const value of [
    '{', 'null', Buffer.from([0xff, 0xfe]), ' '.repeat(MAX_COMPATIBILITY_STATE_BYTES + 1),
    { schemaVersion: 2, generation: 1, pairs: [row] },
    { schemaVersion: 1, generation: 1, pairs: [row], unknown: 'not accepted' },
    { schemaVersion: 1, generation: 1, pairs: [{ ...row, confirmed: 'yes' }] },
    { schemaVersion: 1, generation: 1, pairs: [row, row] },
    { schemaVersion: 1, generation: 1, pairs: [{ ...row, confirmed: false, notified: false }] },
    { schemaVersion: 1, generation: 0, pairs: [row] },
  ]) {
    write(value);
    const current = store.snapshot();
    assert.equal(current.confirmed, false);
    assert.equal(current.revision, null);
    assert.equal(current.errorCode, 'COMPATIBILITY_STATE_INVALID');
    assert.throws(() => store.confirm({ ...PAIR, expectedRevision: 'missing', acceptRisk: true }),
      { code: 'COMPATIBILITY_STATE_INVALID' });
  }
});

test('path errors contain no private directory and do not create a missing profile', t => {
  const { profileDir, create } = fixture(t);
  for (const path of ['', '.', 'relative/profile', 'bad\0path']) {
    assert.throws(() => createCompatibilityState({ profileDir: path, ...PAIR }), { code: 'COMPATIBILITY_STATE_PATH_INVALID' });
  }
  const missing = join(profileDir, 'private-secret-uncreated');
  const store = create({ profileDir: missing });
  const snapshot = store.snapshot();
  assert.equal(snapshot.confirmed, false);
  assert.equal(snapshot.errorCode, 'COMPATIBILITY_STATE_PATH_UNSAFE');
  assert.doesNotMatch(JSON.stringify(snapshot), /private-secret-uncreated|profileDir|path/);
  assert.throws(() => confirm(store), { code: 'COMPATIBILITY_REQUEST_INVALID' });
  assert.equal(existsSync(missing), false);
});

test('directory and hard-linked state targets are refused', t => {
  const { path, profileDir, create } = fixture(t);
  mkdirSync(path, { recursive: true });
  const store = create();
  assert.equal(store.snapshot().errorCode, 'COMPATIBILITY_STATE_PATH_UNSAFE');
  const directoryTarget = resolve(path);
  assert.ok(directoryTarget.startsWith(resolve(profileDir) + sep));
  rmSync(directoryTarget, { recursive: true });
  const external = join(profileDir, 'unrelated.json');
  writeFileSync(external, JSON.stringify({ schemaVersion: 1, generation: 1, pairs: [{ ...PAIR, confirmed: true, notified: true }] }));
  linkSync(external, path);
  assert.equal(store.snapshot().errorCode, 'COMPATIBILITY_STATE_PATH_UNSAFE');
  assert.throws(() => store.confirm({ ...PAIR, expectedRevision: 'missing', acceptRisk: true }), { code: 'COMPATIBILITY_STATE_PATH_UNSAFE' });
  assert.equal(lstatSync(external).nlink, 2);
});

test('a linked plugin directory cannot redirect reads or writes outside the profile', t => {
  const { profileDir, create } = fixture(t);
  const external = join(profileDir, 'external');
  mkdirSync(external);
  symlinkSync(external, join(profileDir, 'grok-search'), process.platform === 'win32' ? 'junction' : 'dir');
  const store = create();
  assert.equal(store.snapshot().errorCode, 'COMPATIBILITY_STATE_PATH_UNSAFE');
  assert.throws(() => store.confirm({ ...PAIR, expectedRevision: 'missing', acceptRisk: true }), { code: 'COMPATIBILITY_STATE_PATH_UNSAFE' });
  assert.deepEqual(readdirSync(external), []);
});

test('a linked profile itself is refused rather than silently resolved', t => {
  const { profileDir, create } = fixture(t);
  const original = join(profileDir, 'original'), link = join(profileDir, 'linked');
  mkdirSync(original);
  symlinkSync(original, link, process.platform === 'win32' ? 'junction' : 'dir');
  const store = create({ profileDir: link });
  assert.equal(store.snapshot().errorCode, 'COMPATIBILITY_STATE_PATH_UNSAFE');
  assert.throws(() => store.confirm({ ...PAIR, expectedRevision: 'missing', acceptRisk: true }), { code: 'COMPATIBILITY_STATE_PATH_UNSAFE' });
  assert.deepEqual(readdirSync(original), []);
});

test('a real profile under a symlinked ancestor uses the same canonical consent state', t => {
  const { profileDir, create } = fixture(t);
  const original = join(profileDir, 'original'), link = join(profileDir, 'ancestor');
  const actualProfile = join(original, 'profile');
  mkdirSync(actualProfile, { recursive: true });
  symlinkSync(original, link, process.platform === 'win32' ? 'junction' : 'dir');
  const throughAlias = create({ profileDir: join(link, 'profile') });
  assert.equal(throughAlias.snapshot().revision, 'missing');
  assert.equal(throughAlias.snapshot().errorCode, null);
  const saved = confirm(throughAlias);
  assert.equal(saved.confirmed, true);
  assert.deepEqual(create({ profileDir: actualProfile }).snapshot(), saved);
  assert.equal(JSON.stringify(saved).includes(profileDir), false);
});

test('the platform default temporary-directory spelling is accepted without caller canonicalization', t => {
  const { profileDir, create } = fixture(t);
  const throughDefault = create({ profileDir: join(tmpdir(), basename(profileDir)) });
  const saved = confirm(throughDefault);
  assert.equal(saved.confirmed, true);
  assert.deepEqual(create().snapshot(), saved);
});

test('retargeting an original ancestor alias cannot switch a pinned profile or its authorization', t => {
  const { profileDir, create } = fixture(t);
  const first = join(profileDir, 'first'), second = join(profileDir, 'second'), link = join(profileDir, 'ancestor');
  const firstProfile = join(first, 'profile'), secondProfile = join(second, 'profile');
  mkdirSync(firstProfile, { recursive: true });
  mkdirSync(secondProfile, { recursive: true });
  symlinkSync(first, link, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = create({ profileDir: join(link, 'profile') });
  assert.equal(aliased.snapshot().revision, 'missing');
  const secondStore = create({ profileDir: secondProfile });
  const otherGrant = confirm(secondStore);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  unlinkSync(link);
  symlinkSync(second, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(aliased.snapshot().confirmed, false);
  assert.equal(aliased.snapshot().revision, 'missing');
  aliased.markNotified(request(aliased));
  assert.equal(create({ profileDir: firstProfile }).snapshot().notified, true);
  assert.deepEqual(secondStore.snapshot(), otherGrant);
  assert.equal(aliased.snapshot().confirmed, false);
});

test('canonicalization of an ancestor never permits a linked directory inside the profile', t => {
  const { profileDir, create } = fixture(t);
  const original = join(profileDir, 'original'), link = join(profileDir, 'ancestor');
  const actualProfile = join(original, 'profile'), unrelated = join(profileDir, 'unrelated');
  mkdirSync(actualProfile, { recursive: true });
  mkdirSync(unrelated);
  symlinkSync(original, link, process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(unrelated, join(actualProfile, 'grok-search'), process.platform === 'win32' ? 'junction' : 'dir');
  const store = create({ profileDir: join(link, 'profile') });
  assert.equal(store.snapshot().errorCode, 'COMPATIBILITY_STATE_PATH_UNSAFE');
  assert.throws(() => store.confirm({ ...PAIR, expectedRevision: 'missing', acceptRisk: true }),
    { code: 'COMPATIBILITY_STATE_PATH_UNSAFE' });
  assert.deepEqual(readdirSync(unrelated), []);
});

test('a pinned profile replaced with an ordinary directory loses authorization rather than being rebound', t => {
  const { profileDir, create } = fixture(t);
  const original = resolve(profileDir, 'profile'), retained = resolve(profileDir, 'retained-profile');
  for (const path of [original, retained]) assert.equal(dirname(path), resolve(profileDir));
  mkdirSync(original);
  const store = create({ profileDir: original });
  const saved = confirm(store);
  renameSync(original, retained);
  mkdirSync(original);
  assert.equal(store.snapshot().confirmed, false);
  assert.equal(store.snapshot().errorCode, 'COMPATIBILITY_STATE_PATH_UNSAFE');
  assert.throws(() => store.confirm({ ...PAIR, expectedRevision: saved.revision, acceptRisk: true }),
    { code: 'COMPATIBILITY_STATE_PATH_UNSAFE' });
  assert.deepEqual(readdirSync(original), []);
});

test('a linked state file is refused including a dangling target', t => {
  const { profileDir, path, create } = fixture(t);
  mkdirSync(dirname(path));
  try { symlinkSync(join(profileDir, 'absent-state.json'), path, 'file'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('File symlinks are not permitted for this test user.'); return; }
    throw error;
  }
  const store = create();
  assert.equal(store.snapshot().errorCode, 'COMPATIBILITY_STATE_PATH_UNSAFE');
  assert.throws(() => store.confirm({ ...PAIR, expectedRevision: 'missing', acceptRisk: true }), { code: 'COMPATIBILITY_STATE_PATH_UNSAFE' });
  assert.equal(existsSync(join(profileDir, 'absent-state.json')), false);
});

test('writers use owned locks and cannot replace an active or unproven owner', t => {
  const { path, create } = fixture(t);
  const second = create();
  let checked = false;
  const first = create({ fault(point) {
    if (point !== 'before-publish') return;
    assert.throws(() => confirm(second), { code: 'COMPATIBILITY_STATE_BUSY' });
    checked = true;
  } });
  confirm(first);
  assert.equal(checked, true);
  const lockPath = path + '.dsh-grok-search.lock';
  const lock = acquireOwnedLock(lockPath);
  try { assert.throws(() => second.revoke(request(second)), { code: 'COMPATIBILITY_STATE_BUSY' }); }
  finally { lock.release(); }
  writeFileSync(lockPath, 'unproven-owner');
  assert.throws(() => second.revoke(request(second)), { code: 'COMPATIBILITY_STATE_BUSY' });
  assert.equal(readFileSync(lockPath, 'utf8'), 'unproven-owner');
});

test('an external change before publish is preserved and staging is removed', t => {
  const { path, create } = fixture(t), initial = create();
  confirm(initial);
  let external;
  const raced = create({ fault(point) {
    if (point !== 'before-publish') return;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.generation++;
    value.pairs[0].confirmed = false;
    external = JSON.stringify(value);
    writeFileSync(path, external);
  } });
  assert.throws(() => raced.revoke(request(raced)), { code: 'COMPATIBILITY_CONFLICT' });
  assert.equal(readFileSync(path, 'utf8'), external);
  assert.deepEqual(readdirSync(dirname(path)), ['compatibility-state.json']);
});

test('publication faults distinguish unchanged state from uncertain committed state', t => {
  for (const point of ['before-publish', 'after-publish']) {
    const { path, create } = fixture(t);
    const first = create();
    const prior = first.markNotified(request(first));
    const faulted = create({ fault(stage) { if (stage === point) throw new Error('private-fault-path'); } });
    assert.throws(() => confirm(faulted), error => {
      assert.doesNotMatch(error.message, /private-fault-path/);
      return error.code === (point === 'before-publish' ? 'COMPATIBILITY_STATE_WRITE_FAILED' : 'COMPATIBILITY_STATE_COMMIT_UNCERTAIN');
    });
    assert.equal(first.snapshot().confirmed, point === 'after-publish');
    if (point === 'before-publish') assert.equal(first.revision, prior.revision);
    assert.deepEqual(readdirSync(dirname(path)), ['compatibility-state.json']);
  }
});

test('replacing a lock after publication does not let release delete its successor', t => {
  const { path, create } = fixture(t);
  const lockPath = path + '.dsh-grok-search.lock';
  const store = create({ fault(point) {
    if (point !== 'after-publish') return;
    unlinkSync(lockPath);
    writeFileSync(lockPath, 'replacement-owner', { flag: 'wx' });
  } });
  assert.equal(confirm(store).confirmed, true);
  assert.equal(readFileSync(lockPath, 'utf8'), 'replacement-owner');
});

test('modified staging content is never published as consent', t => {
  const { path, create } = fixture(t);
  const store = create({ fault(point) {
    if (point !== 'before-publish') return;
    const stage = readdirSync(dirname(path)).find(name => name.endsWith('.tmp'));
    writeFileSync(join(dirname(path), stage), '{}');
  } });
  assert.throws(() => confirm(store), { code: 'COMPATIBILITY_STATE_PATH_UNSAFE' });
  assert.equal(store.snapshot().confirmed, false);
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(dirname(path)), []);
});

test('bounded state never evicts earlier confirmations to admit a new pair', t => {
  const { create, write } = fixture(t);
  write({ schemaVersion: 1, generation: 1, pairs: Array.from({ length: MAX_COMPATIBILITY_PAIRS },
    (_, index) => ({ hostVersion: `0.2.2-alpha.${index}`, pluginVersion: '0.4.0', confirmed: true, notified: true })) });
  const first = create({ hostVersion: '0.2.2-alpha.0' });
  const newer = create({ hostVersion: '0.2.2-alpha.999' });
  assert.throws(() => confirm(newer), { code: 'COMPATIBILITY_STATE_FULL' });
  assert.equal(first.snapshot().confirmed, true);
  assert.equal(newer.snapshot().confirmed, false);
  assert.equal(newer.revoke(request(newer)).confirmed, false);
});

test('independent consent revisions never alter preferences or their revision', t => {
  const { profileDir, create } = fixture(t);
  const preferences = createPrivatePreferences({ path: join(profileDir, 'grok-search', 'preferences.json') });
  const first = preferences.snapshot();
  const saved = preferences.save(first.revision, first.value);
  const store = create();
  store.markNotified(request(store));
  confirm(store);
  store.revoke(request(store));
  assert.deepEqual(preferences.snapshot(), saved);
});

test('onChange reports immediate own commits and detects another store without holding the process open', async t => {
  const { create } = fixture(t), store = create(), external = create();
  const updates = [];
  const stop = store.onChange(value => updates.push(value));
  confirm(store);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].confirmed, true);
  external.revoke(request(external));
  const until = Date.now() + 4000;
  while (updates.length < 2 && Date.now() < until) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  assert.equal(updates.length, 2);
  assert.equal(updates[1].confirmed, false);
  assert.notEqual(updates[0].revision, updates[1].revision);
  stop();
  confirm(store);
  assert.equal(updates.length, 2);
});

test('corruption observed by a subscription promptly removes a previous grant', async t => {
  const { create, write } = fixture(t), store = create();
  confirm(store);
  const updates = [];
  store.onChange(value => updates.push(value));
  write('{');
  const until = Date.now() + 4000;
  while (!updates.length && Date.now() < until) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  assert.equal(updates[0]?.confirmed, false);
  assert.equal(updates[0]?.errorCode, 'COMPATIBILITY_STATE_INVALID');
});

test('disposed state cannot grant and broken sync or async listeners cannot undo a committed change', async t => {
  const { create } = fixture(t), store = create();
  store.onChange(() => { throw new Error('subscriber failure'); });
  store.onChange(async () => { throw new Error('async subscriber failure'); });
  assert.equal(confirm(store).confirmed, true);
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  store.dispose();
  assert.equal(store.snapshot().confirmed, false);
  assert.equal(store.snapshot().errorCode, 'COMPATIBILITY_STATE_UNAVAILABLE');
  assert.throws(() => store.confirm({ ...PAIR, expectedRevision: 'missing', acceptRisk: true }), { code: 'COMPATIBILITY_STATE_UNAVAILABLE' });
});

test('CLI requires an explicit profile, exact versions and deliberate acceptance without leaking paths', t => {
  const { profileDir, create } = fixture(t);
  let output = '', errors = '';
  const io = { stdout: { write(value) { output += value; } }, stderr: { write(value) { errors += value; } } };
  const flags = ['--profile-dir', profileDir, '--host-version', PAIR.hostVersion, '--plugin-version', PAIR.pluginVersion];
  for (const args of [
    [], ['confirm', ...flags], ['inspect', ...flags, '--accept-risk'], ['confirm', ...flags, '--accept-risk', '--accept-risk'],
    ['confirm', ...flags, '--accept-risk', '--host-version', PAIR.hostVersion],
    ['confirm', '--host-version', PAIR.hostVersion, '--plugin-version', PAIR.pluginVersion, '--accept-risk'],
    ['inspect', ...flags, '--allow-version'], ['revoke', ...flags, '--accept-risk'],
  ]) {
    output = ''; errors = '';
    assert.equal(runCompatibilityCli(args, io), 1);
    assert.equal(output, '');
    assert.equal(errors.includes(profileDir), false);
  }
  assert.equal(runCompatibilityCli(['inspect', ...flags], io), 0);
  assert.equal(create().snapshot().revision, 'missing');
  output = '';
  assert.equal(runCompatibilityCli(['confirm', ...flags, '--accept-risk'], io), 0);
  assert.equal(JSON.parse(output).confirmed, true);
  assert.equal(JSON.parse(output).hostVersion, PAIR.hostVersion);
  assert.equal(output.includes(profileDir), false);
  output = '';
  assert.equal(runCompatibilityCli(['revoke', ...flags], io), 0);
  assert.equal(JSON.parse(output).confirmed, false);
});

test('the shipped CLI entry point executes and its inspection makes no directory', t => {
  const { profileDir } = fixture(t);
  const entry = fileURLToPath(new URL('../src/core/compatibility-cli.mjs', import.meta.url));
  const args = ['inspect', '--profile-dir', profileDir, '--host-version', PAIR.hostVersion, '--plugin-version', PAIR.pluginVersion];
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).revision, 'missing');
  assert.equal(existsSync(join(profileDir, 'grok-search')), false);
  assert.ok(readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n'));
});

test('the CLI entry point also executes when invoked through an npm-style file link', t => {
  const { profileDir } = fixture(t);
  const entry = fileURLToPath(new URL('../src/core/compatibility-cli.mjs', import.meta.url));
  const link = join(profileDir, 'dsh-grok-search-compatibility.mjs');
  try { symlinkSync(entry, link, 'file'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('File symlinks are not permitted for this test user.'); return; }
    throw error;
  }
  const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<inspect\|confirm\|revoke>/);
  assert.equal(existsSync(join(profileDir, 'grok-search')), false);
});
