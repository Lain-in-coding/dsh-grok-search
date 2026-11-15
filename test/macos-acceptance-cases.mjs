import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { ACCEPTANCE_VERSIONS, EVIDENCE_TIMEOUTS, FULL_ACCEPTANCE_GATES, executionSha256, sha256 } from '../scripts/lib/compatibility-evidence.mjs';
import {
  FROZEN_PRODUCT_SHA256, PUBLISHED_OLD_PRODUCT, MACOS_HOST_PINS, MACOS_RUNTIME_FILES, MACOS_STAGES,
  collectMacosEvidence, crossHostUpgradeChecked, downloadPublishedOldPackage, hashPackageSource, helpersSucceeded,
  macosHostPin, macosUpgradeSelection,
  mapMacosGates, packageTransportReceipt,
  readPackageArtifact, readStageEvidence, sameHostUpgradeSelection,
} from '../scripts/lib/macos-acceptance-evidence.mjs';
import {
  ACCEPTANCE_TOOL_FILES, ACCEPTANCE_WORKFLOW_FILES, PUBLIC_MACOS_SUPPORT_FILES, acceptanceEnvironment, acceptanceVerifierIdentity, desktopStageArguments,
  downloadPinnedMacosHost, newTemporaryOutput, parseArguments, parseHelperPayload, prepareExecutionTree, programStageArguments,
  reviewedMacosSourceClosure, verifyExecutionTreeInputs, verifyExtractedMacosArchive,
} from '../scripts/macos-full-acceptance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = '0.2.2-rc.3', hash = 'a'.repeat(64), verifierHash = 'b'.repeat(64);
const product = { name: 'dsh-grok-search', version: '0.4.0', sha256: hash, fileCount: 1,
  sourceHashes: [{ file: 'package.json', sha256: 'c'.repeat(64) }] };
const packagedSource = path => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files
  .some(file => file === path || file.endsWith('/') && path.startsWith(file));
const temporary = () => mkdtempSync(join(tmpdir(), 'dsh-macos-acceptance-test-'));
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const exit = () => ({ exitCode: 0, signal: null, forced: false });
const applied = () => ({ application: 'applied', changed: true, target: product.name, error: null });
const nativeAudit = () => ({ schemaVersion: 1, installedVersion: product.version, hostCopies: false,
  checkedModuleDirectories: 3, policyScope: 'profile-local-config-and-installed-tree',
  installPolicy: { autoInstallPeers: true, strictPeerDependencies: true, legacyPeerDeps: false, force: false } });

function successfulStages({ program = false } = {}) {
  const security = Object.fromEntries(['snapshotOk', 'saveOk', 'redacted', 'revealMatches', 'forwardedDenied',
    'restrictedSnapshotOk', 'deniedSave', 'deniedDestination', 'unauthenticatedDenied'].map(key => [key, true]));
  Object.assign(security, { capabilities: { transport: 'loopback' },
    forwardedCode: 'SETTINGS_SECURE_CONNECTION_REQUIRED', deniedSaveCode: 'SETTINGS_SECURE_CONNECTION_REQUIRED',
    deniedDestinationCode: 'SETTINGS_SECURE_CONNECTION_REQUIRED' });
  const manager = evidence => ({ status: 'pass', counts: { pass: 1, fail: 0 }, fatal: null,
    packageReceipts: { product: { sha256: hash, sourceHashes: product.sourceHashes } },
    originalHashes: { unchanged: true,
      before: { [version]: { executable: hash, asar: hash } }, after: { [version]: { executable: hash, asar: hash } } },
    sourcesUnchanged: true, protocolAssociationUnchanged: true, cleanupValidated: true,
    originalDesktopRuntimeValidated: true, packagedDesktopStartupValidated: true, exits: [exit()],
    results: [{ version, status: 'pass', evidence }] });
  const values = {
    admission: { passed: true, productSha256: hash, checkedFiles: 1, hostCopies: false, legacyPeerDeps: false },
    smoke: { passed: true, hostVersion: version, pluginVersion: product.version, realCredentialsUsed: false,
      cleanupVerified: true, officialSearchCalls: 0, observations: { packageAdmission: { hostCopies: false },
        cancellation: { passed: true, callerReasonPreserved: true, upstreamCancelled: true, recovered: true } },
      gates: ['package-admission', 'capabilities', 'search-no-official-fallback', 'cancellation'].map(id => ({ id, passed: true })) },
    'search-contract': { passed: true, version, candidate: product.version, syntheticOnly: true, originalProviderCalls: 0,
      sourceHashes: product.sourceHashes, cases: ['host-default-query-limit', 'queued-cancellation-does-not-dispatch',
        'queued-deadline-does-not-dispatch', 'all-providers-failed-without-official-fallback'] },
    'github-contract': { passed: true, version, candidate: product.version, syntheticOnly: true,
      sourceHashes: product.sourceHashes, cases: ['default-off', 'registered-tool', 'pagination-and-continuation',
        'agent-isolation', 'official-web-fetch', 'permission-denial', 'stop-before-body', 'disable-and-restore', 'dispose'] },
    'program-host': { schemaVersion: 1, kind: 'compatibility-program-host', hostVersion: version,
      pluginVersion: product.version, productSha256: product.sha256, realCredentialsUsed: false,
      officialSearchCalls: 0, cleanupVerified: true, passed: true, grokSha256: 'd'.repeat(64),
      transport: 'loopback-responses-and-exact-registry-remap', installer: 'frozen-product-unmodified', cases: [
        { id: 'managed-grok-child-cancel-and-reap', observations: { childStarted: true, callerReasonPreserved: true,
          childReaped: true, stdioClosed: true, upstreamDisconnectObserved: true, running0: true, queued0: true,
          recovered: true, programVersion: '0.1.26', cancelledCalls: 2 } },
        { id: 'pending-program-preparation-cancel', observations: { preparationStarted: true, callerReasonPreserved: true,
          preparationSettled: true, activeCacheCommitted: false, upstreamDisconnectObserved: true, lateCompletionAttempted: true,
          lateCompletionNotPublished: true, programPhase: 'disposed' } },
        { id: 'program-download-failure-and-repair', observations: { failureObserved: true, failureCode: 'GROK_DOWNLOAD_HTTP',
          invalidCacheActivated: false, repairFailureObserved: true, failedRepairPreservedActive: true, repairSucceeded: true,
          repairedSha256: 'd'.repeat(64), mcpHandshakeValidated: true, recovered: true } },
      ].map(row => {
        const observations = { ...row.observations, orphanProcesses0: true, configUnchanged: true,
          cacheSentinelUnchanged: true, unexpectedRequests: 0 };
        return { id: row.id, status: 'passed', passed: true, observations,
          runs: (row.id === 'pending-program-preparation-cancel' ? ['disable', 'dispose'] : [null]).map(variant =>
            ({ id: row.id, variant, passed: true, status: 'passed', exitCode: 0, exitSignal: null, code: null,
              receipt: { id: row.id, variant, passed: true, code: null, cleanupVerified: true, hostVersion: version, pluginVersion: product.version,
                productSha256: product.sha256, grokSha256: 'd'.repeat(64), realCredentialsUsed: false,
                officialSearchCalls: 0, observations } })) };
      }) },
    manager: manager({ settingsSecurity: security, productInstall: applied(), productRemove: applied(), finalExit: exit(),
      nativeInstallAudit: nativeAudit(), restartNativeInstallAudit: nativeAudit(),
      restartSearch: { beforeCalls: { original: 0 }, afterCalls: { original: 1 } } }),
    'first-use': { ...manager({ program: { source: 'private-cache', sha256: 'd'.repeat(64), mcpHandshakeValidated: true },
      defaultConfigCreatedOnlyBySave: true, manualProfileEditRequired: false, sameManagedProcessReused: true,
      cacheReused: true, nativeDisableReenableValidated: true, orphanPrograms: 0, exit: exit(), nativeInstallAudit: nativeAudit() }),
    firstUseAutoDownloadValidated: true, productionDiagnosticsUiValidated: true },
    upgrade: { ...manager({ inPlaceOnly: false, nativeUpgradeUiValidated: true, configurationUnchanged: true,
      cacheReused: true, noNewProgramCacheDirectory: true, programOverrideRequired: false, configOverrideRequired: false,
      credentialScope: 'synthetic-loopback-only', rollbackScope: 'explicit-reinstall-of-old-package-not-cross-resource-atomicity',
      stages: [{ packageSha256: product.sha256, nativeInstallAudit: nativeAudit() }] }),
    upgradeRetentionValidated: true, upgradeFailureRecoveryValidated: true },
    renderer: { passed: true, fatal: null, live: false, tarballSha256: hash, sourceUnchanged: true,
      sourceHashes: product.sourceHashes,
      originalFilesUnchanged: true, associationUnchanged: true, packagedStartupVerified: true, syntheticKeysOnly: true,
      realKeyFilesWritten: false, exits: [exit()], results: [{ version, passed: true, editableConfig: true,
        checks: ['same packaged client', 'first search uses no original provider', 'failure did not call original provider',
          'hot disable restores previous author route', 'reenable takes over without restart',
          'search after restart remains functional without original fallback', 'actual Session discovers and invokes GitHub tool',
          'GitHub logs contain no original discussion text'].map(name => ({ name, passed: true })) }] },
  };
  return MACOS_STAGES.map(id => id === 'program-host' && !program ? { id, status: 'not-run' }
    : ({ id, status: 'passed', exitCode: 0, failure: null, signal: null, payload: values[id],
      evidence: { path: id + '.json', sha256: 'e'.repeat(64) } }));
}

function crossHostStages() {
  const stages = successfulStages({ program: true }), row = stages.find(row => row.id === 'upgrade').payload;
  const value = row.results[0].evidence, old = PUBLISHED_OLD_PRODUCT;
  const identity = { sessionId: 'synthetic-real-session', throughSeq: 12, recordCount: 4, recordsSha256: 'f'.repeat(64),
    seededHostVersion: '0.2.2-rc.2', seededPluginVersion: old.version, seededPackageSha256: old.sha256, seedInstanceId: 'seed' };
  const cold = (host, previous) => ({ coldReadBeforePrompt: true, historyMatched: true, hostInstanceId: host,
    previousHostInstanceId: previous, previousExitCode: 0, previousExitSignal: null, previousExitForced: false });
  const scope = 'forward-host-and-plugin-upgrade-original-session-cut';
  row.upgradeFailureRecoveryValidated = false; row.crossHostProductUpgradeValidated = true;
  row.originalHashes.before['0.2.2-rc.2'] = { executable: hash, asar: hash };
  row.originalHashes.after['0.2.2-rc.2'] = { executable: hash, asar: hash };
  Object.assign(value, { inPlaceOnly: true, rollbackScope: 'not-run-forward-only', exit: exit(),
    retainedSession: { ...identity, passed: true, scope, hostTransitionValidated: true, sameIdSearchEveryStage: true },
    crossHost: { passed: true, scope, fromHostVersion: '0.2.2-rc.2', toHostVersion: version,
      oldPluginVersion: old.version, newPluginVersion: product.version, oldPackageSha256: old.sha256,
      newPackageSha256: product.sha256, sameProfile: true, sameUserData: true, forwardOnly: true,
      targetRuntimeReceiptSha256: hash,
      hostDowngradeValidated: false, normalFinalExit: true, configurationUnchangedAtBoundary: true,
      controlHistoryUnchangedAtBoundary: true, configurationUnchanged: true, programCacheUnchanged: true,
      oldSessionHistoryRetained: true, boundaryHistory: { ...identity, ...cold('boundary', 'old-restart') },
      oldPackageRejected: { hostVersion: version, pluginVersion: old.version, packageSha256: old.sha256,
        code: 'incompatible-version', requirements: { 'engines.dsh': '0.2.2-rc.2' }, exempted: false, searchIssued: false,
        officialSearchCalls: 0, oldPluginActive: false, protectionStatus: 'old-plugin-unloaded-not-protected',
        evidence: 'official-plugin-manager-incompatible-result' } },
    stages: ['old-configured', 'old-restarted', 'tarball-in-place-restarted'].map((phase, index) => ({
      phase, hostVersion: index === 2 ? version : '0.2.2-rc.2', pluginVersion: index === 2 ? product.version : old.version,
      packageSha256: index === 2 ? product.sha256 : old.sha256, installedFilesVerified: index === 2 ? product.fileCount : 51,
      configurationUnchanged: true, programCacheUnchanged: true, fileKeyEditable: true, searchPassed: true,
      fetchPassed: true, chatPassed: true, originalSearchDelta: 0, programSource: 'private-cache',
      ...(index === 2 ? { nativeInstallAudit: nativeAudit() } : {}),
      retainedSession: { ...identity, coldReadBeforePrompt: false, historyMatched: true, sameIdSearch: true,
        searchSessionId: identity.sessionId, originalCutReadbackAfterTurns: true,
        ...(index ? cold(index === 1 ? 'old-restart' : 'new-restart', index === 1 ? 'seed' : 'boundary') : {}) },
    })),
  });
  return stages;
}

function tarFile(path, contents) {
  const data = Buffer.from(contents), header = Buffer.alloc(512);
  header.write(path);
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write('0', 156);
  header.write('ustar\0', 257); header.write('00', 263);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}

function packageFixture() {
  const directory = temporary(), file = JSON.stringify({ name: product.name, version: product.version, type: 'module' });
  const bytes = gzipSync(Buffer.concat([tarFile('package/package.json', file), Buffer.alloc(1024)]));
  const receipt = { name: product.name, version: product.version, sha256: sha256(bytes),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    sourceHashes: [{ file: 'package.json', sha256: sha256(file) }] };
  writeFileSync(join(directory, 'dsh-grok-search-0.4.0.tgz'), bytes);
  json(join(directory, 'package-receipt.json'), receipt);
  return { directory, receipt, bytes };
}

test('seven macOS targets keep six reviewed pins and the missing rc.4 explicit', () => {
  assert.deepEqual(Object.keys(MACOS_HOST_PINS), [...ACCEPTANCE_VERSIONS]);
  assert.equal(MACOS_HOST_PINS['0.2.1-rc.4'], null);
  assert.throws(() => macosHostPin('0.2.1-rc.4'), { code: 'MACOS_HOST_PIN_MISSING' });
  assert.throws(() => macosHostPin('99.0.0'));
  for (const target of ACCEPTANCE_VERSIONS.filter(value => value !== '0.2.1-rc.4')) {
    assert.equal(new URL(macosHostPin(target).url).hostname, 'download.deepseek.com');
    assert.equal(Buffer.from(macosHostPin(target).integrity.slice(7), 'base64').length, 64);
  }
  assert.equal(macosHostPin('0.2.1-rc.2').provenance.kind, 'reviewed-historical-pin');
  assert.equal(macosHostPin(version).provenance.metadataSha256.length, 64);
});

test('transport validates exact tgz, mandatory integrity and every package file', () => {
  const f = packageFixture();
  const parsed = readPackageArtifact(f.directory, f.receipt.sha256);
  assert.equal(parsed.product.fileCount, 1);
  assert.equal(parsed.files.size, 1);
  assert.throws(() => readPackageArtifact(f.directory, hash));
  delete f.receipt.integrity;
  json(join(f.directory, 'package-receipt.json'), f.receipt);
  assert.throws(() => readPackageArtifact(f.directory, f.receipt.sha256));
});

test('old package engine contract selects same-host upgrades, never escapes into unsupported rc.3', () => {
  const old = { version: '0.3.0', engines: { dsh: '0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.5 || 0.2.2-rc.1 || 0.2.2-rc.2' } };
  assert.equal(sameHostUpgradeSelection(old, '0.2.2-rc.2').eligible, true);
  const latest = sameHostUpgradeSelection(old, '0.2.2-rc.3');
  assert.equal(latest.eligible, false);
  assert.equal(latest.code, 'OLD_PACKAGE_HOST_INCOMPATIBLE');
  assert.equal(latest.requiresCrossRuntimeUpgrade, true);
  assert.equal(sameHostUpgradeSelection({ version: '0.3.0' }, version).code, 'OLD_PACKAGE_HOST_RANGE_MISSING');
  const pair = macosUpgradeSelection(old, version);
  assert.equal(pair.mode, 'cross-host'); assert.equal(pair.fromVersion, '0.2.2-rc.2');
  assert.equal(pair.rollbackScope, 'not-run-forward-only');
  assert.equal(macosUpgradeSelection(old, '0.2.2-rc.2').mode, 'same-host');
  assert.equal(macosUpgradeSelection({ ...old, version: '0.1.0' }, version).eligible, false);
  const driver = readFileSync(join(root, 'scripts/macos-full-acceptance.mjs'), 'utf8');
  assert.match(driver, /id === 'upgrade' && !upgradeSelection\.eligible/);
  assert.doesNotMatch(driver, /--allow-version|--force|ignore.*engines/);
});

test('transport rejects incomplete or malicious inventories and extra artifact files', () => {
  for (const sourceHashes of [[], [{ file: '../escape', sha256: hash }], [{ file: 'package.json', sha256: hash }]]) {
    const f = packageFixture();
    json(join(f.directory, 'package-receipt.json'), { ...f.receipt, sourceHashes });
    assert.throws(() => readPackageArtifact(f.directory, f.receipt.sha256));
  }
  const f = packageFixture();
  writeFileSync(join(f.directory, 'unreviewed-helper.mjs'), 'throw new Error("never execute");');
  assert.throws(() => readPackageArtifact(f.directory, f.receipt.sha256));
});

test('current native install and first-use gates require the strict post-install audit', () => {
  for (const [id, gate] of [['manager', 'install'], ['first-use', 'program-preparation']]) {
    for (const mutation of [audit => { audit.installPolicy.strictPeerDependencies = false; },
      audit => { audit.installPolicy.autoInstallPeers = false; }, audit => { audit.hostCopies = true; }]) {
      const stages = successfulStages({ program: true });
      mutation(stages.find(row => row.id === id).payload.results[0].evidence.nativeInstallAudit);
      assert.equal(mapMacosGates({ product, version, stages }).find(row => row.id === gate).status, 'failed');
    }
  }
});

test('cross-host product upgrade binds old Session, warning, new package, actual exits and strict install without claiming rollback', () => {
  const stages = crossHostStages(), row = stages.find(stage => stage.id === 'upgrade').payload;
  assert.equal(crossHostUpgradeChecked(row, product, version), true);
  assert.equal(mapMacosGates({ product, version, stages }).find(gate => gate.id === 'lifecycle').passed, true);
  assert.equal(row.upgradeFailureRecoveryValidated, false);
  assert.equal(row.results[0].evidence.rollbackScope, 'not-run-forward-only');
  for (const mutate of [value => { value.crossHost.oldPackageRejected.exempted = true; },
    value => { value.crossHost.oldPackageRejected.searchIssued = true; },
    value => { value.crossHost.oldPackageRejected.requirements['engines.dsh'] = '*'; },
    value => { value.crossHost.oldPackageSha256 = hash; },
    value => { value.crossHost.boundaryHistory.previousExitForced = true; },
    value => { value.crossHost.boundaryHistory.recordsSha256 = hash; },
    value => { value.crossHost.boundaryHistory.previousHostInstanceId = 'unrelated-lifetime'; },
    value => { value.stages[2].retainedSession.coldReadBeforePrompt = false; },
    value => { value.stages[2].retainedSession.searchSessionId = 'different'; },
    value => { value.stages[2].nativeInstallAudit.installPolicy.legacyPeerDeps = true; },
    value => { value.stages[2].installedFilesVerified = product.fileCount + 1; },
    value => { value.exit.forced = true; }, value => { value.stages.pop(); }]) {
    const changed = structuredClone(row); mutate(changed.results[0].evidence);
    assert.equal(crossHostUpgradeChecked(changed, product, version), false);
  }
});

test('prior-package transport computes a complete inventory from verified bytes without executing package scripts', () => {
  const f = packageFixture(), expected = { ...f.receipt, size: f.bytes.length };
  const receipt = packageTransportReceipt(f.bytes, expected);
  assert.deepEqual(receipt.sourceHashes, f.receipt.sourceHashes);
  assert.equal(receipt.acceptanceExecuted, false);
  assert.equal(receipt.published, false);
  for (const changed of [{ sha256: hash }, { integrity: 'sha512-' + Buffer.alloc(64).toString('base64') },
    { size: f.bytes.length + 1 }, { name: 'different' }, { version: '0.3.0' }]) {
    assert.throws(() => packageTransportReceipt(f.bytes, { ...expected, ...changed }));
  }
});

test('published prior-package download requires exact registry metadata, URL, integrity and content pins', async () => {
  const pin = PUBLISHED_OLD_PRODUCT;
  assert.equal(pin.sha256, '24ab92c59221d4ef011986afa81022a2d0e6cd1f4bc07358e409e6d8c21d3b48');
  assert.equal(pin.size, 348286);
  const document = overrides => ({ name: pin.name, versions: { [pin.version]: {
    name: pin.name, version: pin.version, dist: { tarball: pin.url, integrity: pin.integrity, ...overrides },
  } } });
  for (const overrides of [{ tarball: 'https://evil.invalid/package.tgz' }, { integrity: undefined },
    { integrity: 'sha512-' + Buffer.alloc(64).toString('base64') }]) {
    let calls = 0;
    await assert.rejects(downloadPublishedOldPackage({ fetchImpl: async (url, init) => {
      calls++; assert.equal(url, pin.metadataUrl); assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.authorization, undefined);
      return new Response(JSON.stringify(document(overrides)));
    } }));
    assert.equal(calls, 1, 'Unreviewed metadata must stop before downloading the asset.');
  }
  const calls = [];
  await assert.rejects(downloadPublishedOldPackage({ fetchImpl: async url => {
    calls.push(url);
    return new Response(url === pin.metadataUrl ? JSON.stringify(document({})) : 'tampered archive');
  } }));
  assert.deepEqual(calls, [pin.metadataUrl, pin.url]);
  await assert.rejects(downloadPublishedOldPackage({ fetchImpl: async () =>
    new Response('', { status: 302, headers: { location: 'https://evil.invalid/metadata' } }) }));
});

test('successful available helpers still do not manufacture full acceptance', () => {
  const gates = mapMacosGates({ product, version, stages: successfulStages() });
  assert.deepEqual(gates.map(row => row.id), [...FULL_ACCEPTANCE_GATES]);
  assert.deepEqual(gates.filter(row => row.passed).map(row => row.id),
    ['install', 'configuration-security', 'search-no-official-fallback', 'lifecycle', 'logs-github']);
  for (const id of ['cancellation', 'program-preparation']) {
    assert.equal(gates.find(row => row.id === id).status, 'not-run');
    assert.ok(gates.find(row => row.id === id).checks.some(row => row.status === 'passed'));
  }
});

test('smoke-only evidence cannot be relabeled as seven full gates', () => {
  const stages = successfulStages().filter(row => row.id === 'smoke');
  assert.equal(mapMacosGates({ product, version, stages }).filter(row => row.passed).length, 0);
  assert.throws(() => mapMacosGates({ product, version, stages: [...stages, ...stages] }));
  assert.throws(() => mapMacosGates({ product, version, stages: [{ id: 'invented', status: 'passed' }] }));
});

test('all seven gates require actual program child, preparation cancel and repair observations', () => {
  const stages = successfulStages({ program: true });
  assert.equal(mapMacosGates({ product, version, stages }).every(row => row.passed), true);
  const probe = stages.find(row => row.id === 'program-host');
  probe.payload.cases[1].observations.activeCacheCommitted = true;
  const failed = mapMacosGates({ product, version, stages });
  assert.equal(failed.find(row => row.id === 'cancellation').status, 'failed');
  assert.equal(failed.find(row => row.id === 'program-preparation').status, 'failed');
});

test('missing, duplicate or cross-product program cases cannot make seven gates pass', () => {
  for (const mutate of [
    row => { row.cases.splice(1, 1); },
    row => { row.cases.push(row.cases[0]); },
    row => { row.productSha256 = 'f'.repeat(64); },
    row => { row.cases[0].observations.childReaped = false; },
    row => { row.cases[2].observations.repairedSha256 = 'not-a-hash'; },
    row => { row.cases[1].runs.splice(1, 1); },
  ]) {
    const stages = successfulStages({ program: true });
    mutate(stages.find(row => row.id === 'program-host').payload);
    assert.equal(mapMacosGates({ product, version, stages }).every(row => row.passed), false);
  }
});

test('a failed repair keeps the actually successful cancellation cases instead of rewriting every case', () => {
  const stages = successfulStages({ program: true }), program = stages.find(row => row.id === 'program-host');
  program.exitCode = 1; program.status = 'failed'; program.payload.passed = false;
  program.payload.cases[2].passed = false; program.payload.cases[2].status = 'failed';
  const gates = mapMacosGates({ product, version, stages });
  assert.equal(gates.find(row => row.id === 'cancellation').passed, true);
  assert.equal(gates.find(row => row.id === 'program-preparation').status, 'failed');
});

test('security needs actual normal-branch RPC evidence rather than first-use readiness', () => {
  const stages = successfulStages();
  const normal = stages.find(row => row.id === 'manager').payload;
  normal.results[0].evidence.settingsSecurity.deniedSaveCode = 'OTHER_ERROR';
  assert.equal(mapMacosGates({ product, version, stages }).find(row => row.id === 'configuration-security').status, 'failed');
  stages.splice(stages.findIndex(row => row.id === 'manager'), 1);
  assert.equal(mapMacosGates({ product, version, stages }).find(row => row.id === 'configuration-security').status, 'not-run');
});

test('protected-window zero is distinct from expected official calls after explicit release', () => {
  const stages = successfulStages();
  assert.equal(stages.find(row => row.id === 'manager').payload.results[0].evidence.restartSearch.afterCalls.original, 1);
  assert.equal(mapMacosGates({ product, version, stages }).find(row => row.id === 'search-no-official-fallback').passed, true);
  stages.find(row => row.id === 'smoke').payload.officialSearchCalls = 1;
  assert.equal(mapMacosGates({ product, version, stages }).find(row => row.id === 'search-no-official-fallback').status, 'failed');
});

test('missing search abort observations cannot pass cancellation', () => {
  const stages = successfulStages();
  stages.find(row => row.id === 'smoke').payload.observations.cancellation.recovered = false;
  assert.equal(mapMacosGates({ product, version, stages }).find(row => row.id === 'cancellation').status, 'failed');
});

test('npm program discovery is not empty-cache private download evidence', () => {
  const stages = successfulStages();
  stages.find(row => row.id === 'first-use').payload.results[0].evidence.program.source = 'npm';
  assert.equal(mapMacosGates({ product, version, stages }).find(row => row.id === 'program-preparation').status, 'failed');
});

test('mixed package, wrong host version, forced exit and missing renderer assertions fail', () => {
  for (const mutate of [
    stages => { stages.find(row => row.id === 'renderer').payload.tarballSha256 = 'f'.repeat(64); },
    stages => { stages.find(row => row.id === 'renderer').payload.results[0].version = '0.2.1-rc.2'; },
    stages => { stages.find(row => row.id === 'renderer').payload.exits[0].forced = true; },
    stages => { stages.find(row => row.id === 'renderer').payload.results[0].checks.pop(); },
    stages => { stages.find(row => row.id === 'renderer').exitCode = 1; },
  ]) {
    const stages = successfulStages(); mutate(stages);
    assert.equal(mapMacosGates({ product, version, stages }).find(row => row.id === 'logs-github').status, 'failed');
  }
});

test('receipt passthrough selects one explicit host for every Desktop stage', () => {
  const flags = ['--runtime-receipt', '/isolated/runtime-receipt.json', '--runtime-receipt-sha256', hash];
  const common = { executable: '/isolated/host', receiptFlags: flags, tarball: '/frozen/product.tgz',
    oldTarball: '/old/product.tgz', cache: '/isolated/cache' };
  for (const id of ['manager', 'first-use', 'renderer', 'upgrade']) {
    const args = desktopStageArguments(id, common);
    assert.ok(flags.every(flag => args.includes(flag)));
    assert.equal(args.filter(value => value === common.executable).length, 1);
    assert.ok(!args.includes('--desktop-rc2') && !args.includes('--desktop-rc21') && !args.includes('--allow-live'));
  }
  assert.ok(desktopStageArguments('first-use', common).includes('--diagnostics'));
  assert.throws(() => desktopStageArguments('upgrade', { ...common, oldTarball: null }));
  const pair = desktopStageArguments('upgrade', { ...common, executable: '/isolated/old-host', receiptFlags: [],
    upgradeTo: { executable: '/isolated/new-host', receiptFlags: flags } });
  assert.equal(pair[pair.indexOf('--desktop') + 1], '/isolated/old-host');
  assert.equal(pair[pair.indexOf('--upgrade-to-desktop') + 1], '/isolated/new-host');
  assert.equal(pair[pair.indexOf('--upgrade-to-runtime-receipt-sha256') + 1], hash);
  assert.ok(pair.includes('--upgrade-in-place-only'));
  assert.equal(pair.includes('--runtime-receipt'), false);
  assert.throws(() => desktopStageArguments('upgrade', { ...common, upgradeTo: { executable: '/new', receiptFlags: [] } }));
});

test('program stage uses the actual host, frozen package and hash-verified first-use binary', () => {
  const args = programStageArguments({ tree: '/tree', hostRoot: '/host/app.asar', outputRoot: '/new/program',
    productDirectory: '/installed/dsh-grok-search', tarball: '/frozen/product.tgz', productSha256: hash,
    grok: '/private/cache/grok', grokSha256: verifierHash });
  assert.ok(args.includes('--expose-internals') && args.includes('--product-package'));
  assert.equal(args[2], '/host/app.asar');
  assert.equal(args[3], '/new/program');
  assert.equal(args[4], '/installed/dsh-grok-search');
  assert.equal(args[5], hash);
  assert.equal(args.at(-1), verifierHash);
  assert.ok(!args.includes('--allow-live') && !args.includes('--case'));
});

test('runtime environments drop tokens, arbitrary PATH and runner control paths', () => {
  const env = acceptanceEnvironment(temporary());
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GITHUB_ENV, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.ok(env.PATH.endsWith('/usr/bin:/bin:/usr/sbin:/sbin'));
  assert.ok(existsSync(env.HOME) && existsSync(env.DSH_HOME));
});

test('fresh acceptance output rejects relative, existing and non-temporary targets before writes', () => {
  const parent = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'dsh-macos-output-test-')), target = join(parent, 'new');
  assert.equal(existsSync(newTemporaryOutput(target)), true);
  assert.throws(() => newTemporaryOutput(target));
  assert.throws(() => newTemporaryOutput('relative-output'));
  assert.throws(() => newTemporaryOutput(join(root, 'not-authorized-output')));
  assert.equal(existsSync(join(root, 'not-authorized-output')), false);
});

test('execution tree copies frozen product plus only explicit verifier tools', () => {
  const f = packageFixture(), source = temporary(), output = temporary();
  for (const path of ACCEPTANCE_TOOL_FILES) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), 'synthetic verifier\n');
  }
  mkdirSync(join(source, 'node_modules'));
  const pkg = readPackageArtifact(f.directory, f.receipt.sha256);
  const tree = prepareExecutionTree(output, pkg, source);
  assert.equal(readFileSync(join(tree, 'package.json'), 'utf8'), pkg.files.get('package.json').toString());
  for (const path of ['scripts/lib/retained-session.mjs', 'scripts/internal-candidate-host.mjs']) {
    assert.ok(ACCEPTANCE_TOOL_FILES.includes(path), 'Copied runtime dependency must be explicitly fingerprinted: ' + path);
    assert.equal(readFileSync(join(tree, path), 'utf8'), 'synthetic verifier\n');
  }
  assert.equal(existsSync(join(tree, 'artifacts')), false);
  assert.throws(() => prepareExecutionTree(output, pkg, source));
});

test('actual execution-tree tools and product bytes must still match the frozen verifier inputs', async () => {
  const tree = temporary(), path = 'scripts/compatibility-smoke-host.mjs';
  mkdirSync(dirname(join(tree, path)), { recursive: true });
  writeFileSync(join(tree, 'package.json'), 'frozen product');
  writeFileSync(join(tree, 'empty-detail.md'), '');
  writeFileSync(join(tree, path), 'actual child');
  const product = { sourceHashes: [{ file: 'package.json', sha256: sha256('frozen product') },
    { file: 'empty-detail.md', sha256: sha256('') }] };
  const verifier = { inputs: [{ path, sha256: sha256('actual child') }] };
  await verifyExecutionTreeInputs(tree, product, verifier);
  assert.equal(hashPackageSource(join(tree, 'empty-detail.md')), sha256(''));
  writeFileSync(join(tree, path), 'tampered child');
  await assert.rejects(verifyExecutionTreeInputs(tree, product, verifier));
});

test('archive postflight rejects unexpected files and link escapes', () => {
  const output = temporary();
  writeFileSync(join(output, 'host'), 'abc');
  verifyExtractedMacosArchive(output, [{ path: 'host', size: 3 }]);
  writeFileSync(join(output, 'extra'), 'extra');
  assert.throws(() => verifyExtractedMacosArchive(output, [{ path: 'host', size: 3 }]));
  const linked = temporary(), outside = temporary();
  symlinkSync(outside, join(linked, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyExtractedMacosArchive(linked, [{ path: 'link', size: 0, link: outside }]));
});

test('asset downloader rejects modified URL or hash without fetching and preserves existing bytes', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches++; throw new Error('not a network test'); };
  const destination = join(temporary(), 'host.zip'), pin = macosHostPin(version);
  await assert.rejects(downloadPinnedMacosHost({ ...pin, url: 'https://evil.invalid/host.zip' }, destination, { fetchImpl }));
  await assert.rejects(downloadPinnedMacosHost({ ...pin, sha256: hash }, destination, { fetchImpl }));
  assert.equal(fetches, 0);
  writeFileSync(destination, 'preserved partial');
  await assert.rejects(downloadPinnedMacosHost(pin, destination, { fetchImpl }));
  assert.equal(readFileSync(destination, 'utf8'), 'preserved partial');
  assert.equal(fetches, 0);
});

test('argument parser rejects duplicates, missing values and non-data arguments', () => {
  assert.deepEqual(parseArguments(['run', '--package-directory', '/input', '--version', version, '--output-root', '/new']).values,
    { '--package-directory': '/input', '--version': version, '--output-root': '/new' });
  for (const args of [['unknown'], ['run', '--version'], ['run', '--version', version, '--version', version],
    ['run', '--version', '--allow-live'], ['run', '--version', 'bad\nvalue']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('helper stdout must contain one actual result, not a success-looking prefix or duplicate marker', () => {
  const marker = 'DSH_COMPATIBILITY_SMOKE=';
  assert.deepEqual(parseHelperPayload('ordinary log\n' + marker + '{"passed":true}\n', marker), { passed: true });
  for (const value of ['{"passed":true}\nextra', 'null', '[]', 'not-json']) {
    assert.equal(parseHelperPayload(value).passed, false);
  }
  assert.equal(parseHelperPayload(marker + '{"passed":true}\n' + marker + '{"passed":true}', marker).passed, false);
});

test('external helper evidence validates hashes and rejects traversal and tamper', async () => {
  const directory = temporary(), value = { passed: true };
  json(join(directory, 'smoke.json'), value);
  const row = { id: 'smoke', status: 'passed', evidence: { path: 'smoke.json', sha256: sha256(readFileSync(join(directory, 'smoke.json'))) } };
  assert.deepEqual((await readStageEvidence(directory, [row]))[0].payload, value);
  await assert.rejects(readStageEvidence(directory, [{ ...row, evidence: { ...row.evidence, path: '../smoke.json' } }]));
  json(join(directory, 'smoke.json'), { passed: false });
  await assert.rejects(readStageEvidence(directory, [row]));
});

test('collector binds raw partial evidence to exact package, host, verifier and CI run', async () => {
  const directory = temporary(), target = join(directory, 'macos-full-' + version);
  mkdirSync(target);
  const stages = successfulStages();
  for (const row of stages.filter(row => row.evidence)) {
    json(join(target, row.evidence.path), row.payload);
    row.evidence.sha256 = sha256(readFileSync(join(target, row.evidence.path)));
  }
  const gates = mapMacosGates({ product, version, stages });
  const context = { kind: 'github-actions', repository: 'test/repo', runId: '42', runAttempt: '1', commit: 'c'.repeat(40) };
  const value = { kind: 'macos-exact-package-acceptance', platform: 'darwin-arm64', version, product,
    hostAsset: macosHostPin(version),
    upgradeSelection: { eligible: true, version, code: null, hostRange: version },
    runtimeFiles: Object.fromEntries(Object.entries(MACOS_RUNTIME_FILES).map(([role, path]) => [role, { path, sha256: hash }])),
    verifierSha256: verifierHash, passed: false, cleanupVerified: true, realCredentialsUsed: false, published: false, gates,
    execution: { platform: 'darwin', arch: 'arm64', context, startedAt: '2026-11-14T00:00:00.000Z', finishedAt: '2026-11-14T01:00:00.000Z' },
    stages: stages.map(({ payload, ...row }) => row) };
  const write = () => json(join(target, 'receipt.json'), { ...value, runSha256: executionSha256(value) });
  write();
  const result = await collectMacosEvidence(directory, product, { ...context, verifierSha256: verifierHash });
  assert.deepEqual(result.summary, { expected: 7, passed: 0, failed: 0, notRun: 7 });
  assert.equal(result.humanReady, false);
  await assert.rejects(collectMacosEvidence(directory, product, { ...context, verifierSha256: hash }));
  await assert.rejects(collectMacosEvidence(directory, product, { ...context, runAttempt: '2', verifierSha256: verifierHash }));
  value.runtimeFiles.archive.sha256 = 'f'.repeat(64); write();
  await assert.rejects(collectMacosEvidence(directory, product, { ...context, verifierSha256: verifierHash }));
  value.runtimeFiles.archive.sha256 = hash;
  value.passed = true; write();
  await assert.rejects(collectMacosEvidence(directory, product, { ...context, verifierSha256: verifierHash }));
});

test('collector can report an actual seven-gate cell without inventing the other six or human acceptance', async () => {
  const directory = temporary(), target = join(directory, 'macos-full-' + version);
  mkdirSync(target);
  const stages = successfulStages({ program: true });
  for (const row of stages) {
    json(join(target, row.evidence.path), row.payload);
    row.evidence.sha256 = sha256(readFileSync(join(target, row.evidence.path)));
  }
  const value = { kind: 'macos-exact-package-acceptance', platform: 'darwin-arm64', version, product,
    hostAsset: macosHostPin(version),
    upgradeSelection: { eligible: true, version, code: null, hostRange: version },
    runtimeFiles: Object.fromEntries(Object.entries(MACOS_RUNTIME_FILES).map(([role, path]) => [role, { path, sha256: hash }])),
    verifierSha256: verifierHash, passed: true, cleanupVerified: true, realCredentialsUsed: false, published: false,
    gates: mapMacosGates({ product, version, stages }),
    execution: { platform: 'darwin', arch: 'arm64', context: { kind: 'local' },
      startedAt: '2026-11-14T00:00:00.000Z', finishedAt: '2026-11-14T01:00:00.000Z' },
    stages: stages.map(({ payload, ...row }) => row) };
  json(join(target, 'receipt.json'), { ...value, runSha256: executionSha256(value) });
  const result = await collectMacosEvidence(directory, product, { verifierSha256: verifierHash });
  assert.deepEqual(result.summary, { expected: 7, passed: 1, failed: 0, notRun: 6 });
  assert.equal(result.passed, false);
  assert.equal(result.humanReady, false);
});

test('failed program-stage receipts keep local case evidence but cannot make the overall cell pass', async () => {
  for (const mutate of [
    row => { row.status = 'failed'; row.payload.passed = false; row.payload.code = 'PROGRAM_HELPER_FAILED'; },
    row => { row.payload.code = 'PROGRAM_HELPER_FAILED'; },
    row => { row.payload.passed = false; },
    row => { row.payload.fatal = { code: 'PROGRAM_HELPER_FAILED' }; },
    row => { row.payload.error = { code: 'PROGRAM_HELPER_FAILED' }; },
  ]) {
    const directory = temporary(), target = join(directory, 'macos-full-' + version);
    mkdirSync(target);
    const stages = successfulStages({ program: true });
    mutate(stages.find(row => row.id === 'program-host'));
    for (const row of stages) {
      json(join(target, row.evidence.path), row.payload);
      row.evidence.sha256 = sha256(readFileSync(join(target, row.evidence.path)));
    }
    const gates = mapMacosGates({ product, version, stages });
    assert.equal(gates.find(row => row.id === 'cancellation').passed, true, 'Retain actually successful local cancellation cases.');
    assert.equal(helpersSucceeded(stages), false);
    const value = { kind: 'macos-exact-package-acceptance', platform: 'darwin-arm64', version, product,
      hostAsset: macosHostPin(version),
      runtimeFiles: Object.fromEntries(Object.entries(MACOS_RUNTIME_FILES).map(([role, path]) => [role, { path, sha256: hash }])),
      upgradeSelection: { eligible: true, version, code: null, hostRange: version },
      verifierSha256: verifierHash, passed: false, cleanupVerified: true, realCredentialsUsed: false, published: false, gates,
      execution: { platform: 'darwin', arch: 'arm64', context: { kind: 'local' },
        startedAt: '2026-11-14T00:00:00.000Z', finishedAt: '2026-11-14T01:00:00.000Z' },
      stages: stages.map(({ payload, ...row }) => row) };
    const write = () => json(join(target, 'receipt.json'), { ...value, runSha256: executionSha256(value) });
    write();
    const result = await collectMacosEvidence(directory, product, { verifierSha256: verifierHash });
    assert.equal(result.targets.find(row => row.version === version).passed, false);
    assert.equal(result.summary.failed, 1);
    value.passed = true; write();
    await assert.rejects(collectMacosEvidence(directory, product, { verifierSha256: verifierHash }));
  }
  assert.equal(helpersSucceeded(successfulStages({ program: true })), true);
  const driver = readFileSync(join(root, 'scripts/macos-full-acceptance.mjs'), 'utf8');
  assert.match(driver, /passed: gates\.every\(row => row\.passed\) && cleanupVerified && helpersSucceeded\(actual\)/);
});

test('a preparation checkpoint enables independent proof but cannot promote failed first-use lifecycle', async () => {
  const directory = temporary(), target = join(directory, 'macos-full-' + version);
  mkdirSync(target);
  const stages = successfulStages({ program: true });
  const firstUse = stages.find(row => row.id === 'first-use');
  firstUse.status = 'failed'; firstUse.exitCode = 1;
  firstUse.payload.status = 'fail'; firstUse.payload.fatal = { code: 'FIRST_USE_HMR_FAILED' };
  for (const row of stages) {
    json(join(target, row.evidence.path), row.payload);
    row.evidence.sha256 = sha256(readFileSync(join(target, row.evidence.path)));
  }
  const checkpoint = { hostVersion: version, productSha256: product.sha256,
    program: { version: '0.1.26', sha256: 'd'.repeat(64), source: 'private-cache', mcpHandshakeValidated: true },
    configCreated: false, activeSha256: hash, nativeInstallAudit: nativeAudit(),
    scope: 'first-use-preparation-checkpoint-not-complete-lifecycle-acceptance' };
  json(join(target, 'first-use-program-prepared.json'), checkpoint);
  const value = { kind: 'macos-exact-package-acceptance', platform: 'darwin-arm64', version, product,
    hostAsset: macosHostPin(version),
    runtimeFiles: Object.fromEntries(Object.entries(MACOS_RUNTIME_FILES).map(([role, path]) => [role, { path, sha256: hash }])),
    upgradeSelection: { eligible: true, version, code: null, hostRange: version },
    verifierSha256: verifierHash, passed: false, cleanupVerified: false, realCredentialsUsed: false, published: false,
    gates: mapMacosGates({ product, version, stages }),
    firstUsePreparation: { ...checkpoint, evidence: { path: 'first-use-program-prepared.json',
      sha256: sha256(readFileSync(join(target, 'first-use-program-prepared.json'))) } },
    execution: { platform: 'darwin', arch: 'arm64', context: { kind: 'local' },
      startedAt: '2026-11-14T00:00:00.000Z', finishedAt: '2026-11-14T01:00:00.000Z' },
    stages: stages.map(({ payload, ...row }) => row) };
  const write = () => json(join(target, 'receipt.json'), { ...value, runSha256: executionSha256(value) });
  write();
  const result = await collectMacosEvidence(directory, product, { verifierSha256: verifierHash });
  assert.equal(result.summary.failed, 1);
  assert.equal(result.targets.find(row => row.version === version).gates.find(row => row.id === 'cancellation').passed, true);
  assert.equal(result.targets.find(row => row.version === version).gates.find(row => row.id === 'program-preparation').passed, false);
  const preparation = value.firstUsePreparation;
  delete value.firstUsePreparation; write();
  await assert.rejects(collectMacosEvidence(directory, product, { verifierSha256: verifierHash }),
    /require their actual preparation checkpoint/);
  value.firstUsePreparation = preparation; write();
  value.passed = true; write();
  await assert.rejects(collectMacosEvidence(directory, product, { verifierSha256: verifierHash }));
  value.passed = false; write();
  json(join(target, 'first-use-program-prepared.json'), { ...checkpoint, program: { ...checkpoint.program, sha256: hash } });
  await assert.rejects(collectMacosEvidence(directory, product, { verifierSha256: verifierHash }));
});

test('collector verifies both official runtime inventories for forward-only product upgrade evidence', async () => {
  const directory = temporary(), target = join(directory, 'macos-full-' + version);
  mkdirSync(target);
  const stages = crossHostStages();
  for (const row of stages) {
    json(join(target, row.evidence.path), row.payload);
    row.evidence.sha256 = sha256(readFileSync(join(target, row.evidence.path)));
  }
  const runtimeFiles = Object.fromEntries(Object.entries(MACOS_RUNTIME_FILES).map(([role, path]) => [role, { path, sha256: hash }]));
  const value = { kind: 'macos-exact-package-acceptance', platform: 'darwin-arm64', version, product,
    hostAsset: macosHostPin(version), runtimeFiles, runtimeReceiptSha256: hash, oldProduct: { ...PUBLISHED_OLD_PRODUCT },
    upgradeSelection: macosUpgradeSelection({ version: '0.3.0', engines: { dsh: '0.2.2-rc.2' } }, version),
    upgradeSourceHost: { asset: { ...macosHostPin('0.2.2-rc.2'), sha256: hash, size: 200 }, runtimeFiles: structuredClone(runtimeFiles) },
    verifierSha256: verifierHash, passed: true, cleanupVerified: true, realCredentialsUsed: false, published: false,
    gates: mapMacosGates({ product, version, stages }),
    execution: { platform: 'darwin', arch: 'arm64', context: { kind: 'local' },
      startedAt: '2026-11-14T00:00:00.000Z', finishedAt: '2026-11-14T01:00:00.000Z' },
    stages: stages.map(({ payload, ...row }) => row) };
  const write = () => json(join(target, 'receipt.json'), { ...value, runSha256: executionSha256(value) });
  write();
  const result = await collectMacosEvidence(directory, product, { verifierSha256: verifierHash });
  const actual = result.targets.find(row => row.version === version);
  assert.equal(actual.passed, true);
  assert.equal(actual.upgradeScope, 'forward-host-and-plugin-upgrade-original-session-cut');
  assert.equal(actual.rollbackScope, 'not-run-forward-only');
  assert.equal(result.humanReady, false);
  value.upgradeSourceHost.runtimeFiles.archive.sha256 = 'f'.repeat(64); write();
  await assert.rejects(collectMacosEvidence(directory, product, { verifierSha256: verifierHash }));
  value.upgradeSourceHost.runtimeFiles.archive.sha256 = hash;
  value.runtimeReceiptSha256 = 'f'.repeat(64); write();
  await assert.rejects(collectMacosEvidence(directory, product, { verifierSha256: verifierHash }));
  value.runtimeReceiptSha256 = hash;
  value.oldProduct.sha256 = hash; write();
  await assert.rejects(collectMacosEvidence(directory, product, { verifierSha256: verifierHash }));
});

test('missing jobs and interrupted helpers remain explicit missing targets', async () => {
  const directory = temporary();
  mkdirSync(join(directory, 'macos-full-' + version));
  const result = await collectMacosEvidence(directory, product, { verifierSha256: verifierHash });
  assert.equal(result.summary.notRun, 7);
  assert.equal(result.passed, false);
  assert.equal(result.targets.find(row => row.version === version).platform, 'darwin-arm64');
  assert.equal(result.targets.find(row => row.version === version).dsh, version);
  assert.equal(result.targets.find(row => row.version === version).blocker, 'MISSING_FINAL_EXECUTION_RECEIPT');
});

test('verifier fingerprint changes with helper, lock and install policy; closure is checked without execution', async () => {
  const source = temporary();
  for (const path of [...ACCEPTANCE_TOOL_FILES, ...ACCEPTANCE_WORKFLOW_FILES, 'package-lock.json', '.npmrc',
    'scripts/lib/retained-session.mjs', 'scripts/internal-candidate-host.mjs']) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), 'fingerprint fixture ' + path);
  }
  const before = await acceptanceVerifierIdentity(product, source);
  writeFileSync(join(source, 'scripts/compatibility-smoke-host.mjs'), 'changed fixture child');
  const child = await acceptanceVerifierIdentity(product, source);
  assert.notEqual(before.sha256, child.sha256);
  writeFileSync(join(source, 'package-lock.json'), 'changed fixture lock');
  const lock = await acceptanceVerifierIdentity(product, source);
  assert.notEqual(lock.sha256, child.sha256);
  writeFileSync(join(source, '.npmrc'), 'legacy-peer-deps=false\n');
  assert.notEqual((await acceptanceVerifierIdentity(product, source)).sha256, lock.sha256);
  for (const path of ['scripts/lib/retained-session.mjs', 'scripts/internal-candidate-host.mjs',
    '.github/workflows/macos-package-transport.yml', '.github/workflows/offline-gates.yml']) {
    const prior = await acceptanceVerifierIdentity(product, source);
    writeFileSync(join(source, path), 'changed fixture dependency ' + path);
    assert.notEqual((await acceptanceVerifierIdentity(product, source)).sha256, prior.sha256, 'Missing runtime fingerprint input: ' + path);
  }
  const result = await build({ absWorkingDir: root, entryPoints: ACCEPTANCE_TOOL_FILES.filter(path => path.endsWith('.mjs')),
    outdir: 'unused-macos-closure', bundle: true, platform: 'node', format: 'esm', packages: 'external',
    treeShaking: false, metafile: true, write: false, logLevel: 'silent',
    plugins: [{ name: 'desktop-fixture-copy-layout', setup(builder) {
      builder.onResolve({ filter: /^\.\/host-fixture\.mjs$/ }, args => {
        // Desktop prepare copies this explicit fixture beside desktop-fixture.
        assert.equal(args.importer.replaceAll('\\', '/'), join(root, 'fixtures/deferred-release/desktop-fixture.mjs').replaceAll('\\', '/'));
        return { path: join(root, 'fixtures/internal-candidate/host-fixture.mjs') };
      });
    } }] });
  for (const path of Object.keys(result.metafile.inputs).map(value => value.replaceAll('\\', '/'))) {
    assert.ok(ACCEPTANCE_TOOL_FILES.includes(path) || packagedSource(path), 'Missing verifier input: ' + path);
  }
  assert.equal(existsSync(join(root, 'unused-macos-closure')), false);
});

test('reviewed public source closure selects exact product and required helpers without artifacts or research data', async () => {
  assert.ok(PUBLIC_MACOS_SUPPORT_FILES.includes('.gitattributes'), 'The byte-preserving transport policy must be reviewed.');
  assert.ok(PUBLIC_MACOS_SUPPORT_FILES.includes('.npmrc'), 'The reviewed dependency-install policy must travel with the public source.');
  assert.ok(PUBLIC_MACOS_SUPPORT_FILES.includes('test/retained-session-cases.mjs'), 'Existing deferred tests require the shared reader cases.');
  const directory = temporary();
  const required = [...new Set([...product.sourceHashes.map(row => row.file), ...ACCEPTANCE_TOOL_FILES, ...PUBLIC_MACOS_SUPPORT_FILES])];
  for (const path of required) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), 'public fixture ' + path);
  }
  const manifest = { ...product, sourceHashes: [{ file: 'package.json', sha256: sha256('public fixture package.json') }] };
  const closure = await reviewedMacosSourceClosure(manifest, directory);
  assert.equal(closure.files.length, required.length);
  assert.equal(closure.productSha256, product.sha256);
  assert.ok(closure.files.every(row => !/^(artifacts|node_modules|docs\/context)\//.test(row.path)));
  writeFileSync(join(directory, 'package.json'), 'changed product');
  await assert.rejects(reviewedMacosSourceClosure(manifest, directory));
  const result = await build({ absWorkingDir: root,
    entryPoints: ['scripts/pack-internal.mjs', 'test/compatibility-evidence.test.mjs', 'test/retained-session-cases.mjs'],
    outdir: 'unused-public-macos-closure', bundle: true, platform: 'node', format: 'esm', packages: 'external',
    treeShaking: false, metafile: true, write: false, logLevel: 'silent' });
  for (const path of Object.keys(result.metafile.inputs).map(value => value.replaceAll('\\', '/'))) {
    assert.ok(required.includes(path) || packagedSource(path), 'Unselected public verifier dependency: ' + path);
  }
  assert.equal(existsSync(join(root, 'unused-public-macos-closure')), false);
});

test('workflow preserves exact package, all seven targets, read-only privileges and failure artifacts', () => {
  const text = readFileSync(join(root, '.github/workflows/macos-full-acceptance.yml'), 'utf8');
  assert.ok(text.includes(FROZEN_PRODUCT_SHA256));
  for (const target of ACCEPTANCE_VERSIONS) assert.ok(text.includes('"' + target + '"'));
  assert.match(text, /max-parallel: 2/);
  assert.match(text, /runs-on: macos-15/);
  const jobMinutes = Number(text.match(/^  macos:[\s\S]*?^    timeout-minutes: (\d+)/m)?.[1]);
  assert.equal(jobMinutes, 150);
  const driver = readFileSync(join(root, 'scripts/macos-full-acceptance.mjs'), 'utf8');
  const driverMinutes = Number(driver.match(/signal: AbortSignal\.timeout\((\d+) \* 60_000\)/)?.[1]);
  assert.equal(driverMinutes, 115);
  const macJob = text.split(/^  macos:\s*$/m)[1].split(/^  evidence:\s*$/m)[0];
  const actionBudgets = [...macJob.matchAll(/^        timeout-minutes: (\d+)$/gm)].map(match => Number(match[1]));
  assert.deepEqual(actionBudgets, [3, 3, 10, 3, 3, 1, 117, 5]);
  assert.equal(actionBudgets.length, (macJob.match(/^      - /gm) ?? []).length, 'Every action needs its own finite timeout.');
  assert.equal(actionBudgets.slice(0, 6).reduce((sum, value) => sum + value, 0), 23);
  assert.equal(actionBudgets[6] - driverMinutes, 2, 'The execution step leaves time after the driver deadline.');
  assert.equal(jobMinutes - actionBudgets.reduce((sum, value) => sum + value, 0), 5,
    'All setup, execution and receipt-upload caps fit inside the job with a five-minute overhead margin.');
  assert.deepEqual(EVIDENCE_TIMEOUTS, { metadata: 20_000, asset: 900_000 });
  const stepTimeouts = [...driver.matchAll(/timeout: ([\d_]+)/g)].map(match => Number(match[1].replaceAll('_', '')));
  assert.deepEqual(stepTimeouts, [180_000, 600_000, 120_000, 180_000, 600_000, 780_000]);
  assert.ok(stepTimeouts.every(value => Number.isSafeInteger(value) && value > 0 && value < driverMinutes * 60_000));
  assert.doesNotMatch(driver, /\bInfinity\b|--fetch-retries=[2-9]/);
  assert.match(text, /contents: read\n  actions: read/);
  assert.equal((text.match(/actions\/checkout@/g) ?? []).length, (text.match(/persist-credentials: false/g) ?? []).length);
  assert.doesNotMatch(text, /npm (?:run (?:build|pack)|publish)|--legacy-peer-deps(?:\s|$)|secrets\./m);
  assert.match(text, /if: always\(\) && needs.inputs.result == 'success'/);
  assert.match(text, /macos-full\/evidence\/\*\.json/);
  assert.doesNotMatch(text, /path:.*(?:private|profile|credentials)/);
  for (const match of text.matchAll(/uses: ([^\s]+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
});

test('current offline and browser jobs retain normal dependency resolution', () => {
  const text = readFileSync(join(root, '.github/workflows/offline-gates.yml'), 'utf8');
  assert.equal((text.match(/npm ci --ignore-scripts --legacy-peer-deps=false/g) ?? []).length, 2);
  assert.doesNotMatch(text, /--legacy-peer-deps(?:\s|$)|--force(?:\s|$)/m);
});

test('registered branch entry rejects unauthorized or ambiguous compatibility dispatches', () => {
  const text = readFileSync(join(root, '.github/workflows/offline-gates.yml'), 'utf8');
  const request = text.split(/^  compatibility-request:\s*$/m)[1].split(/^  compatibility-transport:\s*$/m)[0];
  const snippet = request.match(/node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n\s*NODE/)[1];
  const body = snippet.replace(/^\s*import [^\r\n]+;\r?\n/gm, '');
  const environment = {
    GITHUB_REPOSITORY: 'Lain-in-coding/dsh-grok-search',
    GITHUB_REF: 'refs/heads/ci/compatibility-040-macos-20261115',
    GITHUB_SHA: 'a'.repeat(40), ACCEPTANCE_STAGE: 'transport', CONFIRMED: 'true',
    SOURCE_COMMIT: 'a'.repeat(40), PACKAGE_RUN: '', OLD_RUN: '', DESKTOP_CANDIDATE: 'false',
    TARGET_VERSION: 'all',
  };
  const run = overrides => runInNewContext(body, { assert, process: { env: { ...environment, ...overrides } } }, { timeout: 1000 });
  run({});
  run({ ACCEPTANCE_STAGE: 'acceptance', SOURCE_COMMIT: '', PACKAGE_RUN: '123', OLD_RUN: '123' });
  run({ ACCEPTANCE_STAGE: 'acceptance', SOURCE_COMMIT: '', PACKAGE_RUN: '123', OLD_RUN: '123', TARGET_VERSION: version });
  for (const overrides of [
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REPOSITORY: 'other/repository' }, { CONFIRMED: 'false' },
    { DESKTOP_CANDIDATE: 'true' }, { ACCEPTANCE_STAGE: 'unknown' }, { SOURCE_COMMIT: 'b'.repeat(40) },
    { PACKAGE_RUN: '123' }, { OLD_RUN: '123' },
    { TARGET_VERSION: '0.2.1-rc.2' }, { TARGET_VERSION: 'untrusted' },
    { ACCEPTANCE_STAGE: 'acceptance', SOURCE_COMMIT: '', PACKAGE_RUN: '', OLD_RUN: '123' },
    { ACCEPTANCE_STAGE: 'acceptance', SOURCE_COMMIT: '', PACKAGE_RUN: '123', OLD_RUN: '0' },
  ]) assert.throws(() => run(overrides), 'An invalid dispatch must not start a runner.');
  assert.match(text, /compatibility-transport:[\s\S]*?needs: compatibility-request/);
  assert.match(text, /compatibility-acceptance:[\s\S]*?needs: compatibility-request/);
  assert.match(text, /uses: \.\/\.github\/workflows\/macos-package-transport\.yml/);
  assert.match(text, /uses: \.\/\.github\/workflows\/macos-full-acceptance\.yml/);
  assert.equal((text.match(/if: github\.event_name != 'workflow_dispatch' \|\| inputs\.compatibility_stage == 'none'/g) ?? []).length, 2,
    'Explicit compatibility stages must not rerun unrelated offline and browser jobs.');
  assert.doesNotMatch(text, /secrets: inherit|contents: write|packages: write|npm publish|git push/);
  for (const file of ACCEPTANCE_WORKFLOW_FILES.filter(file => !file.endsWith('offline-gates.yml'))) {
    const reusable = readFileSync(join(root, file), 'utf8');
    assert.match(reusable, /workflow_call:/);
    assert.match(reusable, /workflow_dispatch:/);
  }
});

test('partial macOS diagnostics keep the collector seven-target contract and preserve real HMR failure data', () => {
  const text = readFileSync(join(root, '.github/workflows/macos-full-acceptance.yml'), 'utf8');
  assert.match(text, /version: \$\{\{ fromJSON\(inputs\.target_version == 'all'/);
  assert.match(text, /target_version:[\s\S]*?default: all/);
  const driver = readFileSync(join(root, 'scripts/macos-full-acceptance.mjs'), 'utf8');
  assert.match(driver, /id === 'first-use' && result\.code !== 0/);
  assert.match(driver, /first-use-disable-diagnostic\.json/);
  assert.match(driver, /if \(id === 'first-use' && firstUsePreparation\)/);
  assert.match(driver, /assert\.equal\(await hashFile\(grok\), firstUsePreparation\.program\.sha256\)/);
  const fixture = readFileSync(join(root, 'fixtures/deferred-release/desktop-fixture.mjs'), 'utf8');
  const probe = fixture.slice(fixture.indexOf("if (op === 'hmr-files-readonly')"), fixture.indexOf("if (op === 'plugin-manager-state')"));
  assert.match(probe, /identity === undefined/);
  assert.doesNotMatch(probe, /reconcileProfile\(|\.refresh\(|\.observe\(|\.set\(|\.delete\(/);
});

test('Git transport preserves the frozen support matrix instead of normalizing package bytes', () => {
  const text = readFileSync(join(root, '.gitattributes'), 'utf8');
  assert.match(text, /^support-matrix\.json -text -eol whitespace=cr-at-eol$/m);
  assert.match(text, /^\* text=auto eol=lf$/m);
  assert.doesNotMatch(text, /^\* -text/m, 'Do not disable normal source normalization globally.');
});

test('authorized transport producer cannot silently replace the frozen artifact or claim acceptance', () => {
  const text = readFileSync(join(root, '.github/workflows/macos-package-transport.yml'), 'utf8');
  assert.ok(text.includes(FROZEN_PRODUCT_SHA256));
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /if: inputs\.confirm_public_artifact/);
  assert.match(text, /source_commit:/);
  assert.match(text, /if \(\$env:SOURCE_COMMIT -cne \$env:GITHUB_SHA\) \{ throw /);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /runs-on: windows-2025/);
  assert.match(text, /assert\.equal\(await hashFile\(result\.tarball\), expected/);
  assert.match(text, /copyFileSync\(result\.tarball/);
  assert.match(text, /acceptanceExecuted: false, published: false/);
  assert.match(text, /await downloadPublishedOldPackage\(/);
  assert.match(text, /macos-old-package-24ab92c59221/);
  assert.match(text, /readPackageArtifact\(directory, PUBLISHED_OLD_PRODUCT\.sha256\)/);
  assert.match(text, /await reviewedMacosSourceClosure\(checked\.product\)/);
  assert.doesNotMatch(text, /npm run build:client/);
  assert.doesNotMatch(text, /contents: write|packages: write|secrets\.|git push|npm publish|--legacy-peer-deps(?:\s|$)/m);
  assert.doesNotMatch(text, /path:.*artifacts\/\*\*/);
  for (const match of text.matchAll(/uses: ([^\s]+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
});

test('producer executes every hash check against the workflow pin, not a selected-commit constant', async () => {
  const workflow = readFileSync(join(root, '.github/workflows/macos-package-transport.yml'), 'utf8');
  const fixed = workflow.match(/EXPECTED_PACKAGE_SHA256: ([a-f0-9]{64})/)[1];
  const snippet = workflow.match(/@'\r?\n([\s\S]*?)\r?\n\s*'@ \| node --input-type=module/)[1];
  // Execute only the local workflow body with in-memory imports and a fake environment.
  const body = snippet.replace(/^\s*import [^\r\n]+;\r?\n/gm, '');
  const fixture = (selectedHash, artifactHash) => {
    const calls = { packed: 0, copied: 0, checked: null };
    const environment = { RUNNER_TEMP: '/owned-temp', EXPECTED_PACKAGE_SHA256: fixed };
    const sandbox = { assert, constants: { COPYFILE_EXCL: 1 }, join, realpathSync: path => path,
      existsSync: () => false, mkdirSync: () => {}, cleanEnvironment: () => ({ HOME: '/owned-home' }),
      process: { env: environment }, console: { log() {} }, FROZEN_PRODUCT_SHA256: selectedHash,
      async packInternal() { calls.packed++; return { tarball: '/fixture.tgz', packageReceipt: { sha256: artifactHash } }; },
      async hashFile() { return artifactHash; }, copyFileSync() { calls.copied++; },
      readPackageArtifact(_path, expected) {
        calls.checked = expected;
        return { product: { sha256: artifactHash, fileCount: 58, size: 378390 } };
      },
      async reviewedMacosSourceClosure() { return { acceptanceExecuted: false }; },
    };
    return { calls, environment, run: () => runInNewContext('(async () => {\n' + body + '\n})()', sandbox, { timeout: 1000 }) };
  };
  const changed = fixture(hash, hash);
  await assert.rejects(changed.run());
  assert.equal(changed.calls.packed, 0, 'Reject a changed exported pin before running pack.');
  assert.equal(changed.calls.copied, 0);
  const tampered = fixture(fixed, hash);
  await assert.rejects(tampered.run());
  assert.equal(tampered.calls.copied, 0);
  const valid = fixture(fixed, fixed);
  await valid.run();
  assert.equal(valid.calls.checked, fixed);
  assert.equal(valid.calls.copied, 2);
  assert.equal(valid.environment.EXPECTED_PACKAGE_SHA256, undefined, 'The saved workflow pin survives environment clearing.');
});

test('frozen explicit test entry includes the complete macOS acceptance cases', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(manifest.scripts['test:all'], /npm run test:compatibility/);
  assert.match(manifest.scripts['test:compatibility'], /test\/compatibility-evidence\.test\.mjs/);
  const entry = readFileSync(join(root, 'test/compatibility-evidence.test.mjs'), 'utf8');
  assert.ok(entry.includes("import './macos-acceptance-cases.mjs';"), 'Existing explicit suite must import all macOS cases.');
  assert.equal(existsSync(join(root, 'test/macos-acceptance.test.mjs')), false);
});
