import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateProgramInstaller, resolveGrokProgram, unpackPlatformArchive, verifyArchiveIntegrity } from '../src/core/program-install.mjs';
import { createProgramController } from '../src/program.mjs';
const NAME = '@epsiekygrr_zedxx/grok-search-rs-win32-x64';
const VERSION = '0.1.26';
const PLATFORM = { packageName: NAME, version: VERSION, platform: 'win32' };
function tar(rows) {
  const buffers = [];
  for (const { name, body = '', type = '0' } of rows) {
    const bytes = Buffer.from(body), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000700\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write(type, 156); header.write('ustar\0', 257);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    buffers.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
}
const manifest = { name: NAME, version: VERSION, os: ['win32'], cpu: ['x64'] };
const validRows = () => [
  { name: 'package/package.json', body: JSON.stringify(manifest) },
  { name: 'package/bin/grok-search-rs.exe', body: 'offline-native-binary-fixture' },
];
const integrity = data => 'sha512-' + createHash('sha512').update(data).digest('base64');
function fixture({ latest = VERSION, archive = tar(validRows()), mutateMetadata, failOfficial = false,
  redirect = null, failOfficialArchive = false, handshakeFailure = false, failAll = false, handshake } = {}) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-installer-test-'));
  const urls = [], versions = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (failAll) return new Response('', { status: 503 });
    if (failOfficial && url.startsWith('https://registry.npmjs.org')) throw new Error('offline');
    if (url.endsWith('/latest')) return Response.json({ name: 'grok-search-rs', version: latest });
    if (url.endsWith('/' + VERSION)) {
      const data = { ...manifest, dist: { integrity: integrity(archive),
        tarball: (failOfficial || url.startsWith('https://registry.npmmirror.com') ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org') + '/fixture.tgz' } };
      mutateMetadata?.(data);
      return Response.json(data);
    }
    if (url.endsWith('/fixture.tgz')) {
      if (failOfficialArchive && url.startsWith('https://registry.npmjs.org')) throw new Error('network');
      if (redirect && !url.startsWith('https://cdn.npmmirror.com')) return new Response('', { status: 302, headers: { location: redirect } });
      return new Response(archive);
    }
    return new Response('', { status: 404 });
  };
  const inspect = async path => {
    versions.push(path);
    return { path, version: VERSION, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  };
  return { directory, urls, versions, installer: createPrivateProgramInstaller({ directory, platform: 'win32', arch: 'x64', fetchImpl, inspect,
    handshake: handshake ?? (async () => ({ version: VERSION, toolsDeclared: !handshakeFailure, exited: true })) }) };
}

test('platform archive accepts only the expected manifest and native binary', () => {
  const archive = tar(validRows());
  verifyArchiveIntegrity(archive, integrity(archive));
  const parsed = unpackPlatformArchive(archive, PLATFORM);
  assert.equal(parsed.filename, 'grok-search-rs.exe');
  assert.equal(parsed.executable.toString(), 'offline-native-binary-fixture');
});
test('integrity failure rejects the archive before any installation', () => {
  const archive = tar(validRows());
  assert.throws(() => verifyArchiveIntegrity(Buffer.concat([archive, Buffer.from('changed')]), integrity(archive)), error => error.code === 'GROK_DOWNLOAD_INTEGRITY');
  assert.throws(() => verifyArchiveIntegrity(archive, 'sha1-wrong'), error => error.code === 'GROK_DOWNLOAD_INTEGRITY');
});

test('download cancellation closes a stalled metadata body without mirror retries or publication', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-installer-cancel-body-'));
  const controller = new AbortController(), reason = new Error('synthetic download cancellation');
  let stream, responseBody, started, cancelled = 0, requests = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const installer = createPrivateProgramInstaller({ directory, platform: 'win32', arch: 'x64',
    fetchImpl: async () => {
      requests++;
      responseBody = new Response(new ReadableStream({
        start(value) { stream = value; started(); },
        cancel() { cancelled++; },
      }));
      return responseBody;
    }, inspect: async () => assert.fail('Cancelled download must not inspect a program.'),
    handshake: async () => assert.fail('Cancelled download must not start MCP.') });
  const pending = installer.install({ signal: controller.signal });
  let timer;
  try {
    await ready;
    controller.abort(reason);
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Download body remained pending after cancellation.')), 500);
    })]), failure => failure === reason);
    assert.equal(cancelled, 1);
    assert.equal(requests, 1);
    assert.equal(responseBody.body.locked, false);
    assert.equal(existsSync(join(directory, '.install.lock')), false);
    assert.equal(existsSync(join(directory, 'active.json')), false);
  } finally {
    clearTimeout(timer);
    if (!cancelled) stream.close();
    await pending.catch(() => {});
  }
});

test('path traversal, links, unknown payloads and duplicate binaries are rejected', () => {
  for (const row of [
    { name: 'package/../escape' }, { name: '/absolute' }, { name: 'package/C:\\escape' },
    { name: 'package/link', type: '2' }, { name: 'package/hardlink', type: '1' },
    { name: 'package/pax', type: 'x' }, { name: 'package/evil.js' },
    { name: 'package/bin/grok-search-rs.exe' },
  ]) assert.throws(() => unpackPlatformArchive(tar([...validRows(), row]), PLATFORM), error => error.code.startsWith('GROK_ARCHIVE_'));
});
test('package identity and declared platform are verified', () => {
  for (const patch of [{ name: 'other' }, { version: '9.9.9' }, { os: ['linux'] }, { scripts: { install: 'unsafe' } }]) {
    const rows = validRows();
    rows[0].body = JSON.stringify({ ...manifest, ...patch });
    assert.throws(() => unpackPlatformArchive(tar(rows), PLATFORM), error => error.code === 'GROK_ARCHIVE_METADATA');
  }
});
test('missing program is installed privately and cached, with a receipt', async () => {
  const { installer, directory, urls } = fixture();
  const result = await installer.install();
  assert.ok(result.path.startsWith(directory));
  assert.equal(result.source, 'private-cache');
  assert.equal(result.version, VERSION);
  assert.equal(urls.length, 2);
  assert.equal((await installer.active()).sha256, result.sha256);
  assert.equal(existsSync(join(directory, '.install.lock')), false);
  assert.equal(JSON.parse(readFileSync(join(directory, 'active.json'), 'utf8')).schemaVersion, 1);
});
test('concurrent preparation shares one installation promise', async () => {
  const { installer, versions } = fixture();
  const [first, second] = await Promise.all([installer.install(), installer.install()]);
  assert.equal(first.path, second.path);
  assert.equal(versions.length, 1);
});
test('official registry failure uses a read-only mirror', async () => {
  const { installer, urls } = fixture({ failOfficial: true });
  const result = await installer.install();
  assert.equal(result.version, VERSION);
  assert.ok(urls.some(url => url.startsWith('https://registry.npmmirror.com/')));
});
test('official archive failure uses mirror only with the same integrity', async () => {
  const { installer, urls } = fixture({ failOfficialArchive: true });
  assert.equal((await installer.install()).version, VERSION);
  assert.ok(urls.includes('https://registry.npmmirror.com/fixture.tgz'));
});
test('known mirror CDN redirect is permitted without relaxing arbitrary origins', async () => {
  const { installer, urls } = fixture({ failOfficial: true, redirect: 'https://cdn.npmmirror.com/fixture.tgz' });
  assert.equal((await installer.install()).version, VERSION);
  assert.ok(urls.includes('https://cdn.npmmirror.com/fixture.tgz'));
});
test('untrusted redirect is rejected before fetching its target', async () => {
  const { installer, urls } = fixture({ redirect: 'https://example.invalid/fixture.tgz' });
  await assert.rejects(installer.install(), error => error.code === 'GROK_DOWNLOAD_ORIGIN');
  assert.ok(urls.every(url => !url.includes('example.invalid')));
});
for (const [label, init, expectedCode] of [
  ['HTTP failure', { status: 503 }, 'GROK_DOWNLOAD_HTTP'],
  ['oversized Content-Length', { headers: { 'content-length': String(1_048_577) } }, 'GROK_DOWNLOAD_SIZE'],
]) {
  test(`rejected download ${label} cancels every unread response before trying the mirror`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-installer-response-'));
    let requests = 0, cancellations = 0;
    const cancelledBeforeRequest = [];
    const installer = createPrivateProgramInstaller({
      directory, platform: 'win32', arch: 'x64',
      fetchImpl: async () => {
        cancelledBeforeRequest.push(cancellations);
        requests++;
        return new Response(new ReadableStream({ cancel() { cancellations++; } }), init);
      },
    });
    await assert.rejects(installer.install(), { code: expectedCode });
    assert.equal(requests, 2);
    assert.equal(cancellations, 2);
    assert.deepEqual(cancelledBeforeRequest, [0, 1], 'close the previous body before trying the mirror');
    assert.equal(existsSync(join(directory, '.install.lock')), false);
    assert.equal(existsSync(join(directory, 'active.json')), false);
  });
}
test('failed handshake never promotes the prepared binary', async () => {
  const { installer, directory } = fixture({ handshakeFailure: true });
  await assert.rejects(installer.install(), error => error.code === 'GROK_PROTOCOL_UNVERIFIED');
  assert.equal(existsSync(join(directory, 'active.json')), false);
  assert.deepEqual(readdirSync(directory), [], 'exited, uncommitted candidate is cleaned');
});
test('an uncertain validation process retains its candidate files', async () => {
  const { installer, directory } = fixture({ handshake: async () => {
    throw Object.assign(new Error('not reaped'), { code: 'GROK_PROCESS_REAP_FAILED', diagnostic: { exited: false } });
  } });
  await assert.rejects(installer.install(), { code: 'GROK_PROCESS_REAP_FAILED' });
  assert.equal(existsSync(join(directory, 'active.json')), false);
  assert.equal(readdirSync(directory).filter(name => name.startsWith(VERSION + '-')).length, 1);
});
test('progress observer errors cannot invalidate a completed installation', async () => {
  const { installer } = fixture();
  assert.equal((await installer.install({ onProgress: () => { throw new Error('observer-only'); } })).version, VERSION);
  assert.equal((await installer.active()).version, VERSION);
});
test('a newer upstream latest cannot block first installation of the highest verified version', async () => {
  const { installer, directory, urls } = fixture({ latest: '0.2.0' });
  assert.equal((await installer.install()).version, VERSION);
  assert.equal(urls.some(url => url.endsWith('/latest')), false);
  assert.equal(JSON.parse(readFileSync(join(directory, 'active.json'), 'utf8')).version, VERSION);
});
test('untrusted distribution URL is never fetched', async () => {
  const { installer, urls } = fixture({ mutateMetadata: data => { data.dist.tarball = 'https://example.invalid/evil'; } });
  await assert.rejects(installer.install(), error => error.code === 'GROK_DOWNLOAD_ORIGIN');
  assert.ok(urls.every(url => !url.includes('example.invalid')));
});
test('cache damage is detected before executing a modified binary', async () => {
  const { installer, versions } = fixture();
  const result = await installer.install();
  writeFileSync(result.path, 'modified');
  await assert.rejects(installer.active(), error => error.code === 'GROK_CACHE_DAMAGED');
  assert.equal(versions.length, 1);
});

function damagedCache(directory, missing = false) {
  mkdirSync(join(directory, 'damaged'));
  const executable = 'damaged/grok-search-rs.exe';
  if (!missing) writeFileSync(join(directory, executable), 'damaged-never-executed');
  const record = JSON.stringify({ schemaVersion: 1, version: VERSION, executable,
    sha256: '0'.repeat(64), mcpHandshakeValidated: true });
  writeFileSync(join(directory, 'active.json'), record);
  return record;
}
for (const missing of [false, true]) {
  test(`explicit cache repair recovers ${missing ? 'a missing binary' : 'hash damage'} without consulting unverified latest`, async () => {
    const { installer, directory, urls, versions } = fixture({ latest: '99.0.0' });
    const original = damagedCache(directory, missing);
    await assert.rejects(installer.active(), { code: 'GROK_CACHE_DAMAGED' });
    const [first, second] = await Promise.all([installer.repair(), installer.repair()]);
    assert.equal(first.path, second.path);
    assert.equal(first.version, VERSION);
    assert.equal(versions.length, 1, 'the damaged binary is never executed');
    assert.ok(urls.every(url => !url.endsWith('/latest')));
    assert.equal(urls.length, 2);
    assert.notEqual(readFileSync(join(directory, 'active.json'), 'utf8'), original);
    assert.equal((await installer.active()).path, first.path);
    if (!missing) assert.equal(readFileSync(join(directory, 'damaged/grok-search-rs.exe'), 'utf8'), 'damaged-never-executed');
  });
}
for (const [name, options, code] of [
  ['download', { failAll: true }, 'GROK_DOWNLOAD_HTTP'],
  ['integrity', { mutateMetadata: data => { data.dist.integrity = integrity(Buffer.from('wrong')); } }, 'GROK_DOWNLOAD_INTEGRITY'],
  ['handshake', { handshakeFailure: true }, 'GROK_PROTOCOL_UNVERIFIED'],
]) {
  test(`failed cache repair during ${name} preserves active record and shared configuration`, async () => {
    const { installer, directory } = fixture(options);
    const original = damagedCache(directory);
    const shared = join(directory, '../config-' + directory.split(/[\\/]/).at(-1) + '.toml');
    writeFileSync(shared, 'tavily_api_key = "synthetic-unchanged"\n', { flag: 'wx' });
    const bytes = readFileSync(shared);
    await assert.rejects(installer.repair(), { code });
    assert.equal(readFileSync(join(directory, 'active.json'), 'utf8'), original);
    assert.deepEqual(readFileSync(shared), bytes);
    assert.equal(existsSync(join(directory, '.install.lock')), false);
  });
}
test('cache repair respects cancellation and another installation lock, then succeeds on retry', async () => {
  const { installer, directory, urls } = fixture();
  const original = damagedCache(directory);
  const cancellation = new AbortController();
  const reason = new Error('cancel repair'); cancellation.abort(reason);
  await assert.rejects(installer.repair({ signal: cancellation.signal }), error => error === reason);
  writeFileSync(join(directory, '.install.lock'), 'other-owner');
  await assert.rejects(installer.repair(), { code: 'GROK_INSTALL_BUSY' });
  assert.equal(urls.length, 0);
  assert.equal(readFileSync(join(directory, 'active.json'), 'utf8'), original);
  assert.equal(readFileSync(join(directory, '.install.lock'), 'utf8'), 'other-owner');
  unlinkSync(join(directory, '.install.lock')); // This test owns the synthetic lock.
  assert.equal((await installer.repair()).version, VERSION);
});
test('cache repair cannot follow a record outside its managed directory', async () => {
  const { installer, directory, urls } = fixture();
  const original = JSON.stringify({ schemaVersion: 1, version: VERSION, executable: '../outside.exe',
    sha256: '0'.repeat(64), mcpHandshakeValidated: true });
  writeFileSync(join(directory, 'active.json'), original);
  await assert.rejects(installer.repair(), { code: 'GROK_CACHE_PATH_INVALID' });
  assert.equal(readFileSync(join(directory, 'active.json'), 'utf8'), original);
  assert.equal(urls.length, 0);
});
test('cache repair cannot write through a linked cache root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cache-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'dsh-cache-outside-'));
  const directory = join(root, 'linked-cache');
  symlinkSync(outside, directory, 'junction');
  let downloads = 0;
  const installer = createPrivateProgramInstaller({ directory, platform: 'win32', arch: 'x64',
    fetchImpl: async () => { downloads++; throw new Error('must not download'); } });
  await assert.rejects(installer.repair(), { code: 'GROK_CACHE_PATH_INVALID' });
  assert.equal(downloads, 0);
  assert.equal(existsSync(join(outside, '.install.lock')), false);
  assert.equal(existsSync(join(outside, 'active.json')), false);
});
test('cancellation after repair handshake never promotes the new program', async () => {
  const controller = new AbortController(), reason = new Error('cancel at handshake');
  const { installer, directory } = fixture({ handshake: async () => {
    controller.abort(reason);
    return { version: VERSION, toolsDeclared: true, exited: true };
  } });
  const original = damagedCache(directory);
  await assert.rejects(installer.repair({ signal: controller.signal }), error => error === reason);
  assert.equal(readFileSync(join(directory, 'active.json'), 'utf8'), original);
  assert.equal(existsSync(join(directory, '.install.lock')), false);
});
test('the real controller and resolver recover a damaged private cache without resetting configuration', async () => {
  const { installer, directory } = fixture();
  damagedCache(directory);
  const configPath = join(directory, 'shared.toml');
  const configuration = 'tavily_api_key = "synthetic-preserved"\n';
  writeFileSync(configPath, configuration);
  const manager = createProgramController({ directory, installer, configuration: { configPath },
    env: () => ({ HOME: directory, USERPROFILE: directory, CARGO_HOME: join(directory, 'cargo'), PATH: '' }) });
  try {
    await assert.rejects(manager.prepare(), { code: 'GROK_CACHE_DAMAGED' });
    assert.equal(manager.snapshot().canRepair, true);
    const recovered = await manager.repair();
    assert.equal(recovered.phase, 'ready');
    assert.equal(recovered.canRepair, false);
    assert.equal(recovered.program.source, 'private-cache');
    assert.equal(manager.execution().configPath, configPath);
    assert.equal(readFileSync(configPath, 'utf8'), configuration);
  } finally { await manager.dispose(); }
});
test('stale lock is never reclaimed automatically', async () => {
  const { installer, directory } = fixture();
  writeFileSync(join(directory, '.install.lock'), 'other-owner');
  await assert.rejects(installer.install(), error => error.code === 'GROK_INSTALL_BUSY');
  assert.equal(readFileSync(join(directory, '.install.lock'), 'utf8'), 'other-owner');
});
test('pre-cancelled install leaves cache unchanged', async () => {
  const { installer, directory, urls } = fixture();
  const controller = new AbortController();
  const reason = new Error('cancelled'); controller.abort(reason);
  await assert.rejects(installer.install({ signal: controller.signal }), error => error === reason);
  assert.equal(urls.length, 0);
  assert.equal(existsSync(join(directory, 'active.json')), false);
});
test('discovery reuses an existing program without consulting the installer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-discovery-install-'));
  const binary = join(root, 'grok-search-rs.exe');
  writeFileSync(binary, 'existing');
  const result = await resolveGrokProgram({ override: binary, inspect: async path => ({ path, version: VERSION }),
    installer: { active: () => { throw new Error('must not inspect cache'); }, install: () => { throw new Error('must not download'); } } });
  assert.equal(result.source, 'manual');
});

test('unsupported automatic program discovery does not block a verified private cache or explicit repair', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-discovery-fallback-'));
  writeFileSync(join(directory, 'grok-search-rs.exe'), 'automatic-candidate');
  const options = { env: { PATH: directory, HOME: directory }, platform: 'win32', arch: 'x64',
    inspect: async () => { throw Object.assign(new Error('unsupported'), { code: 'GROK_VERSION_UNVERIFIED' }); } };
  const cached = { found: true, path: 'verified-private-cache' };
  assert.deepEqual(await resolveGrokProgram({ ...options, installer: { active: async () => cached } }), cached);
  await assert.rejects(resolveGrokProgram({ ...options, installer: { active: async () => null,
    install() { assert.fail('an unverified existing program does not authorize silent replacement'); } } }),
  { code: 'GROK_VERSION_UNVERIFIED' });
  assert.deepEqual(await resolveGrokProgram({ ...options, repair: true, installer: { repair: async () => cached } }), cached);
  await assert.rejects(resolveGrokProgram({ ...options, repair: true,
    configured: join(directory, 'grok-search-rs.exe'), installer: { repair() { assert.fail('explicit paths remain authoritative'); } } }),
  { code: 'GROK_VERSION_UNVERIFIED' });
});
