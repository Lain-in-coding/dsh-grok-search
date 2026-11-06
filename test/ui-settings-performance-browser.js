async page => {
  await page.reload();
  await page.waitForFunction(() => Boolean(window.harness));
  const run = await page.evaluate(async () => (await fetch('/begin', { method: 'POST' })).json());
  const results = [], errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.setViewportSize({ width: 1279, height: 821 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const result = { ...run, scope: 'production-ui-synthetic-history-performance', scenarios: results };
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
    .filter(row => ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
      'ScriptDuration', 'TaskDuration', 'Nodes', 'JSEventListeners', 'JSHeapUsedSize'].includes(row.name))
    .map(row => [row.name, row.value]));
  try {
    for (const { queryCount, callsPerQuery } of [
      { queryCount: 2, callsPerQuery: 1 },
      { queryCount: 16, callsPerQuery: 1 },
      { queryCount: 16, callsPerQuery: 16 },
    ]) {
      await page.evaluate(({ queryCount, callsPerQuery }) => {
        window.harness.reset('returning');
        window.harness.unmount();
        const logs = Array.from({ length: 20 }, (_, index) => ({
          id: `search-log-${index + 1}`, at: 1800000000000 + index * 1000,
          q: `Synthetic performance request ${index + 1}`, kind: 'sources', served: 'tavily', ms: 1500,
          calls: [], callsComplete: false, queryCount, queriesComplete: true,
          queries: Array.from({ length: queryCount }, (_, child) => ({
            id: `search-log-${100 + index * 16 + child}`, q: `Synthetic query ${index + 1}.${child + 1}`,
            kind: 'sources', served: 'tavily', ms: 750, callsComplete: true,
            calls: Array.from({ length: callsPerQuery }, () => ({ provider: 'tavily',
              operation: 'search', result: 'ok', charge: { basis: 'reported', amount: 1, unit: 'credits' } })),
          })),
        }));
        window.harness.configure({ logs });
      }, { queryCount, callsPerQuery });
      const before = await metrics();
      await page.evaluate(() => {
        const probe = { started: performance.now(), frames: [], longTasks: [], ready: null };
        window.__uiPerf = probe;
        let previous = probe.started;
        const frame = now => {
          probe.frames.push(now - previous); previous = now;
          const root = document.querySelector('[data-dsg-route]')?.shadowRoot;
          if (probe.ready === null && root?.querySelectorAll('.log-entry').length === 20
            && root.querySelector('#statusPill').dataset.s !== 'load') probe.ready = performance.now() - probe.started;
          probe.raf = requestAnimationFrame(frame);
        };
        probe.observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
        });
        probe.observer.observe({ type: 'longtask' });
        probe.raf = requestAnimationFrame(frame);
        window.harness.mount();
      });
      await page.waitForFunction(() => window.__uiPerf.ready !== null, { timeout: 30000 });
      await page.evaluate(() => new Promise(resolve => {
        const started = performance.now();
        const check = () => performance.now() - started >= 1500 ? resolve() : requestAnimationFrame(check);
        requestAnimationFrame(check);
      }));
      const after = await metrics();
      const measured = await page.evaluate(() => {
        const probe = window.__uiPerf;
        probe.observer.disconnect(); cancelAnimationFrame(probe.raf);
        const root = document.querySelector('[data-dsg-route]').shadowRoot;
        const result = { readyMs: probe.ready, longestFrameMs: Math.max(...probe.frames),
          longTasks: probe.longTasks, elements: root.querySelectorAll('*').length,
          collapsedDetailsElements: [...root.querySelectorAll('.ldet[aria-hidden=true] .ldet-body')]
            .reduce((count, detail) => count + detail.querySelectorAll('*').length, 0) };
        delete window.__uiPerf;
        return result;
      });
      if (measured.collapsedDetailsElements !== 0) throw new Error('Folded history eagerly rendered details.');
      const opened = await page.evaluate(() => {
        const root = document.querySelector('[data-dsg-route]').shadowRoot;
        const article = root.querySelector('.log-entry'), started = performance.now();
        article.querySelector('.le-head').click();
        return new Promise(resolve => requestAnimationFrame(() => resolve({
          ms: performance.now() - started, queries: article.querySelectorAll('.lquery').length,
          calls: article.querySelectorAll('.lu-row').length,
          open: article.classList.contains('is-open') })));
      });
      results.push({ records: 20, queryCount, callsPerQuery, ...measured, opened,
        metricsDelta: Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]])) });
      if (!opened.open || opened.queries !== 1 || opened.calls !== callsPerQuery) throw new Error('Opening per-query details regressed.');
      await page.evaluate(() => window.harness.unmount());
      if (await page.locator('[data-dsg-layer]').count()) throw new Error('Layer survived unmount.');
    }
    await page.evaluate(() => window.harness.mount());
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]')?.shadowRoot
      ?.querySelectorAll('.log-entry').length === 20);
    const polls = await page.evaluate(() => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      window.__stableNodes = { row: root.querySelector('.row'), record: root.querySelector('.log-entry'),
        band: root.querySelector('.le-band-slot').firstElementChild };
      const count = window.harness.state.calls.filter(call => call.method === 'readSearchLog').length;
      window.harness.refresh();
      return count;
    });
    await page.waitForFunction(count => window.harness.state.calls
      .filter(call => call.method === 'readSearchLog').length > count, polls);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const stable = await page.evaluate(() => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      const same = root.querySelector('.row') === window.__stableNodes.row
        && root.querySelector('.log-entry') === window.__stableNodes.record
        && root.querySelector('.le-band-slot').firstElementChild === window.__stableNodes.band;
      delete window.__stableNodes;
      return same;
    });
    if (!stable) throw new Error('An unchanged poll replaced visible provider or log nodes.');
    await page.locator('.log-entry').first().locator('.le-head').click();
    if (await page.locator('.log-entry').first().locator('.lu-row').count() !== 16)
      throw new Error('Expanded query call details are incomplete.');
    await page.locator('#logPrivacy').click();
    if (await page.locator('.log-entry').first().locator('.le-query').textContent() !== '搜索内容已隐藏')
      throw new Error('Expanded details did not update on privacy change.');
    await page.locator('#logPrivacy').click();
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) window.harness.remount();
    });
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]')?.shadowRoot
      ?.querySelector('#statusPill')?.dataset.s !== 'load');
    if (await page.locator('[data-dsg-layer]').count() !== 1) throw new Error('Rapid remount leaked layer hosts.');
    await page.evaluate(() => window.harness.unmount());
    if (await page.locator('[data-dsg-layer]').count() !== 0) throw new Error('Remount cleanup failed.');
    const alignment = [];
    for (const zoom of [1, 2]) {
      await page.evaluate(zoom => {
        document.body.style.zoom = String(zoom);
        window.harness.reset('returning');
      }, zoom);
      await page.waitForFunction(() => {
        const root = document.querySelector('[data-dsg-route]')?.shadowRoot;
        const path = root?.querySelector('#wires .wg[data-w=dsh-hub] path.w');
        if (!path?.getAttribute('d') || !path.getTotalLength()) return false;
        const matrix = path.getScreenCTM();
        if (!matrix) return false;
        return [['dsh-out', 0], ['hub-in', path.getTotalLength()]].every(([name, length]) => {
          const port = root.querySelector(`.port[data-port="${name}"]`)?.getBoundingClientRect();
          if (!port) return false;
          const point = path.getPointAtLength(length).matrixTransform(matrix);
          return Math.hypot(point.x - (port.left + port.width / 2),
            point.y - (port.top + port.height / 2)) < 3;
        });
      }, { timeout: 10000 });
      alignment.push(zoom);
    }
    await page.evaluate(() => { document.body.style.zoom = ''; window.harness.unmount(); });
    result.lifecycle = { unchangedPollPreservesNodes: true, allDetailsExpanded: true,
      privacyUpdatesExpandedDetails: true, rapidRemountCleanup: true, routeAlignmentAtZoom: alignment };
    result.passed = errors.length === 0;
    result.errors = errors;
    const saved = await page.evaluate(async value => {
      const response = await fetch('/evidence', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value) });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }, result);
    console.log(JSON.stringify({ ...saved, ...result }));
  } finally {
    await page.evaluate(() => {
      document.body.style.zoom = '';
      const probe = window.__uiPerf;
      if (probe) { probe.observer?.disconnect(); cancelAnimationFrame(probe.raf); delete window.__uiPerf; }
      window.harness.reset('returning');
    });
    await cdp.detach();
  }
}
