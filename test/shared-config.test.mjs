import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSharedConfigStore, patchSharedToml, resolveSharedConfigPath } from '../src/core/shared-config.mjs';

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

test('default location follows upstream HOME / USERPROFILE and explicit precedence', () => {
  const { root } = setup();
  assert.equal(resolveSharedConfigPath({ env: { HOME: root } }), join(root, '.config/grok-search-rs/config.toml'));
  assert.equal(resolveSharedConfigPath({ env: { USERPROFILE: root } }), join(root, '.config/grok-search-rs/config.toml'));
  assert.equal(resolveSharedConfigPath({ override: join(root, 'explicit.toml'), env: { GROK_SEARCH_CONFIG: join(root, 'env.toml') } }), join(root, 'explicit.toml'));
  assert.throws(() => resolveSharedConfigPath({ override: 'relative.toml' }), code('CONFIG_PATH_INVALID'));
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
    { source_providers: ['tavily', 'tavily'] }, { fallback_sources: 0 },
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
