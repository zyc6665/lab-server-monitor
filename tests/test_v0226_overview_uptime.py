"""v0.1.126：概览主机行/卡片显示采集成功率。"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.storage import init_storage

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "servermanage" / "web" / "static" / "app.js"
STYLE = ROOT / "servermanage" / "web" / "static" / "style.css"


def _insert(path: Path, host: str, when: datetime) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO host_metrics_history (host_name, host, collected_at, success, cpu_usage_percent,"
            " memory_used_mb, memory_total_mb, disk_used_percent) VALUES (?, ?, ?, 1, 1.0, 2.0, 4.0, 3.0)",
            (host, "10.0.0.1", when.isoformat()),
        )
        conn.commit()


def test_counts_are_grouped_by_host(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
    for index in range(3):
        _insert(db, "alpha", now - timedelta(hours=index))
    _insert(db, "beta", now - timedelta(minutes=5))
    _insert(db, "gamma", now - timedelta(days=3))

    counts = storage.count_recent_samples_by_host(db, hours=24, now=now)
    assert counts["alpha"] == 3
    assert counts["beta"] == 1
    assert "gamma" not in counts


def test_missing_database_returns_empty(tmp_path):
    assert storage.count_recent_samples_by_host(tmp_path / "nope.db") == {}


def test_overview_rows_carry_counts():
    routes = (ROOT / "servermanage" / "web" / "routes.py").read_text(encoding="utf-8")
    assert "sample_counts = storage.count_recent_samples_by_host(db_path, hours=24, now=now)" in routes
    assert '"samples": sample_counts.get(host_name, 0),' in routes
    assert '"expected": expected_polls,' in routes
    assert '"collection_uptime": collection_uptime,' in routes


def test_frontend_renders_uptime_chip():
    script = SCRIPT.read_text(encoding="utf-8")
    assert "function uptimeChip(uptime)" in script
    assert "if (ratio >= 0.9) { return null; }" in script
    assert "var rowUptime = uptimeChip(host.collection_uptime);" in script
    assert "var cardUptime = uptimeChip(host.collection_uptime);" in script


def test_style_covers_uptime_chip():
    css = STYLE.read_text(encoding="utf-8")
    block = css[css.index("v0.1.126 概览采集成功率徽标"):]
    assert ".uptime-chip {" in block
    assert ".uptime-chip.is-critical {" in block
    assert 'html[data-theme="dark"] .uptime-chip.is-critical' in block
