// APL-74 and APL-78 both died three times on 2026-09-07, always within three seconds of each
// other. The cause was not an expired login: the CLI's refresh token ROTATES, so of two sessions
// started against a stale access token one refreshes and the other presents a token that has
// already been spent. "OAuth session expired and could not be refreshed" is what the loser prints.
//
// The rule these cases hold down: when the credential is stale, one poll dispatches ONE issue, so
// exactly one process refreshes. When it is fresh, nobody refreshes and the poll is unrestricted.
// Both directions are asserted — a budget that always returned 1 would serialise every dispatch
// forever, and one that always returned Infinity is the bug this file exists for.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
const { dispatchBudget, readClaudeExpiry, shouldAnnounceExpiry } = await import(POLLER + '?race=1');

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message); } };

const NOW = 1_800_000_000_000;
const SKEW = 60_000;

t('a fresh credential does not restrict the poll', () => {
  assert.strictEqual(dispatchBudget(NOW + 8 * 3600_000, NOW, SKEW), Infinity);
});

t('an expired credential lets exactly one issue out, so one process refreshes', () => {
  assert.strictEqual(dispatchBudget(NOW - 1, NOW, SKEW), 1);
});

t('a credential expiring INSIDE the skew is already treated as stale', () => {
  // The window matters: a token with 20s left expires between the first session starting and the
  // second one authenticating, which is the race again with extra steps.
  assert.strictEqual(dispatchBudget(NOW + 20_000, NOW, SKEW), 1);
  assert.strictEqual(dispatchBudget(NOW + SKEW + 1, NOW, SKEW), Infinity);
});

t('an unreadable access expiry yields NO budget — "cannot tell" is not safe', () => {
  // This used to fail open. On 2026-09-23 the keychain read back expiresAt 0 after a session exited
  // mid-refresh, the account was logged out, and failing open sent six sessions to die on
  // "Login expired". See credentialPreflight for the whole rule; this is the access-token half.
  for (const v of [null, undefined, NaN, 'soon']) {
    assert.strictEqual(dispatchBudget(v, NOW, SKEW), 0, `budget was not zero for ${String(v)}`);
  }
});

t('the expiry is read out of the credential JSON', () => {
  const at = NOW + 3600_000;
  assert.strictEqual(readClaudeExpiry(() => JSON.stringify({ claudeAiOauth: { expiresAt: at } })), at);
});

t('every unusable credential shape reads as unknown rather than throwing', () => {
  // A throw here escapes poll() and kills the whole poll — every delegated issue then sits in
  // silence, which is indistinguishable from the agent never having seen it.
  const cases = {
    'not json': () => '<!DOCTYPE html>',
    'empty': () => '',
    'null read': () => null,
    'reader throws': () => { throw new Error('keychain locked'); },
    'no oauth key': () => JSON.stringify({ other: 1 }),
    'expiry not a number': () => JSON.stringify({ claudeAiOauth: { expiresAt: 'tomorrow' } }),
  };
  for (const [name, read] of Object.entries(cases)) {
    assert.strictEqual(readClaudeExpiry(read), null, `${name} did not read as unknown`);
  }
});

t('an unusable credential read composes into no budget', () => {
  assert.strictEqual(dispatchBudget(readClaudeExpiry(() => 'garbage'), NOW, SKEW), 0);
});

t('poll() actually spends the budget — the pure function is wired in', () => {
  // The cases above all exercise dispatchBudget directly, and every one of them stays green if
  // poll() ignores what it returns. That is the shape of bug this repo keeps finding: a correct
  // check nothing consults. This reads the loop instead, which is weaker than driving a poll but
  // is the assertion that goes red when the wiring is cut.
  const src = readFileSync(POLLER.replace(/^file:\/\//, ''), 'utf8');
  const loop = /const processed = new Set\(loadJson\(STATE_PATH[\s\S]*?\n  }\n\n  if \(changed\)/.exec(src);
  assert.ok(loop, 'the dispatch loop was not found — this test is asserting nothing');
  assert.match(src, /const pre = credentialPreflight\(/, 'poll() never runs the pre-flight');
  assert.match(src, /const credBudget = pre\.budget;/, 'poll() ignores what the pre-flight decided');
  assert.match(loop[0], /Math\.min\(credBudget,/, 'the dispatch loop never consults the credential budget');
  assert.match(loop[0], /if\s*\(budget\s*<=\s*0\)\s*break/, 'poll() never stops when the budget runs out');
  assert.match(loop[0], /budget\s*-=\s*1/, 'poll() never spends the budget, so the limit can never be reached');
});

// The notice this state prints used to go out on EVERY poll — 1081 copies in poller.log — and it
// read like a demand to re-login, which was never the fix: the CLI refreshes the token itself. One
// episode is one expiresAt value, so it is announced once and again only after a real refresh.
t('the near-expiry notice is announced once per token, not once per poll', () => {
  let store = {};
  const read = () => store;
  const write = (v) => { store = v; };
  assert.strictEqual(shouldAnnounceExpiry(NOW, read, write), true, 'the first poll must report it');
  assert.strictEqual(shouldAnnounceExpiry(NOW, read, write), false, 'the second poll must stay quiet');
  assert.strictEqual(shouldAnnounceExpiry(NOW, read, write), false);
  // A refreshed token is a new episode and may be reported again.
  assert.strictEqual(shouldAnnounceExpiry(NOW + 8 * 3600_000, read, write), true);
});

t('an unreadable notice file cannot silence or crash the poll', () => {
  const boom = () => { throw new Error('unwritable'); };
  assert.strictEqual(shouldAnnounceExpiry(NOW, () => ({}), boom), true);
  assert.strictEqual(shouldAnnounceExpiry(null, () => ({}), boom), false, 'an unknown expiry is not an episode');
});

t('the notice no longer calls the credential stale or asks for a login', () => {
  // The wording is the whole point of the change: a self-healing state must not read as a task.
  const src = readFileSync(POLLER.replace(/^file:\/\//, ''), 'utf8');
  const line = /log\('claude access token expires shortly[\s\S]*?\);/.exec(src);
  assert.ok(line, 'the near-expiry notice was not found');
  assert.match(line[0], /No action needed/, 'the notice must say it needs nothing from a human');
  assert.doesNotMatch(src, /credential is stale/, 'the misleading wording is back');
});

t('the notice is gated on the once-per-episode check', () => {
  const src = readFileSync(POLLER.replace(/^file:\/\//, ''), 'utf8');
  assert.match(src, /credBudget === 1 && shouldAnnounceExpiry\(expiresAt\)/,
    'poll() logs the notice without consulting shouldAnnounceExpiry');
});

process.exit(fails ? 1 : 0);
