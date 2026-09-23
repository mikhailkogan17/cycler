// Two guards against dispatching into a logged-out account, and the outcome line that reports them.
//
// 2026-09-23: the Claude credential read back `expiresAt: 0` after a session exited mid-refresh. The
// poller dispatched anyway, re-dispatched each dead session because it never posted a start marker,
// and six sessions each ended on one synthetic line, "Login expired · Please run /login". Every poll
// in that window logged `poll ok`. The fixtures below are those transcripts' real entries.
//
// Each guard is asserted in both directions: a classifier that called everything an auth failure
// would stop every retry, and a pre-flight that refused everything would stall the queue — both look
// exactly as green as a working one unless the healthy case is asserted too.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

process.env.CYCLER_HOME = mkdtempSync(join(tmpdir(), 'cycler-auth-'));
process.env.CYCLER_CONFIG = join(process.env.CYCLER_HOME, 'no-config.yaml');
const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
const { classifyAuthFailure, credentialPreflight, readClaudeCredential, shouldNotifyRefusal, pollProblems } =
  await import(POLLER + '?auth=1');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message); } };

const NOW = Date.parse('2026-09-23T16:37:00Z');
const SKEW = 60_000;
const HOUR = 3600_000;
const T = new Date(NOW + 1000).toISOString();
const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n');
const apiError = (text, error) => ({ type: 'assistant', isSidechain: false, isApiErrorMessage: true, error, timestamp: T,
  message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } });
const user = { type: 'user', timestamp: T, message: { role: 'user', content: '/cycler:workflow-feature APL-108' } };

// ─── the classifier ──────────────────────────────────────────────────────────────────────────
t('"Login expired · Please run /login" is an auth failure', () => {
  assert.strictEqual(classifyAuthFailure(jsonl(user, apiError('Login expired · Please run /login', 'authentication_failed'))),
    'Login expired');
});

t('"Please run /login" alone is an auth failure', () => {
  assert.ok(classifyAuthFailure(jsonl(user, apiError('Your session ended. Please run /login'))));
});

t('the mid-refresh failure is an auth failure', () => {
  const text = 'Could not refresh your login because another Claude Code process is refreshing it (or exited '
    + 'mid-refresh) · Try again in a minute; if it keeps happening, close other Claude Code windows or sign in again with /login';
  assert.strictEqual(classifyAuthFailure(jsonl(user, apiError(text, 'server_error'))),
    'Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh)');
});

t('a healthy transcript is not an auth failure', () => {
  const reply = { type: 'assistant', timestamp: T, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Reading the issue.' }] } };
  assert.strictEqual(classifyAuthFailure(jsonl(user, reply)), null);
});

t('a real reply that QUOTES the strings is not an auth failure', () => {
  // A session working on this very bug reads and writes "Login expired". It is alive.
  const reply = { type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: 'The poller must classify "Login expired · Please run /login".' }] } };
  assert.strictEqual(classifyAuthFailure(jsonl(user, reply)), null);
});

t('an auth failure from BEFORE the dispatch does not count, and sidechains do not count', () => {
  const old = { ...apiError('Login expired · Please run /login'), timestamp: new Date(NOW - HOUR).toISOString() };
  assert.strictEqual(classifyAuthFailure(jsonl(old), NOW), null);
  assert.strictEqual(classifyAuthFailure(jsonl({ ...apiError('Login expired'), isSidechain: true })), null);
});

t('the refresh-race loser stays retryable — the winner leaves a good credential', () => {
  assert.strictEqual(classifyAuthFailure(jsonl(apiError('OAuth session expired and could not be refreshed'))), null);
});

t('an empty or garbage transcript is not an auth failure and does not throw', () => {
  for (const v of ['', null, undefined, 'not json\n{', '{}']) assert.strictEqual(classifyAuthFailure(v), null);
});

// ─── the pre-flight ──────────────────────────────────────────────────────────────────────────
const cred = (o) => ({ hasRefresh: true, refreshExpiresAt: NOW + 30 * 24 * HOUR, ...o });

t('valid and far in the future: dispatches without limit', () => {
  assert.deepStrictEqual(credentialPreflight(cred({ expiresAt: NOW + 8 * HOUR }), NOW, SKEW), { budget: Infinity });
});

t('expired, and the refresh token cannot renew it: refuses', () => {
  for (const c of [cred({ expiresAt: NOW - HOUR, refreshExpiresAt: NOW - 1 }),
    cred({ expiresAt: NOW - HOUR, hasRefresh: false }),
    cred({ expiresAt: NOW - HOUR, refreshExpiresAt: null })]) {
    const r = credentialPreflight(c, NOW, SKEW);
    assert.strictEqual(r.budget, 0, JSON.stringify(c)); assert.match(r.refuse, /cannot be renewed/);
  }
});

t('missing expiry: refuses', () => {
  for (const c of [null, cred({ expiresAt: null }), cred({ expiresAt: undefined }), cred({ expiresAt: NaN })]) {
    const r = credentialPreflight(c, NOW, SKEW);
    assert.strictEqual(r.budget, 0); assert.match(r.refuse, /unreadable/);
  }
});

t('epoch-zero expiry: refuses — the 1970-01-01 case', () => {
  const r = credentialPreflight(cred({ expiresAt: 0 }), NOW, SKEW);
  assert.strictEqual(r.budget, 0);
  assert.match(r.refuse, /unreadable \(1970-01-01/);
  // Seconds where milliseconds belong lands in 1970 too.
  assert.strictEqual(credentialPreflight(cred({ expiresAt: Math.floor((NOW + HOUR) / 1000) }), NOW, SKEW).budget, 0);
});

t('expiring inside the skew with no usable refresh token: refuses', () => {
  const r = credentialPreflight(cred({ expiresAt: NOW + 20_000, refreshExpiresAt: NOW + 20_000 }), NOW, SKEW);
  assert.strictEqual(r.budget, 0);
});

t('a stale access token with a live refresh token lets ONE issue out, so exactly one process refreshes', () => {
  // Not a refusal. APL-97/98 went out on 2026-09-16 against an access token 13h stale and both ran:
  // the CLI renews it itself. Refusing here would stall the queue every 8 hours.
  assert.deepStrictEqual(credentialPreflight(cred({ expiresAt: NOW - 13 * HOUR }), NOW, SKEW), { budget: 1 });
  assert.deepStrictEqual(credentialPreflight(cred({ expiresAt: NOW + 20_000 }), NOW, SKEW), { budget: 1 });
});

t('a hold on the current credential refuses; a changed credential releases it', () => {
  const at = NOW + 8 * HOUR;
  const held = credentialPreflight(cred({ expiresAt: at }), NOW, SKEW, { expiresAt: at, reason: 'Login expired' });
  assert.strictEqual(held.budget, 0); assert.match(held.refuse, /died logged out \(Login expired\)/);
  assert.strictEqual(credentialPreflight(cred({ expiresAt: at }), NOW, SKEW, { expiresAt: at - HOUR }).budget, Infinity);
});

t('the credential read keeps expiries and nothing else', () => {
  const c = readClaudeCredential(() => JSON.stringify({ claudeAiOauth:
    { accessToken: 'sk-secret', refreshToken: 'rt-secret', expiresAt: 5e12, refreshTokenExpiresAt: 6e12 } }));
  assert.deepStrictEqual(c, { expiresAt: 5e12, refreshExpiresAt: 6e12, hasRefresh: true });
  assert.doesNotMatch(JSON.stringify(c), /secret/);
  assert.strictEqual(readClaudeCredential(() => { throw new Error('locked'); }), null);
});

// ─── noise control and the outcome line ──────────────────────────────────────────────────────
t('a refusal notifies once per episode, and again after a healthy poll', () => {
  let store = {};
  const r = () => store; const w = (v) => { store = v; };
  assert.strictEqual(shouldNotifyRefusal('logged out', r, w), true);
  assert.strictEqual(shouldNotifyRefusal('logged out', r, w), false, 'notified on every poll');
  assert.strictEqual(shouldNotifyRefusal(null, r, w), false, 'a healthy poll must not notify');
  assert.strictEqual(shouldNotifyRefusal('logged out', r, w), true, 'a new episode stayed silent');
});

t('a poll is degraded when it refused or found dead sessions, and ok only when it did neither', () => {
  const none = { dead: [], authDead: [] };
  assert.deepStrictEqual(pollProblems({ budget: Infinity }, none), []);
  assert.match(pollProblems({ budget: 0, refuse: 'x' }, none)[0], /not dispatching, x — run \/login/);
  assert.match(pollProblems({ budget: 1 }, { dead: [], authDead: [{ identifier: 'APL-108' }] })[0], /APL-108 died logged out/);
  assert.match(pollProblems({ budget: 1 }, { dead: [{ identifier: 'APL-103', giveUp: true }], authDead: [] })[0], /APL-103 \(gave up\)/);
});

process.exit(fails ? 1 : 0);
