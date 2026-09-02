#!/usr/bin/env bash
# PreToolUse hook: no commit without a green gate for THIS exact tree.
#
# The chokepoint that matters. However the bytes arrived — Edit, Write, or a shell redirect that
# slipped past the edit hook — they do not become a commit unless gate.sh passed on the current
# working tree. gate.sh writes the marker; this compares it against the tree as it stands now.
#
# Scope: ONLY inside /task worktrees. exit 0 = allow, exit 2 = deny.

set -uo pipefail

# Where this plugin is installed. Derived from this script's own location so it is right
# even when the caller has no CLAUDE_PLUGIN_ROOT in its environment.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

PAYLOAD="$(cat)"

CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$CWD" ] || CWD="$PWD"

case "$CWD" in
  # /task worktrees. This USED to be ~/.cyrus/worktrees/* — when that orchestrator went away the
  # pattern matched nothing and every one of these hooks silently stopped firing. A guard that cannot
  # fire is worse than no guard, because the process still claims it is enforced.
  */.claude/worktrees/*) ;;
  *) exit 0 ;;
esac

# Only guard commits. Everything else passes straight through.
# Match `git ... commit` anywhere in the command, including compound forms and flags that take a
# separate value (`git -c user.name=x commit`, `git -C path commit`). An earlier pattern only allowed
# single-token flags and let `git -c user.name=y commit` straight through — a false negative here is
# an ungated commit, so this errs toward matching. `git log --grep=commit` is unaffected (no space
# before `commit`); a rare false positive costs one clear error message, which is the cheap direction.
printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+([^;&|]*[[:space:]]+)?commit([[:space:]]|$)' || exit 0

MARKER="$CWD/.test-results/gate/last-pass"
if [ ! -f "$MARKER" ]; then
  cat >&2 <<MSG
BLOCKED by the harness: the gate has not passed in this worktree.

Run it, and fix anything red:
  CONTRACT_PATH=<your contract> bash $PLUGIN_ROOT/harness/gate.sh --fast --base main

A commit that skips the gate is the failure this harness exists to prevent — and note that
'danger local' exits 0 even when it fails the build, so a hand-rolled check is not a substitute.
MSG
  exit 2
fi

# The marker is bound to the exact tree that passed. Any edit since then invalidates it.
NOW="$(bash "$PLUGIN_ROOT/harness/tree-fingerprint.sh" "$CWD")"
WAS="$(cat "$MARKER" 2>/dev/null | tr -d '[:space:]')"

if [ "$NOW" = "$WAS" ]; then
  exit 0
fi

cat >&2 <<MSG
BLOCKED by the harness: the tree changed since the last green gate, so that result no longer applies.

Re-run it:
  CONTRACT_PATH=<your contract> bash $PLUGIN_ROOT/harness/gate.sh --fast --base main

(The marker binds a gate pass to the exact diff that passed. Editing after a green run and then
committing is how an unverified change reaches a PR looking verified.)
MSG
exit 2
