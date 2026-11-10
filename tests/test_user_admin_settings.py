"""Settings round-trip for the two v0.5.0 write switches.

The UI is only useful if the switches actually persist and come back on the
next ``GET /api/settings``; a silently dropped boolean would leave the feature
impossible to turn on (or, worse, impossible to turn off).
"""

from __future__ import annotations

import re

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app

HOST = "gpu-01"
ADMIN_PASSWORD = "admin" + "-pw-123"


def _client(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "settings.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(config=service.load(), db_path=db, settings_service=service)
    app.config.update(TESTING=True)
    client = app.test_client()
    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    assert (
        client.post(
            "/setup",
            data={
                "username": "admin",
                "password": ADMIN_PASSWORD,
                "confirm": ADMIN_PASSWORD,
                "csrf_token": token,
            },
        ).status_code
        == 302
    )
    assert (
        client.post(
            "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
        ).status_code
        == 302
    )
    meta = re.search(
        r'name="csrf-token" content="([^"]+)"', client.get("/").get_data(as_text=True)
    ).group(1)
    client.environ_base["HTTP_X_CSRF_TOKEN"] = meta
    return client


def _create_host(client) -> dict:
    payload = {
        "host": "10.0.0.1",
        "port": 22,
        "username": "monitor",
        "auth_type": "password",
        "password": "ssh" + "-pw",
        "allow_user_write": True,
        "sudo_password": "sudo" + "-pw",
    }
    response = client.put(f"/api/settings/hosts/{HOST}", json=payload)
    assert response.status_code == 200, response.get_json()
    hosts = client.get("/api/settings/hosts").get_json()["hosts"]
    return next(item for item in hosts if item["name"] == HOST)


def test_write_enabled_round_trips_through_the_settings_api(tmp_path):
    client = _client(tmp_path)
    before = client.get("/api/settings").get_json()
    assert before["user_monitoring"]["write_enabled"] is False

    response = client.put("/api/settings/user_monitoring", json={"write_enabled": True})
    assert response.status_code == 200, response.get_json()

    after = client.get("/api/settings").get_json()
    assert after["user_monitoring"]["write_enabled"] is True
    # Untouched fields keep their previous values (partial updates merge).
    assert after["user_monitoring"]["enabled"] == before["user_monitoring"]["enabled"]


def test_allow_user_write_round_trips_through_the_host_api(tmp_path):
    client = _client(tmp_path)
    entry = _create_host(client)
    assert entry["allow_user_write"] is True
    assert entry["sudo_configured"] is True

    response = client.put(
        f"/api/settings/hosts/{HOST}",
        json={
            "host": entry["host"],
            "port": entry["port"],
            "username": entry["username"],
            "auth_type": entry["auth_type"],
            "allow_user_write": False,
        },
    )
    assert response.status_code == 200, response.get_json()

    hosts = client.get("/api/settings/hosts").get_json()["hosts"]
    entry = next(item for item in hosts if item["name"] == HOST)
    assert entry["allow_user_write"] is False
    # The sudo password must survive an unrelated host edit.
    assert entry["sudo_configured"] is True
