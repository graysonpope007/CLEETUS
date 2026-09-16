#!/bin/zsh
# fetch-ble-corpus.sh — pull Grayson's Bluetooth / BLE shelf into vendor/ble.
#
# WHY YOU (GRAYSON) RUN THIS, NOT CLEETUS
# The Claude Code auto-mode classifier blocks the daemon's own session from
# downloading and unpacking external repositories ("untrusted code integration")
# — correctly, since that is exactly the move a prompt-injection would try. So
# the framework (src/bleskills.mjs, the find_ble_skill / read_ble_skill tools,
# the agent briefs) was built to consume the corpus, and the actual fetch is
# this script, which you run once:
#
#     ~/cleetusd/bin/fetch-ble-corpus.sh
#
# It downloads each repo as a tarball (no git needed — /usr/bin/git is the Xcode
# shim until `sudo xcodebuild -license accept`), extracts it under vendor/ble/,
# then builds the index. Re-running is safe: each repo is refreshed in place.
#
# It fetches DOCUMENTATION AND CODE, but nothing is executed and nothing is
# wired to run. The MCP server and the device libraries are reference material
# on the shelf; standing any of them up is a separate, deliberate step.
set -euo pipefail

HERE=${0:A:h}
LIB=${LIB:-$HERE/../vendor/ble}
mkdir -p "$LIB"

# Real, clonable repositories. The GitHub /topics/* pages and the
# Bluetooth-Devices org are indexes, not repos: their notable members are
# listed in vendor/ble/SOURCES.md and can be added here by slug as wanted.
REPOS=(
  Hypijump31/bluetooth-mcp-server
  dotintent/awesome-ble
  engn33r/awesome-bluetooth-security
  urish/awesome-web-bluetooth
  NordicPlayground/nRF52-Bluetooth-Course
  darkmentorllc/bt-re-mad-skillz
  SnailSploit/Claude-Red
)

fetch() {
  local slug="$1" name="${1##*/}" tmp br
  tmp=$(mktemp -d)
  for br in main master; do
    if curl -fsSL -m 300 "https://codeload.github.com/$slug/tar.gz/refs/heads/$br" -o "$tmp/a.tgz"; then
      rm -rf "$LIB/$name"; mkdir -p "$LIB/$name"
      if tar -xzf "$tmp/a.tgz" -C "$LIB/$name" --strip-components=1 2>/dev/null; then
        print "  OK   $slug ($br)"; rm -rf "$tmp"; return 0
      fi
    fi
  done
  print "  FAIL $slug"; rm -rf "$tmp"; return 1
}

print "fetching Bluetooth/BLE corpus into $LIB"
for r in "${REPOS[@]}"; do fetch "$r" || true; done

print "building the index"
node "$HERE/index-ble-corpus.mjs"

print "done. Restart cleetusd so it loads the new library:"
print "  launchctl kickstart -k gui/\$(id -u)/com.cleetus.cleetusd"
