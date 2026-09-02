#!/usr/bin/env bash
# $PLUGIN_ROOT/harness/link-workspace.sh <worktree-path> [main-checkout]
#
# Give a git worktree its own node_modules whose WORKSPACE packages point at that worktree.
#
# Why this exists (APL-48 / APL-50 / APL-53 all paid for it):
# in an npm workspace, so `<main>/node_modules/@your-scope/shared` is itself a symlink to
# `<main>/packages/shared`. A worktree that symlinks the WHOLE root node_modules therefore compiles
# its own `src/` against the MAIN checkout's copy of every workspace package. New exports added in
# the worktree appear not to exist:
#
#     Module '"@your-scope/shared"' has no exported member 'somethingYouJustAdded'
#
# ...which reads as a code bug and is not one. AGENTS.md documents the hazard ("Worktree hazard:
# never symlink root node_modules") and prescribes a full per-worktree `npm install`. That is also
# correct but costs a full install per run; this does the same job in about a second by symlinking
# every third-party entry and pointing only the workspace packages at the worktree.
#
# Idempotent: a worktree that already has a real node_modules directory is left alone.

set -uo pipefail

# Where this plugin is installed. Derived from this script's own location so it is right
# even when the caller has no CLAUDE_PLUGIN_ROOT in its environment.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"


W="${1:-}"
if [ -z "$W" ]; then echo "usage: link-workspace.sh <worktree-path> [main-checkout]" >&2; exit 2; fi
if [ ! -d "$W" ]; then echo "link-workspace: worktree '$W' does not exist" >&2; exit 2; fi

# Main checkout: explicit, else the worktree list's first entry (git always lists the main one first).
P="${2:-}"
if [ -z "$P" ]; then
  P="$(git -C "$W" worktree list 2>/dev/null | head -1 | awk '{print $1}')"
fi
if [ -z "$P" ] || [ ! -d "$P/node_modules" ]; then
  echo "link-workspace: main checkout node_modules not found (looked in '${P:-?}')." >&2
  echo "link-workspace: run 'npm install' in the main checkout first." >&2
  exit 3
fi

W_REAL="$(cd "$W" && pwd -P)"
if [ "$W_REAL" = "$(cd "$P" && pwd -P)" ]; then
  echo "link-workspace: '$W' IS the main checkout — nothing to do"
  exit 0
fi

# NOTE the deeper cause, found while building this: worktrees live INSIDE the repo
# (<main>/.claude/worktrees/<name>), so even with NO node_modules at all, Node's upward module
# resolution walks out of the worktree and finds the MAIN checkout's node_modules — including its
# @your-scope/* symlinks pointing at the MAIN packages/*. The `ln -s` this replaces is one way to get
# shadowed; the nesting means a worktree with a missing or partial node_modules is shadowed too.
# So this script is self-healing rather than all-or-nothing: it does not trust a directory being
# present, it checks that each workspace package actually resolves inside THIS worktree.
#
# A symlinked node_modules is the explicitly broken state. Remove the LINK, never its target.
if [ -L "$W/node_modules" ]; then
  echo "link-workspace: replacing symlinked node_modules (the AGENTS.md worktree hazard)"
  rm "$W/node_modules"
fi

# Workspace package names, derived from package.json "workspaces" — never hardcoded, so a new
# package cannot silently keep resolving to the main checkout.
WS_NAMES="$(node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const globs = pkg.workspaces || [];
  const out = [];
  for (const g of globs) {
    const dir = path.join(root, g.replace(/\/\*$/, ""));
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir)) {
      const pj = path.join(dir, e, "package.json");
      if (!fs.existsSync(pj)) continue;
      const name = JSON.parse(fs.readFileSync(pj, "utf8")).name;
      if (name) out.push(name + "\t" + path.join(g.replace(/\/\*$/, ""), e));
    }
  }
  process.stdout.write(out.join("\n"));
' "$W" 2>/dev/null)"

if [ -z "$WS_NAMES" ]; then
  echo "link-workspace: could not read workspaces from $W/package.json" >&2
  exit 4
fi

mkdir -p "$W/node_modules"

# 1. Every third-party entry: a symlink to the main checkout's copy. Includes dotted entries
#    (.bin, .package-lock.json) — .bin is what puts eslint/vitest/danger on npx's path.
SKIP_TOP=""
while IFS="$(printf '\t')" read -r name _reldir; do
  [ -n "$name" ] || continue
  case "$name" in
    @*/*) SKIP_TOP="$SKIP_TOP ${name%%/*}" ;;   # skip the whole scope dir; rebuilt below
    *)    SKIP_TOP="$SKIP_TOP $name" ;;
  esac
done <<< "$WS_NAMES"

linked=0
for entry in "$P"/node_modules/* "$P"/node_modules/.[!.]*; do
  [ -e "$entry" ] || continue
  base="$(basename "$entry")"
  skip=0
  for s in $SKIP_TOP; do [ "$base" = "$s" ] && skip=1; done
  [ $skip -eq 1 ] && continue
  [ -e "$W/node_modules/$base" ] && continue
  ln -s "$entry" "$W/node_modules/$base" && linked=$((linked + 1))
done

# 2. Workspace packages: point at THIS worktree's packages/*.
#
# EVERY write below must land inside $W. A scope directory that is itself a SYMLINK is the trap: on a
# symlinked '@your-scope', `mkdir -p` succeeds silently and the following rm -rf + ln -s write THROUGH
# it into the main checkout, repointing <main>/node_modules/@your-scope/shared at this worktree. That
# is the exact corruption AGENTS.md documents as having cost three tasks a fix round each — except
# inflicted on the main checkout, and left dangling once the worktree is removed. So: never mkdir over
# a symlink, and verify containment before and after.
wslinked=0
while IFS="$(printf '\t')" read -r name reldir; do
  [ -n "$name" ] || continue
  target="$W/$reldir"
  [ -d "$target" ] || continue
  case "$name" in
    @*/*)
      scope="$W/node_modules/${name%%/*}"
      # A symlinked scope dir points somewhere else — almost always the main checkout. Replace the
      # LINK with a real directory; never follow it.
      if [ -L "$scope" ]; then
        echo "link-workspace: '$scope' is a symlink (writes would land in its target) — replacing it with a real directory"
        rm "$scope"
      fi
      mkdir -p "$scope" || { echo "link-workspace: cannot create scope dir '$scope'" >&2; exit 5; }
      ;;
  esac
  link="$W/node_modules/$name"
  # Refuse to write anywhere outside $W, whatever the pre-state was.
  link_parent="$(cd "$(dirname "$link")" 2>/dev/null && pwd -P)"
  case "$link_parent/" in
    "$W_REAL"/*) ;;
    *) echo "link-workspace: refusing to write '$link' — it resolves to '$link_parent', outside the worktree" >&2
       exit 6 ;;
  esac
  rm -rf "$link"
  ln -s "$target" "$link" && wslinked=$((wslinked + 1))
done <<< "$WS_NAMES"

# Post-condition: every workspace link must resolve inside the worktree. Cheap, and it turns a silent
# corruption into a loud failure.
while IFS="$(printf '\t')" read -r name _reldir; do
  [ -n "$name" ] || continue
  link="$W/node_modules/$name"
  [ -L "$link" ] || continue
  dest="$(cd "$(dirname "$link")" && cd "$(readlink "$link")" 2>/dev/null && pwd -P)"
  case "$dest/" in
    "$W_REAL"/*) ;;
    *) echo "link-workspace: POST-CHECK FAILED — $name resolves to '$dest', outside '$W_REAL'" >&2
       exit 7 ;;
  esac
done <<< "$WS_NAMES"

echo "link-workspace: $linked third-party links + $wslinked workspace packages -> $W/packages/*"

# A repo that needs more than node_modules in a fresh worktree — a gitignored config rendered from an
# example, a generated artifact, a native dependency — declares it as `worktree.bootstrap` in
# cycler.yaml. The Branch stage runs it after this script, advisory and never fatal.
#
# It used to live here, hardcoded: one project's Secrets.xcconfig and its `npm run sidecar`. Real
# needs, but that project's, executed in every worktree of every repo that installed the harness.
exit 0
