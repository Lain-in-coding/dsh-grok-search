import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createPlatformArchive, loadManifest, sha256, verifySource } from './build-grok-backend.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = loadManifest(root);
const license = readFileSync(new URL('../backend/LICENSE', import.meta.url), 'utf8');

function unpack(archive) {
  const bytes = gunzipSync(archive);
  const files = new Map();
  const text = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
  const octal = bytes => Number.parseInt(text(bytes).trim(), 8);
  let at = 0;
  while (at + 512 <= bytes.length && bytes.subarray(at, at + 512).some(x => x !== 0)) {
    const header = bytes.subarray(at, at + 512);
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    assert.equal(octal(header.subarray(148, 156)), checksum);
    assert.equal(header[156], 48, 'only ordinary files are accepted');
    assert.equal(text(header.subarray(345, 500)), '', 'no extended path');
    const name = text(header.subarray(0, 100));
    assert.ok(!files.has(name));
    const size = octal(header.subarray(124, 136));
    assert.ok(size > 0 && size <= 50 * 1024 * 1024);
    assert.equal(octal(header.subarray(136, 148)), 0);
    files.set(name, { content: bytes.subarray(at + 512, at + 512 + size), mode: octal(header.subarray(100, 108)) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(bytes.length - at >= 1024);
  assert.ok(bytes.subarray(at).every(x => x === 0));
  return files;
}

test('source and patch are immutable pins; no download URL is invented for an unbuilt release', () => {
  assert.equal(manifest.upstream.commit, 'be5fe87db22939de9405a7e9c70b1e43f7151214');
  assert.equal(manifest.upstream.cargoVersion, '0.1.25');
  assert.equal(manifest.version, '0.1.26-dsh.1');
  assert.equal(manifest.patch.sha256, sha256(readFileSync(new URL('../backend/grok-search-rs.patch', import.meta.url))));
  assert.throws(() => verifySource(Buffer.from('wrong source'), manifest), /SHA-256 mismatch/);
  for (const value of Object.values(manifest.platforms)) assert.equal(value.url, undefined);
});

for (const platform of Object.keys(manifest.platforms)) {
  test(platform + ': reproducible archive matches strict two-file installer layout and preserves license', () => {
    const executable = Buffer.from('fixture executable bytes\0');
    const archive = createPlatformArchive(manifest, platform, executable, license);
    assert.deepEqual(archive, createPlatformArchive(manifest, platform, executable, license));
    const entries = unpack(archive), p = manifest.platforms[platform];
    assert.deepEqual([...entries.keys()], ['package/package.json', 'package/bin/' + p.executable]);
    const metadata = JSON.parse(entries.get('package/package.json').content.toString('utf8'));
    assert.equal(metadata.name, p.packageName);
    assert.equal(metadata.version, manifest.version);
    assert.equal(metadata.scripts, undefined);
    assert.equal(metadata.license, 'MIT');
    assert.equal(metadata.licenseText, license);
    assert.deepEqual(metadata.os, [p.os]);
    assert.deepEqual(metadata.cpu, [p.arch]);
    assert.equal(metadata.dshBackend.patchSha256, manifest.patch.sha256);
    assert.deepEqual(entries.get('package/bin/' + p.executable).content, executable);
    assert.equal(entries.get('package/bin/' + p.executable).mode, 0o755);
    assert.throws(() => createPlatformArchive(manifest, platform, Buffer.alloc(0), license), /Invalid platform/);
  });
}

test('workflow uploads only small release files and has no publish/secrets/cache capabilities', () => {
  const workflow = readFileSync(new URL('../.github/workflows/grok-backend-build.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /branches: \[ci\/grok-responses-backend\]/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /runner: macos-15/);
  assert.doesNotMatch(workflow, /secrets\.|contents: write|actions\/cache|rust-cache|npm publish|gh release/);
});
