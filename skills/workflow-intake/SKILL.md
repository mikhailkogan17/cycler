---
name: workflow-intake
description: OPTIONAL manual intake, run by hand rather than dispatched — write a task contract by hand, then pass contractPath to /workflow-feature. For full automation just use /workflow-feature directly.
---

# /workflow-intake — manual contract authoring (optional)

For full automation, just use `/workflow-feature` — it authors the contract itself. Use `/workflow-intake` when you want
manual control of the contract before any code runs.

READ `${CLAUDE_PLUGIN_ROOT}/harness/HARNESS.md` and `${CLAUDE_PLUGIN_ROOT}/harness/CONTRACT.md` first.

## Actions (in order)

1. Run `git status --short`. Do NOT touch existing uncommitted changes.
2. Do minimal READ-ONLY probing of the files the request names.
3. Copy `${CLAUDE_PLUGIN_ROOT}/harness/CONTRACT.md` to `.claude/harness/contracts/<slug>.md`.
4. Fill every section from the user's words. If ambiguous, ASK (AskUserQuestion) — do not guess.
   Acceptance checks must be EXACT runnable commands.
5. Show the user the contract + open questions/assumptions. Adjust until they confirm.

## Output

- `.claude/harness/contracts/<slug>.md`.

## Stop condition

- You MUST NOT edit code or run non-read-only commands.
- Once confirmed, tell the user to run `/workflow-feature` with `contractPath` set to this contract.
