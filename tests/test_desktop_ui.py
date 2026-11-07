"""Shell / desktop UI tests for the v1.4 PVS-style layout (Task 6).

These tests render the authenticated shell through the real Flask app and
inspect the two standalone auth templates as source, keeping the new layout
contract (sidebar navigation, custom title bar, app-body shell, auth cards)
pinned independently of any specific page body.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    DashboardAuthConfig,
    DashboardConfig,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.web import create_app

TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def _make_config() -> AppConfig:
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[],
        app=AppRuntimeConfig(poll_interval_seconds=600),
        dashboard=DashboardConfig(
            auth=DashboardAuthConfig(
                enabled=True,
                username="admin",
                password_env=None,
                password="pw",
            ),
            session_secret="test-secret",
        ),
    )


@pytest.fixture()
def client(tmp_path):
    app = create_app(config=_make_config(), db_path=tmp_path / "desktop-ui.db")
    app.config.update(TESTING=True)
    return app.test_client()


def _login(client) -> None:
    response = client.post(
        "/login", data={"username": "admin", "password": "pw"}
    )
    assert response.status_code == 302


def _shell_html(client) -> str:
    _login(client)
    response = client.get("/")
    assert response.status_code == 200
    return response.get_data(as_text=True)


def test_base_sidebar_has_all_navigation_labels(client):
    html = _shell_html(client)
    for label in ("概览", "主机", "磁盘健康", "告警", "终端", "设置"):
        assert label in html


def test_base_has_custom_titlebar_and_window_controls(client):
    html = _shell_html(client)
    assert "titlebar" in html
    assert "window-controls" in html
    assert "windowControl" in html
    assert 'data-window-action="minimize"' in html
    assert 'data-window-action="maximize"' in html
    assert 'data-window-action="close"' in html


def test_base_has_app_body_shell(client):
    html = _shell_html(client)
    assert "app-body" in html
    assert 'class="sidebar"' in html


def test_login_and_setup_templates_use_auth_card():
    login_html = (TEMPLATES / "login.html").read_text(encoding="utf-8")
    setup_html = (TEMPLATES / "setup.html").read_text(encoding="utf-8")
    assert "auth-card" in login_html
    assert "auth-card" in setup_html
