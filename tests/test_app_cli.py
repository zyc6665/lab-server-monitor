"""Tests for the headless-desktop CLI additions to :mod:`servermanage.app`.

Covers the Task 1 surface: parser flags, default config-path resolution, the
parent-stdin watchdog, logging when ``sys.stderr`` is missing, and ``main()``
skipping the browser/tray in headless/desktop mode.  Every startup boundary is
replaced with an in-memory fake so nothing binds a socket, opens a browser or
blocks.
"""

from __future__ import annotations

import io
import logging
from pathlib import Path

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
    host: str = "0.0.0.0",
    port: int = 8080,
    tray_enabled: bool = True,
    open_browser_on_start: bool = True,
    auto_port_fallback: bool = True,
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
            created.append(self)

        def start(self) -> None:
            self.started = True

        def stop(self) -> None:
            self.stopped = True

        def apply_config(self, new_config) -> None:
            pass

    return _FakeService


def _prepare(monkeypatch, tmp_path: Path, config: AppConfig, *, port: int = 8091):
    """Patch every startup boundary and return the recorded call data."""
    monkeypatch.delenv("SERVERMONITOR_DESKTOP", raising=False)
    rec: dict = {}

    lock = _FakeLock(True)
    rec["lock"] = lock
    monkeypatch.setattr(app, "acquire_single_instance", lambda path: lock)
    monkeypatch.setattr(app, "read_runtime_state", lambda path: None)
    monkeypatch.setattr(
        app,
        "configure_logging",
        lambda path: rec.__setitem__("log_dir", Path(path)),
    )

    db_path = tmp_path / "servermanage.db"

    def fake_load(config_path, dotenv_path=None):
        rec["load_called"] = True
        rec["loaded_config_path"] = Path(config_path)
        return config, db_path, object()

    monkeypatch.setattr(app, "load_runtime_with_settings", fake_load)

    monkeypatch.setattr(
        app, "find_available_port", lambda host, preferred, span=20: port
    )

    services: list = []
    monkeypatch.setattr(app, "MonitorService", _make_service_factory(services))
    rec["services"] = services

    server = _FakeServer()
    rec["server"] = server

    def fake_build_server(*, config, db_path, settings, service, host, port):
        rec["built_host"] = host
        rec["built_port"] = port
        return server

    monkeypatch.setattr(app, "_build_server", fake_build_server)

    def fake_write(path, *, url, port, pid=None):
        rec["runtime_url"] = url
        rec["runtime_port"] = port

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

    threads: list = []

    class _FakeThread:
        def __init__(self, target=None, args=(), kwargs=None, daemon=None):
            self.target = target
            self.args = tuple(args)
            self.kwargs = kwargs or {}
            self.daemon = daemon
            self.started = False
            threads.append(self)

        def start(self):
            self.started = True

    monkeypatch.setattr(app.threading, "Thread", _FakeThread)
    rec["threads"] = threads

    tray_rec: dict = {}
    rec["tray"] = tray_rec

    def fake_start_tray(*, url, log_dir, on_exit, enabled=True):
        tray_rec.update(url=url, log_dir=Path(log_dir), on_exit=on_exit, enabled=enabled)
        tray_rec["handle"] = _FakeTrayHandle()
        return tray_rec["handle"]

    monkeypatch.setattr(app, "start_tray", fake_start_tray)
    return rec


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------
def test_build_parser_accepts_headless_and_parent_stdin():
    args = app.build_parser().parse_args(["--headless", "--parent-stdin"])

    assert args.headless is True
    assert args.parent_stdin is True
    assert args.config is None


def test_build_parser_accepts_start_hidden_as_noop():
    args = app.build_parser().parse_args(["--start-hidden"])

    assert args.start_hidden is True
    assert args.config is None


# ---------------------------------------------------------------------------
# Default config path
# ---------------------------------------------------------------------------
def test_default_config_path_uses_repo_config_in_dev(monkeypatch):
    monkeypatch.delattr(app.sys, "frozen", raising=False)

    path = app.default_config_path()

    expected = Path(app.__file__).resolve().parents[1] / "config" / "config.yaml"
    assert path == expected
    assert path.parts[-2:] == ("config", "config.yaml")


def test_default_config_path_uses_executable_tree_when_frozen(monkeypatch, tmp_path):
    exe = tmp_path / "resources" / "backend" / "servermonitor-backend.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")
    monkeypatch.setattr(app.sys, "frozen", True, raising=False)
    monkeypatch.setattr(app.sys, "executable", str(exe))

    # The app-root config (parents[2] of the exe) is used when the exe-dir copy
    # is absent.
    app_config = tmp_path / "config" / "config.yaml"
    app_config.parent.mkdir(parents=True)
    app_config.write_text("servers: []\n", encoding="utf-8")
    assert app.default_config_path() == app_config

    # When the executable's own config dir exists it takes precedence.
    exe_config = exe.parent / "config" / "config.yaml"
    exe_config.parent.mkdir(parents=True)
    exe_config.write_text("servers: []\n", encoding="utf-8")
    assert app.default_config_path() == exe_config

    # No candidate exists: fall back to the first (exe-dir) candidate.
    exe_config.unlink()
    app_config.unlink()
    assert app.default_config_path() == exe.parent / "config" / "config.yaml"


# ---------------------------------------------------------------------------
# Parent-stdin watchdog
# ---------------------------------------------------------------------------
def test_watch_parent_stdin_calls_on_eof():
    calls: list = []

    app.watch_parent_stdin(lambda: calls.append(1), stream=io.BytesIO(b""))

    assert calls == [1]


def test_watch_parent_stdin_reads_until_eof_then_fires():
    stream = io.BytesIO(b"keepalive")
    calls: list = []

    app.watch_parent_stdin(lambda: calls.append(1), stream=stream)

    assert calls == [1]
    assert stream.read() == b""


# ---------------------------------------------------------------------------
# Logging safety
# ---------------------------------------------------------------------------
def test_configure_logging_tolerates_missing_stderr(monkeypatch, tmp_path):
    root = logging.getLogger()
    handlers_before = list(root.handlers)
    level_before = root.level
    monkeypatch.setattr(app, "_LOGGING_CONFIGURED", False)
    monkeypatch.setattr(app.sys, "stderr", None)

    log_dir = tmp_path / "logs"
    try:
        app.configure_logging(log_dir)
    finally:
        for handler in list(root.handlers):
            if handler not in handlers_before:
                root.removeHandler(handler)
                handler.close()
        root.setLevel(level_before)

    assert (log_dir / "servermonitor.log").exists()


# ---------------------------------------------------------------------------
# main() headless / desktop behaviour
# ---------------------------------------------------------------------------
def test_headless_skips_browser_and_tray(monkeypatch, tmp_path):
    config = build_config(host="0.0.0.0")
    rec = _prepare(monkeypatch, tmp_path, config, port=8091)

    exit_code = app.main(["--config", str(tmp_path / "config.yaml"), "--headless"])

    assert exit_code == 0
    assert rec["server"].ran is True
    assert rec["browser_urls"] == []
    assert rec["timers"] == []
    assert rec["tray"] == {}


def test_headless_service_may_bind_lan_host(monkeypatch, tmp_path):
    # R1: a plain --headless CLI service is not restricted to loopback.
    config = build_config(host="10.0.0.5")
    rec = _prepare(monkeypatch, tmp_path, config)

    exit_code = app.main(["--config", str(tmp_path / "config.yaml"), "--headless"])

    assert exit_code == 0
    assert rec["built_host"] == "10.0.0.5"
    assert rec["server"].ran is True


def test_desktop_mode_rejects_non_loopback_host(monkeypatch, tmp_path):
    config = build_config(host="10.0.0.5")
    rec = _prepare(monkeypatch, tmp_path, config)
    monkeypatch.setenv("SERVERMONITOR_DESKTOP", "1")

    exit_code = app.main(["--config", str(tmp_path / "config.yaml")])

    assert exit_code == 2
    assert rec["server"].ran is False
    assert rec["lock"].release_count == 1


def test_desktop_mode_skips_browser_and_tray(monkeypatch, tmp_path):
    config = build_config(host="127.0.0.1")
    rec = _prepare(monkeypatch, tmp_path, config)
    monkeypatch.setenv("SERVERMONITOR_DESKTOP", "1")

    exit_code = app.main(["--config", str(tmp_path / "config.yaml")])

    assert exit_code == 0
    assert rec["server"].ran is True
    assert rec["browser_urls"] == []
    assert rec["tray"] == {}


def test_parent_stdin_starts_shutdown_thread(monkeypatch, tmp_path):
    config = build_config(host="0.0.0.0")
    rec = _prepare(monkeypatch, tmp_path, config)

    exit_code = app.main(
        [
            "--config",
            str(tmp_path / "config.yaml"),
            "--headless",
            "--parent-stdin",
        ]
    )

    assert exit_code == 0
    assert len(rec["threads"]) == 1
    thread = rec["threads"][0]
    assert thread.daemon is True
    assert thread.started is True
    assert thread.target is app.watch_parent_stdin
    assert thread.args == (rec["server"].close,)
