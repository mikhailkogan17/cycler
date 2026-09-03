// Stands in for the `claude` binary during poller tests. Records the exact argv and cwd it was
// spawned with — the argv is the security-relevant artefact (spec 4.3) and cwd is spec 4.6 — then
// prints the line the poller parses the session id out of (spec 4.5).
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.DOUBLE_JOURNAL, JSON.stringify({
  kind: 'spawn',
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  path: process.env.PATH,
}) + '\n');
if (process.env.FAKE_CLAUDE_EXIT && process.env.FAKE_CLAUDE_EXIT !== '0') {
  process.stderr.write('fake claude: refusing\n');
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT));
}
process.stdout.write('backgrounded · sess-abc123 · [KEY] title\n');
