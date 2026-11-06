"""Local-timezone daily aggregation for the weekly report (Task 9).

These tests pin the behaviour that changed in Task 9:

* samples are bucketed into *local* days instead of UTC days, and
* the weekly averages are computed as the mean of per-local-day means
  (each day weighted equally), not the mean of every raw sample.

``fetch_daily_points_for_week`` / ``fetch_weekly_metrics`` keep ``tz=UTC`` as
the default so every pre-existing caller/test observes the old behaviour.
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from servermanage.models import (
    DailyReport,
    DiskUsageRow,
    GPUSummaryRow,
    HostMetrics,
    HostReport,
    MemorySummary,
)
from servermanage.storage import (
    fetch_daily_points_for_week,
    fetch_weekly_metrics,
    init_storage,
    persist_host_reports,
)

SHANGHAI = ZoneInfo("Asia/Shanghai")


def _report_at(
    when: datetime,
    *,
    name: str = "host-a",
    host: str = "10.0.0.1",
    cpu: float = 50.0,
    memory_used: int = 8192,
    memory_total: int = 16384,
) -> DailyReport:
    return DailyReport(
        generated_at=when,
        reports=[
            HostReport(
                host_name=name,
                host=host,
                success=True,
                metrics=HostMetrics(
                    collected_at=when,
                    cpu_usage_percent=cpu,
                    memory=MemorySummary(
                        total_mb=memory_total,
                        used_mb=memory_used,
                        free_mb=memory_total - memory_used,
                        shared_mb=0,
                        buff_cache_mb=0,
                        available_mb=memory_total - memory_used,
                        swap_total_mb=0,
                        swap_used_mb=0,
                        swap_free_mb=0,
                    ),
                    disk_usage=[
                        DiskUsageRow(
                            filesystem="/dev/sda1",
                            size="100G",
                            used="30G",
                            available="70G",
                            percent="30%",
                            mountpoint="/",
                        )
                    ],
                    total_processes=100,
                    logged_in_users=[],
                    gpu_summary=[],
                ),
            )
        ],
        subject_prefix="[Test]",
    )


def test_local_day_boundary(tmp_path: Path):
    """23:30Z and the matching 00:30Z land on two different local days.

    2026-07-06 23:30Z -> 2026-07-07 07:30 Asia/Shanghai
    2026-07-08 00:30Z -> 2026-07-08 08:30 Asia/Shanghai

    (The brief writes the second instant as "2026-07-07 00:30Z", but that is
    an arithmetic typo: 07-07 00:30Z converts to 07-07 08:30.  To obtain the
    asserted local wall time "07-08 08:30" the UTC date must be 07-08.)
    """
    db_path = tmp_path / "servermanage.db"
    persist_host_reports(_report_at(datetime(2026, 7, 6, 23, 30, tzinfo=timezone.utc)), db_path)
    persist_host_reports(_report_at(datetime(2026, 7, 8, 0, 30, tzinfo=timezone.utc)), db_path)

    rows = fetch_daily_points_for_week(
        db_path, date(2026, 7, 6), date(2026, 7, 8), tz=SHANGHAI
    )

    assert [row["day"] for row in rows] == ["2026-07-07", "2026-07-08"]


def test_weekly_average_of_daily_means(tmp_path: Path):
    """Weekly mean averages daily means: day1 (100, 100) + day2 (0) => 50.

    A naive mean over all three raw samples would be 66.7; the local-day
    aggregation must yield 50.0 while ``sample_count`` stays the raw 3.
    """
    db_path = tmp_path / "servermanage.db"
    # local day 2026-07-06: two samples at 100%
    persist_host_reports(_report_at(datetime(2026, 7, 6, 9, 0, tzinfo=timezone.utc), cpu=100.0), db_path)
    persist_host_reports(_report_at(datetime(2026, 7, 6, 10, 0, tzinfo=timezone.utc), cpu=100.0), db_path)
    # local day 2026-07-07: one sample at 0%
    persist_host_reports(_report_at(datetime(2026, 7, 7, 9, 0, tzinfo=timezone.utc), cpu=0.0), db_path)

    rows = fetch_weekly_metrics(
        db_path, date(2026, 7, 6), date(2026, 7, 12), tz=SHANGHAI
    )

    assert len(rows) == 1
    row = rows[0]
    assert row["sample_count"] == 3
    assert row["cpu_avg"] == 50.0  # mean of daily means, NOT 66.666...
    assert row["cpu_max"] == 100.0
    assert row["cpu_min"] == 0.0


def test_default_tz_keeps_existing_behavior(tmp_path: Path):
    """Omitting ``tz`` buckets by UTC day, exactly like the old implementation.

    The same two samples straddle UTC midnight (07-06 / 07-07) but share one
    local Shanghai day (07-07), which proves local bucketing actually differs
    while the default stays backward compatible.
    """
    db_path = tmp_path / "servermanage.db"
    persist_host_reports(_report_at(datetime(2026, 7, 6, 23, 30, tzinfo=timezone.utc)), db_path)
    persist_host_reports(_report_at(datetime(2026, 7, 7, 0, 30, tzinfo=timezone.utc)), db_path)

    default_rows = fetch_daily_points_for_week(db_path, date(2026, 7, 6), date(2026, 7, 7))
    utc_rows = fetch_daily_points_for_week(
        db_path, date(2026, 7, 6), date(2026, 7, 7), tz=timezone.utc
    )
    assert default_rows == utc_rows
    # Old UTC bucketing: two distinct UTC days.
    assert [row["day"] for row in default_rows] == ["2026-07-06", "2026-07-07"]

    # Explicit local tz collapses both samples onto one local day.
    local_rows = fetch_daily_points_for_week(
        db_path, date(2026, 7, 6), date(2026, 7, 7), tz=SHANGHAI
    )
    assert [row["day"] for row in local_rows] == ["2026-07-07"]

    # Weekly metrics default must equal the explicit-UTC result too.
    assert fetch_weekly_metrics(db_path, date(2026, 7, 6), date(2026, 7, 7)) == (
        fetch_weekly_metrics(db_path, date(2026, 7, 6), date(2026, 7, 7), tz=timezone.utc)
    )


def test_same_utc_day_splits_into_two_local_days(tmp_path: Path):
    """A single UTC day can straddle local midnight (strong local-bucketing proof).

    2026-07-06 15:30Z -> 2026-07-06 23:30 local (day 07-06)
    2026-07-06 16:30Z -> 2026-07-07 00:30 local (day 07-07)
    """
    db_path = tmp_path / "servermanage.db"
    persist_host_reports(_report_at(datetime(2026, 7, 6, 15, 30, tzinfo=timezone.utc)), db_path)
    persist_host_reports(_report_at(datetime(2026, 7, 6, 16, 30, tzinfo=timezone.utc)), db_path)

    utc_rows = fetch_daily_points_for_week(db_path, date(2026, 7, 6), date(2026, 7, 7))
    assert [row["day"] for row in utc_rows] == ["2026-07-06"]

    local_rows = fetch_daily_points_for_week(
        db_path, date(2026, 7, 6), date(2026, 7, 7), tz=SHANGHAI
    )
    assert [row["day"] for row in local_rows] == ["2026-07-06", "2026-07-07"]


def test_naive_timestamp_treated_as_utc(tmp_path: Path):
    """Legacy naive timestamps are interpreted as UTC, then converted to ``tz``.

    ``collected_at`` written by this app is ISO-8601 with a ``T`` separator,
    so a legacy naive value (no offset) is assumed to be UTC -- consistent with
    the old SQLite ``DATE(collected_at)`` bucketing.
    """
    db_path = tmp_path / "servermanage.db"
    init_storage(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO host_metrics_history"
            " (collected_at, host_name, host, success, cpu_usage_percent)"
            " VALUES (?, ?, ?, ?, ?)",
            ("2026-07-06T23:30:00", "legacy", "10.0.0.9", 1, 42.0),
        )
        conn.commit()

    utc_rows = fetch_daily_points_for_week(db_path, date(2026, 7, 6), date(2026, 7, 7))
    assert [row["day"] for row in utc_rows] == ["2026-07-06"]

    local_rows = fetch_daily_points_for_week(
        db_path, date(2026, 7, 6), date(2026, 7, 7), tz=SHANGHAI
    )
    assert [row["day"] for row in local_rows] == ["2026-07-07"]


def test_local_week_window_drops_out_of_week_and_keeps_local_monday(tmp_path: Path):
    """Regression: the SQL window must follow the *local* week, not UTC days.

    Week 2026-07-06..07-12, tz Asia/Shanghai.  All rows are UTC-stamped so the
    stored ``+00:00`` instants compare cleanly against the UTC query bounds.

    * 2026-07-05T19:00Z == local 07-06 03:00 -> IN week, bucket day 07-06
    * 2026-07-12T19:00Z == local 07-13 03:00 -> OUT of week (must be excluded)

    A correct window yields exactly seven daily buckets 07-06..07-12 and a
    weekly ``sample_count`` that ignores the out-of-week row.
    """
    db_path = tmp_path / "servermanage.db"
    # One sample at local noon for each of the seven local days.
    for day in range(6, 13):
        local_noon = datetime(2026, 7, day, 12, 0, tzinfo=SHANGHAI)
        persist_host_reports(
            _report_at(local_noon.astimezone(timezone.utc), cpu=float(day)), db_path
        )
    # Local Monday 03:00 (2026-07-06T03:00+08:00 == 2026-07-05T19:00Z): in week.
    persist_host_reports(_report_at(datetime(2026, 7, 5, 19, 0, tzinfo=timezone.utc)), db_path)
    # Local Monday 2026-07-13 03:00 (== 2026-07-12T19:00Z): out of week.
    persist_host_reports(_report_at(datetime(2026, 7, 12, 19, 0, tzinfo=timezone.utc)), db_path)

    daily = fetch_daily_points_for_week(
        db_path, date(2026, 7, 6), date(2026, 7, 12), tz=SHANGHAI
    )
    assert [row["day"] for row in daily] == [
        "2026-07-06",
        "2026-07-07",
        "2026-07-08",
        "2026-07-09",
        "2026-07-10",
        "2026-07-11",
        "2026-07-12",
    ]

    weekly = fetch_weekly_metrics(
        db_path, date(2026, 7, 6), date(2026, 7, 12), tz=SHANGHAI
    )
    assert len(weekly) == 1
    # 7 noon samples + 1 local-Monday-03:00 sample; the out-of-week row is gone.
    assert weekly[0]["sample_count"] == 8


def test_local_week_window_boundaries(tmp_path: Path):
    """Exact local-week edges are inclusive; one minute before is excluded."""
    db_path = tmp_path / "servermanage.db"
    # Exactly local Monday 00:00 (== 2026-07-05T16:00Z): included, day 07-06.
    monday_midnight = datetime(2026, 7, 6, 0, 0, tzinfo=SHANGHAI)
    persist_host_reports(
        _report_at(monday_midnight.astimezone(timezone.utc)), db_path
    )
    # Local Sunday 23:59 (== 2026-07-12T15:59Z): included, day 07-12.
    sunday_last_minute = datetime(2026, 7, 12, 23, 59, tzinfo=SHANGHAI)
    persist_host_reports(
        _report_at(sunday_last_minute.astimezone(timezone.utc)), db_path
    )
    # One minute before local Monday 00:00 (== 2026-07-05T15:59Z): excluded.
    just_before = monday_midnight - timedelta(minutes=1)
    persist_host_reports(_report_at(just_before.astimezone(timezone.utc)), db_path)

    daily = fetch_daily_points_for_week(
        db_path, date(2026, 7, 6), date(2026, 7, 12), tz=SHANGHAI
    )
    assert [row["day"] for row in daily] == ["2026-07-06", "2026-07-12"]

    weekly = fetch_weekly_metrics(
        db_path, date(2026, 7, 6), date(2026, 7, 12), tz=SHANGHAI
    )
    assert weekly[0]["sample_count"] == 2
