#!/usr/bin/env bash
# Install the room-devices panel on creo-bots-pi. Idempotent; re-run to update.
#
# Everything here is SUDO-FREE on purpose: the Pi's sudo needs a password, so
# nothing unattended may touch /etc/systemd/system. This is a --user unit, and
# enable-linger is already on for gpope04 so it starts at boot with nobody
# logged in.
set -euo pipefail
PI="${PI:-gpope04@100.68.53.19}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> reachable?"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$PI" true

echo "==> copying"
ssh "$PI" 'mkdir -p ~/devices-dash/public ~/.config/systemd/user'
scp -q "$HERE/server.mjs"           "$PI:~/devices-dash/server.mjs"
scp -q "$HERE/devices.html"         "$PI:~/devices-dash/public/index.html"
scp -q "$HERE/devices-dash.service" "$PI:~/.config/systemd/user/devices-dash.service"

echo "==> scene page (the kiosk boots on coding.html and 302s to the scene's page)"
scp -q "$HERE/doormat.html" "$PI:/opt/protocol-pi/pages/devices.html"

echo "==> registering the scene"
ssh "$PI" 'python3 - <<PY
import re, pathlib
p = pathlib.Path("/opt/protocol-pi/bin/scene_server.py"); s = p.read_text()
if '"'"'"devices"'"'"' not in s:
    s = re.sub(r"(SCENES\s*=\s*\{)",
               r"\1\n    \"devices\": {\"kind\": \"browser\", \"page\": \"devices.html\"},", s, count=1)
    p.write_text(s); print("scene added")
else:
    print("scene already registered")
PY'

echo "==> starting"
ssh "$PI" 'systemctl --user daemon-reload && systemctl --user enable --now devices-dash && sleep 2 && systemctl --user is-active devices-dash'

echo "==> VERIFYING THE SERVICE ANSWERS (is-active only means the process exists)"
ssh "$PI" 'curl -fsS -m 10 http://127.0.0.1:8791/healthz; echo; curl -fsS -m 30 http://127.0.0.1:8791/devices | head -c 120; echo'

echo "==> reloading scene_server so it sees the new scene (Restart=always, so kill == reload)"
ssh "$PI" 'pkill -f scene_server.py || true; sleep 3; curl -fsS -m 5 http://127.0.0.1:8080/scenes | head -c 200; echo'

cat <<'MSG'

==> switch the panel to it:
      ssh gpope04@100.68.53.19 'curl -fsS -X POST http://127.0.0.1:8080/scene/devices'

==> THEN SCREENSHOT THE PANEL. A healthy service two ports away is not a picture
    on the glass -- that exact mistake showed "DASHBOARD IS NOT RUNNING" for a
    whole session while systemctl said active:
      ssh gpope04@100.68.53.19 'XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/panel.png'
      scp gpope04@100.68.53.19:/tmp/panel.png .
MSG
