#!/opt/homebrew/bin/python3
"""
session_store.py — Persistent conversation session store.
Maps thread_id (platform:channel:ts) → claude_session_id.
Uses SQLite at .claude/data/chat.db.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parents[1] / "data" / "chat.db"


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            thread_id        TEXT PRIMARY KEY,
            claude_session_id TEXT,
            last_updated     TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    return conn


def get_session_id(thread_id: str) -> str | None:
    conn = _conn()
    row = conn.execute(
        "SELECT claude_session_id FROM sessions WHERE thread_id = ?", (thread_id,)
    ).fetchone()
    conn.close()
    return row[0] if row else None


def save_session_id(thread_id: str, claude_session_id: str):
    conn = _conn()
    conn.execute("""
        INSERT INTO sessions (thread_id, claude_session_id, last_updated)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(thread_id) DO UPDATE SET
            claude_session_id = excluded.claude_session_id,
            last_updated = excluded.last_updated
    """, (thread_id, claude_session_id))
    conn.commit()
    conn.close()


def clear_session(thread_id: str):
    conn = _conn()
    conn.execute("DELETE FROM sessions WHERE thread_id = ?", (thread_id,))
    conn.commit()
    conn.close()
