#!/opt/homebrew/bin/python3
"""
scan_booking_threads.py — Pull STEAP booking threads from Gmail.
Returns JSON list of thread summaries to stdout.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[3] / "scripts"))
os.environ.setdefault("CLEETUS_ROOT", str(Path(__file__).parents[4]))

from integrations.gmail import search_threads, GmailThread

QUERY = (
    '(STEAP OR "Sweet Tea Pedigree") '
    "(booking OR venue OR show OR gig OR inquiry OR follow)"
)


def main(max_results: int = 20):
    threads = search_threads(QUERY, max_results=max_results)
    output = [
        {
            "thread_id": t.thread_id,
            "subject": t.subject,
            "sender": t.sender,
            "snippet": t.snippet,
            "date": t.date,
            "unread": t.unread,
        }
        for t in threads
    ]
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--max", type=int, default=20)
    args = p.parse_args()
    main(args.max)
