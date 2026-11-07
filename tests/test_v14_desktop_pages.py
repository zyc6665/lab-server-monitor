"""End-to-end page wiring for v1.4 desktop client (Task 12)."""

from __future__ import annotations

import re

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app

ADMIN_PASSWORD = "AdminPass!23"


def _logged_in_client(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(config=service.load(), db_path=db, settings_service=service)
    client = app.test_client()
    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    assert client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": token,
        },
    ).status_code == 302
    assert client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    ).status_code == 302
    return client


def test_v14_pages_are_wired(tmp_path):
    client = _logged_in_client(tmp_path)

    overview = client.get("/").get_data(as_text=True)
    assert "主机总数" in overview
    assert 'class="sidebar"' in overview
    assert "终端" in overview

    settings = client.get("/settings").get_data(as_text=True)
    assert "连接向导" in settings
    assert "settings-wizard.js" in settings

    terminal = client.get("/terminal").get_data(as_text=True)
    assert "SSH 终端" in terminal
    assert "vendor/xterm/xterm.js" in terminal
    assert "terminal.js" in terminal
