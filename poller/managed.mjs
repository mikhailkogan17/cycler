// Durable workers for foreground CLIs (Codex exec / dsh headless).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { get } from '../lib/runtimes.mjs';
import { isHumanGithub, isHumanLinear, followupPrompt } from './followup.mjs';
const runner = fileURLToPath(new URL('../workflows/run.mjs', import.meta.url));
export function read(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (err) { if (err.code === 'ENOENT') return fallback; throw err; } }
export function write(path, value) { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(path + '.tmp', path); }
export function alive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
export async function launch({ dir, issue, workflow, runtime, cwd, env = process.env, continuation = {} }) {
  const id = randomUUID();
  const folder = join(dir, 'jobs', id);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const statePath = join(folder, 'state.json');
  const requestPath = join(folder, 'request.json');
  // Store no configuration snapshot: OAuth secrets stay in the single config file.
  write(requestPath, { workflow, task: issue.identifier, issueId: issue.identifier, cwd, runtime, statePath, unattended: true, worktree: true, ...continuation });
  write(statePath, { status: 'starting', startedAt: Date.now() });
  const fd = openSync(join(folder, 'worker.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [runner, '--request', requestPath], { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
    child.unref();
    return { id, pid: child.pid, statePath, startedAt: Date.now(), runtime };
  } finally { closeSync(fd); }
}
export async function managedPoll({ dir, issues, runtime, cwd, config, workflowFor, comment, isBlocked, env, log = console.log, start = launch, isAlive = alive, prFor }) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'managed-poll.lock');
  try { mkdirSync(lock); } catch (err) {
    if (err.code === 'EEXIST') throw new Error('Managed poll already running (inspect managed-poll.lock before removing a stale lock)');
    throw err;
  }
  try {
    const registryPath = join(dir, 'managed.json');
    const statePath = join(dir, 'processed.json');
    const registry = read(registryPath, {});
    const processed = new Set(read(statePath, []));
    const max = Number(get(config, 'dispatch.max_concurrent') ?? 1);
    const attempts = Number(get(config, 'dispatch.max_attempts') ?? 3);
    if (!Number.isInteger(max) || max < 0 || !Number.isInteger(attempts) || attempts < 1) throw new Error('Invalid dispatch concurrency/attempt limit');
    const problems = [];
    let running = 0;
    const announce = async (id, text) => { try { await comment(id, text); return true; } catch (err) { problems.push(`comment failed: ${err.message}`); return false; } };
    for (const [issueId, rec] of Object.entries(registry)) {
      let state = read(rec.statePath, null);
      if (!state || ['starting', 'running'].includes(state.status)) {
        if (isAlive(rec.pid)) { running++; continue; }
        state = { status: 'failed', error: 'Worker exited without a terminal result' };
      }
      if (state.status === 'completed') {
        if (!rec.announced) rec.announced = await announce(issueId, `${rec.runtime} workflow completed${state.result?.pr?.prUrl ? `: ${state.result.pr.prUrl}` : '.'}`);
      } else {
        problems.push(`${rec.identifier}: ${state.error || state.result?.blockedReason || 'workflow blocked'}`);
        if (!rec.announced) rec.announced = await announce(issueId, `⚠️ ${rec.runtime} workflow failed: ${state.error || state.result?.blockedReason || 'inspect worker.log'}. Attempt ${rec.attempts}/${attempts}.`);
        // A completed but blocked workflow owns its worktree. Never restart implementation blindly.
        if (!state.result && rec.attempts < attempts) processed.delete(issueId);
      }
    }
    if (prFor) for (const issue of issues) {
      if (max && running >= max) break;
      const rec = registry[issue.id];
      if (!rec || isAlive(rec.pid) || rec.closed) continue;
      const state = read(rec.statePath, null);
      const prior = state?.result || rec.priorResult;
      if (!prior?.pr?.prUrl || !prior.contractPath || !prior.branch) continue;
      try {
        const pr = await prFor(issue.identifier);
        if (!pr) continue;
        if (['MERGED', 'CLOSED'].includes(pr.state)) { rec.closed = true; continue; }
        const since = rec.seenAt || rec.startedAt || 0;
        const links = [
          ...(pr.comments || []).filter(c => isHumanGithub(c, since)).map(c => c.html_url || c.url || pr.url),
          ...(issue.comments?.nodes || []).filter(c => isHumanLinear(c, since)).map(c => `Linear feedback: ${c.body}`),
        ];
        if (!links.length) continue;
        const next = await start({ dir, issue, workflow: '/cycler:workflow-feature', runtime: rec.runtime, cwd, env,
          continuation: { contractPath: prior.contractPath, branch: prior.branch, feedback: [followupPrompt(issue.identifier, pr.number, links)] } });
        registry[issue.id] = { ...next, identifier: issue.identifier, attempts: rec.attempts, seenAt: Date.now(), priorResult: prior };
        write(registryPath, registry); running++;
        await announce(issue.id, `Continued ${rec.runtime} workflow for new feedback on the same PR: ${pr.url}`);
      } catch (err) { problems.push(`${issue.identifier}: follow-up failed: ${err.message}`); }
    }
    for (const issue of issues) {
      if (max && running >= max) break;
      if (processed.has(issue.id) || ['completed', 'canceled'].includes(issue.state?.type) || isBlocked(issue)) continue;
      const previous = registry[issue.id];
      if (previous && isAlive(previous.pid)) continue;
      if ((previous?.attempts || 0) >= attempts) continue;
      try {
        if (!existsSync(cwd)) throw new Error(`Repository missing: ${cwd}`);
        const rec = await start({ dir, issue, workflow: workflowFor(issue).workflow, runtime, cwd, env });
        registry[issue.id] = { ...rec, identifier: issue.identifier, attempts: (previous?.attempts || 0) + 1 };
        // Persist ownership before any remote write. A comment failure cannot duplicate dispatch.
        write(registryPath, registry);
        processed.add(issue.id); write(statePath, [...processed]);
        running++;
        await announce(issue.id, `Dispatched to ${runtime} managed session ${rec.id}.`);
      } catch (err) {
        problems.push(`${issue.identifier}: ${err.message}`);
        await announce(issue.id, `⚠️ ${runtime} dispatch failed: ${err.message}`);
      }
    }
    write(registryPath, registry); write(statePath, [...processed]);
    log(`poll ${problems.length ? 'degraded' : 'ok'}: ${issues.length} delegated, ${running} managed sessions running${problems.length ? '; ' + problems.join('; ') : ''}`);
    return { running, problems };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
