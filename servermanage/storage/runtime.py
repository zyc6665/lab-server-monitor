"""retention, maintenance, backup/restore and integrity (M4: split out of ``storage.py``)."""

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

from servermanage.storage.alerts import (
    prune_alert_history,
    prune_alert_silences,
)

from servermanage.storage.base import (
    _INTEGRITY_CACHE,
    _connect,
)

from servermanage.storage.disk import (
    prune_disk_health,
)

from servermanage.storage.metrics import (
    prune_daily_summary,
    prune_host_metrics,
)


def backup_database(db_path: Path, destination: Path) -> None:
    """Create a transactionally consistent copy of *db_path* at *destination*."""
    db_path = Path(db_path)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    source = _connect(db_path)
    target = _connect(destination)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()


def database_integrity(
    db_path: Path,
    *,
    cache_seconds: float = 0.0,
) -> tuple[bool, str]:
    """Run SQLite's quick integrity check and return ``(ok, message)``.

    ``quick_check`` reads the whole database, so dashboard polling must not run
    it every 30 seconds.  ``cache_seconds`` reuses the previous result for that
    long.  The key is the file path only: the collector writes metrics almost
    continuously, so an mtime-based key never hit and every poll rescanned the
    whole file.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return False, "数据库文件不存在"
    try:
        cache_key: str | None = str(db_path.resolve())
    except OSError:
        cache_key = None
    if cache_key is not None and cache_seconds > 0:
        cached = _INTEGRITY_CACHE.get(cache_key)
        if cached is not None and _time.monotonic() - cached[0] < cache_seconds:
            return cached[1]
    try:
        conn = _connect(db_path)
        try:
            rows = conn.execute("PRAGMA quick_check").fetchall()
        finally:
            conn.close()
        problems = [str(row[0]) for row in rows if str(row[0]).lower() != "ok"]
    except sqlite3.DatabaseError as exc:
        return False, f"数据库无法读取：{exc}"
    if problems:
        result = (False, "完整性检查发现问题：" + "；".join(problems[:3]))
    else:
        result = (True, "完整性检查通过")
    if cache_key is not None:
        _INTEGRITY_CACHE[cache_key] = (_time.monotonic(), result)
        if len(_INTEGRITY_CACHE) > 8:
            oldest = min(_INTEGRITY_CACHE, key=lambda key: _INTEGRITY_CACHE[key][0])
            _INTEGRITY_CACHE.pop(oldest, None)
    return result


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


def prune_ssh_audit(
    db_path: Path, retention_days: int = 30, *, now: datetime | None = None
) -> int:
    """Delete only ended SSH audit rows older than *retention_days*."""
    db_path = Path(db_path)
    if not db_path.exists():
        return 0
    reference = now if now is not None else datetime.now(timezone.utc)
    cutoff = (reference - timedelta(days=max(1, int(retention_days)))).isoformat()
    with _connect(db_path) as conn:
        cursor = conn.execute(
            "DELETE FROM ssh_audit_sessions"
            " WHERE ended_at IS NOT NULL AND started_at < ?",
            (cutoff,),
        )
        deleted = cursor.rowcount if cursor.rowcount is not None else 0
        conn.commit()
    return deleted


def restore_database(source: Path, destination: Path) -> None:
    """Replace *destination* with the contents of *source* using SQLite backup."""
    source = Path(source)
    destination = Path(destination)
    source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    target_connection = _connect(destination, timeout=30)
    try:
        source_connection.backup(target_connection)
    finally:
        target_connection.close()
        source_connection.close()


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
    with _connect(db_path) as conn:
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
