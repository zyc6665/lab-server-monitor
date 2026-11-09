"""Tests for the in-browser settings page (Task 11)."""

from __future__ import annotations

import re

import pytest

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app

ADMIN_PASSWORD = "AdminPass!23"


def _app(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    return create_app(config=service.load(), db_path=db, settings_service=service)


def _csrf_from_form(page: str) -> str:
    return re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)


def _csrf_from_meta(page: str) -> str:
    return re.search(r'name="csrf-token" content="([^"]+)"', page).group(1)


@pytest.fixture()
def client(tmp_path):
    app = _app(tmp_path)
    test_client = app.test_client()
    page = test_client.get("/setup").get_data(as_text=True)
    setup = test_client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": _csrf_from_form(page),
        },
    )
    assert setup.status_code == 302
    login = test_client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    )
    assert login.status_code == 302
    token = _csrf_from_meta(test_client.get("/").get_data(as_text=True))
    test_client.environ_base["HTTP_X_CSRF_TOKEN"] = token
    return test_client


def test_settings_page_has_all_sections(client):
    html = client.get("/settings").get_data(as_text=True)

    for label in ["监控与存储", "主机与 SSH", "通知", "报告", "磁盘健康", "看板与安全"]:
        assert label in html
    assert 'id="settings-root"' in html
    assert "settings.js" in html
    assert "window.__SETTINGS__" in html


def test_settings_page_readonly_when_not_writable(client, monkeypatch):
    monkeypatch.setattr(
        client.application.config["SETTINGS_SERVICE"], "is_writable", lambda: False
    )

    html = client.get("/settings").get_data(as_text=True)

    assert "只读" in html
    assert "disabled" in html


def test_settings_page_has_v12_host_metadata_and_import(client):
    html = client.get("/settings").get_data(as_text=True)

    # Host form metadata fields.
    for name in ("group", "owner", "location", "notes"):
        assert f'data-host-field="{name}"' in html
    # Host table shows the new metadata columns.
    assert "分组" in html
    assert "负责人" in html

    # Batch import dialog and controls.
    assert 'id="import-open-button"' in html
    assert 'id="import-dialog"' in html
    assert 'id="import-format"' in html
    for fmt in ("ssh", "csv", "yaml"):
        assert f'value="{fmt}"' in html
    assert 'id="import-file"' in html
    assert 'type="file"' in html
    assert 'id="import-text"' in html
    assert 'id="import-preview-button"' in html
    assert 'id="import-preview-table"' in html
    assert 'id="import-valid-body"' in html
    assert 'id="import-invalid-body"' in html
    assert 'id="import-duplicate-body"' in html
    assert 'id="import-confirm-button"' in html
    # Batch connection test trigger.
    assert 'id="test-batch-button"' in html


def test_settings_page_has_silence_and_logs_cards(client):
    html = client.get("/settings").get_data(as_text=True)

    # Silence sub-card (scope / scope value / reason / window / create / list).
    assert 'data-section="silences"' in html
    for element_id in (
        "silence-scope-type",
        "silence-scope",
        "silence-reason",
        "silence-starts-at",
        "silence-ends-at",
        "silence-create-button",
        "silence-list",
    ):
        assert f'id="{element_id}"' in html

    # Log card tailing /api/logs.
    assert 'data-section="logs"' in html
    assert 'id="logs-output"' in html
    assert 'id="logs-refresh-button"' in html
    assert "logs-output" in html

    # First paint gets runtime + silences injected alongside settings.
    assert "window.__SETTINGS_RUNTIME__" in html
    assert "window.__SETTINGS_SILENCES__" in html


def test_settings_page_has_v12_checkbox_fields(client):
    html = client.get("/settings").get_data(as_text=True)

    for field in (
        "aggregate_by_host",
        "notify_on_recovery",
        "auto_port_fallback",
        "tray_enabled",
        "open_browser_on_start",
    ):
        assert f'data-field="{field}"' in html


def test_settings_page_hides_desktop_owned_toggles_in_desktop_mode(client, monkeypatch):
    monkeypatch.setenv("SERVERMONITOR_DESKTOP", "1")

    html = client.get("/settings").get_data(as_text=True)

    assert 'data-field="tray_enabled"' not in html
    assert 'data-field="open_browser_on_start"' not in html


def test_settings_page_shows_toggles_outside_desktop_mode(client, monkeypatch):
    monkeypatch.delenv("SERVERMONITOR_DESKTOP", raising=False)

    html = client.get("/settings").get_data(as_text=True)

    assert 'data-field="tray_enabled"' in html
    assert 'data-field="open_browser_on_start"' in html


def test_settings_js_restarts_backend_in_desktop_mode(client):
    source = client.get("/static/settings.js").get_data(as_text=True)

    assert "desktopBridge" in source
    assert "restartBackend" in source


def test_settings_js_decodes_legacy_gbk_upload(client):
    source = client.get("/static/settings.js").get_data(as_text=True)

    # Read raw bytes and decode strictly as UTF-8 first, then GB18030.
    assert "readAsArrayBuffer(file)" in source
    assert 'TextDecoder("utf-8", { fatal: true })' in source
    assert 'TextDecoder("gb18030")' in source
    # The previous implementation decoded with the browser's UTF-8 decoder
    # before upload, destroying GBK bytes irreversibly.
    assert 'readAsText(file, "utf-8")' not in source


def test_settings_page_readonly_fallback_without_service(tmp_path):
    base = load_config_from_mapping(
        {"dashboard": {"auth": {"enabled": False}}}, allow_empty_servers=True
    )
    app = create_app(config=base, db_path=tmp_path / "legacy.db")

    response = app.test_client().get("/settings")

    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'id="settings-root"' in html
    assert "只读" in html


def test_settings_page_renders_host_rows(tmp_path):
    app = _app(tmp_path)
    service = app.config["SETTINGS_SERVICE"]
    service.upsert_host(
        "edge",
        {
            "host": "10.0.0.5",
            "port": 22,
            "username": "ops",
            "auth_type": "key",
            "key_path": "C:/keys/edge",
            "disk_mounts": ["/", "/data"],
            "tags": ["lab"],
        },
    )
    test_client = app.test_client()
    page = test_client.get("/setup").get_data(as_text=True)
    test_client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": _csrf_from_form(page),
        },
    )
    test_client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    )

    html = test_client.get("/settings").get_data(as_text=True)

    assert "edge" in html
    assert "10.0.0.5" in html
    assert "data-host-edit=\"edge\"" in html
    assert "data-host-copy=\"edge\"" in html


# ---------------------------------------------------------------------------
# Task 7: host form sudo password / checks editor / per-host alert rules
# ---------------------------------------------------------------------------


def test_host_form_contains_sudo_and_check_editor(client):
    html = client.get("/settings").get_data(as_text=True)

    assert 'data-host-field="sudo_password"' in html
    assert 'id="host-checks"' in html
    assert "添加检查" in html
    assert "清除 sudo 密码" in html
    assert "未配置" in html

    for name in (
        "alert_cpu_percent",
        "alert_memory_percent",
        "alert_disk_percent",
        "alert_gpu_memory_percent",
        "alert_disk_temperature_c",
        "alert_consecutive_periods",
    ):
        assert f'data-host-field="{name}"' in html

    # The new 检查 column must widen the empty-state colspan.
    assert 'colspan="10"' in html
    assert "<th>检查</th>" in html


def test_settings_js_submits_checks_and_rules(client):
    source = client.get("/static/settings.js").get_data(as_text=True)

    assert "hostPayload()" in source
    assert "sudo_password" in source
    assert "alert_rules" in source
    assert "checks" in source
    assert "/checks/test" in source
    assert "请先保存主机再测试" in source
    assert "该检查已禁用" in source
    assert "result.ok === false" in source


def test_alert_form_exposes_feishu_webhook(client):
    html = client.get("/settings").get_data(as_text=True)
    assert 'value="feishu"' in html
    assert "飞书" in html


def test_alert_form_exposes_global_consecutive_periods(client):
    html = client.get("/settings").get_data(as_text=True)

    assert 'data-field="consecutive_periods"' in html
    assert "连续异常周期数" in html
