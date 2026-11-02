// 来源分页与合并帧的离线夹具，不访问网络。
import { createInterface } from 'node:readline';
const mode = process.argv[2] ?? 'sources';
const input = createInterface({ input: process.stdin });
const keepalive = setInterval(() => {}, 10_000);
let ready = false;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (id, payload) => send({ id, result: { structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] } });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') return send({ id: request.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: '离线分页夹具', version: '0.1.26-fixture' } } });
  if (request.method === 'notifications/initialized') { ready = true; return; }
  if (request.method === 'tools/list') return send({ id: request.id, result: { tools: [
    { name: 'web_search', inputSchema: { type: 'object' } }, { name: 'get_sources', inputSchema: { type: 'object' } },
  ] } });
  if (request.method !== 'tools/call') return;
  if (!ready) return send({ id: request.id, error: { code: -32602, message: '未初始化' } });
  if (request.params.name === 'web_search') {
    if (mode === 'large-coalesced') {
      const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x'.repeat(700) } }) + '\n';
      const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { content: '已完成', sources: [{ url: 'https://example.invalid/a' }] }, content: [] } }) + '\n';
      process.stdout.write(notification.repeat(5) + response); return;
    }
    return result(request.id, { content: '分页摘要', sources: [{ url: 'https://example.invalid/a' }], sources_count: 3, session_id: 'fixture-session', truncated: true });
  }
  if (request.params.name !== 'get_sources') return;
  if (mode === 'source-hang') return;
  if (mode === 'source-rpc-error') return send({ id: request.id, error: { code: -32001, message: '凭据不应回传' } });
  if (mode === 'source-tool-error') return send({ id: request.id, result: { isError: true, content: [{ type: 'text', text: '凭据不应回传' }] } });
  if (request.params.arguments.session_id !== 'fixture-session' || request.params.arguments.offset !== 1 || request.params.arguments.limit !== 2) return send({ id: request.id, error: { code: -32602, message: '补取参数错误' } });
  return result(request.id, { sources: [{ url: 'https://example.invalid/b' }, { url: 'https://example.invalid/c' }], truncated: false });
});
input.on('close', () => { clearInterval(keepalive); process.stdout.end(); });
