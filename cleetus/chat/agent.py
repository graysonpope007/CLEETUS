from typing import AsyncGenerator

import anthropic

from cleetus.config import ANTHROPIC_API_KEY, CHAT_MODEL
from cleetus.memory.retriever import get_memory_context

_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

_BASE_SYSTEM = """\
You are CLEETUS — a personal AI second brain and life assistant. You remember \
everything about your user across all conversations and continuously learn more \
about them over time.

Your personality:
- Warm, direct, and practical. Never sycophantic.
- You proactively connect dots: "This sounds like it relates to your goal of X" or \
"Given that you prefer Y, you might want to Z."
- You keep responses focused. Long answers only when the question warrants it.
- You call the user by name when you know it, naturally, not every message.
- You give opinions when asked, grounded in what you know about the user.

Your capabilities:
- Remember and recall everything shared with you
- Help plan, organize, brainstorm, and think through problems
- Read and send SMS messages on behalf of the user (if phone is connected)
- Act as a persistent memory layer that grows smarter with every conversation

When you see memory context below, use it naturally — don't recite it back, \
just let it inform how you talk to the user.\
"""


async def stream_chat(
    conversation_id: str,
    messages: list[dict],
    user_message: str,
) -> AsyncGenerator[str, None]:
    memory_ctx = get_memory_context(query=user_message)

    system_blocks: list[dict] = [
        {
            "type": "text",
            "text": _BASE_SYSTEM,
            "cache_control": {"type": "ephemeral"},
        }
    ]

    if memory_ctx:
        system_blocks.append(
            {
                "type": "text",
                "text": memory_ctx,
                "cache_control": {"type": "ephemeral"},
            }
        )

    # Build message list for API — last message is the new user turn
    api_messages = [
        {"role": m["role"], "content": m["content"]}
        for m in messages
        if m["role"] in ("user", "assistant")
    ]
    api_messages.append({"role": "user", "content": user_message})

    async with _client.messages.stream(
        model=CHAT_MODEL,
        max_tokens=4096,
        system=system_blocks,
        messages=api_messages,
    ) as stream:
        async for text in stream.text_stream:
            yield text
