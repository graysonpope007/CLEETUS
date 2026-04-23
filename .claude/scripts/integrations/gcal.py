#!/opt/homebrew/bin/python3
"""
gcal.py — Google Calendar integration module.
Read-only. Shared OAuth token with Gmail.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from .auth_google import calendar_service

ET_OFFSET_HOURS = -4  # EDT; -5 EST


@dataclass
class CalEvent:
    event_id: str
    title: str
    start: str      # ISO8601
    end: str        # ISO8601
    location: str
    description: str
    all_day: bool
    attendees: list[str]


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def list_events(days_ahead: int = 1, days_back: int = 0) -> list[CalEvent]:
    svc = calendar_service()
    now = _now_utc()
    time_min = _iso(now - timedelta(days=days_back))
    time_max = _iso(now + timedelta(days=days_ahead))

    result = svc.events().list(
        calendarId="primary",
        timeMin=time_min,
        timeMax=time_max,
        singleEvents=True,
        orderBy="startTime",
    ).execute()

    return [_parse_event(e) for e in result.get("items", [])]


def get_today_agenda() -> list[CalEvent]:
    return list_events(days_ahead=1, days_back=0)


def get_upcoming(days: int = 14) -> list[CalEvent]:
    return list_events(days_ahead=days, days_back=0)


def events_containing(keyword: str, days: int = 30) -> list[CalEvent]:
    events = get_upcoming(days=days)
    kw = keyword.lower()
    return [e for e in events if kw in e.title.lower() or kw in e.description.lower()]


def _parse_event(raw: dict) -> CalEvent:
    start_raw = raw.get("start", {})
    end_raw = raw.get("end", {})
    all_day = "date" in start_raw and "dateTime" not in start_raw
    return CalEvent(
        event_id=raw.get("id", ""),
        title=raw.get("summary", "Untitled"),
        start=start_raw.get("dateTime", start_raw.get("date", "")),
        end=end_raw.get("dateTime", end_raw.get("date", "")),
        location=raw.get("location", ""),
        description=raw.get("description", ""),
        all_day=all_day,
        attendees=[
            a.get("email", "") for a in raw.get("attendees", [])
            if a.get("responseStatus") != "declined"
        ],
    )


if __name__ == "__main__":
    events = get_today_agenda()
    if not events:
        print("No events today.")
    for e in events:
        label = "All day" if e.all_day else e.start[11:16]
        print(f"{label} — {e.title}")
        if e.location:
            print(f"  @ {e.location}")
