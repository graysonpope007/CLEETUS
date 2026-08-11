#!/opt/homebrew/bin/python3
"""
gmail.py — Gmail integration module.
Provides read + draft-send functions. Actual sending requires explicit confirm.
"""
from __future__ import annotations

import base64
import email as email_lib
from dataclasses import dataclass
from datetime import datetime, timezone
from email.mime.text import MIMEText
from typing import Optional

from .auth_google import gmail_service


@dataclass
class GmailThread:
    thread_id: str
    subject: str
    sender: str
    snippet: str
    date: str
    unread: bool
    message_count: int


@dataclass
class GmailMessage:
    message_id: str
    thread_id: str
    subject: str
    sender: str
    body: str
    date: str
    unread: bool


def list_unread(max_results: int = 15, query: str = "is:unread category:primary") -> list[GmailThread]:
    svc = gmail_service()
    result = svc.users().messages().list(userId="me", q=query, maxResults=max_results).execute()
    messages = result.get("messages", [])

    seen_threads: dict[str, GmailThread] = {}
    for msg in messages:
        detail = svc.users().messages().get(
            userId="me", id=msg["id"], format="metadata",
            metadataHeaders=["From", "Subject", "Date"]
        ).execute()
        headers = {h["name"]: h["value"] for h in detail["payload"]["headers"]}
        tid = detail["threadId"]
        if tid not in seen_threads:
            seen_threads[tid] = GmailThread(
                thread_id=tid,
                subject=headers.get("Subject", "(no subject)"),
                sender=headers.get("From", "Unknown"),
                snippet=detail.get("snippet", "")[:120],
                date=headers.get("Date", ""),
                unread="UNREAD" in detail.get("labelIds", []),
                message_count=1,
            )
        else:
            seen_threads[tid].message_count += 1

    return list(seen_threads.values())


def get_thread(thread_id: str) -> list[GmailMessage]:
    svc = gmail_service()
    thread = svc.users().threads().get(userId="me", id=thread_id, format="full").execute()
    messages = []
    for msg in thread.get("messages", []):
        headers = {h["name"]: h["value"] for h in msg["payload"]["headers"]}
        body = _extract_body(msg["payload"])
        messages.append(GmailMessage(
            message_id=msg["id"],
            thread_id=thread_id,
            subject=headers.get("Subject", "(no subject)"),
            sender=headers.get("From", "Unknown"),
            body=body,
            date=headers.get("Date", ""),
            unread="UNREAD" in msg.get("labelIds", []),
        ))
    return messages


def search_threads(query: str, max_results: int = 10) -> list[GmailThread]:
    return list_unread(max_results=max_results, query=query)


def build_draft(to: str, subject: str, body: str) -> dict:
    """Build a draft message dict (does NOT send — call send_draft after confirm)."""
    msg = MIMEText(body)
    msg["to"] = to
    msg["subject"] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return {"message": {"raw": raw}}


def send_draft(draft: dict) -> str:
    """Send a pre-built draft. Only call after explicit user confirmation."""
    svc = gmail_service()
    result = svc.users().messages().send(userId="me", body=draft["message"]).execute()
    return result.get("id", "")


def _extract_body(payload: dict) -> str:
    if payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")
    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain":
            data = part.get("body", {}).get("data", "")
            if data:
                return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
    return ""


if __name__ == "__main__":
    threads = list_unread(max_results=5)
    for t in threads:
        print(f"[{'U' if t.unread else ' '}] {t.sender[:30]:<30} {t.subject[:50]}")
