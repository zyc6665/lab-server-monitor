"""v0.1.119：磁盘健康页按分组折叠。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.disk_health import DiskHealthReport, PhysicalDriveInfo
from servermanage.storage import save_disk_health
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def _drive(slot: int, serial: str) -> PhysicalDriveInfo:
    return PhysicalDriveInfo(
        controller=0,
        enclosure=252,
        slot=slot,
        state="Optl",
        model="WUH721816ALE6L4",
        serial=serial,
        temperature_c=31,
        health="ok",
    )


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    for name, serial in (("a100-zyc", "SERIALA100"), ("k80-zyc", "SERIALK80")):
        save_disk_health(
            DiskHealthReport(
                host_name=name,
                collected_at=datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc),
                status="ok",
                physical_drives=[_drive(0, serial)],
            ),
            db_path,
        )
    config = load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "a100-zyc",
                    "host": "202.119.189.245",
                    "username": "root",
                    "group": "GPU 节点",
                    "auth": {"type": "key", "key_data": "PEM"},
                },
                {
                    "name": "k80-zyc",
                    "host": "202.119.189.246",
                    "username": "root",
                    "group": "训练节点",
                    "auth": {"type": "key", "key_data": "PEM"},
                },
            ],
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


def _page(tmp_path):
    return _client(tmp_path).get("/disk-health").get_data(as_text=True)


def test_group_headers_render_once_per_group(tmp_path):
    html = _page(tmp_path)
    assert html.count('class="disk-group-head"') == 2
    assert 'data-disk-group="GPU 节点"' in html
    assert 'data-disk-group="训练节点"' in html
    assert "1 台主机" in html


def test_hosts_carry_group_marker(tmp_path):
    html = _page(tmp_path)
    assert 'data-disk-group-member="GPU 节点"' in html
    assert 'data-disk-group-member="训练节点"' in html


def test_script_supports_group_collapse():
    script = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "var GROUP_KEY = 'disk:collapsed-groups';" in script
    assert "function setGroupCollapsed(head, collapsed)" in script
    assert "head.hidden = !matchedGroups[name];" in script
    assert "[data-disk-group-collapse]" in script


def test_style_covers_group_header():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    block = css[css.index("v0.1.119 磁盘按分组折叠") :]
    for selector in (".disk-group-head", ".disk-group-collapse", ".disk-group-name", ".disk-group-count"):
        assert selector in block
    assert 'html[data-theme="dark"] .disk-group-collapse:hover' in block
