import { randomUUID } from 'node:crypto';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'candidate-offline-fixture';
const trace = () => globalThis.__DSH_INTERNAL_CANDIDATE__;
// Manual acceptance only (never set by gates): the latest question becomes the
// search query and the reply states plainly that this is not a DeepSeek model.
const MANUAL_SEARCH_REPLY = '（离线验收模型，不是 DeepSeek）本轮已完成，请查看上方 web_search 工具卡片里的搜索来源。';
const MANUAL_CHAT_REPLY = '（离线验收模型，不是 DeepSeek）普通聊天正常。';

export function applyModel(ctx) {
  const state = trace();
  class FixtureAdapter extends LlmAdapter {
    async *stream(options) {
      state.modelCalls++;
      const userIndex = options.messages.findLastIndex(message => message.role === 'user');
      const messages = options.messages.filter((message, index) => index > userIndex && message.role === 'tool');
      const userTexts = options.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text.trim()))
        .filter(text => text && !text.startsWith('Current runtime context') && !text.startsWith('Generate the session title'));
      const manual = process.env.DSH_MANUAL_ACCEPTANCE === '1';
      const command = manual ? userTexts.at(-1) ?? ''
        : userTexts.findLast(text => /^(?:search|fetch|echo|chat|ptc)(?:\s|$)/.test(text)) ?? userTexts.at(-1) ?? '';
      (state.modelCommands ??= []).push(command);
      const mode = command.split(/\s+/)[0];
      const question = manual && command && !/^(?:search|fetch|echo|chat|ptc)$/.test(mode) ? command.slice(0, 200) : null;
      if (messages.length || mode === 'chat') {
        state.toolMessages.push(...structuredClone(messages)); state.completed++;
        yield { type: 'text-delta', index: 0,
          text: manual ? (messages.length ? MANUAL_SEARCH_REPLY : MANUAL_CHAT_REPLY) : '内部候选轮次完成' };
        yield { type: 'finish', reason: { kind: 'stop' } }; return;
      }
      // The host's actual model-facing catalog is authoritative: 0.2.2 removed
      // DSH_TOOLS_MODE and selects executors per agent scope.
      const toolNames = Array.isArray(options.tools)
        ? options.tools.map(tool => tool.name ?? tool.function?.name)
        : Object.keys(options.tools ?? {});
      const ptcTransport = toolNames.includes('run_code') && !toolNames.includes('web_search');
      const tool = (mode === 'ptc' || (ptcTransport && mode === 'search')) ? { name: 'run_code', args: {
        code: "return await tools.web_search({queries:['内部候选 PTC 离线查询']});",
        description: 'Run the controlled search through PTC',
      } }
        : (ptcTransport && mode === 'fetch') ? { name: 'run_code', args: {
          code: "return await tools.web_fetch({url:'https://example.invalid/fetch'});",
          description: 'Run the controlled fetch through PTC',
        } }
          : mode === 'fetch' ? { name: 'web_fetch', args: { url: 'https://example.invalid/fetch' } }
            : mode === 'echo' ? { name: 'candidate_echo', args: {} }
              : { name: 'web_search', args: { queries: !manual && command === 'search batch'
                ? ['内部候选实时查询', '内部候选逐小时查询']
                : [state.searchQuery ?? question ?? '内部候选离线查询'] } };
      yield { type: 'tool-call-delta', index: 0, id: randomUUID(), name: tool.name, argumentsDelta: JSON.stringify(tool.args) };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
  ctx.llm.registerAdapter(['candidate-offline'], new FixtureAdapter());
  ctx.tools.register({ name: 'candidate_echo', description: '离线普通工具对照。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { state.calls.echo++; return '离线普通工具成功'; },
  });
}
export function applyProviders(ctx) {
  const state = trace();
  ctx.web.registerSearchProvider({ id: 'candidate-original', available: () => true,
    async search() { state.calls.original++; return { content: '作者搜索对照', sources: [], truncated: false }; },
  });
  ctx.web.registerFetchProvider({ id: 'candidate-fetch', available: () => true,
    async fetch(request) { state.calls.fetch++; return { url: request.url, statusCode: 200,
      body: { kind: 'text', content: '离线 fetch 保持' }, truncated: false }; },
  });
}
export function applyExisting(ctx) {
  ctx.provide('candidateExistingDependency', { label: '保留既有依赖' });
  ctx.effect(() => () => { trace().existingDisposed++; });
}
export function applyObserver(ctx) {
  const state = trace();
  if (!ctx.get('grokSearchOriginalSearchCounter')) {
    ctx.provide('grokSearchOriginalSearchCounter', { snapshot: () => ({ calls: state.calls.original }) });
  }
  ctx.on('session/event', (session, event) => {
    if (['turn/start', 'tool/call', 'tool/result', 'assistant/message', 'turn/end'].includes(event.type)) {
      state.sessionEvents.push({ sessionId: session.id, ...structuredClone(event) });
    }
  });
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  process.send?.({ type: 'listening', origin, authUrl: ctx.connection.authenticatedUrl(origin + '/') });
}
