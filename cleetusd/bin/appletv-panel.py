#!/usr/bin/env python3
"""Persistent Apple TV connection for the studio panel. JSON lines on stdio.
Existing pyatv pairing stays on this Mac; never serialize configuration or credentials.
"""
import asyncio
from enum import Enum
import json
import logging
import os
import sys
import time
from urllib.parse import urlparse

import pyatv
from pyatv.const import FeatureName, FeatureState, InputAction, ShuffleState, RepeatState
from pyatv.storage.file_storage import FileStorage

logging.basicConfig(level=logging.ERROR, stream=sys.stderr)
NAME = os.environ.get("ATV_NAME", "GP TV")
atv = None
storage = None
catalog_cache = None
catalog_at = 0
stream_task = None
stream_error = None


def feature(name):
    try:
        return atv.features.get_feature(FeatureName[name]).state.name
    except Exception:
        return "Unsupported"


def require(name):
    if feature(name) != "Available":
        raise ValueError(name + " is not available on Apple TV right now")


def prop(getter, default=None):
    try:
        result = getter()
        return result.name if isinstance(result, Enum) else result
    except Exception:
        return default


async def connect():
    global atv, storage, catalog_at
    if atv is not None:
        return atv
    loop = asyncio.get_running_loop()
    storage = FileStorage.default_storage(loop)
    await storage.load()
    found = await pyatv.scan(loop, timeout=3, storage=storage)
    matches = [d for d in found if d.name == NAME]
    if len(matches) != 1:
        raise RuntimeError("GP TV not found uniquely. Check Apple TV power and Wi-Fi.")
    atv = await pyatv.connect(matches[0], loop, storage=storage)
    catalog_at = 0
    return atv


def disconnect():
    global atv
    if atv:
        atv.close()
    atv = None


async def state():
    await connect()
    playing = await atv.metadata.playing()
    app = prop(lambda: atv.metadata.app)
    info = atv.device_info
    return {
        "ok": True, "connected": True, "name": NAME, "at": int(time.time()*1000),
        "model": prop(lambda: info.model), "version": prop(lambda: info.version),
        "power": prop(lambda: atv.power.power_state, "Unknown"),
        "playback": prop(lambda: playing.device_state, "Unknown"),
        "title": prop(lambda: playing.title), "artist": prop(lambda: playing.artist),
        "album": prop(lambda: playing.album), "position": prop(lambda: playing.position),
        "duration": prop(lambda: playing.total_time), "shuffle": prop(lambda: playing.shuffle),
        "repeat": prop(lambda: playing.repeat),
        "app": {"name": app.name, "id": app.identifier} if app else None,
        "volume": prop(lambda: atv.audio.volume) if feature("Volume") == "Available" else None,
        "keyboardFocus": prop(lambda: atv.keyboard.text_focus_state, "Unknown"),
        "features": {f.name: feature(f.name) for f in FeatureName},
        "streamError": stream_error,
    }


async def catalog():
    global catalog_cache, catalog_at
    await connect()
    if catalog_cache and time.monotonic()-catalog_at < 60:
        return catalog_cache
    result = {"ok": True, "apps": [], "accounts": [], "outputs": []}
    errors = []
    for key, feat, get in [
        ("apps", "AppList", lambda: atv.apps.app_list()),
        ("accounts", "AccountList", lambda: atv.user_accounts.account_list()),
    ]:
        if feature(feat) == "Available":
            try:
                result[key] = [{"name": i.name, "id": i.identifier} for i in await get()]
            except Exception:
                errors.append(key + " unavailable")
    if feature("OutputDevices") == "Available":
        result["outputs"] = [{"name": i.name, "id": i.identifier} for i in atv.audio.output_devices]
    result["errors"] = errors
    catalog_cache, catalog_at = result, time.monotonic()
    return result


REMOTE = {
    "up": "Up", "down": "Down", "left": "Left", "right": "Right", "select": "Select",
    "menu": "Menu", "home": "Home", "top_menu": "TopMenu", "play": "Play", "pause": "Pause",
    "play_pause": "PlayPause", "stop": "Stop", "next": "Next", "previous": "Previous",
    "skip_forward": "SkipForward", "skip_backward": "SkipBackward", "screensaver": "Screensaver",
    "control_center": "ControlCenter", "guide": "Guide", "channel_up": "ChannelUp", "channel_down": "ChannelDown",
}


async def command(action, payload):
    global stream_task, stream_error, catalog_at
    await connect()
    if action in REMOTE:
        require(REMOTE[action])
        await getattr(atv.remote_control, action)()
        if action == "stop" and stream_task and not stream_task.done():
            stream_task.cancel()
    elif action == "wake":
        require("Home")
        # On this Apple TV HD, TurnOn acknowledges without waking. Existing
        # verified helper wakes with two Home presses after deep sleep.
        await atv.remote_control.home()
        await atv.remote_control.home()
    elif action == "sleep":
        require("TurnOff")
        await atv.power.turn_off()
    elif action in ("home_hold", "app_switcher"):
        require("Home")
        await atv.remote_control.home(action=InputAction.Hold if action == "home_hold" else InputAction.DoubleTap)
    elif action in ("volume_up", "volume_down"):
        require("VolumeUp" if action == "volume_up" else "VolumeDown")
        await getattr(atv.audio, action)()
    elif action == "set_volume":
        require("SetVolume")
        await atv.audio.set_volume(payload["value"])
    elif action == "seek":
        require("SetPosition")
        await atv.remote_control.set_position(int(payload["value"]))
    elif action == "shuffle":
        require("SetShuffle")
        await atv.remote_control.set_shuffle(ShuffleState[payload["value"]])
    elif action == "repeat":
        require("SetRepeat")
        await atv.remote_control.set_repeat(RepeatState[payload["value"]])
    elif action == "launch_app":
        require("LaunchApp")
        known = await catalog()
        if not any(a["id"] == payload["value"] for a in known["apps"]):
            raise ValueError("Choose an installed Apple TV app")
        await atv.apps.launch_app(payload["value"])
    elif action == "switch_account":
        require("SwitchAccount")
        known = await catalog()
        if not any(a["id"] == payload["value"] for a in known["accounts"]):
            raise ValueError("Choose an Apple TV profile")
        await atv.user_accounts.switch_account(payload["value"])
    elif action in ("text_set", "text_append", "text_clear"):
        require({"text_set": "TextSet", "text_append": "TextAppend", "text_clear": "TextClear"}[action])
        if prop(lambda: atv.keyboard.text_focus_state) != "Focused":
            raise ValueError("Open a text field on Apple TV first")
        if action == "text_clear":
            await atv.keyboard.text_clear()
        else:
            await getattr(atv.keyboard, action)(payload["value"])
    elif action in ("play_url", "stream_audio"):
        require("PlayUrl" if action == "play_url" else "StreamFile")
        url = urlparse(payload["value"])
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            raise ValueError("Use an http or https media URL without embedded credentials")
        if stream_task and not stream_task.done():
            raise ValueError("Stop the current URL stream before starting another")
        stream_error = None
        call = atv.stream.play_url(payload["value"]) if action == "play_url" else atv.stream.stream_file(payload["value"])
        stream_task = asyncio.create_task(call)
        def finished(task):
            global stream_error
            if not task.cancelled() and task.exception():
                stream_error = "The media URL could not play. Check the URL and media format."
        stream_task.add_done_callback(finished)
        await asyncio.sleep(0)
    elif action == "swipe":
        require("Swipe")
        await atv.touch.swipe(*payload["points"], payload["duration"])
    elif action == "touch_click":
        require("Click")
        await atv.touch.click(InputAction.SingleTap)
    elif action in ("add_output", "remove_output", "set_output"):
        require({"add_output": "AddOutputDevices", "remove_output": "RemoveOutputDevices", "set_output": "SetOutputDevices"}[action])
        method = {"add_output": "add_output_devices", "remove_output": "remove_output_devices", "set_output": "set_output_devices"}[action]
        await getattr(atv.audio, method)(*payload["devices"])
        catalog_at = 0
    else:
        raise ValueError("Unknown Apple TV command")
    # A successful send is an acknowledgement, not proof that playback changed.
    return {"ok": True, "accepted": True}


async def main():
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        req = {}
        try:
            req = json.loads(line)
            async with asyncio.timeout(18):
                if req["action"] == "state":
                    result = await state()
                elif req["action"] == "catalog":
                    result = await catalog()
                else:
                    result = await command(req["action"], req.get("payload", {}))
            response = {"id": req.get("id"), "result": result}
        except ValueError as e:
            response = {"id": req.get("id"), "result": {"ok": False, "error": str(e)}}
        except Exception:
            disconnect()
            response = {"id": req.get("id"), "result": {"ok": False, "connected": False, "error": "Apple TV did not respond. Check its power and Wi-Fi, then try again."}}
        print(json.dumps(response), flush=True)
    disconnect()


if __name__ == "__main__":
    asyncio.run(main())
