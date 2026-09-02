// APL-54 wrote its entire feature into the main checkout while its own worktree stayed clean. These
// cases pin the confinement, including the spellings that make a path look local when it is not.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = process.env.HOOK_SH ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "confine-to-worktree.sh");
let failed = 0;
const check = (n, fn) => { try { fn(); console.log(`PASS ${n}`); } catch (e) { failed++; console.log(`FAIL ${n}\n  ${e.message.split("\n")[0]}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// Fixtures must live where the hook fires: a .claude/worktrees path. This used to be
// ~/.cyrus/worktrees; when that moved, the hooks stopped firing and these tests were the
// only thing that noticed.
const ROOT = join(tmpdir(), "harness-hooktest", ".claude", "worktrees");
mkdirSync(ROOT, { recursive: true });
const wt = mkdtempSync(join(ROOT, "confine-"));
mkdirSync(join(wt, "src"), { recursive: true });
writeFileSync(join(wt, "src/a.ts"), "x");
const outside = mkdtempSync(join(tmpdir(), "othercheckout-"));
writeFileSync(join(outside, "b.ts"), "x");

const run = (cwd, file) => {
  const payload = JSON.stringify({ cwd, tool_input: { file_path: file } });
  try { execFileSync("bash", [HOOK], { input: payload, encoding: "utf8" }); return { allowed: true, msg: "" }; }
  catch (e) { return { allowed: false, msg: (e.stderr || "").toString() }; }
};

check("a file inside the worktree is allowed", () => {
  assert(run(wt, join(wt, "src/a.ts")).allowed, "blocked an in-worktree write");
});

check("a relative path inside the worktree is allowed", () => {
  assert(run(wt, "src/a.ts").allowed, "blocked a relative in-worktree write");
});

check("plan mode's plan file is allowed — blocking it deadlocks planning", () => {
  // ~/.claude/plans/<slug>.md is the ONLY file plan mode permits writing. Blocking it does not
  // confine the session, it makes planning impossible in a worktree — and the fix cannot be made
  // from inside plan mode either. This hook denied the plan for its own fix; that is the case.
  // A plan file is not repo state: it reaches no branch, no gate and no PR, which is the same
  // reasoning the hook uses to refuse everything else outside the tree.
  const plan = join(homedir(), ".claude", "plans", "some-plan.md");
  assert(run(wt, plan).allowed, "blocked the plan file — plan mode cannot work in a worktree");
});

check("the plans exemption does not open a path out of it", () => {
  // The exemption is a literal ~/.claude/plans/*.md match, so it must not become a general escape.
  assert(!run(wt, join(homedir(), ".claude", "plans", "..", "..", "evil.sh")).allowed,
    "a ../ escape rode in on the plans exemption");
  assert(!run(wt, join(homedir(), ".claude", "settings.json")).allowed,
    "the exemption widened to the rest of ~/.claude");
});

check("an absolute path into another checkout is blocked — APL-54's exact failure", () => {
  const r = run(wt, join(outside, "b.ts"));
  assert(!r.allowed, "allowed a write into another checkout");
  assert(/outside this session's worktree/.test(r.msg), "unhelpful message:\n" + r.msg);
});

check("a ../ escape is judged by where it lands, not how it is spelled", () => {
  assert(!run(wt, join(wt, "../../escape.ts")).allowed, "allowed a ../ escape");
});

check("a file that does not exist yet still resolves honestly", () => {
  assert(!run(wt, join(outside, "brand-new.ts")).allowed, "allowed a new file outside");
  assert(run(wt, join(wt, "src/brand-new.ts")).allowed, "blocked a new file inside");
});

check("a symlink pointing out of the worktree is blocked", () => {
  const link = join(wt, "escape-link");
  try { symlinkSync(outside, link); } catch { /* already there */ }
  assert(!run(wt, join(link, "b.ts")).allowed, "followed a symlink out of the worktree");
});

check("outside a /task worktree the hook does not fire", () => {
  assert(run(outside, join(outside, "b.ts")).allowed, "fired outside a /task worktree");
});

rmSync(wt, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
