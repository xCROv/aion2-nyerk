"""The game stream's TCP reassembly: how long a gap is waited on, a reconnect on the same ports, and
what is held for flows that are not (yet) the game."""

import socket
import struct

import pytest
from scapy.all import IP, TCP, Ether

from aion2_tracker import capture

SERVER_IP, CLIENT_IP, OTHER_IP, PORT = "10.0.0.1", "192.168.1.2", "10.9.9.9", 13328
MB = 1024 * 1024
SYN, ACK, RST = 0x02, 0x10, 0x04


def record(body: bytes) -> bytes:
    return bytes([len(body) + 4]) + body


def records(*bodies: bytes) -> list[bytes]:
    return [record(b"\x99\x99" + b) for b in bodies]


TERMINATOR = record(b"\x00\x36")  # `06 00 36`


def frame(src: str, sport: int, dst: str, dport: int, seq: int, flags: int, data: bytes = b"") -> bytes:
    tcp = struct.pack("!HHIIBBHHH", sport, dport, seq, 0, 5 << 4, flags, 65535, 0, 0)
    ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 40 + len(data), 0, 0, 64, 6, 0,
                     socket.inet_aton(src), socket.inet_aton(dst))
    return bytes(12) + b"\x08\x00" + ip + tcp + data


def from_server(seq: int, data: bytes = b"", flags: int = ACK) -> bytes:
    return frame(SERVER_IP, PORT, CLIENT_IP, 50000, seq, flags, data)


def from_client(seq: int, flags: int) -> bytes:
    return frame(CLIENT_IP, 50000, SERVER_IP, PORT, seq, flags)


def captured(*frames: bytes) -> list[bytes]:
    """The game packets a stream locked on the game's port reads out of `frames`."""
    got: list[bytes] = []
    stream = capture.GameStream(lambda ts, pkt: got.append(pkt), server_port=PORT)
    for i, f in enumerate(frames):
        seg = capture._raw_segment("Ether", f, float(i))
        assert seg is not None
        stream.segment(*seg)
    return got


def held(stream: capture.GameStream) -> int:
    return sum(len(seg[2]) for segs in stream.held.values() for seg in segs)


def test_a_gap_left_open_after_another_filled_waits_its_own_time():
    gaps: list[int] = []
    r = capture.Reassembler(gaps.append)
    recs = records(*(bytes([i]) * 40 for i in range(6)))
    at = [1000 + sum(map(len, recs[:i])) for i in range(6)]

    out = r.feed(at[0], recs[0], 0.0)
    out += r.feed(at[2], recs[2], 0.0)  # recs[1] missing
    out += r.feed(at[4], recs[4], 0.5)  # recs[3] missing too
    out += r.feed(at[1], recs[1], 1.9)  # the first gap fills
    out += r.feed(at[5], recs[5], 2.1)  # 0.2 s into waiting on recs[3]
    out += r.feed(at[3], recs[3], 2.2)

    assert out == recs
    assert gaps == []


def test_a_gap_is_still_given_up_once_waited_on_long_enough():
    gaps: list[int] = []
    r = capture.Reassembler(gaps.append)
    recs = records(*(bytes([i]) * 40 for i in range(4)))
    at = [1000 + sum(map(len, recs[:i])) for i in range(4)]

    out = r.feed(at[0], recs[0], 0.0)
    out += r.feed(at[2], recs[2], 1.0)  # recs[1] never comes
    out += r.feed(at[3], recs[3], 3.1)

    assert out == [recs[0], recs[2], recs[3]]
    assert gaps == [len(recs[1])]


@pytest.mark.parametrize("ending", [
    [from_client(7, SYN), from_server(1_000_000, flags=SYN | ACK)],  # a new connection's handshake
    [from_client(7, RST)],  # the old one reset
])
def test_a_reconnect_on_the_same_ports_starts_the_stream_afresh(ending):
    old, new = records(b"old"), records(b"new one", b"and more")

    # The new connection's numbers are "behind" the old one's: read as resends, all of it was dropped.
    got = captured(from_server(3_000_000_000, old[0]), *ending,
                   from_server(1_000_001, new[0]), from_server(1_000_001 + len(new[0]), new[1]))

    assert got == old + new


def test_a_replay_gives_the_tcp_flags_too():
    sent = Ether(src="02:00:00:00:00:01", dst="02:00:00:00:00:02") / IP(src=SERVER_IP, dst=CLIENT_IP)
    pkt = Ether(bytes(sent / TCP(sport=PORT, dport=50000, seq=5, flags="SA")))

    assert next(capture._segments([pkt]))[-1] == SYN | ACK


def test_what_connections_that_went_quiet_held_is_freed():
    stream = capture.GameStream(lambda ts, pkt: None, server_port=PORT)
    for n in range(20):  # short connections that are not the game: 1 MB each, then nothing
        for k in range(4):
            stream.segment(1.0, OTHER_IP, 40000 + n, CLIENT_IP, 50000, k * MB // 4, bytes(MB // 4))
    assert held(stream) == 20 * MB

    stream.segment(1.0 + capture.HOLD_YOUNG_S + 1, SERVER_IP, PORT, CLIENT_IP, 50000, 0, TERMINATOR)

    assert held(stream) == 0


def test_what_is_held_before_the_lock_stays_within_a_total_and_keeps_the_game():
    got: list[bytes] = []
    stream = capture.GameStream(lambda ts, pkt: got.append(pkt))
    login = records(b"your collection")[0]
    game = [TERMINATOR, login] + [TERMINATOR] * (capture.LOCK_HITS - 1)
    at = [sum(map(len, game[:i])) for i in range(len(game))]
    stream.segment(0.0, SERVER_IP, PORT, CLIENT_IP, 50000, at[0], game[0])
    stream.segment(0.1, SERVER_IP, PORT, CLIENT_IP, 50000, at[1], game[1])

    for n in range(100):  # a busy PC: other traffic, 1 MB a flow
        for k in range(4):
            stream.segment(0.2, OTHER_IP, 40000 + n, CLIENT_IP, 50000, k * MB // 4, bytes(MB // 4))
    assert held(stream) <= 32 * MB

    for i in range(2, len(game)):
        stream.segment(0.3, SERVER_IP, PORT, CLIENT_IP, 50000, at[i], game[i])

    assert stream.port == PORT
    assert got == game


def test_flows_kept_track_of_before_the_lock_are_capped():
    stream = capture.GameStream(lambda ts, pkt: None)

    for n in range(3000):
        stream.segment(0.0, OTHER_IP, 1024 + n, CLIENT_IP, 50000, 0, b"\x01\x02\x03\x04")

    assert len(stream.held) <= 1024
    assert len(stream.first_seen) <= 1024
