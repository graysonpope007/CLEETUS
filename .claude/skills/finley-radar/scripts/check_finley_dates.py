#!/opt/homebrew/bin/python3
"""
check_finley_dates.py — Find upcoming Finley dates from Google Calendar
plus hardcoded Dec 20 birthday check.
Returns JSON list of upcoming occasions.
"""
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[3] / "scripts"))
os.environ.setdefault("CLEETUS_ROOT", str(Path(__file__).parents[4]))

from integrations.gcal import events_containing, get_upcoming

FINLEY_KEYWORDS = ["finley", "anniversary", "date night"]
BIRTHDAY_MONTH = 12
BIRTHDAY_DAY = 20
DEFAULT_WINDOW_DAYS = 14


def birthday_check(window_days: int) -> dict | None:
    today = date.today()
    this_year_birthday = date(today.year, BIRTHDAY_MONTH, BIRTHDAY_DAY)
    next_year_birthday = date(today.year + 1, BIRTHDAY_MONTH, BIRTHDAY_DAY)

    for birthday in [this_year_birthday, next_year_birthday]:
        delta = (birthday - today).days
        if 0 <= delta <= window_days:
            return {
                "occasion": "birthday",
                "date": birthday.isoformat(),
                "days_away": delta,
                "source": "hardcoded",
                "title": "Finley's Birthday",
            }
    return None


def calendar_check(window_days: int) -> list[dict]:
    results = []
    events = get_upcoming(days=window_days)
    for event in events:
        title_lower = event.title.lower()
        if any(kw in title_lower for kw in FINLEY_KEYWORDS):
            start_date = event.start[:10]
            today = date.today().isoformat()
            delta = (date.fromisoformat(start_date) - date.today()).days
            results.append({
                "occasion": "calendar",
                "date": start_date,
                "days_away": delta,
                "source": "google_calendar",
                "title": event.title,
            })
    return results


def main(window_days: int = DEFAULT_WINDOW_DAYS):
    occasions = []

    bday = birthday_check(window_days)
    if bday:
        occasions.append(bday)

    occasions.extend(calendar_check(window_days))

    # Deduplicate by date
    seen = set()
    unique = []
    for o in occasions:
        if o["date"] not in seen:
            seen.add(o["date"])
            unique.append(o)

    print(json.dumps(unique, indent=2))
    if unique:
        print(f"\n{len(unique)} upcoming Finley occasion(s).", file=sys.stderr)
    else:
        print("No Finley dates in the next {window_days} days.", file=sys.stderr)


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS)
    args = p.parse_args()
    main(args.days)
