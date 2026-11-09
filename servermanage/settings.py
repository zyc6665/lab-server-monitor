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
import hmac
import os
import re
import types
from copy import deepcopy
from dataclasses import fields, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Union, get_args, get_origin, get_type_hints

from servermanage import __version__ as APP_VERSION
from servermanage import security, storage
from servermanage.config import load_config
from servermanage.models import (
    AlertsConfig,
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DashboardAuthConfig,
    DashboardConfig,
    DiskHealthConfig,
    HostAlertRules,
    HostCheckConfig,
    HostConfig,
    HostDiskHealthOverride,
    ReportConfig,
    SMTPConfig,
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
    "SECTION_SMTP",
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
SECTION_SMTP = "smtp"

SECTION_NAMES = (
    SECTION_MONITORING,
    SECTION_DASHBOARD,
    SECTION_ALERTS,
    SECTION_REPORT,
    SECTION_DISK_HEALTH,
    SECTION_SSH,
    SECTION_SMTP,
)

_ALLOWED_SECTIONS = frozenset(SECTION_NAMES)

# --- Secret names -----------------------------------------------------------

SECRET_SMTP_PASSWORD = "smtp:password"
SECRET_WEBHOOK_URL = "webhook:url"
SECRET_ADMIN = "dashboard:admin_password"
SECRET_SESSION = "dashboard:session_secret"

# Per-host secrets: plaintext credentials never live in the ``hosts`` section.
_HOST_SECRET_PASSWORD = "host:{name}:ssh_password"
_HOST_SECRET_KEY = "host:{name}:ssh_key"
_HOST_SECRET_PASSPHRASE = "host:{name}:ssh_passphrase"
_HOST_SECRET_SUDO_PASSWORD = "host:{name}:sudo_password"

# The ``hosts`` section is internal: it is written by the host CRUD helpers,
# never through :meth:`SettingsService.save_section` (which only accepts the
# public section names below).
_SECTION_HOSTS = "hosts"

_HOST_AUTH_TYPES = frozenset({"password", "key"})
_DEFAULT_DISK_MOUNTS = ["/", "/data"]

# Valid ranges for the v1.6 retention fields. These are enforced on save so a
# bad value can never truncate all history or disable cleanup silently.
_MONITORING_INT_RANGES = {
    "host_metrics_max_points": (10, 10000),
    "disk_health_retention_days": (1, 365),
    "disk_health_max_batches": (1, 1000),
    "host_daily_summary_retention_days": (7, 3650),
    "alert_history_retention_days": (1, 3650),
    "ssh_audit_retention_days": (1, 3650),
}

# --- Accepted field names per nested section --------------------------------

_ALERT_TOP_FIELDS = frozenset(
    {
        "enabled",
        "desktop_notification",
        "email",
        "cooldown_minutes",
        "repeat_while_active",
        "offline_failures",
        "aggregate_by_host",
        "notify_on_recovery",
        "consecutive_periods",
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
_SMTP_FIELDS = frozenset(
    {"host", "port", "username", "use_ssl", "from_addr", "to_addrs"}
)
_DASHBOARD_TOP_FIELDS = frozenset({"host", "port", "session_lifetime_hours"})
# Only non-secret auth fields may be persisted from the dashboard section.
# Admin credentials (plaintext, hash, salt, iterations) are exclusively managed
# through SECRET_ADMIN so a settings write can never inject a credential.
_DASHBOARD_AUTH_FIELDS = frozenset({"enabled", "username", "password_env"})


class SettingsError(ValueError):
    """Raised when a settings operation is invalid (bad section/payload/secret)."""


def _resolve_annotation(annotation: Any) -> Any:
    """Unwrap ``T | None`` / ``Optional[T]`` to ``T`` (NoneType otherwise ignored)."""
    origin = get_origin(annotation)
    if origin is Union or origin is types.UnionType:
        for arg in get_args(annotation):
            if arg is not type(None):
                return _resolve_annotation(arg)
    return annotation


def _type_hints(obj: Any) -> dict[str, Any]:
    try:
        return get_type_hints(type(obj))
    except Exception:  # pragma: no cover - defensive against exotic annotations
        return {}


def _coerce_like(current: Any, value: Any, annotation: Any = None) -> Any:
    """Coerce *value* to the annotated field type (JSON payloads arrive untyped).

    The declared annotation wins over the default's runtime type: e.g.
    ``AlertThresholds.disk_percent`` is annotated ``float`` but defaults to the
    int ``90``, so coercing by ``type(default)`` would silently truncate 80.5.
    """
    if value is None:
        return None
    target = _resolve_annotation(annotation)
    if target is bool:
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)
    if target is int and not isinstance(value, bool):
        return int(value)
    if target is float:
        return float(value)
    if target is str:
        return str(value)
    # Fallback: infer from the current value when the annotation is unavailable.
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
    """Return *base_obj* with fields from *payload* overlaid, typed by annotation."""
    hints = _type_hints(base_obj)
    updates: dict[str, Any] = {}
    for field_info in fields(base_obj):
        if allowed is not None and field_info.name not in allowed:
            continue
        if field_info.name in payload:
            annotation = hints.get(field_info.name, field_info.type)
            updates[field_info.name] = _coerce_like(
                getattr(base_obj, field_info.name), payload[field_info.name], annotation
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
        # Machine binding must run before any secret is seeded: a copied config
        # directory on another PC has to wipe the old machine's DPAPI secrets
        # and force first-run setup instead of failing to decrypt them later.
        self._ensure_machine_binding()
        self._ensure_secret_session()
        self._migrate_legacy_secrets()

    # -- public API ---------------------------------------------------------

    def load(self) -> AppConfig:
        """Return the effective config: YAML base overlaid with DB sections/secrets.

        The brief's contract is "base as the bottom layer, overridden section by
        section" (以 base 为底，按 section 覆盖), not a re-run of the raw mapping.
        Overlaying the already-validated base dataclass is equivalent for all
        persisted fields, while the base itself was still produced by
        ``load_config`` -> ``load_config_from_mapping`` so central validation
        (types, cross-field rules) continues to run once for the seed config.
        Secrets are then layered from ``app_secrets`` (never from ``app_settings``).
        """
        self._adopt_env_admin_password()
        sections = storage.load_app_settings(self.db_path)
        config = self.base_config
        for section, payload in sections.items():
            if section not in _ALLOWED_SECTIONS or not isinstance(payload, dict):
                continue
            config = self._apply_section(config, section, payload)
        host_entries = self._read_host_entries(sections)
        if host_entries is not None:
            config = replace(config, servers=self._build_servers(host_entries))
        elif self.base_config.servers and self.is_writable():
            # First load with a YAML/legacy seed but no ``hosts`` section yet:
            # persist the non-sensitive host inventory so later web edits have a
            # single source of truth (secrets are migrated separately).
            self._save_host_entries(
                [_host_entry_from_config(host) for host in self.base_config.servers]
            )
        return self._normalise_placeholder_services(self._apply_secrets(config))

    @staticmethod
    def _normalise_placeholder_services(config: AppConfig) -> AppConfig:
        """Disable report delivery when only the example SMTP block exists.

        The shipped example used to contain ``smtp.example.com`` while daily and
        weekly reports were enabled, so a fresh install tried to email
        ``ops@example.com`` every day and filled the log with DNS errors.  Treat
        the placeholder as "not configured" and switch its reports off; the user
        can enable them in the web settings page after entering a real server.
        """
        smtp = config.smtp
        placeholder = smtp is not None and (
            (smtp.host or "").strip().lower() in {"", "smtp.example.com"}
        )
        if not placeholder:
            return config
        report = config.report
        weekly = replace(report.weekly, enabled=False)
        report = replace(report, daily_enabled=False, weekly=weekly)
        return replace(config, report=report)

    def is_writable(self) -> bool:
        """True only where secrets can be encrypted (Windows DPAPI)."""
        return security.dpapi_available()

    def setup_required(self) -> bool:
        """Whether first-run admin setup still has to happen.

        Read-only platforms (Linux/Docker) keep the legacy YAML/.env login and
        never run the DPAPI-backed setup flow, which cannot persist a password.
        """
        if not self.is_writable():
            return False
        sections = storage.load_app_settings(self.db_path)
        security_section = sections.get("security")
        if isinstance(security_section, dict) and security_section.get("force_setup"):
            return True
        admin_blob = storage.get_secret(SECRET_ADMIN, self.db_path)
        if admin_blob is not None:
            if not self.is_writable():
                return False
            try:
                security.unprotect_secret(admin_blob)
            except security.SecurityError:
                # The credential exists but this machine's DPAPI cannot read it:
                # first-run setup is required again instead of locking the admin out.
                return True
            return False
        self._adopt_env_admin_password()
        return storage.get_secret(SECRET_ADMIN, self.db_path) is None

    def save_section(self, section: str, payload: dict[str, Any]) -> AppConfig:
        """Persist one settings section and return the newly composed config."""
        if section not in _ALLOWED_SECTIONS:
            raise SettingsError(f"unknown settings section: {section}")
        if not isinstance(payload, dict):
            raise SettingsError("settings payload must be an object")
        if not self.is_writable():
            raise SettingsError("settings are not writable on this platform")
        sanitized = deepcopy(payload)
        if section == SECTION_DASHBOARD:
            sanitized = self._sanitize_dashboard(sanitized)
        elif section == SECTION_ALERTS:
            sanitized = self._sanitize_alerts(sanitized)
        elif section == SECTION_SMTP:
            sanitized = self._sanitize_smtp(sanitized)
        if section == SECTION_REPORT:
            current = self.load()
            report = self._apply_report(current.report, sanitized)
            newly_enabled = (report.daily_enabled and not current.report.daily_enabled) or (
                report.weekly.enabled and not current.report.weekly.enabled
            )
            smtp = current.smtp
            smtp_ready = bool(
                smtp is not None
                and smtp.host
                and (not smtp.username or smtp.password)
            )
            if newly_enabled and not smtp_ready:
                raise SettingsError("启用日报/周报前需要先配置 SMTP 邮件服务器")
        storage.save_app_settings(section, sanitized, self.db_path)
        return self.load()

    def public_settings(self) -> dict[str, Any]:
        """Return the masked settings payload consumed by the settings page."""
        config = self.load()
        return {
            "writable": self.is_writable(),
            "version": APP_VERSION,
            "desktop_mode": os.environ.get("SERVERMONITOR_DESKTOP") == "1",
            "setup_required": self.setup_required(),
            "monitoring": {
                "timezone": config.app.timezone,
                "poll_interval_seconds": config.app.poll_interval_seconds,
                "disk_poll_interval_seconds": config.app.disk_poll_interval_seconds,
                "concurrency": config.app.concurrency,
                "retention_days": config.app.retention_days,
                "host_metrics_max_points": config.app.host_metrics_max_points,
                "disk_health_retention_days": config.app.disk_health_retention_days,
                "disk_health_max_batches": config.app.disk_health_max_batches,
                "host_daily_summary_retention_days": config.app.host_daily_summary_retention_days,
                "alert_history_retention_days": config.app.alert_history_retention_days,
                "ssh_audit_retention_days": config.app.ssh_audit_retention_days,
                "auto_port_fallback": config.app.auto_port_fallback,
                "tray_enabled": config.app.tray_enabled,
                "open_browser_on_start": config.app.open_browser_on_start,
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
                "aggregate_by_host": config.alerts.aggregate_by_host,
                "notify_on_recovery": config.alerts.notify_on_recovery,
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
            "hosts": self._public_hosts(),
        }

    # -- hosts ---------------------------------------------------------------

    def list_hosts(self) -> list[dict]:
        """Return the masked host inventory consumed by the settings page."""
        return self.public_settings()["hosts"]

    def get_host(self, name: str) -> dict | None:
        """Return one masked host entry, or ``None`` when it does not exist."""
        for host in self.list_hosts():
            if host.get("name") == name:
                return host
        return None

    def upsert_host(
        self,
        name: str,
        payload: dict[str, Any],
        *,
        allow_missing_credentials: bool = False,
    ) -> AppConfig:
        """Create or update host *name* and return the recomposed config.

        ``password`` / ``private_key`` / ``passphrase`` are write-only: they are moved into
        ``app_secrets`` and never persisted in the ``hosts`` section nor echoed
        by :meth:`public_settings`.
        """
        if not self.is_writable():
            raise SettingsError("settings are not writable on this platform")
        if not isinstance(payload, dict):
            raise SettingsError("host payload must be an object")
        name = _require_text(name, "name")
        payload_name = payload.get("name")
        if payload_name is not None and str(payload_name).strip() != name:
            raise SettingsError("host name in payload does not match the URL name")
        host = _require_text(payload.get("host"), "host")
        username = _require_text(payload.get("username"), "username")
        auth_type = _require_text(payload.get("auth_type"), "auth_type")
        if auth_type not in _HOST_AUTH_TYPES:
            raise SettingsError(f"unsupported auth_type: {auth_type}")
        port = _coerce_port(payload.get("port", 22))
        tags = _string_list(payload.get("tags"))
        disk_mounts = _string_list(payload.get("disk_mounts"), default=list(_DEFAULT_DISK_MOUNTS))
        if not disk_mounts:
            disk_mounts = list(_DEFAULT_DISK_MOUNTS)
        group = (_optional_text(payload.get("group")) or "").strip() or "未分组"
        owner = (_optional_text(payload.get("owner")) or "").strip()
        location = (_optional_text(payload.get("location")) or "").strip()
        notes = (_optional_text(payload.get("notes")) or "").strip()
        clear_secrets = _string_list(payload.get("clear_secrets"))
        key_path_raw = payload.get("key_path")
        key_path = str(key_path_raw).strip() if key_path_raw not in (None, "") else None
        entries = self._host_entries_for_update()
        existing_entry = next(
            (entry for entry in entries if entry.get("name") == name), None
        )
        if "checks" in payload:
            checks = _sanitize_host_checks(payload.get("checks"))
        else:
            checks = list((existing_entry or {}).get("checks") or [])
        if "alert_rules" in payload:
            alert_rules = _validate_alert_rules(payload.get("alert_rules"))
        else:
            alert_rules = (existing_entry or {}).get("alert_rules")

        # Credentials first: a failed secret write must not mutate the inventory.
        has_inline_secret = bool(
            _optional_text(payload.get("private_key"))
            or _optional_text(payload.get("password"))
            or _optional_text(payload.get("passphrase"))
        )
        if not (
            allow_missing_credentials
            and auth_type == "key"
            and key_path is None
            and not has_inline_secret
        ):
            self._apply_host_secrets(
                name,
                auth_type,
                password=_optional_text(payload.get("password")),
                private_key=_optional_text(payload.get("private_key")),
                passphrase=_optional_text(payload.get("passphrase")),
                key_path=key_path,
                clear_secrets=clear_secrets,
            )
        self._apply_host_sudo_password(name, payload, clear_secrets)

        entry = {
            "name": name,
            "host": host,
            "port": port,
            "username": username,
            "tags": tags,
            "disk_mounts": disk_mounts,
            "auth_type": auth_type,
            "key_path": key_path,
            "disk_health": _sanitize_host_disk_health(payload.get("disk_health")),
            "group": group,
            "owner": owner,
            "location": location,
            "notes": notes,
            "checks": checks,
            "alert_rules": alert_rules,
        }
        for index, existing in enumerate(entries):
            if existing.get("name") == name:
                entries[index] = entry
                break
        else:
            entries.append(entry)
        self._save_host_entries(entries)
        return self.load()

    def delete_host(self, name: str) -> AppConfig:
        """Remove host *name* and its three credentials, returning the new config."""
        if not self.is_writable():
            raise SettingsError("settings are not writable on this platform")
        name = _require_text(name, "name")
        for template in (
            _HOST_SECRET_PASSWORD,
            _HOST_SECRET_KEY,
            _HOST_SECRET_PASSPHRASE,
            _HOST_SECRET_SUDO_PASSWORD,
        ):
            storage.delete_secret(template.format(name=name), self.db_path)
        entries = [
            entry for entry in self._host_entries_for_update() if entry.get("name") != name
        ]
        self._save_host_entries(entries)
        return self.load()

    def host_groups(self) -> list[str]:
        """Return the distinct, sorted groups currently used by hosts."""
        groups = {"未分组"}
        for entry in self._host_entries_for_update():
            group = str(entry.get("group") or "").strip() or "未分组"
            groups.add(group)
        return sorted(groups)

    def _validate_import_candidate(
        self, raw: Any, *, allow_missing_credentials: bool = False
    ) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise SettingsError("主机条目必须是对象")
        if raw.get("valid") is False:
            raise SettingsError(str(raw.get("error") or "候选主机无效"))
        payload = dict(raw)
        name = _require_text(raw.get("name"), "name")
        payload["name"] = name
        payload["host"] = _require_text(raw.get("host"), "host")
        payload["username"] = _require_text(raw.get("username"), "username")
        auth_raw = raw.get("auth_type")
        auth_type = str(auth_raw).strip() if auth_raw is not None else ""
        if not auth_type:
            raise SettingsError("auth_type 不能为空")
        if auth_type not in _HOST_AUTH_TYPES:
            raise SettingsError(f"不支持的认证方式: {auth_type}")
        payload["auth_type"] = auth_type
        payload["port"] = _coerce_port(raw.get("port", 22))
        if allow_missing_credentials:
            # SSH-config import may create a host that still needs credentials;
            # the UI marks it as "待补凭据".  Never invent a secret here.
            return payload
        # Mirror _apply_host_secrets(): fail before any write when the selected
        # auth method has no usable credential source.
        clear = set(_string_list(raw.get("clear_secrets")))
        if auth_type == "password":
            existing = storage.get_secret(
                _HOST_SECRET_PASSWORD.format(name=name), self.db_path
            )
            usable = bool(_optional_text(raw.get("password"))) or (
                existing is not None and "password" not in clear
            )
            if not usable:
                raise SettingsError("SSH 密码未设置")
        else:
            key_path = raw.get("key_path")
            existing_key = storage.get_secret(
                _HOST_SECRET_KEY.format(name=name), self.db_path
            )
            usable = (
                bool(_optional_text(raw.get("private_key")))
                or (key_path is not None and bool(str(key_path).strip()))
                or (existing_key is not None and "key" not in clear)
            )
            if not usable:
                raise SettingsError("SSH 私钥未设置")
        return payload

    def import_hosts(
        self,
        candidates: list[dict],
        *,
        overwrite: bool = False,
        allow_missing_credentials: bool = False,
    ) -> dict[str, list]:
        """Validate every candidate before writing any of them, then upsert."""
        if not self.is_writable():
            raise SettingsError("settings are not writable on this platform")
        if not isinstance(candidates, (list, tuple)):
            raise SettingsError("candidates 必须是列表")
        existing = {
            str(entry.get("name") or "").strip()
            for entry in self._host_entries_for_update()
        }
        validated: list[dict] = []
        skipped: list[str] = []
        failed: list[dict] = []
        seen: set[str] = set()
        for raw in candidates:
            if not isinstance(raw, dict):
                failed.append({"name": "", "error": "主机条目必须是对象"})
                continue
            if raw.get("valid") is False:
                failed.append(
                    {
                        "name": str(raw.get("name") or "").strip(),
                        "error": str(raw.get("error") or "候选主机无效"),
                    }
                )
                continue
            try:
                name = _require_text(raw.get("name"), "name")
            except SettingsError as exc:
                failed.append(
                    {"name": str(raw.get("name") or "").strip(), "error": str(exc)}
                )
                continue
            # Existing targets are skipped before credential validation: the
            # stored host may use a key_path-only setup with no stored secret.
            if name in existing and not overwrite:
                skipped.append(name)
                seen.add(name)
                continue
            if name in seen:
                skipped.append(name)
                continue
            try:
                payload = self._validate_import_candidate(
                    raw, allow_missing_credentials=allow_missing_credentials
                )
            except SettingsError as exc:
                failed.append({"name": name, "error": str(exc)})
                continue
            seen.add(name)
            validated.append(payload)

        created: list[str] = []
        updated: list[str] = []
        for payload in validated:
            name = payload["name"]
            try:
                self.upsert_host(
                    name,
                    payload,
                    allow_missing_credentials=allow_missing_credentials,
                )
            except SettingsError as exc:
                failed.append({"name": name, "error": str(exc)})
                continue
            if name in existing:
                updated.append(name)
            else:
                created.append(name)
            existing.add(name)
        return {
            "created": created,
            "updated": updated,
            "skipped": skipped,
            "failed": failed,
        }

    def copy_host(self, source: str, new_name: str) -> AppConfig:
        """Copy host *source* to *new_name*, including all three credentials."""
        if not self.is_writable():
            raise SettingsError("settings are not writable on this platform")
        source = _require_text(source, "source")
        new_name = _require_text(new_name, "new_name")
        entries = self._host_entries_for_update()
        source_entry = next(
            (dict(entry) for entry in entries if entry.get("name") == source), None
        )
        if source_entry is None:
            raise SettingsError(f"源主机不存在: {source}")
        if any(entry.get("name") == new_name for entry in entries):
            raise SettingsError(f"目标主机已存在: {new_name}")
        for template in (
            _HOST_SECRET_PASSWORD,
            _HOST_SECRET_KEY,
            _HOST_SECRET_PASSPHRASE,
            _HOST_SECRET_SUDO_PASSWORD,
        ):
            blob = storage.get_secret(template.format(name=source), self.db_path)
            if blob is not None:
                storage.set_secret(template.format(name=new_name), blob, self.db_path)
        entry = deepcopy(source_entry)
        entry["name"] = new_name
        entry["group"] = str(entry.get("group") or "").strip() or "未分组"
        entries.append(entry)
        self._save_host_entries(entries)
        return self.load()

    # -- alert silences ------------------------------------------------------

    def list_silences(self, active_only: bool = True) -> list[dict]:
        return storage.list_silences(self.db_path, active_only=active_only)

    def add_silence(
        self,
        scope_type: str,
        scope: str | None,
        reason: str,
        starts_at: Any,
        ends_at: Any,
        created_by: str | None = None,
    ) -> int:
        if not self.is_writable():
            raise SettingsError("settings are not writable on this platform")
        scope_type = str(scope_type or "").strip()
        if scope_type not in {"host", "group", "all"}:
            raise SettingsError("scope_type 必须是 host、group 或 all")
        if scope_type == "all":
            if scope is not None and str(scope).strip():
                raise SettingsError("all 作用域的 scope 必须为空")
            scope_value: str | None = None
        else:
            scope_value = str(scope).strip() if scope is not None else ""
            if not scope_value:
                raise SettingsError("scope 不能为空")
        start = _coerce_datetime(starts_at, "starts_at")
        end = _coerce_datetime(ends_at, "ends_at")
        if start >= end:
            raise SettingsError("starts_at 必须早于 ends_at")
        if end - start > timedelta(days=30):
            raise SettingsError("静默窗口不能超过 30 天")
        silence_id = storage.insert_silence(
            scope_type,
            scope_value,
            str(reason or ""),
            start,
            end,
            created_by,
            self.db_path,
        )
        self._resolve_open_alerts_for_scope(scope_type, scope_value)
        return silence_id

    def delete_silence(self, silence_id: int) -> bool:
        return storage.delete_silence(silence_id, self.db_path)

    def _resolve_open_alerts_for_scope(
        self, scope_type: str, scope: str | None
    ) -> None:
        if scope_type == "all":
            target: set[str] | None = None
        elif scope_type == "host":
            target = {scope or ""}
        else:
            target = {
                str(entry.get("name") or "").strip()
                for entry in self._host_entries_for_update()
                if (str(entry.get("group") or "").strip() or "未分组") == scope
            }
            target.discard("")
        for status in ("active", "acknowledged"):
            for alert in storage.list_alerts(
                self.db_path, status=status, limit=1_000_000
            ):
                if target is not None and str(alert.get("host_name") or "") not in target:
                    continue
                storage.update_alert(
                    int(alert["id"]), self.db_path, status="resolved"
                )

    def _apply_host_secrets(
        self,
        name: str,
        auth_type: str,
        *,
        password: str | None,
        private_key: str | None,
        passphrase: str | None,
        key_path: str | None,
        clear_secrets: list[str],
    ) -> None:
        clear = set(clear_secrets)
        password_secret = _HOST_SECRET_PASSWORD.format(name=name)
        key_secret = _HOST_SECRET_KEY.format(name=name)
        passphrase_secret = _HOST_SECRET_PASSPHRASE.format(name=name)
        if auth_type == "password":
            existing = storage.get_secret(password_secret, self.db_path)
            usable = bool(password) or (
                existing is not None and "password" not in clear
            )
            if not usable:
                # Validate the *new* credential before touching any secret: a
                # failed switch must leave the previous auth method intact.
                raise SettingsError("SSH 密码未设置")
            if "password" in clear:
                storage.delete_secret(password_secret, self.db_path)
            if password:
                self._store_secret(password_secret, password)
            # Only now that the new credential is persisted, drop the stale
            # secrets of the other auth method.
            storage.delete_secret(key_secret, self.db_path)
            storage.delete_secret(passphrase_secret, self.db_path)
            return
        # key auth: confirm a usable key source before deleting anything.
        existing_key = storage.get_secret(key_secret, self.db_path)
        usable = bool(private_key) or key_path is not None or (
            existing_key is not None and "key" not in clear
        )
        if not usable:
            raise SettingsError("SSH 私钥未设置")
        if "key" in clear:
            storage.delete_secret(key_secret, self.db_path)
        if private_key:
            self._store_secret(key_secret, private_key)
        if "passphrase" in clear:
            storage.delete_secret(passphrase_secret, self.db_path)
        if passphrase:
            self._store_secret(passphrase_secret, passphrase)
        # Only switch over once the key credential is in place.
        storage.delete_secret(password_secret, self.db_path)

    def _apply_host_sudo_password(
        self,
        name: str,
        payload: dict[str, Any],
        clear_secrets: list[str],
    ) -> None:
        """Persist a write-only sudo password; ``sudo_configured`` is derived."""
        secret_name = _HOST_SECRET_SUDO_PASSWORD.format(name=name)
        if "sudo_password" in set(clear_secrets):
            storage.delete_secret(secret_name, self.db_path)
        raw = payload.get("sudo_password")
        if raw is None:
            return
        text = str(raw)
        if text == "":
            return
        if "\n" in text or "\r" in text:
            raise SettingsError("sudo 密码不能包含换行符")
        if len(text.encode("utf-8")) > 256:
            raise SettingsError("sudo 密码最多 256 字节")
        self._store_secret(secret_name, text)

    def _host_entries_for_update(self) -> list[dict]:
        entries = self._read_host_entries()
        if entries is not None:
            return [dict(entry) for entry in entries]
        return [_host_entry_from_config(host) for host in self.base_config.servers]

    def _read_host_entries(
        self, sections: dict[str, Any] | None = None
    ) -> list[dict] | None:
        if sections is None:
            sections = storage.load_app_settings(self.db_path)
        if not isinstance(sections, dict):
            return None
        payload = sections.get(_SECTION_HOSTS)
        if not isinstance(payload, dict):
            return None
        entries = payload.get("hosts")
        if not isinstance(entries, list):
            return None
        return [entry for entry in entries if isinstance(entry, dict)]

    def _save_host_entries(self, entries: list[dict]) -> None:
        storage.save_app_settings(_SECTION_HOSTS, {"hosts": entries}, self.db_path)

    def _public_hosts(self) -> list[dict]:
        entries = self._read_host_entries()
        if entries is None:
            entries = [_host_entry_from_config(host) for host in self.base_config.servers]
        return [self._public_host_entry(entry) for entry in entries]

    def _public_host_entry(self, entry: dict[str, Any]) -> dict[str, Any]:
        name = str(entry.get("name") or "")
        key_path = entry.get("key_path")
        return {
            "name": name,
            "host": str(entry.get("host") or ""),
            "port": entry.get("port", 22),
            "username": str(entry.get("username") or ""),
            "tags": [str(tag) for tag in entry.get("tags") or []],
            "disk_mounts": [str(mount) for mount in entry.get("disk_mounts") or []],
            "auth_type": str(entry.get("auth_type") or ""),
            "key_path": key_path,
            "disk_health": entry.get("disk_health"),
            "group": str(entry.get("group") or "").strip() or "未分组",
            "owner": str(entry.get("owner") or "").strip(),
            "location": str(entry.get("location") or "").strip(),
            "notes": str(entry.get("notes") or "").strip(),
            "checks": [dict(check) for check in entry.get("checks") or []],
            "alert_rules": entry.get("alert_rules"),
            "password_configured": (
                storage.get_secret(_HOST_SECRET_PASSWORD.format(name=name), self.db_path)
                is not None
            ),
            "key_configured": (
                storage.get_secret(_HOST_SECRET_KEY.format(name=name), self.db_path)
                is not None
                or bool(key_path)
            ),
            "passphrase_configured": (
                storage.get_secret(_HOST_SECRET_PASSPHRASE.format(name=name), self.db_path)
                is not None
            ),
            "sudo_configured": (
                storage.get_secret(
                    _HOST_SECRET_SUDO_PASSWORD.format(name=name), self.db_path
                )
                is not None
            ),
        }

    def _build_servers(self, entries: list[dict[str, Any]]) -> list[HostConfig]:
        servers: list[HostConfig] = []
        for entry in entries:
            name = str(entry.get("name") or "").strip()
            host = str(entry.get("host") or "").strip()
            username = str(entry.get("username") or "").strip()
            auth_type = str(entry.get("auth_type") or "").strip()
            if not name or not host or not username or auth_type not in _HOST_AUTH_TYPES:
                raise SettingsError(
                    f"host entry is invalid: {name or '<unnamed>'} "
                    f"(host/auth_type/username missing or unsupported)"
                )
            try:
                port = int(entry.get("port", 22))
            except (TypeError, ValueError):
                port = 22
            disk_mounts = [str(mount) for mount in entry.get("disk_mounts") or []]
            servers.append(
                HostConfig(
                    name=name,
                    host=host,
                    port=port,
                    username=username,
                    auth=self._build_auth(name, auth_type, entry),
                    tags=[str(tag) for tag in entry.get("tags") or []],
                    disk_health=_build_host_disk_health(entry.get("disk_health")),
                    disk_mounts=disk_mounts or list(_DEFAULT_DISK_MOUNTS),
                    group=str(entry.get("group") or "").strip() or "未分组",
                    owner=str(entry.get("owner") or "").strip(),
                    location=str(entry.get("location") or "").strip(),
                    notes=str(entry.get("notes") or "").strip(),
                    checks=[
                        _build_host_check(check)
                        for check in entry.get("checks") or []
                        if isinstance(check, dict)
                    ],
                    alert_rules=_build_host_alert_rules(entry.get("alert_rules")),
                    sudo_password=self._read_secret_text(
                        _HOST_SECRET_SUDO_PASSWORD.format(name=name)
                    ),
                )
            )
        return servers

    def _build_auth(self, name: str, auth_type: str, entry: dict[str, Any]) -> AuthConfig:
        if auth_type == "password":
            return AuthConfig(
                type=auth_type,
                password=self._read_secret_text(
                    _HOST_SECRET_PASSWORD.format(name=name)
                ),
            )
        key_path_raw = entry.get("key_path")
        key_path = Path(str(key_path_raw)).expanduser() if key_path_raw else None
        return AuthConfig(
            type=auth_type,
            key_path=key_path,
            key_data=self._read_secret_text(_HOST_SECRET_KEY.format(name=name)),
            passphrase=self._read_secret_text(_HOST_SECRET_PASSPHRASE.format(name=name)),
        )

    # -- admin credential ----------------------------------------------------

    def verify_admin(self, username: str, password: str) -> bool:
        """Check *username* / *password* against the stored admin credential.

        Falls back to the plaintext dashboard password from YAML/.env only while
        the DPAPI-backed credential has not been created yet (migration period).
        """
        admin = self._read_secret_json(SECRET_ADMIN)
        if isinstance(admin, dict):
            hash_value = admin.get("hash")
            salt = admin.get("salt")
            if not isinstance(hash_value, str) or not hash_value:
                return False
            if not isinstance(salt, str) or not salt:
                return False
            iterations = admin.get("iterations")
            if not isinstance(iterations, int) or isinstance(iterations, bool) or iterations <= 0:
                iterations = DashboardAuthConfig().password_iterations
            stored_user = admin.get("username") or self.base_config.dashboard.auth.username
            if str(stored_user) != str(username):
                return False
            return security.verify_password(
                password, hash_value, salt, iterations
            )
        auth = self.base_config.dashboard.auth
        sections = storage.load_app_settings(self.db_path)
        security_section = sections.get("security")
        if isinstance(security_section, dict) and security_section.get("force_setup"):
            # During a forced re-setup the legacy plaintext credential is void.
            return False
        if not auth.password:
            return False
        if str(username) != str(auth.username or "admin"):
            return False
        return hmac.compare_digest(str(password), str(auth.password))

    def set_admin_password(
        self,
        current_password: str | None,
        new_password: str,
        *,
        username: str | None = None,
    ) -> None:
        """Create or rotate the admin credential (DPAPI-encrypted JSON in SECRET_ADMIN)."""
        if not self.is_writable():
            raise SettingsError("settings are not writable on this platform")
        if not isinstance(new_password, str) or len(new_password) < 8:
            raise SettingsError("新密码长度至少 8 位")
        admin = self._read_secret_json(SECRET_ADMIN)
        existing_user: str | None = None
        if isinstance(admin, dict) and isinstance(admin.get("hash"), str) and admin.get("hash"):
            existing_user = str(
                admin.get("username")
                or self.base_config.dashboard.auth.username
                or "admin"
            )
            if not current_password or not self.verify_admin(
                existing_user, current_password
            ):
                raise SettingsError("当前密码不正确")
        target_user = (
            username
            or existing_user
            or self.base_config.dashboard.auth.username
            or "admin"
        )
        # Prepare every sensitive value before the first write so a crypto
        # failure leaves the existing credential untouched.
        try:
            session_ciphertext = security.protect_secret(
                _new_session_secret().encode("utf-8")
            )
        except security.SecurityError as exc:
            raise SettingsError(f"无法轮换会话密钥: {exc}") from exc
        self._store_admin_password(new_password, target_user)
        sections = storage.load_app_settings(self.db_path)
        security_section = sections.get("security")
        payload = dict(security_section) if isinstance(security_section, dict) else {}
        payload.pop("force_setup", None)
        payload.pop("migration_error", None)
        payload["machine_id"] = security.current_machine_id()
        # A fresh admin credential means the one-time legacy import is settled;
        # without this marker a restart after a machine-change reset would
        # re-import the old plaintext secrets from the YAML seed.
        payload["migrated_at"] = datetime.now(timezone.utc).isoformat()
        storage.save_app_settings("security", payload, self.db_path)
        storage.set_secret(SECRET_SESSION, session_ciphertext, self.db_path)

    # -- machine binding & legacy migration ----------------------------------

    def _ensure_machine_binding(self) -> None:
        """Wipe DPAPI secrets when they belong to another machine/user.

        Two independent triggers force a reset: a recorded ``machine_id`` that no
        longer matches, or any stored secret that this machine's DPAPI cannot
        decrypt (copied profile, rotated keys, corrupt blob). Either way the
        admin would be locked out, so the secrets are dropped and first-run
        setup is forced while the non-sensitive config is kept.
        """
        sections = storage.load_app_settings(self.db_path)
        section = sections.get("security")
        payload = dict(section) if isinstance(section, dict) else {}
        machine_id = payload.get("machine_id")
        current = security.current_machine_id()
        if machine_id and machine_id != current:
            self._reset_secrets_for_machine(current)
            return
        if self._has_unreadable_secret():
            self._reset_secrets_for_machine(current)
            return
        if not machine_id:
            payload["machine_id"] = current
            storage.save_app_settings("security", payload, self.db_path)

    def _has_unreadable_secret(self) -> bool:
        if not self.is_writable():
            return False
        for name in storage.list_secret_names(self.db_path):
            blob = storage.get_secret(name, self.db_path)
            if blob is None:
                continue
            try:
                security.unprotect_secret(blob)
            except (security.SecurityError, OSError, ValueError):
                return True
        return False

    def _reset_secrets_for_machine(self, current: str) -> None:
        # Keep the non-sensitive host inventory: without a ``hosts`` section the
        # next load would fall back to the YAML seed (and its plaintext
        # credentials) — exactly what this reset must not resurrect.
        if self._read_host_entries() is None and self.base_config.servers:
            self._save_host_entries(
                [_host_entry_from_config(host) for host in self.base_config.servers]
            )
        for name in storage.list_secret_names(self.db_path):
            storage.delete_secret(name, self.db_path)
        storage.save_app_settings(
            "security",
            {"machine_id": current, "force_setup": True},
            self.db_path,
        )

    def _migrate_legacy_secrets(self) -> None:
        """One-time import of YAML/.env plaintext secrets into ``app_secrets``."""
        if not self.is_writable():
            return
        sections = storage.load_app_settings(self.db_path)
        section = sections.get("security")
        payload = dict(section) if isinstance(section, dict) else {}
        if payload.get("migrated_at"):
            return
        if payload.get("force_setup"):
            # A machine change just wiped the secrets; re-importing plaintext
            # from the config would defeat the reset.
            return
        try:
            self._migrate_legacy_sources()
        except Exception as exc:  # noqa: BLE001 - migration must never block startup
            payload["migration_error"] = f"{type(exc).__name__}: {exc}"
            storage.save_app_settings("security", payload, self.db_path)
            return
        payload["migrated_at"] = datetime.now(timezone.utc).isoformat()
        payload.pop("migration_error", None)
        storage.save_app_settings("security", payload, self.db_path)

    def _migrate_legacy_sources(self) -> None:
        base = self.base_config
        if (
            base.smtp is not None
            and base.smtp.password
            and storage.get_secret(SECRET_SMTP_PASSWORD, self.db_path) is None
        ):
            self._store_secret(SECRET_SMTP_PASSWORD, base.smtp.password)
        webhook_url = base.alerts.webhook.url
        if webhook_url and storage.get_secret(SECRET_WEBHOOK_URL, self.db_path) is None:
            self._store_secret(SECRET_WEBHOOK_URL, str(webhook_url))
        admin_password = base.dashboard.auth.password
        if admin_password and storage.get_secret(SECRET_ADMIN, self.db_path) is None:
            self._store_admin_password(
                admin_password, base.dashboard.auth.username
            )
        for host in base.servers:
            self._migrate_legacy_host_secrets(host)

    def _migrate_legacy_host_secrets(self, host: HostConfig) -> None:
        auth = host.auth
        password_secret = _HOST_SECRET_PASSWORD.format(name=host.name)
        if auth.type == "password":
            if auth.password and storage.get_secret(password_secret, self.db_path) is None:
                self._store_secret(password_secret, auth.password)
            return
        if auth.type != "key":
            return
        key_secret = _HOST_SECRET_KEY.format(name=host.name)
        if storage.get_secret(key_secret, self.db_path) is None:
            if auth.key_data:
                self._store_secret(key_secret, auth.key_data)
            elif auth.key_path is not None and Path(auth.key_path).is_file():
                self._store_secret(
                    key_secret, Path(auth.key_path).read_text(encoding="utf-8")
                )
        passphrase_secret = _HOST_SECRET_PASSPHRASE.format(name=host.name)
        if auth.passphrase and storage.get_secret(passphrase_secret, self.db_path) is None:
            self._store_secret(passphrase_secret, auth.passphrase)

    # -- section composition ------------------------------------------------

    def _apply_section(
        self, config: AppConfig, section: str, payload: dict[str, Any]
    ) -> AppConfig:
        if section == SECTION_MONITORING:
            app = _flat(config.app, payload)
            self._validate_monitoring(app)
            return replace(config, app=app)
        if section == SECTION_SSH:
            return replace(config, ssh=_flat(config.ssh, payload))
        if section == SECTION_SMTP:
            current = config.smtp or SMTPConfig(
                host="",
                port=587,
                username="",
                password="",
                use_ssl=False,
                from_addr="",
                to_addrs=[],
            )
            data = {key: value for key, value in payload.items() if key in _SMTP_FIELDS}
            return replace(config, smtp=_flat(current, data, allowed=_SMTP_FIELDS))
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

    def _validate_monitoring(self, app: AppRuntimeConfig) -> None:
        """Reject retention values that would make history useless or unbounded."""
        for field_name, (minimum, maximum) in _MONITORING_INT_RANGES.items():
            value = getattr(app, field_name)
            if not isinstance(value, int) or isinstance(value, bool):
                raise SettingsError(f"{field_name} 必须是整数")
            if value < minimum or value > maximum:
                raise SettingsError(
                    f"{field_name} 必须在 {minimum} 到 {maximum} 之间"
                )

    def _apply_dashboard(
        self, dashboard: DashboardConfig, payload: dict[str, Any]
    ) -> DashboardConfig:
        """Merge only non-secret dashboard/auth fields from persisted settings.

        Admin credentials (password/hash/salt/iterations) are deliberately never
        read from ``app_settings.dashboard``; :meth:`_apply_secrets` layers them
        exclusively from ``dashboard:admin_password``.
        """
        auth = dashboard.auth
        auth_overrides: dict[str, Any] = {}
        auth_payload = payload.get("auth")
        if isinstance(auth_payload, dict):
            auth_overrides.update(
                {key: value for key, value in auth_payload.items() if key in _DASHBOARD_AUTH_FIELDS}
            )
        for key in _DASHBOARD_AUTH_FIELDS:
            if key in payload and key not in auth_overrides:
                auth_overrides[key] = payload[key]
        if auth_overrides:
            auth = _flat(auth, auth_overrides, allowed=_DASHBOARD_AUTH_FIELDS)
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

    def _sanitize_dashboard(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Strip credentials from a dashboard payload before it is persisted.

        Only non-secret auth fields (``enabled``/``username``/``password_env``)
        and safe dashboard top-level fields survive. ``password``,
        ``password_hash``, ``password_salt`` and ``password_iterations`` are
        discarded even when nested under ``auth``, so a settings write can never
        inject a plaintext password or an attacker-chosen hash/salt.
        """
        sanitized: dict[str, Any] = {}
        for key in _DASHBOARD_TOP_FIELDS | _DASHBOARD_AUTH_FIELDS:
            if key in payload:
                sanitized[key] = payload[key]
        auth_payload = payload.get("auth")
        if isinstance(auth_payload, dict):
            auth = {
                key: value
                for key, value in auth_payload.items()
                if key in _DASHBOARD_AUTH_FIELDS
            }
            if auth:
                sanitized["auth"] = auth
        return sanitized

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

    def _sanitize_smtp(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Keep non-secret SMTP fields and move the password into app_secrets."""
        sanitized: dict[str, Any] = {}
        for key in _SMTP_FIELDS:
            if key in payload:
                sanitized[key] = payload[key]
        password = payload.get("password")
        if isinstance(password, str) and password:
            self._store_secret(SECRET_SMTP_PASSWORD, password)
        recipients = sanitized.get("to_addrs")
        if isinstance(recipients, str):
            sanitized["to_addrs"] = [
                item.strip()
                for item in recipients.replace(";", ",").split(",")
                if item.strip()
            ]
        elif isinstance(recipients, (list, tuple)):
            sanitized["to_addrs"] = [str(item).strip() for item in recipients if str(item).strip()]
        sanitized["password_configured"] = (
            storage.get_secret(SECRET_SMTP_PASSWORD, self.db_path) is not None
            or bool(self.base_config.smtp and self.base_config.smtp.password)
        )
        return sanitized

    def _apply_secrets(self, config: AppConfig) -> AppConfig:
        smtp_password = self._read_secret_text(SECRET_SMTP_PASSWORD)
        if smtp_password is not None:
            if config.smtp is None:
                config = replace(
                    config,
                    smtp=SMTPConfig(
                        host="",
                        port=587,
                        username="",
                        password=smtp_password,
                        use_ssl=False,
                        from_addr="",
                        to_addrs=[],
                    ),
                )
            else:
                config = replace(
                    config,
                    smtp=replace(config.smtp, password=smtp_password),
                )

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
        if isinstance(admin, dict):
            hash_value = admin.get("hash")
            if isinstance(hash_value, str) and hash_value:
                username = admin.get("username")
                if not isinstance(username, str) or not username:
                    username = dashboard.auth.username
                salt = admin.get("salt")
                if not isinstance(salt, str) or not salt:
                    salt = None
                iterations = admin.get("iterations", dashboard.auth.password_iterations)
                if (
                    not isinstance(iterations, int)
                    or isinstance(iterations, bool)
                    or iterations <= 0
                ):
                    iterations = dashboard.auth.password_iterations
                dashboard = replace(
                    dashboard,
                    auth=replace(
                        dashboard.auth,
                        username=username,
                        password_hash=hash_value,
                        password_salt=salt,
                        password_iterations=iterations,
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
        sections = storage.load_app_settings(self.db_path)
        section = sections.get("security")
        if isinstance(section, dict) and section.get("force_setup"):
            # A machine-change reset deliberately removed the credential; don't
            # silently recreate it from the legacy env var, which would let the
            # old password authenticate while setup is still required.
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
        sections = storage.load_app_settings(self.db_path)
        section = sections.get("security")
        if isinstance(section, dict) and section.get("force_setup"):
            # A machine-change reset must leave *no* secrets behind; the new
            # credential created during setup rotates this secret anyway.
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


def _require_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SettingsError(f"{field} 不能为空")
    return value.strip()


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _coerce_datetime(value: Any, field: str) -> datetime:
    """Normalize *value* to an aware UTC datetime, raising SettingsError."""
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, str) and value.strip():
        try:
            moment = datetime.fromisoformat(value.strip())
        except ValueError as exc:
            raise SettingsError(f"{field} 不是有效时间") from exc
    else:
        raise SettingsError(f"{field} 不是有效时间")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _string_list(value: Any, *, default: list[str] | None = None) -> list[str]:
    if value is None:
        return list(default or [])
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    return list(default or [])


def _coerce_port(value: Any) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise SettingsError("port 必须是整数") from exc
    if not 1 <= port <= 65535:
        raise SettingsError("port 超出范围")
    return port


def _sanitize_host_disk_health(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    result: dict[str, Any] = {}
    if value.get("enabled") is not None:
        result["enabled"] = bool(value.get("enabled"))
    if value.get("use_sudo") is not None:
        result["use_sudo"] = bool(value.get("use_sudo"))
    storcli_path = value.get("storcli_path")
    if storcli_path:
        result["storcli_path"] = str(storcli_path)
    return result or None


def _build_host_disk_health(value: Any) -> HostDiskHealthOverride | None:
    if not isinstance(value, dict):
        return None

    def _optional_bool(key: str) -> bool | None:
        raw = value.get(key)
        return None if raw is None else bool(raw)

    storcli_path = value.get("storcli_path")
    return HostDiskHealthOverride(
        enabled=_optional_bool("enabled"),
        storcli_path=str(storcli_path) if storcli_path else None,
        use_sudo=_optional_bool("use_sudo"),
    )


_HOST_CHECK_TYPES = frozenset({"tcp", "http", "process", "service"})
_MAX_HOST_CHECKS = 20
_EXPECTED_STATUS_RE = re.compile(r"^\d{3}(-\d{3})?$")
_ALERT_RULE_RANGES = {
    "cpu_percent": (1, 100),
    "memory_percent": (1, 100),
    "disk_percent": (1, 100),
    "gpu_memory_percent": (1, 100),
    "disk_temperature_c": (1, 120),
}


def _validate_alert_rules(value: Any) -> dict[str, Any] | None:
    """Validate per-host alert rule overrides, raising ``SettingsError``."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise SettingsError("alert_rules 必须是对象")
    result: dict[str, Any] = {}
    for key, (minimum, maximum) in _ALERT_RULE_RANGES.items():
        raw = value.get(key)
        if raw is None:
            continue
        if isinstance(raw, bool):
            raise SettingsError(f"alert_rules.{key} 必须是数字")
        try:
            number = float(raw)
        except (TypeError, ValueError) as exc:
            raise SettingsError(f"alert_rules.{key} 必须是数字") from exc
        if not minimum <= number <= maximum:
            raise SettingsError(
                f"alert_rules.{key} 必须在 {minimum} 到 {maximum} 之间"
            )
        result[key] = number
    periods = value.get("consecutive_periods")
    if periods is not None:
        if isinstance(periods, bool) or not isinstance(periods, int):
            raise SettingsError("alert_rules.consecutive_periods 必须是整数")
        if not 1 <= periods <= 10:
            raise SettingsError("alert_rules.consecutive_periods 必须在 1 到 10 之间")
        result["consecutive_periods"] = periods
    return result


def _sanitize_host_checks(value: Any) -> list[dict[str, Any]]:
    """Validate and normalise a host's availability checks."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise SettingsError("checks 必须是列表")
    if len(value) > _MAX_HOST_CHECKS:
        raise SettingsError(f"checks 最多支持 {_MAX_HOST_CHECKS} 项")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise SettingsError(f"checks[{index}] 必须是对象")
        name = str(item.get("name") or "").strip()
        if not name:
            raise SettingsError(f"checks[{index}].name 不能为空")
        if len(name) > 64:
            raise SettingsError(f"checks[{index}].name 最多 64 个字符")
        folded = name.casefold()
        if folded in seen:
            raise SettingsError(f"check 名称重复: {name}")
        seen.add(folded)
        check_type = str(item.get("type") or "").strip().lower()
        if check_type not in _HOST_CHECK_TYPES:
            raise SettingsError(
                f"checks[{index}].type 必须是 tcp/http/process/service 之一"
            )
        target = str(item.get("target") or "").strip()
        if not target:
            raise SettingsError(f"checks[{index}].target 不能为空")
        if len(target) > 256:
            raise SettingsError(f"checks[{index}].target 最多 256 个字符")
        timeout_raw = item.get("timeout_seconds", 5)
        if isinstance(timeout_raw, bool) or not isinstance(timeout_raw, int):
            raise SettingsError(f"checks[{index}].timeout_seconds 必须是整数")
        if not 1 <= timeout_raw <= 30:
            raise SettingsError(f"checks[{index}].timeout_seconds 必须在 1 到 30 之间")
        expected_raw = item.get("expected")
        expected: str | None = None
        if expected_raw is not None and str(expected_raw).strip():
            expected = str(expected_raw).strip()
            if not _EXPECTED_STATUS_RE.match(expected):
                raise SettingsError(
                    f"checks[{index}].expected 必须是 200 或 200-299 这样的状态码"
                )
        result.append(
            {
                "name": name,
                "type": check_type,
                "target": target,
                "timeout_seconds": timeout_raw,
                "expected": expected,
                "enabled": bool(item.get("enabled", True)),
            }
        )
    return result


def _build_host_check(value: dict[str, Any]) -> HostCheckConfig:
    try:
        timeout_seconds = int(value.get("timeout_seconds", 5))
    except (TypeError, ValueError):
        timeout_seconds = 5
    expected = value.get("expected")
    return HostCheckConfig(
        name=str(value.get("name") or ""),
        type=str(value.get("type") or ""),
        target=str(value.get("target") or ""),
        timeout_seconds=timeout_seconds,
        expected=str(expected) if expected is not None else None,
        enabled=bool(value.get("enabled", True)),
    )


def _build_host_alert_rules(value: Any) -> HostAlertRules | None:
    if not isinstance(value, dict):
        return None

    def _optional_float(key: str) -> float | None:
        raw = value.get(key)
        if raw is None:
            return None
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None

    periods_raw = value.get("consecutive_periods")
    try:
        consecutive_periods = (
            int(periods_raw) if periods_raw is not None else None
        )
    except (TypeError, ValueError):
        consecutive_periods = None
    return HostAlertRules(
        cpu_percent=_optional_float("cpu_percent"),
        memory_percent=_optional_float("memory_percent"),
        disk_percent=_optional_float("disk_percent"),
        gpu_memory_percent=_optional_float("gpu_memory_percent"),
        disk_temperature_c=_optional_float("disk_temperature_c"),
        consecutive_periods=consecutive_periods,
    )


def _host_entry_from_config(host: HostConfig) -> dict[str, Any]:
    auth = host.auth
    disk_health: dict[str, Any] | None = None
    if host.disk_health is not None:
        disk_health = {
            "enabled": host.disk_health.enabled,
            "storcli_path": host.disk_health.storcli_path,
            "use_sudo": host.disk_health.use_sudo,
        }
    return {
        "name": host.name,
        "host": host.host,
        "port": host.port,
        "username": host.username,
        "tags": list(host.tags),
        "disk_mounts": list(host.disk_mounts),
        "auth_type": auth.type,
        "key_path": str(auth.key_path) if auth.key_path is not None else None,
        "disk_health": disk_health,
        "group": host.group,
        "owner": host.owner,
        "location": host.location,
        "notes": host.notes,
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
    }


def _new_session_secret() -> str:
    import secrets as _secrets

    return _secrets.token_urlsafe(32)
