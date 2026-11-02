import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { GrokSearchError } from './errors.mjs';

const SOURCES = Object.freeze(['tavily', 'exa', 'tinyfish', 'firecrawl']);
const DEFAULTS = Object.freeze({
  schemaVersion: 1,
  grokEnabled: true,
  githubEnabled: true,
  sourceOrder: SOURCES,
  sourceEnabled: Object.freeze({ tavily: true, exa: true, tinyfish: true, firecrawl: true }),
});
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new GrokSearchError(code, message); };

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PREFERENCES_INVALID', '插件偏好格式无效。');
  if (value.schemaVersion !== 1) fail('PREFERENCES_INVALID', '插件偏好版本不受支持。');
  if (typeof value.grokEnabled !== 'boolean') fail('PREFERENCES_INVALID', 'Grok 开关值无效。');
  if (value.githubEnabled !== undefined && typeof value.githubEnabled !== 'boolean') fail('PREFERENCES_INVALID', 'GitHub 开关值无效。');
  if (!Array.isArray(value.sourceOrder) || value.sourceOrder.length !== SOURCES.length
    || new Set(value.sourceOrder).size !== SOURCES.length
    || value.sourceOrder.some(source => !SOURCES.includes(source))) {
    fail('PREFERENCES_INVALID', '补充来源顺序无效。');
  }
  if (!value.sourceEnabled || typeof value.sourceEnabled !== 'object' || Array.isArray(value.sourceEnabled)
    || SOURCES.some(source => typeof value.sourceEnabled[source] !== 'boolean')) {
    fail('PREFERENCES_INVALID', '补充来源开关无效。');
  }
  return {
    schemaVersion: 1,
    grokEnabled: value.grokEnabled,
    githubEnabled: value.githubEnabled ?? true,
    sourceOrder: [...value.sourceOrder],
    sourceEnabled: Object.fromEntries(SOURCES.map(source => [source, value.sourceEnabled[source]])),
  };
}

export function createPrivatePreferences({ path, fault }) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('PREFERENCES_PATH_INVALID', '偏好文件必须使用绝对路径。');
  const read = () => {
    if (!existsSync(path)) return { value: structuredClone(DEFAULTS), revision: 'missing' };
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('PREFERENCES_PATH_UNSAFE', '偏好目标不是普通文件。');
      if (stat.size > 65536) fail('PREFERENCES_READ_FAILED', '插件偏好超过 64 KiB。');
      const bytes = readFileSync(path);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) fail('PREFERENCES_READ_FAILED', '插件偏好必须使用 UTF-8。');
      const value = validate(JSON.parse(text));
      return { value, revision: digest(text) };
    } catch (error) {
      if (error instanceof GrokSearchError) throw error;
      fail('PREFERENCES_READ_FAILED', '无法读取插件偏好。');
    }
  };
  return Object.freeze({
    snapshot() {
      const current = read();
      return { ...current, value: structuredClone(current.value) };
    },
    save(expectedRevision, value) {
      if (expectedRevision !== 'missing' && !/^[a-f0-9]{64}$/.test(expectedRevision ?? '')) {
        fail('PREFERENCES_REVISION_REQUIRED', '保存偏好前必须读取当前修订。');
      }
      const next = validate(value);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const lock = path + '.dsh-grok-search.lock';
      let lockFd, stage, published = false;
      try {
        try { lockFd = openSync(lock, 'wx', 0o600); }
        catch (error) {
          if (error.code === 'EEXIST') fail('PREFERENCES_BUSY', '插件偏好正在保存或上次保存被中断，请稍后检查。');
          throw error;
        }
        const before = read();
        if (before.revision !== expectedRevision) fail('PREFERENCES_CONFLICT', '插件偏好已被其他窗口修改，请重新读取。');
        const text = JSON.stringify(next, null, 2) + '\n';
        if (before.revision === digest(text)) return { value: structuredClone(next), revision: before.revision };
        stage = `${path}.${randomUUID()}.tmp`;
        const fd = openSync(stage, 'wx', 0o600);
        try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
        fault?.('before-publish');
        if (read().revision !== expectedRevision) fail('PREFERENCES_CONFLICT', '插件偏好已被其他窗口修改，请重新读取。');
        renameSync(stage, path);
        published = true;
        fault?.('after-publish');
        return read();
      } catch (error) {
        if (published) fail('PREFERENCES_COMMIT_UNCERTAIN', '插件偏好已写入，但回读未完成，请重新读取后确认。');
        if (error instanceof GrokSearchError) throw error;
        fail('PREFERENCES_WRITE_FAILED', '无法保存插件偏好；原文件未由本次操作替换。');
      } finally {
        if (stage && !published) { try { unlinkSync(stage); } catch {} }
        if (lockFd !== undefined) { closeSync(lockFd); unlinkSync(lock); }
      }
    },
  });
}
