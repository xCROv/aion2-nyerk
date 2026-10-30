"""Server->client TCP payloads of the game flow, live through Npcap or from a saved .pcap.

The game flow is found the way the DPS meters find it: the server port whose payloads keep
carrying the stream's record terminator. A per-flow sequence check drops retransmissions.

The lock is on the server port, so a reconnect to another server on the same port (13328 when the
game connects directly) carries on at once. Through a ping reducer's local proxy (ExitLag) the
port is the proxy's, and a reconnect gets a new one: when the locked port stops carrying the
terminator and another one carries it, the lock moves there.

Live capture listens on every adapter that has an address at once: with a VPN or a ping reducer
the game's traffic is only readable on the tunnel adapter, which is not Windows' default one.
"""

from __future__ import annotations

import socket
import struct
import sys
import threading
import time
from collections.abc import Callable, Iterator

from scapy.all import IP, TCP, PcapReader, conf

from . import protocol

LOCK_HITS = 12  # signature-bearing packets ...
LOCK_WINDOW_S = 3.0  # ... within this long, from one flow, lock onto it
HOLD_LIMIT = 4 * 1024 * 1024  # bytes kept per flow while waiting for the lock
# Until the lock, how often the log says what each adapter is seeing; once locked, how long the
# stream goes without a packet read before the log says what the locked port sent.
REPORT_S = 30.0
# Once locked: the locked port has gone this long without the terminator (a live game stream
# carries it every 0.2s at most) before another flow can take the lock over.
RELOCK_QUIET_S = 3.0
# Once locked, only flows this young (or carrying the terminator) are held for a re-lock, so the
# other traffic of a long session is not kept.
HOLD_YOUNG_S = 10.0
# How long the stream waits on a missing segment before going on without it. A resend (lost on the
# way, not just by the capture) comes well within this.
GAP_WAIT_S = 2.0
# Once locked, the stream's health (bytes got of those sent) goes in the log every report that
# missed some, and every this many reports regardless (5 minutes).
HEALTH_EVERY = 10
# What Npcap hands over: TCP but the web (HTTPS, HTTP), where a PC's heavy traffic is (downloads,
# streams, Discord) and the game never is. Left to the tracker, a busy PC's ~4,000 packets a second
# were more than it could read (2026-10-28).
CAPTURE_FILTER = "tcp and not port 443 and not port 80"
# Npcap's buffer for each adapter (its default is 1 MB, about 2 s of one player's traffic).
NPCAP_BUFFER = 16 * 1024 * 1024
# Debug logging's recording of the game connection stops past this (the stream is ~5 MB an hour).
RECORD_LIMIT = 100_000_000


class Reassembler:
    """One flow's byte stream: in-order payloads appended, packets split off the front."""

    def __init__(self, on_gap: Callable[[int], None] | None = None) -> None:
        self.buf = b""
        self.next_seq: int | None = None
        self.pending: dict[int, bytes] = {}
        self.pending_since: float | None = None  # when the oldest gap still open was first held behind
        self.appended = 0  # stream bytes taken in order, all told
        self.on_gap = on_gap  # told how many bytes were skipped each time the stream gives up on a gap
        # A flow through a tunnel (protocol.unwrap_tunnel) once seen as one: its messages unwrapped
        # into `inner`, the game stream they carry, which is split as any other.
        self.tunnel = False
        self.inner = b""

    def feed(self, seq: int, data: bytes, ts: float | None = None) -> list[bytes]:
        if self.next_seq is None:
            self.next_seq = seq
        delta = (seq - self.next_seq) & 0xFFFFFFFF
        if delta == 0:
            self._append(data)
        elif delta < 0x80000000:  # ahead: hold until the gap fills (or give up: GAP_WAIT_S, 64 KB)
            self.pending[seq] = data
            if self.pending_since is None:
                self.pending_since = ts
            # A segment Npcap never got is never resent (the game got it), so the gap is given up
            # on after a few seconds too: a quiet stream (1-5 KB per 30 s, standing in a zone) took
            # 10-20 minutes to reach 64 KB, all of it held (2026-10-28, "Game connection idle").
            waited = ts is not None and self.pending_since is not None and ts - self.pending_since > GAP_WAIT_S
            if not waited and sum(map(len, self.pending.values())) <= 65536:
                return []
            self._resync()
        else:  # behind: a retransmission, keep only bytes we have not seen
            skip = (self.next_seq - seq) & 0xFFFFFFFF
            if skip >= len(data):
                return []
            self._append(data[skip:])
        # What was held and now lines up: after the gap filled, or after giving up on it. (Only
        # draining on an exact arrival stalled the stream for good after a resync, whose first
        # held segment had already arrived.)
        self._drain()
        # A gap still open after a resync (another segment missing further on) waits from now.
        self.pending_since = (ts if self.pending_since is None else self.pending_since) if self.pending else None
        if not self.tunnel and protocol.is_tunnel(self.buf):
            self.tunnel = True
            print("[capture] the game stream comes through a tunnel (a ping reducer?): unwrapping it", file=sys.stderr)
        elif not self.tunnel and protocol.maybe_tunnel(self.buf):
            return []  # one message so far: the next says whether the stream is the tunnel's
        if self.tunnel:
            data, consumed = protocol.unwrap_tunnel(self.buf)
            self.buf = self.buf[consumed:]
            self.inner += data
            packets, consumed = protocol.split(self.inner)
            self.inner = self.inner[consumed:]
        else:
            packets, consumed = protocol.split(self.buf)
            self.buf = self.buf[consumed:]
        if len(self.buf) > 2 * 1024 * 1024:
            self.buf = b""
        if len(self.inner) > 2 * 1024 * 1024:
            self.inner = b""
        return packets

    def _append(self, data: bytes) -> None:
        self.appended += len(data)
        self.buf += data
        self.next_seq = (self.next_seq + len(data)) & 0xFFFFFFFF

    def _drain(self) -> None:
        while True:
            # Held segments now (partly) behind the stream: keep only their new bytes, or drop
            # them, so none is held for ever.
            for s in [s for s in self.pending if (s - self.next_seq) & 0xFFFFFFFF >= 0x80000000]:
                data = self.pending.pop(s)
                skip = (self.next_seq - s) & 0xFFFFFFFF
                if skip < len(data) and len(data) - skip > len(self.pending.get(self.next_seq, b"")):
                    self.pending[self.next_seq] = data[skip:]
            if self.next_seq not in self.pending:
                return
            self._append(self.pending.pop(self.next_seq))

    def _resync(self) -> None:
        # Lost a segment for good: drop what is buffered and restart at the earliest held one.
        first = min(self.pending, key=lambda s: (s - self.next_seq) & 0xFFFFFFFF)
        if self.on_gap is not None:
            self.on_gap(((first - self.next_seq) & 0xFFFFFFFF) + len(self.buf))
        self.buf = b""
        self.inner = b""  # what it carried runs on from bytes now lost too
        self.next_seq = first
        self.pending_since = None


class GameStream:
    """Feeds raw TCP segments in, hands game packets (with their capture time) out."""

    def __init__(self, on_packet: Callable[[float, bytes], None], server_port: int | None = None,
                 on_lock: Callable[[str, int], None] | None = None):
        self.on_packet = on_packet
        self.port = server_port
        self.on_lock = on_lock or (lambda host, port: print(f"[capture] game stream locked: server {host}:{port}"))
        self.flows: dict[tuple[str, int, str, int], Reassembler] = {}
        self.hits: dict[tuple[str, int], list[float]] = {}
        # Until a flow is known to be the game, its segments are held here, so that what it sent
        # before the lock (a login's character and collection data) is not lost.
        self.held: dict[tuple[str, int, str, int], list[tuple]] = {}
        self.held_bytes: dict[tuple[str, int, str, int], int] = {}
        self.first_seen: dict[tuple[str, int, str, int], float] = {}
        self.last_sig: float | None = None  # the locked port's last terminator
        # Since the last quiet_report: what came from the locked port, and what was read out of it.
        self.seen = self.seen_bytes = self.empty = self.decoded = 0
        # Since the last health_report: the bytes the server sent (how far each flow's sequence
        # numbers went), those that reached the stream in order, and the gaps given up on.
        self.seq_end: dict[tuple[str, int, str, int], int] = {}
        self.sent = self.got = self.gaps = self.lost = 0

    def health_report(self, always: bool = False) -> str | None:
        """Locked: how much of what the server sent was captured, when some was missed (or
        `always`). The sequence numbers say what was sent whatever the capture saw, so a capture
        that misses most of the stream shows as such (2026-10-28: a player's got 2-10% of it).
        The counts start again either way."""
        line = None
        # A segment still in flight at the end of a window is not a miss: over 1% is.
        if self.port is not None and self.sent and (always or self.lost or self.sent - self.got > self.sent // 100):
            line = (f"game stream: got {self.got:,} of {self.sent:,} bytes the server sent "
                    f"({100 * min(self.got, self.sent) // self.sent}%), {self.gaps} gaps given up ({self.lost:,} bytes)")
        self.sent = self.got = self.gaps = self.lost = 0
        return line

    def quiet_report(self) -> str | None:
        """Locked but nothing read since the last call: what the port sent, so the log says where the
        stream stalls (2026-10-28: a player stuck on "Game connection idle", the log silent about
        why). None when packets were read; the counts start again either way."""
        line = None
        if self.port is not None and not self.decoded:
            waiting = sum(sum(map(len, f.pending.values())) for f in self.flows.values())
            unsplit = sum(len(f.buf) for f in self.flows.values())
            line = (f"locked on port {self.port} but nothing read: {self.seen} segments ({self.seen_bytes} bytes) "
                    f"from it, {self.empty} without payload; {waiting} bytes held waiting on a gap, "
                    f"{unsplit} bytes not split into packets")
        self.seen = self.seen_bytes = self.empty = self.decoded = 0
        return line

    def segment(self, ts: float, src: str, sport: int, dst: str, dport: int, seq: int, data: bytes) -> None:
        if self.port is not None and sport == self.port:
            self.seen += 1
            self.seen_bytes += len(data)
            self.empty += not data
        if not data:
            return
        key = (src, sport, dst, dport)
        signed = any(sig in data for sig in protocol.GAME_SIGNATURES)
        if self.port is not None and sport == self.port:
            if signed:
                self.last_sig = ts
            end = (seq + len(data)) & 0xFFFFFFFF
            ahead = len(data) if key not in self.seq_end else (end - self.seq_end[key]) & 0xFFFFFFFF
            if ahead < 0x80000000:  # not a retransmission, nor a segment that came late
                self.sent += ahead
                self.seq_end[key] = end
            self._feed(key, ts, seq, data)
            return
        # Not (or no longer) the game's port: held, in case it turns out to be.
        self._hold(key, (ts, seq, data), signed)
        if not signed:
            return
        times = [t for t in self.hits.get((src, sport), []) if ts - t <= LOCK_WINDOW_S] + [ts]
        self.hits[(src, sport)] = times
        if len(times) < LOCK_HITS:
            return
        if self.port is not None and self.last_sig is not None and ts - self.last_sig < RELOCK_QUIET_S:
            return  # the locked stream is still live: this one waits (held) until it goes quiet
        self._lock(src, sport, ts)

    def _lock(self, src: str, sport: int, ts: float) -> None:
        self.port = sport
        self.last_sig = ts
        self.on_lock(src, sport)
        held = {k: v for k, v in self.held.items() if k[1] == sport}
        self.flows.clear()  # a stream moved from: gone for good
        self.seq_end.clear()
        self.hits.clear()
        self.held.clear()
        self.held_bytes.clear()
        self.first_seen.clear()
        for k, segs in held.items():
            for t, s, d in segs:
                self._feed(k, t, s, d)
        # the segment that completed the lock was the last one held
        self.sent = self.got = self.gaps = self.lost = 0  # the health counts start with the lock

    def _hold(self, key, seg, signed: bool) -> None:
        if key not in self.held:
            if seg[2][:3] in (b"\x17\x03\x03", b"\x16\x03\x01", b"\x16\x03\x03"):
                self.held_bytes[key] = HOLD_LIMIT  # TLS: never the game, never held
            self.held[key] = []
            self.first_seen[key] = seg[0]
        if (self.port is not None and not signed and not self.hits.get((key[0], key[1]))
                and seg[0] - self.first_seen[key] > HOLD_YOUNG_S):
            # Locked, and an old flow that has never looked like the game: let its bytes go.
            self.held[key] = []
            self.held_bytes[key] = HOLD_LIMIT
        if self.held_bytes.get(key, 0) + len(seg[2]) > HOLD_LIMIT:
            return
        self.held[key].append(seg)
        self.held_bytes[key] = self.held_bytes.get(key, 0) + len(seg[2])

    def _feed(self, key, ts: float, seq: int, data: bytes) -> None:
        if key not in self.flows:
            # A segment Npcap never delivered: whatever it carried (a soul, say) is lost, so the
            # log says so (2026-10-22: pets reaching Lv3 a few souls before the tracker said).
            self.flows[key] = Reassembler(self._gap)
        flow = self.flows[key]
        before = flow.appended
        packets = flow.feed(seq, data, ts)
        self.got += flow.appended - before
        for pkt in packets:
            self.decoded += 1
            self.on_packet(ts, pkt)

    def _gap(self, n: int) -> None:
        self.gaps += 1
        self.lost += n
        print(f"[capture] lost {n} bytes of the game stream (segments never captured)", file=sys.stderr)


def _segments(packets) -> Iterator[tuple]:
    for p in packets:
        if IP in p and TCP in p:
            ip, t = p[IP], p[TCP]
            # Trim to the IP length: short frames carry Ethernet padding that scapy leaves on
            # the TCP payload, and it would be read as stream bytes.
            # An IP length of 0 is a segment the adapter merged past 64 KB (large receive offload):
            # its whole payload is stream bytes.
            size = ip.len - ip.ihl * 4 - t.dataofs * 4
            data = bytes(t.payload) if ip.len == 0 else bytes(t.payload)[: max(size, 0)]
            yield float(p.time), ip.src, t.sport, ip.dst, t.dport, t.seq, data


def _raw_segment(link: str, raw: bytes, ts: float) -> tuple | None:
    """A frame's TCP segment as _segments gives it, read straight from the bytes: `link` is the
    adapter's link layer ("Ether", or "Loopback" for Npcap's loopback adapter). None for anything
    else. Live capture reads every packet this way: scapy taking each frame apart cost ~10x as much,
    and on a busy PC the reading fell behind (2026-10-28)."""
    if link == "Loopback":
        if len(raw) < 4 or int.from_bytes(raw[:4], "little") != 2:  # AF_INET
            return None
        off = 4
    else:
        off, etype = 14, raw[12:14]
        while etype == b"\x81\x00" and len(raw) >= off + 4:  # VLAN tags
            etype, off = raw[off + 2:off + 4], off + 4
        if etype != b"\x08\x00":
            return None
    if len(raw) < off + 20 or raw[off] >> 4 != 4 or raw[off + 9] != 6:
        return None
    ihl = (raw[off] & 0x0F) * 4
    total = int.from_bytes(raw[off + 2:off + 4], "big")
    t = off + ihl
    if len(raw) < t + 20:
        return None
    sport, dport, seq = struct.unpack_from("!HHI", raw, t)
    start = t + (raw[t + 12] >> 4) * 4
    # Trimmed to the IP length (short frames carry Ethernet padding), except a length of 0: a
    # segment merged past 64 KB, all of it stream bytes (as _segments).
    data = raw[start:] if total == 0 else raw[start:off + total]
    return ts, socket.inet_ntoa(raw[off + 12:off + 16]), sport, socket.inet_ntoa(raw[off + 16:off + 20]), dport, seq, data


def replay(path: str, stream: GameStream, speed: float | None = None,
           stop: threading.Event | None = None) -> None:
    """Feed a saved capture through `stream`. With `speed`, at that multiple of real time (for
    trying the overlay without the game); without it, as fast as it reads."""
    first = started = None
    with PcapReader(path) as reader:
        for seg in _segments(reader):
            if stop is not None and stop.is_set():
                return
            if speed:
                first = seg[0] if first is None else first
                started = time.monotonic() if started is None else started
                wait = (seg[0] - first) / speed - (time.monotonic() - started)
                if wait > 0:
                    time.sleep(wait)
            stream.segment(*seg)


def pick_interfaces(ifaces) -> list:
    """The adapters worth listening on: valid ones with an IPv4 address that is not link-local.
    That keeps the connected adapters, VPN tunnels and loopback (some ping reducers proxy through
    it), and leaves out disconnected Wi-Fi, Bluetooth and WAN miniports. Empty if none qualify."""
    return [i for i in ifaces
            if i.is_valid() and any(not ip.startswith("169.254.") for ip in i.ips.get(4, []))]


def _open(log: Callable[[str], None]) -> dict:
    """{socket: adapter name} for every adapter that opens; raises if none does."""
    chosen = pick_interfaces(conf.ifaces.values()) or [conf.iface]
    sockets, opened, failed = {}, [], []
    for iface in chosen:
        try:
            sockets[conf.L2listen(iface=iface, filter=CAPTURE_FILTER)] = iface.name
            opened.append(f"{iface.name} ({iface.description}, {', '.join(iface.ips.get(4, []))})")
        except Exception as e:  # noqa: BLE001 -- one bad adapter must not stop the others
            failed.append(f"{iface.name}: {e}")
            log(f"[capture] could not open {failed[-1]}")
    if not sockets:
        raise RuntimeError("no network adapter could be opened (" + "; ".join(failed) + ")")
    log(f"[capture] listening on {len(opened)} adapter(s): " + "; ".join(opened))
    return sockets


def _npcap_counts(sock) -> tuple[int, int, int] | None:
    """Npcap's own counts for an adapter's socket, all told: (received, dropped because the
    tracker read too slowly, dropped by the adapter). None where they cannot be read."""
    try:
        from ctypes import byref

        from scapy.libs.winpcapy import pcap_stat, pcap_stats

        st = pcap_stat()
        if pcap_stats(sock.pcap_fd.pcap, byref(st)) != 0:
            return None
        return st.ps_recv, st.ps_drop, st.ps_ifdrop
    except Exception:  # noqa: BLE001 -- not Npcap, or not this scapy: the line goes without them
        return None


def _bigger_buffer(sock, name: str, log: Callable[[str], None]) -> None:
    """Npcap's buffer for the adapter at NPCAP_BUFFER, so a moment the tracker is busy (a zone's
    bundle, the PC loading) does not overflow it. Kept as it was where it cannot be set."""
    try:
        from scapy.libs.winpcapy import pcap_setbuff

        if pcap_setbuff(sock.pcap_fd.pcap, NPCAP_BUFFER) != 0:
            log(f"[capture] could not enlarge Npcap's buffer for {name}")
    except Exception:  # noqa: BLE001 -- not Npcap, or not this scapy
        pass


def live(stream: GameStream, iface: str | None = None, save_to: str | None = None,
         stop: threading.Event | None = None, log: Callable[[str], None] = print,
         debug: bool = False, record_to: str | None = None) -> None:
    """Runs until Ctrl+C, or until `stop` is set. Listens on every adapter (see pick_interfaces)
    unless `iface` names one. `save_to` also writes everything captured to a .pcap for later
    replay. `debug` logs the stream's health every report, not only when some was missed;
    `record_to` writes the game connection's packets (both ways, from the lock on, up to
    RECORD_LIMIT) to a .pcap a player can send."""
    from scapy.utils import PcapWriter

    sockets = {conf.L2listen(iface=iface, filter=CAPTURE_FILTER): iface} if iface else _open(log)
    writer = PcapWriter(save_to, append=True, sync=True) if save_to else None
    recorder = PcapWriter(record_to, append=True, sync=True) if record_to else None
    recorded = [0]
    counts = {name: 0 for name in sockets.values()}  # TCP packets per adapter since the last report
    failures: set[str] = set()  # each kind of packet failure, logged once
    game_on: list[str | None] = [None]  # the adapter the game stream is on
    npcap_was = {name: _npcap_counts(sock) for sock, name in sockets.items()}

    def packet(cls, raw: bytes, ts: float):
        p = cls(raw)
        p.time = ts
        return p

    def record(cls, raw: bytes, ts: float, seg: tuple | None) -> None:
        if recorder is None or stream.port is None or seg is None or stream.port not in (seg[2], seg[4]):
            return
        if recorded[0] > RECORD_LIMIT:
            return
        recorder.write(packet(cls, raw, ts))
        recorded[0] += len(raw)
        if recorded[0] > RECORD_LIMIT:
            log(f"[capture] stream recording stopped at {RECORD_LIMIT // 1_000_000} MB: {record_to}")

    def handle(name: str, cls, raw: bytes, ts: float):
        # A packet that fails is skipped, never fatal (2026-10-15: one player name the output could
        # not encode silently ended the capture, when scapy's sniffer read the adapters).
        try:
            if writer is not None:
                writer.write(packet(cls, raw, ts))
            counts[name] += 1
            seg = _raw_segment(cls.__name__, raw, ts)
            if seg is not None:
                before = stream.port
                stream.segment(*seg)
                if stream.port != before:
                    game_on[0] = name
                    moved = f" (moved from port {before})" if before is not None else ""
                    log(f"[capture] the game stream is on {name}{moved}")
            record(cls, raw, ts, seg)
        except Exception as e:  # noqa: BLE001
            if (kind := f"{type(e).__name__}: {e}") not in failures:
                failures.add(kind)
                log(f"[capture] skipped a packet that failed: {kind}")

    def report() -> None:
        seen = ", ".join(f"{name} {n}" for name, n in counts.items())
        log(f"[capture] no game stream yet; TCP packets in the last {REPORT_S:.0f}s: {seen}")
        for name in counts:
            counts[name] = 0

    def npcap() -> str:
        """Npcap's counts since the last report, for the game's adapter (every adapter until known)."""
        parts = []
        for sock, name in sockets.items():
            now, was = _npcap_counts(sock), npcap_was[name]
            npcap_was[name] = now
            if now is None or was is None or game_on[0] not in (None, name):
                continue
            recv, drop, ifdrop = (a - b for a, b in zip(now, was))
            parts.append(f"{name} {recv:,} received, {drop:,} dropped, {ifdrop:,} dropped by the adapter")
        return f"; Npcap: {', '.join(parts)}" if parts else ""

    halt = stop or threading.Event()
    lock = threading.Lock()  # one packet at a time into the stream, whichever adapter it came on
    ended: dict[str, str] = {}  # adapters whose reading failed for good, and why

    def read(sock, name: str) -> None:
        # Each adapter read packet after packet until none is waiting (a read waits up to 100 ms).
        # Scapy's sniffer read one packet each time an adapter signalled: an adapter that hands
        # packets over in batches (a Realtek 2.5GbE, 2026-10-28) got one of each batch read, Npcap's
        # buffer filled, and 90-100% of the game stream was dropped.
        while not halt.is_set():
            try:
                cls, raw, ts = sock.recv_raw()
            except Exception as e:  # noqa: BLE001 -- the adapter is gone: the others carry on
                ended[name] = f"{type(e).__name__}: {e}"
                log(f"[capture] stopped reading {name}: {ended[name]}")
                return
            if raw is None or cls is None:
                continue
            with lock:
                handle(name, cls, raw, float(ts))

    readers = [threading.Thread(target=read, args=(sock, name), name=f"capture {name}", daemon=True)
               for sock, name in sockets.items()]
    for sock, name in sockets.items():
        _bigger_buffer(sock, name, log)
    started = next_report = time.monotonic()
    next_report += REPORT_S
    reports = 0
    if recorder is not None:
        log(f"[capture] debug logging: recording the game connection to {record_to}")
    for t in readers:
        t.start()
    try:
        # Short waits, so Ctrl+C gets through on Windows.
        while not halt.wait(1.0):
            if not any(t.is_alive() for t in readers):
                raise RuntimeError(f"capture ended on its own: {'; '.join(f'{n}: {e}' for n, e in ended.items()) or 'every adapter failed'}")
            if time.monotonic() >= next_report:
                reports += 1
                with lock:
                    if stream.port is None:
                        report()
                        npcap()  # its counts from here on
                    else:
                        if line := stream.quiet_report():
                            log(f"[capture] {line}")
                        # Every report with debug logging, or when some was missed; else now and then.
                        counted = npcap()
                        if line := stream.health_report(always=debug or reports % HEALTH_EVERY == 0):
                            log(f"[capture] {line}{counted}")
                next_report += REPORT_S
    except KeyboardInterrupt:
        pass
    finally:
        halt.set()
        for t in readers:
            t.join(timeout=2.0)
        for sock in sockets:
            sock.close()
        if writer is not None:
            writer.close()
        if recorder is not None:
            recorder.close()
        log(f"[capture] stopped after {time.monotonic() - started:.0f}s")
