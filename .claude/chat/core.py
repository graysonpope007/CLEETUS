#!/opt/homebrew/bin/python3
"""
core.py — Message router and Claude Agent SDK reasoning loop.
Receives an IncomingMessage from any PlatformAdapter, runs it through
Claude with memory context injected, sends the response back.
Adding a new surface = new adapter, zero changes here.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
os.environ.setdefault("CLEETUS_ROOT", "/Users/grayson/cleetus")

from dotenv import load_dotenv
load_dotenv(Path(os.environ["CLEETUS_ROOT"]) / ".env")

from .adapters.base import IncomingMessage, PlatformAdapter
from .session_store import get_session_id, save_session_id

VAULT = Path(__file__).parents[2] / "vault"

# claude-agent-sdk is the Claude Code SDK (claude-code CLI package).
# For programmatic use we call the Anthropic API directly until the
# Agent SDK stabilises its Python interface for external scripts.
# Swap in sdk.query() here when it's production-ready.
import anthropic


def _load_system_prompt() -> str:
    parts = []
    for fname in ["SOUL.md", "USER.md", "MEMORY.md"]:
        p = VAULT / fname
        if p.exists():
            parts.append(p.read_text()[:2000])
    base = "\n\n---\n\n".join(parts)
    return (
        base + "\n\n---\n\n"
        "You are Cleetus, Grayson's AI second brain. Respond in the voice and style "
        "defined in SOUL.md. Never suggest alcohol. Never suggest tree nuts for Finley. "
        "You are in a live conversation with Grayson via Slack DM."
    )


def handle_message(adapter: PlatformAdapter, message: IncomingMessage) -> None:
    """
    Full reasoning loop for one incoming message.
    Runs synchronously — call from a thread if needed (SlackAdapter does this).
    """
    thread_key = adapter.thread_id(message)

    # Load prior session if exists (multi-turn continuity)
    # For now we use the Anthropic API with a conversation history approach.
    # When claude-agent-sdk Python is stable, swap session_id in here.
    history = _get_history(thread_key)
    history.append({"role": "user", "content": message.text})

    try:
        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=_load_system_prompt(),
            messages=history,
        )
        reply = response.content[0].text.strip()
    except Exception as e:
        reply = f"Something went wrong on my end: {e}"

    history.append({"role": "assistant", "content": reply})
    _save_history(thread_key, history)

    adapter.send(reply, message)


# ─────────────────────────────────────────
# SIMPLE HISTORY STORE (SQLite via session_store)
# History is kept in-memory per thread for this session.
# A full Agent SDK integration would use SDK session IDs instead.
# ─────────────────────────────────────────

_history_cache: dict[str, list[dict]] = {}


def _get_history(thread_key: str) -> list[dict]:
    if thread_key not in _history_cache:
        _history_cache[thread_key] = []
    return list(_history_cache[thread_key])


def _save_history(thread_key: str, history: list[dict]):
    # Keep last 20 turns to stay within context
    _history_cache[thread_key] = history[-20:]
