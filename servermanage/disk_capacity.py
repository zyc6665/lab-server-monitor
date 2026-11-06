"""Disk-capacity helpers for per-mount monitoring.

The monitoring feature lets each host declare the mount points whose capacity
should be tracked (``HostConfig.disk_mounts``).  These helpers turn the raw
``DiskUsageRow`` data into a normalised, per-mount view so the collector, the
alert engine and the web dashboard all agree on what "the disk usage" is.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

DEFAULT_DISK_MOUNTS: tuple[str, ...] = ("/", "/data")

#: Filesystems that do not represent real, monitored capacity.
VIRTUAL_FILESYSTEMS = {
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


def normalize_mounts(mounts: Sequence[str] | None) -> list[str]:
    """Return a clean, de-duplicated list of mount points.

    ``None`` or an empty sequence falls back to :data:`DEFAULT_DISK_MOUNTS`.
    """
    if not mounts:
        return list(DEFAULT_DISK_MOUNTS)
    result: list[str] = []
    for mount in mounts:
        if mount is None:
            continue
        text = str(mount).strip()
        if text and text not in result:
            result.append(text)
    return result or list(DEFAULT_DISK_MOUNTS)


def _row_value(row: Any, key: str) -> Any:
    if isinstance(row, dict):
        return row.get(key)
    return getattr(row, key, None)


def _parse_percent(value: Any) -> float | None:
    """Parse an ``int``/``float``/``"95%"``-style value into a float."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    digits = "".join(ch for ch in text if ch.isdigit() or ch == ".")
    if not digits:
        return None
    try:
        return float(digits)
    except ValueError:
        return None


def mount_statuses(
    rows: Sequence[Any] | None,
    mounts: Sequence[str] | None,
) -> list[dict[str, Any]]:
    """Build one status entry per configured mount point.

    Every configured mount appears in the result, in the configured order,
    whether or not it was reported.  A missing mount has ``present`` ``False``
    and all other values ``None``.  Rows backed by a virtual filesystem (for
    example ``tmpfs`` mounted at ``/``) are treated as absent so they never
    raise a capacity alert.
    """
    ordered_mounts = normalize_mounts(mounts)
    indexed: dict[str, Any] = {}
    for row in rows or []:
        mountpoint = _row_value(row, "mountpoint")
        if mountpoint is None:
            continue
        filesystem = _row_value(row, "filesystem")
        if filesystem is not None and str(filesystem) in VIRTUAL_FILESYSTEMS:
            continue
        key = str(mountpoint)
        if key not in indexed:
            indexed[key] = row

    statuses: list[dict[str, Any]] = []
    for mountpoint in ordered_mounts:
        row = indexed.get(mountpoint)
        if row is None:
            statuses.append(
                {
                    "mountpoint": mountpoint,
                    "present": False,
                    "filesystem": None,
                    "size": None,
                    "used": None,
                    "available": None,
                    "percent": None,
                }
            )
            continue
        statuses.append(
            {
                "mountpoint": mountpoint,
                "present": True,
                "filesystem": _row_value(row, "filesystem"),
                "size": _row_value(row, "size"),
                "used": _row_value(row, "used"),
                "available": _row_value(row, "available"),
                "percent": _parse_percent(_row_value(row, "percent")),
            }
        )
    return statuses


def max_percent(
    rows: Sequence[Any] | None,
    mounts: Sequence[str] | None,
) -> float | None:
    """Highest usage percentage among the configured, present mounts."""
    values = [
        status["percent"]
        for status in mount_statuses(rows, mounts)
        if status["present"] and status["percent"] is not None
    ]
    if not values:
        return None
    return float(max(values))
