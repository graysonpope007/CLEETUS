#!/opt/homebrew/bin/python3
"""
heartbeat.py — Cleetus heartbeat. Runs every 30 minutes, 7am–10pm ET.
Python gathers data → diffs against last state → Claude reasons → Slack notifies.
Cost: ~$0.05/run (pre-gathered data, not raw API calls to Claude).

Usage: python3 heartbeat.py [--force]  (--force skips the diff check)
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("CLEETUS_ROOT", "/Users/grayson/cleetus")

from dotenv import load_dotenv
load_dotenv(Path(os.environ["CLEETUS_ROOT"]) / ".env")

ET = ZoneInfo("America/New_York")
VAULT = Path(__file__).parents[2] / "vault"
STATE_PATH = Path(__file__).parent.parent / "data" / "state" / "heartbeat-state.json"
GRAYSON_DM = "D0AMJ560C2W"
ACTIVE_HOURS = (7, 22)  # 7am–10pm ET


# ─────────────────────────────────────────
# ACTIVE HOURS CHECK
# ─────────────────────────────────────────

def is_active_hours() -> bool:
    now_et = datetime.now(ET)
    return ACTIVE_HOURS[0] <= now_et.hour < ACTIVE_HOURS[1]


# ─────────────────────────────────────────
# DATA GATHERING
# ─────────────────────────────────────────

def gather_gmail() -> dict:
    try:
        from integrations.gmail import list_unread
        threads = list_unread(max_results=20)
        return {
            "unread_count": len(threads),
            "subjects": [t.subject[:60] for t in threads[:5]],
        }
    except Exception as e:
        return {"error": str(e)}


def gather_calendar() -> dict:
    try:
        from integrations.gcal import get_upcoming
        events = get_upcoming(days=2)
        today = datetime.now(ET).date().isoformat()
        return {
            "event_count": len(events),
            "today_events": [
                {"title": e.title, "start": e.start[11:16]}
                for e in events if e.start.startswith(today)
            ],
        }
    except Exception as e:
        return {"error": str(e)}


def gather_slack() -> dict:
    try:
        from integrations.slack_integration import get_dm_history
        msgs = get_dm_history(limit=10)
        return {"recent_message_count": len(msgs)}
    except Exception as e:
        return {"unavailable": str(e)}


def gather_finley_dates() -> dict:
    try:
        script = Path(__file__).parents[2] / "skills" / "finley-radar" / "scripts" / "check_finley_dates.py"
        result = subprocess.run(
            ["/opt/homebrew/bin/python3", str(script), "--days", "14"],
            capture_output=True, text=True
        )
        occasions = json.loads(result.stdout) if result.stdout.strip() else []
        return {"upcoming": occasions}
    except Exception as e:
        return {"error": str(e)}


def gather_drafts() -> dict:
    active_dir = VAULT / "drafts" / "active"
    expired_dir = VAULT / "drafts" / "expired"
    now = datetime.now(ET)
    expired = []
    active = []

    for f in active_dir.glob("*.md"):
        age_hours = (now.timestamp() - f.stat().st_mtime) / 3600
        if age_hours > 24:
            expired.append(f.name)
        else:
            active.append(f.name)

    # Move expired drafts
    for name in expired:
        src = active_dir / name
        dst = expired_dir / name
        src.rename(dst)

    return {"active": active, "expired_moved": expired}


def gather_stale_steap() -> dict:
    try:
        script = Path(__file__).parents[2] / "skills" / "steap-followup" / "scripts" / "flag_stale_threads.py"
        result = subprocess.run(
            ["/opt/homebrew/bin/python3", str(script), "--days", "5", "--max", "15"],
            capture_output=True, text=True, timeout=30
        )
        stale = json.loads(result.stdout) if result.stdout.strip() else []
        return {"stale_count": len(stale), "threads": stale[:3]}
    except Exception as e:
        return {"error": str(e)}


def gather_snapshot() -> dict:
    return {
        "ts": datetime.now(ET).isoformat(),
        "gmail": gather_gmail(),
        "calendar": gather_calendar(),
        "slack": gather_slack(),
        "finley_dates": gather_finley_dates(),
        "drafts": gather_drafts(),
        "steap_stale": gather_stale_steap(),
    }


# ─────────────────────────────────────────
# STATE DIFFING
# ─────────────────────────────────────────

def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            return {}
    return {}


def save_state(snapshot: dict):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(snapshot, indent=2))


def has_changes(old: dict, new: dict) -> bool:
    if not old:
        return True
    old_gmail = old.get("gmail", {}).get("unread_count", 0)
    new_gmail = new.get("gmail", {}).get("unread_count", 0)
    if new_gmail != old_gmail:
        return True
    old_cal = old.get("calendar", {}).get("event_count", 0)
    new_cal = new.get("calendar", {}).get("event_count", 0)
    if new_cal != old_cal:
        return True
    new_finley = new.get("finley_dates", {}).get("upcoming", [])
    if new_finley:
        return True
    new_stale = new.get("steap_stale", {}).get("stale_count", 0)
    if new_stale > 0:
        return True
    return False


# ─────────────────────────────────────────
# REASONING (Claude)
# ─────────────────────────────────────────

def reason_over_snapshot(snapshot: dict) -> str:
    try:
        import anthropic
        from dotenv import load_dotenv
        load_dotenv(Path(os.environ["CLEETUS_ROOT"]) / ".env")

        memory_context = _load_memory()
        now_et = datetime.now(ET).strftime("%A, %B %d at %I:%M %p ET")

        prompt = f"""You are Cleetus — Grayson's AI second brain. Current time: {now_et}

Here is the current system snapshot:
{json.dumps(snapshot, indent=2)}

Based on this snapshot, write a brief (3–5 sentence) heartbeat summary for Grayson. Cover:
- Anything that needs his attention (unread emails, stale STEAP threads, upcoming Finley dates)
- Today's calendar if anything is coming up
- Any drafts ready for his review

Be concise and direct. Paragraph form. No bullet walls unless there are 3+ items that benefit from a list.
Never suggest alcohol. Never reference tree nuts in a positive context."""

        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            system=memory_context,
            messages=[{"role": "user", "content": prompt}]
        )
        return response.content[0].text.strip()
    except Exception as e:
        return f"Heartbeat gathered data but reasoning failed: {e}"


def _load_memory() -> str:
    parts = []
    for fname in ["SOUL.md", "USER.md", "MEMORY.md"]:
        p = VAULT / fname
        if p.exists():
            parts.append(p.read_text()[:1500])
    return "\n\n---\n\n".join(parts)


# ─────────────────────────────────────────
# NOTIFY
# ─────────────────────────────────────────

def notify_slack(text: str):
    try:
        from integrations.slack_integration import send_to_grayson
        send_to_grayson(f"🤖 *Cleetus heartbeat*\n{text}")
    except Exception as e:
        notify_macos(f"Cleetus: {text[:100]}")


def notify_macos(text: str):
    safe = text.replace('"', "'").replace("\\", "")[:200]
    script = f'display notification "{safe}" with title "Cleetus"'
    subprocess.run(["osascript", "-e", script], capture_output=True)


# ─────────────────────────────────────────
# HABITS NUDGE
# ─────────────────────────────────────────

def check_habits_nudge() -> str | None:
    now_et = datetime.now(ET)
    if now_et.hour < 19:  # Only nudge after 7pm
        return None
    habits_path = VAULT / "HABITS.md"
    if not habits_path.exists():
        return None
    content = habits_path.read_text()
    unchecked = [
        line.strip()[6:]  # strip "- [ ] "
        for line in content.splitlines()
        if line.strip().startswith("- [ ]")
    ]
    if unchecked:
        items = ", ".join(unchecked[:3])
        return f"Late-day check: {len(unchecked)} habit pillar(s) still unchecked — {items}."
    return None


# ─────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Skip diff, always run")
    args = parser.parse_args()

    if not is_active_hours() and not args.force:
        print("Outside active hours (7am–10pm ET). Exiting.")
        return

    snapshot = gather_snapshot()
    old_state = load_state()

    if not args.force and not has_changes(old_state, snapshot):
        print("No significant changes. Silent exit.")
        save_state(snapshot)
        return

    save_state(snapshot)

    summary = reason_over_snapshot(snapshot)

    habits_nudge = check_habits_nudge()
    if habits_nudge:
        summary += f"\n\n{habits_nudge}"

    print(summary)
    notify_slack(summary)


if __name__ == "__main__":
    main()
