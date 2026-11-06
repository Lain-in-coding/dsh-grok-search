async page => {
  await page.reload();
  await page.waitForFunction(() => Boolean(window.harness));
  const input = await page.evaluate(async () => {
    const response = await fetch('/live-evidence');
    if (!response.ok) throw new Error('Live evidence preview required.');
    return response.json();
  });
  const run = await page.evaluate(async () => (await fetch('/begin', { method: 'POST' })).json());
  const checks = [], errors = [], external = [];
  const origin = await page.evaluate(() => location.origin);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) external.push(request.url());
  });
  const check = (name, actual, expected = true) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, passed, ...(passed ? {} : { actual, expected }) });
    if (!passed) throw new Error(name);
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(input => {
      window.harness.reset('returning');
      window.harness.configure({ logs: [] });
    }, input);
    await page.locator('#routeCard:not([data-s=load])').waitFor();
    await page.evaluate(input => {
      // Only synthetic credentials enter the browser, even for the live data replay.
      window.harness.inject({ tinyfish_api_key: 'tf-synthetic', tavily_api_key: 'tvly-synthetic' });
      window.harness.configure({ logs: input.logs, quotas: input.quotas });
      window.harness.refresh();
    }, input);
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot
      .querySelector('#colList .row[data-id=tinyfish] .switch').getAttribute('aria-checked') === 'true');
    await page.waitForFunction(count => document.querySelector('[data-dsg-route]').shadowRoot
      .querySelectorAll('.log-entry').length === count, input.logs.length);
    check('all captured real log records render', await page.locator('.log-entry').count(), input.logs.length);
    for (const provider of ['tavily', 'exa', 'firecrawl', 'tinyfish']) {
      const index = input.logs.findIndex(log => log.served === provider && log.kind === 'sources');
      const log = input.logs[index], row = page.locator('.log-entry').nth(index);
      await row.locator('.le-head').click();
      const charge = log.calls[0].charge;
      const text = await row.innerText();
      check(provider + ' actual call renders', text.toLowerCase().includes(provider));
      check(provider + ' real charge accuracy', charge.basis === 'unknown'
        ? await row.locator('.lu-unknown').count() > 0
        : text.includes(String(charge.amount)) && text.includes(charge.basis === 'estimated' ? '估算' : '接口报告'));
      await row.locator('.le-head').click();
    }
    const fallback = input.logs.findIndex(log => log.kind === 'fallback');
    const before = await page.evaluate(() => window.harness.state.calls
      .filter(call => ['diagnoseProvider', 'testSearch', 'accountQuota', 'save', 'savePreferences'].includes(call.method)).length);
    await page.locator('.log-entry').nth(fallback).locator('[data-log-replay]').click();
    await page.locator('#historyStage').waitFor();
    check('real fallback sequence reproduces main graph', await page.locator('#historyRoute .lnode')
      .evaluateAll(nodes => nodes.map(node => node.dataset.node)), ['dsh', 'hub', 'grok', 'tavily']);
    await page.locator('#historyStop').click();
    check('real-data replay never searches or spends credits', await page.evaluate(() => window.harness.state.calls
      .filter(call => ['diagnoseProvider', 'testSearch', 'accountQuota', 'save', 'savePreferences'].includes(call.method)).length), before);
    check('unknown official counter is never displayed as zero', await page.locator('.lofficial').count(), 0);
    const format = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
    for (const provider of ['tavily', 'firecrawl', 'tinyfish']) {
      await page.locator(`#colList .row[data-id=${provider}] .row-main`).click();
      await page.locator('#dialog').waitFor();
      await page.locator('[data-a=quota-refresh]').click();
      await page.locator('#quotaPanel[data-state=ready]').waitFor();
      const value = input.quotas[provider];
      if (provider === 'tinyfish') {
        check('real TinyFish wallet renders', await page.locator('.qp-wallet .qp-value').textContent(), String(value.balance));
      } else {
        check(provider + ' real usage and balance render', await page.locator('.qp-stats .qp-value').allTextContents(),
          [value.used === null ? '未报告' : format(value.used), format(value.remaining)]);
        if (provider === 'tavily') {
          check('real account view does not restore removed quota details', await page.locator('[data-a=quota-details],#quotaDetails,.qp-key-hint').count(), 0);
          const restricted = typeof value.keyRemaining === 'number' && value.keyRemaining >= 0
            && typeof value.remaining === 'number' && value.remaining >= 0 && value.keyRemaining < value.remaining;
          check('real key limit is shown only when it adds a restriction',
            await page.locator('.qp-total + [data-quota-kind=key]').count(), restricted ? 1 : 0);
        }
      }
      await page.screenshot({ path: run.directory + '/' + provider + '-live-values.png', fullPage: true });
      await page.locator('[data-a=cancel]').click();
      await page.locator('#overlay').waitFor({ state: 'hidden' });
    }
    await page.locator('#colList .row[data-id=exa] .row-main').click();
    check('Exa remains a compact console entry, not a fabricated failure', await page.locator('#quotaPanel').getAttribute('data-state'), 'unsupported');
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    check('no browser runtime errors', errors.length, 0);
    check('no real keys or provider requests in browser', external.length, 0);
    const summary = { ...run, passed: checks.length, failed: 0, checks, errors, external,
      scope: 'production-client-rendering-captured-live-results-through-fixture-bridge',
      sourceLiveRunId: input.runId, sourceLiveSummarySha256: input.sha256,
      liveBrowserNetwork: false, realCredentialsInBrowser: false, desktopVerified: false };
    const recorded = await page.evaluate(async summary => {
      const response = await fetch('/evidence', { method: 'POST', body: JSON.stringify(summary) });
      return { ok: response.ok, message: await response.text() };
    }, summary);
    if (!recorded.ok) throw new Error(recorded.message);
    console.log(JSON.stringify({ runId: run.runId, passed: checks.length, failed: 0 }));
  } catch (error) {
    await page.screenshot({ path: run.directory + '/failed.png', fullPage: true });
    await page.evaluate(summary => fetch('/evidence', { method: 'POST', body: JSON.stringify(summary) }),
      { ...run, checks, errors, external, failed: 1, error: String(error) });
    throw error;
  }
}
