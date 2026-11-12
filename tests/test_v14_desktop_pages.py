"""End-to-end page wiring for v1.4 desktop client (Task 12)."""

from __future__ import annotations

import re

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.web import create_app

ADMIN_PASSWORD = "AdminPass!23"


def _logged_in_client(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    service = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(config=service.load(), db_path=db, settings_service=service)
    client = app.test_client()
    page = client.get("/setup").get_data(as_text=True)
    token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    assert client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": token,
        },
    ).status_code == 302
    assert client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    ).status_code == 302
    return client


def test_v14_pages_are_wired(tmp_path):
    client = _logged_in_client(tmp_path)

    overview = client.get("/").get_data(as_text=True)
    assert "主机总数" in overview
    assert 'class="sidebar"' in overview
    assert "终端" in overview

    settings = client.get("/settings").get_data(as_text=True)
    assert "连接向导" in settings
    assert "settings-wizard.js" in settings

    terminal = client.get("/terminal").get_data(as_text=True)
    assert "SSH 终端" in terminal
    assert "vendor/xterm/xterm.js" in terminal
    assert "terminal.js" in terminal


def test_hosts_and_disk_health_pages_are_wired(tmp_path):
    client = _logged_in_client(tmp_path)

    hosts = client.get("/hosts")
    assert hosts.status_code == 200
    hosts_html = hosts.get_data(as_text=True)
    assert "主机列表" in hosts_html
    assert 'id="host-table"' in hosts_html

    disk = client.get("/disk-health")
    assert disk.status_code == 200
    disk_html = disk.get_data(as_text=True)
    assert "按主机查看物理盘" in disk_html
    assert "磁盘健康" in disk_html

    settings = client.get("/settings").get_data(as_text=True)
    assert "settings-tabs.js" in settings
    assert 'data-settings-tab="monitoring"' in settings
    assert 'data-settings-tab="health"' in settings
    assert "settings-health.js" in settings
    assert 'id="health-summary"' in settings
    assert 'href="/api/system/backup"' in settings
    assert 'href="/api/system/config-export"' in settings
    assert 'href="/api/logs/download"' in settings
    assert 'id="restore-file"' in settings
    assert 'id="restore-button"' in settings


def test_configured_host_without_snapshot_opens_detail(tmp_path):
    client = _logged_in_client(tmp_path)
    settings = client.get("/settings").get_data(as_text=True)
    token = re.search(r'data-csrf="([^"]+)"', settings).group(1)
    response = client.put(
        "/api/settings/hosts/new-host",
        json={
            "name": "new-host",
            "host": "10.0.0.9",
            "port": 22,
            "username": "tester",
            "auth_type": "password",
            "password": "secret",
            "disk_mounts": ["/", "/data"],
            "group": "实验室",
            "owner": "张三",
            "tags": [],
        },
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code in (200, 201)
    detail = client.get("/host/new-host")
    assert detail.status_code == 200
    assert "等待首次采集" in detail.get_data(as_text=True)


def test_v16_retention_fields_and_collection_status_ui(tmp_path):
    client = _logged_in_client(tmp_path)
    settings = client.get("/settings").get_data(as_text=True)
    for field in (
        "host_metrics_max_points",
        "disk_health_retention_days",
        "disk_health_max_batches",
        "host_daily_summary_retention_days",
        "alert_history_retention_days",
        "ssh_audit_retention_days",
    ):
        assert f'data-field="{field}"' in settings
    assert 'id="host-collection-status"' in settings

    settings_js = client.get("/static/settings.js").get_data(as_text=True)
    assert "servermonitorWatchCollection" in settings_js
    assert "collection-status?names=" in settings_js

    client.application.config["COLLECTION_STATUS_PROVIDER"] = (
        lambda names=None: {"new-host": {"state": "done"}}
    )
    response = client.get("/api/settings/hosts/collection-status?names=new-host")
    assert response.status_code == 200
    assert response.get_json()["statuses"]["new-host"]["state"] == "done"


def test_v19_theme_and_overview_focus_panel(tmp_path):
    client = _logged_in_client(tmp_path)
    overview = client.get("/").get_data(as_text=True)
    assert 'id="theme-toggle"' in overview
    assert 'id="focus-alert-list"' in overview
    assert "重点关注" in overview
    assert 'id="overview-trend"' in overview
    assert 'data-overview-trend="cpu"' in overview
    assert 'id="alert-trend"' in overview
    assert 'data-alert-trend' in overview
    assert 'id="resource-rank"' in overview
    assert 'data-rank-metric="cpu"' in overview
    assert "theme.js" in overview
    assert "v0.1.140 桌面客户端" in overview

    app_js = client.get("/static/app.js").get_data(as_text=True)
    assert "bindAlertRanges" in app_js
    assert "/api/overview/alert-history" in app_js
    assert "renderResourceRanking" in app_js
    assert "bindResourceRankTabs" in app_js

    theme_js = client.get("/static/theme.js").get_data(as_text=True)
    assert "servermonitor-theme" in theme_js
    assert "data-theme" in theme_js

    css = client.get("/static/style.css").get_data(as_text=True)
    assert 'html[data-theme="dark"]' in css
    assert ".host-subnav" in css
    assert ".pct-meter" in css
    assert ".host-actions" in css
    assert ".host-bulk-actions" in css
    assert ".rank-row" in css
    assert ".rank-meter-fill" in css


def test_v19_host_summary_cards_and_subnav(tmp_path):
    client = _logged_in_client(tmp_path)
    settings = client.get("/settings").get_data(as_text=True)
    token = re.search(r'data-csrf="([^"]+)"', settings).group(1)
    response = client.put(
        "/api/settings/hosts/new-host",
        json={
            "name": "new-host",
            "host": "10.0.0.9",
            "port": 22,
            "username": "tester",
            "auth_type": "password",
            "password": "secret",
            "disk_mounts": ["/", "/data"],
            "group": "实验室",
            "owner": "张三",
            "tags": [],
        },
        headers={"X-CSRF-Token": token},
    )
    assert response.status_code in (200, 201)

    html = client.get("/host/new-host").get_data(as_text=True)
    assert 'class="stat-grid host-stat-grid"' in html
    assert 'class="host-tabbar"' in html
    assert 'data-host-tab="storage"' in html
    assert "采集状态" in html
    assert "CPU 使用率" in html
    assert "根目录磁盘" in html


