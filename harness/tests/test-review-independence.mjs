// The workflow's own audit and review stages are subagents. Nothing may read as forbidding them.
//
// This exists because of a real, measured failure. The rule "Never spawn a subagent to work a Linear
// issue" was written to stop a session from spawning a local agent INSTEAD of delegating a separate
// issue — work that then dies with the conversation, leaving no trail on the board. A dispatched
// session working an issue read it as a blanket ban and skipped the auditor and all four review
// lenses, reporting: "treat the review as self-performed, not independent."
//
// Every PR the harness has produced to date carries that caveat. So the single most valuable thing
// the harness does — an adversary that did not write the diff — has never once run.
//
// HARNESS.md's "No ad-hoc parallel subagents" pushed the same way. Both texts now carve the workflow
// out by name, and these cases assert the carve-out rather than the prohibition, because the
// prohibition was never the part that broke.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

// Every file that states the delegate rule must also carve out the workflow's own stages, within
// the same passage — a caveat three sections away is not read by a session mid-run.
const STATES_THE_RULE = ['harness/CLAUDE.reference.md', 'harness/ROUTING.md', 'harness/HARNESS.md'];

t('every file forbidding subagents also exempts the workflow\'s own stages', () => {
  const missing = [];
  for (const f of STATES_THE_RULE) {
    const src = read(f);
    if (!/subagent/i.test(src)) continue;
    // The carve-out must name what is allowed, not merely restate the ban.
    // Strip markdown emphasis first: "does **not** apply" must count the same as "does not apply".
    // The assertion is about meaning, not formatting.
    const plain = src.replace(/[*_`]/g, '');
    const exempts = /audit|review lens|lenses|refut|its own stages|workflow's own/i.test(plain)
      && /(does not|do not|never) (mean|apply|forbid)|exempt|is not what this|never what this/i.test(plain);
    if (!exempts) missing.push(f);
  }
  assert.deepStrictEqual(missing, [],
    `these forbid subagents with no carve-out for the workflow's own audit/review stages: ${missing.join(', ')}`);
});

t('the task skill states that a run without review lenses is incomplete', () => {
  // The skill is what a dispatched session actually follows. If skipping review is silently
  // acceptable there, the carve-out elsewhere changes nothing.
  const src = read('skills/task/SKILL.md');
  assert.ok(/independent|review lens|lenses/i.test(src), 'the skill never mentions independent review');
  assert.ok(/self-performed|not independent|incomplete|say so/i.test(src),
    'the skill does not require a run to declare when review was NOT independent');
});

t('the workflow still dispatches four review lenses', () => {
  // Guards the other direction: a "fix" that removed the lenses would satisfy the wording tests.
  const src = read('workflows/task-orchestration.js');
  for (const lens of ['bugs', 'contract', 'test-gaps', 'scope-creep']) {
    assert.ok(new RegExp(`['"\`]${lens}['"\`]`).test(src), `review lens "${lens}" is gone from the workflow`);
  }
});

process.exit(fails ? 1 : 0);
