import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from cleetus.config import DB_PATH


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_db():
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'New conversation',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );

            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                source_conversation_id TEXT,
                confidence REAL NOT NULL DEFAULT 1.0,
                access_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                content,
                content=memories,
                content_rowid=rowid
            );

            CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
                INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
            END;

            CREATE TABLE IF NOT EXISTS user_profile (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sms_messages (
                id TEXT PRIMARY KEY,
                thread_id TEXT,
                contact_name TEXT,
                contact_number TEXT NOT NULL,
                direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
                body TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                read INTEGER NOT NULL DEFAULT 0,
                synced_at TEXT NOT NULL
            );
        """)


# ── Conversations ────────────────────────────────────────────────────────────

def create_conversation(title: str = "New conversation") -> dict:
    cid = str(uuid.uuid4())
    ts = _now()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?,?,?,?)",
            (cid, title, ts, ts),
        )
    return {"id": cid, "title": title, "created_at": ts, "updated_at": ts}


def get_conversations() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM conversations ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(cid: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (cid,)
        ).fetchone()
    return dict(row) if row else None


def update_conversation_title(cid: str, title: str):
    with get_db() as conn:
        conn.execute(
            "UPDATE conversations SET title=?, updated_at=? WHERE id=?",
            (title, _now(), cid),
        )


# ── Messages ─────────────────────────────────────────────────────────────────

def save_message(cid: str, role: str, content: str) -> dict:
    mid = str(uuid.uuid4())
    ts = _now()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)",
            (mid, cid, role, content, ts),
        )
        conn.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?", (ts, cid)
        )
    return {"id": mid, "conversation_id": cid, "role": role, "content": content, "created_at": ts}


def get_messages(cid: str) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC",
            (cid,),
        ).fetchall()
    return [dict(r) for r in rows]


# ── Memories ──────────────────────────────────────────────────────────────────

def save_memory(
    category: str,
    content: str,
    conversation_id: str | None = None,
    confidence: float = 1.0,
) -> dict:
    mid = str(uuid.uuid4())
    ts = _now()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO memories (id, category, content, source_conversation_id, confidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (mid, category, content, conversation_id, confidence, ts, ts),
        )
    return {"id": mid, "category": category, "content": content, "confidence": confidence, "created_at": ts}


def get_all_memories() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM memories ORDER BY category ASC, confidence DESC, updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_memories_by_category(category: str) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM memories WHERE category=? ORDER BY confidence DESC, updated_at DESC",
            (category,),
        ).fetchall()
    return [dict(r) for r in rows]


def search_memories(query: str, limit: int = 12) -> list[dict]:
    """Full-text search across memories, bumps access_count on hits."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT m.* FROM memories m
            JOIN memories_fts fts ON m.rowid = fts.rowid
            WHERE memories_fts MATCH ?
            ORDER BY rank, m.confidence DESC
            LIMIT ?
            """,
            (query, limit),
        ).fetchall()
        results = [dict(r) for r in rows]
        if results:
            placeholders = ",".join("?" * len(results))
            conn.execute(
                f"UPDATE memories SET access_count = access_count + 1 WHERE id IN ({placeholders})",
                [r["id"] for r in results],
            )
    return results


def delete_memory(mid: str):
    with get_db() as conn:
        conn.execute("DELETE FROM memories WHERE id=?", (mid,))


def memory_count() -> int:
    with get_db() as conn:
        return conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]


# ── User Profile ──────────────────────────────────────────────────────────────

def get_user_profile() -> dict:
    with get_db() as conn:
        rows = conn.execute("SELECT key, value FROM user_profile").fetchall()
    return {r["key"]: r["value"] for r in rows}


def set_profile_field(key: str, value: str):
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO user_profile (key, value, updated_at) VALUES (?,?,?)",
            (key, value, _now()),
        )


# ── SMS ───────────────────────────────────────────────────────────────────────

def save_sms(
    contact_name: str,
    contact_number: str,
    direction: str,
    body: str,
    timestamp: str,
    thread_id: str | None = None,
    read: bool = False,
) -> dict:
    mid = str(uuid.uuid4())
    synced_at = _now()
    with get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sms_messages (id, thread_id, contact_name, contact_number, direction, body, timestamp, read, synced_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (mid, thread_id, contact_name, contact_number, direction, body, timestamp, int(read), synced_at),
        )
    return {"id": mid, "contact_name": contact_name, "direction": direction, "body": body, "timestamp": timestamp}


def get_sms(limit: int = 50, contact_number: str | None = None) -> list[dict]:
    with get_db() as conn:
        if contact_number:
            rows = conn.execute(
                "SELECT * FROM sms_messages WHERE contact_number=? ORDER BY timestamp DESC LIMIT ?",
                (contact_number, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM sms_messages ORDER BY timestamp DESC LIMIT ?",
                (limit,),
            ).fetchall()
    return [dict(r) for r in rows]


def get_unread_sms() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM sms_messages WHERE read=0 AND direction='incoming' ORDER BY timestamp DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def mark_sms_read(sms_id: str):
    with get_db() as conn:
        conn.execute("UPDATE sms_messages SET read=1 WHERE id=?", (sms_id,))
