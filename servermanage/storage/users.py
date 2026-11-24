"""server-user snapshots, baselines and usage history (M4: split out of ``storage.py``)."""

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
    _account_groups,
    _connect,
    _flag,
    _load_groups,
    _to_iso_utc,
    init_storage,
)

from servermanage.storage.hosts import (
    _replace_snapshot_rows,
    _snapshot_row,
)

from servermanage.storage.metrics import (
    _deltas_from_samples,
)


def _decode_user_operation(row: Sequence[Any]) -> dict[str, Any]:
    try:
        steps = json.loads(row[9] or "[]")
    except ValueError:
        steps = []
    return {
        "id": row[0],
        "created_at": row[1],
        "finished_at": row[2],
        "host_name": row[3],
        "account": row[4],
        "operation": row[5],
        "status": row[6],
        "actor": row[7] or "",
        "plan_hash": row[8] or "",
        "steps": steps,
        "error": row[10] or "",
    }


def _decode_user_row(row: sqlite3.Row) -> dict:
    """Turn a stored user row into a dict with ``groups`` and real booleans."""
    data = dict(row)
    data["groups"] = _load_groups(data.pop("groups_json", None))
    for key in (
        "in_docker",
        "in_sudo",
        "home_exists",
        "data_exists",
        "data_supported",
        "usage_stale",
        "usage_readable",
    ):
        if key in data and data[key] is not None:
            data[key] = bool(data[key])
    return data


def _write_baseline(
    conn: sqlite3.Connection, host_name: str, account: dict, seen_at: str
) -> bool:
    """Insert or refresh one baseline row; return True when it was inserted."""
    username = str(account["username"])
    values = (
        account.get("uid"),
        account.get("gid"),
        account.get("primary_group"),
        account.get("shell"),
        account.get("home"),
        json.dumps(_account_groups(account), ensure_ascii=False),
        _flag(account.get("in_docker")),
        _flag(account.get("in_sudo")),
    )
    existing = conn.execute(
        "SELECT 1 FROM host_user_baseline"
        " WHERE host_name = ? AND username = ?",
        (host_name, username),
    ).fetchone()
    if existing is None:
        conn.execute(
            """
            INSERT INTO host_user_baseline (
                host_name, username, uid, gid, primary_group, shell, home,
                groups_json, in_docker, in_sudo, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (host_name, username, *values, seen_at, seen_at),
        )
        return True
    conn.execute(
        """
        UPDATE host_user_baseline SET
            uid = ?, gid = ?, primary_group = ?, shell = ?, home = ?,
            groups_json = ?, in_docker = ?, in_sudo = ?,
            last_seen_at = ?
        WHERE host_name = ? AND username = ?
        """,
        (*values, seen_at, host_name, username),
    )
    return False


def _write_scan_state(
    conn: sqlite3.Connection,
    host_name: str,
    *,
    last_scan_at: datetime | str | None = None,
    last_usage_at: datetime | str | None = None,
    last_error: str | None = None,
) -> None:
    updates: dict[str, object] = {}
    if last_scan_at is not None:
        updates["last_scan_at"] = _to_iso_utc(last_scan_at)
    if last_usage_at is not None:
        updates["last_usage_at"] = _to_iso_utc(last_usage_at)
    if last_error is not None:
        updates["last_error"] = str(last_error)
    conn.execute(
        "INSERT INTO host_user_scan_state (host_name) VALUES (?)"
        " ON CONFLICT(host_name) DO NOTHING",
        (host_name,),
    )
    if updates:
        assignments = ", ".join(f"{column} = ?" for column in updates)
        conn.execute(
            f"UPDATE host_user_scan_state SET {assignments}"
            " WHERE host_name = ?",
            (*updates.values(), host_name),
        )


def append_user_usage_history(
    host_name: str,
    accounts: list[dict],
    db_path: Path,
    *,
    now: datetime | str | None = None,
    retain_days: int = 180,
    min_interval_hours: float = 12,
) -> int:
    """Record one measurement per account, so growth can be charted later.

    Only accounts that actually have a size are written: an unmeasured account
    would otherwise show up as a 0 B sample and produce a fake "-x GB" swing on
    the next round.
    """
    db_path = Path(db_path)
    init_storage(db_path)
    moment = (
        _to_iso_utc(now)
        if now is not None
        else datetime.now(timezone.utc).isoformat()
    )
    candidates = [
        account
        for account in accounts
        if account.get("username")
        and (
            account.get("home_size_bytes") is not None
            or account.get("data_size_bytes") is not None
        )
    ]
    if not candidates:
        return 0

    # Everything below is anchored on the measurement instant, not the wall
    # clock: a caller replaying history (or a test pinning ``now``) must get the
    # same de-duplication result months later.
    anchor = datetime.fromisoformat(moment)
    cutoff = None
    if retain_days > 0:
        cutoff = (anchor - timedelta(days=retain_days)).isoformat()

    # Re-measuring an unchanged directory every few minutes would bury the real
    # changes in noise, so an identical size is only recorded once per
    # ``min_interval_hours``; a changed size is always recorded.
    floor = (
        anchor - timedelta(hours=max(0, min_interval_hours))
    ).isoformat()
    rows: list[tuple] = []
    conn = _connect(db_path)
    try:
        for account in candidates:
            username = str(account["username"])
            home = account.get("home_size_bytes")
            data = account.get("data_size_bytes")
            if min_interval_hours > 0:
                last = conn.execute(
                    "SELECT collected_at, home_size_bytes, data_size_bytes"
                    " FROM host_user_usage_history"
                    " WHERE host_name = ? AND username = ?"
                    " ORDER BY collected_at DESC LIMIT 1",
                    (host_name, username),
                ).fetchone()
                if (
                    last is not None
                    and last[0] >= floor
                    and last[1] == home
                    and last[2] == data
                ):
                    continue
            rows.append((host_name, username, moment, home, data))
        if not rows:
            conn.commit()
            return 0
        conn.executemany(
            "INSERT OR REPLACE INTO host_user_usage_history"
            " (host_name, username, collected_at, home_size_bytes, data_size_bytes)"
            " VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        if cutoff is not None:
            conn.execute(
                "DELETE FROM host_user_usage_history"
                " WHERE host_name = ? AND collected_at < ?",
                (host_name, cutoff),
            )
        conn.commit()
    finally:
        conn.close()
    return len(rows)


def delete_host_user_data(host_name: str, db_path: Path) -> None:
    """Delete the snapshot, baseline and scan state of *host_name*."""
    db_path = Path(db_path)
    if not db_path.exists():
        return

    conn = _connect(db_path)
    try:
        conn.execute(
            "DELETE FROM host_user_snapshot WHERE host_name = ?", (host_name,)
        )
        conn.execute(
            "DELETE FROM host_user_baseline WHERE host_name = ?", (host_name,)
        )
        conn.execute(
            "DELETE FROM host_user_scan_state WHERE host_name = ?", (host_name,)
        )
        conn.commit()
    finally:
        conn.close()


def delete_user_baseline(host_name: str, username: str, db_path: Path) -> bool:
    """Remove one baseline row; return whether a row was actually deleted."""
    db_path = Path(db_path)
    if not db_path.exists():
        return False

    conn = _connect(db_path)
    try:
        cursor = conn.execute(
            "DELETE FROM host_user_baseline"
            " WHERE host_name = ? AND username = ?",
            (host_name, username),
        )
        removed = cursor.rowcount > 0
        conn.commit()
    finally:
        conn.close()

    return removed


def get_all_host_user_snapshots(db_path: Path) -> dict[str, list[dict]]:
    """Return every stored account snapshot grouped by host name."""
    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    conn = _connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM host_user_snapshot ORDER BY host_name, username"
        ).fetchall()
    finally:
        conn.close()

    snapshots: dict[str, list[dict]] = {}
    for row in rows:
        snapshots.setdefault(row["host_name"], []).append(_decode_user_row(row))
    return snapshots


def get_all_user_baselines(db_path: Path) -> dict[str, list[dict]]:
    """Return every baseline grouped by host name in one query.

    The users page polls all hosts every 30 s; a per-host query meant one
    connection per host on top of the snapshot and delta reads.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    conn = _connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM host_user_baseline ORDER BY host_name, username"
        ).fetchall()
    finally:
        conn.close()

    baselines: dict[str, list[dict]] = {}
    for row in rows:
        baselines.setdefault(row["host_name"], []).append(_decode_user_row(row))
    return baselines


def get_all_user_scan_states(db_path: Path) -> dict[str, dict]:
    """Return the scan-state row for every host in one query."""
    db_path = Path(db_path)
    if not db_path.exists():
        return {}

    conn = _connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM host_user_scan_state"
        ).fetchall()
    finally:
        conn.close()

    return {str(row["host_name"]): dict(row) for row in rows}


def get_all_user_usage_deltas(
    db_path: Path,
    *,
    days: int = 7,
    now: datetime | None = None,
) -> dict[str, dict[str, dict]]:
    """Return per-host usage deltas for the whole fleet in one query.

    Maps ``host_name`` to the same ``username -> delta`` mapping that
    :func:`get_user_usage_deltas` returns for a single host, so the 30 s users
    poll needs one round trip instead of one per host.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return {}
    moment = now or datetime.now(timezone.utc)
    since = (moment - timedelta(days=max(1, int(days)))).isoformat()

    conn = _connect(db_path)
    try:
        cursor = conn.execute(
            "SELECT host_name, username, collected_at, home_size_bytes, data_size_bytes"
            " FROM host_user_usage_history"
            " WHERE collected_at >= ?"
            " ORDER BY host_name, username, collected_at",
            (since,),
        )
        grouped: dict[str, dict[str, list[tuple[str, int]]]] = {}
        for host_name, username, collected_at, home, data in cursor.fetchall():
            total = int(home or 0) + int(data or 0)
            grouped.setdefault(str(host_name), {}).setdefault(str(username), []).append(
                (collected_at, total)
            )
    finally:
        conn.close()

    return {host: _deltas_from_samples(samples) for host, samples in grouped.items()}


def get_host_user_snapshot(host_name: str, db_path: Path) -> list[dict]:
    """Return the stored account snapshot for *host_name*, ordered by username."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    conn = _connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM host_user_snapshot"
            " WHERE host_name = ? ORDER BY username",
            (host_name,),
        ).fetchall()
    finally:
        conn.close()

    return [_decode_user_row(row) for row in rows]


def get_user_baseline(host_name: str, db_path: Path) -> list[dict]:
    """Return the baseline rows for *host_name*, ordered by username.

    Rows stay after the account disappears from the snapshot; their attributes
    are the last known values.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    conn = _connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM host_user_baseline"
            " WHERE host_name = ? ORDER BY username",
            (host_name,),
        ).fetchall()
    finally:
        conn.close()

    return [_decode_user_row(row) for row in rows]


def get_user_scan_state(host_name: str, db_path: Path) -> dict | None:
    """Return the scan-state row for *host_name*, or ``None`` when absent."""
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    conn = _connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT host_name, last_scan_at, last_usage_at, last_error"
            " FROM host_user_scan_state WHERE host_name = ?",
            (host_name,),
        ).fetchone()
    finally:
        conn.close()

    return dict(row) if row is not None else None


def get_user_usage_deltas(
    host_name: str,
    db_path: Path,
    *,
    days: int = 7,
    now: datetime | None = None,
) -> dict[str, dict]:
    """Return ``username -> delta`` between the oldest and newest sample.

    A single sample has no meaningful change yet, so it yields a delta of
    ``None``; the caller renders that as "—" instead of a misleading 0 B.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return {}
    moment = now or datetime.now(timezone.utc)
    since = (moment - timedelta(days=max(1, int(days)))).isoformat()

    conn = _connect(db_path)
    try:
        cursor = conn.execute(
            "SELECT username, collected_at, home_size_bytes, data_size_bytes"
            " FROM host_user_usage_history"
            " WHERE host_name = ? AND collected_at >= ?"
            " ORDER BY username, collected_at",
            (host_name, since),
        )
        samples: dict[str, list[tuple[str, int]]] = {}
        for username, collected_at, home, data in cursor.fetchall():
            total = int(home or 0) + int(data or 0)
            samples.setdefault(str(username), []).append((collected_at, total))
    finally:
        conn.close()

    return _deltas_from_samples(samples)


def get_user_usage_series(
    host_name: str,
    db_path: Path | str,
    *,
    days: int = 30,
    now: datetime | None = None,
    max_points: int = 36,
) -> dict[str, list[dict[str, Any]]]:
    """Return down-sampled usage history per account for the last ``days`` days."""
    path = Path(db_path)
    if not path.exists():
        return {}
    reference = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = (reference - timedelta(days=days)).isoformat()
    series: dict[str, list[dict[str, Any]]] = {}
    with closing(_connect(path, timeout=30)) as conn:
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT username, collected_at, home_size_bytes, data_size_bytes
                FROM host_user_usage_history
                WHERE host_name = ? AND collected_at >= ?
                ORDER BY username, collected_at
                """,
                (host_name, cutoff),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
    for row in rows:
        home = row["home_size_bytes"]
        data = row["data_size_bytes"]
        if home is None and data is None:
            continue
        series.setdefault(row["username"], []).append(
            {
                "at": row["collected_at"],
                "home": home,
                "data": data,
                "total": (home or 0) + (data or 0),
            }
        )
    if max_points <= 0:
        return series
    for name, points in series.items():
        if len(points) <= max_points:
            continue
        step = (len(points) - 1) / (max_points - 1)
        picked = [points[round(index * step)] for index in range(max_points)]
        picked[0] = points[0]
        picked[-1] = points[-1]
        series[name] = picked
    return series


def list_user_operations(
    db_path: Path, *, host_name: str | None = None, limit: int = 50
) -> list[dict[str, Any]]:
    """Return recent audit rows, newest first."""
    db_path = Path(db_path)
    if not db_path.exists():
        return []
    init_storage(db_path)

    sql = "SELECT * FROM user_operations"
    params: list[Any] = []
    if host_name:
        sql += " WHERE host_name = ?"
        params.append(host_name)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(max(1, min(int(limit), 200)))

    conn = _connect(db_path)
    try:
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return [_decode_user_operation(row) for row in rows]


def save_host_user_scan_result(
    host_name: str,
    accounts: list[dict],
    db_path: Path,
    *,
    now: datetime | str | None = None,
    usage_refreshed: bool = False,
    seed_only: bool = False,
) -> list[str]:
    """Persist one successful scan atomically.

    The snapshot, the baseline rows and the scan state are written in a single
    ``BEGIN IMMEDIATE`` transaction, so a failure can never leave the baseline
    ahead of the snapshot (which would silently swallow a later ``user-added``
    alert).  Returns the usernames that were inserted into the baseline
    (``seed_only`` returns an empty list: the first scan is silent).
    """
    db_path = Path(db_path)
    init_storage(db_path)

    moment = (
        _to_iso_utc(now)
        if now is not None
        else datetime.now(timezone.utc).isoformat()
    )
    rows = [_snapshot_row(host_name, account, moment) for account in accounts]

    conn = _connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _replace_snapshot_rows(conn, host_name, rows)
        inserted: list[str] = []
        if not seed_only:
            for account in accounts:
                if _write_baseline(conn, host_name, account, moment):
                    inserted.append(str(account["username"]))
        else:
            for account in accounts:
                _write_baseline(conn, host_name, account, moment)
        _write_scan_state(
            conn,
            host_name,
            last_scan_at=moment,
            last_usage_at=moment if usage_refreshed else None,
            last_error="",
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()

    return inserted


def save_host_user_snapshot(
    host_name: str, accounts: list[dict], db_path: Path
) -> None:
    """Replace the account snapshot for *host_name* in one transaction.

    ``BEGIN IMMEDIATE`` followed by delete/insert/commit means readers never see
    a half-written snapshot, and any failure rolls the host back to its previous
    snapshot.  Passing an empty list clears the host (for example after an empty
    but successful scan).
    """
    db_path = Path(db_path)
    init_storage(db_path)

    fallback_collected_at = datetime.now(timezone.utc).isoformat()
    rows = [
        _snapshot_row(host_name, account, fallback_collected_at)
        for account in accounts
    ]

    conn = _connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _replace_snapshot_rows(conn, host_name, rows)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def save_user_operation(
    host_name: str,
    account: str,
    operation: str,
    status: str,
    *,
    actor: str = "",
    plan_hash: str = "",
    steps: Sequence[dict[str, Any]] | None = None,
    error: str = "",
    created_at: datetime | None = None,
    finished_at: datetime | None = None,
    db_path: Path,
) -> int:
    """Append one audit row for an account-provisioning attempt.

    Secrets never reach this function: ``steps`` must already be the masked
    description of what ran (no ``stdin`` field).
    """
    db_path = Path(db_path)
    init_storage(db_path)
    moment = created_at or datetime.now(timezone.utc)
    finished = finished_at or datetime.now(timezone.utc)
    payload = json.dumps(list(steps or []), ensure_ascii=False)

    conn = _connect(db_path)
    try:
        cursor = conn.execute(
            "INSERT INTO user_operations"
            " (created_at, finished_at, host_name, account, operation, status,"
            "  actor, plan_hash, steps_json, error)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                moment.isoformat(),
                finished.isoformat(),
                host_name,
                account,
                operation,
                status,
                actor,
                plan_hash,
                payload,
                error,
            ),
        )
        conn.commit()
        return int(cursor.lastrowid or 0)
    finally:
        conn.close()


def save_user_scan_state(
    host_name: str,
    *,
    db_path: Path,
    last_scan_at: datetime | str | None = None,
    last_usage_at: datetime | str | None = None,
    last_error: str | None = None,
) -> None:
    """Partially upsert the scan state for *host_name*.

    Only keyword arguments that are not ``None`` overwrite their column; passing
    ``last_error=""`` clears a previously recorded error while
    ``last_error=None`` leaves it untouched.
    """
    db_path = Path(db_path)
    init_storage(db_path)

    conn = _connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _write_scan_state(
            conn,
            host_name,
            last_scan_at=last_scan_at,
            last_usage_at=last_usage_at,
            last_error=last_error,
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def top_user_growth(
    db_path: Path | str,
    *,
    days: int = 7,
    limit: int = 8,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Rank accounts by total usage growth inside the window."""
    path = Path(db_path)
    if not path.exists() or limit <= 0:
        return []
    reference = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = (reference - timedelta(days=days)).isoformat()
    with closing(_connect(path, timeout=30)) as conn:
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT host_name, username, collected_at,
                       home_size_bytes, data_size_bytes
                FROM host_user_usage_history
                WHERE collected_at >= ?
                ORDER BY host_name, username, collected_at
                """,
                (cutoff,),
            ).fetchall()
        except sqlite3.OperationalError:
            return []
    buckets: dict[tuple[str, str], list[sqlite3.Row]] = {}
    for row in rows:
        if row["home_size_bytes"] is None and row["data_size_bytes"] is None:
            continue
        buckets.setdefault((row["host_name"], row["username"]), []).append(row)
    items: list[dict[str, Any]] = []
    for (host_name, username), points in buckets.items():
        if len(points) < 2:
            continue
        first, last = points[0], points[-1]
        base = (first["home_size_bytes"] or 0) + (first["data_size_bytes"] or 0)
        current = (last["home_size_bytes"] or 0) + (last["data_size_bytes"] or 0)
        delta = current - base
        if delta <= 0:
            continue
        items.append(
            {
                "host": host_name,
                "account": username,
                "delta": delta,
                "base": base,
                "current": current,
                "since": first["collected_at"],
            }
        )
    items.sort(key=lambda item: item["delta"], reverse=True)
    return items[:limit]


def upsert_user_baseline(
    host_name: str,
    account: dict,
    db_path: Path,
    *,
    now: datetime | str | None = None,
) -> bool:
    """Insert or refresh the baseline row for one account.

    Returns ``True`` only when the row did not exist yet (the caller emits a
    ``user-added`` event on that edge).  An existing row keeps its
    ``first_seen_at`` and is updated with the latest known attributes.
    """
    db_path = Path(db_path)
    init_storage(db_path)

    seen_at = (
        _to_iso_utc(now)
        if now is not None
        else datetime.now(timezone.utc).isoformat()
    )

    conn = _connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        inserted = _write_baseline(conn, host_name, account, seen_at)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()

    return inserted
