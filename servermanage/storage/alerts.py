"""alert rows and silence windows (M4: split out of ``storage.py``)."""

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
    _parse_collected_at,
    _parse_iso_datetime,
    _to_iso_utc,
    init_storage,
)


def close_alerts_for_host(
    host_name: str,
    db_path: Path,
    *,
    category: str,
    status: str = "resolved",
    now: datetime | str | None = None,
) -> int:
    """Mark every non-terminal alert of one host/category as *status*.

    Used when a host is removed: its rows are gone, so leaving ``active`` alerts
    behind would keep alerting about a machine that is no longer monitored.
    Returns the number of rows updated.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    conn = _connect(db_path)
    try:
        cursor = conn.execute(
            "UPDATE alerts SET status = ?"
            " WHERE host_name = ? AND category = ?"
            " AND status IN ('active', 'acknowledged')",
            (status, host_name, category),
        )
        updated = cursor.rowcount or 0
        conn.commit()
    finally:
        conn.close()
    return updated


def count_active_alerts_by_host(db_path: Path) -> dict[str, int]:
    """Count active alerts per host with one grouped aggregate.

    The overview used to materialise every active alert row (limit 100 000)
    just to count them per host; this keeps the 30 s poll to a single index
    scan and never builds alert dicts at all.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT host_name, COUNT(*) FROM alerts"
            " WHERE status = 'active' AND host_name IS NOT NULL"
            " GROUP BY host_name"
        ).fetchall()
    return {str(row[0]): int(row[1]) for row in rows}


def count_active_critical_alerts(db_path: Path) -> int:
    """Count active critical alerts without materialising the whole alert list."""
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    with _connect(db_path) as conn:
        try:
            row = conn.execute(
                "SELECT COUNT(*) FROM alerts"
                " WHERE status = 'active' AND lower(severity) = 'critical'"
            ).fetchone()
        except sqlite3.OperationalError:
            return 0
    return int(row[0]) if row else 0


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

    with _connect(db_path) as conn:
        rows = conn.execute(
            f"SELECT status, COUNT(*) AS count FROM alerts{clause} GROUP BY status",
            params,
        ).fetchall()
    for status, count in rows:
        if status in counts:
            counts[status] = int(count)
        counts["total"] += int(count)
    return counts


def delete_silence(silence_id: int, db_path: Path) -> bool:
    """Delete the silence row; return ``True`` when a row was removed."""
    db_path = Path(db_path)
    if not db_path.exists():
        return False

    try:
        with _connect(db_path) as conn:
            cursor = conn.execute(
                "DELETE FROM alert_silences WHERE id = ?", (int(silence_id),)
            )
            conn.commit()
            return cursor.rowcount > 0
    except sqlite3.OperationalError:
        return False


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

    with _connect(db_path) as conn:
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


def find_latest_alert(fingerprint: str, db_path: Path) -> dict | None:
    """Return the most recent alert with *fingerprint*, or ``None``."""
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM alerts WHERE fingerprint = ?"
            " ORDER BY created_at DESC, id DESC LIMIT 1",
            (fingerprint,),
        ).fetchone()

    return dict(row) if row is not None else None


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
    with _connect(db_path) as conn:
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
    with _connect(db_path) as conn:
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

    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, params).fetchall()

    return [dict(row) for row in rows]


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

    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM alerts WHERE host_name = ?"
            " ORDER BY created_at DESC, id DESC LIMIT ?",
            (host_name, int(limit)),
        ).fetchall()

    return [dict(row) for row in rows]


def list_recent_alerts_grouped(
    db_path: Path,
    *,
    per_host: int = 20,
) -> dict[str, list[dict]]:
    """Return the most recent *per_host* alerts for every host, in one query.

    Maps ``host_name`` to the same newest-first rows that
    :func:`list_alerts_for_host` returns, so the fleet report reads all hosts
    with one round trip instead of one per host.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return {}
    cap = max(1, int(per_host))
    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT * FROM (
                SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY host_name ORDER BY created_at DESC, id DESC
                ) AS rn
                FROM alerts
                WHERE host_name IS NOT NULL
            ) WHERE rn <= ?
            ORDER BY host_name, created_at DESC, id DESC
            """,
            (cap,),
        ).fetchall()
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        entry = dict(row)
        entry.pop("rn", None)  # 窗口函数辅助列，逐主机读取没有这一列
        grouped.setdefault(str(entry["host_name"]), []).append(entry)
    return grouped


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
        with _connect(db_path) as conn:
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


def prune_alert_history(
    db_path: Path, retention_days: int = 30, *, now: datetime | None = None
) -> int:
    """Delete only resolved alerts older than *retention_days*."""
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    reference = now if now is not None else datetime.now(timezone.utc)
    cutoff = (reference - timedelta(days=max(1, int(retention_days)))).isoformat()
    with _connect(db_path) as conn:
        cursor = conn.execute(
            "DELETE FROM alerts WHERE status = 'resolved' AND created_at < ?",
            (cutoff,),
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
    with _connect(db_path) as conn:
        cursor = conn.execute(
            "DELETE FROM alert_silences WHERE ends_at < ?", (reference.isoformat(),)
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
    return deleted


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
    with _connect(db_path) as conn:
        conn.execute(
            f"UPDATE alerts SET {', '.join(assignments)} WHERE id = ?", values
        )
        conn.commit()
