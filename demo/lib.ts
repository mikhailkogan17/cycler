import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const runDir = process.env.DEMO_RUN_DIR;
export const repo = process.env.DEMO_GH_OWNER ? `${process.env.DEMO_GH_OWNER}/cycler-demo` : '';

export function command(bin: string, args: string[], cwd?: string, timeoutMs = 120_000): string {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4_000_000 });
  if (result.status !== 0) throw new Error(`${bin} ${args[0] ?? ''} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function event(type: string, data: Record<string, unknown> = {}): void {
  if (!runDir) throw new Error('DEMO_RUN_DIR missing');
  appendFileSync(join(runDir, 'events.jsonl'), JSON.stringify({ type, at: new Date().toISOString(), ...data }) + '\n');
}

export function events(): Array<Record<string, unknown>> {
  if (!runDir) throw new Error('DEMO_RUN_DIR missing');
  try { return readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

export function requireDemoRepo(): string {
  if (!repo || !/^[A-Za-z0-9-]+\/cycler-demo$/.test(repo)) throw new Error('DEMO_GH_OWNER must identify the demo-only repository');
  const info = JSON.parse(command('gh', ['repo', 'view', repo, '--json', 'nameWithOwner,isPrivate'])) as { nameWithOwner: string; isPrivate: boolean };
  if (info.nameWithOwner !== repo || info.isPrivate) throw new Error(`refusing operation outside public ${repo}`);
  return repo;
}
