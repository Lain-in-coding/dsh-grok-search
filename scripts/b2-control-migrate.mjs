import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';

// This is an explicit verification command, not a production startup/migration hook.
export function resolveTemporaryMigrationProfile(profile) {
  if (typeof profile !== 'string' || !isAbsolute(profile)) throw new Error('An absolute temporary profile is required.');
  const temporary = realpathSync(tmpdir()), target = resolve(profile);
  const inside = relative(temporary, target);
  const parts = inside.split(sep);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)
    || !parts[0].startsWith('dsh-b2-migration-') && !parts[0].startsWith('dsh-deferred-desktop-')
    || parts.slice(-3, -1).join('/') !== 'dsh-home/profiles' || !parts.at(-1)) {
    throw new Error('Migration command is restricted to dedicated temporary DSH_HOME profiles.');
  }
  let cursor = temporary;
  for (const part of parts) {
    cursor = join(cursor, part);
    const entry = lstatSync(cursor, { throwIfNoEntry: false });
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Temporary profile must be an existing ordinary directory without links.');
  }
  return target;
}
export function runLegacyMigration({ profile, mode, expectedRevision, expectedLegacySha256, operationId }) {
  const folder = resolveTemporaryMigrationProfile(profile);
  const legacyPath = join(folder, 'control-intent.fixture.json');
  const store = createControlIntentStore({ directory: join(folder, 'control-intent.records'),
    legacyPath, trustedRoot: folder });
  if (mode === 'inspect') {
    if (expectedRevision !== undefined || expectedLegacySha256 !== undefined || operationId !== undefined) {
      throw new Error('Inspection is read-only and does not accept migration approval parameters.');
    }
    const source = store.inspectLegacy();
    return { mode, sourceSha256: source.sha256, sourceByteLength: source.byteLength,
      legacySchemaVersion: source.intent.schemaVersion, legacyPolicy: source.intent.policy,
      authorizationEstablished: false, routeChanged: false, recordCommitted: false };
  }
  if (mode !== 'migrate') throw new Error('Expected explicit --mode inspect or migrate.');
  const result = store.migrateLegacy({ expectedRevision, expectedLegacySha256, operationId });
  // Verify both retained source and committed origin, not merely the function return.
  const source = store.inspectLegacy(), current = store.read();
  if (source.sha256 !== expectedLegacySha256 || current.revision !== result.envelope.revision
    || !existsSync(legacyPath) || current.intent.migration.sourceSha256 !== source.sha256
    || Buffer.from(current.intent.migration.sourceBase64, 'base64').compare(readFileSync(legacyPath)) !== 0) {
    throw new Error('Migration verification failed; do not report completion.');
  }
  return { mode, kind: result.kind, recordCommitted: result.recordCommitted,
    migrationCommitted: result.migrationCommitted, routeChanged: false, authorizationEstablished: false,
    sourceSha256: source.sha256, sourceByteLength: source.byteLength, originRevision: result.originRevision,
    currentRevision: current.revision, operationId: current.intent.migration.operationId,
    resolution: result.resolution ?? null, legacyRetained: true, productIntegrated: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const named = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index], value = process.argv[index + 1];
      if (!['--profile','--mode','--expected-revision','--expected-sha256','--operation-id'].includes(flag)
        || value === undefined || named.has(flag)) throw new Error('Expected unique named migration arguments.');
      named.set(flag,value);
    }
    const revision = named.has('--expected-revision') ? Number(named.get('--expected-revision')) : undefined;
    if (named.has('--expected-revision') && !/^0$/.test(named.get('--expected-revision'))) throw new Error('Initial migration requires --expected-revision 0.');
    console.log(JSON.stringify(runLegacyMigration({ profile:named.get('--profile'),mode:named.get('--mode'),
      expectedRevision:revision,expectedLegacySha256:named.get('--expected-sha256'),operationId:named.get('--operation-id') }),null,2));
  } catch(error) {
    console.error(JSON.stringify({status:'incomplete',code:error.code??'CONTROL_MIGRATION_ARGUMENT_INVALID',message:error.message,
      migrationOutcome:error.migrationOutcome??null,routeChanged:false,authorizationEstablished:false}));
    process.exitCode=1;
  }
}
