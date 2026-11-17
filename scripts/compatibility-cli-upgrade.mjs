import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { readUpgradePackage, readRetainedSession, retainUpgradeCache } from './verify-search-log-upgrade.mjs';
import { readRuntimeReceipt } from './lib/compatibility-evidence.mjs';
import { adaptRetainedSessionRpc, canonicalRetainedSessionCut, createRetainedSessionReader } from './lib/retained-session.mjs';

const ownFile = fileURLToPath(import.meta.url);
const project = resolve(dirname(ownFile), '..');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const HOST_PEERS = ['cordis', 'dsh', 'dsh-app-boot', 'dsh-typert-protocol', 'dsh-web', 'schemastery']
  .map(name => '@deepseek-ai/' + name);
const REGISTRY = 'https://registry.npmjs.org';
const SENTINEL = 'dsh-cli-upgrade-loopback-not-a-real-key';

export function parseCliUpgradeArguments(argv) {
  const options = { nativeCliInstall: false, onlineNativeInstall: false, hostDefaultPeerPolicy: false };
  const flags = new Map([
    ['--linux-cli', 'cli'], ['--linux-node', 'node'], ['--runtime-root', 'runtimeRoot'],
    ['--runtime-receipt', 'receiptPath'], ['--runtime-receipt-sha256', 'receiptSha256'], ['--receipt-root', 'receiptRoot'],
    ['--host-version', 'version'], ['--run-root', 'runRoot'], ['--retained-cache', 'retainedCache'],
    ['--pnpm-entry', 'pnpmEntry'], ['--pnpm-store', 'pnpmStore'], ['--pnpm-cache', 'pnpmCache'],
    ['--to-linux-cli', 'toCli'], ['--to-linux-node', 'toNode'], ['--to-runtime-root', 'toRuntimeRoot'],
    ['--to-runtime-receipt', 'toReceiptPath'], ['--to-runtime-receipt-sha256', 'toReceiptSha256'], ['--to-receipt-root', 'toReceiptRoot'],
    ['--to-host-version', 'toVersion'],
  ]);
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--native-cli-install') {
      assert.equal(options.nativeCliInstall, false, 'Duplicate native install flag.');
      options.nativeCliInstall = true;
    } else if (value === '--online-native-install') {
      assert.equal(options.onlineNativeInstall, false, 'Duplicate online install flag.');
      options.onlineNativeInstall = true;
    } else if (value === '--host-default-peer-policy') {
      assert.equal(options.hostDefaultPeerPolicy, false, 'Duplicate host default policy flag.');
      options.hostDefaultPeerPolicy = true;
    } else if (value.startsWith('--')) {
      const key = flags.get(value);
      assert.ok(key && argv[index + 1] && !argv[index + 1].startsWith('--'), 'Unknown or incomplete argument: ' + value);
      assert.equal(options[key], undefined, 'Duplicate argument: ' + value);
      options[key] = argv[++index];
    } else positional.push(value);
  }
  assert.equal(positional.length, 2, 'Provide the actual old and frozen new package tarballs.');
  options.oldPackage = positional[0];
  options.newPackage = positional[1];
  assert.equal(options.nativeCliInstall, true, 'This driver requires explicit --native-cli-install.');
  for (const key of ['cli', 'node', 'runtimeRoot', 'receiptPath', 'receiptSha256', 'version',
    'runRoot', 'retainedCache', 'pnpmEntry', 'pnpmStore', 'pnpmCache']) {
    assert.ok(typeof options[key] === 'string' && options[key], 'Missing required input: ' + key);
  }
  const targetKeys = ['toCli', 'toNode', 'toRuntimeRoot', 'toReceiptPath', 'toReceiptSha256', 'toVersion'];
  if (targetKeys.some(key => options[key] !== undefined)) {
    assert.ok(targetKeys.every(key => typeof options[key] === 'string' && options[key]),
      'Forward upgrade requires all target CLI, Node, version and receipt inputs.');
  }
  assert.ok(options.toReceiptRoot === undefined || options.toVersion, 'A target receipt root requires the complete forward pair.');
  for (const key of Object.keys(options).filter(key => !['nativeCliInstall', 'onlineNativeInstall', 'hostDefaultPeerPolicy', 'receiptSha256',
    'toReceiptSha256', 'version', 'toVersion'].includes(key))) {
    assert.ok(isAbsolute(options[key]) && !/[\r\n\0]/.test(options[key]), 'An absolute input path is required: ' + key);
    options[key] = resolve(options[key]);
  }
  for (const key of ['receiptSha256', ...(options.toVersion ? ['toReceiptSha256'] : [])]) {
    assert.match(options[key], /^[a-f0-9]{64}$/, 'Use an explicit SHA-256 receipt fingerprint.');
  }
  return options;
}

const beneath = (base, path) => {
  const rel = relative(resolve(base), resolve(path));
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
};

export function validateCliUpgradeRoot(path, inputs = [], { uid = process.getuid?.() } = {}) {
  const root = resolve(path);
  assert.ok(isAbsolute(path) && !/[\r\n\0]/.test(path), 'Use an absolute persistent output path.');
  assert.equal(lstatSync(root, { throwIfNoEntry: false }), undefined, 'The run root must be new; preserve previous evidence.');
  const parent = dirname(root);
  const stat = lstatSync(parent);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Use an existing private persistent parent directory.');
  assert.equal(realpathSync(parent), parent, 'The persistent parent cannot resolve through links.');
  if (uid !== undefined) {
    assert.equal(stat.uid, uid, 'The persistent parent must belong to the current user.');
    assert.equal(stat.mode & 0o077, 0, 'The persistent parent must be private (0700).');
  }
  assert.ok(!/^\/(?:tmp|var\/tmp)(?:\/|$)/.test(root), 'This acceptance run must not use a temporary root.');
  for (const input of inputs.filter(Boolean)) {
    assert.ok(!beneath(root, input) && !beneath(input, root), 'The run root must not overlap an input: ' + input);
  }
  return root;
}

export function cliUpgradeHostPeerEntry(manifest, packageDir, cli) {
  const esmTarget = target => {
    if (typeof target === 'string') return target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
    for (const [condition, value] of Object.entries(target)) {
      if (['node', 'import', 'default'].includes(condition)) {
        const selected = esmTarget(value);
        if (selected !== null) return selected;
      }
    }
    return null;
  };
  const cliPackage = manifest.name === '@deepseek-ai/dsh';
  const exported = cliPackage ? manifest.exports?.['./profile-boot'] : typeof manifest.exports === 'string'
    ? manifest.exports : manifest.exports?.['.'];
  const target = exported !== undefined ? esmTarget(exported) : cliPackage
    ? typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    : manifest.module ?? manifest.main;
  assert.ok(typeof target === 'string' && target && !isAbsolute(target) && !/[\r\n\0]/.test(target),
    'The shipped manifest must declare a relevant ESM entry or CLI bin; never guess index.js.');
  const entry = resolve(packageDir, target), realPackage = realpathSync(packageDir);
  assert.ok(beneath(packageDir, entry) && beneath(realPackage, realpathSync(entry)),
    'The actual peer implementation escaped the shipped package.');
  const stat = lstatSync(entry);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'The peer implementation must be an ordinary shipped file.');
  if (cliPackage && exported === undefined) assert.equal(entry, resolve(cli), 'The declared CLI bin differs from the verified executable.');
  return entry;
}

export function readCliUpgradeRuntime({ cli, node, runtimeRoot, receiptRoot = runtimeRoot, receiptPath, receiptSha256, version }) {
  assert.equal(semver.valid(version), version, 'Use an exact canonical host version.');
  const verified = readRuntimeReceipt({ receiptPath, receiptSha256, root: receiptRoot,
    version, platform: 'linux', arch: 'x64', roles: ['executable', 'cliManifest'] });
  assert.equal(verified.receipt.asset.lane, 'linux-cli');
  assert.equal(verified.files.executable, resolve(cli), 'CLI differs from its verified receipt.');
  const expectedManifest = join(resolve(runtimeRoot), 'node_modules/@deepseek-ai/dsh/package.json');
  assert.ok(beneath(receiptRoot, runtimeRoot), 'The CLI runtime must remain under its explicitly trusted receipt root.');
  assert.equal(verified.files.cliManifest, expectedManifest, 'Receipt must identify the real installed CLI package.');
  const manifest = JSON.parse(readFileSync(expectedManifest, 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh');
  assert.equal(manifest.version, version);
  assert.equal(manifest.engines?.node ?? null, verified.receipt.asset.nodeRange ?? null);
  assert.ok(lstatSync(node).isFile() && !lstatSync(node).isSymbolicLink(), 'Provide an actual Node executable, not a launcher link.');
  const hostPeers = HOST_PEERS.map(name => {
    const path = join(resolve(runtimeRoot), 'node_modules', name), realPath = realpathSync(path);
    assert.ok(beneath(runtimeRoot, realPath), 'A shipped host peer escaped the verified runtime.');
    const manifestPath = join(path, 'package.json'), peer = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(peer.name, name); assert.equal(semver.valid(peer.version), peer.version);
    const entry = cliUpgradeHostPeerEntry(peer, path, cli);
    return { name, path, realPath, version: peer.version, entry,
      manifestSha256: sha256(manifestPath), entrySha256: sha256(entry) };
  });
  return { cli: resolve(cli), node: resolve(node), runtimeRoot: resolve(runtimeRoot), receiptRoot: resolve(receiptRoot), version,
    receiptPath: resolve(receiptPath), receiptSha256, receipt: verified.receipt,
    hostPeers, inputHashes: { cli: sha256(cli), node: sha256(node), manifest: sha256(expectedManifest),
      hostPeers: hostPeers.map(({ name, realPath, entry, manifestSha256, entrySha256 }) =>
        ({ name, realPath, entry, manifestSha256, entrySha256 })) } };
}

export function cliUpgradeStages(oldManifest, newManifest, runtimes) {
  assert.equal(oldManifest.name, 'dsh-grok-search'); assert.equal(newManifest.name, 'dsh-grok-search');
  assert.equal(oldManifest.version, '0.3.0'); assert.equal(newManifest.version, '0.4.0');
  assert.ok(runtimes.length === 1 || runtimes.length === 2);
  const admits = (manifest, version) => typeof manifest.engines?.dsh === 'string'
    && semver.validRange(manifest.engines.dsh) !== null
    && semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true });
  assert.ok(admits(oldManifest, runtimes[0].version), 'The unchanged old package must normally admit its baseline host.');
  assert.ok(admits(newManifest, runtimes[0].version), 'The new package must admit the baseline host.');
  if (runtimes.length === 1) return [
    { id: 'old-seed', packageIndex: 0, runtimeIndex: 0 },
    { id: 'new-upgraded', packageIndex: 1, runtimeIndex: 0 },
    { id: 'old-rollback', packageIndex: 0, runtimeIndex: 0 },
  ];
  assert.ok(semver.gt(runtimes[1].version, runtimes[0].version), 'Only a forward host transition is allowed.');
  assert.ok(!admits(oldManifest, runtimes[1].version), 'The pair must observe a real old-package admission boundary.');
  assert.ok(admits(newManifest, runtimes[1].version), 'The new package must admit the target host.');
  return [
    { id: 'old-seed', packageIndex: 0, runtimeIndex: 0 },
    { id: 'old-package-rejected', packageIndex: 0, runtimeIndex: 1, rejected: true },
    { id: 'new-forward', packageIndex: 1, runtimeIndex: 1 },
  ];
}

export function cliUpgradeInstallArguments(runtime, packagePath, {
  pnpmStore, pnpmCache, onlineNativeInstall = false, pluginVersion = '0.4.0', hostDefaultPeerPolicy = false,
}) {
  assert.ok(['0.3.0', '0.4.0'].includes(pluginVersion), 'Use the actual pinned package identity.');
  return [runtime.cli, 'plugin', '--profile', 'candidate', 'add', packagePath,
    ...(onlineNativeInstall ? ['--config.fetch-retries=0', '--config.fetch-timeout=60000'] : ['--offline']),
    '--store-dir', pnpmStore, '--cache-dir', pnpmCache, '--ignore-scripts',
    ...(pluginVersion === '0.4.0' && !hostDefaultPeerPolicy
      ? ['--config.auto-install-peers=true', '--config.strict-peer-dependencies=true'] : []),
    '--registry', REGISTRY];
}

export function cliUpgradeInstallEnvironment(environment, pluginVersion, { hostDefaultPeerPolicy = false } = {}) {
  assert.ok(['0.3.0', '0.4.0'].includes(pluginVersion));
  const selected = { ...environment };
  if (pluginVersion === '0.3.0' || hostDefaultPeerPolicy) {
    delete selected.npm_config_auto_install_peers;
    delete selected.npm_config_strict_peer_dependencies;
  }
  return selected;
}

export function cliUpgradeEnvironment(root, node, pnpmEntry) {
  const home = join(root, 'home');
  const bin = join(root, 'bin', createHash('sha256').update(node).digest('hex').slice(0, 16));
  for (const path of [home, bin, join(root, 'tmp'), join(root, 'xdg-config'),
    join(root, 'xdg-cache'), join(root, 'xdg-data'), join(root, 'npm-cache')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const wrapper = join(bin, 'pnpm');
  const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const source = `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(pnpmEntry)} "$@"\n`;
  if (existsSync(wrapper)) {
    assert.ok(lstatSync(wrapper).isFile() && !lstatSync(wrapper).isSymbolicLink());
    assert.equal(readFileSync(wrapper, 'utf8'), source, 'An existing Node-specific pnpm wrapper cannot be replaced.');
  }
  else writeFileSync(wrapper, source, { flag: 'wx', mode: 0o700 });
  for (const file of ['npm-user.npmrc', 'npm-global.npmrc']) {
    if (!existsSync(join(root, file))) writeFileSync(join(root, file), '', { flag: 'wx', mode: 0o600 });
  }
  return { PATH: [bin, dirname(node), '/usr/bin', '/bin'].join(':'), HOME: home,
    TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_DATA_HOME: join(root, 'xdg-data'),
    DSH_HOME: join(root, 'dsh-home'), LANG: 'C.UTF-8', TERM: 'dumb', CI: '1', NO_COLOR: '1',
    DSH_TELEMETRY_DISABLED: '1', npm_config_userconfig: join(root, 'npm-user.npmrc'),
    npm_config_globalconfig: join(root, 'npm-global.npmrc'), npm_config_cache: join(root, 'npm-cache'),
    npm_config_registry: REGISTRY, npm_config_auto_install_peers: 'true',
    npm_config_strict_peer_dependencies: 'true', npm_config_legacy_peer_deps: 'false', npm_config_force: 'false',
    COREPACK_DEFAULT_TO_LATEST: '0', COREPACK_NPM_REGISTRY: REGISTRY };
}

export function bindCliUpgradeHostPeers(profile, runtime, previous = []) {
  const manifestPath = join(profile, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const old = new Map(previous.map(peer => [peer.name, peer]));
  assert.ok(manifest.dependencies && typeof manifest.dependencies === 'object');
  // The verifier declares links to the actual shipped host; it never installs a second host graph.
  const bindings = runtime.hostPeers.map(peer => {
    const path = join(profile, 'node_modules', peer.name), stat = lstatSync(path, { throwIfNoEntry: false });
    assert.equal(realpathSync(peer.path), peer.realPath, 'The verified host peer moved before binding.');
    assert.equal(sha256(join(peer.path, 'package.json')), peer.manifestSha256);
    if (stat) {
      assert.ok(stat.isSymbolicLink(), 'Never repair a private root host copy into a passing fixture.');
      const actual = realpathSync(path);
      assert.ok(actual === peer.realPath || actual === old.get(peer.name)?.realPath,
        'A root host link must belong to the current or previously verified host.');
      if (actual !== peer.realPath) unlinkSync(path);
    }
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      symlinkSync(peer.realPath, path, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const prior = old.get(peer.name);
    const specifier = 'link:' + relative(profile, peer.realPath).split('\\').join('/');
    if (manifest.dependencies[peer.name] !== undefined) {
      const previousSpecifier = prior && 'link:' + relative(profile, prior.realPath).split('\\').join('/');
      assert.ok(manifest.dependencies[peer.name] === specifier || manifest.dependencies[peer.name] === previousSpecifier,
        'Do not replace arbitrary fixture host dependencies.');
    }
    manifest.dependencies[peer.name] = specifier;
    return { ...peer, rootPath: path, provision: 'verified-host-root-link',
      manifestSpecifier: specifier, rebound: Boolean(prior && prior.realPath !== peer.realPath) };
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return bindings;
}

export function cliUpgradeSourceClosure(root = project, entries = [
  'scripts/compatibility-cli-upgrade.mjs', 'scripts/internal-candidate-host.mjs',
  'fixtures/internal-candidate/host-fixture.mjs',
]) {
  const files = new Set(), queue = [...entries];
  const parser = "import { SourceTextModule } from 'node:vm';"
    + "let input='';for await(const chunk of process.stdin)input+=chunk;"
    + "const rows=JSON.parse(input);console.log(JSON.stringify(rows.map(row=>"
    + "new SourceTextModule(row.source,{identifier:row.file}).dependencySpecifiers)));";
  while (queue.length) {
    const batch = queue.splice(0).filter(file => !files.has(file)).map(file => {
      const path = resolve(root, file);
      assert.ok(beneath(root, path) && beneath(realpathSync(root), realpathSync(path)),
        'Local verifier code escaped its source root.');
      assert.ok(lstatSync(path).isFile() && lstatSync(path).size <= 2 * 1024 * 1024);
      files.add(file); return { file, source: readFileSync(path, 'utf8') };
    });
    if (!batch.length) continue;
    assert.ok(files.size <= 100, 'Verifier import closure exceeded its file bound.');
    // Parse imports with Node's ESM parser; never link or evaluate any source module.
    const imports = JSON.parse(execFileSync(process.execPath,
      ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '-e', parser],
      { input: JSON.stringify(batch), encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
        windowsHide: true, env: {} }));
    for (const [index, specifiers] of imports.entries()) {
      for (const specifier of specifiers.filter(value => value.startsWith('.'))) {
        const path = resolve(root, dirname(batch[index].file), specifier);
        assert.ok(beneath(root, path), 'A local import escaped the verifier project.');
        queue.push(relative(root, path).split('\\').join('/'));
      }
    }
  }
  for (const name of ['package.json', 'package-lock.json']) if (existsSync(join(root, name))) files.add(name);
  return [...files].sort().map(file => {
    const path = resolve(root, file);
    assert.ok(beneath(root, path) && beneath(realpathSync(root), realpathSync(path)), 'Local verifier code escaped its source root.');
    return { file: relative(root, path).split('\\').join('/'), sha256: sha256(path) };
  });
}

export function canonicalUpgradeCut(snapshot, sessionId) {
  return canonicalRetainedSessionCut(snapshot, sessionId);
}

export async function captureCliUpgradeSession(host, reader, package_, version) {
  assert.ok(host.sessionId, 'Create and complete the old Session before retaining it.');
  const snapshot = await host.request('snapshot');
  const cut = canonicalUpgradeCut(snapshot, host.sessionId);
  const page = await reader.readPage(host, { sessionId: host.sessionId, throughSeq: cut.seq, maxMessages: 100, cutProof: cut });
  assert.ok(Array.isArray(page.records) && page.records.length > 0 && page.hasMore === false);
  assert.equal(page.cursor, cut.seq);
  const records = structuredClone(page.records);
  return { sessionId: host.sessionId, cursor: page.cursor, records,
    recordsSha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'), cut, historyRead: page.readEvidence,
    instanceId: snapshot.instanceId, hostVersion: version,
    pluginVersion: package_.manifest.version, packageSha256: package_.receipt.sha256 };
}

export async function restoreCliUpgradeSession(host, reader, retained, previousExit) {
  assert.equal(previousExit.exitCode, 0, 'Cold read requires a normal previous host exit.');
  assert.equal(previousExit.signal, null); assert.equal(previousExit.forced, false);
  assert.equal(previousExit.closeError, null);
  assert.ok(!host.sessionId, 'Read the old cut before activating any Session in the new host.');
  const snapshot = await host.request('snapshot');
  assert.ok(snapshot.instanceId && snapshot.instanceId !== previousExit.instanceId,
    'Cold read requires a new actual host lifetime.');
  const page = await readRetainedSession(adaptRetainedSessionRpc(host, reader, retained), retained);
  host.sessionId = retained.sessionId;
  return { coldReadBeforePrompt: true, historyMatched: true, sameSessionId: true,
    hostInstanceId: snapshot.instanceId, previousHostInstanceId: previousExit.instanceId, historyRead: page.readEvidence };
}

export async function cliUpgradeTurn(host, mode, { timeoutMs = 60_000 } = {}) {
  assert.ok(['search', 'fetch', 'chat'].includes(mode));
  if (!host.sessionId) {
    const created = await host.rpc('session/create', { cwd: host.workspace });
    assert.ok(created.sessionId); host.sessionId = created.sessionId;
  }
  const before = await host.request('snapshot');
  await host.rpc('session/prompt', { requestId: 'cli-upgrade-' + randomUUID(), sessionId: host.sessionId,
    mode: 'queue', content: [{ type: 'text', text: mode }] });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = await host.request('snapshot');
    const events = after.sessionEvents.slice(before.sessionEvents.length).filter(event => event.sessionId === host.sessionId);
    const final = events.findLast(event => event.type === 'assistant/message'
      && event.data?.message?.content?.some(block => block.type === 'text' && block.text === '\u5185\u90e8\u5019\u9009\u8f6e\u6b21\u5b8c\u6210'));
    const ended = final && events.find(event => event.type === 'turn/end'
      && event.data?.turn === final.data.turn && event.data?.reason?.kind === 'completed');
    const tool = final && events.findLast(event => event.type === 'tool/result' && event.data?.turn === final.data.turn);
    if (ended && after.completed > before.completed && (mode === 'chat' || tool)) {
      assert.notEqual(tool?.data?.message?.isError, true, 'The actual Session tool failed.');
      assert.equal(after.calls.original, before.calls.original, 'A Session turn reached the original search provider.');
      if (mode === 'search') assert.ok(tool.data.message.content.some(block => block.type === 'text'
        && block.text.includes('CLI upgrade real MCP result')), 'Require the real Grok loopback answer.');
      return { mode, sessionId: host.sessionId, completed: true, originalSearchDelta: 0,
        toolError: false, hostInstanceId: after.instanceId };
    }
    await sleep(50);
  }
  throw new Error('Actual Session turn did not complete: ' + mode);
}

export function inspectCliUpgradeInstall(profile, runtimeRoot, package_, { hostDefaultPeerPolicy = false } = {}) {
  const modules = join(profile, 'node_modules');
  const product = realpathSync(join(modules, 'dsh-grok-search'));
  assert.ok(beneath(profile, product), 'The installed product must remain inside the owned profile.');
  const manifest = JSON.parse(readFileSync(join(product, 'package.json'), 'utf8'));
  assert.equal(manifest.name, package_.manifest.name); assert.equal(manifest.version, package_.manifest.version);
  for (const row of package_.receipt.sourceHashes) {
    const path = join(product, row.file);
    assert.ok(beneath(product, realpathSync(path)), 'A product file escapes its installed package.');
    assert.equal(sha256(path), row.sha256, 'Native install changed a frozen package file: ' + row.file);
  }
  const expected = new Map();
  for (const name of HOST_PEERS) {
    const path = join(runtimeRoot, 'node_modules', name);
    assert.ok(existsSync(path), 'The verified host must provide every product host peer.');
    expected.set(name, { version: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version, realPath: realpathSync(path) });
  }
  const peers = [], seen = new Set();
  const visit = directory => {
    if (!existsSync(directory)) return;
    const actual = realpathSync(directory);
    assert.ok(beneath(profile, actual) || beneath(runtimeRoot, actual), 'A dependency escaped the profile and verified host.');
    if (!beneath(profile, actual) || seen.has(actual)) return;
    assert.ok(seen.size < 10_000, 'Peer audit exceeded its bounded module-directory limit.');
    seen.add(actual);
    const inspect = (name, path) => {
      const actualPackage = realpathSync(path);
      assert.ok(beneath(profile, actualPackage) || beneath(runtimeRoot, actualPackage), 'A package link escaped the owned roots.');
      const manifestPath = join(actualPackage, 'package.json'), stat = lstatSync(manifestPath, { throwIfNoEntry: false });
      let pkg = null;
      if (stat) {
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024,
          'Dependency manifests must be bounded ordinary files.');
        pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
      }
      if (HOST_PEERS.includes(name) || HOST_PEERS.includes(pkg?.name)) {
        assert.equal(name, pkg?.name, 'A host peer alias cannot hide its actual package identity.');
        assert.equal(pkg.version, expected.get(name).version, 'A second host version entered native dependencies.');
        assert.equal(actualPackage, expected.get(name).realPath,
          'A private host peer copy entered native dependencies, even if its version matches.');
        peers.push({ name, version: pkg.version, path: relative(profile, path), realPath: actualPackage });
      }
      visit(join(actualPackage, 'node_modules'));
    };
    for (const row of readdirSync(actual, { withFileTypes: true })) {
      if (!row.isDirectory() && !row.isSymbolicLink()) continue;
      const path = join(actual, row.name);
      if (row.name === '.pnpm') {
        for (const slot of readdirSync(path, { withFileTypes: true })) {
          if (slot.isDirectory()) visit(slot.name === 'node_modules' ? join(path, slot.name) : join(path, slot.name, 'node_modules'));
        }
      } else if (row.name.startsWith('@')) {
        for (const pkg of readdirSync(path, { withFileTypes: true })) {
          if (pkg.isDirectory() || pkg.isSymbolicLink()) inspect(row.name + '/' + pkg.name, join(path, pkg.name));
        }
      } else if (row.name === '.ignored' || row.name === '.store') visit(path);
      else if (!row.name.startsWith('.')) inspect(row.name, path);
    }
  };
  visit(modules);
  const policy = readFileSync(join(profile, '.npmrc'), 'utf8');
  for (const line of [...(hostDefaultPeerPolicy ? [] : ['auto-install-peers=true', 'strict-peer-dependencies=true']),
    'legacy-peer-deps=false', 'force=false']) {
    assert.ok(policy.split(/\r?\n/).includes(line), 'Native peer policy is absent: ' + line);
  }
  const strictCandidate = manifest.version === '0.4.0' && !hostDefaultPeerPolicy;
  assert.ok(['0.3.0', '0.4.0'].includes(manifest.version));
  if (!strictCandidate) {
    const hostPolicy = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(hostPolicy, /^autoInstallPeers: false$/m, 'The old package uses the unchanged official host installation default.');
    assert.match(hostPolicy, /^nodeLinker: hoisted$/m);
    assert.doesNotMatch(hostPolicy, /ignoreMissing|allowedVersions|overrides/);
  }
  const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  const override = JSON.stringify({ overrides: profileManifest.pnpm?.overrides,
    npmOverrides: profileManifest.overrides, resolutions: profileManifest.resolutions });
  assert.ok(!HOST_PEERS.some(peer => override.includes(peer)), 'The fixture must not override host peers.');
  for (const name of HOST_PEERS) {
    const path = join(modules, name);
    assert.ok(lstatSync(path).isSymbolicLink(), 'A legitimate root peer must link to the verified shipped host.');
    assert.equal(realpathSync(path), expected.get(name).realPath, 'The root peer must resolve to this actual host.');
    assert.equal(profileManifest.dependencies?.[name],
      'link:' + relative(profile, expected.get(name).realPath).split('\\').join('/'),
      'The verifier host dependency must remain a link to the original shipped runtime.');
  }
  return { product, installedFilesVerified: package_.receipt.sourceHashes.length, peers,
    hostPeerProvisioning: 'verified-host-root-links', secondHostInstalled: false,
    autoInstallPeers: strictCandidate, strictPeerDependencies: strictCandidate, legacyPeerDeps: false, force: false,
    installPolicyScope: strictCandidate ? 'strict-new-package-native-install'
      : hostDefaultPeerPolicy ? 'official-host-default-lifecycle-separate-strict-install-proof'
        : 'unchanged-official-host-default-old-package-baseline' };
}

async function runCaptured(command, args, { cwd, env, timeoutMs = 360_000, outputLimit = 2 * 1024 * 1024 }) {
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
    detached: process.platform === 'linux', stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, truncated = false, spawnError = null;
  const collect = (current, chunk) => {
    if (current.length + chunk.length > outputLimit) truncated = true;
    return (current + chunk).slice(0, outputLimit);
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = collect(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = collect(stderr, chunk); });
  child.on('error', error => { spawnError = error.code ?? error.message; });
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, timeoutMs);
  const exit = await new Promise(done => child.once('close', (exitCode, signal) => done({ exitCode, signal })));
  clearTimeout(timer);
  return { command, args, ...exit, timedOut, truncated, spawnError, stdout, stderr };
}

function waitForClose(closed, timeoutMs) {
  let timer;
  return Promise.race([closed.then(() => true),
    new Promise(done => { timer = setTimeout(() => done(false), timeoutMs); })]).finally(() => clearTimeout(timer));
}

export async function readCliUpgradeClosingSnapshot(host) {
  const before = await host.request('snapshot'), closing = await host.request('close');
  const count = closing?.calls?.original;
  return { instanceId: closing?.instanceId ?? before.instanceId,
    originalSearchCalls: Number.isSafeInteger(count) && count >= 0 ? count : null,
    counterObservation: 'actual-host-close-reply-before-shutdown' };
}

export function cliUpgradeExitEvidence(exits, remainingProcesses = []) {
  const observed = exits.length > 0 && exits.every(exit =>
    Number.isSafeInteger(exit.originalSearchCalls) && exit.originalSearchCalls >= 0);
  const officialSearchCalls = observed ? exits.reduce((sum, exit) => sum + exit.originalSearchCalls, 0) : null;
  const cleanupVerified = remainingProcesses.length === 0 && exits.length === 3
    && exits.every(exit => exit.exitCode === 0 && exit.signal === null && exit.forced === false
      && exit.closeError === null && (exit.preservationError ?? null) === null);
  return { officialSearchCalls, cleanupVerified,
    passed: cleanupVerified && exits.every(exit => exit.originalSearchCalls === 0) && officialSearchCalls === 0 };
}

export function readCliUpgradeCompatibilityState(profileDir) {
  const path = join(profileDir, 'grok-search/compatibility-state.json');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { present: false, sha256: null, size: 0 };
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024,
    'Compatibility metadata must remain a bounded ordinary product state file.');
  return { present: true, sha256: sha256(path), size: stat.size };
}

export async function seedCliUpgradeCompatibilityState({ profileDir, hostVersion, productDir }) {
  const manifest = JSON.parse(readFileSync(join(productDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-grok-search'); assert.equal(manifest.version, '0.4.0');
  const { createCompatibilityState } = await import(pathToFileURL(join(productDir, 'src/core/compatibility-state.mjs')).href);
  const state = createCompatibilityState({ profileDir, hostVersion, pluginVersion: manifest.version });
  try {
    const before = state.snapshot();
    assert.equal(before.errorCode, null); assert.equal(before.confirmed, false, 'Notice seeding must never grant consent.');
    const after = await state.markNotified({ hostVersion, pluginVersion: manifest.version, expectedRevision: before.revision });
    assert.equal(after.errorCode, null); assert.equal(after.notified, true); assert.equal(after.confirmed, false);
    const file = readCliUpgradeCompatibilityState(profileDir);
    assert.equal(file.present, true); assert.equal(file.sha256, after.revision);
    return { operation: 'shipped-createCompatibilityState.markNotified', hostVersion, pluginVersion: manifest.version,
      before, after, file, consentGranted: false };
  } finally { state.dispose(); }
}

async function startUpgradeHost(runtime, root, env, { prepareOnly = false } = {}) {
  const child = spawn(runtime.node, [join(project, 'scripts/internal-candidate-host.mjs'), runtime.runtimeRoot,
    root, '--cli-runtime-root'], { cwd: root, env, shell: false, windowsHide: true, detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let ended = false, exitCode = null, signal = null, forced = false, closeError = null, serial = 0, readyInstanceId = null;
  let originalSearchCalls = null, counterObservation = null;
  let stdout = '', stderr = '', truncated = false;
  const pending = new Map(), messages = [];
  const append = (text, chunk) => {
    if (text.length + chunk.length > 2 * 1024 * 1024) truncated = true;
    return (text + chunk).slice(0, 2 * 1024 * 1024);
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
  const closed = new Promise(done => child.once('close', (code, exitSignal) => {
    ended = true; exitCode = code; signal = exitSignal;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Owned CLI host closed.')); }
    pending.clear(); done();
  }));
  child.on('error', error => messages.push({ type: 'fatal', error: { message: error.code ?? error.message } }));
  child.on('message', message => {
    if (message.type !== 'reply') { messages.push(message); return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok) item.resolve(message.value);
    else item.reject(Object.assign(new Error(message.error?.message ?? 'Host operation failed.'), { code: message.error?.code }));
  });
  const host = {
    pid: child.pid, workspace: join(root, 'workspace'), closed,
    async request(op, args = {}) {
      assert.equal(ended, false);
      const id = 'cli-upgrade-ipc-' + (++serial);
      return new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Owned host IPC timed out: ' + op)); }, 30_000);
        pending.set(id, { resolve: resolveReply, reject, timer });
        child.send({ id, op, args }, error => {
          if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      });
    },
    async close() {
      let instanceId = readyInstanceId;
      try {
        originalSearchCalls = null; counterObservation = null;
        if (!ended) {
          ({ instanceId, originalSearchCalls, counterObservation } = await readCliUpgradeClosingSnapshot(host));
        }
        const finished = await waitForClose(closed, 20_000);
        if (!finished) throw new Error('Owned host did not exit normally.');
      } catch (error) {
        closeError = error.message;
        if (!ended && child.pid) {
          forced = true;
          try { process.kill(-child.pid, 'SIGTERM'); } catch {}
          await waitForClose(closed, 3000);
          if (!ended) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
            if (!await waitForClose(closed, 3000)) {
              child.stdout.destroy(); child.stderr.destroy(); child.unref();
              closeError += ' The process did not close after bounded forced termination.';
            }
          }
        }
      }
      return { instanceId, exitCode, signal, forced, closeError, originalSearchCalls, counterObservation, truncated, stdout, stderr };
    },
  };
  child.send({ productWiring: true, preserveProductSelection: true,
    nativeCli: { version: runtime.version, receiptPath: runtime.receiptPath, receiptSha256: runtime.receiptSha256,
      receiptRoot: runtime.receiptRoot, configurationOnce: true, initializeConfiguration: prepareOnly, prepareOnly } });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const fatal = messages.find(message => message.type === 'fatal');
      if (fatal) throw Object.assign(new Error(fatal.error?.message ?? 'Host startup failed.'), { code: fatal.error?.code });
      if (prepareOnly) {
        const prepared = messages.find(message => message.type === 'prepared');
        if (prepared) {
          assert.equal(await waitForClose(closed, 10_000), true, 'The preparation child must actually exit.');
          assert.equal(exitCode, 0); assert.equal(signal, null);
          return { prepared, exit: { exitCode, signal, forced, closeError, stdout, stderr } };
        }
      } else {
        const ready = messages.find(message => message.type === 'ready');
        const listening = messages.find(message => message.type === 'listening');
        if (ready && listening) {
          host.ready = ready;
          readyInstanceId = ready.instanceId;
          const origin = new URL(listening.origin);
          const authUrl = new URL(listening.authUrl);
          assert.equal(origin.hostname, '127.0.0.1'); assert.equal(authUrl.origin, origin.origin);
          const auth = await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
          assert.equal(auth.status, 303);
          const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0];
          assert.ok(cookie);
          host.rpc = async (method, request) => {
            assert.ok(['session/create', 'session/prompt', 'session/page'].includes(method));
            const response = await fetch(origin.origin + '/api/' + method, { method: 'POST',
              headers: { 'content-type': 'application/json', origin: origin.origin, cookie },
              body: JSON.stringify({ type: 'client-request', rpcId: 'cli-upgrade-rpc-' + (++serial),
                method, payload: { args: { request } } }), signal: AbortSignal.timeout(60_000) });
            const result = (await response.json()).result;
            assert.equal(result?.ok, true, 'Official Session RPC failed: ' + JSON.stringify(result?.error));
            return result.value;
          };
          return host;
        }
      }
      if (ended) throw new Error('Owned host exited before readiness: ' + (exitCode ?? signal));
      await sleep(25);
    }
    throw new Error('Owned host readiness timed out.');
  } catch (error) {
    const exit = await host.close();
    error.hostExit = exit; throw error;
  }
}

async function startUpgradeLoopback() {
  const requests = [], sockets = new Set();
  let unexpected = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses'
      || request.headers.authorization !== 'Bearer ' + SENTINEL || requests.length >= 100) {
      unexpected++; response.writeHead(403); response.end(); return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { if (body.length < 1024 * 1024) body += chunk; });
    request.on('end', () => {
      let document;
      try { document = JSON.parse(body); } catch {}
      if (document?.model !== 'cli-upgrade' || body.length >= 1024 * 1024) {
        unexpected++; response.writeHead(403); response.end(); return;
      }
      requests.push({ method: request.method, path: request.url, model: document.model, syntheticKey: true });
      const text = 'CLI upgrade real MCP result';
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'resp-' + randomUUID(), object: 'response', status: 'completed',
        model: document.model, output_text: text, output: [
          { type: 'web_search_call', action: { sources: [{ url: 'https://example.invalid/cli-upgrade',
            title: 'CLI upgrade fixture', description: text }] } },
          { type: 'message', content: [{ type: 'output_text', text }] },
        ] }));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { origin: 'http://127.0.0.1:' + server.address().port, requests,
    unexpected: () => unexpected, async close() {
      const closed = new Promise(done => server.close(done));
      for (const socket of sockets) socket.destroy();
      await closed;
    } };
}

export async function executeCliUpgradeStages(plan, operations) {
  let retained = null, previousExit = null, previousPackageIndex = null;
  const stages = [];
  for (const stage of plan) {
    if (!stage.rejected && stage.packageIndex !== previousPackageIndex) await operations.install(stage);
    const host = await operations.start(stage);
    let record, stageError;
    try {
      const reader = await operations.reader(host);
      const coldRead = retained ? await restoreCliUpgradeSession(host, reader, retained, previousExit) : null;
      if (stage.rejected) {
        const boundary = await operations.verifyRejected(host, stage);
        record = { ...stage, boundary, retainedSession: { coldRead, sessionId: retained.sessionId,
          cursor: retained.cursor, recordsSha256: retained.recordsSha256, cut: retained.cut,
          historyRead: retained.historyRead }, searchIssued: false };
      } else {
        const ready = await operations.verifyRequired(host, stage);
        const turns = [];
        for (const mode of ['search', 'fetch', 'chat']) turns.push(await operations.turn(host, mode));
        let historyAfterTurns;
        if (!retained) {
          retained = await operations.capture(host, reader, stage);
          historyAfterTurns = retained.historyRead;
        }
        else {
          assert.ok(turns.every(turn => turn.sessionId === retained.sessionId), 'Every upgrade turn must retain the old Session ID.');
          const page = await readRetainedSession(adaptRetainedSessionRpc(host, reader, retained), retained);
          historyAfterTurns = page.readEvidence;
        }
        record = { ...stage, ready, turns, retainedSession: { coldRead, sessionId: retained.sessionId,
          cursor: retained.cursor, recordsSha256: retained.recordsSha256, recordCount: retained.records.length,
          cut: retained.cut, historyRead: retained.historyRead, historyAfterTurns },
          searchIssued: true };
      }
      await operations.preserve(stage);
    } catch (error) {
      stageError = error;
    } finally {
      let exit;
      try { exit = await operations.close(host, stage); }
      catch (error) {
        stageError ??= error;
        exit = { instanceId: null, exitCode: null, signal: null, forced: true, closeError: error.message,
          originalSearchCalls: null };
      }
      if (record) record.exit = exit;
      previousExit = exit;
      try {
        assert.equal(exit.exitCode, 0, 'A package cannot be replaced after an abnormal host exit.');
        assert.equal(exit.signal, null); assert.equal(exit.forced, false); assert.equal(exit.closeError, null);
        assert.equal(exit.preservationError ?? null, null, 'Private state preservation failed after host exit.');
        assert.equal(exit.originalSearchCalls, 0, 'Every stage close must observe an actual original search counter of zero.');
      } catch (error) { stageError ??= error; }
      await operations.record(stage, record, stageError, exit);
      if (stageError) throw stageError;
    }
    if (stageError) throw stageError;
    stages.push(record); previousPackageIndex = stage.packageIndex;
  }
  assert.ok(retained && stages.length === 3);
  return { stages, retainedSession: { sessionId: retained.sessionId, cursor: retained.cursor,
    recordsSha256: retained.recordsSha256, recordCount: retained.records.length, cut: retained.cut, historyRead: retained.historyRead } };
}

function persistentFiles(directory, { revisionsOnly = false } = {}) {
  if (!existsSync(directory)) return [];
  const files = [], walk = current => {
    for (const row of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, row.name);
      assert.equal(row.isSymbolicLink(), false, 'Retained private data cannot contain links.');
      if (row.isDirectory()) walk(path);
      else if (!revisionsOnly || /^v\d{12}\.json$/.test(row.name)) {
        assert.ok(files.length < 10_000 && lstatSync(path).size <= 8 * 1024 * 1024, 'Private evidence exceeded its file bound.');
        files.push({ file: relative(directory, path), sha256: sha256(path) });
      }
    }
  };
  walk(directory); return files;
}

export async function runCliUpgrade(options) {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const packages = [options.oldPackage, options.newPackage].map(readUpgradePackage);
  const runtimes = [readCliUpgradeRuntime(options)];
  if (options.toVersion) runtimes.push(readCliUpgradeRuntime({ cli: options.toCli, node: options.toNode,
    runtimeRoot: options.toRuntimeRoot, receiptRoot: options.toReceiptRoot ?? options.toRuntimeRoot, receiptPath: options.toReceiptPath,
    receiptSha256: options.toReceiptSha256, version: options.toVersion }));
  const plan = cliUpgradeStages(packages[0].manifest, packages[1].manifest, runtimes);
  const root = validateCliUpgradeRoot(options.runRoot, [project, ...runtimes.flatMap(runtime => [runtime.runtimeRoot, runtime.receiptRoot]),
    options.oldPackage, options.newPackage, options.retainedCache, options.pnpmEntry, options.pnpmStore, options.pnpmCache]);
  for (const path of [options.retainedCache, options.pnpmStore, options.pnpmCache]) {
    const stat = lstatSync(path);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o077, 0, 'Use existing current-user private cache directories.');
  }
  assert.ok(lstatSync(options.pnpmEntry).isFile());
  assert.equal(typeof createRetainedSessionReader, 'function', 'The shared fixed-cut reader must be available before any host runs.');
  mkdirSync(root, { mode: 0o700 });
  const sanitize = text => String(text).replaceAll(SENTINEL, '<SYNTHETIC_KEY>')
    .replace(/([?&]token=)[^\s"'&\\]+/g, '$1<AUTH_REDACTED>')
    .replaceAll(root, '<RUN_ROOT>').replaceAll(project, '<PROJECT>');
  const json = (name, value) => writeFileSync(join(root, name), sanitize(JSON.stringify(value, null, 2)) + '\n',
    { flag: 'wx', mode: 0o600 });
  const log = (name, text) => writeFileSync(join(root, name), sanitize(text), { flag: 'wx', mode: 0o600 });
  const sourceHashes = cliUpgradeSourceClosure();
  json('source-identity.json', { scope: 'transitive-local-import-closure-plus-explicit-child-and-fixture',
    sourceHashes, packages: packages.map(package_ => ({ version: package_.manifest.version,
      sha256: package_.receipt.sha256, integrity: package_.receipt.integrity ?? null,
      sourceHashes: package_.receipt.sourceHashes })) });
  const pnpmHash = sha256(options.pnpmEntry);
  const commands = [], installs = [], exits = [];
  let host = null, upstream = null, fatal = null, execution = null, preservation;
  const envs = runtimes.map(runtime => cliUpgradeEnvironment(root, runtime.node, options.pnpmEntry));
  const profile = join(envs[0].DSH_HOME, 'profiles/candidate');
  const privateRoot = join(profile, 'grok-search');
  const cache = join(privateRoot, 'runtime-cache');
  const configPath = join(envs[0].HOME, '.config/grok-search-rs/config.toml');
  const prefsPath = join(privateRoot, 'preferences.json');
  const controlDirectory = join(profile, 'control-intent.records');
  const compatibilityMetadata = { oldPluginStateAbsent: null, seed: null, observations: [],
    scope: options.toVersion ? 'first-0.4-final-stage-marker-no-later-host-transition'
      : 'first-0.4-marker-retained-byte-for-byte-through-0.3-rollback' };
  const preserved = () => ({ configuration: sha256(configPath), preferences: sha256(prefsPath),
    configHistory: persistentFiles(join(privateRoot, 'config-history')), cache: persistentFiles(cache),
    fixture: persistentFiles(join(root, 'fixture-package')), profilePatch: sha256(join(profile, 'cordis.patch.yml')),
    profilePolicy: sha256(join(profile, '.npmrc')), compatibilityState: readCliUpgradeCompatibilityState(profile) });
  const invoke = async (label, command, args, env) => {
    const result = await runCaptured(command, args, { cwd: root, env });
    log(label + '.stdout.log', result.stdout); log(label + '.stderr.log', result.stderr);
    const { stdout, stderr, ...receipt } = result;
    commands.push({ label, ...receipt }); json(label + '.command.json', receipt);
    assert.equal(result.exitCode, 0, 'Native command failed: ' + label);
    assert.equal(result.signal, null); assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false); assert.equal(result.spawnError, null);
    return result;
  };
  let revision = 0, retainedControl = [], hostBindings = [], boundRuntime = null;
  try {
    for (const [index, runtime] of runtimes.entries()) {
      const nodeResult = await invoke('node-' + index, runtime.node, ['--version'], envs[index]);
      const version = nodeResult.stdout.trim().replace(/^v/, '');
      assert.equal(semver.valid(version), version);
      if (runtime.receipt.asset.nodeRange) assert.ok(semver.satisfies(version, runtime.receipt.asset.nodeRange));
      const cliResult = await invoke('cli-' + index, runtime.node, [runtime.cli, '--version'], envs[index]);
      assert.equal(cliResult.stdout.trim(), runtime.version, 'Verified CLI runtime version differs from its receipt.');
    }
    mkdirSync(join(profile, 'node_modules'), { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-cli-upgrade-profile', private: true,
      type: 'module', dependencies: { 'candidate-offline-fixture': 'file:' + join(root, 'fixture-package') },
      dsh: { profile: { bundles: ['candidate-offline-fixture', 'dsh-grok-search'] } } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(join(profile, '.npmrc'), [`store-dir=${options.pnpmStore}`, `cache-dir=${options.pnpmCache}`,
      ...(options.hostDefaultPeerPolicy ? [] : ['auto-install-peers=true', 'strict-peer-dependencies=true']),
      'legacy-peer-deps=false', 'force=false', ''].join('\n'),
    { flag: 'wx', mode: 0o600 });
    const preparation = await startUpgradeHost(runtimes[0], root, envs[0], { prepareOnly: true });
    json('fixture-preparation.json', preparation.prepared);
    hostBindings = bindCliUpgradeHostPeers(profile, runtimes[0]); boundRuntime = 0;
    json('initial-host-peer-bindings.json', hostBindings);
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, [`grok_api_url = ${JSON.stringify((upstream = await startUpgradeLoopback()).origin + '/v1')}`,
      `grok_api_key = ${JSON.stringify(SENTINEL)}`, 'grok_auth_mode = "api_key"', 'grok_model = "cli-upgrade"',
      'timeout_seconds = 30', 'response_max_chars = 6000', 'fallback_sources = 0', 'default_extra_sources = 0',
      'tavily_enabled = false', 'exa_enabled = false', 'tinyfish_enabled = false', 'firecrawl_enabled = false', ''].join('\n'),
    { flag: 'wx', mode: 0o600 });
    const cacheFiles = retainUpgradeCache(options.retainedCache, cache);
    const active = JSON.parse(readFileSync(join(cache, 'active.json'), 'utf8'));
    const binary = resolve(cache, active.executable);
    assert.equal(active.mcpHandshakeValidated, true); assert.equal(active.version, '0.1.26');
    if (active.platform !== undefined) assert.equal(active.platform, 'linux');
    if (active.arch !== undefined) assert.equal(active.arch, 'x64');
    assert.equal(sha256(binary), active.sha256);
    writeFileSync(prefsPath, JSON.stringify({ schemaVersion: 1, grokEnabled: true, githubEnabled: false,
      githubReadEnabled: false, sourceOrder: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
      sourceEnabled: { tavily: false, exa: false, tinyfish: false, firecrawl: false } }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
    preservation = preserved();
    execution = await executeCliUpgradeStages(plan, {
      async install(stage) {
        const runtime = runtimes[stage.runtimeIndex], package_ = packages[stage.packageIndex];
        assert.equal(host, null, 'Native package installation requires the previous host to be closed.');
        hostBindings = bindCliUpgradeHostPeers(profile, runtime, hostBindings);
        boundRuntime = stage.runtimeIndex;
        json(stage.id + '-host-peer-bindings.json', hostBindings);
        await invoke(stage.id + '-native-add', runtime.node,
          cliUpgradeInstallArguments(runtime, package_.path, { ...options, pluginVersion: package_.manifest.version }),
          cliUpgradeInstallEnvironment(envs[stage.runtimeIndex], package_.manifest.version, options));
        const audit = inspectCliUpgradeInstall(profile, runtime.runtimeRoot, package_, options);
        installs.push({ stage: stage.id, pluginVersion: package_.manifest.version, hostVersion: runtime.version, audit });
        assert.deepEqual(preserved(), preservation, 'Native add changed retained private data.');
        for (const row of retainedControl) assert.equal(sha256(join(controlDirectory, row.file)), row.sha256);
      },
      async start(stage) {
        assert.equal(host, null, 'A host transition requires normal teardown of the preceding owner.');
        if (boundRuntime !== stage.runtimeIndex) {
          hostBindings = bindCliUpgradeHostPeers(profile, runtimes[stage.runtimeIndex], hostBindings);
          boundRuntime = stage.runtimeIndex; json(stage.id + '-host-peer-rebind.json', hostBindings);
        }
        host = await startUpgradeHost(runtimes[stage.runtimeIndex], root, envs[stage.runtimeIndex]);
        return host;
      },
      reader: async () => createRetainedSessionReader(),
      async verifyRequired(current, stage) {
        const deadline = Date.now() + 60_000;
        let state;
        while (Date.now() < deadline) {
          state = await current.request('snapshot');
          if (state.productProgram?.phase === 'error') throw new Error('Private program readiness failed.');
          if (state.productControl?.phase === 'required' && state.productProgram?.phase === 'ready') break;
          await sleep(25);
        }
        assert.equal(state.productControl?.phase, 'required'); assert.equal(state.productProgram?.phase, 'ready');
        assert.equal(state.productControl.recordEnvelope.intent.policy, 'required');
        assert.ok(state.productControl.revision > revision); revision = state.productControl.revision;
        assert.equal(state.runtimeWeb.searchProviderId, 'grok-search');
        assert.equal(state.runtimeWeb.fetchProviderId, 'candidate-fetch');
        assert.equal(state.productProgram.program.source, 'private-cache'); assert.equal(state.productProgram.program.path, binary);
        assert.equal(state.productProgram.configuration.executable, false);
        assert.equal(state.productProgram.configuration.configPath, false); assert.equal(state.productProgram.configPath, configPath);
        assert.equal(state.calls.original, 0); assert.equal(state.existingDependencyPresent, true);
        assert.deepEqual(current.ready.failed, []); assert.deepEqual(current.ready.pending, []);
        assert.deepEqual(preserved(), preservation, 'Compatibility state must not change before the explicit notice marker.');
        if (stage.id === 'old-seed') {
          assert.equal(preservation.compatibilityState.present, false, 'The unchanged 0.3 package has no compatibility state.');
          compatibilityMetadata.oldPluginStateAbsent = true;
        }
        if (packages[stage.packageIndex].manifest.version === '0.4.0' && !compatibilityMetadata.seed) {
          const productDir = realpathSync(join(profile, 'node_modules/dsh-grok-search'));
          compatibilityMetadata.seed = await seedCliUpgradeCompatibilityState({ profileDir: profile,
            hostVersion: runtimes[stage.runtimeIndex].version, productDir });
          preservation = { ...preservation, compatibilityState: compatibilityMetadata.seed.file };
          assert.deepEqual(preserved(), preservation, 'Notice seeding must not alter unrelated retained state.');
        }
        const compatibilityState = readCliUpgradeCompatibilityState(profile);
        compatibilityMetadata.observations.push({ stage: stage.id, point: 'required-ready', file: compatibilityState });
        return { hostVersion: runtimes[stage.runtimeIndex].version, pluginVersion: packages[stage.packageIndex].manifest.version,
          revision, requiredIntent: true, routeOwned: true, programSource: 'private-cache', originalSearchCalls: 0,
          compatibilityState };
      },
      async verifyRejected(current, stage) {
        const bundles = await current.request('plugin-manager-state');
        const bundle = bundles.find(row => row.name === 'dsh-grok-search');
        assert.equal(bundle?.version, '0.3.0'); assert.equal(bundle?.enabled, true); assert.equal(bundle?.installed, true);
        assert.equal(bundle?.error?.code, 'incompatible-version');
        const issue = bundle.error.incompatible;
        assert.ok(Array.isArray(issue) && issue.length === 1);
        assert.equal(issue[0].runtimeVersion, runtimes[stage.runtimeIndex].version);
        assert.deepEqual(issue[0].requirements, { 'engines.dsh': packages[0].manifest.engines.dsh });
        const state = await current.request('snapshot');
        assert.equal(state.productControl, null); assert.equal(state.productProgram, null);
        assert.equal(state.calls.original, 0);
        const compatibilityState = readCliUpgradeCompatibilityState(profile);
        assert.equal(compatibilityState.present, false, 'A rejected old package must not create 0.4 compatibility metadata.');
        compatibilityMetadata.observations.push({ stage: stage.id, point: 'old-package-rejected', file: compatibilityState });
        return { code: bundle.error.code, oldPluginActive: false, searchIssued: false,
          originalSearchCalls: 0, compatibilityState, protectionStatus: 'old-plugin-unloaded-not-protected' };
      },
      turn: cliUpgradeTurn,
      capture: (current, reader, stage) => captureCliUpgradeSession(current, reader, packages[stage.packageIndex],
        runtimes[stage.runtimeIndex].version),
      async preserve() {
        assert.deepEqual(preserved(), preservation);
        for (const row of retainedControl) assert.equal(sha256(join(controlDirectory, row.file)), row.sha256);
      },
      async close(current, stage) {
        const exit = await current.close(); exits.push({ stage: stage.id, ...exit, stdout: undefined, stderr: undefined });
        log(stage.id + '-host.stdout.log', exit.stdout); log(stage.id + '-host.stderr.log', exit.stderr);
        host = null;
        let preservationError = null;
        try {
          assert.deepEqual(preserved(), preservation);
          for (const row of retainedControl) assert.equal(sha256(join(controlDirectory, row.file)), row.sha256);
          retainedControl = persistentFiles(controlDirectory, { revisionsOnly: true });
          for (const row of cacheFiles) assert.equal(sha256(row.from), row.sha256, 'Source test cache changed.');
          compatibilityMetadata.observations.push({ stage: stage.id, point: 'normal-close',
            file: readCliUpgradeCompatibilityState(profile) });
        } catch (error) { preservationError = error.message; }
        return { ...exit, preservationError, stdout: undefined, stderr: undefined };
      },
      async record(stage, record, error, exit) {
        json(stage.id + '.json', { record, failure: error ? { code: error.code ?? null, message: error.message } : null, exit });
      },
    });
    assert.equal(upstream.unexpected(), 0);
  } catch (error) {
    fatal = { code: error.code ?? null, message: error.message, ...(error.hostExit ? { hostExit: error.hostExit } : {}) };
  } finally {
    if (host) {
      try {
        const exit = await host.close(); exits.push({ stage: 'failure-cleanup', ...exit, stdout: undefined, stderr: undefined });
        log('failure-cleanup-host.stdout.log', exit.stdout); log('failure-cleanup-host.stderr.log', exit.stderr);
        if (exit.exitCode !== 0 || exit.forced || exit.closeError) fatal ??= { message: 'Owned host cleanup failed.' };
      } catch (error) { fatal ??= { message: 'Owned host cleanup failed: ' + error.message }; }
    }
    if (upstream) {
      try { await upstream.close(); } catch (error) { fatal ??= { message: 'Owned loopback cleanup failed: ' + error.message }; }
    }
  }
  let sourcesUnchanged = false;
  try { sourcesUnchanged = JSON.stringify(cliUpgradeSourceClosure()) === JSON.stringify(sourceHashes); }
  catch (error) { fatal ??= { message: 'Verifier source closure changed: ' + error.message }; }
  let originalInputsUnchanged = false;
  try {
    originalInputsUnchanged = runtimes.every(runtime => {
      const after = readCliUpgradeRuntime(runtime);
      return JSON.stringify(after.inputHashes) === JSON.stringify(runtime.inputHashes);
    }) && packages.every(package_ => sha256(package_.path) === package_.receipt.sha256)
      && sha256(options.pnpmEntry) === pnpmHash;
  } catch (error) {
    fatal ??= { code: error.code ?? null, message: 'Original runtime input verification failed: ' + error.message };
  }
  const remainingProcesses = [];
  for (const pid of readdirSync('/proc').filter(value => /^\d+$/.test(value) && Number(value) !== process.pid)) {
    try {
      if (readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes(root)) remainingProcesses.push(Number(pid));
    } catch {}
  }
  const exitEvidence = cliUpgradeExitEvidence(exits, remainingProcesses);
  const compatibilityMetadataVerified = Boolean(execution) && compatibilityMetadata.oldPluginStateAbsent === true
    && compatibilityMetadata.seed?.file.present === true
    && compatibilityMetadata.observations.filter(row => row.file.present)
      .every(row => row.file.sha256 === compatibilityMetadata.seed.file.sha256);
  const summary = { schemaVersion: 1, kind: 'compatibility-cli-upgrade', passed: !fatal && Boolean(execution)
    && sourcesUnchanged && originalInputsUnchanged && exitEvidence.passed && compatibilityMetadataVerified,
    hostVersion: runtimes.at(-1).version, productSha256: packages[1].receipt.sha256,
    packages: packages.map(package_ => ({ version: package_.manifest.version, sha256: package_.receipt.sha256 })),
    scope: options.toVersion ? 'forward-host-and-plugin-upgrade-original-session-cut'
      : 'same-host-native-plugin-upgrade-and-rollback-original-session-cut',
    rollbackScope: options.toVersion ? 'not-run-forward-only' : 'actual-short-session-layout-not-checkpoint-downgrade-guarantee',
    realCredentialsUsed: false, transport: options.onlineNativeInstall
      ? 'loopback-responses-and-native-cli-online-install' : 'loopback-responses-and-native-cli-offline-install',
    nativeInstallResolution: options.onlineNativeInstall ? 'bounded-public-npmjs-with-private-cache' : 'explicit-offline-cache-only',
    nativePeerPolicy: options.hostDefaultPeerPolicy
      ? 'official-host-default-lifecycle-separate-strict-install-proof' : 'old-host-default-and-new-strict',
    officialSearchCalls: exitEvidence.officialSearchCalls, cleanupVerified: exitEvidence.cleanupVerified,
    remainingProcesses, fatal, execution, installs, exits, commands, sourcesUnchanged, sourceHashes,
    originalInputsUnchanged, hostPeerBindings: hostBindings,
    compatibilityMetadataVerified, compatibilityMetadata,
    configCachePreferencesPreserved: Boolean(execution), requests: upstream?.requests ?? [] };
  json('summary.json', summary);
  console.log(JSON.stringify({ passed: summary.passed, hostVersion: summary.hostVersion,
    summary: join(root, 'summary.json'), fatal: summary.fatal }));
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === ownFile) {
  try {
    const result = await runCliUpgrade(parseCliUpgradeArguments(process.argv.slice(2)));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ passed: false, code: error.code ?? null, message: error.message }));
    process.exitCode = 1;
  }
}


