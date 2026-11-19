#!/usr/bin/env bash
set -euo pipefail
KEY="${1:?usage: dispatch.sh ISSUE-KEY}"
[[ "$KEY" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]] || exit 2
[[ -n "${DEMO_SANDBOX_PATH:-}" && -d "$DEMO_SANDBOX_PATH/.git" ]] || { echo 'DEMO_SANDBOX_PATH missing' >&2; exit 2; }
[[ -n "${DEMO_RUN_DIR:-}" ]] || exit 2

# The CLI command is the requested direct route. A running poller may already own the issue;
# in that case an unsuccessful direct call falls back to watching its event, without restarting it.
if (cd "$DEMO_SANDBOX_PATH" && claude -p "/cycler:delegate $KEY" > "$DEMO_RUN_DIR/dispatch.log" 2>&1); then
  exit 0
fi

END=$((SECONDS + 240))
while (( SECONDS < END )); do
  if [[ -f "$DEMO_RUN_DIR/events.jsonl" ]] && grep -q '"type":"in_progress"' "$DEMO_RUN_DIR/events.jsonl"; then
    echo 'Direct dispatch failed; existing poller picked up the issue.' >&2
    exit 0
  fi
  sleep 10
done
echo 'Neither direct dispatch nor the existing poller started the issue within 240 seconds.' >&2
exit 1
