import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedCommand } from '../scripts/lib/compatibility-process.mjs';
import { validateInstallManifest } from '../scripts/lib/compatibility-smoke.mjs';

test('bounded commands preserve success and spawn failures without a shell', async () => {
  const result = await runBoundedCommand(process.execPath, ['-e', 'console.log("bounded")'], { timeout: 2000 });
  assert.equal(result.code, 0); assert.equal(result.stdout.trim(), 'bounded'); assert.equal(result.failure, null);
  const missing = await runBoundedCommand('compatibility-command-does-not-exist', [], { timeout: 2000 });
  assert.equal(missing.failure, 'COMPATIBILITY_SMOKE_SPAWN_FAILED');
});

test('aborted callers cannot start a command, and running cancellation has a finite boundary', async () => {
  const cancelled = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(runBoundedCommand(process.execPath, ['-e', 'process.exit(0)'], { signal: cancelled }), /cancelled/);
  const controller = new AbortController();
  const task = runBoundedCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { signal: controller.signal, timeout: 5000, killGraceMs: 1000 });
  setTimeout(() => controller.abort(), 100);
  const result = await task;
  assert.equal(result.failure, 'COMPATIBILITY_SMOKE_CANCELLED');
});

test('a descendant holding inherited output cannot keep a finished parent command open', async () => {
  const start = performance.now();
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},2500)'],{stdio:['ignore',1,2],windowsHide:true});
    child.unref();`;
  const result = await runBoundedCommand(process.execPath, ['-e', source], {
    timeout: 6000, drainMs: 50, killGraceMs: 250,
  });
  // Windows libuv may close its pipe as soon as the direct parent exits;
  // POSIX keeps the inherited descriptor open and exercises the drain timer.
  assert.equal(result.failure, process.platform === 'win32' ? null : 'COMPATIBILITY_SMOKE_PIPE_TIMEOUT');
  assert.ok(performance.now() - start < 1800, 'pipe drain is bounded even if descendant cleanup cannot be verified');
});

test('manifest preflight rejects local, git, URL, alias and lockfile-controlled installation sources', () => {
  const files = new Map([['package.json', Buffer.from('{}')]]);
  assert.equal(validateInstallManifest({ manifest: { dependencies: { semver: '7.8.5' },
    peerDependencies: { '@deepseek-ai/dsh': '*' } }, files }), true);
  for (const range of ['file:/outside', 'link:../outside', 'https://other.invalid/pkg.tgz',
    'github:someone/repo', 'git+ssh://example/repo', 'npm:other-package@1.0.0', 'latest', 'workspace:*']) {
    assert.throws(() => validateInstallManifest({ manifest: { dependencies: { dependency: range } }, files }),
      { code: 'COMPATIBILITY_PACKAGE_DEPENDENCY_UNTRUSTED' });
  }
  for (const name of ['npm-shrinkwrap.json', 'package-lock.json', '.npmrc',
    'NPM-SHRINKWRAP.JSON', 'Package-Lock.Json', '.NPMRC']) {
    assert.throws(() => validateInstallManifest({ manifest: {}, files: new Map([...files, [name, Buffer.from('{}')]]) }),
      { code: 'COMPATIBILITY_PACKAGE_INSTALL_POLICY' });
  }
  for (const key of ['bundleDependencies', 'bundledDependencies', 'overrides']) {
    assert.throws(() => validateInstallManifest({ manifest: { [key]: {} }, files }),
      { code: 'COMPATIBILITY_PACKAGE_INSTALL_POLICY' });
  }
});
