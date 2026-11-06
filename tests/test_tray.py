"""Tests for servermanage.tray: optional system-tray integration.

The tray is a best-effort convenience.  It must never raise into the main
service and must degrade to ``None`` whenever pystray/Pillow is unavailable or
disabled.
"""

from __future__ import annotations

import sys
import threading
import types

import pytest

from servermanage import tray


# ---------------------------------------------------------------------------
# Fixtures: a minimal fake pystray module so the real GUI loop never runs.
# ---------------------------------------------------------------------------
class _FakeMenuItem:
    def __init__(self, text, action, default=False):
        self.text = text
        self.action = action
        self.default = default


class _FakeMenu:
    def __init__(self, *items):
        self.items = list(items)


class _FakeIcon:
    def __init__(self, name, image, title, menu):
        self.name = name
        self.image = image
        self.title = title
        self.menu = menu
        self.started = threading.Event()
        self.stopped = False

    def run(self):
        self.started.set()

    def stop(self):
        self.stopped = True


def _install_fake_pystray(monkeypatch, *, icon_factory=_FakeIcon):
    fake = types.ModuleType("pystray")
    fake.MenuItem = _FakeMenuItem
    fake.Menu = _FakeMenu
    fake.Icon = icon_factory
    monkeypatch.setitem(sys.modules, "pystray", fake)
    return fake


def _wait_until(predicate, timeout=2.0):
    deadline = threading.Event()
    waited = 0.0
    step = 0.01
    while not predicate() and waited < timeout:
        deadline.wait(step)
        waited += step
    return predicate()


# ---------------------------------------------------------------------------
# tray_available
# ---------------------------------------------------------------------------
def test_tray_available_false_off_windows(monkeypatch):
    monkeypatch.setattr(tray.sys, "platform", "linux")
    assert tray.tray_available() is False


def test_tray_available_false_when_pystray_missing(monkeypatch):
    monkeypatch.setattr(tray.sys, "platform", "win32")
    # ``import pystray`` raises ImportError when the module entry is None.
    monkeypatch.setitem(sys.modules, "pystray", None)
    assert tray.tray_available() is False


def test_tray_available_true_with_pystray_and_pillow(monkeypatch):
    pytest.importorskip("PIL")
    monkeypatch.setattr(tray.sys, "platform", "win32")
    _install_fake_pystray(monkeypatch)
    assert tray.tray_available() is True


# ---------------------------------------------------------------------------
# start_tray
# ---------------------------------------------------------------------------
def test_start_tray_disabled_returns_none(tmp_path):
    assert (
        tray.start_tray(
            url="http://127.0.0.1:8080",
            log_dir=tmp_path,
            on_exit=lambda: None,
            enabled=False,
        )
        is None
    )


def test_start_tray_unavailable_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(tray, "tray_available", lambda: False)
    assert (
        tray.start_tray(
            url="http://127.0.0.1:8080", log_dir=tmp_path, on_exit=lambda: None
        )
        is None
    )


def test_start_tray_swallows_errors(tmp_path, monkeypatch):
    def _boom():
        raise RuntimeError("no desktop")

    monkeypatch.setattr(tray, "tray_available", _boom)
    assert (
        tray.start_tray(
            url="http://127.0.0.1:8080", log_dir=tmp_path, on_exit=lambda: None
        )
        is None
    )


def test_start_tray_builds_menu_and_daemon_thread(tmp_path, monkeypatch):
    pytest.importorskip("PIL")
    monkeypatch.setattr(tray, "tray_available", lambda: True)
    _install_fake_pystray(monkeypatch)

    handle = tray.start_tray(
        url="http://127.0.0.1:8080", log_dir=tmp_path, on_exit=lambda: None
    )
    try:
        assert handle is not None
        assert isinstance(handle, tray.TrayHandle)
        # Icon was configured with the three expected menu entries.
        labels = [item.text for item in handle.icon.menu.items]
        assert labels == ["打开看板", "打开日志目录", "退出"]
        assert handle.icon.menu.items[0].default is True
        # ``run`` executes on a daemon thread.
        assert handle.thread.daemon is True
        assert _wait_until(lambda: handle.icon.started.is_set())
        assert handle.icon.name == "servermonitor"
    finally:
        handle.stop()
    assert handle.icon.stopped is True


def test_start_tray_menu_actions(tmp_path, monkeypatch):
    pytest.importorskip("PIL")
    monkeypatch.setattr(tray, "tray_available", lambda: True)
    _install_fake_pystray(monkeypatch)

    opened: list[str] = []
    dirs: list[str] = []
    exited: list[bool] = []
    monkeypatch.setattr(tray, "open_browser", lambda url: opened.append(url))
    monkeypatch.setattr(tray, "_open_directory", lambda path: dirs.append(str(path)))

    handle = tray.start_tray(
        url="http://127.0.0.1:8080",
        log_dir=tmp_path,
        on_exit=lambda: exited.append(True),
    )
    try:
        menu = handle.icon.menu.items
        menu[0].action(handle.icon, None)
        menu[1].action(handle.icon, None)
        menu[2].action(handle.icon, None)

        assert opened == ["http://127.0.0.1:8080"]
        assert dirs == [str(tmp_path)]
        assert exited == [True]
        assert handle.icon.stopped is True
    finally:
        handle.stop()


def test_tray_handle_stop_is_idempotent(tmp_path, monkeypatch):
    pytest.importorskip("PIL")
    monkeypatch.setattr(tray, "tray_available", lambda: True)
    _install_fake_pystray(monkeypatch)

    handle = tray.start_tray(
        url="http://127.0.0.1:8080", log_dir=tmp_path, on_exit=lambda: None
    )
    assert handle is not None
    handle.stop()
    handle.stop()  # must not raise
    assert handle.icon.stopped is True
