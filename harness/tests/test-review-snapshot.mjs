import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { review, gitSources } from '../review.mjs';
const temp = mkdtempSync(join(tmpdir(), 'cycler-snapshot-'));
const bare = join(temp, 'remote.git'), repo = join(temp, 'checkout');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  mkdirSync(repo); git(temp, 'init', '--bare', bare); git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'x.js'), 'old\n');
  for (const file of ['context.js', 'gone.js', 'old-name.js']) writeFileSync(join(repo, file), 'unchanged\n'.repeat(30));
  writeFileSync(join(repo, 'binary.bin'), 'a\0b'); symlinkSync('context.js', join(repo, 'link.js'));
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'x.js'), 'new\n'); unlinkSync(join(repo, 'gone.js'));
  git(repo, 'mv', 'old-name.js', 'new-name.js'); git(repo, 'commit', '-am', 'change');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', 'origin', 'HEAD:refs/pull/1/head');
  git(repo, 'checkout', '-b', 'advanced-base', base);
  writeFileSync(join(repo, 'context.js'), 'base tip only\n'); git(repo, 'commit', '-am', 'advance base independently');
  const baseTip = git(repo, 'rev-parse', 'HEAD'); git(repo, 'checkout', '--detach', head);
  // Leave unrelated local work: the reviewer must see only the pinned remote snapshot.
  writeFileSync(join(repo, 'x.js'), 'local work\n');
  const pr = { number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN', headRefOid: head, baseRefOid: baseTip, title: 'change', body: 'replace old' };
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
  const anchorFiles = [...api.list(), { filename: 'new-name.js', previous_filename: 'old-name.js', status: 'renamed', changes: 0 }];
  const sources = gitSources(repo, pr, anchorFiles);
  assert.equal(sources('LEFT', 'context.js'), 'unchanged\n'.repeat(30), 'LEFT uses merge-base, not advanced base tip');
  assert.equal(sources('LEFT', 'new-name.js'), 'unchanged\n'.repeat(30), 'rename uses previous old-side path');
  assert.equal(sources('LEFT', 'gone.js'), 'unchanged\n'.repeat(30));
  assert.equal(sources('RIGHT', 'x.js'), 'new\n', 'RIGHT ignores dirty working tree');
  for (const file of ['gone.js', 'missing.js', '../context.js', 'link.js', 'binary.bin'])
    assert.throws(() => sources('RIGHT', file), undefined, `invalid source ${file} must fail closed`);
  const anchors = [
    { file: 'context.js', side: 'RIGHT', line: 24, severity: 'blocking', title: 'Caller regression', description: 'Concrete trigger' },
    { file: 'new-name.js', side: 'LEFT', line: 24, severity: 'blocking', title: 'Old caller regression', description: 'Concrete trigger' },
  ];
  const published = []; let refutations = 0;
  const anchorApi = { ...api, list: endpoint => endpoint.endsWith('/files') ? anchorFiles : [],
    api: (endpoint, body) => { published.push(body); return {}; } };
  const anchored = await review({ cwd: repo, pr: pr.url, api: anchorApi, publish: true, agent: async req => {
    if (req.schema.required.includes('isReal')) {
      refutations++;
      const path = JSON.parse(req.prompt.match(/source for .*?: ("[^\n]+")\. Read/)[1]);
      assert(path.startsWith(req.cwd + '/.cycler-review-source-'));
      assert.equal(readFileSync(path, 'utf8'), 'unchanged\n'.repeat(30));
      return { isReal: true, reasoning: 'Confirmed regression' };
    }
    return { findings: req.prompt.includes('Lens: bugs.') ? anchors : [] };
  } });
  assert.equal(refutations, 2); assert.equal(anchored.approved, false);
  assert.equal(published[0].comments.length, 0);
  assert.match(published[0].body, /context.js.*24/); assert.match(published[0].body, /new-name.js.*24/);
  await assert.rejects(review({ cwd: repo, pr: pr.url, api: anchorApi, agent: async req => ({
    findings: req.prompt.includes('Lens: bugs.') ? [{ ...anchors[0], line: 31 }] : [],
  }) }), error => {
    assert.match(error.message, /line does not exist/);
    assert.equal(error.reviewHead, head);
    assert(error.reviewFindings.some(r => r.result.findings[0]?.line === 31), 'failed claims remain available to callers');
    return true;
  });
  assert.equal(readFileSync(join(repo, 'x.js'), 'utf8'), 'local work\n');
  console.log('PASS real Git fetch, immutable review snapshot, cleanup and preservation of local edits');
} finally { rmSync(temp, { recursive: true, force: true }); }
