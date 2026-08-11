#!/opt/homebrew/bin/python3
"""
flag_stale_threads.py — Find STEAP booking threads where Grayson hasn't replied in > N days.
Reads thread list from scan_booking_threads.py, fetches full threads, checks last sender.
Outputs stale thread IDs + subjects to stdout.
"""
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[3] / "scripts"))
os.environ.setdefault("CLEETUS_ROOT", str(Path(__file__).parents[4]))

from integrations.gmail import get_thread, search_threads

GRAYSON_EMAIL_FRAGMENTS = ["grayson", "gpope", "goodlifemusic"]  # partial matches
QUERY = (
    '(STEAP OR "Sweet Tea Pedigree") '
    "(booking OR venue OR show OR gig OR inquiry OR follow)"
)


def is_grayson(sender: str) -> bool:
    sender_lower = sender.lower()
    return any(frag in sender_lower for frag in GRAYSON_EMAIL_FRAGMENTS)


def parse_date(date_str: str) -> datetime | None:
    try:
        return parsedate_to_datetime(date_str)
    except Exception:
        return None


def main(days_stale: int = 5, max_threads: int = 20):
    threads = search_threads(QUERY, max_results=max_threads)
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days_stale)

    stale = []
    for t in threads:
        messages = get_thread(t.thread_id)
        if not messages:
            continue
        last_msg = messages[-1]
        last_date = parse_date(last_msg.date)

        if last_date and last_date < cutoff and not is_grayson(last_msg.sender):
            days_ago = (now - last_date).days
            stale.append({
                "thread_id": t.thread_id,
                "subject": t.subject,
                "last_sender": last_msg.sender,
                "days_since_reply": days_ago,
                "snippet": t.snippet,
            })

    print(json.dumps(stale, indent=2))
    if stale:
        print(f"\n{len(stale)} stale thread(s) found (>{days_stale} days without Grayson reply).",
              file=sys.stderr)


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=5)
    p.add_argument("--max", type=int, default=20)
    args = p.parse_args()
    main(days_stale=args.days, max_threads=args.max)
