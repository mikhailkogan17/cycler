#!/usr/bin/env bash
# harness/tree-fingerprint.sh — hash the WORKING TREE state that a gate result is bound to.
#
# One implementation, called by the gates and by require-green-gate.sh. Two copies of this would
# drift, and a fingerprint that disagrees with itself blocks every commit with a message about the
# tree having changed when nothing changed at all.
#
# INDEX-INDEPENDENT on purpose. The previous version concatenated `git diff HEAD`, `git diff --cached`
# and the untracked file list, so `git add` alone changed the hash: an untracked file moved out of the
# --others list and into --cached, and a tracked one appeared in --cached where it had been absent.
# That made the ordinary sequence — run the gate, stage, commit — fail every time, with a message
# claiming an edit that never happened. Staging is not an edit; only content is.
#
# So: take every path that differs from HEAD or is untracked, in sorted order, and hash the path plus
# its working-tree content. Same content, same hash, whatever the index looks like.

set -uo pipefail
cd "${1:-.}" || exit 1

{
  {
    git diff --name-only HEAD 2>/dev/null
    git diff --name-only --cached 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u | while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s\n' "$f"
    # A deleted file has no content to hash; its presence in the path list is the signal.
    # `|| true`: a false test would otherwise be the loop body's exit status, and with pipefail that
    # fails the whole fingerprint on any deleted file.
    [ -f "$f" ] && cat -- "$f" || true
  done
} | shasum -a 256 | awk '{print $1}'
