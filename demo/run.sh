#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEMO_DIR="$DIR"
[[ -d /opt/homebrew/opt/ffmpeg-full/bin ]] && PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH"
export PATH
if [[ "${1:-}" == --dry-run ]]; then
  cat <<'PLAN'
Read-only plan:
1. Verify Cycler update receipt, CLI authentication, capture tools and sandbox-only config.
2. Create/reset public OWNER/cycler-demo from demo-base; close its PRs and delete cycler/* branches.
3. Create a labelled Linear issue, delegate it, and dispatch without restarting Cycler.
4. Poll issue, contract, gate and PR; record with Cap, plus redacted Linear/PR pages and terminal cast.
5. Render and validate MP4/GIF in temporary storage; publish only after success.
6. Archive labelled demo issues and reset only the verified sandbox (unless DEMO_KEEP=1).
PLAN
  exit 0
fi
[[ $# -eq 0 ]] || { echo 'usage: demo/run.sh [--dry-run]' >&2; exit 2; }
[[ "${DEMO_CYCLER_VERIFIED:-}" == 1 ]] || { echo 'Cycler activation hold: set DEMO_CYCLER_VERIFIED=1 only after the complete update and independent verification.' >&2; exit 1; }
for BIN in gh git linear claude node npm asciinema agg ffmpeg ffprobe gifski; do
  command -v "$BIN" >/dev/null || { echo "missing $BIN" >&2; exit 127; }
done
[[ -n "${DEMO_TEAM:-}" && -n "${DEMO_GH_OWNER:-}" && -r "${DEMO_STORAGE_STATE:-}" && -n "${DEMO_SESSION_LOG:-}" ]] || { echo 'DEMO_TEAM, DEMO_GH_OWNER, DEMO_STORAGE_STATE and DEMO_SESSION_LOG are required' >&2; exit 2; }
[[ -f "${DEMO_CYCLER_CONFIG:-}" ]] || { echo 'DEMO_CYCLER_CONFIG required' >&2; exit 2; }
export CYCLER_CONFIG="$DEMO_CYCLER_CONFIG"
export DEMO_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cycler-demo.XXXXXX")"
export DEMO_WORK_DIR="$DIR/.work"
export DEMO_CAPTURE="${DEMO_CAPTURE:-cap}"
mkdir -p "$DEMO_WORK_DIR"
WATCH_PID='' DISPATCH_PID='' CAST_PID='' CAP_ACTIVE=0
cleanup() {
  STATUS=$?
  trap - EXIT
  [[ -z "$WATCH_PID" ]] || kill "$WATCH_PID" 2>/dev/null || true
  [[ -z "$DISPATCH_PID" ]] || kill "$DISPATCH_PID" 2>/dev/null || true
  [[ -z "$CAST_PID" ]] || kill "$CAST_PID" 2>/dev/null || true
  if [[ "$CAP_ACTIVE" == 1 ]]; then (cd "$DIR" && node --import tsx cap.ts stop) || STATUS=1; fi
  if [[ "${DEMO_KEEP:-0}" != 1 && "${DEMO_SANDBOX_READY:-0}" == 1 ]]; then
    (cd "$DIR" && node --import tsx cleanup.ts) || STATUS=1
    "$DIR/sandbox/setup-sandbox.sh" >/dev/null || STATUS=1
  fi
  if (( STATUS != 0 )); then
    rm -rf "$DEMO_RUN_DIR/cap-recording.cap" "$DEMO_RUN_DIR/cap-raw.mp4"
    echo "Demo failed. Diagnostic files: $DEMO_RUN_DIR" >&2
  else rm -rf "$DEMO_RUN_DIR"; fi
  exit "$STATUS"
}
trap cleanup EXIT

(cd "$DIR" && npm ci --ignore-scripts >/dev/null)
(cd "$DIR" && node --import tsx preflight.ts)
export DEMO_SANDBOX_PATH="$("$DIR/sandbox/setup-sandbox.sh")"
export DEMO_SANDBOX_READY=1
[[ "$(node "$DIR/../harness/read-config.mjs" repo.path '')" == "$DEMO_SANDBOX_PATH" ]] || { echo 'Cycler config repo.path does not match sandbox' >&2; exit 1; }
[[ "$(node "$DIR/../harness/read-config.mjs" repo.branch_prefix '')" == 'cycler/' ]] || { echo 'Cycler config branch prefix must be cycler/' >&2; exit 1; }
if [[ "$DEMO_CAPTURE" == cap ]]; then
  (cd "$DIR" && node --import tsx cap.ts doctor)
  (cd "$DIR" && node --import tsx cap.ts start)
  CAP_ACTIVE=1
fi
KEY="$(cd "$DIR" && node --import tsx seed.ts)"
printf '%s\n' "$KEY" > "$DEMO_RUN_DIR/issue-key"
if [[ -f "$DEMO_SESSION_LOG" ]]; then stat -f%z "$DEMO_SESSION_LOG" > "$DEMO_RUN_DIR/log-offset"; else echo 0 > "$DEMO_RUN_DIR/log-offset"; fi
asciinema rec --output-format asciicast-v2 --overwrite --quiet -c 'tail -n 0 -F "$DEMO_SESSION_LOG" | node --import "$DEMO_DIR/node_modules/tsx/dist/loader.mjs" "$DEMO_DIR/redact.ts"' "$DEMO_RUN_DIR/terminal.cast" & CAST_PID=$!
(cd "$DIR" && node --import tsx watch.ts "$KEY") > "$DEMO_RUN_DIR/watch.log" 2>&1 & WATCH_PID=$!
"$DIR/dispatch.sh" "$KEY" & DISPATCH_PID=$!
wait "$WATCH_PID" || { cat "$DEMO_RUN_DIR/watch.log" >&2; exit 1; }
WATCH_PID=''
wait "$DISPATCH_PID" || { cat "$DEMO_RUN_DIR/dispatch.log" >&2; exit 1; }
DISPATCH_PID=''
kill "$CAST_PID" 2>/dev/null || true
wait "$CAST_PID" 2>/dev/null || true
CAST_PID=''
if [[ "$CAP_ACTIVE" == 1 ]]; then
  (cd "$DIR" && node --import tsx cap.ts stop --export)
  CAP_ACTIVE=0
fi
(cd "$DIR" && node --import tsx verify.ts)
"$DIR/render.sh" "$DEMO_RUN_DIR"
if [[ "${DEMO_KEEP:-0}" != 1 ]]; then
  (cd "$DIR" && node --import tsx cleanup.ts)
  "$DIR/sandbox/setup-sandbox.sh" >/dev/null
  DEMO_SANDBOX_READY=0
fi
OUT_STAGE="$(mktemp -d "$DEMO_WORK_DIR/out-stage.XXXXXX")"
cp "$DEMO_RUN_DIR/cycler-demo.gif" "$OUT_STAGE/cycler-demo.gif"
cp "$DEMO_RUN_DIR/cycler-demo.mp4" "$OUT_STAGE/cycler-demo.mp4"
cp "$DEMO_RUN_DIR/events.jsonl" "$OUT_STAGE/events.jsonl"
cp "$DIR/out/.gitkeep" "$OUT_STAGE/.gitkeep"
cp "$DEMO_RUN_DIR/cycler-demo.gif" "$DIR/../docs/assets/cycler-demo.gif"
OUT_PREV="$(mktemp -d "$DEMO_WORK_DIR/out-prev.XXXXXX")"
rmdir "$OUT_PREV"
mv "$DIR/out" "$OUT_PREV"
mv "$OUT_STAGE" "$DIR/out" || { mv "$OUT_PREV" "$DIR/out"; exit 1; }
cat "$DEMO_RUN_DIR/watch.log"
echo "GIF bytes: $(stat -f%z "$DIR/out/cycler-demo.gif")"
echo "MP4 seconds: $(ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "$DIR/out/cycler-demo.mp4")"
