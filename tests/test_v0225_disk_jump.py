"""v0.1.125：磁盘健康页分组跳转。"""

from __future__ import annotations

from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static" / "disk-health.js"


def _script() -> str:
    return SCRIPT.read_text(encoding="utf-8")


def test_jump_chips_survive_group_collapse():
    script = _script()
    assert "if (el.classList.contains('disk-jump-link')) {" in script
    assert "el.hidden = !matched;\n        return;" in script


def test_expand_group_helper_present():
    script = _script()
    assert "function expandGroupOf(el)" in script
    assert "setGroupCollapsed(head, false);" in script
    assert "function revealTarget(el)" in script
    assert "function revealHash()" in script


def test_jump_click_reveals_and_scrolls():
    script = _script()
    assert "document.querySelectorAll('.disk-jump-link')" in script
    assert "event.preventDefault();" in script
    assert "target.scrollIntoView({ behavior: 'smooth', block: 'start' });" in script
    assert "window.history.replaceState(null, '', '#' + id);" in script
    assert "window.addEventListener('hashchange', revealHash);" in script


def test_initial_hash_uses_reveal():
    script = _script()
    assert "revealHash();\n\n  // 跳转芯片" in script
