import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function freshRun(prefix = 'internal-candidate') {
  const runId = new Date().toISOString().replaceAll(':', '-') + '-' + process.pid;
  const directory = join(project, 'artifacts', prefix, runId);
  if (existsSync(directory)) throw new Error('运行目录已存在，拒绝覆盖。');
  mkdirSync(directory, { recursive: true });
  return { runId, directory };
}
export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
// Synthetic one-character keys must not collide with numeric counts, timing or
// hashes. Long credentials remain substring-checked, including encoded forms;
// short credentials are rejected when present as a complete JSON string value.
export function assertSecretFreeEvidence(value, secrets = []) {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !secret) continue;
    const found = secret.length < 5 ? text.includes(JSON.stringify(secret))
      : [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]
        .some(encoded => text.includes(encoded) || text.includes(JSON.stringify(encoded).slice(1, -1)));
    if (found) {
      throw Object.assign(new Error('Evidence redaction guard'), { code: 'EVIDENCE_SECRET_REJECTED' });
    }
  }
  return value;
}
export function cleanEnvironment(root, extra = {}) {
  const env = {};
  const windows = process.platform === 'win32';
  const inherited = windows
    ? ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
    : ['LANG', 'LC_ALL', 'LC_CTYPE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  for (const key of inherited) if (process.env[key] !== undefined) env[key] = process.env[key];
  const pathValue = windows
    ? [dirname(process.execPath), join(process.env.SystemRoot ?? 'C:/Windows', 'System32')].join(';')
    : [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  Object.assign(env, { PATH: pathValue, HOME: join(root, 'user'), USERPROFILE: join(root, 'user'),
    ...(windows ? { APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), TEMP: root, TMP: root }
      : { TMPDIR: root }),
    NO_COLOR: '1', DSH_TELEMETRY_DISABLED: '1' }, extra);
  for (const path of [root, env.HOME, env.APPDATA, env.LOCALAPPDATA].filter(Boolean)) mkdirSync(path, { recursive: true });
  return env;
}
// Only read the explicitly authorized file. TOML parser errors can contain
// source lines, so none of those errors may escape into an evidence log.
export function configSecrets(path) {
  let document;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 1_048_576) throw new Error('Too large');
    document = parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Cannot safely parse the explicitly supplied acceptance configuration.');
  }
  const values = new Set();
  const visit = (value, sensitive = false) => {
    if (typeof value === 'string' && sensitive) {
      if (value.trim()) values.add(value);
      for (const part of value.split(',').map(item => item.trim()).filter(Boolean)) values.add(part);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, sensitive);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        visit(item, sensitive || /(?:^|_)(?:api_?keys?|keys?|tokens?|secrets?|passwords?)(?:$|_)/i.test(key));
      }
    }
  };
  visit(document);
  return [...values].sort((a, b) => b.length - a.length);
}
export function redact(value, replacements = [], secrets = []) {
  let text = String(value);
  const spellings = new Set();
  for (const secret of secrets) if (secret) {
    spellings.add(secret);
    spellings.add(encodeURIComponent(secret));
    spellings.add(JSON.stringify(secret).slice(1, -1));
  }
  for (const secret of [...spellings].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('<AUTH_REDACTED>');
  }
  for (const [path, label] of [...replacements, [project, '<PROJECT>'], [dirname(process.execPath), '<NODE_INSTALL>'], [homedir(), '<USER_HOME>'], [tmpdir(), '<TEMP>']]) {
    for (const spelling of [path, path.replaceAll('\\', '/'), path.replaceAll('\\', '\\\\'), new URL('file:///' + path.replaceAll('\\', '/')).href]) {
      text = text.split(spelling).join(label);
    }
  }
  return text.replace(/([?&]token=)[^\s"'&\\]+/gi, '$1<AUTH_REDACTED>');
}
export async function commandResult(command, args, { cwd, env, timeoutMs = 120_000, sanitize = value => String(value) } = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, spawnError;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { spawnError = error.message; });
  const exit = await new Promise(done => child.once('close', (code, signal) => done({ code, signal })));
  clearTimeout(timer);
  const result = { command: sanitize(command), args: args.map(argument => sanitize(argument)), cwd: sanitize(cwd ?? process.cwd()), startedAt,
    elapsedMs: Math.round(performance.now() - started), exitCode: exit.code, signal: exit.signal, timedOut,
    ...(spawnError ? { spawnError: sanitize(spawnError) } : {}), stdout: sanitize(stdout), stderr: sanitize(stderr) };
  return { ...result, rawStdout: stdout };
}
export function receipt(result) { const { rawStdout, ...record } = result; return record; }
export const npmCli = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(path => existsSync(path));
if (!npmCli) throw new Error('The Node installation does not contain a supported npm CLI layout.');
