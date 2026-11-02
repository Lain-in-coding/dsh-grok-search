// README 截图：生成的生产 client + 离线合成宿主（fixtures/ui-route-harness）。
// 只用合成 Key，不点击查看/复制，不请求外部服务；不是 Desktop 或付费上游证据。
// 用法：
//   node scripts/ui-route-preview.mjs                      （输出 origin）
//   playwright-cli -s=readme-shots open <origin>/
//   playwright-cli -s=readme-shots run-code --filename=scripts/readme-screenshots.js
// 输出写入新的 artifacts/ui-route-browser/<runId>/，挑选后再复制到 docs/images/。
async page => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  const run = await page.evaluate(async () => (await fetch('/begin', { method: 'POST' })).json());
  const browser = page.context().browser();
  if (!browser) throw new Error('需要非持久化会话，才能创建 2x 截图上下文。');
  const context = await browser.newContext({
    viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: 'light',
  });
  const shot = await context.newPage();
  const errors = [], results = [], files = [];
  shot.on('pageerror', error => errors.push(String(error)));
  const check = (name, actual, expected = true) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, passed, ...(passed ? {} : { actual, expected }) });
    if (!passed) throw new Error(name + ': ' + JSON.stringify({ actual, expected }));
  };
  // 只改夹具宿主页的外框，插件自身的 shadow DOM 样式保持原样。
  const stage = `
    html, body { background: radial-gradient(1200px 600px at 18% 0%, #e8ecff 0%, transparent 60%),
      radial-gradient(900px 600px at 100% 100%, #e6f4f1 0%, transparent 55%), #f3f5f9 !important; }
    body[data-theme=dark], html:has(body[data-theme=dark]) { background: radial-gradient(1200px 600px at 18% 0%, #1d2140 0%, transparent 60%),
      radial-gradient(900px 600px at 100% 100%, #10272a 0%, transparent 55%), #0b0d12 !important; }
    body { padding: 56px 32px !important; }
    main > h1, #outside { display: none !important; }`;
  const open = async (state, theme = 'light') => {
    await shot.goto(origin + '/?state=' + state);
    await shot.addStyleTag({ content: stage });
    await shot.locator('#routeCard[data-s]:not([data-s=load])').waitFor();
    if (theme === 'dark') await shot.evaluate(() => window.harness.theme('dark'));
    await shot.waitForTimeout(500);
  };
  const audit = async label => {
    check(label + ': no key reveal', await shot.evaluate(() => window.harness.state.calls.filter(c => c.method === 'reveal' || c.method === 'copy').length), 0);
    check(label + ': brand images decoded', await shot.evaluate(() => [...document.querySelector('[data-dsg-route]').shadowRoot.querySelectorAll('img')]
      .every(img => img.complete && img.naturalWidth > 0)));
  };
  const capture = async (name, { dialog = false } = {}) => {
    const card = await shot.locator('#routeCard').boundingBox();
    const pad = 44;
    let top = card.y - pad, bottom = card.y + card.height + pad;
    if (dialog) {
      const box = await shot.locator('#dialog').boundingBox();
      top = Math.min(top, box.y - 28); bottom = Math.max(bottom, box.y + box.height + 28);
    }
    const clip = { x: Math.round(card.x - pad), y: Math.max(0, Math.round(top)),
      width: Math.round(card.width + pad * 2), height: Math.round(bottom - Math.max(0, top)) };
    const raw = await shot.screenshot({ clip });
    // 第二遍合成圆角透明外框，便于在 GitHub/npm 浅色与深色页面上显示。
    const frame = await context.newPage();
    await frame.setContent(`<!doctype html><body style="margin:0;background:transparent">
      <div id="f" style="width:${clip.width}px;height:${clip.height}px;border-radius:26px;overflow:hidden">
      <img style="display:block;width:${clip.width}px;height:${clip.height}px" src="data:image/png;base64,${raw.toString('base64')}"></div></body>`);
    await frame.locator('#f img').evaluate(img => img.decode());
    await frame.locator('#f').screenshot({ path: run.directory + '/' + name, omitBackground: true });
    await frame.close();
    files.push({ name, cssWidth: clip.width, cssHeight: clip.height, deviceScaleFactor: 2 });
  };
  try {
    await open('returning');
    check('hero: takeover status', await shot.locator('#statusText').textContent(), '正在接管');
    check('hero: six provider rows', await shot.locator('.row[data-id]').count(), 6);
    await audit('hero');
    await capture('readme-route-light.png');

    await open('backup', 'dark');
    check('dark: sources-only status', await shot.locator('#statusText').textContent(), '补充来源接管');
    check('dark: layer theme', await shot.evaluate(() => document.querySelector('[data-dsg-route]').shadowRoot.querySelector('[data-theme]')?.dataset.theme ?? null), 'dark');
    await audit('dark');
    await capture('readme-sources-only-dark.png');

    for (const [id, title] of [['grok', 'Grok'], ['tavily', 'Tavily']]) {
      await open('returning');
      await shot.locator(`.row[data-id=${id}] .row-main`).click();
      await shot.locator('#dialog').waitFor();
      await shot.waitForTimeout(400);
      check(id + ': dialog title', await shot.locator('#dlgTitle').textContent(), title);
      check(id + ': keys stay hidden', await shot.locator('input[data-k^=key]').evaluateAll(inputs => inputs.every(input => input.value === '')));
      await audit(id + ' dialog');
      await capture(`readme-dialog-${id}.png`, { dialog: true });
    }
    check('no page errors', errors.length, 0);
  } catch (error) {
    results.push({ name: 'readme-screenshots', passed: false, error: String(error) });
  } finally {
    await context.close();
  }
  const summary = { runId: run.runId, scope: 'README screenshots: generated production client + offline synthetic host shim; synthetic keys, no reveal/copy; not Desktop or paid-provider evidence',
    command: 'playwright-cli -s=readme-shots run-code --filename=scripts/readme-screenshots.js',
    passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length,
    pageErrors: errors, files, results };
  const evidence = await page.evaluate(async summary => {
    const response = await fetch('/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) });
    return { ok: response.ok, text: await response.text() };
  }, summary);
  if (!evidence.ok) throw new Error('Evidence write failed: ' + evidence.text);
  return { runId: run.runId, directory: run.directory, passed: summary.passed, failed: summary.failed, files: files.map(file => file.name),
    ...(summary.failed ? { failure: results.filter(item => !item.passed) } : {}) };
}
