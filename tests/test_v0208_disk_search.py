"""v0.1.108：磁盘健康页搜索。"""

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
                    "group": "gpu",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )


def _drive(slot: int, model: str, serial: str) -> PhysicalDriveInfo:
    return PhysicalDriveInfo(
        controller=0,
        enclosure=252,
        slot=slot,
        state="Optl",
        model=model,
        serial=serial,
        temperature_c=31,
        health="ok",
    )


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    save_disk_health(
        DiskHealthReport(
            host_name="a100-zyc",
            collected_at=datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc),
            status="ok",
            physical_drives=[
                _drive(0, "WUH721816ALE6L4", "SERIALA100"),
                _drive(1, "INTELSSDSC2KB", "SERIALB200"),
            ],
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


def test_search_input_is_rendered(tmp_path: Path):
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)
    assert 'id="disk-search"' in html
    assert 'id="disk-search-empty"' in html
    assert "搜索主机、分组、盘型号或序列号" in html


def test_host_block_carries_lowercase_search_text(tmp_path: Path):
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)
    assert 'data-disk-search="a100-zyc gpu 202.119.189.245' in html
    # 型号与序列号都在搜索文本里，方便按盘找主机
    assert "wuh721816ale6l4" in html
    assert "seriala100" in html


def test_jump_links_are_searchable(tmp_path: Path):
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)
    assert '<a class="disk-jump-link" href="#disk-a100-zyc" data-disk-issues="0" data-disk-search="a100-zyc">' in html


def test_script_combines_both_filters():
    script = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "function matchesSearch(el, needle)" in script
    assert "data-disk-search" in script
    assert "var matched = !((onlyIssues && !isIssue(el)) || !matchesSearch(el, needle));" in script
    assert "el.hidden = !matched || collapsed;" in script
    assert "search.addEventListener('input'" in script
    assert "searchEmpty.hidden = !needle || visibleHosts > 0;" in script


def test_styles_cover_search_box():
    tail = (STATIC / "style.css").read_text(encoding="utf-8").split("v0.1.108 磁盘健康搜索")[1]
    assert ".disk-filter .disk-search {" in tail
    assert "border-color: var(--accent);" in tail
    assert 'html[data-theme="dark"] .disk-filter .disk-search' in tail


def test_template_mentions_search_hint():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert "没有匹配的磁盘记录。" in html
