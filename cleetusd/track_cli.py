#!/usr/bin/env python3
"""track_cli.py — object tracking for Cleetus's cameras.

WHY THIS IS NOT JUST DETECTION
`look` already asks a vision model what is in a picture, and it answers well.
What it cannot do is tell you that the mug in this frame is THE SAME MUG as the
one in the last frame. Every question worth asking about a room needs that:

    "did I leave my wallet on the desk"      one object, over time
    "how long has that been sitting there"   an identity with an age
    "did anyone come in"                     an identity that is new
    "is it still there"                      an identity that persisted

A per-frame describer answers none of them, because it has no identities. It
sees a mug, then it sees a mug, and it cannot say whether that is one mug or
two. Tracking is the part that turns pictures into objects with histories.

WHAT THIS IMPLEMENTS
ByteTrack (Zhang et al. 2022, arXiv:2110.06864), which is the tracker the
Roboflow write-up recommends starting from and the default in Ultralytics. The
idea it is named for is one paragraph long:

    Every other tracker throws away low-confidence detections before matching.
    But a low-confidence box is usually not a false positive — it is a real
    object that got occluded, blurred, or half left the frame. Discarding it is
    exactly how a track dies at the moment it most needs to survive.

    So associate TWICE. First match the high-confidence boxes to tracks. Then
    take the tracks that found nothing, and match THOSE against the leftover
    low-confidence boxes. A box too weak to start a track is still good enough
    to keep one alive.

That second pass is the whole algorithm and it is why it beats trackers with far
more machinery. Everything else here is standard SORT: a constant-velocity
Kalman filter per track, IoU as the association cost, Hungarian assignment.

NO APPEARANCE MODEL, deliberately. DeepSORT and BoT-SORT add a re-identification
embedding, which buys identity across a long occlusion and costs a second neural
network per frame. On a fixed camera looking at a desk, things do not leave and
come back looking different; motion is sufficient and the frame budget is
better spent on frame rate. If that stops being true, the place to add it is
`_match` — cost becomes a blend of IoU and cosine distance, and nothing else in
this file changes.

DETECTOR
Pluggable, because the right one depends on what is installed:
  ultralytics   YOLO11n if it is importable. Better, and what Grayson linked.
  torchvision   SSDLite320-MobileNetV3, COCO, ~14MB. Already installed here,
                needs no new packages, and runs on MPS.
Whichever answered is named in the output. A tracker that silently fell back to
a weaker detector, and a tracker that is working well, must not look the same.

USAGE
    track_cli.py watch --camera desk --seconds 6
    track_cli.py watch --camera room --seconds 10 --classes person,cell phone
    track_cli.py once  --camera desk
    track_cli.py selftest
Always prints one JSON object on stdout. Never prints anything else there.
"""

import argparse
import json
import sys
import time
import urllib.request

import numpy as np

CAMERAS = {
    "desk": ("http://127.0.0.1:8765/frame.jpg", "the BRIO looking down at the desk"),
    "room": ("http://127.0.0.1:8768/frame.jpg", "the C920 looking across the room"),
}


# ─── assignment ──────────────────────────────────────────────────────────────
# scipy is not installed in this venv and pulling it in for one function would
# be a 30MB dependency for 40 lines. This is the Hungarian algorithm
# (Kuhn-Munkres) in its O(n^3) shortest-augmenting-path form, which is the same
# result scipy.optimize.linear_sum_assignment returns.
#
# `selftest` checks it against brute-force optimal on random matrices, because
# an assignment that is subtly wrong does not crash — it swaps two IDs
# occasionally, which is indistinguishable from ordinary tracker noise and would
# never be traced back to here.

def linear_sum_assignment(cost):
    cost = np.asarray(cost, dtype=float)
    n, m = cost.shape
    if n == 0 or m == 0:
        return np.array([], dtype=int), np.array([], dtype=int)
    transposed = n > m
    if transposed:
        cost = cost.T
        n, m = m, n

    INF = float("inf")
    u = np.zeros(n + 1)
    v = np.zeros(m + 1)
    p = np.zeros(m + 1, dtype=int)   # p[j] = row assigned to column j
    way = np.zeros(m + 1, dtype=int)

    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = np.full(m + 1, INF)
        used = np.zeros(m + 1, dtype=bool)
        while True:
            used[j0] = True
            i0, delta, j1 = p[j0], INF, -1
            for j in range(1, m + 1):
                if used[j]:
                    continue
                cur = cost[i0 - 1, j - 1] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j], way[j] = cur, j0
                if minv[j] < delta:
                    delta, j1 = minv[j], j
            for j in range(m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1

    rows, cols = [], []
    for j in range(1, m + 1):
        if p[j] > 0:
            rows.append(p[j] - 1)
            cols.append(j - 1)
    rows, cols = np.array(rows, dtype=int), np.array(cols, dtype=int)
    order = np.argsort(rows if not transposed else cols)
    rows, cols = rows[order], cols[order]
    return (cols, rows) if transposed else (rows, cols)


def iou_matrix(a, b):
    """Pairwise IoU. Boxes are xyxy."""
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    lt = np.maximum(a[:, None, :2], b[None, :, :2])
    rb = np.minimum(a[:, None, 2:4], b[None, :, 2:4])
    wh = np.clip(rb - lt, 0, None)
    inter = wh[..., 0] * wh[..., 1]
    area_a = np.clip(a[:, 2] - a[:, 0], 0, None) * np.clip(a[:, 3] - a[:, 1], 0, None)
    area_b = np.clip(b[:, 2] - b[:, 0], 0, None) * np.clip(b[:, 3] - b[:, 1], 0, None)
    union = area_a[:, None] + area_b[None, :] - inter
    return np.where(union > 0, inter / np.maximum(union, 1e-9), 0.0)


# ─── Kalman filter ───────────────────────────────────────────────────────────
# State is [cx, cy, aspect, height, dcx, dcy, daspect, dheight]. Tracking the
# ASPECT RATIO and HEIGHT rather than width and height is the SORT convention
# and it matters: a person walking towards the camera changes height smoothly
# and aspect barely at all, so the filter's velocity term stays meaningful.
# Parameterising as width and height couples the two and makes both noisy.

class Kalman:
    def __init__(self):
        self.F = np.eye(8)
        for i in range(4):
            self.F[i, i + 4] = 1.0
        self.H = np.eye(4, 8)
        # Noise scaled BY THE OBJECT'S OWN HEIGHT rather than fixed. A 20-pixel
        # error on a person filling the frame is nothing; the same error on a
        # pen is the whole object. Fixed noise makes the filter over-trust small
        # objects and under-trust large ones.
        self.pos_w = 1.0 / 20
        self.vel_w = 1.0 / 160

    def initiate(self, box):
        mean = np.r_[to_xyah(box), np.zeros(4)]
        h = mean[3]
        std = np.array([2 * self.pos_w * h, 2 * self.pos_w * h, 1e-2, 2 * self.pos_w * h,
                        10 * self.vel_w * h, 10 * self.vel_w * h, 1e-5, 10 * self.vel_w * h])
        return mean, np.diag(np.square(std))

    def predict(self, mean, cov):
        h = max(mean[3], 1.0)
        std = np.array([self.pos_w * h, self.pos_w * h, 1e-2, self.pos_w * h,
                        self.vel_w * h, self.vel_w * h, 1e-5, self.vel_w * h])
        Q = np.diag(np.square(std))
        mean = self.F @ mean
        cov = self.F @ cov @ self.F.T + Q
        return mean, cov

    def update(self, mean, cov, box):
        h = max(mean[3], 1.0)
        std = np.array([self.pos_w * h, self.pos_w * h, 1e-1, self.pos_w * h])
        R = np.diag(np.square(std))
        S = self.H @ cov @ self.H.T + R
        K = cov @ self.H.T @ np.linalg.inv(S)
        y = to_xyah(box) - self.H @ mean
        mean = mean + K @ y
        cov = (np.eye(8) - K @ self.H) @ cov
        return mean, cov


def to_xyah(box):
    x1, y1, x2, y2 = box[:4]
    w, h = max(x2 - x1, 1e-3), max(y2 - y1, 1e-3)
    return np.array([x1 + w / 2, y1 + h / 2, w / h, h])


def to_xyxy(mean):
    cx, cy, a, h = mean[:4]
    w = a * h
    return np.array([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2])


# ─── tracks ──────────────────────────────────────────────────────────────────

class Track:
    _next = 1

    def __init__(self, box, score, label, frame_no, t, kf):
        self.id = Track._next
        Track._next += 1
        self.kf = kf
        self.mean, self.cov = kf.initiate(box)
        self.label = label
        self.score = score
        self.hits = 1
        self.age = 0
        self.misses = 0
        self.confirmed = False
        self.first_frame = frame_no
        self.last_frame = frame_no
        self.first_seen = t
        self.last_seen = t
        # Sampled, not every frame: a 10 second watch at 8fps is 80 points per
        # object and the shape of the path is legible from a dozen.
        self.path = [tuple(np.round(self.mean[:2], 1))]

    def predict(self):
        self.mean, self.cov = self.kf.predict(self.mean, self.cov)
        self.age += 1

    def update(self, box, score, label, frame_no, t):
        self.mean, self.cov = self.kf.update(self.mean, self.cov, box)
        self.hits += 1
        self.misses = 0
        self.score = max(self.score, score)
        self.label = label
        self.last_frame = frame_no
        self.last_seen = t
        self.path.append(tuple(np.round(self.mean[:2], 1)))

    @property
    def box(self):
        return to_xyxy(self.mean)


class ByteTrack:
    """The two-stage association, and nothing else.

    n_init is 2 rather than 3. Three consecutive frames is the video-rate
    default; these cameras are sampled at 6-10fps to leave headroom for the
    detector, so three frames is half a second and a hand passing through gets
    confirmed as an object. Two is the honest translation of "seen twice".
    """

    def __init__(self, high=0.5, low=0.1, iou_thresh=0.3, max_age=30, n_init=2):
        self.high, self.low = high, low
        self.iou_thresh = iou_thresh
        self.max_age, self.n_init = max_age, n_init
        self.kf = Kalman()
        self.tracks = []

    def _match(self, tracks, dets, thresh):
        """Hungarian on 1-IoU, then drop pairs that are worse than the gate.

        The gate has to be applied AFTER the assignment, not by pre-filtering
        the matrix. Removing bad pairs first changes which rows and columns
        exist, so the optimiser solves a different problem and can hand back an
        assignment that is optimal for that problem and wrong for this one.
        """
        if not tracks or len(dets) == 0:
            return [], list(range(len(tracks))), list(range(len(dets)))
        ious = iou_matrix([t.box for t in tracks], dets[:, :4])
        # A track may only match a detection of its own class. Without this a
        # person walking behind a chair inherits the chair's id, which reads in
        # the output as furniture that got up and moved.
        for i, t in enumerate(tracks):
            for j in range(len(dets)):
                if t.label != int(dets[j, 5]):
                    ious[i, j] = 0.0
        rows, cols = linear_sum_assignment(1.0 - ious)
        matches, ut, ud = [], list(range(len(tracks))), list(range(len(dets)))
        for r, c in zip(rows, cols):
            if ious[r, c] < thresh:
                continue
            matches.append((int(r), int(c)))
            ut.remove(int(r))
            ud.remove(int(c))
        return matches, ut, ud

    def step(self, dets, frame_no, t):
        """dets: (N,6) array of x1,y1,x2,y2,score,class."""
        for tr in self.tracks:
            tr.predict()

        dets = np.asarray(dets, dtype=float).reshape(-1, 6)
        high = dets[dets[:, 4] >= self.high]
        low = dets[(dets[:, 4] >= self.low) & (dets[:, 4] < self.high)]

        # PASS ONE — confident detections against every track.
        m1, ut1, ud_high = self._match(self.tracks, high, self.iou_thresh)
        for ti, di in m1:
            self.tracks[ti].update(high[di, :4], high[di, 4], int(high[di, 5]), frame_no, t)

        # PASS TWO — the tracks that found nothing, against the weak boxes.
        # This is the whole point of ByteTrack. A track being unmatched in pass
        # one is exactly the evidence that its object got occluded or blurred,
        # which is exactly what produces a low-confidence box. The IoU gate is
        # LOOSER here (0.5 of the usual) because the reason the detection is
        # weak is usually that the box is sloppy.
        leftovers = [self.tracks[i] for i in ut1]
        m2, ut2, _ = self._match(leftovers, low, self.iou_thresh * 0.5)
        for ti, di in m2:
            leftovers[ti].update(low[di, :4], low[di, 4], int(low[di, 5]), frame_no, t)

        for tr in [leftovers[i] for i in ut2]:
            tr.misses += 1

        # Unmatched CONFIDENT detections start tracks. Unmatched weak ones never
        # do — a box the detector is unsure about is good enough to sustain an
        # identity and not good enough to invent one.
        for di in ud_high:
            self.tracks.append(Track(high[di, :4], high[di, 4], int(high[di, 5]), frame_no, t, self.kf))

        for tr in self.tracks:
            if not tr.confirmed and tr.hits >= self.n_init:
                tr.confirmed = True

        self.tracks = [tr for tr in self.tracks
                       if tr.misses <= self.max_age and not (not tr.confirmed and tr.misses > 0)]
        return self.tracks


# ─── detectors ───────────────────────────────────────────────────────────────

class Detector:
    """Whichever of the two is available, named in the output."""

    def __init__(self, conf=0.1):
        self.conf = conf
        self.kind = None
        self.names = {}
        self._yolo = None
        self._tv = None
        try:
            from ultralytics import YOLO           # noqa: F401
            self._yolo = YOLO("yolo11n.pt")
            self.kind = "ultralytics yolo11n"
            self.names = self._yolo.names
            return
        except Exception:
            pass
        import torch
        from torchvision.models.detection import (
            ssdlite320_mobilenet_v3_large, SSDLite320_MobileNet_V3_Large_Weights)
        w = SSDLite320_MobileNet_V3_Large_Weights.COCO_V1
        self._tv = ssdlite320_mobilenet_v3_large(weights=w, score_thresh=conf)
        self._tv.eval()
        # MPS on this Mac. Falls back silently to CPU because a detector that
        # refuses to run is worse than a slower one, and the frame rate in the
        # output makes the difference visible anyway.
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        try:
            self._tv.to(self.device)
        except Exception:
            self.device = "cpu"
        self.kind = f"torchvision ssdlite320-mobilenetv3 ({self.device})"
        self.names = {i: n for i, n in enumerate(w.meta["categories"])}
        self._torch = torch

    def __call__(self, bgr):
        if self._yolo is not None:
            r = self._yolo.predict(bgr, conf=self.conf, verbose=False)[0]
            b = r.boxes
            if b is None or len(b) == 0:
                return np.zeros((0, 6))
            return np.c_[b.xyxy.cpu().numpy(), b.conf.cpu().numpy(), b.cls.cpu().numpy()]

        torch = self._torch
        rgb = bgr[:, :, ::-1].copy()
        x = torch.from_numpy(rgb).permute(2, 0, 1).float().div(255.0).to(self.device)
        with torch.no_grad():
            out = self._tv([x])[0]
        boxes = out["boxes"].detach().cpu().numpy()
        scores = out["scores"].detach().cpu().numpy()
        labels = out["labels"].detach().cpu().numpy()
        keep = scores >= self.conf
        if not keep.any():
            return np.zeros((0, 6))
        return np.c_[boxes[keep], scores[keep], labels[keep]]


# ─── camera ──────────────────────────────────────────────────────────────────

def grab(url, timeout=4.0):
    import cv2
    with urllib.request.urlopen(url, timeout=timeout) as r:
        buf = r.read()
    if len(buf) < 2000:
        raise RuntimeError("frame too small to be a picture")
    img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("frame did not decode")
    return img


def summarise(tracks, names, frames, elapsed, min_hits=2):
    out = []
    for t in sorted(tracks, key=lambda t: (-t.hits, t.id)):
        if t.hits < min_hits:
            continue
        x1, y1, x2, y2 = [round(float(v), 1) for v in t.box]
        # DID IT MOVE is net displacement, not path length.
        #
        # Path length was the first attempt and it is the wrong measurement: it
        # sums per-frame steps, so detector jitter of half a pixel a frame
        # accumulates linearly and a chair that has not moved since it was
        # bought reported 24 pixels of travel over 34 frames and came back
        # "moved". Every static object in the room failed the test, which is
        # every object a desk camera is usually looking at.
        #
        # Net displacement does not accumulate noise: jitter cancels, real
        # travel does not. Scaled by the object's own size, because 15 pixels is
        # a shrug for a dining table and half a phone.
        p = np.asarray(t.path) if len(t.path) > 1 else np.zeros((1, 2))
        path_len = float(np.sum(np.linalg.norm(np.diff(p, axis=0), axis=1))) if len(p) > 1 else 0.0
        net = float(np.linalg.norm(p[-1] - p[0])) if len(p) > 1 else 0.0
        diag = float(np.hypot(x2 - x1, y2 - y1)) or 1.0
        out.append({
            "id": t.id,
            "what": names.get(int(t.label), f"class {int(t.label)}"),
            "confidence": round(float(t.score), 2),
            "seen_in_frames": t.hits,
            "of_frames": frames,
            # The two questions that need identity rather than detection.
            "still_present": t.misses == 0,
            "seconds_present": round(t.last_seen - t.first_seen, 1),
            "box": [x1, y1, x2, y2],
            "moved_px": round(net, 1),
            "path_length_px": round(path_len, 1),
            "settled": net < max(12.0, 0.12 * diag),
            "path": [list(p) for p in t.path[:: max(1, len(t.path) // 8)]][:9],
        })
    return out


def watch(camera, seconds, fps, classes, conf):
    if camera not in CAMERAS:
        return {"ok": False, "error": f"no camera called {camera!r}. Use desk or room."}
    url, what = CAMERAS[camera]

    t0 = time.time()
    try:
        det = Detector(conf=conf)
    except Exception as e:
        return {"ok": False, "error": f"no detector available: {e}"}
    load_s = round(time.time() - t0, 1)

    wanted = None
    if classes:
        want = {c.strip().lower() for c in classes.split(",") if c.strip()}
        wanted = {i for i, n in det.names.items() if str(n).lower() in want}
        unknown = want - {str(det.names[i]).lower() for i in wanted}
        if not wanted:
            return {"ok": False,
                    "error": f"this detector knows none of {sorted(want)}",
                    "known": sorted({str(n) for n in det.names.values()})}
    else:
        unknown = set()

    tracker = ByteTrack()
    interval = 1.0 / max(fps, 1)
    start = time.time()
    frames = 0
    errors = []
    while time.time() - start < seconds:
        loop = time.time()
        try:
            img = grab(url)
        except Exception as e:
            errors.append(str(e))
            if len(errors) >= 3:
                return {"ok": False, "error": f"could not read the {camera} camera ({what}): {errors[-1]}"}
            time.sleep(0.4)
            continue
        dets = det(img)
        if wanted is not None and len(dets):
            dets = dets[np.isin(dets[:, 5].astype(int), list(wanted))]
        frames += 1
        tracker.step(dets, frames, time.time())
        rest = interval - (time.time() - loop)
        if rest > 0:
            time.sleep(rest)

    elapsed = time.time() - start
    if frames == 0:
        return {"ok": False, "error": f"no frames came off the {camera} camera in {seconds}s"}

    objects = summarise(tracker.tracks, det.names, frames, elapsed)
    return {
        "ok": True,
        "camera": camera,
        "view": what,
        "detector": det.kind,
        "detector_load_seconds": load_s,
        "frames": frames,
        "seconds": round(elapsed, 1),
        "effective_fps": round(frames / max(elapsed, 1e-6), 1),
        "tracker": "bytetrack (two-stage association, kalman + iou, no re-id)",
        "filtered_to": sorted({str(det.names[i]) for i in wanted}) if wanted else None,
        "unknown_classes": sorted(unknown) or None,
        "objects": objects,
        "count": len(objects),
    }


def once(camera, conf):
    if camera not in CAMERAS:
        return {"ok": False, "error": f"no camera called {camera!r}. Use desk or room."}
    url, what = CAMERAS[camera]
    try:
        det = Detector(conf=conf)
        img = grab(url)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    dets = det(img)
    return {
        "ok": True, "camera": camera, "view": what, "detector": det.kind,
        "objects": [{"what": det.names.get(int(d[5]), int(d[5])),
                     "confidence": round(float(d[4]), 2),
                     "box": [round(float(v), 1) for v in d[:4]]}
                    for d in sorted(dets, key=lambda d: -d[4])],
    }


def selftest():
    """The two things here that fail silently rather than loudly."""
    import itertools
    rng = np.random.default_rng(7)
    worst = 0.0
    # Brute force enumerates INJECTIVE MAPS, not two independent permutations.
    # Permuting both sides is the same assignment counted k! times over — it is
    # the right answer computed 5040 times per trial, which is why the first
    # version of this selftest never finished.
    for n, m in [(1, 1), (3, 3), (4, 6), (6, 4), (5, 5), (6, 6)]:
        for _ in range(30):
            c = rng.random((n, m)) * 10
            r, cc = linear_sum_assignment(c)
            got = c[r, cc].sum()
            if n <= m:
                best = min(sum(c[i, j] for i, j in enumerate(cols))
                           for cols in itertools.permutations(range(m), n))
            else:
                best = min(sum(c[i, j] for j, i in enumerate(rows))
                           for rows in itertools.permutations(range(n), m))
            worst = max(worst, got - best)
    # Keeping one identity through a long partial occlusion IS the property
    # ByteTrack exists for, so it is asserted rather than assumed.
    #
    # This scenario was chosen by first building one that could NOT fail. The
    # obvious test — drop one frame, then send one weak box — passes with the
    # low-score pass ripped out, because max_age alone carries a track over two
    # missed frames and the Kalman prediction re-acquires it. It looked like a
    # test of ByteTrack and was a test of max_age.
    #
    # Six consecutive weak frames against max_age=3 is the shape that separates
    # them. Verified both ways: with the second association the object keeps id
    # 1 throughout; with it removed the track dies mid-occlusion and the object
    # comes back as id 2, which in a real answer reads as a second wallet
    # appearing on the desk.
    tr = ByteTrack(max_age=3)
    for f in range(14):
        score = 0.2 if 4 <= f <= 9 else 0.9
        tr.step(np.array([[10 + f * 4, 10, 60 + f * 4, 70, score, 1.0]]), f, float(f))
    ids = [t.id for t in tr.tracks]
    stable = ids == [1]
    return {
        "ok": worst < 1e-9 and stable,
        "hungarian_max_gap_vs_bruteforce": float(worst),
        "identity_survived_a_six_frame_partial_occlusion": stable,
        "final_track_ids": ids,
    }


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("watch")
    w.add_argument("--camera", default="desk")
    w.add_argument("--seconds", type=float, default=6.0)
    w.add_argument("--fps", type=float, default=6.0)
    w.add_argument("--classes", default="")
    w.add_argument("--conf", type=float, default=0.1)
    o = sub.add_parser("once")
    o.add_argument("--camera", default="desk")
    o.add_argument("--conf", type=float, default=0.25)
    sub.add_parser("selftest")
    a = ap.parse_args()

    try:
        if a.cmd == "watch":
            r = watch(a.camera, min(a.seconds, 60.0), a.fps, a.classes, a.conf)
        elif a.cmd == "once":
            r = once(a.camera, a.conf)
        else:
            r = selftest()
    except Exception as e:
        r = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    json.dump(r, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
