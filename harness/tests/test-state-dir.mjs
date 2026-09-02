// Every shipped script must agree on where cycler keeps its state, and must honour CYCLER_HOME.
//
// This exists because they did not. The poller was migrated from ~/.linear-claude to ~/.cycler and
// the two bundled shell CLIs were not: `lin` and `lin-delegate` kept reading a token.json in the old
// directory. Nothing caught it — the old directory still existed on the machine that made the
// change, so both kept working there and would have failed for every user on first use.
//
// A grep is a weak test in general. Here it is exactly the right shape: the failure was one literal
// path in two files, and no behavioural test would have run those files at all.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.startsWith('harness/tests/'));

t('no shipped file points at the pre-cycler state directory', () => {
  const bad = tracked.filter((f) => {
    try { return readFileSync(join(ROOT, f), 'utf8').includes('.linear-claude') } catch { return false }
  });
  assert.deepStrictEqual(bad, [], `these still read the old state dir: ${bad.join(', ')}`);
});

t('the shell CLIs honour CYCLER_HOME', () => {
  // Not just "says .cycler somewhere" — the override has to work, or a user with a non-default
  // home has a broken install and a confusing "No token" error.
  for (const f of ['poller/lin', 'poller/lin-delegate']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(/CYCLER_HOME/.test(src), `${f} ignores CYCLER_HOME`);
  }
});

t('the poller and the shell CLIs resolve the SAME directory', () => {
  const js = readFileSync(join(ROOT, 'poller/poller.mjs'), 'utf8');
  assert.ok(/CYCLER_HOME.*\.cycler|\.cycler.*CYCLER_HOME/s.test(js), 'poller.mjs lost its state dir');
  for (const f of ['poller/lin', 'poller/lin-delegate']) {
    assert.ok(readFileSync(join(ROOT, f), 'utf8').includes('.cycler'),
      `${f} does not default to ~/.cycler`);
  }
});

process.exit(fails ? 1 : 0);
