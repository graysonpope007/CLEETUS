#!/opt/homebrew/bin/python3
"""
db.py — SQLite abstraction layer.
Uses sqlite-vec for vector similarity and FTS5 for keyword search.
"""
import sqlite3
import struct
from pathlib import Path
from typing import Optional

import sqlite_vec

DB_PATH = Path(__file__).parent.parent / "data" / "memory.db"
VECTOR_DIM = 384  # all-MiniLM-L6-v2


def _conn(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path: Path = DB_PATH):
    conn = _conn(db_path)
    conn.executescript(f"""
        CREATE TABLE IF NOT EXISTS chunks (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            chunk_idx INTEGER NOT NULL,
            content   TEXT NOT NULL,
            mtime     REAL NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
            USING fts5(content, content='chunks', content_rowid='id');

        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec
            USING vec0(
                id        INTEGER PRIMARY KEY,
                embedding FLOAT[{VECTOR_DIM}]
            );
    """)
    conn.commit()
    conn.close()


def upsert_chunk(
    file_path: str,
    chunk_idx: int,
    content: str,
    embedding: list[float],
    mtime: float,
    db_path: Path = DB_PATH,
):
    conn = _conn(db_path)
    cur = conn.cursor()

    # Delete existing chunk at this position (idempotent reindex)
    cur.execute(
        "DELETE FROM chunks WHERE file_path = ? AND chunk_idx = ?",
        (file_path, chunk_idx),
    )

    cur.execute(
        "INSERT INTO chunks (file_path, chunk_idx, content, mtime) VALUES (?, ?, ?, ?)",
        (file_path, chunk_idx, content, mtime),
    )
    rowid = cur.lastrowid

    vec_bytes = struct.pack(f"{VECTOR_DIM}f", *embedding)
    cur.execute(
        "INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?, ?)",
        (rowid, vec_bytes),
    )

    # Keep FTS in sync
    cur.execute(
        "INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)",
        (rowid, content),
    )
    conn.commit()
    conn.close()


def delete_file_chunks(file_path: str, db_path: Path = DB_PATH):
    conn = _conn(db_path)
    rows = conn.execute(
        "SELECT id FROM chunks WHERE file_path = ?", (file_path,)
    ).fetchall()
    ids = [r["id"] for r in rows]
    if ids:
        placeholders = ",".join("?" * len(ids))
        conn.execute(f"DELETE FROM chunks_vec WHERE id IN ({placeholders})", ids)
        conn.execute(
            f"DELETE FROM chunks_fts WHERE rowid IN ({placeholders})", ids
        )
        conn.execute(
            "DELETE FROM chunks WHERE file_path = ?", (file_path,)
        )
    conn.commit()
    conn.close()


def get_file_mtime(file_path: str, db_path: Path = DB_PATH) -> Optional[float]:
    conn = _conn(db_path)
    row = conn.execute(
        "SELECT mtime FROM chunks WHERE file_path = ? LIMIT 1", (file_path,)
    ).fetchone()
    conn.close()
    return row["mtime"] if row else None


def vector_search(
    query_vec: list[float],
    top_k: int = 10,
    path_prefix: Optional[str] = None,
    db_path: Path = DB_PATH,
) -> list[dict]:
    conn = _conn(db_path)
    vec_bytes = struct.pack(f"{VECTOR_DIM}f", *query_vec)

    if path_prefix:
        rows = conn.execute(
            f"""
            SELECT c.id, c.file_path, c.content, c.chunk_idx,
                   vec_distance_cosine(cv.embedding, ?) AS distance
            FROM chunks_vec cv
            JOIN chunks c ON cv.id = c.id
            WHERE c.file_path LIKE ?
            ORDER BY distance
            LIMIT ?
            """,
            (vec_bytes, f"{path_prefix}%", top_k),
        ).fetchall()
    else:
        rows = conn.execute(
            f"""
            SELECT c.id, c.file_path, c.content, c.chunk_idx,
                   vec_distance_cosine(cv.embedding, ?) AS distance
            FROM chunks_vec cv
            JOIN chunks c ON cv.id = c.id
            ORDER BY distance
            LIMIT ?
            """,
            (vec_bytes, top_k),
        ).fetchall()

    conn.close()
    return [dict(r) for r in rows]


def fts_search(
    query: str,
    top_k: int = 10,
    path_prefix: Optional[str] = None,
    db_path: Path = DB_PATH,
) -> list[dict]:
    conn = _conn(db_path)
    if path_prefix:
        rows = conn.execute(
            """
            SELECT c.id, c.file_path, c.content, c.chunk_idx,
                   bm25(chunks_fts) AS score
            FROM chunks_fts
            JOIN chunks c ON chunks_fts.rowid = c.id
            WHERE chunks_fts MATCH ? AND c.file_path LIKE ?
            ORDER BY score
            LIMIT ?
            """,
            (query, f"{path_prefix}%", top_k),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT c.id, c.file_path, c.content, c.chunk_idx,
                   bm25(chunks_fts) AS score
            FROM chunks_fts
            JOIN chunks c ON chunks_fts.rowid = c.id
            WHERE chunks_fts MATCH ?
            ORDER BY score
            LIMIT ?
            """,
            (query, top_k),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]
