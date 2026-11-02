import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateProgramInstaller, resolveGrokProgram, unpackPlatformArchive, verifyArchiveIntegrity } from '../src/core/program-install.mjs';
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
  redirect = null, failOfficialArchive = false, handshakeFailure = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-installer-test-'));
  const urls = [], versions = [];
  const fetchImpl = async url => {
    urls.push(url);
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
    handshake: async () => ({ version: VERSION, toolsDeclared: !handshakeFailure, exited: true }) }) };
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
  assert.equal(urls.length, 3);
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
test('failed handshake never promotes the prepared binary', async () => {
  const { installer, directory } = fixture({ handshakeFailure: true });
  await assert.rejects(installer.install(), error => error.code === 'GROK_PROTOCOL_UNVERIFIED');
  assert.equal(existsSync(join(directory, 'active.json')), false);
});
test('progress observer errors cannot invalidate a completed installation', async () => {
  const { installer } = fixture();
  assert.equal((await installer.install({ onProgress: () => { throw new Error('observer-only'); } })).version, VERSION);
  assert.equal((await installer.active()).version, VERSION);
});
test('unverified upstream latest is reported rather than silently pinning or installing it', async () => {
  const { installer, directory } = fixture({ latest: '0.2.0' });
  await assert.rejects(installer.install(), error => error.code === 'GROK_VERSION_UNVERIFIED');
  assert.equal(existsSync(join(directory, 'active.json')), false);
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
