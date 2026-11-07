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
# Scope: ONLY inside a /workflow-feature worktree, like the other hooks here.
#
# stdin: PreToolUse JSON. exit 0 = allow, exit 2 = deny (stderr goes back to the model).

set -uo pipefail
PAYLOAD="$(cat)"

CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
[ -n "$CWD" ] || CWD="$PWD"

case "$CWD" in
  # /workflow-feature worktrees. This USED to be ~/.cyrus/worktrees/* — when that orchestrator went away the
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
REAL_CWD="$(cd "$CWD" 2>/dev/null && pwd -P || printf '%s' "$CWD")"
REAL_HOME="$(cd "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")"

# A ../ after a component that does not exist cannot be resolved by `cd`, so the probe below would skip
# it: `worktree/zz/../../x.ts` probed as the worktree while it lands in its parent. A tool may also
# normalize the path lexically before writing, while the kernel resolves .. physically through symlinks.
# So the path is judged twice, as spelled (physical) and normalized (lexical), and both must pass.
normpath() {
  local rest="$1" out="" seg
  while [ -n "$rest" ]; do
    seg="${rest%%/*}"
    if [ "$seg" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
    case "$seg" in
      "" | .) ;;
      ..) out="${out%/*}" ;;
      *) out="$out/$seg" ;;
    esac
  done
  printf '%s' "${out:-/}"
}

# decide PATH: exit status 0 if PATH may be written. Sets REAL_PROBE for the message below.
decide() {
  local target="$1" parent probe
  parent="$(dirname "$target")"
  # Resolve the deepest existing DIRECTORY on the path, never the file itself: `cd` only resolves
  # directories, so probing the file leaves the spelled path intact and a symlinked parent directory
  # then reads as local. `worktree/link/b.ts`, where `link` points at another checkout, is the case.
  probe="$parent"
  while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe="$(dirname "$probe")"; done
  # -P: a plain `cd` resolves .. LOGICALLY, so `cd link/..` comes back to where it started.
  REAL_PROBE="$(cd -P "$probe" 2>/dev/null && pwd -P || printf '%s' "$probe")"

  case "$REAL_PROBE/" in
    "$REAL_CWD"/*) return 0 ;;
  esac

  # The exemptions below are .md files only, never through a symlinked file, and direct children of
  # an EXISTING directory: when the probe had to climb, the path was not resolved, so it does not count.
  case "$target" in *.md) ;; *) return 1 ;; esac
  [ -L "$target" ] && return 1

  # Plan mode's plan file. It lives at ~/.claude/plans/<slug>.md by design and is the ONLY file plan
  # mode permits writing — so blocking it does not confine a session, it makes planning impossible in
  # any worktree. Found the hard way: this hook denied the plan for its own fix, and the fix could not
  # be made from inside plan mode either. A guard whose failure mode is deadlock is a bug.
  #
  # Safe to exempt: a plan file is not repo state. It reaches no branch, no gate and no PR, which is
  # exactly the reasoning the message below uses to REFUSE other outside paths.
  #
  # Judged by the RESOLVED directory, not the spelling: a case glob's * crosses /, so the old literal
  # match let ~/.claude/plans/../../x.md and ~/.claude/plans/sub/x.md through. Plan mode creates the
  # directory with the first plan, so a missing ~/.claude/plans is accepted when the path is spelled
  # exactly and its nearest existing ancestor is home or ~/.claude.
  if [ "$probe" = "$parent" ]; then
    [ "$REAL_PROBE" = "$REAL_HOME/.claude/plans" ] && return 0
  elif [ "$parent" = "$HOME/.claude/plans" ] && [ ! -L "$parent" ]; then
    case "$REAL_PROBE" in "$REAL_HOME" | "$REAL_HOME/.claude") return 0 ;; esac
  fi

  # Auto-memory notes. They live at ~/.claude/projects/<project>/memory/<name>.md by design, and the
  # harness tells every session to write them there, so blocking them makes memory unusable from any
  # worktree. Same reasoning as the plan file: not repo state, reaches no branch, no gate and no PR.
  # Judged by the resolved directory, so a ../ escape or a symlinked directory does not qualify.
  local memory_parent="${REAL_PROBE%/memory}"
  if [ "$probe" = "$parent" ] && [ "$memory_parent" != "$REAL_PROBE" ] \
    && [ "$(dirname "$memory_parent")" = "$REAL_HOME/.claude/projects" ]; then
    return 0
  fi
  return 1
}

decide "$(normpath "$TARGET")" && decide "$TARGET" && exit 0

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
