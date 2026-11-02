import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createPrivateProgramInstaller, resolveGrokProgram } from '../src/core/program-install.mjs';
import { freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

const mirrorOnly = process.argv.includes('--mirror-only');
if (process.argv.slice(2).some(arg => arg !== '--mirror-only')) throw new Error('Usage: node scripts/program-install-probe.mjs [--mirror-only]');
const { runId, directory } = freshRun('program-install');
const files = ['src/core/program-discovery.mjs', 'src/core/program-install.mjs', 'src/core/mcp-search.mjs', 'scripts/program-install-probe.mjs'];
const sourceHashes = files.map(file => ({ file, sha256: sha256(join(project, file)) }));
const temporary = mkdtempSync(join(tmpdir(), 'dsh-private-program-'));
const events = [], requests = [];
const fetchImpl = async (url, options) => {
  requests.push(url);
  if (mirrorOnly && url.startsWith('https://registry.npmjs.org/')) throw new Error('Probe simulates official registry unavailable');
  return fetch(url, options);
};
const installer = createPrivateProgramInstaller({ directory: join(temporary, 'runtime-cache'), fetchImpl });
let result, cached, error;
try {
  result = await resolveGrokProgram({ installer, env: { PATH: '', HOME: temporary, USERPROFILE: temporary },
    onProgress: event => events.push(event) });
  cached = await installer.active();
  assert.equal(result.path, cached.path);
  assert.equal(result.sha256, cached.sha256);
  assert.equal(result.version, cached.version);
  assert.equal(result.source, 'private-cache');
} catch (caught) { error = { code: caught.code ?? null, message: caught.message }; }
const sourcesUnchanged = sourceHashes.every(row => sha256(join(project, row.file)) === row.sha256);
if (!sourcesUnchanged) error ??= { code: 'PROBE_SOURCE_CHANGED', message: 'Source changed during verification; this run is not current-source evidence.' };
const summary = { runId, status: error ? 'fail' : 'pass', error: error ?? null,
  scope: 'public-npm-platform-package-download-native-version-and-MCP-handshake-in-new-temporary-private-cache',
  mirrorOnly, platform: process.platform, arch: process.arch, events, requests,
  program: result ? { version: result.version, sha256: result.sha256, source: result.source } : null,
  cacheReadBack: Boolean(cached), mcpHandshakeValidated: !error && Boolean(result), hostIntegrated: false,
  globalInstallationChanged: false, realConfigOrCredentialsUsed: false,
  sourceHashes, sourcesUnchanged };
writeJson(join(directory, 'summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = error ? 1 : 0;
