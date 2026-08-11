#!/usr/bin/env python3
"""
band_finder.py — Find compatible co-bill bands for STEAP via web + social search.

Searches Instagram/TikTok hashtags, Flagpole, OTM, and venue calendars
for bands that would make good co-bills or opening acts.

Usage:
    python3 band_finder.py search                    # full search run
    python3 band_finder.py search --location atlanta # target city
    python3 band_finder.py search --genre americana  # filter by genre
    python3 band_finder.py search --size small       # small/medium/large following
    python3 band_finder.py instagram-hashtag "#athensmusic"
    python3 band_finder.py venue-calendar "40 Watt"
    python3 band_finder.py --dry-run                 # print without saving to pipeline
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("CLEETUS_ROOT", str(Path(__file__).parents[3]))

from dotenv import load_dotenv
load_dotenv(Path(os.environ["CLEETUS_ROOT"]) / ".env", override=True)

import anthropic
import httpx

BRAVE_API_KEY = os.environ.get("BRAVE_SEARCH_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

STEAP_PROFILE = """
Band: Sweet Tea Pedigree (STEAP) — Athens, GA
Genre: Soulful Blues Rock / Southern Rock / Americana — blues, rock, soul, funk
Vibe: High-energy live show, crowd-participatory, mix of originals and covers
Audience: UGA students, Athens music fans, southern rock/Americana listeners 18-35
Credentials: Sold-out Georgia Theatre opener, Classic City Music Festival headline,
  11Alive Artists to Watch, support for Penelope Road / Hippie Sabotage / Houndmouth
Looking for co-bills/openers that: match energy, similar audience, Southeast-based,
  active on social, genres that complement (soul, R&B, indie rock, Americana, funk, blues)
"""

# Search queries tuned for finding Athens/Southeast bands
SEARCH_QUERIES = [
    "Athens GA indie band instagram 2026 southern rock soul",
    "Athens Georgia music scene emerging bands 2026",
    "UGA student band Athens Georgia instagram music",
    "Americana blues rock band Athens GA tiktok",
    "Good Life Music Athens GA roster artists",
    "Flagpole Athens music local bands 2026",
    "40 Watt Club Athens local band opener 2026",
    "Atlanta indie band instagram soul funk 2026 emerging",
    "southeast Americana folk rock band tiktok 2026",
]

INSTAGRAM_HASHTAGS = [
    "#athensmusic",
    "#athensga",
    "#ugamusic",
    "#athensband",
    "#southernrock",
    "#americanamusic",
    "#bluesrock",
    "#soulmusic",
    "#athensgamusic",
    "#classicrockathensg",
]


def brave_search(query: str, count: int = 5) -> list[dict]:
    """Run a Brave web search and return results."""
    if not BRAVE_API_KEY:
        return []
    try:
        r = httpx.get(
            "https://api.search.brave.com/res/v1/web/search",
            headers={
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "X-Subscription-Token": BRAVE_API_KEY,
            },
            params={"q": query, "count": count, "freshness": "py1"},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        return data.get("web", {}).get("results", [])
    except Exception as e:
        print(f"  [search error: {e}]")
        return []


def extract_band_leads(search_results: list[dict], context: str) -> list[dict]:
    """Use Claude Haiku to extract band leads from search results."""
    if not ANTHROPIC_API_KEY or not search_results:
        return []

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    results_text = "\n\n".join([
        f"Title: {r.get('title', '')}\nURL: {r.get('url', '')}\nSnippet: {r.get('description', '')}"
        for r in search_results
    ])

    prompt = f"""You are finding co-bill band leads for Sweet Tea Pedigree.

STEAP PROFILE:
{STEAP_PROFILE}

SEARCH CONTEXT: {context}

SEARCH RESULTS:
{results_text}

Extract any bands mentioned that could be good co-bill partners for STEAP.
For each band found, output a JSON array with objects containing:
- name: band name
- instagram: Instagram handle (no @ prefix) or null
- tiktok: TikTok handle or null
- genre: genre description
- hometown: city/state if mentioned
- why_good_fit: 1 sentence on why they'd work as a co-bill
- source_url: the URL where you found them

Output ONLY a valid JSON array. If no bands found, output [].
Do not include STEAP itself."""

    try:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()
        # Extract JSON
        if "```" in text:
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        return json.loads(text)
    except Exception as e:
        print(f"  [extraction error: {e}]")
        return []


def search_venue_calendar(venue_name: str) -> list[dict]:
    """Search for bands currently playing a venue."""
    venue_queries = {
        "40 watt": "40 Watt Club Athens GA upcoming shows bands 2026",
        "georgia theatre": "Georgia Theatre Athens GA upcoming local bands 2026",
        "live wire": "Live Wire Athens upcoming shows local bands 2026",
        "flicker": "Flicker Theatre Bar Athens upcoming shows 2026",
    }
    key = venue_name.lower().strip()
    query = next((v for k, v in venue_queries.items() if k in key), f"{venue_name} upcoming shows local bands 2026")
    results = brave_search(query)
    return extract_band_leads(results, f"Finding bands on the {venue_name} calendar")


def search_instagram_hashtag(hashtag: str) -> list[dict]:
    """Search for bands using an Instagram hashtag via web search."""
    # We can't hit Instagram's API directly, but web search surfaces IG posts
    query = f'site:instagram.com {hashtag} band music Athens Georgia'
    results = brave_search(query)
    return extract_band_leads(results, f"Instagram hashtag {hashtag}")


def run_full_search(location: str = "Athens GA", genre: str = None, dry_run: bool = False) -> list[dict]:
    """Run comprehensive band discovery search."""
    all_leads: list[dict] = []
    seen_names: set[str] = set()

    print(f"🔍 Searching for co-bill bands ({location}, {genre or 'all genres'})...\n")

    # 1. Brave web searches
    queries = SEARCH_QUERIES.copy()
    if location and location.lower() not in ("athens ga", "athens"):
        queries = [q.replace("Athens GA", location).replace("Athens Georgia", location) for q in queries[:4]]
    if genre:
        queries = [f"{q} {genre}" for q in queries[:3]]

    for query in queries[:5]:  # Limit to 5 queries to respect rate limits
        print(f"  Searching: {query[:60]}...")
        results = brave_search(query)
        leads = extract_band_leads(results, query)
        for lead in leads:
            name = lead.get("name", "").lower()
            if name and name not in seen_names and "sweet tea" not in name:
                seen_names.add(name)
                all_leads.append(lead)

    # 2. Venue calendar checks
    print("\n  Checking venue calendars...")
    for venue in ["40 Watt", "Georgia Theatre", "Live Wire Athens"]:
        results = brave_search(f"{venue} Athens GA 2026 local band opener support")
        leads = extract_band_leads(results, f"{venue} calendar")
        for lead in leads:
            name = lead.get("name", "").lower()
            if name and name not in seen_names and "sweet tea" not in name:
                seen_names.add(name)
                all_leads.append(lead)

    # 3. GLM / OTM ecosystem
    print("  Checking GLM/OTM ecosystem...")
    results = brave_search("Good Life Music Athens GA roster artists 2026 instagram")
    results += brave_search("On The Map OTM Athens GA featured artists 2026")
    leads = extract_band_leads(results, "GLM and OTM artist ecosystem")
    for lead in leads:
        name = lead.get("name", "").lower()
        if name and name not in seen_names and "sweet tea" not in name:
            seen_names.add(name)
            all_leads.append(lead)

    return all_leads


def save_to_pipeline(leads: list[dict]):
    """Add discovered bands to the booking pipeline DB."""
    try:
        import sqlite3
        from pathlib import Path
        db_path = Path(os.environ["CLEETUS_ROOT"]) / ".cache" / "booking_pipeline.sqlite"
        if not db_path.exists():
            print("  Pipeline DB not found. Run booking_pipeline.py first.")
            return
        conn = sqlite3.connect(str(db_path))
        now = datetime.utcnow().isoformat()
        added = 0
        for lead in leads:
            name = lead.get("name")
            if not name:
                continue
            # Check for duplicate
            exists = conn.execute("SELECT id FROM bands WHERE LOWER(name)=LOWER(?)", (name,)).fetchone()
            if exists:
                continue
            conn.execute("""
                INSERT INTO bands (name, instagram, tiktok, genre, hometown, status, notes, created_at)
                VALUES (?, ?, ?, ?, ?, 'lead', ?, ?)
            """, (name, lead.get("instagram"), lead.get("tiktok"), lead.get("genre"),
                  lead.get("hometown"), lead.get("why_good_fit"), now))
            added += 1
        conn.commit()
        conn.close()
        print(f"\n✅ Added {added} new band leads to pipeline.")
    except Exception as e:
        print(f"  [pipeline save error: {e}]")


def print_leads(leads: list[dict]):
    if not leads:
        print("\nNo leads found. Try different search terms.")
        return
    print(f"\n── BAND LEADS FOUND ({len(leads)}) ──────────────────────────")
    for i, lead in enumerate(leads, 1):
        ig = f"@{lead['instagram']}" if lead.get("instagram") else ""
        tt = f"TikTok: @{lead['tiktok']}" if lead.get("tiktok") else ""
        print(f"\n{i}. {lead.get('name', 'Unknown')}")
        if ig or tt:
            print(f"   {ig}  {tt}".strip())
        if lead.get("genre"):
            print(f"   Genre: {lead['genre']}")
        if lead.get("hometown"):
            print(f"   From: {lead['hometown']}")
        if lead.get("why_good_fit"):
            print(f"   Fit: {lead['why_good_fit']}")


def main():
    parser = argparse.ArgumentParser(description="STEAP Band Finder")
    sub = parser.add_subparsers(dest="command")

    # search
    sp = sub.add_parser("search", help="Full band discovery search")
    sp.add_argument("--location", default="Athens GA", help="Target market")
    sp.add_argument("--genre", help="Genre filter (e.g. americana, soul, indie)")
    sp.add_argument("--dry-run", action="store_true", help="Print without saving")

    # instagram-hashtag
    ihp = sub.add_parser("instagram-hashtag", help="Search IG hashtag for bands")
    ihp.add_argument("hashtag", help="e.g. #athensmusic")
    ihp.add_argument("--dry-run", action="store_true")

    # venue-calendar
    vcp = sub.add_parser("venue-calendar", help="Find bands on venue calendar")
    vcp.add_argument("venue", help="e.g. '40 Watt'")
    vcp.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()

    if not args.command or args.command == "search":
        location = getattr(args, "location", "Athens GA")
        genre = getattr(args, "genre", None)
        dry_run = getattr(args, "dry_run", False)
        leads = run_full_search(location=location, genre=genre, dry_run=dry_run)
        print_leads(leads)
        if not dry_run and leads:
            save_to_pipeline(leads)
            print("\nRun `booking_pipeline.py list-bands` to see all leads.")

    elif args.command == "instagram-hashtag":
        leads = search_instagram_hashtag(args.hashtag)
        print_leads(leads)
        if not args.dry_run and leads:
            save_to_pipeline(leads)

    elif args.command == "venue-calendar":
        leads = search_venue_calendar(args.venue)
        print_leads(leads)
        if not args.dry_run and leads:
            save_to_pipeline(leads)


if __name__ == "__main__":
    main()
