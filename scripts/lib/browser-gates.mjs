import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function summarizeChecks(rows, fatal = null) {
  const assertions = rows.filter(row => row.kind !== 'observation');
  const passed = assertions.filter(row => row.passed === true).length;
  const assertionFailures = assertions.filter(row => row.passed !== true).length;
  return { passed, failed: assertionFailures + (fatal && !assertionFailures ? 1 : 0),
    observations: rows.filter(row => row.kind === 'observation').length, fatal };
}

export function assertBrowserResult(value) {
  if (!value || !Number.isSafeInteger(value.passed) || value.passed < 1
    || value.failed !== 0 || hasFailure(value)) {
    throw new Error('Browser suite did not return a successful assertion receipt.');
  }
  return value;
}

// Test-only observer: a host can replace a pending tool row while attribution
// arrives. Follow its call identity instead of holding one transient DOM node.
export function followStreamingSearchCard(document, state) {
  for (const button of document.querySelectorAll(
    'button[data-turn-process][aria-expanded=false],button[data-process-activity][aria-expanded=false]',
  )) button.click();
  state.card = [...document.querySelectorAll('.dsg-chat')]
    .findLast(card => !state.initialCallIds.has(card.dataset.dsgSearchCard)) ?? null;
  if (!state.card) { state.open = false; return; }
  if (state.readingCallId !== state.card.dataset.dsgSearchCard) {
    // Programmatic scrolling alone is not reader intent in the official host.
    // A simulated wheel interaction hands off its follow-to-tail controller.
    state.card.dispatchEvent(new document.defaultView.WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    state.readingCallId = state.card.dataset.dsgSearchCard;
  }
  state.card.querySelector('.card-toggle[aria-expanded=false]')?.click();
  if (state.card.dataset.visible !== 'true') {
    state.card.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  state.open = Boolean(state.card.querySelector('.card-toggle[aria-expanded=true]'));
}

export async function stopPreviewService(service, { timeoutMs = 5000 } = {}) {
  if (service.exited) return;
  const wait = async () => {
    let timer;
    try {
      return await Promise.race([service.closed.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  };
  service.stopping = true;
  service.child.kill();
  if (await wait()) return;
  // Only the runner's own child is eligible, never a user browser or Desktop.
  service.child.kill('SIGKILL');
  if (!await wait()) throw new Error('Preview process did not exit during bounded cleanup.');
  throw new Error('Preview required forced cleanup instead of its normal shutdown.');
}

function hasFailure(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
  if (row.passed === false || row.failed > 0 || row.fatal || row.error
    || row.errors?.length || row.pageErrors?.length || row.external?.length
    || row.exitCode != null && row.exitCode !== 0 || row.forced === true
    || row.status != null && !['pass', 'ok', 'success', 'passed'].includes(row.status)
    || row.counts?.fail > 0 || row.counts?.harnessErrors > 0) return true;
  return ['results', 'suites', 'checks', 'tests'].some(key =>
    Array.isArray(row[key]) && row[key].some(hasFailure));
}

function affirmative(row) {
  if (row.passed === true || Number.isSafeInteger(row.passed) && row.passed > 0) return true;
  if (row.counts?.pass > 0 && (row.status === 'pass' || row.exitCode === 0)) return true;
  // The native stdio probe predates the normalized gate receipt. Its actual
  // protocol, tool result and normal process exit are all required.
  return Boolean(row.serverInfo?.name && row.protocolVersion && row.tools?.includes('web_search')
    && row.call?.name === 'web_search' && row.call.isError === false
    && row.process?.exitCode === 0 && row.process.gracefulStdioEof === true
    && row.process.forced === false);
}

export function assertRequiredEvidence(root, groups, { clientSha256, runId } = {}) {
  if (runId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(runId)) {
    throw new Error('Invalid evidence run identity.');
  }
  const visit = (directory, files) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, files);
      // CPU profiles and other *-summary diagnostics are observations, not
      // assertion receipts. Every selected gate writes one canonical receipt.
      else if (entry.isFile() && ['summary.json', 'receipt.json'].includes(entry.name)) files.push(path);
    }
  };
  return groups.map(group => {
    if (!/^[a-z0-9-]+$/.test(group)) throw new Error('Invalid evidence group.');
    const directory = join(root, group, ...(runId ? [runId] : [])), selected = [];
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (entry?.isDirectory() && !entry.isSymbolicLink()) visit(directory, selected);
    if (!selected.length) throw new Error(`Required evidence missing: ${group}`);
    for (const path of selected) {
      if (statSync(path).size > 16 * 1024 * 1024) throw new Error(`Evidence is too large: ${group}`);
      const row = JSON.parse(readFileSync(path, 'utf8'));
      if (hasFailure(row) || !affirmative(row)) {
        throw new Error(`Failed evidence: ${group}`);
      }
      if (group === 'ui-gates' && clientSha256 && row.clientSha256 !== clientSha256) {
        throw new Error(`Evidence identity mismatch: ${group}`);
      }
      if (group === 'ui-gates') {
        if (row.scope !== 'generated-client-offline-browser-fixtures' || typeof row.smoke !== 'boolean'
          || !Array.isArray(row.suites) || row.suites.length !== (row.smoke ? 2 : 6)) {
          throw new Error(`Incomplete browser evidence: ${group}`);
        }
        for (const suite of row.suites) assertBrowserResult(suite);
        if (row.assertionsPassed !== row.suites.reduce((sum, suite) => sum + suite.passed, 0)) {
          throw new Error(`Invalid browser assertion count: ${group}`);
        }
      }
      if (runId && row.runId !== runId) throw new Error(`Evidence run identity mismatch: ${group}`);
    }
    return { group, receipts: selected.length };
  });
}
