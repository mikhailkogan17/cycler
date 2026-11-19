import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('events file required');
const records = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; at: string });
const start = records.find(item => item.type === 'created');
const end = records.find(item => item.type === 'review_done');
if (!start || !end) throw new Error('created/review_done events required');
const ms = Date.parse(end.at) - Date.parse(start.at);
if (!Number.isFinite(ms) || ms < 0) throw new Error('invalid event timestamps');
process.stdout.write((ms / 60_000).toFixed(1));
