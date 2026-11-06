from __future__ import annotations

from datetime import datetime, timezone
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
    MemorySummary,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.storage import (
    insert_alert,
    list_alerts,
    save_disk_health,
    save_host_snapshot,
)
from servermanage.web import create_app

HOST_NAME = "gpu-01"
HOST_ADDRESS = "10.0.0.1"


def _make_config(*, password: str = "pw", secret: str = "s") -> AppConfig:
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


def test_logout_clears_session(env):
    client, _db_path, _alert_id = env
    _login(client)

    response = client.post("/logout")
    assert response.status_code == 302

    assert client.get("/api/overview").status_code == 401
