#!/opt/homebrew/bin/python3
"""
base.py — PlatformAdapter protocol.
Each chat surface (Slack, iMessage, iOS Shortcut) implements this interface.
The core reasoning loop only talks to this protocol — adding a new surface
never requires changes to core.py.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Protocol


@dataclass
class IncomingMessage:
    text: str
    sender_id: str       # platform-specific user ID
    channel_id: str      # DM channel or conversation ID
    thread_ts: str | None = None   # Slack thread timestamp; None for other platforms
    platform: str = "unknown"


class PlatformAdapter(Protocol):
    def thread_id(self, message: IncomingMessage) -> str:
        """Return a stable session key for this conversation thread."""
        ...

    def send(self, text: str, reply_to: IncomingMessage) -> None:
        """Send a response back to the user on this platform."""
        ...
