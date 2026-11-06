"""Compose the effective :class:`AppConfig` from a YAML seed and SQLite settings.

The YAML ``config.yaml`` (plus its ``.env``) remains the first-boot seed.  From
then on the web UI persists non-sensitive sections to the ``app_settings`` table
and sensitive values (encrypted with Windows DPAPI) to ``app_secrets``.  This
module merges both layers into a single :class:`AppConfig` and exposes a masked
payload for the settings page.

Security invariant: plaintext secrets never enter ``app_settings`` and never
leave this module through :meth:`SettingsService.public_settings`; they are only
returned decrypted inside the in-memory :class:`AppConfig`.
"""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import fields, replace
from pathlib import Path
from typing import Any

from servermanage import security, storage
from servermanage.config import load_config
from servermanage.models import (
    AlertThresholds,
    AlertsConfig,
    AppConfig,
    AppRuntimeConfig,
    DashboardAuthConfig,
    DashboardConfig,
    DiskHealthConfig,
    DiskHealthRuleConfig,
    ReportConfig,
    SSHRuntimeConfig,
    WebhookConfig,
    WeeklyReportConfig,
)

__all__ = [
    "SettingsError",
    "SettingsService",
    "SECTION_MONITORING",
    "SECTION_DASHBOARD",
    "SECTION_ALERTS",
    "SECTION_REPORT",
    "SECTION_DISK_HEALTH",
    "SECTION_SSH",
    "SECTION_NAMES",
    "SECRET_SMTP_PASSWORD",
    "SECRET_WEBHOOK_URL",
    "SECRET_ADMIN",
    "SECRET_SESSION",
]

# --- Settings section names -------------------------------------------------

SECTION_MONITORING = "monitoring"
SECTION_DASHBOARD = "dashboard"
SECTION_ALERTS = "alerts"
SECTION_REPORT = "report"
SECTION_DISK_HEALTH = "disk_health"
SECTION_SSH = "ssh"

SECTION_NAMES = (
    SECTION_MONITORING,
    SECTION_DASHBOARD,
    SECTION_ALERTS,
    SECTION_REPORT,
    SECTION_DISK_HEALTH,
    SECTION_SSH,
)

_ALLOWED_SECTIONS = frozenset(SECTION_NAMES)

# --- Secret names -----------------------------------------------------------

SECRET_SMTP_PASSWORD = "smtp:password"
SECRET_WEBHOOK_URL = "webhook:url"
SECRET_ADMIN = "dashboard:admin_password"
SECRET_SESSION = "dashboard:session_secret"

# --- Accepted field names per nested section --------------------------------

_ALERT_TOP_FIELDS = frozenset(
    {
        "enabled",
        "desktop_notification",
        "email",
        "cooldown_minutes",
        "repeat_while_active",
        "offline_failures",
    }
)
_WEBHOOK_FIELDS = frozenset({"enabled", "type", "url_env"})
_THRESHOLD_FIELDS = frozenset(
    {
        "cpu_percent",
        "memory_percent",
        "disk_percent",
        "gpu_memory_percent",
        "disk_temperature_c",
    }
)
_REPORT_FIELDS = frozenset(
    {"subject_prefix", "include_failed_hosts", "daily_enabled", "daily_time"}
)
_WEEKLY_FIELDS = frozenset(
    {"enabled", "subject_prefix", "busy_threshold", "idle_threshold", "time", "weekday"}
)
_DISK_TOP_FIELDS = frozenset({"enabled", "use_sudo"})
_RULE_FIELDS = frozenset(
    {
        "alert_on_media_errors",
        "alert_on_other_errors",
        "alert_on_predictive_failure",
        "alert_on_smart_flag",
        "alert_on_state_not_optimal",
        "alert_on_error_increase",
    }
)
_DASHBOARD_TOP_FIELDS = frozenset({"host", "port", "session_lifetime_hours"})
_AUTH_FIELDS = frozenset(
    {
        "enabled",
        "username",
        "password_env",
        "password",
        "password_hash",
        "password_salt",
        "password_iterations",
    }
)


class SettingsError(ValueError):
    """Raised when a settings operation is invalid (bad section/payload/secret)."""


def _coerce_like(current: Any, value: Any) -> Any:
    """Coerce *value* to the type of *current* (JSON payloads arrive untyped)."""
    if isinstance(current, bool):
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)
    if isinstance(current, int) and not isinstance(current, bool):
        return int(value)
    if isinstance(current, float):
        return float(value)
    if isinstance(current, str):
        return str(value)
    return value


def _flat(base_obj: Any, payload: dict[str, Any], allowed: frozenset[str] | None = None) -> Any:
    """Return *base_obj* with fields from *payload* overlaid (typed like the base)."""
    updates: dict[str, Any] = {}
    for field_info in fields(base_obj):
        if allowed is not None and field_info.name not in allowed:
            continue
        if field_info.name in payload:
            updates[field_info.name] = _coerce_like(
                getattr(base_obj, field_info.name), payload[field_info.name]
            )
    return replace(base_obj, **updates) if updates else base_obj


class SettingsService:
    """Merge YAML seed + SQLite settings into an :class:`AppConfig`."""

    def __init__(
        self,
        *,
        config_path: Path,
        db_path: Path,
        base_config: AppConfig | None = None,
    ) -> None:
        self.config_path = Path(config_path)
        self.db_path = Path(db_path)
        if base_config is None:
            base_config = load_config(
                self.config_path,
                allow_empty_servers=True,
                allow_missing_secrets=True,
            )
        self.base_config = base_config
        self._ensure_secret_session()

    # -- public API ---------------------------------------------------------

    def load(self) -> AppConfig:
        """Return the effective config: YAML base overlaid with DB sections/secrets."""
        self._adopt_env_admin_password()
        sections = storage.load_app_settings(self.db_path)
        config = self.base_config
        for section, payload in sections.items():
            if section not in _ALLOWED_SECTIONS or not isinstance(payload, dict):
                continue
            config = self._apply_section(config, section, payload)
        return self._apply_secrets(config)

    def is_writable(self) -> bool:
        """True only where secrets can be encrypted (Windows DPAPI)."""
        return security.dpapi_available()

    def setup_required(self) -> bool:
        """Whether first-run admin setup still has to happen."""
        sections = storage.load_app_settings(self.db_path)
        security_section = sections.get("security")
        if isinstance(security_section, dict) and security_section.get("force_setup"):
            return True
        if storage.get_secret(SECRET_ADMIN, self.db_path) is not None:
            return False
        self._adopt_env_admin_password()
        return storage.get_secret(SECRET_ADMIN, self.db_path) is None

    def save_section(self, section: str, payload: dict[str, Any]) -> AppConfig:
        """Persist one settings section and return the newly composed config."""
        if section not in _ALLOWED_SECTIONS:
            raise SettingsError(f"unknown settings section: {section}")
        if not isinstance(payload, dict):
            raise SettingsError("settings payload must be an object")
        sanitized = deepcopy(payload)
        if section == SECTION_ALERTS:
            sanitized = self._sanitize_alerts(sanitized)
        storage.save_app_settings(section, sanitized, self.db_path)
        return self.load()

    def public_settings(self) -> dict[str, Any]:
        """Return the masked settings payload consumed by the settings page."""
        config = self.load()
        return {
            "writable": self.is_writable(),
            "setup_required": self.setup_required(),
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
            # Host listing is filled in by Task 6; empty for now.
            "hosts": [],
        }

    # -- section composition ------------------------------------------------

    def _apply_section(
        self, config: AppConfig, section: str, payload: dict[str, Any]
    ) -> AppConfig:
        if section == SECTION_MONITORING:
            return replace(config, app=_flat(config.app, payload))
        if section == SECTION_SSH:
            return replace(config, ssh=_flat(config.ssh, payload))
        if section == SECTION_DASHBOARD:
            return replace(
                config, dashboard=self._apply_dashboard(config.dashboard, payload)
            )
        if section == SECTION_ALERTS:
            return replace(config, alerts=self._apply_alerts(config.alerts, payload))
        if section == SECTION_REPORT:
            return replace(config, report=self._apply_report(config.report, payload))
        if section == SECTION_DISK_HEALTH:
            return replace(
                config,
                disk_health=self._apply_disk_health(config.disk_health, payload),
            )
        raise SettingsError(f"unknown settings section: {section}")

    def _apply_dashboard(
        self, dashboard: DashboardConfig, payload: dict[str, Any]
    ) -> DashboardConfig:
        auth = dashboard.auth
        auth_payload = payload.get("auth")
        if isinstance(auth_payload, dict):
            auth = _flat(
                auth,
                {key: value for key, value in auth_payload.items() if key in _AUTH_FIELDS},
                allowed=_AUTH_FIELDS,
            )
        username = payload.get("username")
        if username is not None and "auth" not in payload:
            auth = replace(auth, username=str(username))
        dashboard = replace(dashboard, auth=auth)
        top = {key: value for key, value in payload.items() if key in _DASHBOARD_TOP_FIELDS}
        if top:
            dashboard = _flat(dashboard, top, allowed=_DASHBOARD_TOP_FIELDS)
        return dashboard

    def _apply_alerts(self, alerts: AlertsConfig, payload: dict[str, Any]) -> AlertsConfig:
        webhook_payload = payload.get("webhook")
        if isinstance(webhook_payload, dict):
            webhook = _flat(
                alerts.webhook,
                {key: value for key, value in webhook_payload.items() if key in _WEBHOOK_FIELDS},
                allowed=_WEBHOOK_FIELDS,
            )
            alerts = replace(alerts, webhook=webhook)
        thresholds_payload = payload.get("thresholds")
        if isinstance(thresholds_payload, dict):
            thresholds = _flat(
                alerts.thresholds,
                {key: value for key, value in thresholds_payload.items() if key in _THRESHOLD_FIELDS},
                allowed=_THRESHOLD_FIELDS,
            )
            alerts = replace(alerts, thresholds=thresholds)
        top = {key: value for key, value in payload.items() if key in _ALERT_TOP_FIELDS}
        if top:
            alerts = _flat(alerts, top, allowed=_ALERT_TOP_FIELDS)
        return alerts

    def _apply_report(self, report: ReportConfig, payload: dict[str, Any]) -> ReportConfig:
        weekly_payload = payload.get("weekly")
        if isinstance(weekly_payload, dict):
            weekly = _flat(
                report.weekly,
                {key: value for key, value in weekly_payload.items() if key in _WEEKLY_FIELDS},
                allowed=_WEEKLY_FIELDS,
            )
            report = replace(report, weekly=weekly)
        top = {key: value for key, value in payload.items() if key in _REPORT_FIELDS}
        if top:
            report = _flat(report, top, allowed=_REPORT_FIELDS)
        return report

    def _apply_disk_health(
        self, disk_health: DiskHealthConfig, payload: dict[str, Any]
    ) -> DiskHealthConfig:
        rules_payload = payload.get("rules")
        if isinstance(rules_payload, dict):
            rules = _flat(
                disk_health.rules,
                {key: value for key, value in rules_payload.items() if key in _RULE_FIELDS},
                allowed=_RULE_FIELDS,
            )
            disk_health = replace(disk_health, rules=rules)
        candidates = payload.get("storcli_candidates")
        if isinstance(candidates, (list, tuple)):
            disk_health = replace(
                disk_health, storcli_candidates=tuple(str(item) for item in candidates)
            )
        top = {key: value for key, value in payload.items() if key in _DISK_TOP_FIELDS}
        if top:
            disk_health = _flat(disk_health, top, allowed=_DISK_TOP_FIELDS)
        return disk_health

    # -- secrets ------------------------------------------------------------

    def _sanitize_alerts(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Move a client-provided webhook URL into ``app_secrets`` (+ flag)."""
        webhook = payload.get("webhook")
        if isinstance(webhook, dict):
            url = webhook.pop("url", None)
            webhook.pop("url_env", None)
            configured = (
                bool(url)
                or storage.get_secret(SECRET_WEBHOOK_URL, self.db_path) is not None
                or bool(self.base_config.alerts.webhook.url)
            )
            if url:
                self._store_secret(SECRET_WEBHOOK_URL, str(url))
                configured = True
            webhook["url_configured"] = configured
        return payload

    def _apply_secrets(self, config: AppConfig) -> AppConfig:
        smtp_password = self._read_secret_text(SECRET_SMTP_PASSWORD)
        if smtp_password is not None and config.smtp is not None:
            config = replace(config, smtp=replace(config.smtp, password=smtp_password))

        webhook_url = self._read_secret_text(SECRET_WEBHOOK_URL)
        if webhook_url is not None:
            config = replace(
                config,
                alerts=replace(
                    config.alerts,
                    webhook=replace(config.alerts.webhook, url=webhook_url),
                ),
            )

        dashboard = config.dashboard
        session_secret = self._read_secret_text(SECRET_SESSION)
        if session_secret is not None:
            dashboard = replace(dashboard, session_secret=session_secret)
        admin = self._read_secret_json(SECRET_ADMIN)
        if isinstance(admin, dict) and admin.get("hash"):
            dashboard = replace(
                dashboard,
                auth=replace(
                    dashboard.auth,
                    username=str(admin.get("username", dashboard.auth.username)),
                    password_hash=str(admin["hash"]),
                    password_salt=str(admin.get("salt")),
                    password_iterations=int(
                        admin.get("iterations", dashboard.auth.password_iterations)
                    ),
                ),
            )
        if dashboard is not config.dashboard:
            config = replace(config, dashboard=dashboard)
        return config

    def _adopt_env_admin_password(self) -> None:
        """Adopt a legacy plaintext ``DASHBOARD_PASSWORD`` env value once.

        Hashes the password and stores it DPAPI-encrypted under
        ``dashboard:admin_password`` so later loads no longer depend on the env
        var (and existing deployments are not forced through first-run setup).
        """
        if not self.is_writable():
            return
        if storage.get_secret(SECRET_ADMIN, self.db_path) is not None:
            return
        env_password = self.base_config.dashboard.auth.password
        if not env_password:
            return
        try:
            self._store_admin_password(
                env_password, self.base_config.dashboard.auth.username
            )
        except security.SecurityError:
            pass

    def _ensure_secret_session(self) -> None:
        """Seed a per-install session signing secret (Windows only, once)."""
        if not self.is_writable():
            return
        if storage.get_secret(SECRET_SESSION, self.db_path) is not None:
            return
        try:
            ciphertext = security.protect_secret(_new_session_secret().encode("utf-8"))
        except security.SecurityError:
            return
        storage.set_secret(SECRET_SESSION, ciphertext, self.db_path)

    def _store_admin_password(self, password: str, username: str | None) -> None:
        iterations = DashboardAuthConfig().password_iterations
        digest, salt = security.hash_password(password, iterations=iterations)
        document = {
            "username": username or "admin",
            "hash": digest,
            "salt": salt,
            "iterations": iterations,
        }
        ciphertext = security.protect_secret(json.dumps(document).encode("utf-8"))
        storage.set_secret(SECRET_ADMIN, ciphertext, self.db_path)

    def _store_secret(self, name: str, value: str) -> None:
        if not self.is_writable():
            raise SettingsError("settings are not writable on this platform")
        storage.set_secret(name, security.protect_secret(value.encode("utf-8")), self.db_path)

    def _read_secret_text(self, name: str) -> str | None:
        blob = storage.get_secret(name, self.db_path)
        if blob is None:
            return None
        try:
            return security.unprotect_secret(blob).decode("utf-8")
        except (security.SecurityError, UnicodeDecodeError):
            return None

    def _read_secret_json(self, name: str) -> dict[str, Any] | None:
        text = self._read_secret_text(name)
        if text is None:
            return None
        try:
            value = json.loads(text)
        except (ValueError, TypeError):
            return None
        return value if isinstance(value, dict) else None


def _new_session_secret() -> str:
    import secrets as _secrets

    return _secrets.token_urlsafe(32)
