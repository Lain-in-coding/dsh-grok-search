import { mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, existsSync, lstatSync, realpathSync, readdirSync, readlinkSync, symlinkSync, constants } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { candidateRuntime } from './lib/candidate-runtime.mjs';

// 只检查官方程序的 fuse 字节，不修改二进制或放宽运行策略。
export function readElectronFuseWire(binary) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const offset = binary.indexOf(sentinel);
  if (offset < 0 || binary.indexOf(sentinel, offset + 1) !== -1) throw new Error('Electron fuse sentinel is absent or ambiguous.');
  const header = offset + sentinel.length;
  const version = binary[header], length = binary[header + 1];
  if (version !== 1 || !Number.isInteger(length) || length < 6 || header + 2 + length > binary.length) {
    throw new Error('Unsupported or truncated Electron fuse wire.');
  }
  const states = binary.subarray(header + 2, header + 2 + length);
  if ([...states].some(value => ![0x30, 0x31, 0x72].includes(value))) throw new Error('Invalid Electron fuse state.');
  return { version, length, offset, wire: states.toString('ascii'),
    runAsNode: states[0] === 0x31, nodeCliInspect: states[3] === 0x31,
    embeddedAsarIntegrityValidation: states[4] !== 0x30, onlyLoadAppFromAsar: states[5] !== 0x30 };
}

export function assertDevelopmentFuseCompatibility(fuses) {
  if (!fuses.runAsNode || !fuses.nodeCliInspect || fuses.onlyLoadAppFromAsar || fuses.embeddedAsarIntegrityValidation) {
    throw new Error('Official Electron fuses do not permit this isolated development fixture.');
  }
}

function isPathInside(root, target) {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
}

function verifyMacFrameworkCopy(sourceApp, copiedApp, hashFile) {
  const sourceFrameworks = join(sourceApp, 'Contents', 'Frameworks');
  const copiedFrameworks = join(copiedApp, 'Contents', 'Frameworks');
  const sourceRoot = realpathSync(sourceApp);
  const copiedRoot = realpathSync(copiedApp);
  let relativeSymlinkCount = 0;

  const inspectDirectory = sourceDirectory => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const sourcePath = join(sourceDirectory, entry.name);
      const copiedPath = join(copiedFrameworks, relative(sourceFrameworks, sourcePath));
      if (entry.isSymbolicLink()) {
        const sourceTarget = readlinkSync(sourcePath);
        if (readlinkSync(copiedPath) !== sourceTarget) {
          throw new Error('The mac app copy changed a Framework symlink: ' + relative(sourceApp, sourcePath));
        }
        if (!isAbsolute(sourceTarget)) relativeSymlinkCount++;
        const sourceResolved = realpathSync(sourcePath);
        const copiedResolved = realpathSync(copiedPath);
        if (isPathInside(sourceRoot, sourceResolved) && !isPathInside(copiedRoot, copiedResolved)) {
          throw new Error('The mac app copy has a Framework symlink that resolves outside its bundle: ' + relative(sourceApp, sourcePath));
        }
      } else if (entry.isDirectory()) {
        inspectDirectory(sourcePath);
      }
    }
  };

  inspectDirectory(sourceFrameworks);

  const icuCandidates = [
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/icudtl.dat',
    'Contents/Frameworks/Electron Framework.framework/Resources/icudtl.dat',
  ];
  const icuPath = icuCandidates.find(path => existsSync(join(sourceApp, path)));
  if (!icuPath || !existsSync(join(copiedApp, icuPath))) {
    throw new Error('The mac app copy is missing the Electron ICU data resource.');
  }
  const sourceIcuHash = hashFile(join(sourceApp, icuPath));
  const copiedIcuHash = hashFile(join(copiedApp, icuPath));
  if (copiedIcuHash !== sourceIcuHash) throw new Error('The mac app copy changed the Electron ICU data resource.');

  return { relativeSymlinkCount, icuResource: { path: icuPath, sha256: sourceIcuHash } };
}

export function resolveNewTemporaryRunRoot(runRoot) {
  if (typeof runRoot !== 'string' || !isAbsolute(runRoot)) throw new Error('An absolute temporary --run-root is required.');
  const temporaryAlias = resolve(tmpdir()), temporary = realpathSync(temporaryAlias);
  const providedRoot = resolve(runRoot);
  const aliasRelative = relative(temporaryAlias, providedRoot);
  const underAlias = aliasRelative && aliasRelative !== '..'
    && !aliasRelative.startsWith('..' + sep) && !isAbsolute(aliasRelative);
  // macOS commonly exposes /var as the system alias of /private/var.
  // Resolve only that known tmpdir prefix; links below the run root remain forbidden.
  const root = underAlias ? join(temporary, aliasRelative) : providedRoot;
  const inside = relative(temporary, root);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)
    || !inside.split(sep)[0].startsWith('dsh-deferred-desktop-')) {
    throw new Error('Desktop fixture root must stay inside a dedicated temporary namespace.');
  }
  let current = temporary;
  for (const part of inside.split(sep)) {
    current = join(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink() || (entry && !entry.isDirectory())) throw new Error('Desktop fixture root contains a link or non-directory.');
  }
  if (lstatSync(root, { throwIfNoEntry: false })) throw new Error('A new independent --run-root is required.');
  return root;
}

export function inspectDesktopPreparation(desktopExecutable, runRoot) {
  const root = resolveNewTemporaryRunRoot(runRoot);
  const desktop = candidateRuntime(desktopExecutable);
  const source = desktop.binaryDir;
  const pnpmEntry = join(desktop.resourcesDir, desktop.app.version === '0.2.0-rc.2'
    ? 'runtime/pnpm/bin/pnpm.mjs'
    : 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs');
  if (!existsSync(pnpmEntry)) throw new Error('The matching Desktop pnpm resource is missing.');
  const fuses = readElectronFuseWire(readFileSync(desktop.fuseBinary));
  assertDevelopmentFuseCompatibility(fuses);
  return { root, desktop, source, resourcesDir: desktop.resourcesDir, pnpmEntry, fuses };
}

export function prepareDesktopFixture(desktopExecutable, runRoot, { versionedControlRecord = false, productEntries = false,
  pluginManagerEntries = false, liveHmr = false, uxEntries = false, m004 = false, m004BudgetMs = 120000,
  grokProgram = null, grokResponsesUrl = null, grokKey = null } = {}) {
  const { root, desktop, source, resourcesDir, pnpmEntry, fuses } = inspectDesktopPreparation(desktopExecutable, runRoot);
  const actualProject = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const profile = join(root, 'dsh-home', 'profiles', 'desktop');
  const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const write = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const identities = [];
  let electronRoot, resources, electron, macAppBundleValidation = null;
  if (process.platform === 'darwin') {
    if (pluginManagerEntries) {
      electronRoot = dirname(desktop.executable);
      resources = resourcesDir;
      electron = desktop.executable;
    } else {
      const appRoot = resolve(dirname(desktop.executable), '..', '..');
      electronRoot = join(root, 'DeepSeek Harness.app');
      const packagedArchive = join(resourcesDir, 'app.asar');
      cpSync(appRoot, electronRoot, {
        recursive: true, errorOnExist: true, force: false, preserveTimestamps: true,
        verbatimSymlinks: true,
        // Like the Windows fixture, use the shipped default_app runtime with the
        // original archive passed as argv. Never delete or rewrite an ASAR or re-sign code.
        filter: path => resolve(path) !== resolve(packagedArchive),
      });
      macAppBundleValidation = verifyMacFrameworkCopy(appRoot, electronRoot, hashFile);
      resources = join(electronRoot, 'Contents', 'Resources');
      electron = join(electronRoot, 'Contents', 'MacOS', 'DeepSeek Harness');
      const sourceDefault = join(resourcesDir, 'default_app.asar');
      if (!existsSync(sourceDefault)) throw new Error('The mac default_app.asar is missing.');
      for (const [name, original, destination] of [['DeepSeek Harness', desktop.executable, electron],
        ['default_app.asar', sourceDefault, join(resources, 'default_app.asar')]]) {
        const sha256 = hashFile(original);
        if (hashFile(destination) !== sha256) throw new Error('Official mac app copy identity mismatch.');
        identities.push({ name, sha256 });
      }
    }
  } else {
    electronRoot = join(root, 'electron');
    mkdirSync(electronRoot, { recursive: true });
    resources = join(electronRoot, 'resources');
    mkdirSync(resources);
    const fileNames = ['DeepSeek Harness.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
      'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'resources.pak',
      'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'];
    for (const name of fileNames) {
      const original = join(source, name), destination = join(electronRoot, name === 'DeepSeek Harness.exe' ? 'electron.exe' : name);
      copyFileSync(original, destination, constants.COPYFILE_EXCL);
      const sha256 = hashFile(original);
      if (hashFile(destination) !== sha256) throw new Error('Official binary copy identity mismatch.');
      identities.push({ name, sha256 });
    }
    cpSync(join(source, 'locales'), join(electronRoot, 'locales'), { recursive: true, errorOnExist: true, force: false });
    for (const name of ['default_app.asar', 'icon.png', 'tray.ico']) {
      copyFileSync(join(resourcesDir, name), join(resources, name), constants.COPYFILE_EXCL);
      const sha256 = hashFile(join(resourcesDir, name));
      if (hashFile(join(resources, name)) !== sha256) throw new Error('Official resource copy identity mismatch.');
      identities.push({ name: 'resources/' + name, sha256 });
    }
    electron = join(electronRoot, 'electron.exe');
  }
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  const createBundle = (name, exports, patch) => {
    const path = join(profile, 'node_modules', name); mkdirSync(path);
    write(join(path, 'package.json'), { name, version: '0.0.0', private: true, type: 'module',
      exports: { './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml', ...exports },
      engines: { dsh: '0.2.1-rc.2 || 0.2.1-rc.3' }, dsh: { bundle: { patch: './cordis.patch.yml' } } });
    write(join(path, 'cordis.patch.yml'), patch); return path;
  };
  const fixture = createBundle('candidate-offline-fixture', { '.': './desktop-fixture.mjs' }, [{ insert: [
    { id: 'fixture-desktop', name: 'candidate-offline-fixture' },
  ] }, { id: 'agent-default-model', config: { provider: 'candidate-offline', model: 'fixture-native' } },
  { id: 'web', config: { searchProvider: 'candidate-original', fetchProvider: 'candidate-fetch' }, inject: { candidateExistingDependency: { probe: 'retain-existing' } } },
  { id: 'web-search-deepseek', disabled: true }, { id: 'web-fetch-http', disabled: true },
  { id: 'llm-deepseek-account', disabled: true }, { id: 'llm-deepseek', config: { apiKeyEnv: 'DSH_DESKTOP_OFFLINE_SENTINEL' } },
  { id: 'desktop-product-telemetry', disabled: true }, { id: 'product-analytics', config: { enabled: false } },
  { id: 'agent-preset-registry', config: { default: 'desktop-fixture' } },
  { insert: [{ id: 'preset-desktop-fixture', name: '@deepseek-ai/dsh-agent-preset', config: {
    id: 'desktop-fixture', title: '离线桌面控制验收', plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '离线桌面控制验收', complete: true, includeRuntimeContext: false } },
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: m004 ? m004BudgetMs : 30000, fetchTimeoutMs: 30000 } },
    ],
  } }] }]);
  const copyCore = destination => {
    mkdirSync(destination, { recursive: true });
    for (const module of ['control-intent-store.mjs', 'startup-recovery.mjs', 'release-transaction.mjs', 'product-control.mjs', 'original-search-counter.mjs', 'errors.mjs', 'mcp-search.mjs', 'session-owner.mjs', 'result-map.mjs', 'search-executor.mjs']) {
      copyFileSync(join(actualProject, 'src/core', module), join(destination, module), constants.COPYFILE_EXCL);
    }
  };
  copyCore(fixture);
  write(join(fixture, 'desktop-fixture.mjs'), readFileSync(join(actualProject, 'fixtures/deferred-release/desktop-fixture.mjs'), 'utf8')
    .replaceAll('../../src/core/', './'));
  copyFileSync(join(actualProject, 'fixtures/internal-candidate/host-fixture.mjs'), join(fixture, 'host-fixture.mjs'));
  let grokProgramValidation = null;
  if (uxEntries || productEntries) {
    // D-28/D-29: one aggregate bundle with the real package metadata and the
    // complete src tree, exactly as PluginManager installs the tarball.
    const metadata = JSON.parse(readFileSync(join(actualProject, 'package.json'), 'utf8'));
    const product = join(profile, 'node_modules/dsh-grok-search');
    mkdirSync(product);
    let config;
    if (m004) {
      // M0-04 runs the real, identity-checked grok-search-rs against a loopback
      // Responses stub with a synthetic key. The program is copied into this
      // run; the user's global program and configuration are never used.
      if (!grokProgram || !isAbsolute(grokProgram) || !existsSync(grokProgram)) {
        throw new Error('M0-04 requires --grok-program with a verified grok-search-rs executable.');
      }
      if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(grokResponsesUrl ?? '') || !/^[\w-]{8,80}$/.test(grokKey ?? '')) {
        throw new Error('M0-04 requires a loopback --grok-responses-url and a synthetic --grok-key.');
      }
      const programDirectory = join(root, 'grok-program');
      mkdirSync(programDirectory);
      const executable = join(programDirectory, process.platform === 'win32' ? 'grok-search-rs.exe' : 'grok-search-rs');
      copyFileSync(grokProgram, executable, constants.COPYFILE_EXCL);
      const sourceSha256 = hashFile(grokProgram);
      if (hashFile(executable) !== sourceSha256) throw new Error('Grok program copy identity mismatch.');
      const probe = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, PATH: dirname(executable) } });
      const version = /^grok-search-rs (\d+\.\d+\.\d+)\s*$/.exec(probe.stdout ?? '')?.[1];
      if (probe.status !== 0 || version !== '0.1.26') throw new Error('The supplied program is not grok-search-rs 0.1.26.');
      const configDirectory = join(root, 'grok-config');
      mkdirSync(configDirectory);
      const configPath = join(configDirectory, 'config.toml');
      writeFileSync(configPath, [
        `grok_api_url = "${grokResponsesUrl}"`,
        `grok_api_key = "${grokKey}"`,
        'grok_model = "grok-4-1-fast-reasoning"',
        'web_search_enabled = true',
        '',
      ].join('\n'), { flag: 'wx', mode: 0o600 });
      grokProgramValidation = { version, sha256: sourceSha256, copiedIntoRun: true, configIsolated: true };
      config = { executable, configPath, budgetMs: m004BudgetMs };
    } else {
      // Unconfigured search on purpose: never discovers the user's global
      // program/configuration and never downloads behind the probe.
      config = { executable: join(root, 'intentionally-missing-grok-program.exe'), configPath: join(root, 'isolated-grok.toml') };
    }
    write(join(product, 'cordis.patch.yml'), [{ insert: [{ id: 'grok-search', name: 'dsh-grok-search', config }] }]);
    cpSync(join(actualProject, 'src'), join(product, 'src'), { recursive: true, errorOnExist: true, force: false });
    write(join(product, 'package.json'), metadata);
    // The product's own runtime dependencies (MCP client, TOML parser) are what
    // a real pnpm install provides; link the exact installed copies read-only.
    const productModules = join(product, 'node_modules');
    mkdirSync(productModules);
    for (const name of readdirSync(join(actualProject, 'node_modules'))) {
      if (name.startsWith('.') || name === '@deepseek-ai') continue;
      symlinkSync(join(actualProject, 'node_modules', name), join(productModules, name),
        process.platform === 'win32' ? 'junction' : 'dir');
    }
    write(join(profile, 'package.json'), { name: 'isolated-desktop-profile', private: true, type: 'module', dependencies: {
      'candidate-offline-fixture': '0.0.0', 'dsh-grok-search': metadata.version,
    }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      'candidate-offline-fixture', 'dsh-grok-search'] } } });
  } else if (pluginManagerEntries) {
    const fixtureDependency = join(root, 'fixture-package');
    cpSync(fixture, fixtureDependency, { recursive: true, errorOnExist: true, force: false });
    write(join(profile, 'package.json'), { name: 'isolated-desktop-profile', version: '0.0.0', private: true, type: 'module',
      dependencies: { 'candidate-offline-fixture': 'file:../../../fixture-package' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'candidate-offline-fixture'] } } });
    write(join(profile, '.npmrc'), 'auto-install-peers=false\nstrict-peer-dependencies=false\n');
    write(join(profile, 'cordis.patch.yml'), liveHmr ? '[]\n' : '- id: hmr\n  disabled: true\n');
  } else {
  for (const [name, parts] of [['candidate-controlled-search', [['owner', 'applyOwner', ['loader', 'profileContext']], ['provider', 'applyProvider', ['web', 'candidateControlOwner']]]],
   ['candidate-search-recovery', [['recovery', 'applyRecovery', ['loader', 'profileContext']]]]]) {
    const exports = Object.fromEntries(parts.map(([label]) => ['./' + label, './' + label + '.mjs']));
    const bundle = createBundle(name, exports, [{ insert: parts.map(([label]) => ({ id: 'control-' + label, name: name + '/' + label })) }]);
    copyCore(bundle);
    write(join(bundle, 'control.mjs'), readFileSync(join(actualProject, 'fixtures/deferred-release/control.mjs'), 'utf8')
      .replaceAll('../../src/core/', './'));
    for (const [label, apply, inject] of parts) write(join(bundle, label + '.mjs'), `export { ${apply} as apply } from './control.mjs'; export const name='desktop-control-${label}'; export const inject=${JSON.stringify(inject)};\n`);
  }
  write(join(profile, 'package.json'), { name: 'isolated-desktop-profile', private: true, type: 'module', dependencies: {
    'candidate-offline-fixture': '0.0.0', 'candidate-controlled-search': '0.0.0', 'candidate-search-recovery': '0.0.0',
  }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
    'candidate-offline-fixture', 'candidate-controlled-search', 'candidate-search-recovery'] } } });
  }
  if (!pluginManagerEntries) write(join(profile, 'cordis.patch.yml'), '[]\n');
  mkdirSync(join(root, 'workspace'));
  const paths = { versionedControlRecord, root, electron, archive: desktop.archivePath,
    dshHome: join(root, 'dsh-home'), profile, userData: join(root, 'electron-data'),
    runtime: join(desktop.archivePath, 'dsh'), primaryRuntime: join(resourcesDir, 'runtime', 'primary-runtime'),
    pnpmEntry, token: randomUUID(), workspace: join(root, 'workspace') };
  write(join(root, 'local-control.json'), paths);
  write(join(root, 'preparation.json'), { version: desktop.app.version, binaryCopies: identities,
    appArchiveSha256: hashFile(desktop.archivePath), originalSourceUnchanged: true,
    macAppBundleValidation, grokProgramValidation,
    startupMode: process.platform === 'darwin' ? (pluginManagerEntries ? 'official-packaged-mac-app' : 'official-mac-app-copy-default-app-development-load-original-asar')
      : 'official-default-app-development-load-original-asar', packagedStartupValidated: false,
    dependenciesInstalled: false, profile: '<temporary-profile>', privateCapabilityExcluded: true, fuses });
  return { version: desktop.app.version, root: '<independent-temporary-run>', binaryCopies: identities.length,
    macAppBundleValidation, grokProgramValidation,
    originalAsarUnmodified: true, startupMode: process.platform === 'darwin' ? (pluginManagerEntries ? 'packaged-app' : 'mac-development') : 'development', dependencyInstall: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!['--desktop', '--run-root', '--control-record-mode', '--entry-mode', '--m004-budget',
      '--grok-program', '--grok-responses-url', '--grok-key'].includes(process.argv[i]) || !process.argv[i + 1]
      || options.has(process.argv[i].slice(2))) throw new Error('Expected unique named preparation arguments.');
    options.set(process.argv[i].slice(2), process.argv[i + 1]);
  }
  const mode = options.get('control-record-mode') ?? 'legacy';
  if (!['legacy', 'versioned'].includes(mode)) throw new Error('Expected legacy or versioned control record mode.');
  const entryMode = options.get('entry-mode') ?? 'fixture';
  const m004BudgetMs = Number(options.get('m004-budget') ?? 120000);
  if (![60000, 90000, 120000].includes(m004BudgetMs)) throw new Error('M0-04 budget must be 60000, 90000 or 120000 ms.');
  if (!['fixture', 'product', 'plugin-manager', 'plugin-manager-live', 'm0-04', 'ux'].includes(entryMode)) throw new Error('Unsupported entry mode.');
  console.log(JSON.stringify(prepareDesktopFixture(options.get('desktop'), options.get('run-root'), {
    versionedControlRecord: mode === 'versioned', productEntries: entryMode === 'product' || entryMode === 'm0-04',
    pluginManagerEntries: ['plugin-manager', 'plugin-manager-live'].includes(entryMode),
    liveHmr: entryMode === 'plugin-manager-live', m004: entryMode === 'm0-04', m004BudgetMs,
    uxEntries: entryMode === 'ux',
    grokProgram: options.get('grok-program') ?? null, grokResponsesUrl: options.get('grok-responses-url') ?? null,
    grokKey: options.get('grok-key') ?? null,
  })));
}
