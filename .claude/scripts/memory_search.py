#!/opt/homebrew/bin/python3
"""
memory_search.py — Hybrid vault search CLI.
Merges vector similarity (0.7) + BM25 keyword (0.3) scores.

Usage:
    python3 memory_search.py "STEAP booking follow-up"
    python3 memory_search.py "Finley birthday ideas" --path-prefix 30-Projects/Cleetus/finley
    python3 memory_search.py "voice sample" --path-prefix drafts/sent --top-k 5
"""
import argparse
import sys
from typing import Optional

from db import vector_search, fts_search
from embeddings import embed_one

VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3


def _fts_quote(query: str) -> str:
    """Wrap query in double-quotes so FTS5 treats it as a phrase, not operators."""
    return f'"{query.replace(chr(34), "")}"'


def hybrid_search(
    query: str,
    top_k: int = 5,
    path_prefix: Optional[str] = None,
) -> list[dict]:
    query_vec = embed_one(query)

    vec_results = vector_search(query_vec, top_k=top_k * 2, path_prefix=path_prefix)
    fts_results = fts_search(_fts_quote(query), top_k=top_k * 2, path_prefix=path_prefix)

    scores: dict[int, dict] = {}

    # Normalize vector distances (cosine distance: lower = better → invert)
    if vec_results:
        max_d = max(r["distance"] for r in vec_results) or 1.0
        for r in vec_results:
            norm_score = 1.0 - (r["distance"] / max_d)
            scores[r["id"]] = {**r, "score": VECTOR_WEIGHT * norm_score}

    # Normalize BM25 (bm25 is negative in SQLite FTS5: closer to 0 = better)
    if fts_results:
        min_bm25 = min(r["score"] for r in fts_results)
        max_bm25 = max(r["score"] for r in fts_results)
        span = (max_bm25 - min_bm25) or 1.0
        for r in fts_results:
            norm_score = (r["score"] - min_bm25) / span
            if r["id"] in scores:
                scores[r["id"]]["score"] += KEYWORD_WEIGHT * norm_score
            else:
                scores[r["id"]] = {**r, "score": KEYWORD_WEIGHT * norm_score}

    ranked = sorted(scores.values(), key=lambda x: x["score"], reverse=True)
    return ranked[:top_k]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("query", help="Search query")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--path-prefix", type=str, default=None)
    args = parser.parse_args()

    results = hybrid_search(args.query, top_k=args.top_k, path_prefix=args.path_prefix)

    if not results:
        print("No results found.")
        return

    for i, r in enumerate(results, 1):
        print(f"\n{'─'*60}")
        print(f"[{i}] {r['file_path']} (chunk {r['chunk_idx']}) — score {r['score']:.3f}")
        print(f"{'─'*60}")
        print(r["content"][:500])
        if len(r["content"]) > 500:
            print("…")


if __name__ == "__main__":
    main()
