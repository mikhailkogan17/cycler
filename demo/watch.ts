import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { capture } from './capture.js';
import { command, event, events, requireDemoRepo } from './lib.js';

const key = process.argv[2];
if (!key || !/^[A-Z][A-Z0-9]*-\d+$/.test(key)) throw new Error('usage: watch.ts ISSUE-KEY');
const repo = requireDemoRepo();
const sandbox = process.env.DEMO_SANDBOX_PATH;
const logPath = process.env.DEMO_SESSION_LOG;
if (!sandbox || !logPath) throw new Error('DEMO_SANDBOX_PATH and DEMO_SESSION_LOG are required');
const deadline = Date.now() + 30 * 60_000;
const seen = new Set(events().map(item => String(item.type)));
const prior = events().find(item => item.type === 'created');
const initialUrl = String(prior?.issueUrl ?? '');
if (!initialUrl.startsWith('https://linear.app/')) throw new Error('created event lacks Linear URL');
let prUrl = '';
const logOffset = Number(readFileSync(join(process.env.DEMO_RUN_DIR!, 'log-offset'), 'utf8'));
if (!Number.isSafeInteger(logOffset) || logOffset < 0) throw new Error('invalid log offset');

function contractsWritten(): boolean {
  const worktrees = command('git', ['-C', sandbox!, 'worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  for (const tree of worktrees) {
    const dir = join(tree, '.claude/harness/contracts');
    if (existsSync(dir) && readdirSync(dir).some(name => name.toLowerCase().includes(key.toLowerCase()) && name.endsWith('.md'))) return true;
  }
  return false;
}

async function mark(type: string, data: Record<string, unknown> = {}): Promise<void> {
  if (seen.has(type)) return;
  // Capture first: an event with no matching frame must not claim a complete video.
  await capture(type, initialUrl, prUrl || undefined);
  event(type, data);
  seen.add(type);
  process.stdout.write(`${new Date().toISOString()} ${type}\n`);
}

while (Date.now() < deadline) {
  const issue = JSON.parse(command('linear', ['issue', 'view', key, '--json'])) as {
    identifier?: string; state?: { type?: string; name?: string }; url?: string;
    comments?: Array<{ body?: string }> | { nodes?: Array<{ body?: string }> };
  };
  if (issue.identifier !== key) throw new Error('Linear issue identity changed');
  if (issue.state?.type === 'started' || /in progress/i.test(issue.state?.name ?? '')) await mark('in_progress');
  if (contractsWritten()) await mark('contract_written');
  const bytes = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
  const log = bytes.length >= logOffset ? bytes.subarray(logOffset).toString('utf8') : '';
  if (/^DEMO_GATE_GREEN\s*$/m.test(log)) await mark('gate_passed');

  const prs = JSON.parse(command('gh', ['pr', 'list', '-R', repo, '--state', 'open', '--json', 'number,url,headRefName,body,latestReviews,headRefOid', '--limit', '100'])) as Array<{
    number: number; url: string; headRefName: string; body?: string; latestReviews?: unknown[]; headRefOid?: string;
  }>;
  const pr = prs.find(item => item.headRefName.startsWith('cycler/') && (`${item.body ?? ''} ${item.headRefName}`).includes(key));
  if (pr) {
    prUrl = pr.url;
    await mark('pr_opened', { prUrl, prNumber: pr.number, head: pr.headRefOid });
    const comments = Array.isArray(issue.comments) ? issue.comments : issue.comments?.nodes ?? [];
    const cyclerComment = comments.some(item => typeof item.body === 'string' && item.body.includes(prUrl));
    if (cyclerComment && Array.isArray(pr.latestReviews) && pr.latestReviews.length > 0) await mark('review_done', { prUrl, head: pr.headRefOid });
  }
  if (seen.has('review_done')) {
    const required = ['created', 'delegated', 'in_progress', 'contract_written', 'gate_passed', 'pr_opened', 'review_done'];
    const missing = required.filter(type => !seen.has(type));
    if (missing.length) throw new Error(`reviewed PR lacks demo evidence: ${missing.join(', ')}`);
    process.stdout.write(`${prUrl}\n`);
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 10_000));
}
throw new Error(`timed out after 30 min; events=${[...seen].join(',')}`);
