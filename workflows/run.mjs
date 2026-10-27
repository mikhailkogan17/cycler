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
  return { label, threadName: `Cycler ${args.issueId || 'workflow'} · ${label || 'agent'}`,
    onThread: thread => {
      console.error(`Codex chat: ${thread.id} (${thread.name})`);
      if (!args.statePath) return;
      const previous = JSON.parse(readFileSync(args.statePath, 'utf8'));
      patchState(args.statePath, { stage: label, codexThreads: [...(previous.codexThreads || []), { ...thread, stage: label }] });
    } };
}
const reviewLabel = request => `github-review:${/Lens: ([\w-]+)/.exec(request.prompt)?.[1] || 'verify-blocker'}`;
export async function runWorkflow(args, { agent: invoke = runAgent, reviewer = review, enforce = true } = {}) {
  const config = args.config || readConfig();
  const runtime = runtimeName(config, args.runtime);
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
      try { return await reviewer({ ...opts.reviewRequest, config, publish: true,
        agent: request => invoke({ ...request, ...threadOptions(args, reviewLabel(request)) }) }); }
      catch (err) { return { approved: false, fatal: true, fatalReason: err.message }; }
    }
    const route = stageRoute(config, opts.label || '', runtime, opts.model);
    if (opts.replyRequest) {
      try {
        const { pr, commit, threads } = opts.replyRequest;
        const schema = { type: 'object', required: ['replies'], properties: { replies: { type: 'array', items: {
          type: 'object', required: ['id', 'body'], properties: { id: { type: 'integer' }, body: { type: 'string' } }
        } } } };
        const drafted = await invoke({ ...route, config, cwd: opts.cwd || cwd, schema, readOnly: true,
          prompt: `You are the implementer replying to these GitHub threads: ${JSON.stringify(threads)}. Inspect the actual code and commit ${commit}. Explain the verified fix and tests, or an evidence-based disagreement/deferral. Do not publish; return one reply per root thread.`, ...threadOptions(args, opts.label) });
        if (!drafted?.replies || drafted.replies.length !== threads.length || new Set(drafted.replies.map(r => r.id)).size !== threads.length
          || threads.some(t => !drafted.replies.some(r => r.id === t.id))) throw new Error('Implementer did not answer every thread');
        const api = github(opts.cwd || cwd);
        await publishReplies({ api, pr: api.pr(pr), commit, replies: drafted.replies });
        return { replied: true };
      } catch (err) { console.error(`Replies failed: ${err.message}`); return { replied: false }; }
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
      const result = await invoke({ ...route, config, cwd: opts.cwd || cwd, prompt, schema: opts.schema, label: opts.label,
        ...threadOptions(args, opts.label) });
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
  return fn(resolved, agent, tasks => Promise.all(tasks.map(t => t())),
    (items, ...stages) => Promise.all(items.map(async (item, i) => { let v = item; for (const stage of stages) v = await stage(v, item, i); return v; })),
    phase => console.error(`cycler phase: ${phase}`), msg => console.error(msg), { total: null, remaining: () => Infinity });
}
export async function runSkill({ workflow, task, issueId, cwd, runtime, config = readConfig(), ...options }) {
  const name = String(workflow || 'workflow-feature').replace(/^\/?(?:cycler:)?/, '').replace(/^\$/, '');
  if (!['workflow-feature', 'workflow-bug', 'workflow-research', 'workflow-intake', 'workflow-review'].includes(name)) throw new Error(`Unsupported workflow: ${workflow}`);
  runtime = runtimeName(config, runtime);
  if (name === 'workflow-review') return review({ cwd, pr: task, config, runtime, publish: true,
    agent: request => runAgent({ ...request, ...threadOptions({ ...options, issueId }, reviewLabel(request)) }) });
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
  const text = await runAgent({ runtime, config, cwd,
    prompt: `Follow ${ROOT}/skills/${name}/SKILL.md. CYCLER_ROOT=${ROOT}; CLAUDE_PLUGIN_ROOT is the same compatibility alias. Use available tools; no Claude-only ToolSearch or Workflow calls. Request: ${task}`,
    ...threadOptions({ ...options, issueId }, name) });
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
