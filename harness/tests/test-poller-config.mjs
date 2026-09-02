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
process.exit(fails ? 1 : 0);
