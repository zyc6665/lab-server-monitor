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
    # Never ran at all -> due even before the nominal time (fresh-install catch-up).
    assert is_report_due(
        last_run_at=None, target_local=target, now_local=BASE - timedelta(minutes=1)
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
