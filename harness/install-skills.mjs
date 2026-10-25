#!/usr/bin/env node
// Shared .agents skill entry points, discovered by both Codex and dsh.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function installSkills(repo) {
  const names = ['start', 'stop', 'delegate', 'doctor', 'workflow-feature', 'workflow-bug', 'workflow-intake', 'workflow-research', 'workflow-review'];
  for (const name of names) {
    const folder = join(resolve(repo), '.agents', 'skills', `cycler-${name}`);
    const target = join(folder, 'SKILL.md');
    const source = name.startsWith('workflow-') ? `skills/${name}/SKILL.md` : `commands/${name}.md`;
    const body = `---\nname: cycler-${name}\ndescription: Run cycler ${name} using Claude Code, Codex or DeepSeek Harness.\n---\n\n<!-- cycler managed skill -->\nRead and follow ${join(root, source)}.\nThe cycler root (CYCLER_ROOT and the legacy CLAUDE_PLUGIN_ROOT alias) is ${root}.\nSet CYCLER_ROOT to that path in shell calls. Use the portable runner when Workflow is unavailable.\n`;
    if (existsSync(target) && !readFileSync(target, 'utf8').includes('<!-- cycler managed skill -->')) throw new Error(`Refusing to overwrite another skill: ${target}`);
    mkdirSync(folder, { recursive: true }); writeFileSync(target, body);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { repo: { type: 'string', default: process.cwd() } } });
  installSkills(values.repo);
  console.log(`Installed shared Codex/dsh skills in ${resolve(values.repo)}/.agents/skills`);
}
