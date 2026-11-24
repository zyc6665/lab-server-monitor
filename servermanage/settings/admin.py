"""admin credentials, machine binding and secret storage (M5: split out of ``SettingsService``)."""

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
    SECRET_ADMIN,
    SECRET_SESSION,
    SECRET_SMTP_PASSWORD,
    SECRET_WEBHOOK_URL,
    SettingsError,
    _HOST_SECRET_KEY,
    _HOST_SECRET_PASSPHRASE,
    _HOST_SECRET_PASSWORD,
    _HOST_SECRET_SUDO_PASSWORD,
    _host_entry_from_config,
    _new_session_secret,
)


class AdminMixin:
    """admin credentials, machine binding and secret storage."""

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
        if payload.get("force_setup"):
            # A machine change just wiped the secrets; re-importing plaintext
            # from the config would defeat the reset.
            return
        # Sudo support shipped after the original legacy migration.  Run its
        # own idempotent pass even when ``migrated_at`` already exists, so
        # upgrading a database created by an older release keeps working.
        if not payload.get("sudo_migrated_at"):
            try:
                self._migrate_legacy_sudo_passwords()
            except Exception as exc:  # noqa: BLE001 - migration must never block startup
                payload["sudo_migration_error"] = f"{type(exc).__name__}: {exc}"
            else:
                payload["sudo_migrated_at"] = datetime.now(timezone.utc).isoformat()
                payload.pop("sudo_migration_error", None)
            storage.save_app_settings("security", payload, self.db_path)
        if payload.get("migrated_at"):
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

    def _migrate_legacy_sudo_passwords(self) -> None:
        """Import plaintext YAML/env sudo passwords into ``app_secrets``."""
        for host in self.base_config.servers:
            if not host.sudo_password:
                continue
            secret_name = _HOST_SECRET_SUDO_PASSWORD.format(name=host.name)
            if storage.get_secret(secret_name, self.db_path) is None:
                self._store_secret(secret_name, host.sudo_password)

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
