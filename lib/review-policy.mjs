export function admitReview({ history = [], round, head, previousReview }) {
  if (history.length >= 3) throw new Error('Review repeat budget exhausted: one Sol initial and two Luna repeats');
  if (history.length !== round - 1) throw new Error(`Review round mismatch: expected ${history.length + 1}`);
  if (history.length) {
    const previous = history.at(-1);
    if (head === previous.head) throw new Error('Review repeat requires a new pushed PR head');
    if (!previousReview || previousReview.head !== previous.head || !Array.isArray(previousReview.confirmed))
      throw new Error('Review repeat missing prior findings');
  }
  return { model: history.length ? 'gpt-6-luna' : 'gpt-6.1-sol', repeat: history.length > 0 };
}
export function completeReview(history, result, model) {
  if (!result || result.fatal === true || typeof result.approved !== 'boolean' || result.published !== true || !result.head || !Array.isArray(result.confirmed))
    throw new Error('Review returned missing output');
  return [...history, { head: result.head, model, findings: result.confirmed, threads: result.threads || [], result, at: Date.now() }];
}
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export function reviewLedgerFile(repoRoot, pr) {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const root = dirname(resolve(repoRoot, common));
  const dir = join(root, '.claude/worktrees/.cycler-review-ledger');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${createHash('sha256').update(pr).digest('hex')}.json`);
}
export function readReviewLedger(repoRoot, pr) {
  const file = reviewLedgerFile(repoRoot, pr);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}
export async function withReviewLedger(repoRoot, pr, callback) {
  const file = reviewLedgerFile(repoRoot, pr), lock = `${file}.lock`;
  try { mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8')); } catch { /* owner may still be starting */ }
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error(`Review already running for ${pr}; inspect ${lock}`); }
      catch (check) { if (check.code !== 'ESRCH') throw check; }
    } else if (Date.now() - statSync(lock).mtimeMs < 60_000) throw new Error(`Review lock is new and owner is unknown: ${lock}`);
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  try {
    const history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    const outcome = await callback(history);
    if (outcome?.history) {
      writeFileSync(`${file}.tmp`, JSON.stringify(outcome.history, null, 2), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    }
    return outcome?.result;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
