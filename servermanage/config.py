from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml

from servermanage.models import (
    AlertsConfig,
    AlertThresholds,
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DashboardAuthConfig,
    DashboardConfig,
    DiskHealthConfig,
    DiskHealthRuleConfig,
    ExecutiveReportConfig,
    HostAlertRules,
    HostCheckConfig,
    HostConfig,
    HostDiskHealthOverride,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
    StorageConfig,
    UserMonitoringConfig,
    WebhookConfig,
    WeeklyReportConfig,
)


class ConfigError(ValueError):
    pass


_MAX_HOST_CHECKS = 20
_EXPECTED_STATUS_RE = re.compile(r"^\d{3}(-\d{3})?$")
_USER_MONITORING_RANGES = {
    "scan_interval_seconds": (300, 86400),
    "usage_interval_seconds": (3600, 604800),
    "command_timeout": (10, 600),
}
_ALERT_RULE_RANGES = {
    "cpu_percent": (1, 100),
    "memory_percent": (1, 100),
    "disk_percent": (1, 100),
    "gpu_memory_percent": (1, 100),
    "disk_temperature_c": (1, 120),
}


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ConfigError(f"Missing required environment variable: {name}")
    return value


def _require_mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{name} must be a mapping")
    return value


def _require_string(mapping: dict[str, Any], key: str, section: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{section}.{key} is required")
    return value.strip()


def _load_weekly_report_config(data: Any) -> WeeklyReportConfig:
    if data is None:
        return WeeklyReportConfig()
    mapping = _require_mapping(data, "report.weekly")
    return WeeklyReportConfig(
        enabled=bool(mapping.get("enabled", True)),
        subject_prefix=str(mapping.get("subject_prefix", "[Server Weekly Report]")),
        busy_threshold=float(mapping.get("busy_threshold", 70.0)),
        idle_threshold=float(mapping.get("idle_threshold", 20.0)),
        time=str(mapping.get("time", "16:00")),
        weekday=int(mapping.get("weekday", 4)),
    )


def _load_storage_config(data: Any) -> StorageConfig:
    if data is None:
        return StorageConfig()
    mapping = _require_mapping(data, "storage")
    db_path_raw = mapping.get("db_path", "data/servermanage.db")
    return StorageConfig(
        enabled=bool(mapping.get("enabled", True)),
        db_path=Path(str(db_path_raw)).expanduser(),
    )


def _load_app(data: Any) -> AppRuntimeConfig:
    if data is None:
        return AppRuntimeConfig()
    mapping = _require_mapping(data, "app")
    return AppRuntimeConfig(
        poll_interval_seconds=int(mapping.get("poll_interval_seconds", 600)),
        disk_poll_interval_seconds=int(mapping.get("disk_poll_interval_seconds", 86400)),
        concurrency=int(mapping.get("concurrency", 8)),
        retention_days=int(mapping.get("retention_days", 90)),
        host_metrics_max_points=int(mapping.get("host_metrics_max_points", 100)),
        disk_health_retention_days=int(mapping.get("disk_health_retention_days", 7)),
        disk_health_max_batches=int(mapping.get("disk_health_max_batches", 100)),
        host_daily_summary_retention_days=int(
            mapping.get("host_daily_summary_retention_days", 90)
        ),
        alert_history_retention_days=int(
            mapping.get("alert_history_retention_days", 30)
        ),
        ssh_audit_retention_days=int(mapping.get("ssh_audit_retention_days", 30)),
        timezone=str(mapping.get("timezone", "Asia/Shanghai")),
        auto_port_fallback=bool(mapping.get("auto_port_fallback", True)),
        tray_enabled=bool(mapping.get("tray_enabled", True)),
        open_browser_on_start=bool(mapping.get("open_browser_on_start", True)),
    )


def _load_dashboard_auth(data: Any) -> DashboardAuthConfig:
    if data is None:
        data = {}
    mapping = _require_mapping(data, "dashboard.auth")
    password_env = mapping.get("password_env", "DASHBOARD_PASSWORD")
    password_hash = mapping.get("password_hash")
    password_salt = mapping.get("password_salt")
    return DashboardAuthConfig(
        enabled=bool(mapping.get("enabled", True)),
        username=str(mapping.get("username", "admin")),
        password_env=password_env,
        password=os.getenv(password_env) if password_env else None,
        password_hash=str(password_hash) if password_hash is not None else None,
        password_salt=str(password_salt) if password_salt is not None else None,
        password_iterations=int(mapping.get("password_iterations", 200000)),
    )


def _load_dashboard(data: Any) -> DashboardConfig:
    if data is None:
        # No dashboard section: still build defaults so env-backed secrets
        # (DASHBOARD_PASSWORD / DASHBOARD_SECRET) are picked up.
        data = {}
    mapping = _require_mapping(data, "dashboard")
    session_secret_env = str(mapping.get("session_secret_env", "DASHBOARD_SECRET"))
    return DashboardConfig(
        host=str(mapping.get("host", "0.0.0.0")),
        port=int(mapping.get("port", 8080)),
        auth=_load_dashboard_auth(mapping.get("auth")),
        session_secret_env=session_secret_env,
        session_secret=os.getenv(session_secret_env) if session_secret_env else None,
        session_lifetime_hours=int(mapping.get("session_lifetime_hours", 12)),
    )


def _load_thresholds(data: Any) -> AlertThresholds:
    if data is None:
        return AlertThresholds()
    mapping = _require_mapping(data, "alerts.thresholds")
    return AlertThresholds(
        cpu_percent=float(mapping.get("cpu_percent", 90)),
        memory_percent=float(mapping.get("memory_percent", 90)),
        disk_percent=float(mapping.get("disk_percent", 90)),
        gpu_memory_percent=float(mapping.get("gpu_memory_percent", 90)),
        disk_temperature_c=float(mapping.get("disk_temperature_c", 55)),
    )


def _load_webhook(data: Any) -> WebhookConfig:
    if data is None:
        # No webhook section: still build defaults so ALERT_WEBHOOK_URL is read.
        data = {}
    mapping = _require_mapping(data, "alerts.webhook")
    url_env = mapping.get("url_env", "ALERT_WEBHOOK_URL")
    return WebhookConfig(
        enabled=bool(mapping.get("enabled", False)),
        type=str(mapping.get("type", "wecom")),
        url_env=url_env,
        url=os.getenv(url_env) if url_env else None,
    )


def _load_alerts(data: Any) -> AlertsConfig:
    if data is None:
        # No alerts section: still build defaults so webhook env is read.
        data = {}
    mapping = _require_mapping(data, "alerts")
    return AlertsConfig(
        enabled=bool(mapping.get("enabled", True)),
        desktop_notification=bool(mapping.get("desktop_notification", True)),
        email=bool(mapping.get("email", True)),
        webhook=_load_webhook(mapping.get("webhook")),
        thresholds=_load_thresholds(mapping.get("thresholds")),
        cooldown_minutes=int(mapping.get("cooldown_minutes", 60)),
        repeat_while_active=bool(mapping.get("repeat_while_active", False)),
        offline_failures=int(mapping.get("offline_failures", 2)),
        aggregate_by_host=bool(mapping.get("aggregate_by_host", True)),
        notify_on_recovery=bool(mapping.get("notify_on_recovery", True)),
        consecutive_periods=_load_consecutive_periods(mapping.get("consecutive_periods")),
    )


def _load_consecutive_periods(value: Any) -> int:
    """Return a 1..10 period count, clamping out-of-range numbers."""
    if value is None:
        return 2
    if isinstance(value, bool):
        raise ConfigError("alerts.consecutive_periods must be an integer")
    try:
        periods = int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError("alerts.consecutive_periods must be an integer") from exc
    return max(1, min(10, periods))


def _load_disk_health_rules(data: Any) -> DiskHealthRuleConfig:
    if data is None:
        return DiskHealthRuleConfig()
    mapping = _require_mapping(data, "disk_health.rules")
    return DiskHealthRuleConfig(
        alert_on_media_errors=bool(mapping.get("alert_on_media_errors", True)),
        alert_on_other_errors=bool(mapping.get("alert_on_other_errors", True)),
        alert_on_predictive_failure=bool(mapping.get("alert_on_predictive_failure", True)),
        alert_on_smart_flag=bool(mapping.get("alert_on_smart_flag", True)),
        alert_on_state_not_optimal=bool(mapping.get("alert_on_state_not_optimal", True)),
        alert_on_error_increase=bool(mapping.get("alert_on_error_increase", True)),
    )


def _load_disk_health(data: Any) -> DiskHealthConfig:
    if data is None:
        return DiskHealthConfig()
    mapping = _require_mapping(data, "disk_health")
    rules_raw = mapping.get("rules")
    if rules_raw is None:
        # Allow rule keys flattened directly under the disk_health section.
        rules_raw = mapping
    candidates_raw = mapping.get("storcli_candidates")
    if candidates_raw is None:
        candidates = DiskHealthConfig().storcli_candidates
    else:
        candidates = tuple(str(item) for item in candidates_raw)
    return DiskHealthConfig(
        enabled=bool(mapping.get("enabled", True)),
        use_sudo=bool(mapping.get("use_sudo", True)),
        storcli_candidates=candidates,
        rules=_load_disk_health_rules(rules_raw),
    )


def _load_user_monitoring(data: Any) -> UserMonitoringConfig:
    """Parse the optional global ``user_monitoring`` mapping."""
    if data is None:
        return UserMonitoringConfig()
    mapping = _require_mapping(data, "user_monitoring")
    defaults = UserMonitoringConfig()
    enabled = mapping.get("enabled", defaults.enabled)
    if not isinstance(enabled, bool):
        raise ConfigError("user_monitoring.enabled must be a boolean")
    values: dict[str, Any] = {"enabled": enabled}
    for key, (minimum, maximum) in _USER_MONITORING_RANGES.items():
        raw = mapping.get(key, getattr(defaults, key))
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise ConfigError(f"user_monitoring.{key} must be an integer")
        if not minimum <= raw <= maximum:
            raise ConfigError(
                f"user_monitoring.{key} must be between {minimum} and {maximum}"
            )
        values[key] = raw
    return UserMonitoringConfig(**values)


def _load_host_user_monitoring(value: Any) -> bool | None:
    """Parse ``servers[].user_monitoring`` (``None`` inherits the global setting)."""
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ConfigError("servers[].user_monitoring must be a boolean")
    return value


def _load_host_disk(data: Any) -> HostDiskHealthOverride | None:
    if data is None:
        return None
    mapping = _require_mapping(data, "servers[].disk_health")

    def _optional_bool(key: str) -> bool | None:
        value = mapping.get(key)
        return None if value is None else bool(value)

    storcli_path = mapping.get("storcli_path")
    return HostDiskHealthOverride(
        enabled=_optional_bool("enabled"),
        storcli_path=str(storcli_path) if storcli_path is not None else None,
        use_sudo=_optional_bool("use_sudo"),
    )


def _load_host_checks(data: Any) -> list[HostCheckConfig]:
    """Parse and validate the ``servers[].checks`` list from YAML."""
    if data is None:
        return []
    if not isinstance(data, list):
        raise ConfigError("servers[].checks must be a list")
    if len(data) > _MAX_HOST_CHECKS:
        raise ConfigError(
            f"servers[].checks supports at most {_MAX_HOST_CHECKS} entries"
        )
    checks: list[HostCheckConfig] = []
    seen: set[str] = set()
    for index, item in enumerate(data):
        label = f"servers[].checks[{index}]"
        mapping = _require_mapping(item, label)
        name = _require_string(mapping, "name", label)
        if len(name) > 64:
            raise ConfigError(f"{label}.name must be at most 64 characters")
        folded = name.casefold()
        if folded in seen:
            raise ConfigError(f"{label}.name duplicates another check: {name}")
        seen.add(folded)
        check_type = _require_string(mapping, "type", label)
        target = _require_string(mapping, "target", label)
        timeout_raw = mapping.get("timeout_seconds", 5)
        if isinstance(timeout_raw, bool):
            raise ConfigError(f"{label}.timeout_seconds must be an integer")
        try:
            timeout_seconds = int(timeout_raw)
        except (TypeError, ValueError) as exc:
            raise ConfigError(
                f"{label}.timeout_seconds must be an integer"
            ) from exc
        if not 1 <= timeout_seconds <= 30:
            raise ConfigError(f"{label}.timeout_seconds must be between 1 and 30")
        expected_raw = mapping.get("expected")
        expected: str | None = None
        if expected_raw is not None:
            expected = str(expected_raw)
            if not _EXPECTED_STATUS_RE.match(expected):
                raise ConfigError(
                    f"{label}.expected must be a status code or range (e.g. 200 or 200-299)"
                )
        checks.append(
            HostCheckConfig(
                name=name,
                type=check_type,
                target=target,
                timeout_seconds=timeout_seconds,
                expected=expected,
                enabled=bool(mapping.get("enabled", True)),
            )
        )
    return checks


def _load_host_alert_rules(data: Any) -> HostAlertRules | None:
    """Parse the optional ``servers[].alert_rules`` mapping."""
    if data is None:
        return None
    mapping = _require_mapping(data, "servers[].alert_rules")
    values: dict[str, float | int | None] = {}
    for key, (minimum, maximum) in _ALERT_RULE_RANGES.items():
        raw = mapping.get(key)
        if raw is None:
            values[key] = None
            continue
        if isinstance(raw, bool):
            raise ConfigError(f"servers[].alert_rules.{key} must be a number")
        try:
            number = float(raw)
        except (TypeError, ValueError) as exc:
            raise ConfigError(
                f"servers[].alert_rules.{key} must be a number"
            ) from exc
        if not minimum <= number <= maximum:
            raise ConfigError(
                f"servers[].alert_rules.{key} must be between {minimum} and {maximum}"
            )
        values[key] = number
    periods_raw = mapping.get("consecutive_periods")
    if periods_raw is None:
        values["consecutive_periods"] = None
    else:
        if isinstance(periods_raw, bool) or not isinstance(periods_raw, int):
            raise ConfigError(
                "servers[].alert_rules.consecutive_periods must be an integer"
            )
        if not 1 <= periods_raw <= 10:
            raise ConfigError(
                "servers[].alert_rules.consecutive_periods must be between 1 and 10"
            )
        values["consecutive_periods"] = periods_raw
    return HostAlertRules(**values)


def _load_host_sudo_password(
    mapping: dict[str, Any], *, allow_missing_secrets: bool = False
) -> str | None:
    """Resolve a host sudo password, preferring ``sudo_password_env``."""
    env_name = mapping.get("sudo_password_env")
    if env_name:
        env_value = os.getenv(str(env_name))
        if env_value:
            return env_value
    direct = mapping.get("sudo_password")
    if direct is None:
        return None
    text = str(direct)
    return text or None


def _load_smtp(data: Any, *, allow_missing_secrets: bool = False) -> SMTPConfig | None:
    if data is None:
        return None
    mapping = _require_mapping(data, "smtp")
    password_env = mapping.get("password_env")
    if not password_env:
        raise ConfigError("smtp.password_env is required")
    if allow_missing_secrets:
        password = os.getenv(password_env) or ""
    else:
        password = _require_env(password_env)
    smtp = SMTPConfig(
        host=_require_string(mapping, "host", "smtp"),
        port=int(mapping["port"]),
        username=_require_string(mapping, "username", "smtp"),
        password=password,
        use_ssl=bool(mapping.get("use_ssl", True)),
        from_addr=_require_string(mapping, "from_addr", "smtp"),
        to_addrs=list(mapping.get("to_addrs") or []),
    )
    if not smtp.to_addrs:
        raise ConfigError("smtp.to_addrs must not be empty")
    return smtp


def _load_auth(data: dict[str, Any], *, allow_missing_secrets: bool = False) -> AuthConfig:
    auth_type = data.get("type")
    if auth_type == "password":
        password_env = data.get("password_env")
        if not password_env:
            raise ConfigError("password auth requires password_env")
        if allow_missing_secrets:
            password = os.getenv(password_env)
        else:
            password = _require_env(password_env)
        return AuthConfig(
            type=auth_type,
            password_env=password_env,
            password=password,
        )
    if auth_type == "key":
        key_data = data.get("key_data")
        passphrase_env = data.get("passphrase_env")
        if passphrase_env:
            passphrase = os.getenv(passphrase_env) if allow_missing_secrets else _require_env(passphrase_env)
        else:
            passphrase = None
        key_path_raw = data.get("key_path")
        if not key_path_raw:
            if key_data is not None:
                return AuthConfig(
                    type=auth_type,
                    key_data=key_data,
                    passphrase=passphrase,
                    passphrase_env=passphrase_env,
                )
            if allow_missing_secrets:
                return AuthConfig(type=auth_type)
            raise ConfigError("SSH key path does not exist")
        key_path = Path(key_path_raw).expanduser()
        if allow_missing_secrets and (
            not key_path.exists() or not key_path.is_file() or not os.access(key_path, os.R_OK)
        ):
            # A packaged instance may be copied to another PC where the seeded
            # key path does not exist.  Start anyway so the browser settings
            # page can be used to supply a fresh key/password.
            return AuthConfig(
                type=auth_type,
                key_path=key_path,
                passphrase=passphrase,
                passphrase_env=passphrase_env,
                key_data=key_data,
            )
        if not key_path.exists():
            raise ConfigError(f"SSH key path does not exist: {key_path}")
        if not key_path.is_file():
            raise ConfigError(f"SSH key path is not a file: {key_path}")
        if not os.access(key_path, os.R_OK):
            raise ConfigError(f"SSH key path is not readable: {key_path}")
        return AuthConfig(
            type=auth_type,
            key_path=key_path,
            passphrase=passphrase,
            passphrase_env=passphrase_env,
            key_data=key_data,
        )
    raise ConfigError(f"Unsupported auth type: {auth_type}")


def _load_host(item: Any, *, allow_missing_secrets: bool = False) -> HostConfig:
    mapping = _require_mapping(item, "servers[]")
    return HostConfig(
        name=_require_string(mapping, "name", "servers[]"),
        host=_require_string(mapping, "host", "servers[]"),
        port=int(mapping.get("port", 22)),
        username=_require_string(mapping, "username", "servers[]"),
        auth=_load_auth(
            _require_mapping(mapping.get("auth") or {}, "servers[].auth"),
            allow_missing_secrets=allow_missing_secrets,
        ),
        tags=list(mapping.get("tags") or []),
        disk_health=_load_host_disk(mapping.get("disk_health")),
        disk_mounts=list(mapping.get("disk_mounts") or ["/", "/data"]),
        group=str(mapping.get("group") or "未分组"),
        owner=str(mapping.get("owner") or ""),
        location=str(mapping.get("location") or ""),
        notes=str(mapping.get("notes") or ""),
        checks=_load_host_checks(mapping.get("checks")),
        alert_rules=_load_host_alert_rules(mapping.get("alert_rules")),
        user_monitoring=_load_host_user_monitoring(mapping.get("user_monitoring")),
        sudo_password=_load_host_sudo_password(
            mapping, allow_missing_secrets=allow_missing_secrets
        ),
    )


def load_config_from_mapping(
    raw: dict[str, Any],
    *,
    allow_empty_servers: bool = False,
    allow_missing_secrets: bool = False,
) -> AppConfig:
    raw = _require_mapping(raw, "config")

    smtp_raw = raw.get("smtp")
    smtp = _load_smtp(smtp_raw, allow_missing_secrets=allow_missing_secrets) if smtp_raw else None
    ssh_raw = _require_mapping(raw.get("ssh") or {}, "ssh")
    report_raw = _require_mapping(raw.get("report") or {}, "report")
    servers_raw = raw.get("servers") or []
    if not isinstance(servers_raw, list):
        raise ConfigError("servers must not be empty")
    if not servers_raw and not allow_empty_servers:
        raise ConfigError("servers must not be empty")

    executive = None
    executive_raw = report_raw.get("executive")
    if executive_raw is not None:
        executive_mapping = _require_mapping(executive_raw, "report.executive")
        executive_enabled = bool(executive_mapping.get("enabled", False))
        executive_to_addrs = list(executive_mapping.get("to_addrs") or [])
        if executive_enabled and not executive_to_addrs:
            raise ConfigError("report.executive.to_addrs must not be empty")
        executive = ExecutiveReportConfig(
            enabled=executive_enabled,
            subject_prefix=str(
                executive_mapping.get("subject_prefix", report_raw.get("subject_prefix", "[Leader Summary]"))
            ),
            to_addrs=executive_to_addrs,
        )

    ssh = SSHRuntimeConfig(
        connect_timeout=int(ssh_raw.get("connect_timeout", 10)),
        command_timeout=int(ssh_raw.get("command_timeout", 20)),
    )
    report = ReportConfig(
        subject_prefix=report_raw.get("subject_prefix", "[Server Daily Report]"),
        include_failed_hosts=bool(report_raw.get("include_failed_hosts", True)),
        executive=executive,
        weekly=_load_weekly_report_config(report_raw.get("weekly")),
        daily_enabled=bool(report_raw.get("daily_enabled", True)),
        daily_time=str(report_raw.get("daily_time", "09:00")),
    )

    storage = _load_storage_config(raw.get("storage"))
    app_cfg = _load_app(raw.get("app"))
    dashboard = _load_dashboard(raw.get("dashboard"))
    alerts_cfg = _load_alerts(raw.get("alerts"))
    disk_cfg = _load_disk_health(raw.get("disk_health"))

    servers = [
        _load_host(item, allow_missing_secrets=allow_missing_secrets)
        for item in servers_raw
    ]

    return AppConfig(
        smtp=smtp,
        ssh=ssh,
        report=report,
        servers=servers,
        storage=storage,
        app=app_cfg,
        dashboard=dashboard,
        alerts=alerts_cfg,
        disk_health=disk_cfg,
        user_monitoring=_load_user_monitoring(raw.get("user_monitoring")),
    )


def load_config(
    path: str | Path,
    *,
    allow_empty_servers: bool = False,
    allow_missing_secrets: bool = False,
) -> AppConfig:
    config_path = Path(path)
    with config_path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    return load_config_from_mapping(
        raw,
        allow_empty_servers=allow_empty_servers,
        allow_missing_secrets=allow_missing_secrets,
    )
