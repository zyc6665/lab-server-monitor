"""v0.1.82：登录页与首次设置页的视觉层级。"""

from __future__ import annotations

from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


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
    return app.test_client()


def test_login_page_renders_brand_and_footnote(tmp_path: Path):
    html = _client(tmp_path).get("/login").get_data(as_text=True)
    assert 'class="auth-brand"' in html
    assert 'class="auth-mark"' in html
    assert "<strong>服务器监控</strong>" in html
    assert "实验室服务器轮询监测" in html
    assert "登录控制台" in html
    assert "auth-submit" in html
    assert "登录会话 30 天有效" in html


def test_setup_page_renders_brand_and_hint(tmp_path: Path):
    html = _client(tmp_path).get("/setup").get_data(as_text=True)
    assert 'class="auth-brand"' in html
    assert "首次设置" in html
    assert "auth-hint" in html
    assert "创建管理员账户后即可开始监控" in html
    assert "auth-submit" in html
    assert "完成设置" in html


def test_templates_keep_csrf_and_field_names():
    login = (TEMPLATES / "login.html").read_text(encoding="utf-8")
    setup = (TEMPLATES / "setup.html").read_text(encoding="utf-8")
    assert 'name="username"' in login and 'name="password"' in login
    assert 'action="{{ url_for(\'login_submit\') }}"' in login
    assert 'name="csrf_token"' in setup
    assert 'name="confirm"' in setup
    assert 'action="{{ url_for(\'setup\') }}"' in setup


def test_auth_styles_cover_light_and_dark():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.82 登录与首次设置页") :]
    assert ".auth-brand" in tail
    assert ".auth-mark" in tail
    assert ".auth-brand-text strong" in tail
    assert ".auth-hint" in tail
    assert ".auth-submit" in tail
    assert ".auth-foot" in tail
    assert 'html[data-theme="dark"] .auth-card' in tail
    assert "@media (max-width: 480px)" in tail
