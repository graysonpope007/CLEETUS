#!/opt/homebrew/bin/python3
"""
guardrails.py — Layer 2 security: deterministic pre-checks before any tool call.
Blocks dangerous command patterns before Claude even sees them.
Also provides the confirm_send() flow for Advisor-mode outbound actions.
"""
from __future__ import annotations

import re
import time
from typing import Literal

# Commands that are always blocked, no exceptions
BLOCKED_PATTERNS = [
    (r"git\s+push\s+.*--force|git\s+push\s+-f", "force push"),
    (r"git\s+reset\s+--hard", "hard reset"),
    (r"rm\s+-rf", "recursive delete"),
    (r"chmod\s+777", "world-writable permission"),
    (r"DROP\s+TABLE|DROP\s+DATABASE", "database destruction"),
    (r"schwab.*\b(order|trade|buy|sell|place)\b", "Schwab trade execution"),
    (r"send.*email.*(?!grayson|gpope)", "email to non-Grayson"),
]

# Commands that require explicit confirmation before proceeding
CONFIRM_PATTERNS = [
    (r"slack.*send|chat_postMessage(?!.*D0AMJ560C2W)", "Slack message to non-Grayson channel"),
    (r"gmail.*send|messages.*send(?!.*draft)", "Gmail send"),
    (r"calendar.*insert|calendar.*patch", "Calendar modification"),
    (r"drive.*create|drive.*update|drive.*delete", "Drive write operation"),
]

_BLOCK_RE = [(re.compile(p, re.IGNORECASE), label) for p, label in BLOCKED_PATTERNS]
_CONFIRM_RE = [(re.compile(p, re.IGNORECASE), label) for p, label in CONFIRM_PATTERNS]


CheckResult = Literal["allow", "block", "confirm"]


def check_command(command: str) -> tuple[CheckResult, str]:
    """
    Returns ("block", reason), ("confirm", reason), or ("allow", "").
    Call before executing any shell command or API write operation.
    """
    for pattern, label in _BLOCK_RE:
        if pattern.search(command):
            return "block", f"Blocked: {label}"

    for pattern, label in _CONFIRM_RE:
        if pattern.search(command):
            return "confirm", f"Requires confirmation: {label}"

    return "allow", ""


def confirm_send(
    draft_summary: str,
    recipient: str,
    channel: str = "D0AMJ560C2W",
) -> bool:
    """
    Post a draft preview to Grayson's Slack DM and wait for "send it" or "cancel".
    Returns True if confirmed, False if cancelled or timed out (5 minutes).

    In Phase 7+: this integrates with the Slack chat server's message queue.
    For now: prints to stdout and requires manual confirmation (TTY mode).
    """
    print(f"\n{'='*60}")
    print(f"OUTBOUND ACTION PENDING — Advisor confirmation required")
    print(f"To: {recipient}")
    print(f"{'─'*60}")
    print(draft_summary[:500])
    print(f"{'='*60}")
    print("Type 'send it' to confirm, anything else to cancel: ", end="", flush=True)

    try:
        response = input().strip().lower()
        return response == "send it"
    except (EOFError, KeyboardInterrupt):
        return False


def assert_no_secrets_in_text(text: str) -> None:
    """
    Raise if text appears to contain API tokens or credentials.
    Call before writing anything to the vault.
    """
    secret_patterns = [
        r"sk-ant-api\w+",           # Anthropic key
        r"xoxb-\w+",                # Slack bot token
        r"xapp-\w+",                # Slack app token
        r"AIza[0-9A-Za-z\-_]{35}", # Google API key
        r"ya29\.[0-9A-Za-z\-_]+",  # Google OAuth access token
    ]
    for pattern in secret_patterns:
        if re.search(pattern, text):
            raise ValueError(
                "Attempted to write what looks like an API key or token to the vault. "
                "Store secrets in .env or macOS Keychain only."
            )
