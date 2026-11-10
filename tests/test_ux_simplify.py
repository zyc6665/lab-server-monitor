"""Tests for the v0.6.0 usability pass.

Three complaints drove these changes:

* the account buttons were invisible unless every gate was already open, so the
  feature looked like it did not exist;
* the users page had several entry points for the same data;
* saving a host blocked the form until the post-save collection finished.
"""

from __future__ import annotations

from test_user_pages import STATIC, TEMPLATES, _client


def test_admin_entries_are_always_visible(tmp_path):
    page = _client(tmp_path, "ux-users.db").get("/users").get_data(as_text=True)
    assert 'id="user-admin-hint"' in page
    assert 'id="user-admin-hint-link"' in page

    source = (STATIC / "users.js").read_text(encoding="utf-8")
    # The create button follows host selection, not the write gates.
    assert "createButton.hidden = !host;" in source
    # Account actions render for every present account.
    assert "canWriteHost(adminHost())" not in source
    # Missing gates are explained inside the dialog instead of hiding entries.
    assert "function writeBlocker(host)" in source
    assert "hint.hidden = !blocker" in source
    assert "/settings#user-monitoring" in source


def test_admin_blocker_names_the_missing_gate():
    source = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "总开关还没打开" in source
    assert "还没有允许账号写操作" in source
    assert "还没有配置 sudo 密码" in source


def test_settings_save_no_longer_waits_for_collection():
    source = (STATIC / "settings.js").read_text(encoding="utf-8")
    start = source.index('"#save-host-button"')
    save_block = source[start:start + 1600]
    assert "hostForm.hidden = true;" in save_block
    assert "toast(" in save_block
    # The old flow reloaded the page only after the collection finished.
    assert "watchHostCollection([name]);" not in source
    # Import also returns to the host list immediately.
    assert "window.setTimeout(reloadToHosts" in source


def test_toast_and_hint_styles_are_defined():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    for selector in (".settings-toast", ".user-admin-hint", ".settings-toast-error"):
        assert selector in css, selector
    assert 'html[data-theme="dark"] .settings-toast' in css


def test_host_page_actions_stay_free_of_user_management():
    template = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert "服务器用户" not in template
    assert "新建账号" not in template
