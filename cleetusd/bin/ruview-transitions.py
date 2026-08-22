#!/usr/bin/env python3
"""ruview-transitions.py — the drift-controlled question.

Blocked CV over a whole session asks "can a model trained on one stretch of
time score a different stretch". With few transitions that mostly measures RF
DRIFT: the environment changes hour to hour, at-desk and away sit in different
hours, and a classifier happily learns the hour instead of the person. The first
run showed exactly that shape — per-block AUC swinging 0.85 / 0.36 / 0.15.

This asks the sharper question instead. Around each moment he sat down or got
up, take the minutes immediately BEFORE and AFTER and ask whether they can be
told apart. Both sides are minutes apart, so drift is controlled by
construction, and it is the question that actually matters: does the RF change
when he arrives?

Reported per transition AND pooled, because one lucky transition proves nothing.
"""
import json, pathlib, sys
import numpy as np

rows = [json.loads(l) for l in
        (pathlib.Path.home()/"cleetusd/roomwatch/ruview-labeled.jsonl").read_text().splitlines() if l.strip()]
rows.sort(key=lambda r: r["t"])
FEATS = ["mbp", "bbp", "var", "spec", "dom", "chg", "rssi"]
NODES = ["1", "2", "3"]

def vec(r):
    out = []
    for n in NODES:
        d = (r.get("n") or {}).get(n) or {}
        out += [float(d.get(f) or 0.0) for f in FEATS]
    return out

X = np.array([vec(r) for r in rows]); t = np.array([r["t"] for r in rows])
y = np.array([1 if r["at_desk"] else 0 for r in rows]); idle = np.array([float(r.get("idle") or 0) for r in rows])

edges = [i for i in range(1, len(y)) if y[i] != y[i-1] and t[i]-t[i-1] < 5]
print(f"{len(rows)} rows, {len(edges)} transitions\n")
if not edges:
    print("  no transitions yet — a fit cannot separate what never changed."); sys.exit(0)

def auc(sc, lab):
    o=np.argsort(sc); r=np.empty(len(sc)); r[o]=np.arange(1,len(sc)+1)
    p,n=lab.sum(),len(lab)-lab.sum()
    return float("nan") if p==0 or n==0 else (r[lab==1].sum()-p*(p+1)/2)/(p*n)

PAD, GAP = 240, 30      # 4 min each side, skipping 30 s around the edge itself
scores, pooled_d = [], []
for e in edges:
    lo, hi = t[e]-PAD, t[e]+PAD
    pre  = (t>=lo) & (t< t[e]-GAP)
    post = (t> t[e]+GAP) & (t<=hi)
    if pre.sum() < 60 or post.sum() < 60: continue
    # single-feature discrimination, per feature, both directions
    best = 0.0; bestname=""
    for j in range(X.shape[1]):
        a = auc(np.concatenate([X[pre,j], X[post,j]]),
                np.concatenate([np.zeros(pre.sum()), np.ones(post.sum())]))
        d = abs(a-0.5)
        if d > best: best, bestname = d, f"{NODES[j//7]}.{FEATS[j%7]}"
    scores.append(best+0.5)
    lab = "sat down" if y[e]==1 else "got up"
    print(f"  {lab:>9} @ {__import__('time').strftime('%H:%M', __import__('time').localtime(t[e]))}: "
          f"best single-feature AUC {best+0.5:.3f}  ({bestname})")

if scores:
    m = float(np.mean(scores))
    print(f"\n  mean best-feature AUC across {len(scores)} transitions = {m:.3f}")
    print("  NOTE: this is the BEST of 21 features chosen per transition, so it is")
    print("  optimistically biased — chance is nearer 0.6 than 0.5 with that many picks.")
    print(f"  {'Something real is here.' if m > 0.75 else 'No usable signal at the moment he arrives.'}")
