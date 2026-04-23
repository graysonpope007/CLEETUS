#!/bin/bash
# install.sh — Copy launchd plists to ~/Library/LaunchAgents and load them.
# Run once after Phase 9 review: bash .claude/launchd/install.sh

set -e

PLIST_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

for plist in "$PLIST_DIR"/com.cleetus.*.plist; do
    name=$(basename "$plist")
    dst="$LAUNCH_AGENTS/$name"
    cp "$plist" "$dst"
    launchctl unload "$dst" 2>/dev/null || true
    launchctl load "$dst"
    echo "Loaded: $name"
done

echo ""
echo "Cleetus jobs registered:"
launchctl list | grep com.cleetus
