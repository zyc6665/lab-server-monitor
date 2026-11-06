from __future__ import annotations

import logging
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone, tzinfo
from pathlib import Path

from servermanage.models import WeeklyHostSummary, WeeklyReport, WeeklyReportConfig
from servermanage.storage import fetch_daily_points_for_week, fetch_weekly_metrics

LOGGER = logging.getLogger(__name__)

_MIN_SAMPLES_FOR_CLASSIFICATION = 3


def _previous_week_range(reference_date: date | None = None) -> tuple[date, date]:
    today = reference_date or datetime.now(timezone.utc).date()
    # weekday(): Monday=0, Sunday=6
    days_since_monday = today.weekday()
    week_end = today - timedelta(days=days_since_monday + 1)
    week_start = week_end - timedelta(days=6)
    return week_start, week_end


def _compute_intensity_score(summary: WeeklyHostSummary) -> float:
    cpu = summary.cpu_avg or 0.0
    memory = summary.memory_avg_percent or 0.0
    gpu = summary.gpu_util_avg or 0.0

    if summary.gpu_util_avg is None:
        # Re-normalize weights when GPU is absent.
        total_weight = 0.8
        return round((cpu * 0.5 + memory * 0.3) / total_weight, 2)

    return round(cpu * 0.5 + memory * 0.3 + gpu * 0.2, 2)


def _build_summary(row: dict[str, object]) -> WeeklyHostSummary:
    def _float(value: object) -> float | None:
        return float(value) if value is not None else None

    return WeeklyHostSummary(
        host_name=str(row["host_name"]),
        host=str(row["host"]),
        sample_count=int(row["sample_count"]),
        success_count=int(row["success_count"]),
        cpu_avg=_float(row.get("cpu_avg")),
        cpu_max=_float(row.get("cpu_max")),
        cpu_min=_float(row.get("cpu_min")),
        memory_avg_percent=_float(row.get("memory_avg_percent")),
        memory_max_percent=_float(row.get("memory_max_percent")),
        disk_avg_percent=_float(row.get("disk_avg_percent")),
        disk_max_percent=_float(row.get("disk_max_percent")),
        gpu_util_avg=_float(row.get("gpu_util_avg")),
        gpu_util_max=_float(row.get("gpu_util_max")),
        gpu_memory_avg_percent=_float(row.get("gpu_memory_avg_percent")),
        gpu_memory_max_percent=_float(row.get("gpu_memory_max_percent")),
        load_avg=_float(row.get("load_avg")),
        users_avg=_float(row.get("users_avg")),
        processes_avg=_float(row.get("processes_avg")),
    )


def generate_weekly_report(
    db_path: Path,
    *,
    reference_date: date | None = None,
    config: WeeklyReportConfig | None = None,
    tz: tzinfo = timezone.utc,
) -> WeeklyReport:
    config = config or WeeklyReportConfig()
    week_start, week_end = _previous_week_range(reference_date)

    rows = fetch_weekly_metrics(db_path, week_start, week_end, tz=tz)
    daily_rows = fetch_daily_points_for_week(db_path, week_start, week_end, tz=tz)
    daily_points_by_host: dict[tuple[str, str], list[dict[str, object]]] = {}
    for row in daily_rows:
        key = (str(row["host_name"]), str(row["host"]))
        daily_points_by_host.setdefault(key, []).append(
            {
                "day": str(row["day"]),
                "cpu_avg": row["cpu_avg"],
                "memory_percent": row["memory_percent"],
                "gpu_util": row["gpu_util"],
            }
        )

    summaries = []
    for row in rows:
        summary = _build_summary(row)
        key = (summary.host_name, summary.host)
        points = daily_points_by_host.get(key, [])
        summaries.append(
            summary if not points else replace(summary, daily_points=points)
        )

    busy: list[WeeklyHostSummary] = []
    idle: list[WeeklyHostSummary] = []

    for summary in summaries:
        if summary.sample_count < _MIN_SAMPLES_FOR_CLASSIFICATION:
            continue
        score = _compute_intensity_score(summary)
        if score >= config.busy_threshold:
            busy.append(summary)
        elif score <= config.idle_threshold:
            idle.append(summary)

    busy.sort(key=lambda s: _compute_intensity_score(s), reverse=True)
    idle.sort(key=lambda s: _compute_intensity_score(s))

    return WeeklyReport(
        generated_at=datetime.now(timezone.utc),
        week_start=week_start,
        week_end=week_end,
        summaries=summaries,
        busy_hosts=busy,
        idle_hosts=idle,
        subject_prefix=config.subject_prefix,
    )
