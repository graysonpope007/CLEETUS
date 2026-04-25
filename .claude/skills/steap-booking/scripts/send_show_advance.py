#!/usr/bin/env python3
"""
STEAP Show Advance Sender
Generates the standard show advance email for a confirmed booking.

Usage:
    python3 send_show_advance.py --venue "Live Wire Athens" --date 2026-05-10 [--dry-run]
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

CLEETUS_ROOT = Path(os.environ.get("CLEETUS_ROOT", Path.home() / "cleetus"))
load_dotenv(CLEETUS_ROOT / ".env", override=True)

# scripts/ lives inside steap-booking/scripts/ — resolve the skill root from __file__
# Path: .../naughty-fermat-4efa9a/.claude/skills/steap-booking/scripts/send_show_advance.py
SKILLS_DIR = Path(__file__).parent.parent          # .../steap-booking/
# parents[2] = naughty-fermat-4efa9a/
VAULT = SKILLS_DIR.parents[2] / "vault"
ADVANCES_DIR = VAULT / "30-Projects" / "STEAP" / "Advances"

VENUES = {
    "40 watt": {
        "name": "40 Watt Club",
        "contact_email": "velenavego@gmail.com",
        "address": "285 W. Washington Street, Athens, GA 30601",
    },
    "georgia theatre": {
        "name": "Georgia Theatre",
        "contact_email": "margarita@zeromile.com",
        "address": "695 N. Milledge Ave, Athens, GA 30601",
    },
    "live wire": {
        "name": "Live Wire Athens",
        "contact_email": None,
        "contact_phone": "470-236-2069",
        "address": "227 West Dougherty Street, Athens, GA",
    },
    "flicker": {
        "name": "Flicker Theatre & Bar",
        "contact_email": "flickerbooking@gmail.com",
        "address": "263 W. Washington St., Athens, GA 30601",
    },
    "hendershots": {
        "name": "Hendershots",
        "contact_email": None,
        "address": "237 Prince Ave, Athens, GA 30606",
    },
}


def find_venue(query: str) -> dict | None:
    q = query.lower().strip()
    for key, data in VENUES.items():
        if key in q or q in key or q in data["name"].lower():
            return data
    return None


def format_date(date_str: str) -> str:
    """Format date string nicely, e.g. '2026-05-10' -> 'May 10, 2026'."""
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return dt.strftime("%B %-d, %Y")
    except ValueError:
        return date_str


def generate_advance(venue_data: dict, date_str: str) -> str:
    """Generate the advance email body."""
    date_formatted = format_date(date_str)
    template_path = SKILLS_DIR / "templates" / "show-advance.txt"
    template = template_path.read_text()
    return template.replace("{DATE}", date_formatted)


def save_advance(venue_data: dict, advance_text: str, date_str: str) -> Path:
    """Save advance to vault/30-Projects/STEAP/Advances/."""
    ADVANCES_DIR.mkdir(parents=True, exist_ok=True)
    venue_slug = venue_data["name"].lower().replace(" ", "-").replace("'", "").replace("&", "and")
    filename = f"{date_str}_{venue_slug}_advance.md"
    filepath = ADVANCES_DIR / filename

    contact_email = venue_data.get("contact_email") or "(see venue notes)"
    subject = f"Sweet Tea Pedigree / {format_date(date_str)} / Show Advance"

    content = f"""---
type: advance
venue: {venue_data['name']}
date: {date_str}
to: {contact_email}
subject: {subject}
status: draft
created: {datetime.now().strftime('%Y-%m-%d')}
---

## Show Advance

**To:** {contact_email}
**Subject:** {subject}

---

{advance_text}
"""
    filepath.write_text(content)
    return filepath


def main():
    parser = argparse.ArgumentParser(description="Generate STEAP show advance")
    parser.add_argument("--venue", required=True, help="Venue name")
    parser.add_argument("--date", required=True, help="Show date (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true", help="Print without saving")
    args = parser.parse_args()

    venue_data = find_venue(args.venue)
    if not venue_data:
        print(f"Venue '{args.venue}' not found. Known venues:")
        for v in VENUES.values():
            print(f"  - {v['name']}")
        sys.exit(1)

    print(f"Generating advance for: {venue_data['name']} on {format_date(args.date)}")
    print(f"Contact: {venue_data.get('contact_email') or venue_data.get('contact_phone') or 'TBD'}")
    print()

    advance_text = generate_advance(venue_data, args.date)

    print("=" * 60)
    print(advance_text)
    print("=" * 60)

    if args.dry_run:
        print("\n[DRY RUN — not saved]")
        return

    saved = save_advance(venue_data, advance_text, args.date)
    print(f"\nAdvance saved: {saved.relative_to(CLEETUS_ROOT)}")
    print("Review and send from your email client.")


if __name__ == "__main__":
    main()
