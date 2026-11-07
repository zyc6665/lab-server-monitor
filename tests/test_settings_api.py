"""Tests for the settings JSON API (Task 8).

Covers section saves, host CRUD, admin password rotation and the three
connectivity probes.  The ``client`` fixture mirrors the first-run setup/login
helper from ``tests/test_web_setup.py`` so every mutating request carries the
``X-CSRF-Token`` header required once a ``SettingsService`` is wired in.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

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


def test_put_smtp_section_round_trips(client):
    resp = client.put(
        "/api/settings/smtp",
        json={
            "host": "smtp.example.com",
            "port": 465,
            "username": "monitor",
            "password": "smtp-secret",
            "use_ssl": True,
            "from_addr": "monitor@example.com",
            "to_addrs": "ops@example.com; lead@example.com",
        },
    )
    assert resp.status_code == 200
    payload = client.get("/api/settings").get_json()["smtp"]
    assert payload["host"] == "smtp.example.com"
    assert payload["port"] == 465
    assert payload["to_addrs"] == ["ops@example.com", "lead@example.com"]
    assert payload["password_configured"] is True
    assert "smtp-secret" not in repr(payload)


# ---------------------------------------------------------------------------
# Task 9: host import, batch test, copy, alert silences, logs and runtime
# ---------------------------------------------------------------------------

SSH_CONFIG_SAMPLE = """\
Host import-a
    HostName 10.0.0.31
    User deploy
    Port 22
    IdentityFile ~/.ssh/id_rsa

Host import-b
    HostName 10.0.0.32
    User deploy
"""

CSV_SAMPLE = (
    "name,host,port,username,auth_type,key_path\n"
    "csv-a,10.0.0.41,22,deploy,key,~/.ssh/id_rsa\n"
    "csv-b,10.0.0.42,2222,deploy,key,~/.ssh/id_rsa\n"
)


def _seed_host(client, name: str = "copy-src", *, password: str = "copy-secret") -> None:
    resp = client.put(
        f"/api/settings/hosts/{name}",
        json={
            "host": "10.0.0.51",
            "port": 22,
            "username": "u",
            "auth_type": "password",
            "password": password,
        },
    )
    assert resp.status_code == 200


def _silence_window() -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    return (
        (now - timedelta(hours=1)).isoformat(),
        (now + timedelta(hours=2)).isoformat(),
    )


def test_import_preview_parses_without_persisting(client):
    resp = client.post(
        "/api/settings/hosts/import/preview",
        json={"format": "ssh", "content": SSH_CONFIG_SAMPLE},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert set(body) == {"candidates", "errors", "warnings"}
    assert [c["name"] for c in body["candidates"]] == ["import-a", "import-b"]
    assert body["candidates"][0]["host"] == "10.0.0.31"
    assert body["candidates"][1]["username"] == "deploy"
    assert body["errors"] == []
    # A preview must never touch the host inventory.
    assert client.get("/api/settings/hosts").get_json()["hosts"] == []


def test_import_preview_rejects_unknown_format(client):
    resp = client.post(
        "/api/settings/hosts/import/preview",
        json={"format": "json", "content": "{}"},
    )
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_import_creates_hosts(client):
    resp = client.post(
        "/api/settings/hosts/import",
        json={"format": "csv", "content": CSV_SAMPLE},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["created"] == ["csv-a", "csv-b"]
    assert body["updated"] == []
    assert body["skipped"] == []
    assert body["failed"] == []
    hosts = {
        host["name"]: host
        for host in client.get("/api/settings/hosts").get_json()["hosts"]
    }
    assert set(hosts) == {"csv-a", "csv-b"}
    assert hosts["csv-b"]["port"] == 2222


def test_import_skips_existing_without_overwrite(client):
    payload = {"format": "csv", "content": CSV_SAMPLE}
    assert client.post("/api/settings/hosts/import", json=payload).status_code == 200
    again = client.post("/api/settings/hosts/import", json=payload).get_json()
    assert again["created"] == []
    assert again["skipped"] == ["csv-a", "csv-b"]


def test_import_requires_writable(client, monkeypatch):
    monkeypatch.setattr(
        client.application.config["SETTINGS_SERVICE"],
        "is_writable",
        lambda: False,
    )
    resp = client.post(
        "/api/settings/hosts/import",
        json={"format": "csv", "content": CSV_SAMPLE},
    )
    assert resp.status_code == 409
    assert resp.get_json() == {"error": "settings_not_writable"}


def test_copy_host_duplicates_entry_and_secret(client):
    _seed_host(client)
    resp = client.post(
        "/api/settings/hosts/copy-src/copy", json={"new_name": "copy-dst"}
    )
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True, "name": "copy-dst"}
    hosts = {
        host["name"]: host
        for host in client.get("/api/settings/hosts").get_json()["hosts"]
    }
    assert set(hosts) == {"copy-src", "copy-dst"}
    assert hosts["copy-dst"]["password_configured"] is True
    assert "copy-secret" not in repr(hosts)


def test_copy_unknown_source_returns_404(client):
    resp = client.post(
        "/api/settings/hosts/missing/copy", json={"new_name": "target"}
    )
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "not_found"}


def test_copy_duplicate_target_returns_400(client):
    _seed_host(client)
    _seed_host(client, "already-there", password="other")
    resp = client.post(
        "/api/settings/hosts/copy-src/copy", json={"new_name": "already-there"}
    )
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_silence_crud(client):
    starts_at, ends_at = _silence_window()
    created = client.post(
        "/api/settings/silences",
        json={
            "scope_type": "all",
            "scope": None,
            "reason": "维护窗口",
            "starts_at": starts_at,
            "ends_at": ends_at,
        },
    )
    assert created.status_code == 200
    body = created.get_json()
    assert body["ok"] is True
    assert isinstance(body["id"], int)

    active = client.get("/api/settings/silences?active_only=true").get_json()[
        "silences"
    ]
    assert [row["id"] for row in active] == [body["id"]]
    assert active[0]["reason"] == "维护窗口"

    every = client.get("/api/settings/silences?active_only=false").get_json()[
        "silences"
    ]
    assert len(every) == 1

    assert client.delete(f"/api/settings/silences/{body['id']}").status_code == 200
    assert client.get("/api/settings/silences").get_json()["silences"] == []


def test_silence_rejects_invalid_window(client):
    now = datetime.now(timezone.utc).isoformat()
    resp = client.post(
        "/api/settings/silences",
        json={
            "scope_type": "host",
            "scope": "web1",
            "reason": "x",
            "starts_at": now,
            "ends_at": now,
        },
    )
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_silence_delete_unknown_returns_404(client):
    assert client.delete("/api/settings/silences/9999").status_code == 404


def test_silence_requires_writable(client, monkeypatch):
    monkeypatch.setattr(
        client.application.config["SETTINGS_SERVICE"],
        "is_writable",
        lambda: False,
    )
    starts_at, ends_at = _silence_window()
    resp = client.post(
        "/api/settings/silences",
        json={
            "scope_type": "all",
            "scope": None,
            "reason": "x",
            "starts_at": starts_at,
            "ends_at": ends_at,
        },
    )
    assert resp.status_code == 409
    assert resp.get_json() == {"error": "settings_not_writable"}


def test_logs_returns_tail_and_clamps(client, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    (log_dir / "servermonitor.log").write_text(
        "\n".join(f"line-{index}" for index in range(1, 2101)) + "\n",
        encoding="utf-8",
    )

    body = client.get("/api/logs?lines=3").get_json()
    assert body["path"].replace("\\", "/").endswith("logs/servermonitor.log")
    assert body["text"].splitlines() == ["line-2098", "line-2099", "line-2100"]
    assert body["lines"] == body["text"]
    assert body["line_count"] == 3

    clamped = client.get("/api/logs?lines=999999").get_json()
    assert len(clamped["text"].splitlines()) == 2000
    assert clamped["line_count"] == 2000

    floored = client.get("/api/logs?lines=0").get_json()
    assert floored["text"].splitlines() == ["line-2100"]
    assert floored["line_count"] == 1


def test_logs_missing_file_returns_empty_text(client, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    resp = client.get("/api/logs")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["text"] == ""
    assert body["lines"] == ""
    assert body["line_count"] == 0


def test_runtime_missing_returns_url_null(client, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    assert client.get("/api/runtime").get_json() == {"url": None}


def test_runtime_reads_state_file(client, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "runtime.json").write_text(
        json.dumps({"url": "http://127.0.0.1:8123", "port": 8123, "pid": 4321}),
        encoding="utf-8",
    )
    assert client.get("/api/runtime").get_json() == {
        "url": "http://127.0.0.1:8123",
        "port": 8123,
        "pid": 4321,
    }


def test_new_write_apis_require_csrf(client):
    token = client.environ_base.pop("HTTP_X_CSRF_TOKEN")
    try:
        resp = client.post(
            "/api/settings/hosts/import",
            json={"format": "csv", "content": CSV_SAMPLE},
        )
        assert resp.status_code == 400
    finally:
        client.environ_base["HTTP_X_CSRF_TOKEN"] = token


def test_csrf_failure_api_returns_readable_json(client):
    token = client.environ_base.pop("HTTP_X_CSRF_TOKEN")
    try:
        resp = client.post(
            "/api/settings/hosts/import",
            json={"format": "csv", "content": CSV_SAMPLE},
        )
    finally:
        client.environ_base["HTTP_X_CSRF_TOKEN"] = token
    assert resp.status_code == 400
    body = resp.get_json()
    assert body["error"] == "csrf_failed"
    assert "刷新" in body["message"]


def test_csrf_failure_logout_still_logs_out(client):
    # No token at all: logout must never leave the user on a bare 400 page.
    resp = client.post("/logout", data={})
    assert resp.status_code == 302
    assert resp.headers["Location"].endswith("/login")
    # Session was cleared, so the dashboard is no longer reachable.
    assert client.get("/").status_code == 302



def test_session_cookie_name_isolated_by_port(tmp_path):
    from servermanage.web import create_app

    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "c.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    svc = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(
        config=svc.load(), db_path=db, settings_service=svc, session_cookie_suffix="8123"
    )
    assert app.config["SESSION_COOKIE_NAME"] == "servermonitor_session_8123"


def test_test_batch_reports_each_host_without_leaking_secrets(client, monkeypatch):
    import servermanage.web.routes as routes

    batch_secret = "batch-secret"
    _seed_host(client, "batch-host", password=batch_secret)
    monkeypatch.setattr(
        routes.SSHClientWrapper,
        "run",
        lambda self, command, timeout: CommandResult(
            stdout="ok\n", stderr="", exit_status=0
        ),
    )
    resp = client.post(
        "/api/settings/hosts/test-batch",
        json={"names": ["batch-host", "ghost"]},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    results = {item["name"]: item for item in body["results"]}
    assert results["batch-host"]["ok"] is True
    assert results["batch-host"]["detail"] == "ok"
    assert results["ghost"]["ok"] is False
    # The stored credential must never appear anywhere in the response payload.
    assert batch_secret not in repr(body)


def test_test_batch_reports_connection_failure(client, monkeypatch):
    import servermanage.web.routes as routes

    _seed_host(client, "batch-fail", password="pw")

    def _boom(self, command, timeout):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(routes.SSHClientWrapper, "run", _boom)
    resp = client.post(
        "/api/settings/hosts/test-batch", json={"names": ["batch-fail"]}
    )
    assert resp.status_code == 200
    item = resp.get_json()["results"][0]
    assert item["ok"] is False
    assert "connection refused" in item["detail"]


def test_host_import_preview_then_confirm_creates_grouped_hosts(client):
    """Task 13: preview parses without writing, confirm persists hosts + groups."""
    yaml_text = (
        "hosts:\n"
        "  - name: imp-a\n"
        "    host: 10.9.0.1\n"
        "    username: ubuntu\n"
        "    auth_type: key\n"
        "    key_path: /home/u/.ssh/id_rsa\n"
        "    group: GPU\n"
        "  - name: imp-b\n"
        "    host: 10.9.0.2\n"
        "    username: ubuntu\n"
        "    auth_type: key\n"
        "    key_path: /home/u/.ssh/id_rsa\n"
        "    group: 机房\n"
    )

    preview = client.post(
        "/api/settings/hosts/import/preview",
        json={"format": "yaml", "content": yaml_text},
    )
    assert preview.status_code == 200
    assert [c["name"] for c in preview.get_json()["candidates"]] == [
        "imp-a",
        "imp-b",
    ]
    assert client.get("/api/settings").get_json()["hosts"] == []

    imported = client.post(
        "/api/settings/hosts/import",
        json={"format": "yaml", "content": yaml_text},
    )
    assert imported.status_code == 200
    assert sorted(imported.get_json()["created"]) == ["imp-a", "imp-b"]

    hosts = {h["name"]: h for h in client.get("/api/settings").get_json()["hosts"]}
    assert hosts["imp-a"]["group"] == "GPU"
    assert hosts["imp-b"]["group"] == "机房"
