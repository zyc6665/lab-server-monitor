"""v0.7.1：磁盘健康页按主机分组展示物理盘。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.disk_health import DiskHealthReport, PhysicalDriveInfo
from servermanage.storage import save_disk_health
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
                },
                {
                    "name": "4090-zyc",
                    "host": "10.202.2.228",
                    "username": "root",
                    "group": "GPU",
                    "auth": {"type": "key", "key_data": "PEM"},
                },
                {
                    "name": "k80-zyc",
                    "host": "202.119.189.234",
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                },
            ],
        }
    )


def _drive(slot: int, serial: str, health: str = "healthy", temperature: int = 30) -> PhysicalDriveInfo:
    return PhysicalDriveInfo(
        controller=0,
        enclosure=252,
        slot=slot,
        state="Onln",
        model="WUH721816ALE6L4",
        serial=serial,
        health=health,
        temperature_c=temperature,
    )


def _seed(db_path: Path) -> None:
    now = datetime.now(timezone.utc)
    save_disk_health(
        DiskHealthReport(
            host_name="a100-zyc",
            collected_at=now,
            status="ok",
            physical_drives=[_drive(0, "SN-A100-0"), _drive(1, "SN-A100-1")],
        ),
        db_path,
    )
    save_disk_health(
        DiskHealthReport(
            host_name="4090-zyc",
            collected_at=now,
            status="warning",
            physical_drives=[_drive(2, "SN-4090-2", health="warning", temperature=41)],
        ),
        db_path,
    )
    save_disk_health(
        DiskHealthReport(
            host_name="k80-zyc",
            collected_at=now,
            status="no_storcli",
            message="未找到可用的 storcli 可执行文件",
            physical_drives=[],
        ),
        db_path,
    )


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _seed(db_path)
    app = create_app(config=_config(), db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client


def _section(html: str, anchor: str) -> str:
    marker = f'id="disk-{anchor}"'
    start = html.index(marker)
    end = html.find('class="disk-host"', start + len(marker))
    return html[start : end if end != -1 else len(html)]


def test_each_host_gets_its_own_drive_section(tmp_path: Path) -> None:
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)

    assert "按主机查看物理盘" in html
    for anchor in ("a100-zyc", "4090-zyc", "k80-zyc"):
        assert f'id="disk-{anchor}"' in html, anchor

    a100 = _section(html, "a100-zyc")
    assert "SN-A100-0" in a100 and "SN-A100-1" in a100
    assert "SN-4090-2" not in a100

    other = _section(html, "4090-zyc")
    assert "SN-4090-2" in other
    assert "SN-A100-0" not in other


def test_attention_hosts_come_first_and_empty_hosts_explain_why(tmp_path: Path) -> None:
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)

    assert html.index('id="disk-4090-zyc"') < html.index('id="disk-a100-zyc"')
    assert "未找到可用的 storcli 可执行文件" in _section(html, "k80-zyc")


def test_jump_nav_and_counts_are_rendered(tmp_path: Path) -> None:
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)

    assert 'class="disk-jump"' in html
    assert 'href="#disk-a100-zyc"' in html
    assert 'href="#disk-4090-zyc"' in html
    assert "<b>2</b> 健康 · <b>0</b> 告警 · <b>0</b> 严重" in html
    assert "<b>0</b> 健康 · <b>1</b> 告警 · <b>0</b> 严重" in html
    assert "最高 41 °C" in html


def test_flat_all_hosts_drive_table_is_gone(tmp_path: Path) -> None:
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)

    assert "物理盘明细" not in html
    # 主机概览表与分组信息重复，已合并进每个主机区块的头部。
    assert "主机磁盘概览" not in html
    # 每块盘只出现一次，不再有“主机”列的扁平总表。
    assert html.count("SN-A100-0") == 1
    assert html.count("SN-4090-2") == 1


def test_grouping_styles_and_tab_scroller_are_present() -> None:
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.7.1 磁盘健康按主机分组" in css
    for selector in (".disk-jump {", ".disk-jump-link {", ".disk-host {", ".disk-host-head {", ".disk-table {"):
        assert selector in css, selector
    assert "scroll-margin-top: 96px" in css
    assert "flex-wrap: nowrap" in css  # 窄屏标签条横向滚动

    script = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "scrollIntoView({ block: 'nearest', inline: 'center' })" in script
