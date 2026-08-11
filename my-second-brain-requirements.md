# My Second Brain — Requirements

> Filled for Grayson Pope. Feeds into `/create-second-brain-prd my-second-brain-requirements.md`.

---

## 1. About You

- **Name:** Grayson Pope
- **Role/Title:** Label Manager + Executive of Events, Good Life Music LLC (GLM); UGA student; bassist in Sweet Tea Pedigree (STEAP)
- **What I do daily:** I manage artists and events for an independent music label, handle booking and promo follow-ups for my own band, and balance coursework at UGA — all from Athens, GA.
- **Timezone:** America/New_York (Eastern)

---

## 2. Your Platforms

- [X] Email: Gmail
- [X] Calendar: Google Calendar
- [ ] Task Management: _(none currently — # ASSUMPTION: Grayson is not using a dedicated task tracker; tasks flow through Gmail/Slack/vault)_
- [X] Chat/Messaging: Slack (username gpope04, DM channel D0AMJ560C2W)
- [X] Notes/Documents: Obsidian (vault = private git repo)
- [X] Cloud Storage: Google Drive
- [X] Code Hosting: GitHub
- [ ] Community: _(none)_
- [ ] CRM: _(none — # ASSUMPTION: artist/venue relationships tracked in vault notes, not a dedicated CRM)_
- [X] Other: Make.com (deprecating → Cleetus), Twilio (notification channel, staying), Alpha Vantage (stock briefing), Mailchimp, Formspree, Google Analytics, Charles Schwab (OAuth planned — 7-day refresh token expiry is a known blocker)

---

## 3. Top Tasks for AI

1. **STEAP booking + promo follow-ups** [Priority 1 once core is live] — scan Gmail for booking inquiries and venue replies, draft follow-ups in Grayson's voice via `steap-followup` skill, flag anything older than 5 days without a response
2. **GLM artist/show advance and email threading** — surface relevant Gmail threads per artist/show, draft replies, keep vault notes current
3. **Finley proactive planning** — monitor upcoming Finley dates (birthday Dec 20, anniversaries, date ideas), propose allergy-aware (tree-nut free) and alcohol-free gift/experience ideas via `finley-radar` skill, write proposals to `30-Projects/Cleetus/finley/`
4. **Daily stock briefing** — Alpha Vantage data → morning briefing written to `10-Daily/YYYY-MM-DD.md`, migrated from Make.com
5. **School capture + quiz prep** — log assignments, notes, and quiz sessions; synthesize quizzes in "Question # – answer" format

---

## 4. Proactivity Level

- [ ] Observer
- [X] **Advisor** — Draft things for my review, but never send or post. Exception: low-stakes internal vault writes (daily logs, memory updates, file organization) are automatic — no confirmation needed.

---

## 5. Security Boundaries

What Cleetus must NEVER do without explicit confirmation:

- [X] Send email or Slack DMs to anyone other than Grayson
- [X] Post to social media
- [X] Create, accept, or modify calendar invites for external parties
- [X] Execute Schwab trades or any financial transaction — briefing only
- [X] Modify file-sharing permissions on Google Drive or GitHub
- [X] Delete anything
- [X] Other: Never send outbound comms (Slack, Gmail, Twilio) to third parties without explicit "send it" from Grayson. API keys and OAuth tokens live in `.env` / macOS Keychain — never in the vault or git.

---

## 6. Memory Categories

- [X] Meeting notes and decisions
- [X] Project status and progress (GLM artist notes, STEAP, Cleetus)
- [X] Client/customer information (GLM artist + venue contacts)
- [X] Research and learning notes (UGA coursework)
- [X] Personal goals and habits
- [X] Content ideas and drafts
- [X] Team context (GLM roster, STEAP bandmates, venue relationships)
- [X] Other: Finley relationship context (birthday, allergy, date/gift proposals); GLM financials and contracts; Automation/Make migration state; Music gear (Fender P-Bass, Line 6 Helix)

Nothing is walled off — full GLM scope including contracts, financials, and strategy.

---

## 7. Infrastructure

- **Operating System:** [X] macOS
- **Deployment:** [X] Local first → VPS once core + heartbeat are stable
- **Existing tools already set up:**
  - Obsidian installed; vault is this git repo
  - Gmail + Google Calendar OAuth already working (credentials.json + token.json in project root)
  - Python environment active (cleetus.py, cleetus2.py, auth.py already exist)
  - GitHub account active (graysonpope007)
  - Make.com running live scenarios (stock briefing, Gmail/Calendar/Slack reasoning) — all migrating to Cleetus
  - Twilio active as notification channel
  - `.env` file in place at `/Users/grayson/cleetus/.env`

---

## 8. Integration Priority

Build order:

1. Gmail
2. Google Calendar
3. Slack
4. Google Drive
5. Make.com scenario migration (Phase 4b)

---

## Additional Requirements (Beyond Skill Defaults)

### Phase 6 — Morning Briefing Job
7am ET daily job writes `10-Daily/YYYY-MM-DD.md` containing:
- Yesterday's Gmail/Calendar/Slack recap
- Today's agenda (Calendar events)
- Any Finley-related dates within 14 days
- Any STEAP/GLM items flagged in MEMORY.md

### Phase 7 — Chat Interface
- Ship Slack first (DM to gpope04, channel D0AMJ560C2W)
- Message router must use a PlatformAdapter pattern so iMessage and iOS Shortcut can be added as new adapters without changing the core reasoning loop

### Phase 4b — Make.com Migration
Map each current Make scenario to a Cleetus equivalent. Known scenarios:
- Stock briefing (Alpha Vantage → morning email/Slack)
- Gmail triage / auto-label
- Google Calendar event summaries
- Slack digest
- # ASSUMPTION: there may be additional Make scenarios not listed here — Grayson should enumerate them when Phase 4b begins

### Custom Skills
- **`steap-followup`** — Scans Gmail for booking inquiries and venue replies; drafts follow-ups in Grayson's voice; flags threads older than 5 days without a response
- **`finley-radar`** — Checks Google Calendar for upcoming Finley dates (birthday Dec 20, anniversaries, planned dates); proposes gift/experience ideas respecting tree-nut allergy + no alcohol; writes proposals to `30-Projects/Cleetus/finley/`

### Schwab OAuth
7-day refresh token expiry is a known blocker for the stock briefing → Schwab data flow. Call this out explicitly in the PRD. Briefing executes read-only (no trades, ever).

### Vault Sync
Every vault write commits with a sensible git message. Remote URL TBD — Grayson will provide the private GitHub repo URL.
