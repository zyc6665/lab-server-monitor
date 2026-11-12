from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.host_probe import ProbeResult
from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DailyReport,
    DashboardAuthConfig,
    DashboardConfig,
    HostConfig,
    HostMetrics,
    HostReport,
    MemorySummary,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.disk_health import AlertEvent
from servermanage.storage import (
    insert_alert,
    persist_host_reports,
    save_host_snapshot,
)
from servermanage.web import create_app

HOST_NAME = "gpu-01"


def _config() -> AppConfig:
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[
            HostConfig(
                name=HOST_NAME,
                host="10.0.0.1",
                port=22,
                username="monitor",
                auth=AuthConfig(type="password", password="pw"),
            )
        ],
        app=AppRuntimeConfig(poll_interval_seconds=600),
        dashboard=DashboardConfig(
            auth=DashboardAuthConfig(
                enabled=True, username="admin", password_env=None, password="pw"
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


def _login(client) -> None:
    assert client.post("/login", data={"username": "admin", "password": "pw"}).status_code == 302


def _seed(db_path: Path) -> None:
    now = datetime.now(timezone.utc)
    report = HostReport(
        host_name=HOST_NAME,
        host="10.0.0.1",
        success=True,
        metrics=HostMetrics(
            collected_at=now,
            cpu_usage_percent=12.5,
            memory=_memory(),
        ),
    )
    persist_host_reports(
        DailyReport(
            generated_at=now,
            subject_prefix="[Test]",
            reports=[report],
        ),
        db_path,
    )
    save_host_snapshot(report, db_path)


def _client(tmp_path: Path):
    db_path = tmp_path / "insight.db"
    _seed(db_path)
    app = create_app(config=_config(), db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    _login(client)
    return client, app, db_path


def test_host_history_24h_returns_points(tmp_path: Path) -> None:
    client, _app, _db_path = _client(tmp_path)

    response = client.get(f"/api/host/{HOST_NAME}/history?range=24h")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["range"] == "24h"
    assert len(payload["points"]) == 1
    point = payload["points"][0]
    assert point["cpu"] == 12.5
    assert point["memory"] == 25.0
    assert "t" in point


def test_overview_history_returns_fleet_average(tmp_path: Path) -> None:
    client, _app, _db_path = _client(tmp_path)

    response = client.get("/api/overview/history?range=24h")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["range"] == "24h"
    assert len(payload["points"]) == 1
    point = payload["points"][0]
    assert point["cpu"] == 12.5
    assert point["memory"] == 25.0
    assert client.get("/api/overview/history?range=99d").status_code == 400


def test_overview_alert_history_counts_by_severity(tmp_path: Path) -> None:
    client, _app, db_path = _client(tmp_path)
    now = datetime.now(timezone.utc)
    insert_alert(
        AlertEvent(
            host_name=HOST_NAME,
            category="cpu",
            severity="critical",
            title="CPU 高",
            message="CPU 持续高于阈值",
            fingerprint="fp-cpu",
        ),
        db_path,
        created_at=now - timedelta(hours=1),
    )
    insert_alert(
        AlertEvent(
            host_name=HOST_NAME,
            category="memory",
            severity="warning",
            title="内存高",
            message="内存持续高于阈值",
            fingerprint="fp-memory",
        ),
        db_path,
        created_at=now - timedelta(hours=2),
    )

    response = client.get("/api/overview/alert-history?range=24h")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["range"] == "24h"
    assert len(payload["buckets"]) == 24
    assert sum(item["critical"] for item in payload["buckets"]) == 1
    assert sum(item["warning"] for item in payload["buckets"]) == 1
    assert sum(item["total"] for item in payload["buckets"]) == 2
    assert client.get("/api/overview/alert-history?range=99d").status_code == 400


def test_host_history_7d_and_invalid(tmp_path: Path) -> None:
    client, _app, _db_path = _client(tmp_path)

    assert client.get(f"/api/host/{HOST_NAME}/history?range=7d").status_code == 200
    assert client.get(f"/api/host/{HOST_NAME}/history?range=99d").status_code == 400
    assert client.get("/api/host/nope/history?range=24h").status_code == 404


def test_system_health_payload(tmp_path: Path) -> None:
    client, _app, db_path = _client(tmp_path)

    response = client.get("/api/system/health")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["version"] == "0.1.128"
    assert payload["hosts_configured"] == 1
    assert payload["db_path"] == str(db_path)
    assert payload["db_size_bytes"] > 0
    assert payload["history_rows"] >= 1
    assert isinstance(payload["tasks"], list)
    diagnostics = payload["diagnostics"]
    assert diagnostics["status"] == "ok"
    assert [item["key"] for item in diagnostics["checks"]] == [
        "database",
        "hosts",
        "disk",
        "tasks",
        "alerts",
    ]
    assert all(item["status"] == "ok" for item in diagnostics["checks"])


def test_system_diagnostics_flags_critical_alert(tmp_path: Path) -> None:
    client, _app, db_path = _client(tmp_path)
    insert_alert(
        AlertEvent(
            host_name=HOST_NAME,
            category="cpu",
            severity="critical",
            title="CPU 持续过高",
            message="CPU 已连续 5 分钟超过 95%",
            fingerprint="fp-critical",
        ),
        db_path,
    )

    payload = client.get("/api/system/health").get_json()

    assert payload["diagnostics"]["status"] == "warning"
    alerts_check = next(
        item for item in payload["diagnostics"]["checks"] if item["key"] == "alerts"
    )
    assert alerts_check["status"] == "warning"
    assert "1 条严重告警" in alerts_check["message"]


def test_system_check_card_and_settings_diagnostics_are_rendered(tmp_path: Path) -> None:
    client, _app, _db_path = _client(tmp_path)

    overview = client.get("/").get_data(as_text=True)
    assert 'id="system-check"' in overview
    assert 'id="system-check-list"' in overview

    settings = client.get("/settings").get_data(as_text=True)
    assert 'id="health-diagnostics"' in settings
    assert 'id="storage-usage"' in settings
    assert 'data-maintenance-target="database"' in settings

    app_js = client.get("/static/app.js").get_data(as_text=True)
    assert "refreshSystemChecks" in app_js
    assert "renderSystemChecks" in app_js

    health_js = client.get("/static/settings-health.js").get_data(as_text=True)
    assert "renderDiagnostics" in health_js
    assert "renderStorage" in health_js
    assert "runMaintenance" in health_js


def test_system_storage_usage_and_invalid_maintenance_target(tmp_path: Path) -> None:
    client, _app, _db_path = _client(tmp_path)

    response = client.get("/api/system/storage")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["log_retention_hours"] == 24
    assert set(payload["usage"]) == {
        "database",
        "logs",
        "updates",
        "electron",
        "total",
    }
    assert payload["usage"]["database"] > 0

    settings = client.get("/settings").get_data(as_text=True)
    token = re.search(r'data-csrf="([^"]+)"', settings).group(1)
    invalid = client.post(
        "/api/system/maintenance",
        json={"target": "not-a-target"},
        headers={"X-CSRF-Token": token},
    )
    assert invalid.status_code == 400


def test_system_maintenance_cleans_expired_logs(tmp_path: Path) -> None:
    app_dir = tmp_path / "portable"
    db_path = app_dir / "data" / "monitor.db"
    db_path.parent.mkdir(parents=True)
    logs_dir = app_dir / "logs"
    logs_dir.mkdir()
    old_log = logs_dir / "old.log"
    old_log.write_text("old", encoding="utf-8")
    when = datetime.now(timezone.utc) - timedelta(hours=30)
    os.utime(old_log, (when.timestamp(), when.timestamp()))
    app = create_app(config=_config(), db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    _login(client)
    settings = client.get("/settings").get_data(as_text=True)
    token = re.search(r'data-csrf="([^"]+)"', settings).group(1)

    response = client.post(
        "/api/system/maintenance",
        json={"target": "logs"},
        headers={"X-CSRF-Token": token},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["result"]["deleted"] == 1
    assert not old_log.exists()


def test_saved_host_probe_returns_probe_payload(tmp_path: Path, monkeypatch) -> None:
    client, _app, _db_path = _client(tmp_path)
    import servermanage.web.routes as routes

    monkeypatch.setattr(
        routes.host_probe,
        "probe_host",
        lambda host, timeout=8: ProbeResult(
            ok=True,
            status="ok",
            message="connected",
            hostname="gpu-01",
            cpu_cores=8,
            memory_total_mb=16384,
            storcli_available=True,
        ),
    )

    response = client.post(f"/api/settings/hosts/{HOST_NAME}/probe")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["hostname"] == "gpu-01"
    assert payload["cpu_cores"] == 8


def test_saved_host_collect_queues_callback(tmp_path: Path) -> None:
    client, app, _db_path = _client(tmp_path)
    calls: list[list[str]] = []
    app.config["ON_HOSTS_IMPORTED"] = lambda names: calls.append(list(names))

    response = client.post(f"/api/settings/hosts/{HOST_NAME}/collect")

    assert response.status_code == 200
    assert response.get_json() == {"ok": True}
    assert calls == [[HOST_NAME]]


def test_saved_host_collect_without_callback_is_conflict(tmp_path: Path) -> None:
    client, _app, _db_path = _client(tmp_path)

    response = client.post(f"/api/settings/hosts/{HOST_NAME}/collect")

    assert response.status_code == 409


def test_saved_hosts_batch_collect_queues_known_names(tmp_path: Path) -> None:
    client, app, _db_path = _client(tmp_path)
    calls: list[list[str]] = []
    app.config["ON_HOSTS_IMPORTED"] = lambda names: calls.append(list(names))

    response = client.post(
        "/api/settings/hosts/collect",
        json={"names": [HOST_NAME, "missing-host"]},
    )

    assert response.status_code == 200
    assert response.get_json() == {"ok": True, "count": 1}
    assert calls == [[HOST_NAME]]


def test_saved_hosts_batch_collect_without_body_queues_all(tmp_path: Path) -> None:
    client, app, _db_path = _client(tmp_path)
    calls: list[list[str]] = []
    app.config["ON_HOSTS_IMPORTED"] = lambda names: calls.append(list(names))

    response = client.post("/api/settings/hosts/collect")

    assert response.status_code == 200
    assert response.get_json() == {"ok": True, "count": 1}
    assert calls == [[HOST_NAME]]


def test_host_detail_renders_diagnostics_and_trend(tmp_path: Path) -> None:
    client, _app, _db_path = _client(tmp_path)

    html = client.get(f"/host/{HOST_NAME}").get_data(as_text=True)

    assert "诊断与操作" in html
    assert "历史趋势" in html
    assert "host-detail.js" in html
    assert 'data-trend="cpu"' in html
    assert 'id="host-tabbar"' in html
    assert 'data-host-tab="storage"' in html
    assert 'data-host-panel="storage"' in html
    js = client.get("/static/host-detail.js").get_data(as_text=True)
    assert "bindHostTabs" in js


def test_legacy_daily_summary_table_is_migrated_with_timezone(tmp_path: Path) -> None:
    import sqlite3

    from servermanage.storage import init_storage

    db_path = tmp_path / "legacy.db"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE host_daily_summary (
                day TEXT NOT NULL,
                host_name TEXT NOT NULL,
                host TEXT NOT NULL,
                sample_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                cpu_sum REAL, cpu_max REAL, cpu_min REAL,
                memory_pct_sum REAL, memory_pct_max REAL,
                disk_pct_sum REAL, disk_pct_max REAL,
                gpu_util_sum REAL, gpu_util_max REAL,
                gpu_memory_pct_sum REAL, gpu_memory_pct_max REAL,
                load_sum REAL, users_sum REAL, processes_sum REAL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (day, host_name)
            );
            INSERT INTO host_daily_summary
                (day, host_name, host, sample_count, success_count, cpu_sum, updated_at)
            VALUES ('2026-11-07', 'gpu-01', '10.0.0.1', 2, 2, 40.0, '2026-11-07T00:00:00+00:00');
            """
        )

    init_storage(db_path, daily_summary_tz="Asia/Shanghai")

    with sqlite3.connect(db_path) as conn:
        columns = [row[1] for row in conn.execute("PRAGMA table_info(host_daily_summary)")]
        rows = list(conn.execute("SELECT day, host_name, tz, cpu_sum FROM host_daily_summary"))
    assert "tz" in columns
    assert rows == [("2026-11-07", "gpu-01", "Asia/Shanghai", 40.0)]
