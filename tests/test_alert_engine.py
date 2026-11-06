from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.alerts import AlertEngine
from servermanage.disk_health import AlertEvent
from servermanage.models import AlertsConfig
from servermanage.storage import find_latest_alert, list_alerts

BASE = datetime(2026, 11, 6, 2, 0, 0, tzinfo=timezone.utc)


class FakeClock:
    """Deterministic clock: tests advance it explicitly."""

    def __init__(self, current: datetime = BASE) -> None:
        self.current = current

    def __call__(self) -> datetime:
        return self.current

    def advance(self, **kwargs: float) -> None:
        self.current += timedelta(**kwargs)


class FakeNotifier:
    """Records ``dispatch`` calls and returns a fixed channel list."""

    def __init__(self, channels: list[str] | None = None) -> None:
        self.channels = list(channels) if channels is not None else ["desktop", "email"]
        self.calls: list[tuple[AlertEvent, AlertsConfig]] = []

    def dispatch(self, event: AlertEvent, config: AlertsConfig) -> list[str]:
        self.calls.append((event, config))
        return list(self.channels)


def _event(
    fingerprint: str = "system:gpu-01:cpu",
    *,
    host_name: str = "gpu-01",
    category: str = "system",
    title: str = "CPU 使用率过高",
) -> AlertEvent:
    return AlertEvent(
        host_name=host_name,
        category=category,
        severity="warning",
        title=title,
        message="cpu over threshold",
        fingerprint=fingerprint,
    )


def _engine(
    db_path: Path,
    clock: FakeClock,
    notifier: FakeNotifier,
    config: AlertsConfig | None = None,
) -> AlertEngine:
    return AlertEngine(db_path, config or AlertsConfig(), notifier, clock=clock)


# ---------------------------------------------------------------------------
# Core dedupe / cooldown behaviour
# ---------------------------------------------------------------------------


def test_first_event_notified(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier)

    result = engine.process([_event()])

    assert result == [_event()]
    assert len(notifier.calls) == 1
    rows = list_alerts(db_path)
    assert len(rows) == 1
    assert rows[0]["status"] == "active"
    assert rows[0]["notified_channels"] == "desktop,email"
    assert rows[0]["created_at"] == BASE.isoformat()


def test_duplicate_within_cooldown_skipped(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier)
    event = _event()

    assert engine.process([event]) == [event]

    clock.advance(minutes=10)
    assert engine.process([event]) == []

    assert len(notifier.calls) == 1
    assert len(list_alerts(db_path)) == 1


def test_notify_after_cooldown(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier)
    event = _event()

    assert engine.process([event]) == [event]

    clock.advance(minutes=61)
    assert engine.process([event]) == [event]

    assert len(notifier.calls) == 2
    assert len(list_alerts(db_path)) == 2


def test_error_increase_breaks_cooldown(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier)
    event = _event("disk:gpu-01:c0:e252:s3:media_errors:error_increase")

    assert engine.process([event]) == [event]

    clock.advance(minutes=5)
    assert engine.process([event]) == [event]

    assert len(notifier.calls) == 2
    assert len(list_alerts(db_path)) == 2


def test_cooldown_survives_restart(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    first_notifier = FakeNotifier()
    first_engine = _engine(db_path, clock, first_notifier)
    event = _event()

    assert first_engine.process([event]) == [event]

    # A brand-new engine over the same DB must reuse the persisted cooldown.
    clock.advance(minutes=5)
    second_notifier = FakeNotifier()
    second_engine = _engine(db_path, clock, second_notifier)
    assert second_engine.process([event]) == []

    assert second_notifier.calls == []
    assert len(list_alerts(db_path)) == 1


# ---------------------------------------------------------------------------
# Resolution lifecycle
# ---------------------------------------------------------------------------


def test_resolve_marks_active_alerts_resolved(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier)

    engine.process([_event()])
    engine.resolve("gpu-01", "system")

    latest = find_latest_alert("system:gpu-01:cpu", db_path)
    assert latest is not None
    assert latest["status"] == "resolved"

    # Once resolved, the next occurrence is a fresh condition and may notify.
    clock.advance(minutes=5)
    assert engine.process([_event()]) == [_event()]
    assert len(notifier.calls) == 2


def test_resolve_only_touches_matching_host_and_category(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier)

    engine.process(
        [
            _event("system:gpu-01:cpu", host_name="gpu-01", category="system"),
            _event("system:gpu-02:cpu", host_name="gpu-02", category="system"),
            _event("disk:gpu-01:c0:s0:media_errors", host_name="gpu-01", category="disk"),
        ]
    )
    engine.resolve("gpu-01", "system")

    statuses = {
        row["fingerprint"]: row["status"] for row in list_alerts(db_path)
    }
    assert statuses["system:gpu-01:cpu"] == "resolved"
    assert statuses["system:gpu-02:cpu"] == "active"
    assert statuses["disk:gpu-01:c0:s0:media_errors"] == "active"


def test_resolve_missing_resolves_only_conditions_that_cleared(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier)

    engine.process(
        [
            _event("system:gpu-01:cpu"),
            _event("system:gpu-01:memory", title="内存使用率过高"),
        ]
    )
    # This cycle only CPU still fires; memory has cleared.
    engine.resolve_missing("gpu-01", {"system:gpu-01:cpu"}, category="system")

    statuses = {row["fingerprint"]: row["status"] for row in list_alerts(db_path)}
    assert statuses["system:gpu-01:cpu"] == "active"
    assert statuses["system:gpu-01:memory"] == "resolved"


def test_resolve_missing_can_be_scoped_by_category(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier)

    engine.process(
        [
            _event("system:gpu-01:cpu"),
            _event("disk:gpu-01:c0:s0:media_errors", category="disk"),
        ]
    )
    # Only system rules were evaluated this cycle; the disk alert must survive.
    engine.resolve_missing("gpu-01", set(), category="system")

    statuses = {row["fingerprint"]: row["status"] for row in list_alerts(db_path)}
    assert statuses["system:gpu-01:cpu"] == "resolved"
    assert statuses["disk:gpu-01:c0:s0:media_errors"] == "active"


# ---------------------------------------------------------------------------
# Return-value semantics and graceful degradation
# ---------------------------------------------------------------------------


def test_process_returns_only_channels_that_were_notified(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier(channels=[])
    engine = _engine(db_path, clock, notifier)
    event = _event()

    assert engine.process([event]) == []
    # The occurrence is still persisted for dedupe even if no channel accepted it.
    assert len(list_alerts(db_path)) == 1
    assert list_alerts(db_path)[0]["notified_channels"] == ""


def test_disabled_alerts_config_is_a_noop(tmp_path: Path):
    db_path = tmp_path / "servermanage.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier, AlertsConfig(enabled=False))

    assert engine.process([_event()]) == []
    assert notifier.calls == []
    assert list_alerts(db_path) == []


def test_db_error_does_not_raise(tmp_path: Path):
    # Pointing at a directory makes sqlite3.connect fail; the engine must
    # degrade gracefully instead of breaking the polling cycle.
    db_path = tmp_path
    clock = FakeClock()
    notifier = FakeNotifier()
    engine = _engine(db_path, clock, notifier)

    assert engine.process([_event()]) == []
    assert notifier.calls == []
