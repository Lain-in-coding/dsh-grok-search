import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateProgramInstaller, resolveGrokProgram, unpackPlatformArchive, verifyArchiveIntegrity } from '../src/core/program-install.mjs';
import { createProgramController } from '../src/program.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';
import { acquireOwnedLock } from '../src/core/owned-lock.mjs';
import { inspectGrokProgram } from '../src/core/program-discovery.mjs';
import { probeMcpHandshake, runMcpSearch } from '../src/core/mcp-search.mjs';
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
  redirect = null, failOfficialArchive = false, handshakeFailure = false, failAll = false, handshake,
  inspect: inspectImpl, directory: suppliedDirectory } = {}) {
  const directory = suppliedDirectory ?? mkdtempSync(join(realpathSync(tmpdir()), 'dsh-installer-test-'));
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
  const inspect = async (path, options) => {
    versions.push(path);
    if (inspectImpl) return inspectImpl(path, options);
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
  const rows = validRows();
  rows[0].body = 'null';
  assert.throws(() => unpackPlatformArchive(tar(rows), PLATFORM), { code: 'GROK_ARCHIVE_METADATA' });
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
for (const redirect of ['https://example.invalid/fixture.tgz', 'https://[invalid']) {
  test(`invalid or untrusted redirect is rejected before fetching ${redirect}`, async () => {
    const { installer, urls } = fixture({ redirect });
    await assert.rejects(installer.install(), { code: 'GROK_DOWNLOAD_ORIGIN' });
    assert.ok(!urls.includes(redirect));
  });
}
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
for (const code of ['GROK_PROGRAM_CHANGED', 'SYNTHETIC_INSPECTION_FAILURE']) {
  test(`confirmed inspection exit cleans repeated candidates without deleting active or historical files (${code})`, async () => {
    let failInspection = false;
    const failure = Object.assign(new Error('inspection failed after close'), { code });
    Object.defineProperty(failure, 'diagnostic', { value: Object.freeze({ exited: true }) });
    const { installer, directory, versions } = fixture({ inspect: async path => {
      if (failInspection) throw failure;
      return { path, version: VERSION, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    } });
    const installed = await installer.install();
    const active = readFileSync(join(directory, 'active.json')), binary = readFileSync(installed.path);
    const history = join(directory, `${VERSION}-historical`);
    mkdirSync(history);
    writeFileSync(join(history, 'grok-search-rs.exe'), 'historical-owned-by-another-attempt');
    writeFileSync(join(directory, 'unrelated.txt'), 'preserved');
    const names = readdirSync(directory).sort();
    failInspection = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(installer.install(), error => error === failure);
      assert.equal(existsSync(versions.at(-1)), false);
      assert.deepEqual(readdirSync(directory).sort(), names);
      assert.deepEqual(readFileSync(join(directory, 'active.json')), active);
      assert.deepEqual(readFileSync(installed.path), binary);
      assert.equal(readFileSync(join(history, 'grok-search-rs.exe'), 'utf8'), 'historical-owned-by-another-attempt');
      assert.equal(readFileSync(join(directory, 'unrelated.txt'), 'utf8'), 'preserved');
    }
  });
}
test('confirmed inspection exit removes its binary but preserves unknown files in the candidate directory', async () => {
  const failure = new GrokSearchError('GROK_PROGRAM_CHANGED', 'changed after close');
  Object.defineProperty(failure, 'diagnostic', { value: Object.freeze({ exited: true }) });
  let unknown;
  const { installer, directory, versions } = fixture({ inspect: async path => {
    unknown = join(path, '..', 'unknown.txt');
    writeFileSync(unknown, 'not-installer-owned');
    throw failure;
  } });
  await assert.rejects(installer.install(), error => error === failure);
  assert.equal(existsSync(versions[0]), false);
  assert.equal(readFileSync(unknown, 'utf8'), 'not-installer-owned');
  assert.deepEqual(readdirSync(join(unknown, '..')), ['unknown.txt']);
  assert.equal(existsSync(join(directory, 'active.json')), false);
  assert.equal(existsSync(join(directory, '.install.lock')), false);
});
for (const [label, code, exited] of [
  ['missing exit fact', 'GROK_PROGRAM_CHANGED', undefined],
  ['unconfirmed close', 'GROK_PROGRAM_REAP_FAILED', false],
  ['non-boolean exit fact', 'GROK_PROGRAM_CHANGED', 'true'],
]) {
  test(`failed inspection retains its candidate without explicit confirmed exit (${label})`, async () => {
    const failure = new GrokSearchError(code, 'inspection exit is unconfirmed');
    if (exited !== undefined) Object.defineProperty(failure, 'diagnostic', { value: Object.freeze({ exited }) });
    const { installer, directory, versions, urls } = fixture({ inspect: async () => { throw failure; } });
    await assert.rejects(installer.install(), error => error === failure);
    assert.equal(readFileSync(versions[0], 'utf8'), 'offline-native-binary-fixture');
    assert.equal(readdirSync(directory).length, 2);
    assert.equal(existsSync(join(directory, 'active.json')), false);
    assert.equal(existsSync(join(directory, '.install.lock')), true, 'no exit proof means the validator still owns the cache');
    const requests = urls.length;
    await assert.rejects(installer.install(), { code: 'GROK_INSTALL_BUSY' });
    assert.equal(urls.length, requests);
  });
}
for (const [label, handshake] of [
  ['thrown error', async () => {
    throw Object.assign(new Error('not reaped'), { code: 'GROK_PROCESS_REAP_FAILED', diagnostic: { exited: false } });
  }],
  ['exit result', async () => ({ version: VERSION, toolsDeclared: true, exited: false })],
]) {
  test(`an unproven handshake retains its lock and candidate (${label})`, async () => {
    const { installer, directory, urls } = fixture({ handshake });
    await assert.rejects(installer.install(), { code: 'GROK_PROCESS_REAP_FAILED' });
    assert.equal(existsSync(join(directory, 'active.json')), false);
    assert.equal(readdirSync(directory).filter(name => name.startsWith(VERSION + '-')).length, 1);
    assert.equal(existsSync(join(directory, '.install.lock')), true, 'an exited:false result is not exit proof');
    const requests = urls.length;
    await assert.rejects(installer.install(), { code: 'GROK_INSTALL_BUSY' });
    assert.equal(urls.length, requests);
  });
}
for (const point of ['inspect', 'handshake']) {
  test(`real ${point} preflight failure cleans its candidate and permits another attempt`, async () => {
    const f = fixture({
      inspect: point === 'inspect' ? inspectGrokProgram : undefined,
      handshake: point === 'handshake' ? options => runMcpSearch({ ...options,
        request: { query: 'offline-handshake-not-sent' }, handshakeOnly: true, remainingMs: () => 5_000,
        sdkFactory: async () => ({}),
      }) : undefined,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.installer.install(), error =>
        error.code === (point === 'inspect' ? 'GROK_PROGRAM_NOT_NATIVE' : 'GROK_SDK_UNSUPPORTED')
        && error.diagnostic?.exited === true);
      assert.deepEqual(readdirSync(f.directory), [], 'a known pre-spawn failure owns no process or cache lock');
    }
    assert.equal(f.versions.length, 2);
  });
}

for (const point of ['inspect', 'handshake']) {
  test(`real ${point} spawn failure owns no child and cannot retain the installation lock`, async () => {
    const f = fixture({
      archive: tar([{ name: 'package/package.json', body: JSON.stringify(manifest) },
        { name: 'package/bin/grok-search-rs.exe', body: Buffer.from('4d5a0000', 'hex') }]),
      inspect: point === 'inspect' ? inspectGrokProgram : undefined,
      handshake: point === 'handshake' ? probeMcpHandshake : undefined,
    });
    const spawn = childProcess.spawn, children = [];
    const cause = Object.assign(new Error('synthetic validator spawn denial'), { code: 'EACCES' });
    childProcess.spawn = () => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
        stderr: new PassThrough(), kill: () => assert.fail('No child exists to terminate.') });
      children.push(child);
      queueMicrotask(() => { child.emit('error', cause); child.emit('close', -1, null); });
      return child;
    };
    syncBuiltinESMExports();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(f.installer.install(), error => point === 'inspect'
          ? error.code === 'GROK_CACHE_ACCESS_DENIED' && error.cause === cause
          : error.code === 'GROK_PROCESS_ERROR' && error.diagnostic?.exited === true
            && error.diagnostic.childPid === null);
        assert.deepEqual(readdirSync(f.directory), [], 'confirmed spawn failure permits retry without a stale guard');
      }
      assert.equal(children.length, 2);
    } finally {
      childProcess.spawn = spawn;
      syncBuiltinESMExports();
      for (const child of children) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
    }
  });
}

test('cancellation after inspection stops before the real handshake preflight and cleans the candidate', async () => {
  const controller = new AbortController(), reason = new GrokSearchError('GROK_SEARCH_STOPPING', 'cancel before handshake');
  let handshakes = 0;
  const f = fixture({ inspect: async path => {
    controller.abort(reason);
    return { path, version: VERSION, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  }, handshake: options => { handshakes++; return probeMcpHandshake(options); } });
  await assert.rejects(f.installer.install({ signal: controller.signal }), error => error === reason);
  assert.equal(handshakes, 0);
  assert.deepEqual(readdirSync(f.directory), [], 'the completed inspection owns no live validation process');
});

for (const point of ['inspect', 'handshake']) {
  test(`an unreaped ${point} keeps its installation lock until actual exit`, async () => {
    let resolveExit, failValidation = true;
    const whenExited = new Promise(resolve => { resolveExit = resolve; });
    const code = point === 'inspect' ? 'GROK_PROGRAM_REAP_FAILED' : 'GROK_PROCESS_REAP_FAILED';
    const failure = new GrokSearchError(code, 'validation process is still running');
    Object.defineProperty(failure, 'whenExited', { value: whenExited });
    Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
    const f = fixture({
      inspect: point === 'inspect' ? async path => {
        if (failValidation) throw failure;
        return { path, version: VERSION, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
      } : undefined,
      handshake: async () => {
        if (point === 'handshake' && failValidation) throw failure;
        return { version: VERSION, toolsDeclared: true, exited: true };
      },
    });
    const lock = join(f.directory, '.install.lock');
    try {
      await assert.rejects(f.installer.install(), error => error === failure);
      assert.equal(existsSync(lock), true, 'a rejected validation is not permission for another installer');
      const urls = f.urls.length;
      await assert.rejects(f.installer.install(), { code: 'GROK_INSTALL_BUSY' });
      assert.equal(f.urls.length, urls, 'the next attempt cannot download before the previous validation exits');
      assert.equal(existsSync(join(f.directory, 'active.json')), false);
      assert.equal(existsSync(f.versions[0]), true, 'the live validator keeps its candidate bytes');
      resolveExit();
      await whenExited;
      assert.equal(existsSync(lock), false);
      assert.equal(existsSync(f.versions[0]), false, 'confirmed late exit cleans only this incomplete candidate');
      assert.equal(existsSync(dirname(f.versions[0])), false);
      failValidation = false;
      assert.equal((await f.installer.install()).version, VERSION);
    } finally { resolveExit(); await whenExited; }
  });
}

test('a late validator exit cannot remove a replacement installation lock', async () => {
  let resolveExit, replacement;
  const whenExited = new Promise(resolve => { resolveExit = resolve; });
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'validator still owns its process');
  Object.defineProperty(failure, 'whenExited', { value: whenExited });
  Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
  const f = fixture({ handshake: async () => { throw failure; } });
  const path = join(f.directory, '.install.lock');
  try {
    await assert.rejects(f.installer.install(), error => error === failure);
    assert.equal(existsSync(path), true);
    unlinkSync(path);
    replacement = acquireOwnedLock(path);
    const before = readFileSync(path);
    resolveExit();
    await whenExited;
    assert.deepEqual(readFileSync(path), before);
    const urls = f.urls.length;
    await assert.rejects(f.installer.install(), { code: 'GROK_INSTALL_BUSY' });
    assert.equal(f.urls.length, urls);
  } finally { resolveExit(); await whenExited; replacement?.release(); }
});

for (const replacement of ['file', 'content', 'directory', 'cache']) {
  test(`late validator cleanup preserves a replaced candidate ${replacement}`, async () => {
    let resolveExit, successor;
    const whenExited = new Promise(resolve => { resolveExit = resolve; });
    const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'validator has not exited');
    Object.defineProperty(failure, 'whenExited', { value: whenExited });
    Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
    let alias, previousCache, nextCache;
    if (replacement === 'cache') {
      const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-installer-alias-'));
      const previous = join(root, 'previous'), next = join(root, 'next');
      mkdirSync(previous); mkdirSync(next);
      alias = join(root, 'selected');
      symlinkSync(previous, alias, process.platform === 'win32' ? 'junction' : 'dir');
      previousCache = join(previous, 'cache'); nextCache = join(next, 'cache');
      mkdirSync(nextCache);
    }
    const f = fixture({ handshake: async () => { throw failure; },
      directory: alias ? join(alias, 'cache') : undefined });
    try {
      await assert.rejects(f.installer.install(), error => error === failure);
      const path = f.versions[0], folder = dirname(path), original = readFileSync(path);
      if (replacement === 'file') {
        fs.renameSync(path, path + '.retained');
        writeFileSync(path, original);
      } else if (replacement === 'content') {
        writeFileSync(path, 'replacement-content-at-the-same-inode');
      } else if (replacement === 'directory') {
        const retained = folder + '-retained';
        fs.renameSync(folder, retained);
        mkdirSync(folder);
        fs.renameSync(join(retained, basename(path)), path);
      } else {
        fs.renameSync(join(previousCache, basename(folder)), join(nextCache, basename(folder)));
        unlinkSync(alias);
        symlinkSync(dirname(nextCache), alias, process.platform === 'win32' ? 'junction' : 'dir');
        successor = acquireOwnedLock(join(f.directory, '.install.lock'));
      }
      const before = readFileSync(path);
      const lock = join(f.directory, '.install.lock'), lockBytes = successor ? readFileSync(lock) : null;
      resolveExit();
      await whenExited;
      assert.deepEqual(readFileSync(path), before);
      assert.equal(existsSync(folder), true);
      if (successor) {
        assert.deepEqual(readFileSync(lock), lockBytes);
        assert.equal(existsSync(join(previousCache, '.install.lock')), true, 'a retargeted path cannot unlink the original lock');
      } else assert.equal(existsSync(lock), false);
    } finally { resolveExit(); await whenExited; successor?.release(); }
  });
}

test('late validator cleanup removes only its candidate while preserving the old active and unknown files', async () => {
  let resolveExit, failValidation = false;
  const whenExited = new Promise(resolve => { resolveExit = resolve; });
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'validator has not exited');
  Object.defineProperty(failure, 'whenExited', { value: whenExited });
  Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
  const f = fixture({ handshake: async () => {
    if (failValidation) throw failure;
    return { version: VERSION, toolsDeclared: true, exited: true };
  } });
  const installed = await f.installer.install(), active = readFileSync(join(f.directory, 'active.json'));
  const original = readFileSync(installed.path);
  failValidation = true;
  try {
    await assert.rejects(f.installer.install(), error => error === failure);
    const candidate = f.versions.at(-1), unknown = join(dirname(candidate), 'unknown.txt');
    writeFileSync(unknown, 'not-created-by-this-installer');
    resolveExit();
    await whenExited;
    assert.equal(existsSync(candidate), false);
    assert.equal(readFileSync(unknown, 'utf8'), 'not-created-by-this-installer');
    assert.deepEqual(readFileSync(join(f.directory, 'active.json')), active);
    assert.deepEqual(readFileSync(installed.path), original);
    assert.equal(existsSync(join(f.directory, '.install.lock')), false);
  } finally { resolveExit(); await whenExited; }
});

test('late validator cleanup accepts an unchanged ancestor directory alias', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-installer-alias-cleanup-'));
  const physical = join(root, 'physical'), alias = join(root, 'selected');
  mkdirSync(physical);
  symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let resolveExit;
  const whenExited = new Promise(resolve => { resolveExit = resolve; });
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'validator has not exited');
  Object.defineProperty(failure, 'whenExited', { value: whenExited });
  Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
  const f = fixture({ directory: join(alias, 'cache'), handshake: async () => { throw failure; } });
  try {
    await assert.rejects(f.installer.install(), error => error === failure);
    const path = f.versions[0];
    assert.equal(existsSync(path), true);
    resolveExit();
    await whenExited;
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(join(physical, 'cache')), []);
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  } finally { resolveExit(); await whenExited; }
});

test('late validator cleanup preserves a candidate selected by the current active record', async () => {
  let resolveExit;
  const whenExited = new Promise(resolve => { resolveExit = resolve; });
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'validator has not exited');
  Object.defineProperty(failure, 'whenExited', { value: whenExited });
  Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
  const f = fixture({ handshake: async () => { throw failure; } });
  try {
    await assert.rejects(f.installer.install(), error => error === failure);
    const path = f.versions[0], before = readFileSync(path);
    const active = JSON.stringify({ executable: `${basename(dirname(path))}/${basename(path)}` });
    writeFileSync(join(f.directory, 'active.json'), active);
    resolveExit();
    await whenExited;
    assert.deepEqual(readFileSync(path), before);
    assert.equal(readFileSync(join(f.directory, 'active.json'), 'utf8'), active);
    assert.equal(existsSync(join(f.directory, '.install.lock')), false);
  } finally { resolveExit(); await whenExited; }
});

test('late lock release absorbs an unlink failure without rejecting deferred cleanup', async () => {
  let resolveExit, releaseAttempts = 0;
  const whenExited = new Promise(resolve => { resolveExit = resolve; });
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'validator has not exited');
  Object.defineProperty(failure, 'whenExited', { value: whenExited });
  Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
  const f = fixture({ handshake: async () => { throw failure; } });
  await assert.rejects(f.installer.install(), error => error === failure);
  const path = join(f.directory, '.install.lock'), unlink = fs.unlinkSync, before = readFileSync(path);
  fs.unlinkSync = target => {
    if (target === path) { releaseAttempts++; throw Object.assign(new Error('synthetic lock unlink failure'), { code: 'EACCES' }); }
    return unlink(target);
  };
  syncBuiltinESMExports();
  try {
    resolveExit();
    await whenExited;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releaseAttempts, 1);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(f.versions[0]), false);
  } finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); resolveExit(); await whenExited; }
});

for (const point of ['completed-install', 'late-validator-exit']) {
  test(`explicit installation retry releases its own transiently blocked guard (${point})`, async () => {
    let resolveExit, failValidation = point === 'late-validator-exit', releaseAttempts = 0;
    const whenExited = new Promise(resolve => { resolveExit = resolve; });
    const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'validator has not exited');
    Object.defineProperty(failure, 'whenExited', { value: whenExited });
    Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
    const f = fixture({ handshake: async () => {
      if (failValidation) throw failure;
      return { version: VERSION, toolsDeclared: true, exited: true };
    } });
    const path = join(f.directory, '.install.lock'), unlink = fs.unlinkSync;
    fs.unlinkSync = target => {
      if (target === path && ++releaseAttempts === 1) {
        throw Object.assign(new Error('synthetic transient lock unlink failure'), { code: 'EACCES' });
      }
      return unlink(target);
    };
    syncBuiltinESMExports();
    try {
      if (failValidation) {
        await assert.rejects(f.installer.install(), error => error === failure);
        const requests = f.urls.length;
        await assert.rejects(f.installer.install(), { code: 'GROK_INSTALL_BUSY' });
        assert.equal(f.urls.length, requests, 'no retry may bypass a live validator');
        assert.equal(releaseAttempts, 0);
        resolveExit();
        await whenExited;
        await new Promise(resolve => setImmediate(resolve));
        failValidation = false;
      } else {
        assert.equal((await f.installer.install()).version, VERSION);
      }
      assert.equal(releaseAttempts, 1, 'the failed release does not start a background retry loop');
      const before = readFileSync(path);
      assert.equal(JSON.parse(before).pid, process.pid);
      assert.equal((await f.installer.install()).version, VERSION, 'an explicit retry need not wait for the parent PID to exit');
      assert.ok(releaseAttempts >= 2);
      assert.equal(existsSync(path), false);
      assert.equal((await f.installer.active()).version, VERSION);
    } finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); resolveExit(); await whenExited; }
  });
}

test('a real controller retry recovers a proven validator exit followed by transient lock failure', async () => {
  let resolveExit, failValidation = true, releaseAttempts = 0;
  const whenExited = new Promise(resolve => { resolveExit = resolve; });
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'validator has not exited');
  Object.defineProperty(failure, 'whenExited', { value: whenExited });
  Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
  const f = fixture({ handshake: async () => {
    if (failValidation) throw failure;
    return { version: VERSION, toolsDeclared: true, exited: true };
  } });
  const configuration = { configPath: join(f.directory, 'shared-config.toml') };
  writeFileSync(configuration.configPath, 'config-fixture-not-a-real-key');
  const configBytes = readFileSync(configuration.configPath);
  const manager = createProgramController({ configuration, directory: f.directory, installer: f.installer,
    resolveProgram: ({ signal, installer }) => installer.install({ signal }) });
  const lockPath = join(f.directory, '.install.lock'), unlink = fs.unlinkSync;
  fs.unlinkSync = target => {
    if (target === lockPath && ++releaseAttempts === 1) {
      throw Object.assign(new Error('synthetic transient lock unlink failure'), { code: 'EPERM' });
    }
    return unlink(target);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(manager.prepare(), error => error === failure);
    const requests = f.urls.length;
    await assert.rejects(manager.prepare(), error => error === failure);
    assert.equal(f.urls.length, requests, 'a controller recheck must respect pending exit ownership');
    resolveExit();
    await whenExited;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.snapshot().phase, 'error', 'process exit alone is not program readiness');
    assert.equal(existsSync(lockPath), true);
    failValidation = false;
    const first = manager.prepare(), second = manager.prepare();
    assert.equal(first, second, 'overlapping explicit rechecks remain deduplicated');
    assert.equal((await first).phase, 'ready');
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(readFileSync(configuration.configPath), configBytes);
    assert.equal(manager.execution().executable, f.versions.at(-1));
  } finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); resolveExit(); await whenExited; await manager.dispose(); }
});

for (const replacement of ['new-owner', 'changed-bytes', 'linked-cache']) {
  test(`explicit installation retry cannot release a retained guard through ${replacement}`, async () => {
    const f = fixture(), lockPath = join(f.directory, '.install.lock'), unlink = fs.unlinkSync;
    let releaseAttempts = 0, successor = null, linked = false;
    fs.unlinkSync = target => {
      if (target === lockPath && ++releaseAttempts === 1) {
        throw Object.assign(new Error('synthetic transient lock unlink failure'), { code: 'EBUSY' });
      }
      return unlink(target);
    };
    syncBuiltinESMExports();
    try {
      await f.installer.install();
      const original = readFileSync(lockPath), requests = f.urls.length;
      let expected;
      if (replacement === 'new-owner') {
        unlink(lockPath);
        successor = acquireOwnedLock(lockPath);
        expected = readFileSync(lockPath);
      } else if (replacement === 'changed-bytes') {
        expected = Buffer.from(original.toString().replace(/\n$/, ' '));
        writeFileSync(lockPath, expected);
      } else {
        const relocated = f.directory + '-original';
        fs.renameSync(f.directory, relocated);
        symlinkSync(relocated, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
        linked = true;
        expected = original;
      }
      await assert.rejects(f.installer.install(), { code: replacement === 'linked-cache' ? 'GROK_CACHE_PATH_INVALID' : 'GROK_INSTALL_BUSY' });
      assert.equal(f.urls.length, requests, 'refusal occurs before any download');
      assert.equal(releaseAttempts, 1, 'the retained receipt cannot unlink another owner or follow a cache link');
      assert.deepEqual(readFileSync(lockPath), expected);
    } finally {
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
      successor?.release();
      if (linked) {
        if (process.platform === 'win32') fs.rmdirSync(f.directory);
        else fs.unlinkSync(f.directory);
      }
    }
  });
}

test('late old validation cannot replace a newer installation guard awaiting release retry', async () => {
  let resolveExit, firstValidation = true, releaseAttempts = 0;
  const whenExited = new Promise(resolve => { resolveExit = resolve; });
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'old validator has not exited');
  Object.defineProperty(failure, 'whenExited', { value: whenExited });
  Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
  const f = fixture({ handshake: async () => {
    if (firstValidation) { firstValidation = false; throw failure; }
    return { version: VERSION, toolsDeclared: true, exited: true };
  } });
  const lockPath = join(f.directory, '.install.lock'), unlink = fs.unlinkSync;
  try {
    await assert.rejects(f.installer.install(), error => error === failure);
    // Simulate this test's interrupted guard being moved by another cache owner.
    fs.renameSync(lockPath, lockPath + '.old');
    fs.unlinkSync = target => {
      if (target === lockPath && ++releaseAttempts === 1) {
        throw Object.assign(new Error('synthetic transient newer lock unlink failure'), { code: 'EACCES' });
      }
      return unlink(target);
    };
    syncBuiltinESMExports();
    const current = await f.installer.install(), activeBytes = readFileSync(join(f.directory, 'active.json'));
    const successorBytes = readFileSync(lockPath);
    resolveExit();
    await whenExited;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(readFileSync(lockPath), successorBytes, 'the old validator must not unlink the successor');
    assert.deepEqual(readFileSync(join(f.directory, 'active.json')), activeBytes);
    assert.equal(existsSync(current.path), true);
    assert.equal((await f.installer.install()).version, VERSION, 'the old callback must not discard the newer retry receipt');
    assert.equal(existsSync(lockPath), false);
  } finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); resolveExit(); await whenExited; }
});

test('a rejected validator exit proof never releases the installation lock', async () => {
  let rejectExit;
  const whenExited = new Promise((_, reject) => { rejectExit = reject; });
  whenExited.catch(() => {});
  const failure = new GrokSearchError('GROK_PROCESS_REAP_FAILED', 'validator exit is unproven');
  Object.defineProperty(failure, 'whenExited', { value: whenExited });
  Object.defineProperty(failure, 'diagnostic', { value: { exited: false } });
  const f = fixture({ handshake: async () => { throw failure; } });
  await assert.rejects(f.installer.install(), error => error === failure);
  const path = join(f.directory, '.install.lock'), before = readFileSync(path), urls = f.urls.length;
  rejectExit(new Error('exit observer failed'));
  await whenExited.catch(() => {});
  assert.deepEqual(readFileSync(path), before);
  await assert.rejects(f.installer.install(), { code: 'GROK_INSTALL_BUSY' });
  assert.equal(f.urls.length, urls);
});

test('binary mutation during the official backend handshake cannot replace an existing active record', async () => {
  let mutate = false;
  const { installer, directory } = fixture({ handshake: async ({ executable }) => {
    if (mutate) writeFileSync(executable, 'changed-during-handshake');
    return { version: VERSION, toolsDeclared: true, exited: true };
  } });
  const installed = await installer.install();
  const record = readFileSync(join(directory, 'active.json'));
  const bytes = readFileSync(installed.path);
  mutate = true;
  await assert.rejects(installer.install(), { code: 'GROK_PROGRAM_CHANGED' });
  assert.deepEqual(readFileSync(join(directory, 'active.json')), record);
  assert.deepEqual(readFileSync(installed.path), bytes);
  assert.equal(existsSync(join(directory, '.install.lock')), false);
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

for (const code of ['EACCES', 'EPERM']) test(`existing cache ${code} access denial disables controller repair without changing the cache`, async () => {
  const { installer, directory } = fixture();
  const installed = await installer.install();
  const binary = realpathSync(installed.path), recordPath = join(directory, 'active.json');
  const binaryBytes = readFileSync(binary), recordBytes = readFileSync(recordPath);
  const before = fs.statSync(binary), names = readdirSync(directory).sort();
  const cause = Object.assign(new Error('synthetic-private-cache-access'), { code, path: binary });
  const originalAccess = fs.accessSync, originalSpawn = childProcess.spawn;
  let accesses = 0, spawns = 0, downloads = 0;
  const checking = createPrivateProgramInstaller({ directory, platform: 'win32', arch: 'x64',
    fetchImpl: async () => { downloads++; assert.fail('Access denial must not download another program.'); } });
  const manager = createProgramController({ directory, installer: checking, configuration: {},
    env: () => ({ HOME: directory, USERPROFILE: directory, CARGO_HOME: join(directory, 'cargo'), PATH: '' }) });
  const denied = error => {
    assert.equal(error.code, 'GROK_CACHE_ACCESS_DENIED');
    assert.equal(error.cause, cause);
    assert.equal(Object.getOwnPropertyDescriptor(error, 'cause').enumerable, false);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(error)), 'cause'), false);
    assert.equal(error.message.includes('synthetic-private-cache-access'), false);
    return true;
  };
  fs.accessSync = (path, mode) => {
    if (path !== binary) return originalAccess(path, mode);
    accesses++;
    throw cause;
  };
  childProcess.spawn = () => { spawns++; assert.fail('Access denial must stop before spawn.'); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(checking.active(), denied);
    await assert.rejects(manager.prepare(), denied);
    assert.equal(manager.snapshot().canRepair, false);
    assert.equal(manager.snapshot().error.code, 'GROK_CACHE_ACCESS_DENIED');
    assert.equal(JSON.stringify(manager.snapshot()).includes('synthetic-private-cache-access'), false);
    await assert.rejects(manager.repair(), { code: 'GROK_CACHE_REPAIR_UNAVAILABLE' });
    await assert.rejects(checking.repair(), denied);
    assert.equal(accesses, 3);
    assert.equal(spawns, 0);
    assert.equal(downloads, 0);
    assert.deepEqual(readFileSync(binary), binaryBytes);
    assert.deepEqual(readFileSync(recordPath), recordBytes);
    assert.deepEqual(readdirSync(directory).sort(), names);
    assert.equal(fs.statSync(binary).ino, before.ino);
    assert.equal(fs.statSync(binary).mode, before.mode);
  } finally {
    fs.accessSync = originalAccess;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    await manager.dispose();
  }
});

for (const code of ['EACCES', 'EPERM']) {
  test(`readable private cache with ${code} spawn denial preserves bytes and disables repair`, async () => {
    const { installer, directory } = fixture();
    const installed = await installer.install(), binaryBytes = readFileSync(installed.path);
    const recordPath = join(directory, 'active.json'), recordBytes = readFileSync(recordPath);
    writeFileSync(installed.path, Buffer.from('4d5a0000', 'hex'));
    const record = JSON.parse(recordBytes);
    record.sha256 = createHash('sha256').update(readFileSync(installed.path)).digest('hex');
    writeFileSync(recordPath, JSON.stringify(record));
    const originalSpawn = childProcess.spawn, children = [];
    const cause = Object.assign(new Error('synthetic-private-spawn-denial'), { code });
    let downloads = 0;
    const checking = createPrivateProgramInstaller({ directory, platform: 'win32', arch: 'x64',
      fetchImpl: async () => { downloads++; assert.fail('Permission failure must not download.'); } });
    const manager = createProgramController({ directory, installer: checking, configuration: {},
      env: () => ({ HOME: directory, USERPROFILE: directory, PATH: '' }) });
    const beforeBinary = readFileSync(installed.path), beforeRecord = readFileSync(recordPath);
    childProcess.spawn = () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(child);
      queueMicrotask(() => { child.emit('error', cause); child.emit('close', -1, null); });
      return child;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(manager.prepare(), error => {
        assert.equal(error.code, 'GROK_CACHE_ACCESS_DENIED');
        assert.equal(error.cause, cause);
        return true;
      });
      assert.equal(manager.snapshot().canRepair, false);
      await assert.rejects(manager.repair(), { code: 'GROK_CACHE_REPAIR_UNAVAILABLE' });
      assert.equal(downloads, 0);
      assert.deepEqual(readFileSync(installed.path), beforeBinary);
      assert.deepEqual(readFileSync(recordPath), beforeRecord);
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
      await manager.dispose();
      writeFileSync(installed.path, binaryBytes);
      writeFileSync(recordPath, recordBytes);
    }
  });
}

for (const code of ['EACCES', 'EPERM']) {
  test(`newly downloaded program with ${code} execution denial reports permissions and disables repair`, async () => {
    const cause = Object.assign(new Error('synthetic-private-first-execution-denial'), { code });
    const failure = new GrokSearchError('GROK_PROGRAM_START_FAILED', 'version process could not start');
    Object.defineProperty(failure, 'cause', { value: cause });
    Object.defineProperty(failure, 'diagnostic', { value: Object.freeze({ exited: true }) });
    const { installer, directory, versions } = fixture({ inspect: async () => { throw failure; } });
    const manager = createProgramController({ directory, installer, configuration: {},
      env: () => ({ HOME: directory, USERPROFILE: directory, CARGO_HOME: join(directory, 'cargo'), PATH: '' }) });
    try {
      await assert.rejects(manager.prepare(), error => {
        assert.equal(error.code, 'GROK_CACHE_ACCESS_DENIED');
        assert.equal(error.cause, cause);
        assert.equal(JSON.stringify(error).includes('synthetic-private-first-execution-denial'), false);
        return true;
      });
      assert.equal(manager.snapshot().canRepair, false);
      assert.equal(versions.length, 1);
      assert.equal(existsSync(versions[0]), false, 'confirmed spawn failure cleans only its incomplete install');
      assert.deepEqual(readdirSync(directory), []);
      await assert.rejects(manager.repair(), { code: 'GROK_CACHE_REPAIR_UNAVAILABLE' });
      assert.equal(versions.length, 1);
    } finally { await manager.dispose(); }
  });
}

for (const code of ['EACCES', 'EPERM']) for (const stage of ['root', 'binary', 'activation']) {
  test(`cache repair ${stage} ${code} preserves the old record and disables futile repair`, async () => {
    const { installer, directory } = fixture();
    const before = damagedCache(directory), recordPath = join(directory, 'active.json');
    const manager = createProgramController({ directory, installer, configuration: {},
      env: () => ({ HOME: directory, USERPROFILE: directory, CARGO_HOME: join(directory, 'cargo'), PATH: '' }) });
    await assert.rejects(manager.prepare(), { code: 'GROK_CACHE_DAMAGED' });
    assert.equal(manager.snapshot().canRepair, true);
    const operation = { root: 'mkdirSync', binary: 'openSync', activation: 'renameSync' }[stage];
    const original = fs[operation];
    const cause = Object.assign(new Error('synthetic-private-cache-write-denial'), { code });
    let hits = 0;
    fs[operation] = (...args) => {
      const matches = stage === 'root' ? args[0] === directory
        : stage === 'binary' ? String(args[0]).endsWith('grok-search-rs.exe') : args[1] === recordPath;
      if (matches) { hits++; throw cause; }
      return original(...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(manager.repair(), error => {
        assert.equal(error.code, 'GROK_CACHE_ACCESS_DENIED');
        assert.equal(error.cause, cause);
        assert.equal(JSON.stringify(error).includes('synthetic-private-cache-write-denial'), false);
        return true;
      });
      assert.equal(hits, 1);
      assert.equal(manager.snapshot().canRepair, false);
      await assert.rejects(manager.repair(), { code: 'GROK_CACHE_REPAIR_UNAVAILABLE' });
      assert.equal(hits, 1);
      assert.equal(readFileSync(recordPath, 'utf8'), before);
      assert.equal(readFileSync(join(directory, 'damaged', 'grok-search-rs.exe'), 'utf8'), 'damaged-never-executed');
    } finally {
      fs[operation] = original;
      syncBuiltinESMExports();
      await manager.dispose();
    }
  });
}

test('cancelled verification cannot report a cached or configured program as successfully selected', async t => {
  const { directory, installer } = fixture();
  const installed = await installer.install();
  const active = readFileSync(join(directory, 'active.json'));
  for (const selection of ['cached', 'configured']) await t.test(selection, async () => {
    const controller = new AbortController(), reason = new Error('cancel selection');
    const inspect = async () => { controller.abort(reason); return installed; };
    const checking = createPrivateProgramInstaller({ directory, platform: 'win32', arch: 'x64', inspect,
      fetchImpl: async () => assert.fail('selection must not initiate a download') });
    const result = selection === 'cached' ? checking.active({ signal: controller.signal })
      : resolveGrokProgram({ configured: installed.path, platform: 'win32', arch: 'x64', signal: controller.signal, inspect, installer: checking });
    await assert.rejects(result, error => error === reason);
    assert.deepEqual(readFileSync(join(directory, 'active.json')), active);
  });
});

test('cache inspection preserves an unreaped verification failure over caller cancellation', async () => {
  const { installer, directory } = fixture();
  await installer.install();
  const controller = new AbortController(), reason = new Error('cancel cache inspection');
  const failure = new GrokSearchError('GROK_PROGRAM_REAP_FAILED', 'Unproven verification exit.');
  const checking = createPrivateProgramInstaller({ directory, platform: 'win32', arch: 'x64',
    fetchImpl: async () => assert.fail('cached inspection must not download'),
    inspect: async () => { controller.abort(reason); throw failure; } });
  await assert.rejects(checking.active({ signal: controller.signal }), caught => caught === failure);
});
for (const [code, exited] of [
  ['GROK_PROGRAM_CHANGED', undefined], ['GROK_PROGRAM_CHANGED', false],
  ['GROK_PROGRAM_IDENTITY_INVALID', false], ['GROK_PROGRAM_TIMEOUT', undefined],
  ['GROK_PROGRAM_REAP_FAILED', false], ['GROK_PROCESS_REAP_FAILED', false],
]) {
  test(`cache repair requires confirmed inspection exit for a changed program (${code}, ${exited})`, async () => {
    const { installer, directory } = fixture();
    const installed = await installer.install();
    const record = readFileSync(join(directory, 'active.json')), binary = readFileSync(installed.path);
    const names = readdirSync(directory).sort();
    const failure = new GrokSearchError(code, 'inspection exit is unconfirmed');
    if (exited !== undefined) Object.defineProperty(failure, 'diagnostic', { value: Object.freeze({ exited }) });
    const checking = createPrivateProgramInstaller({ directory, platform: 'win32', arch: 'x64',
      fetchImpl: async () => assert.fail('unconfirmed inspection exit must not start another installation'),
      inspect: async () => { throw failure; } });
    await assert.rejects(checking.repair(), error => error === failure);
    assert.deepEqual(readdirSync(directory).sort(), names);
    assert.deepEqual(readFileSync(join(directory, 'active.json')), record);
    assert.deepEqual(readFileSync(installed.path), binary);
  });
}

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
test('explicit repair of an unusable cached program succeeds after a confirmed validator exit', async t => {
  for (const code of ['GROK_PROGRAM_IDENTITY_INVALID', 'GROK_PROGRAM_TIMEOUT']) await t.test(code, async () => {
    let oldPath;
    const failure = Object.assign(new GrokSearchError(code, 'fixture validation failed'), { diagnostic: { exited: true } });
    const { installer, directory, urls } = fixture({ inspect: async path => {
      if (path === oldPath) throw failure;
      return { path, version: VERSION, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    } });
    oldPath = (await installer.install()).path;
    const oldBytes = readFileSync(oldPath);
    const manager = createProgramController({ directory, installer, configuration: {},
      env: () => ({ HOME: directory, USERPROFILE: directory, CARGO_HOME: join(directory, 'cargo'), PATH: '' }) });
    try {
      await assert.rejects(manager.prepare(), { code });
      assert.equal(manager.snapshot().canRepair, true);
      assert.equal(urls.length, 2);
      const repaired = await manager.repair();
      assert.equal(repaired.phase, 'ready');
      assert.notEqual(repaired.program.path, oldPath);
      assert.deepEqual(readFileSync(oldPath), oldBytes);
    } finally { await manager.dispose(); }
  });
});

test('explicit controller repair recovers content changed during active inspection and preserves the old directory', async () => {
  let activePath;
  let changes = 0;
  const failure = new GrokSearchError('GROK_PROGRAM_CHANGED', 'content changed during inspection');
  Object.defineProperty(failure, 'diagnostic', { value: Object.freeze({ exited: true }) });
  const { installer, directory, urls } = fixture({ inspect: async path => {
    if (path === activePath) {
      changes++;
      writeFileSync(path, 'changed-during-version-inspection');
      throw failure;
    }
    return { path, version: VERSION, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  } });
  activePath = (await installer.install()).path;
  const active = readFileSync(join(directory, 'active.json')), binary = readFileSync(activePath);
  const manager = createProgramController({ directory, installer, configuration: {},
    env: () => ({ HOME: directory, USERPROFILE: directory, CARGO_HOME: join(directory, 'cargo'), PATH: '' }) });
  try {
    await assert.rejects(manager.prepare(), error => error === failure);
    assert.equal(manager.snapshot().canRepair, true);
    assert.deepEqual(readFileSync(join(directory, 'active.json')), active);
    assert.equal(urls.length, 2, 'detection must not silently install another program');
    // Restore test-owned bytes so repair itself observes a change during inspection.
    writeFileSync(activePath, binary);
    const recovered = await manager.repair();
    assert.equal(changes, 2);
    assert.equal(recovered.phase, 'ready');
    assert.equal(recovered.canRepair, false);
    assert.notEqual(recovered.program.path, activePath);
    assert.equal(recovered.program.version, VERSION);
    assert.equal(readFileSync(activePath, 'utf8'), 'changed-during-version-inspection');
    assert.equal((await installer.active()).path, recovered.program.path);
    assert.equal(urls.length, 4);
    assert.ok(urls.every(url => !url.endsWith('/latest')));
  } finally { await manager.dispose(); }
});
test('a changed automatically discovered program permits explicit private preparation and is never overwritten', async () => {
  const { installer, directory, urls } = fixture();
  const external = mkdtempSync(join(tmpdir(), 'dsh-changed-discovery-'));
  const binary = join(external, 'grok-search-rs.exe');
  writeFileSync(binary, 'external-program');
  const failure = new GrokSearchError('GROK_PROGRAM_CHANGED', 'external content changed after close');
  Object.defineProperty(failure, 'diagnostic', { value: Object.freeze({ exited: true }) });
  const manager = createProgramController({ directory, installer, configuration: {},
    env: () => ({ HOME: directory, USERPROFILE: directory, CARGO_HOME: join(directory, 'cargo'), PATH: external }),
    resolveProgram: options => resolveGrokProgram({ ...options, platform: 'win32', arch: 'x64', inspect: async path => {
      assert.equal(path, realpathSync(binary));
      writeFileSync(binary, 'external-changed-during-inspection');
      throw failure;
    } }) });
  try {
    await assert.rejects(manager.prepare(), { code: 'GROK_PROGRAM_CHANGED' });
    assert.equal(manager.snapshot().canRepair, true);
    assert.deepEqual(urls, []);
    const recovered = await manager.repair();
    assert.equal(recovered.phase, 'ready');
    assert.equal(recovered.program.source, 'private-cache');
    assert.ok(recovered.program.path.startsWith(directory));
    assert.equal(readFileSync(binary, 'utf8'), 'external-changed-during-inspection');
    assert.equal(urls.length, 2);
  } finally { await manager.dispose(); }
});
for (const selection of ['configured', 'override']) {
  test(`explicit ${selection} program change never consults or overwrites the private cache during repair`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-explicit-changed-'));
    const binary = join(root, 'grok-search-rs.exe');
    writeFileSync(binary, 'explicit-original');
    const failure = new GrokSearchError('GROK_PROGRAM_CHANGED', 'explicit program changed');
    await assert.rejects(resolveGrokProgram({ [selection]: binary, repair: true, platform: 'win32', arch: 'x64',
      inspect: async () => { throw failure; },
      installer: {
        active() { assert.fail('explicit paths must not inspect the private cache'); },
        repair() { assert.fail('explicit paths must not repair the private cache'); },
        install() { assert.fail('explicit paths must not install another program'); },
      } }), error => error === failure);
    assert.equal(readFileSync(binary, 'utf8'), 'explicit-original');
    assert.deepEqual(readdirSync(root), ['grok-search-rs.exe']);
  });
}
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
