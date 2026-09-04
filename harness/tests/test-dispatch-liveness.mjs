// Spawning a session is not the same as the session running.
//
// dispatch() resolves the moment `claude --background` prints an id, and the poller marks the issue
// processed on that. A session that dies on its first turn — an expired Claude Code login does it in
// under a second — is therefore recorded as a success. Four consecutive APL-60 dispatches died this
// way. All four read as fine from the board; the failure was found by hand, days later, by noticing
// no PR had appeared.
//
// The proof of life is the start marker every routable skill posts as its first act. These tests run
// the SHIPPED poller against the Linear double, so the pending record, the grace window, the retry
// and the give-up are the real code paths.
//
// Both directions, deliberately: "a marker-less dispatch is reported dead" alone would pass against a
// poller that called EVERY run dead, which is worse than the bug — it would spawn a duplicate session
// on a live branch every 180s. So the healthy case is asserted just as hard.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const POLLER = join(ROOT, 'poller', 'poller.mjs');
const DOUBLE = join(HERE, 'linear-double', 'double.mjs');
const FAKE = join(HERE, 'linear-double', 'fake-claude.mjs');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

const ISSUE = {
  id: 'uuid-1', identifier: 'ABC-1', title: 'Do the thing',
  state: { type: 'started' }, labels: { nodes: [] },
};

function poll({ script = {}, processed = null, pending = null, extraCfg = '' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cycler-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'cycler-repo-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }));
  writeFileSync(join(home, 'token.json'), JSON.stringify({ access_token: 'tok-1', refresh_token: 'refresh-1' }));
  if (processed) writeFileSync(join(home, 'processed.json'), JSON.stringify(processed));
  if (pending) writeFileSync(join(home, 'pending.json'), JSON.stringify(pending));
  const scriptPath = join(home, 'script.json');
  const journal = join(home, 'journal.ndjson');
  writeFileSync(scriptPath, JSON.stringify(script));
  writeFileSync(journal, '');
  const cfgPath = join(home, 'cycler.yaml');
  writeFileSync(cfgPath,
    `repo:\n  path: ${repo}\n\ndispatch:\n  command: claude ${FAKE} --workflow "{workflow}" --issue "{issue}" --title "{title}"\n${extraCfg}`);

  const r = spawnSync(process.execPath, ['--import', DOUBLE, POLLER], {
    encoding: 'utf8',
    env: { ...process.env, CYCLER_HOME: home, CYCLER_CONFIG: cfgPath, CLAUDE_BIN: process.execPath,
      DOUBLE_SCRIPT: scriptPath, DOUBLE_JOURNAL: journal, CLAUDE_PROJECT_DIR: home },
  });
  const entries = readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const read = (f) => existsSync(join(home, f)) ? JSON.parse(readFileSync(join(home, f), 'utf8')) : null;
  return { r, entries, home,
    processed: read('processed.json'), pending: read('pending.json'),
    spawns: entries.filter((e) => e.kind === 'spawn'),
    comments: entries.filter((e) => e.op === 'comment'),
    liveChecks: entries.filter((e) => e.op === 'issueComments') };
}

const stale = (over = {}) => [{
  issueId: 'uuid-1', identifier: 'ABC-1', workflow: '/cycler:task',
  session: 'sess-1', at: Date.now() - 10 * 60 * 1000, attempts: 1, ...over,
}];
const deadBody = (p) => p.comments.map((c) => c.variables.body).find((b) => /never started/i.test(b));

// ─── the bug ──────────────────────────────────────────────────────────────────
t('a dispatch that posted no start marker is reported dead, not silently accepted', () => {
  const p = poll({ script: { issues: [ISSUE], issueComments: { 'uuid-1': [] } },
    processed: ['uuid-1'], pending: stale() });
  assert.strictEqual(p.liveChecks.length, 1, 'the poller never checked whether the session started');
  assert.ok(deadBody(p), 'no comment told the board the session never started — this is the whole bug');
});

t('the dead-dispatch comment names the likely cause and how to check it', () => {
  const p = poll({ script: { issues: [ISSUE], issueComments: { 'uuid-1': [] } },
    processed: ['uuid-1'], pending: stale() });
  const b = deadBody(p);
  assert.match(b, /ABC-1/, 'the comment must name the issue');
  assert.match(b, /sess-1/, 'the comment must name the session, or it cannot be investigated');
  assert.match(b, /login/i, 'the comment must name the cause that actually happened four times');
});

t('a dead dispatch is un-processed, so the next poll retries it', () => {
  const p = poll({ script: { issues: [ISSUE], issueComments: { 'uuid-1': [] } },
    processed: ['uuid-1'], pending: stale() });
  // Same poll re-dispatches: checkLiveness runs before the dispatch loop.
  assert.strictEqual(p.spawns.length, 1, 'the issue was declared dead but never re-dispatched');
  assert.deepStrictEqual(p.processed, ['uuid-1'], 're-dispatch must mark it processed again');
  assert.strictEqual(p.pending[0].attempts, 2, 'the retry count must carry across the re-dispatch');
});

// ─── the other direction: a live run must be left alone ───────────────────────
t('a dispatch WITH a start marker is left alone — no comment, no duplicate session', () => {
  const p = poll({
    script: { issues: [ISSUE], issueComments: { 'uuid-1': ['<!-- harness:ABC-1:dispatched -->\n🔧 started'] } },
    processed: ['uuid-1'], pending: stale(),
  });
  assert.strictEqual(p.spawns.length, 0, 'a healthy run was re-dispatched — two sessions on one branch');
  assert.ok(!deadBody(p), 'a healthy run was reported dead');
  assert.deepStrictEqual(p.pending, [], 'a confirmed run must stop being tracked');
});

t('the research skill marker counts too — it is a different suffix', () => {
  const p = poll({
    script: { issues: [ISSUE], issueComments: { 'uuid-1': ['<!-- harness:ABC-1:started -->\n🔎 started'] } },
    processed: ['uuid-1'], pending: stale(),
  });
  assert.strictEqual(p.spawns.length, 0, 'a live research run was declared dead');
  assert.ok(!deadBody(p));
});

t('a dispatch still inside the grace window is not judged yet', () => {
  const p = poll({ script: { issues: [ISSUE], issueComments: { 'uuid-1': [] } },
    processed: ['uuid-1'], pending: stale({ at: Date.now() }) });
  assert.strictEqual(p.liveChecks.length, 0, 'the poller judged a session younger than the grace window');
  assert.strictEqual(p.spawns.length, 0);
  assert.strictEqual(p.pending.length, 1, 'it must still be tracked, not dropped');
});

// ─── failure modes of the check itself ────────────────────────────────────────
t('retries stop at maxAttempts instead of looping forever', () => {
  const p = poll({ script: { issues: [ISSUE], issueComments: { 'uuid-1': [] } },
    processed: ['uuid-1'], pending: stale({ attempts: 3 }) });
  assert.strictEqual(p.spawns.length, 0, 'the poller kept re-dispatching past maxAttempts');
  assert.match(deadBody(p), /Not retrying/, 'giving up must be said out loud, not just done');
  assert.deepStrictEqual(p.processed, ['uuid-1'], 'a given-up issue stays processed');
});

t('an unanswerable liveness query keeps waiting rather than declaring a live run dead', () => {
  const p = poll({ script: { issues: [ISSUE], issueComments: { 'uuid-1': [] }, commentsQueryFails: true },
    processed: ['uuid-1'], pending: stale() });
  assert.strictEqual(p.spawns.length, 0, 'an API failure spawned a duplicate session — the worst outcome');
  assert.ok(!deadBody(p));
  assert.strictEqual(p.pending.length, 1, 'the record must be kept for the next poll');
});

t('a fresh dispatch records itself as pending, so it can be judged later', () => {
  const p = poll({ script: { issues: [ISSUE], issueComments: {} } });
  assert.strictEqual(p.spawns.length, 1);
  assert.strictEqual(p.pending.length, 1, 'a dispatch that is not tracked can never be found dead');
  assert.strictEqual(p.pending[0].identifier, 'ABC-1');
  assert.strictEqual(p.pending[0].attempts, 1);
});

// ─── the coupling that would otherwise rot ────────────────────────────────────
t('every routable skill posts the marker the poller looks for', () => {
  for (const s of ['task', 'research']) {
    const src = readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8');
    assert.match(src, /harness:<KEY>:/,
      `skills/${s}/SKILL.md posts no start marker — every ${s} dispatch will be declared dead and retried`);
  }
});

process.exit(fails ? 1 : 0);
