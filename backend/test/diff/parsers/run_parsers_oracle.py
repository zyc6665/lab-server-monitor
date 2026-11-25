#!/usr/bin/env python
"""Read-only Python oracle for the collection-parser differential tests.

Invoked as ``python run_parsers_oracle.py <fixture_json_path>``. The fixture file
has the shape::

    {"host": {"name": "gpu-01", "host": "10.0.0.1"},
     "stages": {"<stage>": "<stdout>", ...}}

where each ``stages`` key is a real probe stage name (``servermanage.commands``)
and the value is that stage's raw stdout. The script rebuilds the collector's
input exactly as production does — a minimal ``HostConfig`` plus one
``CommandResult(stdout, "", 0)`` per stage — then calls the real
``servermanage.parsers.parse_host_metrics`` and prints ``dataclasses.asdict`` of
the returned ``HostMetrics`` as a single JSON object on stdout.

The call is pure / read-only: ``parse_host_metrics`` performs no I/O, so this
oracle never touches a host or a database. Any failure is reported on stderr
with a traceback and a non-zero exit status so the harness fails loudly instead
of silently comparing against a partial answer.
"""
from __future__ import annotations

import dataclasses
import json
import sys
from datetime import datetime
from pathlib import Path

from servermanage.models import AuthConfig, CommandResult, HostConfig
from servermanage.parsers import parse_host_metrics


def _json_default(value):
    """Serialise the one non-JSON scalar in ``HostMetrics``: ``collected_at``."""
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: run_parsers_oracle.py <fixture_json_path>", file=sys.stderr)
        return 2
    fixture_path = Path(argv[1])
    if not fixture_path.exists():
        print(f"fixture not found: {fixture_path}", file=sys.stderr)
        return 2

    payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    host_cfg = payload.get("host") or {}
    host = HostConfig(
        name=str(host_cfg.get("name", "oracle-host")),
        host=str(host_cfg.get("host", "127.0.0.1")),
        port=int(host_cfg.get("port", 22)),
        username=str(host_cfg.get("username", "root")),
        auth=AuthConfig(type="password"),
    )

    stages = payload.get("stages") or {}
    results = {
        str(stage): CommandResult(stdout=str(stdout), stderr="", exit_status=0)
        for stage, stdout in stages.items()
    }

    metrics = parse_host_metrics(results, host)
    record = dataclasses.asdict(metrics)
    sys.stdout.write(json.dumps(record, ensure_ascii=False, default=_json_default) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 - surface every failure to the harness
        import traceback

        traceback.print_exc()
        raise SystemExit(1)
