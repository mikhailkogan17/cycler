import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const retryDir = join(dir, 'retries'); mkdirSync(retryDir);
  const original = { workflow: '/cycler:workflow-feature', task: 'Full approved core task', issueId: 'TASK-1',
    branch: 'claude/TASK-1', contractPath: '/contracts/frozen.md', executorModel: 'gpt-6-sol',
    models: { branch: 'gpt-6-luna' }, workflowThreadId: 'prior-chat', feedback: ['Inspected continuation'],
    statePath: '/obsolete/state.json', config: { secret: 'must not replay' } };
  const seed = (state, request = original, processed = true) => {
    write(join(retryDir, 'state.json'), state);
    if (request) write(join(retryDir, 'request.json'), request);
    else rmSync(join(retryDir, 'request.json'), { force: true });
    write(join(retryDir, 'managed.json'), { '1': { id: 'old', pid: 999, runtime: 'codex', identifier: 'TASK-1',
      statePath: join(retryDir, 'state.json'), attempts: 1, startedAt: 1 } });
    write(join(retryDir, 'processed.json'), processed ? ['1'] : []);
  };
  const launches = [];
  const retryDeps = { ...deps, dir: retryDir, issues: [issues[0]], runtime: 'dsh', isAlive: () => false,
    start: async request => {
      launches.push(request); const statePath = join(retryDir, 'next-state.json');
      write(statePath, { status: 'running' }); return { id: 'next', pid: 1000, statePath, runtime: request.runtime };
    } };
  seed({ status: 'failed', error: 'failed before workflow execution' });
  await managedPoll(retryDeps);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].runtime, 'codex');
  for (const key of ['task', 'issueId', 'branch', 'contractPath', 'executorModel', 'models', 'workflowThreadId', 'feedback'])
    assert.deepEqual(launches[0].continuation[key], original[key]);
  assert(!('statePath' in launches[0].continuation)); assert(!('config' in launches[0].continuation));
  for (const state of [
    { status: 'failed', stage: 'branch:claude/TASK-1', error: 'feedback.map is not a function' },
    { status: 'failed', stage: 'implementer', error: 'API failure' },
    { status: 'running', stage: 'implementer', workflowThreadId: 'latest-chat' },
    { status: 'failed', result: { status: 'blocked', fatal: true } },
    { status: 'failed', fatal: true, error: 'fatal preflight' },
    { status: 'unknown', error: 'unrecognized worker state' },
    { status: 'failed', workflowThreadId: 'model-already-started' },
    { status: 'failed', quotaHold: { stage: 'contract' } },
  ]) {
    seed(state, original, false); await managedPoll(retryDeps);
    assert.equal(launches.length, 1, 'even an externally unprocessed staged/fatal job must stay held');
  }
  seed({ status: 'failed', error: 'unknown failure' }, null, false);
  await managedPoll(retryDeps); assert.equal(launches.length, 1, 'missing request must not fall back to a bare issue');
  seed({ status: 'completed', workflowThreadId: 'latest-chat', result: { pr: { prUrl: 'https://github.com/o/r/pull/1' },
    contractPath: '/contracts/frozen.md', branch: 'claude/TASK-1' } });
  await managedPoll({ ...retryDeps, prFor: async () => ({ state: 'OPEN', number: 1, url: 'https://github.com/o/r/pull/1',
    comments: [{ created_at: new Date().toISOString(), body: 'Please fix this', user: { type: 'User', login: 'human' },
      html_url: 'https://github.com/o/r/pull/1#issuecomment-1' }] }) });
  assert.equal(launches.length, 2);
  assert.equal(launches[1].continuation.workflowThreadId, 'latest-chat');
  assert.equal(launches[1].continuation.executorModel, 'gpt-6-sol');
  assert.deepEqual(launches[1].continuation.models, original.models);
  assert.equal(launches[1].continuation.task, original.task);
  assert(Array.isArray(launches[1].continuation.feedback));
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
