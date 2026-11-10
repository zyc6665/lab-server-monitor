"""Tests for the v0.5.0 account-provisioning UI wiring.

The dialog is inert unless all three gates are satisfied, so these assertions
cover the markup hooks, the guarded JS helpers and the two switches that turn
the feature on (global ``write_enabled`` + per-host ``allow_user_write``).
"""

from __future__ import annotations

from test_user_pages import STATIC, _client


def _users_page(tmp_path) -> str:
    response = _client(tmp_path, "admin.db").get("/users")
    assert response.status_code == 200
    return response.get_data(as_text=True)


def _settings_page(tmp_path) -> str:
    response = _client(tmp_path, "admin-settings.db").get("/settings")
    assert response.status_code == 200
    return response.get_data(as_text=True)


def test_users_page_ships_the_account_admin_dialog(tmp_path):
    page = _users_page(tmp_path)
    for marker in (
        'id="user-admin-dialog"',
        'id="user-admin-operation"',
        'id="user-admin-account"',
        'id="user-admin-password"',
        'id="user-admin-preview"',
        'id="user-admin-steps"',
        'id="user-admin-blocked"',
        'id="user-admin-confirm-host"',
        'id="user-admin-confirm-account"',
        'id="user-admin-execute"',
        'id="user-admin-result"',
        'id="user-detail-create"',
    ):
        assert marker in page, marker
    # The execute button must start disabled: the typed confirmation enables it.
    assert "id=\"user-admin-execute\" disabled" in page


def test_admin_dialog_offers_all_four_safe_operations(tmp_path):
    page = _users_page(tmp_path)
    for operation in ("create", "password", "docker", "data"):
        assert f'value="{operation}"' in page
    # Deletion and shell changes are deliberately out of scope.
    assert 'value="delete"' not in page
    assert 'value="shell"' not in page


def test_users_js_guards_writes_behind_the_three_gates():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function canWriteHost(host)" in source
    assert "payloadState.write_enabled" in source
    assert "host.allow_user_write" in source
    assert "host.sudo_configured" in source
    assert "'/api/users/plan'" in source
    assert "'/api/users/execute'" in source
    # The confirmation must be compared verbatim on both fields.
    assert "currentPlan.host" in source and "currentPlan.account" in source
    assert "updateExecuteState" in source


def test_users_js_only_creates_dom_nodes_with_text_content():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    admin_part = source.split("账号写操作（默认关闭")[1]
    assert "innerHTML" not in admin_part
    for helper in (
        "openAdminDialog",
        "closeAdminDialog",
        "previewPlan",
        "renderPlan",
        "executePlan",
        "bindAdminDialog",
    ):
        assert f"function {helper}" in admin_part


def test_settings_page_exposes_both_write_switches(tmp_path):
    page = _settings_page(tmp_path)
    assert 'data-field="write_enabled"' in page
    assert 'data-host-field="allow_user_write"' in page
    assert "账号写操作" in page


def test_settings_js_round_trips_allow_user_write():
    source = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert 'hostField("allow_user_write").checked' in source
    assert "payload.allow_user_write" in source


def test_style_defines_the_admin_dialog_layout():
    source = (STATIC / "style.css").read_text(encoding="utf-8")
    for selector in (
        ".user-admin-dialog",
        ".user-admin-dialog::backdrop",
        ".user-admin-steps",
        ".user-admin-blocked",
        ".user-admin-confirm",
        ".user-admin-step-ok",
        ".user-acct-action",
    ):
        assert selector in source, selector
    assert 'html[data-theme="dark"] .user-admin-dialog' in source
