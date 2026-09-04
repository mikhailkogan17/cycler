#!/usr/bin/env node
// harness/read-config.mjs — read one key out of cycler.yaml, for the bash hooks.
//
//   node harness/read-config.mjs <dotted.key> [default]
//   node harness/read-config.mjs --json
//
// Prints the value (lists one per line) and exits 0; prints the default and exits 0 when absent.
// `--json` prints the WHOLE config as JSON — that is what the /task skill passes as args.config,
// so the workflow's prompts carry this repo's verify steps and escape hatch instead of defaults.
import { readConfig, get } from '../lib/yaml.mjs';

const [key, fallback] = process.argv.slice(2);
if (!key) { console.error('usage: read-config.mjs <dotted.key> [default] | --json'); process.exit(2); }

if (key === '--json') { process.stdout.write(JSON.stringify(readConfig() ?? {})); process.exit(0); }

const v = get(readConfig(), key);
if (v === undefined || v === null) {
  if (fallback !== undefined) process.stdout.write(String(fallback));
  process.exit(0);
}
process.stdout.write(Array.isArray(v) ? v.join('\n') : String(v));
