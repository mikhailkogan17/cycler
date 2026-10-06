// APL-123 (2026-10-06): a watched session sat `blocked` on a permission prompt and, because the
// owner map only checked that its session id still appeared in the registry AT ALL, it kept
// "owning" its `[KEY]` forever. Every live re-dispatch for the same key was then ghosted as a
// "duplicate" of a session that could never finish — the poller killed every re-dispatch in a loop,
// and the killed re-dispatch's own pending.json record then surfaced on the NEXT poll as a false
// `dead dispatch`, retried, and ghosted again.
//
// This file pins: a blocked watched record no longer owns its key once a live competitor exists
// (findGhosts), the blocked one — not the live one — is the ghost reapGhosts stops, running.json is
// re-pointed at the live replacement, and the replacement's pending.json record (if any) survives
// `reapGhosts` cleanly dropping the one it stopped.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'cycler-cyc10-'));
process.env.CYCLER_HOME = DIR;
// A real ~/.config/cycler/config.yaml must not leak a different start_grace_seconds into this test.
process.env.CYCLER_CONFIG = join(DIR, 'no-config.yaml');
const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
const { findGhosts, reapGhosts, checkLiveness } = await import(POLLER + '?cyc10=1');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message); } };

const T0 = Date.parse('2026-10-06T09:00:00Z');
const START_GRACE_MS = 300_000; // dispatch.start_grace_seconds default (unset in no-config.yaml)

const setWatched = (r) => writeFileSync(join(DIR, 'running.json'), JSON.stringify(r));
const watched = () => JSON.parse(readFileSync(join(DIR, 'running.json'), 'utf8'));
const setPending = (r) => writeFileSync(join(DIR, 'pending.json'), JSON.stringify(r));
const pending = () => JSON.parse(readFileSync(join(DIR, 'pending.json'), 'utf8'));

// A blocked watched session A, and a live (non-blocked) B dispatched for the same key.
const REC_A = { session: 'A', issueId: 'i1', identifier: 'CYC-10', workflow: '/cycler:workflow-feature', attempts: 1, at: T0 };
const agentsAB = [
  { id: 'A', name: '[CYC-10] fix the thing', state: 'blocked' },
  { id: 'B', name: '[CYC-10] fix the thing', state: 'working', startedAt: 1000 },
];

t('a blocked watched session no longer owns its key: findGhosts names A, never B', () => {
  const ghosts = findGhosts(agentsAB, [REC_A]);
  assert.deepStrictEqual(ghosts.map((g) => g.id), ['A'], 'the blocked session should be the ghost, not its live replacement');
  assert.ok(!ghosts.some((g) => g.id === 'B'),
    'APL-123 regression: B must never be ghosted just because A (blocked) still appears in the registry');
});

t('reapGhosts stops exactly A, and re-points running.json at B', () => {
  setWatched([REC_A]);
  setPending([]);
  const stopped = [];
  reapGhosts(agentsAB, (id) => stopped.push(id));
  assert.deepStrictEqual(stopped, ['A']);
  const rows = watched();
  assert.strictEqual(rows.length, 1, 'exactly one record for the key afterwards');
  assert.strictEqual(rows[0].session, 'B');
  assert.strictEqual(rows[0].issueId, 'i1');
  assert.strictEqual(rows[0].identifier, 'CYC-10');
  assert.strictEqual(rows[0].workflow, '/cycler:workflow-feature');
  assert.strictEqual(rows[0].attempts, 1);
  assert.strictEqual(rows[0].notified, undefined, 'notified must be cleared, not carried over from A');
});

t('a pending record for the stopped ghost is dropped, so checkLiveness never calls it dead dispatch', async () => {
  // A third session C: also live under the same key, dispatched moments ago and still in
  // pending.json (its own proof-of-life check has not run yet). It is a duplicate of B (the newest),
  // so it is ghosted and stopped right alongside the blocked A.
  const agents = [...agentsAB, { id: 'C', name: '[CYC-10] fix the thing', state: 'working', startedAt: 500 }];
  setWatched([REC_A]);
  const oldAt = Date.now() - START_GRACE_MS - 60_000;
  setPending([{ issueId: 'i1', identifier: 'CYC-10', workflow: '/cycler:workflow-feature', session: 'C', at: oldAt, attempts: 1 }]);

  const stopped = [];
  reapGhosts(agents, (id) => stopped.push(id));
  assert.deepStrictEqual(stopped.sort(), ['A', 'C'], 'the blocked owner and the extra duplicate are both reaped');
  assert.deepStrictEqual(pending(), [], "C's pending record must be gone before checkLiveness ever sees it");

  const found = await checkLiveness(
    () => { throw new Error('checkLiveness must not need the registry once pending.json is empty'); },
    () => { throw new Error('checkLiveness must not need a transcript once pending.json is empty'); },
    () => null,
  );
  assert.deepStrictEqual(found.dead, [], 'no dead-dispatch verdict for a session this poller stopped itself');
  assert.deepStrictEqual(found.authDead, []);
});

t('pending.json record matched by identifier when it carries no session id yet', () => {
  // dispatch() can resolve no session id at all (APL-76); the pending record then has none either.
  const agents = [...agentsAB, { id: 'D', name: '[CYC-10] fix the thing', state: 'working', startedAt: 500 }];
  setWatched([REC_A]);
  setPending([{ issueId: 'i1', identifier: 'CYC-10', workflow: '/cycler:workflow-feature', session: null, at: Date.now(), attempts: 1 }]);
  reapGhosts(agents, () => {});
  assert.deepStrictEqual(pending(), [], 'a session-less pending record for the same identifier as a stopped ghost is dropped too');
});

t('a blocked watched session with NO live competitor is left alone entirely', () => {
  setWatched([REC_A]);
  setPending([]);
  const agentsAOnly = [{ id: 'A', name: '[CYC-10] fix the thing', state: 'blocked' }];
  assert.deepStrictEqual(findGhosts(agentsAOnly, [REC_A]), [], 'nothing live to replace A — it must not be ghosted');
  const stopped = [];
  reapGhosts(agentsAOnly, (id) => stopped.push(id));
  assert.deepStrictEqual(stopped, []);
  assert.deepStrictEqual(watched(), [REC_A], "A's record is untouched — same session, same everything");
});

t('idle (not blocked) still owns its key — unchanged from before this fix', () => {
  const recIdle = { session: 'A', issueId: 'i1', identifier: 'CYC-10', workflow: '/cycler:workflow-feature', attempts: 1, at: T0 };
  const agents = [
    { id: 'A', name: '[CYC-10] fix the thing', state: 'idle' },
    { id: 'B', name: '[CYC-10] fix the thing', state: 'working', startedAt: 1000 },
  ];
  assert.deepStrictEqual(findGhosts(agents, [recIdle]).map((g) => g.id), ['B'],
    'an idle watched session stays the owner; the live duplicate is the ghost, exactly as before');
});

t('more than one live competitor: the newest wins, the rest are ghosted alongside the blocked owner', () => {
  setWatched([REC_A]);
  setPending([]);
  const agents = [
    { id: 'A', name: '[CYC-10] fix the thing', state: 'blocked' },
    { id: 'B', name: '[CYC-10] fix the thing', state: 'working', startedAt: 2000 },
    { id: 'C', name: '[CYC-10] fix the thing', state: 'working', startedAt: 1000 },
  ];
  const ghosts = findGhosts(agents, [REC_A]);
  assert.deepStrictEqual(ghosts.map((g) => g.id).sort(), ['A', 'C']);
  const stopped = [];
  reapGhosts(agents, (id) => stopped.push(id));
  assert.deepStrictEqual(stopped.sort(), ['A', 'C']);
  assert.deepStrictEqual(watched().map((r) => r.session), ['B']);
});

t('checkLiveness already added its OWN record for B this poll — reapGhosts drops A rather than duplicating B', () => {
  // The realistic race from the contract's assumptions: B was confirmed alive in the SAME poll, so
  // running.json already holds a fresh B record by the time reapGhosts runs with the stale A still
  // in it too.
  const recB = { session: 'B', issueId: 'i1', identifier: 'CYC-10', workflow: '/cycler:workflow-feature', attempts: 1, at: Date.now() };
  setWatched([REC_A, recB]);
  setPending([]);
  const stopped = [];
  reapGhosts(agentsAB, (id) => stopped.push(id));
  assert.deepStrictEqual(stopped, ['A']);
  const rows = watched();
  assert.strictEqual(rows.length, 1, 'exactly one record for the key — A dropped, not a second B');
  assert.strictEqual(rows[0].session, 'B');
});

if (fails) { console.log(`${fails} failed`); process.exit(1); }
