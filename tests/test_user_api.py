"""Tests for the server-user HTTP API (Task 5).

The fixtures seed storage directly (snapshot, baseline, scan state) so the API
is exercised without any SSH collection, and the client helpers mirror the
login/CSRF patterns used by ``tests/test_web_api.py`` and
``tests/test_settings_api.py``.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

import pytest

from servermanage.alerts import fingerprint_for
from servermanage.disk_health import AlertEvent
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
from servermanage.storage import (
    find_latest_alert,
    get_user_baseline,
    insert_alert,
    save_host_user_snapshot,
    save_user_scan_state,
    upsert_user_baseline,
)
from servermanage.web import create_app

HOST = "gpu-01"
OTHER_HOST = "lab-02"
ADMIN_PASSWORD = "pw"


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _make_config() -> AppConfig:
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
        app=AppRuntimeConfig(poll_interval_seconds=600),
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


ALICE = _account("alice", groups=["docker"])
BOB = _account(
    "bob",
    groups=[],
    in_docker=False,
    home_exists=False,
    home_owner=None,
    home_group=None,
    home_mode=None,
    home_size_bytes=None,
    data_exists=False,
    data_owner=None,
    data_group=None,
    data_mode=None,
    data_size_bytes=None,
)
CAROL = _account("carol")
DAVE = _account(
    "dave",
    home_owner="root",
    data_owner="root",
    home_size_bytes=300,
    data_size_bytes=400,
)
ERIN = _account(
    "erin",
    uid=1001,
    groups=["docker", "sudo"],
    data_supported=False,
    data_exists=False,
    data_owner=None,
    data_group=None,
    data_mode=None,
    home_size_bytes=None,
    data_size_bytes=None,
    usage_stale=True,
)


def _seed(db_path) -> None:
    """Two hosts: gpu-01 (scanned) and lab-02 (never scanned)."""
    save_host_user_snapshot(HOST, [ALICE, BOB, DAVE], db_path)
    save_host_user_snapshot(OTHER_HOST, [ERIN], db_path)
    for account in (ALICE, BOB, CAROL, DAVE):
        upsert_user_baseline(HOST, account, db_path)
    upsert_user_baseline(OTHER_HOST, ERIN, db_path)
    save_user_scan_state(
        HOST,
        db_path=db_path,
        last_scan_at=datetime.now(timezone.utc),
    )


def _new_app(db_path, *, settings_service=None, monitor_service=None):
    app = create_app(
        config=_make_config(),
        db_path=db_path,
        settings_service=settings_service,
    )
    app.config.update(TESTING=True)
    if monitor_service is not None:
        app.config["MONITOR_SERVICE"] = monitor_service
    return app


def _login(client) -> None:
    response = client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    )
    assert response.status_code == 302


def _csrf_from_meta(client) -> str:
    page = client.get("/users").get_data(as_text=True)
    return re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)


class _StubSettingsService:
    """Minimal SettingsService stand-in: enables login + CSRF handling."""

    def __init__(self, config: AppConfig) -> None:
        self._config = config

    def setup_required(self) -> bool:
        return False

    def is_writable(self) -> bool:
        return True

    def verify_admin(self, username: str, password: str) -> bool:
        return True

    def load(self) -> AppConfig:
        return self._config


class _StubMonitorService:
    def __init__(self) -> None:
        self.refresh_calls = 0

    def refresh_users(self):
        self.refresh_calls += 1
        return {"ok": True, "started": True}

    def user_scan_status(self):
        return {
            "running": False,
            "started_at": None,
            "finished_at": None,
            "error": None,
            "hosts_done": 2,
            "hosts_total": 2,
        }


@pytest.fixture()
def client(tmp_path):
    db_path = tmp_path / "users.db"
    _seed(db_path)
    test_client = _new_app(db_path).test_client()
    _login(test_client)
    return test_client, db_path


def _accounts(payload: dict) -> dict[tuple[str, str], dict]:
    return {(row["host_name"], row["username"]): row for row in payload["accounts"]}


# ---------------------------------------------------------------------------
# Page + authentication
# ---------------------------------------------------------------------------


def test_users_page_renders(client):
    test_client, _db_path = client

    response = test_client.get("/users")

    assert response.status_code == 200
    page = response.get_data(as_text=True)
    assert 'id="user-dashboard"' in page
    assert "users.js" in page


def test_users_page_requires_login(tmp_path):
    db_path = tmp_path / "users.db"
    _seed(db_path)
    test_client = _new_app(db_path).test_client()

    assert test_client.get("/users").status_code == 302
    assert test_client.get("/api/users").status_code == 401
    assert test_client.post("/api/users/refresh").status_code == 401


# ---------------------------------------------------------------------------
# GET /api/users — merge, issues, summary
# ---------------------------------------------------------------------------


def test_api_users_merges_snapshot_and_baseline(client):
    test_client, _db_path = client

    response = test_client.get("/api/users")

    assert response.status_code == 200
    payload = response.get_json()
    rows = _accounts(payload)
    assert len(rows) == 5

    alice = rows[(HOST, "alice")]
    assert alice["state"] == "present"
    assert alice["issues"] == []
    assert alice["home_size_bytes"] == 1024
    assert alice["data_size_bytes"] == 2048
    assert alice["groups"] == ["docker"]
    assert alice["in_docker"] is True

    bob = rows[(HOST, "bob")]
    assert bob["issues"] == ["docker", "home", "data"]

    dave = rows[(HOST, "dave")]
    assert dave["issues"] == ["owner"]

    # ``carol`` is in the baseline only: a missing row built from frozen values.
    carol = rows[(HOST, "carol")]
    assert carol["state"] == "missing"
    assert carol["issues"] == ["missing"]
    assert carol["uid"] == 1000
    assert carol["home"] == "/home/carol"
    assert carol["groups"] == ["docker"]
    # Missing rows must not claim a live directory state or size.
    assert carol["home_exists"] is None
    assert carol["data_exists"] is None
    assert carol["home_size_bytes"] is None
    assert carol["data_size_bytes"] is None
    assert carol["collected_at"] is None
    assert carol["last_seen_at"]

    # erin lives on a host without /data: no data issue.
    erin = rows[(OTHER_HOST, "erin")]
    assert erin["issues"] == []
    assert erin["data_supported"] is False


def test_api_users_summary_counts(client):
    test_client, _db_path = client

    summary = test_client.get("/api/users").get_json()["summary"]

    assert summary["total"] == 5
    assert summary["present"] == 4
    assert summary["missing"] == 1
    assert summary["total"] == summary["present"] + summary["missing"]
    assert summary["docker_issues"] == 1  # bob
    assert summary["directory_issues"] == 2  # bob (home/data) + dave (owner)
    assert summary["home_bytes"] == 1024 + 300  # erin/bob have no size
    assert summary["data_bytes"] == 2048 + 400


def test_api_users_hosts_block(client):
    test_client, _db_path = client

    hosts = {row["name"]: row for row in test_client.get("/api/users").get_json()["hosts"]}

    assert set(hosts) == {HOST, OTHER_HOST}
    assert hosts[HOST]["status"] == "ok"
    assert hosts[HOST]["last_scan_at"]
    assert hosts[HOST]["last_error"] is None
    assert hosts[HOST]["accounts"] == 4
    assert hosts[OTHER_HOST]["status"] == "unknown"
    assert hosts[OTHER_HOST]["last_scan_at"] is None


# ---------------------------------------------------------------------------
# Host status
# ---------------------------------------------------------------------------


def test_host_status_unknown_then_ok_then_error(client):
    test_client, db_path = client

    statuses = {
        row["name"]: row["status"]
        for row in test_client.get("/api/users").get_json()["hosts"]
    }
    assert statuses == {HOST: "ok", OTHER_HOST: "unknown"}

    # A host without any usage data (no ``du`` permission) is still healthy:
    # only a recorded scan error turns the host into ``error``.
    save_user_scan_state(
        OTHER_HOST,
        db_path=db_path,
        last_scan_at=datetime.now(timezone.utc),
    )
    payload = test_client.get("/api/users").get_json()
    hosts = {row["name"]: row for row in payload["hosts"]}
    assert hosts[OTHER_HOST]["status"] == "ok"
    assert all(
        row["usage_readable"] is None
        for row in payload["accounts"]
        if row["host_name"] == OTHER_HOST
    )

    save_user_scan_state(OTHER_HOST, db_path=db_path, last_error="boom")
    payload = test_client.get("/api/users").get_json()
    hosts = {row["name"]: row for row in payload["hosts"]}
    assert hosts[OTHER_HOST]["status"] == "error"
    assert hosts[OTHER_HOST]["last_error"] == "boom"
    assert hosts[HOST]["status"] == "ok"


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


def test_filter_status_warning(client):
    test_client, _db_path = client

    payload = test_client.get("/api/users?status=warning").get_json()

    assert {row["username"] for row in payload["accounts"]} == {"bob", "carol", "dave"}
    assert payload["filters"]["status"] == "warning"
    # The summary always describes the full baseline, not the filtered view.
    assert payload["summary"]["total"] == 5


def test_filter_status_error(client):
    test_client, db_path = client
    # No host failed yet: ``error`` selects nothing.
    assert test_client.get("/api/users?status=error").get_json()["accounts"] == []

    save_user_scan_state(HOST, db_path=db_path, last_error="ssh timeout")
    payload = test_client.get("/api/users?status=error").get_json()

    assert {row["host_name"] for row in payload["accounts"]} == {HOST}
    assert {row["username"] for row in payload["accounts"]} == {
        "alice",
        "bob",
        "carol",
        "dave",
    }
    hosts = {row["name"]: row for row in payload["hosts"]}
    assert hosts[HOST]["status"] == "error"


def test_filter_q_and_host(client):
    test_client, _db_path = client

    assert {row["username"] for row in test_client.get("/api/users?q=car").get_json()["accounts"]} == {"carol"}
    # ``q`` also matches the host name and the account's group names.
    assert {row["username"] for row in test_client.get("/api/users?q=GPU").get_json()["accounts"]} == {
        "alice",
        "bob",
        "carol",
        "dave",
    }
    assert {row["username"] for row in test_client.get("/api/users?q=sudo").get_json()["accounts"]} == {"erin"}
    assert {row["username"] for row in test_client.get("/api/users?host=lab-02").get_json()["accounts"]} == {"erin"}
    assert test_client.get("/api/users?host=nope").get_json()["accounts"] == []


# ---------------------------------------------------------------------------
# Refresh endpoints
# ---------------------------------------------------------------------------


def test_refresh_reports_503_without_service_method(client):
    test_client, _db_path = client

    response = test_client.post("/api/users/refresh")

    assert response.status_code == 503
    assert response.get_json() == {"error": "unavailable"}


def test_refresh_status_reports_unavailable(client):
    test_client, _db_path = client

    payload = test_client.get("/api/users/refresh-status").get_json()

    assert payload == {"running": False, "error": "unavailable"}


def test_refresh_delegates_to_monitor_service(tmp_path):
    db_path = tmp_path / "users.db"
    _seed(db_path)
    monitor = _StubMonitorService()
    service = _StubSettingsService(_make_config())
    test_client = _new_app(
        db_path, settings_service=service, monitor_service=monitor
    ).test_client()
    _login(test_client)
    token = _csrf_from_meta(test_client)

    response = test_client.post(
        "/api/users/refresh", headers={"X-CSRF-Token": token}
    )

    assert response.status_code == 200
    assert response.get_json() == {"ok": True, "started": True}
    assert monitor.refresh_calls == 1

    status = test_client.get("/api/users/refresh-status").get_json()
    assert status["running"] is False
    assert status["hosts_done"] == 2
    assert status["hosts_total"] == 2


def test_refresh_requires_csrf_token(tmp_path):
    db_path = tmp_path / "users.db"
    _seed(db_path)
    service = _StubSettingsService(_make_config())
    test_client = _new_app(db_path, settings_service=service).test_client()
    _login(test_client)

    missing = test_client.post("/api/users/refresh")
    assert missing.status_code == 400
    assert missing.get_json()["error"] == "csrf_failed"

    token = _csrf_from_meta(test_client)
    assert (
        test_client.post(
            "/api/users/refresh", headers={"X-CSRF-Token": token}
        ).status_code
        == 503
    )


# ---------------------------------------------------------------------------
# Baseline removal
# ---------------------------------------------------------------------------


def _user_present_alert(db_path) -> int:
    return insert_alert(
        AlertEvent(
            host_name=HOST,
            category="user",
            severity="warning",
            title="账号缺失",
            message="账号 carol 已从当前快照中消失",
            fingerprint=fingerprint_for("user-present", HOST, "carol"),
        ),
        db_path,
    )


def test_baseline_remove_deletes_row_and_resolves_alert(client):
    test_client, db_path = client
    _user_present_alert(db_path)

    response = test_client.post(
        "/api/users/baseline/remove", json={"host": HOST, "username": "carol"}
    )

    assert response.status_code == 200
    assert response.get_json() == {"ok": True, "removed": 1}
    assert all(
        row["username"] != "carol" for row in get_user_baseline(HOST, db_path)
    )
    alert = find_latest_alert(
        fingerprint_for("user-present", HOST, "carol"), db_path
    )
    assert alert["status"] == "resolved"

    payload = test_client.get("/api/users").get_json()
    assert (HOST, "carol") not in _accounts(payload)
    assert payload["summary"]["missing"] == 0
    assert payload["summary"]["total"] == 4


def test_baseline_remove_unknown_row_returns_404(client):
    test_client, _db_path = client

    response = test_client.post(
        "/api/users/baseline/remove", json={"host": HOST, "username": "nobody"}
    )

    assert response.status_code == 404
    assert response.get_json()["error"] == "not_found"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"host": HOST},
        {"username": "carol"},
        {"host": "", "username": "carol"},
        {"host": HOST, "username": ""},
        {"host": HOST, "username": 42},
        {"host": "unknown-host", "username": "carol"},
        ["not", "a", "dict"],
    ],
)
def test_baseline_remove_rejects_bad_payload(client, payload):
    test_client, _db_path = client

    response = test_client.post("/api/users/baseline/remove", json=payload)

    assert response.status_code == 400


def test_baseline_remove_requires_csrf_token(tmp_path):
    db_path = tmp_path / "users.db"
    _seed(db_path)
    service = _StubSettingsService(_make_config())
    test_client = _new_app(db_path, settings_service=service).test_client()
    _login(test_client)

    missing = test_client.post(
        "/api/users/baseline/remove", json={"host": HOST, "username": "carol"}
    )
    assert missing.status_code == 400
    assert missing.get_json()["error"] == "csrf_failed"

    token = _csrf_from_meta(test_client)
    ok = test_client.post(
        "/api/users/baseline/remove",
        json={"host": HOST, "username": "carol"},
        headers={"X-CSRF-Token": token},
    )
    assert ok.status_code == 200
    assert ok.get_json() == {"ok": True, "removed": 1}


# ---------------------------------------------------------------------------
# Host detail
# ---------------------------------------------------------------------------


def test_host_detail_includes_users(client):
    test_client, _db_path = client

    response = test_client.get(f"/api/host/{HOST}")

    assert response.status_code == 200
    users = {row["username"]: row for row in response.get_json()["users"]}
    assert set(users) == {"alice", "bob", "carol", "dave"}
    assert users["carol"]["state"] == "missing"
    assert users["carol"]["issues"] == ["missing"]
    assert users["bob"]["issues"] == ["docker", "home", "data"]
