import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { assertBrowserResult, stopPreviewService } from './lib/browser-gates.mjs';
import { project, freshRun, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || args.length && args[0] !== '--smoke') throw new Error('Usage: node scripts/run-ui.mjs [--smoke]');
const smoke = args[0] === '--smoke';
const run = freshRun('ui-gates');
const clientSha256 = sha256(join(project, 'src/client.js'));
const services = [], suites = [];
let browser, fatal = null;
async function preview(script, pattern, extra = []) {
  const child = spawn(process.execPath, [script, ...extra], { cwd: project, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  const service = { child, exited: false };
  service.closed = new Promise(resolve => child.once('close', () => { service.exited = true; resolve(); }));
  services.push(service);
  let output = '';
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Preview readiness timeout: ${script}`)), 20_000);
    const fail = error => { clearTimeout(timer); service.error = String(error); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Preview exited before ready: ${script} (${code})`)));
    child.stderr.on('data', bytes => { output = (output + bytes).slice(-8000); });
    child.stdout.on('data', bytes => {
      output = (output + bytes).slice(-8000);
      const match = pattern.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return origin;
}
async function suite(file, origin, label = file) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const external = [];
  // All data stays local. The approved link-click test fulfills its own exact
  // GitHub URL with a fixture after this guard; no real navigation is needed.
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url === origin || !/^https?:/.test(url)) return route.continue();
    external.push(new URL(url).origin);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  const started = performance.now();
  let timer;
  try {
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.harness || window.__dsgChatReady));
    const execute = vm.runInNewContext(`(${readFileSync(join(project, file), 'utf8')})`,
      { console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Buffer, performance,
        AbortController, AbortSignal, TextEncoder, TextDecoder });
    const result = await Promise.race([execute(page),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Suite timeout: ${label}`)), 180_000); })]);
    assertBrowserResult(result);
    if (pageErrors.length) throw new Error('Browser runtime exception, including before suite setup.');
    if (external.length) throw new Error('Unexpected external browser request.');
    suites.push({ label, file, scriptSha256: sha256(join(project, file)), passed: result.passed, failed: 0,
      durationMs: Math.round(performance.now() - started), observations: result.observations ?? [],
      ...(result.runId ? { evidenceRunId: result.runId } : {}) });
    console.log(JSON.stringify({ suite: label, passed: result.passed, failed: 0 }));
  } catch (error) {
    suites.push({ label, file, passed: 0, failed: 1, error: String(error), external, pageErrors });
    await page.screenshot({ path: join(run.directory, `${suites.length}-failure.png`) }).catch(() => {});
    throw error;
  } finally { clearTimeout(timer); await context.close(); }
}
try {
  const settings = await preview('scripts/ui-route-preview.mjs', /"origin":"(http:\/\/127\.0\.0\.1:\d+)"/);
  const chat = await preview('scripts/chat-card-preview.mjs', /CHAT_CARD_PREVIEW=(http:\/\/127\.0\.0\.1:\d+)\/?/,
    [join(project, 'node_modules')]);
  browser = await chromium.launch({ headless: true });
  await suite('test/ui-smoke.js', settings, 'settings-smoke');
  await suite('test/ui-smoke.js', chat, 'chat-smoke');
  if (!smoke) {
    for (const file of ['test/ui-route-browser.js', 'test/ui-search-log-browser.js', 'test/ui-github-read-browser.js']) {
      await suite(file, settings);
    }
    await suite('test/ui-chat-regression.js', chat);
  }
} catch (error) { fatal = String(error); process.exitCode = 1; }
finally {
  try { await browser?.close(); } catch (error) { fatal ??= String(error); }
  for (const service of services) {
    if (!fatal && (service.exited || service.error)) fatal = service.error ?? 'Preview exited before the run completed.';
  }
  const cleanup = await Promise.allSettled(services.map(service => stopPreviewService(service)));
  for (const result of cleanup) if (result.status === 'rejected') fatal ??= String(result.reason);
  if (sha256(join(project, 'src/client.js')) !== clientSha256) fatal ??= 'Client changed during browser verification.';
  const summary = { runId: run.runId, scope: 'generated-client-offline-browser-fixtures', smoke,
    node: process.version, platform: process.platform, playwright: '1.64.1', clientSha256,
    passed: !fatal && suites.length === (smoke ? 2 : 6), fatal, suites,
    assertionsPassed: suites.reduce((count, row) => count + row.passed, 0),
    upstreamRequests: 0, desktopVerified: false };
  if (!summary.passed) process.exitCode = 1;
  writeJson(join(run.directory, 'summary.json'), summary);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${run.runId}\n`);
  console.log(JSON.stringify({ ...summary, suites: undefined, directory: run.directory }));
}
