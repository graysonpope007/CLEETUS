#!/opt/homebrew/bin/python3
"""
slack_adapter.py — Slack Socket Mode adapter.
Listens on DM channel D0AMJ560C2W. Each thread_ts = separate session.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Callable

from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[4] / ".env")

from slack_sdk import WebClient
from slack_sdk.socket_mode import SocketModeClient
from slack_sdk.socket_mode.request import SocketModeRequest
from slack_sdk.socket_mode.response import SocketModeResponse

from .base import IncomingMessage, PlatformAdapter

GRAYSON_DM = "D0AMJ560C2W"


class SlackAdapter:
    def __init__(self):
        bot_token = os.environ.get("SLACK_BOT_TOKEN")
        app_token = os.environ.get("SLACK_APP_TOKEN")
        if not bot_token or not app_token:
            raise EnvironmentError(
                "SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env. "
                "Create a Slack App with Socket Mode enabled."
            )
        self.web_client = WebClient(token=bot_token)
        self.socket_client = SocketModeClient(
            app_token=app_token,
            web_client=self.web_client,
        )
        self._on_message: Callable[[IncomingMessage], None] | None = None

    def thread_id(self, message: IncomingMessage) -> str:
        ts = message.thread_ts or message.channel_id
        return f"slack:{message.channel_id}:{ts}"

    def send(self, text: str, reply_to: IncomingMessage) -> None:
        kwargs = {"channel": reply_to.channel_id, "text": text}
        if reply_to.thread_ts:
            kwargs["thread_ts"] = reply_to.thread_ts
        self.web_client.chat_postMessage(**kwargs)

    def on_message(self, handler: Callable[[IncomingMessage], None]):
        self._on_message = handler

    def _handle_event(self, client: SocketModeClient, req: SocketModeRequest):
        client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))

        if req.type != "events_api":
            return
        event = req.payload.get("event", {})
        if event.get("type") != "message":
            return
        if event.get("subtype"):  # skip bot messages, edits, etc.
            return
        if event.get("channel") != GRAYSON_DM:
            return  # only respond in Grayson's DM

        msg = IncomingMessage(
            text=event.get("text", ""),
            sender_id=event.get("user", ""),
            channel_id=event.get("channel", ""),
            thread_ts=event.get("thread_ts") or event.get("ts"),
            platform="slack",
        )
        if self._on_message:
            threading.Thread(target=self._on_message, args=(msg,), daemon=True).start()

    def start(self):
        self.socket_client.socket_mode_request_listeners.append(self._handle_event)
        self.socket_client.connect()
        print("Slack adapter connected (Socket Mode). Listening on DM D0AMJ560C2W…")
