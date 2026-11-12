"""Each character has its own collection, told apart by server and name: one name can be taken on
several servers. Collections saved by name alone keep working."""

import json
import struct

from aion2_tracker import track

KAISINEL, ZIKEL = 1104, 2102


def varint(n: int) -> bytes:
    out = bytearray()
    while n >= 0x80:
        out.append(n & 0x7F | 0x80)
        n >>= 7
    return bytes(out + bytes([n]))


def record(body: bytes) -> bytes:
    return varint(len(body) + 4) + body


def named(text: str) -> bytes:
    return bytes([len(text)]) + text.encode()


def zone_entry(name: str, server: int, entity: int = 7001) -> bytes:
    """`33 36`: you entered a zone as `name` of `server`."""
    return record(b"\x33\x36" + varint(entity) + bytes(5) + named(name) + struct.pack("<H", server) + bytes(8))


def soul(pet: int) -> bytes:
    return record(b"\x0d\x90\x01" + struct.pack("<II", pet, 1))


def player_kill(name: str, server: int, guild: str) -> bytes:
    """`04 8d`: `name` of `server` killed a player."""
    return record(b"\x04\x8d" + varint(9100) + bytes(4) + varint(7001) + struct.pack("<H", server)
                  + named(name) + named(guild) + b"\x01")


def tracker(data: dict, events: list) -> track.Tracker:
    return track.Tracker(data, npcs={}, persist=False, on_event=events.append,
                         droppers={}, genera={}, dropper_worlds={})


def souls(t: track.Tracker) -> dict[int, int]:
    return {p["id"]: p["souls"] for p in t.snapshot()}


def test_the_same_name_on_two_servers_has_two_collections():
    events: list[dict] = []
    t = tracker({"pets": {}}, events)
    t.on_packet(0.0, zone_entry("Cro", KAISINEL))
    t.on_packet(1.0, soul(1006))
    t.on_packet(2.0, soul(1006))

    t.on_packet(100.0, zone_entry("Cro", ZIKEL))
    assert events[-1]["type"] == "character"
    assert (events[-1]["name"], events[-1]["server"], events[-1]["switched"]) == ("Cro", ZIKEL, True)
    assert souls(t) == {}
    t.on_packet(101.0, soul(1006))

    t.on_packet(200.0, zone_entry("Cro", KAISINEL))
    assert souls(t) == {1006: 2}
    assert t.character() == {"name": "Cro", "server": KAISINEL, "guild": None}

    t.on_packet(201.0, player_kill("Cro", KAISINEL, "Eclipse"))
    assert (events[-1]["type"], events[-1]["mine"], events[-1]["killer"]["guild"]) == ("pvpKill", True, "Eclipse")


def test_a_collection_saved_by_name_alone_goes_on_under_each_server(tmp_path):
    store = tmp_path / "collection.json"
    store.write_text(json.dumps({
        "pets": {"1006": {"souls": 4, "votes": {}, "level": 1}},
        "current": "Cro",
        "characters": {"Cro": {"server": KAISINEL, "guild": "Eclipse"},
                       "Alt": {"server": KAISINEL, "pets": {"1010": {"souls": 2, "votes": {}, "level": 0}}}},
    }), encoding="utf-8")
    events: list[dict] = []
    t = tracker(track.load(store), events)
    assert t.character() == {"name": "Cro", "server": KAISINEL, "guild": "Eclipse"}

    t.on_packet(0.0, zone_entry("Cro", KAISINEL))
    assert events == []  # the same character: its collection carries on
    assert souls(t) == {1006: 4}

    t.on_packet(100.0, zone_entry("Cro", ZIKEL))
    assert souls(t) == {}

    t.on_packet(200.0, zone_entry("Alt", KAISINEL))
    assert souls(t) == {1010: 2}

    t.on_packet(300.0, zone_entry("Cro", KAISINEL))
    assert souls(t) == {1006: 4}


def test_session_counts_saved_by_name_alone_come_back_after_the_update(tmp_path):
    store = tmp_path / "collection.json"
    store.write_text(json.dumps({"pets": {"1006": {"souls": 4, "votes": {}}}, "current": "Cro",
                                 "characters": {"Cro": {"server": KAISINEL}}}), encoding="utf-8")
    t = tracker(track.load(store), [])

    t.restore_sessions({"Cro": {"1006": 3}})  # as the helper before this one dumped them

    assert [p["session"] for p in t.snapshot()] == [3]
    assert t.session_counts() == {f"{KAISINEL}:Cro": {"1006": 3}}
