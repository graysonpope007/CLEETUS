#!/opt/homebrew/bin/python3
"""
gdrive.py — Google Drive integration module. Read-only.
"""
from __future__ import annotations

from dataclasses import dataclass

from .auth_google import drive_service


@dataclass
class DriveFile:
    file_id: str
    name: str
    mime_type: str
    modified_time: str
    web_view_link: str


def search_files(query: str, max_results: int = 10) -> list[DriveFile]:
    """Full-text search across Drive. query uses Drive search syntax."""
    svc = drive_service()
    result = svc.files().list(
        q=query,
        pageSize=max_results,
        fields="files(id,name,mimeType,modifiedTime,webViewLink)",
        orderBy="modifiedTime desc",
    ).execute()
    return [
        DriveFile(
            file_id=f["id"],
            name=f["name"],
            mime_type=f.get("mimeType", ""),
            modified_time=f.get("modifiedTime", ""),
            web_view_link=f.get("webViewLink", ""),
        )
        for f in result.get("files", [])
    ]


def get_file_content(file_id: str) -> str:
    """Export Google Doc as plain text, or download binary files as UTF-8."""
    svc = drive_service()
    meta = svc.files().get(fileId=file_id, fields="mimeType,name").execute()
    mime = meta.get("mimeType", "")

    if mime == "application/vnd.google-apps.document":
        content = svc.files().export(fileId=file_id, mimeType="text/plain").execute()
        return content.decode("utf-8", errors="replace") if isinstance(content, bytes) else content
    else:
        content = svc.files().get_media(fileId=file_id).execute()
        return content.decode("utf-8", errors="replace") if isinstance(content, bytes) else str(content)


if __name__ == "__main__":
    files = search_files("fullText contains 'STEAP'", max_results=5)
    if not files:
        print("No Drive files found for 'STEAP'.")
    for f in files:
        print(f"  {f.name} ({f.mime_type}) — {f.modified_time[:10]}")
