// Slash commands are the ONLY user interface, and a command name only exists in prose — there is no
// import to break and no compiler to notice. A rename that lands in commands/ but not in the README
// leaves a documented command that does not exist, which reads to a user exactly like a broken
// install.
//
// This caught the real shape of the problem once already: /cycler:setup, /cycler:start-polling and
// /cycler:stop-polling were collapsed into /cycler:start + /cycler:stop, and the old dispatch-one
// command had to move out of the way to /cycler:issue. Fourteen files named the old ones.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

const COMMANDS = ['doctor', 'issue', 'start', 'stop'];
const RETIRED = ['setup', 'start-polling', 'stop-polling', 'setup-linear'];

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.startsWith('harness/tests/'));

t('commands/ holds exactly the documented set', () => {
  const found = readdirSync(join(ROOT, 'commands')).filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepStrictEqual(found, COMMANDS);
});

t('no shipped file names a retired command', () => {
  const bad = [];
  for (const f of tracked) {
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8') } catch { continue }
    for (const name of RETIRED) {
      // The colon form is the only one that is unambiguously a command reference: "setup" as an
      // English word appears all over the prose and must not fail this.
      if (src.includes(`/cycler:${name}`)) bad.push(`${f}: /cycler:${name}`);
    }
  }
  assert.deepStrictEqual(bad, [], `these name a command that no longer exists:\n  ${bad.join('\n  ')}`);
});

t('every live command is reachable from the README table', () => {
  // The other direction: a command file nobody documents is one nobody runs.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const missing = COMMANDS.filter((c) => !readme.includes(`/cycler:${c}`));
  assert.deepStrictEqual(missing, [], `undocumented commands: ${missing.join(', ')}`);
});

t('start is the command that sets up AND starts polling', () => {
  // The whole point of the merge. If start.md stops loading launchd, "start" means nothing.
  const src = readFileSync(join(ROOT, 'commands/start.md'), 'utf8');
  assert.ok(/launchctl load/.test(src), '/cycler:start does not load the launchd job');
  assert.ok(/poller\.mjs" auth/.test(src), '/cycler:start does not run the OAuth authorisation');
  assert.ok(/launchctl list/.test(src), '/cycler:start never checks whether the job is already loaded');
});

process.exit(fails ? 1 : 0);
