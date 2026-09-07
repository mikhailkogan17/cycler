// The cycler config parser. Deliberately a subset — but the subset has to cover what the shipped
// example file actually uses, and it did not.
//
// `dispatch.command: >` is a folded block scalar. The parser returned the literal ">", so the poller
// would have spawned a process named ">" — for every user who copied the example unchanged, which is
// every user. Nothing caught it because every test until now wrote its own inline YAML.
//
// Hence the last case here: parse the shipped example itself, and assert the values are usable.
import { parseYaml, readConfig, get, configPath } from '../../lib/yaml.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

t('folded block scalars (>) join their lines into one string', () => {
  const c = parseYaml('a:\n  cmd: >\n    claude --background\n    --name "x"\nb: 1\n');
  assert.strictEqual(c.a.cmd, 'claude --background --name "x"');
  assert.strictEqual(c.b, 1, 'the key after the block was swallowed');
});

t('literal block scalars (|) keep their newlines', () => {
  const c = parseYaml('notes: |\n  line one\n  line two\nafter: 2\n');
  assert.strictEqual(c.notes, 'line one\nline two');
  assert.strictEqual(c.after, 2, 'the key after the block was swallowed');
});

t('a block scalar inside a list item works', () => {
  const c = parseYaml('steps:\n  - when: a/**\n    run: >\n      one\n      two\n    notes: ok\n');
  assert.strictEqual(c.steps[0].run, 'one two');
  assert.strictEqual(c.steps[0].notes, 'ok');
});

t('scalars, inline lists, block lists and nested maps', () => {
  const c = parseYaml('n: 8\nt: true\ns: "x"\ninline: [a, b]\nblock:\n  - p\n  - q\nm:\n  k: v\n');
  assert.deepStrictEqual([c.n, c.t, c.s, c.inline, c.block, c.m], [8, true, 'x', ['a','b'], ['p','q'], {k:'v'}]);
});

t('the shipped example parses into usable values', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  process.env.CYCLER_CONFIG = join(here, '..', '..', 'cycler.example.yaml');
  const c = readConfig();
  const cmd = c.dispatch?.command || '';
  assert.ok(cmd.startsWith('claude '), `dispatch.command is not a command: ${JSON.stringify(cmd)}`);
  assert.ok(cmd.includes('--background'), 'dispatch.command lost --background');
  assert.ok(!cmd.includes('--print'), '--print conflicts with --background and exits 1');
  assert.strictEqual(c.repo?.base, 'main');
  assert.ok(Array.isArray(c.dispatch?.path_prepend) && c.dispatch.path_prepend.length >= 2);
  // The credentials are in this file now, not a second config.json. If they stop parsing, the
  // poller cannot refresh a token and dies silently 24h after setup.
  assert.ok(c.linear?.client_id && c.linear?.client_secret, 'the example lost its linear credentials');
  assert.strictEqual(c.workflows?.default, '/cycler:workflow-feature');
  assert.strictEqual(c.workflows?.research, '/cycler:workflow-research');
});

// $CYCLER_CONFIG names a file. If it does not exist, the answer is defaults — NOT a silent fall
// back to some other file, which is how you debug the wrong config for an hour.
t('$CYCLER_CONFIG wins even when the file it names does not exist', () => {
  process.env.CYCLER_CONFIG = '/nonexistent/cycler/config.yaml';
  assert.strictEqual(configPath(), '/nonexistent/cycler/config.yaml', 'the explicit path was not honoured');
  assert.deepStrictEqual(readConfig(), {}, 'a missing config must degrade to defaults, not throw');
  delete process.env.CYCLER_CONFIG;
});

// The keys renamed to snake_case in the same release that merged the two config files. A user who
// copies a snippet written in the old spelling must not get silence: `dispatch.pathPrepend` read as
// absent means a dispatched session with launchd's bare PATH, which stalls asking a human where node
// is. Asserted in BOTH directions — a lookup that returned the first value for everything would pass
// the tolerant half alone.
t('a key resolves whichever of snake_case, camelCase or kebab-case it is written in', () => {
  const c = parseYaml('repo:\n  branchPrefix: a/\ndispatch:\n  path-prepend: [x, y]\n');
  assert.strictEqual(get(c, 'repo.branch_prefix'), 'a/');
  assert.strictEqual(get(c, 'repo.branchPrefix'), 'a/');
  assert.strictEqual(get(c, 'repo.branch-prefix'), 'a/');
  assert.deepStrictEqual(get(c, 'dispatch.path_prepend'), ['x', 'y']);
  assert.strictEqual(get(c, 'repo.base'), undefined, 'an absent key must stay absent, not fold onto a sibling');
  assert.strictEqual(get(c, 'repo.branchsuffix'), undefined, 'a different key matched — the fold is too loose');
});

// The exact-match branch has to win, or a file carrying both spellings resolves unpredictably.
t('an exact key match wins over a folded one', () => {
  const c = parseYaml('repo:\n  branchPrefix: wrong/\n  branch_prefix: right/\n');
  assert.strictEqual(get(c, 'repo.branch_prefix'), 'right/');
});

process.exit(fails ? 1 : 0);
