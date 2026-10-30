"""Aion 2 server->client stream: framing and the few records the pet tracker needs.

Layouts were learned from the community DPS meters (taengu/A2Tools-DPS-Meter, current as of
the June 2026 opcode shift). Everything here is written fresh; only the byte layouts are shared.

Stream:  <varint len> <body>      total frame size = len - 4 + varint_bytes
Bundle:  <varint len> FF FF <u32 LE decompressed size> <LZ4 block>   -> more frames inside
Opcode:  the two bytes right after the length varint, e.g. `42 36`.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import lz4.block

MAX_PACKET_BYTES = 65535
MAX_FRAGMENT_WAIT_BYTES = 16384
MAX_DECOMPRESSED_BYTES = 1_000_000
MAX_BUNDLE_DEPTH = 4

OP_SPAWN = (0x41, 0x36)  # mob / summon spawn (was 40 36 before 2026-06)
OP_DEATH = (0x42, 0x36)  # death / despawn (was 41 36 before 2026-06)
OP_DAMAGE = (0x04, 0x38)
OP_PARTY_SCOPE = (0x06, 0x38)  # only ever about you and your party
DEATH_FLAG_COMBAT = 3

# The game stream carries this terminator ~19x/s even idle; used to find the game flow.
GAME_SIGNATURES = (b"\x0e\x00\x36", b"\x06\x00\x36")


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    """(value, byte length); length 0 means no valid varint at `pos`."""
    value = shift = count = 0
    while True:
        if pos + count >= len(buf):
            return 0, 0
        b = buf[pos + count]
        count += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, count
        shift += 7
        if shift >= 32:
            return 0, 0


def frame_size(value: int, varint_len: int) -> int | None:
    size = value - 4 + varint_len
    return size if size >= varint_len and size > 0 else None


def _is_tls_record(b: bytes, at: int) -> int | None:
    if len(b) - at < 5 or not 0x14 <= b[at] <= 0x17 or b[at + 1] != 0x03 or not 1 <= b[at + 2] <= 4:
        return None
    n = int.from_bytes(b[at + 3 : at + 5], "big")
    return 5 + n if 0 < n <= 16384 + 256 else None


def walk(buf: bytes, *, inner: bool = False) -> tuple[list[tuple[int, int]], int]:
    """Split `buf` into (start, end) frames. Returns the frames and how many bytes were consumed;
    the rest is a frame still arriving. `inner` is the stricter walk used inside a bundle."""
    frames: list[tuple[int, int]] = []
    off = 0
    while off < len(buf):
        if buf[off] == 0:
            off += 1
            continue
        if not inner and (tls := _is_tls_record(buf, off)):
            if off + tls > len(buf):
                break
            off += tls
            continue
        value, vlen = read_varint(buf, off)
        if vlen == 0 or value <= 0:
            if inner:
                break
            if off + 5 > len(buf):
                break
            off += 1
            continue
        total = frame_size(value, vlen)
        if total is None or (not inner and total > MAX_PACKET_BYTES):
            off += 1
            continue
        if off + total > len(buf):
            # A big length is most likely a misread, so it is skipped rather than waited for;
            # a bundle's (FF FF after it) is real. A server handoff (a Spacetime rift, joining
            # another continent) sends the new area in one bundle of over 16 KB, and skipping
            # it read its LZ4 bytes as frames and lost the zone load behind it.
            if not inner and total > MAX_FRAGMENT_WAIT_BYTES:
                marker = buf[off + vlen : off + vlen + 2]
                if len(marker) == 2 and marker != b"\xff\xff":
                    off += 1
                    continue
            break
        frames.append((off, off + total))
        off += total
    return frames, off


def decompress_bundle(payload: bytes) -> bytes | None:
    """`payload` starts at the FF FF marker."""
    if len(payload) < 7:
        return None
    size = int.from_bytes(payload[2:6], "little")
    if size == 0 or size > MAX_DECOMPRESSED_BYTES:
        return None
    try:
        return lz4.block.decompress(payload[6:], uncompressed_size=size)
    except lz4.block.LZ4BlockError:
        return None


def split(buf: bytes, depth: int = 0, *, inner: bool = False) -> tuple[list[bytes], int]:
    """Every leaf packet in `buf`, bundles opened, and how many bytes of `buf` were consumed."""
    out: list[bytes] = []
    frames, consumed = walk(buf, inner=inner)
    for start, end in frames:
        pkt = buf[start:end]
        _, vlen = read_varint(pkt, 0)
        if len(pkt) > vlen + 1 and pkt[vlen] == 0xFF and pkt[vlen + 1] == 0xFF:
            if depth < MAX_BUNDLE_DEPTH and (data := decompress_bundle(pkt[vlen:])):
                out.extend(split(data, depth + 1, inner=True)[0])
        else:
            out.append(pkt)
    return out, consumed


# A tunnel some players' game traffic goes through (a tester with ExitLag, 2026-10-30: their
# collection.json held 29 "pets" read out of its bytes). Each message is `01 <u24 LE len>` and then
# fields `<f> <tag> <len, f >> 2 bytes LE> <value>` (f 05: one length byte, 09: two). Tag 01 is
# the kind (09 data, 0a an ack), 03 a 16-byte session id, 22 the data's sequence number, 23 the game
# stream's own bytes, a slice of it as the server sent it:
#   01 32 00 00 | 05 01 01 09 | 05 02 01 01 | 05 03 10 <16 bytes> | 05 22 02 ed 2c
#   | 05 23 0b [0e 00 36 26 fd 20 8e a1 01 00 00] | 05 25 01 01
# Read as the game stream itself it frames as junk: 803 records out of 784 KB, unwrapped 8,830.
TUNNEL_DATA = 0x23
_TUNNEL_START = b"\x05\x01\x01"  # the first field of every message: its kind


def _tunnel_message(buf: bytes, pos: int) -> tuple[list[bytes], int] | None:
    """The fields of the message at `pos`, as (tag-23 values, its end); None if it is not one. A
    message not all here yet is ([], -1)."""
    if len(buf) - pos < 7:
        return [], -1
    if buf[pos] != 1 or buf[pos + 4 : pos + 7] != _TUNNEL_START:
        return None
    end = pos + 4 + int.from_bytes(buf[pos + 1 : pos + 4], "little")
    if end > len(buf):
        return ([], -1) if end - pos <= MAX_PACKET_BYTES else None
    data, i = [], pos + 4
    while i < end:
        f = buf[i]
        n = f >> 2
        if f & 3 != 1 or not 1 <= n <= 3 or i + 2 + n > end:
            return None
        size = int.from_bytes(buf[i + 2 : i + 2 + n], "little")
        if i + 2 + n + size > end:
            return None
        if buf[i + 1] == TUNNEL_DATA:
            data.append(buf[i + 2 + n : i + 2 + n + size])
        i += 2 + n + size
    return data, end


def is_tunnel(buf: bytes) -> bool:
    """Two messages back to back somewhere in `buf`: the stream is the tunnel's."""
    at = buf.find(_TUNNEL_START)
    while at != -1:
        if (m := _tunnel_message(buf, at - 4)) and m[1] != -1 and (n := _tunnel_message(buf, m[1])) and n[1] != -1:
            return True
        at = buf.find(_TUNNEL_START, at + 1)
    return False


def maybe_tunnel(buf: bytes) -> bool:
    """`buf` starts as a tunnel message would, too little of it here to tell (is_tunnel)."""
    return len(buf) < 4096 and buf[:1] == b"\x01" and _TUNNEL_START.startswith(buf[4:7])


def unwrap_tunnel(buf: bytes) -> tuple[bytes, int]:
    """The game stream's bytes carried in `buf`'s messages, and how many bytes of `buf` were
    consumed; the rest is a message still arriving. Bytes that are not a message (the stream joined
    partway, or after a gap) are skipped to the next one."""
    out, pos = bytearray(), 0
    while pos < len(buf):
        m = _tunnel_message(buf, pos)
        if m is None:
            nxt = buf.find(_TUNNEL_START, pos + 5)
            if nxt == -1:
                return bytes(out), max(pos, len(buf) - 6)
            pos = nxt - 4
            continue
        data, end = m
        if end == -1:
            break
        for d in data:
            out += d
        pos = end
    return bytes(out), pos


def opcode(pkt: bytes) -> tuple[int, int] | None:
    _, vlen = read_varint(pkt, 0)
    if vlen == 0 or vlen + 2 > len(pkt):
        return None
    return pkt[vlen], pkt[vlen + 1]


# --- records ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Spawn:
    entity_id: int
    mob_code: int | None
    max_hp: int | None


@dataclass(frozen=True)
class Death:
    entity_id: int
    flag: int


@dataclass(frozen=True)
class Hit:
    target_id: int
    actor_id: int
    skill: int


@dataclass(frozen=True)
class PartyScope:
    entity_id: int


def parse_spawn(pkt: bytes) -> Spawn | None:
    """`41 36 <entity varint> <mask> ...`; the mob code is the u24 before an `00 (00|40) 02` marker
    within 60 bytes, and the HP follows as `01 <cur varint> <max varint>`."""
    _, vlen = read_varint(pkt, 0)
    if opcode(pkt) != OP_SPAWN:
        return None
    pos = vlen + 2
    eid, n = read_varint(pkt, pos)
    if n == 0:
        return None
    pos += n
    code = hp = None
    limit = min(len(pkt) - 2, pos + 60)
    for i in range(pos, limit):
        if pkt[i] == 0 and pkt[i + 1] in (0x00, 0x40) and pkt[i + 2] == 0x02:
            if i >= pos + 3:
                code = pkt[i - 3] | pkt[i - 2] << 8 | pkt[i - 1] << 16
                hp_end = min(len(pkt) - 2, i + 3 + 64)
                for j in range(i + 3, hp_end):
                    if pkt[j] != 0x01:
                        continue
                    cur, cn = read_varint(pkt, j + 1)
                    if cn and cur > 0:
                        mx, mn = read_varint(pkt, j + 1 + cn)
                        if mn and mx >= cur:
                            hp = mx
                            break
            break
    return Spawn(eid, code, hp)


def parse_death(pkt: bytes) -> Death | None:
    """`42 36 <entity varint> <varint, always 0> <flag varint>`; flag 3 = killed in combat."""
    if opcode(pkt) != OP_DEATH:
        return None
    _, vlen = read_varint(pkt, 0)
    pos = vlen + 2
    eid, n = read_varint(pkt, pos)
    if n == 0:
        return None
    pos += n
    _, n = read_varint(pkt, pos)
    if n == 0:
        return None
    flag, n = read_varint(pkt, pos + n)
    if n == 0:
        return None
    return Death(eid, flag)


def parse_hits(pkt: bytes) -> list[Hit]:
    """`04 38` then records `[01 00] <target> <switch> <flag> <actor> <skill u32> ...`. Only the first
    record's head is read: who hit whom is all the tracker needs, not the damage."""
    if opcode(pkt) != OP_DAMAGE:
        return []
    _, vlen = read_varint(pkt, 0)
    pos = vlen + 2
    if pkt[pos : pos + 2] == b"\x01\x00":
        pos += 2
    target, n = read_varint(pkt, pos)
    if not n:
        return []
    pos += n
    switch, n = read_varint(pkt, pos)
    if not n or (switch & 0x0F) not in (0, 2, 4, 5, 6, 7):
        return []
    pos += n
    _, n = read_varint(pkt, pos)
    if not n:
        return []
    pos += n
    actor, n = read_varint(pkt, pos)
    if not n or pos + n + 4 > len(pkt):
        return []
    pos += n
    skill = int.from_bytes(pkt[pos : pos + 4], "little")
    if not 1 <= skill <= 299_999_999 or 1_000_000 <= skill <= 9_999_999:
        return []  # 7-digit skills are NPC skills: a mob hitting someone
    return [Hit(target, actor, skill)]


def parse_party_scope(pkt: bytes) -> PartyScope | None:
    if opcode(pkt) != OP_PARTY_SCOPE:
        return None
    _, vlen = read_varint(pkt, 0)
    eid, n = read_varint(pkt, vlen + 2)
    return PartyScope(eid) if n else None


OP_SOUL = (0x0D, 0x90)  # sent only to you: a pet soul was gained
# Pet ids are 1001-1343 in every capture and the pet list (2026-10-30); room above for new pets. An
# id outside is not a pet: a tester's collection held 29 "pets" with ids like 4014180470 and souls to
# match, the bytes of some other record read as a collection.
PET_IDS = range(1000, 10_000)


def is_pet_id(pid: int) -> bool:
    return pid in PET_IDS


@dataclass(frozen=True)
class Soul:
    pet_id: int
    amount: int


def parse_souls(pkt: bytes) -> list[Soul]:
    """`0d 90 <count u8> (<pet id u32 LE> <amount u32 LE>) * count`. Identified 2026-10-09: ~0.3 s
    after the kill, 5/5 against marked Meadow Sparkie souls (pet 1006); party kills earn them too.
    Souls for two pets on the same tick come as one record of 2 (ursus_lv3.pcap, 2026-10-22: Burned
    Forester and Ashen Ursus, `0d 90 02 74 04 00 00 01 00 00 00 77 04 00 00 01 00 00 00`); reading
    only records of 1 lost both, which is how pets reached Lv3 in game a few souls early."""
    if opcode(pkt) != OP_SOUL:
        return []
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    if not b or not 0 < b[0] <= 64 or len(b) < 1 + 8 * b[0]:
        return []
    souls = []
    for i in range(b[0]):
        entry = b[1 + 8 * i : 9 + 8 * i]
        pid, amount = int.from_bytes(entry[:4], "little"), int.from_bytes(entry[4:8], "little")
        if not 0 < amount < 1000 or not is_pet_id(pid):
            return []
        souls.append(Soul(pid, amount))
    return souls


OP_CRYSTAL = (0x11, 0x90)  # sent only to you: genus crystals, from a monster whose pet is maxed

# The genus byte of `11 90`, as seen. Natura and Varian have not been captured yet.
CRYSTAL_GENUS = {1: "fera", 2: "cogni"}


@dataclass(frozen=True)
class Crystal:
    genus: int
    amount: int
    raw: bytes  # the whole body, while the last byte is not understood


def parse_crystal(pkt: bytes) -> Crystal | None:
    """`11 90 01 <genus u8> <amount u32 LE> 02`. Identified 2026-10-10: one ~0.3 s after each kill
    of a monster whose pet is at Lv3, never in the captures with souls. lv3_crystals.pcap: 6 Fera
    kills (Cairn Tog, Splendent Hill Sparkie), genus 01, 1 crystal each in game; lv3_cogni.pcap: 3
    Cogni kills (Wandering Manduri Fighter), genus 02. The message does not name the pet: the kill
    just before it does. The trailing 02 was the same in both."""
    if opcode(pkt) != OP_CRYSTAL:
        return None
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    if len(b) < 6 or b[0] != 0x01:
        return None
    amount = int.from_bytes(b[2:6], "little")
    if not 0 < amount < 1000:
        return None
    return Crystal(b[1], amount, bytes(b))


OP_COLLECTION = (0x00, 0x90)  # your whole pet collection, sent once when you enter the world
# The most souls a pet holds in the collection: Lv2 tops out at 74 (track.LEVEL_NEED), Lv3 holds 0.
MAX_COLLECTION_SOULS = 74
MAX_PET_LEVEL = 3


@dataclass(frozen=True)
class Collection:
    levels: dict[int, int]  # pet id -> Insight level
    souls: dict[int, int]  # pet id -> souls, as the Pets menu shows them
    extra: bytes  # what follows the two lists: undecoded (genus data?)


def parse_collection(pkt: bytes) -> Collection | None:
    """`00 90 <u32> <varint n> n×(<pet id u32> <pet id u32> <level u32>) <varint m> m×(<pet id u32>
    <souls u32>) ...`. Identified 2026-10-09 from a login: Meadow Sparkie 32 and Hungry Brax 65
    matched the Pets menu. Levels do not follow from the souls alone (pets also come whole from
    chests and shops), so both lists are kept. The souls list names pets the levels list does not
    (Lv0 pets with 1-4 souls: 27 in login1.pcap), so it is checked on its own: one entry that is
    not a pet id, a level or a souls count rejects the whole record (see PET_IDS)."""
    c = _read_collection(pkt)
    if c is None:
        return None
    if not all(is_pet_id(p) and 0 <= lv <= MAX_PET_LEVEL for p, lv in c.levels.items()):
        return None
    if not all(is_pet_id(p) and 0 <= s <= MAX_COLLECTION_SOULS for p, s in c.souls.items()):
        return None
    return c


def _read_collection(pkt: bytes) -> Collection | None:
    if opcode(pkt) != OP_COLLECTION:
        return None
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    pos = 4
    n, ln = read_varint(b, pos)
    if not ln or pos + ln + 12 * n > len(b):
        return None
    pos += ln
    levels = {}
    for _ in range(n):
        pid, pid2, level = (int.from_bytes(b[pos + k : pos + k + 4], "little") for k in (0, 4, 8))
        if pid != pid2:
            return None  # not the layout we know: better no sync than a wrong one
        levels[pid] = level
        pos += 12
    m, ln = read_varint(b, pos)
    if not ln or pos + ln + 8 * m > len(b):
        return None
    pos += ln
    souls = {}
    for _ in range(m):
        souls[int.from_bytes(b[pos : pos + 4], "little")] = int.from_bytes(b[pos + 4 : pos + 8], "little")
        pos += 8
    return Collection(levels, souls, b[pos:])


# --- where you are ----------------------------------------------------------------------------
#
# Positions are game coordinates; questlog.gg's map data (and the app) store y negated, so the
# sidecar reports (x, -y). Found 2026-10-09 in login and kill captures.

OP_MAP_LOAD = (0x21, 0x36)  # every zone load: the map id (= questlog.gg world id) and where you are
OP_TELEPORT = (0x23, 0x36)  # entity 0 = you, placed somewhere (zone entry, teleport)
OP_CASTS = ((0x02, 0x38), (0x03, 0x38))  # skill casts: the caster, then where its target stands


@dataclass(frozen=True)
class MapLoad:
    world: int
    x: float
    y: float


def _f32(b: bytes, at: int) -> float:
    return struct.unpack_from("<f", b, at)[0]


def _body(pkt: bytes) -> bytes:
    _, vlen = read_varint(pkt, 0)
    return pkt[vlen + 2 :]


def parse_map_load(pkt: bytes) -> MapLoad | None:
    """`21 36 <u32> <u32 map id> <8 bytes> <f32 x> <f32 y> <f32 z> ...`"""
    if opcode(pkt) != OP_MAP_LOAD:
        return None
    b = _body(pkt)
    if len(b) < 28:
        return None
    return MapLoad(int.from_bytes(b[4:8], "little"), _f32(b, 16), _f32(b, 20))


def parse_self_teleport(pkt: bytes) -> tuple[float, float] | None:
    """`23 36 00 <5 bytes> <f32 x> <f32 y> <f32 z>`: entity 0 is the local player."""
    if opcode(pkt) != OP_TELEPORT:
        return None
    b = _body(pkt)
    if len(b) < 18 or b[0] != 0:
        return None
    return _f32(b, 6), _f32(b, 10)


def parse_cast(pkt: bytes) -> tuple[int, float, float] | None:
    """`02 38` / `03 38 <caster varint> 00 <target varint> <skill u32> ... <f32 x> <f32 y>`: the
    caster, and where its **target** stands, not the caster (2026-10-17: all 566 of your casts in
    gartua.pcap gave Gartua's spawn point while your effects put you 1,300-2,000 away; of 986 `02 38`
    checked against others' movement, 938 matched the target). Close to you only for melee and
    gathering. Its offset moves with the varints, so the first plausible x, y, z after the
    skill is taken: game coordinates stay within +-500,000, values under 1,000 are the other fields
    of the record read as floats (a 0x42ED90C1 there reads as 118.7), and the height after them is
    under MAX_HEIGHT. That last check matters: some `03 38` carry a field reading 1,413.8 just
    before the position, which passed as an x and shifted the read by one (x 1414, y the real x, z
    the real y): about 1 cast position in 11 was wrong that way (6,006 of 67,950 in gartua,
    pvp_kills and gather_move), the real y as a height far too high.

    The height check only catches that where the real y is over 100,000 away from 0: elsewhere
    (2026-10-23: Altgard and Ellun, y within +-100,000) the shifted read passed and put you 120-130 km
    off, at x 1414. The field is a varint (`c1 b8 b0 44`, `87 ee c8 44`, `a1 b9 c3 48`: some read as
    1,413.8, 1,607.5, 400,845), so a `03 38` is read by its layout instead: `<target varint> <skill
    u32> <u8> <varint> <x y z>` (in all captures 23,915 of 26,771 read so, 4,277 of them misread by
    the scan; the rest are positions under 1,000, None as before)."""
    if opcode(pkt) not in OP_CASTS:
        return None
    b = _body(pkt)
    actor, n = read_varint(b, 0)
    if not n:
        return None
    if opcode(pkt) == (0x03, 0x38):
        _target, m = read_varint(b, n + 1)
        _field, k = read_varint(b, n + 1 + m + 5)
        off = n + 1 + m + 5 + k
        if not m or not k or off + 12 > len(b):
            return None
        x, y, z = _f32(b, off), _f32(b, off + 4), _f32(b, off + 8)
        if 1000 < abs(x) < 500_000 and 1000 < abs(y) < 500_000 and abs(z) < MAX_HEIGHT:
            return actor, x, y
        return None
    for off in range(n + 6, min(len(b) - 12, n + 24)):
        x, y, z = _f32(b, off), _f32(b, off + 4), _f32(b, off + 8)
        if 1000 < abs(x) < 500_000 and 1000 < abs(y) < 500_000 and abs(z) < MAX_HEIGHT:
            return actor, x, y
    return None


# Heights seen run 11,000 to 30,000; a coordinate read as a height is far above this.
MAX_HEIGHT = 100_000


# Effects (buffs, heals, damage over time and their ticks) on an entity, with where it stands.
OP_EFFECTS = ((0x2A, 0x38), (0x2B, 0x38))

# Epoch milliseconds, 2020 to 2128: how the timestamp in an effect record is found. Effects that do
# not run out (gliding's, travel_no_combat.pcap) carry 4,102,412,400,000, the end of 2099.
_MS_MIN, _MS_MAX = 1_580_000_000_000, 5_000_000_000_000


def parse_effect_position(pkt: bytes) -> tuple[int, float, float] | None:
    """`2a 38` / `2b 38 <source varint> ... <u64 ms> <target varint> <0-6 bytes> <x y z f32>`: an
    effect put on the target, and where the target stands, whoever the source is (you, a party
    member, a monster). The bytes after the target are `01 00`, `01 02` or `<varint> 00 02` mostly;
    the first plausible x, y, z within 8 bytes is taken. A field before the time can read as one
    (`f5 81 bb 00 e8 03 00 00` reads as the year 2106), so each window that does is tried in turn.

    Found 2026-10-17: in gartua.pcap all 112,742 effect records read this way, and against
    other entities' movement (`1a`-`1f 37`, under 0.3 s old) the median error was 0, the 90th
    percentile 311. The earlier reading only took `2a 38` with the target repeating the source
    (effects you put on yourself): about 1 record in 24."""
    if opcode(pkt) not in OP_EFFECTS:
        return None
    b = _body(pkt)
    for i in range(1, min(len(b) - 8, 40)):
        if not _MS_MIN < int.from_bytes(b[i : i + 8], "little") < _MS_MAX:
            continue
        target, n = read_varint(b, i + 8)
        if not n or not target:
            continue
        start = i + 8 + n
        for off in range(start, min(start + 9, len(b) - 11)):
            x, y, z = _f32(b, off), _f32(b, off + 4), _f32(b, off + 8)
            if 1000 < abs(x) < 500_000 and 1000 < abs(y) < 500_000 and abs(z) < MAX_HEIGHT:
                return target, x, y
    return None


def height_after(pkt: bytes, x: float, y: float) -> float | None:
    """The height that follows an x, y pair in a record (zone loads, teleports, casts and effects
    all carry `<x> <y> <z>` as f32s): read where those exact bytes are."""
    i = pkt.find(struct.pack("<2f", x, y))
    if i < 0 or i + 12 > len(pkt):
        return None
    z = struct.unpack_from("<f", pkt, i + 8)[0]
    return z if abs(z) < 1e6 else None


OP_SELF = (0x33, 0x36)  # you, on every zone entry: entity, name and server among much else


@dataclass(frozen=True)
class Character:
    name: str
    server: int
    entity: int | None = None  # your entity id in this zone (it changes between zones)
    guild: str | None = None  # your legion, None without one (or where it was not found)


def _guild(b: bytes, pos: int) -> str | None:
    """A length-prefixed legion name at `pos`: 1-32 bytes of printable UTF-8 (they can hold spaces)."""
    n = b[pos] if pos < len(b) else 0
    if not 1 <= n <= 32 or pos + 1 + n > len(b):
        return None
    try:
        guild = b[pos + 1 : pos + 1 + n].decode("utf-8")
    except UnicodeDecodeError:
        return None
    return guild if guild.isprintable() else None


def _name(b: bytes, pos: int) -> str | None:
    """A length-prefixed character name at `pos`: 1-32 bytes of UTF-8 letters and digits."""
    n = b[pos] if pos < len(b) else 0
    if not 1 <= n <= 32 or pos + 1 + n > len(b):
        return None
    try:
        name = b[pos + 1 : pos + 1 + n].decode("utf-8")
    except UnicodeDecodeError:
        return None
    return name if name.isalnum() else None


def is_server_id(server: int) -> bool:
    """A game server's id as the game writes them: faction 1-2, region 1-5, then 01-99 (Kaisinel
    1104, Zikel 2102; all 182 in app/src/shared/gameServers.ts). A tester's tunnel junk (2026-10-30)
    was read as a character "M4" on server 12595, the bytes `33 31`."""
    return 1 <= server // 1000 <= 2 and 1 <= server // 100 % 10 <= 5 and 1 <= server % 100 <= 99


def parse_character(pkt: bytes) -> Character | None:
    """Which character you are: `33 36 <entity varint> <5 bytes> <len u8> <name> <server u16 LE>
    ...` (~2.2 KB), once at every zone entry, logins included (right after the collection, `00 90`).
    Identified 2026-10-13 in login1, chat_login and zones1. Its name is the first length-prefixed
    one within a few bytes of the entity.

    Your legion comes some 250 bytes on, as `00 00 00 00 <server u16> <len><legion>` (Cro's
    "Eclipse" in all four logins, 2026-10-15): the first such run after the name.

    Not `39 8a <len> <name>`: it named you at login, but gartua.pcap has six of them naming other
    players around (online notices?), and 0.1.25 switched collections on them."""
    if opcode(pkt) != OP_SELF:
        return None
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    entity, pos = read_varint(b, 0)
    for p in range(pos, min(pos + 12, len(b))):
        if (name := _name(b, p)) is not None:
            end = p + 1 + len(name.encode())
            if end + 2 > len(b):
                return None
            server = int.from_bytes(b[end : end + 2], "little")
            if not is_server_id(server):
                return None
            marker, guild, k = b"\x00\x00\x00\x00" + b[end : end + 2], None, end + 2
            while guild is None and (k := b.find(marker, k + 1)) != -1:
                guild = _guild(b, k + 6)
            return Character(name, server, entity, guild)
    return None


OP_KILL = (0x04, 0x8D)  # kill credit (and summon/spirit links, which carry no name)
OP_PLAYER = (0x45, 0x36)  # a player in view


@dataclass(frozen=True)
class KillCredit:
    victim: int  # the entity killed
    killer: int  # the player credited (the killing blow)
    server: int  # the killer's game server
    name: str
    guild: str | None
    player_victim: bool  # the victim is a player, not a monster


def parse_kill_credit(pkt: bytes) -> KillCredit | None:
    """`04 8d <victim varint> <u32> <killer varint> <server u16> <len><name> <len><guild> ...
    <last byte>`: who was credited with a kill around you, yours and other players'. The last byte
    is 01 when the victim is a player (every PvP kill in pvp_kills.pcap, 2026-10-13), 00 for a
    monster (Gartua's credit in gartua.pcap). Only the killing blow is credited. The same opcode
    links summons to their owners with no name: those give None."""
    if opcode(pkt) != OP_KILL:
        return None
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    victim, n = read_varint(b, 0)
    if not n:
        return None
    pos = n + 4
    killer, n = read_varint(b, pos)
    if not n or pos + n + 3 > len(b):
        return None
    pos += n
    server = int.from_bytes(b[pos : pos + 2], "little")
    pos += 2
    name = _name(b, pos)
    if name is None or not 1000 <= server <= 9999:
        return None
    pos += 1 + len(name.encode())
    return KillCredit(victim, killer, server, name, _guild(b, pos), b[-1] == 1)


OP_LEGION = (0x33, 0x8A)  # a player's legion


@dataclass(frozen=True)
class Legion:
    entity: int
    id: int  # the legion's id on its server (Eclipse is 1)
    server: int
    name: str


def parse_legion(pkt: bytes) -> Legion | None:
    """`33 8a <entity varint> <legion id u48> <server u16> <len><name> ...`: the legion of a player
    around you, yours included, sent again every few seconds (2026-10-15: Cro's "Eclipse", id 1,
    in every capture, logins or not; other players' with other ids). The only way to your legion
    between zone entries."""
    if opcode(pkt) != OP_LEGION:
        return None
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    entity, n = read_varint(b, 0)
    if not n or n + 9 > len(b):
        return None
    server = int.from_bytes(b[n + 6 : n + 8], "little")
    name = _guild(b, n + 8)
    if name is None or not 1000 <= server <= 9999:
        return None
    return Legion(entity, int.from_bytes(b[n : n + 6], "little"), server, name)


@dataclass(frozen=True)
class Player:
    entity: int
    name: str
    server: int | None  # None where the record's layout is not the usual one
    faction: int | None  # 1 or 2: the two sides (Kaisinel was 1 in pvp_kills.pcap)
    guild: str | None = None  # their legion, right after the server (None without one)


def parse_player(pkt: bytes) -> Player | None:
    """`45 36 <entity varint> <4 bytes> 17 <len><name> <u32> <faction: 01 02 01 | 02 02 02> ...`:
    a player coming into view (pvp_kills.pcap, 2026-10-13: every player later named in a kill
    credit had one). The game server follows some 100-120 bytes on, as `<server u16> <2 bytes>
    00 00 00 00 <server u16> <len><guild>` (Meep 1104, xKanekii 2104, matching the kill credits);
    some records differ there (Tori's), and give no server."""
    if opcode(pkt) != OP_PLAYER:
        return None
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    entity, pos = read_varint(b, 0)
    if not pos:
        return None
    for p in range(pos, min(pos + 12, len(b))):
        if (name := _name(b, p)) is not None:
            end = p + 1 + len(name.encode())
            break
    else:
        return None
    side = b[end + 4 : end + 7]
    faction = 1 if side == b"\x01\x02\x01" else 2 if side == b"\x02\x02\x02" else None
    server = guild = None
    for k in range(end + 40, min(end + 200, len(b) - 10)):
        v = int.from_bytes(b[k : k + 2], "little")
        if 1000 <= v <= 9999 and b[k + 4 : k + 8] == b"\x00\x00\x00\x00" and int.from_bytes(b[k + 8 : k + 10], "little") == v:
            server, guild = v, _guild(b, k + 10)
            break
    return Player(entity, name, server, faction, guild)


OP_ITEM = (0x1B, 0x56)  # an inventory stack's new count; Kina is one of them
KINA_ITEM = bytes.fromhex("3f337037")


def parse_kina(pkt: bytes) -> int | None:
    """Your Kina balance, from the `1b 56` record of its stack:
    `1b 56 01 01 00 <u32> <u32> 3f 33 70 37 <balance u64 LE> ...` (44 bytes with the length).
    Identified 2026-10-13 in kills1, sparkie_long, lv3_crystals and lv3_cogni: one after each kill
    that dropped Kina, the balance only ever going up between them (+161 to +362 at Lv13 Cairn Togs).
    The same opcode carries other stacks (crystals, materials) with other item bytes."""
    if opcode(pkt) != OP_ITEM:
        return None
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    if len(b) < 23 or b[0] != 0x01 or b[11:15] != KINA_ITEM:
        return None
    return int.from_bytes(b[15:23], "little")


OP_FIELD_BOSSES = (0x01, 0x91)  # the map's field boss list for your zone, every ~3 s while the map is open


@dataclass(frozen=True)
class FieldBoss:
    id: int  # the list's own id: 101001-101024 in Verteron (zone 1010 * 100 + n)
    up: bool
    at_ms: int  # up: when it spawned (0: not given, since the 2026-10-14 patch); dead: when it respawns
    position: tuple[float, float, float] | None  # where it is, while up


@dataclass(frozen=True)
class FieldBosses:
    world: int
    bosses: list[FieldBoss]


def parse_field_bosses(pkt: bytes) -> FieldBosses | None:
    """`01 91 <u16> <world u32> <count u8>` then per boss: up `01 <id varint> <x y z f32> [1 byte]
    <spawned u64 ms>`, dead `00 <id varint> <respawns u64 ms>`. Identified 2026-10-13 (gartua.pcap,
    fieldboss_list.pcap): sent every ~3 s while the map is open, never with it closed. Eternal
    Gartua (101021) turned up 0.5 s after its spawn and dead 0.5 s after its death, its respawn
    then 12 h on; the dead bosses' times matched the in-game list to the second, and each up boss's
    position is its questlog.gg marker's (y negated). Some entries, up or dead, carry a byte more
    before the time (unknown), so the time is found where an ms timestamp fits."""
    if opcode(pkt) != OP_FIELD_BOSSES:
        return None
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    if len(b) < 7:
        return None
    world, n = int.from_bytes(b[2:6], "little"), b[6]
    pos, out = 7, []
    for _ in range(n):
        if pos >= len(b) or b[pos] not in (0, 1):
            return None
        up = b[pos] == 1
        bid, ln = read_varint(b, pos + 1)
        if not ln:
            return None
        pos += 1 + ln
        xyz = None
        if up:
            if pos + 12 > len(b):
                return None
            xyz = struct.unpack_from("<3f", b, pos)
            pos += 12
        # No time: 8 zero bytes, sometimes after the odd byte (ff or 00), taken where what follows
        # reads as the next boss (or the end). A boss on a schedule (Lower Reshanta's Kaira, Nahma,
        # Executors) is left out: the game counts those down itself. An up boss is up, its spawn
        # time unknown: since the 2026-10-14 patch the list gives up bosses none
        # (fieldboss_after_patch.pcap: all 18 up ones, the 6 dead ones still with their respawns).
        skip = next((k for k in (0, 1) if b[pos + k : pos + k + 8] == bytes(8)
                     and _boss_starts(b, pos + k + 8, world)), None)
        if skip is not None:
            pos += skip + 8
            if up:
                out.append(FieldBoss(bid, True, 0, xyz))
            continue
        # Then the time, sometimes after a byte or so more (unknown): where an ms timestamp fits.
        for k in range(5):
            if pos + k + 8 <= len(b) and _plausible_ms(b, pos + k):
                pos += k
                break
        else:
            return None
        out.append(FieldBoss(bid, up, int.from_bytes(b[pos : pos + 8], "little"), xyz))
        pos += 8
    return FieldBosses(world, out)


def _boss_starts(b: bytes, pos: int, world: int) -> bool:
    """The list's next boss starts at `pos` (a flag, then an id of this zone), or it ends there."""
    if pos >= len(b) - 3:
        return True
    if b[pos] not in (0, 1):
        return False
    bid, n = read_varint(b, pos + 1)
    return bool(n) and bid // 100 == world


def _plausible_ms(b: bytes, pos: int) -> bool:
    """A u64 at `pos` that reads as a time in ms since 1970, in this game's lifetime."""
    return 1_600_000_000_000 < int.from_bytes(b[pos : pos + 8], "little") < 2_200_000_000_000


OP_SHOP = (0x91, 0x56)  # the Black Cloud Merchant's stock for one tab, sent when the tab is opened
SHOP_RECORD = 34


@dataclass(frozen=True)
class ShopItem:
    slot: int  # the shop's own product id
    item: int  # the game's item id (questlog.gg's): "Pet: <name>" items grant a pet
    quantity: int
    currency: int
    base: int  # the price before the discount
    price: int


@dataclass(frozen=True)
class Shop:
    tab: int
    items: list[ShopItem]
    next_at_ms: int | None  # when the stock changes next (ms since epoch, UTC)


def _shop_record(b: bytes, o: int) -> ShopItem | None:
    if o + SHOP_RECORD > len(b):
        return None
    slot, item = struct.unpack_from("<II", b, o)
    quantity = struct.unpack_from("<Q", b, o + 8)[0]
    currency = b[o + 17]
    base, price = struct.unpack_from("<QQ", b, o + 18)
    if not (0 < slot < 1 << 24 and 100_000_000 <= item < 1 << 32 and 0 < quantity < 1_000_000
            and 0 < price <= base < 10**12):
        return None
    return ShopItem(slot, item, quantity, currency, base, price)


def parse_shop(pkt: bytes) -> Shop | None:
    """`91 56 <tab u8> <count u8>` then per item `<slot u32> <item u32> <quantity u64> <discount
    tier u8> <currency u8> <base price u64> <price u64>`, then `<next restock u64 ms>`. Found
    2026-10-12 (captures/shop_open.pcap): sent when a Black Cloud Merchant tab is opened, one per
    tab; the ten Pets-tab records matched the screen (items, discounts, both prices) and the
    trailing time was the next hour, when the stock changes. Some records start one byte later
    (an extra 0x55 or 0x05 before them, not decoded), so each is tried where expected and one byte
    on. The discount tier byte (00 = 10%, 01 = 20%, 03 = 50%) is not kept: the prices say it."""
    if opcode(pkt) != OP_SHOP:
        return None
    _, vlen = read_varint(pkt, 0)
    b = pkt[vlen + 2 :]
    if len(b) < 2:
        return None
    tab, count, o = b[0], b[1], 2
    items = []
    for _ in range(count):
        for start in (o, o + 1):
            if rec := _shop_record(b, start):
                items.append(rec)
                o = start + SHOP_RECORD
                break
        else:
            return None
    next_at = struct.unpack_from("<Q", b, o)[0] if o + 8 <= len(b) else None
    return Shop(tab, items, next_at if next_at and 1.5e12 < next_at < 4e12 else None)


# The times the game gives for its own schedules (docs/FINDINGS.md, "Resets and scheduled events
# the game sends", 2026-10-29). Every one is an absolute time (ms since 1970, UTC), on a whole
# minute: anything else is a misread (an opcode moved by a patch, say), and is dropped.
OP_NEXT_RESET = (0x23, 0xE2)  # the next daily reset, at login and on zone entry
OP_LIMITS = (0x8E, 0x56)  # limits (shop and weekly caps), each with its own next reset
OP_SIEGE = (0x07, 0xE3)  # the Artifact Siege, on entering the Abyss
OP_SIEGE_UPDATE = (0x05, 0xE3)  # the same times, sent again with an artifact's change
SIEGE_MARK = bytes.fromhex("e903000003")  # artifact 1001, then the siege's times


def _game_time(v: int) -> bool:
    return 1_600_000_000_000 < v < 2_200_000_000_000 and v % 60_000 == 0


def parse_next_reset(pkt: bytes) -> int | None:
    """`23 e2 <next daily reset u64 ms> <u32 0>`: 07:00 UTC in all 15 captures that have it
    (9-27 Oct 2026, NA East), the next one after the packet."""
    if opcode(pkt) != OP_NEXT_RESET:
        return None
    b = _body(pkt)
    if len(b) < 8:
        return None
    at = int.from_bytes(b[:8], "little")
    return at if _game_time(at) else None


@dataclass(frozen=True)
class Limit:
    id: int
    value: int
    reset_ms: int  # its next reset; 2100-01-01 for one that never resets


def parse_limits(pkt: bytes) -> list[Limit] | None:
    """`8e 56 00 00 <n u8>` then n × `<id u32> <value u32> <next reset u64 ms>`. Most reset at the
    weekly reset (Wednesday 07:00 UTC); 1262 on the 1st of the month; 1254 never (gartua,
    pvp_kills, shop_and_duties)."""
    if opcode(pkt) != OP_LIMITS:
        return None
    b = _body(pkt)
    if len(b) < 3 or len(b) < 3 + 16 * b[2]:
        return None
    out = []
    for i in range(b[2]):
        lid, value, at = struct.unpack_from("<IIQ", b, 3 + 16 * i)
        if not 1_600_000_000_000 < at < 5_000_000_000_000:
            return None
        out.append(Limit(lid, value, at))
    return out


def weekly_reset(limits: list[Limit], now_ms: float) -> int | None:
    """The weekly reset, from the limits: the reset most of them share within the next 8 days."""
    soon = [lim.reset_ms for lim in limits
            if now_ms < lim.reset_ms <= now_ms + 8 * 86_400_000 and _game_time(lim.reset_ms)]
    if not soon:
        return None
    at, n = max(((t, soon.count(t)) for t in set(soon)), key=lambda x: (x[1], -x[0]))
    return at if n * 2 > len(soon) else None


@dataclass(frozen=True)
class Siege:
    last_end_ms: int  # when the last siege ended (its 40 minutes, or earlier when won)
    next_ms: int  # when the next one starts


def parse_siege(pkt: bytes) -> Siege | None:
    """`07 e3` (on entering the Abyss) and `05 e3` (an update): `… e9 03 00 00 03 <u8> <last end
    u64 ms> <next start u64 ms>` then the artifacts. Read 2026-10-14: last end Tue 01:40 UTC
    (Monday's 21:00 New York siege), next Fri 01:00 UTC (Thursday 21:00 New York)."""
    if opcode(pkt) not in (OP_SIEGE, OP_SIEGE_UPDATE):
        return None
    b = _body(pkt)
    i = b.find(SIEGE_MARK)
    if i < 0 or i + len(SIEGE_MARK) + 17 > len(b):
        return None
    last, nxt = struct.unpack_from("<QQ", b, i + len(SIEGE_MARK) + 1)
    if not (1_600_000_000_000 < last < nxt and _game_time(nxt)):
        return None
    return Siege(last, nxt)
