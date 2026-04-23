#!/opt/homebrew/bin/python3
"""
memory_index.py — Incremental vault indexer.
Chunks markdown files (~400 tokens, 50-token overlap) and upserts into the
SQLite hybrid search DB. Only re-indexes files whose mtime has changed.

Usage:
    python3 memory_index.py              # index entire vault
    python3 memory_index.py --rebuild    # wipe and rebuild from scratch
"""
import argparse
import os
import re
from pathlib import Path

from db import init_db, upsert_chunk, delete_file_chunks, get_file_mtime, DB_PATH
from embeddings import embed

VAULT = Path(__file__).parent.parent.parent / "vault"
CHUNK_TOKENS = 400
OVERLAP_TOKENS = 50
# Rough chars-per-token for markdown (English text ≈ 4 chars/token)
CHARS_PER_TOKEN = 4
CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN
OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN


def chunk_text(text: str) -> list[str]:
    """Split text into overlapping chunks of ~CHUNK_CHARS characters."""
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_CHARS
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start += CHUNK_CHARS - OVERLAP_CHARS
    return chunks


def iter_vault_files(vault: Path = VAULT):
    for path in sorted(vault.rglob("*.md")):
        # Skip hidden dirs/files using the path relative to vault root
        rel_parts = path.relative_to(vault).parts
        if any(part.startswith(".") for part in rel_parts):
            continue
        yield path


def index_file(path: Path, vault: Path = VAULT, db_path=DB_PATH):
    rel = str(path.relative_to(vault))
    mtime = path.stat().st_mtime
    cached_mtime = get_file_mtime(rel, db_path)

    if cached_mtime and abs(cached_mtime - mtime) < 0.01:
        return  # unchanged

    text = path.read_text(encoding="utf-8")
    chunks = chunk_text(text)
    if not chunks:
        return

    delete_file_chunks(rel, db_path)
    vectors = embed(chunks)
    for idx, (chunk, vec) in enumerate(zip(chunks, vectors)):
        upsert_chunk(rel, idx, chunk, vec, mtime, db_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rebuild", action="store_true", help="Wipe DB and reindex")
    parser.add_argument("--vault", type=str, default=str(VAULT))
    args = parser.parse_args()

    vault = Path(args.vault)

    if args.rebuild and DB_PATH.exists():
        DB_PATH.unlink()
        print("Wiped existing index.")

    init_db()

    files = list(iter_vault_files(vault))
    print(f"Indexing {len(files)} vault files…")
    for i, path in enumerate(files, 1):
        index_file(path, vault)
        print(f"  [{i}/{len(files)}] {path.relative_to(vault)}", flush=True)

    print("Done.")


if __name__ == "__main__":
    main()
