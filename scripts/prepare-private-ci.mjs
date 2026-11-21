import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshRun, project, writeJson } from './lib/internal-candidate-utils.mjs';

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const maxBlobBytes = 3 * 1024 * 1024;
const gitBytes = (args, options = {}) => execFileSync('git', args, {
  cwd: project, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  ...options, env: { ...process.env, ...options.env, GIT_NO_REPLACE_OBJECTS: '1' },
});
const git = (...args) => gitBytes(args).toString('utf8').trim();
const paths = (...args) => new TextDecoder('utf-8', { fatal: true }).decode(gitBytes(args)).split('\0').filter(Boolean);
const allowed = file => !/[\x00-\x1f\x7f\\:]/.test(file)
  && !file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  && (/^(?:src|test|scripts|fixtures|locale)\//.test(file)
    || ['.github/workflows/offline-gates.yml', '.github/workflows/macos-beta-gate.yml',
      '.github/workflows/macos-package-transport.yml', '.github/workflows/macos-full-acceptance.yml'].includes(file)
    || ['.gitignore', '.gitattributes', '.npmrc', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md',
      'LICENSE', 'icon.png', 'cordis.patch.yml', 'support-matrix.json', 'screenshots.json', 'docs/开发与验证.md',
      'docs/plugin-detail.zh.md', 'docs/plugin-detail.en.md'].includes(file));
const privateData = /(?:[A-Z]:[/\\]Users[/\\](?!Public\b|Default\b|runneradmin\b)[^/\\\s"']+|\/Users\/(?!runner\b|Shared\b)[^/\s"']+|sk-[A-Za-z0-9_-]{25,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xai-[A-Za-z0-9_-]{25,}|tvly-[A-Za-z0-9_-]{20,}|fc-[A-Za-z0-9_-]{20,})/;

export function reviewPrivateCiTree(tree) {
  assert.match(tree, objectId, 'An immutable Git tree object ID is required.');
  assert.equal(git('cat-file', '-t', tree), 'tree');
  const entries = paths('ls-tree', '-r', '-z', '-l', '--full-tree', tree).map(row => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\s+(-|\d+)\t([\s\S]+)$/.exec(row);
    assert.ok(match, 'Invalid Git tree entry.');
    const [, mode, type, oid, length, file] = match;
    assert.ok(['100644', '100755'].includes(mode) && type === 'blob', 'Unsupported CI entry mode: ' + mode);
    assert.ok(allowed(file), 'CI path is outside the privacy allowlist: ' + file);
    assert.match(oid, objectId);
    const size = Number(length);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= maxBlobBytes, 'Review oversized CI input: ' + file);
    return { file, mode, oid, size };
  });
  const files = [];
  // Batch raw objects without textconv/filters; the tree is now the sole authority.
  for (let offset = 0; offset < entries.length; offset += 4) {
    const batch = entries.slice(offset, offset + 4);
    const data = gitBytes(['cat-file', '--batch'], { input: batch.map(row => row.oid).join('\n') + '\n' });
    let cursor = 0;
    for (const entry of batch) {
      const end = data.indexOf(10, cursor);
      assert.ok(end >= cursor, 'Missing blob header.');
      assert.equal(data.subarray(cursor, end).toString('ascii'), entry.oid + ' blob ' + entry.size);
      cursor = end + 1;
      const bytes = data.subarray(cursor, cursor + entry.size);
      assert.equal(bytes.length, entry.size);
      cursor += entry.size;
      assert.equal(data[cursor++], 10, 'Incomplete blob response.');
      assert.ok(!privateData.test(entry.file) && !privateData.test(bytes.toString('utf8')),
        'Private data requires review: ' + entry.file);
      files.push({ ...entry, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    assert.equal(cursor, data.length, 'Unexpected blob response.');
  }
  return files;
}

// This historical tool remains restricted to its original private CI branch.
// It never checks out source history; pushing remains a separate action.
export function preparePrivateCi(branch) {
  assert.equal(branch, 'feat/performance-closeout-030-20261112');
  const ref = 'refs/heads/' + branch;
  assert.equal(git('for-each-ref', '--format=%(symref)', ref), '', 'CI branch must not be a symbolic ref.');
  const previous = git('for-each-ref', '--format=%(objectname)', ref);
  if (previous) {
    assert.match(previous, objectId);
    // A parent makes its full history reachable, not only its current tree.
    for (const tree of new Set(git('log', '--format=%T', previous, '--').split(/\r?\n/))) {
      reviewPrivateCiTree(tree);
    }
  }
  const sourceCommit = git('rev-parse', 'HEAD');
  const tracked = paths('ls-files', '-z');
  const changed = new Set([
    ...paths('diff', '--name-only', '--no-renames', '-z'),
    ...paths('diff', '--cached', '--name-only', '--no-renames', '-z'),
    ...paths('ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  assert.deepEqual([...changed].filter(file => !allowed(file)), [],
    'Uncommitted CI snapshot inputs must all pass the explicit file allowlist.');
  const files = [...new Set([...tracked.filter(allowed), ...changed])].sort()
    .filter(file => lstatSync(join(project, file), { throwIfNoEntry: false }));
  assert.ok(files.length > 150);
  const run = freshRun('private-ci-snapshot');
  const index = resolve(run.directory, 'index');
  const invoke = args => gitBytes(args, { env: { GIT_INDEX_FILE: index } }).toString('utf8').trim();
  invoke(['read-tree', '--empty']);
  for (let offset = 0; offset < files.length; offset += 80) {
    invoke(['--literal-pathspecs', 'add', '--', ...files.slice(offset, offset + 80)]);
  }
  const tree = invoke(['write-tree']);
  const reviewedFiles = reviewPrivateCiTree(tree);
  const commit = invoke(['commit-tree', tree, ...(previous ? ['-p', previous] : []),
    '-m', 'ci: 验证零点三候选的跨平台离线与浏览器门禁']);
  const receipt = { runId: run.runId, sourceCommit, commit, tree, branch, files: reviewedFiles,
    sourceHistoryIncluded: false, rawArtifactsIncluded: false, researchIncluded: false,
    immutableTreeInputsValidated: true, changedSourcePaths: [...changed].sort(),
    expectedPreviousCommit: previous || null,
    privacyReviewPassed: true, pushed: false, publicReleaseApproved: false };
  // Persist review before publishing the ref. The receipt identifies a reviewed
  // commit, not proof that a subsequent compare-and-swap update succeeded.
  writeJson(join(run.directory, 'summary.json'), receipt);
  git('update-ref', '--no-deref', ref, commit, previous || '0'.repeat(commit.length));
  console.log(JSON.stringify({ runId: run.runId, sourceCommit, commit, tree, branch,
    files: reviewedFiles.length, refUpdated: true, pushed: false }));
  return receipt;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePrivateCi(process.argv[2]);
}
