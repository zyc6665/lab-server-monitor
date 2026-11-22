"""v0.1.235：主机详情自动刷新开关 + 桌面通知测试。

- 主机详情页新增「自动刷新：开/关」：开启后每 30 秒走 v0.1.232 的软刷新
  （原地替换 <main>，不白屏），窗口隐藏时暂停、回到前台立即补一次；
  偏好存 localStorage，跨刷新与重启保留。计时器在模块级，软刷新重挂载
  （mountDetail 重入）不会叠加多个计时器。
- 通知渠道测试补齐最后一项：邮件 / Webhook 此前已有「发送测试」，
  桌面通知没有；新增 ``POST /api/settings/test-desktop``（复用
  ``send_desktop_notification``，winotify 优先、PowerShell 兜底）与
  「测试桌面通知」按钮。
"""

from __future__ import annotations

import re
from pathlib import Path

from servermanage.notify_desktop import send_desktop_notification
from servermanage.web import create_app

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
ADMIN_PASSWORD = "AdminPass!23"


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 主机详情自动刷新
# ---------------------------------------------------------------------------


def test_host_page_has_auto_refresh_toggle():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'id="host-auto-refresh"' in html
    assert 'aria-pressed="false"' in html


def test_auto_refresh_uses_soft_refresh_and_persists():
    script = _read("host-detail.js")
    assert 'AUTO_REFRESH_KEY = "host-detail:auto-refresh"' in script
    assert "window.setInterval(function () {" in script
    assert "if (document.hidden) { return; }" in script
    assert "softRefreshDetail();" in script
    # 计时器模块级：软刷新重挂载不会叠加
    assert "autoRefreshTimer = null;" in script
    assert "window.clearInterval(autoRefreshTimer);" in script


def test_auto_refresh_rebinds_without_duplicates():
    script = _read("host-detail.js")
    # 按钮点击只绑定一次（dataset.bound 哨兵），软刷新重挂载安全
    assert 'if (!button.dataset.bound)' in script
    assert "bindAutoRefresh();" in script


def test_auto_refresh_button_text_toggles():
    script = _read("host-detail.js")
    assert 'button.textContent = on ? "自动刷新：开" : "自动刷新：关";' in script
    assert 'button.setAttribute("aria-pressed", on ? "true" : "false");' in script


# ---------------------------------------------------------------------------
# 桌面通知测试
# ---------------------------------------------------------------------------


def _client(tmp_path: Path):
    from servermanage.config import load_config_from_mapping
    from servermanage.settings import SettingsService

    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    svc = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(config=svc.load(), db_path=db, settings_service=svc)
    client = app.test_client()
    page = client.get("/setup").get_data(as_text=True)
    client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": re.search(r'name="csrf_token" value="([^"]+)"', page).group(1),
        },
    )
    client.post("/login", data={"username": "admin", "password": ADMIN_PASSWORD})
    meta = client.get("/").get_data(as_text=True)
    client.environ_base["HTTP_X_CSRF_TOKEN"] = re.search(
        r'name="csrf-token" content="([^"]+)"', meta
    ).group(1)
    return client


def test_test_desktop_endpoint_reports_dispatch(tmp_path, monkeypatch):
    import servermanage.web.routes as routes

    client = _client(tmp_path)
    monkeypatch.setattr(
        routes, "send_desktop_notification", lambda title, message: True
    )
    response = client.post("/api/settings/test-desktop", json={})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["detail"] == "已发送桌面通知"


def test_test_desktop_endpoint_reports_failure(tmp_path, monkeypatch):
    import servermanage.web.routes as routes

    client = _client(tmp_path)
    monkeypatch.setattr(
        routes, "send_desktop_notification", lambda title, message: False
    )
    response = client.post("/api/settings/test-desktop", json={})
    payload = response.get_json()
    assert payload["ok"] is False
    assert "桌面会话" in payload["detail"]


def test_settings_page_has_desktop_test_button():
    html = (TEMPLATES / "settings.html").read_text(encoding="utf-8")
    assert 'id="test-desktop-button"' in html


def test_settings_js_binds_desktop_test():
    script = _read("settings.js")
    assert 'qs("#test-desktop-button").addEventListener' in script
    assert '"/api/settings/test-desktop"' in script
