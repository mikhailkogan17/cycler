#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -d /opt/homebrew/opt/ffmpeg-full/bin ]] && PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH"
export PATH
RUN="${1:?usage: render.sh RUN_DIR}"
[[ -f "$RUN/events.jsonl" && -f "$RUN/terminal.cast" ]] || { echo 'capture evidence missing' >&2; exit 1; }
FONT="${DEMO_FONT:-/System/Library/Fonts/SFNS.ttf}"
[[ -r "$FONT" ]] || { echo 'Inter/SF font file missing' >&2; exit 1; }
mkdir -p "$RUN/render" "$RUN/frames-gif"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=black@0:s=840x94:d=1 \
  -vf "format=rgba,geq=r=0:g=0:b=0:a='if(lte(abs(X-420)\\,373)\\,178\\,if(lte(pow(abs(X-420)-373\\,2)+pow(Y-47\\,2)\\,2209)\\,178\\,0))'" \
  -frames:v 1 "$RUN/render/pill.png"
agg "$RUN/terminal.cast" "$RUN/render/terminal.gif"
MINUTES="$(cd "$DIR" && node --import tsx metrics.ts "$RUN/events.jsonl")"
echo "Real elapsed: $MINUTES minutes"

segment() {
  local N="$1" IMAGE="$2" DURATION="$3" CAPTION="$4" SPEED="${5:-1}"
  [[ -f "$IMAGE" ]] || { echo "missing segment frame: $IMAGE" >&2; exit 1; }
  [[ "$(wc -w <<< "$CAPTION" | tr -d ' ')" -le 6 ]] || { echo 'caption exceeds six words' >&2; exit 1; }
  ffmpeg -hide_banner -loglevel error -y -stream_loop -1 -i "$IMAGE" -stream_loop -1 -i "$RUN/render/pill.png" -t "$DURATION" \
    -filter_complex "[0:v]setpts=PTS/${SPEED},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white[base];[base][1:v]overlay=x=540:y=918:shortest=1,drawtext=fontfile=${FONT}:text='${CAPTION}':fontcolor=white:fontsize=45:x=(w-text_w)/2:y=940" \
    -r 30 -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$RUN/render/$N.mp4"
}

segment 01 "$RUN/frames/created-linear.png" 8 'Issue starts in Todo'
segment 02 "$RUN/frames/delegated-linear.png" 9 'Delegate to Cycler'
segment 03 "$RUN/render/terminal.gif" 10 'Local poller starts session'
segment 04 "$RUN/render/terminal.gif" 17 'Contract implement audit' 4
segment 05 "$RUN/render/terminal.gif" 10 'Repository gate passes'
segment 06 "$RUN/frames/review_done-pr.png" 12 'PR and Linear comment'
ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=0x111111:s=1920x1080:r=30:d=6 \
  -vf "drawtext=fontfile=${FONT}:text='0 human input · ${MINUTES} min · runs on your Mac':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=(h-text_h)/2" \
  -c:v libx264 -pix_fmt yuv420p "$RUN/render/07.mp4"

for FILE in "$RUN"/render/0*.mp4; do printf "file '%s'\n" "$FILE"; done > "$RUN/render/list.txt"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$RUN/render/list.txt" -c copy -movflags +faststart "$RUN/cycler-demo.mp4"
ffmpeg -hide_banner -loglevel error -y -i "$RUN/cycler-demo.mp4" \
  -vf 'setpts=PTS*0.42,fps=12,scale=960:-1' "$RUN/frames-gif/%04d.png"
for QUALITY in 50 35 20; do
  rm -f "$RUN/cycler-demo.gif"
  gifski --fps 12 --width 960 --quality "$QUALITY" --output "$RUN/cycler-demo.gif" "$RUN"/frames-gif/*.png
  [[ "$(stat -f%z "$RUN/cycler-demo.gif")" -le 8000000 ]] && break
done

MP4_DURATION="$(ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "$RUN/cycler-demo.mp4")"
GIF_DURATION="$(ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "$RUN/cycler-demo.gif")"
GIF_BYTES="$(stat -f%z "$RUN/cycler-demo.gif")"
awk -v d="$MP4_DURATION" 'BEGIN {exit !(d>=60 && d<=90)}' || { echo "MP4 duration $MP4_DURATION outside 60–90 s" >&2; exit 1; }
awk -v d="$GIF_DURATION" 'BEGIN {exit !(d>=25 && d<=35)}' || { echo "GIF duration $GIF_DURATION outside 25–35 s" >&2; exit 1; }
[[ "$GIF_BYTES" -le 8000000 ]] || { echo "GIF is $GIF_BYTES bytes, above 8 MB" >&2; exit 1; }
[[ "$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$RUN/cycler-demo.mp4")" == '1920,1080' ]] || { echo 'MP4 is not 1080p' >&2; exit 1; }
