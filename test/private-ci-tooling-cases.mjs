import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempTracked } from './helpers/temp-fixture.mjs';

const branch = 'feat/performance-closeout-030-20261112';
const ref = `refs/heads/${branch}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = mkdtempTracked(join(tmpdir(), 'dsh-private-ci-tooling-'));
  const repo = join(root, 'repository'), tools = join(root, 'tooling'), out = join(root, 'out');
  mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(join(tools, 'lib'), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: join(root, 'empty-config'), GIT_CONFIG_NOSYSTEM: '1' });
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (args, input, encoding = 'utf8') => execFileSync('git', args, {
    cwd: repo, env, input, encoding, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  git(['init', '-q', '-b', 'fixture']);
  git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  for (let i = 0; i < 151; i++) writeFileSync(join(repo, 'src', `file-${i}.txt`), `fixture ${i}\n`);
  writeFileSync(join(repo, '.gitattributes'), 'src/filtered.txt filter=fixture\n');
  writeFileSync(join(repo, 'src', 'filtered.txt'), 'worktree bytes\n');
  git(['add', '--', '.']);
  const tree = git(['write-tree']).trim();
  const head = git(['commit-tree', tree, '-m', 'fixture root']).trim();
  git(['update-ref', 'refs/heads/fixture', head]);
  const runner = join(tools, 'prepare-private-ci.mjs');
  writeFileSync(runner, readFileSync(new URL('../scripts/prepare-private-ci.mjs', import.meta.url)));
  writeFileSync(join(tools, 'lib', 'internal-candidate-utils.mjs'), `
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { fileURLToPath } from 'node:url';
    export const project = fileURLToPath(new URL('../../repository', import.meta.url));
    export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    export function freshRun() {
      const directory = fileURLToPath(new URL('../../out', import.meta.url));
      mkdirSync(directory); return { directory, runId: 'isolated-fixture' };
    }
    export function writeJson(path, value) {
      if (process.env.FIXTURE_FAIL_RECEIPT === '1') throw new Error('synthetic receipt failure');
      writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
    }
  `);
  const run = (selectedBranch = branch, extra = {}) => spawnSync(process.execPath, [runner, selectedBranch], {
    cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  const current = () => git(['for-each-ref', '--format=%(objectname)', ref]).trim();
  const filter = bytes => {
    writeFileSync(join(root, 'filter.cjs'), `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(bytes)}));`);
    git(['config', 'filter.fixture.clean', 'node ../filter.cjs']);
    git(['config', 'filter.fixture.required', 'true']);
  };
  const review = treeId => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { reviewPrivateCiTree } from ${JSON.stringify(pathToFileURL(runner).href)};
     console.log(JSON.stringify(reviewPrivateCiTree(${JSON.stringify(treeId)})));`], {
    cwd: repo, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  return { root, repo, out, git, head, tree, run, current, filter, review };
}

test('private CI scans filtered final blobs before publishing a ref', () => {
  const f = fixture(); f.git(['update-ref', ref, f.head]);
  f.filter('sk-' + 'x'.repeat(40));
  const result = f.run();
  assert.notEqual(result.status, 0, 'A clean filter must not inject unreviewed credentials.');
  assert.equal(f.current(), f.head);
});

test('private CI receipts hash final blob bytes, not the working tree', () => {
  const f = fixture(); f.filter('normalized immutable bytes\n');
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(join(f.out, 'summary.json'), 'utf8'));
  assert.equal(f.current(), receipt.commit);
  assert.equal(f.git(['rev-parse', `${receipt.commit}^{tree}`]).trim(), receipt.tree);
  for (const row of receipt.files) {
    const oid = f.git(['rev-parse', `${receipt.tree}:${row.file}`]).trim();
    assert.equal(row.sha256, digest(f.git(['cat-file', 'blob', oid], undefined, null)), row.file);
  }
  assert.notEqual(receipt.files.find(row => row.file === 'src/filtered.txt').sha256,
    digest(readFileSync(join(f.repo, 'src', 'filtered.txt'))));
});

test('private CI records successful review before updating a ref', () => {
  const f = fixture(); f.git(['update-ref', ref, f.head]);
  const result = f.run(branch, { FIXTURE_FAIL_RECEIPT: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(f.current(), f.head, 'A receipt failure must leave the branch unchanged.');
});

test('private CI rejects private ancestors even when the previous tip tree is clean', () => {
  const f = fixture();
  const blob = f.git(['hash-object', '-w', '--stdin'], 'ghp_' + 'x'.repeat(35)).trim();
  const subtree = f.git(['mktree'], `100644 blob ${blob}\tprivate.txt\n`).trim();
  const tree = f.git(['mktree'], `040000 tree ${subtree}\tsrc\n`).trim();
  const ancestor = f.git(['commit-tree', tree, '-m', 'synthetic private ancestor']).trim();
  const cleanTip = f.git(['commit-tree', f.tree, '-p', ancestor, '-m', 'clean snapshot']).trim();
  f.git(['update-ref', ref, cleanTip]);
  const result = f.run();
  assert.notEqual(result.status, 0, 'A parent would make all of its ancestors reachable from the CI ref.');
  assert.match(result.stderr, /Private data requires review/);
  assert.equal(f.current(), cleanTip);
});

test('private CI preserves the declared plugin icon in its reviewed snapshot', () => {
  const f = fixture();
  const icon = readFileSync(new URL('../icon.png', import.meta.url));
  writeFileSync(join(f.repo, 'icon.png'), icon);
  writeFileSync(join(f.repo, 'package.json'), JSON.stringify({
    name: 'dsh-grok-search', version: '0.4.0', icon: 'icon.png', files: ['icon.png'],
  }));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(join(f.out, 'summary.json'), 'utf8'));
  const oid = f.git(['rev-parse', `${receipt.tree}:icon.png`]).trim();
  assert.ok(f.git(['cat-file', 'blob', oid], undefined, null).equals(icon));
  assert.equal(receipt.files.find(row => row.file === 'icon.png')?.sha256, digest(icon));
});

test('private CI keeps its historical branch restriction and rejects outside changes', () => {
  const f = fixture();
  assert.notEqual(f.run('feat/unapproved').status, 0);
  assert.equal(f.current(), '');
  mkdirSync(join(f.repo, 'research')); writeFileSync(join(f.repo, 'research', 'private.txt'), 'synthetic research');
  assert.notEqual(f.run().status, 0);
  assert.equal(f.current(), '');
});

for (const mode of ['120000', '160000']) {
  test(`private CI tree review rejects unsupported ${mode} entries`, () => {
    const f = fixture();
    const oid = mode === '160000' ? f.head : f.git(['hash-object', '-w', '--stdin'], '../outside').trim();
    const child = f.git(['mktree'], `${mode} ${mode === '160000' ? 'commit' : 'blob'} ${oid}\tentry\n`).trim();
    const tree = f.git(['mktree'], `040000 tree ${child}\tsrc\n`).trim();
    const result = f.review(tree);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported CI entry mode/);
    assert.equal(f.current(), '');
  });
}

test('private CI tree review rejects private content even with an image suffix and excludes unreviewed paths', () => {
  const f = fixture();
  const secret = f.git(['hash-object', '-w', '--stdin'], 'ghp_' + 'a'.repeat(35)).trim();
  const child = f.git(['mktree'], `100644 blob ${secret}\tfake.png\n`).trim();
  const image = f.git(['mktree'], `040000 tree ${child}\tsrc\n`).trim();
  assert.match(f.review(image).stderr, /Private data requires review/);
  const outside = f.git(['mktree'], `100644 blob ${secret}\tprivate.txt\n`).trim();
  assert.match(f.review(outside).stderr, /CI path is outside the privacy allowlist/);
});
