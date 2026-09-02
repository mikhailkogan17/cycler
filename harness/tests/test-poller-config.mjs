// The poller reads cycler.yaml. These cases exist because the CONFIGURED branch of routing was
// dead in every earlier test: with no config file present, `Array.isArray(cfg.routes?.byLabel)`
// short-circuits and the code after it never runs — which is how a plain ReferenceError shipped and
// was only found by an actual poll. A test that never loads a config cannot catch that.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const POLLER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'poller', 'poller.mjs');
let fails = 0;
const t = (n, fn) => fn().then(() => console.log('PASS', n),
  (e) => { fails++; console.log('FAIL', n, '\n  ', e.message) });

function withConfig(yaml) {
  const f = join(mkdtempSync(join(tmpdir(), 'cyclercfg-')), 'cycler.yaml');
  writeFileSync(f, yaml);
  process.env.CYCLER_CONFIG = f;
  return f;
}

const CONFIG = `
repo:
  path: ~/somewhere
routes:
  default: /custom:default
  byLabel:
    - label: research
      workflow: /custom:research
    - label: spike
      workflow: /custom:spike
`;

const f = withConfig(CONFIG);
const m = await import(POLLER + '?cfg=1');

await t('a configured byLabel route is used', async () => {
  const r = m.workflowFor({ identifier: 'A-1', labels: { nodes: [{ name: 'Research' }] } });
  assert.strictEqual(r.workflow, '/custom:research');
});

await t('a second configured route is used too — not just the first', async () => {
  const r = m.workflowFor({ identifier: 'A-2', labels: { nodes: [{ name: 'spike' }] } });
  assert.strictEqual(r.workflow, '/custom:spike');
});

await t('an unlabelled issue gets the configured default', async () => {
  const r = m.workflowFor({ identifier: 'A-3', labels: { nodes: [] } });
  assert.strictEqual(r.workflow, '/custom:default');
});

await t('the dispatch argv never contains --print', async () => {
  // --print conflicts with --background; claude exits 1 and it looks exactly like the agent never
  // saw the issue. This cost a week once.
  const argv = m.buildDispatchArgv({ identifier: 'A-4', title: 'x' }, '/custom:default', '[A-4] x');
  assert.ok(!argv.includes('--print'), `argv contains --print: ${argv.join(' ')}`);
  assert.ok(argv.includes('--background'), 'argv lost --background');
});

await t('a title with quotes and $ cannot introduce an argument', async () => {
  const before = m.buildDispatchArgv({ identifier: 'A-5', title: 'x' }, '/w', '[A-5] x').length;
  const after = m.buildDispatchArgv(
    { identifier: 'A-5', title: 'a" --dangerously-skip-permissions $(id) `x`' }, '/w', '[A-5] x').length;
  assert.strictEqual(after, before, 'a hostile title changed the argument count');
});

rmSync(dirname(f), { recursive: true, force: true });
// The case that would have caught all three of them.
//
// Renaming the module-level config object left three stale references — routes.byLabel, then
// routes.byLabel again, then dispatch.pathPrepend. Each was a plain ReferenceError, each crashed the
// poller at import time, and each survived a full green suite, because every test wrote a MINIMAL
// config that never reached the branch in question. The fix is not more unit cases: it is loading
// the shipped example, which exercises every key at once, and reading a value out of each.
await t('the shipped example config drives every config-derived value', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  process.env.CYCLER_CONFIG = join(here, '..', '..', 'cycler.example.yaml');
  const mod = await import(POLLER + '?example=1');

  const argv = mod.buildDispatchArgv({ identifier: 'ABC-1', title: 't' }, '/cycler:task', '[ABC-1] t');
  assert.ok(argv.length > 5, `dispatch argv collapsed: ${JSON.stringify(argv)}`);
  assert.ok(!argv.includes('--print'), '--print conflicts with --background');
  assert.ok(argv.includes('--background'), 'lost --background');
  assert.ok(argv.some((a) => a.includes('/cycler:task ABC-1')), 'the prompt never made it into argv');

  assert.strictEqual(mod.workflowFor({ identifier: 'ABC-2', labels: { nodes: [] } }).workflow, '/cycler:task');
  assert.strictEqual(
    mod.workflowFor({ identifier: 'ABC-3', labels: { nodes: [{ name: 'Research' }] } }).workflow,
    '/cycler:research');
});

process.exit(fails ? 1 : 0);
