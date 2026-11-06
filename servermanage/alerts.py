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

from servermanage.disk_health import (
    AlertEvent,
    DiskHealthReport,
    PhysicalDriveInfo,
    VirtualDriveInfo,
)
from servermanage.models import AlertThresholds, HostMetrics

__all__ = [
    "fingerprint_for",
    "evaluate_system_alerts",
    "evaluate_disk_alerts",
    "offline_alert",
    "recovery_event",
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
