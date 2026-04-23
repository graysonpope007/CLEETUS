#!/opt/homebrew/bin/python3
"""
shortcut_adapter.py — iOS Shortcut / NFC trigger adapter stub.
Not implemented in Phase 7. Stub provides the PlatformAdapter interface
so core.py doesn't need changes when this surface is activated.

To activate: implement the HTTP server below and register it with ngrok
or a VPS reverse proxy. Wire the iOS Shortcut to POST to /message.
"""
from __future__ import annotations

from .base import IncomingMessage


class ShortcutAdapter:
    """Stub — iOS Shortcut HTTP endpoint adapter. Implement in a future phase."""

    def thread_id(self, message: IncomingMessage) -> str:
        return f"shortcut:{message.sender_id}"

    def send(self, text: str, reply_to: IncomingMessage) -> None:
        # Future: push response back via Pushover, APNs, or Twilio SMS
        raise NotImplementedError("ShortcutAdapter.send not yet implemented")

    # TODO Phase 7+:
    # - Start a Flask/FastAPI server on a local port
    # - Accept POST /message {"text": "...", "sender": "grayson"}
    # - Call on_message handler
    # - Return response as JSON {"reply": "..."}
