#!/opt/homebrew/bin/python3
"""
sanitize.py — Layer 1 security: sanitize external text before passing to Claude.
Pattern detection → markdown escaping → XML trust boundary wrapping.
"""
from __future__ import annotations

import re

# Phrases that suggest prompt injection attempts in external content
_INJECTION_PATTERNS = [
    r"ignore\s+(all\s+|previous\s+|above\s+|prior\s+)*instructions",
    r"disregard (your |all |previous )?instructions",
    r"you are now",
    r"new persona",
    r"jailbreak",
    r"act as (if you are|a|an) (?!cleetus)",
    r"forget everything",
    r"system prompt",
    r"</?(system|human|assistant)>",
    r"\[INST\]|\[\/INST\]",
    r"<\|im_start\|>|<\|im_end\|>",
]

_COMPILED = [re.compile(p, re.IGNORECASE) for p in _INJECTION_PATTERNS]


def has_injection_attempt(text: str) -> bool:
    return any(p.search(text) for p in _COMPILED)


def escape_markdown(text: str) -> str:
    """Escape markdown that could affect Claude's output formatting."""
    # Escape backtick sequences that could break code blocks
    text = text.replace("```", "` ` `")
    return text


def wrap_external(text: str, source: str = "external") -> str:
    """
    Wrap external content (emails, Slack messages) in XML trust boundary tags.
    Claude sees the tags and knows this content came from outside the system.
    """
    flagged = " INJECTION_ATTEMPT_DETECTED" if has_injection_attempt(text) else ""
    escaped = escape_markdown(text)
    return (
        f'<external_content source="{source}" trust="untrusted"{flagged}>\n'
        f"{escaped}\n"
        f"</external_content>"
    )


def sanitize_gmail_thread(messages: list[dict]) -> list[dict]:
    """Wrap each message body in an external_content tag."""
    result = []
    for msg in messages:
        sanitized = dict(msg)
        if "body" in sanitized:
            sanitized["body"] = wrap_external(sanitized["body"], source="gmail")
        if "snippet" in sanitized:
            sanitized["snippet"] = wrap_external(sanitized["snippet"], source="gmail")
        result.append(sanitized)
    return result


def sanitize_slack_messages(messages: list[dict]) -> list[dict]:
    result = []
    for msg in messages:
        sanitized = dict(msg)
        if "text" in sanitized:
            sanitized["text"] = wrap_external(sanitized["text"], source="slack")
        result.append(sanitized)
    return result
