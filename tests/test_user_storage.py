"""Task 2 tests: server-user snapshots, baselines and scan state."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from servermanage.settings import SettingsService
from servermanage.storage import (
    delete_host_user_data,
    delete_user_baseline,
    get_all_host_user_snapshots,
    get_host_user_snapshot,
    get_user_baseline,
    get_user_scan_state,
    init_storage,
    save_host_user_snapshot,
    save_user_scan_state,
    upsert_user_baseline,
)

NOW = datetime(2026, 11, 9, 8, 0, tzinfo=timezone.utc)

SNAPSHOT_COLUMNS = {
    "host_name",
    "username",
    "uid",
    "gid",
    "primary_group",
    "gecos",
    "home",
    "shell",
    "groups_json",
    "in_docker",
    "in_sudo",
    "home_exists",
    "home_owner",
    "home_group",
    "home_mode",
    "home_size_bytes",
    "data_exists",
    "data_owner",
    "data_group",
    "data_mode",
    "data_size_bytes",
    "data_supported",
    "usage_stale",
    "usage_collected_at",
    "collected_at",
}

BASELINE_COLUMNS = {
    "host_name",
    "username",
    "uid",
    "gid",
    "primary_group",
    "shell",
    "home",
    "groups_json",
    "in_docker",
    "in_sudo",
    "first_seen_at",
    "last_seen_at",
}

SCAN_STATE_COLUMNS = {"host_name", "last_scan_at", "last_usage_at", "last_error"}


def account(username: str = "alice", **overrides):
    data = {
        "username": username,
        "uid": 1001,
        "gid": 1001,
        "primary_group": username,
        "gecos": f"{username.title()} User",
        "home": f"/home/{username}",
        "shell": "/bin/bash",
        "groups": [username, "docker", "sudo"],
        "in_docker": True,
        "in_sudo": True,
        "home_exists": True,
        "home_owner": username,
        "home_group": username,
        "home_mode": "700",
        "home_size_bytes": 2048,
        "data_exists": True,
        "data_owner": username,
        "data_group": username,
        "data_mode": "750",
        "data_size_bytes": 4096,
        "data_supported": True,
        "usage_stale": False,
        "usage_collected_at": NOW,
        "collected_at": NOW,
    }
    data.update(overrides)
    return data


def _columns(db, table: str) -> set[str]:
    with sqlite3.connect(db) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def test_init_storage_creates_user_tables_idempotently(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    init_storage(db)

    with sqlite3.connect(db) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        indexes = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
        }

    assert {"host_user_snapshot", "host_user_baseline", "host_user_scan_state"} <= tables
    assert "idx_host_user_snapshot_host" in indexes
    assert _columns(db, "host_user_snapshot") == SNAPSHOT_COLUMNS
    assert _columns(db, "host_user_baseline") == BASELINE_COLUMNS
    assert _columns(db, "host_user_scan_state") == SCAN_STATE_COLUMNS


def test_snapshot_roundtrip_orders_by_username_and_keeps_columns(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)

    save_host_user_snapshot(
        "gpu-01", [account("zoe", uid=1003), account("alice")], db
    )

    rows = get_host_user_snapshot("gpu-01", db)
    assert [row["username"] for row in rows] == ["alice", "zoe"]
    alice = rows[0]
    assert alice["host_name"] == "gpu-01"
    assert alice["uid"] == 1001
    assert alice["gid"] == 1001
    assert alice["primary_group"] == "alice"
    assert alice["gecos"] == "Alice User"
    assert alice["home"] == "/home/alice"
    assert alice["shell"] == "/bin/bash"
    assert alice["groups"] == ["alice", "docker", "sudo"]
    assert alice["in_docker"] is True
    assert alice["in_sudo"] is True
    assert alice["home_exists"] is True
    assert alice["home_owner"] == "alice"
    assert alice["home_group"] == "alice"
    assert alice["home_mode"] == "700"
    assert alice["home_size_bytes"] == 2048
    assert alice["data_exists"] is True
    assert alice["data_owner"] == "alice"
    assert alice["data_group"] == "alice"
    assert alice["data_mode"] == "750"
    assert alice["data_size_bytes"] == 4096
    assert alice["data_supported"] is True
    assert alice["usage_stale"] is False
    assert datetime.fromisoformat(alice["usage_collected_at"]) == NOW
    assert datetime.fromisoformat(alice["collected_at"]) == NOW


def test_snapshot_optional_fields_default_cleanly(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)

    save_host_user_snapshot(
        "gpu-01",
        [
            {
                "username": "new",
                "uid": 1005,
                "gid": 1005,
                "collected_at": NOW,
            }
        ],
        db,
    )

    row = get_host_user_snapshot("gpu-01", db)[0]
    assert row["groups"] == []
    assert row["in_docker"] is False
    assert row["home_exists"] is False
    assert row["data_supported"] is True
    assert row["usage_stale"] is False
    assert row["usage_collected_at"] is None


def test_get_all_snapshots_groups_rows_per_host(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_user_snapshot("gpu-02", [account("bob", uid=1002)], db)
    save_host_user_snapshot("gpu-01", [account("alice"), account("zoe", uid=1003)], db)

    snapshots = get_all_host_user_snapshots(db)

    assert list(snapshots) == ["gpu-01", "gpu-02"]
    assert [row["username"] for row in snapshots["gpu-01"]] == ["alice", "zoe"]
    assert [row["username"] for row in snapshots["gpu-02"]] == ["bob"]


def test_snapshot_replace_drops_accounts_that_vanished(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_user_snapshot("gpu-01", [account("alice"), account("bob")], db)

    save_host_user_snapshot("gpu-01", [account("alice")], db)

    assert [row["username"] for row in get_host_user_snapshot("gpu-01", db)] == ["alice"]


def test_empty_snapshot_clears_host_rows(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_user_snapshot("gpu-01", [account("alice")], db)

    save_host_user_snapshot("gpu-01", [], db)

    assert get_host_user_snapshot("gpu-01", db) == []


def test_snapshot_replace_is_atomic_on_insert_failure(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_user_snapshot("gpu-01", [account("alice")], db)

    with pytest.raises(sqlite3.Error):
        save_host_user_snapshot(
            "gpu-01",
            [account("bob"), account("alice", uid={"not": "an integer"})],
            db,
        )

    rows = get_host_user_snapshot("gpu-01", db)
    assert [row["username"] for row in rows] == ["alice"]
    assert rows[0]["uid"] == 1001


def test_upsert_user_baseline_returns_true_only_for_new_rows(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)

    assert upsert_user_baseline("gpu-01", account("alice"), db, now=NOW) is True

    later = NOW + timedelta(hours=1)
    updated = account("alice", shell="/bin/zsh", groups=["alice", "docker"])
    assert upsert_user_baseline("gpu-01", updated, db, now=later) is False

    rows = get_user_baseline("gpu-01", db)
    assert len(rows) == 1
    row = rows[0]
    assert row["shell"] == "/bin/zsh"
    assert row["groups"] == ["alice", "docker"]
    assert datetime.fromisoformat(row["first_seen_at"]) == NOW
    assert datetime.fromisoformat(row["last_seen_at"]) == later


def test_baseline_keeps_row_after_account_leaves_snapshot(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    save_host_user_snapshot("gpu-01", [account("alice"), account("bob")], db)
    assert upsert_user_baseline("gpu-01", account("alice"), db, now=NOW) is True
    assert upsert_user_baseline("gpu-01", account("bob"), db, now=NOW) is True

    save_host_user_snapshot("gpu-01", [account("alice")], db)

    baseline = get_user_baseline("gpu-01", db)
    assert [row["username"] for row in baseline] == ["alice", "bob"]
    bob = baseline[1]
    assert bob["home"] == "/home/bob"
    assert bob["in_docker"] is True
    assert bob["uid"] == 1001  # frozen last-known values stay as stored


def test_delete_user_baseline_reports_whether_a_row_was_removed(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    upsert_user_baseline("gpu-01", account("alice"), db, now=NOW)
    upsert_user_baseline("gpu-01", account("bob"), db, now=NOW)

    assert delete_user_baseline("gpu-01", "bob", db) is True
    assert delete_user_baseline("gpu-01", "bob", db) is False
    assert [row["username"] for row in get_user_baseline("gpu-01", db)] == ["alice"]


def test_scan_state_partial_updates_keep_previous_values(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    assert get_user_scan_state("gpu-01", db) is None

    save_user_scan_state("gpu-01", db_path=db, last_scan_at=NOW)
    state = get_user_scan_state("gpu-01", db)
    assert datetime.fromisoformat(state["last_scan_at"]) == NOW
    assert state["last_usage_at"] is None
    assert state["last_error"] is None

    later = NOW + timedelta(hours=6)
    save_user_scan_state(
        "gpu-01", db_path=db, last_usage_at=later, last_error="du timed out"
    )
    state = get_user_scan_state("gpu-01", db)
    assert datetime.fromisoformat(state["last_scan_at"]) == NOW
    assert datetime.fromisoformat(state["last_usage_at"]) == later
    assert state["last_error"] == "du timed out"

    save_user_scan_state("gpu-01", db_path=db, last_scan_at=later, last_error="")
    state = get_user_scan_state("gpu-01", db)
    assert datetime.fromisoformat(state["last_scan_at"]) == later
    assert datetime.fromisoformat(state["last_usage_at"]) == later
    assert state["last_error"] == ""


def test_delete_host_user_data_clears_all_three_tables(tmp_path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    for host in ("gpu-01", "gpu-02"):
        save_host_user_snapshot(host, [account("alice")], db)
        upsert_user_baseline(host, account("alice"), db, now=NOW)
        save_user_scan_state(host, db_path=db, last_scan_at=NOW)

    delete_host_user_data("gpu-01", db)

    assert get_host_user_snapshot("gpu-01", db) == []
    assert get_user_baseline("gpu-01", db) == []
    assert get_user_scan_state("gpu-01", db) is None
    assert len(get_host_user_snapshot("gpu-02", db)) == 1
    assert len(get_user_baseline("gpu-02", db)) == 1
    assert get_user_scan_state("gpu-02", db) is not None


def test_settings_delete_host_cascades_user_data(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\n", encoding="utf-8")
    service = SettingsService(config_path=cfg, db_path=tmp_path / "monitor.db")
    service.upsert_host(
        "h",
        {
            "host": "1.2.3.4",
            "username": "u",
            "auth_type": "password",
            "password": "x",
        },
    )
    save_host_user_snapshot("h", [account()], service.db_path)
    upsert_user_baseline("h", account(), service.db_path, now=NOW)
    save_user_scan_state("h", db_path=service.db_path, last_scan_at=NOW)

    service.delete_host("h")

    assert get_host_user_snapshot("h", service.db_path) == []
    assert get_user_baseline("h", service.db_path) == []
    assert get_user_scan_state("h", service.db_path) is None


def test_reads_on_missing_database_are_empty(tmp_path):
    db = tmp_path / "missing.db"

    assert get_host_user_snapshot("h", db) == []
    assert get_all_host_user_snapshots(db) == {}
    assert get_user_baseline("h", db) == []
    assert get_user_scan_state("h", db) is None
    assert delete_user_baseline("h", "u", db) is False
    delete_host_user_data("h", db)
    assert db.exists() is False
