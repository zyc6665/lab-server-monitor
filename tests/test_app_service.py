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
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import app as app_module
from servermanage import storage
from servermanage.alerts import SilenceRegistry
from servermanage.app import MonitorService, load_runtime, load_runtime_with_settings
from servermanage.disk_health import DiskHealthReport, PhysicalDriveInfo
from servermanage.models import (
    AlertsConfig,
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DiskHealthConfig,
    DiskUsageRow,
    HostAlertRules,
    HostCheckConfig,
    HostCheckResult,
    HostConfig,
    HostDiskHealthOverride,
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
from servermanage.storage import (
    get_disk_health,
    get_host_check_results,
    get_host_snapshot,
    init_storage,
    list_alerts,
    save_disk_health,
)


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
        # The pre-Task-6 suite asserted alerts fire on the first bad cycle.
        # Consecutive-period behaviour is exercised explicitly by the Task 6
        # tests, which override this back to 2 (the production default).
        alerts=AlertsConfig(consecutive_periods=1),
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


def _config_with_checks(checks) -> AppConfig:
    config = _make_config()
    host = replace(config.servers[0], checks=list(checks))
    return replace(config, servers=[host])


def test_run_status_once_persists_successful_check_results(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    check = HostCheckConfig(
        name="API", type="http", target="http://127.0.0.1:8000/health"
    )
    result = HostCheckResult(
        name="API",
        type="http",
        target=check.target,
        status="ok",
        message="HTTP 200",
        latency_ms=12.0,
        checked_at=datetime.now(timezone.utc),
    )
    service = MonitorService(
        _config_with_checks([check]),
        db_path=db_path,
        collect_status=lambda config: [
            HostReport(
                host_name="gpu-01",
                host="10.0.0.1",
                success=True,
                metrics=HostMetrics(collected_at=datetime.now(timezone.utc)),
                checks=[result],
            )
        ],
        notifier=FakeNotifier(),
    )

    service.run_status_once()

    rows = get_host_check_results("gpu-01", db_path)
    assert [row["check_name"] for row in rows] == ["API"]
    assert rows[0]["status"] == "ok"


def test_run_status_once_marks_failed_host_checks_unknown(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    check = HostCheckConfig(name="API", type="tcp", target="8000")
    ok_result = HostCheckResult(
        name="API",
        type="tcp",
        target="8000",
        status="ok",
        message="端口可连接",
        checked_at=datetime.now(timezone.utc),
    )
    reports = iter(
        [
            HostReport(
                host_name="gpu-01",
                host="10.0.0.1",
                success=True,
                metrics=HostMetrics(collected_at=datetime.now(timezone.utc)),
                checks=[ok_result],
            ),
            HostReport(host_name="gpu-01", host="10.0.0.1", success=False),
        ]
    )
    service = MonitorService(
        _config_with_checks([check]),
        db_path=db_path,
        collect_status=lambda config: [next(reports)],
        notifier=FakeNotifier(),
    )

    service.run_status_once()
    assert get_host_check_results("gpu-01", db_path)[0]["status"] == "ok"

    service.run_status_once()
    rows = get_host_check_results("gpu-01", db_path)
    # Old "ok" row is replaced (not duplicated) so a stale healthy status cannot
    # survive a failed collection cycle.
    assert len(rows) == 1
    assert rows[0]["status"] == "unknown"


def test_run_status_once_survives_check_result_save_failure(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "monitor.db"

    def boom(*_args, **_kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr("servermanage.app.save_host_check_results", boom)
    service = MonitorService(
        _config_with_checks(
            [HostCheckConfig(name="API", type="tcp", target="8000")]
        ),
        db_path=db_path,
        collect_status=lambda config: [_success_report()],
        notifier=FakeNotifier(),
    )

    result = service.run_status_once()

    assert result == {"hosts": 1, "alerts": 0}


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
        lambda host, fps, category=None, notify=None: resolve_calls.append(
            (host, set(fps), category)
        )
    )

    first = service.run_status_once()
    assert first == {"hosts": 1, "alerts": 0}
    assert notifier.events == []
    assert list_alerts(db_path) == []
    # A failed host has no fresh metrics, so system alerts must not be
    # reconciled for it (that would emit a bogus "system recovered" notice).
    assert resolve_calls == []

    second = service.run_status_once()
    assert second == {"hosts": 1, "alerts": 1}
    assert len(notifier.events) == 1
    assert notifier.events[0].category == "offline"
    assert resolve_calls == []
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
    # Disk capacity is monitored per configured mount, so the fingerprint now
    # carries the mount point (the "/" row in _disk_report is at 95%).
    assert notifier.events[0].fingerprint == "system:gpu-01:disk:/"


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
        lambda host, fps, category=None, notify=None: resolve_calls.append(
            (host, set(fps), category)
        )
    )

    result = service.run_status_once()

    assert result == {"hosts": 1, "alerts": 0}
    # Every host must be reconciled each cycle, even when it has no active alert.
    # Task 6 reconciles both system and availability categories.
    assert resolve_calls == [
        ("gpu-01", set(), "system"),
        ("gpu-01", set(), "availability"),
    ]


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
        lambda host, fps, category=None, notify=None: resolve_calls.append(
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


def test_run_disk_once_passes_previous_baseline_and_temperature(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    save_disk_health(
        DiskHealthReport(
            host_name="gpu-01",
            collected_at=datetime.now(timezone.utc),
            status="ok",
            physical_drives=[
                PhysicalDriveInfo(
                    controller=0,
                    enclosure=32,
                    slot=0,
                    did=1,
                    media_errors=1,
                    health="healthy",
                )
            ],
        ),
        db_path,
    )
    seen = {}

    def collect(host, runner, **kwargs):
        seen.update(kwargs)
        return _warning_disk_report(host.name)

    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [],
        collect_disk=collect,
        notifier=FakeNotifier(),
    )

    service.run_disk_once()

    previous = seen["previous"]
    assert previous is not None
    assert previous.physical_drives[0].media_errors == 1
    assert seen["temperature_threshold_c"] == 55.0


def test_previous_disk_report_ignores_non_ok_or_empty_baselines(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)

    save_disk_health(
        DiskHealthReport(
            host_name="gpu-01",
            collected_at=datetime.now(timezone.utc),
            status="permission_denied",
            physical_drives=[],
        ),
        db_path,
    )
    assert app_module._previous_disk_report("gpu-01", db_path) is None

    save_disk_health(
        DiskHealthReport(
            host_name="gpu-01",
            collected_at=datetime.now(timezone.utc),
            status="ok",
            physical_drives=[],
        ),
        db_path,
    )
    assert app_module._previous_disk_report("gpu-01", db_path) is None


def test_run_disk_once_skips_host_disabled_disk_health(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    config = replace(
        _make_config(),
        servers=[
            replace(
                _make_config().servers[0],
                disk_health=HostDiskHealthOverride(enabled=False),
            )
        ],
    )
    called = []

    def collect(host, runner, **kwargs):
        called.append(host.name)
        return _warning_disk_report(host.name)

    service = MonitorService(
        config,
        db_path=db_path,
        collect_status=lambda config: [],
        collect_disk=collect,
        notifier=FakeNotifier(),
    )

    result = service.run_disk_once()

    assert result == {"disk_reports": 0, "alerts": 0}
    assert called == []
    assert get_disk_health("gpu-01", db_path) is None


def test_run_disk_once_globally_disabled_does_not_connect(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    config = replace(_make_config(), disk_health=DiskHealthConfig(enabled=False))
    called = []

    def collect(host, runner, **kwargs):
        called.append(host.name)
        return _warning_disk_report(host.name)

    service = MonitorService(
        config,
        db_path=db_path,
        collect_status=lambda config: [],
        collect_disk=collect,
        notifier=FakeNotifier(),
    )

    assert service.run_disk_once() == {"disk_reports": 0, "alerts": 0}
    assert called == []


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
        "retention_cleanup",
    ]
    by_name = {task.name: task for task in scheduler.tasks}
    assert by_name["status_poll"].interval_seconds == 600
    assert by_name["disk_poll"].interval_seconds == 86400
    assert by_name["daily_report"].interval_seconds == 0
    assert by_name["weekly_report"].interval_seconds == 0
    assert by_name["retention_cleanup"].interval_seconds == 3600
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
    assert names == ["status_poll", "disk_poll", "retention_cleanup"]


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


# ---------------------------------------------------------------------------
# Task 12: settings service wiring and hot config application
# ---------------------------------------------------------------------------


def test_apply_config_updates_scheduler_interval(tmp_path: Path):
    service = MonitorService(_make_config(), db_path=tmp_path / "m.db")
    new = replace(
        service.config,
        app=replace(service.config.app, poll_interval_seconds=120),
    )

    service.apply_config(new)

    assert service.config.app.poll_interval_seconds == 120
    assert service._build_tasks()[0].interval_seconds == 120


def test_apply_config_rebuilds_notifier_and_engine(tmp_path: Path):
    service = MonitorService(_make_config(), db_path=tmp_path / "m.db")
    old_engine = service.engine

    service.apply_config(
        replace(service.config, alerts=replace(service.config.alerts, enabled=False))
    )

    assert service.engine is not old_engine


def test_apply_config_restarts_running_scheduler(tmp_path: Path):
    created = []

    def factory(tasks, *, db_path, tz, clock=None):
        scheduler = FakeScheduler(tasks, db_path=db_path, tz=tz, clock=clock)
        created.append(scheduler)
        return scheduler

    service = MonitorService(
        _make_config(),
        db_path=tmp_path / "m.db",
        collect_status=lambda config: [],
        collect_disk=lambda host, runner, **kwargs: _warning_disk_report(host.name),
        notifier=FakeNotifier(),
        scheduler_factory=factory,
    )
    service.start()

    service.apply_config(
        replace(service.config, app=replace(service.config.app, poll_interval_seconds=120))
    )

    assert created[0].stopped is True
    assert created[1].started is True
    assert created[1].tasks[0].interval_seconds == 120
    service.stop()


def test_load_runtime_with_settings_returns_service(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DASHBOARD_PASSWORD", "Pass!23")
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "storage:\n  db_path: " + str(tmp_path / "runtime.db").replace("\\", "/") + "\nservers: []\n",
        encoding="utf-8",
    )

    config, db_path, settings = load_runtime_with_settings(cfg)

    assert db_path.exists()
    assert settings is not None
    assert settings.public_settings()["writable"] is True


def test_weekly_task_uses_configured_weekday(tmp_path: Path):
    from datetime import datetime as _dt

    config = _make_config()
    config = replace(
        config,
        report=replace(
            config.report,
            weekly=replace(config.report.weekly, weekday=1, time="16:00"),
        ),
    )
    service = MonitorService(config, db_path=tmp_path / "m.db")
    weekly = [task for task in service._build_tasks() if task.name == "weekly_report"][0]

    target = weekly.target_time(_dt(2026, 11, 2, 10, 0))  # Monday

    assert target.weekday() == 1
    assert (target.hour, target.minute) == (16, 0)


# ---------------------------------------------------------------------------
# Task 6: silence registry + recovery notification wiring
# ---------------------------------------------------------------------------


def _config_with_group(group: str = "lab") -> AppConfig:
    base = _make_config()
    return replace(base, servers=[replace(base.servers[0], group=group)])


def test_service_engine_wires_silence_registry_and_host_groups(tmp_path: Path):
    service = MonitorService(
        _config_with_group("lab"),
        db_path=tmp_path / "monitor.db",
        notifier=FakeNotifier(),
    )

    assert isinstance(service.engine._silence_checker, SilenceRegistry)
    assert service.engine._host_groups == {"gpu-01": ["lab"]}


def test_apply_config_rebuilds_silence_registry_and_host_groups(tmp_path: Path):
    service = MonitorService(
        _config_with_group("lab"),
        db_path=tmp_path / "monitor.db",
        notifier=FakeNotifier(),
    )
    old_registry = service.engine._silence_checker

    service.apply_config(_config_with_group("prod"))

    assert isinstance(service.engine._silence_checker, SilenceRegistry)
    assert service.engine._silence_checker is not old_registry
    assert service.engine._host_groups == {"gpu-01": ["prod"]}


def test_group_silence_suppresses_alert_through_service(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    service = MonitorService(
        _config_with_group("lab"),
        db_path=db_path,
        collect_status=lambda config: [_disk_report("95%")],
        notifier=notifier,
    )
    now = datetime.now(timezone.utc)
    storage.insert_silence(
        "group",
        "lab",
        "maintenance",
        now - timedelta(hours=1),
        now + timedelta(hours=1),
        "tester",
        db_path,
    )

    result = service.run_status_once()

    assert result == {"hosts": 1, "alerts": 0}
    assert notifier.events == []
    assert list_alerts(db_path) == []


def test_condition_renotifies_after_silence_ends(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    service = MonitorService(
        _config_with_group("lab"),
        db_path=db_path,
        collect_status=lambda config: [_disk_report("95%")],
        notifier=notifier,
    )
    now = datetime.now(timezone.utc)
    silence_id = storage.insert_silence(
        "group",
        "lab",
        "maintenance",
        now - timedelta(hours=1),
        now + timedelta(hours=1),
        "tester",
        db_path,
    )

    silenced = service.run_status_once()
    assert silenced == {"hosts": 1, "alerts": 0}
    assert notifier.events == []
    # A suppressed condition must not be persisted, or the cooldown would keep
    # hiding it once the maintenance window closes.
    assert list_alerts(db_path) == []

    assert storage.delete_silence(silence_id, db_path) is True
    after = service.run_status_once()

    assert after == {"hosts": 1, "alerts": 1}
    assert [event.fingerprint for event in notifier.events] == [
        "system:gpu-01:disk:/"
    ]
    assert [row["fingerprint"] for row in list_alerts(db_path)] == [
        "system:gpu-01:disk:/"
    ]


def test_offline_recovery_resolves_alert_and_notifies(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter([_failure_report(), _failure_report(), _success_report()])
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: [next(reports)],
        notifier=notifier,
    )

    results = [service.run_status_once() for _ in range(3)]

    assert [result["alerts"] for result in results] == [0, 1, 1]
    statuses = {
        row["fingerprint"]: row["status"] for row in list_alerts(db_path)
    }
    assert statuses["offline:gpu-01"] == "resolved"
    assert statuses["recovery:gpu-01:offline"] == "active"


def _statuses(db_path: Path) -> dict[str, str]:
    return {row["fingerprint"]: row["status"] for row in list_alerts(db_path)}


def test_failed_host_does_not_resolve_system_alerts(tmp_path: Path):
    """A host that went dark must not have its system alerts closed."""
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter([[_disk_report("95%")], [_failure_report()]])
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: next(reports),
        notifier=notifier,
    )

    first = service.run_status_once()
    assert first == {"hosts": 1, "alerts": 1}
    assert _statuses(db_path)["system:gpu-01:disk:/"] == "active"
    events_before = list(notifier.events)

    second = service.run_status_once()
    assert second == {"hosts": 1, "alerts": 0}
    # No spurious "system recovered" notice while the host is unreachable...
    assert notifier.events == events_before
    assert all(
        event.fingerprint != "recovery:gpu-01:system" for event in notifier.events
    )
    # ...and the pre-existing alert stays open.
    assert _statuses(db_path)["system:gpu-01:disk:/"] == "active"


def test_missing_host_does_not_resolve_system_alerts(tmp_path: Path):
    """A host absent from this round's reports must not have alerts closed."""
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter([[_disk_report("95%")], []])
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: next(reports),
        notifier=notifier,
    )

    first = service.run_status_once()
    assert first == {"hosts": 1, "alerts": 1}

    second = service.run_status_once()
    assert second == {"hosts": 0, "alerts": 0}
    assert all(
        event.fingerprint != "recovery:gpu-01:system" for event in notifier.events
    )
    assert _statuses(db_path)["system:gpu-01:disk:/"] == "active"


def test_successful_host_system_recovery_is_notified_and_counted(tmp_path: Path):
    """System recoveries use the same count semantics as offline ones."""
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter([[_disk_report("95%")], [_disk_report("50%")]])
    service = MonitorService(
        _make_config(),
        db_path=db_path,
        collect_status=lambda config: next(reports),
        notifier=notifier,
    )

    first = service.run_status_once()
    assert first == {"hosts": 1, "alerts": 1}

    second = service.run_status_once()
    assert second == {"hosts": 1, "alerts": 1}
    assert [event.fingerprint for event in notifier.events] == [
        "system:gpu-01:disk:/",
        "recovery:gpu-01:system",
    ]
    assert _statuses(db_path)["system:gpu-01:disk:/"] == "resolved"
    assert _statuses(db_path)["recovery:gpu-01:system"] == "active"


# ---------------------------------------------------------------------------
# Task 6: per-host thresholds + consecutive periods
# ---------------------------------------------------------------------------


def _config_with_periods(
    periods: int,
    *,
    rules: HostAlertRules | None = None,
    checks=None,
) -> AppConfig:
    """Build a single-host config with an explicit consecutive-period count."""
    config = _make_config()
    config = replace(
        config, alerts=replace(config.alerts, consecutive_periods=periods)
    )
    host = replace(
        config.servers[0], alert_rules=rules, checks=list(checks or [])
    )
    return replace(config, servers=[host])


def _cpu_report(value: float, name: str = "gpu-01") -> HostReport:
    return HostReport(
        host_name=name,
        host="10.0.0.1",
        success=True,
        metrics=HostMetrics(
            collected_at=datetime.now(timezone.utc),
            cpu_usage_percent=value,
        ),
    )


def _check_report(status: str, name: str = "gpu-01") -> HostReport:
    return HostReport(
        host_name=name,
        host="10.0.0.1",
        success=True,
        metrics=HostMetrics(
            collected_at=datetime.now(timezone.utc), cpu_usage_percent=5.0
        ),
        checks=[
            HostCheckResult(
                name="API",
                type="tcp",
                target="8000",
                status=status,
                message="ok" if status == "ok" else "连接超时",
                checked_at=datetime.now(timezone.utc),
            )
        ],
    )


def test_status_alert_requires_consecutive_periods(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    service = MonitorService(
        _config_with_periods(2),
        db_path=db_path,
        collect_status=lambda config: [_disk_report("95%")],
        notifier=notifier,
    )

    first = service.run_status_once()
    assert first == {"hosts": 1, "alerts": 0}
    assert list_alerts(db_path) == []

    second = service.run_status_once()
    assert second == {"hosts": 1, "alerts": 1}
    assert [row["fingerprint"] for row in list_alerts(db_path)] == [
        "system:gpu-01:disk:/"
    ]


def test_bad_good_bad_restarts_the_streak(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter(
        [
            [_disk_report("95%")],
            [_disk_report("50%")],
            [_disk_report("95%")],
            [_disk_report("95%")],
        ]
    )
    service = MonitorService(
        _config_with_periods(2),
        db_path=db_path,
        collect_status=lambda config: next(reports),
        notifier=notifier,
    )

    results = [service.run_status_once() for _ in range(4)]

    # bad (1) -> good (reset) -> bad (1) -> bad (2, fires)
    assert [result["alerts"] for result in results] == [0, 0, 0, 1]
    assert [row["fingerprint"] for row in list_alerts(db_path)] == [
        "system:gpu-01:disk:/"
    ]


def test_alert_resolves_only_after_consecutive_recovery_periods(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter(
        [
            [_disk_report("95%")],
            [_disk_report("95%")],
            [_disk_report("50%")],
            [_disk_report("50%")],
        ]
    )
    service = MonitorService(
        _config_with_periods(2),
        db_path=db_path,
        collect_status=lambda config: next(reports),
        notifier=notifier,
    )

    results = [service.run_status_once() for _ in range(4)]

    # Open after 2 bad cycles; one good cycle keeps it open; the second closes it.
    assert [result["alerts"] for result in results] == [0, 1, 0, 1]
    assert [event.fingerprint for event in notifier.events] == [
        "system:gpu-01:disk:/",
        "recovery:gpu-01:system",
    ]
    statuses = _statuses(db_path)
    assert statuses["system:gpu-01:disk:/"] == "resolved"
    assert statuses["recovery:gpu-01:system"] == "active"


def test_availability_alert_opens_and_resolves_after_periods(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter(
        [
            [_check_report("failed")],
            [_check_report("failed")],
            [_check_report("ok")],
            [_check_report("ok")],
        ]
    )
    service = MonitorService(
        _config_with_periods(
            2, checks=[HostCheckConfig(name="API", type="tcp", target="8000")]
        ),
        db_path=db_path,
        collect_status=lambda config: next(reports),
        notifier=notifier,
    )

    results = [service.run_status_once() for _ in range(4)]

    assert [result["alerts"] for result in results] == [0, 1, 0, 1]
    assert [event.fingerprint for event in notifier.events] == [
        "availability:gpu-01:api",
        "recovery:gpu-01:availability",
    ]
    assert notifier.events[0].category == "availability"
    assert notifier.events[0].severity == "critical"
    statuses = _statuses(db_path)
    assert statuses["availability:gpu-01:api"] == "resolved"
    assert statuses["recovery:gpu-01:availability"] == "active"


def test_offline_host_does_not_resolve_availability_alert(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = FakeNotifier()
    reports = iter(
        [
            [_check_report("failed")],
            [_check_report("failed")],
            [_failure_report()],
        ]
    )
    service = MonitorService(
        _config_with_periods(
            2, checks=[HostCheckConfig(name="API", type="tcp", target="8000")]
        ),
        db_path=db_path,
        collect_status=lambda config: next(reports),
        notifier=notifier,
    )

    results = [service.run_status_once() for _ in range(3)]

    assert [result["alerts"] for result in results] == [0, 1, 0]
    # The host went dark with no fresh check data: its availability alert must
    # stay open and no bogus "availability recovered" notice may be emitted.
    assert _statuses(db_path)["availability:gpu-01:api"] == "active"
    assert all(
        event.fingerprint != "recovery:gpu-01:availability"
        for event in notifier.events
    )


def test_host_threshold_override_suppresses_system_alert(tmp_path: Path):
    # 95% CPU clears the global 90% threshold...
    default_service = MonitorService(
        _config_with_periods(1),
        db_path=tmp_path / "default.db",
        collect_status=lambda config: [_cpu_report(95.0)],
        notifier=FakeNotifier(),
    )
    assert default_service.run_status_once() == {"hosts": 1, "alerts": 1}

    # ...but a per-host override of 99% keeps it quiet.
    override_service = MonitorService(
        _config_with_periods(
            1, rules=HostAlertRules(cpu_percent=99.0)
        ),
        db_path=tmp_path / "override.db",
        collect_status=lambda config: [_cpu_report(95.0)],
        notifier=FakeNotifier(),
    )
    assert override_service.run_status_once() == {"hosts": 1, "alerts": 0}


def test_run_disk_once_honours_host_temperature_override(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    seen = {}

    def collect(host, runner, **kwargs):
        seen.update(kwargs)
        return _warning_disk_report(host.name)

    service = MonitorService(
        _config_with_periods(
            1, rules=HostAlertRules(disk_temperature_c=65)
        ),
        db_path=db_path,
        collect_status=lambda config: [],
        collect_disk=collect,
        notifier=FakeNotifier(),
    )

    service.run_disk_once()

    assert seen["temperature_threshold_c"] == 65.0
