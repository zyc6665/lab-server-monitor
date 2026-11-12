"""v0.1.128：主机详情采集时间线。"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.storage import init_storage

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "servermanage" / "web" / "templates" / "host.html"
STYLE = ROOT / "servermanage" / "web" / "static" / "style.css"
ROUTES = ROOT / "servermanage" / "web" / "routes.py"


def _insert(path: Path, when: datetime, success: int) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO host_metrics_history (host_name, host, collected_at, success, cpu_usage_percent,"
            " memory_used_mb, memory_total_mb, disk_used_percent) VALUES (?, ?, ?, ?, 1.0, 2.0, 4.0, 3.0)",
            ("a100", "10.0.0.1", when.isoformat(), success),
        )
        conn.commit()


def test_strip_buckets_collection_results(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
    _insert(db, now - timedelta(minutes=5), 1)
    _insert(db, now - timedelta(minutes=8), 1)
    _insert(db, now - timedelta(minutes=40), 0)
    _insert(db, now - timedelta(minutes=42), 0)
    _insert(db, now - timedelta(days=2), 1)

    strip = storage.fetch_host_uptime_strip(db, "a100", hours=24, bucket_minutes=15, now=now)
    assert strip["bucket_minutes"] == 15
    assert len(strip["buckets"]) == 96
    assert strip["samples"] == 4
    assert strip["ok"] == 2
    filled = [b for b in strip["buckets"] if b["total"]]
    assert len(filled) == 2
    assert filled[-1]["ok"] == 2
    assert filled[0]["ok"] == 0


def test_strip_missing_database_is_empty(tmp_path):
    strip = storage.fetch_host_uptime_strip(tmp_path / "nope.db", "a100")
    assert strip["samples"] == 0
    assert len(strip["buckets"]) == 96


def test_route_exposes_strip():
    routes = ROUTES.read_text(encoding="utf-8")
    assert 'detail["uptime_strip"] = storage.fetch_host_uptime_strip(' in routes
    assert "hours=24, bucket_minutes=15" in routes


def test_template_renders_cells():
    markup = TEMPLATE.read_text(encoding="utf-8")
    assert 'id="host-uptime-strip"' in markup
    assert 'data-uptime-cell="{{ bucket.index }}"' in markup
    assert "成功 {{ detail.uptime_strip.ok }} / {{ detail.uptime_strip.samples }} 次" in markup


def test_style_covers_strip():
    css = STYLE.read_text(encoding="utf-8")
    block = css[css.index("v0.1.128 主机采集时间线"):]
    assert ".uptime-strip {" in block
    assert ".uptime-cell.is-bad { background: #dc2626; }" in block
    assert 'html[data-theme="dark"] .uptime-cell.is-empty' in block
