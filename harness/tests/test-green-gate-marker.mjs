// The gate marker binds a pass to the tree that produced it. It must survive `git add` — staging is
// not an edit — and it must NOT survive a real content change.
//
// Both directions, because the failure this replaces was one-sided: the old fingerprint changed on
// staging, so `gate → git add → git commit` was blocked every single time with a message claiming an
// edit that never happened. A test that only checked "an edit invalidates it" would have passed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..');
const FP = join(HARNESS, 'tree-fingerprint.sh');
let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

const git = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
const fp = (d) => execFileSync('bash', [FP, d], { encoding: 'utf8' }).trim();

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'fp-'));
  git(d, 'init', '-q');
  writeFileSync(join(d, 'a.txt'), 'one\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return d;
}

t('staging a MODIFIED file does not change the fingerprint', () => {
  const d = repo();
  writeFileSync(join(d, 'a.txt'), 'two\n');
  const before = fp(d);
  git(d, 'add', '-A');
  assert.strictEqual(fp(d), before, 'git add changed the hash — this blocks every normal commit');
  rmSync(d, { recursive: true, force: true });
});

t('staging an UNTRACKED file does not change the fingerprint', () => {
  const d = repo();
  writeFileSync(join(d, 'b.txt'), 'new\n');
  const before = fp(d);
  git(d, 'add', '-A');
  assert.strictEqual(fp(d), before, 'git add changed the hash for an untracked file');
  rmSync(d, { recursive: true, force: true });
});

t('an actual content change DOES change the fingerprint', () => {
  const d = repo();
  writeFileSync(join(d, 'a.txt'), 'two\n');
  const before = fp(d);
  writeFileSync(join(d, 'a.txt'), 'three\n');
  assert.notStrictEqual(fp(d), before, 'an edit did not invalidate the marker');
  rmSync(d, { recursive: true, force: true });
});

t('deleting a file changes the fingerprint', () => {
  const d = repo();
  rmSync(join(d, 'a.txt'));
  assert.notStrictEqual(fp(d), fp(repo()), 'a deletion was invisible to the fingerprint');
  rmSync(d, { recursive: true, force: true });
});

process.exit(fails ? 1 : 0);
