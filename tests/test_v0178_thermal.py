"""v0.1.78：温度概览（只读）。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.commands import THERMAL_STAGE
from servermanage.config import load_config_from_mapping
from servermanage.models import CommandResult, HostMetrics, HostReport, ThermalZone
from servermanage.parsers import parse_host_metrics, parse_thermal_zones
from servermanage.storage import get_host_snapshot, init_storage, save_host_snapshot
from servermanage.web import create_app

TAB = chr(9)


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


def _snapshot(db_path: Path, zones: list[ThermalZone]) -> None:
    save_host_snapshot(
        HostReport(
            host_name="a100-zyc",
            host="202.119.189.245",
            success=True,
            metrics=HostMetrics(
                collected_at=datetime(2026, 11, 11, 5, 0, tzinfo=timezone.utc),
                thermal_zones=zones,
            ),
        ),
        db_path,
    )


def test_parse_thermal_zones_reads_millidegrees():
    output = (
        "x86_pkg_temp" + TAB + "58000" + chr(10)
        + "acpitz" + TAB + "27800" + chr(10)
        + "nvme" + TAB + "41850" + chr(10)
    )
    zones = parse_thermal_zones(output)
    assert [zone.label for zone in zones] == ["x86_pkg_temp", "nvme", "acpitz"]
    assert zones[0].celsius == 58.0
    assert zones[2].celsius == 27.8


def test_parse_thermal_zones_skips_noise_and_duplicates():
    output = (
        "bad line without tab" + chr(10)
        + "coretemp" + TAB + "not-a-number" + chr(10)
        + "zero" + TAB + "0" + chr(10)
        + "huge" + TAB + "250000" + chr(10)
        + "acpitz" + TAB + "30000" + chr(10)
        + "acpitz" + TAB + "99000" + chr(10)
    )
    zones = parse_thermal_zones(output)
    assert zones == [ThermalZone(label="acpitz", celsius=30.0)]


def test_parse_thermal_zones_handles_empty_and_caps():
    assert parse_thermal_zones("") == []
    assert parse_thermal_zones(None) == []
    output = chr(10).join(f"zone{i}" + TAB + str(40000 + i) for i in range(30))
    assert len(parse_thermal_zones(output)) == 20


def test_parse_host_metrics_includes_thermal_zones():
    results = {
        THERMAL_STAGE: CommandResult(
            stdout="x86_pkg_temp" + TAB + "61000" + chr(10), stderr="", exit_status=0
        )
    }
    metrics = parse_host_metrics(results, _config().servers[0])
    assert [zone.label for zone in metrics.thermal_zones] == ["x86_pkg_temp"]
    assert metrics.thermal_zones[0].celsius == 61.0


def test_snapshot_round_trip_keeps_thermal_zones(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    _snapshot(db_path, [ThermalZone(label="x86_pkg_temp", celsius=57.5)])
    snapshot = get_host_snapshot("a100-zyc", db_path)
    zones = snapshot["metrics"]["thermal_zones"]
    assert zones[0]["label"] == "x86_pkg_temp"
    assert zones[0]["celsius"] == 57.5


def test_host_page_shows_thermal_zones(tmp_path: Path):
    client, db_path = _client(tmp_path)
    _snapshot(
        db_path,
        [
            ThermalZone(label="x86_pkg_temp", celsius=74.0),
            ThermalZone(label="acpitz", celsius=28.0),
        ],
    )
    html = client.get("/host/a100-zyc").get_data(as_text=True)
    assert "kv-thermal" in html
    assert "温度" in html
    assert "74.0 °C" in html
    assert "is-hot" in html
    assert "thermal-chip" in html


def test_thermal_styles_are_wired():
    static = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
    css = (static / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.78 温度概览") :]
    assert ".kv-thermal .thermal-max" in tail
    assert ".kv-thermal .thermal-chip" in tail
    assert 'html[data-theme="dark"] .kv-thermal .thermal-chip' in tail
