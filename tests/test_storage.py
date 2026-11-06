from datetime import date, datetime, timezone
from pathlib import Path

from servermanage.models import (
    DailyReport,
    DiskUsageRow,
    GPUSummaryRow,
    HostMetrics,
    HostReport,
    MemorySummary,
)
from servermanage.storage import (
    fetch_weekly_metrics,
    init_storage,
    persist_host_reports,
)


def _make_host_report(
    name: str,
    host: str,
    *,
    success: bool = True,
    cpu: float | None = 50.0,
    memory_used: int = 4096,
    memory_total: int = 16384,
    disk_percent: str = "30%",
    gpu_util: int | None = None,
    gpu_mem_used: int = 0,
    gpu_mem_total: int = 0,
    processes: int = 120,
    users: int = 2,
    load_1: float = 1.0,
    collected_at: datetime | None = None,
) -> HostReport:
    gpu_summary = []
    if gpu_util is not None:
        gpu_summary = [
            GPUSummaryRow(
                index=0,
                name="Tesla T4",
                utilization_percent=gpu_util,
                temperature_c=50,
                memory_used_mb=gpu_mem_used,
                memory_total_mb=gpu_mem_total,
            )
        ]
    return HostReport(
        host_name=name,
        host=host,
        success=success,
        metrics=HostMetrics(
            collected_at=collected_at or datetime.now(timezone.utc),
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
                    percent=disk_percent,
                    mountpoint="/",
                )
            ],
            total_processes=processes,
            logged_in_users=[],
            gpu_summary=gpu_summary,
        ),
    )


def test_init_storage_creates_database(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    assert not db_path.exists()

    init_storage(db_path)

    assert db_path.exists()
    with __import__("sqlite3").connect(db_path) as conn:
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='host_metrics_history'"
        )
        assert cursor.fetchone() is not None


def test_persist_host_reports_skips_failed_hosts(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    report = DailyReport(
        generated_at=datetime.now(timezone.utc),
        reports=[
            _make_host_report("busy", "10.0.0.1", cpu=80.0),
            HostReport(host_name="failed", host="10.0.0.2", success=False),
        ],
        subject_prefix="[Test]",
    )

    persist_host_reports(report, db_path)

    today = datetime.now(timezone.utc).date()
    metrics = fetch_weekly_metrics(db_path, today, today)
    with __import__("sqlite3").connect(db_path) as conn:
        cursor = conn.execute("SELECT host_name, cpu_usage_percent FROM host_metrics_history")
        data = {row[0]: row[1] for row in cursor.fetchall()}

    assert "busy" in data
    assert data["busy"] == 80.0
    assert "failed" not in data
    assert any(row["host_name"] == "busy" for row in metrics)


def test_fetch_weekly_metrics_aggregates_by_host(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    base = datetime(2026, 7, 6, 9, 0, 0, tzinfo=timezone.utc)
    reports = [
        _make_host_report("host-a", "10.0.0.1", cpu=30.0, memory_used=8192, collected_at=base),
        _make_host_report("host-a", "10.0.0.1", cpu=50.0, memory_used=8192, collected_at=base),
        _make_host_report("host-b", "10.0.0.2", cpu=10.0, memory_used=4096, collected_at=base),
    ]
    report = DailyReport(
        generated_at=base,
        reports=reports,
        subject_prefix="[Test]",
    )

    persist_host_reports(report, db_path)
    metrics = fetch_weekly_metrics(db_path, base.date(), base.date())

    assert len(metrics) == 2
    by_host = {row["host_name"]: row for row in metrics}
    assert by_host["host-a"]["sample_count"] == 2
    assert round(by_host["host-a"]["cpu_avg"], 1) == 40.0
    assert by_host["host-a"]["cpu_max"] == 50.0
    assert by_host["host-a"]["cpu_min"] == 30.0
    assert by_host["host-b"]["sample_count"] == 1
    assert round(by_host["host-b"]["cpu_avg"], 1) == 10.0


def test_fetch_weekly_metrics_returns_empty_when_database_missing(tmp_path: Path):
    db_path = tmp_path / "does-not-exist.db"
    assert fetch_weekly_metrics(db_path, __import__("datetime").date(2026, 7, 6), __import__("datetime").date(2026, 7, 12)) == []
