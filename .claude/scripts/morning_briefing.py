#!/opt/homebrew/bin/python3
"""
morning_briefing.py — 7am ET daily briefing job.
Writes vault/10-Daily/YYYY-MM-DD.md with: yesterday's recap, today's agenda,
Finley dates within 14 days, STEAP/GLM MEMORY flags, stock briefing.
Then commits vault and posts summary to Slack DM.

Usage: python3 morning_briefing.py [--date YYYY-MM-DD]
"""
import json
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("CLEETUS_ROOT", "/Users/grayson/cleetus")

from dotenv import load_dotenv
load_dotenv(Path(os.environ["CLEETUS_ROOT"]) / ".env")

ET = ZoneInfo("America/New_York")
VAULT = Path(__file__).parents[2] / "vault"


# ─────────────────────────────────────────
# DATA SECTIONS
# ─────────────────────────────────────────

def section_gmail_recap(yesterday: str) -> str:
    try:
        from integrations.gmail import list_unread
        threads = list_unread(
            max_results=10,
            query=f"is:unread after:{yesterday.replace('-', '/')} category:primary"
        )
        if not threads:
            return "_No unread primary emails._"
        lines = [f"- **{t.sender[:40]}** — {t.subject[:60]}" for t in threads[:8]]
        return "\n".join(lines)
    except Exception as e:
        return f"_Gmail unavailable: {e}_"


def section_calendar_today(today: str) -> str:
    try:
        from integrations.gcal import get_today_agenda
        events = get_today_agenda()
        if not events:
            return "_No events today._"
        lines = []
        for e in events:
            label = "All day" if e.all_day else e.start[11:16]
            loc = f" @ {e.location}" if e.location else ""
            lines.append(f"- {label} — **{e.title}**{loc}")
        return "\n".join(lines)
    except Exception as e:
        return f"_Calendar unavailable: {e}_"


def section_yesterday_calendar(yesterday: str) -> str:
    try:
        from integrations.gcal import list_events
        events = list_events(days_ahead=0, days_back=1)
        if not events:
            return "_No events yesterday._"
        lines = [f"- {e.start[11:16]} — {e.title}" for e in events]
        return "\n".join(lines) if lines else "_No events yesterday._"
    except Exception as e:
        return f"_Calendar unavailable: {e}_"


def section_finley_dates() -> str:
    try:
        script = Path(__file__).parents[2] / "skills" / "finley-radar" / "scripts" / "check_finley_dates.py"
        result = subprocess.run(
            ["/opt/homebrew/bin/python3", str(script), "--days", "14"],
            capture_output=True, text=True, timeout=20
        )
        occasions = json.loads(result.stdout) if result.stdout.strip() else []
        if not occasions:
            return "_No Finley dates in the next 14 days._"
        lines = [
            f"- **{o['title']}** — {o['date']} ({o['days_away']} days away)"
            for o in occasions
        ]
        return "\n".join(lines)
    except Exception as e:
        return f"_Finley date check unavailable: {e}_"


def section_memory_flags() -> str:
    memory_path = VAULT / "MEMORY.md"
    if not memory_path.exists():
        return "_MEMORY.md not found._"
    content = memory_path.read_text()
    # Surface lines containing STEAP or GLM
    flagged = [
        line.strip()
        for line in content.splitlines()
        if any(kw in line for kw in ["STEAP", "GLM", "Gringos", "Priority", "⚠"])
        and line.strip() and not line.startswith("#")
    ]
    if not flagged:
        return "_No STEAP/GLM flags in MEMORY.md._"
    return "\n".join(f"- {l}" for l in flagged[:6])


def section_stock_briefing() -> str:
    api_key = os.environ.get("ALPHA_VANTAGE_KEY") or os.environ.get("ALPHA_VANTAGE_API_KEY")
    if not api_key:
        return "_Alpha Vantage key not set (`ALPHA_VANTAGE_KEY` in .env)._"

    # Tickers — Grayson to customize
    tickers = os.environ.get("STOCK_TICKERS", "AAPL,MSFT,SPY").split(",")

    import urllib.request
    lines = []
    for ticker in tickers[:5]:
        ticker = ticker.strip()
        url = (
            f"https://www.alphavantage.co/query"
            f"?function=GLOBAL_QUOTE&symbol={ticker}&apikey={api_key}"
        )
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = json.loads(resp.read())
            quote = data.get("Global Quote", {})
            price = quote.get("05. price", "?")
            change_pct = quote.get("10. change percent", "?")
            lines.append(f"- **{ticker}**: ${price} ({change_pct})")
        except Exception as e:
            lines.append(f"- **{ticker}**: unavailable ({e})")

    return "\n".join(lines) if lines else "_No tickers configured._"


# ─────────────────────────────────────────
# WRITE DAILY NOTE
# ─────────────────────────────────────────

def write_daily_note(target_date: str | None = None) -> Path:
    today = target_date or date.today().isoformat()
    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    now_str = datetime.now(ET).strftime("%I:%M %p ET")

    gmail = section_gmail_recap(yesterday)
    cal_yesterday = section_yesterday_calendar(yesterday)
    cal_today = section_calendar_today(today)
    finley = section_finley_dates()
    memory = section_memory_flags()
    stocks = section_stock_briefing()

    note = f"""# {today}

## Morning Briefing — {now_str}

### Yesterday's Recap

#### Gmail
{gmail}

#### Calendar (yesterday)
{cal_yesterday}

### Today's Agenda
{cal_today}

### Finley — Upcoming Dates
{finley}

### STEAP / GLM Flags
{memory}

### Stock Briefing
{stocks}

---
_[Logged items below this line]_
"""

    daily_dir = VAULT / "10-Daily"
    daily_dir.mkdir(parents=True, exist_ok=True)
    note_path = daily_dir / f"{today}.md"

    # Append if file exists (session logs may have already written to it)
    if note_path.exists():
        existing = note_path.read_text()
        if "Morning Briefing" not in existing:
            note_path.write_text(note + "\n" + existing)
        else:
            print(f"Morning briefing already present in {note_path.name}. Skipping.")
            return note_path
    else:
        note_path.write_text(note)

    return note_path


# ─────────────────────────────────────────
# COMMIT + NOTIFY
# ─────────────────────────────────────────

def commit_vault(today: str):
    try:
        subprocess.run(["git", "-C", str(VAULT), "add", "10-Daily/"], capture_output=True)
        subprocess.run(
            ["git", "-C", str(VAULT), "commit", "-m", f"daily: {today} morning briefing"],
            capture_output=True
        )
    except Exception:
        pass


def notify_slack_briefing(today: str, note_path: Path):
    try:
        from integrations.slack_integration import send_to_grayson
        send_to_grayson(
            f"☀️ Good morning — your briefing for *{today}* is ready.\n"
            f"Vault: `10-Daily/{note_path.name}`"
        )
    except Exception as e:
        print(f"Slack notify failed: {e}")


# ─────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────

def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--date", type=str, default=None, help="YYYY-MM-DD (default: today)")
    args = p.parse_args()

    target = args.date or date.today().isoformat()
    print(f"Writing morning briefing for {target}…")

    note_path = write_daily_note(target)
    commit_vault(target)
    notify_slack_briefing(target, note_path)

    print(f"Done: {note_path}")


if __name__ == "__main__":
    main()
