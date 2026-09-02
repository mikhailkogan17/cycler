#!/usr/bin/env bash
# File a contract's "## Follow-ups" entries as Linear issues, via linear-cli.
#
# The process asks the implementer to file these at PR time. It often cannot: the Linear MCP does not
# reliably connect in a dispatched session, so `mcp__linear__*` may simply not exist. APL-54 hit that
# and ended its report with "please file this manually" — and since the review contract lens treats a
# confirmed-but-unfiled defect as BLOCKING, the process was unsatisfiable by construction.
#
# `~/bin/lin` is a plain CLI: present or absent, never half-connected.
#
# Usage: file-followups.sh <CONTRACT_PATH> <ISSUE> [--dry-run]
set -uo pipefail

CONTRACT="${1:-}"; ISSUE="${2:-}"; DRY=0
[ "${3:-}" = "--dry-run" ] && DRY=1
[ -n "$CONTRACT" ] && [ -n "$ISSUE" ] || { echo "usage: $(basename "$0") <contract> <ISSUE> [--dry-run]" >&2; exit 2; }
[ -f "$CONTRACT" ] || { echo "file-followups: no contract at $CONTRACT" >&2; exit 3; }

LIN="${LIN:-$HOME/bin/lin}"
[ -x "$LIN" ] || { echo "file-followups: $LIN missing — cannot file, NOT silently skipping" >&2; exit 4; }
TEAM="${ISSUE%%-*}"

BODY="$(sed -n '/^## *Follow-ups/,/^## /p' "$CONTRACT" | sed '1d;$d')"
[ -n "$(printf '%s' "$BODY" | tr -d '[:space:]')" ] || { echo "file-followups: no follow-ups in $CONTRACT"; exit 0; }

# At most 3: needing a fourth means the contract was wrong, which is worth saying rather than filing
# around. Each bullet is one follow-up; its first line becomes the title.
printf '%s\n' "$BODY" | grep -E '^[-*] ' | head -3 | while IFS= read -r item; do
  title="$(printf '%s' "$item" | sed 's/^[-*] *//' | cut -c1-120)"
  [ -n "$title" ] || continue

  # Search first so a re-run, or a human who already filed it, does not produce a duplicate. Match on
  # a prefix of the title: the full string contains punctuation and file:line that will not survive a
  # round trip through Linear's renderer.
  needle="$(printf '%s' "$title" | cut -c1-40)"
  if "$LIN" issue query --team "$TEAM" --all-states 2>/dev/null | grep -qiF "$needle"; then
    echo "SKIP  already filed: $title"; continue
  fi

  desc="Filed by the harness from ${ISSUE}'s contract follow-ups.

$item

<!-- filed-by-harness:${ISSUE} -->"

  if [ "$DRY" = 1 ]; then echo "DRY   would file (triage): $title"; continue; fi

  # --description-file, not -d: the body is markdown with backticks, newlines and code spans, and
  # passing that through a shell argument mangles it.
  df="$(mktemp -t followup)"; printf '%s\n' "$desc" > "$df"
  # Triage, not Backlog: these are agent-proposed and deserve a human pass before they join the board.
  out="$("$LIN" issue create --team "$TEAM" --title "$title" --description-file "$df" --state triage 2>&1)"
  rm -f "$df"
  if printf '%s' "$out" | grep -qiE '[A-Z]+-[0-9]+'; then
    echo "FILED $(printf '%s' "$out" | grep -oiE 'https://[^ ]+|[A-Z]+-[0-9]+' | head -1): $title"
  else
    # Loud, not silent: an unfiled follow-up is the exact loss this script exists to prevent.
    echo "FAIL  could not file: $title" >&2
    printf '%s\n' "$out" | head -3 | sed 's/^/      /' >&2
  fi
done
