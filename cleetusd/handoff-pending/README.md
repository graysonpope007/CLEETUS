# Pending handoff update — section 15

`apply-section-15.py` adds **section 15 (the browser, working for the first time)** to
`~/Desktop/Cleetus/CLEETUS-HANDOFF.html`, and refreshes the rows that tonight's work made
stale (browse tool now live, 18 tools not 15, 24 doctor checks not 20).

It could not be applied automatically: macOS revoked this session's access to `~/Desktop`
mid-task. Every path outside Desktop stayed readable, and the handoff itself is intact and
complete through section 14 — only this addition is outstanding.

Run it from a terminal that has Desktop access (any normal Terminal window):

    python3 ~/cleetusd/handoff-pending/apply-section-15.py

It prints `added section 15 and refreshed the affected rows` and reports tag balance.
Safe to run once; running it twice would add the section twice, so check first:

    grep -c 'id="s15"' ~/Desktop/Cleetus/CLEETUS-HANDOFF.html   # 0 = not yet applied
