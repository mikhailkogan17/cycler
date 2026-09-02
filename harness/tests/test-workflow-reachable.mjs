// The Workflow tool can only run a script it can already read: the working directory, or a directory
// the session has been given. A plugin lives outside both.
//
// Confirmed verbatim by a real run, twice:
//
//   scriptPath must be a script path this tool returned, or a file you can already read (the working
//   directory or a directory you have added): /Users/.../cycler/workflows/task-orchestration.js
//
// So every instruction to run `${CLAUDE_PLUGIN_ROOT}/workflows/...` was unsatisfiable, and the
// escape-hatch hook printed one inside its own denial message — telling a blocked run to do something
// that cannot be done. That run waived the escape hatch to get past it, which is the worst outcome
// available: a guard talked out of existence by an instruction the guard itself printed.
//
// The workflow is therefore INSTALLED INTO THE REPO by /cycler:setup, and everything references the
// repo-relative path.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.startsWith('harness/tests/'));

t('no shipped file tells a session to run the workflow from the plugin root', () => {
  const bad = [];
  for (const f of tracked) {
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8') } catch { continue }
    // A scriptPath rooted at the plugin — the shape the Workflow tool refuses.
    const re = /scriptPath[^\n]*(\$\{?CLAUDE_PLUGIN_ROOT\}?|\$PLUGIN_ROOT)\/workflows\//g;
    for (const m of src.matchAll(re)) bad.push(`${f}: ${m[0].slice(0, 70)}`);
  }
  assert.deepStrictEqual(bad, [], 'these instruct an unreachable scriptPath:\n  ' + bad.join('\n  '));
});

t('the escape-hatch denial names the repo-relative workflow', () => {
  // This message is printed to a run that has just been blocked. If it names a path the Workflow
  // tool refuses, the run's only remaining move is to waive the guard.
  const src = readFileSync(join(ROOT, 'harness/hooks/require-escape-hatch.sh'), 'utf8');
  assert.ok(/\.claude\/workflows\/task-orchestration\.js/.test(src),
    'the denial message does not name the in-repo workflow path');
});

t('the denial says what to do when the workflow is not installed', () => {
  // A repo that has never run /cycler:setup has no .claude/workflows/. Naming a missing file without
  // saying how to get it is the same dead end one step later.
  const src = readFileSync(join(ROOT, 'harness/hooks/require-escape-hatch.sh'), 'utf8');
  assert.ok(/cycler:setup/.test(src), 'the denial does not tell the reader how to install it');
});

t('setup installs the workflow into the repo', () => {
  const src = readFileSync(join(ROOT, 'commands/setup.md'), 'utf8');
  assert.ok(/\.claude\/workflows/.test(src), '/cycler:setup never installs the workflow');
  assert.ok(/task-orchestration\.js/.test(src), '/cycler:setup does not name the workflow file');
});

t('doctor checks the workflow is installed', () => {
  const src = readFileSync(join(ROOT, 'commands/doctor.md'), 'utf8');
  assert.ok(/\.claude\/workflows\/task-orchestration\.js/.test(src),
    'doctor cannot tell you the escape hatch is unreachable');
});

process.exit(fails ? 1 : 0);
