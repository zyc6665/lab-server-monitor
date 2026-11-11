"""v0.1.85：主机健康诊断。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.diagnostics import build_host_diagnostics, summarize_diagnostics
from servermanage.models import HostMetrics, HostReport
from servermanage.storage import init_storage, save_host_snapshot
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"

NOW = datetime(2026, 11, 11, 16, 0, tzinfo=timezone.utc)


def _detail(**overrides):
    detail = {
        "success": True,
        "collected_at": (NOW - timedelta(minutes=3)).isoformat(),
        "metrics": {
            "cpu_usage_percent": 12.0,
            "cpu_core_count": 32,
            "load_average": {"load_1": 1.0},
            "memory": {"used_mb": 20000, "total_mb": 256000},
            "disks": [{"mount": "/", "used_percent": 40.0}],
        },
        "errors": [],
        "checks": [],
        "disk": None,
        "users": [],
    }
    detail.update(overrides)
    return detail


def _levels(rows):
    return {row["key"]: row["level"] for row in rows}


def test_healthy_host_is_all_ok():
    rows = build_host_diagnostics(_detail(), now=NOW)
    assert _levels(rows)["collect"] == "ok"
    assert _levels(rows)["cpu"] == "ok"
    assert _levels(rows)["disk"] == "ok"
    summary = summarize_diagnostics(rows)
    assert summary["attention"] == 0


def test_failed_collection_is_first_and_critical():
    rows = build_host_diagnostics(
        _detail(
            success=False,
            collected_at=None,
            errors=[{"stage": "ssh", "message": "连接超时"}],
            metrics={},
        ),
        now=NOW,
    )
    assert rows[0]["key"] == "collect"
    assert rows[0]["level"] == "crit"
    assert "连接超时" in rows[0]["detail"]
    assert len(rows) == 1


def test_stale_snapshot_is_warning():
    stale = (_detail(collected_at=(NOW - timedelta(hours=3)).isoformat()))
    rows = build_host_diagnostics(stale, now=NOW, poll_interval_seconds=600)
    assert _levels(rows)["collect"] == "warn"


def test_pressure_thresholds_are_reported():
    detail = _detail(
        metrics={
            "cpu_usage_percent": 92.0,
            "cpu_core_count": 8,
            "load_average": {"load_1": 20.0},
            "memory": {"used_mb": 92000, "total_mb": 100000},
            "disks": [{"mount": "/data", "used_percent": 96.0}],
            "gpu_summary": [
                {"index": 0, "memory_used_mb": 76000, "memory_total_mb": 80000,
                 "temperature_c": 88},
            ],
            "thermal_zones": [{"label": "x86", "celsius": 87.0}],
        },
    )
    levels = _levels(build_host_diagnostics(detail, now=NOW))
    assert levels["cpu"] == "warn"
    assert levels["load"] == "crit"
    assert levels["memory"] == "warn"
    assert levels["disk"] == "crit"
    assert levels["gpu_memory"] == "warn"
    assert levels["temperature"] == "crit"


def test_checks_disk_array_and_accounts():
    detail = _detail(
        checks=[{"check_name": "SSH", "status": "error"}, {"check_name": "nginx", "status": "ok"}],
        disk={"status": "ok", "drives": [{"health": "healthy"}, {"health": "failed"}]},
        users=[{"name": "a", "issues": []}, {"name": "b", "issues": ["user-data"]}],
    )
    rows = build_host_diagnostics(detail, now=NOW)
    levels = _levels(rows)
    assert levels["checks"] == "warn"
    assert levels["disk_health"] == "crit"
    assert levels["accounts"] == "warn"


def test_missing_storcli_is_warning():
    detail = _detail(disk={"status": "no_storcli", "message": "未找到 storcli", "drives": []})
    row = [r for r in build_host_diagnostics(detail, now=NOW) if r["key"] == "disk_health"][0]
    assert row["level"] == "warn"
    assert "storcli" in row["detail"]


def test_host_page_renders_diagnostics(tmp_path: Path):
    app = create_app(
        config=load_config_from_mapping(
            {
                "report": {"daily_enabled": False, "weekly": {"enabled": False}},
                "dashboard": {"auth": {"password": "secret"}},
                "servers": [
                    {
                        "name": "a100-zyc",
                        "host": "10.0.0.1",
                        "username": "root",
                        "auth": {"type": "key", "key_data": "PEM"},
                    }
                ],
            }
        ),
        db_path=tmp_path / "monitor.db",
    )
    init_storage(tmp_path / "monitor.db")
    save_host_snapshot(
        HostReport(
            host_name="a100-zyc",
            host="10.0.0.1",
            success=True,
            metrics=HostMetrics(
                collected_at=datetime.now(timezone.utc),
                cpu_usage_percent=95.0,
                cpu_core_count=32,
            ),
        ),
        tmp_path / "monitor.db",
    )
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    html = client.get("/host/a100-zyc").get_data(as_text=True)
    assert 'id="host-diagnostics"' in html
    assert "健康诊断" in html
    assert 'data-diag-key="collect"' in html
    assert "diag-item diag-" in html
    payload = client.get("/api/host/a100-zyc").get_json()
    assert any(row["key"] == "cpu" and row["level"] == "warn" for row in payload["diagnostics"])


def test_styles_cover_levels_and_dark_theme():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.85 主机健康诊断") :]
    assert ".diag-list {" in tail
    assert ".diag-dot" in tail
    assert ".diag-warn .diag-dot" in tail
    assert ".diag-crit .diag-dot" in tail
    assert ".diag-hint" in tail
    assert ".badge-warning" in tail
    assert 'html[data-theme="dark"] .diag-crit .diag-dot' in tail
    assert "@media (max-width: 760px)" in tail

def test_string_errors_are_tolerated():
    """Older snapshots store errors as plain strings; diagnostics must not crash."""

    rows = build_host_diagnostics(
        _detail(
            success=False,
            collected_at=None,
            errors=["ssh: connect to host 10.0.0.1 port 22: Connection refused"],
            metrics={},
        ),
        now=NOW,
    )
    assert rows[0]["key"] == "collect"
    assert "Connection refused" in rows[0]["detail"]
