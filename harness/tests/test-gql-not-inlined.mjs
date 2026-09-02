// GraphQL inlined into a jq program gets brace-expanded by the shell: `{ a, b }` becomes two words,
// and the query reaches Linear truncated at the first comma. It fails as a GraphQL syntax error, not
// as an empty result, so callers that only check for a value see "no session" and retry forever.
//
// This cost real time twice: once truncating a team lookup, once silently breaking a delegate
// mutation so every dispatch that appeared to work was reusing an already-minted session.
//
// The rule: hold every GraphQL document in a shell variable and pass it via `jq --arg`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = ["file-followups.sh"];
let failed = 0;

for (const name of scripts) {
  const src = readFileSync(join(here, "..", name), "utf8");
  const offenders = src
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /jq -n/.test(line) && /query:"/.test(line));

  if (offenders.length) {
    failed++;
    console.log(`FAIL ${name}: GraphQL inlined into a jq program — the shell will brace-expand it`);
    for (const [n, line] of offenders) console.log(`  ${n}: ${line.trim().slice(0, 100)}`);
  } else {
    console.log(`PASS ${name}: every GraphQL document is passed via a variable`);
  }
}

process.exit(failed ? 1 : 0);
