import { join } from 'node:path';
import { command, event, events, requireDemoRepo, runDir } from './lib.js';

if (!runDir || !process.env.DEMO_SANDBOX_PATH) throw new Error('run directory or sandbox missing');
const repo = requireDemoRepo();
const opened = events().find(item => item.type === 'pr_opened');
const number = Number(opened?.prNumber);
if (!Number.isSafeInteger(number) || number <= 0) throw new Error('PR number missing');
const readHead = () => JSON.parse(command('gh', ['pr', 'view', String(number), '-R', repo, '--json', 'headRefOid,headRefName,state'])) as { headRefOid: string; headRefName: string; state: string };
const before = readHead();
if (before.state !== 'OPEN' || !before.headRefName.startsWith('cycler/') || !/^[0-9a-f]{40}$/.test(before.headRefOid)) throw new Error('PR state/head is not a valid demo branch');
const sandbox = process.env.DEMO_SANDBOX_PATH;
const tree = join(runDir, 'verify-head');
command('git', ['-C', sandbox, 'fetch', 'origin', before.headRefName]);
const fetched = command('git', ['-C', sandbox, 'rev-parse', 'FETCH_HEAD']);
if (fetched !== before.headRefOid) throw new Error('fetched PR head differs from GitHub head');
command('git', ['-C', sandbox, 'worktree', 'add', '--detach', tree, fetched]);
try {
  const gate = command('bash', ['.claude/harness/gate.sh'], tree, 300_000);
  if (!gate.includes('DEMO_GATE_GREEN')) throw new Error('green gate marker missing on exact PR head');
  const after = readHead();
  if (after.headRefOid !== fetched || after.state !== 'OPEN') throw new Error('PR head changed during exact-head gate');
  event('exact_head_gate_passed', { prNumber: number, head: fetched });
} finally {
  command('git', ['-C', sandbox, 'worktree', 'remove', '--force', tree]);
}
