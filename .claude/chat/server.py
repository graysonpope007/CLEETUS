#!/opt/homebrew/bin/python3
"""
server.py — Cleetus chat server entry point.
Starts the Slack Socket Mode adapter and wires it to the core reasoning loop.
Runs continuously as a background process (managed by launchd).

Usage: python3 .claude/chat/server.py
"""
import os
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
os.environ.setdefault("CLEETUS_ROOT", "/Users/grayson/cleetus")

from dotenv import load_dotenv
load_dotenv(Path(os.environ["CLEETUS_ROOT"]) / ".env")

from adapters.slack_adapter import SlackAdapter
from core import handle_message


def main():
    print("Cleetus chat server starting…")

    adapter = SlackAdapter()
    adapter.on_message(lambda msg: handle_message(adapter, msg))
    adapter.start()

    # Keep alive — Socket Mode client runs in background threads
    def _shutdown(sig, frame):
        print("Shutting down…")
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print("Ready. Waiting for messages.")
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
