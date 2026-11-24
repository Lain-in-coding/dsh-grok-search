import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { parseRuntimeReceiptArguments } from './deferred-release-desktop-prepare.mjs';
import { runBoundedCommand } from './lib/compatibility-process.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const freshRun = prefix => {
  const runId = new Date().toISOString().replaceAll(':', '-') + '-' + process.pid;
  const artifactRoot = process.env.DSH_VALIDATION_ARTIFACT_ROOT ?? join(project, 'artifacts');
  assert.ok(artifactRoot && !artifactRoot.includes('\0') && resolve(artifactRoot) === join(artifactRoot, '.'),
    'DSH_VALIDATION_ARTIFACT_ROOT must be an absolute path.');
  const directory = join(artifactRoot, prefix, runId);
  mkdirSync(directory, { recursive: true });
  return { runId, directory };
};
function sourceHashes(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = ['package.json', 'cordis.patch.yml', ...manifest.files.filter(file => file.startsWith('src/'))
    .flatMap(file => file.endsWith('/') ? readdirSync(join(root, file)).map(name => file + name) : [file])];
  return files.sort().map(file => ({ file, sha256: sha256(join(root, file)) }));
}
export function pendingReleaseSummary(envelope) {
  assert.ok(Number.isSafeInteger(envelope?.revision) && envelope.revision > 0, 'pending release needs a committed revision');
  assert.equal(envelope.intent?.policy, 'released', 'cold recovery must start from a release intent');
  assert.equal(envelope.intent.releaseCompletion, undefined, 'cold recovery must not reuse an already-completed release');
  assert.ok(typeof envelope.intent.release?.operationId === 'string' && envelope.intent.release.operationId,
    'pending release needs its real operation identity');
  return { revision: envelope.revision, operationId: envelope.intent.release.operationId,
    reason: envelope.intent.reason, authorSearchProvider: envelope.intent.acquisition?.authorSearchProvider,
    authorFetchProvider: envelope.intent.acquisition?.authorFetchProvider };
}
export function readLifecycleStage(execution, stage, authorCase, sourceGraphSha256) {
  assert.equal(execution.code, 0, `${authorCase}/${stage}: child exit`);
  assert.equal(execution.signal, null, `${authorCase}/${stage}: child signal`);
  assert.equal(execution.failure, null, `${authorCase}/${stage}: process or cleanup failure`);
  const readMarker = prefix => {
    const rows = execution.stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
    assert.equal(rows.length, 1, `${authorCase}/${stage}: missing or duplicate ${prefix.trim()}`);
    return JSON.parse(rows[0].slice(prefix.length));
  };
  const result = readMarker('DSH_UX_STAGE ');
  assert.equal(result.passed, true);
  assert.equal(result.stage, stage);
  assert.equal(result.authorCase, authorCase);
  assert.equal(result.sourceGraphSha256, sourceGraphSha256, 'All stages must use the same source graph.');
  if (stage === 'warm') {
    const resume = readMarker('DSH_UX_COLD_RESUME ');
    assert.equal(resume.authorCase, authorCase);
    assert.equal(resume.isolated, result.isolated);
    assert.ok(typeof resume.isolated === 'string' && isAbsolute(resume.isolated));
    assert.ok(Number.isSafeInteger(resume.pending?.revision) && resume.pending.revision > 0);
    assert.ok(typeof resume.pending.operationId === 'string' && resume.pending.operationId);
    assert.match(resume.ledgerSha256, /^[a-f0-9]{64}$/);
    return { ...result, resume };
  }
  assert.equal(result.pendingVerifiedBeforeMount, true);
  return result;
}

const { args, runtimeOptions } = parseRuntimeReceiptArguments(process.argv.slice(2));
const authorIndex = args.indexOf('--author-case');
const authorCase = authorIndex < 0 ? 'same-author' : args.splice(authorIndex, 2)[1];
assert.ok(['same-author', 'changed-author'].includes(authorCase), 'Unknown lifecycle author case.');
if (args.length === 2 && args[0] === '--desktop') {
  assert.equal(authorIndex, -1, '--desktop runs both independent author cases');
  const { cleanEnvironment } = await import('./lib/internal-candidate-utils.mjs');
  const runtime = candidateRuntime(args[1], {
    receiptPath: runtimeOptions.runtimeReceiptPath, receiptSha256: runtimeOptions.runtimeReceiptSha256,
    root: runtimeOptions.runtimeReceiptPath ? dirname(resolve(runtimeOptions.runtimeReceiptPath)) : undefined,
  });
  const runner = freshRun('ux-lifecycle-runner');
  const sources = sourceHashes(project), sourceGraphSha256 = digest(sources);
  const hostHashes = [...new Set([runtime.executable, runtime.archivePath, runtime.fuseBinary])]
    .map(path => ({ path, sha256: sha256(path) }));
  const env = {
    ...cleanEnvironment(tmpdir()), TMPDIR: tmpdir(), ELECTRON_RUN_AS_NODE: '1',
    DSH_VALIDATION_ARTIFACT_ROOT: process.env.DSH_VALIDATION_ARTIFACT_ROOT,
  };
  const stages = [];
  for (const selectedCase of ['same-author', 'changed-author']) {
    let resumeRoot;
    for (const stage of ['warm', 'cold']) {
      try {
        const execution = await runBoundedCommand(runtime.executable, ['--expose-internals',
          join(project, 'scripts/ux-lifecycle-host.mjs'), '--runtime-root', join(runtime.archivePath, 'dsh'),
          '--author-case', selectedCase, ...(resumeRoot ? ['--resume-root', resumeRoot] : [])],
        { cwd: project, env, timeout: 120_000 });
        writeJson(join(runner.directory, `${selectedCase}-${stage}.json`), execution);
        process.stdout.write(execution.stdout);
        process.stderr.write(execution.stderr);
        const result = readLifecycleStage(execution, stage, selectedCase, sourceGraphSha256);
        stages.push(result);
        if (stage === 'warm') resumeRoot = result.resume.isolated;
      } catch (error) {
        stages.push({ authorCase: selectedCase, stage, passed: false, error: error.message });
        if (stage === 'warm') break;
      }
    }
  }
  let integrityError = null;
  try {
    assert.deepEqual(sourceHashes(project), sources, 'Product sources changed during lifecycle validation.');
    for (const row of hostHashes) assert.equal(sha256(row.path), row.sha256, 'Official host changed during lifecycle validation.');
  } catch (error) { integrityError = error.message; }
  const summary = { scope: 'official-host-components-with-synthetic-providers-not-native-desktop-installation',
    sourceGraphSha256, sourceHashes: sources, hostHashes, integrityError, stages,
    passed: !integrityError && stages.length === 4 && stages.every(stage => stage.passed) };
  if (!summary.passed) process.exitCode = 1;
  writeJson(join(runner.directory, 'summary.json'), summary);
  console.log(JSON.stringify({ evidence: runner.directory, ...summary, sourceHashes: undefined, hostHashes: undefined }));
} else {
if (![2, 4].includes(args.length) || args[0] !== '--runtime-root'
  || args.length === 4 && args[2] !== '--resume-root') {
  throw new Error('Usage: --desktop <exe> [--runtime-receipt <json> --runtime-receipt-sha256 <hash>] | --runtime-root <installed-dsh-root> [--resume-root <owned-root>]');
}
const runtime = resolve(args[1]);
const { runId, directory } = freshRun('ux-lifecycle-host');
const resume = args.length === 4;
const isolated = resume ? resolve(args[3]) : mkdtempSync(join(tmpdir(), 'dsh-ux-lifecycle-'));
const distance = relative(tmpdir(), isolated);
assert.ok(distance && !distance.startsWith('..') && !isAbsolute(distance)
  && basename(isolated).startsWith('dsh-ux-lifecycle-'), 'resume only a workspace-owned lifecycle profile');
assert.equal(lstatSync(isolated).isSymbolicLink(), false);
assert.equal(realpathSync(isolated), join(realpathSync(tmpdir()), distance), 'Do not resume a redirected profile.');
const profile = join(isolated, 'profile');
const modules = join(profile, 'node_modules');
const staged = join(modules, 'dsh-grok-search');
const productVersion = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
const coldPlan = resume ? JSON.parse(readFileSync(join(isolated, 'cold-resume.json'), 'utf8')) : null;
if (coldPlan) assert.equal(coldPlan.authorCase, authorCase);
const sources = coldPlan?.sourceHashes ?? sourceHashes(project);
if (!resume) {
mkdirSync(staged, { recursive: true });
for (const file of ['package.json', 'cordis.patch.yml', 'src']) cpSync(join(project, file), join(staged, file), { recursive: true, errorOnExist: true });
symlinkSync(join(runtime, 'node_modules', '@deepseek-ai'), join(modules, '@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir');
// The product's own runtime dependencies (MCP client, TOML parser) are what a
// real pnpm install provides; link the already-installed exact copies.
for (const name of readdirSync(join(project, 'node_modules'))) {
  if (name.startsWith('.') || name === '@deepseek-ai') continue;
  symlinkSync(join(project, 'node_modules', name), join(modules, name), process.platform === 'win32' ? 'junction' : 'dir');
}
}
assert.deepEqual(sourceHashes(staged), sources, 'Staged lifecycle sources differ from the recorded graph.');
assert.deepEqual(sourceHashes(project), sources, 'Current sources differ from the lifecycle graph.');
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
let readRecord, coldResume = null, pendingVerifiedBeforeMount = false;
try {
  const profileContext = { dir: profile, home: isolated, installAnchor: join(runtime, 'package.json'),
    patchPath: join(profile, 'cordis.patch.yml'), overlays: [] };
  const saveSelection = enabled => writeFileSync(join(profile, 'package.json'), JSON.stringify({
    private: true, type: 'module', dependencies: { 'dsh-grok-search': productVersion },
    dsh: { profile: { bundles: enabled ? ['dsh-grok-search'] : [] } },
  }, null, 2));
  if (!resume) {
    saveSelection(true);
    writeFileSync(profileContext.patchPath, '[]\n');
  }
  const expectedAuthor = authorCase === 'changed-author'
    ? { searchProvider: 'another-current', fetchProvider: 'fetch-current' }
    : { searchProvider: 'original', fetchProvider: 'preserved' };
  let currentAuthor = { searchProvider: 'original', fetchProvider: 'preserved' };
  if (resume) {
    const patch = JSON.parse(readFileSync(profileContext.patchPath, 'utf8'));
    const entries = patch.filter(entry => entry.id === 'web');
    assert.equal(entries.length, 1, 'Cold startup needs the persisted current author.');
    currentAuthor = entries[0].config;
    assert.deepEqual(currentAuthor, expectedAuthor);
    assert.deepEqual(currentAuthor, coldPlan.author);
    assert.ok(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles.includes('dsh-grok-search'));
  }
  ctx.provide('profileContext', profileContext);
  ctx.on('internal/dispatch', (_kind, event, values) => {
    if (event === 'logger/message' && values?.[0]?.level === 'error') failures.push(values[0]);
  });
  const appBoot = await importHost('dsh-app-boot');
  const resolution = await appBoot.createRuntimeResolution({
    installAnchor: profileContext.installAnchor, home: isolated,
    profile: { ...profileContext, layers: [], patches: [], skippedBundles: [] },
  });
  await ctx.plugin(appBoot.PluginPackages, { resolution });
  await ctx.plugin(Loader);
  loader = ctx.loader;
  const settle = async () => {
    for (let pass = 0; pass < 100; pass++) {
      await loader.await();
      await ctx.get('grokSearchBootstrap')?.settled();
      const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers]);
      if (fibers.every(fiber => !fiber.inertia)) return;
      await Promise.all(fibers.map(fiber => fiber.await()));
    }
    throw new Error('Child plugin lifecycle did not converge.');
  };
  const webName = pathToFileURL(join(runtime, 'node_modules', '@deepseek-ai/dsh-web/lib/index.js')).href;
  await loader.create({ id: 'web', name: webName, config: { ...currentAuthor } });
  await settle();
  let originalCalls = 0, observeRebuild = false;
  const transitionQueries = [];
  await ctx.inject(['web'], child => {
    const author = { ...currentAuthor };
    child.web.registerSearchProvider({ id: author.searchProvider, available: () => true, search: async () => {
      originalCalls++;
      return { content: author.searchProvider, sources: [], truncated: false };
    } });
    child.web.registerFetchProvider({ id: author.fetchProvider, available: () => true,
      fetch: async () => ({ content: author.fetchProvider }) });
    if (observeRebuild) transitionQueries.push(child.web.search({ query: 'reload transition' })
      .then(value => ({ ok: true, content: value.content }), error => ({ ok: false, code: error.code })));
  });
  // Use the real host module name for the product's validated target identity.
  loader.resolve('web').options.name = '@deepseek-ai/dsh-web';
  const bundle = pathToFileURL(join(staged, 'src/bundle.mjs')).href;
  const store = await import(pathToFileURL(join(staged, 'src/core/product-control.mjs')).href);
  const productStore = store.createProductStore(ctx);
  readRecord = () => productStore.read();
  const snapshot = () => ({
    route: ctx.web.config.searchProvider.get(),
    fetch: ctx.web.config.fetchProvider.get(),
    control: ctx.get('grokSearchControl')?.publicSnapshot() ?? null,
    record: readRecord(),
    providerIds: [...ctx.web.searchProviders.keys()],
  });
  const offlineConfiguration = { executable: join(isolated, 'intentionally-missing-grok-program.exe'),
    configPath: join(isolated, 'isolated-grok.toml') };
  if (resume) {
    const beforeMount = snapshot();
    assert.deepEqual(pendingReleaseSummary(beforeMount.record), coldPlan.pending);
    assert.equal(digest(beforeMount.record), coldPlan.ledgerSha256, 'Cold startup must receive the unmodified failed release.');
    assert.equal(beforeMount.control, null);
    assert.equal(beforeMount.providerIds.includes('grok-search'), false);
    assert.equal(beforeMount.route, expectedAuthor.searchProvider);
    assert.equal(beforeMount.fetch, expectedAuthor.fetchProvider);
    if (authorCase === 'changed-author') assert.equal(beforeMount.providerIds.includes('original'), false);
    pendingVerifiedBeforeMount = true;
    record('cold-pending-verified-before-mount', { ...beforeMount, authorCase });
  }
  await loader.create({ id: 'grok-search', name: bundle, config: offlineConfiguration });
  await settle();
  let state = snapshot();
  observations.push({ label: 'initial-loader-state', state, entries: [...loader.entries()].map(entry => ({
    id: entry.options.id, state: entry.fiber?.state, error: entry.fiber?.error?.stack ?? null,
  })), fibers: [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => ({
    name: runtime.name, state: fiber.state, error: fiber.error?.stack ?? null,
  }))), logs: ctx.logger.buffer });
  if (loader.resolve('grok-search').fiber?.error) throw loader.resolve('grok-search').fiber.error;
  if (resume) {
    record('cold-reinstall-with-generated-pending-release', {
      ...state, compatibility: ctx.get('grokSearchCompatibility')?.report(),
      recovery: ctx.get('grokSearchRecovery')?.snapshot(),
    });
    console.log(JSON.stringify({ stage: 'cold', authorCase, control: state.control, policy: state.record?.intent.policy,
      reason: state.record?.intent.reason, completion: Boolean(state.record?.intent.releaseCompletion),
      recovery: state.record?.intent.recovery?.action }));
  }
  assert.equal(state.control?.phase, 'required');
  assert.equal(state.route, 'grok-search');
  assert.equal(state.fetch, currentAuthor.fetchProvider);
  record('one-entry-aggregate-takeover', state);
  if (resume) {
    assert.ok(state.record.revision > coldPlan.pending.revision);
    assert.equal(state.record.intent.policy, 'required');
    assert.equal(state.record.intent.release, null);
    assert.equal(state.record.intent.acquisition.authorSearchProvider, expectedAuthor.searchProvider);
    assert.equal(state.record.intent.acquisition.authorFetchProvider, expectedAuthor.fetchProvider);
    const root = loader.resolve('grok-search');
    saveSelection(false);
    loader.remove('grok-search');
    await root.fiber.await();
    await settle();
    state = snapshot();
    assert.equal(state.route, expectedAuthor.searchProvider, 'A later release restores the current author, not the uninstalled owner.');
    assert.equal(state.fetch, expectedAuthor.fetchProvider);
    assert.equal(state.record.intent.releaseCompletion?.routeVerified, true);
    record('cold-reacquired-owner-releases-to-current-author', state);
  }
  if (!resume) {
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

  // Both pending records come from real native releases. Only the Session event
  // is synthetic; no ledger or completion field is written by the fixture.
  const failNativeRelease = async label => {
    const before = snapshot(), removing = loader.resolve('grok-search');
    assert.equal(before.record.intent.policy, 'required');
    let finishDrain;
    const drainGate = new Promise(done => { finishDrain = done; });
    const core = ctx.get('grokSearchCore'), actualDispose = core.dispose;
    core.dispose = async () => { await drainGate; await actualDispose.call(core); };
    const counter = ctx.get('grokSearchOriginalSearchCounter'), count = counter.snapshot().calls;
    try {
      saveSelection(false);
      loader.remove('grok-search');
      await new Promise(done => setImmediate(done));
      ctx.emit('session/event', {}, { type: 'web/deepseek-search-llm-request' });
      assert.equal(counter.snapshot().calls, count + 1);
    } finally { finishDrain(); }
    await removing.fiber.await();
    await settle();
    const failed = snapshot(), pending = pendingReleaseSummary(failed.record);
    assert.ok(pending.revision > before.record.revision);
    assert.equal(failed.control, null);
    assert.equal(failed.providerIds.includes('grok-search'), false);
    record(label, { ...failed, pending, injectedEventOnly: true });
    return pending;
  };
  const warmPending = await failNativeRelease('counter-observes-during-async-drain-and-refuses-false-completion');
  saveSelection(true);
  await loader.create({ id: 'grok-search', name: bundle, config: offlineConfiguration });
  await settle();
  await ctx.get('grokSearchBootstrap')?.settled();
  state = snapshot();
  record('warm-reinstall-with-generated-pending-release', {
    ...state, compatibility: ctx.get('grokSearchCompatibility')?.report(),
    recovery: ctx.get('grokSearchRecovery')?.snapshot(),
  });
  console.log(JSON.stringify({ stage: 'warm', authorCase, control: state.control, policy: state.record?.intent.policy,
    reason: state.record?.intent.reason, completion: Boolean(state.record?.intent.releaseCompletion),
    recovery: state.record?.intent.recovery?.action }));
  assert.equal(state.control?.phase, 'required', 'a re-enabled bundle must finish its old release and acquire a new owner');
  assert.equal(state.record.intent.policy, 'required');
  record('pending-release-reenable-reacquires', state);
  const pending = await failNativeRelease('new-failed-native-release-for-cold-start');
  assert.notEqual(pending.operationId, warmPending.operationId, 'Cold recovery requires a new failed release after warm success.');
  assert.ok(pending.revision > warmPending.revision);
  if (authorCase === 'changed-author') {
    currentAuthor = { ...expectedAuthor };
    const web = loader.resolve('web');
    await web.update({ config: { ...currentAuthor } });
    await web.fiber.restart();
    await settle();
    assert.equal(snapshot().providerIds.includes('original'), false, 'The uninstalled author is no longer registered.');
  }
  state = snapshot();
  assert.equal(state.route, expectedAuthor.searchProvider);
  assert.equal(state.fetch, expectedAuthor.fetchProvider);
  assert.deepEqual(pendingReleaseSummary(state.record), pending);
  writeFileSync(profileContext.patchPath, JSON.stringify([{ id: 'web', config: { ...currentAuthor } }]) + '\n');
  saveSelection(true);
  assert.equal(snapshot().control, null, 'Persist selection without mounting another product owner.');
  coldResume = { isolated, authorCase, pending, ledgerSha256: digest(state.record), author: currentAuthor,
    sourceHashes: sources };
  writeJson(join(isolated, 'cold-resume.json'), coldResume);
  record('cold-resume-prepared-with-pending-ledger', { authorCase, pending, author: currentAuthor });
  }
} catch (error) {
  observations.push({ label: 'failed-lifecycle-state',
    entries: loader ? [...loader.entries()].map(entry => ({ id: entry.options.id,
      state: entry.fiber?.state, error: entry.fiber?.error?.message ?? null })) : [],
    logs: ctx.logger.buffer });
  failures.push({ message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  try { await ctx.fiber.dispose(); }
  catch (error) { failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
  try {
    assert.deepEqual(sourceHashes(project), sources, 'Source graph changed while this stage was running.');
    assert.deepEqual(sourceHashes(staged), sources, 'Staged product changed while this stage was running.');
    if (coldResume) {
      const afterShutdown = readRecord();
      assert.deepEqual(pendingReleaseSummary(afterShutdown), coldResume.pending);
      assert.equal(digest(afterShutdown), coldResume.ledgerSha256, 'Shutdown must leave the new failed release pending.');
    }
  } catch (error) { failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
  writeJson(join(directory, 'summary.json'), { runId, passed: process.exitCode !== 1,
    scope: 'Real Cordis/Loader/WebRuntime lifecycle; not Desktop or PluginManager UI',
    runtimeVersion: JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version,
    authorCase, stage: resume ? 'cold' : 'warm', pendingVerifiedBeforeMount,
    sourceHashes: sources, sourceGraphSha256: digest(sources),
    checks, observations, failures });
  if (coldResume && process.exitCode !== 1) {
    console.log('DSH_UX_COLD_RESUME ' + JSON.stringify({ ...coldResume, sourceHashes: undefined }));
  }
  console.log('DSH_UX_STAGE ' + JSON.stringify({ runId, isolated, authorCase, stage: resume ? 'cold' : 'warm',
    sourceGraphSha256: digest(sources), pendingVerifiedBeforeMount, checks: checks.length,
    passed: process.exitCode !== 1, failures: failures.map(value => value.message) }));
}
}
