from __future__ import annotations

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
from servermanage.storage import persist_host_reports
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
    persist_host_reports(
        DailyReport(
            generated_at=now,
            subject_prefix="[Test]",
            reports=[
                HostReport(
                    host_name=HOST_NAME,
                    host="10.0.0.1",
                    success=True,
                    metrics=HostMetrics(
                        collected_at=now,
                        cpu_usage_percent=12.5,
                        memory=_memory(),
                    ),
                )
            ],
        ),
        db_path,
    )


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
    assert payload["version"] == "0.1.1"
    assert payload["hosts_configured"] == 1
    assert payload["db_path"] == str(db_path)
    assert payload["db_size_bytes"] > 0
    assert payload["history_rows"] >= 1
    assert isinstance(payload["tasks"], list)


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


def test_host_detail_renders_diagnostics_and_trend(tmp_path: Path) -> None:
    client, _app, _db_path = _client(tmp_path)

    html = client.get(f"/host/{HOST_NAME}").get_data(as_text=True)

    assert "诊断与操作" in html
    assert "历史趋势" in html
    assert "host-detail.js" in html
    assert 'data-trend="cpu"' in html
