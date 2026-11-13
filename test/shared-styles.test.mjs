import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSharedStyles } from '../src/ui/shared-styles.mjs';

function documentFixture({ unsupported = false, throws = false } = {}) {
  let constructions = 0, parses = 0, styleElements = 0;
  const document = {
    defaultView: { CSSStyleSheet: unsupported ? undefined : class {
      constructor() { constructions++; }
      replaceSync(css) { parses++; if (throws) throw new Error('unsupported'); this.css = css; }
    } },
    createElement: () => { styleElements++; return { remove() { this.removed = true; } }; },
  };
  const root = () => ({ ownerDocument: document, adoptedStyleSheets: [], prepend(node) { this.style = node; } });
  return { root, counts: () => ({ constructions, parses, styleElements }) };
}

test('two settings roots and repeated mounts parse one shared immutable stylesheet', () => {
  const h = documentFixture(), first = h.root(), second = h.root();
  const other = {};
  first.adoptedStyleSheets.push(other);
  const offFirst = attachSharedStyles(first, '.a{color:red}');
  const offSecond = attachSharedStyles(second, '.a{color:red}');
  assert.equal(first.adoptedStyleSheets[1], second.adoptedStyleSheets[0]);
  assert.deepEqual(h.counts(), { constructions: 1, parses: 1, styleElements: 0 });
  offFirst(); offFirst();
  assert.deepEqual(first.adoptedStyleSheets, [other]);
  assert.equal(second.adoptedStyleSheets.length, 1);
  offSecond();
  attachSharedStyles(h.root(), '.a{color:red}')();
  assert.equal(h.counts().parses, 1);
});

test('different documents and changed CSS never share the wrong sheet', () => {
  const a = documentFixture(), b = documentFixture();
  const first = a.root(), second = b.root(), changed = a.root();
  attachSharedStyles(first, 'old');
  attachSharedStyles(second, 'old');
  attachSharedStyles(changed, 'new');
  assert.notEqual(first.adoptedStyleSheets[0], second.adoptedStyleSheets[0]);
  assert.notEqual(first.adoptedStyleSheets[0], changed.adoptedStyleSheets[0]);
  assert.equal(first.adoptedStyleSheets[0].css, 'old');
});

test('unsupported or rejected constructed sheets retain the original element behavior', () => {
  for (const options of [{ unsupported: true }, { throws: true }]) {
    const h = documentFixture(options), root = h.root(), off = attachSharedStyles(root, '.a{}');
    assert.equal(root.style.textContent, '.a{}');
    assert.equal(root.adoptedStyleSheets.length, 0);
    off();
    assert.equal(root.style.removed, true);
  }
});
