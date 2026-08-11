# Cleetus — Setup Guide

## Prerequisites completed
- [x] Homebrew Python 3.14 at `/opt/homebrew/bin/python3`
- [x] Google OAuth credentials at `/Users/grayson/cleetus/credentials.json`
- [x] Google token at `/Users/grayson/cleetus/token.json`
- [x] `.env` at `/Users/grayson/cleetus/.env`

## One-time setup steps

### 1. Install dependencies
```bash
/opt/homebrew/bin/python3 -m pip install -r requirements.txt --break-system-packages
```

### 2. Add missing .env keys

Open `/Users/grayson/cleetus/.env` and add:

```bash
# Slack — create app at api.slack.com/apps
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Alpha Vantage — free tier sufficient
ALPHA_VANTAGE_KEY=your_key_here

# Tickers for morning briefing (comma-separated)
STOCK_TICKERS=AAPL,SPY,QQQ

# Vault remote (after creating GitHub repo)
# Used by heartbeat commit push — set after step 4
# VAULT_REMOTE=git@github.com:graysonpope007/cleetus-vault.git
```

### 3. Create Slack App

1. Go to api.slack.com/apps → Create New App → From scratch
2. Name: "Cleetus" | Workspace: your workspace
3. **Socket Mode** → Enable Socket Mode → Generate App Token with `connections:write` scope → copy as `SLACK_APP_TOKEN`
4. **OAuth & Permissions** → Bot Token Scopes: `im:read im:write chat:write channels:read groups:read mpim:read`
5. **Install to Workspace** → copy Bot Token as `SLACK_BOT_TOKEN`
6. **Event Subscriptions** → Enable → Subscribe to bot events: `message.im`

### 4. Set up vault remote

```bash
# Create private repo at github.com/new (name: cleetus-vault)
cd vault
git remote add origin git@github.com:graysonpope007/cleetus-vault.git
git push -u origin main
```

### 5. Add Alpha Vantage key

Get a free key at alphavantage.co/support/#api-key, add to `.env` as `ALPHA_VANTAGE_KEY`.

### 6. Add voice samples for steap-followup

Edit `.claude/skills/steap-followup/references/booking-voice-samples.md`  
Paste 3–5 real STEAP booking follow-up emails.

### 7. Register launchd jobs

```bash
bash .claude/launchd/install.sh
```

This loads:
- `com.cleetus.briefing` — 7am ET daily briefing
- `com.cleetus.heartbeat` — every 30 minutes, 7am–10pm ET
- `com.cleetus.chat` — Slack chat server (always-on)

### 8. Verify everything is running

```bash
# Check registry
CLEETUS_ROOT=/Users/grayson/cleetus /opt/homebrew/bin/python3 .claude/scripts/query.py registry

# Run briefing manually
CLEETUS_ROOT=/Users/grayson/cleetus /opt/homebrew/bin/python3 .claude/scripts/morning_briefing.py

# Run heartbeat once
CLEETUS_ROOT=/Users/grayson/cleetus /opt/homebrew/bin/python3 .claude/scripts/heartbeat.py --force

# Re-index vault
cd .claude/scripts && CLEETUS_ROOT=/Users/grayson/cleetus /opt/homebrew/bin/python3 memory_index.py
```

## Daily operation

| Job | Schedule | What it does |
|-----|----------|--------------|
| `morning_briefing.py` | 7am ET | Writes `vault/10-Daily/YYYY-MM-DD.md`, pings Slack |
| `heartbeat.py` | Every 30 min | Checks Gmail/Calendar/Slack/STEAP/Finley, notifies on changes |
| `chat/server.py` | Always on | Listens for Slack DMs, runs Claude reasoning loop |

## Troubleshooting

- **Google auth errors**: Re-run `python3 /Users/grayson/cleetus/auth.py` to refresh `token.json`
- **Slack "not configured"**: Check `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `.env`
- **RAG returns 0 results**: Run `memory_index.py --rebuild` to wipe and re-index vault
- **launchd not firing**: Check logs in `.claude/data/*.log` and `.claude/data/*.err`
- **Schwab token expired**: Re-run the Schwab OAuth flow; token expires every 7 days of inactivity

## Extending Cleetus

- **New chat surface** (iMessage, iOS Shortcut): implement `PlatformAdapter` in `.claude/chat/adapters/`, wire to `core.handle_message()`. No changes to `core.py`.
- **New integration**: copy `.claude/scripts/integrations/gmail.py` as a template, add to `registry.py`, add subcommand to `query.py`.
- **New skill**: create `.claude/skills/<name>/SKILL.md` following the existing skill format. Claude Code picks it up automatically.
