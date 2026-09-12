// A blocking relation on the board has to mean something to the poller, or it means nothing at all.
//
// Ten issues of one IA redesign were delegated together on 2026-09-12. The poller dispatched APL-93
// first — the one that moves History INTO the Applications list that APL-86 had not built yet —
// because the poll query fetched `id identifier title state labels` and nothing else. The board said
// blocked; the poller could not see it.
//
// The direction is the trap. Linear stores "A blocks B" on A, so B has to find it through
// inverseRelations. Reading it the other way round is silent: every issue reads as unblocked and the
// feature looks like it works until the ordering actually matters.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
const { isBlocked, blockerKeys } = await import(POLLER + '?blocked=1');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message); } };

const rel = (identifier, type, stateType) => ({ type, issue: { identifier, state: { type: stateType } } });
const issue = (...nodes) => ({ identifier: 'APL-93', inverseRelations: { nodes } });

t('an open blocker blocks', () => {
  assert.strictEqual(isBlocked(issue(rel('APL-86', 'blocks', 'backlog'))), true);
  assert.deepStrictEqual(blockerKeys(issue(rel('APL-86', 'blocks', 'backlog'))), ['APL-86']);
});

t('a finished blocker does not — this is what lets the queue move on its own', () => {
  assert.strictEqual(isBlocked(issue(rel('APL-86', 'blocks', 'completed'))), false);
  assert.strictEqual(isBlocked(issue(rel('APL-86', 'blocks', 'canceled'))), false);
});

t('one open blocker among several finished ones still blocks', () => {
  const i = issue(rel('APL-84', 'blocks', 'completed'), rel('APL-86', 'blocks', 'started'));
  assert.strictEqual(isBlocked(i), true);
  assert.deepStrictEqual(blockerKeys(i), ['APL-86']);
});

t('only `blocks` counts — `related` and `duplicate` are not ordering constraints', () => {
  // Treating them as such would stall a queue for a reason nobody wrote down.
  assert.strictEqual(isBlocked(issue(rel('APL-1', 'related', 'backlog'))), false);
  assert.strictEqual(isBlocked(issue(rel('APL-1', 'duplicate', 'backlog'))), false);
});

t('the relation is read from inverseRelations, not relations — the direction is the whole bug', () => {
  // An issue carrying the link the WRONG way round is a blocker of something else, not blocked.
  assert.strictEqual(isBlocked({ identifier: 'APL-84', relations: { nodes: [rel('APL-86', 'blocks', 'backlog')] } }), false);
  const src = readFileSync(POLLER, 'utf8');
  assert.match(src, /inverseRelations \{ nodes \{ type issue \{ identifier state \{ type \} \} \} \}/,
    'the poll query does not fetch inverseRelations, so no issue can ever read as blocked');
});

t('missing, empty or malformed relations fail OPEN — never a silently stopped queue', () => {
  assert.strictEqual(isBlocked({ identifier: 'APL-1' }), false);
  assert.strictEqual(isBlocked(issue()), false);
  assert.strictEqual(isBlocked({ inverseRelations: { nodes: null } }), false);
  assert.strictEqual(isBlocked({ inverseRelations: { nodes: [null, {}, { type: 'blocks' }] } }), false);
  assert.strictEqual(isBlocked(undefined), false);
  assert.deepStrictEqual(blockerKeys(undefined), []);
});

t('a blocker with no state reads as OPEN — unknown is not "finished"', () => {
  // The one place failing open would be wrong: it would dispatch the blocked work.
  assert.strictEqual(isBlocked(issue({ type: 'blocks', issue: { identifier: 'APL-86' } })), true);
});

t('poll() skips a blocked issue WITHOUT marking it processed', () => {
  // Marking it would be permanent: processed.json is never re-read for this issue, so it would
  // never dispatch even after its blockers closed. Blocked means waiting, not done with.
  const src = readFileSync(POLLER, 'utf8');
  const loop = /for \(const issue of issues\.nodes\)[\s\S]*?\n  }\n\n  if \(changed\)/.exec(src);
  assert.ok(loop, 'the dispatch loop was not found — this test is asserting nothing');
  const guard = /if \(isBlocked\(issue\)\) \{[\s\S]*?\n    \}/.exec(loop[0]);
  assert.ok(guard, 'poll() never checks whether an issue is blocked');
  assert.ok(!/processed\.add/.test(guard[0]), 'a blocked issue is marked processed — it will never dispatch');
  assert.match(guard[0], /continue;/, 'the blocked branch does not skip the issue');
  assert.match(guard[0], /blockerKeys\(issue\)/, 'the log says "blocked" without naming a blocker');
  // and the check must come before the budget is spent on it
  assert.ok(loop[0].indexOf('isBlocked(issue)') < loop[0].indexOf('await dispatch('),
    'the block check runs after dispatch — too late to matter');
});

process.exit(fails ? 1 : 0);
