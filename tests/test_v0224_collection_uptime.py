"""v0.1.124：诊断卡新增「采集成功率」行。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import diagnostics, storage
from servermanage.storage import init_storage

DB = Path(__file__).parent / "tmp_db" / "usage.db"


def _db(tmp_path: Path) -> Path:
    path = tmp_path / "usage.db"
    init_storage(path)
    return path


def _insert_sample(path: Path, host: str, when: datetime) -> None:
    import sqlite3

    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO host_metrics_history (host_name, host, collected_at, success, cpu_usage_percent,"
            " memory_used_mb, memory_total_mb, disk_used_percent) VALUES (?, ?, ?, 1, 1.0, 2.0, 4.0, 3.0)",
            (host, "10.0.0.1", when.isoformat()),
        )
        conn.commit()


def test_count_recent_samples_only_counts_window(tmp_path):
    path = _db(tmp_path)
    now = datetime.now(timezone.utc)
    _insert_sample(path, "a100", now - timedelta(hours=1))
    _insert_sample(path, "a100", now - timedelta(hours=30))
    _insert_sample(path, "h100", now - timedelta(hours=2))
    assert storage.count_recent_samples(path, "a100", hours=24, now=now) == 1
    assert storage.count_recent_samples(path, "h100", hours=24, now=now) == 1
    assert storage.count_recent_samples(path, "missing", hours=24, now=now) == 0


def test_count_recent_samples_missing_db(tmp_path):
    assert storage.count_recent_samples(tmp_path / "nope.db", "a100") == 0


def test_uptime_row_levels():
    ok = diagnostics._collection_row({"collection_uptime": {"samples": 141, "expected": 144}})
    assert ok["key"] == "uptime" and ok["level"] == diagnostics.LEVEL_OK

    warn = diagnostics._collection_row({"collection_uptime": {"samples": 100, "expected": 144}})
    assert warn["level"] == diagnostics.LEVEL_WARN

    crit = diagnostics._collection_row({"collection_uptime": {"samples": 20, "expected": 144}})
    assert crit["level"] == diagnostics.LEVEL_CRIT
    assert "20 次" in crit["detail"]

    assert diagnostics._collection_row({}) is None
    assert diagnostics._collection_row({"collection_uptime": {"samples": 5, "expected": 0}}) is None


def test_build_host_diagnostics_includes_uptime():
    detail = {
        "name": "a100",
        "success": True,
        "metrics": {},
        "collection_uptime": {"samples": 12, "expected": 144},
    }
    rows = diagnostics.build_host_diagnostics(
        detail, now=datetime.now(timezone.utc), poll_interval_seconds=600
    )
    keys = [row["key"] for row in rows]
    assert "uptime" in keys
    assert keys.index("uptime") <= keys.index("collect")
