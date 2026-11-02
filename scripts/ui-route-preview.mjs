import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { project, freshRun, writeJson } from './lib/internal-candidate-utils.mjs';
import { join } from 'node:path';

const { runId, directory } = freshRun('ui-route-browser');
const runs = new Map([[runId, directory]]);
const allowed = new Map([
  ['/', ['fixtures/ui-route-harness.html', 'text/html; charset=utf-8']],
  ['/fixtures/ui-route-harness.mjs', ['fixtures/ui-route-harness.mjs', 'text/javascript; charset=utf-8']],
  ['/src/client.js', ['src/client.js', 'text/javascript; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/evidence' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 1_000_000) { response.writeHead(413); response.end(); return; }
    }
    try {
      const value = JSON.parse(body);
      if (JSON.stringify(value).includes('synthetic-key')) throw new Error('Evidence must not contain key values.');
      const output = runs.get(value.runId);
      if (!output) throw new Error('Unknown runId.');
      writeJson(join(output, 'summary.json'), value);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ runId: value.runId, directory: output }));
    } catch (error) { response.writeHead(400); response.end(error.message); }
    return;
  }
  if (url.pathname === '/begin' && request.method === 'POST') {
    const run = freshRun('ui-route-browser');
    runs.set(run.runId, run.directory);
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(run)); return;
  }
  if (url.pathname === '/info') {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ runId, directory })); return;
  }
  const file = allowed.get(url.pathname);
  if (!file) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
  response.end(readFileSync(join(project, file[0])));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({
  runId, directory, origin: `http://127.0.0.1:${server.address().port}`,
})));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
