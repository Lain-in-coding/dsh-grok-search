import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import {
  ACCEPTANCE_VERSIONS, FULL_ACCEPTANCE_GATES, EVIDENCE_LIMITS, confinedPath, executionSha256,
  fetchVerifiedResource, hashFile, npmIdentity, relativeFile, requireIntegrity, requireSha256, sha256, verifyBytes,
} from './compatibility-evidence.mjs';
import { inspectPackage, validateInstallManifest } from './compatibility-smoke.mjs';
import { PROGRAM_CASE_IDS, casePassed } from './compatibility-program-checks.mjs';

export const FROZEN_PRODUCT_SHA256 = '74b853274ca4ad509b4bc6cce6cf4906c53400e5e01121e6c78e1f6114d34d1f';
export const PUBLISHED_OLD_PRODUCT = Object.freeze({
  name: 'dsh-grok-search', version: '0.3.0',
  sha256: '24ab92c59221d4ef011986afa81022a2d0e6cd1f4bc07358e409e6d8c21d3b48',
  integrity: 'sha512-KTWr90hnR8ZvVq8QF/JXaMt2CynPkGybwJ5x7cY7EQ825AMR8NiVmtIObrvdAkrPjvIkQPVegaSEXuV7VwwawA==',
  size: 348286,
  metadataUrl: 'https://registry.npmjs.org/dsh-grok-search',
  url: 'https://registry.npmjs.org/dsh-grok-search/-/dsh-grok-search-0.3.0.tgz',
});
export const MACOS_RUNTIME_FILES = Object.freeze({
  executable: 'DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  archive: 'DeepSeek Harness.app/Contents/Resources/app.asar',
  fuseBinary: 'DeepSeek Harness.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
});
const historical = integrity => ({ integrity: 'sha512-' + integrity,
  provenance: { kind: 'reviewed-historical-pin', file: '.github/workflows/macos-beta-gate.yml' } });
export const MACOS_HOST_PINS = Object.freeze({
  '0.2.1-rc.2': historical('vgGV720lZGEd2MnjVFOvhLVafwQH3iUDindQwwSjQ7AJaeZuu6UvjR2Msae2dkGS1SeMxxYCBu5Ks13n+K9Ydw=='),
  '0.2.1-rc.3': historical('0tCeP/zLGLtsH+S4BD4TIyRJ8TwRhh7xaJprTMOUoEfj7hYJFC3G5l6nl/2zCTS41MeE9k+KRN19RE9sqX6goQ=='),
  '0.2.1-rc.4': null,
  '0.2.1-rc.5': historical('SPXR+TMC5+7v9R544aKgA2CkDrLr2XyNL/35/NuxGBbP5nrSTEGMurNRAi+R1RSlcWZm3KNdySAt0RS8Qizv9g=='),
  '0.2.2-rc.1': historical('mHn+lwXZd7I3ZvakFhRg0lxrGe0pNSmWhMU65AQiyrjy/yfa0C8Rq6nQ6tLcxnqdFYl+j5BN4ghOToTLiT2qGA=='),
  '0.2.2-rc.2': historical('SAKrGOp6y3vla/r7QG6hP+y3LfHeRKS3xQ+lxFBuiF7ezSt+dqkCedm9znqKqr7akCkLgag0GnC+yZhkAWL/+Q=='),
  '0.2.2-rc.3': {
    integrity: 'sha512-UThWXKCqiiUnjFgij655+Gc1MgiSl+Ybl71jkQi48BhcBCN0XSDNT4GGmGJY3nvEqnkLT3LtWbL6wy6t/kRxIw==',
    sha256: '1648a29609710d852f04fb3c50602ff37b1ed0def1d2aff65ce813daa5a4f4a4',
    size: 362840431,
    provenance: { kind: 'official-update',
      metadataUrl: 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml',
      metadataSha256: '7043b285fcfff967fb68884814045e7da3035b58a925f92f620d50196884f49e' },
  },
});

export function macosHostPin(version) {
  assert.ok(ACCEPTANCE_VERSIONS.includes(version), 'Unknown acceptance target.');
  const pin = MACOS_HOST_PINS[version];
  if (!pin) throw Object.assign(new Error('No reviewed official macOS asset hash for this target.'),
    { code: 'MACOS_HOST_PIN_MISSING' });
  return { ...structuredClone(pin), version,
    url: `https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-${version}-mac-arm64.zip` };
}

export function sameHostUpgradeSelection(manifest, version) {
  assert.ok(ACCEPTANCE_VERSIONS.includes(version), 'Unknown acceptance target.');
  const range = manifest?.engines?.dsh;
  if (typeof range !== 'string' || !semver.validRange(range)) {
    return { eligible: false, code: 'OLD_PACKAGE_HOST_RANGE_MISSING', version };
  }
  const eligible = semver.satisfies(version, range, { includePrerelease: true });
  return { eligible, code: eligible ? null : 'OLD_PACKAGE_HOST_INCOMPATIBLE',
    version, oldPluginVersion: manifest.version, hostRange: range,
    requiresCrossRuntimeUpgrade: !eligible };
}

export function macosUpgradeSelection(manifest, version) {
  const same = sameHostUpgradeSelection(manifest, version);
  if (same.eligible) return { ...same, mode: 'same-host' };
  if (version === '0.2.2-rc.3' && manifest?.version === PUBLISHED_OLD_PRODUCT.version
    && same.code === 'OLD_PACKAGE_HOST_INCOMPATIBLE' && sameHostUpgradeSelection(manifest, '0.2.2-rc.2').eligible) {
    return { ...same, eligible: true, code: null, mode: 'cross-host', fromVersion: '0.2.2-rc.2',
      previousSameHostCode: same.code, rollbackScope: 'not-run-forward-only' };
  }
  return { ...same, mode: 'unavailable' };
}

export function readPackageArtifact(directory, expectedSha256) {
  requireSha256(expectedSha256);
  const names = readdirSync(directory);
  assert.equal(names.length, 2, 'Transport must contain only one tgz and package-receipt.json.');
  const name = names.find(value => /^dsh-grok-search-[a-zA-Z0-9.+-]+\.tgz$/.test(value));
  assert.ok(name && names.includes('package-receipt.json'), 'Invalid package artifact layout.');
  const path = confinedPath(directory, name), receiptPath = confinedPath(directory, 'package-receipt.json');
  assert.ok(lstatSync(path).isFile() && lstatSync(receiptPath).isFile()
    && lstatSync(path).size <= EVIDENCE_LIMITS.product && lstatSync(receiptPath).size <= EVIDENCE_LIMITS.receipt);
  const bytes = readFileSync(path), receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.sha256, expectedSha256, 'Receipt differs from the explicit package hash.');
  const identity = verifyBytes(bytes, { sha256: expectedSha256, integrity: requireIntegrity(receipt.integrity) });
  const parsed = inspectPackage(bytes);
  validateInstallManifest(parsed);
  assert.equal(parsed.manifest.name, 'dsh-grok-search');
  assert.equal(receipt.name, parsed.manifest.name);
  assert.equal(parsed.manifest.version, receipt.version);
  assert.ok(Array.isArray(receipt.sourceHashes) && receipt.sourceHashes.length === parsed.files.size);
  const seen = new Set();
  for (const row of receipt.sourceHashes) {
    relativeFile(row.file);
    assert.ok(!seen.has(row.file) && parsed.files.has(row.file), 'Invalid package source inventory.');
    seen.add(row.file);
    assert.equal(sha256(parsed.files.get(row.file)), requireSha256(row.sha256), 'Package file differs from receipt.');
  }
  return { path, bytes, files: parsed.files, manifest: parsed.manifest, receipt, product: {
    name: parsed.manifest.name, version: parsed.manifest.version, ...identity,
    fileCount: parsed.files.size, sourceHashes: structuredClone(receipt.sourceHashes),
  } };
}

export function hashPackageSource(path) {
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= EVIDENCE_LIMITS.product,
    'Package source must be a bounded ordinary file.');
  const bytes = readFileSync(path), after = lstatSync(path);
  assert.ok(bytes.length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs && before.ino === after.ino && before.dev === after.dev
    && after.isFile() && !after.isSymbolicLink(), 'Package source changed during hashing.');
  return sha256(bytes);
}

export function packageTransportReceipt(bytes, expected) {
  const identity = verifyBytes(bytes, { sha256: requireSha256(expected.sha256),
    integrity: requireIntegrity(expected.integrity), size: expected.size });
  const parsed = inspectPackage(bytes);
  validateInstallManifest(parsed);
  assert.equal(parsed.manifest.name, expected.name);
  assert.equal(parsed.manifest.version, expected.version);
  return { name: parsed.manifest.name, version: parsed.manifest.version, ...identity,
    sourceHashes: [...parsed.files].map(([file, content]) => ({ file, sha256: sha256(content) })),
    acceptanceExecuted: false, published: false };
}

export async function downloadPublishedOldPackage({ fetchImpl = globalThis.fetch, signal } = {}) {
  const pin = PUBLISHED_OLD_PRODUCT;
  const exactUrl = expected => actual => assert.equal(actual, expected, 'Published package URL differs from its reviewed pin.');
  const metadata = await fetchVerifiedResource(pin.metadataUrl,
    { fetchImpl, signal, validateUrl: exactUrl(pin.metadataUrl) });
  const selected = npmIdentity(metadata, { packageName: pin.name, version: pin.version });
  assert.equal(selected.source.url, pin.url);
  assert.equal(selected.integrity, pin.integrity, 'Published metadata differs from its reviewed integrity.');
  const downloaded = await fetchVerifiedResource(pin.url, { fetchImpl, signal,
    validateUrl: exactUrl(pin.url), limit: pin.size });
  const receipt = packageTransportReceipt(downloaded, pin);
  return { bytes: downloaded, receipt: { ...receipt,
    source: { ...selected.source, reviewedOn: '2026-11-14' } } };
}

export const MACOS_STAGES = Object.freeze([
  'admission', 'smoke', 'search-contract', 'github-contract', 'program-host', 'first-use', 'manager', 'renderer', 'upgrade',
]);

export const PROGRAM_HOST_CASES = PROGRAM_CASE_IDS;

const securityFields = ['snapshotOk', 'saveOk', 'redacted', 'revealMatches', 'forwardedDenied',
  'restrictedSnapshotOk', 'deniedSave', 'deniedDestination', 'unauthenticatedDenied'];
const searchCases = ['host-default-query-limit', 'queued-cancellation-does-not-dispatch',
  'queued-deadline-does-not-dispatch', 'all-providers-failed-without-official-fallback'];
const githubCases = ['default-off', 'registered-tool', 'pagination-and-continuation', 'agent-isolation',
  'official-web-fetch', 'permission-denial', 'stop-before-body', 'disable-and-restore', 'dispose'];
const rendererCases = ['same packaged client', 'first search uses no original provider',
  'failure did not call original provider', 'hot disable restores previous author route',
  'reenable takes over without restart', 'search after restart remains functional without original fallback',
  'actual Session discovers and invokes GitHub tool', 'GitHub logs contain no original discussion text'];
const normalExit = row => (row?.exitCode ?? row?.code) === 0 && row.forced === false
  && !row.signal && !row.closeError && !row.shutdownError;
const allTrue = (row, names) => names.every(name => row?.[name] === true);
const exactSourceSubset = (rows, product) => Array.isArray(rows) && rows.length > 0 && rows.every(row =>
  product.sourceHashes.some(expected => row.file === expected.file && row.sha256 === expected.sha256));
const oneVersion = (row, version) => row?.results?.length === 1 && row.results[0].version === version
  ? row.results[0] : null;
const wholeProduct = (rows, product) => Array.isArray(rows) && product.sourceHashes.every(expected =>
  rows.some(row => row.file === expected.file && row.sha256 === expected.sha256));
const nativeInstallChecked = (audit, version) => audit?.schemaVersion === 1 && audit.installedVersion === version
  && audit.hostCopies === false && Number.isSafeInteger(audit.checkedModuleDirectories) && audit.checkedModuleDirectories > 0
  && audit.policyScope === 'profile-local-config-and-installed-tree'
  && audit.installPolicy?.autoInstallPeers === true && audit.installPolicy.strictPeerDependencies === true
  && audit.installPolicy.legacyPeerDeps === false && audit.installPolicy.force === false;

export function crossHostUpgradeChecked(row, product, version) {
  const value = oneVersion(row, version)?.evidence, pair = value?.crossHost, retained = value?.retainedSession;
  const scope = 'forward-host-and-plugin-upgrade-original-session-cut';
  if (version !== '0.2.2-rc.3' || row?.crossHostProductUpgradeValidated !== true
    || row.upgradeFailureRecoveryValidated !== false || value?.inPlaceOnly !== true
    || value.rollbackScope !== 'not-run-forward-only' || !normalExit(value.exit)
    || pair?.passed !== true || pair.scope !== scope || pair.fromHostVersion !== '0.2.2-rc.2' || pair.toHostVersion !== version
    || pair.oldPluginVersion !== PUBLISHED_OLD_PRODUCT.version || pair.newPluginVersion !== product.version
    || pair.oldPackageSha256 !== PUBLISHED_OLD_PRODUCT.sha256 || pair.newPackageSha256 !== product.sha256
    || !/^[a-f0-9]{64}$/.test(pair.targetRuntimeReceiptSha256)
    || pair.hostDowngradeValidated !== false || !allTrue(pair, ['sameProfile', 'sameUserData', 'forwardOnly',
      'normalFinalExit', 'configurationUnchangedAtBoundary', 'controlHistoryUnchangedAtBoundary',
      'configurationUnchanged', 'programCacheUnchanged', 'oldSessionHistoryRetained'])
    || retained?.passed !== true || retained.scope !== scope || retained.hostTransitionValidated !== true
    || retained.sameIdSearchEveryStage !== true) return false;
  const rejected = pair.oldPackageRejected;
  if (rejected?.hostVersion !== version || rejected.pluginVersion !== PUBLISHED_OLD_PRODUCT.version
    || rejected.packageSha256 !== PUBLISHED_OLD_PRODUCT.sha256 || rejected.code !== 'incompatible-version'
    || rejected.exempted !== false || rejected.searchIssued !== false || rejected.officialSearchCalls !== 0
    || rejected.oldPluginActive !== false || rejected.protectionStatus !== 'old-plugin-unloaded-not-protected'
    || rejected.evidence !== 'official-plugin-manager-incompatible-result') return false;
  const range = rejected.requirements?.['engines.dsh'];
  if (typeof range !== 'string' || !semver.validRange(range)
    || semver.satisfies(version, range, { includePrerelease: true })
    || !semver.satisfies(pair.fromHostVersion, range, { includePrerelease: true })) return false;
  const identity = ['sessionId', 'throughSeq', 'recordCount', 'recordsSha256', 'seededHostVersion',
    'seededPluginVersion', 'seededPackageSha256', 'seedInstanceId'];
  if (!retained.sessionId || !retained.seedInstanceId || !/^[a-f0-9]{64}$/.test(retained.recordsSha256)
    || !Number.isSafeInteger(retained.throughSeq) || retained.throughSeq < 0
    || !Number.isSafeInteger(retained.recordCount) || retained.recordCount <= 0
    || retained.seededHostVersion !== pair.fromHostVersion || retained.seededPluginVersion !== pair.oldPluginVersion
    || retained.seededPackageSha256 !== pair.oldPackageSha256) return false;
  const sameHistory = entry => identity.every(key => entry?.[key] === retained[key]);
  const cold = entry => entry?.coldReadBeforePrompt === true && entry.historyMatched === true
    && typeof entry.hostInstanceId === 'string' && entry.hostInstanceId
    && typeof entry.previousHostInstanceId === 'string' && entry.previousHostInstanceId
    && entry.hostInstanceId !== entry.previousHostInstanceId && entry.previousExitCode === 0
    && entry.previousExitSignal === null && entry.previousExitForced === false;
  if (!sameHistory(pair.boundaryHistory) || !cold(pair.boundaryHistory)) return false;
  const expected = [
    ['old-configured', pair.fromHostVersion, pair.oldPluginVersion, pair.oldPackageSha256],
    ['old-restarted', pair.fromHostVersion, pair.oldPluginVersion, pair.oldPackageSha256],
    ['tarball-in-place-restarted', version, product.version, product.sha256],
  ];
  return value.stages?.length === expected.length && expected.every(([phase, host, plugin, hash], index) => {
    const stage = value.stages[index], history = stage?.retainedSession;
    return stage?.phase === phase && stage.hostVersion === host && stage.pluginVersion === plugin
      && stage.packageSha256 === hash && Number.isSafeInteger(stage.installedFilesVerified) && stage.installedFilesVerified > 0
      && allTrue(stage, ['configurationUnchanged', 'programCacheUnchanged', 'fileKeyEditable', 'searchPassed', 'fetchPassed', 'chatPassed'])
      && stage.originalSearchDelta === 0 && stage.programSource === 'private-cache'
      && sameHistory(history) && allTrue(history, ['historyMatched', 'sameIdSearch', 'originalCutReadbackAfterTurns'])
      && history.searchSessionId === retained.sessionId && (index === 0 ? history.coldReadBeforePrompt === false : cold(history))
      && (index !== 2 || stage.installedFilesVerified === product.fileCount
        && nativeInstallChecked(stage.nativeInstallAudit, product.version));
  }) && value.stages[1].retainedSession.previousHostInstanceId === retained.seedInstanceId
    && pair.boundaryHistory.previousHostInstanceId === value.stages[1].retainedSession.hostInstanceId
    && value.stages[2].retainedSession.previousHostInstanceId === pair.boundaryHistory.hostInstanceId;
}

function managerChecks(row, product, version) {
  const result = oneVersion(row, version);
  return row?.status === 'pass' && row.counts?.pass === 1 && row.counts.fail === 0 && row.fatal === null
    && result?.status === 'pass' && row.packageReceipts?.product?.sha256 === product.sha256
    && wholeProduct(row.packageReceipts.product.sourceHashes, product)
    && row.originalHashes?.unchanged === true && row.sourcesUnchanged === true
    && row.protocolAssociationUnchanged === true && row.cleanupValidated === true
    && row.exits?.length > 0 && row.exits.every(normalExit)
    && row.originalDesktopRuntimeValidated === true && row.packagedDesktopStartupValidated === true;
}

function sourceCheck(stage, payload, product, version) {
  if (stage === 'admission') return payload?.passed === true && payload.productSha256 === product.sha256
    && payload.checkedFiles === product.fileCount && payload.hostCopies === false
    && payload.legacyPeerDeps === false;
  if (stage === 'smoke') return payload?.passed === true && payload.hostVersion === version
    && payload.pluginVersion === product.version && payload.realCredentialsUsed === false
    && payload.cleanupVerified === true && payload.officialSearchCalls === 0
    && payload.observations?.packageAdmission?.hostCopies === false && payload.gates?.length === 4
    && ['package-admission', 'capabilities', 'search-no-official-fallback', 'cancellation']
      .every(id => payload.gates?.filter(gate => gate.id === id && gate.passed === true).length === 1);
  if (stage === 'program-host') return payload?.schemaVersion === 1 && payload.kind === 'compatibility-program-host'
    && payload.hostVersion === version && payload.pluginVersion === product.version && payload.productSha256 === product.sha256
    && payload.realCredentialsUsed === false && payload.officialSearchCalls === 0
    && Array.isArray(payload.cases) && new Set(payload.cases.map(row => row.id)).size === payload.cases.length
    && payload.cases.every(row => PROGRAM_HOST_CASES.includes(row.id))
    && /^[a-f0-9]{64}$/.test(payload.grokSha256)
    && payload.transport === 'loopback-responses-and-exact-registry-remap' && payload.installer === 'frozen-product-unmodified';
  if (['search-contract', 'github-contract'].includes(stage)) return payload?.passed === true
    && payload.version === version && payload.candidate === product.version && payload.syntheticOnly === true
    && exactSourceSubset(payload.sourceHashes, product) && Array.isArray(payload.cases)
    && (stage === 'search-contract' ? searchCases : githubCases).every(name => payload.cases.includes(name))
    && (stage !== 'search-contract' || payload.originalProviderCalls === 0);
  if (stage === 'renderer') {
    const result = oneVersion(payload, version);
    return payload?.passed === true && payload.fatal === null && payload.live === false
      && payload.tarballSha256 === product.sha256 && payload.sourceUnchanged === true
      && wholeProduct(payload.sourceHashes, product)
      && payload.originalFilesUnchanged === true && payload.associationUnchanged === true
      && payload.packagedStartupVerified === true && payload.syntheticKeysOnly === true
      && payload.realKeyFilesWritten === false && payload.exits?.length > 0 && payload.exits.every(normalExit)
      && result?.passed === true && result.editableConfig === true
      && result.checks?.length > 0 && result.checks.every(check => check.passed === true)
      && rendererCases.every(name => result.checks.some(check => check.name === name));
  }
  return managerChecks(payload, product, version);
}

// This is an adapter for named, actually executed helpers, not a new pass/fail
// protocol. A successful four-gate smoke cannot satisfy seven-gate acceptance.
export function mapMacosGates({ product, version, stages = [] }) {
  assert.ok(ACCEPTANCE_VERSIONS.includes(version));
  requireSha256(product.sha256);
  assert.equal(new Set(stages.map(row => row.id)).size, stages.length, 'Duplicate helper result.');
  assert.ok(stages.every(row => MACOS_STAGES.includes(row.id)), 'Unknown helper result.');
  const byId = new Map(stages.map(row => [row.id, row]));
  const check = (id, stage, predicate = () => true) => {
    const row = byId.get(stage);
    if (!row || row.status === 'not-run') return { id, status: 'not-run', stage };
    const passed = row.status === 'passed' && row.exitCode === 0 && !row.failure && !row.signal
      && sourceCheck(stage, row.payload, product, version) && predicate(row.payload);
    return { id, status: passed ? 'passed' : 'failed', stage };
  };
  const program = id => {
    const row = byId.get('program-host');
    if (!row || row.status === 'not-run') {
      return { id, status: 'not-run', stage: 'program-host' };
    }
    if (!row.payload?.cases?.some(value => value.id === id)) {
      return { id, status: row.status === 'failed' ? 'failed' : 'not-run', stage: 'program-host' };
    }
    const passed = (() => {
      const payload = row.payload;
      if (![0, 1].includes(row.exitCode) || row.failure || row.signal || !sourceCheck('program-host', payload, product, version)) return false;
      const value = payload.cases.find(item => item.id === id);
      const variants = id === PROGRAM_HOST_CASES[1] ? ['disable', 'dispose'] : [null];
      return value.passed === true && value.status === 'passed' && casePassed(id, value.observations)
        && (id !== PROGRAM_HOST_CASES[2] || value.observations.repairedSha256 === payload.grokSha256)
        && value.runs?.length === variants.length && variants.every(variant =>
          value.runs.filter(run => run.variant === variant).length === 1)
        && value.runs.every(run => run.passed === true && run.status === 'passed' && run.exitCode === 0
          && run.id === id && run.exitSignal === null && !run.code && run.receipt?.cleanupVerified === true
          && run.receipt.passed === true && run.receipt.id === id && run.receipt.variant === run.variant && !run.receipt.code
          && run.receipt.hostVersion === version && run.receipt.pluginVersion === product.version
          && run.receipt.productSha256 === product.sha256 && run.receipt.grokSha256 === payload.grokSha256
          && run.receipt.realCredentialsUsed === false && run.receipt.officialSearchCalls === 0
          && (id !== PROGRAM_HOST_CASES[2] || run.receipt.observations.repairedSha256 === payload.grokSha256)
          && casePassed(id, run.receipt.observations));
    })();
    return { id, status: passed ? 'passed' : 'failed', stage: 'program-host' };
  };
  const preparationCancel = () => program('pending-program-preparation-cancel');
  const normal = row => oneVersion(row, version)?.evidence;
  const checks = {
    install: [
      check('strict-npm-exact-package-files-no-host-copies', 'admission'),
      check('native-plugin-manager-install', 'manager', row => {
        const install = normal(row)?.productInstall;
        return install?.application === 'applied' && install.changed === true
          && install.target === product.name && (install.error ?? null) === null
          && nativeInstallChecked(normal(row)?.nativeInstallAudit, product.version);
      }),
    ],
    'configuration-security': [
      check('actual-host-settings-rpc-security', 'manager', row => {
        const value = normal(row)?.settingsSecurity;
        return allTrue(value, securityFields) && value.capabilities?.transport === 'loopback'
          && ['forwardedCode', 'deniedSaveCode', 'deniedDestinationCode']
            .every(key => value[key] === 'SETTINGS_SECURE_CONNECTION_REQUIRED');
      }),
      check('editable-config-save-and-restart', 'renderer'),
    ],
    'search-no-official-fallback': [
      check('actual-host-search-batching-errors-queue', 'search-contract'),
      check('native-tool-and-direct-search-protected-window', 'smoke'),
      check('renderer-search-and-failure-protected-window', 'renderer'),
    ],
    cancellation: [
      check('caller-abort-upstream-cancel-and-recovery', 'smoke', row =>
        allTrue(row.observations?.cancellation, ['passed', 'callerReasonPreserved', 'upstreamCancelled', 'recovered'])),
      check('queued-cancellation-does-not-dispatch', 'search-contract'),
      program('managed-grok-child-cancel-and-reap'),
      preparationCancel(),
    ],
    lifecycle: [
      check('native-enable-disable-remove-restart', 'manager', row =>
        normalExit(normal(row)?.finalExit) && normal(row)?.productRemove?.application === 'applied'
          && nativeInstallChecked(normal(row)?.restartNativeInstallAudit, product.version)),
      check('editable-renderer-restart-and-hot-toggle', 'renderer'),
      check('product-upgrade-config-and-cache-retention', 'upgrade', row => {
        const value = normal(row);
        return row.upgradeRetentionValidated === true && value?.nativeUpgradeUiValidated === true
          && value.configurationUnchanged === true && value.cacheReused === true
          && value.noNewProgramCacheDirectory === true && value.programOverrideRequired === false
          && value.configOverrideRequired === false && value.credentialScope === 'synthetic-loopback-only'
          && (value.crossHost ? crossHostUpgradeChecked(row, product, version)
            : row.upgradeFailureRecoveryValidated === true && value.inPlaceOnly === false
              && value.rollbackScope === 'explicit-reinstall-of-old-package-not-cross-resource-atomicity'
              && value.stages?.some(stage => stage.packageSha256 === product.sha256
                && nativeInstallChecked(stage.nativeInstallAudit, product.version)));
      }),
    ],
    'logs-github': [
      check('actual-host-github-permissions-pagination-and-dispose', 'github-contract'),
      check('renderer-log-replay-and-github-session', 'renderer'),
    ],
    'program-preparation': [
      check('empty-cache-private-download-handshake-reuse-and-reap', 'first-use', row => {
        const value = normal(row);
        return row.firstUseAutoDownloadValidated === true && row.productionDiagnosticsUiValidated === true
          && value?.program?.source === 'private-cache' && /^[a-f0-9]{64}$/.test(value.program.sha256)
          && value.program.mcpHandshakeValidated === true && value.defaultConfigCreatedOnlyBySave === true
          && value.manualProfileEditRequired === false && value.sameManagedProcessReused === true
          && value.cacheReused === true && value.nativeDisableReenableValidated === true
          && value.orphanPrograms === 0 && normalExit(value.exit)
          && nativeInstallChecked(value.nativeInstallAudit, product.version);
      }),
      program('program-download-failure-and-repair'),
      preparationCancel(),
    ],
  };
  return FULL_ACCEPTANCE_GATES.map(id => {
    const rows = checks[id];
    const status = rows.some(row => row.status === 'failed') ? 'failed'
      : rows.every(row => row.status === 'passed') ? 'passed' : 'not-run';
    const evidence = [...new Set(rows.map(row => row.stage).filter(Boolean))]
      .flatMap(stage => byId.get(stage)?.evidence ? [byId.get(stage).evidence] : []);
    return { id, status, passed: status === 'passed', checks: rows, evidence };
  });
}

export async function readStageEvidence(root, stages) {
  assert.ok(Array.isArray(stages) && stages.length <= MACOS_STAGES.length);
  const result = [];
  for (const row of stages) {
    assert.ok(MACOS_STAGES.includes(row.id) && ['passed', 'failed', 'not-run'].includes(row.status));
    if (row.status === 'not-run') {
      assert.equal(row.evidence, undefined, 'Unexecuted helpers cannot carry successful evidence.');
      result.push(row); continue;
    }
    assert.equal(row.evidence?.path, row.id + '.json', 'Each helper must reference its own named receipt.');
    const path = confinedPath(root, row.evidence.path);
    assert.equal(await hashFile(path, { limit: EVIDENCE_LIMITS.gate }), requireSha256(row.evidence.sha256),
      'Helper evidence changed after execution.');
    const payload = JSON.parse(readFileSync(path, 'utf8'));
    if (row.sourceEvidence) {
      assert.equal(row.sourceEvidence.sha256, row.evidence.sha256);
      assert.equal(row.sourceEvidence.runId, payload.runId);
    }
    result.push({ ...row, payload });
  }
  return result;
}

export function helpersCleanedUp(stages) {
  const executed = stages.filter(row => row.status !== 'not-run');
  return executed.length > 0 && executed.every(row => {
    if (row.exitCode !== 0 || row.failure || row.signal) return false;
    if (row.id === 'admission') return row.payload?.passed === true;
    if (['smoke', 'program-host'].includes(row.id)) return row.payload?.cleanupVerified === true;
    if (['search-contract', 'github-contract'].includes(row.id)) return row.payload?.passed === true;
    return row.payload?.exits?.length > 0 && row.payload.exits.every(normalExit)
      && (row.id === 'renderer' || row.payload.cleanupValidated === true);
  });
}

const stageSucceeded = row => row.status === 'passed' && row.exitCode === 0 && !row.failure && !row.signal
  && row.payload?.passed !== false && (row.payload?.passed === true || row.payload?.status === 'pass')
  && !row.payload?.code && !row.payload?.error && !row.payload?.fatal;

export function helpersSucceeded(stages) {
  return Array.isArray(stages) && stages.length === MACOS_STAGES.length
    && new Set(stages.map(row => row.id)).size === MACOS_STAGES.length
    && stages.every(row => MACOS_STAGES.includes(row.id) && stageSucceeded(row));
}

function verifyHostInventory(version, asset, runtimeFiles) {
  const pin = macosHostPin(version);
  assert.equal(asset?.version, version);
  assert.equal(asset.url, pin.url);
  assert.equal(asset.integrity, pin.integrity);
  assert.deepEqual(asset.provenance, pin.provenance);
  requireSha256(asset.sha256);
  if (pin.sha256) assert.equal(asset.sha256, pin.sha256);
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= EVIDENCE_LIMITS.asset);
  if (pin.size) assert.equal(asset.size, pin.size);
  assert.deepEqual(Object.keys(runtimeFiles).sort(), Object.keys(MACOS_RUNTIME_FILES).sort());
  for (const [role, path] of Object.entries(MACOS_RUNTIME_FILES)) {
    assert.equal(runtimeFiles[role].path, path);
    requireSha256(runtimeFiles[role].sha256);
  }
}

function verifyRecordedHost(value, stages) {
  if (stages.every(row => row.status === 'not-run')) return;
  verifyHostInventory(value.version, value.hostAsset, value.runtimeFiles);
  for (const row of stages.filter(stage => ['manager', 'first-use', 'upgrade'].includes(stage.id)
    && stage.status === 'passed')) {
    const identity = { executable: value.runtimeFiles.executable.sha256, asar: value.runtimeFiles.archive.sha256 };
    assert.deepEqual(row.payload.originalHashes.before[value.version], identity);
    assert.deepEqual(row.payload.originalHashes.after[value.version], identity);
    if (row.id === 'upgrade') {
      const selection = value.upgradeSelection;
      assert.equal(selection?.eligible, true, 'Upgrade requires an explicit applicable old-host selection.');
      assert.equal(selection.version, value.version);
      assert.equal(selection.code, null);
      if (selection.mode === 'cross-host') {
        assert.equal(selection.fromVersion, '0.2.2-rc.2');
        assert.equal(selection.previousSameHostCode, 'OLD_PACKAGE_HOST_INCOMPATIBLE');
        assert.equal(value.oldProduct?.sha256, PUBLISHED_OLD_PRODUCT.sha256);
        assert.equal(value.oldProduct.version, PUBLISHED_OLD_PRODUCT.version);
        assert.equal(value.oldProduct.integrity, PUBLISHED_OLD_PRODUCT.integrity);
        assert.equal(value.oldProduct.size, PUBLISHED_OLD_PRODUCT.size);
        assert.equal(crossHostUpgradeChecked(row.payload, value.product, value.version), true);
        assert.equal(row.payload.results[0].evidence.crossHost.targetRuntimeReceiptSha256, requireSha256(value.runtimeReceiptSha256));
        const source = value.upgradeSourceHost;
        verifyHostInventory(selection.fromVersion, source?.asset, source?.runtimeFiles);
        const fromIdentity = { executable: source.runtimeFiles.executable.sha256, asar: source.runtimeFiles.archive.sha256 };
        assert.deepEqual(row.payload.originalHashes.before[selection.fromVersion], fromIdentity);
        assert.deepEqual(row.payload.originalHashes.after[selection.fromVersion], fromIdentity);
        assert.equal(row.payload.results[0].evidence.crossHost.oldPackageRejected.requirements['engines.dsh'], selection.hostRange);
        assert.equal(semver.satisfies(value.version, selection.hostRange, { includePrerelease: true }), false);
      } else {
        assert.equal(row.payload.results[0].evidence.crossHost, undefined, 'A same-host selection cannot relabel a cross-host result.');
        assert.equal(semver.satisfies(value.version, selection.hostRange, { includePrerelease: true }), true);
      }
    }
  }
  const program = stages.find(row => row.id === 'program-host' && row.status !== 'not-run' && row.payload?.grokSha256);
  const firstUse = stages.find(row => row.id === 'first-use' && row.status === 'passed');
  if (program && firstUse) assert.equal(program.payload.grokSha256,
    firstUse.payload.results[0].evidence.program.sha256, 'Managed program probe must use the actual first-use binary.');
  if (program && value.firstUsePreparation) assert.equal(program.payload.grokSha256,
    value.firstUsePreparation.program.sha256, 'Independent managed cases must bind to the actual preparation checkpoint.');
}

export async function collectMacosEvidence(root, product, { runId, runAttempt, commit, repository, verifierSha256 } = {}) {
  requireSha256(verifierSha256);
  const targets = [];
  for (const version of ACCEPTANCE_VERSIONS) {
    const target = { version, dsh: version, platform: 'darwin-arm64', host: 'Desktop', environment: 'macos' };
    const directory = join(root, 'macos-full-' + version);
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) { targets.push({ ...target, status: 'not-run', passed: false }); continue; }
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    if (!lstatSync(join(directory, 'receipt.json'), { throwIfNoEntry: false })) {
      targets.push({ ...target, status: 'not-run', passed: false, blocker: 'MISSING_FINAL_EXECUTION_RECEIPT' }); continue;
    }
    const path = confinedPath(directory, 'receipt.json');
    assert.ok(lstatSync(path).size <= EVIDENCE_LIMITS.receipt);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(value.kind, 'macos-exact-package-acceptance');
    assert.deepEqual(value.product, product, 'Evidence package inventory differs.');
    assert.equal(value.version, version);
    assert.equal(value.platform, 'darwin-arm64');
    assert.equal(value.runSha256, executionSha256(value));
    assert.equal(value.verifierSha256, verifierSha256, 'Evidence belongs to another verifier revision.');
    assert.equal(value.execution.platform, 'darwin');
    assert.equal(value.execution.arch, 'arm64');
    assert.ok(Number.isFinite(Date.parse(value.execution.startedAt))
      && Date.parse(value.execution.finishedAt) >= Date.parse(value.execution.startedAt));
    if (runId !== undefined) assert.equal(value.execution.context.kind, 'github-actions');
    assert.equal(value.realCredentialsUsed, false);
    assert.equal(value.published, false);
    assert.equal(value.stages?.length, MACOS_STAGES.length, 'Every helper needs an explicit outcome.');
    for (const [key, expected] of Object.entries({ runId, runAttempt, commit, repository })) {
      if (expected !== undefined) assert.equal(value.execution.context[key], expected, 'Evidence belongs to another CI run.');
    }
    const stages = await readStageEvidence(directory, value.stages);
    const firstUse = stages.find(row => row.id === 'first-use');
    const independentPreparationUsed = stages.some(row => ['program-host', 'renderer', 'upgrade'].includes(row.id)
      && row.status !== 'not-run');
    if (independentPreparationUsed && (!firstUse || !stageSucceeded(firstUse)
      || !sourceCheck('first-use', firstUse.payload, product, version))) {
      assert.ok(value.firstUsePreparation, 'Independent stages require their actual preparation checkpoint when first-use failed.');
    }
    if (value.firstUsePreparation) {
      const preparation = value.firstUsePreparation;
      assert.equal(preparation.evidence?.path, 'first-use-program-prepared.json');
      const path = confinedPath(directory, preparation.evidence.path);
      assert.equal(await hashFile(path, { limit: EVIDENCE_LIMITS.gate }), requireSha256(preparation.evidence.sha256));
      const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
      const { evidence: _evidence, ...recorded } = preparation;
      assert.deepEqual(checkpoint, recorded, 'Preparation checkpoint was rewritten in the final receipt.');
      assert.equal(checkpoint.hostVersion, version);
      assert.equal(checkpoint.productSha256, product.sha256);
      assert.equal(checkpoint.scope, 'first-use-preparation-checkpoint-not-complete-lifecycle-acceptance');
      assert.equal(checkpoint.program?.source, 'private-cache');
      assert.equal(checkpoint.program?.mcpHandshakeValidated, true);
      assert.equal(checkpoint.configCreated, false);
      assert.equal(nativeInstallChecked(checkpoint.nativeInstallAudit, product.version), true);
      requireSha256(checkpoint.program.sha256);
      requireSha256(checkpoint.activeSha256);
    }
    verifyRecordedHost(value, stages);
    const gates = mapMacosGates({ product, version, stages });
    assert.deepEqual(value.gates, gates, 'Summary differs from actual helper evidence.');
    assert.equal(value.cleanupVerified, !value.blocker && helpersCleanedUp(stages));
    assert.equal(value.passed, gates.every(row => row.passed) && value.cleanupVerified === true && helpersSucceeded(stages));
    targets.push({ ...target, status: value.passed ? 'passed'
      : stages.some(row => row.status !== 'not-run' && !stageSucceeded(row)) || gates.some(row => row.status === 'failed')
      || value.blocker && value.blocker !== 'MACOS_HOST_PIN_MISSING' ? 'failed' : 'not-run',
      passed: value.passed, receipt: { path: `macos-full-${version}/receipt.json`, sha256: await hashFile(path) },
      gates, upgradeScope: stages.find(row => row.id === 'upgrade')?.payload?.results?.[0]?.evidence?.crossHost?.scope
        ?? (stages.find(row => row.id === 'upgrade')?.status === 'passed' ? 'same-host-product-upgrade' : 'not-run'),
      rollbackScope: stages.find(row => row.id === 'upgrade')?.payload?.results?.[0]?.evidence?.rollbackScope ?? 'not-run',
      blocker: value.blocker ?? null });
  }
  return { schemaVersion: 1, kind: 'macos-exact-package-acceptance-handoff', product,
    scope: 'macos-arm64-seven-targets-only', targets, passed: targets.every(row => row.passed),
    humanReady: false, published: false,
    limits: ['Windows and WSL evidence is collected separately.',
      'Cross-host product upgrades use an explicit host pair and original Session evidence; forward-only evidence never proves rollback or host downgrade.',
      'Other host transitions are collected separately, not inferred from independent version runs.',
      'Missing managed-child/program-preparation evidence remains not-run, not waived.'],
    summary: { expected: 7, passed: targets.filter(row => row.passed).length,
      failed: targets.filter(row => row.status === 'failed').length,
      notRun: targets.filter(row => row.status === 'not-run').length } };
}
