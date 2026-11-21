import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgramController } from '../src/program.mjs';
import { createGrokProvider } from '../src/provider.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';
import {
  PROGRAM_CASE_IDS, PROGRAM_VERSION, casePassed, digest, packageFiles, parseProgramArguments, platformArchive,
  programCaseDirectory, tarGzip, validateProgramInputs,
} from '../scripts/lib/compatibility-program-checks.mjs';
import { installProgramFetchBoundary, programEnvironment } from '../scripts/compatibility-program-host.mjs';
import { unpackPlatformArchive, verifyArchiveIntegrity } from '../src/core/program-install.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup(resolveProgram, configuration = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-program-controller-'));
  return createProgramController({ configuration, directory: root, env: () => ({ HOME: root }), resolveProgram });
}
const program = { found: true, path: process.execPath, version: '0.1.26', source: 'test-only', sha256: '0'.repeat(64) };

test('program preparation does not block mounting and provider becomes ready without restart', async () => {
  const gate = deferred();
  const manager = setup(() => gate.promise);
  const core = createGrokProvider({ configuration: {}, executionConfiguration: manager.execution,
    runQuery: async config => {
      assert.equal(config.executable, process.execPath);
      return { content: 'ready', sources: [], truncated: false };
    } });
  try {
    const preparing = manager.prepare();
    assert.equal(core.provider.available(), false);
    assert.equal(manager.snapshot().phase, 'discovering');
    await assert.rejects(core.provider.search({ query: 'early' }), error => error.code === 'GROK_PROGRAM_PREPARING');
    gate.resolve(program);
    await preparing;
    assert.equal(core.provider.available(), true);
    assert.equal(manager.snapshot().phase, 'ready');
    assert.equal((await core.provider.search({ query: 'late' })).content, 'ready');
  } finally { await Promise.all([manager.dispose(), core.dispose()]); }
});
test('preparation failure stays explicit and retry is not a fabricated ready state', async () => {
  let calls = 0;
  const manager = setup(async () => { if (calls++ === 0) throw new GrokSearchError('GROK_DOWNLOAD_UNAVAILABLE', 'offline'); return program; });
  await assert.rejects(manager.prepare(), error => error.code === 'GROK_DOWNLOAD_UNAVAILABLE');
  assert.equal(manager.snapshot().phase, 'error');
  assert.throws(manager.execution, error => error.code === 'GROK_DOWNLOAD_UNAVAILABLE');
  await manager.prepare();
  assert.equal(manager.snapshot().phase, 'ready');
  await manager.dispose();
});
test('simultaneous prepare requests share one discovery or download operation', async () => {
  const gate = deferred(); let calls = 0;
  const manager = setup(() => { calls++; return gate.promise; });
  const first = manager.prepare(), second = manager.prepare();
  gate.resolve(program);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  await manager.dispose();
});
test('disposed controller cannot be revived by a late preparation result', async () => {
  const gate = deferred();
  const manager = setup(() => gate.promise);
  const rejection = assert.rejects(manager.prepare(), error => error.code === 'GROK_SEARCH_STOPPING');
  const disposal = manager.dispose();
  gate.resolve(program);
  await Promise.all([rejection, disposal]);
  assert.equal(manager.snapshot().phase, 'disposed');
  assert.throws(manager.execution, error => error.code === 'GROK_SEARCH_STOPPING');
});
test('unreaped verification process prevents retry from launching a replacement', async () => {
  let calls = 0;
  const manager = setup(async () => { calls++; throw new GrokSearchError('GROK_PROGRAM_REAP_FAILED', 'not reaped'); });
  await assert.rejects(manager.prepare());
  await assert.rejects(manager.prepare());
  assert.equal(calls, 1);
  await manager.dispose();
});

test('cache recovery is explicit, deduplicated and remains retryable after a failed download', async () => {
  const attempts = [];
  const manager = setup(async ({ repair }) => {
    attempts.push(repair);
    if (!repair) throw new GrokSearchError('GROK_CACHE_DAMAGED', 'damaged');
    if (attempts.length === 2) throw new GrokSearchError('GROK_DOWNLOAD_HTTP', 'offline');
    return program;
  });
  try {
    await assert.rejects(manager.repair(), { code: 'GROK_CACHE_REPAIR_UNAVAILABLE' });
    await assert.rejects(manager.prepare(), { code: 'GROK_CACHE_DAMAGED' });
    assert.equal(manager.snapshot().canRepair, true);
    await assert.rejects(manager.repair(), { code: 'GROK_DOWNLOAD_HTTP' });
    assert.equal(manager.snapshot().canRepair, true);
    await Promise.all([manager.repair(), manager.repair()]);
    assert.deepEqual(attempts, [false, true, true]);
    assert.equal(manager.snapshot().phase, 'ready');
    assert.equal(manager.snapshot().canRepair, false);
    assert.equal(manager.execution().executable, program.path);
  } finally { await manager.dispose(); }
});
test('an unpinned program change enables explicit repair without silently preparing a replacement', async () => {
  const attempts = [];
  const manager = setup(async ({ repair }) => {
    attempts.push(repair);
    if (!repair) throw new GrokSearchError('GROK_PROGRAM_CHANGED', 'program content changed');
    return program;
  });
  try {
    await assert.rejects(manager.prepare(), { code: 'GROK_PROGRAM_CHANGED' });
    assert.equal(manager.snapshot().canRepair, true);
    assert.deepEqual(attempts, [false]);
    assert.throws(manager.execution, { code: 'GROK_PROGRAM_CHANGED' });
    const recovered = await manager.repair();
    assert.deepEqual(attempts, [false, true]);
    assert.equal(recovered.phase, 'ready');
    assert.equal(recovered.canRepair, false);
  } finally { await manager.dispose(); }
});
for (const code of ['GROK_PROGRAM_CHANGED', 'GROK_CACHE_DAMAGED']) {
  test(`an explicitly configured executable never offers private repair (${code})`, async () => {
    let calls = 0;
    const manager = setup(async () => { calls++; throw new GrokSearchError(code, 'configured program failed'); },
      { executable: process.execPath });
    try {
      await assert.rejects(manager.prepare(), { code });
      assert.equal(manager.snapshot().canRepair, false);
      await assert.rejects(manager.repair(), { code: 'GROK_CACHE_REPAIR_UNAVAILABLE' });
      assert.equal(calls, 1);
    } finally { await manager.dispose(); }
  });
}
for (const code of ['GROK_CACHE_PATH_INVALID', 'GROK_CACHE_ACCESS_DENIED', 'GROK_PROGRAM_REAP_FAILED', 'GROK_PROCESS_REAP_FAILED']) {
  test(`program-change repair stops retrying after a protected failure (${code})`, async () => {
    const failure = new GrokSearchError(code, 'protected repair failure');
    let calls = 0;
    const manager = setup(async ({ repair }) => {
      calls++;
      if (!repair) throw new GrokSearchError('GROK_PROGRAM_CHANGED', 'program content changed');
      throw failure;
    });
    try {
      await assert.rejects(manager.prepare(), { code: 'GROK_PROGRAM_CHANGED' });
      assert.equal(manager.snapshot().canRepair, true);
      await assert.rejects(manager.repair(), error => error === failure);
      assert.equal(manager.snapshot().canRepair, false);
      await assert.rejects(manager.repair(), {
        code: code.endsWith('REAP_FAILED') ? code : 'GROK_CACHE_REPAIR_UNAVAILABLE',
      });
      assert.equal(calls, 2);
    } finally { await manager.dispose(); }
  });
}

test('official program verifier arguments require explicit package and native binary hashes for each case', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-program-verifier-args-'));
  const args = [join(root, 'host'), join(root, 'new-output'), join(root, 'product'), 'a'.repeat(64),
    '--product-package', join(root, 'product.tgz'), '--grok-program', join(root, 'grok-search-rs'),
    '--grok-sha256', 'b'.repeat(64)];
  const parsed = parseProgramArguments(args);
  assert.equal(parsed.caseId, null);
  assert.equal(parsed.productSha256, 'a'.repeat(64));
  assert.equal(parsed.grokSha256, 'b'.repeat(64));
  assert.equal(parseProgramArguments([...args, '--case', PROGRAM_CASE_IDS[1], '--variant', 'disable']).variant, 'disable');
  for (const invalid of [
    args.slice(0, -2), [...args, '--grok-sha256', 'c'.repeat(64)], [...args, '--case', 'unknown'],
    [...args, '--variant', 'dispose'], [...args, '--case', PROGRAM_CASE_IDS[1]],
    [args[0], 'relative', ...args.slice(2)],
    [args[0], args[1], args[2], 'invalid', ...args.slice(4)],
  ]) assert.throws(() => parseProgramArguments(invalid));
  assert.equal(existsSync(parsed.outputRoot), false);
});

test('program verifier validates frozen package bytes and binary before creating any run directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-program-verifier-input-')), product = join(root, 'product');
  mkdirSync(join(product, 'node_modules'), { recursive: true });
  const manifest = Buffer.from(JSON.stringify({ name: 'dsh-grok-search', version: '0.4.0' }));
  const module = Buffer.from('export const fixture = true;\n');
  writeFileSync(join(product, 'package.json'), manifest);
  writeFileSync(join(product, 'fixture.mjs'), module);
  writeFileSync(join(product, 'empty.md'), '');
  const tarball = tarGzip([['package/package.json', manifest], ['package/fixture.mjs', module], ['package/empty.md', '']]);
  const binary = Buffer.from('synthetic bytes are hashed but never executed in this unit test');
  writeFileSync(join(root, 'product.tgz'), tarball); writeFileSync(join(root, 'grok'), binary);
  const input = { hostRoot: join(root, 'host'), outputRoot: join(root, 'not-created'), productDir: product,
    productPackage: join(root, 'product.tgz'), productSha256: digest(tarball),
    grokProgram: join(root, 'grok'), grokSha256: digest(binary) };
  const checked = validateProgramInputs(input);
  assert.equal(checked.manifest.version, '0.4.0');
  assert.equal(checked.files.size, 3);
  assert.equal(existsSync(input.outputRoot), false);
  assert.throws(() => validateProgramInputs({ ...input, grokSha256: '0'.repeat(64) }),
    { code: 'COMPATIBILITY_PROGRAM_HASH_MISMATCH' });
  writeFileSync(join(root, 'empty-program'), '');
  assert.throws(() => validateProgramInputs({ ...input, grokProgram: join(root, 'empty-program'), grokSha256: digest(Buffer.alloc(0)) }),
    { code: 'COMPATIBILITY_PROGRAM_FILE_INVALID' });
  writeFileSync(join(product, 'fixture.mjs'), 'modified');
  assert.throws(() => validateProgramInputs(input), { code: 'COMPATIBILITY_PROGRAM_PRODUCT_CHANGED' });
  writeFileSync(join(product, 'fixture.mjs'), module);
  assert.throws(() => validateProgramInputs({ ...input, outputRoot: join(product, 'output') }),
    { code: 'COMPATIBILITY_PROGRAM_OUTPUT_OVERLAP' });
  mkdirSync(input.outputRoot);
  assert.throws(() => validateProgramInputs(input), { code: 'COMPATIBILITY_PROGRAM_OUTPUT_EXISTS' });
  assert.throws(() => packageFiles(tarGzip([['package/../escape', 'bad'], ['package/package.json', manifest]])),
    { code: 'COMPATIBILITY_PROGRAM_ARCHIVE_PATH' });
});

test('program verifier gives each isolated case a compact path without changing external evidence identifiers', () => {
  const root = join(tmpdir(), 'program-artifacts');
  const cases = [[PROGRAM_CASE_IDS[0], null], [PROGRAM_CASE_IDS[1], 'disable'],
    [PROGRAM_CASE_IDS[1], 'dispose'], [PROGRAM_CASE_IDS[2], null]];
  const paths = cases.map(([id, variant]) => programCaseDirectory(root, id, variant));
  assert.equal(new Set(paths).size, cases.length);
  for (const path of paths) {
    assert.ok(path.startsWith(root));
    assert.ok(path.length <= root.length + 3, 'case labels must not inflate the private native executable path');
    assert.equal(existsSync(path), false);
  }
  assert.throws(() => programCaseDirectory(root, '../outside', null));
  assert.throws(() => programCaseDirectory(root, PROGRAM_CASE_IDS[1], null));
});

test('program verifier synthetic download preserves real binary bytes and matches the product archive contract on every platform', () => {
  const binary = Buffer.from('pinned native bytes, not executed');
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'x64']]) {
    const fixture = platformArchive(binary, platform, arch);
    verifyArchiveIntegrity(fixture.archive, fixture.integrity);
    const unpacked = unpackPlatformArchive(fixture.archive, { packageName: fixture.name, version: PROGRAM_VERSION, platform });
    assert.deepEqual(unpacked.executable, binary);
    assert.equal(unpacked.manifest.cpu.includes(arch), true);
    assert.equal(unpacked.filename, fixture.filename);
    const changed = Buffer.from(fixture.archive);
    changed[changed.length - 1] ^= 1;
    assert.throws(() => verifyArchiveIntegrity(changed, fixture.integrity), { code: 'GROK_DOWNLOAD_INTEGRITY' });
  }
});

test('program verifier remaps only exact installer URLs and preserves abort identity without external requests', async () => {
  const archive = platformArchive(Buffer.from('test'), 'linux', 'x64'), calls = [];
  const upstream = { origin: 'http://127.0.0.1:43210', state: { unexpected: 0 } };
  const boundary = installProgramFetchBoundary(upstream, archive, async (url, options) => {
    calls.push({ url, options }); return new Response('{}');
  });
  const controller = new AbortController(), reason = new GrokSearchError('GROK_SEARCH_STOPPING', 'stopping');
  await boundary.fetch(archive.metadataUrls[0], { signal: controller.signal });
  await boundary.fetch(archive.archiveUrl, { signal: controller.signal });
  assert.equal(calls[0].url, upstream.origin + '/registry/metadata');
  assert.equal(calls[1].url, upstream.origin + '/registry/archive');
  assert.equal(calls[0].options.signal, controller.signal);
  controller.abort(reason);
  assert.equal(boundary.records[0].aborted, true);
  assert.equal(boundary.records[0].signal.reason, reason);
  for (const url of ['https://api.x.ai/v1/responses', archive.archiveUrl + '?changed=1',
    'http://user:secret@127.0.0.1:43210/v1/responses', 'http://127.0.0.1:43211/registry/metadata']) {
    await assert.rejects(boundary.fetch(url), { code: 'COMPATIBILITY_PROGRAM_NETWORK_DENIED' });
  }
  assert.equal(calls.length, 2);
  assert.equal(upstream.state.unexpected, 4);
});

test('program verifier isolates credentials, global program discovery and npm configuration in child environments', () => {
  const root = join(tmpdir(), 'synthetic-program-environment');
  const env = programEnvironment(root, { SystemRoot: 'C:/Windows', GROK_SEARCH_API_KEY: 'not-used',
    HTTP_PROXY: 'not-used', PATH: 'not-used', npm_config_userconfig: 'not-used', NODE_OPTIONS: 'not-used' });
  assert.equal(env.SystemRoot, 'C:/Windows');
  assert.equal(env.PATH, join(root, 'empty-path'));
  assert.equal(env.HOME, join(root, 'user'));
  for (const name of ['GROK_SEARCH_API_KEY', 'HTTP_PROXY', 'npm_config_userconfig', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
});

test('program verifier never passes a case from missing cleanup, process, cancellation or publication evidence', () => {
  const common = { orphanProcesses0: true, configUnchanged: true, cacheSentinelUnchanged: true, unexpectedRequests: 0 };
  const observations = [
    { ...common, childStarted: true, callerReasonPreserved: true, childReaped: true, stdioClosed: true,
      upstreamDisconnectObserved: true, running0: true, queued0: true, recovered: true,
      cancelledCalls: 2, programVersion: PROGRAM_VERSION },
    { ...common, preparationStarted: true, callerReasonPreserved: true, preparationSettled: true,
      upstreamDisconnectObserved: true, lateCompletionAttempted: true, lateCompletionNotPublished: true,
      activeCacheCommitted: false, programPhase: 'disposed' },
    { ...common, failureObserved: true, failureCode: 'GROK_DOWNLOAD_HTTP', invalidCacheActivated: false,
      repairFailureObserved: true, failedRepairPreservedActive: true, repairSucceeded: true,
      repairedSha256: 'a'.repeat(64), mcpHandshakeValidated: true, recovered: true },
  ];
  for (let index = 0; index < PROGRAM_CASE_IDS.length; index++) {
    const id = PROGRAM_CASE_IDS[index], complete = observations[index];
    assert.equal(casePassed(id, complete), true);
    assert.equal(casePassed(id, {}), false);
    for (const key of Object.keys(complete)) {
      const incomplete = { ...complete }; delete incomplete[key];
      assert.equal(casePassed(id, incomplete), false, `${id} requires ${key}`);
    }
  }
});
