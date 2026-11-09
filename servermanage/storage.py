from __future__ import annotations

import json
import logging
import sqlite3
from collections.abc import Mapping, Sequence
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from pathlib import Path

from servermanage import disk_capacity
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
CREATE TABLE IF NOT EXISTS host_daily_summary (
    day TEXT NOT NULL,
    host_name TEXT NOT NULL,
    tz TEXT NOT NULL DEFAULT 'UTC',
    host TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    cpu_sum REAL,
    cpu_max REAL,
    cpu_min REAL,
    memory_pct_sum REAL,
    memory_pct_max REAL,
    disk_pct_sum REAL,
    disk_pct_max REAL,
    gpu_util_sum REAL,
    gpu_util_max REAL,
    gpu_memory_pct_sum REAL,
    gpu_memory_pct_max REAL,
    load_sum REAL,
    users_sum REAL,
    processes_sum REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (day, host_name, tz)
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
CREATE INDEX IF NOT EXISTS idx_host_daily_summary_day
    ON host_daily_summary(day);
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

# Table added by the v1.2 alert-silence feature (Task 3): maintenance windows
# that suppress alert notifications for a host, a group, or everything.
# ``scope`` is NULL for the global (``all``) scope.  Time columns are ISO-8601
# UTC strings.
_CREATE_SILENCE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS alert_silences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    scope TEXT,
    reason TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT
);
"""

_CREATE_SILENCE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_alert_silences_ends_at
    ON alert_silences(ends_at);
"""

# Table added by the v1.4 SSH terminal feature (Task 1): metadata-only audit of
# interactive SSH sessions.  Terminal input/output is never stored.  ``username``
# is the dashboard admin account, ``server_username`` the SSH login account, and
# ``remote_addr`` is always ``127.0.0.1`` in desktop (loopback-only) mode.  Time
# columns are ISO-8601 UTC strings.
_CREATE_SSH_AUDIT_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS ssh_audit_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    server_username TEXT,
    remote_addr TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    error TEXT
);
"""

_CREATE_SSH_AUDIT_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_ssh_audit_started_at
    ON ssh_audit_sessions(started_at);
"""


def _disk_percent_value(percent: str) -> int:
    digits = "".join(ch for ch in percent if ch.isdigit())
    if not digits:
        return -1
    return int(digits)


def _extract_disk_used_percent(
    host_report: HostReport,
    mounts: Sequence[str] | None = None,
) -> float | None:
    if not host_report.metrics.disk_usage:
        return None
    if mounts:
        return disk_capacity.max_percent(host_report.metrics.disk_usage, mounts)
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


def _migrate_host_daily_summary(conn: sqlite3.Connection, tz_key: str) -> None:
    """Upgrade the pre-0.1.1 summary table that lacked the ``tz`` column.

    v1.6.0/v1.6.1 shipped ``host_daily_summary`` with a ``(day, host_name)``
    primary key.  The live schema now includes ``tz`` so two timezones cannot
    overwrite each other.  SQLite cannot add a column to a primary key, so the
    only safe migration is a rename-copy-drop rebuild.  Existing rows were
    produced with the configured local timezone, therefore they are tagged with
    the caller's timezone rather than blindly labelled UTC.
    """
    columns = [row[1] for row in conn.execute("PRAGMA table_info(host_daily_summary)")]
    if not columns or "tz" in columns:
        return
    conn.execute("DROP INDEX IF EXISTS idx_host_daily_summary_day")
    conn.execute("ALTER TABLE host_daily_summary RENAME TO host_daily_summary_legacy")
    conn.executescript(_CREATE_EXTENDED_TABLES_SQL)
    conn.execute(
        """
        INSERT INTO host_daily_summary (
            day, host_name, tz, host, sample_count, success_count,
            cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
            disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
            gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
            processes_sum, updated_at
        )
        SELECT
            day, host_name, ?, host, sample_count, success_count,
            cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
            disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
            gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
            processes_sum, updated_at
        FROM host_daily_summary_legacy
        """,
        (tz_key,),
    )
    conn.execute("DROP TABLE host_daily_summary_legacy")


def init_storage(db_path: Path, *, daily_summary_tz: str | None = "UTC") -> None:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(_CREATE_TABLE_SQL)
        conn.executescript(_CREATE_INDEX_SQL)
        conn.executescript(_CREATE_EXTENDED_TABLES_SQL)
        if daily_summary_tz is not None:
            _migrate_host_daily_summary(conn, daily_summary_tz)
        conn.executescript(_CREATE_EXTENDED_INDEX_SQL)
        conn.executescript(_CREATE_SETTINGS_TABLES_SQL)
        conn.executescript(_CREATE_SILENCE_TABLES_SQL)
        conn.executescript(_CREATE_SILENCE_INDEX_SQL)
        conn.executescript(_CREATE_SSH_AUDIT_TABLES_SQL)
        conn.executescript(_CREATE_SSH_AUDIT_INDEX_SQL)


def _percent_value(used: float | None, total: float | None) -> float | None:
    if used is None or total is None or float(total) <= 0:
        return None
    return float(used) / float(total) * 100.0


def _tz_key(tz: tzinfo) -> str:
    """Stable identifier for a timezone used to partition daily summaries."""
    key = getattr(tz, "key", None)
    if key:
        return str(key)
    return "UTC" if tz == timezone.utc else str(tz)


def _merge_daily_summary(
    conn: sqlite3.Connection,
    *,
    day: str,
    host_name: str,
    host: str,
    tz_key: str,
    values: dict[str, float | int | None],
    updated_at: str,
) -> None:
    """Accumulate one successful sample into ``host_daily_summary``.

    The table stores sums/max/min instead of averages so a day remains exact even
    after every raw point for that day has been pruned.  Missing values are
    ignored rather than written as zero.
    """
    existing = conn.execute(
        "SELECT * FROM host_daily_summary WHERE day = ? AND host_name = ? AND tz = ?",
        (day, host_name, tz_key),
    ).fetchone()
    if existing is None:
        row = {
            "day": day,
            "host_name": host_name,
            "tz": tz_key,
            "host": host,
            "sample_count": 1,
            "success_count": 1,
            "updated_at": updated_at,
        }
        row.update(
            {
                "cpu_sum": values.get("cpu"),
                "cpu_max": values.get("cpu"),
                "cpu_min": values.get("cpu"),
                "memory_pct_sum": values.get("memory_pct"),
                "memory_pct_max": values.get("memory_pct"),
                "disk_pct_sum": values.get("disk_pct"),
                "disk_pct_max": values.get("disk_pct"),
                "gpu_util_sum": values.get("gpu_util"),
                "gpu_util_max": values.get("gpu_util"),
                "gpu_memory_pct_sum": values.get("gpu_memory_pct"),
                "gpu_memory_pct_max": values.get("gpu_memory_pct"),
                "load_sum": values.get("load"),
                "users_sum": values.get("users"),
                "processes_sum": values.get("processes"),
            }
        )
        conn.execute(
            """
            INSERT INTO host_daily_summary
                (day, host_name, tz, host, sample_count, success_count,
                 cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
                 disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
                 gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
                 processes_sum, updated_at)
            VALUES
                (:day, :host_name, :tz, :host, :sample_count, :success_count,
                 :cpu_sum, :cpu_max, :cpu_min, :memory_pct_sum, :memory_pct_max,
                 :disk_pct_sum, :disk_pct_max, :gpu_util_sum, :gpu_util_max,
                 :gpu_memory_pct_sum, :gpu_memory_pct_max, :load_sum, :users_sum,
                 :processes_sum, :updated_at)
            """,
            row,
        )
        return

    updated = dict(existing)
    updated["sample_count"] = int(existing["sample_count"]) + 1
    updated["success_count"] = int(existing["success_count"]) + 1
    updated["updated_at"] = updated_at
    for prefix, value in (
        ("cpu", values.get("cpu")),
        ("memory_pct", values.get("memory_pct")),
        ("disk_pct", values.get("disk_pct")),
        ("gpu_util", values.get("gpu_util")),
        ("gpu_memory_pct", values.get("gpu_memory_pct")),
        ("load", values.get("load")),
        ("users", values.get("users")),
        ("processes", values.get("processes")),
    ):
        if value is None:
            continue
        updated[f"{prefix}_sum"] = float(existing[f"{prefix}_sum"] or 0) + float(value)
        if f"{prefix}_max" in updated:
            old_max = existing[f"{prefix}_max"]
            updated[f"{prefix}_max"] = (
                float(value) if old_max is None else max(float(old_max), float(value))
            )
        if f"{prefix}_min" in updated:
            old_min = existing[f"{prefix}_min"]
            updated[f"{prefix}_min"] = (
                float(value) if old_min is None else min(float(old_min), float(value))
            )
    conn.execute(
        """
        UPDATE host_daily_summary SET
            host = :host, sample_count = :sample_count,
            success_count = :success_count, cpu_sum = :cpu_sum,
            cpu_max = :cpu_max, cpu_min = :cpu_min,
            memory_pct_sum = :memory_pct_sum, memory_pct_max = :memory_pct_max,
            disk_pct_sum = :disk_pct_sum, disk_pct_max = :disk_pct_max,
            gpu_util_sum = :gpu_util_sum, gpu_util_max = :gpu_util_max,
            gpu_memory_pct_sum = :gpu_memory_pct_sum,
            gpu_memory_pct_max = :gpu_memory_pct_max,
            load_sum = :load_sum, users_sum = :users_sum,
            processes_sum = :processes_sum, updated_at = :updated_at
        WHERE day = :day AND host_name = :host_name AND tz = :tz
        """,
        updated,
    )


def persist_host_reports(
    report: DailyReport,
    db_path: Path,
    *,
    disk_mounts: Mapping[str, Sequence[str]] | None = None,
    tz: tzinfo = timezone.utc,
) -> None:
    db_path = Path(db_path)
    init_storage(db_path)

    rows: list[tuple] = []
    summary_rows: list[dict[str, object]] = []
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
        host_mounts = disk_mounts.get(host_report.host_name) if disk_mounts is not None else None

        rows.append(
            (
                row_collected_at,
                host_report.host_name,
                host_report.host,
                1,
                metrics.cpu_usage_percent,
                memory.used_mb if memory else None,
                memory.total_mb if memory else None,
                _extract_disk_used_percent(host_report, host_mounts),
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
        memory_used = memory.used_mb if memory else None
        memory_total = memory.total_mb if memory else None
        gpu_used = (
            sum(gpu.memory_used_mb for gpu in metrics.gpu_summary)
            if metrics.gpu_summary
            else None
        )
        gpu_total = (
            sum(gpu.memory_total_mb for gpu in metrics.gpu_summary)
            if metrics.gpu_summary
            else None
        )
        summary_rows.append(
            {
                "day": _parse_collected_at(row_collected_at)
                .astimezone(tz)
                .date()
                .isoformat(),
                "host_name": host_report.host_name,
                "host": host_report.host,
                "values": {
                    "cpu": metrics.cpu_usage_percent,
                    "memory_pct": _percent_value(memory_used, memory_total),
                    "disk_pct": _extract_disk_used_percent(host_report, host_mounts),
                    "gpu_util": _extract_gpu_utilization_percent(host_report),
                    "gpu_memory_pct": _percent_value(gpu_used, gpu_total),
                    "load": load.load_1 if load else None,
                    "users": len(metrics.logged_in_users),
                    "processes": metrics.total_processes,
                },
            }
        )

    if not rows:
        LOGGER.info("No successful host reports to persist")
        return

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
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
        for summary_row in summary_rows:
            _merge_daily_summary(
                conn,
                day=str(summary_row["day"]),
                host_name=str(summary_row["host_name"]),
                host=str(summary_row["host"]),
                tz_key=_tz_key(tz),
                values=summary_row["values"],  # type: ignore[arg-type]
                updated_at=collected_at,
            )
        conn.commit()

    LOGGER.info("Persisted %s host metric rows to %s", len(rows), db_path)


def backfill_daily_summary(db_path: Path, tz: tzinfo = timezone.utc) -> int:
    """Create missing daily summary rows from existing raw history.

    Existing summary rows are left untouched, so calling this on every startup
    is idempotent and never doubles counts.  Only days that still have raw
    samples can be reconstructed; that is enough for the upgrade path because
    pruning starts after this function has run.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        raw_rows = conn.execute(
            """
            SELECT collected_at, host_name, host, cpu_usage_percent,
                   memory_used_mb, memory_total_mb, disk_used_percent,
                   gpu_utilization_percent, gpu_memory_used_mb,
                   gpu_memory_total_mb, total_processes, logged_in_user_count,
                   load_1
              FROM host_metrics_history
             WHERE success = 1
            """
        ).fetchall()
        aggregated: dict[tuple[str, str, str, str], dict[str, float | int | None]] = {}
        tz_key = _tz_key(tz)
        for row in raw_rows:
            day = _parse_collected_at(row["collected_at"]).astimezone(tz).date().isoformat()
            key = (day, row["host_name"], row["host"], tz_key)
            bucket = aggregated.setdefault(
                key,
                {
                    "sample_count": 0,
                    "cpu_sum": 0.0, "cpu_max": None, "cpu_min": None,
                    "memory_pct_sum": 0.0, "memory_pct_max": None,
                    "disk_pct_sum": 0.0, "disk_pct_max": None,
                    "gpu_util_sum": 0.0, "gpu_util_max": None,
                    "gpu_memory_pct_sum": 0.0, "gpu_memory_pct_max": None,
                    "load_sum": 0.0, "users_sum": 0.0, "processes_sum": 0.0,
                },
            )
            bucket["sample_count"] = int(bucket["sample_count"] or 0) + 1
            values = {
                "cpu": row["cpu_usage_percent"],
                "memory_pct": _percent_value(row["memory_used_mb"], row["memory_total_mb"]),
                "disk_pct": row["disk_used_percent"],
                "gpu_util": row["gpu_utilization_percent"],
                "gpu_memory_pct": _percent_value(row["gpu_memory_used_mb"], row["gpu_memory_total_mb"]),
                "load": row["load_1"],
                "users": row["logged_in_user_count"],
                "processes": row["total_processes"],
            }
            for prefix, value in values.items():
                if value is None:
                    continue
                bucket[f"{prefix}_sum"] = float(bucket.get(f"{prefix}_sum") or 0) + float(value)
                max_key = f"{prefix}_max"
                if max_key in bucket:
                    bucket[max_key] = float(value) if bucket[max_key] is None else max(float(bucket[max_key]), float(value))
                min_key = f"{prefix}_min"
                if min_key in bucket:
                    bucket[min_key] = float(value) if bucket[min_key] is None else min(float(bucket[min_key]), float(value))

        inserted = 0
        now = datetime.now(timezone.utc).isoformat()
        for (day, host_name, host, tz_key), bucket in aggregated.items():
            exists = conn.execute(
                "SELECT 1 FROM host_daily_summary WHERE day = ? AND host_name = ? AND tz = ?",
                (day, host_name, tz_key),
            ).fetchone()
            if exists:
                continue
            conn.execute(
                """
                INSERT INTO host_daily_summary
                    (day, host_name, tz, host, sample_count, success_count,
                     cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
                     disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
                     gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
                     processes_sum, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (day, host_name, tz_key, host, bucket["sample_count"], bucket["sample_count"], bucket["cpu_sum"], bucket["cpu_max"], bucket["cpu_min"], bucket["memory_pct_sum"], bucket["memory_pct_max"], bucket["disk_pct_sum"], bucket["disk_pct_max"], bucket["gpu_util_sum"], bucket["gpu_util_max"], bucket["gpu_memory_pct_sum"], bucket["gpu_memory_pct_max"], bucket["load_sum"], bucket["users_sum"], bucket["processes_sum"], now),
            )
            inserted += 1
        conn.commit()
    return inserted


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


def fetch_host_history(
    db_path: Path,
    host_name: str,
    *,
    range_key: str = "24h",
    tz: tzinfo = timezone.utc,
    now: datetime | None = None,
) -> list[dict[str, object]]:
    """Return chart points for one host.

    ``24h`` reads raw samples (the last 100 points kept by retention) so the
    chart has detail.  ``7d``/``30d`` read the compact daily summary instead,
    which survives raw-point pruning.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []
    if range_key not in ("24h", "7d", "30d"):
        raise ValueError("range_key must be 24h, 7d or 30d")
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    if range_key == "24h":
        cutoff = (current - timedelta(hours=24)).astimezone(timezone.utc).isoformat()
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT collected_at, cpu_usage_percent, memory_used_mb,
                       memory_total_mb, disk_used_percent, gpu_utilization_percent,
                       gpu_memory_used_mb, gpu_memory_total_mb, load_1
                  FROM host_metrics_history
                 WHERE host_name = ? AND success = 1 AND collected_at >= ?
                 ORDER BY collected_at ASC
                """,
                (host_name, cutoff),
            ).fetchall()
        points: list[dict[str, object]] = []
        for row in rows:
            points.append(
                {
                    "t": _parse_collected_at(row["collected_at"]).astimezone(tz).isoformat(),
                    "cpu": row["cpu_usage_percent"],
                    "memory": _memory_percent(row),
                    "disk": row["disk_used_percent"],
                    "gpu_util": row["gpu_utilization_percent"],
                    "gpu_memory": _gpu_memory_percent(row),
                    "load_1": row["load_1"],
                }
            )
        return points

    days = 7 if range_key == "7d" else 30
    start_day = (current.astimezone(tz).date() - timedelta(days=days - 1)).isoformat()
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT day, sample_count, cpu_sum, memory_pct_sum, disk_pct_sum,
                   gpu_util_sum, gpu_memory_pct_sum, load_sum
              FROM host_daily_summary
             WHERE host_name = ? AND tz = ? AND day >= ?
             ORDER BY day ASC
            """,
            (host_name, _tz_key(tz), start_day),
        ).fetchall()
    points = []
    for row in rows:
        count = int(row["sample_count"] or 0)
        if count <= 0:
            continue
        points.append(
            {
                "t": str(row["day"]),
                "cpu": (float(row["cpu_sum"]) / count) if row["cpu_sum"] is not None else None,
                "memory": (float(row["memory_pct_sum"]) / count) if row["memory_pct_sum"] is not None else None,
                "disk": (float(row["disk_pct_sum"]) / count) if row["disk_pct_sum"] is not None else None,
                "gpu_util": (float(row["gpu_util_sum"]) / count) if row["gpu_util_sum"] is not None else None,
                "gpu_memory": (float(row["gpu_memory_pct_sum"]) / count) if row["gpu_memory_pct_sum"] is not None else None,
                "load_1": (float(row["load_sum"]) / count) if row["load_sum"] is not None else None,
            }
        )
    return points


def fetch_overview_history(
    db_path: Path,
    *,
    range_key: str = "24h",
    tz: tzinfo = timezone.utc,
    now: datetime | None = None,
) -> list[dict[str, object]]:
    """Return fleet-wide average chart points for the overview page."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []
    if range_key not in ("24h", "7d", "30d"):
        raise ValueError("range_key must be 24h, 7d or 30d")
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    if range_key == "24h":
        cutoff = (current - timedelta(hours=24)).astimezone(timezone.utc).isoformat()
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT collected_at,
                       AVG(cpu_usage_percent) AS cpu,
                       AVG(CASE WHEN memory_total_mb > 0
                                THEN memory_used_mb * 100.0 / memory_total_mb END) AS memory,
                       AVG(disk_used_percent) AS disk,
                       AVG(gpu_utilization_percent) AS gpu_util,
                       AVG(CASE WHEN gpu_memory_total_mb > 0
                                THEN gpu_memory_used_mb * 100.0 / gpu_memory_total_mb END) AS gpu_memory,
                       AVG(load_1) AS load_1
                  FROM host_metrics_history
                 WHERE success = 1 AND collected_at >= ?
                 GROUP BY collected_at
                 ORDER BY collected_at ASC
                """,
                (cutoff,),
            ).fetchall()
        return [
            {
                "t": _parse_collected_at(row["collected_at"]).astimezone(tz).isoformat(),
                "cpu": row["cpu"],
                "memory": row["memory"],
                "disk": row["disk"],
                "gpu_util": row["gpu_util"],
                "gpu_memory": row["gpu_memory"],
                "load_1": row["load_1"],
            }
            for row in rows
        ]

    days = 7 if range_key == "7d" else 30
    start_day = (current.astimezone(tz).date() - timedelta(days=days - 1)).isoformat()
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT day,
                   SUM(cpu_sum) AS cpu_sum,
                   SUM(memory_pct_sum) AS memory_sum,
                   SUM(disk_pct_sum) AS disk_sum,
                   SUM(gpu_util_sum) AS gpu_util_sum,
                   SUM(gpu_memory_pct_sum) AS gpu_memory_sum,
                   SUM(load_sum) AS load_sum,
                   SUM(sample_count) AS sample_count
              FROM host_daily_summary
             WHERE tz = ? AND day >= ?
             GROUP BY day
             ORDER BY day ASC
            """,
            (_tz_key(tz), start_day),
        ).fetchall()
    points = []
    for row in rows:
        count = int(row["sample_count"] or 0)
        if count <= 0:
            continue
        points.append(
            {
                "t": str(row["day"]),
                "cpu": (float(row["cpu_sum"]) / count) if row["cpu_sum"] is not None else None,
                "memory": (float(row["memory_sum"]) / count) if row["memory_sum"] is not None else None,
                "disk": (float(row["disk_sum"]) / count) if row["disk_sum"] is not None else None,
                "gpu_util": (float(row["gpu_util_sum"]) / count) if row["gpu_util_sum"] is not None else None,
                "gpu_memory": (float(row["gpu_memory_sum"]) / count) if row["gpu_memory_sum"] is not None else None,
                "load_1": (float(row["load_sum"]) / count) if row["load_sum"] is not None else None,
            }
        )
    return points


def fetch_alert_history(
    db_path: Path,
    *,
    range_key: str = "24h",
    tz: tzinfo = timezone.utc,
    now: datetime | None = None,
) -> list[dict[str, object]]:
    """Return per-bucket alert counts grouped by severity."""
    db_path = Path(db_path)
    if range_key not in ("24h", "7d", "30d"):
        raise ValueError("range_key must be 24h, 7d or 30d")
    if not db_path.exists():
        return []
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    local_now = current.astimezone(tz)

    if range_key == "24h":
        first = local_now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=23)
        keys = [first + timedelta(hours=i) for i in range(24)]
        labels = [item.strftime("%H:%M") for item in keys]
        key_of = lambda moment: moment.replace(minute=0, second=0, microsecond=0)
    else:
        days = 7 if range_key == "7d" else 30
        first_day = local_now.date() - timedelta(days=days - 1)
        keys = [first_day + timedelta(days=i) for i in range(days)]
        labels = [item.strftime("%m-%d") for item in keys]
        key_of = lambda moment: moment.date()

    cutoff = keys[0]
    if range_key == "24h":
        cutoff = cutoff.astimezone(timezone.utc)
    else:
        cutoff = datetime.combine(cutoff, datetime.min.time(), tzinfo=tz).astimezone(timezone.utc)
    cutoff_text = cutoff.isoformat()

    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT created_at, severity FROM alerts WHERE created_at >= ? ORDER BY created_at ASC",
            (cutoff_text,),
        ).fetchall()

    bucket_map = {key: {"critical": 0, "warning": 0, "info": 0} for key in keys}
    for created_at, severity in rows:
        try:
            moment = _parse_collected_at(str(created_at)).astimezone(tz)
        except (TypeError, ValueError):
            continue
        bucket = key_of(moment)
        counts = bucket_map.get(bucket)
        if counts is None:
            continue
        level = str(severity or "info").lower()
        if level not in counts:
            level = "info"
        counts[level] += 1

    result = []
    for key, label in zip(keys, labels):
        counts = bucket_map[key]
        result.append(
            {
                "key": key.isoformat() if hasattr(key, "isoformat") else str(key),
                "label": label,
                "critical": counts["critical"],
                "warning": counts["warning"],
                "info": counts["info"],
                "total": counts["critical"] + counts["warning"] + counts["info"],
            }
        )
    return result


def list_task_states(db_path: Path) -> list[dict[str, object]]:
    db_path = Path(db_path)
    if not db_path.exists():
        return []
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT task_name, last_run_at, last_result FROM task_state ORDER BY task_name"
            ).fetchall()
        except sqlite3.OperationalError:
            return []
    return [dict(row) for row in rows]


def database_integrity(db_path: Path) -> tuple[bool, str]:
    """Run SQLite's quick integrity check and return ``(ok, message)``."""
    db_path = Path(db_path)
    if not db_path.exists():
        return False, "数据库文件不存在"
    try:
        conn = sqlite3.connect(db_path)
        try:
            rows = conn.execute("PRAGMA quick_check").fetchall()
        finally:
            conn.close()
        problems = [str(row[0]) for row in rows if str(row[0]).lower() != "ok"]
    except sqlite3.DatabaseError as exc:
        return False, f"数据库无法读取：{exc}"
    if problems:
        return False, "完整性检查发现问题：" + "；".join(problems[:3])
    return True, "完整性检查通过"


def system_stats(db_path: Path) -> dict[str, object]:
    """Small read-only aggregate used by the system-health panel."""
    db_path = Path(db_path)
    stats: dict[str, object] = {
        "db_path": str(db_path),
        "db_size_bytes": db_path.stat().st_size if db_path.exists() else 0,
        "host_snapshots": 0,
        "history_rows": 0,
        "disk_batches": 0,
        "alerts_active": 0,
    }
    if not db_path.exists():
        return stats
    with sqlite3.connect(db_path) as conn:
        try:
            stats["host_snapshots"] = int(conn.execute(
                "SELECT COUNT(*) FROM host_latest_snapshot"
            ).fetchone()[0])
            stats["history_rows"] = int(conn.execute(
                "SELECT COUNT(*) FROM host_metrics_history"
            ).fetchone()[0])
            stats["disk_batches"] = int(conn.execute(
                "SELECT COUNT(*) FROM disk_health_snapshot"
            ).fetchone()[0])
            stats["alerts_active"] = int(conn.execute(
                "SELECT COUNT(*) FROM alerts WHERE status = 'active'"
            ).fetchone()[0])
        except sqlite3.OperationalError:
            pass
    return stats


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


def _summary_rows_for_week(
    db_path: Path, week_start: date, week_end: date, tz: tzinfo = timezone.utc
) -> list[sqlite3.Row]:
    if not Path(db_path).exists():
        return []
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(
                "SELECT * FROM host_daily_summary WHERE day >= ? AND day <= ? AND tz = ?"
                " ORDER BY host_name, day",
                (week_start.isoformat(), week_end.isoformat(), _tz_key(tz)),
            ).fetchall()
        except sqlite3.OperationalError:
            return []


def _summary_avg(row: sqlite3.Row, prefix: str) -> float | None:
    count = row["sample_count"]
    total = row[f"{prefix}_sum"]
    if not count or total is None:
        return None
    return float(total) / int(count)


def _summary_extreme(row: sqlite3.Row, prefix: str, kind: str) -> float | None:
    return row[f"{prefix}_{kind}"]


def fetch_daily_points_for_week(
    db_path: Path,
    week_start: date,
    week_end: date,
    tz: tzinfo = timezone.utc,
) -> list[dict[str, object]]:
    """Per-day averages per host for the week, bucketed by *local* day.

    Prefers the compact ``host_daily_summary`` table (which survives raw-point
    pruning); falls back to the legacy raw-history aggregation when no summary
    rows exist for the week.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    summary_rows = _summary_rows_for_week(db_path, week_start, week_end, tz)
    if summary_rows:
        return [
            {
                "day": row["day"],
                "host_name": row["host_name"],
                "host": row["host"],
                "cpu_avg": _summary_avg(row, "cpu"),
                "memory_percent": _summary_avg(row, "memory_pct"),
                "gpu_util": _summary_avg(row, "gpu_util"),
            }
            for row in summary_rows
        ]

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

    Prefers ``host_daily_summary`` so reports remain valid after raw-point
    pruning; falls back to the legacy raw-history aggregation when no summary
    rows exist for the week.  ``*_max`` / ``*_min`` stay raw extremes over the
    week and ``sample_count`` stays the raw sample count.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    summary_rows = _summary_rows_for_week(db_path, week_start, week_end, tz)
    if summary_rows:
        grouped: dict[tuple[str, str], list[sqlite3.Row]] = {}
        for row in summary_rows:
            grouped.setdefault((row["host_name"], row["host"]), []).append(row)
        results = []
        for (host_name, host), rows in grouped.items():
            results.append(
                {
                    "host_name": host_name,
                    "host": host,
                    "sample_count": sum(int(r["sample_count"]) for r in rows),
                    "success_count": sum(int(r["success_count"]) for r in rows),
                    "cpu_avg": _mean([_summary_avg(r, "cpu") for r in rows]),
                    "cpu_max": _max_or_none([_summary_extreme(r, "cpu", "max") for r in rows]),
                    "cpu_min": _min_or_none([_summary_extreme(r, "cpu", "min") for r in rows]),
                    "memory_avg_percent": _mean([_summary_avg(r, "memory_pct") for r in rows]),
                    "memory_max_percent": _max_or_none([_summary_extreme(r, "memory_pct", "max") for r in rows]),
                    "disk_avg_percent": _mean([_summary_avg(r, "disk_pct") for r in rows]),
                    "disk_max_percent": _max_or_none([_summary_extreme(r, "disk_pct", "max") for r in rows]),
                    "gpu_util_avg": _mean([_summary_avg(r, "gpu_util") for r in rows]),
                    "gpu_util_max": _max_or_none([_summary_extreme(r, "gpu_util", "max") for r in rows]),
                    "gpu_memory_avg_percent": _mean([_summary_avg(r, "gpu_memory_pct") for r in rows]),
                    "gpu_memory_max_percent": _max_or_none([_summary_extreme(r, "gpu_memory_pct", "max") for r in rows]),
                    "load_avg": _mean([_summary_avg(r, "load") for r in rows]),
                    "users_avg": _mean([_summary_avg(r, "users") for r in rows]),
                    "processes_avg": _mean([_summary_avg(r, "processes") for r in rows]),
                }
            )
        results.sort(key=lambda item: item["host_name"])
        return results

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
    since: datetime | str | None = None,
    limit: int = 200,
) -> list[dict]:
    """Return alerts (newest first), optionally filtered by *status* and time.

    ``since`` accepts an aware :class:`datetime` or an ISO-8601 string.  The
    database stores ``created_at`` as UTC ISO-8601, so string comparison is
    safe as long as the value is normalised to UTC first.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    clauses: list[str] = []
    params: list[object] = []
    if status is not None:
        clauses.append("status = ?")
        params.append(status)
    if since is not None:
        if isinstance(since, datetime):
            value = since
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            since = value.astimezone(timezone.utc).isoformat()
        clauses.append("created_at >= ?")
        params.append(since)
    sql = "SELECT * FROM alerts"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    params.append(int(limit))

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, params).fetchall()

    return [dict(row) for row in rows]


def count_alerts_by_status(
    db_path: Path,
    *,
    since: datetime | str | None = None,
) -> dict[str, int]:
    """Count alerts grouped by status, optionally restricted to a time window.

    Always returns keys for ``active``, ``acknowledged`` and ``resolved`` (zero
    when absent), plus ``total``.  ``since`` follows the same normalisation as
    :func:`list_alerts`.
    """
    db_path = Path(db_path)
    counts = {"active": 0, "acknowledged": 0, "resolved": 0, "total": 0}
    if not db_path.exists():
        return counts

    params: list[object] = []
    clause = ""
    if since is not None:
        if isinstance(since, datetime):
            value = since
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            since = value.astimezone(timezone.utc).isoformat()
        clause = " WHERE created_at >= ?"
        params.append(since)

    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            f"SELECT status, COUNT(*) AS count FROM alerts{clause} GROUP BY status",
            params,
        ).fetchall()
    for status, count in rows:
        if status in counts:
            counts[status] = int(count)
        counts["total"] += int(count)
    return counts


def list_alerts_for_host(
    host_name: str,
    db_path: Path,
    *,
    limit: int = 20,
) -> list[dict]:
    """Return the most recent alerts for one host (newest first)."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM alerts WHERE host_name = ?"
            " ORDER BY created_at DESC, id DESC LIMIT ?",
            (host_name, int(limit)),
        ).fetchall()

    return [dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Alert silences (maintenance windows that suppress notifications)
# ---------------------------------------------------------------------------


def _to_iso_utc(value: datetime | str) -> str:
    """Normalise a ``datetime`` or ISO string to an ISO-8601 UTC string.

    Aware datetimes are converted to UTC; naive ones are assumed to already be
    UTC.  Strings are returned unchanged (the caller contract is ISO-8601 UTC).
    """
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _parse_iso_datetime(value: object) -> datetime | None:
    """Parse a stored ISO-8601 string into an aware datetime, or ``None``."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def insert_silence(
    scope_type: str,
    scope: str | None,
    reason: str,
    starts_at: datetime | str,
    ends_at: datetime | str,
    created_by: str | None,
    db_path: Path,
) -> int:
    """Insert an alert-silence window and return its row id.

    ``scope_type`` is ``host`` / ``group`` / ``all``; ``scope`` is the host or
    group name and must be ``None`` for the global ``all`` scope.  ``starts_at``
    and ``ends_at`` accept a ``datetime`` or an ISO-8601 string and are stored
    as ISO-8601 UTC text.
    """
    db_path = Path(db_path)
    init_storage(db_path)

    created_at = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(
            "INSERT INTO alert_silences"
            " (scope_type, scope, reason, starts_at, ends_at, created_at, created_by)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                scope_type,
                scope,
                reason,
                _to_iso_utc(starts_at),
                _to_iso_utc(ends_at),
                created_at,
                created_by,
            ),
        )
        conn.commit()
        return int(cursor.lastrowid)


def list_silences(
    db_path: Path,
    *,
    active_only: bool = False,
    now: datetime | str | None = None,
) -> list[dict]:
    """Return silence rows, newest-id last, ordered by ``id``.

    With ``active_only=True`` only rows whose window contains ``now`` survive,
    using the half-open interval ``starts_at <= now < ends_at``.  ``now``
    defaults to the current UTC instant and may be a ``datetime`` or ISO-8601
    string.  Rows whose ``starts_at`` / ``ends_at`` cannot be parsed as ISO-8601
    are skipped rather than raising, so a single corrupt row never breaks the
    list.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    try:
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            raw_rows = conn.execute(
                "SELECT * FROM alert_silences ORDER BY id"
            ).fetchall()
    except sqlite3.OperationalError:
        return []

    reference: datetime | None = None
    if active_only:
        if now is None:
            reference = datetime.now(timezone.utc)
        elif isinstance(now, datetime):
            reference = (
                now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
            )
        else:
            reference = _parse_iso_datetime(now) or datetime.now(timezone.utc)

    results: list[dict] = []
    for raw in raw_rows:
        starts = _parse_iso_datetime(raw["starts_at"])
        ends = _parse_iso_datetime(raw["ends_at"])
        if starts is None or ends is None:
            continue
        if active_only and reference is not None and not (starts <= reference < ends):
            continue
        results.append(dict(raw))
    return results


def delete_silence(silence_id: int, db_path: Path) -> bool:
    """Delete the silence row; return ``True`` when a row was removed."""
    db_path = Path(db_path)
    if not db_path.exists():
        return False

    try:
        with sqlite3.connect(db_path) as conn:
            cursor = conn.execute(
                "DELETE FROM alert_silences WHERE id = ?", (int(silence_id),)
            )
            conn.commit()
            return cursor.rowcount > 0
    except sqlite3.OperationalError:
        return False


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
# SSH session audit (metadata only)
# ---------------------------------------------------------------------------


def _ssh_audit_now() -> str:
    """Current UTC instant as an ISO-8601 string for audit timestamps."""
    return datetime.now(timezone.utc).isoformat()


def record_ssh_session_start(
    host_name: str,
    username: str,
    server_username: str | None = None,
    remote_addr: str = "127.0.0.1",
    started_at: str | None = None,
    *,
    db_path: Path,
) -> int:
    """Insert an ``active`` audit row and return its row id.

    ``host_name`` is the dashboard host label, ``username`` the dashboard admin
    account, ``server_username`` the SSH login account and ``remote_addr`` the
    caller address (always ``127.0.0.1`` in loopback-only desktop mode).  Only
    session metadata is stored; terminal input/output is never recorded.
    """
    db_path = Path(db_path)
    init_storage(db_path)
    started = started_at if started_at is not None else _ssh_audit_now()

    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(
            "INSERT INTO ssh_audit_sessions"
            " (host_name, username, server_username, remote_addr, started_at,"
            " status)"
            " VALUES (?, ?, ?, ?, ?, 'active')",
            (host_name, username, server_username, remote_addr, started),
        )
        conn.commit()
        return int(cursor.lastrowid)


def record_ssh_session_end(
    session_id: int,
    status: str = "closed",
    error: str | None = None,
    ended_at: str | None = None,
    *,
    db_path: Path,
) -> bool:
    """Finalise an audit row, returning ``True`` when the row was updated."""
    db_path = Path(db_path)
    if not db_path.exists():
        return False
    ended = ended_at if ended_at is not None else _ssh_audit_now()

    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(
            "UPDATE ssh_audit_sessions"
            " SET status = ?, error = ?, ended_at = ?"
            " WHERE id = ?",
            (status, error, ended, session_id),
        )
        conn.commit()
        return cursor.rowcount > 0


def list_ssh_sessions(db_path: Path, limit: int = 100) -> list[sqlite3.Row]:
    """Return audit rows ordered by ``started_at`` (newest first)."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    try:
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT id, host_name, username, server_username, remote_addr,"
                " started_at, ended_at, status, error"
                " FROM ssh_audit_sessions"
                " ORDER BY started_at DESC, id DESC"
                " LIMIT ?",
                (limit,),
            ).fetchall()
    except sqlite3.OperationalError:
        return []

    return list(rows)


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
    the three disk snapshot tables, alerts that are both older than the cutoff
    and ``status = 'resolved'``, silence rows whose ``ends_at`` is before
    the cutoff, and SSH audit rows whose ``started_at`` is before the cutoff.
    Active alerts are never purged.  Pass ``now`` in tests to pin the cutoff.
    """
    db_path = Path(db_path)
    counts = {table: 0 for table in _PURGE_TABLES}
    counts["alerts"] = 0
    counts["alert_silences"] = 0
    counts["ssh_audit_sessions"] = 0
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
        cursor = conn.execute(
            "DELETE FROM alert_silences WHERE ends_at < ?", (cutoff,)
        )
        counts["alert_silences"] = (
            cursor.rowcount if cursor.rowcount is not None else 0
        )
        cursor = conn.execute(
            "DELETE FROM ssh_audit_sessions WHERE started_at < ?", (cutoff,)
        )
        counts["ssh_audit_sessions"] = (
            cursor.rowcount if cursor.rowcount is not None else 0
        )
        conn.commit()

    return counts


def prune_host_metrics(db_path: Path, max_points_per_host: int = 100) -> int:
    """Keep only the newest *max_points_per_host* rows for every host."""
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    limit = max(1, int(max_points_per_host))
    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(
            """
            DELETE FROM host_metrics_history
             WHERE id NOT IN (
                SELECT id FROM (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY host_name
                               ORDER BY collected_at DESC, id DESC
                           ) AS rn
                      FROM host_metrics_history
                ) ranked
                WHERE ranked.rn <= ?
             )
            """,
            (limit,),
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
    return deleted


def prune_disk_health(
    db_path: Path,
    retention_days: int = 7,
    max_batches_per_host: int = 100,
    *,
    now: datetime | None = None,
) -> dict[str, int]:
    """Prune disk batches beyond *retention_days* or newest *max_batches_per_host*."""
    db_path = Path(db_path)
    counts = {
        "disk_health_snapshot": 0,
        "disk_controller_snapshot": 0,
        "disk_vd_snapshot": 0,
        "disk_pd_snapshot": 0,
    }
    if not db_path.exists():
        return counts
    reference = now if now is not None else datetime.now(timezone.utc)
    cutoff = (reference - timedelta(days=max(1, int(retention_days)))).isoformat()
    keep_count = max(1, int(max_batches_per_host))
    with sqlite3.connect(db_path) as conn:
        headers = conn.execute(
            "SELECT host_name, collected_at FROM disk_health_snapshot"
            " ORDER BY host_name, collected_at DESC"
        ).fetchall()
        keep: dict[str, int] = {}
        to_delete: list[tuple[str, str]] = []
        for host_name, collected_at in headers:
            index = keep.get(host_name, 0)
            keep[host_name] = index + 1
            if index >= keep_count or collected_at < cutoff:
                to_delete.append((host_name, collected_at))
        for host_name, collected_at in to_delete:
            conn.execute(
                "DELETE FROM disk_health_snapshot WHERE host_name = ? AND collected_at = ?",
                (host_name, collected_at),
            )
        counts["disk_health_snapshot"] = len(to_delete)
        for table in (
            "disk_controller_snapshot",
            "disk_vd_snapshot",
            "disk_pd_snapshot",
        ):
            cursor = conn.execute(
                f"""
                DELETE FROM {table}
                 WHERE NOT EXISTS (
                    SELECT 1 FROM disk_health_snapshot h
                     WHERE h.host_name = {table}.host_name
                       AND h.collected_at = {table}.collected_at
                 )
                """
            )
            counts[table] = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
    return counts


def prune_alert_history(
    db_path: Path, retention_days: int = 30, *, now: datetime | None = None
) -> int:
    """Delete only resolved alerts older than *retention_days*."""
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    reference = now if now is not None else datetime.now(timezone.utc)
    cutoff = (reference - timedelta(days=max(1, int(retention_days)))).isoformat()
    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(
            "DELETE FROM alerts WHERE status = 'resolved' AND created_at < ?",
            (cutoff,),
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
    return deleted


def prune_ssh_audit(
    db_path: Path, retention_days: int = 30, *, now: datetime | None = None
) -> int:
    """Delete only ended SSH audit rows older than *retention_days*."""
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    reference = now if now is not None else datetime.now(timezone.utc)
    cutoff = (reference - timedelta(days=max(1, int(retention_days)))).isoformat()
    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(
            "DELETE FROM ssh_audit_sessions"
            " WHERE ended_at IS NOT NULL AND started_at < ?",
            (cutoff,),
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
    return deleted


def prune_daily_summary(
    db_path: Path, retention_days: int = 90, *, now: datetime | None = None
) -> int:
    """Delete daily summary rows older than *retention_days* (local-date key)."""
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    reference = now if now is not None else datetime.now(timezone.utc)
    cutoff_day = (
        reference - timedelta(days=max(1, int(retention_days)))
    ).date().isoformat()
    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(
            "DELETE FROM host_daily_summary WHERE day < ?", (cutoff_day,)
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
    return deleted


def prune_alert_silences(db_path: Path, *, now: datetime | None = None) -> int:
    """Delete silence rows whose window already ended."""
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    reference = now if now is not None else datetime.now(timezone.utc)
    with sqlite3.connect(db_path) as conn:
        cursor = conn.execute(
            "DELETE FROM alert_silences WHERE ends_at < ?", (reference.isoformat(),)
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
    return deleted


def prune_retention(db_path: Path, config, *, now: datetime | None = None) -> dict[str, int]:
    """Apply the full v1.6 retention matrix and return per-key counts."""
    app = config.app if hasattr(config, "app") else config
    counts: dict[str, int] = {}
    counts["host_metrics_history"] = prune_host_metrics(
        db_path, app.host_metrics_max_points
    )
    counts.update(
        prune_disk_health(
            db_path,
            app.disk_health_retention_days,
            app.disk_health_max_batches,
            now=now,
        )
    )
    counts["host_daily_summary"] = prune_daily_summary(
        db_path, app.host_daily_summary_retention_days, now=now
    )
    counts["alerts"] = prune_alert_history(
        db_path, app.alert_history_retention_days, now=now
    )
    counts["ssh_audit_sessions"] = prune_ssh_audit(
        db_path, app.ssh_audit_retention_days, now=now
    )
    counts["alert_silences"] = prune_alert_silences(db_path, now=now)
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


def backup_database(db_path: Path, destination: Path) -> None:
    """Create a transactionally consistent copy of *db_path* at *destination*."""
    db_path = Path(db_path)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    source = sqlite3.connect(db_path)
    target = sqlite3.connect(destination)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()


def validate_backup_database(path: Path) -> None:
    """Raise ``ValueError`` unless *path* is a healthy server-monitor SQLite DB."""
    path = Path(path)
    try:
        with path.open("rb") as handle:
            header = handle.read(16)
    except OSError as exc:
        raise ValueError("无法读取备份文件") from exc
    if header != b"SQLite format 3\x00":
        raise ValueError("不是有效的 SQLite 数据库文件")

    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            check = connection.execute("PRAGMA integrity_check").fetchone()
            if not check or check[0] != "ok":
                raise ValueError("数据库完整性检查失败")
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
        finally:
            connection.close()
    except sqlite3.DatabaseError as exc:
        raise ValueError("无法打开数据库文件") from exc

    if not {"app_settings", "app_secrets"} <= tables:
        raise ValueError("备份文件不是本工具的数据库")


def restore_database(source: Path, destination: Path) -> None:
    """Replace *destination* with the contents of *source* using SQLite backup."""
    source = Path(source)
    destination = Path(destination)
    source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    target_connection = sqlite3.connect(destination, timeout=30)
    try:
        source_connection.backup(target_connection)
    finally:
        target_connection.close()
        source_connection.close()
