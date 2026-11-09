"""Task 4 tests: user account alert rules and recovery skipping.

Pure rule tests plus the ``AlertEngine.resolve_missing`` ``skip_prefixes``
behaviour.  No SSH, no network, no filesystem beyond a temporary SQLite file.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from servermanage.alerts import AlertEngine, evaluate_user_alerts
from servermanage.disk_health import AlertEvent
from servermanage.models import AlertsConfig, HostUserAccount
from servermanage.storage import find_latest_alert, list_alerts

BASE = datetime(2026, 11, 9, 2, 0, 0, tzinfo=timezone.utc)


def make_account(**overrides) -> HostUserAccount:
    """Build a healthy lab account; override only the field under test."""
    data = {
        "host_name": "gpu-01",
        "username": "alice",
        "uid": 1000,
        "gid": 1000,
        "primary_group": "alice",
        "home": "/home/alice",
        "groups": ["alice", "docker"],
        "in_docker": True,
        "home_exists": True,
        "home_owner": "alice",
        "data_exists": True,
        "data_owner": "alice",
        "data_supported": True,
    }
    data.update(overrides)
    return HostUserAccount(**data)


def _fingerprints(events: list[AlertEvent]) -> list[str]:
    return [event.fingerprint for event in events]


# ---------------------------------------------------------------------------
# evaluate_user_alerts — missing accounts
# ---------------------------------------------------------------------------


def test_missing_account_emits_only_user_present():
    # Directory/group data is frozen at the last known values; a missing
    # account must not be judged on stale state.
    account = make_account(
        in_docker=False,
        home_exists=False,
        home_owner=None,
        data_exists=False,
        data_owner=None,
    )

    events = evaluate_user_alerts(account, in_baseline=True, missing=True)

    assert _fingerprints(events) == ["user-present:gpu-01:alice"]
    event = events[0]
    assert event.category == "user"
    assert event.severity == "warning"
    assert event.title == "账号缺失"
    assert "gpu-01" in event.message
    assert "alice" in event.message


def test_missing_account_ignores_in_baseline_flag():
    account = make_account()

    events = evaluate_user_alerts(account, in_baseline=False, missing=True)

    assert _fingerprints(events) == ["user-present:gpu-01:alice"]


# ---------------------------------------------------------------------------
# evaluate_user_alerts — new accounts (transition alert)
# ---------------------------------------------------------------------------


def test_new_healthy_account_emits_only_user_added():
    events = evaluate_user_alerts(
        make_account(), in_baseline=False, missing=False
    )

    assert _fingerprints(events) == ["user-added:gpu-01:alice"]
    event = events[0]
    assert event.category == "user"
    assert event.severity == "warning"
    assert event.title == "发现新账号"
    assert "gpu-01" in event.message
    assert "alice" in event.message


def test_new_account_emits_user_added_plus_true_state_alarms():
    events = evaluate_user_alerts(
        make_account(in_docker=False), in_baseline=False, missing=False
    )

    assert _fingerprints(events) == [
        "user-added:gpu-01:alice",
        "user-docker:gpu-01:alice",
    ]


# ---------------------------------------------------------------------------
# evaluate_user_alerts — healthy existing accounts
# ---------------------------------------------------------------------------


def test_healthy_existing_account_emits_nothing():
    assert evaluate_user_alerts(make_account(), in_baseline=True, missing=False) == []


# ---------------------------------------------------------------------------
# evaluate_user_alerts — state alarms
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "fingerprint", "title"),
    [
        (
            {"in_docker": False},
            "user-docker:gpu-01:alice",
            "未加入 docker 组",
        ),
        (
            {"home_exists": False, "home_owner": None},
            "user-home:gpu-01:alice",
            "家目录缺失",
        ),
        (
            {"data_exists": False, "data_owner": None},
            "user-data:gpu-01:alice",
            "数据目录缺失",
        ),
        (
            {"home_owner": "root"},
            "user-config:gpu-01:alice",
            "目录所有者异常",
        ),
        (
            {"data_owner": "root"},
            "user-config:gpu-01:alice",
            "目录所有者异常",
        ),
    ],
)
def test_state_violation_emits_expected_fingerprint(overrides, fingerprint, title):
    events = evaluate_user_alerts(
        make_account(**overrides), in_baseline=True, missing=False
    )

    assert _fingerprints(events) == [fingerprint]
    event = events[0]
    assert event.title == title
    assert event.category == "user"
    assert event.severity == "warning"
    assert event.host_name == "gpu-01"
    assert "gpu-01" in event.message
    assert "alice" in event.message


def test_data_supported_false_suppresses_user_data():
    account = make_account(data_supported=False, data_exists=False, data_owner=None)

    events = evaluate_user_alerts(account, in_baseline=True, missing=False)

    assert events == []


def test_data_supported_false_ignores_data_owner_mismatch():
    # A host without /data cannot own /data/<user>; stale owner data must not
    # produce a user-config event.
    account = make_account(data_supported=False, data_exists=True, data_owner="root")

    events = evaluate_user_alerts(account, in_baseline=True, missing=False)

    assert events == []


def test_missing_home_does_not_compare_home_owner():
    account = make_account(home_exists=False, home_owner="root")

    events = evaluate_user_alerts(account, in_baseline=True, missing=False)

    assert _fingerprints(events) == ["user-home:gpu-01:alice"]


def test_owner_mismatch_emits_exactly_one_user_config_for_both_dirs():
    account = make_account(home_owner="root", data_owner="root")

    events = evaluate_user_alerts(account, in_baseline=True, missing=False)

    assert _fingerprints(events) == ["user-config:gpu-01:alice"]


def test_all_fields_use_account_host_and_username():
    account = make_account(
        host_name="gpu-02",
        username="bob",
        uid=1001,
        gid=1001,
        in_docker=False,
        home="/home/bob",
        home_owner="root",
    )

    events = evaluate_user_alerts(account, in_baseline=True, missing=False)

    assert _fingerprints(events) == [
        "user-docker:gpu-02:bob",
        "user-config:gpu-02:bob",
    ]
    assert all(event.category == "user" for event in events)
    assert all(event.severity == "warning" for event in events)
    assert all(event.host_name == "gpu-02" for event in events)


# ---------------------------------------------------------------------------
# AlertEngine.resolve_missing — skip_prefixes
# ---------------------------------------------------------------------------


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
    fingerprint: str,
    *,
    title: str,
    host_name: str = "gpu-01",
) -> AlertEvent:
    return AlertEvent(
        host_name=host_name,
        category="user",
        severity="warning",
        title=title,
        message=f"message for {fingerprint}",
        fingerprint=fingerprint,
    )


def _engine(db_path: Path, notifier: BatchNotifier) -> AlertEngine:
    return AlertEngine(
        db_path,
        AlertsConfig(),
        notifier,
        clock=FakeClock(),
    )


def _open_fingerprints(db_path: Path) -> set[str]:
    return {
        str(row["fingerprint"])
        for row in list_alerts(db_path, status="active")
    }


def test_resolve_missing_skip_prefixes_keeps_transition_alert_open(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    engine.process(
        [
            _event(
                "user-added:gpu-01:alice",
                title="发现新账号",
            ),
            _event(
                "user-docker:gpu-01:alice",
                title="未加入 docker 组",
            ),
        ]
    )
    notifier.calls.clear()
    notifier.batch_calls.clear()

    recovered = engine.resolve_missing(
        "gpu-01",
        set(),
        category="user",
        skip_prefixes=("user-added",),
        notify=True,
    )

    # Exactly one recovery event: the skipped row contributes no category.
    assert _fingerprints(recovered) == ["recovery:gpu-01:user"]
    assert _open_fingerprints(db_path) == {
        "user-added:gpu-01:alice",
        "recovery:gpu-01:user",
    }
    resolved = {
        str(row["fingerprint"])
        for row in list_alerts(db_path, status="resolved")
    }
    assert resolved == {"user-docker:gpu-01:alice"}
    assert find_latest_alert("user-added:gpu-01:alice", db_path)["status"] == "active"


def test_resolve_missing_without_skip_prefixes_closes_user_added(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    engine.process(
        [
            _event("user-added:gpu-01:alice", title="发现新账号"),
            _event("user-docker:gpu-01:alice", title="未加入 docker 组"),
        ]
    )

    recovered = engine.resolve_missing(
        "gpu-01", set(), category="user", notify=False
    )

    assert _fingerprints(recovered) == ["recovery:gpu-01:user"]
    resolved = {
        str(row["fingerprint"])
        for row in list_alerts(db_path, status="resolved")
    }
    assert resolved == {
        "user-added:gpu-01:alice",
        "user-docker:gpu-01:alice",
    }


def test_resolve_missing_skip_prefixes_does_not_close_other_categories(
    tmp_path: Path,
):
    db_path = tmp_path / "monitor.db"
    notifier = BatchNotifier()
    engine = _engine(db_path, notifier)
    system_event = AlertEvent(
        host_name="gpu-01",
        category="system",
        severity="warning",
        title="CPU 使用率过高",
        message="主机 gpu-01 CPU 使用率 99%",
        fingerprint="system:gpu-01:cpu",
    )
    engine.process(
        [
            system_event,
            _event("user-added:gpu-01:alice", title="发现新账号"),
        ]
    )

    recovered = engine.resolve_missing(
        "gpu-01",
        set(),
        category="user",
        skip_prefixes=("user-added",),
        notify=False,
    )

    assert recovered == []
    assert _open_fingerprints(db_path) == {
        "system:gpu-01:cpu",
        "user-added:gpu-01:alice",
    }
