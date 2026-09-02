// The gate is repo-local: cycler ships a default, and a repo's own .claude/harness/gate.sh must win.
//
// Both directions are asserted on purpose. A resolver that ALWAYS returned the default would pass a
// test that only checked the default case, and would look identical to a working one — which is the
// same vacuous-green failure the rest of this suite is built around.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESOLVER = join(HARNESS, 'gate.sh');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

function run(cwd) {
  const errFile = join(cwd, '.gate-stderr');
  try {
    const out = execFileSync('bash', ['-c', `bash "$1" --fast 2>"$2"`, '_', RESOLVER, errFile], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, timeout: 20000,
    });
    return { code: 0, out, err: readFileSync(errFile, 'utf8') };
  } catch (e) {
    let err = '';
    try { err = readFileSync(errFile, 'utf8'); } catch {}
    return { code: e.status ?? -1, out: (e.stdout || '').toString(), err };
  }
}

function repo(withOwnGate) {
  const d = mkdtempSync(join(tmpdir(), 'gate-resolve-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
  if (withOwnGate) {
    mkdirSync(join(d, '.claude/harness'), { recursive: true });
    const g = join(d, '.claude/harness/gate.sh');
    writeFileSync(g, '#!/usr/bin/env bash\necho "REPO GATE RAN with: $*"\nexit 0\n');
    chmodSync(g, 0o755);
  }
  return d;
}

t("the repo's own gate wins when it exists", () => {
  const d = repo(true);
  const r = run(d);
  assert.match(r.out, /REPO GATE RAN/, `the repo's gate did not run:\n${r.out}${r.err}`);
  assert.match(r.err, /using the repo's own gate/, `provenance was not reported:\n${r.err}`);
  rmSync(d, { recursive: true, force: true });
});

t('arguments reach the chosen gate unchanged', () => {
  const d = repo(true);
  const r = run(d);
  assert.match(r.out, /--fast/, `arguments were swallowed:\n${r.out}`);
  rmSync(d, { recursive: true, force: true });
});

t("cycler's default is used when the repo has none", () => {
  const d = repo(false);
  const r = run(d);
  assert.doesNotMatch(r.out, /REPO GATE RAN/, 'a repo gate ran in a repo that has none');
  assert.match(r.err, /using cycler's default/, `provenance was not reported:\n${r.err}`);
  rmSync(d, { recursive: true, force: true });
});

t('the default FAILS rather than passing vacuously when there is nothing to check', () => {
  // package.json declares no lint/build/test. "GATE: PASS (0 of 0)" would mean every downstream
  // check treats an unverified diff as verified.
  const d = repo(false);
  const r = run(d);
  assert.notStrictEqual(r.code, 0, `an empty default gate exited 0:\n${r.out}`);
  assert.match(r.out, /found no lint\/build\/test script/, `wrong failure reason:\n${r.out}`);
  rmSync(d, { recursive: true, force: true });
});

process.exit(fails ? 1 : 0);
