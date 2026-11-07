"""Task 9: end-to-end desktop integration / release-verification tests.

These tests exercise the packaged desktop surface without opening a real socket
or touching the network:

* ``default_config_path`` resolves the bundled ``config/config.yaml`` inside a
  frozen (PyInstaller/packaged) executable tree.
* ``main(--headless)`` runs against a temporary app tree with the *real* config
  loader, the real ``SettingsService``/SQLite store and the real Flask app. Only
  the two blocking boundaries are replaced: ``waitress.create_server`` returns a
  non-blocking fake that captures the Flask app, and ``MonitorService`` is a fake
  with an ``apply_config`` hook. That lets us assert the ``/setup`` → 200 and
  ``/api/overview`` → 428/200 contract through Flask's test client while
  ``main()``'s full lifecycle (locks, port choice, runtime.json, shutdown) runs
  to completion.
* ``watch_parent_stdin`` fires ``server.close`` within a timeout when the parent
  stdin pipe closes (real OS pipe + daemon thread).
* the built portable ``release/服务器轮询监测工具-Windows-x64-v1.3.zip`` contains
  the required ``servermonitor/*`` entries.
"""

from __future__ import annotations

import os
import re
import threading
import time
import zipfile
from pathlib import Path

import pytest

from servermanage import app
from servermanage.runtime import read_runtime_state

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RELEASE_ZIP = PROJECT_ROOT / "release" / "服务器轮询监测工具-Windows-x64-v1.3.zip"

REQUIRED_ZIP_ENTRIES = [
    "servermonitor/servermonitor.exe",
    "servermonitor/resources/backend/servermonitor-backend.exe",
    "servermonitor/config/config.yaml",
    "servermonitor/启动.bat",
    "servermonitor/允许局域网访问.ps1",
]


# ---------------------------------------------------------------------------
# default_config_path inside a frozen app tree
# ---------------------------------------------------------------------------
def test_default_config_path_finds_bundled_config_in_frozen_tree(tmp_path, monkeypatch):
    exe = tmp_path / "resources" / "backend" / "servermonitor-backend.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")

    app_config = tmp_path / "config" / "config.yaml"
    app_config.parent.mkdir(parents=True)
    app_config.write_text("servers: []\n", encoding="utf-8")

    monkeypatch.setattr(app.sys, "frozen", True, raising=False)
    monkeypatch.setattr(app.sys, "executable", str(exe))

    # The app-root config (parents[2] of the exe) is used when the exe-dir copy
    # is absent.
    assert app.default_config_path() == app_config


# ---------------------------------------------------------------------------
# Headless main() over a real Flask app (no socket, no waitress run loop)
# ---------------------------------------------------------------------------
def _write_minimal_config(path: Path, db_path: Path, *, port: int = 18080) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "servers: []\n"
        "storage:\n"
        "  enabled: true\n"
        f"  db_path: {db_path.as_posix()!r}\n"
        "app:\n"
        "  auto_port_fallback: false\n"
        "  tray_enabled: false\n"
        "  open_browser_on_start: false\n"
        "dashboard:\n"
        "  host: 127.0.0.1\n"
        f"  port: {port}\n",
        encoding="utf-8",
    )


class _FakeLock:
    def __init__(self) -> None:
        self.acquired = True
        self.release_count = 0

    def release(self) -> None:
        self.release_count += 1


class _FakeService:
    def __init__(self, config, *, db_path):
        self.config = config
        self.db_path = Path(db_path)
        self.started = False
        self.stopped = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def apply_config(self, new_config) -> None:
        self.config = new_config


class _FakeWaitressServer:
    """Non-blocking stand-in for the waitress server handle."""

    def __init__(self, flask_app) -> None:
        self.flask_app = flask_app
        self.ran = False
        self.closed = False

    def run(self) -> None:
        self.ran = True

    def close(self) -> None:
        self.closed = True


def test_headless_main_serves_setup_and_overview_without_network(monkeypatch, tmp_path):
    import waitress

    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("SERVERMONITOR_DESKTOP", raising=False)
    # Keep logging off the global root logger and out of the (soon deleted) tmp
    # tree; main() only needs the directory to exist.
    monkeypatch.setattr(
        app,
        "configure_logging",
        lambda path: Path(path).mkdir(parents=True, exist_ok=True),
    )

    lock = _FakeLock()
    monkeypatch.setattr(app, "acquire_single_instance", lambda path: lock)

    services: list[_FakeService] = []
    monkeypatch.setattr(
        app,
        "MonitorService",
        lambda config, *, db_path: services.append(_FakeService(config, db_path=db_path))
        or services[-1],
    )

    captured: dict = {}

    def fake_create_server(flask_app, host, port):
        server = _FakeWaitressServer(flask_app)
        captured.update(server=server, host=host, port=port)
        return server

    monkeypatch.setattr(waitress, "create_server", fake_create_server)

    db_path = tmp_path / "data" / "integration.db"
    config_path = tmp_path / "config" / "config.yaml"
    _write_minimal_config(config_path, db_path)

    exit_code = app.main(["--config", str(config_path), "--headless"])

    assert exit_code == 0
    server = captured["server"]
    assert server.ran is True
    assert server.closed is True
    assert (captured["host"], captured["port"]) == ("127.0.0.1", 18080)
    assert services and services[0].started is True and services[0].stopped is True
    assert lock.release_count == 1

    # main() persisted the runtime state under the temp cwd's data/ directory.
    runtime_file = tmp_path / "data" / "runtime.json"
    assert runtime_file.exists(), "main() must write data/runtime.json"
    state = read_runtime_state(runtime_file)
    assert state["url"] == "http://127.0.0.1:18080"
    assert state["port"] == 18080

    client = server.flask_app.test_client()

    # Fresh install: /setup is reachable and /api/* is gated with 428.
    setup_response = client.get("/setup")
    assert setup_response.status_code == 200
    blocked = client.get("/api/overview")
    assert blocked.status_code == 428
    assert blocked.get_json()["error"] == "setup_required"

    # Complete first-run setup + login, after which the same endpoint is 200.
    page = setup_response.get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    password_value = "AdminPass!23"
    assert (
        client.post(
            "/setup",
            data={
                "username": "admin",
                "password": password_value,
                "confirm": password_value,
                "csrf_token": token,
            },
        ).status_code
        == 302
    )
    assert (
        client.post(
            "/login",
            data={"username": "admin", "password": password_value},
        ).status_code
        == 302
    )
    overview = client.get("/api/overview")
    assert overview.status_code == 200
    assert "hosts" in overview.get_json()


# ---------------------------------------------------------------------------
# Parent-stdin EOF → shutdown within a timeout (real pipe + daemon thread)
# ---------------------------------------------------------------------------
def test_parent_stdin_eof_closes_server_within_timeout():
    read_fd, write_fd = os.pipe()
    reader = os.fdopen(read_fd, "rb")
    closed = threading.Event()

    thread = threading.Thread(
        target=app.watch_parent_stdin,
        args=(closed.set,),
        kwargs={"stream": reader},
        daemon=True,
    )
    thread.start()
    try:
        # The watchdog must be blocked on stdin, not fire early.
        time.sleep(0.1)
        assert not closed.is_set()

        os.close(write_fd)  # Simulate the Electron parent exiting.
        assert closed.wait(timeout=5.0), "server.close was not invoked within timeout"
        thread.join(timeout=5.0)
        assert not thread.is_alive()
    finally:
        try:
            os.close(write_fd)
        except OSError:
            pass
        reader.close()


# ---------------------------------------------------------------------------
# Built portable release zip
# ---------------------------------------------------------------------------
def test_portable_release_zip_has_required_entries():
    if not RELEASE_ZIP.exists():
        pytest.skip(f"portable release zip not built: {RELEASE_ZIP}")

    with zipfile.ZipFile(RELEASE_ZIP) as archive:
        names = {name.replace("\\", "/") for name in archive.namelist()}

    missing = [entry for entry in REQUIRED_ZIP_ENTRIES if entry not in names]
    assert not missing, f"missing entries in {RELEASE_ZIP.name}: {missing}"
