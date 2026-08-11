#!/usr/bin/env python3
"""
booking_pipeline.py — STEAP Show Booking Pipeline Manager

Tracks every venue pitch, hold, confirmed show, band lead, and
festival submission. Single source of truth for Grayson's booking
operation. Syncs confirmed shows to the STEAP Google Calendar.

Usage:
    python3 booking_pipeline.py pipeline                          # full view
    python3 booking_pipeline.py list-shows                        # upcoming confirmed shows
    python3 booking_pipeline.py add-pitch "40 Watt" --email velenavego@gmail.com --date 2026-06-15
    python3 booking_pipeline.py hold <id> --date 2026-06-15
    python3 booking_pipeline.py confirm <id> --set-time 21:00 --load-in 18:00
    python3 booking_pipeline.py decline <id> [--notes "too full this summer"]
    python3 booking_pipeline.py add-band "The Wraps" --instagram thewraps --genre "indie soul"
    python3 booking_pipeline.py list-bands
    python3 booking_pipeline.py calendar-sync                    # push confirmed shows to GCal
    python3 booking_pipeline.py summary                          # Slack-ready digest
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("CLEETUS_ROOT", str(Path(__file__).parents[3]))

from dotenv import load_dotenv
load_dotenv(Path(os.environ["CLEETUS_ROOT"]) / ".env", override=True)

DB_PATH = Path(os.environ["CLEETUS_ROOT"]) / ".cache" / "booking_pipeline.sqlite"
STEAP_CALENDAR_ID = "33ad875b74640fe961001763256b347def6422496ee9e099b3f0628b260c7134@group.calendar.google.com"


# ─── Database setup ───────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    _init_schema(conn)
    return conn


def _init_schema(conn: sqlite3.Connection):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS pitches (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        venue       TEXT NOT NULL,
        contact_name TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        target_date TEXT,           -- YYYY-MM-DD requested, may be NULL (open window)
        status      TEXT NOT NULL DEFAULT 'pitched',
        -- pitched | hold | confirmed | declined | cancelled | completed
        pitched_at  TEXT,
        notes       TEXT,
        advance_sent INTEGER DEFAULT 0,
        calendar_event_id TEXT,
        created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shows (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pitch_id    INTEGER REFERENCES pitches(id),
        venue       TEXT NOT NULL,
        show_date   TEXT NOT NULL,  -- YYYY-MM-DD
        load_in     TEXT,           -- HH:MM (24h)
        soundcheck  TEXT,
        set_time    TEXT,           -- HH:MM (24h)
        set_length_min INTEGER,
        deal_type   TEXT,           -- guarantee | door_split | vs | flat | tbd
        guarantee   INTEGER,        -- dollars
        door_split_pct INTEGER,     -- percent (e.g. 80)
        address     TEXT,
        dos_name    TEXT,           -- Day of Show contact name
        dos_phone   TEXT,
        dos_email   TEXT,
        advance_sent INTEGER DEFAULT 0,
        advance_path TEXT,
        calendar_event_id TEXT,
        settled     INTEGER DEFAULT 0,
        payout      INTEGER,        -- actual dollars received
        notes       TEXT,
        created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bands (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        instagram   TEXT,
        tiktok      TEXT,
        email       TEXT,
        phone       TEXT,
        genre       TEXT,
        hometown    TEXT,
        follower_count TEXT,
        status      TEXT DEFAULT 'lead',
        -- lead | contacted | interested | declined | booked | not_a_fit
        notes       TEXT,
        created_at  TEXT NOT NULL
    );
    """)
    conn.commit()


# ─── Helpers ──────────────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fmt_date(d: str | None) -> str:
    if not d:
        return "TBD"
    try:
        return datetime.strptime(d[:10], "%Y-%m-%d").strftime("%b %-d, %Y")
    except ValueError:
        return d


def fmt_time(t: str | None) -> str:
    if not t:
        return "TBD"
    try:
        return datetime.strptime(t, "%H:%M").strftime("%-I:%M %p")
    except ValueError:
        return t


STATUS_EMOJI = {
    "pitched":   "📤",
    "hold":      "⏳",
    "confirmed": "✅",
    "declined":  "❌",
    "cancelled": "🚫",
    "completed": "🎸",
    "lead":      "🎯",
    "contacted": "💬",
    "interested":"⭐",
    "booked":    "✅",
    "not_a_fit": "🚫",
}


# ─── Commands ────────────────────────────────────────────────────────────────

def cmd_add_pitch(args):
    conn = get_db()
    conn.execute("""
        INSERT INTO pitches (venue, contact_name, contact_email, contact_phone,
                             target_date, status, pitched_at, notes, created_at)
        VALUES (?, ?, ?, ?, ?, 'pitched', ?, ?, ?)
    """, (args.venue, args.contact_name, args.email, args.phone,
          args.date, now_iso(), args.notes, now_iso()))
    conn.commit()
    row = conn.execute("SELECT * FROM pitches ORDER BY id DESC LIMIT 1").fetchone()
    print(f"📤 Pitch added: #{row['id']} — {row['venue']}")
    if args.date:
        print(f"   Target date: {fmt_date(args.date)}")
    if args.email:
        print(f"   Contact: {args.contact_name or ''} {args.email}")


def cmd_hold(args):
    conn = get_db()
    row = conn.execute("SELECT * FROM pitches WHERE id=?", (args.id,)).fetchone()
    if not row:
        print(f"No pitch #{args.id}")
        sys.exit(1)
    conn.execute("""
        UPDATE pitches SET status='hold', target_date=COALESCE(?, target_date), notes=COALESCE(?, notes)
        WHERE id=?
    """, (args.date, args.notes, args.id))
    conn.commit()
    print(f"⏳ #{args.id} {row['venue']} → HOLD{f' ({fmt_date(args.date)})' if args.date else ''}")


def cmd_confirm(args):
    conn = get_db()
    row = conn.execute("SELECT * FROM pitches WHERE id=?", (args.id,)).fetchone()
    if not row:
        print(f"No pitch #{args.id}")
        sys.exit(1)

    show_date = args.date or row["target_date"]
    if not show_date:
        print("ERROR: Need a show date. Use --date YYYY-MM-DD")
        sys.exit(1)

    conn.execute("UPDATE pitches SET status='confirmed' WHERE id=?", (args.id,))

    # Check if show already exists
    existing = conn.execute("SELECT id FROM shows WHERE pitch_id=?", (args.id,)).fetchone()
    if existing:
        print(f"Show already exists (shows #{existing['id']}). Updating...")
        conn.execute("""
            UPDATE shows SET show_date=?, load_in=?, soundcheck=?, set_time=?,
                             set_length_min=?, deal_type=?, guarantee=?, address=?,
                             dos_name=?, dos_phone=?, dos_email=?, notes=?
            WHERE pitch_id=?
        """, (show_date, args.load_in, args.soundcheck, args.set_time,
              args.set_length, args.deal, args.guarantee, args.address,
              args.dos_name, args.dos_phone, args.dos_email, args.notes, args.id))
        show_id = existing["id"]
    else:
        conn.execute("""
            INSERT INTO shows (pitch_id, venue, show_date, load_in, soundcheck, set_time,
                               set_length_min, deal_type, guarantee, address,
                               dos_name, dos_phone, dos_email, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (args.id, row["venue"], show_date, args.load_in, args.soundcheck,
              args.set_time, args.set_length, args.deal, args.guarantee, args.address,
              args.dos_name, args.dos_phone, args.dos_email, args.notes, now_iso()))
        show_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    conn.commit()

    print(f"✅ CONFIRMED: {row['venue']} on {fmt_date(show_date)} (Show #{show_id})")
    if args.set_time:
        print(f"   Set time: {fmt_time(args.set_time)}{f'  ({args.set_length} min)' if args.set_length else ''}")
    if args.load_in:
        print(f"   Load-in: {fmt_time(args.load_in)}")
    if args.guarantee:
        print(f"   Deal: ${args.guarantee} guarantee")

    print("\nNext: run `calendar-sync` to push to STEAP calendar, then send the advance 2-3 weeks out.")


def cmd_decline(args):
    conn = get_db()
    row = conn.execute("SELECT * FROM pitches WHERE id=?", (args.id,)).fetchone()
    if not row:
        print(f"No pitch #{args.id}")
        sys.exit(1)
    conn.execute("UPDATE pitches SET status='declined', notes=COALESCE(?, notes) WHERE id=?",
                 (args.notes, args.id))
    conn.commit()
    print(f"❌ #{args.id} {row['venue']} → DECLINED. Logged.")


def cmd_pipeline(args):
    conn = get_db()
    pitches = conn.execute("""
        SELECT * FROM pitches ORDER BY
            CASE status
                WHEN 'confirmed' THEN 1
                WHEN 'hold' THEN 2
                WHEN 'pitched' THEN 3
                WHEN 'completed' THEN 4
                ELSE 5
            END, target_date ASC NULLS LAST
    """).fetchall()

    if not pitches:
        print("No pitches yet. Run: booking_pipeline.py add-pitch \"Venue Name\"")
        return

    print("\n── STEAP BOOKING PIPELINE ──────────────────────────────")
    for p in pitches:
        if p["status"] in ("declined", "cancelled"):
            continue
        e = STATUS_EMOJI.get(p["status"], "•")
        date_str = fmt_date(p["target_date"])
        contact = p["contact_email"] or p["contact_phone"] or "no contact"
        print(f"\n{e} #{p['id']}  {p['venue'].upper()}")
        print(f"   Status: {p['status'].upper()}   Date: {date_str}")
        if p["contact_name"] or contact != "no contact":
            print(f"   Contact: {p['contact_name'] or ''} {contact}".strip())
        if p["notes"]:
            print(f"   Notes: {p['notes'][:80]}")

    # Show confirmed shows detail
    shows = conn.execute("""
        SELECT s.*, p.venue FROM shows s
        LEFT JOIN pitches p ON s.pitch_id = p.id
        WHERE s.show_date >= date('now')
        ORDER BY s.show_date ASC
    """).fetchall()

    if shows:
        print("\n── UPCOMING CONFIRMED SHOWS ────────────────────────────")
        for s in shows:
            print(f"\n🎸 {s['venue']} — {fmt_date(s['show_date'])}")
            if s["set_time"]:
                print(f"   Set: {fmt_time(s['set_time'])}  Load-in: {fmt_time(s['load_in'])}")
            if s["guarantee"]:
                print(f"   Deal: ${s['guarantee']} guarantee")
            elif s["deal_type"]:
                print(f"   Deal: {s['deal_type']}")
            if not s["advance_sent"]:
                print(f"   ⚠️  ADVANCE NOT SENT")
            if not s["calendar_event_id"]:
                print(f"   📅 Not on calendar yet — run calendar-sync")
    print()


def cmd_list_shows(args):
    conn = get_db()
    shows = conn.execute("""
        SELECT s.* FROM shows s
        WHERE s.show_date >= date('now', '-7 days')
        ORDER BY s.show_date ASC
    """).fetchall()

    if not shows:
        print("No upcoming shows. Confirm a pitch first.")
        return

    for s in shows:
        cal = "📅" if s["calendar_event_id"] else "  "
        adv = "✉️ " if s["advance_sent"] else "  "
        print(f"{cal}{adv} {fmt_date(s['show_date'])}  {s['venue']}  {fmt_time(s['set_time'])}")


def cmd_add_band(args):
    conn = get_db()
    conn.execute("""
        INSERT INTO bands (name, instagram, tiktok, email, phone, genre, hometown,
                           follower_count, status, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lead', ?, ?)
    """, (args.name, args.instagram, args.tiktok, args.email, args.phone,
          args.genre, args.hometown, args.followers, args.notes, now_iso()))
    conn.commit()
    row = conn.execute("SELECT * FROM bands ORDER BY id DESC LIMIT 1").fetchone()
    print(f"🎯 Band lead added: #{row['id']} — {row['name']}")


def cmd_list_bands(args):
    conn = get_db()
    bands = conn.execute("""
        SELECT * FROM bands WHERE status NOT IN ('declined', 'not_a_fit')
        ORDER BY status, name
    """).fetchall()
    if not bands:
        print("No bands in pipeline. Run: booking_pipeline.py add-band \"Band Name\"")
        return
    print("\n── BAND LEADS ──────────────────────────────────────────")
    for b in bands:
        e = STATUS_EMOJI.get(b["status"], "•")
        ig = f"@{b['instagram']}" if b["instagram"] else ""
        print(f"{e} #{b['id']}  {b['name']}  {ig}  {b['genre'] or ''}  [{b['status']}]")
        if b["notes"]:
            print(f"     {b['notes'][:80]}")
    print()


def cmd_band_status(args):
    conn = get_db()
    conn.execute("UPDATE bands SET status=?, notes=COALESCE(?, notes) WHERE id=?",
                 (args.status, args.notes, args.id))
    conn.commit()
    row = conn.execute("SELECT * FROM bands WHERE id=?", (args.id,)).fetchone()
    print(f"Updated #{args.id} {row['name']} → {args.status}")


def cmd_calendar_sync(args):
    """Push confirmed, uncalendar'd shows to STEAP Google Calendar."""
    try:
        from integrations.auth_google import calendar_service
    except ImportError:
        print("ERROR: Google auth not available. Check token.json.")
        sys.exit(1)

    conn = get_db()
    shows = conn.execute("""
        SELECT s.*, p.venue as pitch_venue FROM shows s
        LEFT JOIN pitches p ON s.pitch_id = p.id
        WHERE s.calendar_event_id IS NULL
        AND s.show_date >= date('now')
        ORDER BY s.show_date ASC
    """).fetchall()

    if not shows:
        print("All confirmed shows already on calendar.")
        return

    svc = calendar_service()

    for s in shows:
        venue = s["venue"] or s["pitch_venue"] or "Show"
        show_date = s["show_date"]  # YYYY-MM-DD

        # Build event times
        if s["load_in"]:
            start_time = f"{show_date}T{s['load_in']}:00"
        elif s["set_time"]:
            start_time = f"{show_date}T{s['set_time']}:00"
        else:
            start_time = f"{show_date}T19:00:00"  # default 7pm

        # End time: set_time + set_length or load_in + 4 hours
        if s["set_time"] and s["set_length_min"]:
            from datetime import datetime, timedelta
            st = datetime.strptime(f"{show_date}T{s['set_time']}:00", "%Y-%m-%dT%H:%M:%S")
            end_dt = st + timedelta(minutes=int(s["set_length_min"]) + 30)
            end_time = end_dt.strftime("%Y-%m-%dT%H:%M:%S")
        elif s["load_in"]:
            from datetime import datetime, timedelta
            li = datetime.strptime(f"{show_date}T{s['load_in']}:00", "%Y-%m-%dT%H:%M:%S")
            end_time = (li + timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%S")
        else:
            end_time = f"{show_date}T23:00:00"

        # Build description
        desc_lines = ["🎸 Sweet Tea Pedigree — Confirmed Show"]
        if s["load_in"]:
            desc_lines.append(f"Load-in: {fmt_time(s['load_in'])}")
        if s["soundcheck"]:
            desc_lines.append(f"Soundcheck: {fmt_time(s['soundcheck'])}")
        if s["set_time"]:
            desc_lines.append(f"Set time: {fmt_time(s['set_time'])}" +
                              (f" ({s['set_length_min']} min)" if s["set_length_min"] else ""))
        if s["guarantee"]:
            desc_lines.append(f"Deal: ${s['guarantee']} guarantee")
        elif s["deal_type"]:
            desc_lines.append(f"Deal: {s['deal_type']}")
        if s["dos_name"] or s["dos_phone"]:
            desc_lines.append(f"DOS: {s['dos_name'] or ''} {s['dos_phone'] or s['dos_email'] or ''}".strip())
        if not s["advance_sent"]:
            desc_lines.append("⚠️ ADVANCE NOT SENT YET")
        if s["notes"]:
            desc_lines.append(f"\nNotes: {s['notes']}")

        event = {
            "summary": f"🎸 STEAP — {venue}",
            "location": s["address"] or venue,
            "description": "\n".join(desc_lines),
            "start": {"dateTime": start_time, "timeZone": "America/New_York"},
            "end": {"dateTime": end_time, "timeZone": "America/New_York"},
            "colorId": "10",  # Basil green
        }

        try:
            result = svc.events().insert(calendarId=STEAP_CALENDAR_ID, body=event).execute()
            event_id = result["id"]
            conn.execute("UPDATE shows SET calendar_event_id=? WHERE id=?", (event_id, s["id"]))
            conn.commit()
            print(f"📅 Added to STEAP calendar: {venue} on {fmt_date(show_date)}")
        except Exception as e:
            print(f"❌ Calendar error for {venue}: {e}")

    print("Calendar sync complete.")


def cmd_summary(args):
    """Slack-ready pipeline summary."""
    conn = get_db()
    confirmed = conn.execute(
        "SELECT COUNT(*) FROM pitches WHERE status='confirmed'").fetchone()[0]
    holds = conn.execute(
        "SELECT COUNT(*) FROM pitches WHERE status='hold'").fetchone()[0]
    pitched = conn.execute(
        "SELECT COUNT(*) FROM pitches WHERE status='pitched'").fetchone()[0]
    band_leads = conn.execute(
        "SELECT COUNT(*) FROM bands WHERE status='lead'").fetchone()[0]
    next_show = conn.execute(
        "SELECT venue, show_date FROM shows WHERE show_date >= date('now') ORDER BY show_date LIMIT 1"
    ).fetchone()

    print("*STEAP Booking Pipeline*")
    print(f"✅ Confirmed: {confirmed}  ⏳ Holds: {holds}  📤 Pitched: {pitched}")
    if next_show:
        print(f"🎸 Next show: {next_show['venue']} — {fmt_date(next_show['show_date'])}")
    print(f"🎯 Band leads: {band_leads}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="STEAP Booking Pipeline")
    sub = p.add_subparsers(dest="command")

    # add-pitch
    ap = sub.add_parser("add-pitch", help="Log a new venue pitch")
    ap.add_argument("venue", help="Venue name")
    ap.add_argument("--contact-name", dest="contact_name")
    ap.add_argument("--email")
    ap.add_argument("--phone")
    ap.add_argument("--date", help="Target show date YYYY-MM-DD")
    ap.add_argument("--notes")

    # hold
    hp = sub.add_parser("hold", help="Mark pitch as on hold")
    hp.add_argument("id", type=int)
    hp.add_argument("--date", help="Hold date YYYY-MM-DD")
    hp.add_argument("--notes")

    # confirm
    cp = sub.add_parser("confirm", help="Confirm a show from a pitch")
    cp.add_argument("id", type=int, help="Pitch ID")
    cp.add_argument("--date", help="Show date YYYY-MM-DD")
    cp.add_argument("--set-time", dest="set_time", help="Set time HH:MM (24h)")
    cp.add_argument("--load-in", dest="load_in", help="Load-in HH:MM (24h)")
    cp.add_argument("--soundcheck", help="Soundcheck HH:MM (24h)")
    cp.add_argument("--set-length", dest="set_length", type=int, help="Set length in minutes")
    cp.add_argument("--deal", help="Deal type: guarantee|door_split|vs|flat|tbd")
    cp.add_argument("--guarantee", type=int, help="Guarantee in dollars")
    cp.add_argument("--address")
    cp.add_argument("--dos-name", dest="dos_name")
    cp.add_argument("--dos-phone", dest="dos_phone")
    cp.add_argument("--dos-email", dest="dos_email")
    cp.add_argument("--notes")

    # decline
    dp = sub.add_parser("decline", help="Mark pitch as declined")
    dp.add_argument("id", type=int)
    dp.add_argument("--notes")

    # pipeline
    sub.add_parser("pipeline", help="Full pipeline view")
    sub.add_parser("list-shows", help="Upcoming confirmed shows")

    # add-band
    abp = sub.add_parser("add-band", help="Add a band lead")
    abp.add_argument("name")
    abp.add_argument("--instagram")
    abp.add_argument("--tiktok")
    abp.add_argument("--email")
    abp.add_argument("--phone")
    abp.add_argument("--genre")
    abp.add_argument("--hometown")
    abp.add_argument("--followers")
    abp.add_argument("--notes")

    # list-bands
    sub.add_parser("list-bands", help="List band leads")

    # band-status
    bsp = sub.add_parser("band-status", help="Update band lead status")
    bsp.add_argument("id", type=int)
    bsp.add_argument("status", choices=["lead", "contacted", "interested", "declined", "booked", "not_a_fit"])
    bsp.add_argument("--notes")

    # calendar-sync
    sub.add_parser("calendar-sync", help="Push confirmed shows to STEAP Google Calendar")

    # summary
    sub.add_parser("summary", help="Slack-ready pipeline digest")

    args = p.parse_args()

    dispatch = {
        "add-pitch":    cmd_add_pitch,
        "hold":         cmd_hold,
        "confirm":      cmd_confirm,
        "decline":      cmd_decline,
        "pipeline":     cmd_pipeline,
        "list-shows":   cmd_list_shows,
        "add-band":     cmd_add_band,
        "list-bands":   cmd_list_bands,
        "band-status":  cmd_band_status,
        "calendar-sync": cmd_calendar_sync,
        "summary":      cmd_summary,
    }

    if not args.command:
        p.print_help()
        return

    dispatch[args.command](args)


if __name__ == "__main__":
    main()
