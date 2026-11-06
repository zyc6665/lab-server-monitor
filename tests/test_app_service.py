"""Tests for the service entrypoint and orchestration (Task 12).

Covers the controller-amendment split between status and disk polling, alert
resolution, scheduler task registration, report sending/ skipping, and the
``--help`` path of the CLI.

Note: these tests deliberately inject the SSH-bound collectors, the report
renderer/sender, and the scheduler factory so that nothing here touches a real
host, SMTP server, or background thread.
"""

from __future__ import annotations

import sqlite3
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from servermanage import app as app_module
from servermanage.app import MonitorService, load_runtime
from servermanage.disk_health import DiskHealthReport, PhysicalDriveInfo
from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DiskUsageRow,
    HostConfig,
    HostMetrics,
    HostReport,
    RenderedReport,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
    StorageConfig,
    WeeklyReport,
    WeeklyReportConfig,
)
from servermanage.storage import get_disk_health, get_host_snapshot, list_alerts


# ---------------------------------------------------------------------------
# Test doubles and helpers
# ---------------------------------------------------------------------------


class FakeNotifier:
    """Records dispatched events instead of talking to the OS/SMTP/webhook."""

    def __init__(self) -> None:
        self.events = []

    def dispatch(self, event, config):
        self.events.append(event)
        return ["fake"]


class FakeScheduler:
    """Stand-in for :class:`servermanage.scheduler.Scheduler`.

    Records the tasks it was constructed with so a test can assert task names
    and intervals without starting a real background thread.
    """

    def __init__(self, tasks, *, db_path, tz, clock=None):
        self.tasks = list(tasks)
        self.db_path = db_path
        self.tz = tz
        self.clock = clock
        self.started = False
        self.stopped = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True


def _make_config(
    *,
    smtp: SMTPConfig | None = None,
    daily_enabled: bool = True,
    weekly_enabled: bool = True,
    timezone_name: str = "Asia/Shanghai",
) -> AppConfig:
    return AppConfig(
        smtp=smtp,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(
            subject_prefix="[Test Daily]",
            daily_enabled=daily_enabled,
            daily_time="09:00",
            weekly=WeeklyReportConfig(enabled=weekly_enabled, time="16:00"),
        ),
        servers=[
            HostConfig(
                name="gpu-01",
                host="10.0.0.1",
                port=22,
                username="root",
                auth=AuthConfig(type="password", password="secret"),
            )
        ],
        storage=StorageConfig(enabled=True, db_path=Path("unused.db")),
        app=AppRuntimeConfig(
            poll_interval_seconds=600,
            disk_poll_interval_seconds=86400,
            retention_days=90,
            timezone=timezone_name,
        ),
    )


def _success_report(name: str = "gpu-01") -> HostReport:
    return HostReport(
        host_name=name,
        host="10.0.0.1",
        success=True,
        metrics=HostMetrics(
            collected_at=datetime.now(timezone.utc),
            cpu_usage_percent=5.0,
        ),
    )


def _warning_disk_report(name: str = "gpu-01") -> DiskHealthReport:
    return DiskHealthReport(
        host_name=name,
        collected_at=datetime.now(timezone.utc),
        status="ok",
        physical_drives=[
            PhysicalDriveInfo(
                controller=0,
                enclosure=32,
                slot=0,
                did=1,
                model="ST1000",
                media_errors=3,
                health="warning",
                reasons=["media_errors"],
            )
        ],
    )


def _count_rows(db_path: Path, table: str) -> int:
    with sqlite3.connect(db_path) as conn:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


# ---------------------------------------------------------------------------
# run_once / run_status_once / run_disk_once
# ---------------------------------------------------------------------------


def test_run_once_collects_status_and_disk(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [_success_report()],
        collect_disk=lambda host, runner, **kwargs: _warning_disk_report(host.name),
        notifier=notifier,
    )

    result = service.run_once()

    assert result == {"hosts": 1, "disk_reports": 1, "alerts": 1}
    assert get_host_snapshot("gpu-01", db_path) is not None
    assert get_disk_health("gpu-01", db_path) is not None
    assert len(notifier.events) == 1
    assert notifier.events[0].category == "disk"
    assert _count_rows(db_path, "host_metrics_history") == 1


def _failure_report(name: str = "gpu-01") -> HostReport:
    return HostReport(host_name=name, host="10.0.0.1", success=False)


def _disk_report(
    percent: str,
    *,
    filesystem: str = "/dev/sda1",
    name: str = "gpu-01",
) -> HostReport:
    return HostReport(
        host_name=name,
        host="10.0.0.1",
        success=True,
        metrics=HostMetrics(
            collected_at=datetime.now(timezone.utc),
            disk_usage=[
                DiskUsageRow(
                    filesystem=filesystem,
                    size="100G",
                    used="50G",
                    available="50G",
                    percent=percent,
                    mountpoint="/",
                )
            ],
        ),
    )


def test_run_status_once_debounces_offline_alert_until_threshold(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    service = MonitorService(
        _make_config(),  # AlertsConfig.offline_failures defaults to 2
        db_path=db_path,
        collect_status=lambda config: [_failure_report()],
        notifier=notifier,
    )

    resolve_calls = []
    service.engine.resolve_missing = (
        lambda host, fps, category=None: resolve_calls.append(
            (host, set(fps), category)
        )
    )

    first = service.run_status_once()
    assert first == {"hosts": 1, "alerts": 0}
    assert notifier.events == []
    assert list_alerts(db_path) == []
    assert resolve_calls == [("gpu-01", set(), "system")]

    second = service.run_status_once()
    assert second == {"hosts": 1, "alerts": 1}
    assert len(notifier.events) == 1
    assert notifier.events[0].category == "offline"
    assert resolve_calls[-1] == ("gpu-01", {"offline:gpu-01"}, "system")
    assert [row["fingerprint"] for row in list_alerts(db_path)] == ["offline:gpu-01"]


def test_offline_counter_resets_after_success(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter(
        [_failure_report(), _success_report(), _failure_report(), _failure_report()]
    )
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [next(reports)],
        notifier=notifier,
    )

    results = [service.run_status_once() for _ in range(4)]

    assert [result["alerts"] for result in results] == [0, 0, 0, 1]
    assert len(notifier.events) == 1
    assert notifier.events[0].category == "offline"
    # A success after a single failure must not emit a recovery notification.
    assert all(
        event.fingerprint != "recovery:gpu-01:offline" for event in notifier.events
    )


def test_recovery_notification_after_offline_recovers(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter(
        [_failure_report(), _failure_report(), _success_report()]
    )
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [next(reports)],
        notifier=notifier,
    )

    results = [service.run_status_once() for _ in range(3)]

    assert [result["alerts"] for result in results] == [0, 1, 1]
    assert [event.category for event in notifier.events] == ["offline", "offline"]
    recovery = notifier.events[1]
    assert recovery.fingerprint == "recovery:gpu-01:offline"
    assert recovery.severity == "info"


def test_run_status_once_raises_disk_usage_alert(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [_disk_report("95%")],
        notifier=notifier,
    )

    result = service.run_status_once()

    assert result == {"hosts": 1, "alerts": 1}
    assert len(notifier.events) == 1
    assert notifier.events[0].category == "system"
    assert notifier.events[0].fingerprint == "system:gpu-01:disk"


def test_run_status_once_ignores_disk_usage_below_threshold(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [_disk_report("50%")],
        notifier=notifier,
    )

    result = service.run_status_once()

    assert result == {"hosts": 1, "alerts": 0}
    assert notifier.events == []


def test_run_status_once_ignores_virtual_filesystems_for_disk_alert(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [_disk_report("95%", filesystem="tmpfs")],
        notifier=notifier,
    )

    result = service.run_status_once()

    assert result == {"hosts": 1, "alerts": 0}
    assert notifier.events == []


def test_run_status_once_resolves_for_successful_host(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [_success_report()],
        notifier=FakeNotifier(),
    )

    resolve_calls = []
    service.engine.resolve_missing = (
        lambda host, fps, category=None: resolve_calls.append(
            (host, set(fps), category)
        )
    )

    result = service.run_status_once()

    assert result == {"hosts": 1, "alerts": 0}
    # Every host must be reconciled each cycle, even when it has no active alert.
    assert resolve_calls == [("gpu-01", set(), "system")]


def test_run_disk_once_generates_disk_alert_and_resolves(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [],
        collect_disk=lambda host, runner, **kwargs: _warning_disk_report(host.name),
        notifier=notifier,
    )

    resolve_calls = []
    service.engine.resolve_missing = (
        lambda host, fps, category=None: resolve_calls.append(
            (host, set(fps), category)
        )
    )

    result = service.run_disk_once()

    assert result == {"disk_reports": 1, "alerts": 1}
    assert len(notifier.events) == 1
    assert notifier.events[0].category == "disk"
    assert get_disk_health("gpu-01", db_path) is not None
    assert resolve_calls == [
        ("gpu-01", {notifier.events[0].fingerprint}, "disk")
    ]


# ---------------------------------------------------------------------------
# start() / scheduler wiring
# ---------------------------------------------------------------------------


def test_start_registers_expected_tasks(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    created = {}

    def factory(tasks, *, db_path, tz, clock=None):
        scheduler = FakeScheduler(tasks, db_path=db_path, tz=tz, clock=clock)
        created["scheduler"] = scheduler
        return scheduler

    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [],
        collect_disk=lambda host, runner, **kwargs: _warning_disk_report(host.name),
        notifier=FakeNotifier(),
        scheduler_factory=factory,
    )

    service.start()

    scheduler = created["scheduler"]
    assert scheduler.started is True
    assert [task.name for task in scheduler.tasks] == [
        "status_poll",
        "disk_poll",
        "daily_report",
        "weekly_report",
        "purge",
    ]
    by_name = {task.name: task for task in scheduler.tasks}
    assert by_name["status_poll"].interval_seconds == 600
    assert by_name["disk_poll"].interval_seconds == 86400
    assert by_name["daily_report"].interval_seconds == 0
    assert by_name["weekly_report"].interval_seconds == 0
    assert by_name["purge"].interval_seconds == 86400
    assert by_name["daily_report"].target_time is not None
    assert by_name["weekly_report"].target_time is not None
    assert getattr(scheduler.tz, "key", None) == "Asia/Shanghai"

    service.stop()
    assert scheduler.stopped is True


def test_start_skips_disabled_report_tasks(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    created = {}

    def factory(tasks, *, db_path, tz, clock=None):
        scheduler = FakeScheduler(tasks, db_path=db_path, tz=tz, clock=clock)
        created["scheduler"] = scheduler
        return scheduler

    service = MonitorService(
        _make_config(daily_enabled=False, weekly_enabled=False),
        db_path=db_path,
        collect_status=lambda config: [],
        collect_disk=lambda host, runner, **kwargs: _warning_disk_report(host.name),
        notifier=FakeNotifier(),
        scheduler_factory=factory,
    )

    service.start()

    names = [task.name for task in created["scheduler"].tasks]
    assert names == ["status_poll", "disk_poll", "purge"]


# ---------------------------------------------------------------------------
# Report jobs
# ---------------------------------------------------------------------------


def test_run_daily_report_skips_sending_when_smtp_none(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    sent = []
    service = MonitorService(
        _make_config(smtp=None),
        db_path=db_path,
        collect_status=lambda config: [_success_report()],
        collect_disk=lambda host, runner, **kwargs: _warning_disk_report(host.name),
        notifier=FakeNotifier(),
        render_report=lambda report, variant="technical": RenderedReport(
            subject="s", text_body="t", html_body="h"
        ),
        send_report=lambda *args, **kwargs: sent.append((args, kwargs)),
    )

    service.run_daily_report()  # must not raise

    assert sent == []
    # History is still written even when sending is skipped.
    assert _count_rows(db_path, "host_metrics_history") == 1


def test_run_daily_report_sends_executive_copy(tmp_path: Path):
    from servermanage.models import ExecutiveReportConfig

    db_path = tmp_path / "monitor.db"
    sent = []
    config = _make_config(
        smtp=SMTPConfig(
            host="smtp.example.com",
            port=465,
            username="u",
            password="p",
            use_ssl=True,
            from_addr="from@example.com",
            to_addrs=["to@example.com"],
        )
    )
    config = replace(
        config,
        report=replace(
            config.report,
            executive=ExecutiveReportConfig(
                enabled=True,
                subject_prefix="[Leader]",
                to_addrs=["boss@example.com"],
            ),
        ),
    )
    service = MonitorService(
        config,
        db_path=db_path,
        collect_status=lambda cfg: [_success_report()],
        collect_disk=lambda host, runner, **kwargs: _warning_disk_report(host.name),
        notifier=FakeNotifier(),
        render_report=lambda report, variant="technical": RenderedReport(
            subject=report.subject_prefix, text_body="t", html_body="h"
        ),
        send_report=lambda smtp, report, to_addrs=None: sent.append(
            (report.subject, to_addrs)
        ),
    )

    service.run_daily_report()

    assert sent == [("[Test Daily]", None), ("[Leader]", ["boss@example.com"])]


def test_run_weekly_report_passes_timezone(tmp_path: Path):
    from datetime import date

    db_path = tmp_path / "monitor.db"
    captured = {}
    rendered = []
    sent = []
    config = _make_config(smtp=None, timezone_name="Asia/Shanghai")

    def fake_generate(db_path, *, config=None, tz=None, now=None, reference_date=None):
        captured["db_path"] = db_path
        captured["weekly_config"] = config
        captured["tz"] = tz
        return WeeklyReport(
            generated_at=datetime.now(timezone.utc),
            week_start=date(2026, 7, 6),
            week_end=date(2026, 7, 12),
            summaries=[],
            busy_hosts=[],
            idle_hosts=[],
            subject_prefix="[Server Weekly Report]",
        )

    service = MonitorService(
        config,
        db_path=db_path,
        collect_status=lambda cfg: [],
        collect_disk=lambda host, runner, **kwargs: _warning_disk_report(host.name),
        notifier=FakeNotifier(),
        generate_weekly_report=fake_generate,
        render_report=lambda report, variant="technical": (
            rendered.append(variant) or RenderedReport("s", "t", "h")
        ),
        send_report=lambda *args, **kwargs: sent.append((args, kwargs)),
    )

    service.run_weekly_report()

    assert captured["db_path"] == db_path
    assert captured["weekly_config"] is config.report.weekly
    assert getattr(captured["tz"], "key", None) == "Asia/Shanghai"
    assert rendered == ["weekly"]
    assert sent == []


# ---------------------------------------------------------------------------
# load_runtime / main
# ---------------------------------------------------------------------------


def test_load_runtime_initialises_storage(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "data" / "monitor.db"
    config = replace(
        _make_config(), storage=StorageConfig(enabled=True, db_path=db_path)
    )
    monkeypatch.setattr(app_module, "load_config", lambda path: config)

    loaded_config, loaded_db_path = load_runtime(tmp_path / "config.yaml", None)

    assert loaded_config is config
    assert loaded_db_path == db_path
    assert db_path.exists()


def test_main_help_returns_zero():
    assert app_module.main(["--help"]) == 0
