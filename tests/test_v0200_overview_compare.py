"""v0.1.100：概览整体趋势叠加「上一周期」虚线对比。"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.storage import fetch_overview_history, init_storage
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"
NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
SHANGHAI = ZoneInfo("Asia/Shanghai")


def _seed(db_path: Path, day: str, cpu_sum: float) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO host_daily_summary
                (day, host_name, tz, host, sample_count, success_count,
                 cpu_sum, memory_pct_sum, disk_pct_sum, gpu_util_sum,
                 gpu_memory_pct_sum, load_sum, updated_at)
            VALUES (?, 'gpu-01', 'Asia/Shanghai', '10.0.0.1', 2, 2, ?, 50.0, 40.0, 10.0, 20.0, 1.0,
                    '2026-11-11T00:00:00+00:00')
            """,
            (day, cpu_sum),
        )


def _config():
    return load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "gpu-01",
                    "host": "10.0.0.1",
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )


def test_offset_days_returns_previous_window(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    _seed(db_path, "2026-11-10", 20.0)  # 当前 7 天窗口
    _seed(db_path, "2026-11-02", 80.0)  # 上一周期

    current = fetch_overview_history(db_path, range_key="7d", now=NOW, tz=SHANGHAI)
    previous = fetch_overview_history(db_path, range_key="7d", now=NOW, tz=SHANGHAI, offset_days=7)

    assert [point["t"] for point in current] == ["2026-11-10"]
    assert [point["t"] for point in previous] == ["2026-11-02"]
    assert current[0]["cpu"] == 10.0
    assert previous[0]["cpu"] == 40.0


def test_negative_offset_is_rejected(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    try:
        fetch_overview_history(db_path, range_key="7d", now=NOW, offset_days=-1)
    except ValueError as exc:
        assert "offset_days" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("negative offset should raise")


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    _seed(db_path, "2026-11-10", 20.0)
    _seed(db_path, "2026-11-02", 80.0)
    app = create_app(config=_config(), db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def test_api_returns_previous_series_for_daily_ranges(tmp_path: Path):
    client = _client(tmp_path)
    payload = client.get("/api/overview/history?range=7d&compare=1").get_json()
    assert [point["t"] for point in payload["points"]] == ["2026-11-10"]
    assert [point["t"] for point in payload["previous"]] == ["2026-11-02"]


def test_api_skips_previous_for_24h(tmp_path: Path):
    client = _client(tmp_path)
    payload = client.get("/api/overview/history?range=24h&compare=1").get_json()
    assert payload["previous"] == []


def test_api_without_compare_keeps_old_shape(tmp_path: Path):
    client = _client(tmp_path)
    payload = client.get("/api/overview/history?range=7d").get_json()
    assert "previous" not in payload


def test_frontend_draws_dashed_comparison():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function overviewPath(" in script
    assert "compare=1&range=" in script
    assert "'stroke-dasharray': '4 4'" in script
    template = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'id="overview-trend-hint"' in template
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert ".trend-hint[hidden]" in css
