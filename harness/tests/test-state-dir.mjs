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

// The same shape of failure, one rename later: cycler.yaml at the repo root plus
// ~/.cycler/config.json merged into ONE file at ~/.config/cycler/config.yaml. A shipped script still
// reading either old path finds nothing and falls back to defaults — repo.path becomes ~/your-repo
// and every delegated issue gets a "Dispatch failed" comment. Executable files only: the prose files
// mention the old layout on purpose, to say what it used to be.
const EXEC = tracked.filter((f) => /\.(mjs|js|sh)$/.test(f) || f.startsWith('poller/lin'));

// Comments are stripped first. Several of these files EXPLAIN the old layout on purpose — a stale
// path in prose is history, a stale path in code is a poller silently running on defaults. Grepping
// the raw text would force the explanations out, which is the wrong trade.
const codeOf = (f) => readFileSync(join(ROOT, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|\s)(\/\/|#).*$/, '$1'))
  .join('\n');

t('no shipped script reads config from either pre-merge location', () => {
  const bad = EXEC.filter((f) => /config\.json|cycler\.yaml/.test(codeOf(f)));
  assert.deepStrictEqual(bad, [], `these still read a pre-merge config path: ${bad.join(', ')}`);
});

t('the config resolver points at ~/.config/cycler, and the shell CLIs read through it', () => {
  const yaml = readFileSync(join(ROOT, 'lib/yaml.mjs'), 'utf8');
  assert.ok(/'\.config'\s*,\s*'cycler'/.test(yaml), 'lib/yaml.mjs no longer resolves ~/.config/cycler');
  assert.ok(/XDG_CONFIG_HOME/.test(yaml), 'lib/yaml.mjs ignores $XDG_CONFIG_HOME');
  // `lin` needs the OAuth credentials to refresh a token. Parsing YAML in bash would let it drift
  // from the poller; going through read-config.mjs is what makes them unable to disagree.
  const lin = readFileSync(join(ROOT, 'poller/lin'), 'utf8');
  assert.ok(/read-config\.mjs/.test(lin), 'poller/lin no longer reads the config through read-config.mjs');
  assert.ok(/linear\.client_id/.test(lin) && /linear\.client_secret/.test(lin),
    'poller/lin lost the credential keys — its 401 refresh path is dead and `lin` fails for 24h at a time');
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
