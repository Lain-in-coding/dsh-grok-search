import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

const [baseline] = process.argv.slice(2);
assert.match(baseline ?? '', /^[a-f0-9]{7,40}$/);
const variants = {
  baseline: execFileSync('git', ['show', `${baseline}:src/client.js`], { cwd: project, maxBuffer: 4 * 1024 * 1024 }),
  optimized: readFileSync(join(project, 'src/client.js')),
};
const fixture = readFileSync(join(project, 'fixtures/ui-route-harness.mjs'), 'utf8');
const html = readFileSync(join(project, 'fixtures/ui-route-harness.html'), 'utf8');
const run = freshRun('client-resources');
const results = [];
let browser, fatal = null;
const server = createServer((request, response) => {
  if (request.headers.host !== `127.0.0.1:${server.address().port}` || request.method !== 'GET') {
    response.writeHead(403); response.end(); return;
  }
  const url = new URL(request.url, 'http://localhost');
  const [, label, type] = url.pathname.split('/');
  if (!Object.hasOwn(variants, label)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Cache-Control', 'no-store');
  const fallback = url.searchParams.has('fallback');
  if (!type) {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html.replace('/fixtures/ui-route-harness.mjs', `/${label}/fixture.mjs${fallback ? '?fallback=1' : ''}`));
  } else if (type === 'fixture.mjs') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.end(fixture.replace('/src/client.js', `/${label}/client.js${fallback ? '?fallback=1' : ''}`));
  } else if (type === 'client.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(variants[label]);
  } else { response.writeHead(404); response.end(); }
});
const sample = () => new Promise((resolve, reject) => {
  const fixture = window.harness;
  fixture.unmount();
  const start = performance.now();
  let frames = 0;
  fixture.mount();
  const wait = () => {
    frames++;
    const root = document.querySelector('[data-dsg-route]')?.shadowRoot;
    if (root?.querySelector('#routeCard')?.dataset.s !== 'load' && root?.querySelector('#wires path')?.getAttribute('d')) {
      const layer = document.querySelector('[data-dsg-layer]')?.shadowRoot;
      resolve({ readyMs: performance.now() - start, frames,
        mainSheets: root.adoptedStyleSheets.length, layerSheets: layer.adoptedStyleSheets.length,
        shared: root.adoptedStyleSheets.length > 0 && root.adoptedStyleSheets[0] === layer.adoptedStyleSheets[0],
        styleBytes: [...root.querySelectorAll('style'), ...layer.querySelectorAll('style')]
          .reduce((count, element) => count + element.textContent.length, 0) });
    } else if (performance.now() - start > 10000) reject(new Error('Mount did not settle'));
    else requestAnimationFrame(wait);
  };
  requestAnimationFrame(wait);
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const label of ['baseline', 'optimized']) {
    for (const dpr of [1, 2]) for (const theme of ['light', 'dark']) for (const zoom of [1, 2]) {
      const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1440, height: 1000 } });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/')
        ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const trials = [];
      try {
        for (let index = 0; index < 5; index++) {
          await page.goto(`${origin}/${label}/`);
          await page.waitForFunction(() => Boolean(window.harness));
          await page.evaluate(({ theme, zoom }) => {
            window.harness.theme(theme); document.body.style.zoom = String(zoom);
          }, { theme, zoom });
          const cdp = await context.newCDPSession(page);
          await cdp.send('Performance.enable');
          const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
            .filter(row => ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'JSHeapUsedSize'].includes(row.name))
            .map(row => [row.name, row.value]));
          const before = await metrics();
          const cold = await page.evaluate(sample);
          const after = await metrics();
          const warm = await page.evaluate(sample);
          trials.push({ index, cold, warm, metrics: Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]])) });
          await cdp.detach();
        }
        const geometry = await page.evaluate(() => {
          const root = document.querySelector('[data-dsg-route]').shadowRoot;
          return ['#routeCard', '#stage', '#nodeDsh', '#nodeHub', '#colList'].map(selector => {
            const element = root.querySelector(selector), box = element.getBoundingClientRect(), style = getComputedStyle(element);
            return { selector, width: box.width, height: box.height, color: style.color, background: style.backgroundColor };
          });
        });
        await page.screenshot({ path: join(run.directory, `${label}-${theme}-dpr${dpr}-zoom${zoom}.png`), fullPage: true });
        assert.deepEqual(errors, []);
        results.push({ label, dpr, theme, zoom, trials, geometry });
      } finally { await context.close(); }
    }
  }
  for (const row of results.filter(row => row.label === 'optimized')) {
    const previous = results.find(other => other.label === 'baseline' && other.dpr === row.dpr && other.theme === row.theme && other.zoom === row.zoom);
    assert.deepEqual(row.geometry, previous.geometry, 'resource optimization cannot change approved layout or colors');
    assert.ok(row.trials.every(trial => trial.cold.shared && trial.warm.shared));
  }
  const fallbackContext = await browser.newContext();
  const fallbackPage = await fallbackContext.newPage();
  await fallbackPage.addInitScript(() => {
    Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { value() { throw new Error('forced compatibility path'); } });
  });
  await fallbackPage.goto(`${origin}/optimized/?fallback=1`);
  await fallbackPage.waitForFunction(() => Boolean(window.harness));
  const fallback = await fallbackPage.evaluate(sample);
  assert.equal(fallback.shared, false);
  assert.ok(fallback.styleBytes > 0);
  results.push({ label: 'compatibility-fallback', ...fallback });
  await fallbackContext.close();
} catch (error) { fatal = String(error); process.exitCode = 1; }
finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const comparisons = results.filter(row => row.label === 'optimized').map(row => {
    const before = results.find(item => item.label === 'baseline' && item.theme === row.theme && item.dpr === row.dpr && item.zoom === row.zoom);
    return { theme: row.theme, dpr: row.dpr, zoom: row.zoom,
      beforeReadyMedianMs: median(before.trials.map(trial => trial.cold.readyMs)),
      afterReadyMedianMs: median(row.trials.map(trial => trial.cold.readyMs)),
      beforeWarmMedianMs: median(before.trials.map(trial => trial.warm.readyMs)),
      afterWarmMedianMs: median(row.trials.map(trial => trial.warm.readyMs)) };
  });
  const summary = { runId: run.runId, scope: 'same-browser-generated-client-synthetic-settings-resource-comparison',
    baselineCommit: baseline, passed: !fatal, fatal,
    variants: Object.fromEntries(Object.entries(variants).map(([name, value]) => [name, { bytes: value.length, sha256: digest(value) }])),
    masterSha256: sha256(join(project, 'src/assets/logos/deepseek-harness.png')),
    comparisons, results, desktopVerified: false, upstreamRequests: 0 };
  writeJson(join(run.directory, 'summary.json'), summary);
  console.log(JSON.stringify({ ...summary, results: undefined, directory: run.directory }));
}
