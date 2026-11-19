import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const safe = line
    .replace(/[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email hidden]')
    .replace(/\b(bearer|token|secret|api[_-]?key)\b\s*[=:]\s*\S+/gi, '[credential hidden]');
  process.stdout.write(`${safe}\n`);
}
