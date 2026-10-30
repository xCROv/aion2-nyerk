"""Task List, the tracker half: what the game says about your limits, for the Tasks tab to tick
itself (docs/FINDINGS.md "Content tickets", "Completions", "Arena results").

- **Tickets** (`0b 61` every one at login and zone entry, `0c 61` one changing): the game's own
  counts of each limit, Nightmare attempts, keys, entries, Odyle Energy, the hours left.
- **Season Missions and pass missions** (`83 56` every achievement counter at zone entry, `84 56`
  one changing): only the weekly ones are kept (23x2xxxxx Season Missions, 9104xxxxx Daeva Pass and
  event pass missions); the lifetime achievements stop at their last goal, so tell little.
- **PvP season records** (`2a e3` at zone entry): each mode's rating, wins, losses and streak.
  The arena itself is another server, which the tracker does not follow, so a match shows here on
  the way back.
- **Completions** (`01 61`): an instance over (its event id: Nightmare 200003, an arena map 7 or 8,
  the Dimensional Invasion 500031).
- **The duty board** (`1c 8d` at zone entry and on each change): refreshes used today, duties
  turned in today, and the day's duties with their state (2 taken, 4 turned in; one given up
  leaves it). The game's "Daily Completions n/5" is the duties on it in state 2 to 4.
- **Paid benefits** (`3b e3` at zone entry): each with its start and end; the membership (per
  server) is ids 1058–1066, so the Tasks tab knows it without the toggle.
- **Shop purchase counts** (`01 8c` when a shop opens, `03 8c` on a purchase): what was bought of
  each item this period, for the Command shops' weekly limits. Only seen when a shop is used.

A zone entry sends the lists before the character record (`33 36`), so they wait for it: after a
relog onto another character they belong to the new one. Changes in between belong to whoever is
logged in. Emits "game" (every character seen this run, and who is logged in) within half a
second of a change.
"""

from __future__ import annotations

import struct
import time

from aion2_tracker import protocol as P

OP_TICKETS = (0x0B, 0x61)
OP_TICKET = (0x0C, 0x61)
OP_ACHIEVEMENTS = (0x83, 0x56)
OP_ACHIEVEMENT = (0x84, 0x56)
OP_PVP = (0x2A, 0xE3)
OP_COMPLETED = (0x01, 0x61)
OP_DUTY_BOARD = (0x1C, 0x8D)
OP_SHOP_BOUGHT = (0x01, 0x8C)  # a shop opened: each item's bought count
OP_SHOP_BUY = (0x03, 0x8C)  # a purchase: the items' new bought counts
OP_BENEFITS = (0x3B, 0xE3)  # the server's paid benefits (membership), at zone entry
EMIT_EVERY_S = 0.5
# A zone entry's lists wait this long for the character record before going to whoever is logged in.
PENDING_S = 20.0
# Completions kept per character (the tab counts them; it keeps its own).
KEEP_COMPLETIONS = 50


def weekly(key: int) -> bool:
    """Season Missions (23x2xxxxx: 230210900 Hometown of My Heart ...) and the passes' missions (9104xxxxx)."""
    return (230_000_000 <= key < 240_000_000 and (key // 100_000) % 10 == 2) or 910_400_000 <= key < 910_500_000


def ticket(b: bytes, pos: int) -> tuple[int, dict, int] | None:
    """`<kind u8> <id u32> <values>`: the kind's bits say what follows, in order: 0x01 a u64,
    0x02 a u64 (times, ms), 0x04 a varint, 0x08 a varint (counts). Returns (id, values, next).
    A value left out is 0, and keeps its place: Odyle Energy at 0 basic and 1,395 charged comes as
    0x08 alone, which is [0, 1395], not [1395]."""
    if pos + 5 > len(b) or b[pos] & 0xF0:
        return None
    kind = b[pos]
    tid = struct.unpack_from("<I", b, pos + 1)[0]
    pos += 5
    ms: list[int] = []
    n: list[int] = []
    for i, bit in enumerate((0x01, 0x02)):
        if kind & bit:
            if pos + 8 > len(b):
                return None
            ms += [0] * (i - len(ms)) + [struct.unpack_from("<Q", b, pos)[0]]
            pos += 8
    for i, bit in enumerate((0x04, 0x08)):
        if kind & bit:
            v, ln = P.read_varint(b, pos)
            if not ln:
                return None
            n += [0] * (i - len(n)) + [v]
            pos += ln
    values: dict = {}
    if ms:
        values["ms"] = ms
    if n or not ms:
        values["n"] = n or [0]
    return tid, values, pos


def parse_tickets(b: bytes) -> dict[int, dict] | None:
    count, pos = P.read_varint(b, 0)
    if not pos:
        return None
    out: dict[int, dict] = {}
    for _ in range(count):
        t = ticket(b, pos)
        if t is None:
            return out or None
        tid, values, pos = t
        out[tid] = values
    return out


def parse_achievements(b: bytes) -> dict[int, list[int]] | None:
    """`<count varint>` then 17-byte records `<key u32> <value u32> <changed u64 ms> <tiers u8>`."""
    count, pos = P.read_varint(b, 0)
    if not pos or pos + 17 * count > len(b):
        return None
    out: dict[int, list[int]] = {}
    for _ in range(count):
        key, value, _changed = struct.unpack_from("<IIq", b, pos)
        tiers = b[pos + 16]
        pos += 17
        if weekly(key):
            out[key] = [value, tiers]
    return out


def parse_pvp(b: bytes) -> dict[int, dict] | None:
    """`<count u8>` then per mode 14 bytes: `<mode u8> <rating u32> <4 zero> <wins u8> <losses u8>
    <2 zero> <streak u8>` (modes: 1 Arena of Solitude, 2 Arena of Cooperation, 3 Battlefield)."""
    if not b:
        return None
    count = b[0]
    if 1 + 14 * count > len(b):
        return None
    out: dict[int, dict] = {}
    for i in range(count):
        r = b[1 + 14 * i : 15 + 14 * i]
        out[r[0]] = {"rating": struct.unpack_from("<I", r, 1)[0], "wins": r[9], "losses": r[10], "streak": r[13]}
    return out


def parse_benefits(b: bytes) -> dict[int, list[int]] | None:
    """`<count u8>` then 21-byte records `<id u32> <u8> <start u64 ms> <end u64 ms>`: each paid
    benefit running on the server (the membership is 1058–1066, 30 days from the purchase)."""
    if not b or 1 + 21 * b[0] > len(b):
        return None
    out: dict[int, list[int]] = {}
    for i in range(b[0]):
        bid, _flag, start, end = struct.unpack_from("<IBQQ", b, 1 + 21 * i)
        out[bid] = [start, end]
    return out


def parse_duty_board(b: bytes) -> dict | None:
    """`<refreshes used u32> <turned in u32> <n u8> …` then each duty: `<quest id u32> <4 zero bytes>
    <state u8> …` (rewards follow, so records vary in length; found by their quest ids, under 1000)."""
    if len(b) < 9:
        return None
    refreshes, done = struct.unpack_from("<II", b, 0)
    quests: dict[str, int] = {}
    for i in range(9, len(b) - 9):
        q = struct.unpack_from("<I", b, i)[0]
        if 1 <= q < 1000 and b[i + 4 : i + 8] == bytes(4) and b[i + 8] in (2, 3, 4) and b[i - 4 : i] != bytes(4):
            quests.setdefault(str(q), b[i + 8])
    return {"refreshes": refreshes, "done": done, "quests": quests}


def parse_shop(b: bytes, buy: bool) -> tuple[int, dict[str, int]] | None:
    """`01 8c 00 00 <shop varint> <n u8> n × (<item u32> <bought u32>) <u64 ms>` when a shop opens;
    `03 8c 00 06 <shop u32> <n u8> n × (<item u32> <bought u32>)` on a purchase."""
    if buy:
        if len(b) < 7:
            return None
        shop, pos = struct.unpack_from("<I", b, 2)[0], 6
    else:
        shop, ln = P.read_varint(b, 2)
        if not ln:
            return None
        pos = 2 + ln
    if pos >= len(b):
        return None
    n = b[pos]
    pos += 1
    if pos + 8 * n > len(b):
        return None
    items = {}
    for _ in range(n):
        item, count = struct.unpack_from("<II", b, pos)
        items[str(item)] = count
        pos += 8
    return shop, items


class Game:
    """Each character's tickets, weekly missions and PvP records, as the game last said."""

    def __init__(self) -> None:
        self.chars: dict[str, dict] = {}
        self.current: str | None = None
        self.pending: dict = {}  # a zone entry's lists, waiting for the character record
        self.pending_at = 0.0
        self.dirty = False

    def _char(self, key: str) -> dict:
        return self.chars.setdefault(key, {"tickets": {}, "missions": {}, "pvp": {}, "completions": [], "shops": {}})

    def _target(self) -> dict | None:
        """Where a change goes: the zone entry being read, else whoever is logged in."""
        if self.pending:
            return self.pending
        return self._char(self.current) if self.current else None

    def _settle(self, now: float) -> None:
        """A zone entry's lists with no character record after them: whoever is logged in."""
        if self.pending and self.current and now - self.pending_at > PENDING_S:
            self._merge(self.current, now)

    def _merge(self, key: str, now: float) -> None:
        c = self._char(key)
        for part in ("tickets", "missions", "pvp", "duties", "benefits"):
            if part + "At" in self.pending:
                c[part] = self.pending[part]
                c[part + "At"] = self.pending[part + "At"]
            elif part in self.pending:
                # Changes with no list before them (Nyerk started mid-session): over what is kept.
                c.setdefault(part, {}).update(self.pending[part])
        c.setdefault("shops", {}).update(self.pending.get("shops", {}))
        c["completions"].extend(self.pending.get("completions", []))
        del c["completions"][:-KEEP_COMPLETIONS]
        self.pending = {}
        self.dirty = True

    def packet(self, ts: float, pkt: bytes) -> None:
        op = P.opcode(pkt)
        if op is None:
            return
        now = time.time() * 1000
        if op == P.OP_SELF:
            who = P.parse_character(pkt)
            if who is not None:
                self.current = f"{who.server}:{who.name}"
                c = self._char(self.current)
                c["name"], c["server"] = who.name, who.server
                if self.pending:
                    self._merge(self.current, now)
                self.dirty = True
            return
        b = P._body(pkt)
        if op == OP_TICKETS:
            if (t := parse_tickets(b)) is not None:
                self._start_pending(now)["tickets"] = {str(k): {**v, "at": now} for k, v in t.items()}
                self.pending["ticketsAt"] = now
        elif op == OP_ACHIEVEMENTS:
            if (a := parse_achievements(b)) is not None:
                self._start_pending(now)["missions"] = {str(k): v for k, v in a.items()}
                self.pending["missionsAt"] = now
        elif op == OP_PVP:
            if (r := parse_pvp(b)) is not None:
                self._start_pending(now)["pvp"] = {str(k): v for k, v in r.items()}
                self.pending["pvpAt"] = now
        elif op == OP_BENEFITS:
            if (r := parse_benefits(b)) is not None:
                self._start_pending(now)["benefits"] = {str(k): v for k, v in r.items()}
                self.pending["benefitsAt"] = now
        elif op == OP_DUTY_BOARD:
            # At a zone entry it waits with the other lists; later, a change to whoever is logged in.
            if (d := parse_duty_board(b)) is not None:
                target = self._start_pending(now) if self.pending or self.current is None else self._char(self.current)
                target["duties"] = d
                target["dutiesAt"] = now
                self.dirty = True
        elif op in (OP_SHOP_BOUGHT, OP_SHOP_BUY):
            target = self._target()
            if (r := parse_shop(b, op == OP_SHOP_BUY)) is not None and target is not None:
                shop, items = r
                kept = target.setdefault("shops", {}).setdefault(str(shop), {})
                if op == OP_SHOP_BOUGHT:
                    kept.clear()  # the shop's whole list: an item not on it has none bought
                for item, count in items.items():
                    kept[item] = count
                kept["at"] = now
                self.dirty = True
        elif op == OP_TICKET:
            # `00 <one ticket record> <u8>` (the last byte 3 when one was spent, 2 at a refill).
            t = ticket(b, 1)
            target = self._target()
            if t is not None and target is not None:
                # Each ticket keeps when it was read: a change after a reset is current, though the
                # last full list was read before it.
                target.setdefault("tickets", {})[str(t[0])] = {**t[1], "at": now}
                self.dirty = True
        elif op == OP_ACHIEVEMENT:
            # `01 <key u32> <value u32> <changed u64> <tiers u8>`.
            if len(b) >= 18:
                key, value, _changed = struct.unpack_from("<IIq", b, 1)
                target = self._target()
                if weekly(key) and target is not None:
                    target.setdefault("missions", {})[str(key)] = [value, b[17]]
                    # A mission counting after the weekly reset: the list is this week's.
                    target["missionsAt"] = now
                    self.dirty = True
        elif op == OP_COMPLETED:
            # `<u8> <event id u32> 01 ...`: an instance (Nightmare, an arena map, an invasion) is over.
            if len(b) >= 6:
                event = struct.unpack_from("<I", b, 1)[0]
                target = self._target()
                if target is not None:
                    target.setdefault("completions", []).append([event, now])
                    self.dirty = True

    def _start_pending(self, now: float) -> dict:
        if not self.pending:
            self.pending_at = now / 1000
        return self.pending

    def state(self) -> dict:
        return {"chars": self.chars, "current": self.current}


def setup(api):
    game = Game()
    last = [0.0]

    @api.on_packet
    def packet(ts, pkt):
        game.packet(ts, pkt)

    @api.every(EMIT_EVERY_S)
    def tick():
        now = time.time()
        game._settle(now)
        if game.dirty and now - last[0] >= EMIT_EVERY_S:
            game.dirty = False
            last[0] = now
            api.emit("game", game.state())
