#!/opt/homebrew/bin/python3
"""
embeddings.py — FastEmbed wrapper using all-MiniLM-L6-v2 (384-dim ONNX).
Model is downloaded on first use and cached at ~/.cache/fastembed.
"""
from __future__ import annotations

_model = None
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def _get_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding(MODEL_NAME)
    return _model


def embed(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts. Returns list of 384-dim float vectors."""
    model = _get_model()
    return [list(v) for v in model.embed(texts)]


def embed_one(text: str) -> list[float]:
    return embed([text])[0]
