from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from servermanage.disk_health import (
    AlertEvent,
    DiskHealthReport,
    PhysicalDriveInfo,
)
from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DashboardAuthConfig,
    DashboardConfig,
    DiskUsageRow,
    GPUSummaryRow,
    HostConfig,
    HostMetrics,
    HostReport,
    LoggedInUser,
    MemorySummary,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.storage import (
    insert_alert,
    insert_silence,
    list_alerts,
    save_disk_health,
    save_host_snapshot,
)
from servermanage.web import create_app

HOST_NAME = "gpu-01"
HOST_ADDRESS = "10.0.0.1"


def _make_config(
    *,
    password: str = "pw",
    secret: str = "s",
    group: str = "未分组",
    owner: str = "",
    location: str = "",
    tags: list[str] | None = None,
) -> AppConfig:
    """Build a real AppConfig whose secrets are already resolved."""
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[
            HostConfig(
                name=HOST_NAME,
                host=HOST_ADDRESS,
                port=22,
                username="monitor",
                auth=AuthConfig(type="password", password="ssh-pw"),
                tags=list(tags or []),
                group=group,
                owner=owner,
                location=location,
            )
        ],
        app=AppRuntimeConfig(poll_interval_seconds=600),
        dashboard=DashboardConfig(
            auth=DashboardAuthConfig(
                enabled=True,
                username="admin",
                password_env=None,
                password=password,
            ),
            session_secret=secret,
        ),
    )


def _memory() -> MemorySummary:
    return MemorySummary(
        total_mb=16384,
        used_mb=4096,
        free_mb=12288,
        shared_mb=0,
        buff_cache_mb=0,
        available_mb=12288,
        swap_total_mb=0,
        swap_used_mb=0,
        swap_free_mb=0,
    )


def _seed_database(db_path: Path) -> tuple[int, datetime]:
    now = datetime.now(timezone.utc)
    save_host_snapshot(
        HostReport(
            host_name=HOST_NAME,
            host=HOST_ADDRESS,
            success=True,
            metrics=HostMetrics(
                collected_at=now,
                cpu_usage_percent=42.5,
                logged_in_users=[
                    LoggedInUser(username="alice", terminal="pts/0", login_at="2026-11-06 09:00", remote_host="10.0.0.9"),
                    LoggedInUser(username="alice", terminal="pts/1", login_at="2026-11-06 09:05", remote_host="10.0.0.9"),
                    LoggedInUser(username="bob", terminal="pts/2", login_at="2026-11-06 09:10", remote_host="10.0.0.10"),
                ],
                memory=_memory(),
                disk_usage=[
                    DiskUsageRow(
                        filesystem="/dev/sda1",
                        size="100G",
                        used="45G",
                        available="55G",
                        percent="45%",
                        mountpoint="/",
                    )
                ],
                gpu_summary=[
                    GPUSummaryRow(
                        index=0,
                        name="NVIDIA A100",
                        utilization_percent=10,
                        temperature_c=40,
                        memory_used_mb=2048,
                        memory_total_mb=8192,
                    )
                ],
            ),
        ),
        db_path,
    )

    save_disk_health(
        DiskHealthReport(
            host_name=HOST_NAME,
            collected_at=now,
            status="warning",
            message="1 drive needs attention",
            physical_drives=[
                PhysicalDriveInfo(
                    controller=0, enclosure=252, slot=0, state="Onln",
                    model="ST1000NM0011", serial="SN0001", health="healthy",
                ),
                PhysicalDriveInfo(
                    controller=0, enclosure=252, slot=1, state="Onln",
                    model="ST1000NM0011", serial="SN0002", health="healthy",
                ),
                PhysicalDriveInfo(
                    controller=0, enclosure=252, slot=2, state="Onln",
                    model="ST2000NM0011", serial="SN0003", health="warning",
                    media_errors=2, reasons=["media_errors"],
                ),
            ],
        ),
        db_path,
    )

    alert_id = insert_alert(
        AlertEvent(
            host_name=HOST_NAME,
            category="system",
            severity="warning",
            title="CPU 使用率过高",
            message="CPU 使用率 95% 超过阈值",
            fingerprint=f"system:{HOST_NAME}:cpu",
        ),
        db_path,
    )
    return alert_id, now


@pytest.fixture()
def env(tmp_path):
    db_path = tmp_path / "web-test.db"
    alert_id, _now = _seed_database(db_path)
    app = create_app(config=_make_config(), db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    return client, db_path, alert_id


def _login(client) -> None:
    response = client.post("/login", data={"username": "admin", "password": "pw"})
    assert response.status_code == 302


def test_api_requires_login(env):
    client, _db_path, _alert_id = env

    response = client.get("/api/overview")

    assert response.status_code == 401
    assert response.get_json() == {"error": "unauthorized"}


def test_unauthenticated_page_redirects_to_login(env):
    client, _db_path, _alert_id = env

    response = client.get("/")

    assert response.status_code == 302
    assert response.headers["Location"].endswith("/login")


def test_login_and_overview(env):
    client, _db_path, _alert_id = env

    bad = client.post("/login", data={"username": "admin", "password": "wrong"})
    assert bad.status_code == 401

    _login(client)

    response = client.get("/api/overview")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["summary"] == {"online": 1, "offline": 0, "active_alerts": 1}

    host = next(item for item in payload["hosts"] if item["name"] == HOST_NAME)
    assert host["host"] == HOST_ADDRESS
    assert host["online"] is True
    assert host["cpu_percent"] == pytest.approx(42.5)
    assert host["memory_percent"] == pytest.approx(25.0)
    assert host["disk_percent"] == pytest.approx(45.0)
    assert host["gpu_memory_percent"] == pytest.approx(25.0)
    assert host["logged_in_user_count"] == 2
    assert host["logged_in_sessions"] == 3
    assert host["disk_health"] == {
        "status": "warning",
        "healthy": 2,
        "warning": 1,
        "critical": 0,
    }


def test_host_detail_and_alerts(env):
    client, _db_path, _alert_id = env
    _login(client)

    detail = client.get(f"/api/host/{HOST_NAME}")
    assert detail.status_code == 200
    body = detail.get_json()
    assert body["name"] == HOST_NAME
    assert body["host"] == HOST_ADDRESS
    assert body["success"] is True
    assert body["metrics"]["cpu_usage_percent"] == pytest.approx(42.5)
    assert body["disk"]["status"] == "warning"
    assert len(body["disk"]["physical_drives"]) == 3

    missing = client.get("/api/host/does-not-exist")
    assert missing.status_code == 404

    alerts = client.get("/api/alerts?status=active")
    assert alerts.status_code == 200
    assert len(alerts.get_json()["alerts"]) == 1


def test_ack_alert(env):
    client, db_path, alert_id = env
    _login(client)

    response = client.post(f"/api/alerts/{alert_id}/ack")

    assert response.status_code == 200
    assert response.get_json() == {"ok": True}
    assert list_alerts(db_path, status="active") == []
    stored = list_alerts(db_path)
    assert len(stored) == 1
    assert stored[0]["status"] == "acknowledged"
    assert stored[0]["ack_at"] is not None


def _new_client(config, db_path: Path):
    app = create_app(config=config, db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    _login(client)
    return client


def test_overview_includes_host_metadata_and_groups(tmp_path):
    db_path = tmp_path / "meta.db"
    _seed_database(db_path)
    client = _new_client(
        _make_config(group="GPU", owner="alice", location="A-101", tags=["gpu", "prod"]),
        db_path,
    )

    payload = client.get("/api/overview").get_json()
    host = next(item for item in payload["hosts"] if item["name"] == HOST_NAME)
    assert host["group"] == "GPU"
    assert host["owner"] == "alice"
    assert host["location"] == "A-101"
    assert host["tags"] == ["gpu", "prod"]
    assert host["silenced"] is False
    assert host["silenced_until"] is None
    assert host["active_alert_count"] == 1
    assert payload["meta"]["groups"] == ["GPU"]
    assert payload["meta"]["silenced_count"] == 0


def test_overview_marks_silenced_hosts(tmp_path):
    db_path = tmp_path / "silence.db"
    _seed_database(db_path)
    now = datetime.now(timezone.utc)
    insert_silence(
        "host",
        HOST_NAME,
        "maintenance",
        now - timedelta(hours=1),
        now + timedelta(hours=1),
        "admin",
        db_path,
    )
    client = _new_client(_make_config(group="GPU"), db_path)

    payload = client.get("/api/overview").get_json()
    host = next(item for item in payload["hosts"] if item["name"] == HOST_NAME)
    assert host["silenced"] is True
    assert host["silenced_until"]
    assert payload["meta"]["silenced_count"] == 1


def test_overview_group_scope_silence_marks_host(tmp_path):
    db_path = tmp_path / "group-silence.db"
    _seed_database(db_path)
    now = datetime.now(timezone.utc)
    insert_silence(
        "group",
        "GPU",
        "group maintenance",
        now - timedelta(hours=1),
        now + timedelta(hours=1),
        "admin",
        db_path,
    )
    client = _new_client(_make_config(group="GPU"), db_path)

    host = next(
        item for item in client.get("/api/overview").get_json()["hosts"]
        if item["name"] == HOST_NAME
    )
    assert host["silenced"] is True


def test_overview_page_has_filter_controls(tmp_path):
    db_path = tmp_path / "page.db"
    _seed_database(db_path)
    client = _new_client(_make_config(group="GPU"), db_path)

    html = client.get("/").get_data(as_text=True)
    assert 'id="host-filter"' in html
    assert 'id="filter-group"' in html
    assert 'id="filter-status"' in html
    assert 'id="filter-keyword"' in html
    assert "<th>分组</th>" in html
    assert "<th>负责人</th>" in html


def test_logout_clears_session(env):
    client, _db_path, _alert_id = env
    _login(client)

    response = client.post("/logout")
    assert response.status_code == 302

    assert client.get("/api/overview").status_code == 401


def test_overview_reflects_imported_host_groups(tmp_path):
    """Task 13: hosts imported through SettingsService show up grouped on /overview."""
    from servermanage.config import load_config_from_mapping
    from servermanage.settings import SettingsService
    from servermanage.web.routes import _build_overview

    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db_path = tmp_path / "import-overview.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db_path, base_config=base)

    service.import_hosts(
        [
            {
                "name": "imp-a",
                "host": "10.9.0.1",
                "username": "ubuntu",
                "auth_type": "key",
                "key_path": "/home/u/.ssh/id_rsa",
                "group": "GPU",
            },
            {
                "name": "imp-b",
                "host": "10.9.0.2",
                "username": "ubuntu",
                "auth_type": "key",
                "key_path": "/home/u/.ssh/id_rsa",
                "group": "机房",
            },
        ]
    )

    payload = _build_overview(service.load(), db_path)
    assert payload["meta"]["groups"] == ["GPU", "机房"]
    by_name = {host["name"]: host for host in payload["hosts"]}
    assert set(by_name) == {"imp-a", "imp-b"}
    assert by_name["imp-a"]["group"] == "GPU"
    assert by_name["imp-b"]["group"] == "机房"
