"""connection management, schema/migrations and shared helpers (M4: split out of ``storage.py``)."""

from __future__ import annotations

from __future__ import annotations
import json
import logging
import sqlite3
import threading
import time as _time
from collections.abc import Mapping, Sequence
from contextlib import closing
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from pathlib import Path
from servermanage import disk_capacity
from servermanage.disk_health import AlertEvent, DiskHealthReport
from servermanage.models import DailyReport, HostCheckResult, HostReport
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
    load_15 REAL,
    net_rx_bytes INTEGER,
    net_tx_bytes INTEGER,
    temperature_c REAL
);
"""


_CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_host_metrics_history_collected_at
    ON host_metrics_history(collected_at);
CREATE INDEX IF NOT EXISTS idx_host_metrics_history_host
    ON host_metrics_history(host_name, host);
"""


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


_CREATE_HOST_CHECK_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS host_check_snapshot (
    host_name TEXT NOT NULL,
    check_name TEXT NOT NULL,
    check_type TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    latency_ms REAL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (host_name, check_name)
);
"""


_CREATE_HOST_CHECK_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_host_check_snapshot_host
    ON host_check_snapshot(host_name);
"""


_CREATE_HOST_CHECK_HISTORY_SQL = """
CREATE TABLE IF NOT EXISTS host_check_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_name TEXT NOT NULL,
    check_name TEXT NOT NULL,
    status TEXT NOT NULL,
    latency_ms REAL,
    checked_at TEXT NOT NULL
);
"""


_CREATE_HOST_CHECK_HISTORY_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_host_check_history_lookup
    ON host_check_history(host_name, check_name, id);
"""


_CREATE_USER_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS host_user_snapshot (
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    uid INTEGER NOT NULL,
    gid INTEGER NOT NULL,
    primary_group TEXT,
    gecos TEXT,
    home TEXT,
    shell TEXT,
    groups_json TEXT NOT NULL DEFAULT '[]',
    in_docker INTEGER NOT NULL DEFAULT 0,
    in_sudo INTEGER NOT NULL DEFAULT 0,
    home_exists INTEGER NOT NULL DEFAULT 0,
    home_owner TEXT,
    home_group TEXT,
    home_mode TEXT,
    home_size_bytes INTEGER,
    data_exists INTEGER NOT NULL DEFAULT 0,
    data_owner TEXT,
    data_group TEXT,
    data_mode TEXT,
    data_size_bytes INTEGER,
    data_supported INTEGER NOT NULL DEFAULT 1,
    usage_stale INTEGER NOT NULL DEFAULT 0,
    usage_readable INTEGER NOT NULL DEFAULT 1,
    usage_collected_at TEXT,
    collected_at TEXT NOT NULL,
    PRIMARY KEY (host_name, username)
);
CREATE TABLE IF NOT EXISTS host_user_baseline (
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    uid INTEGER,
    gid INTEGER,
    primary_group TEXT,
    shell TEXT,
    home TEXT,
    groups_json TEXT NOT NULL DEFAULT '[]',
    in_docker INTEGER NOT NULL DEFAULT 0,
    in_sudo INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (host_name, username)
);
CREATE TABLE IF NOT EXISTS host_user_scan_state (
    host_name TEXT PRIMARY KEY,
    last_scan_at TEXT,
    last_usage_at TEXT,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS host_user_usage_history (
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    home_size_bytes INTEGER,
    data_size_bytes INTEGER,
    PRIMARY KEY (host_name, username, collected_at)
);
CREATE INDEX IF NOT EXISTS idx_user_usage_history
    ON host_user_usage_history (host_name, collected_at);
CREATE TABLE IF NOT EXISTS user_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    host_name TEXT NOT NULL,
    account TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    actor TEXT,
    plan_hash TEXT,
    steps_json TEXT NOT NULL DEFAULT '[]',
    error TEXT
);
"""


_CREATE_USER_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_host_user_snapshot_host
    ON host_user_snapshot(host_name);
"""


_INITIALIZED: set[tuple[str, str]] = set()


_INIT_LOCK = threading.Lock()


_INTEGRITY_CACHE: dict[str, tuple[float, tuple[bool, str]]] = {}


_PURGE_TABLES = (
    "host_metrics_history",
    "disk_health_snapshot",
    "disk_controller_snapshot",
    "disk_vd_snapshot",
    "disk_pd_snapshot",
)


_SNAPSHOT_INSERT_SQL = """
INSERT INTO host_user_snapshot (
    host_name, username, uid, gid, primary_group, gecos, home,
    shell, groups_json, in_docker, in_sudo, home_exists,
    home_owner, home_group, home_mode, home_size_bytes,
    data_exists, data_owner, data_group, data_mode,
    data_size_bytes, data_supported, usage_stale, usage_readable,
    usage_collected_at, collected_at
) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?
)
"""


def _account_groups(account: Mapping[str, object]) -> list[str]:
    groups = account.get("groups")
    if not groups:
        return []
    return [str(group) for group in groups]  # type: ignore[union-attr]


def _connect(db_path: Path, *, timeout: float = 10.0) -> sqlite3.Connection:
    """Open a connection with the pragmas every reader and writer here wants.

    WAL mode is stored in the database file, but ``busy_timeout`` and
    ``synchronous`` are per-connection, so each connection reapplies them.
    ``NORMAL`` under WAL is corruption-safe and keeps the 30 s dashboard poll
    from fighting the collector over fsyncs.
    """
    conn = sqlite3.connect(db_path, timeout=timeout)
    try:
        conn.execute(f"PRAGMA busy_timeout = {int(timeout * 1000)}")
        conn.execute("PRAGMA synchronous = NORMAL")
    except sqlite3.DatabaseError:  # pragma: no cover - unreadable file
        pass
    return conn


def _disk_percent_value(percent: str) -> int:
    digits = "".join(ch for ch in percent if ch.isdigit())
    if not digits:
        return -1
    return int(digits)


def _dump_reasons(reasons: list[str] | None) -> str:
    return json.dumps(reasons or [], ensure_ascii=False)


def _ensure_host_metrics_columns(conn: sqlite3.Connection) -> None:
    """Add network counter columns to databases created before v0.1.75.

    ``CREATE TABLE IF NOT EXISTS`` never touches an existing table, so older
    installs need an explicit migration.  Both columns are nullable, which keeps
    historical rows valid and lets the UI hide the metric when it is unknown.
    """
    existing = {row[1] for row in conn.execute("PRAGMA table_info(host_metrics_history)")}
    for column in ("net_rx_bytes", "net_tx_bytes"):
        if column not in existing:
            conn.execute(f"ALTER TABLE host_metrics_history ADD COLUMN {column} INTEGER")
    if "temperature_c" not in existing:
        conn.execute("ALTER TABLE host_metrics_history ADD COLUMN temperature_c REAL")


def _ensure_user_snapshot_columns(conn: sqlite3.Connection) -> None:
    """Add columns introduced after the first 0.3.0 build to existing databases."""
    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(host_user_snapshot)")
    }
    if "usage_readable" not in columns:
        conn.execute(
            "ALTER TABLE host_user_snapshot"
            " ADD COLUMN usage_readable INTEGER NOT NULL DEFAULT 1"
        )


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


def _flag(value: object, *, default: bool = False) -> int:
    if value is None:
        return 1 if default else 0
    return 1 if value else 0


def _gpu_memory_percent(row: sqlite3.Row) -> float | None:
    total = row["gpu_memory_total_mb"]
    used = row["gpu_memory_used_mb"]
    if total and total > 0 and used is not None:
        return float(used) / float(total) * 100.0
    return None


def _load_groups(value: object) -> list[str]:
    """Decode a stored ``groups_json`` column into a list of group names."""
    if not value:
        return []
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(group) for group in parsed]


def _load_reasons(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


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


def _max_or_none(values: list[float | None]) -> float | None:
    numbers = [float(value) for value in values if value is not None]
    return max(numbers) if numbers else None


def _mean(values: list[float | None]) -> float | None:
    """Arithmetic mean of the non-``None`` values, or ``None`` if there are none."""
    numbers = [float(value) for value in values if value is not None]
    if not numbers:
        return None
    return sum(numbers) / len(numbers)


def _memory_percent(row: sqlite3.Row) -> float | None:
    total = row["memory_total_mb"]
    used = row["memory_used_mb"]
    if total and total > 0 and used is not None:
        return float(used) / float(total) * 100.0
    return None


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


def _min_or_none(values: list[float | None]) -> float | None:
    numbers = [float(value) for value in values if value is not None]
    return min(numbers) if numbers else None


def _network_rate_pair(rows) -> dict[str, float | None]:
    """Compute rx/tx rates from a host's two most recent samples."""
    if len(rows) < 2:
        return {"rx_bytes_per_second": None, "tx_bytes_per_second": None}
    latest, previous = rows[0], rows[1]
    try:
        latest_at = _parse_collected_at(latest[0])
        previous_at = _parse_collected_at(previous[0])
    except (TypeError, ValueError):
        return {"rx_bytes_per_second": None, "tx_bytes_per_second": None}
    seconds = (latest_at - previous_at).total_seconds()
    if seconds <= 0:
        return {"rx_bytes_per_second": None, "tx_bytes_per_second": None}

    def _rate(current, before):
        if current is None or before is None:
            return None
        delta = int(current) - int(before)
        if delta < 0:
            return None
        return round(delta / seconds, 1)

    return {
        "rx_bytes_per_second": _rate(latest[1], previous[1]),
        "tx_bytes_per_second": _rate(latest[2], previous[2]),
    }


def _optional_iso(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return _to_iso_utc(value)
    return str(value)


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


def _percent_value(used: float | None, total: float | None) -> float | None:
    if used is None or total is None or float(total) <= 0:
        return None
    return float(used) / float(total) * 100.0


def _settings_now() -> str:
    """Current UTC instant as an ISO-8601 string for ``updated_at`` columns."""
    return datetime.now(timezone.utc).isoformat()


def _ssh_audit_now() -> str:
    """Current UTC instant as an ISO-8601 string for audit timestamps."""
    return datetime.now(timezone.utc).isoformat()


def _summary_avg(row: sqlite3.Row, prefix: str) -> float | None:
    count = row["sample_count"]
    total = row[f"{prefix}_sum"]
    if not count or total is None:
        return None
    return float(total) / int(count)


def _summary_extreme(row: sqlite3.Row, prefix: str, kind: str) -> float | None:
    return row[f"{prefix}_{kind}"]


def _summary_rows_for_week(
    db_path: Path, week_start: date, week_end: date, tz: tzinfo = timezone.utc
) -> list[sqlite3.Row]:
    if not Path(db_path).exists():
        return []
    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(
                "SELECT * FROM host_daily_summary WHERE day >= ? AND day <= ? AND tz = ?"
                " ORDER BY host_name, day",
                (week_start.isoformat(), week_end.isoformat(), _tz_key(tz)),
            ).fetchall()
        except sqlite3.OperationalError:
            return []


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


def _tz_key(tz: tzinfo) -> str:
    """Stable identifier for a timezone used to partition daily summaries."""
    key = getattr(tz, "key", None)
    if key:
        return str(key)
    return "UTC" if tz == timezone.utc else str(tz)


def delete_app_settings(section: str, db_path: Path) -> None:
    """Remove the settings row for *section* if present."""
    db_path = Path(db_path)
    if not db_path.exists():
        return

    try:
        with _connect(db_path) as conn:
            conn.execute("DELETE FROM app_settings WHERE section = ?", (section,))
            conn.commit()
    except sqlite3.OperationalError:
        return


def delete_secret(name: str, db_path: Path) -> None:
    """Remove the secret stored under *name* if present."""
    db_path = Path(db_path)
    if not db_path.exists():
        return

    try:
        with _connect(db_path) as conn:
            conn.execute("DELETE FROM app_secrets WHERE name = ?", (name,))
            conn.commit()
    except sqlite3.OperationalError:
        return


def get_secret(name: str, db_path: Path) -> bytes | None:
    """Return the stored ciphertext for *name*, or ``None`` when absent."""
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    try:
        with _connect(db_path) as conn:
            row = conn.execute(
                "SELECT ciphertext FROM app_secrets WHERE name = ?", (name,)
            ).fetchone()
    except sqlite3.OperationalError:
        return None

    if row is None:
        return None
    value = row[0]
    return bytes(value) if value is not None else None


def get_task_state(task_name: str, db_path: Path) -> dict | None:
    """Return the stored state for *task_name*, or ``None``."""
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT task_name, last_run_at, last_result FROM task_state"
            " WHERE task_name = ?",
            (task_name,),
        ).fetchone()

    return dict(row) if row is not None else None


def init_storage(
    db_path: Path,
    *,
    daily_summary_tz: str | None = "UTC",
    force: bool = False,
) -> None:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if not db_path.exists():
        # A previous database may have left stale -wal/-shm siblings behind;
        # replaying them into a brand-new file would resurrect old pages, so
        # start clean.
        db_path.with_name(db_path.name + "-wal").unlink(missing_ok=True)
        db_path.with_name(db_path.name + "-shm").unlink(missing_ok=True)
    cache_key = (str(db_path.resolve()), daily_summary_tz or "")
    if not force:
        with _INIT_LOCK:
            if cache_key in _INITIALIZED and db_path.exists():
                return
    conn = _connect(db_path)
    try:
        try:
            # WAL lets the dashboard poll read while the collector writes
            # instead of failing with "database is locked".  It persists in
            # the file, so re-running it also heals restored databases.
            conn.execute("PRAGMA journal_mode = WAL")
        except sqlite3.DatabaseError:  # pragma: no cover - network shares etc.
            LOGGER.warning(
                "WAL mode unavailable for %s; keeping the default journal", db_path
            )
        # On a brand-new file this must be set before any table exists.  Older
        # databases keep auto_vacuum=0 until maintain_database() performs its
        # one-time compaction.
        conn.execute("PRAGMA auto_vacuum = INCREMENTAL")
        conn.executescript(_CREATE_TABLE_SQL)
        _ensure_host_metrics_columns(conn)
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
        conn.executescript(_CREATE_HOST_CHECK_TABLES_SQL)
        conn.executescript(_CREATE_HOST_CHECK_INDEX_SQL)
        conn.executescript(_CREATE_HOST_CHECK_HISTORY_SQL)
        conn.executescript(_CREATE_HOST_CHECK_HISTORY_INDEX_SQL)
        conn.executescript(_CREATE_USER_TABLES_SQL)
        _ensure_user_snapshot_columns(conn)
        conn.executescript(_CREATE_USER_INDEX_SQL)
        conn.commit()
    finally:
        # Close for real: a lingering handle would keep the -wal file locked
        # on Windows and break "delete and recreate" flows.
        conn.close()
    with _INIT_LOCK:
        _INITIALIZED.add(cache_key)


def list_secret_names(db_path: Path) -> list[str]:
    """Return every stored secret name, ordered alphabetically."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    try:
        with _connect(db_path) as conn:
            rows = conn.execute("SELECT name FROM app_secrets ORDER BY name").fetchall()
    except sqlite3.OperationalError:
        return []

    return [name for (name,) in rows]


def list_ssh_sessions(db_path: Path, limit: int = 100) -> list[sqlite3.Row]:
    """Return audit rows ordered by ``started_at`` (newest first)."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    try:
        with _connect(db_path) as conn:
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


def list_task_states(db_path: Path) -> list[dict[str, object]]:
    db_path = Path(db_path)
    if not db_path.exists():
        return []
    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT task_name, last_run_at, last_result FROM task_state ORDER BY task_name"
            ).fetchall()
        except sqlite3.OperationalError:
            return []
    return [dict(row) for row in rows]


def load_app_settings(db_path: Path) -> dict[str, dict]:
    """Return ``{section: payload}`` for every stored settings section."""
    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    try:
        with _connect(db_path) as conn:
            rows = conn.execute(
                "SELECT section, payload FROM app_settings"
            ).fetchall()
    except sqlite3.OperationalError:
        return {}

    return {section: json.loads(payload) for section, payload in rows}


def maintain_database(
    db_path: Path,
    *,
    force: bool = False,
    min_free_pages: int = 0,
) -> dict[str, object]:
    """Reclaim free SQLite pages after retention deletes.

    New databases are switched to ``auto_vacuum=INCREMENTAL``.  Existing
    databases created before that setting need one ``VACUUM`` rewrite; later
    calls only run the cheap incremental vacuum.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return {"vacuumed": False, "incremental": False, "free_pages": 0}
    conn = _connect(db_path)
    try:
        auto_vacuum = int(conn.execute("PRAGMA auto_vacuum").fetchone()[0])
        page_count = int(conn.execute("PRAGMA page_count").fetchone()[0])
        free_pages = int(conn.execute("PRAGMA freelist_count").fetchone()[0])
        vacuumed = False
        incremental = False
        if auto_vacuum == 0:
            if force or free_pages >= max(int(min_free_pages), 1):
                conn.execute("PRAGMA auto_vacuum = INCREMENTAL")
                conn.commit()
                conn.execute("VACUUM")
                conn.commit()
                vacuumed = True
                auto_vacuum = int(conn.execute("PRAGMA auto_vacuum").fetchone()[0])
                free_pages = int(conn.execute("PRAGMA freelist_count").fetchone()[0])
        else:
            conn.execute("PRAGMA incremental_vacuum")
            conn.commit()
            incremental = True
            free_pages = int(conn.execute("PRAGMA freelist_count").fetchone()[0])
        return {
            "vacuumed": vacuumed,
            "incremental": incremental,
            "auto_vacuum": auto_vacuum,
            "page_count": page_count,
            "free_pages": free_pages,
        }
    finally:
        conn.close()


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

    with _connect(db_path) as conn:
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

    with _connect(db_path) as conn:
        cursor = conn.execute(
            "UPDATE ssh_audit_sessions"
            " SET status = ?, error = ?, ended_at = ?"
            " WHERE id = ?",
            (status, error, ended, session_id),
        )
        conn.commit()
        return cursor.rowcount > 0


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

    with _connect(db_path) as conn:
        cursor = conn.execute(
            "INSERT INTO ssh_audit_sessions"
            " (host_name, username, server_username, remote_addr, started_at,"
            " status)"
            " VALUES (?, ?, ?, ?, ?, 'active')",
            (host_name, username, server_username, remote_addr, started),
        )
        conn.commit()
        return int(cursor.lastrowid)


def save_app_settings(section: str, payload: dict, db_path: Path) -> None:
    """Insert or replace the JSON *payload* stored for *section*."""
    db_path = Path(db_path)
    init_storage(db_path)

    with _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO app_settings (section, payload, updated_at)"
            " VALUES (?, ?, ?)"
            " ON CONFLICT(section) DO UPDATE SET"
            " payload = excluded.payload, updated_at = excluded.updated_at",
            (section, dump_json(payload), _settings_now()),
        )
        conn.commit()


def set_secret(name: str, ciphertext: bytes, db_path: Path) -> None:
    """Insert or replace the encrypted *ciphertext* stored under *name*."""
    db_path = Path(db_path)
    init_storage(db_path)

    with _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO app_secrets (name, ciphertext, updated_at)"
            " VALUES (?, ?, ?)"
            " ON CONFLICT(name) DO UPDATE SET"
            " ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
            (name, sqlite3.Binary(ciphertext), _settings_now()),
        )
        conn.commit()


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

    with _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO task_state (task_name, last_run_at, last_result)"
            " VALUES (?, ?, ?)"
            " ON CONFLICT(task_name) DO UPDATE SET"
            " last_run_at = excluded.last_run_at,"
            " last_result = excluded.last_result",
            (task_name, last_run_at, last_result),
        )
        conn.commit()
