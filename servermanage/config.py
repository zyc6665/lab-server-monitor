from __future__ import annotations

import os
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
    HostConfig,
    HostDiskHealthOverride,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
    StorageConfig,
    WebhookConfig,
    WeeklyReportConfig,
)


class ConfigError(ValueError):
    pass


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
        timezone=str(mapping.get("timezone", "Asia/Shanghai")),
    )


def _load_dashboard_auth(data: Any) -> DashboardAuthConfig:
    if data is None:
        data = {}
    mapping = _require_mapping(data, "dashboard.auth")
    password_env = mapping.get("password_env", "DASHBOARD_PASSWORD")
    return DashboardAuthConfig(
        enabled=bool(mapping.get("enabled", True)),
        username=str(mapping.get("username", "admin")),
        password_env=password_env,
        password=os.getenv(password_env) if password_env else None,
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
    )


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


def _load_smtp(data: Any) -> SMTPConfig | None:
    if data is None:
        return None
    mapping = _require_mapping(data, "smtp")
    password_env = mapping.get("password_env")
    if not password_env:
        raise ConfigError("smtp.password_env is required")
    smtp = SMTPConfig(
        host=_require_string(mapping, "host", "smtp"),
        port=int(mapping["port"]),
        username=_require_string(mapping, "username", "smtp"),
        password=_require_env(password_env),
        use_ssl=bool(mapping.get("use_ssl", True)),
        from_addr=_require_string(mapping, "from_addr", "smtp"),
        to_addrs=list(mapping.get("to_addrs") or []),
    )
    if not smtp.to_addrs:
        raise ConfigError("smtp.to_addrs must not be empty")
    return smtp


def _load_auth(data: dict[str, Any]) -> AuthConfig:
    auth_type = data.get("type")
    if auth_type == "password":
        password_env = data.get("password_env")
        if not password_env:
            raise ConfigError("password auth requires password_env")
        return AuthConfig(
            type=auth_type,
            password_env=password_env,
            password=_require_env(password_env),
        )
    if auth_type == "key":
        key_path_raw = data.get("key_path")
        if not key_path_raw:
            raise ConfigError("SSH key path does not exist")
        key_path = Path(key_path_raw).expanduser()
        if not key_path.exists():
            raise ConfigError(f"SSH key path does not exist: {key_path}")
        if not key_path.is_file():
            raise ConfigError(f"SSH key path is not a file: {key_path}")
        if not os.access(key_path, os.R_OK):
            raise ConfigError(f"SSH key path is not readable: {key_path}")
        passphrase_env = data.get("passphrase_env")
        passphrase = _require_env(passphrase_env) if passphrase_env else None
        return AuthConfig(
            type=auth_type,
            key_path=key_path,
            passphrase=passphrase,
            passphrase_env=passphrase_env,
        )
    raise ConfigError(f"Unsupported auth type: {auth_type}")


def load_config(path: str | Path) -> AppConfig:
    config_path = Path(path)
    with config_path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    raw = _require_mapping(raw, "config")

    smtp_raw = raw.get("smtp")
    smtp = _load_smtp(smtp_raw) if smtp_raw else None
    ssh_raw = _require_mapping(raw.get("ssh") or {}, "ssh")
    report_raw = _require_mapping(raw.get("report") or {}, "report")
    servers_raw = raw.get("servers") or []
    if not isinstance(servers_raw, list) or not servers_raw:
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
        HostConfig(
            name=_require_string(_require_mapping(item, "servers[]"), "name", "servers[]"),
            host=_require_string(_require_mapping(item, "servers[]"), "host", "servers[]"),
            port=int(item.get("port", 22)),
            username=_require_string(_require_mapping(item, "servers[]"), "username", "servers[]"),
            auth=_load_auth(_require_mapping(item.get("auth") or {}, "servers[].auth")),
            tags=list(item.get("tags") or []),
            disk_health=_load_host_disk(item.get("disk_health")),
        )
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
    )
