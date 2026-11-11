"""v0.1.118：概览主机表排序记忆。"""

from __future__ import annotations

from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static" / "app.js"


def _script() -> str:
    return SCRIPT.read_text(encoding="utf-8")


def test_sort_is_persisted():
    script = _script()
    assert "var HOST_SORT_STORE = 'overview:sort';" in script
    assert "localStorage.setItem(HOST_SORT_STORE, JSON.stringify({ key: hostSortKey, dir: hostSortDir }));" in script
    assert "localStorage.removeItem(HOST_SORT_STORE);" in script


def test_sort_is_restored_on_init():
    script = _script()
    assert "function restoreHostSort()" in script
    assert "restoreHostSort();" in script
    assert "hostSortKey = saved.key;" in script


def test_restore_ignores_unknown_column():
    script = _script()
    assert "if (!known) { return; }" in script


def test_set_host_sort_saves_state():
    script = _script()
    assert "    saveHostSort();\n    renderHosts();" in script
