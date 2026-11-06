"""Alert rule functions for the PC polling monitor.

Task 5 provides the pure rule layer: turn collected ``HostMetrics`` /
``DiskHealthReport`` values into :class:`~servermanage.disk_health.AlertEvent`
objects.  Task 6 adds the dedupe/cooldown :class:`AlertEngine` to this module
and Task 7 adds the :class:`Notifier` channels.

Design notes
------------
* Every rule is a pure function: no I/O, no clock, no network, so it is easy to
  test and safe to call from any thread.
* Fingerprints are stable across runs for the same condition (colon-joined,
  lower-cased) so downstream dedupe/cooldown keyed on ``fingerprint`` works.
* Missing inputs never fabricate an alert (``None`` is "unknown", never 0).
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Protocol

from servermanage import storage
from servermanage.disk_health import (
    AlertEvent,
    DiskHealthReport,
    PhysicalDriveInfo,
    VirtualDriveInfo,
)
from servermanage.models import AlertsConfig, AlertThresholds, HostMetrics

LOGGER = logging.getLogger(__name__)

__all__ = [
    "fingerprint_for",
    "evaluate_system_alerts",
    "evaluate_disk_alerts",
    "offline_alert",
    "recovery_event",
    "NotifierProtocol",
    "AlertEngine",
]

# Report statuses that mean "disk health could not be fully checked".
# ``ok`` is the only healthy status (see ``collect_disk_health`` docstring);
# every other status is treated as a maintenance risk.
_UNAVAILABLE_STATUS_SEVERITY = "warning"


def fingerprint_for(*parts: str) -> str:
    """Join *parts* with ``:`` and lower-case the result.

    A fingerprint identifies one logical condition, e.g.
    ``system:gpu-01:cpu`` or ``disk:gpu-01:c0:e252:s3:media_errors``.
    """
    return ":".join(str(part) for part in parts).lower()


# ---------------------------------------------------------------------------
# System metric rules
# ---------------------------------------------------------------------------

def _memory_percent(metrics: HostMetrics) -> float | None:
    """Return memory used percentage, or ``None`` when it cannot be computed."""
    memory = metrics.memory
    if memory is None or not memory.total_mb:
        return None
    return memory.used_mb / memory.total_mb * 100


def _gpu_memory_percent(metrics: HostMetrics) -> float | None:
    """Return aggregate GPU memory used percentage, or ``None`` when unknown."""
    rows = metrics.gpu_summary
    if not rows:
        return None
    total = sum(row.memory_total_mb for row in rows)
    if not total:
        return None
    used = sum(row.memory_used_mb for row in rows)
    return used / total * 100


def evaluate_system_alerts(
    host_name: str,
    metrics: HostMetrics,
    thresholds: AlertThresholds,
    *,
    disk_percent: float | None = None,
) -> list[AlertEvent]:
    """Build ``warning`` events for CPU / memory / disk / GPU over-utilisation.

    ``disk_percent`` is supplied by the caller (the highest usage across real
    data filesystems) because ``metrics.disk_usage`` rows carry a textual
    percentage.  Thresholds are inclusive: a value *at* the threshold alerts.
    Missing metrics are skipped so an unknown value never produces a false
    ``0%``-based alert.
    """
    events: list[AlertEvent] = []

    cpu = metrics.cpu_usage_percent
    if cpu is not None and cpu >= thresholds.cpu_percent:
        events.append(
            AlertEvent(
                host_name=host_name,
                category="system",
                severity="warning",
                title="CPU 使用率过高",
                message=(
                    f"主机 {host_name} CPU 使用率 {cpu:.1f}% "
                    f"达到阈值 {thresholds.cpu_percent:g}%"
                ),
                fingerprint=fingerprint_for("system", host_name, "cpu"),
            )
        )

    memory = _memory_percent(metrics)
    if memory is not None and memory >= thresholds.memory_percent:
        events.append(
            AlertEvent(
                host_name=host_name,
                category="system",
                severity="warning",
                title="内存使用率过高",
                message=(
                    f"主机 {host_name} 内存使用率 {memory:.1f}% "
                    f"达到阈值 {thresholds.memory_percent:g}%"
                ),
                fingerprint=fingerprint_for("system", host_name, "memory"),
            )
        )

    if disk_percent is not None and disk_percent >= thresholds.disk_percent:
        events.append(
            AlertEvent(
                host_name=host_name,
                category="system",
                severity="warning",
                title="磁盘使用率过高",
                message=(
                    f"主机 {host_name} 磁盘使用率 {disk_percent:.1f}% "
                    f"达到阈值 {thresholds.disk_percent:g}%"
                ),
                fingerprint=fingerprint_for("system", host_name, "disk"),
            )
        )

    gpu = _gpu_memory_percent(metrics)
    if gpu is not None and gpu >= thresholds.gpu_memory_percent:
        events.append(
            AlertEvent(
                host_name=host_name,
                category="system",
                severity="warning",
                title="GPU 显存占用过高",
                message=(
                    f"主机 {host_name} GPU 显存占用 {gpu:.1f}% "
                    f"达到阈值 {thresholds.gpu_memory_percent:g}%"
                ),
                fingerprint=fingerprint_for("system", host_name, "gpu_memory"),
            )
        )

    return events


# ---------------------------------------------------------------------------
# Disk rules
# ---------------------------------------------------------------------------

def _drive_identity(drive: PhysicalDriveInfo) -> tuple[str, ...]:
    """Stable identity parts for one physical drive.

    Prefer controller/enclosure/slot; fall back to the device id (``did``) when
    the drive has no slot, and finally to the controller alone.
    """
    if drive.slot is not None:
        return (f"c{drive.controller}", f"e{drive.enclosure}", f"s{drive.slot}")
    if drive.did is not None:
        return (f"c{drive.controller}", f"did{drive.did}")
    return (f"c{drive.controller}",)


def _drive_location(drive: PhysicalDriveInfo) -> str:
    """Human-readable location such as ``c0/e252/s3``."""
    if drive.slot is not None:
        return f"c{drive.controller}/e{drive.enclosure}/s{drive.slot}"
    if drive.did is not None:
        return f"c{drive.controller}/did{drive.did}"
    return f"c{drive.controller}"


def _drive_message(drive: PhysicalDriveInfo) -> str:
    parts = [f"物理盘 {_drive_location(drive)} 健康状态 {drive.health}"]
    if drive.reasons:
        parts.append("原因：" + ", ".join(drive.reasons))
    if drive.state:
        parts.append(f"状态 {drive.state}")
    if drive.model:
        parts.append(f"型号 {drive.model}")
    if drive.serial:
        parts.append(f"序列号 {drive.serial}")
    return "；".join(parts)


def _physical_drive_alert(host_name: str, drive: PhysicalDriveInfo) -> AlertEvent:
    reason = drive.reasons[0] if drive.reasons else "unknown"
    return AlertEvent(
        host_name=host_name,
        category="disk",
        severity=drive.health,
        title=f"磁盘 {host_name} {_drive_location(drive)} 异常",
        message=_drive_message(drive),
        fingerprint=fingerprint_for(
            "disk", host_name, *_drive_identity(drive), reason
        ),
    )


def _virtual_drive_alert(host_name: str, vd: VirtualDriveInfo) -> AlertEvent:
    reason = vd.reasons[0] if vd.reasons else "unknown"
    details = [f"虚拟盘 c{vd.controller}/vd{vd.vd_id} 健康状态 {vd.health}"]
    if vd.raid_level:
        details.append(f"RAID {vd.raid_level}")
    if vd.state:
        details.append(f"状态 {vd.state}")
    if vd.reasons:
        details.append("原因：" + ", ".join(vd.reasons))
    return AlertEvent(
        host_name=host_name,
        category="disk",
        severity=vd.health,
        title=f"虚拟磁盘 {host_name} c{vd.controller}/vd{vd.vd_id} 异常",
        message="；".join(details),
        fingerprint=fingerprint_for(
            "disk", host_name, f"c{vd.controller}", f"vd{vd.vd_id}", reason
        ),
    )


def _status_alert(report: DiskHealthReport) -> AlertEvent:
    status = report.status
    message = report.message or f"主机 {report.host_name} 磁盘健康检查状态：{status}"
    return AlertEvent(
        host_name=report.host_name,
        category="disk",
        severity=_UNAVAILABLE_STATUS_SEVERITY,
        title=f"磁盘健康检查异常（{report.host_name}）",
        message=message,
        fingerprint=fingerprint_for("disk", report.host_name, "status", status),
    )


def evaluate_disk_alerts(report: DiskHealthReport) -> list[AlertEvent]:
    """Derive alert events from one :class:`DiskHealthReport`.

    * Every physical drive whose ``health`` is ``warning``/``critical`` yields an
      event (``severity`` mirrors the drive health).
    * Every virtual drive whose ``health`` is ``warning``/``critical`` yields an
      event, because a degraded VD is just as much a maintenance risk.
    * A non-``ok`` report status (``permission_denied`` / ``no_storcli`` /
      ``no_controller`` / ``error`` / ``degraded``) yields an event: a host whose
      disk health cannot be checked is itself a maintenance risk, not silence.
    """
    host_name = report.host_name
    events: list[AlertEvent] = []

    if report.status != "ok":
        events.append(_status_alert(report))

    for drive in report.physical_drives:
        if drive.health in {"warning", "critical"}:
            events.append(_physical_drive_alert(host_name, drive))

    for vd in report.virtual_drives:
        if vd.health in {"warning", "critical"}:
            events.append(_virtual_drive_alert(host_name, vd))

    return events


# ---------------------------------------------------------------------------
# Host reachability rules
# ---------------------------------------------------------------------------

def offline_alert(host_name: str, failures: int) -> AlertEvent:
    """Event for a host that has failed ``failures`` consecutive collections."""
    return AlertEvent(
        host_name=host_name,
        category="offline",
        severity="critical",
        title=f"主机 {host_name} 离线",
        message=f"主机 {host_name} 连续 {failures} 次采集失败，判定为离线。",
        fingerprint=fingerprint_for("offline", host_name),
    )


def recovery_event(host_name: str, category: str) -> AlertEvent:
    """Informational event announcing that a host condition has recovered."""
    return AlertEvent(
        host_name=host_name,
        category=category,
        severity="info",
        title=f"主机 {host_name} {category} 告警恢复",
        message=f"主机 {host_name} 的 {category} 告警已恢复。",
        fingerprint=fingerprint_for("recovery", host_name, category),
    )


# ---------------------------------------------------------------------------
# Alert engine: dedupe / cooldown / persistence
# ---------------------------------------------------------------------------

# A fingerprint containing this marker identifies a condition whose error count
# just grew; such growth must break cooldown and notify again immediately.
_ERROR_INCREASE_MARKER = "error_increase"

# Upper bound for the active-alert scan used by :meth:`AlertEngine.resolve`.
# ``list_alerts`` requires a limit; active alerts are purged rarely, so this is
# deliberately generous while still being a bounded query.
_RESOLVE_SCAN_LIMIT = 100_000


class NotifierProtocol(Protocol):
    """Anything able to fan one event out to the enabled channels.

    Task 7's ``Notifier`` implements this.  ``dispatch`` returns the names of
    the channels that actually accepted the event (e.g. ``["desktop", "email"]``).
    """

    def dispatch(self, event: AlertEvent, config: AlertsConfig) -> list[str]:
        ...


def _as_utc(value: datetime) -> datetime:
    """Treat naive datetimes as UTC so cooldown subtraction never raises."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


class AlertEngine:
    """Turn raw :class:`AlertEvent` objects into "notify now" decisions.

    Responsibilities
    ----------------
    * **Deduplication / cooldown** — a still-``active`` alert with the same
      fingerprint is skipped while less than ``cooldown_minutes`` have elapsed
      since it was last recorded.  The check reads the database, so it survives
      a process restart.
    * **Error-increase bypass** — a fingerprint containing ``error_increase``
      always notifies, even inside the cooldown window (a growing error count is
      new information the operator must see).
    * **Persistence** — every notification inserts an ``active`` alert row,
      records the channels that accepted it and lets
      :meth:`resolve` close the condition.  Each row is one occurrence; the
      newest active row's ``created_at`` is the "last notified" anchor.
    * **Graceful degradation** — SQLite failures are logged and swallowed so a
      broken database never aborts the polling cycle.

    ``clock`` is injectable for deterministic tests; it defaults to
    ``datetime.now(timezone.utc)`` and also drives the row's ``created_at``.
    """

    def __init__(
        self,
        db_path: Path,
        config: AlertsConfig,
        notifier: NotifierProtocol,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._db_path = Path(db_path)
        self._config = config
        self._notifier = notifier
        self._clock: Callable[[], datetime] = clock or (
            lambda: datetime.now(timezone.utc)
        )

    # -- public API --------------------------------------------------------

    def process(self, events: list[AlertEvent]) -> list[AlertEvent]:
        """Persist *events* and return the subset actually sent to channels.

        Disabled alerts config is a no-op.  An event is returned only when the
        notifier accepted it on at least one channel; skipped duplicates and
        fully-failed dispatches are omitted.  Persistence errors are logged and
        the remaining events still process.
        """
        if not self._config.enabled:
            return []

        now = _as_utc(self._clock())
        notified: list[AlertEvent] = []

        for event in events:
            if self._should_skip(event, now):
                continue

            alert_id = self._persist(event, now)
            if alert_id is None:
                continue

            channels = self._dispatch(event)
            self._record_channels(alert_id, channels)

            if channels:
                notified.append(event)

        return notified

    def resolve(self, host_name: str, category: str) -> None:
        """Mark every ``active`` alert for *host_name* + *category* as resolved."""
        try:
            active = storage.list_alerts(
                self._db_path, status="active", limit=_RESOLVE_SCAN_LIMIT
            )
        except sqlite3.Error:
            LOGGER.exception(
                "Failed to load active alerts while resolving %s/%s", host_name, category
            )
            return

        for row in active:
            if row.get("host_name") != host_name or row.get("category") != category:
                continue
            try:
                storage.update_alert(row["id"], self._db_path, status="resolved")
            except sqlite3.Error:
                LOGGER.exception("Failed to resolve alert id=%s", row.get("id"))

    def resolve_missing(
        self,
        host_name: str,
        active_fingerprints: set[str] | list[str] | tuple[str, ...],
        *,
        category: str | None = None,
    ) -> None:
        """Resolve a host's active alerts whose condition no longer fires.

        *active_fingerprints* is the set of fingerprints still produced by the
        rules this cycle; any active alert for *host_name* whose fingerprint is
        absent is stale and gets marked ``resolved``.  Pass *category* to scope
        the cleanup to one alert type (e.g. only ``"system"``) when a caller did
        not evaluate every rule for the host.
        """
        remaining = set(active_fingerprints)
        try:
            active = storage.list_alerts(
                self._db_path, status="active", limit=_RESOLVE_SCAN_LIMIT
            )
        except sqlite3.Error:
            LOGGER.exception(
                "Failed to load active alerts while resolving missing for %s", host_name
            )
            return

        for row in active:
            if row.get("host_name") != host_name:
                continue
            if category is not None and row.get("category") != category:
                continue
            if row.get("fingerprint") in remaining:
                continue
            try:
                storage.update_alert(row["id"], self._db_path, status="resolved")
            except sqlite3.Error:
                LOGGER.exception("Failed to resolve alert id=%s", row.get("id"))

    # -- internals ---------------------------------------------------------

    def _should_skip(self, event: AlertEvent, now: datetime) -> bool:
        """Return True when this event is a duplicate inside the cooldown window."""
        if _ERROR_INCREASE_MARKER in event.fingerprint.lower():
            return False

        try:
            latest = storage.find_latest_alert(event.fingerprint, self._db_path)
        except sqlite3.Error:
            # Cannot prove it is a duplicate: let it through rather than risk
            # silently dropping an alert.  ``_persist`` will log any further
            # database failure.
            LOGGER.exception(
                "Failed to look up latest alert for %s", event.fingerprint
            )
            return False

        if latest is None or latest.get("status") != "active":
            return False

        created_at = _parse_iso(latest.get("created_at"))
        if created_at is None:
            return False

        elapsed = now - created_at
        return elapsed < timedelta(minutes=self._config.cooldown_minutes)

    def _persist(self, event: AlertEvent, now: datetime) -> int | None:
        try:
            return storage.insert_alert(event, self._db_path, created_at=now)
        except sqlite3.Error:
            LOGGER.exception(
                "Failed to persist alert %s", event.fingerprint
            )
            return None

    def _dispatch(self, event: AlertEvent) -> list[str]:
        try:
            channels = self._notifier.dispatch(event, self._config)
        except Exception:  # noqa: BLE001 - notification must never break polling
            LOGGER.exception("Notifier failed for alert %s", event.fingerprint)
            return []
        return list(channels or [])

    def _record_channels(self, alert_id: int, channels: list[str]) -> None:
        try:
            storage.update_alert(
                alert_id,
                self._db_path,
                notified_channels=",".join(channels),
            )
        except sqlite3.Error:
            LOGGER.exception(
                "Failed to record notified channels for alert id=%s", alert_id
            )


def _parse_iso(value: object) -> datetime | None:
    """Parse a stored ISO timestamp; return ``None`` when unusable."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return _as_utc(datetime.fromisoformat(value))
    except ValueError:
        return None
