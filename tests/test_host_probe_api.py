"""Task 5 tests: host connection probe API (v1.4)."""

from __future__ import annotations

import re
from types import SimpleNamespace

import pytest

import servermanage.web.routes as routes_module
from servermanage.config import load_config_from_mapping
from servermanage.host_probe import ProbeResult
from servermanage.settings import SettingsService
from servermanage.web import create_app

ADMIN_PASSWORD = "AdminPass!23"


def _csrf_from_form(page: str) -> str:
    return re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)


def _csrf_from_meta(page: str) -> str:
    return re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "monitor.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg, db_path=db, base_config=base)
    app = create_app(config=service.load(), db_path=db, settings_service=service)
    c = app.test_client()
    page = c.get("/setup").get_data(as_text=True)
    assert c.post("/setup", data={"username": "admin", "password": ADMIN_PASSWORD, "confirm": ADMIN_PASSWORD, "csrf_token": _csrf_from_form(page)}).status_code == 302
    assert c.post("/login", data={"username": "admin", "password": ADMIN_PASSWORD}).status_code == 302
    token = _csrf_from_meta(c.get("/").get_data(as_text=True))
    c.environ_base["HTTP_X_CSRF_TOKEN"] = token
    return c


def test_probe_requires_login(client):
    anonymous = client.application.test_client()
    response = anonymous.post("/api/settings/hosts/probe", json={"host": "10.0.0.9"})
    assert response.status_code == 401


def test_probe_maps_private_key_and_returns_fields(client, monkeypatch):
    captured = {}

    def fake_probe(candidate):
        captured["candidate"] = candidate
        return ProbeResult(ok=True, status="ok", message="ok", hostname="gpu-01", os_release="Ubuntu 24.04", kernel="6.8", cpu_cores=16, memory_total_mb=32000, mounts=[{"mountpoint": "/", "percent": 12}], storcli_available=True, storcli_path="/usr/local/bin/storcli", sudo_available=True)

    monkeypatch.setattr(routes_module.host_probe, "probe_host", fake_probe)
    response = client.post("/api/settings/hosts/probe", json={"name": "gpu-01", "host": "10.0.0.9", "port": 2222, "username": "root", "auth_type": "key", "private_key": "-----BEGIN KEY-----", "key_passphrase": "p"})
    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True and body["hostname"] == "gpu-01" and body["cpu_cores"] == 16
    cand = captured["candidate"]
    assert cand["private_key"] == "-----BEGIN KEY-----"
    assert "BEGIN KEY" not in response.get_data(as_text=True)


def test_probe_failure_is_200_with_status(client, monkeypatch):
    monkeypatch.setattr(routes_module.host_probe, "probe_host", lambda candidate: ProbeResult(ok=False, status="auth_failed", message="用户名或密码错误"))
    response = client.post("/api/settings/hosts/probe", json={"host": "10.0.0.9", "username": "root", "auth_type": "password", "password": "bad"})
    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is False and body["status"] == "auth_failed"
    assert "bad" not in response.get_data(as_text=True)


def test_probe_requires_csrf(client):
    client.environ_base.pop("HTTP_X_CSRF_TOKEN")
    response = client.post("/api/settings/hosts/probe", json={"host": "10.0.0.9"})
    assert response.status_code == 400
