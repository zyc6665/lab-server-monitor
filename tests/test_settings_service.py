"""Tests for :class:`servermanage.settings.SettingsService`.

Task 5 scope: effective config synthesis (YAML base + SQLite overrides) and the
public settings payload. Host CRUD/admin password behaviour is added in Task 6.
"""

from __future__ import annotations

import pytest

from servermanage import security, storage
from servermanage.settings import (
    SECRET_ADMIN,
    SECRET_SESSION,
    SECRET_SMTP_PASSWORD,
    SECRET_WEBHOOK_URL,
    SettingsError,
    SettingsService,
)


def _service(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\nreport:\n  subject_prefix: '[D]'\n", encoding="utf-8")
    db = tmp_path / "monitor.db"
    return SettingsService(config_path=cfg, db_path=db)


def test_empty_servers_start_with_setup_required(tmp_path, monkeypatch):
    monkeypatch.delenv("DASHBOARD_PASSWORD", raising=False)
    svc = _service(tmp_path)
    assert svc.setup_required() is True
    assert svc.load().servers == []


def test_save_report_section_persists_and_loads(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section("report", {"daily_enabled": False, "daily_time": "08:30",
                                      "weekly": {"enabled": False}})
    assert cfg.report.daily_enabled is False
    assert svc.load().report.weekly.enabled is False


def test_save_alerts_thresholds(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section("alerts", {"thresholds": {"disk_percent": 80}})
    assert cfg.alerts.thresholds.disk_percent == 80


def test_public_settings_masks_smtp_password(tmp_path, monkeypatch):
    monkeypatch.setenv("SMTP_PW", "topsecret")
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\nsmtp:\n  host: mail\n  port: 465\n  username: u\n"
                   "  password_env: SMTP_PW\n  use_ssl: true\n  from_addr: a@b\n"
                   "  to_addrs: [c@d]\n", encoding="utf-8")
    svc = SettingsService(config_path=cfg, db_path=tmp_path / "m.db")
    payload = svc.public_settings()
    assert payload["alerts"]["email"] is True
    assert "topsecret" not in repr(payload)


def test_non_windows_is_read_only(tmp_path, monkeypatch):
    import sys
    monkeypatch.setattr(sys, "platform", "linux")
    svc = _service(tmp_path)
    assert svc.is_writable() is False


# ---------------------------------------------------------------------------
# Additional behaviour covered while implementing Task 5
# ---------------------------------------------------------------------------


def test_unknown_section_is_rejected(tmp_path):
    svc = _service(tmp_path)
    with pytest.raises(SettingsError):
        svc.save_section("nope", {"x": 1})


def test_non_dict_payload_is_rejected(tmp_path):
    svc = _service(tmp_path)
    with pytest.raises(SettingsError):
        svc.save_section("report", ["not", "a", "dict"])


def test_save_monitoring_section_updates_runtime(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section("monitoring", {"poll_interval_seconds": 300,
                                          "timezone": "UTC"})
    assert cfg.app.poll_interval_seconds == 300
    assert svc.load().app.timezone == "UTC"


def test_public_settings_exposes_expected_sections(tmp_path, monkeypatch):
    monkeypatch.delenv("DASHBOARD_PASSWORD", raising=False)
    svc = _service(tmp_path)
    payload = svc.public_settings()
    for key in ("writable", "setup_required", "monitoring", "dashboard",
                "ssh", "alerts", "report", "disk_health", "hosts"):
        assert key in payload
    assert payload["hosts"] == []
    assert payload["monitoring"]["poll_interval_seconds"] == 600
    assert payload["dashboard"]["username"] == "admin"


def test_save_alerts_webhook_url_is_stored_encrypted(tmp_path):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    svc = _service(tmp_path)
    cfg = svc.save_section(
        "alerts",
        {"webhook": {"enabled": True, "type": "wecom", "url": "https://secret.example/hook"}},
    )
    # Plaintext never persisted in the settings payload nor returned publicly.
    stored = storage.load_app_settings(svc.db_path)["alerts"]
    assert "url" not in stored["webhook"]
    assert stored["webhook"]["url_configured"] is True
    assert "https://secret.example/hook" not in repr(svc.public_settings())
    # ...but the effective config resolves it by decrypting the secret.
    assert cfg.alerts.webhook.url == "https://secret.example/hook"
    assert storage.get_secret(SECRET_WEBHOOK_URL, svc.db_path) is not None


def test_session_secret_seeded_when_writable(tmp_path):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    svc = _service(tmp_path)
    assert storage.get_secret(SECRET_SESSION, svc.db_path) is not None
    assert svc.load().dashboard.session_secret


def test_legacy_env_admin_password_is_adopted(tmp_path, monkeypatch):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    monkeypatch.setenv("DASHBOARD_PASSWORD", "legacypw")
    svc = _service(tmp_path)
    assert svc.setup_required() is False
    assert storage.get_secret(SECRET_ADMIN, svc.db_path) is not None
    assert svc.load().dashboard.auth.password_hash
