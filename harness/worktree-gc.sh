#!/usr/bin/env bash
# APL-10 — worktree garbage collection.
#
# Why this exists: nothing removes a worktree when a session ends. They accumulate registered (so
# invisible to a `git worktree list` sanity check), and the moment one is renamed or its admin record goes
# stale, `git worktree prune` deregisters it and the directory becomes an orphan — which is exactly how
# `.claude/worktrees/t3-telegram-notifications.old-<epoch>` came to be 826 MB. `.claude/worktrees/` is
# gitignored now, so orphans regrow silently.
#
# DRY RUN BY DEFAULT. Nothing is removed unless you pass --delete.
#
#   $PLUGIN_ROOT/harness/worktree-gc.sh              # report only
#   $PLUGIN_ROOT/harness/worktree-gc.sh --delete     # actually remove what it reports as removable
#
# What it will never remove:
#   - the worktree you are currently in
#   - a worktree with uncommitted changes
#   - a worktree whose branch has commits not present on any remote (unpushed work)
# Anything in those categories is reported and left alone. When in doubt it keeps the directory: a stale
# 20 MB worktree costs disk, a deleted unpushed branch costs work.

set -euo pipefail

# Where this plugin is installed. Derived from this script's own location so it is right
# even when the caller has no CLAUDE_PLUGIN_ROOT in its environment.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"


DELETE=0
[[ "${1:-}" == "--delete" ]] && DELETE=1

ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
WORKTREE_DIR="$ROOT/.claude/worktrees"
HERE="$(git rev-parse --show-toplevel)"

[[ -d "$WORKTREE_DIR" ]] || { echo "no $WORKTREE_DIR — nothing to do"; exit 0; }

# The "fully pushed" test is `git log --not --remotes`, which is meaningless without remote refs: it
# excludes nothing, so every worktree reads as pushed and would be removed. In a repo with no remote,
# nothing is safe to remove — only true orphans are.
HAS_REMOTES=1
[[ -n "$(git -C "$ROOT" for-each-ref --format='%(refname)' refs/remotes 2>/dev/null)" ]] || HAS_REMOTES=0
[[ "$HAS_REMOTES" == "1" ]] || echo "note: no remote-tracking refs — no worktree can be shown to be pushed, so all are kept."


# Registered worktree paths under .claude/worktrees, one per line (the main working tree is elsewhere).
registered() {
  git -C "$ROOT" worktree list --porcelain \
    | awk '/^worktree /{print substr($0,10)}' \
    | grep -F "$WORKTREE_DIR/" || true
}

kept=0; removable=0; orphans=0

echo "== registered worktrees =="
while IFS= read -r wt; do
  [[ -n "$wt" ]] || continue
  name="$(basename "$wt")"
  size="$(du -sh "$wt" 2>/dev/null | cut -f1)"

  if [[ "$wt" == "$HERE" ]]; then
    echo "  KEEP  $name ($size) — this is the worktree you are in"
    kept=$((kept + 1)); continue
  fi
  if [[ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]]; then
    echo "  KEEP  $name ($size) — uncommitted changes"
    kept=$((kept + 1)); continue
  fi
  if [[ "$HAS_REMOTES" == "0" ]]; then
    echo "  KEEP  $name ($size) — no remote-tracking refs, so nothing can be shown to be pushed"
    kept=$((kept + 1)); continue
  fi
  # Commits reachable from this worktree's HEAD that no remote branch contains = unpushed work.
  unpushed="$(git -C "$wt" log --oneline --not --remotes 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$unpushed" != "0" ]]; then
    echo "  KEEP  $name ($size) — $unpushed commit(s) not on any remote"
    kept=$((kept + 1)); continue
  fi

  if [[ "$DELETE" == "1" ]]; then
    git -C "$ROOT" worktree remove --force "$wt"
    echo "  GONE  $name ($size) — clean and fully pushed"
  else
    echo "  WOULD REMOVE  $name ($size) — clean and fully pushed"
  fi
  removable=$((removable + 1))
done < <(registered)

echo
echo "== orphan directories (present on disk, unknown to git) =="
reg="$(registered)"
shopt -s nullglob
for dir in "$WORKTREE_DIR"/*/; do
  dir="${dir%/}"
  grep -Fxq "$dir" <<< "$reg" && continue
  size="$(du -sh "$dir" 2>/dev/null | cut -f1)"
  orphans=$((orphans + 1))
  if [[ "$DELETE" == "1" ]]; then
    rm -rf "$dir"
    echo "  GONE  $(basename "$dir") ($size)"
  else
    echo "  WOULD DELETE  $(basename "$dir") ($size)"
  fi
done
[[ "$orphans" == "0" ]] && echo "  (none)"

echo
echo "kept $kept, removable $removable, orphaned $orphans"
[[ "$DELETE" == "1" ]] || echo "(dry run — re-run with --delete to apply)"
