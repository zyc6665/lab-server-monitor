"""Interactive SSH shell session management (v1.4 desktop client).

Each :class:`SshTerminalSession` owns a dedicated :class:`SSHClientWrapper` and
one Paramiko PTY channel opened via ``invoke_shell``.  A reader thread drains the
channel into a bounded output queue; a manager keeps the session registry
thread-safe, enforces the concurrent-session limit and reaps idle sessions.

Only session metadata lives here.  Terminal input/output is never logged.
"""

from __future__ import annotations

import logging
import queue
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterator

from servermanage.models import HostConfig
from servermanage.ssh_client import SSHClientWrapper

LOGGER = logging.getLogger(__name__)

DEFAULT_TERM = "xterm-256color"
DEFAULT_READ_CHUNK_SIZE = 65536


class TerminalError(Exception):
    """Base class for terminal-session failures."""


class TerminalLimitError(TerminalError):
    """Raised when the concurrent terminal-session limit is reached."""


class SessionNotFoundError(TerminalError):
    """Raised when a session id is unknown (or refers to a closed session)."""


class SessionClosedError(SessionNotFoundError):
    """Raised when operating on a session that has already closed."""


@dataclass
class SshTerminalSession:
    """State for one interactive shell session."""

    session_id: str
    host: HostConfig
    wrapper: SSHClientWrapper
    channel: Any
    output: "queue.Queue[bytes]"
    term: str
    created_at: float
    last_activity: float
    closed: bool = False
    error: str | None = None
    reader_thread: threading.Thread | None = None
    received_chunks: int = 0
    received_bytes: int = 0

    def touch(self, now: float) -> None:
        self.last_activity = now

    def send_input(self, data: str | bytes) -> None:
        """Write user input to the PTY.  Converts ``str`` to UTF-8 bytes."""
        if self.closed:
            raise SessionClosedError(f"Terminal session is closed: {self.session_id}")
        payload = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        self.channel.sendall(payload)

    def resize(self, cols: int, rows: int) -> None:
        """Resize the remote PTY (``cols`` -> width, ``rows`` -> height)."""
        if self.closed:
            raise SessionClosedError(f"Terminal session is closed: {self.session_id}")
        self.channel.resize_pty(width=cols, height=rows)

    def close(self) -> None:
        """Close the channel and the owning SSH client.  Idempotent."""
        self.closed = True
        try:
            self.channel.close()
        except Exception:  # noqa: BLE001 - never let teardown crash callers
            pass
        try:
            self.wrapper.close()
        except Exception:  # noqa: BLE001
            pass


class SshTerminalManager:
    """Thread-safe registry of interactive SSH shell sessions."""

    def __init__(
        self,
        *,
        max_sessions: int = 8,
        idle_timeout_seconds: float = 1800,
        output_queue_size: int = 256,
        term: str = DEFAULT_TERM,
        connect_timeout: int = 10,
        ssh_factory: Callable[[HostConfig], SSHClientWrapper] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sweep_interval: float = 30.0,
        read_chunk_size: int = DEFAULT_READ_CHUNK_SIZE,
        thread_join_timeout: float = 5.0,
    ) -> None:
        if max_sessions < 1:
            raise ValueError("max_sessions must be >= 1")
        if output_queue_size < 1:
            raise ValueError("output_queue_size must be >= 1")
        self.max_sessions = max_sessions
        self.idle_timeout_seconds = idle_timeout_seconds
        self.output_queue_size = output_queue_size
        self.term = term
        self.connect_timeout = connect_timeout
        self.read_chunk_size = read_chunk_size
        self.thread_join_timeout = thread_join_timeout
        self._clock = clock
        self._ssh_factory = ssh_factory or self._default_ssh_factory
        self._lock = threading.RLock()
        self._sessions: dict[str, SshTerminalSession] = {}
        self._reserved_ids: set[str] = set()
        self._pending = 0
        self._stop_event = threading.Event()
        self._sweep_interval = sweep_interval
        self._reaper_thread: threading.Thread | None = None
        if sweep_interval and sweep_interval > 0:
            self._start_reaper()

    # -- public API --------------------------------------------------------

    def create(self, host: HostConfig, cols: int = 80, rows: int = 24) -> str:
        """Open a new shell session and return its high-entropy id.

        The SSH connect/handshake happens outside the registry lock so a slow
        host never stalls output from other live sessions; a reservation keeps
        the concurrency limit exact while the connection is being established.
        """
        self.reap_idle()
        with self._lock:
            if len(self._sessions) + self._pending >= self.max_sessions:
                raise TerminalLimitError(
                    f"Terminal session limit reached ({self.max_sessions})"
                )
            session_id = self._new_session_id_locked()
            self._reserved_ids.add(session_id)
            self._pending += 1

        wrapper: SSHClientWrapper | None = None
        try:
            wrapper = self._ssh_factory(host)
            channel = wrapper.open_shell(term=self.term, width=cols, height=rows)
        except Exception:
            if wrapper is not None:
                wrapper.close()
            with self._lock:
                self._reserved_ids.discard(session_id)
                self._pending -= 1
            raise

        now = self._clock()
        session = SshTerminalSession(
            session_id=session_id,
            host=host,
            wrapper=wrapper,
            channel=channel,
            output=queue.Queue(maxsize=self.output_queue_size),
            term=self.term,
            created_at=now,
            last_activity=now,
        )
        thread = threading.Thread(
            target=self._reader_loop,
            args=(session,),
            name=f"servermanage-ssh-terminal-{session_id[:8]}",
            daemon=True,
        )
        session.reader_thread = thread
        with self._lock:
            self._reserved_ids.discard(session_id)
            self._pending -= 1
            self._sessions[session_id] = session
        thread.start()
        return session_id

    def get_session(self, session_id: str) -> SshTerminalSession | None:
        with self._lock:
            return self._sessions.get(session_id)

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._sessions)

    def send_input(self, session_id: str, data: str | bytes) -> None:
        session = self._require_session(session_id)
        session.send_input(data)
        session.touch(self._clock())

    def resize(self, session_id: str, cols: int, rows: int) -> None:
        session = self._require_session(session_id)
        session.resize(cols, rows)
        session.touch(self._clock())

    def get_output(self, session_id: str) -> list[bytes]:
        """Drain and return all chunks currently buffered for a session."""
        session = self._require_session(session_id)
        chunks: list[bytes] = []
        while True:
            try:
                chunks.append(session.output.get_nowait())
            except queue.Empty:
                break
        return chunks

    def stream(self, session_id: str) -> Iterator[bytes]:
        """Yield output chunks until the session closes and the queue drains."""
        session = self._require_session(session_id)
        while True:
            if session.closed and session.output.empty():
                return
            try:
                chunk = session.output.get(timeout=0.05)
            except queue.Empty:
                if session.closed:
                    return
                continue
            yield chunk

    def close(self, session_id: str) -> bool:
        """Close a session (channel + client) and join its reader thread."""
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        session.close()
        thread = session.reader_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=self.thread_join_timeout)
        return True

    def reap_idle(self, now: float | None = None) -> list[str]:
        """Close sessions idle for at least ``idle_timeout_seconds``.

        Returns the ids of sessions that were reaped.  Exposed for deterministic
        tests and callers that prefer their own scheduling.
        """
        current = self._clock() if now is None else now
        with self._lock:
            expired = [
                session_id
                for session_id, session in self._sessions.items()
                if current - session.last_activity >= self.idle_timeout_seconds
            ]
        return [session_id for session_id in expired if self.close(session_id)]

    def shutdown(self) -> None:
        """Stop the idle reaper and close every session (idempotent)."""
        self._stop_event.set()
        thread = self._reaper_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=self.thread_join_timeout)
        self._reaper_thread = None
        with self._lock:
            session_ids = list(self._sessions)
        for session_id in session_ids:
            self.close(session_id)

    # -- internals ---------------------------------------------------------

    def _default_ssh_factory(self, host: HostConfig) -> SSHClientWrapper:
        return SSHClientWrapper(host=host, connect_timeout=self.connect_timeout)

    def _new_session_id_locked(self) -> str:
        while True:
            candidate = secrets.token_urlsafe(32)
            if candidate not in self._sessions and candidate not in self._reserved_ids:
                return candidate

    def _require_session(self, session_id: str) -> SshTerminalSession:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise SessionNotFoundError(f"Unknown terminal session: {session_id}")
        return session

    def _reader_loop(self, session: SshTerminalSession) -> None:
        try:
            while not session.closed:
                try:
                    chunk = session.channel.recv(self.read_chunk_size)
                except socket.timeout:
                    continue
                except Exception as exc:  # noqa: BLE001 - isolate per-session errors
                    if session.closed:
                        return
                    self._mark_error(session, exc)
                    return
                if not chunk:
                    break
                self._store_output(session, chunk)
        finally:
            with self._lock:
                session.closed = True

    def _store_output(self, session: SshTerminalSession, chunk: bytes) -> None:
        with self._lock:
            session.received_chunks += 1
            session.received_bytes += len(chunk)
            session.last_activity = self._clock()
        try:
            session.output.put_nowait(chunk)
        except queue.Full:
            # Bounded queue: drop the oldest chunk so the stream stays live.
            try:
                session.output.get_nowait()
            except queue.Empty:  # pragma: no cover - consumer raced us
                pass
            try:
                session.output.put_nowait(chunk)
            except queue.Full:  # pragma: no cover - consumer raced us
                pass

    def _mark_error(self, session: SshTerminalSession, exc: BaseException) -> None:
        with self._lock:
            session.error = f"{type(exc).__name__}: {exc}"
        session.close()

    def _start_reaper(self) -> None:
        thread = threading.Thread(
            target=self._reap_loop,
            name="servermanage-ssh-terminal-reaper",
            daemon=True,
        )
        self._reaper_thread = thread
        thread.start()

    def _reap_loop(self) -> None:
        while not self._stop_event.wait(self._sweep_interval):
            try:
                self.reap_idle()
            except Exception:  # noqa: BLE001 - a reaper failure must not kill the loop
                LOGGER.exception("SSH terminal idle reaper failed")
