from __future__ import annotations

from datetime import date, timedelta, timezone
from pathlib import Path

import pytest

from servermanage.capacity import (
    build_capacity_forecasts,
    forecast_series,
    linear_slope,
)
from servermanage.models import (
    AlertThresholds,
    AuthConfig,
    HostAlertRules,
    HostConfig,
)


def _series(values: list[float | None], *, start: date = date(2026, 10, 1)) -> list[dict[str, object]]:
    return [
        {"t": (start + timedelta(days=index)).isoformat(), "disk": value}
        for index, value in enumerate(values)
    ]


def test_linear_slope_returns_per_index_growth() -> None:
    assert linear_slope([(0, 50), (1, 60), (2, 70)]) == pytest.approx(10.0)


def test_forecast_series_flags_rising_disk_as_critical() -> None:
    result = forecast_series(_series([50, 53, 57, 60, 63, 67, 70, 73, 77, 80]), "disk", threshold=90)
    assert result["current"] == 80.0
    assert result["slope_per_day"] == pytest.approx(3.35, abs=0.02)
    assert result["days_to_threshold"] == pytest.approx(3.0, abs=0.1)
    assert result["status"] == "critical"


def test_forecast_series_is_stable_when_flat_or_falling() -> None:
    flat = forecast_series(_series([50] * 10), "disk", threshold=90)
    falling = forecast_series(_series([80, 78, 76, 74, 72, 70, 68, 66, 64, 62]), "disk", threshold=90)
    assert flat["status"] == "stable"
    assert falling["status"] == "stable"


def test_forecast_series_requires_five_points() -> None:
    result = forecast_series(_series([50, 52, 54, 56]), "disk", threshold=90)
    assert result["status"] == "insufficient_data"
    assert result["days_to_threshold"] is None


def test_forecast_series_is_critical_when_already_over_threshold() -> None:
    result = forecast_series(_series([95] * 10), "disk", threshold=90)
    assert result["status"] == "critical"
    assert result["days_to_threshold"] == 0.0


def test_forecast_series_keeps_missing_days_as_gaps() -> None:
    series = _series([50, None, None, 65, None, 75, None, 85, None, 95])
    result = forecast_series(series, "disk", threshold=90)
    assert result["status"] in {"warning", "critical"}
    assert result["slope_per_day"] == pytest.approx(5.0, abs=0.1)


def test_build_capacity_forecasts_uses_host_threshold(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="monitor",
        auth=AuthConfig(type="password", password="pw"),
        alert_rules=HostAlertRules(disk_percent=80),
    )

    def fake_history(db_path: Path, host_name: str, *, range_key: str, tz, now=None):
        return _series([60, 62, 64, 66, 68, 70, 72, 74, 76, 79])

    monkeypatch.setattr("servermanage.capacity.storage.fetch_host_history", fake_history)
    result = build_capacity_forecasts(
        tmp_path / "db.sqlite",
        [host],
        thresholds=AlertThresholds(disk_percent=90),
    )

    disk = next(metric for metric in result[0]["metrics"] if metric["key"] == "disk")
    assert disk["threshold"] == 80
    assert disk["status"] == "critical"
