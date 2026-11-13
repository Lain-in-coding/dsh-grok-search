async page => {
  const checks = [], errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const check = (name, value) => { checks.push({ name, passed: value === true }); if (value !== true) throw new Error(name); };
  if (await page.evaluate(() => Boolean(window.harness))) {
    const state = async name => {
      await page.evaluate(name => window.harness.reset(name), name);
      await page.locator('#routeCard:not([data-s=load])').waitFor();
    };
    await state('fresh');
    check('six source rows on first installation', await page.locator('.row').count() === 6);
    check('no configured source was secretly diagnosed', await page.evaluate(() =>
      !window.harness.state.calls.some(row => row.method === 'diagnoseProvider')));
    await page.locator('.row[data-id=tavily] .row-main').click();
    await page.locator('#dialog').waitFor();
    check('quota heading is visible without a key', await page.locator('#quotaTitle').textContent() === '账户额度');
    check('empty quota does not report zero', (await page.locator('#quotaPanel').textContent()).includes('填写 API Key'));
    await page.locator('input[data-k="keys.0"]').fill('smoke-draft-key');
    await page.locator('[data-a=quota-refresh]').click();
    await page.waitForFunction(() => window.harness.state.calls.some(row => row.method === 'previewAccountQuota'));
    await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    check('cancel did not persist draft', await page.evaluate(() => !window.harness.state.content.tavily_api_key));
    await state('stop-failed');
    await page.evaluate(() => window.harness.configure({ delay: 200, releaseError: 'CONTROL_ROUTE_COUNTER_REQUIRED' }));
    await page.locator('[data-act=retry-control]').click();
    check('release retry disables duplicate submission', await page.locator('[data-act=retry-control]').isDisabled());
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-dsg-route]')?.shadowRoot;
      return root?.querySelector('[data-act=retry-control]')?.disabled === false;
    });
    check('failed retry retains the real error', await page.evaluate(() =>
      window.harness.state.snapshot.control.error.code === 'CONTROL_ROUTE_COUNTER_REQUIRED'));
    await page.evaluate(() => window.harness.configure({ releaseError: null }));
    await page.locator('[data-act=retry-control]').click();
    await page.waitForFunction(() => window.harness.state.snapshot.control.phase === 'released');
    check('one call per deliberate retry', await page.evaluate(() =>
      window.harness.state.calls.filter(row => row.method === 'retryControlRelease').length === 2));
    await state('control-failed');
    await page.locator('[data-act=retry-control]').click();
    await page.waitForFunction(() => window.harness.state.calls.some(row => row.method === 'retryControlRelease'));
    check('other control errors cannot create a stop intent', await page.evaluate(() =>
      window.harness.state.snapshot.control.policy === 'required'));
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.harness.theme(theme), theme);
      check(`${theme} route theme`, await page.locator('.dsg-root').getAttribute('data-theme') === theme);
    }
    await page.evaluate(() => { window.harness.remount(); window.harness.remount(); });
    check('repeated mounts retain one overlay', await page.locator('[data-dsg-layer]').count() === 1);
    await page.evaluate(() => window.harness.unmount());
    check('unmount clears layer', await page.locator('[data-dsg-layer]').count() === 0);
  } else {
    check('host React version fixture', await page.evaluate(() => window.__dsgChatReady.react === '18.3.1'));
    for (const scene of ['success', 'lastsuccess', 'allfail']) {
      await page.evaluate(scene => window.__dsgChatFixture.show(scene), scene);
      await page.locator('.dsg-chat').waitFor();
      if (await page.locator('.search-card').getAttribute('data-open') !== 'true') await page.locator('.card-toggle').click();
      await page.locator('.provider-steps').waitFor();
      check(`${scene} title is unchanged`, (await page.locator('.dsg-chat').textContent()).includes('dsh-grok-search'));
      check(`${scene} route retains kernel name`, (await page.locator('.flow-scroll').textContent()).includes('Grok Search Rs'));
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        check(`${scene} stays horizontal at ${width}`, await page.locator('.provider-steps').first().evaluate(el =>
          getComputedStyle(el).flexDirection !== 'column'));
      }
    }
    await page.evaluate(() => window.__dsgChatFixture.dispose());
    check('chat unmount completes', await page.locator('.dsg-chat').count() === 0);
  }
  check('no runtime exceptions', errors.length === 0);
  return { passed: checks.filter(row => row.passed).length, failed: 0, checks, errors };
}
