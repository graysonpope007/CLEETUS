#!/usr/bin/env python3
"""ruview-train.py — can a FITTED model read desk presence out of the RF?

Every previous answer thresholded one feature. This fits all of them together
and cross-validates honestly, which is a different and much fairer question.

TWO THINGS THAT WOULD MAKE THE ANSWER A LIE IF SKIPPED
======================================================

1. BLOCKED CROSS-VALIDATION, NOT RANDOM K-FOLD. Samples are taken one second
   apart and are massively autocorrelated: the row before and the row after a
   held-out sample are almost the same measurement. Random k-fold therefore
   trains on the test row's near-duplicates and reports a beautiful AUC that
   means nothing. Splits here are CONTIGUOUS TIME BLOCKS, so the model is
   always tested on a stretch of time it has never seen.

2. THE AMBIGUOUS MIDDLE IS DROPPED. The label is HID idle time, so "away" at
   90 seconds idle usually means "sitting right there, reading". Rows between
   IDLE_LO and IDLE_HI are excluded rather than fed in as noise — a model
   trained on wrong labels learns to reproduce them.

A window of raw values is also mostly useless on its own: presence shows up in
how a signal VARIES over seconds, not in one instant. Each window contributes
mean / std / min / max / slope per feature.
"""
import json, sys, pathlib
import numpy as np

SRC = pathlib.Path.home()/"cleetusd/roomwatch/ruview-labeled.jsonl"
WIN = 30          # seconds per window
STRIDE = 5        # seconds between windows
IDLE_LO, IDLE_HI = 60, 600     # the ambiguous middle, excluded
FOLDS = 5

rows = []
for line in SRC.read_text().splitlines():
    if not line.strip(): continue
    try: rows.append(json.loads(line))
    except Exception: pass
if len(rows) < 400:
    print(f"only {len(rows)} rows — need a few thousand and both classes. Still collecting.")
    sys.exit(0)

rows.sort(key=lambda r: r["t"])
FEATS = ["mbp", "bbp", "var", "spec", "dom", "chg", "rssi"]
NODES = ["1", "2", "3"]

def vec(r):
    out = []
    for n in NODES:
        d = (r.get("n") or {}).get(n) or {}
        out += [float(d.get(f) or 0.0) for f in FEATS]
    rm = r.get("room") or {}
    out += [float(rm.get(f) or 0.0) for f in ["mbp", "bbp", "var", "spec", "dom", "chg"]]
    return out

raw = np.array([vec(r) for r in rows], dtype=float)
ts  = np.array([r["t"] for r in rows])
at  = np.array([1 if r["at_desk"] else 0 for r in rows])
idle= np.array([float(r.get("idle") or 0) for r in rows])

X, y, T = [], [], []
i = 0
while i + WIN < len(rows):
    sl = slice(i, i + WIN)
    if ts[i + WIN - 1] - ts[i] > WIN * 3:      # a gap: not a real window
        i += STRIDE; continue
    lab = at[sl]
    if lab.mean() not in (0.0, 1.0):           # label must be constant across it
        i += STRIDE; continue
    lo, hi = idle[sl].min(), idle[sl].max()
    if lab[0] == 0 and not (hi >= IDLE_HI):    # "away" must be properly away
        i += STRIDE; continue
    if lab[0] == 1 and not (hi <= IDLE_LO):    # "at desk" must be properly active
        i += STRIDE; continue
    w = raw[sl]
    xs = np.arange(WIN)
    slope = ((xs - xs.mean()) @ (w - w.mean(0))) / max(((xs - xs.mean()) ** 2).sum(), 1e-9)
    X.append(np.concatenate([w.mean(0), w.std(0), w.min(0), w.max(0), slope]))
    y.append(lab[0]); T.append(ts[i])
    i += STRIDE

X = np.array(X); y = np.array(y); T = np.array(T)
if len(y) < 40 or y.sum() == 0 or y.sum() == len(y):
    print(f"{len(y)} clean windows, {int(y.sum())} at-desk / {len(y)-int(y.sum())} away — need both classes. Still collecting.")
    sys.exit(0)

hrs = (ts[-1] - ts[0]) / 3600
print(f"{len(rows)} rows over {hrs:.1f} h -> {len(y)} clean {WIN}s windows")
print(f"  at desk {int(y.sum())}   away {len(y)-int(y.sum())}   ({X.shape[1]} features)\n")

def auc(sc, lab):
    o = np.argsort(sc); r = np.empty(len(sc)); r[o] = np.arange(1, len(sc)+1)
    p, n = lab.sum(), len(lab)-lab.sum()
    if p == 0 or n == 0: return float("nan")
    return (r[lab == 1].sum() - p*(p+1)/2) / (p*n)

def fit(Xtr, ytr, iters=4000, lr=0.15, l2=1e-2):
    w = np.zeros(Xtr.shape[1]); b = 0.0
    for _ in range(iters):
        z = np.clip(Xtr @ w + b, -30, 30); pr = 1/(1+np.exp(-z)); g = pr - ytr
        w -= lr * ((Xtr.T @ g)/len(ytr) + l2*w); b -= lr * g.mean()
    return w, b

# Contiguous time blocks. See note 1 at the top.
order = np.argsort(T)
X, y = X[order], y[order]
edges = np.linspace(0, len(y), FOLDS+1).astype(int)
scores = []
for k in range(FOLDS):
    te = np.zeros(len(y), bool); te[edges[k]:edges[k+1]] = True
    if y[~te].sum() in (0, (~te).sum()) or y[te].sum() in (0, te.sum()): continue
    mu, sd = X[~te].mean(0), X[~te].std(0) + 1e-9
    w, b = fit((X[~te]-mu)/sd, y[~te])
    a = auc(((X[te]-mu)/sd) @ w + b, y[te])
    scores.append(a)
    print(f"  block {k+1}: test AUC {a:.3f}  (train {int(y[~te].sum())}/{(~te).sum()}, test {int(y[te].sum())}/{te.sum()})")

if scores:
    m = float(np.mean(scores))
    print(f"\n  BLOCKED CV AUC = {m:.3f}   (0.5 = coin flip, >0.90 = usable trigger)")
    print(f"  {'USABLE — wire it in.' if m >= 0.90 else 'NOT usable yet.'}")
    # For contrast only: the number a random split would have printed.
    rng = np.random.default_rng(0); perm = rng.permutation(len(y))
    Xr, yr = X[perm], y[perm]; te = np.zeros(len(y), bool); te[:len(y)//FOLDS] = True
    mu, sd = Xr[~te].mean(0), Xr[~te].std(0)+1e-9
    w, b = fit((Xr[~te]-mu)/sd, yr[~te])
    print(f"  (a RANDOM split would have claimed {auc(((Xr[te]-mu)/sd)@w+b, yr[te]):.3f} — that is leakage, not skill)")
