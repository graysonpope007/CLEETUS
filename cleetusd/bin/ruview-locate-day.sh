#!/bin/sh
# ruview-locate-day.sh: one command for a daily RuView locator pass.
#   1. spoken walk (door: vary it INSIDE spots when asked by the voice prompts)
#   2. score the walk against the SAVED model BEFORE anything learns from it
#      (the honest day-over-day number)
#   3. calibrate the camera teacher from the same walk (scored on held-out rounds)
#   4. guarded retrain on everything, restart the live map
# Usage: ruview-locate-day.sh [rounds] [block_seconds]
set -e
B=/Users/grayson/cleetusd/bin
PY=/Users/grayson/ruview-venv/bin/python
ROUNDS=${1:-2}; BLOCK=${2:-45}
/usr/bin/python3 $B/ruview-locate-session.py --rounds "$ROUNDS" --block "$BLOCK"
S=$(ls -t /Users/grayson/cleetusd/roomwatch/locate-sessions/*.jsonl | head -1)
echo "== waiting for the raw collector to flush the last minute"; sleep 70
echo "== 1. day-over-day: saved model on today's walk (no retraining)"
$PY -W ignore $B/ruview-locate-test.py "$S" --score-saved
echo "== 2. camera teacher calibration"
$PY -W ignore $B/ruview-camlabel.py calibrate "$S" || echo "(camera calibration skipped)"
echo "== 3. guarded retrain on everything"
$PY -W ignore $B/ruview-locate-train.py --save --guard
launchctl kickstart -k gui/$(id -u)/com.cleetus.ruview-locate
echo "== done. live map: http://127.0.0.1:8793"
