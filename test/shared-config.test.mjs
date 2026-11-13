import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_FIELDS, createSharedConfigStore, patchSharedToml, resolveSharedConfigPath } from '../src/core/shared-config.mjs';

function setup(text, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-test-'));
  const path = join(root, 'config.toml');
  if (text !== undefined) writeFileSync(path, text);
  const historyDirectory = join(root, 'private-history');
  return { root, path, historyDirectory, store: createSharedConfigStore({ path, historyDirectory, env: () => ({}), ...options }) };
}
const code = wanted => error => error.code === wanted;

test('missing configuration stays read-only until explicit save', () => {
  const { path, store } = setup();
  const snapshot = store.snapshot();
  assert.equal(snapshot.revision, 'missing');
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.fields.grok_api_key.configured, false);
  assert.equal(snapshot.fields.response_max_chars.value, 45_000, 'same default as upstream 0.1.26');
  assert.equal(existsSync(path), false);
  const saved = store.save({ expectedRevision: snapshot.revision, updates: { grok_api_key: 'synthetic-key' } });
  assert.equal(saved.exists, true);
  assert.equal(saved.fields.grok_api_key.configured, true);
  assert.equal(saved.fields.grok_api_key.value, null);
  assert.ok(!JSON.stringify(saved).includes('synthetic-key'));
  assert.equal(store.reveal('grok_api_key').value, 'synthetic-key');
});

test('environment overrides file and defaults, without exposing secret values', () => {
  const { store } = setup('grok_api_key = "file-key"\nweb_search_enabled = true\n', {
    env: () => ({ GROK_SEARCH_API_KEY: 'env-key', GROK_SEARCH_WEB_SEARCH: 'false', GROK_SEARCH_EXTRA_SOURCES: '4' }),
  });
  const state = store.snapshot();
  assert.equal(state.fields.grok_api_key.source, 'environment');
  assert.equal(state.fields.grok_api_key.readOnly, true);
  assert.equal(state.fields.web_search_enabled.value, false);
  assert.equal(state.fields.default_extra_sources.value, 4);
  assert.equal(store.reveal('grok_api_key').value, 'env-key');
  assert.ok(!JSON.stringify(state).includes('env-key'));
  assert.ok(!JSON.stringify(state).includes('file-key'));
  assert.throws(() => store.save({ expectedRevision: state.revision, updates: { grok_api_key: 'ignored-key' } }),
    code('CONFIG_ENV_OVERRIDE'));
});

test('all file-backed keys stay editable and persistent across independent store lifetimes', () => {
  const { path, historyDirectory, store } = setup('# Existing shared file\nfuture_setting = "preserved"\n');
  const keys = Object.entries(CONFIG_FIELDS).filter(([, spec]) => spec.type === 'secret').map(([key]) => key);
  const updates = Object.fromEntries(keys.map(key => [key, 'synthetic-persisted-' + key]));
  const saved = store.save({ expectedRevision: store.snapshot().revision, updates });
  const reopen = () => createSharedConfigStore({ path, historyDirectory, env: () => ({}) });
  for (const key of keys) {
    const reopened = reopen();
    assert.equal(reopened.snapshot().revision, saved.revision);
    assert.equal(reopened.snapshot().fields[key].source, 'file');
    assert.equal(reopened.snapshot().fields[key].readOnly, false);
    assert.equal(reopened.reveal(key).value, updates[key]);
  }
  const reopened = reopen();
  reopened.save({ expectedRevision: reopened.snapshot().revision, updates: { exa_api_key: 'synthetic-replaced-again' } });
  assert.equal(reopen().reveal('exa_api_key').value, 'synthetic-replaced-again');
  assert.equal(store.reveal('exa_api_key').value, 'synthetic-replaced-again', 'other readers of the same file see the update');
  assert.match(readFileSync(path, 'utf8'), /# Existing shared file\nfuture_setting = "preserved"/);
});

test('paired settings snapshot enumerates environment once and returns matching redacted and private values', () => {
  let enumerations = 0, reads = 0;
  const environment = new Proxy({ GROK_SEARCH_API_KEY: 'synthetic-first', GROK_SEARCH_MODEL: 'first' }, {
    ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
  });
  const { store, path } = setup('tavily_api_key = "synthetic-file"\n', {
    env: () => { reads++; return environment; },
  });
  const first = store.readSnapshot();
  assert.equal(reads, 1);
  assert.equal(enumerations, 1, 'one native enumeration per observation, not one per configuration field');
  assert.equal(first.snapshot.fields.grok_api_key.configured, true);
  assert.equal(first.effective.grok_api_key.value, 'synthetic-first');
  assert.ok(!JSON.stringify(first.snapshot).includes('synthetic-'));
  assert.equal(first.snapshot.fields.grok_model.value, first.effective.grok_model.value);
  environment.GROK_SEARCH_API_KEY = 'synthetic-next';
  writeFileSync(path, 'tavily_api_key = "synthetic-changed"\n');
  const second = store.readSnapshot();
  assert.equal(reads, 2);
  assert.equal(enumerations, 2);
  assert.equal(second.effective.grok_api_key.value, 'synthetic-next');
  assert.equal(second.effective.tavily_api_key.value, 'synthetic-changed');
  assert.notEqual(first.snapshot.revision, second.snapshot.revision);
  assert.ok(!JSON.stringify(second.snapshot).includes('synthetic-'));
});

test('single-pass environment capture retains platform case and first-match behavior', () => {
  const { store } = setup('', { env: () => ({
    grok_search_model: 'lower-case', GROK_SEARCH_MODEL: 'upper-case',
  }) });
  assert.equal(store.snapshot().fields.grok_model.value, process.platform === 'win32' ? 'lower-case' : 'upper-case');
});

test('default location follows upstream HOME / USERPROFILE and explicit precedence', () => {
  const { root } = setup();
  assert.equal(resolveSharedConfigPath({ env: { HOME: root } }), join(root, '.config/grok-search-rs/config.toml'));
  assert.equal(resolveSharedConfigPath({ env: { USERPROFILE: root } }), join(root, '.config/grok-search-rs/config.toml'));
  assert.equal(resolveSharedConfigPath({ override: join(root, 'explicit.toml'), env: { GROK_SEARCH_CONFIG: join(root, 'env.toml') } }), join(root, 'explicit.toml'));
  assert.throws(() => resolveSharedConfigPath({ override: 'relative.toml' }), code('CONFIG_PATH_INVALID'));
});

test('Windows MSYS home is normalized without replacing an explicit isolated HOME', () => {
  for (const home of ['/c/Users/review', '/mnt/c/Users/review', '/cygdrive/c/Users/review']) {
    assert.equal(resolveSharedConfigPath({ env: { HOME: home, USERPROFILE: 'C:\\other' }, platform: 'win32' }),
      'C:\\Users\\review\\.config\\grok-search-rs\\config.toml');
  }
  assert.equal(resolveSharedConfigPath({ env: { HOME: 'D:\\isolated', USERPROFILE: 'C:\\real' }, platform: 'win32' }),
    'D:\\isolated\\.config\\grok-search-rs\\config.toml');
  assert.equal(resolveSharedConfigPath({ env: { HOME: '/tmp/isolated' }, platform: 'linux' }),
    '/tmp/isolated/.config/grok-search-rs/config.toml');
});

test('prototype property names cannot bypass the shared configuration allowlist', () => {
  for (const key of ['toString', 'hasOwnProperty', 'valueOf', 'constructor', '__proto__']) {
    for (const value of ['synthetic', null]) {
      assert.throws(() => patchSharedToml('', { [key]: value }), code('CONFIG_FIELD_READ_ONLY'));
    }
  }
  const { store } = setup('toString = "preserved"\nhasOwnProperty = "retained"\n');
  assert.deepEqual(store.snapshot().unknownFields, ['toString', 'hasOwnProperty']);
});

test('editable fallback and response limits match their runtime boundaries', () => {
  const { store } = setup();
  for (const updates of [{ fallback_sources: 0, response_max_chars: 100 },
    { fallback_sources: 10, response_max_chars: 500000 }]) {
    const saved = store.save({ expectedRevision: store.snapshot().revision, updates });
    for (const [key, value] of Object.entries(updates)) assert.equal(saved.fields[key].value, value);
  }
  for (const updates of [{ fallback_sources: -1 }, { fallback_sources: 11 },
    { response_max_chars: 99 }, { response_max_chars: 500001 }]) {
    assert.throws(() => store.save({ expectedRevision: store.snapshot().revision, updates }), code('CONFIG_VALUE_INVALID'));
  }
});

test('localized edit preserves comments, blank lines, CRLF, unknown keys and tables', () => {
  const original = '# heading\r\n\r\ngrok_model  = "old"   # model comment\r\nunknown = 9007199254740993\r\n[future]\r\nx = 42\r\n';
  const changed = patchSharedToml(original, { grok_model: 'new', tavily_api_key: 'synthetic' });
  assert.equal(changed, '# heading\r\n\r\ngrok_model  = "new"   # model comment\r\nunknown = 9007199254740993\r\ntavily_api_key = "synthetic"\r\n[future]\r\nx = 42\r\n');
});

test('hash characters and quotes inside secrets are never retained as comments', () => {
  for (const old of ['"old # secret"', "'old # secret'", '"""old\n# secret"""', "'''old\n# secret'''"]) {
    const result = patchSharedToml(`grok_api_key = ${old} # actual comment\n`, { grok_api_key: 'new-synthetic' });
    assert.equal(result, 'grok_api_key = "new-synthetic" # actual comment\n');
    assert.ok(!result.includes('old'));
  }
});

test('multiline source arrays and quoted root fields edit without flattening other fields', () => {
  const original = '"source_providers" = [\n  "tavily", # first\n  "exa",\n]\n\'grok_model\' = "old"\nextra = """text\nmore text"""\n';
  const result = patchSharedToml(original, { source_providers: ['tinyfish', 'firecrawl'], grok_model: 'new' });
  assert.ok(result.includes('extra = """text\nmore text"""'));
  assert.ok(result.includes("'grok_model' = \"new\""));
  const { store } = setup(result);
  assert.deepEqual(store.snapshot().fields.source_providers.value, ['tinyfish', 'firecrawl']);
});

test('UTF-8 BOM and literal quote styles survive editing unrelated values', () => {
  assert.equal(patchSharedToml('\uFEFFgrok_model = "old"\r\n', { grok_model: 'new' }), '\uFEFFgrok_model = "new"\r\n');
  const unchanged = "custom = '''literal\n# not a comment'''\n";
  assert.ok(patchSharedToml(unchanged, { grok_model: 'new' }).startsWith(unchanged));
});

test('stale and late saves conflict instead of overwriting another writer', () => {
  const { store, path } = setup('grok_model = "base"\n');
  const revision = store.snapshot().revision;
  const saved = store.save({ expectedRevision: revision, updates: { grok_model: 'first' } });
  assert.notEqual(saved.revision, revision);
  assert.throws(() => store.save({ expectedRevision: revision, updates: { grok_model: 'late' } }), code('CONFIG_CONFLICT'));
  assert.equal(readFileSync(path, 'utf8'), 'grok_model = "first"\n');
});

test('external write detected immediately before publish keeps the external change', () => {
  let path;
  const result = setup('grok_model = "base"\n', { fault: stage => {
    if (stage === 'before-publish') writeFileSync(path, 'grok_model = "external"\n');
  } });
  path = result.path;
  assert.throws(() => result.store.save({ expectedRevision: result.store.snapshot().revision, updates: { grok_model: 'draft' } }), code('CONFIG_CONFLICT'));
  assert.equal(readFileSync(path, 'utf8'), 'grok_model = "external"\n');
});

test('exclusive lock is not stolen or automatically deleted', () => {
  const { store, path } = setup('grok_model = "base"\n');
  writeFileSync(path + '.dsh-grok-search.lock', 'other-writer');
  assert.throws(() => store.save({ expectedRevision: store.snapshot().revision, updates: { grok_model: 'new' } }), code('CONFIG_BUSY'));
  assert.equal(readFileSync(path + '.dsh-grok-search.lock', 'utf8'), 'other-writer');
});

test('prepublish failure leaves original intact and retains private history', () => {
  const { store, path } = setup('grok_api_key = "old-synthetic"\n', { fault: () => { throw new Error('simulated I/O failure'); } });
  const revision = store.snapshot().revision;
  assert.throws(() => store.save({ expectedRevision: revision, updates: { grok_api_key: 'new-synthetic' } }), code('CONFIG_WRITE_FAILED'));
  assert.equal(readFileSync(path, 'utf8'), 'grok_api_key = "old-synthetic"\n');
  assert.deepEqual(store.history(), [{ revision }]);
  assert.equal(existsSync(path + '.dsh-grok-search.lock'), false);
});

test('postpublish interruption is uncertain rather than falsely claiming rollback', () => {
  const { store } = setup('grok_model = "old"\n', { fault: stage => { if (stage === 'after-publish') throw new Error('interruption'); } });
  assert.throws(() => store.save({ expectedRevision: store.snapshot().revision, updates: { grok_model: 'new' } }), code('CONFIG_COMMIT_UNCERTAIN'));
  assert.equal(store.snapshot().fields.grok_model.value, 'new');
});

test('missing or replaced config lock does not undo a saved result or delete another owner', () => {
  for (const replacement of [null, 'next-owner']) {
    let lockPath;
    const { store, path } = setup('grok_model = "old"\n', { fault: stage => {
      if (stage !== 'after-publish') return;
      unlinkSync(lockPath);
      if (replacement) writeFileSync(lockPath, replacement, { flag: 'wx' });
    } });
    lockPath = path + '.dsh-grok-search.lock';
    const saved = store.save({ expectedRevision: store.snapshot().revision, updates: { grok_model: 'new' } });
    assert.equal(saved.fields.grok_model.value, 'new');
    assert.equal(existsSync(lockPath), replacement !== null);
    if (replacement) assert.equal(readFileSync(lockPath, 'utf8'), replacement);
  }
});

test('history restore requires current revision and original bytes match exactly', () => {
  const original = '# private\n\ngrok_api_key  = "old-synthetic" # keep\n';
  const { store, path } = setup(original);
  const before = store.snapshot();
  const saved = store.save({ expectedRevision: before.revision, updates: { grok_api_key: 'new-synthetic' } });
  assert.throws(() => store.restore({ expectedRevision: before.revision, revision: before.revision }), code('CONFIG_CONFLICT'));
  const restored = store.restore({ expectedRevision: saved.revision, revision: before.revision });
  assert.equal(restored.revision, before.revision);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.throws(() => store.restore({ expectedRevision: restored.revision, revision: '../config' }), code('CONFIG_HISTORY_INVALID'));
});

test('deleting a value retains its user comment and falls back to defaults', () => {
  const { store, path } = setup('grok_model = "custom" # user comment\ngrok_api_key = "key"\n');
  store.save({ expectedRevision: store.snapshot().revision, updates: { grok_model: null, grok_api_key: null } });
  assert.equal(readFileSync(path, 'utf8'), '# user comment\n\n');
  assert.equal(store.snapshot().fields.grok_model.source, 'default');
  assert.equal(store.reveal('grok_api_key').value, '');
});

test('invalid TOML and types fail without returning secret-containing parser errors', () => {
  for (const content of ['grok_api_key = "synthetic-unclosed', 'cache_size = "bad"', '__proto__.polluted = true']) {
    const { store } = setup(content);
    assert.throws(() => store.snapshot(), error => !error.message.includes('synthetic-unclosed') && error.code.startsWith('CONFIG_'));
  }
});

test('unsupported values cannot silently change upstream semantics', () => {
  const { store, path } = setup();
  for (const updates of [
    { grok_auth_mode: 'oauth' }, { bogus: true }, { source_providers: ['github'] },
    { source_providers: ['tavily', 'tavily'] }, { fallback_sources: -1 },
    { cache_size: 1.5 }, { tavily_api_url: 'http://remote.example' },
    { grok_api_url: 'https://user:secret@example.com' }, { grok_api_key: 'a\nb' },
    { timeout_seconds: 9999 },
  ]) assert.throws(() => store.save({ expectedRevision: 'missing', updates }), error => error.code.startsWith('CONFIG_'));
  assert.equal(existsSync(path), false);
  assert.throws(() => store.reveal('grok_model'), code('CONFIG_FIELD_INVALID'));
});

test('unknown fields are reported by name but retained verbatim', () => {
  const { store, path } = setup('future_secret = "private-synthetic"\ngrok_model = "old"\n');
  const state = store.snapshot();
  assert.deepEqual(state.unknownFields, ['future_secret']);
  assert.ok(!JSON.stringify(state).includes('private-synthetic'));
  store.save({ expectedRevision: state.revision, updates: { grok_model: 'new' } });
  assert.equal(readFileSync(path, 'utf8'), 'future_secret = "private-synthetic"\ngrok_model = "new"\n');
});

test('no-op save is idempotent and creates no redundant history', () => {
  const { store } = setup('grok_model = "existing"\n');
  const revision = store.snapshot().revision;
  assert.equal(store.save({ expectedRevision: revision, updates: { grok_model: 'existing' } }).revision, revision);
  assert.deepEqual(store.history(), []);
});

test('configuration history keeps at most twenty verified revisions', () => {
  const { store } = setup('grok_model = "v0"\n');
  const revisions = [store.snapshot().revision];
  for (let index = 1; index <= 25; index++) {
    const before = store.snapshot();
    revisions.push(before.revision);
    store.save({ expectedRevision: before.revision, updates: { grok_model: `v${index}` } });
  }
  const retained = store.history().map(row => row.revision);
  assert.equal(retained.length, 20);
  assert.equal(retained.includes(revisions[0]), false);
  assert.equal(retained.includes(revisions[1]), false);
  assert.equal(retained.includes(revisions.at(-1)), true);
  assert.equal(store.snapshot().fields.grok_model.value, 'v25');
});

test('age retention uses recorded creation time and leaves unknown-age legacy history untouched', () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const { store, path, historyDirectory } = setup('grok_model = "v0"\n', {
    now: () => new Date(clock),
  });
  const first = store.snapshot();
  store.save({ expectedRevision: first.revision, updates: { grok_model: 'v1' } });
  assert.ok(store.history().some(row => row.revision === first.revision));
  clock += 31 * 24 * 60 * 60 * 1000;
  store.save({ expectedRevision: store.snapshot().revision, updates: { grok_model: 'v2' } });
  assert.equal(store.history().some(row => row.revision === first.revision), false);

  // A history file created before the index existed has no trustworthy age.
  // It may be removed by the count cap, but not by the age rule.
  const legacyText = 'grok_model = "legacy"\n';
  const legacyRevision = createHash('sha256').update(legacyText).digest('hex');
  mkdirSync(historyDirectory, { recursive: true });
  const legacyPath = join(historyDirectory, legacyRevision + '.toml');
  writeFileSync(legacyPath, legacyText);
  const old = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(legacyPath, old, old);
  store.retainHistory();
  assert.equal(existsSync(legacyPath), true);
  assert.equal(readFileSync(path, 'utf8'), 'grok_model = "v2"\n');
});

test('retention never removes a history file whose bytes do not match its revision name', () => {
  const { store, historyDirectory } = setup('grok_model = "base"\n');
  mkdirSync(historyDirectory, { recursive: true });
  const misleading = 'a'.repeat(64) + '.toml';
  writeFileSync(join(historyDirectory, misleading), 'grok_model = "not-the-hash"\n');
  store.retainHistory();
  assert.equal(existsSync(join(historyDirectory, misleading)), true);
});

test('reused configuration hashes refresh undo retention and older restores fit the twenty-entry cap', () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const { store } = setup('grok_model = "base"\n', { now: () => new Date(clock) });
  const original = store.snapshot().revision;
  for (let index = 1; index <= 20; index++) {
    clock += 1000;
    store.save({ expectedRevision: store.snapshot().revision, updates: { grok_model: `version-${index}` } });
  }
  assert.equal(store.history().length, 20);
  store.restore({ expectedRevision: store.snapshot().revision, revision: original });
  assert.equal(store.snapshot().revision, original);
  assert.equal(store.history().length, 20);
  clock += 31 * 24 * 60 * 60 * 1000;
  const saved = store.save({ expectedRevision: original, updates: { grok_model: 'later' } });
  store.restore({ expectedRevision: saved.revision, revision: original });
  assert.equal(store.snapshot().fields.grok_model.value, 'base');
  assert.ok(store.history().length <= 20);
});

test('a corrupt retention index reports maintenance failure without masking a successful save', () => {
  const reports = [];
  const { store, historyDirectory } = setup('grok_model = "before"\n', { onMaintenance: value => reports.push(value) });
  mkdirSync(historyDirectory, { recursive: true });
  writeFileSync(join(historyDirectory, 'index.json'), '{ corrupt');
  const original = store.snapshot().revision;
  const saved = store.save({ expectedRevision: original, updates: { grok_model: 'after' } });
  assert.equal(saved.fields.grok_model.value, 'after');
  assert.equal(store.maintenanceStatus().status, 'error');
  assert.equal(reports.at(-1).code, 'CONFIG_HISTORY_INVALID');
  assert.equal(readFileSync(join(historyDirectory, 'index.json'), 'utf8'), '{ corrupt');
  assert.equal(existsSync(join(historyDirectory, original + '.toml')), true);
  store.restore({ expectedRevision: saved.revision, revision: original });
  assert.equal(store.snapshot().fields.grok_model.value, 'before');
});

test('a partial history write cannot publish a corrupt backup or permanently block later saves', () => {
  const raw = 'grok_model = "original-before-write-failure"\n';
  const { store, historyDirectory } = setup(raw);
  const before = store.snapshot(), originalWrite = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = (file, data, ...options) => {
    if (!injected && String(data) === raw) {
      injected = true;
      originalWrite(file, raw.slice(0, 10), ...options);
      throw Object.assign(new Error('synthetic short history write'), { code: 'ENOSPC' });
    }
    return originalWrite(file, data, ...options);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.save({ expectedRevision: before.revision, updates: { grok_model: 'next' } }),
      { code: 'CONFIG_WRITE_FAILED' });
  } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(store.snapshot().revision, before.revision);
  assert.equal(existsSync(join(historyDirectory, before.revision + '.toml')), false,
    'partial bytes must never occupy the content-addressed backup filename');
  assert.equal(store.save({ expectedRevision: before.revision, updates: { grok_model: 'next' } }).fields.grok_model.value, 'next');
  assert.equal(readFileSync(join(historyDirectory, before.revision + '.toml'), 'utf8'), raw);
});

test('history maintenance and restore use the same config lock and cannot race a save', () => {
  let other;
  const { store, path, historyDirectory } = setup('grok_model = "before"\n', { fault(stage) {
    if (stage !== 'before-publish') return;
    assert.throws(() => other.retainHistory(), { code: 'EEXIST' });
  } });
  other = createSharedConfigStore({ path, historyDirectory });
  store.save({ expectedRevision: store.snapshot().revision, updates: { grok_model: 'after' } });
});

test('directory targets are rejected', () => {
  const { root } = setup();
  assert.throws(() => createSharedConfigStore({ path: root }).snapshot(), code('CONFIG_PATH_UNSAFE'));
});

test('symlink targets are rejected', { skip: process.platform === 'win32' ? 'Windows file symlink creation may require elevation' : false }, () => {
  const { store, path, root } = setup();
  const target = join(root, 'target.toml');
  writeFileSync(target, 'grok_model="test"\n');
  symlinkSync(target, path);
  assert.throws(() => store.snapshot(), code('CONFIG_PATH_UNSAFE'));
  const folder = join(root, 'folder');
  mkdirSync(folder);
  assert.throws(() => createSharedConfigStore({ path: folder }).snapshot(), code('CONFIG_PATH_UNSAFE'));
});
