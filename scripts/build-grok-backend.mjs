import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };

export function loadManifest(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'backend/manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+-dsh\.\d+$/.test(manifest.version)
    || !/^\d+\.\d+\.\d+$/.test(manifest.rustToolchain)) fail('Invalid backend version/toolchain pin.');
  const { upstream, patch, platforms } = manifest;
  if (!/^[a-f0-9]{40}$/.test(upstream.commit)
    || upstream.repository !== 'https://github.com/Episkey-G/GrokSearch-rs'
    || upstream.sourceUrl !== 'https://codeload.github.com/Episkey-G/GrokSearch-rs/tar.gz/' + upstream.commit
    || upstream.archiveRoot !== 'GrokSearch-rs-' + upstream.commit
    || !/^[a-f0-9]{64}$/.test(upstream.sourceSha256)
    || patch.file !== 'grok-search-rs.patch' || !/^[a-f0-9]{64}$/.test(patch.sha256)) fail('Invalid source/patch pin.');
  if (sha256(readFileSync(join(root, 'backend', patch.file))) !== patch.sha256) fail('Patch SHA-256 mismatch.');
  const supported = {
    'windows-x64': ['win32', 'x64', 'x86_64-pc-windows-msvc'],
    'macos-arm64': ['darwin', 'arm64', 'aarch64-apple-darwin'],
    'linux-x64': ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
  };
  if (Object.keys(platforms).sort().join() !== Object.keys(supported).sort().join()) fail('Unsupported platform map.');
  for (const [name, [os, arch, target]] of Object.entries(supported)) {
    const p = platforms[name];
    if (p.os !== os || p.arch !== arch || p.target !== target
      || p.packageName !== '@dsh-grok-search/backend-' + name
      || p.archive !== 'grok-backend-' + manifest.version + '-' + name + '.tar.gz'
      || p.executable !== (os === 'win32' ? 'grok-search-rs.exe' : 'grok-search-rs')) fail('Invalid platform identity: ' + name);
  }
  return manifest;
}

export function verifySource(bytes, manifest) {
  if (sha256(bytes) !== manifest.upstream.sourceSha256) fail('Source archive SHA-256 mismatch.');
}

// Two ordinary ustar entries, fixed owner/time/modes, no PAX extensions or links.
// This also matches the existing private installer's deliberately small format.
export function createPlatformArchive(manifest, platform, executable, licenseText) {
  const p = manifest.platforms[platform];
  if (!p || !executable.length || executable.length > 50 * 1024 * 1024) fail('Invalid platform executable.');
  const metadata = {
    name: p.packageName, version: manifest.version, private: true,
    os: [p.os], cpu: [p.arch], bin: { 'grok-search-rs': 'bin/' + p.executable },
    license: 'MIT', licenseText,
    repository: manifest.upstream.repository,
    dshBackend: { schemaVersion: 1, upstreamCommit: manifest.upstream.commit,
      sourceSha256: manifest.upstream.sourceSha256, patchSha256: manifest.patch.sha256, target: p.target },
  };
  const entries = [
    ['package/package.json', Buffer.from(JSON.stringify(metadata, null, 2) + '\n'), 0o644],
    ['package/bin/' + p.executable, executable, 0o755],
  ];
  const blocks = [];
  for (const [name, content, mode] of entries) {
    const header = Buffer.alloc(512);
    const text = (value, at, length) => header.write(value, at, length, 'ascii');
    const octal = (value, at, length) => text(value.toString(8).padStart(length - 1, '0') + '\0', at, length);
    text(name, 0, 100); octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(content.length, 124, 12); octal(0, 136, 12); header.fill(32, 148, 156);
    text('0', 156, 1); text('ustar\0', 257, 6); text('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    text(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function run(command, args, { cwd = ROOT, env = process.env, capture = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(command + ' failed (' + result.status + ').' + (capture ? '\n' + result.stderr : ''));
  return capture ? result.stdout.trim() : '';
}

function withinArtifacts(candidate) {
  const artifacts = join(ROOT, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const absolute = resolve(candidate);
  const rel = relative(realpathSync(artifacts), realpathSync(absolute));
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(realpathSync(artifacts), rel) !== realpathSync(absolute)) {
    fail('Build path must be inside this workspace artifacts directory.');
  }
  return absolute;
}

async function downloadSource(manifest) {
  const response = await fetch(manifest.upstream.sourceUrl, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok) fail('Official source download returned HTTP ' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) fail('Source archive exceeds the download limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function buildBackend({ platform, sourceArchive, prepareOnly = false } = {}) {
  const manifest = loadManifest();
  platform ??= Object.keys(manifest.platforms).find(key => {
    const p = manifest.platforms[key]; return p.os === process.platform && p.arch === process.arch;
  });
  const spec = manifest.platforms[platform];
  if (!spec || spec.os !== process.platform || spec.arch !== process.arch) fail('Build on the matching native platform.');
  const buildRoot = join(ROOT, 'artifacts/grok-backend-build');
  mkdirSync(buildRoot, { recursive: true });
  withinArtifacts(buildRoot);
  run('git', ['check-ignore', '-q', 'artifacts/grok-backend-build/source']);
  const work = join(buildRoot, platform + '-' + randomUUID());
  mkdirSync(work);
  withinArtifacts(work);
  const archive = sourceArchive ? readFileSync(sourceArchive) : await downloadSource(manifest);
  verifySource(archive, manifest);
  const sourceTar = join(work, 'source.tar.gz');
  writeFileSync(sourceTar, archive, { flag: 'wx' });
  const listing = run('tar', ['-tzf', sourceTar], { capture: true });
  for (const name of listing.split(/\r?\n/)) {
    if (!name.startsWith(manifest.upstream.archiveRoot + '/') || /[\\:\0]/.test(name)
      || name.split('/').some(part => part === '..' || part === '.git')) fail('Unsafe source archive path.');
  }
  run('tar', ['-xzf', sourceTar, '-C', work]);
  const sourceDir = withinArtifacts(join(work, manifest.upstream.archiveRoot));
  const license = readFileSync(join(ROOT, 'backend/LICENSE'));
  if (!license.equals(readFileSync(join(sourceDir, 'LICENSE')))) fail('Upstream license differs from the reviewed copy.');
  const patch = join(ROOT, 'backend', manifest.patch.file);
  const patchDirectory = relative(ROOT, sourceDir).split(sep).join('/');
  run('git', ['apply', '--check', '--whitespace=error', '--directory=' + patchDirectory, patch]);
  run('git', ['apply', '--whitespace=error', '--directory=' + patchDirectory, patch]);
  // A reverse check catches a silently skipped patch in a parent Git worktree.
  run('git', ['apply', '--reverse', '--check', '--directory=' + patchDirectory, patch]);
  if (!readFileSync(join(sourceDir, 'Cargo.toml'), 'utf8').includes('version = "' + manifest.version + '"')) fail('Patched version missing.');
  if (existsSync(join(sourceDir, '.git'))) fail('Source must not contain a nested Git repository.');
  const prepared = { platform, sourceDir, upstreamCommit: manifest.upstream.commit,
    sourceSha256: manifest.upstream.sourceSha256, patchSha256: manifest.patch.sha256 };
  if (prepareOnly) return prepared;

  const targetDir = join(buildRoot, 'target', platform);
  mkdirSync(targetDir, { recursive: true });
  withinArtifacts(targetDir);
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
  for (const name of Object.keys(env)) if (/^(GROK_|TAVILY_|EXA_|TINYFISH_|FIRECRAWL_|OPENAI_|CARGO_ENCODED_RUSTFLAGS$|RUSTFLAGS$)/i.test(name)) delete env[name];
  const cargo = args => run('rustup', ['run', manifest.rustToolchain, 'cargo', ...args], { cwd: sourceDir, env });
  const rustc = run('rustup', ['run', manifest.rustToolchain, 'rustc', '--version'], { capture: true });
  const cargoVersion = run('rustup', ['run', manifest.rustToolchain, 'cargo', '--version'], { capture: true });
  if (!rustc.startsWith('rustc ' + manifest.rustToolchain + ' ')) fail('Rust toolchain identity mismatch.');
  // Ignored tests are live probes. Do not pass --ignored or --include-ignored.
  cargo(['test', '--locked', '--all-targets', '--target', spec.target]);
  cargo(['build', '--release', '--locked', '--target', spec.target]);
  const binaryPath = join(targetDir, spec.target, 'release', spec.executable);
  const binaryVersion = run(binaryPath, ['--version'], { env, capture: true });
  if (binaryVersion !== 'grok-search-rs ' + manifest.version) fail('Built executable identity mismatch.');
  const binary = readFileSync(binaryPath);
  const bytes = createPlatformArchive(manifest, platform, binary, license.toString('utf8'));
  const dist = join(ROOT, 'artifacts/grok-backend-dist');
  mkdirSync(dist, { recursive: true });
  withinArtifacts(dist);
  const tarball = join(dist, spec.archive);
  const receipt = {
    schemaVersion: 1, version: manifest.version, platform, packageName: spec.packageName,
    target: spec.target, archive: spec.archive, sha256: sha256(bytes),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    executable: spec.executable, executableSha256: sha256(binary), binaryVersion,
    upstream: manifest.upstream, patch: manifest.patch,
    cargoLockSha256: sha256(readFileSync(join(sourceDir, 'Cargo.lock'))),
    rustToolchain: manifest.rustToolchain, rustc, cargo: cargoVersion,
    tests: 'cargo test --locked --all-targets --target ' + spec.target,
    build: 'cargo build --release --locked --target ' + spec.target,
    sourceCommit: run('git', ['rev-parse', 'HEAD'], { capture: true }),
    sourceDirty: Boolean(run('git', ['status', '--porcelain', '--', 'backend', 'scripts/build-grok-backend.mjs',
      'scripts/build-grok-backend.test.mjs', '.github/workflows/grok-backend-build.yml'], { capture: true })),
    inputs: { manifestSha256: sha256(readFileSync(join(ROOT, 'backend/manifest.json'))),
      buildScriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), licenseSha256: sha256(license) },
  };
  writeFileSync(tarball, bytes);
  writeFileSync(tarball + '.sha256', receipt.sha256 + '  ' + spec.archive + '\n');
  writeFileSync(tarball + '.build.json', JSON.stringify(receipt, null, 2) + '\n');
  return { ...prepared, tarball, sha256: receipt.sha256, integrity: receipt.integrity,
    buildIdentity: tarball + '.build.json', binaryPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--platform' || arg === '--source-archive') {
      const value = process.argv[++i];
      if (!value || value.startsWith('--')) fail('Missing value for ' + arg);
      options[arg === '--platform' ? 'platform' : 'sourceArchive'] = value;
    } else if (arg === '--prepare-only') options.prepareOnly = true;
    else fail('Unknown option: ' + arg);
  }
  buildBackend(options).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
