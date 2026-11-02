import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

const ORIGINAL_SEARCH_EVENT = 'web/deepseek-search-llm-request';
const trace = globalThis.__DSH_CLI_WEB_FIXTURE__ ??= {
  instanceId: randomUUID(),
  calls: { original: 0, fetch: 0, echo: 0 },
  modelCalls: 0,
  modelCommands: [],
  modelToolNames: [],
  completed: 0,
  officialSearchEvents: 0,
  sessionEvents: [],
  toolMessages: [],
};

const selected = value => typeof value?.get === 'function' ? value.get() : value;
const raw = value => Object.fromEntries(Object.entries(value ?? {}).map(([key, item]) =>
  [key, selected(item)]));

function eventView(session, event) {
  return {
    sessionId: session.id,
    seq: event.seq,
    time: event.time,
    type: event.type,
    data: structuredClone(event.data),
  };
}

export function applyModel(ctx) {
  class FixtureAdapter extends LlmAdapter {
    async *stream(options) {
      trace.modelCalls += 1;
      trace.modelToolNames.push(Array.isArray(options.tools)
        ? options.tools.map(tool => tool.name ?? tool.function?.name).filter(Boolean)
        : Object.keys(options.tools ?? {}));
      const userIndex = options.messages.findLastIndex(message => message.role === 'user');
      const toolMessages = options.messages
        .filter((message, index) => index > userIndex && message.role === 'tool');
      const userTexts = options.messages
        .filter(message => message.role === 'user')
        .flatMap(message => message.content
          .filter(part => part.type === 'text')
          .map(part => part.text.trim()))
        .filter(text => text
          && !text.startsWith('Current runtime context')
          && !text.startsWith('Generate the session title'));
      const command = userTexts.findLast(text =>
        /^(?:search|fetch|echo|chat)(?:\s|$)/.test(text)) ?? '';
      trace.modelCommands.push(command);
      const mode = command.split(/\s+/)[0];

      if (toolMessages.length || mode === 'chat' || mode === '') {
        trace.toolMessages.push(...structuredClone(toolMessages));
        trace.completed += 1;
        yield { type: 'text-delta', index: 0, text: '内部候选轮次完成' };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }

      const tool = mode === 'fetch'
        ? { name: 'web_fetch', args: { url: 'https://example.invalid/fetch' } }
        : mode === 'echo'
          ? { name: 'candidate_echo', args: {} }
          : { name: 'web_search', args: { queries: ['内部候选离线查询'] } };
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: randomUUID(),
        name: tool.name,
        argumentsDelta: JSON.stringify(tool.args),
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }

  ctx.llm.registerAdapter(['candidate-offline'], new FixtureAdapter());
  ctx.tools.register({
    name: 'candidate_echo',
    description: '离线普通工具对照。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      trace.calls.echo += 1;
      return '离线普通工具成功';
    },
  });
}

export function applyProviders(ctx) {
  ctx.web.registerSearchProvider({
    id: 'candidate-original',
    available: () => true,
    async search() {
      trace.calls.original += 1;
      return { content: '作者搜索对照', sources: [], truncated: false };
    },
  });
  ctx.web.registerFetchProvider({
    id: 'candidate-fetch',
    available: () => true,
    async fetch(request) {
      trace.calls.fetch += 1;
      return {
        url: request.url,
        statusCode: 200,
        body: { kind: 'text', content: '离线 fetch 保持' },
        truncated: false,
      };
    },
  });
}

function snapshot(ctx) {
  let web = null;
  try { web = ctx.get('web') ?? null; }
  catch {}
  let control = null;
  try { control = ctx.get('grokSearchControl')?.publicSnapshot?.() ?? null; }
  catch (error) {
    control = { available: false, error: { code: error?.code ?? null, message: error?.message ?? String(error) } };
  }
  let core = null;
  try { core = ctx.get('grokSearchCore')?.snapshot?.() ?? null; }
  catch (error) {
    core = { error: { code: error?.code ?? null, message: error?.message ?? String(error) } };
  }
  let originalSearchCounter = null;
  try { originalSearchCounter = ctx.get('grokSearchOriginalSearchCounter')?.snapshot?.() ?? null; }
  catch (error) {
    originalSearchCounter = {
      error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    };
  }
  let routeVerifier = null;
  try { routeVerifier = ctx.get('grokSearchRouteVerifier')?.snapshot?.() ?? null; }
  catch {}
  const packagePath = ctx.profileContext.dir + '/package.json';
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  const entries = [...ctx.loader.entries()].map(entry => ({
    id: entry.options.id,
    state: entry.fiber?.state ?? null,
    disabled: entry.options.disabled === true,
    error: entry.fiber?.error ? String(entry.fiber.error) : null,
  }));
  return {
    instanceId: trace.instanceId,
    pid: process.pid,
    node: process.versions.node,
    calls: { ...trace.calls },
    modelCalls: trace.modelCalls,
    modelCommands: [...trace.modelCommands],
    modelToolNames: structuredClone(trace.modelToolNames),
    completed: trace.completed,
    fixtureObservedOfficialEvents: trace.officialSearchEvents,
    originalSearchCounter,
    routeVerifier,
    sessionEvents: structuredClone(trace.sessionEvents),
    toolMessages: structuredClone(trace.toolMessages),
    selectedBundles: manifest.dsh?.profile?.bundles ?? [],
    startedBundles: [...ctx.profileContext.startedBundles],
    workspace: process.env.DSH_CLI_WEB_WORKSPACE,
    runtimeWeb: web ? {
      searchProviderId: web.searchProviderId ?? selected(web.config?.searchProvider),
      fetchProviderId: web.fetchProviderId ?? selected(web.config?.fetchProvider),
      searchProviderIds: [...(web.searchProviders?.keys?.() ?? [])],
      fetchProviderIds: [...(web.fetchProviders?.keys?.() ?? [])],
      config: raw(web.config),
    } : null,
    control,
    core,
    program: ctx.get('grokSearchProgram')?.snapshot?.() ?? null,
    route: ctx.get('grokSearchCore')?.routeSnapshot?.() ?? null,
    entries,
  };
}

export async function applyObserver(ctx) {
  const state = trace;
  const entry = id => {
    const found = [...ctx.loader.entries()].filter(row => row.options.id === id);
    if (found.length !== 1) throw new Error(`Expected exactly one entry for ${id}.`);
    return found[0];
  };
  ctx.on('session/event', (session, event) => {
    if (event?.type === ORIGINAL_SEARCH_EVENT) state.officialSearchEvents += 1;
    if (!['turn/start', 'step/start', 'step/end', 'assistant/message', 'tool/call',
      'tool/result', 'llm/retry', 'turn/end', 'model/selection']
      .includes(event?.type)) return;
    state.sessionEvents.push(eventView(session, event));
    if (state.sessionEvents.length > 500) state.sessionEvents.splice(0, state.sessionEvents.length - 500);
  });

  const readyFile = process.env.DSH_CLI_WEB_READY_FILE;
  if (!readyFile) throw new Error('DSH_CLI_WEB_READY_FILE is required.');
  const token = randomBytes(32).toString('hex');
  let operation = Promise.resolve();
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(value));
    };
    if (request.method !== 'POST' || request.url !== '/probe'
      || request.headers.authorization !== 'Bearer ' + token) {
      send(403, { ok: false, error: 'fixture request rejected' });
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 65_536) throw new Error('fixture request too large');
      }
      const input = body ? JSON.parse(body) : {};
      const work = operation.then(async () => {
        if (!input.op || input.op === 'snapshot') return snapshot(ctx);
        if (input.op === 'read-control-record') {
          const { createControlIntentStore } = await import('dsh-grok-search/control-intent');
          return createControlIntentStore({ directory: join(ctx.profileContext.dir, 'control-intent.records'),
            legacyPath: join(ctx.profileContext.dir, 'control-intent.fixture.json'), trustedRoot: ctx.profileContext.dir }).read();
        }
        if (input.op === 'product-query-result') {
          const web = ctx.get('web');
          if (!web) throw new Error('Public WebRuntime is not available.');
          return web.search({ query: 'offline shared result budget', maxResults: 1 }, AbortSignal.timeout(5000));
        }
        if (input.op === 'stop') {
          const control = ctx.get('grokSearchControl');
          if (!control?.stop) throw new Error('product control unavailable');
          return await control.stop(input.reason ?? 'cli-web-fixture-stop');
        }
        if (input.op === 'reload-web-with-session-search') {
          if (!input.args?.origin || !input.args.cookie || !input.args.sessionId) {
            throw new Error('Reload/search probe requires origin, cookie and sessionId.');
          }
          const args = input.args;
          const target = entry('web');
          const eventStart = state.sessionEvents.length;
          const requestId = args.requestId ?? randomUUID();
          let reloadStartedAt = null;
          let reloadSettledAt = null;
          let reloadPromise = null;
          const armed = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              stop();
              reject(new Error('Search tool call did not start.'));
            }, 15000);
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
            const finished = state.sessionEvents.slice(eventStart).some(event =>
              event.sessionId === args.sessionId && event.type === 'turn/end'
              && event.data?.reason?.kind === 'completed');
            if (finished) break;
            await new Promise(done => setTimeout(done, 10));
          }
          const events = state.sessionEvents.slice(eventStart)
            .filter(event => event.sessionId === args.sessionId)
            .filter(event => ['tool/call', 'tool/result', 'turn/end'].includes(event.type));
          const toolCall = events.find(event => event.type === 'tool/call' && event.data?.name === 'web_search');
          const toolResult = events.findLast(event => event.type === 'tool/result');
          if (!toolCall || !toolResult || !events.some(event => event.type === 'turn/end'
            && event.data?.reason?.kind === 'completed')) {
            throw new Error('Reload/search turn did not complete.');
          }
          return { ...snapshot(ctx), reloadProbe: {
            reloadStartedAt, reloadSettledAt,
            promptAcceptedAt: Date.now(), toolCallAt: toolCall.time,
            toolResultAt: toolResult.time, overlappedReload: toolCall.time <= reloadSettledAt,
            toolResult: toolResult.data?.message ?? null,
            originalSearchCounter: ctx.get('grokSearchOriginalSearchCounter')?.snapshot?.() ?? null } };
        }
        if (input.op === 'plugin-manager-state') {
          const manager = ctx.get('pluginManager');
          if (!manager) throw new Error('Official pluginManager service absent.');
          const bundles = (await manager.listBundles()).map(({ name, version, enabled, removable, error }) => ({
            name, version: version ?? null, enabled, removable, error: error ? String(error) : null }));
          const plugins = (await manager.listPlugins()).filter(row => row.moduleName?.startsWith('dsh-grok-search'))
            .map(({ entryId, moduleName, enabled, readOnlyReason }) => ({ entryId, moduleName, enabled,
              readOnlyReason: readOnlyReason ?? null }));
          return { bundles, plugins };
        }
        if (input.op === 'plugin-manager-set-bundle') {
          const manager = ctx.get('pluginManager');
          if (!manager?.setBundleEnabled) throw new Error('Official pluginManager service absent.');
          return await manager.setBundleEnabled(input.args.name, input.args.enabled === true);
        }
        if (input.op === 'plugin-manager-remove') {
          const manager = ctx.get('pluginManager');
          if (!manager?.removeBundle) throw new Error('Official pluginManager service absent.');
          return await manager.removeBundle(input.args.name);
        }
        throw new Error('unknown fixture operation');
      });
      operation = work.catch(() => {});
      send(200, { ok: true, value: await work });
    } catch (error) {
      send(500, {
        ok: false,
        error: { code: error?.code ?? null, message: error?.message ?? String(error) },
      });
    }
  });

  ctx.effect(() => () => new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close(error => error ? reject(error) : resolve());
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const origin = 'http://127.0.0.1:' + ctx.webServer.port;
      const value = {
        runId: process.env.DSH_CLI_WEB_RUN_ID,
        pid: process.pid,
        probePort: server.address().port,
        probeToken: token,
        hostOrigin: origin,
        authUrl: ctx.connection.authenticatedUrl(origin + '/'),
        workspace: process.env.DSH_CLI_WEB_WORKSPACE,
      };
      try {
        writeFileSync(readyFile, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}
