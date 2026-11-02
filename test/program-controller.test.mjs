import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgramController } from '../src/program.mjs';
import { createGrokProvider } from '../src/provider.mjs';
import { GrokSearchError } from '../src/core/errors.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup(resolveProgram) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-program-controller-'));
  return createProgramController({ configuration: {}, directory: root, env: () => ({ HOME: root }), resolveProgram });
}
const program = { found: true, path: process.execPath, version: '0.1.26', source: 'test-only', sha256: '0'.repeat(64) };

test('program preparation does not block mounting and provider becomes ready without restart', async () => {
  const gate = deferred();
  const manager = setup(() => gate.promise);
  const core = createGrokProvider({ configuration: {}, executionConfiguration: manager.execution,
    runQuery: async config => {
      assert.equal(config.executable, process.execPath);
      return { content: 'ready', sources: [], truncated: false };
    } });
  try {
    const preparing = manager.prepare();
    assert.equal(core.provider.available(), false);
    assert.equal(manager.snapshot().phase, 'discovering');
    await assert.rejects(core.provider.search({ query: 'early' }), error => error.code === 'GROK_PROGRAM_PREPARING');
    gate.resolve(program);
    await preparing;
    assert.equal(core.provider.available(), true);
    assert.equal(manager.snapshot().phase, 'ready');
    assert.equal((await core.provider.search({ query: 'late' })).content, 'ready');
  } finally { await Promise.all([manager.dispose(), core.dispose()]); }
});
test('preparation failure stays explicit and retry is not a fabricated ready state', async () => {
  let calls = 0;
  const manager = setup(async () => { if (calls++ === 0) throw new GrokSearchError('GROK_DOWNLOAD_UNAVAILABLE', 'offline'); return program; });
  await assert.rejects(manager.prepare(), error => error.code === 'GROK_DOWNLOAD_UNAVAILABLE');
  assert.equal(manager.snapshot().phase, 'error');
  assert.throws(manager.execution, error => error.code === 'GROK_DOWNLOAD_UNAVAILABLE');
  await manager.prepare();
  assert.equal(manager.snapshot().phase, 'ready');
  await manager.dispose();
});
test('simultaneous prepare requests share one discovery or download operation', async () => {
  const gate = deferred(); let calls = 0;
  const manager = setup(() => { calls++; return gate.promise; });
  const first = manager.prepare(), second = manager.prepare();
  gate.resolve(program);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  await manager.dispose();
});
test('disposed controller cannot be revived by a late preparation result', async () => {
  const gate = deferred();
  const manager = setup(() => gate.promise);
  const rejection = assert.rejects(manager.prepare(), error => error.code === 'GROK_SEARCH_STOPPING');
  const disposal = manager.dispose();
  gate.resolve(program);
  await Promise.all([rejection, disposal]);
  assert.equal(manager.snapshot().phase, 'disposed');
  assert.throws(manager.execution, error => error.code === 'GROK_SEARCH_STOPPING');
});
test('unreaped verification process prevents retry from launching a replacement', async () => {
  let calls = 0;
  const manager = setup(async () => { calls++; throw new GrokSearchError('GROK_PROGRAM_REAP_FAILED', 'not reaped'); });
  await assert.rejects(manager.prepare());
  await assert.rejects(manager.prepare());
  assert.equal(calls, 1);
  await manager.dispose();
});
