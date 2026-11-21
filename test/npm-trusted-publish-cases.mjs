import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { digest, tarGzip } from '../scripts/lib/compatibility-program-checks.mjs';
import { checkTrustedIdentity, repository, validateOfflineRun, validateRelease, validateRequest,
  verifyFrozenPackage, verifyRegistryPackage } from '../scripts/npm-trusted-publish.mjs';

const env = { GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/npm-publish.yml@refs/heads/main`,
  NPM_CHANNEL_RUNNER: 'github-hosted', NPM_CHANNEL_MODE: 'check' };
const request = { mode: 'publish', version: '0.4.2', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), offlineRun: '123' };
const run = { repository: { full_name: repository }, path: '.github/workflows/offline-gates.yml',
  head_sha: request.commit, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
const jobs = ['Offline gates on windows-2025', 'Offline gates on ubuntu-24.04',
  'Offline gates on macos-15', 'Chromium UI smoke'].map(name => ({ name, status: 'completed', conclusion: 'success' }));

test('trusted publishing utilities import from standard input without starting authentication or publishing', () => {
  const url = new URL('../scripts/npm-trusted-publish.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: `await import(${JSON.stringify(url)}); console.log('IMPORTED');`,
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'IMPORTED');
});

test('trusted publishing is explicit, main-only and rejects static credentials and incomplete identities', () => {
  assert.equal(validateRequest(env).mode, 'check');
  const publish = { ...env, NPM_CHANNEL_MODE: 'publish', NPM_CHANNEL_VERSION: request.version,
    NPM_CHANNEL_SHA256: request.sha256, NPM_CHANNEL_COMMIT: request.commit, NPM_CHANNEL_OFFLINE_RUN: request.offlineRun };
  assert.deepEqual(validateRequest(publish), request);
  for (const change of [{ GITHUB_REF: 'refs/heads/other' }, { GITHUB_EVENT_NAME: 'schedule' },
    { GITHUB_REPOSITORY: 'untrusted/repo' }, { NPM_CHANNEL_RUNNER: 'self-hosted' },
    { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@refs/heads/main` },
    { NPM_TOKEN: 'synthetic-static-token' }, { NODE_AUTH_TOKEN: 'synthetic-static-token' },
    { NPM_CHANNEL_VERSION: '0.4.2' }]) assert.throws(() => validateRequest({ ...env, ...change }));
  for (const change of [{ NPM_CHANNEL_SHA256: '' }, { NPM_CHANNEL_COMMIT: 'main' },
    { NPM_CHANNEL_VERSION: '0.4.2; echo injected' }, { NPM_CHANNEL_OFFLINE_RUN: '../123' }]) {
    assert.throws(() => validateRequest({ ...publish, ...change }));
  }
});

test('only complete successful offline gates for the exact reviewed commit are accepted', () => {
  validateOfflineRun(run, jobs, request);
  for (const change of [{ head_sha: 'c'.repeat(40) }, { event: 'pull_request' }, { conclusion: 'failure' },
    { path: '.github/workflows/compatibility-watch.yml' }, { status: 'in_progress' }]) {
    assert.throws(() => validateOfflineRun({ ...run, ...change }, jobs, request));
  }
  assert.throws(() => validateOfflineRun(run, jobs.slice(1), request));
  assert.throws(() => validateOfflineRun(run, [...jobs, jobs[0]], request));
  assert.throws(() => validateOfflineRun(run, jobs.map((row, i) => i ? row : { ...row, conclusion: 'skipped' }), request));
});

test('release identity and exact public download assets cannot be substituted', () => {
  const asset = (name, size) => ({ name, size,
    browser_download_url: `https://github.com/${repository}/releases/download/v${request.version}/${name}` });
  const release = { tag_name: 'v0.4.2', draft: false, prerelease: false, published_at: '2026-11-21T00:00:00Z',
    assets: [asset('dsh-grok-search-0.4.2.tgz', 100), asset('SHA256SUMS.txt', 100)] };
  assert.equal(validateRelease(release, request.commit, request).filename, 'dsh-grok-search-0.4.2.tgz');
  assert.throws(() => validateRelease(release, 'c'.repeat(40), request));
  for (const change of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.4.1' },
    { assets: [release.assets[0]] }, { assets: [...release.assets, release.assets[0]] },
    { assets: [{ ...release.assets[0], browser_download_url: 'https://untrusted.invalid/file' }, release.assets[1]] }]) {
    assert.throws(() => validateRelease({ ...release, ...change }, request.commit, request));
  }
});

function fixture() {
  const manifest = { name: 'dsh-grok-search', version: '0.4.2', main: 'src/bundle.mjs', icon: 'icon.png',
    files: ['src/bundle.mjs', 'icon.png', 'cordis.patch.yml', 'support-matrix.json'],
    repository: { url: `https://github.com/${repository}.git` }, publishConfig: { tag: 'latest', access: 'public' } };
  const files = new Map([['package.json', Buffer.from(JSON.stringify(manifest))],
    ...['README.md', 'LICENSE', 'src/bundle.mjs', 'icon.png', 'cordis.patch.yml', 'support-matrix.json']
      .map(path => [path, Buffer.from('synthetic-' + path)])]);
  const bytes = tarGzip([...files].map(([path, value]) => ['package/' + path, value]));
  const expected = { ...request, sha256: digest(bytes) };
  const sums = `${expected.sha256}  dsh-grok-search-0.4.2.tgz\n`;
  return { files, bytes, expected, sums };
}

test('frozen archive bytes, checksum and all packed source files must match without repacking', () => {
  const { files, bytes, expected, sums } = fixture();
  const result = verifyFrozenPackage(bytes, sums, expected, path => files.get(path));
  assert.equal(result.fileCount, files.size);
  assert.equal(result.size, bytes.length);
  assert.throws(() => verifyFrozenPackage(bytes, sums, request, path => files.get(path)));
  assert.throws(() => verifyFrozenPackage(bytes, sums.replace(expected.sha256, 'c'.repeat(64)), expected, path => files.get(path)));
  assert.throws(() => verifyFrozenPackage(bytes, sums + sums, expected, path => files.get(path)));
  assert.throws(() => verifyFrozenPackage(bytes, sums, expected, () => Buffer.from('substituted')));
  const extra = tarGzip([...files, ['backend/private.patch', Buffer.from('unapproved')]]
    .map(([path, value]) => ['package/' + path, value]));
  assert.throws(() => verifyFrozenPackage(extra, sums.replace(expected.sha256, digest(extra)),
    { ...expected, sha256: digest(extra) }, path => files.get(path)));
});

test('registry verification rejects altered archives and changes to next', () => {
  const { files, bytes, expected, sums } = fixture();
  const product = verifyFrozenPackage(bytes, sums, expected, path => files.get(path));
  const metadata = { name: product.name, version: product.version, dist: { integrity: product.integrity } };
  const before = { latest: '0.4.1', next: '0.1.1' }, after = { latest: '0.4.2', next: '0.1.1' };
  verifyRegistryPackage(metadata, bytes, product, after, before);
  assert.throws(() => verifyRegistryPackage(metadata, Buffer.from('wrong'), product, after, before));
  assert.throws(() => verifyRegistryPackage(metadata, bytes, product, { ...after, next: '0.4.2' }, before));
  assert.throws(() => verifyRegistryPackage(metadata, bytes, product, before, before));
});

test('OIDC check uses only the package-scoped exchange, masks ephemeral tokens and never publishes', async () => {
  const requests = [], masked = [];
  const result = await checkTrustedIdentity({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://identity.synthetic.invalid/?request=1',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-request-token' }, async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => requests.length === 1
      ? { value: 'synthetic-id-token' } : { token: 'synthetic-npm-token' } };
  }, value => masked.push(value));
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).searchParams.get('audience'), 'npm:registry.npmjs.org');
  assert.equal(requests[1].url, 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/dsh-grok-search');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer synthetic-id-token');
  assert.deepEqual(masked, ['synthetic-id-token', 'synthetic-npm-token']);
  assert.equal(result.published, false);
  assert.equal(result.credentialPersisted, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic.*token/);
  await assert.rejects(checkTrustedIdentity({}, () => { throw new Error('must not call'); }));
  await assert.rejects(checkTrustedIdentity({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://identity.synthetic.invalid/',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic' }, async () => ({ ok: false }), () => {}));
});

test('channel workflow is dispatch-only, pinned, tokenless and uploads only its sanitized receipt', () => {
  const text = readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
  assert.match(text, /workflow_dispatch:/);
  assert.doesNotMatch(text, /^\s+(?:schedule|push|pull_request):/m);
  assert.match(text, /id-token: write/);
  assert.match(text, /options: \[check, publish\]/);
  assert.match(text, /cancel-in-progress: false/);
  assert.doesNotMatch(text, /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|npm (?:pack|login|stage)|npm publish/);
  for (const match of text.matchAll(/uses: (\S+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
  assert.match(text, /retention-days: 30/);
  assert.match(text, /path: \$\{\{ runner.temp \}\}\/npm-trusted-publish\/result\.json/);
  const jobEnv = text.slice(text.indexOf('    env:\n'), text.indexOf('    steps:\n'));
  assert.doesNotMatch(jobEnv, /runner\./, 'Runner context is only available after job dispatch.');
  const closure = readFileSync(new URL('../scripts/macos-full-acceptance.mjs', import.meta.url), 'utf8');
  for (const path of ['scripts/npm-trusted-publish.mjs', 'test/npm-trusted-publish-cases.mjs',
    '.github/workflows/npm-publish.yml']) assert.ok(closure.includes(`'${path}'`));
});
