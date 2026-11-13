import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import { SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifact = join(root, 'src/client.js');
const original = readFileSync(artifact, 'utf8'), originalTime = statSync(artifact).mtimeMs;
const { buildClient, checkClientArtifact } = await import('../scripts/build-client.mjs');
const result = await buildClient();

function instantiate() {
  let definition;
  const required = [];
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(value) { assert.equal(definition, undefined); definition = value; } } },
  });
  vm.runInContext('globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));', context);
  vm.runInContext(result.code, context, { filename: 'client.js' });
  assert.equal(definition.id, 'dsh-grok-search');
  assert.equal(typeof definition.factory, 'function');
  assert.deepEqual(required, [], 'loading must not resolve React before the host factory is called');
  const react = { useEffect() {}, useRef: () => ({ current: null }) }, runtime = { jsx() {} };
  const client = definition.factory(name => {
    required.push(name);
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return runtime;
    throw new Error(`Unexpected host dependency: ${name}`);
  });
  return { client, context, required };
}

test('ESM client builds are deterministic and neither import nor build writes the stored artifact', async () => {
  const second = await buildClient();
  assert.equal(result.code, second.code);
  assert.deepEqual(result.metafile, second.metafile);
  assert.equal(readFileSync(artifact, 'utf8'), original);
  assert.equal(statSync(artifact).mtimeMs, originalTime);
  assert.doesNotMatch(result.code, /__(?:CODEC|SOURCE_CHAIN|ROUTE_CONTROLLER|SEARCH_LOG|QUOTA|TOOL_ROUTE)_FACTORY__/);
  assert.doesNotMatch(result.code, /sourceMappingURL|[A-Z]:\\Users\\/);
});

test('browser metafile contains real UI imports and no server, Node or bundled React dependency', () => {
  const inputs = Object.keys(result.metafile.inputs).sort();
  assert.deepEqual(inputs, [
    'dsh-client:data',
    'src/client.template.js',
    'src/core/settings-codec.mjs',
    'src/core/source-chain.mjs',
    'src/ui/quota-view.mjs',
    'src/ui/route-controller.mjs',
    'src/ui/route-form.mjs',
    'src/ui/shared-styles.mjs',
    'src/ui/search-log-view.mjs',
    'src/ui/tool-route-view.mjs',
  ].sort());
  assert.equal(inputs.some(path => /node_modules|settings-ui|node:/.test(path)), false);
  const outputs = Object.values(result.metafile.outputs);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].entryPoint, 'src/client.template.js');
  assert.deepEqual(outputs[0].imports, []);
});

test('built client keeps the host ModuleLoader and React factory contract', () => {
  const { client, required } = instantiate();
  assert.deepEqual(required, ['react', 'react/jsx-runtime']);
  assert.equal(client.NS, 'plugins.dshGrokSearch');
  assert.equal(typeof client.apply, 'function');
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'remote']);
  assert.equal(JSON.stringify(client.__test.descriptors), JSON.stringify(SETTINGS_DESCRIPTORS));
  for (const name of ['routeController', 'searchLogView', 'quotaView', 'toolRouteView']) {
    assert.equal(typeof client.__test[name], 'function', name);
  }
});

test('built browser codecs enforce the current contract without host services', () => {
  const { client, context } = instantiate();
  context.client = client;
  assert.equal(vm.runInContext(`(() => {
    const parser = client.__test.descriptors.find(item => item.method === 'save').parameters[0].codec.create();
    return parser.safeParse({ expectedRevision: 'missing', updates: { grok_model: 'example' } }).success
      && !parser.safeParse(undefined).success
      && !parser.safeParse({ expectedRevision: 'missing', updates: { value: Infinity } }).success
      && !parser.safeParse({ expectedRevision: 'missing', updates: { value: new Date() } }).success;
  })()`, context), true);
});

test('virtual input data preserves approved HTML, CSS and all theme assets exactly', () => {
  const { client } = instantiate(), data = client.__test;
  const text = name => readFileSync(join(root, 'src/ui', name), 'utf8');
  assert.equal(data.ROUTE_CSS, text('route.css') + '\n' + text('search-log.css'));
  assert.equal(data.TOOL_ROUTE_CSS, text('tool-route.css'));
  assert.equal(data.ROUTE_CARD, text('route-card.html'));
  assert.equal(data.ROUTE_LAYER, text('route-layer.html'));
  assert.equal(Object.keys(data.LOGOS).length, 13);
  for (const [key, file] of [
    ['harness', 'deepseek-harness-settings.png'],
    ['harnessChat', 'deepseek-harness-chat-light.png'],
    ['harnessChatDark', 'deepseek-harness-chat-dark.png'],
  ]) {
    assert.equal(data.LOGOS[key], `data:image/png;base64,${readFileSync(join(root, 'src/assets/logos', file)).toString('base64')}`);
  }
});

test('artifact checking accepts exact bytes and reports stale output without repairing it', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-client-build-')), path = join(directory, 'client.js');
  t.after(() => { rmSync(path, { force: true }); rmdirSync(directory); });
  writeFileSync(path, result.code);
  assert.doesNotThrow(() => checkClientArtifact(result.code, path));
  writeFileSync(path, 'stale client fixture\n');
  assert.throws(() => checkClientArtifact(result.code, path), /src\/client\.js is stale.*build:client/);
  assert.equal(readFileSync(path, 'utf8'), 'stale client fixture\n');
});

test('CLI check mode validates the stored artifact and never rewrites it', () => {
  const expected = readFileSync(artifact, 'utf8');
  const checked = spawnSync(process.execPath, ['scripts/build-client.mjs', '--check'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(checked.error, undefined);
  assert.equal(checked.status, expected === result.code ? 0 : 1, checked.stderr);
  assert.match(checked.stdout + checked.stderr, expected === result.code
    ? /Client artifact matches/ : /src\/client\.js is stale/);
  assert.equal(readFileSync(artifact, 'utf8'), expected);
});
