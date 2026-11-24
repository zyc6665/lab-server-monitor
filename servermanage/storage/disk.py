"""disk-health batches (storcli snapshots) (M4: split out of ``storage.py``)."""

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
    _dump_reasons,
    _load_reasons,
    init_storage,
)


def get_all_disk_health(db_path: Path) -> list[dict]:
    """Return the latest disk-health batch for every host.

    Same shape as :func:`get_disk_health` per host, but fetched with four
    queries for the whole fleet (header + one per component table) instead of
    four per host.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return []

    latest = (
        "WITH latest AS ("
        " SELECT host_name, MAX(collected_at) AS collected_at"
        " FROM disk_health_snapshot GROUP BY host_name"
        ")"
    )
    with _connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        headers = conn.execute(
            f"""
            {latest}
            SELECT h.host_name, h.collected_at, h.status, h.message
              FROM latest l
              JOIN disk_health_snapshot h
                ON h.host_name = l.host_name AND h.collected_at = l.collected_at
             ORDER BY h.host_name
            """
        ).fetchall()
        if not headers:
            return []
        controllers = conn.execute(
            f"""
            {latest}
            SELECT c.host_name, c.controller, c.model, c.firmware, c.bbu_state,
                   c.health, c.reasons
              FROM latest l
              JOIN disk_controller_snapshot c
                ON c.host_name = l.host_name AND c.collected_at = l.collected_at
             ORDER BY c.host_name, c.controller
            """
        ).fetchall()
        virtual_drives = conn.execute(
            f"""
            {latest}
            SELECT v.host_name, v.controller, v.vd_id, v.raid_level, v.state,
                   v.size, v.health, v.reasons
              FROM latest l
              JOIN disk_vd_snapshot v
                ON v.host_name = l.host_name AND v.collected_at = l.collected_at
             ORDER BY v.host_name, v.controller, v.vd_id
            """
        ).fetchall()
        physical_drives = conn.execute(
            f"""
            {latest}
            SELECT p.host_name, p.controller, p.enclosure, p.slot, p.did, p.model,
                   p.serial, p.state, p.media_errors, p.other_errors,
                   p.predictive_failures, p.smart_alert, p.temperature_c,
                   p.shield_counter, p.health, p.reasons
              FROM latest l
              JOIN disk_pd_snapshot p
                ON p.host_name = l.host_name AND p.collected_at = l.collected_at
             ORDER BY p.host_name, p.controller, p.enclosure, p.slot
            """
        ).fetchall()

    results: dict[str, dict] = {}
    for row in headers:
        results[str(row["host_name"])] = {
            "host_name": row["host_name"],
            "collected_at": row["collected_at"],
            "status": row["status"],
            "message": row["message"],
            "controllers": [],
            "virtual_drives": [],
            "physical_drives": [],
        }

    for row in controllers:
        entry = results.get(str(row["host_name"]))
        if entry is None:
            continue
        item = {key: row[key] for key in row.keys() if key != "host_name"}
        item["reasons"] = _load_reasons(item.get("reasons"))
        entry["controllers"].append(item)
    for row in virtual_drives:
        entry = results.get(str(row["host_name"]))
        if entry is None:
            continue
        item = {key: row[key] for key in row.keys() if key != "host_name"}
        item["reasons"] = _load_reasons(item.get("reasons"))
        entry["virtual_drives"].append(item)
    for row in physical_drives:
        entry = results.get(str(row["host_name"]))
        if entry is None:
            continue
        item = {key: row[key] for key in row.keys() if key != "host_name"}
        item["reasons"] = _load_reasons(item.get("reasons"))
        if item.get("smart_alert") is not None:
            item["smart_alert"] = bool(item["smart_alert"])
        entry["physical_drives"].append(item)

    return [results[name] for name in sorted(results)]


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

    with _connect(db_path) as conn:
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
    with _connect(db_path) as conn:
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

    with _connect(db_path) as conn:
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
