#!/usr/bin/env bash
# Report what an issue's run actually cost.
#
# Read this before believing any cost claim about the harness. The obvious method is wrong: the
# `modelUsage` block on a session's final `result` record is cumulative *for that session only*, and a
# run that hits a quota limit is resumed as a NEW session with a new log. APL-52 spanned twelve of
# them. Reading the last result therefore reports the last fragment and undercounts by 2-4x — which is
# exactly how "APL-54 cost 7.32M with 8 agents, so more agents are cheaper" got published here. Summed
# properly it was 30.33M with 13 agents, and the conclusion was backwards.
#
# So: sum per-turn cache reads across every session log for the issue.
#
# Usage: measure-usage.sh <ISSUE> [<ISSUE> ...]
set -uo pipefail
# Historical logs from the previous orchestrator are archived here; a live poller session logs
# through Claude Code itself (`claude logs <id>`), so this reads the archive by default.
LOGS="${SESSION_LOGS_DIR:-${CYCLER_HOME:-$HOME/.cycler}/archive/session-logs}"

printf '%-9s %9s %9s %8s %8s %7s %7s\n' ISSUE CACHE-READ CREATE OUT TURNS AGENTS SESSNS
for ISSUE in "$@"; do
  d="$LOGS/$ISSUE"
  [ -d "$d" ] || { printf '%-9s  (no logs)\n' "$ISSUE"; continue; }
  read -r cr cc out turns < <(
    for f in "$d"/*.jsonl; do
      jq -r 'select(.message.type=="assistant") | .message.message.usage
             | [(.cache_read_input_tokens//0),(.cache_creation_input_tokens//0),(.output_tokens//0)]
             | @tsv' "$f" 2>/dev/null
    done | awk '{cr+=$1; cc+=$2; o+=$3; n++} END{print cr+0, cc+0, o+0, n+0}'
  )
  agents=0
  for f in "$d"/*.jsonl; do
    n=$(jq -r '..|objects|select(.type=="tool_use" and .name=="Agent")|1' "$f" 2>/dev/null | wc -l | tr -d ' ')
    agents=$((agents + n))
  done
  sessions=$(ls "$d"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  awk -v i="$ISSUE" -v cr="$cr" -v cc="$cc" -v o="$out" -v t="$turns" -v a="$agents" -v s="$sessions" \
    'BEGIN{printf "%-9s %8.2fM %8.0fK %7.0fK %8s %7s %7s\n", i, cr/1e6, cc/1000, o/1000, t, a, s}'
done

cat <<'NOTE'

cache-read dominates cost and is the number to compare. It is the sum over turns of the context each
turn re-read, so it grows with turns x context — not with diff size. A resumed session re-reads
everything it had, so quota restarts inflate it directly.
NOTE
