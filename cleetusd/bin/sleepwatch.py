#!/usr/bin/env python3
"""sleepwatch.py: the overnight watch that learns what "in bed" and "asleep" look like.

  sleepwatch.py run                         sample every 10 s forever (LaunchAgent com.cleetus.sleepwatch)
  sleepwatch.py mark bed|asleep|up|note [text]   a truth mark, timestamped now
  sleepwatch.py truth YYYY-MM-DD bed=HH:MM asleep=HH:MM up=HH:MM
                                            truth given after the fact (night = the date you got IN bed;
                                            times after midnight roll to the next day automatically)
  sleepwatch.py status                      nights logged, nights with truth, whether the baseline is ready

It only RECORDS. Each 10 s row holds the cheap signals that are gone if not captured now:
  locator posterior (RF spot model, :8793), HID idle seconds, Hue lamp on/off, the latest
  roomwatch camera heartbeat (brightness + changed_pct; the camera is BLIND after ~02:00).
The expensive signal, stillness from raw CSI, is computed later by sleepwatch-report.py from
roomwatch/csi-raw/, which ruview-raw.py already keeps.

Files: roomwatch/sleepwatch/samples-YYYY-MM-DD.jsonl (by wall-clock day), marks.jsonl, truth.jsonl.
"""
import json, subprocess, sys, time, pathlib, urllib.request, datetime as dt

HOME = pathlib.Path.home()
DIR = HOME / "cleetusd/roomwatch/sleepwatch"
EVENTS = HOME / "cleetusd/roomwatch/events.jsonl"
NODE = "/opt/homebrew/bin/node"
LIGHTS = HOME / "cleetusd/bin/lights.mjs"
TICK = 10
LIGHTS_EVERY = 60


def hid_idle():
    try:
        out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            if "HIDIdleTime" in line:
                return round(int(line.split("=")[-1].strip()) / 1e9, 1)
    except Exception:
        pass
    return None


def locator():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8793/state", timeout=3) as r:
            s = json.load(r)
        return {"top": s.get("top"), "spots": {k: round(v, 4) for k, v in (s.get("spots") or {}).items()},
                "out": round(s["out"], 4) if s.get("out") is not None else None,
                "views": s.get("views_live"), "status": s.get("status")}
    except Exception as e:
        return {"error": str(e)[:80]}


def lamps():
    try:
        out = subprocess.run([NODE, str(LIGHTS), "status"], capture_output=True, text=True, timeout=20,
                             cwd=str(HOME / "cleetusd")).stdout
        rows = [l.split() for l in out.splitlines() if l.strip()]
        on = [r for r in rows if r[0] == "on"]
        if not rows:
            return None
        return {"on": len(on), "total": len(rows)}
    except Exception:
        return None


def last_camera():
    """Latest roomwatch heartbeat row. Read from the tail only."""
    try:
        with open(EVENTS, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 8192))
            lines = f.read().decode(errors="ignore").splitlines()[1:]
        for line in reversed(lines):
            e = json.loads(line)
            if e.get("why") == "heartbeat":
                return {"at": e["at"], "kind": e["kind"], "changed_pct": e.get("changed_pct"),
                        "brightness": e.get("brightness")}
    except Exception:
        pass
    return None


def run():
    DIR.mkdir(parents=True, exist_ok=True)
    lamp_state, lamp_t = None, 0
    while True:
        t0 = time.time()
        if t0 - lamp_t >= LIGHTS_EVERY:
            lamp_state, lamp_t = lamps(), t0
        row = {"t": round(t0, 1), "hid_idle": hid_idle(), "loc": locator(), "lamps": lamp_state,
               "cam": last_camera()}
        day = dt.datetime.fromtimestamp(t0).strftime("%Y-%m-%d")
        with open(DIR / f"samples-{day}.jsonl", "a") as f:
            f.write(json.dumps(row) + "\n")
        time.sleep(max(1, TICK - (time.time() - t0)))


def mark(kind, text=""):
    DIR.mkdir(parents=True, exist_ok=True)
    row = {"t": round(time.time(), 1), "at": dt.datetime.now().isoformat(timespec="seconds"), "kind": kind,
           "text": text}
    with open(DIR / "marks.jsonl", "a") as f:
        f.write(json.dumps(row) + "\n")
    print(f"marked {kind} at {row['at']}")


def parse_truth(night, pairs):
    """night = date you got in bed. Times earlier than 15:00 belong to the NEXT morning."""
    base = dt.date.fromisoformat(night)
    out = {"night": night}
    for p in pairs:
        k, v = p.split("=")
        h, m = map(int, v.split(":"))
        day = base + dt.timedelta(days=1) if h < 15 else base
        out[k] = dt.datetime.combine(day, dt.time(h, m)).timestamp()
        out[k + "_str"] = dt.datetime.fromtimestamp(out[k]).isoformat(timespec="minutes")
    return out


def truth(night, pairs):
    row = parse_truth(night, pairs)
    with open(DIR / "truth.jsonl", "a") as f:
        f.write(json.dumps(row) + "\n")
    print("truth", {k: v for k, v in row.items() if k.endswith("_str") or k == "night"})


def status():
    days = sorted(p.name[8:18] for p in DIR.glob("samples-*.jsonl"))
    truths = [json.loads(l) for l in open(DIR / "truth.jsonl")] if (DIR / "truth.jsonl").exists() else []
    base = DIR / "baseline.json"
    print(f"sample days: {len(days)} {days[-3:] if days else ''}")
    print(f"nights with truth: {len({t['night'] for t in truths})}")
    if base.exists():
        b = json.load(open(base))
        print(f"baseline: {'READY' if b.get('ready') else 'not ready'}  {b.get('why', '')}")
    else:
        print("baseline: none yet (run sleepwatch-report.py after a night)")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "run":
        run()
    elif cmd == "mark":
        mark(sys.argv[2], " ".join(sys.argv[3:]))
    elif cmd == "truth":
        truth(sys.argv[2], sys.argv[3:])
    else:
        status()
