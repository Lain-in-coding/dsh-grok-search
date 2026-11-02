// 内部候选的外部离线 MCP 进程；只记录夹具事实，不访问网络。
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
const [controlPath, eventsPath] = process.argv.slice(2);
const mode = JSON.parse(readFileSync(controlPath, 'utf8')).mode;
const input = createInterface({ input: process.stdin });
const keepalive = setInterval(() => {}, 10_000);
const event = (type, extra = {}) => appendFileSync(eventsPath, JSON.stringify({ type, mode, pid: process.pid, ...extra }) + '\n');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, payload) => send({ id, result: { ...(mode === 'text-json' ? {} : { structuredContent: payload }), content: [{ type: 'text', text: JSON.stringify(payload) }] } });
let initialized = false;
event('spawn');
input.on('line', line => {
  const request = JSON.parse(line);
  event('request', { method: request.method, ...(request.params?.name ? { tool: request.params.name } : {}) });
  if (request.method === 'initialize') return send({ id: request.id, result: { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: '离线内部候选', version: '0.1.26-fixture' } } });
  if (request.method === 'notifications/initialized') { initialized = true; return; }
  if (request.method === 'tools/list') return send({ id: request.id, result: { tools: ['web_search', 'get_sources'].map(name => ({ name, inputSchema: { type: 'object' } })) } });
  if (request.method !== 'tools/call') return;
  if (!initialized) return send({ id: request.id, error: { code: -32602, message: '初始化未完成' } });
  if (request.params.name === 'get_sources') return reply(request.id, { sources: [{ url: 'https://example.invalid/second', title: '第二条' }], truncated: false });
  if (request.params.name !== 'web_search' || request.params.arguments.response_format !== 'concise') return send({ id: request.id, error: { code: -32602, message: '夹具请求无效' } });
  if (mode === 'hang') return;
  if (mode === 'rpc-error') return send({ id: request.id, error: { code: -32001, message: 'api_key=fixture-private-value' } });
  if (mode === 'tool-error') return send({ id: request.id, result: { isError: true, content: [{ type: 'text', text: 'Authorization: Bearer fixture-private-value' }] } });
  const payload = { content: '内部候选离线搜索成功', sources: [{ url: 'https://example.invalid/first', title: '第一条', description: '离线来源' }],
    truncated: false, search_provider: 'offline-fixture', fallback_used: false };
  if (mode === 'invalid-result') payload.sources = 'invalid';
  if (mode === 'sources') Object.assign(payload, { sources_count: 2, session_id: 'candidate-source-session', truncated: true });
  reply(request.id, payload);
});
input.on('close', () => { event('stdin-closed'); clearInterval(keepalive); process.stdout.end(); });
process.on('exit', code => { event('exit', { code }); });
