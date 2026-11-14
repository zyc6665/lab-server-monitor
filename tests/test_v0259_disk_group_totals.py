"""v0.1.159：磁盘健康页分组头显示该组合计（主机数、健康/告警/严重盘数）。"""

from __future__ import annotations

from pathlib import Path

from datetime import datetime, timezone

from servermanage.disk_health import DiskHealthReport, PhysicalDriveInfo
from servermanage.storage import init_storage, save_disk_health

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _disk_health(host: str, states):
    drives = [
        PhysicalDriveInfo(
            controller=0,
            enclosure=252,
            slot=index,
            model="WUH721816ALE6L4",
            serial=f"SN{index}",
            state="Onln",
            health="healthy" if state == "ok" else state,
            temperature_c=30 + index,
        )
        for index, state in enumerate(states)
    ]
    return DiskHealthReport(
        host_name=host,
        collected_at=datetime(2026, 11, 14, 8, 0, tzinfo=timezone.utc),
        physical_drives=drives,
    )


def test_group_totals_are_computed(tmp_path: Path):
    from servermanage.config import load_config_from_mapping
    from servermanage.web import create_app

    db_path = tmp_path / "servermonitor.db"
    init_storage(db_path)
    save_disk_health(_disk_health("gpu-01", ["ok", "ok"]), db_path)
    save_disk_health(_disk_health("gpu-02", ["ok", "warning"]), db_path)
    save_disk_health(_disk_health("cpu-01", ["ok", "critical"]), db_path)

    config = load_config_from_mapping(
        {
            "servers": [
                {"name": "gpu-01", "host": "10.0.0.1", "port": 22, "username": "root",
                 "group": "GPU", "auth": {"type": "key", "key_data": "PEM"}},
                {"name": "gpu-02", "host": "10.0.0.2", "port": 22, "username": "root",
                 "group": "GPU", "auth": {"type": "key", "key_data": "PEM"}},
                {"name": "cpu-01", "host": "10.0.0.3", "port": 22, "username": "root",
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

    html = client.get("/disk-health").get_data(as_text=True)
    assert "disk-group-health" in html
    # GPU 组：2 台主机、3 块健康、1 块告警；CPU 组：1 台、1 健康、1 严重
    assert "<b>3</b> 健康" in html
    assert '<b class="is-warn">1</b> 告警' in html
    assert '<b class="is-crit">1</b> 严重' in html

    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.159 磁盘分组显示合计 -- */" in css
    assert ".disk-group-health b.is-warn { color: #b45309; }" in css
