// require-green-gate.sh is the chokepoint the whole harness rests on: however the bytes arrived,
// they do not become a commit unless gate.sh passed on the tree as it now stands.
//
// It shipped with no test at all. test-green-gate-marker.mjs sounds like this file but exercises
// tree-fingerprint.sh — the marker mechanism, not the hook that consumes it — so the hook could be
// deleted outright and all 25 test files stayed green. Three of the four PreToolUse hooks were
// tested; the one that blocks a commit on a red gate was not.
//
// Every case asserts both directions. A hook that denied everything would pass "an ungated commit is
// blocked", and a hook that allowed everything would pass "a gated commit is allowed".
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = process.env.HOOK_SH || join(HERE, '..', 'hooks', 'require-green-gate.sh');
const FP = join(HERE, '..', 'tree-fingerprint.sh');

let failed = 0;
const check = (n, fn) => { try { fn(); console.log(`PASS ${n}`); } catch (e) { failed++; console.log(`FAIL ${n}\n  ${e.message.split('\n')[0]}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// The hook only fires under a .claude/worktrees path — the scope check is itself load-bearing, since
// this used to be ~/.cyrus/worktrees and matched nothing after that moved.
const ROOT = join(tmpdir(), 'harness-greengate', '.claude', 'worktrees');
mkdirSync(ROOT, { recursive: true });

function worktree({ gated = false, thenEdit = false } = {}) {
  const d = mkdtempSync(join(ROOT, 'gg-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  writeFileSync(join(d, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: d });
  if (gated) {
    mkdirSync(join(d, '.test-results/gate'), { recursive: true });
    const fp = execFileSync('bash', [FP, d], { encoding: 'utf8' }).trim();
    writeFileSync(join(d, '.test-results/gate/last-pass'), fp + '\n');
  }
  if (thenEdit) writeFileSync(join(d, 'a.txt'), 'edited after the gate passed\n');
  return d;
}

const run = (cwd, command) => {
  const payload = JSON.stringify({ cwd, tool_input: { command } });
  try { execFileSync('bash', [HOOK], { input: payload, encoding: 'utf8' }); return { allowed: true, msg: '' }; }
  catch (e) { return { allowed: false, msg: (e.stderr || '').toString() }; }
};

check('a commit with no gate marker at all is BLOCKED', () => {
  const r = run(worktree({ gated: false }), 'git commit -m "wip"');
  assert(!r.allowed, 'an ungated commit was allowed — this is the chokepoint');
  assert(/gate has not passed/.test(r.msg), `the denial does not say why:\n${r.msg}`);
});

check('a commit on a tree that passed the gate is ALLOWED', () => {
  const r = run(worktree({ gated: true }), 'git commit -m "done"');
  assert(r.allowed, `a legitimately gated commit was blocked:\n${r.msg}`);
});

check('a commit AFTER editing the gated tree is BLOCKED', () => {
  // The marker is bound to the exact tree that passed. This is the difference between "the gate ran"
  // and "the gate ran on what you are about to commit".
  const r = run(worktree({ gated: true, thenEdit: true }), 'git commit -m "sneak"');
  assert(!r.allowed, 'a commit was allowed on a tree edited after the gate passed');
});

check('the marker does not invalidate itself in a repo that does not gitignore it', () => {
  // gate.sh computes the fingerprint and then writes it under .test-results/gate/. If that path
  // counted toward the hash, writing the marker would invalidate it on landing and EVERY commit
  // would be blocked with "the tree changed". This repo gitignores .test-results/, so the bug was
  // invisible here and would have hit a consuming repo on its first commit.
  const d = worktree({ gated: true });   // fixture writes no .gitignore, on purpose
  const r = run(d, 'git commit -m "first commit in a fresh repo"');
  assert(r.allowed, `the gate marker invalidated itself:\n${r.msg}`);
});

check('a non-commit git command is allowed even with no marker', () => {
  const d = worktree({ gated: false });
  assert(run(d, 'git status').allowed, 'git status was blocked');
  assert(run(d, 'git log --grep=commit').allowed, 'git log --grep=commit tripped the commit matcher');
  assert(run(d, 'npm test').allowed, 'a non-git command was blocked');
});

check('commit spellings that flags could hide are still matched', () => {
  // An earlier pattern allowed only single-token flags, so `git -c user.name=y commit` went straight
  // through ungated. A false negative here is an ungated commit.
  const d = worktree({ gated: false });
  for (const cmd of [
    'git -c user.name=y commit -m x',
    'git -C /some/path commit -m x',
    'echo hi && git commit -m x',
    'git commit',
  ]) assert(!run(d, cmd).allowed, `this reached a commit ungated: ${cmd}`);
});

check('the hook does not fire outside a .claude/worktrees path', () => {
  // Scope, asserted in both directions by the cases above: inside a worktree an ungated commit is
  // blocked, and outside one it is not this hook's business.
  const outside = mkdtempSync(join(tmpdir(), 'not-a-worktree-'));
  assert(run(outside, 'git commit -m x').allowed, 'the hook fired outside a /task worktree');
  rmSync(outside, { recursive: true, force: true });
});

rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
