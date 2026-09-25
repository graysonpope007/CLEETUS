#!/usr/bin/env python3
"""ruview-locate-session.py: guided, spoken calibration walk for RF localisation.

Speaks each instruction through the Mac (`say`) and logs exact block times to
~/cleetusd/roomwatch/locate-sessions/<start>.jsonl. Raw CSI is collected
separately by ruview-raw.py; the analyser joins them on time.

Design, because a localisation test is easy to fool:
  * ROUNDS: every spot is visited once per round, in a DIFFERENT shuffled order
    each round. The analyser trains on some rounds and tests on a held-out one,
    so the model is always judged on a visit it has never seen.
  * OUT blocks are interleaved (you leave the room), so "empty" is sampled
    across the whole session and slow drift cannot masquerade as position.
  * Only the settled middle of each block is labelled: the first SETTLE seconds
    (walking there) are logged but excluded.

  ruview-locate-session.py [--rounds 3] [--block 45]
"""
import json, random, subprocess, sys, time, pathlib, argparse

SPOTS = [
    ("desk",   "Sit in the desk chair."),
    ("keys",   "Sit on the stool at the keyboard."),
    ("bed",    "Lie down on the bed."),
    ("center", "Stand in the middle of the room."),
    ("closet", "Stand by the closet."),
    ("out",    "Leave the room."),
]
SETTLE = 12

ap = argparse.ArgumentParser()
ap.add_argument("--rounds", type=int, default=3)
ap.add_argument("--block", type=int, default=45)
ap.add_argument("--spots", default=",".join(s for s, _ in SPOTS))
a = ap.parse_args()
chosen = [s for s in SPOTS if s[0] in a.spots.split(",")]

out = pathlib.Path.home() / "cleetusd/roomwatch/locate-sessions"
out.mkdir(parents=True, exist_ok=True)
log = out / time.strftime("%Y%m%d-%H%M%S.jsonl")

def say(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)
    subprocess.run(["say", "-r", "185", msg])

def write(row):
    with open(log, "a") as f:
        f.write(json.dumps(row) + "\n")

say(f"Localisation calibration. {a.rounds} rounds of {len(chosen)} spots, {a.block} seconds each. "
    "Move when I say, then stay put until the next instruction.")
for r in range(a.rounds):
    # The first walk shut the door for every "out" block and the model learned
    # "door shut = out". Alternate the door by ROUND so every spot, out
    # included, is seen both ways.
    door = "open" if r % 2 == 0 else "closed"
    say(f"Round {r + 1}. Set the door {door} and leave it {door} for this whole round, including when you step out.")
    time.sleep(8)
    order = chosen[:]
    random.shuffle(order)
    for spot, instr in order:
        say(instr)
        t0 = time.time()
        write({"round": r, "spot": spot, "door": door, "t_move": t0, "t0": t0 + SETTLE, "t1": t0 + a.block})
        # stay silent through the block; a chime marks the end
        time.sleep(a.block)
        subprocess.run(["afplay", "/System/Library/Sounds/Tink.aiff"])
say("Done. Thank you. You can come back to the desk.")
print("session log:", log)
