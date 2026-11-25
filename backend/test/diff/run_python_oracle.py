#!/usr/bin/env python
"""Read-only Python oracle for the storage differential harness.

Test-only helper. It *never* mutates the database: every handler delegates to
the production ``servermanage.storage`` read functions, which only issue
``SELECT`` statements (their per-connection pragmas are not persisted in the
file). Before running any handler we additionally open the database through a
``mode=ro`` URI and flip ``PRAGMA query_only`` on, as an explicit read-only gate.

Protocol
--------
Invoked as ``python run_python_oracle.py <db_path>`` with a JSON *plan* on
stdin::

    {"queries": [{"name": "settings", "op": "settings", "args": {}}, ...]}

For every query one JSON line is printed to stdout::

    {"name": "settings", "ok": true, "value": <oracle output>}

or, when a handler raises::

    {"name": "settings", "ok": false, "error": "<repr>"}

Anything the imported packages happen to print is ignored by the harness, which
only keeps lines that parse as JSON objects carrying a ``name`` field.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

from servermanage.storage import alerts, base, hosts, metrics

try:  # pragma: no cover - Python 3.9+
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]


def _tz(name: str | None):
    if not name or name == "UTC":
        return timezone.utc
    if ZoneInfo is None:  # pragma: no cover
        raise RuntimeError("zoneinfo unavailable")
    return ZoneInfo(name)


def _dt(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _date(value: str) -> date:
    return date.fromisoformat(value)


def _op_settings(db_path: Path, args: dict[str, Any]) -> Any:
    return base.load_app_settings(db_path)


def _op_secret_names(db_path: Path, args: dict[str, Any]) -> Any:
    return base.list_secret_names(db_path)


def _op_all_snapshots(db_path: Path, args: dict[str, Any]) -> Any:
    return hosts.get_all_host_snapshots(db_path)


def _op_host_snapshot(db_path: Path, args: dict[str, Any]) -> Any:
    return hosts.get_host_snapshot(str(args["host_name"]), db_path)


def _op_alerts(db_path: Path, args: dict[str, Any]) -> Any:
    return alerts.list_alerts(
        db_path,
        status=args.get("status"),
        since=args.get("since"),
        limit=int(args.get("limit", 200)),
    )


def _op_metrics_history(db_path: Path, args: dict[str, Any]) -> Any:
    return metrics.fetch_host_history(
        db_path,
        str(args["host_name"]),
        range_key=str(args.get("range_key", "24h")),
        tz=_tz(args.get("tz")),
        now=_dt(args.get("now")),
    )


def _op_daily_week(db_path: Path, args: dict[str, Any]) -> Any:
    return metrics.fetch_daily_points_for_week(
        db_path,
        _date(str(args["week_start"])),
        _date(str(args["week_end"])),
        tz=_tz(args.get("tz")),
    )


HANDLERS: dict[str, Callable[[Path, dict[str, Any]], Any]] = {
    "settings": _op_settings,
    "secret_names": _op_secret_names,
    "all_snapshots": _op_all_snapshots,
    "host_snapshot": _op_host_snapshot,
    "alerts": _op_alerts,
    "metrics_history": _op_metrics_history,
    "daily_week": _op_daily_week,
}


def _readonly_gate(db_path: Path) -> None:
    """Fail fast if the file is not readable through a strictly read-only URI."""
    uri = db_path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        conn.execute("PRAGMA query_only = ON")
        conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
    finally:
        conn.close()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: run_python_oracle.py <db_path>", file=sys.stderr)
        return 2
    db_path = Path(argv[1])
    if not db_path.exists():
        print(f"database not found: {db_path}", file=sys.stderr)
        return 2

    plan = json.loads(sys.stdin.read() or "{}")
    queries = plan.get("queries", [])

    _readonly_gate(db_path)

    for query in queries:
        name = query.get("name")
        op = query.get("op")
        args = query.get("args") or {}
        handler = HANDLERS.get(op)
        try:
            if handler is None:
                raise KeyError(f"unknown oracle op: {op!r}")
            value = handler(db_path, args)
            record = {"name": name, "ok": True, "value": value}
        except Exception as exc:  # noqa: BLE001 - surface every failure to the harness
            record = {"name": name, "ok": False, "error": repr(exc)}
        sys.stdout.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
