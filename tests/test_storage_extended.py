from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.disk_health import (
    AlertEvent,
    DiskControllerInfo,
    DiskHealthReport,
    PhysicalDriveInfo,
    VirtualDriveInfo,
)
from servermanage import storage
from servermanage.models import HostMetrics, HostReport, MemorySummary
from servermanage.serialization import dump_json, to_jsonable
from servermanage.storage import (
    delete_silence,
    find_latest_alert,
    get_all_disk_health,
    get_all_host_snapshots,
    get_disk_health,
    get_host_snapshot,
    get_task_state,
    init_storage,
    insert_alert,
    insert_silence,
    list_alerts,
    list_silences,
    purge_old_data,
    save_disk_health,
    save_host_snapshot,
    set_task_state,
    update_alert,
)

BASE = datetime(2026, 11, 6, 2, 0, 0, tzinfo=timezone.utc)


def _memory(total: int = 16384, used: int = 4096) -> MemorySummary:
    return MemorySummary(
        total_mb=total,
        used_mb=used,
        free_mb=total - used,
        shared_mb=0,
        buff_cache_mb=0,
        available_mb=total - used,
        swap_total_mb=0,
        swap_used_mb=0,
        swap_free_mb=0,
    )


def _host_report(
    name: str = "gpu-01",
    *,
    cpu: float | None = 42.5,
    success: bool = True,
    collected_at: datetime = BASE,
) -> HostReport:
    return HostReport(
        host_name=name,
        host="10.0.0.1",
        success=success,
        metrics=HostMetrics(
            collected_at=collected_at,
            cpu_usage_percent=cpu,
            memory=_memory(),
            total_processes=120,
        ),
    )


def _six_drive_disk_report(host_name: str = "gpu-01") -> DiskHealthReport:
    drives = [
        PhysicalDriveInfo(
            controller=0,
            enclosure=252,
            slot=0,
            did=10,
            model="ST1000NM0011",
            serial="SN0001",
            state="Onln",
            media_errors=0,
            other_errors=0,
            predictive_failures=0,
            smart_alert=False,
            temperature_c=30,
            shield_counter=0,
            health="healthy",
            reasons=[],
        ),
        PhysicalDriveInfo(
            controller=0,
            enclosure=252,
            slot=1,
            did=11,
            model="ST1000NM0011",
            serial="SN0002",
            state="Onln",
            media_errors=2,
            other_errors=0,
            predictive_failures=0,
            smart_alert=True,
            temperature_c=41,
            shield_counter=0,
            health="warning",
            reasons=["media_errors", "smart_flag"],
        ),
        PhysicalDriveInfo(
            controller=0, enclosure=252, slot=2, did=12, model="ST2000NM0011",
            serial="SN0003", state="Onln", health="healthy",
        ),
        PhysicalDriveInfo(
            controller=0, enclosure=252, slot=3, did=13, model="ST2000NM0011",
            serial="SN0004", state="Onln", health="healthy",
        ),
        PhysicalDriveInfo(
            controller=0, enclosure=252, slot=4, did=None, model="ST2000NM0011",
            serial="SN0005", state="Onln", temperature_c=None, health="healthy",
        ),
        PhysicalDriveInfo(
            controller=0, enclosure=252, slot=5, did=15, model="ST2000NM0011",
            serial="SN0006", state="Onln", health="healthy",
            reasons=[],
        ),
    ]
    return DiskHealthReport(
        host_name=host_name,
        collected_at=BASE,
        status="warning",
        message="1 drive needs attention",
        controllers=[
            DiskControllerInfo(
                controller=0,
                model="LSI MegaRAID 9460-16i",
                firmware="4.0.1",
                bbu_state="Optimal",
                health="ok",
            )
        ],
        virtual_drives=[
            VirtualDriveInfo(
                controller=0,
                vd_id=0,
                raid_level="RAID1",
                state="Optl",
                size="1.8 TB",
                health="ok",
                reasons=[],
            )
        ],
        physical_drives=drives,
    )


# ---------------------------------------------------------------------------
# serialization
# ---------------------------------------------------------------------------


def test_to_jsonable_converts_dataclass_datetime_tuple_path():
    payload = {
        "when": BASE,
        "tuple": (1, BASE),
        "path": Path("/tmp/x.db"),
        "drive": PhysicalDriveInfo(controller=0, slot=3, health="warning"),
    }

    result = to_jsonable(payload)

    assert result["when"] == BASE.isoformat()
    assert result["tuple"] == [1, BASE.isoformat()]
    assert result["path"] == str(Path("/tmp/x.db"))
    assert result["drive"]["slot"] == 3
    assert result["drive"]["health"] == "warning"


def test_dump_json_keeps_non_ascii():
    text = dump_json({"title": "磁盘告警"})
    assert "磁盘告警" in text
    assert json.loads(text) == {"title": "磁盘告警"}


# ---------------------------------------------------------------------------
# host snapshot
# ---------------------------------------------------------------------------


def test_host_snapshot_roundtrip(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    report = _host_report(cpu=42.5)

    save_host_snapshot(report, db_path)

    snapshot = get_host_snapshot("gpu-01", db_path)
    assert snapshot is not None
    assert snapshot["host_name"] == "gpu-01"
    assert snapshot["collected_at"] == BASE.isoformat()
    assert snapshot["success"] is True
    assert snapshot["metrics"]["cpu_usage_percent"] == 42.5
    assert isinstance(snapshot["errors"], list)
    assert snapshot["metrics"]["memory"]["used_mb"] == 4096


def test_host_snapshot_upserts_and_lists(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    save_host_snapshot(_host_report("gpu-01", cpu=10.0), db_path)
    save_host_snapshot(_host_report("gpu-01", cpu=88.0), db_path)
    save_host_snapshot(_host_report("gpu-02", cpu=5.0), db_path)

    latest = get_host_snapshot("gpu-01", db_path)
    assert latest is not None
    assert latest["metrics"]["cpu_usage_percent"] == 88.0

    all_snapshots = get_all_host_snapshots(db_path)
    assert {row["host_name"] for row in all_snapshots} == {"gpu-01", "gpu-02"}
    assert len(all_snapshots) == 2

    assert get_host_snapshot("missing", db_path) is None


# ---------------------------------------------------------------------------
# disk health
# ---------------------------------------------------------------------------


def test_save_disk_health_roundtrip_six_drives(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    report = _six_drive_disk_report()

    save_disk_health(report, db_path)

    result = get_disk_health("gpu-01", db_path)
    assert result is not None
    assert result["collected_at"] == BASE.isoformat()
    assert result["status"] == "warning"
    assert "message" in result

    assert len(result["controllers"]) == 1
    controller = result["controllers"][0]
    assert controller["controller"] == 0
    assert controller["model"] == "LSI MegaRAID 9460-16i"
    assert controller["firmware"] == "4.0.1"
    assert controller["bbu_state"] == "Optimal"
    assert controller["health"] == "ok"

    assert len(result["virtual_drives"]) == 1
    vd = result["virtual_drives"][0]
    assert vd["vd_id"] == 0
    assert vd["raid_level"] == "RAID1"
    assert vd["state"] == "Optl"
    assert vd["size"] == "1.8 TB"

    assert len(result["physical_drives"]) == 6
    by_slot = {drive["slot"]: drive for drive in result["physical_drives"]}
    first = by_slot[0]
    assert first["controller"] == 0
    assert first["enclosure"] == 252
    assert first["did"] == 10
    assert first["model"] == "ST1000NM0011"
    assert first["serial"] == "SN0001"
    assert first["state"] == "Onln"
    assert first["media_errors"] == 0
    assert first["other_errors"] == 0
    assert first["predictive_failures"] == 0
    assert first["smart_alert"] is False
    assert first["temperature_c"] == 30
    assert first["shield_counter"] == 0
    assert first["health"] == "healthy"
    assert first["reasons"] == []

    bad = by_slot[1]
    assert bad["media_errors"] == 2
    assert bad["smart_alert"] is True
    assert bad["health"] == "warning"
    assert bad["reasons"] == ["media_errors", "smart_flag"]

    # None values survive the roundtrip unchanged.
    assert by_slot[4]["did"] is None
    assert by_slot[4]["temperature_c"] is None

    assert get_disk_health("missing-host", db_path) is None


def test_get_all_disk_health_returns_latest_per_host(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    save_disk_health(_six_drive_disk_report("gpu-01"), db_path)
    later = DiskHealthReport(
        host_name="gpu-01",
        collected_at=BASE + timedelta(hours=1),
        physical_drives=[
            PhysicalDriveInfo(controller=0, enclosure=252, slot=0, health="healthy")
        ],
    )
    save_disk_health(later, db_path)
    save_disk_health(_six_drive_disk_report("gpu-02"), db_path)

    all_health = get_all_disk_health(db_path)
    assert {row["host_name"] for row in all_health} == {"gpu-01", "gpu-02"}
    latest = next(row for row in all_health if row["host_name"] == "gpu-01")
    assert latest["collected_at"] == (BASE + timedelta(hours=1)).isoformat()
    assert len(latest["physical_drives"]) == 1


# ---------------------------------------------------------------------------
# alerts
# ---------------------------------------------------------------------------


def _alert(fingerprint: str = "system:gpu-01:cpu", title: str = "CPU 使用率过高") -> AlertEvent:
    return AlertEvent(
        host_name="gpu-01",
        category="system",
        severity="warning",
        title=title,
        message="cpu over threshold",
        fingerprint=fingerprint,
    )


def test_alert_insert_find_update(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    alert_id = insert_alert(_alert(), db_path)
    assert isinstance(alert_id, int)
    assert alert_id > 0

    latest = find_latest_alert("system:gpu-01:cpu", db_path)
    assert latest is not None
    assert latest["id"] == alert_id
    assert latest["host_name"] == "gpu-01"
    assert latest["title"] == "CPU 使用率过高"
    assert latest["status"] == "active"
    assert latest["created_at"]

    update_alert(
        alert_id,
        db_path,
        status="resolved",
        notified_channels="desktop,email",
        ack_at=BASE.isoformat(),
    )
    updated = find_latest_alert("system:gpu-01:cpu", db_path)
    assert updated is not None
    assert updated["status"] == "resolved"
    assert updated["notified_channels"] == "desktop,email"
    assert updated["ack_at"] == BASE.isoformat()

    assert find_latest_alert("does-not-exist", db_path) is None


def test_list_alerts_filters_by_status_and_limit(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    a = insert_alert(_alert("system:gpu-01:cpu", "CPU"), db_path)
    insert_alert(_alert("system:gpu-01:memory", "内存"), db_path)
    insert_alert(_alert("system:gpu-02:cpu", "CPU-2"), db_path)
    update_alert(a, db_path, status="resolved")

    active = list_alerts(db_path, status="active")
    assert len(active) == 2
    assert all(row["status"] == "active" for row in active)

    resolved = list_alerts(db_path, status="resolved")
    assert [row["id"] for row in resolved] == [a]

    everything = list_alerts(db_path)
    assert len(everything) == 3

    limited = list_alerts(db_path, limit=2)
    assert len(limited) == 2


def test_find_latest_alert_picks_newest_for_fingerprint(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    insert_alert(_alert("dup", "first"), db_path)
    second_id = insert_alert(_alert("dup", "second"), db_path)

    latest = find_latest_alert("dup", db_path)
    assert latest is not None
    assert latest["id"] == second_id
    assert latest["title"] == "second"


# ---------------------------------------------------------------------------
# task state
# ---------------------------------------------------------------------------


def test_task_state_overwrites(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    assert get_task_state("poll", db_path) is None

    set_task_state("poll", db_path, last_run_at=BASE.isoformat(), last_result="ok")
    first = get_task_state("poll", db_path)
    assert first is not None
    assert first["last_run_at"] == BASE.isoformat()
    assert first["last_result"] == "ok"

    later = (BASE + timedelta(minutes=10)).isoformat()
    set_task_state("poll", db_path, last_run_at=later, last_result="failed")
    second = get_task_state("poll", db_path)
    assert second is not None
    assert second["last_run_at"] == later
    assert second["last_result"] == "failed"

    with sqlite3.connect(db_path) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM task_state WHERE task_name = 'poll'"
        ).fetchone()[0]
    assert count == 1


# ---------------------------------------------------------------------------
# purge
# ---------------------------------------------------------------------------


def test_purge_old_data_deletes_old_keeps_today(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)
    now = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)
    old = (now - timedelta(days=100)).isoformat()
    today = now.isoformat()

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO host_metrics_history (collected_at, host_name, host, success)"
            " VALUES (?, 'old-host', '10.0.0.9', 1)",
            (old,),
        )
        conn.execute(
            "INSERT INTO host_metrics_history (collected_at, host_name, host, success)"
            " VALUES (?, 'new-host', '10.0.0.8', 1)",
            (today,),
        )
        conn.execute(
            "INSERT INTO disk_controller_snapshot (collected_at, host_name, controller)"
            " VALUES (?, 'old-host', 0)",
            (old,),
        )
        conn.execute(
            "INSERT INTO disk_controller_snapshot (collected_at, host_name, controller)"
            " VALUES (?, 'new-host', 0)",
            (today,),
        )
        conn.execute(
            "INSERT INTO disk_vd_snapshot (collected_at, host_name, controller, vd_id)"
            " VALUES (?, 'old-host', 0, 0)",
            (old,),
        )
        conn.execute(
            "INSERT INTO disk_vd_snapshot (collected_at, host_name, controller, vd_id)"
            " VALUES (?, 'new-host', 0, 0)",
            (today,),
        )
        conn.execute(
            "INSERT INTO disk_pd_snapshot (collected_at, host_name, controller, slot)"
            " VALUES (?, 'old-host', 0, 0)",
            (old,),
        )
        conn.execute(
            "INSERT INTO disk_pd_snapshot (collected_at, host_name, controller, slot)"
            " VALUES (?, 'new-host', 0, 1)",
            (today,),
        )
        # old + resolved -> purged
        conn.execute(
            "INSERT INTO alerts (created_at, host_name, category, severity, title,"
            " message, fingerprint, status) VALUES (?, 'old-host', 'disk', 'warning',"
            " 'old resolved', 'm', 'fp-old-resolved', 'resolved')",
            (old,),
        )
        # old + active -> kept
        conn.execute(
            "INSERT INTO alerts (created_at, host_name, category, severity, title,"
            " message, fingerprint, status) VALUES (?, 'old-host', 'disk', 'warning',"
            " 'old active', 'm', 'fp-old-active', 'active')",
            (old,),
        )
        # today + resolved -> kept
        conn.execute(
            "INSERT INTO alerts (created_at, host_name, category, severity, title,"
            " message, fingerprint, status) VALUES (?, 'new-host', 'disk', 'warning',"
            " 'new resolved', 'm', 'fp-new-resolved', 'resolved')",
            (today,),
        )
        conn.commit()

    counts = purge_old_data(db_path, retention_days=90, now=now)

    assert counts["host_metrics_history"] == 1
    assert counts["disk_controller_snapshot"] == 1
    assert counts["disk_vd_snapshot"] == 1
    assert counts["disk_pd_snapshot"] == 1
    assert counts["alerts"] == 1

    with sqlite3.connect(db_path) as conn:
        host_names = {
            row[0]
            for row in conn.execute(
                "SELECT host_name FROM host_metrics_history"
            ).fetchall()
        }
        assert host_names == {"new-host"}
        pd_hosts = {
            row[0]
            for row in conn.execute(
                "SELECT host_name FROM disk_pd_snapshot"
            ).fetchall()
        }
        assert pd_hosts == {"new-host"}
        alert_fps = {
            row[0]
            for row in conn.execute("SELECT fingerprint FROM alerts").fetchall()
        }
        assert alert_fps == {"fp-old-active", "fp-new-resolved"}


# ---------------------------------------------------------------------------
# disk health header (status / message snapshot)
# ---------------------------------------------------------------------------


def test_zero_drive_report_roundtrips_status_and_message(tmp_path: Path):
    """(a) A zero-drive report keeps its own status/message, not a derived one."""
    db_path = tmp_path / "servermanage.db"
    report = DiskHealthReport(
        host_name="gpu-09",
        collected_at=BASE,
        status="permission_denied",
        message="sudo: a password is required",
    )

    save_disk_health(report, db_path)

    result = get_disk_health("gpu-09", db_path)
    assert result is not None
    assert result["status"] == "permission_denied"
    assert result["message"] == "sudo: a password is required"
    assert result["collected_at"] == BASE.isoformat()
    assert result["controllers"] == []
    assert result["virtual_drives"] == []
    assert result["physical_drives"] == []


def test_zero_drive_report_not_masked_by_older_batch(tmp_path: Path):
    """(a) A newer zero-drive header must not be masked by an older batch."""
    db_path = tmp_path / "servermanage.db"
    save_disk_health(_six_drive_disk_report("gpu-01"), db_path)

    newer = DiskHealthReport(
        host_name="gpu-01",
        collected_at=BASE + timedelta(hours=1),
        status="permission_denied",
        message="sudo: a password is required",
    )
    save_disk_health(newer, db_path)

    result = get_disk_health("gpu-01", db_path)
    assert result is not None
    assert result["collected_at"] == (BASE + timedelta(hours=1)).isoformat()
    assert result["status"] == "permission_denied"
    assert result["message"] == "sudo: a password is required"
    assert result["controllers"] == []
    assert result["virtual_drives"] == []
    assert result["physical_drives"] == []


def test_report_status_preserved_when_all_drives_ok(tmp_path: Path):
    """(b) An explicit critical status survives even with all-ok components."""
    db_path = tmp_path / "servermanage.db"
    report = DiskHealthReport(
        host_name="gpu-03",
        collected_at=BASE,
        status="critical",
        message="controller offline",
        physical_drives=[
            PhysicalDriveInfo(
                controller=0, enclosure=252, slot=0, health="ok"
            )
        ],
    )

    save_disk_health(report, db_path)

    result = get_disk_health("gpu-03", db_path)
    assert result is not None
    assert result["status"] == "critical"
    assert result["message"] == "controller offline"
    assert len(result["physical_drives"]) == 1
    assert result["physical_drives"][0]["health"] == "ok"


def test_purge_old_data_covers_disk_health_snapshot(tmp_path: Path):
    """(c) Retention purge deletes old disk_health_snapshot header rows."""
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)
    now = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)
    old = (now - timedelta(days=100)).isoformat()
    today = now.isoformat()

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO disk_health_snapshot"
            " (host_name, collected_at, status, message)"
            " VALUES ('old-host', ?, 'ok', NULL)",
            (old,),
        )
        conn.execute(
            "INSERT INTO disk_health_snapshot"
            " (host_name, collected_at, status, message)"
            " VALUES ('new-host', ?, 'ok', NULL)",
            (today,),
        )
        conn.commit()

    counts = purge_old_data(db_path, retention_days=90, now=now)

    assert counts["disk_health_snapshot"] == 1
    with sqlite3.connect(db_path) as conn:
        hosts = {
            row[0]
            for row in conn.execute(
                "SELECT host_name FROM disk_health_snapshot"
            ).fetchall()
        }
    assert hosts == {"new-host"}


# ---------------------------------------------------------------------------
# web settings and encrypted secrets
# ---------------------------------------------------------------------------


def test_app_settings_roundtrip_and_upsert(tmp_path):
    db = tmp_path / "s.db"
    storage.save_app_settings("report", {"daily_enabled": False}, db)
    storage.save_app_settings("report", {"daily_enabled": True}, db)
    assert storage.load_app_settings(db)["report"]["daily_enabled"] is True


def test_secret_roundtrip_and_delete(tmp_path):
    db = tmp_path / "s.db"
    storage.set_secret("smtp:password", b"ciphertext", db)
    assert storage.get_secret("smtp:password", db) == b"ciphertext"
    assert storage.list_secret_names(db) == ["smtp:password"]
    storage.delete_secret("smtp:password", db)
    assert storage.get_secret("smtp:password", db) is None


def test_settings_tables_created_by_init_storage(tmp_path):
    db = tmp_path / "s.db"
    storage.init_storage(db)
    names = {row[0] for row in sqlite3.connect(db).execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"app_settings", "app_secrets"} <= names


# ---------------------------------------------------------------------------
# alert silences
# ---------------------------------------------------------------------------


def test_alert_silences_table_and_index_created_by_init_storage(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)
    with sqlite3.connect(db_path) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        indexes = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
    assert "alert_silences" in tables
    assert "idx_alert_silences_ends_at" in indexes


def test_silence_insert_list_delete_roundtrip(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    silence_id = insert_silence(
        "host",
        "gpu-01",
        "maintenance",
        BASE,
        BASE + timedelta(hours=2),
        "alice",
        db_path,
    )
    assert isinstance(silence_id, int)
    assert silence_id > 0

    rows = list_silences(db_path)
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == silence_id
    assert row["scope_type"] == "host"
    assert row["scope"] == "gpu-01"
    assert row["reason"] == "maintenance"
    assert row["starts_at"] == BASE.isoformat()
    assert row["ends_at"] == (BASE + timedelta(hours=2)).isoformat()
    assert row["created_by"] == "alice"
    assert row["created_at"]

    assert delete_silence(silence_id, db_path) is True
    assert list_silences(db_path) == []
    assert delete_silence(silence_id, db_path) is False


def test_list_silences_active_only_uses_start_end_window(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    now = BASE
    ended = insert_silence(
        "host", "gpu-01", "ended",
        BASE - timedelta(hours=2), BASE - timedelta(hours=1), "a", db_path,
    )
    active = insert_silence(
        "host", "gpu-02", "active",
        BASE - timedelta(hours=1), BASE + timedelta(hours=1), "a", db_path,
    )
    future = insert_silence(
        "host", "gpu-03", "future",
        BASE + timedelta(hours=1), BASE + timedelta(hours=2), "a", db_path,
    )
    # Boundary semantics: starts_at <= now < ends_at.
    starts_now = insert_silence(
        "host", "gpu-04", "starts-now",
        BASE, BASE + timedelta(hours=1), "a", db_path,
    )
    ends_now = insert_silence(
        "host", "gpu-05", "ends-now",
        BASE - timedelta(hours=1), BASE, "a", db_path,
    )

    active_ids = {
        row["id"] for row in list_silences(db_path, active_only=True, now=now)
    }
    assert active_ids == {active, starts_now}

    all_ids = {row["id"] for row in list_silences(db_path)}
    assert all_ids == {ended, active, future, starts_now, ends_now}


def test_silence_scopes_nullable_and_kinds(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    end = BASE + timedelta(hours=1)
    all_id = insert_silence("all", None, "global", BASE, end, "admin", db_path)
    group_id = insert_silence("group", "lab", "group-scope", BASE, end, "admin", db_path)
    host_id = insert_silence("host", "gpu-01", "host-scope", BASE, end, "admin", db_path)

    rows = {row["id"]: row for row in list_silences(db_path)}
    assert rows[all_id]["scope_type"] == "all"
    assert rows[all_id]["scope"] is None
    assert rows[group_id]["scope"] == "lab"
    assert rows[host_id]["scope"] == "gpu-01"


def test_list_silences_skips_malformed_time_rows(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    good = insert_silence(
        "host", "gpu-01", "good", BASE, BASE + timedelta(hours=1), "a", db_path
    )
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO alert_silences"
            " (scope_type, scope, reason, starts_at, ends_at, created_at, created_by)"
            " VALUES ('host', 'gpu-02', 'bad', 'not-a-date', 'also-bad', ?, 'a')",
            (BASE.isoformat(),),
        )
        conn.commit()

    rows = list_silences(db_path)  # must not raise on malformed rows
    assert [row["id"] for row in rows] == [good]
    assert [row["id"] for row in list_silences(db_path, active_only=True, now=BASE)] == [
        good
    ]


def test_purge_old_data_deletes_expired_silences(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    now = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)
    old_end = now - timedelta(days=100)
    insert_silence(
        "host", "gpu-01", "old",
        old_end - timedelta(hours=1), old_end, "a", db_path,
    )
    live_id = insert_silence(
        "host", "gpu-02", "live",
        now - timedelta(hours=1), now + timedelta(days=30), "a", db_path,
    )

    counts = purge_old_data(db_path, retention_days=90, now=now)

    assert counts["alert_silences"] == 1
    remaining = {row["id"] for row in list_silences(db_path)}
    assert remaining == {live_id}


def test_purge_old_data_reports_zero_silences_on_missing_db(tmp_path: Path):
    db_path = tmp_path / "missing.db"
    counts = purge_old_data(db_path, retention_days=90, now=BASE)
    assert counts["alert_silences"] == 0
