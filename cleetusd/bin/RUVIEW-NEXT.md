# RuView: where it actually stands, and the one experiment left

Measured 2026-08-24 on 65.5 h of labelled data (215,072 samples, 29 transitions).
Run `python3 bin/ruview-verdict.py` to reproduce.

## Settled with verified ground truth, 2026-08-24/25

296 minutes of camera-corroborated EMPTY room against 83 minutes of verified
OCCUPIED. No inferred labels anywhere. Run `python3 bin/ruview-empty.py`.

**Every output RuView presents as an answer is a constant.**

| output | verified empty | verified occupied | lift |
|---|---|---|---|
| `edge-vitals presence` | 5.4% true | 5.0% true | -0.4 pts |
| `motion` | 100% | 100% | 0.0 |
| `person_count > 0` | 100% | 100% | 0.0 |
| `pose n > 0` | 100% | 99.9% | -0.1 |

`presence` briefly looked like the one sane output because it is false 95% of
the time in an empty room. It is false 95% of the time with somebody sitting
there too. Low false-positive rate, zero true-positive rate.

`pose` reported a mean of 4.5 people and a peak of **14** in a room the camera
agreed was empty, every keypoint at confidence 0.00.

**The CSI motion features do not respond to a human at all.** Verified-empty,
HID-away and HID-at-desk medians for `mbp`, `bbp`, `var` and `spec` all sit
within 0.06 sigma of each other. The old HID-derived negative class was never
the problem: the sensor is.

**RSSI differences are drift.** Node 3 wanders 2 dB across five hours with
nobody in the room and has a 15 dB spread. The gap that looked like occupancy
was 4 dB.

**The verified return at 22:35:42** scored 1.rssi 0.752 at four minutes and
0.683 / 0.666 / 0.666 across all three nodes at fifteen. Against the 41
historical transitions scored identically, single-transition RSSI has a median
of 0.508 and a p90 of 0.666: a node reaches that by chance 11% of the time and
all three agree in direction on 17% of transitions. It was an ordinary
transition that landed high, which is the same mechanism that produced the
0.705 corrected earlier.

The field calibration was also completed for the first time (12,831 frames, 14
eigenvalues, variance explained 0.168) and changed none of the above.

## The earlier verdict, from inferred labels



**No usable signal, for either question.**

| question | best feature | AUC | consistency |
|---|---|---|---|
| is he seated at the desk | `3.rssi` | 0.545 | 57% |
| did something cross the room | `2.dom` | 0.439 | 76% |

The positive control, run through the identical pipeline, detects a consistent
synthetic effect from about **0.25 sigma** (AUC 0.560 at 96% consistency). Pure
noise reads 0.499 at 54%. The real features sit with the noise. This is a
measurement, not an absence of one.

### Why the earlier number was better than the truth

`ruview-transitions.py` reported **0.705** and it was read as "trending negative
but close". It picked the strongest of 21 features AT EACH TRANSITION and then
averaged, which is a lottery: whichever feature has the widest dynamic range
wins most often whether or not it carries information. RSSI won 13 of 27 that
way. Fixed a priori and scored across all transitions, RSSI is 0.545 at 57%
consistency, which is noise.

**Consistency is the discriminator, not AUC.** A real 0.10-sigma effect shows
79% consistency. Noise shows ~54% with an AUC that can still look respectable.

## Why it fails, and what would change it

The router is **downstairs**, past the desk-guitar wall. Every sensed path is
the AP radiating up through the floor and arriving as scattered multipath, and a
body seated above nodes mounted at 0.75 m rarely intersects it. No feature, no
threshold and no model repairs that: the channel being measured does not pass
through the person.

CSI responds when a body sits **between a transmitter and a receiver**. So the
fix is a transmitter inside the room.

## The experiment, cheapest first

The nodes capture CSI promiscuously, so a node does **not** have to associate
with the transmitter it senses. It only has to be **tuned to the same channel**.
The fleet is on channel 1.

### Option A, free: an existing 2.4 GHz device already in the room

There are Meross smart plugs on the LAN (`c4:e7:ae:27:1e:4a` at 192.168.1.5,
`c4:e7:ae:27:1d:8e` at 192.168.1.254) and an unidentified Espressif device
(`24:58:7c:e3:32:d0` at 192.168.1.235). If any of them is physically in the
studio and on channel 1, it is a free in-room transmitter.

They are clients, not APs, so they transmit only when they have something to
say. Generate traffic with a steady ping. Keep it gentle: 20 parallel pingers
knocked both ESP32 nodes offline last time, so start at one ping every 20 ms and
watch the node stay up.

### Option B, about $25 and the one that should actually work

A cheap 2.4 GHz access point or travel router, **pinned to channel 1**, placed
across the room so the desk chair sits between it and at least one node, and
bridged to the existing LAN so the nodes keep reaching the Mac at 192.168.1.134.

An iPhone hotspot is not a good substitute: you cannot pin its channel, and if a
node joins it instead of the house network it can no longer reach the Mac.

## Running it

Use `~/RuView/firmware/esp32-csi-node/provision.py`. **NOT**
`~/RuView/scripts/provision.py`, which is a different, older script with no
`--filter-mac`, no `--tdm-total` and no `--channel`. Half of this project's
lost time is flags that exist in one copy and not the other.

Change ONE node first. If a single node with a clean in-room path shows nothing,
three will not either, and that is a cheap way to find out.

```
# 1. Get the new transmitter's 2.4 GHz BSSID and confirm its channel is 1.

# 2. Desk node on USB. Keep every other setting identical to today:
python3 ~/RuView/firmware/esp32-csi-node/provision.py \
  --port /dev/cu.usbmodem* \
  --ssid 'Not a meth lab' --password '<pw>' \
  --target-ip 192.168.1.134 --target-port 5005 \
  --node-id 2 --tdm-slot 1 --tdm-total 3 --zone studio --edge-tier 2 \
  --channel 1 \
  --filter-mac <NEW_BSSID> \
  --pres-thresh 0

# 3. Power-cycle and LEAVE THE ROOM for 90 s. The per-node presence threshold
#    is learned from the first 1200 frames after boot, so booting with a person
#    in the room teaches it that a person is the ambient state.

# 4. Let the collector gather at least 10 transitions, then:
python3 ~/cleetusd/bin/ruview-verdict.py
```

The collector is already running as `com.cleetus.ruview-collect` and labels from
HID idle time, so transitions accumulate for free just by using the desk.

## What to conclude if it still reads noise

That the hardware and the room cannot do CSI presence, which is a real answer
worth having. The camera already does this job: roomwatch identified him by name
while the RF panel said CANNOT TELL. RuView's vitals (breathing, heart rate) are
a separate signal and were never part of this failure.

## Do not spend time on

- Tuning thresholds. Three independent measurements now say the quantity does
  not separate the classes; a threshold cannot fix a distribution overlap.
- `/api/v1/pose/current`. It fabricates people, with all 17 keypoints at
  confidence 0.0, positions outside the room, and the same coordinate repeated.
- Peer-to-peer between nodes. Mechanically sound, ~0.1 frames/s natively, and
  forcing traffic knocks the boards offline.
