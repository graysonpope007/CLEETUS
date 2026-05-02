#!/usr/bin/env python3
"""
vault_sync.py  —  push Obsidian vault context to Supabase
Run on Mac:  python3 vault_sync.py

Reads the Cleetus Obsidian vault, pulls recent iMessages, compiles
grayson-context.json, and uploads it to Supabase storage (creo-config bucket).

Requirements (stdlib only + supabase-py or raw requests):
    pip install supabase   # or: pip install requests

Env vars (or .env file in same directory):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY   (needs storage write; anon key is read-only)
"""

import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

VAULT = Path.home() / "Library/Mobile Documents/iCloud~md~obsidian/Documents/Cleetus"
MESSAGES_DB = Path.home() / "Library/Messages/chat.db"

BUCKET = "creo-config"
OBJECT = "grayson-context.json"

# How many daily notes to include
MAX_DAILY = 7
# How many iMessage threads to include
MAX_THREADS = 20
# How many messages per thread
MAX_MSGS_PER_THREAD = 10
# Truncate individual markdown files at this length (chars)
MAX_FILE_CHARS = 4000


def _load_env():
    """Load .env from several known locations (first match wins per key)."""
    candidates = [
        Path(__file__).parent / ".env",          # next to vault_sync.py
        Path.home() / "cleetus" / ".env",         # Python backend
        Path.home() / "cleetus-app" / ".env",     # Expo app (no service role key here)
    ]
    for env_path in candidates:
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ── Vault readers ─────────────────────────────────────────────────────────────

def _read(path: Path, max_chars: int = MAX_FILE_CHARS) -> str:
    try:
        text = path.read_text(encoding="utf-8").strip()
        return text[:max_chars] if len(text) > max_chars else text
    except Exception:
        return ""


def _read_dir_as_dict(folder: Path, max_chars: int = MAX_FILE_CHARS) -> dict:
    result = {}
    if not folder.is_dir():
        return result
    for f in sorted(folder.glob("*.md")):
        key = f.stem
        text = _read(f, max_chars)
        if text:
            result[key] = text
    return result


def _read_daily_notes() -> tuple[str, dict]:
    """Returns (today_content, {date_str: content}) for last MAX_DAILY days."""
    daily_dir = VAULT / "10-Daily"
    today_str = datetime.now().strftime("%Y-%m-%d")
    today_content = ""
    recent: dict = {}

    if not daily_dir.is_dir():
        return today_content, recent

    # Collect all daily notes, sort descending
    notes = sorted(daily_dir.glob("*.md"), reverse=True)
    for note in notes[:MAX_DAILY]:
        content = _read(note)
        if not content:
            continue
        if note.stem == today_str:
            today_content = content
        else:
            recent[note.stem] = content

    return today_content, recent


def _read_inbox() -> str:
    inbox_dir = VAULT / "00-Inbox"
    if not inbox_dir.is_dir():
        return ""
    items = []
    for f in sorted(inbox_dir.glob("*.md")):
        text = _read(f, 500)
        if text:
            items.append(f"### {f.stem}\n{text}")
    return "\n\n".join(items)


# ── iMessages reader ──────────────────────────────────────────────────────────

def _read_imessages() -> str:
    if not MESSAGES_DB.exists():
        return "(Messages DB not accessible — run on Mac with full disk access)"
    try:
        conn = sqlite3.connect(f"file:{MESSAGES_DB}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # Get most recent threads
        threads_sql = """
            SELECT
                h.id AS contact,
                MAX(m.date) AS last_date
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat c ON c.ROWID = cmj.chat_id
            JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
            JOIN handle h ON h.ROWID = chj.handle_id
            WHERE m.text IS NOT NULL AND m.text != ''
            GROUP BY h.id
            ORDER BY last_date DESC
            LIMIT ?
        """
        cur.execute(threads_sql, (MAX_THREADS,))
        threads = cur.fetchall()

        output_parts = []
        for thread in threads:
            contact = thread["contact"]
            msgs_sql = """
                SELECT
                    m.is_from_me,
                    m.text,
                    datetime(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime') AS ts
                FROM message m
                JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                JOIN chat c ON c.ROWID = cmj.chat_id
                JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
                JOIN handle h ON h.ROWID = chj.handle_id
                WHERE h.id = ? AND m.text IS NOT NULL AND m.text != ''
                ORDER BY m.date DESC
                LIMIT ?
            """
            cur.execute(msgs_sql, (contact, MAX_MSGS_PER_THREAD))
            msgs = cur.fetchall()
            if not msgs:
                continue
            lines = [f"**{contact}**"]
            for msg in reversed(msgs):
                sender = "Me" if msg["is_from_me"] else contact
                lines.append(f"  [{msg['ts']}] {sender}: {msg['text'][:200]}")
            output_parts.append("\n".join(lines))

        conn.close()
        return "\n\n".join(output_parts) if output_parts else "(no messages found)"
    except Exception as e:
        return f"(iMessages unavailable: {e})"


# ── Supabase upload ───────────────────────────────────────────────────────────

def _upload(data: dict, url: str, key: str) -> None:
    """Upload JSON to Supabase storage using requests (no extra deps needed)."""
    try:
        import requests
    except ImportError:
        print("ERROR: 'requests' not installed. Run: pip install requests")
        sys.exit(1)

    payload = json.dumps(data, ensure_ascii=False, indent=2)
    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{OBJECT}"

    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "x-upsert": "true",
    }

    resp = requests.post(endpoint, data=payload.encode("utf-8"), headers=headers)

    if resp.status_code in (200, 201):
        size_kb = len(payload) / 1024
        print(f"✓ Uploaded {OBJECT} ({size_kb:.1f} KB) to {BUCKET}")
    else:
        # If object already exists, try PUT
        if resp.status_code == 400:
            resp2 = requests.put(endpoint, data=payload.encode("utf-8"), headers=headers)
            if resp2.status_code in (200, 201):
                size_kb = len(payload) / 1024
                print(f"✓ Updated {OBJECT} ({size_kb:.1f} KB) in {BUCKET}")
                return
        print(f"ERROR: Upload failed — HTTP {resp.status_code}: {resp.text}")
        sys.exit(1)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    _load_env()

    # Accept either bare SUPABASE_URL or Expo's EXPO_PUBLIC_ prefix
    supabase_url = (
        os.environ.get("SUPABASE_URL")
        or os.environ.get("EXPO_PUBLIC_SUPABASE_URL")
        or ""
    ).strip()

    # Use service role key if available; fall back to anon key (bucket policy allows it)
    service_key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SERVICE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("EXPO_PUBLIC_SUPABASE_ANON_KEY")
        or ""
    ).strip()

    if not supabase_url or "YOUR_PROJECT_ID" in supabase_url:
        print("ERROR: SUPABASE_URL not set.")
        print("  Add SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL to ~/cleetus-app/.env")
        sys.exit(1)
    if not service_key:
        print("ERROR: No Supabase key found.")
        print("  Add EXPO_PUBLIC_SUPABASE_ANON_KEY to ~/cleetus-app/.env")
        sys.exit(1)

    print(f"Supabase URL: {supabase_url}")

    if not VAULT.is_dir():
        print(f"ERROR: Vault not found at {VAULT}")
        sys.exit(1)

    print(f"Reading vault: {VAULT}")

    # Core identity files
    user_md = _read(VAULT / "USER.md")
    memory_md = _read(VAULT / "MEMORY.md")
    soul_md = _read(VAULT / "SOUL.md")
    critical_md = _read(VAULT / "CRITICAL_FACTS.md")
    habits_md = _read(VAULT / "HABITS.md")
    heartbeat_md = _read(VAULT / "HEARTBEAT.md")
    activity_log = _read(VAULT / "log.md", max_chars=6000)

    # Combine user identity
    user_parts = [p for p in [user_md, critical_md] if p]
    user = "\n\n".join(user_parts) or "Grayson Pope, 21, Athens GA, musician and entrepreneur."

    # Memory + habits combined
    memory_parts = [p for p in [memory_md, habits_md] if p]
    memory = "\n\n".join(memory_parts) or "No memory loaded."

    # Soul + heartbeat
    soul_parts = [p for p in [soul_md, heartbeat_md] if p]
    soul = "\n\n".join(soul_parts) or "Warm, direct, Southern-friendly. Never mention alcohol. Tree-nut allergy for Finley."

    # Structured sections
    projects = _read_dir_as_dict(VAULT / "30-Projects")
    people = _read_dir_as_dict(VAULT / "20-People")
    resources = _read_dir_as_dict(VAULT / "50-Resources")
    inbox = _read_inbox()
    today, recent_days = _read_daily_notes()

    # iMessages
    print("Reading iMessages...")
    recent_texts = _read_imessages()

    synced_at = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    context = {
        "user": user,
        "memory": memory,
        "soul": soul,
        "projects": projects,
        "people": people,
        "resources": resources,
        "inbox": inbox,
        "today": today,
        "recent_days": recent_days,
        "activity_log": activity_log,
        "recent_texts": recent_texts,
        "updated": synced_at,
        "_synced_at": synced_at,
    }

    # Summary
    print(f"  user: {len(user)} chars")
    print(f"  memory: {len(memory)} chars")
    print(f"  projects: {len(projects)} files")
    print(f"  people: {len(people)} files")
    print(f"  resources: {len(resources)} files")
    print(f"  inbox: {len(inbox)} chars")
    print(f"  today: {len(today)} chars")
    print(f"  recent_days: {len(recent_days)} notes")
    print(f"  activity_log: {len(activity_log)} chars")
    print(f"  recent_texts: {len(recent_texts)} chars")

    print(f"\nUploading to Supabase ({supabase_url})...")
    _upload(context, supabase_url, service_key)

    print()
    print("Done. The app will load fresh context on next vault fetch.")
    print("(Cache TTL is 5 min — or tap a fresh session to force reload.)")


if __name__ == "__main__":
    main()
