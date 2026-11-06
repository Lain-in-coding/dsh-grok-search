import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { commandResult, freshRun, npmCli, project, receipt, sha256, writeJson, redact } from './lib/internal-candidate-utils.mjs';

const run = freshRun('search-log-integration');
const files = folder => readdirSync(join(project, folder), { withFileTypes: true }).flatMap(item =>
  item.isDirectory() ? files(`${folder}/${item.name}`) : [`${folder}/${item.name}`]);
const inputFiles = [...files('src'), ...files('test'), ...files('fixtures'),
  'package.json', 'README.md', 'scripts/build-client.mjs', 'scripts/ui-route-preview.mjs',
  'scripts/verify-search-log.mjs'];
const hashes = () => inputFiles.map(file => ({ file, sha256: sha256(join(project, file)) }));
const sourceHashes = hashes();
const execution = await commandResult(process.execPath, [npmCli, 'run', 'test:all'], {
  cwd: project, timeoutMs: 600_000, sanitize: value => redact(value),
});
writeJson(join(run.directory, 'offline-execution.json'), receipt(execution));
const unchanged = JSON.stringify(sourceHashes) === JSON.stringify(hashes());
writeJson(join(run.directory, 'summary.json'), {
  runId: run.runId, exitCode: execution.exitCode, timedOut: execution.timedOut,
  passed: execution.exitCode === 0 && !execution.timedOut && unchanged,
  sourceUnchanged: unchanged, sourceHashes, scope: 'all-offline-gates',
  realPaidProvidersVerified: false, desktopVerified: false, published: false,
});
console.log(JSON.stringify({ ...run, exitCode: execution.exitCode, unchanged }));
process.exitCode = execution.exitCode === 0 && unchanged && !execution.timedOut ? 0 : 1;
