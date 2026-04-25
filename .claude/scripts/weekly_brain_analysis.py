#!/usr/bin/env python3
"""
weekly_brain_analysis.py — Cleetus Brain Growth Engine

Runs every Friday at 6 PM ET. Analyzes the vault for:
  1. Orphan notes (no wikilinks in or out)
  2. Knowledge gaps (topics mentioned but pages missing)
  3. Low-density clusters (areas with few connections)
  4. Suggested new connections between distant concepts

Fills gaps via web research, writes new wiki pages, and produces a
weekly analysis report to vault/10-Daily/brain-analysis-YYYY-MM-DD.md

Usage:
  python3 weekly_brain_analysis.py           # full run
  python3 weekly_brain_analysis.py --dry-run # analysis only, no writes
  python3 weekly_brain_analysis.py --gaps-only  # just find gaps, no research
"""

import os
import re
import sys
import json
import argparse
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
from dotenv import load_dotenv

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
CLEETUS_ROOT = SCRIPT_DIR.parents[1]
VAULT = Path(os.environ.get(
    "CLEETUS_VAULT",
    "/Users/grayson/Library/Mobile Documents/iCloud~md~obsidian/Documents/Cleetus"
))

load_dotenv(CLEETUS_ROOT / ".env")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# Skip these folders/files during analysis
SKIP_DIRS = {".obsidian", "raw", ".git", "node_modules"}
SKIP_FILES = {"_CLAUDE.md", "log.md"}

# ── Wikilink parsing ─────────────────────────────────────────────────────────
WIKILINK_RE = re.compile(r'\[\[([^\]|#]+?)(?:\|[^\]]+?)?\]\]')
MENTION_RE  = re.compile(r'\b([A-Z][a-z]+(?:[\s-][A-Z][a-z]+)+)\b')  # Proper nouns

def slug(name: str) -> str:
    """Normalize a name to a vault slug."""
    return name.strip().replace(" ", "-").replace("/", "-")


def all_vault_files(vault: Path) -> list[Path]:
    """Return all .md files in the vault, skipping ignored dirs."""
    files = []
    for p in vault.rglob("*.md"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.name in SKIP_FILES:
            continue
        files.append(p)
    return sorted(files)


def parse_wikilinks(text: str) -> set[str]:
    """Extract all wikilink targets from markdown text."""
    return {slug(m) for m in WIKILINK_RE.findall(text)}


def build_graph(vault: Path) -> tuple[dict, dict, dict]:
    """
    Build the vault knowledge graph.
    Returns:
        pages     : {slug: Path}
        outlinks  : {slug: {slug, ...}}  — links this page makes
        inlinks   : {slug: {slug, ...}}  — links pointing to this page
    """
    pages: dict[str, Path] = {}
    outlinks: dict[str, set] = defaultdict(set)
    inlinks:  dict[str, set] = defaultdict(set)

    for f in all_vault_files(vault):
        rel = f.relative_to(vault)
        # Use stem as slug, with folder prefix for disambiguation
        s = slug(f.stem)
        pages[s] = f

        text = f.read_text(encoding="utf-8", errors="ignore")
        targets = parse_wikilinks(text)
        outlinks[s] = targets
        for t in targets:
            inlinks[t].add(s)

    return pages, dict(outlinks), dict(inlinks)


def find_orphans(pages: dict, outlinks: dict, inlinks: dict) -> list[str]:
    """Pages with no outgoing AND no incoming wikilinks."""
    orphans = []
    for s in pages:
        has_out = bool(outlinks.get(s))
        has_in  = bool(inlinks.get(s))
        if not has_out and not has_in:
            orphans.append(s)
    return sorted(orphans)


def find_missing_pages(pages: dict, outlinks: dict) -> dict[str, list]:
    """
    Topics that are linked to (in [[wikilinks]]) but have no page yet.
    Returns {missing_slug: [pages_that_link_to_it]}
    """
    all_links: dict[str, list] = defaultdict(list)
    for source, targets in outlinks.items():
        for t in targets:
            all_links[t].append(source)
    # Keep only those with no page
    missing = {t: sources for t, sources in all_links.items() if t not in pages}
    return dict(sorted(missing.items(), key=lambda x: -len(x[1])))


def find_isolated_clusters(pages: dict, outlinks: dict, inlinks: dict) -> list[str]:
    """Pages with only 1 connection (very low density)."""
    low_density = []
    for s in pages:
        total = len(outlinks.get(s, set())) + len(inlinks.get(s, set()))
        if total == 1:
            low_density.append(s)
    return sorted(low_density)


def connection_density(pages: dict, outlinks: dict) -> float:
    """Average number of outgoing links per page."""
    if not pages:
        return 0.0
    total = sum(len(v) for v in outlinks.values())
    return total / len(pages)


# ── Claude research ───────────────────────────────────────────────────────────
def research_gap(topic: str, context_slugs: list[str], vault: Path) -> str:
    """
    Use Claude to research a knowledge gap and return a wiki page draft.
    context_slugs = pages that already reference this topic.
    """
    try:
        import anthropic
    except ImportError:
        return f"# {topic}\n\n> Auto-research unavailable (anthropic not installed)\n"

    if not ANTHROPIC_API_KEY:
        return f"# {topic}\n\n> Auto-research unavailable (no API key)\n"

    # Load context from referencing pages
    context_snippets = []
    for cs in context_slugs[:3]:
        # Try to find the file
        for f in all_vault_files(vault):
            if slug(f.stem) == cs:
                text = f.read_text(encoding="utf-8", errors="ignore")
                context_snippets.append(f"## From [[{cs}]]:\n{text[:800]}")
                break

    context_text = "\n\n".join(context_snippets) if context_snippets else "No context available."

    # Map topic to real-world subject
    friendly_topic = topic.replace("-", " ")

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    prompt = f"""You are Cleetus, an AI second brain for Grayson Pope (21, Athens GA, musician/student/entrepreneur).

A knowledge gap was detected: the topic "{friendly_topic}" is referenced in the vault but has no dedicated page.

Context from pages that reference it:
{context_text}

Write a concise, informative wiki page about "{friendly_topic}" that:
1. Explains what it is in 2-3 sentences
2. Shows its relevance to Grayson's world (music, Athens, UGA, his projects)
3. Lists 3-5 key facts or bullet points
4. Ends with a "## Connected to" section with [[wikilinks]] to relevant vault pages

Format as clean Obsidian markdown with YAML frontmatter:
---
tags: [auto-generated]
type: concept or entity (choose one)
updated: {datetime.now().strftime('%Y-%m-%d')}
source: brain-analysis
---

Keep it under 300 words. Be specific and useful, not generic."""

    try:
        msg = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}]
        )
        return msg.content[0].text
    except Exception as e:
        return f"# {friendly_topic}\n\n> Research failed: {e}\n"


def suggest_connections(pages: dict, outlinks: dict, inlinks: dict, vault: Path) -> list[dict]:
    """
    Use Claude to suggest non-obvious connections between pages
    that aren't currently linked.
    """
    try:
        import anthropic
    except ImportError:
        return []

    if not ANTHROPIC_API_KEY:
        return []

    # Build a compact summary of what each page is about
    page_summaries = []
    for s, path in list(pages.items())[:40]:  # cap to avoid huge context
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
            # First non-frontmatter line
            lines = [l for l in text.split("\n") if l.strip() and not l.startswith("---") and not l.startswith("#")]
            snippet = lines[0][:100] if lines else ""
            page_summaries.append(f"- **{s}**: {snippet}")
        except Exception:
            pass

    summary_text = "\n".join(page_summaries)

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    prompt = f"""You are analyzing a personal knowledge vault for Grayson Pope (musician, entrepreneur, student in Athens GA).

Here are the current vault pages and their first lines:
{summary_text}

Identify 5 non-obvious connections between pages that are NOT currently linked to each other, where creating a link or a new synthesis page would generate genuine insight.

Focus on cross-domain connections (e.g., a music business concept that applies to his nonprofit work, or a neuroscience concept relevant to his performance practice).

Return JSON array of objects:
[
  {{
    "page_a": "slug-of-first-page",
    "page_b": "slug-of-second-page",
    "insight": "One sentence explaining the non-obvious connection",
    "action": "add-link|create-synthesis-page"
  }}
]

Only return valid JSON, nothing else."""

    try:
        msg = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=800,
            messages=[{"role": "user", "content": prompt}]
        )
        raw = msg.content[0].text.strip()
        # Strip code fences if present
        raw = re.sub(r'^```json\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        return json.loads(raw)
    except Exception as e:
        print(f"  ⚠️  Connection suggestion failed: {e}")
        return []


# ── Report writing ────────────────────────────────────────────────────────────
def write_report(
    vault: Path,
    orphans: list,
    missing: dict,
    low_density: list,
    connections: list,
    new_pages: list,
    density: float,
    total_pages: int,
) -> Path:
    """Write the weekly analysis report to 10-Daily/brain-analysis-YYYY-MM-DD.md"""
    today = datetime.now().strftime("%Y-%m-%d")
    report_path = vault / "10-Daily" / f"brain-analysis-{today}.md"

    lines = [
        f"---",
        f"type: brain-analysis",
        f"date: {today}",
        f"tags: [brain-analysis, weekly]",
        f"---",
        f"",
        f"# 🧠 Weekly Brain Analysis — {today}",
        f"",
        f"## Vault Health",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Total pages | {total_pages} |",
        f"| Avg connection density | {density:.2f} links/page |",
        f"| Orphan pages | {len(orphans)} |",
        f"| Missing pages (linked but don't exist) | {len(missing)} |",
        f"| Low-density pages | {len(low_density)} |",
        f"| New pages created this run | {len(new_pages)} |",
        f"",
    ]

    # Orphans
    lines += [
        f"## 🏝️ Orphan Pages (no connections)",
        f"These pages exist but nothing links to them. Consider adding wikilinks or archiving.",
        f"",
    ]
    if orphans:
        for o in orphans[:15]:
            lines.append(f"- [ ] [[{o}]]")
    else:
        lines.append("_No orphans found — great connectivity!_")
    lines.append("")

    # Missing pages
    lines += [
        f"## 🕳️ Knowledge Gaps (linked but missing)",
        f"These topics are referenced in wikilinks but have no page. Highest priority first.",
        f"",
    ]
    if missing:
        for topic, sources in list(missing.items())[:15]:
            source_list = ", ".join(f"[[{s}]]" for s in sources[:3])
            lines.append(f"- [ ] **{topic}** — referenced by: {source_list}")
    else:
        lines.append("_No missing pages — all wikilinks resolve!_")
    lines.append("")

    # New pages written
    if new_pages:
        lines += [
            f"## ✨ New Pages Created This Run",
            f"",
        ]
        for np in new_pages:
            lines.append(f"- [[{np}]]")
        lines.append("")

    # Suggested connections
    lines += [
        f"## 🔗 Suggested New Connections",
        f"Non-obvious bridges discovered by analysis.",
        f"",
    ]
    if connections:
        for c in connections:
            action = "📄 Create synthesis page" if c.get("action") == "create-synthesis-page" else "🔗 Add link"
            lines.append(f"- {action}: **[[{c.get('page_a')}]]** ↔ **[[{c.get('page_b')}]]**")
            lines.append(f"  > {c.get('insight', '')}")
            lines.append("")
    else:
        lines.append("_No suggestions generated._")
        lines.append("")

    # Low density
    if low_density:
        lines += [
            f"## 📉 Low-Density Pages (only 1 connection)",
            f"These pages are barely connected to the rest of the brain.",
            f"",
        ]
        for ld in low_density[:10]:
            lines.append(f"- [ ] [[{ld}]]")
        lines.append("")

    # Action items
    lines += [
        f"---",
        f"## 📋 Recommended Actions",
        f"",
        f"1. Review orphan pages above — add wikilinks or archive",
        f"2. Review new auto-created pages in `50-Resources/wiki/` — edit and expand",
        f"3. Act on top 3 suggested connections",
        f"4. Open Obsidian graph view and explore new clusters",
        f"",
        f"---",
        f"*Generated by Cleetus weekly_brain_analysis.py — {datetime.now().strftime('%Y-%m-%d %H:%M ET')}*",
    ]

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Cleetus Weekly Brain Analysis")
    parser.add_argument("--dry-run", action="store_true", help="Analyze only, don't write new pages")
    parser.add_argument("--gaps-only", action="store_true", help="Find gaps but skip web research")
    parser.add_argument("--vault", type=str, default=str(VAULT), help="Override vault path")
    args = parser.parse_args()

    vault = Path(args.vault)
    print(f"\n🧠 Cleetus Brain Analysis")
    print(f"   Vault: {vault}")
    print(f"   Mode: {'dry-run' if args.dry_run else 'full'}")
    print()

    if not vault.exists():
        print(f"❌ Vault not found: {vault}")
        sys.exit(1)

    # Step 1: Build graph
    print("📊 Building knowledge graph...")
    pages, outlinks, inlinks = build_graph(vault)
    print(f"   {len(pages)} pages, {sum(len(v) for v in outlinks.values())} links total")

    density = connection_density(pages, outlinks)
    print(f"   Avg density: {density:.2f} links/page")

    # Step 2: Find issues
    print("\n🔍 Analyzing graph...")
    orphans = find_orphans(pages, outlinks, inlinks)
    missing = find_missing_pages(pages, outlinks)
    low_density = find_isolated_clusters(pages, outlinks, inlinks)

    print(f"   Orphans: {len(orphans)}")
    print(f"   Missing pages: {len(missing)}")
    print(f"   Low-density: {len(low_density)}")

    # Step 3: Research and fill top gaps
    new_pages = []
    if not args.dry_run and not args.gaps_only and missing:
        print(f"\n🔬 Researching top knowledge gaps...")
        # Research top 5 most-referenced missing pages
        top_gaps = list(missing.items())[:5]
        wiki_concepts_dir = vault / "50-Resources" / "wiki" / "concepts"
        wiki_concepts_dir.mkdir(parents=True, exist_ok=True)

        for topic, sources in top_gaps:
            friendly = topic.replace("-", " ")
            print(f"   → Researching: {friendly}")
            content = research_gap(topic, sources, vault)
            page_path = wiki_concepts_dir / f"{topic}.md"
            if not page_path.exists():
                page_path.write_text(content, encoding="utf-8")
                new_pages.append(topic)
                print(f"     ✅ Created: {page_path.relative_to(vault)}")
            else:
                print(f"     ⏭️  Already exists: {topic}")

    # Step 4: Suggest connections
    connections = []
    if not args.dry_run and not args.gaps_only:
        print(f"\n🔗 Finding non-obvious connections...")
        connections = suggest_connections(pages, outlinks, inlinks, vault)
        print(f"   {len(connections)} connections suggested")

    # Step 5: Write report
    print(f"\n📝 Writing analysis report...")
    if not args.dry_run:
        report_path = write_report(
            vault, orphans, missing, low_density,
            connections, new_pages, density, len(pages)
        )
        print(f"   ✅ Report: {report_path.relative_to(vault)}")

        # Update log.md
        log_path = vault / "log.md"
        if log_path.exists():
            today = datetime.now().strftime("%Y-%m-%d")
            entry = f"- `[{datetime.now().strftime('%H:%M')}]` Brain analysis complete. {len(pages)} pages, {len(orphans)} orphans, {len(missing)} gaps, {len(new_pages)} new pages created.\n"
            content = log_path.read_text(encoding="utf-8")
            # Insert after the date header for today, or add at top of entries
            if today in content:
                content = content.replace(f"## {today}\n", f"## {today}\n{entry}", 1)
            else:
                # Add new date section
                insert_after = "# Activity Log — Cleetus\n\n> Complete timeline of vault activity. Appended by sessions and scripts.\n\n---\n\n"
                content = content.replace(insert_after, insert_after + f"## {today}\n{entry}\n")
            log_path.write_text(content, encoding="utf-8")
    else:
        print(f"\n📊 Dry-run summary:")
        print(f"   Orphans: {orphans[:5]}")
        print(f"   Top gaps: {list(missing.keys())[:5]}")
        print(f"   Would create {min(5, len(missing))} new pages")

    print(f"\n✅ Brain analysis complete!")


if __name__ == "__main__":
    main()
