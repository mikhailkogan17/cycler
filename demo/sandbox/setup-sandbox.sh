#!/usr/bin/env bash
set -euo pipefail
exec 3>&1
exec 1>&2

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${DEMO_WORK_DIR:-$DEMO_DIR/.work}"
REPO="$WORK/sandbox"
OWNER="${DEMO_GH_OWNER:?set DEMO_GH_OWNER to your GitHub login or organization}"
TARGET="$OWNER/cycler-demo"
[[ "$OWNER" =~ ^[A-Za-z0-9-]+$ ]] || { echo 'invalid DEMO_GH_OWNER' >&2; exit 2; }
mkdir -p "$WORK"

# This proof precedes every destructive GitHub operation.
if gh repo view "$TARGET" --json nameWithOwner,isPrivate --jq '.nameWithOwner + " " + (.isPrivate|tostring)' > "$WORK/repo-identity" 2>/dev/null; then
  read -r FOUND PRIVATE < "$WORK/repo-identity"
  [[ "$FOUND" == "$TARGET" && "$PRIVATE" == false ]] || { echo "refusing reset: expected public $TARGET, got $FOUND private=$PRIVATE" >&2; exit 1; }
else
  gh repo create "$TARGET" --public --description 'Disposable public sandbox for Cycler demo' --disable-issues --confirm
  [[ "$(gh repo view "$TARGET" --json nameWithOwner,isPrivate --jq '.nameWithOwner + " " + (.isPrivate|tostring)')" == "$TARGET false" ]] || exit 1
fi

if [[ ! -d "$REPO/.git" ]]; then
  mkdir -p "$REPO"
  git -C "$REPO" init -b main
  git -C "$REPO" remote add origin "https://github.com/$TARGET.git"
fi
[[ "$(git -C "$REPO" remote get-url origin)" == "https://github.com/$TARGET.git" ]] || { echo 'sandbox origin mismatch' >&2; exit 1; }
git -C "$REPO" fetch origin --tags --prune

if git -C "$REPO" rev-parse -q --verify refs/tags/demo-base >/dev/null; then
  git -C "$REPO" checkout -B main demo-base
  git -C "$REPO" reset --hard demo-base
else
  [[ -z "$(git -C "$REPO" status --porcelain)" ]] || { echo 'untracked sandbox contents before baseline' >&2; exit 1; }
  cp -R "$DEMO_DIR/sandbox/template/." "$REPO/"
  chmod +x "$REPO/.claude/harness/gate.sh"
  git -C "$REPO" add .claude/harness/gate.sh .gitignore package.json package-lock.json tsconfig.json src/slugify.ts test/slugify.test.ts
  git -C "$REPO" commit -m 'Demo baseline'
  git -C "$REPO" tag demo-base
  git -C "$REPO" push origin demo-base
fi

# The target is proven above. Close every open PR, delete only cycler/* branches.
gh pr list -R "$TARGET" --state open --json number --jq '.[].number' | while read -r NUM; do
  [[ -n "$NUM" ]] && gh pr close "$NUM" -R "$TARGET" --comment 'Demo sandbox reset; no merge.'
done
git -C "$REPO" ls-remote --heads origin 'cycler/*' | while read -r _ REF; do
  [[ "$REF" == refs/heads/cycler/* ]] && git -C "$REPO" push origin --delete "${REF#refs/heads/}"
done
git -C "$REPO" push --force origin demo-base:main
git -C "$REPO" checkout -B main demo-base
printf '%s\n' "$REPO" >&3
