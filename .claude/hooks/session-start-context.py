#!/usr/bin/env python3
"""
SessionStart hook — injects SOUL.md, USER.md, MEMORY.md, and the last 3 daily logs
into every Claude Code conversation as a system context block.
"""
import sys
import os
from pathlib import Path
from datetime import datetime, date

VAULT = Path(__file__).parent.parent.parent / "vault"
DAILY_DIR = VAULT / "10-Daily"
CORE_FILES = ["SOUL.md", "USER.md", "MEMORY.md"]
DAILY_LOOKBACK = 3


def read_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def get_recent_daily_logs() -> list[tuple[str, str]]:
    if not DAILY_DIR.exists():
        return []
    logs = sorted(
        [f for f in DAILY_DIR.glob("*.md") if f.stem != ".gitkeep"],
        reverse=True
    )[:DAILY_LOOKBACK]
    return [(f.stem, read_file(f)) for f in logs if read_file(f)]


def main():
    sections = []

    # Core memory files
    for filename in CORE_FILES:
        content = read_file(VAULT / filename)
        if content:
            sections.append(f"## {filename}\n\n{content}")

    # Recent daily logs
    daily_logs = get_recent_daily_logs()
    if daily_logs:
        log_block = "\n\n---\n\n".join(
            f"### {name}\n\n{content}" for name, content in daily_logs
        )
        sections.append(f"## Recent Daily Logs (last {len(daily_logs)})\n\n{log_block}")

    if not sections:
        return

    today = date.today().isoformat()
    tz = "America/New_York"
    output = (
        f"<cleetus_memory>\n"
        f"<!-- Injected by session-start-context.py at {today} ({tz}) -->\n\n"
        + "\n\n---\n\n".join(sections)
        + "\n</cleetus_memory>"
    )
    print(output)


if __name__ == "__main__":
    main()
