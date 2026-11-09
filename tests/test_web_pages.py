"""Page-route tests for the dashboard (Task 11).

These tests exercise the server-rendered HTML pages, not the JSON API.  They
build a real ``AppConfig`` and a real temporary SQLite database (via the public
storage helpers) so the pages render real persisted data.
"""

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
    WeeklyReportConfig,
)
from servermanage.storage import (
    insert_alert,
    save_disk_health,
    save_host_snapshot,
)
from servermanage.web import create_app

HOST_NAME = "gpu-01"
HOST_ADDRESS = "10.0.0.1"
DRIVE_MODEL = "ST1000NM0011"


def _make_config(
    *,
    poll_interval: int = 600,
    disk_poll_interval: int = 86400,
    timezone_name: str = "Asia/Shanghai",
    daily_enabled: bool = True,
    weekly_enabled: bool = True,
    servers: list[HostConfig] | None = None,
) -> AppConfig:
    """Build a real ``AppConfig`` whose secrets are already resolved."""
    if servers is None:
        servers = [
            HostConfig(
                name=HOST_NAME,
                host=HOST_ADDRESS,
                port=22,
                username="monitor",
                auth=AuthConfig(type="password", password="ssh-pw"),
            )
        ]
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(
            subject_prefix="[Test]",
            daily_enabled=daily_enabled,
            weekly=WeeklyReportConfig(enabled=weekly_enabled),
        ),
        servers=servers,
        app=AppRuntimeConfig(
            poll_interval_seconds=poll_interval,
            disk_poll_interval_seconds=disk_poll_interval,
            timezone=timezone_name,
        ),
        dashboard=DashboardConfig(
            auth=DashboardAuthConfig(
                enabled=True,
                username="admin",
                password_env=None,
                password="pw",
            ),
            session_secret="s",
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


def _seed_database(db_path: Path) -> None:
    now = datetime.now(timezone.utc)
    save_host_snapshot(
        HostReport(
            host_name=HOST_NAME,
            host=HOST_ADDRESS,
            success=True,
            metrics=HostMetrics(
                os_pretty_name="Ubuntu 22.04",
                uptime="12 days",
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
                    model=DRIVE_MODEL, serial="SN0001", health="healthy",
                    temperature_c=31,
                ),
                PhysicalDriveInfo(
                    controller=0, enclosure=252, slot=1, state="Onln",
                    model=DRIVE_MODEL, serial="SN0002", health="warning",
                    media_errors=2, temperature_c=33,
                ),
            ],
        ),
        db_path,
    )

    insert_alert(
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


@pytest.fixture()
def env(tmp_path):
    db_path = tmp_path / "web-pages.db"
    _seed_database(db_path)
    app = create_app(config=_make_config(), db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    return client, db_path


def _login(client) -> None:
    response = client.post("/login", data={"username": "admin", "password": "pw"})
    assert response.status_code == 302


# ---------------------------------------------------------------------------
# Step 1 required tests
# ---------------------------------------------------------------------------


def test_overview_page_contains_host(env):
    client, _db_path = env
    _login(client)

    response = client.get("/")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert HOST_NAME in html
    assert "概览" in html
    # Summary counters and Chinese badges are present.
    assert "在线" in html
    assert "离线" in html
    assert "活动告警" in html


def test_host_page_has_disk_section(env):
    client, _db_path = env
    _login(client)

    response = client.get(f"/host/{HOST_NAME}")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "磁盘阵列" in html
    assert "磁盘" in html
    assert DRIVE_MODEL in html
    assert "Virtual Drives" in html
    assert "Physical Drives" in html


def test_settings_shows_poll_interval(env):
    client, _db_path = env
    _login(client)

    response = client.get("/settings")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "600" in html
    assert "Asia/Shanghai" in html
    assert "86400" in html


def test_static_css_served(env):
    client, _db_path = env

    # Static assets are served without login.
    response = client.get("/static/style.css")

    assert response.status_code == 200
    assert "text/css" in response.headers.get("Content-Type", "")


# ---------------------------------------------------------------------------
# Additional guards
# ---------------------------------------------------------------------------


def test_all_pages_require_login(env):
    client, _db_path = env

    for path in ("/", f"/host/{HOST_NAME}", "/alerts", "/settings"):
        response = client.get(path)
        assert response.status_code == 302, path
        assert response.headers["Location"].endswith("/login"), path


def test_overview_empty_state(tmp_path):
    # No configured servers and an empty database -> the empty state appears.
    app = create_app(config=_make_config(servers=[]), db_path=tmp_path / "empty.db")
    app.config.update(TESTING=True)
    client = app.test_client()
    _login(client)

    response = client.get("/")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "还没有添加服务器" in html
    assert 'id="onboard-card"' in html
    assert 'id="onboard-add-host"' in html
    # With no hosts the onboarding block must not be hidden by the shell.
    assert 'id="onboard-card" hidden' not in html


def test_alerts_page_lists_alert_and_ack_button(env):
    client, _db_path = env
    _login(client)

    response = client.get("/alerts")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "CPU 使用率过高" in html
    assert "CPU 使用率 95% 超过阈值" in html
    assert "ack-btn" in html
    assert "data-alert-id" in html


def test_settings_report_ownership_maps_enabled_to_pc(tmp_path):
    app = create_app(
        config=_make_config(daily_enabled=False, weekly_enabled=True),
        db_path=tmp_path / "settings.db",
    )
    app.config.update(TESTING=True)
    client = app.test_client()
    _login(client)

    html = client.get("/settings").get_data(as_text=True)

    assert "关闭" in html  # daily disabled
    assert "PC" in html  # weekly enabled
    assert "日报" in html
    assert "周报" in html


def test_host_page_missing_host_returns_404(env):
    client, _db_path = env
    _login(client)

    response = client.get("/host/does-not-exist")

    assert response.status_code == 404
    assert "未找到" in response.get_data(as_text=True)
