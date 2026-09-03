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
import { run } from './sim.mjs';
import { makeResponder } from './stubs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
let fails = 0;
const t = async (n, fn) => { try { await fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

// Every file that states the delegate rule must also carve out the workflow's own stages, within
// the same passage — a caveat three sections away is not read by a session mid-run.
const STATES_THE_RULE = ['harness/CLAUDE.reference.md', 'harness/ROUTING.md', 'harness/HARNESS.md'];

// The carve-out has to sit WITH the prohibition. This used to be a whole-file search for two
// unrelated regexes, which the word "audit" in the stage table and an unrelated "does not forbid"
// three sections away satisfied on their own — so deleting the entire carve-out sentence added by
// #2 left this file green. The check written to prove the fix could not fail on the input it judged.
//
// So: find each passage that states the prohibition, and require the carve-out inside THAT passage.
const WINDOW = 600;  // characters after the prohibition — about one bullet or paragraph

function carveOutNear(plain) {
  const bans = [...plain.matchAll(/(no|never|not) [^.\n]{0,60}subagents?/gi)];
  if (!bans.length) return { banned: false };
  for (const b of bans) {
    const passage = plain.slice(b.index, b.index + WINDOW);
    const names = /(audit|review lens|lenses|refut)/i.test(passage);
    const permits = /(never what this|not what this|does not (apply|forbid|mean)|do not forbid|are the point|must let them run|exempt)/i.test(passage);
    if (names && permits) return { banned: true, ok: true };
  }
  return { banned: true, ok: false, sample: plain.slice(bans[0].index, bans[0].index + 180) };
}

await t('every file forbidding subagents exempts the workflow\'s own stages IN THE SAME PASSAGE', () => {
  const missing = [];
  for (const f of STATES_THE_RULE) {
    // Strip markdown emphasis: "does **not** apply" must count the same as "does not apply".
    const r = carveOutNear(read(f).replace(/[*_`]/g, ''));
    if (r.banned && !r.ok) missing.push(`${f} (${JSON.stringify(r.sample)})`);
  }
  assert.deepStrictEqual(missing, [],
    `these forbid subagents with no carve-out within ${WINDOW} chars of the prohibition — a caveat ` +
    `three sections away is not read by a session mid-run:\n  ${missing.join('\n  ')}`);
});

await t('the proximity check can actually fail', () => {
  // Guards the guard. The previous version passed on text with the ban and no carve-out at all,
  // which is precisely the pre-#2 state it was written to detect.
  const pre = 'Rules\n- One workflow, always. No ad-hoc parallel subagents, no per-stage workflows.\n' +
    '- Audit is independent.\n' + 'x'.repeat(2000) + '\nThis does not apply to several runs at once.';
  const r = carveOutNear(pre);
  assert.ok(r.banned, 'the prohibition was not even recognised');
  assert.strictEqual(r.ok, false, 'un-carved text passed the proximity check — the check cannot go red');
});

await t('the task skill states that a run without review lenses is incomplete', () => {
  // The skill is what a dispatched session actually follows. If skipping review is silently
  // acceptable there, the carve-out elsewhere changes nothing.
  const src = read('skills/task/SKILL.md');
  assert.ok(/independent|review lens|lenses/i.test(src), 'the skill never mentions independent review');
  assert.ok(/self-performed|not independent|incomplete|say so/i.test(src),
    'the skill does not require a run to declare when review was NOT independent');
});

await t('the workflow still dispatches four review lenses', async () => {
  // Guards the other direction: a "fix" that removed the lenses would satisfy the wording tests.
  //
  // Asserted by RUNNING the workflow, not by grepping it. A substring search for 'bugs' passed with
  // DIMENSIONS emptied out, because those words appear elsewhere in a 1600-line file — so the
  // assertion could not tell "four lenses are dispatched" from "the word is present".
  const { calls } = await run({ args: { task: 'ABC-1 do a thing', cwd: '/tmp' }, responder: makeResponder({
    auditDirty: [false], verifyGreen: [true], reviewApproved: [true],
  }) });
  const lenses = calls.filter((c) => c.startsWith('review:')).map((c) => c.slice('review:'.length));
  assert.deepStrictEqual(lenses.sort(), ['bugs', 'contract', 'scope-creep', 'test-gaps'],
    `the run dispatched these review lenses: ${JSON.stringify(lenses)}`);
});

process.exit(fails ? 1 : 0);
