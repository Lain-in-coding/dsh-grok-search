import { mkdirSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  COMPATIBILITY_LANES, EVIDENCE_LIMITS, SMOKE_GATES, assertAssetUnchanged, confinedPath, createExecutionIdentity,
  desktopCandidates, downloadHostAsset, evidenceError, exactVersion, fetchVerifiedResource, hashFile,
  npmIdentity, officialMetadataUrl, readJsonReceipt, requireSha256,
  rememberAssets, sealExecutionResult, sha256, validateCandidate, validateOfficialUrl, validateSmokeResult, verifyBytes,
} from './lib/compatibility-evidence.mjs';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNAL_URL = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=20';
const PRODUCT_FEED = 'https://registry.npmjs.org/dsh-grok-search';
const safeCode = error => /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'COMPATIBILITY_FAILED';
const insist = (condition, code, message) => { if (!condition) throw evidenceError(code, message); };
const metadataPolicy = (lane, packageName) => url => validateOfficialUrl(url, { kind: 'metadata', lane, packageName });
const fetchData = (url, validateUrl, options) => fetchVerifiedResource(url, { ...options, validateUrl });

export function smokeKey({ product, candidate, verifierSha256 }) {
  validateCandidate(candidate);
  return sha256(JSON.stringify({
    product: requireSha256(product.sha256), host: candidate.integrity,
    source: candidate.source.url, lane: candidate.lane, version: candidate.version,
    verifier: requireSha256(verifierSha256), gates: SMOKE_GATES,
  }));
}

export async function discoverCompatibility({ target = 'released', candidatePath, candidateSha256,
  previous = null, verifierSha256, fetchImpl = globalThis.fetch, signal } = {}) {
  requireSha256(verifierSha256);
  insist(['released', 'candidate'].includes(target), 'COMPATIBILITY_TARGET_INVALID', 'Unknown product selection.');
  if (previous !== null) {
    insist(previous.schemaVersion === 1 && previous.kind === 'compatibility-watch-state'
      && Array.isArray(previous.candidates) && Array.isArray(previous.results),
    'COMPATIBILITY_RECEIPT_INVALID', 'Invalid previous watch state.');
  }
  // First observations survive failed lanes and later releases; a failed round must not reset trust.
  let observations = rememberAssets(previous?.observations ?? previous?.candidates ?? []);
  const options = { fetchImpl, signal };
  const issues = [];
  // Releases are only a signal; assets are discovered exclusively from the official feeds.
  let releases = [];
  try {
    const bytes = await fetchData(SIGNAL_URL, url => insist(url === SIGNAL_URL,
      'COMPATIBILITY_URL_UNTRUSTED', 'The release signal cannot redirect.'), options);
    const rows = JSON.parse(bytes.toString('utf8'));
    insist(Array.isArray(rows), 'COMPATIBILITY_METADATA_INVALID', 'Invalid release signal.');
    releases = rows.slice(0, 20).filter(row => !row.draft && typeof row.tag_name === 'string')
      .map(row => ({ tag: row.tag_name.slice(0, 128), prerelease: row.prerelease === true }));
  } catch (error) {
    signal?.throwIfAborted();
    issues.push({ source: 'github-signal', code: safeCode(error), required: false });
  }
  let product, productBytes;
  if (target === 'released') {
    insist(candidatePath === undefined && candidateSha256 === undefined,
      'COMPATIBILITY_TARGET_INVALID', 'Released mode cannot override the npm package.');
    const metadata = await fetchData(PRODUCT_FEED, metadataPolicy(null, 'dsh-grok-search'), options);
    const identity = npmIdentity(metadata, { packageName: 'dsh-grok-search' });
    productBytes = await fetchData(identity.source.url,
      url => validateOfficialUrl(url, { kind: 'npm-tarball', packageName: identity.name }),
      { ...options, limit: EVIDENCE_LIMITS.product });
    product = { ...identity, target, ...verifyBytes(productBytes, identity) };
  } else {
    requireSha256(candidateSha256);
    insist(typeof candidatePath === 'string' && isAbsolute(candidatePath),
      'COMPATIBILITY_TARGET_INVALID', 'Candidate mode requires a local absolute tarball and its frozen hash.');
    const stat = lstatSync(candidatePath);
    insist(stat.isFile() && !stat.isSymbolicLink() && stat.size <= EVIDENCE_LIMITS.product,
      'COMPATIBILITY_PATH_UNSAFE', 'Candidate input must be a bounded ordinary tarball.');
    productBytes = readFileSync(candidatePath);
    const receipt = readJsonReceipt(join(dirname(candidatePath), 'package-receipt.json'));
    insist(receipt.sha256 === candidateSha256, 'COMPATIBILITY_HASH_MISMATCH', 'Candidate receipt and supplied hash differ.');
    product = { schemaVersion: 1, kind: 'product-candidate', name: 'dsh-grok-search',
      version: exactVersion(receipt.version), target, ...verifyBytes(productBytes, { sha256: candidateSha256 }) };
  }
  const candidates = [];
  for (const lane of Object.keys(COMPATIBILITY_LANES)) {
    try {
      const metadata = await fetchData(officialMetadataUrl(lane), metadataPolicy(lane), options);
      const available = lane === 'linux-cli'
        ? [npmIdentity(metadata, { packageName: '@deepseek-ai/dsh', lane })]
        : desktopCandidates(metadata, lane);
      const selected = available.find(row => row.source.url.endsWith('.zip')) ?? available[0];
      assertAssetUnchanged(selected, observations);
      observations = rememberAssets(observations, available);
      candidates.push(selected);
    } catch (error) {
      signal?.throwIfAborted();
      issues.push({ lane, code: safeCode(error), required: true });
    }
  }
  const results = [];
  const matrix = [];
  for (const candidate of candidates) {
    const key = smokeKey({ product, candidate, verifierSha256 });
    const old = previous?.results.find(row => row.key === key);
    if (old) {
      try {
        requireSha256(old.candidate?.sha256);
        insist(smokeKey({ product, candidate: old.candidate, verifierSha256 }) === key,
        'COMPATIBILITY_RECEIPT_INVALID', 'Previous smoke candidate differs.');
        validateSmokeResult(old.result, { product, candidate: old.candidate, verifierSha256 });
        const age = Date.now() - Date.parse(old.result.execution.finishedAt);
        insist(age >= 0 && age < 6 * 24 * 60 * 60 * 1000,
          'COMPATIBILITY_REUSE_EXPIRED', 'Refresh execution before its retained gate artifacts expire.');
        results.push({ ...old, reused: true });
        continue;
      } catch { issues.push({ lane: candidate.lane, code: 'COMPATIBILITY_REUSE_REJECTED', required: false }); }
    }
    matrix.push({ lane: candidate.lane, runner: COMPATIBILITY_LANES[candidate.lane].runner, key });
  }
  return {
    plan: { schemaVersion: 1, kind: 'compatibility-watch-plan', target, product, verifierSha256,
      releases, candidates, observations, results, matrix, issues, passed: false, published: false,
      fullAcceptanceRun: false, generatedAt: new Date().toISOString() },
    productBytes,
  };
}

export function smokeEnvironment(environment = process.env, root) {
  const allowed = /^(?:PATH|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATHEXT|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY)$/i;
  return { ...Object.fromEntries(Object.entries(environment).filter(([name, value]) => allowed.test(name) && typeof value === 'string')),
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    DSH_HOME: join(root, 'dsh-home'), XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_DATA_HOME: join(root, 'xdg-data'),
    DSH_TELEMETRY_DISABLED: '1', CI: '1' };
}

export async function runCompatibilitySmoke({ plan, lane, productPath, outputRoot, runner,
  fetchImpl = globalThis.fetch, signal, platform = process.platform, arch = process.arch,
  runContext = { kind: 'local' } } = {}) {
  insist(plan?.schemaVersion === 1 && plan.kind === 'compatibility-watch-plan',
    'COMPATIBILITY_RECEIPT_INVALID', 'Expected a watch plan.');
  const spec = COMPATIBILITY_LANES[lane];
  insist(spec && spec.platform === platform && spec.arch === arch,
    'COMPATIBILITY_LANE_INVALID', 'The smoke process must match the candidate platform and architecture.');
  const candidate = plan.candidates.find(row => row.lane === lane);
  validateCandidate(candidate);
  insist(typeof runner === 'function', 'COMPATIBILITY_SMOKE_RUNNER_UNAVAILABLE',
    'The reviewed local host smoke runner is not installed; no acceptance is claimed.');
  insist(await hashFile(productPath, { limit: EVIDENCE_LIMITS.product }) === plan.product.sha256,
    'COMPATIBILITY_HASH_MISMATCH', 'Product path differs from the frozen package.');
  const productBytes = readFileSync(productPath);
  verifyBytes(productBytes, plan.product);
  const suffix = lane === 'linux-cli' ? '.tgz' : new URL(candidate.source.url).pathname.match(/\.[a-z0-9]+$/)[0];
  const assetPath = confinedPath(outputRoot, 'official-host' + suffix, { allowMissing: true });
  const verified = await downloadHostAsset(candidate, assetPath, { fetchImpl, signal });
  const env = smokeEnvironment(process.env, outputRoot);
  for (const name of ['home', 'appdata', 'localappdata', 'tmp', 'dsh-home', 'xdg-config', 'xdg-cache', 'xdg-data']) {
    mkdirSync(confinedPath(outputRoot, name, { allowMissing: true }), { mode: 0o700 });
  }
  // runner is a reviewed, fixed local import, never a command or module URL from metadata.
  const execution = createExecutionIdentity({ platform, arch, context: runContext });
  const raw = await runner({ product: structuredClone(plan.product), productPath, candidate: structuredClone(verified),
    assetPath, outputRoot, environment: env, signal, verifierSha256: plan.verifierSha256,
    execution: structuredClone(execution), requiredGates: [...SMOKE_GATES],
    noLiveServices: true, extractionMustBeConfined: true });
  const result = await sealExecutionResult(raw, { product: plan.product, candidate: verified,
    verifierSha256: plan.verifierSha256, execution, outputRoot });
  validateSmokeResult(result, { product: plan.product, candidate: verified,
    verifierSha256: plan.verifierSha256, requirePassed: false });
  insist(await hashFile(assetPath) === verified.sha256 && await hashFile(productPath) === plan.product.sha256,
    'COMPATIBILITY_ASSET_CHANGED', 'Smoke execution modified its frozen inputs.');
  return { key: smokeKey({ product: plan.product, candidate, verifierSha256: plan.verifierSha256 }),
    candidate: verified, result, reused: false };
}

export function collectCompatibility(plan, results = []) {
  insist(plan?.kind === 'compatibility-watch-plan' && Array.isArray(results),
    'COMPATIBILITY_RECEIPT_INVALID', 'Invalid compatibility collection.');
  const all = [...plan.results, ...results], seen = new Set();
  for (const row of all) {
    const candidate = plan.candidates.find(item => item.lane === row.candidate?.lane);
    insist(candidate && !seen.has(candidate.lane), 'COMPATIBILITY_RECEIPT_INVALID', 'Unexpected or duplicate smoke result.');
    insist(row.key === smokeKey({ product: plan.product, candidate, verifierSha256: plan.verifierSha256 })
      && row.key === smokeKey({ product: plan.product, candidate: row.candidate, verifierSha256: plan.verifierSha256 }),
    'COMPATIBILITY_RECEIPT_INVALID', 'Smoke identity differs from discovery.');
    validateSmokeResult(row.result, { product: plan.product, candidate: row.candidate,
      verifierSha256: plan.verifierSha256, requirePassed: row.reused === true });
    seen.add(candidate.lane);
  }
  const missing = Object.keys(COMPATIBILITY_LANES).filter(lane => !seen.has(lane));
  return { schemaVersion: 1, kind: 'compatibility-watch-state', product: plan.product,
    verifierSha256: plan.verifierSha256, candidates: plan.candidates, results: all,
    observations: rememberAssets(plan.observations ?? plan.candidates, all.map(row => row.candidate)),
    summary: { actualRuns: all.filter(row => !row.reused).length, reusedRuns: all.filter(row => row.reused).length,
      passedLanes: all.filter(row => row.result.passed).length,
      failedLanes: all.filter(row => !row.result.passed).map(row => row.candidate.lane), missingLanes: missing,
      runSha256: all.map(row => row.result.runSha256) },
    issues: plan.issues, passed: !plan.issues.some(row => row.required)
      && missing.length === 0 && all.every(row => row.result.passed),
    fullAcceptanceRun: false, published: false };
}

export function createOutputRoot(path, parent = process.env.RUNNER_TEMP || tmpdir()) {
  insist(typeof path === 'string' && isAbsolute(path) && isAbsolute(parent),
    'COMPATIBILITY_PATH_UNSAFE', 'Output needs an absolute temporary path.');
  const canonicalParent = realpathSync(parent), rel = relative(resolve(parent), resolve(path));
  insist(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
    && /^dsh-compatibility-[a-zA-Z0-9_-]+$/.test(rel),
  'COMPATIBILITY_PATH_UNSAFE', 'Output must be a new compatibility directory directly inside the temporary root.');
  const target = join(canonicalParent, rel);
  insist(!lstatSync(target, { throwIfNoEntry: false }), 'COMPATIBILITY_PATH_UNSAFE', 'Output directory already exists.');
  mkdirSync(target, { mode: 0o700 });
  return target;
}
export function parseWatchArguments(args) {
  const options = { mode: 'discover', target: 'released', results: [] };
  const flags = new Set(['mode', 'target', 'candidate-path', 'candidate-sha256', 'previous', 'output-root',
    'plan', 'plan-sha256', 'lane', 'product-path', 'result', 'run-repository', 'run-id', 'run-attempt', 'run-commit']);
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.slice(2);
    insist(args[i]?.startsWith('--') && flags.has(name) && typeof args[i + 1] === 'string'
      && !args[i + 1].startsWith('--') && (name === 'result' || !seen.has(name)),
    'COMPATIBILITY_ARGUMENT_INVALID', 'Invalid or repeated compatibility argument.');
    seen.add(name);
    if (name === 'result') options.results.push(args[i + 1]);
    else options[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = args[i + 1];
  }
  insist(['discover', 'smoke', 'collect'].includes(options.mode) && ['released', 'candidate'].includes(options.target)
    && options.outputRoot, 'COMPATIBILITY_ARGUMENT_INVALID', 'A valid mode and new --output-root are required.');
  if (options.target === 'candidate') {
    insist(options.candidatePath && options.candidateSha256, 'COMPATIBILITY_HASH_REQUIRED', 'Candidate mode requires the frozen tarball SHA-256.');
    requireSha256(options.candidateSha256);
  }
  if (options.mode !== 'discover') {
    insist(options.plan && options.planSha256, 'COMPATIBILITY_HASH_REQUIRED', 'The exact discovery plan and SHA-256 are required.');
    requireSha256(options.planSha256);
  }
  const fields = ['runRepository', 'runId', 'runAttempt', 'runCommit'];
  if (fields.some(key => options[key] !== undefined)) {
    insist(options.mode === 'smoke' && fields.every(key => options[key] !== undefined),
      'COMPATIBILITY_ARGUMENT_INVALID', 'Actions evidence requires all four run identity arguments.');
    options.runContext = { kind: 'github-actions', repository: options.runRepository,
      runId: options.runId, runAttempt: options.runAttempt, commit: options.runCommit };
    createExecutionIdentity({ platform: process.platform, arch: process.arch, context: options.runContext });
  }
  return options;
}
// Keep computed-import and subprocess entry points explicit; tests check their local import closure.
export const VERIFIER_INPUT_PATHS = Object.freeze([
  '.github/workflows/compatibility-watch.yml', 'package-lock.json',
  'scripts/compatibility-watch.mjs', 'scripts/lib/compatibility-evidence.mjs',
  'scripts/lib/compatibility-smoke.mjs', 'scripts/compatibility-smoke-host.mjs',
  'scripts/lib/compatibility-process.mjs',
  'scripts/lib/candidate-runtime.mjs', 'scripts/lib/asar.mjs', 'scripts/b3-cli-web.mjs',
  'scripts/lib/renderer-cdp.mjs', 'scripts/lib/browser-gates.mjs',
  'scripts/lib/internal-candidate-utils.mjs', 'scripts/deferred-release-desktop-prepare.mjs',
  'scripts/verify-search-execution-host.mjs', 'scripts/verify-github-read-host.mjs',
  'scripts/verify-tool-budget-host.mjs', 'fixtures/cli-web/fixture.mjs',
  'fixtures/deferred-release/desktop-fixture.mjs', 'fixtures/internal-candidate/host-fixture.mjs',
]);
export async function verifierIdentity(projectRoot = PROJECT) {
  return sha256(JSON.stringify(await Promise.all(VERIFIER_INPUT_PATHS.map(async path =>
    [path, await hashFile(confinedPath(projectRoot, path))]))));
}
async function main() {
  const options = parseWatchArguments(process.argv.slice(2));
  const root = createOutputRoot(options.outputRoot);
  const write = (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    writeFileSync(confinedPath(root, name, { allowMissing: true }), bytes, { flag: 'wx', mode: 0o600 });
    return sha256(bytes);
  };
  try {
    if (options.mode === 'discover') {
      const previous = options.previous ? readJsonReceipt(options.previous) : null;
      const { plan, productBytes } = await discoverCompatibility({ ...options, previous, verifierSha256: await verifierIdentity() });
      writeFileSync(join(root, 'product.tgz'), productBytes, { flag: 'wx', mode: 0o600 });
      const planSha256 = write('plan.json', plan);
      console.log(JSON.stringify({ planSha256, matrix: { include: plan.matrix }, outputRoot: root,
        productSha256: plan.product.sha256, issues: plan.issues }));
    } else {
      const plan = readJsonReceipt(options.plan, options.planSha256);
      insist(plan.verifierSha256 === await verifierIdentity(), 'COMPATIBILITY_HASH_MISMATCH', 'Verifier changed since discovery.');
      if (options.mode === 'smoke') {
        const modulePath = join(PROJECT, 'scripts/lib/compatibility-smoke.mjs');
        insist(lstatSync(modulePath, { throwIfNoEntry: false })?.isFile(),
          'COMPATIBILITY_SMOKE_RUNNER_UNAVAILABLE', 'The fixed local smoke runner is unavailable.');
        const { runCompatibilitySmoke: runner } = await import(pathToFileURL(modulePath).href);
        const row = await runCompatibilitySmoke({ plan, lane: options.lane,
          productPath: options.productPath, outputRoot: root, runner, runContext: options.runContext });
        write('smoke.json', row);
        console.log(JSON.stringify({ lane: row.candidate.lane, passed: row.result.passed,
          productSha256: row.result.productSha256, hostSha256: row.result.hostSha256,
          verifierSha256: row.result.verifierSha256, runSha256: row.result.runSha256,
          gates: row.result.gates.map(({ id, status }) => ({ id, status })) }));
        if (!row.result.passed) process.exitCode = 1;
      } else {
        let state;
        try { state = collectCompatibility(plan, options.results.map(path => readJsonReceipt(path))); }
        catch (error) {
          state = collectCompatibility({ ...plan, results: [],
            issues: [...plan.issues, { code: safeCode(error), required: true, source: 'collection' }] });
        }
        write('state.json', state);
        console.log(JSON.stringify({ passed: state.passed, productSha256: state.product.sha256, ...state.summary }));
        if (!state.passed) process.exitCode = 1;
      }
    }
  } catch (error) {
    write('failure.json', { passed: false, code: safeCode(error), mode: options.mode, lane: options.lane ?? null,
      fullAcceptanceRun: false, published: false });
    console.error(safeCode(error));
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
