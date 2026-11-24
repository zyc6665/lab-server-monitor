"""silence windows (M5: split out of ``SettingsService``)."""

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
    SettingsError,
    _coerce_datetime,
)


class SilencesMixin:
    """silence windows."""

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
