"""v0.1.107：磁盘健康页温度汇总。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.disk_health import DiskHealthReport, PhysicalDriveInfo
from servermanage.storage import save_disk_health
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


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
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )


def _drive(slot: int, temp: int | None) -> PhysicalDriveInfo:
    return PhysicalDriveInfo(
        controller=0,
        enclosure=252,
        slot=slot,
        state="Optl",
        model="WUH721816ALE6L4",
        temperature_c=temp,
        health="ok",
    )


def _client(tmp_path: Path, temps=(31, 41, 61, None)):
    db_path = tmp_path / "monitor.db"
    save_disk_health(
        DiskHealthReport(
            host_name="a100-zyc",
            collected_at=datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc),
            status="ok",
            physical_drives=[_drive(index, temp) for index, temp in enumerate(temps)],
        ),
        db_path,
    )
    app = create_app(config=_config(), db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def test_summary_reports_max_average_and_hot_count(tmp_path: Path):
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)
    assert "温度 最高 61 °C" in html
    # (31 + 41 + 61) / 3 = 44.3，缺温度的盘不参与统计
    assert "平均 44.3 °C" in html
    assert "1 块 ≥55 °C" in html


def test_summary_hides_hot_count_when_all_cool(tmp_path: Path):
    html = _client(tmp_path, temps=(31, 41, 51)).get("/disk-health").get_data(as_text=True)
    assert "温度 最高 51 °C" in html
    assert "≥55 °C" not in html


def test_summary_is_absent_without_temperatures(tmp_path: Path):
    html = _client(tmp_path, temps=(None, None)).get("/disk-health").get_data(as_text=True)
    assert "disk-temp-summary" not in html


def test_styles_cover_the_summary():
    tail = (STATIC / "style.css").read_text(encoding="utf-8").split("v0.1.107 磁盘温度汇总")[1]
    assert ".disk-temp-summary {" in tail
    assert ".disk-temp-summary-hot { color: #b45309; font-weight: 600; }" in tail
    assert 'html[data-theme="dark"] .disk-temp-summary-hot' in tail


def test_template_mentions_the_summary():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert "temperature_stats" in html
    assert "仅统计上报了温度的盘位" in html
