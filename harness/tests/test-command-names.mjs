// Slash commands are the ONLY user interface, and a command name only exists in prose — there is no
// import to break and no compiler to notice. A rename that lands in commands/ but not in the README
// leaves a documented command that does not exist, which reads to a user exactly like a broken
// install.
//
// Two sets share one `/cycler:` namespace and are NOT interchangeable:
//   commands/  — verbs the user runs:  start, stop, delegate, doctor
//   skills/    — workflows a dispatched session runs, prefixed `workflow-`
// The prefix is the whole distinction. Before it, `/cycler:issue` (a trigger) and `/cycler:task`
// (a workflow) sat side by side in the same list with nothing to tell them apart, and the first
// question anyone asked was why both existed. A prefix rather than a suffix because it also sorts
// and filters: typing `/cycler:workflow` narrows to exactly the things the user does not run.
// `cycler:workflow:feature` would say it better and is not available — a skill name may hold only
// letters, digits, underscores and hyphens, and the one `cycler:` is the plugin namespace.
//
// This file caught the real shape of the problem once already: /cycler:setup, /cycler:start-polling
// and /cycler:stop-polling collapsed into /cycler:start + /cycler:stop, and fourteen files named the
// old ones.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

const COMMANDS = ['delegate', 'doctor', 'start', 'stop'];
const WORKFLOWS = ['workflow-bug', 'workflow-feature', 'workflow-intake', 'workflow-research'];
// workflow-bug is an ALIAS: the Bug label needs a route of its own, the lifecycle behind it does not.
const ALIASES = { 'workflow-bug': 'workflow-feature' };
const RETIRED = ['setup', 'start-polling', 'stop-polling', 'setup-linear', 'issue', 'task', 'research', 'intake'];

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.startsWith('harness/tests/'));

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const dirsIn = (d) => readdirSync(join(ROOT, d)).filter((f) => statSync(join(ROOT, d, f)).isDirectory());

t('commands/ holds exactly the documented set', () => {
  const found = readdirSync(join(ROOT, 'commands')).filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepStrictEqual(found, COMMANDS);
});

t('skills/ holds exactly the documented workflows', () => {
  assert.deepStrictEqual(dirsIn('skills').sort(), WORKFLOWS);
});

t('every workflow is prefixed, and no command is', () => {
  // The prefix IS the interface. A workflow without it reads as a verb the user should run; a
  // command with it reads as something the session runs on its own.
  const unprefixed = dirsIn('skills').filter((d) => !d.startsWith('workflow-'));
  assert.deepStrictEqual(unprefixed, [], `workflows missing the workflow- prefix: ${unprefixed.join(', ')}`);
  const prefixed = COMMANDS.filter((c) => c.startsWith('workflow-'));
  assert.deepStrictEqual(prefixed, [], `commands wearing the workflow prefix: ${prefixed.join(', ')}`);
});

t('every name Claude Code will accept as a skill', () => {
  // `cycler:workflow:feature` reads better and does not exist: the name is validated against
  // letters, digits, underscores and hyphens, so the only colon available is the plugin's own.
  // Discovering that after publishing means renaming a command users have already learned.
  for (const n of [...COMMANDS, ...WORKFLOWS]) {
    assert.match(n, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, `${n} is not a name Claude Code will load`);
  }
});

t("a skill's directory name is the name it is invoked by", () => {
  // The slash command comes from the frontmatter `name:`, not the directory. They drifted once
  // already, and a skill dispatched by the config's name then does not exist.
  for (const d of dirsIn('skills')) {
    const fm = /^name:\s*(\S+)\s*$/m.exec(readFileSync(join(ROOT, 'skills', d, 'SKILL.md'), 'utf8'));
    assert.ok(fm, `skills/${d}/SKILL.md has no name: in its frontmatter`);
    assert.strictEqual(fm[1], d, `skills/${d} is invoked as /cycler:${fm[1]}`);
  }
});

t('no shipped file names a retired command', () => {
  const bad = [];
  for (const f of tracked) {
    let src;
    try { src = readFileSync(join(ROOT, f), 'utf8') } catch { continue }
    for (const name of RETIRED) {
      // The colon form is the only one that is unambiguously a command reference: "setup" as an
      // English word appears all over the prose and must not fail this. The trailing boundary
      // matters as much — without it, retired `research` matches live `/cycler:workflow-research`.
      if (new RegExp(`/cycler:${name}(?![\\w-])`).test(src)) bad.push(`${f}: /cycler:${name}`);
    }
  }
  assert.deepStrictEqual(bad, [], `these name a command that no longer exists:\n  ${bad.join('\n  ')}`);
});

t('every live command is reachable from the README table', () => {
  // The other direction: a command file nobody documents is one nobody runs.
  const missing = COMMANDS.filter((c) => !readme.includes(`/cycler:${c}`));
  assert.deepStrictEqual(missing, [], `undocumented commands: ${missing.join(', ')}`);
});

t('every workflow is documented too, and separately from the commands', () => {
  const missing = WORKFLOWS.filter((w) => !readme.includes(`/cycler:${w}`));
  assert.deepStrictEqual(missing, [], `undocumented workflows: ${missing.join(', ')}`);
  // A single merged list is the state this rename existed to leave. The README has to keep saying,
  // in words, that one set is run by the user and the other by the dispatched session.
  assert.ok(/inside the dispatched\s+session/i.test(readme),
    'the README never says the workflows run inside the dispatched session');
});

t('every workflow the shipped config routes to exists', () => {
  // A route naming a workflow that was renamed away dispatches a slash command with nothing behind
  // it — the session starts, finds no skill, and improvises. Silent, and expensive.
  const yaml = readFileSync(join(ROOT, 'cycler.example.yaml'), 'utf8');
  const routed = [...yaml.matchAll(/^\s*\w+:\s*(\/cycler:[\w-]+)/gm)].map((m) => m[1]);
  assert.ok(routed.length >= 2, 'no workflow routes found in cycler.example.yaml');
  const unknown = routed.filter((r) => !WORKFLOWS.includes(r.replace('/cycler:', '')));
  assert.deepStrictEqual(unknown, [], `routes to a workflow that does not exist: ${unknown.join(', ')}`);
});

t('an alias delegates rather than copying the workflow it aliases', () => {
  // Two copies of the lifecycle is the failure this alias exists to avoid. The copy that drifts is
  // the one nobody runs interactively, so it drifts silently and a user finds it.
  for (const [alias, target] of Object.entries(ALIASES)) {
    const a = readFileSync(join(ROOT, 'skills', alias, 'SKILL.md'), 'utf8');
    const t = readFileSync(join(ROOT, 'skills', target, 'SKILL.md'), 'utf8');
    assert.ok(a.includes(`skills/${target}/SKILL.md`),
      `skills/${alias} never tells the session to read ${target}`);
    assert.ok(a.length < t.length / 2,
      `skills/${alias} is ${a.length} chars against ${target}'s ${t.length} — that is a copy, not an alias`);
  }
});

t('start is the command that sets up AND starts polling', () => {
  // The whole point of the merge. If start.md stops loading launchd, "start" means nothing.
  const src = readFileSync(join(ROOT, 'commands/start.md'), 'utf8');
  assert.ok(/launchctl load/.test(src), '/cycler:start does not load the launchd job');
  assert.ok(/poller\.mjs" auth/.test(src), '/cycler:start does not run the OAuth authorisation');
  assert.ok(/launchctl list/.test(src), '/cycler:start never checks whether the job is already loaded');
});

t('delegate is the command that puts the issue on the agent and polls', () => {
  // Renamed from /cycler:issue because "issue" is a noun: it named the object, not the act, and
  // gave no hint that it does the same thing as assigning on the board.
  const src = readFileSync(join(ROOT, 'commands/delegate.md'), 'utf8');
  assert.ok(/lin-delegate/.test(src), '/cycler:delegate never puts the issue on the agent');
  assert.ok(/poller\.mjs/.test(src), '/cycler:delegate never forces a poll');
});

process.exit(fails ? 1 : 0);
