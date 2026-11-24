import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { mkdtempTracked } from './helpers/temp-fixture.mjs';
import { runBoundedCommand } from '../scripts/lib/compatibility-process.mjs';
import { validateInstallManifest } from '../scripts/lib/compatibility-smoke.mjs';
import { tarGzip } from '../scripts/lib/compatibility-program-checks.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function lifecycleGuards() {
  const source = readFileSync(new URL('../scripts/ux-lifecycle-host.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function pendingReleaseSummary(');
  const end = source.indexOf('\nconst { args, runtimeOptions }', start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(source.slice(start, end).replaceAll('export function ', 'function ')
    + '\n({ pendingReleaseSummary, readLifecycleStage });', { assert, isAbsolute });
}

test('cold lifecycle admission refuses healthy or completed ledgers before mounting', () => {
  const { pendingReleaseSummary } = lifecycleGuards();
  const pending = { revision: 12, intent: { policy: 'released', reason: 'native-bundle-disable',
    release: { operationId: 'synthetic-release' }, acquisition: {
      authorSearchProvider: 'original', authorFetchProvider: 'preserved' } } };
  assert.equal(pendingReleaseSummary(pending).operationId, 'synthetic-release');
  for (const invalid of [null, { ...pending, revision: 0 },
    { ...pending, intent: { ...pending.intent, policy: 'required' } },
    { ...pending, intent: { ...pending.intent, release: null } },
    { ...pending, intent: { ...pending.intent, releaseCompletion: { routeVerified: true } } }]) {
    assert.throws(() => pendingReleaseSummary(invalid));
  }
});

test('lifecycle runner requires both stage identities and refuses zero-exit cleanup failures', () => {
  const { readLifecycleStage } = lifecycleGuards(), sourceGraphSha256 = 'a'.repeat(64);
  const isolated = resolve(tmpdir(), 'dsh-ux-lifecycle-synthetic');
  const stage = { stage: 'warm', authorCase: 'same-author', isolated, sourceGraphSha256, passed: true };
  const resume = { isolated, authorCase: 'same-author', pending: { revision: 12, operationId: 'synthetic-release' },
    ledgerSha256: 'b'.repeat(64) };
  const warm = { code: 0, signal: null, failure: null,
    stdout: 'DSH_UX_STAGE ' + JSON.stringify(stage) + '\nDSH_UX_COLD_RESUME ' + JSON.stringify(resume) + '\n' };
  assert.equal(readLifecycleStage(warm, 'warm', 'same-author', sourceGraphSha256).resume.isolated, isolated);
  for (const invalid of [
    { ...warm, failure: 'COMPATIBILITY_SMOKE_PIPE_TIMEOUT' },
    { ...warm, signal: 'SIGTERM' }, { ...warm, code: 1 },
    { ...warm, stdout: warm.stdout.split('\n')[0] },
    { ...warm, stdout: warm.stdout + warm.stdout },
    { ...warm, stdout: warm.stdout.replaceAll('same-author', 'changed-author') },
    { ...warm, stdout: warm.stdout.replace(sourceGraphSha256, 'c'.repeat(64)) },
    { ...warm, stdout: warm.stdout.replace('"passed":true', '"passed":false') },
  ]) assert.throws(() => readLifecycleStage(invalid, 'warm', 'same-author', sourceGraphSha256));
  const cold = { ...warm, stdout: 'DSH_UX_STAGE ' + JSON.stringify({ ...stage, stage: 'cold', pendingVerifiedBeforeMount: true }) };
  assert.equal(readLifecycleStage(cold, 'cold', 'same-author', sourceGraphSha256).passed, true);
  assert.throws(() => readLifecycleStage(warm, 'cold', 'same-author', sourceGraphSha256));
  assert.throws(() => readLifecycleStage({ ...cold, stdout: cold.stdout.replace('"pendingVerifiedBeforeMount":true',
    '"pendingVerifiedBeforeMount":false') }, 'cold', 'same-author', sourceGraphSha256));
});

test('evidence checker consumes wrapper-owned receipts and rejects a missing run or relative root', () => {
  const artifactRoot = mkdtempTracked(join(tmpdir(), 'dsh-evidence-root-'));
  const runId = 'synthetic-owned-run', directory = join(artifactRoot, 'ui-gates', runId);
  mkdirSync(directory, { recursive: true });
  const summary = { runId, scope: 'generated-client-offline-browser-fixtures', passed: true, smoke: true,
    clientSha256: hash(readFileSync(new URL('../src/client.js', import.meta.url))),
    suites: [{ passed: 2, failed: 0 }, { passed: 3, failed: 0 }], assertionsPassed: 5 };
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary));
  const check = (root, id = runId) => spawnSync(process.execPath, [join(project, 'scripts/check-evidence.mjs'), 'ui', id], {
    cwd: project, env: { ...process.env, DSH_VALIDATION_ARTIFACT_ROOT: root },
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  const accepted = check(artifactRoot);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).requiredEvidence[0].receipts, 1);
  assert.notEqual(check(artifactRoot, 'missing-run').status, 0);
  assert.notEqual(check('relative-artifacts').status, 0);
});

test('platform opener failure keeps extraction and evidence inside the wrapper artifact root', () => {
  const root = mkdtempTracked(join(tmpdir(), 'dsh-opener-artifacts-'));
  const artifactRoot = join(root, 'artifacts'), tarball = join(root, 'synthetic.tgz');
  const files = [['package.json', Buffer.from('{}')],
    ['src/core/config-opener.mjs', Buffer.from('throw new Error("SYNTHETIC_OPENER_IMPORT_FAILURE");\n')]];
  const bytes = tarGzip(files.map(([file, body]) => ['package/' + file, body]));
  writeFileSync(tarball, bytes);
  writeFileSync(join(root, 'package-receipt.json'), JSON.stringify({ sha256: hash(bytes),
    sourceHashes: files.map(([file, body]) => ({ file, sha256: hash(body) })) }));
  const result = spawnSync(process.execPath, [join(project, 'scripts/verify-config-opener-platform.mjs'), tarball], {
    cwd: project, env: { ...process.env, DSH_VALIDATION_ARTIFACT_ROOT: artifactRoot },
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.equal(result.status, 1, result.stderr);
  const output = join(artifactRoot, 'config-opener-platform');
  const runs = readdirSync(output);
  assert.equal(runs.length, 1);
  const summary = JSON.parse(readFileSync(join(output, runs[0], 'summary.json'), 'utf8'));
  assert.equal(summary.passed, false);
  assert.equal(summary.error, 'SYNTHETIC_OPENER_IMPORT_FAILURE');
  assert.equal(hash(readFileSync(join(output, runs[0], 'package/src/core/config-opener.mjs'))), hash(files[1][1]));
});

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

test('bounded command diagnostics preserve split UTF-8 while counting raw output bytes', async () => {
  const expected = '\u6821\u9a8c\u20ac\ud83d\ude00\n';
  const bytes = [...Buffer.from(expected)];
  const source = `const bytes=${JSON.stringify(bytes)};
    (async()=>{for(const byte of bytes){
      process.stdout.write(Buffer.from([byte]));process.stderr.write(Buffer.from([byte]));
      await new Promise(done=>setTimeout(done,20));
    }})();`;
  const result = await runBoundedCommand(process.execPath, ['-e', source], {
    timeout: 10_000, limit: bytes.length * 2,
  });
  assert.equal(result.code, 0);
  assert.equal(result.failure, null);
  assert.equal(result.stdout, expected);
  assert.equal(result.stderr, expected);
  const limited = await runBoundedCommand(process.execPath, ['-e', source], {
    timeout: 10_000, limit: bytes.length * 2 - 1,
  });
  assert.equal(limited.failure, 'COMPATIBILITY_SMOKE_OUTPUT_LIMIT');
});

test('Windows cancellation lets tree termination reap a live parent and its owned descendant', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = mkdtempTracked(join(tmpdir(), 'dsh-process-cancel-tree-'));
  const ready = join(root, 'ready.json');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)},
    JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(0),4000);`;
  const source = `const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{windowsHide:true,stdio:'ignore'});
    setTimeout(()=>process.exit(0),5000);`;
  const controller = new AbortController();
  const task = runBoundedCommand(process.execPath, ['-e', source], {
    signal: controller.signal, timeout: 10_000, killGraceMs: 1500,
  });
  let pid, alive = false;
  try {
    const deadline = performance.now() + 3000;
    while (!existsSync(ready) && performance.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(existsSync(ready), 'The owned descendant must start before cancellation.');
    ({ pid } = JSON.parse(readFileSync(ready)));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    controller.abort();
    const result = await task;
    assert.equal(result.failure, 'COMPATIBILITY_SMOKE_CANCELLED');
    try { process.kill(pid, 0); alive = true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    assert.equal(alive, false, 'Cancellation must not return with its known descendant still alive.');
  } finally {
    controller.abort();
    await task;
    // A failing old implementation still leaves only a short-lived synthetic process.
    if (alive || !pid) await new Promise(done => setTimeout(done, 4500));
  }
});
