"""Compatibility facade for the split route modules.

M1 keeps every symbol that used to live in ``web/routes.py`` importable
from this package so existing tests and ``app.py`` stay unchanged while
route groups move into per-domain modules.
"""

import sys as _sys
from types import ModuleType as _ModuleType

from servermanage.web.routes import _core as _core  # noqa: F401
from servermanage.web.routes import ssh_terminal as ssh_terminal  # noqa: F401


class _FacadeModule(_ModuleType):
    """Forward attribute writes to ``_core`` so monkeypatching still works.

    Most tests patch names (``send_webhook``, ``_LOG_FILE``, ...) on the
    historical ``servermanage.web.routes`` module. After the M1 split those
    globals live in ``_core``; without forwarding, a patch on this facade would
    not be visible to the view functions that now live in ``_core``.
    """

    def __setattr__(self, name, value):
        super().__setattr__(name, value)
        # A test patching ``routes.SSHClientWrapper`` / ``routes.send_webhook``
        # must reach every split module that imported that name, not just _core.
        prefix = "servermanage.web.routes."
        for module_name, module in list(_sys.modules.items()):
            if module is None or not module_name.startswith(prefix):
                continue
            if name in getattr(module, "__dict__", {}):
                object.__setattr__(module, name, value)

from servermanage.web.routes._core import (  # noqa: F401
    base64,
    getpass,
    hmac,
    json,
    logging,
    os,
)
from servermanage.web.routes._core import (  # noqa: F401
    secrets,
    smtplib,
    tempfile,
    threading,
    time,
    deque,
)
from servermanage.web.routes._core import (  # noqa: F401
    ThreadPoolExecutor,
    replace,
    datetime,
    timedelta,
    timezone,
    Path,
)
from servermanage.web.routes._core import (  # noqa: F401
    Any,
    Flask,
    Response,
    current_app,
    jsonify,
    redirect,
)
from servermanage.web.routes._core import (  # noqa: F401
    render_template,
    request,
    send_file,
    session,
    url_for,
    availability,
)
from servermanage.web.routes._core import (  # noqa: F401
    capacity,
    compute_mod,
    diagnostics_mod,
    disk_capacity,
    host_import,
    host_probe,
)
from servermanage.web.routes._core import (  # noqa: F401
    maintenance,
    storage,
    container_stats_mod,
    admin,
    user_mode,
    app_version,
)
from servermanage.web.routes._core import (  # noqa: F401
    anchor_slug,
    fingerprint_for,
    run_host_checks,
    is_user_monitoring_enabled,
    AlertEvent,
    AuthConfig,
)
from servermanage.web.routes._core import (  # noqa: F401
    HostConfig,
    WebhookConfig,
    send_desktop_notification,
    send_webhook,
    read_runtime_state,
    to_jsonable,
)
from servermanage.web.routes._core import (  # noqa: F401
    SettingsError,
    _build_host_check,
    _sanitize_host_checks,
    ssh_client,
    SSHClientWrapper,
    SessionNotFoundError,
)
from servermanage.web.routes._core import (  # noqa: F401
    SshTerminalManager,
    TerminalLimitError,
    resolve_timezone,
    timezone_status,
    LOGGER,
    _VIRTUAL_FILESYSTEMS,
)
from servermanage.web.routes._core import (  # noqa: F401
    _plan_cache,
    _run_execute_job,
    _EXECUTE_JOBS,
    _EXECUTE_JOBS_LOCK,
    _EXECUTE_JOB_TTL_SECONDS,
    _config,
)
from servermanage.web.routes._core import (  # noqa: F401
    _db_path,
    _view_mode,
    _member_account,
    _USER_MODE_ALLOWED,
    _USER_MODE_SETTINGS_KEYS,
    _user_mode_allows,
)
from servermanage.web.routes._core import (  # noqa: F401
    get_ssh_terminal_manager,
    _terminal_request_allowed,
    _settings_service,
    _monitor_service,
    _request_user_refresh,
    _ALLOWED_SETTINGS_SECTIONS,
)
from servermanage.web.routes._core import (  # noqa: F401
    _settings_snapshot,
    _settings_or_404,
    _ensure_writable,
    _as_int,
    _optional_text,
    _IMPORT_PARSERS,
)
from servermanage.web.routes._core import (  # noqa: F401
    _LOG_FILE,
    _RUNTIME_FILE,
    _parse_import_payload,
    _ssh_config_path,
    _read_ssh_config_candidates,
    _truthy_arg,
)
from servermanage.web.routes._core import (  # noqa: F401
    _host_config_from_payload,
    _LOOPBACK_ADDRESSES,
    _LOGIN_FAILURE_LIMIT,
    _LOGIN_FAILURE_WINDOW_SECONDS,
    _is_loopback,
    _csrf_token,
)
from servermanage.web.routes._core import (  # noqa: F401
    _csrf_failure_response,
    _require_csrf,
    _refresh_config,
    _notify_hosts_imported,
    _parse_iso,
    _to_local_iso,
)
from servermanage.web.routes._core import (  # noqa: F401
    _localize_alerts,
    _ALERT_RANGE_HOURS,
    _ALERT_STATUS_FILTERS,
    _alert_status_filter,
    _alert_range_since,
    _as_float,
)
from servermanage.web.routes._core import (  # noqa: F401
    _percent_int,
    _memory_percent,
    _disk_percent,
    _gpu_memory_percent,
    _disk_health_summary,
    _anchor,
)
from servermanage.web.routes._core import (  # noqa: F401
    _drive_sort_key,
    _is_online,
    _metrics_payload,
    _logged_in_counts,
    _summarize_checks,
    _hottest_temperature,
)
from servermanage.web.routes._core import (  # noqa: F401
    _gpu_memory_totals,
    _gpu_payload,
    _host_row,
    _silence_applies,
    _system_diagnostics,
    _CAPACITY_CACHE,
)
from servermanage.web.routes._core import (  # noqa: F401
    _CAPACITY_CACHE_TTL_SECONDS,
    _CAPACITY_CACHE_LOCK,
    _capacity_forecasts_cached,
    _build_overview,
    _USER_DIRECTORY_ISSUES,
    _USAGE_DELTA_DAYS,
)
from servermanage.web.routes._core import (  # noqa: F401
    _user_row_issues,
    _user_usage_readable,
    _usage_scan_state,
    _usage_hint,
    _present_user_row,
    _missing_user_row,
)
from servermanage.web.routes._core import (  # noqa: F401
    _merge_user_rows,
    _user_host_status,
    _to_local_text,
    _build_my_summary,
    _gpu_usage_from_metrics,
    _gpu_usage_by_user,
)
from servermanage.web.routes._core import (  # noqa: F401
    _build_user_rows,
    _host_user_counts,
    _build_users_payload,
    _resolve_user_present_alert,
    _parse_iso_datetime,
    _host_alert_days,
)
from servermanage.web.routes._core import (  # noqa: F401
    _build_host_detail,
    _empty_uptime_strip_payload,
    _report_number,
    _build_host_report,
    _report_filename,
    _fleet_report_filename,
)
from servermanage.web.routes._core import (  # noqa: F401
    _build_fleet_report,
    _aggregate_series,
)


_sys.modules[__name__].__class__ = _FacadeModule

__all__ = [
    'base64',
    'getpass',
    'hmac',
    'json',
    'logging',
    'os',
    'secrets',
    'smtplib',
    'tempfile',
    'threading',
    'time',
    'deque',
    'ThreadPoolExecutor',
    'replace',
    'datetime',
    'timedelta',
    'timezone',
    'Path',
    'Any',
    'Flask',
    'Response',
    'current_app',
    'jsonify',
    'redirect',
    'render_template',
    'request',
    'send_file',
    'session',
    'url_for',
    'availability',
    'capacity',
    'compute_mod',
    'diagnostics_mod',
    'disk_capacity',
    'host_import',
    'host_probe',
    'maintenance',
    'storage',
    'container_stats_mod',
    'admin',
    'user_mode',
    'app_version',
    'anchor_slug',
    'fingerprint_for',
    'run_host_checks',
    'is_user_monitoring_enabled',
    'AlertEvent',
    'AuthConfig',
    'HostConfig',
    'WebhookConfig',
    'send_desktop_notification',
    'send_webhook',
    'read_runtime_state',
    'to_jsonable',
    'SettingsError',
    '_build_host_check',
    '_sanitize_host_checks',
    'ssh_client',
    'SSHClientWrapper',
    'SessionNotFoundError',
    'SshTerminalManager',
    'TerminalLimitError',
    'resolve_timezone',
    'timezone_status',
    'LOGGER',
    '_VIRTUAL_FILESYSTEMS',
    '_plan_cache',
    '_run_execute_job',
    '_EXECUTE_JOBS',
    '_EXECUTE_JOBS_LOCK',
    '_EXECUTE_JOB_TTL_SECONDS',
    '_config',
    '_db_path',
    '_view_mode',
    '_member_account',
    '_USER_MODE_ALLOWED',
    '_USER_MODE_SETTINGS_KEYS',
    '_user_mode_allows',
    'get_ssh_terminal_manager',
    '_terminal_request_allowed',
    '_settings_service',
    '_monitor_service',
    '_request_user_refresh',
    '_ALLOWED_SETTINGS_SECTIONS',
    '_settings_snapshot',
    '_settings_or_404',
    '_ensure_writable',
    '_as_int',
    '_optional_text',
    '_IMPORT_PARSERS',
    '_LOG_FILE',
    '_RUNTIME_FILE',
    '_parse_import_payload',
    '_ssh_config_path',
    '_read_ssh_config_candidates',
    '_truthy_arg',
    '_host_config_from_payload',
    '_LOOPBACK_ADDRESSES',
    '_LOGIN_FAILURE_LIMIT',
    '_LOGIN_FAILURE_WINDOW_SECONDS',
    '_is_loopback',
    '_csrf_token',
    '_csrf_failure_response',
    '_require_csrf',
    '_refresh_config',
    '_notify_hosts_imported',
    '_parse_iso',
    '_to_local_iso',
    '_localize_alerts',
    '_ALERT_RANGE_HOURS',
    '_ALERT_STATUS_FILTERS',
    '_alert_status_filter',
    '_alert_range_since',
    '_as_float',
    '_percent_int',
    '_memory_percent',
    '_disk_percent',
    '_gpu_memory_percent',
    '_disk_health_summary',
    '_anchor',
    '_drive_sort_key',
    '_is_online',
    '_metrics_payload',
    '_logged_in_counts',
    '_summarize_checks',
    '_hottest_temperature',
    '_gpu_memory_totals',
    '_gpu_payload',
    '_host_row',
    '_silence_applies',
    '_system_diagnostics',
    '_CAPACITY_CACHE',
    '_CAPACITY_CACHE_TTL_SECONDS',
    '_CAPACITY_CACHE_LOCK',
    '_capacity_forecasts_cached',
    '_build_overview',
    '_USER_DIRECTORY_ISSUES',
    '_USAGE_DELTA_DAYS',
    '_user_row_issues',
    '_user_usage_readable',
    '_usage_scan_state',
    '_usage_hint',
    '_present_user_row',
    '_missing_user_row',
    '_merge_user_rows',
    '_user_host_status',
    '_to_local_text',
    '_build_my_summary',
    '_gpu_usage_from_metrics',
    '_gpu_usage_by_user',
    '_build_user_rows',
    '_host_user_counts',
    '_build_users_payload',
    '_resolve_user_present_alert',
    '_parse_iso_datetime',
    '_host_alert_days',
    '_build_host_detail',
    '_empty_uptime_strip_payload',
    '_report_number',
    '_build_host_report',
    '_report_filename',
    '_fleet_report_filename',
    '_build_fleet_report',
    '_aggregate_series',
]


def register_routes(app: Flask) -> None:
    """Register auth guards and every split route module (M1 facade).

    ``_require_login`` stays here so it is installed exactly once, before the
    domain modules add their rules.  Each module registers its own view
    functions with the original bare endpoint names, so templates and
    ``url_for`` keep working unchanged.
    """
    from servermanage.web.routes import (
        alerts as _alerts,
        auth as _auth,
        disk_health as _disk_health,
        hosts as _hosts,
        overview as _overview,
        pages as _pages,
        settings_api as _settings_api,
        ssh_terminal as _ssh_terminal,
        system as _system,
        users as _users,
    )
    from servermanage.web.routes._core import (
        _config,
        _csrf_token,
        _require_csrf,
        _settings_service,
        _user_mode_allows,
        _view_mode,
        user_mode,
    )

    app.jinja_env.globals["csrf_token"] = _csrf_token

    @app.before_request
    def _require_login():
        path = request.path
        if path.startswith("/static/"):
            return None

        service = _settings_service(app)

        # 1) First-run setup gate.  ``/setup`` itself must stay reachable, and
        #    ``/login`` stays reachable so credentials can be checked/limited.
        if (
            path not in ("/setup", "/login")
            and service is not None
            and service.setup_required()
        ):
            if path.startswith("/api/"):
                return jsonify({"error": "setup_required"}), 428
            return redirect(url_for("setup"))

        # 1b) Unauthenticated API calls must be 401 even for POST/PUT/DELETE;
        #     otherwise a missing session yields a misleading CSRF 400.
        if path.startswith("/api/") and service is not None:
            api_config = _config(app)
            if api_config.dashboard.auth.enabled and not session.get("logged_in"):
                return jsonify({"error": "unauthorized"}), 401

        # 2) CSRF protection for state-changing requests.  Enforced whenever the
        #    app manages a session: a wired settings service always enforces it;
        #    an auth-enabled app also enforces it once the session carries a CSRF
        #    token (i.e. a browser session that rendered a page).  The token gate
        #    keeps the legacy no-service app in ``tests/test_web_api.py`` working
        #    (it drives the API directly, without ever loading a page) while
        #    closing the hole where an auth-enabled app skipped CSRF entirely.
        csrf_session_active = service is not None or (
            bool(getattr(_config(app).dashboard.auth, "enabled", False))
            and bool(session.get("csrf_token"))
        )
        if (
            csrf_session_active
            and path not in ("/login", "/setup")
            and request.method in ("POST", "PUT", "DELETE")
        ):
            rejection = _require_csrf()
            if rejection is not None:
                return rejection

        # 3) ``/setup`` and ``/login`` bypass the logged-in gate.
        if path in ("/setup", "/login"):
            return None

        config = _config(app)
        if config.dashboard.auth.enabled and not session.get("logged_in"):
            if path.startswith("/api/"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("login"))

        # 4) Member (user) mode: only the personal surfaces stay reachable.
        if _view_mode(config) == user_mode.MODE_USER and not _user_mode_allows(path):
            if path.startswith("/api/"):
                return (
                    jsonify(
                        {
                            "error": "admin_only",
                            "message": "该功能仅在管理员模式下可用",
                        }
                    ),
                    403,
                )
            return redirect(url_for("my_page"))
        return None

    _auth.register_auth(app)
    _overview.register_overview(app)
    _hosts.register_hosts(app)
    _users.register_users(app)
    _alerts.register_alerts(app)
    _disk_health.register_disk_health(app)
    _settings_api.register_settings_api(app)
    _system.register_system(app)
    _ssh_terminal.register(app)
    _pages.register_pages(app)
