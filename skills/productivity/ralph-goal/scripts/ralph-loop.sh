#!/usr/bin/env sh
# Ralph loop. Reruns the agent on the same prompt until a sentinel appears.
# Usage: AGENT="claude -p" ./ralph-loop.sh   (override AGENT for codex/aider/etc.)
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT="${AGENT:-claude -p}"   # any CLI taking the prompt on stdin
MAX="${MAX:-50}"              # hard cap so a non-converging loop can't run forever
STALL="${STALL:-3}"          # halt if PROGRESS.md unchanged this many iterations

hash_progress() { md5sum "$DIR/PROGRESS.md" 2>/dev/null || md5 "$DIR/PROGRESS.md"; }

prev=""; stuck=0; i=0
while [ "$i" -lt "$MAX" ]; do
  i=$((i + 1)); echo "=== ralph iteration $i ==="
  cat "$DIR/PROMPT.md" | $AGENT
  [ -f "$DIR/RALPH_DONE" ]  && { echo "DONE: $(cat "$DIR/RALPH_DONE")"; exit 0; }
  [ -f "$DIR/RALPH_STUCK" ] && { echo "STUCK: $(cat "$DIR/RALPH_STUCK")"; exit 1; }
  now="$(hash_progress)"
  if [ "$now" = "$prev" ]; then stuck=$((stuck + 1)); else stuck=0; fi
  prev="$now"
  [ "$stuck" -ge "$STALL" ] && { echo "STALLED: PROGRESS.md unchanged $STALL iterations."; exit 3; }
done
echo "Hit MAX=$MAX without finishing. Check PROGRESS.md."; exit 2
