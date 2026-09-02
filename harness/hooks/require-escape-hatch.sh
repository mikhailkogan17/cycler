#!/usr/bin/env bash
# PreToolUse hook: a large contract must go through the workflow, not inline.
#
# The process has always said "more than ~8 files, or apps/macOS/**, do NOT continue inline — run
# task-orchestration". APL-41 was thirteen files AND apps/macOS, ran inline anyway, and cost $8.68
# across 331 turns with context peaking at 216k. The hatch was advice, and advice loses.
#
# Why it matters more than agent count: a driver session's context grows monotonically and every later
# turn re-reads every earlier result. A fresh implementer's context stays small and dies with it.
# Measured on APL-41, cache reads were 61% of cost. Splitting the work splits the context.
#
# Scope: ONLY inside /task worktrees, like require-contract.sh — a hook that fires on local edits gets
# switched off within a day.
#
# stdin: PreToolUse JSON. exit 0 = allow, exit 2 = deny (stderr goes back to the model).

set -uo pipefail

# Where this plugin is installed. Derived from this script's own location so it is right
# even when the caller has no CLAUDE_PLUGIN_ROOT in its environment.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

PAYLOAD="$(cat)"

CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
[ -n "$CWD" ] || CWD="$PWD"

case "$CWD" in
  # /task worktrees. This USED to be ~/.cyrus/worktrees/* — when that orchestrator went away the
  # pattern matched nothing and every one of these hooks silently stopped firing. A guard that cannot
  # fire is worse than no guard, because the process still claims it is enforced.
  */.claude/worktrees/*) ;;
  *) exit 0 ;;
esac

# Editing the contract, docs, or harness files is never the thing this guards against.
#
# The exemption must be anchored to THIS worktree. A bare `*/.claude/*` glob matches any path
# containing that segment — and now that worktrees live under `.claude/worktrees/`, every source file
# inside one matched it and the hook allowed everything. The guard silently became a no-op; only the
# tests noticed.
case "$FILE" in
  "$CWD"/.claude/harness/contracts/*|*.md|"$CWD"/.claude/*) exit 0 ;;
esac

# Resolve THIS run's contract by issue key, the way require-contract.sh does.
#
# This used to be `ls -t ... | head -1` — newest wins. The contracts directory holds every contract
# the worktree has ever seen and is written by whatever is running, so "newest" is not "mine": an
# APL-59 run was refused against `harness-token-cut.md`, an unrelated concurrent contract, on a file
# count that had nothing to do with it. Worse, both remedies the refusal offers are edits under
# `.claude/`, so an agent told not to touch the harness cannot comply — and that run got its work
# done through Bash instead, which this matcher does not cover. A guard that fires on the wrong
# contract teaches agents to route around it.
WT_NAME="$(basename "$CWD")"
# Uppercase, 2+ letters: a real key is APL-19. The old case-INSENSITIVE form matched any
# word-dash-digits, so a scratch directory called `agent-deadbeef-3` read as issue "deadbeef-3"
# and the hook then demanded a contract named after it.
ISSUE="$(printf '%s' "$WT_NAME" | grep -oE '[A-Z]{2,}-[0-9]+' | head -1)"
[ -n "$ISSUE" ] || ISSUE="$WT_NAME"
CONTRACTS="$CWD/.claude/harness/contracts"

shopt -s nullglob nocaseglob
MATCHES=("$CONTRACTS"/*"$ISSUE"*.md)
ALL=("$CONTRACTS"/*.md)
shopt -u nullglob nocaseglob

if [ ${#MATCHES[@]} -eq 1 ]; then
  CONTRACT="${MATCHES[0]}"
elif [ ${#ALL[@]} -eq 1 ]; then
  # One contract in the directory is unambiguous whatever the worktree is called.
  CONTRACT="${ALL[0]}"
else
  # Either nothing matches this issue, or several do. Guessing is how the wrong contract got picked
  # in the first place. No contract at all is require-contract.sh's job, not this one.
  exit 0
fi
[ -n "$CONTRACT" ] || exit 0

# An explicit opt-out, so a genuine judgement call is possible without editing the hook. It has to be
# written into the contract, which means it survives into the audit and the PR rather than vanishing.
grep -qi '^ *\*\*Escape hatch\*\*: *\(waived\|not needed\)' "$CONTRACT" && exit 0

# Count the contract's declared files the same way audit.sh does — literally the same code, sourced
# from one file. This comment used to make that claim while the two implementations differed.
# shellcheck source=../contract-section.sh
. "$PLUGIN_ROOT/harness/contract-section.sh"
section() { contract_section "$CONTRACT" "$1"; }
FILES="$(section "Files expected to change")"
[ -n "$FILES" ] || FILES="$(section "Allowed paths")"
COUNT="$(printf '%s\n' "$FILES" | sed '/^$/d' | wc -l | tr -d ' ')"

# cycler.yaml: escapeHatch.maxFiles (default 8) and escapeHatch.paths (default: none). The path list
# is where a repo names the areas that are expensive to work inline — a macOS app might use apps/macOS/**,
# because an Xcode build inside a driver session is the single most context-hungry thing it does.
READ_CFG="$(dirname "$0")/../read-config.mjs"
MAX_FILES="$(node "$READ_CFG" escapeHatch.maxFiles 8 2>/dev/null || echo 8)"
HEAVY_PATHS="$(node "$READ_CFG" escapeHatch.paths '' 2>/dev/null || true)"

HEAVY=0
HEAVY_HIT=""
if [ -n "$HEAVY_PATHS" ]; then
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    # `apps/macOS/**` is a prefix in practice; strip the glob tail and match on it.
    pref="${pat%%\**}"
    if printf '%s\n' "$FILES" | grep -q "^${pref}"; then
      HEAVY=$((HEAVY + 1)); HEAVY_HIT="${HEAVY_HIT:+$HEAVY_HIT, }$pat"
    fi
  done <<< "$HEAVY_PATHS"
fi

if [ "$COUNT" -gt "$MAX_FILES" ] || [ "$HEAVY" -gt 0 ]; then
  REASON=""
  [ "$COUNT" -gt "$MAX_FILES" ] && REASON="the contract lists $COUNT files (limit $MAX_FILES)"
  [ "$HEAVY" -gt 0 ] && REASON="${REASON:+$REASON, and }it touches $HEAVY_HIT"
  cat >&2 <<MSG
Blocked: $REASON, so this issue is past the inline escape hatch.

Do not edit source inline. Run the workflow instead, then go to the report step:

  Workflow({ scriptPath: "$PLUGIN_ROOT/workflows/task-orchestration.js", args: {
    contractPath: "$CONTRACT", cwd: "$CWD",
    issueId: "<ISSUE>", branch: "<BRANCH>", prBase: "$(node "$READ_CFG" repo.base main 2>/dev/null || echo main)",
    worktree: false, linear: false
  }})

Why: one driver session carrying a large change grows its context monotonically, and every later turn
re-reads every earlier tool result. APL-41 ran inline past this same limit — 331 turns, context to
216k, 61% of its cost in cache reads. Separate implementers keep their contexts small and disposable.

If splitting genuinely does not apply here, put this line in the contract and re-try:
  **Escape hatch**: waived — <one sentence saying why>
MSG
  exit 2
fi
exit 0
