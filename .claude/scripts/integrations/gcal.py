#!/opt/homebrew/bin/python3
"""
gcal.py — Google Calendar integration module.
Read + write. Shared OAuth token with Gmail (requires calendar scope, not just readonly).
Re-run auth.py if you get a 403 — the token needs the full calendar scope.
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


STEAP_CALENDAR_ID = "33ad875b74640fe961001763256b347def6422496ee9e099b3f0628b260c7134@group.calendar.google.com"


def create_event(
    summary: str,
    start_dt: str,          # ISO8601 datetime string e.g. "2026-06-15T21:00:00"
    end_dt: str,
    calendar_id: str = STEAP_CALENDAR_ID,
    location: str = "",
    description: str = "",
    timezone: str = "America/New_York",
    color_id: str = "10",   # 10 = Basil green
) -> str:
    """Create a calendar event. Returns the event ID."""
    svc = calendar_service()
    body = {
        "summary": summary,
        "location": location,
        "description": description,
        "start": {"dateTime": start_dt, "timeZone": timezone},
        "end": {"dateTime": end_dt, "timeZone": timezone},
        "colorId": color_id,
    }
    result = svc.events().insert(calendarId=calendar_id, body=body).execute()
    return result["id"]


def update_event(
    event_id: str,
    updates: dict,
    calendar_id: str = STEAP_CALENDAR_ID,
) -> None:
    """Update fields on an existing calendar event."""
    svc = calendar_service()
    event = svc.events().get(calendarId=calendar_id, eventId=event_id).execute()
    event.update(updates)
    svc.events().update(calendarId=calendar_id, eventId=event_id, body=event).execute()


def delete_event(event_id: str, calendar_id: str = STEAP_CALENDAR_ID) -> None:
    """Delete a calendar event."""
    svc = calendar_service()
    svc.events().delete(calendarId=calendar_id, eventId=event_id).execute()


def list_steap_events(days_ahead: int = 120) -> list[CalEvent]:
    """List upcoming events on the STEAP calendar."""
    svc = calendar_service()
    now = _now_utc()
    result = svc.events().list(
        calendarId=STEAP_CALENDAR_ID,
        timeMin=_iso(now),
        timeMax=_iso(now + timedelta(days=days_ahead)),
        singleEvents=True,
        orderBy="startTime",
    ).execute()
    return [_parse_event(e) for e in result.get("items", [])]


if __name__ == "__main__":
    events = get_today_agenda()
    if not events:
        print("No events today.")
    for e in events:
        label = "All day" if e.all_day else e.start[11:16]
        print(f"{label} — {e.title}")
        if e.location:
            print(f"  @ {e.location}")
