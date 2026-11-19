import { command, requireDemoRepo } from './lib.js';

const team = process.env.DEMO_TEAM;
if (!team || !/^[A-Z][A-Z0-9]*$/.test(team)) throw new Error('DEMO_TEAM missing');
requireDemoRepo();
function rows(input: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(input)) return input as Array<Record<string, unknown>>;
  if (input && typeof input === 'object') {
    for (const key of ['nodes', 'issues', 'labels']) {
      const value = (input as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
      if (value && typeof value === 'object' && Array.isArray((value as { nodes?: unknown }).nodes)) return (value as { nodes: Array<Record<string, unknown>> }).nodes;
    }
  }
  throw new Error('unrecognized linear-cli JSON response; cleanup cannot be confirmed');
}
const raw = JSON.parse(command('linear', ['label', 'list', '--team', team, '--json'])) as unknown;
const labels = rows(raw);
for (const value of labels) {
  const label = value as { name?: string };
  if (!/^demo-run-\d{14,}$/.test(label.name ?? '')) continue;
  const found = JSON.parse(command('linear', ['issue', 'query', '--team', team, '--label', label.name!, '--limit', '0', '--json'])) as unknown;
  const issues = rows(found);
  for (const value of issues) {
    const issue = value as { identifier?: string; state?: { type?: string }; labels?: Array<{ name?: string }> };
    if (!issue.identifier?.startsWith(`${team}-`)) continue;
    const detail = JSON.parse(command('linear', ['issue', 'view', issue.identifier, '--json'])) as { id?: string; labels?: Array<{ name?: string }> | { nodes?: Array<{ name?: string }> }; identifier?: string };
    const detailLabels = Array.isArray(detail.labels) ? detail.labels : detail.labels?.nodes ?? [];
    if (detail.identifier !== issue.identifier || !detail.id || !detailLabels.some(item => item.name === label.name)) continue;
    // Explicit user authorization: linear-cli 2.5.0 has no archive command, so the
    // sole cleanup exception uses `linear api` for issueArchive after exact label/team proof.
    const mutation = 'mutation DemoArchive($id:String!){issueArchive(id:$id){success entity{id archivedAt}}}';
    const result = JSON.parse(command('linear', ['api', mutation, '--variables-json', JSON.stringify({ id: detail.id })])) as {
      data?: { issueArchive?: { success?: boolean; entity?: { id?: string; archivedAt?: string } } }; errors?: unknown;
    };
    const archive = result.data?.issueArchive;
    if (result.errors || !archive?.success || archive.entity?.id !== detail.id || !archive.entity?.archivedAt) throw new Error(`demo issue ${issue.identifier} was not archived`);
    process.stdout.write(`archived ${issue.identifier}\n`);
  }
}
