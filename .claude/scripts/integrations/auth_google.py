#!/opt/homebrew/bin/python3
"""
auth_google.py — Shared Google OAuth2 helper.
Loads credentials from the existing token.json in the cleetus project root.
Never exposes tokens to Claude — Python handles auth, passes only data.
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

load_dotenv(Path(__file__).parents[4] / ".env")

# CLEETUS_ROOT points to the directory containing token.json and credentials.json
_CREDS_ROOT = Path(os.environ.get("CLEETUS_ROOT", str(Path(__file__).parents[4])))
_TOKEN_PATH = _CREDS_ROOT / "token.json"
_CREDS_PATH = _CREDS_ROOT / "credentials.json"

# Full scope set for initial authorization (auth.py / re-auth flow).
# Existing token may only have a subset — that's fine, it knows its own scopes.
ALL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",          # full read+write (was readonly)
    "https://www.googleapis.com/auth/drive.readonly",
]


def get_credentials() -> Credentials:
    if not _TOKEN_PATH.exists():
        raise FileNotFoundError(
            f"token.json not found at {_TOKEN_PATH}. "
            "Run auth.py from the cleetus project root to generate it."
        )
    # Don't force scopes on load — let the token use what it was issued with.
    # Passing a broader scope list causes RefreshError if token was narrower.
    creds = Credentials.from_authorized_user_file(str(_TOKEN_PATH))
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        _TOKEN_PATH.write_text(creds.to_json())
    return creds


def gmail_service():
    return build("gmail", "v1", credentials=get_credentials())


def calendar_service():
    return build("calendar", "v3", credentials=get_credentials())


def drive_service():
    return build("drive", "v3", credentials=get_credentials())
