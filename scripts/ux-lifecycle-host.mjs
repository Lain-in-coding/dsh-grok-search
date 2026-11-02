import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freshRun, project, sha256, writeJson } from './lib/internal-candidate-utils.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--runtime-root') throw new Error('Usage: node scripts/ux-lifecycle-host.mjs --runtime-root <installed-dsh-root>');
const runtime = resolve(args[1]);
const { runId, directory } = freshRun('ux-lifecycle-host');
const isolated = mkdtempSync(join(tmpdir(), 'dsh-ux-lifecycle-'));
const profile = join(isolated, 'profile');
const modules = join(profile, 'node_modules');
const staged = join(modules, 'dsh-grok-search');
const productVersion = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
mkdirSync(staged, { recursive: true });
for (const file of ['package.json', 'cordis.patch.yml', 'src']) cpSync(join(project, file), join(staged, file), { recursive: true, errorOnExist: true });
symlinkSync(join(runtime, 'node_modules', '@deepseek-ai'), join(modules, '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir');
// The product's own runtime dependencies (MCP client, TOML parser) are what a
// real pnpm install provides; link the already-installed exact copies.
for (const name of readdirSync(join(project, 'node_modules'))) {
  if (name.startsWith('.') || name === '@deepseek-ai') continue;
  symlinkSync(join(project, 'node_modules', name), join(modules, name), process.platform === 'win32' ? 'junction' : 'dir');
}
const importHost = name => import(pathToFileURL(join(runtime, 'node_modules', '@deepseek-ai', name, 'lib/index.js')));
const [{ Context }, { Loader }] = await Promise.all([importHost('cordis'), importHost('cordis-plugin-loader')]);
const ctx = new Context();
const observations = [];
const failures = [];
const checks = [];
const record = (label, value) => {
  checks.push(label);
  observations.push({ label, ...value });
};
let loader;
try {
  const profileContext = { dir: profile, home: isolated, installAnchor: join(runtime, 'package.json'),
    patchPath: join(profile, 'cordis.patch.yml'), overlays: [] };
  const saveSelection = enabled => writeFileSync(join(profile, 'package.json'), JSON.stringify({
    private: true, type: 'module', dependencies: { 'dsh-grok-search': productVersion },
    dsh: { profile: { bundles: enabled ? ['dsh-grok-search'] : [] } },
  }, null, 2));
  saveSelection(true);
  writeFileSync(profileContext.patchPath, '[]\n');
  ctx.provide('profileContext', profileContext);
  ctx.on('internal/dispatch', (_kind, event, values) => {
    if (event === 'logger/message' && values?.[0]?.level === 'error') failures.push(values[0]);
  });
  await ctx.plugin(Loader);
  loader = ctx.loader;
  const settle = async () => {
    for (let pass = 0; pass < 100; pass++) {
      await loader.await();
      const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers]);
      if (fibers.every(fiber => !fiber.inertia)) return;
      await Promise.all(fibers.map(fiber => fiber.await()));
    }
    throw new Error('Child plugin lifecycle did not converge.');
  };
  const webName = pathToFileURL(join(runtime, 'node_modules', '@deepseek-ai/dsh-web/lib/index.js')).href;
  await loader.create({ id: 'web', name: webName, config: { searchProvider: 'original', fetchProvider: 'preserved' } });
  await settle();
  let originalCalls = 0, observeRebuild = false;
  const transitionQueries = [];
  await ctx.inject(['web'], child => {
    child.web.registerSearchProvider({ id: 'original', available: () => true, search: async () => {
      originalCalls++;
      return { content: 'original', sources: [], truncated: false };
    } });
    child.web.registerFetchProvider({ id: 'preserved', available: () => true, fetch: async () => ({ content: 'fetch-preserved' }) });
    if (observeRebuild) transitionQueries.push(child.web.search({ query: 'reload transition' })
      .then(value => ({ ok: true, content: value.content }), error => ({ ok: false, code: error.code })));
  });
  // Use the real host module name for the product's validated target identity.
  loader.resolve('web').options.name = '@deepseek-ai/dsh-web';
  const bundle = pathToFileURL(join(staged, 'src/bundle.mjs')).href;
  const store = await import(pathToFileURL(join(staged, 'src/core/product-control.mjs')).href);
  const snapshot = () => ({
    route: ctx.web.config.searchProvider.get(),
    fetch: ctx.web.config.fetchProvider.get(),
    control: ctx.get('grokSearchControl')?.publicSnapshot() ?? null,
    record: store.createProductStore(ctx).read(),
    providerIds: [...ctx.web.searchProviders.keys()],
  });
  const offlineConfiguration = { executable: join(isolated, 'intentionally-missing-grok-program.exe'),
    configPath: join(isolated, 'isolated-grok.toml') };
  await loader.create({ id: 'grok-search', name: bundle, config: offlineConfiguration });
  await settle();
  let state = snapshot();
  observations.push({ label: 'initial-loader-state', state, entries: [...loader.entries()].map(entry => ({
    id: entry.options.id, state: entry.fiber?.state, error: entry.fiber?.error?.stack ?? null,
  })), fibers: [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => ({
    name: runtime.name, state: fiber.state, error: fiber.error?.stack ?? null,
  }))), logs: ctx.logger.buffer });
  if (loader.resolve('grok-search').fiber?.error) throw loader.resolve('grok-search').fiber.error;
  assert.equal(state.control?.phase, 'required');
  assert.equal(state.route, 'grok-search');
  assert.equal(state.fetch, 'preserved');
  record('one-entry-aggregate-takeover', state);
  const root = loader.resolve('grok-search');
  const before = state.record;
  await root.fiber.restart();
  await settle();
  state = snapshot();
  assert.equal(state.record.intent.policy, 'required');
  assert.equal(state.record.revision, before.revision);
  assert.equal(state.route, 'grok-search');
  record('ordinary-restart-is-not-release', state);

  // A volatile update is parsed through the actual internal/config waterfall.
  await loader.resolve('web').update({ config: { searchProvider: 'original', fetchProvider: 'preserved' } });
  await settle();
  state = snapshot();
  assert.equal(state.route, 'grok-search');
  record('volatile-reload-remains-product-selected', state);

  observeRebuild = true;
  await loader.resolve('web').fiber.restart();
  await settle();
  observeRebuild = false;
  state = snapshot();
  assert.equal(state.route, 'grok-search');
  assert.equal(state.record.intent.policy, 'required');
  assert.equal(originalCalls, 0);
  assert.ok(transitionQueries.length > 0);
  const transitionResults = await Promise.all(transitionQueries);
  assert.ok(transitionResults.every(value => !value.ok));
  record('web-recreation-transition-errors-without-original-fallback', { ...state, originalCalls, transitionResults });

  saveSelection(false);
  loader.remove('grok-search');
  await root.fiber.await();
  await settle();
  state = snapshot();
  assert.equal(state.route, 'original');
  assert.equal(state.fetch, 'preserved');
  assert.equal(state.control, null);
  assert.equal(state.providerIds.includes('grok-search'), false);
  assert.equal(state.record.intent.policy, 'released');
  assert.equal(state.record.intent.releaseCompletion?.routeVerified, true);
  record('native-bundle-disable-restores-and-completes', state);

  saveSelection(true);
  await loader.create({ id: 'grok-search', name: bundle, config: offlineConfiguration });
  await settle();
  state = snapshot();
  assert.equal(state.route, 'grok-search');
  assert.equal(state.control.phase, 'required');
  assert.equal(state.record.intent.policy, 'required');
  assert.equal(state.control.completionCommitted, false);
  record('native-bundle-reenable-reacquires', state);

  writeFileSync(profileContext.patchPath, '- id: grok-search\n  disabled: true\n');
  const component = loader.resolve('grok-search');
  await component.update({ disabled: true });
  await component.fiber.await();
  await settle();
  state = snapshot();
  assert.equal(state.route, 'original');
  assert.equal(state.record.intent.reason, 'native-component-disable');
  record('native-component-disable-restores', state);

  writeFileSync(profileContext.patchPath, '[]\n');
  await component.update({ disabled: false });
  await settle();
  state = snapshot();
  assert.equal(state.route, 'grok-search');
  assert.equal(state.record.intent.policy, 'required');
  record('native-component-reenable-reacquires', state);

  // A controlled Session event during async drain must remain visible. This
  // observer lifetime probe is not evidence of an actual official API call.
  let finishDrain;
  const drainGate = new Promise(resolveDrain => { finishDrain = resolveDrain; });
  const core = ctx.get('grokSearchCore');
  const actualDispose = core.dispose;
  core.dispose = async () => { await drainGate; await actualDispose(); };
  const liveCounter = ctx.get('grokSearchOriginalSearchCounter');
  const counterBefore = liveCounter.snapshot().calls;
  saveSelection(false);
  loader.remove('grok-search');
  await new Promise(resolveTick => setImmediate(resolveTick));
  ctx.emit('session/event', {}, { type: 'web/deepseek-search-llm-request' });
  const duringDrainCalls = liveCounter.snapshot().calls;
  finishDrain();
  await component.fiber.await();
  await settle();
  assert.equal(duringDrainCalls, counterBefore + 1);
  state = snapshot();
  assert.equal(state.record.intent.policy, 'released');
  assert.equal(state.record.intent.releaseCompletion, undefined);
  record('counter-observes-during-async-drain-and-refuses-false-completion', {
    calls: liveCounter.snapshot().calls, completionAbsent: true, injectedEventOnly: true,
  });
} catch (error) {
  failures.push({ message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  try { await ctx.fiber.dispose(); }
  catch (error) { failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
  writeJson(join(directory, 'summary.json'), { runId, passed: process.exitCode !== 1,
    scope: 'Real Cordis/Loader/WebRuntime lifecycle; not Desktop or PluginManager UI',
    runtimeVersion: JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version,
    sourceHashes: ['src/bundle.mjs', 'src/control.mjs', 'src/route-verifier.mjs', 'src/core/product-control.mjs', 'cordis.patch.yml']
      .map(file => ({ file, sha256: sha256(join(project, file)) })),
    checks, observations, failures });
  console.log(JSON.stringify({ runId, checks: checks.length, passed: process.exitCode !== 1, failures: failures.map(value => value.message) }));
}
