"""
Android ADB SMS integration.

Requirements:
  1. Android phone connected via USB with USB debugging enabled
  2. `adb` available on PATH  (sudo apt install android-tools-adb  or  brew install android-platform-tools)
  3. Run:  adb devices   — phone must appear as "device" (not "unauthorized")
  4. Grant the permission prompt that appears on your phone screen

Sending SMS uses Android Intents — no root required.
Reading SMS uses the content provider — also no root required.
"""

import subprocess
import json
import re
import shutil
from datetime import datetime, timezone

from cleetus.memory.database import save_sms, get_sms, get_unread_sms, mark_sms_read


def _adb(*args: str, timeout: int = 10) -> tuple[int, str, str]:
    """Run an adb command, return (returncode, stdout, stderr)."""
    cmd = ["adb", *args]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout, result.stderr
    except FileNotFoundError:
        return -1, "", "adb not found — install android-tools-adb"
    except subprocess.TimeoutExpired:
        return -1, "", "adb command timed out"


def is_adb_available() -> bool:
    return shutil.which("adb") is not None


def get_device_status() -> dict:
    """Return connection status and device serial if connected."""
    rc, out, err = _adb("devices")
    if rc != 0:
        return {"connected": False, "error": err or "adb not available"}
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    devices = [l for l in lines[1:] if "\t" in l]
    ready = [d for d in devices if d.split("\t")[1] == "device"]
    if not ready:
        unauthorized = [d for d in devices if "unauthorized" in d]
        if unauthorized:
            return {
                "connected": False,
                "error": "Phone connected but unauthorized — check your phone screen and tap 'Allow'",
            }
        return {"connected": False, "error": "No Android device found — connect via USB with USB debugging enabled"}
    serial = ready[0].split("\t")[0]
    return {"connected": True, "serial": serial, "device_count": len(ready)}


def _parse_sms_row(row: str) -> dict | None:
    """Parse one Row(...) line from adb content query output."""
    row = row.strip()
    if not row.startswith("Row:"):
        return None

    def extract(field: str) -> str:
        pattern = rf"{re.escape(field)}=([^,\n]+)"
        m = re.search(pattern, row)
        return m.group(1).strip() if m else ""

    address = extract("address")
    body = extract("body")
    date_ms = extract("date")
    sms_type = extract("type")  # 1=inbox, 2=sent
    thread_id = extract("thread_id")
    read_flag = extract("read")
    person = extract("person")  # contact id, may be empty

    if not address or not body:
        return None

    try:
        ts_ms = int(date_ms)
        ts = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat()
    except (ValueError, OSError):
        ts = datetime.now(timezone.utc).isoformat()

    direction = "incoming" if sms_type == "1" else "outgoing"

    return {
        "contact_number": address,
        "contact_name": person or address,
        "direction": direction,
        "body": body,
        "timestamp": ts,
        "thread_id": thread_id or None,
        "read": read_flag == "1",
    }


def sync_sms(limit: int = 200) -> dict:
    """
    Pull SMS messages from the connected Android device and store them locally.
    Returns a summary dict with counts.
    """
    status = get_device_status()
    if not status["connected"]:
        return {"success": False, "error": status["error"]}

    rc, out, err = _adb(
        "shell", "content", "query",
        "--uri", "content://sms",
        "--projection", "address,body,date,type,thread_id,read,person",
        "--sort", "date DESC",
        "--limit", str(limit),
        timeout=30,
    )

    if rc != 0:
        return {"success": False, "error": err or "Failed to query SMS"}

    rows = [l for l in out.splitlines() if l.strip().startswith("Row:")]
    saved = 0
    for row in rows:
        parsed = _parse_sms_row(row)
        if parsed:
            save_sms(**parsed)
            saved += 1

    return {"success": True, "synced": saved, "total_rows": len(rows)}


def send_sms(to: str, message: str) -> dict:
    """
    Send an SMS via Android Intents. Opens the messaging app with pre-filled
    recipient and body. Sending is initiated by the OS — no special permissions needed.

    Note: This uses ACTION_SENDTO intent which pre-fills the message but does NOT
    auto-send (requires user confirmation on phone). For true background sending,
    root or ADB shell permissions would be needed.
    """
    status = get_device_status()
    if not status["connected"]:
        return {"success": False, "error": status["error"]}

    # Escape message for shell
    escaped_msg = message.replace("'", "\\'").replace('"', '\\"')
    # Normalize phone number
    to_clean = re.sub(r"[^\d+]", "", to)

    rc, out, err = _adb(
        "shell", "am", "start",
        "-a", "android.intent.action.SENDTO",
        "-d", f"smsto:{to_clean}",
        "--es", "sms_body", escaped_msg,
        "--ez", "exit_on_sent", "true",
        timeout=15,
    )

    if rc != 0:
        return {"success": False, "error": err or "Failed to open SMS app"}

    return {
        "success": True,
        "message": f"SMS composer opened on phone to {to_clean}. Tap Send on your phone.",
        "to": to_clean,
    }


def get_recent_sms(limit: int = 50, contact: str | None = None) -> list[dict]:
    """Return locally stored SMS messages (run sync_sms first)."""
    return get_sms(limit=limit, contact_number=contact)


def get_unread() -> list[dict]:
    """Return unread incoming SMS messages."""
    return get_unread_sms()


def mark_read(sms_id: str):
    mark_sms_read(sms_id)


def format_sms_summary(messages: list[dict]) -> str:
    """Format SMS messages as readable text for CLEETUS to report."""
    if not messages:
        return "No messages."
    lines = []
    for m in messages:
        name = m.get("contact_name") or m.get("contact_number", "Unknown")
        direction = "→ you" if m["direction"] == "incoming" else "you →"
        ts = m.get("timestamp", "")[:16].replace("T", " ")
        lines.append(f"[{ts}] {name} ({direction}): {m['body']}")
    return "\n".join(lines)
