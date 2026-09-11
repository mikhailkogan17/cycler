// A dispatched session is not one agent: it runs task-orchestration.js, which fans out to ~5-9
// subagents normally. Two of those share one account-level usage pool and neither can see the other
// spending it — the workflow's own budget guard is unreachable for a dispatched run, because
// --max-budget-usd requires --print and --print conflicts with --background.
//
// So the poller's only lever is how many runs it starts. APL-74 and APL-78 went out in the same poll
// on 2026-09-10 and hit the session limit together 30 minutes later, both blocked at audit with the
// diff unverified.
//
// Both directions are asserted. A slot count that always returned 0 is a permanent stall; one that
// always returned Infinity is the bug this file exists for. And the "could not tell" case must read
// as Infinity, not 0 — an unreadable registry must not stop the queue.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
const { countRunningSessions, concurrencySlots } = await import(POLLER + '?conc=1');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message); } };

const agent = (name, status) => ({ name, status });
const reads = (v) => () => (typeof v === 'string' ? v : JSON.stringify(v));

t('a busy dispatched session is counted', () => {
  assert.strictEqual(countRunningSessions(reads([agent('[APL-78] Scoring resolves a key', 'busy')])), 1);
});

t('an idle or blocked session is NOT counted — that is how a limit-hit run stalls the queue forever', () => {
  // Yesterday's two sessions sat idle/blocked for fifteen hours. Counting them would mean the
  // poller never dispatched again, which is strictly worse than the burn this check prevents.
  const list = [agent('[APL-74] Every apply attempt fails', 'idle'), agent('[APL-78] Scoring', 'idle')];
  assert.strictEqual(countRunningSessions(reads(list)), 0);
});

t('a session this poller did not start is not counted against it', () => {
  // dispatch() names every session "[KEY-N] title". Anything else is the human's own window, and
  // holding the queue because someone opened an unrelated session is not the contract.
  const list = [agent('my own refactor', 'busy'), agent('[APL-9] real one', 'busy')];
  assert.strictEqual(countRunningSessions(reads(list)), 1);
});

t('both listing shapes parse — a bare array and { agents: [...] }', () => {
  const one = [agent('[APL-1] a', 'busy')];
  assert.strictEqual(countRunningSessions(reads(one)), 1);
  assert.strictEqual(countRunningSessions(reads({ agents: one })), 1);
});

t('an unreadable registry is "could not tell" (null), never a confident zero', () => {
  assert.strictEqual(countRunningSessions(() => { throw new Error('not a TTY'); }), null);
  assert.strictEqual(countRunningSessions(reads('not json at all')), null);
  assert.strictEqual(countRunningSessions(reads({ nope: 1 })), null);
  assert.strictEqual(countRunningSessions(reads('null')), null);
});

t('a malformed entry does not throw or inflate the count', () => {
  assert.strictEqual(countRunningSessions(reads([null, {}, agent(undefined, 'busy'), agent('[APL-2] x', 'busy')])), 1);
});

t('slots: nothing running yields the full limit; the limit being reached yields zero', () => {
  assert.strictEqual(concurrencySlots(0, 1), 1);
  assert.strictEqual(concurrencySlots(1, 1), 0);
  assert.strictEqual(concurrencySlots(1, 3), 2);
  assert.strictEqual(concurrencySlots(3, 3), 0);
});

t('slots never go negative — more running than the limit still just means "wait"', () => {
  // Reachable whenever the limit is lowered while runs are in flight.
  assert.strictEqual(concurrencySlots(5, 1), 0);
});

t('slots fail OPEN when the count is unknown, matching the unreadable-credential rule', () => {
  assert.strictEqual(concurrencySlots(null, 1), Infinity);
});

t('a limit of 0 or a garbage limit disables the check rather than stopping the queue', () => {
  // "max_concurrent: 0" is a user saying "no limit", not "dispatch nothing" — the same reading
  // every other opt-out in this config takes.
  assert.strictEqual(concurrencySlots(4, 0), Infinity);
  assert.strictEqual(concurrencySlots(4, NaN), Infinity);
});

t('poll() actually consults the slot count — the pure functions are wired in', () => {
  // Every case above stays green if poll() ignores concurrencySlots entirely. This reads the source
  // instead: weaker than driving a poll, but it is the assertion that goes red when the wiring is cut.
  const src = readFileSync(POLLER, 'utf8');
  const loop = /const processed = new Set\(loadJson\(STATE_PATH[\s\S]*?\n  }\n\n  if \(changed\)/.exec(src);
  assert.ok(loop, 'the dispatch loop was not found — this test is asserting nothing');
  assert.match(loop[0], /=\s*countRunningSessions\(/, 'poll() never asks what is already running');
  assert.match(loop[0], /concurrencySlots\(running\)/, 'poll() never converts that into free slots');
  assert.match(loop[0], /Math\.min\(\s*credBudget\s*,\s*slots\s*\)/,
    'poll() does not combine the credential budget with the slot count — one of the two limits is ignored');
});

t('the default limit is 1, and it is a config key', () => {
  const src = readFileSync(POLLER, 'utf8');
  assert.match(src, /cfg\('dispatch\.max_concurrent'\)\s*\?\?\s*1/,
    "dispatch.max_concurrent is not read with a default of 1");
});

process.exit(fails ? 1 : 0);
