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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
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

const CWD = '/r/app';
function poll({ script = {}, processed = null, pending = null, extraCfg = '', agents = [], transcripts = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cycler-home-'));
  const agentsFile = join(home, 'agents.json');
  writeFileSync(agentsFile, agents === null ? 'not json' : JSON.stringify(agents));
  const tdir = join(home, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  for (const [sid, lines] of Object.entries(transcripts))
    writeFileSync(join(tdir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const repo = mkdtempSync(join(tmpdir(), 'cycler-repo-'));
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
      DOUBLE_SCRIPT: scriptPath, DOUBLE_JOURNAL: journal, CLAUDE_PROJECT_DIR: home,
      HOME: home, CYCLER_AGENTS_FILE: agentsFile },
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
  issueId: 'uuid-1', identifier: 'ABC-1', workflow: '/cycler:workflow-feature',
  session: 'sess-1', at: Date.now() - 10 * 60 * 1000, attempts: 1, ...over,
}];
const deadBody = (p) => p.comments.map((c) => c.variables.body).find((b) => /never started/i.test(b));
const agent = (over = {}) => ({ id: 'sess-1', sessionId: 'sess-1', cwd: CWD, name: '[ABC-1] Do the thing', state: 'working', ...over });
const now = () => new Date().toISOString();
const reply = { type: 'assistant', timestamp: now(), message: { content: [{ type: 'text', text: 'reading the issue' }] } };
const loginError = { type: 'assistant', timestamp: now(), isApiErrorMessage: true,
  message: { content: [{ type: 'text', text: 'OAuth session expired and could not be refreshed' }] } };
const oldReply = { ...reply, timestamp: new Date(Date.now() - 86400_000).toISOString() };
const base = { script: { issues: [ISSUE] }, processed: ['uuid-1'] };

// ─── the bug ──────────────────────────────────────────────────────────────────
t('a session that is not in the registry is reported dead, not silently accepted', () => {
  const p = poll({ ...base, pending: stale(), agents: [] });
  assert.ok(deadBody(p), 'no comment told the board the session never started — this is the whole bug');
});

t('a session whose transcript holds only an API error (expired login) is dead', () => {
  const p = poll({ ...base, pending: stale(), agents: [agent({ state: 'idle' })], transcripts: { 'sess-1': [loginError] } });
  const b = deadBody(p);
  assert.ok(b, 'a login-expired session read as alive');
  assert.match(b, /ABC-1/); assert.match(b, /sess-1/); assert.match(b, /login/i);
});

t('a dead dispatch is un-processed, so the next poll retries it', () => {
  const p = poll({ ...base, pending: stale(), agents: [] });
  assert.strictEqual(p.spawns.length, 1, 'the issue was declared dead but never re-dispatched');
  assert.deepStrictEqual(p.processed, ['uuid-1'], 're-dispatch must mark it processed again');
  assert.strictEqual(p.pending[0].attempts, 2, 'the retry count must carry across the re-dispatch');
});

// ─── the other direction: a live run must be left alone ───────────────────────
t('a session with a real reply after dispatch is alive — no comment, no duplicate, no Linear query', () => {
  const p = poll({ ...base, pending: stale(), agents: [agent()], transcripts: { 'sess-1': [reply] } });
  assert.strictEqual(p.spawns.length, 0, 'a healthy run was re-dispatched — two sessions on one branch');
  assert.ok(!deadBody(p), 'a healthy run was reported dead');
  assert.deepStrictEqual(p.pending, [], 'a confirmed run must stop being tracked');
  assert.strictEqual(p.liveChecks.length, 0, 'liveness must not depend on Linear comments');
});

t('comments never prove liveness — a start comment with no transcript reply is not alive', () => {
  const p = poll({ script: { issues: [ISSUE], issueComments: { 'uuid-1': ['🔧 Harness run started'] } },
    processed: ['uuid-1'], pending: stale(), agents: [] });
  assert.ok(deadBody(p));
});

t('a reply from BEFORE the dispatch does not count', () => {
  const p = poll({ ...base, pending: stale(), agents: [agent({ state: 'stopped' })], transcripts: { 'sess-1': [oldReply] } });
  assert.ok(deadBody(p), 'a stale transcript made a dead session look alive');
});

t('a session found only by its [KEY] name is judged too (dispatch printed no id)', () => {
  const p = poll({ ...base, pending: stale({ session: null }), agents: [agent({ id: 'other9', sessionId: 'other9' })],
    transcripts: { other9: [reply] } });
  assert.ok(!deadBody(p)); assert.strictEqual(p.spawns.length, 0);
});

t('a live session that has not replied yet keeps waiting', () => {
  const p = poll({ ...base, pending: stale(), agents: [agent()], transcripts: {} });
  assert.ok(!deadBody(p)); assert.strictEqual(p.spawns.length, 0);
  assert.strictEqual(p.pending.length, 1, 'it must still be tracked, not dropped');
});

t('a dispatch still inside the grace window is not judged yet', () => {
  const p = poll({ ...base, pending: stale({ at: Date.now() }), agents: [] });
  assert.strictEqual(p.spawns.length, 0);
  assert.strictEqual(p.pending.length, 1, 'it must still be tracked, not dropped');
});

// ─── failure modes of the check itself ────────────────────────────────────────
t('retries stop at maxAttempts instead of looping forever', () => {
  const p = poll({ ...base, pending: stale({ attempts: 3 }), agents: [] });
  assert.strictEqual(p.spawns.length, 0, 'the poller kept re-dispatching past maxAttempts');
  assert.match(deadBody(p), /Not retrying/, 'giving up must be said out loud, not just done');
  assert.deepStrictEqual(p.processed, ['uuid-1'], 'a given-up issue stays processed');
});

t('dispatch.max_attempts is read from the config, in either spelling', () => {
  for (const spelling of ['max_attempts', 'maxAttempts', 'max-attempts']) {
    const p = poll({ ...base, pending: stale({ attempts: 1 }), agents: [], extraCfg: `  ${spelling}: 1\n` });
    assert.strictEqual(p.spawns.length, 0, `${spelling} was ignored — it re-dispatched past the limit`);
    assert.match(deadBody(p), /Not retrying/, `${spelling} was ignored`);
  }
  const dflt = poll({ ...base, pending: stale({ attempts: 1 }), agents: [] });
  assert.strictEqual(dflt.spawns.length, 1, 'attempt 1 of 3 must retry');
});

t('dispatch.start_grace_seconds is read from the config', () => {
  const p = poll({ ...base, pending: stale(), agents: [], extraCfg: '  start_grace_seconds: 86400\n' });
  assert.strictEqual(p.spawns.length, 0);
  assert.strictEqual(p.pending.length, 1, 'it must still be tracked, not dropped');
});

t('an unreadable session registry keeps waiting rather than declaring a live run dead', () => {
  const p = poll({ ...base, pending: stale(), agents: null });
  assert.strictEqual(p.spawns.length, 0, 'an unreadable registry spawned a duplicate session — the worst outcome');
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

// ─── comments stay readable ──────────────────────────────────────────────────
t('no skill posts a hidden HTML marker', () => {
  for (const s of ['workflow-feature', 'workflow-bug', 'workflow-research']) {
    const src = readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(src, /--body '<!--/, `skills/${s}/SKILL.md posts an HTML marker`);
  }
});

process.exit(fails ? 1 : 0);
