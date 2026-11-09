"""Tests for the server-user dashboard pages (Task 6).

The UI is plain Jinja + vanilla JS with no build step, so the assertions cover
both rendered markup (``/users``) and the static sources (``users.js`` /
``host.html`` / ``base.html`` / ``style.css``).  The rendered page is the only
check that the template compiles and that the sidebar entry is wired in.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DashboardAuthConfig,
    DashboardConfig,
    HostConfig,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.web import create_app

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"

COLUMNS = [
    "主机",
    "用户名",
    "UID",
    "GID",
    "主组",
    "附加组",
    "状态",
    "Docker",
    "sudo",
    "家目录",
    "数据目录",
    "最近采集",
    "操作",
]


def _make_config() -> AppConfig:
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[
            HostConfig(
                name="gpu-01",
                host="10.0.0.1",
                port=22,
                username="monitor",
                auth=AuthConfig(type="password", password="ssh-pw"),
            )
        ],
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
def users_page(tmp_path):
    """Render ``/users`` with a logged-in session (no login POST needed)."""
    app = create_app(config=_make_config(), db_path=tmp_path / "pages.db")
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
    response = client.get("/users")
    assert response.status_code == 200
    return response.get_data(as_text=True)


# ---------------------------------------------------------------------------
# /users page
# ---------------------------------------------------------------------------


def test_users_page_renders_dashboard_shell(users_page):
    assert 'id="user-dashboard"' in users_page
    assert 'id="user-stats"' in users_page
    assert 'id="user-table"' in users_page
    assert 'id="user-table-body"' in users_page
    assert 'id="user-empty"' in users_page
    assert 'id="user-refresh"' in users_page
    assert 'id="user-refresh-status"' in users_page
    assert 'id="user-host-filter"' in users_page
    assert 'id="user-search"' in users_page
    assert 'id="user-status-filter"' in users_page


def test_users_page_renders_stat_cards(users_page):
    for element_id in (
        "stat-user-total",
        "stat-user-present",
        "stat-user-missing",
        "stat-user-docker",
        "stat-user-dirs",
        "stat-user-bytes",
    ):
        assert f'id="{element_id}"' in users_page


def test_users_page_host_filter_has_all_hosts_default(users_page):
    assert '<option value="">全部主机</option>' in users_page
    assert '<option value="all">全部</option>' in users_page
    assert '<option value="warning">有异常</option>' in users_page
    assert '<option value="error">仅错误</option>' in users_page
    assert '<option value="ok">仅正常</option>' in users_page


def test_users_page_table_has_every_column(users_page):
    table = users_page.split('id="user-table"', 1)[1].split("</thead>", 1)[0]
    headers = [f"<th>{column}</th>" for column in COLUMNS]
    assert len(headers) == 13
    for header in headers:
        assert header in table, header


def test_users_page_loads_users_script_with_cache_buster(users_page):
    assert "users.js?v=" in users_page


def test_users_page_sidebar_links_to_users(users_page):
    assert 'href="/users"' in users_page
    assert 'active' in users_page.split('href="/users"', 1)[1][:200]


# ---------------------------------------------------------------------------
# users.js
# ---------------------------------------------------------------------------


def test_users_js_exposes_testable_functions():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    for name in (
        "function renderUserRows",
        "function fetchUsers",
        "function refreshUsers",
        "function removeUserBaseline",
    ):
        assert name in source, name
    assert "DOMContentLoaded" in source


def test_users_js_uses_the_user_api_endpoints():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    for endpoint in (
        "/api/users",
        "/api/users/refresh",
        "/api/users/refresh-status",
        "/api/users/baseline/remove",
    ):
        assert endpoint in source, endpoint


def test_users_js_renders_only_with_text_content():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "textContent" in source
    assert "innerHTML" not in source


def test_users_js_sends_csrf_header_and_polls():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "X-CSRF-Token" in source
    assert "meta[name=\"csrf-token\"]" in source
    assert "2000" in source
    assert "badge-missing" in source
    assert "badge-warning" in source
    assert "badge-ok" in source


def test_users_js_renders_gid_and_tri_state_badges():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "row.gid" in source
    assert "function triBadgeCell" in source
    # 未知（null）必须显示破折号，不能显示成"否"。
    assert "value === null || value === undefined" in source


def test_users_js_reports_partial_failures():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "hosts_failed" in source
    assert "payload.errors" in source
    assert "台主机采集失败" in source


# ---------------------------------------------------------------------------
# host.html / base.html / style.css
# ---------------------------------------------------------------------------


def test_host_page_has_server_user_tab_and_panel():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'data-host-tab="users"' in html
    assert 'id="host-users"' in html
    assert 'data-host-panel="users"' in html
    assert 'id="host-users-empty"' in html
    # The pre-existing "登录用户" (sessions) tab keeps its own panel key so the
    # two tabs never activate together.
    assert 'data-host-tab="sessions"' in html
    assert 'data-host-panel="sessions"' in html


def test_host_page_user_panel_lists_every_column_but_host():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    panel = html.split('id="host-users"', 1)[1].split("</section>", 1)[0]
    for column in COLUMNS:
        if column == "主机":
            continue
        assert f"<th>{column}</th>" in panel, column
    assert "<th>主机</th>" not in panel


def test_base_sidebar_has_users_navigation_entry():
    html = (TEMPLATES / "base.html").read_text(encoding="utf-8")
    assert 'href="/users"' in html
    assert "服务器用户" in html


def test_style_defines_user_layout_and_badges():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    for selector in (
        ".user-stats",
        ".user-toolbar",
        ".badge-missing",
        ".badge-ok",
        ".badge-warning",
        ".user-row-missing",
    ):
        assert selector in css, selector
    assert 'html[data-theme="dark"] .badge-missing' in css
    assert 'html[data-theme="dark"] .user-row-missing' in css
