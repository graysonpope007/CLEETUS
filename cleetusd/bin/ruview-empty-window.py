#!/usr/bin/env python3
"""Hold a camera-verified EMPTY truth window open until a wall-clock deadline.

Grayson says the room is empty. The camera is the only thing that can check it,
and the one failure this window has to avoid is opening while he is still
walking out: those minutes are occupied data sitting inside a window labelled
empty. So it waits for the camera to go quiet BEFORE asserting anything, then
watches for motion the whole way through and records every burst rather than
quietly averaging over it.

It also samples the node roster every 5 minutes. A board that drops out mid
window leaves its last frame lingering until STALE_THRESHOLD, and a statistic
computed across that gap is measuring the dropout, not the room. That mistake
has already been made once on this project and it produced a 10 s tail that was
read as fusion jitter.
"""
import json, os, subprocess, time, urllib.request
from datetime import datetime

HOME = os.path.expanduser("~")
EV   = f"{HOME}/cleetusd/roomwatch/events.jsonl"
LOG  = f"{HOME}/cleetusd/roomwatch/empty-window-2026-08-26.log"
TRUTH= f"{HOME}/cleetusd/bin/ruview-truth.mjs"
DEADLINE = datetime(2026, 8, 26, 22, 30, 0).timestamp()   # 22:30 local
STILL_NEEDED = 4          # consecutive quiet heartbeats (~2 min) before opening

def say(msg):
    line = f"{datetime.now().strftime('%H:%M:%S')}  {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f: f.write(line + "\n")

def last_events(n=1):
    try:
        with open(EV) as f: rows = f.read().strip().split("\n")[-n:]
        return [json.loads(r) for r in rows if r.strip()]
    except Exception: return []

def nodes():
    try:
        with urllib.request.urlopen("http://127.0.0.1:3000/api/v1/nodes", timeout=4) as r:
            d = json.load(r)
        return sorted((n["node_id"], n["status"], n.get("rssi_dbm")) for n in d.get("nodes", []))
    except Exception as e:
        return [("ERR", str(e), None)]

say(f"waiting for the camera to go quiet ({STILL_NEEDED} clear heartbeats) before opening the window")
seen = None
still = 0
while time.time() < DEADLINE:
    ev = last_events(1)
    if ev and ev[0].get("at") != seen:
        seen = ev[0].get("at")
        if ev[0].get("kind") == "cleared":
            still += 1
            say(f"quiet {still}/{STILL_NEEDED}")
        else:
            if still: say(f"motion again ({ev[0].get('changed_pct')}% changed) - restarting the count")
            still = 0
    if still >= STILL_NEEDED: break
    time.sleep(10)

if still < STILL_NEEDED:
    say("never went quiet before the deadline. NOT opening a window on contaminated data.")
    raise SystemExit(1)

r = subprocess.run(["node", TRUTH, "begin", "empty",
                    "Grayson out until 22:30, camera-verified still before opening"],
                   capture_output=True, text=True)
say(f"truth window OPEN: {r.stdout.strip() or r.stderr.strip()}")
opened = time.time()
say(f"nodes at open: {nodes()}")

bursts, last_roster, seen_ev = [], 0, seen
while time.time() < DEADLINE:
    for ev in last_events(6):
        at = ev.get("at")
        if at and at > (seen_ev or "") and ev.get("kind") == "motion_confirmed":
            seen_ev = at
            bursts.append(at)
            say(f"CAMERA MOTION inside the empty window: {at} "
                f"changed={ev.get('changed_pct')}% faces={ev.get('unknown_faces')}")
        elif at and at > (seen_ev or ""):
            seen_ev = at
    if time.time() - last_roster > 300:
        last_roster = time.time()
        say(f"nodes: {nodes()}  bursts so far: {len(bursts)}  "
            f"{(DEADLINE-time.time())/60:.0f} min left")
    time.sleep(20)

r = subprocess.run(["node", TRUTH, "end"], capture_output=True, text=True)
say(f"truth window CLOSED: {r.stdout.strip() or r.stderr.strip()}")
say(f"held {(time.time()-opened)/60:.1f} min. camera motion bursts inside it: {len(bursts)}")
if bursts:
    say(f"first burst {bursts[0]} - cross-check with ruview-empty.py before trusting the window")
