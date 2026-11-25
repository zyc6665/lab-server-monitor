"""host snapshots and availability-check rows (M4: split out of ``storage.py``)."""

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

from servermanage.storage.base import (
    LOGGER,
    _SNAPSHOT_INSERT_SQL,
    _account_groups,
    _connect,
    _extract_disk_used_percent,
    _extract_gpu_utilization_percent,
    _flag,
    _network_rate_pair,
    _optional_iso,
    _parse_collected_at,
    _percent_value,
    _to_iso_utc,
    _tz_key,
    init_storage,
)

from servermanage.storage.metrics import (
    _merge_daily_summary,
)


def _replace_snapshot_rows(
    conn: sqlite3.Connection, host_name: str, rows: list[tuple]
) -> None:
    conn.execute(
        "DELETE FROM host_user_snapshot WHERE host_name = ?", (host_name,)
    )
    if rows:
        conn.executemany(_SNAPSHOT_INSERT_SQL, rows)


def _snapshot_row(
    host_name: str, account: Mapping[str, object], collected_at: str
) -> tuple:
    # ``uid`` / ``gid`` are deliberately not coerced here: a bad value must fail
    # inside the transaction (and roll back) rather than while building rows.
    return (
        host_name,
        str(account["username"]),
        account.get("uid"),
        account.get("gid"),
        account.get("primary_group"),
        account.get("gecos"),
        account.get("home"),
        account.get("shell"),
        json.dumps(_account_groups(account), ensure_ascii=False),
        _flag(account.get("in_docker")),
        _flag(account.get("in_sudo")),
        _flag(account.get("home_exists")),
        account.get("home_owner"),
        account.get("home_group"),
        account.get("home_mode"),
        account.get("home_size_bytes"),
        _flag(account.get("data_exists")),
        account.get("data_owner"),
        account.get("data_group"),
        account.get("data_mode"),
        account.get("data_size_bytes"),
        _flag(account.get("data_supported"), default=True),
        _flag(account.get("usage_stale")),
        _flag(
            account.get("usage_readable"),
            default=(
                account.get("home_size_bytes") is not None
                or account.get("data_size_bytes") is not None
            ),
        ),
        _optional_iso(account.get("usage_collected_at")),
        _optional_iso(account.get("collected_at")) or collected_at,
    )


def delete_host_check_results(host_name: str, db_path: Path) -> None:
    """Delete every stored check result for *host_name*."""
    db_path = Path(db_path)
    if not db_path.exists():
        return

    with _connect(db_path) as conn:
        conn.execute(
            "DELETE FROM host_check_snapshot WHERE host_name = ?", (host_name,)
        )
        conn.execute(
            "DELETE FROM host_check_history WHERE host_name = ?", (host_name,)
        )
        conn.commit()


def fetch_all_host_network_rates(db_path: Path) -> dict[str, dict[str, float | None]]:
    """Return :func:`fetch_host_network_rates` for every host, in one query."""
    db_path = Path(db_path)
    empty = {"rx_bytes_per_second": None, "tx_bytes_per_second": None}
    if not db_path.exists():
        return {}
    with _connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT host_name, collected_at, net_rx_bytes, net_tx_bytes FROM (
                SELECT host_name, collected_at, net_rx_bytes, net_tx_bytes,
                       ROW_NUMBER() OVER (
                           PARTITION BY host_name ORDER BY collected_at DESC
                       ) AS rn
                FROM host_metrics_history
                WHERE success = 1 AND net_rx_bytes IS NOT NULL
                  AND net_tx_bytes IS NOT NULL
            ) WHERE rn <= 2
            ORDER BY host_name, collected_at DESC
            """
        ).fetchall()
    grouped: dict[str, list] = {}
    for host_name, collected_at, rx, tx in rows:
        grouped.setdefault(str(host_name), []).append((collected_at, rx, tx))
    return {
        host: _network_rate_pair(samples) if len(samples) >= 2 else dict(empty)
        for host, samples in grouped.items()
    }


def fetch_host_network_rates(
    db_path: Path,
    host_name: str,
) -> dict[str, float | None]:
    """Return instantaneous rx/tx bytes per second for one host.

    ``/proc/net/dev`` only exposes cumulative counters, so the rate comes from
    the last two samples.  A negative delta means the counter was reset (reboot
    or interface re-created) and is reported as unknown instead of a bogus
    negative number.
    """
    empty: dict[str, float | None] = {
        "rx_bytes_per_second": None,
        "tx_bytes_per_second": None,
    }
    db_path = Path(db_path)
    if not db_path.exists():
        return empty

    with _connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT collected_at, net_rx_bytes, net_tx_bytes
              FROM host_metrics_history
             WHERE host_name = ? AND success = 1
               AND net_rx_bytes IS NOT NULL AND net_tx_bytes IS NOT NULL
             ORDER BY collected_at DESC
             LIMIT 2
            """,
            (host_name,),
        ).fetchall()
    return _network_rate_pair(rows) if len(rows) >= 2 else empty


def get_all_host_check_results(db_path: Path) -> dict[str, list[dict]]:
    """Return the latest check snapshot for every host in one query.

    Maps ``host_name`` to the same ordered rows that
    :func:`get_host_check_results` returns for a single host.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT host_name, check_name, check_type, target, status,
                   message, latency_ms, checked_at
            FROM host_check_snapshot
            ORDER BY host_name, check_name
            """
        ).fetchall()

    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(str(row["host_name"]), []).append(dict(row))
    return grouped


def get_all_host_snapshots(db_path: Path) -> list[dict]:
    """Return one snapshot dict per host, ordered by host name.

    One query for the whole fleet: the 30 s dashboard poll used to open a
    fresh connection per host, which needless doubled the lock contention
    with the collector.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT host_name, collected_at, success, raw_json"
            " FROM host_latest_snapshot ORDER BY host_name"
        ).fetchall()

    snapshots: list[dict] = []
    for row in rows:
        raw = json.loads(row["raw_json"]) if row["raw_json"] else {}
        snapshots.append(
            {
                "host_name": row["host_name"],
                "collected_at": row["collected_at"],
                "success": bool(row["success"]),
                "metrics": raw.get("metrics", {}),
                "errors": raw.get("errors", []),
            }
        )
    return snapshots


def get_host_check_results(host_name: str, db_path: Path) -> list[dict]:
    """Return the latest check snapshot for *host_name*, ordered by check name."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT host_name, check_name, check_type, target, status,
                   message, latency_ms, checked_at
            FROM host_check_snapshot
            WHERE host_name = ?
            ORDER BY check_name
            """,
            (host_name,),
        ).fetchall()

    return [dict(row) for row in rows]


def get_host_snapshot(host_name: str, db_path: Path) -> dict | None:
    """Return the latest snapshot dict for *host_name*, or ``None``."""
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    with _connect(db_path) as conn:
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
                metrics.net_rx_bytes,
                metrics.net_tx_bytes,
                metrics.hottest_temperature_c,
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

    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        # Take the write lock up front so the metrics insert and the daily
        # summary read-modify-write below happen atomically and cannot race a
        # concurrent writer into a lost update.
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            """
            INSERT INTO host_metrics_history (
                collected_at, host_name, host, success, cpu_usage_percent,
                memory_used_mb, memory_total_mb, disk_used_percent,
                gpu_utilization_percent, gpu_memory_used_mb, gpu_memory_total_mb,
                total_processes, logged_in_user_count, load_1, load_5, load_15,
                net_rx_bytes, net_tx_bytes, temperature_c
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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


def save_host_check_results(
    host_name: str, results: Sequence[HostCheckResult], db_path: Path
) -> None:
    """Replace the latest check snapshot for *host_name* in one transaction.

    Existing rows for the host are deleted first so removing a configured check
    also removes its stale result.  ``BEGIN IMMEDIATE`` keeps readers from seeing
    a half-updated snapshot and the transaction is rolled back on any error.
    """
    db_path = Path(db_path)
    init_storage(db_path)

    now = datetime.now(timezone.utc)
    rows = [
        (
            host_name,
            item.name,
            item.type,
            item.target,
            item.status,
            item.message or "",
            item.latency_ms,
            _to_iso_utc(item.checked_at if item.checked_at is not None else now),
        )
        for item in results
    ]

    conn = _connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "DELETE FROM host_check_snapshot WHERE host_name = ?", (host_name,)
        )
        if rows:
            conn.executemany(
                """
                INSERT INTO host_check_snapshot
                    (host_name, check_name, check_type, target, status,
                     message, latency_ms, checked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


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

    with _connect(db_path) as conn:
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
