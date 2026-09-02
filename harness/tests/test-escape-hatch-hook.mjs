// The escape hatch was prose for its whole life and was ignored on the one run that hit it: APL-41,
// thirteen files and apps/macOS, ran inline for 331 turns at $8.68. These cases pin the enforcement.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = process.env.HOOK_SH ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "require-escape-hatch.sh");
let failed = 0;
const check = (n, fn) => { try { fn(); console.log(`PASS ${n}`); } catch (e) { failed++; console.log(`FAIL ${n}\n  ${e.message.split("\n")[0]}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// The hook only fires inside a /task worktree, so the fixture must live under one.
// Fixtures must live where the hook fires: a .claude/worktrees path. This used to be
// ~/.cyrus/worktrees; when that moved, the hooks stopped firing and these tests were the
// only thing that noticed.
const ROOT = join(tmpdir(), "harness-hooktest", ".claude", "worktrees");
mkdirSync(ROOT, { recursive: true });

function fixture(contract) {
  const dir = mkdtempSync(join(ROOT, "hooktest-"));
  mkdirSync(join(dir, ".claude/harness/contracts"), { recursive: true });
  writeFileSync(join(dir, ".claude/harness/contracts/c.md"), contract);
  return dir;
}
function run(dir, file, env = {}) {
  const payload = JSON.stringify({ cwd: dir, tool_input: { file_path: file } });
  try {
    execFileSync("bash", [HOOK], { input: payload, encoding: "utf8", env: { ...process.env, ...env } });
    return { allowed: true, msg: "" };
  } catch (e) {
    return { allowed: false, msg: (e.stderr || "").toString() };
  }
}

// escapeHatch.paths is repo config now, not a hardcoded applygent path. Written to a temp file so
// the two cases below differ ONLY in the config — which is what makes the pair able to go red on a
// hook that ignores it.
function configWith(paths) {
  const f = join(mkdtempSync(join(tmpdir(), "cyclercfg-")), "cycler.yaml");
  writeFileSync(f, paths.length
    ? "escapeHatch:\n  paths:\n" + paths.map((x) => "    - " + x).join("\n") + "\n"
    : "escapeHatch:\n  maxFiles: 8\n");
  return { CYCLER_CONFIG: f };
}
const list = (n) => "## Files expected to change\n\n" +
  Array.from({ length: n }, (_, i) => "- `src/f" + i + ".ts`").join("\n") + "\n";

check("another agent's contract must not be the one judged", () => {
  // The contracts directory accumulates every contract a worktree has seen, and any concurrent run
  // writes into it. Picking the NEWEST file (the old `ls -t | head -1`) therefore judged an edit
  // against whatever was touched last: an APL-59 run was refused on an unrelated contract's 11-file
  // count while its own change was 6 files. The issue key in the worktree name is what disambiguates.
  const dir = mkdtempSync(join(ROOT, "APL-59-"));
  mkdirSync(join(dir, ".claude/harness/contracts"), { recursive: true });
  // This run's contract: small, should be allowed.
  writeFileSync(join(dir, ".claude/harness/contracts/apl-59-lint.md"), list(3));
  // A concurrent agent's, written LATER so mtime ordering would pick it, and big enough to refuse.
  writeFileSync(join(dir, ".claude/harness/contracts/harness-token-cut.md"), list(11));

  const r = run(dir, join(dir, "src/f0.ts"));
  assert(r.allowed, "judged against a different agent's contract:\n" + r.msg);
  rmSync(dir, { recursive: true, force: true });
});

check("a small contract is allowed through", () => {
  const d = fixture(list(3));
  assert(run(d, join(d, "src/f0.ts")).allowed, "blocked a 3-file contract");
  rmSync(d, { recursive: true, force: true });
});

check("more than 8 files is blocked", () => {
  const d = fixture(list(13));
  const r = run(d, join(d, "src/f0.ts"));
  assert(!r.allowed, "13-file contract was allowed inline");
  assert(/lists 13 files/.test(r.msg), "message did not name the count:\n" + r.msg);
  rmSync(d, { recursive: true, force: true });
});

check("a path listed in escapeHatch.paths is blocked even when the contract is small", () => {
  // APL-41's other trigger. One file, so the file COUNT cannot be what blocks it — the only thing
  // that can is the configured path.
  const d = fixture("## Files expected to change\n\n- `apps/macOS/App/A.swift`\n");
  const r = run(d, join(d, "apps/macOS/App/A.swift"), configWith(["apps/macOS/**"]));
  assert(!r.allowed, "a configured heavy path was allowed inline");
  assert(/apps\/macOS/.test(r.msg), "message did not name the trigger:\n" + r.msg);
  rmSync(d, { recursive: true, force: true });
});

check("the same small contract is ALLOWED when escapeHatch.paths does not list it", () => {
  // The other half of the pair. Without this, a hook that blocked apps/macOS unconditionally — the
  // hardcoded behaviour cycler replaced — would still pass the case above.
  const d = fixture("## Files expected to change\n\n- `apps/macOS/App/A.swift`\n");
  const r = run(d, join(d, "apps/macOS/App/A.swift"), configWith([]));
  assert(r.allowed, "blocked a path no config names:\n" + r.msg);
  rmSync(d, { recursive: true, force: true });
});

check("an explicit waiver in the contract re-opens it", () => {
  const d = fixture(list(13) + "\n**Escape hatch**: waived — one mechanical rename across 13 files.\n");
  assert(run(d, join(d, "src/f0.ts")).allowed, "waiver was ignored");
  rmSync(d, { recursive: true, force: true });
});

check("markdown and .claude files are never blocked", () => {
  const d = fixture(list(13));
  assert(run(d, join(d, "NOTES.md")).allowed, "blocked a markdown edit");
  rmSync(d, { recursive: true, force: true });
});

check("outside a /task worktree the hook does not fire", () => {
  const d = mkdtempSync(join(tmpdir(), "local-"));
  mkdirSync(join(d, ".claude/harness/contracts"), { recursive: true });
  writeFileSync(join(d, ".claude/harness/contracts/c.md"), list(13));
  assert(run(d, join(d, "src/f0.ts")).allowed, "fired outside a /task worktree");
  rmSync(d, { recursive: true, force: true });
});

process.exit(failed ? 1 : 0);
