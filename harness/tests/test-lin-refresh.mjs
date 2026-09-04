// `lin` refreshes its token only when it recognises an auth failure in the CLI's output. That
// recognition is a grep, and the grep did not match what Linear actually says.
//
// The real message is "You need to authenticate to access this operation." The pattern looked for
// "not authenticated", "AUTHENTICATION_ERROR" or "No API key configured" — none of which appear in
// it. So 24 hours after auth, every `lin` call failed, the refresh branch never ran, and the token
// sat one HTTP request away from working. The poller was unaffected (it matches on the GraphQL error
// code), so the board kept moving while every harness read and write through `lin` was dead.
//
// A recovery path that cannot trigger is the same defect as a check that cannot fail: it reports
//健康 by never running. These cases pin the strings, because the strings are the whole mechanism.
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIN = join(HERE, '..', '..', 'poller', 'lin');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };
const assert = (c, m) => { if (!c) throw new Error(m) };

const src = readFileSync(LIN, 'utf8');

// Every phrasing observed from the Linear CLI / API for an expired or absent token.
const AUTH_FAILURES = [
  'You need to authenticate to access this operation.',   // what it actually says — the one that broke
  'Error: not authenticated',
  'AUTHENTICATION_ERROR',
  'No API key configured',
];

check('the refresh trigger matches every known auth-failure phrasing', () => {
  // Pull the pattern out of the script and test it the way the script uses it, so the test cannot
  // drift from the implementation into asserting its own copy of the regex.
  const m = src.match(/grep -qiE '([^']+)'/);
  assert(m, 'could not find the auth-failure grep in poller/lin');
  const pattern = m[1];
  for (const msg of AUTH_FAILURES) {
    const hit = execFileSync('bash', ['-c',
      `printf '%s' ${JSON.stringify(msg)} | grep -qiE ${JSON.stringify(pattern)} && echo yes || echo no`],
      { encoding: 'utf8' }).trim();
    assert(hit === 'yes', `refresh would NOT trigger on: "${msg}"`);
  }
});

check('an unrelated failure does not trigger a refresh', () => {
  // The other direction. A pattern loose enough to match everything would pass the case above and
  // burn a refresh on every network blip, hiding the real error behind a second failure.
  const pattern = src.match(/grep -qiE '([^']+)'/)[1];
  for (const msg of ['Error: issue APL-999 not found', 'connect ECONNREFUSED', 'rate limit exceeded']) {
    const hit = execFileSync('bash', ['-c',
      `printf '%s' ${JSON.stringify(msg)} | grep -qiE ${JSON.stringify(pattern)} && echo yes || echo no`],
      { encoding: 'utf8' }).trim();
    assert(hit === 'no', `refresh would wrongly trigger on: "${msg}"`);
  }
});

check('a refreshed token is written 0600', () => {
  assert(/chmod 600 "\$TOKEN_PATH"/.test(src), 'lin does not chmod the token it writes');
});

check('the refresh merges rather than replaces', () => {
  // A refresh response may omit refresh_token; replacing would make the NEXT refresh impossible.
  assert(/jq -s '\.\[0\] \* \.\[1\]'/.test(src), 'lin replaces the token file instead of merging');
});

process.exit(fails ? 1 : 0);
