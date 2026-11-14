"""v0.1.168：整体趋势支持按主机过滤（只读）。"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.storage import fetch_overview_history, init_storage

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _seed(db_path: Path) -> None:
    init_storage(db_path)
    now = datetime.now(timezone.utc)
    rows = []
    for host, cpu in (("a100-zyc", 10.0), ("h100-zyc", 30.0)):
        for minutes in (5, 10):
            rows.append(
                (
                    host,
                    host,
                    (now - timedelta(minutes=minutes)).isoformat(),
                    1,
                    cpu,
                    1024,
                    2048,
                    40.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                )
            )
    with sqlite3.connect(db_path) as conn:
        conn.executemany(
            """
            INSERT INTO host_metrics_history
                (host_name, host, collected_at, success, cpu_usage_percent,
                 memory_used_mb, memory_total_mb, disk_used_percent,
                 gpu_utilization_percent, load_1, gpu_memory_used_mb,
                 gpu_memory_total_mb, total_processes, logged_in_user_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.commit()


def test_history_can_be_filtered_by_host(tmp_path: Path):
    db_path = tmp_path / "servermonitor.db"
    _seed(db_path)

    fleet = fetch_overview_history(db_path, range_key="24h")
    assert fleet, "整体趋势应有点"
    assert {round(point["cpu"], 1) for point in fleet} == {20.0}  # (10 + 30) / 2

    single = fetch_overview_history(db_path, range_key="24h", host="a100-zyc")
    assert single and all(round(point["cpu"], 1) == 10.0 for point in single)

    assert fetch_overview_history(db_path, range_key="24h", host="missing") == []
    # 未知主机在 7 天汇总里同样返回空
    assert fetch_overview_history(db_path, range_key="7d", host="missing") == []


def test_page_and_script_wire_the_host_filter():
    page = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'id="overview-trend-host"' in page
    assert '<option value="">全部主机</option>' in page

    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function populateTrendHosts(hosts)" in js
    assert "populateTrendHosts(hosts);" in js
    assert "'&host=' + encodeURIComponent(host)" in js
    assert "loadOverviewHistory(overviewHistory.range || '24h');" in js

    routes = (ROOT / "servermanage" / "web" / "routes.py").read_text(encoding="utf-8")
    assert 'host=(request.args.get("host") or "").strip() or None,' in routes

    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.168 整体趋势可按主机过滤 -- */" in css
