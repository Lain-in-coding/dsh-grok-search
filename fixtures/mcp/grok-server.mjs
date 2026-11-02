// Offline MCP peer for the Grok smoke helper. Never contacts an upstream service.
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'structured';
const lines = createInterface({ input: process.stdin });
let initialized = false;
let answered = false;
const keepalive = setInterval(() => {}, 10_000);

function send(message, fragmented = false) {
  const wire = JSON.stringify(message) + '\n';
  if (!fragmented) { process.stdout.write(wire); return; }
  const bytes = Buffer.from(wire);
  const unicodeStart = bytes.indexOf(Buffer.from('中'));
  const midpoint = unicodeStart < 0 ? Math.floor(bytes.length / 2) : unicodeStart + 1;
  process.stdout.write(bytes.subarray(0, midpoint));
  setTimeout(() => process.stdout.write(bytes.subarray(midpoint)), 5);
}

function result(id, value, fragmented) {
  send({ jsonrpc: '2.0', id, result: value }, fragmented);
}

lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    if (mode === 'init-hang') return;
    if (mode === 'init-exit') { process.exit(23); return; }
    if (mode === 'init-error') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'api_key=never-retain-this-secret' } });
      return;
    }
    result(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'offline-grok-fixture', version: '0.1.26-fixture' },
    }, mode === 'fragmented');
    return;
  }
  if (request.method === 'notifications/initialized') { initialized = true; return; }
  if (request.method === 'notifications/cancelled') {
    if (mode === 'cancel') process.exit(0);
    return;
  }
  if (request.method === 'tools/list') {
    result(request.id, { tools: [{ name: 'web_search', description: 'Offline fixture', inputSchema: { type: 'object' } }] });
    return;
  }
  if (request.method !== 'tools/call') return;
  if (!initialized || request.params.name !== 'web_search' || request.params.arguments.response_format !== 'concise') {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'invalid fixture handshake or call' } });
    return;
  }
  if (mode === 'call-hang' || mode === 'cancel') return;
  if (mode === 'call-exit') { process.exit(24); return; }
  if (mode === 'stdout-limit') { process.stdout.write('x'.repeat(100_000)); return; }
  if (mode === 'invalid-json') { process.stdout.write('{"jsonrpc":"2.0","id":\n'); return; }
  if (mode === 'invalid-frame') { process.stdout.write('{"jsonrpc":"2.0","id":{},"result":{}}\n'); return; }
  if (mode === 'rpc-error') {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Authorization: Bearer never-retain-this-secret' } });
    return;
  }
  if (mode === 'tool-error') {
    result(request.id, { isError: true, content: [{ type: 'text', text: 'GROK_API_KEY=never-retain-this-secret' }] });
    return;
  }
  const payload = {
    content: JSON.stringify({
      query: request.params.arguments.query,
      initialized,
      configSelected: process.env.GROK_SEARCH_CONFIG === process.env.FIXTURE_EXPECT_CONFIG,
      inheritedSecret: process.env.GROK_FIXTURE_PARENT_SECRET ?? null,
      explicitValue: process.env.GROK_FIXTURE_EXPLICIT ?? null,
      childPid: process.pid,
    }),
    sources: [{ url: 'https://example.invalid/grok-fixture', title: 'Fixture', description: 'Offline source', published_date: '2026-10-15' }],
    search_provider: 'offline-fixture',
    fallback_used: mode === 'fallback',
    truncated: mode === 'fallback',
  };
  if (mode === 'stderr') process.stderr.write('api_key=never-retain-this-secret\n'.repeat(10_000));
  if (mode === 'malformed-result') payload.sources = 'not-an-array';
  answered = true;
  const response = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  if (mode !== 'text-json') response.structuredContent = payload;
  if (mode === 'coalesced') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'offline fixture notification' } }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: request.id, result: response }) + '\n');
  } else result(request.id, response, mode === 'fragmented');
});

lines.on('close', () => {
  if (mode === 'ignore-eof') return;
  clearInterval(keepalive);
  // Do not cut off a pending stdout write or the stderr-redaction test.
  process.stdout.end();
  if (!answered && mode !== 'init-hang' && mode !== 'call-hang') process.exitCode = 0;
});
