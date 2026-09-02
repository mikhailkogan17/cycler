#!/usr/bin/env bash
# Deterministic half of the audit. Replaces most of what an audit agent was spawned to eyeball.
#
# Five of the six audit questions are arithmetic on the diff and the contract — files outside Allowed
# paths, anything in Forbidden paths, the contract file being edited by the run it governs, generated
# or secret files, and scope against "Files expected to change". Only "are the acceptance checks
# genuinely met" needs judgement.
#
# Paying ~39k of cold-start context for a model to re-derive the arithmetic is the same waste gate.sh
# removed from the verify step, with the same fix: compute it, print one line per check, and leave the
# agent only the part that actually needs reading comprehension.
#
# Usage: CONTRACT_PATH=<contract> audit.sh [--base main]
set -uo pipefail

BASE="main"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; [ -n "$BASE" ] || { echo "--base needs a value" >&2; exit 2; }; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "${CONTRACT_PATH:-}" ] || { echo "audit: CONTRACT_PATH is not set — every path check would silently pass" >&2; exit 2; }
[ -f "$CONTRACT_PATH" ]     || { echo "audit: no contract at $CONTRACT_PATH" >&2; exit 2; }

REF="origin/$BASE"; git rev-parse --verify -q "$REF" >/dev/null || REF="$BASE"

# Skip the whole thing when nothing has changed since the last clean run. The audit is a pure function
# of (diff, contract), so re-running it on an identical tree can only produce the identical answer.
# gate.sh already computed a tree fingerprint for the commit hook but never read it back to skip work,
# which is why it re-ran ten times in APL-41. Same idea, wired up this time.
#
# The contract is part of the key: editing Allowed paths must invalidate a previous CLEAN.
fingerprint() {
  { git diff "$REF"...HEAD; git status --porcelain; cat "$CONTRACT_PATH"; } 2>/dev/null | shasum -a 256 | awk '{print $1}'
}
FP=$(fingerprint)
STAMP=".test-results/audit/last-clean"
if [ "${AUDIT_NO_CACHE:-0}" != "1" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$FP" ]; then
  echo "AUDIT: CLEAN (cached — diff and contract unchanged since the last clean run)"
  echo "Not checked here — needs an agent: are the acceptance checks genuinely met?"
  exit 0
fi

# Changed files: committed against the base, plus anything still in the working tree.
# -uall is load-bearing: without it `git status --porcelain` collapses a wholly-untracked directory to
# a single "tests/" entry. Every path check here compares against FILE globs, so a run that adds a new
# file inside a new directory was reported as touching a path outside Allowed paths — naming a
# directory the contract could not have listed. Another false DIRTY indistinguishable from a real one.
CHANGED=$( { git diff --name-only "$REF"...HEAD; git status --porcelain -uall | sed 's/^...//'; } | sed '/^$/d' | sort -u )

# Contract sections are bullet lists of globs; read until the next heading.
# Take the backticked path out of each bullet. Contracts label entries ("New: `a/b.swift`",
# "Modified: `c.ts`"), so stripping only the bullet marker leaves the label glued to the path and
# every such entry then reads as "outside Allowed paths". That false positive is worse than no check:
# it trains the next reader to skim past a DIRTY line.
# Only BULLET lines are path declarations. A section also contains prose, and prose contains
# backticks — that is what a good contract looks like. APL-55 wrote a Risks-style paragraph inside
# Forbidden paths explaining WHY it was touching `apps/macOS/**`, and audit.sh read that explanation
# as a forbidden glob and reported DIRTY on the very files the contract allowed. Moving the paragraph
# made the identical tree CLEAN. So the check punished the author for explaining themselves, which is
# the opposite of what this harness wants: the fix is to read declarations, not sentences.
# shellcheck source=contract-section.sh
. "$(dirname "${BASH_SOURCE[0]}")/contract-section.sh"
section() { contract_section "$CONTRACT_PATH" "$1"; }
ALLOWED=$(section "Allowed paths"); FORBIDDEN=$(section "Forbidden paths")
EXPECTED_FILES=$(section "Files expected to change")

# APL-65: a Forbidden bullet is often a broad glob with a prose exception —
#   "any test file NOT listed under Files expected to change (... and every other `apps/x/Tests/*`)"
# section() reads declarations, not sentences, so it cannot see the qualifier and applied the glob
# unconditionally. audit.sh then reported forbidden-paths DIRTY on the very files the SAME contract's
# Allowed paths, Files expected to change and acceptance checks all required the run to modify.
#
# That is a false DIRTY indistinguishable from a real scope violation, which is the failure this
# script's own comments call worse than no check at all.
#
# The rule is deliberately narrow: an EXACT path under "Files expected to change" beats a forbidden
# pattern containing a wildcard. It never beats an exact forbidden path — "never touch this specific
# file" stays absolute, or the Files-expected list becomes a way to launder any path.
forbid_reason() {  # $1 = path; echoes the matching forbid glob, or nothing
  local p="$1" g
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    case "$p" in $g) printf '%s' "$g"; return 0 ;; esac
  done <<< "$FORBIDDEN"
  return 1
}
is_expected() {  # $1 = path; exact (not glob) membership of "Files expected to change"
  [ -n "$EXPECTED_FILES" ] && printf '%s\n' "$EXPECTED_FILES" | grep -Fxq -- "$1"
}
is_forbidden() {  # $1 = path
  local g
  g="$(forbid_reason "$1")" || return 1
  case "$g" in
    *'*'*|*'?'*|*'['*)  # a pattern: an explicit listing overrides it
      is_expected "$1" && return 1 ;;
  esac
  return 0
}

matches_any() {  # $1 = path, $2 = newline-separated globs
  local p="$1" g
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    case "$p" in $g) return 0 ;; esac
    case "$p" in ${g%/}/*) return 0 ;; esac
  done <<< "$2"
  return 1
}

fails=0
report() { # name, offending list
  if [ -n "$2" ]; then
    echo "AUDIT $1  DIRTY"; echo "$2" | sed 's/^/  /'; fails=$((fails + 1))
  else
    echo "AUDIT $1  clean"
  fi
}

outside=""; forbidden=""; generated=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -n "$ALLOWED" ] && ! matches_any "$f" "$ALLOWED" && outside="$outside$f"$'\n'
  [ -n "$FORBIDDEN" ] && is_forbidden "$f" && forbidden="$forbidden$f"$'\n'
  case "$f" in
    node_modules/*|dist/*|build/*|*.log|.env*|config.local.yaml*|memory/profiles/*|memory/cvs/*|memory/apply-logs/*)
      generated="$generated$f"$'\n' ;;
  esac
done <<< "$CHANGED"

report "allowed-paths " "$(echo "$outside" | sed '/^$/d')"
report "forbidden-paths" "$(echo "$forbidden" | sed '/^$/d')"
report "generated/secret" "$(echo "$generated" | sed '/^$/d')"

# The contract must not be edited by the run it governs — that is how a diff "meets" its own checks.
report "contract-intact" "$(echo "$CHANGED" | grep -F "$(basename "$CONTRACT_PATH")" || true)"

# Scope: compare against the contract's own file list.
EXPECTED=$(section "Files expected to change" | wc -l | tr -d ' ')
ACTUAL=$(echo "$CHANGED" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$EXPECTED" -gt 0 ] && [ "$ACTUAL" -gt $((EXPECTED * 2)) ]; then
  echo "AUDIT scope          DIRTY"; echo "  contract lists $EXPECTED file(s); the diff touches $ACTUAL"; fails=$((fails + 1))
else
  echo "AUDIT scope          clean  ($ACTUAL changed, $EXPECTED listed)"
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "AUDIT: DIRTY ($fails of 5)"
  rm -f "$STAMP" 2>/dev/null
else
  echo "AUDIT: CLEAN (5 of 5)"
  mkdir -p .test-results/audit 2>/dev/null && printf '%s' "$FP" > "$STAMP" 2>/dev/null
fi
echo "Not checked here — needs an agent: are the acceptance checks genuinely met?"
[ "$fails" -gt 0 ] && exit 1 || exit 0
