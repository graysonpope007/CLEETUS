#!/usr/bin/env python3
"""ruview-locate-live.py: live "where is he" from RF multipath fingerprints.

Listens on 127.0.0.1:5007 (ruview-raw.py forwards every CSI packet), rebuilds
EXACTLY the features ruview-locate-test.py trained on (last 3 s per view, view =
one board hearing one transmitter), and once a second publishes the model's
probability for each trained spot.

  GET http://127.0.0.1:8793/        floor-plan heatmap
  GET http://127.0.0.1:8793/state   JSON {spots: {name: p}, out: p, views_live, ...}

Honest limits, also printed on the page: the model knows the SPOTS it was walked
through (desk, keys, bed, center, closet, out), trained on ONE person in ONE
session. It is a spot classifier drawn as a heatmap, not continuous tracking,
and nothing about two people has been tested.
"""
import json, pickle, socket, struct, threading, time, pathlib, collections
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import numpy as np

MODEL = pathlib.Path.home() / "cleetusd/roomwatch/locate-model.pkl"
PAGE = pathlib.Path(__file__).with_name("ruview-locate-live.html")
CSI_MAGIC = 0xC5110001
NSUB = 64
EMA = 0.35          # per-second smoothing of the posterior

M = pickle.load(open(MODEL, "rb"))
ACTIVE = M["active"]
VIEWS = [tuple(v) for v in M["views"]]
VIEW_IX = {v: i for i, v in enumerate(VIEWS)}
WIN = M["win"]
WIDTH = 2 * int(ACTIVE.sum())

frames = collections.deque()          # (t, view_ix, amp)
lock = threading.Lock()
state = {"t": 0, "spots": {}, "out": None, "views_live": 0, "views_total": len(VIEWS),
         "status": "starting", "acc_heldout": M.get("acc_heldout")}

def rx():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 5007))
    while True:
        pkt, _ = s.recvfrom(4096)
        if len(pkt) < 20:
            continue
        magic, node, nant, nsub = struct.unpack_from("<IBBH", pkt, 0)
        if magic != CSI_MAGIC:
            continue
        iq_len = nant * nsub * 2
        if len(pkt) < 26 + iq_len or iq_len < 2 * NSUB:
            continue
        src = int.from_bytes(pkt[20 + iq_len:26 + iq_len], "big")
        v = VIEW_IX.get((node, src))
        if v is None:
            continue
        iq = np.frombuffer(pkt, dtype=np.int8, offset=20, count=2 * NSUB).astype(np.float32)
        amp = np.hypot(iq[1::2], iq[0::2])
        if amp.mean() <= 1.0:
            continue
        with lock:
            frames.append((time.time(), v, amp))

def feats(a):
    x = a[:, ACTIVE]
    x = x / (x.mean(1, keepdims=True) + 1e-6)
    lx = np.log(x + 1e-3)
    return np.concatenate([lx.mean(0), lx.std(0)])

TICK = 0.25                              # seconds between updates (4 Hz)
T = float(M.get("temperature", 1.0))     # calibration: LDA alone claims ~100%
STAY = float(M.get("hmm_stay_per_s", 0.9))

def calibrate(p):
    L = np.log(np.clip(p, 1e-12, 1)) / T
    L -= L.max(); q = np.exp(L)
    return q / q.sum()

def infer():
    """Sticky forward filter over calibrated probabilities: a spot has to keep
    winning for a moment before the display moves (measured: flicker 5.7 -> 3.5
    switches/min for -1.6 pts accuracy). Stay probability is per second, scaled
    to the tick so the behaviour does not depend on the update rate."""
    cls = [str(c) for c in M["model"].classes_]
    k = len(cls)
    stay = STAY ** TICK
    Tm = np.full((k, k), (1 - stay) / (k - 1)); np.fill_diagonal(Tm, stay)
    belief = None
    while True:
        time.sleep(TICK)
        now = time.time()
        with lock:
            while frames and frames[0][0] < now - WIN:
                frames.popleft()
            snap = list(frames)
        per = collections.defaultdict(list)
        for _, v, amp in snap:
            per[v].append(amp)
        parts, live = [], 0
        for v in range(len(VIEWS)):
            if len(per[v]) >= 2:
                parts.append(feats(np.stack(per[v]))); live += 1
            else:
                parts.append(np.full(WIDTH, np.nan))
        st = {"t": now, "views_live": live, "views_total": len(VIEWS),
              "acc_heldout": M.get("acc_heldout"), "temperature": T}
        if live < len(VIEWS) / 2:
            st.update(status="insufficient views", spots={}, out=None)
            belief = None
        else:
            p = calibrate(M["model"].predict_proba(np.concatenate(parts)[None, :])[0])
            # Windows overlap (3 s window, new estimate every 0.25 s), so each
            # tick carries only TICK seconds of NEW evidence: temper it to match
            # the 1 update/s the filter was measured with.
            e = p ** TICK; e /= e.sum()
            belief = p if belief is None else (Tm.T @ belief) * e
            belief = belief / belief.sum()
            probs = dict(zip(cls, map(float, belief)))
            raw = dict(zip(cls, map(float, p)))
            out = probs.pop("out", None); raw.pop("out", None)
            st.update(status="ok", out=out, spots=probs, raw=raw, top=max(probs, key=probs.get))
        with lock:
            state.clear(); state.update(st)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        if self.path.startswith("/state"):
            with lock:
                body = json.dumps(state).encode()
            ctype = "application/json"
        elif self.path in ("/", "/index.html"):
            body = PAGE.read_bytes(); ctype = "text/html; charset=utf-8"
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(body)

if __name__ == "__main__":
    threading.Thread(target=rx, daemon=True).start()
    threading.Thread(target=infer, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", 8793), H).serve_forever()
