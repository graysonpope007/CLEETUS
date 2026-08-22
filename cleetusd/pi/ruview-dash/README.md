# ruview-dash — the studio panel on `creo-bots-pi`

A mirror of what runs on the Pi. It lived only on that SD card until
2026-08-21; this copy exists so a dead card is an afternoon, not a rebuild.

**Where it runs:** `~/ruview-dash/` on the Pi, as a systemd **--user** service
(`ruview-dash.service`). `loginctl enable-linger gpope04` is on, so it starts at
boot with nobody logged in. Panel is 1024×600, reachable on the tailnet at
`http://100.68.53.19:8790/`.

**Why a --user unit:** the Pi's `sudo` needs a password, so nothing unattended
can touch `/etc/systemd/system`. Everything here is deliberately sudo-free.

**The service holds the bearer; the page never does.** It reads
`/opt/protocol-pi/secrets/ruview.token` and proxies `https://me.cleetusai.com`.
That matters for `/camera.mjpg` in particular: an `<img>` cannot attach a
bearer, and this box serves the whole tailnet, so a token in the markup would be
a token given away.

**The live view is the alarm's own eye.** `/camera.mjpg` proxies
`/airpad/stream.mjpg` — the C920 that roomwatch confirms motion with — so the
panel shows the exact frames the alarm decides on, not a second opinion. The WiFi
traces sit *below* it because they were measured not to separate an occupied room
from an empty one; the layout says which one is load-bearing.

## Deploying a change

    scp server.mjs public/index.html gpope04@100.68.53.19:~/ruview-dash/…
    ssh gpope04@100.68.53.19 'systemctl --user restart ruview-dash'

Then **screenshot the panel** — `systemctl is-active` said `active` for an hour
while the page showed "DASHBOARD IS NOT RUNNING" because of a missing CORS
header:

    ssh gpope04@100.68.53.19 'export XDG_RUNTIME_DIR=/run/user/$(id -u); \
      WAYLAND_DISPLAY=wayland-0 grim /tmp/panel.png'

To reload a SYSTEM unit without sudo: the PROTOCOL units are `Restart=always`,
so `kill <pid>` makes systemd relaunch on the new file.
