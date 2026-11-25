"""Differential-test oracle for ``disk_report_from_snapshot``.

Invoked by ``backend/test/disk/report.test.ts`` as::

    python run_disk_report_oracle.py snapshot <fixture_path> <group>

``<fixture_path>`` is a JSON object mapping a group name to a stored-snapshot
dict (exactly what ``storage.get_disk_health`` returns). The script imports the
Python production module ``servermanage.disk_health``, calls
``disk_report_from_snapshot`` on the selected group, and serialises the resulting
``DiskHealthReport`` dataclass to a single JSON line on stdout.

Datetimes are rendered with ``isoformat()`` so the payload is JSON-safe; the
Node side normalises ISO instants to a canonical UTC microsecond value before
diffing, so equal instants compare equal regardless of ``+00:00`` vs ``Z``.

Failures are reported as ``{"ok": false, "error": "<ClassName>", "message": ...}``
so the Node test can surface the same exception class.
"""
from __future__ import annotations

import dataclasses
import datetime as _dt
import json
import sys

from servermanage import disk_health as dh


def _jsonable(value):
    if isinstance(value, _dt.datetime):
        return value.isoformat()
    if isinstance(value, _dt.date):
        return value.isoformat()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return _jsonable(dataclasses.asdict(value))
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    return value


def _run() -> object:
    op = sys.argv[1]
    path = sys.argv[2]
    group = sys.argv[3] if len(sys.argv) > 3 else None
    with open(path, "r", encoding="utf-8") as handle:
        groups = json.load(handle)
    if op != "snapshot":
        raise SystemExit(f"unknown op: {op}")
    if not isinstance(groups, dict) or group not in groups:
        raise SystemExit(f"unknown group: {group}")
    return dh.disk_report_from_snapshot(groups[group])


def main() -> None:
    try:
        value = _run()
    except Exception as exc:  # noqa: BLE001 - surface the class name to Node
        print(
            json.dumps(
                {"ok": False, "error": type(exc).__name__, "message": str(exc)},
                ensure_ascii=False,
            )
        )
        return
    print(json.dumps({"ok": True, "value": _jsonable(value)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
