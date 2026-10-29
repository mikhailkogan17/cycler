import assert from 'node:assert/strict';
import { run } from './sim.mjs';
import { makeResponder } from './stubs.mjs';
import { runWorkflow, save, patchState, canonicalCommit } from '../../workflows/run.mjs';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { managedPoll } from '../../poller/managed.mjs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let reviews = 0, replies = 0;
const defaultResponse = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
const responder = async (label, prompt, opts, calls) => {
  if (label === 'github-review') {
    reviews++;
    assert(opts.schema, 'native agent must return structured JSON');
    return { approved: reviews > 1, fatal: false, published: true, head: 'a'.repeat(40), confirmed: [],
      blockingIssues: reviews === 1 ? ['x.js:1: failing input'] : [], threads: reviews === 1 ? [{ id: 4, body: 'bug' }] : [] };
  }
  if (label === 'review-replies') { replies++; assert.match(prompt, /--replies/); return { replied: true }; }
  return defaultResponse(label, prompt, opts, calls);
};
const result = await run({ args: { task: 'TEST-1 fix', githubReview: true }, responder });
assert.equal(reviews, 2); assert.equal(replies, 1); assert.equal(result.result.status, 'done');
const bad = await run({ args: { task: 'TEST-1 fix', githubReview: true }, responder: async (l, p, o, c) => l === 'github-review' ? { approved: true, published: false } : defaultResponse(l, p, o, c) });
assert.equal(bad.result.status, 'blocked'); assert.equal(bad.result.stage, 'review');
const seen = [];
const stub = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
const portable = await runWorkflow({ cwd: '/tmp', task: 'test', runtime: 'codex', config: {}, noCommit: true }, { enforce: false, agent: async req => {
  seen.push(req);
  return stub(req.label, req.prompt, {}, []);
} });
assert(seen.every(r => r.runtime === 'codex'));
assert(seen.every(r => !['haiku', 'opus', 'sonnet'].includes(r.model)));
assert.equal(portable.status, 'done');
assert(seen.some(r => r.label === 'verify-gate'), 'the real portable runner must reach verification');
const dir = mkdtempSync(join(tmpdir(), 'cycler-thread-state-'));
try {
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'test']);
  const fullCommit = git(['rev-parse', 'HEAD']);
  assert.equal(await canonicalCommit(dir, fullCommit.slice(0, 8)), fullCommit);
  assert.equal(await canonicalCommit(dir, fullCommit), fullCommit);
  await assert.rejects(canonicalCommit(dir, 'HEAD'), /Invalid commit/);
  await assert.rejects(canonicalCommit(dir, '--help'), /Invalid commit/);
  await assert.rejects(canonicalCommit(dir, '0'.repeat(40)), /failed/);
  const statePath = join(dir, 'state.json');
  save(statePath, { status: 'running' });
  const staged = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
  await runWorkflow({ cwd: dir, task: 'test', issueId: 'TEST-1', runtime: 'codex', config: {}, statePath, noCommit: true }, {
    enforce: false, agent: async req => {
      req.onThread?.({ id: 'thread-' + req.label, name: req.threadName, model: 'test-model', cwd: req.cwd, source: 'vscode' });
      return staged(req.label, req.prompt, {}, []);
    },
  });
  patchState(statePath, { status: 'completed' });
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert(saved.codexThreads.some(t => t.name === 'Cycler TEST-1 · contract'));
  assert(saved.codexThreads.some(t => t.stage === 'implementer'));
  assert.equal(saved.status, 'completed', 'terminal updates must retain session identities');
  save(statePath, { status: 'running' });
  const providers = [];
  await runWorkflow({ cwd: dir, task: 'test', runtime: 'codex', statePath, noCommit: true,
    config: { review: { runtime: 'claude', model: 'sonnet' } } }, { enforce: false,
    agent: async req => {
      const runtime = providers.length === 1 ? 'claude' : 'codex';
      await req.onRuntime({ runtime, ...(runtime === 'claude' ? { reason: 'weekly ceiling', resetsAt: 456 } : {}) });
      const current = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(current.preferredRuntime, 'codex'); assert.equal(current.effectiveRuntime, runtime);
      assert.equal(current.runtimeFallback?.runtime || null, runtime === 'claude' ? 'claude' : null);
      providers.push(runtime);
      return staged(req.label, req.prompt, {}, []);
    } });
  assert(providers.length >= 3); assert.deepEqual(providers.slice(0, 3), ['codex', 'claude', 'codex']);
  save(statePath, { status: 'running' });
  const groupedCalls = [];
  const groupedResponse = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
  const groupedResult = await runWorkflow({ cwd: dir, task: 'test', issueId: 'TEST-1', runtime: 'codex', statePath,
    config: { runtimes: { codex: { thread_mode: 'workflow' } } } }, {
    enforce: false, agent: async req => {
      groupedCalls.push(req);
      req.onThread?.({ id: req.threadId || (req.ephemeral ? 'check-' + req.label : 'workflow-thread'),
        name: req.threadName, model: 'test-model', cwd: req.cwd, ephemeral: req.ephemeral });
      if (req.label === 'workflow-summary') return 'Workflow done.';
      return groupedResponse(req.label, req.prompt, {}, []);
    },
    reviewer: async () => ({ approved: true, published: true, fatal: false, head: fullCommit, confirmed: [], threads: [], blockingIssues: [] }),
  });
  assert.equal(groupedResult.workflowChatError, undefined);
  const summary = groupedCalls.find(r => r.label === 'workflow-summary');
  assert.equal(summary.threadId, 'workflow-thread');
  assert.equal(summary.readOnly, true);
  assert.equal(summary.ephemeral, false);
  assert(summary.prompt.includes('"approved":true') && summary.prompt.includes(fullCommit), 'final chat includes independent reviewer approval and exact head');
  const groupedState = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(groupedState.workflowThreadId, 'workflow-thread');
  assert.equal(groupedState.codexThreads.filter(t => !t.ephemeral).length, 1);
  assert(groupedState.codexThreads.find(t => t.id === 'workflow-thread').stages.includes('implementer'));
  assert(groupedCalls.filter(r => r.label.startsWith('branch:') || r.label === 'implementer').every(r => r.threadId === 'workflow-thread'));
  assert(groupedCalls.filter(r => r.label.startsWith('audit:') || r.label === 'verify-gate').every(r => r.ephemeral && !r.threadId));
  assert(groupedCalls.filter(r => !r.ephemeral).every(r => r.threadName === 'Cycler TEST-1'));
  assert(groupedCalls.some(r => !r.ephemeral && r.prompt.includes('"stage":"verify-gate"')), 'independent check summaries stay inside workflow chat');
  const managedDir = join(dir, 'managed'); mkdirSync(managedDir);
  const workerPath = join(managedDir, 'worker.json');
  save(join(managedDir, 'request.json'), { workflow: '/cycler:workflow-feature', task: 'Approved TEST-1 task',
    executorModel: 'gpt-6-sol', models: { branch: 'gpt-6-luna' } });
  save(workerPath, { status: 'completed', workflowThreadId: 'workflow-thread', result: {
    status: 'done', contractPath: 'contract.md', branch: 'codex/TEST-1', pr: { prUrl: 'https://github.com/test/repo/pull/1' },
  } });
  save(join(managedDir, 'managed.json'), { issue: { statePath: workerPath, pid: 99999, runtime: 'codex', identifier: 'TEST-1', announced: true, attempts: 1 } });
  save(join(managedDir, 'processed.json'), ['issue']);
  let continuation;
  await managedPoll({ dir: managedDir, issues: [{ id: 'issue', identifier: 'TEST-1' }], runtime: 'codex', cwd: dir,
    config: { dispatch: { max_concurrent: 1 } }, workflowFor: () => ({}), comment: async () => {},
    isBlocked: () => false, isAlive: () => false, log: () => {},
    prFor: async () => ({ state: 'OPEN', number: 1, url: 'https://github.com/test/repo/pull/1',
      comments: [{ user: { login: 'human' }, created_at: new Date().toISOString(), body: 'Please continue', url: 'https://github.com/test/repo/pull/1#comment' }] }),
    start: async request => { continuation = request.continuation; return { statePath: workerPath, pid: 99998, runtime: 'codex' }; },
  });
  assert.equal(continuation.workflowThreadId, 'workflow-thread', 'human PR feedback continues the same workflow chat');
  assert.equal(continuation.executorModel, 'gpt-6-sol');
  assert.deepEqual(continuation.models, { branch: 'gpt-6-luna' });
  const quotaState = join(dir, 'quota.json'); save(quotaState, { status: 'running' });
  const held = await runWorkflow({ cwd: dir, task: 'test', runtime: 'codex', config: {}, statePath: quotaState, noCommit: true }, {
    enforce: false, agent: async () => { throw Object.assign(new Error('Codex quota hold: primary reserve'), { code: 'CYCLER_QUOTA_HOLD', resetsAt: 9000 }); },
  });
  assert.equal(held.status, 'blocked');
  const quota = JSON.parse(readFileSync(quotaState, 'utf8')).quotaHold;
  assert.equal(quota.stage, 'contract'); assert.equal(quota.resetsAt, 9000);
  const reviewQuotaState = join(dir, 'review-quota.json'); save(reviewQuotaState, { status: 'running' });
  const reviewQuotaResponse = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
  const reviewHeld = await runWorkflow({ cwd: dir, task: 'test', runtime: 'codex', config: {}, statePath: reviewQuotaState }, {
    enforce: false, agent: async req => {
      if (req.label?.startsWith('github-review:')) throw Object.assign(new Error('Codex quota hold: weekly reserve'), { code: 'CYCLER_QUOTA_HOLD', resetsAt: 10000 });
      return reviewQuotaResponse(req.label, req.prompt, {}, []);
    },
    reviewer: async ({ agent }) => { await agent({ runtime: 'codex', cwd: dir, prompt: 'Review. Lens: bugs.' }); },
  });
  assert.equal(reviewHeld.status, 'blocked');
  const reviewQuota = JSON.parse(readFileSync(reviewQuotaState, 'utf8')).quotaHold;
  assert.equal(reviewQuota.stage, 'github-review:bugs'); assert.equal(reviewQuota.resetsAt, 10000);
  const claudeReviewResponse = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
  await runWorkflow({ cwd: dir, task: 'test', runtime: 'codex', statePath,
    config: { review: { runtime: 'claude', model: 'sonnet' } } }, { enforce: false,
    agent: async req => {
      if (req.runtime === 'claude') {
        await req.onRuntime({ runtime: 'claude' });
        assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).preferredRuntime, 'codex', 'independent reviewer cannot overwrite base preference');
        return { findings: [] };
      }
      return claudeReviewResponse(req.label, req.prompt, {}, []);
    },
    reviewer: async ({ agent, config }) => {
      assert.equal(config.review.runtime, 'claude');
      await agent({ runtime: 'claude', cwd: dir, prompt: 'Review. Lens: bugs.' });
      return { approved: true, published: true, fatal: false, head: fullCommit, confirmed: [], threads: [], blockingIssues: [] };
    } });
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).preferredRuntime, 'codex');
  const reviewed = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
  const blockedReview = await runWorkflow({ cwd: dir, task: 'test', issueId: 'TEST-1', runtime: 'codex', config: {}, statePath }, {
    enforce: false,
    agent: async req => {
      req.onThread?.({ id: 'review-thread-' + req.label, name: req.threadName, model: 'test-model', cwd: req.cwd });
      if (req.label?.startsWith('github-review:')) return { findings: [] };
      return reviewed(req.label, req.prompt, {}, []);
    },
    reviewer: async ({ agent }) => {
      await agent({ runtime: 'codex', cwd: dir, prompt: 'Review. Lens: bugs.' });
      throw new Error('publication failed');
    },
  });
  assert.equal(blockedReview.status, 'blocked');
  assert(JSON.parse(readFileSync(statePath, 'utf8')).codexThreads.some(t => t.stage === 'github-review:bugs'));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('PASS shared GitHub review loop, threaded replies, publication failure and portable stage routing');
