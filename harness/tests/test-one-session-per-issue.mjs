// One issue, one session. The rule the whole worktree model rests on, and the one thing
// dispatch.max_concurrent turned out not to be able to enforce on its own.
//
// APL-84, 2026-09-12. A session stopped by the account's 5-hour limit is NOT dead: it resumes by
// itself when the window reopens. The poller's cooldown is computed from the same reset time, so it
// lifts at the same moment — and 0.2.8 had already put the issue back in the queue on the assumption
// that the run was lost. e416007a resumed at 12:00:40 and 9f2a405e was dispatched at 12:01:26. Two
// runs, one branch, forty-six seconds apart.
//
// max_concurrent cannot see this. It reads the registry ONCE at the top of a poll, and at that
// instant the resuming session had not yet flipped to `working`. A count taken early cannot answer a
// question that changes late, so the invariant is checked per issue, immediately before spawning.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
const { liveSessionFor } = await import(POLLER + '?one=1');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message); } };

const agent = (name, state, id) => ({ id, kind: 'background', name, state });
const reads = (v) => () => (typeof v === 'string' ? v : JSON.stringify(v));

t('an issue already being worked reports its session', () => {
  assert.strictEqual(liveSessionFor('APL-84', reads([agent('[APL-84] Sidebar: regroup', 'working', 'e416007a')])), 'e416007a');
});

t('a finished or idle session does not block a re-dispatch', () => {
  // The opposite failure: treating a corpse as live means the issue never goes out again.
  assert.strictEqual(liveSessionFor('APL-84', reads([agent('[APL-84] Sidebar', 'blocked', 'old')])), null);
  assert.strictEqual(liveSessionFor('APL-84', reads([agent('[APL-84] Sidebar', 'idle', 'old')])), null);
});

t('a live session on a DIFFERENT issue is irrelevant', () => {
  assert.strictEqual(liveSessionFor('APL-84', reads([agent('[APL-85] Flow A', 'working', 'other')])), null);
});

t('the key must match exactly — APL-8 must not match [APL-84]', () => {
  // Prefix matching on a bare key would make APL-8 permanently "already running" whenever APL-84 is.
  assert.strictEqual(liveSessionFor('APL-8', reads([agent('[APL-84] Sidebar', 'working', 'e4')])), null);
});

t('a corpse and a live run for the same issue: the live one wins', () => {
  const list = [agent('[APL-84] Sidebar', 'blocked', 'dead'), agent('[APL-84] Sidebar', 'working', 'alive')];
  assert.strictEqual(liveSessionFor('APL-84', reads(list)), 'alive');
});

t('an unreadable registry does NOT block dispatch — it fails open like every other guard', () => {
  assert.strictEqual(liveSessionFor('APL-84', () => { throw new Error('no TTY'); }), null);
  assert.strictEqual(liveSessionFor('APL-84', reads('garbage')), null);
});

t('poll() checks it immediately before dispatching, and does not mark the issue processed', () => {
  const src = readFileSync(POLLER, 'utf8');
  const loop = /for \(const issue of issues\.nodes\)[\s\S]*?\n  }\n\n  if \(changed\)/.exec(src);
  assert.ok(loop, 'the dispatch loop was not found — this test is asserting nothing');
  const guard = /const already = liveSessionFor\(issue\.identifier\);[\s\S]*?\n    \}/.exec(loop[0]);
  assert.ok(guard, 'poll() never checks whether a session is already working the issue');
  assert.ok(!/processed\.add/.test(guard[0]),
    'the issue is marked processed when skipped — if that session then fails, it never retries');
  assert.match(guard[0], /continue;/, 'the guard does not skip the dispatch');
  // It has to be the LAST check before the spawn. Anything between them is a window for the race.
  const at = loop[0].indexOf('liveSessionFor(issue.identifier)');
  const spawn = loop[0].indexOf('await dispatch(');
  assert.ok(at !== -1 && at < spawn, 'the guard runs after dispatch — too late to matter');
  assert.ok(!/countRunningSessions\(/.test(loop[0].slice(at, spawn)),
    'the guard is not the last word before the spawn');
});

process.exit(fails ? 1 : 0);
