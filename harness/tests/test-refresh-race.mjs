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
const { dispatchBudget, readClaudeExpiry } = await import(POLLER + '?race=1');

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

t('an unreadable credential restricts NOTHING, rather than stalling the poller', () => {
  // Fail open. This process runs under launchd, and whether it can read the keychain is a property
  // of how it was started. Turning "cannot read" into "dispatch nothing" would convert a
  // permissions question into a silent stall, which is the failure mode this poller is built to
  // avoid everywhere else.
  for (const v of [null, undefined, NaN, 'soon']) {
    assert.strictEqual(dispatchBudget(v, NOW, SKEW), Infinity, `budget was limited for ${String(v)}`);
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

t('a stale credential plus an unusable read still cannot stall the poll', () => {
  // The two halves compose: unknown expiry -> no budget limit. Asserted together because each
  // half passing separately is what let the argument order bug survive in an earlier draft.
  assert.strictEqual(dispatchBudget(readClaudeExpiry(() => 'garbage'), NOW, SKEW), Infinity);
});

t('poll() actually spends the budget — the pure function is wired in', () => {
  // The cases above all exercise dispatchBudget directly, and every one of them stays green if
  // poll() ignores what it returns. That is the shape of bug this repo keeps finding: a correct
  // check nothing consults. This reads the loop instead, which is weaker than driving a poll but
  // is the assertion that goes red when the wiring is cut.
  const src = readFileSync(POLLER.replace(/^file:\/\//, ''), 'utf8');
  const loop = /const processed = new Set\(loadJson\(STATE_PATH[\s\S]*?\n  }\n\n  if \(changed\)/.exec(src);
  assert.ok(loop, 'the dispatch loop was not found — this test is asserting nothing');
  assert.match(loop[0], /=\s*dispatchBudget\(/, 'poll() never asks for a budget');
  assert.match(loop[0], /if\s*\(budget\s*<=\s*0\)\s*break/, 'poll() never stops when the budget runs out');
  assert.match(loop[0], /budget\s*-=\s*1/, 'poll() never spends the budget, so the limit can never be reached');
});

process.exit(fails ? 1 : 0);
