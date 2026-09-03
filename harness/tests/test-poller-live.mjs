// Spec 001 assertions that needed a Linear API double: §1 auth, §2 selection, §4 dispatch, §5 reporting.
//
// The poller runs as a real child process against harness/tests/linear-double — only `fetch` and the
// `claude` binary are replaced, so token load, the delegate filter, routing, spawn and the state
// write are the shipped code paths. Every assertion here was "— untested" in docs/specs/001-poller.md.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
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

const issue = (o = {}) => ({
  id: o.id || 'uuid-1', identifier: o.identifier || 'ABC-1', title: o.title || 'Do the thing',
  state: { type: o.stateType || 'started' }, labels: { nodes: (o.labels || []).map((name) => ({ name })) },
});

// One poll, against a scripted Linear. Returns the journal of everything that crossed the boundary.
function poll({ script = {}, cfg = null, token = {}, processed = null, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cycler-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'cycler-repo-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }));
  writeFileSync(join(home, 'token.json'), JSON.stringify({ access_token: 'tok-1', refresh_token: 'refresh-1', ...token }));
  if (processed) writeFileSync(join(home, 'processed.json'), JSON.stringify(processed));
  const scriptPath = join(home, 'script.json');
  const journal = join(home, 'journal.ndjson');
  writeFileSync(scriptPath, JSON.stringify(script));
  writeFileSync(journal, '');
  const cfgPath = join(home, 'cycler.yaml');
  const repoLine = `repo:\n  path: ${repo}\n`;
  writeFileSync(cfgPath, cfg ? cfg(repoLine) : repoLine);

  const r = spawnSync(process.execPath, ['--import', DOUBLE, POLLER], {
    encoding: 'utf8',
    env: {
      ...process.env, ...env,
      CYCLER_HOME: home, CYCLER_CONFIG: cfgPath,
      CLAUDE_BIN: process.execPath,   // argv[0] 'claude' is rewritten to this
      DOUBLE_SCRIPT: scriptPath, DOUBLE_JOURNAL: journal,
      CLAUDE_PROJECT_DIR: home,
    },
  });
  const entries = readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const state = existsSync(join(home, 'processed.json')) ? JSON.parse(readFileSync(join(home, 'processed.json'), 'utf8')) : null;
  return { r, entries, state, repo, repoReal: realpathSync(repo), home,
    spawns: entries.filter((e) => e.kind === 'spawn'),
    comments: entries.filter((e) => e.op === 'comment'),
    issuesQueries: entries.filter((e) => e.op === 'issues'),
    oauth: entries.filter((e) => e.kind === 'oauth') };
}

// A config whose dispatch.command runs the fake claude instead of the real binary.
const dispatchCfg = (repoLine, extra = '') =>
  `${repoLine}\ndispatch:\n  command: claude ${FAKE} --workflow "{workflow}" --issue "{issue}" --title "{title}"\n${extra}`;

// ─── §1 Authentication ────────────────────────────────────────────────────────
t('1.4 an AUTHENTICATION_ERROR triggers exactly one refresh and one retry', () => {
  const p = poll({ script: { authErrorOnCalls: [1], issues: [] } });
  assert.strictEqual(p.oauth.length, 1, `expected exactly one refresh, got ${p.oauth.length}`);
  assert.strictEqual(p.oauth[0].grant_type, 'refresh_token');
  const viewers = p.entries.filter((e) => e.op === 'viewer');
  assert.strictEqual(viewers.length, 2, 'the failed query must be retried exactly once');
  assert.match(viewers[1].auth, /refreshed-token/, 'the retry must use the NEW token');
});

t('1.4 a second AUTHENTICATION_ERROR is not retried again (no refresh loop)', () => {
  const p = poll({ script: { authErrorOnCalls: [1, 2], issues: [] } });
  assert.strictEqual(p.oauth.length, 1, 'the poller must refresh once, not in a loop');
  assert.notStrictEqual(p.r.status, 0, 'a persistently failing auth must exit non-zero');
});

t('1.5 a refresh response omitting refresh_token MERGES, keeping the old one', () => {
  const p = poll({
    script: { authErrorOnCalls: [1], issues: [], tokenResponses: [{ access_token: 'new-tok', expires_in: 86399 }] },
  });
  const tok = JSON.parse(readFileSync(join(p.home, 'token.json'), 'utf8'));
  assert.strictEqual(tok.access_token, 'new-tok', 'the new access token must be stored');
  assert.strictEqual(tok.refresh_token, 'refresh-1',
    'the refresh_token was DROPPED — the next refresh becomes impossible and the poller dies in 24h');
});

// ─── §2 Selection ─────────────────────────────────────────────────────────────
t('2.1 issues are selected by delegate, never assignee', () => {
  // The trap that wastes the most time: assigning is a different field that looks correct in the UI
  // and dispatches nothing. Asserted on the wire, because this is the one place it is observable.
  const p = poll({ script: { issues: [] } });
  const q = p.issuesQueries[0].query;
  assert.match(q, /delegate:\s*\{\s*id:\s*\{\s*eq:/, 'the issue filter is not on delegate');
  assert.doesNotMatch(q, /assignee/, 'the query filters on assignee — which dispatches nothing');
});

// Both directions on purpose: a poller that dispatched NOTHING would pass "completed is skipped".
t('2.2 a completed issue is skipped and a started one is dispatched', () => {
  const done = poll({ script: { issues: [issue({ stateType: 'completed' })] }, cfg: dispatchCfg });
  assert.strictEqual(done.spawns.length, 0, 'a completed issue was dispatched');
  const canceled = poll({ script: { issues: [issue({ stateType: 'canceled' })] }, cfg: dispatchCfg });
  assert.strictEqual(canceled.spawns.length, 0, 'a canceled issue was dispatched');
  const live = poll({ script: { issues: [issue({ stateType: 'started' })] }, cfg: dispatchCfg });
  assert.strictEqual(live.spawns.length, 1, 'a started issue was NOT dispatched — the skip is unconditional');
});

t('2.3 an issue already in processed.json is not dispatched again', () => {
  const p = poll({ script: { issues: [issue({ id: 'uuid-9' })] }, processed: ['uuid-9'], cfg: dispatchCfg });
  assert.strictEqual(p.spawns.length, 0, 'a processed issue was dispatched a second time');
  assert.strictEqual(p.comments.length, 0, 'a processed issue was commented on again');
});

t('2.4 a FAILED dispatch is not marked processed, so it retries next poll', () => {
  const p = poll({ script: { issues: [issue()] }, cfg: dispatchCfg, env: { FAKE_CLAUDE_EXIT: '1' } });
  assert.strictEqual(p.spawns.length, 1, 'the dispatch never happened');
  assert.ok(!(p.state || []).includes('uuid-1'),
    'a failed dispatch was marked processed — the issue will never be retried');
});

t('2.4 (other direction) a SUCCESSFUL dispatch IS marked processed', () => {
  const p = poll({ script: { issues: [issue()] }, cfg: dispatchCfg });
  assert.deepStrictEqual(p.state, ['uuid-1'], 'a successful dispatch was not recorded, so it will re-dispatch');
});

// ─── §3 Routing ───────────────────────────────────────────────────────────────
t('3.4 CYCLER_WORKFLOW overrides all routing, including a matching label', () => {
  const cfg = (repo) => dispatchCfg(repo, 'routes:\n  default: /cycler:task\n  byLabel:\n    - label: research\n      workflow: /cycler:research\n');
  const routed = poll({ script: { issues: [issue({ labels: ['research'] })] }, cfg });
  assert.match(routed.spawns[0].argv.join(' '), /\/cycler:research/, 'the label route did not apply');
  const forced = poll({ script: { issues: [issue({ labels: ['research'] })] }, cfg, env: { CYCLER_WORKFLOW: '/forced' } });
  assert.match(forced.spawns[0].argv.join(' '), /\/forced/, 'CYCLER_WORKFLOW did not override the label route');
});

t('3.5 the chosen route AND the reason appear in the dispatch comment', () => {
  const cfg = (repo) => dispatchCfg(repo, 'routes:\n  byLabel:\n    - label: research\n      workflow: /cycler:research\n      why: decision, not a diff\n');
  const p = poll({ script: { issues: [issue({ labels: ['research'] })] }, cfg });
  const body = p.comments[0].variables.body;
  assert.match(body, /\/cycler:research/, 'the comment does not name the route');
  assert.match(body, /decision, not a diff/, 'the comment does not give the REASON for the route');
});

// ─── §4 Dispatch ──────────────────────────────────────────────────────────────
t('4.3 a hostile issue title cannot introduce an argument', () => {
  // The real attack surface: title is attacker-influenced text in any shared workspace.
  const title = '"; rm -rf / #  $(whoami)  `id`  --dangerously-skip-permissions';
  const p = poll({ script: { issues: [issue({ title })] }, cfg: dispatchCfg });
  const argv = p.spawns[0].argv;
  assert.ok(argv.includes(title), 'the title must arrive as ONE argument, intact');
  assert.strictEqual(argv.filter((a) => a === '--dangerously-skip-permissions').length, 0,
    'the title split into extra argv entries — an issue title can inject a flag');
});

t('4.5 the session id is parsed out of the `backgrounded · <id>` line', () => {
  const p = poll({ script: { issues: [issue()] }, cfg: dispatchCfg });
  assert.match(p.comments[0].variables.body, /sess-abc123/, 'the session id never reached the comment');
});

t('4.6 the dispatched session runs in repo.path', () => {
  const p = poll({ script: { issues: [issue()] }, cfg: dispatchCfg });
  assert.strictEqual(p.spawns[0].cwd, p.repoReal, `dispatched in ${p.spawns[0].cwd}, not repo.path`);
});

// ─── §5 Reporting ─────────────────────────────────────────────────────────────
t('5.1 every dispatch posts a comment with the session id, route and reason', () => {
  const p = poll({ script: { issues: [issue()] }, cfg: dispatchCfg });
  assert.strictEqual(p.comments.length, 1, 'no dispatch comment was posted');
  const b = p.comments[0].variables.body;
  assert.match(b, /sess-abc123/); assert.match(b, /Route:/); assert.match(b, /cycler:task/);
});

t('5.2 a FAILED dispatch posts a comment too', () => {
  const p = poll({ script: { issues: [issue()] }, cfg: dispatchCfg, env: { FAKE_CLAUDE_EXIT: '3' } });
  assert.strictEqual(p.comments.length, 1, 'a failed dispatch posted nothing — indistinguishable from never seeing the issue');
  assert.match(p.comments[0].variables.body, /Dispatch failed/);
});

t('5.3 the poller writes no issue status — that is the workflow\'s job (ADR 0005)', () => {
  const p = poll({ script: { issues: [issue()] }, cfg: dispatchCfg });
  const mutations = p.entries.filter((e) => e.kind === 'graphql' && /mutation/.test(e.query || ''));
  for (const m of mutations) {
    assert.doesNotMatch(m.query, /issueUpdate|stateId|workflowState/,
      'the poller performed a status write; ADR 0005 gives those to the workflow');
  }
});

// ─── Failure modes ────────────────────────────────────────────────────────────
t('a comment failure after a successful spawn must not cause a re-dispatch', () => {
  const p = poll({ script: { issues: [issue()], commentFails: true }, cfg: dispatchCfg });
  assert.strictEqual(p.spawns.length, 1, 'precondition: the session WAS spawned');
  assert.ok((p.state || []).includes('uuid-1'),
    'the session was spawned but the issue is NOT marked processed: the next poll spawns a SECOND session on the same issue and branch');
});

t('a missing repo.path fails each issue with a comment, and never silences the poll', () => {
  // The bug was that the check threw from OUTSIDE the per-issue try, so it escaped poll() at the
  // first issue. Two issues, so "aborted the loop" and "handled each one" are distinguishable —
  // with one issue both behaviours look the same from the outside.
  const p = poll({
    script: { issues: [issue({ id: 'uuid-1', identifier: 'ABC-1' }), issue({ id: 'uuid-2', identifier: 'ABC-2' })] },
    cfg: () => dispatchCfg('repo:\n  path: /nonexistent/repo\n'),
  });
  assert.strictEqual(p.comments.length, 2,
    `only ${p.comments.length} of 2 issues was told anything — the poll aborted mid-loop and the rest sit delegated in silence`);
  for (const c of p.comments) assert.match(c.variables.body, /Dispatch failed/);
  assert.ok(!(p.state || []).length, 'an issue that never dispatched was marked processed');
});

process.exit(fails ? 1 : 0);
