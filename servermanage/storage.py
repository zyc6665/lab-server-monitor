from __future__ import annotations

import logging
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path

from servermanage.models import DailyReport, HostReport

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
