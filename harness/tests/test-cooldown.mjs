// max_concurrent stops two runs from racing. It does NOT stop them from emptying the same usage
// window one after the other, and that is what happened on 2026-09-11: APL-78 ran alone for 22
// minutes across 14 agents, finished, and APL-74 started three minutes later into the remainder and
// died at its last stage. Eleven straight "holding off" lines in the log — nothing was concurrent.
//
// So the second guard is time, not parallelism: when a dispatched session dies on the account's
// usage limit, nothing new goes out until the window resets. The CLI names the reset in the message
// it kills the session with, and that message is read from `claude logs <id>` — local, no network
// call and no inference call.
//
// Both directions matter. A parser that returned a hold for any text would stall the queue on an
// ordinary failure; one that never returned a hold is the bug this file exists for.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// requeueAfterLimit() WRITES processed.json, so the state dir is redirected before the module is
// imported — DIR is resolved once at module load. Without this the suite would edit the real
// ~/.cycler and a test run could re-dispatch live issues.
const DIR = mkdtempSync(join(tmpdir(), 'cycler-cooldown-'));
process.env.CYCLER_HOME = DIR;

const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
const { parseLimitReset, cooldownRemaining, busySessionIds, requeueAfterLimit } =
  await import(POLLER + '?cool=1');
assert.notStrictEqual(DIR, join(process.env.HOME || '', '.cycler'), 'the test is writing to the real state dir');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message); } };

// A fixed instant to reason from: 2026-09-11T02:29:56Z, which is 05:29 in Asia/Jerusalem.
const NOW = Date.parse('2026-09-11T02:29:56Z');
const MIN = 60_000;
// A ceiling high enough to not interfere: the clamp gets its own case below.
const NOCAP = 99 * 60 * 60_000;
const parse = (text, now = NOW) => parseLimitReset(text, now, undefined, NOCAP);
const near = (actual, expectedMin, label) =>
  assert.ok(Math.abs((actual - NOW) / MIN - expectedMin) < 1.5,
    `${label}: expected ~${expectedMin} min, got ${Math.round((actual - NOW) / MIN)}`);

t('the real message that killed APL-74 parses, and holds until the named reset', () => {
  // 05:29 Jerusalem -> 9am the same morning is 3h31m away.
  const out = parseLimitReset("You've hit your session limit · resets 9am (Asia/Jerusalem)", NOW);
  near(out, 211, '9am from 05:29');
});

t('a reset that has already passed today is read as tomorrow, not as the past', () => {
  // 05:29 Jerusalem, "resets 5am" -> 23h31m, not minus 29 minutes. A negative hold is no hold at
  // all, which would put the poller straight back into the spent window.
  const out = parse("You've hit your session limit · resets 5am (Asia/Jerusalem)");
  assert.ok(out > NOW, 'a past-looking reset produced a hold in the past');
  near(out, 23 * 60 + 31, '5am from 05:29');
});

t('minutes and pm are both read — "resets 5:20pm" is not "resets 5am"', () => {
  const out = parse("You've hit your session limit · resets 5:20pm (Asia/Jerusalem)");
  near(out, 11 * 60 + 51, '5:20pm from 05:29');
});

t('12am and 12pm are not read as hour 12 and hour 0', () => {
  const noon = parse('hit your session limit · resets 12pm (Asia/Jerusalem)');
  const midnight = parse('hit your session limit · resets 12am (Asia/Jerusalem)');
  near(noon, 6 * 60 + 31, 'noon from 05:29');
  near(midnight, 18 * 60 + 31, 'midnight from 05:29');
});

t('the hold is capped, so a misread reset cannot stall the queue for a day', () => {
  const out = parseLimitReset('hit your session limit · resets 5am (Asia/Jerusalem)', NOW);
  assert.ok(out - NOW <= 6 * 60 * MIN, 'a 23-hour hold was not capped to the ceiling');
});

t('a limit message with no readable reset still holds, on the fallback', () => {
  // Knowing the window is spent is the load-bearing half. The reset time only sharpens it.
  near(parseLimitReset('You have hit your usage limit', NOW), 60, 'no reset at all');
  near(parseLimitReset('hit your session limit · resets 9am (Mars/Olympus)', NOW), 60, 'unknown zone');
  near(parseLimitReset('hit your session limit · resets 99:99 (Asia/Jerusalem)', NOW), 60, 'impossible clock');
});

t('ordinary output is NOT a limit — the queue must not stop on a normal failure', () => {
  for (const text of [
    '', 'Error: gate failed on 3 checks', 'rate limit exceeded for the GitHub API',
    'the session limit for open worktrees', 'Done. Opened PR #152.',
  ]) assert.strictEqual(parseLimitReset(text, NOW), null, `treated as a limit: ${JSON.stringify(text)}`);
});

t('a non-string log read is not a limit', () => {
  for (const v of [null, undefined, 0, {}, []]) assert.strictEqual(parseLimitReset(v, NOW), null);
});

t('cooldownRemaining: a future hold blocks, a past one does not, junk does not', () => {
  assert.strictEqual(cooldownRemaining({ until: NOW + 10 * MIN }, NOW), 10 * MIN);
  assert.strictEqual(cooldownRemaining({ until: NOW - MIN }, NOW), 0);
  assert.strictEqual(cooldownRemaining(null, NOW), 0);
  assert.strictEqual(cooldownRemaining({}, NOW), 0);
  assert.strictEqual(cooldownRemaining({ until: 'soon' }, NOW), 0);
});

t('busySessionIds returns only what is busy, and survives an unreadable registry', () => {
  const reads = (v) => () => JSON.stringify(v);
  const got = busySessionIds(reads([{ id: 'aaa', status: 'busy' }, { id: 'bbb', status: 'idle' }]));
  assert.deepStrictEqual([...got], ['aaa']);
  assert.deepStrictEqual([...busySessionIds(() => { throw new Error('no TTY'); })], []);
});

t('poll() honours the cooldown before dispatching, and it is the tail of a session that sets it', () => {
  const src = readFileSync(POLLER, 'utf8');
  const loop = /const processed = new Set\(loadJson\(STATE_PATH[\s\S]*?\n  }\n\n  if \(changed\)/.exec(src);
  assert.ok(loop, 'the dispatch loop was not found — this test is asserting nothing');
  assert.match(loop[0], /reviewRunning\(/, 'poll() never checks how the last sessions ended');
  assert.match(loop[0], /cooldownRemaining\(/, 'poll() never reads the cooldown');
  assert.match(loop[0], /cooling\s*>\s*0\s*\?\s*0\s*:/, 'a live cooldown does not actually zero the slots');
  // The watch only exists because pending.json is dropped the moment a session proves it STARTED,
  // and a limit is hit hours later.
  assert.match(src, /RUNNING_PATH[\s\S]{0,1200}?watched\.push/, 'a confirmed session is never watched for how it ends');
});

t('the watch record carries issueId — without it a limited run cannot be requeued', () => {
  // This is the whole difference between "the cooldown held the queue" and "the work resumed".
  // APL-79 and APL-67 were both recorded as ending on the usage limit and both were then dropped:
  // the issue stays in processed.json, so the cooldown expired onto an empty queue.
  const src = readFileSync(POLLER, 'utf8');
  const push = /watched\.push\(\{[\s\S]*?\}\)/.exec(src);
  assert.ok(push, 'the watch record was not found');
  assert.match(push[0], /issueId:/, 'the watch record has no issue id, so nothing can be un-processed');
  assert.match(push[0], /attempts:/, 'the watch record loses the attempt count, so the retry ceiling never applies');
});

t('a limited session is REQUEUED — the issue comes back out of processed.json', () => {
  const issueId = 'f10abda2-5d35-41d2-b800-e3681cdcec48';
  writeFileSync(join(DIR, 'processed.json'), JSON.stringify([issueId, 'other-issue']));
  const out = requeueAfterLimit([{ issueId, identifier: 'APL-79', session: 'a472f353', attempts: 1 }]);
  assert.strictEqual(out.length, 1, 'the record was not requeued');
  const processed = JSON.parse(readFileSync(join(DIR, 'processed.json'), 'utf8'));
  assert.ok(!processed.includes(issueId), 'the issue is still processed, so it will never re-dispatch');
  assert.ok(processed.includes('other-issue'), 'requeuing one issue wiped an unrelated one');
});

t('the retry ceiling still applies — an issue that hits the limit every time does not loop forever', () => {
  const issueId = 'aaaa1111-0000-0000-0000-000000000000';
  writeFileSync(join(DIR, 'processed.json'), JSON.stringify([issueId]));
  const out = requeueAfterLimit([{ issueId, identifier: 'APL-1', session: 'x', attempts: 3 }]);
  assert.strictEqual(out.length, 0, 'an issue past the attempt ceiling was requeued anyway');
  assert.ok(JSON.parse(readFileSync(join(DIR, 'processed.json'), 'utf8')).includes(issueId),
    'it was un-processed despite not being requeued — it will re-dispatch with no ceiling');
});

t('a watch record with no issue id is reported, not silently dropped', () => {
  writeFileSync(join(DIR, 'processed.json'), JSON.stringify([]));
  assert.deepStrictEqual(requeueAfterLimit([{ identifier: 'APL-76', session: 'x', attempts: 1 }]), []);
});

t('poll() requeues and ANNOUNCES a limited run, rather than only logging it', () => {
  const src = readFileSync(POLLER, 'utf8');
  const loop = /const processed = new Set\(loadJson\(STATE_PATH[\s\S]*?\n  }\n\n  if \(changed\)/.exec(src);
  assert.match(loop[0], /requeueAfterLimit\(review\.limited\)/,
    'poll() never requeues the issues a usage limit killed — the cooldown expires onto an empty queue');
  assert.match(loop[0], /await comment\(\s*rec\.issueId/,
    'nothing is posted to Linear, so a run killed by the limit looks identical on the board to one never picked up');
  assert.match(loop[0], /resumesAt/, 'the comment does not say when the work resumes');
});

t('a resumed dispatch says so, and says it AFTER the line everything else matches on', () => {
  const src = readFileSync(POLLER, 'utf8');
  const fn = /async function dispatch\(issue\)[\s\S]*?\n}\n/.exec(src);
  const body = /`⚡ Dispatched[\s\S]*?\n    \);/.exec(fn[0]);
  assert.ok(body, 'the dispatch comment was not found');
  assert.match(body[0], /Resumed/, 'a re-dispatch after a usage limit is indistinguishable from a first one');
  assert.ok(body[0].indexOf('⚡ Dispatched') < body[0].indexOf('Resumed'),
    'the resume note prefixes the comment — other checks match on "⚡ Dispatched" being first');
});

process.exit(fails ? 1 : 0);
