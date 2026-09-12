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

// parkForResume() and resumeAfterLimit() WRITE state files, so the state dir is redirected before
// the module is imported — DIR is resolved once at module load. Without this the suite would edit
// the real ~/.cycler and a test run could disturb live sessions.
const DIR = mkdtempSync(join(tmpdir(), 'cycler-cooldown-'));
process.env.CYCLER_HOME = DIR;

const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
const { parseLimitReset, cooldownRemaining, busySessionIds, parkForResume, resumeAfterLimit,
  resumePrompt, resumeArgv, fullSessionId } =
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

t('a limited session is PARKED for resume — the issue stays processed so nothing re-dispatches it', () => {
  const issueId = 'f10abda2-5d35-41d2-b800-e3681cdcec48';
  writeFileSync(join(DIR, 'processed.json'), JSON.stringify([issueId, 'other-issue']));
  writeFileSync(join(DIR, 'resume.json'), '[]');
  const out = parkForResume([{ issueId, identifier: 'APL-79', session: 'a472f353', workflow: '/w', attempts: 1 }], 123);
  assert.strictEqual(out.length, 1, 'the record was not parked');
  assert.strictEqual(out[0].attempts, 2, 'the attempt count did not advance');
  const processed = JSON.parse(readFileSync(join(DIR, 'processed.json'), 'utf8'));
  assert.ok(processed.includes(issueId),
    'the issue was un-processed, so the normal dispatch path will start a SECOND run on it — the APL-84 bug');
  const parked = JSON.parse(readFileSync(join(DIR, 'resume.json'), 'utf8'));
  assert.strictEqual(parked[0].session, 'a472f353', 'the session id was not kept, so nothing can be resumed');
});

t('the retry ceiling still applies — an issue that hits the limit every time does not loop forever', () => {
  writeFileSync(join(DIR, 'resume.json'), '[]');
  const out = parkForResume([{ issueId: 'aaaa', identifier: 'APL-1', session: 'x', attempts: 3 }], 1);
  assert.strictEqual(out.length, 0, 'a run past the attempt ceiling was parked anyway');
  assert.deepStrictEqual(JSON.parse(readFileSync(join(DIR, 'resume.json'), 'utf8')), []);
});

t('a watch record with no session id is reported, not silently parked', () => {
  writeFileSync(join(DIR, 'resume.json'), '[]');
  assert.deepStrictEqual(parkForResume([{ issueId: 'b', identifier: 'APL-76', attempts: 1 }], 1), []);
});

t('resumeAfterLimit continues the SAME session rather than dispatching a new one', () => {
  writeFileSync(join(DIR, 'resume.json'), JSON.stringify(
    [{ session: 'a472f353', issueId: 'i1', identifier: 'APL-79', workflow: '/w', attempts: 2 }]));
  writeFileSync(join(DIR, 'running.json'), '[]');
  const calls = [];
  const out = resumeAfterLimit((s, p) => calls.push([s, p]), () => JSON.stringify([]));
  assert.strictEqual(calls.length, 1, 'nothing was resumed');
  assert.strictEqual(calls[0][0], 'a472f353', 'a different session was resumed');
  assert.match(calls[0][1], /reset/i, 'the resumed session is not told why it woke up');
  assert.strictEqual(out.resumed.length, 1);
  assert.deepStrictEqual(JSON.parse(readFileSync(join(DIR, 'resume.json'), 'utf8')), [],
    'the record stayed parked, so it will resume again on the next poll');
  const watched = JSON.parse(readFileSync(join(DIR, 'running.json'), 'utf8'));
  assert.strictEqual(watched[0].session, 'a472f353',
    'the resumed session is not watched, so a second limit in the new window goes unnoticed');
});

t('resume is ALWAYS called; a copy the CLI starts for an already-running session is stopped', () => {
  writeFileSync(join(DIR, 'resume.json'), JSON.stringify(
    [{ session: 'e416007a', issueId: 'i1', identifier: 'APL-84', workflow: '/w', attempts: 2 }]));
  writeFileSync(join(DIR, 'running.json'), '[]');
  const calls = [], stopped = [];
  const agents = () => JSON.stringify([{ id: 'e416007a', name: '[APL-84] Sidebar', state: 'working' }]);
  const out = resumeAfterLimit((s) => { calls.push(s); return 'b9bc6f60'; }, agents, (id) => stopped.push(id));
  assert.strictEqual(calls.length, 1, 'resume was skipped');
  assert.deepStrictEqual(stopped, ['b9bc6f60'], 'the duplicate copy was left running');
  assert.strictEqual(out.selfRestored.length, 1);
  assert.deepStrictEqual(JSON.parse(readFileSync(join(DIR, 'resume.json'), 'utf8')), []);
});

t('a copy started for a DEAD session is stopped and the resume retried (the 0.2.11 b9bc6f60 bug)', () => {
  writeFileSync(join(DIR, 'resume.json'), JSON.stringify(
    [{ session: '8b56d07d', issueId: 'i1', identifier: 'APL-87', workflow: '/w', attempts: 2 }]));
  writeFileSync(join(DIR, 'running.json'), '[]');
  const stopped = [];
  const out = resumeAfterLimit(() => 'b9bc6f60', () => '[]', (id) => stopped.push(id));
  assert.deepStrictEqual(stopped, ['b9bc6f60']);
  assert.strictEqual(out.resumed.length, 0, 'a new session was counted as a resume');
  assert.strictEqual(JSON.parse(readFileSync(join(DIR, 'resume.json'), 'utf8')).length, 1);
});

t('resume uses the FULL session UUID, auto permissions, and runs from the repo', () => {
  const agents = () => JSON.stringify([{ id: '8b56d07d', sessionId: '8b56d07d-4184-49fe-86b2-04a9b1981c49' }]);
  assert.strictEqual(fullSessionId('8b56d07d', agents), '8b56d07d-4184-49fe-86b2-04a9b1981c49');
  const argv = resumeArgv('8b56d07d-4184-49fe-86b2-04a9b1981c49', 'go');
  assert.deepStrictEqual(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2),
    ['--resume', '8b56d07d-4184-49fe-86b2-04a9b1981c49']);
  assert.ok(argv.includes('--background'));
  assert.match(argv.join(' '), /--permission-mode auto/);
  const src = readFileSync(POLLER, 'utf8');
  const fn = /function defaultResume[\s\S]*?\n}\n/.exec(src)[0];
  assert.match(fn, /cwd: REPO_PATH/, 'launchd cwd is "/" — the CLI starts a new session there');
  assert.match(fn, /PATH_PREPEND/);
  assert.match(fn, /sessionId/);
  assert.match(fn, /!isWorking\(hit\)[\s\S]*defaultStop\(session\)[\s\S]*resumeArgv/,
    'an idle registered session is not stopped before --resume, so the CLI starts a copy');
});

t('poll() counts resumed sessions against max_concurrent', () => {
  assert.match(readFileSync(POLLER, 'utf8'), /running \+= resumed\.length/,
    'a resume and a fresh dispatch went out in the same poll at max_concurrent=1');
});

t('a failed resume is retried, not dropped', () => {
  writeFileSync(join(DIR, 'resume.json'), JSON.stringify(
    [{ session: 'zz', issueId: 'i1', identifier: 'APL-9', workflow: '/w', attempts: 2 }]));
  writeFileSync(join(DIR, 'running.json'), '[]');
  const out = resumeAfterLimit(() => { throw new Error('claude exploded'); }, () => JSON.stringify([]));
  assert.strictEqual(out.resumed.length, 0);
  assert.strictEqual(JSON.parse(readFileSync(join(DIR, 'resume.json'), 'utf8')).length, 1,
    'a resume that failed once dropped the run on the floor');
});

t('the resume prompt forbids starting over — a fresh run on the same branch is the failure mode', () => {
  const text = resumePrompt({ identifier: 'APL-84', workflow: '/cycler:workflow-feature' });
  assert.match(text, /APL-84/);
  assert.match(text, /\/cycler:workflow-feature/);
  assert.match(text, /not start over/i, 'the resumed session is free to redo the whole issue');
});

t('poll() parks and ANNOUNCES a limited run, rather than only logging it', () => {
  const src = readFileSync(POLLER, 'utf8');
  const loop = /const processed = new Set\(loadJson\(STATE_PATH[\s\S]*?\n  }\n\n  if \(changed\)/.exec(src);
  assert.match(loop[0], /parkForResume\(review\.limited/,
    'poll() never parks the runs a usage limit killed — they are abandoned when the window reopens');
  assert.match(loop[0], /await comment\(\s*rec\.issueId/,
    'nothing is posted to Linear, so a run killed by the limit looks identical on the board to one never picked up');
  assert.match(loop[0], /resumesAt/, 'the comment does not say when the work resumes');
});

t('poll() resumes parked sessions once the cooldown is over, and says so on the issue', () => {
  const src = readFileSync(POLLER, 'utf8');
  const block = /if \(cooling === 0\) \{[\s\S]*?\n  }\n/.exec(src);
  assert.ok(block, 'poll() never resumes parked sessions — a limited run is parked and forgotten');
  assert.match(block[0], /resumeAfterLimit\(\)/);
  assert.match(block[0], /await comment\(/, 'a resume is invisible on the board');
});

process.exit(fails ? 1 : 0);
