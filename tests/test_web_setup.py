"""Tests for first-run setup, hashed admin login, CSRF and login rate limiting.

Task 7 of the web-settings monitoring feature.  These tests exercise the new
``settings_service``-aware ``create_app`` factory, the ``/setup`` flow, the
DPAPI-backed ``verify_admin`` login path and the per-address login throttle.
"""

from __future__ import annotations

import re

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app


def _app(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    svc = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    return create_app(config=svc.load(), db_path=db, settings_service=svc)


def test_setup_required_redirects_to_setup(tmp_path):
    client = _app(tmp_path).test_client()
    resp = client.get("/")
    assert resp.status_code == 302
    assert "/setup" in resp.headers["Location"]


def test_setup_rejects_non_loopback(tmp_path):
    client = _app(tmp_path).test_client()
    resp = client.post("/setup", data={"username": "admin", "password": "AdminPass!23",
                                       "confirm": "AdminPass!23"},
                       environ_base={"REMOTE_ADDR": "10.0.0.9"})
    assert resp.status_code == 403


def test_setup_sets_password_and_then_login(tmp_path):
    client = _app(tmp_path).test_client()
    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    resp = client.post("/setup", data={"username": "admin", "password": "AdminPass!23",
                                       "confirm": "AdminPass!23", "csrf_token": token})
    assert resp.status_code == 302
    login = client.post("/login", data={"username": "admin", "password": "AdminPass!23"})
    assert login.status_code == 302
    assert "/api/overview" not in login.headers["Location"]


def test_login_rate_limited(tmp_path):
    client = _app(tmp_path).test_client()
    for _ in range(6):
        resp = client.post("/login", data={"username": "admin", "password": "bad"})
    assert resp.status_code == 429


# ---------------------------------------------------------------------------
# CSRF coverage for the service-enabled app (setup / logout / API ack)
# ---------------------------------------------------------------------------

SECRET = "AdminPass!23"


def _csrf_from_form(page: str) -> str:
    return re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)


def _csrf_from_meta(page: str) -> str:
    return re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)


def _do_setup(client) -> None:
    page = client.get("/setup").get_data(as_text=True)
    resp = client.post(
        "/setup",
        data={
            "username": "admin",
            "password": SECRET,
            "confirm": SECRET,
            "csrf_token": _csrf_from_form(page),
        },
    )
    assert resp.status_code == 302


def _do_login(client) -> None:
    resp = client.post(
        "/login", data={"username": "admin", "password": SECRET}
    )
    assert resp.status_code == 302


def test_setup_requires_csrf(tmp_path):
    app = _app(tmp_path)
    client = app.test_client()
    resp = client.post(
        "/setup",
        data={"username": "admin", "password": SECRET, "confirm": SECRET},
    )
    assert resp.status_code == 400
    service = app.config["SETTINGS_SERVICE"]
    assert service.setup_required() is True
    assert service.verify_admin("admin", SECRET) is False


def test_api_returns_428_while_setup_required(tmp_path):
    client = _app(tmp_path).test_client()
    resp = client.get("/api/overview")
    assert resp.status_code == 428
    assert resp.get_json() == {"error": "setup_required"}


def test_logout_tolerates_expired_csrf_once_service_wired(tmp_path):
    client = _app(tmp_path).test_client()
    _do_setup(client)
    _do_login(client)

    token = _csrf_from_meta(client.get("/").get_data(as_text=True))
    resp = client.post("/logout", data={"csrf_token": token})
    assert resp.status_code == 302
    assert resp.headers["Location"].endswith("/login")

    _do_login(client)
    # An expired page token must not strand the user on a bare 400 screen.
    assert client.post("/logout").status_code == 302


def test_ack_accepts_csrf_header_once_service_wired(tmp_path):
    client = _app(tmp_path).test_client()
    _do_setup(client)
    _do_login(client)

    token = _csrf_from_meta(client.get("/").get_data(as_text=True))
    ok = client.post("/api/alerts/1/ack", headers={"X-CSRF-Token": token})
    assert ok.status_code == 200
    assert ok.get_json() == {"ok": True}

    assert client.post("/api/alerts/1/ack").status_code == 400


def test_login_throttle_keys_on_forwarded_for_behind_loopback(tmp_path):
    client = _app(tmp_path).test_client()
    bad = {"username": "admin", "password": "bad"}

    for _ in range(6):
        client.post("/login", data=bad, environ_base={"HTTP_X_FORWARDED_FOR": "203.0.113.7"})
    throttled = client.post(
        "/login", data=bad, environ_base={"HTTP_X_FORWARDED_FOR": "203.0.113.7"}
    )
    assert throttled.status_code == 429

    # A different real client behind the same proxy is unaffected.
    other = client.post(
        "/login", data=bad, environ_base={"HTTP_X_FORWARDED_FOR": "203.0.113.9"}
    )
    assert other.status_code == 401


def test_login_failure_map_prunes_expired_and_caps_entries(tmp_path):
    from servermanage.web.routes import auth as auth_mod

    app = _app(tmp_path)
    with app.app_context():
        failures = auth_mod._login_failures()
        now = auth_mod.time.monotonic()
        stale = now - auth_mod._LOGIN_FAILURE_WINDOW_SECONDS - 5
        failures["1.1.1.1"] = auth_mod.deque([stale])
        failures["2.2.2.2"] = auth_mod.deque()
        auth_mod._prune_failure_map(failures, now)
        assert "1.1.1.1" not in failures
        assert "2.2.2.2" not in failures

        for i in range(auth_mod._LOGIN_FAILURE_MAX_ENTRIES + 10):
            failures[f"ip-{i}"] = auth_mod.deque([now])
        auth_mod._prune_failure_map(failures, now)
        assert len(failures) == auth_mod._LOGIN_FAILURE_MAX_ENTRIES


def test_session_cookie_secure_defaults_off_and_http_only(tmp_path):
    app = _app(tmp_path)
    assert app.config["SESSION_COOKIE_SECURE"] is False
    assert app.config["SESSION_COOKIE_HTTPONLY"] is True


def test_session_cookie_secure_enabled_by_env(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "1")
    app = _app(tmp_path)
    assert app.config["SESSION_COOKIE_SECURE"] is True
