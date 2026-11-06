"""Tests for the in-browser settings page (Task 11)."""

from __future__ import annotations

import re

import pytest

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app

ADMIN_PASSWORD = "AdminPass!23"


def _app(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    return create_app(config=service.load(), db_path=db, settings_service=service)


def _csrf_from_form(page: str) -> str:
    return re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)


def _csrf_from_meta(page: str) -> str:
    return re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)


@pytest.fixture()
def client(tmp_path):
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


def test_settings_page_has_all_sections(client):
    html = client.get("/settings").get_data(as_text=True)

    for label in ["监控与存储", "主机与 SSH", "通知", "报告", "磁盘健康", "看板与安全"]:
        assert label in html
    assert 'id="settings-root"' in html
    assert "settings.js" in html
    assert "window.__SETTINGS__" in html


def test_settings_page_readonly_when_not_writable(client, monkeypatch):
    monkeypatch.setattr(
        client.application.config["SETTINGS_SERVICE"], "is_writable", lambda: False
    )

    html = client.get("/settings").get_data(as_text=True)

    assert "只读" in html
    assert "disabled" in html


def test_settings_page_renders_host_rows(tmp_path):
    app = _app(tmp_path)
    service = app.config["SETTINGS_SERVICE"]
    service.upsert_host(
        "edge",
        {
            "host": "10.0.0.5",
            "port": 22,
            "username": "ops",
            "auth_type": "key",
            "key_path": "C:/keys/edge",
            "disk_mounts": ["/", "/data"],
            "tags": ["lab"],
        },
    )
    test_client = app.test_client()
    page = test_client.get("/setup").get_data(as_text=True)
    test_client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": _csrf_from_form(page),
        },
    )
    test_client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    )

    html = test_client.get("/settings").get_data(as_text=True)

    assert "edge" in html
    assert "10.0.0.5" in html
    assert "data-host-edit=\"edge\"" in html
