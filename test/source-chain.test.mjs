import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createSourceChain } from '../src/core/source-chain.mjs';
import { createSharedConfigStore, SOURCE_PROVIDERS } from '../src/core/shared-config.mjs';

const chain = createSourceChain();
const ALL = ['tavily', 'exa', 'tinyfish', 'firecrawl'];
const fieldsOf = ({ list, flags = {}, locked = {} } = {}) => ({
  ...(list === undefined ? {} : { source_providers: { value: list, readOnly: locked.list === true } }),
  ...Object.fromEntries(ALL.filter(id => id in flags)
    .map(id => [`${id}_enabled`, { value: flags[id], readOnly: locked[id] === true }])),
});
const applyUpdates = (fields, updates) => {
  const next = structuredClone(fields);
  for (const [key, value] of Object.entries(updates)) next[key] = { value, readOnly: next[key]?.readOnly === true };
  return next;
};
const codeOf = code => error => error.code === code;
const permutations = list => list.length <= 1 ? [list]
  : list.flatMap((item, index) => permutations(list.filter((_, at) => at !== index)).map(rest => [item, ...rest]));

test('the chain uses the same four sources as the shared config', () => {
  assert.deepEqual([...chain.SOURCES], [...SOURCE_PROVIDERS]);
});

test('the embedded copy runs without outer bindings', () => {
  const embedded = new Function(`return (${createSourceChain.toString()})`)()();
  const fields = fieldsOf({ list: ['exa'], flags: { tavily: false } });
  assert.deepEqual(embedded.view(fields), chain.view(fields));
  assert.deepEqual(embedded.plan(fields, { kind: 'toggle', id: 'tinyfish', on: true }),
    chain.plan(fields, { kind: 'toggle', id: 'tinyfish', on: true }));
});

test('view follows grok-search-rs: empty list is canonical, a list keeps only its sources in order', () => {
  assert.deepEqual(chain.view({}), { order: ALL, listed: ALL, explicit: false,
    enabled: { tavily: true, exa: true, tinyfish: true, firecrawl: true },
    flags: { tavily: true, exa: true, tinyfish: true, firecrawl: true },
    flagLocked: { tavily: false, exa: false, tinyfish: false, firecrawl: false }, orderLocked: false });
  const listed = chain.view(fieldsOf({ list: ['firecrawl', 'exa'], flags: { exa: false } }));
  assert.deepEqual(listed.order, ['firecrawl', 'exa', 'tavily', 'tinyfish']);
  assert.deepEqual(listed.enabled, { tavily: false, exa: false, tinyfish: false, firecrawl: true });
  assert.equal(listed.explicit, true);
  // Same normalisation as upstream csv_list; unknown names never reach the chain.
  const csv = chain.view({ source_providers: ' Exa, tavily ,exa,,unknown' });
  assert.deepEqual(csv.listed, ['exa', 'tavily']);
  // Raw values (router) and snapshot items (settings) give the same view.
  const raw = { source_providers: ['exa'], tavily_enabled: false, exa_enabled: true };
  assert.deepEqual(chain.view(raw), chain.view(fieldsOf({ list: ['exa'], flags: { tavily: false, exa: true } })));
  const locks = chain.view(fieldsOf({ list: ['exa'], flags: { exa: true }, locked: { list: true, exa: true } }));
  assert.equal(locks.orderLocked, true);
  assert.equal(locks.flagLocked.exa, true);
});

test('any toggle changes only that source, from every listed and switch state', () => {
  const lists = [undefined, [], ['exa'], ['exa', 'tavily'], ['firecrawl', 'tinyfish', 'exa'], ['tinyfish', 'exa', 'tavily', 'firecrawl']];
  for (const list of lists) for (let mask = 0; mask < 16; mask++) {
    const flags = Object.fromEntries(ALL.map((id, bit) => [id, (mask & (1 << bit)) === 0]));
    const fields = fieldsOf({ list, flags });
    const before = chain.view(fields);
    for (const id of ALL) for (const on of [true, false]) {
      const updates = chain.plan(fields, { kind: 'toggle', id, on });
      const after = chain.view(applyUpdates(fields, updates));
      const label = JSON.stringify({ list, flags, id, on, updates });
      assert.equal(after.enabled[id], on, label);
      for (const other of ALL.filter(other => other !== id)) assert.equal(after.enabled[other], before.enabled[other], label);
      const kept = before.order.filter(other => before.enabled[other] && other !== id);
      assert.deepEqual(after.order.filter(other => kept.includes(other)), kept, label);
      if (before.enabled[id] === on) assert.deepEqual(updates, {}, label);
    }
  }
});

test('any drag keeps every on/off state and yields exactly the dragged order', () => {
  const lists = [undefined, ['exa'], ['exa', 'tavily'], ['firecrawl', 'tinyfish', 'exa']];
  for (const list of lists) for (let mask = 0; mask < 16; mask++) {
    const flags = Object.fromEntries(ALL.map((id, bit) => [id, (mask & (1 << bit)) === 0]));
    const fields = fieldsOf({ list, flags });
    const before = chain.view(fields);
    for (const order of permutations(ALL)) {
      const updates = chain.plan(fields, { kind: 'order', order });
      const after = chain.view(applyUpdates(fields, updates));
      const label = JSON.stringify({ list, flags, order, updates });
      assert.deepEqual(after.enabled, before.enabled, label);
      assert.deepEqual(after.order, order, label);
      if (order.join() === before.order.join()) assert.deepEqual(updates, {}, label);
    }
  }
});

test('toggles write the minimum: a switch, or an appended list entry', () => {
  assert.deepEqual(chain.plan({}, { kind: 'toggle', id: 'exa', on: false }), { exa_enabled: false });
  assert.deepEqual(chain.plan(fieldsOf({ flags: { exa: false } }), { kind: 'toggle', id: 'exa', on: true }), { exa_enabled: true });
  assert.deepEqual(chain.plan(fieldsOf({ list: ['exa'] }), { kind: 'toggle', id: 'tavily', on: true }),
    { source_providers: ['exa', 'tavily'] });
  assert.deepEqual(chain.plan(fieldsOf({ list: ['exa'], flags: { tavily: false } }), { kind: 'toggle', id: 'tavily', on: true }),
    { tavily_enabled: true, source_providers: ['exa', 'tavily'] });
  // Switching every source off is allowed: grok-search-rs then has no fallback.
  const off = fieldsOf({ list: ['exa'] });
  assert.deepEqual(chain.plan(off, { kind: 'toggle', id: 'exa', on: false }), { exa_enabled: false });
});

test('drags write the full list and keep left-out sources off through their switch', () => {
  assert.deepEqual(chain.plan({}, { kind: 'order', order: ['exa', 'tavily', 'tinyfish', 'firecrawl'] }),
    { source_providers: ['exa', 'tavily', 'tinyfish', 'firecrawl'] });
  assert.deepEqual(chain.plan(fieldsOf({ list: ['exa', 'tavily'] }), { kind: 'order', order: ['tavily', 'exa', 'tinyfish', 'firecrawl'] }),
    { tinyfish_enabled: false, firecrawl_enabled: false, source_providers: ['tavily', 'exa', 'tinyfish', 'firecrawl'] });
  // The default value from a snapshot is the canonical list: no write needed.
  assert.deepEqual(chain.plan(fieldsOf({ list: ALL }), { kind: 'order', order: ALL }), {});
});

test('environment-owned fields are never written', () => {
  // A switch forced on by the environment can still leave the chain.
  assert.deepEqual(chain.plan(fieldsOf({ flags: { tavily: true }, locked: { tavily: true } }), { kind: 'toggle', id: 'tavily', on: false }),
    { source_providers: ['exa', 'tinyfish', 'firecrawl'] });
  assert.throws(() => chain.plan(fieldsOf({ flags: { tavily: false }, locked: { tavily: true } }), { kind: 'toggle', id: 'tavily', on: true }),
    codeOf('CONFIG_ENV_OVERRIDE'));
  const envList = fieldsOf({ list: ['exa', 'tavily'], locked: { list: true } });
  assert.throws(() => chain.plan(envList, { kind: 'toggle', id: 'tinyfish', on: true }), codeOf('CONFIG_ENV_OVERRIDE'));
  assert.deepEqual(chain.plan(envList, { kind: 'toggle', id: 'exa', on: false }), { exa_enabled: false });
  assert.throws(() => chain.plan(envList, { kind: 'order', order: ['tavily', 'exa', 'tinyfish', 'firecrawl'] }),
    codeOf('CONFIG_ENV_OVERRIDE'));
  assert.deepEqual(chain.plan(envList, { kind: 'order', order: ['exa', 'tavily', 'tinyfish', 'firecrawl'] }), {});
  // The only listed source is forced on: an empty list would mean "all on".
  assert.throws(() => chain.plan(fieldsOf({ list: ['tavily'], flags: { tavily: true }, locked: { tavily: true } }),
    { kind: 'toggle', id: 'tavily', on: false }), codeOf('SOURCE_CHAIN_EMPTY'));
  // A source forced on but left out stays out of a dragged list.
  const forced = fieldsOf({ list: ['exa'], flags: { tavily: true }, locked: { tavily: true } });
  const updates = chain.plan(forced, { kind: 'order', order: ['tavily', 'exa', 'tinyfish', 'firecrawl'] });
  assert.deepEqual(updates, { tinyfish_enabled: false, firecrawl_enabled: false, source_providers: ['exa', 'tinyfish', 'firecrawl'] });
  assert.deepEqual(chain.view(applyUpdates(forced, updates)).enabled, chain.view(forced).enabled);
});

test('invalid actions are rejected before planning any write', () => {
  assert.throws(() => chain.plan({}, { kind: 'toggle', id: 'github', on: true }), codeOf('SOURCE_CHAIN_INVALID'));
  assert.throws(() => chain.plan({}, { kind: 'toggle', id: 'exa', on: 'yes' }), codeOf('SOURCE_CHAIN_INVALID'));
  assert.throws(() => chain.plan({}, { kind: 'order', order: ['exa', 'exa', 'tavily', 'tinyfish'] }), codeOf('SOURCE_CHAIN_INVALID'));
  assert.throws(() => chain.plan({}, { kind: 'order', order: ['exa'] }), codeOf('SOURCE_CHAIN_INVALID'));
  assert.throws(() => chain.plan({}, { kind: 'rename' }), codeOf('SOURCE_CHAIN_INVALID'));
});

test('planned updates round-trip through the shared config store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-source-chain-'));
  const path = join(directory, 'config.toml');
  writeFileSync(path, '# user comment\nsource_providers = ["exa", "tavily"]\ntavily_api_key = "k"\n');
  const store = createSharedConfigStore({ path, env: () => ({}) });
  let snapshot = store.snapshot();
  const updates = chain.plan(snapshot.fields, { kind: 'order', order: ['tavily', 'firecrawl', 'exa', 'tinyfish'] });
  snapshot = store.save({ expectedRevision: snapshot.revision, updates });
  const view = chain.view(snapshot.fields);
  assert.deepEqual(view.order, ['tavily', 'firecrawl', 'exa', 'tinyfish']);
  assert.deepEqual(view.enabled, { tavily: true, exa: true, tinyfish: false, firecrawl: false });
  const toggled = store.save({ expectedRevision: snapshot.revision,
    updates: chain.plan(snapshot.fields, { kind: 'toggle', id: 'firecrawl', on: true }) });
  assert.equal(chain.view(toggled.fields).enabled.firecrawl, true);
  assert.equal(store.readEffective().tavily_api_key.value, 'k', 'unrelated values survive');
});
