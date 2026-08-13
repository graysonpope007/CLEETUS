#!/usr/bin/env python3
"""face_cli.py — who is in front of the camera, decided on this machine.

The eyes already worked: vision.mjs pulls a frame and a VLM writes a sentence
about it. But a VLM asked "is that Grayson" will say yes, because it is a
language model looking at a man at a desk and that is the likely answer. It has
never seen his face and has no way to say it does not know. Identity has to
come from something that MEASURES rather than something that describes.

So: YuNet finds faces, SFace turns each one into 128 numbers, and a face is
Grayson only if those numbers land within a fixed distance of the numbers taken
when he enrolled. That distance is a published threshold, not a feel — 0.363
cosine, from the OpenCV model card — and everything below it comes back
"unknown" rather than "probably him".

WHY THESE TWO MODELS. Nothing new had to be installed. The studio-locate venv
already has OpenCV 5, which carries both of these in the box; deepface would
have brought TensorFlow and face_recognition would have brought a dlib build,
for a job two 37MB ONNX files already do at full frame rate on the CPU. Nothing
leaves the machine, which for a camera pointed at his house is the whole point.

WHAT THIS IS NOT. There is no liveness check. A photograph of Grayson held up
to the camera will identify as Grayson, and the room camera has already caught
a second person at the kitchen table, so "a face" is not "the person I expect".
Fine for "who is at my desk"; not a lock, and it must never be wired to one.

Output is always JSON on stdout, including for errors, because the caller is a
tool loop and an exception traceback on stderr reads to it as silence.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models" / "face"
DETECTOR = MODELS / "yunet.onnx"
EMBEDDER = MODELS / "sface.onnx"

# Where "the same person" starts. SFace ships with 0.363 and this is NOT that,
# because 0.363 was measured to be wrong for this camera and this gallery:
#
#   Grayson, live, 110 samples over 30s          min 0.634   max 0.870
#   80 other people's faces in photos on disk    all < 0.363 EXCEPT one
#   the exception: a stranger in ~/Desktop/Oak hill/IMG_1340.jpg      0.394
#
# That last one is a young man with the same colouring and the same curly fair
# hair, and at the published threshold cleetusd would have called him Grayson.
# 0.45 sits in the measured gap: 0.06 clear of the worst impostor, 0.18 below
# his worst true match. Raising it trades a false name for an occasional "I
# don't recognise them", which is the right way round — this is the one tool
# where being confidently wrong is worse than being unsure.
#
# CAVEAT, because the number will drift: those 110 true scores were taken
# minutes after enrolment, same light, same shirt. Cross-session scores run
# lower. If he starts going unrecognised, the fix is another enrolment in that
# day's light — the gallery appends — not quietly lowering this back.
COSINE_MATCH = 0.45

# SFace resizes every crop to 112x112. A face smaller than that is being
# upscaled before it is measured, and a 24-pixel face across the room carries
# almost no identity signal — matching one is guessing with a number attached.
MIN_FACE_PX = 60
RELIABLE_FACE_PX = 100

# More than this per person and the oldest go. Twenty crops covers the angles
# and lighting a desk sees; unbounded growth just makes every identify slower.
MAX_EMBEDDINGS = 20


def out(obj, code=0):
    json.dump(obj, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(code)


def fail(error, detail=""):
    out({"ok": False, "error": error, "detail": detail}, 1)


def gallery_path(args):
    root = args.gallery or os.environ.get("CLEETUS_MEMORY_ROOT") or str(Path.home() / "cleetus-memory")
    return Path(root) / "faces" / "gallery.json"


def load_gallery(path):
    if not path.exists():
        return {"version": 1, "people": {}}
    try:
        g = json.loads(path.read_text())
    except Exception as e:
        fail("gallery_unreadable", f"{path}: {e}")
    g.setdefault("people", {})
    return g


def save_gallery(path, g):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(g, indent=2))
    tmp.replace(path)  # atomic: a half-written gallery would forget everyone


def models_ready():
    missing = [str(p) for p in (DETECTOR, EMBEDDER) if not p.exists() or p.stat().st_size < 100_000]
    return missing


def build():
    missing = models_ready()
    if missing:
        fail("no_models", "missing or truncated: " + ", ".join(missing))
    det = cv2.FaceDetectorYN.create(str(DETECTOR), "", (320, 320), 0.85, 0.3, 5000)
    rec = cv2.FaceRecognizerSF.create(str(EMBEDDER), "")
    return det, rec


def grab(url, timeout=6):
    """One JPEG from a camera's still endpoint, decoded."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            raw = r.read()
    except Exception as e:
        raise RuntimeError(f"camera at {url} did not answer: {e}")
    if len(raw) < 2000:
        raise RuntimeError(f"camera at {url} returned {len(raw)} bytes, too small to be a picture")
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"camera at {url} returned something that is not a decodable image")
    return img, raw


def detect(det, img):
    h, w = img.shape[:2]
    det.setInputSize((w, h))
    _, faces = det.detect(img)
    if faces is None:
        return []
    # Biggest first: on both cameras the nearest face is the one being asked about.
    return sorted(faces, key=lambda f: float(f[3]), reverse=True)


def embed(rec, img, face):
    v = rec.feature(rec.alignCrop(img, face))
    v = np.asarray(v, dtype=np.float32).reshape(-1)
    n = float(np.linalg.norm(v))
    if n == 0:
        raise RuntimeError("embedding came back as zeros")
    return v / n  # stored normalised, so a match is a plain dot product


def cosine(a, b):
    return float(np.dot(a, b))


def box_of(face):
    return [int(v) for v in face[:4]]


def frontality(face):
    """How square-on a face is, from YuNet's five landmarks.

    Enrolling a profile teaches almost nothing: SFace measures a face it can
    see both sides of, and a head turned ninety degrees gives it one eye and a
    silhouette. The first attempt here caught him mid-conversation, turned away
    from the camera with four other people in the room, and would have written
    that into the gallery as what Grayson looks like.

    So enrolment waits for a face pointed at the lens rather than asking him to
    hold still for a countdown.

    Returns the two raw ratios, both MEASURED off this camera rather than
    guessed at:
      nose_offset — how far the nose sits from the midpoint of the eyes, as a
                    fraction of the distance between them. 0.00 head-on.
      eye_spread  — distance between the eyes over the width of the box.

    Measured on two frames from the room camera: square-ish to the lens gave
    0.245 and 0.423; the same man in profile mid-conversation gave 0.50+ and
    0.086. The thresholds below sit in that gap. The first pair of thresholds
    here were picked by eye instead and rejected BOTH frames, which would have
    looked exactly like a camera that never sees anyone.
    """
    pts = face[4:14].reshape(5, 2)
    (rx, ry), (lx, ly), (nx, _) = pts[0], pts[1], pts[2]
    eye_dist = float(np.hypot(lx - rx, ly - ry))
    box_w = float(face[2])
    if eye_dist <= 1 or box_w <= 1:
        return 1.0, 0.0
    nose_offset = abs(float(nx) - (rx + lx) / 2.0) / eye_dist
    return float(nose_offset), float(eye_dist / box_w)


MAX_NOSE_OFFSET = 0.30
MIN_EYE_SPREAD = 0.30

# Two shots more alike than this are the same pose, and the second one teaches
# nothing. MEASURED, and the measurement is the reason this gate exists at all:
# sampling this camera for 35 seconds, the same man in different head positions
# scored as low as 0.225 against himself — well under the 0.363 needed to call
# it a match. Identity here is carried by the SPREAD of what was enrolled, not
# the count. Twelve frames half a second apart are one pose twelve times, and a
# gallery like that stops recognising him the moment he tilts his head.
DIVERSITY_MAX = 0.97


def is_frontal(face):
    nose_offset, eye_spread = frontality(face)
    return nose_offset <= MAX_NOSE_OFFSET and eye_spread >= MIN_EYE_SPREAD


def tally(rejected):
    """Every attempt, grouped by why it did not count."""
    n = {"attempts": len(rejected), "no_face": 0, "turned_away": 0, "too_far": 0,
         "same_pose": 0, "camera": 0}
    for r in rejected:
        if r.startswith("face turned away"):
            n["turned_away"] += 1
        elif r.startswith("nearest face"):
            n["too_far"] += 1
        elif r == "no face in frame":
            n["no_face"] += 1
        elif r.startswith("same pose"):
            n["same_pose"] += 1
        else:
            n["camera"] += 1
    return n


def slug(name):
    return "".join(c if c.isalnum() else "-" for c in name.strip().lower()).strip("-") or "someone"


# ── identify ────────────────────────────────────────────────────────────────

def cmd_identify(args):
    det, rec = build()
    g = load_gallery(gallery_path(args))
    people = g["people"]

    known = []
    for key, p in people.items():
        vecs = np.asarray(p["embeddings"], dtype=np.float32)
        known.append((p.get("name", key), vecs))

    try:
        img, _ = grab(args.url)
    except RuntimeError as e:
        fail("camera_down", str(e))

    faces = detect(det, img)
    seen = []
    for f in faces:
        box = box_of(f)
        height = box[3]
        rec_score = float(f[-1])
        entry = {"box": box, "height": height, "detection_score": round(rec_score, 3)}
        if height < args.min_face:
            # Reported, not dropped. "There is someone across the room but they
            # are too far away to tell" is a true and useful answer; silently
            # returning one face when the camera can see two is not.
            entry.update({"name": None, "score": None, "too_small": True})
            seen.append(entry)
            continue
        try:
            v = embed(rec, img, f)
        except Exception as e:
            entry.update({"name": None, "score": None, "error": str(e)})
            seen.append(entry)
            continue
        best_name, best_score = None, -1.0
        for name, vecs in known:
            s = float(np.max(vecs @ v))  # best of that person's enrolled angles
            if s > best_score:
                best_name, best_score = name, s
        entry["score"] = round(best_score, 3) if known else None
        entry["name"] = best_name if (known and best_score >= args.threshold) else None
        entry["reliable"] = height >= RELIABLE_FACE_PX
        seen.append(entry)

    out({
        "ok": True,
        "camera_url": args.url,
        "frame": [int(img.shape[1]), int(img.shape[0])],
        "faces": seen,
        "enrolled": [p.get("name", k) for k, p in people.items()],
        "threshold": args.threshold,
    })


# ── enroll ──────────────────────────────────────────────────────────────────

def cmd_enroll(args):
    det, rec = build()
    path = gallery_path(args)
    g = load_gallery(path)
    key = slug(args.name)

    crops_dir = path.parent / "crops"
    crops_dir.mkdir(parents=True, exist_ok=True)

    vecs, crops, rejected = [], [], []
    stamp = int(time.time())
    started = time.time()
    deadline = started + args.wait
    i = -1
    while len(vecs) < args.shots and time.time() < deadline:
        i += 1
        if i:
            time.sleep(args.interval)
        try:
            img, _ = grab(args.url)
        except RuntimeError as e:
            rejected.append(str(e))
            continue
        faces = detect(det, img)
        if not faces:
            rejected.append("no face in frame")
            continue
        f = faces[0]  # largest — the person standing at the camera, not one behind them
        h = int(f[3])
        if h < args.min_face:
            rejected.append(f"nearest face only {h}px tall, too far away")
            continue
        # WAIT for him to look over rather than capturing whatever is pointed
        # where. A countdown asks a person to perform being still; a camera that
        # is patient just needs them to glance at it once.
        if not is_frontal(f):
            nose, spread = frontality(f)
            rejected.append(f"face turned away (nose {nose:.2f}, eyes {spread:.2f})")
            continue
        try:
            v = embed(rec, img, f)
        except Exception as e:
            rejected.append(str(e))
            continue
        if vecs and max(cosine(v, u) for u in vecs) > DIVERSITY_MAX:
            rejected.append("same pose as a shot already taken")
            continue
        vecs.append(v)
        # The crop is written to disk on purpose: an enrolment is a claim about
        # WHOSE face this is, and the only way to check that claim later is to
        # look at what was actually captured.
        x, y, w, bh = box_of(f)
        pad = int(0.25 * bh)
        crop = img[max(0, y - pad):y + bh + pad, max(0, x - pad):x + w + pad]
        cp = crops_dir / f"{key}-{stamp}-{i}.jpg"
        cv2.imwrite(str(cp), crop)
        crops.append(str(cp))

    if not vecs:
        # WHY it failed decides what the person does next, and the first version
        # of this printed the first six rejects verbatim — which over a
        # forty-second wait is the first two seconds, and says nothing about the
        # other thirty-eight. A tally of every attempt is both shorter and true.
        n = tally(rejected)
        if n["turned_away"] and not n["camera"]:
            fail("never_faced_camera",
                 f"someone was in front of the camera for {n['turned_away']} of {n['attempts']} "
                 f"attempts over {args.wait:.0f}s but never turned toward it" +
                 (f" (and the frame was empty {n['no_face']} times)" if n["no_face"] else ""))
        if n["too_far"] and not n["camera"]:
            fail("too_far_away",
                 f"a face was visible {n['too_far']} of {n['attempts']} attempts but never closer "
                 f"than {args.min_face}px tall, which is too small to measure")
        if n["camera"]:
            fail("camera_down", rejected[-1])
        fail("nothing_captured",
             f"nobody was in front of the camera — {n['no_face']} of {n['attempts']} attempts saw "
             f"an empty frame" if n["no_face"] else "; ".join(rejected[:4]) or "no frames taken")

    # THE SHOTS MUST AGREE WITH EACH OTHER BEFORE ANY OF THEM IS BELIEVED.
    #
    # Enrolment takes the LARGEST face, on the reasoning that the person being
    # enrolled is the one standing at the camera. The room camera has already
    # shown three people at once — if someone crosses in front mid-capture,
    # that reasoning silently enrols the wrong face under Grayson's name, and
    # every identify afterwards is wrong in a way nothing would surface.
    #
    # So the captured set is checked against itself: shots that do not match
    # the centroid of the set are dropped, and if the set does not hold
    # together at all, nothing is saved. Cheap, and it turns the failure from
    # a corrupted gallery into a message saying to try again.
    dropped = []
    if len(vecs) > 2:
        c = np.mean(np.stack(vecs), axis=0)
        c = c / np.linalg.norm(c)
        keep = []
        for i, v in enumerate(vecs):
            s = cosine(v, c)
            (keep if s >= args.threshold else dropped).append((i, v, round(s, 3)))
        if len(keep) < 2:
            fail("shots_disagree",
                 "the captured faces do not match each other — someone may have crossed the camera. "
                 "Nothing was saved.")
        crops = [crops[i] for i, _, _ in keep]
        vecs = [v for _, v, _ in keep]
        dropped = [{"shot": i, "similarity": s} for i, _, s in dropped]

    # Every shot identical means the camera served one frozen frame N times, and
    # a gallery of eight copies of one picture looks robust and is not. Say so
    # rather than letting the count imply coverage it does not have.
    spread = None
    if len(vecs) > 1:
        m = np.stack(vecs)
        sims = m @ m.T
        iu = np.triu_indices(len(vecs), k=1)
        spread = float(np.mean(sims[iu]))

    person = g["people"].get(key) if not args.replace else None
    if person is None:
        person = {"name": args.name.strip(), "embeddings": [], "enrolled": []}
    person["name"] = args.name.strip()
    person["embeddings"] = (person["embeddings"] + [v.tolist() for v in vecs])[-MAX_EMBEDDINGS:]
    person["enrolled"] = (person.get("enrolled", []) + [{"at": stamp, "shots": len(vecs), "crops": crops}])[-10:]
    g["people"][key] = person
    save_gallery(path, g)

    out({
        "ok": True,
        "name": person["name"],
        "captured": len(vecs),
        "asked_for": args.shots,
        "seconds": round(time.time() - started, 1),
        "rejected": tally(rejected),
        "dropped_as_someone_else": dropped,
        "total_embeddings": len(person["embeddings"]),
        # A frozen camera cannot show itself in the SHOTS any more, because the
        # diversity gate now refuses the duplicates it would produce. It shows
        # up in the rejects instead: a wall of "same pose" against almost
        # nothing kept. Detected where the evidence actually is.
        "frozen_frame_suspected": bool(tally(rejected)["same_pose"] >= 10 and len(vecs) <= 2),
        "shot_similarity": None if spread is None else round(spread, 4),
        "crops": crops,
        "gallery": str(path),
    })


# ── housekeeping ────────────────────────────────────────────────────────────

def cmd_list(args):
    g = load_gallery(gallery_path(args))
    out({
        "ok": True,
        "gallery": str(gallery_path(args)),
        "people": [
            {"name": p.get("name", k), "embeddings": len(p.get("embeddings", [])),
             "last_enrolled": (p.get("enrolled") or [{}])[-1].get("at")}
            for k, p in g["people"].items()
        ],
    })


def cmd_forget(args):
    path = gallery_path(args)
    g = load_gallery(path)
    key = slug(args.name)
    if key not in g["people"]:
        fail("no_such_person", f"nobody enrolled as {args.name}")
    name = g["people"].pop(key).get("name", key)
    save_gallery(path, g)
    out({"ok": True, "forgotten": name})


def cmd_selftest(args):
    """Prove the pipeline end to end without needing a known face in frame."""
    missing = models_ready()
    if missing:
        fail("no_models", "missing or truncated: " + ", ".join(missing))
    det, rec = build()
    try:
        img, raw = grab(args.url)
    except RuntimeError as e:
        fail("camera_down", str(e))
    faces = detect(det, img)
    res = {"ok": True, "models": [str(DETECTOR), str(EMBEDDER)], "frame_bytes": len(raw),
           "frame": [int(img.shape[1]), int(img.shape[0])], "faces": len(faces)}
    if faces:
        v1 = embed(rec, img, faces[0])
        res["self_similarity"] = round(cosine(v1, embed(rec, img, faces[0])), 4)
        res["largest_face_px"] = int(faces[0][3])
    out(res)


def main():
    ap = argparse.ArgumentParser(description="Local face recognition for Cleetus.")
    ap.add_argument("--gallery", help="Directory holding faces/gallery.json. Defaults to CLEETUS_MEMORY_ROOT.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    # --url, never --camera. The camera names live in cleetusd/src/tools/vision.mjs
    # and nowhere else; a second map here is a second thing to keep in step.
    def with_url(p):
        p.add_argument("--url", required=True, help="Still-frame endpoint, e.g. http://127.0.0.1:8768/frame.jpg")
        p.add_argument("--min-face", type=int, default=MIN_FACE_PX, dest="min_face")
        return p

    i = with_url(sub.add_parser("identify"))
    i.add_argument("--threshold", type=float, default=COSINE_MATCH)
    i.set_defaults(fn=cmd_identify)

    e = with_url(sub.add_parser("enroll"))
    e.add_argument("--name", required=True)
    e.add_argument("--shots", type=int, default=8)
    e.add_argument("--interval", type=float, default=0.6)
    e.add_argument("--wait", type=float, default=30.0,
                   help="Seconds to keep watching for a face turned toward the camera.")
    e.add_argument("--replace", action="store_true", help="Start this person over instead of adding angles.")
    e.add_argument("--threshold", type=float, default=COSINE_MATCH)
    e.set_defaults(fn=cmd_enroll)

    s = with_url(sub.add_parser("selftest"))
    s.set_defaults(fn=cmd_selftest)

    l = sub.add_parser("list")
    l.set_defaults(fn=cmd_list)

    f = sub.add_parser("forget")
    f.add_argument("--name", required=True)
    f.set_defaults(fn=cmd_forget)

    args = ap.parse_args()
    try:
        args.fn(args)
    except SystemExit:
        raise
    except Exception as e:  # never a traceback: the caller parses stdout
        fail("unexpected", f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
