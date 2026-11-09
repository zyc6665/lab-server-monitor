"""Capacity trend forecasts for memory, disk and GPU memory.

The forecast is intentionally simple: a least-squares line over the daily
summary points, then a straight-line projection to the alert threshold.  It is
a planning signal, not an alert rule, so all functions are pure or read-only.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, timezone, tzinfo
from pathlib import Path
from typing import Any

from servermanage import storage
from servermanage.models import AlertThresholds, HostAlertRules, HostConfig

__all__ = ["linear_slope", "forecast_series", "build_capacity_forecasts"]

_METRICS: tuple[tuple[str, str, str], ...] = (
    ("memory", "内存", "memory_percent"),
    ("disk", "磁盘", "disk_percent"),
    ("gpu_memory", "GPU 显存", "gpu_memory_percent"),
)


def linear_slope(points: Sequence[tuple[float, float]]) -> float | None:
    """Return the least-squares slope of ``(x, y)`` points, or ``None``."""
    count = len(points)
    if count < 2:
        return None
    x_mean = sum(x for x, _ in points) / count
    y_mean = sum(y for _, y in points) / count
    denominator = sum((x - x_mean) ** 2 for x, _ in points)
    if denominator == 0:
        return None
    numerator = sum((x - x_mean) * (y - y_mean) for x, y in points)
    return numerator / denominator


def _parse_day(value: Any) -> date | None:
    if value is None:
        return None
    text = str(value)
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def forecast_series(
    series: Sequence[dict[str, Any]],
    key: str,
    *,
    threshold: float,
    min_points: int = 5,
    horizon_days: int = 30,
) -> dict[str, Any]:
    """Forecast one metric from a series of ``{"t": date, key: value}`` rows."""
    valid: list[tuple[date, float]] = []
    for item in series:
        raw = item.get(key)
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        day = _parse_day(item.get("t"))
        if day is None:
            continue
        valid.append((day, value))

    result: dict[str, Any] = {
        "key": key,
        "current": round(valid[-1][1], 2) if valid else None,
        "slope_per_day": None,
        "days_to_threshold": None,
        "status": "insufficient_data",
        "threshold": float(threshold),
    }
    if len(valid) < min_points:
        return result

    first_day = valid[0][0]
    points = [((day - first_day).days, value) for day, value in valid]
    slope = linear_slope(points)
    current = valid[-1][1]
    result["current"] = round(current, 2)
    result["slope_per_day"] = round(slope, 2) if slope is not None else None

    if current >= threshold:
        result["days_to_threshold"] = 0.0
        result["status"] = "critical"
        return result

    if slope is None or slope <= 0.01:
        result["status"] = "stable"
        return result

    days_to_threshold = (threshold - current) / slope
    result["days_to_threshold"] = round(max(0.0, days_to_threshold), 2)
    if days_to_threshold <= 7:
        result["status"] = "critical"
    elif days_to_threshold <= horizon_days:
        result["status"] = "warning"
    else:
        result["status"] = "stable"
    return result


def _threshold_for(
    attr: str,
    base: AlertThresholds,
    rules: HostAlertRules | None,
) -> float:
    override = getattr(rules, attr, None) if rules is not None else None
    if override is not None:
        return float(override)
    return float(getattr(base, attr))


def build_capacity_forecasts(
    db_path: Path,
    servers: Sequence[HostConfig],
    *,
    tz: tzinfo = timezone.utc,
    now: datetime | None = None,
    thresholds: AlertThresholds | None = None,
    days: int = 30,
) -> list[dict[str, Any]]:
    """Return per-host capacity forecasts for all configured servers."""
    if days not in (7, 30, 90):
        raise ValueError("days must be 7, 30 or 90")
    base = thresholds or AlertThresholds()
    range_key = f"{days}d"
    hosts: list[dict[str, Any]] = []
    for server in servers:
        try:
            series = storage.fetch_host_history(
                db_path,
                server.name,
                range_key=range_key,
                tz=tz,
                now=now,
            )
        except ValueError:
            series = []
        metrics: list[dict[str, Any]] = []
        for key, label, attr in _METRICS:
            forecast = forecast_series(
                series,
                key,
                threshold=_threshold_for(attr, base, server.alert_rules),
                horizon_days=days,
            )
            forecast["label"] = label
            metrics.append(forecast)
        hosts.append(
            {
                "host_name": server.name,
                "host": server.host,
                "metrics": metrics,
            }
        )
    return hosts
