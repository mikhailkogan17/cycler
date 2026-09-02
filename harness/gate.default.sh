#!/usr/bin/env bash
# $PLUGIN_ROOT/harness/gate.default.sh — cycler's default gate.
#
# Used only when the repo has no .claude/harness/gate.sh of its own. See harness/gate.sh (resolver).
#
# ONE command that answers "is this diff green". It replaces a prompt that asked a model to decide
# which checks applied, consolidate them to "<= 6, never more than 10", and run them — reasoning paid
# for on every gate round of every task to arrive at nearly the same answer each time.
#
# OUTPUT CONTRACT (load-bearing — this is what makes the calling agent cheap):
#   * a passing check prints exactly ONE line
#   * only failures print detail, capped at --tail lines
#   * the final line is always  GATE: PASS|FAIL (n of m)
#   * exit 0 only when every check that ran passed
# Wall-clock is nearly free in tokens; OUTPUT is not. Keep it that way.
#
# Usage:
#   $PLUGIN_ROOT/harness/gate.sh [--fast|--full] [--base <ref>] [--tail <n>] [--only <check>]
#
#   --fast (default)  lint + build + test
#   --full            the same set; a repo's own gate is where a slower full mode belongs
#
# CONTRACT_PATH is passed through for repo gates that check the diff against the contract.

set -uo pipefail

# Where this plugin is installed. Derived from this script's own location so it is right
# even when the caller has no CLAUDE_PLUGIN_ROOT in its environment.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"


MODE=fast
BASE=main
TAIL_LINES=20
ONLY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --fast) MODE=fast; shift ;;
    --full) MODE=full; shift ;;
    --base|--tail|--only)
      # `shift 2` with only one argument left does NOT shift and returns non-zero, so the while loop
      # spins forever. A gate that hangs is worse than one that errors.
      if [ $# -lt 2 ]; then echo "gate.sh: $1 requires a value" >&2; exit 2; fi
      case "$1" in
        --base) BASE="$2" ;;
        --tail) TAIL_LINES="$2" ;;
        --only) ONLY="$2" ;;
      esac
      shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "gate.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then echo "GATE: FAIL (not inside a git repository)"; exit 2; fi
cd "$REPO_ROOT" || { echo "GATE: FAIL (cannot cd to $REPO_ROOT)"; exit 2; }

# Resolve the base ref. A base that does not exist must be said out loud, not silently treated as
# "nothing changed" — that would make the gate pass by reviewing an empty diff.
# origin/<base> is preferred over the local branch: a PR is diffed against the REMOTE base, and a
# stale local `main` silently inflates the changed-file set with other people's merged work. Measured
# while building this: local main was 3 commits behind, so `main...HEAD` reported 17 changed files
# where `origin/main...HEAD` correctly reported 0.
case "$BASE" in
  origin/*) ;;
  *)
    if git rev-parse --verify -q "origin/$BASE" >/dev/null 2>&1; then
      BASE="origin/$BASE"
    fi
    ;;
esac
if ! git rev-parse --verify -q "$BASE" >/dev/null 2>&1; then
  echo "NOTE base ref '$BASE' not found — comparing against HEAD only (uncommitted changes)"
  BASE=""
fi

# ---- changed files -----------------------------------------------------------------------------
# Committed-since-base + unstaged + staged, deduped, existing files only (--diff-filter=d drops
# deletions: linting a file that no longer exists is a guaranteed spurious red).
# NOTE two lists. `--diff-filter=d` (drop deletions) is right for LINTERS — linting a file that no
# longer exists is a guaranteed spurious red. It is WRONG for danger: filtering deletions out of the
# set staged for review makes the forbidden-paths / scope net blind to a file being DELETED, which is
# the most destructive out-of-scope change there is. So danger gets its own list, deletions included.
# WORKING-TREE changes only, deletions included. Deliberately NOT "$BASE...HEAD": that set contains
# files this branch's own commits DELETED, which no longer exist and are already recorded in HEAD.
# `git add` aborts the WHOLE invocation on one unmatchable pathspec
# ("fatal: pathspec '...' did not match any files", exit 128), so including them staged NOTHING —
# danger then reviewed an empty index and reported PASS. Committed changes need no staging anyway.
CHANGED_ALL_LIST="$(
  {
    git diff --name-only HEAD 2>/dev/null
    git diff --name-only --cached 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u
)"
CHANGED_LIST="$(
  {
    [ -n "$BASE" ] && git diff --name-only --diff-filter=d "$BASE...HEAD" 2>/dev/null
    git diff --name-only --diff-filter=d HEAD 2>/dev/null
    git diff --name-only --diff-filter=d --cached 2>/dev/null
    # Untracked-but-not-ignored files: a brand-new source or test file is invisible to `git diff`,
    # so without this a new file would silently skip every check.
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u
)"

CHANGED=()
CHANGED_ALL=()
CHANGED_TS=()
CHANGED_SWIFT=()
# Everything under apps/macOS, not only .swift. The Swift SUITE's inputs are wider than its sources:
# snapshot baselines, JSON fixtures, Assets, project.yml, xcconfig. Gating the suite on .swift alone
# meant a change to any of those skipped the very tests it was about — APL-57 re-recorded a snapshot
# baseline and `--full` reported PASS having never run a Swift test (APL-63).
CHANGED_MACOS=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  CHANGED_ALL+=("$f")
done <<< "$CHANGED_ALL_LIST"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -e "$f" ] || continue
  CHANGED+=("$f")
  case "$f" in
    *.ts|*.tsx) CHANGED_TS+=("$f") ;;
    *.swift)    CHANGED_SWIFT+=("$f") ;;
  esac
  case "$f" in
    apps/macOS/*) CHANGED_MACOS+=("$f") ;;
  esac
done <<< "$CHANGED_LIST"

# B2: `vitest related` prints "No test files found" and EXITS 0 when nothing is related to the changed
# files — a green `tests` line for a run that executed nothing. Fall back to the full suite instead.
# Exported so it is visible inside run_check's `bash -c`.
gate_tests_fast() {
  _t_out="$(npx --no-install vitest related --run "$@" 2>&1)"
  _t_code=$?
  printf '%s\n' "$_t_out"
  if printf '%s' "$_t_out" | grep -q 'No test files found'; then
    echo ">>> gate.sh: 'vitest related' matched no test files for the changed .ts files."
    echo ">>> Falling back to the FULL suite — a green line for zero tests is silent under-testing."
    # A PASSING check prints no detail, so without this sentinel the fallback would be invisible on
    # success — and "we quietly ran something else" is exactly what this gate must never do.
    [ -n "${GATE_FALLBACK_FLAG:-}" ] && : > "$GATE_FALLBACK_FLAG"
    npx --no-install vitest run
    return $?
  fi
  return $_t_code
}
export -f gate_tests_fast
GATE_FALLBACK_FLAG="$(mktemp -t gatefb)"; rm -f "$GATE_FALLBACK_FLAG"
export GATE_FALLBACK_FLAG

PASSED=0
FAILED=0
RAN=0
SKIPPED=()
FAILED_NAMES=()

# run_check <name> <shell command string> [fail-pattern]
#
# fail-pattern exists because not every tool reports failure through its exit code. `danger local`
# prints "Failing the build, there is 1 fail." and then exits 0 — measured, not assumed. Trusting the
# exit code alone made danger ADVISORY: its secrets / forbidden-paths / generated-files checks could
# never block a run. A check that cannot fail is worse than no check, because it reads as coverage.
run_check() {
  _name="$1"; _cmd="$2"; _failpat="${3:-}"
  # --only <name> narrows the gate to one check. Used by `npm run gate:diff`, and by an agent
  # re-running just the check that failed instead of the whole gate.
  if [ -n "$ONLY" ] && [ "$ONLY" != "$_name" ]; then return 0; fi
  _start=$SECONDS
  _out="$(mktemp -t gate)"   # macOS mktemp; GNU coreutils would need a XXXXXX template
  bash -c "$_cmd" >"$_out" 2>&1
  _code=$?
  if [ -n "$_failpat" ] && [ $_code -eq 0 ] && grep -qE "$_failpat" "$_out"; then
    _code=1
    printf 'NOTE %s reported failure in its output but exited 0 — treated as FAIL\n' "$_name"
  fi
  _dur=$((SECONDS - _start))
  RAN=$((RAN + 1))
  if [ $_code -eq 0 ]; then
    printf 'CHECK %-12s PASS  %ss\n' "$_name" "$_dur"
    PASSED=$((PASSED + 1))
  else
    printf 'CHECK %-12s FAIL  %ss (exit %s)\n' "$_name" "$_dur" "$_code"
    printf '  $ %s\n' "$_cmd"
    tail -n "$TAIL_LINES" "$_out" | sed 's/^/  /'
    # Keep the FULL log for a failed check. The tail is what the agent reads; the whole log is what a
    # human needs when a check fails intermittently and the next run is green. Caller truncation of
    # this script's stdout must not be able to destroy the evidence.
    mkdir -p .test-results/gate 2>/dev/null
    if cp "$_out" ".test-results/gate/$_name.log" 2>/dev/null; then
      printf '  (full log: .test-results/gate/%s.log)\n' "$_name"
    fi
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$_name")
  fi
  rm -f "$_out"
}

skip_check() {
  if [ -n "$ONLY" ] && [ "$ONLY" != "$1" ]; then return 0; fi
  SKIPPED+=("$1 — $2")
}


# ---- checks -------------------------------------------------------------------------------------
# This is cycler's DEFAULT gate. It runs only when the repo has no gate of its own; a repo's
# .claude/harness/gate.sh always wins (see harness/gate.sh, the resolver).
#
# It is deliberately small. A gate depends on the repo and the stack, and a default that guessed at
# more would either fail on repos that do not have those tools or, worse, skip everything and report
# PASS — a gate that cannot go red is the exact failure this harness exists to prevent. So: lint,
# build and test, each run only when package.json actually declares that script, and a run where
# NOTHING was checked reports FAIL rather than a vacuous pass.
#
# Add your own: copy this file to .claude/harness/gate.sh in your repo and edit the checks. The
# runner above (argument handling, changed-file sets, one-line-per-pass output, the index-safe
# summary, the pass marker the commit hook reads) is what you are inheriting; keep it.

has_script() {
  [ -f package.json ] || return 1
  node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)" 2>/dev/null
}

# ---- 1. lint ------------------------------------------------------------------------------------
if has_script lint; then
  run_check lint "npm run --silent lint"
else
  skip_check lint "no \"lint\" script in package.json"
fi

# ---- 2. build / typecheck -----------------------------------------------------------------------
if has_script build; then
  run_check build "npm run --silent build"
elif has_script typecheck; then
  run_check build "npm run --silent typecheck"
else
  skip_check build "no \"build\" or \"typecheck\" script in package.json"
fi

# ---- 3. tests -----------------------------------------------------------------------------------
if has_script test; then
  run_check tests "npm test --silent"
else
  skip_check tests "no \"test\" script in package.json"
fi

# A default gate that checked nothing must not read as green. Without this a repo with no scripts
# would get "GATE: PASS (0 of 0)" and every downstream check would treat the diff as verified.
if [ $RAN -eq 0 ] && [ -z "$ONLY" ]; then
  echo "GATE: FAIL (cycler's default gate found no lint/build/test script in package.json —"
  echo "            write your own at .claude/harness/gate.sh; it will be used instead of this one)"
  exit 2
fi

# ---- summary ------------------------------------------------------------------------------------
for s in "${SKIPPED[@]:-}"; do [ -n "$s" ] && printf 'SKIP  %s\n' "$s"; done
# B1: `--only X` that ran NOTHING is not a pass. It used to fall through to "GATE: PASS (0 of 0)",
# exit 0 — including `npm run gate:diff` (--only danger) with no CONTRACT_PATH, which therefore
# reported PASS while checking nothing at all. A gate that cannot fail is worse than no gate.
if [ -n "$ONLY" ] && [ $RAN -eq 0 ]; then
  _why=""
  for s in "${SKIPPED[@]:-}"; do case "$s" in "$ONLY "*) _why="$s" ;; esac; done
  if [ -n "$_why" ]; then
    printf 'GATE: FAIL (--only %s ran nothing — it was skipped: %s)\n' "$ONLY" "${_why#"$ONLY" — }"
  else
    printf 'GATE: FAIL (--only %s matched no check)\n' "$ONLY"
  fi
  exit 2
fi
# The pass marker binds this result to the EXACT tree that produced it, so the commit hook
# ($PLUGIN_ROOT/harness/hooks/require-green-gate.sh) can tell "gate passed" from "gate passed, then
# somebody edited". Editing after a green run and committing is how an unverified change reaches a
# PR looking verified.
tree_fingerprint() {
  { git diff HEAD 2>/dev/null
    git diff --cached 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | shasum -a 256 | awk '{print $1}'
}

if [ $FAILED -eq 0 ]; then
  if [ $RAN -gt 0 ]; then
    mkdir -p .test-results/gate 2>/dev/null && tree_fingerprint > .test-results/gate/last-pass 2>/dev/null
  fi
  printf 'GATE: PASS (%s of %s)\n' "$PASSED" "$RAN"
  exit 0
fi
# A red gate must invalidate any earlier pass, or the commit hook would honour a stale marker.
rm -f .test-results/gate/last-pass 2>/dev/null
printf 'GATE: FAIL (%s of %s failed: %s)\n' "$FAILED" "$RAN" "$(IFS=,; echo "${FAILED_NAMES[*]}")"
exit 1
