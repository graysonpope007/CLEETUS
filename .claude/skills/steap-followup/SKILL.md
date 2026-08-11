---
name: steap-followup
description: Scan Gmail for Sweet Tea Pedigree (STEAP) booking inquiries and venue replies. Draft follow-ups in Grayson's voice. Flag threads older than 5 days without a response. Use when Grayson says "STEAP follow-ups", "booking check", or when heartbeat detects stale booking threads.
argument-hint: [--dry-run] [--days-stale N]
---

# steap-followup

Scans Gmail for STEAP booking and promo threads, drafts follow-ups in Grayson's voice, and flags anything stale.

## Workflow

1. **Scan** — Run `scan_booking_threads.py` to pull Gmail threads matching the STEAP booking query.

2. **Flag stale** — Run `flag_stale_threads.py` to identify threads where Grayson hasn't replied in > 5 days (default).

3. **Draft follow-ups** — For each stale or unanswered thread:
   - Search `vault/drafts/sent/` via `memory_search.py --path-prefix drafts/sent` for similar past replies
   - Use those matches to calibrate Grayson's voice
   - Write a draft to `vault/drafts/active/YYYY-MM-DD_email_<venue-slug>.md`

4. **Report** — Post a summary to Grayson via Slack DM: how many threads scanned, how many stale, draft filenames.

## Draft File Format

```markdown
---
type: email
source_id: <gmail_thread_id>
recipient: <venue or contact name>
subject: <email subject>
context: STEAP booking inquiry
created: YYYY-MM-DD
status: active
---

## Original Message

[last message in thread]

## Draft Reply

[Grayson's voice — concise, warm, professional. No bullet walls. No alcohol references.]
```

## Gmail Search Query
```
STEAP OR "Sweet Tea Pedigree" (booking OR venue OR show OR gig OR inquiry OR follow)
```

## Voice Guidelines (until booking-voice-samples.md is populated)
- Warm, direct, Southern-friendly but professional
- One paragraph max for an initial follow-up
- Always include availability window or ask for theirs
- Never mention alcohol
- Sign off as "Grayson" not "Grayson Pope"

## Scripts
- `scripts/scan_booking_threads.py` — Gmail query, returns thread list
- `scripts/flag_stale_threads.py` — filters threads where Grayson's last reply > N days ago

## References
- `references/booking-voice-samples.md` — Paste 3–5 real STEAP follow-up emails here for voice calibration. **REQUIRED before production use.**
