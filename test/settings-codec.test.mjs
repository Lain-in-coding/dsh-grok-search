import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSettingsCodec } from '../src/core/settings-codec.mjs';
import { createSearchLog } from '../src/core/search-log.mjs';
import { SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';

const codec = schema => createSettingsCodec('test/settings', schema).create();
const rejects = (parser, values) => {
  for (const value of values) {
    assert.throws(() => parser.parse(value), { name: 'TypeError', message: 'Invalid settings payload.' });
    assert.equal(parser.safeParse(value).success, false);
  }
};

test('settings codec enforces numeric bounds, integer unions and scalar enum choices', () => {
  const integer = codec({ type: ['integer', 'null'], minimum: 0, maximum: 3 });
  for (const value of [null, 0, 1, 3]) assert.equal(integer.parse(value), value);
  rejects(integer, [-1, 4, 1.5, NaN, Infinity, -Infinity, '1']);
  const number = codec({ type: 'number', minimum: 0.5, maximum: 1.5 });
  assert.equal(number.parse(1.25), 1.25);
  rejects(number, [0.49, 1.51]);
  const choice = codec({ enum: [null, false, 0, 'allowed'] });
  for (const value of [null, false, 0, 'allowed']) assert.equal(choice.parse(value), value);
  rejects(choice, [true, 1, '0', 'other', {}, []]);
});

test('string bounds count Unicode code points and patterns retain JSON Schema match semantics', () => {
  const parser = codec({ type: 'string', minLength: 2, maxLength: 3, pattern: 'x' });
  assert.equal(parser.parse('x\u{1f600}'), 'x\u{1f600}');
  assert.equal(parser.parse('axz'), 'axz');
  rejects(parser, ['x', 'xyzx', '\u{1f600}\u{1f600}']);
  assert.equal(codec({ type: 'string', pattern: '^.$' }).parse('\u{1f600}'), '\u{1f600}');
  const exact = codec({ type: 'string', pattern: '^[a-z]{2}$' });
  rejects(exact, ['ab\n', 'ABC', ' ab']);
});

test('array bounds, required own fields and additional property rules apply inside anyOf', () => {
  const parser = codec({
    type: 'object', required: ['values'], additionalProperties: false,
    properties: { values: { type: 'array', minItems: 1, maxItems: 2,
      items: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1, maximum: 2 }] } } },
  });
  const valid = { values: [null, 2] };
  assert.equal(parser.parse(valid), valid);
  rejects(parser, [{}, { values: [] }, { values: [1, 2, 1] }, { values: [0] },
    { values: [1.5] }, { values: [1], extra: true }, Object.create({ values: [1] })]);
  const sibling = codec({ type: 'number', maximum: 2, anyOf: [{ minimum: 1 }, { enum: [0] }] });
  assert.equal(sibling.parse(0), 0);
  assert.equal(sibling.parse(1.5), 1.5);
  rejects(sibling, [3, -1, '1']);
});

test('codec accepts only JSON data without running getters or custom serialization', () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked++; return 1; } });
  const toJSON = { toJSON() { invoked++; return {}; } };
  const parser = codec({});
  rejects(parser, [undefined, new Date(), new Map(), new Set(), new Number(1), new Uint8Array(1),
    { nested: new Date() }, { nested: undefined }, { nested: 1n }, { nested: Symbol('value') },
    { nested() {} }, getter, toJSON, { [Symbol('key')]: 1 },
    Object.defineProperty({}, 'hidden', { value: 1 }), [, 1], Object.assign([], { extra: true })]);
  assert.equal(invoked, 0);
  const shared = { value: 1 }, value = { first: shared, second: shared, empty: Object.create(null) };
  assert.equal(parser.parse(value), value, 'shared acyclic values remain valid');
  const named = JSON.parse('{"__proto__":{"safe":true},"constructor":1}');
  assert.equal(parser.parse(named), named);
});

test('JSON validation rejects cycles, excessive depth, node count and total escaped size', () => {
  const parser = codec({});
  const cyclic = {};
  cyclic.self = cyclic;
  const recursiveArray = [];
  recursiveArray.push(recursiveArray);
  let deep = null;
  for (let index = 0; index < 100; index++) deep = { next: deep };
  let bounded = null;
  for (let index = 0; index < 60; index++) bounded = { next: bounded };
  assert.equal(parser.parse(bounded), bounded);
  rejects(parser, [cyclic, recursiveArray, deep, Array(200_000).fill(null),
    { large: 'x'.repeat(6_000_000) }, { ['k'.repeat(6_000_000)]: null }]);
  assert.equal(parser.parse({ afterFailure: true }).afterFailure, true);
});

test('unsupported or malformed schema features fail at creation rather than silently widening validation', () => {
  for (const schema of [
    { type: 'date' }, { type: [] }, { type: ['number', 'number'] }, { anyOf: [] },
    { type: 'string', format: 'uri' }, { $ref: '#/definitions/item' },
    { allOf: [{ type: 'string' }] }, { type: 'array', uniqueItems: true },
    { type: 'object', additionalProperties: { type: 'string' } },
    { type: 'array', items: [{ type: 'string' }] },
    { enum: [{}] }, { enum: [] }, { enum: [1, 1] },
    { minimum: '1' }, { maximum: Infinity }, { maxItems: 1.5 }, { minLength: -1 },
    { properties: null }, { required: null }, { required: [1] }, { required: ['x', 'x'] },
    { additionalProperties: null }, { pattern: '[' }, { pattern: 1 },
    { properties: { nested: { type: 'string', unknownKeyword: true } } }, true, null,
  ]) assert.throws(() => codec(schema), /Invalid or unsupported settings schema/);
  const cyclic = { type: 'array' };
  cyclic.items = cyclic;
  assert.throws(() => codec(cyclic), /Invalid or unsupported settings schema/);
});

test('compiled validation and returned schema copies cannot be changed by callers', () => {
  const schema = { type: 'object', properties: { count: { type: 'integer', maximum: 2 } }, additionalProperties: false };
  const descriptor = createSettingsCodec('test/settings', schema);
  schema.properties.count.maximum = 10;
  descriptor.jsonSchema.properties.count.maximum = 20;
  assert.equal(descriptor.mode, 'strict');
  assert.equal(descriptor.typeSymbol, 'test/settings');
  assert.equal(descriptor.create().parse({ count: 2 }).count, 2);
  rejects(descriptor.create(), [{ count: 3 }]);
});

test('maximum real search history remains within the JSON safety budget', () => {
  const log = createSearchLog({ now: () => 1 });
  const sessionId = randomUUID(), query = '\0'.repeat(5000);
  try {
    for (let call = 0; call < 20; call++) {
      const logScope = log.beginCall({ sessionId, callId: `call-${call}` });
      for (let index = 0; index < 16; index++) {
        const token = log.begin(query, { logScope });
        for (let attempt = 0; attempt < 16; attempt++) log.call(token, {
          provider: 'firecrawl', operation: 'supplement', result: 'failed', evidence: 'source-label',
          code: 'E'.repeat(64), keyIndex: attempt, charge: { amount: 1e9, unit: 'credits', basis: 'estimated' },
        });
        log.finish(token, { outcome: 'ok', served: 'firecrawl', callsComplete: true });
      }
      log.finishCall(logScope);
    }
    const value = log.snapshot(sessionId);
    assert.equal(value.records.length, 20);
    assert.equal(value.records[0].queries.length, 16);
    assert.equal(value.records[0].queries[0].calls.length, 16);
    const parser = SETTINGS_DESCRIPTORS.find(row => row.method === 'readSearchLog').result.create();
    assert.equal(parser.parse(value), value);
  } finally { log.dispose(); }
});

test('actual trace result codec enforces its declared route and attempt limits', () => {
  const parser = SETTINGS_DESCRIPTORS.find(row => row.method === 'toolCallTrace').result.create();
  const attempt = { provider: 'tavily', result: 'ok', code: '', keyIndex: 0, operation: 'search', evidence: '',
    at: 1, elapsedMs: 0 };
  const route = { served: 'tavily', outcome: 'ok', fallbackUsed: false, code: '', index: 0,
    phase: 'complete', at: 1, elapsedMs: 0, callsComplete: true, callsTruncated: false,
    calls: Array(16).fill(attempt), planned: ['tavily'] };
  const value = { known: true, state: 'complete', routes: Array(16).fill(route) };
  assert.equal(parser.parse(value), value);
  rejects(parser, [{ ...value, routes: Array(17).fill(route) },
    { ...value, routes: [{ ...route, calls: Array(17).fill(attempt) }] }]);
});
