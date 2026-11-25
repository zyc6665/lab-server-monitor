#!/usr/bin/env python
"""Python oracle for the P5 Task 10 report-rendering port.

Reads a JSON scenario fixture (authored in the Python/snake_case shape, the
same shape used by ``report-context-scenarios.json``) and emits a single JSON
object on stdout:

    {
      "daily":  [{"name": ..., "technical": {subject, text_body, html_body},
                  "executive": {subject, text_body, html_body}}],
      "weekly": [{"name": ..., "weekly": {subject, text_body, html_body}}]
    }

The rendered bodies come straight from ``servermanage.report.render_report``
(the real Jinja2 environment); ``render.test.ts`` compares the Node output
byte-for-byte against these strings.
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


def _int_or_none(value: object) -> object:
    return None if value is None else int(value)


def _proc_rows(rows: list[dict]) -> list[m.ProcessRow]:
    result = []
    for row in rows:
        item = dict(row)
        for field in ("cpu_percent", "mem_percent"):
            if item.get(field) is not None:
                item[field] = float(item[field])
        if item.get("pid") is not None:
            item["pid"] = int(item["pid"])
        result.append(m.ProcessRow(**item))
    return result


def _gpu_summary_row(row: dict) -> m.GPUSummaryRow:
    item = dict(row)
    for field in ("index", "memory_used_mb", "memory_total_mb"):
        if item.get(field) is not None:
            item[field] = int(item[field])
    item["temperature_c"] = _int_or_none(item.get("temperature_c"))
    return m.GPUSummaryRow(**item)


def _gpu_process_row(row: dict) -> m.GPUProcessRow:
    item = dict(row)
    for field in ("index", "pid", "memory_used_mb"):
        if item.get(field) is not None:
            item[field] = int(item[field])
    return m.GPUProcessRow(**item)


def _metrics(data: dict) -> m.HostMetrics:
    kwargs: dict[str, object] = {}
    for key in ("hostname", "os_pretty_name", "kernel_version", "uptime", "cpu_usage_percent"):
        if key in data:
            kwargs[key] = data[key]
    for key in ("cpu_core_count", "total_processes", "net_rx_bytes", "net_tx_bytes"):
        if key in data:
            kwargs[key] = _int_or_none(data[key])
    if "collected_at" in data:
        kwargs["collected_at"] = _dt(data["collected_at"])
    if data.get("load_average") is not None:
        load = dict(data["load_average"])
        for field in ("load_1", "load_5", "load_15"):
            if load.get(field) is not None:
                load[field] = float(load[field])
        kwargs["load_average"] = m.LoadAverage(**load)
    if data.get("memory") is not None:
        memory = {key: _int_or_none(value) for key, value in data["memory"].items()}
        kwargs["memory"] = m.MemorySummary(**memory)
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
        counts = []
        for row in data["process_counts_by_user"]:
            item = dict(row)
            if item.get("count") is not None:
                item["count"] = int(item["count"])
            counts.append(m.UserProcessCount(**item))
        kwargs["process_counts_by_user"] = counts
    if "top_cpu_processes" in data:
        kwargs["top_cpu_processes"] = _proc_rows(data["top_cpu_processes"])
    if "top_memory_processes" in data:
        kwargs["top_memory_processes"] = _proc_rows(data["top_memory_processes"])
    if "gpu_summary" in data:
        kwargs["gpu_summary"] = [_gpu_summary_row(row) for row in data["gpu_summary"]]
    if "gpu_processes" in data:
        kwargs["gpu_processes"] = [_gpu_process_row(row) for row in data["gpu_processes"]]
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


def _render(report: object, variant: str) -> dict[str, str]:
    rendered = report_mod.render_report(report, variant)  # type: ignore[arg-type]
    return {
        "subject": rendered.subject,
        "text_body": rendered.text_body,
        "html_body": rendered.html_body,
    }


def main() -> int:
    fixture_path = Path(sys.argv[1])
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    output: dict[str, list] = {"daily": [], "weekly": []}

    for scenario in fixture.get("daily", []):
        daily_report = _daily(scenario)
        output["daily"].append(
            {
                "name": scenario["name"],
                "technical": _render(daily_report, "technical"),
                "executive": _render(daily_report, "executive"),
            }
        )

    for scenario in fixture.get("weekly", []):
        weekly_report = _weekly(scenario)
        output["weekly"].append(
            {"name": scenario["name"], "weekly": _render(weekly_report, "weekly")}
        )

    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
