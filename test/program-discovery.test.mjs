import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverGrokCandidates, findExistingGrok, grokPlatformPackage, inspectGrokProgram } from '../src/core/program-discovery.mjs';
import { resolveGrokProgram } from '../src/core/program-install.mjs';
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
test('an orphan npm shim or incomplete package is never executed and falls back to the private program', async () => {
  for (const artifact of ['grok-search-rs.cmd', 'grok-search-rs.ps1', 'grok-search-rs.bat',
    'node_modules/grok-search-rs/package.json',
    'node_modules/@epsiekygrr_zedxx/grok-search-rs-win32-x64/package.json']) {
    for (const cached of [{ path: 'private-cache', found: true }, null]) {
      const root = setup();
      makeFile(join(root, artifact));
      let inspections = 0, actives = 0, installs = 0;
      const result = await resolveGrokProgram({
        env: { PATH: root, USERPROFILE: root }, platform: 'win32', arch: 'x64',
        inspect: async () => { inspections++; throw new Error('must not execute a shim'); },
        installer: {
          active: async () => { actives++; return cached; },
          install: async () => { installs++; return { path: 'prepared', found: true }; },
        },
      });
      assert.equal(inspections, 0, artifact);
      assert.equal(actives, 1, artifact);
      // A completed private install is reused; only a missing one is prepared.
      assert.equal(installs, cached ? 0 : 1, artifact);
      assert.equal(result.path, cached ? 'private-cache' : 'prepared', artifact);
    }
  }
});
test('a healthy native installation is reusable despite an orphan shim elsewhere on PATH', async () => {
  const root = setup(), stale = join(root, 'stale'), healthy = join(root, 'healthy');
  makeFile(join(stale, 'grok-search-rs.cmd'));
  const binary = makeFile(join(healthy, 'grok-search-rs.exe'));
  const result = await findExistingGrok({
    env: { PATH: `${stale};${healthy}`, USERPROFILE: root }, platform: 'win32', arch: 'x64',
    inspect: async path => ({ path, version: '0.1.26' }),
  });
  assert.equal(result.path, binary);
});
for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64']]) {
  const unixFixture = (text = '#!/usr/bin/env node\nthrow new Error("must never run");\n') => {
    const root = setup(), cargo = join(root, 'cargo'), bin = join(cargo, 'bin');
    const wrapper = makeFile(join(bin, 'grok-search-rs'));
    writeFileSync(wrapper, text); chmodSync(wrapper, 0o700);
    // Windows cannot represent a POSIX PATH drive separator. Cargo discovery
    // reaches the same automatic-candidate branch; native Unix also uses PATH.
    const env = { HOME: root, USERPROFILE: root, CARGO_HOME: cargo,
      PATH: process.platform === 'win32' ? '' : bin };
    return { root, wrapper, bin, env };
  };
  test(`${platform}: a launcher-only installation reuses private cache or prepares it without executing the script`, async () => {
    for (const header of ['#!/usr/bin/env node', '#!/bin/sh']) {
      for (const cached of [{ path: 'private-cache', found: true }, null]) {
        const { env } = unixFixture(header + '\nexit 99\n');
        let actives = 0, installs = 0;
        const result = await resolveGrokProgram({ env, platform, arch, installer: {
          active: async () => { actives++; return cached; },
          install: async () => { installs++; return { path: 'prepared', found: true }; },
        } });
        assert.equal(actives, 1);
        assert.equal(installs, cached ? 0 : 1);
        assert.equal(result.path, cached ? 'private-cache' : 'prepared');
      }
    }
  });
  test(`${platform}: a manually selected launcher remains an explicit error`, async () => {
    const { env, wrapper } = unixFixture();
    for (const selection of [{ override: wrapper }, { configured: wrapper }]) {
      await assert.rejects(resolveGrokProgram({ ...selection, env, platform, arch,
        installer: { active: () => assert.fail('must not fall back'), install: () => assert.fail('must not install') } }),
      { code: 'GROK_PROGRAM_NOT_NATIVE' });
    }
  });
  test(`${platform}: launcher discovery still finds a valid native npm program`, async () => {
    const { env, wrapper, bin } = unixFixture();
    const binary = makeFile(join(bin, 'node_modules', grokPlatformPackage(platform, arch), 'bin/grok-search-rs'));
    const result = await findExistingGrok({ env, platform, arch, inspect: (path, options) =>
      path === wrapper ? inspectGrokProgram(path, options) : Promise.resolve({ path, version: '0.1.26' }) });
    assert.equal(result.path, binary);
    assert.equal(result.source, 'npm');
    await assert.rejects(findExistingGrok({ env, platform, arch, inspect: (path, options) =>
      path === wrapper ? inspectGrokProgram(path, options)
        : Promise.reject(Object.assign(new Error('unverified native version'), { code: 'GROK_VERSION_UNVERIFIED' })) }),
    { code: 'GROK_VERSION_UNVERIFIED' });
  });
  test(`${platform}: arbitrary damaged bytes are not silently treated as an ignorable launcher`, async () => {
    const { env } = unixFixture('damaged-native-file');
    await assert.rejects(findExistingGrok({ env, platform, arch }), { code: 'GROK_PROGRAM_NOT_NATIVE' });
  });
}
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
