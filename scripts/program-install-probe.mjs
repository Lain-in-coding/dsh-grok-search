import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createPrivateProgramInstaller, resolveGrokProgram } from '../src/core/program-install.mjs';
import { freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { runBoundedCommand } from './lib/compatibility-process.mjs';
import { PROGRAM_CASE_IDS, PROGRAM_CASE_MARKER, PROGRAM_MARKER, tarGzip } from './lib/compatibility-program-checks.mjs';
import { programEnvironment } from './compatibility-program-host.mjs';
import { COMPATIBILITY_SMOKE_MARKER } from './compatibility-smoke-host.mjs';
import { inspectPackage } from './lib/compatibility-smoke.mjs';
import { readUpgradePackage } from './verify-search-log-upgrade.mjs';

export function parseProgramProbeArguments(args) {
  const usage = 'Usage: node scripts/program-install-probe.mjs [--mirror-only] [--host-desktop <exe>'
    + ' [--runtime-receipt <json> --runtime-receipt-sha256 <hash> --receipt-root <root>]'
    + ' [--product-package <tgz> --product-sha256 <hash>]]';
  const values = {};
  let mirrorOnly = false;
  const flags = ['--host-desktop', '--runtime-receipt', '--runtime-receipt-sha256',
    '--receipt-root', '--product-package', '--product-sha256'];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--mirror-only' && !mirrorOnly) mirrorOnly = true;
    else if (flags.includes(flag) && !Object.hasOwn(values, flag)
      && args[index + 1] && !args[index + 1].startsWith('--')) values[flag] = args[++index];
    else throw new Error(usage);
  }
  const receiptValues = flags.slice(1, 4).map(flag => values[flag]);
  const packageValues = flags.slice(4).map(flag => values[flag]);
  if (receiptValues.some(value => value !== undefined)
    && (!values['--host-desktop'] || receiptValues.some(value => value === undefined))
    || packageValues.some(value => value !== undefined)
      && (!values['--host-desktop'] || packageValues.some(value => value === undefined)
        || !/^[a-f0-9]{64}$/.test(values['--product-sha256']))) throw new Error(usage);
  return { mirrorOnly, desktop: values['--host-desktop'], receiptPath: values['--runtime-receipt'],
    receiptSha256: values['--runtime-receipt-sha256'], receiptRoot: values['--receipt-root'],
    productPackage: values['--product-package'], productSha256: values['--product-sha256'] };
}
const { mirrorOnly, desktop, receiptPath, receiptSha256, receiptRoot, productPackage, productSha256 } =
  parseProgramProbeArguments(process.argv.slice(2));
const candidate = productPackage ? readUpgradePackage(productPackage) : null;
if (candidate) assert.equal(candidate.receipt.sha256, productSha256, 'Frozen package must match the explicitly selected hash.');
const runtime = desktop ? candidateRuntime(desktop, { receiptPath, receiptSha256, root: receiptRoot }) : null;
const { runId, directory } = freshRun('program-install');
const files = ['src/core/program-discovery.mjs', 'src/core/program-install.mjs', 'src/core/mcp-search.mjs', 'scripts/program-install-probe.mjs'];
const sourceHashes = files.map(file => ({ file, sha256: sha256(join(project, file)) }));
const temporary = runtime ? join(tmpdir(), 'p') : mkdtempSync(join(tmpdir(), 'dsh-private-program-'));
if (runtime) mkdirSync(temporary);
const events = [], requests = [];
const fetchImpl = async (url, options) => {
  requests.push(url);
  if (mirrorOnly && url.startsWith('https://registry.npmjs.org/')) throw new Error('Probe simulates official registry unavailable');
  return fetch(url, options);
};
const installer = createPrivateProgramInstaller({ directory: join(temporary, 'runtime-cache'), fetchImpl });
let result, cached, error, hostCheck = null, smokeCheck = null;
try {
  result = await resolveGrokProgram({ installer, env: { PATH: '', HOME: temporary, USERPROFILE: temporary },
    onProgress: event => events.push(event) });
  cached = await installer.active();
  assert.equal(result.path, cached.path);
  assert.equal(result.sha256, cached.sha256);
  assert.equal(result.version, cached.version);
  assert.equal(result.source, 'private-cache');
  if (runtime) {
    const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
    const sourceFiles = candidate ? inspectPackage(candidate.data).files : new Map();
    const collect = relative => {
      const path = join(project, relative), stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, 'Source fixture must not follow links.');
      if (stat.isDirectory()) for (const name of readdirSync(path)) collect(relative + '/' + name);
      else { assert.equal(stat.isFile(), true); sourceFiles.set(relative, readFileSync(path)); }
    };
    if (!candidate) for (const path of ['package.json', ...manifest.files]) collect(path.replace(/\/+$/, ''));
    for (const [path, bytes] of sourceFiles) {
      assert.ok(readFileSync(join(project, path)).equals(bytes), 'Selected package differs from current source: ' + path);
    }
    // This disposable source fixture feeds the existing host driver. It is not
    // a release candidate and never leaves the validation scratch directory.
    const sourceFixture = candidate?.path ?? join(temporary, 'source-fixture.tgz');
    if (!candidate) writeFileSync(sourceFixture,
      tarGzip([...sourceFiles].map(([path, bytes]) => ['package/' + path, bytes])), { flag: 'wx' });
    const hostHashes = [runtime.executable, runtime.archivePath].map(path => ({ path, sha256: sha256(path) }));
    const execution = await runBoundedCommand(runtime.executable, ['--expose-internals',
      join(project, 'scripts/compatibility-program-host.mjs'), join(runtime.archivePath, 'dsh'),
      join(temporary, 'h'), project, sha256(sourceFixture),
      '--product-package', sourceFixture, '--grok-program', result.path, '--grok-sha256', result.sha256,
      ...(!candidate ? ['--case', PROGRAM_CASE_IDS[2]] : [])], { cwd: temporary, timeout: candidate ? 600_000 : 120_000,
      env: { ...programEnvironment(join(temporary, 'host-environment')), ELECTRON_RUN_AS_NODE: '1' } });
    const marker = candidate ? PROGRAM_MARKER : PROGRAM_CASE_MARKER;
    const lines = execution.stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
    assert.equal(lines.length, 1, 'Host driver must return one case receipt.');
    hostCheck = JSON.parse(lines[0].slice(marker.length));
    assert.equal(execution.code, 0); assert.equal(execution.failure, null);
    assert.equal(hostCheck.passed, true);
    assert.equal(hostCheck.hostVersion, runtime.app.version);
    assert.equal(hostCheck.officialSearchCalls, 0);
    assert.equal(hostCheck.cleanupVerified, true);
    assert.equal(hostCheck.productSha256, sha256(sourceFixture));
    if (candidate) {
      // Reuse the maintenance-side smoke driver on the exact same archive.
      const smokeRoot = join(temporary, 's'), env = programEnvironment(smokeRoot);
      for (const value of Object.values(env)) {
        if (typeof value === 'string' && value.startsWith(smokeRoot + '\\')
          || typeof value === 'string' && value.startsWith(smokeRoot + '/')) mkdirSync(value, { recursive: true });
      }
      const profile = join(env.DSH_HOME, 'profiles', 'candidate');
      const product = join(profile, 'node_modules', 'dsh-grok-search');
      mkdirSync(product, { recursive: true });
      for (const [path, bytes] of sourceFiles) {
        const target = join(product, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: 'wx' });
      }
      symlinkSync(join(project, 'node_modules'), join(product, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir');
      writeJson(join(profile, 'package.json'), { name: 'exact-package-smoke', private: true, type: 'module',
        dependencies: { 'dsh-grok-search': candidate.manifest.version } });
      const smoke = await runBoundedCommand(runtime.executable, ['--expose-internals',
        join(project, 'scripts/compatibility-smoke-host.mjs'), join(runtime.archivePath, 'dsh'), smokeRoot, product],
      { cwd: temporary, timeout: 180_000, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
      const receipts = smoke.stdout.split(/\r?\n/).filter(line => line.startsWith(COMPATIBILITY_SMOKE_MARKER));
      assert.equal(receipts.length, 1, 'Smoke driver must return one receipt.');
      smokeCheck = JSON.parse(receipts[0].slice(COMPATIBILITY_SMOKE_MARKER.length));
      assert.equal(smoke.code, 0); assert.equal(smoke.failure, null);
      assert.equal(smokeCheck.passed, true); assert.equal(smokeCheck.cleanupVerified, true);
      assert.equal(smokeCheck.hostVersion, runtime.app.version);
      assert.equal(smokeCheck.pluginVersion, candidate.manifest.version);
      assert.equal(smokeCheck.officialSearchCalls, 0);
      assert.equal(smokeCheck.realCredentialsUsed, false);
      assert.equal(candidate.receipt.sha256, sha256(sourceFixture));
      for (const [path, bytes] of sourceFiles) assert.ok(readFileSync(join(product, path)).equals(bytes));
    }
    assert.equal(hostHashes.every(row => sha256(row.path) === row.sha256), true, 'Host bytes must remain unchanged.');
    assert.equal([...sourceFiles].every(([path, bytes]) => readFileSync(join(project, path)).equals(bytes)), true);
    hostCheck.sourceFixture = !candidate;
    hostCheck.sourceFixtureFiles = sourceFiles.size;
    hostCheck.desktopUiVerified = false;
  }
} catch (caught) { error = { code: caught.code ?? null, message: caught.message }; }
const sourcesUnchanged = sourceHashes.every(row => sha256(join(project, row.file)) === row.sha256);
if (!sourcesUnchanged) error ??= { code: 'PROBE_SOURCE_CHANGED', message: 'Source changed during verification; this run is not current-source evidence.' };
const summary = { runId, status: error ? 'fail' : 'pass', error: error ?? null,
  scope: candidate ? 'exact-frozen-package-native-program-and-host-synthetic-upstream'
    : 'public-npm-platform-package-download-native-version-and-MCP-handshake-in-new-temporary-private-cache',
  mirrorOnly, platform: process.platform, arch: process.arch, events, requests,
  program: result ? { version: result.version, sha256: result.sha256, source: result.source } : null,
  cacheReadBack: Boolean(cached), mcpHandshakeValidated: Boolean(result), hostIntegrated: hostCheck?.passed === true,
  hostCheck, smokeCheck, productSha256: candidate?.receipt.sha256 ?? null,
  pluginVersion: candidate?.manifest.version ?? null,
  globalInstallationChanged: false, realConfigOrCredentialsUsed: false,
  sourceHashes, sourcesUnchanged };
writeJson(join(directory, 'summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = error ? 1 : 0;
