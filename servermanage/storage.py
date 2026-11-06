from __future__ import annotations

import json
import logging
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from servermanage.disk_health import AlertEvent, DiskHealthReport
from servermanage.models import DailyReport, HostReport
from servermanage.serialization import dump_json, to_jsonable

LOGGER = logging.getLogger(__name__)

_VIRTUAL_FILESYSTEMS = {
    "tmpfs",
    "devtmpfs",
    "overlay",
    "squashfs",
    "nsfs",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "mqueue",
    "shm",
}

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS host_metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT NOT NULL,
    host_name TEXT NOT NULL,
    host TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    cpu_usage_percent REAL,
    memory_used_mb INTEGER,
    memory_total_mb INTEGER,
    disk_used_percent REAL,
    gpu_utilization_percent REAL,
    gpu_memory_used_mb INTEGER,
    gpu_memory_total_mb INTEGER,
    total_processes INTEGER,
    logged_in_user_count INTEGER,
    load_1 REAL,
    load_5 REAL,
    load_15 REAL
);
"""

_CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_host_metrics_history_collected_at
    ON host_metrics_history(collected_at);
CREATE INDEX IF NOT EXISTS idx_host_metrics_history_host
    ON host_metrics_history(host_name, host);
"""

# Tables added by the PC polling monitor (Task 2).  The legacy
# ``host_metrics_history`` table above is intentionally left untouched.
_CREATE_EXTENDED_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS host_latest_snapshot (
    host_name TEXT PRIMARY KEY,
    collected_at TEXT NOT NULL,
    success INTEGER NOT NULL,
    raw_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS disk_controller_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT NOT NULL,
    host_name TEXT NOT NULL,
    controller INTEGER,
    model TEXT,
    firmware TEXT,
    bbu_state TEXT,
    health TEXT,
    reasons TEXT
);
CREATE TABLE IF NOT EXISTS disk_vd_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT NOT NULL,
    host_name TEXT NOT NULL,
    controller INTEGER,
    vd_id INTEGER,
    raid_level TEXT,
    state TEXT,
    size TEXT,
    health TEXT,
    reasons TEXT
);
CREATE TABLE IF NOT EXISTS disk_pd_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at TEXT NOT NULL,
    host_name TEXT NOT NULL,
    controller INTEGER,
    enclosure INTEGER,
    slot INTEGER,
    did INTEGER,
    model TEXT,
    serial TEXT,
    state TEXT,
    media_errors INTEGER,
    other_errors INTEGER,
    predictive_failures INTEGER,
    smart_alert INTEGER,
    temperature_c INTEGER,
    shield_counter INTEGER,
    health TEXT,
    reasons TEXT
);
CREATE TABLE IF NOT EXISTS disk_health_snapshot (
    host_name TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    PRIMARY KEY (host_name, collected_at)
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    host_name TEXT,
    category TEXT,
    severity TEXT,
    title TEXT,
    message TEXT,
    fingerprint TEXT,
    status TEXT DEFAULT 'active',
    notified_channels TEXT,
    ack_at TEXT
);
CREATE TABLE IF NOT EXISTS task_state (
    task_name TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL,
    last_result TEXT
);
"""

_CREATE_EXTENDED_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_disk_controller_snapshot_host_time
    ON disk_controller_snapshot(host_name, collected_at);
CREATE INDEX IF NOT EXISTS idx_disk_vd_snapshot_host_time
    ON disk_vd_snapshot(host_name, collected_at);
CREATE INDEX IF NOT EXISTS idx_disk_pd_snapshot_host_time
    ON disk_pd_snapshot(host_name, collected_at);
CREATE INDEX IF NOT EXISTS idx_alerts_fingerprint
    ON alerts(fingerprint);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at
    ON alerts(created_at);
"""

def _disk_percent_value(percent: str) -> int:
    digits = "".join(ch for ch in percent if ch.isdigit())
    if not digits:
        return -1
    return int(digits)


def _extract_disk_used_percent(host_report: HostReport) -> float | None:
    if not host_report.metrics.disk_usage:
        return None
    real_disks = [
        row
        for row in host_report.metrics.disk_usage
        if row.filesystem not in _VIRTUAL_FILESYSTEMS
    ]
    if not real_disks:
        return None
    focus = max(real_disks, key=lambda row: _disk_percent_value(row.percent))
    percent = _disk_percent_value(focus.percent)
    return float(percent) if percent >= 0 else None


def _extract_gpu_utilization_percent(host_report: HostReport) -> float | None:
    if not host_report.metrics.gpu_summary:
        return None
    return float(max(gpu.utilization_percent for gpu in host_report.metrics.gpu_summary))


def init_storage(db_path: Path) -> None:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(_CREATE_TABLE_SQL)
        conn.executescript(_CREATE_INDEX_SQL)
        conn.executescript(_CREATE_EXTENDED_TABLES_SQL)
        conn.executescript(_CREATE_EXTENDED_INDEX_SQL)


def persist_host_reports(report: DailyReport, db_path: Path) -> None:
    db_path = Path(db_path)
    init_storage(db_path)

    rows: list[tuple] = []
    collected_at = datetime.now(timezone.utc).isoformat()

    for host_report in report.reports:
        if not host_report.success:
            continue

        metrics = host_report.metrics
        row_collected_at = (
            metrics.collected_at.isoformat()
            if metrics.collected_at is not None
            else collected_at
        )
        memory = metrics.memory
        load = metrics.load_average

        rows.append(
            (
                row_collected_at,
                host_report.host_name,
                host_report.host,
                1,
                metrics.cpu_usage_percent,
                memory.used_mb if memory else None,
                memory.total_mb if memory else None,
                _extract_disk_used_percent(host_report),
                _extract_gpu_utilization_percent(host_report),
                sum(gpu.memory_used_mb for gpu in metrics.gpu_summary) if metrics.gpu_summary else None,
                sum(gpu.memory_total_mb for gpu in metrics.gpu_summary) if metrics.gpu_summary else None,
                metrics.total_processes,
                len(metrics.logged_in_users),
                load.load_1 if load else None,
                load.load_5 if load else None,
                load.load_15 if load else None,
            )
        )

    if not rows:
        LOGGER.info("No successful host reports to persist")
        return

    with sqlite3.connect(db_path) as conn:
        conn.executemany(
            """
            INSERT INTO host_metrics_history (
                collected_at, host_name, host, success, cpu_usage_percent,
                memory_used_mb, memory_total_mb, disk_used_percent,
                gpu_utilization_percent, gpu_memory_used_mb, gpu_memory_total_mb,
                total_processes, logged_in_user_count, load_1, load_5, load_15
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.commit()

    LOGGER.info("Persisted %s host metric rows to %s", len(rows), db_path)


def fetch_daily_points_for_week(
    db_path: Path,
    week_start: date,
    week_end: date,
) -> list[dict[str, object]]:
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    start_iso = datetime.combine(week_start, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    end_iso = datetime.combine(week_end, datetime.max.time(), tzinfo=timezone.utc).isoformat()

    sql = """
    SELECT
        DATE(collected_at) AS day,
        host_name,
        host,
        AVG(cpu_usage_percent) AS cpu_avg,
        AVG(CASE WHEN memory_total_mb > 0 THEN CAST(memory_used_mb AS REAL) / memory_total_mb * 100 END) AS memory_percent,
        AVG(gpu_utilization_percent) AS gpu_util
    FROM host_metrics_history
    WHERE collected_at >= ? AND collected_at <= ? AND success = 1
    GROUP BY DATE(collected_at), host_name, host
    ORDER BY host_name, day
    """

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(sql, (start_iso, end_iso))
        return [dict(row) for row in cursor.fetchall()]


def fetch_weekly_metrics(
    db_path: Path,
    week_start: date,
    week_end: date,
) -> list[dict[str, object]]:
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    start_iso = datetime.combine(week_start, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    end_iso = datetime.combine(week_end, datetime.max.time(), tzinfo=timezone.utc).isoformat()

    sql = """
    SELECT
        host_name,
        host,
        COUNT(*) AS sample_count,
        SUM(success) AS success_count,
        AVG(cpu_usage_percent) AS cpu_avg,
        MAX(cpu_usage_percent) AS cpu_max,
        MIN(cpu_usage_percent) AS cpu_min,
        AVG(CASE WHEN memory_total_mb > 0 THEN CAST(memory_used_mb AS REAL) / memory_total_mb * 100 END) AS memory_avg_percent,
        MAX(CASE WHEN memory_total_mb > 0 THEN CAST(memory_used_mb AS REAL) / memory_total_mb * 100 END) AS memory_max_percent,
        AVG(disk_used_percent) AS disk_avg_percent,
        MAX(disk_used_percent) AS disk_max_percent,
        AVG(gpu_utilization_percent) AS gpu_util_avg,
        MAX(gpu_utilization_percent) AS gpu_util_max,
        AVG(CASE WHEN gpu_memory_total_mb > 0 THEN CAST(gpu_memory_used_mb AS REAL) / gpu_memory_total_mb * 100 END) AS gpu_memory_avg_percent,
        MAX(CASE WHEN gpu_memory_total_mb > 0 THEN CAST(gpu_memory_used_mb AS REAL) / gpu_memory_total_mb * 100 END) AS gpu_memory_max_percent,
        AVG(load_1) AS load_avg,
        AVG(logged_in_user_count) AS users_avg,
        AVG(total_processes) AS processes_avg
    FROM host_metrics_history
    WHERE collected_at >= ? AND collected_at <= ? AND success = 1
    GROUP BY host_name, host
    ORDER BY host_name
    """

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(sql, (start_iso, end_iso))
        return [dict(row) for row in cursor.fetchall()]


# ---------------------------------------------------------------------------
# Host snapshots (latest full HostReport per host)
# ---------------------------------------------------------------------------


def save_host_snapshot(host_report: HostReport, db_path: Path) -> None:
    """Persist the latest full :class:`HostReport` for a host (upsert by host)."""
    db_path = Path(db_path)
    init_storage(db_path)

    metrics = host_report.metrics
    collected_at = (
        metrics.collected_at.isoformat()
        if metrics.collected_at is not None
        else datetime.now(timezone.utc).isoformat()
    )
    raw_json = dump_json(host_report)

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO host_latest_snapshot (host_name, collected_at, success, raw_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(host_name) DO UPDATE SET
                collected_at = excluded.collected_at,
                success = excluded.success,
                raw_json = excluded.raw_json
            """,
            (
                host_report.host_name,
                collected_at,
                1 if host_report.success else 0,
                raw_json,
            ),
        )
        conn.commit()


def get_host_snapshot(host_name: str, db_path: Path) -> dict | None:
    """Return the latest snapshot dict for *host_name*, or ``None``."""
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT host_name, collected_at, success, raw_json"
            " FROM host_latest_snapshot WHERE host_name = ?",
            (host_name,),
        ).fetchone()

    if row is None:
        return None

    raw = json.loads(row["raw_json"]) if row["raw_json"] else {}
    return {
        "host_name": row["host_name"],
        "collected_at": row["collected_at"],
        "success": bool(row["success"]),
        "metrics": raw.get("metrics", {}),
        "errors": raw.get("errors", []),
    }


def get_all_host_snapshots(db_path: Path) -> list[dict]:
    """Return one snapshot dict per host, ordered by host name."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT host_name FROM host_latest_snapshot ORDER BY host_name"
        ).fetchall()

    snapshots: list[dict] = []
    for (host_name,) in rows:
        snapshot = get_host_snapshot(host_name, db_path)
        if snapshot is not None:
            snapshots.append(snapshot)
    return snapshots


# ---------------------------------------------------------------------------
# Disk health snapshots (one batch keyed by host + collected_at)
# ---------------------------------------------------------------------------


def _dump_reasons(reasons: list[str] | None) -> str:
    return json.dumps(reasons or [], ensure_ascii=False)


def _load_reasons(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


def save_disk_health(report: DiskHealthReport, db_path: Path) -> None:
    """Persist one :class:`DiskHealthReport` batch into the three disk tables.

    All rows share ``report.collected_at.isoformat()`` so a batch can be read
    back together.  Re-saving the same host/timestamp replaces the old rows.
    """
    db_path = Path(db_path)
    init_storage(db_path)

    collected_at = report.collected_at.isoformat()
    host_name = report.host_name

    controller_rows = [
        (
            collected_at,
            host_name,
            controller.controller,
            controller.model,
            controller.firmware,
            controller.bbu_state,
            controller.health,
            _dump_reasons(controller.reasons),
        )
        for controller in report.controllers
    ]
    vd_rows = [
        (
            collected_at,
            host_name,
            vd.controller,
            vd.vd_id,
            vd.raid_level,
            vd.state,
            vd.size,
            vd.health,
            _dump_reasons(vd.reasons),
        )
        for vd in report.virtual_drives
    ]
    pd_rows = [
        (
            collected_at,
            host_name,
            drive.controller,
            drive.enclosure,
            drive.slot,
            drive.did,
            drive.model,
            drive.serial,
            drive.state,
            drive.media_errors,
            drive.other_errors,
            drive.predictive_failures,
            None if drive.smart_alert is None else (1 if drive.smart_alert else 0),
            drive.temperature_c,
            drive.shield_counter,
            drive.health,
            _dump_reasons(drive.reasons),
        )
        for drive in report.physical_drives
    ]

    with sqlite3.connect(db_path) as conn:
        # Always write the batch header, even for zero-drive reports, so the
        # report's own ``status`` / ``message`` are not lost.
        conn.execute(
            """
            INSERT INTO disk_health_snapshot
                (host_name, collected_at, status, message)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(host_name, collected_at) DO UPDATE SET
                status = excluded.status,
                message = excluded.message
            """,
            (host_name, collected_at, report.status, report.message),
        )

        for table in (
            "disk_controller_snapshot",
            "disk_vd_snapshot",
            "disk_pd_snapshot",
        ):
            conn.execute(
                f"DELETE FROM {table} WHERE host_name = ? AND collected_at = ?",
                (host_name, collected_at),
            )

        if controller_rows:
            conn.executemany(
                "INSERT INTO disk_controller_snapshot"
                " (collected_at, host_name, controller, model, firmware, bbu_state,"
                " health, reasons)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                controller_rows,
            )
        if vd_rows:
            conn.executemany(
                "INSERT INTO disk_vd_snapshot"
                " (collected_at, host_name, controller, vd_id, raid_level, state,"
                " size, health, reasons)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                vd_rows,
            )
        if pd_rows:
            conn.executemany(
                "INSERT INTO disk_pd_snapshot"
                " (collected_at, host_name, controller, enclosure, slot, did, model,"
                " serial, state, media_errors, other_errors, predictive_failures,"
                " smart_alert, temperature_c, shield_counter, health, reasons)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                pd_rows,
            )
        conn.commit()


def get_disk_health(host_name: str, db_path: Path) -> dict | None:
    """Return the most recent disk-health batch for *host_name*, or ``None``.

    The overall ``status`` / ``message`` are read from the newest
    ``disk_health_snapshot`` header row for the host and returned unchanged
    (never derived from component health).  Component lists come from the
    latest batch at that same ``collected_at``.  If no header row exists for
    the host, ``None`` is returned.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        header = conn.execute(
            "SELECT collected_at, status, message FROM disk_health_snapshot"
            " WHERE host_name = ?"
            " ORDER BY collected_at DESC LIMIT 1",
            (host_name,),
        ).fetchone()
        if header is None:
            return None

        collected_at = header["collected_at"]
        controllers = [
            dict(row)
            for row in conn.execute(
                "SELECT controller, model, firmware, bbu_state, health, reasons"
                " FROM disk_controller_snapshot"
                " WHERE host_name = ? AND collected_at = ?"
                " ORDER BY controller",
                (host_name, collected_at),
            ).fetchall()
        ]
        virtual_drives = [
            dict(row)
            for row in conn.execute(
                "SELECT controller, vd_id, raid_level, state, size, health, reasons"
                " FROM disk_vd_snapshot"
                " WHERE host_name = ? AND collected_at = ?"
                " ORDER BY controller, vd_id",
                (host_name, collected_at),
            ).fetchall()
        ]
        physical_drives = [
            dict(row)
            for row in conn.execute(
                "SELECT controller, enclosure, slot, did, model, serial, state,"
                " media_errors, other_errors, predictive_failures, smart_alert,"
                " temperature_c, shield_counter, health, reasons"
                " FROM disk_pd_snapshot"
                " WHERE host_name = ? AND collected_at = ?"
                " ORDER BY controller, enclosure, slot",
                (host_name, collected_at),
            ).fetchall()
        ]

    for controller in controllers:
        controller["reasons"] = _load_reasons(controller.get("reasons"))
    for vd in virtual_drives:
        vd["reasons"] = _load_reasons(vd.get("reasons"))
    for drive in physical_drives:
        drive["reasons"] = _load_reasons(drive.get("reasons"))
        if drive.get("smart_alert") is not None:
            drive["smart_alert"] = bool(drive["smart_alert"])

    return {
        "host_name": host_name,
        "collected_at": collected_at,
        "status": header["status"],
        "message": header["message"],
        "controllers": controllers,
        "virtual_drives": virtual_drives,
        "physical_drives": physical_drives,
    }


def get_all_disk_health(db_path: Path) -> list[dict]:
    """Return the latest disk-health batch for every host."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT host_name FROM (
                SELECT host_name FROM disk_health_snapshot
                UNION
                SELECT host_name FROM disk_controller_snapshot
                UNION
                SELECT host_name FROM disk_vd_snapshot
                UNION
                SELECT host_name FROM disk_pd_snapshot
            ) ORDER BY host_name
            """
        ).fetchall()

    results: list[dict] = []
    for (host_name,) in rows:
        health = get_disk_health(host_name, db_path)
        if health is not None:
            results.append(health)
    return results


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------


def insert_alert(
    event: AlertEvent,
    db_path: Path,
    *,
    created_at: datetime | None = None,
) -> int:
    """Insert an alert event with status ``active`` and return its row id.

    ``created_at`` defaults to the current UTC time.  The alert engine passes an
    explicit value so its injectable clock also drives the persisted timestamp
    (otherwise cooldown math computed from a fake clock would not line up with
    the stored row).  Existing callers are unaffected.
    """
    db_path = Path(db_path)
    init_storage(db_path)

    created_at_text = (
        created_at if created_at is not None else datetime.now(timezone.utc)
    ).isoformat()
    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(
            "INSERT INTO alerts"
            " (created_at, host_name, category, severity, title, message,"
            " fingerprint, status)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
            (
                created_at_text,
                event.host_name,
                event.category,
                event.severity,
                event.title,
                event.message,
                event.fingerprint,
            ),
        )
        conn.commit()
        return int(cursor.lastrowid)


def find_latest_alert(fingerprint: str, db_path: Path) -> dict | None:
    """Return the most recent alert with *fingerprint*, or ``None``."""
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM alerts WHERE fingerprint = ?"
            " ORDER BY created_at DESC, id DESC LIMIT 1",
            (fingerprint,),
        ).fetchone()

    return dict(row) if row is not None else None


def update_alert(
    alert_id: int,
    db_path: Path,
    *,
    status: str | None = None,
    notified_channels: str | None = None,
    ack_at: str | None = None,
) -> None:
    """Update selected columns of an alert; unset arguments are left unchanged."""
    db_path = Path(db_path)

    assignments: list[str] = []
    values: list[object] = []
    if status is not None:
        assignments.append("status = ?")
        values.append(status)
    if notified_channels is not None:
        assignments.append("notified_channels = ?")
        values.append(notified_channels)
    if ack_at is not None:
        assignments.append("ack_at = ?")
        values.append(ack_at)

    if not assignments:
        return

    values.append(alert_id)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            f"UPDATE alerts SET {', '.join(assignments)} WHERE id = ?", values
        )
        conn.commit()


def list_alerts(
    db_path: Path,
    *,
    status: str | None = None,
    limit: int = 200,
) -> list[dict]:
    """Return alerts (newest first), optionally filtered by *status*."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    sql = "SELECT * FROM alerts"
    params: list[object] = []
    if status is not None:
        sql += " WHERE status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    params.append(int(limit))

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, params).fetchall()

    return [dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Task state (scheduler catch-up)
# ---------------------------------------------------------------------------


def get_task_state(task_name: str, db_path: Path) -> dict | None:
    """Return the stored state for *task_name*, or ``None``."""
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT task_name, last_run_at, last_result FROM task_state"
            " WHERE task_name = ?",
            (task_name,),
        ).fetchone()

    return dict(row) if row is not None else None


def set_task_state(
    task_name: str,
    db_path: Path,
    *,
    last_run_at: str,
    last_result: str | None = None,
) -> None:
    """Insert or overwrite the state row for *task_name*."""
    db_path = Path(db_path)
    init_storage(db_path)

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO task_state (task_name, last_run_at, last_result)"
            " VALUES (?, ?, ?)"
            " ON CONFLICT(task_name) DO UPDATE SET"
            " last_run_at = excluded.last_run_at,"
            " last_result = excluded.last_result",
            (task_name, last_run_at, last_result),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

_PURGE_TABLES = (
    "host_metrics_history",
    "disk_health_snapshot",
    "disk_controller_snapshot",
    "disk_vd_snapshot",
    "disk_pd_snapshot",
)


def purge_old_data(
    db_path: Path,
    retention_days: int,
    *,
    now: datetime | None = None,
) -> dict[str, int]:
    """Delete data older than *retention_days* and return per-table counts.

    Covers ``host_metrics_history``, the ``disk_health_snapshot`` header table,
    the three disk snapshot tables, and alerts that are both older than the
    cutoff and ``status = 'resolved'``.
    Active alerts are never purged.  Pass ``now`` in tests to pin the cutoff.
    """
    db_path = Path(db_path)
    counts = {table: 0 for table in _PURGE_TABLES}
    counts["alerts"] = 0
    if not db_path.exists():
        return counts

    reference = now if now is not None else datetime.now(timezone.utc)
    cutoff = (reference - timedelta(days=retention_days)).isoformat()

    with sqlite3.connect(db_path) as conn:
        for table in _PURGE_TABLES:
            cursor = conn.execute(
                f"DELETE FROM {table} WHERE collected_at < ?", (cutoff,)
            )
            counts[table] = cursor.rowcount if cursor.rowcount is not None else 0
        cursor = conn.execute(
            "DELETE FROM alerts WHERE created_at < ? AND status = 'resolved'",
            (cutoff,),
        )
        counts["alerts"] = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()

    return counts
