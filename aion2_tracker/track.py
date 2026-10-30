"""Live pet-soul tracker.

    python -m aion2_tracker.track                 watch the game and count souls (Ctrl+C to stop)
    python -m aion2_tracker.track --replay X.pcap count the souls in a saved capture
    python -m aion2_tracker.track set 1006 18     set a pet's count to what the Pets menu shows
    python -m aion2_tracker.track show            print the saved collection
    python -m aion2_tracker.track sync X.pcap     take every pet's count from a capture of a login

A soul is the `0d 90` record (pet id + amount), which the server sends only to you. The record does
not name the monster, so each pet's name is learned from the kills just before its souls arrive,
by majority vote, and settles after a few souls.
"""

from __future__ import annotations

import argparse
import collections
import copy
import json
import math
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from . import capture, protocol as P
from .analyze import NPCS_DEFAULT, load_dropper_worlds, load_droppers, load_genera, loot_owner_records

STORE = Path(__file__).resolve().parents[1] / "collection.json"
# Souls to go from Lv0 to 1, 1 to 2 and 2 to 3. The count the Pets menu shows restarts at 0 on each
# level-up, and a pet at MAX_LEVEL collects genus crystals instead of souls (the user, and the login
# collection: Lv0 pets hold 1-4 souls, Lv1 0-24, Lv2 0-74, Lv3 always 0).
LEVEL_NEED = (5, 25, 75)
MAX_LEVEL = 3
NAME_WINDOW_S = 1.5
# A pet that got a soul this recently is not at Lv3 in game: a crystal does not correct it...
SOUL_PROOF_S = 600.0
# ...unless this many crystals in a row, with no soul for it between, are its monsters' alone: a
# pet reaching Lv3 gets its last soul seconds before its first crystal (2026-10-22: Black Ash
# Basilisk, saved at 72/75 with 3 souls missed, its kills then gave ~47 crystals to no one).
CRYSTAL_RUN = 3
# A "combat" event at most this often: the overlay only needs to know fighting is going on.
COMBAT_EVERY_S = 5.0
# How soon after a login sync the record naming the character comes (same frame bundle in the
# captures): a switch of character within this moves the sync to the new one.
SYNC_SWITCH_S = 30.0
# Your casts carry their target's position, not yours: within this of where an effect last put
# you, a cast says nothing new (ranged skills reached 2,000 from you in gartua.pcap); farther, you
# have moved since and the target is the best guess.
CAST_RANGE = 2500.0
# Faster than this between two positions under MAX_JUMP_S apart is a misread, not you (yours
# reached 5,400/s, mounted or dashing, in pvp_kills.pcap).
MAX_SPEED = 10_000.0
MAX_JUMP_S = 2.0
# Farther than this from your last position, with nothing between for MAX_JUMP_S or more, is believed
# only once a second record puts you near it: in arenas and dungeons a lone effect or cast put you
# 24-250 km off (arena_win, arena_win2, nightmare_run.pcap), the next record back where you were.
CONFIRM_JUMP = 20_000.0
# A monster in view is named by some record (its movement, the `1d 37` that comes while it stands,
# hits) every few seconds: the median monster's longest silence 1-3 s, the 99th percentile 32 s, the
# longest 57 s, over ~1,800 monsters in seven captures (2026-10-22). Silent this long, it is taken
# to have left without its `42 36` reaching us (a segment the capture lost: about 20 a session in
# tracker.log) and goes out of Nearby. Short, so a stale one goes quickly; one taken out wrongly
# comes back with the next record naming it.
GONE_SILENT_S = 15.0


def load(path: Path = STORE) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"pets": {}}
    drop_non_pets(data)
    return data


def drop_non_pets(data: dict) -> int:
    """Take out entries whose id is not a pet's (P.PET_IDS), from the collection and each saved
    character's, and characters whose server is not one: what misread records left before these
    were checked. How many went."""
    dropped = 0
    for pets in [data.get("pets", {})] + [c.get("pets", {}) for c in data.get("characters", {}).values()]:
        for pid in [k for k in pets if not (k.isdigit() and P.is_pet_id(int(k)))]:
            del pets[pid]
            dropped += 1
    if dropped:
        print(f"collection: dropped {dropped} entries that are not pets (misread ids)", file=sys.stderr)
    # And characters on a server that is not one (misread, as "M4" on 12595): their pets are votes
    # copied from the real ones', which those still have.
    chars = data.get("characters", {})
    for name in [n for n, c in chars.items()
                 if n != data.get("current") and c.get("server") is not None and not P.is_server_id(c["server"])]:
        print(f"collection: dropped character {name} (server {chars.pop(name)['server']}, not one)", file=sys.stderr)
        dropped += 1
    return dropped


def save(data: dict, path: Path = STORE) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def pet_name(pet: dict) -> str:
    votes = pet.get("votes", {})
    return max(votes, key=votes.get) if votes else "(unknown monster)"


def progress(pet: dict) -> str:
    level = pet.get("level") or 0
    est = " (est.)" if pet.get("level") is None or pet.get("levelEstimated") else ""
    if level >= MAX_LEVEL:
        return f"  Lv{level} max, {pet.get('crystals', 0)} crystals{est}"
    return f"{pet['souls']:>3}/{LEVEL_NEED[level]} souls  Lv{level}{est}"


def level_up(pet: dict) -> bool:
    """Apply the level rules to a pet's souls: past a threshold the pet levels up and the count
    restarts. True if it levelled. A pet whose level was never sent by the server starts at 0."""
    level = pet.get("level")
    if level is None:
        level = 0
        pet["levelEstimated"] = True
    levelled = False
    while level < MAX_LEVEL and pet["souls"] >= LEVEL_NEED[level]:
        pet["souls"] -= LEVEL_NEED[level]
        level += 1
        levelled = True
    pet["level"] = level
    return levelled


def pet_view(pid: str | int, pet: dict, session: int = 0) -> dict:
    """One pet as the overlay sees it."""
    votes = pet.get("votes", {})
    level = pet.get("level")
    return {
        "id": int(pid),
        "name": max(votes, key=votes.get) if votes else None,
        "souls": pet["souls"],
        "level": level if level is not None else 0,
        "levelEstimated": level is None or bool(pet.get("levelEstimated")),
        "crystals": pet.get("crystals", 0),
        "session": session,
    }


def print_event(ev: dict) -> None:
    """The console's view of the tracker's events."""
    stamp = time.strftime("%H:%M:%S", time.localtime(ev.get("ts", time.time())))
    if ev["type"] == "sync":
        print(f"{stamp}  synced {ev['pets']} pets from the server ({ev['souls']} souls in all)")
        for c in ev["corrected"]:
            print(f"          corrected {c['name'] or '(unknown monster)'} (pet {c['id']}) {c['before']} -> {c['after']}")
    elif ev["type"] == "soul":
        pet = ev["pet"]
        lv = f"Lv{pet['level']}" + (" (est.)" if pet["levelEstimated"] else "")
        print(f"{stamp}  +{ev['amount']} soul  {pet['name'] or '(unknown monster)':30} pet {pet['id']:<6} "
              f"{pet['souls']:>3} souls  {lv}   (this session: {pet['session']})")
    elif ev["type"] == "crystal":
        pet = ev["pet"]
        who = f"{pet['name'] or '(unknown monster)':30} pet {pet['id']:<6} {pet['crystals']:>3} crystals" if pet else             f"(monster {ev['npc'] or 'unknown'})"
        print(f"{stamp}  +{ev['amount']} {ev['genus'] or '?'} crystal  {who}   [{ev['raw']}]")


class Tracker:
    def __init__(self, data: dict, npcs: dict, persist: bool = True,
                 on_event: Callable[[dict], None] = print_event, store: Path = STORE,
                 droppers: dict[int, int] | None = None, genera: dict[int, str] | None = None,
                 dropper_worlds: dict[int, tuple[int, ...]] | None = None):
        self.data, self.npcs, self.persist, self.on_event, self.store = data, npcs, persist, on_event, store
        # Monster code -> the pet it drops: how a crystal, which names no pet, finds one.
        self.droppers = load_droppers() if droppers is None else droppers
        # Pet -> genus: a crystal's genus must match its pet's.
        self.genera = load_genera() if genera is None else genera
        # Soul monster code -> the zones it spawns in: your zone before a zone load is seen.
        self.dropper_worlds = load_dropper_worlds() if dropper_worlds is None else dropper_worlds
        self.mob_code: dict[int, int | None] = {}
        self.recent: collections.deque = collections.deque(maxlen=64)  # (ts, mob entity)
        # Each character's session counts; `session` is the one playing.
        self.sessions: dict[str | None, collections.Counter] = {}
        self.session: collections.Counter = self.sessions.setdefault(self.data.get("current"), collections.Counter())
        # The capture thread and the overlay's edits both change `data`.
        self.lock = threading.RLock()
        # Around you: the monsters loaded in your view (entity -> mob code), your zone and your
        # position (x, -y: questlog.gg's convention, as the app's map data uses).
        self.visible: dict[int, int] = {}
        self.heard: dict[int, float] = {}  # entity in view -> when a record last named it
        self.swept = float("-inf")
        self.silenced: dict[int, int] = {}  # entity taken out for its silence -> its mob code
        self.world: int | None = None
        # The zone came from before an app update restart, not from a zone load: the field boss
        # list or the soul monsters around you naming another zone replace it (a zone change the
        # old version missed, or made while the app was closed, would otherwise stay until the next).
        self.world_restored = False
        self.position: tuple[float, float] | None = None
        self.height: float | None = None  # your z, with the position where the record gives it
        # When the position last moved, and whether it is yours (zone load, teleport, an effect on
        # you) or a cast target's near you.
        self.position_ts = float("-inf")
        self.position_exact = False
        self.far_seen: tuple[float, float] | None = None  # a far position waiting for a second record
        self.nearby_dirty = False
        # Collections saved before the level rules can hold a pet past its threshold (97 souls at
        # Lv1): level those up now, as the game already has.
        for pid, pet in self.data["pets"].items():
            if pet.get("level") is not None and level_up(pet):
                print(f"level: pet {pid} was past its threshold, now Lv{pet['level']} with {pet['souls']}", file=sys.stderr)
        # Which entity is you: the player credited with the kills just before your souls.
        self.credits: collections.deque = collections.deque(maxlen=32)  # (ts, mob, player entity)
        # When each pet last got a soul: proof it is below Lv3.
        self.last_soul: dict[int, float] = {}
        # The crystals since each pet's last soul that only its monsters' kills explain, and how
        # many they gave: a run of them puts it at Lv3 (CRYSTAL_RUN).
        self.crystal_run: dict[int, tuple[int, int]] = {}
        self.last_combat = float("-inf")
        # The collection as it was before the last login sync, and that sync: the sync comes just
        # before the record that says who you are, so a switch of character moves it across.
        self.before_sync: tuple[float, dict, P.Collection] | None = None
        # The map's field boss list, as last passed on: it comes every 3 s, unchanged mostly.
        self.field_bosses: tuple | None = None
        # The times the game gave for its schedules, as last passed on (timer id -> ms).
        self.game_times: dict[str, int] = {}
        # The kill feed: the players in view (entity -> Player), your own entity in this zone (from
        # your zone entry record), and the player kills passed on lately (each is sent once).
        self.players: dict[int, P.Player] = {}
        self.self_entity: int | None = None
        self.pvp_seen: dict[tuple[int, int], float] = {}
        self.self_votes: collections.Counter = collections.Counter()
        self.legions: dict[int, str] = {}  # entity -> legion name, for the players around you
        # Addons' Python parts (addons.py), set by the helper; told of each packet and zone.
        self.addons = None
        self._zoned = False

    def on_packet(self, ts: float, pkt: bytes) -> None:
        # Under the lock: the app's helper reads `visible` from another thread.
        with self.lock:
            self._on_packet(ts, pkt)
            if self.addons is not None:
                if self._zoned:
                    self._zoned = False
                    self.addons.zone(self.world)
                self.addons.packet(ts, pkt)

    def _on_packet(self, ts: float, pkt: bytes) -> None:
        self._hear(ts, pkt)
        if s := P.parse_spawn(pkt):
            self.mob_code[s.entity_id] = s.mob_code
            if s.mob_code:
                self.visible[s.entity_id] = s.mob_code
                self.heard[s.entity_id] = ts
                self.silenced.pop(s.entity_id, None)
                self.nearby_dirty = True
        for mob, owner, _name in loot_owner_records(pkt):
            if mob in self.mob_code:
                self.recent.append((ts, mob))
                self.credits.append((ts, mob, owner))
            # Your kills (anyone's until it is known which player you are): fighting is going on.
            me = self.self_id()
            if (me is None or owner == me) and ts - self.last_combat >= COMBAT_EVERY_S:
                self.last_combat = ts
                self.on_event({"type": "combat", "ts": ts})
        if d := P.parse_death(pkt):
            # Any 42 36 takes a monster out of view: 1 = out of range, 3 = killed, 7 = gone.
            self.silenced.pop(d.entity_id, None)
            if self.visible.pop(d.entity_id, None) is not None:
                self.heard.pop(d.entity_id, None)
                self.nearby_dirty = True
            if d.flag == P.DEATH_FLAG_COMBAT and d.entity_id in self.mob_code:
                self.recent.append((ts, d.entity_id))
        if m := P.parse_map_load(pkt):
            # A new zone: nothing from the last one is around you any more.
            self.world = m.world
            self.world_restored = False
            self._move(ts, pkt, m.x, m.y, exact=True)
            self.visible.clear()
            self.heard.clear()
            self.silenced.clear()
            self.players.clear()
            self.legions.clear()
            self.nearby_dirty = True
            self._zoned = True
        elif t := P.parse_self_teleport(pkt):
            self._move(ts, pkt, t[0], t[1], exact=True)
        elif (e := P.parse_effect_position(pkt)) and self._is_me(e[0]):
            # Effects on you, whoever put them there: where you are, between zone loads.
            if not self._jump(ts, e[1], e[2]):
                self._move(ts, pkt, e[1], e[2], exact=True)
        elif (c := P.parse_cast(pkt)) and self._is_me(c[0]):
            # Your casts (gathering is one) give where their target is: only a guess at yours.
            near = self.position is not None and math.dist(self.position, (c[1], -c[2])) <= CAST_RANGE
            if not (self.position_exact and near) and not self._jump(ts, c[1], c[2]):
                self._move(ts, pkt, c[1], c[2], exact=False)
        if (who := P.parse_character(pkt)) is not None:
            self.self_entity = who.entity
            self._character(ts, who)
        if (player := P.parse_player(pkt)) is not None:
            self.players[player.entity] = player
        if (legion := P.parse_legion(pkt)) is not None:
            self.legions[legion.entity] = legion.name
            me = self.self_entity if self.self_entity is not None else self.self_id()
            if legion.entity == me:
                self._my_legion(legion.name)
        if (credit := P.parse_kill_credit(pkt)) is not None:
            me = self.character()
            if self.self_entity is None and me and credit.name == me["name"] and me["server"] in (None, credit.server):
                # Started mid-game (no zone entry yet): a kill credited to you, monsters' too, says who you are.
                self.self_entity = credit.killer
                if credit.killer in self.legions:
                    self._my_legion(self.legions[credit.killer])
            if credit.player_victim:
                self._pvp_kill(ts, credit)
        if souls := P.parse_souls(pkt):
            for soul in souls:
                # Two pets' souls in one record: the kill just before cannot say which is whose.
                self._soul(ts, soul, vote=len(souls) == 1)
        elif crystal := P.parse_crystal(pkt):
            self._crystal(ts, crystal)
        elif P.opcode(pkt) in (P.OP_SOUL, P.OP_CRYSTAL):
            # One not read is a soul or crystal lost: the raw record, to learn its layout from.
            print(f"unread {P.opcode(pkt)[0]:02x} {P.opcode(pkt)[1]:02x} record: {pkt.hex(' ')}", file=sys.stderr)
        elif (kina := P.parse_kina(pkt)) is not None:
            # The balance as is: the app works out what was earned (and per hour) from the changes.
            self.on_event({"type": "kina", "ts": ts, "balance": kina})
        elif bosses := P.parse_field_bosses(pkt):
            if self.world_restored and bosses.world != self.world:
                self._unrestore(bosses.world)
            key = (bosses.world, tuple((b.id, b.up, b.at_ms) for b in bosses.bosses))
            if key != self.field_bosses:
                self.field_bosses = key
                self.on_event({"type": "fieldBosses", "ts": ts, "world": bosses.world,
                               "bosses": [{"id": b.id, "up": b.up, "at": b.at_ms} for b in bosses.bosses]})
        elif shop := P.parse_shop(pkt):
            # The Black Cloud Merchant's stock, as the tab just opened shows it: passed on as is
            # (the app knows which items are pets, and which pets are worth buying).
            self.on_event({"type": "shop", "ts": ts, "tab": shop.tab, "nextAt": shop.next_at_ms,
                           "items": [vars(i) for i in shop.items]})
        elif (reset := P.parse_next_reset(pkt)) is not None:
            self._game_time(ts, "dailyReset", reset)
        elif (limits := P.parse_limits(pkt)) is not None:
            if (weekly := P.weekly_reset(limits, ts * 1000)) is not None:
                self._game_time(ts, "weeklyReset", weekly)
        elif siege := P.parse_siege(pkt):
            self._game_time(ts, "siege", siege.next_ms)
        if coll := P.parse_collection(pkt):
            self._sync(ts, coll)
        elif P.opcode(pkt) == P.OP_COLLECTION:
            # Not a collection we can read, or not one at all: no sync, and the record to learn from.
            print(f"collection not read ({len(pkt)} bytes): {pkt[:64].hex(' ')}", file=sys.stderr)

    def _game_time(self, ts: float, timer: str, at: int) -> None:
        """A start the game gave for one of the app's timers (shared/timers.ts ids), passed on once
        per new time: the app moves that timer's schedule onto it."""
        if self.game_times.get(timer) != at:
            self.game_times[timer] = at
            self.on_event({"type": "gameTime", "ts": ts, "timer": timer, "at": at})

    def _hear(self, ts: float, pkt: bytes) -> None:
        """A record naming a monster in view (its entity first) says it is still there; once a
        second, those not named for GONE_SILENT_S are taken out of view. One taken out that is named
        again (moving, standing, hit) is back."""
        body = P._body(pkt)
        entity, n = P.read_varint(body, 0)
        if n and entity in self.heard:
            self.heard[entity] = ts
        elif n and entity in self.silenced:
            self.visible[entity] = self.silenced.pop(entity)
            self.heard[entity] = ts
            self.nearby_dirty = True
        if ts - self.swept < 1.0:
            return
        self.swept = ts
        for entity in [e for e, at in self.heard.items() if ts - at > GONE_SILENT_S]:
            self.heard.pop(entity)
            if (code := self.visible.pop(entity, None)) is not None:
                self.silenced[entity] = code
                self.nearby_dirty = True

    def _move(self, ts: float, pkt: bytes, x: float, y: float, exact: bool) -> None:
        """You are at game (x, y): kept as questlog.gg's (x, -y), with the height the record gives."""
        self.position = (x, -y)
        self.height = P.height_after(pkt, x, y)
        self.position_ts, self.position_exact = ts, exact
        self.far_seen = None
        self.nearby_dirty = True

    def _jump(self, ts: float, x: float, y: float) -> bool:
        """Game (x, y) is too far from your last position for the time since, or far off with no
        second record near it yet: a misread."""
        if self.position is None:
            return False
        dt, d = ts - self.position_ts, math.dist(self.position, (x, -y))
        if d <= (MAX_SPEED * max(dt, 0.05) if dt < MAX_JUMP_S else CONFIRM_JUMP):
            return False
        # Dropped, but remembered: a second record near it, once MAX_JUMP_S has passed, is believed.
        seen, self.far_seen = self.far_seen, (x, -y)
        return dt < MAX_JUMP_S or seen is None or math.dist(seen, (x, -y)) > CAST_RANGE

    def forget_view(self) -> None:
        """The game closed: nothing is around you any more, and entity ids start over (yours too:
        kept, an effect on whoever gets it next would place you)."""
        with self.lock:
            self.visible.clear()
            self.heard.clear()
            self.silenced.clear()
            self.mob_code.clear()
            self.credits.clear()
            self.self_votes.clear()
            self.players.clear()
            self.legions.clear()
            self.self_entity = None
            self.world = self.position = self.height = None
            self.world_restored = False
            self.position_ts = float("-inf")
            self.position_exact = False
            self.nearby_dirty = True
            if self.addons is not None:
                self.addons.zone(None)

    def _maxed(self, pid: int | None) -> bool:
        """A pet at the cap, which gets crystals instead of souls."""
        pet = self.data["pets"].get(str(pid)) if pid is not None else None
        return bool(pet) and (pet.get("level") or 0) >= MAX_LEVEL

    def _is_me(self, entity: int) -> bool:
        """You: the entity your zone entry named, or the one credited with the kills before your souls."""
        return entity in (self.self_entity, self.self_id()) and entity is not None

    def self_id(self) -> int | None:
        best = self.self_votes.most_common(1)
        return best[0][0] if best else None

    def current_world(self) -> int | None:
        """Your zone: the last zone load's, else (started mid-session, no zone load seen yet) the one
        the soul monsters around you spawn in. What the app and addons all take as your zone."""
        with self.lock:
            if self.world is not None and not self.world_restored:
                return self.world
            votes: collections.Counter = collections.Counter()
            for code in self.visible.values():
                for world in self.dropper_worlds.get(code, ()):
                    votes[world] += 1
            guess = votes.most_common(1)[0][0] if votes else None
            if self.world_restored:
                if guess is None or guess == self.world:
                    return self.world
                self._unrestore(None)  # back to guessing, as with no zone load seen
        return guess

    def _unrestore(self, world: int | None) -> None:
        """The zone restored after an update restart is not yours: `world` is, as the field boss list
        says (None: the soul monsters' guess takes over). The restored position was in the old zone,
        so it goes too."""
        self.world = world
        self.world_restored = False
        self.position = self.height = None
        self.position_ts = float("-inf")
        self.position_exact = False
        self.nearby_dirty = True
        self._zoned = world is not None

    def nearby(self) -> dict:
        """The monsters loaded around you, by mob code, with your zone, position and height."""
        with self.lock:
            self.nearby_dirty = False
            counts = collections.Counter(self.visible.values())
            world = self.current_world()
        return {
            "world": world,
            "position": [round(v) for v in self.position] if self.position else None,
            "height": round(self.height) if self.height is not None and self.position else None,
            "monsters": [{"npc": code, "count": n} for code, n in counts.most_common()],
        }

    def view(self, pid: str | int) -> dict:
        return pet_view(pid, self.data["pets"][str(pid)], self.session[int(pid)])

    def snapshot(self) -> list[dict]:
        with self.lock:
            return [self.view(pid) for pid in self.data["pets"]]

    def reset_session(self) -> None:
        """Start the session's counts again (the collection itself is untouched)."""
        with self.lock:
            self.session.clear()

    def session_counts(self) -> dict[str, dict[str, int]]:
        """Every character's session counts ('' before one was seen), for an app update restart."""
        with self.lock:
            return {name or "": {str(pid): n for pid, n in counts.items() if n > 0}
                    for name, counts in self.sessions.items() if any(n > 0 for n in counts.values())}

    def restore_sessions(self, sessions: dict, world: int | None = None,
                         position: list | None = None) -> None:
        """The counts session_counts gave before an app update restart, back in place; and where
        you were, until the next zone load says otherwise."""
        with self.lock:
            for name, counts in sessions.items():
                session = self.sessions.setdefault(name or None, collections.Counter())
                session.clear()
                session.update({int(pid): int(n) for pid, n in counts.items() if int(n) > 0})
            self.session = self.sessions.setdefault(self.data.get("current"), collections.Counter())
            if self.world is None and isinstance(world, int):
                self.world = world
                self.world_restored = True
                if isinstance(position, list) and len(position) == 2:
                    self.position = (float(position[0]), float(position[1]))
                self.nearby_dirty = True

    def set_souls(self, pid: int, souls: int) -> dict:
        with self.lock:
            self._pet(pid)["souls"] = souls
            self._save()
            return self.view(pid)

    def set_name(self, pid: int, name: str) -> dict:
        with self.lock:
            self._pet(pid)["votes"] = {name: 10**6}  # a name you give outvotes any learned one
            self._save()
            return self.view(pid)

    def _pet(self, pid: int) -> dict:
        return self.data["pets"].setdefault(str(pid), {"souls": 0, "votes": {}})

    def _save(self) -> None:
        if self.persist:
            save(self.data, self.store)

    def character(self) -> dict | None:
        """The character playing (the one the collection is), or None before one was seen."""
        name = self.data.get("current")
        entry = self.data.get("characters", {}).get(name, {})
        return {"name": name, "server": entry.get("server"), "guild": entry.get("guild")} if name else None

    def _character(self, ts: float, who: P.Character) -> None:
        """Pet levels are per character: each has its own collection (souls, levels, crystals),
        saved under `characters` while another plays. What the tracker learned of which monster
        drops which pet (the votes) is the same for all, and goes along to the one switched to."""
        chars = self.data.setdefault("characters", {})
        old = self.data.get("current")
        if who.name == old:
            entry = chars.setdefault(old, {})
            if who.server is not None and entry.get("server") != who.server:
                entry["server"] = who.server
                self._save()
            if who.guild is not None:
                self._my_legion(who.guild)
            return
        resync = None
        if old is not None:
            # A login sync just before this was the new character's, not the old one's: undo it.
            if self.before_sync and ts - self.before_sync[0] <= SYNC_SWITCH_S:
                _, before, resync = self.before_sync
                self.data["pets"] = before
            chars.setdefault(old, {})["pets"] = self.data["pets"]
            entry = chars.setdefault(who.name, {})
            pets = entry.pop("pets", {})
            _merge_votes(self.data["pets"], pets)
            self.data["pets"] = pets
        # else: the first character seen takes the collection saved before characters were told apart
        # (a sync just before is this character's own, already in it).
        entry = chars.setdefault(who.name, {})
        if who.server is not None:
            entry["server"] = who.server
        if who.guild is not None:
            entry["guild"] = who.guild
        self.data["current"] = who.name
        self.session = self.sessions.setdefault(who.name, collections.Counter())
        self.last_soul.clear()
        self.crystal_run.clear()
        self._save()
        print(f"character: {who.name}" + (f" (was {old})" if old else ""), file=sys.stderr)
        self.before_sync = None
        if resync:
            self._sync(ts, resync, keep=False)
        self.on_event({"type": "character", "ts": ts, **self.character(), "switched": old is not None,
                       "pets": [self.view(pid) for pid in self.data["pets"]]})

    def _my_legion(self, name: str) -> None:
        """Your legion, kept with the character playing (for the PvP Log's My Guild)."""
        me = self.data.get("current")
        if me is None:
            return
        entry = self.data.setdefault("characters", {}).setdefault(me, {})
        if entry.get("guild") != name:
            entry["guild"] = name
            self._save()
            print(f"legion: {me} is in {name}", file=sys.stderr)

    def _pvp_kill(self, ts: float, credit: P.KillCredit) -> None:
        """A player killed a player around you (the killing blow): passed on once, with the victim's
        name if they were in view, and whether you were the killer or the victim."""
        key = (credit.victim, credit.killer)
        if ts - self.pvp_seen.get(key, float("-inf")) < 30:
            return
        self.pvp_seen = {k: t for k, t in self.pvp_seen.items() if ts - t < 60}
        self.pvp_seen[key] = ts
        me = self.data.get("current")
        if me is not None and credit.name == me and credit.guild is not None:
            self._my_legion(credit.guild)  # your own kill names your legion
        mine = self.data.get("characters", {}).get(me, {}) if me else {}
        my_server, my_guild = mine.get("server"), mine.get("guild")
        died = credit.victim == self.self_entity and self.self_entity is not None
        victim = self.players.get(credit.victim)
        victim_view = ({"name": me, "server": my_server, "guild": my_guild} if died else
                       {"name": victim.name, "server": victim.server,
                        "guild": victim.guild or self.legions.get(credit.victim)} if victim else None)
        killer_guild = credit.guild or self.legions.get(credit.killer)

        def ours(guild: str | None, server: int | None) -> bool:
            # Legion names are per server: one of the same name elsewhere is another legion.
            return my_guild is not None and guild == my_guild and (server is None or my_server is None or server == my_server)

        self.on_event({
            "type": "pvpKill", "ts": ts,
            "killer": {"name": credit.name, "server": credit.server, "guild": killer_guild},
            "victim": victim_view,
            "mine": me is not None and credit.name == me and (my_server is None or credit.server == my_server),
            "died": died,
            # Your legion killed or was killed (you included).
            "legion": ours(killer_guild, credit.server) or (victim_view is not None and ours(victim_view["guild"], victim_view["server"])),
        })

    def _sync(self, ts: float, coll: P.Collection, keep: bool = True) -> None:
        """Entering the world sends the whole collection: take the server's numbers for every pet."""
        if keep:
            self.before_sync = (ts, copy.deepcopy(self.data["pets"]), coll)
        corrected = []
        for pid in coll.souls.keys() | coll.levels.keys():
            pet = self._pet(pid)
            souls = coll.souls.get(pid, 0)
            if pet["souls"] != souls and (pet["souls"] or pet.get("votes")):
                corrected.append({"id": pid, "name": pet_view(pid, pet)["name"], "before": pet["souls"], "after": souls})
            pet["souls"] = souls
            if pid in coll.levels:
                pet["level"] = coll.levels[pid]
                pet.pop("levelEstimated", None)
                pet.pop("corrected", None)  # the game's level now, nothing to undo
        self._save()
        self.on_event({"type": "sync", "ts": ts, "pets": len(coll.souls), "souls": sum(coll.souls.values()),
                       "corrected": corrected})

    def _soul(self, ts: float, soul: P.Soul, vote: bool = True) -> None:
        pet = self._pet(soul.pet_id)
        self.last_soul[soul.pet_id] = ts
        self.crystal_run.pop(soul.pet_id, None)
        # A soul for a pet a crystal put at Lv3: it was not, so that is undone (its level and
        # souls back, the crystals it was given taken off).
        undone = False
        if (was := pet.pop("corrected", None)) and (pet.get("level") or 0) >= MAX_LEVEL:
            pet["level"], pet["souls"] = was["level"], was["souls"]
            if was.get("levelEstimated"):
                pet["levelEstimated"] = True
            pet["crystals"] = max(0, pet.get("crystals", 0) - was["crystals"])
            undone = True
        pet["souls"] += soul.amount
        levelled = level_up(pet)
        # Vote for the nearest kill before the soul (kill credit comes ~0.3 s before it).
        near = [(ts - t, m) for t, m in self.recent if 0 <= ts - t <= NAME_WINDOW_S]
        if near and vote:
            code = self.mob_code.get(min(near)[1])
            name = self.npcs.get(str(code), {}).get("name")
            if name:
                pet["votes"][name] = pet["votes"].get(name, 0) + 1
        self.session[soul.pet_id] += soul.amount
        # Whoever was credited with the kill just before this soul is (most often) you.
        credited = [(ts - t, owner) for t, _mob, owner in self.credits if 0 <= ts - t <= NAME_WINDOW_S]
        if credited:
            self.self_votes[min(credited)[1]] += 1
        self._save()
        self.on_event({"type": "soul", "ts": ts, "amount": soul.amount, "pet": self.view(soul.pet_id),
                       "levelUp": levelled, "levelUndone": undone})

    def _crystal(self, ts: float, crystal: P.Crystal) -> None:
        """Genus crystals from a monster whose pet is maxed. The message names no pet, so it is
        the pet of a monster killed just before (yours if it is known which player you are), of
        the crystal's genus. Among those:
        - a pet already at Lv3 (as the login sync said) is it: the nearest such kill, yours
          first, else anyone's (a party member's kill gives you its crystal too);
        - else, if every such kill around (anyone's) is one pet's monster, and that pet got no soul
          lately, that pet is at Lv3 already in game, whatever was saved (souls it got and the
          tracker missed): it is corrected and credited (2026-10-11: Dracuni Herbalist, Lv3 in
          game, saved as Lv2 with 70). A soul later undoes it (see _soul);
        - else no one: two pets that could both be it (2026-10-10, a Foul Skama and a Marsh
          Targon dying together, had put the Skama's crystal on the Targon and marked it Lv3).
        Only your kills counted for the correction once: in a party, your Lv2 pet's monster dying
        beside a party member's maxed one was taken to be Lv3 (2026-10-19: Naga Elite Priest,
        Sulfur Skama and two more, all getting souls right after).
        """
        genus = P.CRYSTAL_GENUS.get(crystal.genus)
        kills = [(ts - t, mob, owner) for t, mob, owner in self.credits if 0 <= ts - t <= NAME_WINDOW_S]
        me = self.self_id()
        # (seconds before, monster code, pet, yours) for each kill whose monster drops a pet of this genus.
        candidates = []
        for ago, mob, owner in kills:
            code = self.mob_code.get(mob)
            pid = self.droppers.get(code) if code else None
            if pid is not None and (genus is None or self.genera.get(pid) in (None, genus)):
                candidates.append((ago, code, pid, me is None or owner == me))
        maxed = [c for c in candidates if self._maxed(c[2])]
        pick, corrected, amount = None, False, crystal.amount
        if maxed:
            pick = min([c for c in maxed if c[3]] or maxed)
        elif candidates and len({c[2] for c in candidates}) == 1:
            pid = candidates[0][2]
            n, given = self.crystal_run.get(pid, (0, 0))
            n, given = n + 1, given + crystal.amount
            if ts - self.last_soul.get(pid, float("-inf")) > SOUL_PROOF_S or n >= CRYSTAL_RUN:
                # The run's earlier crystals, which went to no one, are its too.
                pick, corrected, amount = min(candidates), True, given
                self.crystal_run.pop(pid, None)
            else:
                self.crystal_run[pid] = (n, given)
        event = {"type": "crystal", "ts": ts, "amount": crystal.amount, "genus": genus,
                 "npc": pick[1] if pick else None, "raw": crystal.raw.hex(" "), "pet": None,
                 "levelCorrected": False,
                 # What was considered, when it went to no one: to see why in the log.
                 "kills": [] if pick else [
                     {"npc": self.mob_code.get(mob), "name": self._npc_name(self.mob_code.get(mob)),
                      "pet": self.droppers.get(self.mob_code.get(mob)), "ago": round(ago, 2)}
                     for ago, mob, _owner in kills]}
        if pick:
            _ago, code, pid, _mine = pick
            pet = self._pet(pid)
            if corrected:
                # What it was, for a soul to undo this with.
                pet["corrected"] = {"level": pet.get("level") or 0, "souls": pet["souls"],
                                    "levelEstimated": pet.get("level") is None or bool(pet.get("levelEstimated")),
                                    "crystals": 0}
                pet["level"], pet["souls"] = MAX_LEVEL, 0
                pet.pop("levelEstimated", None)
                event["levelCorrected"] = True
            pet["crystals"] = pet.get("crystals", 0) + amount
            if "corrected" in pet:
                pet["corrected"]["crystals"] += amount
            if name := self._npc_name(code):
                pet["votes"][name] = pet["votes"].get(name, 0) + 1
            self._save()
            event["pet"] = self.view(pid)
        self.on_event(event)

    def _npc_name(self, code: int | None) -> str | None:
        return self.npcs.get(str(code), {}).get("name") if code else None

def _merge_votes(src: dict, dst: dict) -> None:
    """The monster names learned for each pet, from one character's collection into another's."""
    for pid, pet in src.items():
        if not pet.get("votes"):
            continue
        votes = dst.setdefault(pid, {"souls": 0, "votes": {}}).setdefault("votes", {})
        for name, n in pet["votes"].items():
            votes[name] = max(votes.get(name, 0), n)


def show(data: dict, everything: bool = True) -> None:
    pets = sorted(data["pets"].items(), key=lambda kv: -kv[1]["souls"])
    if not pets:
        print("no pets tracked yet")
    shown = [(pid, pet) for pid, pet in pets if everything or pet.get("votes")]
    for pid, pet in shown:
        print(f"  {pet_name(pet):30} pet {pid:<6} {progress(pet)}")
    if len(shown) < len(pets):
        print(f"  ... and {len(pets) - len(shown)} pets not yet matched to a monster ('show' lists all)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="*", help="'set <pet id> <souls>', 'name <pet id> <name>', 'sync <login.pcap>' or 'show'")
    ap.add_argument("--replay", help="count the souls in a saved .pcap instead of watching live")
    ap.add_argument("--npcs", default=str(NPCS_DEFAULT))
    a = ap.parse_args()
    data = load()

    if a.cmd:
        if a.cmd[0] == "set" and len(a.cmd) == 3:
            Tracker(data, npcs={}).set_souls(int(a.cmd[1]), int(a.cmd[2]))
        elif a.cmd[0] == "name" and len(a.cmd) >= 3:
            Tracker(data, npcs={}).set_name(int(a.cmd[1]), " ".join(a.cmd[2:]))
        elif a.cmd[0] == "sync" and len(a.cmd) == 2:
            # Only the login collection is taken from the capture, not its souls: a capture that is
            # synced twice must not count the same souls twice.
            tracker = Tracker(data, npcs={}, persist=True)

            def collection_only(ts: float, pkt: bytes) -> None:
                if coll := P.parse_collection(pkt):
                    tracker._sync(ts, coll)

            capture.replay(a.cmd[1], capture.GameStream(collection_only))
            show(data, everything=False)
            return
        elif a.cmd[0] != "show":
            ap.error("unknown command")
        show(data)
        return

    npcs = json.loads(Path(a.npcs).read_text(encoding="utf-8"))
    if a.replay:
        # A replay counts from zero into a throwaway copy, so it never touches your saved counts.
        tracker = Tracker({"pets": {}}, npcs, persist=False)
        capture.replay(a.replay, capture.GameStream(tracker.on_packet))
        show(tracker.data, everything=False)
        return
    tracker = Tracker(data, npcs)
    print("tracking pet souls. Log in (or switch character) while this runs to sync every pet.")
    show(data, everything=False)
    try:
        capture.live(capture.GameStream(tracker.on_packet))
    except KeyboardInterrupt:
        pass
    print("\nsession totals:")
    show(data, everything=False)


if __name__ == "__main__":
    main()
