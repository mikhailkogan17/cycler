---
name: workflow-bug
description: The workflow a dispatched session runs for a BUG — the same lifecycle as workflow-feature, entered in fix mode: the failing test comes before the fix. Auto-commits, opens a PR, never merges.
---

## Runtime compatibility (read first)

These instructions apply to Claude Code, Codex and DeepSeek Harness (`dsh`). Resolve
`CYCLER_ROOT` from the environment, `CLAUDE_PLUGIN_ROOT`, or this skill's directory (`../..`).
`CLAUDE_PLUGIN_ROOT` in the legacy instructions below is a compatibility alias for that root;
`CLAUDE_CODE_SESSION_ID` may be replaced with `CYCLER_SESSION_ID` or the current runtime session ID.
Use the tools available in your runtime; `ToolSearch` is not a prerequisite for research or Linear.

When the native `Workflow` tool is unavailable (Codex, dsh, or a Claude install without it),
run the SAME lifecycle through the portable runner and report its result:

```bash
node "$CYCLER_ROOT/workflows/run.mjs" --runtime '<claude|codex|dsh>' --cwd "$PWD" --workflow workflow-bug --task '<complete request or issue key>'
```

Pass `--contract <path>` to reuse a contract; `--no-commit` leaves changes for inspection.
Do not continue into the native `Workflow(...)` instructions after this runner completes.
The runner owns independent stages, gate enforcement, GitHub comments and implementer replies.



# /workflow-bug — an alias for `/workflow-feature`, entered in fix mode

**This skill is not a second workflow.** It runs `/workflow-feature` end to end. It exists so that a
`Bug` label has a route of its own on the board, and so the run starts already knowing which mode it
is in.

## What to do

1. **Post the start comment first** — before anything else, exactly as `/workflow-feature` step 3
   does. A dispatched run that posts nothing is declared dead by the poller and re-dispatched, and
   the alias must not be the reason that happens:

```bash
"${CLAUDE_PLUGIN_ROOT}/poller/lin" issue comment list <KEY> | grep -q 'workflow run started' \
  || "${CLAUDE_PLUGIN_ROOT}/poller/lin" issue comment add <KEY> --body "'bug' workflow run started in session \`${CLAUDE_CODE_SESSION_ID:0:8}\`."
```

2. **READ `${CLAUDE_PLUGIN_ROOT}/skills/workflow-feature/SKILL.md` and follow it from step 1**, with
   the same inputs you were given. Skip its step 3 — you have already posted the start comment.
3. **Read `${CLAUDE_PLUGIN_ROOT}/harness/modes/fix.md`** and work in that mode. The contract's
   acceptance check is a test that **fails on the current code and passes after the fix**. A fix
   whose regression test passes before the change has not been shown to fix anything.

## Why an alias and not a workflow

The two would be the same file. Copying `workflow-feature` here to have a `Bug` route would mean
every later change to the lifecycle has to land in two places, and the copy that gets missed is the
one nobody runs interactively — it would drift silently and be found by a user. Routing is what
wanted to distinguish bugs, and routing is where the distinction lives: the label picks this skill,
this skill picks the mode.

If a bug ever needs a genuinely different lifecycle — a reproduction stage before contracting, say —
this is the file that grows it, and no route has to be renamed for that to happen.
