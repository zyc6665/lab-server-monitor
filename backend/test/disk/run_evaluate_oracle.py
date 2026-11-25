#!/usr/bin/env python
"""Read-only Python oracle for the disk-health evaluation differential tests.

Invoked as ``python run_evaluate_oracle.py <fixture_json_path>``. The fixture is
shaped::

    {
      "drives": [
        {"name": "...", "drive": {...}, "rules": {...},  # optional
         "temperature_threshold_c": 55,                  # optional
         "previous": {...} | null}                       # optional
      ],
      "virtual_drives": [{"name": "...", "vd": {...}}],
      "controllers":   [{"name": "...", "controller": {...}}]
    }

For each scenario it builds the real ``servermanage.disk_health`` dataclasses and
calls the actual oracle functions:

- drives      -> ``evaluate_drive_health`` (+ ``servermanage.alerts.evaluate_disk_alerts``)
- virtual     -> ``evaluate_virtual_drive_health`` (+ ``evaluate_disk_alerts``)
- controllers -> ``_evaluate_controller_health``

Output (single JSON object on stdout) mirrors the fixture groups; each entry has
the evaluated ``{health, reasons}`` and, for drive/virtual entries, the derived
alert ``events`` (``dataclasses.asdict``). This is pure/read-only — nothing here
touches a host, DB, or network. Any failure prints a traceback to stderr and
exits non-zero so the harness fails loudly.
"""
from __future__ import annotations

import dataclasses
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from servermanage.alerts import evaluate_disk_alerts
from servermanage.disk_health import (
    DiskControllerInfo,
    DiskHealthReport,
    PhysicalDriveInfo,
    VirtualDriveInfo,
    _evaluate_controller_health,
    evaluate_drive_health,
    evaluate_virtual_drive_health,
)
from servermanage.models import DiskHealthRuleConfig

_HOST_NAME = "oracle-host"

_DRIVE_FIELDS = (
    "controller",
    "enclosure",
    "slot",
    "did",
    "model",
    "serial",
    "state",
    "media_errors",
    "other_errors",
    "predictive_failures",
    "smart_alert",
    "temperature_c",
    "shield_counter",
    "health",
    "reasons",
)
_VD_FIELDS = ("controller", "vd_id", "raid_level", "state", "size", "health", "reasons")
_CONTROLLER_FIELDS = ("controller", "model", "firmware", "bbu_state", "health", "reasons")
_RULE_FIELDS = (
    "alert_on_media_errors",
    "alert_on_other_errors",
    "alert_on_predictive_failure",
    "alert_on_smart_flag",
    "alert_on_state_not_optimal",
    "alert_on_error_increase",
)


def _pick(payload: dict, allowed: tuple[str, ...]) -> dict:
    return {key: payload[key] for key in allowed if key in payload}


def _drive(payload: dict | None) -> PhysicalDriveInfo | None:
    if payload is None:
        return None
    return PhysicalDriveInfo(**_pick(payload, _DRIVE_FIELDS))


def _vd(payload: dict) -> VirtualDriveInfo:
    return VirtualDriveInfo(**_pick(payload, _VD_FIELDS))


def _controller(payload: dict) -> DiskControllerInfo:
    return DiskControllerInfo(**_pick(payload, _CONTROLLER_FIELDS))


def _rules(payload: dict | None) -> DiskHealthRuleConfig:
    if not payload:
        return DiskHealthRuleConfig()
    return DiskHealthRuleConfig(**_pick(payload, _RULE_FIELDS))


def _events_json(drive: PhysicalDriveInfo | None, vd: VirtualDriveInfo | None) -> list[dict]:
    report = DiskHealthReport(
        host_name=_HOST_NAME,
        collected_at=datetime.now(timezone.utc),
        status="ok",
        physical_drives=[drive] if drive is not None else [],
        virtual_drives=[vd] if vd is not None else [],
    )
    return [dataclasses.asdict(event) for event in evaluate_disk_alerts(report)]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: run_evaluate_oracle.py <fixture_json_path>", file=sys.stderr)
        return 2
    fixture_path = Path(argv[1])
    if not fixture_path.exists():
        print(f"fixture not found: {fixture_path}", file=sys.stderr)
        return 2

    payload = json.loads(fixture_path.read_text(encoding="utf-8"))

    drives_out = []
    for scenario in payload.get("drives", []):
        evaluated = evaluate_drive_health(
            _drive(scenario.get("drive")),
            rules=_rules(scenario.get("rules")),
            temperature_threshold_c=scenario.get("temperature_threshold_c", 55.0),
            previous=_drive(scenario.get("previous")),
        )
        drives_out.append(
            {
                "name": scenario["name"],
                "result": {"health": evaluated.health, "reasons": list(evaluated.reasons)},
                "events": _events_json(evaluated, None),
            }
        )

    vds_out = []
    for scenario in payload.get("virtual_drives", []):
        evaluated_vd = evaluate_virtual_drive_health(_vd(scenario["vd"]))
        vds_out.append(
            {
                "name": scenario["name"],
                "result": {
                    "health": evaluated_vd.health,
                    "reasons": list(evaluated_vd.reasons),
                },
                "events": _events_json(None, evaluated_vd),
            }
        )

    controllers_out = []
    for scenario in payload.get("controllers", []):
        evaluated_ctrl = _evaluate_controller_health(_controller(scenario["controller"]))
        controllers_out.append(
            {
                "name": scenario["name"],
                "result": {
                    "health": evaluated_ctrl.health,
                    "reasons": list(evaluated_ctrl.reasons),
                },
            }
        )

    record = {
        "drives": drives_out,
        "virtual_drives": vds_out,
        "controllers": controllers_out,
    }
    sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
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
