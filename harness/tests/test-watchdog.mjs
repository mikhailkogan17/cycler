// The watchdog reads each watched session's transcript and gives it exactly one verdict per poll:
// limited, waiting on a human, finished, or still working. Each verdict below must be able to go red.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'cycler-watchdog-'));
process.env.CYCLER_HOME = DIR;
const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
const { classifyTranscript, reviewRunning, findGhosts, reapGhosts } = await import(POLLER + '?wd=1');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message); } };

const T0 = Date.parse('2026-09-12T20:00:00Z');
const limitEntry = (ts) => ({ type: 'assistant', uuid: 'L', timestamp: new Date(ts).toISOString(), isApiErrorMessage: true,
  message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 1am (Asia/Jerusalem)" }] } });
const turnEntry = (ts, text = 'Should I raise max_files to 50?', uuid = 'Q') => ({ type: 'assistant', uuid, timestamp: new Date(ts).toISOString(),
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const toolEntry = (ts) => ({ type: 'assistant', uuid: 'T', timestamp: new Date(ts).toISOString(),
  message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } });
const jsonl = (...e) => e.map((x) => JSON.stringify(x)).join('\n') + '\n{"type":"system","subtype":"turn_duration"}\n';
const REC = { session: 's1', issueId: 'i1', identifier: 'APL-87', at: T0 };
const setWatched = (r) => writeFileSync(join(DIR, 'running.json'), JSON.stringify(r));
const watched = () => JSON.parse(readFileSync(join(DIR, 'running.json'), 'utf8'));
const cooldown = () => { try { return JSON.parse(readFileSync(join(DIR, 'cooldown.json'), 'utf8')); } catch { return null; } };

t('a limit error newer than the watch is limited', () => {
  assert.strictEqual(classifyTranscript(jsonl(limitEntry(T0 + 1000)), T0).kind, 'limited');
});
t('a limit error OLDER than the watch is not (the fake-cooldown bug)', () => {
  assert.strictEqual(classifyTranscript(jsonl(limitEntry(T0 - 1000)), T0).kind, 'working');
});
t('a limit followed by more work is not limited', () => {
  assert.strictEqual(classifyTranscript(jsonl(limitEntry(T0 + 1), turnEntry(T0 + 2)), T0).kind, 'turn');
});
t('mid tool call is working', () => {
  assert.strictEqual(classifyTranscript(jsonl(toolEntry(T0 + 1)), T0).kind, 'working');
});

t('limited session is parked with a hold computed from when the limit hit', () => {
  setWatched([REC]);
  const hit = Date.parse('2026-09-12T21:00:00Z'); // 00:00 Jerusalem → reset 1h later
  const r = reviewRunning({ agents: [{ id: 's1', state: 'stopped' }], readTranscript: () => jsonl(limitEntry(hit)), now: hit + 30 * 60_000 });
  assert.strictEqual(r.limited.length, 1);
  assert.ok(Math.abs(r.state.until - (hit + 60 * 60_000)) < 90_000, 'hold not anchored to the limit timestamp');
  assert.deepStrictEqual(watched(), []);
});

t('a hold already in the past writes no cooldown', () => {
  writeFileSync(join(DIR, 'cooldown.json'), 'null');
  setWatched([REC]);
  const hit = Date.parse('2026-09-12T21:00:00Z');
  const r = reviewRunning({ agents: [], readTranscript: () => jsonl(limitEntry(hit)), now: hit + 3 * 3600_000 });
  assert.strictEqual(r.limited.length, 1);
  assert.strictEqual(cooldown(), null);
});

t('waiting on a human is notified once per message and kept', () => {
  setWatched([REC]);
  const agents = [{ id: 's1', state: 'idle' }];
  const read = () => jsonl(turnEntry(T0 + 5));
  assert.strictEqual(reviewRunning({ agents, readTranscript: read }).waiting.length, 1);
  assert.strictEqual(watched().length, 1, 'waiting session dropped from the watch');
  assert.strictEqual(reviewRunning({ agents, readTranscript: read }).waiting.length, 0, 'notified twice for one message');
  const again = reviewRunning({ agents, readTranscript: () => jsonl(turnEntry(T0 + 9, 'next?', 'Q2')) });
  assert.strictEqual(again.waiting.length, 1, 'a new question was not notified');
});

t('busy sessions are kept without reading anything', () => {
  setWatched([REC]);
  const r = reviewRunning({ agents: [{ id: 's1', state: 'working' }], readTranscript: () => { throw new Error('read'); } });
  assert.strictEqual(r.waiting.length + r.limited.length + r.finished.length, 0);
  assert.strictEqual(watched().length, 1);
});

t('gone, stopped or closed-issue sessions are finished', () => {
  for (const [agents, states] of [[[], new Map()], [[{ id: 's1', state: 'stopped' }], new Map()],
    [[{ id: 's1', state: 'working' }], new Map([['i1', 'completed']])]]) {
    setWatched([REC]);
    const r = reviewRunning({ agents, issueStates: states, readTranscript: () => jsonl(turnEntry(T0 + 5)) });
    assert.strictEqual(r.finished.length, 1);
    assert.deepStrictEqual(watched(), []);
  }
});

t('an unreadable registry changes nothing', () => {
  setWatched([REC]);
  reviewRunning({ agents: null, readTranscript: () => jsonl(limitEntry(T0 + 5)) });
  assert.strictEqual(watched().length, 1);
});

t('ghosts: resume-prompt copies and live duplicates of a watched key; never the watched one', () => {
  const agents = [
    { id: 's1', name: '[APL-87] feature', state: 'idle' },
    { id: 'g1', name: "The account's Claude usage window has reset, so…", state: 'working' },
    { id: 'g2', name: '[APL-87] feature', state: 'working' },
    { id: 'ok', name: '[APL-94] other', state: 'working' },
    { id: 'old', name: '[APL-87] feature', state: 'stopped' },
  ];
  assert.deepStrictEqual(findGhosts(agents, [REC]).map((g) => g.id), ['g1', 'g2']);
  assert.deepStrictEqual(findGhosts(agents.filter((a) => a.id !== 's1'), [REC]).map((g) => g.id), ['g1'],
    'a re-dispatch was reaped although its watched session is gone');
  setWatched([REC]);
  const stopped = [];
  reapGhosts(agents, (id) => stopped.push(id));
  assert.deepStrictEqual(stopped, ['g1', 'g2']);
});

t('poll() no longer reads `claude logs`', () => {
  const src = readFileSync(POLLER, 'utf8');
  assert.doesNotMatch(src, /\['logs'/);
  assert.match(src, /reapGhosts\(agents\)/);
  assert.match(src, /Waiting for you/);
});

if (fails) { console.log(`${fails} failed`); process.exit(1); }
