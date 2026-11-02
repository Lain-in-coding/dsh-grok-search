import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverGrokCandidates, findExistingGrok, grokPlatformPackage, inspectGrokProgram } from '../src/core/program-discovery.mjs';
const setup = () => mkdtempSync(join(tmpdir(), 'dsh-discovery-test-'));
const makeFile = path => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'offline-fixture'); return path; };
const nativeBinary = process.platform === 'win32' ? 'grok-search-rs.exe' : 'grok-search-rs';
const nativePackage = grokPlatformPackage(process.platform, process.arch);

test('three declared platform package mappings are explicit', () => {
  assert.match(grokPlatformPackage('win32', 'x64'), /win32-x64$/);
  assert.match(grokPlatformPackage('darwin', 'arm64'), /darwin-universal$/);
  assert.match(grokPlatformPackage('linux', 'x64'), /linux-x64$/);
  assert.throws(() => grokPlatformPackage('darwin', 'x64'), error => error.code === 'GROK_PLATFORM_UNSUPPORTED');
});
test('manual and Loader selections take precedence without fallback', async () => {
  const root = setup();
  assert.deepEqual(discoverGrokCandidates({ override: join(root, 'manual.exe'), configured: join(root, 'loader.exe') }), [
    { path: join(root, 'manual.exe'), source: 'manual', explicit: true },
  ]);
  let calls = 0;
  await assert.rejects(findExistingGrok({ configured: join(root, 'missing.exe'), inspect: async () => { calls++; throw new Error('missing'); } }));
  assert.equal(calls, 1);
});
test('npm global layout is resolved to the native binary, never to its launcher', () => {
  const root = setup();
  makeFile(join(root, 'grok-search-rs.cmd'));
  const binary = makeFile(join(root, 'node_modules/grok-search-rs/node_modules/@epsiekygrr_zedxx/grok-search-rs-win32-x64/bin/grok-search-rs.exe'));
  const rows = discoverGrokCandidates({ env: { PATH: root, USERPROFILE: root }, platform: 'win32', arch: 'x64' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, binary);
  assert.equal(rows[0].source, 'npm');
});
test('PATH and cargo discovery de-duplicate the same native program', () => {
  const root = setup();
  const binary = makeFile(join(root, '.cargo/bin/grok-search-rs'));
  const rows = discoverGrokCandidates({ env: { PATH: dirname(binary), HOME: root }, platform: 'linux', arch: 'x64' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, binary);
});
test('npm prefix/lib/node_modules layout resolves the host-native platform package', () => {
  const root = setup(), bin = join(root, 'bin');
  mkdirSync(bin);
  const binary = makeFile(join(root, 'lib/node_modules/grok-search-rs/node_modules', nativePackage, 'bin', nativeBinary));
  // The filesystem belongs to the current OS. A POSIX ':' PATH fabricated on
  // Windows would split the drive letter and accidentally depend on cwd's disk.
  const rows = discoverGrokCandidates({ env: { PATH: bin, HOME: root } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, binary);
  assert.equal(rows[0].source, 'npm');
});
test('launch scripts are rejected before spawn even with an executable filename', async () => {
  const root = setup();
  const wrapper = makeFile(join(root, 'grok-search-rs.exe'));
  writeFileSync(wrapper, '#!/usr/bin/env node\nthrow new Error(\"must not run\");');
  await assert.rejects(inspectGrokProgram(wrapper), error =>
    ['GROK_PROGRAM_NOT_NATIVE', 'GROK_PROGRAM_MISSING'].includes(error.code));
});
test('no installed candidate reports missing without downloading', async () => {
  const root = setup();
  const result = await findExistingGrok({ env: { PATH: '', HOME: root }, platform: 'linux', arch: 'x64' });
  assert.deepEqual(result, { found: false, candidates: 0 });
});
test('an invalid discovered program is an explicit error, not permission to download', async () => {
  const root = setup();
  makeFile(join(root, nativeBinary));
  await assert.rejects(findExistingGrok({ env: { PATH: root, HOME: root },
    inspect: async () => { throw Object.assign(new Error('unsupported'), { code: 'GROK_VERSION_UNVERIFIED' }); } }),
  error => error.code === 'GROK_VERSION_UNVERIFIED');
});
test('validated existing program returns its source and identity', async () => {
  const root = setup();
  const binary = makeFile(join(root, nativeBinary));
  const value = await findExistingGrok({ env: { PATH: root, HOME: root },
    inspect: async path => ({ path, version: '0.1.26', sha256: 'a'.repeat(64) }) });
  assert.equal(value.found, true);
  assert.equal(value.source, 'path');
  assert.equal(value.path, binary);
});
test('pre-cancelled inspection never starts a process', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(inspectGrokProgram(process.execPath, { signal: controller.signal }), error => error === reason);
});
test('other executables cannot masquerade as Grok', async () => {
  // Recent Linux Node binaries exceed the Grok-specific size bound and would
  // be rejected before their identity check. A small native system executable
  // reaches --version on each OS and proves that its output is not Grok.
  const other = process.platform === 'win32' ? process.execPath : '/bin/echo';
  await assert.rejects(inspectGrokProgram(other), error => error.code === 'GROK_PROGRAM_IDENTITY_INVALID');
});
