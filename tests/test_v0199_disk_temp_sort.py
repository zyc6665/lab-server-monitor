"""v0.1.99：磁盘健康页每台主机内按温度排序（热盘在前）。"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.disk_health import DiskHealthReport, PhysicalDriveInfo
from servermanage.storage import save_disk_health
from servermanage.web import create_app

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
    save_disk_health(
        DiskHealthReport(
            host_name="a100-zyc",
            collected_at=datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc),
            status="ok",
            physical_drives=[_drive(0, 31), _drive(1, 72), _drive(2, None), _drive(3, 55)],
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


def test_drives_are_ordered_by_temperature(tmp_path: Path):
    client = _client(tmp_path)
    response = client.get("/disk-health")
    assert response.status_code == 200
    html = response.get_data(as_text=True)

    section = html[html.index('id="disk-a100-zyc"') :]
    cells = re.findall(r'<td class="mono disk-temp[^"]*"[^>]*>\s*(.*?)\s*</td>', section, re.S)
    # 单元格里现在还有热度小柱，比较时只取文本
    temps = [" ".join(re.sub(r"<[^>]+>", "", cell).split()) for cell in cells]
    assert temps == ["72 °C", "55 °C", "31 °C", "—"], temps


def test_section_head_documents_the_order(tmp_path: Path):
    client = _client(tmp_path)
    html = client.get("/disk-health").get_data(as_text=True)
    assert "每台按温度排序，热盘在前" in html


def test_sort_helper_handles_missing_values():
    from servermanage.web.routes import _drive_sort_key

    keys = [_drive_sort_key(drive) for drive in ({"temperature_c": 31}, {"temperature_c": None}, {"temperature_c": 72})]
    ordered = [key for _, key in sorted(zip(keys, (31, None, 72)), key=lambda pair: pair[0])]
    assert ordered == [72, 31, None]


def test_template_mentions_sorting():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert "热盘在前" in html
