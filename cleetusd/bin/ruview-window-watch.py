#!/usr/bin/env python3
"""Watch whatever truth window is currently open and record what could spoil it.

Does NOT close the window - a sleeping person cannot tell you when they woke up,
so closing is a human act. This only records the things that make a window
untrustworthy after the fact, because discovering them afterwards is how this
project lost a night: a node that had dropped out left its last frame lingering
until STALE_THRESHOLD, and the resulting 10 s tail was read as fusion jitter.
"""
import json, os, time, urllib.request
from datetime import datetime

HOME = os.path.expanduser("~")
TRUTH = f"{HOME}/cleetusd/roomwatch/ruview-truth.jsonl"
EV    = f"{HOME}/cleetusd/roomwatch/events.jsonl"
LOG   = f"{HOME}/cleetusd/roomwatch/window-watch.log"
FEATS = f"{HOME}/cleetusd/roomwatch/ruview-labeled.jsonl"

def say(m):
    line = f"{datetime.now().strftime('%m-%d %H:%M:%S')}  {m}"
    print(line, flush=True)
    with open(LOG, "a") as f: f.write(line + "\n")

def open_window():
    try:
        rows = [json.loads(l) for l in open(TRUTH) if l.strip()]
    except Exception: return None
    rows.sort(key=lambda r: r["t"])
    cur = None
    for r in rows:
        if r["event"] == "begin": cur = r
        elif r["event"] == "end": cur = None
    return cur

def nodes():
    try:
        with urllib.request.urlopen("http://127.0.0.1:3000/api/v1/nodes", timeout=4) as r:
            d = json.load(r)
        return {n["node_id"]: (n["status"], n.get("rssi_dbm")) for n in d.get("nodes", [])}
    except Exception as e:
        return {"ERR": (str(e)[:60], None)}

def rows_now():
    try: return sum(1 for _ in open(FEATS))
    except Exception: return -1

w = open_window()
if not w:
    say("no truth window is open - nothing to watch"); raise SystemExit(0)
say(f"watching the OPEN {w['state'].upper()} window from "
    f"{datetime.fromtimestamp(w['t']).strftime('%H:%M:%S')}")
say(f"note: {w.get('note','')}")

seen_ev, last_roster, base_rows = None, 0, rows_now()
dropouts = 0
while True:
    cur = open_window()
    if not cur or cur["t"] != w["t"]:
        say(f"window closed. {rows_now()-base_rows} feature rows collected inside it, "
            f"{dropouts} node dropout event(s) seen.")
        break
    try:
        rows = [json.loads(l) for l in open(EV) if l.strip()][-6:]
    except Exception:
        rows = []
    for ev in rows:
        at = ev.get("at")
        if at and at > (seen_ev or ""):
            seen_ev = at
            if ev.get("kind") == "motion_confirmed":
                say(f"CAMERA MOTION {at} changed={ev.get('changed_pct')}% "
                    f"brightness={ev.get('brightness')}")
            elif ev.get("kind") in ("camera_unavailable", "camera_frozen"):
                say(f"CAMERA FAULT {ev.get('kind')} at {at}")
    if time.time() - last_roster > 300:
        last_roster = time.time()
        ns = nodes()
        missing = [i for i in (1, 2, 3) if i not in ns]
        if missing:
            dropouts += 1
            say(f"!! NODE(S) MISSING {missing} - data from here is suspect. roster={ns}")
        else:
            say(f"nodes ok {ns}  rows +{rows_now()-base_rows}")
    time.sleep(20)
