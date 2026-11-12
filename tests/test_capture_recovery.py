"""Live capture opens adapters that come up after it started (a VPN's tunnel), opens again one whose
reading failed, and the helper tries again after a capture that failed. Npcap is faked."""

import io
import json
import queue
import socket
import struct
import sys
import threading
import time

import pytest

from aion2_tracker import capture, sidecar

SERVER_IP, CLIENT_IP, PORT = "10.0.0.1", "10.8.0.2", 13328


class Ether:
    """What Npcap's socket names an Ethernet adapter's frames by."""


def record(body: bytes) -> bytes:
    return bytes([len(body) + 4]) + body


def frame(seq: int, data: bytes) -> bytes:
    """An Ethernet frame with one server->client TCP segment of the game stream."""
    tcp = struct.pack("!HHIIBBHHH", PORT, 50000, seq, 0, 5 << 4, 0x18, 65535, 0, 0)
    ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(tcp) + len(data), 0, 0, 64, 6, 0,
                     socket.inet_aton(SERVER_IP), socket.inet_aton(CLIENT_IP))
    return bytes(12) + b"\x08\x00" + ip + tcp + data


class Adapter:
    def __init__(self, name: str, ip: str, index: int) -> None:
        self.name = self.description = name
        self.ips = {4: [ip]}
        self.index = index

    def is_valid(self) -> bool:
        return True


class Listener:
    """One opened adapter: hands over the frames put in, and fails every read once `gone`."""

    def __init__(self, adapter: Adapter, frames: list[bytes], gone: bool) -> None:
        self.adapter, self.gone, self.closed = adapter, gone, False
        self.frames: queue.Queue = queue.Queue()
        for f in frames:
            self.frames.put(f)

    def recv_raw(self):
        if self.gone:
            raise OSError("the adapter was removed")
        try:
            return Ether, self.frames.get(timeout=0.01), time.time()
        except queue.Empty:
            return None, None, None

    def close(self) -> None:
        self.closed = True


class Npcap:
    """scapy's `conf` as live capture uses it: the adapters, and listening on one."""

    def __init__(self, *adapters: Adapter) -> None:
        self.adapters = list(adapters)
        self.iface = adapters[0]
        self.ifaces = self
        self.opened: list[Listener] = []
        self.to_send: dict[str, list[bytes]] = {}  # adapter -> frames its next listener hands over
        self.broken: set[str] = set()  # adapters whose next listener fails its reads

    def values(self) -> list[Adapter]:
        return list(self.adapters)

    def reload(self) -> None:
        pass

    def L2listen(self, iface: Adapter, filter: str) -> Listener:
        broken = iface.name in self.broken
        self.broken.discard(iface.name)
        sock = Listener(iface, [] if broken else self.to_send.pop(iface.name, []), broken)
        self.opened.append(sock)
        return sock


def wait_for(condition, timeout: float = 5.0) -> bool:
    end = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > end:
            return False
        time.sleep(0.01)
    return True


@pytest.fixture
def capturing(monkeypatch):
    """Starts live capture on a faked Npcap; the packets it read, and the log."""
    monkeypatch.setattr(capture, "ADAPTER_SCAN_S", 0.1, raising=False)
    stop, threads, packets, logged = threading.Event(), [], [], []

    def start(npcap: Npcap) -> None:
        monkeypatch.setattr(capture, "conf", npcap)
        stream = capture.GameStream(lambda ts, pkt: packets.append(pkt), server_port=PORT)
        t = threading.Thread(target=capture.live, args=(stream,), kwargs={"stop": stop, "log": logged.append}, daemon=True)
        t.start()
        threads.append(t)

    yield start, packets, logged
    stop.set()
    for t in threads:
        t.join(timeout=5)


def test_a_tunnel_that_comes_up_after_the_capture_started_is_opened(capturing):
    start, packets, _ = capturing
    npcap = Npcap(Adapter("Ethernet", "192.168.1.2", 3))
    start(npcap)
    assert wait_for(lambda: len(npcap.opened) == 1)

    npcap.to_send["VPN"] = [frame(1000, record(b"\x99\x99hello"))]
    npcap.adapters.append(Adapter("VPN", CLIENT_IP, 17))

    assert wait_for(lambda: packets == [record(b"\x99\x99hello")])


def test_an_adapter_whose_reading_failed_is_opened_again(capturing):
    start, packets, logged = capturing
    npcap = Npcap(Adapter("Ethernet", "192.168.1.2", 3), Adapter("VPN", CLIENT_IP, 17))
    npcap.broken.add("VPN")
    npcap.to_send["VPN"] = [frame(1000, record(b"\x99\x99again"))]

    start(npcap)

    assert wait_for(lambda: any("stopped reading VPN" in line for line in logged))
    assert wait_for(lambda: packets == [record(b"\x99\x99again")])
    assert [s.adapter.name for s in npcap.opened if s.closed] == ["VPN"]


def test_a_tunnel_made_again_under_its_name_is_opened_again(capturing):
    start, packets, _ = capturing
    npcap = Npcap(Adapter("Ethernet", "192.168.1.2", 3), Adapter("VPN", CLIENT_IP, 17))
    start(npcap)
    assert wait_for(lambda: len(npcap.opened) == 2)

    npcap.to_send["VPN"] = [frame(1000, record(b"\x99\x99made again"))]
    npcap.adapters[1] = Adapter("VPN", CLIENT_IP, 18)

    assert wait_for(lambda: packets == [record(b"\x99\x99made again")])


def test_the_helper_tries_the_capture_again_after_it_failed(monkeypatch, tmp_path):
    tries, again = [], threading.Event()

    def live(stream, stop, **kwargs):
        tries.append(stream)
        if len(tries) == 1:
            raise RuntimeError("no network adapter could be opened (VPN: Error opening adapter)")
        again.set()
        stop.wait()

    def stdin():
        again.wait(5)
        yield '{"cmd": "quit"}\n'

    monkeypatch.setattr(capture, "live", live)
    monkeypatch.setattr(sidecar, "CAPTURE_RETRY_S", 0.01, raising=False)
    monkeypatch.setattr(sys, "argv", ["sidecar", "--data", str(tmp_path / "collection.json")])
    monkeypatch.setattr(sys, "stdin", stdin())
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", io.StringIO())

    sidecar.main()

    states = [ev["state"] for ev in map(json.loads, out.getvalue().splitlines()) if ev["type"] == "status"]
    assert states == ["listening", "error", "listening"]
    assert tries[0] is tries[1]  # the same stream: a lock it had carries on
