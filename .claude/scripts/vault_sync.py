#!/opt/homebrew/bin/python3
"""
vault_sync.py — Sync key vault facts to Supabase so Railway Cleetus knows Grayson.

Reads vault markdown files, compresses them into a context JSON blob,
and uploads to Supabase storage (creo-config bucket) as `grayson-context.json`.

The Railway server reads this file at startup and injects it into the system prompt.

Usage:
  python3 vault_sync.py              # sync vault to Supabase
  python3 vault_sync.py --dry-run    # show what would be synced, don't upload
  python3 vault_sync.py --local      # write to /tmp/grayson-context.json only
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("CLEETUS_ROOT", str(Path(__file__).parents[3]))

from dotenv import load_dotenv
load_dotenv(Path(os.environ["CLEETUS_ROOT"]) / ".env", override=True)

# Also load Railway project .env for Supabase keys
_RAILWAY_ENV = Path("/Users/grayson/Documents/New project/.env")
if _RAILWAY_ENV.exists():
    load_dotenv(_RAILWAY_ENV, override=False)  # don't override Cleetus keys

ET = ZoneInfo("America/New_York")
VAULT = Path(__file__).parents[2] / "vault"

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
CONFIG_BUCKET = os.getenv("SUPABASE_CONFIG_BUCKET", "creo-config")
CONTEXT_FILE = "grayson-context.json"


# ─── Vault reading ────────────────────────────────────────────────────────────

def read_vault_file(path: Path, max_chars: int = 3000) -> str:
    try:
        return path.read_text()[:max_chars]
    except Exception:
        return ""


def build_context() -> dict:
    """Assemble a compact context object from key vault files."""
    now = datetime.now(ET).isoformat()

    context = {
        "_synced_at": now,
        "_version": 2,
    }

    # Core identity files
    for fname in ["USER.md", "MEMORY.md", "SOUL.md"]:
        p = VAULT / fname
        if p.exists():
            context[fname.replace(".md", "").lower()] = read_vault_file(p, max_chars=4000)

    # Active projects (includes subdirectory project folders like STEAP/)
    projects_dir = VAULT / "30-Projects"
    projects = {}
    if projects_dir.exists():
        # Top-level .md files (one per project summary)
        for f in sorted(projects_dir.glob("*.md"))[:8]:
            projects[f.stem] = read_vault_file(f, max_chars=1500)
        # Project subfolders — include up to 2 files per subfolder
        for subdir in sorted(projects_dir.iterdir()):
            if subdir.is_dir() and not subdir.name.startswith("."):
                sub_key = subdir.name
                sub_texts = []
                for f in sorted(subdir.glob("*.md"))[:3]:
                    sub_texts.append(f"### {f.stem}\n" + read_vault_file(f, max_chars=1200))
                if sub_texts:
                    projects[sub_key] = "\n\n".join(sub_texts)
    context["projects"] = projects

    # Key people
    people_dir = VAULT / "20-People"
    people = {}
    if people_dir.exists():
        for f in sorted(people_dir.glob("*.md"))[:10]:
            people[f.stem] = read_vault_file(f, max_chars=800)
    context["people"] = people

    # Resources / how-I-work
    resources_dir = VAULT / "50-Resources"
    if resources_dir.exists():
        for fname in ["How-I-Work.md", "Music-Industry-Knowledge.md", "Marketing-and-Content-Knowledge.md"]:
            p = resources_dir / fname
            if p.exists():
                key = fname.replace(".md", "").replace("-", "_").lower()
                context[key] = read_vault_file(p, max_chars=2000)

    # Today's daily note (if it exists)
    today = datetime.now(ET).date().isoformat()
    daily = VAULT / "10-Daily" / f"{today}.md"
    if daily.exists():
        context["today"] = read_vault_file(daily, max_chars=1500)

    # Heartbeat state (recent activity)
    state_path = Path(__file__).parent.parent / "data" / "state" / "heartbeat-state.json"
    if state_path.exists():
        try:
            context["recent_state"] = json.loads(state_path.read_text())
        except Exception:
            pass

    return context


def estimate_tokens(context: dict) -> int:
    """Rough token estimate: ~4 chars per token."""
    total_chars = len(json.dumps(context))
    return total_chars // 4


# ─── Upload to Supabase ───────────────────────────────────────────────────────

def upload_to_supabase(context: dict) -> bool:
    """Upload context JSON to Supabase storage."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        print("⚠️  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping upload.")
        return False

    try:
        import urllib.request
        import urllib.error

        data = json.dumps(context, ensure_ascii=False, indent=2).encode("utf-8")
        url = f"{SUPABASE_URL}/storage/v1/object/{CONFIG_BUCKET}/{CONTEXT_FILE}"

        req = urllib.request.Request(
            url,
            data=data,
            method="PUT",
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
                "x-upsert": "true",
            }
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
            return resp.status in (200, 201)

    except Exception as e:
        # Try POST if PUT fails
        try:
            import urllib.request
            data = json.dumps(context, ensure_ascii=False, indent=2).encode("utf-8")
            url = f"{SUPABASE_URL}/storage/v1/object/{CONFIG_BUCKET}/{CONTEXT_FILE}"
            req = urllib.request.Request(
                url,
                data=data,
                method="POST",
                headers={
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                    "Content-Type": "application/json",
                    "x-upsert": "true",
                }
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read()
                return True
        except Exception as e2:
            print(f"Upload failed: {e2}")
            return False


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    dry_run = "--dry-run" in sys.argv
    local_only = "--local" in sys.argv

    print("[vault_sync] Building context from vault...")
    context = build_context()

    token_est = estimate_tokens(context)
    print(f"  Files included: user={bool(context.get('user'))}, memory={bool(context.get('memory'))}, "
          f"projects={len(context.get('projects', {}))}, people={len(context.get('people', {}))}")
    print(f"  Estimated tokens: ~{token_est:,}")

    if dry_run:
        print("\n=== DRY RUN — context preview ===")
        print(f"Keys: {list(context.keys())}")
        if context.get("user"):
            print(f"\nUSER.md preview:\n{context['user'][:300]}...")
        if context.get("memory"):
            print(f"\nMEMORY.md preview:\n{context['memory'][:300]}...")
        return

    if local_only:
        out = Path("/tmp/grayson-context.json")
        out.write_text(json.dumps(context, indent=2, ensure_ascii=False))
        print(f"  Written to {out}")
        return

    ok = upload_to_supabase(context)
    if ok:
        print(f"  ✅ Uploaded to Supabase: {CONFIG_BUCKET}/{CONTEXT_FILE}")
    else:
        # Fallback: write locally so Railway can pick it up next deploy
        out = Path("/Users/grayson/Documents/New project/data/grayson-context.json")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(context, indent=2, ensure_ascii=False))
        print(f"  ⚠️  Supabase upload failed. Written locally to {out}")


if __name__ == "__main__":
    main()
