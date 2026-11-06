"""Tests for servermanage.runtime: single-instance lock, port probing, state IO."""

from __future__ import annotations

import json
import socket

import pytest

from servermanage import runtime


def _free_port() -> int:
    """Grab an OS-assigned free TCP port, then release it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


# ---------------------------------------------------------------------------
# Single instance lock
# ---------------------------------------------------------------------------
def test_single_instance_is_mutually_exclusive(tmp_path):
    lock_path = tmp_path / "nested" / "servermonitor.lock"

    first = runtime.acquire_single_instance(lock_path)
    try:
        assert first.acquired is True
        assert lock_path.parent.is_dir()  # parent dirs created automatically

        second = runtime.acquire_single_instance(lock_path)
        try:
            assert second.acquired is False
        finally:
            second.release()
    finally:
        first.release()

    # After the first lock is released a new acquisition must succeed again.
    third = runtime.acquire_single_instance(lock_path)
    try:
        assert third.acquired is True
    finally:
        third.release()


def test_release_is_idempotent(tmp_path):
    lock = runtime.acquire_single_instance(tmp_path / "idempotent.lock")
    assert lock.acquired is True
    lock.release()
    lock.release()  # must not raise
    assert lock.acquired is False


# ---------------------------------------------------------------------------
# Port probing
# ---------------------------------------------------------------------------
def test_find_available_port_skips_occupied():
    occupied = _free_port()
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        holder.bind(("127.0.0.1", occupied))
        holder.listen(1)

        found = runtime.find_available_port("127.0.0.1", occupied, span=10)

        assert found != occupied
        assert occupied < found <= occupied + 10
        # The returned port must actually be bindable.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", found))
    finally:
        holder.close()


def test_find_available_port_returns_preferred_when_free():
    preferred = _free_port()
    assert runtime.find_available_port("127.0.0.1", preferred) == preferred


def test_find_available_port_raises_when_none_available():
    occupied = _free_port()
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        holder.bind(("127.0.0.1", occupied))
        holder.listen(1)
        with pytest.raises(OSError):
            # span covers only the single occupied port.
            runtime.find_available_port("127.0.0.1", occupied, span=1)
    finally:
        holder.close()


# ---------------------------------------------------------------------------
# Runtime state file
# ---------------------------------------------------------------------------
def test_runtime_state_roundtrip(tmp_path):
    path = tmp_path / "sub" / "runtime.json"

    runtime.write_runtime_state(path, url="http://127.0.0.1:8765", port=8765, pid=4242)
    state = runtime.read_runtime_state(path)

    assert state == {"url": "http://127.0.0.1:8765", "port": 8765, "pid": 4242}
    # File must be valid UTF-8 JSON.
    assert json.loads(path.read_text(encoding="utf-8"))["port"] == 8765


def test_runtime_state_pid_defaults_to_none(tmp_path):
    path = tmp_path / "runtime.json"
    runtime.write_runtime_state(path, url="http://127.0.0.1:9000", port=9000)
    assert runtime.read_runtime_state(path)["pid"] is None


def test_read_runtime_state_missing_returns_none(tmp_path):
    assert runtime.read_runtime_state(tmp_path / "does-not-exist.json") is None


def test_read_runtime_state_invalid_json_returns_none(tmp_path):
    path = tmp_path / "broken.json"
    path.write_text("{not valid json", encoding="utf-8")
    assert runtime.read_runtime_state(path) is None


# ---------------------------------------------------------------------------
# Browser helper
# ---------------------------------------------------------------------------
def test_open_browser_returns_true(monkeypatch):
    monkeypatch.setattr(runtime.webbrowser, "open", lambda url: True)
    assert runtime.open_browser("http://127.0.0.1:8765") is True


def test_open_browser_swallows_exceptions(monkeypatch):
    def boom(url):
        raise RuntimeError("no browser")

    monkeypatch.setattr(runtime.webbrowser, "open", boom)
    assert runtime.open_browser("http://127.0.0.1:8765") is False
