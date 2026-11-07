from __future__ import annotations

import queue
import re
import socket
import threading
import time

import pytest

from servermanage.models import AuthConfig, HostConfig
from servermanage.ssh_client import SSHClientWrapper
from servermanage.ssh_terminal import (
    SessionNotFoundError,
    SshTerminalManager,
    TerminalLimitError,
)


def _host(name: str = "gpu-01") -> HostConfig:
    return HostConfig(
        name=name,
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="key", key_path="/tmp/id_rsa"),
    )


class FakeTransport:
    def __init__(self) -> None:
        self.keepalive = None
        self.keepalive_calls: list[int] = []

    def set_keepalive(self, interval: int) -> None:
        self.keepalive = interval
        self.keepalive_calls.append(interval)


class FakeChannel:
    """Minimal Paramiko channel double.

    ``recv`` blocks for a very short time to mimic a real channel timeout, then
    raises ``socket.timeout`` so the reader loop keeps polling.  Feed data with
    :meth:`feed`; end the stream with :meth:`finish`.
    """

    def __init__(self) -> None:
        self.incoming: queue.Queue[bytes] = queue.Queue()
        self.closed = False
        self.eof = False
        self.error: BaseException | None = None
        self.timeout: float | None = None
        self.timeout_calls: list[float] = []
        self.sent: list[bytes] = []
        self.resize_calls: list[tuple[int, int]] = []
        self.recv_calls = 0

    def settimeout(self, value: float | None) -> None:
        self.timeout = value
        self.timeout_calls.append(value)

    def recv(self, nbytes: int) -> bytes:
        self.recv_calls += 1
        if self.closed:
            return b""
        try:
            return self.incoming.get_nowait()
        except queue.Empty:
            pass
        if self.error is not None:
            raise self.error
        if self.eof:
            return b""
        try:
            return self.incoming.get(timeout=0.02)
        except queue.Empty:
            if self.error is not None:
                raise self.error
            if self.eof:
                return b""
            raise socket.timeout("timed out")

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def resize_pty(
        self,
        width: int = 80,
        height: int = 24,
        width_pixels: int = 0,
        height_pixels: int = 0,
    ) -> None:
        self.resize_calls.append((width, height))

    def close(self) -> None:
        self.closed = True

    # -- test helpers -----------------------------------------------------
    def feed(self, data: bytes) -> None:
        self.incoming.put(data)

    def finish(self) -> None:
        self.eof = True


class FakeSSHClient:
    def __init__(self) -> None:
        self.transport = FakeTransport()
        self.channels: list[FakeChannel] = []
        self.invoke_calls: list[tuple[str, int, int]] = []
        self.connect_calls = 0
        self.closed = False

    def set_missing_host_key_policy(self, _policy) -> None:
        return None

    def connect(self, **kwargs) -> None:
        self.connect_calls += 1
        self.kwargs = kwargs

    def get_transport(self) -> FakeTransport:
        return self.transport

    def invoke_shell(self, term: str = "xterm", width: int = 80, height: int = 24):
        self.invoke_calls.append((term, width, height))
        channel = FakeChannel()
        self.channels.append(channel)
        return channel

    def close(self) -> None:
        self.closed = True


class FakeParamiko:
    """Builds a fresh ``SSHClientWrapper`` per session, like production."""

    def __init__(self) -> None:
        self.clients: list[FakeSSHClient] = []

    def ssh_factory(self, host: HostConfig) -> SSHClientWrapper:
        client = FakeSSHClient()
        self.clients.append(client)
        return SSHClientWrapper(
            host=host,
            connect_timeout=10,
            client_factory=lambda: client,
        )

    def channel(self, index: int = 0) -> FakeChannel:
        return self.clients[index].channels[0]


def _wait_until(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met before timeout")


# ---------------------------------------------------------------------------
# SSHClientWrapper.open_shell
# ---------------------------------------------------------------------------


def test_open_shell_invokes_shell_with_term_size_and_keepalive():
    client = FakeSSHClient()
    wrapper = SSHClientWrapper(
        host=_host(),
        connect_timeout=10,
        client_factory=lambda: client,
        keepalive_interval=45,
        shell_timeout=2.5,
    )

    channel = wrapper.open_shell(term="xterm-256color", width=120, height=30)

    assert channel is client.channels[0]
    assert client.invoke_calls == [("xterm-256color", 120, 30)]
    assert client.transport.keepalive == 45
    assert channel.timeout == 2.5
    assert isinstance(channel, FakeChannel)


def test_open_shell_reuses_connection():
    client = FakeSSHClient()
    wrapper = SSHClientWrapper(
        host=_host(), connect_timeout=10, client_factory=lambda: client
    )

    wrapper.open_shell(width=100, height=40)
    wrapper.open_shell(width=100, height=40)

    assert client.connect_calls == 1
    assert len(client.channels) == 2


# ---------------------------------------------------------------------------
# SshTerminalManager
# ---------------------------------------------------------------------------


def _manager(**kwargs) -> tuple[SshTerminalManager, FakeParamiko]:
    fake = FakeParamiko()
    defaults = dict(
        max_sessions=8,
        idle_timeout_seconds=1800,
        output_queue_size=256,
        sweep_interval=0,
        ssh_factory=fake.ssh_factory,
    )
    defaults.update(kwargs)
    return SshTerminalManager(**defaults), fake


def test_create_returns_high_entropy_id_and_starts_reader():
    manager, fake = _manager()
    try:
        session_id = manager.create(_host(), cols=120, rows=30)

        assert re.fullmatch(r"[A-Za-z0-9_-]{32,}", session_id)
        assert session_id != manager.create(_host("gpu-02"), cols=80, rows=24)

        session = manager.get_session(session_id)
        assert session is not None
        assert session.reader_thread is not None
        assert session.reader_thread.is_alive()
        assert fake.clients[0].invoke_calls == [("xterm-256color", 120, 30)]
        assert manager.active_count == 2
    finally:
        manager.shutdown()


def test_create_raises_when_max_sessions_reached():
    manager, fake = _manager(max_sessions=2)
    try:
        manager.create(_host("h1"), cols=80, rows=24)
        manager.create(_host("h2"), cols=80, rows=24)

        with pytest.raises(TerminalLimitError):
            manager.create(_host("h3"), cols=80, rows=24)
    finally:
        manager.shutdown()


def test_send_input_writes_bytes_to_channel():
    manager, fake = _manager()
    try:
        session_id = manager.create(_host(), cols=80, rows=24)
        manager.send_input(session_id, "ls -la\r")

        assert fake.channel().sent == [b"ls -la\r"]

        with pytest.raises(SessionNotFoundError):
            manager.send_input("missing-session", "x")
    finally:
        manager.shutdown()


def test_resize_calls_resize_pty_with_cols_rows():
    manager, fake = _manager()
    try:
        session_id = manager.create(_host(), cols=80, rows=24)
        manager.resize(session_id, 100, 40)

        assert fake.channel().resize_calls == [(100, 40)]
    finally:
        manager.shutdown()


def test_close_closes_channel_and_client_and_joins_reader():
    manager, fake = _manager()
    session_id = manager.create(_host(), cols=80, rows=24)
    session = manager.get_session(session_id)
    reader = session.reader_thread

    assert manager.close(session_id) is True
    assert session.closed is True
    assert fake.channel().closed is True
    assert fake.clients[0].closed is True
    assert reader.is_alive() is False
    assert manager.get_session(session_id) is None
    assert manager.active_count == 0
    assert manager.close(session_id) is False

    manager.shutdown()


def test_get_output_returns_queued_chunks_and_drains():
    manager, fake = _manager()
    try:
        session_id = manager.create(_host(), cols=80, rows=24)
        channel = fake.channel()
        channel.feed(b"hello ")
        channel.feed(b"world")
        channel.finish()
        _wait_until(lambda: manager.get_session(session_id).closed)

        chunks = manager.get_output(session_id)
        assert b"".join(chunks) == b"hello world"
        assert manager.get_output(session_id) == []
    finally:
        manager.shutdown()


def test_stream_yields_chunks_until_session_closes():
    manager, fake = _manager()
    try:
        session_id = manager.create(_host(), cols=80, rows=24)
        channel = fake.channel()
        channel.feed(b"one")
        channel.feed(b"two")
        channel.finish()
        _wait_until(lambda: manager.get_session(session_id).closed)

        assert list(manager.stream(session_id)) == [b"one", b"two"]
    finally:
        manager.shutdown()


def test_output_queue_drops_oldest_when_full():
    manager, fake = _manager(output_queue_size=2)
    try:
        session_id = manager.create(_host(), cols=80, rows=24)
        channel = fake.channel()
        channel.feed(b"A")
        channel.feed(b"B")
        channel.feed(b"C")
        _wait_until(
            lambda: manager.get_session(session_id).received_chunks >= 3
            and manager.get_session(session_id).output.qsize() == 2
        )

        assert manager.get_output(session_id) == [b"B", b"C"]
    finally:
        manager.shutdown()


def test_channel_read_exception_marks_session_closed_with_error():
    manager, fake = _manager()
    try:
        session_id = manager.create(_host(), cols=80, rows=24)
        fake.channel().error = RuntimeError("channel boom")

        _wait_until(lambda: manager.get_session(session_id).closed)
        session = manager.get_session(session_id)
        assert session.error is not None
        assert "RuntimeError" in session.error
        assert "channel boom" in session.error
        # The manager keeps working after a broken session.
        assert manager.create(_host("gpu-02"), cols=80, rows=24)
    finally:
        manager.shutdown()


def test_reap_idle_closes_expired_sessions():
    now = [1000.0]
    fake = FakeParamiko()
    manager = SshTerminalManager(
        max_sessions=8,
        idle_timeout_seconds=10,
        output_queue_size=16,
        sweep_interval=0,
        ssh_factory=fake.ssh_factory,
        clock=lambda: now[0],
    )
    try:
        stale_id = manager.create(_host("stale"), cols=80, rows=24)
        now[0] += 4
        fresh_id = manager.create(_host("fresh"), cols=80, rows=24)
        now[0] += 7  # stale is 11s idle, fresh is 7s idle

        reaped = manager.reap_idle()

        assert reaped == [stale_id]
        assert manager.get_session(stale_id) is None
        assert manager.get_session(fresh_id) is not None
        assert fake.clients[0].closed is True
    finally:
        manager.shutdown()


def test_idle_timeout_reaps_on_create():
    now = [500.0]
    fake = FakeParamiko()
    manager = SshTerminalManager(
        max_sessions=8,
        idle_timeout_seconds=10,
        output_queue_size=16,
        sweep_interval=0,
        ssh_factory=fake.ssh_factory,
        clock=lambda: now[0],
    )
    try:
        stale_id = manager.create(_host("stale"), cols=80, rows=24)
        now[0] += 20
        manager.create(_host("fresh"), cols=80, rows=24)

        assert manager.get_session(stale_id) is None
        assert manager.active_count == 1
    finally:
        manager.shutdown()


def test_send_input_to_closed_session_raises():
    manager, fake = _manager()
    try:
        session_id = manager.create(_host(), cols=80, rows=24)
        session = manager.get_session(session_id)
        session.closed = True

        with pytest.raises(SessionNotFoundError):
            manager.send_input(session_id, "x")
    finally:
        manager.shutdown()
