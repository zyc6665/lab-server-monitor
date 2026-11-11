"""v0.1.98：磁盘健康页温度高亮。"""

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


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    drives = [_drive(0, 42), _drive(1, 58), _drive(2, 72)]
    save_disk_health(
        DiskHealthReport(
            host_name="a100-zyc",
            collected_at=datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc),
            status="ok",
            physical_drives=drives,
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


def test_temperature_cells_carry_threshold_classes(tmp_path: Path):
    client = _client(tmp_path)
    response = client.get("/disk-health")
    assert response.status_code == 200
    html = response.get_data(as_text=True)

    assert 'class="mono disk-temp" ' in html or 'class="mono disk-temp" title' in html
    assert "42 °C" in html and "58 °C" in html and "72 °C" in html
    assert html.count("disk-temp is-hot") == 1
    assert html.count("disk-temp is-critical") == 1
    # 主机头部的最高温度同样着色
    assert "disk-temp-max is-critical" in html


def test_missing_temperature_renders_dash_without_classes(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    drive = _drive(0, None)
    save_disk_health(
        DiskHealthReport(
            host_name="a100-zyc",
            collected_at=datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc),
            status="ok",
            physical_drives=[drive],
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
    html = client.get("/disk-health").get_data(as_text=True)
    assert "disk-temp" in html
    assert "disk-temp is-hot" not in html
    assert "disk-temp is-critical" not in html


def test_template_and_styles_define_threshold_classes():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert "temp >= 65" in html and "temp >= 55" in html
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.98 磁盘温度高亮") :]
    assert ".disk-temp.is-hot" in tail
    assert ".disk-temp.is-critical" in tail
    assert ".disk-temp-max.is-critical" in tail
    assert 'html[data-theme="dark"] .disk-temp.is-critical' in tail
