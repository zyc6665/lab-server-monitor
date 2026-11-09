"""Task 2 tests: persist the latest per-host check snapshot."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

from servermanage.models import HostCheckResult
from servermanage.storage import (
    delete_host_check_results,
    get_host_check_results,
    init_storage,
    save_host_check_results,
)


def result(
    name: str,
    status: str,
    latency_ms: float | None = 12.5,
    *,
    checked_at: datetime | None = None,
    check_type: str = "http",
    target: str = "http://127.0.0.1:8000/health",
    message: str = "",
) -> HostCheckResult:
    return HostCheckResult(
        name=name,
        type=check_type,
        target=target,
        status=status,
        message=message,
        latency_ms=latency_ms,
        checked_at=checked_at or datetime(2026, 11, 9, 4, 0, tzinfo=timezone.utc),
    )


def test_save_read_and_overwrite_check_results(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_check_results("gpu-01", [result("API", "ok", 12.5)], db)
    assert get_host_check_results("gpu-01", db)[0]["status"] == "ok"
    save_host_check_results("gpu-01", [result("API", "failed", 20.0)], db)
    rows = get_host_check_results("gpu-01", db)
    assert len(rows) == 1
    assert rows[0]["status"] == "failed"
    assert rows[0]["latency_ms"] == pytest.approx(20.0)


def test_rows_are_ordered_by_check_name_and_scoped_per_host(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_check_results(
        "gpu-01",
        [
            result("web", "ok"),
            result("API", "ok"),
            result("db", "failed"),
        ],
        db,
    )
    save_host_check_results("gpu-02", [result("only", "ok")], db)
    assert [row["check_name"] for row in get_host_check_results("gpu-01", db)] == [
        "API",
        "db",
        "web",
    ]
    assert [row["check_name"] for row in get_host_check_results("gpu-02", db)] == [
        "only"
    ]


def test_all_columns_roundtrip(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    checked_at = datetime(2026, 11, 9, 4, 5, 6, tzinfo=timezone.utc)
    save_host_check_results(
        "gpu-01",
        [
            result(
                "训练 API",
                "error",
                3.25,
                checked_at=checked_at,
                check_type="http",
                target="http://127.0.0.1:8000/health",
                message="curl missing",
            )
        ],
        db,
    )
    row = get_host_check_results("gpu-01", db)[0]
    assert row["host_name"] == "gpu-01"
    assert row["check_name"] == "训练 API"
    assert row["check_type"] == "http"
    assert row["target"] == "http://127.0.0.1:8000/health"
    assert row["status"] == "error"
    assert row["message"] == "curl missing"
    assert row["latency_ms"] == pytest.approx(3.25)
    assert datetime.fromisoformat(row["checked_at"]) == checked_at


def test_missing_checked_at_defaults_to_now(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_check_results("gpu-01", [result("API", "ok", checked_at=None)], db)
    row = get_host_check_results("gpu-01", db)[0]
    assert datetime.fromisoformat(row["checked_at"]).tzinfo is not None


def test_delete_host_check_results_is_cascade_ready(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_check_results("gpu-01", [result("API", "ok")], db)
    save_host_check_results("gpu-02", [result("API", "ok")], db)
    delete_host_check_results("gpu-01", db)
    assert get_host_check_results("gpu-01", db) == []
    assert len(get_host_check_results("gpu-02", db)) == 1


def test_empty_results_clears_snapshot(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_check_results("gpu-01", [result("API", "ok")], db)
    save_host_check_results("gpu-01", [], db)
    assert get_host_check_results("gpu-01", db) == []


def test_get_missing_host_returns_empty_list(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    assert get_host_check_results("nope", db) == []
    assert get_host_check_results("nope", tmp_path / "does-not-exist.db") == []


def test_save_rolls_back_on_error(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_check_results("gpu-01", [result("API", "ok")], db)

    class Broken:
        name = "BROKEN"
        type = "tcp"
        target = "22"
        status = {"not": "a string"}
        message = ""
        latency_ms = None
        checked_at = None

    with pytest.raises(sqlite3.ProgrammingError):
        save_host_check_results("gpu-01", [result("web", "ok"), Broken()], db)
    rows = get_host_check_results("gpu-01", db)
    assert [row["check_name"] for row in rows] == ["API"]
    assert rows[0]["status"] == "ok"


def test_init_storage_creates_table_for_old_database(tmp_path):
    db = tmp_path / "monitor.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE legacy_only (id INTEGER PRIMARY KEY)")
    init_storage(db)
    save_host_check_results("gpu-01", [result("API", "ok")], db)
    assert get_host_check_results("gpu-01", db)[0]["status"] == "ok"
