import json
import re
from anthropic import Anthropic

from cleetus.config import ANTHROPIC_API_KEY, EXTRACT_MODEL
from cleetus.memory.database import (
    get_all_memories,
    get_messages,
    save_memory,
)

_client = Anthropic(api_key=ANTHROPIC_API_KEY)

_CATEGORIES = [
    "identity",   # name, age, location, demographics
    "preference", # likes, dislikes, habits, style
    "goal",       # ambitions, plans, things they want
    "expertise",  # skills, knowledge areas, experience
    "project",    # current/past projects and work
    "relationship", # family, friends, colleagues
    "context",    # life situation, circumstances
    "value",      # beliefs, principles, what matters to them
]

_SYSTEM = """\
You are a memory extraction engine. Your only job is to analyze a conversation \
and extract NEW factual learnings about the user that are NOT already captured \
in their memory store.

Return a JSON array of memory objects. Each object has exactly three fields:
  "category": one of: identity, preference, goal, expertise, project, relationship, context, value
  "content": a concise, specific fact about the user (1-2 sentences max)
  "confidence": a float 0.0-1.0 indicating how certain this fact is

Rules:
- Only extract concrete facts, not vague impressions
- Do NOT duplicate memories already in the existing store
- If nothing new can be learned, return an empty array []
- Do NOT include assistant self-references or meta-commentary
- Return ONLY valid JSON, no markdown fences, no explanation
"""


def _build_extraction_prompt(messages: list[dict], existing: list[dict]) -> str:
    convo_text = "\n".join(
        f"{m['role'].upper()}: {m['content']}" for m in messages[-20:]
    )
    existing_text = (
        "\n".join(f"[{m['category']}] {m['content']}" for m in existing[-100:])
        if existing
        else "(none yet)"
    )
    return (
        f"EXISTING MEMORIES:\n{existing_text}\n\n"
        f"CONVERSATION:\n{convo_text}\n\n"
        "Extract new memories about the user from this conversation."
    )


def _word_overlap(a: str, b: str) -> float:
    """Jaccard-style overlap on the shorter string's vocabulary."""
    words_a = set(re.sub(r"[^\w\s]", "", a.lower()).split())
    words_b = set(re.sub(r"[^\w\s]", "", b.lower()).split())
    # Remove very common stop words so "the user likes X" != "the user likes Y"
    stops = {"the", "a", "an", "is", "are", "was", "were", "user", "grayson", "he", "his", "i", "my"}
    words_a -= stops
    words_b -= stops
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / min(len(words_a), len(words_b))


def _is_duplicate(content: str, existing: list[dict], threshold: float = 0.72) -> bool:
    for mem in existing:
        if _word_overlap(content, mem["content"]) >= threshold:
            return True
    return False


def extract_and_save(conversation_id: str) -> int:
    messages = get_messages(conversation_id)
    if len(messages) < 2:
        return 0

    existing = get_all_memories()
    prompt = _build_extraction_prompt(messages, existing)

    resp = _client.messages.create(
        model=EXTRACT_MODEL,
        max_tokens=1024,
        system=_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = resp.content[0].text.strip()

    # Strip markdown code fences if model wraps anyway
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        return 0

    if not isinstance(items, list):
        return 0

    saved = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        category = item.get("category", "").strip().lower()
        content = item.get("content", "").strip()
        confidence = float(item.get("confidence", 1.0))
        if category not in _CATEGORIES or not content:
            continue
        if _is_duplicate(content, existing):
            continue
        mem = save_memory(
            category=category,
            content=content,
            conversation_id=conversation_id,
            confidence=confidence,
        )
        existing.append(mem)
        saved += 1

    return saved
