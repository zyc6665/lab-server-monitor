"""core service: construction, config load, setup gate (M5: split out of ``SettingsService``)."""

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
    _ALLOWED_SECTIONS,
    _host_entry_from_config,
)


class SettingsServiceBase:
    """core service: construction, config load, setup gate."""

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
