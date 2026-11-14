"""v0.1.175：用户详情里的账号列表可按占用 / 显存 / 变化排序。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_account_sort():
    page = (TEMPLATES / "users.html").read_text(encoding="utf-8")
    assert 'id="user-account-sort"' in page
    for value in ("name", "usage", "gpu", "growth"):
        assert f'<option value="{value}">' in page


def test_script_sorts_and_remembers():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "var ACCOUNT_SORT_STORE = 'users:account-sort';" in js
    assert "function sortAccounts(rows, mode)" in js
    assert "return (row.home_size_bytes || 0) + (row.data_size_bytes || 0);" in js
    assert "return row.gpu_memory_mb || 0;" in js
    assert "rows = sortAccounts(rows, readAccountSort());" in js
    assert "saveAccountSort(accountSort.value);" in js


def test_sort_is_visible():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.175 账号列表排序 -- */" in css
    assert ".account-sort { margin-left: auto; }" in css
