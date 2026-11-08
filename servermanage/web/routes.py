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

import base64
import getpass
import hmac
import json
import logging
import os
import secrets
import smtplib
import tempfile
import time
from collections import deque
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)

from servermanage import disk_capacity, host_import, host_probe, storage
from servermanage.disk_health import AlertEvent
from servermanage.models import AuthConfig, HostConfig, WebhookConfig
from servermanage.notify_webhook import send_webhook
from servermanage.runtime import read_runtime_state
from servermanage.settings import SettingsError
from servermanage.ssh_client import SSHClientWrapper
from servermanage.ssh_terminal import (
    SessionNotFoundError,
    SshTerminalManager,
    TerminalLimitError,
)
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


def get_ssh_terminal_manager(app: Flask) -> SshTerminalManager:
    """Return the app-scoped SSH terminal manager, creating it on first use."""
    manager = app.extensions.get("ssh_terminal")
    if manager is None:
        manager = SshTerminalManager()
        app.extensions["ssh_terminal"] = manager
    return manager


def _terminal_request_allowed() -> bool:
    """Desktop-only terminal: require desktop launch and a loopback request."""
    if os.environ.get("SERVERMONITOR_DESKTOP") != "1":
        return False
    return _is_loopback(request.remote_addr)


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
    from servermanage import __version__ as app_version

    return {
        "writable": False,
        "version": app_version,
        "desktop_mode": False,
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


def _ssh_config_path() -> Path:
    """Fixed location of the current user's OpenSSH client config."""
    return Path.home() / ".ssh" / "config"


def _read_ssh_config_candidates():
    """Read and normalise the local SSH config.

    Returns ``(path, exists, result)``.  The file is read as bytes so the parser
    can try UTF-8-sig and fall back to GB18030; only the fixed user config path
    is ever read, never a caller-supplied one.
    """
    path = _ssh_config_path()
    if not path.is_file():
        return path, False, host_import.ParseResult()
    home = path.parent.parent
    raw = path.read_bytes()
    parsed = host_import.parse_ssh_config(raw, home=home)
    result = host_import.apply_import_defaults(
        parsed,
        raw,
        home=home,
        default_username=getpass.getuser(),
    )
    return path, True, result


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


def _csrf_failure_response():
    """Return a helpful response instead of an unstyled 400 for an expired page.

    A session cookie can legitimately go stale when the backend is restarted,
    when two copies share a host, or when a page was left open across an
    upgrade.  The old implementation returned the bare text "CSRF 校验失败",
    which looked like a broken white screen in the desktop window.  Now:
    - ``/logout`` always succeeds (logging out is not a sensitive action);
    - ``/api/*`` returns JSON so the JS can show a clear message;
    - other HTML form posts render a small, readable page asking to refresh.
    """
    if request.path == "/logout":
        session.clear()
        return redirect(url_for("login"))
    if request.path.startswith("/api/"):
        return (
            jsonify(
                {
                    "error": "csrf_failed",
                    "message": "页面已过期，请刷新页面后重试",
                }
            ),
            400,
        )
    surface = "登录" if request.path == "/login" else "当前"
    return (
        render_template(
            "csrf_error.html",
            message=f"{surface}页面的安全令牌已过期，请刷新页面后重试。",
        ),
        400,
    )


def _require_csrf():
    """Validate the CSRF token for a state-changing request.

    Returns ``None`` when the token is valid; otherwise a readable response
    (never bare text).  Accepts either the hidden ``csrf_token`` form field or
    the ``X-CSRF-Token`` header so plain HTML forms and fetch()/XHR clients both
    work.
    """
    expected = session.get("csrf_token")
    supplied = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token")
    if (
        not isinstance(expected, str)
        or not expected
        or not isinstance(supplied, str)
        or not supplied
    ):
        return _csrf_failure_response()
    if not hmac.compare_digest(expected, supplied):
        return _csrf_failure_response()
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


def _notify_hosts_imported(app: Flask, names: list[str]) -> None:
    """Trigger background collection after hosts were created/updated."""
    callback = app.config.get("ON_HOSTS_IMPORTED")
    if callback is None or not names:
        return
    try:
        callback(sorted({str(name) for name in names if str(name)}))
    except Exception:  # pragma: no cover - collection must not break the save
        LOGGER.exception("on_hosts_imported callback failed")


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


def _system_diagnostics(config, db_path, *, now: datetime | None = None) -> dict[str, Any]:
    """Build a small set of actionable checks for the system-health panel."""
    now = now or datetime.now(timezone.utc)
    checks: list[dict[str, str]] = []

    ok, message = storage.database_integrity(db_path)
    checks.append(
        {
            "key": "database",
            "label": "数据库",
            "status": "ok" if ok else "error",
            "message": message,
        }
    )

    snapshots = {
        item["host_name"]: item for item in storage.get_all_host_snapshots(db_path)
    }
    poll_interval = max(int(getattr(config.app, "poll_interval_seconds", 600) or 600), 1)
    offline: list[str] = []
    stale: list[str] = []
    missing: list[str] = []
    for server in config.servers:
        snapshot = snapshots.get(server.name)
        if snapshot is None:
            missing.append(server.name)
        elif not snapshot.get("success"):
            offline.append(server.name)
        elif not _is_online(snapshot, poll_interval, now):
            stale.append(server.name)
    total = len(config.servers)
    healthy = total - len(missing) - len(offline) - len(stale)
    if not total:
        host_status, host_message = "warning", "尚未配置监控主机"
    elif healthy <= 0:
        host_status = "error"
        host_message = f"{total} 台主机均未成功采集"
    elif missing or offline or stale:
        host_status = "warning"
        problems: list[str] = []
        if offline:
            problems.append("离线：" + "、".join(offline[:3]))
        if stale:
            problems.append("数据过期：" + "、".join(stale[:3]))
        if missing:
            problems.append("无数据：" + "、".join(missing[:3]))
        host_message = f"{healthy}/{total} 台采集正常；" + "；".join(problems)
    else:
        host_status, host_message = "ok", f"{total}/{total} 台采集正常"
    checks.append(
        {
            "key": "hosts",
            "label": "主机采集",
            "status": host_status,
            "message": host_message,
        }
    )

    disk_reports = storage.get_all_disk_health(db_path)
    bad_disks = [
        item
        for item in disk_reports
        if str(item.get("status") or "").lower() not in ("ok", "healthy")
    ]
    if not disk_reports:
        disk_status, disk_message = "ok", "尚未采集磁盘健康"
    elif bad_disks:
        disk_status = "warning"
        names = [str(item.get("host_name") or "未知") for item in bad_disks]
        disk_message = "异常主机：" + "、".join(names[:3])
    else:
        disk_status, disk_message = "ok", f"{len(disk_reports)} 台磁盘阵列健康"
    checks.append(
        {
            "key": "disk",
            "label": "磁盘阵列",
            "status": disk_status,
            "message": disk_message,
        }
    )

    tasks = storage.list_task_states(db_path)
    failed_tasks = [
        task
        for task in tasks
        if task.get("last_result") is not None and str(task.get("last_result")) != "ok"
    ]
    if failed_tasks:
        names = [str(task.get("task_name") or "未知") for task in failed_tasks]
        task_status, task_message = "warning", "最近失败：" + "、".join(names[:3])
    else:
        task_status, task_message = "ok", (
            f"{len(tasks)} 个调度任务正常" if tasks else "暂无调度记录"
        )
    checks.append(
        {
            "key": "tasks",
            "label": "调度任务",
            "status": task_status,
            "message": task_message,
        }
    )

    active_alerts = storage.list_alerts(db_path, status="active", limit=100_000)
    critical = [
        alert
        for alert in active_alerts
        if str(alert.get("severity") or "").lower() == "critical"
    ]
    if critical:
        alert_status = "warning"
        alert_message = f"{len(critical)} 条严重告警待处理"
    else:
        alert_status, alert_message = "ok", "没有未处理的严重告警"
    checks.append(
        {
            "key": "alerts",
            "label": "严重告警",
            "status": alert_status,
            "message": alert_message,
        }
    )

    if any(check["status"] == "error" for check in checks):
        overall = "error"
    elif any(check["status"] == "warning" for check in checks):
        overall = "warning"
    else:
        overall = "ok"
    return {"status": overall, "checks": checks}


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
    """Build the ``/api/host/<name>`` payload, or ``None`` when unknown.

    A host that is configured but has not been polled yet is still valid: the
    detail page opens with empty metrics instead of a 404, which is important
    right after adding a host (or while the first collection is failing).
    """
    snapshot = storage.get_host_snapshot(name, db_path)
    addresses = {server.name: server.host for server in config.servers}
    servers_by_name = {server.name: server for server in config.servers}
    server = servers_by_name.get(name)
    if snapshot is None and server is None:
        return None

    tz = resolve_timezone(config.app.timezone)
    disk = storage.get_disk_health(name, db_path)
    if disk is not None:
        disk = dict(disk)
        disk["collected_at"] = _to_local_iso(disk.get("collected_at"), tz)
    alerts = _localize_alerts(
        storage.list_alerts_for_host(name, db_path, limit=20),
        tz,
    )
    return {
        "name": name,
        "host": addresses.get(name),
        "collected_at": (
            _to_local_iso(snapshot.get("collected_at"), tz) if snapshot else None
        ),
        "success": snapshot.get("success") if snapshot else None,
        "group": (server.group if server is not None else None) or "未分组",
        "owner": server.owner if server is not None else "",
        "location": server.location if server is not None else "",
        "tags": list(server.tags) if server is not None else [],
        "metrics": (snapshot.get("metrics") or {}) if snapshot else {},
        "errors": (snapshot.get("errors") or []) if snapshot else [],
        "disk": disk,
        "alerts": alerts,
    }


def _report_number(value: Any) -> float | None:
    """Return *value* as a float, accepting values such as ``"45%"``."""
    if value is None or value == "":
        return None
    try:
        return float(str(value).strip().rstrip("%"))
    except (TypeError, ValueError):
        return None


def _build_host_report(
    detail: dict[str, Any],
    generated_at: datetime,
    *,
    include_heading: bool = True,
) -> str:
    """Render a plain-text diagnostic report for one host snapshot."""
    metrics = detail.get("metrics") or {}
    lines: list[str] = []
    if include_heading:
        lines.append("服务器轮询监测 · 主机诊断报告")
        lines.append("=" * 46)
        lines.append(f"生成时间：{generated_at.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    lines.append(f"主机名称：{detail.get('name') or '—'}")
    lines.append(f"主机地址：{detail.get('host') or '—'}")
    lines.append(f"分组：{detail.get('group') or '未分组'}")
    lines.append(f"负责人：{detail.get('owner') or '—'}")
    lines.append(f"位置：{detail.get('location') or '—'}")
    tags = detail.get("tags") or []
    lines.append(f"标签：{', '.join(str(tag) for tag in tags) if tags else '—'}")
    success = detail.get("success")
    status_text = "成功" if success else ("失败" if success is False else "等待首次采集")
    lines.append(f"采集状态：{status_text}")
    lines.append(f"采集时间：{detail.get('collected_at') or '—'}")
    lines.append("")
    lines.append("[系统概览]")
    lines.append(f"  操作系统：{metrics.get('os_pretty_name') or '—'}")
    lines.append(f"  内核版本：{metrics.get('kernel_version') or '—'}")
    lines.append(f"  主机名：{metrics.get('hostname') or '—'}")
    lines.append(f"  运行时长：{metrics.get('uptime') or '—'}")
    lines.append(f"  CPU 核心：{metrics.get('cpu_core_count') if metrics.get('cpu_core_count') is not None else '—'}")
    cpu = _report_number(metrics.get("cpu_usage_percent"))
    lines.append(f"  CPU 使用率：{f'{cpu:.1f}%' if cpu is not None else '—'}")
    memory = metrics.get("memory") or {}
    total_mb = _report_number(memory.get("total_mb"))
    used_mb = _report_number(memory.get("used_mb"))
    if total_mb and used_mb is not None:
        mem_percent = used_mb / total_mb * 100
        lines.append(f"  内存：{used_mb:.0f} / {total_mb:.0f} MB（{mem_percent:.1f}%）")
    else:
        mem_percent = None
        lines.append("  内存：—")
    load = metrics.get("load_average") or {}
    if load:
        lines.append(
            "  负载（1/5/15）：{} / {} / {}".format(
                load.get("load_1", "—"), load.get("load_5", "—"), load.get("load_15", "—")
            )
        )
    else:
        lines.append("  负载（1/5/15）：—")
    lines.append("")
    lines.append("[磁盘挂载]")
    mounts = []
    for row in metrics.get("disk_usage") or []:
        filesystem = str(row.get("filesystem") or "")
        mountpoint = str(row.get("mountpoint") or "")
        if filesystem in _VIRTUAL_FILESYSTEMS:
            continue
        if filesystem.startswith("/dev/loop") or mountpoint.startswith("/snap"):
            continue
        mounts.append(row)
    if mounts:
        for row in mounts:
            lines.append(
                "  {}  {}  {}/{}（{}）".format(
                    row.get("mountpoint") or "—",
                    row.get("filesystem") or "—",
                    row.get("used") or "—",
                    row.get("size") or "—",
                    row.get("percent") or "—",
                )
            )
    else:
        lines.append("  （无）")
    lines.append("")
    lines.append("[GPU]")
    gpus = metrics.get("gpu_summary") or []
    if gpus:
        for gpu in gpus:
            lines.append(
                "  GPU{} {}：利用率 {}%，显存 {}/{} MB，温度 {}°C".format(
                    gpu.get("index", "—"),
                    gpu.get("name") or "—",
                    gpu.get("utilization_percent", "—"),
                    gpu.get("memory_used_mb", "—"),
                    gpu.get("memory_total_mb", "—"),
                    gpu.get("temperature_c", "—"),
                )
            )
    else:
        lines.append("  （无 GPU 数据）")
    lines.append("")
    lines.append("[当前登录用户]")
    users = metrics.get("logged_in_users") or []
    if users:
        for user in users:
            lines.append(
                "  {}  终端 {}  来源 {}  登录 {}".format(
                    user.get("username") or "—",
                    user.get("terminal") or "—",
                    user.get("remote_host") or "—",
                    user.get("login_at") or "—",
                )
            )
    else:
        lines.append("  （无登录会话）")
    lines.append("")
    lines.append("[CPU 占用前 3 进程]")
    processes = metrics.get("top_cpu_processes") or []
    if processes:
        for proc in processes[:3]:
            command = " ".join(str(proc.get("command") or "").split())
            if len(command) > 120:
                command = command[:117] + "..."
            lines.append(
                "  PID {}  {}  CPU {}%  内存 {}%  {}".format(
                    proc.get("pid", "—"),
                    proc.get("username") or "—",
                    proc.get("cpu_percent", "—"),
                    proc.get("mem_percent", "—"),
                    command or "—",
                )
            )
    else:
        lines.append("  （无进程数据）")
    lines.append("")
    lines.append("[磁盘阵列健康]")
    disk = detail.get("disk") or {}
    if disk:
        lines.append(f"  状态：{disk.get('status') or '—'}")
        lines.append(f"  消息：{disk.get('message') or '—'}")
        lines.append(f"  采集时间：{disk.get('collected_at') or '—'}")
    else:
        lines.append("  （暂无磁盘阵列数据）")
    lines.append("")
    lines.append("[最近采集异常]")
    errors = detail.get("errors") or []
    if errors:
        for err in errors:
            lines.append(f"  - {err.get('stage') or 'unknown'}：{err.get('message') or '—'}")
    else:
        lines.append("  （无）")
    lines.append("")
    lines.append("[最近告警]")
    recent_alerts = detail.get("alerts") or []
    if recent_alerts:
        for alert in recent_alerts[:5]:
            lines.append(
                "  {} [{}] {}（{}）".format(
                    alert.get("created_at") or "—",
                    alert.get("severity") or "—",
                    alert.get("title") or "—",
                    alert.get("status") or "—",
                )
            )
    else:
        lines.append("  （无）")
    lines.append("")
    lines.append("[重点关注]")
    attention: list[str] = []
    if success is False:
        attention.append("最近一次采集失败，请检查 SSH 连接和凭据。")
    elif success is None:
        attention.append("尚未完成首次采集，请先测试连接并立即采集。")
    for err in errors:
        attention.append(f"采集异常：{err.get('stage') or 'unknown'} - {err.get('message') or '未知错误'}")
    if cpu is not None and cpu >= 90:
        attention.append(f"CPU 使用率达到 {cpu:.1f}%，请检查高负载进程。")
    if mem_percent is not None and mem_percent >= 90:
        attention.append(f"内存使用率达到 {mem_percent:.1f}%，请检查内存占用。")
    for row in mounts:
        percent = _report_number(row.get("percent"))
        if percent is not None and percent >= 90:
            attention.append(f"挂载点 {row.get('mountpoint') or '—'} 使用率达到 {percent:.0f}%。")
    disk_status = str(disk.get("status") or "").lower()
    if disk_status and disk_status not in ("ok", "healthy"):
        attention.append(f"磁盘阵列状态为 {disk.get('status')}：{disk.get('message') or '请检查存储控制器'}。")
    if not attention:
        attention.append("未发现明显异常。")
    for item in attention:
        lines.append(f"  - {item}")
    lines.append("")
    lines.append("（报告由服务器轮询监测工具自动生成）")
    return "\n".join(lines) + "\n"


def _report_filename(name: str, generated_at: datetime) -> str:
    safe = "".join(
        char if (char.isascii() and (char.isalnum() or char in "-_")) else "_"
        for char in name
    ).strip("_") or "host"
    return f"host-report-{safe}-{generated_at.strftime('%Y%m%d-%H%M%S')}.txt"


def _fleet_report_filename(generated_at: datetime) -> str:
    return f"fleet-report-{generated_at.strftime('%Y%m%d-%H%M%S')}.txt"


def _build_fleet_report(config: Any, db_path: Path, generated_at: datetime) -> str:
    """Render one plain-text inspection report covering every configured host.

    The report opens with a fleet-wide summary and per-host one-line snapshot,
    then appends the detailed diagnostic report for each host.  It is meant to
    be saved or mailed as a point-in-time handover/check-up artifact.
    """
    details: list[dict[str, Any]] = []
    for server in config.servers:
        detail = _build_host_detail(server.name, config, db_path)
        if detail is not None:
            details.append(detail)
    total = len(details)
    succeeded = sum(1 for detail in details if detail.get("success") is True)
    failed = sum(1 for detail in details if detail.get("success") is False)
    waiting = total - succeeded - failed
    active_alerts = sum(
        1
        for detail in details
        for alert in (detail.get("alerts") or [])
        if alert.get("status") == "active"
    )
    disk_attention = sum(
        1
        for detail in details
        if str((detail.get("disk") or {}).get("status") or "").lower()
        not in ("", "ok", "healthy")
    )

    lines: list[str] = [
        "服务器轮询监测 · 全网巡检报告",
        "=" * 50,
        f"生成时间：{generated_at.strftime('%Y-%m-%d %H:%M:%S %Z')}",
        f"主机总数：{total}",
        f"采集成功：{succeeded}",
        f"采集失败：{failed}",
        f"等待首次采集：{waiting}",
        f"活动告警：{active_alerts}",
        f"磁盘阵列异常：{disk_attention}",
        "",
        "[主机摘要]",
    ]
    if not details:
        lines.append("  （未配置主机）")
    for detail in details:
        metrics = detail.get("metrics") or {}
        cpu = _report_number(metrics.get("cpu_usage_percent"))
        memory = metrics.get("memory") or {}
        total_mb = _report_number(memory.get("total_mb"))
        used_mb = _report_number(memory.get("used_mb"))
        mem_percent = (
            used_mb / total_mb * 100 if total_mb and used_mb is not None else None
        )
        root_percent = None
        for row in metrics.get("disk_usage") or []:
            if str(row.get("mountpoint") or "") == "/":
                root_percent = _report_number(row.get("percent"))
                break
        success = detail.get("success")
        status_text = "成功" if success is True else ("失败" if success is False else "等待采集")
        host_alerts = sum(
            1 for alert in (detail.get("alerts") or []) if alert.get("status") == "active"
        )
        lines.append(
            "  {} | {} | {} | 状态 {} | CPU {} | 内存 {} | 根目录 {} | 活动告警 {}".format(
                detail.get("name") or "—",
                detail.get("host") or "—",
                detail.get("group") or "未分组",
                status_text,
                f"{cpu:.1f}%" if cpu is not None else "—",
                f"{mem_percent:.1f}%" if mem_percent is not None else "—",
                f"{root_percent:.1f}%" if root_percent is not None else "—",
                host_alerts,
            )
        )
    lines.append("")
    for index, detail in enumerate(details, 1):
        lines.append("-" * 60)
        lines.append(f"【主机 {index}/{total}】{detail.get('name') or '—'}")
        lines.append("-" * 60)
        lines.append(
            _build_host_report(detail, generated_at, include_heading=False).rstrip()
        )
        lines.append("")
    lines.append("（报告由服务器轮询监测工具自动生成）")
    return "\n".join(lines) + "\n"


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

        # 1b) Unauthenticated API calls must be 401 even for POST/PUT/DELETE;
        # otherwise a missing session yields a CSRF 400 which is misleading.
        if path.startswith("/api/") and service is not None:
            api_config = _config(app)
            if api_config.dashboard.auth.enabled and not session.get("logged_in"):
                return jsonify({"error": "unauthorized"}), 401

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

    # -- host connection probe ---------------------------------------------

    @app.post("/api/settings/hosts/probe")
    def probe_host_settings():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict) or not str(payload.get("host") or "").strip():
            return jsonify({"ok": False, "status": "invalid", "message": "请填写服务器地址"}), 400
        try:
            result = host_probe.probe_host(payload)
        except Exception as exc:  # defensive; probe_host normally reports failures
            LOGGER.exception("Host probe failed unexpectedly")
            return jsonify({"ok": False, "status": "error", "message": f"探测失败：{exc}"}), 200
        return jsonify(asdict(result)), 200

    # -- SSH terminal (desktop-only, loopback-only) ------------------------

    def _terminal_denied():
        if not _terminal_request_allowed():
            return jsonify({"error": "forbidden", "message": "SSH 终端仅限本机桌面客户端"}), 403
        return None

    def _find_host(name: str):
        for host in _config(app).servers:
            if host.name == name:
                return host
        return None

    @app.post("/api/ssh/sessions")
    def create_ssh_session():
        denied = _terminal_denied()
        if denied is not None:
            return denied
        payload = request.get_json(silent=True) or {}
        host_name = str(payload.get("host_name") or "").strip()
        host = _find_host(host_name)
        if host is None:
            return jsonify({"error": "host_not_found"}), 404
        try:
            cols = max(20, min(400, int(payload.get("cols", 80))))
            rows = max(5, min(200, int(payload.get("rows", 24))))
        except (TypeError, ValueError):
            return jsonify({"error": "invalid_size"}), 400
        manager = get_ssh_terminal_manager(app)
        try:
            session_id = manager.create(host, cols=cols, rows=rows)
        except TerminalLimitError:
            return jsonify({"error": "terminal_limit"}), 429
        except Exception as exc:  # SSH failures must surface as JSON
            LOGGER.warning("SSH terminal create failed for %s: %s", host_name, exc)
            return jsonify({"error": "ssh_failed", "message": str(exc)}), 502
        audit_id = storage.record_ssh_session_start(
            host_name,
            username=str(session.get("username") or "admin"),
            server_username=host.username,
            remote_addr=request.remote_addr or "127.0.0.1",
            db_path=_db_path(app),
        )
        app.extensions.setdefault("ssh_audit", {})[session_id] = audit_id
        return jsonify({"session_id": session_id}), 201

    def _terminal_session_or_none(session_id: str):
        manager = get_ssh_terminal_manager(app)
        try:
            return manager.get_session(session_id)
        except SessionNotFoundError:
            return None

    @app.post("/api/ssh/sessions/<session_id>/input")
    def ssh_terminal_input(session_id: str):
        denied = _terminal_denied()
        if denied is not None:
            return denied
        if _terminal_session_or_none(session_id) is None:
            return jsonify({"error": "session_not_found"}), 404
        payload = request.get_json(silent=True) or {}
        data = payload.get("data", "")
        if not isinstance(data, str):
            return jsonify({"error": "invalid_data"}), 400
        try:
            get_ssh_terminal_manager(app).send_input(session_id, data)
        except SessionNotFoundError:
            return jsonify({"error": "session_not_found"}), 404
        return "", 204

    @app.post("/api/ssh/sessions/<session_id>/resize")
    def ssh_terminal_resize(session_id: str):
        denied = _terminal_denied()
        if denied is not None:
            return denied
        if _terminal_session_or_none(session_id) is None:
            return jsonify({"error": "session_not_found"}), 404
        payload = request.get_json(silent=True) or {}
        try:
            cols = max(20, min(400, int(payload.get("cols", 80))))
            rows = max(5, min(200, int(payload.get("rows", 24))))
        except (TypeError, ValueError):
            return jsonify({"error": "invalid_size"}), 400
        try:
            get_ssh_terminal_manager(app).resize(session_id, cols, rows)
        except SessionNotFoundError:
            return jsonify({"error": "session_not_found"}), 404
        return "", 204

    def _finish_ssh_audit(session_id: str, status: str, error: str | None = None) -> None:
        audit_id = app.extensions.get("ssh_audit", {}).pop(session_id, None)
        if audit_id is None:
            return
        try:
            storage.record_ssh_session_end(
                audit_id, status=status, error=error, db_path=_db_path(app)
            )
        except Exception:  # auditing must never break the session close
            LOGGER.exception("Failed to finalise SSH audit row %s", audit_id)

    @app.delete("/api/ssh/sessions/<session_id>")
    def ssh_terminal_close(session_id: str):
        denied = _terminal_denied()
        if denied is not None:
            return denied
        manager = get_ssh_terminal_manager(app)
        closed = manager.close(session_id)
        if not closed and _terminal_session_or_none(session_id) is None:
            return jsonify({"error": "session_not_found"}), 404
        _finish_ssh_audit(session_id, "closed")
        return "", 204

    @app.get("/api/ssh/sessions/<session_id>/stream")
    def ssh_terminal_stream(session_id: str):
        denied = _terminal_denied()
        if denied is not None:
            return denied
        manager = get_ssh_terminal_manager(app)
        if _terminal_session_or_none(session_id) is None:
            return jsonify({"error": "session_not_found"}), 404

        def generate():
            outcome = "closed"
            error_text = None
            try:
                for chunk in manager.stream(session_id):
                    if chunk:
                        yield b"data: " + base64.b64encode(chunk) + b"\n\n"
                    else:
                        yield b": keepalive\n\n"
            except Exception as exc:  # client disconnect / SSH error
                outcome = "error"
                error_text = f"{type(exc).__name__}: {exc}"
                LOGGER.info("SSH terminal stream ended with error: %s", error_text)
            finally:
                try:
                    manager.close(session_id)
                finally:
                    _finish_ssh_audit(session_id, outcome, error_text)

        return Response(
            generate(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

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

    @app.get("/api/overview/history")
    def api_overview_history():
        range_key = request.args.get("range", "24h")
        if range_key not in ("24h", "7d", "30d"):
            return jsonify({"error": "invalid_range"}), 400
        config = _config(app)
        points = storage.fetch_overview_history(
            _db_path(app),
            range_key=range_key,
            tz=resolve_timezone(config.app.timezone),
        )
        return jsonify({"range": range_key, "points": points})

    @app.get("/api/overview/alert-history")
    def api_overview_alert_history():
        range_key = request.args.get("range", "24h")
        if range_key not in ("24h", "7d", "30d"):
            return jsonify({"error": "invalid_range"}), 400
        config = _config(app)
        buckets = storage.fetch_alert_history(
            _db_path(app),
            range_key=range_key,
            tz=resolve_timezone(config.app.timezone),
        )
        return jsonify({"range": range_key, "buckets": buckets})

    @app.get("/api/host/<name>")
    def api_host(name: str):
        detail = _build_host_detail(name, _config(app), _db_path(app))
        if detail is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(detail)

    @app.get("/api/host/<name>/report")
    def api_host_report(name: str):
        detail = _build_host_detail(name, _config(app), _db_path(app))
        if detail is None:
            return jsonify({"error": "not found"}), 404
        config = _config(app)
        generated_at = datetime.now(resolve_timezone(config.app.timezone))
        text = _build_host_report(detail, generated_at)
        return Response(
            "﻿" + text,
            mimetype="text/plain",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{_report_filename(name, generated_at)}"'
                )
            },
        )

    @app.get("/api/overview/report")
    def api_overview_report():
        config = _config(app)
        generated_at = datetime.now(resolve_timezone(config.app.timezone))
        text = _build_fleet_report(config, _db_path(app), generated_at)
        return Response(
            "﻿" + text,
            mimetype="text/plain",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{_fleet_report_filename(generated_at)}"'
                )
            },
        )

    @app.get("/api/host/<name>/history")
    def api_host_history(name: str):
        range_key = request.args.get("range", "24h")
        if range_key not in ("24h", "7d", "30d"):
            return jsonify({"error": "invalid_range"}), 400
        detail = _build_host_detail(name, _config(app), _db_path(app))
        if detail is None:
            return jsonify({"error": "not found"}), 404
        config = _config(app)
        points = storage.fetch_host_history(
            _db_path(app),
            name,
            range_key=range_key,
            tz=resolve_timezone(config.app.timezone),
        )
        return jsonify({"range": range_key, "points": points})

    @app.get("/api/system/health")
    def api_system_health():
        from servermanage import __version__ as app_version

        config = _config(app)
        stats = storage.system_stats(_db_path(app))
        runtime = read_runtime_state(_RUNTIME_FILE) or {}
        return jsonify(
            {
                "version": app_version,
                "runtime": runtime,
                "tasks": storage.list_task_states(_db_path(app)),
                "hosts_configured": len(config.servers),
                "diagnostics": _system_diagnostics(config, _db_path(app)),
                **stats,
            }
        )

    @app.get("/api/system/backup")
    def api_system_backup():
        """Download a consistent snapshot of the SQLite database."""
        handle, temp_name = tempfile.mkstemp(prefix="servermonitor-backup-", suffix=".db")
        os.close(handle)
        temp_path = Path(temp_name)
        try:
            storage.backup_database(_db_path(app), temp_path)
            data = temp_path.read_bytes()
        finally:
            temp_path.unlink(missing_ok=True)

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        return Response(
            data,
            mimetype="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="servermonitor-backup-{stamp}.db"'
            },
        )

    @app.post("/api/system/restore")
    def api_system_restore():
        """Restore the database from an uploaded backup (admin only)."""
        if request.content_length and request.content_length > 100 * 1024 * 1024:
            return jsonify({"error": "备份文件不能超过 100 MB"}), 413
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            return jsonify({"error": "请选择备份文件"}), 400

        handle, temp_name = tempfile.mkstemp(prefix="servermonitor-restore-", suffix=".db")
        os.close(handle)
        incoming = Path(temp_name)
        try:
            upload.save(incoming)
            try:
                storage.validate_backup_database(incoming)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400

            db_path = _db_path(app)
            safety_dir = db_path.parent / "backups"
            safety_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            safety = safety_dir / f"pre-restore-{stamp}.db"
            storage.backup_database(db_path, safety)
            storage.restore_database(incoming, db_path)
        finally:
            incoming.unlink(missing_ok=True)

        return jsonify(
            {
                "ok": True,
                "restart_required": True,
                "safety_backup": str(safety),
                "message": "数据库已恢复，请关闭并重新打开工具使配置生效。",
            }
        )

    @app.get("/api/system/config-export")
    def api_system_config_export():
        """Download the non-secret configuration as a JSON document."""
        service = app.config.get("SETTINGS_SERVICE")
        if service is None:
            return jsonify({"error": "settings service unavailable"}), 404
        payload = json.dumps(service.public_settings(), ensure_ascii=False, indent=2)
        return Response(
            payload,
            mimetype="application/json",
            headers={
                "Content-Disposition": "attachment; filename=servermonitor-config.json"
            },
        )

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

    @app.get("/api/settings/hosts/collection-status")
    def api_host_collection_status():
        provider = app.config.get("COLLECTION_STATUS_PROVIDER")
        if provider is None:
            return jsonify({"statuses": {}})
        raw_names = request.args.get("names")
        names = None
        if raw_names is not None:
            names = [item.strip() for item in raw_names.split(",") if item.strip()]
        try:
            statuses = provider(names)
        except Exception:  # noqa: BLE001 - status is best effort
            LOGGER.exception("collection_status provider failed")
            statuses = {}
        return jsonify({"statuses": statuses})

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
        _notify_hosts_imported(app, [name])
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

    @app.get("/api/settings/hosts/ssh-config")
    def api_ssh_config_preview():
        """Return hosts parsed from the local ``~/.ssh/config`` for confirmation."""
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        path, exists, parsed = _read_ssh_config_candidates()
        return jsonify(
            {
                "path": str(path),
                "exists": exists,
                "default_username": getpass.getuser(),
                "candidates": [asdict(candidate) for candidate in parsed.candidates],
                "errors": parsed.errors,
                "warnings": parsed.warnings,
            }
        )

    @app.post("/api/settings/hosts/ssh-config/import")
    def api_ssh_config_import():
        """Import selected hosts from ``~/.ssh/config``.

        The file is re-read server-side; ``names`` only selects from the fresh
        parse, so a browser cannot inject a made-up host or credential.
        """
        service, error = _settings_or_404(app)
        if error is not None:
            return error
        rejection = _ensure_writable(service)
        if rejection is not None:
            return rejection
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        names = payload.get("names")
        if names is not None and (
            not isinstance(names, list) or not all(isinstance(n, str) for n in names)
        ):
            return jsonify({"error": "invalid_payload"}), 400
        _path, exists, parsed = _read_ssh_config_candidates()
        selected = set(names) if names is not None else None
        candidates = [
            asdict(candidate)
            for candidate in parsed.candidates
            if selected is None or candidate.name in selected
        ]
        if selected is not None and not candidates:
            return jsonify(
                {"ok": False, "error": "no_matching_hosts", "candidates": []}
            ), 400
        try:
            result = service.import_hosts(
                candidates,
                overwrite=_truthy_arg(payload.get("overwrite")),
                allow_missing_credentials=True,
            )
        except SettingsError as exc:
            return jsonify({"error": str(exc)}), 400
        _refresh_config(app)
        _notify_hosts_imported(app, result.get("created", []) + result.get("updated", []))
        return jsonify(
            {
                "ok": True,
                "exists": exists,
                "parse_errors": parsed.errors,
                "warnings": parsed.warnings,
                **result,
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
        _notify_hosts_imported(app, result.get("created", []) + result.get("updated", []))
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

    @app.post("/api/settings/hosts/<name>/probe")
    def api_probe_saved_host(name: str):
        """Probe a saved host using its stored credentials.

        This is the host-detail "test connection" button.  The probe is
        read-only; no secret is ever returned to the browser.
        """
        config = _config(app)
        host_config = next((h for h in config.servers if h.name == name), None)
        if host_config is None:
            return jsonify({"error": "not_found"}), 404
        result = host_probe.probe_host(
            host_config, timeout=config.ssh.connect_timeout
        )
        return jsonify(asdict(result))

    @app.post("/api/settings/hosts/<name>/collect")
    def api_collect_saved_host(name: str):
        """Queue an immediate status + disk collection for one saved host."""
        config = _config(app)
        if not any(h.name == name for h in config.servers):
            return jsonify({"error": "not_found"}), 404
        callback = app.config.get("ON_HOSTS_IMPORTED")
        if callback is None:
            return jsonify({"error": "collection_unavailable"}), 409
        try:
            callback([name])
        except Exception:  # noqa: BLE001 - surface a stable error
            LOGGER.exception("immediate collection failed for %s", name)
            return jsonify({"error": "collection_failed"}), 500
        return jsonify({"ok": True})

    @app.post("/api/settings/hosts/collect")
    def api_collect_saved_hosts():
        """Queue an immediate collection for several saved hosts.

        The browser sends ``{"names": [...]}``; an empty or omitted list means
        every saved host. Unknown names are ignored instead of failing the
        whole batch.
        """
        config = _config(app)
        saved_names = [host.name for host in config.servers]
        payload = request.get_json(silent=True)
        if payload is None:
            selected = saved_names
        elif not isinstance(payload, dict):
            return jsonify({"error": "invalid_payload"}), 400
        else:
            raw_names = payload.get("names")
            if raw_names is None:
                selected = saved_names
            elif not isinstance(raw_names, list):
                return jsonify({"error": "invalid_payload"}), 400
            else:
                wanted = {str(name) for name in raw_names}
                selected = [name for name in saved_names if name in wanted]
        if not selected:
            return jsonify({"ok": True, "count": 0})
        callback = app.config.get("ON_HOSTS_IMPORTED")
        if callback is None:
            return jsonify({"error": "collection_unavailable"}), 409
        try:
            callback(selected)
        except Exception:  # noqa: BLE001 - surface a stable error
            LOGGER.exception("batch collection failed for %s", selected)
            return jsonify({"error": "collection_failed"}), 500
        return jsonify({"ok": True, "count": len(selected)})

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
        _notify_hosts_imported(app, [new_name])
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

    @app.get("/api/logs/download")
    def api_logs_download():
        """Download the complete dashboard log file."""
        if not _LOG_FILE.is_file():
            return jsonify({"error": "log file not found"}), 404
        return send_file(
            _LOG_FILE,
            as_attachment=True,
            download_name="servermonitor.log",
            mimetype="text/plain",
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

    @app.get("/hosts")
    def hosts_page():
        data = _build_overview(_config(app), _db_path(app))
        return render_template(
            "hosts.html",
            active_page="hosts",
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
                    "host.html", active_page="hosts", name=name, detail=None
                ),
                404,
            )
        return render_template(
            "host.html", active_page="hosts", name=name, detail=detail
        )

    @app.get("/disk-health")
    def disk_health_page():
        config = _config(app)
        db_path = _db_path(app)
        tz = resolve_timezone(config.app.timezone)
        healths = {
            item["host_name"]: item for item in storage.get_all_disk_health(db_path)
        }
        names = []
        for server in config.servers:
            if server.name not in names:
                names.append(server.name)
        for host_name in healths:
            if host_name not in names:
                names.append(host_name)

        addresses = {server.name: server.host for server in config.servers}
        groups = {server.name: (server.group or "未分组") for server in config.servers}
        host_rows: list[dict[str, Any]] = []
        drives: list[dict[str, Any]] = []
        totals = {"healthy": 0, "warning": 0, "critical": 0, "drives": 0}
        for host_name in sorted(names):
            health = healths.get(host_name)
            counts = _disk_health_summary(health)
            totals["healthy"] += counts["healthy"]
            totals["warning"] += counts["warning"]
            totals["critical"] += counts["critical"]
            totals["drives"] += counts["healthy"] + counts["warning"] + counts["critical"]
            host_rows.append(
                {
                    "name": host_name,
                    "host": addresses.get(host_name),
                    "group": groups.get(host_name, "未分组"),
                    "status": counts["status"],
                    "healthy": counts["healthy"],
                    "warning": counts["warning"],
                    "critical": counts["critical"],
                    "controller_count": len((health or {}).get("controllers") or []),
                    "vd_count": len((health or {}).get("virtual_drives") or []),
                    "pd_count": len((health or {}).get("physical_drives") or []),
                    "message": (health or {}).get("message"),
                    "collected_at": _to_local_iso((health or {}).get("collected_at"), tz),
                }
            )
            for drive in (health or {}).get("physical_drives") or []:
                if not isinstance(drive, dict):
                    continue
                item = dict(drive)
                item["host_name"] = host_name
                drives.append(item)
        return render_template(
            "disk_health.html",
            active_page="disk_health",
            hosts=host_rows,
            drives=drives,
            totals=totals,
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

    @app.get("/terminal")
    def terminal_page():
        config = _config(app)
        hosts = [
            {"name": host.name, "host": host.host, "group": host.group}
            for host in config.servers
        ]
        return render_template(
            "terminal.html",
            active_page="terminal",
            hosts=hosts,
            desktop_mode=os.environ.get("SERVERMONITOR_DESKTOP") == "1",
        )
