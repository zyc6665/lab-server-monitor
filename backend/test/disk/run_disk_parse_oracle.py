"""Differential-test oracle for the storcli parsers.

Invoked by ``backend/test/disk/parse.test.ts`` as::

    python run_disk_parse_oracle.py <op> <fixture_path> [<arg>]

It imports the Python production module ``servermanage.disk_health`` and calls
the requested ``parse_*`` function on the fixture text, serialising the result
(dataclasses -> plain dicts) to a single JSON line on stdout. Parse failures are
reported as ``{"ok": false, "error": "<ExceptionClassName>", ...}`` so the Node
test can assert both stacks reject the same input identically.
"""
from __future__ import annotations

import dataclasses
import json
import sys

from servermanage import disk_health as dh


def _serialize(value):
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    if isinstance(value, list):
        return [_serialize(item) for item in value]
    return value


def _run() -> object:
    op = sys.argv[1]
    path = sys.argv[2]
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    if op == "controllers":
        return dh.parse_controllers(text)
    if op == "virtual":
        return dh.parse_virtual_drives(text, int(sys.argv[3]))
    if op == "physical":
        return dh.parse_physical_drives(text)
    if op == "physical_text":
        return dh.parse_physical_drives_text(text)
    if op == "temperature":
        return [dh.parse_temperature(v) for v in json.loads(sys.argv[3])]
    raise SystemExit(f"unknown op: {op}")


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
    print(json.dumps({"ok": True, "value": _serialize(value)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
