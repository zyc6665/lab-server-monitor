"""Settings schema helpers and defaults (M5: split out of ``settings.py``)."""

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
    "SECTION_USER_MONITORING",
    "SECTION_NAMES",
    "SECRET_SMTP_PASSWORD",
    "SECRET_WEBHOOK_URL",
    "SECRET_ADMIN",
    "SECRET_SESSION",
]


SECTION_MONITORING = "monitoring"


SECTION_DASHBOARD = "dashboard"


SECTION_ALERTS = "alerts"


SECTION_REPORT = "report"


SECTION_DISK_HEALTH = "disk_health"


SECTION_SSH = "ssh"


SECTION_SMTP = "smtp"


SECTION_USER_MONITORING = "user_monitoring"


SECTION_NAMES = (
    SECTION_MONITORING,
    SECTION_DASHBOARD,
    SECTION_ALERTS,
    SECTION_REPORT,
    SECTION_DISK_HEALTH,
    SECTION_SSH,
    SECTION_SMTP,
    SECTION_USER_MONITORING,
)


_ALLOWED_SECTIONS = frozenset(SECTION_NAMES)


SECRET_SMTP_PASSWORD = "smtp:password"


SECRET_WEBHOOK_URL = "webhook:url"


SECRET_ADMIN = "dashboard:admin_password"


SECRET_SESSION = "dashboard:session_secret"


_HOST_SECRET_PASSWORD = "host:{name}:ssh_password"


_HOST_SECRET_KEY = "host:{name}:ssh_key"


_HOST_SECRET_PASSPHRASE = "host:{name}:ssh_passphrase"


_HOST_SECRET_SUDO_PASSWORD = "host:{name}:sudo_password"


_SECTION_HOSTS = "hosts"


_HOST_AUTH_TYPES = frozenset({"password", "key"})


_DEFAULT_DISK_MOUNTS = ["/", "/data"]


_USER_MONITORING_RANGES = {
    "scan_interval_seconds": (300, 86400),
    "usage_interval_seconds": (3600, 604800),
    "usage_timeout_seconds": (60, 7200),
    "command_timeout": (10, 600),
}


_MONITORING_INT_RANGES = {
    "host_metrics_max_points": (10, 10000),
    "disk_health_retention_days": (1, 365),
    "disk_health_max_batches": (1, 1000),
    "host_daily_summary_retention_days": (7, 3650),
    "alert_history_retention_days": (1, 3650),
    "ssh_audit_retention_days": (1, 3650),
}


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


_DASHBOARD_AUTH_FIELDS = frozenset({"enabled", "username", "password_env"})


class SettingsError(ValueError):
    """Raised when a settings operation is invalid (bad section/payload/secret)."""


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


def _tri_state_bool(value: Any) -> bool | None:
    """Coerce a JSON/YAML value into ``True`` / ``False`` / ``None`` (inherit)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("", "inherit", "none", "null", "default"):
            return None
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off"):
            return False
    raise SettingsError(f"user_monitoring 必须是 true/false 或留空: {value!r}")


def _tri_state_bool_lenient(value: Any) -> bool | None:
    try:
        return _tri_state_bool(value)
    except SettingsError:
        return None


def _require_bool(value: Any, label: str) -> bool:
    """Strict boolean for safety switches: never guess from strings."""
    if isinstance(value, bool):
        return value
    raise SettingsError(f"{label}必须是 true 或 false")


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


def _validate_consecutive_periods(value: Any) -> int:
    """Validate the global consecutive-period threshold."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise SettingsError("alerts.consecutive_periods 必须是整数")
    if not 1 <= value <= 10:
        raise SettingsError("alerts.consecutive_periods 必须在 1 到 10 之间")
    return value


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
        try:
            validate_check_target(check_type, target)
        except ValueError as exc:
            raise SettingsError(f"checks[{index}].target 非法: {exc}") from None
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
        "user_monitoring": host.user_monitoring,
        "allow_user_write": host.allow_user_write,
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
