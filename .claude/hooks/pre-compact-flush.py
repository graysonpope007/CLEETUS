#!/usr/bin/env python3
"""
PreCompact hook — before Claude Code auto-compacts the conversation, extract
key decisions and facts from the current session transcript and append them
to today's daily log in the vault.

Reads the transcript from stdin as JSON (Claude Code passes it this way).
"""
import sys
import json
import os
from pathlib import Path
from datetime import datetime, timezone

VAULT = Path(__file__).parent.parent.parent / "vault"
DAILY_DIR = VAULT / "10-Daily"

ET_OFFSET = -4  # EDT; adjust to -5 for EST outside DST


def today_log_path() -> Path:
    today = datetime.now().strftime("%Y-%m-%d")
    return DAILY_DIR / f"{today}.md"


def extract_key_points(transcript: list[dict]) -> list[str]:
    """Pull assistant messages that look like decisions, facts, or action items."""
    points = []
    for msg in transcript:
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content", "")
        if isinstance(content, list):
            content = " ".join(
                c.get("text", "") for c in content if isinstance(c, dict)
            )
        content = content.strip()
        if not content:
            continue
        # Keep it short — first 300 chars of meaningful assistant turns
        if len(content) > 50:
            points.append(content[:300].replace("\n", " ") + ("…" if len(content) > 300 else ""))
    return points[-10:]  # last 10 meaningful turns


def append_to_daily_log(points: list[str]):
    DAILY_DIR.mkdir(parents=True, exist_ok=True)
    path = today_log_path()
    timestamp = datetime.now().strftime("%H:%M")

    lines = [f"\n\n## Pre-compact flush — {timestamp} ET\n"]
    for i, point in enumerate(points, 1):
        lines.append(f"{i}. {point}")
    lines.append("")

    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        transcript = data.get("messages", [])
    except Exception:
        transcript = []

    if not transcript:
        return

    points = extract_key_points(transcript)
    if points:
        append_to_daily_log(points)


if __name__ == "__main__":
    main()
