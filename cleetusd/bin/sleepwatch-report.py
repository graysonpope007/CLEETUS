#!/usr/bin/env python3
"""sleepwatch-report.py: turn the overnight watch into a per-minute timeline and, once there
is truth, a baseline for "in bed" and "asleep" that is scored on nights it never saw.

  sleepwatch-report.py [NIGHT]      NIGHT = date you went to bed (default: last night).
                                    Writes roomwatch/sleepwatch/night-NIGHT.json (+ minutes CSV)
                                    and refits baseline.json from every night that has truth.
  sleepwatch-report.py --push       same, then push a one-line summary to the phone.

Per-minute features (a night runs 18:00 -> 14:00 next day):
  bed_p      mean locator probability of the "bed" spot           (RF, trained spot model)
  top_bed    fraction of samples where "bed" was the top spot
  hid        1 if the keyboard/mouse was used in that minute      (idle < 60 s at any sample)
  lamps      lamps on (0-4)
  cam_b      roomwatch camera brightness (0 = dark OR blind; the camera has no IR)
  motion     CSI temporal variability, median over the 12 views   (raw CSI, gain-normalised)
  breath     share of CSI power in 0.1-0.5 Hz (a breathing band)  (EXPERIMENTAL, unvalidated)

Labels only ever come from the user (truth.jsonl, marks.jsonl): out-of-bed / in-bed-awake / asleep.
No label is inferred from the sensors and then used to score the same sensors.

READY rule (written into baseline.json, never loosened by this script):
  >= 5 nights with truth, and leave-one-NIGHT-out on every night:
  in-bed minute accuracy >= 95%, bedtime and get-up time each within 15 min,
  sleep-onset within 20 min on at least 4 of 5 nights.
"""
import json, sys, glob, pathlib, datetime as dt, subprocess
import numpy as np

HOME = pathlib.Path.home()
DIR = HOME / "cleetusd/roomwatch/sleepwatch"
CSI = HOME / "cleetusd/roomwatch/csi-raw"
START_H, END_H = 18, 14
READY = {"nights": 5, "inbed_acc": 0.95, "edge_min": 15, "onset_min": 20, "onset_nights_frac": 0.8}


def night_bounds(night):
    d = dt.date.fromisoformat(night)
    a = dt.datetime.combine(d, dt.time(START_H)).timestamp()
    b = dt.datetime.combine(d + dt.timedelta(days=1), dt.time(END_H)).timestamp()
    return a, b


def load_samples(a, b):
    rows = []
    for day in {dt.datetime.fromtimestamp(x).strftime("%Y-%m-%d") for x in (a, b)}:
        p = DIR / f"samples-{day}.jsonl"
        if p.exists():
            for line in open(p):
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if a <= r["t"] < b:
                    rows.append(r)
    return rows


def csi_minutes(a, b):
    """{minute_ts: (motion, breath)} from raw CSI files that fall inside the night."""
    out = {}
    for f in sorted(CSI.glob("*.npz")):
        ts = dt.datetime.strptime(f.stem, "%Y%m%d-%H%M").timestamp()
        if not (a <= ts < b):
            continue
        try:
            d = np.load(f)
        except Exception:
            continue
        amp = d["amp"].astype(np.float32)
        good = amp.mean(1) > 1.0
        src = d["src"] if "src" in d.files else np.zeros(len(good), np.uint64)
        amp, t, node, src = amp[good], d["t"][good], d["node"][good], src[good]
        motions, breaths = [], []
        for key in set(zip(node.tolist(), src.tolist())):
            m = (node == key[0]) & (src == key[1])
            if m.sum() < 120:          # < 2 Hz for the minute: not a usable view
                continue
            x = amp[m]
            x = x[:, x.mean(0) > 2.0]  # drop null/guard subcarriers
            if x.shape[1] < 20:
                continue
            x = x / x.mean(1, keepdims=True)          # remove AGC gain per frame
            motions.append(float(np.median(x.std(0) / x.mean(0))))
            # breathing band: resample the first PC to 4 Hz, share of 0.05-2 Hz power in 0.1-0.5 Hz
            tt = t[m] - t[m][0]
            xc = x - x.mean(0)
            try:
                pc = xc @ np.linalg.svd(xc, full_matrices=False)[2][0]
            except np.linalg.LinAlgError:
                continue
            grid = np.arange(0, tt[-1], 0.25)
            if len(grid) < 160:
                continue
            s = np.interp(grid, tt, pc)
            s = s - s.mean()
            P = np.abs(np.fft.rfft(s * np.hanning(len(s)))) ** 2
            fr = np.fft.rfftfreq(len(s), 0.25)
            tot = P[(fr >= 0.05) & (fr <= 2.0)].sum()
            if tot > 0:
                breaths.append(float(P[(fr >= 0.1) & (fr <= 0.5)].sum() / tot))
        if motions:
            out[int(ts // 60 * 60)] = (float(np.median(motions)),
                                      float(np.median(breaths)) if breaths else np.nan)
    return out


def minutes_for(night):
    a, b = night_bounds(night)
    rows = load_samples(a, b)
    csi = csi_minutes(a, b)
    by = {}
    for r in rows:
        by.setdefault(int(r["t"] // 60 * 60), []).append(r)
    mins = []
    for m in range(int(a), int(b), 60):
        rs = by.get(m, [])
        locs = [r["loc"] for r in rs if r.get("loc") and "spots" in r["loc"]]
        cams = [r["cam"]["brightness"] for r in rs if r.get("cam") and r["cam"].get("brightness") is not None]
        lamps = [r["lamps"]["on"] for r in rs if r.get("lamps")]
        idles = [r["hid_idle"] for r in rs if r.get("hid_idle") is not None]
        mo, br = csi.get(m, (np.nan, np.nan))
        mins.append({
            "t": m,
            "n": len(rs),
            "bed_p": float(np.mean([l["spots"].get("bed", 0) for l in locs])) if locs else np.nan,
            "top_bed": float(np.mean([l["top"] == "bed" for l in locs])) if locs else np.nan,
            "hid": float(min(idles) < 60) if idles else np.nan,
            "lamps": float(np.mean(lamps)) if lamps else np.nan,
            "cam_b": float(np.mean(cams)) if cams else np.nan,
            "motion": mo, "breath": br,
        })
    return mins


def truth_for(night):
    a, b = night_bounds(night)
    t = {}
    p = DIR / "truth.jsonl"
    if p.exists():
        for line in open(p):
            r = json.loads(line)
            if r["night"] == night:
                t.update({k: r[k] for k in ("bed", "asleep", "up") if k in r})
    p = DIR / "marks.jsonl"
    if p.exists():
        for line in open(p):
            r = json.loads(line)
            if a <= r["t"] < b and r["kind"] in ("bed", "asleep", "up") and r["kind"] not in t:
                t[r["kind"]] = r["t"]
    return t


def label(mins, tr):
    """0 = out of bed / awake, 1 = in bed awake, 2 = asleep. None where truth is missing."""
    if "bed" not in tr or "up" not in tr:
        return None
    asleep = tr.get("asleep", tr["bed"])
    return np.array([0 if (m["t"] < tr["bed"] or m["t"] >= tr["up"]) else (2 if m["t"] >= asleep else 1)
                     for m in mins])


FEATS = ["bed_p", "top_bed", "hid", "lamps", "motion", "breath"]


def matrix(mins):
    X = np.array([[m[k] for k in FEATS] for m in mins], dtype=float)
    X[:, 4] = np.log(np.maximum(X[:, 4], 1e-4))
    return X


def smooth(p, k=9):
    """Centered running mean over k minutes of each class probability."""
    ker = np.ones(k) / k
    return np.stack([np.convolve(np.pad(p[:, j], k // 2, mode="edge"), ker, "valid") for j in range(p.shape[1])], 1)


def edges(y):
    """(bed, asleep, up) minute indices from a label sequence: the longest in-bed run."""
    inb = y >= 1
    best, cur, s = (0, 0), 0, 0
    for i, v in enumerate(np.append(inb, False)):
        if v and cur == 0:
            s = i
        cur = cur + 1 if v else 0
        if not v and i > 0 and inb[i - 1] and (i - s) > best[1] - best[0]:
            best = (s, i)
    if best == (0, 0):
        return None
    sl = np.where(y[best[0]:best[1]] == 2)[0]
    return best[0], (best[0] + sl[0]) if len(sl) else None, best[1]


def fit_eval(nights):
    """Leave-one-night-out. Returns per-night scores and the model fit on all nights."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.impute import SimpleImputer
    from sklearn.preprocessing import StandardScaler

    def model():
        return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                             LogisticRegression(max_iter=2000, class_weight="balanced"))

    scores = []
    for i, (n, X, y) in enumerate(nights):
        if len(nights) < 2:
            break
        Xtr = np.vstack([x for j, (_, x, _) in enumerate(nights) if j != i])
        ytr = np.concatenate([yy for j, (_, _, yy) in enumerate(nights) if j != i])
        if len(set(ytr)) < 3:
            continue
        m = model().fit(Xtr, ytr)
        pred = np.argmax(smooth(m.predict_proba(X)), 1)
        e_true, e_pred = edges(y), edges(pred)
        sc = {"night": n, "inbed_acc": float(np.mean((pred >= 1) == (y >= 1))),
              "state_acc": float(np.mean(pred == y))}
        if e_true and e_pred:
            sc["bed_err_min"] = abs(e_pred[0] - e_true[0])
            sc["up_err_min"] = abs(e_pred[2] - e_true[2])
            if e_true[1] is not None and e_pred[1] is not None:
                sc["onset_err_min"] = abs(e_pred[1] - e_true[1])
        scores.append(sc)
    full = None
    allY = np.concatenate([y for _, _, y in nights]) if nights else np.array([])
    if len(set(allY.tolist())) == 3:
        full = model().fit(np.vstack([x for _, x, _ in nights]), allY)
    return scores, full


def verdict(scores, n_truth):
    if n_truth < READY["nights"]:
        return False, f"{n_truth}/{READY['nights']} nights with truth"
    bad = [s for s in scores if s["inbed_acc"] < READY["inbed_acc"]
           or s.get("bed_err_min", 999) > READY["edge_min"] or s.get("up_err_min", 999) > READY["edge_min"]]
    onset_ok = sum(1 for s in scores if s.get("onset_err_min", 999) <= READY["onset_min"])
    if bad:
        return False, f"{len(bad)} held-out night(s) miss the in-bed bar: " + ", ".join(s["night"] for s in bad)
    if onset_ok < READY["onset_nights_frac"] * len(scores):
        return False, f"sleep onset within {READY['onset_min']} min on only {onset_ok}/{len(scores)} nights"
    return True, f"every held-out night passed ({len(scores)} nights)"


def hm(ts):
    return dt.datetime.fromtimestamp(ts).strftime("%H:%M") if ts else "?"


def main():
    args = [x for x in sys.argv[1:] if not x.startswith("--")]
    night = args[0] if args else (dt.date.today() - dt.timedelta(days=1)).isoformat()
    mins = minutes_for(night)
    tr = truth_for(night)
    import csv
    with open(DIR / f"night-{night}-minutes.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(mins[0].keys()))
        w.writeheader()
        w.writerows(mins)

    # Every night with data + truth feeds the baseline.
    nights = []
    for p in sorted(DIR.glob("night-*-minutes.csv")):
        n = p.name[6:16]
        t = truth_for(n)
        ms = mins if n == night else minutes_for(n)
        y = label(ms, t)
        if y is not None and sum(m["n"] > 0 for m in ms) > 60:
            nights.append((n, matrix(ms), y))
    scores, full = fit_eval(nights)
    ready, why = verdict(scores, len(nights))

    # Class profiles: what each state looks like, from truth only.
    prof = {}
    if nights:
        X = np.vstack([x for _, x, _ in nights]); Y = np.concatenate([y for _, _, y in nights])
        for c, name in enumerate(["out_of_bed", "in_bed_awake", "asleep"]):
            sel = X[Y == c]
            if len(sel):
                prof[name] = {k: [round(float(np.nanpercentile(sel[:, i], q)), 4) for q in (10, 50, 90)]
                              for i, k in enumerate(FEATS) if np.isfinite(sel[:, i]).any()}
                prof[name]["minutes"] = int(len(sel))

    # This night's estimate: the fitted model if there is one, else a plain-rules guess, marked as such.
    guess = None
    X = matrix(mins)
    if full is not None:
        pred = np.argmax(smooth(full.predict_proba(X)), 1)
        src = "model"
    else:
        quiet = np.nan_to_num(X[:, 2], nan=1) == 0
        dark = np.nan_to_num(X[:, 3], nan=4) == 0
        bedish = np.nan_to_num(X[:, 1], nan=0) >= 0.5
        pred = ((quiet & dark & bedish) | (quiet & dark & (np.arange(len(mins)) > 300))).astype(int)
        pred = (np.convolve(pred, np.ones(15) / 15, "same") > 0.5).astype(int)
        src = "rules (no truth yet)"
    e = edges(pred)
    if e:
        guess = {"source": src, "bed": mins[e[0]]["t"], "asleep": mins[e[1]]["t"] if e[1] is not None else None,
                 "up": mins[min(e[2], len(mins) - 1)]["t"]}

    rep = {"night": night, "samples": sum(m["n"] for m in mins),
           "csi_minutes": int(sum(np.isfinite(m["motion"]) for m in mins)),
           "truth": {k: hm(v) for k, v in tr.items()}, "guess": guess and {k: hm(v) if k != "source" else v
                                                                            for k, v in guess.items()},
           "heldout": scores, "profiles": prof}
    json.dump(rep, open(DIR / f"night-{night}.json", "w"), indent=1, default=float)
    base = {"updated": dt.datetime.now().isoformat(timespec="minutes"), "ready": ready, "why": why,
            "rule": READY, "nights": [n for n, _, _ in nights], "heldout": scores, "profiles": prof}
    json.dump(base, open(DIR / "baseline.json", "w"), indent=1, default=float)
    if full is not None:
        import pickle
        pickle.dump({"model": full, "feats": FEATS}, open(DIR / "sleep-model.pkl", "wb"))

    print(json.dumps({k: rep[k] for k in ("night", "samples", "csi_minutes", "truth", "guess")}, indent=1))
    print("baseline:", "READY" if ready else "not ready", "-", why)
    for s in scores:
        print("  held-out", s)

    if "--push" in sys.argv:
        g = rep["guess"] or {}
        body = (f"Guess ({g.get('source', '-')}): bed {g.get('bed', '?')}, asleep {g.get('asleep', '?')}, "
                f"up {g.get('up', '?')}. " + ("Truth logged, thanks. " if tr else
                "Tell Claude your real bed/asleep/up times. ") + f"Baseline: {why}.")
        js = ("import('/Users/grayson/cleetusd/src/roomwatch.mjs').then(m=>m.pushAlert(process.argv[1],process.argv[2]))"
              ".then(r=>console.log(JSON.stringify(r)))")
        subprocess.run(["/opt/homebrew/bin/node", "-e", js, "Sleep watch " + night, body],
                       cwd=str(HOME / "cleetusd"), timeout=60)


if __name__ == "__main__":
    main()
