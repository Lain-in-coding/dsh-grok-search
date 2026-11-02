import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
