// audit.sh replaces the arithmetic half of the audit agent. These cases pin the behaviour that makes
// it trustworthy: it must refuse to run blind, it must parse the contract's real bullet format, and a
// violation must be DIRTY rather than a quiet pass.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
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
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

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

// ---- APL-65: an explicit listing beats a forbidden WILDCARD, but never an exact forbid ----------
//
// A contract's Forbidden section legitimately carries broad globs with prose exceptions:
//   "any test file NOT listed under Files expected to change (... and every other `apps/x/Tests/*`)"
// section() cannot read the qualifier, so the glob was applied unconditionally and audit.sh reported
// forbidden-paths DIRTY on the very files the same contract's Allowed paths, Files expected to change
// AND acceptance checks all required the task to modify.
//
// That is the failure this script's own comments warn about, one level up: a false DIRTY that looks
// exactly like a real scope violation and trains the next reader to skim past the line.
//
// Narrow rule, so the check keeps its teeth: an EXACT path under "Files expected to change" wins over
// a forbidden pattern containing a wildcard. It never wins over an exact forbidden path — "never
// touch this specific file" stays absolute.

check("an explicitly listed file beats a forbidden WILDCARD", () => {
  const dir = repo(
    "## Allowed paths\n\n- `src/a.ts`\n- `tests/keep.test.ts`\n\n" +
    "## Forbidden paths\n\n- any test file NOT listed below (in particular `tests/*`)\n\n" +
    "## Files expected to change\n\n- `src/a.ts` — the fix\n- `tests/keep.test.ts` — its regression test\n",
    ["src/a.ts", "tests/keep.test.ts"]);
  const out = run(dir, false);
  assert(/forbidden-paths *clean/.test(out), "a file the contract explicitly lists was reported forbidden:\n" + out);
  rmSync(dir, { recursive: true, force: true });
});

check("an UNlisted file matching the same wildcard is still forbidden", () => {
  // The other direction. Without it, the rule above could be implemented by dropping wildcard
  // forbids altogether, and the check would pass while enforcing nothing.
  const dir = repo(
    "## Allowed paths\n\n- `src/a.ts`\n- `tests/*`\n\n" +
    "## Forbidden paths\n\n- any test file NOT listed below (in particular `tests/*`)\n\n" +
    "## Files expected to change\n\n- `src/a.ts` — the fix\n",
    ["src/a.ts", "tests/sneaky.test.ts"]);
  const out = run(dir, true);
  assert(/forbidden-paths *DIRTY/.test(out), "an unlisted file matching a forbidden glob passed:\n" + out);
  assert(/sneaky/.test(out), "the offending path was not named:\n" + out);
  rmSync(dir, { recursive: true, force: true });
});

check("an EXACT forbidden path still wins over an explicit listing", () => {
  // A contract that lists a file it also forbids by exact path is contradicting itself deliberately.
  // Forbid wins: "never touch this specific file" must stay absolute, or the escape becomes a way to
  // launder any path through the Files-expected list.
  const dir = repo(
    "## Allowed paths\n\n- `src/a.ts`\n\n" +
    "## Forbidden paths\n\n- `package.json`\n\n" +
    "## Files expected to change\n\n- `src/a.ts` — the fix\n- `package.json` — should NOT be allowed\n",
    ["src/a.ts", "package.json"]);
  const out = run(dir, true);
  assert(/forbidden-paths *DIRTY/.test(out), "an exact forbid was overridden by a listing:\n" + out);
  rmSync(dir, { recursive: true, force: true });
});

check("a new file in a NEW directory is judged as a file, not as its directory", () => {
  // `git status --porcelain` collapses a wholly-untracked directory to one "tests/" entry, and every
  // check here compares against FILE globs. So adding a new file in a new directory reported
  // allowed-paths DIRTY, naming a directory no contract could have listed. -uall fixes it.
  const dir = repo(
    "## Allowed paths\n\n- `src/deep/new.ts`\n\n## Forbidden paths\n\n- `package.json`\n\n" +
    "## Files expected to change\n\n- `src/deep/new.ts` — a new file in a new directory\n",
    ["src/deep/new.ts"]);
  const out = run(dir, false);
  assert(!/src\/deep\/$/m.test(out), "a directory was reported instead of the file:\n" + out);
  assert(/allowed-paths *clean/.test(out), "a listed file in a new directory read as out of scope:\n" + out);
  rmSync(dir, { recursive: true, force: true });
});

check("spaces, quotes, and Unicode in untracked and staged paths stay raw", () => {
  const names = ['src/Document 1 (11).png', 'src/a "quoted" file.txt', 'src/עברית файл.txt'];
  const dir = repo(
    "## Allowed paths\n\n- `src/**`\n\n## Forbidden paths\n\n- `secret/**`\n\n" +
    "## Files expected to change\n\n- `src/**`\n", names);
  git(dir, "add", "--", names[0]);
  const out = run(dir, false);
  assert(/allowed-paths *clean/.test(out) && /scope *clean/.test(out), out);
  rmSync(dir, { recursive: true, force: true });
});

check("renaming a protected source into an allowed path remains DIRTY", () => {
  const dir = repo(
    "## Allowed paths\n\n- `src/renamed.txt`\n\n## Forbidden paths\n\n- `src/base.txt`\n\n" +
    "## Files expected to change\n\n- `src/renamed.txt`\n", []);
  git(dir, "switch", "-q", "-c", "feature");
  git(dir, "mv", "src/base.txt", "src/renamed.txt");
  const out = run(dir, true);
  assert(/forbidden-paths *DIRTY/.test(out) && /src\/base.txt/.test(out), out);
  rmSync(dir, { recursive: true, force: true });
});

check("a staged change remains visible when the working file matches HEAD", () => {
  const dir = repo(
    "## Allowed paths\n\n- `src/other.txt`\n\n## Forbidden paths\n\n- `src/base.txt`\n", []);
  writeFileSync(join(dir, "src/base.txt"), "staged");
  git(dir, "add", "--", "src/base.txt");
  writeFileSync(join(dir, "src/base.txt"), "base\n");
  const out = run(dir, true);
  assert(/forbidden-paths *DIRTY/.test(out), out);
  rmSync(dir, { recursive: true, force: true });
});

check("an invalid base fails before a cached clean result can be used", () => {
  const dir = repo("## Allowed paths\n\n- `src/**`\n", []);
  let failedClosed = false;
  try {
    execFileSync("bash", [AUDIT, "--base", "missing-ref"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, CONTRACT_PATH: ".claude/harness/contracts/c.md" }, stdio: "pipe" });
  } catch (e) { failedClosed = e.status !== 0 && /unknown base/.test(e.stderr || ""); }
  assert(failedClosed, "invalid base did not fail closed");
  rmSync(dir, { recursive: true, force: true });
});

check("cache invalidates when another path appears inside an untracked directory", () => {
  const dir = repo(
    "## Allowed paths\n\n- `src/**`\n\n## Forbidden paths\n\n- `src/secret.txt`\n\n" +
    "## Files expected to change\n\n- `src/**`\n", ["src/ok.txt"]);
  writeFileSync(join(dir, ".git/info/exclude"), ".test-results/\n");
  run(dir, false);
  writeFileSync(join(dir, "src/secret.txt"), "secret");
  const out = run(dir, true);
  assert(/forbidden-paths *DIRTY/.test(out), out);
  rmSync(dir, { recursive: true, force: true });
});

check("a wildcard authorizes a large committed deletion batch", () => {
  const dir = repo(
    "## Allowed paths\n\n- `src/**`\n\n## Files expected to change\n\n- `src/**`\n", []);
  for (let i = 0; i < 24; i++) writeFileSync(join(dir, `src/old ${i}.txt`), "old");
  git(dir, "add", "--", "src");
  git(dir, "commit", "-qm", "fixture");
  git(dir, "switch", "-q", "-c", "feature");
  for (let i = 0; i < 24; i++) unlinkSync(join(dir, `src/old ${i}.txt`));
  git(dir, "add", "-u");
  git(dir, "commit", "-qm", "remove old files");
  const out = run(dir, false);
  assert(/scope *clean *\(24 changed, 24 listed\)/.test(out), out);
  rmSync(dir, { recursive: true, force: true });
});

check("unplanned additions still exceed the declared scope", () => {
  const dir = repo(
    "## Allowed paths\n\n- `src/**`\n\n## Files expected to change\n\n- `src/expected.txt`\n",
    ["src/expected.txt", "src/extra 1.txt", "src/extra 2.txt"]);
  git(dir, "add", "--", "src/expected.txt");
  const out = run(dir, true);
  assert(/scope *DIRTY/.test(out), out);
  rmSync(dir, { recursive: true, force: true });
});

check("an unmatched planned wildcard cannot disable scope checking", () => {
  const dir = repo(
    "## Allowed paths\n\n- `src/**`\n\n## Files expected to change\n\n" +
    "- `src/planned/**`\n- `src/planned/**`\n",
    ["src/unplanned/a.txt", "src/unplanned/b.txt", "src/unplanned/c.txt", "src/unplanned/d.txt"]);
  const out = run(dir, true);
  assert(/allowed-paths *clean/.test(out), out);
  assert(/scope *DIRTY/.test(out) && /contract lists 1 file\(s\); the diff touches 4/.test(out), out);
  rmSync(dir, { recursive: true, force: true });
});

check("no expected-files section retains the no-scope default", () => {
  const dir = repo("## Allowed paths\n\n- `src/**`\n",
    ["src/a.txt", "src/b.txt", "src/c.txt", "src/d.txt"]);
  const out = run(dir, false);
  assert(/scope *clean *\(4 changed, 0 listed\)/.test(out), out);
  rmSync(dir, { recursive: true, force: true });
});

check("explicit path lists are honored without reading explanatory symbols", () => {
  const dir = repo("## Allowed paths\n\n- `src/a.ts`, `src/b.ts`, and the new `src/c.ts` for the API.\n- `src/d.ts` — replaces `outside.ts` with `helper()`\n\n## Forbidden paths\n\n- `src/secret.ts`, and `src/blocked.ts`\n", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  assert(/allowed-paths *clean/.test(run(dir, false)), "listed paths rejected");
  writeFileSync(join(dir, "outside.ts"), "x");
  assert(/allowed-paths *DIRTY/.test(run(dir, true)), "prose reference became an allowed path");
  unlinkSync(join(dir, "outside.ts"));
  writeFileSync(join(dir, "src/blocked.ts"), "x");
  assert(/forbidden-paths *DIRTY/.test(run(dir, true)), "second explicit forbidden path was ignored");
  rmSync(dir, { recursive: true, force: true });
});

for (const list of [
  "`src/a.ts` (new), `src/b.ts` (new)",
  "`src/a.ts`, and the `src/b.ts`",
  "`src/a.ts`, and a new `src/b.ts`",
  "`src/a.ts` / `src/b.ts`",
  "`src/a.ts`; `src/b.ts`",
  "`src/a.ts` + `src/b.ts`",
]) check(`general declaration-list grammar: ${list}`, () => {
  const allowed = repo(`## Allowed paths\n\n- ${list}\n`, ["src/a.ts", "src/b.ts"]);
  assert(/allowed-paths *clean/.test(run(allowed, false)), "explicit path lost");
  rmSync(allowed, { recursive: true, force: true });
  const forbidden = repo(`## Allowed paths\n\n- \`src/**\`\n\n## Forbidden paths\n\n- ${list}\n`, ["src/b.ts"]);
  assert(/forbidden-paths *DIRTY/.test(run(forbidden, true)), "second forbidden path lost");
  rmSync(forbidden, { recursive: true, force: true });
});

process.exit(failed ? 1 : 0);
