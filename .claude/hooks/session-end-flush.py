#!/usr/bin/env python3
"""
SessionEnd hook — on session exit, write a brief summary entry to today's daily log.
Also stages and commits any vault changes made during the session.
"""
import sys
import json
import subprocess
from pathlib import Path
from datetime import datetime

VAULT = Path(__file__).parent.parent.parent / "vault"
DAILY_DIR = VAULT / "10-Daily"


def today_log_path() -> Path:
    today = datetime.now().strftime("%Y-%m-%d")
    return DAILY_DIR / f"{today}.md"


def append_session_end(transcript: list[dict]):
    DAILY_DIR.mkdir(parents=True, exist_ok=True)
    path = today_log_path()
    timestamp = datetime.now().strftime("%H:%M")

    # Count turns as a lightweight proxy for session depth
    user_turns = sum(1 for m in transcript if m.get("role") == "user")

    # Extract last user message as session topic hint
    last_user = ""
    for msg in reversed(transcript):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
            last_user = content.strip()[:120]
            break

    entry = (
        f"\n\n## Session end — {timestamp} ET\n"
        f"- Turns: {user_turns}\n"
        f"- Last topic: {last_user or '(unknown)'}\n"
    )

    with open(path, "a", encoding="utf-8") as f:
        f.write(entry)


def commit_vault():
    try:
        result = subprocess.run(
            ["git", "-C", str(VAULT), "status", "--porcelain"],
            capture_output=True, text=True
        )
        if result.stdout.strip():
            subprocess.run(
                ["git", "-C", str(VAULT), "add", "-A"],
                capture_output=True
            )
            today = datetime.now().strftime("%Y-%m-%d")
            subprocess.run(
                ["git", "-C", str(VAULT), "commit", "-m", f"session: {today} end-of-session flush"],
                capture_output=True
            )
    except Exception:
        pass  # Never block Claude Code exit on a vault commit failure


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        transcript = data.get("messages", [])
    except Exception:
        transcript = []

    append_session_end(transcript)
    commit_vault()


if __name__ == "__main__":
    main()
