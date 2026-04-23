#!/opt/homebrew/bin/python3
"""
registry.py — Integration registry.
Tracks which integrations are available and whether they're configured.
"""
import os
from pathlib import Path

import os
from dotenv import load_dotenv, dotenv_values

_ENV_PATH = Path(__file__).parents[4] / ".env"
load_dotenv(_ENV_PATH)


def _env_set(key: str) -> bool:
    vals = dotenv_values(str(_ENV_PATH))
    return bool(vals.get(key))


def _token_exists() -> bool:
    root = Path(os.environ.get("CLEETUS_ROOT", str(Path(__file__).parents[4])))
    return (root / "token.json").exists()


INTEGRATIONS = {
    "gmail": {
        "description": "Gmail — read unread, search threads, build drafts",
        "enabled": lambda: _token_exists(),
        "module": "integrations.gmail",
    },
    "gcal": {
        "description": "Google Calendar — today's agenda, upcoming events",
        "enabled": lambda: _token_exists(),
        "module": "integrations.gcal",
    },
    "gdrive": {
        "description": "Google Drive — search and read files (read-only)",
        "enabled": lambda: _token_exists(),
        "module": "integrations.gdrive",
    },
    "slack": {
        "description": "Slack — DM history, send to Grayson, post briefing",
        "enabled": lambda: _env_set("SLACK_BOT_TOKEN"),
        "module": "integrations.slack_integration",
    },
}


def list_integrations() -> list[dict]:
    return [
        {
            "name": name,
            "description": info["description"],
            "enabled": info["enabled"](),
        }
        for name, info in INTEGRATIONS.items()
    ]


if __name__ == "__main__":
    for item in list_integrations():
        status = "OK" if item["enabled"] else "NOT CONFIGURED"
        print(f"  [{status:>14}] {item['name']:10} — {item['description']}")
