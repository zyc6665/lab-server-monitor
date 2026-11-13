"""v0.1.133: saving user settings starts a size scan immediately."""

from __future__ import annotations

import re
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"

PASSWORD = "admin" + "-pw-123"


class FakeMonitor:
    def __init__(self) -> None:
        self.calls: list[bool] = []

    def refresh_users(self, *, force_usage: bool = False) -> dict:
        self.calls.append(force_usage)
        return {"ok": True, "started": True, "reason": "started"}

    def user_scan_status(self) -> dict:
        return {"running": False}


def _client(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "settings.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    monitor = FakeMonitor()
    app = create_app(
        config=service.load(),
        db_path=db,
        settings_service=service,
        monitor_service=monitor,
    )
    app.config.update(TESTING=True)
    client = app.test_client()
    token = re.search(
        r'name="csrf_token" value="([^"]+)"',
        client.get("/setup").get_data(as_text=True),
    ).group(1)
    client.post(
        "/setup",
        data={
            "username": "admin",
            "password": PASSWORD,
            "confirm": PASSWORD,
            "csrf_token": token,
        },
    )
    client.post("/login", data={"username": "admin", "password": PASSWORD})
    page = client.get("/settings").get_data(as_text=True)
    csrf = re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)
    return client, monitor, csrf


def test_saving_user_monitoring_forces_a_usage_scan(tmp_path):
    client, monitor, csrf = _client(tmp_path)

    response = client.put(
        "/api/settings/user_monitoring",
        json={"usage_interval_seconds": 172800},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    assert monitor.calls == [True]


def test_saving_other_sections_does_not_force_usage(tmp_path):
    client, monitor, csrf = _client(tmp_path)

    response = client.put(
        "/api/settings/monitoring",
        json={"poll_interval_seconds": 600},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    assert monitor.calls == []


def test_refresh_endpoint_accepts_usage_flag(tmp_path):
    client, monitor, csrf = _client(tmp_path)

    response = client.post(
        "/api/users/refresh",
        json={"usage": True},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert monitor.calls == [True]


def test_plain_refresh_does_not_force_usage(tmp_path):
    client, monitor, csrf = _client(tmp_path)

    client.post("/api/users/refresh", json={}, headers={"X-CSRF-Token": csrf})

    assert monitor.calls == [False]


def test_users_page_has_a_usage_button():
    html = (TEMPLATES / "users.html").read_text(encoding="utf-8")
    assert 'id="user-refresh-usage"' in html
    assert "统计占用" in html

    script = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function refreshUsers(forceUsage)" in script
    assert "JSON.stringify({ usage: !!forceUsage })" in script
    assert "refreshUsers(true);" in script


def test_users_payload_exposes_usage_hint(tmp_path):
    client, _monitor, _csrf = _client(tmp_path)

    payload = client.get("/api/users").get_json()

    assert "usage_hint" in payload
    assert isinstance(payload["usage_hint"], str)


def test_usage_hint_banner_is_wired():
    html = (TEMPLATES / "users.html").read_text(encoding="utf-8")
    assert 'id="usage-hint"' in html

    script = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function renderUsageHint(text, scan)" in script
    assert "renderUsageHint(lastScanHint, lastScan);" in script

    style = (STATIC / "style.css").read_text(encoding="utf-8")
    assert ".usage-hint {" in style
    assert '.usage-hint[hidden] { display: none !important; }' in style
