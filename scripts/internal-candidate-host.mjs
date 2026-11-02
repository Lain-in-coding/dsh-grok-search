import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID, randomInt } from 'node:crypto';
import { createServer } from 'node:net';

const [archive, directory] = process.argv.slice(2);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = join(archive, 'dsh');
const imp = (name, file = 'lib/index.js') => import(pathToFileURL(join(runtimeRoot, 'node_modules', '@deepseek-ai', name, file)).href);
const config = await new Promise(done => process.once('message', done));
const productWiring = config.productWiring === true;
const preserveProductSelection = config.preserveProductSelection === true;
const profile = join(process.env.DSH_HOME, 'profiles', 'candidate');
const fixturePackage = join(profile, 'node_modules', 'candidate-offline-fixture');
const controlPath = join(directory, 'mcp-control.json');
const eventPath = join(directory, 'mcp-events.jsonl');
const trace = { instanceId: randomUUID(), searchQuery: config.realGrok?.query ?? null,
  calls: { original: 0, fetch: 0, echo: 0 }, modelCalls: 0, completed: 0,
  existingDisposed: 0, sessionEvents: [], toolMessages: [], cancellations: [] };
globalThis.__DSH_INTERNAL_CANDIDATE__ = trace;
let boot, cancelController, cancelReason, cancelTask;
const safeError = error => ({ message: String(error?.message ?? error), code: error?.code ?? null });
const mcpEvents = () => existsSync(eventPath) ? readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
function sdkVersion(entry) {
  if (!entry) return null;
  let directory = dirname(fileURLToPath(entry));
  for (let i = 0; i < 8; i++, directory = dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name === '@modelcontextprotocol/client') return pkg.version;
    }
  }
  return null;
}
function snapshot() {
  const core = boot?.ctx.get('grokSearchCore')?.snapshot();
  const web = boot?.ctx.get('web');
  return { ...trace, core, sdk: { entry: core?.lastDiagnostic?.sdkEntry ?? null,
    version: sdkVersion(core?.lastDiagnostic?.sdkEntry), suppliedByPlugin: Boolean(core?.lastDiagnostic?.sdkEntry?.includes('/profiles/candidate/')) },
    runtimeWeb: web ? { searchProviderId: web.searchProviderId ?? web.config?.searchProvider?.get?.(), fetchProviderId: web.fetchProviderId ?? web.config?.fetchProvider?.get?.(),
      searchProviderIds: [...web.searchProviders.keys()], fetchProviderIds: [...web.fetchProviders.keys()] } : null,
    existingDependencyPresent: Boolean(boot?.ctx.get('candidateExistingDependency')),
    productControl: boot?.ctx.get('grokSearchControl')?.snapshot() ?? null,
    productRecovery: boot?.ctx.get('grokSearchRecovery')?.snapshot() ?? null,
    productRouteVerifier: boot?.ctx.get('grokSearchRouteVerifier')?.snapshot() ?? null,
    productProgram: boot?.ctx.get('grokSearchProgram')?.snapshot?.() ?? null,
    selectedBundles: JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? [],
    webInject: [...boot.ctx.loader.entries()].find(entry => entry.options.id === 'web')?.options.inject,
    mcpEvents: mcpEvents() };
}
process.on('message', async message => {
  const { id, op, args = {} } = message;
  if (!id || !op) return;
  try {
    let value;
    if (op === 'snapshot') value = snapshot();
    else if (op === 'mode') { writeFileSync(controlPath, JSON.stringify({ mode: args.mode })); value = true; }
    else if (op === 'direct-search') {
      try { value = { ok: true, result: await boot.ctx.web.search({ query: '独立 seam 查询', maxResults: 5 }) }; }
      catch (error) { value = { ok: false, error: safeError(error) }; }
    } else if (op === 'cancel-start') {
      writeFileSync(controlPath, JSON.stringify({ mode: 'hang' }));
      const controller = new AbortController();
      const reason = new Error('内部候选用户取消');
      cancelController = controller;
      cancelReason = reason;
      cancelTask = boot.ctx.web.search({ query: '取消离线查询' }, controller.signal).then(
        result => ({ ok: true, result }), error => ({ ok: false, error: safeError(error), callerReasonPreserved: error === reason }));
      value = true;
    } else if (op === 'cancel-finish') {
      cancelController.abort(cancelReason);
      value = await cancelTask;
      trace.cancellations.push(value);
      cancelController = null; cancelReason = null; cancelTask = null;
    } else if (op === 'retry-product-recovery') {
      const recovery = boot?.ctx.get('grokSearchRecovery'); if (!recovery?.retry) throw new Error('Product recovery service absent.'); await recovery.retry(); value = snapshot();
    } else if (op === 'dispose-core') {
      const entry = [...boot.ctx.loader.entries()].find(entry => entry.options.id === 'grok-search-core');
      if (!entry?.fiber) throw new Error('搜索核心未加载。');
      await entry.fiber.dispose(); await boot.ctx.loader.await(); value = snapshot();
    } else if (op === 'close') {
      process.send?.({ type: 'reply', id, ok: true, value: snapshot() });
      await boot.shutdown.shutdown(0); process.disconnect(); return;
    } else throw new Error('未知候选操作。');
    // 私有运行任务不进入 IPC 或记录。
    process.send?.({ type: 'reply', id, ok: true, value });
  } catch (error) { process.send?.({ type: 'reply', id, ok: false, error: safeError(error) }); }
});

try {
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { recursive: true });
  let port;
  for (let attempt = 0; attempt < 20 && port === undefined; attempt++) {
    const reservation = createServer(); const candidate = randomInt(20_000, 60_000);
    const bound = await new Promise((done, fail) => {
      // Windows Hyper-V/WSL may reserve part of this range. Like an occupied
      // port, a denied reservation is not a usable probe endpoint; try another.
      reservation.once('error', error => ['EADDRINUSE', 'EACCES'].includes(error.code) ? done(false) : fail(error));
      reservation.listen(candidate, '127.0.0.1', () => done(true));
    });
    if (!bound) continue;
    await new Promise((done, fail) => reservation.close(error => error ? fail(error) : done())); port = candidate;
  }
  if (!port) throw new Error('无法分配本地测试端口。');
  mkdirSync(fixturePackage, { recursive: true });
  copyFileSync(join(project, 'fixtures/internal-candidate/host-fixture.mjs'), join(fixturePackage, 'fixture.mjs'));
  const exports = {};
  for (const [label, apply, inject] of [
    ['model', 'applyModel', ['llm', 'tools']], ['providers', 'applyProviders', ['web']],
    ['existing', 'applyExisting', []], ['observer', 'applyObserver', ['sessionController', 'connection', 'webServer', 'typertGateway']],
  ]) {
    writeFileSync(join(fixturePackage, label + '.mjs'), `export { ${apply} as apply } from './fixture.mjs'; export const name = 'candidate-${label}'; export const inject = ${JSON.stringify(inject)};\n`);
    exports['./' + label] = './' + label + '.mjs';
  }
  writeFileSync(join(fixturePackage, 'package.json'), JSON.stringify({ name: 'candidate-offline-fixture', version: '0.0.0', private: true,
    type: 'module', exports: { './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml', ...exports },
    dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2));
  const manifestPath = join(profile, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.dependencies['candidate-offline-fixture'] = '0.0.0';
  if (!(productWiring && preserveProductSelection)) manifest.dsh = { profile: { bundles: productWiring
    ? ['candidate-offline-fixture', 'dsh-grok-search']
    : ['candidate-offline-fixture', 'dsh-grok-search'] } };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(controlPath, JSON.stringify({ mode: 'structured' }));
  writeFileSync(eventPath, '', { flag: productWiring ? 'w' : 'wx' });
  const index = join(profile, 'index.html'); writeFileSync(index, '<!doctype html><html lang="zh-CN"><body>内部候选隔离会话</body></html>');
  const row = (id, name, options = {}) => ({ id, name: '@deepseek-ai/' + name, config: options });
  const rows = [
    row('timer', 'cordis-plugin-timer'), row('config-editor', 'dsh-config-editor'),
    row('llm', 'dsh-llm'), row('sessions', 'dsh-session'), row('agents', 'dsh-agent'),
    row('session-projections', 'dsh-session-projection'), row('system-prompt', 'dsh-system-prompt'),
    row('tools', 'dsh-tools', { mode: 'native' }), row('agent-loop', 'dsh-agent-loop', { agents: [] }),
    row('default-model', 'dsh-agent-default-model', { provider: 'candidate-offline', model: 'fixture-native' }),
    row('fs', 'dsh-fs-local', { cwd: workspace }), row('attachments', 'dsh-attachment-local', { dshHome: process.env.DSH_HOME }),
    row('session-persistence', 'dsh-session-persistence-jsonl', { root: join(directory, 'sessions') }),
    row('session-query', 'dsh-session-query-sqlite', { path: join(directory, 'session-index.sqlite'), openAt: 'never' }),
    row('storage', 'dsh-storage'), row('storage-json', 'dsh-storage-json', { root: join(directory, 'storage') }),
    row('storage-domain', 'dsh-storage-domain', { backend: 'json' }), row('workspace', 'dsh-workspace'),
    row('credentials', 'dsh-credentials-local', { dshHome: process.env.DSH_HOME, watch: false }),
    row('connection', 'dsh-client-connection'), row('commands', 'dsh-commands'), row('file-upload', 'dsh-client-file-upload'),
    row('typert', 'dsh-typert-registry'), row('typert-loader', 'dsh-typert-loader'),
    ...(JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8')).version.startsWith('0.2.1-') ? [row('remote-access', 'dsh-api-remote-access')] : []),
    row('gateway', 'dsh-api-gateway'),
    row('session-controller', 'dsh-api-session-controller', { nativeOpen: false }),
    row('webserver', 'dsh-host-webserver', { host: '127.0.0.1', port, compression: 'none' }),
    row('frontend', 'dsh-host-frontend-static', { distIndex: index }),
    { ...row('web', 'dsh-web', { searchProvider: productWiring ? 'candidate-original' : 'grok-search', fetchProvider: 'candidate-fetch' }), inject: ['candidateExistingDependency'] },
    row('tool-web', 'dsh-tool-web', { searchTimeoutMs: 120_000, fetchTimeoutMs: 30_000 }),
    { id: 'fixture-model', name: 'candidate-offline-fixture/model' },
    { id: 'fixture-providers', name: 'candidate-offline-fixture/providers' },
    { id: 'fixture-existing', name: 'candidate-offline-fixture/existing' },
    { id: 'fixture-observer', name: 'candidate-offline-fixture/observer' },
  ];
  writeFileSync(join(fixturePackage, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }], null, 2));
  const queryConfiguration = config.realGrok ? { executable: config.realGrok.executable, configPath: config.realGrok.configPath, budgetMs: 120_000 }
    : productWiring ? { executable: join(directory, 'intentionally-missing-grok-program'),
      configPath: join(directory, 'isolated-not-configured.toml'), budgetMs: 120_000 }
    : { executable: config.fixtureNode, executableArgs: [join(project, 'fixtures/internal-candidate/host-mcp.mjs'), controlPath, eventPath], budgetMs: 30_000 };
  // The shipped patch has one aggregate root. Configure that public entry;
  // nonexistent child loader entries cannot carry execution configuration.
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ id: 'grok-search', config: queryConfiguration }], null, 2));
  const appBoot = await imp('dsh-app-boot');
  const { runProfile } = await imp('dsh', 'lib/profile-boot.js');
  boot = await runProfile({ environment: appBoot.loadLayeredEnv('dsh', directory), profile: 'candidate', patchFiles: [], args: [] });
  const failed = [...boot.ctx.loader.entries()].filter(entry => entry.fiber?.error).map(entry => ({ id: entry.options.id, error: safeError(entry.fiber.error) }));
  process.send?.({ type: 'ready', workspace, failed, pending: [...boot.ctx.loader.entries()].filter(entry => entry.fiber?.state !== 2).map(entry => ({ id: entry.options.id, state: entry.fiber?.state ?? null })), versions: { node: process.versions.node, electron: process.versions.electron }, ...snapshot() });
} catch (error) {
  process.send?.({ type: 'fatal', error: { ...safeError(error), stack: error.stack } });
  if (boot) await boot.shutdown.shutdown(1);
  process.exitCode = 1; process.disconnect();
}
