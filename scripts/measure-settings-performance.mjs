// Local, read-only diagnostics. Does not retain RPC payloads, credentials,
// search text, URLs, console output or raw CPU profiles in the evidence.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { connectRenderer, waitForRenderer } from './lib/renderer-cdp.mjs';
import { freshRun, sha256, project, writeJson } from './lib/internal-candidate-utils.mjs';

const args = process.argv.slice(2);
const port = Number(args[0]), label = args[1], tarball = args[2] ? resolve(args[2]) : null;
const expectedHistoryCount = args[3] === undefined ? null : Number(args[3]);
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
assert.ok(/^[a-z0-9-]{1,48}$/.test(label ?? ''));
assert.ok(args.length >= 2 && args.length <= 4);
assert.ok(expectedHistoryCount === null || Number.isSafeInteger(expectedHistoryCount)
  && expectedHistoryCount >= 0 && expectedHistoryCount <= 20);
const receipt = tarball ? JSON.parse(readFileSync(join(dirname(tarball), 'package-receipt.json'), 'utf8')) : null;
if (receipt) assert.equal(sha256(tarball), receipt.sha256);
const { runId, directory } = freshRun('settings-performance');
const renderer = await connectRenderer(port, { requestTimeoutMs: 45_000 });
const call = fn => renderer.evaluate(`(${fn})()`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const metricNames = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
  'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'Nodes', 'JSEventListeners', 'LayoutObjects'];
const metrics = async () => Object.fromEntries((await renderer.send('Performance.getMetrics')).metrics
  .filter(row => metricNames.includes(row.name)).map(row => [row.name, row.value]));
const start = () => {
  const button = [...document.querySelectorAll('button')]
    .find(item => item.getAttribute('aria-label') === '查看 dsh-grok-search');
  if (!button) throw new Error('Open the native plugin list before measuring.');
  const state = { start: performance.now(), frames: [], longTasks: [], mounts: 0, rowAdds: 0,
    rowRemoves: 0, mutations: 0, attributeMutations: 0, rpc: [], stopped: false,
    readyAt: null, logsReadyAt: null, expectedHistoryCount: window.__dsgExpectedHistoryCount };
  delete window.__dsgExpectedHistoryCount;
  window.__dsgPerformanceProbe = state;
  let previous = state.start, observed = null;
  const inspect = now => {
    if (state.stopped) return;
    state.frames.push(now - previous); previous = now;
    const shadow = document.querySelector('[data-dsg-route]')?.shadowRoot;
    if (shadow && shadow !== observed) {
      state.mounts++; observed = shadow;
      state.mutationsObserver?.disconnect();
      state.mutationsObserver = new MutationObserver(records => {
        state.mutations += records.length;
        state.attributeMutations += records.filter(record => record.type === 'attributes').length;
        for (const record of records) if (record.type === 'childList') {
          for (const node of record.addedNodes) if (node.nodeType === 1) {
            state.rowAdds += Number(node.matches?.('.row')) + (node.querySelectorAll?.('.row').length ?? 0);
          }
          for (const node of record.removedNodes) if (node.nodeType === 1) {
            state.rowRemoves += Number(node.matches?.('.row')) + (node.querySelectorAll?.('.row').length ?? 0);
          }
        }
      });
      state.mutationsObserver.observe(shadow, { subtree: true, attributes: true, childList: true });
    }
    if (state.readyAt === null && shadow?.querySelector('#statusPill')?.dataset.s !== 'load'
      && shadow?.querySelectorAll('#colList .row').length === 6
      && shadow.querySelector('#wires path')?.getAttribute('d')) state.readyAt = performance.now() - state.start;
    if (state.logsReadyAt === null && state.expectedHistoryCount !== null && shadow?.querySelector('#logList')
      && shadow.querySelectorAll('#logList .log-entry').length === state.expectedHistoryCount)
      state.logsReadyAt = performance.now() - state.start;
    state.frame = requestAnimationFrame(inspect);
  };
  state.longTaskObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.longTasks.push({ at: entry.startTime - state.start, ms: entry.duration });
  });
  state.longTaskObserver.observe({ type: 'longtask' });
  state.resourceObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const match = /\/api\/grokSearchSettings\/([A-Za-z]+)(?:[/?#]|$)/.exec(entry.name);
      if (match) state.rpc.push({ method: match[1], ms: entry.duration });
    }
  });
  state.resourceObserver.observe({ type: 'resource' });
  state.frame = requestAnimationFrame(inspect);
  button.click();
  return true;
};
const stop = () => {
  const state = window.__dsgPerformanceProbe;
  state.stopped = true;
  cancelAnimationFrame(state.frame);
  state.longTaskObserver.disconnect();
  state.resourceObserver.disconnect();
  state.mutationsObserver?.disconnect();
  const frames = state.frames.slice(1).sort((a, b) => a - b);
  const value = { readyMs: state.readyAt, logsReadyMs: state.logsReadyAt, observedMs: performance.now() - state.start,
    frameCount: frames.length, frameP95Ms: frames[Math.floor(frames.length * .95)] ?? null,
    longestFrameMs: Math.max(0, ...frames), framesOver50Ms: frames.filter(ms => ms > 50).length,
    longTasks: state.longTasks, mounts: state.mounts, rowAdds: state.rowAdds, rowRemoves: state.rowRemoves,
    mutations: state.mutations, attributeMutations: state.attributeMutations, rpc: state.rpc };
  delete window.__dsgPerformanceProbe;
  return value;
};
const close = async () => {
  await call(() => {
    [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === '返回插件')?.click();
    return true;
  });
  await waitForRenderer(renderer, current => current.evaluate(`!document.querySelector('[data-dsg-route]')`));
};
const sourceFiles = ['src/client.js', 'src/client.template.js', 'src/ui/route-controller.mjs',
  'src/ui/search-log-view.mjs', 'src/ui/quota-view.mjs', 'src/settings-ui.mjs',
  'src/core/shared-config.mjs', 'src/core/control-intent-store.mjs', 'scripts/measure-settings-performance.mjs'];
const output = { runId, label, scope: 'existing-isolated-native-desktop-read-only',
  sourceHashes: receipt?.sourceHashes ?? sourceFiles.map(file => ({ file, sha256: sha256(join(project, file)) })),
  packageSha256: receipt?.sha256 ?? null,
  measurementScriptSha256: sha256(join(project, 'scripts/measure-settings-performance.mjs')),
  credentialsSaved: false, searchesIssued: false, iterations: [] };
try {
  await renderer.send('Page.bringToFront');
  await renderer.send('Performance.enable');
  output.viewport = await call(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  await close();
  output.rpc = await call(async () => {
    const result = [], logSession = crypto.randomUUID();
    for (let i = 0; i < 5; i++) for (const method of ['snapshot', 'preferences', 'readSearchLog']) {
      const start = performance.now(), route = 'grokSearchSettings/' + method;
      const response = await fetch('/api/' + route, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          type: 'client-request', rpcId: crypto.randomUUID(), method: route,
          payload: { args: method === 'readSearchLog' ? { request: { sessionId: logSession } } : {} },
        }) });
      const json = await response.json();
      result.push({ method, ms: performance.now() - start, httpStatus: response.status,
        ok: json.result?.ok === true, ...(method === 'snapshot' ? { control: json.result?.value?.control?.phase } : {}) });
    }
    const method = 'grokSearchSettings/closeSearchLog';
    await fetch('/api/' + method, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        type: 'client-request', rpcId: crypto.randomUUID(), method,
        payload: { args: { request: { sessionId: logSession } } },
      }) });
    return result;
  });
  for (let iteration = 0; iteration < 5; iteration++) {
    const before = await metrics();
    await renderer.send('Profiler.enable');
    await renderer.send('Profiler.start');
    await renderer.evaluate(`window.__dsgExpectedHistoryCount = ${JSON.stringify(expectedHistoryCount)}`);
    await call(start);
    await waitForRenderer(renderer, current => current.evaluate(`Boolean(window.__dsgPerformanceProbe
      && window.__dsgPerformanceProbe.readyAt !== null
      && (window.__dsgPerformanceProbe.expectedHistoryCount === null
        || window.__dsgPerformanceProbe.logsReadyAt !== null))`),
      { timeoutMs: 30_000, intervalMs: 50 });
    await pause(1600);
    const value = await call(stop), after = await metrics();
    const { profile } = await renderer.send('Profiler.stop');
    await renderer.send('Profiler.disable');
    const samples = new Map();
    for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
      const id = profile.samples[i];
      samples.set(id, (samples.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0));
    }
    value.cpuTop = profile.nodes.map(node => ({ fn: node.callFrame.functionName || '(anonymous)',
      line: node.callFrame.lineNumber + 1, us: samples.get(node.id) ?? 0,
      product: /dsh-grok-search/.test(node.callFrame.url) })).filter(row => row.us)
      .sort((a, b) => b.us - a.us).slice(0, 18);
    value.metricsDelta = Object.fromEntries(metricNames.slice(0, 6).map(name => [name, after[name] - before[name]]));
    if (iteration === 0) {
      const clip = await call(() => {
        const root = document.querySelector('[data-dsg-route]').shadowRoot;
        const card = root.querySelector('.route-card').getBoundingClientRect();
        const foot = root.querySelector('.rc-foot').getBoundingClientRect();
        return { x: Math.max(0, card.x), y: Math.max(0, card.y),
          width: Math.min(card.width, innerWidth - Math.max(0, card.x)),
          height: Math.min(foot.bottom, innerHeight) - Math.max(0, card.y), scale: 1 };
      });
      const screenshot = await renderer.send('Page.captureScreenshot', { format: 'png', clip });
      writeFileSync(join(directory, 'route-baseline.png'), Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
    }
    await close();
    await renderer.send('HeapProfiler.collectGarbage');
    value.afterClose = { ...await metrics(), ...await call(() => ({
      routeHosts: document.querySelectorAll('[data-dsg-route]').length,
      layerHosts: document.querySelectorAll('[data-dsg-layer]').length })) };
    output.iterations.push(value);
    console.log(JSON.stringify({ iteration: iteration + 1, readyMs: value.readyMs,
      longTasks: value.longTasks, metrics: value.metricsDelta }));
  }
  // Leave the native view exactly where the user began: on plugin details.
  await call(() => [...document.querySelectorAll('button')]
    .find(item => item.getAttribute('aria-label') === '查看 dsh-grok-search')?.click());
  writeJson(join(directory, 'summary.json'), output);
  console.log(JSON.stringify({ runId, directory, exitCode: 0 }));
} catch (error) {
  await call(() => {
    const state = window.__dsgPerformanceProbe;
    if (state) {
      state.stopped = true; cancelAnimationFrame(state.frame);
      state.longTaskObserver?.disconnect(); state.resourceObserver?.disconnect(); state.mutationsObserver?.disconnect();
      delete window.__dsgPerformanceProbe;
    }
  }).catch(() => {});
  writeJson(join(directory, 'failed.json'), { ...output, error: error.message });
  throw error;
} finally {
  await renderer.send('Profiler.disable').catch(() => {});
  await renderer.send('Performance.disable').catch(() => {});
  renderer.close();
}
