"""Interval task scheduler with catch-up for the PC polling monitor.

Design notes
------------
* The PC running the monitor may be switched off for days.  A task therefore
  must never be skipped *permanently* just because its next slot was missed:
  every due check compares the stored ``last_run_at`` against the current
  clock, so a stale task simply runs once on the next ``run_pending`` call
  ("catch-up").  Recording the fresh timestamp then prevents a second run
  until the next interval / target.
* Two kinds of tasks share one scheduler:

  - **Interval tasks** (polling, disk polling): due when
    ``now - last_run_at >= interval_seconds`` (or never ran).
  - **Report tasks** (daily / weekly e-mail): due when a *scheduled target
    time* has passed and no report was sent for that target.  They carry an
    optional ``target_time`` callable that maps a *reference* local time (the
    last run, or "now" when there is none) to the first target after it (see
    :func:`compute_daily_fire` / :func:`compute_weekly_fire`).

* All comparisons happen in the configured timezone.  A naive datetime from
  the injectable ``clock`` (default: :func:`datetime.now`) is interpreted as
  wall-clock time in that timezone; an aware datetime is converted to it.
  Timestamps are persisted as ``datetime.isoformat()`` strings, so they keep
  their UTC offset and can be parsed back unambiguously.  A stored value
  without an offset (older/hand-written rows) is likewise treated as local
  wall time.

* ``run_pending`` never lets one failing task abort the others: the exception
  is logged, the failure is recorded in ``task_state.last_result`` and the
  loop continues.  The task still counts as invoked (it is returned in the
  list) but its slot is consumed, matching the "record the attempt" policy
  that avoids hammering a broken dependency on every tick.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, tzinfo
from pathlib import Path
from typing import Callable

from servermanage import storage

LOGGER = logging.getLogger(__name__)

__all__ = [
    "should_run",
    "compute_daily_fire",
    "compute_weekly_fire",
    "is_report_due",
    "ScheduledTask",
    "Scheduler",
]

# Granularity of the background loop.  Capped so a long poll interval does not
# delay a daily/weekly report by more than this many seconds, and floored so a
# tiny interval cannot spin the CPU.
_MAX_TICK_SECONDS = 60.0
_MIN_TICK_SECONDS = 1.0

# How long ``stop`` waits for the worker thread to finish before giving up.
_STOP_JOIN_TIMEOUT_SECONDS = 5.0

# Longest failure text stored in ``task_state.last_result``.
_MAX_RESULT_LENGTH = 500


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _normalize(value: datetime, tz: tzinfo) -> datetime:
    """Interpret a naive datetime as wall time in *tz*; convert aware ones."""
    if value.tzinfo is None:
        return value.replace(tzinfo=tz)
    return value.astimezone(tz)


def _align_pair(first: datetime, second: datetime) -> tuple[datetime, datetime]:
    """Make two datetimes comparable without raising on naive/aware mixes.

    A naive value is anchored to the other value's timezone (or UTC when both
    are naive).  This keeps the pure helpers safe for callers that pass a
    mismatched pair.
    """
    if first.tzinfo is None and second.tzinfo is None:
        return first, second
    if first.tzinfo is None:
        first = first.replace(tzinfo=second.tzinfo)
    elif second.tzinfo is None:
        second = second.replace(tzinfo=first.tzinfo)
    return first, second


def _parse_hhmm(hhmm: str) -> tuple[int, int]:
    """Parse ``"HH:MM"`` into ``(hour, minute)``, raising ``ValueError``."""
    try:
        hour_text, minute_text = str(hhmm).split(":")
        hour, minute = int(hour_text), int(minute_text)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"Invalid HH:MM time value: {hhmm!r}") from exc
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise ValueError(f"Invalid HH:MM time value: {hhmm!r}")
    return hour, minute


def _parse_iso(value: object) -> datetime | None:
    """Parse a stored ISO timestamp; return ``None`` when unusable/absent."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        LOGGER.warning("Ignoring unparseable task_state timestamp %r", value)
        return None


# ---------------------------------------------------------------------------
# Pure due calculations
# ---------------------------------------------------------------------------


def should_run(
    *,
    last_run_at: datetime | None,
    interval_seconds: int,
    now: datetime,
) -> bool:
    """Return True when an interval task is due at *now*.

    ``last_run_at is None`` means the task never ran, which is always due.
    A non-positive interval means "every cycle".  Clock skew (a ``last_run_at``
    in the future) yields ``False`` rather than running early.
    """
    if last_run_at is None:
        return True
    if interval_seconds <= 0:
        return True
    last_run_at, now = _align_pair(last_run_at, now)
    return now - last_run_at >= timedelta(seconds=interval_seconds)


def compute_daily_fire(now_local: datetime, hhmm: str) -> datetime:
    """Return the next daily fire time at *hhmm* (``"HH:MM"``).

    Today's occurrence is returned when it is still in the future, otherwise
    tomorrow's.  The result keeps ``now_local``'s timezone and has
    second/microsecond zeroed.
    """
    hour, minute = _parse_hhmm(hhmm)
    target = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now_local:
        target += timedelta(days=1)
    return target


def compute_weekly_fire(now_local: datetime, weekday: int, hhmm: str) -> datetime:
    """Return the next weekly fire time.

    *weekday* follows :meth:`datetime.datetime.weekday` semantics (0 = Monday).
    A same-day occurrence still in the future is used; otherwise the next
    week's occurrence is returned.
    """
    if not 0 <= weekday <= 6:
        raise ValueError(f"weekday must be in 0..6, got {weekday!r}")
    hour, minute = _parse_hhmm(hhmm)
    days_ahead = (weekday - now_local.weekday()) % 7
    target = (now_local + timedelta(days=days_ahead)).replace(
        hour=hour, minute=minute, second=0, microsecond=0
    )
    if target <= now_local:
        target += timedelta(days=7)
    return target


def is_report_due(
    *,
    last_run_at: datetime | None,
    target_local: datetime,
    now_local: datetime,
) -> bool:
    """Return True when a scheduled report for *target_local* must be sent.

    A report is due when

    * it has never been sent (``last_run_at is None``) — a fresh install /
      brand-new task must produce a report rather than silently waiting for a
      whole period, or
    * the last run predates the target and the target has already passed
      (``last_run_at < target_local <= now_local``) — a missed report fires
      once.

    A report already sent for that target (``last_run_at >= target_local``) or
    a target still in the future is never due, so nothing is sent twice.
    """
    if last_run_at is None:
        return True
    target_local, now_local = _align_pair(target_local, now_local)
    last_run_at, target_local = _align_pair(last_run_at, target_local)
    return last_run_at < target_local <= now_local


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------


@dataclass
class ScheduledTask:
    """One task the :class:`Scheduler` can run.

    ``interval_seconds`` is used for plain interval tasks.  ``target_time`` is
    an optional extension for report tasks: given a *reference* local time it
    returns the first scheduled occurrence strictly after it (exactly what
    :func:`compute_daily_fire` / :func:`compute_weekly_fire` compute), which
    switches the due check from :func:`should_run` to :func:`is_report_due`.
    It is a keyword-only field with a default so the documented
    ``ScheduledTask(name, interval, func)`` constructor keeps working
    unchanged.
    """

    name: str
    interval_seconds: int
    func: Callable[[], None]
    target_time: Callable[[datetime], datetime] | None = None


class Scheduler:
    """Run due tasks, persisting ``last_run_at`` in the ``task_state`` table.

    Parameters
    ----------
    tasks:
        Tasks to consider, in order.
    db_path:
        SQLite database holding ``task_state`` (shared with the rest of the
        application).
    tz:
        Timezone used to interpret naive clock values and report targets.
    clock:
        Injectable clock returning "now".  Defaults to :func:`datetime.now`
        (naive local wall time).  Tests pass a fixed value.
    tick_seconds:
        Optional override for the background-loop granularity (defaults to the
        smallest positive task interval, capped at 60 s).
    """

    def __init__(
        self,
        tasks: list[ScheduledTask],
        *,
        db_path: Path,
        tz: tzinfo,
        clock: Callable[[], datetime] = datetime.now,
        tick_seconds: float | None = None,
    ) -> None:
        self._tasks = list(tasks)
        self._db_path = Path(db_path)
        self._tz = tz
        self._clock = clock
        self._tick_seconds = tick_seconds or self._default_tick(self._tasks)
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._run_lock = threading.Lock()

    # -- public API --------------------------------------------------------

    def run_pending(self) -> list[str]:
        """Run every task that is due; return the names of the tasks invoked.

        Each task's state is read before deciding, so a task never runs twice
        within one call.  A failing task is logged and recorded, does not
        prevent later tasks from running, and is still listed as invoked (its
        outcome is in ``task_state.last_result``).
        """
        invoked: list[str] = []
        with self._run_lock:
            now = _normalize(self._clock(), self._tz)
            for task in self._tasks:
                last_run_at = self._last_run_at(task.name)
                if not self._is_due(task, last_run_at, now):
                    continue

                invoked.append(task.name)
                try:
                    task.func()
                except Exception as exc:  # noqa: BLE001 - isolate task failures
                    LOGGER.exception("Scheduled task %r failed", task.name)
                    self._record(task.name, now, self._describe_error(exc))
                    continue

                self._record(task.name, now, "ok")

        return invoked

    def start(self) -> None:
        """Start the background loop (idempotent)."""
        with self._run_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._loop, name="servermanage-scheduler", daemon=True
            )
            self._thread.start()

    def stop(self) -> None:
        """Signal the loop to stop and join the worker thread."""
        self._stop_event.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=_STOP_JOIN_TIMEOUT_SECONDS)
            if thread.is_alive():
                LOGGER.warning(
                    "Scheduler thread did not stop within %.1fs",
                    _STOP_JOIN_TIMEOUT_SECONDS,
                )
            self._thread = None

    # -- internals ---------------------------------------------------------

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            started = time.monotonic()
            try:
                self.run_pending()
            except Exception:  # noqa: BLE001 - the loop must never die
                LOGGER.exception("Scheduler cycle failed")
            elapsed = time.monotonic() - started
            wait = max(0.0, self._tick_seconds - elapsed)
            if self._stop_event.wait(wait):
                return

    def _is_due(
        self,
        task: ScheduledTask,
        last_run_at: datetime | None,
        now: datetime,
    ) -> bool:
        if task.target_time is not None:
            # The target is the first occurrence after the last run: that is
            # the slot which may have been missed.  With no state yet the
            # task is due regardless, so any reference time is fine.
            reference = last_run_at if last_run_at is not None else now
            target_local = _normalize(task.target_time(reference), self._tz)
            return is_report_due(
                last_run_at=last_run_at,
                target_local=target_local,
                now_local=now,
            )
        return should_run(
            last_run_at=last_run_at,
            interval_seconds=task.interval_seconds,
            now=now,
        )

    def _last_run_at(self, name: str) -> datetime | None:
        try:
            state = storage.get_task_state(name, self._db_path)
        except sqlite3.Error:
            # Cannot read the state: treat the task as never run so it is not
            # skipped permanently by a transient database problem.
            LOGGER.exception("Failed to read task_state for %r", name)
            return None
        if not state:
            return None
        parsed = _parse_iso(state.get("last_run_at"))
        return _normalize(parsed, self._tz) if parsed is not None else None

    def _record(self, name: str, now: datetime, result: str) -> None:
        try:
            storage.set_task_state(
                name,
                self._db_path,
                last_run_at=now.isoformat(),
                last_result=result[:_MAX_RESULT_LENGTH],
            )
        except sqlite3.Error:
            LOGGER.exception("Failed to record task_state for %r", name)

    @staticmethod
    def _describe_error(exc: BaseException) -> str:
        return f"error: {type(exc).__name__}: {exc}"

    @staticmethod
    def _default_tick(tasks: list[ScheduledTask]) -> float:
        positive = [
            float(task.interval_seconds)
            for task in tasks
            if task.interval_seconds and task.interval_seconds > 0
        ]
        base = min(positive) if positive else _MAX_TICK_SECONDS
        return max(_MIN_TICK_SECONDS, min(base, _MAX_TICK_SECONDS))
