"""JSON API and authentication routes for the server-monitor dashboard.

Route contract (Task 10):

* ``GET  /api/overview``                 – summary + one row per host
* ``GET  /api/host/<name>``              – latest host snapshot + disk health
* ``GET  /api/alerts?status=active``     – alerts (newest first)
* ``POST /api/alerts/<int:alert_id>/ack``– acknowledge an alert
* ``GET/POST /login``, ``POST /logout``  – single-admin password login

``register_routes(app)`` registers everything on the app created by
:func:`servermanage.web.create_app`; Task 11 extends the same function with the
HTML page routes.
"""

from __future__ import annotations

import hmac
import logging
import secrets
import smtplib
import time
from collections import deque
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from servermanage import disk_capacity, host_import, storage
from servermanage.disk_health import AlertEvent
from servermanage.models import AuthConfig, HostConfig, WebhookConfig
from servermanage.notify_webhook import send_webhook
from servermanage.runtime import read_runtime_state
from servermanage.settings import SettingsError
from servermanage.ssh_client import SSHClientWrapper
from servermanage.timeutil import resolve_timezone

LOGGER = logging.getLogger(__name__)

# Same filtering rule as storage._extract_disk_used_percent: only real block
# devices count towards the "disk usage" gauge, never tmpfs/proc/overlay mounts.
_VIRTUAL_FILESYSTEMS = {
    "tmpfs",
    "devtmpfs",
    "overlay",
    "squashfs",
    "nsfs",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "mqueue",
    "shm",
}

# ---------------------------------------------------------------------------
# Small value helpers
# ---------------------------------------------------------------------------


def _config(app: Flask):
    return app.config["CONFIG"]


def _db_path(app: Flask):
    return app.config["DB_PATH"]


def _settings_service(app: Flask):
    """The optional :class:`SettingsService` injected by ``create_app``."""
    return app.config.get("SETTINGS_SERVICE")


# Editable settings sections accepted by ``PUT /api/settings/<section>``.  The
# ``hosts`` section is intentionally excluded: host rows are managed through the
# dedicated CRUD endpoints so their credentials land in ``app_secrets``.
_ALLOWED_SETTINGS_SECTIONS = frozenset(
    {"monitoring", "dashboard", "alerts", "smtp", "report", "disk_health", "ssh"}
)


def _settings_snapshot(config: AppConfig) -> dict[str, Any]:
    """Best-effort settings payload for the legacy no-service dashboard.

    The packaged Windows build always injects a :class:`SettingsService`; this
    fallback keeps the read-only page (and the pre-1.1 test fixtures) rendering
    the same values without creating a writable settings store.
    """
    hosts = []
    for host in config.servers:
        auth = host.auth
        hosts.append(
            {
                "name": host.name,
                "host": host.host,
                "port": host.port,
                "username": host.username,
                "tags": list(host.tags),
                "disk_mounts": list(host.disk_mounts),
                "auth_type": auth.type,
                "key_path": auth.key_path,
                "disk_health": None,
                "password_configured": bool(auth.password or auth.password_env),
                "key_configured": bool(auth.key_path or auth.key_data),
                "passphrase_configured": bool(
                    auth.passphrase or auth.passphrase_env
                ),
            }
        )
    return {
        "writable": False,
        "setup_required": False,
        "monitoring": {
            "timezone": config.app.timezone,
            "poll_interval_seconds": config.app.poll_interval_seconds,
            "disk_poll_interval_seconds": config.app.disk_poll_interval_seconds,
            "concurrency": config.app.concurrency,
            "retention_days": config.app.retention_days,
        },
        "dashboard": {
            "host": config.dashboard.host,
            "port": config.dashboard.port,
            "username": config.dashboard.auth.username,
            "session_lifetime_hours": config.dashboard.session_lifetime_hours,
        },
        "ssh": {
            "connect_timeout": config.ssh.connect_timeout,
            "command_timeout": config.ssh.command_timeout,
        },
        "smtp": {
            "host": config.smtp.host if config.smtp else "",
            "port": config.smtp.port if config.smtp else 587,
            "username": config.smtp.username if config.smtp else "",
            "use_ssl": config.smtp.use_ssl if config.smtp else False,
            "from_addr": config.smtp.from_addr if config.smtp else "",
            "to_addrs": list(config.smtp.to_addrs) if config.smtp else [],
            "password_configured": bool(
                config.smtp is not None and config.smtp.password
            ),
        },
        "alerts": {
            "enabled": config.alerts.enabled,
            "desktop_notification": config.alerts.desktop_notification,
            "email": bool(config.smtp is not None and config.alerts.email),
            "webhook": {
                "enabled": config.alerts.webhook.enabled,
                "type": config.alerts.webhook.type,
                "url_configured": bool(config.alerts.webhook.url),
            },
            "thresholds": {
                "cpu_percent": config.alerts.thresholds.cpu_percent,
                "memory_percent": config.alerts.thresholds.memory_percent,
                "disk_percent": config.alerts.thresholds.disk_percent,
                "gpu_memory_percent": config.alerts.thresholds.gpu_memory_percent,
                "disk_temperature_c": config.alerts.thresholds.disk_temperature_c,
            },
            "cooldown_minutes": config.alerts.cooldown_minutes,
            "repeat_while_active": config.alerts.repeat_while_active,
            "offline_failures": config.alerts.offline_failures,
        },
        "report": {
            "daily_enabled": config.report.daily_enabled,
            "daily_time": config.report.daily_time,
            "weekly": {
                "enabled": config.report.weekly.enabled,
                "subject_prefix": config.report.weekly.subject_prefix,
                "busy_threshold": config.report.weekly.busy_threshold,
                "idle_threshold": config.report.weekly.idle_threshold,
                "time": config.report.weekly.time,
                "weekday": config.report.weekly.weekday,
            },
        },
        "disk_health": {
            "enabled": config.disk_health.enabled,
            "use_sudo": config.disk_health.use_sudo,
            "storcli_candidates": list(config.disk_health.storcli_candidates),
            "rules": {
                "alert_on_media_errors": config.disk_health.rules.alert_on_media_errors,
                "alert_on_other_errors": config.disk_health.rules.alert_on_other_errors,
                "alert_on_predictive_failure": (
                    config.disk_health.rules.alert_on_predictive_failure
                ),
                "alert_on_smart_flag": config.disk_health.rules.alert_on_smart_flag,
                "alert_on_state_not_optimal": (
                    config.disk_health.rules.alert_on_state_not_optimal
                ),
                "alert_on_error_increase": (
                    config.disk_health.rules.alert_on_error_increase
                ),
            },
        },
        "hosts": hosts,
    }


def _settings_or_404(app: Flask):
    """Return ``(service, None)`` or ``(None, (response, 404))``.

    Every settings endpoint requires an injected :class:`SettingsService`; the
    legacy dashboard app (no service) reports 404 instead of crashing, matching
    the "route does not exist" semantics.
    """
    service = _settings_service(app)
    if service is None:
        return None, (jsonify({"error": "settings_unavailable"}), 404)
    return service, None


def _ensure_writable(service):
    """Return a 409 response when the service cannot persist, else ``None``."""
    if not service.is_writable():
        return jsonify({"error": "settings_not_writable"}), 409
    return None


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


# Format aliases accepted by the import preview / import endpoints.
_IMPORT_PARSERS = {
    "ssh": host_import.parse_ssh_config,
    "ssh_config": host_import.parse_ssh_config,
    "csv": host_import.parse_csv,
    "yaml": host_import.parse_yaml,
    "yml": host_import.parse_yaml,
}

# Fixed, non-configurable files: the log viewer and the single-instance state
# file never accept a caller-supplied path (avoids arbitrary file reads).
_LOG_FILE = Path("logs") / "servermonitor.log"
_RUNTIME_FILE = Path("data") / "runtime.json"


def _parse_import_payload(payload: dict[str, Any]):
    """Parse an import request body into a :class:`host_import.ParseResult`.

    Returns ``(result, None)`` on success or ``(None, (response, status))`` when
    the format is unknown or the content is missing.
    """
    fmt = str(payload.get("format") or "").strip().lower()
    parser = _IMPORT_PARSERS.get(fmt)
    if parser is None:
        return None, (jsonify({"error": "unsupported_format"}), 400)
    content = payload.get("content")
    if not isinstance(content, str):
        return None, (jsonify({"error": "invalid_payload"}), 400)
    return parser(content), None


def _truthy_arg(value: Any, default: bool = False) -> bool:
    """Coerce a query-string / JSON flag to a bool (``false``/``0``/``no``/``off``)."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"0", "false", "no", "off", ""}


def _host_config_from_payload(payload: dict[str, Any], *, name: str | None = None) -> HostConfig:
    """Build a transient :class:`HostConfig` for the SSH connectivity probe.

    The object is never persisted; secrets come straight from the request body so
    a "test connection" click does not have to save the host first.
    """
    auth_type = str(payload.get("auth_type") or "password")
    key_path_raw = payload.get("key_path")
    auth = AuthConfig(
        type=auth_type,
        password=_optional_text(payload.get("password")),
        key_data=_optional_text(payload.get("private_key")),
        key_path=(
            Path(str(key_path_raw)).expanduser() if key_path_raw else None
        ),
        passphrase=_optional_text(payload.get("passphrase")),
    )
    return HostConfig(
        name=name or str(payload.get("name") or payload.get("host") or "test"),
        host=str(payload.get("host") or ""),
        port=_as_int(payload.get("port"), 22),
        username=str(payload.get("username") or ""),
        auth=auth,
    )


# ---------------------------------------------------------------------------
# Task 7: first-run setup, CSRF and config refresh helpers
# ---------------------------------------------------------------------------

# Only a request originating from the same machine may complete first-run setup:
# until an admin credential exists there is nothing else guarding ``/setup``.
_LOOPBACK_ADDRESSES = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}

# Login throttling: the 6th failed attempt from one remote address inside the
# rolling window is rejected with 429 (5 failures are tolerated).
_LOGIN_FAILURE_LIMIT = 5
_LOGIN_FAILURE_WINDOW_SECONDS = 60


def _is_loopback(remote_addr: str | None) -> bool:
    return (remote_addr or "") in _LOOPBACK_ADDRESSES


def _csrf_token() -> str:
    """Return the per-session CSRF token, creating one on first use."""
    token = session.get("csrf_token")
    if not isinstance(token, str) or not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def _require_csrf():
    """Validate the CSRF token for a state-changing request.

    Returns ``None`` when the token is valid, otherwise a ``(body, 400)`` tuple
    ready to be returned from ``before_request``.  Accepts either the hidden
    ``csrf_token`` form field or the ``X-CSRF-Token`` header so plain HTML forms
    and fetch()/XHR clients both work.
    """
    expected = session.get("csrf_token")
    supplied = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token")
    if (
        not isinstance(expected, str)
        or not expected
        or not isinstance(supplied, str)
        or not supplied
    ):
        return ("CSRF 校验失败", 400)
    if not hmac.compare_digest(expected, supplied):
        return ("CSRF 校验失败", 400)
    return None


def _refresh_config(app: Flask) -> None:
    """Reload settings from the service and publish the new config to the app.

    Also rotates ``app.secret_key`` when the freshly loaded dashboard config
    carries a session secret, and notifies ``on_config_changed`` so the polling
    process can hot-apply the new settings.
    """
    service = _settings_service(app)
    if service is None:
        return
    new_config = service.load()
    app.config["CONFIG"] = new_config
    app.config["config"] = new_config
    new_secret = new_config.dashboard.session_secret
    if new_secret:
        app.secret_key = new_secret
    callback = app.config.get("ON_CONFIG_CHANGED")
    if callback is not None:
        callback(new_config)


def _parse_iso(value: Any) -> datetime | None:
    """Parse a stored ISO timestamp; naive values are treated as UTC."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _to_local_iso(value: Any, tz) -> Any:
    """Render a stored ISO UTC timestamp in *tz* with an explicit offset.

    Non-timestamp values (``None`` / already formatted strings that cannot be
    parsed) are returned unchanged so the templates keep degrading gracefully.
    """
    parsed = _parse_iso(value)
    if parsed is None:
        return value
    return parsed.astimezone(tz).isoformat()


def _localize_alerts(rows: list[dict[str, Any]], tz) -> list[dict[str, Any]]:
    """Render alert ``created_at`` values in the configured local timezone."""
    localized = []
    for row in rows:
        item = dict(row)
        item["created_at"] = _to_local_iso(item.get("created_at"), tz)
        localized.append(item)
    return localized


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _percent_int(value: Any) -> int | None:
    """Convert ``"45%"`` / ``45`` / ``45.0`` into ``45``; missing -> ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        digits = "".join(ch for ch in value if ch.isdigit())
        if digits:
            return int(digits)
    return None


def _memory_percent(metrics: dict[str, Any]) -> float | None:
    memory = metrics.get("memory") or {}
    total = _as_float(memory.get("total_mb"))
    used = _as_float(memory.get("used_mb"))
    if total is None or used is None or total <= 0:
        return None
    return round(used / total * 100.0, 2)


def _disk_percent(
    metrics: dict[str, Any],
    mounts: list[str] | None = None,
) -> float | None:
    rows = metrics.get("disk_usage") or []
    if mounts is not None:
        return disk_capacity.max_percent(rows, mounts)
    percents: list[int] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("filesystem") in _VIRTUAL_FILESYSTEMS:
            continue
        percent = _percent_int(row.get("percent"))
        if percent is not None and percent >= 0:
            percents.append(percent)
    if not percents:
        return None
    return float(max(percents))


def _gpu_memory_percent(metrics: dict[str, Any]) -> float | None:
    gpus = metrics.get("gpu_summary") or []
    used_total = 0.0
    memory_total = 0.0
    found = False
    for gpu in gpus:
        if not isinstance(gpu, dict):
            continue
        total = _as_float(gpu.get("memory_total_mb"))
        used = _as_float(gpu.get("memory_used_mb"))
        if total is None or used is None:
            continue
        found = True
        memory_total += total
        used_total += used
    if not found or memory_total <= 0:
        return None
    return round(used_total / memory_total * 100.0, 2)


def _disk_health_summary(health: dict[str, Any] | None) -> dict[str, Any]:
    """Overall disk status plus per-drive health counts from the latest batch."""
    counts = {"healthy": 0, "warning": 0, "critical": 0}
    if not health:
        return {"status": "unknown", **counts}
    for drive in health.get("physical_drives") or []:
        if not isinstance(drive, dict):
            continue
        value = str(drive.get("health") or "").lower()
        if value in counts:
            counts[value] += 1
    return {"status": str(health.get("status") or "unknown"), **counts}


def _is_online(snapshot: dict[str, Any], poll_interval_seconds: int, now: datetime) -> bool:
    """A host is online when its last snapshot succeeded recently.

    Rule: ``success`` must be true **and** ``collected_at`` must be no older than
    ``3 × poll_interval_seconds`` (default 30 minutes for a 600 s poll).  The 3×
    window tolerates one missed/slow poll cycle; anything older (or a failed
    collection) is shown offline.  A snapshot timestamp in the future is treated
    as fresh rather than offline.
    """
    if not snapshot.get("success"):
        return False
    collected = _parse_iso(snapshot.get("collected_at"))
    if collected is None:
        return False
    max_age = max(int(poll_interval_seconds), 1) * 3
    return (now - collected).total_seconds() <= max_age


def _metrics_payload(
    metrics: dict[str, Any],
    disk_mounts: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "cpu_percent": _as_float(metrics.get("cpu_usage_percent")),
        "memory_percent": _memory_percent(metrics),
        "disk_percent": _disk_percent(metrics, disk_mounts),
        "gpu_memory_percent": _gpu_memory_percent(metrics),
    }


def _logged_in_counts(metrics: dict[str, Any]) -> tuple[int, int]:
    """Return ``(distinct_usernames, sessions)`` from a snapshot metrics dict."""
    users = metrics.get("logged_in_users") or []
    sessions = 0
    usernames: set[str] = set()
    for user in users:
        if not isinstance(user, dict):
            continue
        sessions += 1
        username = user.get("username")
        if username:
            usernames.add(str(username))
    return len(usernames), sessions


def _host_row(
    *,
    name: str,
    host: str | None,
    snapshot: dict[str, Any] | None,
    disk_health: dict[str, Any] | None,
    poll_interval_seconds: int,
    now: datetime,
    tz,
    disk_mounts: list[str] | None = None,
    group: str = "未分组",
    owner: str = "",
    location: str = "",
    tags: list[str] | None = None,
    silenced: bool = False,
    silenced_until: str | None = None,
    active_alert_count: int = 0,
) -> dict[str, Any]:
    meta = {
        "group": group or "未分组",
        "owner": owner or "",
        "location": location or "",
        "tags": list(tags or []),
        "silenced": bool(silenced),
        "silenced_until": silenced_until,
        "active_alert_count": int(active_alert_count),
    }
    if snapshot is None:
        return {
            "name": name,
            "host": host,
            "online": False,
            "collected_at": None,
            "cpu_percent": None,
            "memory_percent": None,
            "disk_percent": None,
            "gpu_memory_percent": None,
            "logged_in_user_count": 0,
            "logged_in_sessions": 0,
            "disk_health": _disk_health_summary(disk_health),
            **meta,
        }
    metrics = snapshot.get("metrics") or {}
    user_count, session_count = _logged_in_counts(metrics)
    return {
        "name": name,
        "host": host,
        "online": _is_online(snapshot, poll_interval_seconds, now),
        "collected_at": _to_local_iso(snapshot.get("collected_at"), tz),
        **_metrics_payload(metrics, disk_mounts),
        "logged_in_user_count": user_count,
        "logged_in_sessions": session_count,
        "disk_health": _disk_health_summary(disk_health),
        **meta,
    }


def _silence_applies(silence: dict[str, Any], host_name: str, group: str) -> bool:
    """Return True when *silence* covers *host_name* in *group*."""
    scope_type = silence.get("scope_type")
    scope = silence.get("scope")
    if scope_type == "all":
        return True
    if scope_type == "host":
        return scope == host_name
    if scope_type == "group":
        return scope == (group or "未分组")
    return False


def _build_overview(config, db_path) -> dict[str, Any]:
    """Build the ``/api/overview`` payload shared by the JSON API and pages.

    Kept as one function so the server-rendered overview page and the 30 s
    polling refresh always agree on the summary counts and per-host rows.
    """
    now = datetime.now(timezone.utc)
    tz = resolve_timezone(config.app.timezone)

    snapshots = {
        item["host_name"]: item for item in storage.get_all_host_snapshots(db_path)
    }
    disk_reports = {
        item["host_name"]: item for item in storage.get_all_disk_health(db_path)
    }
    servers_by_name = {server.name: server for server in config.servers}
    addresses = {server.name: server.host for server in config.servers}
    mounts_by_host = {server.name: server.disk_mounts for server in config.servers}

    active_silences = storage.list_silences(db_path, active_only=True)
    active_alerts = storage.list_alerts(db_path, status="active", limit=100_000)
    alert_counts: dict[str, int] = {}
    for alert in active_alerts:
        host_name = alert.get("host_name")
        if host_name:
            alert_counts[host_name] = alert_counts.get(host_name, 0) + 1

    groups: list[str] = []
    for server in config.servers:
        group_name = server.group or "未分组"
        if group_name not in groups:
            groups.append(group_name)

    names: list[str] = []
    for server in config.servers:
        if server.name not in names:
            names.append(server.name)
    for host_name in snapshots:
        if host_name not in names:
            names.append(host_name)

    hosts: list[dict[str, Any]] = []
    silenced_count = 0
    for host_name in sorted(names):
        server = servers_by_name.get(host_name)
        group = (server.group if server is not None else None) or "未分组"
        matched = [
            silence
            for silence in active_silences
            if _silence_applies(silence, host_name, group)
        ]
        silenced_until = None
        if matched:
            silenced_count += 1
            ends = [s.get("ends_at") for s in matched if s.get("ends_at")]
            if ends:
                silenced_until = _to_local_iso(max(ends), tz)
        hosts.append(
            _host_row(
                name=host_name,
                host=addresses.get(host_name),
                snapshot=snapshots.get(host_name),
                disk_health=disk_reports.get(host_name),
                poll_interval_seconds=config.app.poll_interval_seconds,
                now=now,
                tz=tz,
                disk_mounts=mounts_by_host.get(host_name),
                group=group,
                owner=server.owner if server is not None else "",
                location=server.location if server is not None else "",
                tags=server.tags if server is not None else [],
                silenced=bool(matched),
                silenced_until=silenced_until,
                active_alert_count=alert_counts.get(host_name, 0),
            )
        )

    online = sum(1 for host in hosts if host["online"])
    return {
        "summary": {
            "online": online,
            "offline": len(hosts) - online,
            "active_alerts": len(active_alerts),
        },
        "meta": {
            "groups": groups,
            "silenced_count": silenced_count,
        },
        "hosts": hosts,
    }


def _build_host_detail(name: str, config, db_path) -> dict[str, Any] | None:
    """Build the ``/api/host/<name>`` payload, or ``None`` when unknown."""
    snapshot = storage.get_host_snapshot(name, db_path)
    if snapshot is None:
        return None

    addresses = {server.name: server.host for server in config.servers}
    servers_by_name = {server.name: server for server in config.servers}
    tz = resolve_timezone(config.app.timezone)
    disk = storage.get_disk_health(name, db_path)
    if disk is not None:
        disk = dict(disk)
        disk["collected_at"] = _to_local_iso(disk.get("collected_at"), tz)
    server = servers_by_name.get(name)
    return {
        "name": name,
        "host": addresses.get(name),
        "collected_at": _to_local_iso(snapshot.get("collected_at"), tz),
        "success": snapshot.get("success"),
        "group": (server.group if server is not None else None) or "未分组",
        "owner": server.owner if server is not None else "",
        "location": server.location if server is not None else "",
        "tags": list(server.tags) if server is not None else [],
        "metrics": snapshot.get("metrics") or {},
        "disk": disk,
    }


def register_routes(app: Flask) -> None:
    """Register auth guards, API routes and the login/logout endpoints."""

    # Expose the CSRF token helper to every template.
    app.jinja_env.globals["csrf_token"] = _csrf_token

    def _login_failures() -> dict[str, deque]:
        return app.extensions.setdefault("login_failures", {})

    def _too_many_failures(remote_addr: str) -> bool:
        now = time.monotonic()
        failures = _login_failures().get(remote_addr)
        if failures is None:
            return False
        while failures and now - failures[0] > _LOGIN_FAILURE_WINDOW_SECONDS:
            failures.popleft()
        return len(failures) >= _LOGIN_FAILURE_LIMIT

    def _record_failure(remote_addr: str) -> None:
        now = time.monotonic()
        failures = _login_failures().setdefault(remote_addr, deque())
        while failures and now - failures[0] > _LOGIN_FAILURE_WINDOW_SECONDS:
            failures.popleft()
        failures.append(now)

    @app.before_request
    def _require_login():
        path = request.path
        if path.startswith("/static/"):
            return None

        service = _settings_service(app)

        # 1) First-run setup gate.  ``/setup`` itself must stay reachable, and
        #    ``/login`` stays reachable so credentials can be checked/limited
        #    (it simply fails until setup has created the admin credential).
        if (
            path not in ("/setup", "/login")
            and service is not None
            and service.setup_required()
        ):
            if path.startswith("/api/"):
                return jsonify({"error": "setup_required"}), 428
            return redirect(url_for("setup"))

        # 2) CSRF protection for state-changing requests.  Enforced only when a
        #    settings service is wired in, so the legacy app built by
        #    ``tests/test_web_api.py`` (no service) keeps working unchanged.
        #    ``/login`` is exempt because the credential itself is the proof and
        #    ``/setup`` validates CSRF itself *after* its loopback check (a
        #    non-loopback POST must be 403, not 400).
        if (
            service is not None
            and path not in ("/login", "/setup")
            and request.method in ("POST", "PUT", "DELETE")
        ):
            rejection = _require_csrf()
            if rejection is not None:
                return rejection

        # 3) ``/setup`` and ``/login`` bypass the normal logged-in gate.
        if path in ("/setup", "/login"):
            return None

        config = _config(app)
        if not config.dashboard.auth.enabled:
            return None
        if session.get("logged_in"):
            return None
        if path.startswith("/api/"):
            return jsonify({"error": "unauthorized"}), 401
        return redirect(url_for("login"))

    # -- first-run setup ---------------------------------------------------

    @app.route("/setup", methods=["GET", "POST"])
    def setup():
        if not _is_loopback(request.remote_addr):
            return render_template("setup.html", error="首次设置只允许本机访问"), 403

        if request.method == "POST":
            rejection = _require_csrf()
            if rejection is not None:
                return rejection

        service = _settings_service(app)
        if service is None:
            return render_template("setup.html", error="设置服务不可用"), 500

        if request.method == "GET":
            if not service.setup_required():
                return redirect(url_for("login"))
            return render_template("setup.html")

        username = (request.form.get("username") or "").strip() or "admin"
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")

        error = None
        if len(password) < 8:
            error = "密码长度至少 8 位"
        elif password != confirm:
            error = "两次输入的密码不一致"
        else:
            try:
                service.set_admin_password(None, password, username=username)
            except SettingsError as exc:
                error = str(exc)
            else:
                _refresh_config(app)
                return redirect(url_for("login"))

        return render_template("setup.html", error=error, username=username), 400

    # -- authentication ----------------------------------------------------

    @app.get("/login")
    def login():
        if session.get("logged_in"):
            return redirect("/")
        return render_template("login.html")

    @app.post("/login")
    def login_submit():
        remote_addr = request.remote_addr or ""
        if _too_many_failures(remote_addr):
            LOGGER.warning("Dashboard login rate-limited for remote_addr=%r", remote_addr)
            return (
                render_template("login.html", error="尝试过于频繁，请稍后再试"),
                429,
            )

        auth = _config(app).dashboard.auth
        username = request.form.get("username", "")
        password = request.form.get("password", "")

        service = _settings_service(app)
        if service is not None:
            credentials_ok = bool(auth.enabled) and service.verify_admin(username, password)
        else:
            expected_username = auth.username or ""
            expected_password = auth.password or ""

            username_ok = hmac.compare_digest(username, expected_username)
            # An unset configured password must never authenticate (compare_digest
            # against "" would otherwise accept an empty password).
            password_ok = bool(expected_password) and hmac.compare_digest(
                password, expected_password
            )
            credentials_ok = bool(auth.enabled) and username_ok and password_ok

        if credentials_ok:
            _login_failures().pop(remote_addr, None)
            session.clear()
            session.permanent = True
            session["logged_in"] = True
            session["username"] = username
            return redirect("/")

        _record_failure(remote_addr)
        LOGGER.warning("Dashboard login failed for username=%r", username)
        return render_template("login.html", error="用户名或密码错误"), 401

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # -- JSON API ----------------------------------------------------------

    @app.get("/api/overview")
    def api_overview():
        return jsonify(_build_overview(_config(app), _db_path(app)))

    @app.get("/api/host/<name>")
    def api_host(name: str):
        detail = _build_host_detail(name, _config(app), _db_path(app))
        if detail is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(detail)

    @app.get("/api/alerts")
    def api_alerts():
        status = request.args.get("status") or None
        config = _config(app)
        rows = storage.list_alerts(_db_path(app), status=status)
        return jsonify(
            {"alerts": _localize_alerts(rows, resolve_timezone(config.app.timezone))}
        )

    @app.post("/api/alerts/<int:alert_id>/ack")
    def api_ack_alert(alert_id: int):
        # ``acknowledged`` (not ``active``) so the alert leaves the active list;
        # ``resolved`` stays reserved for the alert engine detecting recovery.
        storage.update_alert(
            alert_id,
            _db_path(app),
            status="acknowledged",
            ack_at=datetime.now(timezone.utc).isoformat(),
        )
        return jsonify({"ok": True})

    # -- settings API (Task 8) --------------------------------------------
    #
    # All mutating routes require an injected SettingsService (404 otherwise) and
    # a writable platform (409 otherwise).  ``_refresh_config`` re-composes the
    # runtime config after every successful write so callers can see the change
    # immediately and ``on_config_changed`` can hot-apply it.

    @app.get("/api/settings")
    def api_get_settings():
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        # ``public_settings`` already carries ``writable``/``setup_required``;
        # secrets are reduced to booleans and never echoed.
        return jsonify(service.public_settings())

    @app.put("/api/settings/<section>")
    def api_put_settings_section(section: str):
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        rejection = _ensure_writable(service)
        if rejection is not None:
            return rejection
        if section not in _ALLOWED_SETTINGS_SECTIONS:
            return jsonify({"error": "unknown_section"}), 404
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        try:
            service.save_section(section, payload)
        except SettingsError as exc:
            return jsonify({"error": str(exc)}), 400
        _refresh_config(app)
        return jsonify({"ok": True, "restart_required": section == "dashboard"})

    @app.get("/api/settings/hosts")
    def api_list_hosts():
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        return jsonify({"hosts": service.list_hosts()})

    @app.put("/api/settings/hosts/<name>")
    def api_upsert_host(name: str):
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        rejection = _ensure_writable(service)
        if rejection is not None:
            return rejection
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        try:
            service.upsert_host(name, payload)
        except SettingsError as exc:
            return jsonify({"error": str(exc)}), 400
        _refresh_config(app)
        return jsonify({"ok": True})

    @app.delete("/api/settings/hosts/<name>")
    def api_delete_host(name: str):
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        rejection = _ensure_writable(service)
        if rejection is not None:
            return rejection
        if service.get_host(name) is None:
            return jsonify({"error": "not_found"}), 404
        try:
            service.delete_host(name)
        except SettingsError as exc:
            return jsonify({"error": str(exc)}), 400
        _refresh_config(app)
        return jsonify({"ok": True})

    @app.post("/api/settings/password")
    def api_change_password():
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        rejection = _ensure_writable(service)
        if rejection is not None:
            return rejection
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        try:
            service.set_admin_password(
                payload.get("current_password"),
                payload.get("new_password"),
                username=payload.get("new_username"),
            )
        except SettingsError as exc:
            # SettingsError messages are user-facing and never contain a stack
            # trace or secret material.
            return jsonify({"error": str(exc)}), 400
        _refresh_config(app)
        return jsonify({"ok": True})

    @app.post("/api/settings/test-ssh")
    def api_test_ssh():
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        if not str(payload.get("host") or "").strip():
            return jsonify({"ok": False, "detail": "host 不能为空"})
        config = _config(app)
        try:
            host_config = _host_config_from_payload(payload)
            with SSHClientWrapper(
                host=host_config,
                connect_timeout=config.ssh.connect_timeout,
            ) as ssh:
                result = ssh.run("echo ok", timeout=config.ssh.command_timeout)
            return jsonify({"ok": True, "detail": result.stdout})
        except Exception as exc:  # noqa: BLE001 - report, never leak a traceback
            return jsonify({"ok": False, "detail": str(exc)})

    @app.post("/api/settings/test-email")
    def api_test_email():
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        host = str(payload.get("host") or "").strip()
        if not host:
            return jsonify({"ok": False, "detail": "host 不能为空"})
        port = _as_int(payload.get("port"), 25)
        username = str(payload.get("username") or "")
        password = str(payload.get("password") or "")
        if not password:
            configured = service.load().smtp
            if configured is not None:
                password = configured.password or ""
        use_ssl = bool(payload.get("use_ssl"))
        try:
            # Connectivity probe only: connect and authenticate, never send a mail.
            if use_ssl:
                server = smtplib.SMTP_SSL(host, port, timeout=10)
            else:
                server = smtplib.SMTP(host, port, timeout=10)
            try:
                if username:
                    server.login(username, password)
            finally:
                try:
                    server.quit()
                except Exception:  # noqa: BLE001 - best-effort teardown
                    pass
        except Exception as exc:  # noqa: BLE001 - text-only error surface
            return jsonify({"ok": False, "detail": str(exc)})
        return jsonify({"ok": True, "detail": "SMTP 连接与登录成功"})

    @app.post("/api/settings/test-webhook")
    def api_test_webhook():
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        url = str(payload.get("url") or "").strip()
        if not url:
            return jsonify({"ok": False, "detail": "url 不能为空"})
        kind = str(payload.get("type") or "generic")
        try:
            webhook = WebhookConfig(enabled=True, type=kind, url=url)
            event = AlertEvent(
                host_name="test",
                category="test",
                severity="info",
                title="Webhook 测试",
                message="这是一条来自设置页的测试通知",
                fingerprint="settings:test-webhook",
            )
            sent = send_webhook(webhook, event)
        except Exception as exc:  # noqa: BLE001 - text-only error surface
            return jsonify({"ok": False, "detail": str(exc)})
        return jsonify(
            {"ok": bool(sent), "detail": "已发送" if sent else "发送失败"}
        )

    # -- Task 9: host import / batch probe / copy ---------------------------

    @app.post("/api/settings/hosts/import/preview")
    def api_preview_host_import():
        """Parse pasted/uploaded host definitions without touching the store."""
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        parsed, parse_error = _parse_import_payload(payload)
        if parse_error is not None:
            return parse_error
        return jsonify(
            {
                "candidates": [asdict(candidate) for candidate in parsed.candidates],
                "errors": parsed.errors,
                "warnings": parsed.warnings,
            }
        )

    @app.post("/api/settings/hosts/import")
    def api_import_hosts():
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        rejection = _ensure_writable(service)
        if rejection is not None:
            return rejection
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        parsed, parse_error = _parse_import_payload(payload)
        if parse_error is not None:
            return parse_error
        try:
            result = service.import_hosts(
                [asdict(candidate) for candidate in parsed.candidates],
                overwrite=_truthy_arg(payload.get("overwrite")),
            )
        except SettingsError as exc:
            return jsonify({"error": str(exc)}), 400
        _refresh_config(app)
        return jsonify({"ok": True, "parse_errors": parsed.errors, **result})

    @app.post("/api/settings/hosts/test-batch")
    def api_test_hosts_batch():
        """Probe several saved hosts, one temporary connection at a time.

        Nothing is persisted and the response only carries a status line; secret
        material from the config is never copied into the payload.
        """
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        names = payload.get("names")
        if not isinstance(names, list) or not all(
            isinstance(name, str) for name in names
        ):
            return jsonify({"error": "invalid_payload"}), 400
        config = _config(app)
        servers = {server.name: server for server in config.servers}
        results = []
        for name in names:
            if service.get_host(name) is None:
                results.append({"name": name, "ok": False, "detail": "主机不存在"})
                continue
            host_config = servers.get(name)
            if host_config is None:
                results.append(
                    {"name": name, "ok": False, "detail": "主机配置不可用"}
                )
                continue
            try:
                with SSHClientWrapper(
                    host=host_config,
                    connect_timeout=config.ssh.connect_timeout,
                ) as ssh:
                    probe = ssh.run(
                        "echo ok", timeout=config.ssh.command_timeout
                    )
                detail = (probe.stdout or probe.stderr or "").strip()
                results.append(
                    {
                        "name": name,
                        "ok": probe.exit_status == 0,
                        "detail": detail,
                    }
                )
            except Exception as exc:  # noqa: BLE001 - text-only error surface
                results.append({"name": name, "ok": False, "detail": str(exc)})
        return jsonify({"results": results})

    @app.post("/api/settings/hosts/<name>/copy")
    def api_copy_host(name: str):
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        rejection = _ensure_writable(service)
        if rejection is not None:
            return rejection
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        new_name = str(payload.get("new_name") or "").strip()
        if not new_name:
            return jsonify({"error": "new_name 不能为空"}), 400
        if service.get_host(name) is None:
            return jsonify({"error": "not_found"}), 404
        try:
            service.copy_host(name, new_name)
        except SettingsError as exc:
            return jsonify({"error": str(exc)}), 400
        _refresh_config(app)
        return jsonify({"ok": True, "name": new_name})

    # -- Task 9: alert silences --------------------------------------------

    @app.get("/api/settings/silences")
    def api_list_silences():
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        active_only = _truthy_arg(request.args.get("active_only"), default=True)
        return jsonify(
            {"silences": service.list_silences(active_only=active_only)}
        )

    @app.post("/api/settings/silences")
    def api_add_silence():
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        rejection = _ensure_writable(service)
        if rejection is not None:
            return rejection
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        try:
            silence_id = service.add_silence(
                scope_type=payload.get("scope_type"),
                scope=payload.get("scope"),
                reason=str(payload.get("reason") or ""),
                starts_at=payload.get("starts_at"),
                ends_at=payload.get("ends_at"),
                created_by=session.get("username"),
            )
        except SettingsError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify({"ok": True, "id": silence_id})

    @app.delete("/api/settings/silences/<int:silence_id>")
    def api_delete_silence(silence_id: int):
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        rejection = _ensure_writable(service)
        if rejection is not None:
            return rejection
        if not service.delete_silence(silence_id):
            return jsonify({"error": "not_found"}), 404
        return jsonify({"ok": True})

    # -- Task 9: log tail and single-instance runtime state ----------------

    @app.get("/api/logs")
    def api_logs():
        """Return the tail of the fixed dashboard log.

        Response contract: ``lines`` is the tail *text* (design §3.9),
        ``text`` is the same content under the brief's naming, and
        ``line_count`` is the integer number of lines returned—so callers can
        tell the payload apart from the request parameter unambiguously.
        """
        lines = max(1, min(_as_int(request.args.get("lines"), 200), 2000))
        log_path = _LOG_FILE
        if not log_path.is_file():
            return jsonify(
                {"path": str(log_path), "lines": "", "text": "", "line_count": 0}
            )
        try:
            with log_path.open("r", encoding="utf-8", errors="replace") as handle:
                tail = deque(handle, maxlen=lines)
        except OSError as exc:
            return jsonify({"error": str(exc)}), 500
        text = "".join(tail)
        return jsonify(
            {
                "path": str(log_path),
                "lines": text,
                "text": text,
                "line_count": len(tail),
            }
        )

    @app.get("/api/runtime")
    def api_runtime():
        state = read_runtime_state(_RUNTIME_FILE)
        if not state:
            return jsonify({"url": None})
        return jsonify(
            {
                "url": state.get("url"),
                "port": state.get("port"),
                "pid": state.get("pid"),
            }
        )

    # -- HTML pages --------------------------------------------------------
    #
    # Page routes are login-protected by the ``before_request`` gate above: an
    # unauthenticated non-``/api`` request is redirected to ``/login`` (never a
    # 401 JSON body).  Each page renders its initial state server-side so the
    # dashboard is usable without JavaScript; ``app.js`` then refreshes the
    # dynamic parts every 30 s from the JSON API.

    @app.get("/")
    def overview_page():
        data = _build_overview(_config(app), _db_path(app))
        return render_template(
            "overview.html",
            active_page="overview",
            summary=data["summary"],
            meta=data["meta"],
            hosts=data["hosts"],
        )

    @app.get("/host/<name>")
    def host_page(name: str):
        detail = _build_host_detail(name, _config(app), _db_path(app))
        if detail is None:
            return (
                render_template(
                    "host.html", active_page="overview", name=name, detail=None
                ),
                404,
            )
        return render_template(
            "host.html", active_page="overview", name=name, detail=detail
        )

    @app.get("/alerts")
    def alerts_page():
        config = _config(app)
        alerts = _localize_alerts(
            storage.list_alerts(_db_path(app), status="active"),
            resolve_timezone(config.app.timezone),
        )
        return render_template(
            "alerts.html", active_page="alerts", alerts=alerts
        )

    @app.get("/settings")
    def settings_page():
        config = _config(app)
        service = _settings_service(app)
        settings = service.public_settings() if service is not None else _settings_snapshot(config)
        runtime = read_runtime_state(_RUNTIME_FILE) or {}
        silences = (
            service.list_silences(active_only=True) if service is not None else []
        )
        return render_template(
            "settings.html",
            active_page="settings",
            config=config,
            settings=settings,
            runtime=runtime,
            silences=silences,
        )
