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
    WeeklyReportConfig,
)
from servermanage.storage import persist_host_reports
from servermanage.weekly import (
    _compute_intensity_score,
    _previous_week_range,
    generate_weekly_report,
)


def _make_report_at(
    when: datetime,
    *,
    name: str = "host",
    host: str = "10.0.0.1",
    cpu: float = 50.0,
    memory_used: int = 8192,
    memory_total: int = 16384,
    gpu_util: int | None = None,
) -> DailyReport:
    gpu_summary = []
    if gpu_util is not None:
        gpu_summary = [
            GPUSummaryRow(
                index=0,
                name="Tesla T4",
                utilization_percent=gpu_util,
                temperature_c=50,
                memory_used_mb=1024,
                memory_total_mb=4096,
            )
        ]
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
                    gpu_summary=gpu_summary,
                ),
            )
        ],
        subject_prefix="[Test]",
    )


def test_previous_week_range_returns_monday_to_sunday():
    # 2026-07-13 is Monday
    week_start, week_end = _previous_week_range(date(2026, 7, 13))
    assert week_start == date(2026, 7, 6)
    assert week_end == date(2026, 7, 12)

    # 2026-07-12 is Sunday
    week_start, week_end = _previous_week_range(date(2026, 7, 12))
    assert week_start == date(2026, 6, 29)
    assert week_end == date(2026, 7, 5)


def test_previous_week_range_uses_local_timezone():
    """A weekly run just after local midnight must pick the local week.

    Simulate ``now = 2026-07-13T00:30+08:00``.  Asia/Shanghai is already Monday
    07-13, so the previous week is 07-06..07-12.  The same instant is still
    Sunday 07-12 in UTC, where the old naive-UTC logic would (wrongly) pick
    06-29..07-05 -- asserted below to prove the timezone actually matters.
    """
    shanghai = ZoneInfo("Asia/Shanghai")
    now = datetime(2026, 7, 13, 0, 30, tzinfo=shanghai)

    # Sanity: the UTC calendar date lags a day behind the local date.
    assert now.astimezone(timezone.utc).date() == date(2026, 7, 12)

    local_start, local_end = _previous_week_range(tz=shanghai, now=now)
    assert (local_start, local_end) == (date(2026, 7, 6), date(2026, 7, 12))

    # Explicit UTC tz from the same instant reproduces the old wrong week.
    utc_start, utc_end = _previous_week_range(tz=timezone.utc, now=now)
    assert (utc_start, utc_end) == (date(2026, 6, 29), date(2026, 7, 5))


def test_generate_weekly_report_selects_week_in_local_tz(tmp_path: Path):
    """``generate_weekly_report`` threads tz into the previous-week selection."""
    shanghai = ZoneInfo("Asia/Shanghai")
    db_path = tmp_path / "servermanage.db"

    base_local = datetime(2026, 7, 6, 9, 0, tzinfo=shanghai)
    for day in range(7):
        when = (base_local + timedelta(days=day)).astimezone(timezone.utc)
        persist_host_reports(_make_report_at(when), db_path)

    report = generate_weekly_report(
        db_path,
        tz=shanghai,
        now=datetime(2026, 7, 13, 0, 30, tzinfo=shanghai),
    )

    assert report.week_start == date(2026, 7, 6)
    assert report.week_end == date(2026, 7, 12)
    assert len(report.summaries) == 1
    assert report.summaries[0].sample_count == 7


def test_compute_intensity_score_with_gpu():
    summary = type(
        "Summary",
        (),
        {
            "cpu_avg": 80.0,
            "memory_avg_percent": 60.0,
            "gpu_util_avg": 90.0,
        },
    )()
    assert _compute_intensity_score(summary) == round(80.0 * 0.5 + 60.0 * 0.3 + 90.0 * 0.2, 2)


def test_compute_intensity_score_without_gpu():
    summary = type(
        "Summary",
        (),
        {
            "cpu_avg": 80.0,
            "memory_avg_percent": 60.0,
            "gpu_util_avg": None,
        },
    )()
    # Re-normalized: (80*0.5 + 60*0.3) / 0.8 = 72.5
    assert _compute_intensity_score(summary) == 72.5


def test_generate_weekly_report_classifies_busy_and_idle(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    base = datetime(2026, 7, 6, 9, 0, 0, tzinfo=timezone.utc)

    # 7 days of high CPU/GPU -> busy
    for day in range(7):
        when = base + __import__("datetime").timedelta(days=day)
        persist_host_reports(
            _make_report_at(when, name="busy", cpu=85.0, memory_used=13000, gpu_util=95),
            db_path,
        )

    # 7 days of low CPU/no GPU -> idle
    for day in range(7):
        when = base + __import__("datetime").timedelta(days=day)
        persist_host_reports(
            _make_report_at(when, name="idle", cpu=5.0, memory_used=2048, gpu_util=None),
            db_path,
        )

    config = WeeklyReportConfig(busy_threshold=70.0, idle_threshold=20.0)
    report = generate_weekly_report(db_path, reference_date=date(2026, 7, 13), config=config)

    assert report.week_start == date(2026, 7, 6)
    assert report.week_end == date(2026, 7, 12)
    assert len(report.summaries) == 2

    busy_names = {h.host_name for h in report.busy_hosts}
    idle_names = {h.host_name for h in report.idle_hosts}
    assert "busy" in busy_names
    assert "idle" in idle_names


def test_generate_weekly_report_ignores_insufficient_data(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    base = datetime(2026, 7, 6, 9, 0, 0, tzinfo=timezone.utc)

    # Only 2 samples -> insufficient
    for day in range(2):
        when = base + __import__("datetime").timedelta(days=day)
        persist_host_reports(
            _make_report_at(when, name="sparse", cpu=95.0, memory_used=15000, gpu_util=95),
            db_path,
        )

    config = WeeklyReportConfig(busy_threshold=70.0, idle_threshold=20.0)
    report = generate_weekly_report(db_path, reference_date=date(2026, 7, 13), config=config)

    assert len(report.summaries) == 1
    assert report.busy_hosts == []
    assert report.idle_hosts == []
    assert report.summaries[0].sample_count == 2
