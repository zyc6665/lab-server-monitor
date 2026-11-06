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
