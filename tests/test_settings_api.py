"""Tests for the settings JSON API (Task 8).

Covers section saves, host CRUD, admin password rotation and the three
connectivity probes.  The ``client`` fixture mirrors the first-run setup/login
helper from ``tests/test_web_setup.py`` so every mutating request carries the
``X-CSRF-Token`` header required once a ``SettingsService`` is wired in.
"""

from __future__ import annotations

import re

import pytest

from servermanage.config import load_config_from_mapping
from servermanage.models import CommandResult
from servermanage.settings import SettingsService
from servermanage.web import create_app

ADMIN_PASSWORD = "AdminPass!23"


def _app(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    svc = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    return create_app(config=svc.load(), db_path=db, settings_service=svc)


def _csrf_from_form(page: str) -> str:
    return re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)


def _csrf_from_meta(page: str) -> str:
    return re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)


@pytest.fixture()
def client(tmp_path):
    """An authenticated test client whose mutating calls carry the CSRF header."""
    app = _app(tmp_path)
    test_client = app.test_client()
    page = test_client.get("/setup").get_data(as_text=True)
    setup = test_client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": _csrf_from_form(page),
        },
    )
    assert setup.status_code == 302
    login = test_client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    )
    assert login.status_code == 302
    token = _csrf_from_meta(test_client.get("/").get_data(as_text=True))
    test_client.environ_base["HTTP_X_CSRF_TOKEN"] = token
    return test_client


# ---------------------------------------------------------------------------
# Brief tests (with the masked-payload assertion amended per Controller note)
# ---------------------------------------------------------------------------


def test_get_settings_returns_masked_payload(client):
    # Seed a host with a known secret so "no secret leaks" is actually tested;
    # asserting the literal word "password" would trip on the public boolean
    # field name "password_configured" even when nothing leaks.
    seed = client.put(
        "/api/settings/hosts/secret-host",
        json={
            "host": "10.0.0.9",
            "port": 22,
            "username": "u",
            "auth_type": "password",
            "password": "topsecret-pw",
        },
    )
    assert seed.status_code == 200

    body = client.get("/api/settings").get_json()
    assert body["monitoring"]["poll_interval_seconds"] == 600
    assert body["writable"] is True
    assert body["setup_required"] is False
    assert body["hosts"], "the seeded host should appear in the payload"

    hosts_repr = repr(body["hosts"])
    assert "topsecret-pw" not in hosts_repr
    assert "key_data" not in hosts_repr
    assert "private_key" not in hosts_repr
    # And the secret must not leak anywhere else in the payload either.
    assert "topsecret-pw" not in repr(body)


def test_put_report_section_persists(client):
    resp = client.put("/api/settings/report", json={"daily_enabled": False})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True
    assert body["restart_required"] is False

    settings = client.get("/api/settings").get_json()
    assert settings["report"]["daily_enabled"] is False


def test_put_settings_rejected_when_not_writable(client, monkeypatch):
    monkeypatch.setattr(
        client.application.config["SETTINGS_SERVICE"],
        "is_writable",
        lambda: False,
    )
    resp = client.put("/api/settings/report", json={"daily_enabled": True})
    assert resp.status_code == 409
    assert resp.get_json() == {"error": "settings_not_writable"}


def test_host_crud(client):
    payload = {
        "host": "10.0.0.5",
        "port": 22,
        "username": "u",
        "auth_type": "password",
        "password": "pw",
    }
    assert client.put("/api/settings/hosts/edge", json=payload).status_code == 200
    listed = client.get("/api/settings/hosts").get_json()
    assert listed["hosts"][0]["name"] == "edge"
    assert listed["hosts"][0]["password_configured"] is True
    assert client.delete("/api/settings/hosts/edge").status_code == 200
    assert client.get("/api/settings/hosts").get_json()["hosts"] == []


def test_change_password_requires_current(client):
    resp = client.post(
        "/api/settings/password",
        json={"current_password": "bad", "new_password": "AdminPass!23"},
    )
    assert resp.status_code == 400
    assert "error" in resp.get_json()


# ---------------------------------------------------------------------------
# Additional coverage
# ---------------------------------------------------------------------------


def test_put_unknown_section_returns_404(client):
    resp = client.put("/api/settings/not-a-section", json={"anything": True})
    assert resp.status_code == 404


def test_settings_routes_404_without_service(tmp_path):
    # A legacy app (no SettingsService) must report "route does not exist".
    base = load_config_from_mapping(
        {"dashboard": {"auth": {"enabled": False}}}, allow_empty_servers=True
    )
    legacy = create_app(config=base, db_path=tmp_path / "legacy.db").test_client()
    assert legacy.get("/api/settings").status_code == 404
    assert legacy.put("/api/settings/report", json={"daily_enabled": False}).status_code == 404


def test_delete_unknown_host_returns_404(client):
    assert client.delete("/api/settings/hosts/missing").status_code == 404


def test_host_upsert_rejects_unknown_auth(client):
    resp = client.put(
        "/api/settings/hosts/broken",
        json={"host": "10.0.0.6", "username": "u", "auth_type": "bogus"},
    )
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_change_password_succeeds_with_current(client):
    service = client.application.config["SETTINGS_SERVICE"]
    resp = client.post(
        "/api/settings/password",
        json={
            "current_password": ADMIN_PASSWORD,
            "new_password": "NewSecret123",
        },
    )
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True}
    assert service.verify_admin("admin", "NewSecret123") is True


def test_test_ssh_reports_ok_and_failure(client, monkeypatch):
    import servermanage.web.routes as routes

    monkeypatch.setattr(
        routes.SSHClientWrapper,
        "run",
        lambda self, command, timeout: CommandResult(
            stdout="ok\n", stderr="", exit_status=0
        ),
    )
    payload = {
        "host": "10.0.0.9",
        "port": 22,
        "username": "u",
        "auth_type": "password",
        "password": "pw",
    }
    resp = client.post("/api/settings/test-ssh", json=payload)
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True, "detail": "ok\n"}

    def _boom(self, command, timeout):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(routes.SSHClientWrapper, "run", _boom)
    resp = client.post("/api/settings/test-ssh", json=payload)
    body = resp.get_json()
    assert body["ok"] is False
    assert "connection refused" in body["detail"]


def test_test_email_connects_and_logs_in_without_sending(client, monkeypatch):
    import servermanage.web.routes as routes

    calls: list[tuple] = []

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            calls.append(("connect", host, port))

        def login(self, username, password):
            calls.append(("login", username, password))

        def quit(self):
            calls.append(("quit",))

        def sendmail(self, *args, **kwargs):  # pragma: no cover - guard
            raise AssertionError("test-email must not send a message")

    monkeypatch.setattr(routes.smtplib, "SMTP", FakeSMTP)
    resp = client.post(
        "/api/settings/test-email",
        json={
            "host": "smtp.example.com",
            "port": 587,
            "username": "u",
            "password": "pw",
            "use_ssl": False,
            "from_addr": "a@example.com",
            "to_addrs": ["b@example.com"],
        },
    )
    assert resp.status_code == 200
    assert resp.get_json()["ok"] is True
    assert ("connect", "smtp.example.com", 587) in calls
    assert ("login", "u", "pw") in calls


def test_test_webhook_calls_send_once(client, monkeypatch):
    import servermanage.web.routes as routes

    calls: list[tuple] = []

    def fake_send(webhook, event):
        calls.append((webhook, event))
        return True

    monkeypatch.setattr(routes, "send_webhook", fake_send)
    resp = client.post(
        "/api/settings/test-webhook",
        json={"type": "generic", "url": "https://example.com/hook"},
    )
    assert resp.status_code == 200
    assert resp.get_json()["ok"] is True
    assert len(calls) == 1
    assert calls[0][0].url == "https://example.com/hook"
