"""API tests for reading and importing the local OpenSSH config."""

from __future__ import annotations

import re

import pytest

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app
from servermanage.web import routes as routes_module

ADMIN_PASSWORD = "AdminPass123!"


def _csrf_from_form(page: str) -> str:
    return re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)


def _csrf_from_meta(page: str) -> str:
    return re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=config_path, db_path=db, base_config=base)
    app = create_app(config=service.load(), db_path=db, settings_service=service)

    home = tmp_path / "home"
    ssh_dir = home / ".ssh"
    ssh_dir.mkdir(parents=True)
    (ssh_dir / "id_ed25519").write_text("key\n", encoding="utf-8")
    ssh_config = ssh_dir / "config"
    ssh_config.write_text(
        "Host *\n"
        "  User labuser\n"
        "  Port 2222\n"
        "  IdentityFile ~/.ssh/id_ed25519\n"
        "Host alpha\n"
        "  HostName 10.0.0.1\n"
        "Host beta\n"
        "  HostName 10.0.0.2\n"
        "  ProxyJump jump\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(routes_module, "_ssh_config_path", lambda: ssh_config)

    test_client = app.test_client()
    page = test_client.get("/setup").get_data(as_text=True)
    assert test_client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": _csrf_from_form(page),
        },
    ).status_code == 302
    assert test_client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    ).status_code == 302
    token = _csrf_from_meta(test_client.get("/").get_data(as_text=True))
    test_client.environ_base["HTTP_X_CSRF_TOKEN"] = token
    return test_client


def test_ssh_config_preview_reads_fixed_path(client):
    body = client.get("/api/settings/hosts/ssh-config").get_json()
    assert body["exists"] is True
    assert body["path"].replace("\\", "/").endswith(".ssh/config")
    assert [c["name"] for c in body["candidates"]] == ["alpha", "beta"]
    alpha = body["candidates"][0]
    assert alpha["username"] == "labuser"
    assert alpha["port"] == 2222
    assert alpha["key_path"].endswith("id_ed25519")
    beta = body["candidates"][1]
    assert beta["valid"] is False


def test_ssh_config_import_selected_hosts(client):
    response = client.post(
        "/api/settings/hosts/ssh-config/import", json={"names": ["alpha"]}
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body["created"] == ["alpha"]

    host = client.get("/api/settings").get_json()["hosts"][0]
    assert host["name"] == "alpha"
    assert host["port"] == 2222
    assert host["username"] == "labuser"
    assert host["auth_type"] == "key"


def test_ssh_config_import_rejects_unknown_selection(client):
    response = client.post(
        "/api/settings/hosts/ssh-config/import", json={"names": ["missing"]}
    )
    assert response.status_code == 400
    assert response.get_json()["error"] == "no_matching_hosts"
