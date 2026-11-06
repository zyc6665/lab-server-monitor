"""Tests for the :func:`servermanage.app.main` startup flow.

These tests never bind a socket, open a browser or block: every boundary
(waitress server, monitor service, tray, browser, single-instance lock and
runtime-state file) is replaced with an in-memory fake so the whole startup and
shutdown path can be asserted deterministically.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from servermanage import app
from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    DashboardConfig,
    ReportConfig,
    SSHRuntimeConfig,
)


# ---------------------------------------------------------------------------
# Helpers / fakes
# ---------------------------------------------------------------------------
def build_config(
    *,
    auto_port_fallback: bool = True,
    tray_enabled: bool = True,
    open_browser_on_start: bool = True,
    host: str = "0.0.0.0",
    port: int = 8080,
) -> AppConfig:
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Daily]"),
        servers=[],
        app=AppRuntimeConfig(
            auto_port_fallback=auto_port_fallback,
            tray_enabled=tray_enabled,
            open_browser_on_start=open_browser_on_start,
        ),
        dashboard=DashboardConfig(host=host, port=port),
    )


class _FakeLock:
    def __init__(self, acquired: bool = True) -> None:
        self.acquired = acquired
        self.release_count = 0

    def release(self) -> None:
        self.release_count += 1


class _FakeServer:
    def __init__(self) -> None:
        self.ran = False
        self.closed = False

    def run(self) -> None:
        self.ran = True

    def close(self) -> None:
        self.closed = True


class _FakeTrayHandle:
    def __init__(self) -> None:
        self.stopped = False

    def stop(self) -> None:
        self.stopped = True


def _make_service_factory(created: list):
    class _FakeService:
        def __init__(self, config, *, db_path):
            self.config = config
            self.db_path = Path(db_path)
            self.started = False
            self.stopped = False
            self.applied = []
            created.append(self)

        def start(self) -> None:
            self.started = True

        def stop(self) -> None:
            self.stopped = True

        def apply_config(self, new_config) -> None:
            self.applied.append(new_config)

    return _FakeService


def _prepare(monkeypatch, tmp_path: Path, config: AppConfig, *, port: int = 8091):
    """Patch every startup boundary and return the recorded call data."""
    rec: dict = {}

    lock = _FakeLock(True)
    rec["lock"] = lock

    def fake_acquire(path):
        rec["lock_path"] = Path(path)
        return lock

    monkeypatch.setattr(app, "configure_logging", lambda path: rec.__setitem__("log_dir", Path(path)))
    monkeypatch.setattr(app, "acquire_single_instance", fake_acquire)
    monkeypatch.setattr(app, "read_runtime_state", lambda path: rec.get("runtime_state"))

    db_path = tmp_path / "servermanage.db"

    def fake_load(config_path, dotenv_path=None):
        rec["load_called"] = True
        rec["loaded_config_path"] = Path(config_path)
        return config, db_path, object()

    monkeypatch.setattr(app, "load_runtime_with_settings", fake_load)

    port_calls: list = []

    def fake_find_available_port(host, preferred, span=20):
        port_calls.append((host, preferred, span))
        return port

    monkeypatch.setattr(app, "find_available_port", fake_find_available_port)
    rec["port_calls"] = port_calls

    services: list = []
    monkeypatch.setattr(app, "MonitorService", _make_service_factory(services))
    rec["services"] = services

    server = _FakeServer()
    rec["server"] = server

    def fake_build_server(*, config, db_path, settings, service, host, port):
        rec.update(
            built_config=config,
            built_db_path=db_path,
            built_settings=settings,
            built_service=service,
            built_host=host,
            built_port=port,
        )
        return server

    monkeypatch.setattr(app, "_build_server", fake_build_server)

    def fake_write(path, *, url, port, pid=None):
        rec.update(runtime_path=Path(path), runtime_url=url, runtime_port=port, runtime_pid=pid)

    monkeypatch.setattr(app, "write_runtime_state", fake_write)

    browser_urls: list = []
    monkeypatch.setattr(app, "open_browser", lambda url: browser_urls.append(url))
    rec["browser_urls"] = browser_urls

    timers: list = []

    class _FakeTimer:
        def __init__(self, interval, function, args=None, kwargs=None):
            self.interval = interval
            self.function = function
            self.args = list(args or [])
            self.kwargs = kwargs
            self.started = False
            timers.append(self)

        def start(self):
            self.started = True

    monkeypatch.setattr(app.threading, "Timer", _FakeTimer)
    rec["timers"] = timers

    tray_rec: dict = {}
    rec["tray"] = tray_rec

    def fake_start_tray(*, url, log_dir, on_exit, enabled=True):
        tray_rec.update(url=url, log_dir=Path(log_dir), on_exit=on_exit, enabled=enabled)
        tray_rec["handle"] = _FakeTrayHandle()
        return tray_rec["handle"]

    monkeypatch.setattr(app, "start_tray", fake_start_tray)
    return rec


# ---------------------------------------------------------------------------
# Unit-level helpers
# ---------------------------------------------------------------------------
def test_choose_port_uses_fallback_when_enabled(monkeypatch):
    monkeypatch.setattr(app, "find_available_port", lambda host, port, span=20: 9000)
    assert app.choose_port("0.0.0.0", 8080, True) == 9000


def test_choose_port_keeps_preferred_when_fallback_disabled(monkeypatch):
    def _boom(*_a, **_k):
        raise AssertionError("find_available_port must not be called")

    monkeypatch.setattr(app, "find_available_port", _boom)
    assert app.choose_port("0.0.0.0", 8080, False) == 8080


def test_dashboard_url_normalises_wildcard_host():
    assert app._dashboard_url("0.0.0.0", 8080) == "http://127.0.0.1:8080"
    assert app._dashboard_url("::", 9000) == "http://127.0.0.1:9000"
    assert app._dashboard_url("10.0.0.5", 8080) == "http://10.0.0.5:8080"


# ---------------------------------------------------------------------------
# Full non-blocking happy path
# ---------------------------------------------------------------------------
def test_main_runs_without_blocking_and_wires_all_components(monkeypatch, tmp_path):
    config = build_config()
    rec = _prepare(monkeypatch, tmp_path, config, port=8091)

    exit_code = app.main(["--config", str(tmp_path / "config.yaml")])

    assert exit_code == 0
    # Lock acquired on the bootstrap path and released in the finally block.
    assert rec["lock_path"] == app._LOCK_PATH
    assert rec["lock"].acquired is True
    assert rec["lock"].release_count == 1
    # Port probing used the configured host/preferred port.
    assert rec["port_calls"] == [("0.0.0.0", 8080, 20)]
    assert rec["built_host"] == "0.0.0.0"
    assert rec["built_port"] == 8091
    # Service lifecycle.
    service = rec["services"][0]
    assert service.started is True and service.stopped is True
    assert rec["built_service"] is service
    # Blocking server ran and was closed on shutdown.
    assert rec["server"].ran is True
    assert rec["server"].closed is True
    # runtime.json written with the actual port and a loopback URL.
    assert rec["runtime_path"] == app._RUNTIME_STATE_PATH
    assert rec["runtime_url"] == "http://127.0.0.1:8091"
    assert rec["runtime_port"] == 8091
    assert isinstance(rec["runtime_pid"], int)
    # Browser opener scheduled on a 0.8s timer, not called inline.
    assert rec["browser_urls"] == []
    assert len(rec["timers"]) == 1
    timer = rec["timers"][0]
    assert timer.interval == 0.8
    assert timer.started is True
    assert timer.args == ["http://127.0.0.1:8091"]
    assert timer.function is app.open_browser
    # Tray started after the server exists and stopped on shutdown.
    tray = rec["tray"]
    assert tray["enabled"] is True
    assert tray["url"] == "http://127.0.0.1:8091"
    assert tray["log_dir"] == Path("logs")
    assert tray["handle"].stopped is True
    # The tray exit callback closes the server (idempotent with shutdown).
    tray["on_exit"]()
    assert rec["server"].closed is True


def test_main_skips_port_probe_when_fallback_disabled(monkeypatch, tmp_path):
    config = build_config(auto_port_fallback=False)
    rec = _prepare(monkeypatch, tmp_path, config)

    def _boom(*_a, **_k):
        raise AssertionError("find_available_port must not be called")

    monkeypatch.setattr(app, "find_available_port", _boom)

    exit_code = app.main(["--config", str(tmp_path / "config.yaml")])

    assert exit_code == 0
    assert rec["built_port"] == 8080
    assert rec["runtime_url"] == "http://127.0.0.1:8080"


def test_main_port_conflict_without_fallback_returns_nonzero(monkeypatch, tmp_path):
    config = build_config(auto_port_fallback=False)
    rec = _prepare(monkeypatch, tmp_path, config)

    def _conflict(**_kwargs):
        raise OSError("port already in use")

    monkeypatch.setattr(app, "_build_server", _conflict)

    exit_code = app.main(["--config", str(tmp_path / "config.yaml")])

    assert exit_code == 1
    # Service was started before the bind failed, and still stopped cleanly.
    service = rec["services"][0]
    assert service.started is True and service.stopped is True
    assert rec["lock"].release_count == 1


def test_main_disables_tray_and_browser_when_configured(monkeypatch, tmp_path):
    config = build_config(tray_enabled=False, open_browser_on_start=False)
    rec = _prepare(monkeypatch, tmp_path, config)

    exit_code = app.main(["--config", str(tmp_path / "config.yaml")])

    assert exit_code == 0
    assert rec["tray"] == {}  # start_tray never called
    assert rec["timers"] == []  # no browser timer


# ---------------------------------------------------------------------------
# Single-instance branch
# ---------------------------------------------------------------------------
def test_main_second_instance_opens_existing_dashboard_and_exits_zero(monkeypatch, tmp_path):
    config = build_config()
    rec = _prepare(monkeypatch, tmp_path, config)
    rec["lock"].acquired = False
    rec["runtime_state"] = {"url": "http://127.0.0.1:7777", "port": 7777, "pid": 123}

    def _should_not_load(*_a, **_k):
        raise AssertionError("config must not be loaded when the lock is held")

    monkeypatch.setattr(app, "load_runtime_with_settings", _should_not_load)

    exit_code = app.main(["--config", str(tmp_path / "config.yaml")])

    assert exit_code == 0
    assert rec["browser_urls"] == ["http://127.0.0.1:7777"]
    assert rec.get("load_called") is None
    assert rec["lock"].release_count == 1


def test_main_second_instance_without_state_still_exits_zero(monkeypatch, tmp_path):
    config = build_config()
    rec = _prepare(monkeypatch, tmp_path, config)
    rec["lock"].acquired = False
    rec["runtime_state"] = None

    exit_code = app.main(["--config", str(tmp_path / "config.yaml")])

    assert exit_code == 0
    assert rec["browser_urls"] == []
    assert rec["lock"].release_count == 1


# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------
def test_main_returns_one_when_config_load_fails(monkeypatch, tmp_path):
    config = build_config()
    rec = _prepare(monkeypatch, tmp_path, config)

    def _fail(*_a, **_k):
        raise ValueError("bad config")

    monkeypatch.setattr(app, "load_runtime_with_settings", _fail)

    exit_code = app.main(["--config", str(tmp_path / "config.yaml")])

    assert exit_code == 1
    assert rec["services"] == []  # service never constructed
    assert rec["lock"].release_count == 1
