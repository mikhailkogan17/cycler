// The cycler.yaml parser. Deliberately a subset — but the subset has to cover what the shipped
// example file actually uses, and it did not.
//
// `dispatch.command: >` is a folded block scalar. The parser returned the literal ">", so the poller
// would have spawned a process named ">" — for every user who copied the example unchanged, which is
// every user. Nothing caught it because every test until now wrote its own inline YAML.
//
// Hence the last case here: parse the shipped example itself, and assert the values are usable.
import { parseYaml, readConfig } from '../../lib/yaml.mjs';
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
  assert.ok(Array.isArray(c.dispatch?.pathPrepend) && c.dispatch.pathPrepend.length >= 2);
});

process.exit(fails ? 1 : 0);
