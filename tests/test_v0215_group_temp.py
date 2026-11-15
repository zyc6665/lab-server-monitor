"""v0.1.215：磁盘分组标题显示该组最热的单盘温度。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.disk_health import DiskHealthReport, PhysicalDriveInfo
from servermanage.storage import init_storage, save_disk_health
from servermanage.web import create_app

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _report(host: str, temps) -> DiskHealthReport:
    drives = [
        PhysicalDriveInfo(
            controller=0,
            enclosure=252,
            slot=index,
            model="WUH721816ALE6L4",
            serial=f"SN{index}",
            state="Onln",
            health="healthy",
            temperature_c=temp,
        )
        for index, temp in enumerate(temps)
    ]
    return DiskHealthReport(
        host_name=host,
        collected_at=datetime(2026, 11, 15, 8, 0, tzinfo=timezone.utc),
        physical_drives=drives,
    )


def _client(tmp_path: Path):
    db_path = tmp_path / "servermonitor.db"
    init_storage(db_path)
    save_disk_health(_report("gpu-01", [34, 36]), db_path)
    save_disk_health(_report("cpu-01", [58, 61]), db_path)
    config = load_config_from_mapping(
        {
            "servers": [
                {"name": "gpu-01", "host": "10.0.0.1", "port": 22, "username": "root",
                 "group": "GPU", "auth": {"type": "key", "key_data": "PEM"}},
                {"name": "cpu-01", "host": "10.0.0.2", "port": 22, "username": "root",
                 "group": "CPU", "auth": {"type": "key", "key_data": "PEM"}},
            ]
        }
    )
    app = create_app(config=config, db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def test_group_header_shows_hottest_drive(tmp_path: Path):
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)
    assert "最高 36 °C" in html
    assert "最高 61 °C" in html
    assert "disk-group-temp is-hot" in html


def test_group_temp_style_exists():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.215" in css
    assert ".disk-group-temp.is-critical" in css
