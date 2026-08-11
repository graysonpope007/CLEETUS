#!/usr/bin/env python3
"""
STEAP Booking Pitch Generator
Generates a personalized booking pitch for a target venue and optionally emails it.

Usage:
    python3 generate_booking_pitch.py --venue "40 Watt" [--date 2026-06-15] [--dry-run] [--send]
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

# Load env
CLEETUS_ROOT = Path(os.environ.get("CLEETUS_ROOT", Path.home() / "cleetus"))
load_dotenv(CLEETUS_ROOT / ".env", override=True)

sys.path.insert(0, str(CLEETUS_ROOT / ".claude" / "scripts"))

VAULT = CLEETUS_ROOT / "vault"
DRAFTS_DIR = VAULT / "drafts" / "active"
SKILLS_DIR = CLEETUS_ROOT / ".claude" / "skills" / "steap-booking"

# Venue database — pulled from Athens-Venues.md
VENUES = {
    "40 watt": {
        "name": "40 Watt Club",
        "contact_name": None,
        "contact_email": "velenavego@gmail.com",
        "phone": "706.549.7871",
        "capacity": "~500",
        "tier": 1,
        "notes": "One of the most iconic rock clubs in the world. STEAP has already played here to a crowd of 300.",
        "pitch_angle": "We've already played the 40 Watt to a crowd of 300 — we'd love to come back for a proper headlining slot.",
    },
    "georgia theatre": {
        "name": "Georgia Theatre",
        "contact_name": "Margarita Rios",
        "contact_email": "margarita@zeromile.com",
        "phone": None,
        "capacity": "~1,000",
        "tier": 1,
        "notes": "STEAP opened a sold-out show here on March 31, 2026. Amelia Duffner is a former intern.",
        "pitch_angle": "We opened a sold-out show at the Georgia Theatre on March 31st — we'd love to talk about what a return booking could look like.",
    },
    "live wire": {
        "name": "Live Wire Athens",
        "contact_name": "AJ Steele",
        "contact_email": None,
        "phone": "470-236-2069",
        "capacity": "1,000 total / Robertson Hall 275",
        "tier": 1,
        "notes": "Family-run, 100–135 events/year, 90% local. Strong community venue.",
        "pitch_angle": "We're an Athens-based band building real momentum and looking to get on your calendar.",
    },
    "hendershots": {
        "name": "Hendershots",
        "contact_name": None,
        "contact_email": None,
        "phone": None,
        "capacity": "Intimate",
        "tier": 2,
        "notes": "Five Points neighborhood. Best fit for acoustic or stripped-down STEAP sets.",
        "pitch_angle": "We'd love to bring an acoustic or stripped-down set to your room.",
    },
    "flicker": {
        "name": "Flicker Theatre & Bar",
        "contact_name": None,
        "contact_email": "flickerbooking@gmail.com",
        "phone": "(706) 546-0039",
        "capacity": "~100–200",
        "tier": 2,
        "notes": "Edgier/experimental focus — not primary fit but worth monitoring for cross-genre bills.",
        "pitch_angle": "We'd love to explore a cross-genre bill with your calendar.",
    },
    "smiths": {
        "name": "Smith's Olde Bar",
        "contact_name": None,
        "contact_email": None,
        "phone": None,
        "capacity": "Café Bleu",
        "tier": 3,
        "notes": "STEAP played Café Bleu showcase November 8, 2025 — sold out.",
        "pitch_angle": "We sold out the Café Bleu showcase back in November — we'd love to come back.",
    },
}

BAND_CREDENTIALS = [
    "sold-out Georgia Theatre opener (March 31, 2026)",
    "Classic City Music Festival headliner (April 2026)",
    "11Alive Atlanta 'Artists to Watch' (February 2026)",
    "300-person crowd at the 40 Watt",
    "support slots with Penelope Road, Hippie Sabotage, Houndmouth",
    "sold out Smith's Olde Bar Café Bleu showcase (November 2025)",
    "debut single 'Wayback' on all major platforms",
]


def find_venue(query: str) -> dict | None:
    """Fuzzy match venue name from our database."""
    q = query.lower().strip()
    for key, data in VENUES.items():
        if key in q or q in key or q in data["name"].lower():
            return data
    return None


def generate_pitch(venue_data: dict, date_hint: str | None, dry_run: bool) -> str:
    """Use Claude Haiku to generate the personalized pitch."""
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    availability = date_hint or "late May / June 2026"
    contact = venue_data.get("contact_name") or "there"

    prompt = f"""You are drafting a booking inquiry email for Sweet Tea Pedigree (STEAP),
an Athens, Georgia soulful blues rock / southern rock band.

VENUE: {venue_data['name']}
CONTACT: {contact}
VENUE NOTES: {venue_data['notes']}
PITCH ANGLE: {venue_data['pitch_angle']}
AVAILABILITY: {availability}

BAND CREDENTIALS (pick the 2-3 most relevant):
{chr(10).join(f'- {c}' for c in BAND_CREDENTIALS)}

VOICE GUIDELINES:
- Warm, direct, Southern-friendly but professional
- ONE paragraph maximum for the body — bookers skim
- Include our availability window
- Never mention alcohol
- Sign off as "Grayson" (not "Grayson Pope")
- Lead with the strongest credential relevant to this venue

Write ONLY the email body (no subject line). Start with "Hello {contact}," and end with the signature block:

Grayson
sweetteapedigree@gmail.com
(706) 847-5109"""

    response = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=400,
        messages=[{"role": "user", "content": prompt}],
    )

    return response.content[0].text.strip()


def save_draft(venue_data: dict, pitch_text: str, date_hint: str | None) -> Path:
    """Save the pitch draft to vault/drafts/active/."""
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    venue_slug = venue_data["name"].lower().replace(" ", "-").replace("'", "").replace("&", "and")
    filename = f"{today}_booking_pitch_{venue_slug}.md"
    filepath = DRAFTS_DIR / filename

    contact_name = venue_data.get("contact_name") or "Booking"
    contact_email = venue_data.get("contact_email") or "(see venue notes)"
    subject = f"Sweet Tea Pedigree — Booking Inquiry / {date_hint or 'Spring-Summer 2026'}"

    content = f"""---
type: email
recipient: {contact_name} — {venue_data['name']}
to: {contact_email}
subject: {subject}
context: STEAP booking pitch
created: {today}
status: active
---

## Pitch Email

**To:** {contact_email}
**Subject:** {subject}

---

{pitch_text}

---

## Venue Context
{venue_data['notes']}

## Pitch Angle
{venue_data['pitch_angle']}
"""
    filepath.write_text(content)
    return filepath


def main():
    parser = argparse.ArgumentParser(description="Generate STEAP booking pitch")
    parser.add_argument("--venue", required=True, help="Venue name (e.g. '40 Watt', 'Georgia Theatre')")
    parser.add_argument("--date", help="Target date or window (e.g. '2026-06-15' or 'June 2026')")
    parser.add_argument("--dry-run", action="store_true", help="Print pitch without saving")
    parser.add_argument("--send", action="store_true", help="Send via Gmail after draft review (future feature)")
    args = parser.parse_args()

    venue_data = find_venue(args.venue)
    if not venue_data:
        print(f"Venue '{args.venue}' not found in database. Known venues:")
        for v in VENUES.values():
            print(f"  - {v['name']}")
        sys.exit(1)

    print(f"Generating pitch for: {venue_data['name']}")
    print(f"Contact: {venue_data.get('contact_name') or 'unknown'} ({venue_data.get('contact_email') or venue_data.get('phone') or 'see notes'})")
    print()

    pitch = generate_pitch(venue_data, args.date, args.dry_run)

    print("=" * 60)
    print(pitch)
    print("=" * 60)

    if args.dry_run:
        print("\n[DRY RUN — not saved]")
        return

    draft_path = save_draft(venue_data, pitch, args.date)
    print(f"\nDraft saved: {draft_path.relative_to(CLEETUS_ROOT)}")

    if args.send:
        print("\n[--send not yet wired to Gmail integration — open draft and send manually]")
        print(f"Email: {venue_data.get('contact_email') or 'see venue file'}")


if __name__ == "__main__":
    main()
