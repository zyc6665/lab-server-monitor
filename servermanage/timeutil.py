"""Timezone helpers for the PC polling monitor.

The application is configured with an IANA timezone name (``app.timezone``,
default ``Asia/Shanghai``).  On Windows the IANA database comes from the
``tzdata`` package (already a dependency), so :class:`zoneinfo.ZoneInfo` works
without the OS providing tz data.
"""

from __future__ import annotations

import logging
from datetime import timezone, tzinfo
from zoneinfo import ZoneInfo

LOGGER = logging.getLogger(__name__)

__all__ = ["resolve_timezone", "timezone_status"]

# ``name -> {"available": bool, "detail": str}``, filled whenever a timezone is
# resolved.  A UTC fallback used to be visible only in the log file; the
# system-health panel now reads this so an offset clock becomes user-visible.
_STATUS: dict[str, dict[str, object]] = {}


def _probe(name: str) -> dict[str, object]:
    """Resolve *name* once and memoise the outcome (no logging, never raises)."""
    cached = _STATUS.get(name)
    if cached is not None:
        return cached
    try:
        ZoneInfo(name)
    except Exception as exc:  # noqa: BLE001 - a probe must never raise
        info: dict[str, object] = {
            "available": False,
            "detail": f"{type(exc).__name__}: {exc}",
        }
    else:
        info = {"available": True, "detail": ""}
    _STATUS[name] = info
    return info


def resolve_timezone(name: str) -> tzinfo:
    """Return the ``tzinfo`` for the IANA timezone *name*.

    Falls back to :data:`datetime.timezone.utc` (with a warning) when the name
    is unknown or tz data is unavailable, so a bad config value degrades to a
    usable timezone instead of crashing the whole application at startup.
    """
    try:
        resolved = ZoneInfo(name)
    except Exception:  # noqa: BLE001 - any failure must degrade to UTC
        _STATUS[name] = {
            "available": False,
            "detail": "ZoneInfo could not load the IANA key (tzdata missing?)",
        }
        LOGGER.warning(
            "Timezone %r is not available; falling back to UTC. Logs, reports and "
            "e-mail timestamps will be offset - check that the bundled tzdata data "
            "files exist (see packaging/verify-bundle.py).",
            name,
            exc_info=True,
        )
        return timezone.utc
    _STATUS[name] = {"available": True, "detail": ""}
    return resolved


def timezone_status(name: str) -> dict[str, object]:
    """Return ``{name, available, effective, detail}`` for *name*; never raises.

    Used by the system-health panel so a silent UTC fallback is reported as a
    warning instead of staying a log-only detail.
    """
    info = _probe(name)
    available = bool(info["available"])
    return {
        "name": name,
        "available": available,
        "effective": name if available else "UTC",
        "detail": str(info["detail"]),
    }
