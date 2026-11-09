// Real platform smoke gate; only newly created, credential-free configuration.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { platform, release } from 'node:os';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tarball = resolve(process.argv[2] || '');
assert.ok(process.argv[2]?.endsWith('.tgz'), 'Pass the frozen .tgz');
const receipt = JSON.parse(readFileSync(join(dirname(tarball), 'package-receipt.json'), 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
assert.equal(hash(tarball), receipt.sha256);
const directory = join(project, 'artifacts/config-opener-platform', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid);
mkdirSync(directory, { recursive: true });
const result = { platform: platform(), osRelease: release(), packageSha256: receipt.sha256, passed: false,
  syntheticConfigOnly: true, published: false };
const run = (command, args, env = process.env) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { child.kill(); reject(new Error('Platform observation timed out: ' + command)); }, 30_000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }); });
});
let opener;
try {
  const unpack = await run(process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar', ['-xf', tarball, '-C', directory]);
  assert.equal(unpack.code, 0, unpack.stderr);
  for (const item of receipt.sourceHashes) assert.equal(hash(join(directory, 'package', item.file)), item.sha256, item.file);
  const { createConfigLocationOpener } = await import(pathToFileURL(join(directory, 'package/src/core/config-opener.mjs')).href);
  const folder = join(directory, "中文 空格 ' & $literal");
  mkdirSync(folder);
  const path = join(folder, `config-open-${randomUUID()}.toml`);
  const content = '# Synthetic editor roundtrip.\ntimeout_seconds = 73\n';
  writeFileSync(path, content, { flag: 'wx' });
  const before = hash(path);
  if (process.platform === 'linux') {
    opener = createConfigLocationOpener({ env: { PATH: '/usr/bin:/bin', HOME: directory } });
    for (const kind of ['file', 'folder']) {
      await assert.rejects(opener.open({ path, kind }), { code: 'CONFIG_OPEN_NO_DESKTOP' });
    }
    result.scope = 'real-Linux-headless-CLI-host';
    result.noDesktopErrorVerified = true;
  } else if (process.platform === 'darwin') {
    opener = createConfigLocationOpener();
    result.openFile = await opener.open({ path, kind: 'file' });
    assert.equal(result.openFile.opened, true);
    const processes = await run('/usr/bin/pgrep', ['-fl', 'TextEdit']);
    result.editorProcesses = processes.stdout.trim();
    const screen = await run('/usr/sbin/screencapture', ['-x', join(directory, 'synthetic-editor.png')]);
    result.screenCaptureCode = screen.code;
    // The clean macOS runner's default text editor is TextEdit. Observe only the
    // unique synthetic document, then save it to prove it is the original file.
    result.editorAutomation = [];
    const editorStep = async (step, source) => {
      const appleScript = `
on run argv
  set expectedName to item 1 of argv
  with timeout of 8 seconds
  tell application "TextEdit"
    ${source}
  end tell
  end timeout
end run`;
      const response = await run('/usr/bin/osascript', ['-e', appleScript, path.split('/').at(-1)]);
      result.editorAutomation.push({ step, code: response.code,
        stdout: response.stdout.trim(), stderr: response.stderr.trim() });
      if (response.code !== 0) {
        const capture = await run('/usr/sbin/screencapture', ['-x', join(directory, 'synthetic-editor-failure.png')]);
        result.failureScreenCaptureCode = capture.code;
      }
      assert.equal(response.code, 0, `${step}: ${response.stderr}`);
      return response.stdout.trim();
    };
    const names = await editorStep('locate', 'return name of every document');
    assert.ok(names.includes(path.split('/').at(-1)), 'The default editor must contain the opened document');
    const original = await editorStep('read', 'return text of document expectedName');
    assert.equal(original, content.trim(), 'TextEdit must expose the original synthetic content');
    await editorStep('edit', `set text of document expectedName to "# Synthetic editor roundtrip." & linefeed & "timeout_seconds = 74" & linefeed
    return "EDIT_OK"`);
    await editorStep('save', `save document expectedName
    return "SAVE_OK"`);
    assert.equal(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), content.replace('73', '74'));
    result.originalFileRoundtripVerified = true;
    await editorStep('close', `close document expectedName saving no
    return "CLOSE_OK"`);
    result.openFolder = await opener.open({ path, kind: 'folder' });
    assert.equal(result.openFolder.opened, true);
    result.scope = 'real-macOS-default-TextEdit-and-Finder';
  } else {
    throw new Error('Use the Windows Desktop --open-config gate for actual editor selection.');
  }
  if (process.platform !== 'darwin') assert.equal(hash(path), before);
  result.passed = true;
} catch (error) {
  result.error = String(error.message).slice(0, 800);
  process.exitCode = 1;
} finally {
  opener?.dispose();
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...result, evidence: directory }));
}
