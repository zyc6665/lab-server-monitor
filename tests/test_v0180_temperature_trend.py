"""v0.1.80：温度进入 24 小时趋势。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.models import (
    DailyReport,
    GPUSummaryRow,
    HostMetrics,
    HostReport,
    ThermalZone,
)
from servermanage.storage import fetch_host_history, init_storage, persist_host_reports

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def _report(at: datetime, zones, gpus=()) -> HostReport:
    return HostReport(
        host_name="a100-zyc",
        host="202.119.189.245",
        success=True,
        metrics=HostMetrics(
            collected_at=at,
            cpu_usage_percent=12.0,
            thermal_zones=zones,
            gpu_summary=list(gpus),
        ),
    )


def test_hottest_temperature_prefers_highest_sensor():
    metrics = HostMetrics(
        thermal_zones=[ThermalZone(label="x86_pkg_temp", celsius=58.0)],
        gpu_summary=[
            GPUSummaryRow(
                index=0,
                name="NVIDIA A100",
                utilization_percent=10,
                temperature_c=71,
                memory_used_mb=1000,
                memory_total_mb=40960,
            )
        ],
    )
    assert metrics.hottest_temperature_c == 71.0
    assert HostMetrics().hottest_temperature_c is None


def test_history_24h_exposes_temperature_points(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    start = datetime.now(timezone.utc) - timedelta(hours=2)
    persist_host_reports(
        DailyReport(
            generated_at=start,
            reports=[
                _report(start, [ThermalZone(label="x86_pkg_temp", celsius=52.0)]),
                _report(
                    start + timedelta(minutes=10),
                    [ThermalZone(label="x86_pkg_temp", celsius=64.5)],
                ),
            ],
            subject_prefix="test",
        ),
        db_path,
    )
    points = fetch_host_history(db_path, "a100-zyc", range_key="24h")
    values = [point["temperature"] for point in points]
    assert 52.0 in values and 64.5 in values


def test_history_daily_ranges_have_no_temperature(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    start = datetime.now(timezone.utc) - timedelta(hours=2)
    persist_host_reports(
        DailyReport(
            generated_at=start,
            reports=[_report(start, [ThermalZone(label="x86_pkg_temp", celsius=52.0)])],
            subject_prefix="test",
        ),
        db_path,
    )
    points = fetch_host_history(db_path, "a100-zyc", range_key="7d")
    assert points
    assert all(point["temperature"] is None for point in points)


def test_template_and_script_render_temperature_chart():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'data-trend="temperature"' in html
    assert 'data-trend-latest="temperature"' in html

    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "temperature: '#e11d48'" in js
    assert "temperature: '温度'" in js
    assert "function trendText(value, key)" in js
    assert "num.toFixed(1) + ' °C'" in js
