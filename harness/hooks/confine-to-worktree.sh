#!/usr/bin/env bash
# PreToolUse hook: a session may not write outside its own worktree.
#
# APL-54 wrote its entire feature into the MAIN checkout -- three modified files and four
# new ones -- while its own worktree stayed clean, zero commits. It was
# found only because an unrelated `git status` showed files nobody in this session had touched. A
# `git add -A` at the wrong moment would have committed a stranger's half-finished feature to main
# under someone else's message.
#
# A dispatcher grants Read on the main checkout on purpose (the worktree needs to resolve the repo), and
# nothing stopped writes following the same path. This is the same class of failure as the node_modules
# shadowing that cost APL-48, APL-50 and APL-53 a round each: work that lands in the other checkout.
#
# Scope: ONLY inside a /task worktree, like the other hooks here.
#
# stdin: PreToolUse JSON. exit 0 = allow, exit 2 = deny (stderr goes back to the model).

set -uo pipefail
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
[ -n "$FILE" ] || exit 0

# Resolve both sides before comparing: a relative path, a symlink, or a ../ escape all have to be
# judged by where they actually land, not by how they were spelled.
abspath() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *)  printf '%s' "$CWD/$1" ;;
  esac
}
TARGET="$(abspath "$FILE")"
# Resolve the deepest existing DIRECTORY on the path, never the file itself: `cd` only resolves
# directories, so probing the file leaves the spelled path intact and a symlinked parent directory
# then reads as local. `worktree/link/b.ts`, where `link` points at another checkout, is the case.
probe="$(dirname "$TARGET")"
while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe="$(dirname "$probe")"; done
REAL_PROBE="$(cd "$probe" 2>/dev/null && pwd -P || printf '%s' "$probe")"
REAL_CWD="$(cd "$CWD" 2>/dev/null && pwd -P || printf '%s' "$CWD")"

case "$REAL_PROBE/" in
  "$REAL_CWD"/*) exit 0 ;;
esac

# Plan mode's plan file. It lives at ~/.claude/plans/<slug>.md by design and is the ONLY file plan
# mode permits writing — so blocking it does not confine a session, it makes planning impossible in
# any worktree. Found the hard way: this hook denied the plan for its own fix, and the fix could not
# be made from inside plan mode either. A guard whose failure mode is deadlock is a bug.
#
# Safe to exempt: a plan file is not repo state. It reaches no branch, no gate and no PR, which is
# exactly the reasoning the message below uses to REFUSE other outside paths.
case "$TARGET" in
  "$HOME"/.claude/plans/*.md) exit 0 ;;
esac

# Writing into someone else's tree is never what a worktree session means to do.
cat >&2 <<MSG
Blocked: that path is outside this session's worktree.

  target:   $TARGET
  resolves: $REAL_PROBE
  worktree: $REAL_CWD

Work only inside the worktree. Its checkout is what the branch, the gate and the PR are built from —
edits anywhere else are invisible to all three, and land in a tree another session may be committing.

APL-54 did exactly this: its whole feature went into the main checkout while its worktree stayed
empty. Nothing was lost only because the stray files happened to be noticed.

If you need something from the main checkout, read it and copy it in.
MSG
exit 2
