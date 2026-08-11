---
name: steap-booking
description: >
  Full booking agent for Sweet Tea Pedigree. Generates venue pitches, finds co-bill
  bands via Instagram/TikTok search, manages the booking pipeline (pitched → hold →
  confirmed), syncs confirmed shows to the STEAP Google Calendar, sends show advances,
  and teaches Grayson the industry. Use for: "pitch [venue]", "find co-bills",
  "booking status", "what shows should we go after", "advance [venue]",
  "add [show] to calendar", "teach me how to book shows".
argument-hint: [pitch <venue>] [advance <venue> <date>] [status] [find-bands] [calendar] [teach <topic>]
---

# steap-booking — Full Booking Agent

Cleetus's complete show booking system for Sweet Tea Pedigree.
Covers discovery → outreach → pipeline → calendar → advance → settle → follow-up.

---

## What This Skill Can Do

| Command | What happens |
|---------|-------------|
| `pitch <venue>` | Generate a personalized booking pitch email, save to drafts |
| `advance <venue> <date>` | Generate the standard show advance email |
| `find-bands [location] [genre]` | Search Instagram/TikTok/web for co-bill candidates |
| `status` | Full pipeline view — what's pitched, on hold, confirmed |
| `confirm <pitch_id>` | Mark show confirmed, add to STEAP Google Calendar |
| `calendar` | Show upcoming STEAP calendar events |
| `teach <topic>` | Explain a booking concept using the Show Booking Guide |
| `targets` | Print the priority venue target queue |

---

## Core Scripts

| Script | What it does |
|--------|-------------|
| `scripts/generate_booking_pitch.py` | AI-drafted venue pitch email, saves to drafts |
| `scripts/send_show_advance.py` | Standard advance email generator |
| `../../scripts/booking_pipeline.py` | Full SQLite pipeline: pitches, shows, bands |
| `../../scripts/band_finder.py` | Band discovery via Brave Search + Claude Haiku |

---

## Full Pipeline Workflow

### Step 1 — Find Targets
```bash
# Who should we pitch?
python3 scripts/booking_pipeline.py pipeline        # see current status
python3 scripts/band_finder.py search               # find new co-bill bands
python3 scripts/band_finder.py instagram-hashtag "#athensmusic"
python3 scripts/band_finder.py venue-calendar "40 Watt"
```

### Step 2 — Pitch a Venue
```bash
# Generate the pitch email
python3 scripts/generate_booking_pitch.py --venue "40 Watt" --date "June 2026"

# Log it in the pipeline
python3 scripts/booking_pipeline.py add-pitch "40 Watt" \
    --email velenavego@gmail.com \
    --date 2026-06-15
```

### Step 3 — Track the Hold
```bash
# Venue says "we can do June 21st" — put it on hold
python3 scripts/booking_pipeline.py hold 1 --date 2026-06-21
```

### Step 4 — Confirm the Show
```bash
# Show is confirmed — log the details
python3 scripts/booking_pipeline.py confirm 1 \
    --date 2026-06-21 \
    --set-time 21:30 \
    --load-in 18:00 \
    --soundcheck 19:00 \
    --set-length 60 \
    --deal guarantee \
    --guarantee 400 \
    --address "285 W. Washington St, Athens GA 30601"

# Push to STEAP Google Calendar automatically
python3 scripts/booking_pipeline.py calendar-sync
```

### Step 5 — Send the Advance (2–3 weeks out)
```bash
python3 scripts/send_show_advance.py --venue "40 Watt" --date 2026-06-21
```

### Step 6 — Day of Show
- Arrive at load-in time
- Soundcheck, play, settle payment
- Mark show complete:
```bash
python3 scripts/booking_pipeline.py confirm 1   # re-run to update payout notes
```

### Step 7 — Follow-Up
Email the booker within 48 hours. Tag the venue in social posts. Set up the next one.

---

## Band Discovery Workflow

When Grayson says "find bands" or "who should we co-bill with":

1. Run `band_finder.py search` — queries Brave Search + Claude Haiku extraction
2. Results are saved to the pipeline as leads (`status = 'lead'`)
3. Review leads: `booking_pipeline.py list-bands`
4. Update status as you reach out: `booking_pipeline.py band-status 3 contacted`
5. When a band is interested: `booking_pipeline.py band-status 3 interested`
6. Add them to a show pitch as part of the co-bill

### What the finder looks for
- Athens-area bands (can extend to Atlanta, Southeast)
- Genres that complement STEAP: soul, R&B, Americana, indie rock, funk, blues
- Active social presence (posting in last 30 days)
- Similar audience size (within 50% of STEAP's draw)
- Southeast-based or willing to travel

### Manual discovery sources
- OTM (@weare_onthemap) weekly event roundups — every band featured is a lead
- GLM (@goodlifemusicllc) roster — The Wraps, Sky Ciela, Aislin Ward, Patriot McKee
- Flagpole calendar — who else is playing 40 Watt / Georgia Theatre openers?
- Workin' Past Midnight showcase nights
- Instagram hashtags: `#athensmusic`, `#athensband`, `#athensga`, `#ugamusic`

---

## Google Calendar Integration

The **STEAP calendar** already exists in Grayson's Google account.
Calendar ID: `33ad875b74640fe961001763256b347def6422496ee9e099b3f0628b260c7134@group.calendar.google.com`

All confirmed shows automatically sync when you run `calendar-sync`:
```bash
python3 scripts/booking_pipeline.py calendar-sync
```

**⚠️ REQUIRES CALENDAR WRITE SCOPE**
The current token only has `calendar.readonly`. Grayson needs to re-run auth once:
```bash
cd ~/cleetus && python3 auth.py
```
This opens a browser to approve the updated scope (now includes full calendar write access).

---

## Teaching Mode

When Grayson asks to learn about booking, reference `vault/50-Resources/Show-Booking-Guide.md`.

Key topics in the guide:
- **The pipeline** (lead → pitch → hold → confirm → advance → day-of → settle)
- **Deal structures** (guarantee, door split, vs., break-even)
- **How to write a pitch** (hook hierarchy, length, what to never say)
- **Holds** (first hold vs. second hold, how to challenge)
- **Advancing a show** (what to confirm 2-3 weeks out)
- **Day-of-show checklist** (arrival, soundcheck, settlement)
- **The follow-up** (most underused tool in booking)
- **Finding co-bills** (where to look, how to reach out)
- **Regional touring** (hub-and-spoke model, routing logic)
- **Festival strategy** (AthFest, Savannah Stopover, FloydFest)
- **Deal negotiation** (how to counter, what your floor is)
- **Contracts and getting paid** (STEAP is an LLC — track everything)

Example: "Grayson, what's a guarantee vs. door deal?" → Pull from Part 3 of the guide.

---

## Priority Target Queue (Summer 2026)

| Priority | Venue | Contact | Deal target | Status |
|----------|-------|---------|-------------|--------|
| 🔴 1 | **40 Watt Club** (headline) | velenavego@gmail.com | $300–500 guarantee | Not pitched |
| 🔴 2 | **Georgia Theatre** (support or headline) | margarita@zeromile.com | Vary | Played ✅ → return |
| 🟡 3 | **Live Wire Athens** | AJ Steele 470-236-2069 | $200–400 | Not pitched |
| 🟡 4 | **Smith's Olde Bar** (Atlanta return) | Form/email | $300 | Played ✅ → return |
| 🟢 5 | **AthFest** submission | athfest.com | Festival slot | Submit now |
| 🟢 6 | **Savannah Stopover** | savannahstopover.com | Festival | Submit fall |
| 🟢 7 | **OTM artist feature** | @weare_onthemap | Free promo | DM pitch |

---

## Key Files

| File | Purpose |
|------|---------|
| `vault/30-Projects/STEAP/STEAP-Profile.md` | Full band bio, history, contacts |
| `vault/30-Projects/STEAP/Athens-Venues.md` | Complete Athens venue directory |
| `vault/50-Resources/Show-Booking-Guide.md` | Complete booking education guide |
| `~/.cache/booking_pipeline.sqlite` | Live pipeline database |
| `vault/30-Projects/STEAP/Advances/` | Archive of sent advance emails |
| `vault/drafts/active/` | Pitch drafts pending send |

---

## Voice Guidelines (All Booking Comms)
- Warm, direct, Southern-professional — never corporate
- First email = 4–5 sentences MAX
- Lead with strongest credential for that specific venue
- Close with clear ask + availability window
- Never mention alcohol
- Sign: "Grayson" — not "Grayson Pope"
- Follow up once at 7–10 days, then move on
