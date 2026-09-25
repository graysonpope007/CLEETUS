#!/usr/bin/env python3
"""ruview-locate-train.py: retrain the room locator on EVERYTHING labelled.

The first model learned one 14-minute walk and failed 5 minutes after it (said
"out" while Grayson typed at the desk). One walk memorises that walk's room
state: door, drift, posture. The fix is volume and variety, so labels come
from three sources:

  walk     every block of every session in roomwatch/locate-sessions/
  desk     SELF-LABELLED: any 3 s window in which the HID idle time (collector,
           1 Hz) stayed under IDLE_MAX s is "desk". Free, hours per day, and it
           spans door states, time of day and drift.
  out      human-asserted EMPTY windows from roomwatch/ruview-truth.jsonl

Scored with TIME-BLOCKED cross-validation (10-minute blocks held out), which
is the honest test for drift: the model is judged on stretches of time it
never saw. Desk windows are capped per block so hours of typing cannot drown
the rarer walk spots.

  ruview-locate-train.py             report only
  ruview-locate-train.py --save      also refit on everything and replace the live
                                     model (compare the printed scores first)
"""
import sys, json, glob, pickle, pathlib, importlib.util, argparse, time
import numpy as np

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("lt", HERE / "ruview-locate-test.py")
lt = importlib.util.module_from_spec(spec); spec.loader.exec_module(lt)
ROOM = pathlib.Path.home() / "cleetusd/roomwatch"
IDLE_MAX = 8.0
BLOCK = 600.0
DESK_CAP_PER_BLOCK = 60

def hid_rows(t0, t1):
    out = []
    for f in sorted(glob.glob(str(ROOM / "ruview-labeled*.jsonl"))):
        with open(f) as fh:
            for line in fh:
                if not line.startswith('{"t":1'):
                    continue
                try:
                    tv = float(line[5:line.index(",")])
                except ValueError:
                    continue
                if t0 <= tv <= t1:
                    r = json.loads(line); out.append((r["t"], r.get("idle")))
    out.sort()
    return np.array([o[0] for o in out]), np.array([o[1] if o[1] is not None else 1e9 for o in out])

def labelled_blocks(t_raw0, t_raw1):
    blocks = []
    for s in sorted(glob.glob(str(ROOM / "locate-sessions/*.jsonl"))):
        for l in open(s):
            if l.strip():
                b = json.loads(l); b["source"] = "walk"; blocks.append(b)
    walk_spans = [(b["t_move"], b["t_move"] + 60) for b in blocks]
    # desk from HID: contiguous runs of idle < IDLE_MAX, outside walks
    ht, hi = hid_rows(t_raw0, t_raw1)
    run = None
    for tv, iv in zip(ht, hi):
        inwalk = any(a <= tv <= b for a, b in walk_spans)
        if iv < IDLE_MAX and not inwalk:
            run = [tv - iv, tv] if run is None else [run[0], tv]
        else:
            if run and run[1] - run[0] >= 6:
                blocks.append({"spot": "desk", "t0": run[0], "t1": run[1], "source": "hid"})
            run = None
    if run and run[1] - run[0] >= 6:
        blocks.append({"spot": "desk", "t0": run[0], "t1": run[1], "source": "hid"})
    # out from human-asserted empty windows
    tf = ROOM / "ruview-truth.jsonl"
    if tf.exists():
        rows = [json.loads(l) for l in open(tf) if l.strip()]
        opened = None
        for r in rows:
            if r["event"] == "begin" and r["state"] == "empty":
                opened = r["t"]
            elif r["event"] == "end" and opened:
                blocks.append({"spot": "out", "t0": opened + 60, "t1": r["t"] - 60, "source": "truth"}); opened = None
    # camera: only from a CALIBRATED map (ruview-camlabel.py calibrate), only
    # confident frames, only outside walks and self-labelled desk time
    try:
        spec2 = importlib.util.spec_from_file_location("cam", HERE / "ruview-camlabel.py")
        cam = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(cam)
        taken = [(b["t0"], b["t1"]) for b in blocks] + walk_spans
        n_cam = 0
        for c0, c1, spot in cam.label_windows(t_raw0, t_raw1):
            if not any(a <= c1 and c0 <= b_ for a, b_ in taken):
                blocks.append({"spot": str(spot), "t0": c0, "t1": c1, "source": "camera"}); n_cam += 1
        print(f"camera label runs: {n_cam}" + ("" if cam.MAP.exists() else " (no calibrated camera map yet)"))
    except Exception as e:
        print("camera labels skipped:", e)
    return [b for b in blocks if b["t1"] > t_raw0 and b["t0"] < t_raw1]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--save", action="store_true")
    ap.add_argument("--guard", action="store_true", help="with --save: refuse if held-out drops >5 pts vs the live model")
    a = ap.parse_args()
    print(time.strftime("=== %Y-%m-%d %H:%M ==="))
    files = sorted(glob.glob(str(lt.RAW / "*.npz")))
    t_raw0 = float(np.load(files[0])["t"][0]); t_raw1 = float(np.load(files[-1])["t"][-1])
    blocks = labelled_blocks(t_raw0, t_raw1)
    for b in blocks:
        b["round"] = int(b["t0"] // BLOCK)          # time block = CV group
    raw = lt.load_raw(min(b["t0"] for b in blocks) - 1, max(b["t1"] for b in blocks) + 1)
    M_old = pickle.load(open(lt.MODEL, "rb")) if lt.MODEL.exists() else None
    keys = [tuple(k) for k in M_old["views"]] if M_old else None
    # use the live model's view set so old and new models are comparable
    t, n, amp, src = raw
    lt.ACTIVE = M_old["active"] if M_old else amp.mean(0) > 0.5
    view = np.full(len(t), -1)
    for i, (node, mac) in enumerate(keys):
        view[(n == node) & (src == mac)] = i
    X, y, g = lt.windows(raw, blocks, (view, len(keys)))
    src_of = []
    for b in blocks:
        k = int((b["t1"] - b["t0"]) // lt.WIN)
        src_of += [b["source"]] * max(k, 0)
    # cap self-labelled desk windows per time block
    rng = np.random.default_rng(0); keep = np.ones(len(y), bool)
    for blk in np.unique(g):
        idx = np.where((g == blk) & (y == "desk"))[0]
        if len(idx) > DESK_CAP_PER_BLOCK:
            keep[rng.choice(idx, len(idx) - DESK_CAP_PER_BLOCK, replace=False)] = False
    X, y, g = X[keep], y[keep], g[keep]
    print(f"{len(y)} windows from {len(set(g))} ten-minute blocks; labels: " +
          ", ".join(f"{s} {int((y==s).sum())}" for s in sorted(set(y))))
    hours = (max(b['t1'] for b in blocks) - min(b['t0'] for b in blocks)) / 3600
    print(f"span {hours:.1f} h")
    # time-blocked CV for the NEW recipe
    acc, pred = lt.lor_score(X, y, g)
    print(f"\nNEW (all labels), held-out 10-min blocks: {acc:.1%}")
    print("  per spot:", ", ".join(f"{s} {np.mean(pred[y==s]==s):.0%} (n={int((y==s).sum())})" for s in sorted(set(y))))
    if M_old:
        po = M_old["model"].predict(X)
        print(f"OLD live model on the same windows (includes its own training walk, so flattered): {np.mean(po==y):.1%}")
        print("  per spot:", ", ".join(f"{s} {np.mean(po[y==s]==s):.0%}" for s in sorted(set(y))))
    if a.save and a.guard and M_old and M_old.get("cv") == "time-blocked 10 min":
        prev = float(M_old.get("acc_heldout") or 0)
        if acc < prev - 0.05:
            print(f"NOT saving: held-out {acc:.1%} is more than 5 pts below the live model's {prev:.1%}")
            return
    if a.save:
        m = lt.model().fit(X, y)
        T = lt.temperature(lt.LAST_CV["P"], lt.LAST_CV["Y"]) if lt.LAST_CV.get("P") is not None else 10.0
        pickle.dump({"model": m, "active": lt.ACTIVE, "views": keys, "win": lt.WIN,
                     "spots": list(m.classes_), "acc_heldout": acc, "temperature": T,
                     "hmm_stay_per_s": 0.9, "sessions": ["auto:" + time.strftime("%Y-%m-%d %H:%M")],
                     "cv": "time-blocked 10 min"}, open(lt.MODEL, "wb"))
        print(f"saved (T={T:.1f})")

if __name__ == "__main__":
    main()
