// audit.sh replaces the arithmetic half of the audit agent. These cases pin the behaviour that makes
// it trustworthy: it must refuse to run blind, it must parse the contract's real bullet format, and a
// violation must be DIRTY rather than a quiet pass.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AUDIT = process.env.AUDIT_SH || join(dirname(fileURLToPath(import.meta.url)), "..", "audit.sh");
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n  ${e.message.split("\n")[0]}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

function repo(contract, files) {
  const dir = mkdtempSync(join(tmpdir(), "audit-"));
  const sh = (c) => execFileSync("bash", ["-c", c], { cwd: dir, encoding: "utf8" });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  sh("mkdir -p src && echo base > src/base.txt && git add -A && git commit -qm base && git branch -M main");
  mkdirSync(join(dir, ".claude/harness/contracts"), { recursive: true });
  writeFileSync(join(dir, ".claude/harness/contracts/c.md"), contract);
  // Commit the contract: an untracked contract shows up as a changed file and skews every check.
  sh("git add -A && git commit -qm contract");
  for (const f of files) { mkdirSync(join(dir, dirname(f)), { recursive: true }); writeFileSync(join(dir, f), "x"); }
  return dir;
}
function run(dir, expectFail) {
  try {
    const out = execFileSync("bash", [AUDIT, "--base", "main"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, CONTRACT_PATH: ".claude/harness/contracts/c.md" } });
    if (expectFail) throw new Error("expected a non-zero exit, got success:\n" + out);
    return out;
  } catch (e) {
    if (!expectFail) throw new Error("expected success, got exit " + e.status + ":\n" + (e.stdout || e.message));
    return e.stdout || "";
  }
}

check("prose in a section is not a path declaration", () => {
  // APL-62. A contract that EXPLAINS itself was punished for it: audit.sh took every backticked
  // token between two headings, so a paragraph justifying a decision turned its own examples into
  // forbidden globs and reported DIRTY on files the contract explicitly allowed. Moving the
  // paragraph made the identical tree CLEAN. Only bullets declare paths.
  const dir = repo(
    "## Allowed paths\n\n- `src/*`\n\n" +
    "## Forbidden paths\n\n- `dangerfile.js`\n\n" +
    "Why this run touches `src/**` and not `apps/macOS/**`: the mapping lives in\n" +
    "`case \"reply-sweep\": self = .gmailCheck`, which is Swift and out of scope here.\n\n" +
    "## Files expected to change\n\n- `src/a.ts` — why\n",
    ["src/a.ts"],
  );
  const out = run(dir, false);
  assert(!/DIRTY/.test(out), "explaining a decision in prose produced a false DIRTY:\n" + out);
  rmSync(dir, { recursive: true, force: true });
});

check("refuses to run without CONTRACT_PATH — a blind pass is worse than no check", () => {
  const dir = repo("## Allowed paths\n\n- `src/*`\n", []);
  let threw = false;
  try {
    execFileSync("bash", [AUDIT], { cwd: dir, encoding: "utf8", env: { ...process.env, CONTRACT_PATH: "" } });
  } catch { threw = true; }
  assert(threw, "ran anyway with no contract");
  rmSync(dir, { recursive: true, force: true });
});

check("a file outside Allowed paths is DIRTY", () => {
  const dir = repo("## Allowed paths\n\n- `src/ok.txt`\n\n## Forbidden paths\n\n- `secrets/*`\n", ["src/nope.txt"]);
  const out = run(dir, true);
  assert(/allowed-paths\s+DIRTY/.test(out), "did not flag the stray file:\n" + out);
  rmSync(dir, { recursive: true, force: true });
});

check('a "New: `path`" bullet is parsed as a path, not as prose', () => {
  // The real APL-41 contract wrote its new files this way. Stripping only the bullet marker left
  // "New: apps/..." as the glob, so every new file read as a violation.
  const dir = repo("## Allowed paths\n\n- New: `src/fresh.txt`\n", ["src/fresh.txt"]);
  const out = run(dir, false);
  assert(/allowed-paths\s+clean/.test(out), "labelled bullet was not parsed:\n" + out);
  rmSync(dir, { recursive: true, force: true });
});

check("editing the contract the run is judged against is DIRTY", () => {
  const dir = repo("## Allowed paths\n\n- `.claude/harness/contracts/c.md`\n", []);
  execFileSync("bash", ["-c", "echo tampered >> .claude/harness/contracts/c.md"], { cwd: dir });
  const out = run(dir, true);
  assert(/contract-intact\s+DIRTY/.test(out), "contract edit went unnoticed:\n" + out);
  rmSync(dir, { recursive: true, force: true });
});

process.exit(failed ? 1 : 0);
