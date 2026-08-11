# Phase 4b — Make.com Migration Map

Each Make scenario mapped to its Cleetus equivalent. Complete this before writing Phase 4b code.

| Make Scenario | Trigger | Cleetus Equivalent | Status |
|---|---|---|---|
| Stock briefing (Alpha Vantage → email/Slack) | Daily schedule | `heartbeat.py` 7am briefing — `integrations/alpha_vantage.py` → writes to `10-Daily/YYYY-MM-DD.md` + Slack DM | 🔲 Phase 6 |
| Gmail triage / auto-label | New email webhook | `heartbeat.py` Gmail scan → draft management → `drafts/active/` | 🔲 Phase 6 |
| Google Calendar event summaries | Daily schedule | `heartbeat.py` 7am briefing via `integrations/gcal.py` | 🔲 Phase 6 |
| Slack digest | Daily schedule | `heartbeat.py` Slack history scan → daily note section | 🔲 Phase 6 |
| Schwab OAuth flow | Manual re-auth | Blocked — 7-day refresh token expiry. `integrations/schwab.py` with `schwab-py` library; CLI re-auth command when token < 24h remaining | 🔲 Deferred |

## Make Scenarios To Enumerate (ASSUMPTION)
Before starting Phase 4b, Grayson should log into Make.com and list every active/inactive scenario. The table above covers known scenarios — there may be others.

## Alpha Vantage Integration Note
Free tier: 25 API requests/day. Sufficient for a daily briefing of 3–5 tickers.
- Key endpoint: `GLOBAL_QUOTE` for current price/change
- Key endpoint: `OVERVIEW` for company fundamentals
- API key: add `ALPHA_VANTAGE_KEY=<key>` to `.env`

## Schwab Blocker Detail
- Access token: 30 min expiry
- Refresh token: 7 days
- `schwab-py` auto-refreshes access token while refresh token is valid
- If refresh token goes 7 days without use: full interactive re-auth required
- Mitigation: `heartbeat.py` warns via Slack DM when refresh token < 24h remaining
- All Schwab operations are **read-only** — no trade execution, ever
