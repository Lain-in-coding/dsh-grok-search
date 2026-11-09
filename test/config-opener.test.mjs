import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { win32 } from 'node:path';
import { createConfigLocationOpener } from '../src/core/config-opener.mjs';

const ROOT = 'C:\\Windows';
const COMMAND = ROOT + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const FILE = "C:\\隔离 目录\\引号' & $数据\\config.toml";
const DIRECTORY = win32.dirname(FILE);
const info = directory => ({ isFile: () => !directory, isDirectory: () => directory });
const baseEnv = { SystemRoot: ROOT, PATH: 'C:\\minimal-node', HOME: 'C:\\isolated-home',
  GROK_SEARCH_API_KEY: 'must-not-leak', GITHUB_TOKEN: 'must-not-leak', DSH_GROK_OPEN_TARGET: 'must-not-inherit' };
function harness({ env = baseEnv, platform = 'win32', entries, behavior, timeoutMs = 200 } = {}) {
  const files = entries ?? new Map([[FILE, info(false)], [DIRECTORY, info(true)], [COMMAND, info(false)]]);
  const calls = [], children = [];
  const opener = createConfigLocationOpener({
    platform, env, timeoutMs,
    stat(path) {
      const entry = files.get(path);
      if (entry instanceof Error) throw entry;
      if (!entry) throw Object.assign(new Error('missing private-path'), { code: 'ENOENT' });
      return entry;
    },
    spawnImpl(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.killCalls = 0; child.unref = () => {};
      child.kill = () => { child.killCalls++; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
      calls.push({ command, args, options }); children.push(child);
      queueMicrotask(() => {
        child.emit('spawn');
        if (behavior) return behavior(child);
        child.stdout.write(options.env.DSH_GROK_OPEN_KIND === 'folder' ? 'DSH_GROK_OPEN_FOLDER_VISIBLE' : 'DSH_GROK_OPEN_OK');
        child.stdout.end();
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  return { opener, calls, children };
}

test('Windows opens with an absolute system helper even when PATH omits Windows', async () => {
  const { opener, calls } = harness();
  assert.deepEqual(await opener.open({ path: FILE, kind: 'file' }), { exists: true, opened: true });
  const call = calls[0];
  assert.equal(call.command, COMMAND);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.DSH_GROK_OPEN_TARGET, FILE);
  assert.equal(call.options.env.DSH_GROK_OPEN_KIND, 'file');
  assert.ok(!call.args.some(argument => argument.includes(FILE)));
  assert.ok(!call.args.includes('-ExecutionPolicy'));
  assert.match(call.args.at(-1), /UseShellExecute = \$true/);
  assert.match(call.args.at(-1), /if \(\$kind -eq 'file'\)\s*\{\s*Start-TextEditor/);
  assert.match(call.args.at(-1), /notepad\.exe/);
  assert.equal(call.options.env.GROK_SEARCH_API_KEY, undefined);
  assert.equal(call.options.env.GITHUB_TOKEN, undefined);
});

test('Windows environment lookup is case-insensitive and does not hardcode the system drive', async () => {
  const system = 'D:\\System Folder', command = system + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const { opener, calls } = harness({ env: { windir: system, Path: '' },
    entries: new Map([[FILE, info(false)], [command, info(false)]]) });
  await opener.open({ path: FILE, kind: 'file' });
  assert.equal(calls[0].command, command);
  assert.equal(calls[0].options.env.SystemRoot, system);
});

test('folder opening targets the actual parent, including before the first config save', async () => {
  const { opener, calls } = harness({ entries: new Map([[DIRECTORY, info(true)], [COMMAND, info(false)]]) });
  assert.deepEqual(await opener.open({ path: FILE, kind: 'file' }), { exists: false, opened: false });
  assert.equal(calls.length, 0);
  assert.deepEqual(await opener.open({ path: FILE, kind: 'folder' }), { exists: false, opened: true });
  assert.equal(calls[0].options.env.DSH_GROK_OPEN_TARGET, DIRECTORY);
});

test('folder opening requires a visibility receipt, never an editor or launch-only acknowledgement', async () => {
  for (const receipt of ['DSH_GROK_OPEN_OK', 'DSH_GROK_OPEN_OK:modern:none', 'DSH_GROK_OPEN_FOLDER_VISIBLE\nextra']) {
    const h = harness({ behavior(child) { child.stdout.write(receipt); child.emit('close', 0, null); } });
    await assert.rejects(h.opener.open({ path: FILE, kind: 'folder' }), { code: 'CONFIG_OPEN_FAILED' });
  }
  const h = harness({ behavior(child) { child.stdout.write('DSH_GROK_OPEN_FOLDER_UNCONFIRMED'); child.emit('close', 1, null); } });
  await assert.rejects(h.opener.open({ path: FILE, kind: 'folder' }), { code: 'CONFIG_OPEN_FOLDER_UNCONFIRMED' });
});

test('an unusual config extension is opened as text, never executed through its association', async () => {
  const path = 'C:\\safe\\config.ps1';
  const { opener, calls } = harness({ entries: new Map([[path, info(false)], [COMMAND, info(false)]]) });
  await opener.open({ path, kind: 'file' });
  assert.equal(calls[0].options.env.DSH_GROK_OPEN_KIND, 'file');
  assert.match(calls[0].args.at(-1), /if \(\$kind -eq 'file'\)\s*\{\s*Start-TextEditor/);
});

test('invalid or inaccessible locations never launch a helper', async () => {
  const h = harness();
  for (const path of ['relative.toml', 'C:\\bad\0config.toml', 'C:\\bad\nconfig.toml', 'C:\\bad"config.toml']) {
    await assert.rejects(h.opener.open({ path, kind: 'file' }), { code: 'CONFIG_OPEN_INVALID' });
  }
  await assert.rejects(h.opener.open({ path: FILE, kind: 'unknown' }), { code: 'CONFIG_OPEN_INVALID' });
  assert.equal(h.calls.length, 0);
  const bad = harness({ entries: new Map([[FILE, Object.assign(new Error('private-path'), { code: 'EACCES' })]]) });
  await assert.rejects(bad.opener.open({ path: FILE, kind: 'file' }), error =>
    error.code === 'CONFIG_OPEN_ACCESS_FAILED' && !error.message.includes('private-path'));
  assert.equal(bad.calls.length, 0);
});

test('spawn alone cannot acknowledge that the system accepted the open request', async () => {
  let process;
  const { opener } = harness({ behavior: child => { process = child; } });
  let settled = false;
  const pending = opener.open({ path: FILE, kind: 'file' }).then(value => { settled = true; return value; });
  await new Promise(done => setImmediate(done));
  assert.equal(settled, false);
  process.stdout.write('DSH_GROK_OPEN_ERROR:5');
  process.emit('close', 1, null);
  await assert.rejects(pending, error => error.code === 'CONFIG_OPEN_FAILED' && error.details.osCode === 5);
});

test('Windows requires the bounded helper receipt, not only an exit code', async () => {
  for (const output of ['', 'arbitrary editor output', 'DSH_GROK_OPEN_OK\nprivate-path']) {
    const { opener } = harness({ behavior(child) { child.stdout.write(output); child.emit('close', 0, null); } });
    await assert.rejects(opener.open({ path: FILE, kind: 'file' }), error =>
      error.code === 'CONFIG_OPEN_FAILED' && !error.message.includes('private-path'));
  }
});

test('modern and fallback receipts carry only fixed editor status', async () => {
  for (const [receipt, expected] of [
    ['modern:none', { editor: 'modern', fallbackReason: null }],
    ['classic:none', { editor: 'classic', fallbackReason: null }],
    ...['unavailable', 'discovery-failed', 'launch-failed', 'early-exit'].map(reason =>
      [`classic:${reason}`, { editor: 'classic', fallbackReason: reason }]),
  ]) {
    const h = harness({ behavior(child) { child.stdout.write('DSH_GROK_OPEN_OK:' + receipt); child.emit('close', 0, null); } });
    assert.deepEqual(await h.opener.open({ path: FILE, kind: 'file' }), { opened: true, exists: true, ...expected });
  }
  for (const receipt of ['modern:early-exit', 'classic:private-output', 'classic:early-exit\nDSH_GROK_OPEN_OK']) {
    const h = harness({ behavior(child) { child.stdout.write('DSH_GROK_OPEN_OK:' + receipt); child.emit('close', 0, null); } });
    await assert.rejects(h.opener.open({ path: FILE, kind: 'file' }), { code: 'CONFIG_OPEN_FAILED' });
  }
});

test('early editor crash and missing desktop profile cannot be reported as opened', async () => {
  const crashed = harness({ behavior(child) {
    child.stdout.write('DSH_GROK_OPEN_EDITOR_ERROR:-1073741819');
    child.emit('close', 1, null);
  } });
  await assert.rejects(crashed.opener.open({ path: FILE, kind: 'file' }), error =>
    error.code === 'CONFIG_OPEN_EDITOR_FAILED' && error.details.editorExitCode === -1073741819
    && error.message.includes('0xC0000005'));
  const noProfile = harness({ behavior(child) {
    child.stdout.write('DSH_GROK_OPEN_PROFILE_ERROR'); child.emit('close', 1, null);
  } });
  await assert.rejects(noProfile.opener.open({ path: FILE, kind: 'file' }), { code: 'CONFIG_OPEN_PROFILE_FAILED' });
  assert.equal(crashed.children[0].killCalls, 0);
});

test('missing helper and spawn failures are explicit, sanitized and retryable', async () => {
  const missing = harness({ entries: new Map([[FILE, info(false)]]) });
  await assert.rejects(missing.opener.open({ path: FILE, kind: 'file' }), { code: 'CONFIG_OPEN_UNAVAILABLE' });
  assert.equal(missing.calls.length, 0);
  let count = 0;
  const { opener } = harness({ behavior(child) {
    if (count++ === 0) child.emit('error', Object.assign(new Error('private-path'), { code: 'EACCES' }));
    else { child.stdout.write('DSH_GROK_OPEN_OK'); child.emit('close', 0, null); }
  } });
  await assert.rejects(opener.open({ path: FILE, kind: 'file' }), error =>
    error.code === 'CONFIG_OPEN_START_FAILED' && !error.message.includes('private-path'));
  assert.equal((await opener.open({ path: FILE, kind: 'file' })).opened, true);
});

test('concurrent clicks reuse one request and a different action reports busy', async () => {
  let child;
  const h = harness({ behavior(value) { child = value; } });
  const first = h.opener.open({ path: FILE, kind: 'file' });
  const second = h.opener.open({ path: FILE, kind: 'file' });
  assert.equal(first, second);
  await assert.rejects(h.opener.open({ path: FILE, kind: 'folder' }), { code: 'CONFIG_OPEN_BUSY' });
  await new Promise(done => setImmediate(done));
  child.stdout.write('DSH_GROK_OPEN_OK'); child.emit('close', 0, null);
  await first;
  assert.equal(h.calls.length, 1);
});

test('timeout reaps only the helper and leaves the operation retryable', async () => {
  const h = harness({ timeoutMs: 20, behavior() {} });
  await assert.rejects(h.opener.open({ path: FILE, kind: 'file' }), { code: 'CONFIG_OPEN_TIMEOUT' });
  assert.equal(h.children[0].killCalls, 1);
});

test('cancellation and disposal stop helper work without starting later requests', async () => {
  const controller = new AbortController();
  const h = harness({ behavior() {} });
  const pending = h.opener.open({ path: FILE, kind: 'file', signal: controller.signal });
  const reason = new Error('caller cancelled');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(h.children[0].killCalls, 1);
  h.opener.dispose();
  await assert.rejects(h.opener.open({ path: FILE, kind: 'file' }), { code: 'CONFIG_OPEN_CANCELLED' });
  assert.equal(h.calls.length, 1);
});

test('oversized helper output is rejected without forwarding it', async () => {
  const h = harness({ behavior(child) { child.stdout.write('private-output'.repeat(200)); } });
  await assert.rejects(h.opener.open({ path: FILE, kind: 'file' }), error =>
    error.code === 'CONFIG_OPEN_UNCONFIRMED' && !error.message.includes('private-output'));
  assert.equal(h.children[0].killCalls, 1);
});

test('macOS uses system open, text mode and file reveal without shell parsing', async () => {
  const path = "/tmp/中文 ';$(value)/config.toml";
  for (const kind of ['file', 'folder']) {
    const h = harness({ platform: 'darwin', env: { PATH: '', HOME: '/tmp/home' },
      entries: new Map([[path, info(false)], [path.slice(0, path.lastIndexOf('/')), info(true)], ['/usr/bin/open', info(false)]]) });
    assert.equal((await h.opener.open({ path, kind })).opened, true);
    assert.equal(h.calls[0].command, '/usr/bin/open');
    assert.deepEqual(h.calls[0].args, [kind === 'file' ? '-t' : '-R', path]);
  }
});

test('Linux opens only with a desktop session and checks xdg-open exit status', async () => {
  const path = '/tmp/space & 中文/config.toml', folder = '/tmp/space & 中文';
  const entries = new Map([[path, info(false)], [folder, info(true)], ['/usr/bin/xdg-open', info(false)]]);
  const headless = harness({ platform: 'linux', env: {}, entries });
  await assert.rejects(headless.opener.open({ path, kind: 'folder' }), { code: 'CONFIG_OPEN_NO_DESKTOP' });
  assert.equal(headless.calls.length, 0);
  const linux = harness({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, entries,
    behavior(child) { child.emit('close', 4, null); } });
  await assert.rejects(linux.opener.open({ path, kind: 'folder' }), error =>
    error.code === 'CONFIG_OPEN_FAILED' && error.details.exitCode === 4);
  assert.deepEqual(linux.calls[0].args, [folder]);
});

test('a long-running Linux opener is not killed because it may have become the editor', async () => {
  const path = '/tmp/config.toml';
  const linux = harness({ platform: 'linux', env: { DISPLAY: ':0' }, timeoutMs: 20,
    entries: new Map([[path, info(false)], ['/usr/bin/xdg-open', info(false)]]), behavior() {} });
  await assert.rejects(linux.opener.open({ path, kind: 'file' }), { code: 'CONFIG_OPEN_TIMEOUT' });
  assert.equal(linux.children[0].killCalls, 0);
  assert.equal(linux.calls[0].options.stdio, 'ignore');
});
