from __future__ import annotations

import json
import logging
import sqlite3
from datetime import date, datetime, time, timedelta, timezone, tzinfo
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

# Tables added by the web-settings monitor (Task 3): persisted application
# settings (JSON payloads keyed by section) and encrypted secrets (opaque
# bytes keyed by name).  ``updated_at`` is an ISO-8601 UTC timestamp.
_CREATE_SETTINGS_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS app_settings (
    section TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_secrets (
    name TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    updated_at TEXT NOT NULL
);
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
        conn.executescript(_CREATE_SETTINGS_TABLES_SQL)


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


def _parse_collected_at(value: str) -> datetime:
    """Parse a stored ``collected_at`` string into an aware datetime.

    The application writes ``datetime.isoformat()`` (``T`` separator, optional
    UTC offset).  Legacy rows may be naive; those are interpreted as UTC, which
    matches how SQLite's ``DATE(collected_at)`` treated them and keeps the
    default ``tz=UTC`` output byte-for-byte identical to the old behaviour.
    """
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _mean(values: list[float | None]) -> float | None:
    """Arithmetic mean of the non-``None`` values, or ``None`` if there are none."""
    numbers = [float(value) for value in values if value is not None]
    if not numbers:
        return None
    return sum(numbers) / len(numbers)


def _max_or_none(values: list[float | None]) -> float | None:
    numbers = [float(value) for value in values if value is not None]
    return max(numbers) if numbers else None


def _min_or_none(values: list[float | None]) -> float | None:
    numbers = [float(value) for value in values if value is not None]
    return min(numbers) if numbers else None


def _memory_percent(row: sqlite3.Row) -> float | None:
    total = row["memory_total_mb"]
    used = row["memory_used_mb"]
    if total and total > 0 and used is not None:
        return float(used) / float(total) * 100.0
    return None


def _gpu_memory_percent(row: sqlite3.Row) -> float | None:
    total = row["gpu_memory_total_mb"]
    used = row["gpu_memory_used_mb"]
    if total and total > 0 and used is not None:
        return float(used) / float(total) * 100.0
    return None


def _local_week_utc_bounds(
    week_start: date, week_end: date, tz: tzinfo
) -> tuple[datetime, datetime]:
    """Return the ``[start, end)`` UTC instants covering the local week.

    ``week_start`` / ``week_end`` are inclusive *local* dates.  The query
    window is local Monday 00:00 (inclusive) through the day after local Sunday
    00:00 (exclusive), converted to UTC instants so UTC-stamped samples are
    compared against the correct wall-clock week regardless of server time.
    """
    start = datetime.combine(week_start, time.min, tzinfo=tz).astimezone(timezone.utc)
    end = datetime.combine(
        week_end + timedelta(days=1), time.min, tzinfo=tz
    ).astimezone(timezone.utc)
    return start, end


def fetch_daily_points_for_week(
    db_path: Path,
    week_start: date,
    week_end: date,
    tz: tzinfo = timezone.utc,
) -> list[dict[str, object]]:
    """Per-day averages per host for the week, bucketed by *local* day.

    Raw rows are fetched over the local week converted to a ``[start, end)``
    UTC instant window and grouped in Python by ``dt.astimezone(tz).date()``;
    any bucket outside ``[week_start, week_end]`` is dropped defensively.
    Passing ``tz=UTC`` (the default) reproduces the legacy
    ``DATE(collected_at)`` bucketing exactly.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    start_dt, end_dt = _local_week_utc_bounds(week_start, week_end, tz)
    start_iso = start_dt.isoformat()
    end_iso = end_dt.isoformat()

    sql = """
    SELECT
        collected_at,
        host_name,
        host,
        cpu_usage_percent,
        memory_used_mb,
        memory_total_mb,
        gpu_utilization_percent
    FROM host_metrics_history
    WHERE collected_at >= ? AND collected_at < ? AND success = 1
    """

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        raw_rows = conn.execute(sql, (start_iso, end_iso)).fetchall()

    buckets: dict[tuple[str, str, str], dict[str, list[float | None]]] = {}
    for row in raw_rows:
        local_day = _parse_collected_at(row["collected_at"]).astimezone(tz).date()
        if local_day < week_start or local_day > week_end:
            # Defensive clamp: never surface a bucket outside the local week,
            # even if a stored instant slipped past the UTC query window.
            continue
        day = local_day.isoformat()
        bucket = buckets.setdefault(
            (row["host_name"], row["host"], day),
            {"cpu": [], "memory": [], "gpu": []},
        )
        bucket["cpu"].append(row["cpu_usage_percent"])
        bucket["memory"].append(_memory_percent(row))
        bucket["gpu"].append(row["gpu_utilization_percent"])

    results = [
        {
            "day": day,
            "host_name": host_name,
            "host": host,
            "cpu_avg": _mean(values["cpu"]),
            "memory_percent": _mean(values["memory"]),
            "gpu_util": _mean(values["gpu"]),
        }
        for (host_name, host, day), values in buckets.items()
    ]
    results.sort(key=lambda item: (item["host_name"], item["day"]))
    return results


def fetch_weekly_metrics(
    db_path: Path,
    week_start: date,
    week_end: date,
    tz: tzinfo = timezone.utc,
) -> list[dict[str, object]]:
    """Weekly per-host metrics, aggregating as the mean of daily means.

    Raw rows are fetched over the local week converted to a ``[start, end)``
    UTC instant window and bucketed by ``dt.astimezone(tz).date()`` (buckets
    outside ``[week_start, week_end]`` are dropped defensively).  For every host
    we first compute a mean per
    local day and then average those daily means over the week, so each day
    carries equal weight regardless of how many samples it holds.  ``*_max`` /
    ``*_min`` stay raw extremes over every sample and ``sample_count`` stays
    the raw sample count.  Passing ``tz=UTC`` (the default) reproduces the old
    behaviour for evenly-sampled data.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    start_dt, end_dt = _local_week_utc_bounds(week_start, week_end, tz)
    start_iso = start_dt.isoformat()
    end_iso = end_dt.isoformat()

    sql = """
    SELECT
        collected_at,
        host_name,
        host,
        success,
        cpu_usage_percent,
        memory_used_mb,
        memory_total_mb,
        disk_used_percent,
        gpu_utilization_percent,
        gpu_memory_used_mb,
        gpu_memory_total_mb,
        load_1,
        logged_in_user_count,
        total_processes
    FROM host_metrics_history
    WHERE collected_at >= ? AND collected_at < ? AND success = 1
    """

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        raw_rows = conn.execute(sql, (start_iso, end_iso)).fetchall()

    groups: dict[tuple[str, str], list[sqlite3.Row]] = {}
    for row in raw_rows:
        groups.setdefault((row["host_name"], row["host"]), []).append(row)

    results: list[dict[str, object]] = []
    for (host_name, host), host_rows in groups.items():
        day_buckets: dict[str, list[sqlite3.Row]] = {}
        for row in host_rows:
            local_day = _parse_collected_at(row["collected_at"]).astimezone(tz).date()
            if local_day < week_start or local_day > week_end:
                # Defensive clamp, mirroring fetch_daily_points_for_week.
                continue
            day_buckets.setdefault(local_day.isoformat(), []).append(row)

        daily_means: dict[str, list[float | None]] = {
            "cpu": [],
            "memory": [],
            "disk": [],
            "gpu": [],
            "gpu_memory": [],
            "load": [],
            "users": [],
            "processes": [],
        }
        for rows_in_day in day_buckets.values():
            daily_means["cpu"].append(_mean([r["cpu_usage_percent"] for r in rows_in_day]))
            daily_means["memory"].append(_mean([_memory_percent(r) for r in rows_in_day]))
            daily_means["disk"].append(_mean([r["disk_used_percent"] for r in rows_in_day]))
            daily_means["gpu"].append(_mean([r["gpu_utilization_percent"] for r in rows_in_day]))
            daily_means["gpu_memory"].append(_mean([_gpu_memory_percent(r) for r in rows_in_day]))
            daily_means["load"].append(_mean([r["load_1"] for r in rows_in_day]))
            daily_means["users"].append(_mean([r["logged_in_user_count"] for r in rows_in_day]))
            daily_means["processes"].append(_mean([r["total_processes"] for r in rows_in_day]))

        all_cpu = [r["cpu_usage_percent"] for r in host_rows]
        all_memory = [_memory_percent(r) for r in host_rows]
        all_disk = [r["disk_used_percent"] for r in host_rows]
        all_gpu = [r["gpu_utilization_percent"] for r in host_rows]
        all_gpu_memory = [_gpu_memory_percent(r) for r in host_rows]

        results.append(
            {
                "host_name": host_name,
                "host": host,
                "sample_count": len(host_rows),
                "success_count": sum(int(r["success"]) for r in host_rows),
                "cpu_avg": _mean(daily_means["cpu"]),
                "cpu_max": _max_or_none(all_cpu),
                "cpu_min": _min_or_none(all_cpu),
                "memory_avg_percent": _mean(daily_means["memory"]),
                "memory_max_percent": _max_or_none(all_memory),
                "disk_avg_percent": _mean(daily_means["disk"]),
                "disk_max_percent": _max_or_none(all_disk),
                "gpu_util_avg": _mean(daily_means["gpu"]),
                "gpu_util_max": _max_or_none(all_gpu),
                "gpu_memory_avg_percent": _mean(daily_means["gpu_memory"]),
                "gpu_memory_max_percent": _max_or_none(all_gpu_memory),
                "load_avg": _mean(daily_means["load"]),
                "users_avg": _mean(daily_means["users"]),
                "processes_avg": _mean(daily_means["processes"]),
            }
        )

    results.sort(key=lambda item: item["host_name"])
    return results


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


# ---------------------------------------------------------------------------
# Web settings and encrypted secrets
# ---------------------------------------------------------------------------


def _settings_now() -> str:
    """Current UTC instant as an ISO-8601 string for ``updated_at`` columns."""
    return datetime.now(timezone.utc).isoformat()


def save_app_settings(section: str, payload: dict, db_path: Path) -> None:
    """Insert or replace the JSON *payload* stored for *section*."""
    db_path = Path(db_path)
    init_storage(db_path)

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO app_settings (section, payload, updated_at)"
            " VALUES (?, ?, ?)"
            " ON CONFLICT(section) DO UPDATE SET"
            " payload = excluded.payload, updated_at = excluded.updated_at",
            (section, dump_json(payload), _settings_now()),
        )
        conn.commit()


def load_app_settings(db_path: Path) -> dict[str, dict]:
    """Return ``{section: payload}`` for every stored settings section."""
    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    try:
        with sqlite3.connect(db_path) as conn:
            rows = conn.execute(
                "SELECT section, payload FROM app_settings"
            ).fetchall()
    except sqlite3.OperationalError:
        return {}

    return {section: json.loads(payload) for section, payload in rows}


def delete_app_settings(section: str, db_path: Path) -> None:
    """Remove the settings row for *section* if present."""
    db_path = Path(db_path)
    if not db_path.exists():
        return

    try:
        with sqlite3.connect(db_path) as conn:
            conn.execute("DELETE FROM app_settings WHERE section = ?", (section,))
            conn.commit()
    except sqlite3.OperationalError:
        return


def set_secret(name: str, ciphertext: bytes, db_path: Path) -> None:
    """Insert or replace the encrypted *ciphertext* stored under *name*."""
    db_path = Path(db_path)
    init_storage(db_path)

    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO app_secrets (name, ciphertext, updated_at)"
            " VALUES (?, ?, ?)"
            " ON CONFLICT(name) DO UPDATE SET"
            " ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
            (name, sqlite3.Binary(ciphertext), _settings_now()),
        )
        conn.commit()


def get_secret(name: str, db_path: Path) -> bytes | None:
    """Return the stored ciphertext for *name*, or ``None`` when absent."""
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    try:
        with sqlite3.connect(db_path) as conn:
            row = conn.execute(
                "SELECT ciphertext FROM app_secrets WHERE name = ?", (name,)
            ).fetchone()
    except sqlite3.OperationalError:
        return None

    if row is None:
        return None
    value = row[0]
    return bytes(value) if value is not None else None


def delete_secret(name: str, db_path: Path) -> None:
    """Remove the secret stored under *name* if present."""
    db_path = Path(db_path)
    if not db_path.exists():
        return

    try:
        with sqlite3.connect(db_path) as conn:
            conn.execute("DELETE FROM app_secrets WHERE name = ?", (name,))
            conn.commit()
    except sqlite3.OperationalError:
        return


def list_secret_names(db_path: Path) -> list[str]:
    """Return every stored secret name, ordered alphabetically."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    try:
        with sqlite3.connect(db_path) as conn:
            rows = conn.execute("SELECT name FROM app_secrets ORDER BY name").fetchall()
    except sqlite3.OperationalError:
        return []

    return [name for (name,) in rows]
