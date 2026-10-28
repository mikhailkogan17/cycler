import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { review } from '../review.mjs';
const temp = mkdtempSync(join(tmpdir(), 'cycler-snapshot-'));
const bare = join(temp, 'remote.git'), repo = join(temp, 'checkout');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  mkdirSync(repo); git(temp, 'init', '--bare', bare); git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'x.js'), 'old\n'); git(repo, 'add', 'x.js'); git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'x.js'), 'new\n'); git(repo, 'commit', '-am', 'change');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', 'origin', 'HEAD:refs/pull/1/head');
  // Leave unrelated local work: the reviewer must see only the pinned remote snapshot.
  writeFileSync(join(repo, 'x.js'), 'local work\n');
  const pr = { number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN', headRefOid: head, baseRefOid: base, title: 'change', body: 'replace old' };
  const api = { pr: () => pr, repo: () => 'o/r', list: () => [{ filename: 'x.js', changes: 1, patch: '@@ -1 +1 @@\n-old\n+new' }] };
  const dirs = [];
  const result = await review({ cwd: repo, pr: pr.url, api, config: {}, agent: async req => {
    dirs.push(req.cwd); assert.notEqual(req.cwd, repo);
    assert.equal(readFileSync(join(req.cwd, 'x.js'), 'utf8'), 'new\n');
    assert.equal(git(req.cwd, 'rev-parse', 'HEAD'), head);
    return { findings: [] };
  } });
  assert.equal(result.approved, true); assert.equal(dirs.length, 3);
  assert(!existsSync(dirs[0])); assert.equal(readFileSync(join(repo, 'x.js'), 'utf8'), 'local work\n');
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  const largeFiles = Array.from({ length: 80 }, (_, index) => ({
    filename: index === 0 ? '../../untrusted-name.js' : `removed/${index}.js`,
    changes: 100, status: 'removed', additions: 0, deletions: 100,
    patch: `@@ -1,100 +0,0 @@\n${'-deleted source\n'.repeat(100)}${index}`,
  }));
  const largeApi = { ...api, list: () => largeFiles };
  const largeDirs = [];
  await review({ cwd: repo, pr: pr.url, api: largeApi, agent: async req => {
    largeDirs.push(req.cwd);
    assert(Buffer.byteLength(req.prompt) < 10000);
    const bundle = JSON.parse(req.prompt.match(/local bundle ("[^\n]+")\./)[1]);
    assert(bundle.startsWith(req.cwd + '/.cycler-review-input-'));
    const manifest = readFileSync(join(bundle, 'manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(manifest.length, largeFiles.length);
    manifest.forEach((entry, index) => {
      assert.equal(entry.filename, largeFiles[index].filename);
      assert.equal(readFileSync(join(bundle, entry.patch), 'utf8'), largeFiles[index].patch);
    });
    assert.match(readFileSync(join(bundle, 'contract.md'), 'utf8'), /replace old/);
    return { findings: [] };
  } });
  assert.equal(largeDirs.length, 3); assert(!existsSync(largeDirs[0]));
  await assert.rejects(review({ cwd: repo, pr: pr.url, api: largeApi, snapshot: false,
    agent: async () => { throw Error('must not run'); } }), /requires an isolated snapshot/);
  await assert.rejects(review({ cwd: repo, pr: pr.url, api: { ...largeApi,
    list: () => [...largeFiles, { filename: 'missing', changes: 1 }] },
    agent: async () => { throw Error('must not run'); } }), /truncated/);
  console.log('PASS real Git fetch, immutable review snapshot, cleanup and preservation of local edits');
} finally { rmSync(temp, { recursive: true, force: true }); }
