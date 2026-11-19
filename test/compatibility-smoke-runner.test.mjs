import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { archivePath, inspectPackage, inspectZip, parseSevenZipListing, runCompatibilitySmoke } from '../scripts/lib/compatibility-smoke.mjs';

function tarFile(path, contents, type = '0') {
  const data = Buffer.from(contents), header = Buffer.alloc(512);
  header.write(path, 0);
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header.write(type, 156);
  header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((value, byte) => value + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(entries) {
  const bodies = [], rows = [];
  let offset = 0;
  for (const { path, contents = '', mode = 0x81a4, flags = 0, method = 0,
    descriptor = 'signed', populatedLocal = false, extra = Buffer.alloc(0) } of entries) {
    const name = Buffer.from(path), data = Buffer.from(contents), crc = crc32(data);
    const compressed = method === 8 ? deflateRawSync(data) : data, local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!(flags & 8) || populatedLocal) {
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    const tail = flags & 8 && descriptor !== 'missing' ? Buffer.alloc(descriptor === 'signed' ? 16 : 12) : Buffer.alloc(0);
    if (tail.length) {
      const start = descriptor === 'signed' ? 4 : 0;
      if (start) tail.writeUInt32LE(0x08074b50, 0);
      tail.writeUInt32LE(crc, start); tail.writeUInt32LE(compressed.length, start + 4); tail.writeUInt32LE(data.length, start + 8);
    }
    const body = Buffer.concat([local, name, extra, compressed, tail]);
    bodies.push(body); offset += body.length; rows.push(Buffer.concat([central, name, extra]));
  }
  const body = Buffer.concat(bodies), index = Buffer.concat(rows);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, index, end]);
}

function zipFile(path, contents, mode = 0x81a4, flags = 0) {
  return zipArchive([{ path, contents, mode, flags }]);
}

const centralOffset = archive => archive.readUInt32LE(archive.length - 6);

test('preparation failure never claims verified cleanup without a completed host receipt', async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'dsh-compatibility-preparation-'));
  const result = await runCompatibilitySmoke({ outputRoot });
  assert.equal(result.passed, false);
  assert.equal(result.cleanupVerified, false);
  assert.equal(result.gates[0].status, 'failed');
  const failure = JSON.parse(readFileSync(join(outputRoot, 'preparation-failure.json'), 'utf8'));
  assert.equal(failure.code, 'COMPATIBILITY_SMOKE_POLICY_REQUIRED');
  assert.equal(failure.childStarted, false);
});

test('archive names reject traversal, absolute paths, Windows aliases and control characters', () => {
  assert.equal(archivePath('resources\\app.asar', { windows: true }), 'resources/app.asar');
  for (const path of ['../outside', '/outside', 'C:\\outside', 'a/./b', 'a//b', 'a\0b', 'a\nb', 'a:b']) {
    assert.throws(() => archivePath(path), { code: 'COMPATIBILITY_ARCHIVE_PATH_UNSAFE' });
  }
  for (const path of ['aux.txt', 'a/NUL', 'a/file.', 'a/file ', 'a/NUL .txt', 'COM\u00b9',
    'LPT\u00b2.log', 'com\u00b3.txt', 'CONIN$', 'a/conout$.txt', 'a/file*', 'a/file?', 'a/<file>', 'a/fi"le', 'a/fi|le']) {
    assert.throws(() => archivePath(path, { windows: true }), { code: 'COMPATIBILITY_ARCHIVE_PATH_UNSAFE' });
  }
  assert.equal(archivePath('App/e\u0301/file'), 'App/e\u0301/file', 'Keys, not output paths, are Unicode-normalized.');
  assert.throws(() => archivePath('a/\ud800'), { code: 'COMPATIBILITY_ARCHIVE_PATH_UNSAFE' });
});

test('7-Zip listing permits ordinary members but rejects links, duplicates and file-parent conflicts', () => {
  const row = (path, fields = '') => `Path = ${path}\nSize = 2\n${fields}\n`;
  assert.equal(parseSevenZipListing('header\n----------\n' + row('app.asar')).length, 1);
  assert.equal(parseSevenZipListing('header\n----------\n' + row('app.asar') + '\n\nWarnings: 1\n').length, 1);
  assert.throws(() => parseSevenZipListing('bad'), { code: 'COMPATIBILITY_ARCHIVE_LIST_INVALID' });
  for (const fields of ['Symbolic Link = outside', 'Hard Link = elsewhere', 'Encrypted = +']) {
    assert.throws(() => parseSevenZipListing('----------\n' + row('a', fields)));
  }
  assert.throws(() => parseSevenZipListing('----------\n' + row('a') + '\n' + row('A')),
    { code: 'COMPATIBILITY_ARCHIVE_DUPLICATE' });
  assert.throws(() => parseSevenZipListing('----------\n' + row('a') + '\n' + row('a/b')),
    { code: 'COMPATIBILITY_ARCHIVE_PATH_CONFLICT' });
});

test('7-Zip listing refuses duplicate fields, malformed records and trimmed-away unsafe names', () => {
  for (const fields of [
    'Path = ../outside\nPath = safe\nSize = 1',
    'Path = safe\nSize = 1\nSize = 2',
    'Path = safe\nSize = 1\nSymbolic Link = outside\nSymbolic Link = \nAttributes = A',
    'Path = safe\nSize = 1\nHard Link = outside\nHard Link = \nAttributes = A',
    'Path = safe\nSize = 1\nEncrypted = +\nEncrypted = -',
    'Path = safe\nSize = 1\nmalformed',
    'Path = safe\nSize = 0x2',
    'Path = safe\nSize = 1e2',
    'Path = safe\nSize = ',
    'Size = 1\nPath = safe',
  ]) assert.throws(() => parseSevenZipListing('----------\n' + fields + '\n'),
    { code: 'COMPATIBILITY_ARCHIVE_LIST_INVALID' });
  assert.throws(() => parseSevenZipListing('----------\nSize = 1\nPath = file \n'),
    { code: 'COMPATIBILITY_ARCHIVE_LIST_INVALID' });
  assert.throws(() => parseSevenZipListing('----------\nPath = file \nSize = 1\n'),
    { code: 'COMPATIBILITY_ARCHIVE_PATH_UNSAFE' });
  assert.throws(() => parseSevenZipListing('----------\nPath = COM\u00b9\nSize = 1\n'),
    { code: 'COMPATIBILITY_ARCHIVE_PATH_UNSAFE' });
  assert.deepEqual(parseSevenZipListing('----------\r\nPath = folder/\r\nSize = \r\nFolder = +\r\n'),
    [{ path: 'folder', size: 0, directory: true }]);
});

test('tarball inspection binds normal npm file bytes without executing package code', () => {
  const data = gzipSync(Buffer.concat([
    tarFile('package/package.json', '{"name":"dsh-grok-search","version":"0.4.0"}'),
    tarFile('package/src/index.mjs', 'throw new Error("must not execute");'), Buffer.alloc(1024),
  ]));
  const result = inspectPackage(data);
  assert.equal(result.manifest.version, '0.4.0');
  assert.equal(result.files.size, 2);
  assert.match(result.files.get('src/index.mjs').toString(), /must not execute/);
  assert.throws(() => inspectPackage(gzipSync(Buffer.concat([
    tarFile('package/package.json', '{}'), tarFile('package/../escape', 'x'), Buffer.alloc(1024),
  ]))));
  assert.throws(() => inspectPackage(gzipSync(Buffer.concat([
    tarFile('package/package.json', '{}'), tarFile('package/link', 'target', '2'), Buffer.alloc(1024),
  ]))), { code: 'COMPATIBILITY_PACKAGE_UNSUPPORTED_ENTRY' });
});

test('ZIP validation checks local names and confines macOS Framework links before extraction', () => {
  const archive = zipFile('DeepSeek Harness.app/Contents/file', 'content');
  assert.deepEqual(inspectZip(archive), [{ path: 'DeepSeek Harness.app/Contents/file', size: 7, directory: false }]);
  const link = zipFile('App/Framework/Current', 'A', 0xa1ff);
  assert.equal(inspectZip(link)[0].link, 'A');
  for (const target of ['/outside', '../../../outside', 'C:\\outside']) {
    assert.throws(() => inspectZip(zipFile('App/Framework/Current', target, 0xa1ff)));
  }
  assert.throws(() => inspectZip(zipFile('../outside', 'x')));
  assert.throws(() => inspectZip(zipFile('encrypted', 'x', 0x81a4, 1)));
  const changed = Buffer.from(archive); changed[30] = 88;
  assert.throws(() => inspectZip(changed), { code: 'COMPATIBILITY_ARCHIVE_PATH_CONFLICT' });
  assert.throws(() => inspectZip(Buffer.alloc(4)), { code: 'COMPATIBILITY_ARCHIVE_LIST_INVALID' });
});

test('ZIP preflight resolves transitive link targets before applying dot-dot segments', () => {
  const link = (path, contents) => ({ path, contents, mode: 0xa1ff });
  for (const entries of [
    [link('base', '.'), link('up', 'base/..')],
    [link('App/base', '..'), link('App/up', 'base/..')],
    [link('App/base', '..'), link('App/indirect', 'base'), link('App/escape', 'indirect/..')],
    [link('App/current', 'Versions/Current'), link('App/Versions/Current', '../..'), link('App/escape', 'current/..')],
  ]) assert.throws(() => inspectZip(zipArchive(entries)), { code: 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE' });
});

test('ZIP link preflight rejects cycles and files used as directory components', () => {
  const link = (path, contents) => ({ path, contents, mode: 0xa1ff });
  for (const entries of [
    [link('self', 'self')], [link('a', 'b'), link('b', 'a')],
    [{ path: 'file', contents: 'x' }, link('link', 'file/..')],
    [{ path: 'file', contents: 'x' }, link('link', 'file/child')],
    [link('empty', '')],
  ]) assert.throws(() => inspectZip(zipArchive(entries)), { code: 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE' });
});

test('ZIP keys reject Unicode-normalized duplicates and aliased parent links', () => {
  const file = path => ({ path, contents: 'content' });
  for (const entries of [
    [file('\u00e9'), file('e\u0301')],
    [file('App/\u00c9'), file('app/e\u0301')],
    [file('\u03c3'), file('\u03c2')],
  ]) assert.throws(() => inspectZip(zipArchive(entries)), { code: 'COMPATIBILITY_ARCHIVE_DUPLICATE' });
  for (const mode of [0x81a4, 0xa1ff]) {
    assert.throws(() => inspectZip(zipArchive([
      { path: 'App/\u00e9', contents: 'target', mode }, file('App/e\u0301/child'),
    ])), { code: 'COMPATIBILITY_ARCHIVE_PATH_CONFLICT' });
  }
  assert.throws(() => inspectZip(zipArchive([
    { path: 'base', contents: '.', mode: 0xa1ff },
    { path: 'up', contents: 'base/..', mode: 0xa1ff },
    { path: '\u00e9', contents: 'up/..', mode: 0xa1ff },
    file('e\u0301/synthetic-target'),
  ])), { code: 'COMPATIBILITY_ARCHIVE_PATH_CONFLICT' });
});

test('safe macOS Framework chains and internal dot-dot link targets remain supported', () => {
  const entries = [
    { path: 'App/Framework/Versions/A/Framework', contents: 'binary' },
    { path: 'App/Framework/Versions/A/Resources/data', contents: 'data' },
    { path: 'App/Framework/Versions/Current', contents: 'A', mode: 0xa1ff },
    { path: 'App/Framework/Framework', contents: 'Versions/Current/Framework', mode: 0xa1ff },
    { path: 'App/Framework/Resources', contents: 'Versions/Current/Resources', mode: 0xa1ff },
    { path: 'App/Framework/Versions/A/PreviousResources', contents: '../Current/Resources', mode: 0xa1ff },
  ];
  assert.equal(inspectZip(zipArchive(entries)).length, entries.length);
  assert.equal(inspectZip(zipArchive(entries.slice().reverse())).length, entries.length, 'Resolution does not depend on listing order.');
});

test('ZIP local flags, method, CRC, sizes and version must match their central directory', () => {
  for (const [offset, value, width] of [
    [4, 21, 2], [6, 1, 2], [6, 8, 2], [8, 8, 2],
    [14, 1, 4], [18, 3, 4], [22, 0x7fffffff, 4],
  ]) {
    const archive = zipFile('safe', 'data');
    if (width === 2) archive.writeUInt16LE(value, offset);
    else archive.writeUInt32LE(value, offset);
    assert.throws(() => inspectZip(archive), { code: 'COMPATIBILITY_ARCHIVE_HEADER_MISMATCH' });
  }
  const matchingDeflate = zipArchive([{ path: 'deflated', contents: 'content'.repeat(20), method: 8 }]);
  assert.equal(inspectZip(matchingDeflate)[0].size, 140);
});

test('ZIP streaming entries require a matching signed or unsigned data descriptor', () => {
  for (const descriptor of ['signed', 'unsigned']) {
    for (const populatedLocal of [false, true]) {
      for (const method of [0, 8]) {
        const archive = zipArchive([{ path: 'streamed', contents: 'streaming content', flags: 8, descriptor, populatedLocal, method }]);
        assert.equal(inspectZip(archive)[0].size, 17);
      }
    }
  }
  for (const method of [0, 8]) {
    const linked = zipArchive([{ path: 'App/Current', contents: 'Target', mode: 0xa1ff, flags: 8, method }]);
    assert.equal(inspectZip(linked)[0].link, 'Target');
  }
  assert.throws(() => inspectZip(zipArchive([{ path: 'missing', contents: 'data', flags: 8, descriptor: 'missing' }])),
    { code: 'COMPATIBILITY_ARCHIVE_DESCRIPTOR_INVALID' });
  for (const descriptor of ['signed', 'unsigned']) {
    for (const field of [0, 4, 8]) {
      const archive = zipArchive([{ path: 'changed', contents: 'data', flags: 8, descriptor }]);
      const start = centralOffset(archive) - 12;
      archive.writeUInt32LE(0x12345678, start + field);
      assert.throws(() => inspectZip(archive), { code: 'COMPATIBILITY_ARCHIVE_DESCRIPTOR_INVALID' });
    }
  }
  const invalidLocal = zipArchive([{ path: 'invalid-local', contents: 'data', flags: 8 }]);
  invalidLocal.writeUInt32LE(99, 22);
  assert.throws(() => inspectZip(invalidLocal), { code: 'COMPATIBILITY_ARCHIVE_HEADER_MISMATCH' });
});

test('ZIP extra fields cannot override names and link payloads must match their declared bytes', () => {
  const unicode = (path, alternate) => {
    const name = Buffer.from(alternate), extra = Buffer.alloc(9 + name.length);
    extra.writeUInt16LE(0x7075, 0); extra.writeUInt16LE(5 + name.length, 2); extra[4] = 1;
    extra.writeUInt32LE(crc32(Buffer.from(path)), 5); name.copy(extra, 9);
    return extra;
  };
  assert.equal(inspectZip(zipArchive([{ path: 'safe', contents: 'data', extra: unicode('safe', 'safe') }])).length, 1);
  assert.throws(() => inspectZip(zipArchive([{ path: 'safe', contents: 'data', extra: unicode('safe', '../escape') }])),
    { code: 'COMPATIBILITY_ARCHIVE_PATH_CONFLICT' });
  const badCrc = zipFile('App/Current', 'Target', 0xa1ff);
  badCrc[30 + Buffer.byteLength('App/Current')] ^= 1;
  assert.throws(() => inspectZip(badCrc), { code: 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE' });
  assert.throws(() => inspectZip(zipFile('App/Current', Buffer.from([0xff]), 0xa1ff)),
    { code: 'COMPATIBILITY_ARCHIVE_LINK_UNSAFE' });
  const multiDisk = zipFile('safe', 'data');
  multiDisk.writeUInt16LE(1, centralOffset(multiDisk) + 34);
  assert.throws(() => inspectZip(multiDisk), { code: 'COMPATIBILITY_ARCHIVE_LIST_INVALID' });
});
