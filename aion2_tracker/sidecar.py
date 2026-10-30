"""The tracker as a background helper for the overlay app: JSON lines in, JSON lines out.

    python -m aion2_tracker.sidecar [--data collection.json] [--paused] [--replay X.pcap --speed 4]

stdout, one JSON object per line (nothing else is ever written there):
    {"type": "ready", "pets": [...], "character": {"name", "server"} | null}
                                                        on start, the saved collection
    {"type": "character", "name": "Cro", "server": 1104, "switched": true, "pets": [...]}
                                                        a character entered the world that is not
                                                        the one the collection was: its own
                                                        collection (switched), or the first one seen
    {"type": "status", "state": "listening" | "locked" | "idle" | "stopped" | "error", ...}
                                                        idle: not capturing (paused)
    {"type": "heartbeat", "lastPacketAgo": 1.2}         every 2 s while capturing: seconds since
                                                        the last game packet
    {"type": "sync", "pets": 119, "souls": 938, "corrected": [...], "collection": [...]}
    {"type": "soul", "amount": 1, "pet": {...}, "levelUp": false, "levelUndone": false}
                                                        levelUndone: the pet a crystal had put
                                                        at Lv3 was not (it got this soul)
    {"type": "crystal", "amount": 1, "genus": "fera" | "cogni" | null, "pet": {...} | null,
     "npc": 2100006 | null, "raw": "01 01 ...", "levelCorrected": false,
     "kills": [{"npc", "name", "pet", "ago"}]}     kills considered, when credited to no pet
                                                        genus crystals (the pet is maxed), credited
                                                        to the pet the last kill drops; null if
                                                        that kill's monster is not known
    {"type": "pet", "pet": {...}}                       after an edit
    {"type": "combat"}                                  you killed something (at most every 5 s)
    {"type": "kina", "balance": 3769926}                your Kina, whenever it changes
    {"type": "pvpKill", "killer": {"name", "server", "guild"}, "victim": {"name", "server"} | null,
     "mine": false, "died": false}                      a player killed a player around you
    {"type": "shop", "tab": 104, "nextAt": ms | null, "items": [{"slot", "item", "quantity",
     "currency", "base", "price"}]}                     a Black Cloud Merchant tab was opened
    {"type": "fieldBosses", "world": 1010, "bosses": [{"id": 101021, "up": false, "at": ms}]}
                                                        the map's field boss list, when it changes
                                                        (up: spawned at; dead: respawns at)
    {"type": "snapshot", "pets": [...]}                 answer to {"cmd": "snapshot"}, then a nearby
    {"type": "nearby", "world": 1010, "position": [x, y] | null, "height": z | null,
     "monsters": [{"npc", "count"}]}
                                                        what is loaded around you, when it changes

stdin, one JSON object per line:
    {"cmd": "snapshot"} · {"cmd": "set", "pet": 1006, "souls": 32}
    {"cmd": "name", "pet": 1006, "name": "Meadow Sparkie"} · {"cmd": "quit"}
    {"cmd": "resetSession"}             start the session's soul counts again; answered with a
                                        snapshot
    {"cmd": "dumpSession"}              every character's session counts, answered with
                                        {"type": "session", "sessions": {"Cro": {"1006": 3}}}
                                        (the app keeps them across an update restart)
    {"cmd": "restoreSession", "sessions": {...}, "world": 1010 | null, "position": [x, y] | null}
                                        put them back after the restart; answered with a snapshot
    {"cmd": "capture", "on": false}     stop capturing (the game closed) or start again. Paused,
                                        the helper only serves the collection; a session's counts
                                        carry on across a pause. --paused starts it that way.
    {"cmd": "addon", "addon": "example", "name": "...", "data": ...}
                                        to an addon's Python part, from its pages (addons.py)
    {"cmd": "addonSettings", "addon": "example", "values": {...}}
                                        its declared settings, at start and when they change

--addon <id>=<file.py>, once per addon, loads addons' Python parts (addons.py has their lines out).

A pet is {"id", "name" (null if unknown), "souls", "level", "levelEstimated", "session"}.
The app ends the helper by sending quit or closing stdin.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from pathlib import Path

from . import capture
from .addons import Addons
from .analyze import NPCS_DEFAULT
from .track import STORE, Tracker, load


# Nearby (monsters, your position) goes out at most this often, when it changed.
NEARBY_EVERY_S = 0.25
# Debug logging keeps this many recordings of the game connection, the newest.
RECORDINGS_KEPT = 3


def recording(folder: str | None) -> str | None:
    """A new recording's path in `folder` (each capture gets its own), the oldest beyond
    RECORDINGS_KEPT removed first. None without debug logging."""
    if folder is None:
        return None
    where = Path(folder)
    where.mkdir(parents=True, exist_ok=True)
    for old in sorted(where.glob("stream-*.pcap"))[: -(RECORDINGS_KEPT - 1) or None]:
        old.unlink(missing_ok=True)
    return str(where / f"stream-{time.strftime('%Y%m%d-%H%M%S')}.pcap")

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(STORE), help="the collection file")
    ap.add_argument("--npcs", default=str(NPCS_DEFAULT))
    ap.add_argument("--replay", help="feed a saved capture instead of the live game (to try the UI)")
    ap.add_argument("--speed", type=float, default=1.0, help="replay speed, as a multiple of real time")
    ap.add_argument("--paused", action="store_true", help="start without capturing (the game is closed)")
    ap.add_argument("--addon", action="append", default=[], help="an addon's Python part, as <id>=<file.py>")
    ap.add_argument("--debug-dir", help="debug logging: the stream's health every report, and the game "
                                        "connection recorded to a .pcap in this folder")
    a = ap.parse_args()

    # UTF-8 both ways, whatever the environment: the packaged helper ignores the app's
    # PYTHONIOENCODING and would write cp1252, which cannot encode names like "ツ".
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    # stdout belongs to the protocol. Anything printed by accident (a library, a stray print) goes
    # to stderr instead of corrupting it.
    out_stream, sys.stdout = sys.stdout, sys.stderr
    out_lock = threading.Lock()

    def emit(ev: dict) -> None:
        line = json.dumps(ev, ensure_ascii=False)
        with out_lock:
            out_stream.write(line + "\n")
            out_stream.flush()

    store = Path(a.data)
    data = load(store)
    npcs = json.loads(Path(a.npcs).read_text(encoding="utf-8"))
    last_packet = [None]

    def on_event(ev: dict) -> None:
        if ev["type"] == "sync":
            ev = {**ev, "collection": tracker.snapshot()}
        emit(ev)

    tracker = Tracker(data, npcs, persist=a.replay is None, on_event=on_event, store=store)
    if a.addon:
        addons = Addons(tracker, emit)
        with tracker.lock:
            addons.load(a.addon)
            tracker.addons = addons

    def on_packet(ts: float, pkt: bytes) -> None:
        last_packet[0] = time.monotonic()
        tracker.on_packet(ts, pkt)

    def on_lock(host: str, port: int) -> None:
        emit({"type": "status", "state": "locked", "server": f"{host}:{port}"})

    stop = threading.Event()  # the helper is ending
    # The current capture's stop, or None while paused. Each capture gets a new event and a new
    # stream: the next game is a new connection, to lock onto afresh.
    capturing: list[threading.Event | None] = [None]

    def run_capture(halt: threading.Event) -> None:
        stream = capture.GameStream(on_packet, on_lock=on_lock)
        try:
            emit({"type": "status", "state": "listening", "source": a.replay or "live"})
            if a.replay:
                capture.replay(a.replay, stream, speed=a.speed, stop=halt)
            else:
                capture.live(stream, stop=halt, log=lambda m: print(m, file=sys.stderr),
                             debug=a.debug_dir is not None, record_to=recording(a.debug_dir))
            if not halt.is_set():
                emit({"type": "status", "state": "stopped"})
        except Exception as e:  # noqa: BLE001 -- reported to the app, which shows it
            emit({"type": "status", "state": "error", "detail": f"{type(e).__name__}: {e}"})

    def set_capture(on: bool) -> None:
        if on and capturing[0] is None:
            halt = threading.Event()
            capturing[0] = halt
            threading.Thread(target=run_capture, args=(halt,), name="capture", daemon=True).start()
        elif not on and capturing[0] is not None:
            capturing[0].set()
            capturing[0] = None
            last_packet[0] = None
            tracker.forget_view()
            emit({"type": "status", "state": "idle"})
            emit({"type": "nearby", **tracker.nearby()})

    def heartbeat() -> None:
        while not stop.wait(2.0):
            if capturing[0] is None:
                continue
            ago = None if last_packet[0] is None else round(time.monotonic() - last_packet[0], 1)
            emit({"type": "heartbeat", "lastPacketAgo": ago})

    def nearby_out() -> None:
        # What is around you (monsters, your position) within 250 ms of a change,
        # at most 4 times a second however busy it gets.
        while not stop.wait(NEARBY_EVERY_S):
            if capturing[0] is not None and tracker.nearby_dirty:
                emit({"type": "nearby", **tracker.nearby()})

    emit({"type": "ready", "pets": tracker.snapshot(), "character": tracker.character(), "data": str(store), "replay": bool(a.replay)})
    if a.paused and not a.replay:
        emit({"type": "status", "state": "idle"})
    else:
        set_capture(True)
    threading.Thread(target=heartbeat, name="heartbeat", daemon=True).start()
    threading.Thread(target=nearby_out, name="nearby", daemon=True).start()

    for line in sys.stdin:
        try:
            msg = json.loads(line)
            cmd = msg.get("cmd")
            if cmd == "quit":
                break
            if cmd == "snapshot":
                emit({"type": "snapshot", "pets": tracker.snapshot()})
                emit({"type": "nearby", **tracker.nearby()})
            elif cmd == "set":
                emit({"type": "pet", "pet": tracker.set_souls(int(msg["pet"]), int(msg["souls"]))})
            elif cmd == "resetSession":
                tracker.reset_session()
                emit({"type": "snapshot", "pets": tracker.snapshot()})
            elif cmd == "dumpSession":
                emit({"type": "session", "sessions": tracker.session_counts()})
            elif cmd == "restoreSession":
                tracker.restore_sessions(msg.get("sessions") or {}, msg.get("world"), msg.get("position"))
                emit({"type": "snapshot", "pets": tracker.snapshot()})
                emit({"type": "nearby", **tracker.nearby()})
            elif cmd == "name":
                emit({"type": "pet", "pet": tracker.set_name(int(msg["pet"]), str(msg["name"]))})
            elif cmd == "capture":
                if not a.replay:
                    set_capture(bool(msg["on"]))
            elif cmd in ("addon", "addonSettings"):
                if tracker.addons is not None:
                    with tracker.lock:
                        if cmd == "addon":
                            tracker.addons.message(str(msg["addon"]), str(msg["name"]), msg.get("data"))
                        else:
                            tracker.addons.settings(str(msg["addon"]), dict(msg.get("values") or {}))
            else:
                emit({"type": "error", "detail": f"unknown command {cmd!r}"})
        except (ValueError, KeyError, TypeError) as e:
            emit({"type": "error", "detail": f"bad command: {e}"})
    stop.set()
    if capturing[0] is not None:
        capturing[0].set()


if __name__ == "__main__":
    main()
