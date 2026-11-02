import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createControlIntentStore } from '../../src/core/control-intent-store.mjs';

export const name = 'candidate-desktop-fixture';
export const inject = ['loader', 'profileContext'];
const trace = globalThis.__DSH_INTERNAL_CANDIDATE__ ??= {
  instanceId: randomUUID(), calls: { original: 0, fetch: 0, echo: 0, grok: 0 },
  modelCalls: 0, completed: 0, existingDisposed: 0,
  b2ControlRecord: process.env.DSH_B2_CONTROL_RECORD === '1',
  b2RecordFault: process.env.DSH_B2_RECORD_FAULT ?? null,
  productCounter: process.env.DSH_B2_PRODUCT_COUNTER !== '0',
  sessionEvents: [], toolMessages: [], controlEvents: [], currentSelectionAuthorization: true,
  productReleaseObservations: [],
};
const raw = value => Object.fromEntries(Object.entries(value ?? {}).map(([key, item]) =>
  [key, typeof item?.get === 'function' ? item.get() : item]));
const socketRecords = new Map();
let webSocketModule = null;
function runtimeWebSocket() {
  if (webSocketModule) return webSocketModule;
  const runtimeRoot = process.env.DSH_DESKTOP_DSH_DIR
    ?? (process.resourcesPath ? join(process.resourcesPath, 'app.asar', 'dsh') : null);
  if (!runtimeRoot) throw new Error('Desktop runtime root is unavailable.');
  const runtimeRequire = createRequire(join(runtimeRoot, 'package.json'));
  webSocketModule = runtimeRequire('ws');
  return webSocketModule;
}

export async function captureDesktopSearch(web, calls) {
  try { return { ok: true, result: await web.search({ query: '离线桌面控制验收', maxResults: 5 }), calls: { ...calls } }; }
  catch (error) { return { ok: false, error: { name: error?.name ?? 'Error', code: error?.code ?? null,
    message: error?.message ?? String(error) }, calls: { ...calls } }; }
}

export async function captureDesktopSeam(ctx, calls) {
  const web = ctx.get('web');
  if (!web || typeof web.search !== 'function') throw new Error('Desktop Web 服务不可用，未完成 direct seam 采样。');
  return await captureDesktopSearch(web, calls);
}

export async function waitForDesktopRecovery(ctx) {
  const recovery = ctx.get('candidateControlRecovery');
  if (!recovery || typeof recovery.retry !== 'function') throw new Error('Recovery fixture absent; no recovery was completed.');
  return await recovery.retry();
}

export async function apply(ctx) {
  const { applyModel, applyProviders, applyExisting } = await import('./host-fixture.mjs');
  applyExisting(ctx);
  ctx.inject(['llm', 'tools'], applyModel);
  ctx.inject(['web'], applyProviders);
  if (trace.productCounter && !ctx.get('grokSearchOriginalSearchCounter')) {
    ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: trace.calls.original }) });
  }
  ctx.on('session/event', (session, event) => {
    if (['turn/start', 'tool/call', 'tool/ptc-dispatch', 'tool/result', 'assistant/message', 'turn/end'].includes(event.type)) {
      trace.sessionEvents.push({ sessionId: session.id, ...structuredClone(event) });
    }
  });
  const recordPath = join(ctx.profileContext.dir, 'control-intent.fixture.json');
  // Packaged Desktop does not expose the Cordis logger on stdout. Keep a small
  // isolated-profile buffer of product warnings/errors for gate diagnostics.
  const hostLogs = [];
  ctx.on('internal/dispatch', (_kind, event, values) => {
    if (event !== 'logger/message') return;
    const message = values?.[0];
    if (!message || !['warn', 'error'].includes(message.type)) return;
    const text = JSON.stringify(message.args ?? []).slice(0, 2000);
    if (!/grok|CONTROL_/i.test(text + (message.name ?? ''))) return;
    hostLogs.push({ type: message.type, name: message.name ?? null, text });
    if (hostLogs.length > 50) hostLogs.shift();
  });
  const selectionPath = join(ctx.profileContext.dir, 'package.json');
  const versionedStore = trace.b2ControlRecord ? createControlIntentStore({
    directory: join(ctx.profileContext.dir, 'control-intent.records'), legacyPath: recordPath }) : null;
  const entry = id => {
    const found = [...ctx.loader.entries()].filter(row => row.options.id === id);
    if (found.length !== 1) throw new Error('Expected exactly one Desktop fixture entry: ' + id);
    return found[0];
  };
  const snapshot = () => {
    const webEntry = entry('web'), web = ctx.get('web');
    let record = null, recordError = null, recordEnvelope = null;
    try {
      if (versionedStore) { recordEnvelope = versionedStore.read(); record = recordEnvelope?.intent ?? null; }
      else if (existsSync(recordPath)) record = JSON.parse(readFileSync(recordPath, 'utf8'));
    }
    catch (error) { recordError = error.message; }
    return {
      ...structuredClone(trace), pid: process.pid, versions: { node: process.versions.node, electron: process.versions.electron },
      selectedBundles: JSON.parse(readFileSync(selectionPath, 'utf8')).dsh.profile.bundles,
      startedBundles: [...ctx.profileContext.startedBundles], record, recordError, recordEnvelope,
      ownerPresent: Boolean(ctx.get('candidateControlOwner')),
      recoveryPresent: Boolean(ctx.get('candidateControlRecovery')),
      recovery: ctx.get('candidateControlRecovery')?.snapshot() ?? null,
      productControl: ctx.get('grokSearchControl')?.snapshot() ?? null,
      productRecovery: ctx.get('grokSearchRecovery')?.snapshot() ?? null,
      productRouteVerifier: ctx.get('grokSearchRouteVerifier')?.snapshot() ?? null,
      productProgram: ctx.get('grokSearchProgram')?.snapshot?.() ?? null,
      originalSearchCounter: ctx.get('grokSearchOriginalSearchCounter')?.snapshot?.() ?? null,
      pluginManagerPresent: Boolean(ctx.get('pluginManager')),
      runtimeWeb: web ? { searchProviderId: web.searchProviderId ?? raw(web.config).searchProvider,
        fetchProviderId: web.fetchProviderId ?? raw(web.config).fetchProvider,
        searchProviders: [...web.searchProviders.keys()] } : null,
      webConfig: raw(webEntry.fiber.config), webInject: structuredClone(webEntry.options.inject),
      authorConfig: structuredClone(webEntry.options.config),
      existingDependencyPresent: Boolean(ctx.get('candidateExistingDependency')),
      entries: [...ctx.loader.entries()].map(row => ({ id: row.options.id, state: row.fiber?.state ?? null,
        disabled: row.options.disabled === true, error: row.fiber?.error ? String(row.fiber.error) : null })),
      sockets: [...socketRecords.values()].map(item => ({ id: item.id, opened: item.opened, closed: item.closed, frames: item.frames })),
      hostLogs: structuredClone(hostLogs),
    };
  };
  ctx.inject(['webServer', 'sessionController', 'connection', 'agents', 'tools'], async (probeCtx) => {
    const token = process.env.DSH_DESKTOP_FIXTURE_TOKEN;
    const addressFile = process.env.DSH_DESKTOP_FIXTURE_ADDRESS_FILE;
    if (!token || !addressFile) throw new Error('Isolated Desktop probe capability is required.');
    let operations = Promise.resolve();
    const server = createServer(async (request, response) => {
      const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.method !== 'POST' || request.url !== '/probe' || request.headers.authorization !== token) {
        send(403, { error: 'Isolated fixture request rejected.' }); return;
      }
      try {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 8192) throw new Error('Fixture request exceeds limit.');
        }
        const { op, args = {} } = JSON.parse(body);
        const work = operations.then(async () => {
          if (op === 'snapshot') return snapshot();
          // Test-only call of the public WebRuntime seam. Session tool output
          // is rendered as Markdown and drops internal presentation metadata;
          // this returns the real per-query JSON result without patching it.
          if (op === 'product-query-result') {
            const web = ctx.get('web');
            if (!web) throw new Error('Public WebRuntime is not available.');
            return web.search({ query: 'offline per-query budget probe', maxResults: 1 }, AbortSignal.timeout(5000));
          }
          if (op === 'model-auth') return { url: probeCtx.connection.authenticatedUrl('http://127.0.0.1:' + probeCtx.webServer.port + '/') };
          if (op === 'tool-definition') {
            const agent = probeCtx.agents.get(args.sessionId);
            if (!agent) throw new Error('Agent scope is unavailable for session: ' + args.sessionId);
            const definitions = ['web_search', 'web_fetch'].map(name => {
              const definition = probeCtx.tools.get(name, agent);
              return definition ? { name, timeoutMs: definition.timeoutMs ?? null, description: definition.description ?? null } : null;
            });
            // D-28 aggregate bundle: the query core is a child of the root
            // `grok-search` entry and shares its configuration.
            const rows = [...ctx.loader.entries()];
            const core = rows.some(row => row.options.id === 'grok-search-core')
              ? entry('grok-search-core') : entry('grok-search');
            const coreConfig = raw(core.fiber.config);
            return { sessionId: args.sessionId, definitions, coreBudgetMs: coreConfig.budgetMs ?? null };
          }
          if (op === 'websocket') {
            const WebSocket = runtimeWebSocket();
            return await new Promise(resolveSocket => {
              const id = args.id ?? randomUUID();
              const item = { id, opened: false, closed: false, frames: [] };
              const socket = new WebSocket(args.origin.replace(/^http/, 'ws') + '/api/remote.mux',
                { headers: { Cookie: args.cookie ?? '', Origin: args.origin }, handshakeTimeout: 3000 });
              item.socket = socket; socketRecords.set(id, item);
              const finish = value => resolveSocket(value);
              const timer = setTimeout(() => { socket.terminate(); finish({ id, opened: item.opened, reason: 'timeout' }); }, 3500);
              socket.on('open', () => {
                item.opened = true;
                if (args.sessionId) socket.send(JSON.stringify({ type: 'open', streamId: 'follow', endpoint: 'session/follow',
                  payload: { args: { request: { address: { kind: 'session', sessionId: args.sessionId }, assistantStream: true } } } }));
                clearTimeout(timer); finish({ id, opened: true });
              });
              socket.on('message', bytes => {
                if (bytes.length > 1024 * 1024 || item.frames.length >= 200) { socket.terminate(); return; }
                try { item.frames.push(JSON.parse(bytes.toString())); }
                catch { item.frames.push({ type: 'invalid-json' }); socket.terminate(); }
              });
              socket.on('error', error => { clearTimeout(timer); finish({ id, opened: false, reason: error.message }); });
              socket.on('close', () => { item.closed = true; clearTimeout(timer); finish({ id, opened: item.opened, closed: true }); });
            });
          }
          if (op === 'close-websocket') {
            const item = socketRecords.get(args.id);
            if (!item?.socket) throw new Error('Unknown WebSocket probe: ' + args.id);
            item.socket.close(); return true;
          }
          if (op === 'dispose-owner' || op === 'dispose-recovery') {
            await entry(op === 'dispose-owner' ? 'control-owner' : 'control-recovery').fiber.dispose();
            await ctx.loader.await(); return snapshot();
          }
          if (op === 'seam') return await captureDesktopSeam(ctx, trace.calls);
          if (op === 'upstream-failure') { trace.upstreamFailure = args.enabled === true; return snapshot(); }
          if (op === 'rebuild-web-from-author') {
            const target = entry('web'); target.fiber.update({ ...target.options.config }, true);
            await target.fiber.await(); return snapshot();
          }
          if (op === 'reload-web-with-session-search') {
            if (!args.origin || !args.cookie || !args.sessionId) throw new Error('Reload/search probe requires origin, cookie and sessionId.');
            const target = entry('web');
            const eventStart = trace.sessionEvents.length;
            const requestId = args.requestId ?? randomUUID();
            let reloadStartedAt = null;
            let reloadSettledAt = null;
            let reloadPromise = null;
            const armed = new Promise((resolve, reject) => {
              const timer = setTimeout(() => { stop(); reject(new Error('Search tool call did not start.')); }, 15000);
              const stop = ctx.on('session/event', (session, event) => {
                if (session.id !== args.sessionId || event.type !== 'tool/call' || event.data?.name !== 'web_search') return;
                clearTimeout(timer);
                stop();
                reloadStartedAt = Date.now();
                target.fiber.update({ ...target.options.config }, true);
                reloadPromise = target.fiber.await().then(() => { reloadSettledAt = Date.now(); });
                resolve();
              });
            });
            const prompt = fetch(args.origin + '/api/session/prompt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Origin: args.origin, Cookie: args.cookie },
              body: JSON.stringify({ type: 'client-request', rpcId: requestId, method: 'session/prompt',
                payload: { args: { request: { requestId, sessionId: args.sessionId, mode: 'queue',
                  content: [{ type: 'text', text: 'search' }] } } } }),
              signal: AbortSignal.timeout(15000),
            });
            await armed;
            await reloadPromise;
            const response = await prompt;
            const payload = await response.json();
            if (response.status !== 200 || payload?.result?.ok !== true) {
              throw new Error('Reload/search prompt failed: ' + JSON.stringify(payload));
            }
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
              const finished = trace.sessionEvents.slice(eventStart).some(event =>
                event.sessionId === args.sessionId && event.type === 'turn/end'
                && event.data?.reason?.kind === 'completed');
              if (finished) break;
              await new Promise(done => setTimeout(done, 10));
            }
            const events = trace.sessionEvents.slice(eventStart)
              .filter(event => event.sessionId === args.sessionId)
              .filter(event => ['tool/call', 'tool/result', 'turn/end'].includes(event.type));
            const toolCall = events.find(event => event.type === 'tool/call' && event.data?.name === 'web_search');
            const toolResult = events.findLast(event => event.type === 'tool/result');
            if (!toolCall || !toolResult || !events.some(event => event.type === 'turn/end'
              && event.data?.reason?.kind === 'completed')) throw new Error('Reload/search turn did not complete.');
            return { ...snapshot(), reloadProbe: { reloadStartedAt, reloadSettledAt,
              promptAcceptedAt: Date.now(), toolCallAt: toolCall.time,
              toolResultAt: toolResult.time, overlappedReload: toolCall.time <= reloadSettledAt,
              toolResult: toolResult.data?.message ?? null,
              originalSearchCounter: ctx.get('grokSearchOriginalSearchCounter')?.snapshot?.() ?? null } };
          }
          if (op === 'wait-recovery') { await waitForDesktopRecovery(ctx); return snapshot(); }
          if (op === 'retry-product-control') { const control = ctx.get('grokSearchControl'); if (!control?.retry) throw new Error('Product control service absent.'); await control.retry(); return snapshot(); }
          if (op === 'retry-product-recovery') { const recovery = ctx.get('grokSearchRecovery'); if (!recovery?.retry) throw new Error('Product recovery service absent.'); await recovery.retry(); return snapshot(); }
          if (op === 'product-stop') { const control = ctx.get('grokSearchControl'); if (!control?.stop) throw new Error('Product control service absent.'); const outcome = await control.stop(args.reason ?? 'explicit-product-stop'); return { ...snapshot(), productStopOutcome: outcome }; }
          if (op === 'observe-product-release') {
            // Isolated-profile diagnostics only: record how the product owner's
            // own release promise settles while the native disable tears the
            // bundle down. The returned promise is passed through unchanged.
            const control = ctx.get('grokSearchControl');
            if (!control?.stop) throw new Error('Product control service absent.');
            if (!control.__candidateReleaseObserved) {
              const original = control.stop;
              const observed = (reason, options) => {
                const row = { reason: reason ?? null, unloading: options?.unloading === true,
                  startedAt: new Date().toISOString(), settled: null };
                trace.productReleaseObservations.push(row);
                let task;
                try { task = original(reason, options); }
                catch (error) {
                  row.settled = { status: 'threw', at: new Date().toISOString(),
                    code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 500) };
                  throw error;
                }
                Promise.resolve(task).then(outcome => {
                  row.settled = { status: 'resolved', at: new Date().toISOString(), kind: outcome?.kind ?? null,
                    recordCommitted: outcome?.recordCommitted ?? null,
                    completionCommitted: outcome?.completionCommitted ?? null,
                    drainSettled: outcome?.drainSettled ?? null, routeChanged: outcome?.routeChanged ?? null,
                    routeVerified: outcome?.routeVerified ?? null, code: outcome?.error?.code ?? null,
                    message: outcome?.error?.message ? String(outcome.error.message).slice(0, 500) : null,
                    receipt: outcome?.routeReceipt ? structuredClone({ ...outcome.routeReceipt, hostEvidence: undefined }) : null };
                }, error => {
                  row.settled = { status: 'rejected', at: new Date().toISOString(), code: error?.code ?? null,
                    message: String(error?.message ?? error).slice(0, 500),
                    outcomeCode: error?.releaseOutcome?.error?.code ?? null };
                });
                return task;
              };
              control.stop = observed;
              control.release = observed;
              control.__candidateReleaseObserved = true;
            }
            return { observed: true, observations: structuredClone(trace.productReleaseObservations) };
          }
          if (op === 'dispose-product-control') {
            // Ordinary dispose, never a release: the bundle stays selected and
            // no component is disabled. The aggregate bundle has no separate
            // control entry, so the root fiber that owns the control child is
            // disposed instead.
            const rows = [...ctx.loader.entries()];
            const target = rows.some(row => row.options.id === 'grok-search-control')
              ? entry('grok-search-control') : entry('grok-search');
            await target.fiber.dispose(); await ctx.loader.await(); return snapshot();
          }
          if (op === 'plugin-manager-state') {
            const manager = ctx.get('pluginManager');
            if (!manager) throw new Error('Official PluginManager service absent.');
            const bundles = (await manager.listBundles()).map(({ name, version, enabled, removable, error }) => ({
              name, version: version ?? null, enabled, removable, error: error ? String(error) : null }));
            const plugins = (await manager.listPlugins()).filter(row => row.moduleName?.startsWith('dsh-grok-search'))
              .map(({ entryId, moduleName, enabled, readOnlyReason }) => ({ entryId, moduleName, enabled,
                readOnlyReason: readOnlyReason ?? null }));
            return { bundles, plugins };
          }
          if (op === 'plugin-manager-install') {
            const manager = ctx.get('pluginManager');
            if (!manager?.installBundle) throw new Error('Official PluginManager service absent.');
            return await manager.installBundle(args.spec, { enabled: args.enabled !== false,
              requestId: args.requestId ?? randomUUID() });
          }
          if (op === 'plugin-manager-set-bundle') {
            const manager = ctx.get('pluginManager');
            if (!manager?.setBundleEnabled) throw new Error('Official PluginManager service absent.');
            return await manager.setBundleEnabled(args.name, args.enabled === true);
          }
          if (op === 'plugin-manager-remove') {
            const manager = ctx.get('pluginManager');
            if (!manager?.removeBundle) throw new Error('Official PluginManager service absent.');
            return await manager.removeBundle(args.name);
          }
          if (op === 'confirm-stop') {
            const owner = ctx.get('candidateControlOwner');
            if (!owner?.stop) throw new Error('Current selection owner missing.');
            await owner.stop(args.reason ?? 'explicit-plugin-stop'); return snapshot();
          }
          if (op === 'record-fault') {
            if (!trace.b2ControlRecord || ![null, 'before-stage-write', 'before-publish', 'after-publish'].includes(args.stage)) {
              throw new Error('Invalid isolated record fault stage.');
            }
            trace.b2RecordFault = args.stage; return snapshot();
          }
          throw new Error('Unknown Desktop fixture operation: ' + op);
        });
        operations = work.catch(() => {});
        send(200, { ok: true, value: await work });
      } catch (error) { send(500, { ok: false, error: { message: error.message, stack: error.stack } }); }
    });
    probeCtx.effect(() => async () => {
      for (const item of socketRecords.values()) item.socket?.terminate();
      if (server.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
      await operations;
    });
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        try {
          writeFileSync(addressFile, JSON.stringify({ port: server.address().port, pid: process.pid,
            hostOrigin: `http://127.0.0.1:${probeCtx.webServer.port}`, instanceId: trace.instanceId }) + '\n');
          done();
        } catch (error) { reject(error); }
      });
    });
  });
}
