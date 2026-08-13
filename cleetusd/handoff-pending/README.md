# Pending handoff updates

> **APPLIED 12 Aug 2026, 22:5x ET.** Desktop access was granted and
> `apply-pending-handoff.py` ran clean: sections 17-25 written, table of contents
> complete, no unbalanced tags, rendered and checked in a browser. The handoff went
> from 9 sections to 18 (s08-s25) and 115,202 to 153,090 characters. A timestamped
> `.bak` sits beside it. Nothing below is outstanding; it is kept as the record of
> what was queued and why. Re-running exits on its own (`id="s25"` guard).

macOS keeps revoking this background session's access to `~/Desktop`. Everything outside
Desktop is unaffected, so the work is done and verified — only the write to the handoff is
blocked.

    python3 ~/cleetusd/handoff-pending/apply-pending-handoff.py

Applies four things, asserting each anchor first so it fails loudly rather than
half-applying:

1. **Correction to section 15** — Playwright was not one of the browser faults. The harness
   launches with `channel: 'chrome'`; the failure was in a probe I wrote while diagnosing.
   Three faults, not four.
2. **Section 17** — the tool sweep: the missing-argument guard, and the browser being unable
   to recover from being closed.
3. **Correction to section 14** — the six "recoverable" launch agents are **not** a pure path
   rewrite. This is the one that matters.
4. **Section 18** — why. Short version: the vault is computed as
   `Path(__file__).parents[2] / "vault"`, so repointing the scripts moves the vault to
   `/Users/grayson/vault`, which does not exist. The brief would run, succeed, and write
   where nobody looks.

5. **Section 19** — the flight map was returning `no_adsb_feed_reachable` in production. adsb.lol
   answers 200 with an empty list, and the source loop returned on the first *Array* it got, so the
   fallbacks never ran. adsb.fi works and is now tried first. Live: 4,862 aircraft, 20/20 anchors.

Superseded check: `grep -c 'id="s19"' ~/Desktop/Cleetus/CLEETUS-HANDOFF.html` → 0 means not yet.

6. **Section 24** — the air trackpad. Four faults stacked, every one presenting as nothing
   happening while every readout stayed green: it was driving the television, the tracker
   thread had been dead for hours on a MediaPipe timestamp error, the camera was sending one
   picture over and over (0.2 real fps at the configured 1080p), and the watchdog's polite
   SIGTERM could not clear it. Plus calibration: a homography from four measured corners.

7. **Section 25** — /reach and /ruview as real pages, and the chat that answered with its own
   preamble. Same question, same 20 tool calls: 378 characters ending on a colon, against
   1,479 that lead with the conclusion.

Rehearsed before shipping: the script was run against a synthetic file carrying all eight
anchors it asserts. Exit 0, both sections spliced, table of contents complete, both sections
internally balanced.

Already applied? `grep -c 'id="s25"' ~/Desktop/Cleetus/CLEETUS-HANDOFF.html` → 0 means not yet.
