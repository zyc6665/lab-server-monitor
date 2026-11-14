"""v0.1.111：概览趋势支持 90 天。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from servermanage.config import load_config_from_mapping
import sqlite3

from servermanage.storage import fetch_overview_history, init_storage
from servermanage.web import create_app

TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"
SHANGHAI = ZoneInfo("Asia/Shanghai")


def _seed(db_path: Path, days: int, start_cpu: float = 10.0) -> None:
    init_storage(db_path)
    now = datetime.now(timezone.utc)
    rows = []
    for offset in range(days):
        day = (now.astimezone(SHANGHAI).date() - timedelta(days=offset)).isoformat()
        rows.append(
            (
                day,
                "a100-zyc",
                "Asia/Shanghai",
                "202.119.189.245",
                1,
                1,
                start_cpu + offset,
                start_cpu + offset,
                start_cpu + offset,
                20.0,
                20.0,
                30.0,
                30.0,
                5.0,
                5.0,
                6.0,
                6.0,
                1.0,
                0.0,
                0.0,
                now.isoformat(),
            )
        )
    with sqlite3.connect(db_path) as conn:
        conn.executemany(
            """
            INSERT OR REPLACE INTO host_daily_summary
                (day, host_name, tz, host, sample_count, success_count,
                 cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
                 disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
                 gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
                 processes_sum, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            rows,
        )


def test_ninety_day_window_reads_daily_summaries(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _seed(db_path, 95)
    points = fetch_overview_history(
        db_path,
        range_key="90d",
        tz=SHANGHAI,
        now=datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc),
    )
    assert len(points) == 90
    assert points[-1]["t"] == "2026-11-11"


def test_ninety_day_previous_period_shifts_back(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _seed(db_path, 200, start_cpu=10.0)
    now = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
    current = fetch_overview_history(db_path, range_key="90d", tz=SHANGHAI, now=now)
    previous = fetch_overview_history(db_path, range_key="90d", tz=SHANGHAI, now=now, offset_days=90)
    assert current and previous
    assert previous[-1]["t"] < current[0]["t"]


def test_invalid_range_still_rejected(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    with pytest.raises(ValueError):
        fetch_overview_history(db_path, range_key="365d")


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _seed(db_path, 95)
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
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def test_api_accepts_ninety_days(tmp_path: Path):
    client = _client(tmp_path)
    payload = client.get("/api/overview/history?range=90d&compare=1").get_json()
    assert payload["range"] == "90d"
    # 接口按真实“今天”取窗口，种子也从今天往前铺，确保窗口内天数稳定
    assert 88 <= len(payload["points"]) <= 90
    assert isinstance(payload["previous"], list)


def test_api_still_rejects_unknown_range(tmp_path: Path):
    client = _client(tmp_path)
    assert client.get("/api/overview/history?range=365d").status_code == 400


def test_template_has_ninety_day_tab():
    html = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'data-overview-range="90d">90 天<' in html
