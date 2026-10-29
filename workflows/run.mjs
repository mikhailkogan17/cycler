#!/usr/bin/env node
// Execute the existing workflow with real CLI-backed agent/parallel/pipeline primitives.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readConfig } from '../lib/yaml.mjs';
import { runAgent, runtimeName, stageRoute, get, expand, execute } from '../lib/runtimes.mjs';
import { protect } from '../lib/invariants.mjs';
import { review, publishReplies, github } from '../harness/review.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function save(path, data) {
  writeFileSync(path + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
export function patchState(path, data) {
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  save(path, { ...previous, ...data });
}
function threadOptions(args, label) {
  const mode = get(args.config || {}, 'runtimes.codex.thread_mode') || 'stage';
  if (!['stage', 'workflow'].includes(mode)) throw new Error(`Invalid Codex thread_mode: ${mode}`);
  const isolated = /^(audit:|verify-|github-review:|review:|refute:|synthesis|review-replies)/.test(label || '');
  const shared = mode === 'workflow' && !isolated;
  const saved = args.statePath && existsSync(args.statePath) ? JSON.parse(readFileSync(args.statePath, 'utf8')) : {};
  return { label, threadName: shared ? `Cycler ${args.issueId || 'workflow'}` : `Cycler ${args.issueId || 'workflow'} · ${label || 'agent'}`,
    threadId: shared ? args.workflowThreadId || saved.workflowThreadId : undefined,
    ephemeral: mode === 'workflow' && isolated,
    onThread: thread => {
      if (shared) args.workflowThreadId = thread.id;
      console.error(`Codex ${thread.ephemeral ? 'isolated check' : 'chat'}: ${thread.id} (${thread.name})`);
      if (!args.statePath) return;
      const previous = JSON.parse(readFileSync(args.statePath, 'utf8'));
      const entries = previous.codexThreads || [];
      const prior = entries.find(t => t.id === thread.id);
      patchState(args.statePath, { stage: label, ...(shared ? { workflowThreadId: thread.id } : {}),
        codexThreads: [...entries.filter(t => t.id !== thread.id), { ...thread, stage: label,
          stages: [...(prior?.stages || []), label] }] });
    } };
}
const reviewLabel = request => `github-review:${/Lens: ([\w-]+)/.exec(request.prompt)?.[1] || 'verify-blocker'}`;
export async function canonicalCommit(cwd, commit) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{7,64}$/i.test(commit)) throw new Error('Invalid commit ID for review replies');
  return (await execute(['git', 'rev-parse', '--verify', `${commit}^{commit}`], { cwd })).trim();
}
function quotaTracked(invoke, args) {
  return async request => {
    try { return await invoke({ ...request, onRuntime: async info => {
      await request.onRuntime?.(info);
      const independentReview = /^(github-review:|review:|refute:|synthesis)/.test(request.label || '');
      if (args.statePath && !independentReview) patchState(args.statePath, { effectiveRuntime: info.runtime,
        runtimeFallback: info.reason ? { ...info, stage: request.label || 'agent', checkedAt: Date.now() } : null });
    } }); }
    catch (error) {
      if (error.code === 'CYCLER_QUOTA_HOLD' && args.statePath) patchState(args.statePath, {
        quotaHold: { reason: error.message, resetsAt: error.resetsAt ?? null, stage: request.label || 'agent', checkedAt: Date.now() },
      });
      throw error;
    }
  };
}
export async function runWorkflow(args, { agent: rawInvoke = runAgent, reviewer = review, enforce = true } = {}) {
  const invoke = quotaTracked(rawInvoke, args);
  const config = args.config || readConfig();
  const threadArgs = { ...args, config };
  const checkSummaries = [];
  const runtime = runtimeName(config, args.runtime);
  // A request runtime is a preference; quota fallback is selected afresh for each stage.
  if (args.statePath) patchState(args.statePath, { preferredRuntime: runtime });
  const cwd = expand(args.cwd || get(config, 'repo.path') || process.cwd());
  const resolved = { ...args, ...(args.contractPath ? { contractPath: resolve(cwd, args.contractPath) } : {}), cwd, config, runtime, pluginRoot: ROOT, githubReview: args.githubReview !== false,
    prBase: args.prBase || get(config, 'repo.base') || 'main', branchPrefix: args.branchPrefix || get(config, 'repo.branch_prefix') || `${runtime}/` };
  let contract = resolved.contractPath;
  if (enforce && contract && !existsSync(contract)) throw new Error(`Contract missing: ${contract}`);
  let assertContract = contract && enforce ? protect([contract]) : () => {};
  let assertGate = () => {};
  const agent = async (prompt, opts = {}) => {
    console.error(`cycler stage: ${opts.label}`);
    if (args.statePath) patchState(args.statePath, { stage: opts.label });
    if (opts.reviewRequest) {
      try {
        const result = await reviewer({ ...opts.reviewRequest, config, publish: true,
          agent: request => invoke({ ...request, ...threadOptions(threadArgs, reviewLabel(request)) }) });
        checkSummaries.push({ stage: opts.label, approved: result.approved, published: result.published,
          head: result.head, fatal: result.fatal, fatalReason: result.fatalReason, blockingIssues: result.blockingIssues,
          findings: result.confirmed?.map(f => ({ severity: f.severity, title: f.title })) });
        return result;
      }
      catch (err) {
        checkSummaries.push({ stage: opts.label, approved: false, fatal: true, fatalReason: err.message });
        return { approved: false, fatal: true, fatalReason: err.message };
      }
    }
    const route = stageRoute(config, opts.label || '', runtime, opts.model);
    if (opts.replyRequest) {
      try {
        const { pr, threads } = opts.replyRequest;
        const commit = await canonicalCommit(opts.cwd || cwd, opts.replyRequest.commit);
        const schema = { type: 'object', required: ['replies'], properties: { replies: { type: 'array', items: {
          type: 'object', required: ['id', 'body'], properties: { id: { type: 'integer' }, body: { type: 'string' } }
        } } } };
        const drafted = await invoke({ ...route, config, cwd: opts.cwd || cwd, schema, readOnly: true,
          prompt: `You are the implementer replying to these GitHub threads: ${JSON.stringify(threads)}. Inspect the actual code and commit ${commit}. Explain the verified fix and tests, or an evidence-based disagreement/deferral. Do not publish; return one reply per root thread.`, ...threadOptions(threadArgs, opts.label) });
        if (!drafted?.replies || drafted.replies.length !== threads.length || new Set(drafted.replies.map(r => r.id)).size !== threads.length
          || threads.some(t => !drafted.replies.some(r => r.id === t.id))) throw new Error('Implementer did not answer every thread');
        const api = github(opts.cwd || cwd);
        await publishReplies({ api, pr: api.pr(pr), commit, replies: drafted.replies });
        checkSummaries.push({ stage: opts.label, replied: true, commit });
        return { replied: true };
      } catch (err) {
        checkSummaries.push({ stage: opts.label, replied: false, error: err.message });
        console.error(`Replies failed: ${err.message}`); return { replied: false };
      }
    }

    try {
      // Provider-independent deterministic pre-commit enforcement: no model can declare a red gate green.
      if (enforce && opts.label !== 'followups' && opts.label !== 'cleanup') { assertContract(); assertGate(); }
      if (enforce && opts.label?.startsWith('committer:')) {
        if (!contract) throw new Error('No contract recorded before commit');
        const env = { ...process.env, CONTRACT_PATH: resolve(cwd, contract), CLAUDE_PROJECT_DIR: opts.cwd || cwd, AUDIT_NO_CACHE: '1' };
        await execute(['bash', join(ROOT, 'harness/audit.sh'), '--base', resolved.prBase], { cwd: opts.cwd || cwd, env });
        await execute(['bash', join(ROOT, 'harness/gate.sh'), '--fast', '--base', resolved.prBase], { cwd: opts.cwd || cwd, env });
      }
      const session = threadOptions(threadArgs, opts.label);
      const grouped = get(config, 'runtimes.codex.thread_mode') === 'workflow';
      const stagePrompt = grouped && !session.ephemeral
        ? `Workflow stage: ${opts.label}. Follow the current stage instructions below.\nIndependent check results (controller summary): ${JSON.stringify(checkSummaries)}\n\n${prompt}` : prompt;
      const result = await invoke({ ...route, config, cwd: opts.cwd || cwd, prompt: stagePrompt, schema: opts.schema, label: opts.label,
        ...session });
      if (grouped && session.ephemeral) checkSummaries.push({ stage: opts.label, clean: result?.clean,
        checks: result?.checks?.map(c => ({ name: c.name, passed: c.passed })), blockers: result?.blockers });
      if (result?.contractPath) {
        result.contractPath = resolve(cwd, result.contractPath); contract = result.contractPath;
        if (enforce) { if (!existsSync(contract)) throw new Error(`Contract missing: ${contract}`); assertContract = protect([contract]); }
      }
      if (enforce && opts.label?.startsWith('branch:') && result?.ok) {
        const tree = args.worktree ? join(cwd, '.claude/worktrees', result.branch.replace(/[^A-Za-z0-9._-]/g, '-')) : cwd;
        assertGate = protect([join(tree, '.claude/harness/gate.sh'), join(ROOT, 'harness/gate.sh'), join(ROOT, 'harness/gate.default.sh')]);
      }
      if (enforce && opts.label !== 'followups' && opts.label !== 'cleanup') { assertContract(); assertGate(); }
      return result;
    }
    catch (err) { console.error(`${opts.label}: ${err.message}`); return null; }
  };
  const src = readFileSync(join(ROOT, 'workflows/task-orchestration.js'), 'utf8').replace(/^export const meta/m, 'const meta');
  const fn = new (Object.getPrototypeOf(async function () {}).constructor)('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', src);
  const result = await fn(resolved, agent, tasks => Promise.all(tasks.map(t => t())),
    (items, ...stages) => Promise.all(items.map(async (item, i) => { let v = item; for (const stage of stages) v = await stage(v, item, i); return v; })),
    phase => console.error(`cycler phase: ${phase}`), msg => console.error(msg), { total: null, remaining: () => Infinity });
  if (runtime === 'codex' && get(config, 'runtimes.codex.thread_mode') === 'workflow' && threadArgs.workflowThreadId) {
    try {
      await invoke({ ...stageRoute(config, 'workflow-summary', runtime), config, cwd, readOnly: true,
        ...threadOptions(threadArgs, 'workflow-summary'),
        prompt: `Workflow finished. Do not use tools or perform more work. Give a concise final status using only this controller report: ${JSON.stringify({
          status: result.status, stage: result.stage, blockedReason: result.blockedReason, pr: result.pr, checks: checkSummaries,
        })}` });
    } catch (error) { result.workflowChatError = error.message; console.error(`Workflow chat summary failed: ${error.message}`); }
  }
  return result;
}
export async function runSkill({ workflow, task, issueId, cwd, runtime, config = readConfig(), ...options }) {
  const invoke = quotaTracked(runAgent, options);
  const name = String(workflow || 'workflow-feature').replace(/^\/?(?:cycler:)?/, '').replace(/^\$/, '');
  if (!['workflow-feature', 'workflow-bug', 'workflow-research', 'workflow-intake', 'workflow-review'].includes(name)) throw new Error(`Unsupported workflow: ${workflow}`);
  runtime = runtimeName(config, runtime);
  if (name === 'workflow-review') return review({ cwd, pr: task, config, runtime, publish: true,
    agent: request => invoke({ ...request, ...threadOptions({ ...options, issueId, config }, reviewLabel(request)) }) });
  if (name === 'workflow-feature' || name === 'workflow-bug') {
    issueId ||= typeof task === 'string' && (/^\s*([A-Z][A-Z0-9]*-\d+)\s*$/i.exec(task)?.[1] || /https?:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)/i.exec(task)?.[1]);
    if (issueId && !options.contractPath) {
      // Resolve the complete issue before giving any provider a task. No MCP assumptions.
      const description = await execute([join(ROOT, 'poller/lin'), 'issue', 'view', issueId], { cwd });
      task = `${issueId}\n${description}`;
    }
    if (name === 'workflow-bug') task = `FIX MODE: read ${ROOT}/harness/modes/fix.md; regression test before implementation.\n${task}`;
    return runWorkflow({ ...options, task, issueId, cwd, runtime, config });
  }
  const text = await invoke({ runtime, config, cwd,
    prompt: `Follow ${ROOT}/skills/${name}/SKILL.md. CYCLER_ROOT=${ROOT}; CLAUDE_PLUGIN_ROOT is the same compatibility alias. Use available tools; no Claude-only ToolSearch or Workflow calls. Request: ${task}`,
    ...threadOptions({ ...options, issueId, config }, name) });
  return { status: 'done', workflow: name, summary: text };
}
export async function syncLinear(result, cwd) {
  for (const entry of result.linearWrites || []) {
    if (entry.skipped || !entry.issue) continue;
    try {
      const lin = join(ROOT, 'poller/lin');
      const comments = await execute([lin, 'issue', 'comment', 'list', entry.issue], { cwd });
      if (entry.body && !comments.includes(entry.body)) await execute([lin, 'issue', 'comment', 'add', entry.issue, '--body', entry.body], { cwd });
      if (entry.stateType && entry.stateType !== 'completed') await execute([lin, 'issue', 'update', entry.issue, '--state', entry.statePreference || entry.stateType], { cwd });
    } catch (err) { console.error(`Linear sync failed: ${err.message}`); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { request: { type: 'string' }, workflow: { type: 'string' }, task: { type: 'string' },
    cwd: { type: 'string' }, runtime: { type: 'string' }, contract: { type: 'string' }, 'no-commit': { type: 'boolean' } } });
  let request;
  try {
    request = values.request ? JSON.parse(readFileSync(values.request, 'utf8')) : { ...values, contractPath: values.contract, noCommit: values['no-commit'] };
    const config = request.config || readConfig();
    request.cwd ||= expand(get(config, 'repo.path') || process.cwd());
    if (request.statePath) save(request.statePath, { status: 'running', pid: process.pid, startedAt: Date.now() });
    const result = await runSkill({ ...request, config });
    await syncLinear(result, request.cwd);
    if (request.statePath) patchState(request.statePath, { status: result.status === 'blocked' ? 'failed' : 'completed', result, finishedAt: Date.now() });
    console.log(JSON.stringify(result));
    if (result.status === 'blocked') process.exitCode = 1;
  } catch (err) {
    if (request?.statePath) patchState(request.statePath, { status: 'failed', error: err.message, finishedAt: Date.now() });
    console.error(err.stack || err.message); process.exitCode = 1;
  }
}
