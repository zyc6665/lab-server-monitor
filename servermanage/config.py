from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

from servermanage.models import (
    AppConfig,
    AuthConfig,
    ExecutiveReportConfig,
    HostConfig,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
    StorageConfig,
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

    smtp_raw = _require_mapping(raw.get("smtp") or {}, "smtp")
    ssh_raw = _require_mapping(raw.get("ssh") or {}, "ssh")
    report_raw = _require_mapping(raw.get("report") or {}, "report")
    servers_raw = raw.get("servers") or []
    if not isinstance(servers_raw, list) or not servers_raw:
        raise ConfigError("servers must not be empty")

    password_env = smtp_raw.get("password_env")
    if not password_env:
        raise ConfigError("smtp.password_env is required")

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

    smtp = SMTPConfig(
        host=_require_string(smtp_raw, "host", "smtp"),
        port=int(smtp_raw["port"]),
        username=_require_string(smtp_raw, "username", "smtp"),
        password=_require_env(password_env),
        use_ssl=bool(smtp_raw.get("use_ssl", True)),
        from_addr=_require_string(smtp_raw, "from_addr", "smtp"),
        to_addrs=list(smtp_raw.get("to_addrs") or []),
    )
    if not smtp.to_addrs:
        raise ConfigError("smtp.to_addrs must not be empty")
    ssh = SSHRuntimeConfig(
        connect_timeout=int(ssh_raw.get("connect_timeout", 10)),
        command_timeout=int(ssh_raw.get("command_timeout", 20)),
    )
    report = ReportConfig(
        subject_prefix=report_raw.get("subject_prefix", "[Server Daily Report]"),
        include_failed_hosts=bool(report_raw.get("include_failed_hosts", True)),
        executive=executive,
        weekly=_load_weekly_report_config(report_raw.get("weekly")),
    )

    storage = _load_storage_config(raw.get("storage"))

    servers = [
        HostConfig(
            name=_require_string(_require_mapping(item, "servers[]"), "name", "servers[]"),
            host=_require_string(_require_mapping(item, "servers[]"), "host", "servers[]"),
            port=int(item.get("port", 22)),
            username=_require_string(_require_mapping(item, "servers[]"), "username", "servers[]"),
            auth=_load_auth(_require_mapping(item.get("auth") or {}, "servers[].auth")),
        )
        for item in servers_raw
    ]

    return AppConfig(smtp=smtp, ssh=ssh, report=report, servers=servers, storage=storage)
