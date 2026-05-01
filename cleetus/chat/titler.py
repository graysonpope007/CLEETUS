import re

from anthropic import Anthropic

from cleetus.config import ANTHROPIC_API_KEY, EXTRACT_MODEL
from cleetus.memory.database import get_conversation, get_messages, update_conversation_title

_client = Anthropic(api_key=ANTHROPIC_API_KEY)

_SYSTEM = """\
Generate a short, specific title (4-7 words) for this conversation based on the first exchange.
Return ONLY the title text — no quotes, no punctuation at the end, no explanation.
Examples: "Planning Nashville Weekend Trip", "Debugging Python Import Error", "Reviewing Q2 Goals"\
"""


def auto_title(conversation_id: str) -> None:
    conv = get_conversation(conversation_id)
    if not conv or conv["title"] != "New conversation":
        return

    messages = get_messages(conversation_id)
    if len(messages) < 2:
        return

    exchange = "\n".join(
        f"{m['role'].upper()}: {m['content'][:400]}" for m in messages[:2]
    )

    resp = _client.messages.create(
        model=EXTRACT_MODEL,
        max_tokens=32,
        system=_SYSTEM,
        messages=[{"role": "user", "content": exchange}],
    )

    title = resp.content[0].text.strip()
    title = re.sub(r'^["\' ]+|["\' ]+$', "", title)
    if title:
        update_conversation_title(conversation_id, title)
