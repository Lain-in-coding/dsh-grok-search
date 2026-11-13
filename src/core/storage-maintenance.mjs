import { randomUUID, createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createControlIntentStore } from './control-intent-store.mjs';
import { acquireOwnedLock, DEFAULT_STALE_LOCK_MS } from './owned-lock.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => lstatSync(path, { throwIfNoEntry: false });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const regularDirectory = path => {
  const entry = exists(path);
  if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) fail('CONTROL_STORAGE_PATH_UNSAFE', 'Expected an existing ordinary local directory.');
};
const readJson = path => {
  const entry = exists(path);
  if (!entry?.isFile() || entry.isSymbolicLink() || entry.size > 4 * 1024 * 1024) {
    fail('CONTROL_STORAGE_RECEIPT_INVALID', 'Storage receipt must be a bounded regular file.');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
};
const writeReceipt = (path, value) => {
  const stage = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(stage, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(stage, path);
};
function assertOffline(record) {
  const pid = record?.intent?.lease?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    fail('CONTROL_HOST_STATE_UNKNOWN', 'Cannot prove that the recorded host process exited. Keep DSH closed and check the process.');
  }
  fail('CONTROL_HOST_STILL_RUNNING', 'The recorded host process still exists. Exit DSH before converting storage.');
}
function pathsFor(profile) {
  if (typeof profile !== 'string' || !isAbsolute(profile) || /^\\\\|^\/\//.test(profile)) {
    fail('CONTROL_STORAGE_PATH_UNSAFE', 'An absolute local DSH profile directory is required.');
  }
  regularDirectory(resolve(profile));
  // macOS /var and /tmp are system aliases. Resolve above the explicitly
  // named ordinary profile; all subsequent moves stay in that physical root.
  const root = realpathSync.native(resolve(profile));
  const directory = join(root, 'control-intent.records');
  return { root, directory, legacyPath: join(root, 'control-intent.fixture.json'),
    transition: directory + '.transition.json' };
}
export function runStorageMaintenance({
  profile, mode, expectedRevision, preparedDirectory, offline = false, fault = () => {},
} = {}) {
  const paths = pathsFor(profile);
  const store = () => createControlIntentStore({ directory: paths.directory,
    legacyPath: paths.legacyPath, trustedRoot: paths.root });
  if (mode === 'inspect') {
    if (exists(paths.transition)) return { status: 'downgrade-interrupted', action: 'recover-downgrade', mutation: false };
    const current = store().read();
    return { mode, revision: current?.revision ?? 0, policy: current?.intent.policy ?? null,
      storage: store().inspectStorage(), mutation: false };
  }
  if (!['maintain', 'prepare-downgrade', 'activate-downgrade', 'recover-downgrade'].includes(mode)) {
    fail('CONTROL_STORAGE_ARGUMENT', 'Expected inspect, maintain, prepare-downgrade, activate-downgrade or recover-downgrade.');
  }
  if (!offline) fail('CONTROL_OFFLINE_REQUIRED', 'Close DSH and pass --offline true for storage changes.');
  const lock = acquireOwnedLock(join(paths.root, '.dsh-grok-search-storage.lock'), {
    reclaimStaleAfterMs: DEFAULT_STALE_LOCK_MS,
  });
  try {
    if (mode === 'recover-downgrade') return recover(paths, fault);
    if (exists(paths.transition)) fail('CONTROL_STORAGE_TRANSITION', 'Recover the interrupted downgrade before another storage change.');
    const instance = store(), current = instance.read();
    if (!current || !Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      fail('CONTROL_CAS_CONFLICT', 'Inspect storage first, then pass its current --expected-revision.');
    }
    assertOffline(current);
    if (mode === 'maintain') return instance.maintain({ expectedRevision, force: true });
    if (mode === 'prepare-downgrade') {
      const target = join(paths.root, 'control-intent.compatible-' + randomUUID());
      const result = instance.exportCompatibleHistory({ targetDirectory: target });
      return { mode, ...result, next: 'activate-downgrade; then install the older plugin while DSH remains closed' };
    }
    const prepared = resolve(preparedDirectory ?? '');
    if (dirname(prepared) !== paths.root || !/^control-intent\.compatible-[0-9a-f-]{36}$/.test(basename(prepared))) {
      fail('CONTROL_STORAGE_PATH_UNSAFE', 'Use the prepared sibling directory returned by prepare-downgrade.');
    }
    regularDirectory(prepared);
    const receipt = readJson(join(prepared, 'conversion.json'));
    const compatible = createControlIntentStore({ directory: prepared, legacyPath: paths.legacyPath }).read();
    if (receipt.format !== 'dsh-grok-search/control-downgrade' || receipt.sourceRevision !== current.revision
      || receipt.sourceOperationId !== current.operationId || receipt.sourceSha256 !== instance.inspectStorage().headSha256 || !compatible
      || !isDeepStrictEqual(compatible.intent, current.intent)
      || compatible.operationId !== current.operationId
      || sha256(readFileSync(join(prepared, `v${String(compatible.revision).padStart(12, '0')}.json`))) !== receipt.exportedSha256) {
      fail('CONTROL_EXPORT_SOURCE_CHANGED', 'Prepared downgrade no longer matches the active control state.');
    }
    const retainedName = 'control-intent.retained-' + randomUUID();
    writeReceipt(paths.transition, { schemaVersion: 1, kind: 'control-downgrade',
      preparedName: basename(prepared), retainedName, exportedSha256: receipt.exportedSha256,
      exportedRevision: compatible.revision, sourceRevision: current.revision,
      sourceOperationId: current.operationId, sourcePolicy: current.intent.policy,
      sourceSha256: receipt.sourceSha256 });
    fault('before-source-move');
    renameSync(paths.directory, join(paths.root, retainedName));
    fault('after-source-move');
    renameSync(prepared, paths.directory);
    fault('after-target-move');
    return recover(paths, fault);
  } finally { lock.release(); }
}
function recover(paths, fault) {
  const receipt = readJson(paths.transition);
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'control-downgrade'
    || !/^control-intent\.compatible-[0-9a-f-]{36}$/.test(receipt.preparedName ?? '')
    || !/^control-intent\.retained-[0-9a-f-]{36}$/.test(receipt.retainedName ?? '')
    || !/^[a-f0-9]{64}$/.test(receipt.exportedSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(receipt.sourceSha256 ?? '')
    || !Number.isSafeInteger(receipt.sourceRevision) || receipt.sourceRevision < 1
    || !Number.isSafeInteger(receipt.exportedRevision) || receipt.exportedRevision < 1) {
    fail('CONTROL_STORAGE_RECEIPT_INVALID', 'Interrupted downgrade receipt is invalid; no directory was changed.');
  }
  const retained = join(paths.root, receipt.retainedName), prepared = join(paths.root, receipt.preparedName);
  if (!exists(retained)) {
    regularDirectory(paths.directory);
    regularDirectory(prepared);
    const sourceStore = createControlIntentStore({ directory: paths.directory, legacyPath: paths.legacyPath,
      allowOfflineTransition: true });
    const source = sourceStore.read();
    assertOffline(source);
    if (source?.revision !== receipt.sourceRevision || source?.operationId !== receipt.sourceOperationId
      || sourceStore.inspectStorage().headSha256 !== receipt.sourceSha256) {
      fail('CONTROL_EXPORT_SOURCE_CHANGED', 'Original source changed before downgrade recovery.');
    }
    renameSync(paths.directory, retained);
  }
  regularDirectory(retained);
  const retainedStore = createControlIntentStore({ directory: retained, legacyPath: paths.legacyPath });
  const old = retainedStore.read();
  assertOffline(old);
  if (old?.revision !== receipt.sourceRevision || old?.operationId !== receipt.sourceOperationId
    || retainedStore.inspectStorage().headSha256 !== receipt.sourceSha256) {
    fail('CONTROL_EXPORT_SOURCE_CHANGED', 'Retained source changed during downgrade.');
  }
  if (!exists(paths.directory)) {
    regularDirectory(prepared);
    const candidate = createControlIntentStore({ directory: prepared, legacyPath: paths.legacyPath }).read();
    if (!candidate || !isDeepStrictEqual(candidate.intent, old.intent) || candidate.operationId !== old.operationId
      || sha256(readFileSync(join(prepared, `v${String(receipt.exportedRevision).padStart(12, '0')}.json`))) !== receipt.exportedSha256) {
      fail('CONTROL_EXPORT_SOURCE_CHANGED', 'Prepared downgrade state does not match retained source.');
    }
    renameSync(prepared, paths.directory);
  }
  regularDirectory(paths.directory);
  const path = join(paths.directory, `v${String(receipt.exportedRevision).padStart(12, '0')}.json`);
  if (sha256(readFileSync(path)) !== receipt.exportedSha256) {
    fail('CONTROL_STORAGE_RECEIPT_INVALID', 'Activated downgrade failed fingerprint verification.');
  }
  const result = createControlIntentStore({ directory: paths.directory, legacyPath: paths.legacyPath,
    allowOfflineTransition: true }).read();
  if (!isDeepStrictEqual(result.intent, old.intent) || result.operationId !== old.operationId) {
    fail('CONTROL_EXPORT_SOURCE_CHANGED', 'Downgrade state verification failed.');
  }
  fault('before-transition-complete');
  unlinkSync(paths.transition);
  return { status: 'downgraded', revision: result.revision, originalRevision: old.revision,
    policy: result.intent.policy, retainedDirectory: retained, configurationChanged: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const fields = { '--profile': 'profile', '--mode': 'mode', '--expected-revision': 'expectedRevision',
      '--prepared-directory': 'preparedDirectory', '--offline': 'offline' };
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = fields[process.argv[index]], value = process.argv[index + 1];
      if (!key || value === undefined || Object.hasOwn(options, key)) fail('CONTROL_STORAGE_ARGUMENT', 'Expected unique named storage arguments.');
      options[key] = key === 'expectedRevision' ? Number(value) : key === 'offline' ? value === 'true' : value;
    }
    console.log(JSON.stringify(runStorageMaintenance(options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'incomplete', code: error.code ?? 'CONTROL_STORAGE_FAILED', message: error.message }));
    process.exitCode = 1;
  }
}
