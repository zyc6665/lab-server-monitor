"""Validate the shipped Windows PC example configuration.

``config/config.yaml.example`` is the template users copy to
``config/config.yaml`` for the green (PyInstaller) package.  This test proves it
actually loads through :func:`servermanage.config.load_config` and that the
documented defaults (dashboard port, disk temperature threshold, polling
cadence, tray/port behaviour) are present.

Since v1.2 the template ships with an empty ``servers`` list and treats
``config/.env`` as optional: the first run seeds hosts through the browser
``/setup`` flow.  The load test therefore runs in permissive mode with every
placeholder secret removed, proving no ``.env`` file is mandatory.
"""

from __future__ import annotations

from pathlib import Path

from servermanage.config import load_config

PROJECT_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_CONFIG = PROJECT_ROOT / "config" / "config.yaml.example"
PYPROJECT = PROJECT_ROOT / "pyproject.toml"


def test_example_config_loads_with_expected_defaults(monkeypatch):
    assert EXAMPLE_CONFIG.is_file(), f"missing example config: {EXAMPLE_CONFIG}"

    # v1.2: ``config/.env`` is optional.  Clear every secret the template could
    # reference so this test proves the example loads with no .env at all.
    for name in (
        "SMTP_PASSWORD",
        "DASHBOARD_PASSWORD",
        "DASHBOARD_SECRET",
        "ALERT_WEBHOOK_URL",
        "A100_SSH_PASSWORD",
        "L40S_01_SSH_PASSWORD",
    ):
        monkeypatch.delenv(name, raising=False)

    cfg = load_config(
        EXAMPLE_CONFIG,
        allow_empty_servers=True,
        allow_missing_secrets=True,
    )

    # Controller amendment item 6: the exact values the example must declare.
    assert cfg.dashboard.port == 8080
    assert cfg.alerts.thresholds.disk_temperature_c == 55
    assert cfg.app.poll_interval_seconds == 600
    assert cfg.app.disk_poll_interval_seconds == 86400

    # v1.2 runtime behaviour documented by the template.
    assert cfg.app.auto_port_fallback is True
    assert cfg.app.tray_enabled is True
    assert cfg.app.open_browser_on_start is True

    # Disk/storage defaults the green package relies on.
    assert cfg.disk_health.enabled is True
    assert str(cfg.storage.db_path).replace("\\", "/").endswith("data/servermonitor.db")

    # No secrets are demanded and the seed host list is empty; hosts are added
    # from the browser during first-run setup.
    assert cfg.servers == []
    assert cfg.dashboard.auth.password is None
    assert cfg.smtp is not None and cfg.smtp.password == ""


def test_example_config_documents_root_and_data_mounts():
    text = EXAMPLE_CONFIG.read_text(encoding="utf-8")

    assert "disk_mounts:" in text
    assert '"/data"' in text
    assert "disk_health:" in text
    assert 'db_path: "data/servermonitor.db"' in text
    # The shipped seed intentionally carries no hosts.
    assert "servers: []" in text


def test_project_version_is_1_2_0():
    assert 'version = "1.2.0"' in PYPROJECT.read_text(encoding="utf-8")
