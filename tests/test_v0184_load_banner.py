"""v0.1.84：加载失败时显示统一提示条与重试按钮。"""

from __future__ import annotations

from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.web import create_app

TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"
STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def _client(tmp_path: Path):
    app = create_app(
        config=load_config_from_mapping(
            {
                "report": {"daily_enabled": False, "weekly": {"enabled": False}},
                "dashboard": {"auth": {"password": "secret"}},
                "servers": [],
            },
            allow_empty_servers=True,
        ),
        db_path=tmp_path / "monitor.db",
    )
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client


def test_overview_hosts_card_has_load_banner(tmp_path: Path):
    html = _client(tmp_path).get("/").get_data(as_text=True)
    assert 'id="host-load-banner"' in html
    assert 'id="host-load-retry"' in html
    assert 'class="load-banner-text"' in html
    assert "hidden" in html[html.index('id="host-load-banner"') : html.index('id="host-load-banner"') + 260]


def test_alerts_page_has_load_banner(tmp_path: Path):
    html = _client(tmp_path).get("/alerts").get_data(as_text=True)
    assert 'id="alert-load-banner"' in html
    assert 'id="alert-load-retry"' in html


def test_app_js_shows_banner_on_failure():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function showLoadBanner(id, text)" in js
    assert "function hideLoadBanner(id)" in js
    assert "function hideSkeleton(id)" in js
    assert "showLoadBanner('host-load-banner', '主机数据加载失败" in js
    assert "showLoadBanner('alert-load-banner', '告警数据加载失败" in js
    assert "hideSkeleton('host-skeleton');" in js
    assert "hostRetry.addEventListener('click', function () { refreshOverview(); });" in js
    assert "alertRetry.addEventListener('click', function () { refreshAlerts(); });" in js
    # 成功后必须收起提示条
    assert js.count("hideLoadBanner('host-load-banner');") >= 1
    assert js.count("hideLoadBanner('alert-load-banner');") >= 1


def test_banner_styles_cover_light_and_dark():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.84 加载失败提示统一") :]
    assert ".load-banner {" in tail
    assert ".load-banner[hidden] { display: none !important; }" in tail
    assert ".load-banner-dot" in tail
    assert ".load-banner-retry" in tail
    assert 'html[data-theme="dark"] .load-banner' in tail
    assert 'html[data-theme="dark"] .load-banner-dot' in tail
