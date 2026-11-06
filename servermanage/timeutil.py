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

__all__ = ["resolve_timezone"]


def resolve_timezone(name: str) -> tzinfo:
    """Return the ``tzinfo`` for the IANA timezone *name*.

    Falls back to :data:`datetime.timezone.utc` (with a warning) when the name
    is unknown or tz data is unavailable, so a bad config value degrades to a
    usable timezone instead of crashing the whole application at startup.
    """
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - any failure must degrade to UTC
        LOGGER.warning(
            "Timezone %r is not available; falling back to UTC", name, exc_info=True
        )
        return timezone.utc
