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
    check('approved intro has five independently linked official provider logos',
      await page.locator('.intro-source').evaluateAll(links => links.map(link => link.href)),
      ['https://grok.com/', 'https://tavily.com/', 'https://exa.ai/', 'https://firecrawl.dev/', 'https://tinyfish.ai/']);
    check('intro repository link follows the tagline', await page.locator('.intro-title .intro-github').getAttribute('href'),
      'https://github.com/Lain-in-coding/dsh-grok-search');
    const projectLink = page.locator('[data-dsg-project] a');
    const projectTip = page.locator('[data-dsg-project] [role=tooltip]');
    check('one title project badge', await page.locator('[data-dsg-project]').count(), 1);
    check('project badge follows version', await page.locator('.version-tag + #project-badge [data-dsg-project]').count(), 1);
    check('project badge accessible label', await projectLink.getAttribute('aria-label'),
      '打开 dsh-grok-search 的 GitHub 项目首页（新窗口）');
    check('project icon and hit area stay compact', await projectLink.evaluate(link => {
      const icon = link.querySelector('img'), a = link.getBoundingClientRect(), i = icon.getBoundingClientRect();
      return [a.width, a.height, i.width, i.height];
    }), [24, 24, 16, 16]);
    await projectLink.hover();
    await projectTip.waitFor({ state: 'visible' });
    check('project hover tooltip', await projectTip.textContent(), '用着还行？给个star');
    await page.keyboard.press('Escape');
    await projectTip.waitFor({ state: 'hidden' });
    await page.locator('#outside').focus();
    await page.keyboard.press('Shift+Tab');
    check('project link reachable by keyboard', await projectLink.evaluate(link => link.matches(':focus-visible')));
    await projectTip.waitFor({ state: 'visible' });
    check('project focus tooltip', await projectTip.textContent(), '用着还行？给个star');
    const linkBefore = await projectLink.getAttribute('href'), originalPage = page.url();
    await page.context().route('https://github.com/Lain-in-coding/dsh-grok-search', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Project navigation test</title>' }));
    const opened = page.waitForEvent('popup');
    await projectLink.press('Enter');
    const popup = await opened;
    await popup.waitForURL('https://github.com/Lain-in-coding/dsh-grok-search');
    await popup.waitForLoadState('domcontentloaded');
    check('project link opens exact homepage', popup.url(), 'https://github.com/Lain-in-coding/dsh-grok-search');
    check('project navigation has no opener', await popup.evaluate(() => window.opener === null));
    check('project navigation preserves settings page', page.url(), originalPage);
    check('project href stays fixed', linkBefore, popup.url());
    await popup.close();
    // Returning from a noopener popup must not leave the animation suite background-throttled.
    await page.bringToFront();
    const focus = await page.context().newCDPSession(page);
    await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await focus.detach();
    await page.context().unroute('https://github.com/Lain-in-coding/dsh-grok-search');
    const lightLogo = await projectLink.locator('img').getAttribute('src');
    await page.evaluate(() => window.harness.theme('dark'));
    check('project icon adapts to explicit dark theme', await projectLink.locator('img').getAttribute('src') !== lightLogo);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('project icon respects reduced motion', await projectLink.locator('img').evaluate(img =>
      getComputedStyle(img).transitionDuration), '0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      window.harness.theme('light');
      window.harness.subject({ kind: 'bundle', pkg: { name: 'another-plugin' } });
    });
    check('project badge absent on other plugin details', await page.locator('[data-dsg-project]').count(), 0);
    await page.evaluate(() => window.harness.subject({ kind: 'bundle', pkg: { name: 'dsh-grok-search' } }));
    await page.evaluate(() => window.harness.remount());
    check('project badge survives remount without duplicates', await page.locator('[data-dsg-project] a').count(), 1);
    check('project badge keeps one host across remount and StrictMode replay', await page.locator('[data-dsg-project]').count(), 1);
    check('project badge replay keeps one tooltip', await page.locator('[data-dsg-project] [role=tooltip]').count(), 1);
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
    // A redacted key looks identical after another writer rotates it. Never
    // auto-merge a destination edit onto that unreviewed credential revision.
    await card('exa');
    await page.locator('input[data-k=url]').fill('https://merge.example.test');
    await page.evaluate(() => window.harness.inject({ exa_api_key: 'synthetic-concurrent-replacement' }));
    await page.locator('[data-a=save]').click();
    await page.locator('.save-error:has-text("CONFIG_CONFLICT")').waitFor();
    check('endpoint edit cannot silently pair with a concurrently replaced key',
      await read(() => !Object.hasOwn(window.harness.state.content, 'exa_api_url')));
    check('endpoint conflict preserves the draft', await page.locator('input[data-k=url]').inputValue(), 'https://merge.example.test');
    check('endpoint conflict does not retry the secret-bearing destination',
      await read(() => window.harness.state.calls.filter(call => call.method === 'save').length), 1);
    await close();
    await state('returning');
    await card('grok');
    await page.locator('input[data-k=model]').fill('grok-unrelated-merge');
    await page.evaluate(() => window.harness.inject({ response_max_chars: 65000 }));
    await save();
    check('unrelated CAS merge keeps external field', await read(() => window.harness.state.content.response_max_chars), 65000);
    check('unrelated CAS merge still saves a non-destination field', await read(() => window.harness.state.content.grok_model), 'grok-unrelated-merge');

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

    await state('off');
    await page.locator('#nodeOfficial').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      window.harness.configure({ control: { phase: 'incomplete', error: { code: 'CONTROL_TARGET_MISSING', message: 'synthetic' } } });
      window.harness.refresh();
    });
    await page.locator('#routeCard[data-s=ctlerr]').waitFor();
    check('startup or control failure never claims official search restored',
      await page.locator('#nodeOfficial').getAttribute('aria-hidden'), 'true');
    check('control failure remains visible with its actual code', await page.locator('#bannerSlot').textContent().then(text => text.includes('CONTROL_TARGET_MISSING')));
    await state('fresh');
    await card('grok');
    check('protocol selectors use the approved familiar names', await page.locator('.seg button').allTextContents(),
      ['xAI Responses', 'OpenAI 兼容网关']);
    check('Responses title explains transport without excluding custom services', await page.locator('[data-a=mode][data-v=responses]').getAttribute('title'),
      'Responses 接口；支持兼容此协议的自定义服务');
    check('gateway title identifies Chat Completions', await page.locator('[data-a=mode][data-v=compat]').getAttribute('title'),
      'Chat Completions 接口');
    check('Responses placeholder includes official and third-party key examples', await page.locator('input[data-k=key]').getAttribute('placeholder'),
      'xai-.../sk-...');
    check('Responses does not imply official-only routing', await page.locator('.dlg-form').textContent().then(text => text.includes('直连 xAI 官方接口')), false);
    await page.locator('input[data-k=url]').fill('https://responses.example.test');
    await page.locator('input[data-k=key]').fill('sk-synthetic-responses');
    await save();
    check('third-party sk key saves in Responses fields', await read(() => {
      const { grok_api_url, grok_api_key } = window.harness.state.content;
      return grok_api_url === 'https://responses.example.test' && grok_api_key === 'sk-synthetic-responses';
    }));
    await card('grok');
    await page.locator('[data-a=mode][data-v=compat]').click();
    check('Chat Completions URL label is Base URL', await page.locator('label[for=f-gwUrl]').textContent(), 'Base URL');
    check('Chat Completions key label is API Key', await page.locator('label[for=f-gwKey]').textContent(), 'API Key');
    check('protocol switch still warns about shared-config key removal', await page.locator('.seg').locator('..').textContent().then(text =>
      text.includes('共享配置删除') && text.includes('配置历史')));
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
    check('locked key explains the environment source', await page.locator('label[for=f-key]').textContent().then(text => text.includes('环境变量')));
    await close();
    await page.evaluate(() => window.harness.environment({}));
    await refresh();
    await card('exa');
    await page.locator('[data-a=eye][data-k=key]').click();
    check('file-backed existing key is editable after removing test injection', await page.locator('input[data-k=key]').isEditable());
    await page.locator('input[data-k=key]').fill('exa-replaced-after-unlock');
    await save();
    await page.evaluate(() => window.harness.remount());
    await page.locator('#routeCard:not([data-s=load])').waitFor();
    await card('exa');
    await page.locator('[data-a=eye][data-k=key]').click();
    check('replacement key remains editable after settings remount', await page.locator('input[data-k=key]').isEditable());
    check('remount reads the last saved key', await page.locator('input[data-k=key]').inputValue(), 'exa-replaced-after-unlock');
    await close();
    await card('grok');
    check('file-backed Grok key permits both protocols', await page.locator('.seg button:disabled').count(), 0);
    await close();

    await page.evaluate(() => window.harness.configure({ capabilities: { secretsAllowed: false, transport: 'restricted', reason: '远程 HTTP' } }));
    await refresh();
    await page.locator('.banner:has-text("仅显示脱敏")').waitFor();
    await card('tavily');
    check('restricted connection disables reveal', await page.locator('[data-a=eye]').first().isDisabled());
    check('restricted connection disables copy', await page.locator('[data-a=copy]').first().isDisabled());
    check('restricted connection disables key additions', await page.locator('[data-a=add-key]').isDisabled());
    check('restricted connection locks credential destination URL', await page.locator('input[data-k=url]').getAttribute('readonly') !== null);
    await close();
    check('restricted log explains the secure-connection requirement', await page.locator('#logNote').textContent(), '请通过本机直连或 HTTPS 查看搜索日志');
    check('restricted log is not announced as a user clear', await page.locator('#logAnnouncer').textContent() !== '已清空本次会话的搜索记录。');
    check('restricted log polling stays silent', await read(() => new Promise(resolve => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      let changes = 0;
      const observer = new MutationObserver(records => { changes += records.length; });
      observer.observe(root.querySelector('#logAnnouncer'), { childList: true, characterData: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(changes); }, 2700);
    })), 0);

    await state('returning');
    // Before the first snapshot the connection is unknown, not restricted.
    await page.evaluate(() => { window.harness.configure({ delay: 4000 }); window.harness.remount(); });
    check('log before first snapshot waits without a restricted verdict', await read(() => new Promise(resolve => setTimeout(() => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      resolve([root.querySelector('#logNote').textContent, root.querySelector('#logAnnouncer').textContent]);
    }, 2700))), ['仅内存 · 最近 20 条 · 停用或退出 DSH 后清空', '']);
    await page.evaluate(() => window.harness.configure({ delay: 0 }));
    await page.locator('#routeCard[data-s]:not([data-s=load])').waitFor();
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
    // boundingBox() does not wait for the entry animation. Pointer coordinates
    // must target the settled row, not its earlier translated position.
    await page.waitForFunction(() => !document.querySelector('[data-dsg-route]').shadowRoot.querySelector('#rowsSupp .row.enter'));
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
    check('GitHub has its own completed verification icon',
      await page.locator('#strip .s-node[data-id=github]').getAttribute('data-health'), 'ok');
    check('partial Tavily key error not whole-source failure', await page.locator('.row[data-id=tavily] .row-fault').getAttribute('data-tone'), 'partial');
    check('real grok code shown without fake HTTP', await page.locator('.row[data-id=grok] .row-fault').textContent().then(text => text.includes('认证')));
    check('individual diagnosis does not claim actual fallback', await page.locator('.s-end').textContent().then(text =>
      text.includes('Grok 未通过') && text.includes('4/6 项可用') && !text.includes('已静默回退')));
    check('availability status is distinct from observed fallback', await page.locator('#statusText').textContent(), '补充来源可用');
    check('diagnostic banner names all successful supplementary providers', await page.locator('.banner').textContent().then(text =>
      text.includes('Tavily、Exa、Firecrawl 可用') && !text.includes('已静默回退到')));
    check('diagnostic route accessible label does not invent a fallback attempt', await page.locator('#strip').getAttribute('aria-label')
      .then(text => !text?.includes('已尝试静默回退')));
    check('result insertion keeps every route icon aligned without crossing the result text', await page.locator('#strip').evaluate(strip => {
      const children = [...strip.children].map(node => node.getBoundingClientRect());
      return children.every((rect, index) => index === 0 || rect.left >= children[index - 1].right - 1);
    }));
    check('all keys recorded, not merely first success', await page.locator('.s-node[data-id=tavily] .s-dot').count(), 2);
    check('no duplicate full search spends quota', await read(() => window.harness.state.calls.filter(c => c.method === 'testSearch').length), 0);
    await page.screenshot({ path: run.directory + '/diagnostic-partial-light.png' });
    await page.evaluate(() => window.harness.theme('dark'));
    await page.waitForFunction(() => getComputedStyle(
      document.querySelector('[data-dsg-route]').shadowRoot.querySelector('#routeCard')
    ).backgroundColor === 'rgb(22, 24, 28)');
    await page.screenshot({ path: run.directory + '/diagnostic-partial-dark.png' });
    check('dark theme reaches dialog layer', await read(() => document.querySelector('[data-dsg-layer]').shadowRoot.querySelector('.dsg-layer').dataset.theme), 'dark');
    await card('grok');
    check('confirmed authentication error stays beside the key', await page.locator('input[data-k=key]').locator('..').getAttribute('data-health'), 'true');
    check('authentication feedback remains accessible', await page.locator('input[data-k=key]').getAttribute('aria-describedby').then(value => value?.includes('f-key-message')));
    check('authentication error is not duplicated in search summary', await page.locator('.search-result').isVisible(), false);
    await page.locator('[data-a=close]').focus();
    await page.keyboard.press('Shift+Tab');
    check('focus trapped within layer shadow root', await read(() => Boolean(document.querySelector('[data-dsg-layer]').shadowRoot.activeElement?.closest('#dialog'))));
    await close();
    await page.evaluate(() => window.harness.remount());
    await page.locator('#routeCard:not([data-s=load])').waitFor();
    check('remount preserves diagnostic availability without inventing a search route',
      await page.locator('#statusText').textContent(), '补充来源可用');
    check('remount retains accurate diagnostic banner', await page.locator('.banner').textContent().then(text =>
      text.includes('尚未发生实际搜索回退') && !text.includes('已静默回退到')));
    await page.locator('.banner [data-act=grok-off]').click();
    await page.locator('.row[data-id=grok] .switch[aria-checked=false]').waitFor();
    // The switch is optimistic. Do not reset the synthetic server while its
    // delayed preference write can still overwrite the next scenario's data.
    await page.waitForFunction(() => window.harness.state.prefs.value.grokEnabled === false);
    check('turning off failed Grok uses supplementary mode without retaining its test warning',
      await page.locator('#statusText').textContent(), '补充来源接管');
    check('disabled Grok no longer produces the diagnostic failure banner',
      await page.locator('#bannerSlot').textContent().then(text => text.includes('Grok 测试未通过')), false);

    // A test is not a chat search. Exercise the failure-only and no-result
    // combinations with reduced motion, retaining each provider's own result.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const onlyGrok of [true, false]) {
      await state('returning');
      await page.evaluate(onlyGrok => {
        if (onlyGrok) window.harness.inject({ tavily_enabled: false, exa_enabled: false, firecrawl_enabled: false });
        window.harness.configure({ diagnostics: {
          grok: ['grok_timeout'], tavily: ['HTTP_401', 'HTTP_429'], exa: ['HTTP_503'], github: ['OK'],
        } });
        window.harness.refresh();
      }, onlyGrok);
      if (onlyGrok) await page.locator('.row[data-id=tavily] .switch[aria-checked=false]').waitFor();
      await page.locator('#testBtn').click();
      await page.locator('[data-pop=go]').click();
      await page.locator('.s-end:has-text("测试未通过")').waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-dsg-route]').shadowRoot.querySelector('#testBtn').disabled);
      check(`${onlyGrok ? 'Grok-only' : 'all-source'} diagnosis failure is not a chat-search failure`,
        await page.locator('#statusText').textContent(), '最近检查未通过');
      check(`${onlyGrok ? 'Grok-only' : 'all-source'} diagnostic failure retains exact timeout reason`,
        await page.locator('.banner').textContent().then(text =>
          text.includes('grok_timeout') && !text.includes('本次搜索已明确报错') && !text.includes('已静默回退')));
      check(`${onlyGrok ? 'Grok-only' : 'all-source'} checks continue independently and skip closed sources`,
        await read(() => window.harness.state.calls.filter(c => c.method === 'diagnoseProvider').map(c => c.request.provider)),
        onlyGrok ? ['grok', 'github'] : ['grok', 'tavily', 'exa', 'github']);
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    for (const mode of ['responses', 'compat']) {
      for (const code of ['grok_sources_empty', 'grok_provider_error', 'grok_timeout', 'grok_parse_error', 'HTTP_403', 'HTTP_429']) {
        await state('returning');
        await page.evaluate(({ mode, code }) => {
          if (mode === 'compat') window.harness.inject({
            grok_api_key: '', openai_compatible_api_url: 'https://chat.example.test/v1',
            openai_compatible_api_key: 'sk-synthetic-chat', openai_compatible_model: 'grok-test',
          });
          window.harness.configure({ route: { at: Date.now(), origin: 'search', outcome: 'ok',
            served: 'exa', grokCode: code, fallbackUsed: true, failures: [] } });
          window.harness.refresh();
        }, { mode, code });
        await page.locator('.row[data-id=grok] .row-fault').waitFor();
        await card('grok');
        const key = mode === 'compat' ? 'gwKey' : 'key';
        check(`${mode} ${code} appears in the search result area`, await page.locator('.search-result').isVisible());
        check(`${mode} ${code} does not flag the key`, await page.locator(`input[data-k=${key}]`).locator('..').getAttribute('data-health'), 'false');
        check(`${mode} ${code} has no key-specific error text`, await page.locator(`.f-msg[data-msg=${key}]`).isVisible(), false);
        check(`${mode} ${code} summary is announced`, await page.locator('.search-result').getAttribute('role'), 'status');
        if (code === 'grok_sources_empty') {
          check(`${mode} source error says what is missing`, await page.locator('.search-result').textContent().then(text =>
            text.includes('未返回引用链接') && text.includes('来源链接') && !text.includes('没有可核验')));
          check(`${mode} fallback copy is backed by a successful route`, await page.locator('.search-result').textContent().then(text =>
            text.includes('已静默回退')));
          await page.waitForFunction(() => {
            const dialog = document.querySelector('[data-dsg-layer]').shadowRoot.querySelector('#dialog');
            return getComputedStyle(dialog).backgroundColor === 'rgb(22, 24, 28)' && dialog.getAnimations().length === 0;
          });
          await page.screenshot({ path: `${run.directory}/${mode}-source-result-dark.png` });
          await page.evaluate(() => window.harness.theme('light'));
          await page.waitForFunction(() => {
            const layer = document.querySelector('[data-dsg-layer]').shadowRoot;
            return layer.querySelector('.dsg-layer').dataset.theme === 'light'
              && getComputedStyle(layer.querySelector('input[data-k=url], input[data-k=gwUrl]').closest('.input')).backgroundColor === 'rgb(241, 242, 245)';
          });
          await page.screenshot({ path: `${run.directory}/${mode}-source-result-light.png` });
          await page.evaluate(() => window.harness.theme('dark'));
        }
        const model = mode === 'compat' ? 'gwModel' : 'model';
        const previousModel = await page.locator(`input[data-k=${model}]`).inputValue();
        await page.locator(`input[data-k=${model}]`).fill('changed-test-model');
        check(`${mode} ${code} old result clears on model edit`, await page.locator('.search-result').isVisible(), false);
        await page.locator(`input[data-k=${model}]`).fill(previousModel);
        check(`${mode} ${code} original configuration retains its result`, await page.locator('.search-result').isVisible());
        await page.locator(`[data-a=mode][data-v=${mode === 'compat' ? 'responses' : 'compat'}]`).click();
        check(`${mode} ${code} old result does not follow a protocol switch`, await page.locator('.search-result').isVisible(), false);
        await close();
      }
    }

    await state('fallback');
    await card('tavily');
    check('provider-level Tavily 401 does not identify an individual key', await page.locator('input[data-k="keys.0"]').locator('..').getAttribute('data-health'), 'false');
    await close();
    await state('returning');
    await page.evaluate(() => {
      window.harness.configure({ diagnostics: { grok: ['OK'], tavily: ['HTTP_403', 'HTTP_401'], exa: ['OK'], github: ['OK'] } });
    });
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      return root.querySelector('.s-end')?.textContent.includes('项连通') && !root.querySelector('#testBtn').disabled;
    }, undefined, { timeout: 15000 });
    await card('tavily');
    check('Tavily permissions failure is a provider result', await page.locator('.search-result').textContent().then(text => text.includes('Key 1') && text.includes('403')));
    check('Tavily permissions failure does not flag key format', await page.locator('input[data-k="keys.0"]').locator('..').getAttribute('data-health'), 'false');
    check('Tavily 401 still flags only its own key', await page.locator('input[data-k="keys.1"]').locator('..').getAttribute('data-health'), 'true');
    await close();

    await state('returning');
    await page.evaluate(() => window.harness.configure({
      diagnostics: { grok: ['grok_sources_empty'], tavily: ['EMPTY', 'EMPTY'], exa: ['EMPTY'], github: ['OK'] },
    }));
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      return root.querySelector('.s-end')?.textContent.includes('项无结果') && !root.querySelector('#testBtn').disabled;
    }, undefined, { timeout: 15000 });
    await card('grok');
    check('an empty supplemental diagnosis cannot claim successful fallback', await page.locator('.search-result').textContent().then(text =>
      text.includes('未返回引用链接') && !text.includes('已静默回退')));
    check('empty Grok diagnosis is retained as a search result', await page.locator('.search-result').textContent().then(text =>
      text.includes('未返回引用链接')));
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
    await page.evaluate(() => window.harness.configure({ route: { at: Date.now(), origin: 'search', outcome: 'failed',
      served: null, grokCode: 'DISABLED', fallbackUsed: false, code: 'SOURCE_ALL_FAILED',
      failures: [{ provider: 'tavily', code: 'OUTPUT_LIMIT' }] } }));
    await refresh();
    check('output cap error is distinct from invalid key', await page.locator('.row[data-id=tavily] .row-fault').textContent().then(text => text.includes('回复上限过小')));
    await page.evaluate(() => window.harness.configure({ route: { at: Date.now(), origin: 'search', outcome: 'ok',
      served: 'grok-sources', grokCode: 'grok_auth_error', fallbackUsed: true, failures: [] } }));
    await refresh();
    await page.locator('.banner:has-text("来源未报告")').waitFor();
    check('unidentified MCP fallback does not light arbitrary source', await page.locator('#rowsSupp .row[data-st=live]').count(), 0);
    await state('returning');
    await page.evaluate(() => window.harness.configure({ route: { at: Date.now(), origin: 'search', outcome: 'ok',
      served: 'tavily', grokCode: 'grok_sources_empty', fallbackUsed: true, failures: [],
      resultProviders: ['tavily'], resultProvidersComplete: true, provenance: 'source-label' } }));
    await refresh();
    check('reported supplier replaces the generic MCP fallback banner', await page.locator('.banner').textContent()
      .then(text => text.includes('回退到 Tavily') && !text.includes('补充链')));
    check('reported supplier uses its actual route branch', await page.locator('#rowsSupp .row[data-st=live]').getAttribute('data-id'), 'tavily');
    check('MCP result attribution does not certify any individual Tavily key', await page.locator('.s-node[data-id=tavily] .s-dot[data-tone=ok]').count(), 0);
    await state('returning');
    await page.evaluate(() => window.harness.configure({ delay: 2500 }));
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.waitForFunction(() => window.harness.state.calls.some(call => call.method === 'diagnoseProvider'));
    check('running test exposes an enabled stop action', await page.locator('#testBtn').textContent(), '停止测试');
    check('actual elapsed time and source count are visible', await page.locator('#statusText').textContent()
      .then(text => /0\/\d+ · Grok · \d+秒/.test(text)));
    await page.locator('#testBtn').click();
    check('explicit stop sends cancellation', await read(() => window.harness.state.calls.some(call => call.method === 'cancelDiagnosis')));
    check('stopped summary does not claim untested keys failed', await page.locator('.s-end').textContent()
      .then(text => text.includes('已停止') && text.includes('0/')));
    check('stop leaves no active provider animation', await page.locator('.row.is-searching').count(), 0);
    await state('returning');
    await page.evaluate(() => window.harness.configure({ diagnostics: {
      grok: ['GROK_QUEUE_TIMEOUT'], tavily: ['GROK_QUEUE_FULL', 'GROK_QUEUE_FULL'], exa: ['GROK_QUEUE_FULL'], github: ['OK'],
    } }));
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.locator('.s-end:has-text("测试未完成")').waitFor();
    check('queue refusal never marks an untested key as invalid', await page.locator('.s-dot[data-tone=err]').count(), 0);
    check('queue refusal does not claim every key was checked', await page.locator('#announcer').textContent()
      .then(text => text.includes('部分项目未完成') && !text.includes('已检查全部')));
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
    for (const width of [1646, 1366, 1100, 900, 700]) {
      await page.setViewportSize({ width, height: 925 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => window.harness.theme(theme), theme);
        // CSS spacing transitions and wire coordinates must settle together.
        await page.waitForFunction(() => {
          const root = document.querySelector('[data-dsg-route]')?.shadowRoot;
          const stage = root?.querySelector('#stage');
          return stage && !stage.getAnimations().some(animation => animation.playState === 'running');
        });
        check(`route fits actual slot at ${width}px ${theme}`, await read(() => {
          const mount = document.querySelector('[data-dsg-route]'), root = mount.shadowRoot;
          const card = root.querySelector('#routeCard'), log = root.querySelector('#logCard');
          const bounds = mount.getBoundingClientRect();
          const contained = element => {
            if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return true;
            const rect = element.getBoundingClientRect();
            return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
          };
          return [mount, root.querySelector('.dsg-root'), root.querySelector('.route-scroll'), card]
            .every(element => element.scrollWidth <= element.clientWidth + 1)
            && Math.abs(card.getBoundingClientRect().width - log.getBoundingClientRect().width) < 1
            && [...root.querySelectorAll('#routeCard,#stage,.rc-head,.rc-actions,#testBtn,.node,.row,.row .switch,.rc-foot [data-open]')]
              .every(contained)
            && [...root.querySelectorAll('.row-name')].every(element => element.scrollWidth <= element.clientWidth + 1);
        }));
      }
    }
    await page.evaluate(() => {
      window.harness.theme('light');
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      root.querySelector('.banner .b-text code').textContent = 'C:/' + 'long-config-folder/'.repeat(18) + 'config.toml';
      root.querySelector('#cfgPath').textContent = 'C:/' + 'long-config-folder/'.repeat(18) + 'config.toml';
    });
    check('long configuration paths cannot widen or clip the route', await read(() => {
      const mount = document.querySelector('[data-dsg-route]'), root = mount.shadowRoot;
      const card = root.querySelector('#routeCard'), text = root.querySelector('.banner .b-text');
      return card.scrollWidth <= card.clientWidth + 1 && text.scrollWidth <= text.clientWidth + 1;
    }));
    await state('fresh');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      window.harness.inject({ tavily_api_key: 'synthetic-only-tavily' });
      window.harness.configure({ diagnostics: { tavily: ['OK'] } });
      window.harness.refresh();
    });
    await page.locator('.row[data-id=tavily] .switch[aria-checked=true]').waitFor();
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.locator('.s-end:has-text("1/1")').waitFor();
    check('fresh single-source target list excludes never-configured GitHub',
      await read(() => window.harness.state.calls.filter(call => call.method === 'diagnoseProvider').map(call => call.request.provider)), ['tavily']);
    check('unconfigured GitHub has no verification icon', await page.locator('#strip .s-node[data-id=github]').count(), 0);
    await page.evaluate(() => { window.harness.inject({ github_token: 'ghp_synthetic' }); window.harness.refresh(); });
    await page.locator('.row[data-id=github] .switch[aria-checked=true]').waitFor();
    await page.locator('.row[data-id=github] .switch').click();
    await page.locator('.row[data-id=github] .switch[aria-checked=false]').waitFor();
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.locator('.s-end:has-text("1/1")').waitFor();
    check('previously configured but closed GitHub is never requested',
      await read(() => window.harness.state.calls.filter(call => call.method === 'diagnoseProvider' && call.request.provider === 'github').length), 0);
    await page.locator('.row[data-id=github] .switch').click();
    await page.locator('.row[data-id=github] .switch[aria-checked=true]').waitFor();
    await page.evaluate(() => window.harness.configure({ diagnostics: { tavily: ['OK'], github: ['HTTP_403'] } }));
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.locator('.s-end:has-text("1/2")').waitFor();
    check('GitHub failure remains separate from successful search source',
      await page.locator('#strip .s-node[data-id=github]').getAttribute('data-health'), 'err');
    check('GitHub displays its actual failure code',
      await page.locator('.row[data-id=github] .row-fault-code').textContent(), '403');
    check('GitHub failure uses the same broken route state',
      await page.locator('#wires [data-w="hub-github"]').getAttribute('data-ws'), 'broken');
    await state('fresh');
    await page.evaluate(() => {
      window.harness.environment({ tavily_api_key: 'synthetic-env-a' });
      window.harness.refresh();
    });
    await page.locator('.row[data-id=tavily] .switch[aria-checked=true]').waitFor();
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.locator('.s-end:has-text("1/1")').waitFor();
    check('first environment key has a completed verification',
      await page.locator('#strip .s-node[data-id=tavily]').getAttribute('data-health'), 'ok');
    const envBaseline = await read(() => {
      const config = window.harness.state.snapshot.config;
      return { revision: config.revision, identity: config.quotaRevision, fields: config.fields };
    });
    await page.evaluate(() => {
      window.harness.environment({ tavily_api_key: 'synthetic-env-b' });
      window.harness.refresh();
    });
    await page.waitForFunction(() => window.harness.state.calls.filter(call => call.method === 'snapshot').length > 1);
    await page.waitForTimeout(100);
    check('environment-only replacement preserves the file revision',
      await read(() => window.harness.state.snapshot.config.revision), envBaseline.revision);
    check('equal-shaped environment keys keep the same redacted fields',
      await read(() => window.harness.state.snapshot.config.fields), envBaseline.fields);
    check('effective identity changes without revealing key values',
      await page.evaluate(identity => window.harness.state.snapshot.config.quotaRevision !== identity, envBaseline.identity));
    check('environment key replacement invalidates old verification without writing the shared file',
      await page.locator('#strip .s-node[data-id=tavily]').getAttribute('data-health'), 'idle');
    check('environment change clears the completed trace', await page.locator('#strip .s-end').count(), 0);
    await page.locator('#testBtn').click();
    await page.locator('[data-pop=go]').click();
    await page.locator('.s-end:has-text("1/1")').waitFor();
    await page.evaluate(() => {
      window.harness.environment({ tavily_api_key: 'synthetic-env-c' });
      window.harness.remount();
    });
    await page.locator('#routeCard:not([data-s=load])').waitFor();
    check('remount also invalidates remembered results when the environment key changed',
      await page.locator('#strip .s-node[data-id=tavily]').getAttribute('data-health'), 'idle');
    check('environment identity checks never save credentials',
      await read(() => window.harness.state.calls.filter(call => call.method === 'save').length), 0);
    await state('returning');
    await card('exa');
    await page.locator('[data-a=eye][data-k=key]').click();
    await page.locator('input[data-k=key]').fill('synthetic-unsaved-preserved');
    const secretInput = page.locator('input[data-k=key]');
    check('authorized form displays the explicitly revealed draft', await secretInput.getAttribute('type'), 'text');
    await page.evaluate(() => {
      window.harness.configure({ capabilities: { secretsAllowed: false, transport: 'restricted', reason: 'fixture' } });
      window.harness.refresh();
    });
    await page.locator('.banner:has-text("仅显示脱敏")').waitFor();
    check('permission revocation removes secret text from the existing DOM', await secretInput.inputValue(), '');
    check('permission revocation immediately locks the open secret field', await secretInput.getAttribute('readonly') !== null);
    check('permission revocation immediately disables copy', await page.locator('[data-a=copy][data-k=key]').isDisabled());
    check('permission revocation immediately disables reveal', await page.locator('[data-a=eye][data-k=key]').isDisabled());
    await page.evaluate(() => {
      window.harness.configure({ capabilities: { secretsAllowed: true, transport: 'loopback', reason: null } });
      window.harness.refresh();
    });
    await page.waitForFunction(() => !document.querySelector('[data-dsg-layer]').shadowRoot
      .querySelector('[data-a=eye][data-k=key]').disabled);
    check('restoring a safe connection preserves the unsaved draft in password form', await secretInput.inputValue(), 'synthetic-unsaved-preserved');
    check('restoring permission does not automatically reveal plaintext', await secretInput.getAttribute('type'), 'password');
    check('permission changes never save the draft', await read(() => window.harness.state.content.exa_api_key), 'exa-synthetic');
    await close();
    await state('returning');
    await card('exa');
    await page.evaluate(() => window.harness.configure({ revealDelay: 1200 }));
    await page.locator('[data-a=eye][data-k=key]').click();
    await page.evaluate(() => {
      window.harness.configure({ capabilities: { secretsAllowed: false, transport: 'restricted', reason: 'fixture' } });
      window.harness.refresh();
    });
    await page.locator('.banner:has-text("仅显示脱敏")').waitFor();
    await page.evaluate(() => {
      window.harness.configure({ capabilities: { secretsAllowed: true, transport: 'loopback', reason: null } });
      window.harness.refresh();
    });
    await page.waitForTimeout(1350);
    check('old reveal reply cannot populate a dialog even after permission was restored', await secretInput.inputValue(), '');
    check('old reveal reply retains the explicit reveal requirement', await secretInput.getAttribute('data-hidden'), 'true');
    await page.evaluate(() => window.harness.configure({ revealDelay: 0 }));
    await page.locator('[data-a=eye][data-k=key]').click();
    check('fresh reveal remains functional after permission recovery', await secretInput.inputValue(), 'exa-synthetic');
    await close();
    await state('returning');
    await page.evaluate(() => window.harness.configure({ delay: 800,
      openError: { code: 'CONFIG_OPEN_UNAVAILABLE', message: 'Windows 系统打开工具不存在，请复制路径后手动打开。' } }));
    await page.locator('.rc-foot [data-open=file]').click();
    check('file opening exposes busy state', await page.locator('.rc-foot [data-open=file]').getAttribute('aria-busy'), 'true');
    check('folder opening is disabled during an existing open request', await page.locator('.rc-foot [data-open=folder]').isDisabled());
    await page.evaluate(() => window.harness.refresh());
    await page.evaluate(() => {
      const root = document.querySelector('[data-dsg-route]').shadowRoot;
      root.querySelector('.rc-foot [data-open=file]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.getByText('Windows 系统打开工具不存在，请复制路径后手动打开。', { exact: true }).waitFor();
    check('repeated opening clicks send one RPC', await read(() =>
      window.harness.state.calls.filter(call => call.method === 'openConfigLocationWithStatus').length), 1);
    check('open failure retains copy-path fallback', await page.getByRole('button', { name: '复制路径', exact: true }).isVisible());
    check('file open failure restores controls', await page.locator('.rc-foot [data-open=file]').isEnabled());
    check('file opening never changes shared configuration', await read(() =>
      window.harness.state.calls.filter(call => call.method === 'save').length), 0);
    await page.evaluate(() => window.harness.configure({ delay: 0, openError: null }));
    await state('fresh');
    await page.locator('.rc-foot [data-open=folder]').click();
    await page.locator('.rc-foot [data-open=folder]:not([disabled])').waitFor();
    check('opening a folder cannot enable a nonexistent file', await page.locator('.rc-foot [data-open=file]').isDisabled());
    await state('returning');
    await page.evaluate(() => window.harness.configure({ openResult: { opened: true, editor: 'modern', fallbackReason: null } }));
    await page.locator('.rc-foot [data-open=file]').click();
    await page.locator('.rc-foot [data-open=file]:not([disabled])').waitFor();
    check('modern editor success has no fallback notice', await page.getByText('已使用备用文本编辑器打开', { exact: true }).count(), 0);
    await page.evaluate(() => window.harness.configure({ openResult: { opened: true, editor: 'classic', fallbackReason: 'launch-failed' } }));
    await page.locator('.rc-foot [data-open=file]').click();
    await page.getByText('已使用备用文本编辑器打开', { exact: true }).waitFor();
    check('successful fallback shows one short notice', await page.getByText('已使用备用文本编辑器打开', { exact: true }).isVisible());
    await state('returning');
    await page.evaluate(() => window.harness.configure({ openResult: { opened: false, copyOnly: true } }));
    await page.locator('.rc-foot [data-open=file]').click();
    await page.getByText('此页面不能打开宿主文件，请复制路径后在 DSH 所在设备打开。', { exact: true }).waitFor();
    check('remote HTTPS shows host-only path guidance', await page.getByRole('button', { name: '复制路径', exact: true }).isVisible());
    await state('returning');
    await card('tinyfish');
    await close();
    check('reduced motion dialog usable', await page.locator('#overlay').isVisible(), false);
    await state('returning');
    const configurationBeforeRepair = await read(() => JSON.stringify(window.harness.state.content));
    await page.evaluate(() => {
      window.harness.configure({ program: { phase: 'error', program: null, canRepair: true,
        error: { code: 'GROK_CACHE_DAMAGED', message: '程序缓存损坏，请重新准备。' } },
        nextRepairError: 'GROK_DOWNLOAD_HTTP' });
      window.harness.refresh();
    });
    await page.locator('#hubMeta').filter({ hasText: '准备失败' }).waitFor();
    await page.locator('#nodeHub').click();
    const repairButton = page.locator('[data-a=redetect]');
    check('damaged private cache exposes an actual repair action', (await repairButton.textContent()).trim(), '重新准备');
    await page.evaluate(() => window.harness.configure({ delay: 250 }));
    await repairButton.evaluate(button => { button.click(); button.click(); });
    await page.getByText('合成下载服务暂不可用。', { exact: true }).first().waitFor();
    await repairButton.waitFor();
    check('failed repair stays available without leaving the dialog', (await repairButton.textContent()).trim(), '重新准备');
    check('repeated clicks share one repair RPC', await read(() => window.harness.state.calls.filter(call => call.method === 'repairProgram').length), 1);
    await page.evaluate(() => window.harness.configure({ delay: 0 }));
    await repairButton.click();
    await page.waitForFunction(() => document.querySelector('[data-dsg-layer]').shadowRoot
      .querySelector('[data-a=redetect]')?.textContent.trim() === '重新检测');
    check('successful repair restores ready status without restart', await read(() => window.harness.state.snapshot.program.phase), 'ready');
    check('repair does not rewrite shared configuration', await read(() => JSON.stringify(window.harness.state.content)), configurationBeforeRepair);
    check('repair sends no config save', await read(() => window.harness.state.calls.filter(call => call.method === 'save').length), 0);
    await repairButton.click();
    check('healthy program still uses the compatible detection RPC',
      await read(() => window.harness.state.calls.some(call => call.method === 'prepareProgram')));
    await close();
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
    command: 'playwright-cli run-code --filename=test/ui-route-browser.js',
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
