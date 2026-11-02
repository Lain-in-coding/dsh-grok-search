async page => {
  const run = await page.evaluate(async () => (await fetch('/begin', { method: 'POST' })).json());
  const results = [], errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const check = (name, actual, expected = true) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, passed: ok, ...(ok ? {} : { actual, expected }) });
    if (!ok) throw new Error(name + ': ' + JSON.stringify({ actual, expected }));
  };
  const state = async name => {
    await page.evaluate(name => window.harness.reset(name), name);
    await page.locator('#routeCard[data-s]:not([data-s=load])').waitFor();
  };
  const read = fn => page.evaluate(fn);
  const close = async () => {
    if (await page.locator('#overlay').isVisible()) await page.locator('[data-a=cancel]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
  };
  const card = async id => { await page.locator(`.row[data-id=${id}] .row-main`).click(); await page.locator('#dialog').waitFor(); };
  const save = async () => {
    await page.locator('[data-a=save]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
  };
  const refresh = async () => { await page.evaluate(() => window.harness.refresh()); };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await state('returning');
    check('six provider rows', await page.locator('.row[data-id]').count(), 6);
    check('one layer host', await page.locator('[data-dsg-layer]').count(), 1);
    check('no global route IDs', await read(() => document.querySelector('#routeCard')), null);
    check('snapshot never reveals keys', await read(() => window.harness.state.calls.filter(call => call.method === 'reveal').length), 0);
    check('all local brand images decode', await read(() => [...document.querySelector('[data-dsg-route]').shadowRoot.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0)));
    check('DSH and official logo differ', await read(() => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      return root.querySelector('[data-logo=dsh]').src !== root.querySelector('[data-logo=deepseek]').src;
    }));
    check('idle keys not falsely green', await page.locator('.s-dot[data-tone=ok]').count(), 0);
    for (const id of ['grok', 'tavily', 'exa', 'tinyfish', 'firecrawl', 'github']) {
      await card(id);
      check(id + ' dialog title', await page.locator('#dlgTitle').textContent(),
        { grok: 'Grok', tavily: 'Tavily', exa: 'Exa', tinyfish: 'TinyFish', firecrawl: 'Firecrawl', github: 'GitHub' }[id]);
      check(id + ' open does not write', await read(() => window.harness.state.calls.filter(c => c.method === 'save').length), 0);
      if (id === 'tinyfish') {
        check('TinyFish outside switch off', await page.locator('.row[data-id=tinyfish] .switch').getAttribute('aria-checked'), 'false');
        check('TinyFish draft switch off until key exists', await page.locator('.head-switch .switch').getAttribute('aria-checked'), 'false');
        await page.locator('input[data-k=key]').fill('tf-synthetic-test');
        check('TinyFish draft lights after key entered', await page.locator('.head-switch .switch').getAttribute('aria-checked'), 'true');
      }
      await close();
    }
    await card('grok');
    check('hidden key is not in input', await page.locator('input[data-k=key]').inputValue(), '');
    await page.locator('[data-a=eye][data-k=key]').click();
    check('explicit reveal called once', await read(() => window.harness.state.calls.filter(c => c.method === 'reveal').length), 1);
    check('revealing does not dirty form', await page.locator('[data-a=save]').isDisabled());
    await page.locator('input[data-k=model]').fill('grok-test-model');
    await save();
    check('model save sends only changed field', await read(() => {
      const call = window.harness.state.calls.filter(c => c.method === 'save').at(-1);
      return Object.keys(call.request.updates);
    }), ['grok_model']);
    check('key preserved on unrelated edit', await read(() => window.harness.state.content.grok_api_key === 'xai-synthetic-key'));
    await page.locator('.t-act').click();
    check('real CAS undo uses history', await read(() => window.harness.state.calls.some(c => c.method === 'restoreConfig')));
    check('history undo removes edited model', await read(() => !Object.hasOwn(window.harness.state.content, 'grok_model')));

    await card('tavily');
    check('Tavily has two key rows', await page.locator('.key-row').count(), 2);
    await page.locator('[data-a=eye][data-k="keys.1"]').click();
    check('Tavily one reveal unlocks all rows', await page.locator('input[data-hidden]').count(), 0);
    check('Tavily reveal still pristine', await page.locator('[data-a=save]').isDisabled());
    await page.locator('[data-a=add-key]').click();
    await page.locator('input[data-k="keys.2"]').fill('tvly-synthetic-3');
    await save();
    check('Tavily key count persisted', await read(() => window.harness.state.content.tavily_api_key.split(',').length), 3);

    await card('exa');
    await page.locator('input[data-k=url]').fill('https://search.example.test');
    await page.evaluate(() => window.harness.configure({ nextSaveError: 'CONFIG_WRITE_FAILED' }));
    await page.locator('[data-a=save]').click();
    await page.locator('.save-error').waitFor();
    check('failed save keeps dialog draft', await page.locator('input[data-k=url]').inputValue(), 'https://search.example.test');
    check('failed save retains error code', await page.locator('.save-error').textContent().then(text => text.includes('CONFIG_WRITE_FAILED')));
    await save();
    check('retry saves retained draft', await read(() => window.harness.state.content.exa_api_url), 'https://search.example.test');

    await card('exa');
    await page.locator('input[data-k=url]').fill('https://other.example.test');
    await page.evaluate(() => window.harness.inject({ exa_api_url: 'https://external.example.test' }));
    await page.locator('[data-a=save]').click();
    await page.locator('.save-error').waitFor();
    check('same-field CAS conflict retained', await page.locator('input[data-k=url]').inputValue(), 'https://other.example.test');
    check('same-field conflict does not overwrite external', await read(() => window.harness.state.content.exa_api_url), 'https://external.example.test');
    await page.locator('[data-a=reload-draft]').click();
    await page.locator('.save-error:has-text("CONFIG_RELOADED")').waitFor();
    check('explicit reload keeps user draft', await page.locator('input[data-k=url]').inputValue(), 'https://other.example.test');
    check('explicit reload itself never writes', await read(() => window.harness.state.content.exa_api_url), 'https://external.example.test');
    await save();
    check('reviewed draft can now save', await read(() => window.harness.state.content.exa_api_url), 'https://other.example.test');

    await state('returning');
    await card('exa');
    await page.locator('input[data-k=url]').fill('https://merge.example.test');
    await page.evaluate(() => window.harness.inject({ response_max_chars: 65000 }));
    await save();
    check('unrelated CAS merge keeps external field', await read(() => window.harness.state.content.response_max_chars), 65000);
    check('unrelated CAS merge saves own field', await read(() => window.harness.state.content.exa_api_url), 'https://merge.example.test');

    await card('grok');
    await page.locator('[data-a=mode][data-v=compat]').click();
    await page.locator('input[data-k=gwUrl]').fill('https://gateway.example.test/v1');
    await page.locator('input[data-k=gwKey]').fill('sk-synthetic-compat');
    await save();
    check('compat mode really removes xAI key', await read(() => !Object.hasOwn(window.harness.state.content, 'grok_api_key')));
    check('compat mode stored gateway key', await read(() => window.harness.state.content.openai_compatible_api_key === 'sk-synthetic-compat'));
    await card('grok');
    check('compat mode readback selected', await page.locator('[data-a=mode][data-v=compat]').getAttribute('aria-checked'), 'true');
    await close();

    await state('returning');
    await page.evaluate(() => window.harness.environment({ exa_api_url: 'https://locked.example.test', exa_api_key: 'synthetic-environment' }));
    await refresh();
    await page.waitForFunction(() => window.harness.state.snapshot.config.fields.exa_api_url.readOnly);
    await card('exa');
    check('environment URL locked', (await page.locator('input[data-k=url]').getAttribute('readonly')) !== null);
    check('environment key explicit reveal allowed', await page.locator('[data-a=eye][data-k=key]').isEnabled());
    await page.locator('[data-a=eye][data-k=key]').click();
    check('environment key remains read only', (await page.locator('input[data-k=key]').getAttribute('readonly')) !== null);
    await close();

    await page.evaluate(() => window.harness.configure({ capabilities: { secretsAllowed: false, transport: 'restricted', reason: '远程 HTTP' } }));
    await refresh();
    await page.locator('.banner:has-text("仅显示脱敏")').waitFor();
    await card('tavily');
    check('restricted connection disables reveal', await page.locator('[data-a=eye]').first().isDisabled());
    check('restricted connection disables copy', await page.locator('[data-a=copy]').first().isDisabled());
    check('restricted connection disables key additions', await page.locator('[data-a=add-key]').isDisabled());
    await close();

    await state('returning');
    await page.evaluate(() => window.harness.inject({ default_extra_sources: 17, response_max_chars: 900000 }));
    await refresh();
    await page.locator('#nodeHub').click();
    check('hub imports out-of-UI-range value', await page.locator('input[data-k=extra]').inputValue(), '17');
    await page.locator('input[data-k=timeout]').fill('65');
    await save();
    check('unrelated hub save tolerates imported value', await read(() => window.harness.state.content.default_extra_sources), 17);
    await page.locator('#nodeHub').click();
    await page.locator('[data-a=adv]').click();
    check('plugin budget read only', (await page.locator('input[data-k=budget]').getAttribute('readonly')) !== null);
    check('plugin executable read only', (await page.locator('input[data-k=exeOverride]').getAttribute('readonly')) !== null);
    await close();

    await state('returning');
    await page.locator('.row[data-id=github] .switch').click();
    check('GitHub toggle never clears token', await read(() => window.harness.state.content.github_token === 'ghp_synthetic'));
    check('GitHub toggle private preference', await read(() => window.harness.state.prefs.value.githubEnabled), false);
    await page.evaluate(() => window.harness.configure({ nextPreferenceError: 'PREFERENCES_BUSY' }));
    await page.locator('.row[data-id=grok] .switch').click();
    await page.locator('.toast:has-text("PREFERENCES_BUSY")').waitFor();
    check('locked preference write preserves real switch', await read(() => window.harness.state.prefs.value.grokEnabled), true);
    check('locked switch UI rolls back', await page.locator('.row[data-id=grok] .switch').getAttribute('aria-checked'), 'true');
    await page.evaluate(() => window.harness.configure({ nextPreferenceError: 'PREFERENCES_COMMIT_UNCERTAIN' }));
    await page.locator('.row[data-id=grok] .switch').click();
    await page.locator('.toast:has-text("PREFERENCES_COMMIT_UNCERTAIN")').waitFor();
    check('uncertain preference commit reads actual saved switch', await read(() => window.harness.state.prefs.value.grokEnabled), false);
    check('uncertain switch UI matches reread', await page.locator('.row[data-id=grok] .switch').getAttribute('aria-checked'), 'false');
    await page.locator('.row[data-id=grok] .switch').click();
    await page.locator('.row[data-id=grok] .switch').click();
    await page.locator('#routeCard[data-s=backup]').waitFor();
    check('Grok off persists sources-only', await read(() => window.harness.state.prefs.value.grokEnabled), false);
    check('Grok off preserves shared credential', await read(() => window.harness.state.content.grok_api_key === 'xai-synthetic-key'));
    await page.locator('.row[data-id=firecrawl] .switch').click();
    check('source switch writes shared config', await read(() => window.harness.state.content.firecrawl_enabled), true);
    await page.locator('.row[data-id=exa] .row-main').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForFunction(() => window.harness.state.content.source_providers?.[0] === 'exa');
    check('keyboard reorder persists same shared chain', await read(() => window.harness.state.content.source_providers[0]), 'exa');
    await page.evaluate(() => window.harness.remount());
    await page.locator('#routeCard[data-s=backup]').waitFor();
    check('remount retains persisted order', await page.locator('#rowsSupp .row').first().getAttribute('data-id'), 'exa');
    check('remount has no duplicate layer', await page.locator('[data-dsg-layer]').count(), 1);
    await state('returning');
    const dragRow = page.locator('.row[data-id=exa] .row-main');
    const dragBox = await dragRow.boundingBox();
    await page.mouse.move(dragBox.x + 55, dragBox.y + dragBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + 55, dragBox.y + dragBox.height / 2 + 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.harness.state.content.source_providers?.[2] === 'exa');
    check('pointer drag saves order without enabling hidden sources', await read(() => window.harness.state.content.source_providers), ['tavily', 'firecrawl', 'exa', 'tinyfish']);
    check('pointer drag preserves disabled Firecrawl', await read(() => window.harness.state.content.firecrawl_enabled), false);

    await state('returning');
    await page.locator('.row[data-id=firecrawl] .switch').click();
    await page.evaluate(() => {
      window.harness.inject({ tinyfish_api_key: 'tf-synthetic', tinyfish_enabled: true });
      window.harness.configure({ delay: 100, diagnostics: { grok: ['grok_auth_error'], tavily: ['HTTP_401', 'OK'], exa: ['OK'], tinyfish: ['HTTP_503'], firecrawl: ['OK'], github: ['OK'] } });
    });
    await refresh();
    await page.waitForFunction(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelector('.row[data-id=tinyfish] .switch').getAttribute('aria-checked') === 'true');
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      return root.querySelector('.s-end')?.textContent.includes('项可用') && !root.querySelector('#testBtn').disabled;
    }, undefined, { timeout: 15000 });
    check('diagnoses all enabled providers including GitHub', await read(() => window.harness.state.calls.filter(c => c.method === 'diagnoseProvider').map(c => c.request.provider)),
      ['grok', 'tavily', 'exa', 'firecrawl', 'tinyfish', 'github']);
    check('partial Tavily key error not whole-source failure', await page.locator('.row[data-id=tavily] .row-fault').getAttribute('data-tone'), 'partial');
    check('real grok code shown without fake HTTP', await page.locator('.row[data-id=grok] .row-fault').textContent().then(text => text.includes('认证')));
    check('silent fallback summary present', await page.locator('.s-end').textContent().then(text => text.includes('已静默回退')));
    check('all keys recorded, not merely first success', await page.locator('.s-node[data-id=tavily] .s-dot').count(), 2);
    check('no duplicate full search spends quota', await read(() => window.harness.state.calls.filter(c => c.method === 'testSearch').length), 0);
    await page.screenshot({ path: run.directory + '/diagnostic-partial-light.png' });
    await page.evaluate(() => window.harness.theme('dark'));
    await page.screenshot({ path: run.directory + '/diagnostic-partial-dark.png' });
    check('dark theme reaches dialog layer', await read(() => document.querySelector('[data-dsg-layer]').shadowRoot.querySelector('.dsg-layer').dataset.theme), 'dark');
    await card('grok');
    await page.locator('[data-a=close]').focus();
    await page.keyboard.press('Shift+Tab');
    check('focus trapped within layer shadow root', await read(() => Boolean(document.querySelector('[data-dsg-layer]').shadowRoot.activeElement?.closest('#dialog'))));
    await close();

    await state('returning');
    await card('exa');
    await page.locator('[data-a=clear]').click();
    await page.locator('[data-a=clear]').click();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    check('clear really removes config credential', await read(() => !Object.hasOwn(window.harness.state.content, 'exa_api_key')));
    await page.locator('.t-act').click();
    check('clear undo restores credential', await read(() => window.harness.state.content.exa_api_key === 'exa-synthetic'));
    await state('fresh');
    check('fresh state waiting not live', await page.locator('#routeCard').getAttribute('data-s'), 'wait');
    await state('off');
    check('off requires verified control completion', await page.locator('#routeCard').getAttribute('data-s'), 'off');
    await page.evaluate(() => window.harness.configure({ control: { routeVerified: false } }));
    await refresh();
    await page.locator('#routeCard[data-s=connecting]').waitFor();
    check('released record alone is not restored UI', await page.locator('#routeCard').getAttribute('data-s'), 'connecting');
    await state('returning');
    await page.evaluate(() => window.harness.configure({ configError: { code: 'CONFIG_PARSE_FAILED', message: '无效 TOML' } }));
    await refresh();
    await page.locator('#routeCard[data-s=cfgerr]').waitFor();
    check('broken config retains file location', await page.locator('#cfgPath').textContent(), '~/.config/grok-search-rs/config.toml');
    await state('returning');
    await page.evaluate(() => window.harness.configure({ diagnostics: { grok: ['EMPTY'], tavily: ['EMPTY', 'EMPTY'], exa: ['EMPTY'] } }));
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.locator('.s-end:has-text("项无结果")').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-dsg-route]').shadowRoot.querySelector('#testBtn').disabled);
    check('empty results are healthy but explicitly no-result', await page.locator('.s-end').textContent().then(text => text.includes('项无结果')));
    check('empty check is not a key failure', await page.locator('.row.has-fault').count(), 0);
    await state('allfail');
    await page.locator('#routeCard[data-s=err]').waitFor();
    check('background all failed cannot imply another key works', await page.locator('#statusText').textContent(), '搜索失败');
    check('provider-level Tavily failure has exact badge', await page.locator('.row[data-id=tavily] .row-fault').textContent().then(text => text.includes('401')));
    check('provider-level failure leaves per-key check unverified', await page.locator('.s-node[data-id=tavily] .s-dot[data-tone=err]').count(), 0);
    await page.evaluate(() => window.harness.configure({ route: { at: Date.now(), origin: 'search', outcome: 'ok',
      served: 'grok-sources', grokCode: 'grok_auth_error', fallbackUsed: true, failures: [] } }));
    await refresh();
    await page.locator('.banner:has-text("Grok 内置补充链")').waitFor();
    check('unidentified MCP fallback does not light arbitrary source', await page.locator('#rowsSupp .row[data-st=live]').count(), 0);
    await state('returning');
    await page.evaluate(() => window.harness.configure({ delay: 2500 }));
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.waitForFunction(() => window.harness.state.calls.some(call => call.method === 'diagnoseProvider'));
    await page.evaluate(() => window.harness.unmount());
    check('unmount dispatches owned cancellation', await read(() => window.harness.state.calls.some(call => call.method === 'cancelDiagnosis')));
    check('cancelling one source stops remaining diagnosis loop', await read(() => window.harness.state.calls.filter(call => call.method === 'diagnoseProvider').length), 1);
    await page.evaluate(() => { window.harness.configure({ delay: 0 }); window.harness.mount(); });
    await page.locator('#routeCard:not([data-s=load])').waitFor();
    check('late cancelled response cannot revive old layer', await page.locator('[data-dsg-layer]').count(), 1);
    await state('returning');
    await page.setViewportSize({ width: 700, height: 900 });
    check('narrow viewport keeps wide topology', await read(() => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot, stage = root.querySelector('#stage');
      return stage.dataset.layout === 'wide' && getComputedStyle(stage).gridTemplateColumns.split(' ').length === 3;
    }));
    check('no host horizontal overflow', await read(() => document.documentElement.scrollWidth <= innerWidth));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await card('tinyfish');
    await close();
    check('reduced motion dialog usable', await page.locator('#overlay').isVisible(), false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => { for (let i = 0; i < 4; i++) window.harness.remount(); });
    await page.locator('#routeCard:not([data-s=load])').waitFor();
    check('repeated mounts keep one layer', await page.locator('[data-dsg-layer]').count(), 1);
    await page.evaluate(() => window.harness.unmount());
    check('unmount removes layer', await page.locator('[data-dsg-layer]').count(), 0);
    check('unmount removes route DOM', await page.locator('#routeCard').count(), 0);
    check('no page errors', errors.length, 0);
  } catch (error) {
    results.push({ name: 'browser-run', passed: false, error: String(error) });
    await page.screenshot({ path: run.directory + '/failure.png' });
  }
  const summary = { runId: run.runId, scope: 'generated production client + offline synthetic host shim; not Desktop or paid-provider evidence',
    command: 'playwright-cli -s=dsg-v74 run-code --filename=test/ui-route-browser.js',
    passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length,
    pageErrors: errors, results };
  const evidence = await page.evaluate(async summary => {
    const response = await fetch('/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) });
    return { ok: response.ok, text: await response.text() };
  }, summary);
  if (!evidence.ok) throw new Error('Evidence write failed: ' + evidence.text);
  return { runId: run.runId, passed: summary.passed, failed: summary.failed, directory: run.directory,
    ...(summary.failed ? { failure: results.filter(result => !result.passed) } : {}) };
}
