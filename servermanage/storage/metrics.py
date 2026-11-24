"""metric history, daily summaries, trends and sparklines (M4: split out of ``storage.py``)."""

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
    _connect,
    _gpu_memory_percent,
    _local_week_utc_bounds,
    _max_or_none,
    _mean,
    _memory_percent,
    _min_or_none,
    _parse_collected_at,
    _percent_value,
    _summary_avg,
    _summary_extreme,
    _summary_rows_for_week,
    _to_iso_utc,
    _tz_key,
    init_storage,
)


def _deltas_from_samples(samples: dict[str, list[tuple[str, int]]]) -> dict[str, dict]:
    """Aggregate per-username ``[(collected_at, total)]`` into delta dicts."""
    deltas: dict[str, dict] = {}
    for username, points in samples.items():
        if len(points) < 2:
            deltas[username] = {
                "delta": None,
                "base": points[0][1] if points else None,
                "current": points[-1][1] if points else None,
                "since": points[0][0] if points else None,
                "points": len(points),
            }
            continue
        base = points[0][1]
        current = points[-1][1]
        deltas[username] = {
            "delta": current - base,
            "base": base,
            "current": current,
            "since": points[0][0],
            "points": len(points),
        }
    return deltas


def _empty_uptime_strip(hours: int, bucket_minutes: int, since: datetime) -> dict:
    count = max(1, int((hours * 60) / bucket_minutes))
    bucket = timedelta(minutes=bucket_minutes)
    return {
        "hours": hours,
        "bucket_minutes": bucket_minutes,
        "buckets": [
            {"index": index, "start": (since + bucket * index).isoformat(), "total": 0, "ok": 0}
            for index in range(count)
        ],
        "samples": 0,
        "ok": 0,
    }


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


def append_host_check_history(
    host_name: str,
    results: Sequence[HostCheckResult],
    db_path: Path,
    *,
    keep: int = 60,
) -> None:
    """Append one heartbeat row per check and prune each check to *keep* rows.

    The snapshot table only holds the latest state; this keeps a short rolling
    history so the UI can show whether a check has been healthy lately.  Pruning
    inside the same transaction keeps the table bounded forever.
    """
    if not results:
        return
    db_path = Path(db_path)
    init_storage(db_path)

    now = datetime.now(timezone.utc)
    rows = [
        (
            host_name,
            item.name,
            item.status,
            item.latency_ms,
            _to_iso_utc(item.checked_at if item.checked_at is not None else now),
        )
        for item in results
    ]

    keep = max(1, int(keep))
    conn = _connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            """
            INSERT INTO host_check_history
                (host_name, check_name, status, latency_ms, checked_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.execute(
            """
            DELETE FROM host_check_history
            WHERE host_name = ?
              AND id NOT IN (
                  SELECT id FROM host_check_history
                  WHERE host_name = ?
                  ORDER BY id DESC
                  LIMIT ?
              )
            """,
            (host_name, host_name, keep * max(1, len(rows))),
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


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
    with _connect(db_path) as conn:
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


def count_recent_samples(
    db_path: Path,
    host_name: str,
    *,
    hours: int = 24,
    now: datetime | None = None,
) -> int:
    """Count how many collection snapshots a host wrote in the last *hours*.

    Used for the "采集成功率" diagnostic: comparing it with the number of
    expected polls tells the operator how often a host actually answered.
    """

    db_path = Path(db_path)
    if not db_path.exists():
        return 0

    now = now or datetime.now(timezone.utc)
    since = _to_iso_utc(now - timedelta(hours=max(1, int(hours))))
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM host_metrics_history WHERE host_name = ? AND collected_at >= ?",
            (host_name, since),
        ).fetchone()
    return int(row[0] or 0) if row else 0


def count_recent_samples_by_host(
    db_path: Path,
    *,
    hours: int = 24,
    now: datetime | None = None,
) -> dict[str, int]:
    """Count recent snapshots for every host in one query.

    The overview draws a whole fleet at a time, so a per-host query would be
    five round trips instead of one grouped aggregate.
    """

    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    now = now or datetime.now(timezone.utc)
    since = _to_iso_utc(now - timedelta(hours=max(1, int(hours))))
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT host_name, COUNT(*) FROM host_metrics_history "
            "WHERE collected_at >= ? GROUP BY host_name",
            (since,),
        ).fetchall()
    return {str(row[0]): int(row[1]) for row in rows}


def fetch_all_host_uptime_strips(
    db_path: Path,
    *,
    hours: int = 24,
    bucket_minutes: int = 15,
    now: datetime | None = None,
) -> dict[str, dict]:
    """Return :func:`fetch_host_uptime_strip` for every host, in one query."""
    db_path = Path(db_path)
    bucket_minutes = max(1, int(bucket_minutes))
    hours = max(1, int(hours))
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(hours=hours)
    bucket = timedelta(minutes=bucket_minutes)
    count = max(1, int((hours * 60) / bucket_minutes))
    strips: dict[str, dict] = {}
    if not db_path.exists():
        return strips
    since_iso = _to_iso_utc(since)
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT host_name, collected_at, success FROM host_metrics_history"
            " WHERE collected_at >= ? ORDER BY host_name, collected_at",
            (since_iso,),
        ).fetchall()
    for host_name, raw, success in rows:
        strip = strips.get(str(host_name))
        if strip is None:
            strip = _empty_uptime_strip(hours, bucket_minutes, since)
            strips[str(host_name)] = strip
        try:
            moment = _parse_collected_at(raw)
        except (TypeError, ValueError):
            continue
        index = int((moment - since).total_seconds() // bucket.total_seconds())
        if index < 0 or index >= count:
            continue
        strip["buckets"][index]["total"] += 1
        if success:
            strip["buckets"][index]["ok"] += 1
    for strip in strips.values():
        strip["samples"] = sum(item["total"] for item in strip["buckets"])
        strip["ok"] = sum(item["ok"] for item in strip["buckets"])
    return strips


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

    with _connect(db_path) as conn:
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
    chart has detail.  ``7d``/``30d``/``90d`` read the compact daily summary
    instead, which survives raw-point pruning.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []
    if range_key not in ("24h", "7d", "30d", "90d"):
        raise ValueError("range_key must be 24h, 7d, 30d or 90d")
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    if range_key == "24h":
        cutoff = (current - timedelta(hours=24)).astimezone(timezone.utc).isoformat()
        with _connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT collected_at, cpu_usage_percent, memory_used_mb,
                       memory_total_mb, disk_used_percent, gpu_utilization_percent,
                       gpu_memory_used_mb, gpu_memory_total_mb, load_1, temperature_c,
                       net_rx_bytes, net_tx_bytes
                  FROM host_metrics_history
                 WHERE host_name = ? AND success = 1 AND collected_at >= ?
                 ORDER BY collected_at ASC
                """,
                (host_name, cutoff),
            ).fetchall()
        points: list[dict[str, object]] = []
        previous_at: datetime | None = None
        previous_rx: float | None = None
        previous_tx: float | None = None
        for row in rows:
            moment = _parse_collected_at(row["collected_at"]).astimezone(tz)
            rx_raw = row["net_rx_bytes"]
            tx_raw = row["net_tx_bytes"]
            rx_rate = None
            tx_rate = None
            if (
                previous_at is not None
                and previous_rx is not None
                and previous_tx is not None
                and rx_raw is not None
                and tx_raw is not None
            ):
                seconds = (moment - previous_at).total_seconds()
                delta_rx = float(rx_raw) - previous_rx
                delta_tx = float(tx_raw) - previous_tx
                if seconds > 0 and delta_rx >= 0 and delta_tx >= 0:
                    rx_rate = round(delta_rx / seconds, 1)
                    tx_rate = round(delta_tx / seconds, 1)
            points.append(
                {
                    "t": moment.isoformat(),
                    "cpu": row["cpu_usage_percent"],
                    "memory": _memory_percent(row),
                    "disk": row["disk_used_percent"],
                    "gpu_util": row["gpu_utilization_percent"],
                    "gpu_memory": _gpu_memory_percent(row),
                    "temperature": row["temperature_c"],
                    "load_1": row["load_1"],
                    "net_rx": rx_rate,
                    "net_tx": tx_rate,
                }
            )
            previous_at = moment
            previous_rx = float(rx_raw) if rx_raw is not None else None
            previous_tx = float(tx_raw) if tx_raw is not None else None
        return points

    days = {"7d": 7, "30d": 30, "90d": 90}[range_key]
    start_day = (current.astimezone(tz).date() - timedelta(days=days - 1)).isoformat()
    with _connect(db_path) as conn:
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
                # 每日汇总目前不保存温度与网络吞吐，保持与 24h 点位相同的键。
                "temperature": None,
                "net_rx": None,
                "net_tx": None,
            }
        )
    return points


def fetch_host_sparklines(
    db_path: Path,
    *,
    points: int = 24,
    hours: int = 24,
    now: datetime | None = None,
) -> dict[str, dict[str, list[float]]]:
    """Return recent CPU/memory series per host for the overview table.

    One query for every host keeps the 30 s overview poll cheap: the table only
    renders a handful of points and a per-host ``LIMIT`` would issue N queries.
    Values are percentages (0–100) rounded to one decimal.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    points = max(2, int(points))
    now = now or datetime.now(timezone.utc)
    since = _to_iso_utc(now - timedelta(hours=max(1, int(hours))))

    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT host_name, cpu_usage_percent, memory_used_mb, memory_total_mb
            FROM host_metrics_history
            WHERE success = 1 AND collected_at >= ?
            ORDER BY collected_at
            """,
            (since,),
        ).fetchall()

    grouped: dict[str, dict[str, list[float]]] = {}
    for row in rows:
        entry = grouped.setdefault(row["host_name"], {"cpu": [], "memory": []})
        cpu = row["cpu_usage_percent"]
        if cpu is not None:
            entry["cpu"].append(round(float(cpu), 1))
        memory = _percent_value(row["memory_used_mb"], row["memory_total_mb"])
        if memory is not None:
            entry["memory"].append(round(memory, 1))

    return {
        name: {"cpu": series["cpu"][-points:], "memory": series["memory"][-points:]}
        for name, series in grouped.items()
    }


def fetch_host_uptime_strip(
    db_path: Path,
    host_name: str,
    *,
    hours: int = 24,
    bucket_minutes: int = 15,
    now: datetime | None = None,
) -> dict:
    """Return per-bucket collection success for the last *hours* hours.

    Each bucket reports how many samples landed and how many of them
    succeeded, which is what the host page paints as a heartbeat strip:
    a gap means the client was not running, a red bucket means collection
    ran but failed.
    """
    db_path = Path(db_path)
    bucket_minutes = max(1, int(bucket_minutes))
    hours = max(1, int(hours))
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(hours=hours)
    bucket = timedelta(minutes=bucket_minutes)
    count = max(1, int((hours * 60) / bucket_minutes))
    buckets = [
        {
            "index": index,
            "start": (since + bucket * index).isoformat(),
            "total": 0,
            "ok": 0,
        }
        for index in range(count)
    ]
    if db_path.exists():
        since_iso = _to_iso_utc(since)
        with _connect(db_path) as conn:
            rows = conn.execute(
                "SELECT collected_at, success FROM host_metrics_history"
                " WHERE host_name = ? AND collected_at >= ?"
                " ORDER BY collected_at",
                (host_name, since_iso),
            ).fetchall()
        for raw, success in rows:
            try:
                moment = _parse_collected_at(raw)
            except (TypeError, ValueError):
                continue
            index = int((moment - since).total_seconds() // bucket.total_seconds())
            if index < 0 or index >= count:
                continue
            buckets[index]["total"] += 1
            if success:
                buckets[index]["ok"] += 1

    total = sum(item["total"] for item in buckets)
    ok = sum(item["ok"] for item in buckets)
    return {
        "hours": hours,
        "bucket_minutes": bucket_minutes,
        "buckets": buckets,
        "samples": total,
        "ok": ok,
    }


def fetch_overview_history(
    db_path: Path,
    *,
    range_key: str = "24h",
    tz: tzinfo = timezone.utc,
    now: datetime | None = None,
    offset_days: int = 0,
    host: str | None = None,
) -> list[dict[str, object]]:
    """Return fleet-wide (or single-host) average chart points for the overview page.

    ``offset_days`` shifts the window backwards, which is how the overview
    chart draws the previous period for comparison.
    """
    db_path = Path(db_path)
    if offset_days < 0:
        raise ValueError("offset_days must be zero or positive")
    if not db_path.exists():
        return []
    if range_key not in ("24h", "7d", "30d", "90d"):
        raise ValueError("range_key must be 24h, 7d, 30d or 90d")
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    if offset_days:
        current = current - timedelta(days=offset_days)

    host_clause = "AND host_name = ?" if host else ""

    if range_key == "24h":
        cutoff = (current - timedelta(hours=24)).astimezone(timezone.utc).isoformat()
        ceiling = current.astimezone(timezone.utc).isoformat()
        with _connect(db_path) as conn:
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
                 WHERE success = 1 AND collected_at >= ? AND collected_at <= ?
                   {host_clause}
                 GROUP BY collected_at
                 ORDER BY collected_at ASC
                """.format(host_clause=host_clause),
                (
                    (cutoff, ceiling, host)
                    if host
                    else (cutoff, ceiling)
                ),
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

    days = {"7d": 7, "30d": 30, "90d": 90}[range_key]
    start_day = (current.astimezone(tz).date() - timedelta(days=days - 1)).isoformat()
    end_day = current.astimezone(tz).date().isoformat()
    with _connect(db_path) as conn:
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
             WHERE tz = ? AND day >= ? AND day <= ?
                   {host_clause}
             GROUP BY day
             ORDER BY day ASC
            """.format(host_clause=host_clause),
            (
                (_tz_key(tz), start_day, end_day, host)
                if host
                else (_tz_key(tz), start_day, end_day)
            ),
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

    with _connect(db_path) as conn:
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


def get_all_host_check_history(
    db_path: Path, *, limit: int = 40
) -> dict[str, dict[str, list[str]]]:
    """Return :func:`get_host_check_history` for every host, in one query."""
    db_path = Path(db_path)
    if not db_path.exists():
        return {}
    limit = max(1, int(limit))
    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT host_name, check_name, status FROM (
                SELECT host_name, check_name, status,
                       ROW_NUMBER() OVER (
                           PARTITION BY host_name ORDER BY id DESC
                       ) AS rn
                FROM host_check_history
            ) WHERE rn <= ?
            ORDER BY host_name, rn DESC
            """,
            (limit * 32,),
        ).fetchall()

    grouped: dict[str, dict[str, list[str]]] = {}
    for row in rows:
        host_group = grouped.setdefault(str(row["host_name"]), {})
        bucket = host_group.setdefault(row["check_name"], [])
        bucket.append(row["status"])
    return {
        host: {name: statuses[-limit:] for name, statuses in host_group.items()}
        for host, host_group in grouped.items()
    }


def get_host_check_history(
    host_name: str, db_path: Path, *, limit: int = 40
) -> dict[str, list[str]]:
    """Return ``{check_name: [oldest…newest statuses]}`` for *host_name*."""
    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    limit = max(1, int(limit))
    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT check_name, status, id
            FROM host_check_history
            WHERE host_name = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (host_name, limit * 32),
        ).fetchall()

    grouped: dict[str, list[str]] = {}
    for row in reversed(rows):
        bucket = grouped.setdefault(row["check_name"], [])
        bucket.append(row["status"])
    return {name: statuses[-limit:] for name, statuses in grouped.items()}


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
    with _connect(db_path) as conn:
        cursor = conn.execute(
            "DELETE FROM host_daily_summary WHERE day < ?", (cutoff_day,)
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
    return deleted


def prune_host_metrics(db_path: Path, max_points_per_host: int = 100) -> int:
    """Keep only the newest *max_points_per_host* rows for every host."""
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    limit = max(1, int(max_points_per_host))
    with _connect(db_path) as conn:
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
