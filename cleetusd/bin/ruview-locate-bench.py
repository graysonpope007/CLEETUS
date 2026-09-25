#!/usr/bin/env python3
"""ruview-locate-bench.py: compare localisation variants on a walk, honestly.

Every candidate is scored the same way ruview-locate-test.py scores: train on
the other rounds, test on a held-out round it never saw. With only a few walks,
picking the best of many candidates on the same data overfits the choice
itself, so the candidate list is short and principled, every result is printed,
and the real verdict is the NEXT walk scored against the saved model
(ruview-locate-test.py --score-saved).

Also scores TIME SMOOTHING: a sticky forward filter (HMM) over the held-out
round's 1 s windows in time order, which is what the live service does.

  ruview-locate-bench.py <session.jsonl> [more sessions...]
"""
import sys, json, importlib.util, pathlib, itertools, time
import numpy as np
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.decomposition import PCA

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("lt", HERE / "ruview-locate-test.py")
lt = importlib.util.module_from_spec(spec); spec.loader.exec_module(lt)

# ---------- features -------------------------------------------------------
def view_feats(a, kind):
    x = a[:, lt.ACTIVE]
    gain = np.log(x.mean(1) + 1e-3)                       # per-frame level (AGC + shadowing)
    xn = x / (x.mean(1, keepdims=True) + 1e-6)
    lx = np.log(xn + 1e-3)
    f = [lx.mean(0), lx.std(0)]
    if kind in ("shape+level", "shape+level+delta"):
        f.append(np.array([gain.mean(), gain.std()]))
    if kind == "shape+level+delta":
        # frame-to-frame change per subcarrier: motion energy with spectral detail
        d = np.abs(np.diff(lx, axis=0)).mean(0) if len(lx) > 1 else np.zeros(lx.shape[1])
        f.append(d)
    return np.concatenate(f)

def build(raw, blocks, views, win, stride, kind):
    t, n, a, src = raw
    view, nv = views
    probe = view_feats(a[:3], kind); width = len(probe)
    X, y, g, tt = [], [], [], []
    for b in blocks:
        w0 = b["t0"]
        while w0 + win <= b["t1"]:
            m = (t >= w0) & (t < w0 + win)
            parts = []
            for v in range(nv):
                mm = m & (view == v)
                parts.append(view_feats(a[mm], kind) if mm.sum() >= 2 else np.full(width, np.nan))
            if np.mean([not np.isnan(p[0]) for p in parts]) >= 0.5:
                X.append(np.concatenate(parts)); y.append(b["spot"]); g.append(b["session"] * 10 + b["round"]); tt.append(w0 + win)
            w0 += stride
    return np.array(X), np.array(y), np.array(g), np.array(tt)

# ---------- models ---------------------------------------------------------
def models():
    imp = lambda: SimpleImputer(keep_empty_features=True)
    return {
        "LDA-shrink": lambda: make_pipeline(imp(), StandardScaler(), LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto")),
        "PCA40+LDA": lambda: make_pipeline(imp(), StandardScaler(), PCA(40, random_state=0), LinearDiscriminantAnalysis()),
        "LogReg-L2": lambda: make_pipeline(imp(), StandardScaler(), LogisticRegression(C=0.05, max_iter=3000)),
        "ExtraTrees": lambda: make_pipeline(imp(), ExtraTreesClassifier(400, max_features="sqrt", min_samples_leaf=2, n_jobs=-1, random_state=0)),
    }

# ---------- temporal filter ------------------------------------------------
def hmm_filter(P, classes, stay):
    """Forward filter with a sticky transition matrix; P rows are per-window
    class probabilities in time order. Returns filtered argmax indices."""
    k = P.shape[1]
    T = np.full((k, k), (1 - stay) / (k - 1)); np.fill_diagonal(T, stay)
    b = np.full(k, 1 / k); out = []
    for p in P:
        b = (T.T @ b) * np.clip(p, 1e-4, 1)
        b /= b.sum(); out.append(b.argmax())
    return np.array(out)

def evaluate(X, y, g, tt, make):
    raw_ok, filt = [], {s: [] for s in (0.8, 0.9, 0.95)}
    for r in np.unique(g):
        tr, te = g != r, g == r
        m = make().fit(X[tr], y[tr])
        P = m.predict_proba(X[te]); cls = m.classes_
        order = np.argsort(tt[te]); yt = y[te][order]; Pt = P[order]
        raw_ok += list(cls[Pt.argmax(1)] == yt)
        for s in filt:
            filt[s] += list(cls[hmm_filter(Pt, cls, s)] == yt)
    return np.mean(raw_ok), {s: np.mean(v) for s, v in filt.items()}

def main():
    sessions = sys.argv[1:]
    blocks = []
    for i, s in enumerate(sessions):
        blocks += [dict(json.loads(l), session=i) for l in open(s) if l.strip()]
    raw = lt.load_raw(min(b["t_move"] for b in blocks), max(b["t1"] for b in blocks))
    views = lt.fit_views(raw)
    print(f"{len(sessions)} session(s), {len(blocks)} blocks, {views[1]} views, chance {1/len({b['spot'] for b in blocks}):.1%}")
    print(f"{'features':20s} {'win':>4s} {'model':12s} {'raw':>6s}  {'hmm.80':>6s} {'hmm.90':>6s} {'hmm.95':>6s}   n")
    rows = []
    for kind, win in itertools.product(["shape", "shape+level", "shape+level+delta"], [3.0, 5.0]):
        X, y, g, tt = build(raw, blocks, views, win, 1.0, kind)
        for name, make in models().items():
            t0 = time.time(); acc, f = evaluate(X, y, g, tt, make)
            rows.append((kind, win, name, acc, f))
            print(f"{kind:20s} {win:4.0f} {name:12s} {acc:6.1%}  {f[0.8]:6.1%} {f[0.9]:6.1%} {f[0.95]:6.1%}   {len(y)}  ({time.time()-t0:.0f}s)", flush=True)
    best = max(rows, key=lambda r: r[3])
    print(f"\nbest per-window: {best[0]} win {best[1]:.0f}s {best[2]} {best[3]:.1%}")

if __name__ == "__main__":
    main()
