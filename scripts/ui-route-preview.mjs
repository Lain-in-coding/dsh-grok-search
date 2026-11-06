import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { project, freshRun, writeJson, sha256 } from './lib/internal-candidate-utils.mjs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--live-evidence')) {
  throw new Error('Usage: node scripts/ui-route-preview.mjs [--live-evidence <redacted-summary.json>]');
}
let liveEvidence = null;
if (args.length) {
  const input = resolve(args[1]);
  const evidence = JSON.parse(readFileSync(input, 'utf8'));
  if (evidence.scope !== 'real-credentials-packaged-core-no-desktop' || evidence.keysSaved !== false
    || evidence.rawResponsesSaved !== false || evidence.invariantsPassed !== true) {
    throw new Error('Only a secret-free live verification summary can seed visual verification.');
  }
  // Deliberately do not expose source paths, request headers, keys or raw results.
  liveEvidence = { runId: evidence.runId, sha256: sha256(input),
    logs: evidence.results.filter(row => row.log).map((row, index) => ({
      ...row.log, id: `search-log-${index + 1}`, at: Date.now() - index * 1000,
      q: 'DeepSeek Harness GitHub official repository', detail: '',
    })),
    quotas: Object.fromEntries(evidence.results.filter(row => row.case.startsWith('quota-') && row.quota?.value)
      .map(row => [row.case.slice(6), row.quota.value])) };
}

const { runId, directory } = freshRun('ui-route-browser');
const runs = new Map([[runId, directory]]);
const sourceHashes = ['src/client.js', 'src/client.template.js', 'src/ui/route-controller.mjs',
  'src/ui/search-log-view.mjs', 'src/ui/quota-view.mjs', 'src/ui/route.css', 'src/ui/search-log.css',
  'src/ui/route-card.html', 'src/settings-ui.mjs', 'fixtures/ui-route-harness.mjs', 'fixtures/ui-route-harness.html',
  'test/ui-search-log-browser.js', 'test/ui-route-browser.js', 'test/ui-settings-performance-browser.js',
  ...(liveEvidence ? ['test/ui-search-log-live-browser.js'] : [])].map(file => ({ file, sha256: sha256(join(project, file)) }));
const allowed = new Map([
  ['/', ['fixtures/ui-route-harness.html', 'text/html; charset=utf-8']],
  ['/fixtures/ui-route-harness.mjs', ['fixtures/ui-route-harness.mjs', 'text/javascript; charset=utf-8']],
  ['/src/client.js', ['src/client.js', 'text/javascript; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (request.headers.host !== `127.0.0.1:${server.address().port}`) {
    response.writeHead(403); response.end(); return;
  }
  if (request.method === 'POST' && request.headers.origin !== origin) {
    response.writeHead(403); response.end(); return;
  }
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
      if (existsSync(join(output, 'summary.json'))) throw new Error('Evidence already committed.');
      const hashesNow = sourceHashes.map(({ file }) => ({ file, sha256: sha256(join(project, file)) }));
      if (JSON.stringify(hashesNow) !== JSON.stringify(sourceHashes)) throw new Error('Source changed; restart preview before recording evidence.');
      writeJson(join(output, 'summary.json'), { ...value, sourceHashes });
      runs.delete(value.runId);
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
  if (url.pathname === '/live-evidence' && request.method === 'GET' && liveEvidence) {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(liveEvidence)); return;
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
