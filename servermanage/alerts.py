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
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from html import escape as _html_escape
from pathlib import Path
from typing import Callable, Protocol

from servermanage import storage
from servermanage.disk_health import (
    AlertEvent,
    DiskHealthReport,
    PhysicalDriveInfo,
    VirtualDriveInfo,
)
from servermanage.mailer import send_report
from servermanage.models import (
    AlertsConfig,
    AlertThresholds,
    HostMetrics,
    RenderedReport,
    SMTPConfig,
    WebhookConfig,
)
from servermanage.notify_desktop import send_desktop_notification
from servermanage.notify_webhook import send_webhook

LOGGER = logging.getLogger(__name__)

__all__ = [
    "fingerprint_for",
    "evaluate_system_alerts",
    "evaluate_disk_alerts",
    "offline_alert",
    "recovery_event",
    "SilenceRegistry",
    "NotifierProtocol",
    "Notifier",
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
    disk_mounts: list[dict[str, object]] | None = None,
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

    if disk_mounts is not None:
        for status in disk_mounts:
            if not status.get("present"):
                continue
            percent = status.get("percent")
            if percent is None:
                continue
            percent = float(percent)
            if percent < thresholds.disk_percent:
                continue
            mountpoint = str(status.get("mountpoint"))
            events.append(
                AlertEvent(
                    host_name=host_name,
                    category="system",
                    severity="warning",
                    title="磁盘使用率过高",
                    message=(
                        f"主机 {host_name} 挂载点 {mountpoint} 磁盘使用率 "
                        f"{percent:.1f}% 达到阈值 {thresholds.disk_percent:g}%"
                    ),
                    fingerprint=fingerprint_for(
                        "system", host_name, "disk", mountpoint
                    ),
                )
            )
    elif disk_percent is not None and disk_percent >= thresholds.disk_percent:
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
        reasons=tuple(drive.reasons or ()),
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
        reasons=tuple(vd.reasons or ()),
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
# Alert silences (maintenance windows)
# ---------------------------------------------------------------------------

# Silence scopes from broadest to narrowest.  When more than one matches a host
# the broadest scope wins, making an ``all`` window impossible to override by a
# narrower host/group window.
_SILENCE_PRECEDENCE = ("all", "group", "host")


class SilenceRegistry:
    """Look up the active maintenance silence covering a host.

    The database is read on **every** call (no caching), so a silence created or
    deleted by another process takes effect on the next polling cycle.  Scope
    precedence is ``all`` → ``group`` → ``host``: the first matching row wins.
    """

    def __init__(
        self,
        db_path: Path,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._db_path = Path(db_path)
        self._clock: Callable[[], datetime] = clock or (
            lambda: datetime.now(timezone.utc)
        )

    def active_for(
        self,
        host_name: str,
        groups: Iterable[str] = (),
        now: datetime | None = None,
    ) -> dict | None:
        """Return the active silence dict for *host_name*, or ``None``.

        *groups* are the host's group memberships; they are supplied by the
        caller because groups are a monitor-service concept, not alert data.
        """
        moment = _as_utc(now or self._clock())
        rows = storage.list_silences(
            self._db_path, active_only=True, now=moment
        )
        wanted_groups = {str(group) for group in (groups or ())}
        for scope_type in _SILENCE_PRECEDENCE:
            for row in rows:
                if row.get("scope_type") != scope_type:
                    continue
                if scope_type == "all":
                    return row
                if (
                    scope_type == "group"
                    and str(row.get("scope")) in wanted_groups
                ):
                    return row
                if scope_type == "host" and row.get("scope") == host_name:
                    return row
        return None


# ---------------------------------------------------------------------------
# Alert engine: dedupe / cooldown / persistence
# ---------------------------------------------------------------------------

# A fingerprint containing this marker identifies a condition whose error count
# just grew; such growth must break cooldown and notify again immediately.
_ERROR_INCREASE_MARKER = "error_increase"

# Alert statuses that represent an unresolved condition.  ``acknowledged`` is
# "condition still present, user confirmed", so it is open just like ``active``:
# it suppresses repeats while the condition fires and must be resolved when the
# condition disappears.  ``resolved`` is the only closed status.
_OPEN_ALERT_STATUSES = ("active", "acknowledged")

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

    def dispatch_batch(
        self, events: list[AlertEvent], config: AlertsConfig
    ) -> list[str]:
        """Notify several events that share a host using one merged message."""
        ...


def _alert_timestamp() -> str:
    """Local, human-readable ISO-8601 timestamp for notification bodies."""
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _alert_subject(event: AlertEvent) -> str:
    """Short one-line subject/title, prefixed with the severity."""
    return f"[{event.severity}] {event.title}"


def _alert_text_body(event: AlertEvent) -> str:
    """Plain-text alert body: host, category, severity, title, time, message."""
    return "\n".join(
        [
            f"主机: {event.host_name}",
            f"类别: {event.category}",
            f"级别: {event.severity}",
            f"标题: {event.title}",
            f"时间: {_alert_timestamp()}",
            "",
            event.message,
        ]
    )


def _alert_html_body(event: AlertEvent) -> str:
    """Minimal HTML rendering of :func:`_alert_text_body`, safely escaped."""
    rows = (
        ("主机", event.host_name),
        ("类别", event.category),
        ("级别", event.severity),
        ("标题", event.title),
        ("时间", _alert_timestamp()),
        ("详情", event.message),
    )
    cells = "".join(
        f"<tr><th>{_html_escape(str(label))}</th>"
        f"<td>{_html_escape(str(value))}</td></tr>"
        for label, value in rows
    )
    return (
        "<html><body>"
        f"<h3>{_html_escape(event.title)}</h3>"
        f"<table>{cells}</table>"
        "</body></html>"
    )


def _batch_event(events: list[AlertEvent]) -> AlertEvent:
    """Merge several same-host events into one notification event.

    The merged event keeps the host, carries the highest severity, and lists
    every underlying title/message in its body.  Its fingerprint is only used
    for logging (the individual rows keep their own fingerprints).
    """
    host_name = events[0].host_name
    highest = max(events, key=lambda event: _severity_rank(event.severity))
    title = f"主机 {host_name} {len(events)} 项告警"
    details = "\n".join(
        f"- [{event.severity}] {event.title}：{event.message}"
        for event in events
    )
    return AlertEvent(
        host_name=host_name,
        category="batch",
        severity=highest.severity,
        title=title,
        message=details,
        fingerprint=fingerprint_for("batch", host_name, str(len(events))),
    )


class Notifier:
    """Fan one :class:`AlertEvent` out to every enabled notification channel.

    Channels are tried independently, in the order ``desktop`` → ``email`` →
    ``webhook``.  Each channel honours its ``enabled`` flag (a disabled channel
    performs no I/O at all), and a failure in one channel is logged and does not
    prevent the others from running.  :meth:`dispatch` returns only the channel
    names that actually accepted the event; an empty list therefore means the
    alert engine should retry on the next polling cycle (Task 6 semantics).

    Email requires an :class:`~servermanage.models.SMTPConfig`.  When the
    ``email`` flag is on but no SMTP config was supplied (``smtp is None``), the
    email channel is skipped cleanly rather than treated as a failure.

    ``dispatch`` never raises: an unexpected error is logged and the channels
    accepted so far are still returned.
    """

    def __init__(self, *, smtp: SMTPConfig | None = None) -> None:
        self._smtp = smtp

    # -- public API --------------------------------------------------------

    def dispatch(self, event: AlertEvent, config: AlertsConfig) -> list[str]:
        accepted: list[str] = []
        try:
            if config.desktop_notification and self._dispatch_desktop(event):
                accepted.append("desktop")
            if config.email and self._dispatch_email(event):
                accepted.append("email")
            if (
                config.webhook is not None
                and config.webhook.enabled
                and self._dispatch_webhook(event, config.webhook)
            ):
                accepted.append("webhook")
        except Exception:  # noqa: BLE001 - dispatch must never raise
            LOGGER.exception(
                "Unexpected notifier failure for alert %s", event.fingerprint
            )
        return accepted

    def dispatch_batch(
        self, events: list[AlertEvent], config: AlertsConfig
    ) -> list[str]:
        """Notify *events* (all for one host) with a single merged message.

        A single event delegates to :meth:`dispatch` so its message keeps the
        normal single-alert shape.  Several events are merged into one title
        ``主机 <host> N 项告警`` and one body listing each item, then sent once
        per enabled channel.  Channel failures stay independent because
        :meth:`dispatch` already isolates them.
        """
        events = list(events)
        if not events:
            return []
        if len(events) == 1:
            return self.dispatch(events[0], config)
        return self.dispatch(_batch_event(events), config)

    # -- per-channel helpers ----------------------------------------------

    def _dispatch_desktop(self, event: AlertEvent) -> bool:
        try:
            return bool(
                send_desktop_notification(
                    _alert_subject(event), _alert_text_body(event)
                )
            )
        except Exception:  # noqa: BLE001 - one channel must not break others
            LOGGER.exception("Desktop notification failed for %s", event.fingerprint)
            return False

    def _dispatch_email(self, event: AlertEvent) -> bool:
        if self._smtp is None:
            LOGGER.debug(
                "Email channel enabled but no SMTP config; skipping for %s",
                event.fingerprint,
            )
            return False
        try:
            report = RenderedReport(
                subject=_alert_subject(event),
                text_body=_alert_text_body(event),
                html_body=_alert_html_body(event),
            )
            send_report(self._smtp, report)
            return True
        except Exception:  # noqa: BLE001 - one channel must not break others
            LOGGER.exception("Email notification failed for %s", event.fingerprint)
            return False

    def _dispatch_webhook(
        self, event: AlertEvent, webhook: WebhookConfig
    ) -> bool:
        try:
            return bool(send_webhook(webhook, event))
        except Exception:  # noqa: BLE001 - one channel must not break others
            LOGGER.exception("Webhook notification failed for %s", event.fingerprint)
            return False


def _as_utc(value: datetime) -> datetime:
    """Treat naive datetimes as UTC so cooldown subtraction never raises."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _has_error_increase(event: AlertEvent) -> bool:
    """True when the event reports a growing error count.

    The structured ``reasons`` tuple is the authoritative signal.  The
    fingerprint substring is kept as a defensive fallback for producers that
    still embed the marker there.
    """
    if _ERROR_INCREASE_MARKER in tuple(event.reasons or ()):
        return True
    return _ERROR_INCREASE_MARKER in event.fingerprint.lower()


# Ordering used to detect a genuine escalation (low -> high notifies even when
# ``repeat_while_active`` is off).  Unknown severities rank lowest.
_SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}


def _severity_rank(severity: str | None) -> int:
    return _SEVERITY_RANK.get(str(severity or "").strip().lower(), 0)


# Sentinel for "caller did not specify notify".  Modern notifiers (those with
# ``dispatch_batch``) default recovery notifications on; legacy notifiers that
# only implement ``dispatch`` keep the historical no-recovery behaviour so old
# integrations/test doubles are not broken by Task 5.
_NOTIFY_DEFAULT: object = object()


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
        silence_checker: "SilenceRegistry | None" = None,
        host_groups: (
            Mapping[str, Iterable[str]] | Callable[[str], Iterable[str]] | None
        ) = None,
    ) -> None:
        self._db_path = Path(db_path)
        self._config = config
        self._notifier = notifier
        self._clock: Callable[[], datetime] = clock or (
            lambda: datetime.now(timezone.utc)
        )
        self._silence_checker = silence_checker
        self._host_groups = host_groups

    # -- public API --------------------------------------------------------

    def process(self, events: list[AlertEvent]) -> list[AlertEvent]:
        """Persist *events* and return the subset actually sent to channels.

        Silenced events are logged and dropped before persistence/dispatch.
        When ``aggregate_by_host`` is on, the remaining events are grouped by
        host: a host with one event uses :meth:`dispatch`, a host with several
        uses one merged :meth:`dispatch_batch`.  Every event is still persisted
        and gets the channels accepted for its group written back.

        Disabled alerts config is a no-op.  An event is returned only when the
        notifier accepted it on at least one channel; skipped duplicates and
        fully-failed dispatches are omitted.  Persistence errors are logged and
        the remaining events still process.
        """
        if not self._config.enabled:
            return []

        now = _as_utc(self._clock())
        candidates: list[AlertEvent] = []
        for event in events:
            if self._is_silenced(event, now):
                continue
            if self._should_skip(event, now):
                continue
            candidates.append(event)

        if not candidates:
            return []

        if bool(getattr(self._config, "aggregate_by_host", False)):
            return self._process_aggregated(candidates, now)
        return self._process_individually(candidates, now)

    def _process_individually(
        self, events: list[AlertEvent], now: datetime
    ) -> list[AlertEvent]:
        notified: list[AlertEvent] = []
        for event in events:
            alert_id = self._persist(event, now)
            if alert_id is None:
                continue
            channels = self._dispatch(event)
            self._record_channels(alert_id, channels)
            if channels:
                notified.append(event)
        return notified

    def _process_aggregated(
        self, events: list[AlertEvent], now: datetime
    ) -> list[AlertEvent]:
        groups: dict[str, list[AlertEvent]] = {}
        for event in events:
            groups.setdefault(event.host_name, []).append(event)

        notified: list[AlertEvent] = []
        for group in groups.values():
            if len(group) == 1:
                event = group[0]
                alert_id = self._persist(event, now)
                if alert_id is None:
                    continue
                channels = self._dispatch(event)
                self._record_channels(alert_id, channels)
                if channels:
                    notified.append(event)
                continue

            persisted: list[tuple[AlertEvent, int]] = []
            for event in group:
                alert_id = self._persist(event, now)
                if alert_id is not None:
                    persisted.append((event, alert_id))
            if not persisted:
                continue

            batch_events = [event for event, _ in persisted]
            channels = self._dispatch_batch(batch_events)
            for _, alert_id in persisted:
                self._record_channels(alert_id, channels)
            if channels:
                notified.extend(batch_events)
        return notified

    def resolve(
        self,
        host_name: str,
        category: str,
        *,
        notify: bool | object = _NOTIFY_DEFAULT,
    ) -> list[AlertEvent]:
        """Mark every unresolved alert for *host_name* + *category* as resolved.

        Both ``active`` and ``acknowledged`` rows are open conditions: an
        acknowledged alert whose condition disappears must still be closed,
        otherwise it lingers in the database forever.

        With *notify* (and ``notify_on_recovery``), one recovery event is
        generated for the closed ``(host, category)`` and processed through the
        normal pipeline.  Returns the recovery events that were generated, even
        when notifications are disabled; no open rows means an empty list.
        """
        try:
            rows = self._open_alerts()
        except sqlite3.Error:
            LOGGER.exception(
                "Failed to load open alerts while resolving %s/%s", host_name, category
            )
            return []

        closed_conditions = 0
        for row in rows:
            if row.get("host_name") != host_name or row.get("category") != category:
                continue
            is_recovery = str(row.get("fingerprint") or "").startswith("recovery:")
            try:
                storage.update_alert(row["id"], self._db_path, status="resolved")
                if not is_recovery:
                    closed_conditions += 1
            except sqlite3.Error:
                LOGGER.exception("Failed to resolve alert id=%s", row.get("id"))

        if not closed_conditions:
            return []
        return self._emit_recovery([(host_name, category)], notify)

    def resolve_missing(
        self,
        host_name: str,
        active_fingerprints: set[str] | list[str] | tuple[str, ...],
        *,
        category: str | None = None,
        notify: bool | object = _NOTIFY_DEFAULT,
    ) -> list[AlertEvent]:
        """Resolve a host's open alerts whose condition no longer fires.

        *active_fingerprints* is the set of fingerprints still produced by the
        rules this cycle; any open alert (``active`` or ``acknowledged``) for
        *host_name* whose fingerprint is absent is stale and gets marked
        ``resolved``.  Pass *category* to scope the cleanup to one alert type
        (e.g. only ``"system"``) when a caller did not evaluate every rule for
        the host.

        One recovery event is produced per ``(host, category)`` that actually
        had rows closed.  With *notify* (and ``notify_on_recovery``) they are
        processed through the normal aggregation/dispatch pipeline.
        """
        remaining = set(active_fingerprints)
        try:
            rows = self._open_alerts()
        except sqlite3.Error:
            LOGGER.exception(
                "Failed to load open alerts while resolving missing for %s", host_name
            )
            return []

        closed_categories: list[str] = []
        for row in rows:
            if row.get("host_name") != host_name:
                continue
            if category is not None and row.get("category") != category:
                continue
            if row.get("fingerprint") in remaining:
                continue
            is_recovery = str(row.get("fingerprint") or "").startswith("recovery:")
            try:
                storage.update_alert(row["id"], self._db_path, status="resolved")
            except sqlite3.Error:
                LOGGER.exception("Failed to resolve alert id=%s", row.get("id"))
                continue
            if is_recovery:
                # A recovery notice is informational; closing it must not spawn
                # another recovery notice for the same category.
                continue
            row_category = row.get("category")
            if (
                isinstance(row_category, str)
                and row_category not in closed_categories
            ):
                closed_categories.append(row_category)

        if not closed_categories:
            return []
        return self._emit_recovery(
            [(host_name, row_category) for row_category in closed_categories],
            notify,
        )

    def _emit_recovery(
        self, keys: list[tuple[str, str]], notify: bool | object
    ) -> list[AlertEvent]:
        events = [recovery_event(host_name, category) for host_name, category in keys]
        if self._should_notify_recovery(notify) and bool(
            getattr(self._config, "notify_on_recovery", True)
        ):
            self.process(events)
        return events

    def _should_notify_recovery(self, notify: bool | object) -> bool:
        if notify is _NOTIFY_DEFAULT:
            # Capability-based default: real notifiers (and new test doubles)
            # implementing ``dispatch_batch`` get recovery notifications; legacy
            # ``dispatch``-only notifiers retain the old behaviour.
            return callable(getattr(self._notifier, "dispatch_batch", None))
        return bool(notify)

    # -- internals ---------------------------------------------------------

    def _open_alerts(self) -> list[dict]:
        """Return every open alert: both ``active`` and ``acknowledged`` rows.

        ``storage.list_alerts`` keeps its single-status contract, so the two
        scans are merged here.  ``sqlite3.Error`` propagates to the caller.
        """
        rows: list[dict] = []
        for status in _OPEN_ALERT_STATUSES:
            rows.extend(
                storage.list_alerts(
                    self._db_path, status=status, limit=_RESOLVE_SCAN_LIMIT
                )
            )
        return rows

    def _groups_for_host(self, host_name: str) -> list[str]:
        """Resolve a host's group memberships for silence matching."""
        source = self._host_groups
        if source is None:
            return []
        try:
            if callable(source):
                groups = source(host_name)
            else:
                groups = source.get(host_name, ())
            return [str(group) for group in (groups or ())]
        except Exception:  # noqa: BLE001 - group lookup must not break polling
            LOGGER.exception("Failed to resolve groups for host %s", host_name)
            return []

    def _is_silenced(self, event: AlertEvent, now: datetime) -> bool:
        """True when an active silence covers this event's host."""
        if self._silence_checker is None:
            return False
        try:
            hit = self._silence_checker.active_for(
                event.host_name,
                self._groups_for_host(event.host_name),
                now,
            )
        except Exception:  # noqa: BLE001 - silence lookup must not break polling
            LOGGER.exception(
                "Silence check failed for host %s", event.host_name
            )
            return False
        if not hit:
            return False
        LOGGER.info(
            "alert suppressed by silence %s for %s/%s",
            hit.get("id"),
            event.host_name,
            event.category,
        )
        return True

    def _should_skip(self, event: AlertEvent, now: datetime) -> bool:
        """Return True when this event should be suppressed.

        Suppression rules, in order:

        * ``error_increase`` always notifies — deterioration is new information
          an acknowledgement must not silence.
        * An ``acknowledged`` latest row means "condition still present, user
          already confirmed": suppress while the same fingerprint keeps firing,
          regardless of the cooldown window.  An older ``active`` row for the
          same fingerprint (possible legacy data) does not override this,
          because the newest row is the authoritative ack.
        * An ``active`` row follows the original cooldown / un-notified-retry
          semantics.
        """
        if _has_error_increase(event):
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

        if latest is None:
            return False

        status = latest.get("status")
        if status == "acknowledged":
            # User confirmed a still-present condition: stay silent.
            return True
        if status != "active":
            return False

        # A previous attempt that no channel accepted must be retried: an
        # un-notified active row does not consume the cooldown, otherwise a
        # transient notification outage would silence the alert for the whole
        # cooldown window.
        if not latest.get("notified_channels"):
            return False

        created_at = _parse_iso(latest.get("created_at"))
        if created_at is None:
            return False

        elapsed = now - created_at
        if elapsed < timedelta(minutes=self._config.cooldown_minutes):
            return True

        # Cooldown elapsed on a still-active, already-notified alert.  When
        # ``repeat_while_active`` is off, stay silent for the same condition
        # unless the new event is a genuine escalation (strictly higher severity).
        if not bool(getattr(self._config, "repeat_while_active", False)):
            if _severity_rank(event.severity) <= _severity_rank(
                latest.get("severity")
            ):
                return True
        return False

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

    def _dispatch_batch(self, events: list[AlertEvent]) -> list[str]:
        """Dispatch a same-host batch, tolerating notifiers without support.

        Old test doubles / integrations only implement ``dispatch``; when
        ``dispatch_batch`` is absent we fall back to dispatching each event and
        unioning the accepted channels, preserving the previous behaviour.
        """
        if not events:
            return []
        if len(events) == 1:
            return self._dispatch(events[0])

        batch = getattr(self._notifier, "dispatch_batch", None)
        if callable(batch):
            try:
                channels = batch(events, self._config)
            except Exception:  # noqa: BLE001 - must not break polling
                LOGGER.exception(
                    "Notifier batch failed for %s", events[0].host_name
                )
                return []
            return list(channels or [])

        accepted: list[str] = []
        for event in events:
            for channel in self._dispatch(event):
                if channel not in accepted:
                    accepted.append(channel)
        return accepted

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
