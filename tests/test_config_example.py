"""Validate the shipped Windows PC example configuration.

``config/config.yaml.example`` is the template users copy to
``config/config.yaml`` for the green (PyInstaller) package.  This test proves it
actually loads through :func:`servermanage.config.load_config` and that the
documented defaults (dashboard port, disk temperature threshold, polling
cadence) are present.  All ``*_env`` references are satisfied with dummy values
so the test never depends on a real secret or SSH key file.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from servermanage.config import load_config

PROJECT_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_CONFIG = PROJECT_ROOT / "config" / "config.yaml.example"


def test_example_config_loads_with_expected_defaults(monkeypatch):
    assert EXAMPLE_CONFIG.is_file(), f"missing example config: {EXAMPLE_CONFIG}"

    # Every environment variable referenced by the example config (``*_env``)
    # gets a harmless placeholder so load_config can resolve it.
    for name in (
        "SMTP_PASSWORD",
        "DASHBOARD_PASSWORD",
        "DASHBOARD_SECRET",
        "ALERT_WEBHOOK_URL",
        "A100_SSH_PASSWORD",
        "L40S_01_SSH_PASSWORD",
    ):
        monkeypatch.setenv(name, f"dummy-{name.lower()}")

    cfg = load_config(EXAMPLE_CONFIG)

    # Controller amendment item 6: the exact values the example must declare.
    assert cfg.dashboard.port == 8080
    assert cfg.alerts.thresholds.disk_temperature_c == 55
    assert cfg.app.poll_interval_seconds == 600
    assert cfg.app.disk_poll_interval_seconds == 86400
    assert len(cfg.servers) >= 1

    # The PC example must use password auth (no key file / passphrase needed).
    assert all(server.auth.type == "password" for server in cfg.servers)

    # Named host + disk-health enablement required by the brief.
    assert any(server.name == "a100" for server in cfg.servers)
    assert cfg.disk_health.enabled is True
    assert str(cfg.storage.db_path).replace("\\", "/").endswith("data/servermonitor.db")
