// The Workflow runtime is not Node module scope.
//
// It exposes `args`, `agent`, `parallel`, `pipeline`, `log`, `phase` and `budget` — and nothing
// else. `process` is not among them. task-orchestration.js nevertheless opened with:
//
//   const repoRoot = args?.cwd || process.cwd()
//   const PLUGIN_ROOT = args?.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT || '.'
//
// so any invocation that did not pass BOTH args died with `process is not defined` on the script's
// first executable line, before a single stage dispatched. The /cycler:task skill passed neither.
// Four consecutive unattended dispatches of APL-60 left no branch and no PR, and the poller — which
// marks an issue processed the moment the session spawns — reported all four as fine.
//
// It survived 29 test files because the simulator was a plain Node AsyncFunction, so every Node
// global leaked in: the sim was strictly MORE permissive than production, and green meant nothing
// about this line. sim.mjs now shadows those globals, which is the fix that makes the rest real.
//
// Both directions matter here. Asserting only "the workflow throws without cwd" would still pass if
// someone reintroduced a `process` fallback further down; asserting only "no `process.` in the
// source" would pass against a workflow that silently guessed a checkout. So: both.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { run } from './sim.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let fails = 0;
const t = async (n, fn) => { try { await fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

const wf = readFileSync(join(ROOT, 'workflows/task-orchestration.js'), 'utf8');
const skill = readFileSync(join(ROOT, 'skills/task/SKILL.md'), 'utf8');

// Strip comments before looking for `process` — the file explains this trap in prose, and a naive
// grep would match its own explanation and pass forever.
const code = wf.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

await t('the workflow never touches a Node global the runtime does not provide', () => {
  for (const g of ['process', 'require', '__dirname', '__filename']) {
    const hit = new RegExp(`(^|[^.\\w])${g}\\b`).exec(code);
    assert.ok(!hit, `workflow references \`${g}\`, which does not exist in the Workflow runtime`);
  }
});

await t('a run with no cwd fails loudly, naming the missing arg', async () => {
  await assert.rejects(
    () => run({ noDefaults: true, args: { pluginRoot: '/p', task: 'x' }, responder: async () => null }),
    /args\.cwd is required/
  );
});

await t('a run with no pluginRoot fails loudly, naming the missing arg', async () => {
  await assert.rejects(
    () => run({ noDefaults: true, args: { cwd: '/r', task: 'x' }, responder: async () => null }),
    /args\.pluginRoot is required/
  );
});

// The check that could have gone red on the real bug: the skill is the only caller in a dispatched
// run, and it passed neither arg.
await t('the /task skill passes every arg the workflow requires', () => {
  const block = skill.slice(skill.indexOf('Workflow({'), skill.indexOf('}})'));
  assert.ok(block.length > 50, 'could not find the Workflow({...}) invocation in skills/task/SKILL.md');
  for (const k of ['cwd:', 'pluginRoot:', 'config:']) {
    assert.ok(block.includes(k), `skills/task/SKILL.md does not pass \`${k.slice(0, -1)}\``);
  }
});

// A green simulator is only evidence if it can go red the way production does.
await t('the simulator withholds the Node globals production withholds', () => {
  const sim = readFileSync(join(ROOT, 'harness/tests/sim.mjs'), 'utf8');
  const absent = /const ABSENT = \[([^\]]*)\]/.exec(sim);
  assert.ok(absent, 'sim.mjs no longer shadows Node globals — every workflow test is now weaker than production');
  for (const g of ['process', 'require', '__dirname']) {
    assert.ok(absent[1].includes(`'${g}'`), `sim.mjs does not shadow \`${g}\``);
  }
});

process.exit(fails ? 1 : 0);
