from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.alerts import AlertEngine, SilenceRegistry
from servermanage.disk_health import AlertEvent
from servermanage.models import AlertsConfig
from servermanage.storage import find_latest_alert, list_alerts

BASE = datetime(2026, 11, 6, 2, 0, 0, tzinfo=timezone.utc)


class FakeClock:
    def __init__(self, current: datetime = BASE) -> None:
        self.current = current

    def __call__(self) -> datetime:
        return self.current

    def advance(self, **kwargs: float) -> None:
        self.current += timedelta(**kwargs)


class BatchNotifier:
    def __init__(self, channels: list[str] | None = None) -> None:
        self.channels = list(channels) if channels is not None else ["desktop", "email"]
        self.calls: list[AlertEvent] = []
        self.batch_calls: list[list[AlertEvent]] = []

    def dispatch(self, event: AlertEvent, config: AlertsConfig) -> list[str]:
        self.calls.append(event)
        return list(self.channels)

    def dispatch_batch(
        self, events: list[AlertEvent], config: AlertsConfig
    ) -> list[str]:
        events = list(events)
        self.batch_calls.append(events)
        return list(self.channels)


def _event(
    fingerprint: str = "system:gpu-01:cpu",
    *,
    host_name: str = "gpu-01",
    category: str = "system",
    severity: str = "warning",
) -> AlertEvent:
    return AlertEvent(
        host_name=host_name,
        category=category,
        severity=severity,
        title=f"{category} problem",
        message=f"message for {fingerprint}",
        fingerprint=fingerprint,
    )


def _engine(
    db_path: Path,
    notifier: BatchNotifier,
    *,
    config: AlertsConfig | None = None,
    registry: SilenceRegistry | None = None,
    clock: FakeClock | None = None,
) -> AlertEngine:
    return AlertEngine(
        db_path,
        config or AlertsConfig(),
        notifier,
        clock=clock or FakeClock(),
        silence_checker=registry,
    )


# ---------------------------------------------------------------------------
# resolve
# ---------------------------------------------------------------------------


def test_resolve_notifies_once_and_returns_recovery_event(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    engine.process([_event()])
    notifier.calls.clear()
    notifier.batch_calls.clear()

    recovered = engine.resolve("gpu-01", "system", notify=True)

    assert len(recovered) == 1
    event = recovered[0]
    assert event.fingerprint == "recovery:gpu-01:system"
    assert event.category == "system"
    assert event.severity == "info"
    assert notifier.calls == [event]
    assert notifier.batch_calls == []

    # Second resolve has no open rows to close -> no duplicate recovery event.
    assert engine.resolve("gpu-01", "system", notify=True) == []
    assert notifier.calls == [event]
    assert find_latest_alert("recovery:gpu-01:system", db_path) is not None


def test_resolve_with_no_open_rows_returns_empty(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)

    assert engine.resolve("gpu-01", "system", notify=True) == []
    assert notifier.calls == []
    assert notifier.batch_calls == []


def test_resolve_notify_false_closes_rows_without_dispatch(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    engine.process([_event()])
    notifier.calls.clear()

    recovered = engine.resolve("gpu-01", "system", notify=False)

    assert len(recovered) == 1
    assert notifier.calls == []
    assert find_latest_alert("recovery:gpu-01:system", db_path) is None


def test_resolve_default_notifies_for_batch_capable_notifier(tmp_path: Path):
    """A notifier implementing dispatch_batch opts into default recovery alerts."""
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    engine.process([_event()])
    notifier.calls.clear()

    recovered = engine.resolve("gpu-01", "system")

    assert len(recovered) == 1
    assert notifier.calls == recovered
    assert find_latest_alert("recovery:gpu-01:system", db_path) is not None


def test_resolve_notify_on_recovery_false_disables_dispatch(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    config = AlertsConfig(notify_on_recovery=False)
    engine = _engine(db_path, notifier, config=config)
    engine.process([_event()])
    notifier.calls.clear()
    notifier.batch_calls.clear()

    recovered = engine.resolve("gpu-01", "system", notify=True)

    assert len(recovered) == 1
    assert notifier.calls == []
    assert notifier.batch_calls == []


def test_resolve_does_not_touch_other_hosts_or_categories(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    engine.process(
        [
            _event("system:gpu-01:cpu", host_name="gpu-01", category="system"),
            _event("disk:gpu-01:sda", host_name="gpu-01", category="disk"),
            _event("system:gpu-02:cpu", host_name="gpu-02", category="system"),
        ]
    )
    notifier.calls.clear()
    notifier.batch_calls.clear()

    recovered = engine.resolve("gpu-01", "system", notify=True)

    assert [event.fingerprint for event in recovered] == ["recovery:gpu-01:system"]
    open_rows = list_alerts(db_path, status="active")
    assert {row["fingerprint"] for row in open_rows} == {
        "disk:gpu-01:sda",
        "system:gpu-02:cpu",
        "recovery:gpu-01:system",
    }


# ---------------------------------------------------------------------------
# resolve_missing
# ---------------------------------------------------------------------------


def test_resolve_missing_generates_one_recovery_per_category(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    engine.process(
        [
            _event("system:gpu-01:cpu", category="system"),
            _event("system:gpu-01:memory", category="system"),
            _event("disk:gpu-01:sda", category="disk"),
        ]
    )
    notifier.calls.clear()
    notifier.batch_calls.clear()

    recovered = engine.resolve_missing("gpu-01", set(), notify=True)

    assert {event.fingerprint for event in recovered} == {
        "recovery:gpu-01:system",
        "recovery:gpu-01:disk",
    }
    assert len(recovered) == 2
    # Both recovery events share a host, so they are aggregated once.
    assert len(notifier.batch_calls) == 1
    assert len(notifier.batch_calls[0]) == 2


def test_resolve_missing_only_keeps_matching_fingerprints(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    engine.process(
        [
            _event("system:gpu-01:cpu", category="system"),
            _event("system:gpu-01:memory", category="system"),
        ]
    )
    notifier.calls.clear()
    notifier.batch_calls.clear()

    recovered = engine.resolve_missing(
        "gpu-01", {"system:gpu-01:cpu"}, category="system", notify=True
    )

    assert [event.fingerprint for event in recovered] == ["recovery:gpu-01:system"]
    active = list_alerts(db_path, status="active")
    assert {row["fingerprint"] for row in active} == {
        "system:gpu-01:cpu",
        "recovery:gpu-01:system",
    }


def test_resolve_missing_no_open_rows_returns_empty(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)

    assert engine.resolve_missing("gpu-01", set(), notify=True) == []
    assert notifier.calls == []


def test_resolve_missing_notify_false_skips_dispatch(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    engine.process([_event()])
    notifier.calls.clear()

    recovered = engine.resolve_missing("gpu-01", set(), notify=False)

    assert len(recovered) == 1
    assert notifier.calls == []


# ---------------------------------------------------------------------------
# Recovery + silence
# ---------------------------------------------------------------------------


def test_silenced_recovery_is_not_dispatched(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    clock = FakeClock()
    notifier = BatchNotifier()
    registry = SilenceRegistry(db_path, clock=clock)
    engine = _engine(db_path, notifier, registry=registry, clock=clock)
    engine.process([_event()])
    notifier.calls.clear()

    storage.insert_silence(
        "host",
        "gpu-01",
        "maintenance",
        BASE - timedelta(hours=1),
        BASE + timedelta(hours=1),
        "tester",
        db_path,
    )

    recovered = engine.resolve("gpu-01", "system", notify=True)

    assert len(recovered) == 1
    assert notifier.calls == []
    assert find_latest_alert("recovery:gpu-01:system", db_path) is None
