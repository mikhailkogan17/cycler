import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedPoll, launch, write, read } from '../../poller/managed.mjs';
const dir = mkdtempSync(join(tmpdir(), 'cycler-managed-'));
const issues = [1, 2].map(n => ({ id: String(n), identifier: `TASK-${n}`, state: { type: 'unstarted' } }));
let starts = 0, live = true, failComment = true;
const comments = [];
const deps = { dir, issues, runtime: 'dsh', cwd: dir, config: { dispatch: { max_concurrent: 1 } },
  workflowFor: () => ({ workflow: '/cycler:workflow-feature' }), isBlocked: () => false, isAlive: () => live, log: () => {},
  comment: async (...args) => { if (failComment) throw new Error('network'); comments.push(args); },
  start: async ({ runtime }) => {
    starts++; const statePath = join(dir, `worker-${starts}.json`); write(statePath, { status: 'running' });
    return { id: `run-${starts}`, pid: 400 + starts, statePath, runtime };
  } };
try {
  await managedPoll(deps); assert.equal(starts, 1); assert.deepEqual(read(join(dir, 'processed.json')), ['1']);
  failComment = false;
  await managedPoll(deps); assert.equal(starts, 1, 'live workers and comment failures cannot duplicate dispatch');
  write(join(dir, 'worker-1.json'), { status: 'completed', result: { status: 'done' } }); live = false;
  await managedPoll(deps); assert.equal(starts, 2, 'finished worker releases concurrency slot');
  write(join(dir, 'worker-2.json'), { status: 'failed', result: { status: 'blocked', blockedReason: 'red gate' } });
  await managedPoll(deps); assert.equal(starts, 2, 'blocked implementations must not restart blindly');
  assert(comments.some(c => c[1].includes('red gate')));
  assert(read(join(dir, 'managed.json'))['2'].announced);
  const fake = join(dir, 'fake-dsh');
  writeFileSync(fake, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"final",text:"Research completed"}));\n', { mode: 0o755 });
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, `dispatch:\n  runtime: dsh\nruntimes:\n  dsh:\n    bin: ${fake}\n`);
  const job = await launch({ dir, issue: issues[0], workflow: '/cycler:workflow-research', runtime: 'dsh', cwd: dir,
    env: { ...process.env, CYCLER_CONFIG: configPath } });
  let terminal;
  for (let i = 0; i < 100; i++) {
    terminal = read(job.statePath);
    if (['completed', 'failed'].includes(terminal.status)) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(terminal.status, 'completed'); assert.equal(terminal.result.summary, 'Research completed');
  console.log('PASS real detached worker records a durable terminal result');
  console.log('PASS managed ownership, concurrency, comment failure, terminal failures and failure reporting');
} finally { rmSync(dir, { recursive: true, force: true }); }
