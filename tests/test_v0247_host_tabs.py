"""v0.1.147：主机详情分区切换更顺手（记住上次分区、切分区回到顶部、淡入）。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _js() -> str:
    return (STATIC / "host-detail.js").read_text(encoding="utf-8")


def _css() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_tab_choice_is_remembered_per_host():
    js = _js()
    assert "var TAB_STORE = 'host:tab:' + (HOST_NAME || '');" in js
    assert "function rememberTab(key)" in js
    assert "function storedTab()" in js
    assert "if (!initialHash) {" in js
    assert "activate(remembered, false);" in js


def test_switching_scrolls_back_to_the_tab_bar():
    js = _js()
    assert "function scrollToTabs()" in js
    # 页面滚动发生在 .container 上，不是 window，所以按标签条与分区的相对位置算。
    assert "function scrollParent(el)" in js
    assert "scroller.scrollBy({ top: panelTop - barBottom - 8, behavior: 'smooth' });" in js
    # 分区已经完整露在标签条下方时不做任何滚动，页首点击不会跳动。
    assert "if (panelTop >= barBottom + 4) { return; }" in js
    assert "activate(key, false);\n        scrollToTabs();" in js


def test_panels_fade_in_without_replaying_on_hidden_ones():
    js = _js()
    assert "panel.classList.remove('panel-enter');" in js
    assert "void panel.offsetWidth;" in js
    assert "panel.classList.add('panel-enter');" in js
    assert "// 换分区时轻轻淡入" in js

    css = _css()
    assert "/* -- v0.1.147 主机详情分区切换手感 -- */" in css
    assert ".panel-enter {" in css
    assert "@keyframes host-panel-in" in css
    assert "@media (prefers-reduced-motion: reduce)" in css
