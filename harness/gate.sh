#!/usr/bin/env bash
# $PLUGIN_ROOT/harness/gate.sh — the gate RESOLVER. This is the one gate command.
#
#   CONTRACT_PATH=<contract.md> bash "$PLUGIN_ROOT/harness/gate.sh" --fast --base main
#
# A gate always depends on the repo and its stack, so cycler does not own yours. Resolution order:
#
#   1. $CLAUDE_PROJECT_DIR/.claude/harness/gate.sh  — the repo's own gate. WINS whenever it exists.
#   2. $PLUGIN_ROOT/harness/gate.default.sh — cycler's default (lint/build/test from
#      package.json), for a repo that has not written one yet.
#
# It exec's, so the chosen gate's output and exit status are this script's, unchanged — every caller
# (the review agents, require-green-gate.sh, the workflow) sees the same output contract either way.
#
# One line of provenance goes to stderr, never stdout: stdout is the output contract, and a
# resolver that quietly always picked the default would look identical to a working one. Saying
# which gate ran is what makes that difference visible.

set -uo pipefail

# Where this plugin is installed. Derived from this script's own location so it is right
# even when the caller has no CLAUDE_PLUGIN_ROOT in its environment.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"


REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_GATE="$REPO/.claude/harness/gate.sh"
DEFAULT_GATE="$PLUGIN_DIR/gate.default.sh"

# A repo whose gate.sh IS this file (someone copied the plugin in) would recurse forever.
if [ -f "$REPO_GATE" ] && [ "$(cd "$(dirname "$REPO_GATE")" && pwd)" != "$PLUGIN_DIR" ]; then
  echo "gate: using the repo's own gate ($REPO_GATE)" >&2
  exec bash "$REPO_GATE" "$@"
fi

if [ ! -f "$DEFAULT_GATE" ]; then
  echo "GATE: FAIL (no repo gate at $REPO_GATE and cycler's default is missing at $DEFAULT_GATE)"
  exit 2
fi

echo "gate: no repo gate at $REPO_GATE — using cycler's default" >&2
exec bash "$DEFAULT_GATE" "$@"
