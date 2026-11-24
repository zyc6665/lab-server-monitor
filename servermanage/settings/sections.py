"""settings sections: public payload and save/apply (M5: split out of ``SettingsService``)."""

from __future__ import annotations

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
from servermanage import security, storage, usermode as user_mode
from servermanage.availability import validate_check_target
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
    UserMonitoringConfig,
)

from servermanage.settings.schema import (
    SECRET_SMTP_PASSWORD,
    SECRET_WEBHOOK_URL,
    SECTION_ALERTS,
    SECTION_DASHBOARD,
    SECTION_DISK_HEALTH,
    SECTION_MONITORING,
    SECTION_REPORT,
    SECTION_SMTP,
    SECTION_SSH,
    SECTION_USER_MONITORING,
    SettingsError,
    _ALERT_TOP_FIELDS,
    _ALLOWED_SECTIONS,
    _DASHBOARD_AUTH_FIELDS,
    _DASHBOARD_TOP_FIELDS,
    _DISK_TOP_FIELDS,
    _MONITORING_INT_RANGES,
    _REPORT_FIELDS,
    _RULE_FIELDS,
    _SMTP_FIELDS,
    _THRESHOLD_FIELDS,
    _USER_MONITORING_RANGES,
    _WEBHOOK_FIELDS,
    _WEEKLY_FIELDS,
    _flat,
    _require_bool,
    _validate_consecutive_periods,
)


class SectionsMixin:
    """settings sections: public payload and save/apply."""

    def save_section(self, section: str, payload: dict[str, Any]) -> AppConfig:
        """Persist one settings section and return the newly composed config."""
        if section not in _ALLOWED_SECTIONS:
            raise SettingsError(f"unknown settings section: {section}")
        if not isinstance(payload, dict):
            raise SettingsError("settings payload must be an object")
        if not self.is_writable():
            raise SettingsError("settings are not writable on this platform")
        sanitized = deepcopy(payload)
        if section == SECTION_USER_MONITORING:
            # The card posts only its own fields; merge so a partial save cannot
            # silently reset the intervals it did not touch back to defaults.
            stored = storage.load_app_settings(self.db_path).get(
                SECTION_USER_MONITORING
            )
            if isinstance(stored, dict):
                merged = dict(stored)
                merged.update(sanitized)
                sanitized = merged
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
                "mode": config.app.mode,
                "member_account": config.app.member_account,
            },
            "user_monitoring": {
                "enabled": config.user_monitoring.enabled,
                "scan_interval_seconds": config.user_monitoring.scan_interval_seconds,
                "usage_interval_seconds": config.user_monitoring.usage_interval_seconds,
                "usage_timeout_seconds": config.user_monitoring.usage_timeout_seconds,
                "command_timeout": config.user_monitoring.command_timeout,
                "write_enabled": config.user_monitoring.write_enabled,
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
                "host_key_policy": config.ssh.host_key_policy,
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

    def _apply_section(
        self, config: AppConfig, section: str, payload: dict[str, Any]
    ) -> AppConfig:
        if section == SECTION_MONITORING:
            data = dict(payload)
            if "mode" in data or "member_account" in data:
                try:
                    mode, member = user_mode.validate_mode(
                        data.get("mode", config.app.mode),
                        data.get("member_account", config.app.member_account),
                    )
                except user_mode.ModeError as exc:
                    raise SettingsError(str(exc)) from None
                data["mode"] = mode
                data["member_account"] = member
            app = _flat(config.app, data)
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
        if section == SECTION_USER_MONITORING:
            return replace(
                config,
                user_monitoring=self._apply_user_monitoring(
                    config.user_monitoring, payload
                ),
            )
        raise SettingsError(f"unknown settings section: {section}")

    def _apply_user_monitoring(
        self, current: UserMonitoringConfig, payload: dict[str, Any]
    ) -> UserMonitoringConfig:
        """Validate the user-scan cadence so the scheduler cannot be hammered.

        A missing key keeps the current value: the settings page posts only the
        fields it renders, and a partial payload must not silently reset the
        other intervals to their defaults.
        """
        data = {"enabled": current.enabled}
        if "enabled" in payload:
            enabled = payload.get("enabled")
            if not isinstance(enabled, bool):
                raise SettingsError("启用服务器用户采集必须是布尔值")
            data["enabled"] = enabled
        data["write_enabled"] = current.write_enabled
        if "write_enabled" in payload:
            data["write_enabled"] = _require_bool(
                payload.get("write_enabled"), "允许账号写操作"
            )
        labels = {
            "scan_interval_seconds": "账号扫描间隔",
            "usage_interval_seconds": "占用统计间隔",
            "usage_timeout_seconds": "占用统计超时",
            "command_timeout": "单次命令超时",
        }
        for key, (minimum, maximum) in _USER_MONITORING_RANGES.items():
            if key not in payload:
                data[key] = getattr(current, key)
                continue
            raw = payload.get(key)
            if isinstance(raw, bool) or not isinstance(raw, int):
                raise SettingsError(f"{labels[key]}必须是整数")
            if not minimum <= raw <= maximum:
                raise SettingsError(
                    f"{labels[key]}必须在 {minimum} 到 {maximum} 之间"
                )
            data[key] = raw
        return UserMonitoringConfig(**data)

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
        try:
            user_mode.validate_mode(app.mode, app.member_account)
        except user_mode.ModeError as exc:
            raise SettingsError(str(exc)) from None

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
        if "consecutive_periods" in payload:
            _validate_consecutive_periods(payload.get("consecutive_periods"))
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
        """Validate alert fields and move a provided webhook URL to secrets."""
        if "consecutive_periods" in payload:
            payload["consecutive_periods"] = _validate_consecutive_periods(
                payload.get("consecutive_periods")
            )
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
