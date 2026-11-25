#!/usr/bin/env python
"""Differential oracle for P4 Task11 (scheduler time semantics + alert engine).

Run from the repository root with CPython 3.12 (``python`` on PATH); the test
harness injects PYTHONPATH so that ``import servermanage.*`` resolves.  Emits a
single JSON document on stdout whose last line is the payload; failures print a
traceback to stderr and exit 1.

Two independent parts
=====================
Part A -- time semantics
    Drives the REAL scheduling helpers in ``servermanage/scheduler.py`` so the
    Node port ``backend/src/runtime/schedule-time.ts`` can be diffed against the
    Python source of truth:

      * ``should_run(*, last_run_at, interval_seconds, now)``      scheduler.py:135-152
      * ``compute_daily_fire(now_local, hhmm)``                    scheduler.py:155-166
      * ``compute_weekly_fire(now_local, weekday, hhmm)``          scheduler.py:169-185
      * ``_current_period_target(target_time, now_local, tz)``     scheduler.py:188-223
      * ``is_report_due(*, last_run_at, target_local, now_local)`` scheduler.py:226-253
    Every instant is formatted as a naive wall-clock string ``%Y-%m-%dT%H:%M:%S``
    (the Node side works in the same "civil" domain: UTC getters == wall clock).

Part B -- alert engine state machine
    Drives the REAL ``servermanage.alerts.AlertEngine`` (not a re-implementation)
    against an in-memory-style temp SQLite database created by
    ``servermanage.storage.init_storage`` with a fake clock and a recording
    notifier.  The engine rules exercised (and the line numbers they live on in
    ``servermanage/alerts.py``):

      * silence gating ............ _is_silenced L1210-1233 / SilenceRegistry.active_for L605-634
      * cooldown + ack + retry .... _should_skip L1235-1297
      * error-increase bypass ..... _has_error_increase L855-864 (checked first in _should_skip)
      * severity escalation ....... _severity_rank L869-872 + repeat_while_active branch L1292-1297
      * recovery emission ......... resolve L1012-1052 / resolve_missing L1054-1128 /
                                    _emit_recovery L1158-1166 / recovery_event L564-573
      * aggregate batch .......... _process_aggregated L976-1010 / _batch_event L722-743 /
                                    _dispatch_batch L1316-1344
      * persistence/record ....... _persist L1299-1306 / _record_channels L1346-1356

    Note: consecutive-period ("streak") gating is NOT part of Python's
    AlertEngine -- it lives in ``servermanage/app.py`` (run_status_once).  The
    Node port folds that gate into ``AlertEngine.process`` (engine.ts:34-37).  To
    compare the *shared* engine logic 1:1 the fixtures set
    ``consecutive_periods = 1`` on both sides, which makes the folded gate a
    pass-through; streak > 1 is a documented structural difference covered by
    the dedicated ``backend/src/alerts/streak.ts`` unit tests instead.
"""

from __future__ import annotations

import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import servermanage.alerts as alerts
import servermanage.scheduler as scheduler
import servermanage.storage.alerts as storage_alerts
from servermanage.alerts import AlertEngine, SilenceRegistry
from servermanage.disk_health import AlertEvent
from servermanage.models import AlertsConfig
from servermanage.storage import init_storage

WALL_FMT = "%Y-%m-%dT%H:%M:%S"


def _wall(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.replace(tzinfo=None).strftime(WALL_FMT)


def _aware(naive_iso: str | None, tz: str) -> datetime | None:
    if naive_iso is None:
        return None
    dt = datetime.fromisoformat(naive_iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(tz))
    return dt


def _inst(instant_iso: str) -> datetime:
    return datetime.fromisoformat(instant_iso.replace("Z", "+00:00"))


# ----------------------------------------------------------------------------
# Part A: time semantics
# ----------------------------------------------------------------------------
def build_time_points(fixture: dict) -> list[dict]:
    rows = fixture["timePoints"]
    out: list[dict] = []
    for row in rows:
        tz = row["tz"]
        now_aware = _inst(row["nowUtc"])
        now_local = now_aware.astimezone(ZoneInfo(tz))

        daily_fire = scheduler.compute_daily_fire(now_local, row["dailyHhmm"])
        weekly_fire = scheduler.compute_weekly_fire(
            now_local, int(row["weeklyWeekday"]), row["weeklyHhmm"]
        )

        spacing = int(row["reportSpacingDays"])
        if spacing <= 2:
            def target_time(n, hhmm=row["reportHhmm"]):
                return scheduler.compute_daily_fire(n, hhmm)
        else:
            def target_time(n, wd=int(row["reportWeekday"]), hhmm=row["reportHhmm"]):
                return scheduler.compute_weekly_fire(n, wd, hhmm)
        period_target = scheduler._current_period_target(
            target_time, now_local, ZoneInfo(tz)
        )

        last_run = _aware(row["lastRunLocal"], tz)
        should = scheduler.should_run(
            last_run_at=last_run,
            interval_seconds=int(row["intervalSeconds"]),
            now=now_aware,
        )

        report_last = _aware(row["reportLastRunLocal"], tz)
        report_due = scheduler.is_report_due(
            last_run_at=report_last,
            target_local=period_target,
            now_local=now_local,
        )

        out.append(
            {
                "id": row["id"],
                "tz": tz,
                "nowUtc": row["nowUtc"],
                "nowLocal": _wall(now_local),
                "dailyFire": _wall(daily_fire),
                "weeklyFire": _wall(weekly_fire),
                "periodTarget": _wall(period_target),
                "shouldRun": bool(should),
                "reportDue": bool(report_due),
            }
        )
    return out


# ----------------------------------------------------------------------------
# Part B: alert engine
# ----------------------------------------------------------------------------
def norm_event(ev: AlertEvent) -> dict:
    return {
        "host_name": ev.host_name,
        "category": ev.category,
        "severity": ev.severity,
        "title": ev.title,
        "message": ev.message,
        "fingerprint": ev.fingerprint,
        "reasons": list(ev.reasons or []),
    }


def make_event(raw: dict) -> AlertEvent:
    return AlertEvent(
        host_name=raw["host_name"],
        category=raw["category"],
        severity=raw["severity"],
        title=raw["title"],
        message=raw["message"],
        fingerprint=raw["fingerprint"],
        reasons=tuple(raw.get("reasons") or ()),
    )


class FakeNotifier:
    """Records every dispatch call; accepts a fixed channel list per step."""

    def __init__(self) -> None:
        self._accept: list[str] = []
        self.log: list[dict] = []

    def set_accept(self, channels: list[str]) -> None:
        self._accept = list(channels)

    def reset(self, channels: list[str]) -> None:
        self._accept = list(channels)
        self.log = []

    def dispatch(self, event: AlertEvent, config) -> list[str]:
        channels = list(self._accept)
        self.log.append({"events": [norm_event(event)], "channels": channels})
        return channels

    def dispatch_batch(self, events, config) -> list[str]:
        channels = list(self._accept)
        self.log.append(
            {"events": [norm_event(e) for e in events], "channels": channels}
        )
        return channels


def build_config(raw: dict) -> AlertsConfig:
    return AlertsConfig(
        enabled=bool(raw["enabled"]),
        cooldown_minutes=int(raw["cooldown_minutes"]),
        repeat_while_active=bool(raw["repeat_while_active"]),
        aggregate_by_host=bool(raw["aggregate_by_host"]),
        notify_on_recovery=bool(raw["notify_on_recovery"]),
        consecutive_periods=int(raw["consecutive_periods"]),
    )


def run_scenario(sc: dict, workroot: str) -> dict:
    db_dir = tempfile.mkdtemp(dir=workroot)
    db_path = Path(db_dir) / "alerts.sqlite"
    init_storage(db_path)

    state: dict[str, datetime] = {"now": _inst("2026-01-01T00:00:00Z")}

    def clock() -> datetime:
        return alerts._as_utc(state["now"])

    config = build_config(sc["config"])
    notifier = FakeNotifier()
    silence_checker = SilenceRegistry(db_path, clock=clock)

    for silence in sc.get("silences", []):
        storage_alerts.insert_silence(
            silence["scopeType"],
            silence.get("scope"),
            silence["reason"],
            silence["startsAt"],
            silence["endsAt"],
            None,
            db_path,
        )

    engine = AlertEngine(
        db_path,
        config,
        notifier,
        clock=clock,
        silence_checker=silence_checker,
        host_groups=sc.get("hostGroups"),
    )

    steps_out: list[dict] = []
    for step in sc["steps"]:
        at = step["at"]
        state["now"] = _inst(at)
        now = alerts._as_utc(state["now"])
        action = step["action"]
        channels = list(step["accept"]) if "accept" in step else ["desktop"]
        notifier.reset(channels)

        notified: list[dict] = []
        if action == "process":
            events = [make_event(e) for e in step.get("events", [])]
            result = engine.process(events)
            notified = [norm_event(e) for e in result]
        elif action == "ack":
            host = step["host"]
            category = step.get("category")
            rows = storage_alerts.list_open_alerts_for_host(
                host, db_path, category=category
            )
            for row in rows:
                storage_alerts.update_alert(
                    row["id"],
                    db_path,
                    status="acknowledged",
                    ack_at=now.isoformat(),
                )
        elif action == "resolve":
            result = engine.resolve(
                step["host"],
                step["category"],
                notify=bool(step.get("notify", True)),
            )
            notified = [norm_event(e) for e in result]
        elif action == "resolve_missing":
            result = engine.resolve_missing(
                step["host"],
                step.get("active_fingerprints", []),
                category=step.get("category"),
                skip_prefixes=tuple(step.get("skip_prefixes", ())),
                notify=bool(step.get("notify", True)),
            )
            notified = [norm_event(e) for e in result]
        else:  # pragma: no cover - guarded by fixtures
            raise ValueError(f"unknown action {action!r}")

        steps_out.append(
            {
                "action": action,
                "at": at,
                "notified": notified,
                "dispatched": list(notifier.log),
            }
        )

    return {"id": sc["id"], "steps": steps_out}


def main() -> int:
    base = Path(__file__).resolve().parent
    fixtures = base / "fixtures"
    time_fixture = json.loads((fixtures / "time_points.json").read_text("utf-8"))
    scenario_fixture = json.loads((fixtures / "scenarios.json").read_text("utf-8"))

    workroot = tempfile.mkdtemp(prefix="scheduler-alerts-oracle-")
    try:
        time_points = build_time_points(time_fixture)
        scenarios = [
            run_scenario(sc, workroot) for sc in scenario_fixture["scenarios"]
        ]
    finally:
        import shutil

        shutil.rmtree(workroot, ignore_errors=True)

    payload = {
        "part": "scheduler-alerts",
        "pythonVersion": sys.version.split()[0],
        "timePoints": time_points,
        "scenarios": scenarios,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
