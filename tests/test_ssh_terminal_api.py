"""Tests for the desktop-only SSH terminal HTTP API (Task 4, v1.4).

The browser cannot open a raw socket, so the terminal is exposed as a small
JSON+SSE API on the existing Flask app:

* ``POST   /api/ssh/sessions``              – open a session
* ``POST   /api/ssh/sessions/<id>/input``   – forward keystrokes
* ``POST   /api/ssh/sessions/<id>/resize``  – resize the PTY
* ``DELETE /api/ssh/sessions/<id>``         – close the session
* ``GET    /api/ssh/sessions/<id>/stream``  – Server-Sent Events output

The terminal is deliberately restricted to a loopback request *and* a desktop
launch (``SERVERMONITOR_DESKTOP == "1"``); a remote browser or a headless
launch must never be able to reach a server shell.  These tests replace the
real :class:`SshTerminalManager` with a fake so no SSH connection is attempted.
"""

from __future__ import annotations

import base64
import inspect
import re
from types import SimpleNamespace

import pytest

import servermanage.app as app_module
import servermanage.web.routes as routes_module
from servermanage import storage
from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app

ADMIN_PASSWORD = "AdminPass!23"
HOST_NAME = "gpu-01"


class FakeManager:
    """In-memory stand-in for :class:`servermanage.ssh_terminal.SshTerminalManager`."""

    def __init__(self) -> None:
        self.created: list[tuple[object, int, int]] = []
        self.inputs: list[tuple[str, object]] = []
        self.resizes: list[tuple[str, int, int]] = []
        self.closed: list[str] = []
        self.session_id = "sess-1"
        self.stream_chunks: list[bytes] = [b"hello", b"world"]
        self.stream_error: BaseException | None = None
        self.shutdown_called = False

    def create(self, host, cols: int = 80, rows: int = 24) -> str:  # noqa: ANN001
        self.created.append((host, cols, rows))
        return self.session_id

    def get_session(self, session_id: str):  # noqa: ANN201
        return object() if session_id == self.session_id else None

    def send_input(self, session_id: str, data) -> None:  # noqa: ANN001
        self.inputs.append((session_id, data))

    def resize(self, session_id: str, cols: int, rows: int) -> None:
        self.resizes.append((session_id, cols, rows))

    def close(self, session_id: str) -> bool:
        self.closed.append(session_id)
        return True

    def stream(self, session_id: str):
        for chunk in self.stream_chunks:
            yield chunk
        if self.stream_error is not None:
            raise self.stream_error

    def shutdown(self) -> None:
        self.shutdown_called = True


def _csrf_from_form(page: str) -> str:
    return re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)


def _csrf_from_meta(page: str) -> str:
    return re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)


def _build_app(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db_path = tmp_path / "monitor.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db_path, base_config=base)
    app = create_app(config=service.load(), db_path=db_path, settings_service=service)
    return app, db_path


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """An authenticated desktop client with a seeded host and a fake manager."""
    monkeypatch.setenv("SERVERMONITOR_DESKTOP", "1")
    app, db_path = _build_app(tmp_path)
    client = app.test_client()

    page = client.get("/setup").get_data(as_text=True)
    setup = client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": _csrf_from_form(page),
        },
    )
    assert setup.status_code == 302

    login = client.post(
        "/login",
        data={"username": "admin", "password": ADMIN_PASSWORD},
    )
    assert login.status_code == 302

    token = _csrf_from_meta(client.get("/").get_data(as_text=True))
    client.environ_base["HTTP_X_CSRF_TOKEN"] = token

    seeded = client.put(
        f"/api/settings/hosts/{HOST_NAME}",
        json={
            "host": "10.0.0.51",
            "port": 22,
            "username": "root",
            "auth_type": "password",
            "password": "server-secret",
        },
    )
    assert seeded.status_code == 200

    manager = FakeManager()
    app.extensions["ssh_terminal"] = manager
    return SimpleNamespace(
        app=app,
        client=client,
        db_path=db_path,
        manager=manager,
        token=token,
    )


def _open_session(env, *, cols: int = 100, rows: int = 40):
    response = env.client.post(
        "/api/ssh/sessions",
        json={"host_name": HOST_NAME, "cols": cols, "rows": rows},
    )
    assert response.status_code == 201
    return response.get_json()["session_id"]


# ---------------------------------------------------------------------------
# Authentication / locality / desktop guards
# ---------------------------------------------------------------------------


def test_all_endpoints_require_login(env):
    anonymous = env.app.test_client()
    endpoints = [
        ("post", "/api/ssh/sessions", {"host_name": HOST_NAME}),
        ("post", "/api/ssh/sessions/sess-1/input", {"data": "ls\n"}),
        ("post", "/api/ssh/sessions/sess-1/resize", {"cols": 80, "rows": 24}),
        ("delete", "/api/ssh/sessions/sess-1", None),
        ("get", "/api/ssh/sessions/sess-1/stream", None),
    ]
    for method, path, payload in endpoints:
        response = getattr(anonymous, method)(path, json=payload) if payload is not None else getattr(anonymous, method)(path)
        assert response.status_code == 401, (method, path, response.status_code)
        body = response.get_json()
        assert body is not None and body.get("error") == "unauthorized"


def test_non_loopback_request_is_forbidden(env):
    response = env.client.post(
        "/api/ssh/sessions",
        json={"host_name": HOST_NAME, "cols": 80, "rows": 24},
        environ_base={"REMOTE_ADDR": "10.9.9.9"},
    )
    assert response.status_code == 403
    assert env.manager.created == []


def test_non_desktop_launch_is_forbidden(env, monkeypatch):
    monkeypatch.delenv("SERVERMONITOR_DESKTOP", raising=False)
    response = env.client.post(
        "/api/ssh/sessions",
        json={"host_name": HOST_NAME, "cols": 80, "rows": 24},
    )
    assert response.status_code == 403
    assert env.manager.created == []


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


def test_create_session_returns_id_and_writes_audit_start(env):
    session_id = _open_session(env, cols=100, rows=40)

    assert session_id == "sess-1"
    assert len(env.manager.created) == 1
    host, cols, rows = env.manager.created[0]
    assert host.name == HOST_NAME
    assert host.username == "root"
    assert (cols, rows) == (100, 40)

    rows_db = storage.list_ssh_sessions(env.db_path)
    assert len(rows_db) == 1
    audit = rows_db[0]
    assert audit["host_name"] == HOST_NAME
    assert audit["username"] == "admin"
    assert audit["server_username"] == "root"
    assert audit["remote_addr"] == "127.0.0.1"
    assert audit["status"] == "active"
    assert audit["ended_at"] is None


def test_create_session_rejects_unknown_host(env):
    response = env.client.post(
        "/api/ssh/sessions",
        json={"host_name": "missing", "cols": 80, "rows": 24},
    )
    assert response.status_code == 404
    assert env.manager.created == []


def test_input_is_forwarded(env):
    _open_session(env)
    response = env.client.post(
        "/api/ssh/sessions/sess-1/input", json={"data": "ls -la\n"}
    )
    assert response.status_code == 204
    assert env.manager.inputs == [("sess-1", "ls -la\n")]


def test_input_without_csrf_is_rejected(env):
    _open_session(env)
    token = env.client.environ_base.pop("HTTP_X_CSRF_TOKEN")
    try:
        response = env.client.post(
            "/api/ssh/sessions/sess-1/input", json={"data": "ls\n"}
        )
    finally:
        env.client.environ_base["HTTP_X_CSRF_TOKEN"] = token
    assert response.status_code == 400
    assert env.manager.inputs == []


def test_resize_is_forwarded(env):
    _open_session(env)
    response = env.client.post(
        "/api/ssh/sessions/sess-1/resize", json={"cols": 120, "rows": 50}
    )
    assert response.status_code == 204
    assert env.manager.resizes == [("sess-1", 120, 50)]


def test_delete_closes_session_and_writes_audit_end(env):
    _open_session(env)
    response = env.client.delete("/api/ssh/sessions/sess-1")
    assert response.status_code == 204
    assert env.manager.closed == ["sess-1"]

    audit = storage.list_ssh_sessions(env.db_path)[0]
    assert audit["status"] == "closed"
    assert audit["ended_at"] is not None


# ---------------------------------------------------------------------------
# Server-Sent Events output
# ---------------------------------------------------------------------------


def test_stream_is_sse_with_base64_chunks(env):
    _open_session(env)
    response = env.client.get("/api/ssh/sessions/sess-1/stream")
    assert response.status_code == 200
    assert response.content_type.startswith("text/event-stream")

    body = response.get_data()
    frames = [frame for frame in body.split(b"\n\n") if frame]
    assert frames, body
    assert frames[0].startswith(b"data: ")
    payload = frames[0][len(b"data: "):]
    assert base64.b64decode(payload) == b"hello"
    assert env.manager.closed == ["sess-1"]


def test_stream_error_closes_session_and_audits_error(env):
    _open_session(env)
    env.manager.stream_error = RuntimeError("ssh dropped")

    response = env.client.get("/api/ssh/sessions/sess-1/stream")
    # The generator catches the failure so the client still gets a clean close.
    list(response.response)

    assert env.manager.closed == ["sess-1"]
    audit = storage.list_ssh_sessions(env.db_path)[0]
    assert audit["status"] == "error"
    assert audit["error"] is not None
    assert "RuntimeError" in audit["error"]


# ---------------------------------------------------------------------------
# Waitress server configuration
# ---------------------------------------------------------------------------


def test_build_server_sets_threads_and_channel_timeout(tmp_path, monkeypatch):
    import waitress

    db_path = tmp_path / "monitor.db"
    config = load_config_from_mapping({}, allow_empty_servers=True)

    captured: dict[str, object] = {}

    class FakeServer:
        def __init__(self, application):
            self.application = application
            self.closed = False

        def close(self) -> None:
            self.closed = True

    def fake_create_server(application, **kwargs):
        captured["application"] = application
        captured["kwargs"] = kwargs
        return FakeServer(application)

    fake_manager = FakeManager()
    monkeypatch.setattr(waitress, "create_server", fake_create_server)
    monkeypatch.setattr(
        routes_module, "get_ssh_terminal_manager", lambda app: fake_manager
    )

    service = SimpleNamespace(apply_config=lambda cfg: None)
    server = app_module._build_server(
        config=config,
        db_path=db_path,
        settings=None,
        service=service,
        host="127.0.0.1",
        port=8123,
    )

    kwargs = captured["kwargs"]
    assert kwargs["threads"] == 32
    assert kwargs["channel_timeout"] == 3600
    assert kwargs["host"] == "127.0.0.1"
    assert kwargs["port"] == 8123

    # The source carries the literal design values so a regression is obvious.
    source = inspect.getsource(app_module._build_server)
    assert "threads=32" in source
    assert "channel_timeout=3600" in source

    server.close()
    assert fake_manager.shutdown_called is True
    assert server.closed is True
