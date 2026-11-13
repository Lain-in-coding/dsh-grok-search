import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { effectiveConfig } from '../src/core/product-control.mjs';
import { createToolBudgetController } from '../src/core/tool-budget.mjs';

const BUDGET_MS = 90_000;
const AUTHOR_CONFIG = { search: true, searchTimeoutMs: 60_000, fetchTimeoutMs: 23_000, fetch: false };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Synthetic lifecycle seams cover both config shapes, not a real host load.
function fixture({ modern, beforeUpdate = () => {}, afterUpdate = () => {}, settle = () => {} }) {
  const hooks = new Map(), calls = [], awaits = [], errors = [];
  const runtime = { name: 'tool-web', fibers: new Set() };
  const ctx = {
    registry: new Map([['tool-web', runtime]]),
    on: (name, callback) => hooks.set(name, callback),
  };
  const controller = createToolBudgetController({
    ctx, budgetMs: BUDGET_MS, required: () => true,
    resolveConfig: (_runtime, raw) => structuredClone(raw),
    onError: error => errors.push(error),
  });
  const resolveCandidate = (fiber, raw) => hooks.get('internal/config').call(
    fiber, modern ? fiber : raw, () => structuredClone(raw),
  );
  function addFiber(raw = AUTHOR_CONFIG, options = {}) {
    const fiber = {
      uid: runtime.fibers.size + 1, state: 2, runtime,
      entry: { options: { name: '@deepseek-ai/dsh-tool-web', ...options, config: structuredClone(raw) } },
      config: structuredClone(raw),
    };
    if (modern) {
      fiber.effectiveConfig = structuredClone(raw);
      fiber.resolveConfig = candidate => resolveCandidate(fiber, candidate);
    }
    let currentCall;
    fiber.update = async (config, forced) => {
      const call = { fiber, raw: structuredClone(config), forced, index: calls.length + 1 };
      calls.push(call);
      currentCall = call;
      await beforeUpdate(call);
      if (modern) fiber.config = structuredClone(config);
      const candidate = resolveCandidate(fiber, config);
      hooks.get('internal/update').call(fiber, () => {
        if (modern) fiber.effectiveConfig = candidate;
        else fiber.config = candidate;
      });
      await afterUpdate(call);
    };
    fiber.await = async () => {
      awaits.push(currentCall);
      await settle(currentCall);
    };
    runtime.fibers.add(fiber);
    return fiber;
  }
  const fiber = addFiber();
  const rawConfig = target => modern ? target.config : target.entry.options.config;
  const authorUpdate = async (target, raw) => {
    target.entry.options.config = structuredClone(raw);
    await target.update(raw, true);
    await target.await();
  };
  return { controller, fiber, calls, awaits, errors, addFiber, rawConfig, authorUpdate, resolveCandidate };
}

for (const modern of [false, true]) {
  const label = modern ? 'modern raw/effective config' : 'legacy resolved config';

  test(`${label}: a failed refresh rejects its caller and a later acquire succeeds`, async () => {
    const failure = new Error('first update failed');
    const h = fixture({ modern, beforeUpdate: ({ index }) => { if (index === 1) throw failure; } });
    await assert.rejects(h.controller.acquire(), error => error === failure);
    assert.deepEqual(h.controller.snapshot(), { budgetMs: BUDGET_MS, owned: 0, releasing: false });
    assert.deepEqual(effectiveConfig(h.fiber), AUTHOR_CONFIG);

    await h.controller.acquire();
    assert.equal(h.calls.length, 2);
    assert.equal(effectiveConfig(h.fiber).searchTimeoutMs, BUDGET_MS);
    assert.equal(h.controller.snapshot().owned, 1);
    assert.deepEqual(h.rawConfig(h.fiber), AUTHOR_CONFIG);

    await h.controller.release();
    assert.deepEqual(effectiveConfig(h.fiber), AUTHOR_CONFIG);
    assert.equal(h.controller.snapshot().owned, 0);
    assert.deepEqual(h.errors, []);
  });

  test(`${label}: concurrent acquires wait for both update and fiber settlement`, async () => {
    const updateStarted = deferred(), updateGate = deferred();
    const awaitStarted = deferred(), awaitGate = deferred();
    const h = fixture({
      modern,
      afterUpdate: async ({ index }) => {
        if (index !== 1) return;
        updateStarted.resolve();
        await updateGate.promise;
      },
      settle: async ({ index }) => {
        if (index !== 1) return;
        awaitStarted.resolve();
        await awaitGate.promise;
      },
    });
    const first = h.controller.acquire(), second = h.controller.acquire(), third = h.controller.acquire();
    await updateStarted.promise;
    await nextTurn();
    assert.equal(h.calls.length, 1);
    assert.equal(h.awaits.length, 0);

    updateGate.resolve();
    await awaitStarted.promise;
    await nextTurn();
    assert.equal(h.calls.length, 1);
    awaitGate.resolve();
    await Promise.all([first, second, third]);
    assert.deepEqual(h.calls.map(call => call.index), [1, 2, 3]);
    assert.deepEqual(h.awaits.map(call => call.index), [1, 2, 3]);
    assert.ok(h.calls.every(call => call.forced === true));
    assert.equal(h.controller.snapshot().owned, 1);
    await h.controller.release();
    assert.deepEqual(effectiveConfig(h.fiber), AUTHOR_CONFIG);
  });

  test(`${label}: release waits for an in-flight refresh and skips queued acquires`, async () => {
    const updateStarted = deferred(), updateGate = deferred();
    const awaitStarted = deferred(), awaitGate = deferred();
    const h = fixture({
      modern,
      afterUpdate: async ({ index }) => {
        if (index !== 1) return;
        updateStarted.resolve();
        await updateGate.promise;
      },
      settle: async ({ index }) => {
        if (index !== 1) return;
        awaitStarted.resolve();
        await awaitGate.promise;
      },
    });
    const acquisition = h.controller.acquire(), queued = h.controller.acquire();
    await updateStarted.promise;
    let released = false;
    const release = h.controller.release().then(() => { released = true; });
    await nextTurn();
    assert.equal(released, false);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.controller.snapshot(), { budgetMs: BUDGET_MS, owned: 1, releasing: true });

    updateGate.resolve();
    await awaitStarted.promise;
    await nextTurn();
    assert.equal(released, false);
    assert.equal(h.calls.length, 1);
    awaitGate.resolve();
    await Promise.all([acquisition, queued, release]);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].raw, AUTHOR_CONFIG);
    assert.deepEqual(effectiveConfig(h.fiber), AUTHOR_CONFIG);
    assert.deepEqual(h.fiber.entry.options.config, AUTHOR_CONFIG);
    assert.deepEqual(h.controller.snapshot(), { budgetMs: BUDGET_MS, owned: 0, releasing: true });
    await h.controller.acquire();
    assert.equal(h.calls.length, 2);
  });

  test(`${label}: release reports a settled acquire failure and restores its partial lease`, async () => {
    const failure = new Error('fiber settlement failed');
    const h = fixture({ modern, settle: ({ index }) => { if (index === 1) throw failure; } });
    await assert.rejects(h.controller.acquire(), error => error === failure);
    assert.equal(h.controller.snapshot().owned, 1);
    assert.equal(effectiveConfig(h.fiber).searchTimeoutMs, BUDGET_MS);

    await h.controller.release();
    assert.deepEqual(h.errors, [failure]);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(effectiveConfig(h.fiber), AUTHOR_CONFIG);
    assert.equal(h.controller.snapshot().owned, 0);
  });

  test(`${label}: release observes an in-flight acquire rejection before restoring its lease`, async () => {
    const updateStarted = deferred(), updateGate = deferred();
    const failure = new Error('in-flight refresh failed');
    const h = fixture({
      modern,
      afterUpdate: async ({ index }) => {
        if (index !== 1) return;
        updateStarted.resolve();
        await updateGate.promise;
      },
    });
    const acquisition = h.controller.acquire();
    const rejected = assert.rejects(acquisition, error => error === failure);
    await updateStarted.promise;
    const release = h.controller.release();
    assert.deepEqual(h.errors, []);
    updateGate.reject(failure);
    await Promise.all([rejected, release]);
    assert.deepEqual(h.errors, [failure]);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(effectiveConfig(h.fiber), AUTHOR_CONFIG);
    assert.equal(h.controller.snapshot().owned, 0);
  });

  test(`${label}: author updates yield ownership and release retains later unrelated raw edits`, async () => {
    const h = fixture({ modern });
    const retained = h.addFiber({ ...AUTHOR_CONFIG, fetchTimeoutMs: 19_000 });
    const disabled = h.addFiber(AUTHOR_CONFIG, { disabled: true });
    const noSearch = h.addFiber({ ...AUTHOR_CONFIG, search: false });
    const unrelated = h.addFiber(AUTHOR_CONFIG, { name: 'another-tool' });
    await h.controller.acquire();
    assert.equal(h.calls.length, 2);
    assert.equal(h.controller.snapshot().owned, 2);

    const author = { ...AUTHOR_CONFIG, searchTimeoutMs: 42_000, fetchTimeoutMs: 27_000 };
    await h.authorUpdate(h.fiber, author);
    assert.equal(h.controller.snapshot().owned, 1);
    await h.controller.acquire();
    assert.equal(h.calls.filter(call => call.fiber === h.fiber).length, 2);
    assert.deepEqual(effectiveConfig(h.fiber), author);

    h.rawConfig(retained).fetchTimeoutMs = 31_000;
    h.rawConfig(retained).authorOption = 'retained';
    await h.controller.release();
    assert.deepEqual(effectiveConfig(h.fiber), author);
    assert.deepEqual(effectiveConfig(retained), { ...AUTHOR_CONFIG, fetchTimeoutMs: 31_000, authorOption: 'retained' });
    assert.deepEqual(effectiveConfig(disabled), AUTHOR_CONFIG);
    assert.deepEqual(effectiveConfig(noSearch), { ...AUTHOR_CONFIG, search: false });
    assert.deepEqual(effectiveConfig(unrelated), AUTHOR_CONFIG);
    assert.equal(h.calls.filter(call => call.fiber === h.fiber).length, 2);
    assert.equal(h.controller.snapshot().owned, 0);
  });

  test(`${label}: validating an author candidate does not release a live lease`, async () => {
    const h = fixture({ modern });
    await h.controller.acquire();
    const candidate = { ...AUTHOR_CONFIG, searchTimeoutMs: 35_000 };
    assert.deepEqual(h.resolveCandidate(h.fiber, candidate), candidate);
    assert.equal(h.controller.snapshot().owned, 1);
    assert.equal(effectiveConfig(h.fiber).searchTimeoutMs, BUDGET_MS);
    await h.controller.release();
    assert.deepEqual(effectiveConfig(h.fiber), AUTHOR_CONFIG);
    assert.equal(h.calls.length, 2);
  });

  test(`${label}: release does not overwrite a runtime timeout changed by another owner`, async () => {
    const h = fixture({ modern });
    await h.controller.acquire();
    effectiveConfig(h.fiber).searchTimeoutMs = 45_000;
    await h.controller.release();
    assert.equal(effectiveConfig(h.fiber).searchTimeoutMs, 45_000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.controller.snapshot().owned, 0);
  });
}
