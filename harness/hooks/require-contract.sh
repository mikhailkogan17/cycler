#!/usr/bin/env bash
# PreToolUse hook: no source edits before a contract exists.
#
# `promptTemplatePath` asks the agent to write a contract first. This makes it so. A prompt is a
# request the model can reason its way out of — the first real dispatched run did exactly that, ignoring
# the harness and hand-exploring instead. A denied tool call is not persuadable.
#
# Scope: ONLY inside a /task worktree (.claude/worktrees/...). Interactive work in the main checkout
# is untouched — an editing hook that fires on every local edit would be turned off within a day.
#
# stdin: the PreToolUse JSON payload. exit 0 = allow, exit 2 = deny (stderr goes back to the model).

set -uo pipefail

# Where this plugin is installed. Derived from this script's own location so it is right
# even when the caller has no CLAUDE_PLUGIN_ROOT in its environment.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

PAYLOAD="$(cat)"

CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)"
[ -n "$CWD" ] || CWD="$PWD"

# Only enforce inside a /task worktree.
case "$CWD" in
  # /task worktrees. This USED to be ~/.cyrus/worktrees/* — when that orchestrator went away the
  # pattern matched nothing and every one of these hooks silently stopped firing. A guard that cannot
  # fire is worse than no guard, because the process still claims it is enforced.
  */.claude/worktrees/*) ;;
  *) exit 0 ;;
esac

# The ".claude is never blocked" exemption must be anchored to THIS worktree. A bare `*/.claude/*`
# glob matches any path containing that segment — and now that worktrees live under
# `.claude/worktrees/`, every source file inside one matched it and the hook allowed everything.
# The guard silently became a no-op; only the tests noticed.
# Writing the contract itself must always be allowed, or the rule is unsatisfiable.
case "$FILE" in
  */.claude/harness/contracts/*) exit 0 ;;
esac

# Docs and the harness's own files are not "source" for this purpose.
case "$FILE" in
  *.md|"$CWD"/.claude/*) exit 0 ;;
esac

# Pull the issue key out of the worktree name. The previous orchestrator named worktrees exactly
# `APL-44`; /task names them `claude-APL-15`. Matching the whole basename would look for a contract
# called *claude-APL-15*.md and never find `apl-15-<slug>.md`, so every edit would be blocked with a
# message naming a key that does not exist. Extract the key itself and fall back to the basename.
WT_NAME="$(basename "$CWD")"
# Uppercase, 2+ letters: a real key is APL-19. The old case-INSENSITIVE form matched any
# word-dash-digits, so a scratch directory called `agent-deadbeef-3` read as issue "deadbeef-3"
# and the hook then demanded a contract named after it.
ISSUE="$(printf '%s' "$WT_NAME" | grep -oE '[A-Z]{2,}-[0-9]+' | head -1)"
CONTRACTS="$CWD/.claude/harness/contracts"
shopt -s nullglob nocaseglob
ALL=("$CONTRACTS"/*.md)
if [ -n "$ISSUE" ]; then MATCHES=("$CONTRACTS"/*"$ISSUE"*.md); else MATCHES=(); fi
shopt -u nullglob nocaseglob

# A worktree whose name carries an issue key must have THAT issue's contract.
if [ -n "$ISSUE" ] && [ ${#MATCHES[@]} -gt 0 ]; then
  exit 0
fi

# No key in the name: any contract satisfies this hook's actual claim, which is "you wrote a contract
# before editing source" — not "you named your directory after the issue". Background agents get
# worktrees called `agent-<hex>`, and the old fallback matched the WHOLE basename, so it demanded a
# contract whose filename contained that hex. APL-19 complied by renaming its contract to
# `apl-19-chart-window-agent-a2da24db40cb279e9.md`, which satisfies a guard while making the artifact
# worse. A rule that is cheaper to game than to meet is training agents to game it.
if [ -z "$ISSUE" ] && [ ${#ALL[@]} -gt 0 ]; then
  exit 0
fi

cat >&2 <<MSG
BLOCKED by the harness: no contract exists${ISSUE:+ for $ISSUE}, so source edits are not allowed yet.

Write the contract FIRST:
  cp $PLUGIN_ROOT/harness/CONTRACT.md .claude/harness/contracts/${ISSUE}-<slug>.md
then fill in Goal, Non-goals, Allowed paths, Forbidden paths, Files expected to change, and
Acceptance checks (exact commands) from the Linear issue.

This is the contract-first rule from $PLUGIN_ROOT/harness/HARNESS.md. It is enforced here rather than
merely requested, because a diff that predates its contract cannot be audited against it.
MSG
exit 2
