"""Tests for the server-user dashboard pages.

The UI is plain Jinja + vanilla JS with no build step, so the assertions cover
both rendered markup (``/users``, ``/host/<name>``) and the static sources
(``users.js`` / ``host.html`` / ``base.html`` / ``style.css``).  The rendered
pages are the only check that the templates compile and that the sidebar entry
is wired in.
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


def _client(tmp_path, db_name="pages.db"):
    app = create_app(config=_make_config(), db_path=tmp_path / db_name)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
    return client


@pytest.fixture()
def users_page(tmp_path):
    """Render ``/users`` with a logged-in session (no login POST needed)."""
    response = _client(tmp_path).get("/users")
    assert response.status_code == 200
    return response.get_data(as_text=True)


@pytest.fixture()
def host_page(tmp_path):
    """Render ``/host/gpu-01`` for a host that has not been polled yet."""
    response = _client(tmp_path, "host.db").get("/host/gpu-01")
    assert response.status_code == 200
    return response.get_data(as_text=True)


# ---------------------------------------------------------------------------
# /users page shell
# ---------------------------------------------------------------------------


def test_users_page_renders_summary_and_host_grid(users_page):
    assert 'id="user-dashboard"' in users_page
    assert 'id="user-stats"' in users_page
    assert 'id="user-host-grid"' in users_page
    assert 'id="user-hosts-empty"' in users_page
    assert 'id="user-host-count"' in users_page
    assert 'id="user-refresh"' in users_page
    assert 'id="user-refresh-status"' in users_page
    assert 'id="user-search"' in users_page
    assert 'id="user-status-filter"' in users_page


def test_users_page_has_a_host_detail_view(users_page):
    assert 'id="user-detail"' in users_page
    assert 'id="user-detail-back"' in users_page
    assert 'id="user-detail-title"' in users_page
    assert 'id="user-detail-meta"' in users_page
    assert 'id="user-acct-list"' in users_page
    assert 'id="user-detail-empty"' in users_page
    for chip in ("all", "issue", "missing"):
        assert f'data-user-state="{chip}"' in users_page


def test_users_page_no_longer_ships_a_wide_account_table(users_page):
    assert 'id="user-table"' not in users_page
    assert "<th>UID</th>" not in users_page


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


def test_users_page_status_filter_options(users_page):
    assert '<option value="all">全部</option>' in users_page
    assert '<option value="warning">有异常</option>' in users_page
    assert '<option value="error">仅错误</option>' in users_page
    assert '<option value="ok">仅正常</option>' in users_page


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
        "function buildHostCard",
        "function selectHost",
        "function syncUrl",
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
    assert "function triBadge" in source
    # 未知（null）必须显示破折号，不能显示成"否"。
    assert "value === null || value === undefined" in source


def test_users_js_reports_partial_failures():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "hosts_failed" in source
    assert "payload.errors" in source
    assert "台主机采集失败" in source


def test_users_js_switches_between_host_grid_and_detail():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "?host=" in source
    assert "history.replaceState" in source
    assert "user-host-grid" in source
    assert "user-acct-list" in source
    assert "从基线移除" in source
    # 汇总与明细互斥显示，明细不会叠在主机卡片下面。
    assert "user-hosts" in source
    assert "user-detail" in source


# ---------------------------------------------------------------------------
# host.html / base.html / style.css
# ---------------------------------------------------------------------------


def test_host_page_no_longer_duplicates_the_users_page(host_page):
    # v0.6.0 收掉了主机详情里的“服务器用户”分区：账号只在一个地方看，
    # 主机页保留“登录用户”（sessions）这个不同含义的分区。
    assert 'data-host-tab="users"' not in host_page
    assert 'id="host-users"' not in host_page
    assert 'data-host-panel="users"' not in host_page
    assert 'data-host-tab="sessions"' in host_page
    assert 'data-host-panel="sessions"' in host_page


def test_sidebar_is_the_single_users_entry():
    base = (TEMPLATES / "base.html").read_text(encoding="utf-8")
    assert base.count('href="/users"') == 1
    # 主机详情不再提供第二个入口。
    host_template = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert "/users?host=" not in host_template


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
        ".user-host-grid",
        ".user-host-card",
        ".user-acct",
        ".user-chip",
    ):
        assert selector in css, selector
    assert 'html[data-theme="dark"] .badge-missing' in css
    assert 'html[data-theme="dark"] .user-row-missing' in css
    assert 'html[data-theme="dark"] .user-host-card' in css
