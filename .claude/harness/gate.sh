#!/usr/bin/env bash
# cycler's own gate. Dogfoods the contract: a repo's .claude/harness/gate.sh wins over the plugin's
# default, and this repo is a repo like any other.
#
# The default gate cannot serve here — cycler has no package.json and no lint/build/test scripts, so
# it would (correctly) report FAIL. These are the checks that actually apply to this repo.
#
# Output contract, same as every cycler gate: one line per passing check, detail only on failure,
# last line GATE: PASS|FAIL, exit 0 only when everything that ran passed.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || { echo "GATE: FAIL (not in a git repo)"; exit 2; }

# Arguments are accepted and ignored on purpose: the caller is the plugin's resolver, which passes
# --fast/--full/--base. This repo's checks take seconds, so there is no fast/full split to make.
TAIL=20
PASSED=0; RAN=0; FAILED=0; FAILED_NAMES=()

run_check() {
  local name="$1" cmd="$2" out
  RAN=$((RAN + 1))
  if out="$(eval "$cmd" 2>&1)"; then
    PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$name"
  else
    FAILED=$((FAILED + 1)); FAILED_NAMES+=("$name")
    printf 'FAIL  %s\n' "$name"
    printf '%s\n' "$out" | tail -n "$TAIL" | sed 's/^/      /'
  fi
}

run_check syntax-js  'for f in $(git ls-files "*.mjs" "*.js"); do node --check "$f" || exit 1; done'
run_check syntax-sh  'for f in $(git ls-files "*.sh"); do bash -n "$f" || exit 1; done'
run_check syntax-json 'for f in $(git ls-files "*.json"); do python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$f" || exit 1; done'
run_check harness-tests 'node harness/tests/run.mjs'

# The plugin manifests are what make this installable at all; a typo in either fails the install with
# a message about hooks, not about JSON, so check them by name rather than trusting the glob above.
run_check plugin-manifests \
  'python3 -c "import json;[json.load(open(p)) for p in [\".claude-plugin/plugin.json\",\".claude-plugin/marketplace.json\"]]"'

# A gate that ran nothing must not read as green.
if [ $RAN -eq 0 ]; then echo "GATE: FAIL (no checks ran)"; exit 2; fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/cycler}"
tree_fingerprint() { bash "$PLUGIN_ROOT/harness/tree-fingerprint.sh" .; }

if [ $FAILED -eq 0 ]; then
  mkdir -p .test-results/gate 2>/dev/null && tree_fingerprint > .test-results/gate/last-pass 2>/dev/null
  printf 'GATE: PASS (%s of %s)\n' "$PASSED" "$RAN"; exit 0
fi
rm -f .test-results/gate/last-pass 2>/dev/null
printf 'GATE: FAIL (%s of %s failed: %s)\n' "$FAILED" "$RAN" "$(IFS=,; echo "${FAILED_NAMES[*]}")"
exit 1
