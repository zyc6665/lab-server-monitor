"""v0.1.110：磁盘健康折叠状态记忆。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def _script() -> str:
    return (STATIC / "disk-health.js").read_text(encoding="utf-8")


def test_collapse_state_is_stored_under_its_own_key():
    script = _script()
    assert "var COLLAPSE_KEY = 'disk:collapsed';" in script
    assert "window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(list));" in script


def test_toggling_updates_the_stored_list():
    script = _script()
    assert "var list = readCollapsed().filter(function (item) { return item !== anchor; });" in script
    assert "if (collapsed) { list.push(anchor); }" in script
    assert "saveCollapsed(list);" in script


def test_saved_state_is_restored_on_load():
    script = _script()
    assert "var collapsed = readCollapsed();" in script
    assert "collapsed.indexOf(block.id) !== -1" in script


def test_hash_jump_expands_the_target_host():
    script = _script()
    assert "var jumpTarget = document.getElementById(window.location.hash.replace('#', ''));" in script
    assert "setCollapsed(jumpButton, false);" in script


def test_read_guards_against_bad_json():
    script = _script()
    assert "return Array.isArray(parsed) ? parsed : [];" in script
