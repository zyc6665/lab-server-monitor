from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.storage import (
    init_storage,
    list_ssh_sessions,
    purge_old_data,
    record_ssh_session_end,
    record_ssh_session_start,
)


def _columns(db_path: Path, table: str) -> dict[str, sqlite3.Row]:
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"]: row for row in rows}


def test_init_storage_creates_ssh_audit_sessions(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)

    columns = _columns(db_path, "ssh_audit_sessions")
    assert columns["id"]["pk"] == 1
    assert columns["host_name"]["notnull"] == 1
    assert columns["username"]["notnull"] == 1
    assert columns["server_username"]["notnull"] == 0
    assert columns["remote_addr"]["notnull"] == 1
    assert columns["started_at"]["notnull"] == 1
    assert columns["ended_at"]["notnull"] == 0
    assert columns["status"]["notnull"] == 1
    assert columns["status"]["dflt_value"] == "'active'"
    assert columns["error"]["notnull"] == 0

    with sqlite3.connect(db_path) as conn:
        indexes = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master"
                " WHERE type = 'index' AND tbl_name = 'ssh_audit_sessions'"
            )
        }
    assert "idx_ssh_audit_started_at" in indexes


def test_record_ssh_session_start_returns_id_and_defaults(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)

    session_id = record_ssh_session_start(
        "gpu-01", "admin", server_username="root", db_path=db_path
    )

    assert isinstance(session_id, int)
    rows = list_ssh_sessions(db_path)
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == session_id
    assert row["host_name"] == "gpu-01"
    assert row["username"] == "admin"
    assert row["server_username"] == "root"
    assert row["remote_addr"] == "127.0.0.1"
    assert row["status"] == "active"
    assert row["ended_at"] is None
    assert row["error"] is None
    assert row["started_at"]


def test_record_ssh_session_start_honours_started_at_and_optional_server_user(
    tmp_path: Path,
):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)
    started_at = "2026-11-01T08:30:00+00:00"

    session_id = record_ssh_session_start(
        "gpu-02", "admin", started_at=started_at, db_path=db_path
    )

    row = list_ssh_sessions(db_path)[0]
    assert row["id"] == session_id
    assert row["server_username"] is None
    assert row["started_at"] == started_at


def test_record_ssh_session_end_closes_session(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)
    session_id = record_ssh_session_start("gpu-01", "admin", db_path=db_path)
    ended_at = "2026-11-07T10:00:00+00:00"

    ok = record_ssh_session_end(session_id, ended_at=ended_at, db_path=db_path)

    assert ok is True
    row = list_ssh_sessions(db_path)[0]
    assert row["status"] == "closed"
    assert row["ended_at"] == ended_at
    assert row["error"] is None


def test_record_ssh_session_end_records_error_status(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)
    session_id = record_ssh_session_start("gpu-01", "admin", db_path=db_path)

    ok = record_ssh_session_end(
        session_id, status="error", error="connection reset", db_path=db_path
    )

    assert ok is True
    row = list_ssh_sessions(db_path)[0]
    assert row["status"] == "error"
    assert row["error"] == "connection reset"
    assert row["ended_at"] is not None


def test_record_ssh_session_end_missing_id_returns_false(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)

    assert record_ssh_session_end(9999, db_path=db_path) is False


def test_list_ssh_sessions_newest_first_and_limit(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)
    first = record_ssh_session_start(
        "gpu-01", "admin", started_at="2026-11-01T00:00:00+00:00", db_path=db_path
    )
    second = record_ssh_session_start(
        "gpu-02", "admin", started_at="2026-11-03T00:00:00+00:00", db_path=db_path
    )
    third = record_ssh_session_start(
        "gpu-03", "admin", started_at="2026-11-02T00:00:00+00:00", db_path=db_path
    )

    rows = list_ssh_sessions(db_path)
    assert [row["id"] for row in rows] == [second, third, first]

    limited = list_ssh_sessions(db_path, limit=2)
    assert [row["id"] for row in limited] == [second, third]


def test_list_ssh_sessions_missing_db_returns_empty(tmp_path: Path):
    assert list_ssh_sessions(tmp_path / "missing.db") == []


def test_purge_old_data_deletes_expired_ssh_audit_rows(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)
    now = datetime(2026, 11, 7, 12, 0, 0, tzinfo=timezone.utc)
    old = record_ssh_session_start(
        "gpu-01",
        "admin",
        started_at=(now - timedelta(days=100)).isoformat(),
        db_path=db_path,
    )
    recent = record_ssh_session_start(
        "gpu-02",
        "admin",
        started_at=(now - timedelta(days=3)).isoformat(),
        db_path=db_path,
    )

    counts = purge_old_data(db_path, retention_days=90, now=now)

    assert counts["ssh_audit_sessions"] == 1
    remaining = {row["id"] for row in list_ssh_sessions(db_path)}
    assert remaining == {recent}


def test_purge_old_data_reports_zero_ssh_audit_on_missing_db(tmp_path: Path):
    counts = purge_old_data(
        tmp_path / "missing.db",
        retention_days=90,
        now=datetime(2026, 11, 7, 12, 0, 0, tzinfo=timezone.utc),
    )
    assert counts["ssh_audit_sessions"] == 0
