import asyncio
import json
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from cleetus.chat.agent import stream_chat
from cleetus.integrations.sms import (
    format_sms_summary,
    get_device_status,
    get_recent_sms,
    get_unread,
    mark_read,
    send_sms,
    sync_sms,
)
from cleetus.memory.database import (
    create_conversation,
    delete_memory,
    get_all_memories,
    get_conversation,
    get_conversations,
    get_messages,
    get_user_profile,
    init_db,
    memory_count,
    save_message,
    set_profile_field,
    update_conversation_title,
)
from cleetus.integrations.vault import (
    append_update,
    get_vault_context,
    list_notes,
    read_note,
    write_note,
)
from cleetus.memory.extractor import extract_and_save

app = FastAPI(title="CLEETUS", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Startup ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    init_db()


# ── Static / Frontend ─────────────────────────────────────────────────────────

_FRONTEND = Path(__file__).parent.parent / "frontend"

@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = _FRONTEND / "index.html"
    if html_path.exists():
        return HTMLResponse(html_path.read_text())
    return HTMLResponse("<h1>CLEETUS</h1><p>Frontend not found.</p>")


# ── Conversations ─────────────────────────────────────────────────────────────

class NewConversationBody(BaseModel):
    title: str = "New conversation"


@app.post("/api/conversations")
async def api_create_conversation(body: NewConversationBody):
    return create_conversation(body.title)


@app.get("/api/conversations")
async def api_list_conversations():
    return get_conversations()


@app.get("/api/conversations/{cid}")
async def api_get_conversation(cid: str):
    conv = get_conversation(cid)
    if not conv:
        raise HTTPException(404, "Conversation not found")
    return conv


@app.get("/api/conversations/{cid}/messages")
async def api_get_messages(cid: str):
    return get_messages(cid)


class TitleBody(BaseModel):
    title: str


@app.patch("/api/conversations/{cid}/title")
async def api_update_title(cid: str, body: TitleBody):
    update_conversation_title(cid, body.title)
    return {"ok": True}


# ── Chat (SSE streaming) ──────────────────────────────────────────────────────

class ChatBody(BaseModel):
    message: str


@app.post("/api/conversations/{cid}/chat")
async def api_chat(cid: str, body: ChatBody, background_tasks: BackgroundTasks):
    conv = get_conversation(cid)
    if not conv:
        raise HTTPException(404, "Conversation not found")

    history = get_messages(cid)
    user_msg = body.message.strip()
    if not user_msg:
        raise HTTPException(400, "Message cannot be empty")

    save_message(cid, "user", user_msg)

    async def event_stream():
        full_response = []
        try:
            async for chunk in stream_chat(cid, history, user_msg):
                full_response.append(chunk)
                payload = json.dumps({"type": "chunk", "text": chunk})
                yield f"data: {payload}\n\n"

            assistant_text = "".join(full_response)
            save_message(cid, "assistant", assistant_text)

            # Kick off memory extraction in background after streaming completes
            background_tasks.add_task(_run_extraction, cid)

            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _run_extraction(conversation_id: str):
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, extract_and_save, conversation_id)


# ── Memories ──────────────────────────────────────────────────────────────────

@app.get("/api/memories")
async def api_get_memories():
    return get_all_memories()


@app.get("/api/memories/count")
async def api_memory_count():
    return {"count": memory_count()}


@app.delete("/api/memories/{mid}")
async def api_delete_memory(mid: str):
    delete_memory(mid)
    return {"ok": True}


# ── User Profile ──────────────────────────────────────────────────────────────

@app.get("/api/profile")
async def api_get_profile():
    return get_user_profile()


class ProfileBody(BaseModel):
    key: str
    value: str


@app.post("/api/profile")
async def api_set_profile(body: ProfileBody):
    set_profile_field(body.key, body.value)
    return {"ok": True}


# ── SMS ───────────────────────────────────────────────────────────────────────

@app.get("/api/sms/status")
async def api_sms_status():
    return get_device_status()


@app.post("/api/sms/sync")
async def api_sms_sync():
    return sync_sms()


@app.get("/api/sms/messages")
async def api_sms_messages(limit: int = 50, contact: str | None = None):
    return get_recent_sms(limit=limit, contact=contact)


@app.get("/api/sms/unread")
async def api_sms_unread():
    msgs = get_unread()
    return {"messages": msgs, "summary": format_sms_summary(msgs)}


@app.post("/api/sms/{sms_id}/read")
async def api_mark_sms_read(sms_id: str):
    mark_read(sms_id)
    return {"ok": True}


class SendSmsBody(BaseModel):
    to: str
    message: str


@app.post("/api/sms/send")
async def api_send_sms(body: SendSmsBody):
    return send_sms(body.to, body.message)


# ── Vault ─────────────────────────────────────────────────────────────────────

class NoteBody(BaseModel):
    content: str


class UpdateBody(BaseModel):
    text: str


@app.get("/api/vault/notes")
async def api_vault_list_notes(folder: str = ""):
    return {"notes": list_notes(folder)}


@app.get("/api/vault/context")
async def api_vault_context():
    return {"context": get_vault_context()}


@app.get("/api/vault/notes/{path:path}")
async def api_vault_read_note(path: str):
    content = read_note(path)
    if content is None:
        raise HTTPException(404, "Note not found")
    return {"path": path, "content": content}


@app.post("/api/vault/notes/{path:path}/update")
async def api_vault_append_update(path: str, body: UpdateBody):
    try:
        append_update(path, body.text)
    except FileNotFoundError:
        raise HTTPException(404, "Note not found")
    return {"ok": True}


@app.post("/api/vault/notes/{path:path}")
async def api_vault_write_note(path: str, body: NoteBody):
    write_note(path, body.content)
    return {"ok": True}
