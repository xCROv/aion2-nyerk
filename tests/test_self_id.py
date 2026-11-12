"""Which entity is you, after a zone change: entity ids change between zones, so the one you were
in the last zone is someone else's in this one."""

import struct

from aion2_tracker import track

YOU_BEFORE, YOU_NOW, SOMEONE = 7001, 8002, 9003
START = (1500.0, 2500.0)


def varint(n: int) -> bytes:
    out = bytearray()
    while n >= 0x80:
        out.append(n & 0x7F | 0x80)
        n >>= 7
    return bytes(out + bytes([n]))


def record(body: bytes) -> bytes:
    return varint(len(body) + 4) + body


def zone_entry(entity: int) -> bytes:
    """`33 36`: you (Cro of server 1104) entered a zone as `entity`."""
    return record(b"\x33\x36" + varint(entity) + bytes(5) + b"\x03Cro" + struct.pack("<H", 1104) + bytes(8))


def spawn(entity: int, mob_code: int = 2100006) -> bytes:
    return record(b"\x41\x36" + varint(entity) + b"\x01" + mob_code.to_bytes(3, "little") + b"\x00\x00\x02" + bytes(8))


def kill(mob: int, player: int) -> bytes:
    """`04 8d`: `player` (Cro) got the kill of `mob`."""
    return record(b"\x04\x8d" + varint(mob) + bytes(4) + varint(player) + struct.pack("<H", 1104) + b"\x03Cro\x00\x00")


def soul(pet: int = 1006) -> bytes:
    return record(b"\x0d\x90\x01" + struct.pack("<II", pet, 1))


def map_load(world: int, x: float, y: float) -> bytes:
    return record(b"\x21\x36" + bytes(4) + struct.pack("<I", world) + bytes(8) + struct.pack("<3f", x, y, 20_000.0))


def effect(on: int, x: float, y: float) -> bytes:
    """`2a 38`: an effect put on `on`, standing at x, y."""
    return record(b"\x2a\x38" + varint(1) + struct.pack("<Q", 1_790_000_000_000) + varint(on) + b"\x01\x00"
                  + struct.pack("<3f", x, y, 20_000.0))


def tracker(events: list) -> track.Tracker:
    return track.Tracker({"pets": {}}, npcs={}, persist=False, on_event=events.append,
                         droppers={}, genera={}, dropper_worlds={})


def your_souls(t: track.Tracker, ts: float, player: int) -> None:
    """Three kills credited to `player`, each with a soul for you just after."""
    for k in range(3):
        mob = 5001 + k
        t.on_packet(ts + k, spawn(mob))
        t.on_packet(ts + k + 0.1, kill(mob, player))
        t.on_packet(ts + k + 0.4, soul())


def test_after_a_zone_change_you_are_who_the_zone_entry_says():
    events: list[dict] = []
    t = tracker(events)
    t.on_packet(0.0, zone_entry(YOU_BEFORE))
    your_souls(t, 1.0, YOU_BEFORE)

    t.on_packet(10.0, map_load(1020, *START))
    t.on_packet(10.1, zone_entry(YOU_NOW))
    t.on_packet(11.0, effect(on=YOU_BEFORE, x=5000.0, y=6000.0))  # someone else's entity now

    assert t.position == (START[0], -START[1])
    assert t.self_id() == YOU_NOW

    t.on_packet(11.5, effect(on=YOU_NOW, x=1600.0, y=2600.0))
    t.on_packet(20.0, spawn(5100))
    t.on_packet(20.1, kill(5100, YOU_NOW))

    assert t.position == (1600.0, -2600.0)
    assert [ev["ts"] for ev in events if ev["type"] == "combat"][-1] == 20.1


def test_the_last_zones_votes_do_not_say_who_you_are_in_this_one():
    t = tracker([])
    your_souls(t, 1.0, YOU_BEFORE)  # started mid-game: no zone entry seen, you are who gets your souls
    assert t.self_id() == YOU_BEFORE

    t.on_packet(10.0, map_load(1020, *START))
    t.on_packet(11.0, effect(on=YOU_BEFORE, x=5000.0, y=6000.0))

    assert t.position == (START[0], -START[1])
    assert t.self_id() is None

    your_souls(t, 12.0, SOMEONE)

    assert t.self_id() == SOMEONE
