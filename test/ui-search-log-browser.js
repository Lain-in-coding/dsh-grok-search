async page => {
  await page.reload();
  await page.waitForFunction(() => Boolean(window.harness));
  const run = await page.evaluate(async () => (await fetch('/begin', { method: 'POST' })).json());
  const checks = [], errors = [], external = [];
  const origin = await page.evaluate(() => location.origin);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (!request.url().startsWith(origin) && /^https?:/.test(request.url())) external.push(request.url()); });
  const check = (name, actual, expected = true) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, passed, ...(passed ? {} : { actual, expected }) });
    if (!passed) throw new Error(name + ': ' + JSON.stringify(actual));
  };
  const read = fn => page.evaluate(fn);
  const refresh = async () => {
    await page.evaluate(() => window.harness.refresh());
    await page.waitForFunction(() => window.harness.state.calls.some(call => call.method === 'readSearchLog'));
  };
  const rows = () => page.locator('.log-entry');
  const logs = [
    { id: 'search-log-3', at: 1800000002000, q: '<script>private query</script>', kind: 'fallback',
      served: 'tavily', ms: 1200, reason: 'grok_auth_error', official: null, detail: '',
      calls: [{ provider: 'grok', result: 'failed', code: 'HTTP_401' },
        { provider: 'tavily', result: 'ok', keyIndex: 0, charge: { basis: 'reported', amount: 1, unit: 'credits' } }] },
    { id: 'search-log-2', at: 1800000001000, q: 'unknown source', kind: 'fallback', served: 'grok-sources', ms: 300, reason: 'grok_provider_error' },
    { id: 'search-log-1', at: 1800000000000, q: 'all failed', kind: 'failed', served: null, ms: 500, reason: 'SOURCE_ALL_FAILED', calls: [] },
  ];
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.harness.reset('returning'));
    await page.locator('#routeCard:not([data-s=load])').waitFor();
    check('empty log below route', await page.locator('#logCard').evaluate(el => el.previousElementSibling.id), 'routeCard');
    const pendingReads = await read(() => window.harness.state.calls.filter(call => call.method === 'readSearchLog').length);
    await page.evaluate(() => {
      window.harness.configure({ delay: 250, logs: [{ id: 'search-log-1', at: 1800000000000,
        q: 'private-synthetic-query', kind: 'ok', served: 'grok' }] });
      window.harness.refresh();
    });
    await page.waitForFunction(count => window.harness.state.calls.filter(call => call.method === 'readSearchLog').length > count, pendingReads);
    await page.evaluate(() => {
      window.harness.configure({ delay: 0, capabilities: { secretsAllowed: false, transport: 'restricted', reason: 'fixture' } });
      window.harness.refresh();
    });
    await page.waitForTimeout(400);
    check('a late private log reply cannot repopulate a restricted view', await rows().count(), 0);
    check('pending log reads do not defer the restricted notice', await page.locator('#logNote').textContent(),
      '请通过本机直连或 HTTPS 查看搜索日志');
    await page.evaluate(() => { window.harness.configure({ logs: [] }); window.harness.reset('returning'); });
    await page.locator('#routeCard:not([data-s=load])').waitFor();
    await page.evaluate(() => {
      const view = document.querySelector('[data-dsg-route]').shadowRoot;
      view.querySelector('#colList .row[data-id=grok] .row-main').click();
      document.querySelector('[data-dsg-layer]').shadowRoot.querySelector('input[data-k=url]').focus();
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check('opening RAF respects an already focused input', await page.locator('input[data-k=url]').evaluate(el => el.getRootNode().activeElement === el));
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, logs);
    await rows().first().waitFor();
    check('three real gateway-shaped records render', await rows().count(), 3);
    check('query is escaped', await rows().first().locator('.le-query').textContent(), logs[0].q);
    check('no query-created script', await rows().first().locator('script').count(), 0);
    await rows().first().locator('.le-head').click();
    check('reported credits display', await rows().first().locator('.lu-charge').textContent(), '1 credits接口报告');
    check('missing usage remains unknown', await rows().first().locator('.lu-unknown').count(), 1);
    check('no invented official count', await page.locator('.lofficial').count(), 0);
    const before = await read(() => window.harness.state.calls.filter(call => ['diagnoseProvider', 'testSearch', 'save', 'savePreferences', 'accountQuota'].includes(call.method)).length);
    await rows().first().locator('[data-log-replay]').click();
    check('replay overlays main graph', await page.locator('#historyStage').isVisible());
    check('same complete chain in header', await page.locator('#historyRoute .lnode').evaluateAll(nodes => nodes.map(node => node.dataset.node)), ['dsh', 'hub', 'grok', 'tavily']);
    check('overlay provider row does not corrupt live configuration', await page.locator('#colList .row[data-id]').count(), 6);
    const historyMarks = await page.locator('#historyStage .hr-port').evaluateAll(nodes => nodes.map(node => node.dataset.mark || ''));
    const readsBefore = await read(() => window.harness.state.calls.filter(call => call.method === 'readSearchLog').length);
    await page.evaluate(() => window.harness.refresh());
    await page.waitForFunction(count => window.harness.state.calls.filter(call => call.method === 'readSearchLog').length > count, readsBefore);
    check('live polling never changes historical ports', await page.locator('#historyStage .hr-port').evaluateAll(nodes => nodes.map(node => node.dataset.mark || '')), historyMarks);
    check('replay does not issue paid or config RPC', await read(() => window.harness.state.calls.filter(call => ['diagnoseProvider', 'testSearch', 'save', 'savePreferences', 'accountQuota'].includes(call.method)).length), before);
    await page.locator('#historyStop').click();
    check('stop restores current graph', await page.locator('#historyStage').isHidden());
    await page.locator('#logPrivacy').click();
    check('privacy masks rendered query', await rows().first().locator('.le-query').textContent(), '搜索内容已隐藏');
    await rows().first().locator('[data-log-replay]').click();
    check('privacy masks replay query too', await page.locator('#historyQuery').textContent(), '搜索内容已隐藏');
    await page.locator('#historyStop').click();
    await page.locator('[data-logfilter=failed]').click();
    check('failed filter only', await rows().count(), 1);
    await page.locator('[data-logfilter=all]').click();
    // Re-entering settings re-reads the same session log: the first readable
    // snapshot is a baseline, and the session privacy choice is kept.
    await page.evaluate(() => {
      window.harness.remount();
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      const watch = window.__logRemountWatch = { flagged: false };
      const flagged = node => node.nodeType === 1 && node.isConnected
        && (node.matches('.log-entry.is-new, .log-entry.is-final') || !!node.querySelector('.log-entry.is-new, .log-entry.is-final'));
      watch.observer = new MutationObserver(records => {
        if (records.some(record => flagged(record.target) || [...record.addedNodes].some(flagged))) watch.flagged = true;
      });
      watch.observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
    await rows().nth(2).waitFor();
    check('privacy choice survives a settings remount', await page.locator('#logPrivacy').getAttribute('aria-pressed'), 'true');
    check('remounted log keeps queries masked', await rows().locator('.le-query').allTextContents(), ['搜索内容已隐藏', '搜索内容已隐藏', '搜索内容已隐藏']);
    check('remount baseline does not flag existing records as new', await read(() => {
      const watch = window.__logRemountWatch; watch.observer.disconnect(); return watch.flagged;
    }), false);
    check('remount baseline does not announce existing records', await page.locator('#logAnnouncer').textContent(), '');
    await rows().first().locator('.le-head').click();
    await page.locator('#logPrivacy').click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await rows().first().locator('[data-log-replay]').click();
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelector('.hr-wires .packet'));
    check('real packet shares core and halo sizes', await page.locator('.hr-wires .packet').first().evaluate(el =>
      [el.querySelector('.p-halo').getAttribute('r'), el.querySelector('.p-core').getAttribute('r')]), ['7', '3.2']);
    await page.locator('#historyStop').click();
    check('packet cleared after stop', await page.locator('.hr-wires .packet').count(), 0);
    await rows().first().locator('[data-log-replay]').click();
    await page.locator('#historyBar[data-phase=done]').waitFor();
    check('full replay completes and restores configuration', await page.locator('#historyStage').isHidden());
    await rows().nth(1).locator('[data-log-replay]').click();
    await page.locator('#historyStage').waitFor();
    check('unknown source does not pick a provider', await page.locator('.hr-node[data-history-node=unknown]').count(), 1);
    await page.locator('#historyStop').click();
    await page.evaluate(() => window.harness.theme('dark'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-dsg-route]').shadowRoot.querySelector('#routeCard')).backgroundColor === 'rgb(22, 24, 28)');
    await page.screenshot({ path: run.directory + '/log-dark.png', fullPage: true });
    await page.evaluate(() => window.harness.theme('light'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-dsg-route]').shadowRoot.querySelector('#routeCard')).backgroundColor === 'rgb(255, 255, 255)');
    await page.screenshot({ path: run.directory + '/log-light.png', fullPage: true });

    const batch = { id: 'search-log-40', at: 1800000003000, q: '秦皇岛 天气 实时 今天', kind: 'sources',
      served: 'tavily', ms: 3339, queryCount: 2, queriesComplete: true, callFinished: true,
      calls: [], callsComplete: true, queries: [
        { id: 'search-log-41', at: 1800000003000, q: '秦皇岛 天气 实时 今天', kind: 'sources',
          served: 'tavily', ms: 2137, callsComplete: true, calls: [
            { provider: 'tavily', result: 'ok', keyIndex: 0, charge: { basis: 'reported', amount: 1, unit: 'credits' } }] },
        { id: 'search-log-42', at: 1800000003000, q: '河北秦皇岛天气 逐小时预报', kind: 'sources',
          served: 'tavily', ms: 3339, callsComplete: true, calls: [
            { provider: 'tavily', result: 'ok', keyIndex: 0, charge: { basis: 'reported', amount: 1, unit: 'credits' } }] },
      ] };
    await page.evaluate(batch => { window.harness.configure({ logs: [batch] }); window.harness.refresh(); }, batch);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelectorAll('.log-entry').length === 2);
    check('one tool batch is displayed as independent queries', await rows().count(), 2);
    check('header counts displayed queries', await page.locator('#logCount').textContent(), '2');
    check('outer grouped count removed', await page.locator('.le-query-count').count(), 0);
    check('each row retains its own elapsed time', await rows().locator('.le-head .le-dur').allTextContents(), ['2.1 秒', '3.3 秒']);
    check('each query starts collapsed', await rows().first().locator('.le-head').getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: run.directory + '/batch-collapsed-light.png', fullPage: true });
    await rows().first().locator('.le-head').click();
    await rows().nth(1).locator('.le-head').click();
    check('each child title remains directly visible', await rows().locator('.le-query').allTextContents(), batch.queries.map(query => query.q));
    check('detail retains only four columns and no repeated prose', await rows().first().locator('.ldet h4,.ldet p').count(), 0);
    check('child usage is not duplicated in a parent total', await page.locator('.lu-charge').allTextContents(), ['1 credits接口报告', '1 credits接口报告']);
    const detailNode = await rows().first().evaluate(el => { window.__batchNode = el; return true; });
    const headNode = await rows().first().locator('.le-head').evaluate(el => { window.__batchHead = el; return true; });
    check('batch nodes captured', detailNode && headNode);
    await refresh();
    check('polling retains same expanded article', await rows().first().evaluate(el => el === window.__batchNode));
    check('polling retains header instead of resetting focus', await rows().first().locator('.le-head').evaluate(el => el === window.__batchHead));
    const paidBeforeChildReplay = await read(() => window.harness.state.calls.filter(call =>
      ['diagnoseProvider', 'testSearch', 'accountQuota', 'save', 'savePreferences'].includes(call.method)).length);
    await rows().nth(1).locator('[data-log-replay]').click();
    check('child replay uses the selected query in main graph', await page.locator('#historyQuery').textContent(), batch.queries[1].q);
    check('child replay marks the selected independent row', await rows().nth(1).locator('[data-log-replay]').getAttribute('aria-pressed'), 'true');
    check('child replay remains read only', await read(() => window.harness.state.calls.filter(call =>
      ['diagnoseProvider', 'testSearch', 'accountQuota', 'save', 'savePreferences'].includes(call.method)).length), paidBeforeChildReplay);
    await page.locator('#historyStop').click();
    await page.locator('#logPrivacy').click();
    check('privacy covers every child', await rows().locator('.le-query').allTextContents(), ['搜索内容已隐藏', '搜索内容已隐藏']);
    await page.locator('#logPrivacy').click();
    await page.locator('#logList').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: run.directory + '/batch-expanded-light.png', fullPage: true });
    await page.locator('#logCard').screenshot({ path: run.directory + '/batch-detail-light.png' });
    await page.evaluate(() => window.harness.theme('dark'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-dsg-route]').shadowRoot.querySelector('#routeCard')).backgroundColor === 'rgb(22, 24, 28)');
    await page.screenshot({ path: run.directory + '/batch-expanded-dark.png', fullPage: true });
    await page.locator('#logCard').screenshot({ path: run.directory + '/batch-detail-dark.png' });
    await page.evaluate(() => window.harness.theme('light'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const transition = await rows().first().locator('.ldet').evaluate(el => getComputedStyle(el).transitionDuration);
    check('expanded detail has an intentional motion duration', transition.includes('0.26'));
    for (let index = 0; index < 7; index++) await rows().first().locator('.le-head').click();
    check('rapid toggles settle in the requested state', await rows().first().locator('.le-head').getAttribute('aria-expanded'), 'false');
    await rows().first().locator('.le-head').click();
    check('details remain operable after interruption', await page.locator('.lquery').count(), 2);
    await rows().first().locator('.le-head').press('Enter');
    check('keyboard can collapse the batch', await rows().first().locator('.le-head').getAttribute('aria-expanded'), 'false');
    await rows().first().locator('.le-head').press('Enter');
    const motion = await rows().first().locator('.ldet').evaluate(async detail => {
      const header = detail.closest('.log-entry').querySelector('.le-head');
      if (header.getAttribute('aria-expanded') === 'true') header.click();
      await Promise.all(detail.getAnimations().map(animation => animation.finished.catch(() => {})));
      header.click();
      const samples = [];
      await new Promise(resolve => {
        const start = performance.now();
        const tick = time => { samples.push({ dt: time - start, height: detail.getBoundingClientRect().height });
          if (time - start >= 420) resolve(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      return { frames: samples.length, finalHeight: samples.at(-1).height,
        maxFrameGap: Math.max(...samples.slice(1).map((row, index) => row.dt - samples[index].dt)),
        intermediate: samples.some(row => row.height > 0 && row.height < samples.at(-1).height - 1) };
    });
    check('disclosure reaches a non-empty settled state', motion.finalHeight > 0);
    check('disclosure animation presents intermediate geometry', motion.intermediate);
    checks.push({ name: 'measured disclosure motion (diagnostic only, not an FPS guarantee)', passed: true, measurement: motion });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('reduced motion disables the disclosure transition', await rows().first().locator('.ldet').evaluate(el =>
      getComputedStyle(el).transitionDuration.split(',').every(value => parseFloat(value) < .01)));

    const mixed = JSON.parse(JSON.stringify(batch));
    mixed.queries[1].served = 'firecrawl';
    mixed.queries[1].calls = [{ provider: 'firecrawl', result: 'ok', charge: { basis: 'reported', amount: 2, unit: 'credits' } }];
    mixed.served = null;
    await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, [mixed]);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelector('.lu-provider')?.parentElement?.parentElement?.textContent.includes('1 credits'));
    await page.waitForFunction(() => [...document.querySelector('[data-dsg-route]').shadowRoot.querySelectorAll('.lu-provider')].some(el=>el.textContent.includes('Firecrawl')));
    check('different providers credits remain in their own query', await page.locator('.lu-charge').allTextContents(), ['1 credits接口报告', '2 credits接口报告']);
    mixed.queries[1].calls = [{ provider: 'firecrawl', result: 'failed' }];
    mixed.queries[1].callsComplete = false;
    mixed.queries[1].kind = 'failed';
    mixed.kind = 'failed';
    await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, [mixed]);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelector('.log-entry[data-kind=failed]'));
    check('unknown usage remains unknown', await rows().nth(1).locator('.lu-unknown').textContent(), '未报告');
    check('failed parent keeps the successful child charge', await rows().first().locator('.lu-charge').textContent(), '1 credits接口报告');
    await page.locator('[data-logfilter=failed]').click();
    check('failure filter sees only the failed child', await rows().count(), 1);
    await page.locator('[data-logfilter=all]').click();
    const retry = JSON.parse(JSON.stringify(batch));
    retry.kind = 'fallback'; retry.served = 'exa';
    retry.queries[0].kind = 'fallback'; retry.queries[0].served = 'exa';
    retry.queries[0].calls = [
      { provider: 'tavily', result: 'failed', code: 'HTTP_429' },
      { provider: 'exa', result: 'ok', charge: { basis: 'estimated', amount: .003, unit: 'USD' } },
    ];
    await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, [retry]);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelector('.log-entry .lnode[data-node=exa]'));
    check('supplement-only failover never fabricates Grok failure',
      await rows().first().locator('.lroute .lnode').evaluateAll(nodes => nodes.map(node => node.dataset.node)),
      ['dsh', 'hub', 'tavily', 'exa']);
    await rows().first().locator('[data-log-replay]').click();
    check('supplement-only replay marks the actual failed source', await page.locator('#historyStage [data-history-node=tavily]').getAttribute('data-hs'), 'fail');
    check('supplement-only replay leaves Grok untouched', await page.locator('#historyStage [data-history-node=grok]').getAttribute('data-hs'), 'idle');
    await page.locator('#historyStop').click();

    for (const [index, provider] of ['tavily', 'exa', 'tinyfish', 'firecrawl'].entries()) {
      const attributed = { ...logs[0], id: `search-log-${200 + index}`, q: `${provider} internal fallback`,
        served: provider, resultProviders: [provider], resultProvidersComplete: true, callsComplete: false,
        calls: [{ provider: 'grok', result: 'failed', code: 'grok_sources_empty' },
          { provider, operation: 'supplement', result: 'ok', evidence: 'source-label' }] };
      await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, [attributed]);
      await rows().first().locator(`.lnode[data-node="${provider}"]`).waitFor();
      check(provider + ' internal fallback names the actual supplier', await rows().first().locator('.lnode')
        .evaluateAll(nodes => nodes.map(node => node.dataset.node)), ['dsh', 'hub', 'grok', provider]);
      await rows().first().locator('.le-head').click();
      check(provider + ' result labels do not invent billable call counts', await rows().first().locator('.lu-operation').allTextContents(),
        ['搜索', '结果来源']);
      check(provider + ' unknown cost remains unknown', await rows().first().locator('.lu-unknown').count(), 2);
      await rows().first().locator('[data-log-replay]').click();
      check(provider + ' replay lights its official supplier node', await page.locator(`#historyStage [data-history-node="${provider}"]`).getAttribute('data-hs'), 'back');
      check(provider + ' replay has no generic fallback card', await page.locator('#historyStage [data-history-node=unknown]').count(), 0);
      await page.locator('#routeCard').screenshot({ path: run.directory + `/actual-provider-${provider}.png` });
      await page.locator('#historyStop').click();
    }
    const mixedResult = { ...logs[0], id: 'search-log-210', served: 'exa',
      resultProviders: ['grok', 'exa'], resultProvidersComplete: true,
      reason: 'grok_content_empty', calls: [{ provider: 'grok', result: 'failed', code: 'grok_content_empty' },
        { provider: 'exa', result: 'ok', evidence: 'source-label' }] };
    await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, [mixedResult]);
    await rows().first().locator('.lnode[data-node=exa]').waitFor();
    check('mixed evidence keeps Grok citations and the actual fallback supplier without duplicates',
      await rows().first().locator('.lnode').evaluateAll(nodes => nodes.map(node => node.dataset.node)), ['dsh', 'hub', 'grok', 'exa']);
    mixedResult.resultProviders = ['exa']; mixedResult.resultProvidersComplete = false;
    await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, [mixedResult]);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelector('.log-entry .lroute').textContent.includes('来源未报告'));
    check('partial metadata never hides the known supplier', await rows().first().locator('.lroute').textContent()
      .then(text => text.includes('Exa') && text.includes('来源未报告') && !text.includes('补充链')));

    const long = { ...logs[0], id: 'search-log-99', q: '五供应商完整链路', served: 'tinyfish', callsComplete: true, calls: [
      ...['grok', 'tavily', 'exa', 'firecrawl'].map(provider => ({ provider, result: 'failed', code: 'HTTP_429' })),
      { provider: 'tinyfish', result: 'ok' },
    ] };
    await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, [long]);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelectorAll('.log-entry').length === 1);
    check('all five providers keep their names and logos', await rows().first().locator('.lnode').evaluateAll(nodes =>
      nodes.map(node => node.dataset.node)), ['dsh', 'hub', 'grok', 'tavily', 'exa', 'firecrawl', 'tinyfish']);
    check('flat rows use a neutral white surface', await rows().first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
    check('status uses reference dot, not old status SVG', await rows().first().locator('.le-chip').evaluate(el =>
      Boolean(el.querySelector('.le-dot')) && !el.querySelector('svg')));
    await rows().first().locator('.le-head').click();
    const tip = page.locator('.log-entry[data-parent-id="search-log-99"]').locator('.lu-unknown [data-log-tip]').last();
    await tip.focus();
    check('tooltip opens in real Shadow DOM', await page.locator('#logTooltip').isVisible());
    check('tooltip retains accessible relationship in the same shadow tree', await tip.evaluate(el =>
      Boolean(el.getRootNode().getElementById(el.getAttribute('aria-describedby')))));
    check('cost warning is only shown on demand', await page.locator('#logTooltip').textContent(),
      '未报告不代表免费；失败、超时或取消也可能产生消耗。');
    check('tooltip stays within viewport', await page.locator('#logTooltip').evaluate(el => {
      const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }));
    check('tooltip stays anchored to its trigger', await tip.evaluate(el => {
      const r = el.getBoundingClientRect(), t = el.getRootNode().getElementById('logTooltip').getBoundingClientRect();
      const near = (a, b) => Math.abs(a - b) <= 4;
      const centred = near(t.left + t.width / 2, r.left + r.width / 2)
        || (near(t.left, 12) || near(t.right, innerWidth - 12)) && t.left <= r.right && t.right >= r.left;
      return centred && (near(t.top, r.bottom + 8) || near(t.bottom, r.top - 8));
    }));
    await page.evaluate(log => {
      window.harness.configure({ logs: [{ ...log, id: 'search-log-100', kind: 'running', q: 'another pending query' }, log] });
      window.harness.refresh();
    }, long);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelectorAll('.log-entry').length === 2);
    check('new unrelated record does not steal the info-button focus', await tip.evaluate(el => el === el.getRootNode().activeElement));
    check('new unrelated record does not dismiss focused explanation', await page.locator('#logTooltip').isVisible());
    await page.keyboard.press('Escape');
    check('Escape dismisses without moving focus', await page.locator('#logTooltip').isHidden());
    await page.locator('#logPrivacy').click();
    check('privacy erases tooltip text', await page.locator('#logTooltip').textContent(), '');
    await page.locator('#logPrivacy').click();
    const timed = JSON.parse(JSON.stringify(batch));
    timed.queries[0].at += 3000; timed.queries[1].at += 10000;
    await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, [timed]);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelector('.le-query')?.textContent.includes('秦皇岛'));
    const times = await page.evaluate(rows => rows.map(row => new Date(row.at).toLocaleTimeString('zh-CN', {hour12:false})), timed.queries);
    check('individual timestamps are not replaced with parent time', await rows().locator('.le-time').allTextContents(), times);
    const tiny = { ...logs[0], id: 'search-log-101', q: 'tiny fee', kind: 'sources', served: 'tavily', detail: 'sensitive error echo',
      reason: 'constructor', callsComplete: true, calls: [{ provider: 'tavily', result: 'ok',
        charge: { amount: 0.0000001, unit: 'credits', basis: 'reported' } }] };
    await page.evaluate(logs => { window.harness.configure({ logs }); window.harness.refresh(); }, [tiny]);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelector('.le-query')?.textContent === 'tiny fee');
    await rows().first().locator('.le-head').click();
    check('tiny credits do not round down to free', await rows().first().locator('.lu-charge').textContent(), '<0.000001 credits接口报告');
    check('inherited property names are not turned into functions', await rows().first().locator('.lu-columns [data-log-tip]').getAttribute('data-log-tip')
      .then(text => !text.includes('function Object')));
    await page.locator('#logPrivacy').click();
    check('privacy also covers echoed error details', await rows().first().evaluate(el => !el.outerHTML.includes('sensitive error echo')));
    await page.locator('#logPrivacy').click();
    const rollback = await page.evaluate(async () => {
      const original = window.ResizeObserver;
      window.ResizeObserver = class { constructor() { throw new Error('test setup failure'); } };
      document.querySelector('[data-dsg-route]').shadowRoot.querySelector('[data-log-replay]').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      const value = { hidden: root.querySelector('#historyStage').hidden, locked: root.querySelector('#stage').inert,
        error: root.querySelector('#logAnnouncer').textContent };
      window.ResizeObserver = original;
      return value;
    });
    check('replay setup error unlocks production controls', rollback.hidden && !rollback.locked && rollback.error.includes('回放未能完成'));
    await page.locator('#logCard').screenshot({ path: run.directory + '/compact-log-detail.png' });

    const quotaCallsBefore = await read(() => window.harness.state.calls.filter(call => call.method === 'accountQuota').length);
    const revealsBefore = await read(() => window.harness.state.calls.filter(call => call.method === 'reveal').length);
    await page.evaluate(() => window.harness.configure({ quotas: { tavily: [
      { kind: 'credits', used: 45, remaining: 955, plan: 1000,
        keyUsed: 5, keyLimit: 100, keyRemaining: 95, note: '真实数据格式，离线夹具' },
      { kind: 'credits', used: 70, remaining: 930, plan: 1000,
        keyUsed: 20, keyLimit: 200, keyRemaining: 180, note: '第二个离线账户' },
    ] }, quotaDelay: 150 }));
    await page.locator('#colList .row[data-id=tavily] .row-main').click();
    await page.locator('#dialog').waitFor();
    check('quota header includes compact console link', await page.locator('.qp-heading .qp-console').count(), 1);
    check('console typography matches approved detail', await page.locator('.qp-console').evaluate(el => {
      const style = getComputedStyle(el); return [style.fontSize, style.fontWeight];
    }), ['11px', '550']);
    await page.locator('#quotaPanel[data-state=ready]').waitFor();
    check('opening config automatically queries the saved account once',
      await read(() => window.harness.state.calls.filter(call => call.method === 'accountQuota').length), quotaCallsBefore + 1);
    check('automatic query never reveals credentials',
      await read(() => window.harness.state.calls.filter(call => call.method === 'reveal').length), revealsBefore);
    check('automatic query leaves saved keys masked', await page.locator('input[data-k^="keys."]').evaluateAll(inputs => inputs.every(input => !input.value)));
    check('used and remaining are distinct', await page.locator('.qp-stats .qp-value').allTextContents(), ['45', '955']);
    check('approved quota details and separate key row are absent',
      await page.locator('[data-a=quota-details],#quotaDetails,.qp-key-hint').count(), 0);
    check('header keeps both controls right-aligned with the original title', await page.locator('.qp-head').evaluate(el => {
      const rect = el.getBoundingClientRect(), title = el.querySelector('h3'), link = el.querySelector('.qp-console');
      const controls = [...el.querySelectorAll('.qp-tools button,.qp-tools select')];
      return getComputedStyle(title).fontSize === '13px' && getComputedStyle(title).fontWeight === '600'
        && link.getBoundingClientRect().left - title.getBoundingClientRect().right === 8
        && controls.length === 2 && controls.every(node => {
          const box = node.getBoundingClientRect();
          return box.left > link.getBoundingClientRect().right
            && Math.abs(box.y + box.height / 2 - rect.y - rect.height / 2) < 1;
        }) && el.nextElementSibling.getBoundingClientRect().top >= rect.bottom;
    }));
    check('only the useful key restriction tooltip accompanies the total',
      await page.locator('.qp-total + [data-quota-kind=key]').count(), 1);
    check('Tavily no longer renders the redundant account note', await page.locator('[data-quota-kind=account]').count(), 0);
    await page.locator('[data-quota-kind=key]').focus();
    await page.locator('#routeTooltip').waitFor();
    check('key allowance tooltip works through Shadow DOM keyboard focus',
      await page.locator('#routeTooltip').textContent(), '当前 Key 最多还可用 95 credits。');
    check('tooltip has an accessible same-shadow relationship', await page.locator('[data-quota-kind=key]').evaluate(el =>
      el.getAttribute('aria-describedby') === 'routeTooltip' && el.getRootNode().querySelector('#routeTooltip').getAttribute('role') === 'tooltip'));
    await page.keyboard.press('Escape');
    check('first Escape dismisses the quota tip rather than its dialog',
      await page.locator('#routeTooltip').isHidden() && await page.locator('#overlay').isVisible());
    await page.locator('[data-quota-kind=key]').click();
    check('click also reveals the key limit', await page.locator('#routeTooltip').isVisible());
    await page.locator('#dialog').screenshot({ path: run.directory + '/quota-compact-success.png' });
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    await page.locator('#colList .row[data-id=tavily] .row-main').click();
    check('quick reopen instantly uses the same account cache', await page.locator('#quotaPanel').getAttribute('data-state'), 'ready');
    check('quick reopen does not duplicate quota requests',
      await read(() => window.harness.state.calls.filter(call => call.method === 'accountQuota').length), quotaCallsBefore + 1);
    await page.locator('[data-quota-key]').selectOption('1');
    await page.locator('#quotaPanel[data-state=ready]').waitFor();
    check('selecting an unqueried Tavily key automatically loads its own account',
      await page.locator('.qp-stats .qp-value').allTextContents(), ['70', '930']);
    await page.locator('[data-quota-kind=key]').hover();
    check('tooltip updates to the selected key allowance',
      await page.locator('#routeTooltip').textContent(), '当前 Key 最多还可用 180 credits。');
    await page.locator('[data-quota-key]').selectOption('0');
    check('switching back reuses only the matching key cache',
      await page.locator('.qp-stats .qp-value').allTextContents(), ['45', '955']);
    check('key restriction does not add a second large balance', await page.locator('.qp-stats .qp-value').count(), 2);
    await page.evaluate(() => window.harness.configure({ quotaError: true }));
    await page.locator('[data-a=quota-refresh]').click();
    await page.locator('#quotaPanel[data-state=error]').waitFor();
    check('query failure retains explicitly stale value', await page.locator('.qp-updated').textContent().then(text => text.includes('刷新失败 · 上次结果')));
    await page.locator('[data-quota-kind=error]').hover();
    check('unknown failure never invents an auth failure',
      await page.locator('#routeTooltip').textContent().then(text => text.includes('不等于搜索不可用') && !text.includes('401')));
    await page.locator('input[data-k=url]').fill('https://custom.test');
    check('changed URL does not reuse old balance', await page.locator('#quotaPanel').getAttribute('data-state'), 'unreported');
    check('dirty destination supports explicit quota query', await page.locator('[data-a=quota-refresh]').isEnabled());
    const savedQuotaConfig = await read(() => JSON.stringify(window.harness.state.content));
    await page.evaluate(() => window.harness.configure({ quotaError: false }));
    await page.locator('[data-a=quota-refresh]').click();
    await page.locator('#quotaPanel[data-state=ready]').waitFor();
    check('draft quota keeps configuration dialog open', await page.locator('#overlay').isVisible());
    check('draft destination sent only for this request',
      await read(() => window.harness.state.calls.filter(call => call.method === 'previewAccountQuota').at(-1).request.draft.baseUrl), 'https://custom.test');
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    check('cancelling draft quota leaves saved config unchanged',
      await read(() => JSON.stringify(window.harness.state.content)), savedQuotaConfig);
    await page.evaluate(() => window.harness.configure({ quotaError: false, quotaDelay: 500, quotaIgnoreCancellation: true,
      quotas: { firecrawl: { kind: 'credits', used: null, remaining: 890, plan: null, note: '离线团队余额' } } }));
    await page.locator('#colList .row[data-id=firecrawl] .row-main').click();
    await page.locator('#quotaPanel[data-state=loading]').waitFor();
    check('quota loading exposes accessible busy state', await page.locator('#quotaPanel').getAttribute('aria-busy'), 'true');
    check('automatic loading disables duplicate refresh', await page.locator('[data-a=quota-refresh]').isDisabled());
    const slowQuota = await read(() => window.harness.state.calls.filter(call => call.method === 'accountQuota').at(-1).request.operationId);
    await page.locator('input[data-k=url]').fill('https://custom.test');
    check('editing the destination cancels its pending automatic query',
      await page.evaluate(id => window.harness.state.calls.some(call => call.method === 'cancelDiagnosis' && call.request.operationId === id), slowQuota));
    await page.locator('input[data-k=url]').fill('');
    await page.waitForTimeout(650);
    check('restoring draft text does not accept a previously cancelled balance', await page.locator('#quotaPanel .qp-value').count(), 0);
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    await page.locator('#colList .row[data-id=firecrawl] .row-main').click();
    await page.locator('#quotaPanel[data-state=loading]').waitFor();
    const closeQuota = await read(() => window.harness.state.calls.filter(call => call.method === 'accountQuota').at(-1).request.operationId);
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    check('closing the dialog cancels only its own quota request',
      await page.evaluate(id => window.harness.state.calls.some(call => call.method === 'cancelDiagnosis' && call.request.operationId === id), closeQuota));
    await page.locator('#colList .row[data-id=exa] .row-main').click();
    check('Exa no fake refresh request', await page.locator('[data-a=quota-refresh]').count(), 0);
    check('Exa compact not failed', await page.locator('#quotaPanel').getAttribute('data-state'), 'unsupported');
    await page.waitForTimeout(650);
    check('late quota response cannot replace another provider dialog', await page.locator('#quotaPanel').getAttribute('data-provider'), 'exa');
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.harness.configure({ quotaDelay: 0, quotaIgnoreCancellation: false }));
    await page.locator('#colList .row[data-id=firecrawl] .row-main').click();
    await page.locator('#quotaPanel[data-state=ready]').waitFor();
    // An external write with no draft edit makes the open account baseline stale.
    await page.evaluate(() => { window.harness.inject({ timeout_seconds: 61 }); window.harness.refresh(); });
    await page.locator('[data-a=reload-draft]').waitFor({ timeout: 5000 });
    check('external write marks the open quota as stale', await page.locator('#quotaPanel').getAttribute('data-state'), 'stale');
    check('stale quota cannot refresh against the old baseline', await page.locator('[data-a=quota-refresh]').isDisabled());
    check('stale quota does not claim a local edit', await page.locator('.qp-placeholder').textContent().then(text => !text.includes('保存后刷新')));
    await page.locator('[data-a=reload-draft]').click();
    await page.locator('#quotaPanel[data-state=ready]').waitFor();
    check('reloading the latest config restores quota refresh', await page.locator('[data-stat=remaining] .qp-value').textContent(), '890');
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    // Custom URLs keep an explicit official console link, but credentials never
    // leave the authenticated quota RPC or appear in this tooltip.
    await page.evaluate(() => {
      window.harness.inject({ tavily_api_url: 'https://quota.example.test' });
      window.harness.configure({ quotas: { tavily: [
        { kind: 'credits', used: 45, remaining: 955, plan: 1000, keyRemaining: 95 },
        { kind: 'credits', used: 70, remaining: 930, plan: 1000, keyRemaining: 180 },
      ] } });
      window.harness.refresh();
    });
    await page.locator('#colList .row[data-id=tavily] .row-main').click();
    await page.locator('#quotaPanel[data-state=ready]').waitFor();
    await page.locator('.qp-console').hover();
    check('custom URL keeps an honestly labelled official console destination',
      await page.locator('#routeTooltip').textContent().then(text => text.includes('官方服务控制台') && text.includes('自定义服务')));
    check('console uses the same fixed safe official URL', await page.locator('.qp-console').evaluate(el =>
      el.href === 'https://app.tavily.com/' && el.target === '_blank' && el.rel.includes('noreferrer')));
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    // TinyFish is initially unconfigured in this fixture.
    await page.locator('#colList .row[data-id=tinyfish] .row-main').click();
    check('unconfigured row remains compact', await page.locator('.qp-empty').evaluate(el => el.getBoundingClientRect().height <= 44));
    check('unconfigured title and console remain visible', await page.locator('.qp-heading .qp-console').isVisible());
    await page.locator('#dialog').screenshot({ path: run.directory + '/quota-unconfigured.png' });
    const beforeUnsavedKey = await read(() => JSON.stringify(window.harness.state.content));
    await page.locator('input[data-k=key]').fill('synthetic-unsaved-tinyfish');
    await page.evaluate(() => window.harness.configure({ quotas: { tinyfish: { kind: 'wallet', balance: 2 } } }));
    check('new unsaved key can query immediately', await page.locator('[data-a=quota-refresh]').isEnabled());
    await page.locator('[data-a=quota-refresh]').click();
    await page.locator('#quotaPanel[data-state=ready]').waitFor();
    check('current form key is sent in transient draft',
      await read(() => window.harness.state.calls.filter(call => call.method === 'previewAccountQuota').at(-1).request.draft.apiKey), 'synthetic-unsaved-tinyfish');
    await page.evaluate(() => window.harness.configure({ quotaError: { category: 'AUTH', httpStatus: 401 } }));
    await page.locator('[data-a=quota-refresh]').click();
    await page.locator('#quotaPanel[data-state=error]').waitFor();
    await page.locator('[data-quota-kind=error]').hover();
    check('quota failure explains independent quota permissions',
      await page.locator('#routeTooltip').textContent().then(text => text.includes('不等于搜索不可用')));
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    check('cancel after draft-key test never persists the key', await read(() => JSON.stringify(window.harness.state.content)), beforeUnsavedKey);
    await page.evaluate(() => {
      window.harness.inject({ tinyfish_api_key: 'synthetic-quota-test' });
      window.harness.configure({ quotaError: true });
      window.harness.refresh();
    });
    await page.locator('#colList .row[data-id=tinyfish] .row-main').click();
    await page.locator('#quotaPanel[data-state=error]').waitFor();
    check('first failure is compact and contains no manufactured zero', await page.locator('#quotaPanel').evaluate(el =>
      el.querySelector('.qp-empty').getBoundingClientRect().height <= 44 && !el.querySelector('.qp-value')));
    check('failure keeps refresh aligned in header', await page.locator('.qp-head [data-a=quota-refresh]').textContent(), '重试');
    await page.locator('[data-quota-kind=error]').focus();
    await page.locator('#routeTooltip').waitFor();
    await page.keyboard.press('Escape');
    check('error explanation Escape also preserves its dialog', await page.locator('#overlay').isVisible());
    await page.locator('#dialog').screenshot({ path: run.directory + '/quota-failed.png' });
    await page.evaluate(() => window.harness.configure({ quotaError: false, quotas: {
      tinyfish: { kind: 'wallet', balance: -1.25, note: '钱包余额不是剩余免费搜索次数。' },
    } }));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('[data-a=quota-refresh]').click();
    await page.locator('#quotaPanel[data-state=ready]').waitFor();
    await page.locator('#quotaPanel').evaluate(el => Promise.all(el.parentElement.getAnimations({ subtree: true })
      .filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    check('retry displays wallet data without inventing credits', await page.locator('.qp-wallet .qp-value').textContent(), '-1.25');
    // Focus restoration can start a short CSS transition after the WAAPI
    // promise settles. Assert bounded quiescence, not the same microtask.
    await page.waitForFunction(() => document.querySelector('[data-dsg-layer]').shadowRoot
      .querySelector('#quotaSlot').getAnimations({ subtree: true }).length === 0, undefined, { timeout: 1500 });
    check('settled quota animations release their keyframes', await page.locator('#quotaSlot').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => {
        window.harness.theme(theme);
        window.harness.configure({ quotas: { tavily: [
          { kind: 'credits', used: 12345678.125, remaining: 7654321.875, plan: 20000000,
            keyRemaining: 0, note: '<img src=x onerror=alert(1)>' },
          { kind: 'credits', used: 1000, remaining: 0, plan: 1000, keyRemaining: 0 },
        ] } });
      }, theme);
      await page.locator('#colList .row[data-id=tavily] .row-main').click();
      await page.locator('[data-a=quota-refresh]').click();
      await page.locator('#quotaPanel[data-state=ready]').waitFor();
      check(theme + ': real zero key allowance is preserved', await page.locator('[data-quota-kind=key]').getAttribute('data-quota-tip'), '当前 Key 最多还可用 0 credits。');
      check(theme + ': raw note cannot inject tooltip markup', await page.locator('#quotaPanel img').count(), 0);
      for (const width of [1440, 390, 360]) {
        await page.setViewportSize({ width, height: 900 });
        check(theme + '/' + width + ': quota contents do not overflow', await page.locator('#quotaPanel').evaluate(el =>
          el.scrollWidth <= el.clientWidth + 1 && el.querySelector('.qp-head').getBoundingClientRect().height === 30));
      }
      await page.locator('#dialog').screenshot({ path: run.directory + '/quota-narrow-' + theme + '.png' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('[data-quota-key]').selectOption('1');
      await page.locator('[data-a=quota-refresh]').click();
      await page.locator('#quotaPanel[data-state=ready]').waitFor();
      check(theme + ': zero account balance remains a successful result', await page.locator('[data-stat=remaining] .qp-value').textContent(), '0');
      check(theme + ': matching limits have no redundant key hint', await page.locator('[data-quota-kind=key]').count(), 0);
      await page.locator('[data-a=cancel]').click();
      await page.locator('#overlay').waitFor({ state: 'hidden' });
    }
    await page.evaluate(() => window.harness.theme('light'));
    await page.locator('#logClear').click();
    await page.waitForFunction(() => window.harness.state.calls.some(call => call.method === 'clearSearchLog'));
    check('clear removes records', await rows().count(), 0);
    await page.evaluate(() => { window.harness.configure({ logError: 'gateway/signature-invalid' }); window.harness.refresh(); });
    await page.locator('.lc-empty:has-text("搜索记录暂不可读")').waitFor();
    check('failed log reads do not claim zero searches', await page.locator('#logCount').textContent(), '—');
    check('log errors retain real codes instead of blaming HTTPS', await page.locator('#logNote').textContent().then(text =>
      text.includes('gateway/signature-invalid') && !text.includes('安全连接')));
    await page.evaluate(() => { window.harness.configure({ logError: null }); window.harness.refresh(); });
    await page.locator('.lc-empty:has-text("还没有搜索记录")').waitFor();
    await page.evaluate(() => {
      window.harness.configure({ logs: [{ id: 'search-log-120', at: 1800000009000, q: 'after clear arrives',
        kind: 'ok', served: 'grok', ms: 800, reason: '', calls: [] }] });
      window.harness.refresh();
    });
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot
      .querySelector('#logAnnouncer').textContent === 'after clear arrives，Grok 返回。');
    check('a record arriving after an explicit clear is still announced as new', await rows().count(), 1);
    await page.locator('#colList .row[data-id=grok] .row-main').click();
    check('provider switch has an explicit accessible label', await page.locator('[data-a=enabled]').getAttribute('aria-label'), 'Grok 启用');
    await page.locator('[data-a=mode][data-v=responses]').focus();
    await page.keyboard.press('ArrowRight');
    check('protocol radios support keyboard selection and roving focus', await page.locator('[data-a=mode][data-v=compat]')
      .evaluate(el => el.getRootNode().activeElement === el && el.getAttribute('aria-checked') === 'true' && el.tabIndex === 0));
    await page.keyboard.press('ArrowLeft');
    check('protocol arrow navigation returns to existing configuration', await page.locator('[data-a=mode][data-v=responses]')
      .getAttribute('aria-checked'), 'true');
    await page.keyboard.press('ArrowDown');
    check('protocol radios also follow vertical arrow keys', await page.locator('[data-a=mode][data-v=compat]')
      .evaluate(el => el.getRootNode().activeElement === el && el.getAttribute('aria-checked') === 'true'));
    await page.keyboard.press('ArrowUp');
    check('vertical arrow navigation returns to existing configuration', await page.locator('[data-a=mode][data-v=responses]')
      .evaluate(el => el.getRootNode().activeElement === el && el.getAttribute('aria-checked') === 'true'));
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    for (const [method, code] of [
      ['log', 'SETTINGS_AUTH_REQUIRED'],
      ['log', 'SETTINGS_SECURE_CONNECTION_REQUIRED'],
      ['snapshot', 'SETTINGS_AUTH_REQUIRED'],
    ]) {
      await page.evaluate(() => {
        window.harness.configure({ logError: null, snapshotError: null, logs: [{
          id: 'search-log-121', at: Date.now(), q: 'private-revocation-check', kind: 'sources',
          served: 'tavily', ms: 500, calls: [{ provider: 'tavily', result: 'ok' }],
        }] });
        window.harness.refresh();
      });
      await rows().first().locator('.le-query').filter({ hasText: 'private-revocation-check' }).waitFor();
      await rows().first().locator('.le-head').click();
      await rows().first().locator('[data-log-replay]').click();
      const clears = await read(() => window.harness.state.calls.filter(call => call.method === 'clearSearchLog').length);
      await page.evaluate(({ method, code }) => {
        window.harness.configure(method === 'log' ? { logError: code } : { snapshotError: code });
        window.harness.refresh();
      }, { method, code });
      await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelectorAll('.log-entry').length === 0);
      check(method + '/' + code + ': private query is immediately removed', await rows().count(), 0);
      check(method + '/' + code + ': unreadable count is not zero', await page.locator('#logCount').textContent(), '—');
      check(method + '/' + code + ': playback closes', await page.locator('#historyStage').isHidden());
      check(method + '/' + code + ': replay text is removed', await page.locator('#historyQuery').textContent(), '');
      check(method + '/' + code + ': rejection code remains actionable', (await page.locator('#logNote').textContent()).includes(code));
      check(method + '/' + code + ': server history is not deleted',
        await read(() => window.harness.state.calls.filter(call => call.method === 'clearSearchLog').length), clears);
    }
    await page.evaluate(() => {
      window.harness.configure({ snapshotError: null, logError: null });
      window.harness.refresh();
    });
    await rows().first().waitFor();
    await page.evaluate(() => { window.harness.configure({ logError: 'SETTINGS_UNAVAILABLE' }); window.harness.refresh(); });
    await page.locator('#logNote').filter({ hasText: 'SETTINGS_UNAVAILABLE' }).waitFor();
    check('ordinary log network error retains readable history', await rows().first().locator('.le-query').textContent(), 'private-revocation-check');
    // A stale authorized snapshot must not undo a newer log rejection.
    const beforeDeniedRead = await read(() => window.harness.state.calls.filter(call => call.method === 'readSearchLog').length);
    await page.evaluate(() => {
      window.harness.configure({ logError: 'SETTINGS_AUTH_REQUIRED', logDelay: 250 });
      window.harness.refresh();
    });
    await page.waitForFunction(count => window.harness.state.calls.filter(call => call.method === 'readSearchLog').length > count, beforeDeniedRead);
    await page.evaluate(() => {
      window.harness.configure({ logError: null, snapshotDelay: 700 });
      window.harness.refresh();
    });
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelectorAll('.log-entry').length === 0);
    await page.evaluate(() => window.harness.configure({ snapshotError: 'SETTINGS_AUTH_REQUIRED' }));
    await page.waitForTimeout(800);
    check('late authorized snapshot cannot revive rejected private history', await rows().count(), 0);
    check('late authorized snapshot cannot re-enable secret controls',
      await page.locator('.banner:has-text("仅显示脱敏")').count() > 0);
    await page.evaluate(() => {
      window.harness.configure({ snapshotError: null, snapshotDelay: 0, logDelay: 0, logError: null });
      window.harness.refresh();
    });
    await rows().first().waitFor();
    check('fresh authorization and log read restore retained server history',
      await rows().first().locator('.le-query').textContent(), 'private-revocation-check');
    await page.setViewportSize({width:720,height:900});
    check('main routing UI retains wide topology within its actual container', await page.locator('#routeCard').evaluate(el => {
      const root = el.getRootNode(), stage = root.querySelector('#stage');
      return stage.dataset.layout === 'wide' && getComputedStyle(stage).gridTemplateColumns.split(' ').length === 3
        && el.scrollWidth <= el.clientWidth + 1
        && el.getBoundingClientRect().width <= root.host.getBoundingClientRect().width + 1;
    }));
    await page.evaluate(() => window.harness.unmount());
    check('unmount closes private lease', await read(() => window.harness.state.calls.some(call => call.method === 'closeSearchLog')));
    check('all layer hosts removed', await page.locator('[data-dsg-layer]').count(), 0);
    check('no runtime error', errors.length, 0);
    check('no external request', external.length, 0);
    const summary = { ...run, passed: checks.length, failed: 0, checks, errors, external,
      fixtureOnly: true, realHostVerified: false };
    const recorded = await page.evaluate(async summary => {
      const response = await fetch('/evidence', { method: 'POST', body: JSON.stringify(summary) });
      return { ok: response.ok, text: await response.text() };
    }, summary);
    if (!recorded.ok) throw new Error(recorded.text);
    console.log(JSON.stringify({ runId: run.runId, passed: checks.length, failed: 0 }));
  } catch (error) {
    await page.screenshot({ path: run.directory + '/failed.png', fullPage: true });
    const summary = { ...run, checks, errors, external, failed: 1, error: String(error), fixtureOnly: true };
    await page.evaluate(summary => fetch('/evidence', { method: 'POST', body: JSON.stringify(summary) }), summary);
    throw error;
  }
}
