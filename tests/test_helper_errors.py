"""The helper keeps running through bad commands, saves that fail, packets that fail and
positions that are not numbers."""

import io
import json
import math
import struct
import sys
from pathlib import Path

import pytest

from aion2_tracker import capture, protocol, sidecar, track

SERVER = ("10.0.0.1", 13328, "192.168.1.2", 50000)
HELD = PermissionError(13, "The process cannot access the file because it is being used by another process")


def varint(n: int) -> bytes:
    out = bytearray()
    while n >= 0x80:
        out.append(n & 0x7F | 0x80)
        n >>= 7
    return bytes(out + bytes([n]))


def record(body: bytes) -> bytes:
    """One record of the stream, as the server frames it: `body` starts with the opcode."""
    return varint(len(body) + 4) + body


def soul(pet: int, amount: int = 1) -> bytes:
    return record(b"\x0d\x90\x01" + struct.pack("<II", pet, amount))


def map_load(world: int, x: float, y: float) -> bytes:
    return record(b"\x21\x36" + bytes(4) + struct.pack("<I", world) + bytes(8) + struct.pack("<3f", x, y, 20_000.0))


def teleport(x: float, y: float) -> bytes:
    return record(b"\x23\x36" + bytes(6) + struct.pack("<3f", x, y, 20_000.0))


def tracker(events: list, store: Path) -> track.Tracker:
    return track.Tracker({"pets": {}}, npcs={}, on_event=events.append, store=store,
                         droppers={}, genera={}, dropper_worlds={})


def run_helper(monkeypatch, store: Path, commands: list[str]) -> list[dict]:
    """The helper, paused, given `commands` on stdin: what it wrote on stdout."""
    monkeypatch.setattr(sys, "argv", ["sidecar", "--data", str(store), "--paused"])
    monkeypatch.setattr(sys, "stdin", io.StringIO("".join(c + "\n" for c in commands)))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", io.StringIO())
    sidecar.main()
    return [json.loads(line) for line in out.getvalue().splitlines()]


def test_commands_that_are_not_objects_or_fail_are_answered_with_an_error(monkeypatch, tmp_path):
    out = run_helper(monkeypatch, tmp_path / "collection.json", [
        "[1]",
        '"snapshot"',
        '{"cmd": "restoreSession", "sessions": [1]}',
        '{"cmd": "snapshot"}',
        '{"cmd": "quit"}',
    ])

    assert [ev["type"] for ev in out] == ["ready", "status", "error", "error", "error", "snapshot", "nearby"]


def test_a_set_whose_save_keeps_failing_is_still_answered(monkeypatch, tmp_path):
    def held(self, target):
        raise HELD

    monkeypatch.setattr(Path, "replace", held)
    monkeypatch.setattr(track, "SAVE_RETRIES_S", (0.0,), raising=False)

    out = run_helper(monkeypatch, tmp_path / "collection.json", [
        '{"cmd": "set", "pet": 1006, "souls": 3}',
        '{"cmd": "snapshot"}',
        '{"cmd": "quit"}',
    ])

    assert out[2] == {"type": "pet", "pet": {"id": 1006, "name": None, "souls": 3, "level": 0,
                                             "levelEstimated": True, "crystals": 0, "session": 0}}
    assert out[3]["type"] == "snapshot"


def test_a_save_held_for_a_moment_is_tried_again(monkeypatch, tmp_path):
    replace, tries = Path.replace, []

    def held_twice(self, target):
        tries.append(target)
        if len(tries) <= 2:
            raise HELD
        return replace(self, target)

    monkeypatch.setattr(Path, "replace", held_twice)
    store = tmp_path / "collection.json"

    track.save({"pets": {"1006": {"souls": 3, "votes": {}}}}, store)

    assert len(tries) == 3
    assert json.loads(store.read_text(encoding="utf-8"))["pets"]["1006"]["souls"] == 3


def test_a_soul_whose_save_fails_still_reaches_the_overlay(monkeypatch, tmp_path):
    def held(self, target):
        raise HELD

    monkeypatch.setattr(Path, "replace", held)
    monkeypatch.setattr(track, "SAVE_RETRIES_S", (0.0,), raising=False)
    events: list[dict] = []
    t = tracker(events, tmp_path / "collection.json")

    t.on_packet(1.0, soul(1006))

    assert [(ev["type"], ev["pet"]["id"], ev["pet"]["souls"]) for ev in events] == [("soul", 1006, 1)]


def test_a_packet_that_fails_does_not_lose_the_rest_of_its_segment(capsys):
    seen = []

    def on_packet(ts: float, pkt: bytes) -> None:
        if pkt.endswith(b"!"):
            raise KeyError("boom")
        seen.append(pkt)

    stream = capture.GameStream(on_packet, server_port=SERVER[1])
    good, bad = record(b"\x99\x99ok"), record(b"\x99\x99!")

    stream.segment(1.0, *SERVER, 1000, good + bad + bad + bad + bad + good)

    assert seen == [good, good]
    # Logged the 1st, 2nd and 4th time: how often, without a line for each.
    assert capsys.readouterr().err.count("a packet") == 3


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_positions_that_are_not_numbers_are_not_read(bad):
    assert protocol.parse_map_load(map_load(1010, bad, 1500.0)) is None
    assert protocol.parse_map_load(map_load(1010, 1500.0, bad)) is None
    assert protocol.parse_self_teleport(teleport(bad, 1500.0)) is None
    assert protocol.parse_map_load(map_load(1010, 1500.0, 2500.0)) == protocol.MapLoad(1010, 1500.0, 2500.0)


@pytest.mark.parametrize("bad", [math.nan, math.inf])
def test_nearby_still_answers_after_a_zone_load_misread(bad, tmp_path):
    t = tracker([], tmp_path / "collection.json")
    t.on_packet(1.0, map_load(1010, 1500.0, 2500.0))

    t.on_packet(2.0, map_load(1020, bad, 2500.0))
    t.on_packet(3.0, teleport(bad, 2500.0))

    assert t.nearby() == {"world": 1010, "position": [1500, -2500], "height": 20000, "monsters": []}
