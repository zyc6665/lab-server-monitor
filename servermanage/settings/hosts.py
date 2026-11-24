"""host inventory: CRUD, import, copy, credentials (M5: split out of ``SettingsService``)."""

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
    _DEFAULT_DISK_MOUNTS,
    _HOST_AUTH_TYPES,
    _HOST_SECRET_KEY,
    _HOST_SECRET_PASSPHRASE,
    _HOST_SECRET_PASSWORD,
    _HOST_SECRET_SUDO_PASSWORD,
    _SECTION_HOSTS,
    _build_host_alert_rules,
    _build_host_check,
    _build_host_disk_health,
    _coerce_port,
    _host_entry_from_config,
    _optional_text,
    _require_bool,
    _require_text,
    _sanitize_host_checks,
    _sanitize_host_disk_health,
    _string_list,
    _tri_state_bool,
    _tri_state_bool_lenient,
    _validate_alert_rules,
)


class HostsMixin:
    """host inventory: CRUD, import, copy, credentials."""

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
        if "user_monitoring" in payload:
            user_monitoring = _tri_state_bool(payload.get("user_monitoring"))
        else:
            user_monitoring = (existing_entry or {}).get("user_monitoring")
        if "allow_user_write" in payload:
            allow_user_write = _require_bool(
                payload.get("allow_user_write"), "允许账号写操作"
            )
        else:
            allow_user_write = bool((existing_entry or {}).get("allow_user_write"))

        # Validate every secret before the first write so a bad sudo value cannot
        # leave a partially written SSH credential behind.
        self._validated_sudo_password(payload)
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
            "user_monitoring": user_monitoring,
            "allow_user_write": allow_user_write,
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
        storage.delete_host_check_results(name, self.db_path)
        storage.delete_host_user_data(name, self.db_path)
        # The host is gone: its rows will never be scanned again, so open user
        # alerts must not linger as permanent active alerts.
        storage.close_alerts_for_host(name, self.db_path, category="user")
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

    @staticmethod
    def _validated_sudo_password(payload: dict[str, Any]) -> str | None:
        """Return a validated sudo password without persisting it."""
        raw = payload.get("sudo_password")
        if raw is None:
            return None
        text = str(raw)
        if text == "":
            return None
        if "\n" in text or "\r" in text:
            raise SettingsError("sudo 密码不能包含换行符")
        if len(text.encode("utf-8")) > 256:
            raise SettingsError("sudo 密码最多 256 字节")
        return text

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
        text = self._validated_sudo_password(payload)
        if text is None:
            return
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
        base_by_name = {host.name: host for host in self.base_config.servers}
        return [
            self._public_host_entry(entry, base_host=base_by_name.get(str(entry.get("name") or "")))
            for entry in entries
        ]

    def _public_host_entry(
        self, entry: dict[str, Any], *, base_host: HostConfig | None = None
    ) -> dict[str, Any]:
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
            "user_monitoring": _tri_state_bool_lenient(entry.get("user_monitoring")),
            "allow_user_write": bool(entry.get("allow_user_write")),
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
                or (
                    not self.is_writable()
                    and bool(base_host and base_host.sudo_password)
                )
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
                    user_monitoring=_tri_state_bool_lenient(
                        entry.get("user_monitoring")
                    ),
                    allow_user_write=bool(entry.get("allow_user_write")),
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
