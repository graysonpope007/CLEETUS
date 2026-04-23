#!/opt/homebrew/bin/python3
"""
slack_integration.py — Slack integration module (non-Socket-Mode queries).
Provides read + DM send to Grayson. Sending to others requires explicit confirm.
Bot token loaded from .env — Claude never sees it.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

_ENV_PATH = Path(os.environ.get("CLEETUS_ROOT", str(Path(__file__).parents[4]))) / ".env"
load_dotenv(_ENV_PATH)

GRAYSON_DM_CHANNEL = "D0AMJ560C2W"

_client: WebClient | None = None


def _get_client() -> WebClient:
    global _client
    if _client is None:
        token = os.getenv("SLACK_BOT_TOKEN")
        if not token:
            raise EnvironmentError(
                "SLACK_BOT_TOKEN not set in .env. "
                "Create a Slack App with Socket Mode and add the bot token."
            )
        _client = WebClient(token=token)
    return _client


@dataclass
class SlackMessage:
    channel: str
    user: str
    text: str
    ts: str
    thread_ts: str | None


def send_to_grayson(text: str, thread_ts: str | None = None) -> str:
    """Send a message to Grayson's DM channel. Safe — always goes to Grayson only."""
    client = _get_client()
    kwargs = {"channel": GRAYSON_DM_CHANNEL, "text": text}
    if thread_ts:
        kwargs["thread_ts"] = thread_ts
    response = client.chat_postMessage(**kwargs)
    return response["ts"]


def send_to_channel(channel: str, text: str) -> str:
    """Send to any channel. Only call after explicit user confirmation for non-Grayson channels."""
    client = _get_client()
    response = client.chat_postMessage(channel=channel, text=text)
    return response["ts"]


def get_dm_history(limit: int = 20) -> list[SlackMessage]:
    client = _get_client()
    try:
        result = client.conversations_history(
            channel=GRAYSON_DM_CHANNEL, limit=limit
        )
        return [
            SlackMessage(
                channel=GRAYSON_DM_CHANNEL,
                user=m.get("user", "bot"),
                text=m.get("text", ""),
                ts=m.get("ts", ""),
                thread_ts=m.get("thread_ts"),
            )
            for m in result.get("messages", [])
        ]
    except SlackApiError as e:
        return []


def post_briefing(text: str) -> str:
    """Convenience: post the morning briefing to Grayson's DM."""
    return send_to_grayson(text)


if __name__ == "__main__":
    token = os.getenv("SLACK_BOT_TOKEN")
    if not token:
        print("SLACK_BOT_TOKEN not set — skipping Slack test.")
    else:
        history = get_dm_history(limit=5)
        print(f"Last {len(history)} DM messages loaded.")
        for m in history[:3]:
            print(f"  [{m.ts}] {m.user}: {m.text[:60]}")
