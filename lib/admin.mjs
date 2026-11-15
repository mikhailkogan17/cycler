// Mechanical workflow operations. All commands use argv arrays; task text is never a shell program.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execute, get } from './runtimes.mjs';

const ref = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.startsWith('-') && !value.includes('..');
const git = (cwd, ...args) => execute(['git', ...args], { cwd });
export class AdminError extends Error {
  constructor(stage, command, cause) { super(`${stage}: ${command}: ${cause.message}`); this.code = 'CYCLER_STAGE_FAILURE'; this.stage = stage; this.command = command; this.cause = cause; }
}
async function command(stage, cwd, argv, options) {
  try { return await execute(argv, { cwd, ...options }); }
  catch (error) { throw new AdminError(stage, argv.join(' '), error); }
}
export async function adminBranch({ cwd, branch, base, worktree, config = {} }) {
  if (!ref(branch) || !ref(base) || branch === base) throw new Error('Invalid task/base branch');
  const previousBranch = (await git(cwd, 'branch', '--show-current')).trim();
  const path = join(cwd, '.claude/worktrees', branch.replace(/[^A-Za-z0-9._-]/g, '-'));
  if (worktree) {
    if (existsSync(path)) {
      const actual = (await git(path, 'branch', '--show-current')).trim();
      if (actual !== branch) throw new Error(`Worktree ${path} belongs to ${actual}, expected ${branch}`);
      return { branch, previousBranch, created: false, baseSha: (await git(path, 'rev-parse', '--short', 'HEAD')).trim(), ok: true };
    }
    try { await git(cwd, 'fetch', 'origin', base); } catch { /* local base is valid offline */ }
    const local = await git(cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false);
    const remote = !local && await git(cwd, 'ls-remote', '--exit-code', '--heads', 'origin', branch).then(() => true, () => false);
    const remoteBase = await git(cwd, 'rev-parse', '--verify', `refs/remotes/origin/${base}`).then(() => true, () => false);
    const argv = local ? ['git', 'worktree', 'add', path, branch]
      : remote ? ['git', 'worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]
        : ['git', 'worktree', 'add', '-b', branch, path, remoteBase ? `origin/${base}` : base];
    await command('branch', cwd, argv);
    if (get(config, 'worktree.link_workspace')) await command('branch', cwd, ['bash', join(new URL('..', import.meta.url).pathname, 'harness/link-workspace.sh'), path, cwd]);
    // Bootstrap is advisory, as in the existing workflow. It remains an explicitly configured command.
    let note = '';
    if (get(config, 'worktree.bootstrap')) {
      try { await execute(['/bin/sh', '-c', get(config, 'worktree.bootstrap')], { cwd: path }); }
      catch (error) { note = `Bootstrap failed: ${error.message}`; }
    }
    const actual = (await git(path, 'branch', '--show-current')).trim();
    const unchanged = (await git(cwd, 'branch', '--show-current')).trim();
    if (actual !== branch || unchanged !== previousBranch) throw new Error('Branch verification failed');
    return { branch, previousBranch, created: !local && !remote, baseSha: (await git(path, 'rev-parse', '--short', 'HEAD')).trim(), ok: true, ...(note ? { error: note } : {}) };
  }
  const lock = join(cwd, '.claude/worktrees/.task-shared-tree.lock');
  mkdirSync(join(cwd, '.claude/worktrees'), { recursive: true });
  try { mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let started = NaN;
    try { started = Number(new Date(readFileSync(join(lock, 'started'), 'utf8').trim())); } catch { /* missing timestamp is stale */ }
    if (Number.isFinite(started) && Date.now() - started <= 6 * 60 * 60 * 1000)
      throw new Error(`Shared-tree lock held at ${lock}`);
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  writeFileSync(join(lock, 'branch'), branch); writeFileSync(join(lock, 'started'), new Date().toISOString());
  try {
    if (previousBranch !== branch) {
      try { await git(cwd, 'fetch', 'origin', base); } catch { /* local base */ }
      const local = await git(cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false);
      if (local) await command('branch', cwd, ['git', 'switch', branch]);
      else {
        const remote = await git(cwd, 'ls-remote', '--exit-code', '--heads', 'origin', branch).then(() => true, () => false);
        const remoteBase = await git(cwd, 'rev-parse', '--verify', `refs/remotes/origin/${base}`).then(() => true, () => false);
        await command('branch', cwd, remote ? ['git', 'switch', '--track', `origin/${branch}`] : ['git', 'switch', '-c', branch, remoteBase ? `origin/${base}` : base]);
      }
    }
    if ((await git(cwd, 'branch', '--show-current')).trim() !== branch) throw new Error('Branch verification failed');
    return { branch, previousBranch, created: previousBranch !== branch, baseSha: (await git(cwd, 'rev-parse', '--short', 'HEAD')).trim(), ok: true, lockTaken: true };
  } catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
}
export async function adminCommit({ cwd, files, issueId, runtime, label }) {
  const current = (await git(cwd, 'branch', '--show-current')).trim();
  if (!current) throw new Error('Commit requires a named branch');
  const names = [...new Set(files || [])];
  if (!names.length || names.some(p => !p || p.startsWith('/') || p.split('/').some(x => x === '..' || x === '.'))) throw new Error('Commit requires safe task file paths');
  const status = (await git(cwd, 'status', '--porcelain=v1', '-z', '--', ...names)).split('\0').filter(Boolean);
  const changed = status.map(s => s.slice(3));
  if (!changed.length) {
    const hash = (await git(cwd, 'rev-parse', 'HEAD')).trim();
    const pushed = (await git(cwd, 'rev-parse', '@{upstream}').catch(() => '')).trim() === hash;
    if (!pushed) await command('push', cwd, ['git', 'push', '-u', 'origin', 'HEAD']);
    return { commitHash: hash, committedFiles: [], message: 'Existing commit', pushed: true };
  }
  await command('commit', cwd, ['git', 'add', '--', ...changed]);
  const staged = (await git(cwd, 'diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean);
  if (staged.some(p => !names.includes(p))) throw new Error(`Staged file outside task: ${staged.filter(p => !names.includes(p)).join(', ')}`);
  const message = `${issueId ? `(${issueId}) ` : ''}${label === 'initial' ? 'Implement contracted change' : 'Address review findings'}`;
  const trailer = runtime === 'codex' ? 'Co-Authored-By: Codex <noreply@openai.com>' : runtime === 'dsh' ? 'Generated-by: DeepSeek Harness' : 'Co-Authored-By: Claude <noreply@anthropic.com>';
  await command('commit', cwd, ['git', 'commit', '-m', message, '-m', trailer]);
  const commitHash = (await git(cwd, 'rev-parse', 'HEAD')).trim();
  await command('push', cwd, ['git', 'push', '-u', 'origin', 'HEAD']);
  return { commitHash, committedFiles: staged, message, pushed: true };
}
export async function adminPR({ cwd, base, contract, issueId }) {
  if (!ref(base)) throw new Error('Invalid PR base');
  const branch = (await git(cwd, 'branch', '--show-current')).trim();
  if (!branch || branch === base) throw new Error('PR requires a distinct task branch');
  let prior;
  try { prior = JSON.parse(await execute(['gh', 'pr', 'view', branch, '--json', 'number,url,headRefOid'], { cwd })); } catch { /* absent PR */ }
  if (prior?.url) return { prUrl: prior.url, prNumber: String(prior.number), note: 'Existing PR' };
  const spec = readFileSync(contract, 'utf8');
  const goal = /## Goal\s*\n+([^\n]+)/i.exec(spec)?.[1]?.trim() || `Implement ${branch}`;
  const title = goal.replace(/^[-*]\s*/, '').slice(0, 120);
  const body = `${goal}\n\n${issueId ? `Closes ${issueId}.\n\n` : ''}Generated by the task harness — do NOT merge without review.`;
  await command('pr', cwd, ['gh', 'pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]);
  const result = JSON.parse(await command('pr', cwd, ['gh', 'pr', 'view', branch, '--json', 'number,url,headRefOid']));
  return { prUrl: result.url, prNumber: String(result.number), note: 'Created PR' };
}
export async function adminCleanup({ cwd, worktree, lock, removeWorktree }) {
  let lockReleased = false, worktreeRemoved = false;
  if (lock) { rmSync(lock, { recursive: true, force: true }); lockReleased = !existsSync(lock); }
  if (removeWorktree && worktree) { await command('cleanup', cwd, ['git', 'worktree', 'remove', '--force', worktree]); worktreeRemoved = !existsSync(worktree); }
  return { lockReleased, worktreeRemoved, note: `lock ${lockReleased ? 'released' : 'unchanged'}; worktree ${worktreeRemoved ? 'removed' : 'kept'}` };
}
