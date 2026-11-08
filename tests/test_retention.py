from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3

from servermanage.models import (
    DailyReport,
    HostMetrics,
    HostReport,
    MemorySummary,
)
from servermanage.storage import (
    fetch_daily_points_for_week,
    fetch_weekly_metrics,
    init_storage,
    persist_host_reports,
    prune_alert_history,
    prune_disk_health,
    prune_host_metrics,
    prune_ssh_audit,
)


def _report(
    name: str = "h1",
    *,
    cpu: float = 10.0,
    when: datetime | None = None,
    disk_percent: str = "30%",
) -> HostReport:
    return HostReport(
        host_name=name,
        host=f"{name}.example",
        success=True,
        metrics=HostMetrics(
            hostname=name,
            cpu_usage_percent=cpu,
            memory=MemorySummary(
                total_mb=16384,
                used_mb=4096,
                free_mb=12288,
                shared_mb=0,
                buff_cache_mb=0,
                available_mb=12288,
                swap_total_mb=0,
                swap_used_mb=0,
                swap_free_mb=0,
            ),
            disk_usage=[],
            collected_at=when or datetime(2026, 11, 8, 1, 0, tzinfo=timezone.utc),
        ),
        errors=[],
    )


def _persist(db: Path, rows: list[HostReport]) -> None:
    persist_host_reports(
        DailyReport(
            generated_at=datetime.now(timezone.utc),
            reports=rows,
            subject_prefix="x",
        ),
        db,
    )


def test_daily_summary_accumulates_and_weekly_uses_it_after_prune(tmp_path: Path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    _persist(db, [_report(cpu=10), _report(cpu=20), _report(cpu=30)])
    with sqlite3.connect(db) as conn:
        row = conn.execute(
            "SELECT sample_count, cpu_sum, cpu_max, cpu_min FROM host_daily_summary"
        ).fetchone()
    assert row == (3, 60.0, 30.0, 10.0)

    removed = prune_host_metrics(db, 2)
    assert removed == 1
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM host_metrics_history").fetchone()[0] == 2
    day = datetime(2026, 11, 8, tzinfo=timezone.utc).date()
    daily = fetch_daily_points_for_week(db, day, day)
    assert len(daily) == 1
    assert daily[0]["cpu_avg"] == 20.0
    weekly = fetch_weekly_metrics(db, day, day)
    assert len(weekly) == 1
    assert weekly[0]["cpu_avg"] == 20.0
    assert weekly[0]["sample_count"] == 3


def test_prune_host_metrics_keeps_newest_n_per_host(tmp_path: Path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    for i in range(5):
        _persist(db, [_report(name="a", cpu=float(i))])
    for i in range(3):
        _persist(db, [_report(name="b", cpu=float(i))])
    prune_host_metrics(db, 2)
    with sqlite3.connect(db) as conn:
        counts = dict(
            conn.execute(
                "SELECT host_name, COUNT(*) FROM host_metrics_history GROUP BY host_name"
            ).fetchall()
        )
    assert counts == {"a": 2, "b": 2}


def test_prune_disk_health_removes_headers_and_orphan_details(tmp_path: Path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    now = datetime(2026, 11, 8, tzinfo=timezone.utc)
    with sqlite3.connect(db) as conn:
        for i in range(8):
            stamp = (now - timedelta(days=i)).isoformat()
            conn.execute(
                "INSERT INTO disk_health_snapshot(host_name,collected_at,status,message)"
                " VALUES ('a',?,'ok','')",
                (stamp,),
            )
            conn.execute(
                "INSERT INTO disk_pd_snapshot(collected_at,host_name,slot,health)"
                " VALUES (?, 'a', 0, 'healthy')",
                (stamp,),
            )
        conn.commit()
    counts = prune_disk_health(db, retention_days=7, max_batches_per_host=5, now=now)
    assert counts["disk_health_snapshot"] == 3
    with sqlite3.connect(db) as conn:
        headers = conn.execute("SELECT COUNT(*) FROM disk_health_snapshot").fetchone()[0]
        details = conn.execute("SELECT COUNT(*) FROM disk_pd_snapshot").fetchone()[0]
        orphans = conn.execute(
            "SELECT COUNT(*) FROM disk_pd_snapshot d WHERE NOT EXISTS ("
            "SELECT 1 FROM disk_health_snapshot h WHERE h.host_name=d.host_name"
            " AND h.collected_at=d.collected_at)"
        ).fetchone()[0]
    assert headers == 5
    assert details == 5
    assert orphans == 0


def test_prune_alert_history_only_removes_old_resolved(tmp_path: Path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    now = datetime(2026, 11, 8, tzinfo=timezone.utc)
    old = (now - timedelta(days=40)).isoformat()
    recent = now.isoformat()
    with sqlite3.connect(db) as conn:
        conn.executemany(
            "INSERT INTO alerts(created_at,host_name,category,severity,title,message,fingerprint,status)"
            " VALUES (?,?,?,?,?,?,?,?)",
            [
                (old, "a", "cpu", "warning", "t", "m", "f1", "resolved"),
                (old, "a", "cpu", "warning", "t", "m", "f2", "active"),
                (recent, "a", "cpu", "warning", "t", "m", "f3", "resolved"),
            ],
        )
        conn.commit()
    assert prune_alert_history(db, 30, now=now) == 1
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0] == 2


def test_prune_ssh_audit_keeps_active_sessions(tmp_path: Path):
    db = tmp_path / "monitor.db"
    init_storage(db)
    now = datetime(2026, 11, 8, tzinfo=timezone.utc)
    old = (now - timedelta(days=40)).isoformat()
    with sqlite3.connect(db) as conn:
        conn.executemany(
            "INSERT INTO ssh_audit_sessions(host_name,username,server_username,remote_addr,started_at,ended_at,status)"
            " VALUES ('a','admin','u','127.0.0.1',?,?,?)",
            [(old, old, "closed"), (old, None, "active")],
        )
        conn.commit()
    assert prune_ssh_audit(db, 30, now=now) == 1
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM ssh_audit_sessions").fetchone()[0] == 1
