import { assertRequiredEvidence } from './lib/browser-gates.mjs';
import { project, sha256 } from './lib/internal-candidate-utils.mjs';
import { join } from 'node:path';

const [mode, firstUse, searchLog] = process.argv.slice(2);
let groups;
if (mode === 'ui' && typeof firstUse === 'string' && process.argv.length === 4) groups = ['ui-gates'];
else if (mode === 'macos' && process.argv.length === 5 && ['true', 'false'].includes(firstUse) && ['true', 'false'].includes(searchLog)) {
  if (firstUse === 'true' && searchLog === 'true') throw new Error('Conflicting evidence selection.');
  groups = [];
  if (firstUse !== 'true') groups.push('macos-grok-protocol', 'host-execution-contracts');
  // --first-use + --diagnostics share a single diagnostics-desktop receipt.
  if (searchLog !== 'true') groups.push('b2-product-install', 'b2-plugin-manager-desktop', 'diagnostics-desktop');
  if (firstUse !== 'true') groups.push('search-log-desktop');
  if (firstUse !== 'true' && searchLog !== 'true') groups.push('b2-product-desktop', 'b2-m0-04-desktop', 'ux-lifecycle-desktop', 'internal-candidate-real');
} else throw new Error('Usage: node scripts/check-evidence.mjs ui <run-id> | macos <first-use-only> <search-log-only>');
console.log(JSON.stringify({ requiredEvidence: assertRequiredEvidence(join(project, 'artifacts'), groups,
  mode === 'ui' ? { clientSha256: sha256(join(project, 'src/client.js')), runId: firstUse } : {}) }));
