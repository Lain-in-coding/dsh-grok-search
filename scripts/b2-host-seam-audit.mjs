import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { freshRun, project, redact, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  if (!['--desktop-rc2', '--desktop-rc21'].includes(name) || !process.argv[index + 1] || options.has(name)) {
    throw new Error('Expected unique --desktop-rc2 and --desktop-rc21 paths.');
  }
  options.set(name, process.argv[index + 1]);
}
const runtimes = [candidateRuntime(options.get('--desktop-rc2')), candidateRuntime(options.get('--desktop-rc21'))];
assert.deepEqual(runtimes.map(runtime => runtime.app.version), ['0.2.0-rc.2', '0.2.1-rc.2']);

const { runId, directory } = freshRun('b2-host-seam-audit');
const replacements = runtimes.map(runtime => [dirname(runtime.executable), `<DESKTOP_${runtime.app.version}>`]);
const sanitize = value => redact(String(value), replacements);

const sourceFiles = [
  ['web-runtime', 'dsh/node_modules/@deepseek-ai/dsh-web/lib/index.js'],
  ['web-search-deepseek', 'dsh/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js'],
  ['web-tool', 'dsh/node_modules/@deepseek-ai/dsh-tool-web/lib/index.js'],
  ['session', 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'],
  ['plugin-manager', 'dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js'],
  ['cordis-loader', 'dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js'],
  ['cordis', 'dsh/node_modules/@deepseek-ai/cordis/lib/index.js'],
  ['app-boot', 'dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'],
];

const counterPatterns = [
  ['canonical-session-event', /web\/deepseek-search-llm-request/],
  ['grokSearchOriginalSearchCounter', /grokSearchOriginalSearchCounter/],
  ['originalSearchCalls', /originalSearchCalls/],
  ['searchCallCount', /searchCallCount/],
  ['searchCounter', /searchCounter/],
  ['searchCalls', /searchCalls/],
  ['webSearchCallCount', /webSearchCallCount/],
  ['webSearchCalls', /webSearchCalls/],
];
const weakCounterPatterns = [
  ['callCount', /\bcallCount\b/],
  ['invocationCount', /\binvocationCount\b/],
  ['toolCallCount', /\btoolCallCount\b/],
];
const releasePatterns = [
  ['releaseCompletion', /releaseCompletion/],
  ['releaseReceipt', /releaseReceipt/],
  ['releaseBeforeCommit', /releaseBeforeCommit/],
  ['release-before-commit', /release-before-commit/],
  ['completionReceipt', /completionReceipt/],
  ['hostRelease', /hostRelease/],
  ['releaseApplied', /releaseApplied/],
  ['releaseComplete', /releaseComplete/],
  ['releaseTransaction', /releaseTransaction/],
];

function matchingLines(source, patterns) {
  const lines = source.split(/\r?\n/);
  const hits = [];
  for (const [id, pattern] of patterns) {
    for (let index = 0; index < lines.length; index += 1) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[index])) hits.push({ id, line: index + 1, text: lines[index].trim().slice(0, 240) });
    }
  }
  return hits;
}

function snippets(source, pattern, radius = 2, limit = 3) {
  const lines = source.split(/\r?\n/);
  const result = [];
  for (let index = 0; index < lines.length && result.length < limit; index += 1) {
    pattern.lastIndex = 0;
    if (!pattern.test(lines[index])) continue;
    const start = Math.max(0, index - radius);
    const end = Math.min(lines.length, index + radius + 1);
    result.push({ line: index + 1, text: lines.slice(start, end).join('\n') });
  }
  return result;
}

function providedServices(source) {
  const names = new Set();
  for (const match of source.matchAll(/\.provide\(\s*["']([^"']+)["']/g)) names.add(match[1]);
  return [...names].sort();
}

function canonicalSearchCounterContract(modules) {
  const provider = modules.find(module => module.role === 'web-search-deepseek');
  const session = modules.find(module => module.role === 'session');
  const declared = module => module?.counterHits.some(hit => hit.id === 'canonical-session-event') === true;
  return declared(provider) && declared(session);
}

const audits = runtimes.map(runtime => {
  const modules = sourceFiles.map(([role, file]) => {
    const text = runtime.archive.read(file).toString('utf8');
    const counterHits = matchingLines(text, counterPatterns);
    const weakCounterHits = matchingLines(text, weakCounterPatterns);
    const releaseHits = matchingLines(text, releasePatterns);
    return {
      role,
      file,
      sha256: runtime.archive.sha256(file),
      bytes: Buffer.byteLength(text),
      lines: text.split(/\r?\n/).length,
      providedServices: providedServices(text),
      counterHits,
      weakCounterHits,
      releaseHits,
      searchMethod: role === 'web-runtime' ? snippets(text, /async search\s*\(/) : [],
      toolExecute: role === 'web-tool' ? snippets(text, /async execute\s*\(/) : [],
      setBundleEnabled: role === 'plugin-manager' ? snippets(text, /setBundleEnabled\s*\(/) : [],
    };
  });
  const counterHits = modules.flatMap(module => module.counterHits.map(hit => ({ module: module.file, ...hit })));
  const weakCounterHits = modules.flatMap(module => module.weakCounterHits.map(hit => ({ module: module.file, ...hit })));
  const releaseHits = modules.flatMap(module => module.releaseHits.map(hit => ({ module: module.file, ...hit })));
  return {
    version: runtime.app.version,
    executable: `<DESKTOP_${runtime.app.version}>`,
    archiveSha256: sha256(runtime.archivePath),
    modules,
    counterContractFound: canonicalSearchCounterContract(modules),
    weakCounterSignalsFound: weakCounterHits.length > 0,
    releaseCompletionContractFound: releaseHits.length > 0,
    counterHits,
    weakCounterHits,
    releaseHits,
  };
});

const counterContractFound = audits.every(audit => audit.counterContractFound);
const releaseCompletionContractFound = audits.every(audit => audit.releaseCompletionContractFound);
const status = counterContractFound && releaseCompletionContractFound ? 'found'
  : counterContractFound || releaseCompletionContractFound ? 'partial' : 'not-found';
const summary = {
  runId,
  status,
  scope: 'read-only-official-asar-public-source-audit',
  generatedAt: new Date().toISOString(),
  command: {
    executable: sanitize(process.execPath),
    args: process.argv.map(sanitize),
    cwd: sanitize(project),
  },
  findings: {
    originalSearchCounter: {
      found: counterContractFound,
      decision: counterContractFound ? 'canonical-session-event-adapter' : 'fail-closed-no-official-seam',
      note: counterContractFound
        ? 'Both official providers append web/deepseek-search-llm-request to the canonical Session before dispatch.'
        : 'No official counter or equivalent call-fact service was found in the audited modules.',
    },
    releaseCompletionReceipt: {
      found: releaseCompletionContractFound,
      decision: releaseCompletionContractFound ? 'adapter-candidate' : 'upstream-or-explicit-limitation',
      note: releaseCompletionContractFound ? 'Official source contains a candidate release receipt contract; inspect before adapting.'
        : 'No awaitable host-level release completion receipt was found in the audited modules.',
    },
  },
  contractLayering: {
    m0GateCounter: 'fixture-counter-accepted-by-Plan',
    productionCounter: counterContractFound ? 'candidate-found' : 'not-available-without-upstream-or-host-change',
    hostReleaseReceipt: releaseCompletionContractFound ? 'candidate-found' : 'not-available-without-upstream-or-host-change',
    recordCommitIsNotRouteChange: true,
    routeVerificationIsNotHostReleaseReceipt: true,
  },
  decision: {
    stopB2CodeAdvance: !counterContractFound || !releaseCompletionContractFound,
    productIntegrated: false,
    nextDefault: releaseCompletionContractFound ? 'continue-beta-review' : 'upstream-release-completion-receipt',
    upstreamProposal: 'prepare-not-send',
  },
  boundaries: {
    originalSearchCounter: counterContractFound
      ? 'The Session event records an official-provider dispatch attempt before fetch; it does not prove network success.'
      : 'No trusted original-search count contract was found.',
    releaseCompletionReceipt: releaseCompletionContractFound
      ? 'A candidate release-completion contract was found and still requires semantic verification.'
      : 'Generic config reload completion and PluginManager applied outcomes are not release-completion receipts.',
  },
  audits,
};

writeJson(join(directory, 'summary.json'), summary);
writeJson(join(directory, 'command.json'), summary.command);
console.log(JSON.stringify({
  runId,
  status,
  counterContractFound,
  releaseCompletionContractFound,
  stopB2CodeAdvance: summary.decision.stopB2CodeAdvance,
  summary: sanitize(join(directory, 'summary.json')),
}, null, 2));
