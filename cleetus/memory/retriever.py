from cleetus.integrations.vault import get_vault_context
from cleetus.memory.database import (
    get_memories_by_category,
    get_user_profile,
    search_memories,
)


def get_memory_context(query: str = "") -> str:
    """Build a memory block to inject into the system prompt."""
    lines: list[str] = []

    # Always inject identity facts so CLEETUS always knows who it's talking to
    identity = get_memories_by_category("identity")
    if identity:
        lines.append("## Who you're talking to")
        for m in identity[:10]:
            lines.append(f"- {m['content']}")

    # User profile fields (name, etc.)
    profile = get_user_profile()
    if profile:
        lines.append("\n## User profile")
        for k, v in profile.items():
            lines.append(f"- {k}: {v}")

    # FTS search for query-relevant memories
    if query:
        hits = search_memories(query, limit=15)
        relevant = [h for h in hits if h.get("category") != "identity"]
        if relevant:
            lines.append("\n## Relevant memories")
            for m in relevant:
                lines.append(f"- [{m['category']}] {m['content']}")

    # Always include goals and values for personality grounding
    for cat in ("goal", "value"):
        mems = get_memories_by_category(cat)
        if mems:
            lines.append(f"\n## User {cat}s")
            for m in mems[:5]:
                lines.append(f"- {m['content']}")

    vault_ctx = get_vault_context(query)
    if vault_ctx:
        lines.append("\n" + vault_ctx)

    if not lines:
        return ""

    return "# What you know about the user\n" + "\n".join(lines)
