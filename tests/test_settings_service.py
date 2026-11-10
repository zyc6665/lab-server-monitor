"""Tests for :class:`servermanage.settings.SettingsService`.

Task 5 scope: effective config synthesis (YAML base + SQLite overrides) and the
public settings payload. Host CRUD/admin password behaviour is added in Task 6.
"""

from __future__ import annotations

import json

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
    assert svc.setup_required() is False
    with pytest.raises(SettingsError):
        svc.save_section("report", {"daily_enabled": False})


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


# ---------------------------------------------------------------------------
# Review fixes: dashboard credential injection + numeric coercion
# ---------------------------------------------------------------------------


def test_dashboard_save_strips_admin_credentials(tmp_path, monkeypatch):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    monkeypatch.delenv("DASHBOARD_PASSWORD", raising=False)
    svc = _service(tmp_path)
    cfg = svc.save_section(
        "dashboard",
        {
            "host": "127.0.0.1",
            "auth": {
                "username": "bob",
                "password": "MARKER",
                "password_hash": "attacker-hash",
                "password_salt": "attacker-salt",
                "password_iterations": 1,
                "enabled": True,
                "password_env": "DASHBOARD_PASSWORD",
            },
        },
    )
    stored = storage.load_app_settings(svc.db_path)["dashboard"]
    stored_auth = stored.get("auth", {})
    # Nothing credential-like is persisted, directly or nested under auth.
    assert "password" not in stored_auth
    assert "password_hash" not in stored_auth
    assert "password_salt" not in stored_auth
    assert "password_iterations" not in stored_auth
    assert "MARKER" not in repr(stored)
    assert "attacker-hash" not in repr(stored)
    # Loaded config has no injected admin credential; only safe fields applied.
    assert cfg.dashboard.auth.password is None
    assert cfg.dashboard.auth.password_hash is None
    assert cfg.dashboard.auth.password_salt is None
    assert cfg.dashboard.auth.username == "bob"
    assert cfg.dashboard.host == "127.0.0.1"


def test_dashboard_admin_hash_comes_only_from_secret(tmp_path, monkeypatch):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    monkeypatch.delenv("DASHBOARD_PASSWORD", raising=False)
    svc = _service(tmp_path)
    svc._store_admin_password("realpw", "admin")
    secret_hash = svc.load().dashboard.auth.password_hash
    assert secret_hash

    svc.save_section(
        "dashboard",
        {"auth": {"password_hash": "attacker-hash", "password_salt": "x",
                  "password_iterations": 1}},
    )
    loaded = svc.load().dashboard.auth
    assert loaded.password_hash == secret_hash != "attacker-hash"
    assert loaded.password_salt != "x"


def test_float_threshold_is_not_truncated(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section("alerts", {"thresholds": {"disk_percent": 80.5}})
    assert cfg.alerts.thresholds.disk_percent == 80.5
    assert isinstance(cfg.alerts.thresholds.disk_percent, float)
    assert svc.load().alerts.thresholds.disk_percent == 80.5


def test_malformed_admin_secret_is_tolerated(tmp_path):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    svc = _service(tmp_path)
    document = {"hash": "deadbeef", "salt": 123, "iterations": "nope"}
    storage.set_secret(
        SECRET_ADMIN,
        security.protect_secret(json.dumps(document).encode("utf-8")),
        svc.db_path,
    )
    auth = svc.load().dashboard.auth
    assert auth.password_hash == "deadbeef"
    assert auth.password_salt is None
    assert auth.password_iterations == 200000


# ---------------------------------------------------------------------------
# Task 6: host CRUD, secret migration, machine reset and admin password
# ---------------------------------------------------------------------------


def test_upsert_host_stores_and_masks_secret(tmp_path):
    svc = _service(tmp_path)
    svc.set_admin_password(None, "AdminPass!23", username="admin")
    cfg = svc.upsert_host("a100", {
        "host": "202.119.189.245", "port": 22, "username": "zhouyc",
        "auth_type": "password", "password": "ssh-secret",
        "disk_mounts": ["/", "/data"],
    })
    assert [h.name for h in cfg.servers] == ["a100"]
    assert cfg.servers[0].auth.password == "ssh-secret"
    assert "ssh-secret" not in repr(svc.public_settings())


def test_updating_host_without_password_keeps_existing_secret(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("h", {"host": "1.2.3.4", "username": "u",
                          "auth_type": "password", "password": "keepme"})
    svc.upsert_host("h", {"host": "1.2.3.5", "username": "u", "auth_type": "password"})
    assert svc.load().servers[0].auth.password == "keepme"


def test_delete_host_removes_secrets(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("h", {"host": "1.2.3.4", "username": "u",
                          "auth_type": "password", "password": "x"})
    svc.delete_host("h")
    assert svc.load().servers == []
    assert storage.get_secret("host:h:ssh_password", svc.db_path) is None


def test_verify_admin_and_change_password(tmp_path):
    svc = _service(tmp_path)
    svc.set_admin_password(None, "OldPass!23", username="admin")
    assert svc.verify_admin("admin", "OldPass!23") is True
    assert svc.verify_admin("admin", "wrong") is False
    svc.set_admin_password("OldPass!23", "AdminPass!23")
    assert svc.verify_admin("admin", "AdminPass!23") is True


def test_machine_mismatch_forces_setup_and_clears_secrets(tmp_path):
    svc = _service(tmp_path)
    svc.set_admin_password(None, "Pass!234", username="admin")
    storage.save_app_settings("security", {"machine_id": "other-machine"}, svc.db_path)
    svc2 = SettingsService(config_path=svc.config_path, db_path=svc.db_path)
    assert svc2.setup_required() is True
    assert storage.get_secret("dashboard:admin_password", svc.db_path) is None


def test_legacy_env_password_migrates_to_dpapi(tmp_path, monkeypatch):
    monkeypatch.setenv("DASHBOARD_PASSWORD", "LegacyPass!23")
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\n", encoding="utf-8")
    svc = SettingsService(config_path=cfg, db_path=tmp_path / "m.db")
    svc.load()
    if security.dpapi_available():
        assert storage.get_secret("dashboard:admin_password", svc.db_path) is not None


# ---------------------------------------------------------------------------
# Task 6 review fixes: validation, migration, DPAPI reset and auth switching
# ---------------------------------------------------------------------------


def test_set_admin_rejects_short_password(tmp_path):
    svc = _service(tmp_path)
    with pytest.raises(SettingsError):
        svc.set_admin_password(None, "1234567")


def test_wrong_current_password_is_rejected(tmp_path):
    svc = _service(tmp_path)
    svc.set_admin_password(None, "Password1", username="admin")
    with pytest.raises(SettingsError):
        svc.set_admin_password("wrong-password", "Password2")


def test_upsert_host_rejects_unknown_auth_type(tmp_path):
    svc = _service(tmp_path)
    with pytest.raises(SettingsError):
        svc.upsert_host("x", {"host": "1.2.3.4", "username": "u", "auth_type": "telnet"})


def test_upsert_host_rejects_payload_name_mismatch(tmp_path):
    svc = _service(tmp_path)
    with pytest.raises(SettingsError):
        svc.upsert_host("a", {"name": "b", "host": "1.2.3.4", "username": "u",
                              "auth_type": "password", "password": "pw"})


def test_key_auth_host_upsert_and_clear_secrets(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("k", {"host": "1.2.3.4", "username": "u", "auth_type": "key",
                          "private_key": "KEYDATA", "passphrase": "pp"})
    assert storage.get_secret("host:k:ssh_key", svc.db_path) is not None
    assert storage.get_secret("host:k:ssh_passphrase", svc.db_path) is not None
    entry = svc.get_host("k")
    assert entry["key_configured"] is True
    assert entry["passphrase_configured"] is True
    assert svc.load().servers[0].auth.key_data == "KEYDATA"

    svc.upsert_host("k", {"host": "1.2.3.4", "username": "u", "auth_type": "key",
                          "key_path": "~/id_rsa", "clear_secrets": ["key", "passphrase"]})
    assert storage.get_secret("host:k:ssh_key", svc.db_path) is None
    assert storage.get_secret("host:k:ssh_passphrase", svc.db_path) is None
    entry = svc.get_host("k")
    assert entry["key_configured"] is True  # falls back to key_path
    assert entry["passphrase_configured"] is False
    assert svc.load().servers[0].auth.key_data is None


def test_switching_auth_type_clears_stale_secrets(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("s", {"host": "1.2.3.4", "username": "u", "auth_type": "key",
                          "private_key": "KEYDATA", "passphrase": "pp"})
    svc.upsert_host("s", {"host": "1.2.3.4", "username": "u", "auth_type": "password",
                          "password": "newpw"})
    assert storage.get_secret("host:s:ssh_key", svc.db_path) is None
    assert storage.get_secret("host:s:ssh_passphrase", svc.db_path) is None
    entry = svc.get_host("s")
    assert entry["password_configured"] is True
    assert entry["key_configured"] is False
    assert entry["passphrase_configured"] is False


def test_unreadable_admin_secret_forces_setup_and_clears_all_secrets(tmp_path):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    svc = _service(tmp_path)
    svc.set_admin_password(None, "Password1", username="admin")
    svc.upsert_host("h", {"host": "1.2.3.4", "username": "u",
                          "auth_type": "password", "password": "pw"})
    storage.set_secret(SECRET_ADMIN, b"not-a-dpapi-blob", svc.db_path)
    fresh = SettingsService(config_path=svc.config_path, db_path=svc.db_path)
    assert fresh.setup_required() is True
    assert storage.list_secret_names(svc.db_path) == []
    section = storage.load_app_settings(svc.db_path)["security"]
    assert section["force_setup"] is True
    assert section["machine_id"] == security.current_machine_id()


def test_machine_reset_db_level_state(tmp_path):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    svc = _service(tmp_path)
    svc.set_admin_password(None, "Password1", username="admin")
    svc.upsert_host("h", {"host": "1.2.3.4", "username": "u",
                          "auth_type": "password", "password": "pw"})
    storage.save_app_settings("security", {"machine_id": "other-machine"}, svc.db_path)
    SettingsService(config_path=svc.config_path, db_path=svc.db_path)
    assert storage.list_secret_names(svc.db_path) == []
    section = storage.load_app_settings(svc.db_path)["security"]
    assert section == {"machine_id": security.current_machine_id(), "force_setup": True}


def test_admin_setup_marks_migration_so_legacy_secrets_stay_gone(tmp_path, monkeypatch):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    monkeypatch.setenv("LEGACY_HOST_PW", "legacy-pw")
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "servers:\n"
        "  - name: legacy\n"
        "    host: 1.2.3.4\n"
        "    port: 22\n"
        "    username: u\n"
        "    auth:\n"
        "      type: password\n"
        "      password_env: LEGACY_HOST_PW\n",
        encoding="utf-8",
    )
    db = tmp_path / "m.db"
    svc = SettingsService(config_path=cfg, db_path=db)
    assert storage.get_secret("host:legacy:ssh_password", db) is not None

    storage.save_app_settings("security", {"machine_id": "other-machine"}, db)
    reset = SettingsService(config_path=cfg, db_path=db)
    assert storage.list_secret_names(db) == []
    reset.set_admin_password(None, "Password1", username="admin")

    restarted = SettingsService(config_path=cfg, db_path=db)
    assert storage.get_secret("host:legacy:ssh_password", db) is None
    assert restarted.load().servers[0].auth.password is None


def test_migration_failure_records_error_and_keeps_config_usable(tmp_path, monkeypatch):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")

    def boom(self):
        raise RuntimeError("boom")

    monkeypatch.setattr(SettingsService, "_migrate_legacy_sources", boom)
    svc = _service(tmp_path)
    section = storage.load_app_settings(svc.db_path)["security"]
    assert "RuntimeError: boom" in section["migration_error"]
    assert "migrated_at" not in section
    assert svc.load().app.poll_interval_seconds == 600


def test_failed_key_to_password_switch_preserves_credentials(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("h", {"host": "1.2.3.4", "username": "u", "auth_type": "key",
                          "private_key": "KEYDATA", "passphrase": "pp"})
    with pytest.raises(SettingsError):
        svc.upsert_host("h", {"host": "1.2.3.4", "username": "u",
                              "auth_type": "password"})
    assert storage.get_secret("host:h:ssh_key", svc.db_path) is not None
    assert storage.get_secret("host:h:ssh_passphrase", svc.db_path) is not None
    assert storage.get_secret("host:h:ssh_password", svc.db_path) is None
    auth = svc.load().servers[0].auth
    assert auth.type == "key"
    assert auth.key_data == "KEYDATA"
    assert auth.passphrase == "pp"


def test_failed_password_to_key_switch_preserves_credentials(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("h", {"host": "1.2.3.4", "username": "u",
                          "auth_type": "password", "password": "oldpw"})
    with pytest.raises(SettingsError):
        svc.upsert_host("h", {"host": "1.2.3.4", "username": "u", "auth_type": "key"})
    assert storage.get_secret("host:h:ssh_password", svc.db_path) is not None
    assert storage.get_secret("host:h:ssh_key", svc.db_path) is None
    auth = svc.load().servers[0].auth
    assert auth.type == "password"
    assert auth.password == "oldpw"


def test_machine_reset_does_not_readopt_env_admin(tmp_path, monkeypatch):
    if not security.dpapi_available():
        pytest.skip("DPAPI only available on Windows")
    monkeypatch.setenv("DASHBOARD_PASSWORD", "LegacyPass!23")
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    svc = SettingsService(config_path=cfg, db_path=db)
    assert storage.get_secret(SECRET_ADMIN, db) is not None  # migrated from env

    storage.save_app_settings("security", {"machine_id": "other-machine"}, db)
    fresh = SettingsService(config_path=cfg, db_path=db)
    fresh.load()
    fresh.public_settings()
    assert storage.get_secret(SECRET_ADMIN, db) is None
    assert fresh.setup_required() is True
    assert fresh.verify_admin("admin", "LegacyPass!23") is False


def test_smtp_section_stores_password_in_secret_store(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section(
        "smtp",
        {
            "host": "smtp.example.com",
            "port": 465,
            "username": "monitor",
            "password": "smtp-secret",
            "use_ssl": True,
            "from_addr": "monitor@example.com",
            "to_addrs": "ops@example.com; lead@example.com",
        },
    )
    assert cfg.smtp is not None
    assert cfg.smtp.host == "smtp.example.com"
    assert cfg.smtp.password == "smtp-secret"
    assert cfg.smtp.to_addrs == ["ops@example.com", "lead@example.com"]
    payload = svc.public_settings()
    assert payload["smtp"]["password_configured"] is True
    assert "smtp-secret" not in repr(payload)


def test_enabling_report_without_smtp_is_rejected(tmp_path):
    svc = _service(tmp_path)
    svc.save_section("report", {"daily_enabled": False, "weekly": {"enabled": False}})
    with pytest.raises(SettingsError):
        svc.save_section("report", {"daily_enabled": True})
    svc.save_section(
        "smtp",
        {
            "host": "mail.lab.internal",
            "port": 587,
            "username": "monitor",
            "password": "smtp-secret",
            "from_addr": "monitor@example.com",
            "to_addrs": ["ops@example.com"],
        },
    )
    cfg = svc.save_section("report", {"daily_enabled": True, "daily_time": "08:00"})
    assert cfg.report.daily_enabled is True


def test_non_windows_never_requires_setup(tmp_path, monkeypatch):
    import sys

    monkeypatch.setattr(sys, "platform", "linux")
    svc = _service(tmp_path)
    assert svc.is_writable() is False
    assert svc.setup_required() is False


# ---------------------------------------------------------------------------
# Task 4: v1.2 public monitoring/alerts fields
# ---------------------------------------------------------------------------


def test_public_settings_exposes_v12_toggles(tmp_path):
    svc = _service(tmp_path)
    payload = svc.public_settings()
    monitoring = payload["monitoring"]
    assert monitoring["auto_port_fallback"] is True
    assert monitoring["tray_enabled"] is True
    assert monitoring["open_browser_on_start"] is True
    alerts = payload["alerts"]
    assert alerts["aggregate_by_host"] is True
    assert alerts["notify_on_recovery"] is True


def test_save_monitoring_v12_toggles(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section(
        "monitoring",
        {
            "auto_port_fallback": False,
            "tray_enabled": False,
            "open_browser_on_start": False,
        },
    )
    assert cfg.app.auto_port_fallback is False
    assert cfg.app.tray_enabled is False
    assert cfg.app.open_browser_on_start is False
    payload = svc.public_settings()["monitoring"]
    assert payload["auto_port_fallback"] is False
    assert payload["tray_enabled"] is False
    assert payload["open_browser_on_start"] is False


def test_save_alerts_v12_toggles(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section(
        "alerts", {"aggregate_by_host": False, "notify_on_recovery": False}
    )
    assert cfg.alerts.aggregate_by_host is False
    assert cfg.alerts.notify_on_recovery is False
    alerts = svc.public_settings()["alerts"]
    assert alerts["aggregate_by_host"] is False
    assert alerts["notify_on_recovery"] is False


# ---------------------------------------------------------------------------
# Task 5: desktop mode flag
# ---------------------------------------------------------------------------


def test_public_settings_desktop_mode_true(tmp_path, monkeypatch):
    monkeypatch.setenv("SERVERMONITOR_DESKTOP", "1")
    svc = _service(tmp_path)
    assert svc.public_settings()["desktop_mode"] is True


def test_public_settings_desktop_mode_false(tmp_path, monkeypatch):
    monkeypatch.delenv("SERVERMONITOR_DESKTOP", raising=False)
    svc = _service(tmp_path)
    assert svc.public_settings()["desktop_mode"] is False


def test_save_user_monitoring_section_persists_intervals(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.save_section(
        "user_monitoring",
        {
            "enabled": True,
            "scan_interval_seconds": 7200,
            "usage_interval_seconds": 86400,
            "command_timeout": 60,
        },
    )
    assert cfg.user_monitoring.usage_interval_seconds == 86400
    reloaded = svc.load().user_monitoring
    assert reloaded.scan_interval_seconds == 7200
    assert reloaded.command_timeout == 60


def test_partial_user_monitoring_payload_keeps_other_fields(tmp_path):
    svc = _service(tmp_path)
    svc.save_section("user_monitoring", {"usage_interval_seconds": 43200})
    svc.save_section("user_monitoring", {"command_timeout": 90})
    settings = svc.load().user_monitoring
    assert settings.usage_interval_seconds == 43200
    assert settings.command_timeout == 90
    assert settings.scan_interval_seconds == 3600


@pytest.mark.parametrize(
    "payload",
    [
        {"scan_interval_seconds": 60},
        {"usage_interval_seconds": 60},
        {"command_timeout": 5},
        {"scan_interval_seconds": "600"},
        {"enabled": "yes"},
    ],
)
def test_invalid_user_monitoring_payload_is_rejected(tmp_path, payload):
    svc = _service(tmp_path)
    with pytest.raises(SettingsError):
        svc.save_section("user_monitoring", payload)
