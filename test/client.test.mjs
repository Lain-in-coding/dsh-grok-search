import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import { createSourceChain } from '../src/core/source-chain.mjs';

function loadClient() {
  let factory;
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, set textContent(_) {} }),
    head: { appendChild() {} },
  };
  const window = { __ModuleLoader__: { load(definition) { factory = definition.factory; } } };
  const context = { window, document, structuredClone, console, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), context,
    { filename: 'src/client.js' });
  assert.equal(typeof factory, 'function');
  const react = {
    useState: () => [null, () => {}],
    useCallback: value => value,
    useEffect() {},
    useMemo: value => value(),
    useRef: () => ({ current: null }),
  };
  const jsx = () => ({});
  return factory(name => name === 'react' ? react : { jsx, jsxs: jsx, Fragment: Symbol('Fragment') });
}

test('client exposes the real settings contribution and all route methods', () => {
  const client = loadClient();
  const methods = client.__test.descriptors.map(descriptor => descriptor.method);
  assert.equal(JSON.stringify(methods), JSON.stringify(SETTINGS_DESCRIPTORS.map(descriptor => descriptor.method)));
  assert.equal(JSON.stringify(client.__test.descriptors), JSON.stringify(SETTINGS_DESCRIPTORS));
  assert.equal(client.__test.descriptors.every(descriptor => descriptor.invocation.kind === 'direct'), true);
});

test('client declares the owners of its remote and keyed detail slot', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'));
});

test('production view embeds v74 inputs without mock actions or global presentation changes', () => {
  const code = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.match(code, /attachShadow/);
  assert.match(code, /restoreConfig/);
  assert.match(code, /diagnoseProvider/);
  assert.match(code, /theme\/change/);
  assert.doesNotMatch(code, /window\.mock|simulateFail|makeScene|masterSwitch|style\[data-dsg-style\]/);
  assert.doesNotMatch(code, /document\.body\.(?:style|dataset|classList)|document\.documentElement\.dataset/);
});

test('client embeds the exact host source-chain rules', () => {
  const client = loadClient();
  const fields = { source_providers: { value: ['exa', 'tavily'], readOnly: false }, exa_enabled: { value: false, readOnly: false } };
  const host = createSourceChain();
  assert.equal(JSON.stringify(client.__test.sourceChain.view(fields)), JSON.stringify(host.view(fields)));
  const change = { kind: 'order', order: ['tavily', 'exa', 'firecrawl', 'tinyfish'] };
  assert.equal(JSON.stringify(client.__test.sourceChain.plan(fields, change)), JSON.stringify(host.plan(fields, change)));
});
