"""v0.1.171：用户页记住状态筛选与账号视图（全部/异常/缺失）。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_filters_are_persisted():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "var FILTER_STORE = 'users:filters';" in js
    assert "function readFilters()" in js
    assert "function saveFilters()" in js
    assert "localStorage.setItem(FILTER_STORE, JSON.stringify({" in js
    assert "var saved = readFilters();" in js
    # 恢复时同时回填下拉与账号视图高亮
    assert "if (saved.status) { status.value = saved.status; }" in js
    assert "if (saved.entry) { entryFilter = saved.entry; }" in js


def test_changes_are_written_back():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert js.count("saveFilters();") >= 2
    assert "status.addEventListener('change', function () {\n        saveFilters();\n        fetchUsers();" in js
    assert "setEntryFilter(chip.getAttribute('data-user-state') || 'all');\n        saveFilters();" in js
