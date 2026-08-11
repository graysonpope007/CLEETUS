#!/opt/homebrew/bin/python3
"""
query.py — Unified integration CLI.

Usage:
    query.py registry                          # list integrations + status
    query.py gmail list [--max N] [--q QUERY]  # unread threads
    query.py gmail thread <thread_id>          # full thread
    query.py gmail search <query>              # search threads
    query.py gcal today                        # today's agenda
    query.py gcal upcoming [--days N]          # next N days
    query.py gcal search <keyword>             # events containing keyword
    query.py slack history [--limit N]         # recent DMs
    query.py slack send <text>                 # send DM to Grayson (safe)
    query.py drive search <query>              # Drive file search
    query.py drive get <file_id>               # file content
"""
import argparse
import sys
from pathlib import Path

# Ensure scripts dir is on path
sys.path.insert(0, str(Path(__file__).parent))


def cmd_registry(args):
    from integrations.registry import list_integrations
    for item in list_integrations():
        status = "OK" if item["enabled"] else "NOT CONFIGURED"
        print(f"  [{status:>14}] {item['name']:10} — {item['description']}")


def cmd_gmail(args):
    from integrations.gmail import list_unread, get_thread, search_threads
    sub = args.sub
    if sub == "list":
        q = getattr(args, "q", "is:unread category:primary") or "is:unread category:primary"
        threads = list_unread(max_results=getattr(args, "max", 15) or 15, query=q)
        if not threads:
            print("No unread threads.")
            return
        for t in threads:
            u = "U" if t.unread else " "
            print(f"[{u}] {t.sender[:35]:<35} {t.subject[:55]}")
            print(f"    {t.snippet}")
    elif sub == "thread":
        messages = get_thread(args.thread_id)
        for m in messages:
            print(f"\n--- {m.sender} | {m.date} ---")
            print(m.body[:800])
    elif sub == "search":
        threads = search_threads(" ".join(args.query_terms), max_results=10)
        for t in threads:
            print(f"[{t.thread_id}] {t.sender[:30]:<30} {t.subject}")


def cmd_gcal(args):
    from integrations.gcal import get_today_agenda, get_upcoming, events_containing
    sub = args.sub
    if sub == "today":
        events = get_today_agenda()
        if not events:
            print("No events today.")
        for e in events:
            label = "All day" if e.all_day else e.start[11:16]
            loc = f" @ {e.location}" if e.location else ""
            print(f"  {label} — {e.title}{loc}")
    elif sub == "upcoming":
        days = getattr(args, "days", 14) or 14
        events = get_upcoming(days=days)
        for e in events:
            label = (e.start[:10] + " " + e.start[11:16]).strip()
            print(f"  {label} — {e.title}")
    elif sub == "search":
        kw = " ".join(args.keyword)
        events = events_containing(kw)
        for e in events:
            print(f"  {e.start[:10]} — {e.title}")


def cmd_slack(args):
    from integrations.slack_integration import get_dm_history, send_to_grayson
    sub = args.sub
    if sub == "history":
        limit = getattr(args, "limit", 20) or 20
        messages = get_dm_history(limit=limit)
        for m in messages:
            print(f"  [{m.ts}] {m.user}: {m.text[:80]}")
    elif sub == "send":
        text = " ".join(args.text)
        ts = send_to_grayson(text)
        print(f"Sent (ts={ts})")


def cmd_drive(args):
    from integrations.gdrive import search_files, get_file_content
    sub = args.sub
    if sub == "search":
        query = " ".join(args.query_terms)
        files = search_files(query)
        for f in files:
            print(f"  [{f.file_id}] {f.name} — {f.modified_time[:10]}")
    elif sub == "get":
        content = get_file_content(args.file_id)
        print(content[:2000])


def main():
    parser = argparse.ArgumentParser(prog="query.py")
    sub = parser.add_subparsers(dest="integration")

    sub.add_parser("registry")

    gm = sub.add_parser("gmail")
    gm_sub = gm.add_subparsers(dest="sub")
    gm_list = gm_sub.add_parser("list")
    gm_list.add_argument("--max", type=int, default=15)
    gm_list.add_argument("--q", type=str, default=None)
    gm_thread = gm_sub.add_parser("thread")
    gm_thread.add_argument("thread_id")
    gm_search = gm_sub.add_parser("search")
    gm_search.add_argument("query_terms", nargs="+")

    gc = sub.add_parser("gcal")
    gc_sub = gc.add_subparsers(dest="sub")
    gc_sub.add_parser("today")
    gc_up = gc_sub.add_parser("upcoming")
    gc_up.add_argument("--days", type=int, default=14)
    gc_search = gc_sub.add_parser("search")
    gc_search.add_argument("keyword", nargs="+")

    sl = sub.add_parser("slack")
    sl_sub = sl.add_subparsers(dest="sub")
    sl_hist = sl_sub.add_parser("history")
    sl_hist.add_argument("--limit", type=int, default=20)
    sl_send = sl_sub.add_parser("send")
    sl_send.add_argument("text", nargs="+")

    dr = sub.add_parser("drive")
    dr_sub = dr.add_subparsers(dest="sub")
    dr_search = dr_sub.add_parser("search")
    dr_search.add_argument("query_terms", nargs="+")
    dr_get = dr_sub.add_parser("get")
    dr_get.add_argument("file_id")

    args = parser.parse_args()

    dispatch = {
        "registry": cmd_registry,
        "gmail":    cmd_gmail,
        "gcal":     cmd_gcal,
        "slack":    cmd_slack,
        "drive":    cmd_drive,
    }

    if args.integration not in dispatch:
        parser.print_help()
        return

    dispatch[args.integration](args)


if __name__ == "__main__":
    main()
