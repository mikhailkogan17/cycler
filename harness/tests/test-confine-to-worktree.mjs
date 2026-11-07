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
  assert(!run(wt, join(homedir(), ".claude", "plans") + "/../../evil.sh").allowed,
    "a ../ escape rode in on the plans exemption");
  assert(!run(wt, join(homedir(), ".claude", "settings.json")).allowed,
    "the exemption widened to the rest of ~/.claude");
});

// Auto-memory lives under the user's home, so these cases run against a throwaway HOME.
const fakeHome = mkdtempSync(join(tmpdir(), "confine-home-"));
const memDir = join(fakeHome, ".claude", "projects", "some-project", "memory");
mkdirSync(memDir, { recursive: true });
const runHome = (cwd, file) => {
  const payload = JSON.stringify({ cwd, tool_input: { file_path: file } });
  try { execFileSync("bash", [HOOK], { input: payload, encoding: "utf8", env: { ...process.env, HOME: fakeHome } }); return true; }
  catch { return false; }
};

check("an auto-memory note is allowed", () => {
  assert(runHome(wt, join(memDir, "note.md")), "blocked a memory note");
  assert(runHome(wt, join(memDir, "MEMORY.md")), "blocked the memory index");
});

check("the memory exemption does not open a path out of it", () => {
  assert(!runHome(wt, join(memDir, "evil.sh")), "a non-markdown file rode in on the exemption");
  assert(!runHome(wt, memDir + "/../../evil.md"), "a ../ escape rode in on the exemption");
  mkdirSync(join(memDir, "sub"), { recursive: true });
  assert(!runHome(wt, join(memDir, "sub", "x.md")), "a nested directory rode in on the exemption");
  mkdirSync(join(fakeHome, ".claude", "projects", "a", "b", "memory"), { recursive: true });
  assert(!runHome(wt, join(fakeHome, ".claude", "projects", "a", "b", "memory", "x.md")), "a deeper memory directory qualified");
  mkdirSync(join(fakeHome, "memory"), { recursive: true });
  assert(!runHome(wt, join(fakeHome, "memory", "x.md")), "a memory directory outside projects qualified");
});

check("the plans exemption is judged by where the file lands", () => {
  // A case glob's * crosses /, so a spelled-path match let ~/.claude/plans/../../x.md through.
  // Built by concatenation: path.join would normalize the ../ away before the hook ever saw it.
  const plans = join(fakeHome, ".claude", "plans");
  mkdirSync(plans, { recursive: true });
  assert(runHome(wt, join(plans, "a-plan.md")), "blocked a plan file");
  assert(!runHome(wt, plans + "/../../evil.md"), "a ../ escape rode in on the plans exemption");
  assert(!runHome(wt, plans + "/../settings.md"), "a ../ into ~/.claude rode in on the plans exemption");
  mkdirSync(join(plans, "sub"), { recursive: true });
  assert(!runHome(wt, join(plans, "sub", "x.md")), "a nested directory rode in on the plans exemption");
  symlinkSync(join(outside, "b.ts"), join(plans, "link.md"));
  assert(!runHome(wt, join(plans, "link.md")), "a symlinked plan file qualified");
});

check("a ../ after a directory that does not exist is judged by where it lands", () => {
  // `cd` cannot resolve zz/.., so the probe used to climb past it and judge the path by the directory
  // it started from. Found in review: this bypassed the worktree check itself, not just the exemptions.
  const plans = join(fakeHome, ".claude", "plans");
  assert(!runHome(wt, wt + "/zz/../../escape.ts"), "worktree/zz/../../ escaped the worktree");
  assert(!runHome(wt, plans + "/zz/../../../evil.md"), "plans/zz/../../../ escaped through the plans exemption");
  assert(!runHome(wt, memDir + "/zz/../../../../evil.md"), "memory/zz/../../../../ escaped through the memory exemption");
  assert(!runHome(wt, plans + "/zz/x.md"), "a nested plans directory that does not exist qualified");
  assert(!runHome(wt, memDir + "/zz/x.md"), "a nested memory directory that does not exist qualified");
  assert(runHome(wt, wt + "/zz/../src/ok.ts"), "a ../ that stays inside the worktree was blocked");
  // The other direction: lexically link/.. is the worktree, but the kernel resolves .. through the
  // symlink, so the write lands next to the other checkout. Both readings have to pass.
  symlinkSync(outside, join(wt, "phys-link"));
  assert(!runHome(wt, wt + "/phys-link/../escape.ts"), "a ../ through a symlink was judged only lexically");
});

check("the first plan is allowed before ~/.claude/plans exists", () => {
  // Plan mode creates the directory with its first write; requiring it to exist would deadlock again.
  const freshHome = mkdtempSync(join(tmpdir(), "confine-freshhome-"));
  const runFresh = file => {
    const payload = JSON.stringify({ cwd: wt, tool_input: { file_path: file } });
    try { execFileSync("bash", [HOOK], { input: payload, encoding: "utf8", env: { ...process.env, HOME: freshHome } }); return true; }
    catch { return false; }
  };
  try {
    assert(runFresh(join(freshHome, ".claude", "plans", "first.md")), "blocked the first plan");
    symlinkSync(outside, join(freshHome, ".claude"));
    assert(!runFresh(join(freshHome, ".claude", "plans", "first.md")), "a symlinked ~/.claude carried the first plan out");
  } finally { rmSync(freshHome, { recursive: true, force: true }); }
});

check("a symlink cannot carry a write out through the memory exemption", () => {
  const linkDir = join(fakeHome, ".claude", "projects", "linked");
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(outside, join(linkDir, "memory"));
  assert(!runHome(wt, join(linkDir, "memory", "x.md")), "a symlinked memory directory qualified");
  symlinkSync(join(outside, "b.ts"), join(memDir, "link.md"));
  assert(!runHome(wt, join(memDir, "link.md")), "a symlinked note qualified");
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

check("outside a /workflow-feature worktree the hook does not fire", () => {
  assert(run(outside, join(outside, "b.ts")).allowed, "fired outside a /workflow-feature worktree");
});

rmSync(wt, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
rmSync(fakeHome, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
