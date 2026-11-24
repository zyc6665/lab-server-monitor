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
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    Response,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)

from servermanage import (
    availability,
    capacity,
    compute as compute_mod,
    diagnostics as diagnostics_mod,
    disk_capacity,
    host_import,
    host_probe,
    maintenance,
    storage,
)
from servermanage import container_stats as container_stats_mod
from servermanage import user_admin as admin
from servermanage import usermode as user_mode
from servermanage import __version__ as app_version
from servermanage.web.anchors import anchor_slug
from servermanage.alerts import fingerprint_for
from servermanage.availability import run_host_checks
from servermanage.user_collection import is_user_monitoring_enabled
from servermanage.disk_health import AlertEvent
from servermanage.models import AuthConfig, HostConfig, WebhookConfig
from servermanage.notify_desktop import send_desktop_notification
from servermanage.notify_webhook import send_webhook
from servermanage.runtime import read_runtime_state
from servermanage.serialization import to_jsonable
from servermanage.settings import SettingsError, _build_host_check, _sanitize_host_checks
from servermanage import ssh_client
from servermanage.ssh_client import SSHClientWrapper
from servermanage.ssh_terminal import (
    SessionNotFoundError,
    SshTerminalManager,
    TerminalLimitError,
)
from servermanage.timeutil import resolve_timezone, timezone_status

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

# Previewed account plans live in memory only: the password they carry must
# never be written to the database, a file or the browser.  The cache is
# size-bounded and TTL-bounded in :class:`servermanage.user_admin.PlanCache`.
_plan_cache = admin.PlanCache()

def _run_execute_job(
    *,
    app,
    job: dict[str, Any],
    plan: dict[str, Any],
    plan_hash: str,
    host_config,
    connect_timeout: int,
    actor: str,
    started: datetime,
    db_path,
) -> None:
    """Run one provisioning plan off the request thread, then write the audit row."""
    try:
        try:
            with SSHClientWrapper(
                host=host_config, connect_timeout=connect_timeout
            ) as ssh:
                outcome = admin.execute_plan(plan, ssh)
        except Exception as exc:  # noqa: BLE001 - never leak a traceback or password
            outcome = {
                "ok": False,
                "status": "error",
                "steps": [],
                "error": str(exc)[:400],
            }
        for entry in outcome.get("steps", []):
            masked_step = next(
                (item for item in job["steps"] if item["id"] == entry["id"]), None
            )
            if masked_step is not None:
                masked_step["status"] = entry["status"]
                masked_step["stderr"] = entry.get("stderr", "")
                masked_step["stdout"] = entry.get("stdout", "")
        storage.save_user_operation(
            plan["host"],
            plan["account"],
            plan["operation"],
            outcome.get("status", "error"),
            actor=actor,
            plan_hash=plan_hash,
            steps=job["steps"],
            error=str(outcome.get("error") or ""),
            created_at=started,
            finished_at=datetime.now(timezone.utc),
            db_path=db_path,
        )
        job["ok"] = bool(outcome.get("ok"))
        job["error"] = str(outcome.get("error") or "")
        job["state"] = "done"
        if job["ok"]:
            _request_user_refresh(app)
    except Exception as exc:  # noqa: BLE001 - job must never stay "running"
        job["ok"] = False
        job["error"] = str(exc)[:400]
        job["state"] = "error"
    finally:
        job["finished_at"] = datetime.now(timezone.utc).isoformat()


# v0.1.230：账号操作改为后台任务执行。此前整个计划在请求线程里同步跑
# （最多 6 步 sudo SSH，慢主机会把浏览器拖到超时，重试还可能重复执行）。
# 任务注册表只存脱敏后的步骤；按 actor 隔离读取。
_EXECUTE_JOBS: dict[str, dict[str, Any]] = {}
_EXECUTE_JOBS_LOCK = threading.Lock()
_EXECUTE_JOB_TTL_SECONDS = 3600.0

# ---------------------------------------------------------------------------
# Small value helpers
# ---------------------------------------------------------------------------


def _config(app: Flask):
    return app.config["CONFIG"]


def _db_path(app: Flask):
    return app.config["DB_PATH"]


def _view_mode(config) -> str:
    """Return the active viewing mode: ``admin`` or ``user``."""
    mode = getattr(getattr(config, "app", None), "mode", user_mode.MODE_ADMIN)
    return mode if mode in user_mode.MODES else user_mode.MODE_ADMIN


def _member_account(config) -> str:
    """Return the lab account name configured by a member-mode client."""
    return str(getattr(getattr(config, "app", None), "member_account", "") or "")


#: Paths a member-mode client may still reach.  Everything else is admin-only.
_USER_MODE_ALLOWED = frozenset(
    {
        "/",
        "/my",
        "/api/my/summary",
        "/settings",
        "/api/settings",
        "/api/settings/monitoring",
        "/api/settings/password",
        "/api/runtime",
        "/login",
        "/setup",
        "/logout",
    }
)

#: Keys a member may change through ``PUT /api/settings/monitoring``.
_USER_MODE_SETTINGS_KEYS = frozenset({"mode", "member_account"})


def _user_mode_allows(path: str) -> bool:
    if path.startswith("/static/"):
        return True
    return path in _USER_MODE_ALLOWED


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


def _monitor_service(app: Flask):
    """The background poller/service used by the user API, when available.

    Task 4 owns ``MonitorService.refresh_users()`` / ``user_scan_status()``;
    until that lands the routes resolve whatever object is wired in and treat a
    missing method as "feature unavailable" instead of importing the service
    (which would create a circular import through ``servermanage.app``).
    """
    service = app.config.get("MONITOR_SERVICE")
    if service is None:
        service = app.extensions.get("monitor_service")
    if service is None:
        service = _settings_service(app)
    return service


def _request_user_refresh(app: Flask, *, force_usage: bool = False) -> None:
    """Ask the background service to rescan users after a write operation.

    ``force_usage`` also refreshes the directory sizes, which is what a fresh
    sudo password or a changed usage interval needs: without it the next size
    scan could be up to two days away.

    Failure is not fatal: the account was already created on the host, and the
    next scheduled scan will pick it up.  We only avoid a stale page.
    """
    service = _monitor_service(app)
    refresh = getattr(service, "refresh_users", None)
    if not callable(refresh):
        return
    try:
        refresh(force_usage=force_usage)
    except TypeError:
        # Service implementations from older builds take no keyword arguments.
        try:
            refresh()
        except Exception:  # noqa: BLE001 - best-effort refresh only
            LOGGER.warning("refresh_users() failed", exc_info=True)
    except Exception:  # noqa: BLE001 - best-effort refresh only
        LOGGER.warning("refresh_users() failed", exc_info=True)


# Editable settings sections accepted by ``PUT /api/settings/<section>``.  The
# ``hosts`` section is intentionally excluded: host rows are managed through the
# dedicated CRUD endpoints so their credentials land in ``app_secrets``.
_ALLOWED_SETTINGS_SECTIONS = frozenset(
    {
        "monitoring",
        "dashboard",
        "alerts",
        "smtp",
        "report",
        "disk_health",
        "ssh",
        "user_monitoring",
    }
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
                # config 解析会把 key_path 变成 Path，直接进 tojson 会让 /settings 500。
                "key_path": str(auth.key_path) if auth.key_path is not None else None,
                "disk_health": None,
                "password_configured": bool(auth.password or auth.password_env),
                "key_configured": bool(auth.key_path or auth.key_data),
                "passphrase_configured": bool(
                    auth.passphrase or auth.passphrase_env
                ),
                "checks": [
                    {
                        "name": check.name,
                        "type": check.type,
                        "target": check.target,
                        "timeout_seconds": check.timeout_seconds,
                        "expected": check.expected,
                        "enabled": check.enabled,
                    }
                    for check in host.checks
                ],
                "alert_rules": (
                    {
                        "cpu_percent": host.alert_rules.cpu_percent,
                        "memory_percent": host.alert_rules.memory_percent,
                        "disk_percent": host.alert_rules.disk_percent,
                        "gpu_memory_percent": host.alert_rules.gpu_memory_percent,
                        "disk_temperature_c": host.alert_rules.disk_temperature_c,
                        "consecutive_periods": host.alert_rules.consecutive_periods,
                    }
                    if host.alert_rules is not None
                    else None
                ),
                "sudo_configured": bool(host.sudo_password),
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
        "user_monitoring": {
            "enabled": config.user_monitoring.enabled,
            "scan_interval_seconds": config.user_monitoring.scan_interval_seconds,
            "usage_interval_seconds": config.user_monitoring.usage_interval_seconds,
            "command_timeout": config.user_monitoring.command_timeout,
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
            "consecutive_periods": config.alerts.consecutive_periods,
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
        sudo_password=_optional_text(payload.get("sudo_password")),
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


_ALERT_RANGE_HOURS = {"24h": 24, "7d": 24 * 7, "30d": 24 * 30}
_ALERT_STATUS_FILTERS = ("active", "acknowledged", "resolved", "all")


def _alert_status_filter(value: str | None) -> str:
    """Return a valid alert status filter; unknown/empty values fall back to active."""
    status = (value or "").strip()
    return status if status in _ALERT_STATUS_FILTERS else "active"


def _alert_range_since(range_key: str, *, now: datetime | None = None) -> datetime | None:
    """Return the UTC cutoff for an alert-list range filter (None = all time)."""
    hours = _ALERT_RANGE_HOURS.get((range_key or "").strip())
    if hours is None:
        return None
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current - timedelta(hours=hours)


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


def _anchor(name: str) -> str:
    """HTML id-safe anchor for a host section."""
    return anchor_slug(name)


def _drive_sort_key(drive: dict[str, Any]) -> tuple:
    """Hottest drive first; drives without a temperature sink to the bottom."""
    temperature = drive.get("temperature_c")
    hot = float(temperature) if isinstance(temperature, (int, float)) else float("-inf")
    slot = drive.get("slot")
    slot_key = slot if isinstance(slot, int) else 10**6
    return (-hot, slot_key)


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
    load = metrics.get("load_average") or {}
    return {
        "cpu_percent": _as_float(metrics.get("cpu_usage_percent")),
        "memory_percent": _memory_percent(metrics),
        "disk_percent": _disk_percent(metrics, disk_mounts),
        "gpu_memory_percent": _gpu_memory_percent(metrics),
        "load_1": _as_float(load.get("load_1") if isinstance(load, dict) else None),
        "cpu_cores": int(metrics.get("cpu_core_count") or 0),
        "uptime": str(metrics.get("uptime") or ""),
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


def _summarize_checks(results: list[dict[str, Any]]) -> dict[str, int]:
    """Collapse stored check results into a total/ok/failed/unknown summary.

    Both ``failed`` (definitive failure) and ``error`` (check could not be
    evaluated) count as failed so a broken check is never mistaken for an
    unchecked one. ``unknown`` only covers results with no recognisable
    status (e.g. no result / host offline).
    """
    total = len(results)
    ok = sum(1 for row in results if str(row.get("status")) == "ok")
    failed = sum(1 for row in results if str(row.get("status")) in ("failed", "error"))
    unknown = total - ok - failed
    return {"total": total, "ok": ok, "failed": failed, "unknown": unknown}


def _hottest_temperature(metrics: dict[str, Any]) -> float | None:
    """Highest CPU/board/GPU temperature in a stored metrics payload."""

    values: list[float] = []
    for zone in metrics.get("thermal_zones") or []:
        try:
            values.append(float(zone.get("celsius")))
        except (TypeError, ValueError):
            continue
    for row in metrics.get("gpu_summary") or []:
        try:
            if row.get("temperature_c") is not None:
                values.append(float(row["temperature_c"]))
        except (TypeError, ValueError):
            continue
    if not values:
        return None
    return round(max(values), 1)


def _gpu_memory_totals(metrics: dict[str, Any]) -> tuple[float, float] | None:
    """Used and total GPU memory (MB) across every card of a host."""

    used = 0.0
    total = 0.0
    for row in metrics.get("gpu_summary") or []:
        try:
            total += float(row.get("memory_total_mb") or 0)
            used += float(row.get("memory_used_mb") or 0)
        except (TypeError, ValueError):
            continue
    if total <= 0:
        return None
    return round(used, 1), round(total, 1)


def _gpu_payload(totals: tuple[float, float] | None) -> dict[str, float] | None:
    if not totals:
        return None
    return {"used_mb": totals[0], "total_mb": totals[1]}


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
    checks: dict[str, int] | None = None,
    spark: dict[str, list[float]] | None = None,
    collection_uptime: dict[str, int] | None = None,
) -> dict[str, Any]:
    if checks is None:
        checks = {"total": 0, "ok": 0, "failed": 0, "unknown": 0}
    spark_data = {
        "cpu": list((spark or {}).get("cpu") or []),
        "memory": list((spark or {}).get("memory") or []),
    }
    container_count = len(((snapshot or {}).get("metrics") or {}).get("containers") or [])
    temperature_c = _hottest_temperature((snapshot or {}).get("metrics") or {})
    gpu_totals = _gpu_memory_totals((snapshot or {}).get("metrics") or {})
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
            "checks": checks,
            "spark": spark_data,
            "container_count": container_count,
            "temperature_c": temperature_c,
            "gpu_memory": _gpu_payload(gpu_totals),
            "collection_uptime": collection_uptime,
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
        "checks": checks,
        "spark": spark_data,
        "container_count": container_count,
        "temperature_c": temperature_c,
        "gpu_memory": _gpu_payload(gpu_totals),
        "collection_uptime": collection_uptime,
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

    ok, message = storage.database_integrity(db_path, cache_seconds=300)
    checks.append(
        {
            "key": "database",
            "label": "数据库",
            "status": "ok" if ok else "error",
            "message": message,
        }
    )

    # A silent UTC fallback used to be visible only in the log file, so every
    # timestamp looked normal while being 8 hours off.  Surface it here.
    tz_state = timezone_status(getattr(config.app, "timezone", "Asia/Shanghai"))
    if tz_state["available"]:
        tz_message = f"时区 {tz_state['name']} 已生效"
    else:
        tz_message = (
            f"时区 {tz_state['name']} 不可用，已回退 {tz_state['effective']}，"
            f"页面与报告的本地时间会偏移；请确认打包产物包含 tzdata 时区数据（{tz_state['detail']}）"
        )
    checks.append(
        {
            "key": "timezone",
            "label": "时区",
            "status": "ok" if tz_state["available"] else "warning",
            "message": tz_message,
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

    critical_count = storage.count_active_critical_alerts(db_path)
    if critical_count:
        alert_status = "warning"
        alert_message = f"{critical_count} 条严重告警待处理"
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


# v0.1.226：30 天容量预测是慢变化信号，30 秒轮询不必每次重读 30 天历史重算回归。
_CAPACITY_CACHE: dict[tuple, tuple[float, list[dict[str, Any]]]] = {}
_CAPACITY_CACHE_TTL_SECONDS = 300.0
_CAPACITY_CACHE_LOCK = threading.Lock()


def _capacity_forecasts_cached(config, db_path, tz, now, thresholds, days: int = 30):
    """Capacity forecasts with a five-minute TTL, keyed by fleet + thresholds."""
    key = (
        str(db_path),
        str(getattr(tz, "key", None) or str(tz)),
        int(days),
        tuple(sorted(server.name for server in config.servers)),
        (
            float(thresholds.cpu_percent),
            float(thresholds.memory_percent),
            float(thresholds.disk_percent),
            float(thresholds.gpu_memory_percent),
            float(thresholds.disk_temperature_c),
        ),
    )
    now_mono = time.monotonic()
    with _CAPACITY_CACHE_LOCK:
        cached = _CAPACITY_CACHE.get(key)
        if cached is not None and now_mono - cached[0] < _CAPACITY_CACHE_TTL_SECONDS:
            return cached[1]
    result = capacity.build_capacity_forecasts(
        db_path,
        config.servers,
        tz=timezone.utc if tz is None else tz,
        now=now,
        thresholds=thresholds,
        days=days,
    )
    with _CAPACITY_CACHE_LOCK:
        _CAPACITY_CACHE[key] = (now_mono, result)
        if len(_CAPACITY_CACHE) > 8:
            oldest = min(_CAPACITY_CACHE, key=lambda item: _CAPACITY_CACHE[item][0])
            _CAPACITY_CACHE.pop(oldest, None)
    return result


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
    addresses = {server.name: server.host for server in config.servers}
    servers_by_name = {server.name: server for server in config.servers}
    mounts_by_host = {server.name: server.disk_mounts for server in config.servers}

    active_silences = storage.list_silences(db_path, active_only=True)
    # One grouped aggregate instead of materialising every active alert row.
    alert_counts = storage.count_active_alerts_by_host(db_path)
    active_alert_total = sum(alert_counts.values())

    # 24 h CPU/memory series for the inline sparkline in every host row.  One
    # query for all hosts, so the 30 s poll stays a single cheap read.
    try:
        sparklines = storage.fetch_host_sparklines(db_path, now=now)
    except Exception:  # noqa: BLE001 - a missing column must not break the page
        LOGGER.exception("Failed to load host sparklines")
        sparklines = {}

    groups: list[str] = []
    for server in config.servers:
        group_name = server.group or "未分组"
        if group_name not in groups:
            groups.append(group_name)

    # 采集成功率：一次分组查询拿到全队 24 小时入库次数，用来在列表里标出漏采。
    try:
        sample_counts = storage.count_recent_samples_by_host(db_path, hours=24, now=now)
    except Exception:  # noqa: BLE001 - diagnostics must never break the overview
        LOGGER.exception("Failed to count recent samples")
        sample_counts = {}
    expected_polls = max(1, int(24 * 3600 / max(60, int(config.app.poll_interval_seconds or 600))))

    # 服务检查快照同样一次读完，避免每台主机一次查询的 N+1。
    try:
        check_results = storage.get_all_host_check_results(db_path)
    except Exception:  # noqa: BLE001 - diagnostics must never break the overview
        LOGGER.exception("Failed to load host check results")
        check_results = {}

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
                checks=_summarize_checks(check_results.get(host_name, [])),
                spark=sparklines.get(host_name),
                collection_uptime={
                    "samples": sample_counts.get(host_name, 0),
                    "expected": expected_polls,
                },
            )
        )

    online = sum(1 for host in hosts if host["online"])
    return {
        "summary": {
            "online": online,
            "offline": len(hosts) - online,
            "active_alerts": active_alert_total,
        },
        "meta": {
            "groups": groups,
            "silenced_count": silenced_count,
            "has_groups": any(server.group and server.group != "未分组" for server in config.servers),
            # v0.1.234：标签筛选（标签是自由文本，取全队去重排序）。
            "tags": sorted({tag.strip() for server in config.servers for tag in (server.tags or []) if tag.strip()}),
            "has_tags": any(server.tags for server in config.servers),
        },
        "hosts": hosts,
        "capacity": _capacity_forecasts_cached(
            config, db_path, tz, now, config.alerts.thresholds
        ),
    }


# ---------------------------------------------------------------------------
# Server-user rows (Task 5)
# ---------------------------------------------------------------------------

# Issues surfaced to the UI.  They mirror ``alerts.evaluate_user_alerts`` so the
# dashboard can highlight a row without re-deriving the alert rules client-side;
# the alert notes themselves (``user-added`` / ``user-present``) are deliberately
# not listed here: "added" is informational and "missing" is expressed by the
# row ``state`` instead.
_USER_DIRECTORY_ISSUES = frozenset({"home", "data", "owner"})
# Growth window shown on the users page (days).
_USAGE_DELTA_DAYS = 7


def _user_row_issues(row: dict[str, Any]) -> list[str]:
    """Return the UI issue keys for a *present* snapshot row.

    Same rules as :func:`servermanage.alerts.evaluate_user_alerts`:
    ``docker`` when the account is not in the docker group, ``home`` when
    ``/home/<name>`` is gone, ``data`` when ``/data/<name>`` is gone on a host
    that supports it, and ``owner`` when a directory is not owned by the
    account.  Missing rows never reach this function (``issues == ["missing"]``).
    """
    username = str(row.get("username") or "")
    issues: list[str] = []
    if not row.get("in_docker"):
        issues.append("docker")
    if not row.get("home_exists"):
        issues.append("home")
    if row.get("data_supported") and not row.get("data_exists"):
        issues.append("data")
    owner_mismatch = bool(
        row.get("home_exists")
        and row.get("home_owner")
        and row.get("home_owner") != username
    ) or bool(
        row.get("data_supported")
        and row.get("data_exists")
        and row.get("data_owner")
        and row.get("data_owner") != username
    )
    if owner_mismatch:
        issues.append("owner")
    return issues


def _user_usage_readable(row: dict[str, Any]) -> bool:
    """Whether the collector could measure this account's directories.

    Persisted by the collector (``usage_readable``): ``False`` means ``du``
    failed for lack of privileges, so the size columns are last-known values
    rather than live ones.  Rows collected before the column existed fall back
    to "sizes present => readable".
    """
    value = row.get("usage_readable")
    if value is not None:
        return bool(value)
    return bool(
        row.get("home_size_bytes") is not None
        or row.get("data_size_bytes") is not None
    )


def _usage_scan_state(app: Any) -> dict[str, Any]:
    """Describe the running usage scan so the page can show progress."""
    service = _monitor_service(app)
    status = getattr(service, "user_scan_status", None)
    if not callable(status):
        return {"running": False}
    try:
        payload = status()
    except Exception:  # pragma: no cover - status must never break the page
        LOGGER.exception("user_scan_status() failed")
        return {"running": False}
    if not isinstance(payload, dict):
        return {"running": False}
    return {
        "running": bool(payload.get("running")),
        "hosts_done": int(payload.get("hosts_done") or 0),
        "hosts_total": int(payload.get("hosts_total") or 0),
        "started_at": payload.get("started_at"),
        "current_host": payload.get("current_host"),
        "current_account": payload.get("current_account"),
        "next_account": payload.get("next_account"),
        "accounts_done": int(payload.get("accounts_done") or 0),
        "accounts_total": int(payload.get("accounts_total") or 0),
    }


def _usage_hint(row: dict[str, Any], server: Any) -> str:
    """Explain why directory sizes are missing, so the fix is obvious.

    ``du`` needs privileges to walk other people's homes; without a sudo
    password the collector intentionally degrades to "sizes unknown" instead of
    writing partial numbers.  Spell that out rather than showing a bare
    "无权限读取".
    """
    if _user_usage_readable(row):
        return ""
    has_password = bool(getattr(server, "sudo_password", None))
    if not has_password:
        return "未配置 sudo 密码，已跳过目录占用统计；可在该主机设置里填写 sudo 密码（或配置免密 sudo）。"
    return "上次统计失败或超时，将在下个统计周期重试。"


def _present_user_row(
    host_name: str, row: dict[str, Any], server: Any = None
) -> dict[str, Any]:
    """Build an API row for a user that exists in the latest snapshot."""
    item = dict(row)
    item["host_name"] = host_name
    item["state"] = "present"
    item.setdefault("first_seen_at", None)
    item.setdefault("last_seen_at", None)
    item["usage_readable"] = _user_usage_readable(item)
    item["usage_hint"] = _usage_hint(item, server)
    item["issues"] = _user_row_issues(item)
    return item


def _missing_user_row(host_name: str, row: dict[str, Any]) -> dict[str, Any]:
    """Build an API row for a baseline-only (disappeared) account.

    Only attributes frozen in ``host_user_baseline`` are available, so every
    live observation is ``None``: a missing account must never imply that its
    home/data directory still exists or that its size is zero.
    """
    return {
        "host_name": host_name,
        "username": row.get("username"),
        "state": "missing",
        "uid": row.get("uid"),
        "gid": row.get("gid"),
        "primary_group": row.get("primary_group"),
        "gecos": "",
        "home": row.get("home"),
        "shell": row.get("shell"),
        "groups": list(row.get("groups") or []),
        "in_docker": row.get("in_docker"),
        "in_sudo": row.get("in_sudo"),
        "home_exists": None,
        "home_owner": None,
        "home_group": None,
        "home_mode": None,
        "home_size_bytes": None,
        "data_exists": None,
        "data_owner": None,
        "data_group": None,
        "data_mode": None,
        "data_size_bytes": None,
        "data_supported": None,
        "usage_stale": None,
        "usage_readable": None,
        "usage_collected_at": None,
        "collected_at": None,
        "first_seen_at": row.get("first_seen_at"),
        "last_seen_at": row.get("last_seen_at"),
        "issues": ["missing"],
    }


def _merge_user_rows(
    host_name: str,
    snapshot_rows: list[dict[str, Any]],
    baseline_rows: list[dict[str, Any]],
    server: Any = None,
) -> list[dict[str, Any]]:
    """Merge one host's snapshot (present) and baseline (missing) rows."""
    rows: list[dict[str, Any]] = []
    present: set[str] = set()
    for row in snapshot_rows:
        username = row.get("username")
        if not username:
            continue
        present.add(str(username))
        rows.append(_present_user_row(host_name, row, server))
    for row in baseline_rows:
        username = row.get("username")
        if not username or str(username) in present:
            continue
        rows.append(_missing_user_row(host_name, row))
    rows.sort(key=lambda item: str(item.get("username") or ""))
    return rows


def _user_host_status(scan_state: dict[str, Any] | None) -> str:
    """Return ``ok`` / ``unknown`` (never scanned) / ``error`` for a host.

    ``usage_readable=False`` rows or a host without ``/data`` are not errors:
    only an explicit collector error recorded in ``host_user_scan_state`` is.
    """
    state = scan_state or {}
    if str(state.get("last_error") or "").strip():
        return "error"
    if state.get("last_scan_at"):
        return "ok"
    return "unknown"


def _to_local_text(value: Any, tz) -> Any:
    """Render a stored ISO UTC timestamp as ``YYYY-MM-DD HH:MM`` local time.

    Templates show this directly, so a raw ISO string with an offset would look
    like machine output.  Unparseable values pass through untouched.
    """
    parsed = _parse_iso(value)
    if parsed is None:
        return value
    return parsed.astimezone(tz).strftime("%Y-%m-%d %H:%M")


def _build_my_summary(config, db_path, *, tz=None) -> dict[str, Any]:
    """Return only the signed-in member's accounts, grouped by host.

    The member is identified by the locally configured account name; hosts that
    have no such account (present or in the baseline) are omitted entirely so
    a member never sees unrelated servers.
    """
    member = _member_account(config)
    payload = _build_users_payload(config, db_path, tz=tz)
    mine: dict[str, dict[str, Any]] = {}
    for row in payload["accounts"]:
        if member and str(row.get("username") or "") == member:
            mine[str(row.get("host_name"))] = row
    hosts: list[dict[str, Any]] = []
    for block in payload["hosts"]:
        account = mine.get(str(block.get("name")))
        if account is None:
            continue
        hosts.append(
            {
                "name": block.get("name"),
                "address": block.get("address"),
                "status": block.get("status"),
                "last_scan_at": _to_local_text(block.get("last_scan_at"), tz)
                if tz is not None
                else block.get("last_scan_at"),
                "last_error": block.get("last_error"),
                "account": account,
            }
        )
    return {
        "mode": _view_mode(config),
        "member": member,
        "hosts": hosts,
        "summary": {
            "hosts": len(hosts),
            "present": sum(
                1 for host in hosts if host["account"]["state"] == "present"
            ),
            "missing": sum(
                1 for host in hosts if host["account"]["state"] == "missing"
            ),
            "issues": sum(1 for host in hosts if host["account"].get("issues")),
            "host_errors": sum(1 for host in hosts if host.get("status") == "error"),
            "home_bytes": sum(
                host["account"].get("home_size_bytes") or 0 for host in hosts
            ),
            "data_bytes": sum(
                host["account"].get("data_size_bytes") or 0 for host in hosts
            ),
        },
    }



def _gpu_usage_from_metrics(metrics: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Sum GPU memory per Linux account from one host's metrics snapshot."""
    usage: dict[str, dict[str, Any]] = {}
    for proc in metrics.get("gpu_processes") or []:
        if not isinstance(proc, dict):
            continue
        who = str(proc.get("username") or "").strip()
        if not who:
            continue
        bucket = usage.setdefault(who, {"mb": 0.0, "procs": 0})
        bucket["mb"] += float(proc.get("memory_used_mb") or 0)
        bucket["procs"] += 1
    return usage


def _gpu_usage_by_user(host_name: str, db_path) -> dict[str, dict[str, Any]]:
    """Sum GPU memory per Linux account for one host, from the latest snapshot.

    Uses the ``nvidia-smi`` process list that the poller already collects, so this
    adds no extra work on the server. Returns ``{username: {"mb", "procs"}}``.
    """
    snapshot = storage.get_host_snapshot(host_name, db_path)
    metrics = (snapshot or {}).get("metrics") or {}
    return _gpu_usage_from_metrics(metrics)


def _build_user_rows(
    host_name: str,
    db_path,
    tz=None,
    server: Any = None,
    *,
    precomputed: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Return the merged present/missing rows for one host.

    ``precomputed`` carries fleet-wide reads already fetched for the 30 s users
    poll (snapshots / baselines / deltas / gpu usage).  ``None`` entries fall
    back to the per-host query so other callers stay on the simple path.
    """
    shared = precomputed or {}
    snapshot_rows = shared.get("snapshots")
    if snapshot_rows is None:
        snapshot_rows = storage.get_host_user_snapshot(host_name, db_path)
    baseline_rows = shared.get("baselines")
    if baseline_rows is None:
        baseline_rows = storage.get_user_baseline(host_name, db_path)
    rows = _merge_user_rows(host_name, snapshot_rows, baseline_rows, server)
    deltas = shared.get("deltas")
    if deltas is None:
        deltas = storage.get_user_usage_deltas(host_name, db_path, days=_USAGE_DELTA_DAYS)
    gpu_usage = shared.get("gpu_usage")
    if gpu_usage is None:
        gpu_usage = _gpu_usage_by_user(host_name, db_path)
    for row in rows:
        info = deltas.get(str(row.get("username") or ""))
        row["usage_delta_bytes"] = info.get("delta") if info else None
        row["usage_delta_days"] = _USAGE_DELTA_DAYS if info else None
        row["usage_delta_since"] = info.get("since") if info else None
        gpu = gpu_usage.get(str(row.get("username") or ""))
        row["gpu_memory_mb"] = round(gpu["mb"], 1) if gpu else None
        row["gpu_process_count"] = gpu["procs"] if gpu else 0
    if tz is not None:
        for row in rows:
            for key in ("collected_at", "usage_collected_at", "last_seen_at"):
                row[key] = _to_local_text(row.get(key), tz)
    return rows


def _host_user_counts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-host roll-up used by the host cards on ``/users``.

    ``bytes`` is the sum of what could be measured; ``usage_readable`` is False
    when at least one account's size could not be read, so the card can mark the
    total as partial instead of pretending it is exact.
    """
    present = [row for row in rows if row.get("state") == "present"]
    missing = [row for row in rows if row.get("state") == "missing"]
    return {
        "present": len(present),
        "missing": len(missing),
        "docker_issues": sum(1 for row in rows if "docker" in row.get("issues", [])),
        "directory_issues": sum(
            1 for row in rows if _USER_DIRECTORY_ISSUES.intersection(row.get("issues", []))
        ),
        "gpu_memory_mb": round(
            sum(row.get("gpu_memory_mb") or 0 for row in rows), 1
        ),
        "gpu_processes": sum(row.get("gpu_process_count") or 0 for row in rows),
        "home_bytes": sum(
            row.get("home_size_bytes") or 0
            for row in rows
            if row.get("home_size_bytes") is not None
        ),
        "data_bytes": sum(
            row.get("data_size_bytes") or 0
            for row in rows
            if row.get("data_size_bytes") is not None
        ),
        "bytes": sum(
            (row.get("home_size_bytes") or 0) + (row.get("data_size_bytes") or 0)
            for row in rows
        ),
        "delta_bytes": sum(
            row.get("usage_delta_bytes") or 0
            for row in rows
            if row.get("usage_delta_bytes") is not None
        ),
        "delta_days": _USAGE_DELTA_DAYS,
        "usage_readable": not any(
            row.get("usage_readable") is False for row in present
        ),
    }


def _build_users_payload(
    config,
    db_path,
    *,
    host: str = "",
    query: str = "",
    status: str = "all",
    tz=None,
) -> dict[str, Any]:
    """Build the ``GET /api/users`` payload for every configured host."""
    host_filter = (host or "").strip()
    needle = (query or "").strip().casefold()
    status_filter = status if status in ("all", "warning", "error", "ok") else "all"

    # ``hosts`` always lists every configured host: the page's selector must not
    # collapse to a single entry just because a host filter is active.
    all_names: list[str] = []
    enabled: dict[str, bool] = {}
    for server in config.servers:
        if server.name in enabled:
            continue
        all_names.append(server.name)
        enabled[server.name] = is_user_monitoring_enabled(server, config)

    host_blocks: list[dict[str, Any]] = []
    all_rows: list[dict[str, Any]] = []
    statuses: dict[str, str] = {}
    addresses = {server.name: server.host for server in config.servers}
    servers_by_name = {server.name: server for server in config.servers}
    # v0.1.226：全部主机一次批量读齐（快照/基线/增量/扫描状态/GPU 占用），
    # 30 秒轮询不再每台主机开 5 个连接。
    fleet_snapshots = storage.get_all_host_user_snapshots(db_path)
    fleet_baselines = storage.get_all_user_baselines(db_path)
    fleet_deltas = storage.get_all_user_usage_deltas(db_path, days=_USAGE_DELTA_DAYS)
    fleet_states = storage.get_all_user_scan_states(db_path)
    latest_by_host = {
        item["host_name"]: item for item in storage.get_all_host_snapshots(db_path)
    }
    for name in all_names:
        if not enabled[name]:
            statuses[name] = "disabled"
            host_blocks.append(
                {
                    "name": name,
                    "address": addresses.get(name),
                    "status": "disabled",
                    "monitored": False,
                    "last_scan_at": None,
                    "last_usage_at": None,
                    "last_error": None,
                    "accounts": 0,
                    "allow_user_write": False,
                    "sudo_configured": False,
                    **_host_user_counts([]),
                }
            )
            continue
        host_snapshot = latest_by_host.get(name)
        precomputed = {
            "snapshots": fleet_snapshots.get(name),
            "baselines": fleet_baselines.get(name),
            "deltas": fleet_deltas.get(name),
            "gpu_usage": (
                _gpu_usage_from_metrics((host_snapshot or {}).get("metrics") or {})
                if host_snapshot is not None
                else None
            ),
        }
        rows = _build_user_rows(
            name, db_path, tz, servers_by_name.get(name), precomputed=precomputed
        )
        state = fleet_states.get(name)
        host_status = _user_host_status(state)
        statuses[name] = host_status
        all_rows.extend(rows)
        server = servers_by_name.get(name)
        host_blocks.append(
            {
                "name": name,
                "address": addresses.get(name),
                "status": host_status,
                "monitored": True,
                "last_scan_at": _to_local_iso((state or {}).get("last_scan_at"), tz),
                "last_usage_at": _to_local_iso((state or {}).get("last_usage_at"), tz),
                "last_error": (state or {}).get("last_error") or None,
                "accounts": len(rows),
                "allow_user_write": bool(server and server.allow_user_write),
                "sudo_configured": bool(server and server.sudo_password),
                **_host_user_counts(rows),
            }
        )

    filtered: list[dict[str, Any]] = []
    for row in all_rows:
        if host_filter and row["host_name"] != host_filter:
            continue
        if status_filter == "warning" and not (row["issues"] or row["state"] == "missing"):
            continue
        if status_filter == "error" and statuses.get(row["host_name"]) != "error":
            continue
        if status_filter == "ok" and (
            row["issues"] or row["state"] == "missing"
        ):
            continue
        if needle:
            haystack = " ".join(
                [
                    str(row.get("username") or ""),
                    str(row.get("host_name") or ""),
                    str(row.get("primary_group") or ""),
                    " ".join(str(group) for group in row.get("groups") or []),
                ]
            ).casefold()
            if needle not in haystack:
                continue
        filtered.append(row)

    summary = {
        "total": len(all_rows),
        "present": sum(1 for row in all_rows if row["state"] == "present"),
        "missing": sum(1 for row in all_rows if row["state"] == "missing"),
        "docker_issues": sum(1 for row in all_rows if "docker" in row["issues"]),
        "directory_issues": sum(
            1 for row in all_rows if _USER_DIRECTORY_ISSUES.intersection(row["issues"])
        ),
        "home_bytes": sum(
            row["home_size_bytes"]
            for row in all_rows
            if row.get("home_size_bytes") is not None
        ),
        "data_bytes": sum(
            row["data_size_bytes"]
            for row in all_rows
            if row.get("data_size_bytes") is not None
        ),
    }
    blocked = [
        block["name"]
        for block in host_blocks
        if block.get("monitored")
        and not block.get("sudo_configured")
        and block.get("accounts")
    ]
    usage_hint = ""
    if blocked:
        preview = "、".join(blocked[:3])
        usage_hint = (
            f"{len(blocked)} 台主机没有 sudo 密码，目录占用无法统计（{preview}）。"
            "在设置 → 主机里填写 sudo 密码后会立刻开始统计。"
        )
    totals: dict[str, list[dict[str, Any]]] = {}
    for block in host_blocks:
        try:
            series = storage.get_user_usage_series(
                block.get("name", ""), db_path, days=30
            )
        except Exception:  # pragma: no cover - history is best effort
            series = {}
        totals[block.get("name", "")] = _aggregate_series(series)

    return {
        "accounts": filtered,
        "usage_totals": totals,
        "hosts": host_blocks,
        "summary": summary,
        "usage_hint": usage_hint,
        "usage_scan": _usage_scan_state(current_app._get_current_object()),
        "write_enabled": bool(config.user_monitoring.write_enabled),
        "filters": {
            "host": host_filter,
            "q": (query or "").strip(),
            "status": status_filter,
        },
    }


def _resolve_user_present_alert(host_name: str, username: str, db_path) -> None:
    """Mark open ``user-present`` alerts resolved (no recovery notification).

    The baseline was removed deliberately from the dashboard, so there is no
    "account came back" state to announce; using :meth:`AlertEngine.resolve_missing`
    would send a recovery notification for something the admin asked to forget.
    """
    fingerprint = fingerprint_for("user-present", host_name, username)
    for alert in storage.list_alerts(db_path, status="active", limit=1000):
        if alert.get("fingerprint") != fingerprint:
            continue
        storage.update_alert(int(alert["id"]), db_path, status="resolved")


def _parse_iso_datetime(value: Any) -> datetime | None:
    """Parse an ISO timestamp, tolerating ``Z`` suffixes and junk values."""

    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment


def _host_alert_days(
    alerts: list[dict[str, Any]], tz, *, days: int = 7, now: datetime | None = None
) -> list[dict[str, Any]]:
    """Bucket *alerts* into the last *days* local calendar days (oldest first)."""

    current = now or datetime.now(tz)
    today = current.astimezone(tz).date()
    start = today - timedelta(days=days - 1)
    buckets: dict[str, dict[str, Any]] = {}
    for offset in range(days):
        day = start + timedelta(days=offset)
        key = day.isoformat()
        buckets[key] = {
            "key": key,
            "label": day.strftime("%m-%d"),
            "total": 0,
            "critical": 0,
            "warning": 0,
            "info": 0,
        }
    for alert in alerts or []:
        moment = _parse_iso_datetime(alert.get("created_at"))
        if moment is None:
            continue
        key = moment.astimezone(tz).date().isoformat()
        bucket = buckets.get(key)
        if bucket is None:
            continue
        bucket["total"] += 1
        severity = str(alert.get("severity") or "info")
        if severity in ("critical", "warning"):
            bucket[severity] += 1
        else:
            bucket["info"] += 1
    rows = list(buckets.values())
    peak = max((row["total"] for row in rows), default=0)
    for row in rows:
        row["height"] = round(row["total"] * 100 / peak) if peak else 0
    return rows


def _build_host_detail(
    name: str,
    config,
    db_path,
    *,
    precomputed: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Build the ``/api/host/<name>`` payload, or ``None`` when unknown.

    A host that is configured but has not been polled yet is still valid: the
    detail page opens with empty metrics instead of a 404, which is important
    right after adding a host (or while the first collection is failing).

    ``precomputed`` carries fleet-wide reads for the inspection report
    (``snapshots`` / ``disks`` / ``alerts`` / ``checks`` / ``check_history`` /
    ``network`` / ``sample_counts`` / ``uptime_strips`` plus the user-row
    inputs).  ``None`` entries fall back to the per-host query so single-host
    callers stay on the simple path.
    """
    shared = precomputed or {}
    snapshots = shared.get("snapshots")
    snapshot = (
        snapshots.get(name)
        if snapshots is not None
        else storage.get_host_snapshot(name, db_path)
    )
    addresses = {server.name: server.host for server in config.servers}
    servers_by_name = {server.name: server for server in config.servers}
    server = servers_by_name.get(name)
    if snapshot is None and server is None:
        return None

    tz = resolve_timezone(config.app.timezone)
    disks = shared.get("disks")
    disk = disks.get(name) if disks is not None else storage.get_disk_health(name, db_path)
    if disk is not None:
        disk = dict(disk)
        disk["collected_at"] = _to_local_iso(disk.get("collected_at"), tz)
    alerts_grouped = shared.get("alerts")
    alerts = _localize_alerts(
        alerts_grouped.get(name, [])
        if alerts_grouped is not None
        else storage.list_alerts_for_host(name, db_path, limit=20),
        tz,
    )
    checks_grouped = shared.get("checks")
    checks = (
        checks_grouped.get(name, [])
        if checks_grouped is not None
        else storage.get_host_check_results(name, db_path)
    )
    history_grouped = shared.get("check_history")
    check_history = (
        history_grouped.get(name, {})
        if history_grouped is not None
        else storage.get_host_check_history(name, db_path)
    )
    network_grouped = shared.get("network")
    network = (
        network_grouped.get(name, {"rx_bytes_per_second": None, "tx_bytes_per_second": None})
        if network_grouped is not None
        else storage.fetch_host_network_rates(db_path, name)
    )
    users_pre = (shared.get("users") or {}).get(name) or {}
    detail = {
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
        "checks": checks,
        "check_history": check_history,
        "network": network,
        "users": _build_user_rows(name, db_path, tz, server, precomputed=users_pre),
    }
    poll_seconds = max(60, int(config.app.poll_interval_seconds or 600))
    sample_counts = shared.get("sample_counts")
    detail["collection_uptime"] = {
        "samples": (
            sample_counts.get(name, 0)
            if sample_counts is not None
            else storage.count_recent_samples(db_path, detail["name"], hours=24)
        ),
        "expected": max(1, int(24 * 3600 / poll_seconds)),
    }
    strips = shared.get("uptime_strips")
    detail["uptime_strip"] = (
        strips.get(
            name,
            _empty_uptime_strip_payload(24, 15, shared.get("_strip_since")),
        )
        if strips is not None
        else storage.fetch_host_uptime_strip(
            db_path, detail["name"], hours=24, bucket_minutes=15
        )
    )
    detail["diagnostics"] = diagnostics_mod.build_host_diagnostics(
        detail,
        poll_interval_seconds=config.app.poll_interval_seconds,
    )
    detail["diagnostics_summary"] = diagnostics_mod.summarize_diagnostics(
        detail["diagnostics"]
    )
    detail["alert_days"] = _host_alert_days(
        alerts,
        tz,
        now=datetime.now(tz),
    )
    return detail


def _empty_uptime_strip_payload(hours: int, bucket_minutes: int, since) -> dict:
    """Zero-filled heartbeat strip matching fetch_host_uptime_strip's shape."""
    since = since or datetime.now(timezone.utc)
    count = max(1, int((hours * 60) / bucket_minutes))
    bucket = timedelta(minutes=bucket_minutes)
    return {
        "hours": hours,
        "bucket_minutes": bucket_minutes,
        "buckets": [
            {"index": index, "start": (since + bucket * index).isoformat(), "total": 0, "ok": 0}
            for index in range(count)
        ],
        "samples": 0,
        "ok": 0,
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
    lines.append("[服务可用性]")
    checks = detail.get("checks") or []
    if checks:
        for check in checks:
            check_name = check.get("check_name") or "—"
            check_type = check.get("check_type") or "—"
            check_target = check.get("target") or "—"
            check_status = check.get("status") or "—"
            check_message = check.get("message") or "—"
            latency = _report_number(check.get("latency_ms"))
            latency_text = f" {latency:.0f}ms" if latency is not None else ""
            lines.append(
                f"  {check_name}（{check_type} {check_target}）："
                f"{check_status} {check_message}{latency_text}"
            )
    else:
        lines.append("  未配置服务检查")
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
    # v0.1.233：全队一次批量读齐（此前每台主机约 10 次查询）。
    tz = resolve_timezone(config.app.timezone)
    latest_raw = {
        item["host_name"]: item for item in storage.get_all_host_snapshots(db_path)
    }
    disks = {item["host_name"]: item for item in storage.get_all_disk_health(db_path)}
    alerts = {
        host: _localize_alerts(items, tz)
        for host, items in storage.list_recent_alerts_grouped(db_path, per_host=20).items()
    }
    checks = storage.get_all_host_check_results(db_path)
    check_history = storage.get_all_host_check_history(db_path)
    network = storage.fetch_all_host_network_rates(db_path)
    sample_counts = storage.count_recent_samples_by_host(db_path, hours=24)
    strip_now = datetime.now(timezone.utc)
    uptime_strips = storage.fetch_all_host_uptime_strips(
        db_path, hours=24, bucket_minutes=15, now=strip_now
    )
    fleet_users = {
        "snapshots": storage.get_all_host_user_snapshots(db_path),
        "baselines": storage.get_all_user_baselines(db_path),
        "deltas": storage.get_all_user_usage_deltas(db_path, days=_USAGE_DELTA_DAYS),
        "gpu_usage": {
            name: _gpu_usage_from_metrics((item or {}).get("metrics") or {})
            for name, item in latest_raw.items()
        },
    }
    precomputed = {
        "snapshots": latest_raw,
        "disks": disks,
        "alerts": alerts,
        "checks": checks,
        "check_history": check_history,
        "network": network,
        "sample_counts": sample_counts,
        "uptime_strips": uptime_strips,
        "_strip_since": strip_now - timedelta(hours=24),
        "users": {name: dict(fleet_users) for name in {s.name for s in config.servers}},
    }
    details: list[dict[str, Any]] = []
    for server in config.servers:
        detail = _build_host_detail(server.name, config, db_path, precomputed=precomputed)
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


def _aggregate_series(series: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Sum every account's points into one per-timestamp series for a host."""
    buckets: dict[str, float] = {}
    for points in (series or {}).values():
        for point in points or []:
            stamp = point.get("at")
            if not stamp:
                continue
            buckets[stamp] = buckets.get(stamp, 0) + float(point.get("total") or 0)
    return [{"at": stamp, "total": total} for stamp, total in sorted(buckets.items())]
