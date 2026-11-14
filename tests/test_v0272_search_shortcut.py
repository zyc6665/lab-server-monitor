"""v0.1.172：/ 聚焦搜索框，Esc 清空。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_slash_focuses_the_search_box():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function bindSearchShortcut()" in js
    assert "var ids = ['alert-search', 'user-search', 'host-filter'];" in js
    assert "if (event.key === '/' && !typing) {" in js
    assert "event.preventDefault();" in js
    assert "box.focus();" in js
    # 正在输入时不抢按键
    assert "var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;" in js


def test_escape_clears_the_search_box():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "if (event.key === 'Escape' && tag === 'input' && ids.indexOf(target.id) !== -1) {" in js
    assert "target.dispatchEvent(new Event('input', { bubbles: true }));" in js
    assert "bindSearchShortcut();" in js
