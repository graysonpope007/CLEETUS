"""
Obsidian vault integration — file I/O only, no external API.

Vault path is configured via the VAULT_PATH env var. If the path does not
exist on the current machine (e.g. running on a server without iCloud),
all functions degrade gracefully and return empty results.
"""

from datetime import date
from pathlib import Path

from cleetus.config import VAULT_PATH

_CONTEXT_FOLDERS = ("20-People", "50-Resources")


# ── Read ───────────────────────────────────────────────────────────────────────

def read_note(relative_path: str) -> str | None:
    """Read a vault note. Returns content or None if missing."""
    if not VAULT_PATH.exists():
        return None
    target = (VAULT_PATH / relative_path).resolve()
    if not target.is_relative_to(VAULT_PATH.resolve()):
        return None
    if not target.exists():
        return None
    return target.read_text(encoding="utf-8")


def list_notes(folder: str = "") -> list[str]:
    """Return note paths relative to VAULT_PATH within the given folder."""
    root = VAULT_PATH / folder if folder else VAULT_PATH
    if not root.exists():
        return []
    vault_resolved = VAULT_PATH.resolve()
    return sorted(
        str(p.resolve().relative_to(vault_resolved)).replace("\\", "/")
        for p in root.rglob("*.md")
    )


# ── Write ──────────────────────────────────────────────────────────────────────

def write_note(relative_path: str, content: str) -> None:
    """Create or overwrite a vault note. Creates parent dirs as needed."""
    target = (VAULT_PATH / relative_path).resolve()
    if not target.is_relative_to(VAULT_PATH.resolve()):
        raise ValueError(f"Path outside vault: {relative_path}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def append_update(relative_path: str, update_text: str) -> None:
    """
    Append a dated update block to an existing note under ## Updates.
    If the heading is absent it is added at the end.
    Raises FileNotFoundError if the note does not exist.
    """
    target = (VAULT_PATH / relative_path).resolve()
    if not target.is_relative_to(VAULT_PATH.resolve()):
        raise ValueError(f"Path outside vault: {relative_path}")
    if not target.exists():
        raise FileNotFoundError(f"Note not found: {relative_path}")

    existing = target.read_text(encoding="utf-8")
    section = f"\n### Update {date.today().isoformat()}\n{update_text.rstrip()}\n"

    if "## Updates" in existing:
        updated = existing.replace("## Updates", f"## Updates{section}", 1)
    else:
        updated = existing.rstrip() + "\n\n## Updates\n" + section

    target.write_text(updated, encoding="utf-8")


# ── Context for CLEETUS ────────────────────────────────────────────────────────

def get_vault_context(query: str = "") -> str:
    """
    Build a vault context block for injection into the system prompt.
    Loads all notes from 20-People/ and 50-Resources/ in full.
    Returns empty string if the vault path does not exist.
    """
    if not VAULT_PATH.exists():
        return ""

    sections: list[str] = []
    for folder in _CONTEXT_FOLDERS:
        for rel_path in list_notes(folder):
            content = read_note(rel_path)
            if content and content.strip():
                sections.append(f"## {rel_path}\n{content.strip()}")

    if not sections:
        return ""

    return "# Vault notes\n\n" + "\n\n".join(sections)
