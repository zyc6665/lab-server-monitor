from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from servermanage import alerts as alerts_module
from servermanage.alerts import AlertEngine, Notifier
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


class LegacyNotifier:
    """Only knows dispatch -- exercises the backwards-compatible fallback."""

    def __init__(self, channels: list[str] | None = None) -> None:
        self.channels = list(channels) if channels is not None else ["desktop"]
        self.calls: list[AlertEvent] = []

    def dispatch(self, event: AlertEvent, config: AlertsConfig) -> list[str]:
        self.calls.append(event)
        return list(self.channels)


def _event(
    fingerprint: str,
    *,
    host_name: str = "gpu-01",
    category: str = "system",
    severity: str = "warning",
    title: str | None = None,
) -> AlertEvent:
    return AlertEvent(
        host_name=host_name,
        category=category,
        severity=severity,
        title=title or f"{category} alert {fingerprint}",
        message=f"message for {fingerprint}",
        fingerprint=fingerprint,
    )


def _three_same_host() -> list[AlertEvent]:
    return [
        _event("system:gpu-01:cpu", title="CPU 使用率过高"),
        _event("system:gpu-01:memory", title="内存不足", severity="critical"),
        _event("system:gpu-01:load", title="负载过高"),
    ]


# ---------------------------------------------------------------------------
# Engine aggregation
# ---------------------------------------------------------------------------


def test_three_events_same_host_use_one_dispatch_batch(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = AlertEngine(db_path, AlertsConfig(), notifier, clock=FakeClock())
    events = _three_same_host()

    result = engine.process(events)

    assert result == events
    assert len(notifier.batch_calls) == 1
    assert notifier.batch_calls[0] == events
    assert notifier.calls == []

    rows = list_alerts(db_path)
    assert len(rows) == 3
    assert {row["fingerprint"] for row in rows} == {event.fingerprint for event in events}
    assert all(row["notified_channels"] == "desktop,email" for row in rows)


def test_single_event_same_host_uses_dispatch_not_batch(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = AlertEngine(db_path, AlertsConfig(), notifier, clock=FakeClock())
    event = _event("system:gpu-01:cpu")

    result = engine.process([event])

    assert result == [event]
    assert notifier.batch_calls == []
    assert notifier.calls == [event]


def test_events_grouped_per_host(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = AlertEngine(db_path, AlertsConfig(), notifier, clock=FakeClock())
    a1 = _event("system:gpu-01:cpu", host_name="gpu-01")
    a2 = _event("system:gpu-01:memory", host_name="gpu-01")
    b1 = _event("system:gpu-02:cpu", host_name="gpu-02")

    result = engine.process([a1, a2, b1])

    assert result == [a1, a2, b1]
    assert len(notifier.batch_calls) == 1
    assert notifier.batch_calls[0] == [a1, a2]
    assert notifier.calls == [b1]
    assert len(list_alerts(db_path)) == 3


def test_aggregate_by_host_false_dispatches_each_event(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    config = AlertsConfig(aggregate_by_host=False)
    engine = AlertEngine(db_path, config, notifier, clock=FakeClock())
    events = _three_same_host()

    result = engine.process(events)

    assert result == events
    assert notifier.batch_calls == []
    assert notifier.calls == events


def test_legacy_notifier_without_dispatch_batch_still_works(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = LegacyNotifier()
    engine = AlertEngine(db_path, AlertsConfig(), notifier, clock=FakeClock())
    events = _three_same_host()

    result = engine.process(events)

    assert result == events
    assert notifier.calls == events
    assert all(
        row["notified_channels"] == "desktop" for row in list_alerts(db_path)
    )


def test_batch_returns_nothing_when_all_channels_fail(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier(channels=[])
    engine = AlertEngine(db_path, AlertsConfig(), notifier, clock=FakeClock())

    result = engine.process(_three_same_host())

    assert result == []
    rows = list_alerts(db_path)
    assert len(rows) == 3
    assert all(row["notified_channels"] == "" for row in rows)


# ---------------------------------------------------------------------------
# Notifier.dispatch_batch merged message
# ---------------------------------------------------------------------------


def test_dispatch_batch_builds_one_merged_message(tmp_path: Path, monkeypatch):
    captured: dict[str, str] = {}

    def fake_desktop(title, message):
        captured["desktop_title"] = title
        captured["desktop_body"] = message
        return True

    def fake_email(smtp, report):
        captured["email_subject"] = report.subject
        captured["email_body"] = report.text_body
        captured["email_html"] = report.html_body or ""
        return True

    monkeypatch.setattr(alerts_module, "send_desktop_notification", fake_desktop)
    monkeypatch.setattr(alerts_module, "send_report", fake_email)

    config = AlertsConfig(webhook=None)
    notifier = Notifier(smtp=object())
    events = _three_same_host()

    channels = notifier.dispatch_batch(events, config)

    assert channels == ["desktop", "email"]
    assert "gpu-01" in captured["desktop_title"]
    assert "3 项告警" in captured["desktop_title"]
    assert "3 项告警" in captured["email_subject"]
    for event in events:
        assert event.title in captured["desktop_body"]
        assert event.title in captured["email_body"]
    # Highest severity drives the merged severity.
    assert "[critical]" in captured["desktop_title"]


def test_dispatch_batch_channel_failures_are_independent(tmp_path: Path, monkeypatch):
    sent: list[str] = []

    def broken_desktop(title, message):
        raise RuntimeError("desktop exploded")

    def fake_email(smtp, report):
        sent.append("email")
        return True

    monkeypatch.setattr(alerts_module, "send_desktop_notification", broken_desktop)
    monkeypatch.setattr(alerts_module, "send_report", fake_email)

    notifier = Notifier(smtp=object())
    channels = notifier.dispatch_batch(_three_same_host(), AlertsConfig(webhook=None))

    assert channels == ["email"]
    assert sent == ["email"]


def test_dispatch_batch_single_event_delegates_to_dispatch(tmp_path: Path, monkeypatch):
    captured: dict[str, str] = {}

    def fake_desktop(title, message):
        captured["title"] = title
        return True

    monkeypatch.setattr(alerts_module, "send_desktop_notification", fake_desktop)
    config = AlertsConfig(email=False, webhook=None)
    event = _event("system:gpu-01:cpu", title="CPU 使用率过高")

    channels = Notifier().dispatch_batch([event], config)

    assert channels == ["desktop"]
    assert captured["title"] == "[warning] CPU 使用率过高"
