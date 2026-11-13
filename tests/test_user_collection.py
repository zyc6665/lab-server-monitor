"""Tests for the user-scan orchestration (Task 4, Deliverables A and B).

The scan itself is faked: these tests only care about usage scheduling,
baseline/snapshot persistence, alert reconciliation, failure isolation and the
``MonitorService`` background-thread plumbing.  A real :class:`AlertEngine` with
a recording notifier is used so the alert rows written to SQLite are asserted
directly through :func:`servermanage.storage.list_alerts`.
"""

from __future__ import annotations

import threading
import time
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.alerts import AlertEngine
from servermanage.app import MonitorService
from servermanage.models import (
    AlertsConfig,
    AppConfig,
    AuthConfig,
    HostConfig,
    HostUserAccount,
    ReportConfig,
    SSHRuntimeConfig,
    UserMonitoringConfig,
    WeeklyReportConfig,
)
from servermanage.user_collection import run_user_scan

BASE = datetime(2026, 11, 9, 8, 0, tzinfo=timezone.utc)
USAGE_INTERVAL = 21600

ScanCall = namedtuple(
    "ScanCall", "host runner now usage_due command_timeout"
)


# ---------------------------------------------------------------------------
# Doubles and builders
# ---------------------------------------------------------------------------


class DummyNotifier:
    """Records dispatches; no OS/SMTP side effects."""

    def __init__(self) -> None:
        self.events = []

    def dispatch(self, event, config):
        self.events.append(event)
        return ["fake"]


class FakeRunner:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeScan:
    """Fake ``collect_host_users`` with per-host call sequencing.

    ``handler(host, call_index)`` returns ``(accounts, usage_readable,
    usage_refreshed)`` or raises to simulate a host failure.  Every call is
    recorded so tests can assert ``usage_due`` and the timeout.
    """

    def __init__(self, handler):
        self.handler = handler
        self.calls: list[ScanCall] = []
        self._counts: dict[str, int] = {}

    def __call__(self, host, runner, *, now, usage_due, command_timeout=120, usage_timeout=None, sudo_available=True, known_usage=None, usage_progress=None):
        if usage_progress is not None:
            usage_progress('alice', 0, 1)
        index = self._counts.get(host.name, 0)
        self._counts[host.name] = index + 1
        self.calls.append(
            ScanCall(host.name, runner, now, usage_due, command_timeout)
        )
        return self.handler(host, index)


def make_host(name: str = "gpu-01", **overrides) -> HostConfig:
    values = dict(
        name=name,
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    values.update(overrides)
    return HostConfig(**values)


def make_config(
    *servers: HostConfig,
    user_monitoring: UserMonitoringConfig | None = None,
) -> AppConfig:
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        alerts=AlertsConfig(consecutive_periods=1),
        report=ReportConfig(
            subject_prefix="[Test]",
            daily_enabled=False,
            weekly=WeeklyReportConfig(enabled=False),
        ),
        servers=list(servers) or [make_host()],
        user_monitoring=user_monitoring or UserMonitoringConfig(),
    )


def make_account(
    username: str = "alice", host_name: str = "gpu-01", **overrides
) -> HostUserAccount:
    values = dict(
        host_name=host_name,
        username=username,
        uid=1000,
        gid=1000,
        primary_group=username,
        gecos=username,
        home=f"/home/{username}",
        shell="/bin/bash",
        groups=[username, "docker"],
        in_docker=True,
        in_sudo=True,
        home_exists=True,
        home_owner=username,
        home_group=username,
        home_mode="700",
        home_size_bytes=1024,
        data_exists=True,
        data_owner=username,
        data_group=username,
        data_mode="700",
        data_size_bytes=2048,
        data_supported=True,
        usage_readable=True,
        usage_stale=False,
        usage_collected_at=None,
        collected_at=BASE,
        state="present",
    )
    values.update(overrides)
    return HostUserAccount(**values)


def make_engine(db_path: Path) -> tuple[AlertEngine, DummyNotifier]:
    notifier = DummyNotifier()
    engine = AlertEngine(
        db_path,
        AlertsConfig(consecutive_periods=1),
        notifier,
        clock=lambda: BASE,
    )
    return engine, notifier


def recording_builder():
    runners = []

    def build(host, timeout):
        runner = FakeRunner()
        runners.append((host.name, timeout, runner))
        return runner

    return build, runners


def _iso(value: str) -> datetime:
    return datetime.fromisoformat(value)


# ---------------------------------------------------------------------------
# Deliverable A: run_user_scan
# ---------------------------------------------------------------------------


def test_first_scan_seeds_baseline_snapshot_and_emits_no_alerts(tmp_path):
    db = tmp_path / "monitor.db"
    engine, notifier = make_engine(db)
    resolved = []
    real_resolve = engine.resolve_missing

    def spy_resolve(host_name, active, **kwargs):
        resolved.append((host_name, set(active), kwargs))
        return real_resolve(host_name, active, **kwargs)

    engine.resolve_missing = spy_resolve

    scan = FakeScan(lambda host, index: ([make_account()], True, True))
    build, runners = recording_builder()

    summary = run_user_scan(
        make_config(),
        db,
        engine,
        build_runner=build,
        scan=scan,
        now=BASE,
    )

    baseline = storage.get_user_baseline("gpu-01", db)
    snapshot = storage.get_host_user_snapshot("gpu-01", db)
    state = storage.get_user_scan_state("gpu-01", db)

    assert [row["username"] for row in baseline] == ["alice"]
    assert [row["username"] for row in snapshot] == ["alice"]
    assert state is not None
    assert _iso(state["last_scan_at"]) == BASE
    assert _iso(state["last_usage_at"]) == BASE
    assert state["last_error"] == ""
    assert storage.list_alerts(db) == []
    assert resolved == []
    assert notifier.events == []

    assert summary["hosts_total"] == 1
    assert summary["hosts_done"] == 1
    assert summary["hosts_failed"] == 0
    assert summary["accounts"] == 1
    assert summary["errors"] == {}
    assert isinstance(summary["started_at"], str)
    assert isinstance(summary["finished_at"], str)

    assert scan.calls[0].usage_due is True
    assert scan.calls[0].command_timeout == 120
    assert len(runners) == 1
    assert runners[0][0] == "gpu-01"
    assert runners[0][1] == 10
    assert runners[0][2].closed is True


def test_first_successful_scan_after_failure_seeds_silently(tmp_path):
    """A host that failed before ever storing data must not report every account
    as newly added on its first successful scan."""
    db = tmp_path / "monitor.db"
    engine, notifier = make_engine(db)
    healthy = make_account()

    def handler(host, index):
        if index == 0:
            raise RuntimeError("ssh down")
        return ([healthy], True, True)

    scan = FakeScan(handler)
    config = make_config()

    run_user_scan(
        config,
        db,
        engine,
        build_runner=recording_builder()[0],
        scan=scan,
        now=BASE,
    )
    assert storage.get_user_scan_state("gpu-01", db)["last_error"] == "ssh down"
    assert storage.get_user_baseline("gpu-01", db) == []

    run_user_scan(
        config,
        db,
        engine,
        build_runner=recording_builder()[0],
        scan=scan,
        now=BASE + timedelta(hours=1),
    )

    assert [row["username"] for row in storage.get_user_baseline("gpu-01", db)] == [
        "alice"
    ]
    assert [row["username"] for row in storage.get_host_user_snapshot(
        "gpu-01", db
    )] == ["alice"]
    assert storage.list_alerts(db) == []
    assert notifier.events == []


def test_same_account_on_second_scan_generates_no_alert(tmp_path):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    scan = FakeScan(lambda host, index: ([make_account()], True, True))
    config = make_config()

    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE)
    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE + timedelta(hours=1))

    assert storage.list_alerts(db) == []
    assert len(storage.get_user_baseline("gpu-01", db)) == 1


def test_added_account_creates_user_added_alert_that_is_not_auto_resolved(
    tmp_path,
):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    alice = make_account("alice")
    bob = make_account("bob", uid=1001, gid=1001)

    def handler(host, index):
        return ([alice, bob] if index >= 1 else [alice], True, True)

    scan = FakeScan(handler)
    config = make_config()

    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE)
    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE + timedelta(hours=1))

    alerts = storage.list_alerts(db)
    assert len(alerts) == 1
    assert alerts[0]["fingerprint"] == "user-added:gpu-01:bob"
    assert alerts[0]["status"] == "active"

    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE + timedelta(hours=2))

    alerts = [row for row in storage.list_alerts(db) if row["status"] == "active"]
    assert len(alerts) == 1
    assert alerts[0]["fingerprint"] == "user-added:gpu-01:bob"


def test_empty_first_scan_does_not_suppress_the_next_user_added(tmp_path):
    """A host with zero accounts on its first scan is still "seeded".

    The old ``not baseline and not previous_snapshot`` test treated the next
    round as another first scan, so the first genuinely new account produced no
    ``user-added`` alert.
    """
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    alice = make_account("alice")
    scan = FakeScan(lambda host, index: ([] if index == 0 else [alice], True, True))
    config = make_config()

    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE)
    assert storage.get_user_baseline("gpu-01", db) == []
    assert storage.get_user_scan_state("gpu-01", db)["last_scan_at"]

    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE + timedelta(hours=1))

    alerts = storage.list_alerts(db)
    assert [row["fingerprint"] for row in alerts] == ["user-added:gpu-01:alice"]


def test_due_usage_failure_marks_rows_stale_and_unreadable(tmp_path):
    """``usage_due`` but no refresh => stale=True and usage_readable=False.

    Persisting both flags is what lets the UI say "no permission" instead of
    showing last week's byte counts as if they were current.
    """
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    alice = make_account("alice")
    config = make_config(
        user_monitoring=UserMonitoringConfig(usage_interval_seconds=3600)
    )
    scan = FakeScan(lambda host, index: ([alice], True, True))

    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE)

    # Due again, but this time du needs sudo and has none.
    failing = FakeScan(lambda host, index: ([alice], False, False))
    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=failing, now=BASE + timedelta(hours=2))
    assert failing.calls[-1].usage_due is True

    [row] = storage.get_host_user_snapshot("gpu-01", db)
    assert row["usage_stale"] is True
    assert row["usage_readable"] is False
    # Sizes are carried over from the last successful measurement.
    assert row["home_size_bytes"] == alice.home_size_bytes


def test_removed_account_alert_stays_active_then_resolves_when_it_returns(
    tmp_path,
):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    alice = make_account("alice")
    bob = make_account("bob", uid=1001, gid=1001)
    config = make_config()

    def handler(host, index):
        accounts = [alice, bob] if index == 0 else [alice]
        if index >= 3:
            accounts = [alice, bob]
        return (accounts, True, True)

    scan = FakeScan(handler)
    for hour in range(4):
        run_user_scan(
            config,
            db,
            engine,
            build_runner=recording_builder()[0],
            scan=scan,
            now=BASE + timedelta(hours=hour),
        )

    row = [
        alert
        for alert in storage.list_alerts(db)
        if alert["fingerprint"] == "user-present:gpu-01:bob"
    ]
    assert len(row) == 1
    assert row[0]["status"] == "resolved"
    assert [item["username"] for item in storage.get_host_user_snapshot(
        "gpu-01", db
    )] == ["alice", "bob"]


def test_removed_account_stays_active_across_scans(tmp_path):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    alice = make_account("alice")
    bob = make_account("bob", uid=1001, gid=1001)

    def handler(host, index):
        return ([alice, bob] if index == 0 else [alice], True, True)

    scan = FakeScan(handler)
    config = make_config()

    for hour in range(3):
        run_user_scan(
            config,
            db,
            engine,
            build_runner=recording_builder()[0],
            scan=scan,
            now=BASE + timedelta(hours=hour),
        )

    alerts = [
        alert
        for alert in storage.list_alerts(db)
        if alert["fingerprint"] == "user-present:gpu-01:bob"
    ]
    assert len(alerts) == 1
    assert alerts[0]["status"] == "active"


def test_host_failure_preserves_snapshot_and_alerts_and_records_error(tmp_path):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    healthy = make_account("alice")
    broken = make_account("alice", in_docker=False)

    def handler(host, index):
        if index == 2:
            raise RuntimeError("ssh down")
        return ([healthy if index == 0 else broken], True, True)

    scan = FakeScan(handler)
    config = make_config()

    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE)
    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE + timedelta(hours=1))
    before = storage.list_alerts(db)
    assert [alert["fingerprint"] for alert in before if alert["status"] == "active"] == [
        "user-docker:gpu-01:alice"
    ]
    snapshot_before = storage.get_host_user_snapshot("gpu-01", db)

    summary = run_user_scan(
        config,
        db,
        engine,
        build_runner=recording_builder()[0],
        scan=scan,
        now=BASE + timedelta(hours=2),
    )

    assert summary["hosts_done"] == 0
    assert summary["hosts_failed"] == 1
    assert summary["errors"] == {"gpu-01": "ssh down"}

    snapshot_after = storage.get_host_user_snapshot("gpu-01", db)
    assert snapshot_after == snapshot_before
    assert snapshot_after[0]["in_docker"] is False

    alerts = storage.list_alerts(db)
    assert len(alerts) == len(before)
    assert alerts[0]["fingerprint"] == "user-docker:gpu-01:alice"
    assert alerts[0]["status"] == "active"

    state = storage.get_user_scan_state("gpu-01", db)
    assert state is not None
    assert state["last_error"] == "ssh down"


def test_failed_host_does_not_block_other_hosts(tmp_path):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    alice = make_account("alice", host_name="gpu-01")

    def handler(host, index):
        if host.name == "gpu-02":
            raise RuntimeError("connection refused")
        return ([alice], True, True)

    scan = FakeScan(handler)
    config = make_config(make_host("gpu-01"), make_host("gpu-02", host="10.0.0.2"))

    summary = run_user_scan(
        config,
        db,
        engine,
        build_runner=recording_builder()[0],
        scan=scan,
        now=BASE,
    )

    assert summary["hosts_total"] == 2
    assert summary["hosts_done"] == 1
    assert summary["hosts_failed"] == 1
    assert summary["accounts"] == 1
    assert summary["errors"] == {"gpu-02": "connection refused"}
    assert [row["username"] for row in storage.get_host_user_snapshot(
        "gpu-01", db
    )] == ["alice"]
    assert storage.get_host_user_snapshot("gpu-02", db) == []
    assert storage.get_user_baseline("gpu-02", db) == []
    state = storage.get_user_scan_state("gpu-02", db)
    assert state is not None
    assert state["last_error"] == "connection refused"


def test_host_with_user_monitoring_disabled_is_skipped_entirely(tmp_path):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    scan = FakeScan(lambda host, index: ([make_account()], True, True))
    config = make_config(
        make_host("gpu-01"),
        make_host("gpu-02", user_monitoring=False),
    )

    summary = run_user_scan(
        config,
        db,
        engine,
        build_runner=recording_builder()[0],
        scan=scan,
        now=BASE,
    )

    assert [call.host for call in scan.calls] == ["gpu-01"]
    assert summary["hosts_total"] == 1
    assert storage.get_host_user_snapshot("gpu-02", db) == []
    assert storage.get_user_baseline("gpu-02", db) == []
    assert storage.get_user_scan_state("gpu-02", db) is None


def test_usage_due_follows_last_usage_and_force_usage(tmp_path):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    account = make_account()

    def handler(host, index):
        return ([account], True, index != 1)

    scan = FakeScan(handler)
    # 这两条用例验证的是「按间隔触发」的逻辑本身，固定成 6 小时节奏，
    # 不受默认值（0.1.142 起为三天）变化影响。
    config = make_config(
        user_monitoring=UserMonitoringConfig(usage_interval_seconds=21600)
    )

    for offset in (0, 1, 6):
        run_user_scan(
            config,
            db,
            engine,
            build_runner=recording_builder()[0],
            scan=scan,
            now=BASE + timedelta(hours=offset),
        )

    assert [call.usage_due for call in scan.calls] == [True, False, True]

    run_user_scan(
        config,
        db,
        engine,
        build_runner=recording_builder()[0],
        scan=scan,
        now=BASE + timedelta(hours=6),
        force_usage=True,
    )
    assert scan.calls[-1].usage_due is True


def test_usage_stale_only_after_one_and_a_half_intervals(tmp_path):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    account = make_account(home_size_bytes=111, data_size_bytes=222)

    def handler(host, index):
        if index == 0:
            return ([account], True, True)
        no_sizes = make_account(home_size_bytes=None, data_size_bytes=None)
        return ([no_sizes], True, False)

    scan = FakeScan(handler)
    # 固定 6 小时节奏，验证「1.5 个间隔后标记 stale」本身的行为。
    config = make_config(
        user_monitoring=UserMonitoringConfig(usage_interval_seconds=21600)
    )

    run_user_scan(config, db, engine, build_runner=recording_builder()[0],
                  scan=scan, now=BASE)
    run_user_scan(
        config,
        db,
        engine,
        build_runner=recording_builder()[0],
        scan=scan,
        now=BASE + timedelta(hours=1),
    )
    row = storage.get_host_user_snapshot("gpu-01", db)[0]
    assert row["usage_stale"] is False
    assert row["home_size_bytes"] == 111
    assert row["data_size_bytes"] == 222
    assert _iso(row["usage_collected_at"]) == BASE

    run_user_scan(
        config,
        db,
        engine,
        build_runner=recording_builder()[0],
        scan=scan,
        now=BASE + timedelta(hours=10),
    )
    row = storage.get_host_user_snapshot("gpu-01", db)[0]
    assert row["usage_stale"] is True
    assert row["home_size_bytes"] == 111
    assert row["data_size_bytes"] == 222


def test_usage_stale_when_usage_was_never_collected(tmp_path):
    db = tmp_path / "monitor.db"
    engine, _ = make_engine(db)
    scan = FakeScan(
        lambda host, index: (
            [make_account(home_size_bytes=None, data_size_bytes=None)],
            False,
            False,
        )
    )

    run_user_scan(
        make_config(),
        db,
        engine,
        build_runner=recording_builder()[0],
        scan=scan,
        now=BASE,
    )

    row = storage.get_host_user_snapshot("gpu-01", db)[0]
    assert row["usage_stale"] is True
    assert row["usage_collected_at"] is None
    state = storage.get_user_scan_state("gpu-01", db)
    assert state["last_usage_at"] is None


# ---------------------------------------------------------------------------
# Deliverable B: MonitorService
# ---------------------------------------------------------------------------


def test_refresh_users_starts_then_reports_already_running(tmp_path):
    started = threading.Event()
    release = threading.Event()

    def slow_scan(host, runner, *, now, usage_due, command_timeout=120, usage_timeout=None, sudo_available=True, known_usage=None, usage_progress=None):
        started.set()
        assert release.wait(5), "test never released the slow scan"
        return ([make_account()], True, True)

    service = MonitorService(
        make_config(user_monitoring=UserMonitoringConfig(scan_interval_seconds=60)),
        db_path=tmp_path / "monitor.db",
        notifier=DummyNotifier(),
        collect_users=slow_scan,
    )

    first = service.refresh_users()
    assert first == {"ok": True, "started": True}
    assert started.wait(5), "worker thread never called the scan"

    status = service.user_scan_status()
    assert status["running"] is True
    assert status["hosts_total"] == 1
    assert status["hosts_done"] == 0
    assert status["finished_at"] is None

    second = service.refresh_users()
    assert second == {"ok": True, "started": False, "reason": "already_running"}

    release.set()
    deadline = time.time() + 5
    while service.user_scan_status()["running"] and time.time() < deadline:
        time.sleep(0.01)

    status = service.user_scan_status()
    assert status["running"] is False
    assert status["hosts_done"] == 1
    assert status["hosts_total"] == 1
    assert status["accounts"] == 1
    assert status["error"] is None
    assert status["finished_at"] is not None


def test_refresh_users_reports_per_host_scan_failure(tmp_path):
    def failing_scan(host, runner, *, now, usage_due, command_timeout=120, usage_timeout=None, sudo_available=True, known_usage=None, usage_progress=None):
        raise RuntimeError("scan exploded")

    service = MonitorService(
        make_config(),
        db_path=tmp_path / "monitor.db",
        notifier=DummyNotifier(),
        collect_users=failing_scan,
    )

    assert service.refresh_users()["started"] is True
    deadline = time.time() + 5
    while service.user_scan_status()["running"] and time.time() < deadline:
        time.sleep(0.01)

    status = service.user_scan_status()
    assert status["running"] is False
    assert status["error"] is None
    assert status["hosts_failed"] == 1
    assert status["errors"] == {"gpu-01": "scan exploded"}
    assert status["finished_at"] is not None


def test_refresh_users_worker_exception_sets_error(tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("servermanage.app.run_user_scan", boom)
    service = MonitorService(
        make_config(),
        db_path=tmp_path / "monitor.db",
        notifier=DummyNotifier(),
        collect_users=FakeScan(lambda host, index: ([], True, False)),
    )

    assert service.refresh_users()["started"] is True
    deadline = time.time() + 5
    while service.user_scan_status()["running"] and time.time() < deadline:
        time.sleep(0.01)

    status = service.user_scan_status()
    assert status["running"] is False
    assert status["error"] == "boom"
    assert status["finished_at"] is not None


def test_build_tasks_registers_user_scan_only_when_enabled(tmp_path):
    enabled = MonitorService(
        make_config(
            user_monitoring=UserMonitoringConfig(
                enabled=True, scan_interval_seconds=1234
            )
        ),
        db_path=tmp_path / "m.db",
        collect_users=FakeScan(lambda host, index: ([], True, False)),
    )
    tasks = {task.name: task for task in enabled._build_tasks()}
    assert "user_scan" in tasks
    assert tasks["user_scan"].interval_seconds == 1234
    assert tasks["user_scan"].func == enabled.refresh_users

    disabled = MonitorService(
        make_config(user_monitoring=UserMonitoringConfig(enabled=False)),
        db_path=tmp_path / "m2.db",
        collect_users=FakeScan(lambda host, index: ([], True, False)),
    )
    assert "user_scan" not in {task.name for task in disabled._build_tasks()}


def test_build_tasks_registers_user_scan_for_a_single_enabled_host(tmp_path):
    """Global off + one host on must still schedule the scan."""
    config = make_config(
        make_host("gpu-01", user_monitoring=True),
        user_monitoring=UserMonitoringConfig(enabled=False),
    )

    service = MonitorService(
        config,
        db_path=tmp_path / "m.db",
        collect_users=FakeScan(lambda host, index: ([], True, False)),
    )

    assert "user_scan" in {task.name for task in service._build_tasks()}


def test_refresh_users_reports_progress_per_host(tmp_path):
    """The UI polls ``hosts_done``; it must advance during the round."""
    seen: list[dict] = []

    def handler(host, index):
        return ([make_account(host_name=host.name)], True, False)

    config = make_config(
        make_host("gpu-01"), make_host("gpu-02", host="10.0.0.2")
    )
    service = MonitorService(
        config,
        db_path=tmp_path / "monitor.db",
        collect_users=FakeScan(handler),
    )

    original = service._user_scan_status

    def record_progress(update):
        seen.append(dict(update))

    assert service.refresh_users()["started"] is True
    deadline = time.time() + 5
    while service.user_scan_status()["running"] and time.time() < deadline:
        window = service.user_scan_status()
        if window.get("hosts_done"):
            seen.append(dict(window))
        time.sleep(0.01)

    assert seen, "no progress was reported while the scan ran"
    final = service.user_scan_status()
    assert final["hosts_done"] == 2
    assert final["hosts_total"] == 2
    assert final["accounts"] == 2
