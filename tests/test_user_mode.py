"""Tests for the admin/user view mode (0.4.0).

The mode is a client-side role: in user mode the UI and the HTTP surface only
expose the signed-in person's own accounts. It is explicitly *not* a security
boundary, so these tests assert the gate, the payload filtering and the
settings round-trip rather than any privilege separation.
"""

from __future__ import annotations

import re
from dataclasses import replace
from pathlib import Path

import pytest

from servermanage import usermode
from servermanage.config import ConfigError, load_config
from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DashboardAuthConfig,
    DashboardConfig,
    HostConfig,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.settings import SettingsError
from servermanage.storage import (
    save_host_user_snapshot,
    save_user_scan_state,
    upsert_user_baseline,
)
from servermanage.web import create_app

from datetime import datetime, timezone

HOST = "gpu-01"
OTHER_HOST = "lab-02"
ADMIN_PASSWORD = "pw"


# ---------------------------------------------------------------------------
# usermode helpers
# ---------------------------------------------------------------------------


def test_normalize_mode_accepts_known_values_and_falls_back():
    assert usermode.normalize_mode("admin") == "admin"
    assert usermode.normalize_mode("USER") == "user"
    assert usermode.normalize_mode(" user ") == "user"
    assert usermode.normalize_mode("", default="user") == "user"
    assert usermode.normalize_mode(None) == "admin"


def test_normalize_mode_rejects_unknown_value():
    with pytest.raises(usermode.ModeError):
        usermode.normalize_mode("operator")


def test_normalize_member_account_lowercases_and_validates():
    assert usermode.normalize_member_account(" Zhou") == "zhou"
    assert usermode.normalize_member_account("") == ""
    assert usermode.normalize_member_account(None) == ""
    assert usermode.normalize_member_account("zhang_san-2") == "zhang_san-2"
    for bad in ("1abc", "-abc", "a b", "a.b", "a" * 40, "张三"):
        with pytest.raises(usermode.ModeError):
            usermode.normalize_member_account(bad)


def test_validate_mode_requires_member_in_user_mode():
    assert usermode.validate_mode("user", " zhou ") == ("user", "zhou")
    assert usermode.validate_mode("admin", "") == ("admin", "")
    with pytest.raises(usermode.ModeError):
        usermode.validate_mode("user", "")


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------


def _write_config(tmp_path: Path, app_block: str) -> Path:
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        f"""
app:
{app_block}
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    username: "root"
    auth:
      type: "password"
      password_env: "SSH_PW"
""".strip(),
        encoding="utf-8",
    )
    return config_file


@pytest.fixture(autouse=True)
def _ssh_env(monkeypatch):
    monkeypatch.setenv("SSH_PW", "ssh-pw")


def test_config_loads_user_mode(tmp_path):
    config = load_config(
        _write_config(
            tmp_path,
            '  mode: "user"\n  member_account: " Zhou "',
        )
    )

    assert config.app.mode == "user"
    assert config.app.member_account == "zhou"


def test_config_defaults_to_admin_mode(tmp_path):
    config = load_config(_write_config(tmp_path, '  poll_interval_seconds: 600'))

    assert config.app.mode == "admin"
    assert config.app.member_account == ""


def test_config_rejects_user_mode_without_account(tmp_path):
    with pytest.raises(ConfigError):
        load_config(_write_config(tmp_path, '  mode: "user"'))


def test_config_rejects_unknown_mode(tmp_path):
    with pytest.raises(ConfigError):
        load_config(_write_config(tmp_path, '  mode: "observer"'))


# ---------------------------------------------------------------------------
# App fixtures
# ---------------------------------------------------------------------------


def _make_config(*, mode: str = "user", member: str = "alice") -> AppConfig:
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[
            HostConfig(
                name=HOST,
                host="10.0.0.1",
                port=22,
                username="monitor",
                auth=AuthConfig(type="password", password="ssh-pw"),
            ),
            HostConfig(
                name=OTHER_HOST,
                host="10.0.0.2",
                port=22,
                username="monitor",
                auth=AuthConfig(type="password", password="ssh-pw"),
            ),
        ],
        app=AppRuntimeConfig(
            poll_interval_seconds=600, mode=mode, member_account=member
        ),
        dashboard=DashboardConfig(
            auth=DashboardAuthConfig(
                enabled=True,
                username="admin",
                password_env=None,
                password=ADMIN_PASSWORD,
            ),
            session_secret="test-secret",
        ),
    )


def _account(username: str, **overrides) -> dict:
    data = {
        "username": username,
        "uid": 1000,
        "gid": 1000,
        "primary_group": username,
        "gecos": "",
        "home": f"/home/{username}",
        "shell": "/bin/bash",
        "groups": ["docker"],
        "in_docker": True,
        "in_sudo": False,
        "home_exists": True,
        "home_owner": username,
        "home_group": username,
        "home_mode": "750",
        "home_size_bytes": 1024,
        "data_exists": True,
        "data_owner": username,
        "data_group": username,
        "data_mode": "750",
        "data_size_bytes": 2048,
        "data_supported": True,
        "usage_stale": False,
    }
    data.update(overrides)
    return data


def _seed(db_path) -> None:
    """alice exists on gpu-01 (with a stray bob) and is missing on lab-02."""
    alice = _account("alice")
    bob = _account("bob", home_exists=False, home_size_bytes=None)
    carol = _account("carol")
    save_host_user_snapshot(HOST, [alice, bob], db_path)
    save_host_user_snapshot(OTHER_HOST, [carol], db_path)
    for account in (alice, bob, carol):
        upsert_user_baseline(HOST, account, db_path)
    upsert_user_baseline(OTHER_HOST, carol, db_path)
    upsert_user_baseline(OTHER_HOST, alice, db_path)
    save_user_scan_state(HOST, db_path=db_path, last_scan_at=datetime.now(timezone.utc))


class _StubSettingsService:
    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self.saved: dict | None = None

    def setup_required(self) -> bool:
        return False

    def is_writable(self) -> bool:
        return True

    def verify_admin(self, username: str, password: str) -> bool:
        return True

    def load(self) -> AppConfig:
        return self._config

    def public_settings(self) -> dict:
        return {
            "monitoring": {
                "timezone": "Asia/Shanghai",
                "mode": self._config.app.mode,
                "member_account": self._config.app.member_account,
            }
        }

    def save_section(self, section: str, payload: dict) -> AppConfig:
        if section != "monitoring":
            raise SettingsError("不支持的分区")
        mode, member = usermode.validate_mode(
            payload.get("mode", "admin"), payload.get("member_account", "")
        )
        self.saved = {"mode": mode, "member_account": member}
        self._config = replace(
            self._config,
            app=replace(self._config.app, mode=mode, member_account=member),
        )
        return self._config

    def refresh_settings(self) -> dict:
        return self.public_settings()


def _new_app(db_path, *, config=None, settings_service=None):
    app = create_app(
        config=config or _make_config(),
        db_path=db_path,
        settings_service=settings_service,
    )
    app.config.update(TESTING=True)
    return app


def _login(client) -> None:
    response = client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    )
    assert response.status_code == 302


@pytest.fixture()
def user_client(tmp_path):
    db_path = tmp_path / "mode.db"
    _seed(db_path)
    client = _new_app(db_path).test_client()
    _login(client)
    return client, db_path


# ---------------------------------------------------------------------------
# Gate
# ---------------------------------------------------------------------------


def test_admin_pages_redirect_to_my_page_in_user_mode(user_client):
    client, _db_path = user_client

    for path in ("/", "/hosts", "/alerts", "/users", "/disk-health", "/terminal"):
        response = client.get(path)
        assert response.status_code == 302, path
        assert response.headers["Location"].endswith("/my"), path


def test_admin_apis_are_forbidden_in_user_mode(user_client):
    client, _db_path = user_client

    for path in ("/api/overview", "/api/alerts", "/api/users", "/api/system/health"):
        response = client.get(path)
        assert response.status_code == 403, path
        assert response.get_json()["error"] == "admin_only", path


def test_static_assets_and_own_pages_stay_available_in_user_mode(user_client):
    client, _db_path = user_client

    assert client.get("/my").status_code == 200
    assert client.get("/api/my/summary").status_code == 200
    assert client.get("/settings").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/api/runtime").status_code == 200


def test_admin_mode_still_serves_dashboards(tmp_path):
    db_path = tmp_path / "mode.db"
    _seed(db_path)
    client = _new_app(db_path, config=_make_config(mode="admin", member="")).test_client()
    _login(client)

    assert client.get("/").status_code == 200
    assert client.get("/users").status_code == 200
    assert client.get("/api/overview").status_code == 200
    assert client.get("/my").status_code == 200


# ---------------------------------------------------------------------------
# My servers payload
# ---------------------------------------------------------------------------


def test_my_summary_only_lists_hosts_with_the_member_account(user_client):
    client, _db_path = user_client

    payload = client.get("/api/my/summary").get_json()

    assert payload["mode"] == "user"
    assert payload["member"] == "alice"
    names = [host["name"] for host in payload["hosts"]]
    assert names == [HOST, OTHER_HOST]
    by_name = {host["name"]: host for host in payload["hosts"]}
    assert by_name[HOST]["account"]["state"] == "present"
    assert by_name[HOST]["account"]["username"] == "alice"
    assert by_name[OTHER_HOST]["account"]["state"] == "missing"
    assert payload["summary"]["hosts"] == 2
    assert payload["summary"]["present"] == 1
    assert payload["summary"]["missing"] == 1


def test_my_summary_hides_hosts_without_the_member_account(tmp_path):
    db_path = tmp_path / "mode.db"
    _seed(db_path)
    config = _make_config(mode="user", member="nobody")
    client = _new_app(db_path, config=config).test_client()
    _login(client)

    payload = client.get("/api/my/summary").get_json()

    assert payload["hosts"] == []
    assert payload["summary"]["hosts"] == 0


def test_my_page_renders_member_and_hides_admin_navigation(user_client):
    client, _db_path = user_client

    page = client.get("/my").get_data(as_text=True)

    assert "我的服务器" in page
    assert "alice" in page
    assert 'id="my-host-list"' in page
    # Admin-only navigation and widgets must not be rendered at all.
    for needle in ('href="/alerts"', 'href="/users"', 'href="/terminal"',
                   'id="command-palette"', 'id="command-trigger"'):
        assert needle not in page, needle


def test_settings_page_switches_to_the_user_shell(user_client):
    client, _db_path = user_client

    page = client.get("/settings").get_data(as_text=True)

    assert 'id="settings-user-root"' in page
    assert 'id="user-mode-member"' in page
    assert 'id="user-mode-switch"' in page
    assert 'data-section="hosts"' not in page


# ---------------------------------------------------------------------------
# Settings round-trip
# ---------------------------------------------------------------------------


def test_user_mode_can_save_its_own_account(tmp_path):
    db_path = tmp_path / "mode.db"
    _seed(db_path)
    config = _make_config(mode="user", member="alice")
    settings = _StubSettingsService(config)
    client = _new_app(db_path, config=config, settings_service=settings).test_client()
    _login(client)
    token = re.search(
        r'name="csrf-token" content="([^"]+)"',
        client.get("/my").get_data(as_text=True),
    ).group(1)

    response = client.put(
        "/api/settings/monitoring",
        json={"mode": "user", "member_account": " Zhang "},
        headers={"X-CSRF-Token": token},
    )

    assert response.status_code == 200
    assert settings.saved == {"mode": "user", "member_account": "zhang"}


def test_user_mode_cannot_write_other_sections(tmp_path):
    db_path = tmp_path / "mode.db"
    _seed(db_path)
    config = _make_config(mode="user", member="alice")
    settings = _StubSettingsService(config)
    client = _new_app(db_path, config=config, settings_service=settings).test_client()
    _login(client)
    token = re.search(
        r'name="csrf-token" content="([^"]+)"',
        client.get("/my").get_data(as_text=True),
    ).group(1)

    blocked = client.put(
        "/api/settings/alerts",
        json={"enabled": False},
        headers={"X-CSRF-Token": token},
    )
    extra_keys = client.put(
        "/api/settings/monitoring",
        json={"mode": "user", "member_account": "alice", "poll_interval_seconds": 5},
        headers={"X-CSRF-Token": token},
    )

    assert blocked.status_code == 403
    assert extra_keys.status_code == 403
