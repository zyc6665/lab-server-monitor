from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.alerts import AlertEngine, SilenceRegistry
from servermanage.disk_health import AlertEvent
from servermanage.models import AlertsConfig
from servermanage.storage import list_alerts

BASE = datetime(2026, 11, 6, 2, 0, 0, tzinfo=timezone.utc)


class FakeClock:
    def __init__(self, current: datetime = BASE) -> None:
        self.current = current

    def __call__(self) -> datetime:
        return self.current

    def advance(self, **kwargs: float) -> None:
        self.current += timedelta(**kwargs)


class FakeNotifier:
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


def _insert_silence(
    db_path: Path,
    *,
    scope_type: str,
    scope: str | None,
    starts: datetime = BASE - timedelta(hours=1),
    ends: datetime = BASE + timedelta(hours=1),
    reason: str = "maintenance",
) -> int:
    return storage.insert_silence(
        scope_type,
        scope,
        reason,
        starts,
        ends,
        "tester",
        db_path,
    )


# ---------------------------------------------------------------------------
# SilenceRegistry matching / precedence
# ---------------------------------------------------------------------------


def test_registry_matches_host_scope(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    silence_id = _insert_silence(
        db_path, scope_type="host", scope="gpu-01"
    )
    registry = SilenceRegistry(db_path, clock=FakeClock())

    hit = registry.active_for("gpu-01", [], BASE)

    assert hit is not None
    assert hit["id"] == silence_id
    assert hit["scope_type"] == "host"
    assert registry.active_for("gpu-02", [], BASE) is None


def test_registry_matches_group_scope(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _insert_silence(db_path, scope_type="group", scope="lab")
    registry = SilenceRegistry(db_path, clock=FakeClock())

    assert registry.active_for("gpu-01", ["lab"], BASE) is not None
    assert registry.active_for("gpu-01", ["other"], BASE) is None


def test_registry_all_scope_wins_over_group_and_host(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    all_id = _insert_silence(db_path, scope_type="all", scope=None)
    _insert_silence(db_path, scope_type="group", scope="lab")
    _insert_silence(db_path, scope_type="host", scope="gpu-01")
    registry = SilenceRegistry(db_path, clock=FakeClock())

    hit = registry.active_for("gpu-01", ["lab"], BASE)

    assert hit is not None
    assert hit["id"] == all_id
    assert hit["scope_type"] == "all"


def test_registry_group_scope_wins_over_host(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    group_id = _insert_silence(db_path, scope_type="group", scope="lab")
    _insert_silence(db_path, scope_type="host", scope="gpu-01")
    registry = SilenceRegistry(db_path, clock=FakeClock())

    hit = registry.active_for("gpu-01", ["lab"], BASE)

    assert hit is not None
    assert hit["id"] == group_id
    assert hit["scope_type"] == "group"


def test_registry_ignores_expired_and_future_windows(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _insert_silence(
        db_path,
        scope_type="host",
        scope="gpu-01",
        starts=BASE - timedelta(hours=3),
        ends=BASE - timedelta(hours=1),
    )
    _insert_silence(
        db_path,
        scope_type="host",
        scope="gpu-02",
        starts=BASE + timedelta(hours=1),
        ends=BASE + timedelta(hours=2),
    )
    registry = SilenceRegistry(db_path, clock=FakeClock())

    assert registry.active_for("gpu-01", [], BASE) is None
    assert registry.active_for("gpu-02", [], BASE) is None


def test_registry_reads_storage_each_call(tmp_path: Path):
    """A silence added after construction must apply without a new registry."""
    db_path = tmp_path / "monitor.db"
    registry = SilenceRegistry(db_path, clock=FakeClock())
    assert registry.active_for("gpu-01", [], BASE) is None

    _insert_silence(db_path, scope_type="host", scope="gpu-01")

    assert registry.active_for("gpu-01", [], BASE) is not None


# ---------------------------------------------------------------------------
# AlertEngine suppression: no persist, no dispatch
# ---------------------------------------------------------------------------


def test_silenced_event_is_not_persisted_or_dispatched(tmp_path: Path, caplog):
    db_path = tmp_path / "monitor.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    _insert_silence(db_path, scope_type="host", scope="gpu-01")
    registry = SilenceRegistry(db_path, clock=clock)
    engine = AlertEngine(
        db_path,
        AlertsConfig(),
        notifier,
        clock=clock,
        silence_checker=registry,
    )

    with caplog.at_level(logging.INFO):
        result = engine.process([_event()])

    assert result == []
    assert notifier.calls == []
    assert notifier.batch_calls == []
    assert list_alerts(db_path) == []
    assert any(
        "alert suppressed by silence" in record.getMessage()
        for record in caplog.records
    )


def test_unsilenced_event_still_persisted_and_dispatched(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    registry = SilenceRegistry(db_path, clock=clock)
    engine = AlertEngine(
        db_path,
        AlertsConfig(),
        notifier,
        clock=clock,
        silence_checker=registry,
    )

    result = engine.process([_event()])

    assert result == [_event()]
    assert len(notifier.calls) == 1
    assert len(list_alerts(db_path)) == 1


def test_silence_hit_does_not_block_other_hosts(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    clock = FakeClock()
    notifier = FakeNotifier()
    _insert_silence(db_path, scope_type="host", scope="gpu-01")
    registry = SilenceRegistry(db_path, clock=clock)
    engine = AlertEngine(
        db_path,
        AlertsConfig(),
        notifier,
        clock=clock,
        silence_checker=registry,
    )

    silenced = _event("system:gpu-01:cpu", host_name="gpu-01")
    loud = _event("system:gpu-02:cpu", host_name="gpu-02")
    result = engine.process([silenced, loud])

    assert result == [loud]
    assert [row["host_name"] for row in list_alerts(db_path)] == ["gpu-02"]
