import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createPrivatePreferences } from '../src/core/private-preferences.mjs';

test('private route preferences use CAS and preserve the safe default', () => {
  const store = createPrivatePreferences({ path: join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json') });
  const initial = store.snapshot();
  assert.equal(initial.revision, 'missing');
  assert.equal(initial.value.grokEnabled, true);
  const saved = store.save(initial.revision, {
    ...initial.value,
    grokEnabled: false,
    sourceOrder: ['exa', 'tavily', 'tinyfish', 'firecrawl'],
  });
  assert.equal(saved.value.grokEnabled, false);
  assert.deepEqual(saved.value.sourceOrder.slice(0, 2), ['exa', 'tavily']);
  assert.throws(() => store.save(initial.revision, saved.value), error => error.code === 'PREFERENCES_CONFLICT');
});

test('invalid source order is rejected instead of silently normalized', () => {
  const store = createPrivatePreferences({ path: join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json') });
  const initial = store.snapshot();
  assert.throws(() => store.save(initial.revision, { ...initial.value, sourceOrder: ['exa'] }),
    error => error.code === 'PREFERENCES_INVALID');
});

test('a dangling preference link is not a first-run default or writable missing file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pref-'));
  const path = join(directory, 'preferences.json');
  const store = createPrivatePreferences({ path });
  const initial = store.snapshot();
  symlinkSync(join(directory, 'missing-target'), path, process.platform === 'win32' ? 'junction' : 'file');
  assert.equal(existsSync(path), false);
  assert.throws(store.snapshot, { code: 'PREFERENCES_PATH_UNSAFE' });
  assert.throws(() => store.save('missing', initial.value), { code: 'PREFERENCES_PATH_UNSAFE' });
  assert.equal(lstatSync(path).isSymbolicLink(), true);
});

test('permission errors cannot silently reset disabled preference choices', () => {
  const moduleUrl = new URL('../src/core/private-preferences.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { resolve } from 'node:path';
    import { createPrivatePreferences } from ${JSON.stringify(moduleUrl)};
    fs.existsSync = () => false;
    fs.lstatSync = () => { throw Object.assign(new Error('private-path'), { code: 'EACCES' }); };
    syncBuiltinESMExports();
    const store = createPrivatePreferences({ path: resolve('synthetic-inaccessible-preferences.json') });
    assert.throws(store.snapshot, error => error.code === 'PREFERENCES_READ_FAILED'
      && !error.message.includes('private-path'));
  `], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('existing private preferences remain usable through a directory alias', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pref-'));
  const outside = join(root, 'outside'), directory = join(root, 'grok-search');
  mkdirSync(outside);
  const initial = createPrivatePreferences({ path: join(root, 'defaults.json') }).snapshot().value;
  writeFileSync(join(outside, 'preferences.json'), JSON.stringify({ ...initial, githubReadEnabled: true }));
  symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  const path = join(directory, 'preferences.json'), store = createPrivatePreferences({ path });
  const before = store.snapshot();
  assert.equal(before.value.githubReadEnabled, true);
  const saved = store.save(before.revision, { ...before.value, grokEnabled: false });
  assert.equal(saved.value.grokEnabled, false);
  assert.equal(saved.value.githubReadEnabled, true);
  const { searchGeneration, ...stored } = JSON.parse(readFileSync(join(outside, 'preferences.json'), 'utf8'));
  assert.equal(typeof searchGeneration, 'string');
  assert.deepEqual(stored, saved.value);
  assert.equal(lstatSync(directory).isSymbolicLink(), true);
});

test('preference directory permission failures use a stable write error without leaking its path', () => {
  const moduleUrl = new URL('../src/core/private-preferences.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { resolve } from 'node:path';
    import { createPrivatePreferences } from ${JSON.stringify(moduleUrl)};
    fs.lstatSync = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
    fs.mkdirSync = () => { throw Object.assign(new Error('/private/preferences'), { code: 'EACCES' }); };
    syncBuiltinESMExports();
    const store = createPrivatePreferences({ path: resolve('synthetic-inaccessible-preferences.json') });
    assert.throws(() => store.save('missing', store.snapshot().value), error =>
      error.code === 'PREFERENCES_WRITE_FAILED' && !error.message.includes('/private/preferences'));
  `], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('new GitHub read consent defaults off and older clients cannot overwrite it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
  const store = createPrivatePreferences({ path });
  const initial = store.snapshot();
  assert.equal(initial.value.githubEnabled, true);
  assert.equal(initial.value.githubReadEnabled, false);
  const enabled = store.save(initial.revision, { ...initial.value, githubReadEnabled: true });
  const { githubReadEnabled, ...oldClient } = enabled.value;
  const saved = store.save(enabled.revision, { ...oldClient, grokEnabled: false });
  assert.equal(saved.value.githubReadEnabled, true);
  assert.throws(() => store.save(saved.revision, { ...saved.value, githubReadEnabled: 'yes' }), { code: 'PREFERENCES_INVALID' });
});

test('missing or malformed sidebar choices read as off without rewriting or masking invalid search settings', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
  const store = createPrivatePreferences({ path });
  const { sidebarShortcutEnabled, ...legacy } = store.snapshot().value;
  assert.equal(sidebarShortcutEnabled, false);
  assert.equal(existsSync(path), false);
  for (const fields of [{}, { sidebarShortcutEnabled: 'true' }, { sidebarShortcutEnabled: 1 }, { sidebarShortcutEnabled: null }]) {
    const raw = JSON.stringify({ ...legacy, grokEnabled: false, githubReadEnabled: true, ...fields });
    writeFileSync(path, raw);
    assert.deepEqual(store.snapshot().value, { ...legacy, grokEnabled: false, githubReadEnabled: true, sidebarShortcutEnabled: false });
    assert.equal(readFileSync(path, 'utf8'), raw);
  }
  writeFileSync(path, JSON.stringify({ ...legacy, grokEnabled: 'false', sidebarShortcutEnabled: 'true' }));
  assert.throws(store.snapshot, { code: 'PREFERENCES_INVALID' });
});

test('sidebar changes use full-file CAS and legacy requests preserve both newer switches', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
  const store = createPrivatePreferences({ path });
  const first = store.snapshot();
  const withConsent = store.save(first.revision, { ...first.value, githubReadEnabled: true });
  const { sidebarShortcutEnabled, githubReadEnabled, ...legacy } = withConsent.value;
  const enabled = store.save(withConsent.revision, { ...withConsent.value, sidebarShortcutEnabled: true });
  const reopened = createPrivatePreferences({ path });
  assert.deepEqual(reopened.snapshot(), enabled);
  assert.notEqual(enabled.revision, withConsent.revision);
  assert.throws(() => reopened.save(withConsent.revision, legacy), { code: 'PREFERENCES_CONFLICT' });
  const saved = reopened.save(enabled.revision, { ...legacy, grokEnabled: false });
  assert.equal(saved.value.sidebarShortcutEnabled, true);
  assert.equal(saved.value.githubReadEnabled, true);
  for (const invalid of [null, 'false', 1, undefined]) {
    assert.throws(() => reopened.save(saved.revision, { ...saved.value, sidebarShortcutEnabled: invalid }), { code: 'PREFERENCES_INVALID' });
  }
  assert.deepEqual(store.snapshot(), saved);
  const disabled = store.save(saved.revision, { ...saved.value, sidebarShortcutEnabled: false });
  assert.equal(reopened.snapshot().value.sidebarShortcutEnabled, false);
  assert.deepEqual(reopened.save(disabled.revision, disabled.value), disabled);
});

test('an older preference writer cannot reactivate a disabled GitHub diagnosis on a sidebar-only edit', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
  const store = createPrivatePreferences({ path });
  const initial = store.snapshot();
  const saved = store.save(initial.revision, { ...initial.value, githubEnabled: false, githubReadEnabled: true });
  const identity = store.diagnosisSnapshot().identity;
  const { githubEnabled, githubReadEnabled, ...legacy } = saved.value;
  const changed = store.save(saved.revision, { ...legacy, sidebarShortcutEnabled: true });
  assert.deepEqual(changed.value, { ...saved.value, sidebarShortcutEnabled: true });
  assert.equal(store.diagnosisSnapshot().identity, identity);
});

test('diagnostic identity tracks search settings and their ABA across writers, not sidebar changes or file formatting', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pref-')), path = join(directory, 'preferences.json');
  const reader = createPrivatePreferences({ path }), writer = createPrivatePreferences({ path });
  const first = reader.snapshot(), identity = reader.diagnosisSnapshot().identity;
  const enabled = writer.save(first.revision, { ...first.value, sidebarShortcutEnabled: true, searchGeneration: 'client-controlled' });
  assert.equal(reader.diagnosisSnapshot().identity, identity);
  assert.equal(Object.hasOwn(enabled.value, 'searchGeneration'), false);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(Object.hasOwn(raw, 'searchGeneration'), false);
  writeFileSync(path, JSON.stringify(raw));
  assert.equal(reader.diagnosisSnapshot().identity, identity);
  assert.notEqual(reader.snapshot().revision, enabled.revision);
  assert.throws(() => writer.save(enabled.revision, enabled.value), { code: 'PREFERENCES_CONFLICT' });
  for (const delta of [{ grokEnabled: false }, { githubEnabled: false }, { githubReadEnabled: true },
    { sourceOrder: [...raw.sourceOrder].reverse() }, { sourceEnabled: { ...raw.sourceEnabled, exa: false } }]) {
    const before = reader.diagnosisSnapshot().identity;
    const changed = writer.save(reader.snapshot().revision, { ...raw, ...delta });
    assert.notEqual(reader.diagnosisSnapshot().identity, before);
    writer.save(changed.revision, raw);
    assert.notEqual(reader.diagnosisSnapshot().identity, before);
    assert.deepEqual(reader.snapshot().value, enabled.value);
  }
  const current = reader.snapshot(), baseline = reader.diagnosisSnapshot().identity;
  writer.save(current.revision, { ...current.value, sidebarShortcutEnabled: false, searchGeneration: 'client-controlled' });
  assert.equal(reader.diagnosisSnapshot().identity, baseline);
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...persisted, grokEnabled: false }));
  assert.notEqual(reader.diagnosisSnapshot().identity, baseline);
});

test('preference writers cooperate through an exclusive lock and never steal an abandoned one', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
  const second = createPrivatePreferences({ path });
  let blocked = false;
  const first = createPrivatePreferences({ path, fault: stage => {
    if (stage !== 'before-publish') return;
    assert.throws(() => second.save('missing', second.snapshot().value), { code: 'PREFERENCES_BUSY' });
    blocked = true;
  } });
  first.save('missing', { ...first.snapshot().value, grokEnabled: false });
  assert.equal(blocked, true);
  assert.equal(second.snapshot().value.grokEnabled, false);
  writeFileSync(path + '.dsh-grok-search.lock', 'abandoned-writer', { flag: 'wx' });
  assert.throws(() => second.save(second.snapshot().revision, second.snapshot().value), { code: 'PREFERENCES_BUSY' });
  assert.equal(readFileSync(path + '.dsh-grok-search.lock', 'utf8'), 'abandoned-writer');
});

test('a noncooperative external change before publish is detected rather than overwritten', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
  const initial = createPrivatePreferences({ path });
  const saved = initial.save('missing', initial.snapshot().value);
  const changed = { ...saved.value, githubEnabled: false };
  const external = JSON.stringify(changed, null, 2) + '\n';
  const late = createPrivatePreferences({ path, fault: stage => {
    if (stage === 'before-publish') writeFileSync(path, external);
  } });
  assert.throws(() => late.save(saved.revision, { ...saved.value, grokEnabled: false }), { code: 'PREFERENCES_CONFLICT' });
  assert.equal(readFileSync(path, 'utf8'), external);
  assert.equal(existsSync(path + '.dsh-grok-search.lock'), false);
});

test('preference failures distinguish unpublished writes from uncertain committed writes', () => {
  for (const point of ['before-publish', 'after-publish']) {
    const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
    const initial = createPrivatePreferences({ path });
    const saved = initial.save('missing', initial.snapshot().value);
    const store = createPrivatePreferences({ path, fault: stage => { if (stage === point) throw new Error('interruption'); } });
    assert.throws(() => store.save(saved.revision, { ...saved.value, grokEnabled: false }),
      { code: point === 'before-publish' ? 'PREFERENCES_WRITE_FAILED' : 'PREFERENCES_COMMIT_UNCERTAIN' });
    assert.equal(initial.snapshot().value.grokEnabled, point === 'before-publish');
    assert.equal(existsSync(path + '.dsh-grok-search.lock'), false);
  }
});

test('preference publication survives a vanished lock and never removes a replacement owner', () => {
  for (const replacement of [null, 'next-owner']) {
    const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
    const lock = path + '.dsh-grok-search.lock';
    const store = createPrivatePreferences({ path, fault: stage => {
      if (stage !== 'after-publish') return;
      unlinkSync(lock);
      if (replacement) writeFileSync(lock, replacement, { flag: 'wx' });
    } });
    const saved = store.save('missing', { ...store.snapshot().value, grokEnabled: false });
    assert.equal(saved.value.grokEnabled, false);
    assert.equal(existsSync(lock), replacement !== null);
    if (replacement) assert.equal(readFileSync(lock, 'utf8'), replacement);
  }
});
test('a post-publish external preference edit never becomes the receipt for a combined undo', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
  const initial = createPrivatePreferences({ path }).snapshot().value;
  const external = JSON.stringify({ ...initial, githubReadEnabled: true });
  const store = createPrivatePreferences({ path, fault: stage => {
    if (stage === 'after-publish') writeFileSync(path, external);
  } });
  assert.throws(() => store.save('missing', { ...initial, grokEnabled: false }), { code: 'PREFERENCES_COMMIT_UNCERTAIN' });
  assert.equal(readFileSync(path, 'utf8'), external);
});
test('modified preference staging cannot grant permissions before readback detects the change', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pref-')), path = join(directory, 'preferences.json');
  const initial = createPrivatePreferences({ path }).snapshot().value;
  const store = createPrivatePreferences({ path, fault: point => {
    if (point !== 'before-publish') return;
    const stage = readdirSync(directory).find(name => name.endsWith('.tmp'));
    writeFileSync(join(directory, stage), JSON.stringify({ ...initial, githubReadEnabled: true }));
  } });
  assert.throws(() => store.save('missing', { ...initial, grokEnabled: false }),
    { code: 'PREFERENCES_PATH_UNSAFE' });
  assert.equal(existsSync(path), false);
});

test('a replaced preference staging file is preserved on a failed publication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pref-')), path = join(directory, 'preferences.json');
  let replacement;
  const store = createPrivatePreferences({ path, fault: point => {
    if (point !== 'before-publish') return;
    replacement = join(directory, readdirSync(directory).find(name => name.endsWith('.tmp')));
    renameSync(replacement, replacement + '.original');
    writeFileSync(replacement, 'external-stage', { flag: 'wx' });
    throw new Error('publication interrupted');
  } });
  assert.throws(() => store.save('missing', store.snapshot().value), { code: 'PREFERENCES_WRITE_FAILED' });
  assert.equal(readFileSync(replacement, 'utf8'), 'external-stage');
  assert.equal(existsSync(path), false);
});

test('idempotent preference saves do not republish and oversized or invalid UTF-8 files fail closed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-pref-')), 'preferences.json');
  const initial = createPrivatePreferences({ path });
  const saved = initial.save('missing', initial.snapshot().value);
  const store = createPrivatePreferences({ path, fault: () => { throw new Error('must not publish'); } });
  assert.deepEqual(store.save(saved.revision, saved.value), saved);
  writeFileSync(path, ' '.repeat(65537));
  assert.throws(store.snapshot, { code: 'PREFERENCES_READ_FAILED' });
  writeFileSync(path, Buffer.from([0xff, 0xfe]));
  assert.throws(store.snapshot, { code: 'PREFERENCES_READ_FAILED' });
});
