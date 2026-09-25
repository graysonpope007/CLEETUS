#!/usr/bin/env python3
"""ruview-locate-test.py: can multipath fingerprints say WHERE someone is?

No geometry, no link lines. Each receiver's channel across its 52 active
subcarriers is a fingerprint of every reflection in the room; a body anywhere
changes it. The question is whether that change is (a) repeatable per spot and
(b) bigger than the room's own drift. This answers it honestly:

  * features per 3 s window, per node: gain-normalised log amplitude profile
    (mean, 52 dims) and its per-subcarrier spread (std, 52 dims, i.e. motion)
  * LEAVE-ONE-ROUND-OUT: train on the other rounds, test on a round never seen
  * controls, every run:
      - label-shuffle: the same pipeline with block labels permuted -> must be chance
      - planted: real CSI with a synthetic spot signal of known size -> sets what
        the test CAN detect (only with --synthetic)

  ruview-locate-test.py <session.jsonl>          score a real session
  ruview-locate-test.py --synthetic [--minutes 18] [--effect 0.03]
      fake 6-spot x 3-round session over the most recent raw CSI; with
      --effect 0 it must read chance, with an effect it must read high
  ruview-locate-test.py <session.jsonl> --save   also write the live model
"""
import sys, json, glob, pathlib, argparse, pickle
import numpy as np
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

RAW = pathlib.Path.home() / "cleetusd/roomwatch/csi-raw"
MODEL = pathlib.Path.home() / "cleetusd/roomwatch/locate-model.pkl"
WIN = 3.0
NODES = [1, 2, 3]

def load_raw(t0, t1):
    ts, ns, amps, srcs = [], [], [], []
    for f in sorted(glob.glob(str(RAW / "*.npz"))):
        d = np.load(f)
        if len(d["t"]) == 0 or d["t"][-1] < t0 or d["t"][0] > t1:
            continue
        # drop empty/garbage frames (all-zero I/Q) that blow up the gain normalisation
        m = (d["t"] >= t0) & (d["t"] <= t1) & (d["amp"].astype(np.float32).mean(1) > 1.0)
        ts.append(d["t"][m]); ns.append(d["node"][m]); amps.append(d["amp"][m].astype(np.float32))
        srcs.append(d["src"][m] if "src" in d.files else np.zeros(m.sum(), np.uint64))
    if not ts:
        return None
    return np.concatenate(ts), np.concatenate(ns), np.concatenate(amps), np.concatenate(srcs)

ACTIVE = None
K_MODES = 2
def logprof(a):
    global ACTIVE
    if ACTIVE is None:
        ACTIVE = a.mean(0) > 0.5
    x = a[:, ACTIVE]
    x = x / (x.mean(1, keepdims=True) + 1e-6)          # remove AGC gain per frame
    return np.log(x + 1e-3)

def node_feats(lx):
    return np.concatenate([lx.mean(0), lx.std(0)])

VIEW_KEYS = []
MIN_VIEW_RATE = 1.0   # frames/s a (node, transmitter) pair needs to count as a view

def fit_views(raw):
    """A VIEW is one transmitter heard by one receiver. Multi-illuminator
    firmware tags each frame with its transmitter MAC; for nodes on older
    firmware (src 0) the transmitters are separated label-free by k-means on
    profile shape. Returns a per-frame view id (-1 = discarded) and the count."""
    from sklearn.cluster import KMeans
    global ACTIVE
    t, n, a, src = raw
    ACTIVE = a.mean(0) > 0.5          # guard/null subcarriers read ~0 on every view
    dur = max(t[-1] - t[0], 1.0)
    global VIEW_KEYS
    view = np.full(len(t), -1); nv = 0; VIEW_KEYS = []
    for node in NODES:
        m = n == node
        if not m.any():
            continue
        tagged = src[m] != 0
        if tagged.mean() > 0.5:
            for mac in np.unique(src[m][tagged]):
                mm = m & (src == mac)
                if mm.sum() / dur >= MIN_VIEW_RATE:
                    view[mm] = nv; nv += 1; VIEW_KEYS.append((int(node), int(mac)))
        else:
            lx = logprof(a[m])
            km = KMeans(K_MODES, n_init=5, random_state=0).fit(lx)
            order = np.argsort(-np.bincount(km.labels_, minlength=K_MODES))
            remap = np.empty(K_MODES, int); remap[order] = np.arange(K_MODES)
            idx = np.where(m)[0]
            view[idx] = nv + remap[km.labels_]; nv += K_MODES
            VIEW_KEYS += [(int(node), -1 - k) for k in range(K_MODES)]   # untagged: k-means mode
    return view, nv

def windows(raw, blocks, views=None):
    t, n, a, src = raw
    view, nv = views if views is not None else fit_views(raw)
    width = 2 * int(ACTIVE.sum())
    X, y, g = [], [], []
    for b in blocks:
        w0 = b["t0"]
        while w0 + WIN <= b["t1"]:
            m = (t >= w0) & (t < w0 + WIN)
            parts = []
            for v in range(nv):
                mm = m & (view == v)
                parts.append(node_feats(logprof(a[mm])) if mm.sum() >= 2 else np.full(width, np.nan))
            # keep the window if at least half of the views reported
            if np.mean([not np.isnan(p_[0]) for p_ in parts]) >= 0.5:
                X.append(np.concatenate(parts)); y.append(b["spot"]); g.append(b["round"])
            w0 += WIN
    return np.array(X), np.array(y), np.array(g)

def model():
    from sklearn.impute import SimpleImputer
    return make_pipeline(SimpleImputer(keep_empty_features=True), StandardScaler(), LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto"))

LAST_CV = {}
SCORING = None
def lor_score(X, y, g):
    preds = np.empty(len(y), dtype=object)
    probs, truth = [], []
    for r in np.unique(g):
        tr, te = g != r, g == r
        if len(np.unique(y[tr])) < 2:
            continue
        m = model().fit(X[tr], y[tr]); preds[te] = m.predict(X[te])
        if set(y) <= set(m.classes_):
            probs.append(m.predict_proba(X[te])); truth += [list(m.classes_).index(v) for v in y[te]]
    LAST_CV["P"] = np.vstack(probs) if probs else None; LAST_CV["Y"] = np.array(truth)
    ok = preds == y
    return ok.mean(), preds

def temperature(P, Y):
    """Shrinkage LDA is wildly overconfident (claims ~100%, is right ~71%).
    Fit one temperature on held-out-round predictions by minimising NLL."""
    def nll(T):
        L = np.log(np.clip(P, 1e-12, 1)) / T; L -= L.max(1, keepdims=True)
        Q = np.exp(L); Q /= Q.sum(1, keepdims=True)
        return -np.mean(np.log(np.clip(Q[np.arange(len(Y)), Y], 1e-9, 1)))
    Ts = np.exp(np.linspace(0, np.log(80), 120))
    return float(min(Ts, key=nll))

def shuffled(blocks, seed):
    rng = np.random.default_rng(seed)
    out = []
    for r in sorted({b["round"] for b in blocks}):
        bs = [b for b in blocks if b["round"] == r]
        spots = [b["spot"] for b in bs]; rng.shuffle(spots)
        out += [dict(b, spot=s) for b, s in zip(bs, spots)]
    return out

def report(title, X, y, g):
    acc, preds = lor_score(X, y, g)
    spots = sorted(set(y)); chance = 1 / len(spots)
    print(f"\n{title}: {len(y)} windows, {len(spots)} spots, held-out-round accuracy {acc:.1%} (chance {chance:.1%})")
    print("  per spot:", ", ".join(f"{s} {np.mean(preds[y==s]==s):.0%}" for s in spots))
    pres = np.array([s != "out" for s in y]); pp = np.array([p != "out" for p in preds])
    if (~pres).any():
        print(f"  present-vs-out: {np.mean(pres==pp):.1%}  (out windows called present {np.mean(pp[~pres]):.0%}, present called out {np.mean(~pp[pres]):.0%})")
    return acc

def score_saved(raw, blocks):
    """Day-2 test: rebuild features with the SAVED model's views and subcarrier
    mask, predict, and report. Nothing is refit, so this is out-of-sample in
    time as well as in visits."""
    global ACTIVE
    M = pickle.load(open(MODEL, "rb"))
    ACTIVE = M["active"]
    t, n, a, src = raw
    keys = [tuple(k) for k in M["views"]]
    view = np.full(len(t), -1)
    for i, (node, mac) in enumerate(keys):
        view[(n == node) & (src == mac)] = i
    X, y, g = windows(raw, blocks, (view, len(keys)))
    trained_on = {str(pathlib.Path(p_).resolve()) for p_ in M.get("sessions", [])}
    if SCORING and str(pathlib.Path(SCORING).resolve()) in trained_on:
        print("WARNING: this session is IN the saved model's training set; the score below is in-sample and means nothing.")
    P = M["model"].predict_proba(X); cls = M["model"].classes_
    pred = cls[P.argmax(1)]
    spots = sorted(set(y))
    print(f"SAVED MODEL (trained {M.get('sessions')}) on {len(y)} new windows: accuracy {np.mean(pred == y):.1%} (chance {1/len(spots):.1%})")
    print("  per spot:", ", ".join(f"{s} {np.mean(pred[y==s]==s):.0%}" for s in spots))
    pres = y != "out"; pp = pred != "out"
    print(f"  present-vs-out: {np.mean(pres == pp):.1%}")
    return np.mean(pred == y)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", nargs="?")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--minutes", type=float, default=18)
    ap.add_argument("--effect", type=float, default=0.03)
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--extra", nargs="*", default=[], help="more session logs to train on together")
    ap.add_argument("--score-saved", action="store_true",
                    help="score this session against the SAVED model, no retraining (the day-2 test)")
    a = ap.parse_args()

    if a.synthetic:
        files = sorted(glob.glob(str(RAW / "*.npz")))
        tend = float(np.load(files[-1])["t"][-1]); tstart = tend - a.minutes * 60
        raw = load_raw(tstart, tend)
        spots = ["desk", "keys", "bed", "center", "closet", "out"]
        blk = a.minutes * 60 / (3 * len(spots)); rng = np.random.default_rng(0)
        blocks, t = [], tstart
        for r in range(3):
            order = rng.permutation(spots)
            for s in order:
                blocks.append({"round": r, "spot": str(s), "t0": t + 12, "t1": t + blk}); t += blk
        print(f"synthetic session over REAL raw CSI {a.minutes:.0f} min, {blk:.0f} s blocks, planted effect {a.effect:.1%}")
        if a.effect > 0:
            t_, n_, amp, src_ = raw; amp = amp.copy()
            pat = {s: np.exp(a.effect * rng.standard_normal((len(NODES), amp.shape[1]))) for s in spots if s != "out"}
            for b in blocks:
                if b["spot"] == "out": continue
                m = (t_ >= b["t0"] - 12) & (t_ < b["t1"])
                for i, node in enumerate(NODES):
                    mm = m & (n_ == node); amp[mm] *= pat[b["spot"]][i]
            raw = (t_, n_, amp, src_)
    else:
        blocks = []
        for i, sp in enumerate([a.session] + a.extra):
            blocks += [dict(json.loads(l), round=json.loads(l)["round"] + 10 * i) for l in open(sp) if l.strip()]
        raw = load_raw(min(b["t_move"] for b in blocks), max(b["t1"] for b in blocks))
        if raw is None:
            sys.exit("no raw CSI covers this session; is ruview-raw running?")
        if a.score_saved:
            global SCORING
            SCORING = a.session
            return score_saved(raw, blocks)

    X, y, g = windows(raw, blocks)
    if len(y) == 0:
        sys.exit("no complete windows (all three nodes must report)")
    acc = report("REAL LABELS", X, y, g)
    cvP, cvY = LAST_CV.get("P"), LAST_CV.get("Y")
    ctrl = [report(f"CONTROL shuffled #{i}", *windows(raw, shuffled(blocks, i))) for i in range(3)]
    print(f"\nverdict: real {acc:.1%} vs shuffled mean {np.mean(ctrl):.1%}")
    if a.save and not a.synthetic:
        m = model().fit(X, y)
        T = temperature(cvP, cvY) if cvP is not None else 1.0
        print(f"temperature {T:.1f} (fit on held-out-round predictions)")
        pickle.dump({"model": m, "active": ACTIVE, "views": VIEW_KEYS, "win": WIN,
                     "spots": list(m.classes_), "acc_heldout": acc, "temperature": T,
                     "hmm_stay_per_s": 0.9, "sessions": [a.session] + a.extra}, open(MODEL, "wb"))
        print("saved", MODEL)

if __name__ == "__main__":
    main()
