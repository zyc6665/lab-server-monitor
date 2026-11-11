"""v0.1.81：概览显示当前最高温度。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.models import GPUSummaryRow, HostMetrics, HostReport, ThermalZone
from servermanage.storage import init_storage, save_host_snapshot
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def _config():
    return load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "a100-zyc",
                    "host": "202.119.189.245",
                    "username": "root",
                    "group": "GPU",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    app = create_app(config=_config(), db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client, db_path


def _snapshot(db_path: Path, metrics: HostMetrics) -> None:
    save_host_snapshot(
        HostReport(
            host_name="a100-zyc",
            host="202.119.189.245",
            success=True,
            metrics=metrics,
        ),
        db_path,
    )


def test_overview_reports_hottest_temperature(tmp_path: Path):
    client, db_path = _client(tmp_path)
    init_storage(db_path)
    _snapshot(
        db_path,
        HostMetrics(
            collected_at=datetime.now(timezone.utc),
            thermal_zones=[ThermalZone(label="x86_pkg_temp", celsius=58.0)],
            gpu_summary=[
                GPUSummaryRow(
                    index=0,
                    name="NVIDIA A100",
                    utilization_percent=12,
                    temperature_c=77,
                    memory_used_mb=1000,
                    memory_total_mb=40960,
                )
            ],
        ),
    )
    payload = client.get("/api/overview").get_json()
    row = payload["hosts"][0]
    assert row["temperature_c"] == 77.0


def test_overview_without_sensors_reports_null(tmp_path: Path):
    client, db_path = _client(tmp_path)
    init_storage(db_path)
    _snapshot(db_path, HostMetrics(collected_at=datetime.now(timezone.utc)))
    payload = client.get("/api/overview").get_json()
    assert payload["hosts"][0]["temperature_c"] is None


def test_host_row_without_snapshot_has_null_temperature(tmp_path: Path):
    client, _db = _client(tmp_path)
    payload = client.get("/api/overview").get_json()
    assert payload["hosts"][0]["temperature_c"] is None


def test_chip_rendering_and_styles():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function temperatureChip(value)" in js
    assert "chip.textContent = Math.round(num) + '°';" in js
    assert "if (num >= 85) { chip.classList.add('is-critical'); }" in js
    assert "else if (num >= 70) { chip.classList.add('is-hot'); }" in js
    assert "var rowTemp = temperatureChip(host.temperature_c);" in js
    assert "var cardTemp = temperatureChip(host.temperature_c);" in js

    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.81 概览温度徽标") :]
    assert ".temp-chip" in tail
    assert ".temp-chip.is-hot" in tail
    assert ".temp-chip.is-critical" in tail
    assert 'html[data-theme="dark"] .temp-chip.is-critical' in tail
