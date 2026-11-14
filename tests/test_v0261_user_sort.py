"""v0.1.161：用户页主机卡支持按占用 / 增长 / 显存排序（只读，前端记忆）。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_toolbar_has_sort_select():
    page = (TEMPLATES / "users.html").read_text(encoding="utf-8")
    assert 'id="user-sort"' in page
    for value in ("name", "usage", "growth", "gpu"):
        assert f'<option value="{value}">' in page


def test_script_sorts_and_remembers():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "var SORT_STORE = 'users:sort';" in js
    assert "function sortHosts(list, mode) {" in js
    assert "var key = mode === 'gpu' ? 'gpu_memory_mb' : (mode === 'growth' ? 'delta_bytes' : 'bytes');" in js
    assert "saveSort(sort.value);" in js
    # 排序发生在渲染前，筛选结果也照样排
    assert "var hosts = sortHosts(" in js
    assert "currentSortMode()" in js
    # 排序切换走数据加载，而不是未定义函数
    assert "saveSort(sort.value);" in js
    assert "fetchUsers();" in js


def test_sort_select_is_not_cramped():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.161 用户页主机排序 -- */" in css
    assert "#user-sort { min-width: 140px; }" in css
