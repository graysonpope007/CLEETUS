# Grayson's Second Brain — Product Requirements Document

**Generated:** 2026-04-23  
**Summary:** Cleetus is a locally-run, Advisor-mode AI second brain that handles STEAP booking follow-ups, GLM artist/show management, Finley relationship proactivity, stock briefings, and school capture — replacing Make.com entirely and shipping through Slack DM first.

---

## Phase Table

| Phase | Name | Complexity | Depends On |
|-------|------|------------|------------|
| 1 | Foundation — Memory Layer | Low | — |
| 2 | Hooks — Context Persistence | Medium | 1 |
| 3 | Memory Search — Hybrid RAG | Medium | 1 |
| 4 | Integrations — Gmail + Calendar + Slack + Drive | Medium × 4 | 1 |
| 4b | Make Migration | Low | 4 |
| 5 | Skills — steap-followup, finley-radar, vault-structure | Low–Medium | 4 |
| 6 | Proactive Systems — Heartbeat + 7am Briefing | High | 2, 3, 4, 5 |
| 7 | Chat Interface — Slack DM + Adapter Pattern | High | 4, 6 |
| 8 | Security Hardening | Medium | all |
| 9 | Deployment — launchd + VPS path | Medium | all |

---

## Phase 1: Foundation — Memory Layer

**What to build:** Initialize the Obsidian vault as the source of truth. The vault already exists as a git repo — this phase finalizes the file schema and seeds the core memory files.

**Key files:**

```
vault/
  SOUL.md          ✅ seeded
  USER.md          ✅ seeded
  MEMORY.md        ✅ seeded
  HABITS.md        create
  HEARTBEAT.md     create
  00-Inbox/
  10-Daily/        YYYY-MM-DD.md generated here
  20-People/
    Finley.md      create — full profile, allergy + no-alcohol at top
  30-Projects/
    GLM/
    STEAP/
    Cleetus/
      finley/      finley-radar proposals land here
    The-Gringos/
  40-Areas/
    Label-Ops/
    Booking/
    School/
    Health/
    Finance/
  50-Resources/
  60-Archive/
  drafts/
    active/        heartbeat-generated drafts
    sent/          completed drafts for voice-matching RAG
    expired/       drafts older than 24h, not sent
```

**HABITS.md pillars to seed:**
1. GLM/STEAP progress (at least one booking or artist action)
2. Finley (intentional attention — date idea, message, plan)
3. School (one assignment logged or studied)
4. Health
5. Personal (open)

**HEARTBEAT.md:** List of what the heartbeat monitors — Gmail unread + flagged, Calendar today + tomorrow, Slack DMs, STEAP booking threads, Finley upcoming dates, MEMORY.md flags.

**20-People/Finley.md:** Full profile. Tree-nut allergy and no-alcohol must appear in the first 3 lines, in bold.

**Dependencies:** None  
**Complexity:** Low  
**Personalization:** GLM roster, STEAP bandmates, Finley profile, Evans GA hometown all in USER.md (already seeded).

---

## Phase 2: Hooks — Context Persistence

**What to build:** Three lifecycle hooks that inject memory into every Claude Code session and flush context back to the vault on exit or compaction.

**Key files:**
```
.claude/hooks/
  session-start-context.py   reads SOUL.md + USER.md + MEMORY.md + last 3 daily logs
  pre-compact-flush.py       extracts key facts from JSONL transcript → appends to today's daily log
  session-end-flush.py       saves session summary to daily log on exit
.claude/settings.json        hook configuration
```

**settings.json hook config pattern:**
```json
{
  "hooks": {
    "SessionStart": [{ "command": "python .claude/hooks/session-start-context.py" }],
    "PreCompact":   [{ "command": "python .claude/hooks/pre-compact-flush.py" }],
    "SessionEnd":   [{ "command": "python .claude/hooks/session-end-flush.py" }]
  }
}
```

**session-start-context.py logic:**
1. Read `vault/SOUL.md`, `vault/USER.md`, `vault/MEMORY.md`
2. Read last 3 `vault/10-Daily/*.md` files (sorted by name)
3. Print all to stdout — Claude Code injects this into context as a system message

**Dependencies:** Phase 1  
**Complexity:** Medium  
**Personalization:** Start context always loads Finley allergy rules + no-alcohol constraint from SOUL.md.

---

## Phase 3: Memory Search — Hybrid RAG

**What to build:** Local hybrid search over the vault — semantic (vector) + keyword (FTS5) — so Cleetus can retrieve relevant notes without loading the entire vault into context.

**Key files:**
```
.claude/scripts/
  db.py            SQLite abstraction (sqlite-vec for vectors, FTS5 for keywords)
  embeddings.py    FastEmbed wrapper — all-MiniLM-L6-v2 (384-dim ONNX)
  memory_index.py  chunker (≈400 tokens, 50-token overlap) + incremental indexer
  memory_search.py CLI: memory_search.py "query" [--path-prefix drafts/sent]
.claude/data/
  memory.db        SQLite database
```

**Install:**
```bash
pip install fastembed sqlite-vec
```

**FastEmbed usage:**
```python
from fastembed import TextEmbedding
model = TextEmbedding("sentence-transformers/all-MiniLM-L6-v2")
embeddings = list(model.embed(["text1", "text2"]))  # batch
```

**Hybrid merge:** score = 0.7 × vector_similarity + 0.3 × bm25_score  
**Incremental:** track file mtimes; only re-index changed files.

**`--path-prefix` flag:** Used by `finley-radar` and `steap-followup` to scope search to `drafts/sent/` for voice-matching.

**Dependencies:** Phase 1  
**Complexity:** Medium

---

## Phase 4: Integrations

### 4a-i: Gmail

**Package:** `google-api-python-client google-auth-httplib2 google-auth-oauthlib`

**OAuth2 scopes:**
```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
```

**Gotcha — Custom Domain / External App:** Set OAuth consent screen User Type to **External** (not Internal) since GLM uses a custom domain. This may require Google verification if the app goes beyond 100 test users — for a personal app, stay in test mode permanently.

**Existing credentials:** `credentials.json` + `token.json` already live at `/Users/grayson/cleetus/`. Phase 4 integrates these into the integration module pattern rather than re-creating auth.

**Key files:**
```
.claude/scripts/integrations/
  gmail.py           Auth + query functions (list_unread, list_threads, send_draft)
  gmail_auth.py      OAuth2 flow — reuse existing token.json
.claude/scripts/
  query.py           Unified CLI: query.py gmail list [--label INBOX] [--query "from:venue"]
```

**Key Gmail API methods:**
- `service.users().messages().list(userId='me', q='is:unread')` — list unread
- `service.users().threads().get(userId='me', id=thread_id)` — full thread
- `service.users().messages().send(userId='me', body=msg)` — send (Advisor: only called after explicit confirm)

**Rate limits:** 250 quota units/second; batch requests up to 100 calls.

---

### 4a-ii: Google Calendar

**Scopes:** `https://www.googleapis.com/auth/calendar.readonly` (read-only is sufficient for briefing + Finley date checks)

**Shared token:** Same OAuth flow and `token.json` as Gmail. Add calendar scope to the existing scopes list.

**Key files:**
```
.claude/scripts/integrations/
  gcal.py            list_events(days_ahead=14), get_today_agenda()
```

**Key Calendar API call:**
```python
service.events().list(
    calendarId='primary',
    timeMin=now_iso,
    timeMax=(now + timedelta(days=14)).isoformat() + 'Z',
    singleEvents=True,
    orderBy='startTime'
).execute()
```

**Used by:** 7am briefing (today's agenda), `finley-radar` (Finley dates within 14 days).

---

### 4a-iii: Slack

**Package:** `pip install slack-sdk`

**Auth tokens needed:**
- **Bot Token** (`xoxb-…`): scopes `im:read im:write chat:write channels:read groups:read mpim:read`
- **App Token** (`xapp-…`): `connections:write` scope — required for Socket Mode

**Socket Mode setup:**
```python
from slack_sdk.socket_mode import SocketModeClient
from slack_sdk import WebClient

web_client = WebClient(token=os.environ["SLACK_BOT_TOKEN"])
socket_client = SocketModeClient(
    app_token=os.environ["SLACK_APP_TOKEN"],
    web_client=web_client
)
```

**Socket Mode note:** Outbound WebSocket — no public URL needed. Works for personal/internal bots on all Slack plan tiers. Ideal for Cleetus running locally.

**DM to Grayson:** Always send to channel `D0AMJ560C2W` (already known). All Cleetus-to-Grayson notifications go here.

**Key files:**
```
.claude/scripts/integrations/
  slack_integration.py    send_dm(text), list_unread_dms(), get_channel_history()
```

---

### 4a-iv: Google Drive

**Scope:** `https://www.googleapis.com/auth/drive.readonly`  
**Shared OAuth token** with Gmail + Calendar.

**Key files:**
```
.claude/scripts/integrations/
  gdrive.py    search_files(query), get_file_content(file_id)
```

**Used by:** GLM contract/financial lookups, artist asset retrieval.

---

### 4b: Make.com Migration

Map each known Make scenario to a Cleetus equivalent:

| Make Scenario | Cleetus Equivalent | Phase |
|---------------|--------------------|-------|
| Stock briefing (Alpha Vantage → email/Slack) | Heartbeat morning briefing — Alpha Vantage `OVERVIEW` + `GLOBAL_QUOTE` endpoints → written to `10-Daily/YYYY-MM-DD.md` + Slack DM | 6 |
| Gmail triage / auto-label | `gmail.py` + heartbeat scan + draft management system | 4, 6 |
| Google Calendar event summaries | `gcal.py` + 7am briefing job | 6 |
| Slack digest | Heartbeat Slack history scan → summary in daily note | 6 |
| Schwab OAuth flow | Blocked — 7-day refresh token expiry (see below) | Deferred |

**# ASSUMPTION:** There may be additional Make scenarios not listed here. Enumerate all remaining scenarios at the start of Phase 4b.

**Schwab OAuth blocker:** Schwab access tokens expire in 30 minutes; refresh tokens expire in 7 days with no extension. If the refresh token goes unused for 7 days, the full interactive OAuth flow must restart. Workaround: `schwab-py` library auto-refreshes silently while the token is active, rolling the 7-day window — but a 7-day gap in usage still forces re-auth. For now: Schwab briefing is **read-only** (no trades, ever), and the re-auth flow should be a simple CLI command that opens the browser. Flag token expiry via Slack DM when within 24 hours.

**Dependencies:** Phase 4a  
**Complexity:** Low  

---

## Phase 5: Skills

### 5a: `vault-structure`

Teaches the agent the vault folder conventions. Invoked on any vault write to ensure correct placement.

```
.claude/skills/vault-structure/
  SKILL.md          file placement rules, naming conventions, git commit format
```

---

### 5b: `steap-followup`

**What it does:** Scans Gmail for STEAP booking inquiries and venue replies, drafts follow-ups in Grayson's voice, flags threads older than 5 days without a response.

```
.claude/skills/steap-followup/
  SKILL.md
  scripts/
    scan_booking_threads.py    Gmail query: "STEAP OR Sweet Tea Pedigree booking venue"
    flag_stale_threads.py      threads with last message > 5 days and no Grayson reply
  references/
    booking-voice-samples.md   # ASSUMPTION: Grayson should add 3-5 real follow-up examples here for voice calibration
```

**Draft output:** `vault/drafts/active/YYYY-MM-DD_email_<venue-slug>.md`  
**Voice-matching:** RAG over `vault/drafts/sent/` via `memory_search.py --path-prefix drafts/sent`

---

### 5c: `finley-radar`

**What it does:** Checks Google Calendar for Finley dates within 14 days, proposes gift/experience ideas respecting tree-nut allergy and no-alcohol constraint, writes proposals to `vault/30-Projects/Cleetus/finley/`.

```
.claude/skills/finley-radar/
  SKILL.md
  scripts/
    check_finley_dates.py      gcal.py + hardcoded Dec 20 birthday check
    propose_ideas.py           generates allergy-safe, alcohol-free ideas via Claude Agent SDK
  references/
    finley-profile.md          mirrors vault/20-People/Finley.md
    allergy-constraints.md     explicit tree-nut list + no-alcohol rule
```

**SOUL.md constraint applies:** Every single proposal must be verified against the tree-nut list and alcohol rule before writing to vault. This is non-negotiable.

**Proposal file format:** `vault/30-Projects/Cleetus/finley/YYYY-MM-DD_<occasion>.md`

---

**Dependencies:** Phases 1, 3, 4  
**Complexity:** Low–Medium

---

## Phase 6: Proactive Systems — Heartbeat + 7am Briefing

**What to build:** Two scheduled scripts — a 30-minute heartbeat for continuous monitoring and a 7am ET morning briefing job that writes the daily note.

### 6a: Heartbeat (`heartbeat.py`)

```
.claude/scripts/
  heartbeat.py          main loop — gather → diff → reason → notify
  heartbeat_state.json  snapshot of last-seen state (Gmail unread count, Slack DM IDs, etc.)
```

**Run schedule:** Every 30 minutes, 7am–10pm ET (Phase 9 wires this to launchd).

**Heartbeat loop:**
1. Python gathers data from all integrations (Gmail, Calendar, Slack, MEMORY.md) — no Claude yet
2. `build_snapshot()` → `diff_snapshot()` — only proceed if something changed
3. Claude Agent SDK reasons over pre-loaded snapshot
4. Notify via Slack DM D0AMJ560C2W and/or Twilio (no-change = silent)

**Cost:** ~$0.05/run (Python pre-gathers; Claude reasons over structured data, not raw API calls)

**Advisor behaviors triggered by heartbeat:**
- Scan `vault/drafts/active/` for drafts older than 24h → move to `expired/`
- HABITS.md: suggest specific actions for unchecked pillars (late-day nudge after 7pm)
- `finley-radar`: surface any Finley date within 14 days
- `steap-followup`: flag stale booking threads
- Schwab token expiry: warn 24h before the 7-day window closes

### 6b: 7am Morning Briefing Job

**Run time:** 7:00am ET daily.

**Output file:** `vault/10-Daily/YYYY-MM-DD.md`

**File structure:**
```markdown
# YYYY-MM-DD

## Morning Briefing — 7am ET

### Yesterday's Recap
[Gmail: unread/flagged threads from yesterday]
[Calendar: completed events from yesterday]
[Slack: DM summary from yesterday]

### Today's Agenda
[Calendar events for today — time, title, location]

### Finley — Upcoming Dates
[Any Finley dates within 14 days — birthday Dec 20, anniversaries, planned events]
[Empty section if none within window]

### STEAP / GLM Flags
[Any MEMORY.md items flagged as active for STEAP or GLM]

### Stock Briefing
[Alpha Vantage: 3-5 tracked tickers — last close, day change %, brief note]
[Schwab token status — days until refresh token expires if < 3 days]

---
_[Logged items below this line]_
```

**Vault commit:** After writing the daily note, commit: `git -C vault add 10-Daily/ && git -C vault commit -m "daily: YYYY-MM-DD morning briefing"`

**Dependencies:** Phases 1, 2, 3, 4, 5  
**Complexity:** High

---

## Phase 7: Chat Interface — Slack DM + Adapter Pattern

**What to build:** A persistent Slack bot that receives DMs to gpope04 and routes them through the Claude Agent SDK reasoning loop. Architecture uses a `PlatformAdapter` protocol so iMessage and iOS Shortcut can be added later without rewriting the core.

### Architecture

```
.claude/chat/
  server.py              Entry point — starts SlackAdapter via Socket Mode
  core.py                Message router: adapter.receive() → reasoning loop → adapter.send()
  session_store.py       SQLite at .claude/data/chat.db — thread_id → conversation history
  adapters/
    base.py              PlatformAdapter protocol: receive(), send(), thread_id()
    slack_adapter.py     Socket Mode client — listens to D0AMJ560C2W DMs
    imessage_adapter.py  # FUTURE — stub interface only, not implemented in Phase 7
    shortcut_adapter.py  # FUTURE — HTTP endpoint stub for iOS Shortcut, not implemented
```

**SlackAdapter:**
- Socket Mode (`xapp-` + `xoxb-` tokens)
- `receive()`: listen for `message` events in DM D0AMJ560C2W
- `send(text, thread_ts)`: post reply in same thread
- `thread_id()`: return `channel_id + ts` as persistent session key

**core.py reasoning loop:**
```python
async def handle_message(adapter, message):
    session_id = adapter.thread_id(message)
    history = session_store.get(session_id)
    
    async for event in query(
        prompt=message.text,
        options=ClaudeAgentOptions(
            system_prompt={"type": "custom", "text": load_soul_and_memory()},
            allowed_tools=["Read", "Edit", "Bash"],  # scoped — no Send without confirm
        ),
        resume=history.claude_session_id if history else None
    ):
        if isinstance(event, ResultMessage):
            adapter.send(event.result, message.thread_ts)
            session_store.save(session_id, event.session_id)
```

**Adding iMessage later:** Create `imessage_adapter.py` implementing `PlatformAdapter`. No changes to `core.py`.

**Dependencies:** Phases 4a-iii (Slack), 6 (heartbeat for context)  
**Complexity:** High

---

## Phase 8: Security Hardening

**What to build:** Three-layer defense against prompt injection and accidental outbound actions.

### Layer 1 — Sanitize (`sanitize.py`)
- Pattern detection (jailbreak phrases, override attempts)
- Markdown escaping for all external text (Gmail subjects, Slack messages) before passing to Claude
- XML trust boundaries: wrap external content in `<external_content>` tags with `trust="untrusted"`

### Layer 2 — Guardrails (`shared.py`)
Deterministic pre-check before any tool call:
```python
BLOCKED_PATTERNS = [
    r"git push",
    r"git reset --hard",
    r"send.*email",           # only allowed after explicit confirm
    r"slack.*send.*(?!D0AMJ560C2W)",  # only allow DM to Grayson
    r"schwab.*order|schwab.*trade",
    r"rm -rf",
    r"chmod.*777",
]
```

### Layer 3 — API Key Isolation
- `.env` holds all tokens: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `GOOGLE_CREDENTIALS_PATH`, `ALPHA_VANTAGE_KEY`, `SCHWAB_CLIENT_ID`, `TWILIO_AUTH_TOKEN`
- Python integration modules load tokens from `.env` — Claude never sees raw tokens
- Vault and git repo: confirm `.gitignore` excludes `.env`, `credentials.json`, `token.json`

**Advisor confirmation pattern:** Any outbound send (Gmail, Slack to non-Grayson, Twilio to non-Grayson) routes through:
```python
def confirm_send(draft_path, recipient):
    # post draft preview to Slack DM D0AMJ560C2W
    # wait for "send it" or "cancel" reply
    # only execute on "send it"
```

**Dependencies:** All phases  
**Complexity:** Medium

---

## Phase 9: Deployment — launchd + VPS Path

### 9a: macOS Local (Current)

**Scheduler:** launchd plists in `~/Library/LaunchAgents/`

```xml
<!-- com.cleetus.heartbeat.plist -->
<key>StartInterval</key><integer>1800</integer>   <!-- 30 min -->

<!-- com.cleetus.briefing.plist -->
<key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>

<!-- com.cleetus.chat.plist -->
<key>RunAtLoad</key><true/>   <!-- Slack chat server runs continuously -->
```

**Install:**
```bash
launchctl load ~/Library/LaunchAgents/com.cleetus.heartbeat.plist
launchctl load ~/Library/LaunchAgents/com.cleetus.briefing.plist
launchctl load ~/Library/LaunchAgents/com.cleetus.chat.plist
```

**Vault sync:** `git -C vault push origin main` at end of every heartbeat run (once remote URL is set).

### 9b: VPS Path (Future)

Once core + heartbeat are stable:
- Linux VPS (e.g., DigitalOcean $6/mo droplet)
- Migrate SQLite → Postgres + pgvector
- launchd → systemd timers
- Vault sync: git pull at start of heartbeat, git push at end
- Headless OAuth: store `token.json` on VPS; re-auth via SSH tunnel to local browser when Schwab token expires

**Cost estimate:**
- Claude API: ~$20–50/month at Advisor frequency
- VPS: ~$6/month (future)
- Obsidian: free
- Alpha Vantage free tier: 25 API calls/day (sufficient for daily briefing)
- **Total now:** ~$20–50/month  
- **Total with VPS:** ~$26–56/month

**Dependencies:** All phases  
**Complexity:** Medium

---

## Recommended Build Order

```
Phase 1 (vault) → Phase 2 (hooks) → Phase 3 (RAG) → Phase 4a-i (Gmail)
→ Phase 4a-ii (Calendar) → Phase 4a-iii (Slack) → Phase 4a-iv (Drive)
→ Phase 4b (Make migration)
→ Phase 5 (skills) [can parallel with Phase 4b]
→ Phase 6 (heartbeat + briefing)
→ Phase 7 (chat)
→ Phase 8 (security — harden throughout, formalize here)
→ Phase 9 (deployment)
```

Phases 3 and 4a-i can begin in parallel once Phase 1 is done.

---

## All `# ASSUMPTION:` Flags

1. **Phase 2, 4b** — There may be Make.com scenarios beyond the four listed (stock briefing, Gmail triage, Calendar summaries, Slack digest). Grayson should enumerate all active scenarios before Phase 4b begins.
2. **Phase 5b** — `booking-voice-samples.md` is empty. Grayson should add 3–5 real STEAP follow-up emails as voice calibration samples before running `steap-followup`.
3. **Phase 1** — No dedicated task management tool (Asana, Linear, etc.) is in the stack. Tasks flow through Gmail/Slack/vault notes.
4. **Phase 4** — GLM artist and venue relationships are tracked in vault notes, not a dedicated CRM. If a CRM is added later, it's a new integration module — no core rewrite.
5. **Phase 6** — Alpha Vantage free tier (25 calls/day) is sufficient for a daily briefing of 3–5 tickers. If more tickers are needed, upgrade to a paid tier (~$50/month).
6. **Phase 9b** — VPS migration assumes Grayson is comfortable with SSH and Linux CLI. If not, macOS-local deployment is indefinitely stable.

---

## What I Need From You (in order for Phase 1)

See the "What I need from you" section in the Step 5 report.

---

_This PRD was generated from your requirements. Revisit and update as Cleetus evolves._
