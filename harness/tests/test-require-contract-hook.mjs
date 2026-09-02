// require-contract.sh — "you wrote a contract before editing source".
//
// The subtlety is in what identifies "your" contract. A /task worktree is named `claude-APL-15`, so
// the key is in the name. A background agent's worktree is named `agent-<hex>` and carries no key at
// all, and the old fallback matched the WHOLE basename — demanding a contract whose filename
// contained that hex. APL-19 complied by renaming its contract to
// `apl-19-chart-window-agent-a2da24db40cb279e9.md`: the guard was satisfied and the artifact was
// worse. A rule cheaper to game than to meet trains agents to game it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK = process.env.HOOK_SH ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "require-contract.sh");
let failed = 0;
const check = (n, fn) => { try { fn(); console.log(`PASS ${n}`); } catch (e) { failed++; console.log(`FAIL ${n}\n  ${e.message.split("\n")[0]}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const ROOT = join(tmpdir(), "harness-contracthook", ".claude", "worktrees");
mkdirSync(ROOT, { recursive: true });

// Allowed only when the hook exits 0.
let seq = 0;
function allows(wtName, contractName) {
  // NOT mkdtemp: its numeric suffix turned `agent-deadbeef` into `agent-deadbeef-3`, which the key
  // regex read as issue "deadbeef-3" — so the no-key path was never actually exercised. The suffix
  // goes in a parent directory instead, leaving the worktree basename exactly as named.
  const dir = join(mkdtempSync(join(ROOT, "wt-")), wtName);
  seq += 1;
  mkdirSync(join(dir, ".claude/harness/contracts"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  if (contractName) writeFileSync(join(dir, ".claude/harness/contracts", contractName), "# c\n");
  const payload = JSON.stringify({ cwd: dir, tool_input: { file_path: join(dir, "src/a.ts") } });
  try { execFileSync("bash", [HOOK], { input: payload, encoding: "utf8" }); return true; }
  catch { return false; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

check("an agent worktree accepts a sensibly-named contract", () => {
  // `agent-<hex>` carries no issue key. Requiring the filename to contain the hex is what forced the
  // APL-19 rename; any contract proves the discipline this hook exists to enforce.
  assert(allows("agent-deadbeef", "apl-19-chart-window.md"),
    "blocked a real contract because the worktree name had no issue key in it");
});

check("an agent worktree with NO contract is still blocked", () => {
  assert(!allows("agent-deadbeef", null), "allowed source edits with no contract at all");
});

check("a keyed worktree still requires ITS OWN issue's contract", () => {
  assert(allows("claude-APL-15", "apl-15-counts.md"), "blocked the matching contract");
  assert(!allows("claude-APL-15", "apl-99-unrelated.md"),
    "a keyed worktree accepted another issue's contract — the key check is gone");
});

process.exit(failed ? 1 : 0);
