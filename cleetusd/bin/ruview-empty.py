#!/usr/bin/env python3
"""ruview-empty.py: what RuView says about a room somebody confirmed was empty.

Every measurement before 2026-08-24 labelled the negative class from HID idle
time. That answers "is he touching the keyboard", which is a fine proxy for AT
DESK and a poor one for EMPTY ROOM: reading on the bed, sleeping, and being out
of the house all land in the same bucket. 200,000 of the first 215,000 rows
carry that label, so the negative class was never clean.

`ruview-truth.mjs` records windows a human asserts, with their source. This
reads those windows and reports two things:

  1. FALSE POSITIVE RATE of the signals RuView presents as answers, over a
     window where the correct answer is known. That is a number the project has
     never had, and it does not depend on any model or threshold.

  2. THE EMPTY-ROOM REFERENCE DISTRIBUTION for every raw feature. Anything
     built later needs to know what quiet actually looks like on this hardware,
     and a distribution measured over a poisoned negative class is not that.

If a verified OCCUPIED window also exists, the two are compared directly. That
is the cleanest test this project can run: both classes verified, no inference.
"""
import json, pathlib, sys
import numpy as np

ROOT = pathlib.Path.home() / "cleetusd/roomwatch"
TRUTH, FEATS_F = ROOT / "ruview-truth.jsonl", ROOT / "ruview-labeled.jsonl"
VERDICTS, EVENTS = ROOT / "ruview-verdicts.jsonl", ROOT / "events.jsonl"
FEATS = ["mbp", "bbp", "var", "spec", "dom", "chg", "rssi"]
NODES = ["1", "2", "3"]


def jsonl(path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass          # torn last line while a collector is writing
    return out


def windows():
    """Pair begin/end markers into closed windows; an open one runs to now."""
    import time
    out, start = [], None
    for r in sorted(jsonl(TRUTH), key=lambda r: r["t"]):
        if r["event"] == "begin":
            start = r
        elif r["event"] == "end" and start:
            out.append((start["state"], start["t"], r["t"], start.get("note", "")))
            start = None
    if start:
        out.append((start["state"], start["t"], time.time(), start.get("note", "") + " [still open]"))
    return out


def inside(rows, lo, hi):
    return [r for r in rows if lo <= r["t"] <= hi]


def main():
    wins = windows()
    if not wins:
        sys.exit(f"no verified windows in {TRUTH}\n"
                 f"open one with:  ruview-truth.mjs begin empty \"reason\"")

    print("VERIFIED WINDOWS")
    for state, lo, hi, note in wins:
        print(f"  {state:8} {(hi-lo)/60:7.1f} min   {note}")

    verdicts = jsonl(VERDICTS)
    feats = jsonl(FEATS_F)

    # ── 0. Does the CAMERA agree the room was empty? ──────────────────────
    # A human label nobody corroborates is how this project got a negative
    # class full of "reading on the bed". roomwatch scores every 30 s heartbeat
    # as changed_pct: a still room measures 0.00 and a person 3 to 98, so the
    # camera can contradict the claim independently of any RF signal.
    import datetime as dt
    cam = []
    for r in jsonl(EVENTS):
        if r.get("changed_pct") is None or not r.get("at"):
            continue
        try:
            ts = dt.datetime.fromisoformat(r["at"].replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        cam.append({"t": ts, "pct": float(r["changed_pct"]), "kind": r.get("kind")})

    PERSON_PCT = 3.0        # roomwatch measured a person at 3 to 98 percent
    for state, lo, hi, _ in wins:
        c = inside(cam, lo, hi)
        if not c:
            continue
        pcts = np.array([x["pct"] for x in c])
        big = [x for x in c if x["pct"] >= PERSON_PCT]
        print(f"\nCAMERA CHECK on the verified {state.upper()} window ({len(c)} heartbeats)")
        print(f"    changed_pct: median {np.median(pcts):.3f}, p95 {np.percentile(pcts,95):.3f}, max {pcts.max():.3f}")
        if state == "empty" and big:
            print(f"    !! {len(big)} heartbeat(s) at or above {PERSON_PCT}%, which is the range a")
            print(f"       PERSON produces. This window may not be empty throughout:")
            for x in big[:5]:
                print(f"         {dt.datetime.fromtimestamp(x['t']).strftime('%H:%M:%S')}  {x['pct']:.2f}%")
        elif state == "empty":
            print(f"    camera agrees: nothing reached the {PERSON_PCT}% a person produces.")
            trips = [x for x in c if x["kind"] == "motion_confirmed"]
            if trips:
                print(f"    ({len(trips)} tripped roomwatch's own 0.5% gate, all far below a person:")
                print(f"     max {max(x['pct'] for x in trips):.2f}%. That gate is set low on purpose.)")

    # ── 1. What did RuView claim, when the answer was known? ──────────────
    for state, lo, hi, _ in wins:
        v = inside(verdicts, lo, hi)
        if not v:
            continue
        print(f"\nWHAT RUVIEW SAID during {(hi-lo)/60:.0f} min of verified {state.upper()}"
              f"  ({len(v)} samples)")
        # person_count per node
        for nid in NODES:
            pcs = [s["nodes"].get(nid, {}).get("pc") for s in v]
            pcs = [p for p in pcs if p is not None]
            if not pcs:
                continue
            wrong = sum(1 for p in pcs if (p > 0) != (state == "occupied"))
            print(f"    node {nid} person_count: mean {np.mean(pcs):.2f}, "
                  f"said {'someone' if state=='empty' else 'nobody'} {wrong/len(pcs)*100:.0f}% of the time")
        # motion_level
        mls = [s["nodes"].get(n, {}).get("ml") for s in v for n in NODES]
        mls = [m for m in mls if m]
        if mls:
            from collections import Counter
            top = Counter(mls).most_common(3)
            print(f"    motion_level: " + ", ".join(f"{k} {c/len(mls)*100:.0f}%" for k, c in top))
        # pose
        pn = [s["pose"]["n"] for s in v if s.get("pose")]
        if pn:
            kp = [s["pose"]["maxkp"] for s in v if s.get("pose") and s["pose"]["maxkp"] is not None]
            print(f"    pose persons: mean {np.mean(pn):.1f}, max {max(pn)}, "
                  f"nonzero {sum(1 for p in pn if p)/len(pn)*100:.0f}% of samples")
            if kp:
                print(f"    pose keypoint confidence, best seen anywhere: {max(kp):.2f}")
        # presence flag from edge-vitals
        pres = [s["ev"].get("presence") for s in v if s.get("ev")]
        pres = [p for p in pres if p is not None]
        if pres:
            print(f"    edge-vitals presence true: {sum(pres)/len(pres)*100:.0f}% of samples")

    # ── 2. The empty-room reference distribution ──────────────────────────
    empt = [r for state, lo, hi, _ in wins if state == "empty" for r in inside(feats, lo, hi)]
    occ = [r for state, lo, hi, _ in wins if state == "occupied" for r in inside(feats, lo, hi)]

    if empt:
        print(f"\nEMPTY-ROOM REFERENCE ({len(empt)} samples)")
        print(f"    {'feature':12} {'p05':>9} {'median':>9} {'p95':>9} {'p99':>9}")
        for n in NODES:
            for f in FEATS:
                v = np.array([float(((r.get('n') or {}).get(n) or {}).get(f) or 0.0) for r in empt])
                if not v.any():
                    continue
                q = np.percentile(v, [5, 50, 95, 99])
                print(f"    {n}.{f:10} {q[0]:9.2f} {q[1]:9.2f} {q[2]:9.2f} {q[3]:9.2f}")

    # ── 3. Both classes verified: the cleanest comparison available ───────
    if empt and occ:
        def auc(a, b):
            s = np.concatenate([a, b]); lab = np.concatenate([np.zeros(len(a)), np.ones(len(b))])
            o = np.argsort(s); r = np.empty(len(s)); r[o] = np.arange(1, len(s) + 1)
            p, q = lab.sum(), len(lab) - lab.sum()
            return float("nan") if p == 0 or q == 0 else (r[lab == 1].sum() - p * (p + 1) / 2) / (p * q)
        print(f"\nVERIFIED EMPTY ({len(empt)}) vs VERIFIED OCCUPIED ({len(occ)})")
        print("    Both classes asserted by a human. No inferred labels anywhere.")
        rows = []
        for n in NODES:
            for f in FEATS:
                a = np.array([float(((r.get('n') or {}).get(n) or {}).get(f) or 0.0) for r in empt])
                b = np.array([float(((r.get('n') or {}).get(n) or {}).get(f) or 0.0) for r in occ])
                if not a.any() and not b.any():
                    continue
                rows.append((abs(auc(a, b) - 0.5), auc(a, b), f"{n}.{f}"))
        rows.sort(reverse=True)
        print(f"    {'feature':12} {'AUC':>7}")
        for dev, a, name in rows[:8]:
            print(f"    {name:12} {a:7.3f}{'   <-- separates' if dev > 0.15 else ''}")
        print("\n    Caveat that does not go away: these two windows are at different")
        print("    TIMES, so RF drift is a confound. A feature that separates here and")
        print("    not in ruview-verdict.py's transition test is measuring the hour.")
    elif empt:
        print("\n    No verified OCCUPIED window yet. Mark one when he is back at the desk:")
        print("      ruview-truth.mjs begin occupied \"at the desk\"")
        print("    Then this prints the comparison with both classes verified.")


if __name__ == "__main__":
    main()
