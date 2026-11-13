import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { GrokSearchError, isRecord } from './errors.mjs';
import { acquireOwnedLock, DEFAULT_STALE_LOCK_MS } from './owned-lock.mjs';
export { resolveSharedConfigPath } from './config-path.mjs';

const fail = (code, message) => { throw new GrokSearchError(code, message); };
const hash = text => createHash('sha256').update(text).digest('hex');
const MAX_BYTES = 1_048_576;
const MAX_HISTORY_INDEX_BYTES = 262_144;
const DEFAULT_HISTORY_MAX_ENTRIES = 20;
const DEFAULT_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const field = (env, type, fallback, extra = {}) => Object.freeze({ env, type, fallback, ...extra });
export const SOURCE_PROVIDERS = Object.freeze(['tavily', 'exa', 'tinyfish', 'firecrawl']);
export const CONFIG_FIELDS = Object.freeze({
  grok_api_url: field('GROK_SEARCH_URL', 'url', 'https://api.x.ai'),
  grok_api_key: field('GROK_SEARCH_API_KEY', 'secret', ''),
  grok_model: field('GROK_SEARCH_MODEL', 'string', 'grok-4-1-fast-reasoning'),
  grok_auth_mode: field('GROK_SEARCH_AUTH_MODE', 'string', 'api_key', { readOnly: true }),
  grok_auth_file: field('GROK_SEARCH_AUTH_FILE', 'string', '', { readOnly: true }),
  web_search_enabled: field('GROK_SEARCH_WEB_SEARCH', 'boolean', true),
  x_search_enabled: field('GROK_SEARCH_X_SEARCH', 'boolean', false),
  openai_compatible_api_url: field('OPENAI_COMPATIBLE_API_URL', 'url', ''),
  openai_compatible_api_key: field('OPENAI_COMPATIBLE_API_KEY', 'secret', ''),
  openai_compatible_model: field('OPENAI_COMPATIBLE_MODEL', 'string', ''),
  tavily_api_url: field('TAVILY_API_URL', 'url', 'https://api.tavily.com'),
  tavily_api_key: field('TAVILY_API_KEY', 'secret', ''),
  tavily_enabled: field('TAVILY_ENABLED', 'boolean', true),
  exa_api_url: field('EXA_API_URL', 'url', 'https://api.exa.ai'),
  exa_api_key: field('EXA_API_KEY', 'secret', ''),
  exa_enabled: field('EXA_ENABLED', 'boolean', true),
  tinyfish_search_api_url: field('TINYFISH_SEARCH_API_URL', 'url', 'https://api.search.tinyfish.ai'),
  tinyfish_fetch_api_url: field('TINYFISH_FETCH_API_URL', 'url', 'https://api.fetch.tinyfish.ai'),
  tinyfish_api_key: field('TINYFISH_API_KEY', 'secret', ''),
  tinyfish_enabled: field('TINYFISH_ENABLED', 'boolean', true),
  firecrawl_api_url: field('FIRECRAWL_API_URL', 'url', 'https://api.firecrawl.dev'),
  firecrawl_api_key: field('FIRECRAWL_API_KEY', 'secret', ''),
  firecrawl_enabled: field('FIRECRAWL_ENABLED', 'boolean', true),
  github_token: field('GITHUB_TOKEN', 'secret', ''),
  source_providers: field('GROK_SEARCH_SOURCE_PROVIDERS', 'sources', SOURCE_PROVIDERS),
  default_extra_sources: field('GROK_SEARCH_EXTRA_SOURCES', 'integer', 3, { min: 0, max: 10 }),
  fallback_sources: field('GROK_SEARCH_FALLBACK_SOURCES', 'integer', 5, { min: 0, max: 10 }),
  timeout_seconds: field('GROK_SEARCH_TIMEOUT_SECONDS', 'integer', 60, { min: 5, max: 300 }),
  cache_size: field('GROK_SEARCH_CACHE_SIZE', 'integer', 256, { min: 1, max: 4096 }),
  response_max_chars: field('GROK_SEARCH_RESPONSE_MAX_CHARS', 'integer', 45000, { min: 100, max: 500000 }),
});
const knownReadOnly = new Set(['fetch_max_chars', 'source_max_answers', 'source_max_comments',
  'enrich_concurrency', 'enrich_max_chars', 'max_inline_sources']);
function environmentValues(environment) {
  // Enumerating process.env on Windows crosses the native environment boundary.
  // Capture it once per read, not once for each field; never cache it across reads.
  const values = new Map();
  for (const [name, value] of Object.entries(environment)) {
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    if (!values.has(key)) values.set(key, value);
  }
  return values;
}

function parseDocument(text) {
  try { return parse(text.replace(/^\uFEFF/, ''), { integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'throw' }); }
  catch { fail('CONFIG_PARSE_FAILED', '配置文件不是有效 TOML，请先修正文件语法。'); }
}
function validateValue(key, value, { writing = false } = {}) {
  const spec = Object.hasOwn(CONFIG_FIELDS, key) ? CONFIG_FIELDS[key] : null;
  if (!spec || writing && spec.readOnly) fail('CONFIG_FIELD_READ_ONLY', '该配置项不允许从插件修改。');
  const invalid = () => fail('CONFIG_VALUE_INVALID', `${key} 的值无效。`);
  if (spec.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < 0 || writing && (value < spec.min || value > spec.max)) invalid();
  } else if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') invalid();
  } else if (spec.type === 'sources') {
    if (!Array.isArray(value) || value.length !== new Set(value).size
      || value.some(item => !SOURCE_PROVIDERS.includes(item))) invalid();
  } else {
    if (typeof value !== 'string' || value.length > 32768 || value.includes('\0')) invalid();
    if (spec.type === 'url' && value !== '') {
      let url;
      try { url = new URL(value); } catch { invalid(); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) invalid();
      if (writing && url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        fail('CONFIG_INSECURE_URL', '远程服务地址必须使用 HTTPS。');
      }
    }
    if (spec.type === 'secret' && writing && /[\r\n]/.test(value)) invalid();
  }
  return value;
}

// Identify root assignment spans without reserializing unrelated TOML. The
// parsed semantic comparison below is a fail-closed guard for unusual syntax.
function statements(text) {
  const output = [];
  let start = text.startsWith('\uFEFF') ? 1 : 0, quote = '', triple = false, depth = 0, comment = false, commentStart = null;
  for (let at = start; at < text.length; at++) {
    const char = text[at];
    if (comment) {
      if (char !== '\n') continue;
      comment = false;
    } else if (quote) {
      if (quote === '"' && char === '\\') { at++; continue; }
      if (char === quote) {
        if (!triple) quote = '';
        else if (text.slice(at, at + 3) === quote.repeat(3)) {
          while (text[at + 1] === quote) at++;
          quote = ''; triple = false;
        }
      }
      continue;
    } else if (char === '#') { comment = true; if (depth === 0) commentStart = at - start; continue; }
    else if (char === '"' || char === "'") {
      quote = char; triple = text.slice(at, at + 3) === char.repeat(3);
      if (triple) at += 2;
      continue;
    } else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    if (char === '\n' && depth === 0) {
      output.push({ start, end: at + 1, text: text.slice(start, at + 1), commentStart });
      start = at + 1; commentStart = null;
    }
  }
  if (start < text.length) output.push({ start, end: text.length, text: text.slice(start), commentStart });
  return output;
}

export function patchSharedToml(text, updates) {
  if (!isRecord(updates)) fail('CONFIG_PATCH_INVALID', '保存内容必须是配置项对象。');
  for (const [key, value] of Object.entries(updates)) {
    if (!Object.hasOwn(CONFIG_FIELDS, key)) fail('CONFIG_FIELD_READ_ONLY', '该配置项不允许从插件修改。');
    if (value !== null) validateValue(key, value, { writing: true });
  }
  for (const key of Object.keys(updates)) {
    if (!Object.hasOwn(CONFIG_FIELDS, key) || CONFIG_FIELDS[key].readOnly) fail('CONFIG_FIELD_READ_ONLY', '该配置项不允许从插件修改。');
  }
  const before = parseDocument(text);
  const expected = Object.assign(Object.create(Object.getPrototypeOf(before)), before);
  for (const [key, value] of Object.entries(updates)) { if (value === null) delete expected[key]; else expected[key] = value; }
  const rows = statements(text), edits = [], found = new Set();
  let insertion = text.length;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  for (const row of rows) {
    if (/^\s*\[/.test(row.text)) { insertion = row.start; break; }
    const match = /^([ \t]*)(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')([ \t]*=[ \t]*)/.exec(row.text);
    const key = match?.[2] ?? match?.[3] ?? match?.[4];
    if (!key || !Object.hasOwn(updates, key)) continue;
    found.add(key);
    // Retain an end-of-assignment comment when replacing its value. Embedded
    // comments in arrays stay unchanged unless that array itself is edited.
    const lineEnding = /\r?\n$/.exec(row.text)?.[0] ?? '';
    const suffix = row.commentStart !== null
      ? /[ \t]*$/.exec(row.text.slice(0, row.commentStart))[0] + row.text.slice(row.commentStart) : lineEnding;
    const value = updates[key];
    const replacement = value === null ? (row.commentStart !== null ? row.text.slice(row.commentStart) : lineEnding)
      : match[0] + stringify({ value }).slice('value = '.length).trimEnd() + suffix;
    edits.push({ start: row.start, end: row.end, replacement });
  }
  const additions = Object.entries(updates).filter(([key, value]) => !found.has(key) && value !== null)
    .map(([key, value]) => stringify({ [key]: value }).replace(/\n/g, newline)).join('');
  if (additions) edits.push({ start: insertion, end: insertion,
    replacement: (insertion > 0 && text[insertion - 1] !== '\n' ? newline : '') + additions });
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  if (!isDeepStrictEqual(parseDocument(result), expected)) fail('CONFIG_EDIT_UNSUPPORTED', '该 TOML 格式无法安全局部修改，原文件未改动。');
  return result;
}

export function createSharedConfigStore({
  path, historyDirectory, env = () => process.env, fault,
  now = () => new Date(),
  retention = {}, onMaintenance = () => {}, trustedHistoryRoot = null,
} = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('CONFIG_PATH_INVALID', '配置文件必须使用绝对路径。');
  if (historyDirectory && !isAbsolute(historyDirectory)) fail('CONFIG_PATH_INVALID', '配置历史必须使用绝对路径。');
  const historyMaxEntries = retention.maxEntries ?? DEFAULT_HISTORY_MAX_ENTRIES;
  const historyMaxAgeMs = retention.maxAgeMs ?? DEFAULT_HISTORY_MAX_AGE_MS;
  if (!Number.isSafeInteger(historyMaxEntries) || historyMaxEntries < 1
    || !Number.isFinite(historyMaxAgeMs) || historyMaxAgeMs < 0) {
    fail('CONFIG_HISTORY_INVALID', '配置历史保留策略无效。');
  }
  const clock = () => {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) fail('CONFIG_HISTORY_INVALID', '配置历史时钟返回值无效。');
    return date;
  };
  const historyIndexPath = historyDirectory ? join(historyDirectory, 'index.json') : null;
  const historyBoundary = historyDirectory ? resolve(trustedHistoryRoot ?? dirname(historyDirectory)) : null;
  if (historyDirectory) {
    const child = relative(historyBoundary, resolve(historyDirectory));
    if (child === '' || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) {
      fail('CONFIG_HISTORY_INVALID', '配置历史目录必须位于可信目录内部。');
    }
  }
  let lastMaintenance = null;
  const checkHistoryDirectory = () => {
    for (let cursor = historyDirectory; cursor; cursor = dirname(cursor)) {
      const entry = lstatSync(cursor, { throwIfNoEntry: false });
      if (entry) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) fail('CONFIG_HISTORY_INVALID', '配置历史目录不是安全的本地目录。');
      }
      if (resolve(cursor) === historyBoundary) break;
      if (dirname(cursor) === cursor) break;
    }
  };
  const historyNames = () => {
    if (!historyDirectory) return [];
    checkHistoryDirectory();
    if (!existsSync(historyDirectory)) return [];
    return readdirSync(historyDirectory).filter(name => /^[a-f0-9]{64}\.toml$/.test(name));
  };
  const readHistoryIndex = () => {
    if (!historyIndexPath || !existsSync(historyIndexPath)) return { entries: {} };
    try {
      const entry = lstatSync(historyIndexPath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_HISTORY_INDEX_BYTES) fail('CONFIG_HISTORY_INVALID', '配置历史索引无效；已保留原文件。');
      const parsed = JSON.parse(readFileSync(historyIndexPath, 'utf8'));
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.entries)) fail('CONFIG_HISTORY_INVALID', '配置历史索引格式无效；已保留原文件。');
      const entries = {};
      for (const [revision, value] of Object.entries(parsed.entries)) {
        if (!/^[a-f0-9]{64}$/.test(revision) || !isRecord(value)
          || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
          fail('CONFIG_HISTORY_INVALID', '配置历史索引条目无效；已保留原文件。');
        }
        entries[revision] = { createdAt: value.createdAt };
      }
      return { entries };
    } catch (error) {
      if (error instanceof GrokSearchError) throw error;
      fail('CONFIG_HISTORY_INVALID', '无法读取配置历史索引；未清理历史。');
    }
  };
  const writeHistoryIndex = entries => {
    if (!historyDirectory) return;
    checkHistoryDirectory();
    mkdirSync(historyDirectory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, entries }, null, 2) + '\n');
    if (bytes.length > MAX_HISTORY_INDEX_BYTES) fail('CONFIG_HISTORY_INVALID', '配置历史索引超过支持大小，已保留原索引。');
    const stage = join(historyDirectory, `.index-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(stage, 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(stage, historyIndexPath);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(stage)) unlinkSync(stage);
    }
  };
  const recordHistory = revision => {
    if (!historyDirectory) return;
    const entries = readHistoryIndex().entries;
    // A reused revision is once again the undo target of a fresh save. Refresh
    // its retention clock so an immediate undo cannot expire an old hash.
    entries[revision] = { createdAt: clock().toISOString() };
    writeHistoryIndex(entries);
  };
  const retainHistory = ({ keep = [] } = {}) => {
    if (!historyDirectory) return { deleted: [], retained: 0 };
    const names = historyNames();
    const index = readHistoryIndex();
    const keepSet = new Set(keep.filter(revision => typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision)));
    const nowMs = clock().getTime(), rows = [];
    for (const name of names) {
      const revision = name.slice(0, -5);
      const fullPath = join(historyDirectory, name);
      let entry;
      try { entry = lstatSync(fullPath); }
      catch { continue; }
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES) fail('CONFIG_HISTORY_INVALID', '配置历史包含非普通文件或超限文件，未继续清理。');
      const createdAt = index.entries[revision]?.createdAt;
      const createdMs = createdAt ? Date.parse(createdAt) : null;
      rows.push({ revision, path: fullPath, createdMs, sortMs: createdMs ?? entry.mtimeMs, entry });
    }
    rows.sort((left, right) => Number(keepSet.has(right.revision)) - Number(keepSet.has(left.revision))
      || right.sortMs - left.sortMs || left.revision.localeCompare(right.revision));
    const deleted = [];
    let retained = 0, keptByCount = 0, changed = false;
    for (const row of rows) {
      const tooOld = row.createdMs !== null && nowMs - row.createdMs > historyMaxAgeMs;
      const future = row.createdMs !== null && nowMs < row.createdMs;
      if (keepSet.has(row.revision)) {
        if (keptByCount < historyMaxEntries) keptByCount++;
        retained++;
        continue;
      }
      if ((!tooOld || future) && keptByCount < historyMaxEntries) {
        keptByCount++;
        retained++;
        continue;
      }
      // Never delete a file whose name no longer matches its exact bytes.
      let bytes;
      bytes = readFileSync(row.path);
      const text = bytes.toString('utf8');
      if (hash(text) !== row.revision || !Buffer.from(text).equals(bytes)) {
        fail('CONFIG_HISTORY_INVALID', '配置历史校验失败，已保留异常文件。');
      }
      const current = lstatSync(row.path);
      if (current.isSymbolicLink() || current.ino !== row.entry.ino || current.dev !== row.entry.dev
        || current.size !== row.entry.size || current.mtimeMs !== row.entry.mtimeMs) {
        fail('CONFIG_HISTORY_INVALID', '配置历史在维护期间发生变化，已停止清理。');
      }
      unlinkSync(row.path);
      delete index.entries[row.revision];
      deleted.push(row.revision);
      changed = true;
    }
    const present = new Set(names);
    for (const revision of Object.keys(index.entries)) {
      if (!present.has(revision + '.toml')) {
        delete index.entries[revision];
        changed = true;
      }
    }
    if (changed) writeHistoryIndex(index.entries);
    return { deleted, retained };
  };
  const reportMaintenance = result => {
    lastMaintenance = result;
    try { onMaintenance(result); }
    catch { lastMaintenance = { ...result, reportingFailed: true }; }
    return result;
  };
  const maintainHistory = keep => {
    try { return reportMaintenance({ status: 'ok', ...retainHistory({ keep }) }); }
    catch (error) { return reportMaintenance({ status: 'error', code: error.code ?? 'CONFIG_HISTORY_FAILED',
      message: '配置已保存，历史维护未完成；历史文件已保留供检查。' }); }
  };
  const read = () => {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('CONFIG_PATH_UNSAFE', '配置目标不是普通文件，请检查实际路径。');
      if (stat.size > MAX_BYTES) fail('CONFIG_SIZE_LIMIT', '配置文件超过 1 MiB，未读取。');
      const bytes = readFileSync(path);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) fail('CONFIG_ENCODING_INVALID', '配置文件必须使用 UTF-8 编码。');
      const values = parseDocument(text);
      for (const [key, value] of Object.entries(values)) if (Object.hasOwn(CONFIG_FIELDS, key)) validateValue(key, value);
      return { text, values, revision: hash(bytes), exists: true, mode: stat.mode & 0o777 };
    } catch (error) {
      if (error.code === 'ENOENT') return { text: '', values: {}, revision: 'missing', exists: false, mode: 0o600 };
      if (error instanceof GrokSearchError) throw error;
      fail('CONFIG_READ_FAILED', '无法读取配置文件，请检查文件权限。');
    }
  };
  const effective = document => {
    const environment = environmentValues(env());
    return Object.fromEntries(Object.entries(CONFIG_FIELDS).map(([key, spec]) => {
    const raw = environment.get(spec.env);
    let value, source;
    if (typeof raw === 'string' && raw !== '') {
      source = 'environment';
      value = spec.type === 'boolean' ? raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : raw
        : spec.type === 'integer' ? /^\d+$/.test(raw) ? Number(raw) : raw
          : spec.type === 'sources' ? raw.split(',').map(item => item.trim()).filter(Boolean) : raw;
    } else {
      source = Object.hasOwn(document.values, key) ? 'file' : 'default';
      value = document.values[key] ?? structuredClone(spec.fallback);
    }
    validateValue(key, value);
    return [key, { value, source, readOnly: spec.readOnly === true || source === 'environment' }];
  }));
  };
  const readSnapshot = () => {
    const document = read();
    const resolved = effective(document);
    const fields = { ...resolved };
    for (const [key, item] of Object.entries(fields)) if (CONFIG_FIELDS[key].type === 'secret') {
      const count = item.value.split(',').filter(value => value.trim()).length;
      fields[key] = { value: null, configured: count > 0, keyCount: count, source: item.source, readOnly: item.readOnly };
    }
    return { effective: resolved, snapshot: { path, exists: document.exists, revision: document.revision, fields,
      unknownFields: Object.keys(document.values).filter(key => !Object.hasOwn(CONFIG_FIELDS, key) && !knownReadOnly.has(key)) } };
  };
  const snapshot = () => readSnapshot().snapshot;
  const preserveHistory = before => {
    checkHistoryDirectory();
    mkdirSync(historyDirectory, { recursive: true, mode: 0o700 });
    const history = join(historyDirectory, before.revision + '.toml');
    const verify = target => {
      const entry = lstatSync(target);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES
        || hash(readFileSync(target)) !== before.revision) {
        fail('CONFIG_HISTORY_INVALID', '保存前历史备份校验失败，原配置未更改。');
      }
    };
    if (existsSync(history)) { verify(history); return; }
    const stage = join(historyDirectory, `.history-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(stage, 'wx', 0o600);
      writeFileSync(fd, before.text);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      verify(stage);
      // A failed/partial write must not occupy the content-addressed name:
      // future saves can retry without deleting or overwriting evidence.
      try { linkSync(stage, history); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      verify(history);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(stage); } catch { /* A private incomplete stage is never a restorable revision. */ }
    }
  };
  const commit = (expectedRevision, transform, { keepHistory = [] } = {}) => {
    if (expectedRevision !== 'missing' && !/^[a-f0-9]{64}$/.test(expectedRevision ?? '')) fail('CONFIG_REVISION_REQUIRED', '保存前必须读取当前配置修订。');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let lock, stage, published = false;
    try {
      const lockPath = path + '.dsh-grok-search.lock';
      try { lock = acquireOwnedLock(lockPath, { reclaimStaleAfterMs: DEFAULT_STALE_LOCK_MS }); }
      catch (error) { if (error.code === 'EEXIST') fail('CONFIG_BUSY', '配置正在保存或上次保存被中断，请稍后检查。'); throw error; }
      const before = read();
      if (before.revision !== expectedRevision) fail('CONFIG_CONFLICT', '配置已被其他程序修改；草稿已保留，请重新读取后合并。');
      const text = transform(before);
      if (Buffer.byteLength(text) > MAX_BYTES) fail('CONFIG_SIZE_LIMIT', '保存内容超过 1 MiB。');
      parseDocument(text);
      if (text === before.text && before.exists) return snapshot();
      if (before.exists && historyDirectory) preserveHistory(before);
      stage = join(dirname(path), '.dsh-grok-search-' + randomUUID() + '.tmp');
      const fd = openSync(stage, 'wx', before.mode);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      fault?.('before-publish');
      if (read().revision !== expectedRevision) fail('CONFIG_CONFLICT', '配置已被其他程序修改；草稿已保留，请重新读取后合并。');
      renameSync(stage, path);
      published = true;
      fault?.('after-publish');
      const result = snapshot();
      if (historyDirectory) {
        try {
          if (before.exists) recordHistory(before.revision);
          maintainHistory([before.revision, ...keepHistory]);
        } catch (error) {
          reportMaintenance({ status: 'error', code: error.code ?? 'CONFIG_HISTORY_FAILED',
            message: '配置已保存，历史索引维护未完成；请检查历史目录。' });
        }
      }
      return result;
    } catch (error) {
      if (published) fail('CONFIG_COMMIT_UNCERTAIN', '配置已写入，但回读未完成；请重新读取后确认，不要重复保存。');
      if (error instanceof GrokSearchError) throw error;
      fail('CONFIG_WRITE_FAILED', '无法保存配置；原文件未由本次操作替换，请检查文件权限。');
    } finally {
      // Staging cleanup and lock release stay separate from verified retention.
      // Never remove another writer's live or replaced lock here.
      if (stage && !published) { try { unlinkSync(stage); } catch {} }
      if (lock) lock.release();
    }
  };
  return Object.freeze({
    snapshot,
    // Server-only paired read: a redacted snapshot and its exact effective
    // identity come from the same file/environment observation.
    readSnapshot,
    readEffective: () => effective(read()),
    reveal(key) {
      if (CONFIG_FIELDS[key]?.type !== 'secret') fail('CONFIG_FIELD_INVALID', '只能显式查看凭据字段。');
      return { key, ...effective(read())[key] };
    },
    save({ expectedRevision, updates }) {
      const captured = structuredClone(updates);
      return commit(expectedRevision, before => {
        const current = effective(before);
        if (isRecord(captured) && Object.keys(captured).some(key => current[key]?.source === 'environment')) {
          fail('CONFIG_ENV_OVERRIDE', '这些配置由启动环境提供，不能在插件中覆盖，请先修改环境变量。');
        }
        return patchSharedToml(before.text, captured);
      });
    },
    history() {
      return historyNames().map(name => ({ revision: name.slice(0, -5) }));
    },
    restore({ expectedRevision, revision }) {
      if (!historyDirectory || !/^[a-f0-9]{64}$/.test(revision ?? '')) fail('CONFIG_HISTORY_INVALID', '配置历史修订无效。');
      return commit(expectedRevision, () => {
        checkHistoryDirectory();
        const historical = join(historyDirectory, revision + '.toml');
        const fd = openSync(historical, 'r');
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > MAX_BYTES || lstatSync(historical).isSymbolicLink()) fail('CONFIG_HISTORY_INVALID', '配置历史文件不安全。');
          const text = readFileSync(fd, 'utf8');
          if (hash(text) !== revision) fail('CONFIG_HISTORY_INVALID', '配置历史校验失败。');
          return text;
        } finally { closeSync(fd); }
      }, { keepHistory: [revision] });
    },
    retainHistory(options) {
      if (!historyDirectory || !existsSync(historyDirectory)) return { deleted: [], retained: 0 };
      const lock = acquireOwnedLock(path + '.dsh-grok-search.lock', { reclaimStaleAfterMs: DEFAULT_STALE_LOCK_MS });
      try { return retainHistory(options); } finally { lock.release(); }
    },
    maintenanceStatus() { return lastMaintenance ? { ...lastMaintenance } : null; },
  });
}
