#!/usr/bin/env python3
"""ruview-camlabel.py: the camera as a TEACHER for the RF room locator.

The RF locator only learns spots it has labels for. Walks are short, and HID
labels only ever say "desk". The desk camera (C920, served by AirPad on :8768)
looks ACROSS the room from the desk: it sees the door/closet side, the middle
and the bed, i.e. exactly the spots the locator is weakest on.

Design: observe now, label later.
  run          every 2 s, read AirPad's frame.jpg (no second camera open), run
               MediaPipe pose, append NUMBERS ONLY (no images) to
               roomwatch/camera-obs.jsonl: hip/shoulder position in the frame,
               lying vs upright, visibility, frame brightness.
  calibrate S  fit the camera-position -> spot map from a walk session S (the
               walk says where the person really was), SCORE it on held-out
               rounds, and save roomwatch/camera-spotmap.json only with that
               score attached. ruview-locate-train.py uses camera labels only
               from a calibrated map, only above MIN_CONF, and only outside
               walks and HID-desk time.
  status       what has been observed and whether a map exists

A spot the camera cannot see is never labelled from it, and "no person seen"
is never turned into "empty": the view does not cover the whole room.
"""
import json, sys, time, pathlib, urllib.request, argparse, collections
import numpy as np

ROOM = pathlib.Path.home() / "cleetusd/roomwatch"
OBS = ROOM / "camera-obs.jsonl"
MAP = ROOM / "camera-spotmap.json"
FRAME = "http://127.0.0.1:8768/frame.jpg"
MODEL = pathlib.Path.home() / "cleetusd/models/pose/pose_landmarker_full.task"
PERIOD = 2.0
MIN_BRIGHT = 12.0          # below this the pose model guesses at shadows
MIN_CONF = 0.8             # calibrated-map probability needed to emit a label

def pose_features(p):
    """Frame-normalised body summary from 33 landmarks."""
    L = lambda i: (p[i].x, p[i].y, p[i].visibility)
    lh, rh, ls, rs = L(23), L(24), L(11), L(12)
    hip = ((lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2)
    sh = ((ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2)
    vis = [l.visibility for l in p]
    xs = [l.x for l in p if l.visibility > 0.5]; ys = [l.y for l in p if l.visibility > 0.5]
    dx, dy = sh[0] - hip[0], sh[1] - hip[1]
    lying = abs(dx) > abs(dy)          # torso more horizontal than vertical
    return {"hip_x": round(hip[0], 4), "hip_y": round(hip[1], 4), "sh_x": round(sh[0], 4), "sh_y": round(sh[1], 4),
            "lying": bool(lying), "vis": round(float(np.mean(vis)), 3),
            "bbox": [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)] if xs else None}

def run():
    import mediapipe as mp, cv2
    from mediapipe.tasks.python import vision, BaseOptions
    det = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(MODEL)),
        running_mode=vision.RunningMode.IMAGE, num_poses=3, min_pose_detection_confidence=0.5))
    while True:
        t0 = time.time()
        row = {"t": round(t0, 2)}
        try:
            data = urllib.request.urlopen(FRAME, timeout=3).read()
            img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            row["bright"] = round(float(gray.mean()), 1)
            if row["bright"] < MIN_BRIGHT:
                row["status"] = "dark"
            else:
                r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
                row["status"] = "ok"
                row["people"] = [pose_features(p) for p in r.pose_landmarks]
        except Exception as e:
            row["status"] = "no-frame"; row["err"] = str(e)[:80]
        with open(OBS, "a") as f:
            f.write(json.dumps(row) + "\n")
        time.sleep(max(0.0, PERIOD - (time.time() - t0)))

def load_obs(t0=0, t1=9e12):
    out = []
    if OBS.exists():
        for line in open(OBS):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if t0 <= r["t"] <= t1:
                out.append(r)
    return out

def feat(p):
    return [p["hip_x"], p["hip_y"], p["sh_x"], p["sh_y"], 1.0 if p["lying"] else 0.0]

def calibrate(session):
    from sklearn.neighbors import KNeighborsClassifier
    blocks = [json.loads(l) for l in open(session) if l.strip()]
    obs = load_obs(min(b["t_move"] for b in blocks), max(b["t1"] for b in blocks))
    X, y, g = [], [], []
    seen = collections.Counter()
    for b in blocks:
        for r in obs:
            if b["t0"] <= r["t"] < b["t1"] and r.get("status") == "ok":
                ppl = r.get("people", [])
                seen[(b["spot"], len(ppl))] += 1
                if len(ppl) == 1:
                    X.append(feat(ppl[0])); y.append(b["spot"]); g.append(b["round"])
    X, y, g = np.array(X), np.array(y), np.array(g)
    print("frames per spot by people-count:", dict(seen))
    # A body seen during an "out" block is someone passing the doorway, never a
    # label; and a spot seen in only a handful of frames is edge spill, not a view.
    cnt = collections.Counter(y)
    keep = np.array([s != "out" and cnt[s] >= 20 for s in y], bool)
    X, y, g = X[keep], y[keep], g[keep]
    visible = sorted({s for s in y})
    print("spots the camera saw a body in:", visible)
    if len(visible) < 2:
        sys.exit("fewer than two spots visible; nothing to calibrate")
    # held-out-round score of the camera mapping itself
    preds, probs = np.empty(len(y), object), np.zeros(len(y))
    for r in np.unique(g):
        tr, te = g != r, g == r
        if len(set(y[tr])) < 2:
            continue
        m = KNeighborsClassifier(n_neighbors=min(7, int(tr.sum()))).fit(X[tr], y[tr])
        preds[te] = m.predict(X[te]); probs[te] = m.predict_proba(X[te]).max(1)
    conf = probs >= MIN_CONF
    acc = float(np.mean(preds == y)); acc_conf = float(np.mean(preds[conf] == y[conf])) if conf.any() else float("nan")
    print(f"camera map, held-out rounds: {acc:.1%} of all frames; {acc_conf:.1%} of the {conf.mean():.0%} it is confident on (>= {MIN_CONF})")
    for s in visible:
        mm = y == s
        print(f"  {s:7s} n={int(mm.sum()):3d}  right {np.mean(preds[mm]==s):.0%}")
    MAP.write_text(json.dumps({"X": X.tolist(), "y": y.tolist(), "k": 7, "min_conf": MIN_CONF,
                               "heldout_acc": acc, "heldout_acc_confident": acc_conf,
                               "session": str(session), "visible_spots": visible, "made": time.time()}))
    print("saved", MAP)

def label_windows(t0, t1):
    """(t_start, t_end, spot) runs from the calibrated map; used by the trainer."""
    if not MAP.exists():
        return []
    from sklearn.neighbors import KNeighborsClassifier
    M = json.loads(MAP.read_text())
    m = KNeighborsClassifier(n_neighbors=M["k"]).fit(np.array(M["X"]), np.array(M["y"]))
    runs, cur = [], None
    for r in load_obs(t0, t1):
        spot = None
        if r.get("status") == "ok" and len(r.get("people", [])) == 1:
            p = m.predict_proba([feat(r["people"][0])])[0]
            if p.max() >= M["min_conf"]:
                spot = m.classes_[p.argmax()]
        if spot and cur and cur[2] == spot and r["t"] - cur[1] <= 2 * PERIOD + 0.5:
            cur[1] = r["t"]
        else:
            if cur and cur[1] - cur[0] >= 6:
                runs.append(tuple(cur))
            cur = [r["t"], r["t"], spot] if spot else None
    if cur and cur[1] - cur[0] >= 6:
        runs.append(tuple(cur))
    return runs

def status():
    obs = load_obs(time.time() - 3600)
    c = collections.Counter(r.get("status") for r in obs)
    ppl = collections.Counter(len(r.get("people", [])) for r in obs if r.get("status") == "ok")
    print(f"last hour: {len(obs)} observations {dict(c)}; people-count {dict(ppl)}")
    print("spot map:", json.loads(MAP.read_text())["heldout_acc"] if MAP.exists() else "NONE yet (calibrate from a walk)")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["run", "calibrate", "status"]); ap.add_argument("session", nargs="?")
    a = ap.parse_args()
    {"run": run, "status": status}.get(a.cmd, lambda: calibrate(a.session))()
