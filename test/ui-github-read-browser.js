async page => {
  const run = await page.evaluate(async () => (await fetch('/begin', { method: 'POST' })).json());
  const results = [], errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const check = (name, value) => { results.push({ name, passed: !!value }); if (!value) throw new Error(name); };
  const ready = () => page.locator('#routeCard:not([data-s=load])').waitFor();
  const reset = async () => { await page.evaluate(() => window.harness.reset('fresh')); await ready(); };
  const cancel = async () => { await page.locator('[data-a=cancel]').click(); await page.locator('#overlay').waitFor({ state: 'hidden' }); };
  try {
    await page.setViewportSize({ width: 1366, height: 960 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await reset();
    check('new read consent is off', await page.locator('.row[data-id=github] .switch').getAttribute('aria-checked') === 'false');
    await page.locator('.row[data-id=github] .row-main').click();
    check('opening form grants no read consent', await page.locator('[data-a=enabled]').getAttribute('aria-checked') === 'false');
    check('first enable discloses model and history', (await page.locator('#dialog').textContent()).includes('当前聊天模型')
      && (await page.locator('#dialog').textContent()).includes('会话历史'));
    await page.locator('input[data-k=token]').fill('ghp_transient_preview');
    await page.locator('[data-a=test-github]').click();
    await page.locator('.search-result:has-text("连接成功")').waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.harness.theme(theme), theme);
      check(`${theme} successful draft test uses success color`, await page.locator('.search-result').evaluate(el => {
        const reference = document.createElement('i');
        reference.style.backgroundColor = 'var(--ok-soft)';
        el.appendChild(reference);
        try { return getComputedStyle(el).backgroundColor === getComputedStyle(reference).backgroundColor; }
        finally { reference.remove(); }
      }));
    }
    await page.evaluate(() => window.harness.theme('light'));
    check('draft test does not save or enable', await page.evaluate(() => {
      const state = window.harness.state;
      return !state.content.github_token && state.prefs.value.githubReadEnabled === false
        && !state.calls.some(call => ['save', 'savePreferences'].includes(call.method));
    }));
    check('test leaves form open', await page.locator('#dialog').isVisible());
    await page.evaluate(() => window.harness.configure({ nextGithubError: 'CONFIG_CONFLICT', delay: 300 }));
    await page.locator('[data-a=test-github]').click();
    check('new draft test clears previous success tone', await page.locator('.search-result').getAttribute('data-tone') === 'run');
    await page.locator('.search-result:has-text("CONFIG_CONFLICT")').waitFor();
    check('RPC rejection cannot retain success tone', await page.locator('.search-result').getAttribute('data-tone') === 'err');
    await page.evaluate(() => window.harness.configure({ delay: 0 }));
    await cancel();
    check('cancel discards draft', await page.evaluate(() => !window.harness.state.content.github_token));

    await page.locator('.row[data-id=github] .switch').click();
    check('first outside enable opens consent form', await page.locator('#dialog').isVisible());
    await page.locator('[data-a=save]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    check('anonymous read can be enabled', await page.evaluate(() => window.harness.state.prefs.value.githubReadEnabled
      && !window.harness.state.content.github_token));
    check('old detection preference remains', await page.evaluate(() => window.harness.state.prefs.value.githubEnabled === true));
    check('test button works without search keys or Grok readiness', !await page.locator('#testBtn').isDisabled());
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.locator('.s-end:has-text("GitHub 读取可用")').waitFor();
    check('GitHub success is not search success', (await page.locator('.s-end').textContent()).includes('未测试网页搜索'));
    check('main test selects only enabled GitHub', await page.evaluate(() =>
      window.harness.state.calls.filter(call => call.method === 'diagnoseProvider').every(call => call.request.provider === 'github')));

    await page.locator('.row[data-id=github] .row-main').click();
    await page.evaluate(() => window.harness.configure({ diagnostics: { github: ['HTTP_401'] } }));
    await page.locator('[data-a=test-github]').click();
    await page.locator('.search-result:has-text("HTTP_401")').waitFor();
    check('draft failure remains distinct', await page.locator('.search-result').getAttribute('data-tone') === 'err');
    await page.evaluate(() => window.harness.configure({ delay: 1000 }));
    await page.locator('[data-a=test-github]').click();
    check('duplicate test is disabled while pending', await page.locator('[data-a=test-github]').isDisabled());
    await cancel();
    check('closing cancels preview', await page.evaluate(() => window.harness.state.calls.some(call => call.method === 'cancelDiagnosis')));

    for (const kind of ['failed', 'cancelled', 'running']) {
      await page.evaluate(kind => {
        window.harness.configure({ delay: 0, logs: [{
          id: 'search-log-90', recordType: 'github', q: 'https://github.com/example/project/issues/7',
          kind, served: 'github', at: Date.now(), ms: kind === 'running' ? null : 20,
          reason: kind === 'failed' ? 'GITHUB_AUTH' : '', callsComplete: true, calls: [],
        }] });
        window.harness.refresh();
      }, kind);
      await page.locator('#logCount:has-text("1")').waitFor();
      const row = page.locator('.log-entry');
      await row.locator('.le-chip').filter({ hasText: kind === 'failed' ? '读取失败' : kind === 'cancelled' ? '已取消' : '处理中' }).waitFor();
      if (await row.locator('.le-head').getAttribute('aria-expanded') !== 'true') await row.locator('.le-head').click();
      const note = await row.locator('.lu-columns [data-log-tip]').getAttribute('data-log-tip');
      check(`${kind} read never claims content delivery`, !note.includes('当前内容已交付') && !note.includes('请续读'));
      if (kind === 'cancelled') check('cancelled GitHub endpoint is not shown as successful',
        await row.locator('.lnode[data-node=github]').getAttribute('data-s') !== 'hit');
    }

    await page.evaluate(() => {
      window.harness.configure({ delay: 0, logs: [{
        id: 'search-log-81', recordType: 'github', q: 'https://github.com/example/project/pull/7',
        kind: 'ok', served: 'github', at: Date.now(), ms: 240, segment: 2, cacheHit: true,
        hasMore: true, acquiredComplete: true, apiRequests: 1, reason: '', callsComplete: true,
        resultProviders: ['github'], resultProvidersComplete: true,
        calls: [{ provider: 'github', operation: 'fetch', result: 'ok', code: '', charge: { basis: 'unknown' } }],
      }] });
      window.harness.refresh();
    });
    await page.locator('#logCount:has-text("1")').waitFor();
    await page.locator('.le-chip').filter({ hasText: '可继续读取' }).waitFor();
    check('history title is recent records', (await page.locator('#logTitle').textContent()).includes('最近记录'));
    check('read record shows segment and cache', (await page.locator('.log-entry').textContent()).includes('分段 2')
      && (await page.locator('.log-entry').textContent()).includes('缓存续读'));
    await page.locator('.le-head').click();
    check('record uses approved hub display name and GitHub API route', (await page.locator('#logList .lroute').textContent()).includes('Grok Search Rs')
      && (await page.locator('#logList .lroute').textContent()).includes('GitHub API'));
    check('partial delivery is explicitly resumable', (await page.locator('.le-chip').textContent()).includes('可继续读取'));
    const callsBefore = await page.evaluate(() => window.harness.state.calls.filter(call => ['diagnoseProvider', 'previewGithubConnection', 'testSearch'].includes(call.method)).length);
    await page.locator('[data-log-replay]').click();
    await page.locator('#historyStage [data-history-node=github]').waitFor();
    check('main replay uses approved hub display name', (await page.locator('#historyStage [data-history-node=hub]').textContent()).includes('Grok Search Rs'));
    check('replay does not issue provider requests', callsBefore === await page.evaluate(() =>
      window.harness.state.calls.filter(call => ['diagnoseProvider', 'previewGithubConnection', 'testSearch'].includes(call.method)).length));
    await page.screenshot({ path: run.directory + '/github-read-replay-light.png' });
    await page.evaluate(() => window.harness.theme('dark'));
    await page.screenshot({ path: run.directory + '/github-read-replay-dark.png' });
    check('no browser exceptions', errors.length === 0);
  } catch (failure) {
    if (!results.some(row => row.passed === false)) results.push({ name: 'browser-run', passed: false, error: String(failure) });
    await page.screenshot({ path: run.directory + '/failure.png' });
  }
  const summary = { runId: run.runId, scope: 'generated-client-synthetic-github-030',
    passed: results.filter(row => row.passed).length, failed: results.filter(row => !row.passed).length, results, pageErrors: errors };
  const saved = await page.evaluate(async summary => {
    const response = await fetch('/evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(summary) });
    return { ok: response.ok, body: await response.text() };
  }, summary);
  if (!saved.ok) throw new Error(saved.body);
  if (summary.failed) throw new Error(`GitHub browser regression failed (${summary.failed}); evidence: ${run.runId}`);
  return { runId: run.runId, passed: summary.passed, failed: summary.failed, directory: run.directory,
    failures: results.filter(row => !row.passed) };
}
