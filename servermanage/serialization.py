"""JSON serialization helpers for the polling monitor storage layer.

The storage layer persists dataclasses (``HostReport``, ``DiskHealthReport``,
``AlertEvent`` ...) as JSON so snapshots can be replayed to the dashboard
without re-collecting.  The two helpers here perform a recursive structural
conversion that :func:`json.dumps` can handle.
"""

from __future__ import annotations

import json
from dataclasses import fields, is_dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

__all__ = ["to_jsonable", "dump_json"]


def to_jsonable(obj: Any) -> Any:
    """Convert *obj* into a JSON-serialisable structure.

    - dataclass instance -> ``dict`` (recursively, walked field by field)
    - ``datetime`` / ``date`` -> ISO 8601 string
    - ``tuple`` / ``set`` / other list-likes -> ``list``
    - ``Path`` -> ``str``

    Dataclass fields whose ``metadata["sensitive"]`` is truthy are omitted so
    secrets (for example a host's ``sudo_password``) can never be serialised.

    Containers are walked recursively so datetimes nested inside plain
    ``dict`` / ``list`` values are converted too.
    """
    if is_dataclass(obj) and not isinstance(obj, type):
        return {
            item.name: to_jsonable(getattr(obj, item.name))
            for item in fields(obj)
            if not item.metadata.get("sensitive")
        }
    if isinstance(obj, dict):
        return {key: to_jsonable(value) for key, value in obj.items()}
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [to_jsonable(value) for value in obj]
    if isinstance(obj, Path):
        return str(obj)
    return obj


def dump_json(obj: Any) -> str:
    """Serialise *obj* to JSON, preserving non-ASCII characters (``ensure_ascii=False``)."""
    return json.dumps(to_jsonable(obj), ensure_ascii=False)
