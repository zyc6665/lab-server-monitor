"""Tests for the interval/report scheduler (Task 8).

Covers the pure due-calculation helpers, the ``Scheduler`` DB-backed
catch-up/recording behaviour, and timezone resolution.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.scheduler import (
    ScheduledTask,
    Scheduler,
    compute_daily_fire,
    compute_weekly_fire,
    is_report_due,
    should_run,
)
from servermanage.storage import get_task_state, set_task_state
from servermanage.timeutil import resolve_timezone

TZ = timezone(timedelta(hours=8))
BASE = datetime(2026, 11, 6, 9, 0, 0, tzinfo=TZ)  # Friday 2026-11-06 09:00 +08:00


# ---------------------------------------------------------------------------
# should_run
# ---------------------------------------------------------------------------


def test_should_run_first_time():
    assert should_run(last_run_at=None, interval_seconds=600, now=BASE) is True


def test_should_run_respects_interval():
    last = BASE - timedelta(minutes=9)
    assert should_run(last_run_at=last, interval_seconds=600, now=BASE) is False
    last = BASE - timedelta(minutes=11)
    assert should_run(last_run_at=last, interval_seconds=600, now=BASE) is True


def test_catch_up_after_three_days(tmp_path: Path):
    """A task that has not run for days is due exactly once per run_pending."""
    calls: list[int] = []

    def func() -> None:
        calls.append(1)

    db_path = tmp_path / "state.db"
    task = ScheduledTask("poll", 600, func)
    clock_now = BASE
    scheduler = Scheduler([task], db_path=db_path, tz=TZ, clock=lambda: clock_now)

    # Seed a state row from three days ago (the PC was switched off since).
    set_task_state(
        "poll", db_path, last_run_at=(BASE - timedelta(days=3)).isoformat()
    )

    assert scheduler.run_pending() == ["poll"]
    assert len(calls) == 1

    # Still the same instant: the catch-up must not run twice in one call/cycle.
    assert scheduler.run_pending() == []
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# compute_daily_fire / compute_weekly_fire
# ---------------------------------------------------------------------------


def test_daily_fire_before_and_after():
    assert compute_daily_fire(BASE.replace(hour=8, minute=0), "09:00") == BASE
    assert compute_daily_fire(
        BASE.replace(hour=10, minute=0), "09:00"
    ) == BASE + timedelta(days=1)


def test_weekly_fire():
    wednesday = datetime(2026, 11, 4, 10, 0, tzinfo=TZ)
    assert compute_weekly_fire(wednesday, 4, "16:00") == datetime(
        2026, 11, 6, 16, 0, tzinfo=TZ
    )

    saturday = datetime(2026, 11, 7, 10, 0, tzinfo=TZ)
    assert compute_weekly_fire(saturday, 4, "16:00") == datetime(
        2026, 11, 13, 16, 0, tzinfo=TZ
    )

    # Same-day but still in the future: fire later today.
    friday_morning = datetime(2026, 11, 6, 9, 0, tzinfo=TZ)
    assert compute_weekly_fire(friday_morning, 4, "16:00") == datetime(
        2026, 11, 6, 16, 0, tzinfo=TZ
    )


# ---------------------------------------------------------------------------
# is_report_due
# ---------------------------------------------------------------------------


def test_is_report_due_semantics():
    target = BASE
    # Never ran -> due (missed report fires once).
    assert is_report_due(
        last_run_at=None, target_local=target, now_local=BASE + timedelta(hours=1)
    )
    # Last run predates the target and the target has passed -> due.
    assert is_report_due(
        last_run_at=BASE - timedelta(days=1),
        target_local=target,
        now_local=BASE + timedelta(minutes=1),
    )
    # Target not reached yet -> not due, even if the previous run predates it.
    assert not is_report_due(
        last_run_at=BASE - timedelta(days=1),
        target_local=target,
        now_local=BASE - timedelta(minutes=1),
    )
    # Never ran, but the target is still in the future -> NOT due: a fresh
    # install before today's target must wait instead of reporting immediately.
    assert not is_report_due(
        last_run_at=None, target_local=target, now_local=BASE - timedelta(minutes=1)
    )
    # Never ran and the target is exactly now -> due (catch-up boundary).
    assert is_report_due(
        last_run_at=None, target_local=target, now_local=target
    )
    # Already sent for exactly this target -> not due again.
    assert not is_report_due(
        last_run_at=target, target_local=target, now_local=BASE + timedelta(hours=1)
    )
    # Last run after the target -> not due.
    assert not is_report_due(
        last_run_at=BASE + timedelta(minutes=5),
        target_local=target,
        now_local=BASE + timedelta(hours=1),
    )


def test_report_task_fires_once_after_missed_day(tmp_path: Path):
    """A daily report missed while the PC was off fires exactly once."""
    calls: list[int] = []

    def send_report() -> None:
        calls.append(1)

    db_path = tmp_path / "state.db"
    task = ScheduledTask(
        "daily-report",
        0,
        send_report,
        target_time=lambda now: compute_daily_fire(now, "09:00"),
    )
    clock_now = BASE.replace(hour=10, minute=0)
    scheduler = Scheduler([task], db_path=db_path, tz=TZ, clock=lambda: clock_now)

    set_task_state(
        "daily-report",
        db_path,
        last_run_at=(BASE - timedelta(days=2)).isoformat(),
    )

    assert scheduler.run_pending() == ["daily-report"]
    assert len(calls) == 1
    assert scheduler.run_pending() == []
    assert len(calls) == 1

    # Next day at the same wall-clock time the next target becomes due.
    clock_now = clock_now + timedelta(days=1)
    assert scheduler.run_pending() == ["daily-report"]
    assert len(calls) == 2


def test_fresh_install_before_target_does_not_report(tmp_path: Path):
    """Install at 08:00 for a 09:00 daily report: no immediate (double) send."""
    calls: list[int] = []

    def send_report() -> None:
        calls.append(1)

    db_path = tmp_path / "state.db"
    task = ScheduledTask(
        "daily-report",
        0,
        send_report,
        target_time=lambda now: compute_daily_fire(now, "09:00"),
    )
    clock_now = datetime(2026, 11, 6, 8, 0, tzinfo=TZ)
    scheduler = Scheduler([task], db_path=db_path, tz=TZ, clock=lambda: clock_now)

    # 08:00, before today's target: nothing is due, nothing recorded.
    assert scheduler.run_pending() == []
    assert calls == []
    assert get_task_state("daily-report", db_path) is None

    # 09:00:01, the target has just passed: fires exactly once.
    clock_now = datetime(2026, 11, 6, 9, 0, 1, tzinfo=TZ)
    assert scheduler.run_pending() == ["daily-report"]
    assert calls == [1]

    # Same day, later: the slot is covered, so no second report.
    clock_now = datetime(2026, 11, 6, 12, 0, tzinfo=TZ)
    assert scheduler.run_pending() == []
    assert calls == [1]

    # Next day the following occurrence fires once.
    clock_now = datetime(2026, 11, 7, 9, 0, 1, tzinfo=TZ)
    assert scheduler.run_pending() == ["daily-report"]
    assert calls == [1, 1]


def test_fresh_install_after_target_fires_catch_up_once(tmp_path: Path):
    """Install at 10:00 for a 09:00 daily report: one catch-up report today."""
    calls: list[int] = []

    def send_report() -> None:
        calls.append(1)

    db_path = tmp_path / "state.db"
    task = ScheduledTask(
        "daily-report",
        0,
        send_report,
        target_time=lambda now: compute_daily_fire(now, "09:00"),
    )
    scheduler = Scheduler(
        [task],
        db_path=db_path,
        tz=TZ,
        clock=lambda: datetime(2026, 11, 6, 10, 0, tzinfo=TZ),
    )

    assert scheduler.run_pending() == ["daily-report"]
    assert calls == [1]

    # A second call the same day must not report again.
    assert scheduler.run_pending() == []
    assert calls == [1]


def test_weekly_fresh_install_semantics(tmp_path: Path):
    """Weekly report: this week's slot governs a fresh install."""
    calls: list[int] = []

    def send_report() -> None:
        calls.append(1)

    db_path = tmp_path / "state.db"
    task = ScheduledTask(
        "weekly-report",
        0,
        send_report,
        target_time=lambda now: compute_weekly_fire(now, 0, "09:00"),  # Monday 09:00
    )
    clock_now = datetime(2026, 11, 2, 8, 0, tzinfo=TZ)  # Monday, before 09:00
    scheduler = Scheduler([task], db_path=db_path, tz=TZ, clock=lambda: clock_now)

    # This week's Monday 09:00 is still ahead -> not due.
    assert scheduler.run_pending() == []
    assert calls == []

    # Friday: this week's Monday slot has passed -> one catch-up, then quiet.
    clock_now = datetime(2026, 11, 6, 10, 0, tzinfo=TZ)
    assert scheduler.run_pending() == ["weekly-report"]
    assert calls == [1]
    assert scheduler.run_pending() == []
    assert calls == [1]

    # The following Monday's slot fires normally.
    clock_now = datetime(2026, 11, 9, 9, 0, 1, tzinfo=TZ)
    assert scheduler.run_pending() == ["weekly-report"]
    assert calls == [1, 1]


def test_multi_day_gap_reports_exactly_once(tmp_path: Path):
    """Several missed daily slots still produce a single catch-up report."""
    calls: list[int] = []

    def send_report() -> None:
        calls.append(1)

    db_path = tmp_path / "state.db"
    task = ScheduledTask(
        "daily-report",
        0,
        send_report,
        target_time=lambda now: compute_daily_fire(now, "09:00"),
    )
    scheduler = Scheduler(
        [task],
        db_path=db_path,
        tz=TZ,
        clock=lambda: datetime(2026, 11, 6, 10, 0, tzinfo=TZ),
    )

    # Last ran five days ago; four/five slots were missed while the PC was off.
    set_task_state(
        "daily-report",
        db_path,
        last_run_at=datetime(2026, 11, 1, 9, 0, tzinfo=TZ).isoformat(),
    )

    assert scheduler.run_pending() == ["daily-report"]
    assert calls == [1]

    # Not replayed once per missed day.
    assert scheduler.run_pending() == []
    assert calls == [1]


# ---------------------------------------------------------------------------
# Scheduler state recording / isolation
# ---------------------------------------------------------------------------


def test_scheduler_records_task_state(tmp_path: Path):
    calls: list[int] = []

    def func() -> None:
        calls.append(1)

    db_path = tmp_path / "state.db"
    task = ScheduledTask("poll", 600, func)
    scheduler = Scheduler([task], db_path=db_path, tz=TZ, clock=lambda: BASE)

    assert get_task_state("poll", db_path) is None
    assert scheduler.run_pending() == ["poll"]
    assert len(calls) == 1

    state = get_task_state("poll", db_path)
    assert state is not None
    assert state["last_run_at"] == BASE.isoformat()
    assert state["last_result"] == "ok"

    # Inside the interval: not executed again, state untouched.
    assert scheduler.run_pending() == []
    assert len(calls) == 1


def test_scheduler_failure_does_not_stop_others(tmp_path: Path):
    done: list[str] = []

    def boom() -> None:
        raise RuntimeError("boom")

    def ok() -> None:
        done.append("ok")

    db_path = tmp_path / "state.db"
    scheduler = Scheduler(
        [
            ScheduledTask("broken", 600, boom),
            ScheduledTask("healthy", 600, ok),
        ],
        db_path=db_path,
        tz=TZ,
        clock=lambda: BASE,
    )

    result = scheduler.run_pending()

    assert result == ["broken", "healthy"]
    assert done == ["ok"]
    broken_state = get_task_state("broken", db_path)
    assert broken_state is not None
    assert "boom" in (broken_state["last_result"] or "")


def test_due_check_error_does_not_block_healthy_task(tmp_path: Path):
    """A bad report target_time must not abort the run for later tasks."""
    done: list[str] = []

    def bad_report() -> None:
        done.append("report")

    def healthy() -> None:
        done.append("ok")

    db_path = tmp_path / "state.db"
    scheduler = Scheduler(
        [
            ScheduledTask(
                "bad-report",
                0,
                bad_report,
                target_time=lambda now: compute_daily_fire(now, "25:99"),
            ),
            ScheduledTask("healthy", 600, healthy),
        ],
        db_path=db_path,
        tz=TZ,
        clock=lambda: BASE,
    )

    result = scheduler.run_pending()  # must not raise

    assert "healthy" in result
    assert done == ["ok"]
    bad_state = get_task_state("bad-report", db_path)
    assert bad_state is not None
    assert "ValueError" in (bad_state["last_result"] or "")


def test_scheduler_normalizes_naive_clock_and_state(tmp_path: Path):
    """Naive clock values are interpreted in the configured timezone."""
    calls: list[int] = []

    def func() -> None:
        calls.append(1)

    db_path = tmp_path / "state.db"
    task = ScheduledTask("poll", 600, func)
    naive_now = BASE.replace(tzinfo=None, minute=10)  # 10 min after the seeded run
    scheduler = Scheduler(
        [task], db_path=db_path, tz=TZ, clock=lambda: naive_now
    )
    # Naive stored timestamp must compare correctly against the naive clock.
    set_task_state(
        "poll", db_path, last_run_at=BASE.replace(tzinfo=None).isoformat()
    )

    assert scheduler.run_pending() == ["poll"]
    assert len(calls) == 1


def test_scheduler_start_stop_runs_background_loop(tmp_path: Path):
    """start() runs tasks in a background thread and stop() joins cleanly."""
    import threading

    fired = threading.Event()

    def func() -> None:
        fired.set()

    db_path = tmp_path / "state.db"
    scheduler = Scheduler(
        [ScheduledTask("poll", 600, func)],
        db_path=db_path,
        tz=TZ,
        clock=lambda: BASE,
        tick_seconds=0.01,
    )

    scheduler.start()
    try:
        assert fired.wait(timeout=5.0) is True
    finally:
        scheduler.stop()

    assert scheduler._thread is None
    assert get_task_state("poll", db_path) is not None


# ---------------------------------------------------------------------------
# Timezone resolution
# ---------------------------------------------------------------------------


def test_resolve_timezone_known_name():
    tz = resolve_timezone("Asia/Shanghai")
    assert tz.utcoffset(BASE.replace(tzinfo=None)) == timedelta(hours=8)


def test_resolve_timezone_falls_back_to_utc(caplog):
    with caplog.at_level(logging.WARNING):
        tz = resolve_timezone("Not/ARealZone")
    assert tz is timezone.utc
    assert any("Not/ARealZone" in record.getMessage() for record in caplog.records)
