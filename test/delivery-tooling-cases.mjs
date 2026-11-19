import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { mkdtempTracked } from './helpers/temp-fixture.mjs';
import { connectRenderer } from '../scripts/lib/renderer-cdp.mjs';

const fixtureHelper = new URL('./helpers/temp-fixture.mjs', import.meta.url).href;

function cleanupProbe(mode) {
  const root = mkdtempTracked(join(tmpdir(), 'dsh-tooling-cleanup-'));
  const parent = join(root, 'parent'); mkdirSync(parent);
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join, basename } from 'node:path';
    const mode = process.env.FIXTURE_MODE, root = process.env.FIXTURE_ROOT;
    const parent = join(root, 'parent');
    if (mode === 'remove-error') {
      fs.rmSync = () => { throw Object.assign(new Error('synthetic-private-message'), { code: 'EACCES' }); };
      syncBuiltinESMExports();
    }
    const { mkdtempTracked } = await import(${JSON.stringify(fixtureHelper)});
    const path = mkdtempTracked(join(parent, 'dsh-owned-'));
    fs.writeFileSync(join(path, 'sentinel'), 'owned');
    if (mode === 'child-replaced') {
      fs.renameSync(path, join(root, 'original-child'));
      fs.mkdirSync(path); fs.writeFileSync(join(path, 'sentinel'), 'replacement');
    }
    if (mode === 'parent-replaced') {
      fs.renameSync(parent, join(root, 'original-parent'));
      fs.mkdirSync(parent);
      fs.renameSync(join(root, 'original-parent', basename(path)), path);
    }
    if (mode === 'parent-link') {
      fs.renameSync(parent, join(root, 'original-parent'));
      fs.symlinkSync(join(root, 'original-parent'), parent, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (mode === 'child-link') {
      fs.renameSync(path, join(root, 'original-child'));
      fs.symlinkSync(join(root, 'original-child'), path, process.platform === 'win32' ? 'junction' : 'dir');
    }
    process.on('exit', () => console.log(JSON.stringify({ exists: fs.existsSync(path) })));
    if (mode === 'nonzero') process.exitCode = 7;
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, RUNNER_TEMP: parent, FIXTURE_ROOT: root, FIXTURE_MODE: mode,
      DSH_KEEP_TEST_FIXTURES: mode === 'keep' ? '1' : '0' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, mode === 'nonzero' ? 7 : 0, result.stderr);
  return { ...JSON.parse(result.stdout.trim()), stderr: result.stderr, root };
}

test('fixture cleanup deletes original ordinary directories and honors retention', () => {
  assert.equal(cleanupProbe('ordinary').exists, false);
  for (const mode of ['keep', 'nonzero']) assert.equal(cleanupProbe(mode).exists, true, mode);
});

for (const mode of ['child-replaced', 'parent-replaced', 'parent-link', 'child-link', 'remove-error']) {
  test(`fixture cleanup retains and safely reports ${mode}`, () => {
    const result = cleanupProbe(mode);
    assert.equal(result.exists, true, 'Never remove a replacement or redirected fixture.');
    assert.match(result.stderr, /TEST_FIXTURE_CLEANUP/);
    assert.doesNotMatch(result.stderr, /synthetic-private-message/);
    assert.equal(result.stderr.includes(result.root), false, 'Diagnostics must not expose private temporary paths.');
  });
}

test('fixture cleanup does not adopt existing directories or out-of-root prefixes', () => {
  const root = mkdtempTracked(join(tmpdir(), 'dsh-tooling-cleanup-scope-'));
  const parent = join(root, 'ordinary'); mkdirSync(parent);
  const existing = join(parent, 'dsh-existing'); mkdirSync(existing);
  const script = `
    import { mkdtempTracked } from ${JSON.stringify(fixtureHelper)};
    console.log(JSON.stringify({ created: mkdtempTracked(process.env.FIXTURE_PREFIX) }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, RUNNER_TEMP: '', FIXTURE_PREFIX: join(parent, 'dsh-unowned-') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(existing), true);
  assert.equal(existsSync(JSON.parse(result.stdout).created), true);
});

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Disconnect did not settle promptly.')), 250);
    })]);
  } finally { clearTimeout(timer); }
}

async function rendererFixture(t, setup = 'open') {
  let socket;
  class Socket extends EventTarget {
    readyState = 0;
    sent = [];
    closeCount = 0;
    constructor() {
      super(); socket = this;
      queueMicrotask(() => {
        if (setup === 'close-before-open') { this.readyState = 3; this.dispatchEvent(new Event('close')); }
        else { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      });
    }
    send(bytes) {
      const request = JSON.parse(bytes); this.sent.push(request);
      if (request.method === 'Runtime.enable') queueMicrotask(() => {
        if (setup === 'close-during-enable') { this.readyState = 3; this.dispatchEvent(new Event('close')); }
        else this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result: {} }) }));
      });
      if (request.method === 'throw') throw new Error('synthetic send failure');
    }
    close() { this.closeCount++; this.readyState = 3; }
  }
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true,
    json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:1/fixture' }],
  }));
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; socket?.close(); });
  const connection = connectRenderer(1, { timeoutMs: 1_000, requestTimeoutMs: 2_000 });
  return { connection, socket: () => socket };
}

for (const signal of ['close', 'error', 'explicit-close', 'send-error']) {
  test(`renderer rejects pending and future requests on ${signal}`, async t => {
    const fixture = await rendererFixture(t), renderer = await fixture.connection, socket = fixture.socket();
    const requests = [renderer.send('pending-one'), renderer.evaluate('pending-two')];
    const settled = Promise.allSettled(requests);
    if (signal === 'explicit-close') renderer.close();
    else if (signal === 'send-error') await assert.rejects(renderer.send('throw'));
    else { if (signal === 'close') socket.readyState = 3; socket.dispatchEvent(new Event(signal)); }
    const results = await within(settled);
    assert.ok(results.every(row => row.status === 'rejected'));
    assert.ok(results.every(row => !/timed out/.test(row.reason.message)));
    const sent = socket.sent.length;
    await assert.rejects(within(renderer.send('future')), /closed|disconnect|failed|send failure/i);
    assert.equal(socket.sent.length, sent, 'Disconnected calls must not reach socket.send.');
    if (signal !== 'close') assert.ok(socket.closeCount > 0);
  });
}

for (const setup of ['close-before-open', 'close-during-enable']) {
  test(`renderer setup rejects immediately on ${setup}`, async t => {
    const fixture = await rendererFixture(t, setup);
    await assert.rejects(within(fixture.connection), /closed|disconnect/i);
    assert.ok(fixture.socket().closeCount > 0);
  });
}

test('B2 advanced read-only probes use complete attribute selectors', async () => {
  const source = readFileSync(new URL('../scripts/b2-plugin-manager-desktop.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("    check('program path read-only'");
  const end = source.indexOf("    check('close advanced'", start);
  assert.ok(start >= 0 && end > start);
  const selectors = [];
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    q(selector) {
      assert.match(selector, /^input\[data-k=(exeOverride|cfgOverride|budget)\]$/);
      selectors.push(selector); return '({ readOnly: true })';
    },
    renderer: { evaluate: async expression => runInNewContext(expression) },
    check: (_, value) => assert.equal(value, true),
  });
  assert.equal(selectors.length, 3);
});
