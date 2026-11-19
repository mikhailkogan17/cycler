import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from './capture.js';
import { command, event } from './lib.js';

const demoDir = fileURLToPath(new URL('.', import.meta.url));
const team = process.env.DEMO_TEAM;
if (!team || !/^[A-Z][A-Z0-9]*$/.test(team)) throw new Error('DEMO_TEAM must be a Linear team key');
const runLabel = `demo-run-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;

// These CLI calls use the already configured linear auth; no token is copied or logged.
command('linear', ['auth', 'whoami']);
command('linear', ['label', 'create', '--name', runLabel, '--team', team, '--color', '#6B8EFA']);
const output = command('linear', ['issue', 'create', '--team', team, '--title', 'Demo: implement slugify', '--description-file', join(demoDir, 'seed-issue.md'), '--label', runLabel, '--no-interactive']);
const key = output.match(new RegExp(`\\b${team}-\\d+\\b`))?.[0];
if (!key) throw new Error(`Linear create succeeded but issue key was not found: ${output}`);
const issue = JSON.parse(command('linear', ['issue', 'view', key, '--json'])) as { id?: string; identifier?: string; url?: string };
if (issue.identifier !== key || !issue.id || !issue.url) throw new Error('created issue identity could not be verified');
await capture('created', issue.url);
event('created', { issueKey: key, issueUrl: issue.url, label: runLabel });

const query = 'query DemoDelegate($id:String!){viewer{id} issue(id:$id){id identifier}}';
const lookup = JSON.parse(command('linear', ['api', query, '--variables-json', JSON.stringify({ id: key })])) as { data?: { viewer?: { id?: string }; issue?: { id?: string; identifier?: string } }; errors?: unknown };
if (lookup.errors || lookup.data?.issue?.id !== issue.id || !lookup.data.viewer?.id) throw new Error('delegate preflight failed');
const mutation = 'mutation DemoDelegate($id:String!,$delegate:String!){issueUpdate(id:$id,input:{delegateId:$delegate}){success issue{identifier delegate{id}}}}';
const result = JSON.parse(command('linear', ['api', mutation, '--variables-json', JSON.stringify({ id: issue.id, delegate: lookup.data.viewer.id })])) as { data?: { issueUpdate?: { success?: boolean; issue?: { identifier?: string; delegate?: { id?: string } } } }; errors?: unknown };
const updated = result.data?.issueUpdate;
if (result.errors || !updated?.success || updated.issue?.identifier !== key || updated.issue.delegate?.id !== lookup.data.viewer.id) throw new Error('issue delegation failed');
await capture('delegated', issue.url);
event('delegated', { issueKey: key });
process.stdout.write(`${key}\n`);
