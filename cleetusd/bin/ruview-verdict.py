#!/usr/bin/env python3
"""ruview-verdict.py: does the RF change when he arrives, and can this test tell?

Supersedes the best-of-21 scoring in ruview-transitions.py, which had a bias it
could not measure. Picking the strongest of 21 features AT EACH TRANSITION and
then averaging is a lottery: whichever feature has the widest dynamic range wins
most often whether or not it carries information. That method reported 0.705 and
was read as "trending negative but close". Scored honestly the same data gives
0.545, which is noise.

Three things this does differently.

1. EVERY FEATURE IS FIXED A PRIORI and scored across every transition. No
   per-transition selection, so chance is 0.5 and not "somewhere nearer 0.6".

2. CONSISTENCY IS REPORTED ALONGSIDE AUC, and it is the more useful of the two.
   A real effect moves the SAME feature the SAME direction at most transitions.
   Noise produces a respectable-looking mean AUC with consistency near 50%.
   That distinction is what separates the two on this data.

3. A POSITIVE CONTROL RUNS EVERY TIME. Synthetic effects of known size are
   pushed through the identical pipeline, so the output states what this test
   COULD have detected. A negative result with no positive control is not a
   result, it is an absence of one, and this project has already drawn a wrong
   conclusion from an unvalidated harness once.

Two questions are asked, because they are not the same question:
  SEATED  is he at the desk, over four-minute windows either side.
  MOVING  did something cross the room, over seconds around the crossing.
CSI is fundamentally a motion sensor, so MOVING is the kinder question and the
one worth checking before concluding the hardware is useless.
"""
import json, pathlib, sys, time
import numpy as np

# The collector caps each file at 200 MB and stops. Rotated parts are named
# ruview-labeled.partN.jsonl, so read EVERY part: pointing at the live file
# alone silently analyses only whatever has accumulated since the last rotation,
# which looks like a successful run over a fraction of the data.
_ROOM = pathlib.Path.home() / "cleetusd/roomwatch"
SRCS = sorted(_ROOM.glob("ruview-labeled*.jsonl"))
SRC = _ROOM / "ruview-labeled.jsonl"
FEATS = ["mbp", "bbp", "var", "spec", "dom", "chg", "rssi"]
NODES = ["1", "2", "3"]
NAMES = [f"{n}.{f}" for n in NODES for f in FEATS]

# What counts as a real effect. Both must hold: a mean away from chance AND the
# same direction at most transitions. Either alone is reachable by noise.
MIN_DEV, MIN_CONS = 0.10, 0.80


def load():
    if not SRCS:
        sys.exit(f"no data in {_ROOM}: run ruview-collect.mjs first")
    rows = []
    for _src in SRCS:
      for line in _src.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass          # a torn last line while the collector is writing
    rows.sort(key=lambda r: r["t"])
    return rows


def vec(r):
    out = []
    for n in NODES:
        d = (r.get("n") or {}).get(n) or {}
        out += [float(d.get(f) or 0.0) for f in FEATS]
    return out


def auc(score, label):
    order = np.argsort(score)
    rank = np.empty(len(score))
    rank[order] = np.arange(1, len(score) + 1)
    pos, neg = label.sum(), len(label) - label.sum()
    if pos == 0 or neg == 0:
        return float("nan")
    return (rank[label == 1].sum() - pos * (pos + 1) / 2) / (pos * neg)


def summarise(per_feature):
    """mean AUC and directional consistency for each feature."""
    out = []
    for name, vals in per_feature.items():
        v = np.array(vals)
        if len(v) < 5:
            continue
        m = float(v.mean())
        cons = float(np.mean((v - 0.5) * (m - 0.5) > 0))
        out.append({"name": name, "auc": m, "cons": cons, "dev": abs(m - 0.5), "n": len(v)})
    out.sort(key=lambda d: -d["dev"])
    return out


def report(title, summary, note=""):
    print(f"\n  {title}")
    if note:
        print(f"    {note}")
    if not summary:
        print("    not enough transitions to score")
        return None
    print(f"    {'feature':12} {'AUC':>6} {'consistency':>12}")
    for d in summary[:5]:
        real = d["dev"] >= MIN_DEV and d["cons"] >= MIN_CONS
        print(f"    {d['name']:12} {d['auc']:6.3f} {d['cons']*100:11.0f}%{'   <-- REAL' if real else ''}")
    return summary[0]


def main():
    rows = load()
    X = np.array([vec(r) for r in rows])
    t = np.array([r["t"] for r in rows])
    y = np.array([1 if r["at_desk"] else 0 for r in rows])

    edges = [i for i in range(1, len(y)) if y[i] != y[i - 1] and t[i] - t[i - 1] < 5]
    span_h = (t[-1] - t[0]) / 3600
    print(f"{len(rows):,} samples over {span_h:.1f} h, {len(edges)} transitions "
          f"({y.sum():,} at desk, {len(y)-y.sum():,} away)")
    if len(edges) < 5:
        sys.exit("\nfewer than 5 transitions: nothing here can be concluded either way.")

    # ── SEATED: four minutes either side of the transition ────────────────
    PAD, GAP = 240, 30
    seated = {n: [] for n in NAMES}
    used = 0
    for e in edges:
        pre = (t >= t[e] - PAD) & (t < t[e] - GAP)
        post = (t > t[e] + GAP) & (t <= t[e] + PAD)
        if pre.sum() < 60 or post.sum() < 60:
            continue
        used += 1
        # Orient so 1 always means AT DESK, whichever way this transition went.
        lab = np.concatenate([np.full(pre.sum(), 1 - y[e]), np.full(post.sum(), y[e])])
        for j, name in enumerate(NAMES):
            a = auc(np.concatenate([X[pre, j], X[post, j]]), lab)
            if not np.isnan(a):
                seated[name].append(a)
    s_top = report(f"SEATED  ({used} transitions, 4 min either side)", summarise(seated),
                   "drift is controlled by construction: both sides are minutes apart")

    # ── MOVING: seconds around the crossing, against quiet minutes nearby ──
    et = t[np.array(edges)]
    far = np.ones(len(t), bool)
    for e in et:
        far &= np.abs(t - e) > 360
    moving = {n: [] for n in NAMES}
    usedm = 0
    for e in edges:
        mov = np.abs(t - t[e]) <= 20
        ref = far & (np.abs(t - t[e]) < 1800)      # quiet, same RF era
        if mov.sum() < 8 or ref.sum() < 120:
            continue
        usedm += 1
        lab = np.concatenate([np.zeros(ref.sum()), np.ones(mov.sum())])
        for j, name in enumerate(NAMES):
            a = auc(np.concatenate([X[ref, j], X[mov, j]]), lab)
            if not np.isnan(a):
                moving[name].append(a)
    m_top = report(f"MOVING  ({usedm} crossings, 20 s window vs quiet minutes)", summarise(moving),
                   "CSI is a motion sensor, so this is the kinder question")

    # ── POSITIVE CONTROL: what could this test have found? ────────────────
    print("\n  POSITIVE CONTROL (synthetic effects through the same pipeline)")
    rng = np.random.default_rng(7)

    def probe(feature):
        vals = []
        for e in edges:
            pre = (t >= t[e] - PAD) & (t < t[e] - GAP)
            post = (t > t[e] + GAP) & (t <= t[e] + PAD)
            if pre.sum() < 60 or post.sum() < 60:
                continue
            lab = np.concatenate([np.full(pre.sum(), 1 - y[e]), np.full(post.sum(), y[e])])
            a = auc(np.concatenate([feature[pre], feature[post]]), lab)
            if not np.isnan(a):
                vals.append(a)
        v = np.array(vals)
        m = float(v.mean())
        return m, float(np.mean((v - 0.5) * (m - 0.5) > 0))

    print(f"    {'planted effect':16} {'AUC':>6} {'consistency':>12}")
    a, c = probe(rng.normal(size=len(t)))
    print(f"    {'none (noise)':16} {a:6.3f} {c*100:11.0f}%")
    floor = None
    for amp in (0.10, 0.25, 0.50, 1.00):
        a, c = probe(rng.normal(size=len(t)) + amp * y)
        print(f"    {f'{amp:.2f} sigma':16} {a:6.3f} {c*100:11.0f}%")
        if floor is None and c >= MIN_CONS:
            floor = amp

    # ── verdict ───────────────────────────────────────────────────────────
    print("\n" + "=" * 62)
    best = max([d for d in (s_top, m_top) if d], key=lambda d: d["dev"], default=None)
    if best and best["dev"] >= MIN_DEV and best["cons"] >= MIN_CONS:
        print(f"SIGNAL: {best['name']} at AUC {best['auc']:.3f}, {best['cons']*100:.0f}% consistent.")
        print("Worth building on. Confirm it holds on a fresh collection before trusting it.")
    else:
        line = f"NO SIGNAL. Best is {best['name']} at AUC {best['auc']:.3f} with "\
               f"{best['cons']*100:.0f}% consistency." if best else "NO SIGNAL."
        print(line)
        if floor:
            print(f"The control shows this test detects a consistent effect from about "
                  f"{floor:.2f} sigma;")
            print("the real features do not reach that, so this is a measurement, not a shrug.")
        print("\nThe geometry is the known cause: the router is downstairs, so every sensed")
        print("path arrives through the floor as scattered multipath and a seated body")
        print("rarely intersects it. No feature or threshold repairs that. The untried fix")
        print("is a 2.4 GHz transmitter INSIDE the room, with each node's --filter-mac")
        print("pointed at it (USB per board).")


if __name__ == "__main__":
    main()
