#!/usr/bin/env python3
"""ruview-raw.py: keep the per-subcarrier CSI that every other path throws away.

The sensing server's recordings and WebSocket carry summary features only
(`amplitude: []`), and the collector reduces each frame to 7 numbers. Position
lives in the SHAPE of the channel across subcarriers (multipath), so testing
any localisation idea needs the raw frames. The server tees every admitted
datagram to 127.0.0.1:5006 when RUVIEW_UDP_TEE is set; this stores them.

Output: ~/cleetusd/roomwatch/csi-raw/YYYYmmdd-HHMM.npz, one file per minute:
  t (float64 unix s), node (uint8), rssi (int8), amp (float16, N x 64),
  src (uint64 transmitter MAC, 0 = firmware without the trailer)
Amplitude only: ESP32 phase carries per-packet CFO/SFO/STO offsets that a
single antenna cannot remove.

  ruview-raw.py            run the collector
  ruview-raw.py --stats    print magic counts for 10 s and exit
"""
import socket, struct, sys, time, pathlib, collections
import numpy as np

PORT = 5006
OUT = pathlib.Path.home() / "cleetusd/roomwatch/csi-raw"
CSI_MAGIC = 0xC5110001
NSUB = 64

def parse(pkt):
    if len(pkt) < 20:
        return None
    magic, node, nant, nsub = struct.unpack_from("<IBBH", pkt, 0)
    if magic != CSI_MAGIC:
        return magic, None
    rssi = struct.unpack_from("<b", pkt, 16)[0]
    iq_len = nant * nsub * 2
    # Multi-illuminator firmware appends the 6-byte transmitter MAC after the
    # I/Q; older firmware sends none (src = 0).
    src = int.from_bytes(pkt[20 + iq_len:26 + iq_len], "big") if len(pkt) >= 26 + iq_len else 0
    iq = np.frombuffer(pkt, dtype=np.int8, offset=20)
    if iq.size < 2 * NSUB:
        return magic, None
    iq = iq[: 2 * NSUB].astype(np.float32)
    # ESP32 order is imaginary, real per subcarrier.
    amp = np.hypot(iq[1::2], iq[0::2])
    return magic, (node, rssi, amp, src)

def main():
    stats = "--stats" in sys.argv
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", PORT))
    s.settimeout(1.0)
    # Live consumers (ruview-locate-live.py on 5007) get every packet verbatim.
    fwd = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    OUT.mkdir(parents=True, exist_ok=True)
    magics = collections.Counter()
    buf = []
    minute = time.strftime("%Y%m%d-%H%M")
    t_end = time.time() + 10
    while True:
        try:
            pkt, _ = s.recvfrom(4096)
        except socket.timeout:
            pkt = None
        now = time.time()
        if pkt:
            try:
                fwd.sendto(pkt, ("127.0.0.1", 5007))
            except OSError:
                pass
            r = parse(pkt)
            if r:
                magics[hex(r[0])] += 1
                if r[1] is not None and not stats:
                    node, rssi, amp, src = r[1]
                    buf.append((now, node, rssi, amp, src))
        if stats and now > t_end:
            print(dict(magics)); return
        m = time.strftime("%Y%m%d-%H%M")
        if m != minute and buf:
            np.savez(OUT / f"{minute}.npz",
                     t=np.array([b[0] for b in buf]),
                     node=np.array([b[1] for b in buf], dtype=np.uint8),
                     rssi=np.array([b[2] for b in buf], dtype=np.int8),
                     amp=np.stack([b[3] for b in buf]).astype(np.float16),
                     src=np.array([b[4] for b in buf], dtype=np.uint64))
            buf = []
        minute = m

if __name__ == "__main__":
    main()
