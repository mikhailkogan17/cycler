import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminBranch, adminCommit, adminCleanup, adminPR } from '../../lib/admin.mjs';
import { runWorkflow, save, stopReason } from '../../workflows/run.mjs';
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
  const again = await adminBranch({ cwd: source, branch: 'codex/TEST-1', base: 'main', worktree: true });
  assert.equal(again.created, false); assert.equal(git(tree, 'rev-parse', 'HEAD'), commit.commitHash);
  const cleanup = await adminCleanup({ cwd: source, worktree: tree, removeWorktree: true });
  assert.equal(cleanup.worktreeRemoved, true);
  assert.equal(git(source, 'branch', '--show-current'), 'main');
  console.log('PASS deterministic branch, commit, push, PR reuse and cleanup with no model invocation or merge');

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
} finally { rmSync(root, { recursive: true, force: true }); }
