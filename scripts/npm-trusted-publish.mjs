import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, packageFiles } from './lib/compatibility-program-checks.mjs';

export const repository = 'Lain-in-coding/dsh-grok-search';
const packageName = 'dsh-grok-search';
const registry = 'https://registry.npmjs.org';
const apiRoot = `https://api.github.com/repos/${repository}`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const insist = (condition, code) => { if (!condition) fail(code); };
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'NPM_CHANNEL_FAILED';
const sha512 = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

export function validateRequest(env) {
  insist(env.GITHUB_REPOSITORY === repository && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.NPM_CHANNEL_RUNNER === 'github-hosted',
  'NPM_CHANNEL_CONTEXT_INVALID');
  insist(env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/npm-publish.yml@refs/heads/main`,
    'NPM_CHANNEL_WORKFLOW_INVALID');
  insist(!['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_ID_TOKEN'].some(name => env[name]),
    'NPM_CHANNEL_STATIC_CREDENTIAL_REJECTED');
  const mode = env.NPM_CHANNEL_MODE;
  insist(['check', 'publish'].includes(mode), 'NPM_CHANNEL_MODE_INVALID');
  const request = { mode, version: env.NPM_CHANNEL_VERSION ?? '', sha256: env.NPM_CHANNEL_SHA256 ?? '',
    commit: env.NPM_CHANNEL_COMMIT ?? '', offlineRun: env.NPM_CHANNEL_OFFLINE_RUN ?? '' };
  if (mode === 'check') insist(!request.version && !request.sha256 && !request.commit && !request.offlineRun,
    'NPM_CHANNEL_CHECK_MUST_NOT_PUBLISH');
  else {
    insist(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(request.version)
      && /^[a-f0-9]{64}$/.test(request.sha256) && /^[a-f0-9]{40}$/.test(request.commit)
      && /^[1-9]\d{0,19}$/.test(request.offlineRun), 'NPM_CHANNEL_EXACT_IDENTITY_REQUIRED');
  }
  return request;
}

export function validateOfflineRun(run, jobs, request) {
  insist(run.path === '.github/workflows/offline-gates.yml' && run.head_sha === request.commit
    && run.head_branch === 'main' && run.event === 'push' && run.status === 'completed'
    && run.conclusion === 'success' && run.repository?.full_name === repository,
  'NPM_CHANNEL_OFFLINE_RUN_INVALID');
  for (const name of ['Offline gates on windows-2025', 'Offline gates on ubuntu-24.04',
    'Offline gates on macos-15', 'Chromium UI smoke']) {
    const matches = jobs.filter(job => job.name === name);
    insist(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success',
      'NPM_CHANNEL_OFFLINE_GATE_MISSING');
  }
}

export function validateRelease(release, tagCommit, request) {
  insist(release.tag_name === `v${request.version}` && release.draft === false && release.prerelease === false
    && typeof release.published_at === 'string' && tagCommit === request.commit, 'NPM_CHANNEL_RELEASE_INVALID');
  const filename = `${packageName}-${request.version}.tgz`;
  const archive = release.assets.filter(asset => asset.name === filename);
  const sums = release.assets.filter(asset => asset.name === 'SHA256SUMS.txt');
  insist(archive.length === 1 && sums.length === 1 && archive[0].size > 0 && archive[0].size <= 16 * 1024 ** 2
    && sums[0].size > 0 && sums[0].size <= 256 * 1024, 'NPM_CHANNEL_RELEASE_ASSETS_INVALID');
  for (const asset of [archive[0], sums[0]]) {
    insist(asset.browser_download_url === `https://github.com/${repository}/releases/download/v${request.version}/${asset.name}`,
      'NPM_CHANNEL_RELEASE_URL_INVALID');
  }
  return { archive: archive[0], sums: sums[0], filename };
}

export function verifyFrozenPackage(bytes, checksumText, request, source) {
  const filename = `${packageName}-${request.version}.tgz`;
  insist(digest(bytes) === request.sha256, 'NPM_CHANNEL_PACKAGE_HASH_MISMATCH');
  const rows = checksumText.split(/\r?\n/).filter(Boolean);
  const matching = rows.filter(row => row.match(/^[a-f0-9]{64} [ *](.+)$/)?.[1] === filename);
  insist(matching.length === 1 && matching[0].slice(0, 64) === request.sha256,
    'NPM_CHANNEL_CHECKSUM_MISMATCH');
  const files = packageFiles(bytes), manifest = JSON.parse(files.get('package.json').toString('utf8'));
  insist(manifest.name === packageName && manifest.version === request.version && manifest.private !== true
    && manifest.publishConfig?.tag === 'latest' && manifest.publishConfig?.access === 'public'
    && manifest.repository?.url === `https://github.com/${repository}.git`
    && Array.isArray(manifest.files), 'NPM_CHANNEL_PACKAGE_IDENTITY_INVALID');
  for (const [path, packed] of files) {
    const allowed = ['package.json', 'README.md', 'LICENSE'].includes(path)
      || manifest.files.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
    insist(allowed && packed.equals(source(path)), 'NPM_CHANNEL_PACKAGE_SOURCE_MISMATCH');
  }
  for (const path of ['README.md', 'LICENSE', manifest.icon, manifest.main, 'cordis.patch.yml', 'support-matrix.json']) {
    insist(typeof path === 'string' && files.has(path), 'NPM_CHANNEL_PACKAGE_INCOMPLETE');
  }
  return { name: packageName, version: request.version, filename, sha256: request.sha256,
    integrity: sha512(bytes), size: bytes.length, fileCount: files.size, sourceCommit: request.commit };
}

export function verifyRegistryPackage(metadata, bytes, expected, tags, previousTags) {
  insist(metadata.name === packageName && metadata.version === expected.version
    && metadata.dist?.integrity === expected.integrity && sha512(bytes) === expected.integrity
    && digest(bytes) === expected.sha256, 'NPM_CHANNEL_REGISTRY_PACKAGE_MISMATCH');
  insist(tags.latest === expected.version && tags.next === previousTags.next, 'NPM_CHANNEL_REGISTRY_TAG_MISMATCH');
}

export async function checkTrustedIdentity(env, fetchImpl = fetch, mask = value => console.log(`::add-mask::${value}`)) {
  insist(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'NPM_CHANNEL_OIDC_PERMISSION_MISSING');
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  insist(url.protocol === 'https:', 'NPM_CHANNEL_OIDC_URL_INVALID');
  url.searchParams.set('audience', 'npm:registry.npmjs.org');
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(30_000) });
  insist(response.ok, 'NPM_CHANNEL_GITHUB_IDENTITY_FAILED');
  const identity = await response.json();
  insist(typeof identity.value === 'string' && identity.value.length > 0, 'NPM_CHANNEL_GITHUB_IDENTITY_MISSING');
  mask(identity.value);
  // The package-scoped exchange is the same endpoint used by the native npm CLI.
  const exchange = await fetchImpl(`${registry}/-/npm/v1/oidc/token/exchange/package/${packageName}`, {
    method: 'POST', headers: { Authorization: `Bearer ${identity.value}` }, signal: AbortSignal.timeout(30_000),
  });
  insist(exchange.ok, 'NPM_CHANNEL_TRUST_BINDING_REJECTED');
  const credential = await exchange.json();
  insist(typeof credential.token === 'string' && credential.token.length > 0, 'NPM_CHANNEL_EXCHANGE_TOKEN_MISSING');
  mask(credential.token);
  return { authenticated: true, package: packageName, credentialPersisted: false,
    scope: 'github-actions-identity-and-package-specific-npm-token-exchange',
    published: false, directPublishPermission: 'verify-the-saved-trust-configuration-and-first-actual-publish' };
}

async function githubJson(path, env) {
  const response = await fetch(`${apiRoot}${path}`, { headers: { Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
  insist(response.ok, 'NPM_CHANNEL_GITHUB_REQUEST_FAILED');
  return response.json();
}

async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  insist(response.ok, 'NPM_CHANNEL_DOWNLOAD_FAILED');
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    insist(size <= limit, 'NPM_CHANNEL_DOWNLOAD_LIMIT');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

async function registryJson(path, missing = false) {
  const response = await fetch(`${registry}/${path}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  if (missing && response.status === 404) return null;
  insist(response.ok, 'NPM_CHANNEL_REGISTRY_REQUEST_FAILED');
  return response.json();
}

async function publishOnce(path, env) {
  return new Promise(done => {
    const child = spawn('npm', ['publish', path, '--tag', 'latest', '--access', 'public',
      '--ignore-scripts', `--registry=${registry}`], { shell: false, stdio: ['ignore', 'inherit', 'inherit'], env });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 180_000);
    child.once('error', () => { clearTimeout(timer); done({ code: null, startFailed: true, timedOut }); });
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, timedOut }); });
  });
}

export async function runChannel(env = process.env) {
  const request = validateRequest(env);
  insist(typeof env.NPM_CHANNEL_OUTPUT === 'string' && isAbsolute(env.NPM_CHANNEL_OUTPUT),
    'NPM_CHANNEL_OUTPUT_INVALID');
  mkdirSync(env.NPM_CHANNEL_OUTPUT, { recursive: true, mode: 0o700 });
  const result = { schemaVersion: 1, mode: request.mode, repository, passed: false, published: false,
    packageBytesChanged: false, credentialsPersisted: false, code: null };
  try {
    if (request.mode === 'check') Object.assign(result, await checkTrustedIdentity(env), { passed: true });
    else {
      insist(env.GH_TOKEN && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''), 'NPM_CHANNEL_GITHUB_CONTEXT_MISSING');
      execFileSync('git', ['merge-base', '--is-ancestor', request.commit, env.GITHUB_SHA], { stdio: 'pipe' });
      const run = await githubJson(`/actions/runs/${request.offlineRun}`, env), jobs = [];
      for (let page = 1; ; page++) {
        const rows = (await githubJson(`/actions/runs/${request.offlineRun}/jobs?per_page=100&page=${page}`, env)).jobs;
        jobs.push(...rows);
        if (rows.length < 100) break;
        insist(page < 10, 'NPM_CHANNEL_JOBS_LIMIT');
      }
      validateOfflineRun(run, jobs, request);
      const release = await githubJson(`/releases/tags/v${request.version}`, env);
      let tag = (await githubJson(`/git/ref/tags/v${request.version}`, env)).object;
      for (let depth = 0; tag.type === 'tag'; depth++) {
        insist(depth < 5, 'NPM_CHANNEL_TAG_DEPTH');
        tag = (await githubJson(`/git/tags/${tag.sha}`, env)).object;
      }
      insist(tag.type === 'commit', 'NPM_CHANNEL_TAG_INVALID');
      const assets = validateRelease(release, tag.sha, request);
      const bytes = await download(assets.archive.browser_download_url, 16 * 1024 ** 2);
      insist(bytes.length === assets.archive.size, 'NPM_CHANNEL_DOWNLOAD_SIZE_MISMATCH');
      const sums = await download(assets.sums.browser_download_url, 256 * 1024);
      const expected = verifyFrozenPackage(bytes, sums.toString('utf8'), request,
        path => execFileSync('git', ['show', `${request.commit}:${path}`], { maxBuffer: 16 * 1024 ** 2 }));
      Object.assign(result, { package: expected, offlineRun: request.offlineRun,
        offlineRunUrl: run.html_url, releaseUrl: release.html_url });
      const before = await registryJson(packageName), previousTags = before['dist-tags'] ?? {};
      const existing = await registryJson(`${packageName}/${request.version}`, true);
      const path = join(env.NPM_CHANNEL_OUTPUT, expected.filename);
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      if (!existing) {
        const latest = previousTags.latest?.match(/^(\d+)\.(\d+)\.(\d+)$/);
        insist(latest && latest.slice(1).map(Number).some((part, index, values) => {
          const target = request.version.split('.').map(Number);
          return values.slice(0, index).every((value, prior) => value === target[prior]) && part < target[index];
        }), 'NPM_CHANNEL_LATEST_DOWNGRADE_REJECTED');
        result.publishAttempt = await publishOnce(path, env);
      } else result.alreadyPublished = true;
      // A failed or interrupted upload is checked, never blindly published a second time.
      let verified = false, verificationError;
      for (let attempt = 0; attempt < 6 && !verified; attempt++) {
        try {
          const metadata = await registryJson(`${packageName}/${request.version}`);
          insist(typeof metadata.dist?.tarball === 'string'
            && new URL(metadata.dist.tarball).origin === registry, 'NPM_CHANNEL_REGISTRY_URL_INVALID');
          const publishedBytes = await download(metadata.dist.tarball, 16 * 1024 ** 2);
          const tags = (await registryJson(packageName))['dist-tags'] ?? {};
          verifyRegistryPackage(metadata, publishedBytes, expected, tags, previousTags);
          result.distTags = tags;
          verified = true;
        } catch (error) {
          verificationError = error;
          if (attempt < 5) await new Promise(done => setTimeout(done, 5000));
        }
      }
      if (!verified) throw verificationError;
      insist(readFileSync(path).equals(bytes), 'NPM_CHANNEL_LOCAL_PACKAGE_CHANGED');
      Object.assign(result, { passed: true, published: true, registryDownloadVerified: true });
    }
  } catch (error) { result.code = safeCode(error); }
  json(join(env.NPM_CHANNEL_OUTPUT, 'result.json'), result);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runChannel();
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(safeCode(error));
    process.exitCode = 1;
  }
}
