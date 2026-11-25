#!/usr/bin/env python
"""Python oracle for the P5 Task 9 report-context port.

Reads a JSON scenario fixture (authored in the Python/snake_case shape) and
emits a single JSON object on stdout:

    {
      "daily":     [{"name": ..., "context": <_build_context>}],
      "executive": [{"name": ..., "context": <_build_executive_context>}],
      "weekly":    [{"name": ..., "context": <_build_weekly_context>}],
      "charts":    [{"name": ..., "svg": <render_svg_line_chart>}]
    }

The fixture is shared with `context.test.ts`, which builds the equivalent
camelCase report objects and compares the two stacks line by line.
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime
from pathlib import Path

from servermanage import models as m
from servermanage import report as report_mod


def _dt(value: object) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(str(value))


def _metrics(data: dict) -> m.HostMetrics:
    kwargs: dict[str, object] = {}
    for key in (
        "hostname",
        "os_pretty_name",
        "kernel_version",
        "uptime",
        "cpu_core_count",
        "cpu_usage_percent",
        "total_processes",
        "net_rx_bytes",
        "net_tx_bytes",
    ):
        if key in data:
            kwargs[key] = data[key]
    if "collected_at" in data:
        kwargs["collected_at"] = _dt(data["collected_at"])
    if data.get("load_average") is not None:
        kwargs["load_average"] = m.LoadAverage(**data["load_average"])
    if data.get("memory") is not None:
        kwargs["memory"] = m.MemorySummary(**data["memory"])
    if "disk_usage" in data:
        kwargs["disk_usage"] = [m.DiskUsageRow(**row) for row in data["disk_usage"]]
    if "logged_in_users" in data:
        users = []
        for row in data["logged_in_users"]:
            item = dict(row)
            item["login_at"] = _dt(item.get("login_at"))
            users.append(m.LoggedInUser(**item))
        kwargs["logged_in_users"] = users
    if "process_counts_by_user" in data:
        kwargs["process_counts_by_user"] = [
            m.UserProcessCount(**row) for row in data["process_counts_by_user"]
        ]
    if "top_cpu_processes" in data:
        kwargs["top_cpu_processes"] = [m.ProcessRow(**row) for row in data["top_cpu_processes"]]
    if "top_memory_processes" in data:
        kwargs["top_memory_processes"] = [
            m.ProcessRow(**row) for row in data["top_memory_processes"]
        ]
    if "gpu_summary" in data:
        kwargs["gpu_summary"] = [m.GPUSummaryRow(**row) for row in data["gpu_summary"]]
    if "gpu_processes" in data:
        kwargs["gpu_processes"] = [m.GPUProcessRow(**row) for row in data["gpu_processes"]]
    if "containers" in data:
        kwargs["containers"] = [m.ContainerInfo(**row) for row in data["containers"]]
    if "thermal_zones" in data:
        kwargs["thermal_zones"] = [m.ThermalZone(**row) for row in data["thermal_zones"]]
    return m.HostMetrics(**kwargs)


def _checks(rows: list[dict]) -> list[m.HostCheckResult]:
    checks = []
    for row in rows:
        item = dict(row)
        if "checked_at" in item:
            item["checked_at"] = _dt(item["checked_at"])
        checks.append(m.HostCheckResult(**item))
    return checks


def _host_report(data: dict) -> m.HostReport:
    return m.HostReport(
        host_name=str(data["host_name"]),
        host=str(data["host"]),
        success=bool(data["success"]),
        metrics=_metrics(data.get("metrics") or {}),
        errors=[m.HostCollectionError(**row) for row in data.get("errors", [])],
        checks=_checks(data.get("checks", [])),
    )


def _daily(data: dict) -> m.DailyReport:
    return m.DailyReport(
        generated_at=_dt(data["generated_at"]),
        reports=[_host_report(row) for row in data["reports"]],
        subject_prefix=str(data["subject_prefix"]),
    )


_WEEKLY_NUMERIC_FIELDS = (
    "cpu_avg",
    "cpu_max",
    "cpu_min",
    "memory_avg_percent",
    "memory_max_percent",
    "disk_avg_percent",
    "disk_max_percent",
    "gpu_util_avg",
    "gpu_util_max",
    "gpu_memory_avg_percent",
    "gpu_memory_max_percent",
    "load_avg",
    "users_avg",
    "processes_avg",
)


def _weekly_summary(data: dict) -> m.WeeklyHostSummary:
    numeric = {key: data.get(key) for key in _WEEKLY_NUMERIC_FIELDS}
    return m.WeeklyHostSummary(
        host_name=str(data["host_name"]),
        host=str(data["host"]),
        sample_count=int(data["sample_count"]),
        success_count=int(data["success_count"]),
        daily_points=[dict(point) for point in data.get("daily_points", [])],
        checks=[dict(check) for check in data.get("checks", [])],
        **numeric,
    )


def _weekly(data: dict) -> m.WeeklyReport:
    summaries = [_weekly_summary(row) for row in data["summaries"]]
    busy = [summaries[index] for index in data.get("busy_indices", [])]
    idle = [summaries[index] for index in data.get("idle_indices", [])]
    return m.WeeklyReport(
        generated_at=_dt(data["generated_at"]),
        week_start=date.fromisoformat(data["week_start"]),
        week_end=date.fromisoformat(data["week_end"]),
        summaries=summaries,
        busy_hosts=busy,
        idle_hosts=idle,
        subject_prefix=str(data["subject_prefix"]),
    )


def _jsonable(value: object) -> object:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def main() -> int:
    fixture_path = Path(sys.argv[1])
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    output: dict[str, list] = {"daily": [], "executive": [], "weekly": [], "charts": []}

    for scenario in fixture["daily"]:
        daily_report = _daily(scenario)
        output["daily"].append(
            {
                "name": scenario["name"],
                "context": _jsonable(report_mod._build_context(daily_report)),
            }
        )
        output["executive"].append(
            {
                "name": scenario["name"],
                "context": _jsonable(report_mod._build_executive_context(daily_report)),
            }
        )

    for scenario in fixture["weekly"]:
        weekly_report = _weekly(scenario)
        output["weekly"].append(
            {
                "name": scenario["name"],
                "context": _jsonable(report_mod._build_weekly_context(weekly_report)),
            }
        )

    for scenario in fixture["charts"]:
        points = [(str(label), value) for label, value in scenario["data_points"]]
        kwargs: dict[str, object] = {}
        for key in ("width", "height", "y_max"):
            if key in scenario:
                kwargs[key] = scenario[key]
        if "title" in scenario:
            kwargs["title"] = scenario["title"]
        output["charts"].append(
            {"name": scenario["name"], "svg": report_mod.render_svg_line_chart(points, **kwargs)}
        )

    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
