#!/usr/bin/env python3
"""roomwatch-cam.py — ask the camera whether anything actually moved.

Stage two of the watcher. RuView says "something changed in the RF"; this says
whether a camera pointed at the room agrees. It is deliberately dumb: frame
differencing on a downscaled grayscale image, no model, no detector. A person
walking through a room is an enormous signal by this measure, and the things
that fool smarter detectors (a poster of a face, a reflection) do not matter
here because the question is only "did the pixels change".

WHY IT GRABS FROM HTTP AND NOT THE DEVICE. The C920 is already held open by
the AirPad process, which serves single JPEGs on 127.0.0.1:8768. Opening the
device a second time is how you get a camera that returns zero frames forever.

WHY IT REPORTS THE WHOLE SERIES. Returning one boolean would hide the shape of
the evidence. A single spike is an autoexposure step or a compression artefact;
motion is several consecutive frames above the floor. The caller decides, and
can see what it decided from.
"""
import argparse, json, os, sys, time, urllib.request
import cv2, numpy as np

p = argparse.ArgumentParser()
p.add_argument("--url", default="http://127.0.0.1:8768/frame.jpg")
p.add_argument("--frames", type=int, default=8)
p.add_argument("--gap-ms", type=int, default=250)
p.add_argument("--out", default="")            # dir to save the frames into
p.add_argument("--tag", default="probe")
p.add_argument("--keep", action="store_true", help="save a thumbnail even when nothing moved")
a = p.parse_args()

def grab():
    with urllib.request.urlopen(a.url, timeout=5) as r:
        buf = np.frombuffer(r.read(), dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    return img

frames, small, err = [], [], None
for i in range(a.frames):
    try:
        img = grab()
        if img is None:
            err = "decode_failed"; break
        frames.append(img)
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        # 160-wide is enough to see a person cross a room and small enough that
        # sensor noise averages out instead of dominating the difference.
        g = cv2.resize(g, (160, 120), interpolation=cv2.INTER_AREA)
        small.append(cv2.GaussianBlur(g, (5, 5), 0).astype(np.int16))
    except Exception as e:
        err = str(e)[:120]; break
    if i < a.frames - 1:
        time.sleep(a.gap_ms / 1000.0)

if err or len(small) < 2:
    print(json.dumps({"ok": False, "error": err or "too_few_frames", "frames": len(small)}))
    sys.exit(1)

# Consecutive difference: how much changed between one frame and the next.
diffs = [float(np.mean(np.abs(small[i] - small[i - 1]))) for i in range(1, len(small))]
# Spread against the first frame: catches a slow walk that never spikes between
# adjacent frames but ends up somewhere completely different.
spread = [float(np.mean(np.abs(s - small[0]))) for s in small[1:]]

# WHAT CHANGED, not HOW MUCH the average pixel changed.
#
# A mean absolute difference cannot tell a person crossing the room from the
# whole image getting slightly brighter: one changes 10% of pixels a lot, the
# other changes 100% of pixels a little, and they average out the same. This
# removes each frame's mean first (killing any global brightness shift) and
# then counts the FRACTION of pixels that moved by more than 12 grey levels.
# A body is a compact blob of large changes and scores high; exposure drift
# scores essentially zero.
norm = [s - s.mean() for s in small]
changed = [float(np.mean(np.abs(norm[i] - norm[i - 1]) > 12) * 100) for i in range(1, len(norm))]

# A FROZEN STREAM IS NOT A STILL ROOM.
#
# If the capture process stalls, /frame.jpg keeps answering 200 with the same
# bytes and every difference goes to zero — which this stage would otherwise
# report as "nothing is moving", forever, in exactly the situation where an
# alarm most needs to speak. Real sensor noise never gives a byte-identical
# pair, so an exact zero is the signature of a stall and never of a quiet room.
identical = sum(1 for i in range(1, len(small)) if int(np.max(np.abs(small[i] - small[i - 1]))) == 0)
frozen = identical >= len(small) - 1 and len(small) > 2

saved = []
if a.out and (a.keep or max(changed, default=0) > 0.5 or frozen):
    os.makedirs(a.out, exist_ok=True)
    # Save the frame with the largest change, plus the first, so a human can see
    # both what the room looked like and what set it off.
    idx = int(np.argmax(spread)) + 1 if spread else 0
    for label, i in (("first", 0), ("peak", idx)):
        path = os.path.join(a.out, f"{a.tag}-{label}.jpg")
        cv2.imwrite(path, frames[i], [cv2.IMWRITE_JPEG_QUALITY, 82])
        saved.append(path)

print(json.dumps({
    "ok": True,
    "frames": len(small),
    "frozen": frozen,
    "identical_pairs": identical,
    "changed_pct": [round(c, 3) for c in changed],
    "max_changed_pct": round(max(changed), 3) if changed else 0.0,
    "mean_brightness": round(float(np.mean([float(s.mean()) for s in small])), 2),
    "diffs": [round(d, 3) for d in diffs],
    "spread": [round(d, 3) for d in spread],
    "max_diff": round(max(diffs), 3),
    "max_spread": round(max(spread), 3) if spread else 0.0,
    "mean_diff": round(float(np.mean(diffs)), 3),
    "saved": saved,
}))
