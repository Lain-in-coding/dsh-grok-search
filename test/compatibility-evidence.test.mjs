import test from 'node:test';
import './macos-acceptance-cases.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { mkdtempTracked as mkdtempSync } from './helpers/temp-fixture.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  ACCEPTANCE_VERSIONS, COMPATIBILITY_LANES, EVIDENCE_TIMEOUTS, FULL_ACCEPTANCE_GATES, SMOKE_GATES, acceptanceTargets,
  assertAssetUnchanged, confinedPath, createExecutionIdentity, desktopCandidates, executionSha256,
  downloadHostAsset, fetchVerifiedResource, hostVersionAdmitted,
  npmIdentity, officialMetadataUrl, parseUpdateMetadata, readRuntimeReceipt, releaseEvidence,
  requireIntegrity, sealExecutionResult, sha256, validateOfficialUrl, validateRuntimeReceipt, verifyBytes, verifyHostAsset,
} from '../scripts/lib/compatibility-evidence.mjs';
import {
  collectCompatibility, createOutputRoot, discoverCompatibility, parseWatchArguments,
  runCompatibilitySmoke, smokeEnvironment, smokeKey, VERIFIER_INPUT_PATHS, verifierIdentity,
} from '../scripts/compatibility-watch.mjs';
import { candidateRuntime, CANDIDATE_VERSIONS } from '../scripts/lib/candidate-runtime.mjs';
import { cliNodeVersionSupported, parseCliWebArguments } from '../scripts/b3-cli-web.mjs';

const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const hostBytes = Buffer.from('synthetic-official-host');
const productBytes = Buffer.from('synthetic-product-tarball');
const gateBytes = Buffer.from('synthetic gate execution evidence');
const verifierSha256 = 'a'.repeat(64);
const version = '0.2.2-rc.3';
const feed = (lane = 'windows-desktop', overrides = {}) => Buffer.from(JSON.stringify({
  version, files: [{
    url: `https://download.deepseek.com/dsh-desk/bin/${COMPATIBILITY_LANES[lane].feedDirectory}/deepseek-harness-${version}-${lane === 'windows-desktop' ? 'win-x64.exe' : 'mac-arm64.zip'}`,
    sha512: integrity(hostBytes).slice(7), size: hostBytes.length, ...overrides,
  }],
}));
const candidate = () => desktopCandidates(feed(), 'windows-desktop')[0];
function npmDocument(name = 'dsh-grok-search', value = '0.4.0', bytes = productBytes) {
  return Buffer.from(JSON.stringify({ name, 'dist-tags': { latest: value }, versions: {
    [value]: { name, version: value, engines: { node: '>=24.9.0' }, dist: {
      tarball: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${value}.tgz`, integrity: integrity(bytes),
    } },
  } }));
}
function networkFixture({ mutate, redirect } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(Object.keys(init.headers).some(key => /authorization|cookie/i.test(key)), false);
    let bytes;
    if (url.startsWith('https://api.github.com/')) bytes = Buffer.from(JSON.stringify([
      { tag_name: 'dsh-v' + version, prerelease: true, draft: false, assets: [{ browser_download_url: 'https://evil.invalid/run' }] },
    ]));
    else if (url === officialMetadataUrl('windows-desktop')) bytes = feed();
    else if (url === officialMetadataUrl('macos-desktop')) bytes = feed('macos-desktop');
    else if (url === officialMetadataUrl('linux-cli')) bytes = npmDocument('@deepseek-ai/dsh', version, hostBytes);
    else if (url === 'https://registry.npmjs.org/dsh-grok-search') bytes = npmDocument();
    else if (url === 'https://registry.npmjs.org/dsh-grok-search/-/dsh-grok-search-0.4.0.tgz') bytes = productBytes;
    else bytes = hostBytes;
    if (redirect) return new Response('', { status: 302, headers: { location: redirect } });
    return new Response(mutate?.(url, bytes) ?? bytes);
  };
  return { calls, fetchImpl };
}
const passing = (product, host) => ({ passed: true, scope: 'official-host-synthetic-upstream',
  productSha256: product.sha256, hostSha256: host.sha256, verifierSha256, dsh: host.version, lane: host.lane,
  realCredentialsUsed: false, officialSearchCalls: 0, cleanupVerified: true,
  gates: SMOKE_GATES.map(id => ({ id, status: 'passed', passed: true,
    evidence: [{ path: 'evidence.json', sha256: sha256(gateBytes) }] })) });
function sealedFixture(result, platform = 'win32', arch = 'x64') {
  const execution = createExecutionIdentity({ platform, arch });
  const sealed = { ...result, execution: { ...execution, finishedAt: execution.startedAt } };
  return { ...sealed, runSha256: executionSha256(sealed) };
}

async function assertVerifierImportClosure(projectRoot, entryPoints, fingerprintPaths) {
  const result = await build({ absWorkingDir: projectRoot, entryPoints, outdir: 'unused-verifier-closure',
    bundle: true, platform: 'node', format: 'esm', packages: 'external', treeShaking: false,
    metafile: true, write: false, logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs).map(path => path.replaceAll('\\', '/'));
  assert.deepEqual(inputs.filter(path => !fingerprintPaths.includes(path)).sort(), [],
    'Every local verifier import must be included in the fingerprint.');
}

test('future semantic versions are admission inputs, not trusted runtime candidates', () => {
  for (const value of ['0.2.1-rc.2', '0.2.1-rc.10', '0.2.2-alpha.1', version,
    '2.0.0-beta.1', '99.0.0', '0.2.2-rc.3+build.1']) {
    assert.equal(hostVersionAdmitted(value), true, value);
  }
  for (const value of ['0.2.1-rc.1', '0.2.0', 'v0.2.2', '*', '0.2', '01.2.3', '0.2.2;run']) {
    assert.equal(hostVersionAdmitted(value), false, value);
  }
  assert.equal(CANDIDATE_VERSIONS.includes(version), false);
  assert.equal(acceptanceTargets().length, 21);
  assert.equal(ACCEPTANCE_VERSIONS.length, 7);
});
test('official updater metadata uses production nightly feeds and requires exact integrity', () => {
  assert.equal(officialMetadataUrl('windows-desktop'), 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml');
  assert.equal(officialMetadataUrl('macos-desktop'), 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml');
  const yaml = Buffer.from(`version: ${version}\nfiles:\n  - url: "${candidate().source.url}"\n    sha512: ${integrity(hostBytes).slice(7)}\n    size: ${hostBytes.length}\n    blockMapSize: 300\nreleaseDate: '2026-11-14'\n`);
  assert.equal(desktopCandidates(yaml, 'windows-desktop')[0].integrity, integrity(hostBytes));
  assert.equal(desktopCandidates(feed('windows-desktop', {
    url: candidate().source.url.split('/').at(-1),
  }), 'windows-desktop')[0].source.url, candidate().source.url);
  assert.equal(parseUpdateMetadata(yaml).files.length, 1);
  for (const sha512 of [undefined, '', 'abcd', 'sha512-' + 'A'.repeat(86) + '==']) {
    assert.throws(() => desktopCandidates(feed('windows-desktop', { sha512 }), 'windows-desktop'),
      { code: 'COMPATIBILITY_HASH_REQUIRED' });
  }
  assert.throws(() => requireIntegrity('sha1-old'), { code: 'COMPATIBILITY_HASH_REQUIRED' });
  assert.throws(() => parseUpdateMetadata(Buffer.from('version: 1.2.3\nversion: 2.0.0\n')), { code: 'COMPATIBILITY_METADATA_INVALID' });
  assert.throws(() => parseUpdateMetadata(Buffer.from('version: !!js/function foo\n')), { code: 'COMPATIBILITY_METADATA_INVALID' });
});
test('public macOS and Windows nightly feeds parse their exact folded-strip scalar shape offline', () => {
  // Public metadata only: these rows do not attest to downloaded or executed host binaries.
  const samples = [
    { lane: 'macos-desktop', directory: 'mac-arm64', extension: 'zip', size: 362840431,
      hash: 'UThWXKCqiiUnjFgij655+Gc1MgiSl+Ybl71jkQi48BhcBCN0XSDNT4GGmGJY3nvEqnkLT3LtWbL6wy6t/kRxIw==',
      date: '2026-11-13T07:40:14.455Z' },
    { lane: 'windows-desktop', directory: 'win-x64', extension: 'exe', size: 299595752,
      hash: 'GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==',
      date: '2026-11-13T07:31:42.937Z' },
  ];
  for (const sample of samples) {
    const url = `https://download.deepseek.com/dsh-desk/bin/${sample.directory}/deepseek-harness-0.2.2-rc.3-${sample.directory}.${sample.extension}`;
    const text = [
      'version: 0.2.2-rc.3', 'files:', '  - url: >-', `      ${url}`,
      `    size: ${sample.size}`, '    sha512: >-', `      ${sample.hash}`,
      'path: >-', `  ${url}`, 'sha512: >-', `  ${sample.hash}`,
      'stagingPercentage: 100', `releaseDate: '${sample.date}'`, '',
    ].join('\n');
    for (const newline of ['\n', '\r\n']) {
      const bytes = Buffer.from(text.replaceAll('\n', newline));
      const parsed = parseUpdateMetadata(bytes);
      assert.deepEqual(parsed, { version: '0.2.2-rc.3',
        files: [{ url, size: String(sample.size), sha512: sample.hash }], path: url, sha512: sample.hash });
      const [host] = desktopCandidates(bytes, sample.lane);
      assert.equal(host.source.url, url);
      assert.equal(host.source.metadataSha256, sha256(bytes));
      assert.equal(host.integrity, 'sha512-' + sample.hash);
      assert.equal(host.size, sample.size);
      assert.equal(host.sha256, undefined, 'metadata parsing is not a downloaded-asset receipt');
    }
    const legacyShape = Buffer.from(`version: 0.2.2-rc.3\npath: >-\n  ${url}\nsha512: >-\n  ${sample.hash}\n`);
    assert.equal(desktopCandidates(legacyShape, sample.lane)[0].source.url, url);
  }
});
test('folded-strip scalars follow ordinary folding and stripping, never silently collapse whitespace', () => {
  const parsed = parseUpdateMetadata(Buffer.from('path: >-\n  first\n  second\n\n  third\n\n\nversion: 1.2.3\n'));
  assert.equal(parsed.path, 'first second\nthird');
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parseUpdateMetadata(Buffer.from('path: >-\n\n  first\n\n')).path, '\nfirst');
  assert.equal(parseUpdateMetadata(Buffer.from('path: >-\n  first')).path, 'first');
  for (const text of ['path: >-\nversion: 1.2.3\n', 'path: >-\n  first\n   nested\n',
    'path: >-\n   first\n  underindented\n', 'path: >-\n\tfirst\n',
    'path: >\n  first\n', 'path: >+\n  first\n', 'path: >2-\n  first\n', 'path: |\n  first\n']) {
    assert.throws(() => parseUpdateMetadata(Buffer.from(text)), { code: 'COMPATIBILITY_METADATA_INVALID' });
  }
});
test('folded updater values retain duplicate, integrity, size, URL and non-executable YAML safeguards', () => {
  const url = candidate().source.url, hash = integrity(hostBytes).slice(7);
  const text = `version: ${version}\nfiles:\n  - url: >-\n      ${url}\n    sha512: >-\n      ${hash}\n    size: ${hostBytes.length}\n`;
  for (const extra of [`    sha512: >-\n      ${hash}\n`, `    url: >-\n      ${url}\n`,
    `  - url: >-\n      ${url}\n    sha512: >-\n      ${hash}\n`, `version: ${version}\n`]) {
    assert.throws(() => desktopCandidates(Buffer.from(text + extra), 'windows-desktop'),
      { code: 'COMPATIBILITY_METADATA_INVALID' });
  }
  for (const value of ['!include external', '&asset >-', '*asset']) {
    assert.throws(() => desktopCandidates(Buffer.from(text.replace('url: >-', 'url: ' + value)), 'windows-desktop'),
      { code: 'COMPATIBILITY_METADATA_INVALID' });
  }
  for (const value of ['https://untrusted.invalid/a.exe', '../../outside.exe', url + '\n      suffix']) {
    assert.throws(() => desktopCandidates(Buffer.from(text.replace(url, value)), 'windows-desktop'),
      { code: 'COMPATIBILITY_URL_UNTRUSTED' });
  }
  assert.throws(() => desktopCandidates(Buffer.from(text.replace(hash, 'missing-integrity')), 'windows-desktop'),
    { code: 'COMPATIBILITY_HASH_REQUIRED' });
  assert.throws(() => desktopCandidates(Buffer.from(text.replace(`size: ${hostBytes.length}`, 'size: 2147483649')), 'windows-desktop'),
    { code: 'COMPATIBILITY_SIZE_LIMIT' });
});
test('untrusted URL, platform escape, credentials and arbitrary metadata execution are rejected', () => {
  for (const url of ['http://download.deepseek.com/a.exe', 'https://download.deepseek.com.evil.invalid/a.exe',
    'https://user:pass@download.deepseek.com/dsh-desk/bin/win-x64/a.exe',
    'file:///tmp/host.exe', 'https://evil.invalid/run.exe',
    'https://download.deepseek.com/dsh-desk/bin/mac-arm64/a.exe',
    candidate().source.url + '?token=secret', candidate().source.url + '#x',
    '../../bin/win-x64/a.exe', 'https://download.deepseek.com/dsh-desk/bin/win-x64/%2e%2e/a.exe']) {
    assert.throws(() => desktopCandidates(feed('windows-desktop', { url }), 'windows-desktop'), url);
  }
  assert.throws(() => validateOfficialUrl('https://registry.npmjs.org/other/-/x.tgz',
    { kind: 'npm-tarball', packageName: 'dsh-grok-search' }), { code: 'COMPATIBILITY_URL_UNTRUSTED' });
  assert.throws(() => parseUpdateMetadata(Buffer.from(`version: ${version}\nfiles:\n  - url: !include malicious\n`)));
});
test('content hashes are mandatory; same release asset changes cannot silently replace a candidate', () => {
  assert.throws(() => verifyBytes(hostBytes), { code: 'COMPATIBILITY_HASH_REQUIRED' });
  assert.throws(() => verifyHostAsset(candidate(), Buffer.from('changed')), { code: 'COMPATIBILITY_SIZE_MISMATCH' });
  const verified = verifyHostAsset(candidate(), hostBytes);
  assert.equal(verified.sha256, sha256(hostBytes));
  const changed = { ...candidate(), integrity: integrity(Buffer.from('changed')) };
  assert.throws(() => assertAssetUnchanged(changed, [verified]), { code: 'COMPATIBILITY_ASSET_CHANGED' });
  assertAssetUnchanged(candidate(), [verified]);
});
test('fetch denies cross-origin redirects before request and bounds/cancels body reads', async () => {
  const f = networkFixture({ redirect: 'https://evil.invalid/collect' });
  await assert.rejects(fetchVerifiedResource(officialMetadataUrl('windows-desktop'), {
    fetchImpl: f.fetchImpl, validateUrl: url => validateOfficialUrl(url, { kind: 'metadata', lane: 'windows-desktop' }),
  }), { code: 'COMPATIBILITY_URL_UNTRUSTED' });
  assert.equal(f.calls.length, 1);
  let cancelled = false;
  await assert.rejects(fetchVerifiedResource(candidate().source.url, { limit: 3,
    validateUrl: url => validateOfficialUrl(url, { kind: 'desktop-asset', lane: 'windows-desktop' }),
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('large')); }, cancel() { cancelled = true; },
    })),
  }), { code: 'COMPATIBILITY_SIZE_LIMIT' });
  assert.equal(cancelled, true);
  await assert.rejects(fetchVerifiedResource(candidate().source.url, {
    validateUrl: () => {}, fetchImpl: async () => new Response('', { status: 401 }),
  }), { code: 'COMPATIBILITY_METADATA_HTTP' });
});
test('asset timeout defaults to fifteen minutes while metadata stays twenty seconds and overrides are bounded', async t => {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-timeout-'));
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response(hostBytes); };
  const path = join(root, 'default.exe');
  assert.equal((await downloadHostAsset(candidate(), path, { fetchImpl })).sha256, sha256(hostBytes));
  assert.ok(timeouts.length > 0 && timeouts.every(ms => ms === 900_000));
  assert.deepEqual(EVIDENCE_TIMEOUTS, { metadata: 20_000, asset: 900_000 });
  timeouts.length = 0;
  await fetchVerifiedResource(officialMetadataUrl('windows-desktop'), { fetchImpl,
    validateUrl: url => validateOfficialUrl(url, { kind: 'metadata', lane: 'windows-desktop' }) });
  assert.deepEqual(timeouts, [20_000]);
  for (const timeoutMs of [1, 900_000]) {
    timeouts.length = 0;
    await downloadHostAsset(candidate(), join(root, timeoutMs + '.exe'), { fetchImpl, timeoutMs });
    assert.ok(timeouts.length > 0 && timeouts.every(ms => ms === timeoutMs));
  }
  const requestCount = requests;
  for (const timeoutMs of [0, -1, 1.5, 900_001, Number.NaN, Infinity, '900000', null]) {
    const destination = join(root, 'invalid.exe');
    await assert.rejects(downloadHostAsset(candidate(), destination, { fetchImpl, timeoutMs }),
      { code: 'COMPATIBILITY_TIMEOUT_INVALID' });
    assert.equal(existsSync(destination), false);
  }
  const controller = new AbortController(), reason = new Error('fixture pre-cancellation');
  controller.abort(reason);
  const cancelledPath = join(root, 'pre-cancelled.exe');
  await assert.rejects(downloadHostAsset(candidate(), cancelledPath, { fetchImpl, signal: controller.signal }),
    error => error === reason);
  assert.equal(existsSync(cancelledPath), false);
  await assert.rejects(downloadHostAsset(candidate(), path, { fetchImpl }), { code: 'EEXIST' });
  assert.deepEqual(readFileSync(path), hostBytes);
  assert.equal(requests, requestCount, 'invalid, pre-cancelled and existing targets must not issue requests');
});
test('a slow asset body cannot succeed with late bytes after its deadline or an earlier external abort', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', () => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-slow-body-'));
  for (const mode of ['deadline', 'external']) {
    const external = new AbortController();
    const reason = mode === 'deadline' ? new DOMException('Fixture deadline elapsed', 'TimeoutError')
      : new Error('Fixture caller cancelled earlier');
    const path = join(root, mode + '.exe'), prefix = hostBytes.subarray(0, 5);
    let releaseRead, waiting, requests = 0, reads = 0, released = false, receivedSignal;
    const pendingRead = new Promise(resolve => { waiting = resolve; }), cancellations = [];
    const reader = {
      async read() {
        if (++reads === 1) return { done: false, value: prefix };
        return new Promise(resolve => { releaseRead = resolve; waiting(); });
      },
      async cancel(value) { cancellations.push(value); },
      releaseLock() { released = true; },
    };
    const pending = downloadHostAsset(candidate(), path, { signal: external.signal,
      fetchImpl: async (_url, { signal }) => {
        requests++; receivedSignal = signal;
        return { ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader } };
      } });
    const rejected = assert.rejects(pending, error => error === reason);
    await pendingRead;
    assert.deepEqual(readFileSync(path), prefix);
    if (mode === 'deadline') deadlines.at(-1).abort(reason);
    else external.abort(reason);
    assert.equal(receivedSignal.aborted, true);
    // Simulate a body that delivers a queued chunk even after cancellation.
    releaseRead({ done: false, value: hostBytes.subarray(prefix.length) });
    await rejected;
    assert.equal(requests, 1, 'timeouts must not retry the download');
    assert.ok(cancellations.includes(reason));
    assert.equal(released, true);
    assert.deepEqual(readFileSync(path), prefix, 'preserve the partial file without appending late bytes');
  }
});
test('a deadline during stream finalization cannot report a hash-valid asset as successful', async t => {
  const deadline = new AbortController(), reason = new DOMException('Fixture finalization deadline', 'TimeoutError');
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-late-timeout-')), path = join(root, 'complete.exe');
  let reads = 0;
  await assert.rejects(downloadHostAsset(candidate(), path, {
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
      async read() { return ++reads === 1 ? { done: false, value: hostBytes } : { done: true }; },
      async cancel() { deadline.abort(reason); },
      releaseLock() {},
    }) } }),
  }), error => error === reason);
  assert.deepEqual(readFileSync(path), hostBytes, 'complete bytes alone are not a successful timed-out download receipt');
});
test('released selection freezes npm latest exact bytes and ignores GitHub binary links', async () => {
  const f = networkFixture();
  const { plan, productBytes: actual } = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256 });
  assert.deepEqual(actual, productBytes);
  assert.equal(plan.target, 'released');
  assert.equal(plan.product.version, '0.4.0');
  assert.equal(plan.product.sha256, sha256(productBytes));
  assert.equal(plan.matrix.length, 3);
  assert.equal(plan.passed, false);
  assert.equal(plan.fullAcceptanceRun, false);
  assert.equal(f.calls.some(row => row.url.includes('evil.invalid')), false);
  assert.equal(plan.candidates.some(row => row.sha256), false, 'discovery is not an asset execution receipt');
  assert.equal(npmIdentity(npmDocument(), { packageName: 'dsh-grok-search' }).version, '0.4.0');
});
test('missing hashes and changed feed assets create blocked lanes rather than trusted future fixtures', async () => {
  const previous = { schemaVersion: 1, kind: 'compatibility-watch-state', candidates: [candidate()], results: [] };
  const f = networkFixture({ mutate: (url, bytes) => url === officialMetadataUrl('windows-desktop')
    ? feed('windows-desktop', { sha512: integrity(Buffer.from('changed')).slice(7) }) : bytes });
  const { plan } = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256, previous });
  assert.equal(plan.matrix.length, 2);
  assert.ok(plan.issues.some(row => row.code === 'COMPATIBILITY_ASSET_CHANGED' && row.required));
  const failedState = collectCompatibility(plan);
  const next = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256, previous: failedState });
  assert.ok(next.plan.issues.some(row => row.code === 'COMPATIBILITY_ASSET_CHANGED' && row.required));
  assert.equal(next.plan.candidates.some(row => row.lane === 'windows-desktop'), false);
  assert.equal(next.plan.observations.find(row => row.lane === 'windows-desktop').integrity, candidate().integrity);
  const missing = networkFixture({ mutate: (url, bytes) => url === officialMetadataUrl('macos-desktop')
    ? feed('macos-desktop', { sha512: undefined }) : bytes });
  const result = await discoverCompatibility({ fetchImpl: missing.fetchImpl, verifierSha256 });
  assert.ok(result.plan.issues.some(row => row.code === 'COMPATIBILITY_HASH_REQUIRED'));
});
test('candidate selection is local and pinned, never an arbitrary remote URL', async () => {
  assert.throws(() => parseWatchArguments(['--output-root', '/tmp/dsh-compatibility-x', '--target', 'candidate']),
    { code: 'COMPATIBILITY_HASH_REQUIRED' });
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-test-'));
  const path = join(root, 'candidate.tgz');
  writeFileSync(path, productBytes);
  writeFileSync(join(root, 'package-receipt.json'), JSON.stringify({ version: '0.4.0', sha256: sha256(productBytes) }));
  const f = networkFixture();
  const { plan } = await discoverCompatibility({ target: 'candidate', candidatePath: path,
    candidateSha256: sha256(productBytes), fetchImpl: f.fetchImpl, verifierSha256 });
  assert.equal(plan.product.target, 'candidate');
  assert.equal(f.calls.some(row => row.url.includes('/dsh-grok-search')), false);
  await assert.rejects(discoverCompatibility({ target: 'candidate', candidatePath: path,
    candidateSha256: '0'.repeat(64), fetchImpl: f.fetchImpl, verifierSha256 }), { code: 'COMPATIBILITY_HASH_MISMATCH' });
});
test('smoke requires actual local runner evidence and preserves exact frozen inputs', async () => {
  const f = networkFixture();
  const { plan } = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256 });
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-smoke-')), path = join(root, 'product.tgz');
  writeFileSync(path, productBytes);
  await assert.rejects(runCompatibilitySmoke({ plan, lane: 'windows-desktop', productPath: path,
    outputRoot: root, platform: 'win32', arch: 'x64', fetchImpl: f.fetchImpl }),
  { code: 'COMPATIBILITY_SMOKE_RUNNER_UNAVAILABLE' });
  assert.equal(existsSync(join(root, 'official-host.exe')), false);
  let called = false;
  const result = await runCompatibilitySmoke({ plan, lane: 'windows-desktop', productPath: path,
    outputRoot: root, platform: 'win32', arch: 'x64', fetchImpl: f.fetchImpl,
    runner: async input => {
      called = true;
      assert.equal(input.noLiveServices, true);
      assert.equal(input.extractionMustBeConfined, true);
      assert.deepEqual(readFileSync(input.assetPath), hostBytes);
      writeFileSync(join(input.outputRoot, 'evidence.json'), gateBytes);
      return passing(input.product, input.candidate);
    } });
  assert.equal(called, true);
  assert.equal(result.result.hostSha256, sha256(hostBytes));
  assert.equal(result.result.runSha256, executionSha256(result.result));
  assert.equal(result.result.execution.context.kind, 'local');
  assert.equal(result.key, smokeKey({ product: plan.product, candidate: candidate(), verifierSha256 }));
  assert.equal(collectCompatibility(plan, [result]).passed, false, 'one lane cannot stand for all platforms');
  assert.throws(() => collectCompatibility(plan, [result, result]), { code: 'COMPATIBILITY_RECEIPT_INVALID' });
});
test('reuse needs matching product, host, verifier, gates and a passing result', async () => {
  const f = networkFixture();
  const { plan } = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256 });
  const host = verifyHostAsset(plan.candidates[0], hostBytes);
  const row = { key: smokeKey({ product: plan.product, candidate: host, verifierSha256 }), candidate: host,
    result: sealedFixture(passing(plan.product, host)) };
  const previous = { schemaVersion: 1, kind: 'compatibility-watch-state', candidates: plan.candidates, results: [row] };
  const reused = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256, previous });
  assert.equal(reused.plan.matrix.length, 2);
  assert.equal(reused.plan.results[0].reused, true);
  const changed = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256: 'b'.repeat(64), previous });
  assert.equal(changed.plan.matrix.length, 3);
  row.result.cleanupVerified = false;
  assert.equal((await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256, previous })).plan.matrix.length, 3);
});
test('verifier fingerprint binds the child, process helper and dependency lock to smoke reuse', async () => {
  for (const path of ['scripts/compatibility-smoke-host.mjs', 'scripts/lib/compatibility-smoke.mjs',
    'scripts/lib/compatibility-process.mjs',
    'scripts/lib/compatibility-evidence.mjs', 'scripts/lib/candidate-runtime.mjs',
    'scripts/lib/asar.mjs', 'scripts/deferred-release-desktop-prepare.mjs', 'package-lock.json']) {
    assert.ok(VERIFIER_INPUT_PATHS.includes(path), path);
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-verifier-'));
  const child = 'scripts/compatibility-smoke-host.mjs';
  for (const path of VERIFIER_INPUT_PATHS.filter(path => path !== child)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'synthetic fingerprint fixture: ' + path + '\n');
  }
  await assert.rejects(verifierIdentity(root), { code: 'COMPATIBILITY_PATH_UNSAFE' });
  writeFileSync(join(root, child), 'export const syntheticChildGate = 1;\n');
  const before = await verifierIdentity(root);
  assert.equal(await verifierIdentity(root), before);
  const f = networkFixture();
  const { plan } = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256: before });
  const host = verifyHostAsset(plan.candidates[0], hostBytes);
  const key = smokeKey({ product: plan.product, candidate: host, verifierSha256: before });
  const previous = collectCompatibility(plan, [{ key, candidate: host, reused: false,
    result: sealedFixture({ ...passing(plan.product, host), verifierSha256: before }) }]);
  const reused = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256: before, previous });
  assert.equal(reused.plan.results[0].reused, true);
  writeFileSync(join(root, child), 'export const syntheticChildGate = 2;\n');
  const afterChild = await verifierIdentity(root);
  assert.notEqual(afterChild, before);
  assert.notEqual(smokeKey({ product: plan.product, candidate: host, verifierSha256: afterChild }), key);
  const changed = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256: afterChild, previous });
  assert.equal(changed.plan.results.length, 0);
  assert.equal(changed.plan.matrix.length, 3);
  writeFileSync(join(root, 'scripts/lib/compatibility-process.mjs'), 'export const syntheticProcessRevision = 2;\n');
  const afterProcess = await verifierIdentity(root);
  assert.notEqual(afterProcess, afterChild);
  assert.notEqual(smokeKey({ product: plan.product, candidate: host, verifierSha256: afterProcess }),
    smokeKey({ product: plan.product, candidate: host, verifierSha256: afterChild }));
  writeFileSync(join(root, 'package-lock.json'), '{"syntheticDependencyRevision":2}\n');
  const afterLock = await verifierIdentity(root);
  assert.notEqual(afterLock, afterProcess);
  assert.notEqual(smokeKey({ product: plan.product, candidate: host, verifierSha256: afterLock }),
    smokeKey({ product: plan.product, candidate: host, verifierSha256: afterProcess }));
});
test('fingerprint covers the local import closure of the watcher, dynamic runner and child helper', async () => {
  // Computed imports and subprocess paths are not discoverable through static module resolution.
  const entryPoints = ['scripts/compatibility-watch.mjs', 'scripts/lib/compatibility-smoke.mjs',
    'scripts/compatibility-smoke-host.mjs'];
  assert.equal(new Set(VERIFIER_INPUT_PATHS).size, VERIFIER_INPUT_PATHS.length);
  for (const path of [...entryPoints, 'package-lock.json']) assert.ok(VERIFIER_INPUT_PATHS.includes(path), path);
  await assertVerifierImportClosure(fileURLToPath(new URL('..', import.meta.url)), entryPoints, VERIFIER_INPUT_PATHS);
});
test('closure validation detects missing transitive, re-exported and literal dynamic helper imports without execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-closure-'));
  const sources = {
    'entry.mjs': "import './direct.mjs';\nexport { helper } from './bridge.mjs';\nawait import('./dynamic.mjs');\n",
    'direct.mjs': "import './nested/leaf.mjs';\n",
    'bridge.mjs': "export { helper } from './nested/leaf.mjs';\n",
    'nested/leaf.mjs': 'export const helper = 1;\n',
    'dynamic.mjs': "throw new Error('Static closure checks must never execute fixtures');\n",
  };
  for (const [path, source] of Object.entries(sources)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  const paths = Object.keys(sources);
  await assertVerifierImportClosure(root, ['entry.mjs'], paths);
  for (const omitted of ['direct.mjs', 'bridge.mjs', 'nested/leaf.mjs', 'dynamic.mjs']) {
    await assert.rejects(assertVerifierImportClosure(root, ['entry.mjs'], paths.filter(path => path !== omitted)),
      { code: 'ERR_ASSERTION', message: /Every local verifier import/ });
  }
  assert.equal(existsSync(join(root, 'unused-verifier-closure')), false);
});
test('subprocess environment removes authentication, profiles and loader injection', () => {
  const env = smokeEnvironment({ PATH: '/system/bin', GITHUB_TOKEN: 'secret', ACTIONS_RUNTIME_TOKEN: 'secret',
    NODE_OPTIONS: '--import malicious', GROK_SEARCH_API_KEY: 'secret', HOME: '/real', DSH_HOME: '/real-profile',
    npm_config_userconfig: '/private/.npmrc', HTTPS_PROXY: 'https://user:secret@proxy' }, '/isolated');
  assert.equal(env.PATH, '/system/bin');
  for (const key of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NODE_OPTIONS', 'GROK_SEARCH_API_KEY',
    'npm_config_userconfig', 'HTTPS_PROXY']) assert.equal(env[key], undefined);
  assert.equal(env.HOME, join('/isolated', 'home'));
  assert.equal(env.DSH_HOME, join('/isolated', 'dsh-home'));
});
test('new output roots and receipt paths reject escape, reused directories and links', () => {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-compat-parent-'));
  const root = createOutputRoot(join(parent, 'dsh-compatibility-test'), parent);
  assert.equal(existsSync(root), true);
  assert.throws(() => createOutputRoot(root, parent), { code: 'COMPATIBILITY_PATH_UNSAFE' });
  for (const path of ['../escape', '/absolute', 'folder\\escape', 'C:/escape', 'NUL.json', 'folder./evidence']) {
    assert.throws(() => confinedPath(root, path, { allowMissing: true }), { code: 'COMPATIBILITY_PATH_UNSAFE' });
  }
  const outside = mkdtempSync(join(tmpdir(), 'dsh-compat-outside-'));
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => confinedPath(root, 'linked/file', { allowMissing: true }), { code: 'COMPATIBILITY_PATH_UNSAFE' });
});
test('runtime receipts bind local file hashes without marking synthetic future fixtures trusted', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-runtime-'));
  writeFileSync(join(root, 'host.exe'), hostBytes);
  const receipt = { schemaVersion: 1, kind: 'verified-runtime-candidate', asset: verifyHostAsset(candidate(), hostBytes),
    files: { executable: { path: 'host.exe', sha256: sha256(hostBytes) } } };
  const path = join(root, 'receipt.json'), bytes = Buffer.from(JSON.stringify(receipt));
  writeFileSync(path, bytes);
  const args = { root, version, platform: 'win32', arch: 'x64', roles: ['executable'] };
  assert.equal(validateRuntimeReceipt(receipt, args).files.executable, join(root, 'host.exe'));
  assert.throws(() => readRuntimeReceipt({ ...args, receiptPath: path }), { code: 'COMPATIBILITY_HASH_REQUIRED' });
  assert.equal(readRuntimeReceipt({ ...args, receiptPath: path, receiptSha256: sha256(bytes) }).receipt.asset.version, version);
  writeFileSync(join(root, 'host.exe'), 'modified');
  assert.throws(() => validateRuntimeReceipt(receipt, args), { code: 'COMPATIBILITY_HASH_MISMATCH' });
  assert.equal(CANDIDATE_VERSIONS.includes(version), false);
  assert.equal(typeof candidateRuntime, 'function');
});
test('external evidence requires all 21 exact-package outcomes, not old matrix labels', () => {
  const product = { version: '0.4.0', ...verifyBytes(productBytes, { integrity: integrity(productBytes) }) };
  assert.equal(releaseEvidence({ product }).passed, false);
  const results = acceptanceTargets().map(target => sealedFixture({ ...target, productSha256: product.sha256,
    hostSha256: 'b'.repeat(64), verifierSha256, scope: 'official-host-synthetic-upstream',
    realCredentialsUsed: false, passed: true, cleanupVerified: true, officialSearchCalls: 0,
    gates: FULL_ACCEPTANCE_GATES.map(id => ({ id, status: 'passed', passed: true,
      evidence: [{ path: 'evidence.json', sha256: sha256(gateBytes) }] })) },
  target.platform.split('-')[0], target.platform.split('-')[1]));
  assert.equal(releaseEvidence({ product, results }).passed, true);
  assert.equal(releaseEvidence({ product, results: results.slice(1) }).passed, false);
  assert.throws(() => releaseEvidence({ product, results: [{ ...results[0], productSha256: '0'.repeat(64) }] }),
    { code: 'COMPATIBILITY_RECEIPT_INVALID' });
  assert.throws(() => releaseEvidence({ product, results: [{ ...results[0], environment: 'native-linux' }] }),
    { code: 'COMPATIBILITY_RECEIPT_INVALID' });
  assert.throws(() => releaseEvidence({ product, results: [results[0], results[0]] }),
    { code: 'COMPATIBILITY_RECEIPT_INVALID' });
});

test('partial smoke outcomes remain failed evidence and are never reused as passes', async () => {
  const f = networkFixture();
  const { plan } = await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256 });
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-partial-')), path = join(root, 'product.tgz');
  writeFileSync(path, productBytes);
  const row = await runCompatibilitySmoke({ plan, lane: 'windows-desktop', productPath: path,
    outputRoot: root, platform: 'win32', arch: 'x64', fetchImpl: f.fetchImpl,
    runContext: { kind: 'github-actions', repository: 'owner/repo', runId: '12', runAttempt: '2', commit: 'c'.repeat(40) },
    runner: async input => {
      writeFileSync(join(input.outputRoot, 'evidence.json'), gateBytes);
      const raw = passing(input.product, input.candidate);
      raw.passed = false;
      raw.gates[2] = { id: SMOKE_GATES[2], status: 'failed', passed: false, evidence: raw.gates[0].evidence };
      raw.gates[3] = { id: SMOKE_GATES[3], status: 'not-run', passed: false, evidence: [] };
      return raw;
    } });
  assert.equal(row.result.passed, false);
  assert.equal(row.result.execution.context.commit, 'c'.repeat(40));
  const state = collectCompatibility(plan, [row]);
  assert.deepEqual(state.summary.failedLanes, ['windows-desktop']);
  assert.equal(state.summary.actualRuns, 1);
  assert.equal(state.summary.reusedRuns, 0);
  assert.equal((await discoverCompatibility({ fetchImpl: f.fetchImpl, verifierSha256, previous: state })).plan.matrix.length, 3);
});

test('executed gates require real bounded file hashes, not manufactured summary booleans', async () => {
  const product = { sha256: sha256(productBytes) }, host = verifyHostAsset(candidate(), hostBytes);
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-seal-'));
  writeFileSync(join(root, 'evidence.json'), gateBytes);
  const options = { product, candidate: host, verifierSha256, outputRoot: root,
    execution: createExecutionIdentity({ platform: 'win32', arch: 'x64' }) };
  const raw = passing(product, host);
  const absent = structuredClone(raw);
  absent.gates[0].evidence = [];
  await assert.rejects(sealExecutionResult(absent, options), { code: 'COMPATIBILITY_RECEIPT_INVALID' });
  const inconsistent = structuredClone(raw);
  inconsistent.gates[0].passed = false;
  await assert.rejects(sealExecutionResult(inconsistent, options), { code: 'COMPATIBILITY_RECEIPT_INVALID' });
  const sealed = await sealExecutionResult(raw, options);
  assert.equal(sealed.runSha256, executionSha256(sealed));
  writeFileSync(join(root, 'evidence.json'), 'changed');
  await assert.rejects(sealExecutionResult(raw, options), { code: 'COMPATIBILITY_HASH_MISMATCH' });
});

test('CLI candidate arguments bind the selected executable, manifest and declared Node range', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-cli-'));
  const asset = verifyHostAsset(npmIdentity(npmDocument('@deepseek-ai/dsh', version, hostBytes),
    { packageName: '@deepseek-ai/dsh', lane: 'linux-cli' }), hostBytes);
  const manifest = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh', version, engines: { node: asset.nodeRange } }));
  writeFileSync(join(root, 'bin.js'), hostBytes);
  writeFileSync(join(root, 'package.json'), manifest);
  const receipt = { schemaVersion: 1, kind: 'verified-runtime-candidate', asset, files: {
    executable: { path: 'bin.js', sha256: sha256(hostBytes) },
    cliManifest: { path: 'package.json', sha256: sha256(manifest) },
  } };
  const bytes = Buffer.from(JSON.stringify(receipt)), receiptPath = join(root, 'receipt.json');
  writeFileSync(receiptPath, bytes);
  const args = ['--dsh-cli', join(root, 'bin.js'), '--dsh-version', version,
    '--product-package', 'product.tgz', '--grok-linux-archive', 'grok.tar.gz', '--browser-executable', '/fixture/browser',
    '--pnpm-entry', 'pnpm.cjs', '--pnpm-store', 'store', '--pnpm-cache', 'cache',
    '--candidate-receipt', receiptPath, '--candidate-sha256', sha256(bytes), '--candidate-root', root];
  assert.equal(parseCliWebArguments(args).candidateReceipt.asset.version, version);
  assert.equal(cliNodeVersionSupported('24.9.0', version, receipt), true);
  assert.equal(cliNodeVersionSupported('22.22.2', version, receipt), false);
  assert.equal(cliNodeVersionSupported('24.9.0', version), false);
  writeFileSync(join(root, 'bin.js'), 'changed');
  assert.throws(() => parseCliWebArguments(args), { code: 'COMPATIBILITY_HASH_MISMATCH' });
});
