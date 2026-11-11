"""v0.1.120：主机详情最近 7 天告警分布。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.config import load_config_from_mapping
from servermanage.disk_health import AlertEvent
from servermanage.web import create_app
from servermanage.web.routes import _host_alert_days

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


def test_alert_days_bucket_by_local_day():
    tz = timezone(timedelta(hours=8))
    now = datetime(2026, 11, 12, 10, 0, tzinfo=tz)
    alerts = [
        {"created_at": _iso(datetime(2026, 11, 12, 9, 0, tzinfo=tz)), "severity": "critical"},
        {"created_at": _iso(datetime(2026, 11, 12, 8, 0, tzinfo=tz)), "severity": "warning"},
        {"created_at": _iso(datetime(2026, 11, 10, 20, 0, tzinfo=tz)), "severity": "info"},
        {"created_at": _iso(datetime(2026, 10, 1, 8, 0, tzinfo=tz)), "severity": "critical"},
        {"created_at": "junk", "severity": "critical"},
    ]
    days = _host_alert_days(alerts, tz, now=now)
    assert len(days) == 7
    assert days[0]["key"] == "2026-11-06"
    assert days[-1]["key"] == "2026-11-12"
    today = days[-1]
    assert (today["total"], today["critical"], today["warning"]) == (2, 1, 1)
    assert days[-3]["total"] == 1
    assert days[-1]["height"] == 100


def test_alert_days_empty_when_nothing_matches():
    tz = timezone.utc
    now = datetime(2026, 11, 12, 10, 0, tzinfo=tz)
    days = _host_alert_days([], tz, now=now)
    assert all(day["total"] == 0 and day["height"] == 0 for day in days)


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    storage.init_storage(db_path)
    storage.insert_alert(
        AlertEvent(
            host_name="a100-zyc",
            category="host",
            severity="critical",
            title="a100-zyc 离线",
            message="最近一次采集失败",
            fingerprint="a100-zyc:offline",
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
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )
    app = create_app(config=config, db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client


def test_host_page_renders_alert_days(tmp_path):
    page = _client(tmp_path).get("/host/a100-zyc")
    assert page.status_code == 200
    html = page.get_data(as_text=True)
    assert "host-alert-days" in html
    assert 'data-alert-day="' in html
    assert "host-alert-day-label" in html


def test_style_covers_alert_days():
    css = STATIC.joinpath("style.css").read_text(encoding="utf-8")
    block = css[css.index("v0.1.120 主机最近告警分布"):]
    assert ".host-alert-days" in block
    assert "grid-template-columns: repeat(7, minmax(0, 1fr));" in block
    assert ".host-alert-seg-critical" in block
    assert 'html[data-theme="dark"] .host-alert-day-bar' in block
