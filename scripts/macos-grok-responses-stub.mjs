import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const readyFile = process.argv[2];
const receiptFile = process.argv[3];
if (!readyFile || !receiptFile) {
  throw new Error('Usage: node scripts/macos-grok-responses-stub.mjs <ready-file> <receipt-file>');
}

const syntheticKey = 'dsh-grok-search-local-test-key';
const requests = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => {
    if (body.length < 1024 * 1024) body += chunk;
  });
  request.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(body); } catch {}
    const authorized = request.headers.authorization === `Bearer ${syntheticKey}`;
    if (request.method === 'POST' && request.url === '/__shutdown' && authorized) {
      response.writeHead(202, { 'cache-control': 'no-store' });
      response.end();
      close();
      return;
    }
    requests.push({
      method: request.method,
      path: request.url,
      authorizedWithSyntheticKey: authorized,
      model: payload?.model ?? null,
    });
    if (request.method !== 'POST' || request.url !== '/v1/responses' || !authorized) {
      response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { message: 'local test authorization rejected' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({
      id: `resp-${requests.length}`,
      object: 'response',
      status: 'completed',
      model: payload.model,
      output_text: 'macOS Grok local Responses stub succeeded.',
      output: [{
        type: 'web_search_call',
        action: {
          sources: [{
            url: 'https://example.invalid/grok-search-rs-macos',
            title: 'Local Grok Responses stub',
            description: 'Served by the isolated macOS gate.',
          }],
        },
      }, {
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'macOS Grok local Responses stub succeeded.',
        }],
      }],
    }));
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
writeFileSync(readyFile, JSON.stringify({
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  syntheticKey,
}) + '\n', { flag: 'wx' });

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close(() => {
    writeFileSync(receiptFile, JSON.stringify({
      requestCount: requests.length,
      requests,
      syntheticKeyOnly: requests.length > 0 && requests.every(item => item.authorizedWithSyntheticKey),
    }, null, 2) + '\n', { flag: 'wx' });
    process.exitCode = requests.length > 0 && requests.every(item => item.authorizedWithSyntheticKey) ? 0 : 1;
  });
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
