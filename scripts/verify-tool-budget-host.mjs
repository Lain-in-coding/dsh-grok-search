import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createToolBudgetController } from '../src/core/tool-budget.mjs';
import { effectiveConfig } from '../src/core/product-control.mjs';

// Run only against an already installed official runtime. No package install,
// user profile, credentials, network requests or persistent configuration.
const roots = process.argv.slice(2);
if (!roots.length) throw new Error('Provide official runtime directories.');
for (const root of roots) {
  const require = createRequire(pathToFileURL(resolve(root, 'package.json')));
  const { Context, resolveConfig } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const tool = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-web')));
  const app = new Context();
  const definitions = [], entries = new Map();
  let pendingConfig;
  app.provide('tools', { register(definition) { definitions.push(definition); }, get() {} });
  // Service stubs provide registration seams only; the tool implementation,
  // config schema, fibers, restart/update lifecycle and registry are official.
  app.provide('systemPrompt', { getSectionOrder() { return 1; }, section() {} });
  app.provide('web', { searchReady() { return true; }, fetchReady() { return true; } });
  app.on('internal/plugin', fiber => {
    if (fiber.runtime?.name !== 'tool-web') return;
    if (fiber.uid === null) return;
    const entry = { options: { name: '@deepseek-ai/dsh-tool-web', config: structuredClone(pendingConfig) } };
    entries.set(fiber, entry);
    Object.defineProperty(fiber, 'entry', { value: entry, configurable: true });
  }, { global: true, prepend: true });
  const addTool = async config => { pendingConfig = config; await app.plugin(tool, config); };
  // Before the plugin is enabled: the official 60s preset budget is unchanged.
  await addTool({ searchTimeoutMs: 60_000, fetchTimeoutMs: 19_000, fetch: false });
  const before = [...app.registry.get(tool).fibers][0];
  assert.equal(effectiveConfig(before).searchTimeoutMs, 60_000);
  let budgets;
  const owner = app.plugin({ name: 'budget-test-owner', async apply(ctx) {
    budgets = createToolBudgetController({ ctx, budgetMs: 90_000, required: () => true, resolveConfig });
    await budgets.acquire();
  } });
  await owner;
  assert.equal(effectiveConfig(before).searchTimeoutMs, 90_000);
  assert.equal(definitions.at(-1).timeoutMs, 90_000);
  assert.equal(effectiveConfig(before).fetchTimeoutMs, 19_000);
  // New agent / old-preset instances must receive the same runtime lease.
  await addTool({ searchTimeoutMs: 60_000, fetchTimeoutMs: 23_000, fetch: false });
  const later = [...app.registry.get(tool).fibers].find(fiber => fiber !== before);
  assert.equal(effectiveConfig(later).searchTimeoutMs, 90_000);
  await addTool({ search: false, fetch: false, searchTimeoutMs: 31_000 });
  const disabled = [...app.registry.get(tool).fibers].find(fiber => !effectiveConfig(fiber).search);
  assert.equal(effectiveConfig(disabled).searchTimeoutMs, 31_000);
  // A real external update owns its new shorter value, even after restart.
  entries.get(before).options.config = { searchTimeoutMs: 42_000, fetchTimeoutMs: 27_000, fetch: false };
  await before.update(entries.get(before).options.config, true);
  await before.await();
  assert.equal(effectiveConfig(before).searchTimeoutMs, 42_000);
  await before.restart();
  assert.equal(effectiveConfig(before).searchTimeoutMs, 42_000);
  await budgets.release();
  assert.equal(effectiveConfig(before).searchTimeoutMs, 42_000);
  assert.equal(effectiveConfig(before).fetchTimeoutMs, 27_000);
  assert.equal(effectiveConfig(later).searchTimeoutMs, 60_000);
  assert.equal(effectiveConfig(later).fetchTimeoutMs, 23_000);
  assert.equal(budgets.snapshot().owned, 0);
  for (const runtime of [...app.registry.values()]) for (const fiber of [...runtime.fibers]) await fiber.dispose();
  console.log(JSON.stringify({ runtime: require('@deepseek-ai/dsh-tool-web/package.json').version,
    scope: 'official-tool-and-cordis-lifecycle-registration-stubs', passed: true }));
}
