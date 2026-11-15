import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminBranch, adminCommit, adminCleanup, adminPR } from '../../lib/admin.mjs';
import { runWorkflow, save, stopReason, resumeRequest, claimResumeRequest } from '../../workflows/run.mjs';
import { makeResponder } from './stubs.mjs';

const root = mkdtempSync(join(tmpdir(), 'cycler-native-admin-'));
const source = join(root, 'source'); const remote = join(root, 'remote.git');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
try {
  mkdirSync(source);
  execFileSync('git', ['init', '--bare', '-q', remote]);
  git(source, 'init', '-q'); git(source, 'config', 'user.name', 'Cycler Test'); git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'checkout', '-qb', 'main');
  writeFileSync(join(source, 'code.txt'), 'before\n'); git(source, 'add', 'code.txt'); git(source, 'commit', '-qm', 'base');
  git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-q', '-u', 'origin', 'main');
  const branch = await adminBranch({ cwd: source, branch: 'codex/TEST-1', base: 'main', worktree: true });
  assert.equal(branch.ok, true); assert.equal(git(source, 'branch', '--show-current'), 'main');
  const tree = join(source, '.claude/worktrees/codex-TEST-1');
  git(tree, 'config', 'user.name', 'Cycler Test'); git(tree, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(tree, 'code.txt'), 'after\n');
  const commit = await adminCommit({ cwd: tree, files: ['code.txt'], issueId: 'TEST-1', runtime: 'codex', label: 'initial' });
  assert.equal(commit.pushed, true);
  assert.equal(git(source, 'ls-remote', 'origin', 'refs/heads/codex/TEST-1').split('\t')[0], commit.commitHash);
  assert.notEqual(git(source, 'rev-parse', 'main'), commit.commitHash);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const marker = join(root, 'created'); const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\nif [ "$1" = pr ] && [ "$2" = create ]; then printf 'created\\n' >> '${marker}'; exit 0; fi\nif [ -f '${marker}' ] && [ "$1" = pr ] && [ "$2" = view ]; then printf '{"number":1,"url":"https://github.com/example/repo/pull/1","headRefOid":"${commit.commitHash}"}\\n'; exit 0; fi\nexit 1\n`);
  chmodSync(gh, 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try {
    const contract = join(root, 'contract.md'); writeFileSync(contract, '## Goal\nDo the fixture task.\n');
    const pr = await adminPR({ cwd: tree, base: 'main', contract, issueId: 'TEST-1' });
    assert.equal(pr.prUrl, 'https://github.com/example/repo/pull/1');
    await adminPR({ cwd: tree, base: 'main', contract, issueId: 'TEST-1' });
    assert.equal(readFileSync(marker, 'utf8').trim(), 'created', 'PR creation is idempotent');
  } finally { process.env.PATH = oldPath; }
  git(tree, 'mv', 'code.txt', 'renamed.txt');
  await assert.rejects(adminCommit({ cwd: tree, files: ['code.txt', 'renamed.txt'], issueId: 'TEST-1', runtime: 'codex',
    label: 'fix', expectedFingerprint: 'green-tree', fingerprint: async () => 'changed-tree' }), /Tree changed after green gate/);
  assert.equal(git(tree, 'rev-parse', 'HEAD'), commit.commitHash, 'changed content cannot reuse gate evidence');
  const renameCommit = await adminCommit({ cwd: tree, files: ['code.txt', 'renamed.txt'], issueId: 'TEST-1', runtime: 'codex', label: 'fix' });
  assert(renameCommit.committedFiles.includes('code.txt') && renameCommit.committedFiles.includes('renamed.txt'));
  writeFileSync(join(tree, 'user-asset.png'), 'keep me');
  const heldCleanup = await adminCleanup({ cwd: source, worktree: tree, removeWorktree: true });
  assert.equal(heldCleanup.worktreeRemoved, false, 'untracked user asset keeps worktree');
  rmSync(join(tree, 'user-asset.png'));
  writeFileSync(join(source, '.git/info/exclude'), 'node_modules/\n');
  mkdirSync(join(tree, 'node_modules')); writeFileSync(join(tree, 'node_modules/fixture'), 'dependency');
  const again = await adminBranch({ cwd: source, branch: 'codex/TEST-1', base: 'main', worktree: true });
  assert.equal(again.created, false); assert.equal(git(tree, 'rev-parse', 'HEAD'), renameCommit.commitHash);
  const cleanup = await adminCleanup({ cwd: source, worktree: tree, removeWorktree: true });
  assert.equal(cleanup.worktreeRemoved, true);
  assert.equal(git(source, 'branch', '--show-current'), 'main');
  console.log('PASS deterministic branch, commit, push, PR reuse and cleanup with no model invocation or merge');

  writeFileSync(join(source, 'code.txt'), 'pre-existing user edit\n');
  const shared = await adminBranch({ cwd: source, branch: 'codex/shared-fixture', base: 'main', worktree: false });
  assert(shared.baselinePaths.includes('code.txt'));
  await assert.rejects(adminCommit({ cwd: source, files: ['code.txt'], baselinePaths: shared.baselinePaths, label: 'initial' }), /pre-existing shared-tree/);
  await adminCleanup({ cwd: source, lock: join(source, '.claude/worktrees/.task-shared-tree.lock'), removeWorktree: false });
  console.log('PASS shared-tree baseline prevents committing a pre-existing user edit');

  // A stopped stage resumes from its saved outputs without replaying earlier agent work.
  const statePath = join(root, 'state.json'); save(statePath, { status: 'running' });
  const counts = new Map(); let failVerify = true;
  const respond = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
  const agent = async request => {
    counts.set(request.label, (counts.get(request.label) || 0) + 1);
    if (request.label === 'verify-gate' && failVerify) throw Object.assign(new Error('quota exceeded'), { code: 'CYCLER_QUOTA_HOLD' });
    return respond(request.label, request.prompt, {}, []);
  };
  const request = { cwd: source, task: 'fixture task', runtime: 'codex', config: {}, noCommit: true, statePath, resumeReceipts: true };
  const first = await runWorkflow(request, { enforce: false, agent });
  assert.equal(first.status, 'blocked'); assert.equal(stopReason({ code: 'CYCLER_QUOTA_HOLD', message: 'quota exceeded' }, 'verify-gate').type, 'quota');
  failVerify = false;
  const second = await runWorkflow(request, { enforce: false, agent });
  assert.equal(second.status, 'done');
  assert.equal(counts.get('contract'), 1); assert.equal(counts.get('implementer'), 1);
  assert.equal(counts.get('verify-gate'), 2);
  console.log('PASS failed-stage resume reuses completed contract and implementation outputs');
  const job = join(root, 'job'); mkdirSync(job);
  const jobState = join(job, 'state.json');
  save(join(job, 'request.json'), { statePath: jobState, task: 'fixture task', workflow: 'workflow-feature' });
  save(jobState, { status: 'failed', workflowThreadId: 'thread-1', stageReceipts: { done: true } });
  assert.equal(resumeRequest(jobState).workflowThreadId, 'thread-1');
  const claim = claimResumeRequest(jobState);
  assert.throws(() => claimResumeRequest(jobState), /Resume already running/);
  claim.release();
  save(jobState, { status: 'running' });
  assert.throws(() => resumeRequest(jobState), /failed job state/);
  console.log('PASS explicit managed resume refuses a running job and preserves thread identity');

  const feedbackState = join(root, 'feedback-state.json'); save(feedbackState, { status: 'running' });
  const feedbackCalls = []; const reviewRounds = [];
  const feedbackStub = makeResponder({ auditDirty: [false, false], verifyGreen: [true, true] });
  const feedbackAgent = async request => {
    feedbackCalls.push(request.label);
    return feedbackStub(request.label, request.prompt, {}, []);
  };
  const feedbackReviewer = async request => {
    reviewRounds.push(request.reviewRound);
    return { approved: true, published: true, fatal: false, head: (reviewRounds.length === 1 ? 'a' : 'b').repeat(40),
      confirmed: [], blockingIssues: [], threads: [], notes: 'fixture review' };
  };
  const feedbackArgs = { cwd: source, task: 'fixture feedback', contractPath: join(root, 'contract.md'), runtime: 'codex',
    config: {}, statePath: feedbackState, githubReview: true, resumeReceipts: true, linear: false };
  const beforeFeedback = await runWorkflow(feedbackArgs, { enforce: false, agent: feedbackAgent, reviewer: feedbackReviewer });
  assert.equal(beforeFeedback.status, 'done');
  const afterFeedback = await runWorkflow({ ...feedbackArgs, feedback: ['Human follow-up'] },
    { enforce: false, agent: feedbackAgent, reviewer: feedbackReviewer });
  assert.equal(afterFeedback.status, 'done');
  assert.deepEqual(reviewRounds, [1, 2], 'feedback uses the next review slot');
  assert.equal(feedbackCalls.filter(label => label === 'committer:initial').length, 2,
    'new feedback must commit again rather than replaying the old receipt');
  console.log('PASS managed feedback runs a new commit and the next bounded review round');
} finally { rmSync(root, { recursive: true, force: true }); }
