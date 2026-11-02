// README 动态演示：生成的生产 client + 离线合成宿主（fixtures/ui-route-harness）。
// 只用合成 Key，不点击查看/复制，不请求外部服务；不是 Desktop、真实宿主或付费上游证据。
// 用法：node scripts/readme-demos.mjs --chrome <Chrome/Edge/Chromium 可执行文件>
//        [--ffmpeg ffmpeg] [--formats apng,gif,webp] [--dpr 1.25] [--fps 24] [--speed 0.3] [--only test,fallback,first-use,order]
// 截图本身较慢，录制时把页面时间（JS 计时器、rAF、CSS 动画时间线）放慢到 --speed，编码时按原速还原帧时长。
// 输出：新的 artifacts/ui-route-browser/<runId>/demo-*.{png,gif,webp} 与 summary.json；挑选后复制到 docs/images/。
// 临时帧和浏览器 profile 写入脚本自建的系统临时目录，成功后只删除该目录。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { connectRenderer, waitForRenderer } from './lib/renderer-cdp.mjs';
import { project } from './lib/internal-candidate-utils.mjs';

const usage = 'Usage: node scripts/readme-demos.mjs --chrome <path> [--ffmpeg <path>] [--formats apng,gif,webp] [--dpr 1.25] [--fps 24] [--speed 0.3] [--only id,...]';
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--chrome', '--ffmpeg', '--formats', '--dpr', '--fps', '--speed', '--only'].includes(key) || value === undefined) throw new Error(usage);
  options.set(key, value);
}
const chrome = options.get('--chrome');
if (!chrome || !existsSync(chrome)) throw new Error('需要 --chrome 指向本机 Chrome/Edge/Chromium 可执行文件。\n' + usage);
const ffmpeg = options.get('--ffmpeg') ?? 'ffmpeg';
if (spawnSync(ffmpeg, ['-hide_banner', '-version'], { windowsHide: true }).status !== 0) throw new Error('找不到可用的 ffmpeg。');
const formats = (options.get('--formats') ?? 'apng').split(',').map(value => value.trim()).filter(Boolean);
for (const format of formats) if (!['apng', 'gif', 'webp'].includes(format)) throw new Error('Unknown format: ' + format);
const dpr = Number(options.get('--dpr') ?? '1.25');
if (!(dpr >= 1 && dpr <= 2)) throw new Error('--dpr must be between 1 and 2.');
const minFrameMs = 1000 / Number(options.get('--fps') ?? '24');
if (!(minFrameMs >= 16 && minFrameMs <= 200)) throw new Error('--fps must be between 5 and 60.');
const speed = Number(options.get('--speed') ?? '0.3');
if (!(speed >= 0.1 && speed <= 1)) throw new Error('--speed must be between 0.1 and 1.');
const only = options.has('--only') ? new Set(options.get('--only').split(',').map(value => value.trim())) : null;

const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const WIDTH = 1089, PAD = 44, RADIUS = 26;
// 只改夹具宿主页：渐变底、留白、演示光标。插件 shadow DOM 内的样式保持原样。
const STAGE_CSS = `
  html { background: radial-gradient(1100px 560px at 15% 0%, #e7ebff 0%, transparent 62%),
    radial-gradient(900px 560px at 100% 100%, #e3f3ef 0%, transparent 56%), #f2f4f8 !important; }
  body { margin: 0 !important; padding: ${PAD}px ${PAD - 15}px 0 ${PAD}px !important; background: transparent !important; overflow: hidden; }
  main { width: auto !important; max-width: none !important; margin: 0 !important; }
  main > h1, #outside { display: none !important; }
  #demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity .2s; will-change: transform; }
  #demo-cursor.on { opacity: 1; }
  #demo-cursor svg { position: absolute; left: -1px; top: -1px; transform-origin: 1px 1px; transition: transform .12s;
    filter: drop-shadow(0 2px 3px rgba(15, 23, 42, .35)); }
  #demo-cursor.down svg { transform: scale(.86); }
  .demo-ripple { position: fixed; z-index: 2147483646; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
    border: 2px solid rgba(79, 110, 247, .75); background: rgba(79, 110, 247, .16); pointer-events: none; animation: demo-ripple .55s ease-out forwards; }
  @keyframes demo-ripple { from { transform: scale(.35); opacity: 1; } to { transform: scale(1.35); opacity: 0; } }`;

// 在页面脚本运行前统一放慢 JS 时间；CSS/WAAPI 动画另由 Animation.setPlaybackRate 放慢同一倍数。
function timeShim(rate) {
  const now = performance.now.bind(performance), origin = now(), dateNow = Date.now.bind(Date), dateOrigin = dateNow();
  const timeout = window.setTimeout.bind(window), frame = window.requestAnimationFrame.bind(window);
  performance.now = () => origin + (now() - origin) * rate;
  Date.now = () => Math.round(dateOrigin + (dateNow() - dateOrigin) * rate);
  window.setTimeout = (handler, delay = 0, ...args) => timeout(handler, Math.max(0, Number(delay) || 0) / rate, ...args);
  // 不换算原生帧时间戳：它可能已随动画时间线放慢，再换算会被放慢两次。
  window.requestAnimationFrame = callback => frame(() => callback(performance.now()));
}

function pageHelpers(css) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M1 1v18.4l4.6-4.4 3.1 7.1 3-1.3-3.1-7h6.4z" fill="#fff" stroke="#111827" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  document.body.append(cursor);
  const place = (x, y) => { cursor.style.transform = `translate(${x}px, ${y}px)`; };
  addEventListener('pointermove', event => place(event.clientX, event.clientY), true);
  addEventListener('pointerdown', event => {
    cursor.classList.add('down');
    const ring = document.createElement('div');
    ring.className = 'demo-ripple';
    ring.style.left = event.clientX + 'px';
    ring.style.top = event.clientY + 'px';
    document.body.append(ring);
    setTimeout(() => ring.remove(), 650);
  }, true);
  addEventListener('pointerup', () => cursor.classList.remove('down'), true);
  const route = () => document.querySelector('[data-dsg-route]')?.shadowRoot;
  const roots = () => [document.querySelector('[data-dsg-layer]')?.shadowRoot, route(), document].filter(Boolean);
  const demo = window.__demo = {
    maxCard: 0,
    show(x, y) { place(x, y); cursor.classList.add('on'); return true; },
    q(selector) { for (const root of roots()) { const node = root.querySelector(selector); if (node) return node; } return null; },
    box(selector) {
      const node = demo.q(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    },
    status() { return route()?.querySelector('#statusText')?.textContent ?? null; },
    testing() { const button = route()?.querySelector('#testBtn'); return Boolean(button?.disabled || button?.querySelector('.spin')); },
    overlayHidden() { const overlay = demo.q('#overlay'); return !overlay || overlay.hidden || getComputedStyle(overlay).display === 'none'; },
    sensitiveCalls() { return window.harness.state.calls.filter(call => call.method === 'reveal' || call.method === 'copy').length; },
    resetMax() { demo.maxCard = card.getBoundingClientRect().height; return demo.maxCard; },
  };
  const card = route().querySelector('#routeCard');
  new ResizeObserver(() => { demo.maxCard = Math.max(demo.maxCard, card.getBoundingClientRect().height); }).observe(card);
  return true;
}

const preview = spawn(process.execPath, [join(project, 'scripts/ui-route-preview.mjs')], { cwd: project, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
const info = await new Promise((done, fail) => {
  let text = '';
  const timer = setTimeout(() => fail(new Error('Preview server did not start.')), 15000);
  preview.stdout.on('data', chunk => {
    text += chunk;
    if (!text.includes('\n')) return;
    clearTimeout(timer);
    try { done(JSON.parse(text.split('\n')[0])); } catch (error) { fail(error); }
  });
  preview.once('exit', code => { clearTimeout(timer); fail(new Error('Preview server exited: ' + code)); });
});
const scratch = mkdtempSync(join(tmpdir(), 'dsh-readme-demos-'));
const profile = join(scratch, 'profile');
// 缩放比直接交给浏览器窗口：仿真 deviceScaleFactor 会在并发截图时把鼠标坐标按错误比例换算。
const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--force-device-scale-factor=${dpr}`, '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--hide-scrollbars',
  '--mute-audio', '--force-color-profile=srgb', '--window-size=1280,1000', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const browserExit = new Promise(done => browser.once('exit', done));

let renderer, succeeded = false;
const report = { runId: info.runId, scope: 'README animated demos: generated production client + offline synthetic host shim; synthetic keys, no reveal/copy; demo cursor injected in host page only; page time slowed during capture and restored at encode; not Desktop, real host or paid-provider evidence',
  command: `node scripts/readme-demos.mjs --chrome <browser> --formats ${formats.join(',')} --dpr ${dpr} --speed ${speed}`, dpr, speed, width: WIDTH, scenarios: [] };
try {
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  let port = 0;
  while (!port) {
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0;
    if (!port) { if (Date.now() > deadline) throw new Error('Chrome did not expose DevTools.'); await sleep(100); }
  }
  renderer = await connectRenderer(port);
  const { send, evaluate } = renderer;
  await send('Page.enable');
  await send('Animation.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'prefers-color-scheme', value: 'light' }] });
  const call = (fn, ...args) => evaluate(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`);
  // S = 实际耗时 / 页面耗时。演示脚本里的时长都按页面时间书写。
  let S = 1, shimId = null;
  const pause = milliseconds => sleep(milliseconds * S);
  const until = (expression, timeoutMs = 15000) => waitForRenderer(renderer, () => evaluate(expression), { timeoutMs: timeoutMs * S, intervalMs: 60 });

  let pointer = { x: 0, y: 0 }, buttons = 0;
  let viewportHeight = 1000;
  const rest = () => ({ x: 210, y: viewportHeight - 130 });
  const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: buttons ? 'left' : 'none', buttons, pointerType: 'mouse' });
  const press = async down => {
    buttons = down ? 1 : 0;
    await send('Input.dispatchMouseEvent', { type: down ? 'mousePressed' : 'mouseReleased', x: pointer.x, y: pointer.y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse' });
  };
  // 按实际流逝时间插值：录制时鼠标事件会排在截图后面，按步数推进会让移动比设定慢。
  const glide = async (from, to, duration) => {
    const total = duration * S, started = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - started) / total), e = ease(t);
      pointer = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      await mouse('mouseMoved', pointer.x, pointer.y);
      if (t >= 1) return;
      await sleep(12);
    }
  };
  const moveTo = (x, y, duration = 650) => glide({ ...pointer }, { x, y }, duration);
  const box = async selector => {
    const value = await evaluate(`window.__demo.box(${JSON.stringify(selector)})`);
    if (!value) throw new Error('Element not found: ' + selector);
    return value;
  };
  const show = async (x, y) => { pointer = { x, y }; await evaluate(`window.__demo.show(${x}, ${y})`); await mouse('mouseMoved', x, y); };
  const click = async (selector, { dx = .5, dy = .5, duration = 650, settle = 150 } = {}) => {
    const target = await box(selector);
    await moveTo(target.x + target.w * dx, target.y + target.h * dy, duration);
    await pause(settle);
    await press(true); await pause(90); await press(false);
  };
  const type = async (text, delay = 45) => { for (const character of text) { await send('Input.insertText', { text: character }); await pause(delay); } };
  const drag = async (selector, dy, { dx = 55 } = {}) => {
    const target = await box(selector);
    await moveTo(target.x + dx, target.y + target.h / 2, 650);
    await pause(180);
    await press(true);
    await pause(160);
    await glide({ ...pointer }, { x: pointer.x, y: pointer.y + dy }, 760);
    await pause(180);
    await press(false);
  };
  const waitTest = async () => {
    await until('window.__demo.testing()', 3000);
    await until('!window.__demo.testing()', 25000);
  };
  const prepareSources = (codes, delay) => call((codes, delay) => {
    window.harness.inject({ tinyfish_api_key: 'tf-demo-1', tinyfish_enabled: true, firecrawl_enabled: true });
    window.harness.configure({ delay, diagnostics: codes });
    window.harness.refresh();
    return true;
  }, codes, delay);
  const allSourcesOn = `['tinyfish', 'firecrawl'].every(id => window.__demo.q('.row[data-id=' + id + '] .switch')?.getAttribute('aria-checked') === 'true')`;
  const dismissRead = () => evaluate(`(window.__demo.q('[data-act=dismiss-read]')?.click(), true)`);

  const scenarios = [
    { id: 'test', title: '测试搜索：逐一检查全部来源', state: 'returning',
      async setup() {
        await prepareSources({ grok: ['OK'], tavily: ['OK', 'OK'], exa: ['OK'], tinyfish: ['OK'], firecrawl: ['OK'], github: ['OK'] }, 260);
        await until(allSourcesOn); await dismissRead();
      },
      async steps() {
        await pause(500); await click('#testBtn'); await pause(800);
        await click('[data-pop=go]', { duration: 450 }); await waitTest();
        await moveTo(rest().x, rest().y, 700); await pause(2000);
      },
      verify: `({ status: window.__demo.status(), faults: document.querySelector('[data-dsg-route]').shadowRoot.querySelectorAll('.row.has-fault').length })`,
      expect: value => value.status === '正在接管' && value.faults === 0 },
    { id: 'fallback', title: '主搜索失败：静默回退与逐 Key 结果', state: 'returning',
      async setup() {
        await prepareSources({ grok: ['grok_auth_error'], tavily: ['HTTP_401', 'OK'], exa: ['OK'], tinyfish: ['OK'], firecrawl: ['OK'], github: ['OK'] }, 260);
        await until(allSourcesOn); await dismissRead();
      },
      async steps() {
        await pause(500); await click('#testBtn'); await pause(800);
        await click('[data-pop=go]', { duration: 450 }); await waitTest();
        await moveTo(rest().x, rest().y, 700); await pause(2600);
      },
      verify: `({ status: window.__demo.status(), summary: document.querySelector('[data-dsg-route]').shadowRoot.querySelector('.s-end')?.textContent ?? null })`,
      expect: value => String(value.summary).includes('已静默回退') },
    { id: 'first-use', title: '首次使用：填 Key 保存即接管', state: 'fresh',
      async setup() { await until(`window.__demo.status() === '等待配置'`); },
      async steps() {
        await pause(600); await click('.row[data-id=grok] .row-main');
        await until(`Boolean(window.__demo.q('#dialog')) && !window.__demo.overlayHidden()`); await pause(650);
        await click('input[data-k=key]', { dx: .3 }); await pause(250);
        await type('xai-demo-7f3a92c41b6e58d0a7'); await pause(600);
        await click('[data-a=save]', { duration: 550 });
        await until('window.__demo.overlayHidden()', 8000);
        await until(`window.__demo.status() === '正在接管'`, 8000);
        await moveTo(rest().x, rest().y, 700); await pause(2200);
      },
      verify: `({ status: window.__demo.status(), grokKey: Boolean(window.harness.state.content.grok_api_key) })`,
      expect: value => value.status === '正在接管' && value.grokKey },
    { id: 'order', title: '拖动排序与关闭 Grok 主搜索', state: 'returning',
      async setup() { await dismissRead(); },
      async steps() {
        await pause(500);
        const tavily = await box('.row[data-id=tavily] .row-main'), exa = await box('.row[data-id=exa] .row-main');
        await drag('.row[data-id=exa] .row-main', tavily.y - exa.y - 6);
        await until(`window.harness.state.content.source_providers?.[0] === 'exa'`, 6000); await pause(1000);
        await click('.row[data-id=grok] .switch'); await until(`window.__demo.status() === '补充来源接管'`, 6000); await pause(1700);
        await click('.row[data-id=grok] .switch'); await until(`window.__demo.status() === '正在接管'`, 6000);
        await moveTo(rest().x, rest().y, 700); await pause(1800);
      },
      verify: `({ status: window.__demo.status(), order: window.harness.state.content.source_providers, grokEnabled: window.harness.state.prefs.value.grokEnabled })`,
      expect: value => value.status === '正在接管' && value.order?.[0] === 'exa' && value.grokEnabled === true },
  ].filter(scenario => !only || only.has(scenario.id));

  const load = async (state, height, rate = 1) => {
    viewportHeight = height;
    if (shimId) { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: shimId }); shimId = null; }
    if (rate !== 1) shimId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${timeShim.toString()})(${rate})` })).identifier;
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height, deviceScaleFactor: 0, mobile: false });
    await evaluate('(window.__demoStale = true)').catch(() => {});
    await send('Page.navigate', { url: info.origin + '/?state=' + state });
    await send('Animation.setPlaybackRate', { playbackRate: rate });
    S = 1 / rate;
    await until(`!window.__demoStale && Boolean(window.harness && document.querySelector('[data-dsg-route]')?.shadowRoot?.querySelector('#routeCard[data-s]:not([data-s=load])'))`);
    const ratio = await evaluate('window.devicePixelRatio');
    if (Math.abs(ratio - dpr) > 0.01) throw new Error(`devicePixelRatio ${ratio} != ${dpr}`);
    // 实测页面时间、CSS 动画时间线与帧时间都按同一倍数前进，否则拒绝录制。
    // 页面刚加载时首帧可能晚到，先等探针动画和首帧就绪再开始计时。
    await evaluate(`(async () => { const a = document.body.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 600000 });
      await a.ready; const r = await new Promise(done => requestAnimationFrame(done));
      window.__demoProbe = { a, t: performance.now(), c: a.currentTime, r }; return true; })()`);
    const clockStart = performance.now();
    await sleep(800);
    const measured = await evaluate(`(async () => { const p = window.__demoProbe; const r = await new Promise(done => requestAnimationFrame(done));
      const v = { js: performance.now() - p.t, css: p.a.currentTime - p.c, raf: r - p.r }; p.a.cancel(); return v; })()`);
    const elapsed = performance.now() - clockStart;
    if (['js', 'css', 'raf'].some(key => Math.abs(measured[key] / elapsed - rate) > 0.15)) {
      throw new Error('Page time dilation mismatch: ' + JSON.stringify({ rate, elapsed, ...measured }));
    }
    await call(pageHelpers, STAGE_CSS);
    await pause(450);
  };

  for (const scenario of scenarios) {
    // 第一遍只测量卡片最大高度，第二遍按“卡片 + 上下留白”设定视口，使对话框遮罩和提示条落在画面内。
    await load(scenario.state, 1000);
    await scenario.setup();
    await sleep(450);
    await evaluate('window.__demo.resetMax()');
    await show(rest().x, rest().y);
    await scenario.steps();
    const height = Math.ceil(PAD + await evaluate('window.__demo.maxCard') + PAD);

    await load(scenario.state, height, speed);
    await scenario.setup();
    await pause(350);
    await show(rest().x, rest().y);
    await pause(250);
    const directory = join(scratch, scenario.id);
    mkdirSync(directory);
    const frames = [];
    let active = true, captures = 0;
    const loop = (async () => {
      while (active) {
        const started = performance.now();
        const { data } = await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
        captures++;
        const at = (started + performance.now()) / 2;
        const hash = createHash('sha1').update(data).digest('hex');
        if (frames.at(-1)?.hash !== hash) {
          const file = 'f' + String(frames.length).padStart(5, '0') + '.png';
          writeFileSync(join(directory, file), Buffer.from(data, 'base64'));
          frames.push({ hash, file, at });
        }
        const wait = minFrameMs * S - (performance.now() - started);
        if (wait > 0) await sleep(wait);
      }
    })();
    const startedAt = performance.now();
    await scenario.steps();
    active = false;
    await loop;
    const endedAt = performance.now();
    const verify = await evaluate(scenario.verify);
    const expected = scenario.expect(verify);
    const sensitiveCalls = await evaluate('window.__demo.sensitiveCalls()');

    const firstFrame = readFileSync(join(directory, frames[0].file));
    const pixelWidth = firstFrame.readUInt32BE(16), pixelHeight = firstFrame.readUInt32BE(20);
    const lines = ['ffconcat version 1.0'];
    frames.forEach((frame, index) => {
      const next = index + 1 < frames.length ? frames[index + 1].at : endedAt;
      lines.push(`file '${frame.file}'`, `duration ${(Math.max(20, (next - frame.at) / S) / 1000).toFixed(3)}`);
    });
    lines.push(`file '${frames.at(-1).file}'`);
    writeFileSync(join(directory, 'frames.ffconcat'), lines.join('\n') + '\n');
    const run = args => {
      const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: directory, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== 0) throw new Error('ffmpeg failed: ' + String(result.stderr).slice(-1500));
    };
    const r = Math.round(RADIUS * dpr);
    const edge = (v, size) => `max(max(${r}-${v}-0.5\\,${v}+0.5-(${size}-${r}))\\,0)`;
    run(['-f', 'lavfi', '-i', `color=c=white:s=${pixelWidth}x${pixelHeight}`, '-frames:v', '1',
      '-vf', `format=gray,geq=lum=255*clip(${r}+0.5-hypot(${edge('X', 'W')}\\,${edge('Y', 'H')})\\,0\\,1)`, 'mask.png']);
    const inputs = ['-f', 'concat', '-safe', '0', '-i', 'frames.ffconcat', '-i', 'mask.png'];
    const merge = '[0:v]format=rgba[c];[1:v]format=gray[m];[c][m]alphamerge';
    const outputs = [];
    for (const format of formats) {
      const file = join(info.directory, `demo-${scenario.id}.${format === 'apng' ? 'png' : format}`);
      if (format === 'apng') run([...inputs, '-filter_complex', merge + ',format=rgba[a]', '-map', '[a]', '-fps_mode', 'passthrough',
        '-c:v', 'apng', '-pred', 'mixed', '-plays', '0', '-f', 'apng', file]);
      if (format === 'webp') run([...inputs, '-filter_complex', merge + ',format=bgra[a]', '-map', '[a]', '-fps_mode', 'passthrough',
        '-c:v', 'libwebp_anim', '-lossless', '1', '-compression_level', '6', '-quality', '100', '-loop', '0', file]);
      if (format === 'gif') {
        run([...inputs, '-filter_complex', merge + ',palettegen=reserve_transparent=1:stats_mode=full', '-frames:v', '1', 'palette.png']);
        run([...inputs, '-i', 'palette.png', '-filter_complex', merge + '[a];[a][2:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle:alpha_threshold=128',
          '-fps_mode', 'passthrough', '-loop', '0', file]);
      }
      outputs.push({ format, file: basename(file), bytes: statSync(file).size });
    }
    report.scenarios.push({ id: scenario.id, title: scenario.title, state: scenario.state, viewport: { width: WIDTH, height },
      pixels: { width: pixelWidth, height: pixelHeight }, captures, uniqueFrames: frames.length,
      durationMs: Math.round((endedAt - startedAt) / S), effectiveFps: Number((captures / ((endedAt - startedAt) / S / 1000)).toFixed(1)),
      sensitiveCalls, verify, expected, outputs });
    console.log(JSON.stringify(report.scenarios.at(-1)));
  }
  report.pageErrors = renderer.exceptions.map(item => item.description ?? item.text);
  report.passed = report.scenarios.every(item => item.sensitiveCalls === 0 && item.expected) && report.pageErrors.length === 0;
  const response = await fetch(info.origin + '/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
  if (!response.ok) throw new Error('Evidence write failed: ' + await response.text());
  succeeded = report.passed;
  console.log(JSON.stringify({ runId: info.runId, directory: info.directory, passed: report.passed, pageErrors: report.pageErrors.length }));
} finally {
  renderer?.close();
  browser.kill();
  await Promise.race([browserExit, sleep(5000)]);
  preview.kill();
  const root = resolve(tmpdir()), target = resolve(scratch);
  if (succeeded && target.startsWith(root + sep) && basename(target).startsWith('dsh-readme-demos-')) {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } else if (!succeeded) console.error('临时帧保留在：' + target);
}
if (!succeeded) process.exitCode = 1;
